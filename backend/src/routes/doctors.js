'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { query, tenantQuery, tenantTransaction } = require('../db');
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { validateUUID, handleError } = require('../utils/errors');
const { adminOnly, writeAuditLog } = require('./adminHelpers');
const { addDays, format } = require('date-fns');
const logger = require('../utils/logger');

router.use(authMiddleware, tenantMiddleware);

const slotsGenerateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Too many slot generation requests. Try again in an hour.' },
  standardHeaders: true,
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
          FROM time_slots WHERE slot_date>=CURRENT_DATE AND status='available' GROUP BY doctor_id
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
      LEFT JOIN (SELECT doctor_id, COUNT(*) as available FROM time_slots WHERE slot_date>=CURRENT_DATE AND status='available' GROUP BY doctor_id) slot_agg ON slot_agg.doctor_id=d.id
      WHERE d.id=$1
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Doctor not found' });
    res.json({ doctor: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.patch('/doctors/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { name, specialization, qualification, consultation_fee, slot_duration_minutes, is_active, department_id, hospital_id } = req.body;
    const s = req.tenant.schema_name;
    const oldR = await tenantQuery(s, `SELECT name, is_active, hospital_id FROM doctors WHERE id=$1`, [req.params.id]);
    if (!oldR.rows[0]) return res.status(404).json({ error: 'Doctor not found' });
    if (department_id) {
      const effectiveHospitalId = hospital_id || oldR.rows[0].hospital_id;
      const deptCheck = await tenantQuery(s, `SELECT id FROM departments WHERE id=$1 AND hospital_id=$2`, [department_id, effectiveHospitalId]);
      if (!deptCheck.rows[0]) return res.status(400).json({ error: 'Department not found or does not belong to this hospital' });
    }
    const r = await tenantQuery(s, `
      UPDATE doctors SET
        name=COALESCE($1,name), specialization=COALESCE($2,specialization),
        qualification=COALESCE($3,qualification), consultation_fee=COALESCE($4,consultation_fee),
        slot_duration_minutes=COALESCE($5,slot_duration_minutes), is_active=COALESCE($6,is_active),
        department_id=COALESCE($7::uuid,department_id), hospital_id=COALESCE($8::uuid,hospital_id)
      WHERE id=$9 RETURNING *
    `, [name, specialization, qualification, consultation_fee, slot_duration_minutes, is_active, department_id || null, hospital_id || null, req.params.id]);
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
          SELECT 1 FROM appointments WHERE doctor_id=$1 AND status='confirmed' AND appointment_date >= CURRENT_DATE
        )
      RETURNING id
    `, [req.params.id]);
    if (!r.rows[0]) {
      const exists = await tenantQuery(s,
        `SELECT id, (SELECT COUNT(*) FROM appointments WHERE doctor_id=$1 AND status='confirmed' AND appointment_date >= CURRENT_DATE) as upcoming FROM doctors WHERE id=$1`,
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
        if (s.lunch_start_time && !TIME_RE.test(s.lunch_start_time)) {
          return res.status(400).json({ error: `Day ${dow}: lunch_start_time must be HH:MM` });
        }
        if (s.lunch_end_time && !TIME_RE.test(s.lunch_end_time)) {
          return res.status(400).json({ error: `Day ${dow}: lunch_end_time must be HH:MM` });
        }
      }
    }
    const s = req.tenant.schema_name;
    for (const sched of schedules) {
      await tenantQuery(s, `
        INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working, lunch_start_time, lunch_end_time)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (doctor_id, day_of_week) DO UPDATE SET
          start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time,
          is_working=EXCLUDED.is_working,
          lunch_start_time=EXCLUDED.lunch_start_time,
          lunch_end_time=EXCLUDED.lunch_end_time
      `, [req.params.id, sched.day_of_week, sched.start_time, sched.end_time, sched.is_working !== false, sched.lunch_start_time || null, sched.lunch_end_time || null]);
    }

    // Regenerate future slots to reflect the new schedule.
    // Delete all future available slots for this doctor first, then re-create.
    let slotsGenerated = 0;
    try {
      await tenantQuery(s,
        `DELETE FROM time_slots WHERE doctor_id=$1 AND status='available' AND slot_date > CURRENT_DATE`,
        [req.params.id]);
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
    let added = 0;
    for (const d of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      await tenantQuery(s, `
        INSERT INTO doctor_leaves (doctor_id, leave_date, reason, created_by_user_id)
        VALUES ($1,$2,$3,$4) ON CONFLICT (doctor_id, leave_date) DO NOTHING
      `, [req.params.id, d, reason || null, req.user.id]);
      await tenantQuery(s,
        `UPDATE time_slots SET status='blocked' WHERE doctor_id=$1 AND slot_date=$2 AND status='available'`,
        [req.params.id, d]);
      added++;
    }
    await writeAuditLog(s, req.user.id, req.user.role, 'ADD_DOCTOR_LEAVE', 'doctor', req.params.id,
      null, { dates, reason }, req.ip);
    res.json({ success: true, added });
  } catch (err) { handleError(res, err); }
});

router.delete('/doctors/:id/leaves/:date', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s,
      `DELETE FROM doctor_leaves WHERE doctor_id=$1 AND leave_date=$2 RETURNING id`,
      [req.params.id, req.params.date]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Leave record not found' });
    await tenantQuery(s,
      `UPDATE time_slots SET status='available' WHERE doctor_id=$1 AND slot_date=$2 AND status='blocked'`,
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
    const UUID_RE = /^[0-9a-f-]{36}$/i;
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
    const r = await tenantQuery(s,
      `UPDATE time_slots SET status=$1 WHERE id=$2 AND status != 'booked' RETURNING *`,
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
    const s = req.tenant.schema_name;
    const safeDays = Math.min(Math.max(parseInt(days) || 7, 1), 365);
    if (clear) {
      await tenantQuery(s, `DELETE FROM time_slots WHERE doctor_id=$1 AND status IN ('available','blocked') AND slot_date >= CURRENT_DATE`, [doctor_id]);
    }
    const docR = await tenantQuery(s, `SELECT * FROM doctors WHERE id=$1`, [doctor_id]);
    if (!docR.rows[0]) return res.status(404).json({ error: 'Doctor not found' });
    const doc = docR.rows[0];
    const schedR = await tenantQuery(s, `SELECT * FROM doctor_schedules WHERE doctor_id=$1 AND is_working=true`, [doctor_id]);
    if (!schedR.rows.length) return res.status(400).json({ error: 'No schedule configured for this doctor' });
    const duration = Math.max(5, doc.slot_duration_minutes || 30);
    const today = new Date();
    let generated = 0;
    for (let i = 1; i <= safeDays; i++) {
      const date = addDays(today, i);
      const dow = date.getDay();
      const sched = schedR.rows.find(sc => sc.day_of_week === dow);
      if (!sched) continue;
      const dateStr = format(date, 'yyyy-MM-dd');
      const [sh, sm] = sched.start_time.split(':').map(Number);
      const [eh, em] = sched.end_time.split(':').map(Number);
      let lunchStart = null, lunchEnd = null;
      if (sched.lunch_start_time && sched.lunch_end_time) {
        const [lsh, lsm] = sched.lunch_start_time.split(':').map(Number);
        const [leh, lem] = sched.lunch_end_time.split(':').map(Number);
        lunchStart = lsh * 60 + lsm;
        lunchEnd = leh * 60 + lem;
      }
      let cur = sh * 60 + sm;
      const end = eh * 60 + em;
      const daySlots = [];
      while (cur + duration <= end) {
        if (lunchStart !== null && cur < lunchEnd && cur + duration > lunchStart) { cur = lunchEnd; continue; }
        const st = `${String(Math.floor(cur / 60)).padStart(2, '0')}:${String(cur % 60).padStart(2, '0')}`;
        const et = `${String(Math.floor((cur + duration) / 60)).padStart(2, '0')}:${String((cur + duration) % 60).padStart(2, '0')}`;
        daySlots.push([doctor_id, doc.hospital_id, dateStr, st, et]);
        cur += duration;
      }
      for (let j = 0; j < daySlots.length; j += 100) {
        const chunk = daySlots.slice(j, j + 100);
        const values = chunk.map((_, k) => `($${k*5+1},$${k*5+2},$${k*5+3},$${k*5+4},$${k*5+5},'available')`).join(',');
        await tenantQuery(s, `
          INSERT INTO time_slots (doctor_id, hospital_id, slot_date, start_time, end_time, status)
          VALUES ${values} ON CONFLICT (doctor_id, slot_date, start_time) DO NOTHING
        `, chunk.flat());
        generated += chunk.length;
      }
    }
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

module.exports = router;
