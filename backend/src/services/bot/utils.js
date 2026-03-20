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

function fuzzyFind(items, input, nameField = 'name') {
  const lower = input.toLowerCase();
  const exact = items.find(item =>
    item[nameField].toLowerCase() === lower ||
    item[nameField].toLowerCase().includes(lower)
  );
  if (exact) return exact;
  // Guard: skip levenshtein for very long inputs to prevent O(m*n) DoS
  if (lower.length > 50) return null;
  let best = null, bestDist = Infinity;
  for (const item of items) {
    // Truncate long item names so levenshtein stays bounded
    const name = item[nameField].toLowerCase().slice(0, 50);
    const dist = levenshtein(lower, name);
    const threshold = Math.max(2, Math.floor(name.length * 0.4));
    if (dist < bestDist && dist <= threshold) {
      bestDist = dist;
      best = item;
    }
  }
  return best;
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
  await tenantQuery(schemaName,
    `UPDATE bot_sessions SET state=$1, context=$2::jsonb, last_activity=NOW() WHERE phone=$3`,
    [state, encryptedContext, phone]);
}

async function getPatient(schemaName, phone) {
  const r = await tenantQuery(schemaName,
    `SELECT id, phone, name, email, date_of_birth, gender, visit_count FROM patients WHERE phone=$1`, [phone]);
  return r.rows[0] || null;
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

module.exports = {
  STATES,
  genBookingId,
  levenshtein,
  fuzzyFind,
  getSession,
  updateSession,
  getPatient,
  logMessage,
};
