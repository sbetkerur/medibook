'use strict';
/**
 * DB-free unit test for the standing open-appointment cap.
 *
 * bookingFlow.completeBooking already rate-limits BOOKINGS PER HOUR per phone
 * (LIMITS.MAX_BOOKINGS_PER_HOUR) — that stops a burst, not the same abuse
 * spread out slowly enough to dodge it (one booking every 20 minutes still
 * reaches dozens of held slots by end of day). This pins the second,
 * independent gate: a standing cap on how many CONFIRMED appointments a phone
 * may hold at once, WhatsApp-only (LIMITS.MAX_OPEN_APPOINTMENTS_PER_PHONE).
 *
 * Run: node tests/openAppointmentCap.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_QUEUE = 'true';
process.env.JWT_SECRET = 'unit-test-secret-at-least-32-chars-long!!';

const path = require('path');
const assert = require('assert');

function rows(r) { return { rows: r, rowCount: r.length }; }

// Controllable per-test — how many CONFIRMED appointments the open-cap query
// should report for this phone. Default 0 keeps unrelated code paths clean.
let mockOpenCount = 0;

const sessions = new Map();

async function routeQuery(sql) {
  const q = String(sql).replace(/\s+/g, ' ').trim();

  if (q.startsWith('INSERT INTO bot_sessions')) return rows([]);
  if (q.startsWith('SELECT * FROM bot_sessions')) return rows([]);

  // Two queries share the "COUNT(*) FROM appointments a JOIN patients p"
  // shape — the hourly rate limit (has its own time window) and the standing
  // open-appointment cap this file tests (no time window). Keep the rate
  // limit permanently unlatched here so it never masks what this file is
  // actually checking.
  if (q.includes('COUNT(*) FROM appointments a') && q.includes('JOIN patients p')) {
    if (q.includes("INTERVAL '1 hour'")) return rows([{ count: '0' }]);
    return rows([{ count: String(mockOpenCount) }]);
  }

  return rows([]);
}

// pool.connect() is called ONLY after every pre-flight check (schema
// validation, rate limit, THIS cap, monthly quota) passes — never reached
// when the cap blocks. A sentinel rejection here is the signal that the code
// proceeded past the check under test, without needing to mock the entire
// booking transaction just to prove that.
const mockDb = {
  tenantQuery: (_schema, sql, params) => routeQuery(sql, params),
  query: (sql, params) => routeQuery(sql, params),
  pool: { connect: async () => { throw new Error('POOL_CONNECT_REACHED'); } },
  validateSchemaName: (schema) => {
    if (!schema || !/^tenant_[a-z0-9_]+$/.test(schema)) throw new Error('bad schema');
  },
};
const dbPath = path.resolve(__dirname, '../src/db/index.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const wa = require('../src/services/whatsapp');
const sent = [];
wa.sendText = async (to, text) => { sent.push(text); };

const { completeBooking } = require('../src/services/bot/bookingFlow');
const { LIMITS } = require('../src/utils/errors');

const SCHEMA = 'tenant_demo';
const PHONE = '919333333333';
const tenant = { id: 't-1', slug: 'demo', name: 'Demo Clinic', schema_name: SCHEMA, plan: 'starter', settings: {} };
const send = { text: async (t) => { await wa.sendText(PHONE, t); } };

async function run() {
  let pass = 0, fail = 0;
  async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  }

  console.log('\nOpen-appointment cap unit tests\n');

  await test(`at the cap (${LIMITS.MAX_OPEN_APPOINTMENTS_PER_PHONE} open) blocks the booking before it touches the DB`, async () => {
    mockOpenCount = LIMITS.MAX_OPEN_APPOINTMENTS_PER_PHONE;
    sent.length = 0;
    // Should return normally (not throw) — blocked BEFORE pool.connect(), so
    // the POOL_CONNECT_REACHED sentinel must never fire here.
    await completeBooking(PHONE, SCHEMA, tenant, send, { hospital_id: 'hosp-1' });
    assert(sent.some(t => new RegExp(`already have ${LIMITS.MAX_OPEN_APPOINTMENTS_PER_PHONE}`).test(t)),
      'expected the cap message, got: ' + JSON.stringify(sent));
    assert(sent.some(t => /nothing new was booked/i.test(t)),
      'the block must say nothing was booked: ' + JSON.stringify(sent));
  });

  await test('above the cap also blocks (>=, not ==)', async () => {
    mockOpenCount = LIMITS.MAX_OPEN_APPOINTMENTS_PER_PHONE + 5;
    sent.length = 0;
    await completeBooking(PHONE, SCHEMA, tenant, send, { hospital_id: 'hosp-1' });
    assert(sent.some(t => /already have/.test(t)), 'expected the cap message: ' + JSON.stringify(sent));
  });

  await test('one below the cap is NOT blocked here — the flow proceeds past this check', async () => {
    mockOpenCount = LIMITS.MAX_OPEN_APPOINTMENTS_PER_PHONE - 1;
    sent.length = 0;
    // No cap message, and the sentinel from pool.connect() proves execution
    // reached past the rate-limit AND open-cap checks (both pre-flight, both
    // before pool.connect()) — a real DB would continue into the booking
    // transaction from here.
    await assert.rejects(
      completeBooking(PHONE, SCHEMA, tenant, send, { hospital_id: 'hosp-1' }),
      /POOL_CONNECT_REACHED/,
      'expected the flow to proceed past the open-cap check'
    );
    assert(!sent.some(t => /already have/.test(t)), 'should not have been blocked: ' + JSON.stringify(sent));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
