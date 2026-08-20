'use strict';
/**
 * DB-free unit tests for shouldRouteToTest (routes/webhook.js).
 *
 * One WhatsApp number means Meta delivers every message to ONE webhook, so the
 * dev/prod split is decided in code — inside the production message path. That
 * makes this the highest-consequence branch in the system that a patient never
 * sees: get it wrong and a real clinic's patient is answered by a test
 * environment, or silently answered by nobody.
 *
 * The rules it pins:
 *
 *   1. A code on TEST_ENTRY_CODES always goes to dev. That is the typed demo
 *      shortcut, and it must not resolve in production even if a clinic is one
 *      day created there with the same code.
 *   2. A code production KNOWS stays in production — checked WITHOUT a status
 *      filter, so a suspended clinic is still production's to answer for rather
 *      than leaking into dev because somebody paused it.
 *   3. Anything else falls through to dev: either a dev clinic's QR, or a typo,
 *      and dev answers "that code didn't match a clinic" in the same words.
 *   4. Only the FIRST message of a conversation carries a code, so a codeless
 *      message follows the stored affinity — and a NEW code re-decides, which
 *      is how scanning a real clinic's poster pulls a phone back out of dev.
 *   5. Every uncertainty resolves to PRODUCTION. A failed lookup, a missing
 *      Redis, an unreadable message: all of them mean "production handles it".
 *      Silence would be indistinguishable from a patient who never wrote.
 *
 * Run: node tests/devRouting.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_QUEUE = 'true';
process.env.JWT_SECRET = 'unit-test-secret-at-least-32-chars-long!!';
// Read at module load, so these must be set BEFORE webhook.js is required.
process.env.TEST_ROUTE_URL = 'https://dev.example.invalid/api/webhook/whatsapp';
process.env.TEST_ENTRY_CODES = 'TRYMED';

const path = require('path');
const assert = require('assert');

// ── Scenario knobs, reset per test ────────────────────────────
const world = {
  prodKnowsCode: false,   // does production's `tenants` hold this entry_code?
  lookupThrows: false,    // the entry-code lookup fails outright
  redis: new Map(),       // phone -> '1' affinity
  redisDown: false,       // getClient() returns null (REDIS_URL unset)
  redisThrows: false,     // Redis is configured but erroring
};

function rows(r) { return { rows: r, rowCount: r.length }; }

async function routeQuery(sql) {
  const q = String(sql).replace(/\s+/g, ' ').trim();
  if (q.includes('FROM tenants WHERE entry_code')) {
    if (world.lookupThrows) throw new Error('connection terminated');
    return rows(world.prodKnowsCode ? [{ '?column?': 1 }] : []);
  }
  return rows([]);
}

const mockDb = {
  pool: { connect: async () => { throw new Error('not used'); }, query: routeQuery, on() {}, totalCount: 0, options: { max: 20 } },
  query: (sql, params) => routeQuery(sql, params),
  tenantQuery: async () => rows([]),
  tenantTransaction: async () => { throw new Error('not used'); },
};
const dbPath = path.resolve(__dirname, '../src/db/index.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const mockRedis = {
  isRedisConfigured: () => !world.redisDown,
  getClient: () => {
    if (world.redisDown) return null;
    return {
      async get(k) { if (world.redisThrows) throw new Error('redis down'); return world.redis.get(k) || null; },
      async set(k, v) { if (world.redisThrows) throw new Error('redis down'); world.redis.set(k, v); },
      async del(k) { if (world.redisThrows) throw new Error('redis down'); world.redis.delete(k); },
    };
  },
  incrWithTTL: async () => 1,
  redisHealthCheck: async () => true,
  closeClient: () => {},
};
const redisPath = path.resolve(__dirname, '../src/utils/redisClient.js');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: mockRedis };

const { shouldRouteToTest } = require('../src/routes/webhook');

const PHONE = '919812345678';
const text = body => ({ type: 'text', from: PHONE, text: { body } });

function scenario(overrides) {
  Object.assign(world, {
    prodKnowsCode: false, lookupThrows: false, redisDown: false, redisThrows: false,
  }, overrides);
  if (!overrides || !overrides.keepRedis) world.redis = new Map();
}

async function run() {
  let pass = 0, fail = 0;
  const test = async (name, fn) => {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  };

  console.log('\nshouldRouteToTest — which environment answers the patient\n');

  await test('a TEST_ENTRY_CODES code goes to dev even when production knows it', async () => {
    scenario({ prodKnowsCode: true });   // a clinic in prod holding TRYMED must not win
    assert.strictEqual(await shouldRouteToTest(PHONE, text('TRYMED')), true);
  });

  await test('the demo code is matched case-insensitively and through separators', async () => {
    scenario({});
    assert.strictEqual(await shouldRouteToTest(PHONE, text('trymed')), true);
    assert.strictEqual(await shouldRouteToTest(PHONE, text('#TRYMED')), true);
    assert.strictEqual(await shouldRouteToTest(PHONE, text(' try-med ')), true);
  });

  await test('a code production knows stays in production', async () => {
    scenario({ prodKnowsCode: true });
    assert.strictEqual(await shouldRouteToTest(PHONE, text('#ABCDEF')), false);
  });

  await test('a code nobody knows falls through to dev', async () => {
    scenario({ prodKnowsCode: false });
    assert.strictEqual(await shouldRouteToTest(PHONE, text('#ZZZZZZ')), true);
  });

  await test('a codeless message follows the affinity set by the code before it', async () => {
    scenario({});
    await shouldRouteToTest(PHONE, text('TRYMED'));            // claims the phone
    assert.strictEqual(await shouldRouteToTest(PHONE, text('book')), true);
    assert.strictEqual(await shouldRouteToTest(PHONE, text('yes')), true);
  });

  await test('a real clinic code pulls a phone back OUT of dev', async () => {
    scenario({});
    await shouldRouteToTest(PHONE, text('TRYMED'));            // in dev
    world.prodKnowsCode = true;
    // A VALID code: the alphabet excludes L/I/O/U, so '#REALCD' would not parse
    // as a code at all and would have followed affinity straight back to dev.
    assert.strictEqual(await shouldRouteToTest(PHONE, text('#ABCDEF')), false);
    // …and stays out for the rest of the conversation.
    assert.strictEqual(await shouldRouteToTest(PHONE, text('yes')), false);
  });

  await test('a codeless message from an unknown phone goes to production', async () => {
    scenario({});
    assert.strictEqual(await shouldRouteToTest(PHONE, text('hello')), false);
  });

  await test('a failed entry-code lookup keeps the patient in production', async () => {
    scenario({ lookupThrows: true });
    assert.strictEqual(await shouldRouteToTest(PHONE, text('#ABCDEF')), false);
  });

  await test('no Redis means codeless messages go to production, never nowhere', async () => {
    scenario({ redisDown: true });
    assert.strictEqual(await shouldRouteToTest(PHONE, text('hello')), false);
    // A test code still routes: that decision needs no affinity to make.
    assert.strictEqual(await shouldRouteToTest(PHONE, text('TRYMED')), true);
  });

  await test('a throwing Redis fails open to production rather than propagating', async () => {
    scenario({ redisThrows: true });
    assert.strictEqual(await shouldRouteToTest(PHONE, text('hello')), false);
  });

  await test('a non-text message carries no code and follows affinity only', async () => {
    scenario({});
    const interactive = { type: 'interactive', from: PHONE, interactive: { button_reply: { title: 'TRYMED' } } };
    // Even though the button TITLE reads like the demo code, it is not a scan.
    assert.strictEqual(await shouldRouteToTest(PHONE, interactive), false);
  });

  await test('a message with no text body at all does not throw', async () => {
    scenario({});
    assert.strictEqual(await shouldRouteToTest(PHONE, { type: 'text', from: PHONE }), false);
    assert.strictEqual(await shouldRouteToTest(PHONE, {}), false);
  });

  console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

run().catch(err => { console.error('Suite crashed:', err); process.exit(1); });
