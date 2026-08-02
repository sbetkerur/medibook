'use strict';

const { tenantQuery } = require('../../db');
const logger = require('../../utils/logger');

const STATES = {
  IDLE: 'idle',
  MAIN_MENU: 'main_menu',
  SELECT_HOSPITAL: 'select_hospital',
  SELECT_DEPARTMENT: 'select_department',
  SELECT_DOCTOR: 'select_doctor',
  SELECT_DATE: 'select_date',
  SELECT_SLOT: 'select_slot',
  COLLECT_NAME: 'collect_name',
  COLLECT_DOB: 'collect_dob',
  COLLECT_GENDER: 'collect_gender',
  CONFIRM_BOOKING: 'confirm_booking',
  MY_APPOINTMENTS: 'my_appointments',
  RESCHEDULE_SELECT: 'reschedule_select',
  RESCHEDULE_DATE: 'reschedule_date',
  RESCHEDULE_SLOT: 'reschedule_slot',
  RESCHEDULE_CONFIRM: 'reschedule_confirm',
  CANCEL_SELECT: 'cancel_select',
  CANCEL_REASON: 'cancel_reason',
  CANCEL_CONFIRM: 'cancel_confirm',
  SELECT_PATIENT: 'select_patient',
  COLLECT_EMAIL: 'collect_email',
  COLLECT_CHIEF_COMPLAINT: 'collect_chief_complaint',
  CHECK_BOOKING_STATUS: 'check_booking_status',
  COLLECT_FEEDBACK_RATING: 'collect_feedback_rating',
  COLLECT_FEEDBACK_COMMENT: 'collect_feedback_comment',
  RESUME_CONFIRM: 'resume_confirm',
};

function genBookingId() {
  const { randomUUID } = require('crypto');
  // 10 hex chars = 40 bits of entropy. Using 8 previously gave ~1-in-4-billion
  // collision rate; 10 reduces it to ~1-in-trillion which is safe at scale.
  return 'MB' + randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
}

// Simple Levenshtein distance for fuzzy matching
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

/**
 * Parse a "reply with a number" selection, STRICTLY.
 *
 * parseInt() is wrong here: it parses a leading digit run out of anything, so
 * parseInt('3c1b2d3e-…') === 3 and parseInt('09:30 – 10:00') === 9. WhatsApp
 * keeps earlier list rows tappable forever, so a stale tap delivers a UUID row
 * id or a formatted row title into a handler expecting "1".."N" — which used to
 * silently select an unrelated date or time slot and carry on booking.
 *
 * Returns NaN unless the whole (trimmed) string is digits.
 */
function parseChoiceNumber(input) {
  const s = String(input == null ? '' : input).trim();
  return /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
}

// Substring matching below this length is not evidence of intent — it is a
// coin flip. "a" is a substring of most names, so a one-character reply used to
// resolve to whichever doctor happened to be first in the list.
const MIN_SUBSTRING_MATCH_LEN = 3;

/**
 * Resolve free-text input to one of `items`.
 *
 * Returns null when the input is too short to be meaningful, matches nothing,
 * or matches MORE THAN ONE item. Ambiguity must never be resolved by list
 * order: this picks the doctor a patient is booked with, so a wrong guess is
 * worse than asking again.
 */
function fuzzyFind(items, input, nameField = 'name') {
  if (!input || input.length === 0) return null;
  const lower = input.toLowerCase();
  const nameOf = item => (item[nameField] || '').toLowerCase();

  // Exact name match wins outright, at any length, and is unambiguous by intent.
  const exact = items.filter(item => nameOf(item) === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // two identically-named items — ask instead

  // Substring match: long enough to be intentional, and unique.
  if (lower.length >= MIN_SUBSTRING_MATCH_LEN) {
    const partial = items.filter(item => nameOf(item).includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) return null; // e.g. "sha" matching two doctors
  }

  // Guard: skip levenshtein for very long inputs to prevent O(m*n) DoS
  if (lower.length < MIN_SUBSTRING_MATCH_LEN || lower.length > 50) return null;

  let best = null, bestDist = Infinity, bestTied = false;
  for (const item of items) {
    // Truncate long item names so levenshtein stays bounded
    const name = nameOf(item).slice(0, 50);
    const dist = levenshtein(lower, name);
    const threshold = Math.max(2, Math.floor(name.length * 0.4));
    if (dist > threshold) continue;
    if (dist < bestDist) { bestDist = dist; best = item; bestTied = false; }
    else if (dist === bestDist) { bestTied = true; }
  }
  // A tie means two names are equally close — no basis to prefer either.
  return bestTied ? null : best;
}

async function getSession(schemaName, phone) {
  // Atomic upsert — avoids a race condition where two concurrent webhook
  // deliveries for the same phone both SELECT no rows and both try INSERT,
  // causing a unique constraint violation on the second attempt.
  await tenantQuery(schemaName,
    `INSERT INTO bot_sessions (phone, state, context) VALUES ($1, 'idle', '{}')
     ON CONFLICT (phone) DO NOTHING`,
    [phone]);
  const r = await tenantQuery(schemaName,
    `SELECT * FROM bot_sessions WHERE phone = $1`, [phone]);
  return r.rows[0];
}

async function updateSession(schemaName, phone, state, context) {
  const { LIMITS } = require('../../utils/errors');
  const plainJson = JSON.stringify(context || {});
  const byteLen = Buffer.byteLength(plainJson, 'utf8');
  if (byteLen > LIMITS.SESSION_CONTEXT_MAX_BYTES) {
    logger.warn(`Session context too large (${byteLen} bytes), resetting to idle`);
    await tenantQuery(schemaName,
      `UPDATE bot_sessions SET state='idle', context='{}', last_activity=NOW() WHERE phone=$1`, [phone]);
    return;
  }
  // Encrypt context before storage to protect PII (patient names, DOB, selected options)
  const { encrypt } = require('../../utils/encryption');
  let encryptedContext;
  try {
    encryptedContext = JSON.stringify({ _enc: encrypt(plainJson) });
  } catch (encErr) {
    logger.warn('Session context encryption failed, resetting to idle', { error: encErr.message });
    await tenantQuery(schemaName,
      `UPDATE bot_sessions SET state='idle', context='{}', last_activity=NOW() WHERE phone=$1`, [phone]);
    return;
  }
  // UPSERT, not UPDATE: the greeting fast-path in botEngine calls updateSession
  // BEFORE getSession has created a row. A plain UPDATE silently no-ops for a
  // brand-new phone, so the first "Hi" left no session and the patient's first
  // "Book" tap landed in idle state — re-showing the menu instead of booking.
  await tenantQuery(schemaName,
    `INSERT INTO bot_sessions (phone, state, context, last_activity)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (phone) DO UPDATE SET state=$2, context=$3::jsonb, last_activity=NOW()`,
    [phone, state, encryptedContext]);
}

/**
 * Reset a bot session to idle with empty context. Thin wrapper around
 * updateSession() so every reset site — botEngine's opt-out handler, the
 * admin bot-session-reset route, and the sessionCleaner cron — goes through
 * the same encryption/upsert/size-check guarantees instead of hand-rolling a
 * raw `UPDATE bot_sessions SET state='idle', context='{}' ...`. Those raw
 * writes were harmless while context was always literally empty, but would
 * silently skip encryption if ever reused to reset with non-empty context.
 */
async function resetSessionToIdle(schemaName, phone) {
  return updateSession(schemaName, phone, STATES.IDLE, {});
}

async function getPatient(schemaName, phone) {
  const r = await tenantQuery(schemaName,
    `SELECT id, phone, name, email, date_of_birth, gender, visit_count FROM patients WHERE phone=$1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`, [phone]);
  return r.rows[0] || null;
}

async function getPatients(schemaName, phone) {
  const r = await tenantQuery(schemaName,
    `SELECT id, phone, name, date_of_birth, gender, visit_count FROM patients WHERE phone=$1 AND deleted_at IS NULL ORDER BY created_at ASC`, [phone]);
  return r.rows;
}

async function logMessage(schemaName, phone, direction, type, content, waMessageId) {
  try {
    await tenantQuery(schemaName,
      `INSERT INTO wa_messages (phone, direction, message_type, content, wa_message_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [phone, direction, type, content, waMessageId || null]);
  } catch (err) {
    logger.warn('logMessage failed', { phone, direction, error: err.message });
  }
}

/**
 * Send a WhatsApp alert to all admin users who have notify_phone set.
 * Uses the tenant's own WhatsApp credentials. Never throws — logs warnings on failure.
 */
async function notifyAdminWhatsApp(schema, tenant, message) {
  try {
    const adminUsers = await tenantQuery(schema,
      `SELECT notify_phone FROM users WHERE role = 'admin' AND is_active = true AND notify_phone IS NOT NULL LIMIT 3`);
    if (!adminUsers.rows.length) return;
    // Shared phone — use global META_* env vars
    const wa = require('../whatsapp');
    for (const admin of adminUsers.rows) {
      try {
        await wa.sendText(admin.notify_phone, message, null, null);
        // Recorded like any other outbound message, but under its own type so a
        // conversation view can keep staff alerts out of patient threads.
        await logMessage(schema, admin.notify_phone, 'out', 'admin_alert', message, null);
      } catch (err) {
        logger.warn('Admin WhatsApp alert failed', { error: err.message });
      }
    }
  } catch (err) {
    logger.warn('notifyAdminWhatsApp failed', { error: err.message });
  }
}

module.exports = {
  STATES,
  genBookingId,
  levenshtein,
  fuzzyFind,
  parseChoiceNumber,
  getSession,
  updateSession,
  resetSessionToIdle,
  getPatient,
  getPatients,
  logMessage,
  notifyAdminWhatsApp,
};
