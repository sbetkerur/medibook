'use strict';
/**
 * How many messages one patient may receive from a clinic in a week.
 *
 * Every cron here throttles ITSELF — nudges wait 7 days, recalls close when the
 * patient books, feedback fires once per appointment. None of them look at the
 * patient as a whole. A root-canal patient with three sittings can collect two
 * reminders per sitting, a feedback request after each, up to three treatment
 * nudges and a recall: a dozen-plus WhatsApp messages from one number inside a
 * few weeks.
 *
 * That is how a number earns blocks, and every clinic shares one number — so
 * one clinic's over-messaging degrades delivery for all of them (see
 * docs/whatsapp-outage-plan.md). This is the budget none of them had.
 *
 * WHAT IS GATED, AND WHAT IS NOT.
 * Only DISCRETIONARY sends are gated: feedback requests, post-visit follow-ups,
 * treatment nudges and recalls. Those are the clinic starting a conversation
 * nobody asked for. Appointment reminders and booking confirmations are never
 * gated — a patient with an appointment tomorrow wants that message, suppressing
 * it causes the no-show the reminder exists to prevent, and a missed reminder is
 * a far worse failure than one unsent nudge.
 *
 * The COUNT, though, includes everything the patient received. Blocking is
 * driven by total volume as they experience it, not by our categories.
 */
const { tenantQuery } = require('../db');
const logger = require('../utils/logger');

// Six in seven days: comfortably above a normal week (two reminders, a
// confirmation, a feedback request) and below the volume that reads as spam.
const DEFAULT_MAX = 6;
const DEFAULT_WINDOW_DAYS = 7;

/**
 * May we send this patient a discretionary message right now?
 *
 * Fails OPEN. A budget check that cannot run must not silence a clinic's whole
 * outreach — the failure mode we are avoiding is being too noisy, and the cure
 * must not be worse than the disease.
 *
 * @param {string} schema      tenant schema
 * @param {string} phone       patient's phone
 * @param {object} [opts]      { max, windowDays } — per-clinic override
 * @returns {Promise<boolean>}
 */
async function canSendDiscretionary(schema, phone, opts = {}) {
  // `>= 0`, not `> 0`. Zero is the one value that means "send this patient
  // nothing discretionary at all", and it was the only value the guard threw
  // away: budgetFor faithfully returned max:0 and this line replaced it with the
  // default 6. So a clinic whose outreach was deliberately halted — the lever
  // you reach for when Meta drops the shared number's quality rating — carried
  // on sending up to six messages a week per patient, with nothing to show the
  // setting had been ignored. `sent >= max` short-circuits correctly at 0.
  const max = Number.isInteger(opts.max) && opts.max >= 0 ? opts.max : DEFAULT_MAX;
  const days = Number.isInteger(opts.windowDays) && opts.windowDays > 0
    ? opts.windowDays : DEFAULT_WINDOW_DAYS;
  try {
    const r = await tenantQuery(schema, `
      SELECT COUNT(*)::int AS n
        FROM wa_messages
       WHERE phone = $1
         AND direction = 'out'
         -- admin_alert goes to STAFF, not to this patient, and must never eat a
         -- patient's budget. It shares the table because it shares the sender.
         AND message_type <> 'admin_alert'
         AND created_at >= NOW() - make_interval(days => $2::int)
    `, [phone, days]);
    const sent = r.rows[0]?.n ?? 0;
    if (sent >= max) {
      logger.info('Discretionary message suppressed — patient over budget', {
        schema, sent, max, days,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('Message budget check failed — allowing send', { schema, error: err.message });
    return true;
  }
}

/**
 * The clinic's own budget, if it set one. Kept here so every cron reads the
 * setting the same way rather than each inventing its own key.
 */
function budgetFor(tenant) {
  const s = tenant?.settings || {};
  return {
    max: Number.isInteger(s.message_budget_max) ? s.message_budget_max : DEFAULT_MAX,
    windowDays: Number.isInteger(s.message_budget_days) ? s.message_budget_days : DEFAULT_WINDOW_DAYS,
  };
}

module.exports = { canSendDiscretionary, budgetFor, DEFAULT_MAX, DEFAULT_WINDOW_DAYS };
