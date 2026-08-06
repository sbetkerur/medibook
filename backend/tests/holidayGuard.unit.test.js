'use strict';
/**
 * DB-free unit test for the clinic-holiday guard on the POST-date booking steps.
 *
 * The bug: declaring a holiday only INSERTed a clinic_holidays row. The only
 * thing keeping those slots unbookable was the NOT EXISTS filter in the
 * date-LIST queries — and everything downstream of the date list trusted the
 * date the patient had already been offered. Sessions have no TTL, so a patient
 * could tap a date row cached days before the holiday existed, get its slots
 * back as 'available', and confirm a booking on a day the clinic was shut.
 *
 * The mock below behaves like Postgres: it applies the leave/holiday exclusion
 * ONLY when the SQL actually carries the NOT EXISTS clauses. Drop the guard from
 * any of these queries and these tests fail — which is the point.
 *
 * Also pins the patients-before-time_slots lock ordering in completeBooking:
 * the admin walk-in route takes the patient row first, and taking them in the
 * opposite order here deadlocked (40P01) two transactions meeting on the same
 * patient and slot.
 *
 * Run: node tests/holidayGuard.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_QUEUE = 'true';
process.env.JWT_SECRET = 'unit-test-secret-at-least-32-chars-long!!';

const path = require('path');
const assert = require('assert');

const HOSP = 'hosp-1';
const OTHER_HOSP = 'hosp-2';
const DOC = 'doc-1';
const OPEN_DAY = '2099-01-05';
const SHUT_DAY = '2099-01-06';

// ── In-memory tenant data ─────────────────────────────────────
const db = {
  sessions: new Map(),
  // Two identical days for the same dentist; only their date differs.
  slots: [
    { id: 'slot-open', doctor_id: DOC, hospital_id: HOSP, slot_date: OPEN_DAY, start_time: '10:00:00', end_time: '10:30:00' },
    { id: 'slot-shut', doctor_id: DOC, hospital_id: HOSP, slot_date: SHUT_DAY, start_time: '10:00:00', end_time: '10:30:00' },
  ],
  bookedSlots: new Set(),
  appointments: [],
  holidays: [],  // { date, hospital_id }  — hospital_id null = clinic-wide
  leaves: [],    // { doctor_id, date }
  statements: [],// every SQL statement the transaction client saw, in order
};

function rows(r) { return { rows: r, rowCount: r.length }; }

// Does this SQL carry the guard? (i.e. would a real Postgres apply it)
const hasHolidayGuard = (q) => /NOT EXISTS \( SELECT 1 FROM clinic_holidays/i.test(q);
const hasLeaveGuard   = (q) => /NOT EXISTS \( SELECT 1 FROM doctor_leaves/i.test(q);

// The guard's semantics, evaluated against a slot row.
function dayBlockedFor(slot) {
  const holiday = db.holidays.some(h =>
    h.date === slot.slot_date && (h.hospital_id === null || h.hospital_id === slot.hospital_id));
  const leave = db.leaves.some(l => l.doctor_id === slot.doctor_id && l.date === slot.slot_date);
  return { holiday, leave };
}
function slotVisible(q, slot) {
  const { holiday, leave } = dayBlockedFor(slot);
  if (holiday && hasHolidayGuard(q)) return false;
  if (leave && hasLeaveGuard(q)) return false;
  return true;
}

async function routeQuery(sql, params = []) {
  const q = sql.replace(/\s+/g, ' ').trim();

  // bot_sessions
  if (q.startsWith('INSERT INTO bot_sessions')) {
    const phone = params[0];
    if (q.includes('DO UPDATE')) {
      db.sessions.set(phone, {
        id: 's-' + phone, phone, state: params[1],
        context: typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2],
      });
    } else if (!db.sessions.has(phone)) {
      db.sessions.set(phone, { id: 's-' + phone, phone, state: 'idle', context: {} });
    }
    return rows([]);
  }
  if (q.startsWith('SELECT * FROM bot_sessions')) {
    const s = db.sessions.get(params[0]);
    return rows(s ? [{ ...s }] : []);
  }
  if (q.startsWith('UPDATE bot_sessions')) return rows([]);

  // completeBooking's "why did the lock fail?" probe:
  //   SELECT 1 FROM time_slots WHERE id=$1 AND NOT (<guard>) LIMIT 1
  if (q.startsWith('SELECT 1 FROM time_slots') && q.includes('AND NOT (')) {
    const slot = db.slots.find(s => s.id === params[0]);
    if (!slot) return rows([]);
    const { holiday, leave } = dayBlockedFor(slot);
    const closed = (holiday && hasHolidayGuard(q)) || (leave && hasLeaveGuard(q));
    return rows(closed ? [{ '?column?': 1 }] : []);
  }

  // handleSelectDate's per-date slot list
  if (q.startsWith('SELECT id, start_time, end_time FROM time_slots')) {
    return rows(db.slots.filter(s =>
      s.doctor_id === params[0] && s.slot_date === params[1] &&
      !db.bookedSlots.has(s.id) && slotVisible(q, s)));
  }

  // The atomic slot lock
  if (q.startsWith("UPDATE time_slots SET status='booked'")) {
    const slot = db.slots.find(s => s.id === params[0]);
    if (!slot || db.bookedSlots.has(slot.id) || !slotVisible(q, slot)) return rows([]);
    db.bookedSlots.add(slot.id);
    return rows([{ id: slot.id }]);
  }

  // Next-available-dates suggestion after an empty slot list
  if (q.includes('SELECT slot_date::text AS date')) return rows([]);

  // patients / appointments
  if (q.startsWith('INSERT INTO patients')) return rows([{ id: 'pat-new' }]);
  if (q.startsWith('UPDATE patients')) return rows([]);
  if (q.startsWith('INSERT INTO appointments')) {
    const appt = { id: 'appt-' + (db.appointments.length + 1), booking_id: params[0] };
    db.appointments.push(appt);
    return rows([appt]);
  }
  if (q.startsWith('SELECT consultation_fee FROM doctors')) return rows([{ consultation_fee: 500 }]);

  if (q.includes('FROM plans')) return rows([]);
  if (q.includes('COUNT(*)')) return rows([{ count: '0' }]);
  return rows([]);
}

const mockClient = {
  async query(sql, params) {
    const q = String(sql).trim();
    const upper = q.toUpperCase();
    if (upper === 'BEGIN' || upper === 'COMMIT' || upper === 'ROLLBACK' ||
        upper.startsWith('SET LOCAL') || upper.startsWith('SAVEPOINT') ||
        upper.startsWith('RELEASE') || upper.startsWith('ROLLBACK TO')) {
      return rows([]);
    }
    db.statements.push(q.replace(/\s+/g, ' '));
    return routeQuery(sql, params);
  },
  release() {},
};

const mockDb = {
  pool: { connect: async () => mockClient, query: routeQuery, on() {}, totalCount: 0, options: { max: 20 } },
  query: (sql, params) => routeQuery(sql, params),
  tenantQuery: (_schema, sql, params) => routeQuery(sql, params),
  tenantTransaction: async (_schema, cb) => cb(mockClient),
  // Mirrors the real implementation rather than stubbing it to a no-op:
  // completeBooking interpolates the schema into `SET LOCAL search_path`, so
  // the guard it runs first is worth exercising here too.
  validateSchemaName: (schemaName) => {
    if (!schemaName || !/^tenant_[a-z0-9_]+$/.test(schemaName)) {
      throw new Error(`Invalid schema name: "${schemaName}"`);
    }
  },
};
const dbPath = path.resolve(__dirname, '../src/db/index.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const wa = require('../src/services/whatsapp');
wa.sendText = async () => {};
wa.sendButtons = async () => {};
wa.sendList = async () => {};
wa.sendBookingConfirmationTemplate = async () => { throw new Error('template not approved (test)'); };

const bookingFlow = require('../src/services/bot/bookingFlow');
const { SLOT_DAY_OPEN_SQL } = require('../src/services/bookingCore');

const SCHEMA = 'tenant_demo';
const PHONE = '919111111111';
const tenant = { id: 'tenant-1', slug: 'demo', name: 'Demo Clinic', schema_name: SCHEMA, plan: 'starter', settings: {} };

// Minimal stand-in for botEngine's `send` helpers.
function makeSend(sink) {
  return {
    text:    async (t) => { sink.push({ type: 'text', text: t }); },
    buttons: async (t) => { sink.push({ type: 'buttons', text: t }); },
    list:    async (t, _label, sections) => { sink.push({ type: 'list', text: t, sections }); },
  };
}

// A session that was parked at SELECT_DATE while both days were still open —
// exactly the state the bug needs.
function ctxAtDateStep() {
  return {
    hospital_id: HOSP, hospital_name: 'Smile Dental',
    department_id: 'dept-1', department_name: 'General Dentistry',
    doctor_id: DOC, doctor_name: 'Priya Sharma',
    _dates: [
      { date: OPEN_DAY, label: 'Tue, 5 Jan', slots: 1 },
      { date: SHUT_DAY, label: 'Wed, 6 Jan', slots: 1 },
    ],
  };
}

function ctxAtConfirmStep(slotId, date) {
  return {
    ...ctxAtDateStep(), patient_id: 'pat-1', patient_name: 'Asha Verma',
    slot_id: slotId, appointment_date: date, appointment_time: '10:00:00',
    visit_type: 'in_person',
  };
}

function reset() {
  db.bookedSlots.clear();
  db.appointments.length = 0;
  db.holidays.length = 0;
  db.leaves.length = 0;
  db.statements.length = 0;
  db.sessions.clear();
}

async function run() {
  let pass = 0, fail = 0;
  async function test(name, fn) {
    try { reset(); await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  }

  console.log('\nHoliday / leave guard on the post-date booking steps\n');

  // ── The guard itself ────────────────────────────────────────
  await test('SLOT_DAY_OPEN_SQL binds no parameters (safe to interpolate anywhere)', async () => {
    assert(!/\$\d/.test(SLOT_DAY_OPEN_SQL), 'guard must not reference bound parameters');
  });

  await test('SLOT_DAY_OPEN_SQL honours clinic-wide AND per-hospital holidays', async () => {
    const q = SLOT_DAY_OPEN_SQL.replace(/\s+/g, ' ');
    assert(/ch\.hospital_id IS NULL/.test(q), 'clinic-wide holidays must block');
    assert(/ch\.hospital_id = time_slots\.hospital_id/.test(q), 'per-hospital holidays must block');
  });

  // ── handleSelectDate: the per-date slot query ───────────────
  await test('control: an open day still returns its slots', async () => {
    const sink = [];
    await bookingFlow.handleSelectDate(PHONE, SCHEMA, tenant, makeSend(sink), ctxAtDateStep(), OPEN_DAY);
    assert(sink.some(m => m.type === 'list' && (m.sections || []).some(s => /^Slots on /.test(s.title))),
      'open day offered no times — the guard is over-blocking: ' + JSON.stringify(sink));
  });

  await test('REGRESSION: a date cached BEFORE a clinic-wide holiday offers no slots', async () => {
    db.holidays.push({ date: SHUT_DAY, hospital_id: null });
    const sink = [];
    // The stale row is still in _dates, so the "was it offered?" check passes —
    // only the slot query can catch this.
    await bookingFlow.handleSelectDate(PHONE, SCHEMA, tenant, makeSend(sink), ctxAtDateStep(), SHUT_DAY);
    assert(!sink.some(m => m.type === 'list' && (m.sections || []).some(s => /^Slots on /.test(s.title))),
      'slots were offered on a declared holiday: ' + JSON.stringify(sink));
    assert(sink.some(m => /Nothing left on that date/i.test(m.text)), 'expected a "no slots" reply: ' + JSON.stringify(sink));
  });

  await test('a holiday at THIS branch blocks the day', async () => {
    db.holidays.push({ date: SHUT_DAY, hospital_id: HOSP });
    const sink = [];
    await bookingFlow.handleSelectDate(PHONE, SCHEMA, tenant, makeSend(sink), ctxAtDateStep(), SHUT_DAY);
    assert(!sink.some(m => m.type === 'list'), 'branch holiday did not block: ' + JSON.stringify(sink));
  });

  await test('a holiday at ANOTHER branch does not block this one', async () => {
    db.holidays.push({ date: SHUT_DAY, hospital_id: OTHER_HOSP });
    const sink = [];
    await bookingFlow.handleSelectDate(PHONE, SCHEMA, tenant, makeSend(sink), ctxAtDateStep(), SHUT_DAY);
    assert(sink.some(m => m.type === 'list' && (m.sections || []).some(s => /^Slots on /.test(s.title))),
      'another branch\'s holiday closed this branch: ' + JSON.stringify(sink));
  });

  await test('a doctor leave declared after the date list also blocks the day', async () => {
    db.leaves.push({ doctor_id: DOC, date: SHUT_DAY });
    const sink = [];
    await bookingFlow.handleSelectDate(PHONE, SCHEMA, tenant, makeSend(sink), ctxAtDateStep(), SHUT_DAY);
    assert(!sink.some(m => m.type === 'list'), 'leave did not block: ' + JSON.stringify(sink));
  });

  // ── completeBooking: the last line of defence ───────────────
  await test('control: completeBooking books an open day', async () => {
    const sink = [];
    await bookingFlow.completeBooking(PHONE, SCHEMA, tenant, makeSend(sink), ctxAtConfirmStep('slot-open', OPEN_DAY));
    assert.strictEqual(db.appointments.length, 1, 'open-day booking failed: ' + JSON.stringify(sink));
    assert(db.bookedSlots.has('slot-open'), 'slot not locked');
  });

  await test('REGRESSION: completeBooking refuses a slot whose day closed mid-flow', async () => {
    // Holiday declared while the patient sat on the confirm screen: the date
    // list, the slot list and the summary all predate it.
    db.holidays.push({ date: SHUT_DAY, hospital_id: null });
    const sink = [];
    await bookingFlow.completeBooking(PHONE, SCHEMA, tenant, makeSend(sink), ctxAtConfirmStep('slot-shut', SHUT_DAY));
    assert.strictEqual(db.appointments.length, 0, 'booked an appointment on a declared holiday');
    assert(!db.bookedSlots.has('slot-shut'), 'slot was locked on a holiday');
    assert(sink.some(m => /no longer open/i.test(m.text)),
      'patient should be told the day closed, not that someone took the slot: ' + JSON.stringify(sink));
  });

  await test('a leave declared mid-flow is refused by the lock too', async () => {
    db.leaves.push({ doctor_id: DOC, date: SHUT_DAY });
    const sink = [];
    await bookingFlow.completeBooking(PHONE, SCHEMA, tenant, makeSend(sink), ctxAtConfirmStep('slot-shut', SHUT_DAY));
    assert.strictEqual(db.appointments.length, 0, 'booked an appointment on a doctor leave day');
  });

  // ── Lock ordering (deadlock regression) ─────────────────────
  await test('REGRESSION: completeBooking locks patients BEFORE time_slots', async () => {
    const sink = [];
    await bookingFlow.completeBooking(PHONE, SCHEMA, tenant, makeSend(sink), ctxAtConfirmStep('slot-open', OPEN_DAY));
    const patientAt = db.statements.findIndex(s => /^(INSERT INTO patients|UPDATE patients)/.test(s));
    const slotAt    = db.statements.findIndex(s => /^UPDATE time_slots SET status='booked'/.test(s));
    const apptAt    = db.statements.findIndex(s => /^INSERT INTO appointments/.test(s));
    assert(patientAt !== -1 && slotAt !== -1 && apptAt !== -1,
      'expected all three writes: ' + JSON.stringify(db.statements));
    assert(patientAt < slotAt,
      'patients must be locked before time_slots — the walk-in route does, and the ' +
      'opposite order deadlocks (40P01) on the same patient + slot');
    assert(slotAt < apptAt, 'appointments must stay last');
  });

  await test('a new-patient booking takes the same lock order', async () => {
    const ctx = ctxAtConfirmStep('slot-open', OPEN_DAY);
    delete ctx.patient_id; // forces the INSERT branch
    await bookingFlow.completeBooking(PHONE, SCHEMA, tenant, makeSend([]), ctx);
    const patientAt = db.statements.findIndex(s => /^INSERT INTO patients/.test(s));
    const slotAt    = db.statements.findIndex(s => /^UPDATE time_slots SET status='booked'/.test(s));
    assert(patientAt !== -1, 'new patient was never inserted');
    assert(patientAt < slotAt, 'new-patient insert must also precede the slot lock');
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
