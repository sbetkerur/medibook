'use strict';
/**
 * Tenant-initiated account closure — mounted under /api/admin, so auth + tenant
 * + read-only middleware already ran (the demo clinic can never reach the POST
 * routes: enforceReadOnlyTenant 403s every non-GET).
 *
 * A clinic admin requests deletion; ACCOUNT_DELETION_GRACE_DAYS later
 * (default 14) jobs/accountDeletion.js DROPs the tenant schema and deletes the
 * `tenants` row. Fully cancellable until then. Nothing is scrubbed during the
 * grace window — the clinic keeps working normally so a mis-click or a
 * change of heart costs nothing.
 *
 * Deliberately requires the admin's own password AND a typed confirmation
 * string: this is the single most destructive action a tenant can take, and
 * the ≤30-day encrypted backups are the only recovery path afterwards.
 */
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, tenantQuery } = require('../db');
const { handleError } = require('../utils/errors');
const { adminOnly } = require('./adminHelpers');
const logger = require('../utils/logger');

const GRACE_DAYS = Math.max(1, parseInt(process.env.ACCOUNT_DELETION_GRACE_DAYS || '14', 10) || 14);

router.get('/account/deletion', async (req, res) => {
  try {
    const r = await query(
      `SELECT deletion_requested_at, deletion_scheduled_for, deletion_requested_by FROM tenants WHERE id=$1`,
      [req.tenant.id]);
    const t = r.rows[0] || {};
    res.json({
      pending: !!t.deletion_requested_at,
      requested_at: t.deletion_requested_at || null,
      scheduled_for: t.deletion_scheduled_for || null,
      grace_days: GRACE_DAYS,
    });
  } catch (err) { handleError(res, err); }
});

router.post('/account/deletion', adminOnly, async (req, res) => {
  try {
    const password = String(req.body?.password || '');
    const confirm = String(req.body?.confirm || '');
    if (confirm !== 'DELETE') {
      return res.status(400).json({ error: 'Type DELETE to confirm you want to close this clinic account.' });
    }
    if (!password) return res.status(400).json({ error: 'Enter your password to confirm.' });

    const uR = await tenantQuery(req.tenant.schema_name,
      `SELECT password_hash FROM users WHERE id=$1 AND is_active=true`, [req.user.id]);
    if (!uR.rows[0]) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(password, uR.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'That password is not correct.' });

    const cur = await query(`SELECT deletion_requested_at, slug, schema_name, signup_source FROM tenants WHERE id=$1`, [req.tenant.id]);
    if (cur.rows[0]?.deletion_requested_at) {
      return res.json({ pending: true, already: true });
    }

    const r = await query(`
      UPDATE tenants
         SET deletion_requested_at = NOW(),
             deletion_scheduled_for = NOW() + make_interval(days => $2::int),
             deletion_requested_by = $3
       WHERE id=$1
       RETURNING deletion_requested_at, deletion_scheduled_for
    `, [req.tenant.id, GRACE_DAYS, req.user.id]);

    // Stop the subscription renewing into a clinic that's closing — the
    // dunning cron issues the actual Razorpay cancel at cycle end.
    await query(
      `UPDATE tenant_billing SET cancel_at_period_end=true, cancel_reason=COALESCE(cancel_reason,'account_deletion'), updated_at=NOW() WHERE tenant_id=$1`,
      [req.tenant.id]).catch(() => {});

    await query(`
      INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, new_values, ip_address)
      VALUES ($1,$2,'ACCOUNT_DELETION_REQUESTED','tenant',$3,$4,$5)
    `, [req.user.id, req.user.role, req.tenant.id,
        JSON.stringify({ scheduled_for: r.rows[0].deletion_scheduled_for, grace_days: GRACE_DAYS }), req.ip]).catch(() => {});

    logger.warn('Account deletion requested', { slug: cur.rows[0].slug, by: req.user.email, scheduled_for: r.rows[0].deletion_scheduled_for });

    // Tell every admin (the requester may not be the owner) on WhatsApp.
    try {
      const { notifyAdminWhatsApp } = require('../services/bot/utils');
      const when = new Date(r.rows[0].deletion_scheduled_for).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      await notifyAdminWhatsApp(req.tenant.schema_name, req.tenant,
        `A request to permanently delete this MediBook clinic was made by ${req.user.email}. ` +
        `All data will be erased on ${when} unless the request is cancelled in Settings › Billing before then.`);
    } catch (_) {}

    res.json({
      pending: true,
      requested_at: r.rows[0].deletion_requested_at,
      scheduled_for: r.rows[0].deletion_scheduled_for,
      grace_days: GRACE_DAYS,
    });
  } catch (err) { handleError(res, err); }
});

router.post('/account/deletion/cancel', adminOnly, async (req, res) => {
  try {
    const cur = await query(`SELECT deletion_requested_at, slug FROM tenants WHERE id=$1`, [req.tenant.id]);
    if (!cur.rows[0]?.deletion_requested_at) {
      return res.status(400).json({ error: 'This clinic is not scheduled for deletion.' });
    }
    await query(`
      UPDATE tenants SET deletion_requested_at=NULL, deletion_scheduled_for=NULL, deletion_requested_by=NULL WHERE id=$1
    `, [req.tenant.id]);
    // Undo the subscription wind-down THIS flow started — but only that one.
    // POST /account/deletion sets cancel_at_period_end with
    // cancel_reason=COALESCE(cancel_reason,'account_deletion'), so a row still
    // reading 'account_deletion' was flagged BY the deletion request and must
    // be un-flagged with it; anything else is an independent billing cancel the
    // admin made separately and we leave it alone. Without this, cancelling a
    // deletion left the subscription winding down silently → past_due → suspended.
    await query(`
      UPDATE tenant_billing
         SET cancel_at_period_end=false, cancel_reason=NULL, updated_at=NOW()
       WHERE tenant_id=$1 AND cancel_at_period_end=true AND cancel_reason='account_deletion'
    `, [req.tenant.id]).catch(() => {});
    await query(`
      INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, ip_address)
      VALUES ($1,$2,'ACCOUNT_DELETION_CANCELLED','tenant',$3,$4)
    `, [req.user.id, req.user.role, req.tenant.id, req.ip]).catch(() => {});
    logger.info('Account deletion cancelled', { slug: cur.rows[0].slug, by: req.user.email });
    res.json({ pending: false });
  } catch (err) { handleError(res, err); }
});

module.exports = router;
