'use strict';
/**
 * Patient-side booking of subsequent treatment sittings.
 *
 * The clinical flow this serves: a patient books a consultation with the clinic,
 * the dentist diagnoses a treatment, and the FIRST sitting is normally booked at
 * the desk before the patient leaves. Everything after that is the patient's own
 * — they get a nudge on WhatsApp and book the next sitting themselves rather
 * than the receptionist chasing them.
 *
 * This module only picks the plan. Once picked it hands straight over to
 * bookingFlow's dentist step, so dates, slots, patient details and the atomic
 * slot lock stay in exactly one place — the plan just pre-fills the branch,
 * treatment and dentist the patient would otherwise have had to choose again.
 */
const { tenantQuery } = require('../../db');
const { STATES, parseChoiceNumber, updateSession, clinicPhoneLine } = require('./utils');

/** Plans the patient can still book a sitting on, newest first. */
async function getOpenPlans(schema, phone) {
  const r = await tenantQuery(schema, `
    SELECT tp.id, tp.title, tp.total_visits, tp.hospital_id, tp.department_id,
           tp.treating_doctor_id,
           dep.name AS department_name,
           h.name AS hospital_name,
           d.name AS doctor_name, d.qualification, d.consultation_fee, d.specialization,
           COUNT(a.id) FILTER (WHERE a.status = 'completed')::int AS completed_visits,
           COUNT(a.id) FILTER (WHERE a.status <> 'cancelled')::int AS booked_visits
    FROM treatment_plans tp
    JOIN patients p ON p.id = tp.patient_id
    LEFT JOIN departments dep ON dep.id = tp.department_id
    LEFT JOIN hospitals h ON h.id = tp.hospital_id
    LEFT JOIN doctors d ON d.id = tp.treating_doctor_id AND d.is_active = true
    LEFT JOIN appointments a ON a.treatment_plan_id = tp.id
    WHERE p.phone = $1 AND p.deleted_at IS NULL
      AND tp.status IN ('proposed','in_progress')
      -- Clinic-scheduled courses (ortho) are booked at the chair. Offering the
      -- patient a slot list for their next adjustment invites a booking the
      -- dentist did not plan, at a date the treatment is not ready for.
      AND tp.scheduling_mode = 'patient'
    GROUP BY tp.id, dep.name, h.name, d.name, d.qualification, d.consultation_fee, d.specialization
    HAVING COUNT(a.id) FILTER (WHERE a.status <> 'cancelled') < tp.total_visits
    ORDER BY tp.created_at DESC
    LIMIT 10
  `, [phone]);
  return r.rows;
}

/** "visit 2 of 3" — the only thing the patient actually needs to recognise. */
function planLabel(plan) {
  return `${plan.title} — visit ${plan.booked_visits + 1} of ${plan.total_visits}`;
}

/**
 * Show the patient their unbooked sittings.
 *
 * With exactly one open plan there is nothing to choose, so it goes straight to
 * that plan's dates — the nudge already named the treatment, and re-asking
 * "which treatment?" of someone with one treatment is the kind of step that
 * loses people mid-flow.
 *
 * @returns {boolean} false when there was nothing to show, so the caller can
 *   fall through to its own handling rather than leaving the patient with no reply.
 */
async function showTreatmentPlans(phone, schema, tenant, send, ctx = {}) {
  const plans = await getOpenPlans(schema, phone);

  if (!plans.length) {
    await send.text(
      'You have no treatment sittings waiting to be booked.\n\n' +
      'If you are having braces or aligners, your next visit is arranged by the ' +
      'dentist at your appointment — there is nothing for you to book here.\n\n' +
      'Reply *Menu* to book an ordinary appointment.'
    );
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return false;
  }

  if (plans.length === 1) {
    return startPlanBooking(phone, schema, tenant, send, ctx, plans[0]);
  }

  const rows = plans.map(p => ({
    id: `plan:${p.id}`,
    title: p.title.slice(0, 24),
    description: `Visit ${p.booked_visits + 1} of ${p.total_visits}`
      + (p.doctor_name ? ` · Dr. ${p.doctor_name}` : ''),
  }));
  await send.list(
    'Which one would you like to book the next sitting for?',
    'View Treatments',
    [{ title: 'Ongoing Treatments', rows }]
  );
  await updateSession(schema, phone, STATES.SELECT_TREATMENT_PLAN, { ...ctx, _plans: plans });
  return true;
}

/** Resolve the patient's pick and hand over to the dentist/date step. */
async function handleSelectTreatmentPlan(phone, schema, tenant, send, ctx, choice, input) {
  const plans = ctx._plans || [];
  const byId = plans.find(p => choice === `plan:${p.id}` || choice === p.id);
  const num = parseChoiceNumber(input);
  const byNum = num >= 1 && num <= plans.length ? plans[num - 1] : null;
  // No fuzzyFind over titles: treatment titles are free text written by the
  // clinic ("Root canal 26", "Root canal 27") and are routinely near-identical,
  // which is exactly the case fuzzyFind refuses to resolve. Re-ask instead.
  const plan = byId || byNum;

  if (!plan) {
    if (plans.length) {
      await send.list(
        'I could not tell which treatment you meant. Please pick one from the list:',
        'View Treatments',
        [{
          title: 'Ongoing Treatments',
          rows: plans.map(p => ({
            id: `plan:${p.id}`,
            title: p.title.slice(0, 24),
            description: `Visit ${p.booked_visits + 1} of ${p.total_visits}`,
          })),
        }]
      );
      await updateSession(schema, phone, STATES.SELECT_TREATMENT_PLAN, ctx);
      return;
    }
    return showTreatmentPlans(phone, schema, tenant, send, ctx);
  }

  return startPlanBooking(phone, schema, tenant, send, ctx, plan);
}

/**
 * Pre-fill the booking context from the plan and jump to the dentist step,
 * which lists that dentist's dates.
 *
 * Re-read under the hood by bookingFlow.completeBooking, which re-checks the
 * visit count inside the booking transaction — this context is a convenience,
 * never the authority on whether another sitting may be booked.
 */
async function startPlanBooking(phone, schema, tenant, send, ctx, plan) {
  if (!plan.treating_doctor_id || !plan.doctor_name) {
    // The dentist was deactivated after the plan was written. The patient can't
    // resolve that; the clinic has to reassign it.
    await send.text(
      `*${plan.title}*\n\n` +
      'The dentist looking after this treatment is not taking online bookings at the moment. ' +
      'Please call us and we will arrange your next sitting.\n\nReply *Menu* to go back.'
      + await clinicPhoneLine(schema, plan.hospital_id)
    );
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return true;
  }

  const nextVisit = plan.booked_visits + 1;
  await send.text(
    `*${planLabel(plan)}*\n\n` +
    `with Dr. ${plan.doctor_name}${plan.specialization ? ` · ${plan.specialization}` : ''}\n` +
    (plan.hospital_name ? `${plan.hospital_name}\n` : '') +
    `\nLet us find you a time.`
  );

  const planCtx = {
    ...ctx,
    hospital_id: plan.hospital_id,
    hospital_name: plan.hospital_name,
    department_id: plan.department_id,
    department_name: plan.department_name || plan.title,
    treatment_plan_id: plan.id,
    treatment_plan_title: plan.title,
    treatment_visit_number: nextVisit,
    visit_type: 'in_person',
    visit_label: '🦷 In-Clinic Visit',
    // handleSelectDoctor picks from this list; one entry means the patient never
    // sees a dentist picker for a treatment that already has a dentist assigned.
    _doctors: [{
      id: plan.treating_doctor_id,
      name: plan.doctor_name,
      qualification: plan.qualification,
      consultation_fee: plan.consultation_fee,
      specialization: plan.specialization,
    }],
  };

  // Required lazily: bookingFlow requires this module back for the general
  // consultation path, and a top-level require would be a cycle.
  const { handleSelectDoctor } = require('./bookingFlow');
  return handleSelectDoctor(phone, schema, tenant, send, planCtx, plan.treating_doctor_id, plan.doctor_name);
}

module.exports = {
  getOpenPlans,
  planLabel,
  showTreatmentPlans,
  handleSelectTreatmentPlan,
  startPlanBooking,
};
