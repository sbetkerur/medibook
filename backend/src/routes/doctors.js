'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { query, tenantQuery, tenantTransaction } = require('../db');
const { validate, schemas } = require('../middleware/validate');
const { validateUUID, handleError, UUID_RE } = require('../utils/errors');
const { adminOnly, writeAuditLog } = require('./adminHelpers');
const logger = require('../utils/logger');
const { IST_TODAY_SQL } = require('../utils/dateTz');
const { normalizeDepartmentIds, syncDoctorDepartments, MAX_DEPARTMENTS_PER_DOCTOR } = require('../utils/doctorDepartments');

// Auth + tenant middleware applied once in index.js for /api/admin and /api/v1/admin

const slotsGenerateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Too many slot generation requests. Try again in an hour.' },
  standardHeaders: true,
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Deletes still-upcoming (IST) time_slots for a doctor that aren't referenced by
// an appointment — a cancelled appointment keeps its slot_id, so deleting a
// referenced slot would violate the appointments FK.
//
// "Upcoming" is the two-clause IST test, not a date-only one: the generator now
// creates TODAY's remaining slots too, so a date-only '> today' would leave the
// old schedule's afternoon grid in place while the regenerated one is added
// alongside it — two overlapping sets of bookable times for the same dentist.
// Slots whose start time has already passed are left alone; they are history.
// (The UTC date is a day behind IST until 05:30, hence timezone(...) rather
// than CURRENT_DATE.)
//
// `statuses` controls which slot statuses are eligible for deletion — schedule
// updates only touch 'available' slots, while a manual "clear" regen also
// releases slots an admin had manually 'blocked'.
//
// `throughDays` bounds the DELETE to the window the caller is about to
// REGENERATE. Without it this deleted every future slot out to the full 60-day
// CRON_LOOKAHEAD_DAYS horizon while POST /slots/generate re-created only
// `days` (default 7) — so one "clear and regenerate" wiped ~53 days of
// availability and restored a week, leaving the bot's 14-day date picker
// half-empty until the 23:30 IST cron refilled it. Null means "no upper bound",
// which is correct for the schedule-update path: it regenerates the whole cron
// window, so clearing the whole cron window is the matching span.
async function deleteFutureUnreferencedSlots(schema, doctorId, statuses = ['available'], throughDays = null) {
  const upperBound = throughDays === null
    ? ''
    : `AND slot_date <= (timezone('Asia/Kolkata', NOW()))::date + ($3::int * INTERVAL '1 day')`;
  const params = [doctorId, statuses];
  if (throughDays !== null) params.push(throughDays);
  return tenantQuery(schema,
    `DELETE FROM time_slots WHERE doctor_id=$1 AND status = ANY($2::text[])
       AND (slot_date > (timezone('Asia/Kolkata', NOW()))::date
            OR (slot_date = (timezone('Asia/Kolkata', NOW()))::date
                AND start_time > (timezone('Asia/Kolkata', NOW()))::time))
       ${upperBound}
       AND id NOT IN (SELECT slot_id FROM appointments WHERE slot_id IS NOT NULL)`,
    params);
}

// ── DOCTORS ───────────────────────────────────────────────────
router.get('/doctors', async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    const safeLimit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 200);
    const safePage  = Math.max(parseInt(req.query.page)  || 1, 1);
    const offset    = (safePage - 1) * safeLimit;
    const schema    = req.tenant.schema_name;
    const whereClause = includeInactive ? '' : 'WHERE d.is_active=true';

    const [r, countR] = await Promise.all([
      tenantQuery(schema, `
        SELECT d.*, dep.name as department_name, h.name as hospital_name,
               COALESCE(dept_agg.departments, '[]'::json) as departments,
               -- EVERY branch this dentist sits at, not just their primary.
               -- A visiting consultant is based at one branch and holds clinics
               -- at others, and their slots carry the SESSION's branch, so any
               -- caller filtering dentists by hospital_id alone (the walk-in
               -- modal did) hides them from the very branch the patient is
               -- standing in. Primary is included so a doctor with no sessions
               -- yet still resolves.
               COALESCE(hosp_agg.hospital_ids, '[]'::json) as hospital_ids,
               COALESCE(appt_agg.total, 0)::int as total_appointments,
               COALESCE(slot_agg.available, 0)::int as available_slots
        FROM doctors d
        LEFT JOIN (
          SELECT doctor_id, json_agg(DISTINCT hospital_id) AS hospital_ids
            FROM (
              SELECT id AS doctor_id, hospital_id FROM doctors WHERE hospital_id IS NOT NULL
              UNION
              SELECT doctor_id, hospital_id FROM doctor_schedules WHERE hospital_id IS NOT NULL
              UNION
              SELECT doctor_id, hospital_id FROM doctor_hospitals WHERE hospital_id IS NOT NULL
            ) all_h
           GROUP BY doctor_id
        ) hosp_agg ON hosp_agg.doctor_id=d.id
        LEFT JOIN departments dep ON dep.id=d.department_id
        LEFT JOIN hospitals h ON h.id=d.hospital_id
        LEFT JOIN (
          SELECT dd.doctor_id,
                 json_agg(json_build_object('id', dp.id, 'name', dp.name) ORDER BY dp.name) as departments
          FROM doctor_departments dd JOIN departments dp ON dp.id=dd.department_id
          GROUP BY dd.doctor_id
        ) dept_agg ON dept_agg.doctor_id=d.id
        LEFT JOIN (
          SELECT doctor_id, COUNT(*) as total
          FROM appointments WHERE status='confirmed' GROUP BY doctor_id
        ) appt_agg ON appt_agg.doctor_id=d.id
        LEFT JOIN (
          SELECT doctor_id, COUNT(*) as available
          FROM time_slots WHERE slot_date>=${IST_TODAY_SQL} AND status='available' GROUP BY doctor_id
        ) slot_agg ON slot_agg.doctor_id=d.id
        ${whereClause}
        ORDER BY d.is_active DESC, d.name
        LIMIT $1 OFFSET $2
      `, [safeLimit, offset]),
      tenantQuery(schema, `SELECT COUNT(*) FROM doctors d ${whereClause}`),
    ]);

    const total = parseInt(countR.rows[0]?.count || 0);
    res.json({ doctors: r.rows, total, page: safePage, limit: safeLimit, has_more: offset + r.rows.length < total });
  } catch (err) { handleError(res, err, 'GET /doctors'); }
});

router.post('/doctors', adminOnly, validate(schemas.createDoctor), async (req, res) => {
  try {
    const { name, specialization, qualification, department_id, department_ids, hospital_id, consultation_fee, slot_duration_minutes } = req.body;
    const s = req.tenant.schema_name;

    // Pre-validate FK references before entering the transaction
    const hospCheck = await tenantQuery(s, `SELECT id FROM hospitals WHERE id=$1 AND is_active=true AND deleted_at IS NULL`, [hospital_id]);
    if (!hospCheck.rows[0]) return res.status(400).json({ error: 'Hospital not found' });

    const { ids: deptIds, invalid, tooMany } = normalizeDepartmentIds(department_id, department_ids);
    if (invalid.length) return res.status(400).json({ error: 'Invalid department_id format' });
    if (tooMany) return res.status(400).json({ error: `A doctor can belong to at most ${MAX_DEPARTMENTS_PER_DOCTOR} departments` });
    if (deptIds.length) {
      const deptCheck = await tenantQuery(s,
        `SELECT id FROM departments WHERE id = ANY($1::uuid[]) AND hospital_id=$2`, [deptIds, hospital_id]);
      if (deptCheck.rows.length !== deptIds.length) {
        return res.status(400).json({ error: 'Department not found or does not belong to this hospital' });
      }
    }
    // normalizeDepartmentIds puts the primary first, so this also covers the case
    // where only department_ids was sent: the first one becomes the primary that
    // receipts and analytics read.
    const primaryDeptId = deptIds[0] || null;

    const planR = await query(`SELECT max_doctors FROM plans WHERE id=$1`, [req.tenant.plan]);
    const planLimit = planR.rows[0]?.max_doctors ?? null;

    // Atomic quota check + insert: advisory lock serialises concurrent doctor creation per tenant
    // pg_advisory_xact_lock is released automatically at transaction end
    const crypto = require('crypto');
    const lockId = crypto.createHash('sha256').update(`doctor_quota:${s}`).digest().readInt32BE(0);

    const r = await tenantTransaction(s, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [lockId]);

      if (planLimit !== null) {
        const countR = await client.query(`SELECT COUNT(*) FROM doctors WHERE is_active=true`);
        const current = parseInt(countR.rows[0].count);
        if (current >= planLimit) {
          const err = new Error(`QUOTA:${current}/${planLimit}`);
          err.isQuota = true;
          throw err;
        }
      }

      const inserted = await client.query(`
        INSERT INTO doctors (name, specialization, qualification, department_id, hospital_id, consultation_fee, slot_duration_minutes)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
      `, [name, specialization, qualification, primaryDeptId, hospital_id, consultation_fee || 0, slot_duration_minutes || 30]);
      await syncDoctorDepartments(client, inserted.rows[0].id, deptIds);
      return inserted;
    });

    // Audited: adding a dentist consumes the plan's doctor quota and changes who
    // patients can be booked with. GET /audit-logs is the clinic's only
    // attribution record, and PATCH/DELETE on this same resource already write
    // to it — a create that does not is the gap an owner hits when the seat
    // count does not match the staff they remember hiring.
    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role,
      'CREATE_DOCTOR', 'doctor', r.rows[0].id, null,
      { name: r.rows[0].name, hospital_id: r.rows[0].hospital_id, department_ids: deptIds }, req.ip);
    res.json({ doctor: { ...r.rows[0], department_ids: deptIds } });
  } catch (err) {
    if (err.isQuota) {
      const [cur, max] = err.message.replace('QUOTA:', '').split('/');
      return res.status(403).json({
        error: `Doctor limit reached for your plan (${cur}/${max}). Upgrade to add more doctors.`,
        quota_exceeded: true,
      });
    }
    handleError(res, err, 'POST /doctors');
  }
});

router.get('/doctors/:id', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name, `
      SELECT d.*, dep.name as department_name, h.name as hospital_name,
             COALESCE(dept_agg.departments, '[]'::json) as departments,
             COALESCE(appt_agg.total, 0)::int as total_appointments,
             COALESCE(slot_agg.available, 0)::int as available_slots
      FROM doctors d
      LEFT JOIN departments dep ON dep.id=d.department_id
      LEFT JOIN hospitals h ON h.id=d.hospital_id
      LEFT JOIN (
        SELECT dd.doctor_id,
               json_agg(json_build_object('id', dp.id, 'name', dp.name) ORDER BY dp.name) as departments
        FROM doctor_departments dd JOIN departments dp ON dp.id=dd.department_id
        GROUP BY dd.doctor_id
      ) dept_agg ON dept_agg.doctor_id=d.id
      LEFT JOIN (SELECT doctor_id, COUNT(*) as total FROM appointments WHERE status='confirmed' GROUP BY doctor_id) appt_agg ON appt_agg.doctor_id=d.id
      LEFT JOIN (SELECT doctor_id, COUNT(*) as available FROM time_slots WHERE slot_date>=${IST_TODAY_SQL} AND status='available' GROUP BY doctor_id) slot_agg ON slot_agg.doctor_id=d.id
      WHERE d.id=$1
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Doctor not found' });
    res.json({ doctor: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.patch('/doctors/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { name, specialization, qualification, consultation_fee, slot_duration_minutes, is_active, department_id, department_ids, hospital_id, pricing_rules, is_visiting, online_bookable } = req.body;
    const s = req.tenant.schema_name;
    // Validate UUID fields early — PostgreSQL's ::uuid cast would otherwise return 500
    if (hospital_id && !UUID_RE.test(hospital_id)) {
      return res.status(400).json({ error: 'Invalid hospital_id format' });
    }
    if (department_ids !== undefined && department_ids !== null && !Array.isArray(department_ids)) {
      return res.status(400).json({ error: 'department_ids must be an array' });
    }
    const oldR = await tenantQuery(s, `SELECT name, is_active, hospital_id, department_id FROM doctors WHERE id=$1`, [req.params.id]);
    if (!oldR.rows[0]) return res.status(404).json({ error: 'Doctor not found' });

    // Same check POST /doctors does — without it a bogus/deactivated hospital_id
    // silently orphans the doctor from every hospital join and derails
    // effectiveHospitalId below (used for the department-membership check).
    if (hospital_id) {
      const hospCheck = await tenantQuery(s, `SELECT id FROM hospitals WHERE id=$1 AND is_active=true AND deleted_at IS NULL`, [hospital_id]);
      if (!hospCheck.rows[0]) return res.status(400).json({ error: 'Hospital not found' });
    }

    // Deactivating through this route must clear the same bar DELETE /doctors/:id
    // does. It didn't: is_active went straight through COALESCE below, so an
    // admin who flipped the toggle on the edit form instead of using Deactivate
    // stranded every patient already booked with that dentist — the bot's
    // department and dentist lists all filter is_active=true, so those patients
    // could no longer see or reschedule their own appointment, and the guard
    // written to prevent exactly that never ran.
    // Normalised to a real boolean (or null) BEFORE the guard, exactly as
    // is_visiting and online_bookable are below. This route has no Joi schema,
    // so `{"is_active":"false"}` used to skip the strict `=== false` test here
    // and still reach `is_active=COALESCE($6,is_active)`, where Postgres
    // happily coerced the string — deactivating a dentist who had upcoming
    // appointments, which is the one thing this guard exists to prevent. A
    // non-boolean, non-null value is now rejected rather than coerced, so
    // `{"is_active":"maybe"}` is a 400 instead of a 500 from the driver.
    if (is_active !== undefined && is_active !== null && typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be true or false' });
    }
    const isActive = typeof is_active === 'boolean' ? is_active : null;

    if (isActive === false && oldR.rows[0].is_active === true) {
      const upcoming = await tenantQuery(s,
        `SELECT COUNT(*)::int AS n FROM appointments
         WHERE doctor_id=$1 AND status='confirmed' AND appointment_date >= ${IST_TODAY_SQL}`,
        [req.params.id]);
      const cnt = upcoming.rows[0].n;
      if (cnt > 0) {
        return res.status(409).json({
          error: `Cannot deactivate doctor — ${cnt} upcoming appointment(s) exist.`,
          upcoming_appointments: cnt,
        });
      }
    }

    // Two shapes, deliberately different:
    //   department_ids present → REPLACE the bookable set outright.
    //   department_id alone    → change the primary and ADD it to the set, leaving
    //                            the doctor's other treatments in place (otherwise
    //                            an unrelated PATCH from an older client would
    //                            silently strip them).
    const replacingSet = Array.isArray(department_ids);
    const { ids: deptIds, invalid, tooMany } = normalizeDepartmentIds(department_id, department_ids);
    if (invalid.length) return res.status(400).json({ error: 'Invalid department_id format' });
    if (tooMany) return res.status(400).json({ error: `A doctor can belong to at most ${MAX_DEPARTMENTS_PER_DOCTOR} departments` });

    const effectiveHospitalId = hospital_id || oldR.rows[0].hospital_id;
    if (deptIds.length) {
      const deptCheck = await tenantQuery(s,
        `SELECT id FROM departments WHERE id = ANY($1::uuid[]) AND hospital_id=$2`, [deptIds, effectiveHospitalId]);
      if (deptCheck.rows.length !== deptIds.length) {
        return res.status(400).json({ error: 'Department not found or does not belong to this hospital' });
      }
    }
    // Clearing the set clears the primary too, or doctors.department_id would
    // point at a department the doctor is no longer bookable for.
    const primaryDeptId = deptIds[0] || (replacingSet ? null : department_id || null);
    const clearingPrimary = replacingSet && !deptIds.length;

    const pricingRulesVal = pricing_rules && typeof pricing_rules === 'object' ? JSON.stringify(pricing_rules) : null;
    // One transaction: the primary department and the bookable set must not be
    // able to disagree, which is what syncDoctorDepartments' invariant rests on.
    const r = await tenantTransaction(s, async (client) => {
      const updated = await client.query(`
        UPDATE doctors SET
          name=COALESCE($1,name), specialization=COALESCE($2,specialization),
          qualification=COALESCE($3,qualification), consultation_fee=COALESCE($4,consultation_fee),
          slot_duration_minutes=COALESCE($5,slot_duration_minutes), is_active=COALESCE($6,is_active),
          department_id=CASE WHEN $11::boolean THEN NULL ELSE COALESCE($7::uuid,department_id) END,
          hospital_id=COALESCE($8::uuid,hospital_id),
          pricing_rules=COALESCE($10::jsonb,pricing_rules),
          is_visiting=COALESCE($12::boolean,is_visiting),
          -- Whether PATIENTS may pick this dentist in the bot. Distinct from
          -- is_active: a visiting orthodontist is very much active, they just
          -- take referred cases rather than walk-in toothache off a menu.
          -- The desk can still book anyone, either way.
          online_bookable=COALESCE($13::boolean,online_bookable)
        WHERE id=$9 RETURNING *
      `, [name, specialization, qualification, consultation_fee, slot_duration_minutes, isActive,
          primaryDeptId, hospital_id || null, req.params.id, pricingRulesVal, clearingPrimary,
          typeof is_visiting === 'boolean' ? is_visiting : null,
          typeof online_bookable === 'boolean' ? online_bookable : null]);

      if (replacingSet) {
        await syncDoctorDepartments(client, req.params.id, deptIds);
      } else if (primaryDeptId) {
        await client.query(
          `INSERT INTO doctor_departments (doctor_id, department_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [req.params.id, primaryDeptId]);
      }
      return updated;
    });
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_DOCTOR', 'doctor', req.params.id,
      oldR.rows[0], { name, is_active: isActive, department_ids: replacingSet ? deptIds : undefined }, req.ip);
    res.json({ doctor: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.delete('/doctors/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      UPDATE doctors SET is_active=false
      WHERE id=$1 AND is_active=true
        AND NOT EXISTS (
          SELECT 1 FROM appointments WHERE doctor_id=$1 AND status='confirmed' AND appointment_date >= ${IST_TODAY_SQL}
        )
      RETURNING id
    `, [req.params.id]);
    if (!r.rows[0]) {
      const exists = await tenantQuery(s,
        `SELECT id, (SELECT COUNT(*) FROM appointments WHERE doctor_id=$1 AND status='confirmed' AND appointment_date >= ${IST_TODAY_SQL}) as upcoming FROM doctors WHERE id=$1`,
        [req.params.id]);
      if (!exists.rows[0]) return res.status(404).json({ error: 'Doctor not found' });
      const cnt = parseInt(exists.rows[0].upcoming);
      return res.status(409).json({ error: `Cannot deactivate doctor — ${cnt} upcoming appointment(s) exist.`, upcoming_appointments: cnt });
    }
    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_DOCTOR', 'doctor', req.params.id, null, null, req.ip);
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── DOCTOR SCHEDULE ───────────────────────────────────────────
router.get('/doctors/:id/schedule', validateUUID(), async (req, res) => {
  try {
    // A schedule row IS a session: doctor + weekday + hours + branch. Ordered
    // by start_time within the day so two sessions come back morning-first.
    //
    // doctor_schedules.hospital_id is authoritative and is what slot generation
    // reads; doctor_hospitals is consulted only to fill a legacy NULL. The
    // `AND s.hospital_id IS NULL` on the join is load-bearing — without it a
    // dentist with two branches on one weekday matched both dh rows and the
    // query returned 2 sessions × 2 branches = 4 rows. The dashboard then
    // rendered phantom sessions, and any client round-tripping this payload
    // back into POST /doctors/:id/schedule tripped the overlap check and was
    // told the dentist "cannot be in two places at once" — making a schedule
    // that already existed impossible to save.
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT s.*, COALESCE(s.hospital_id, dh.hospital_id) AS hospital_id
       FROM doctor_schedules s
       LEFT JOIN doctor_hospitals dh
         ON dh.doctor_id = s.doctor_id AND dh.day_of_week = s.day_of_week
        AND s.hospital_id IS NULL
        -- Same scoping as the backfill in tenantMigrate.js and the two slot
        -- generation queries. A deliberate NULL sitting BESIDE a session that
        -- names a branch means "the primary branch", not "that branch": on a
        -- Tuesday split 10-13 at B / 17-21 at primary there is exactly one dh
        -- row, and handing it to the evening session made the dashboard show
        -- both sessions at B. That is the reading a client then POSTs back,
        -- which writes the wrong branch into doctor_schedules for good.
        AND NOT EXISTS (
          SELECT 1 FROM doctor_schedules s2
           WHERE s2.doctor_id = s.doctor_id AND s2.day_of_week = s.day_of_week
             AND s2.hospital_id IS NOT NULL
        )
        AND (SELECT COUNT(*) FROM doctor_hospitals dh2
              WHERE dh2.doctor_id = s.doctor_id AND dh2.day_of_week = s.day_of_week) = 1
       WHERE s.doctor_id=$1 ORDER BY s.day_of_week, s.start_time`, [req.params.id]);
    res.json({ schedule: r.rows });
  } catch (err) { handleError(res, err); }
});

router.post('/doctors/:id/schedule', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { schedules } = req.body;
    if (!Array.isArray(schedules)) return res.status(400).json({ error: 'schedules array required' });
    for (const s of schedules) {
      const dow = parseInt(s.day_of_week);
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
        return res.status(400).json({ error: `day_of_week must be 0 (Sunday) through 6 (Saturday), got: ${s.day_of_week}` });
      }
      if (s.is_working !== false) {
        if (!TIME_RE.test(s.start_time) || !TIME_RE.test(s.end_time)) {
          return res.status(400).json({ error: `Day ${dow}: times must be HH:MM (24h format)` });
        }
        if (s.start_time >= s.end_time) {
          return res.status(400).json({ error: `Day ${dow}: start_time must be before end_time` });
        }
        if (s.lunch_start_time || s.lunch_end_time) {
          // Both must be provided together — a partial lunch window breaks slot generation
          if (!s.lunch_start_time || !s.lunch_end_time) {
            return res.status(400).json({ error: `Day ${dow}: lunch_start_time and lunch_end_time must both be provided` });
          }
          if (!TIME_RE.test(s.lunch_start_time)) {
            return res.status(400).json({ error: `Day ${dow}: lunch_start_time must be HH:MM` });
          }
          if (!TIME_RE.test(s.lunch_end_time)) {
            return res.status(400).json({ error: `Day ${dow}: lunch_end_time must be HH:MM` });
          }
          if (s.lunch_start_time >= s.lunch_end_time) {
            return res.status(400).json({ error: `Day ${dow}: lunch_start_time must be before lunch_end_time` });
          }
          if (s.lunch_start_time <= s.start_time || s.lunch_end_time >= s.end_time) {
            return res.status(400).json({ error: `Day ${dow}: lunch window must fall within working hours` });
          }
        }
        // Visiting consultants: which weeks of the month they attend. Empty or
        // absent means every week — the meaning of every row that predates this.
        if (s.week_of_month !== undefined && s.week_of_month !== null) {
          if (!Array.isArray(s.week_of_month)) {
            return res.status(400).json({ error: `Day ${dow}: week_of_month must be an array` });
          }
          if (!s.week_of_month.every(w => Number.isInteger(w) && w >= 1 && w <= 5)) {
            return res.status(400).json({ error: `Day ${dow}: week_of_month values must be 1-5 (1 = first occurrence of that weekday in the month)` });
          }
        }
        if (s.hospital_id && !UUID_RE.test(s.hospital_id)) {
          return res.status(400).json({ error: `Day ${dow}: invalid hospital_id format` });
        }
      }
    }

    // A day may now carry SEVERAL sessions — 10–1 at one branch, 5–9 at
    // another — but they must not overlap, whatever branch each names: a
    // dentist cannot be in two places at once. Without this check the overlap
    // is not rejected, it is silently swallowed by the
    // (doctor_id, slot_date, start_time) unique index on time_slots, and the
    // second branch simply has no availability with no error anywhere.
    const byDay = new Map();
    for (const x of schedules) {
      if (x.is_working === false) continue;
      const dow = parseInt(x.day_of_week);
      if (!byDay.has(dow)) byDay.set(dow, []);
      byDay.get(dow).push(x);
    }
    for (const [dow, list] of byDay) {
      const sorted = [...list].sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
      for (let i = 1; i < sorted.length; i++) {
        if (String(sorted[i].start_time) < String(sorted[i - 1].end_time)) {
          return res.status(400).json({
            error: `Day ${dow}: sessions overlap (${sorted[i - 1].start_time}-${sorted[i - 1].end_time} and ${sorted[i].start_time}-${sorted[i].end_time}). A dentist cannot be in two places at once.`,
          });
        }
      }
    }
    const s = req.tenant.schema_name;

    // Per-day branches must belong to this tenant and be live, or slots would be
    // generated against a deleted branch and become invisible to every patient.
    const dayHospitalIds = [...new Set(schedules.map(x => x.hospital_id).filter(Boolean))];
    if (dayHospitalIds.length) {
      const hospCheck = await tenantQuery(s,
        `SELECT id FROM hospitals WHERE id = ANY($1::uuid[]) AND is_active=true AND deleted_at IS NULL`,
        [dayHospitalIds]);
      if (hospCheck.rows.length !== dayHospitalIds.length) {
        return res.status(400).json({ error: 'One or more branches were not found' });
      }
    }
    await tenantTransaction(s, async (client) => {
      // Replace whole DAYS rather than upserting rows. A day is now a LIST of
      // sessions, so an upsert keyed on one session can never remove a session
      // the admin deleted — the evening branch would linger after being taken
      // off the form, and keep generating slots nobody expected.
      const submittedDays = [...new Set(schedules.map(x => parseInt(x.day_of_week)))];
      if (submittedDays.length) {
        await client.query(
          `DELETE FROM doctor_schedules WHERE doctor_id=$1 AND day_of_week = ANY($2::int[])`,
          [req.params.id, submittedDays]);
        await client.query(
          `DELETE FROM doctor_hospitals WHERE doctor_id=$1 AND day_of_week = ANY($2::int[])`,
          [req.params.id, submittedDays]);
      }

      for (const sched of schedules) {
        const weeks = Array.isArray(sched.week_of_month) && sched.week_of_month.length
          ? [...new Set(sched.week_of_month)].sort((a, b) => a - b)
          : null; // null = every week

        // A non-working day is recorded once, with no hours and no branch, so
        // the GET still reports "closed" rather than an absent row.
        await client.query(`
          INSERT INTO doctor_schedules
            (doctor_id, day_of_week, start_time, end_time, is_working,
             lunch_start_time, lunch_end_time, week_of_month, hospital_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (doctor_id, day_of_week, start_time) DO UPDATE SET
            end_time=EXCLUDED.end_time,
            is_working=EXCLUDED.is_working,
            lunch_start_time=EXCLUDED.lunch_start_time,
            lunch_end_time=EXCLUDED.lunch_end_time,
            week_of_month=EXCLUDED.week_of_month,
            hospital_id=EXCLUDED.hospital_id
        `, [req.params.id, sched.day_of_week, sched.start_time, sched.end_time,
            sched.is_working !== false, sched.lunch_start_time || null,
            sched.lunch_end_time || null, weeks, sched.hospital_id || null]);

        // doctor_hospitals is mirrored for the /locations API. It is no longer
        // what slot generation reads — doctor_schedules.hospital_id is — so the
        // two can no longer disagree about which branch a session belongs to.
        if (sched.hospital_id && sched.is_working !== false) {
          await client.query(`
            INSERT INTO doctor_hospitals (doctor_id, hospital_id, day_of_week, start_time, end_time)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (doctor_id, hospital_id, day_of_week) DO UPDATE
              SET start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time
          `, [req.params.id, sched.hospital_id, sched.day_of_week, sched.start_time, sched.end_time]);
        }
      }
    });

    // Regenerate future slots to reflect the new schedule: delete this doctor's
    // future available slots, then re-create them from the saved schedule.
    //
    // The DELETE is unbounded (the whole CRON_LOOKAHEAD_DAYS horizon) and used
    // to run unconditionally, with the rebuild that follows it inside the same
    // swallowing catch. A delete that committed followed by a generate that
    // threw wiped the doctor's entire 60-day availability and still answered
    // 200 {success:true}: the admin saw a saved schedule while the bot told
    // every patient "no slots available" for that dentist until the 23:30 IST
    // sweep repaired it, up to a day later.
    //
    // The two cannot share a transaction without threading a client through
    // generateSlotsForDoctor and everything it calls. So the plan is computed
    // FIRST, as a dry run: it exercises the same schedule read and the same
    // day loop that the real generation does, so the realistic failures (bad
    // schedule rows, a query error, a doctor with nothing to generate) surface
    // while the existing grid is still untouched. Only a dry run that both
    // succeeded and produced slots earns the right to delete.
    let slotsGenerated = 0;
    let regenError = null;
    try {
      const { generateSlotsForDoctor } = require('../jobs/slotGenerator');
      const preview = await generateSlotsForDoctor(s, req.params.id, true);
      const wouldGenerate = preview?.would_generate ?? 0;
      if (wouldGenerate > 0) {
        // Skip slots referenced by appointments — a cancelled appointment keeps
        // its slot_id, so deleting the released slot violates the appointments
        // FK and aborts the regeneration.
        await deleteFutureUnreferencedSlots(s, req.params.id);
        slotsGenerated = await generateSlotsForDoctor(s, req.params.id);
        logger.info(`Slots regenerated after schedule update for doctor ${req.params.id}: ${slotsGenerated} slots`);
      } else {
        // Nothing to rebuild — an inactive doctor, or every day set non-working.
        // Clearing the grid is still correct here: the schedule now says the
        // dentist works nowhere, so their remaining slots must not stay bookable.
        await deleteFutureUnreferencedSlots(s, req.params.id);
        logger.info(`Schedule for doctor ${req.params.id} generates no slots — future availability cleared`);
      }
    } catch (regenErr) {
      // The schedule itself is saved (its own transaction, already committed).
      // Whether the grid survived depends on where this threw, so say that
      // plainly — "success: true, slots_regenerated: 0" was indistinguishable
      // from the legitimate "nothing to add" case.
      slotsGenerated = 0;
      regenError = regenErr.message;
      logger.error(`Slot regeneration failed after schedule update for doctor ${req.params.id}`, { error: regenErr.message });
    }

    res.json({
      success: true,
      updated: schedules.length,
      slots_regenerated: slotsGenerated,
      ...(regenError ? {
        slots_regenerated_ok: false,
        warning: 'Schedule saved, but slots could not be regenerated. Retry, or wait for the nightly slot sweep.',
      } : {}),
    });
  } catch (err) { handleError(res, err); }
});

// ── DOCTOR LEAVES ─────────────────────────────────────────────
router.get('/doctors/:id/leaves', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT * FROM doctor_leaves WHERE doctor_id=$1 ORDER BY leave_date`, [req.params.id]);
    res.json({ leaves: r.rows });
  } catch (err) { handleError(res, err); }
});

router.post('/doctors/:id/leaves', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { dates, reason } = req.body;
    if (!Array.isArray(dates) || dates.length === 0) return res.status(400).json({ error: 'dates array required' });
    const s = req.tenant.schema_name;
    // Use IST date to reject past leaves consistently with the bot's timezone.
    // Between 18:30–23:59 UTC, UTC date is one day behind IST — hardcode the
    // +5:30 offset so admins can't accidentally block slots that are already past.
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const todayIST = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
    let added = 0;
    // Malformed and past dates are silently skipped
    const validDates = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= todayIST);
    let skipped = dates.length - validDates.length;
    if (validDates.length) {
      // ONE transaction for the INSERT and the block. As two separate statements
      // a failure in between (connection drop, pool timeout) committed the leave
      // and left its slots 'available' — the dentist is recorded as away while
      // the bot keeps booking them, and nothing ever reconciles the two. That is
      // the same "recorded but not enforced" hole clinic holidays had.
      added = await tenantTransaction(s, async (client) => {
        const ins = await client.query(`
          INSERT INTO doctor_leaves (doctor_id, leave_date, reason, created_by_user_id)
          SELECT $1, d, $2, $3 FROM unnest($4::date[]) AS d
          ON CONFLICT (doctor_id, leave_date) DO NOTHING
          RETURNING id
        `, [req.params.id, reason || null, req.user.id, validDates]);
        // Mark blocked_by_leave so removing the leave later only releases these
        // slots — never slots an admin blocked manually for another reason.
        await client.query(
          `UPDATE time_slots SET status='blocked', blocked_by_leave=true
           WHERE doctor_id=$1 AND slot_date = ANY($2::date[]) AND status='available'`,
          [req.params.id, validDates]);
        // Only count rows actually inserted — ON CONFLICT DO NOTHING returns no
        // row for dates that were already on leave.
        return ins.rows.length;
      });
      skipped += validDates.length - added;
    }

    // Surface already-booked appointments on the leave dates: blocking only
    // affects AVAILABLE slots, so confirmed bookings still stand and patients
    // would show up to an absent doctor unless the clinic reschedules them.
    let affectedAppointments = [];
    if (validDates.length) {
      try {
        const apptR = await tenantQuery(s, `
          SELECT a.booking_id, a.appointment_date::text, a.appointment_time::text,
                 p.name as patient_name, p.phone as patient_phone
          FROM appointments a
          JOIN patients p ON p.id = a.patient_id
          WHERE a.doctor_id=$1 AND a.status='confirmed' AND a.appointment_date = ANY($2::date[])
          ORDER BY a.appointment_date, a.appointment_time
        `, [req.params.id, validDates]);
        affectedAppointments = apptR.rows;
      } catch (apptErr) {
        logger.warn('Leave: affected-appointment lookup failed', { error: apptErr.message });
      }
    }

    await writeAuditLog(s, req.user.id, req.user.role, 'ADD_DOCTOR_LEAVE', 'doctor', req.params.id,
      null, { dates, reason, affected_appointments: affectedAppointments.length }, req.ip);
    res.json({
      success: true,
      added,
      skipped,
      affected_appointments: affectedAppointments.length,
      affected_appointment_details: affectedAppointments,
      ...(affectedAppointments.length > 0 && {
        warning: `${affectedAppointments.length} confirmed appointment(s) already exist on the leave date(s). Reschedule or cancel them — patients have NOT been notified automatically.`,
      }),
    });
  } catch (err) { handleError(res, err); }
});

router.delete('/doctors/:id/leaves/:date', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    // DELETE + release in one transaction — the mirror of the create path above.
    const released = await tenantTransaction(s, async (client) => {
      const del = await client.query(
        `DELETE FROM doctor_leaves WHERE doctor_id=$1 AND leave_date=$2 RETURNING id`,
        [req.params.id, req.params.date]);
      if (!del.rows[0]) return null;
      // Only release slots that THIS leave blocked (blocked_by_leave) — a blanket
      // unblock previously also re-opened slots an admin had blocked manually.
      // The clinic_holidays check is the same guard the holiday delete carries in
      // the other direction: a holiday declared AFTER the leave could not block
      // the already-'blocked' slots, so without it ending a leave re-opens a day
      // the whole clinic is shut.
      const rel = await client.query(
        `UPDATE time_slots SET status='available', blocked_by_leave=false
         WHERE doctor_id=$1 AND slot_date=$2 AND status='blocked' AND blocked_by_leave=true
           AND blocked_by_holiday IS NOT TRUE
           AND NOT EXISTS (
             SELECT 1 FROM clinic_holidays ch
             WHERE ch.holiday_date = time_slots.slot_date
               AND (ch.hospital_id IS NULL OR ch.hospital_id = time_slots.hospital_id)
           )
         RETURNING id`,
        [req.params.id, req.params.date]);
      return rel.rows.length;
    });
    if (released === null) return res.status(404).json({ error: 'Leave record not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'REMOVE_DOCTOR_LEAVE', 'doctor', req.params.id,
      null, { date: req.params.date, slots_released: released }, req.ip);
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── SLOTS ─────────────────────────────────────────────────────
router.get('/slots', async (req, res) => {
  try {
    const { doctor_id, date } = req.query;
    if (!doctor_id || !date) return res.status(400).json({ error: 'doctor_id and date required' });
    if (!UUID_RE.test(doctor_id)) return res.status(400).json({ error: 'Invalid doctor_id' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
    const r = await tenantQuery(req.tenant.schema_name, `
      SELECT ts.*,
             CASE WHEN a.id IS NOT NULL THEN a.booking_id END as booking_id,
             CASE WHEN a.id IS NOT NULL THEN p.name END as patient_name
      FROM time_slots ts
      LEFT JOIN appointments a ON a.slot_id = ts.id AND a.status != 'cancelled'
      LEFT JOIN patients p ON p.id = a.patient_id
      WHERE ts.doctor_id=$1 AND ts.slot_date=$2
      ORDER BY ts.start_time
    `, [doctor_id, date]);
    res.json({ slots: r.rows });
  } catch (err) { handleError(res, err); }
});

// adminOnly: blocking/unblocking a slot is a schedule mutation, exactly like
// POST /slots/block-range below — which does the same thing in one call and has
// always been admin-gated. Without it a 'staff' login could enumerate ids via
// GET /slots?doctor_id=…&date=… and loop PATCH {"action":"block"} to take a
// dentist's entire bookable calendar offline one slot at a time.
router.patch('/slots/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { status, action } = req.body;
    const s = req.tenant.schema_name;
    let newStatus;
    if (action) {
      if (!['block', 'unblock'].includes(action)) return res.status(400).json({ error: "action must be 'block' or 'unblock'" });
      newStatus = action === 'block' ? 'blocked' : 'available';
    } else if (status) {
      if (!['available', 'blocked'].includes(status)) return res.status(400).json({ error: "status must be 'available' or 'blocked'" });
      newStatus = status;
    } else {
      return res.status(400).json({ error: "Provide 'action' (block/unblock) or 'status' (available/blocked)" });
    }
    const existing = await tenantQuery(s, `SELECT * FROM time_slots WHERE id=$1`, [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Slot not found' });
    if (existing.rows[0].status === 'booked' && newStatus === 'blocked') {
      return res.status(409).json({ error: 'Cannot block a booked slot' });
    }
    // Clear blocked_by_leave / blocked_by_holiday on any manual block/unblock:
    // the flags mark slots blocked BY A LEAVE or BY A HOLIDAY so that removing
    // that leave/holiday releases only those. Once an admin manually changes a
    // slot's status, the slot is under manual control — a stale flag would let a
    // later leave/holiday removal re-open a manually blocked slot.
    const r = await tenantQuery(s,
      `UPDATE time_slots SET status=$1, blocked_by_leave=false, blocked_by_holiday=false
       WHERE id=$2 AND status != 'booked' RETURNING *`,
      [newStatus, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Slot not found or is already booked' });
    await writeAuditLog(s, req.user.id, req.user.role, `slot_${newStatus === 'blocked' ? 'block' : 'unblock'}`, 'time_slot', req.params.id, null, null, req.ip);
    res.json({ slot: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.post('/slots/generate', adminOnly, slotsGenerateLimiter, async (req, res) => {
  try {
    const { doctor_id, days = 7, clear = false } = req.body;
    if (!doctor_id) return res.status(400).json({ error: 'doctor_id required' });
    if (!UUID_RE.test(doctor_id)) {
      return res.status(400).json({ error: 'Invalid doctor_id format' });
    }
    const s = req.tenant.schema_name;
    const safeDays = Math.min(Math.max(parseInt(days) || 7, 1), 365);
    if (clear) {
      // Upcoming-only in IST (past slots are history and are never regenerated),
      // and never rows still referenced by an appointment (FK violation —
      // cancelled appointments keep their slot_id). Also releases manually
      // 'blocked' slots — unlike the schedule-update regen above, a manual
      // "clear" is meant to reset everything. Bounded to safeDays: this route
      // regenerates only that far, so clearing further would delete days it is
      // not going to rebuild.
      await deleteFutureUnreferencedSlots(s, doctor_id, ['available', 'blocked'], safeDays);
    }
    const docR = await tenantQuery(s, `SELECT id FROM doctors WHERE id=$1`, [doctor_id]);
    if (!docR.rows[0]) return res.status(404).json({ error: 'Doctor not found' });
    const schedR = await tenantQuery(s, `SELECT id FROM doctor_schedules WHERE doctor_id=$1 AND is_working=true`, [doctor_id]);
    if (!schedR.rows.length) return res.status(400).json({ error: 'No schedule configured for this doctor' });
    // Delegate to the shared generator so this route applies the same exclusions
    // as the nightly cron (doctor leaves, clinic holidays, public holidays, IST
    // base date). The previous inline loop skipped none of them, so manually
    // generated slots reappeared on declared holidays and leave days.
    const { generateSlotsForDoctor } = require('../jobs/slotGenerator');
    const generated = await generateSlotsForDoctor(s, doctor_id, false, safeDays);
    res.json({ success: true, generated, days: safeDays });
  } catch (err) { handleError(res, err); }
});

router.post('/slots/block-range', adminOnly, validate(schemas.blockRange), async (req, res) => {
  try {
    const { doctor_id, start_date, end_date, reason } = req.body;
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      UPDATE time_slots SET status='blocked'
      WHERE doctor_id=$1 AND slot_date BETWEEN $2 AND $3 AND status='available'
      RETURNING id
    `, [doctor_id, start_date, end_date]);
    await writeAuditLog(s, req.user.id, req.user.role, 'BLOCK_SLOTS_RANGE', 'time_slot', null,
      null, { doctor_id, start_date, end_date, reason, count: r.rows.length }, req.ip);
    res.json({ blocked: r.rows.length });
  } catch (err) { handleError(res, err); }
});

// ── BULK IMPORT DOCTORS via CSV ───────────────────────────────
const { parse: parseCsv } = require('csv-parse/sync');

router.post('/doctors/import', adminOnly, async (req, res) => {
  try {
    const { csv_data } = req.body;
    if (!csv_data) return res.status(400).json({ error: 'csv_data is required' });
    // Type-checked before .includes() below, which throws a TypeError on any
    // non-string and surfaces as a bare 500 — a mis-wired client sending an
    // array or a number deserves to be told what the field wants.
    if (typeof csv_data !== 'string') {
      return res.status(400).json({ error: 'csv_data must be a raw CSV or base64 string' });
    }

    let rawCsv = csv_data;
    if (!csv_data.includes('\n') && !csv_data.includes(',')) {
      try { rawCsv = Buffer.from(csv_data, 'base64').toString('utf8'); } catch (_) {}
    }

    const records = parseCsv(rawCsv, { columns: true, skip_empty_lines: true, trim: true });
    if (!records.length) return res.status(400).json({ error: 'No records found in CSV' });
    if (records.length > 100) return res.status(400).json({ error: 'Maximum 100 doctors per import' });

    const s = req.tenant.schema_name;
    let imported = 0;
    let skipped = 0;
    const errors = [];

    // Enforce the plan's doctor quota — same limit POST /doctors applies.
    // Without this check, CSV import silently bypassed max_doctors.
    const planR = await query(`SELECT max_doctors FROM plans WHERE id=$1`, [req.tenant.plan]);
    const planLimit = planR.rows[0]?.max_doctors ?? null;
    let activeCount = 0;
    if (planLimit !== null) {
      const countR = await tenantQuery(s, `SELECT COUNT(*) FROM doctors WHERE is_active=true`);
      activeCount = parseInt(countR.rows[0].count);
    }

    // Fetch all hospitals, departments, and existing doctors for matching
    const [hospitalsR, deptsR, existingR] = await Promise.all([
      tenantQuery(s, `SELECT id, name FROM hospitals WHERE is_active=true`),
      tenantQuery(s, `SELECT id, name, hospital_id FROM departments WHERE is_active=true`),
      tenantQuery(s, `SELECT lower(name) as name, hospital_id FROM doctors`),
    ]);
    const existingDoctorKeys = new Set(existingR.rows.map(d => `${d.name}::${d.hospital_id}`));

    for (const row of records) {
      try {
        const name = (row.name || row.Name || row.NAME || '').toString().trim();
        if (!name) { skipped++; errors.push(`Row: missing name`); continue; }

        const spec = (row.specialization || row.Specialization || '').toString().trim() || null;
        const qual = (row.qualification || row.Qualification || '').toString().trim() || null;
        const fee = parseInt(row.consultation_fee || row.fee || '0') || 0;
        const duration = parseInt(row.slot_duration_minutes || row.duration || '30') || 30;
        const hospitalName = (row.hospital || row.Hospital || '').toString().trim();
        const deptName = (row.department || row.Department || row.specialty || '').toString().trim();

        // Match hospital
        let hospitalId = null;
        if (hospitalName) {
          const h = hospitalsR.rows.find(h => h.name.toLowerCase() === hospitalName.toLowerCase());
          hospitalId = h?.id || null;
        }
        if (!hospitalId && hospitalsR.rows.length === 1) hospitalId = hospitalsR.rows[0].id;
        if (!hospitalId) {
          skipped++;
          errors.push(`Row "${name}": hospital "${hospitalName}" not found`);
          continue;
        }

        // Match department
        let deptId = null;
        if (deptName) {
          const d = deptsR.rows.find(d => d.name.toLowerCase() === deptName.toLowerCase() && d.hospital_id === hospitalId);
          deptId = d?.id || null;
        }

        // Skip duplicates — doctors has no unique constraint on name, so the old
        // ON CONFLICT DO NOTHING was a no-op and re-imports duplicated every row.
        const dupKey = `${name.toLowerCase()}::${hospitalId}`;
        if (existingDoctorKeys.has(dupKey)) {
          skipped++;
          errors.push(`Row "${name}": doctor already exists at this hospital — skipped`);
          continue;
        }

        // Plan quota check (mirrors POST /doctors)
        if (planLimit !== null && activeCount >= planLimit) {
          skipped++;
          errors.push(`Row "${name}": doctor limit reached for your plan (${activeCount}/${planLimit})`);
          continue;
        }

        // The bookable-department row goes in with the doctor: the bot lists
        // dentists through doctor_departments, so an imported doctor without one
        // is invisible on WhatsApp until the next boot's backfill runs.
        // A CSV names one department per row; extras are ticked in the UI after.
        await tenantQuery(s, `
          WITH new_doctor AS (
            INSERT INTO doctors (name, specialization, qualification, hospital_id, department_id, consultation_fee, slot_duration_minutes)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            RETURNING id, department_id
          )
          INSERT INTO doctor_departments (doctor_id, department_id)
          SELECT id, department_id FROM new_doctor WHERE department_id IS NOT NULL
          ON CONFLICT DO NOTHING
        `, [name, spec, qual, hospitalId, deptId, fee, Math.max(5, Math.min(480, duration))]);
        existingDoctorKeys.add(dupKey);
        activeCount++;
        imported++;
      } catch (rowErr) {
        skipped++;
        errors.push(`Row: ${rowErr.message}`);
      }
    }

    // Audited for the same reason POST /patients/import already is: a CSV can
    // add dozens of dentists in one call, and that is precisely the event an
    // owner later cannot account for against their plan's seat count.
    await writeAuditLog(s, req.user.id, req.user.role,
      'IMPORT_DOCTORS', 'doctor', null, null, { imported, skipped }, req.ip);
    res.json({ imported, skipped, errors: errors.slice(0, 20) });
  } catch (err) { handleError(res, err); }
});

// ── DOCTOR AVAILABILITY ───────────────────────────────────────
router.get('/doctors/:id/availability', validateUUID(), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date required (YYYY-MM-DD)' });
    }
    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      SELECT slot_date::text as date,
             COUNT(*) FILTER (WHERE status='available')::int as available_slots,
             COUNT(*) FILTER (WHERE status='booked')::int as booked_slots,
             array_agg(start_time::text ORDER BY start_time) FILTER (WHERE status='available') as available_times
      FROM time_slots
      WHERE doctor_id=$1
        AND slot_date BETWEEN $2 AND $3
      GROUP BY slot_date
      ORDER BY slot_date
    `, [req.params.id, start_date, end_date]);
    res.json({ availability: r.rows, doctor_id: req.params.id });
  } catch (err) { handleError(res, err, 'GET /doctors/:id/availability'); }
});

// ── DOCTOR PRICING ────────────────────────────────────────────
router.patch('/doctors/:id/pricing', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { new_patient_fee, returning_patient_fee, consultation_fee } = req.body;
    const s = req.tenant.schema_name;
    const updates = [];
    const params = [];
    if (typeof consultation_fee === 'number') {
      params.push(consultation_fee); updates.push(`consultation_fee=$${params.length}`);
    }
    const pricingRules = {};
    if (typeof new_patient_fee === 'number') pricingRules.new_patient_fee = new_patient_fee;
    if (typeof returning_patient_fee === 'number') pricingRules.returning_patient_fee = returning_patient_fee;
    if (Object.keys(pricingRules).length > 0) {
      params.push(JSON.stringify(pricingRules));
      // MERGE (`||`), not replace. This route builds a fresh object containing
      // only the keys present in the body, so a plain `pricing_rules=$N` wiped
      // every rule the caller did not happen to send: PATCH {new_patient_fee:600}
      // against {new_patient_fee:500, returning_patient_fee:300} silently
      // deleted the returning-patient fee, with nothing in the audit log to show
      // what happened.
      updates.push(`pricing_rules = COALESCE(pricing_rules, '{}'::jsonb) || $${params.length}::jsonb`);
    }
    if (!updates.length) return res.status(400).json({ error: 'No pricing fields provided' });
    params.push(req.params.id);
    const r = await tenantQuery(s,
      `UPDATE doctors SET ${updates.join(',')} WHERE id=$${params.length} AND is_active=true RETURNING id, name, consultation_fee, pricing_rules`,
      params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Doctor not found' });
    // Audited like every other mutating doctor route in this file — a change to
    // what a patient is charged should not be the one that leaves no trace.
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_DOCTOR_PRICING', 'doctor', req.params.id,
      null, { consultation_fee, ...pricingRules }, req.ip);
    res.json({ doctor: r.rows[0] });
  } catch (err) { handleError(res, err, 'PATCH /doctors/:id/pricing'); }
});

// ── DOCTOR MULTI-LOCATION ─────────────────────────────────────
router.get('/doctors/:id/locations', validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      SELECT dh.hospital_id, dh.day_of_week, dh.start_time::text, dh.end_time::text,
             h.name as hospital_name, h.city
      FROM doctor_hospitals dh
      JOIN hospitals h ON h.id = dh.hospital_id
      WHERE dh.doctor_id = $1
      ORDER BY dh.day_of_week, h.name
    `, [req.params.id]);
    res.json({ locations: r.rows });
  } catch (err) { handleError(res, err, 'GET /doctors/:id/locations'); }
});

router.post('/doctors/:id/locations', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { hospital_id, day_of_week, start_time, end_time } = req.body;
    if (!hospital_id || day_of_week === undefined || !start_time || !end_time) {
      return res.status(400).json({ error: 'hospital_id, day_of_week, start_time, end_time required' });
    }
    if (!UUID_RE.test(hospital_id)) {
      return res.status(400).json({ error: 'Invalid hospital_id format' });
    }
    const dow = parseInt(day_of_week);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      return res.status(400).json({ error: 'day_of_week must be 0 (Sunday) through 6 (Saturday)' });
    }
    if (!TIME_RE.test(start_time) || !TIME_RE.test(end_time)) {
      return res.status(400).json({ error: 'start_time and end_time must be HH:MM (24h format)' });
    }
    if (start_time >= end_time) {
      return res.status(400).json({ error: 'start_time must be before end_time' });
    }
    const s = req.tenant.schema_name;
    // A doctor is at ONE branch on a given weekday. The unique key is
    // (doctor_id, hospital_id, day_of_week), so two rows for the same weekday at
    // DIFFERENT branches are perfectly legal to the schema — and both then feed
    // slotGenerator's LEFT JOIN, which resolves the branch with .find() over an
    // unordered result set. Tuesday's slots got whichever row Postgres returned
    // first, and it could change between runs: patients who chose one branch
    // were sent to the other. POST /doctors/:id/schedule has always deleted the
    // conflicting row; this route did not, so the same clinic state was
    // reachable through the API but not the dashboard.
    await tenantTransaction(s, async (client) => {
      await client.query(
        `DELETE FROM doctor_hospitals WHERE doctor_id=$1 AND day_of_week=$2 AND hospital_id<>$3`,
        [req.params.id, day_of_week, hospital_id]);
      await client.query(`
        INSERT INTO doctor_hospitals (doctor_id, hospital_id, day_of_week, start_time, end_time)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (doctor_id, hospital_id, day_of_week) DO UPDATE
          SET start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time
      `, [req.params.id, hospital_id, day_of_week, start_time, end_time]);
    });
    // Audited: this decides which BRANCH a whole weekday's slots are stamped
    // with, and it silently deletes the conflicting row for that day. A change
    // here moves a visiting consultant's clinic without touching the schedule
    // screen, so it must be attributable.
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_DOCTOR_LOCATION', 'doctor', req.params.id,
      null, { hospital_id, day_of_week, start_time, end_time }, req.ip);
    res.json({ success: true });
  } catch (err) { handleError(res, err, 'POST /doctors/:id/locations'); }
});

router.delete('/doctors/:id/locations/:hospitalId', adminOnly, validateUUID(), async (req, res) => {
  try {
    // validateUUID() only checks :id. Without this, a malformed :hospitalId
    // reaches Postgres and comes back as a 500 ("invalid input syntax for type
    // uuid") instead of a 400 — same guard as the other two-param routes.
    if (!UUID_RE.test(req.params.hospitalId)) {
      return res.status(400).json({ error: 'Invalid hospital ID' });
    }
    const s = req.tenant.schema_name;
    await tenantQuery(s, `
      DELETE FROM doctor_hospitals WHERE doctor_id=$1 AND hospital_id=$2
    `, [req.params.id, req.params.hospitalId]);
    res.json({ success: true });
  } catch (err) { handleError(res, err, 'DELETE /doctors/:id/locations/:hospitalId'); }
});

module.exports = router;
