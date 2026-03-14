'use strict';
const router = require('express').Router();
const { tenantQuery, tenantTransaction } = require('../db');
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { VALID_APPOINTMENT_STATUSES, validateUUID, handleError } = require('../utils/errors');
const { adminOnly, writeAuditLog } = require('./adminHelpers');
const logger = require('../utils/logger');

router.use(authMiddleware, tenantMiddleware);

// ── LIST APPOINTMENTS ─────────────────────────────────────────
router.get('/appointments', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const { date, status, page = 1, limit = 25 } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
    const safePage = Math.max(parseInt(page) || 1, 1);

    // Validate status against whitelist before building SQL
    if (status && !VALID_APPOINTMENT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_APPOINTMENT_STATUSES.join(', ')}` });
    }

    const where = ['1=1'];
    const params = [];
    if (date) { params.push(date); where.push(`a.appointment_date=$${params.length}`); }
    if (status) { params.push(status); where.push(`a.status=$${params.length}`); }
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
      tenantQuery(s, `SELECT COUNT(*) FROM appointments a WHERE ${where.join(' AND ')}`, countParams),
    ]);
    const total = parseInt(countR.rows[0]?.count || 0);
    res.json({ appointments: r.rows, total, page: safePage, limit: safeLimit, has_more: r.rows.length === safeLimit });
  } catch (err) { handleError(res, err); }
});

// ── GET SINGLE APPOINTMENT ────────────────────────────────────
router.get('/appointments/:id', validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      SELECT a.*,
             p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
             p.date_of_birth, p.gender, p.visit_count, p.medical_history,
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
    const history = await tenantQuery(s, `
      SELECT a2.booking_id, a2.appointment_date, a2.appointment_time, a2.status, d2.name as doctor_name
      FROM appointments a2 JOIN doctors d2 ON d2.id=a2.doctor_id
      WHERE a2.patient_id=$1 AND a2.id != $2
      ORDER BY a2.appointment_date DESC LIMIT 5
    `, [r.rows[0].patient_id, req.params.id]);
    // Audit medical history access for privacy compliance
    if (r.rows[0].medical_history && Object.keys(r.rows[0].medical_history).length > 0) {
      writeAuditLog(s, req.user.id, req.user.role, 'ACCESS_MEDICAL_HISTORY', 'patient',
        r.rows[0].patient_id, null, null, req.ip)
        .catch(e => logger.warn('Medical history audit log failed', { error: e.message }));
    }
    res.json({ appointment: r.rows[0], patient_history: history.rows });
  } catch (err) { handleError(res, err); }
});

// ── UPDATE APPOINTMENT STATUS ─────────────────────────────────
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
      return res.status(400).json({ error: 'cancellation_reason is required when cancelling' });
    }
    const oldR = await tenantQuery(s, `SELECT status FROM appointments WHERE id=$1`, [req.params.id]);
    if (!oldR.rows[0]) return res.status(404).json({ error: 'Appointment not found' });

    // Wrap cancel + slot release in a transaction to prevent a race where the
    // reminder cron marks reminder_Xh_sent=true on an appointment being cancelled.
    let r;
    if (status === 'cancelled') {
      r = await tenantTransaction(s, async (client) => {
        // Lock the appointment row to serialise against concurrent reminder updates
        const locked = await client.query(
          `SELECT id, slot_id, doctor_id FROM appointments WHERE id=$1 AND status='confirmed' FOR UPDATE`,
          [req.params.id]
        );
        if (!locked.rows[0]) {
          const err = new Error('NOT_CANCELLABLE');
          err.code = 'NOT_CANCELLABLE';
          throw err;
        }
        const updates = ['updated_at=NOW()', 'status=$1', 'cancelled_at=NOW()', `cancelled_by_user_id=$2`];
        const params = [status, req.user.id];
        if (notes !== undefined) { params.push(notes); updates.push(`notes=$${params.length}`); }
        if (note_category) { params.push(note_category); updates.push(`note_category=$${params.length}`); }
        if (cancellation_reason) { params.push(cancellation_reason); updates.push(`cancellation_reason=$${params.length}`); }
        params.push(req.params.id);
        const updated = await client.query(
          `UPDATE appointments SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`, params
        );
        if (locked.rows[0].slot_id) {
          await client.query(
            `UPDATE time_slots SET status='available' WHERE id=$1 AND status='booked'`,
            [locked.rows[0].slot_id]
          );
        }
        return updated;
      }).catch(err => {
        if (err.code === 'NOT_CANCELLABLE') return null;
        throw err;
      });
      if (!r) return res.status(409).json({ error: 'Appointment is not in a cancellable state (already cancelled or completed)' });
    } else {
      // Non-cancel updates don't need the transaction overhead
      const updates = ['updated_at=NOW()'];
      const params = [];
      if (status) { params.push(status); updates.push(`status=$${params.length}`); }
      if (notes !== undefined) { params.push(notes); updates.push(`notes=$${params.length}`); }
      if (note_category) { params.push(note_category); updates.push(`note_category=$${params.length}`); }
      params.push(req.params.id);
      r = await tenantQuery(s,
        `UPDATE appointments SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`, params);
      if (!r.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    }

    if (status === 'cancelled' && r.rows[0].slot_id) {
      // Notify waiting list patients that a slot has opened up
      try {
        const { notifyWaitlistForDoctor } = require('../services/bot/utils');
        if (r.rows[0].doctor_id) {
          notifyWaitlistForDoctor(s, r.rows[0].doctor_id, req.tenant)
            .catch(e => logger.warn('Waitlist notification failed', { error: e.message }));
        }
      } catch (e) {
        logger.warn('Waitlist notification skipped', { error: e.message });
      }
    }
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_APPOINTMENT', 'appointment', req.params.id,
      { status: oldR.rows[0].status }, { status, cancellation_reason }, req.ip);
    res.json({ appointment: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

// ── CREATE APPOINTMENT (walk-in) ──────────────────────────────
router.post('/appointments', adminOnly, validate(schemas.createAppointment), async (req, res) => {
  try {
    const { patient_phone, patient_name, doctor_id, hospital_id, slot_id, appointment_date, appointment_time, visit_type, notes } = req.body;
    const s = req.tenant.schema_name;

    // Reject appointments in the past
    const today = new Date().toISOString().slice(0, 10);
    if (appointment_date < today) {
      return res.status(400).json({ error: 'appointment_date cannot be in the past' });
    }

    // Verify doctor exists, is active, and belongs to the specified hospital
    const doctorCheck = await tenantQuery(s,
      `SELECT id FROM doctors WHERE id=$1 AND hospital_id=$2 AND is_active=true`,
      [doctor_id, hospital_id]);
    if (!doctorCheck.rows[0]) {
      return res.status(400).json({ error: 'Doctor not found or does not belong to the specified hospital' });
    }

    const patientR = await tenantQuery(s, `
      INSERT INTO patients (phone, name, visit_count) VALUES ($1,$2,1)
      ON CONFLICT (phone) DO UPDATE SET
        name=COALESCE(EXCLUDED.name, patients.name),
        visit_count=patients.visit_count+1, updated_at=NOW()
      RETURNING id
    `, [patient_phone, patient_name || null]);
    const patientId = patientR.rows[0].id;
    if (slot_id) {
      const slotR = await tenantQuery(s,
        `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available' RETURNING id`, [slot_id]);
      if (!slotR.rows[0]) return res.status(409).json({ error: 'Slot is no longer available' });
    }
    const bookingId = 'MB' + Date.now().toString(36).toUpperCase().slice(-6);
    const r = await tenantQuery(s, `
      INSERT INTO appointments
        (booking_id, patient_id, doctor_id, hospital_id, slot_id, appointment_date, appointment_time, visit_type, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed') RETURNING *
    `, [bookingId, patientId, doctor_id, hospital_id, slot_id || null, appointment_date, appointment_time, visit_type || 'in_person', notes || null]);
    await writeAuditLog(s, req.user.id, req.user.role, 'CREATE_APPOINTMENT', 'appointment', r.rows[0].id,
      null, { booking_id: bookingId, doctor_id, appointment_date }, req.ip);
    res.status(201).json({ appointment: r.rows[0], booking_id: bookingId });
  } catch (err) { handleError(res, err); }
});

// ── BULK STATUS UPDATE ────────────────────────────────────────
router.patch('/appointments/bulk', adminOnly, async (req, res) => {
  try {
    const { ids, status, cancellation_reason } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
    if (!status || !VALID_APPOINTMENT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_APPOINTMENT_STATUSES.join(', ')}` });
    }
    if (status === 'cancelled' && !cancellation_reason) {
      return res.status(400).json({ error: 'cancellation_reason required when bulk cancelling' });
    }
    if (ids.length > 50) return res.status(400).json({ error: 'Cannot bulk update more than 50 appointments at once' });
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!ids.every(id => UUID_RE.test(id))) return res.status(400).json({ error: 'All ids must be valid UUIDs' });
    const s = req.tenant.schema_name;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const statusParam = ids.length + 1;
    const extraUpdates = status === 'cancelled' ? `, cancellation_reason=$${statusParam + 1}, cancelled_at=NOW(), cancelled_by_user_id=$${statusParam + 2}` : '';
    const extraParams = status === 'cancelled' ? [cancellation_reason, req.user.id] : [];
    const r = await tenantQuery(s, `
      UPDATE appointments SET status=$${statusParam}, updated_at=NOW()${extraUpdates}
      WHERE id IN (${placeholders}) RETURNING id, slot_id
    `, [...ids, status, ...extraParams]);
    if (status === 'cancelled') {
      const slotIds = r.rows.map(a => a.slot_id).filter(Boolean);
      for (const slotId of slotIds) {
        await tenantQuery(s, `UPDATE time_slots SET status='available' WHERE id=$1 AND status='booked'`, [slotId])
          .catch(() => {});
      }
      // Notify waitlist for each unique doctor/date combination
      try {
        const { notifyWaitlistForDoctor } = require('../services/bot/utils');
        const seen = new Set();
        for (const appt of r.rows) {
          if (appt.doctor_id && !seen.has(appt.doctor_id)) {
            seen.add(appt.doctor_id);
            notifyWaitlistForDoctor(s, appt.doctor_id, req.tenant)
              .catch(e => logger.warn('Bulk waitlist notification failed', { error: e.message }));
          }
        }
      } catch (e) {
        logger.warn('Bulk waitlist notification skipped', { error: e.message });
      }
    }
    await writeAuditLog(s, req.user.id, req.user.role, 'BULK_UPDATE_APPOINTMENTS', 'appointment', null,
      null, { ids, status }, req.ip);
    res.json({ updated: r.rows.length, ids: r.rows.map(a => a.id) });
  } catch (err) { handleError(res, err); }
});

module.exports = router;
