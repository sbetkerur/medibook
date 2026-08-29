'use strict';
/**
 * Razorpay REST wrapper — self-serve signup billing.
 *
 * Deliberately NOT the `razorpay` npm SDK: the surface we need is four calls and
 * two HMAC checks, the SDK pulls its own transitive tree, and the rest of this
 * codebase already talks to Meta the same way (axios + `crypto` for signature
 * verification). One dependency-free file is easier to audit than an SDK we use
 * 5% of.
 *
 * Auth is HTTP Basic `key_id:key_secret`. The secret NEVER leaves the server —
 * the browser only ever sees `key_id` (public by design) and a `subscription_id`.
 *
 * Everything here throws on misuse or a non-2xx response; callers decide whether
 * that is fatal. `isConfigured()` is the gate every route checks first, so a
 * deployment without Razorpay keys simply has self-serve signup switched off
 * rather than 500-ing.
 */
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

const API_BASE = 'https://api.razorpay.com/v1';

function keyId()        { return (process.env.RAZORPAY_KEY_ID || '').trim(); }
function keySecret()    { return (process.env.RAZORPAY_KEY_SECRET || '').trim(); }
function webhookSecret(){ return (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim(); }

/**
 * Are Razorpay credentials present AND real (not the .env.example placeholders)?
 * routes/signup.js and routes/billing.js both gate on this; index.js warns at
 * boot when it is false but SELF_SIGNUP_ENABLED is true.
 */
function isConfigured() {
  const id = keyId(), secret = keySecret();
  if (!id || !secret) return false;
  if (/placeholder|changeme|your_key/i.test(id) || /placeholder|changeme|your_key/i.test(secret)) return false;
  // Live and test keys are `rzp_live_…` / `rzp_test_…`.
  return /^rzp_(live|test)_/.test(id);
}

function planIdFor(plan) {
  const map = {
    starter: (process.env.RAZORPAY_PLAN_STARTER || '').trim(),
    professional: (process.env.RAZORPAY_PLAN_PROFESSIONAL || '').trim(),
  };
  return map[plan] || null;
}

let _client = null;
function client() {
  if (_client) return _client;
  _client = axios.create({
    baseURL: API_BASE,
    timeout: 12000,
    auth: { username: keyId(), password: keySecret() },
    headers: { 'Content-Type': 'application/json' },
  });
  return _client;
}

// Surface Razorpay's own error description rather than a bare "Request failed
// with status code 400" — its messages ("plan_id is not a valid id") are what
// actually tells an operator what is wrong.
function _wrap(err, context) {
  const desc = err?.response?.data?.error?.description;
  const code = err?.response?.status;
  const e = new Error(desc ? `Razorpay ${context}: ${desc}` : `Razorpay ${context} failed (${code || err.message})`);
  e.status = code;
  e.razorpay = err?.response?.data?.error || null;
  return e;
}

/** Create (or fetch, if it already exists for this email) a Razorpay customer. */
async function createCustomer({ name, email, contact }) {
  try {
    const { data } = await client().post('/customers', {
      name: String(name || '').slice(0, 100),
      email,
      contact: String(contact || '').replace(/[^\d+]/g, ''),
      fail_existing: 0, // return the existing customer instead of erroring
    });
    return data; // { id: 'cust_...', ... }
  } catch (err) { throw _wrap(err, 'createCustomer'); }
}

/**
 * Create a subscription that takes a card now and starts billing after the trial.
 *
 * `start_at` (unix seconds) is the first CHARGE — until then the subscription
 * sits in `authenticated` once the customer has completed the Checkout auth
 * transaction. `customer_notify: 1` lets Razorpay send its own payment emails.
 */
async function createSubscription({ plan, customerId, trialDays, notes, quantity }) {
  const rzpPlanId = planIdFor(plan);
  if (!rzpPlanId) throw new Error(`No Razorpay plan configured for "${plan}" (set RAZORPAY_PLAN_${String(plan).toUpperCase()})`);
  const days = Math.max(0, Number(trialDays) || 0);
  // Razorpay rejects a `start_at` that is not in the future. When the trial has
  // already lapsed (past_due clinic adding a card) omit it entirely so billing
  // starts immediately, instead of sending `now` and getting a BAD_REQUEST.
  const startAt = days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : null;
  try {
    const { data } = await client().post('/subscriptions', {
      plan_id: rzpPlanId,
      customer_id: customerId,
      // 100 years of monthly cycles. Razorpay requires a finite count; this is
      // effectively "until cancelled". Was 120 (10y) — bumped so a long-lived
      // clinic never hits `subscription.completed` and silently stops billing.
      total_count: 1200,
      quantity: Math.max(1, Number(quantity) || 1),
      customer_notify: 1,
      ...(startAt ? { start_at: startAt, expire_by: startAt + 7 * 86400 } : {}),
      notes: notes || {},
    });
    return data; // { id: 'sub_...', status, short_url, ... }
  } catch (err) { throw _wrap(err, 'createSubscription'); }
}

/**
 * Update a live subscription — plan swap and/or quantity change.
 *   scheduleChangeAt: 'now' (immediate, proration on) | 'cycle_end' (default).
 * Razorpay's PATCH /subscriptions/:id takes `plan_id`, `quantity`,
 * `schedule_change_at` and `remaining_count`. We pass `remaining_count` on a
 * plan change because Razorpay resets the billing cycle and requires it.
 */
async function updateSubscription(subscriptionId, { planId, quantity, scheduleChangeAt = 'cycle_end' } = {}) {
  const body = { schedule_change_at: scheduleChangeAt === 'now' ? 'now' : 'cycle_end' };
  if (planId) {
    const rzpPlanId = planIdFor(planId);
    if (!rzpPlanId) throw new Error(`No Razorpay plan configured for "${planId}"`);
    body.plan_id = rzpPlanId;
    body.remaining_count = 1200;
  }
  if (quantity != null) body.quantity = Math.max(1, Number(quantity) || 1);
  try {
    const { data } = await client().patch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, body);
    return data;
  } catch (err) { throw _wrap(err, 'updateSubscription'); }
}

async function fetchSubscription(subscriptionId) {
  try {
    const { data } = await client().get(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
    return data;
  } catch (err) { throw _wrap(err, 'fetchSubscription'); }
}

/** Cancel — `atCycleEnd: true` lets the clinic keep service until it has paid for. */
async function cancelSubscription(subscriptionId, atCycleEnd = false) {
  try {
    const { data } = await client().post(
      `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      { cancel_at_cycle_end: atCycleEnd ? 1 : 0 }
    );
    return data;
  } catch (err) { throw _wrap(err, 'cancelSubscription'); }
}

// ── Signature verification ───────────────────────────────────────────────────

/**
 * The handshake Checkout hands back on a successful subscription authorisation:
 * HMAC-SHA256( razorpay_payment_id + '|' + subscription_id , key_secret ).
 * Constant-time compare — a plain === leaks which prefix bytes matched.
 */
function verifyCheckoutSignature({ razorpay_payment_id, razorpay_subscription_id, razorpay_signature }) {
  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) return false;
  const expected = crypto
    .createHmac('sha256', keySecret())
    .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(razorpay_signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Webhook: HMAC-SHA256( raw request body , RAZORPAY_WEBHOOK_SECRET ). */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = webhookSecret();
  if (!secret || !signatureHeader || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * A subscription state we treat as "paid up / in good standing".
 * `authenticated` = card is on file (Checkout auth completed) and the trial has
 * not yet ended. `created` is NOT healthy: it means the subscription exists but
 * the customer never authorised a card — treating it as good standing let an
 * abandoned Checkout flip a past_due clinic back to active with no payment.
 */
function isHealthyStatus(status) {
  return status === 'active' || status === 'authenticated';
}

module.exports = {
  isConfigured,
  keyId,
  planIdFor,
  createCustomer,
  createSubscription,
  updateSubscription,
  fetchSubscription,
  cancelSubscription,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  isHealthyStatus,
};
