'use strict';

const { tenantQuery } = require('../../db');
const wa = require('../whatsapp');
const { decrypt } = require('../../utils/encryption');
const logger = require('../../utils/logger');

const STATES = {
  IDLE: 'idle',
  MAIN_MENU: 'main_menu',
  SELECT_HOSPITAL: 'select_hospital',
  SELECT_VISIT_TYPE: 'select_visit_type',
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
  CHECK_BOOKING_STATUS: 'check_booking_status',
  WAITLIST_CONFIRM: 'waitlist_confirm',
  COLLECT_FEEDBACK_RATING: 'collect_feedback_rating',
  COLLECT_FEEDBACK_COMMENT: 'collect_feedback_comment',
};

function genBookingId() {
  const { randomUUID } = require('crypto');
  return 'MB' + randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
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
  let best = null, bestDist = Infinity;
  for (const item of items) {
    const dist = levenshtein(lower, item[nameField].toLowerCase());
    const threshold = Math.max(2, Math.floor(item[nameField].length * 0.4));
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
  if (plainJson.length > LIMITS.SESSION_CONTEXT_MAX_BYTES) {
    logger.warn(`Session context too large (${plainJson.length} bytes), resetting to idle`);
    await tenantQuery(schemaName,
      `UPDATE bot_sessions SET state='idle', context='{}', last_activity=NOW() WHERE phone=$1`, [phone]);
    return;
  }
  // Encrypt context before storage to protect PII (patient names, DOB, selected options)
  const { encrypt } = require('../../utils/encryption');
  const encryptedContext = JSON.stringify({ _enc: encrypt(plainJson) });
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

async function notifyWaitlistForDoctor(schema, doctorId, tenant) {
  try {
    const waToken = tenant?.wa_access_token_enc ? decrypt(tenant.wa_access_token_enc) : null;
    const waPhoneId = tenant?.wa_phone_number_id;
    if (!waToken || !waPhoneId) return;

    const doctorR = await tenantQuery(schema, `SELECT name FROM doctors WHERE id=$1`, [doctorId]);
    const doctorName = doctorR.rows[0]?.name || 'your doctor';

    const wl = await tenantQuery(schema,
      `SELECT wl.*, p.phone FROM waiting_list wl JOIN patients p ON p.id=wl.patient_id
       WHERE wl.doctor_id=$1 AND wl.notified=false LIMIT 5`, [doctorId]);
    for (const entry of wl.rows) {
      try {
        await wa.sendText(entry.phone,
          `🎉 *Slot Available!*\n\nA slot has opened up with Dr. ${doctorName}.\n\nReply *Hi* to book your appointment now before it's taken!`,
          waToken, waPhoneId
        );
        await tenantQuery(schema,
          `UPDATE bot_sessions SET state='main_menu', context='{}', last_activity=NOW() WHERE phone=$1`, [entry.phone]);
        // Remove entry from waiting list after notifying — this lets the patient
        // re-join if they miss this slot and want notifications for future openings.
        await tenantQuery(schema,
          `DELETE FROM waiting_list WHERE id=$1`, [entry.id]);
      } catch (err) {
        logger.warn('Waitlist notification failed for entry', { phone: entry.phone, waitlistId: entry.id, error: err.message });
      }
    }
  } catch (err) {
    logger.warn('notifyWaitlistForDoctor failed', { schema, doctorId, error: err.message });
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
  notifyWaitlistForDoctor,
};
