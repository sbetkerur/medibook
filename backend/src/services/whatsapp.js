'use strict';
const axios = require('axios');
const logger = require('../utils/logger');

// ── Axios instance pool (per tenant phone number ID + token suffix) ──────────
const _axiosPool = new Map();

function getAxiosInstance(accessToken, phoneNumberId) {
  const token = accessToken || process.env.META_ACCESS_TOKEN;
  const phoneId = phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  // Use last 16 chars (not 8) to avoid collision between tenants whose tokens share a suffix,
  // which would cause one tenant's messages to be sent using another tenant's authorization.
  const key = `${phoneId}:${(token || '').slice(-16)}`;

  if (!_axiosPool.has(key)) {
    _axiosPool.set(key, axios.create({
      baseURL: `https://graph.facebook.com/v21.0/${phoneId}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }));
  }
  // Evict stale entries for same phoneId with a different token suffix (token rotation)
  for (const k of _axiosPool.keys()) {
    if (k.startsWith(`${phoneId}:`) && k !== key) _axiosPool.delete(k);
  }
  return { instance: _axiosPool.get(key), phoneId };
}

// Legacy helper for backwards compat
function getClient(accessToken, phoneNumberId) {
  const token = accessToken || process.env.META_ACCESS_TOKEN;
  const phoneId = phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  return {
    base: `https://graph.facebook.com/v21.0/${phoneId}/messages`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
}

// ── Circuit Breaker ───────────────────────────────────────────────────────────
// States: CLOSED (normal), OPEN (stop calls), HALF_OPEN (test one call)
const _circuits = new Map(); // phoneNumberId -> { state, failures, openedAt }
const CB_FAILURE_THRESHOLD = 8;  // raised from 5 — transient blips shouldn't open the circuit
const CB_RESET_MS = 30 * 1000;   // reduced from 60s — recover faster after a hiccup
// Longer than any single Meta request can take (axios timeout in _send), so it
// only ever fires for a probe that returned without recording an outcome.
const CB_PROBE_TIMEOUT_MS = 60 * 1000;

function getCircuit(phoneId) {
  if (!_circuits.has(phoneId)) {
    _circuits.set(phoneId, { state: 'CLOSED', failures: 0, openedAt: null });
  }
  return _circuits.get(phoneId);
}

function recordSuccess(phoneId) {
  const cb = getCircuit(phoneId);
  cb.failures = 0;
  cb.state = 'CLOSED';
  cb.probing = false;
}

function recordFailure(phoneId) {
  const cb = getCircuit(phoneId);
  cb.failures++;
  cb.probing = false;
  // Re-open from HALF_OPEN (test call failed) as well as from CLOSED (threshold hit)
  if (cb.failures >= CB_FAILURE_THRESHOLD && (cb.state === 'CLOSED' || cb.state === 'HALF_OPEN')) {
    cb.state = 'OPEN';
    cb.openedAt = Date.now();
    logger.warn(`Circuit breaker OPEN for phoneId ${phoneId} after ${cb.failures} failures`);
  }
}

function isCircuitOpen(phoneId) {
  const cb = getCircuit(phoneId);
  // HALF_OPEN is tested FIRST, as its own state. It used to be checked with
  // `if (cb.state !== 'HALF_OPEN')` nested INSIDE `if (cb.state === 'OPEN')`,
  // where it is always true — so `return cb.probing` was unreachable and
  // `probing` was dead state. Worse, once the first caller flipped the breaker
  // to HALF_OPEN every subsequent caller failed the `=== 'OPEN'` test entirely
  // and fell through to `return false` at the bottom: allowed. With the hourly
  // crons running tenants five at a time, "test one call" was in practice five
  // or more calls fired at a Meta that was still down.
  if (cb.state === 'HALF_OPEN') {
    // A probe that never records an outcome would otherwise wedge the breaker
    // shut forever, which the old (broken) code could not do because it let
    // everyone through. recordSuccess/recordFailure normally clear `probing`
    // within the caller's own request timeout; CB_PROBE_TIMEOUT_MS is the
    // backstop for a path that returns without recording either.
    if (cb.probing && Date.now() - (cb.probeStartedAt || 0) > CB_PROBE_TIMEOUT_MS) {
      logger.warn(`Circuit breaker probe for phoneId ${phoneId} never reported — allowing a fresh probe`);
      cb.probeStartedAt = Date.now();
      return false;
    }
    return cb.probing; // a probe is already in flight — block everyone else
  }
  if (cb.state === 'OPEN') {
    if (Date.now() - cb.openedAt > CB_RESET_MS) {
      // Only the caller that flips state to HALF_OPEN gets to make the probe
      // call — every other caller in the same tick would otherwise also see
      // state !== 'OPEN' and fall through, turning "test one call" into a
      // thundering herd right as the breaker reopens. `probing` gates that:
      // it's cleared again in recordSuccess/recordFailure once the probe
      // resolves, so a stuck probe (network hang) still eventually times out
      // via the caller's own request timeout and unblocks via recordFailure.
      cb.state = 'HALF_OPEN';
      cb.probing = true;
      cb.probeStartedAt = Date.now();
      logger.info(`Circuit breaker HALF_OPEN for phoneId ${phoneId} — testing`);
      return false; // allow this one test call
    }
    return true; // still open
  }
  return false;
}

// ── Outbound allowlist (non-production safety) ───────────────────────────────
// Every environment shares ONE WhatsApp number, so a dev deployment holds the
// production access token and sends as the clinic-facing number. It also runs
// the same reminder / nudge / recall / feedback crons on a timer — which message
// people who never wrote in. A copy of production's data therefore turns a test
// environment into something that texts real patients from the real number.
//
// WHATSAPP_ALLOWED_RECIPIENTS is the seatbelt: set it in dev to a comma-separated
// list of numbers you own, and nothing else can be reached, whatever the database
// happens to contain. Unset — which is how production runs — imposes no limit.
//
// This is deliberately the LAST gate before the HTTP call rather than a check in
// the crons: it covers the bot's replies, every cron, every future sender, and
// anything added by hand — every path that puts CONTENT in front of a patient
// goes through _send.
//
// markRead() below posts to Meta without passing through here, and is meant to:
// it delivers no content, only a read receipt on a message the patient already
// sent, so it cannot reach anybody who did not write in first. Any NEW sender
// must go through _send, or it is outside this guard.
const ALLOWED_RECIPIENTS = new Set(
  String(process.env.WHATSAPP_ALLOWED_RECIPIENTS || '')
    .split(',').map(s => s.replace(/\D/g, '')).filter(Boolean)
);

function recipientAllowed(to) {
  if (!ALLOWED_RECIPIENTS.size) return true;          // production: no restriction
  return ALLOWED_RECIPIENTS.has(String(to || '').replace(/\D/g, ''));
}

// ── Core send helper ──────────────────────────────────────────────────────────
async function _send(payload, accessToken, phoneNumberId) {
  if (!recipientAllowed(payload?.to)) {
    // Swallowed rather than thrown. A throw here would surface to a patient as
    // "something went wrong at our end" and would mark cron rows as failed,
    // which is misleading — nothing went wrong, the send was deliberately
    // withheld. Callers get a null message id, exactly as they would from a
    // send that Meta accepted but never delivered.
    logger.warn('Outbound suppressed — recipient not in WHATSAPP_ALLOWED_RECIPIENTS', {
      to: String(payload?.to || '').slice(0, 4) + '…',
    });
    return { data: { messages: [] } };
  }
  const { instance, phoneId } = getAxiosInstance(accessToken, phoneNumberId);

  if (isCircuitOpen(phoneId)) {
    throw new Error(`Circuit breaker OPEN for ${phoneId} — skipping send`);
  }

  try {
    const res = await instance.post('/messages', { messaging_product: 'whatsapp', ...payload });
    recordSuccess(phoneId);
    return res;
  } catch (err) {
    // Config/auth errors are not availability issues — don't trip the circuit breaker.
    // Code 190 = expired/invalid token. Code 10 = permission denied (also config).
    // Circuit breaker should only trip on network errors or Meta server errors (5xx).
    const errCode = err.response?.data?.error?.code;
    const isConfigError = errCode === 190 || errCode === 10;
    if (!isConfigError) recordFailure(phoneId);
    else {
      // Reset circuit so a fresh token takes effect immediately without waiting
      const cb = getCircuit(phoneId);
      cb.failures = 0;
      cb.state = 'CLOSED';
      logger.warn(`Config/auth error (code ${errCode}) for ${phoneId} — circuit reset.`);
    }
    throw err;
  }
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Meta's send response is `{ messages: [{ id: "wamid...." }], ... }`. Every
 * sender must hand that id back: it is the ONLY key delivery receipts arrive
 * with, and `updateMessageStatus()` matches on `wa_messages.wa_message_id`.
 * While the senders returned undefined, every outbound row was written with a
 * NULL id and no sent/delivered/read callback could ever match a row.
 */
function _messageId(res) {
  return res?.data?.messages?.[0]?.id || null;
}

async function sendText(to, text, accessToken, phoneNumberId) {
  try {
    const res = await _send({
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: String(text).slice(0, 4096) },
    }, accessToken, phoneNumberId);
    return _messageId(res);
  } catch (err) {
    logger.error('sendText failed', { to, error: err.response?.data || err.message });
    throw err;
  }
}

/**
 * Build the optional header/footer slots of an interactive message.
 *
 * WhatsApp renders a `header` as its own emphasised line and a `footer` as small
 * grey text under the buttons — both distinct from the body. We faked the header
 * with bold text inside the body and stuffed helper hints ("Reply *Menu* to go
 * back") into the body too, which is why every message read as one undifferen-
 * tiated block. Using the real slots is what makes a flow look native rather
 * than typed out.
 *
 * Meta caps both at 60 characters and rejects the whole message if either is
 * longer, so they are truncated rather than trusted.
 */
function _headerFooter({ header, footer } = {}) {
  const out = {};
  if (header) out.header = { type: 'text', text: String(header).slice(0, 60) };
  if (footer) out.footer = { text: String(footer).slice(0, 60) };
  return out;
}

/** The header/footer as plain text, for the no-interactive-message fallback. */
function _flatten(bodyText, { header, footer } = {}) {
  return [header ? `*${header}*` : null, bodyText, footer || null].filter(Boolean).join('\n\n');
}

async function sendButtons(to, bodyText, buttons, accessToken, phoneNumberId, opts = {}) {
  const btns = buttons.slice(0, 3);
  try {
    const res = await _send({
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        ..._headerFooter(opts),
        body: { text: String(bodyText).slice(0, 1024) },
        action: {
          buttons: btns.map((b, i) => ({
            type: 'reply',
            reply: { id: `btn_${i}_${Date.now()}`, title: String(b).slice(0, 20) },
          })),
        },
      },
    }, accessToken, phoneNumberId);
    return _messageId(res);
  } catch (err) {
    // Fallback to numbered text list. Return the FALLBACK's id — that plain text
    // is the message the patient actually received, so it is the one whose
    // delivery receipts must find a row.
    const numbered = buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
    return await sendText(to, `${_flatten(bodyText, opts)}\n\n${numbered}\n\nReply with number to choose.`, accessToken, phoneNumberId);
  }
}

async function sendList(to, bodyText, buttonLabel, sections, accessToken, phoneNumberId, opts = {}) {
  // WhatsApp limits: section title ≤ 24, row title ≤ 24, row description ≤ 72,
  // and ≤ 10 rows TOTAL per list message — an 11-row list is rejected outright
  // (Meta #131009), so without the cap every send from a tenant with 11+
  // dentists/branches failed and degraded to the numbered-text fallback.
  let rowBudget = 10;
  const sanitizedSections = sections.map(s => {
    const rows = (s.rows || []).slice(0, Math.max(rowBudget, 0)).map(r => ({
      id: String(r.id).slice(0, 200),
      title: String(r.title || '').slice(0, 24),
      ...(r.description ? { description: String(r.description).slice(0, 72) } : {}),
    }));
    rowBudget -= rows.length;
    return { title: String(s.title || '').slice(0, 24), rows };
  }).filter(s => s.rows.length > 0);
  try {
    const res = await _send({
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        ..._headerFooter(opts),
        body: { text: String(bodyText).slice(0, 1024) },
        action: { button: String(buttonLabel).slice(0, 20), sections: sanitizedSections },
      },
    }, accessToken, phoneNumberId);
    return _messageId(res);
  } catch (err) {
    logger.warn('sendList failed, falling back to text', { to, error: err.response?.data || err.message });
    // Numbering must be a single running counter across sections. The old
    // `si * 10 + ri + 1` numbered section 1's rows 11, 12, … while every caller
    // that parses a typed number (handleSelectSlot, handleSelectDate,
    // handleSelectHospital) matches against 1..rows.length — so on a
    // multi-section list the fallback was unusable.
    let n = 0;
    const lines = sections.flatMap((s) =>
      (s.rows || []).map((r) => `${++n}. ${r.title}${r.description ? ' — ' + r.description : ''}`)
    );
    // As in sendButtons: the fallback text is what was really delivered, so its
    // id is the one the caller must record.
    return await sendText(to, `${_flatten(bodyText, opts)}\n\n${lines.join('\n')}\n\nReply with the number of your choice.`, accessToken, phoneNumberId);
  }
}

async function sendTemplate(to, templateName, components = [], accessToken, phoneNumberId) {
  try {
    const res = await _send({
      to,
      type: 'template',
      template: { name: templateName, language: { code: 'en' }, components },
    }, accessToken, phoneNumberId);
    return _messageId(res);
  } catch (err) {
    logger.error('sendTemplate failed', { to, templateName, error: err.response?.data || err.message });
    throw err;
  }
}

async function markRead(messageId, accessToken, phoneNumberId) {
  const phoneId = phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  const token = accessToken || process.env.META_ACCESS_TOKEN;
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${phoneId}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 5000 }
    );
  } catch (_) { /* non-critical */ }
}

/**
 * Update delivery status of an outgoing wa_message record.
 * Called by webhook.js when Meta sends status update callbacks.
 */
async function updateMessageStatus(schemaName, waMessageId, status) {
  if (!schemaName || !waMessageId || !status) return;
  try {
    const { tenantQuery } = require('../db');
    await tenantQuery(schemaName,
      `UPDATE wa_messages SET status=$1, status_updated_at=NOW() WHERE wa_message_id=$2`,
      [status, waMessageId]);
  } catch (_) { /* non-critical */ }
}

// ── Template convenience wrappers ─────────────────────────────────────────────
async function sendBookingConfirmationTemplate(to, { bookingId, doctorName, hospitalName, date, time }, accessToken, phoneNumberId) {
  return await sendTemplate(to, 'appointment_confirmed_v4', [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(bookingId) },
        { type: 'text', text: String(doctorName) },
        { type: 'text', text: String(hospitalName) },
        { type: 'text', text: String(date) },
        { type: 'text', text: String(time) },
      ],
    },
    // Quick-reply payloads, index-aligned with the template's two buttons.
    // These override whatever payload the template carries — the form prefills
    // that from the LABEL, which here would be "📅 Reschedule" and matches no
    // keyword. Keep in step with docs/whatsapp-templates.md.
    { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'Reschedule' }] },
    { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'Cancel appointment' }] },
  ], accessToken, phoneNumberId);
}


function resetCircuit(phoneId) {
  const id = phoneId || process.env.META_PHONE_NUMBER_ID;
  if (id) {
    _circuits.delete(id);
    // Also evict all cached axios instances for this phoneId so fresh token is picked up
    for (const k of _axiosPool.keys()) {
      if (k.startsWith(`${id}:`)) _axiosPool.delete(k);
    }
    logger.info(`Circuit breaker and token cache reset for phoneId ${id}`);
  }
}

module.exports = {
  sendText, sendButtons, sendList, sendTemplate, markRead,
  updateMessageStatus,
  sendBookingConfirmationTemplate,
  getAxiosInstance, // exported for testing
  resetCircuit,
  // Exported for tests/circuitBreaker.unit.test.js. The HALF_OPEN gate is the
  // difference between probing Meta with ONE call after an outage and firing
  // every queued cron send at a service that is still down, and it was silently
  // unreachable for a long time — worth pinning.
  isCircuitOpen, recordSuccess, recordFailure,
};
