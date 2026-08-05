'use strict';
/**
 * Recall / recare — bringing a healthy patient back for their next check-up.
 *
 * The cheapest revenue a clinic has, and the one loop none of the other crons
 * covered: reminders are for appointments already booked, feedback is about a
 * visit that happened, and the treatment nudge only fires for a course a dentist
 * has already advised. Nothing brought back a patient with nothing wrong.
 *
 * Recalls are created automatically when a visit is completed (see
 * routes/appointments.js) and can be added or adjusted by hand here.
 */
const router = require('express').Router();
const { tenantQuery } = require('../db');
const { validateUUID, handleError, UUID_RE } = require('../utils/errors');
const { adminOnly, writeAuditLog } = require('./adminHelpers');
const { IST_TODAY_SQL } = require('../utils/dateTz');

const RECALL_STATUSES = ['due', 'booked', 'done', 'dismissed'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const RECALL_SELECT = `
  SELECT r.*, r.due_date::text AS due_date,
         p.name AS patient_name, p.phone AS patient_phone, p.opted_out,
         h.name AS hospital_name,
         (r.due_date <= ${IST_TODAY_SQL}) AS is_due_now
  FROM patient_recalls r
  JOIN patients p ON p.id = r.patient_id
  LEFT JOIN hospitals h ON h.id = r.hospital_id`;

router.get('/recalls', async (req, res) => {
  try {
    const { status = 'due', due_only } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const where = ['p.deleted_at IS NULL'];
    const params = [];
    if (status !== 'all') {
      const list = String(status).split(',').map(x => x.trim()).filter(Boolean);
      if (!list.every(x => RECALL_STATUSES.includes(x))) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${RECALL_STATUSES.join(', ')}` });
      }
      params.push(list);
      where.push(`r.status = ANY($${params.length})`);
    }
    if (due_only === 'true') where.push(`r.due_date <= ${IST_TODAY_SQL}`);

    params.push(limit);
    const r = await tenantQuery(req.tenant.schema_name, `
      ${RECALL_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY r.due_date
      LIMIT $${params.length}
    `, params);
    res.json({ recalls: r.rows });
  } catch (err) { handleError(res, err, 'GET /recalls'); }
});

router.post('/recalls', async (req, res) => {
  try {
    const { patient_id, due_date, reason, hospital_id } = req.body || {};
    const s = req.tenant.schema_name;
    if (!patient_id || !UUID_RE.test(patient_id)) return res.status(400).json({ error: 'Valid patient_id required' });
    if (!due_date || !DATE_RE.test(due_date)) return res.status(400).json({ error: 'due_date must be YYYY-MM-DD' });
    if (hospital_id && !UUID_RE.test(hospital_id)) return res.status(400).json({ error: 'Invalid hospital_id format' });

    const pat = await tenantQuery(s, `SELECT id FROM patients WHERE id=$1 AND deleted_at IS NULL`, [patient_id]);
    if (!pat.rows[0]) return res.status(400).json({ error: 'Patient not found' });

    // One open recall per patient per reason (partial unique index). A repeat
    // request moves the date rather than queueing a second identical reminder.
    const r = await tenantQuery(s, `
      INSERT INTO patient_recalls (patient_id, due_date, reason, hospital_id)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (patient_id, reason) WHERE status='due'
      DO UPDATE SET due_date=EXCLUDED.due_date, hospital_id=EXCLUDED.hospital_id, updated_at=NOW()
      RETURNING *
    `, [patient_id, due_date, (reason || 'Routine check-up').slice(0, 255), hospital_id || null]);
    res.json({ recall: r.rows[0] });
  } catch (err) { handleError(res, err, 'POST /recalls'); }
});

router.patch('/recalls/:id', validateUUID(), async (req, res) => {
  try {
    const { status, due_date, reason } = req.body || {};
    const s = req.tenant.schema_name;
    if (status && !RECALL_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${RECALL_STATUSES.join(', ')}` });
    }
    if (due_date && !DATE_RE.test(due_date)) return res.status(400).json({ error: 'due_date must be YYYY-MM-DD' });

    const updates = ['updated_at=NOW()'];
    const params = [];
    if (status) { params.push(status); updates.push(`status=$${params.length}`); }
    if (due_date) { params.push(due_date); updates.push(`due_date=$${params.length}`); }
    if (reason) { params.push(reason.slice(0, 255)); updates.push(`reason=$${params.length}`); }
    if (params.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    const r = await tenantQuery(s,
      `UPDATE patient_recalls SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Recall not found' });
    res.json({ recall: r.rows[0] });
  } catch (err) { handleError(res, err, 'PATCH /recalls/:id'); }
});

router.delete('/recalls/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `DELETE FROM patient_recalls WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Recall not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_RECALL', 'recall', req.params.id, null, null, req.ip);
    res.json({ success: true });
  } catch (err) { handleError(res, err, 'DELETE /recalls/:id'); }
});

module.exports = router;
