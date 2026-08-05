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
const logger = require('../utils/logger');

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
 * @param {string[]} [buttonPayloads] - quick-reply payloads, index-aligned with
 *   the template's buttons. See quickReplyComponents below.
 */
async function sendPatientTemplate(schema, phone, templateName, components, logText, buttonPayloads) {
  const waMessageId = await wa.sendTemplate(phone, templateName,
    [...(components || []), ...quickReplyComponents(buttonPayloads)], null, null);
  await logMessage(schema, phone, 'out', 'template', logText || `[template: ${templateName}]`, waMessageId);
}

/**
 * Quick-reply payloads for a template's buttons.
 *
 * WhatsApp Manager's create-template form has no payload field — a quick-reply
 * button there is only a LABEL. The payload the webhook receives is supplied by
 * the SENDER, one button component per button, index-aligned with the order the
 * buttons appear in the template.
 *
 * Without this the label doubles as the payload, which forces every button to be
 * worded exactly like the keyword it triggers ("Treatment", "Yes") — so the
 * buttons in docs/whatsapp-templates.md ("Book my next sitting") would have
 * arrived as unrecognised text and done nothing.
 *
 * @param {string[]} [payloads] - e.g. ['Yes', 'Reschedule', 'Cancel appointment']
 */
function quickReplyComponents(payloads) {
  if (!Array.isArray(payloads) || !payloads.length) return [];
  return payloads.slice(0, 3).map((payload, index) => ({
    type: 'button',
    sub_type: 'quick_reply',
    index: String(index),
    parameters: [{ type: 'payload', payload: String(payload) }],
  }));
}

/**
 * A message the CLINIC starts, sent template-first.
 *
 * Meta only allows free-form text inside the 24-hour customer service window —
 * i.e. to a patient who has messaged us recently. Every cron in this codebase
 * messages patients who by definition have NOT (a reminder for tomorrow, a
 * feedback request, "your next sitting isn't booked"), so a plain sendText is
 * rejected for exactly the audience it is aimed at. The two reminder crons
 * always knew this and open-coded template-then-text; the feedback, post-visit
 * and treatment-nudge crons did not, and would have gone silent in production
 * while logging a per-patient error.
 *
 * The text fallback is still worth attempting: it succeeds for anyone who IS
 * inside the window, and it is what runs in dev where no template is approved.
 *
 * @param {object} opts
 * @param {string} [opts.template]   - approved template name; skipped if absent
 * @param {Array}  [opts.components] - template components
 * @param {string} opts.text         - the human-readable message, also the history entry
 */
async function sendPatientMessage(schema, phone, { template, components, buttonPayloads, text }) {
  if (template) {
    try {
      await sendPatientTemplate(schema, phone, template,
        [...(components || []), ...quickReplyComponents(buttonPayloads)], text);
      return { via: 'template' };
    } catch (err) {
      // Not an error worth surfacing: an unapproved template is the normal
      // state until the clinic's WhatsApp account is fully set up.
      logger.debug?.('Template send failed, falling back to text', { template, error: err.message });
    }
  }
  await sendPatientText(schema, phone, text);
  return { via: 'text' };
}

module.exports = { sendPatientText, sendPatientTemplate, sendPatientMessage, quickReplyComponents };
