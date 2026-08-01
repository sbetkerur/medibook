'use strict';
const router = require('express').Router();
const { tenantQuery, tenantTransaction } = require('../db');
const { validate, schemas } = require('../middleware/validate');
const { VALID_APPOINTMENT_STATUSES, APPOINTMENT_TRANSITIONS, UUID_RE, validateUUID, handleError } = require('../utils/errors');
const { adminOnly, writeAuditLog } = require('./adminHelpers');
const logger = require('../utils/logger');
const { setTenantId } = require('../utils/requestContext');

// Auth + tenant middleware applied once in index.js for /api/admin and /api/v1/admin

// Populate tenantId on this request's AsyncLocalStorage context (see
// utils/requestContext.js) now that index.js's tenant-resolution middleware
// has already run and set req.tenant. Ideally this one-liner would live
// globally in index.js's request-context setup right after tenant resolution;
// it's added per-route-file here instead because of this task's file-ownership
// constraints (index.js may only be touched for its backup-cron registration).
// Other admin route files won't carry tenantId in their logs until the same
// line is added there too.
router.use((req, res, next) => {
  if (req.tenant?.id) setTenantId(req.tenant.id);
  next();
});

// ── LIST APPOINTMENTS ─────────────────────────────────────────
router.get('/appointments', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const { date, from, to, status, doctor_id, page = 1, limit = 25 } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
    const safePage = Math.max(parseInt(page) || 1, 1);

    // Status can be a single value or comma-separated list (e.g. "confirmed,completed")
    const statusList = status ? status.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (statusList.length > 0 && !statusList.every(s => VALID_APPOINTMENT_STATUSES.includes(s))) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_APPOINTMENT_STATUSES.join(', ')}` });
    }

    if (doctor_id && !UUID_RE.test(doctor_id)) {
      return res.status(400).json({ error: 'Invalid doctor_id format' });
    }

    // Validate date params up front — garbage here reached the SQL cast and
    // surfaced as a 500 on the main dashboard list.
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    for (const [name, val] of [['date', date], ['from', from], ['to', to]]) {
      if (val && !DATE_RE.test(val)) {
        return res.status(400).json({ error: `Invalid ${name} — expected YYYY-MM-DD` });
      }
    }

    const where = ['1=1'];
    const params = [];
    if (date) { params.push(date); where.push(`a.appointment_date=$${params.length}`); }
    if (from) { params.push(from); where.push(`a.appointment_date>=$${params.length}`); }
    if (to) { params.push(to); where.push(`a.appointment_date<=$${params.length}`); }
    if (statusList.length === 1) { params.push(statusList[0]); where.push(`a.status=$${params.length}`); }
    else if (statusList.length > 1) { params.push(statusList); where.push(`a.status = ANY($${params.length})`); }
    if (doctor_id) { params.push(doctor_id); where.push(`a.doctor_id=$${params.length}`); }
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
    const offset = (safePage - 1) * safeLimit;
    res.json({ appointments: r.rows, total, page: safePage, limit: safeLimit, has_more: offset + r.rows.length < total });
  } catch (err) { handleError(res, err); }
});

// ── GET SINGLE APPOINTMENT ────────────────────────────────────
router.get('/appointments/:id', validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      SELECT a.*,
             p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
             p.date_of_birth, p.gender, p.visit_count, p.dental_history,
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
    // Audit dental history access for privacy compliance.
    // Store a truncated patient_id (first 8 chars) rather than the full UUID to
    // avoid unnecessarily surfacing sensitive identifiers in audit log queries.
    if (r.rows[0].dental_history && Object.keys(r.rows[0].dental_history).length > 0) {
      const maskedPatientId = String(r.rows[0].patient_id || '').slice(0, 8) + '…';
      writeAuditLog(s, req.user.id, req.user.role, 'ACCESS_DENTAL_HISTORY', 'patient',
        maskedPatientId, null, null, req.ip)
        .catch(e => logger.warn('Medical history audit log failed', { error: e.message }));
    }
    res.json({ appointment: r.rows[0], patient_history: history.rows });
  } catch (err) { handleError(res, err); }
});

// ── BULK STATUS UPDATE ────────────────────────────────────────
// IMPORTANT: this route must be declared before /appointments/:id so Express
// does not treat the literal string "bulk" as a UUID parameter.
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
    if (!ids.every(id => UUID_RE.test(id))) return res.status(400).json({ error: 'All ids must be valid UUIDs' });
    const s = req.tenant.schema_name;

    let updated;
    if (status === 'cancelled') {
      // Wrap cancel + slot releases in a single transaction to avoid partial state
      // (e.g. some appointments cancelled but their slots still locked) on DB error.
      updated = await tenantTransaction(s, async (client) => {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
        const statusParam = ids.length + 1;
        // Derive cancellable source states from APPOINTMENT_TRANSITIONS — the
        // previous hard-coded ('confirmed','no_show') allowed no_show→cancelled,
        // a transition the single-appointment route correctly rejects.
        const cancellableSources = Object.keys(APPOINTMENT_TRANSITIONS)
          .filter(from => APPOINTMENT_TRANSITIONS[from].includes('cancelled'));
        const r = await client.query(`
          UPDATE appointments SET status=$${statusParam}, updated_at=NOW(),
            cancellation_reason=$${statusParam + 1}, cancelled_at=NOW(), cancelled_by_user_id=$${statusParam + 2}
          WHERE id IN (${placeholders}) AND status = ANY($${statusParam + 3}) RETURNING id, slot_id, doctor_id
        `, [...ids, status, cancellation_reason, req.user.id, cancellableSources]);

        const slotIds = r.rows.map(a => a.slot_id).filter(Boolean);
        if (slotIds.length) {
          const slotPlaceholders = slotIds.map((_, i) => `$${i + 1}`).join(',');
          await client.query(
            `UPDATE time_slots SET status='available' WHERE id IN (${slotPlaceholders}) AND status='booked'`,
            slotIds
          );
        }
        return r;
      });
    } else {
      // Enforce the same state machine as the single-appointment PATCH: only
      // update rows whose CURRENT status allows a transition to the target.
      // Previously this branch updated unconditionally, so a bulk "confirmed"
      // could resurrect cancelled/completed appointments without re-locking
      // their slots.
      const allowedSources = Object.keys(APPOINTMENT_TRANSITIONS)
        .filter(from => APPOINTMENT_TRANSITIONS[from].includes(status));
      if (!allowedSources.length) {
        return res.status(409).json({ error: `No status can transition to '${status}'` });
      }
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const statusParam = ids.length + 1;
      updated = await tenantQuery(s, `
        UPDATE appointments SET status=$${statusParam}, updated_at=NOW()
        WHERE id IN (${placeholders}) AND status = ANY($${ids.length + 2})
        RETURNING id, slot_id, doctor_id
      `, [...ids, status, allowedSources]);
    }

    await writeAuditLog(s, req.user.id, req.user.role, 'BULK_UPDATE_APPOINTMENTS', 'appointment', null,
      null, { ids, status }, req.ip);
    // skipped = requested ids that were not in a state allowing this transition
    res.json({ updated: updated.rows.length, skipped: ids.length - updated.rows.length, ids: updated.rows.map(a => a.id) });
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

    // Enforce valid state transitions to prevent data inconsistency
    // (e.g. reverting a completed appointment back to confirmed).
    // APPOINTMENT_TRANSITIONS is shared with the bulk route so the two can't drift.
    if (status) {
      const currentStatus = oldR.rows[0].status;
      const allowed = APPOINTMENT_TRANSITIONS[currentStatus] || [];
      if (!allowed.includes(status)) {
        return res.status(409).json({
          error: `Invalid status transition: '${currentStatus}' → '${status}'. ` +
            `Allowed transitions from '${currentStatus}': [${allowed.join(', ') || 'none'}]`,
        });
      }
    }

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
      // Non-cancel updates don't need the transaction overhead, but a status
      // change must still be guarded against the status read above — otherwise
      // a concurrent cancel can commit between the check and this UPDATE and
      // e.g. a 'completed' lands on a cancelled row whose slot was released.
      const updates = ['updated_at=NOW()'];
      const params = [];
      if (status) { params.push(status); updates.push(`status=$${params.length}`); }
      if (notes !== undefined) { params.push(notes); updates.push(`notes=$${params.length}`); }
      if (note_category) { params.push(note_category); updates.push(`note_category=$${params.length}`); }
      params.push(req.params.id);
      const idParam = params.length;
      let guard = '';
      if (status) {
        params.push(oldR.rows[0].status);
        guard = ` AND status=$${params.length}`;
      }
      r = await tenantQuery(s,
        `UPDATE appointments SET ${updates.join(',')} WHERE id=$${idParam}${guard} RETURNING *`, params);
      if (!r.rows[0]) {
        return status
          ? res.status(409).json({ error: 'Appointment status changed concurrently — reload and retry' })
          : res.status(404).json({ error: 'Appointment not found' });
      }
    }

    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_APPOINTMENT', 'appointment', req.params.id,
      { status: oldR.rows[0].status }, { status, cancellation_reason }, req.ip);
    res.json({ appointment: r.rows[0] });
    // Fire-and-forget WhatsApp alert to admin on cancel
    if (status === 'cancelled') {
      (async () => {
        try {
          const { notifyAdminWhatsApp } = require('../services/bot/utils');
          const { format, parseISO } = require('date-fns');
          const apptR = await tenantQuery(s, `
            SELECT a.booking_id, a.appointment_date, a.appointment_time, a.cancellation_reason,
                   p.name as patient_name, p.phone as patient_phone, d.name as doctor_name
            FROM appointments a
            JOIN patients p ON p.id = a.patient_id
            JOIN doctors d ON d.id = a.doctor_id
            WHERE a.id = $1
          `, [req.params.id]);
          if (!apptR.rows[0]) return;
          const appt = apptR.rows[0];
          let dateLabel = String(appt.appointment_date || '').slice(0, 10);
          try { dateLabel = format(parseISO(dateLabel), 'EEE, d MMM yyyy'); } catch {}
          await notifyAdminWhatsApp(s, req.tenant,
            `❌ *Appointment Cancelled*\n\n` +
            `Booking: *${appt.booking_id}*\n` +
            `Patient: ${appt.patient_name || appt.patient_phone} · ${appt.patient_phone}\n` +
            `Dr. ${appt.doctor_name}\n` +
            `📅 ${dateLabel} at ${String(appt.appointment_time || '').slice(0, 5)}\n` +
            `📝 ${appt.cancellation_reason || 'No reason given'}\n` +
            `By: ${req.user.role}`
          );
        } catch (_) {}
      })();
    }
  } catch (err) { handleError(res, err); }
});

// ── PRINTABLE RECEIPT (A2) ────────────────────────────────────
router.get('/appointments/:id/receipt', validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      SELECT a.booking_id, a.appointment_date, a.appointment_time, a.status,
             a.visit_type, a.notes, a.note_category, a.created_at,
             p.name AS patient_name, p.phone AS patient_phone, p.email AS patient_email,
             p.date_of_birth, p.gender,
             d.name AS doctor_name, d.qualification, d.consultation_fee,
             dep.name AS treatment_type,
             h.name AS clinic_name, h.address AS clinic_address, h.phone AS clinic_phone
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      LEFT JOIN departments dep ON dep.id=d.department_id
      JOIN hospitals h ON h.id=a.hospital_id
      WHERE a.id=$1
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    const a = r.rows[0];
    // Escape HTML entities to prevent XSS from user-supplied data (names, addresses etc.)
    const he = (str) => String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
    const apptDate = a.appointment_date ? String(a.appointment_date).slice(0, 10) : '—';
    const apptTime = a.appointment_time ? String(a.appointment_time).slice(0, 5) : '—';
    const generatedOn = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const statusColors = { confirmed: '#065f46|#d1fae5', completed: '#1e40af|#dbeafe', cancelled: '#991b1b|#fee2e2', no_show: '#4b5563|#f3f4f6' };
    const [statusTxt, statusBg] = (statusColors[a.status] || '#4b5563|#f3f4f6').split('|');
    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Receipt · ${he(a.booking_id)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;padding:40px;max-width:680px;margin:0 auto}
.hdr{text-align:center;border-bottom:2.5px solid #0066cc;padding-bottom:18px;margin-bottom:22px}
.clinic{font-size:22px;font-weight:700;color:#0066cc}
.sub{font-size:12px;color:#888;margin-top:3px;letter-spacing:.5px;text-transform:uppercase}
.bid{background:#f0f7ff;border:1px solid #b3cfe8;border-radius:8px;padding:10px 18px;text-align:center;margin:16px 0}
.bid span{font-size:20px;font-weight:700;color:#0066cc;letter-spacing:2px}
.sec{margin:18px 0}.sec-title{font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-weight:600}
.row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f0f0f0}
.row:last-child{border-bottom:none}.lbl{color:#777;font-size:13px}.val{font-size:13px;font-weight:500;text-align:right;max-width:55%}
.total{display:flex;justify-content:space-between;padding:14px 0;border-top:2px solid #1a1a1a;margin-top:6px}
.t-lbl{font-size:15px;font-weight:700}.t-val{font-size:18px;font-weight:700;color:#0066cc}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;text-transform:uppercase;color:${statusTxt};background:${statusBg}}
.ftr{text-align:center;margin-top:28px;padding-top:14px;border-top:1px solid #eee;color:#aaa;font-size:11px}
@media print{body{padding:20px}}</style></head>
<body>
<div class="hdr">
  <div class="clinic">🦷 ${he(a.clinic_name)}</div>
  ${a.clinic_address ? `<div style="font-size:12px;color:#666;margin-top:3px">${he(a.clinic_address)}</div>` : ''}
  ${a.clinic_phone ? `<div style="font-size:12px;color:#666">📞 ${he(a.clinic_phone)}</div>` : ''}
  <div class="sub">Appointment Receipt</div>
</div>
<div class="bid">Booking ID: <span>${he(a.booking_id)}</span></div>
<div class="sec">
  <div class="sec-title">Patient</div>
  <div class="row"><span class="lbl">Name</span><span class="val">${he(a.patient_name) || '—'}</span></div>
  <div class="row"><span class="lbl">Phone</span><span class="val">${he(a.patient_phone)}</span></div>
  ${a.patient_email ? `<div class="row"><span class="lbl">Email</span><span class="val">${he(a.patient_email)}</span></div>` : ''}
  ${a.gender ? `<div class="row"><span class="lbl">Gender</span><span class="val" style="text-transform:capitalize">${he(a.gender)}</span></div>` : ''}
</div>
<div class="sec">
  <div class="sec-title">Appointment</div>
  <div class="row"><span class="lbl">Dentist</span><span class="val">Dr. ${he(a.doctor_name)}${a.qualification ? ` · ${he(a.qualification)}` : ''}</span></div>
  <div class="row"><span class="lbl">Treatment</span><span class="val">${he(a.treatment_type) || '—'}</span></div>
  <div class="row"><span class="lbl">Date</span><span class="val">${he(apptDate)}</span></div>
  <div class="row"><span class="lbl">Time</span><span class="val">${he(apptTime)}</span></div>
  <div class="row"><span class="lbl">Status</span><span class="val"><span class="badge">${he((a.status || '').replace('_', ' '))}</span></span></div>
  ${a.notes ? `<div class="row"><span class="lbl">Notes</span><span class="val">${he(a.notes)}</span></div>` : ''}
</div>
<div class="total"><span class="t-lbl">Consultation Fee</span><span class="t-val">₹${parseInt(a.consultation_fee) || 0}</span></div>
<div class="ftr">
  <p>Generated on ${he(generatedOn)}</p>
  <p style="margin-top:4px">Thank you for choosing ${he(a.clinic_name)} 😊</p>
</div>
<script>window.onload=function(){window.print();}</script>
</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Relax the API-wide helmet CSP for this HTML page only: the receipt uses an
    // inline <style> block and an inline window.print() script, which the global
    // script-src/style-src 'self' policy would block (unstyled page, no auto-print).
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:");
    res.send(html);
  } catch (err) { handleError(res, err); }
});

// ── CREATE APPOINTMENT (walk-in) ──────────────────────────────
router.post('/appointments', adminOnly, validate(schemas.createAppointment), async (req, res) => {
  try {
    const { patient_phone: rawPhone, patient_name, doctor_id, hospital_id, slot_id, appointment_date, appointment_time, visit_type, notes } = req.body;
    // Strip leading '+' to match DB CHECK constraint: phone ~ '^[0-9]{7,20}$'
    const patient_phone = rawPhone.replace(/^\+/, '');
    const s = req.tenant.schema_name;

    // Reject appointments in the past — IST "today", matching the Joi validator
    // (UTC is a day behind IST between 18:30 and 23:59 UTC, which let admins
    // create appointments dated yesterday).
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
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

    // Plan quota: block walk-in creation once the monthly allowance is used up
    const { insertAppointmentWithRetry, checkMonthlyQuota } = require('../services/bookingCore');
    const quota = await checkMonthlyQuota(req.tenant);
    if (!quota.allowed) {
      return res.status(403).json({
        error: `Monthly appointment limit reached for your plan (${quota.used}/${quota.limit}). Upgrade to book more appointments.`,
        quota_exceeded: true,
      });
    }

    // Single transaction: patient upsert + slot lock + appointment insert.
    // Without this, a failed INSERT (e.g. booking-ID collision) would leave the
    // slot orphaned in 'booked' status with no appointment attached.
    let bookingResult;
    try {
      bookingResult = await tenantTransaction(s, async (client) => {
        // patients.phone is intentionally NON-unique (family booking: one phone can
        // have several patient profiles), so ON CONFLICT (phone) is not usable — it
        // would raise 42P10. Reuse an existing profile for this phone (matching the
        // supplied name when present) and bump visit_count; otherwise create a new one.
        let patientId;
        const existingPatient = await client.query(
          `SELECT id FROM patients
           WHERE phone=$1 AND deleted_at IS NULL
             AND ($2::text IS NULL OR lower(name)=lower($2))
           ORDER BY created_at ASC LIMIT 1`,
          [patient_phone, patient_name || null]);
        if (existingPatient.rows[0]) {
          patientId = existingPatient.rows[0].id;
          await client.query(
            `UPDATE patients SET name=COALESCE($2, name), visit_count=visit_count+1, updated_at=NOW() WHERE id=$1`,
            [patientId, patient_name || null]);
        } else {
          const patientR = await client.query(
            `INSERT INTO patients (phone, name, visit_count) VALUES ($1,$2,1) RETURNING id`,
            [patient_phone, patient_name || null]);
          patientId = patientR.rows[0].id;
        }

        if (slot_id) {
          // Verify the slot belongs to the specified doctor AND hospital, and that
          // its date/time actually match the requested appointment_date/time —
          // otherwise the appointment record (used by reminders and the dashboard)
          // could disagree with the slot that was locked.
          const slotR = await client.query(
            `UPDATE time_slots SET status='booked'
             WHERE id=$1 AND status='available' AND doctor_id=$2 AND hospital_id=$3
               AND slot_date=$4::date AND start_time=$5::time
             RETURNING id`,
            [slot_id, doctor_id, hospital_id, appointment_date, appointment_time]);
          if (!slotR.rows[0]) {
            const err = new Error('SLOT_TAKEN');
            err.code = 'SLOT_TAKEN';
            throw err;
          }
        }

        return insertAppointmentWithRetry(client, {
          patientId,
          doctorId: doctor_id,
          hospitalId: hospital_id,
          slotId: slot_id || null,
          appointmentDate: appointment_date,
          appointmentTime: appointment_time,
          visitType: visit_type || 'in_person',
          notes: notes || null,
        });
      });
    } catch (txErr) {
      if (txErr.code === 'SLOT_TAKEN') {
        return res.status(409).json({ error: 'Slot is no longer available, does not belong to the specified doctor/hospital, or does not match the requested date and time' });
      }
      throw txErr;
    }
    const { bookingId, row: appointment } = bookingResult;
    await writeAuditLog(s, req.user.id, req.user.role, 'CREATE_APPOINTMENT', 'appointment', appointment.id,
      null, { booking_id: bookingId, doctor_id, appointment_date }, req.ip);
    res.status(201).json({ appointment, booking_id: bookingId });
    // Fire-and-forget WhatsApp alert to admin for walk-in booking
    (async () => {
      try {
        const { notifyAdminWhatsApp } = require('../services/bot/utils');
        const { format, parseISO } = require('date-fns');
        const detailR = await tenantQuery(s,
          `SELECT d.name as doctor_name, h.name as hospital_name
           FROM doctors d JOIN hospitals h ON h.id = d.hospital_id
           WHERE d.id = $1`, [doctor_id]);
        if (!detailR.rows[0]) return;
        let dateLabel = appointment_date;
        try { dateLabel = format(parseISO(appointment_date), 'EEE, d MMM yyyy'); } catch {}
        await notifyAdminWhatsApp(s, req.tenant,
          `🆕 *Walk-in Booking Created*\n\n` +
          `Booking: *${bookingId}*\n` +
          `Patient: ${patient_name || patient_phone} · ${patient_phone}\n` +
          `Dr. ${detailR.rows[0].doctor_name}\n` +
          `📅 ${dateLabel} at ${(appointment_time || '').slice(0, 5)}\n` +
          `🦷 ${detailR.rows[0].hospital_name}`
        );
      } catch (_) {}
    })();
  } catch (err) { handleError(res, err); }
});

// ── FOLLOW-UP SCHEDULING ──────────────────────────────────────
router.post('/appointments/:id/followup', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { follow_up_days = 14, doctor_id, notes } = req.body;
    if (follow_up_days < 1 || follow_up_days > 365) {
      return res.status(400).json({ error: 'follow_up_days must be between 1 and 365' });
    }
    if (doctor_id && !UUID_RE.test(doctor_id)) {
      return res.status(400).json({ error: 'Invalid doctor_id format' });
    }
    const s = req.tenant.schema_name;

    // Get original appointment
    const origR = await tenantQuery(s, `
      SELECT a.*, d.consultation_fee, d.pricing_rules FROM appointments a
      JOIN doctors d ON d.id = a.doctor_id
      WHERE a.id = $1
    `, [req.params.id]);
    if (!origR.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    const orig = origR.rows[0];

    if (orig.follow_up_appointment_id) {
      return res.status(409).json({ error: 'Follow-up already scheduled for this appointment' });
    }

    const targetDoctorId = doctor_id || orig.doctor_id;
    // The target doctor may differ from the original's — verify they're active
    // and use THEIR hospital for the new appointment (the original's hospital_id
    // is wrong when the follow-up doctor practices at another branch).
    const targetDocR = await tenantQuery(s,
      `SELECT id, hospital_id FROM doctors WHERE id=$1 AND is_active=true`, [targetDoctorId]);
    if (!targetDocR.rows[0]) {
      return res.status(400).json({ error: 'Follow-up doctor not found or is deactivated' });
    }
    // parseISO, not new Date(): appointment_date is a "YYYY-MM-DD" string (see
    // the DATE type parser in db/index.js), which new Date() reads as UTC
    // midnight while format() renders in server-local time — off by one day on
    // any host that isn't UTC. Every other date site in the codebase uses parseISO.
    const { addDays, format, parseISO } = require('date-fns');
    const followUpDate = format(addDays(parseISO(String(orig.appointment_date).slice(0, 10)), follow_up_days), 'yyyy-MM-dd');

    // Plan quota: the walk-in route enforces this before creating an appointment —
    // without the same check here, "schedule follow-up" was an unmetered back door
    // around the monthly appointment cap.
    const { insertAppointmentWithRetry, checkMonthlyQuota } = require('../services/bookingCore');
    const quota = await checkMonthlyQuota(req.tenant);
    if (!quota.allowed) {
      return res.status(403).json({
        error: `Monthly appointment limit reached for your plan (${quota.used}/${quota.limit}). Upgrade to book more appointments.`,
        quota_exceeded: true,
      });
    }

    // Single transaction: find + lock slot, insert follow-up, link to original.
    // Prevents an orphaned 'booked' slot if any later statement fails.
    let followUp;
    try {
      followUp = await tenantTransaction(s, async (client) => {
        // Lock the ORIGINAL appointment first — every multi-table writer must
        // take locks in appointment → slot order (the bot reschedule does), or
        // two of them meeting on the same rows deadlock.
        const lockedOrig = await client.query(
          `SELECT id, follow_up_appointment_id FROM appointments WHERE id=$1 FOR UPDATE`, [req.params.id]);
        // Re-check under the row lock: the outer check above ran before the
        // transaction started, so two near-simultaneous requests can both pass
        // it and both reach here. Only the first to acquire the lock may proceed.
        if (lockedOrig.rows[0]?.follow_up_appointment_id) {
          const err = new Error('FOLLOWUP_EXISTS');
          err.code = 'FOLLOWUP_EXISTS';
          throw err;
        }
        // Lock the first available slot on or after the follow-up date.
        // FOR UPDATE SKIP LOCKED serialises against concurrent bookers without
        // blocking. Skip clinic-holiday dates — holiday creation doesn't block
        // already-generated slots, so they're still 'available' here.
        // GREATEST(followUpDate, IST today): when the ORIGINAL appointment is
        // old enough that original_date + follow_up_days is already in the past,
        // a plain `slot_date >= $2` would happily book a slot that has gone by.
        const slotR = await client.query(`
          SELECT id, hospital_id, slot_date::text, start_time::text
          FROM time_slots ts
          WHERE doctor_id=$1
            AND slot_date >= GREATEST($2::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
            AND (slot_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                 OR start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time)
            AND status='available'
            AND NOT EXISTS (
              SELECT 1 FROM clinic_holidays ch
              WHERE ch.holiday_date = ts.slot_date
                AND (ch.hospital_id = ts.hospital_id OR ch.hospital_id IS NULL)
            )
          ORDER BY slot_date, start_time
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `, [targetDoctorId, followUpDate]);
        if (!slotR.rows[0]) {
          const err = new Error('NO_SLOT');
          err.code = 'NO_SLOT';
          throw err;
        }
        const slot = slotR.rows[0];
        // Guard with AND status='available', matching the booking-integrity
        // pattern used elsewhere — currently redundant with the FOR UPDATE SKIP
        // LOCKED lock above, but keeps this statement safe on its own if the
        // locking logic above it is ever refactored.
        const slotUpdateR = await client.query(
          `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available'`, [slot.id]);
        if (slotUpdateR.rowCount === 0) {
          const err = new Error('SLOT_TAKEN');
          err.code = 'SLOT_TAKEN';
          throw err;
        }

        const { bookingId, row } = await insertAppointmentWithRetry(client, {
          patientId: orig.patient_id,
          doctorId: targetDoctorId,
          hospitalId: slot.hospital_id || targetDocR.rows[0].hospital_id,
          slotId: slot.id,
          appointmentDate: slot.slot_date,
          appointmentTime: slot.start_time,
          visitType: orig.visit_type,
          notes: notes || 'Follow-up appointment',
        });

        // Link back to original
        await client.query(
          `UPDATE appointments SET follow_up_appointment_id=$1, follow_up_days=$2 WHERE id=$3`,
          [row.id, follow_up_days, req.params.id]);

        return { bookingId, row, slot };
      });
    } catch (txErr) {
      if (txErr.code === 'NO_SLOT') {
        return res.status(404).json({ error: `No available slots found after ${followUpDate} for the selected doctor` });
      }
      if (txErr.code === 'SLOT_TAKEN') {
        return res.status(409).json({ error: 'Slot is no longer available — please retry' });
      }
      if (txErr.code === 'FOLLOWUP_EXISTS') {
        return res.status(409).json({ error: 'Follow-up already scheduled for this appointment' });
      }
      throw txErr;
    }

    await writeAuditLog(s, req.user.id, req.user.role, 'CREATE_FOLLOWUP', 'appointment', followUp.row.id,
      null, { original_id: req.params.id, follow_up_days, booking_id: followUp.bookingId }, req.ip);

    res.json({
      follow_up_appointment: followUp.row,
      booking_id: followUp.bookingId,
      date: followUp.slot.slot_date,
      time: followUp.slot.start_time,
    });
  } catch (err) { handleError(res, err, 'POST /appointments/:id/followup'); }
});

// ── SMS FALLBACK ──────────────────────────────────────────────
router.post('/appointments/:id/sms', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      SELECT a.*, p.phone, p.name as patient_name, d.name as doctor_name, h.name as hospital_name
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      JOIN hospitals h ON h.id=a.hospital_id
      WHERE a.id=$1
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Appointment not found' });
    const appt = r.rows[0];
    if (appt.sms_fallback_sent) {
      return res.status(409).json({ error: 'SMS already sent for this appointment' });
    }
    const smsService = require('../services/sms');
    const { format, parseISO } = require('date-fns');
    let dateStr = appt.appointment_date;
    try { dateStr = format(parseISO(String(appt.appointment_date).slice(0, 10)), 'EEE, d MMM yyyy'); } catch {}
    const sent = await smsService.sendBookingConfirmationSMS(appt.phone, {
      bookingId: appt.booking_id,
      doctorName: appt.doctor_name,
      date: dateStr,
      time: (appt.appointment_time || '').slice(0, 5),
      hospitalName: appt.hospital_name,
    });
    if (sent) {
      await tenantQuery(s, `UPDATE appointments SET sms_fallback_sent=true WHERE id=$1`, [appt.id]);
      res.json({ success: true, message: 'SMS sent successfully' });
    } else {
      res.status(503).json({ error: 'SMS service not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.' });
    }
  } catch (err) { handleError(res, err, 'POST /appointments/:id/sms'); }
});

module.exports = router;
