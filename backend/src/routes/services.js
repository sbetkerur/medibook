'use strict';
const router = require('express').Router();
const { tenantQuery, tenantTransaction } = require('../db');
const { adminOnly, writeAuditLog } = require('./adminHelpers');
const { handleError, validateUUID, UUID_RE } = require('../utils/errors');
const logger = require('../utils/logger');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const rateLimit = require('express-rate-limit');

// Auth + tenant middleware applied once in index.js for /api/admin and /api/v1/admin
router.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

// ── SERVICE CATALOG (A1) ──────────────────────────────────────

router.get('/services', async (req, res) => {
  try {
    const { hospital_id, category, include_inactive } = req.query;
    if (hospital_id && !UUID_RE.test(hospital_id)) {
      return res.status(400).json({ error: 'Invalid hospital_id format' });
    }
    const where = ['1=1'];
    const params = [];
    if (hospital_id) { params.push(hospital_id); where.push(`hospital_id=$${params.length}`); }
    if (!include_inactive) where.push('is_active=true');
    if (category) { params.push(category); where.push(`category=$${params.length}`); }
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT * FROM clinic_services WHERE ${where.join(' AND ')} ORDER BY category NULLS LAST, name`,
      params);
    res.json({ services: r.rows });
  } catch (err) { handleError(res, err); }
});

router.post('/services', adminOnly, async (req, res) => {
  try {
    const { name, description, category, duration_minutes, price, hospital_id } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (hospital_id && !UUID_RE.test(hospital_id)) {
      return res.status(400).json({ error: 'Invalid hospital_id format' });
    }
    const r = await tenantQuery(req.tenant.schema_name,
      `INSERT INTO clinic_services (hospital_id, name, description, category, duration_minutes, price)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [hospital_id || null, name.trim(), description || null, category || null,
       parseInt(duration_minutes) || 30, parseInt(price) || 0]);
    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role, 'CREATE_SERVICE',
      'clinic_service', r.rows[0].id, null, { name }, req.ip);
    res.status(201).json({ service: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.patch('/services/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { name, description, category, duration_minutes, price, is_active } = req.body;
    if (name !== undefined && typeof name !== 'string') {
      return res.status(400).json({ error: 'name must be a string' });
    }
    const sets = [], params = [];
    if (name !== undefined)             { params.push(name.trim());             sets.push(`name=$${params.length}`); }
    if (description !== undefined)      { params.push(description);             sets.push(`description=$${params.length}`); }
    if (category !== undefined)         { params.push(category);                sets.push(`category=$${params.length}`); }
    if (duration_minutes !== undefined) { params.push(parseInt(duration_minutes) || 30); sets.push(`duration_minutes=$${params.length}`); }
    if (price !== undefined)            { params.push(parseInt(price) || 0);    sets.push(`price=$${params.length}`); }
    if (is_active !== undefined)        { params.push(Boolean(is_active));      sets.push(`is_active=$${params.length}`); }
    if (!sets.length) return res.json({ message: 'nothing to update' });
    params.push(req.params.id);
    const r = await tenantQuery(req.tenant.schema_name,
      `UPDATE clinic_services SET ${sets.join(',')} WHERE id=$${params.length} RETURNING *`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Service not found' });
    res.json({ service: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.delete('/services/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    await tenantQuery(req.tenant.schema_name,
      `UPDATE clinic_services SET is_active=false WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── CLINIC HOLIDAYS (A4) ──────────────────────────────────────

router.get('/holidays', async (req, res) => {
  try {
    const { hospital_id, from, to } = req.query;
    // Same validation POST /holidays already does. Unvalidated, these three go
    // straight into $N and PostgreSQL raises a cast error on anything that
    // isn't a uuid/date (?from=x), which handleError reports as a generic 500 —
    // no injection, but a user-input typo shows up in the logs looking exactly
    // like a server fault and masks real ones.
    if (hospital_id && !UUID_RE.test(hospital_id)) {
      return res.status(400).json({ error: 'Invalid hospital_id format' });
    }
    for (const [key, value] of [['from', from], ['to', to]]) {
      if (value && (!DATE_RE.test(value) || isNaN(Date.parse(value)))) {
        return res.status(400).json({ error: `${key} must be a valid YYYY-MM-DD date` });
      }
    }
    const where = ['1=1'];
    const params = [];
    if (hospital_id) { params.push(hospital_id); where.push(`hospital_id=$${params.length}`); }
    if (from) { params.push(from); where.push(`holiday_date >= $${params.length}`); }
    if (to)   { params.push(to);   where.push(`holiday_date <= $${params.length}`); }
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT * FROM clinic_holidays WHERE ${where.join(' AND ')} ORDER BY holiday_date`, params);
    res.json({ holidays: r.rows });
  } catch (err) { handleError(res, err); }
});

router.post('/holidays', adminOnly, async (req, res) => {
  try {
    const { holiday_date, name, hospital_id } = req.body;
    if (!holiday_date || !name?.trim()) {
      return res.status(400).json({ error: 'holiday_date and name are required' });
    }
    if (!DATE_RE.test(holiday_date) || isNaN(Date.parse(holiday_date))) {
      return res.status(400).json({ error: 'holiday_date must be a valid YYYY-MM-DD date' });
    }
    if (hospital_id && !UUID_RE.test(hospital_id)) {
      return res.status(400).json({ error: 'Invalid hospital_id format' });
    }
    // INSERT + slot block in ONE transaction, exactly like POST /doctors/:id/leaves.
    // Recording the holiday without blocking its slots is the worst of the two
    // outcomes: the clinic sees the day marked closed on the dashboard while the
    // bot keeps handing those slots out, and nothing ever reconciles the two
    // (the nightly generator only INSERTs ... ON CONFLICT DO NOTHING).
    const { holiday, blocked } = await tenantTransaction(req.tenant.schema_name, async (client) => {
      const ins = await client.query(
        `INSERT INTO clinic_holidays (hospital_id, holiday_date, name, created_by_user_id)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [hospital_id || null, holiday_date, name.trim(), req.user.id]);
      // Mark blocked_by_holiday so DELETE /holidays/:id releases only these —
      // never a doctor's leave days and never slots an admin blocked by hand.
      // A clinic-wide holiday (hospital_id IS NULL) blocks every branch.
      const upd = await client.query(
        `UPDATE time_slots SET status='blocked', blocked_by_holiday=true
         WHERE slot_date=$1 AND status='available'
           AND ($2::uuid IS NULL OR hospital_id=$2)
         RETURNING id`,
        [holiday_date, hospital_id || null]);
      return { holiday: ins.rows[0], blocked: upd.rows.length };
    });
    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role, 'CREATE_HOLIDAY',
      'clinic_holiday', holiday.id, null, { holiday_date, name, slots_blocked: blocked }, req.ip);
    // Already-confirmed appointments are untouched (blocking only affects
    // 'available' slots) — surface the count the same way the leave route does,
    // so staff know patients still need rescheduling by hand. Non-fatal, for the
    // same reason it is there: the holiday has already COMMITTED, so throwing a
    // 500 out of an advisory count would report a success as a failure and make
    // the retry collide with its own row (409).
    let affected = 0;
    try {
      const bookedR = await tenantQuery(req.tenant.schema_name,
        `SELECT COUNT(*)::int AS n FROM appointments
         WHERE status='confirmed' AND appointment_date=$1
           AND ($2::uuid IS NULL OR hospital_id=$2)`,
        [holiday_date, hospital_id || null]);
      affected = bookedR.rows[0]?.n || 0;
    } catch (cntErr) {
      logger.warn('Holiday: affected-appointment lookup failed', { error: cntErr.message });
    }
    res.status(201).json({
      holiday, slots_blocked: blocked, affected_appointments: affected,
      ...(affected > 0 && {
        warning: `${affected} confirmed appointment(s) already exist on ${holiday_date}. Reschedule or cancel them — patients have NOT been notified automatically.`,
      }),
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A holiday already exists for that date' });
    handleError(res, err);
  }
});

router.delete('/holidays/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    // DELETE + release in one transaction, for the mirror-image reason the
    // create path needs one: a delete that commits without the release leaves
    // the day permanently unbookable with no holiday row left to explain why.
    const result = await tenantTransaction(req.tenant.schema_name, async (client) => {
      const del = await client.query(
        `DELETE FROM clinic_holidays WHERE id=$1 RETURNING *`, [req.params.id]);
      if (!del.rows[0]) return null;
      const { holiday_date, hospital_id } = del.rows[0];
      // Release only what THIS holiday blocked:
      //  • blocked_by_holiday — not slots an admin blocked by hand, and not
      //    blocked_by_leave slots (belt and braces: the leave/holiday UPDATEs
      //    only touch 'available' rows, so the two flags never co-occur).
      //  • still-standing holidays — a clinic-wide holiday and a branch-specific
      //    one can cover the same date; removing one must not re-open the other.
      //    Runs after the DELETE inside the same transaction, so the row just
      //    removed is already gone from this check.
      //  • doctor leaves — a leave declared AFTER the holiday could not block
      //    the already-'blocked' slots, so without this the holiday's removal
      //    would hand out a day the dentist is away.
      const rel = await client.query(
        `UPDATE time_slots SET status='available', blocked_by_holiday=false
         WHERE slot_date=$1 AND status='blocked'
           AND blocked_by_holiday=true AND blocked_by_leave IS NOT TRUE
           AND ($2::uuid IS NULL OR hospital_id=$2)
           AND NOT EXISTS (
             SELECT 1 FROM clinic_holidays ch
             WHERE ch.holiday_date = time_slots.slot_date
               AND (ch.hospital_id IS NULL OR ch.hospital_id = time_slots.hospital_id)
           )
           AND NOT EXISTS (
             SELECT 1 FROM doctor_leaves dl
             WHERE dl.doctor_id = time_slots.doctor_id AND dl.leave_date = time_slots.slot_date
           )
         RETURNING id`,
        [holiday_date, hospital_id]);
      return { holiday: del.rows[0], released: rel.rows.length };
    });
    if (!result) return res.status(404).json({ error: 'Holiday not found' });
    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role, 'DELETE_HOLIDAY',
      'clinic_holiday', req.params.id, result.holiday, { slots_released: result.released }, req.ip);
    res.json({ success: true, slots_released: result.released });
  } catch (err) { handleError(res, err); }
});

module.exports = router;
