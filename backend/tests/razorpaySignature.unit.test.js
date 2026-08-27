'use strict';
/**
 * Razorpay signature verification — the two HMACs the self-serve billing flow
 * leans on.
 *
 *   - verifyCheckoutSignature: HMAC-SHA256(payment_id + '|' + subscription_id, key_secret)
 *     is what Razorpay Checkout hands back when a card is authorised. If this is
 *     wrong, a forged client call flips a clinic to "paid".
 *   - verifyWebhookSignature: HMAC-SHA256(raw body, webhook_secret) on every
 *     subscription.* event. If this is wrong, anyone who can POST to the webhook
 *     can suspend or un-suspend any clinic.
 *
 * Both must be constant-time and reject on any mismatch, wrong length, or
 * missing input.
 *
 * Run: node tests/razorpaySignature.unit.test.js   (no Postgres/Redis/Razorpay)
 */
process.env.NODE_ENV = 'test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123';
process.env.RAZORPAY_KEY_SECRET = 'secret_key_value';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_value';
process.env.RAZORPAY_PLAN_STARTER = 'plan_starter_x';
process.env.RAZORPAY_PLAN_PROFESSIONAL = 'plan_pro_x';

const assert = require('assert');
const crypto = require('crypto');
const rzp = require('../src/services/razorpay');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
}

const hmac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('hex');

console.log('Razorpay signature unit tests\n');

test('isConfigured is true for a real rzp_test_ key', () => {
  assert.strictEqual(rzp.isConfigured(), true);
});

test('isConfigured is false for a placeholder key', () => {
  const saved = process.env.RAZORPAY_KEY_ID;
  process.env.RAZORPAY_KEY_ID = 'your_key_id_here';
  // module already cached — call the function which re-reads env each time
  assert.strictEqual(rzp.isConfigured(), false);
  process.env.RAZORPAY_KEY_ID = saved;
});

test('planIdFor maps the two tiers and nothing else', () => {
  assert.strictEqual(rzp.planIdFor('starter'), 'plan_starter_x');
  assert.strictEqual(rzp.planIdFor('professional'), 'plan_pro_x');
  assert.strictEqual(rzp.planIdFor('enterprise'), null);
});

test('isHealthyStatus accepts active/authenticated only', () => {
  ['active', 'authenticated'].forEach(s =>
    assert.strictEqual(rzp.isHealthyStatus(s), true, s));
  // 'created' = subscription exists but no card authorised — NOT good standing.
  ['created', 'halted', 'cancelled', 'pending', 'expired', 'completed', undefined].forEach(s =>
    assert.strictEqual(rzp.isHealthyStatus(s), false, String(s)));
});

// ── Checkout signature ──────────────────────────────────────
test('verifyCheckoutSignature accepts a correctly-signed triple', () => {
  const payment_id = 'pay_123', subscription_id = 'sub_456';
  const sig = hmac(`${payment_id}|${subscription_id}`, process.env.RAZORPAY_KEY_SECRET);
  assert.strictEqual(rzp.verifyCheckoutSignature({
    razorpay_payment_id: payment_id,
    razorpay_subscription_id: subscription_id,
    razorpay_signature: sig,
  }), true);
});

test('verifyCheckoutSignature rejects a tampered payment id', () => {
  const sig = hmac('pay_123|sub_456', process.env.RAZORPAY_KEY_SECRET);
  assert.strictEqual(rzp.verifyCheckoutSignature({
    razorpay_payment_id: 'pay_999',
    razorpay_subscription_id: 'sub_456',
    razorpay_signature: sig,
  }), false);
});

test('verifyCheckoutSignature rejects the wrong secret', () => {
  const sig = hmac('pay_123|sub_456', 'not_the_secret');
  assert.strictEqual(rzp.verifyCheckoutSignature({
    razorpay_payment_id: 'pay_123',
    razorpay_subscription_id: 'sub_456',
    razorpay_signature: sig,
  }), false);
});

test('verifyCheckoutSignature rejects missing fields', () => {
  assert.strictEqual(rzp.verifyCheckoutSignature({}), false);
  assert.strictEqual(rzp.verifyCheckoutSignature({ razorpay_payment_id: 'x' }), false);
});

test('verifyCheckoutSignature rejects a short/garbage signature without throwing', () => {
  assert.strictEqual(rzp.verifyCheckoutSignature({
    razorpay_payment_id: 'pay_123', razorpay_subscription_id: 'sub_456', razorpay_signature: 'abc',
  }), false);
});

// ── Webhook signature ──────────────────────────────────────
test('verifyWebhookSignature accepts a correctly-signed body', () => {
  const body = Buffer.from(JSON.stringify({ event: 'subscription.charged' }));
  const sig = hmac(body, process.env.RAZORPAY_WEBHOOK_SECRET);
  assert.strictEqual(rzp.verifyWebhookSignature(body, sig), true);
});

test('verifyWebhookSignature rejects a body that changed by one byte', () => {
  const body = Buffer.from(JSON.stringify({ event: 'subscription.charged' }));
  const sig = hmac(body, process.env.RAZORPAY_WEBHOOK_SECRET);
  const tampered = Buffer.from(JSON.stringify({ event: 'subscription.halted' }));
  assert.strictEqual(rzp.verifyWebhookSignature(tampered, sig), false);
});

test('verifyWebhookSignature rejects when the secret is unset', () => {
  const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  const body = Buffer.from('{}');
  assert.strictEqual(rzp.verifyWebhookSignature(body, hmac(body, 'x')), false);
  process.env.RAZORPAY_WEBHOOK_SECRET = saved;
});

test('verifyWebhookSignature rejects a missing signature header', () => {
  assert.strictEqual(rzp.verifyWebhookSignature(Buffer.from('{}'), undefined), false);
});

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
