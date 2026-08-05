'use strict';
/**
 * "Your next sitting isn't booked yet."
 *
 * The first sitting of a treatment is normally booked at the desk before the
 * patient leaves. Every sitting after that is the patient's own to arrange, and
 * without a nudge it is simply forgotten — which is both a half-finished root
 * canal and the clinic's largest quiet revenue leak.
 *
 * This cron finds courses with a sitting still unbooked and no upcoming visit on
 * the calendar, and asks the patient to book it. The reply is handled by
 * botEngine's *Treatment* keyword, which walks them through dates and slots.
 */
const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const { forEachActiveTenantParallel } = require('../utils/tenantUtils');
const { withCronLock } = require('../utils/cronLock');
const { IST_TODAY_SQL } = require('../utils/dateTz');
// Template-first: this cron targets patients who have NOT messaged recently
// (that is its trigger condition), so they are outside Meta's 24-hour window
// and a plain text send is rejected. See services/outbound.js.
const { sendPatientMessage } = require('../services/outbound');
const { canSendDiscretionary, budgetFor } = require('../services/messageBudget');
// Clinic-INITIATED question on a shared WhatsApp number: without this the reply
// is looked up in whichever clinic the patient last searched for.
const { KINDS, recordPendingReply } = require('../services/pendingReply');
const { maskPhone } = require('../services/bot/utils');
const logger = require('../utils/logger');

// Wait this long after the last sitting before asking. Nudging the morning
// after a visit reads as pestering; the gap between sittings of a real course
// is days, not hours.
const QUIET_DAYS_AFTER_VISIT = 3;
// Never ask the same patient about the same course more often than this…
const MIN_DAYS_BETWEEN_NUDGES = 7;
// …and never more than this many times in total. A patient who has ignored
// three messages has decided; continuing is what gets a clinic's number blocked.
const MAX_NUDGES_PER_PLAN = 3;
// Cap per clinic per run, matching the feedback job — a clinic that has just
// migrated a backlog of plans must not fire hundreds of messages in one minute.
const NUDGE_BATCH_LIMIT = 25;
// Approved Meta template for this message. Until a clinic's WhatsApp account
// has it, sendPatientMessage falls back to plain text, which reaches only the
// patients already inside the 24-hour window.
const TREATMENT_NUDGE_TEMPLATE = 'treatment_sitting_reminder';

/**
 * Courses that need a nudge right now.
 *
 * Every condition here is a reason NOT to message someone, which is why they
 * live in SQL rather than in a filter after the fact.
 */
async function findPlansNeedingNudge(schema) {
  const r = await tenantQuery(schema, `
    SELECT tp.id, tp.title, tp.total_visits, tp.nudge_count,
           p.phone, p.name AS patient_name,
           d.name AS doctor_name,
           h.name AS hospital_name,
           COUNT(a.id) FILTER (WHERE a.status <> 'cancelled')::int AS booked_visits
    FROM treatment_plans tp
    JOIN patients p ON p.id = tp.patient_id
    LEFT JOIN doctors d ON d.id = tp.treating_doctor_id AND d.is_active = true
    LEFT JOIN hospitals h ON h.id = tp.hospital_id
    LEFT JOIN appointments a ON a.treatment_plan_id = tp.id
    WHERE tp.status IN ('proposed','in_progress')
      -- Orthodontics is 18-24 monthly adjustments and the next one is set by
      -- the dentist at the chair ("come back in four weeks"), never chosen by
      -- the patient from a slot list. Nudging them to self-book a monthly
      -- adjustment is wrong for the single biggest course type in an Indian
      -- practice, and it is 24 unwanted messages per patient.
      AND tp.scheduling_mode = 'patient'
      AND p.opted_out IS NOT TRUE
      AND p.deleted_at IS NULL
      AND tp.nudge_count < $1
      AND (tp.last_nudge_at IS NULL OR tp.last_nudge_at < NOW() - make_interval(days => $2::int))
      -- Nothing already on the calendar: a patient with an upcoming sitting
      -- gets the ordinary 24h reminder, not a "you haven't booked" message.
      AND NOT EXISTS (
        SELECT 1 FROM appointments up
        WHERE up.treatment_plan_id = tp.id
          AND up.status = 'confirmed'
          AND up.appointment_date >= ${IST_TODAY_SQL}
      )
      -- Let the dust settle after the previous sitting.
      AND NOT EXISTS (
        SELECT 1 FROM appointments recent
        WHERE recent.treatment_plan_id = tp.id
          AND recent.status <> 'cancelled'
          AND recent.appointment_date > ${IST_TODAY_SQL} - make_interval(days => $3::int)
      )
    GROUP BY tp.id, p.phone, p.name, d.name, h.name
    HAVING COUNT(a.id) FILTER (WHERE a.status <> 'cancelled') < tp.total_visits
    ORDER BY tp.updated_at
    LIMIT $4
  `, [MAX_NUDGES_PER_PLAN, MIN_DAYS_BETWEEN_NUDGES, QUIET_DAYS_AFTER_VISIT, NUDGE_BATCH_LIMIT]);
  return r.rows;
}

async function sendTreatmentNudges() {
  await forEachActiveTenantParallel('sendTreatmentNudges', async (tenant) => {
    const settings = tenant.settings || {};
    if (settings.treatment_nudges_enabled === false) return;

    const plans = await findPlansNeedingNudge(tenant.schema_name);
    for (const plan of plans) {
      try {
        const nextVisit = plan.booked_visits + 1;
        const isFirst = plan.booked_visits === 0;

        // In step with the `treatment_sitting_reminder` template.
        const text =
          `🦷 *About your treatment*\n\n` +
          (isFirst
            ? `Your dentist advised *${plan.title}* — ${plan.total_visits} sitting${plan.total_visits > 1 ? 's' : ''} in total, and none of them booked yet.\n`
            : `Your *${plan.title}* isn't finished. Sitting *${nextVisit}* of *${plan.total_visits}* still needs a date.\n`) +
          (plan.doctor_name ? `\nwith Dr. ${plan.doctor_name}` : '') +
          (plan.hospital_name ? `\n${plan.hospital_name}` : '') +
          `\n\nLeaving a treatment part-done can undo the work already carried out, so let's get it in the diary.\n\n` +
          `Reply *Treatment* to pick a time, or call the clinic.`;

        // A nudge is the most skippable message this product sends — the
        // patient has an open course and will be reminded again in a week.
        if (!await canSendDiscretionary(tenant.schema_name, plan.phone, budgetFor(tenant))) continue;

        await sendPatientMessage(tenant.schema_name, plan.phone, {
          template: TREATMENT_NUDGE_TEMPLATE,
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: plan.title },
              { type: 'text', text: String(nextVisit) },
              { type: 'text', text: String(plan.total_visits) },
              { type: 'text', text: plan.doctor_name || 'your dentist' },
              // {{5}} — see the note in jobs/reminders.js: a clinic-initiated
              // message on a shared number has to say which clinic.
              { type: 'text', text: tenant.name },
            ],
          }],
          // Button 1 on the template. 'Treatment' is the keyword the engine
          // acts on; the label the patient sees can read however we like.
          buttonPayloads: ['Treatment'],
          text,
        });

        // The reply is "treatment" — meaningless on its own, so record which
        // clinic is waiting for it. 7 days: long enough for a patient who reads
        // it on the weekend, short enough not to outlive the next nudge.
        await recordPendingReply(plan.phone, tenant.id, KINDS.TREATMENT, 24 * 7);

        logger.info('Treatment nudge sent', {
          tenant: tenant.slug, plan: plan.id, phone: maskPhone(plan.phone), visit: nextVisit,
        });
      } catch (err) {
        // Per-plan catch: one unreachable number must not stop the rest of the
        // clinic's nudges.
        logger.error('Treatment nudge failed', { plan: plan.id, error: err.message });
      } finally {
        // Counted on the ATTEMPT, not on success. Writing it only on success
        // meant a send that can never succeed — no approved template, the
        // patient blocked the number — was retried every single day forever,
        // and nudge_count never reached MAX_NUDGES_PER_PLAN to stop it. The
        // trade is that a transient failure costs one of three attempts, which
        // is much cheaper than an unbounded daily retry against every plan.
        await tenantQuery(tenant.schema_name,
          `UPDATE treatment_plans SET last_nudge_at=NOW(), nudge_count=nudge_count+1 WHERE id=$1`,
          [plan.id]).catch(e => logger.warn('Nudge bookkeeping failed', { plan: plan.id, error: e.message }));
      }
    }
  });
}

function startTreatmentNudgeCron() {
  // 10:30 IST — inside clinic hours, so a patient who replies immediately
  // reaches a bot backed by staff who can pick up the phone if it goes wrong.
  // TTL is under the 24h gap between runs, per the withCronLock contract.
  const task = cron.schedule('30 10 * * *', async () => {
    await withCronLock('cron:treatment_nudges', 3600, async () => {
      logger.info('Running treatment nudge cron...');
      try {
        await sendTreatmentNudges();
        try {
          await query(
            `UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='treatment_nudges'`
          );
        } catch (_) {}
      } catch (err) {
        logger.error('Treatment nudge cron error', { error: err.message });
        try {
          await query(
            `UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='treatment_nudges'`,
            [err.message]
          );
        } catch (_) {}
      }
    });
  }, { timezone: 'Asia/Kolkata' });
  logger.info('Treatment nudge cron registered (daily 10:30 IST)');
  return task;
}

module.exports = {
  startTreatmentNudgeCron,
  sendTreatmentNudges,
  findPlansNeedingNudge,
  QUIET_DAYS_AFTER_VISIT,
  MIN_DAYS_BETWEEN_NUDGES,
  MAX_NUDGES_PER_PLAN,
};
