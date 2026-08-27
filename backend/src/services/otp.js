'use strict';
/**
 * One-time codes over WhatsApp — the ONLY verification channel this product has.
 *
 * Used for two things: verifying a clinic owner's number during self-serve
 * signup (routes/signup.js), and the WhatsApp-code password reset in
 * routes/auth.js. Both send a 6-digit code to a phone and check it back on a
 * WEB form — nothing is parsed out of the shared-number webhook, which is
 * deliberately left untouched.
 *
 * DELIVERY IS TEMPLATE-FIRST. A clinic owner never messages the shared number
 * (the QR is for patients), so the owner is permanently outside Meta's 24-hour
 * free-form window and a plain sendText is rejected in production. An approved
 * AUTHENTICATION/UTILITY template is required; SIGNUP_OTP_TEMPLATE names it. The
 * sendText fallback still runs — it succeeds in dev and for a number that HAS
 * written in — so local testing needs no template.
 *
 * The code is stored only as a SHA-256 hash (same discipline as refresh tokens).
 */
const crypto = require('crypto');
const { query } = require('../db');
const wa = require('./whatsapp');
const logger = require('../utils/logger');

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
// Don't let one phone request an unbounded stream of codes (SMS-pumping's
// WhatsApp cousin — each send costs the platform and erodes the number's
// quality rating). 4 live codes per hour per phone is plenty for a retry or two.
const MAX_LIVE_CODES_PER_HOUR = 4;
const RESEND_COOLDOWN_SECONDS = 45;

const TEMPLATE = () => (process.env.SIGNUP_OTP_TEMPLATE || '').trim();
const TEMPLATE_HAS_BUTTON = () => String(process.env.SIGNUP_OTP_TEMPLATE_HAS_BUTTON || 'true') !== 'false';

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function generateCode() {
  // 6 digits, uniform, never leading-zero-stripped (kept as a string throughout).
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function normalizePhone(input) {
  return String(input == null ? '' : input).replace(/[^\d]/g, '');
}

/**
 * Issue a code for `phone` + `purpose`, storing `payload` alongside it for the
 * verify step to return. Sends the code over WhatsApp. Returns
 * `{ ok, retryAfter?, error? }` — never throws for the expected rejections
 * (cooldown, hourly cap) so callers can pass the reason straight to the client.
 *
 * @param {string} phone    digits only (E.164 without '+')
 * @param {'signup'|'password_reset'} purpose
 * @param {object} [payload] opaque data handed back on successful verify
 */
async function issueOtp(phone, purpose, payload = {}) {
  const p = normalizePhone(phone);
  if (!/^\d{8,20}$/.test(p)) return { ok: false, error: 'A valid WhatsApp number is required.' };

  // Rate: recent send (cooldown) and hourly volume, in one round-trip. The
  // hourly count is of ALL codes sent — not just unconsumed ones — because the
  // supersede step below means at most one is ever live at a time, so a
  // "still live" count could never bound total sends.
  const recent = await query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at > NOW() - make_interval(secs => $3::int)) AS in_cooldown,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')              AS sent_last_hour
     FROM wa_otps WHERE phone = $1 AND purpose = $2`,
    [p, purpose, RESEND_COOLDOWN_SECONDS]
  );
  if (parseInt(recent.rows[0].in_cooldown) > 0) {
    return { ok: false, retryAfter: RESEND_COOLDOWN_SECONDS, error: `Please wait ${RESEND_COOLDOWN_SECONDS} seconds before requesting another code.` };
  }
  if (parseInt(recent.rows[0].sent_last_hour) >= MAX_LIVE_CODES_PER_HOUR) {
    return { ok: false, error: 'Too many codes requested for this number. Try again in an hour.' };
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();

  // Supersede any still-live code for this phone+purpose so only the newest
  // works — a resend must invalidate the previous one.
  await query(
    `UPDATE wa_otps SET consumed_at = NOW()
      WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > NOW()`,
    [p, purpose]
  );
  await query(
    `INSERT INTO wa_otps (phone, purpose, code_hash, payload, max_attempts, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [p, purpose, sha256(code), JSON.stringify(payload || {}), MAX_ATTEMPTS, expiresAt]
  );

  await deliverCode(p, code, purpose);
  return { ok: true, expiresInMinutes: CODE_TTL_MINUTES };
}

async function deliverCode(phone, code, purpose) {
  const label = purpose === 'password_reset' ? 'password reset' : 'MediBook sign-up';
  const text = `${code} is your ${label} verification code. It expires in ${CODE_TTL_MINUTES} minutes. Do not share it with anyone.`;
  const tpl = TEMPLATE();

  if (tpl) {
    try {
      const components = [{ type: 'body', parameters: [{ type: 'text', text: code }] }];
      if (TEMPLATE_HAS_BUTTON()) {
        // Meta AUTHENTICATION templates carry a copy-code button whose parameter
        // must be sent too. UTILITY templates with a single body variable should
        // set SIGNUP_OTP_TEMPLATE_HAS_BUTTON=false.
        components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
      }
      await wa.sendTemplate(phone, tpl, components, null, null);
      return;
    } catch (err) {
      logger.warn('OTP template send failed — falling back to text', { template: tpl, error: err.response?.data?.error?.message || err.message });
    }
  } else if (process.env.NODE_ENV === 'production') {
    logger.error('SIGNUP_OTP_TEMPLATE is not set — OTP delivery in production will fail for any owner outside the 24h window');
  }

  try {
    await wa.sendText(phone, text, null, null);
  } catch (err) {
    // The row is already written; a delivery failure is surfaced so the client
    // can offer "resend". Do NOT leak whether the number exists on WhatsApp.
    logger.warn('OTP text send failed', { error: err.response?.data?.error?.message || err.message });
  }
}

/**
 * Check a code. Returns `{ ok, payload }` on success, `{ ok:false, error }`
 * otherwise. A correct code is single-use (consumed). Attempts are counted so a
 * live code cannot be brute-forced within its 10-minute window.
 */
async function verifyOtp(phone, purpose, code) {
  const p = normalizePhone(phone);
  const submitted = String(code || '').replace(/[^\d]/g, '');
  if (!/^\d{6}$/.test(submitted)) return { ok: false, error: 'Enter the 6-digit code from WhatsApp.' };

  const r = await query(
    `SELECT * FROM wa_otps
      WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1`,
    [p, purpose]
  );
  const row = r.rows[0];
  if (!row) return { ok: false, error: 'That code has expired. Request a new one.' };

  if (row.attempts >= row.max_attempts) {
    await query(`UPDATE wa_otps SET consumed_at = NOW() WHERE id = $1`, [row.id]);
    return { ok: false, error: 'Too many incorrect attempts. Request a new code.' };
  }

  if (sha256(submitted) !== row.code_hash) {
    await query(`UPDATE wa_otps SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    const left = row.max_attempts - row.attempts - 1;
    return { ok: false, error: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Incorrect code. Request a new one.' };
  }

  await query(`UPDATE wa_otps SET consumed_at = NOW() WHERE id = $1`, [row.id]);
  let payload = {};
  try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {}); } catch (_) {}
  return { ok: true, payload };
}

/** Housekeeping — called by the dunning cron. */
async function purgeExpiredOtps() {
  await query(`DELETE FROM wa_otps WHERE expires_at < NOW() - INTERVAL '1 day'`).catch(() => {});
}

module.exports = {
  issueOtp,
  verifyOtp,
  purgeExpiredOtps,
  normalizePhone,
  CODE_TTL_MINUTES,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
  // exported for tests
  _sha256: sha256,
};
