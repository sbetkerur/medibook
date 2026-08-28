'use strict';
/**
 * Trial outbound cap for self-serve tenants (services/sendCaps.js).
 *
 * Self-serve signup lets clinics we have never spoken to send on the shared
 * WhatsApp number within minutes. This is the ceiling that keeps a trial one
 * from blasting it — 50/24h while on the card-free trial, uncapped the moment a
 * live subscription is attached (and uncapped for super-admin-provisioned
 * clinics, which went through a human). It MUST fail open (a cap check that
 * errors must not silence a clinic).
 *
 * Run: node tests/sendCaps.unit.test.js   (no Postgres/Redis required)
 */
process.env.NODE_ENV = 'test';

const assert = require('assert');

// Stub ../src/db before sendCaps loads it.
//   query()       → the tenants + tenant_billing join
//   tenantQuery() → the rolling-24h wa_messages count
let billingRow = null;      // { signup_source, razorpay_subscription_id, subscription_status } | null
let sentLast24h = 0;
let billingQueryThrows = false;
let countQueryThrows = false;

const dbPath = require.resolve('../src/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async () => {
      if (billingQueryThrows) throw new Error('db down');
      return { rows: billingRow ? [billingRow] : [], rowCount: billingRow ? 1 : 0 };
    },
    tenantQuery: async () => {
      if (countQueryThrows) throw new Error('db down');
      return { rows: [{ n: sentLast24h }], rowCount: 1 };
    },
  },
};

const { withinDailyCap, dailyCapFor, TRIAL_DAILY_CAP, _clearCache } = require('../src/services/sendCaps');

const selfServe = (o = {}) => ({ signup_source: 'self_serve', razorpay_subscription_id: null, subscription_status: 'trialing', ...o });

let pass = 0, fail = 0;
async function test(name, fn) {
  _clearCache();
  billingQueryThrows = false; countQueryThrows = false;
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
}

(async () => {
  console.log('sendCaps unit tests\n');

  await test('TRIAL_DAILY_CAP is 50', () => {
    assert.strictEqual(TRIAL_DAILY_CAP, 50);
  });

  await test('a self-serve tenant on the card-free trial is capped at 50', async () => {
    billingRow = selfServe({ subscription_status: 'trialing' });
    assert.strictEqual(await dailyCapFor('tenant_x'), 50);
  });

  await test('a self-serve tenant with a live subscription is uncapped (null)', async () => {
    billingRow = selfServe({ razorpay_subscription_id: 'sub_123', subscription_status: 'active' });
    assert.strictEqual(await dailyCapFor('tenant_x'), null);
  });

  await test('"authenticated" also counts as paying → uncapped', async () => {
    billingRow = selfServe({ razorpay_subscription_id: 'sub_123', subscription_status: 'authenticated' });
    assert.strictEqual(await dailyCapFor('tenant_x'), null);
  });

  await test('a lapsed trial with no card stays capped at 50', async () => {
    billingRow = selfServe({ razorpay_subscription_id: null, subscription_status: 'trial_ended' });
    assert.strictEqual(await dailyCapFor('tenant_x'), 50);
  });

  await test('a subscription id with an UNhealthy status is still capped', async () => {
    billingRow = selfServe({ razorpay_subscription_id: 'sub_123', subscription_status: 'halted' });
    assert.strictEqual(await dailyCapFor('tenant_x'), 50);
  });

  await test('a super-admin-provisioned tenant is never capped', async () => {
    billingRow = { signup_source: 'admin', razorpay_subscription_id: null, subscription_status: null };
    assert.strictEqual(await dailyCapFor('tenant_x'), null);
  });

  await test('withinDailyCap allows a trial tenant below its ceiling', async () => {
    billingRow = selfServe(); sentLast24h = 49;
    assert.strictEqual(await withinDailyCap('tenant_x'), true);
  });

  await test('withinDailyCap blocks a trial tenant AT its ceiling', async () => {
    billingRow = selfServe(); sentLast24h = 50;
    assert.strictEqual(await withinDailyCap('tenant_x'), false);
  });

  await test('withinDailyCap never blocks a paying tenant, whatever the volume', async () => {
    billingRow = selfServe({ razorpay_subscription_id: 'sub_123', subscription_status: 'active' });
    sentLast24h = 99999;
    assert.strictEqual(await withinDailyCap('tenant_x'), true);
  });

  await test('FAILS OPEN when the billing lookup errors', async () => {
    billingQueryThrows = true;
    assert.strictEqual(await withinDailyCap('tenant_x'), true);
  });

  await test('FAILS OPEN when the count query errors', async () => {
    billingRow = selfServe(); countQueryThrows = true;
    assert.strictEqual(await withinDailyCap('tenant_x'), true);
  });

  await test('an unknown schema (no row) is treated as uncapped', async () => {
    billingRow = null;
    assert.strictEqual(await dailyCapFor('tenant_x'), null);
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
