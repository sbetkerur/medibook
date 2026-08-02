'use strict';
/**
 * DB-free unit test for the bot booking flow.
 *
 * Regression test for the stale-button bug: every interactive (buttonId) reply
 * inside the booking flow used to be misclassified as a "stale button" and
 * reset the patient to the main menu, making button-based booking impossible.
 *
 * Mocks src/db before any module loads, stubs the whatsapp sender, and drives
 * the state machine: Hi → Book (button) → treatment (button) → dentist should
 * be offered — and a full confirm-path test through completeBooking.
 *
 * Run: node tests/botFlow.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_QUEUE = 'true';
process.env.JWT_SECRET = 'unit-test-secret-at-least-32-chars-long!!';

const path = require('path');
const assert = require('assert');

// ── In-memory tenant data ─────────────────────────────────────
const db = {
  sessions: new Map(), // phone -> { phone, state, context, last_activity }
  patients: [],
  hospitals: [{ id: 'hosp-1', name: 'Smile Dental', city: 'Hyderabad' }],
  departments: [
    { id: 'dept-1', name: 'General Dentistry' },
    { id: 'dept-2', name: 'Orthodontics & Braces' },
  ],
  doctors: [{ id: 'doc-1', name: 'Priya Sharma', qualification: 'BDS', consultation_fee: 500 }],
  slotDates: [{ date: '2099-01-05', slots: '4' }],
  slots: [
    { id: 'slot-1', start_time: '10:00:00', end_time: '10:30:00' },
    { id: 'slot-2', start_time: '10:30:00', end_time: '11:00:00' },
  ],
  bookedSlots: new Set(),
  appointments: [],
};

function rows(r) { return { rows: r, rowCount: r.length }; }

// Route a SQL string to the in-memory store (substring matching is fine here —
// the queries are distinctive enough).
async function routeQuery(sql, params = []) {
  const q = sql.replace(/\s+/g, ' ').trim();

  // bot_sessions
  if (q.startsWith('INSERT INTO bot_sessions')) {
    // Two shapes:
    //   getSession:    VALUES ($1, 'idle', '{}') ON CONFLICT (phone) DO NOTHING   — params [phone]
    //   updateSession: VALUES ($1, $2, $3) ON CONFLICT (phone) DO UPDATE ...      — params [phone, state, context]
    const phone = params[0];
    if (q.includes('DO UPDATE')) {
      const s = db.sessions.get(phone) || { id: 's-' + phone, phone, context: {} };
      s.state = params[1];
      s.context = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
      s.last_activity = new Date();
      db.sessions.set(phone, s);
    } else if (!db.sessions.has(phone)) {
      db.sessions.set(phone, { id: 's-' + phone, phone, state: 'idle', context: {}, last_activity: new Date() });
    }
    return rows([]);
  }
  if (q.startsWith('SELECT * FROM bot_sessions')) {
    const s = db.sessions.get(params[0]);
    return rows(s ? [{ ...s }] : []);
  }
  if (q.startsWith('UPDATE bot_sessions')) {
    // Two shapes: SET state=$1, context=$2::jsonb ... WHERE phone=$3  |  SET state='idle', context='{}' WHERE phone=$1
    const phone = params[params.length - 1];
    const s = db.sessions.get(phone) || { phone, context: {} };
    if (params.length >= 3) {
      s.state = params[0];
      s.context = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
    } else {
      s.state = 'idle';
      s.context = {};
    }
    s.last_activity = new Date();
    db.sessions.set(phone, s);
    return rows([]);
  }

  // patients
  if (q.includes('FROM patients WHERE phone')) {
    if (q.startsWith('SELECT opted_out')) return rows([]);
    return rows(db.patients.filter(p => p.phone === params[0]));
  }
  if (q.startsWith('UPDATE patients')) return rows([]);
  if (q.startsWith('INSERT INTO patients')) {
    const p = { id: 'pat-' + (db.patients.length + 1), phone: params[0], name: params[1] };
    db.patients.push(p);
    return rows([{ id: p.id }]);
  }

  // catalog
  if (q.includes('FROM hospitals')) return rows(db.hospitals);
  if (q.includes('FROM departments d')) return rows(db.departments);
  if (q.includes('FROM doctors WHERE department_id')) return rows(db.doctors);
  if (q.startsWith('SELECT consultation_fee FROM doctors')) return rows([{ consultation_fee: 500 }]);

  // slot dates + slots
  if (q.includes('SELECT slot_date::text AS date')) return rows(db.slotDates);
  if (q.includes('FROM time_slots WHERE doctor_id') && q.includes("status='available'") && q.startsWith('SELECT')) {
    return rows(db.slots.filter(s => !db.bookedSlots.has(s.id)));
  }
  if (q.startsWith('UPDATE time_slots SET status=\'booked\'')) {
    const id = params[0];
    if (db.bookedSlots.has(id)) return rows([]);
    db.bookedSlots.add(id);
    return rows([{ id }]);
  }

  // appointments
  if (q.startsWith('INSERT INTO appointments')) {
    const appt = { id: 'appt-' + (db.appointments.length + 1), booking_id: params[0] };
    db.appointments.push(appt);
    return rows([appt]);
  }
  if (q.includes('COUNT(*) FROM appointments a JOIN patients p')) return rows([{ count: '0' }]);

  // plans / quota / wa_messages / users / misc — empty defaults
  if (q.includes('FROM plans')) return rows([]);
  if (q.includes('COUNT(*)')) return rows([{ count: '0' }]);
  return rows([]);
}

// Mock transaction client — same routing, plus transaction control statements
const mockClient = {
  async query(sql, params) {
    const q = String(sql).trim().toUpperCase();
    if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' ||
        q.startsWith('SET LOCAL') || q.startsWith('SAVEPOINT') ||
        q.startsWith('RELEASE') || q.startsWith('ROLLBACK TO')) {
      return rows([]);
    }
    return routeQuery(sql, params);
  },
  release() {},
};

const mockDb = {
  pool: { connect: async () => mockClient, query: routeQuery, on() {}, totalCount: 0, options: { max: 20 } },
  query: (sql, params) => routeQuery(sql, params),
  tenantQuery: (_schema, sql, params) => routeQuery(sql, params),
  tenantTransaction: async (_schema, cb) => cb(mockClient),
};

// Install the mock into the require cache BEFORE anything loads src/db
const dbPath = path.resolve(__dirname, '../src/db/index.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// Stub outgoing WhatsApp — record everything sent
const wa = require('../src/services/whatsapp');
const sent = [];
wa.sendText = async (to, text) => { sent.push({ type: 'text', text }); };
// Mint reply ids exactly as the real sendButtons does (`btn_${i}_${Date.now()}`)
// and hand them back on the recorded message. Confirm steps now verify that a
// positional btn_N belongs to the prompt they just sent (see bot/utils.js
// confirmButtonIndex), so a test tapping a hardcoded id is no longer tapping
// the button the bot rendered — it is tapping a stale one, which is the whole
// point of that check.
wa.sendButtons = async (to, text, buttons) => {
  sent.push({ type: 'buttons', text, buttons, ids: buttons.map((_, i) => `btn_${i}_${Date.now()}`) });
};
wa.sendList = async (to, text, label, sections) => { sent.push({ type: 'list', text, sections }); };
wa.sendBookingConfirmationTemplate = async () => { throw new Error('template not approved (test)'); };

const botEngine = require('../src/services/botEngine');

const tenant = { id: 'tenant-1', slug: 'demo', name: 'Demo Clinic', schema_name: 'tenant_demo', plan: 'starter', settings: {} };
const PHONE = '919111111111';

async function send(text, buttonId) {
  sent.length = 0;
  await botEngine.handle({ phone: PHONE, text, buttonId, tenant });
  return sent.slice();
}

function state() { return db.sessions.get(PHONE)?.state; }

async function run() {
  let pass = 0, fail = 0;
  async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  }

  console.log('Bot flow unit tests (stale-button regression)\n');

  await test('Hi shows main menu', async () => {
    const r = await send('Hi');
    assert(r.some(m => m.type === 'buttons' && /Welcome/.test(m.text)), 'no welcome buttons');
    assert.strictEqual(state(), 'main_menu');
  });

  await test('Tapping Book button starts booking (single hospital → treatments)', async () => {
    const r = await send('📅 Book Appointment', 'btn_0_1700000000001');
    assert(r.some(m => /Select Treatment/.test(m.text)), 'treatment picker not shown: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'select_department');
  });

  await test('REGRESSION: tapping a treatment button advances to dentist selection (not main-menu reset)', async () => {
    const r = await send('Orthodontics & Braces', 'btn_1_1700000000002');
    assert(!r.some(m => /How can I help you today|Booking cancelled/.test(m.text)),
      'flow was reset to main menu — stale-button bug is back');
    assert(r.some(m => /Select Dentist/.test(m.text)), 'dentist picker not shown: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'select_doctor');
  });

  await test('Tapping a dentist (list reply with UUID buttonId) shows dates', async () => {
    const r = await send('Dr. Priya Sharma', 'doc-1');
    assert(r.some(m => /Select Date/.test(m.text)), 'date picker not shown: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'select_date');
  });

  await test('Tapping a date (list reply) shows time slots', async () => {
    const r = await send('Mon, 5 Jan', '2099-01-05');
    assert(r.some(m => /Select Time/.test(m.text)), 'slot picker not shown: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'select_slot');
  });

  await test('Tapping a slot (new patient) asks for name', async () => {
    const r = await send('10:00 – 10:30', 'slot-1');
    assert(r.some(m => /Patient Name/.test(m.text)), 'name prompt not shown: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'collect_name');
  });

  await test('Stale button tap during name collection re-prompts instead of storing title as name', async () => {
    // A stale non-menu button (e.g. an old "✅ Confirm") must not become the patient's name.
    // (Main-menu button titles are a deliberate escape hatch and are tested separately below.)
    const r = await send('✅ Confirm', 'btn_0_1700000000003');
    assert(r.some(m => /type.*full name/i.test(m.text)), 'expected typed-name re-prompt: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'collect_name');
  });

  await test('REGRESSION: unrecognised gender reply re-prompts instead of silently storing "other"', async () => {
    await send('Asha Verma');
    assert.strictEqual(state(), 'collect_dob');
    await send('15/08/1990');
    assert.strictEqual(state(), 'collect_gender');
    // A typo / stale tap used to fall through to 'other' and advance the flow.
    const r = await send('femle');
    assert(r.some(m => /choose one of the options/i.test(m.text)),
      'expected gender re-prompt: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'collect_gender', 'should stay on gender step');
    const ctxRaw = db.sessions.get(PHONE).context;
    const ctx = JSON.parse(require('../src/utils/encryption').decrypt(ctxRaw._enc));
    assert.strictEqual(ctx.patient_gender, undefined, 'gender must not be set from an unrecognised reply');
  });

  // Set by the confirmation-summary test below: the id of the "✅ Confirm"
  // button the summary actually minted.
  let confirmBtnId = null;

  await test('Typed name → DOB → gender → email skip → reason → confirmation summary', async () => {
    assert.strictEqual(state(), 'collect_gender');
    await send('Female', 'btn_1_1700000000004');
    assert.strictEqual(state(), 'collect_email');
    await send('⏭ Skip', 'btn_0_1700000000005');
    assert.strictEqual(state(), 'collect_chief_complaint');
    const r = await send('🔍 Checkup / Cleaning', 'btn_1_1700000000006');
    const summary = r.find(m => /review your booking/.test(m.text));
    assert(summary, 'confirmation summary not shown: ' + JSON.stringify(r));
    confirmBtnId = summary.ids[0];
    assert.strictEqual(state(), 'confirm_booking');
  });

  await test('STALE btn_0 at confirm_booking does not book — it re-asks', async () => {
    // btn_0 of some older message (WhatsApp keeps every button tappable). It is
    // not consent to book, so nothing may be written.
    const r = await send('✅ Confirm', 'btn_0_1700000000099');
    assert(r.some(m => /Please confirm your booking/.test(m.text)),
      'expected a re-prompt for the stale tap: ' + JSON.stringify(r));
    assert.strictEqual(db.appointments.length, 0, 'a stale tap booked an appointment');
    assert.strictEqual(state(), 'confirm_booking');
    // The re-prompt minted fresh buttons — tap those instead.
    confirmBtnId = r.find(m => /Please confirm your booking/.test(m.text)).ids[0];
  });

  await test('REGRESSION: tapping ✅ Confirm completes the booking (not main-menu reset)', async () => {
    const r = await send('✅ Confirm', confirmBtnId);
    assert(!r.some(m => /How can I help you today/.test(m.text)),
      'confirm tap was reset to main menu — stale-button bug is back');
    assert(r.some(m => /Appointment Confirmed/.test(m.text)), 'confirmation not sent: ' + JSON.stringify(r));
    assert.strictEqual(db.appointments.length, 1, 'appointment row not created');
    assert(db.bookedSlots.has('slot-1'), 'slot not marked booked');
    assert.strictEqual(state(), 'idle');
  });

  await test('Stale MAIN MENU button during booking still exits to menu', async () => {
    await send('Hi');
    await send('📅 Book Appointment', 'btn_0_1700000000008'); // back into select_department
    const r = await send('🗓 My Appointments', 'btn_1_1700000000009');
    assert(r.some(m => /Welcome/.test(m.text)), 'main-menu escape broken: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'main_menu');
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
