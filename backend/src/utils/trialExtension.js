'use strict';
/**
 * Ad-hoc trial extension for a single self-serve clinic.
 *
 * The card-free trial is written once (`tenant_billing.trial_end`, by
 * POST /superadmin/tenants/:id/approve) and then only ever ENDED —
 * jobs/billingDunning.js moves a lapsed `trialing` clinic to `past_due`
 * (`suspension_reason='trial_ended'`, `tenant_billing.subscription_status
 * ='trial_ended'`). There was no supported way to give one clinic longer.
 *
 * POST /superadmin/tenants/:id/extend-trial uses the three pure helpers here:
 * decide whether the clinic is eligible, compute the new end date, and decide
 * whether the tenant needs un-lapsing back to `active`. The route then applies
 * both writes and audits them.
 */

const MAX_EXTENSION_DAYS = 365;

/**
 * Is this clinic on (or freshly off) a card-free trial we can extend?
 * @param {{ billing: object|null }} args  tenant_billing row (or null)
 * @returns {{ ok: boolean, code?: string, error?: string }}
 */
function trialExtensionGuard({ billing }) {
  if (!billing) {
    return {
      ok: false,
      code: 'NO_BILLING',
      error: 'This clinic has no billing record — only an approved self-serve clinic has a trial to extend.',
    };
  }
  if (billing.razorpay_subscription_id) {
    return {
      ok: false,
      code: 'HAS_SUBSCRIPTION',
      error: 'This clinic has a card on file. A trial only applies before a subscription is attached; adjust the subscription in Razorpay instead.',
    };
  }
  const s = billing.subscription_status;
  if (s !== 'trialing' && s !== 'trial_ended') {
    return {
      ok: false,
      code: 'NOT_TRIALING',
      error: `This clinic isn't on a card-free trial (billing status: ${s || 'unknown'}). Trial extension only applies while trialing or just after it lapsed.`,
    };
  }
  return { ok: true };
}

/**
 * New trial end after adding `days`. If the trial is still running, the days are
 * added to the existing end; if it has already lapsed, they run from now — so
 * "give them 14 more days" always means a full 14 days of usable trial.
 * @param {Date|string|null} currentTrialEnd
 * @param {number} days  positive integer
 * @param {Date} [now]
 * @returns {Date}
 */
function nextTrialEnd(currentTrialEnd, days, now = new Date()) {
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > MAX_EXTENSION_DAYS) {
    throw new RangeError(`days must be a whole number 1–${MAX_EXTENSION_DAYS}`);
  }
  const cur = currentTrialEnd ? new Date(currentTrialEnd) : null;
  const base = cur && !Number.isNaN(cur.getTime()) && cur > now ? cur : now;
  return new Date(base.getTime() + d * 24 * 60 * 60 * 1000);
}

/**
 * True when extending the trial should also lift a lapse the dunning cron
 * applied. Two states qualify, both from the card-free-trial path only:
 *   - `past_due` + `suspension_reason='trial_ended'`  (billingDunning.endLapsedTrials)
 *   - `suspended` + `suspension_reason='payment_grace_elapsed'` once the grace
 *     window elapsed (billingDunning.suspendExpiredGrace) — which does NOT touch
 *     tenant_billing, so `subscription_status` is still 'trial_ended' and tells
 *     it apart from a real card-payment failure that reached the same status.
 * A `past_due`/`suspended` for a genuine payment failure is left alone (the
 * route's guard has already rejected any clinic with a Razorpay subscription,
 * so a `trial_ended` billing status here is an unambiguous "card-free trial").
 * @param {{ status: string, suspension_reason?: string|null }} tenant
 * @param {{ subscription_status?: string|null }|null} [billing]
 */
function shouldRelapseToActive(tenant, billing) {
  if (tenant.status === 'past_due' && tenant.suspension_reason === 'trial_ended') {
    return true;
  }
  if (
    tenant.status === 'suspended'
    && tenant.suspension_reason === 'payment_grace_elapsed'
    && billing && billing.subscription_status === 'trial_ended'
  ) {
    return true;
  }
  return false;
}

module.exports = {
  MAX_EXTENSION_DAYS,
  trialExtensionGuard,
  nextTrialEnd,
  shouldRelapseToActive,
};
