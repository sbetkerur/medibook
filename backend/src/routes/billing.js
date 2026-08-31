'use strict';
/**
 * Tenant-facing billing — mounted under /api/admin, so auth + tenant middleware
 * already ran in index.js.
 *
 * The self-serve trial is CARD-FREE. A clinic runs for `trial_end` days with no
 * card; to keep going it adds one here, which creates the Razorpay subscription
 * that bills from then on. jobs/billingDunning.js moves a clinic to `past_due`
 * when the trial lapses with no subscription attached, and the frontend reads
 * `paywalled` / `needs_card` from GET /admin/billing to show the banner.
 *
 * A super-admin-created clinic has no `tenant_billing` row and sees
 * "managed by MediBook" — nothing here 500s for it.
 */
const router = require('express').Router();
const crypto = require('crypto');
const { query, tenantQuery } = require('../db');
const { handleError, validateUUID } = require('../utils/errors');
const { validate, schemas } = require('../middleware/validate');
const { adminOnly } = require('./adminHelpers');
const razorpay = require('../services/razorpay');
const billingSvc = require('../services/billing');
const invoiceSvc = require('../services/invoice');
const logger = require('../utils/logger');
const { effectiveDoctorLimit, effectiveBranchLimit } = require('../utils/planLimits');

// GSTIN: 2-digit state code, 10-char PAN, 1 entity digit, 'Z', 1 checksum.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

function daysLeft(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

function shapeBilling(tenant, billing, plan) {
  const trialing = billing?.subscription_status === 'trialing' && !billing?.razorpay_subscription_id;
  const trialDaysLeft = trialing ? daysLeft(billing.trial_end) : null;
  return {
    tenant_status: tenant.status,
    paywalled: tenant.status === 'past_due',
    review_pending: tenant.status === 'pending_review',
    self_serve: tenant.signup_source === 'self_serve',
    // The card prompt: on trial (any time), or past_due, and no subscription yet.
    needs_card: (tenant.status === 'past_due' || trialing) && !billing?.razorpay_subscription_id,
    trialing,
    trial_end: billing?.trial_end || null,
    trial_days_left: trialDaysLeft,
    plan: plan ? { id: plan.id, name: plan.name, price_monthly: plan.price_monthly } : { id: tenant.plan },
    billing: billing ? {
      provider: billing.provider,
      subscription_status: billing.subscription_status,
      current_period_end: billing.current_period_end,
      last_payment_at: billing.last_payment_at,
      cancel_at_period_end: billing.cancel_at_period_end,
      canceled_at: billing.canceled_at,
      cancel_reason: billing.cancel_reason,
      quantity: billing.quantity || 1,
      pending_plan_id: billing.pending_plan_id || null,
      plan_change_at: billing.plan_change_at || null,
      has_subscription: !!billing.razorpay_subscription_id,
    } : null,
    managed_by_medibook: !billing || tenant.signup_source !== 'self_serve',
  };
}

// Doctors/branches used vs the ceiling — so the clinic sees "2 of 2 dentists"
// BEFORE it hits the hard block in routes/doctors.js. NULL limit (unlimited) is
// reported as null, never a number. `planId` is the plan whose list limits
// apply (the tenant's own for the /billing readout; the DOWNGRADE target for
// change-plan). `tenant` carries any negotiated max_*_override and is applied
// on top — pass `null` to get the tier's list limits with no override
// (change-plan does this so a self-serve downgrade is judged fairly).
async function loadUsage(schemaName, planId, tenant) {
  try {
    const [d, h, p] = await Promise.all([
      tenantQuery(schemaName, `SELECT COUNT(*)::int AS n FROM doctors WHERE is_active=true`),
      tenantQuery(schemaName, `SELECT COUNT(*)::int AS n FROM hospitals WHERE is_active=true AND deleted_at IS NULL`),
      query(`SELECT max_doctors, max_branches FROM plans WHERE id=$1`, [planId]),
    ]);
    const planRow = p.rows[0] || {};
    return {
      doctors:  { used: d.rows[0].n, limit: effectiveDoctorLimit(tenant, planRow) },
      branches: { used: h.rows[0].n, limit: effectiveBranchLimit(tenant, planRow) },
    };
  } catch (e) {
    logger.warn('billing: usage read failed', { schema: schemaName, error: e.message });
    return null;
  }
}

async function loadContext(tenantId) {
  const [tR, bR] = await Promise.all([
    query(`SELECT * FROM tenants WHERE id=$1`, [tenantId]),
    query(`SELECT * FROM tenant_billing WHERE tenant_id=$1`, [tenantId]),
  ]);
  const tenant = tR.rows[0];
  const billing = bR.rows[0] || null;
  let plan = null;
  if (tenant) {
    const pR = await query(`SELECT * FROM plans WHERE id=$1`, [tenant.plan]);
    plan = pR.rows[0] || null;
  }
  return { tenant, billing, plan };
}

// ── GET /admin/billing ──────────────────────────────────────
router.get('/billing', async (req, res) => {
  try {
    const { tenant, billing, plan } = await loadContext(req.tenant.id);
    if (!tenant) return res.status(404).json({ error: 'Clinic not found' });
    const base = shapeBilling(tenant, billing, plan);
    const [usage, plansR, profR, invCountR] = await Promise.all([
      loadUsage(tenant.schema_name, tenant.plan, tenant),
      query(`SELECT id, name, price_monthly, max_doctors, max_branches FROM plans WHERE id IN ('starter','professional') ORDER BY price_monthly ASC`),
      query(`SELECT tenant_id, legal_name, billing_address, gstin, place_of_supply, billing_email FROM tenant_billing_profiles WHERE tenant_id=$1`, [tenant.id]),
      query(`SELECT COUNT(*)::int AS n FROM billing_invoices WHERE tenant_id=$1`, [tenant.id]),
    ]);
    res.json({
      ...base,
      usage,
      plans: plansR.rows,
      profile: profR.rows[0] || null,
      invoices_count: invCountR.rows[0].n,
      deletion: tenant.deletion_requested_at ? {
        requested_at: tenant.deletion_requested_at,
        scheduled_for: tenant.deletion_scheduled_for,
      } : null,
    });
  } catch (err) { handleError(res, err); }
});

// ── POST /admin/billing/subscribe ───────────────────────────
// Create the Razorpay subscription for this clinic and hand the browser what it
// needs to open Checkout. If the trial is still running the first charge is
// scheduled for trial_end, so adding a card early never costs a day.
router.post('/billing/subscribe', adminOnly, async (req, res) => {
  try {
    if (!razorpay.isConfigured()) return res.status(503).json({ error: 'Billing is not configured on this deployment.' });
    const { tenant, billing } = await loadContext(req.tenant.id);
    if (!tenant) return res.status(404).json({ error: 'Clinic not found' });
    if (billing?.razorpay_subscription_id) {
      return res.status(409).json({ error: 'A subscription is already attached to this clinic.', subscription_id: billing.razorpay_subscription_id, key_id: razorpay.keyId() });
    }
    if (!razorpay.planIdFor(tenant.plan)) {
      return res.status(503).json({ error: 'This plan is not billable via self-serve yet — contact support.' });
    }

    let customerId = billing?.razorpay_customer_id || null;
    if (!customerId) {
      const ownerEmail = tenant.owner_email;
      const cust = await razorpay.createCustomer({ name: tenant.name, email: ownerEmail, contact: '' }).catch(e => {
        logger.warn('Razorpay customer create failed at subscribe', { error: e.message }); return null;
      });
      customerId = cust?.id || null;
    }
    // Razorpay requires a customer_id on a subscription — without one the
    // createSubscription call below is a guaranteed 502. Fail with a clear
    // message instead.
    if (!customerId) {
      return res.status(502).json({ error: 'Could not set up your billing profile. Please try again shortly, or contact support.' });
    }

    // Charge from trial_end if we are still inside the trial, else now.
    const trialEndMs = billing?.trial_end ? new Date(billing.trial_end).getTime() : 0;
    const trialDaysRemaining = trialEndMs > Date.now() ? Math.ceil((trialEndMs - Date.now()) / 86400000) : 0;

    let subscription;
    try {
      subscription = await razorpay.createSubscription({
        plan: tenant.plan, customerId, trialDays: trialDaysRemaining,
        notes: { slug: tenant.slug, tenant_id: tenant.id },
      });
    } catch (e) {
      logger.error('Razorpay createSubscription failed', { slug: tenant.slug, error: e.message });
      return res.status(502).json({ error: 'Could not set up the subscription. Please try again shortly.' });
    }

    await query(`
      INSERT INTO tenant_billing (tenant_id, provider, plan_id, razorpay_customer_id, razorpay_subscription_id, subscription_status, short_url, updated_at)
      VALUES ($1,'razorpay',$2,$3,$4,$5,$6, NOW())
      ON CONFLICT (tenant_id) DO UPDATE SET
        plan_id=EXCLUDED.plan_id,
        razorpay_customer_id=COALESCE(EXCLUDED.razorpay_customer_id, tenant_billing.razorpay_customer_id),
        razorpay_subscription_id=EXCLUDED.razorpay_subscription_id,
        subscription_status=EXCLUDED.subscription_status,
        short_url=EXCLUDED.short_url,
        updated_at=NOW()
    `, [tenant.id, tenant.plan, customerId, subscription.id, subscription.status || 'created', subscription.short_url || null]);

    res.json({
      subscription_id: subscription.id,
      key_id: razorpay.keyId(),
      short_url: subscription.short_url || null,
      prefill: { name: tenant.name, email: tenant.owner_email },
    });
  } catch (err) { handleError(res, err); }
});

// ── POST /admin/billing/subscribe/confirm ───────────────────
// Verify the Checkout signature after the owner authorised the card.
router.post('/billing/subscribe/confirm', adminOnly, validate(schemas.billingSubscribeConfirm), async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;
    const { tenant, billing } = await loadContext(req.tenant.id);
    if (!billing || billing.razorpay_subscription_id !== razorpay_subscription_id) {
      return res.status(400).json({ error: 'That subscription does not belong to this clinic.' });
    }
    if (!razorpay.verifyCheckoutSignature({ razorpay_payment_id, razorpay_subscription_id, razorpay_signature })) {
      logger.warn('billing subscribe confirm: bad signature', { slug: tenant.slug });
      return res.status(400).json({ error: 'We could not verify that authorisation. Please try again.' });
    }

    let sub;
    try { sub = await razorpay.fetchSubscription(razorpay_subscription_id); }
    catch (e) { sub = { status: 'authenticated' }; }

    const periodEnd = sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null;
    await query(`
      UPDATE tenant_billing
         SET subscription_status=$1, current_period_end=COALESCE($2, current_period_end), updated_at=NOW()
       WHERE tenant_id=$3
    `, [sub.status || 'authenticated', periodEnd, tenant.id]);

    // Clearing the paywall: a past_due clinic that has now authorised a card is
    // back in good standing.
    let recovered = false;
    if (tenant.status === 'past_due' && razorpay.isHealthyStatus(sub.status || 'authenticated')) {
      await query(`UPDATE tenants SET status='active', suspension_reason=NULL, suspended_at=NULL WHERE id=$1`, [tenant.id]);
      require('../middleware/auth').invalidateTenantCache(tenant.id);
      recovered = true;
      logger.info('past_due tenant recovered — card authorised', { slug: tenant.slug });
    }

    const ctx = await loadContext(req.tenant.id);
    res.json({ ...shapeBilling(ctx.tenant, ctx.billing, ctx.plan), recovered });
  } catch (err) { handleError(res, err); }
});

// ── POST /admin/billing/refresh ─────────────────────────────
// "I just paid — update now." Pulls live state from Razorpay.
router.post('/billing/refresh', adminOnly, async (req, res) => {
  try {
    const { tenant, billing } = await loadContext(req.tenant.id);
    if (!billing || !billing.razorpay_subscription_id) {
      return res.status(400).json({ error: 'No subscription is attached to this clinic yet.' });
    }
    if (!razorpay.isConfigured()) return res.status(503).json({ error: 'Billing is not configured on this deployment.' });

    let sub;
    try { sub = await razorpay.fetchSubscription(billing.razorpay_subscription_id); }
    catch (e) { return res.status(502).json({ error: 'Could not reach the payment provider. Try again shortly.' }); }

    const periodEnd = sub.current_end ? new Date(sub.current_end * 1000).toISOString() : billing.current_period_end;
    const chargedAt = sub.current_start ? new Date(sub.current_start * 1000).toISOString() : billing.last_payment_at;
    await query(`
      UPDATE tenant_billing SET subscription_status=$1, current_period_end=$2, last_payment_at=$3, updated_at=NOW()
       WHERE tenant_id=$4
    `, [sub.status, periodEnd, chargedAt, tenant.id]);

    let recovered = false;
    if (tenant.status === 'past_due' && razorpay.isHealthyStatus(sub.status)) {
      await query(`UPDATE tenants SET status='active', suspension_reason=NULL, suspended_at=NULL WHERE id=$1`, [tenant.id]);
      require('../middleware/auth').invalidateTenantCache(tenant.id);
      recovered = true;
    }
    const ctx = await loadContext(req.tenant.id);
    res.json({ ...shapeBilling(ctx.tenant, ctx.billing, ctx.plan), recovered });
  } catch (err) { handleError(res, err); }
});

// ── POST /admin/billing/update-card ─────────────────────────
router.post('/billing/update-card', adminOnly, async (req, res) => {
  try {
    const { billing } = await loadContext(req.tenant.id);
    if (!billing || !billing.razorpay_subscription_id) {
      return res.status(400).json({ error: 'No subscription is attached to this clinic yet.' });
    }
    if (!razorpay.isConfigured()) return res.status(503).json({ error: 'Billing is not configured on this deployment.' });
    let sub;
    try { sub = await razorpay.fetchSubscription(billing.razorpay_subscription_id); }
    catch (e) { return res.status(502).json({ error: 'Could not reach the payment provider. Try again shortly.' }); }
    if (sub.short_url) {
      if (sub.short_url !== billing.short_url) {
        await query(`UPDATE tenant_billing SET short_url=$1, updated_at=NOW() WHERE tenant_id=$2`, [sub.short_url, req.tenant.id]);
      }
      return res.json({ url: sub.short_url });
    }
    res.status(409).json({ error: 'This subscription has no self-service update link. Please contact support to change the card.' });
  } catch (err) { handleError(res, err); }
});

// ── POST /admin/billing/cancel ─────────────────────────────
// The clinic asks to stop. We do NOT hit Razorpay's cancel here: instead we
// flag `cancel_at_period_end` and let jobs/billingDunning.js issue the actual
// Razorpay cancel once `current_period_end` passes. That makes /cancel/undo a
// real undo (Razorpay has no un-cancel) and guarantees the clinic keeps every
// day it has paid for. A clinic still on the card-free trial has no
// subscription yet — the flag just records the intent so the trial lapses to
// past_due without a card prompt nagging them.
router.post('/billing/cancel', adminOnly, async (req, res) => {
  try {
    const { tenant, billing } = await loadContext(req.tenant.id);
    if (!tenant) return res.status(404).json({ error: 'Clinic not found' });
    if (tenant.signup_source !== 'self_serve' || !billing) {
      return res.status(400).json({ error: 'Billing for this clinic is managed by MediBook — contact us to make changes.' });
    }
    if (billing.cancel_at_period_end) {
      return res.json({ ...shapeBilling(tenant, billing, null), already: true });
    }
    const reason = String(req.body?.reason || '').slice(0, 500) || null;
    await query(
      `UPDATE tenant_billing SET cancel_at_period_end=true, cancel_reason=$1, updated_at=NOW() WHERE tenant_id=$2`,
      [reason, tenant.id]
    );
    await query(`
      INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, new_values, ip_address)
      VALUES ($1,$2,'BILLING_CANCEL_REQUESTED','tenant',$3,$4,$5)
    `, [req.user.id, req.user.role, tenant.id, JSON.stringify({ reason, period_end: billing.current_period_end }), req.ip]).catch(() => {});
    logger.info('billing: cancel requested', { slug: tenant.slug });
    const ctx = await loadContext(req.tenant.id);
    res.json(shapeBilling(ctx.tenant, ctx.billing, ctx.plan));
  } catch (err) { handleError(res, err); }
});

// ── POST /admin/billing/cancel/undo ────────────────────────
router.post('/billing/cancel/undo', adminOnly, async (req, res) => {
  try {
    const { tenant, billing } = await loadContext(req.tenant.id);
    if (!billing || !billing.cancel_at_period_end) {
      return res.status(400).json({ error: 'This clinic is not scheduled to cancel.' });
    }
    if (billing.canceled_at) {
      return res.status(409).json({ error: 'The subscription has already been cancelled with the payment provider. Add a card to start again.' });
    }
    await query(
      `UPDATE tenant_billing SET cancel_at_period_end=false, cancel_reason=NULL, updated_at=NOW() WHERE tenant_id=$1`,
      [tenant.id]
    );
    await query(`
      INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, ip_address)
      VALUES ($1,$2,'BILLING_CANCEL_UNDONE','tenant',$3,$4)
    `, [req.user.id, req.user.role, tenant.id, req.ip]).catch(() => {});
    const ctx = await loadContext(req.tenant.id);
    res.json(shapeBilling(ctx.tenant, ctx.billing, ctx.plan));
  } catch (err) { handleError(res, err); }
});

// ── POST /admin/billing/change-plan ───────────────────────
// Upgrade takes effect NOW (proration on); downgrade is scheduled for the next
// cycle so the clinic keeps the tier it paid for. A downgrade that the clinic's
// current usage would violate (3 dentists on a 2-dentist plan) is refused with
// what to shed first. On the card-free trial there is no subscription, so the
// swap is just a column update — nothing has been charged.
router.post('/billing/change-plan', adminOnly, async (req, res) => {
  try {
    const target = String(req.body?.plan || '').trim();
    if (!['starter', 'professional'].includes(target)) {
      return res.status(400).json({ error: 'Choose either the Starter or Professional plan.' });
    }
    const { tenant, billing } = await loadContext(req.tenant.id);
    if (!tenant) return res.status(404).json({ error: 'Clinic not found' });
    if (tenant.signup_source !== 'self_serve' || !billing) {
      return res.status(400).json({ error: 'Billing for this clinic is managed by MediBook — contact us to change plans.' });
    }
    if (target === tenant.plan && !billing.pending_plan_id) {
      return res.status(409).json({ error: `You are already on the ${target} plan.` });
    }

    const order = { starter: 0, professional: 1 };
    const isUpgrade = order[target] > order[tenant.plan];

    // Guard a downgrade against live usage. Judged against the TARGET tier's
    // list limits, NOT any negotiated max_*_override (pass null): this is a
    // self-serve card clinic downgrading its own paid plan, so a super-admin
    // favour must not let it keep a bigger cap on a cheaper tier. A
    // super-admin-billed clinic never reaches here (blocked above).
    if (!isUpgrade) {
      const usage = await loadUsage(tenant.schema_name, target, null);
      const problems = [];
      if (usage?.doctors?.limit != null && usage.doctors.used > usage.doctors.limit) {
        problems.push(`deactivate ${usage.doctors.used - usage.doctors.limit} dentist(s) (limit ${usage.doctors.limit})`);
      }
      if (usage?.branches?.limit != null && usage.branches.used > usage.branches.limit) {
        problems.push(`remove ${usage.branches.used - usage.branches.limit} branch(es) (limit ${usage.branches.limit})`);
      }
      if (problems.length) {
        return res.status(409).json({ error: `The ${target} plan does not fit your current setup — first ${problems.join(' and ')}.`, code: 'DOWNGRADE_BLOCKED' });
      }
    }

    const qty = await billingSvc.branchQuantity(tenant.schema_name, target);

    // No subscription yet (trial): just move the plan.
    if (!billing.razorpay_subscription_id) {
      await query(`UPDATE tenants SET plan=$1 WHERE id=$2`, [target, tenant.id]);
      await query(`UPDATE tenant_billing SET plan_id=$1, pending_plan_id=NULL, plan_change_at=NULL, quantity=$2, updated_at=NOW() WHERE tenant_id=$3`,
        [target, qty, tenant.id]);
      require('../middleware/auth').invalidateTenantCache(tenant.id);
      await recordPlanChange(tenant.id, tenant.plan, target, req.user.id, isUpgrade ? 'immediate' : 'immediate');
      const ctx = await loadContext(req.tenant.id);
      return res.json({ ...shapeBilling(ctx.tenant, ctx.billing, ctx.plan), applied: 'now' });
    }

    if (!razorpay.isConfigured()) return res.status(503).json({ error: 'Billing is not configured on this deployment.' });
    if (!razorpay.planIdFor(target)) return res.status(503).json({ error: 'That plan is not billable via self-serve yet — contact support.' });

    try {
      await razorpay.updateSubscription(billing.razorpay_subscription_id, {
        planId: target, quantity: qty, scheduleChangeAt: isUpgrade ? 'now' : 'cycle_end',
      });
    } catch (e) {
      logger.error('billing: change-plan Razorpay update failed', { slug: tenant.slug, target, error: e.message });
      return res.status(502).json({ error: 'Could not change the plan with the payment provider. Try again shortly.' });
    }

    if (isUpgrade) {
      await query(`UPDATE tenants SET plan=$1 WHERE id=$2`, [target, tenant.id]);
      await query(`UPDATE tenant_billing SET plan_id=$1, pending_plan_id=NULL, plan_change_at=NULL, quantity=$2, updated_at=NOW() WHERE tenant_id=$3`,
        [target, qty, tenant.id]);
      require('../middleware/auth').invalidateTenantCache(tenant.id);
    } else {
      await query(`UPDATE tenant_billing SET pending_plan_id=$1, plan_change_at=current_period_end, updated_at=NOW() WHERE tenant_id=$2`,
        [target, tenant.id]);
    }
    await recordPlanChange(tenant.id, tenant.plan, target, req.user.id, isUpgrade ? 'immediate' : 'cycle_end');
    logger.info('billing: plan change', { slug: tenant.slug, from: tenant.plan, to: target, when: isUpgrade ? 'now' : 'cycle_end' });
    const ctx = await loadContext(req.tenant.id);
    res.json({ ...shapeBilling(ctx.tenant, ctx.billing, ctx.plan), applied: isUpgrade ? 'now' : 'cycle_end' });
  } catch (err) { handleError(res, err); }
});

async function recordPlanChange(tenantId, oldPlan, newPlan, userId, effective) {
  await query(`
    INSERT INTO plan_changes (tenant_id, old_plan, new_plan, changed_by, source, effective)
    VALUES ($1,$2,$3,$4,'self_serve',$5)
  `, [tenantId, oldPlan, newPlan, userId, effective]).catch(e => logger.warn('plan_changes insert failed', { error: e.message }));
}

// ── GET /admin/billing/invoices ────────────────────────────
// adminOnly: a GST tax invoice is a financial document, gated like
// /billing/profile and the PHI export, not open to the dentist role.
router.get('/billing/invoices', adminOnly, async (req, res) => {
  try {
    const r = await query(`
      SELECT id, invoice_number, issued_at, period_start, period_end,
             total_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise,
             currency, status, plan_id, quantity
        FROM billing_invoices
       WHERE tenant_id=$1
       ORDER BY issued_at DESC
       LIMIT 60
    `, [req.tenant.id]);
    res.json({ invoices: r.rows });
  } catch (err) { handleError(res, err); }
});

// ── GET /admin/billing/invoices/:id.pdf ────────────────────
router.get('/billing/invoices/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const r = await query(`SELECT * FROM billing_invoices WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.tenant.id]);
    const invoice = r.rows[0];
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const tR = await query(`SELECT name FROM tenants WHERE id=$1`, [req.tenant.id]);
    invoiceSvc.renderInvoicePdf(res, { invoice, tenant: tR.rows[0] || null });
  } catch (err) { if (!res.headersSent) handleError(res, err); }
});

// ── GET / PUT /admin/billing/profile ──────────────────────
// The buyer's GST identity, used to raise a compliant tax invoice. adminOnly:
// it changes what appears on a legal document.
router.get('/billing/profile', adminOnly, async (req, res) => {
  try {
    const r = await query(`SELECT tenant_id, legal_name, billing_address, gstin, place_of_supply, billing_email, updated_at FROM tenant_billing_profiles WHERE tenant_id=$1`, [req.tenant.id]);
    res.json({ profile: r.rows[0] || null });
  } catch (err) { handleError(res, err); }
});

router.put('/billing/profile', adminOnly, async (req, res) => {
  try {
    const legal_name = req.body?.legal_name != null ? String(req.body.legal_name).trim().slice(0, 255) : null;
    const billing_address = req.body?.billing_address != null ? String(req.body.billing_address).trim().slice(0, 1000) : null;
    const billing_email = req.body?.billing_email != null ? String(req.body.billing_email).trim().slice(0, 255) : null;
    let gstin = req.body?.gstin != null ? String(req.body.gstin).trim().toUpperCase() : null;
    let place_of_supply = req.body?.place_of_supply != null ? String(req.body.place_of_supply).trim() : null;

    if (gstin) {
      if (!GSTIN_RE.test(gstin)) return res.status(400).json({ error: 'That does not look like a valid 15-character GSTIN.' });
      // Place of supply defaults to the state encoded in the GSTIN.
      if (!place_of_supply) place_of_supply = gstin.slice(0, 2);
    }
    if (place_of_supply && !/^[0-9]{2}$/.test(place_of_supply)) {
      return res.status(400).json({ error: 'Place of supply must be a 2-digit GST state code (e.g. 29 for Karnataka).' });
    }
    if (billing_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(billing_email)) {
      return res.status(400).json({ error: 'Enter a valid billing email or leave it blank.' });
    }

    await query(`
      INSERT INTO tenant_billing_profiles (tenant_id, legal_name, billing_address, gstin, place_of_supply, billing_email, updated_at, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
      ON CONFLICT (tenant_id) DO UPDATE SET
        legal_name=EXCLUDED.legal_name,
        billing_address=EXCLUDED.billing_address,
        gstin=EXCLUDED.gstin,
        place_of_supply=EXCLUDED.place_of_supply,
        billing_email=EXCLUDED.billing_email,
        updated_at=NOW(), updated_by=EXCLUDED.updated_by
    `, [req.tenant.id, legal_name, billing_address, gstin, place_of_supply, billing_email, req.user.id]);
    await query(`
      INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, new_values, ip_address)
      VALUES ($1,$2,'UPDATE_BILLING_PROFILE','tenant',$3,$4,$5)
    `, [req.user.id, req.user.role, req.tenant.id, JSON.stringify({ gstin, place_of_supply }), req.ip]).catch(() => {});
    const r = await query(`SELECT tenant_id, legal_name, billing_address, gstin, place_of_supply, billing_email, updated_at FROM tenant_billing_profiles WHERE tenant_id=$1`, [req.tenant.id]);
    res.json({ profile: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

module.exports = router;
