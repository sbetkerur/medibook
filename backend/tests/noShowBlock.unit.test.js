'use strict';
/**
 * DB-free unit test for the repeat-no-show self-booking gate
 * (services/bot/utils.js noShowBlock).
 *
 * A clinic opts in with settings.noshow_block_threshold > 0. Past that many
 * missed appointments (since the patient's last completed visit, within the
 * window), the bot hands the patient to the front desk instead of self-booking.
 * 0 / unset = off, and the check must fail OPEN on any error.
 *
 * Mocks src/db before bot/utils.js loads and calls noShowBlock() directly.
 *
 * Run: node tests/noShowBlock.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'unit-test-secret-at-least-32-chars-long!!';

const path = require('path');
const assert = require('assert');

// ── knobs the individual cases set ─────────────────────────────
let mockSettings = {};        // what SELECT settings FROM tenants returns
let mockNoShowCount = 0;      // what the COUNT(*) query returns
let throwOnTenantsRead = false;
let throwOnCount = false;
let captured = {};            // last params seen by the count query
let countQueryRan = false;    // did the COUNT(*) no-show query execute at all

function rows(r) { return { rows: r, rowCount: r.length }; }

async function routeQuery(sql, params = []) {
  const q = String(sql).replace(/\s+/g, ' ').trim();

  if (q.startsWith('SELECT settings FROM tenants')) {
    if (throwOnTenantsRead) throw new Error('tenants read boom');
    return rows([{ settings: mockSettings }]);
  }
  if (q.includes("a.status = 'no_show'") && q.includes('FROM appointments a')) {
    countQueryRan = true;
    if (throwOnCount) throw new Error('count boom');
    captured.phone = params[0];
    captured.win = params[1];
    // The "since last completed visit" guard must be part of the query.
    assert(q.includes("a2.status = 'completed'"),
      'count query is missing the "since last completed visit" filter');
    return rows([{ n: mockNoShowCount }]);
  }
  return rows([]);
}

const mockDb = {
  pool: { connect: async () => ({ query: routeQuery, release() {} }), query: routeQuery, on() {} },
  query: (sql, params) => routeQuery(sql, params),
  tenantQuery: (_schema, sql, params) => routeQuery(sql, params),
  tenantTransaction: async (_schema, cb) => cb({ query: routeQuery, release() {} }),
  validateSchemaName: (s) => { if (!/^tenant_[a-z0-9_]+$/.test(s || '')) throw new Error(`Invalid schema: ${s}`); },
};

const dbPath = path.resolve(__dirname, '../src/db/index.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { noShowBlock } = require('../src/services/bot/utils');

const SCHEMA = 'tenant_demo';
const PHONE = '919222222222';

function reset() {
  mockSettings = {};
  mockNoShowCount = 0;
  throwOnTenantsRead = false;
  throwOnCount = false;
  captured = {};
  countQueryRan = false;
}

async function run() {
  let pass = 0, fail = 0;
  const test = async (name, fn) => {
    reset();
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  };

  console.log('Repeat-no-show gate unit tests\n');

  await test('off by default — no threshold set, never blocks and never counts', async () => {
    const r = await noShowBlock(SCHEMA, PHONE);
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(countQueryRan, false, 'must not run the count query when the feature is off');
  });

  await test('threshold 0 is treated as off', async () => {
    mockSettings = { noshow_block_threshold: 0 };
    const r = await noShowBlock(SCHEMA, PHONE);
    assert.strictEqual(r.blocked, false);
  });

  await test('below threshold — not blocked', async () => {
    mockSettings = { noshow_block_threshold: 3 };
    mockNoShowCount = 2;
    const r = await noShowBlock(SCHEMA, PHONE);
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(r.count, 2);
  });

  await test('at threshold — blocked', async () => {
    mockSettings = { noshow_block_threshold: 3 };
    mockNoShowCount = 3;
    const r = await noShowBlock(SCHEMA, PHONE);
    assert.strictEqual(r.blocked, true);
    assert.strictEqual(r.count, 3);
  });

  await test('above threshold — blocked', async () => {
    mockSettings = { noshow_block_threshold: 2 };
    mockNoShowCount = 9;
    const r = await noShowBlock(SCHEMA, PHONE);
    assert.strictEqual(r.blocked, true);
  });

  await test('window defaults to 180 days when unset', async () => {
    mockSettings = { noshow_block_threshold: 3 };
    await noShowBlock(SCHEMA, PHONE);
    assert.strictEqual(captured.win, 180);
  });

  await test('a valid custom window is passed through', async () => {
    mockSettings = { noshow_block_threshold: 3, noshow_block_window_days: 90 };
    await noShowBlock(SCHEMA, PHONE);
    assert.strictEqual(captured.win, 90);
  });

  await test('a too-small custom window falls back to 180', async () => {
    mockSettings = { noshow_block_threshold: 3, noshow_block_window_days: 5 };
    await noShowBlock(SCHEMA, PHONE);
    assert.strictEqual(captured.win, 180);
  });

  await test('fails OPEN when the tenants settings read throws', async () => {
    throwOnTenantsRead = true;
    const r = await noShowBlock(SCHEMA, PHONE);
    assert.strictEqual(r.blocked, false);
  });

  await test('fails OPEN when the count query throws', async () => {
    mockSettings = { noshow_block_threshold: 1 };
    throwOnCount = true;
    const r = await noShowBlock(SCHEMA, PHONE);
    assert.strictEqual(r.blocked, false);
  });

  await test('non-numeric threshold is ignored (treated as off)', async () => {
    mockSettings = { noshow_block_threshold: 'lots' };
    mockNoShowCount = 50;
    const r = await noShowBlock(SCHEMA, PHONE);
    assert.strictEqual(r.blocked, false);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
