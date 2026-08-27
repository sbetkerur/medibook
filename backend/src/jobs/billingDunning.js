'use strict';
/**
 * Trial expiry, billing reconciliation, and dunning for self-serve clinics.
 *
 * The trial is CARD-FREE, so this cron is what actually ENDS a trial: a clinic
 * still on `trialing` past `trial_end` with no subscription attached is moved to
 * `past_due` (paywall — it can log in and add a card). The Razorpay webhook is
 * the primary signal once a card exists; this is the daily backstop and the
 * enforcer of the grace window. Every day it:
 *
 *   1. purges expired OTPs and abandoned pending_signups,
 *   2. ends lapsed trials (active + trialing + trial_end passed → past_due),
 *   3. pulls live subscription state from Razorpay into tenant_billing for every
 *      clinic that HAS a subscription, moving active⇄past_due to match,
 *   4. suspends any clinic that has sat in past_due longer than the grace
 *      window (SIGNUP_DUNNING_GRACE_DAYS, default 7), and alerts its admins,
 *   5. retries provisioning for any 'pending_payment' clinic whose schema build
 *      failed at signup.
 *
 * Super-admin-created clinics have no tenant_billing row and are untouched.
 */
const cron = require('node-cron');
const { query } = require('../db');
const { withCronLock } = require('../utils/cronLock');
const razorpay = require('../services/razorpay');
const { purgeExpiredOtps } = require('../services/otp');
const { notifyAdminWhatsApp } = require('../services/bot/utils');
const { invalidateTenantCache } = require('../middleware/auth');
const logger = require('../utils/logger');

const GRACE_DAYS = Math.max(1, parseInt(process.env.SIGNUP_DUNNING_GRACE_DAYS || '7', 10) || 7);

async function purgeStaleSignups() {
  await purgeExpiredOtps().catch(() => {});
  const r = await query(
    `DELETE FROM pending_signups
      WHERE consumed_at IS NULL AND tenant_id IS NULL AND expires_at < NOW() - INTERVAL '1 day'`
  ).catch(() => ({ rowCount: 0 }));
  if (r.rowCount) logger.info('billing_dunning: purged abandoned signups', { count: r.rowCount });
}

async function endLapsedTrials() {
  const rows = (await query(`
    SELECT t.id, t.slug, t.schema_name, t.name
      FROM tenants t
      JOIN tenant_billing b ON b.tenant_id = t.id
     WHERE t.status = 'active'
       AND b.subscription_status = 'trialing'
       AND b.razorpay_subscription_id IS NULL
       AND b.trial_end IS NOT NULL
       AND b.trial_end < NOW()
  `)).rows;

  for (const t of rows) {
    await query(
      `UPDATE tenants SET status='past_due', suspension_reason='trial_ended', suspended_at=NOW() WHERE id=$1`,
      [t.id]
    );
    await query(`UPDATE tenant_billing SET subscription_status='trial_ended', updated_at=NOW() WHERE tenant_id=$1`, [t.id]);
    invalidateTenantCache(t.id);
    logger.warn('billing_dunning: trial ended → past_due', { slug: t.slug });
    await notifyAdminWhatsApp(t.schema_name, t,
      `Your MediBook free trial has ended. Add a card in Settings › Billing to keep taking bookings — ` +
      `your data and setup are safe in the meantime.`
    ).catch(() => {});
  }
}

async function reconcileSubscriptions() {
  if (!razorpay.isConfigured()) return;
  const rows = (await query(`
    SELECT b.tenant_id, b.razorpay_subscription_id, t.status AS tenant_status, t.slug
      FROM tenant_billing b
      JOIN tenants t ON t.id = b.tenant_id
     WHERE b.razorpay_subscription_id IS NOT NULL
       AND t.status IN ('active','past_due','pending_review')
  `)).rows;

  for (const row of rows) {
    let sub;
    try { sub = await razorpay.fetchSubscription(row.razorpay_subscription_id); }
    catch (e) { logger.warn('billing_dunning: subscription fetch failed', { slug: row.slug, error: e.message }); continue; }

    const periodEnd = sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null;
    const chargedAt = sub.current_start ? new Date(sub.current_start * 1000).toISOString() : null;
    await query(`
      UPDATE tenant_billing SET
        subscription_status=$1,
        current_period_end=COALESCE($2, current_period_end),
        last_payment_at=COALESCE($3, last_payment_at),
        updated_at=NOW()
      WHERE tenant_id=$4
    `, [sub.status, periodEnd, chargedAt, row.tenant_id]).catch(() => {});

    const healthy = razorpay.isHealthyStatus(sub.status);
    if (row.tenant_status === 'active' && !healthy) {
      await query(`UPDATE tenants SET status='past_due', suspension_reason='payment', suspended_at=NOW() WHERE id=$1`, [row.tenant_id]);
      invalidateTenantCache(row.tenant_id);
      logger.warn('billing_dunning: active → past_due', { slug: row.slug, sub_status: sub.status });
    } else if (row.tenant_status === 'past_due' && healthy) {
      await query(`UPDATE tenants SET status='active', suspension_reason=NULL, suspended_at=NULL WHERE id=$1`, [row.tenant_id]);
      invalidateTenantCache(row.tenant_id);
      logger.info('billing_dunning: past_due → active (payment recovered)', { slug: row.slug });
    }
  }
}

async function suspendExpiredGrace() {
  const rows = (await query(`
    SELECT t.id, t.slug, t.schema_name, t.name
      FROM tenants t
     WHERE t.status = 'past_due'
       AND t.suspended_at IS NOT NULL
       AND t.suspended_at < NOW() - make_interval(days => $1::int)
  `, [GRACE_DAYS])).rows;

  for (const t of rows) {
    await query(
      `UPDATE tenants SET status='suspended', suspension_reason='payment_grace_elapsed', suspended_at=NOW() WHERE id=$1`,
      [t.id]
    );
    invalidateTenantCache(t.id);
    await query(`
      INSERT INTO audit_logs (actor_role, action, resource_type, resource_id, new_values)
      VALUES ('system','SUSPEND_TENANT_DUNNING','tenant',$1,$2)
    `, [t.id, JSON.stringify({ grace_days: GRACE_DAYS })]).catch(() => {});
    logger.warn('billing_dunning: past_due grace elapsed → suspended', { slug: t.slug });
    await notifyAdminWhatsApp(t.schema_name, t,
      `Your MediBook subscription is overdue and clinic messaging is now paused. ` +
      `Contact MediBook support to settle payment and restore service.`
    ).catch(() => {});
  }
}

async function retryStuckProvisioning() {
  const rows = (await query(`
    SELECT ps.* FROM pending_signups ps
    JOIN tenants t ON t.id = ps.tenant_id
    WHERE t.status = 'pending_payment'
  `)).rows;
  const TRIAL_DAYS = Math.max(0, parseInt(process.env.SIGNUP_TRIAL_DAYS || '14', 10) || 14);
  for (const pending of rows) {
    try {
      const { provisionSelfServeTenant } = require('../services/signupProvision');
      const { tenant } = await provisionSelfServeTenant(pending);
      // The card-free trial row + consumed flag are normally written by the
      // /signup/confirm route. If the client abandoned after the schema build
      // failed, this cron is the only thing that ever finishes the job — so it
      // has to start the trial too, or the clinic goes live billed by nobody.
      await query(`
        INSERT INTO tenant_billing
          (tenant_id, provider, plan_id, razorpay_customer_id, subscription_status, trial_end, updated_at)
        VALUES ($1,'razorpay',$2,$3,'trialing', NOW() + make_interval(days => $4::int), NOW())
        ON CONFLICT (tenant_id) DO NOTHING
      `, [tenant.id, tenant.plan, pending.razorpay_customer_id, TRIAL_DAYS]).catch(() => {});
      await query(
        `UPDATE pending_signups SET consumed_at=COALESCE(consumed_at, NOW()), tenant_id=$1 WHERE token=$2`,
        [tenant.id, pending.token]
      ).catch(() => {});
      logger.info('billing_dunning: stuck provisioning recovered', { slug: tenant.slug });
    } catch (e) {
      logger.error('billing_dunning: provisioning retry still failing', { slug: pending.slug, error: e.message });
    }
  }
}

async function runOnce() {
  await purgeStaleSignups();
  await endLapsedTrials();
  await reconcileSubscriptions();
  await suspendExpiredGrace();
  await retryStuckProvisioning();
}

function startBillingDunningCron() {
  // 06:15 IST — before the working day, after any overnight Razorpay retries.
  const task = cron.schedule('15 6 * * *', async () => {
    await withCronLock('cron:billing_dunning', 3600, async () => {
      logger.info('Running billing dunning cron...');
      try {
        await runOnce();
        await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='billing_dunning'`).catch(() => {});
      } catch (err) {
        logger.error('Billing dunning cron error', { error: err.message });
        await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='billing_dunning'`,
          [err.message?.slice(0, 500)]).catch(() => {});
      }
    });
  }, { timezone: 'Asia/Kolkata' });
  return task;
}

module.exports = { startBillingDunningCron, runOnce, GRACE_DAYS };
