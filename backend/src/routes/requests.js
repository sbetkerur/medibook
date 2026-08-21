'use strict';
/**
 * The queue of patients the bot could not finish serving.
 *
 * An Indian dental practice does not turn people away because the grid is
 * full — the receptionist finds them a time. These rows exist so that
 * conversation still happens when the patient met a bot instead of a person:
 * a full day, or a request to be rung back. Working the list is a front-desk
 * job, so reading and clearing are open to any signed-in staff member.
 *
 * Auth + tenant middleware are applied once in index.js — not re-applied here.
 */
const router = require('express').Router();
const { tenantQuery } = require('../db');
const { validateUUID, handleError } = require('../utils/errors');
const { writeAuditLog } = require('./adminHelpers');
const logger = require('../utils/logger');

const VALID_STATUS = ['open', 'handled', 'closed'];

// ── LIST ──────────────────────────────────────────────────────
router.get('/requests', async (req, res) => {
  try {
    const { status = 'open', kind } = req.query;
    if (!VALID_STATUS.includes(status) && status !== 'all') {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUS.join(', ')}, all` });
    }
    if (kind && !['appointment', 'callback'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be appointment or callback' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);

    const where = [];
    const params = [];
    if (status !== 'all') { params.push(status); where.push(`r.status = $${params.length}`); }
    if (kind) { params.push(kind); where.push(`r.kind = $${params.length}`); }
    params.push(limit);

    const r = await tenantQuery(req.tenant.schema_name, `
      SELECT r.id, r.kind, r.phone, r.patient_name, r.preferred_date::text, r.note,
             r.status, r.created_at, r.handled_at,
             d.name AS doctor_name, dep.name AS department_name, h.name AS hospital_name,
             p.name AS known_patient_name, p.visit_count
      FROM clinic_requests r
      LEFT JOIN doctors d      ON d.id = r.doctor_id
      LEFT JOIN departments dep ON dep.id = r.department_id
      LEFT JOIN hospitals h    ON h.id = r.hospital_id
      LEFT JOIN patients p     ON p.id = r.patient_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.created_at DESC
      LIMIT $${params.length}
    `, params);

    // The open count is what the dashboard badges, and it must not depend on
    // the filter the user happens to be looking at.
    const countR = await tenantQuery(req.tenant.schema_name,
      `SELECT COUNT(*)::int AS open FROM clinic_requests WHERE status='open'`);

    res.json({ requests: r.rows, open_count: countR.rows[0]?.open ?? 0 });
  } catch (err) { handleError(res, err); }
});

// ── CLEAR ONE ─────────────────────────────────────────────────
// Not adminOnly: clearing a callback you have just made is exactly the
// receptionist's job, and gating it behind the owner means the list is never
// cleared and stops being trusted.
router.patch('/requests/:id', validateUUID(), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['handled', 'closed', 'open'].includes(status)) {
      return res.status(400).json({ error: 'status must be handled, closed or open' });
    }
    const s = req.tenant.schema_name;
    // Reopening clears the record of who dealt with it, so the row never claims
    // to have been handled by someone who did not. Decided here rather than in a
    // CASE over $1: reusing one parameter as both the assigned value and a
    // comparand makes Postgres deduce conflicting types for it and reject the
    // statement outright.
    const reopening = status === 'open';
    const r = await tenantQuery(s, `
      UPDATE clinic_requests
         SET status = $1,
             handled_by_user_id = $2,
             handled_at = $3
       WHERE id = $4
       RETURNING id, kind, phone, status
    `, [status, reopening ? null : req.user.id, reopening ? null : new Date(), req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Request not found' });

    await writeAuditLog(s, req.user.id, req.user.role,
      'UPDATE_CLINIC_REQUEST', 'clinic_request', req.params.id, null, { status }, req.ip)
      .catch(e => logger.warn('Request audit failed', { error: e.message }));

    res.json({ request: r.rows[0] });
  } catch (err) {
    // idx_clinic_requests_one_open allows ONE open row per (phone, kind), so
    // re-opening an old request while a newer one is already open raises 23505
    // — which handleError turned into a bare 500. The receptionist needs to be
    // told that the newer request is the live one, not shown a server fault.
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'This patient already has a newer open request of the same kind. Clear that one first, or work from it instead.',
      });
    }
    handleError(res, err);
  }
});

module.exports = router;
