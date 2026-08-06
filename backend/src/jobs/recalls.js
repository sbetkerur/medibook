'use strict';
/**
 * "You're due for a check-up."
 *
 * The recare loop. Everything else in this codebase talks to a patient about
 * something already in motion — an appointment they booked, a visit they had, a
 * treatment a dentist advised. This is the only job that contacts a patient with
 * nothing wrong, which is exactly why it is the cheapest revenue a clinic has
 * and the easiest for a busy front desk to never get around to.
 */
const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const { forEachActiveTenantParallel } = require('../utils/tenantUtils');
const { withCronLock } = require('../utils/cronLock');
const { IST_TODAY_SQL } = require('../utils/dateTz');
// Clinic-initiated and months after the last visit, so far outside Meta's
// 24-hour window: template-first or it does not arrive. See services/outbound.js.
const { sendPatientMessage } = require('../services/outbound');
const { canSendDiscretionary, budgetFor } = require('../services/messageBudget');
const { recordPendingReply, KINDS } = require('../services/pendingReply');
const { maskPhone } = require('../services/bot/utils');
const logger = require('../utils/logger');

const RECALL_TEMPLATE = 'patient_recall_checkup';
// Ask at most this many times, then leave them alone. A patient who ignored
// three check-up reminders has answered.
const MAX_SENDS_PER_RECALL = 3;
// …and never more often than this. Recare is a yearly rhythm, not a weekly one.
const MIN_DAYS_BETWEEN_SENDS = 30;
const RECALL_BATCH_LIMIT = 40;

/**
 * Recalls that are due and may be contacted now.
 *
 * The `NOT EXISTS` is the one that matters: a patient who has already booked
 * something since the recall was raised does not need chasing, and a "you're due
 * for a check-up" message on top of an appointment they have next week is how a
 * clinic's number gets muted.
 */
async function findRecallsDue(schema) {
  const r = await tenantQuery(schema, `
    SELECT r.id, r.reason, r.due_date::text AS due_date, r.send_count,
           p.id AS patient_id, p.phone, p.name AS patient_name,
           h.name AS hospital_name
    FROM patient_recalls r
    JOIN patients p ON p.id = r.patient_id
    LEFT JOIN hospitals h ON h.id = r.hospital_id
    WHERE r.status = 'due'
      AND r.due_date <= ${IST_TODAY_SQL}
      AND p.opted_out IS NOT TRUE
      AND p.deleted_at IS NULL
      AND r.send_count < $1
      AND (r.last_sent_at IS NULL OR r.last_sent_at < NOW() - make_interval(days => $2::int))
      AND NOT EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.patient_id = p.id
          AND a.status = 'confirmed'
          AND a.appointment_date >= ${IST_TODAY_SQL}
      )
    ORDER BY r.due_date
    LIMIT $3
  `, [MAX_SENDS_PER_RECALL, MIN_DAYS_BETWEEN_SENDS, RECALL_BATCH_LIMIT]);
  return r.rows;
}

async function sendRecalls() {
  await forEachActiveTenantParallel('sendRecalls', async (tenant) => {
    if (tenant.settings?.recalls_enabled === false) return;

    const due = await findRecallsDue(tenant.schema_name);
    for (const rec of due) {
      // Outside the try — same reasoning as the treatment nudge: `continue`
      // from inside it still runs the finally, so a suppressed send burned one
      // of the recall's three attempts without ever attempting one. Three quiet
      // months exhausted the recall and findRecallsDue then excluded it
      // forever, silently dropping that patient out of the recare loop.
      //
      // Six months have passed already; another week costs nothing.
      if (!await canSendDiscretionary(tenant.schema_name, rec.phone, budgetFor(tenant))) continue;

      try {
        const firstName = rec.patient_name ? rec.patient_name.split(' ')[0] : 'there';
        // In step with the `patient_recall_checkup` template.
        const text =
          `🦷 *Time for a check-up*\n\n` +
          `Hi ${firstName}, it's been a while since we saw you${rec.hospital_name ? ` at ${rec.hospital_name}` : ''}.\n\n` +
          `A check-up takes about twenty minutes and catches small problems while they're still small — and still cheap to fix.\n\n` +
          `Reply *Menu* to find a time that suits you.`;

        await sendPatientMessage(tenant.schema_name, rec.phone, {
          template: RECALL_TEMPLATE,
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: firstName },
              { type: 'text', text: rec.hospital_name || 'the clinic' },
            ],
          }],
          buttonPayloads: ['Menu'],
          text,
        });
        // Clinic-initiated question, so the answer has to be able to find its
        // way back. Without this, a patient who has since searched for another
        // clinic on the shared number opened THAT clinic's menu and, if they
        // booked, booked there — while this clinic's recall stayed 'due',
        // closeActedOnRecalls (which only scans this schema) never closed it,
        // and they were chased again next month up to MAX_SENDS_PER_RECALL.
        //
        // 72h: a recall is not urgent and patients answer it when they get
        // round to it, but an answer three days later is no longer a reply to
        // this message.
        await recordPendingReply(rec.phone, tenant.id, KINDS.RECALL, 72);
        logger.info('Recall sent', {
          tenant: tenant.slug, recall: rec.id, phone: maskPhone(rec.phone), due: rec.due_date,
        });
      } catch (err) {
        logger.error('Recall send failed', { recall: rec.id, error: err.message });
      } finally {
        // Counted on the ATTEMPT — same reasoning as the treatment nudge. A send
        // that can never succeed (no approved template, patient blocked us) must
        // exhaust its budget rather than retry every day forever.
        await tenantQuery(tenant.schema_name,
          `UPDATE patient_recalls SET last_sent_at=NOW(), send_count=send_count+1, updated_at=NOW() WHERE id=$1`,
          [rec.id]).catch(e => logger.warn('Recall bookkeeping failed', { recall: rec.id, error: e.message }));
      }
    }
  });
}

/**
 * Close recalls the patient has acted on.
 *
 * A patient who books anything after being reminded has done what was asked;
 * leaving the recall 'due' would have them chased again next month. Runs before
 * the sends so a booking made yesterday stops today's message.
 */
async function closeActedOnRecalls() {
  await forEachActiveTenantParallel('closeActedOnRecalls', async (tenant) => {
    await tenantQuery(tenant.schema_name, `
      UPDATE patient_recalls r
      SET status='booked', booked_appointment_id = a.id, updated_at=NOW()
      FROM appointments a
      WHERE a.patient_id = r.patient_id
        AND r.status = 'due'
        AND a.status = 'confirmed'
        AND a.appointment_date >= ${IST_TODAY_SQL}
        AND a.created_at >= r.created_at
    `);
  });
}

function startRecallCron() {
  // 11:00 IST, half an hour after the treatment nudge so the two never contend
  // for the same clinic's send quota in the same minute.
  const task = cron.schedule('0 11 * * *', async () => {
    await withCronLock('cron:recalls', 3600, async () => {
      logger.info('Running recall cron...');
      try {
        await closeActedOnRecalls();
        await sendRecalls();
        try {
          await query(
            `UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='recalls'`
          );
        } catch (_) {}
      } catch (err) {
        logger.error('Recall cron error', { error: err.message });
        try {
          await query(
            `UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='recalls'`,
            [err.message]
          );
        } catch (_) {}
      }
    });
  }, { timezone: 'Asia/Kolkata' });
  logger.info('Recall cron registered (daily 11:00 IST)');
  return task;
}

module.exports = {
  startRecallCron,
  sendRecalls,
  closeActedOnRecalls,
  findRecallsDue,
  MAX_SENDS_PER_RECALL,
  MIN_DAYS_BETWEEN_SENDS,
};
