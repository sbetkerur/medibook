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
const CB_FAILURE_THRESHOLD = 5;
const CB_RESET_MS = 60 * 1000; // 60 seconds

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
}

function recordFailure(phoneId) {
  const cb = getCircuit(phoneId);
  cb.failures++;
  // Re-open from HALF_OPEN (test call failed) as well as from CLOSED (threshold hit)
  if (cb.failures >= CB_FAILURE_THRESHOLD && (cb.state === 'CLOSED' || cb.state === 'HALF_OPEN')) {
    cb.state = 'OPEN';
    cb.openedAt = Date.now();
    logger.warn(`Circuit breaker OPEN for phoneId ${phoneId} after ${cb.failures} failures`);
  }
}

function isCircuitOpen(phoneId) {
  const cb = getCircuit(phoneId);
  if (cb.state === 'OPEN') {
    if (Date.now() - cb.openedAt > CB_RESET_MS) {
      cb.state = 'HALF_OPEN';
      logger.info(`Circuit breaker HALF_OPEN for phoneId ${phoneId} — testing`);
      return false; // allow one test call
    }
    return true; // still open
  }
  return false;
}

// ── Core send helper ──────────────────────────────────────────────────────────
async function _send(payload, accessToken, phoneNumberId) {
  const token = accessToken || process.env.META_ACCESS_TOKEN;
  const phoneId = phoneNumberId || process.env.META_PHONE_NUMBER_ID;

  // Always use a fresh axios instance keyed on current token — never serve
  // a cached instance built with an old (expired) token.
  const key = `${phoneId}:${(token || '').slice(-16)}`;
  if (!_axiosPool.has(key)) {
    _axiosPool.set(key, axios.create({
      baseURL: `https://graph.facebook.com/v21.0/${phoneId}`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    }));
  }
  // Evict stale entries for same phoneId but different token suffix
  for (const k of _axiosPool.keys()) {
    if (k.startsWith(`${phoneId}:`) && k !== key) _axiosPool.delete(k);
  }
  const instance = _axiosPool.get(key);

  if (isCircuitOpen(phoneId)) {
    throw new Error(`Circuit breaker OPEN for ${phoneId} — skipping send`);
  }

  try {
    const res = await instance.post('/messages', { messaging_product: 'whatsapp', ...payload });
    recordSuccess(phoneId);
    return res;
  } catch (err) {
    // Auth errors (expired/invalid token) are config problems — don't trip the
    // circuit breaker, which is meant to protect against Meta API outages.
    const isAuthError = err.response?.data?.error?.code === 190;
    if (!isAuthError) recordFailure(phoneId);
    else {
      // Reset the circuit so a fresh token takes effect immediately
      const cb = getCircuit(phoneId);
      cb.failures = 0;
      cb.state = 'CLOSED';
      logger.warn(`Auth error for ${phoneId} — token may be expired. Circuit reset.`);
    }
    throw err;
  }
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

async function sendText(to, text, accessToken, phoneNumberId) {
  try {
    await _send({
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: String(text).slice(0, 4096) },
    }, accessToken, phoneNumberId);
  } catch (err) {
    logger.error('sendText failed', { to, error: err.response?.data || err.message });
    throw err;
  }
}

async function sendButtons(to, bodyText, buttons, accessToken, phoneNumberId) {
  const btns = buttons.slice(0, 3);
  try {
    await _send({
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: String(bodyText).slice(0, 1024) },
        action: {
          buttons: btns.map((b, i) => ({
            type: 'reply',
            reply: { id: `btn_${i}_${Date.now()}`, title: String(b).slice(0, 20) },
          })),
        },
      },
    }, accessToken, phoneNumberId);
  } catch (err) {
    // Fallback to numbered text list
    const numbered = buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
    await sendText(to, `${bodyText}\n\n${numbered}\n\nReply with number to choose.`, accessToken, phoneNumberId);
  }
}

async function sendList(to, bodyText, buttonLabel, sections, accessToken, phoneNumberId) {
  try {
    await _send({
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: String(bodyText).slice(0, 1024) },
        action: { button: String(buttonLabel).slice(0, 20), sections },
      },
    }, accessToken, phoneNumberId);
  } catch (err) {
    logger.warn('sendList failed, falling back to text', { to, error: err.response?.data || err.message });
    const lines = sections.flatMap((s, si) =>
      s.rows.map((r, ri) => `${si * 10 + ri + 1}. ${r.title}${r.description ? ' — ' + r.description : ''}`)
    );
    await sendText(to, `${bodyText}\n\n${lines.join('\n')}\n\nReply with the number of your choice.`, accessToken, phoneNumberId);
  }
}

async function sendTemplate(to, templateName, components = [], accessToken, phoneNumberId) {
  try {
    await _send({
      to,
      type: 'template',
      template: { name: templateName, language: { code: 'en' }, components },
    }, accessToken, phoneNumberId);
  } catch (err) {
    logger.error('sendTemplate failed', { to, templateName, error: err.response?.data || err.message });
    throw err;
  }
}

async function sendImage(to, imageUrl, caption, accessToken, phoneNumberId) {
  try {
    await _send({
      recipient_type: 'individual',
      to,
      type: 'image',
      image: { link: imageUrl, caption: caption ? String(caption).slice(0, 1024) : '' },
    }, accessToken, phoneNumberId);
  } catch (err) {
    logger.error('sendImage failed', { to, error: err.response?.data || err.message });
    throw err;
  }
}

async function sendReaction(to, messageId, emoji, accessToken, phoneNumberId) {
  try {
    await _send({
      to,
      type: 'reaction',
      reaction: { message_id: messageId, emoji },
    }, accessToken, phoneNumberId);
  } catch (err) {
    logger.warn('sendReaction failed (non-critical)', { to, error: err.response?.data || err.message });
    // non-critical — don't re-throw
  }
}

async function sendDocument(to, documentUrl, filename, caption, accessToken, phoneNumberId) {
  try {
    await _send({
      recipient_type: 'individual',
      to,
      type: 'document',
      document: { link: documentUrl, filename: filename || 'document', caption: caption || '' },
    }, accessToken, phoneNumberId);
  } catch (err) {
    logger.error('sendDocument failed', { to, error: err.response?.data || err.message });
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
  await sendTemplate(to, 'appointment_confirmed', [{
    type: 'body',
    parameters: [
      { type: 'text', text: String(bookingId) },
      { type: 'text', text: String(doctorName) },
      { type: 'text', text: String(hospitalName) },
      { type: 'text', text: String(date) },
      { type: 'text', text: String(time) },
    ],
  }], accessToken, phoneNumberId);
}

async function sendReminderTemplate(to, { doctorName, hospitalName, date, time }, accessToken, phoneNumberId) {
  await sendTemplate(to, 'appointment_reminder_24h', [{
    type: 'body',
    parameters: [
      { type: 'text', text: String(doctorName) },
      { type: 'text', text: String(hospitalName) },
      { type: 'text', text: String(date) },
      { type: 'text', text: String(time) },
    ],
  }], accessToken, phoneNumberId);
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
  sendDocument, sendImage, sendReaction, updateMessageStatus,
  sendBookingConfirmationTemplate, sendReminderTemplate,
  getAxiosInstance, // exported for testing
  resetCircuit,
};
