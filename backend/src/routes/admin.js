const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, tenantQuery } = require('../db');
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');

router.use(authMiddleware, tenantMiddleware);

// ── DASHBOARD STATS ───────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const [today, upcoming, patients, slots, recentAppts] = await Promise.all([
      tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date=CURRENT_DATE AND status='confirmed'`),
      tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date>CURRENT_DATE AND status='confirmed'`),
      tenantQuery(s, `SELECT COUNT(*) FROM patients`),
      tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date>=CURRENT_DATE AND status='available'`),
      tenantQuery(s, `
        SELECT a.booking_id, a.appointment_date, a.appointment_time, a.status,
               p.name as patient_name, d.name as doctor_name
        FROM appointments a
        JOIN patients p ON p.id=a.patient_id
        JOIN doctors d ON d.id=a.doctor_id
        WHERE a.appointment_date=CURRENT_DATE
        ORDER BY a.appointment_time
        LIMIT 10
      `),
    ]);
    res.json({
      today_appointments: parseInt(today.rows[0].count),
      upcoming_appointments: parseInt(upcoming.rows[0].count),
      total_patients: parseInt(patients.rows[0].count),
      available_slots: parseInt(slots.rows[0].count),
      todays_schedule: recentAppts.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── APPOINTMENTS ──────────────────────────────────────────────
router.get('/appointments', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const { date, status, page = 1, limit = 25 } = req.query;
    const where = ['1=1'];
    const params = [];
    if (date) { params.push(date); where.push(`a.appointment_date=$${params.length}`); }
    if (status) { params.push(status); where.push(`a.status=$${params.length}`); }
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    const r = await tenantQuery(s, `
      SELECT a.*, p.name as patient_name, p.phone as patient_phone,
             d.name as doctor_name, dep.name as department_name, h.name as hospital_name
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      LEFT JOIN departments dep ON dep.id=d.department_id
      JOIN hospitals h ON h.id=a.hospital_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.appointment_date DESC, a.appointment_time DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    res.json({ appointments: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/appointments/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s,
      `UPDATE appointments SET status=$1, notes=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [status, notes, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    res.json({ appointment: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── HOSPITALS ─────────────────────────────────────────────────
router.get('/hospitals', async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT * FROM hospitals WHERE is_active=true ORDER BY name`);
    res.json({ hospitals: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/hospitals', async (req, res) => {
  try {
    const { name, address, city, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const r = await tenantQuery(req.tenant.schema_name,
      `INSERT INTO hospitals (name, address, city, phone) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, address, city, phone]);
    res.json({ hospital: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DEPARTMENTS ───────────────────────────────────────────────
router.get('/departments', async (req, res) => {
  try {
    const { hospital_id } = req.query;
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT d.*, h.name as hospital_name FROM departments d
       JOIN hospitals h ON h.id=d.hospital_id
       WHERE d.is_active=true ${hospital_id ? 'AND d.hospital_id=$1' : ''}
       ORDER BY d.name`,
      hospital_id ? [hospital_id] : []);
    res.json({ departments: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/departments', async (req, res) => {
  try {
    const { name, hospital_id, description } = req.body;
    const r = await tenantQuery(req.tenant.schema_name,
      `INSERT INTO departments (hospital_id, name, description) VALUES ($1,$2,$3) RETURNING *`,
      [hospital_id, name, description]);
    res.json({ department: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DOCTORS ───────────────────────────────────────────────────
router.get('/doctors', async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    const r = await tenantQuery(req.tenant.schema_name, `
      SELECT d.*, dep.name as department_name, h.name as hospital_name,
             (SELECT COUNT(*) FROM appointments a WHERE a.doctor_id=d.id AND a.status='confirmed') as total_appointments,
             (SELECT COUNT(*) FROM time_slots ts WHERE ts.doctor_id=d.id AND ts.slot_date>=CURRENT_DATE AND ts.status='available') as available_slots
      FROM doctors d
      LEFT JOIN departments dep ON dep.id=d.department_id
      LEFT JOIN hospitals h ON h.id=d.hospital_id
      ${includeInactive ? '' : 'WHERE d.is_active=true'}
      ORDER BY d.is_active DESC, d.name
    `);
    res.json({ doctors: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/doctors', async (req, res) => {
  try {
    const { name, specialization, qualification, department_id, hospital_id, consultation_fee, slot_duration_minutes } = req.body;
    if (!name || !hospital_id) return res.status(400).json({ error: 'Name and hospital_id required' });
    const r = await tenantQuery(req.tenant.schema_name, `
      INSERT INTO doctors (name, specialization, qualification, department_id, hospital_id, consultation_fee, slot_duration_minutes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [name, specialization, qualification, department_id, hospital_id, consultation_fee || 0, slot_duration_minutes || 30]);
    res.json({ doctor: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/doctors/:id', async (req, res) => {
  try {
    const { name, specialization, qualification, consultation_fee, slot_duration_minutes, is_active } = req.body;
    const r = await tenantQuery(req.tenant.schema_name, `
      UPDATE doctors SET
        name=COALESCE($1,name), specialization=COALESCE($2,specialization),
        qualification=COALESCE($3,qualification), consultation_fee=COALESCE($4,consultation_fee),
        slot_duration_minutes=COALESCE($5,slot_duration_minutes), is_active=COALESCE($6,is_active)
      WHERE id=$7 RETURNING *
    `, [name, specialization, qualification, consultation_fee, slot_duration_minutes, is_active, req.params.id]);
    res.json({ doctor: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Doctor schedule
router.get('/doctors/:id/schedule', async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT * FROM doctor_schedules WHERE doctor_id=$1 ORDER BY day_of_week`, [req.params.id]);
    res.json({ schedule: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/doctors/:id/schedule', async (req, res) => {
  try {
    const { schedules } = req.body;
    if (!Array.isArray(schedules)) return res.status(400).json({ error: 'schedules array required' });
    for (const s of schedules) {
      const lunchStart = s.lunch_start_time || null;
      const lunchEnd   = s.lunch_end_time   || null;
      await tenantQuery(req.tenant.schema_name, `
        INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working, lunch_start_time, lunch_end_time)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (doctor_id, day_of_week) DO UPDATE SET
          start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time,
          is_working=EXCLUDED.is_working,
          lunch_start_time=EXCLUDED.lunch_start_time,
          lunch_end_time=EXCLUDED.lunch_end_time
      `, [req.params.id, s.day_of_week, s.start_time, s.end_time, s.is_working !== false, lunchStart, lunchEnd]);
    }
    res.json({ success: true, updated: schedules.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATIENTS ──────────────────────────────────────────────────
router.get('/patients', async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    let sql = `SELECT * FROM patients`;
    let params = [];
    if (search) {
      params.push(`%${search}%`);
      sql += ` WHERE name ILIKE $1 OR phone LIKE $1 OR email ILIKE $1`;
    }
    params.push(25, (parseInt(page) - 1) * 25);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const r = await tenantQuery(req.tenant.schema_name, sql, params);
    res.json({ patients: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Patient appointment history
router.get('/patients/:id/appointments', async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name, `
      SELECT a.*, d.name as doctor_name FROM appointments a
      JOIN doctors d ON d.id=a.doctor_id
      WHERE a.patient_id=$1 ORDER BY a.appointment_date DESC LIMIT 20
    `, [req.params.id]);
    res.json({ appointments: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ANALYTICS ─────────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const { days = 30 } = req.query;
    const [byDay, byDoctor, byStatus, byDept] = await Promise.all([
      tenantQuery(s, `
        SELECT appointment_date::text as date, COUNT(*) as count
        FROM appointments
        WHERE appointment_date >= CURRENT_DATE - INTERVAL '${parseInt(days)} days'
        GROUP BY appointment_date ORDER BY appointment_date
      `),
      tenantQuery(s, `
        SELECT d.name, COUNT(a.id) as count, SUM(d.consultation_fee) as revenue
        FROM appointments a JOIN doctors d ON d.id=a.doctor_id
        WHERE a.created_at >= NOW() - INTERVAL '${parseInt(days)} days' AND a.status='confirmed'
        GROUP BY d.name ORDER BY count DESC LIMIT 10
      `),
      tenantQuery(s, `
        SELECT status, COUNT(*) as count FROM appointments
        WHERE created_at >= NOW() - INTERVAL '${parseInt(days)} days' GROUP BY status
      `),
      tenantQuery(s, `
        SELECT dep.name, COUNT(a.id) as count FROM appointments a
        JOIN doctors d ON d.id=a.doctor_id
        LEFT JOIN departments dep ON dep.id=d.department_id
        WHERE a.created_at >= NOW() - INTERVAL '${parseInt(days)} days'
        GROUP BY dep.name ORDER BY count DESC
      `),
    ]);
    res.json({
      by_day: byDay.rows,
      by_doctor: byDoctor.rows,
      by_status: byStatus.rows,
      by_department: byDept.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SLOTS ─────────────────────────────────────────────────────
router.get('/slots', async (req, res) => {
  try {
    const { doctor_id, date } = req.query;
    if (!doctor_id || !date) return res.status(400).json({ error: 'doctor_id and date required' });
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT * FROM time_slots WHERE doctor_id=$1 AND slot_date=$2 ORDER BY start_time`,
      [doctor_id, date]);
    res.json({ slots: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/slots/:id', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['available', 'blocked'].includes(status)) {
      return res.status(400).json({ error: "status must be 'available' or 'blocked'" });
    }
    const r = await tenantQuery(req.tenant.schema_name,
      `UPDATE time_slots SET status=$1 WHERE id=$2 AND status != 'booked' RETURNING *`,
      [status, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Slot not found or is already booked' });
    res.json({ slot: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/slots/generate', async (req, res) => {
  try {
    const { doctor_id, days = 7, clear = false } = req.body;
    if (!doctor_id) return res.status(400).json({ error: 'doctor_id required' });
    const s = req.tenant.schema_name;

    // Optionally clear existing available (non-booked) slots before regenerating
    if (clear) {
      await tenantQuery(s,
        `DELETE FROM time_slots WHERE doctor_id=$1 AND status IN ('available','blocked') AND slot_date >= CURRENT_DATE`,
        [doctor_id]);
    }

    const docR = await tenantQuery(s, `SELECT * FROM doctors WHERE id=$1`, [doctor_id]);
    if (!docR.rows[0]) return res.status(404).json({ error: 'Doctor not found' });
    const doc = docR.rows[0];

    const schedR = await tenantQuery(s,
      `SELECT * FROM doctor_schedules WHERE doctor_id=$1 AND is_working=true`, [doctor_id]);
    if (!schedR.rows.length) return res.status(400).json({ error: 'No schedule configured for this doctor' });

    const { addDays, format } = require('date-fns');
    const duration = doc.slot_duration_minutes || 30;
    const today = new Date();
    let generated = 0;

    for (let i = 1; i <= parseInt(days); i++) {
      const date = addDays(today, i);
      const dow = date.getDay();
      const sched = schedR.rows.find(s => s.day_of_week === dow);
      if (!sched) continue;
      const dateStr = format(date, 'yyyy-MM-dd');
      const [sh, sm] = sched.start_time.split(':').map(Number);
      const [eh, em] = sched.end_time.split(':').map(Number);

      // Parse lunch window (null = no lunch break)
      let lunchStart = null, lunchEnd = null;
      if (sched.lunch_start_time && sched.lunch_end_time) {
        const [lsh, lsm] = sched.lunch_start_time.split(':').map(Number);
        const [leh, lem] = sched.lunch_end_time.split(':').map(Number);
        lunchStart = lsh * 60 + lsm;
        lunchEnd   = leh * 60 + lem;
      }

      let cur = sh * 60 + sm;
      const end = eh * 60 + em;
      while (cur + duration <= end) {
        // Skip any slot that overlaps the lunch window
        if (lunchStart !== null && cur < lunchEnd && cur + duration > lunchStart) {
          cur = lunchEnd; // jump past lunch
          continue;
        }
        const st = `${String(Math.floor(cur / 60)).padStart(2, '0')}:${String(cur % 60).padStart(2, '0')}`;
        const et = `${String(Math.floor((cur + duration) / 60)).padStart(2, '0')}:${String((cur + duration) % 60).padStart(2, '0')}`;
        await tenantQuery(s, `
          INSERT INTO time_slots (doctor_id, hospital_id, slot_date, start_time, end_time, status)
          VALUES ($1,$2,$3,$4,$5,'available')
          ON CONFLICT (doctor_id, slot_date, start_time) DO NOTHING
        `, [doctor_id, doc.hospital_id, dateStr, st, et]);
        cur += duration;
        generated++;
      }
    }
    res.json({ success: true, generated, days: parseInt(days) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
