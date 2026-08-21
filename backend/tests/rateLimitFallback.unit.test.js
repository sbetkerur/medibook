'use strict';
/**
 * The per-tenant rate limiter with no Redis configured.
 *
 * REDIS_URL is documented as OPTIONAL, and utils/redisClient.js states that
 * callers "already treat a throw as fall back to the in-process limiter". The
 * limiter did not: incrWithTTL threw REDIS_NOT_CONFIGURED on every request, the
 * catch logged a warning and called next(), and a Redis-less deployment ran with
 * no per-tenant limit at all — plan cap, 90%-usage alert and IP-abuse block all
 * unreachable — while writing one warn line per request to disk.
 *
 * Run: node tests/rateLimitFallback.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL; // the condition under test

const assert = require('assert');

// db is only used for the IP-block lookup and abuse recording; stub both.
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: async () => ({ rows: [], rowCount: 0 }) },
};

const tenantRateLimit = require('../src/middleware/tenantRateLimit');

const STARTER_LIMIT = 60;

/** Drive one request through the middleware and report what happened. */
async function hit(tenantId = 't-1', plan = 'starter') {
  const res = {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let nexted = false;
  await tenantRateLimit(
    { user: { tenant_id: tenantId }, tenant: { id: tenantId, plan, settings: {} }, path: '/appointments', ip: '1.2.3.4' },
    res,
    () => { nexted = true },
  );
  return { allowed: nexted, status: res.statusCode, body: res.body, headers: res.headers };
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
}

(async () => {
  console.log('Tenant rate limit — no-Redis fallback\n');

  await test('requests under the plan limit are allowed and counted', async () => {
    const first = await hit('t-under');
    assert.strictEqual(first.allowed, true);
    assert.strictEqual(first.headers['X-RateLimit-Limit'], STARTER_LIMIT,
      'the limit header must still be reported without Redis');
    assert.strictEqual(first.headers['X-RateLimit-Remaining'], STARTER_LIMIT - 1,
      'the counter is not advancing — this is the "no limit at all" bug');
  });

  // ── The regression this file exists for ────────────────────────
  await test('the plan limit is actually ENFORCED without Redis', async () => {
    for (let i = 0; i < STARTER_LIMIT; i++) await hit('t-cap');
    const overflow = await hit('t-cap');
    assert.strictEqual(overflow.allowed, false,
      'request 61 of 60 was allowed through — the tenant is unlimited');
    assert.strictEqual(overflow.status, 429);
    assert.strictEqual(overflow.body.limit, STARTER_LIMIT);
  });

  await test('one tenant exhausting its budget does not limit another', async () => {
    for (let i = 0; i < STARTER_LIMIT + 5; i++) await hit('t-noisy');
    const other = await hit('t-quiet');
    assert.strictEqual(other.allowed, true, 'counters must be per tenant, not global');
  });

  await test('the professional tier gets its higher ceiling', async () => {
    for (let i = 0; i < STARTER_LIMIT + 1; i++) await hit('t-pro', 'professional');
    const next = await hit('t-pro', 'professional');
    assert.strictEqual(next.allowed, true, 'a professional tenant was capped at the starter limit');
    assert.strictEqual(next.headers['X-RateLimit-Limit'], 300);
  });

  await test('a request with no tenant is passed straight through', async () => {
    let nexted = false;
    await tenantRateLimit({ user: {}, path: '/x' }, { setHeader() {} }, () => { nexted = true });
    assert.strictEqual(nexted, true);
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
