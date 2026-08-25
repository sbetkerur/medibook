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
  // `departments` is the BOOKABLE set (doctor_departments), `department_id` the
  // primary. Dr Priya is a general dentist who also takes braces cases — the
  // ordinary Indian arrangement, and the reason a dentist has to be reachable
  // from a treatment that isn't their primary one.
  doctors: [
    { id: 'doc-1', name: 'Priya Sharma', qualification: 'BDS', consultation_fee: 500,
      specialization: 'General Dentist', department_id: 'dept-1', departments: ['dept-1', 'dept-2'] },
    { id: 'doc-2', name: 'Rahul Menon', qualification: 'BDS, MDS', consultation_fee: 800,
      specialization: 'Orthodontist', department_id: 'dept-2', departments: ['dept-2'] },
  ],
  slotDates: [{ date: '2099-01-05', slots: '4' }],
  slots: [
    { id: 'slot-1', start_time: '10:00:00', end_time: '10:30:00' },
    { id: 'slot-2', start_time: '10:30:00', end_time: '11:00:00' },
  ],
  bookedSlots: new Set(),
  appointments: [],
  // Ongoing multi-visit treatments for PHONE. Shaped like getOpenPlans' rows:
  // only courses with a sitting still to book ever appear here.
  treatmentPlans: [],
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
  // Ongoing treatments with a sitting left to book (treatmentFlow.getOpenPlans).
  if (q.includes('FROM treatment_plans tp')) return rows(db.treatmentPlans);

  // "Not sure" — every dentist at the branch, no department filter at all. The
  // marker is the literal `false AS is_primary`, which only that query has.
  if (q.includes('false AS is_primary')) {
    return rows(db.doctors.map(d => ({ ...d, is_primary: false })));
  }
  // Dentists for a treatment, joined through doctor_departments ($1 = department).
  // Filtered here rather than returning everyone, so a test can prove that a
  // dentist whose PRIMARY department is something else still shows up — and that
  // one who doesn't render the treatment does not.
  if (q.includes('JOIN doctor_departments dd ON dd.doctor_id')) {
    const deptId = params[0];
    const matching = db.doctors
      .filter(d => d.departments.includes(deptId))
      .map(d => ({ ...d, is_primary: d.department_id === deptId }))
      .sort((a, b) => (b.is_primary - a.is_primary) || a.name.localeCompare(b.name));
    return rows(matching);
  }
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
  // Mirrors the real implementation rather than stubbing it to a no-op:
  // completeBooking interpolates the schema into `SET LOCAL search_path`, so
  // the guard it runs first is worth exercising here too.
  validateSchemaName: (schemaName) => {
    if (!schemaName || !/^tenant_[a-z0-9_]+$/.test(schemaName)) {
      throw new Error(`Invalid schema name: "${schemaName}"`);
    }
  },
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
// `opts` is WhatsApp's own header/footer slots. Captured here — and folded into
// `all` — so assertions can match a step title without caring whether it lives
// in the header or the body, which is exactly the kind of presentation detail
// that should be free to change.
wa.sendButtons = async (to, text, buttons, _t, _p, opts = {}) => {
  sent.push({ type: 'buttons', text, buttons, ...opts,
    all: [opts.header, text, opts.footer].filter(Boolean).join('\n'),
    ids: buttons.map((_, i) => `btn_${i}_${Date.now()}`) });
};
wa.sendList = async (to, text, label, sections, _t, _p, opts = {}) => {
  sent.push({ type: 'list', text, sections, ...opts,
    all: [opts.header, text, opts.footer].filter(Boolean).join('\n') });
};
wa.sendBookingConfirmationTemplate = async () => { throw new Error('template not approved (test)'); };

const botEngine = require('../src/services/botEngine');

const tenant = { id: 'tenant-1', slug: 'demo', name: 'Demo Clinic', schema_name: 'tenant_demo', plan: 'starter', settings: {} };
const PHONE = '919111111111';

async function send(text, buttonId, welcome) {
  sent.length = 0;
  await botEngine.handle({ phone: PHONE, text, buttonId, tenant, welcome });
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
    assert(r.some(m => m.type === 'buttons' && /how can we help|Book an appointment/.test(m.all)), 'no welcome buttons');
    assert.strictEqual(state(), 'main_menu');
  });

  // ── The arrival has to read as the CLINIC's own channel ──────
  // The WhatsApp number is shared between every clinic, so the first message
  // after a QR scan is the only thing distinguishing "my dentist's WhatsApp"
  // from "some booking service". Asserted on `m.all` (header+body+footer) per
  // the house rule, except where the point IS which slot the name landed in.
  await test('a QR arrival welcomes the patient BY THE CLINIC NAME', async () => {
    db.sessions.delete(PHONE);
    const r = await send('Hi', null, true);
    const menu = r.find(m => m.type === 'buttons');
    assert(menu, 'no menu sent');
    assert(/Welcome to \*Demo Clinic\*/.test(menu.text),
      'the clinic name must be in the BODY, not only the header — the header is small and grey: ' + menu.text);
    assert.strictEqual(state(), 'main_menu');
  });

  await test('a QR arrival is ONE message, not a handover then a menu', async () => {
    db.sessions.delete(PHONE);
    const r = await send('Hi', null, true);
    // The old flow sent "✅ Connecting you to X…" first, which put a
    // switchboard between the patient and the clinic.
    assert(!r.some(m => /connecting you/i.test(m.all)), 'switchboard handover is back: ' + JSON.stringify(r));
    assert.strictEqual(r.filter(m => m.type === 'buttons').length, 1, 'expected exactly one menu');
  });

  await test('an ordinary "Hi" later in the thread is NOT an arrival', async () => {
    db.sessions.delete(PHONE);
    const r = await send('Hi');
    const menu = r.find(m => m.type === 'buttons');
    assert(!/Welcome to \*Demo Clinic\*/.test(menu.text),
      'the welcome must be reserved for a scan, or it fires on every greeting: ' + menu.text);
  });

  await test('no copy offers the patient a different clinic', async () => {
    // The roster is invisible by design. Copy that says "choose a different
    // clinic" both advertises competitors and is now simply untrue — nothing a
    // patient types can detach them.
    db.sessions.delete(PHONE);
    for (const input of ['Hi', 'help', 'zzzz-unrecognised']) {
      const r = await send(input);
      assert(!r.some(m => /different clinic|another clinic|other clinics/i.test(m.all)),
        `"${input}" offered a different clinic: ` + JSON.stringify(r));
    }
  });

  await test('Tapping Book button starts booking (single hospital → what do you need)', async () => {
    const r = await send('📅 Book Appointment', 'btn_0_1700000000001');
    assert(r.some(m => /What do you need/.test(m.all)), 'treatment picker not shown: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'select_department');
  });

  // Patients arrive with a symptom, not a diagnosis. The first option must let
  // them book the clinic without naming a treatment only the dentist can name.
  await test('the "not sure" option is offered FIRST, ahead of the named treatments', async () => {
    const picker = sent.find(m => /What do you need/.test(m.all));
    const names = picker.buttons || (picker.sections?.[0].rows || []).map(r => r.title);
    assert(/Not sure|Consultation/i.test(names[0]),
      'consultation option is not first: ' + JSON.stringify(names));
  });

  // Pickers used to choose buttons vs list on the option COUNT alone, so a short
  // set of long names rendered as buttons and was cut: a reply-button title caps
  // at 20 characters and whatsapp.js slices to fit rather than let Meta reject
  // the message. Three treatments, one of them 21 characters, is exactly that
  // case — it must fall through to a list, whose rows hold 24.
  await test('a label too long for a button falls to the list rather than being cut', async () => {
    const picker = sent.find(m => /What do you need/.test(m.all));
    assert.strictEqual(picker.type, 'list',
      'a 21-character treatment name was rendered as a button: ' + JSON.stringify(picker));
    const titles = (picker.sections?.[0].rows || []).map(r => r.title);
    assert(titles.includes('Orthodontics & Braces'),
      'treatment name reached the patient truncated: ' + JSON.stringify(titles));
    for (const t of titles) {
      assert(t.length <= 24, `row title over the 24-char cap: ${JSON.stringify(t)}`);
    }
  });


  await test('REGRESSION: tapping a treatment button advances to dentist selection (not main-menu reset)', async () => {
    const r = await send('Orthodontics & Braces', 'btn_1_1700000000002');
    assert(!r.some(m => /How can I help you today|Booking cancelled/.test(m.text)),
      'flow was reset to main menu — stale-button bug is back');
    assert(r.some(m => /Choose a dentist/.test(m.all)), 'dentist picker not shown: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'select_doctor');
  });

  // The other half of the same rule: when every label DOES fit, buttons are
  // still the better widget (one tap, no menu to open) and must be kept — the
  // width check must not quietly push every picker into a list.
  await test('labels that fit are still offered as buttons, not pushed into a list', async () => {
    const picker = sent.find(m => /Choose a dentist/.test(m.all));
    assert.strictEqual(picker.type, 'buttons',
      'two short dentist names should stay buttons: ' + JSON.stringify(picker));
    for (const b of picker.buttons) {
      assert(b.length <= 20, `button title over the 20-char cap: ${JSON.stringify(b)}`);
    }
  });

  // ── Multi-department dentists ───────────────────────────────
  // A dentist belongs to several treatments. Booking by treatment must reach
  // everyone who renders it, not only those whose PRIMARY department it is —
  // otherwise the general dentist who does simple root canals is unbookable for
  // one, which is the normal arrangement in an Indian clinic.
  await test('a treatment lists every dentist who renders it, specialist first', async () => {
    const picker = sent.find(m => /Choose a dentist/.test(m.all));
    assert(picker, 'no dentist picker in the last exchange');
    const names = (picker.buttons || (picker.sections?.[0].rows || []).map(r => r.title));
    assert(names.some(n => /Rahul Menon/.test(n)),
      'the orthodontist is missing from their own treatment: ' + JSON.stringify(names));
    assert(names.some(n => /Priya Sharma/.test(n)),
      'the general dentist who also does braces is missing — multi-department listing is broken: '
      + JSON.stringify(names));
    // The dentist whose primary department this is leads: a patient scanning the
    // list should see the specialist before the generalist.
    assert(/Rahul Menon/.test(names[0]),
      'specialist should be listed first for their own treatment: ' + JSON.stringify(names));
  });

  await test('a dentist is NOT offered for a treatment they do not render', async () => {
    await send('Hi');
    await send('📅 Book Appointment', 'btn_0_1700000000101');
    const r = await send('General Dentistry', 'dept-1');
    const picker = r.find(m => /Choose a dentist/.test(m.all));
    assert(picker, 'dentist picker not shown: ' + JSON.stringify(r));
    const names = (picker.buttons || (picker.sections?.[0].rows || []).map(r2 => r2.title));
    assert(names.some(n => /Priya Sharma/.test(n)), 'general dentist missing: ' + JSON.stringify(names));
    assert(!names.some(n => /Rahul Menon/.test(n)),
      'the orthodontist was offered for general dentistry — the department filter is not applied: '
      + JSON.stringify(names));
  });

  await test('choosing "not sure" auto-assigns the branch\'s generalist, no dentist picker shown', async () => {
    await send('Hi');
    await send('📅 Book Appointment', 'btn_0_1700000000103');
    // "Not sure" now asks what brings them in FIRST — the answer can still
    // change who they see at that point, which it could not once the dentist,
    // day and time were already chosen.
    const asked = await send('🩺 Not sure yet', 'general_consult');
    assert(asked.some(m => /What brings you in/.test(m.all)),
      'complaint should be asked before booking on the consult path: ' + JSON.stringify(asked));
    const r = await send('🔍 Checkup/Cleaning', 'btn_1_1700000000105');
    assert(!r.some(m => /Choose a dentist/.test(m.all)),
      'a patient who does not know what they need should not have to pick a NAME either: ' + JSON.stringify(r));
    // Priya Sharma is the branch's general dentist (matches "general" on both
    // specialization and department name) and sorts first in the auto-assign
    // query, so she is who gets booked — Rahul Menon (the orthodontist) never
    // appears here.
    const dates = r.find(m => /is free on these days/.test(m.all));
    assert(dates, 'auto-assigned doctor\'s date picker not shown: ' + JSON.stringify(r));
    assert(/Priya Sharma/.test(dates.all), 'wrong dentist auto-assigned: ' + JSON.stringify(dates));
    assert.strictEqual(state(), 'select_date');
  });

  await test('typing "not sure" works as well as tapping it', async () => {
    await send('Hi');
    await send('📅 Book Appointment', 'btn_0_1700000000104');
    await send('not sure');
    const r = await send('🔍 Checkup/Cleaning', 'btn_1_1700000000106');
    assert(!r.some(m => /Choose a dentist/.test(m.all)),
      'typed "not sure" should also skip the dentist picker: ' + JSON.stringify(r));
    assert(r.some(m => /is free on these days/.test(m.all)),
      'typed "not sure" did not reach the auto-assigned doctor\'s dates: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'select_date');
  });

  // Back to the Orthodontics booking the rest of the flow continues from.
  await test('resuming the braces booking with the general dentist', async () => {
    await send('Hi');
    await send('📅 Book Appointment', 'btn_0_1700000000102');
    const r = await send('Orthodontics & Braces', 'dept-2');
    assert(r.some(m => /Choose a dentist/.test(m.all)), 'dentist picker not shown: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'select_doctor');
  });

  await test('Tapping a dentist (list reply with UUID buttonId) shows dates', async () => {
    const r = await send('Dr. Priya Sharma', 'doc-1');
    assert(r.some(m => /When suits you|free on these days/.test(m.all)), 'date picker not shown: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'select_date');
  });

  await test('Tapping a date (list reply) shows time slots', async () => {
    const r = await send('Mon, 5 Jan', '2099-01-05');
    assert(r.some(m => /What time|Pick a time|with Dr\./.test(m.all)), 'slot picker not shown: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'select_slot');
  });

  await test('Tapping a slot (new patient) asks for name', async () => {
    const r = await send('10:00 – 10:30', 'slot-1');
    assert(r.some(m => /what name/i.test(m.text)), 'name prompt not shown: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'collect_name');
  });

  await test('Stale button tap during name collection re-prompts instead of storing title as name', async () => {
    // A stale non-menu button (e.g. an old "✅ Confirm") must not become the patient's name.
    // (Main-menu button titles are a deliberate escape hatch and are tested separately below.)
    const r = await send('✅ Confirm', 'btn_0_1700000000003');
    assert(r.some(m => /\*type\*/i.test(m.text)), 'expected typed-name re-prompt: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'collect_name');
  });

  await test('a malformed date of birth re-asks and still offers Skip', async () => {
    await send('Asha Verma');
    assert.strictEqual(state(), 'collect_dob');
    // Gender and email are no longer asked; DOB is optional but must not accept
    // rubbish silently — a bad date re-prompts WITH the escape hatch visible.
    const bad = await send('femle');
    assert(bad.some(m => /doesn't look like a date/i.test(m.text)), JSON.stringify(bad));
    assert(bad.some(m => (m.buttons || []).some(b => /skip/i.test(b))), 'no Skip offered');
    assert.strictEqual(state(), 'collect_dob');
    await send('15/08/1990');
    assert.strictEqual(state(), 'collect_chief_complaint');
    const ctxRaw = db.sessions.get(PHONE).context;
    const ctx = JSON.parse(require('../src/utils/encryption').decrypt(ctxRaw._enc));
    assert.strictEqual(ctx.patient_gender, undefined, 'gender must not be set from an unrecognised reply');
  });

  // Set by the confirmation-summary test below: the id of the "✅ Confirm"
  // button the summary actually minted.
  let confirmBtnId = null;

  await test('Typed name → DOB → reason → confirmation summary', async () => {
    assert.strictEqual(state(), 'collect_chief_complaint');
    const r = await send('🔍 Checkup/Cleaning', 'btn_1_1700000000006');
    const summary = r.find(m => /Check and confirm/.test(m.all));
    assert(summary, 'confirmation summary not shown: ' + JSON.stringify(r));
    confirmBtnId = summary.ids[0];
    assert.strictEqual(state(), 'confirm_booking');
  });

  await test('STALE btn_0 at confirm_booking does not book — it re-asks', async () => {
    // btn_0 of some older message (WhatsApp keeps every button tappable). It is
    // not consent to book, so nothing may be written.
    const r = await send('✅ Confirm', 'btn_0_1700000000099');
    assert(r.some(m => /check the details/i.test(m.text)),
      'expected a re-prompt for the stale tap: ' + JSON.stringify(r));
    assert.strictEqual(db.appointments.length, 0, 'a stale tap booked an appointment');
    assert.strictEqual(state(), 'confirm_booking');
    // The re-prompt minted fresh buttons — tap those instead.
    confirmBtnId = r.find(m => /check the details/i.test(m.text)).ids[0];
  });

  await test('REGRESSION: tapping ✅ Confirm completes the booking (not main-menu reset)', async () => {
    const r = await send('✅ Confirm', confirmBtnId);
    assert(!r.some(m => /How can I help you today/.test(m.text)),
      'confirm tap was reset to main menu — stale-button bug is back');
    assert(r.some(m => /\*Booked\*/.test(m.text)), 'confirmation not sent: ' + JSON.stringify(r));
    assert.strictEqual(db.appointments.length, 1, 'appointment row not created');
    assert(db.bookedSlots.has('slot-1'), 'slot not marked booked');
    assert.strictEqual(state(), 'idle');
  });

  await test('Stale MAIN MENU button during booking still exits to menu', async () => {
    await send('Hi');
    await send('📅 Book Appointment', 'btn_0_1700000000008'); // back into select_department
    const r = await send('🗓 My Appointments', 'btn_1_1700000000009');
    // Every main-menu send now goes through sendMainMenu, so this asserts the
    // shared shape (clinic name in the header) rather than one path's wording —
    // it was matching the old duplicate copy that this consolidation removed.
    assert(r.some(m => m.type === 'buttons' && m.header === tenant.name),
      'main-menu escape broken: ' + JSON.stringify(r));
    assert.strictEqual(state(), 'main_menu');
  });

  // ── Patient books their own subsequent sittings ─────────────
  // The first sitting of a treatment is booked at the desk; every one after it
  // is the patient's, prompted by a nudge that says "Reply *Treatment*".
  await test('with no ongoing treatment, *Treatment* says so instead of dead-ending', async () => {
    db.treatmentPlans = [];
    await send('Hi');
    const r = await send('Treatment');
    assert(r.some(m => /no treatment sittings/i.test(m.text)),
      'expected a plain "nothing waiting" reply: ' + JSON.stringify(r));
  });

  await test('the greeting surfaces an ongoing treatment (all 3 menu buttons are taken)', async () => {
    db.treatmentPlans = [{
      id: 'plan-1', title: 'Root canal 36', total_visits: 3, booked_visits: 1,
      hospital_id: 'hosp-1', hospital_name: 'Smile Dental',
      department_id: 'dept-1', department_name: 'General Dentistry',
      treating_doctor_id: 'doc-2', doctor_name: 'Rahul Menon',
      qualification: 'BDS, MDS', consultation_fee: 800, specialization: 'Orthodontist',
      completed_visits: 1,
    }];
    const r = await send('Hi');
    assert(r.some(m => /Ongoing treatment/i.test(m.text)), 'greeting did not mention it: ' + JSON.stringify(r));
    assert(r.some(m => /visit 2 of 3/.test(m.text)), 'greeting did not say which sitting is next');
  });

  await test('*Treatment* with ONE course skips the picker and goes straight to dates', async () => {
    await send('Hi');
    const r = await send('Treatment');
    assert(r.some(m => /Root canal 36/.test(m.text)), 'treatment not named: ' + JSON.stringify(r));
    assert(r.some(m => /When suits you|free on these days/.test(m.all)),
      'one course should not ask "which treatment?": ' + JSON.stringify(r));
    assert.strictEqual(state(), 'select_date');
  });

  await test('the sitting is booked with the TREATING dentist, not re-picked by the patient', async () => {
    const picker = sent.find(m => /When suits you|free on these days/.test(m.all));
    assert(/Rahul Menon/.test(picker.text),
      'dates should be the treating dentist\'s: ' + JSON.stringify(picker.text));
  });

  await test('*Treatment* mid-booking does NOT hijack the flow', async () => {
    await send('Hi');
    await send('📅 Book Appointment', 'btn_0_1700000000201'); // now at select_department
    const r = await send('Treatment');
    // It is not a treatment list, and not a silent no-op — the department step
    // owns the message and re-asks.
    assert(!r.some(m => /When suits you|free on these days/.test(m.all)), 'treatment keyword hijacked an active booking');
    assert.strictEqual(state(), 'select_department');
  });

  // ── MAIN-MENU KEYWORD ROUTING ────────────────────────────────
  // The My-Appointments test used to be /\bappointment\b|\bmy\b/ and ran BEFORE
  // the Book test, so it swallowed any sentence containing either word. These
  // pin the anchoring that replaced it.

  await test('"I need an appointment" starts a booking, not the empty list', async () => {
    db.sessions.delete(PHONE);
    await send('Hi');
    const r = await send('I need an appointment');
    assert(!r.some(m => /no appointments with us yet/i.test(m.all || m.text)),
      'a request to book was answered with "you have no bookings": ' + JSON.stringify(r));
    assert(state() !== 'main_menu',
      'expected the booking flow to have started, still at: ' + state());
  });

  await test('"my tooth pain" reaches complaint routing, not My Appointments', async () => {
    db.sessions.delete(PHONE);
    await send('Hi');
    const r = await send('my tooth pain');
    assert(!r.some(m => /no appointments with us yet/i.test(m.all || m.text)),
      'the word "my" hijacked a symptom: ' + JSON.stringify(r));
  });

  await test('"my appointments" on its own still shows the list', async () => {
    db.sessions.delete(PHONE);
    await send('Hi');
    const r = await send('my appointments');
    assert(r.some(m => /no appointments with us yet|Your appointments/i.test(m.all || m.text)),
      'the deliberate phrasing must still work: ' + JSON.stringify(r));
  });

  await test('the My Appointments BUTTON still works', async () => {
    db.sessions.delete(PHONE);
    await send('Hi');
    const r = await send('🗓 My Appointments', 'btn_1_1700000000301');
    assert(r.some(m => /no appointments with us yet|Your appointments/i.test(m.all || m.text)),
      'button reply broke: ' + JSON.stringify(r));
  });

  // ── STALE MAIN-MENU BUTTON ───────────────────────────────────
  // WhatsApp keeps every card tappable forever. The escape hatch listed the
  // OLD third button ("Check Status"), which no longer exists, so a tap on the
  // live "Address & Phone" card fell through to the current step handler.
  await test('a stale "Address & Phone" tap mid-booking returns to the menu', async () => {
    db.sessions.delete(PHONE);
    await send('Hi');
    await send('📅 Book Appointment', 'btn_0_1700000000401'); // → select_department
    const r = await send('📍 Address & Phone', 'btn_2_1700000000001');
    assert.strictEqual(state(), 'main_menu',
      'a stale main-menu tap must reset to the menu, landed at: ' + state());
    assert(r.some(m => m.type === 'buttons'), 'expected the menu card back: ' + JSON.stringify(r));
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
