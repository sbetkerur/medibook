'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { query, tenantQuery, tenantTransaction } = require('../db');
const { validate, schemas } = require('../middleware/validate');
const { validateUUID, handleError, UUID_RE } = require('../utils/errors');
const { adminOnly, writeAuditLog } = require('./adminHelpers');
const logger = require('../utils/logger');
const { IST_TODAY_SQL } = require('../utils/dateTz');

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
async function deleteFutureUnreferencedSlots(schema, doctorId, statuses = ['available']) {
  return tenantQuery(schema,
    `DELETE FROM time_slots WHERE doctor_id=$1 AND status = ANY($2::text[])
       AND (slot_date > (timezone('Asia/Kolkata', NOW()))::date
            OR (slot_date = (timezone('Asia/Kolkata', NOW()))::date
                AND start_time > (timezone('Asia/Kolkata', NOW()))::time))
       AND id NOT IN (SELECT slot_id FROM appointments WHERE slot_id IS NOT NULL)`,
    [doctorId, statuses]);
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
               COALESCE(appt_agg.total, 0)::int as total_appointments,
               COALESCE(slot_agg.available, 0)::int as available_slots
        FROM doctors d
        LEFT JOIN departments dep ON dep.id=d.department_id
        LEFT JOIN hospitals h ON h.id=d.hospital_id
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
    const { name, specialization, qualification, department_id, hospital_id, consultation_fee, slot_duration_minutes } = req.body;
    const s = req.tenant.schema_name;

    // Pre-validate FK references before entering the transaction
    const hospCheck = await tenantQuery(s, `SELECT id FROM hospitals WHERE id=$1 AND is_active=true AND deleted_at IS NULL`, [hospital_id]);
    if (!hospCheck.rows[0]) return res.status(400).json({ error: 'Hospital not found' });
    if (department_id) {
      const deptCheck = await tenantQuery(s, `SELECT id FROM departments WHERE id=$1 AND hospital_id=$2`, [department_id, hospital_id]);
      if (!deptCheck.rows[0]) return res.status(400).json({ error: 'Department not found or does not belong to this hospital' });
    }

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

      return client.query(`
        INSERT INTO doctors (name, specialization, qualification, department_id, hospital_id, consultation_fee, slot_duration_minutes)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
      `, [name, specialization, qualification, department_id, hospital_id, consultation_fee || 0, slot_duration_minutes || 30]);
    });

    res.json({ doctor: r.rows[0] });
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
             COALESCE(appt_agg.total, 0)::int as total_appointments,
             COALESCE(slot_agg.available, 0)::int as available_slots
      FROM doctors d
      LEFT JOIN departments dep ON dep.id=d.department_id
      LEFT JOIN hospitals h ON h.id=d.hospital_id
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
    const { name, specialization, qualification, consultation_fee, slot_duration_minutes, is_active, department_id, hospital_id, pricing_rules } = req.body;
    const s = req.tenant.schema_name;
    // Validate UUID fields early — PostgreSQL's ::uuid cast would otherwise return 500
    if (hospital_id && !UUID_RE.test(hospital_id)) {
      return res.status(400).json({ error: 'Invalid hospital_id format' });
    }
    if (department_id && !UUID_RE.test(department_id)) {
      return res.status(400).json({ error: 'Invalid department_id format' });
    }
    const oldR = await tenantQuery(s, `SELECT name, is_active, hospital_id FROM doctors WHERE id=$1`, [req.params.id]);
    if (!oldR.rows[0]) return res.status(404).json({ error: 'Doctor not found' });
    if (department_id) {
      const effectiveHospitalId = hospital_id || oldR.rows[0].hospital_id;
      const deptCheck = await tenantQuery(s, `SELECT id FROM departments WHERE id=$1 AND hospital_id=$2`, [department_id, effectiveHospitalId]);
      if (!deptCheck.rows[0]) return res.status(400).json({ error: 'Department not found or does not belong to this hospital' });
    }
    const pricingRulesVal = pricing_rules && typeof pricing_rules === 'object' ? JSON.stringify(pricing_rules) : null;
    const r = await tenantQuery(s, `
      UPDATE doctors SET
        name=COALESCE($1,name), specialization=COALESCE($2,specialization),
        qualification=COALESCE($3,qualification), consultation_fee=COALESCE($4,consultation_fee),
        slot_duration_minutes=COALESCE($5,slot_duration_minutes), is_active=COALESCE($6,is_active),
        department_id=COALESCE($7::uuid,department_id), hospital_id=COALESCE($8::uuid,hospital_id),
        pricing_rules=COALESCE($10::jsonb,pricing_rules)
      WHERE id=$9 RETURNING *
    `, [name, specialization, qualification, consultation_fee, slot_duration_minutes, is_active, department_id || null, hospital_id || null, req.params.id, pricingRulesVal]);
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_DOCTOR', 'doctor', req.params.id,
      oldR.rows[0], { name, is_active }, req.ip);
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
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT * FROM doctor_schedules WHERE doctor_id=$1 ORDER BY day_of_week`, [req.params.id]);
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
      }
    }
    const s = req.tenant.schema_name;
    await tenantTransaction(s, async (client) => {
      for (const sched of schedules) {
        await client.query(`
          INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working, lunch_start_time, lunch_end_time)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (doctor_id, day_of_week) DO UPDATE SET
            start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time,
            is_working=EXCLUDED.is_working,
            lunch_start_time=EXCLUDED.lunch_start_time,
            lunch_end_time=EXCLUDED.lunch_end_time
        `, [req.params.id, sched.day_of_week, sched.start_time, sched.end_time, sched.is_working !== false, sched.lunch_start_time || null, sched.lunch_end_time || null]);
      }
    });

    // Regenerate future slots to reflect the new schedule.
    // Delete all future available slots for this doctor first, then re-create.
    let slotsGenerated = 0;
    try {
      // Also skip slots referenced by appointments — a cancelled appointment
      // keeps its slot_id, so deleting the released slot violates the
      // appointments FK and aborts the regeneration.
      await deleteFutureUnreferencedSlots(s, req.params.id);
      const { generateSlotsForDoctor } = require('../jobs/slotGenerator');
      slotsGenerated = await generateSlotsForDoctor(s, req.params.id);
      if (slotsGenerated > 0) {
        logger.info(`Slots regenerated after schedule update for doctor ${req.params.id}: ${slotsGenerated} slots`);
      }
    } catch (regenErr) {
      // Non-fatal: schedule saved, slot regeneration is best-effort
      logger.warn(`Slot regeneration failed after schedule update for doctor ${req.params.id}`, { error: regenErr.message });
    }

    res.json({ success: true, updated: schedules.length, slots_regenerated: slotsGenerated });
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
      const ins = await tenantQuery(s, `
        INSERT INTO doctor_leaves (doctor_id, leave_date, reason, created_by_user_id)
        SELECT $1, d, $2, $3 FROM unnest($4::date[]) AS d
        ON CONFLICT (doctor_id, leave_date) DO NOTHING
        RETURNING id
      `, [req.params.id, reason || null, req.user.id, validDates]);
      // Only count rows actually inserted — ON CONFLICT DO NOTHING returns no row
      // for dates that were already on leave.
      added = ins.rows.length;
      skipped += validDates.length - added;
      // Mark blocked_by_leave so removing the leave later only releases these
      // slots — never slots an admin blocked manually for another reason.
      await tenantQuery(s,
        `UPDATE time_slots SET status='blocked', blocked_by_leave=true
         WHERE doctor_id=$1 AND slot_date = ANY($2::date[]) AND status='available'`,
        [req.params.id, validDates]);
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
    const r = await tenantQuery(s,
      `DELETE FROM doctor_leaves WHERE doctor_id=$1 AND leave_date=$2 RETURNING id`,
      [req.params.id, req.params.date]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Leave record not found' });
    // Only release slots that THIS leave blocked (blocked_by_leave) — a blanket
    // unblock previously also re-opened slots an admin had blocked manually.
    await tenantQuery(s,
      `UPDATE time_slots SET status='available', blocked_by_leave=false
       WHERE doctor_id=$1 AND slot_date=$2 AND status='blocked' AND blocked_by_leave=true`,
      [req.params.id, req.params.date]);
    await writeAuditLog(s, req.user.id, req.user.role, 'REMOVE_DOCTOR_LEAVE', 'doctor', req.params.id,
      null, { date: req.params.date }, req.ip);
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

router.patch('/slots/:id', validateUUID(), async (req, res) => {
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
    // Clear blocked_by_leave on any manual block/unblock: the flag marks slots
    // blocked BY A LEAVE so that removing the leave releases only those. Once an
    // admin manually changes a slot's status, the slot is under manual control —
    // a stale flag would let a later leave removal re-open a manually blocked slot.
    const r = await tenantQuery(s,
      `UPDATE time_slots SET status=$1, blocked_by_leave=false WHERE id=$2 AND status != 'booked' RETURNING *`,
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
      // "clear" is meant to reset everything.
      await deleteFutureUnreferencedSlots(s, doctor_id, ['available', 'blocked']);
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

        await tenantQuery(s, `
          INSERT INTO doctors (name, specialization, qualification, hospital_id, department_id, consultation_fee, slot_duration_minutes)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [name, spec, qual, hospitalId, deptId, fee, Math.max(5, Math.min(480, duration))]);
        existingDoctorKeys.add(dupKey);
        activeCount++;
        imported++;
      } catch (rowErr) {
        skipped++;
        errors.push(`Row: ${rowErr.message}`);
      }
    }

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
      updates.push(`pricing_rules=$${params.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'No pricing fields provided' });
    params.push(req.params.id);
    const r = await tenantQuery(s,
      `UPDATE doctors SET ${updates.join(',')} WHERE id=$${params.length} AND is_active=true RETURNING id, name, consultation_fee, pricing_rules`,
      params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Doctor not found' });
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
    await tenantQuery(s, `
      INSERT INTO doctor_hospitals (doctor_id, hospital_id, day_of_week, start_time, end_time)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (doctor_id, hospital_id, day_of_week) DO UPDATE
        SET start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time
    `, [req.params.id, hospital_id, day_of_week, start_time, end_time]);
    res.json({ success: true });
  } catch (err) { handleError(res, err, 'POST /doctors/:id/locations'); }
});

router.delete('/doctors/:id/locations/:hospitalId', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    await tenantQuery(s, `
      DELETE FROM doctor_hospitals WHERE doctor_id=$1 AND hospital_id=$2
    `, [req.params.id, req.params.hospitalId]);
    res.json({ success: true });
  } catch (err) { handleError(res, err, 'DELETE /doctors/:id/locations/:hospitalId'); }
});

module.exports = router;
