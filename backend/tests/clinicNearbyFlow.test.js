'use strict';
/**
 * "Clinics near me" — end-to-end through the REAL webhook route.
 *
 * `/api/webhook/test` cannot cover this flow: it resolves a tenant itself and
 * calls botEngine.handle directly, which skips the whole point — the global
 * routing in processIncomingMessage that decides WHICH clinic a message belongs
 * to. So this drives Meta-shaped payloads at POST /api/webhook/whatsapp with
 * the whatsapp senders patched in-process to record what would have gone out.
 *
 * Self-seeding: it creates its own tenants (schemas included, because a clinic
 * the test SELECTS must have somewhere to write its bot session and
 * wa_messages row) and drops them again in `finally`. Invented city names are
 * used throughout so the assertions hold whatever else is in the dev database —
 * the city picker lists every active tenant's city, so an exact-match assertion
 * on that list would break the moment someone seeds another clinic.
 *
 * Needs postgres up (docker-compose up -d) and migrations run.
 * Run: node tests/clinicNearbyFlow.test.js
 */
process.env.NODE_ENV = 'test';
// A port of its own, so the test does not fight a `npm run dev` already on 3001.
process.env.PORT = process.env.TEST_PORT || '3099';

// index.js first: it loads dotenv and binds the server. Requiring the whatsapp
// module afterwards hands back the SAME cached instance webhook.js holds, so
// patching its exports here is what webhook.js actually calls.
require('../src/index');
const { query } = require('../src/db');
const { createTenantSchema, runTenantMigrations } = require('../src/db/tenantMigrate');
const wa = require('../src/services/whatsapp');

let sent = [];
wa.sendText = async (to, text) => { sent.push({ type: 'text', to, text }); return 'wamid.stub'; };
wa.sendButtons = async (to, text, buttons) => { sent.push({ type: 'buttons', to, text, buttons }); return 'wamid.stub'; };
wa.sendList = async (to, text, label, sections) => { sent.push({ type: 'list', to, text, label, sections }); return 'wamid.stub'; };
wa.sendTemplate = async () => 'wamid.stub';
wa.sendImage = async () => 'wamid.stub';

const BASE = `http://localhost:${process.env.PORT}`;
const SLUG_PREFIX = 'nearbytest-';
const RUN = Date.now().toString(36);
const PHONES = ['919990000801', '919990000802', '919990000803', '919990000804', '919990000805'];

// Invented so they cannot collide with a real clinic's name or city.
const FIXTURES = [
  { key: 'a', name: 'Aurelia Dental Clinic',    city: 'Quintonia' },
  { key: 'b', name: 'Borealis Dental Clinic',   city: 'Quintonia' },
  { key: 'c', name: 'Cassiopeia Dental Clinic', city: 'Zephyrhaven' },
];

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`); failed++; }
}
function checkMatch(name, actual, re) {
  if (re.test(String(actual))) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}\n     ${re} did not match: ${JSON.stringify(actual)}`); failed++; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

let seq = 0;
async function inbound(phone, msg) {
  sent = [];
  const message = { from: phone, id: `wamid.NEARBY.${RUN}.${++seq}`, timestamp: `${Math.floor(Date.now() / 1000)}`, ...msg };
  const res = await fetch(`${BASE}/api/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: '0', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: {}, messages: [message] } }] }],
    }),
  });
  if (res.status !== 200) throw new Error(`webhook returned ${res.status}`);
  // The route ACKs Meta immediately and processes afterwards, so poll for the
  // first send rather than guessing a fixed delay, then let any follow-up land.
  for (let i = 0; i < 100 && sent.length === 0; i++) await sleep(50);
  await sleep(250);
  return sent;
}
const text = t => ({ type: 'text', text: { body: t } });
const listReply = (id, title) => ({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title } } });

const sessionOf = async phone => (await query(
  `SELECT state, tenant_id, search_matches FROM global_bot_sessions WHERE phone=$1`, [phone]
)).rows[0] || null;

async function dropFixtures() {
  const r = await query(`SELECT schema_name FROM tenants WHERE slug LIKE $1`, [SLUG_PREFIX + '%']);
  for (const row of r.rows) {
    // Validated the same way tenantQuery validates, since this interpolates.
    if (/^tenant_[a-z0-9_]+$/.test(row.schema_name)) {
      await query(`DROP SCHEMA IF EXISTS ${row.schema_name} CASCADE`);
    }
  }
  await query(`DELETE FROM tenants WHERE slug LIKE $1`, [SLUG_PREFIX + '%']);
  await query(`DELETE FROM global_bot_sessions WHERE phone = ANY($1)`, [PHONES]);
}

async function createFixtures() {
  const made = {};
  for (const f of FIXTURES) {
    const slug = `${SLUG_PREFIX}${RUN}-${f.key}`;
    const schema = 'tenant_' + slug.replace(/-/g, '_');
    const r = await query(
      `INSERT INTO tenants (name, slug, schema_name, owner_email, plan, status, city)
       VALUES ($1,$2,$3,$4,'starter','active',$5) RETURNING id, name, city`,
      [f.name, slug, schema, `${slug}@example.test`, f.city]
    );
    // A real schema, not just a public row: selecting this clinic writes a bot
    // session and a wa_messages row into it.
    await createTenantSchema(schema);
    await runTenantMigrations(schema);
    made[f.key] = r.rows[0];
  }
  return made;
}

(async () => {
  await sleep(1500); // let the server bind

  // Defensive: a previous run that died mid-way would otherwise poison the
  // city list (and leave tenant rows whose schemas `npm run migrate` walks).
  await dropFixtures();
  const T = await createFixtures();

  console.log('\nclinics near me — end-to-end through the real webhook\n');

  // ── First contact offers BOTH paths ──────────────────────────
  const [P1, P2, P3, P4, P5] = PHONES;
  let out = await inbound(P1, text('Hi'));
  check('first contact sends one message', out.length, 1);
  check('first contact is an interactive button message', out[0]?.type, 'buttons');
  checkMatch('body still asks for the clinic NAME', out[0]?.text, /send your clinic's name/i);
  check('offers the nearby button', out[0]?.buttons, ['📍 Clinics near me']);

  // ── Tapping it asks for a city ───────────────────────────────
  out = await inbound(P1, text('📍 Clinics near me'));
  check('nearby reply is a city list', out[0]?.type, 'list');
  checkMatch('asks which city', out[0]?.text, /which city/i);
  const rows = out[0]?.sections?.[0]?.rows || [];
  const titles = rows.map(r => r.title);
  // A subset assertion on purpose — other clinics in the database contribute
  // their own cities, and that is correct behaviour, not a failure.
  check('our cities are offered', ['Quintonia', 'Zephyrhaven'].every(c => titles.includes(c)), true);
  check('cities are de-duplicated', titles.filter(t => t === 'Quintonia').length, 1);
  check('cities are sorted', titles, [...titles].sort((a, b) => a.localeCompare(b)));
  check('city row ids are namespaced', rows.every(r => r.id === 'city:' + r.title), true);
  check('session parked in select_city', (await sessionOf(P1))?.state, 'select_city');

  // ── Picking a city lists only that city's clinics ────────────
  out = await inbound(P1, listReply('city:Quintonia', 'Quintonia'));
  check('city pick returns a clinic list', out[0]?.type, 'list');
  checkMatch('names the city', out[0]?.text, /Quintonia/);
  const quint = (out[0]?.sections?.[0]?.rows || []).map(r => r.title).sort();
  check('exactly that city\'s clinics', quint, ['Aurelia Dental Clinic', 'Borealis Dental Clinic'].sort());
  let st = await sessionOf(P1);
  check('back to select_tenant', st?.state, 'select_tenant');
  check('shortlist stored so a numbered reply resolves', (st?.search_matches || []).length, 2);
  check('still not attached to any clinic', st?.tenant_id, null);

  // ── A city with ONE clinic is confirmed, never auto-attached ──
  await inbound(P2, text('Hi'));
  await inbound(P2, text('nearby'));
  out = await inbound(P2, listReply('city:Zephyrhaven', 'Zephyrhaven'));
  check('single-clinic city still returns a list', out[0]?.type, 'list');
  const solo = out[0]?.sections?.[0]?.rows || [];
  check('one row', solo.length, 1);
  check('NOT auto-attached to the only clinic', (await sessionOf(P2))?.tenant_id, null);

  // ── Selecting the clinic finally attaches ────────────────────
  out = await inbound(P2, listReply(solo[0].id, solo[0].title));
  st = await sessionOf(P2);
  check('clinic selected → session active', st?.state, 'active');
  check('attached to the clinic that was picked', st?.tenant_id, T.c.id);
  checkMatch('confirms the clinic', out.map(o => o.text).join(' | '), /Clinic selected/i);

  // ── Typing a city while being asked for one ──────────────────
  await inbound(P3, text('Hi'));
  await inbound(P3, text('near me'));
  out = await inbound(P3, text('quint'));
  check('unique prefix typed in select_city resolves', out[0]?.type, 'list');
  checkMatch('resolved to Quintonia', out[0]?.text, /Quintonia/);

  // ── …but a city name is NOT a city pick outside select_city ──
  // The sharp edge: "Quintonia" typed at the entry step is search text. Reading
  // it as a city would answer a question the patient was never asked.
  await inbound(P4, text('Hi'));
  out = await inbound(P4, text('Quintonia'));
  check('city name at the entry step is a NAME search', out[0]?.type, 'buttons');
  checkMatch('and finds nothing, rather than listing the city', out[0]?.text, /No clinic found/i);
  check('not attached, not parked in select_city', (await sessionOf(P4))?.state, 'select_tenant');

  // ── A unique name still auto-selects ─────────────────────────
  out = await inbound(P4, text('aurelia'));
  st = await sessionOf(P4);
  check('name search still auto-selects a unique match', st?.state, 'active');
  check('attached to the named clinic', st?.tenant_id, T.a.id);

  // ── "Hi" from the city step restarts cleanly ─────────────────
  await inbound(P5, text('Hi'));
  await inbound(P5, text('nearby'));
  check('parked in select_city', (await sessionOf(P5))?.state, 'select_city');
  out = await inbound(P5, text('Hi'));
  check('"Hi" leaves select_city', (await sessionOf(P5))?.state, 'select_tenant');
  check('"Hi" re-offers the entry prompt', out[0]?.type, 'buttons');

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return failed;
})()
  .then(async failures => {
    await dropFixtures().catch(e => console.error('cleanup failed:', e.message));
    process.exit(failures ? 1 : 0);
  })
  .catch(async err => {
    console.error('\nTEST ERROR:', err);
    await dropFixtures().catch(e => console.error('cleanup failed:', e.message));
    process.exit(2);
  });
