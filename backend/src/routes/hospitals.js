'use strict';
const router = require('express').Router();
const { tenantQuery } = require('../db');
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { validateUUID } = require('../utils/errors');
const { adminOnly, writeAuditLog } = require('./adminHelpers');

router.use(authMiddleware, tenantMiddleware);

// ── HOSPITALS ─────────────────────────────────────────────────
router.get('/hospitals', async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT * FROM hospitals WHERE is_active=true ORDER BY name`);
    res.json({ hospitals: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/hospitals/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
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
      const exists = await tenantQuery(s,
        `SELECT id, (SELECT COUNT(*) FROM appointments WHERE hospital_id=$1 AND status='confirmed' AND appointment_date >= CURRENT_DATE) as upcoming FROM hospitals WHERE id=$1`,
        [req.params.id]);
      if (!exists.rows[0]) return res.status(404).json({ error: 'Hospital not found' });
      const cnt = parseInt(exists.rows[0].upcoming);
      return res.status(409).json({
        error: `Cannot deactivate hospital — ${cnt} upcoming appointment(s) exist.`,
        upcoming_appointments: cnt,
      });
    }
    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_HOSPITAL', 'hospital', req.params.id,
      null, null, req.ip);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/departments/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { name, description } = req.body;
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      UPDATE departments SET name=COALESCE($1,name), description=COALESCE($2,description)
      WHERE id=$3 AND is_active=true RETURNING *
    `, [name || null, description || null, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Department not found' });
    res.json({ department: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
