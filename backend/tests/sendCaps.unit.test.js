'use strict';
/**
 * Staged outbound caps for young tenants (services/sendCaps.js).
 *
 * Self-serve signup lets clinics we have never spoken to send on the shared
 * WhatsApp number within minutes. This is the ceiling that keeps a fresh one
 * from blasting it — 100/24h for the first week, 300 for the first month, then
 * uncapped — and it MUST fail open (a cap check that errors must not silence a
 * clinic).
 *
 * Run: node tests/sendCaps.unit.test.js   (no Postgres/Redis required)
 */
process.env.NODE_ENV = 'test';

const assert = require('assert');

// Stub ../src/db before sendCaps loads it.
//   query()       → the tenant's age row (SELECT COALESCE(activated_at,created_at))
//   tenantQuery() → the rolling-24h wa_messages count
let ageSince = null;        // ISO string or null
let sentLast24h = 0;
let ageQueryThrows = false;
let countQueryThrows = false;

const dbPath = require.resolve('../src/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async () => {
      if (ageQueryThrows) throw new Error('db down');
      return { rows: [{ since: ageSince }], rowCount: 1 };
    },
    tenantQuery: async () => {
      if (countQueryThrows) throw new Error('db down');
      return { rows: [{ n: sentLast24h }], rowCount: 1 };
    },
  },
};

const { withinDailyCap, dailyCapFor, TIERS, _clearCache } = require('../src/services/sendCaps');

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

let pass = 0, fail = 0;
async function test(name, fn) {
  _clearCache();
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
}

(async () => {
  console.log('sendCaps unit tests\n');

  await test('TIERS is the agreed shape: 100 (<7d), 300 (<30d)', () => {
    assert.deepStrictEqual(TIERS, [
      { maxAgeDays: 7, cap: 100 },
      { maxAgeDays: 30, cap: 300 },
    ]);
  });

  await test('a 2-day-old tenant is capped at 100', async () => {
    ageSince = daysAgo(2);
    assert.strictEqual(await dailyCapFor('tenant_x'), 100);
  });

  await test('a 20-day-old tenant is capped at 300', async () => {
    ageSince = daysAgo(20);
    assert.strictEqual(await dailyCapFor('tenant_x'), 300);
  });

  await test('a 45-day-old tenant is uncapped (null)', async () => {
    ageSince = daysAgo(45);
    assert.strictEqual(await dailyCapFor('tenant_x'), null);
  });

  await test('exactly 7 days old has crossed into the 300 tier', async () => {
    ageSince = daysAgo(7.01);
    assert.strictEqual(await dailyCapFor('tenant_x'), 300);
  });

  await test('withinDailyCap allows a young tenant below its ceiling', async () => {
    ageSince = daysAgo(1); sentLast24h = 99;
    assert.strictEqual(await withinDailyCap('tenant_x'), true);
  });

  await test('withinDailyCap blocks a young tenant AT its ceiling', async () => {
    ageSince = daysAgo(1); sentLast24h = 100;
    assert.strictEqual(await withinDailyCap('tenant_x'), false);
  });

  await test('withinDailyCap never blocks a matured tenant, whatever the volume', async () => {
    ageSince = daysAgo(400); sentLast24h = 99999;
    assert.strictEqual(await withinDailyCap('tenant_x'), true);
  });

  await test('FAILS OPEN when the age lookup errors', async () => {
    ageQueryThrows = true;
    assert.strictEqual(await withinDailyCap('tenant_x'), true);
    ageQueryThrows = false;
  });

  await test('FAILS OPEN when the count query errors', async () => {
    ageSince = daysAgo(1); countQueryThrows = true;
    assert.strictEqual(await withinDailyCap('tenant_x'), true);
    countQueryThrows = false;
  });

  await test('a tenant with no created_at at all is treated as uncapped', async () => {
    ageSince = null;
    assert.strictEqual(await dailyCapFor('tenant_x'), null);
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
