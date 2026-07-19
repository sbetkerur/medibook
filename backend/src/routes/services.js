'use strict';
const router = require('express').Router();
const { tenantQuery } = require('../db');
const { adminOnly, writeAuditLog } = require('./adminHelpers');
const { handleError } = require('../utils/errors');
const rateLimit = require('express-rate-limit');

// Auth + tenant middleware applied once in index.js for /api/admin and /api/v1/admin
router.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

// ── SERVICE CATALOG (A1) ──────────────────────────────────────

router.get('/services', async (req, res) => {
  try {
    const { hospital_id, category, include_inactive } = req.query;
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

router.patch('/services/:id', adminOnly, async (req, res) => {
  try {
    const { name, description, category, duration_minutes, price, is_active } = req.body;
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

router.delete('/services/:id', adminOnly, async (req, res) => {
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
    const r = await tenantQuery(req.tenant.schema_name,
      `INSERT INTO clinic_holidays (hospital_id, holiday_date, name, created_by_user_id)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [hospital_id || null, holiday_date, name.trim(), req.user.id]);
    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role, 'CREATE_HOLIDAY',
      'clinic_holiday', r.rows[0].id, null, { holiday_date, name }, req.ip);
    res.status(201).json({ holiday: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A holiday already exists for that date' });
    handleError(res, err);
  }
});

router.delete('/holidays/:id', adminOnly, async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `DELETE FROM clinic_holidays WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Holiday not found' });
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

module.exports = router;
