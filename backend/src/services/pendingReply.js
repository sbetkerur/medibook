'use strict';
/**
 * "Which clinic is waiting for an answer from this phone?"
 *
 * Inbound WhatsApp messages are routed by the patient's currently selected
 * clinic (global_bot_sessions). That is right for anything the patient starts,
 * and wrong for anything a CLINIC starts: reminders and feedback requests are
 * sent per tenant by the crons, and the reply — "yes", "4" — carries nothing
 * that says who asked. A patient booked at clinic A who then switched to clinic
 * B had their reminder confirmation looked up in B's schema, found nothing, and
 * silently dropped; a rating landed in B's bot engine as unrecognised input.
 *
 * So the sending cron records its expectation here, and routes/webhook.js
 * consults it before handing a plausible reply to the current clinic.
 *
 * Deliberately best-effort: every function swallows its errors. A message that
 * routes to the patient's current clinic (today's behaviour) is a far better
 * failure mode than a message that is not processed at all.
 */
const { query } = require('../db');
const logger = require('../utils/logger');

const KINDS = {
  CONFIRMATION: 'confirmation', // reply to a 24h reminder: yes / no
  FEEDBACK: 'feedback',         // reply to a feedback request: 1–5
};

/**
 * Note that `tenantId` is waiting for a `kind` reply from `phone`.
 * Re-recording refreshes the expiry — the most recent ask wins.
 */
async function recordPendingReply(phone, tenantId, kind, ttlHours) {
  if (!phone || !tenantId || !kind) return;
  try {
    await query(
      `INSERT INTO global_pending_replies (phone, tenant_id, kind, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(hours => $4::int))
       ON CONFLICT (phone, tenant_id, kind)
       DO UPDATE SET expires_at = EXCLUDED.expires_at, created_at = NOW()`,
      [phone, tenantId, kind, ttlHours]
    );
  } catch (err) {
    logger.warn('recordPendingReply failed', { kind, error: err.message });
  }
}

/**
 * The tenant most recently waiting for this kind of reply, or null.
 * If two clinics are both waiting, the one that asked last wins — it is the
 * message still on the patient's screen.
 */
async function findPendingReplyTenant(phone, kind) {
  if (!phone || !kind) return null;
  try {
    const r = await query(
      `SELECT tenant_id FROM global_pending_replies
       WHERE phone=$1 AND kind=$2 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [phone, kind]
    );
    return r.rows[0]?.tenant_id || null;
  } catch (err) {
    logger.warn('findPendingReplyTenant failed', { kind, error: err.message });
    return null;
  }
}

/** Drop the expectation once it has been answered. */
async function clearPendingReply(phone, tenantId, kind) {
  if (!phone || !tenantId || !kind) return;
  try {
    await query(
      `DELETE FROM global_pending_replies WHERE phone=$1 AND tenant_id=$2 AND kind=$3`,
      [phone, tenantId, kind]
    );
  } catch (err) {
    logger.warn('clearPendingReply failed', { kind, error: err.message });
  }
}

module.exports = { KINDS, recordPendingReply, findPendingReplyTenant, clearPendingReply };
