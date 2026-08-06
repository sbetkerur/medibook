'use strict';
/**
 * Multi-visit treatment plans.
 *
 * The common clinical path: a patient books a general dentist, the dentist
 * diagnoses something that takes several visits, and those visits are rendered
 * either by the same dentist or by a specialist in the same clinic. This file
 * records that advice, tracks the course of visits, and books the next one.
 *
 * Progress is derived from the linked appointments — see utils/treatmentPlan.js.
 *
 * Auth + tenant middleware are applied once in index.js; route files must not
 * re-apply them (see CLAUDE.md).
 */
const router = require('express').Router();
const { tenantQuery, tenantTransaction } = require('../db');
const { validateUUID, handleError, UUID_RE } = require('../utils/errors');
const { adminOnly, writeAuditLog } = require('./adminHelpers');
const { planProgress, derivePlanStatus, canTransitionPlan, PLAN_STATUSES } = require('../utils/treatmentPlan');
const { IST_TODAY_SQL } = require('../utils/dateTz');
const logger = require('../utils/logger');

// Shared by POST and PATCH, and matched by the treatment_plans_total_visits_check
// CHECK constraint in tenantMigrate.js. The two routes drifted once — PATCH kept
// an old cap of 30 while POST allowed 60 — which made a long orthodontic course
// creatable but permanently uneditable. One constant, both call sites.
const MAX_TOTAL_VISITS = 60;

const OPEN_STATUSES = ['proposed', 'in_progress'];
// A started course with nothing booked and no sitting in this long is not
// "pending", it is abandoned. 30 days is past any normal gap between sittings
// (a root canal runs 1–3 weeks apart) without flagging a slow but live course.
const STALLED_AFTER_DAYS = 30;

// Visit counts per plan, derived rather than stored. Cancelled visits don't
// count as booked — that's the whole reason these are computed.
const PROGRESS_SQL = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed_visits,
           COUNT(*) FILTER (WHERE a.status <> 'cancelled')::int AS booked_visits,
           -- The EARLIEST still-upcoming visit. MIN over confirmed rows alone
           -- would surface a visit the clinic already sat through but never
           -- marked completed; IST, not CURRENT_DATE, which is a day behind
           -- until 05:30 and would drop today's visit off the card.
           MIN(a.appointment_date) FILTER (
             WHERE a.status = 'confirmed' AND a.appointment_date >= ${IST_TODAY_SQL}
           )::text AS next_visit_date,
           -- When anything last actually happened on this course. Distinguishes
           -- "advised yesterday, not booked yet" from "started three months ago
           -- and the patient stopped coming" — which read identically before,
           -- and are completely different conversations.
           MAX(a.appointment_date) FILTER (WHERE a.status IN ('completed','no_show'))::text AS last_visit_date,
           COUNT(*) FILTER (WHERE a.status = 'no_show')::int AS no_show_visits,
           -- Ordinals already taken by live visits. Read here as well as at the
           -- write site so the "Book visit N" label the operator clicks is the
           -- N the booking will actually use.
           COALESCE(
             ARRAY_AGG(a.visit_number) FILTER (WHERE a.status <> 'cancelled' AND a.visit_number IS NOT NULL),
             '{}'
           ) AS used_visit_numbers
    FROM appointments a WHERE a.treatment_plan_id = tp.id
  ) prog ON TRUE`;

// Collected against the course. Separate from appointments.effective_fee, which
// is the per-visit consultation fee — a course is billed as a whole.
const PAID_SQL = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(amount), 0)::int AS amount_paid
    FROM treatment_payments pay WHERE pay.treatment_plan_id = tp.id
  ) money ON TRUE`;

const PLAN_SELECT_SQL = `
  SELECT tp.*,
         p.name AS patient_name, p.phone AS patient_phone,
         dep.name AS treatment_name,
         h.name AS hospital_name,
         advisor.name AS advised_by_name,
         treater.name AS treating_doctor_name, treater.specialization AS treating_doctor_specialization,
         svc.name AS service_name,
         COALESCE(prog.completed_visits, 0) AS completed_visits,
         COALESCE(prog.booked_visits, 0) AS booked_visits,
         COALESCE(prog.used_visit_numbers, '{}') AS used_visit_numbers,
         prog.next_visit_date, prog.last_visit_date,
         COALESCE(prog.no_show_visits, 0) AS no_show_visits,
         COALESCE(money.amount_paid, 0) AS amount_paid,
         COALESCE(lab.open_lab_items, 0) AS open_lab_items,
         lab.next_lab_expected
  FROM treatment_plans tp
  JOIN patients p ON p.id = tp.patient_id
  LEFT JOIN departments dep ON dep.id = tp.department_id
  LEFT JOIN hospitals h ON h.id = tp.hospital_id
  LEFT JOIN doctors advisor ON advisor.id = tp.advised_by_doctor_id
  LEFT JOIN doctors treater ON treater.id = tp.treating_doctor_id
  LEFT JOIN clinic_services svc ON svc.id = tp.service_id
  ${PROGRESS_SQL}
  ${PAID_SQL}
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS open_lab_items,
           MIN(expected_date)::text AS next_lab_expected
    FROM lab_works lw
    WHERE lw.treatment_plan_id = tp.id AND lw.status IN ('pending','sent')
  ) lab ON TRUE`;

/** Attach derived progress so clients never recompute it (and never disagree). */
function withProgress(row) {
  const progress = planProgress({
    totalVisits: row.total_visits,
    completedVisits: row.completed_visits,
    bookedVisits: row.booked_visits,
    usedVisitNumbers: row.used_visit_numbers,
  });
  const estimated = Number(row.estimated_cost) || 0;
  const paid = Number(row.amount_paid) || 0;

  // Abandoned mid-course: work has started, nothing is on the calendar, and the
  // last sitting was long enough ago that the patient has stopped rather than
  // simply not got round to it. A clinic chases this differently from a fresh
  // recommendation — there is usually money outstanding and a tooth left open.
  const daysSinceLastVisit = row.last_visit_date
    ? Math.floor((Date.now() - Date.parse(row.last_visit_date + 'T00:00:00Z')) / 86400000)
    : null;
  const stalled = progress.visitsDone > 0
    && !progress.isComplete
    && !row.next_visit_date
    && daysSinceLastVisit != null && daysSinceLastVisit >= STALLED_AFTER_DAYS;

  return {
    ...row,
    ...progress,
    amount_paid: paid,
    days_since_last_visit: daysSinceLastVisit,
    stalled,
    // Clamped at 0: a course paid over the estimate (extra work, a revised
    // quote nobody updated) must not display as a negative amount owed.
    balance_due: Math.max(0, estimated - paid),
    // Paid MORE than estimated is worth surfacing rather than hiding — it
    // usually means the estimate is stale, not that the patient overpaid.
    overpaid: paid > estimated && estimated > 0,
  };
}

// ── LIST ──────────────────────────────────────────────────────
// `outstanding=true` is the money question: treatment advised, visits still not
// booked. That is the report a clinic owner actually wants.
router.get('/treatment-plans', async (req, res) => {
  try {
    const { status, patient_id, outstanding } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;
    const s = req.tenant.schema_name;

    const where = [];
    const params = [];
    if (status) {
      const list = String(status).split(',').map(x => x.trim()).filter(Boolean);
      if (!list.every(x => PLAN_STATUSES.includes(x))) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${PLAN_STATUSES.join(', ')}` });
      }
      params.push(list);
      where.push(`tp.status = ANY($${params.length})`);
    }
    if (patient_id) {
      if (!UUID_RE.test(patient_id)) return res.status(400).json({ error: 'Invalid patient_id format' });
      params.push(patient_id);
      where.push(`tp.patient_id = $${params.length}`);
    }
    if (outstanding === 'true') {
      params.push(OPEN_STATUSES);
      where.push(`tp.status = ANY($${params.length})`);
      // Compared against booked_visits, not completed: a plan whose remaining
      // visits are already on the calendar is not outstanding work.
      where.push(`COALESCE(prog.booked_visits, 0) < tp.total_visits`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit, offset);
    const [r, countR] = await Promise.all([
      tenantQuery(s, `
        ${PLAN_SELECT_SQL}
        ${whereSql}
        ORDER BY tp.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params),
      tenantQuery(s, `
        SELECT COUNT(*) FROM treatment_plans tp ${PROGRESS_SQL} ${whereSql}
      `, params.slice(0, params.length - 2)),
    ]);

    const total = parseInt(countR.rows[0]?.count || 0);
    res.json({
      treatment_plans: r.rows.map(withProgress),
      total, page, limit, has_more: offset + r.rows.length < total,
    });
  } catch (err) { handleError(res, err, 'GET /treatment-plans'); }
});

// ── ONE PLAN + ITS VISITS ─────────────────────────────────────
router.get('/treatment-plans/:id', validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `${PLAN_SELECT_SQL} WHERE tp.id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Treatment plan not found' });

    const visits = await tenantQuery(s, `
      SELECT a.id, a.booking_id, a.visit_number, a.status,
             a.appointment_date::text AS appointment_date, a.appointment_time::text AS appointment_time,
             a.notes, d.name AS doctor_name
      FROM appointments a
      LEFT JOIN doctors d ON d.id = a.doctor_id
      WHERE a.treatment_plan_id = $1
      ORDER BY a.visit_number NULLS LAST, a.appointment_date, a.appointment_time
    `, [req.params.id]);

    res.json({ treatment_plan: withProgress(r.rows[0]), visits: visits.rows });
  } catch (err) { handleError(res, err, 'GET /treatment-plans/:id'); }
});

// ── RECORD TREATMENT ADVISED ──────────────────────────────────
// Not adminOnly, matching PATCH /appointments/:id: recording what the dentist
// advised is the clinical work of the dentist and the front desk typing it up.
// Withholding it from those two roles would leave only the owner able to record
// a diagnosis, which is backwards. Cancelling a plan IS admin-gated below.
router.post('/treatment-plans', async (req, res) => {
  try {
    const {
      appointment_id, patient_id, department_id, service_id,
      treating_doctor_id, title, tooth_ref, total_visits, estimated_cost, notes,
      scheduling_mode,
    } = req.body;
    const s = req.tenant.schema_name;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title is required (what treatment was advised)' });
    }
    // 60, not 30: a two-year orthodontic case is monthly adjustments plus
    // bonding, debond and retainer reviews. Still bounded — an unbounded value
    // here is a typo that puts hundreds of visits on a plan.
    const visits = parseInt(total_visits ?? 1, 10);
    if (!Number.isInteger(visits) || visits < 1 || visits > MAX_TOTAL_VISITS) {
      return res.status(400).json({ error: `total_visits must be between 1 and ${MAX_TOTAL_VISITS}` });
    }
    // Who books the sittings after the first. 'patient' (the default) is the
    // ordinary case: the patient is nudged and books the next one themselves.
    // 'clinic' is orthodontics and anything else the dentist schedules at the
    // chair — those plans are never nudged and never offered in the bot's
    // treatment list, because the date depends on clinical progress the
    // patient cannot judge.
    const mode = scheduling_mode || 'patient';
    if (!['patient', 'clinic'].includes(mode)) {
      return res.status(400).json({ error: "scheduling_mode must be 'patient' or 'clinic'" });
    }
    const cost = parseInt(estimated_cost ?? 0, 10);
    if (!Number.isInteger(cost) || cost < 0 || cost > 10000000) {
      return res.status(400).json({ error: 'estimated_cost must be between 0 and 10000000' });
    }
    for (const [name, value] of Object.entries({ appointment_id, patient_id, department_id, service_id, treating_doctor_id })) {
      if (value && !UUID_RE.test(value)) return res.status(400).json({ error: `Invalid ${name} format` });
    }

    // Everything the plan needs is on the originating appointment — the visit
    // where the dentist actually said this. Deriving patient/branch/advisor from
    // it means the front desk types a diagnosis, not a foreign key.
    let origin = null;
    if (appointment_id) {
      const originR = await tenantQuery(s, `
        SELECT a.id, a.patient_id, a.hospital_id, a.doctor_id, a.department_id
        FROM appointments a WHERE a.id = $1
      `, [appointment_id]);
      if (!originR.rows[0]) return res.status(404).json({ error: 'Originating appointment not found' });
      origin = originR.rows[0];
    }

    const effectivePatientId = patient_id || origin?.patient_id;
    if (!effectivePatientId) {
      return res.status(400).json({ error: 'patient_id is required when appointment_id is not given' });
    }
    const patientR = await tenantQuery(s,
      `SELECT id FROM patients WHERE id=$1 AND deleted_at IS NULL`, [effectivePatientId]);
    if (!patientR.rows[0]) return res.status(400).json({ error: 'Patient not found' });

    // Who renders it: the same dentist, or a specialist in the clinic. Defaults
    // to whoever advised it — the "I'll do it myself" case, which is the common one.
    const effectiveTreatingId = treating_doctor_id || origin?.doctor_id || null;
    let treatingDoctor = null;
    if (effectiveTreatingId) {
      const docR = await tenantQuery(s,
        `SELECT id, name, hospital_id, department_id FROM doctors WHERE id=$1 AND is_active=true`, [effectiveTreatingId]);
      if (!docR.rows[0]) return res.status(400).json({ error: 'Treating dentist not found or is deactivated' });
      treatingDoctor = docR.rows[0];
    }

    // The treating dentist's branch, not the originating appointment's: a
    // referral to a specialist who sits at another branch happens there.
    const effectiveHospitalId = treatingDoctor?.hospital_id || origin?.hospital_id || null;

    // The treatment this course IS — it labels every sitting's receipt and the
    // "by treatment" analytics. Order matters:
    //   1. what the clinic said explicitly;
    //   2. the treating dentist's own specialty — a referral to the endodontist
    //      IS a root canal, whatever the consultation that produced it was
    //      filed under;
    //   3. the originating visit, last. Inheriting it first was wrong: a course
    //      diagnosed during a general consultation is not general dentistry, and
    //      every sitting of a root canal came out labelled "General Dentistry".
    const effectiveDepartmentId = department_id || treatingDoctor?.department_id || origin?.department_id || null;

    if (service_id) {
      const svcR = await tenantQuery(s,
        `SELECT id FROM clinic_services WHERE id=$1 AND is_active=true`, [service_id]);
      if (!svcR.rows[0]) return res.status(400).json({ error: 'Service not found' });
    }

    const r = await tenantQuery(s, `
      INSERT INTO treatment_plans
        (patient_id, hospital_id, department_id, service_id, origin_appointment_id,
         advised_by_doctor_id, treating_doctor_id, title, tooth_ref, total_visits,
         estimated_cost, notes, created_by_user_id, scheduling_mode)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [effectivePatientId, effectiveHospitalId, effectiveDepartmentId, service_id || null,
        appointment_id || null, origin?.doctor_id || null, effectiveTreatingId,
        String(title).trim().slice(0, 255), tooth_ref ? String(tooth_ref).slice(0, 50) : null,
        visits, cost, notes || null, req.user.id, mode]);

    await writeAuditLog(s, req.user.id, req.user.role, 'CREATE_TREATMENT_PLAN', 'treatment_plan',
      r.rows[0].id, null, { title: r.rows[0].title, total_visits: visits, treating_doctor_id: effectiveTreatingId, scheduling_mode: mode }, req.ip);

    res.json({ treatment_plan: withProgress({ ...r.rows[0], completed_visits: 0, booked_visits: 0 }) });
  } catch (err) { handleError(res, err, 'POST /treatment-plans'); }
});

// ── BOOK THE NEXT VISIT ───────────────────────────────────────
// Shares the booking-integrity primitives with every other booking path: atomic
// slot lock inside a transaction, insertAppointmentWithRetry, monthly quota.
router.post('/treatment-plans/:id/visits', validateUUID(), async (req, res) => {
  try {
    const { slot_id, doctor_id, after_days, notes } = req.body || {};
    const s = req.tenant.schema_name;

    if (slot_id && !UUID_RE.test(slot_id)) return res.status(400).json({ error: 'Invalid slot_id format' });
    if (doctor_id && !UUID_RE.test(doctor_id)) return res.status(400).json({ error: 'Invalid doctor_id format' });
    const afterDays = after_days === undefined ? 7 : parseInt(after_days, 10);
    if (!Number.isInteger(afterDays) || afterDays < 0 || afterDays > 365) {
      return res.status(400).json({ error: 'after_days must be between 0 and 365' });
    }

    const planR = await tenantQuery(s, `${PLAN_SELECT_SQL} WHERE tp.id = $1`, [req.params.id]);
    if (!planR.rows[0]) return res.status(404).json({ error: 'Treatment plan not found' });
    const plan = withProgress(planR.rows[0]);

    if (!OPEN_STATUSES.includes(plan.status)) {
      return res.status(409).json({ error: `Cannot book a visit on a ${plan.status} treatment plan` });
    }
    if (!plan.canBookNext) {
      return res.status(409).json({
        error: `All ${plan.total_visits} visit(s) for this treatment are already booked. Raise total_visits first if more are needed.`,
      });
    }

    const targetDoctorId = doctor_id || plan.treating_doctor_id;
    if (!targetDoctorId) {
      return res.status(400).json({ error: 'This plan has no treating dentist — pass doctor_id' });
    }
    const docR = await tenantQuery(s,
      `SELECT id, name, hospital_id FROM doctors WHERE id=$1 AND is_active=true`, [targetDoctorId]);
    if (!docR.rows[0]) return res.status(400).json({ error: 'Treating dentist not found or is deactivated' });
    const doctor = docR.rows[0];

    const { insertAppointmentWithRetry, checkMonthlyQuota, SLOT_DAY_OPEN_SQL } = require('../services/bookingCore');
    // A 3-visit treatment is 3 appointments. Metering them here keeps this from
    // being a back door around the cap, exactly as the follow-up route does.
    const quota = await checkMonthlyQuota(req.tenant);
    if (!quota.allowed) {
      return res.status(403).json({
        error: `Monthly appointment limit reached for your plan (${quota.used}/${quota.limit}). Upgrade to book more appointments.`,
        quota_exceeded: true,
      });
    }

    let booked;
    try {
      booked = await tenantTransaction(s, async (client) => {
        // Lock the plan first, then the slot. Every multi-table writer in this
        // codebase takes locks in that order (appointment/plan → slot); two of
        // them meeting on the same rows in opposite orders deadlock.
        const lockedPlan = await client.query(
          `SELECT id, status, total_visits FROM treatment_plans WHERE id=$1 FOR UPDATE`, [req.params.id]);
        if (!lockedPlan.rows[0]) { const e = new Error('GONE'); e.code = 'GONE'; throw e; }

        // Re-count under the lock: the check above ran before the transaction,
        // so two near-simultaneous requests can both pass it and over-book the
        // course. Only the first to hold the lock may proceed.
        // used_visit_numbers is what the new sitting's ordinal is derived from —
        // the lowest number no live visit holds. Read under the same plan lock
        // as the counts, so two receptionists booking at once cannot both be
        // handed the same free number.
        const countR = await client.query(`
          SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_visits,
                 COUNT(*) FILTER (WHERE status <> 'cancelled')::int AS booked_visits,
                 COALESCE(
                   ARRAY_AGG(visit_number) FILTER (WHERE status <> 'cancelled' AND visit_number IS NOT NULL),
                   '{}'
                 ) AS used_visit_numbers
          FROM appointments WHERE treatment_plan_id = $1
        `, [req.params.id]);
        const live = planProgress({
          totalVisits: lockedPlan.rows[0].total_visits,
          completedVisits: countR.rows[0].completed_visits,
          bookedVisits: countR.rows[0].booked_visits,
          usedVisitNumbers: countR.rows[0].used_visit_numbers,
        });
        if (!live.canBookNext) { const e = new Error('PLAN_FULL'); e.code = 'PLAN_FULL'; throw e; }

        // Either the slot the caller picked, or the first one open on/after the
        // gap the dentist asked for. SLOT_DAY_OPEN_SQL excludes doctor leaves
        // and clinic holidays; the IST clauses keep a past slot from being booked.
        const slotSql = slot_id
          ? `SELECT id, hospital_id, slot_date::text, start_time::text
             FROM time_slots
             WHERE id=$1 AND doctor_id=$2 AND status='available'
               AND (slot_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                    OR (slot_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                        AND start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time))
               AND ${SLOT_DAY_OPEN_SQL}
             FOR UPDATE SKIP LOCKED`
          : `SELECT id, hospital_id, slot_date::text, start_time::text
             FROM time_slots
             WHERE doctor_id=$2 AND status='available'
               AND slot_date >= ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + ($1::text || ' days')::interval)::date
               AND (slot_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                    OR start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time)
               AND ${SLOT_DAY_OPEN_SQL}
             ORDER BY slot_date, start_time
             LIMIT 1
             FOR UPDATE SKIP LOCKED`;
        const slotR = await client.query(slotSql, [slot_id || String(afterDays), targetDoctorId]);
        if (!slotR.rows[0]) { const e = new Error('NO_SLOT'); e.code = 'NO_SLOT'; throw e; }
        const slot = slotR.rows[0];

        const slotUpd = await client.query(
          `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available'`, [slot.id]);
        if (slotUpd.rowCount === 0) { const e = new Error('SLOT_TAKEN'); e.code = 'SLOT_TAKEN'; throw e; }

        const inserted = await insertAppointmentWithRetry(client, {
          patientId: plan.patient_id,
          doctorId: targetDoctorId,
          hospitalId: slot.hospital_id || doctor.hospital_id,
          slotId: slot.id,
          appointmentDate: slot.slot_date,
          appointmentTime: slot.start_time,
          visitType: 'in_person',
          notes: notes || `${plan.title} — visit ${live.nextVisitNumber} of ${lockedPlan.rows[0].total_visits}`,
          departmentId: plan.department_id || null,
          treatmentPlanId: plan.id,
          visitNumber: live.nextVisitNumber,
        });

        // A booked visit means the course has started. derivePlanStatus refuses
        // to move a terminal plan, so this can't reopen anything.
        const nextStatus = derivePlanStatus(lockedPlan.rows[0].status, {
          totalVisits: lockedPlan.rows[0].total_visits,
          completedVisits: countR.rows[0].completed_visits,
          bookedVisits: countR.rows[0].booked_visits + 1,
        });
        if (nextStatus !== lockedPlan.rows[0].status) {
          await client.query(`UPDATE treatment_plans SET status=$1, updated_at=NOW() WHERE id=$2`,
            [nextStatus, req.params.id]);
        }
        return { ...inserted, slot, visitNumber: live.nextVisitNumber };
      });
    } catch (txErr) {
      if (txErr.code === 'GONE') return res.status(404).json({ error: 'Treatment plan not found' });
      if (txErr.code === 'PLAN_FULL') return res.status(409).json({ error: 'All visits for this treatment are already booked' });
      if (txErr.code === 'NO_SLOT') {
        return res.status(404).json({
          error: slot_id
            ? 'That slot is not available for this dentist (taken, in the past, or on a leave/holiday)'
            : `No available slots for Dr. ${doctor.name} on or after ${afterDays} day(s) from today`,
        });
      }
      if (txErr.code === 'SLOT_TAKEN') return res.status(409).json({ error: 'Slot is no longer available — please retry' });
      throw txErr;
    }

    await writeAuditLog(s, req.user.id, req.user.role, 'BOOK_TREATMENT_VISIT', 'treatment_plan', req.params.id,
      null, { booking_id: booked.bookingId, visit_number: booked.visitNumber, doctor_id: targetDoctorId }, req.ip);

    res.json({
      appointment: booked.row,
      booking_id: booked.bookingId,
      visit_number: booked.visitNumber,
      date: booked.slot.slot_date,
      time: booked.slot.start_time,
    });

    // Tell the patient, after responding — a WhatsApp failure must not fail the
    // booking. sendPatientText (not wa.sendText) so it lands in clinic history.
    // This is a STATEMENT, not a question, so it needs no pendingReply record:
    // nothing is waiting on a reply that could be routed to the wrong clinic.
    (async () => {
      try {
        const { sendPatientMessage } = require('../services/outbound');
        const { format, parseISO } = require('date-fns');
        const pretty = format(parseISO(booked.slot.slot_date), 'EEE, d MMM yyyy');
        const time = String(booked.slot.start_time).slice(0, 5);
        const branch = plan.hospital_name || '';

        // Restyled to match every other confirmation: WHEN and WHO lead,
        // supporting detail sits under them, one glyph at most. It was the last
        // message still opening each fact with its own emoji (🦷 👨‍⚕️ 📅 🏥).
        const text =
          `✅ *Your next visit is booked*\n\n` +
          `*${pretty}*\n` +
          `*${time}* with Dr. ${doctor.name}\n\n` +
          `${plan.title} — visit ${booked.visitNumber} of ${plan.total_visits}\n` +
          (branch ? `${branch}\n` : '') +
          `Booking ID *${booked.bookingId}*\n\n` +
          `Reply *Menu* for your appointments.`;

        // Template-first: the receptionist books this at the desk, so the
        // patient is very often NOT mid-conversation — outside Meta's 24-hour
        // window a plain text send is rejected and they hear nothing at all,
        // while the clinic believes they were told.
        await sendPatientMessage(s, plan.patient_phone, {
          template: 'treatment_sitting_booked',
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: String(plan.title).slice(0, 120) },
              { type: 'text', text: String(booked.visitNumber) },
              { type: 'text', text: String(plan.total_visits) },
              { type: 'text', text: pretty },
              { type: 'text', text: time },
              { type: 'text', text: String(doctor.name).slice(0, 60) },
              // A plan with no branch would leave the parameter empty, and Meta
              // rejects the whole send on an empty parameter.
              { type: 'text', text: branch || 'the clinic' },
            ],
          }],
          // Index-aligned with the template's two quick replies. Without this
          // the tap carries the payload stored on the template, which the form
          // prefills from the LABEL — "📅 Reschedule", matching neither
          // /^reschedule$/i nor /^cancel appointment$/i, so the button did
          // nothing. Every other buttoned template already passes these.
          buttonPayloads: ['Reschedule', 'Cancel appointment'],
          text,
        });
      } catch (err) {
        logger.warn('Treatment visit booked but patient notification failed', {
          plan: req.params.id, error: err.message,
        });
      }
    })();
  } catch (err) { handleError(res, err, 'POST /treatment-plans/:id/visits'); }
});

// ── UPDATE ────────────────────────────────────────────────────
router.patch('/treatment-plans/:id', validateUUID(), async (req, res) => {
  try {
    const { status, notes, total_visits, estimated_cost, treating_doctor_id, tooth_ref } = req.body || {};
    const s = req.tenant.schema_name;

    // Same reasoning as cancelling an appointment: recording and progressing a
    // plan is everyday clinic work, but writing one off is a decision with money
    // attached and stays with the owner.
    if (req.user?.role !== 'admin' && (status === 'cancelled' || status === 'declined')) {
      return res.status(403).json({ error: 'Admin access required to cancel or decline a treatment plan' });
    }

    const curR = await tenantQuery(s, `${PLAN_SELECT_SQL} WHERE tp.id = $1`, [req.params.id]);
    if (!curR.rows[0]) return res.status(404).json({ error: 'Treatment plan not found' });
    const cur = withProgress(curR.rows[0]);

    if (status) {
      if (!PLAN_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${PLAN_STATUSES.join(', ')}` });
      }
      if (status !== cur.status && !canTransitionPlan(cur.status, status)) {
        return res.status(409).json({
          error: `Invalid status transition: '${cur.status}' → '${status}'. ` +
            `Allowed from '${cur.status}': [${(require('../utils/treatmentPlan').PLAN_TRANSITIONS[cur.status] || []).join(', ') || 'none'}]`,
        });
      }
    }

    let visits;
    if (total_visits !== undefined) {
      visits = parseInt(total_visits, 10);
      // 60, not 30 — must match the POST cap and the DB CHECK. A two-year
      // orthodontic case is monthly adjustments plus bonding, debond and
      // retainer reviews, and a plan created at 48 has to stay editable.
      if (!Number.isInteger(visits) || visits < 1 || visits > MAX_TOTAL_VISITS) {
        return res.status(400).json({ error: `total_visits must be between 1 and ${MAX_TOTAL_VISITS}` });
      }
      // Shrinking below what's already on the calendar would make canBookNext
      // and the outstanding queue disagree with the appointments themselves.
      if (visits < cur.visitsBooked) {
        return res.status(409).json({
          error: `${cur.visitsBooked} visit(s) are already booked — cancel one before lowering total_visits to ${visits}`,
        });
      }
    }
    let cost;
    if (estimated_cost !== undefined) {
      cost = parseInt(estimated_cost, 10);
      if (!Number.isInteger(cost) || cost < 0 || cost > 10000000) {
        return res.status(400).json({ error: 'estimated_cost must be between 0 and 10000000' });
      }
    }
    if (treating_doctor_id) {
      if (!UUID_RE.test(treating_doctor_id)) return res.status(400).json({ error: 'Invalid treating_doctor_id format' });
      const docR = await tenantQuery(s,
        `SELECT id FROM doctors WHERE id=$1 AND is_active=true`, [treating_doctor_id]);
      if (!docR.rows[0]) return res.status(400).json({ error: 'Treating dentist not found or is deactivated' });
    }

    const updates = ['updated_at=NOW()'];
    const params = [];
    if (status) { params.push(status); updates.push(`status=$${params.length}`); }
    if (notes !== undefined) { params.push(notes); updates.push(`notes=$${params.length}`); }
    if (visits !== undefined) { params.push(visits); updates.push(`total_visits=$${params.length}`); }
    if (cost !== undefined) { params.push(cost); updates.push(`estimated_cost=$${params.length}`); }
    if (treating_doctor_id) { params.push(treating_doctor_id); updates.push(`treating_doctor_id=$${params.length}`); }
    if (tooth_ref !== undefined) { params.push(tooth_ref ? String(tooth_ref).slice(0, 50) : null); updates.push(`tooth_ref=$${params.length}`); }
    if (params.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    const idParam = params.length;
    // Guard on the status read above, so a concurrent transition can't be
    // overwritten between the check and this UPDATE.
    let guard = '';
    if (status) { params.push(cur.status); guard = ` AND status=$${params.length}`; }
    const r = await tenantQuery(s,
      `UPDATE treatment_plans SET ${updates.join(',')} WHERE id=$${idParam}${guard} RETURNING *`, params);
    if (!r.rows[0]) {
      return res.status(409).json({ error: 'Treatment plan changed concurrently — reload and retry' });
    }

    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_TREATMENT_PLAN', 'treatment_plan', req.params.id,
      { status: cur.status, total_visits: cur.total_visits }, { status, total_visits: visits }, req.ip);

    res.json({ treatment_plan: withProgress({ ...r.rows[0], completed_visits: cur.completed_visits, booked_visits: cur.booked_visits }) });
  } catch (err) { handleError(res, err, 'PATCH /treatment-plans/:id'); }
});

// ── PAYMENTS ──────────────────────────────────────────────────
const PAYMENT_METHODS = ['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'other'];

router.get('/treatment-plans/:id/payments', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name, `
      SELECT pay.*, a.booking_id
      FROM treatment_payments pay
      LEFT JOIN appointments a ON a.id = pay.appointment_id
      WHERE pay.treatment_plan_id = $1
      ORDER BY pay.collected_at DESC
    `, [req.params.id]);
    res.json({ payments: r.rows });
  } catch (err) { handleError(res, err, 'GET /treatment-plans/:id/payments'); }
});

// Not adminOnly: taking payment at the desk is the front desk's job, and it is
// additive — a mistake is corrected by deleting the row, which IS admin-gated.
router.post('/treatment-plans/:id/payments', validateUUID(), async (req, res) => {
  try {
    const { amount, method, note, appointment_id } = req.body || {};
    const s = req.tenant.schema_name;

    const amt = parseInt(amount, 10);
    if (!Number.isInteger(amt) || amt <= 0 || amt > 10000000) {
      return res.status(400).json({ error: 'amount must be a whole number of rupees between 1 and 10000000' });
    }
    if (method && !PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({ error: `Invalid method. Must be one of: ${PAYMENT_METHODS.join(', ')}` });
    }
    if (appointment_id && !UUID_RE.test(appointment_id)) {
      return res.status(400).json({ error: 'Invalid appointment_id format' });
    }

    const planR = await tenantQuery(s, `SELECT id, status FROM treatment_plans WHERE id=$1`, [req.params.id]);
    if (!planR.rows[0]) return res.status(404).json({ error: 'Treatment plan not found' });
    // Money can still arrive against a finished course (the balance settled a
    // week later), so completed plans accept payments. Only a course that never
    // happened does not.
    if (['declined', 'cancelled'].includes(planR.rows[0].status)) {
      return res.status(409).json({ error: `Cannot record a payment against a ${planR.rows[0].status} treatment` });
    }
    // A payment can be attached to the sitting it was taken at, but only to a
    // sitting of THIS course — otherwise a receipt points at another patient.
    if (appointment_id) {
      const apptR = await tenantQuery(s,
        `SELECT 1 FROM appointments WHERE id=$1 AND treatment_plan_id=$2`, [appointment_id, req.params.id]);
      if (!apptR.rows[0]) return res.status(400).json({ error: 'That appointment is not part of this treatment' });
    }

    const r = await tenantQuery(s, `
      INSERT INTO treatment_payments (treatment_plan_id, appointment_id, amount, method, note, collected_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [req.params.id, appointment_id || null, amt, method || 'cash', note || null, req.user.id]);

    await writeAuditLog(s, req.user.id, req.user.role, 'RECORD_TREATMENT_PAYMENT', 'treatment_plan', req.params.id,
      null, { amount: amt, method: method || 'cash' }, req.ip);

    const totals = await tenantQuery(s, `
      SELECT COALESCE(SUM(amount),0)::int AS amount_paid FROM treatment_payments WHERE treatment_plan_id=$1
    `, [req.params.id]);

    // ── THE RECEIPT ──────────────────────────────────────────
    // Every patient who pays asks for something to keep, and until now there
    // was nothing to give them — the only "receipt" in this codebase was a
    // WhatsApp delivery receipt. This is not a tax invoice (the product does
    // not issue those) and does not pretend to be: it is the payment slip a
    // front desk would hand over, in the place the patient will still have it
    // in six months.
    //
    // Best-effort and non-blocking: the money is already recorded, and a failed
    // WhatsApp send must never fail the request the receptionist just made or
    // tempt them into keying the payment twice.
    (async () => {
      const info = await tenantQuery(s, `
        SELECT p.phone, p.name AS patient_name, p.opted_out, tp.title, tp.estimated_cost
          FROM treatment_plans tp JOIN patients p ON p.id = tp.patient_id
         WHERE tp.id = $1
      `, [req.params.id]);
      const row = info.rows[0];
      if (!row?.phone || row.opted_out) return;

      const paid = totals.rows[0].amount_paid;
      // Clamped at 0 and reported the same way the plan's own balance is: an
      // overpayment usually means a stale estimate, and a negative "balance"
      // on a receipt is alarming rather than informative.
      const balance = Math.max(0, (row.estimated_cost || 0) - paid);
      const money = n => '₹' + Number(n || 0).toLocaleString('en-IN');
      const methodLabel = (method || 'cash').replace(/_/g, ' ');

      // The two figures that vary in SHAPE, not just in value, are pre-composed
      // into single parameters. A template cannot carry a conditional line, and
      // a course with no estimate has no balance to state — so the phrase is
      // built here and passed whole.
      const paidPhrase = row.estimated_cost
        ? `${money(paid)} of ${money(row.estimated_cost)}`
        : money(paid);
      const balancePhrase = !row.estimated_cost
        ? 'we will confirm the total with you'
        : (balance > 0 ? money(balance) : 'nothing further to pay');

      const text =
        `*Payment received*\n\n` +
        `${money(amt)} by ${methodLabel}\n` +
        `for *${row.title}*\n\n` +
        `Paid so far  ${paidPhrase}\n` +
        `Balance  ${balancePhrase}\n\n` +
        `Thank you — ${req.tenant.name}`;

      // Template-first. A payment is routinely recorded days after the patient
      // last messaged, which puts them outside Meta's 24-hour window — where a
      // plain text send is rejected outright and the patient gets nothing.
      const { sendPatientMessage } = require('../services/outbound');
      await sendPatientMessage(s, row.phone, {
        template: 'payment_receipt',
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: money(amt) },
            { type: 'text', text: methodLabel },
            { type: 'text', text: String(row.title).slice(0, 120) },
            { type: 'text', text: paidPhrase },
            { type: 'text', text: balancePhrase },
            { type: 'text', text: String(req.tenant.name).slice(0, 60) },
          ],
        }],
        text,
      });
    })().catch(err => logger.warn('Payment receipt not sent', { plan: req.params.id, error: err.message }));

    res.json({ payment: r.rows[0], amount_paid: totals.rows[0].amount_paid });
  } catch (err) { handleError(res, err, 'POST /treatment-plans/:id/payments'); }
});

/**
 * Record that consent was taken for this course.
 *
 * Extractions and surgery need one and it is what protects the dentist. This
 * records the FACT of consent — who took it, when, and what was explained —
 * rather than capturing a signature, which is a different and much larger
 * thing. The note is where "explained risk of nerve damage, patient agreed"
 * goes.
 *
 * Not adminOnly: the dentist who took the consent is usually not the account
 * owner, and consent recorded a day late by the one person allowed to type it
 * is worth less than consent recorded at the chair.
 */
router.post('/treatment-plans/:id/consent', validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const note = req.body?.note ? String(req.body.note).slice(0, 2000) : null;

    const r = await tenantQuery(s, `
      UPDATE treatment_plans
         SET consent_taken_at = NOW(), consent_taken_by = $1, consent_note = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, title, consent_taken_at, consent_note
    `, [req.user.id, note, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Treatment plan not found' });

    // Audited because it is evidence. An unaudited consent record is worth
    // little if it is ever actually needed.
    await writeAuditLog(s, req.user.id, req.user.role, 'RECORD_CONSENT', 'treatment_plan',
      req.params.id, null, { note }, req.ip);

    res.json({ treatment_plan: r.rows[0] });
  } catch (err) { handleError(res, err, 'POST /treatment-plans/:id/consent'); }
});

// Correcting a mis-keyed amount. Admin-only and audited: this is the one
// operation here that reduces recorded revenue.
router.delete('/treatment-plans/:id/payments/:paymentId', adminOnly, validateUUID(), async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.paymentId)) {
      return res.status(400).json({ error: 'Invalid payment ID' });
    }
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s,
      `DELETE FROM treatment_payments WHERE id=$1 AND treatment_plan_id=$2 RETURNING amount, method`,
      [req.params.paymentId, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Payment not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_TREATMENT_PAYMENT', 'treatment_plan', req.params.id,
      r.rows[0], null, req.ip);
    res.json({ success: true });
  } catch (err) { handleError(res, err, 'DELETE /treatment-plans/:id/payments/:paymentId'); }
});

// ── LAB WORK ──────────────────────────────────────────────────
const LAB_STATUSES = ['pending', 'sent', 'received', 'fitted', 'cancelled'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/lab-works', async (req, res) => {
  try {
    const { status, overdue } = req.query;
    const where = [];
    const params = [];
    if (status) {
      const list = String(status).split(',').map(x => x.trim()).filter(Boolean);
      if (!list.every(x => LAB_STATUSES.includes(x))) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${LAB_STATUSES.join(', ')}` });
      }
      params.push(list);
      where.push(`lw.status = ANY($${params.length})`);
    }
    // "The crown should have been here by now" — the only view staff open daily.
    if (overdue === 'true') {
      where.push(`lw.status IN ('pending','sent') AND lw.expected_date < ${IST_TODAY_SQL}`);
    }
    const r = await tenantQuery(req.tenant.schema_name, `
      SELECT lw.*, lw.sent_date::text AS sent_date, lw.expected_date::text AS expected_date,
             lw.received_date::text AS received_date,
             p.name AS patient_name, p.phone AS patient_phone, tp.title AS treatment_title
      FROM lab_works lw
      LEFT JOIN patients p ON p.id = lw.patient_id
      LEFT JOIN treatment_plans tp ON tp.id = lw.treatment_plan_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY lw.expected_date NULLS LAST, lw.created_at DESC
      LIMIT 200
    `, params);
    res.json({ lab_works: r.rows });
  } catch (err) { handleError(res, err, 'GET /lab-works'); }
});

router.post('/treatment-plans/:id/lab-works', validateUUID(), async (req, res) => {
  try {
    const { item, lab_name, sent_date, expected_date, cost, notes, status } = req.body || {};
    const s = req.tenant.schema_name;
    if (!item || !String(item).trim()) return res.status(400).json({ error: 'item is required (what went to the lab)' });
    for (const [name, v] of Object.entries({ sent_date, expected_date })) {
      if (v && !DATE_RE.test(v)) return res.status(400).json({ error: `${name} must be YYYY-MM-DD` });
    }
    if (status && !LAB_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${LAB_STATUSES.join(', ')}` });
    }
    const cst = parseInt(cost ?? 0, 10);
    if (!Number.isInteger(cst) || cst < 0 || cst > 10000000) {
      return res.status(400).json({ error: 'cost must be between 0 and 10000000' });
    }

    const planR = await tenantQuery(s, `SELECT id, patient_id FROM treatment_plans WHERE id=$1`, [req.params.id]);
    if (!planR.rows[0]) return res.status(404).json({ error: 'Treatment plan not found' });

    const r = await tenantQuery(s, `
      INSERT INTO lab_works (treatment_plan_id, patient_id, lab_name, item, sent_date, expected_date, cost, notes, status, created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [req.params.id, planR.rows[0].patient_id, lab_name || null, String(item).trim().slice(0, 255),
        sent_date || null, expected_date || null, cst, notes || null, status || (sent_date ? 'sent' : 'pending'), req.user.id]);
    await writeAuditLog(s, req.user.id, req.user.role, 'CREATE_LAB_WORK', 'treatment_plan', req.params.id,
      null, { item: r.rows[0].item, lab: lab_name }, req.ip);
    res.json({ lab_work: r.rows[0] });
  } catch (err) { handleError(res, err, 'POST /treatment-plans/:id/lab-works'); }
});

router.patch('/lab-works/:id', validateUUID(), async (req, res) => {
  try {
    const { status, lab_name, item, sent_date, expected_date, received_date, cost, notes } = req.body || {};
    const s = req.tenant.schema_name;
    if (status && !LAB_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${LAB_STATUSES.join(', ')}` });
    }
    for (const [name, v] of Object.entries({ sent_date, expected_date, received_date })) {
      if (v && !DATE_RE.test(v)) return res.status(400).json({ error: `${name} must be YYYY-MM-DD` });
    }

    const updates = ['updated_at=NOW()'];
    const params = [];
    const set = (col, val) => { params.push(val); updates.push(`${col}=$${params.length}`); };
    if (status) set('status', status);
    if (lab_name !== undefined) set('lab_name', lab_name || null);
    if (item !== undefined && String(item).trim()) set('item', String(item).trim().slice(0, 255));
    if (sent_date !== undefined) set('sent_date', sent_date || null);
    if (expected_date !== undefined) set('expected_date', expected_date || null);
    if (received_date !== undefined) set('received_date', received_date || null);
    if (cost !== undefined) {
      const c = parseInt(cost, 10);
      if (!Number.isInteger(c) || c < 0 || c > 10000000) return res.status(400).json({ error: 'cost must be between 0 and 10000000' });
      set('cost', c);
    }
    if (notes !== undefined) set('notes', notes || null);
    if (params.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    // Marking it received without a date is the common case at the desk —
    // stamp today rather than leaving the overdue view unable to tell.
    if (status === 'received' && received_date === undefined) {
      updates.push(`received_date=COALESCE(received_date, ${IST_TODAY_SQL})`);
    }

    params.push(req.params.id);
    const r = await tenantQuery(s,
      `UPDATE lab_works SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Lab work not found' });
    res.json({ lab_work: r.rows[0] });
  } catch (err) { handleError(res, err, 'PATCH /lab-works/:id'); }
});

// ── DELETE (admin) ────────────────────────────────────────────
// Soft outcome: a plan with visits on the calendar is cancelled, not removed,
// so the appointments keep pointing at something. Only a plan nobody ever acted
// on is deleted outright.
router.delete('/treatment-plans/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const usedR = await tenantQuery(s,
      `SELECT COUNT(*)::int AS n FROM appointments WHERE treatment_plan_id=$1`, [req.params.id]);
    if (usedR.rows[0].n > 0) {
      return res.status(409).json({
        error: 'This treatment plan has appointments — set status to cancelled instead of deleting it',
      });
    }
    const r = await tenantQuery(s, `DELETE FROM treatment_plans WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Treatment plan not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_TREATMENT_PLAN', 'treatment_plan', req.params.id, null, null, req.ip);
    res.json({ success: true });
  } catch (err) { handleError(res, err, 'DELETE /treatment-plans/:id'); }
});

module.exports = router;
