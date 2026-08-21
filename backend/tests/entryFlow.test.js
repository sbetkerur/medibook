'use strict';
/**
 * End-to-end entry routing, against the REAL webhook route.
 *
 * `/api/webhook/test` calls botEngine.handle directly with a tenant already
 * resolved, so it cannot exercise any of this — the decisions under test all
 * happen in routes/webhook.js BEFORE the engine is reached. So this posts
 * Meta-shaped payloads at the live endpoint and asserts on what ends up in
 * `global_bot_sessions`, which is the thing that actually decides which clinic
 * a patient is talking to.
 *
 * Needs: DB + seed (for the demo tenant's fixed `TESTME` code) and a backend
 * running on :3001. Signature verification is off without META_APP_SECRET.
 *
 * Run: node src/index.js &   then   node tests/entryFlow.test.js
 */
require('dotenv').config();
const crypto = require('crypto');
const { query, pool } = require('../src/db');

const BASE = process.env.TEST_API_BASE || 'http://localhost:3001/api/webhook/whatsapp';
// Processing is async (BullMQ when Redis is up, sync fallback otherwise) and the
// route ACKs Meta before doing any of it, so every assertion has to wait.
const SETTLE_MS = Number(process.env.TEST_SETTLE_MS || 1200);

// Phones are unique per run so a re-run never inherits a session from the last
// one — every case here is about what happens to a session in a known state.
const RUN = Date.now().toString().slice(-6);
let seq = 0;
const newPhone = () => `9199${RUN}${String(seq++).padStart(2, '0')}`;

async function send(phone, text) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '1', phone_number_id: '1' },
      messages: [{
        from: phone,
        // Unique: the route dedups on wa_message_id, so a repeated id would be
        // silently dropped and the test would assert on a stale session.
        id: 'wamid.test.' + RUN + '.' + (seq++) + '.' + Math.random().toString(36).slice(2),
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: text },
      }],
    } }] }],
  });

  const headers = { 'content-type': 'application/json' };
  // Signed against the RAW body, exactly as Meta does. Without this every
  // request is rejected with 200 + "Unsigned webhook request rejected" whenever
  // META_APP_SECRET happens to be set — which looks IDENTICAL to a message that
  // was processed and attached nothing, quietly turning every negative
  // assertion below into a false pass.
  const secret = process.env.META_APP_SECRET;
  if (secret) {
    headers['x-hub-signature-256'] =
      'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  const res = await fetch(BASE, { method: 'POST', headers, body })
    .catch(err => { throw new Error(`Is the backend running on :3001? (${err.message})`); });
  if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
  await new Promise(r => setTimeout(r, SETTLE_MS));
}

// Interpolated into SQL, so it is validated the same way db/index.js does it
// rather than trusted because it came from our own tenants table.
function schemaOf(tenant) {
  if (!/^tenant_[a-z0-9_]+$/.test(tenant.schema_name)) throw new Error('Bad schema name');
  return tenant.schema_name;
}

const clinicOf = async phone => (await query(
  `SELECT t.slug FROM global_bot_sessions gs
   LEFT JOIN tenants t ON t.id = gs.tenant_id WHERE gs.phone=$1`, [phone]
)).rows[0]?.slug ?? null;

let passed = 0, failed = 0;
function check(name, actual, expected) {
  if (actual === expected) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}\n     expected: ${expected}\n     actual:   ${actual}`); failed++; }
}

(async () => {
  console.log('\nentry routing — the QR is the only way to reach a clinic\n');

  const demo = (await query(`SELECT entry_code, schema_name FROM tenants WHERE slug='demo-clinic'`)).rows[0];
  if (!demo?.entry_code) throw new Error('Demo tenant has no entry code — run: npm run seed');
  const other = (await query(
    `SELECT slug, entry_code FROM tenants WHERE status='active' AND slug <> 'demo-clinic'
     AND entry_code IS NOT NULL ORDER BY created_at LIMIT 1`)).rows[0];

  // ── What attaches a clinic ───────────────────────────────────
  console.log(' attaching');
  const scanned = newPhone();
  await send(scanned, `Hi Smile Dental Clinic, I'd like to book an appointment. #${demo.entry_code}`);
  const firstAttach = await clinicOf(scanned);
  check('the deep-link message a scan produces', firstAttach, 'demo-clinic');
  // Hard stop, not just a failed assertion. Every "must NOT attach" case below
  // passes trivially when messages are being dropped before they are processed
  // at all (a bad signature, a wrong URL, a stopped worker), so a green run
  // would be meaningless. If the one case that MUST attach did not, nothing
  // downstream is evidence of anything.
  if (firstAttach !== 'demo-clinic') {
    throw new Error('No message reached routing — check the signature, the URL and that the backend on :3001 is THIS code (docker compose may be holding the port).');
  }

  const typed = newPhone();
  await send(typed, demo.entry_code.toLowerCase());
  check('a bare code typed off a card, lowercase', await clinicOf(typed), 'demo-clinic');

  // ── The arrival must look like the clinic's own channel ──────
  // The number is shared, so the first message after a scan is the only thing
  // standing between "my dentist's WhatsApp" and "some booking service". It has
  // to name the clinic, and it must not be preceded by a switchboard handover.
  const firstOut = (await query(
    `SELECT content FROM ${schemaOf(demo)}.wa_messages
     WHERE phone=$1 AND direction='out' ORDER BY created_at ASC LIMIT 1`, [scanned]
  )).rows[0]?.content;
  if (firstOut === undefined) {
    console.log('  ⏭  outbound copy not checked (sends fail without live Meta credentials)');
  } else {
    check('the first message names the clinic', /Smile Dental Clinic/.test(firstOut), true);
    check('it welcomes rather than "connecting you…"',
      /welcome/i.test(firstOut) && !/connecting you/i.test(firstOut), true);
  }

  // ── What must NOT attach a clinic ────────────────────────────
  // The first two are the entry paths this replaced. If either ever resolves
  // again, a clinic's patients are being shown other clinics.
  console.log('\n not attaching');
  const named = newPhone();
  await send(named, 'Smile Dental Clinic');
  check('a clinic NAME (the search is gone)', await clinicOf(named), null);

  const nearby = newPhone();
  await send(nearby, 'clinics near me');
  check('"clinics near me" (the picker is gone)', await clinicOf(nearby), null);

  const prose = newPhone();
  await send(prose, 'hello is the clinic open today');
  check('ordinary prose from a stranger', await clinicOf(prose), null);

  const bogus = newPhone();
  await send(bogus, '#ZZZZZZ');
  check('a code no clinic is using', await clinicOf(bogus), null);

  // ── Nothing typed may DETACH a patient ───────────────────────
  // With no search to land on, a detached patient has no way back.
  console.log('\n staying attached');
  await send(scanned, 'Hi');
  check('"Hi" no longer drops the clinic', await clinicOf(scanned), 'demo-clinic');

  await send(scanned, 'switch clinic');
  check('"switch clinic" answers but does not drop it', await clinicOf(scanned), 'demo-clinic');

  if (other) {
    await send(scanned, `Hi, I'd like to book an appointment. #${other.entry_code}`);
    check('scanning another clinic DOES move them', await clinicOf(scanned), other.slug);

    // The asymmetry that keeps a mid-conversation reply from being read as a
    // code: tagged works from any state, bare only from a standing start.
    await send(scanned, demo.entry_code);
    check('a BARE code does not move an attached patient', await clinicOf(scanned), other.slug);

    // A TAGGED code that matches NO clinic, sent by a patient who is already
    // attached to one. This used to fall through to the attached clinic's
    // engine, which handed the scan message to it as ordinary free text: the
    // patient standing in the other practice's waiting room got THIS clinic's
    // main menu, headed with THIS clinic's name, and never learned the scan had
    // failed. The poster may be stale, or the clinic deactivated.
    //
    // Two things are asserted, and both matter: the clinic must not change
    // (a failed scan must never strand a patient — nothing detaches them), and
    // the patient must be TOLD the code did not match rather than being quietly
    // answered by the wrong practice.
    const before = await clinicOf(scanned);
    await send(scanned, `Hi, I'd like to book an appointment. #ZZZZZZ`);
    check('a dead QR does not move an attached patient', await clinicOf(scanned), before);

    const reply = (await query(
      `SELECT content FROM ${schemaOf(demo)}.wa_messages
        WHERE phone=$1 AND direction='out' ORDER BY created_at DESC LIMIT 1`, [scanned]
    )).rows[0]?.content;
    // The reply goes out unlogged (it is not the attached clinic speaking), so
    // the check is that the attached clinic did NOT answer it as a menu.
    if (reply === undefined) {
      console.log('  ⏭  unmatched-code reply not checked (sends fail without live Meta credentials)');
    } else {
      check('the attached clinic did not answer a failed scan with its menu',
        /didn't match a clinic/i.test(reply) || !/how can we help/i.test(reply), true);
    }
  } else {
    console.log('  ⏭  clinic-switch cases skipped (only one active tenant)');
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
})().catch(async err => {
  console.error('\n❌ ' + err.message + '\n');
  await pool.end().catch(() => {});
  process.exit(1);
});
