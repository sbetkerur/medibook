'use strict';
/**
 * Outbound WhatsApp sends that are recorded in the tenant's message history.
 *
 * botEngine's `send.*` helpers already log everything they send, but the CRONS
 * do not go through botEngine: reminders, feedback requests and post-visit
 * follow-ups called `wa.sendText`/`wa.sendTemplate` directly, so none of them
 * ever reached `wa_messages`. The clinic's history was therefore missing
 * exactly the messages patients ring up about ("I never got a reminder"), and
 * delivery receipts for them had no row to attach to — `updateMessageStatus`
 * matches on `wa_message_id` in that table.
 *
 * Use these wrappers for any patient-facing send outside the bot engine.
 * A send that throws is NOT logged: the history must record what actually went
 * out, and callers already treat the throw as "not sent" (reminders fall back
 * to plain text, and leave `reminder_*_sent` false so the next run retries).
 */
const wa = require('./whatsapp');
const { logMessage } = require('./bot/utils');

/** Send a plain text message and record it. Shared phone → global META_* env. */
async function sendPatientText(schema, phone, text) {
  // Record the id Meta returns: it is the join key delivery receipts arrive
  // with, so a row logged without it can never leave status NULL.
  const waMessageId = await wa.sendText(phone, text, null, null);
  await logMessage(schema, phone, 'out', 'text', text, waMessageId);
}

/**
 * Send an approved template and record it.
 * @param {string} logText - human-readable rendering stored as the history
 *   entry; the raw parameter array would be meaningless to clinic staff.
 */
async function sendPatientTemplate(schema, phone, templateName, components, logText) {
  const waMessageId = await wa.sendTemplate(phone, templateName, components, null, null);
  await logMessage(schema, phone, 'out', 'template', logText || `[template: ${templateName}]`, waMessageId);
}

module.exports = { sendPatientText, sendPatientTemplate };
