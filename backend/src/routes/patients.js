'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { tenantQuery } = require('../db');
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const { validateUUID, handleError } = require('../utils/errors');
const { adminOnly, writeAuditLog } = require('./adminHelpers');

router.use(authMiddleware, tenantMiddleware);

const patientLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

// ── LIST PATIENTS ─────────────────────────────────────────────
router.get('/patients', patientLimiter, async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const safePage = Math.max(parseInt(page) || 1, 1);
    const s = req.tenant.schema_name;
    let where = '';
    let params = [];
    if (search) { params.push(`%${search}%`); where = ` WHERE name ILIKE $1 OR phone LIKE $1 OR email ILIKE $1`; }
    const countParams = [...params];
    params.push(25, (safePage - 1) * 25);
    const [r, countR] = await Promise.all([
      tenantQuery(s,
        `SELECT id, name, phone, email, gender, date_of_birth, visit_count, created_at FROM patients${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params),
      tenantQuery(s, `SELECT COUNT(*) FROM patients${where}`, countParams),
    ]);
    const total = parseInt(countR.rows[0]?.count || 0);
    res.json({ patients: r.rows, total, page: safePage, limit: 25, has_more: r.rows.length === 25 });
  } catch (err) { handleError(res, err); }
});

// ── GET PATIENT ───────────────────────────────────────────────
router.get('/patients/:id', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT id, name, phone, email, gender, date_of_birth, visit_count, medical_history, created_at, updated_at FROM patients WHERE id=$1`,
      [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    res.json({ patient: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

// ── PATIENT APPOINTMENTS ──────────────────────────────────────
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

// ── UPDATE PATIENT ────────────────────────────────────────────
router.patch('/patients/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { name, email, gender, date_of_birth } = req.body;
    const s = req.tenant.schema_name;
    const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (date_of_birth && !DOB_RE.test(date_of_birth)) return res.status(400).json({ error: 'date_of_birth must be YYYY-MM-DD' });
    const VALID_GENDERS = ['male', 'female', 'other'];
    if (gender && !VALID_GENDERS.includes(gender.toLowerCase())) {
      return res.status(400).json({ error: `gender must be one of: ${VALID_GENDERS.join(', ')}` });
    }
    const r = await tenantQuery(s, `
      UPDATE patients SET
        name=COALESCE($1,name), email=COALESCE($2,email),
        gender=COALESCE($3,gender), date_of_birth=COALESCE($4::date,date_of_birth), updated_at=NOW()
      WHERE id=$5 RETURNING id, name, phone, email, gender, date_of_birth, visit_count
    `, [name || null, email || null, gender || null, date_of_birth || null, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_PATIENT', 'patient', req.params.id,
      null, { name, email, gender }, req.ip);
    res.json({ patient: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

// ── DELETE PATIENT (anonymise) ────────────────────────────────
router.delete('/patients/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const upcoming = await tenantQuery(s,
      `SELECT COUNT(*) FROM appointments WHERE patient_id=$1 AND status='confirmed' AND appointment_date >= CURRENT_DATE`,
      [req.params.id]);
    if (parseInt(upcoming.rows[0].count) > 0) {
      return res.status(409).json({
        error: `Cannot delete patient — ${upcoming.rows[0].count} upcoming appointment(s) exist.`,
        upcoming_appointments: parseInt(upcoming.rows[0].count),
      });
    }
    const r = await tenantQuery(s, `
      UPDATE patients SET
        name='[Deleted]', email=NULL, date_of_birth=NULL, gender=NULL,
        medical_history='{}', updated_at=NOW()
      WHERE id=$1 RETURNING id
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_PATIENT', 'patient', req.params.id, null, null, req.ip);
    res.json({ success: true, message: 'Patient record anonymised (GDPR)' });
  } catch (err) { handleError(res, err); }
});

// ── MEDICAL HISTORY ───────────────────────────────────────────
router.get('/patients/:id/medical-history', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT id, name, phone, medical_history FROM patients WHERE id=$1`, [req.params.id]);
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
      `UPDATE patients SET medical_history=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, medical_history`,
      [JSON.stringify(medical_history), req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_MEDICAL_HISTORY', 'patient', req.params.id,
      null, { fields: Object.keys(medical_history) }, req.ip);
    res.json({ patient: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

module.exports = router;
