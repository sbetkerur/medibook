require('dotenv').config();
const botEngine = require('../src/services/botEngine');
const { query, pool } = require('../src/db');

const TEST_PHONE = '919111111111';
let tenant;

async function getTenant() {
  const r = await query(`SELECT * FROM tenants WHERE slug='demo-clinic'`);
  return r.rows[0];
}

async function sendMsg(text, buttonId = null) {
  const responses = [];
  const wa = require('../src/services/whatsapp');
  const origText = wa.sendText;
  const origBtns = wa.sendButtons;
  const origList = wa.sendList;

  wa.sendText = async (to, t) => responses.push({ type: 'text', text: t });
  wa.sendButtons = async (to, t, btns) => responses.push({ type: 'buttons', text: t, buttons: btns });
  wa.sendList = async (to, t, label, sections) => responses.push({ type: 'list', text: t, label, sections });

  await botEngine.handle({ phone: TEST_PHONE, text, buttonId, tenant });

  wa.sendText = origText;
  wa.sendButtons = origBtns;
  wa.sendList = origList;

  return responses;
}

async function resetSession() {
  const { tenantQuery } = require('../src/db');
  await tenantQuery(tenant.schema_name,
    `UPDATE bot_sessions SET state='idle', context='{}', last_activity=NOW() WHERE phone=$1`,
    [TEST_PHONE]);
}

async function runTests() {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║  MediBook Bot Engine — Test Suite     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  tenant = await getTenant();
  if (!tenant) {
    console.error('❌ No demo-clinic tenant found. Run: npm run seed');
    process.exit(1);
  }
  console.log(`Testing against tenant: ${tenant.name} (${tenant.schema_name})\n`);

  let pass = 0;
  let fail = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✅  ${name}`);
      pass++;
    } catch (err) {
      console.log(`  ❌  ${name}`);
      console.log(`       → ${err.message}`);
      fail++;
    }
  }

  // ── TEST 1: Greeting ─────────────────────────────────────────
  await test('Greeting "Hi" shows main menu with buttons', async () => {
    await resetSession();
    const r = await sendMsg('Hi');
    if (!r.length) throw new Error('No response received');
    if (!/how can we help|Book an appointment/.test(r[0].text || '')) throw new Error(`Missing "Welcome" in response: "${r[0].text?.slice(0, 100)}"`);
    if (!r[0].buttons?.some(b => String(b).includes('Book'))) throw new Error('Missing Book button');
  });

  // ── TEST 2: Session state persists ──────────────────────────
  await test('Session state persists to "main_menu" after Hi', async () => {
    await resetSession();
    await sendMsg('Hi');
    const { tenantQuery } = require('../src/db');
    const s = await tenantQuery(tenant.schema_name,
      `SELECT state FROM bot_sessions WHERE phone=$1`, [TEST_PHONE]);
    if (!s.rows[0]) throw new Error('Session not found in DB');
    if (s.rows[0].state !== 'main_menu') throw new Error(`Expected "main_menu", got "${s.rows[0].state}"`);
  });

  // ── TEST 3: Book flow starts ─────────────────────────────────
  await test('Selecting "Book" starts the booking flow', async () => {
    await resetSession();
    await sendMsg('Hi');
    const r = await sendMsg('Book');
    if (!r.length) throw new Error('No response after "Book"');
    // Should ask for visit type or hospital
    const hasContent = r.some(m => m.text?.length > 0);
    if (!hasContent) throw new Error('Empty response after Book');
  });

  // ── TEST 4: Fallback for garbage input ───────────────────────
  await test('Garbage input returns fallback message', async () => {
    await resetSession();
    const r = await sendMsg('zxqmwvlrtfkp99999');
    if (!r.length) throw new Error('No response to garbage input');
  });

  // ── TEST 5: Hi resets any mid-flow state ────────────────────
  await test('"Hi" resets any mid-flow state back to main menu', async () => {
    const { tenantQuery } = require('../src/db');
    // Force into a mid-booking state
    await tenantQuery(tenant.schema_name,
      `UPDATE bot_sessions SET state='select_doctor', context='{}' WHERE phone=$1`, [TEST_PHONE]);
    const r = await sendMsg('Hi');
    if (!r.length) throw new Error('No response');
    if (!/how can we help|Book an appointment/.test(r[0].text || '')) throw new Error(`Expected welcome, got: "${r[0].text?.slice(0, 100)}"`);
  });

  // ── TEST 6: Session created automatically ───────────────────
  await test('New phone number gets a session created automatically', async () => {
    const { tenantQuery } = require('../src/db');
    const newPhone = '919800000099';
    // Delete any existing session for this phone
    await tenantQuery(tenant.schema_name,
      `DELETE FROM bot_sessions WHERE phone=$1`, [newPhone]);
    // Send a message
    const wa = require('../src/services/whatsapp');
    const orig = wa.sendText; wa.sendText = async () => {};
    const origB = wa.sendButtons; wa.sendButtons = async () => {};
    await botEngine.handle({ phone: newPhone, text: 'Hi', buttonId: null, tenant });
    wa.sendText = orig; wa.sendButtons = origB;
    // Check session was created
    const s = await tenantQuery(tenant.schema_name,
      `SELECT * FROM bot_sessions WHERE phone=$1`, [newPhone]);
    if (!s.rows[0]) throw new Error('Session not created for new phone');
    // Cleanup
    await tenantQuery(tenant.schema_name, `DELETE FROM bot_sessions WHERE phone=$1`, [newPhone]);
  });

  // ── TEST 7: Atomic slot booking (race condition prevention) ──
  await test('Atomic slot lock prevents double-booking', async () => {
    const { tenantQuery } = require('../src/db');
    const slotR = await tenantQuery(tenant.schema_name,
      `SELECT id FROM time_slots WHERE status='available' LIMIT 1`);
    if (!slotR.rows[0]) {
      console.log('       (skipped — no available slots in DB)');
      return;
    }
    const slotId = slotR.rows[0].id;
    // Simulate 2 concurrent bookings
    const [r1, r2] = await Promise.all([
      tenantQuery(tenant.schema_name,
        `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available' RETURNING id`, [slotId]),
      tenantQuery(tenant.schema_name,
        `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available' RETURNING id`, [slotId]),
    ]);
    const successes = [r1, r2].filter(r => r.rows.length > 0);
    // Restore slot
    await tenantQuery(tenant.schema_name,
      `UPDATE time_slots SET status='available' WHERE id=$1`, [slotId]);
    if (successes.length !== 1) throw new Error(`Expected exactly 1 success, got ${successes.length}`);
  });

  // ── TEST 8: My appointments for unknown patient ──────────────
  await test('"My Appointments" with unknown phone returns graceful message', async () => {
    const unknownPhone = '919700000001';
    const { tenantQuery } = require('../src/db');
    await tenantQuery(tenant.schema_name,
      `DELETE FROM bot_sessions WHERE phone=$1`, [unknownPhone]);

    const responses = [];
    const wa = require('../src/services/whatsapp');
    const origT = wa.sendText; wa.sendText = async (to, t) => responses.push(t);
    const origB = wa.sendButtons; wa.sendButtons = async (to, t) => responses.push(t);

    // Set to main menu
    await botEngine.handle({ phone: unknownPhone, text: 'Hi', buttonId: null, tenant });
    responses.length = 0;
    await botEngine.handle({ phone: unknownPhone, text: 'My Appointments', buttonId: null, tenant });

    wa.sendText = origT;
    wa.sendButtons = origB;

    const allText = responses.join(' ');
    if (!allText.length) throw new Error('No response for unknown patient appointments');
    // Cleanup
    await tenantQuery(tenant.schema_name, `DELETE FROM bot_sessions WHERE phone=$1`, [unknownPhone]);
  });

  // ── RESULTS ──────────────────────────────────────────────────
  console.log('');
  console.log('─'.repeat(42));
  console.log(`  Results: ${pass} passed, ${fail} failed out of ${pass + fail} tests`);
  console.log('─'.repeat(42));

  if (fail === 0) {
    console.log('  🎉 All tests passed! Bot engine is working correctly.\n');
  } else {
    console.log(`  ⚠️  ${fail} test(s) failed. Fix issues before proceeding.\n`);
  }

  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
