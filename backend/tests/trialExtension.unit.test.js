'use strict';
/**
 * Ad-hoc trial extension (utils/trialExtension.js), behind
 * POST /superadmin/tenants/:id/extend-trial.
 *
 * The trial is written once by /approve and then only ever ENDED by
 * jobs/billingDunning.js. These are the pure pieces the new route composes:
 *
 *  1. Only a card-free, self-serve trial can be extended — a paying clinic (has
 *     a Razorpay subscription) or one not on a trial is refused with a reason.
 *  2. "Give them N more days" means a FULL N days: added to the current end if
 *     the trial is still running, run from now if it has already lapsed.
 *  3. Extending un-lapses a clinic ONLY if it sits in the exact state the
 *     dunning cron leaves — `past_due` + `suspension_reason='trial_ended'`. A
 *     `past_due` for a real payment failure is left alone.
 *
 * Run: node tests/trialExtension.unit.test.js   (no Postgres/Redis)
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const {
  trialExtensionGuard, nextTrialEnd, shouldRelapseToActive, MAX_EXTENSION_DAYS,
} = require('../src/utils/trialExtension');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
}

console.log('\nAd-hoc trial extension (utils/trialExtension.js)\n');

// ── guard ────────────────────────────────────────────────────
test('refuses a clinic with no billing row', () => {
  const g = trialExtensionGuard({ billing: null });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.code, 'NO_BILLING');
});

test('refuses a clinic that already has a Razorpay subscription', () => {
  const g = trialExtensionGuard({ billing: { razorpay_subscription_id: 'sub_123', subscription_status: 'active' } });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.code, 'HAS_SUBSCRIPTION');
});

test('refuses a clinic whose billing status is not a trial state', () => {
  for (const s of ['active', 'cancelled', 'halted', null]) {
    const g = trialExtensionGuard({ billing: { subscription_status: s } });
    assert.strictEqual(g.ok, false, `status ${s}`);
    assert.strictEqual(g.code, 'NOT_TRIALING');
  }
});

test('allows a clinic that is still trialing', () => {
  assert.strictEqual(trialExtensionGuard({ billing: { subscription_status: 'trialing' } }).ok, true);
});

test('allows a clinic whose trial just lapsed (trial_ended)', () => {
  assert.strictEqual(trialExtensionGuard({ billing: { subscription_status: 'trial_ended' } }).ok, true);
});

// ── nextTrialEnd ─────────────────────────────────────────────
const NOW = new Date('2026-09-02T09:00:00Z');

test('running trial: days are added to the existing end', () => {
  const out = nextTrialEnd('2026-09-10T09:00:00Z', 14, NOW);
  assert.strictEqual(out.toISOString(), '2026-09-24T09:00:00.000Z');
});

test('lapsed trial: days run from now, not from the old end', () => {
  const out = nextTrialEnd('2026-08-20T09:00:00Z', 14, NOW);
  assert.strictEqual(out.toISOString(), '2026-09-16T09:00:00.000Z');
});

test('null trial_end (placeholder row): days run from now', () => {
  const out = nextTrialEnd(null, 7, NOW);
  assert.strictEqual(out.toISOString(), '2026-09-09T09:00:00.000Z');
});

test('a trial ending exactly now counts as lapsed (runs from now)', () => {
  const out = nextTrialEnd(NOW.toISOString(), 1, NOW);
  assert.strictEqual(out.toISOString(), '2026-09-03T09:00:00.000Z');
});

test('rejects zero, negative, fractional, NaN and over-cap day counts', () => {
  for (const d of [0, -1, 1.5, NaN, MAX_EXTENSION_DAYS + 1, 'abc']) {
    assert.throws(() => nextTrialEnd('2026-09-10T09:00:00Z', d, NOW), RangeError, `days=${d}`);
  }
});

test('coerces a numeric string ("14") like the route does', () => {
  assert.strictEqual(
    nextTrialEnd('2026-09-10T09:00:00Z', '14', NOW).toISOString(),
    '2026-09-24T09:00:00.000Z');
});

test('accepts the maximum allowed extension', () => {
  assert.doesNotThrow(() => nextTrialEnd(null, MAX_EXTENSION_DAYS, NOW));
});

// ── shouldRelapseToActive ────────────────────────────────────
test('un-lapses only past_due + trial_ended', () => {
  assert.strictEqual(shouldRelapseToActive({ status: 'past_due', suspension_reason: 'trial_ended' }), true);
});

test('leaves a payment-failure past_due alone', () => {
  assert.strictEqual(shouldRelapseToActive({ status: 'past_due', suspension_reason: 'payment' }), false);
});

test('does nothing for an already-active clinic', () => {
  assert.strictEqual(shouldRelapseToActive({ status: 'active', suspension_reason: null }), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
