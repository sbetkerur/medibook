'use strict';
/**
 * DB-free unit test for the bot-level read-only guard (isReadOnlyDemo,
 * services/bot/utils.js).
 *
 * tenants.read_only always blocked the DASHBOARD (middleware/auth.js
 * enforceReadOnlyTenant, /api/admin + /api/v1/admin only) but never touched
 * the bot/webhook path — nothing stopped the bot engine from actually
 * booking, cancelling, rescheduling, or queuing a clinic_requests row (which
 * also fires a real WhatsApp alert to the clinic's own admin) against a
 * read-only tenant. Harmless while the read-only demo tenant's WhatsApp
 * number was unreachable by the public; not harmless once a public "try the
 * bot" widget (routes/demoChat.js) invokes the same bot engine.
 *
 * This proves each of the five mutation points refuses to touch the
 * database — not just that it replies politely — for a `read_only` tenant:
 * completeBooking, handleCancelConfirm, handleRescheduleConfirm,
 * handleCallbackRequest, handleAppointmentRequest.
 *
 * Run: node tests/demoReadOnlyBot.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';

const path = require('path');
const assert = require('assert');

function rows(r) { return { rows: r, rowCount: r.length }; }

// Every query this test cares about is business data — booking a slot,
// touching a patient, or queuing/alerting a clinic request. bot_sessions
// bookkeeping (every guard branch calls updateSession(...IDLE...) on the way
// out) is expected and deliberately NOT flagged here.
const FORBIDDEN = /\b(appointments|time_slots|clinic_requests)\b|FROM patients|INSERT INTO patients|notify_phone/i;

const queryLog = [];
let poolConnectCalled = false;
let transactionCalled = false;

function routeQuery(sql) {
  queryLog.push(String(sql));
  return rows([]);
}

const mockClient = { async query(sql) { return routeQuery(sql); }, release() {} };

const mockDb = {
  pool: { connect: async () => { poolConnectCalled = true; return mockClient; }, on() {}, totalCount: 0, options: { max: 20 } },
  query: (sql) => routeQuery(sql),
  tenantQuery: (_schema, sql) => routeQuery(sql),
  tenantTransaction: async (_schema, cb) => { transactionCalled = true; return cb(mockClient); },
  validateSchemaName: (schemaName) => {
    if (!schemaName || !/^tenant_[a-z0-9_]+$/.test(schemaName)) {
      throw new Error(`Invalid schema name: "${schemaName}"`);
    }
  },
};

const dbPath = path.resolve(__dirname, '../src/db/index.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// Stub outgoing WhatsApp — none of these should ever fire for a blocked
// mutation, since notifyAdminWhatsApp is only ever reached AFTER the write.
const wa = require('../src/services/whatsapp');
wa.sendText = async () => { throw new Error('a real WhatsApp send must never happen for a read-only tenant'); };
wa.sendButtons = async () => {};
wa.sendList = async () => {};

const { completeBooking } = require('../src/services/bot/bookingFlow');
const { handleCancelConfirm, handleRescheduleConfirm } = require('../src/services/bot/appointmentFlow');
const { handleCallbackRequest, handleAppointmentRequest } = require('../src/services/bot/requestFlow');

const tenant = { id: 't-demo', slug: 'pragati-demo', name: 'Pragati Dental Studio', schema_name: 'tenant_pragati_demo', plan: 'starter', settings: {}, read_only: true };
const PHONE = '919999999999';

// A send stub that records what the patient would have received.
function makeSend() {
  const out = [];
  return {
    out,
    text: async (t) => { out.push(t); },
    buttons: async (t) => { out.push(t); },
  };
}

async function run() {
  let pass = 0, fail = 0;
  async function test(name, fn) {
    queryLog.length = 0;
    poolConnectCalled = false;
    transactionCalled = false;
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  }

  console.log('Bot-level read-only guard unit tests (isReadOnlyDemo)\n');

  await test('completeBooking refuses to write for a read_only tenant', async () => {
    const send = makeSend();
    await completeBooking(PHONE, tenant.schema_name, tenant, send, {});
    assert.strictEqual(poolConnectCalled, false, 'pool.connect was called — a transaction was opened');
    assert(send.out.some(t => /live demo/i.test(t)), 'no demo-mode message sent: ' + JSON.stringify(send.out));
    assert(!queryLog.some(q => FORBIDDEN.test(q)), 'a business-data query ran: ' + JSON.stringify(queryLog));
  });

  await test('handleCancelConfirm refuses to write for a read_only tenant', async () => {
    const send = makeSend();
    const ctx = { cancel_appt_id: 'appt-1', cancel_slot_id: 'slot-1', cancel_booking_id: 'MB0000000000' };
    await handleCancelConfirm(PHONE, tenant.schema_name, tenant, send, ctx, 'yes');
    assert.strictEqual(transactionCalled, false, 'tenantTransaction was called — the cancel ran');
    assert(send.out.some(t => /live demo/i.test(t)), 'no demo-mode message sent: ' + JSON.stringify(send.out));
    assert(!queryLog.some(q => FORBIDDEN.test(q)), 'a business-data query ran: ' + JSON.stringify(queryLog));
  });

  await test('handleRescheduleConfirm refuses to write for a read_only tenant', async () => {
    const send = makeSend();
    const ctx = {
      reschedule_appt_id: 'appt-1', reschedule_new_slot_id: 'slot-2', reschedule_old_slot_id: 'slot-1',
      reschedule_new_date: '2099-01-05', reschedule_new_time: '10:30:00', reschedule_booking_id: 'MB0000000000',
      reschedule_doctor_name: 'Priya Sharma',
    };
    await handleRescheduleConfirm(PHONE, tenant.schema_name, tenant, send, ctx, 'yes');
    assert.strictEqual(transactionCalled, false, 'tenantTransaction was called — the reschedule ran');
    assert(send.out.some(t => /live demo/i.test(t)), 'no demo-mode message sent: ' + JSON.stringify(send.out));
    assert(!queryLog.some(q => FORBIDDEN.test(q)), 'a business-data query ran: ' + JSON.stringify(queryLog));
  });

  await test('handleCallbackRequest refuses to queue a request (and alert staff) for a read_only tenant', async () => {
    const send = makeSend();
    await handleCallbackRequest(PHONE, tenant.schema_name, tenant, send, {});
    assert(send.out.some(t => /live demo/i.test(t)), 'no demo-mode message sent: ' + JSON.stringify(send.out));
    assert(!queryLog.some(q => FORBIDDEN.test(q)), 'a business-data query ran (or admin was alerted): ' + JSON.stringify(queryLog));
  });

  await test('handleAppointmentRequest refuses to queue a request (and alert staff) for a read_only tenant', async () => {
    const send = makeSend();
    await handleAppointmentRequest(PHONE, tenant.schema_name, tenant, send, {});
    assert(send.out.some(t => /live demo/i.test(t)), 'no demo-mode message sent: ' + JSON.stringify(send.out));
    assert(!queryLog.some(q => FORBIDDEN.test(q)), 'a business-data query ran (or admin was alerted): ' + JSON.stringify(queryLog));
  });

  await test('a NON-read_only tenant is unaffected — completeBooking still opens a transaction', async () => {
    const writableTenant = { ...tenant, read_only: false };
    const send = makeSend();
    // Missing ctx fields will make the real booking path fail deeper in
    // (patient/slot lookups) — that's fine, this only asserts the guard did
    // NOT short-circuit before pool.connect.
    await completeBooking(PHONE, writableTenant.schema_name, writableTenant, send, {}).catch(() => {});
    assert.strictEqual(poolConnectCalled, true, 'a writable tenant must still be able to open a transaction');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
