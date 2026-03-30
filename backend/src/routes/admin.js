const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query, tenantQuery, tenantTransaction } = require('../db');
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { VALID_ROLES, VALID_APPOINTMENT_STATUSES, validateUUID, handleError } = require('../utils/errors');
const logger = require('../utils/logger');

router.use(authMiddleware, tenantMiddleware);

// ── RATE LIMITERS ─────────────────────────────────────────────
const slotsGenerateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many slot generation requests. Try again in an hour.' },
  standardHeaders: true,
});

// ── ROLE GUARD ────────────────────────────────────────────────
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── AUDIT LOG HELPER ──────────────────────────────────────────
async function writeAuditLog(schema, actorId, actorRole, action, resourceType, resourceId, oldValues, newValues, ipAddress) {
  try {
    await tenantQuery(schema, `
      INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, old_values, new_values, ip_address)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      actorId, actorRole, action, resourceType, resourceId,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      ipAddress || null,
    ]);
  } catch (err) { logger.warn('Audit log write failed', { action, error: err.message }); }
}

// ── DASHBOARD STATS ───────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const tenantId = req.tenant.id;

    // Try stats cache first (valid if updated within 15 minutes)
    let cached = null;
    try {
      const cacheR = await query(`
        SELECT * FROM tenant_stats_cache
        WHERE tenant_id=$1 AND stat_date=CURRENT_DATE AND updated_at > NOW() - INTERVAL '15 minutes'
      `, [tenantId]);
      cached = cacheR.rows[0] || null;
    } catch (_) { /* cache miss */ }

    let statsData;
    if (cached) {
      statsData = {
        today_appointments: cached.appointments_today,
        total_patients: cached.patients_total,
        available_slots: cached.active_slots,
      };
    }

    // Always run upcoming (time-sensitive) and today's schedule live
    const [upcoming, recentAppts, ...liveStats] = await Promise.allSettled([
      tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date>CURRENT_DATE AND status='confirmed'`),
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
      // Only run heavy queries if cache miss
      ...(cached ? [] : [
        tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date=CURRENT_DATE AND status='confirmed'`),
        tenantQuery(s, `SELECT COUNT(*) FROM patients`),
        tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date>=CURRENT_DATE AND status='available'`),
        tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date >= date_trunc('month', CURRENT_DATE) AND status IN ('confirmed','completed')`),
      ]),
    ]);

    const val = (r, field = 'count', fallback = null) =>
      r.status === 'fulfilled' ? (field === 'rows' ? r.value.rows : parseInt(r.value.rows[0]?.[field] ?? '0')) : fallback;

    if (!cached && liveStats.length >= 4) {
      statsData = {
        today_appointments: val(liveStats[0]),
        total_patients: val(liveStats[1]),
        available_slots: val(liveStats[2]),
        appointments_month: val(liveStats[3]),
      };
      // Async update cache (non-blocking)
      query(`
        INSERT INTO tenant_stats_cache (tenant_id, stat_date, appointments_today, appointments_month, patients_total, active_slots, updated_at)
        VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, NOW())
        ON CONFLICT (tenant_id, stat_date) DO UPDATE SET
          appointments_today=EXCLUDED.appointments_today, appointments_month=EXCLUDED.appointments_month,
          patients_total=EXCLUDED.patients_total, active_slots=EXCLUDED.active_slots, updated_at=NOW()
      `, [tenantId, statsData.today_appointments, statsData.appointments_month ?? 0, statsData.total_patients, statsData.available_slots])
        .catch(() => {});
    }

    // Log any rejected queries
    [upcoming, recentAppts, ...liveStats].forEach((r, i) => {
      if (r.status === 'rejected') logger.warn(`Dashboard query [${i}] failed`, { error: r.reason?.message });
    });

    res.json({
      today_appointments: statsData?.today_appointments ?? null,
      upcoming_appointments: val(upcoming),
      total_patients: statsData?.total_patients ?? null,
      available_slots: statsData?.available_slots ?? null,
      todays_schedule: val(recentAppts, 'rows', []),
      cache_hit: !!cached,
    });
  } catch (err) { handleError(res, err); }
});

// ── APPOINTMENTS ──────────────────────────────────────────────
router.get('/appointments', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const { date, status, from, to, page = 1, limit = 25 } = req.query;
    // Enforce pagination bounds — prevent DoS via large limit
    const safeLimit = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
    const safePage = Math.max(parseInt(page) || 1, 1);
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (date && !DATE_RE.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
    if (from && !DATE_RE.test(from)) {
      return res.status(400).json({ error: 'Invalid from date format. Use YYYY-MM-DD.' });
    }
    if (to && !DATE_RE.test(to)) {
      return res.status(400).json({ error: 'Invalid to date format. Use YYYY-MM-DD.' });
    }
    if (status && !VALID_APPOINTMENT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_APPOINTMENT_STATUSES.join(', ')}` });
    }
    const where = ['1=1'];
    const params = [];
    if (date) { params.push(date); where.push(`a.appointment_date=$${params.length}`); }
    if (from) { params.push(from); where.push(`a.appointment_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`a.appointment_date <= $${params.length}`); }
    if (status) { params.push(status); where.push(`a.status=$${params.length}`); }
    // Separate count params (no LIMIT/OFFSET)
    const countParams = params.slice();
    params.push(safeLimit, (safePage - 1) * safeLimit);
    const [r, countR] = await Promise.all([
      tenantQuery(s, `
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
      `, params),
      tenantQuery(s, `
        SELECT COUNT(*) FROM appointments a WHERE ${where.join(' AND ')}
      `, countParams),
    ]);
    const total = parseInt(countR.rows[0]?.count || 0);
    res.json({
      appointments: r.rows,
      total,
      page: safePage,
      limit: safeLimit,
      has_more: r.rows.length === safeLimit,
    });
  } catch (err) { handleError(res, err); }
});

router.patch('/appointments/:id', validateUUID(), async (req, res) => {
  try {
    const { status, notes, note_category, cancellation_reason } = req.body;
    const s = req.tenant.schema_name;

    const VALID_NOTE_CATEGORIES = ['general', 'vip', 'allergy', 'followup', 'special'];
    if (status && !VALID_APPOINTMENT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_APPOINTMENT_STATUSES.join(', ')}` });
    }
    if (note_category && !VALID_NOTE_CATEGORIES.includes(note_category)) {
      return res.status(400).json({ error: `Invalid note_category. Must be one of: ${VALID_NOTE_CATEGORIES.join(', ')}` });
    }
    if (status === 'cancelled' && !cancellation_reason) {
      return res.status(400).json({ error: 'cancellation_reason is required when cancelling an appointment' });
    }

    const oldR = await tenantQuery(s, `SELECT status, slot_id FROM appointments WHERE id=$1`, [req.params.id]);
    if (!oldR.rows[0]) return res.status(404).json({ error: 'Appointment not found' });

    // Prevent invalid state transitions — completed and cancelled are terminal states
    const currentStatus = oldR.rows[0].status;
    if (status && status !== currentStatus) {
      const TERMINAL_STATUSES = ['completed', 'cancelled'];
      if (TERMINAL_STATUSES.includes(currentStatus)) {
        return res.status(409).json({ error: `Cannot change status from '${currentStatus}' — it is a terminal state` });
      }
    }

    const updates = ['updated_at=NOW()'];
    const params = [];
    if (status) { params.push(status); updates.push(`status=$${params.length}`); }
    if (notes !== undefined) { params.push(notes); updates.push(`notes=$${params.length}`); }
    if (note_category) { params.push(note_category); updates.push(`note_category=$${params.length}`); }
    if (cancellation_reason) { params.push(cancellation_reason); updates.push(`cancellation_reason=$${params.length}`); }
    if (status === 'cancelled') {
      updates.push('cancelled_at=NOW()');
      updates.push(`cancelled_by='admin'`);
      params.push(req.user.id);
      updates.push(`cancelled_by_user_id=$${params.length}`);
    }
    params.push(req.params.id);

    // Wrap appointment update + slot release in a single transaction so a crash
    // between the two writes cannot leave a cancelled appointment with a booked slot.
    let updatedRow;
    await tenantTransaction(s, async (client) => {
      const r = await client.query(
        `UPDATE appointments SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`,
        params);
      if (!r.rows[0]) return; // not found — handled below
      updatedRow = r.rows[0];
      if (status === 'cancelled' && updatedRow.slot_id) {
        await client.query(
          `UPDATE time_slots SET status='available' WHERE id=$1 AND status='booked'`,
          [updatedRow.slot_id]);
      }
    });
    if (!updatedRow) return res.status(404).json({ error: 'Appointment not found' });

    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_APPOINTMENT', 'appointment', req.params.id,
      { status: oldR.rows[0].status }, { status, cancellation_reason }, req.ip);

    res.json({ appointment: updatedRow });
  } catch (err) { handleError(res, err); }
});

router.get('/appointments/:id', validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      SELECT a.*,
             p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
             p.date_of_birth, p.gender, p.visit_count, p.dental_history as medical_history,
             d.name as doctor_name, d.specialization, d.consultation_fee,
             h.name as hospital_name, h.address as hospital_address,
             dep.name as department_name
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      JOIN hospitals h ON h.id=a.hospital_id
      LEFT JOIN departments dep ON dep.id=d.department_id
      WHERE a.id=$1
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Appointment not found' });

    // Fetch patient's recent appointment history
    const history = await tenantQuery(s, `
      SELECT a2.booking_id, a2.appointment_date, a2.appointment_time, a2.status, d2.name as doctor_name
      FROM appointments a2
      JOIN doctors d2 ON d2.id=a2.doctor_id
      WHERE a2.patient_id=$1 AND a2.id != $2
      ORDER BY a2.appointment_date DESC LIMIT 5
    `, [r.rows[0].patient_id, req.params.id]);

    res.json({ appointment: r.rows[0], patient_history: history.rows });
  } catch (err) { handleError(res, err); }
});

router.post('/appointments', adminOnly, validate(schemas.createAppointment), async (req, res) => {
  try {
    const { patient_phone, patient_name, doctor_id, hospital_id, slot_id, appointment_date, appointment_time, visit_type, notes } = req.body;
    if (!patient_phone || !doctor_id || !hospital_id || !appointment_date || !appointment_time) {
      return res.status(400).json({ error: 'patient_phone, doctor_id, hospital_id, appointment_date, appointment_time are required' });
    }
    const s = req.tenant.schema_name;

    let newAppointment;
    let bookingId;
    const { randomUUID } = require('crypto');

    // Retry up to 3 times on booking_id collision (23505 unique_violation).
    // Same retry pattern used by the bot booking flow in bookingFlow.js.
    let insertAttempts = 0;
    while (true) {
      bookingId = 'MB' + randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
      try {
        await tenantTransaction(s, async (client) => {
          // Upsert walk-in patient
          const patientR = await client.query(`
            INSERT INTO patients (phone, name, visit_count)
            VALUES ($1, $2, 1)
            ON CONFLICT (phone) DO UPDATE SET
              name=COALESCE(EXCLUDED.name, patients.name),
              visit_count=patients.visit_count+1, updated_at=NOW()
            RETURNING id
          `, [patient_phone, patient_name || null]);
          const patientId = patientR.rows[0].id;

          // Lock slot atomically inside the transaction — if slot already booked,
          // the transaction rolls back and no orphaned booked slot is left behind
          if (slot_id) {
            const slotR = await client.query(
              `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available' RETURNING id`,
              [slot_id]);
            if (!slotR.rows[0]) {
              const err = new Error('Slot is no longer available');
              err.statusCode = 409;
              throw err;
            }
          }

          const r = await client.query(`
            INSERT INTO appointments
              (booking_id, patient_id, doctor_id, hospital_id, slot_id, appointment_date, appointment_time, visit_type, notes, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed') RETURNING *
          `, [bookingId, patientId, doctor_id, hospital_id, slot_id || null, appointment_date, appointment_time, visit_type || 'in_person', notes || null]);
          newAppointment = r.rows[0];
        });
        break; // success
      } catch (insertErr) {
        // 23505 = unique_violation — retry only on booking_id collision, not slot conflict
        if (insertErr.code === '23505' && insertErr.constraint?.includes('booking_id') && ++insertAttempts < 3) {
          logger.warn('Walk-in booking_id collision, retrying', { attempt: insertAttempts });
          continue;
        }
        throw insertErr;
      }
    }

    await writeAuditLog(s, req.user.id, req.user.role, 'CREATE_APPOINTMENT', 'appointment', newAppointment.id,
      null, { booking_id: bookingId, doctor_id, appointment_date }, req.ip);

    res.status(201).json({ appointment: newAppointment, booking_id: bookingId });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ error: err.message });
    handleError(res, err);
  }
});

// ── HOSPITALS ─────────────────────────────────────────────────
router.get('/hospitals', async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT * FROM hospitals WHERE is_active=true ORDER BY name`);
    res.json({ hospitals: r.rows });
  } catch (err) { handleError(res, err); }
});

router.post('/hospitals', adminOnly, validate(schemas.createHospital), async (req, res) => {
  try {
    const { name, address, city, phone } = req.body;
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s,
      `INSERT INTO hospitals (name, address, city, phone) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, address, city, phone]);
    await writeAuditLog(s, req.user.id, req.user.role, 'CREATE_HOSPITAL', 'hospital', r.rows[0].id,
      null, { name, city }, req.ip);
    res.json({ hospital: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.patch('/hospitals/:id', adminOnly, validateUUID(), validate(schemas.createHospital), async (req, res) => {
  try {
    const { name, address, city, phone } = req.body;
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      UPDATE hospitals SET
        name=COALESCE($1,name), address=COALESCE($2,address),
        city=COALESCE($3,city), phone=COALESCE($4,phone)
      WHERE id=$5 AND is_active=true RETURNING *
    `, [name, address, city, phone, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Hospital not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_HOSPITAL', 'hospital', req.params.id,
      null, { name, city }, req.ip);
    res.json({ hospital: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.delete('/hospitals/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    // Atomic check-and-update: only deactivate if no upcoming confirmed appointments exist
    const r = await tenantQuery(s, `
      UPDATE hospitals SET is_active=false
      WHERE id=$1 AND is_active=true
        AND NOT EXISTS (
          SELECT 1 FROM appointments
          WHERE hospital_id=$1 AND status='confirmed' AND appointment_date >= CURRENT_DATE
        )
      RETURNING id
    `, [req.params.id]);
    if (!r.rows[0]) {
      // Distinguish between "not found" and "blocked by appointments"
      const exists = await tenantQuery(s,
        `SELECT id, (SELECT COUNT(*) FROM appointments WHERE hospital_id=$1 AND status='confirmed' AND appointment_date >= CURRENT_DATE) as upcoming FROM hospitals WHERE id=$1`,
        [req.params.id]);
      if (!exists.rows[0]) return res.status(404).json({ error: 'Hospital not found' });
      const cnt = parseInt(exists.rows[0].upcoming);
      return res.status(409).json({
        error: `Cannot deactivate hospital — ${cnt} upcoming confirmed appointment(s) exist. Cancel them first.`,
        upcoming_appointments: cnt,
      });
    }
    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_HOSPITAL', 'hospital', req.params.id,
      null, null, req.ip);
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── DEPARTMENTS ───────────────────────────────────────────────
router.get('/departments', async (req, res) => {
  try {
    const { hospital_id } = req.query;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (hospital_id && !UUID_RE.test(hospital_id)) {
      return res.status(400).json({ error: 'hospital_id must be a valid UUID' });
    }
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT d.*, h.name as hospital_name FROM departments d
       JOIN hospitals h ON h.id=d.hospital_id
       WHERE d.is_active=true ${hospital_id ? 'AND d.hospital_id=$1' : ''}
       ORDER BY d.name`,
      hospital_id ? [hospital_id] : []);
    res.json({ departments: r.rows });
  } catch (err) { handleError(res, err); }
});

router.post('/departments', adminOnly, validate(schemas.createDepartment), async (req, res) => {
  try {
    const { name, hospital_id, description } = req.body;
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s,
      `INSERT INTO departments (hospital_id, name, description) VALUES ($1,$2,$3) RETURNING *`,
      [hospital_id, name, description]);
    await writeAuditLog(s, req.user.id, req.user.role, 'CREATE_DEPARTMENT', 'department', r.rows[0].id,
      null, { name, hospital_id }, req.ip);
    res.json({ department: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.patch('/departments/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { name, description } = req.body;
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      UPDATE departments SET
        name=COALESCE($1,name), description=COALESCE($2,description)
      WHERE id=$3 AND is_active=true RETURNING *
    `, [name || null, description || null, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Department not found' });
    res.json({ department: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.delete('/departments/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s,
      `UPDATE departments SET is_active=false WHERE id=$1 AND is_active=true RETURNING id`,
      [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Department not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_DEPARTMENT', 'department', req.params.id,
      null, null, req.ip);
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── DOCTORS ───────────────────────────────────────────────────
router.get('/doctors', async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    const r = await tenantQuery(req.tenant.schema_name, `
      SELECT d.*, dep.name as department_name, h.name as hospital_name,
             COALESCE(appt_agg.total, 0)::int as total_appointments,
             COALESCE(slot_agg.available, 0)::int as available_slots
      FROM doctors d
      LEFT JOIN departments dep ON dep.id=d.department_id
      LEFT JOIN hospitals h ON h.id=d.hospital_id
      LEFT JOIN (
        SELECT doctor_id, COUNT(*) as total
        FROM appointments WHERE status='confirmed'
        GROUP BY doctor_id
      ) appt_agg ON appt_agg.doctor_id=d.id
      LEFT JOIN (
        SELECT doctor_id, COUNT(*) as available
        FROM time_slots WHERE slot_date>=CURRENT_DATE AND status='available'
        GROUP BY doctor_id
      ) slot_agg ON slot_agg.doctor_id=d.id
      ${includeInactive ? '' : 'WHERE d.is_active=true'}
      ORDER BY d.is_active DESC, d.name
    `);
    res.json({ doctors: r.rows });
  } catch (err) { handleError(res, err); }
});

router.post('/doctors', adminOnly, validate(schemas.createDoctor), async (req, res) => {
  try {
    const { name, specialization, qualification, department_id, hospital_id, consultation_fee, slot_duration_minutes } = req.body;
    const s = req.tenant.schema_name;

    // Plan quota enforcement
    const planR = await query(`SELECT max_doctors FROM plans WHERE id=$1`, [req.tenant.plan]);
    if (planR.rows[0]) {
      const countR = await tenantQuery(s, `SELECT COUNT(*) FROM doctors WHERE is_active=true`);
      const current = parseInt(countR.rows[0].count);
      const limit = planR.rows[0].max_doctors;
      if (current >= limit) {
        return res.status(403).json({
          error: `Doctor limit reached for your plan (${current}/${limit}). Upgrade to add more doctors.`,
          quota_exceeded: true,
        });
      }
    }

    // Validate hospital exists (avoids 500 from FK violation)
    const hospCheck = await tenantQuery(s, `SELECT id FROM hospitals WHERE id=$1 AND is_active=true`, [hospital_id]);
    if (!hospCheck.rows[0]) return res.status(400).json({ error: 'Hospital not found' });
    // Validate department belongs to that hospital if provided
    if (department_id) {
      const deptCheck = await tenantQuery(s, `SELECT id FROM departments WHERE id=$1 AND hospital_id=$2`, [department_id, hospital_id]);
      if (!deptCheck.rows[0]) return res.status(400).json({ error: 'Department not found or does not belong to this hospital' });
    }

    const r = await tenantQuery(s, `
      INSERT INTO doctors (name, specialization, qualification, department_id, hospital_id, consultation_fee, slot_duration_minutes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [name, specialization, qualification, department_id, hospital_id, consultation_fee || 0, slot_duration_minutes || 30]);
    await writeAuditLog(s, req.user.id, req.user.role, 'CREATE_DOCTOR', 'doctor', r.rows[0].id,
      null, { name, specialization, department_id, hospital_id }, req.ip);
    res.json({ doctor: r.rows[0] });
  } catch (err) { handleError(res, err); }
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
      LEFT JOIN (
        SELECT doctor_id, COUNT(*) as total FROM appointments WHERE status='confirmed' GROUP BY doctor_id
      ) appt_agg ON appt_agg.doctor_id=d.id
      LEFT JOIN (
        SELECT doctor_id, COUNT(*) as available FROM time_slots WHERE slot_date>=CURRENT_DATE AND status='available' GROUP BY doctor_id
      ) slot_agg ON slot_agg.doctor_id=d.id
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

    // Validate department belongs to the effective hospital (new one if provided, current one if not)
    if (department_id) {
      const effectiveHospitalId = hospital_id || oldR.rows[0].hospital_id;
      const deptCheck = await tenantQuery(s,
        `SELECT id FROM departments WHERE id=$1 AND hospital_id=$2`, [department_id, effectiveHospitalId]);
      if (!deptCheck.rows[0]) {
        return res.status(400).json({ error: 'Department not found or does not belong to this hospital' });
      }
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
    // Atomic check-and-update: only deactivate if no upcoming confirmed appointments exist
    const r = await tenantQuery(s, `
      UPDATE doctors SET is_active=false
      WHERE id=$1 AND is_active=true
        AND NOT EXISTS (
          SELECT 1 FROM appointments
          WHERE doctor_id=$1 AND status='confirmed' AND appointment_date >= CURRENT_DATE
        )
      RETURNING id
    `, [req.params.id]);
    if (!r.rows[0]) {
      // Distinguish between "not found" and "blocked by appointments"
      const exists = await tenantQuery(s,
        `SELECT id, (SELECT COUNT(*) FROM appointments WHERE doctor_id=$1 AND status='confirmed' AND appointment_date >= CURRENT_DATE) as upcoming FROM doctors WHERE id=$1`,
        [req.params.id]);
      if (!exists.rows[0]) return res.status(404).json({ error: 'Doctor not found' });
      const cnt = parseInt(exists.rows[0].upcoming);
      return res.status(409).json({
        error: `Cannot deactivate doctor — ${cnt} upcoming confirmed appointment(s) exist. Cancel them first.`,
        upcoming_appointments: cnt,
      });
    }
    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_DOCTOR', 'doctor', req.params.id,
      null, null, req.ip);
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// Doctor schedule
router.get('/doctors/:id/schedule', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT * FROM doctor_schedules WHERE doctor_id=$1 ORDER BY day_of_week`, [req.params.id]);
    res.json({ schedule: r.rows });
  } catch (err) { handleError(res, err); }
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

router.post('/doctors/:id/schedule', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { schedules } = req.body;
    if (!Array.isArray(schedules)) return res.status(400).json({ error: 'schedules array required' });

    for (const s of schedules) {
      // Validate day_of_week range
      const dow = parseInt(s.day_of_week, 10);
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
        return res.status(400).json({ error: `Invalid day_of_week: ${s.day_of_week}. Must be 0 (Sunday) to 6 (Saturday).` });
      }
      // Validate time format
      if (s.is_working !== false) {
        if (!TIME_RE.test(s.start_time) || !TIME_RE.test(s.end_time)) {
          return res.status(400).json({ error: `Day ${s.day_of_week}: times must be HH:MM (24h format)` });
        }
        if (s.start_time >= s.end_time) {
          return res.status(400).json({
            error: `Invalid schedule for day ${s.day_of_week}: start_time must be before end_time`
          });
        }
        if (s.lunch_start_time && !TIME_RE.test(s.lunch_start_time)) {
          return res.status(400).json({ error: `Day ${s.day_of_week}: lunch_start_time must be HH:MM` });
        }
        if (s.lunch_end_time && !TIME_RE.test(s.lunch_end_time)) {
          return res.status(400).json({ error: `Day ${s.day_of_week}: lunch_end_time must be HH:MM` });
        }
        if (s.lunch_start_time && s.lunch_end_time && s.lunch_start_time >= s.lunch_end_time) {
          return res.status(400).json({ error: `Day ${s.day_of_week}: lunch_start_time must be before lunch_end_time` });
        }
      }
    }

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
  } catch (err) { handleError(res, err); }
});

// ── PATIENTS ──────────────────────────────────────────────────
const patientLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

router.get('/patients', patientLimiter, async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const safePage = Math.max(parseInt(page) || 1, 1);
    const s = req.tenant.schema_name;
    let where = '';
    let params = [];
    if (search) {
      params.push(`%${search}%`);
      where = ` WHERE deleted_at IS NULL AND (name ILIKE $1 OR phone LIKE $1 OR email ILIKE $1)`;
    } else {
      where = ` WHERE deleted_at IS NULL`;
    }
    const countParams = [...params];
    params.push(25, (safePage - 1) * 25);
    const [r, countR] = await Promise.all([
      tenantQuery(s,
        `SELECT id, name, phone, email, gender, date_of_birth, visit_count, created_at FROM patients${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params),
      tenantQuery(s, `SELECT COUNT(*) FROM patients${where}`, countParams),
    ]);
    const total = parseInt(countR.rows[0]?.count || 0);
    res.json({
      patients: r.rows,
      total,
      page: safePage,
      limit: 25,
      has_more: r.rows.length === 25,
    });
  } catch (err) { handleError(res, err); }
});

router.get('/patients/:id/appointments', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name, `
      SELECT a.*, d.name as doctor_name FROM appointments a
      JOIN doctors d ON d.id=a.doctor_id
      WHERE a.patient_id=$1 ORDER BY a.appointment_date DESC LIMIT 20
    `, [req.params.id]);
    res.json({ appointments: r.rows });
  } catch (err) { handleError(res, err); }
});

router.patch('/patients/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { name, email, gender, date_of_birth } = req.body;
    const s = req.tenant.schema_name;
    const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (date_of_birth && !DOB_RE.test(date_of_birth)) {
      return res.status(400).json({ error: 'date_of_birth must be YYYY-MM-DD' });
    }
    const VALID_GENDERS = ['male', 'female', 'other'];
    if (gender && !VALID_GENDERS.includes(gender.toLowerCase())) {
      return res.status(400).json({ error: `gender must be one of: ${VALID_GENDERS.join(', ')}` });
    }
    const r = await tenantQuery(s, `
      UPDATE patients SET
        name=COALESCE($1,name), email=COALESCE($2,email),
        gender=COALESCE($3,gender), date_of_birth=COALESCE($4::date,date_of_birth),
        updated_at=NOW()
      WHERE id=$5 RETURNING id, name, phone, email, gender, date_of_birth, visit_count
    `, [name || null, email || null, gender || null, date_of_birth || null, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_PATIENT', 'patient', req.params.id,
      null, { name, email, gender }, req.ip);
    res.json({ patient: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.get('/patients/:id', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT id, name, phone, email, gender, date_of_birth, visit_count, dental_history as medical_history, created_at, updated_at FROM patients WHERE id=$1`,
      [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    res.json({ patient: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.delete('/patients/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    // Block delete if active upcoming appointments exist
    const upcoming = await tenantQuery(s,
      `SELECT COUNT(*) FROM appointments WHERE patient_id=$1 AND status='confirmed' AND appointment_date >= CURRENT_DATE`,
      [req.params.id]);
    if (parseInt(upcoming.rows[0].count) > 0) {
      return res.status(409).json({
        error: `Cannot delete patient — ${upcoming.rows[0].count} upcoming confirmed appointment(s) exist. Cancel them first.`,
        upcoming_appointments: parseInt(upcoming.rows[0].count),
      });
    }
    // Anonymise rather than hard-delete (GDPR-safe soft delete)
    const r = await tenantQuery(s, `
      UPDATE patients SET
        name='[Deleted]', email=NULL, date_of_birth=NULL, gender=NULL,
        dental_history='{}', updated_at=NOW()
      WHERE id=$1 RETURNING id
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_PATIENT', 'patient', req.params.id,
      null, null, req.ip);
    res.json({ success: true, message: 'Patient record anonymised (GDPR)' });
  } catch (err) { handleError(res, err); }
});

// Analytics routes are handled by routes/analytics.js (mounted before this router).
// They are not duplicated here.

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

    // Support both `action: 'block'|'unblock'` and `status: 'available'|'blocked'` for compatibility
    let newStatus;
    if (action) {
      if (!['block', 'unblock'].includes(action)) {
        return res.status(400).json({ error: "action must be 'block' or 'unblock'" });
      }
      newStatus = action === 'block' ? 'blocked' : 'available';
    } else if (status) {
      if (!['available', 'blocked'].includes(status)) {
        return res.status(400).json({ error: "status must be 'available' or 'blocked'" });
      }
      newStatus = status;
    } else {
      return res.status(400).json({ error: "Provide 'action' (block/unblock) or 'status' (available/blocked)" });
    }

    // Check slot exists and is not booked before blocking
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
    // Clamp days to safe range
    const safeDays = Math.min(Math.max(parseInt(days) || 7, 1), 365);

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

    for (let i = 1; i <= safeDays; i++) {
      const date = addDays(today, i);
      const dow = date.getDay();
      const sched = schedR.rows.find(s => s.day_of_week === dow);
      if (!sched) continue;
      const dateStr = format(date, 'yyyy-MM-dd');
      const [sh, sm] = sched.start_time.split(':').map(Number);
      const [eh, em] = sched.end_time.split(':').map(Number);

      let lunchStart = null, lunchEnd = null;
      if (sched.lunch_start_time && sched.lunch_end_time) {
        const [lsh, lsm] = sched.lunch_start_time.split(':').map(Number);
        const [leh, lem] = sched.lunch_end_time.split(':').map(Number);
        lunchStart = lsh * 60 + lsm;
        lunchEnd   = leh * 60 + lem;
      }

      let cur = sh * 60 + sm;
      const end = eh * 60 + em;

      const daySlots = [];
      while (cur + duration <= end) {
        if (lunchStart !== null && cur < lunchEnd && cur + duration > lunchStart) {
          cur = lunchEnd;
          continue;
        }
        const st = `${String(Math.floor(cur / 60)).padStart(2, '0')}:${String(cur % 60).padStart(2, '0')}`;
        const et = `${String(Math.floor((cur + duration) / 60)).padStart(2, '0')}:${String((cur + duration) % 60).padStart(2, '0')}`;
        daySlots.push([doctor_id, doc.hospital_id, dateStr, st, et]);
        cur += duration;
      }

      for (let j = 0; j < daySlots.length; j += 100) {
        const chunk = daySlots.slice(j, j + 100);
        const values = chunk.map((_, k) =>
          `($${k * 5 + 1},$${k * 5 + 2},$${k * 5 + 3},$${k * 5 + 4},$${k * 5 + 5},'available')`
        ).join(',');
        await tenantQuery(s, `
          INSERT INTO time_slots (doctor_id, hospital_id, slot_date, start_time, end_time, status)
          VALUES ${values}
          ON CONFLICT (doctor_id, slot_date, start_time) DO NOTHING
        `, chunk.flat());
        generated += chunk.length;
      }
    }
    res.json({ success: true, generated, days: safeDays });
  } catch (err) { handleError(res, err); }
});

// ── STAFF CRUD ────────────────────────────────────────────────
router.get('/staff', async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT id, email, name, role, is_active, created_at FROM users ORDER BY created_at DESC`);
    res.json({ staff: r.rows });
  } catch (err) { handleError(res, err); }
});

router.post('/staff', adminOnly, validate(schemas.createStaff), async (req, res) => {
  try {
    const { name, email, password, role = 'staff' } = req.body;
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    const hash = await bcrypt.hash(password, 12);
    const r = await tenantQuery(req.tenant.schema_name,
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id,email,name,role,is_active,created_at`,
      [email.toLowerCase(), hash, name, role]);
    res.json({ staff: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    return handleError(res, err);
  }
});

router.patch('/staff/:id', adminOnly, validateUUID(), validate(schemas.updateStaff), async (req, res) => {
  try {
    const { name, email, password, role, is_active } = req.body;
    const updates = [];
    const params = [];
    if (name) { params.push(name); updates.push(`name=$${params.length}`); }
    if (email) { params.push(email.toLowerCase()); updates.push(`email=$${params.length}`); }
    if (password) { const h = await bcrypt.hash(password, 12); params.push(h); updates.push(`password_hash=$${params.length}`); }
    if (role && VALID_ROLES.includes(role)) { params.push(role); updates.push(`role=$${params.length}`); }
    if (typeof is_active === 'boolean') { params.push(is_active); updates.push(`is_active=$${params.length}`); }
    if (!updates.length) return res.json({ message: 'Nothing to update' });
    params.push(req.params.id);
    const r = await tenantQuery(req.tenant.schema_name,
      `UPDATE users SET ${updates.join(',')} WHERE id=$${params.length} RETURNING id,email,name,role,is_active`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Staff member not found' });

    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role,
      'UPDATE_STAFF', 'user', req.params.id, null, { role, is_active }, req.ip);

    res.json({ staff: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.delete('/staff/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });

    const targetR = await tenantQuery(req.tenant.schema_name,
      `SELECT role FROM users WHERE id=$1`, [req.params.id]);
    if (!targetR.rows[0]) return res.status(404).json({ error: 'Staff member not found' });

    if (targetR.rows[0].role === 'admin') {
      const adminCount = await tenantQuery(req.tenant.schema_name,
        `SELECT COUNT(*) FROM users WHERE role='admin' AND is_active=true AND id != $1`,
        [req.params.id]);
      if (parseInt(adminCount.rows[0].count) < 1) {
        return res.status(400).json({ error: 'Cannot deactivate the last admin account' });
      }
    }

    await tenantQuery(req.tenant.schema_name,
      `UPDATE users SET is_active=false WHERE id=$1`, [req.params.id]);

    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role,
      'DEACTIVATE_STAFF', 'user', req.params.id, null, null, req.ip);

    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── SETTINGS ──────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const t = req.tenant;
    const [hospR, planR, usageR] = await Promise.allSettled([
      tenantQuery(t.schema_name, `SELECT * FROM hospitals LIMIT 1`),
      query(`SELECT * FROM plans WHERE id=$1`, [t.plan]),
      Promise.all([
        tenantQuery(t.schema_name, `SELECT COUNT(*) FROM doctors WHERE is_active=true`),
        tenantQuery(t.schema_name, `SELECT COUNT(*) FROM appointments WHERE created_at >= date_trunc('month', NOW())`),
      ]),
    ]);
    const hosp = hospR.status === 'fulfilled' ? (hospR.value.rows[0] || {}) : {};
    const planData = planR.status === 'fulfilled' ? planR.value.rows[0] : null;
    const [docCount, apptCount] = usageR.status === 'fulfilled' ? usageR.value : [null, null];
    res.json({
      clinic_name: t.name,
      owner_email: t.owner_email,
      plan: t.plan,
      wa_phone_number_id: t.wa_phone_number_id || '',
      wa_configured: !!t.wa_phone_number_id,
      settings: t.settings || {},
      hospital: {
        address: hosp.address || '',
        city: hosp.city || '',
        phone: hosp.phone || '',
      },
      plan_limits: planData ? {
        name: planData.name,
        max_doctors: planData.max_doctors,
        max_appointments_per_month: planData.max_appointments_per_month,
        price_monthly: planData.price_monthly,
      } : null,
      usage: {
        active_doctors: docCount ? parseInt(docCount.rows[0].count) : null,
        appointments_this_month: apptCount ? parseInt(apptCount.rows[0].count) : null,
      },
    });
  } catch (err) { handleError(res, err); }
});

router.patch('/settings', adminOnly, validate(schemas.updateSettings), async (req, res) => {
  try {
    const { name, wa_phone_number_id, wa_access_token, notification_prefs } = req.body;
    const updates = [];
    const params = [];
    if (name) { params.push(name); updates.push(`name=$${params.length}`); }
    if (wa_phone_number_id !== undefined) { params.push(wa_phone_number_id); updates.push(`wa_phone_number_id=$${params.length}`); }
    if (wa_access_token) {
      const { encrypt } = require('../utils/encryption');
      params.push(encrypt(wa_access_token)); updates.push(`wa_access_token_enc=$${params.length}`);
    }
    if (notification_prefs) {
      params.push(JSON.stringify(notification_prefs));
      updates.push(`settings=settings || $${params.length}::jsonb`);
    }
    if (updates.length) {
      params.push(req.tenant.id);
      await query(`UPDATE tenants SET ${updates.join(',')} WHERE id=$${params.length}`, params);
    }

    // Audit log for settings changes (especially WA credential updates)
    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role,
      'UPDATE_SETTINGS', 'tenant', req.tenant.id,
      null,
      { name: !!name, wa_phone_updated: !!wa_phone_number_id, wa_token_updated: !!wa_access_token },
      req.ip);

    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── BLOCK SLOT RANGE ──────────────────────────────────────────
router.post('/slots/block-range', adminOnly, validate(schemas.blockRange), async (req, res) => {
  try {
    const { doctor_id, start_date, end_date, reason } = req.body;
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s,
      `UPDATE time_slots SET status='blocked'
       WHERE doctor_id=$1 AND slot_date BETWEEN $2 AND $3 AND status='available'
       RETURNING id`,
      [doctor_id, start_date, end_date]);

    await writeAuditLog(s, req.user.id, req.user.role, 'BLOCK_SLOTS', 'time_slots', doctor_id,
      null, { doctor_id, start_date, end_date, count: r.rows.length, reason }, req.ip);

    res.json({ blocked: r.rows.length, reason: reason || null });
  } catch (err) { handleError(res, err); }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────
router.get('/notifications/recent', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      SELECT a.id, a.booking_id, a.created_at, a.appointment_date, a.appointment_time,
             p.name as patient_name, d.name as doctor_name
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      WHERE a.created_at >= NOW() - INTERVAL '5 minutes' AND a.status='confirmed'
      ORDER BY a.created_at DESC
      LIMIT 10
    `);
    res.json({ notifications: r.rows, count: r.rows.length });
  } catch (err) { handleError(res, err); }
});

// ── FEEDBACK ──────────────────────────────────────────────────
router.get('/feedback', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const { page = 1, limit = 25, doctor_id, min_rating, max_rating } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (doctor_id && !UUID_RE.test(doctor_id)) {
      return res.status(400).json({ error: 'Invalid doctor_id format' });
    }
    const where = ['1=1'];
    const params = [];
    if (doctor_id) { params.push(doctor_id); where.push(`a.doctor_id=$${params.length}`); }
    if (min_rating) { params.push(parseInt(min_rating)); where.push(`af.rating>=$${params.length}`); }
    if (max_rating) { params.push(parseInt(max_rating)); where.push(`af.rating<=$${params.length}`); }
    params.push(safeLimit, offset);
    const r = await tenantQuery(s, `
      SELECT af.*, p.name as patient_name, d.name as doctor_name,
             a.booking_id, a.appointment_date
      FROM appointment_feedback af
      JOIN patients p ON p.id=af.patient_id
      JOIN appointments a ON a.id=af.appointment_id
      JOIN doctors d ON d.id=a.doctor_id
      WHERE ${where.join(' AND ')}
      ORDER BY af.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    const [avgR, distR] = await Promise.all([
      tenantQuery(s, `SELECT ROUND(AVG(rating),1) as avg_rating, COUNT(*) as total FROM appointment_feedback`),
      tenantQuery(s, `SELECT rating, COUNT(*) as count FROM appointment_feedback GROUP BY rating ORDER BY rating DESC`),
    ]);
    res.json({
      feedback: r.rows,
      page: parseInt(page),
      has_more: r.rows.length === safeLimit,
      avg_rating: avgR.rows[0]?.avg_rating ? parseFloat(avgR.rows[0].avg_rating) : null,
      total: parseInt(avgR.rows[0]?.total || 0),
      distribution: distR.rows,
    });
  } catch (err) { handleError(res, err); }
});


// ── DOCTOR LEAVES ─────────────────────────────────────────────
router.get('/doctors/:id/leaves', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name, `
      SELECT * FROM doctor_leaves WHERE doctor_id=$1 ORDER BY leave_date
    `, [req.params.id]);
    res.json({ leaves: r.rows });
  } catch (err) { handleError(res, err); }
});

router.post('/doctors/:id/leaves', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { dates, reason } = req.body; // dates: string[] of 'YYYY-MM-DD'
    if (!Array.isArray(dates) || dates.length === 0) {
      return res.status(400).json({ error: 'dates array required' });
    }
    const s = req.tenant.schema_name;
    let added = 0;
    for (const d of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      await tenantQuery(s, `
        INSERT INTO doctor_leaves (doctor_id, leave_date, reason, created_by_user_id)
        VALUES ($1,$2,$3,$4) ON CONFLICT (doctor_id, leave_date) DO NOTHING
      `, [req.params.id, d, reason || null, req.user.id]);
      // Block existing available slots on that date
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
    // Restore blocked slots for this leave date (only those not booked)
    await tenantQuery(s,
      `UPDATE time_slots SET status='available'
       WHERE doctor_id=$1 AND slot_date=$2 AND status='blocked'`,
      [req.params.id, req.params.date]);
    await writeAuditLog(s, req.user.id, req.user.role, 'REMOVE_DOCTOR_LEAVE', 'doctor', req.params.id,
      null, { date: req.params.date }, req.ip);
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── PATIENT MEDICAL HISTORY ───────────────────────────────────
router.get('/patients/:id/medical-history', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT id, name, phone, dental_history as medical_history FROM patients WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    res.json({ patient: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.patch('/patients/:id/medical-history', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { medical_history } = req.body;
    if (!medical_history || typeof medical_history !== 'object') {
      return res.status(400).json({ error: 'medical_history object required' });
    }
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s,
      `UPDATE patients SET dental_history=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, dental_history as medical_history`,
      [JSON.stringify(medical_history), req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_MEDICAL_HISTORY', 'patient', req.params.id,
      null, { fields: Object.keys(medical_history) }, req.ip);
    res.json({ patient: r.rows[0] });
  } catch (err) { handleError(res, err); }
});


// ── ONBOARDING ────────────────────────────────────────────────
router.get('/onboarding/status', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const [hospitalR, doctorR, slotR] = await Promise.all([
      tenantQuery(s, `SELECT COUNT(*) FROM hospitals WHERE is_active=true`),
      tenantQuery(s, `SELECT COUNT(*) FROM doctors WHERE is_active=true`),
      tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date >= CURRENT_DATE AND status='available'`),
    ]);
    const hospitals = parseInt(hospitalR.rows[0].count);
    const doctors = parseInt(doctorR.rows[0].count);
    const slots = parseInt(slotR.rows[0].count);
    const completed = req.tenant.onboarding_completed;
    const steps = [
      { id: 'hospital', label: 'Add your clinic/hospital', done: hospitals > 0 },
      { id: 'doctor', label: 'Add a doctor', done: doctors > 0 },
      { id: 'slots', label: 'Generate appointment slots', done: slots > 0 },
      { id: 'whatsapp', label: 'Configure WhatsApp', done: !!req.tenant.wa_phone_number_id },
    ];
    res.json({ steps, all_done: steps.every(s => s.done), onboarding_completed: completed });
  } catch (err) { handleError(res, err); }
});

router.post('/onboarding/complete', adminOnly, async (req, res) => {
  try {
    await query(`UPDATE tenants SET onboarding_completed=true WHERE id=$1`, [req.tenant.id]);
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── ACCESS LOGS ────────────────────────────────────────────────
router.get('/access-logs', adminOnly, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;
    const r = await query(`
      SELECT * FROM admin_access_logs
      WHERE tenant_id=$1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.tenant.id, safeLimit, offset]);
    res.json({ logs: r.rows });
  } catch (err) { handleError(res, err); }
});

// ── QUEUE STATS ───────────────────────────────────────────────
router.get('/queue/stats', adminOnly, async (req, res) => {
  try {
    const { getQueueStats } = require('../jobs/botWorker');
    const stats = await getQueueStats();
    res.json(stats);
  } catch (err) { handleError(res, err); }
});

// ── BOT SESSION MANAGEMENT ────────────────────────────────────
router.delete('/bot-sessions/:phone', adminOnly, async (req, res) => {
  try {
    const phone = req.params.phone.replace(/[^0-9+]/g, '');
    if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
    const r = await tenantQuery(req.tenant.schema_name,
      `UPDATE bot_sessions SET state='idle', context='{}', last_activity=NOW() WHERE phone=$1 RETURNING id`,
      [phone]);
    if (!r.rows[0]) return res.status(404).json({ error: 'No active session for that phone number' });
    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role, 'RESET_BOT_SESSION', 'bot_session', phone,
      null, null, req.ip);
    res.json({ success: true, message: `Bot session reset for ${phone}` });
  } catch (err) { handleError(res, err); }
});

// ── BULK APPOINTMENT UPDATE ───────────────────────────────────
router.patch('/appointments/bulk', adminOnly, async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
    if (ids.length > 100) return res.status(400).json({ error: 'Maximum 100 appointments per bulk update' });
    if (!['completed', 'no_show', 'confirmed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    // Validate all ids are UUIDs
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (ids.some(id => !uuidRe.test(id))) return res.status(400).json({ error: 'Invalid appointment ID in list' });

    const s = req.tenant.schema_name;
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(',');
    const r = await tenantQuery(s,
      `UPDATE appointments SET status=$1, updated_at=NOW()
       WHERE id IN (${placeholders}) RETURNING id`,
      [status, ...ids]);

    // Release slots back to available if bulk-cancelling
    if (status === 'cancelled') {
      const slotPlaceholders = ids.map((_, i) => `$${i + 1}`).join(',');
      await tenantQuery(s,
        `UPDATE time_slots SET status='available'
         WHERE status='booked' AND id IN (
           SELECT slot_id FROM appointments WHERE id IN (${slotPlaceholders})
         )`,
        ids);
    }

    await writeAuditLog(s, req.user.id, req.user.role, 'BULK_UPDATE_APPOINTMENT', 'appointment',
      null, null, { ids, status }, req.ip);

    res.json({ updated: r.rows.length, status });
  } catch (err) { handleError(res, err); }
});

// ── SEND WHATSAPP MESSAGE FROM DASHBOARD ──────────────────────
router.post('/messages/send', adminOnly, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });
    if (message.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' });
    if (!/^[0-9]{7,20}$/.test(phone.replace(/[+\s]/g, ''))) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    const { decrypt } = require('../utils/encryption');
    const wa = require('../services/whatsapp');
    const waToken = req.tenant.wa_access_token_enc ? decrypt(req.tenant.wa_access_token_enc) : null;
    const waPhoneId = req.tenant.wa_phone_number_id;
    if (!waToken || !waPhoneId) {
      return res.status(400).json({ error: 'WhatsApp credentials not configured for this clinic' });
    }
    const normalised = phone.replace(/[+\s]/g, '');
    await wa.sendText(normalised, message, waToken, waPhoneId);
    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role,
      'SEND_WA_MESSAGE', 'patient', normalised, null, { message: message.slice(0, 100) }, req.ip);
    res.json({ success: true, phone: normalised });
  } catch (err) { handleError(res, err); }
});

// ── AUDIT LOGS ────────────────────────────────────────────────
router.get('/audit-logs', adminOnly, async (req, res) => {
  try {
    const { from, to, action, resource_type, page = 1, limit = 50, export: doExport } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;
    const s = req.tenant.schema_name;

    const conditions = ['1=1'];
    const params = [];

    if (from) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return res.status(400).json({ error: 'Invalid from date (YYYY-MM-DD)' });
      params.push(from);
      conditions.push(`created_at >= $${params.length}::date`);
    }
    if (to) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'Invalid to date (YYYY-MM-DD)' });
      params.push(to);
      conditions.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (action) {
      params.push(action.toUpperCase());
      conditions.push(`action = $${params.length}`);
    }
    if (resource_type) {
      params.push(resource_type.toLowerCase());
      conditions.push(`resource_type = $${params.length}`);
    }

    const where = conditions.join(' AND ');

    // Total count for pagination
    const countR = await tenantQuery(s, `SELECT COUNT(*) FROM audit_logs WHERE ${where}`, params);
    const total = parseInt(countR.rows[0].count);

    params.push(safeLimit, offset);
    const r = await tenantQuery(s, `
      SELECT id, actor_id, actor_role, action, resource_type, resource_id,
             old_values, new_values, ip_address, created_at
      FROM audit_logs
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    // CSV export
    if (doExport === 'csv') {
      const headers = ['timestamp', 'actor_role', 'action', 'resource_type', 'resource_id', 'ip_address'];
      const rows = r.rows.map(l => [
        l.created_at?.toISOString() || '',
        l.actor_role || '',
        l.action || '',
        l.resource_type || '',
        l.resource_id || '',
        l.ip_address || '',
      ]);
      const csv = [headers, ...rows].map(row =>
        row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
      ).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(csv);
    }

    res.json({ logs: r.rows, total, page: parseInt(page), limit: safeLimit, has_more: offset + r.rows.length < total });
  } catch (err) { handleError(res, err); }
});

// ── CIRCUIT BREAKER RESET ─────────────────────────────────────────────────────
// Call this after updating META_ACCESS_TOKEN to immediately unblock sends.
router.post('/admin/whatsapp/reset-circuit', async (req, res) => {
  try {
    const wa = require('../services/whatsapp');
    if (typeof wa.resetCircuit === 'function') {
      wa.resetCircuit(req.tenant.wa_phone_number_id || process.env.META_PHONE_NUMBER_ID);
      res.json({ success: true, message: 'Circuit breaker reset — bot will send again immediately.' });
    } else {
      res.status(501).json({ error: 'resetCircuit not exported from whatsapp service' });
    }
  } catch (err) { handleError(res, err); }
});

module.exports = router;
