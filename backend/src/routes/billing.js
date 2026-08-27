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
const { query } = require('../db');
const { handleError } = require('../utils/errors');
const { validate, schemas } = require('../middleware/validate');
const { adminOnly } = require('./adminHelpers');
const razorpay = require('../services/razorpay');
const logger = require('../utils/logger');

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
      has_subscription: !!billing.razorpay_subscription_id,
    } : null,
    managed_by_medibook: !billing || tenant.signup_source !== 'self_serve',
  };
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
    res.json(shapeBilling(tenant, billing, plan));
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

module.exports = router;
