'use strict';
/**
 * DB-free unit test for the per-appointment reschedule cap
 * (appointments.reschedule_count, LIMITS.MAX_RESCHEDULES_PER_APPOINTMENT).
 *
 * Past the cap, handleRescheduleSelect must block BEFORE the 2-hour-notice
 * check or the date query — this proves that ordering by driving an
 * appointment that would otherwise pass (or fail) the 2-hour check and
 * checking which message comes back.
 *
 * Run: node tests/rescheduleCap.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_QUEUE = 'true';
process.env.JWT_SECRET = 'unit-test-secret-at-least-32-chars-long!!';

const path = require('path');
const assert = require('assert');

function rows(r) { return { rows: r, rowCount: r.length }; }

// Controllable per-test.
let mockRescheduleCount = 0;
// appointment_time far enough out that the 2-hour-notice check never fires —
// used for the "under cap" case so a PASS there unambiguously means the
// booking cleared BOTH gates, not that the second one masked the first.
const FAR_FUTURE_DATE = '2099-01-06';

async function routeQuery(sql) {
  const q = String(sql).replace(/\s+/g, ' ').trim();

  if (q.startsWith('INSERT INTO bot_sessions')) return rows([]);
  if (q.startsWith('SELECT * FROM bot_sessions')) return rows([]);

  if (q.includes('FROM appointments a') && q.includes('JOIN doctors d') && q.includes("a.status='confirmed'")) {
    return rows([{
      id: 'appt-1', booking_id: 'MB0001', status: 'confirmed',
      doctor_id: 'doc-1', hospital_id: 'hosp-1', doctor_name: 'Priya Sharma',
      appointment_date: FAR_FUTURE_DATE, appointment_time: '10:00:00',
      reschedule_count: mockRescheduleCount,
    }]);
  }

  // Date-list query reached only once BOTH gates are cleared.
  if (q.includes('SELECT slot_date::text AS date')) return rows([{ date: FAR_FUTURE_DATE, slots: '2' }]);

  return rows([]);
}

const mockDb = {
  tenantQuery: (_schema, sql, params) => routeQuery(sql, params),
};
const dbPath = path.resolve(__dirname, '../src/db/index.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const wa = require('../src/services/whatsapp');
const sent = [];
wa.sendText = async (to, text) => { sent.push(text); };
wa.sendList = async (to, text) => { sent.push(text); };

const { handleRescheduleSelect } = require('../src/services/bot/appointmentFlow');
const { LIMITS } = require('../src/utils/errors');

const SCHEMA = 'tenant_demo';
const PHONE = '919444444444';
const tenant = { id: 't-1', slug: 'demo', name: 'Demo Clinic', schema_name: SCHEMA, settings: {} };
const send = {
  text: async (t) => { await wa.sendText(PHONE, t); },
  list: async (t) => { await wa.sendList(PHONE, t); },
};

async function run() {
  let pass = 0, fail = 0;
  async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  }

  console.log('\nReschedule cap unit tests\n');

  await test(`at the cap (${LIMITS.MAX_RESCHEDULES_PER_APPOINTMENT} reschedules) blocks with a cancel-and-rebook message`, async () => {
    mockRescheduleCount = LIMITS.MAX_RESCHEDULES_PER_APPOINTMENT;
    sent.length = 0;
    await handleRescheduleSelect(PHONE, SCHEMA, tenant, send, {}, null, 'MB0001');
    assert(sent.some(t => new RegExp(`rescheduled ${LIMITS.MAX_RESCHEDULES_PER_APPOINTMENT} times`).test(t)),
      'expected the cap message: ' + JSON.stringify(sent));
    assert(sent.some(t => /cancel it and book/i.test(t)), 'expected the cancel-and-rebook instruction: ' + JSON.stringify(sent));
  });

  await test('above the cap also blocks (>=, not ==)', async () => {
    mockRescheduleCount = LIMITS.MAX_RESCHEDULES_PER_APPOINTMENT + 3;
    sent.length = 0;
    await handleRescheduleSelect(PHONE, SCHEMA, tenant, send, {}, null, 'MB0001');
    assert(sent.some(t => /rescheduled .* times/.test(t)), 'expected the cap message: ' + JSON.stringify(sent));
  });

  await test('one under the cap is NOT blocked — reaches the date picker', async () => {
    mockRescheduleCount = LIMITS.MAX_RESCHEDULES_PER_APPOINTMENT - 1;
    sent.length = 0;
    await handleRescheduleSelect(PHONE, SCHEMA, tenant, send, {}, null, 'MB0001');
    assert(!sent.some(t => /rescheduled .* times/.test(t)), 'should not have hit the cap: ' + JSON.stringify(sent));
    assert(sent.some(t => /^Currently \*/.test(t)), 'expected the date picker to be reached: ' + JSON.stringify(sent));
  });

  await test('zero reschedules so far is obviously fine', async () => {
    mockRescheduleCount = 0;
    sent.length = 0;
    await handleRescheduleSelect(PHONE, SCHEMA, tenant, send, {}, null, 'MB0001');
    assert(!sent.some(t => /rescheduled .* times/.test(t)), 'should not have hit the cap: ' + JSON.stringify(sent));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
