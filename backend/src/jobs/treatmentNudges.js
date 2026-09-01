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
 *
 * Orthodontics/braces (utils/treatmentPlan.js isOrthodonticDepartment) is
 * self-bookable too, but runs on its own cadence — one nudge, a month after
 * the last sitting — instead of this cron's ordinary short-course one, since
 * an adjustment is due roughly monthly, not every few days.
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
const { nextFreeVisitNumber } = require('../utils/treatmentPlan');
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
// Orthodontics/braces (utils/treatmentPlan.js isOrthodonticDepartment): an
// adjustment is roughly monthly, so the short-course cadence above would chase
// a patient weekly for something that isn't due yet. One nudge, a month after
// the last sitting, matches how the course actually runs. "One" is per GAP, not
// per plan — see the orthoOnly clause in findPlansNeedingNudge, which is what
// makes the allowance reset each time the patient attends a sitting.
const ORTHO_QUIET_DAYS_AFTER_VISIT = 30;
// A LIFETIME BACKSTOP, not the cadence gate. The per-gap rule ("one nudge, and
// not until the patient has attended another sitting") is enforced by the
// orthoOnly clause in findPlansNeedingNudge, because nudge_count only ever
// increments and so cannot express "one per gap" on its own. This value used to
// be 1, which the counter then read as one nudge for the ENTIRE two-year
// course. 30 is above the 24-ish adjustments of the longest real case — and
// total_visits itself caps at 60 — so it bounds a runaway without ever being
// reached by a course running normally.
const ORTHO_MAX_NUDGES_PER_PLAN = 30;
// Cap per clinic per run, matching the feedback job — a clinic that has just
// migrated a backlog of plans must not fire hundreds of messages in one minute.
const NUDGE_BATCH_LIMIT = 25;
// Approved Meta template for this message. Until a clinic's WhatsApp account
// has it, sendPatientMessage falls back to plain text, which reaches only the
// patients already inside the 24-hour window.
const TREATMENT_NUDGE_TEMPLATE = 'treatment_sitting_reminder';
// Same keyword match as utils/treatmentPlan.js's isOrthodonticDepartment,
// spelled for Postgres — the department name is free text a clinic typed
// themselves, so there's no id to key off.
const ORTHO_DEPT_SQL = `dep.name ~* '(ortho|brace|aligner)'`;

/**
 * Courses that need a nudge right now, for ONE cadence.
 *
 * Every condition here is a reason NOT to message someone, which is why they
 * live in SQL rather than in a filter after the fact. Called twice by
 * sendTreatmentNudges — once for the ordinary short-course cadence, once for
 * orthodontics' monthly one — rather than folding both into one query with a
 * per-row CASE, so each cadence's thresholds stay simple named parameters
 * instead of duplicated conditional expressions.
 */
async function findPlansNeedingNudge(schema, { orthoOnly, maxNudges, minDaysBetweenNudges, quietDaysAfterVisit, limit }) {
  const r = await tenantQuery(schema, `
    SELECT tp.id, tp.title, tp.total_visits, tp.nudge_count,
           p.phone, p.name AS patient_name,
           d.name AS doctor_name,
           h.name AS hospital_name,
           COUNT(a.id) FILTER (WHERE a.status <> 'cancelled')::int AS booked_visits,
           array_remove(array_agg(a.visit_number) FILTER (WHERE a.status <> 'cancelled'), NULL) AS used_visit_numbers
    FROM treatment_plans tp
    JOIN patients p ON p.id = tp.patient_id
    LEFT JOIN departments dep ON dep.id = tp.department_id
    LEFT JOIN doctors d ON d.id = tp.treating_doctor_id AND d.is_active = true
    LEFT JOIN hospitals h ON h.id = tp.hospital_id
    LEFT JOIN appointments a ON a.treatment_plan_id = tp.id
    WHERE tp.status IN ('proposed','in_progress')
      -- 'clinic' mode (chair-scheduled courses) is still excluded from the
      -- ordinary cadence — EXCEPT orthodontics, which is always self-bookable
      -- (services/bot/treatmentFlow.js) and just runs on its own, slower
      -- cadence instead of being excluded outright.
      AND (tp.scheduling_mode = 'patient' OR ${ORTHO_DEPT_SQL})
      AND COALESCE(${ORTHO_DEPT_SQL}, false) = $5
      AND p.opted_out IS NOT TRUE
      AND p.deleted_at IS NULL
      -- The lifetime cap. For the ordinary short-course cadence this is exactly
      -- what is wanted and what CLAUDE.md documents: three messages ignored
      -- means the patient has decided, and a fourth is how a clinic's number
      -- gets blocked.
      AND tp.nudge_count < $1
      AND (tp.last_nudge_at IS NULL OR tp.last_nudge_at < NOW() - make_interval(days => $2::int))
      -- …but for ORTHODONTICS the cap must be per GAP, not per plan. A braces
      -- course is 18-24 monthly adjustments over two years, and the documented
      -- cadence is "one nudge, 30 days after the last sitting" — i.e. one per
      -- missed adjustment. nudge_count only ever increments, so with
      -- ORTHO_MAX_NUDGES_PER_PLAN = 1 the condition above allowed exactly ONE
      -- nudge for the whole two years: the patient was chased once after
      -- sitting 3, booked sittings 4-8, and was then never nudged again for the
      -- remaining ~14 adjustments. Requiring the last nudge to predate the most
      -- recent sitting restarts the allowance every time the patient actually
      -- attends, which is the behaviour the constant was named for.
      ${orthoOnly ? `AND (
        tp.last_nudge_at IS NULL
        OR tp.last_nudge_at < (
             SELECT MAX(seen.appointment_date)::timestamptz
               FROM appointments seen
              WHERE seen.treatment_plan_id = tp.id AND seen.status <> 'cancelled'
           )
      )` : ''}
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
  `, [maxNudges, minDaysBetweenNudges, quietDaysAfterVisit, limit, orthoOnly]);
  return r.rows;
}

async function sendTreatmentNudges() {
  await forEachActiveTenantParallel('sendTreatmentNudges', async (tenant) => {
    const settings = tenant.settings || {};
    if (settings.treatment_nudges_enabled === false) return;

    const plans = [
      ...await findPlansNeedingNudge(tenant.schema_name, {
        orthoOnly: false, maxNudges: MAX_NUDGES_PER_PLAN, minDaysBetweenNudges: MIN_DAYS_BETWEEN_NUDGES,
        quietDaysAfterVisit: QUIET_DAYS_AFTER_VISIT, limit: NUDGE_BATCH_LIMIT,
      }),
      ...await findPlansNeedingNudge(tenant.schema_name, {
        orthoOnly: true, maxNudges: ORTHO_MAX_NUDGES_PER_PLAN, minDaysBetweenNudges: ORTHO_QUIET_DAYS_AFTER_VISIT,
        quietDaysAfterVisit: ORTHO_QUIET_DAYS_AFTER_VISIT, limit: NUDGE_BATCH_LIMIT,
      }),
    ];
    for (const plan of plans) {
      // The budget gate sits OUTSIDE the try, because `continue` from inside it
      // would still run the finally and burn one of the plan's three attempts
      // on a send that was never attempted. A patient who booked their first
      // sitting over WhatsApp is routinely over budget for the following week,
      // and three suppressed weeks used to exhaust the plan permanently — the
      // half-finished root canal then never got nudged at all, which is the one
      // thing this job exists to prevent.
      //
      // A nudge is the most skippable message this product sends — the patient
      // has an open course and will be reminded again in a week.
      if (!await canSendDiscretionary(tenant.schema_name, plan.phone, budgetFor(tenant))) continue;

      // Set when the trial send cap swallowed the nudge (sendPatientMessage
      // returns { via: 'suppressed_cap' } rather than throwing). Nothing
      // reached the patient and the cap is transient, so the finally must not
      // spend one of the three attempts on it — otherwise a trial clinic that
      // stays over its cap for three runs exhausts nudge_count without the
      // patient ever seeing a nudge, the exact permanent silence this job
      // exists to prevent.
      let suppressedByCap = false;
      try {
        const nextVisit = nextFreeVisitNumber(plan.used_visit_numbers, plan.booked_visits);
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

        const sendResult = await sendPatientMessage(tenant.schema_name, plan.phone, {
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
        // Skip when the new-tenant send cap suppressed the nudge: the patient
        // never saw it, so a pending "treatment" reply would only misroute
        // their next unrelated message (resolveAskingTenant).
        if (sendResult?.via === 'suppressed_cap') {
          suppressedByCap = true;
          logger.info('Treatment nudge suppressed by trial send cap — will retry', { plan: plan.id });
          continue;
        }
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
        // A cap suppression is the one non-attempt: it will clear itself.
        if (!suppressedByCap) {
          await tenantQuery(tenant.schema_name,
            `UPDATE treatment_plans SET last_nudge_at=NOW(), nudge_count=nudge_count+1 WHERE id=$1`,
            [plan.id]).catch(e => logger.warn('Nudge bookkeeping failed', { plan: plan.id, error: e.message }));
        }
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
  ORTHO_QUIET_DAYS_AFTER_VISIT,
  ORTHO_MAX_NUDGES_PER_PLAN,
};
