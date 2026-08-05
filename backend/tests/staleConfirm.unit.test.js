'use strict';
/**
 * DB-free unit tests for replies that must NOT be taken at face value.
 *
 * 1. Destructive confirms (cancel / reschedule / book) used to accept a bare
 *    positional "btn_0". whatsapp.js mints ids as `btn_${i}_${Date.now()}` and
 *    WhatsApp keeps every button it ever delivered tappable, so btn_0 means
 *    "the first button of SOME message we once sent" — a patient at the
 *    "This cannot be undone. Are you sure?" step who scrolled up and tapped the
 *    still-live "🔄 Reschedule" button from three steps earlier had their
 *    appointment cancelled and the slot released without ever answering.
 *
 * 2. Unrecognised free text at the date and slot pickers used to send
 *    "❌ Booking cancelled." and wipe the context — typing "tomorrow" at the
 *    date list cost the patient the whole booking, unlike the sibling
 *    treatment/dentist steps which re-ask.
 *
 * 3. A feedback reply of "3rd visit, staff were lovely" used to be filed as a
 *    3-star rating (parseInt), discarding the comment.
 *
 * Run: node tests/staleConfirm.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_QUEUE = 'true';
process.env.JWT_SECRET = 'unit-test-secret-at-least-32-chars-long!!';

const path = require('path');
const assert = require('assert');

// ── In-memory tenant data ─────────────────────────────────────
const db = {
  sessions: new Map(),
  appointments: [{ id: 'appt-1', booking_id: 'MB0001', status: 'confirmed', slot_id: 'slot-9' }],
  slots: new Map([['slot-9', 'booked'], ['slot-10', 'available']]),
};

function rows(r) { return { rows: r, rowCount: r.length }; }

async function routeQuery(sql, params = []) {
  const q = String(sql).replace(/\s+/g, ' ').trim();

  if (q.startsWith('INSERT INTO bot_sessions')) {
    const phone = params[0];
    if (q.includes('DO UPDATE')) {
      const s = db.sessions.get(phone) || { phone };
      s.state = params[1];
      s.context = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
      s.last_activity = new Date();
      db.sessions.set(phone, s);
    } else if (!db.sessions.has(phone)) {
      db.sessions.set(phone, { phone, state: 'idle', context: {}, last_activity: new Date() });
    }
    return rows([]);
  }
  if (q.startsWith('SELECT * FROM bot_sessions')) {
    const s = db.sessions.get(params[0]);
    return rows(s ? [{ ...s }] : []);
  }

  // cancel: UPDATE appointments SET status='cancelled' ... AND status='confirmed'
  if (q.startsWith("UPDATE appointments SET status='cancelled'")) {
    const a = db.appointments.find(x => x.id === params[1] && x.status === 'confirmed');
    if (!a) return rows([]);
    a.status = 'cancelled';
    return rows([{ id: a.id }]);
  }
  // reschedule: lock the appointment row
  if (q.includes('FROM appointments WHERE id=') && q.includes('FOR UPDATE')) {
    const a = db.appointments.find(x => x.id === params[0] && x.status === 'confirmed');
    return rows(a ? [{ id: a.id, slot_id: a.slot_id }] : []);
  }
  if (q.startsWith("UPDATE time_slots SET status='booked'")) {
    if (db.slots.get(params[0]) !== 'available') return rows([]);
    db.slots.set(params[0], 'booked');
    return rows([{ id: params[0] }]);
  }
  if (q.startsWith("UPDATE time_slots SET status='available'")) {
    db.slots.set(params[0], 'available');
    return rows([]);
  }
  if (q.startsWith('UPDATE appointments SET slot_id=')) {
    const a = db.appointments.find(x => x.id === params[3]);
    if (a) { a.slot_id = params[0]; a.appointment_date = params[1]; a.rescheduled = true; }
    return rows([]);
  }

  // available time slots for a date (bookingFlow re-query after a date is picked)
  if (q.includes('FROM time_slots WHERE doctor_id') && q.startsWith('SELECT')) {
    return rows([{ id: 'slot-10', start_time: '10:00:00', end_time: '10:30:00' }]);
  }

  if (q.includes('FROM appointment_feedback')) return rows([]);
  if (q.includes('FROM patients WHERE phone')) return rows([]);
  if (q.includes('FROM users WHERE role')) return rows([]); // no admins to notify
  return rows([]);
}

const mockClient = {
  async query(sql, params) {
    const q = String(sql).trim().toUpperCase();
    if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' || q.startsWith('SET LOCAL')) return rows([]);
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
const dbPath = path.resolve(__dirname, '../src/db/index.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// Stub outgoing WhatsApp. sendButtons mints ids the way the real one does, so a
// test can tap either the button that was just rendered or a stale one.
const wa = require('../src/services/whatsapp');
const sent = [];
wa.sendText = async (to, text) => { sent.push({ type: 'text', text }); };
wa.sendButtons = async (to, text, buttons) => {
  sent.push({ type: 'buttons', text, buttons, ids: buttons.map((_, i) => `btn_${i}_${Date.now()}`) });
};
wa.sendList = async (to, text, label, sections) => { sent.push({ type: 'list', text, sections }); };

const { confirmButtonIndex, sendConfirmButtons, STATES, updateSession } = require('../src/services/bot/utils');
const { handleCancelConfirm, handleRescheduleConfirm } = require('../src/services/bot/appointmentFlow');
const { handleSelectDate, handleSelectSlot } = require('../src/services/bot/bookingFlow');
const botEngine = require('../src/services/botEngine');

const SCHEMA = 'tenant_demo';
const PHONE = '919222222222';
const tenant = { id: 't-1', slug: 'demo', name: 'Demo Clinic', schema_name: SCHEMA, settings: {} };

// send.* the handlers receive (same shape botEngine builds)
const send = {
  text: async (t) => { await wa.sendText(PHONE, t); },
  buttons: async (t, b) => { await wa.sendButtons(PHONE, t, b); },
  list: async (t, l, s) => { await wa.sendList(PHONE, t, l, s); },
};
function reset() { sent.length = 0; }
function texts() { return sent.map(m => m.text).join(' | '); }
function lastButtonIds() {
  for (let i = sent.length - 1; i >= 0; i--) if (sent[i].ids) return sent[i].ids;
  return null;
}

// A ctx as it exists at the cancel-confirm step, with the binding recorded by
// the prompt that got the patient there.
async function cancelCtx() {
  const ctx = {
    cancel_appt_id: 'appt-1', cancel_slot_id: 'slot-9', cancel_booking_id: 'MB0001',
    cancel_doctor_name: 'Priya Sharma', cancel_date: '2099-01-05', cancel_time: '10:00:00',
    cancel_reason: 'Schedule conflict',
  };
  await sendConfirmButtons(send, ctx, 'This cannot be undone. Are you sure?', ['Yes, Cancel It', 'No, Keep It']);
  return ctx;
}

async function rescheduleCtx() {
  const ctx = {
    reschedule_appt_id: 'appt-1', reschedule_old_slot_id: 'slot-9', reschedule_new_slot_id: 'slot-10',
    reschedule_doctor_name: 'Priya Sharma', reschedule_booking_id: 'MB0001',
    reschedule_old_date: '2099-01-05', reschedule_old_time: '10:00:00',
    reschedule_new_date: '2099-01-06', reschedule_new_time: '10:00:00',
  };
  await sendConfirmButtons(send, ctx, 'Confirm the change?', ['✅ Yes, Reschedule', '❌ No, Keep Original']);
  return ctx;
}

function restoreAppointment() {
  db.appointments[0].status = 'confirmed';
  db.appointments[0].slot_id = 'slot-9';
  db.appointments[0].rescheduled = false;
  db.slots.set('slot-9', 'booked');
  db.slots.set('slot-10', 'available');
}

// A stale id: minted long before the confirm prompt (btn_0 of an older message).
const STALE_BTN_0 = 'btn_0_1700000000000';
const STALE_BTN_1 = 'btn_1_1700000000000';

async function run() {
  let pass = 0, fail = 0;
  async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  }

  console.log('\nStale-tap / re-prompt unit tests\n');

  // ── confirmButtonIndex ──────────────────────────────────────
  await test('confirmButtonIndex: typed text is not a positional reply (null)', () => {
    assert.strictEqual(confirmButtonIndex({ _confirm_btns: { from: 1, to: 2 } }, 'yes'), null);
    assert.strictEqual(confirmButtonIndex({ _confirm_btns: { from: 1, to: 2 } }, '1'), null);
    // A list-row id (UUID / date) is not positional either.
    assert.strictEqual(confirmButtonIndex({ _confirm_btns: { from: 1, to: 2 } }, '2099-01-05'), null);
  });

  await test('confirmButtonIndex: a btn_N from this prompt returns its index', () => {
    const ctx = {};
    return sendConfirmButtons(send, ctx, 'x', ['a', 'b']).then(() => {
      const ids = lastButtonIds();
      assert.strictEqual(confirmButtonIndex(ctx, ids[0]), 0);
      assert.strictEqual(confirmButtonIndex(ctx, ids[1]), 1);
    });
  });

  await test('confirmButtonIndex: a btn_N from any other message is -1 (stale)', async () => {
    const ctx = {};
    await sendConfirmButtons(send, ctx, 'x', ['a', 'b']);
    assert.strictEqual(confirmButtonIndex(ctx, STALE_BTN_0), -1);
    // Bare "btn_0" with no timestamp cannot be attributed to anything.
    assert.strictEqual(confirmButtonIndex(ctx, 'btn_0'), null);
  });

  await test('confirmButtonIndex: no binding recorded fails CLOSED', async () => {
    assert.strictEqual(confirmButtonIndex({}, `btn_0_${Date.now()}`), -1);
  });

  // ── CANCEL_CONFIRM ──────────────────────────────────────────
  await test('CRITICAL: a stale btn_0 tap does NOT cancel the appointment', async () => {
    restoreAppointment();
    const ctx = await cancelCtx();
    reset();
    await handleCancelConfirm(PHONE, SCHEMA, tenant, send, ctx, STALE_BTN_0);
    assert.strictEqual(db.appointments[0].status, 'confirmed', 'appointment was cancelled by a stale tap');
    assert.strictEqual(db.slots.get('slot-9'), 'booked', 'slot was released by a stale tap');
    assert(/older message/.test(texts()), 'expected a re-ask: ' + texts());
    assert(!/\*Cancelled\*/.test(texts()), 'cancellation confirmation was sent');
  });

  await test('a stale btn_1 tap does not silently answer "keep" either — it re-asks', async () => {
    restoreAppointment();
    const ctx = await cancelCtx();
    reset();
    await handleCancelConfirm(PHONE, SCHEMA, tenant, send, ctx, STALE_BTN_1);
    assert(/older message/.test(texts()), 'expected a re-ask: ' + texts());
    assert.strictEqual(db.appointments[0].status, 'confirmed');
  });

  await test('the re-ask rebinds, so tapping ITS cancel button then cancels', async () => {
    restoreAppointment();
    const ctx = await cancelCtx();
    reset();
    await handleCancelConfirm(PHONE, SCHEMA, tenant, send, ctx, STALE_BTN_0);
    const freshIds = lastButtonIds();
    reset();
    // [1], not [0]: the re-ask offers "Move it instead" first too.
    await handleCancelConfirm(PHONE, SCHEMA, tenant, send, ctx, freshIds[1]);
    assert.strictEqual(db.appointments[0].status, 'cancelled', 'fresh tap did not cancel: ' + texts());
    assert(/\*Cancelled\*/.test(texts()), texts());
  });

  await test('tapping the real "Yes, cancel it" button cancels', async () => {
    restoreAppointment();
    const ctx = await cancelCtx();
    const ids = lastButtonIds();
    reset();
    await handleCancelConfirm(PHONE, SCHEMA, tenant, send, ctx, ids[1]);
    assert.strictEqual(db.appointments[0].status, 'cancelled', 'real tap did not cancel: ' + texts());
    assert.strictEqual(db.slots.get('slot-9'), 'available', 'slot not released');
  });

  await test('tapping the real "No, keep it" button keeps the appointment', async () => {
    restoreAppointment();
    const ctx = await cancelCtx();
    const ids = lastButtonIds();
    reset();
    await handleCancelConfirm(PHONE, SCHEMA, tenant, send, ctx, ids[2]);
    assert.strictEqual(db.appointments[0].status, 'confirmed');
    assert(/Still on/.test(texts()), texts());
  });

  // ── THE SAVE ───────────────────────────────────────────────
  // A patient who rings to cancel is routinely offered another day and takes
  // it. The bot used to automate only the losing half of that conversation:
  // "Schedule conflict" was one of the reasons on the previous screen and
  // still went straight to a red button.
  await test('"Move it instead" does NOT cancel the appointment', async () => {
    restoreAppointment();
    const ctx = await cancelCtx();
    const ids = lastButtonIds();
    reset();
    await handleCancelConfirm(PHONE, SCHEMA, tenant, send, ctx, ids[0]);
    assert.strictEqual(db.appointments[0].status, 'confirmed',
      'the save path cancelled the appointment: ' + texts());
  });

  await test('typing "move" is the save too', async () => {
    restoreAppointment();
    const ctx = await cancelCtx();
    reset();
    await handleCancelConfirm(PHONE, SCHEMA, tenant, send, ctx, 'move');
    assert.strictEqual(db.appointments[0].status, 'confirmed', texts());
  });

  // A STALE btn_0 must not reach the save either — it is unverifiable, and the
  // re-ask is the only correct answer to a tap we cannot attribute.
  await test('a stale btn_0 re-asks rather than silently rescheduling', async () => {
    restoreAppointment();
    const ctx = await cancelCtx();
    reset();
    await handleCancelConfirm(PHONE, SCHEMA, tenant, send, ctx, STALE_BTN_0);
    assert(/older message/.test(texts()), 'expected a re-ask: ' + texts());
    assert.strictEqual(db.appointments[0].status, 'confirmed');
  });

  await test('typed "yes" still cancels (unchanged)', async () => {
    restoreAppointment();
    const ctx = await cancelCtx();
    reset();
    await handleCancelConfirm(PHONE, SCHEMA, tenant, send, ctx, 'yes');
    assert.strictEqual(db.appointments[0].status, 'cancelled', texts());
  });

  await test('typed "2" cancels (numbered text fallback, shifted by the save)', async () => {
    restoreAppointment();
    const ctx = await cancelCtx();
    reset();
    await handleCancelConfirm(PHONE, SCHEMA, tenant, send, ctx, '2');
    assert.strictEqual(db.appointments[0].status, 'cancelled', texts());
  });

  await test('negative intent still wins over the word "cancel" it contains', async () => {
    for (const reply of ['no', "no, don't cancel", 'keep it', 'nahi', '3']) {
      restoreAppointment();
      const ctx = await cancelCtx();
      reset();
      await handleCancelConfirm(PHONE, SCHEMA, tenant, send, ctx, reply);
      assert.strictEqual(db.appointments[0].status, 'confirmed', `"${reply}" cancelled the appointment`);
    }
  });

  // ── RESCHEDULE_CONFIRM ──────────────────────────────────────
  await test('CRITICAL: a stale btn_0 tap does NOT reschedule the appointment', async () => {
    restoreAppointment();
    const ctx = await rescheduleCtx();
    reset();
    await handleRescheduleConfirm(PHONE, SCHEMA, tenant, send, ctx, STALE_BTN_0);
    assert.strictEqual(db.appointments[0].rescheduled, false, 'a stale tap moved the appointment');
    assert.strictEqual(db.slots.get('slot-10'), 'available', 'a stale tap locked the new slot');
    assert(/older message/.test(texts()), 'expected a re-ask: ' + texts());
  });

  await test('tapping the real "Yes, Reschedule" button reschedules', async () => {
    restoreAppointment();
    const ctx = await rescheduleCtx();
    const ids = lastButtonIds();
    reset();
    await handleRescheduleConfirm(PHONE, SCHEMA, tenant, send, ctx, ids[0]);
    assert.strictEqual(db.appointments[0].rescheduled, true, 'real tap did not reschedule: ' + texts());
    assert(/\*Moved\*/.test(texts()), texts());
  });

  await test('typed "yes" still reschedules; "no, keep it" still does not', async () => {
    restoreAppointment();
    let ctx = await rescheduleCtx();
    reset();
    await handleRescheduleConfirm(PHONE, SCHEMA, tenant, send, ctx, 'yes');
    assert.strictEqual(db.appointments[0].rescheduled, true, texts());

    restoreAppointment();
    ctx = await rescheduleCtx();
    reset();
    await handleRescheduleConfirm(PHONE, SCHEMA, tenant, send, ctx, "no, don't reschedule");
    assert.strictEqual(db.appointments[0].rescheduled, false, texts());
  });

  // ── DATE / SLOT re-prompts ──────────────────────────────────
  await test('unrecognised text at the date step re-asks instead of cancelling the booking', async () => {
    const ctx = { _dates: [{ date: '2099-01-05', label: 'Mon, 5 Jan', slots: 4 }], doctor_id: 'doc-1', hospital_id: 'h-1' };
    reset();
    await handleSelectDate(PHONE, SCHEMA, tenant, send, ctx, 'tomorrow');
    assert(!/Booking cancelled/.test(texts()), 'booking was discarded: ' + texts());
    assert(/tell which date/.test(texts()), texts());
    assert.strictEqual(db.sessions.get(PHONE).state, STATES.SELECT_DATE, 'left the date step');
  });

  await test('an empty _dates cache re-asks too (lost context write), still no cancel', async () => {
    const ctx = { _dates: [], doctor_id: 'doc-1', hospital_id: 'h-1' };
    reset();
    await handleSelectDate(PHONE, SCHEMA, tenant, send, ctx, 'tomorrow');
    assert(!/Booking cancelled/.test(texts()), 'booking was discarded: ' + texts());
    assert(/lost track of the dates/.test(texts()), texts());
    assert.strictEqual(db.sessions.get(PHONE).state, STATES.SELECT_DATE);
  });

  await test('a date NOT on the offered list is still refused (leaves/holidays guard intact)', async () => {
    const ctx = { _dates: [{ date: '2099-01-05', label: 'Mon, 5 Jan', slots: 4 }], doctor_id: 'doc-1', hospital_id: 'h-1' };
    reset();
    await handleSelectDate(PHONE, SCHEMA, tenant, send, ctx, '2099-12-25');
    assert(/not available/.test(texts()), texts());
    assert.strictEqual(ctx.appointment_date, undefined, 'an unoffered date was accepted');
  });

  await test('a date FROM the list still advances to the slot picker', async () => {
    const ctx = { _dates: [{ date: '2099-01-05', label: 'Mon, 5 Jan', slots: 4 }], doctor_id: 'doc-1', hospital_id: 'h-1' };
    reset();
    await handleSelectDate(PHONE, SCHEMA, tenant, send, ctx, '2099-01-05');
    // Assert the slot picker was actually rendered, not the wording of it —
    // `texts()` only joins message bodies, and the step title now lives in
    // WhatsApp's header slot with the times in the list rows.
    assert(sent.some(m => m.type === 'list' && (m.sections || []).some(s => /^Slots on /.test(s.title))),
      texts());
    assert.strictEqual(db.sessions.get(PHONE).state, STATES.SELECT_SLOT);
  });

  await test('unrecognised text at the slot step re-asks instead of cancelling the booking', async () => {
    const ctx = {
      _slots: [{ id: 'slot-10', start_time: '10:00:00', end_time: '10:30:00' }],
      appointment_date: '2099-01-05',
    };
    reset();
    await handleSelectSlot(PHONE, SCHEMA, tenant, send, ctx, 'morning', 'morning');
    assert(!/Booking cancelled/.test(texts()), 'booking was discarded: ' + texts());
    assert(/tell which time/.test(texts()), texts());
    assert.strictEqual(db.sessions.get(PHONE).state, STATES.SELECT_SLOT);
    assert.strictEqual(ctx.slot_id, undefined);
  });

  await test('an empty _slots cache re-asks too, still no cancel', async () => {
    const ctx = { _slots: [], appointment_date: '2099-01-05' };
    reset();
    await handleSelectSlot(PHONE, SCHEMA, tenant, send, ctx, '10 am', '10 am');
    assert(!/Booking cancelled/.test(texts()), 'booking was discarded: ' + texts());
    assert(/lost track of the times/.test(texts()), texts());
  });

  // ── FEEDBACK RATING ─────────────────────────────────────────
  await test('"3rd visit, staff were lovely" is not a 3-star rating', async () => {
    await updateSession(SCHEMA, PHONE, STATES.COLLECT_FEEDBACK_RATING, { feedback_appointment_id: 'appt-1' });
    reset();
    await botEngine.handle({ phone: PHONE, text: '3rd visit, staff were lovely', tenant });
    assert(/\*1\* to \*5\*/.test(texts()), 'expected a re-prompt, got: ' + texts());
    assert.strictEqual(db.sessions.get(PHONE).state, STATES.COLLECT_FEEDBACK_RATING,
      'a comment was accepted as a rating');
  });

  await test('a bare "4" is still a rating', async () => {
    await updateSession(SCHEMA, PHONE, STATES.COLLECT_FEEDBACK_RATING, { feedback_appointment_id: 'appt-1' });
    reset();
    await botEngine.handle({ phone: PHONE, text: '4', tenant });
    assert(/4\/5/.test(texts()), texts());
    assert.strictEqual(db.sessions.get(PHONE).state, STATES.COLLECT_FEEDBACK_COMMENT);
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
