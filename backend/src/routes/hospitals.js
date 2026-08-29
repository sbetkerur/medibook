'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const { query, tenantQuery, tenantTransaction } = require('../db');
const { validate, schemas } = require('../middleware/validate');
const { validateUUID, handleError, UUID_RE } = require('../utils/errors');
const { adminOnly, writeAuditLog } = require('./adminHelpers');
const { IST_TODAY_SQL } = require('../utils/dateTz');

// Auth + tenant middleware applied once in index.js for /api/admin and /api/v1/admin

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

    // Branch quota. Professional is the per-branch tier (max_branches NULL =
    // unlimited); Starter and Growth are single-location and capped at 1, so a
    // second branch is the upgrade conversation. Same shape as the max_doctors
    // check in doctors.js: NULL means no cap, and the count runs inside the
    // transaction under an advisory lock so two concurrent creates can't both
    // read "0 branches" and both insert.
    const planR = await query(`SELECT max_branches FROM plans WHERE id=$1`, [req.tenant.plan]);
    const planLimit = planR.rows[0]?.max_branches ?? null;

    const lockId = crypto.createHash('sha256').update(`branch_quota:${s}`).digest().readInt32BE(0);

    const r = await tenantTransaction(s, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [lockId]);

      if (planLimit !== null) {
        // Matches how the billing page counts a live branch — a soft-deleted
        // one must not consume quota the clinic can't reclaim.
        const countR = await client.query(
          `SELECT COUNT(*) FROM hospitals WHERE is_active=true AND deleted_at IS NULL`);
        const current = parseInt(countR.rows[0].count);
        if (current >= planLimit) {
          const err = new Error(`QUOTA:${current}/${planLimit}`);
          err.isQuota = true;
          throw err;
        }
      }

      return client.query(
        `INSERT INTO hospitals (name, address, city, phone) VALUES ($1,$2,$3,$4) RETURNING *`,
        [name, address, city, phone]);
    });

    await writeAuditLog(s, req.user.id, req.user.role, 'CREATE_HOSPITAL', 'hospital', r.rows[0].id,
      null, { name, city }, req.ip);
    // Professional bills per branch — push the new count to Razorpay. Never
    // blocks the response; jobs/billingDunning.js reconciles quantity daily.
    require('../services/billing').syncSubscriptionQuantity(req.tenant.id)
      .catch(e => require('../utils/logger').warn('branch add: billing sync failed', { error: e.message }));
    res.json({ hospital: r.rows[0] });
  } catch (err) {
    if (err.isQuota) {
      const [cur, max] = err.message.replace('QUOTA:', '').split('/');
      return res.status(403).json({
        error: `Branch limit reached for your plan (${cur}/${max}). Upgrade to Professional to add more branches.`,
        quota_exceeded: true,
        code: 'PLAN_LIMIT',
        resource: 'branches',
        upgrade_to: 'professional',
      });
    }
    handleError(res, err);
  }
});

router.patch('/hospitals/:id', adminOnly, validateUUID(), validate(schemas.updateHospital), async (req, res) => {
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
    const r = await tenantQuery(s, `
      UPDATE hospitals SET is_active=false
      WHERE id=$1 AND is_active=true
        AND NOT EXISTS (
          SELECT 1 FROM appointments
          WHERE hospital_id=$1 AND status='confirmed' AND appointment_date >= ${IST_TODAY_SQL}
        )
      RETURNING id
    `, [req.params.id]);
    if (!r.rows[0]) {
      const exists = await tenantQuery(s,
        `SELECT id, (SELECT COUNT(*) FROM appointments WHERE hospital_id=$1 AND status='confirmed' AND appointment_date >= ${IST_TODAY_SQL}) as upcoming FROM hospitals WHERE id=$1`,
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
    // One fewer branch to bill for (Professional). Takes effect next cycle.
    require('../services/billing').syncSubscriptionQuantity(req.tenant.id)
      .catch(e => require('../utils/logger').warn('branch remove: billing sync failed', { error: e.message }));
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── DEPARTMENTS ───────────────────────────────────────────────
router.get('/departments', async (req, res) => {
  try {
    const { hospital_id } = req.query;
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
    const hospCheck = await tenantQuery(s, `SELECT id FROM hospitals WHERE id=$1 AND is_active=true AND deleted_at IS NULL`, [hospital_id]);
    if (!hospCheck.rows[0]) return res.status(400).json({ error: 'Hospital not found' });
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
      UPDATE departments SET name=COALESCE($1,name), description=COALESCE($2,description)
      WHERE id=$3 AND is_active=true RETURNING *
    `, [name || null, description || null, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Department not found' });
    // Audited like POST and DELETE on the same resource. Renaming a department
    // changes what patients are offered in the bot's treatment picker, and for
    // orthodontics it also changes the NUDGE CADENCE — isOrthodonticDepartment
    // is a keyword match on this very name, so renaming "Orthodontics" to
    // "Braces & Aligners" or to "Smile Correction" quietly moves every plan
    // under it between the monthly and the weekly chase.
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_DEPARTMENT', 'department', req.params.id,
      null, { name, description }, req.ip);
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

module.exports = router;
