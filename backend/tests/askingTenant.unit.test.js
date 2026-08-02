'use strict';
/**
 * DB-free unit tests for resolveAskingTenant (routes/webhook.js).
 *
 * On a shared WhatsApp number, inbound routing follows the clinic the PATIENT
 * selected. That is wrong for a question a CLINIC asked unprompted — a
 * reminder's "yes", a feedback "4" — so those get redirected back to the asker.
 * The redirect has two failure modes this file pins down:
 *
 *   1. At main_menu the digits ARE the menu (botEngine reads '1' as Book, '2'
 *      as My Appointments, '3' as Check Status) and RATING_REPLY_RE is /^[1-5]$/.
 *      A patient who switched clinics and typed '1' to book had it filed as a
 *      1-star review against the clinic they left, and never got the booking.
 *
 *   2. Redirecting into a clinic that is mid-conversation does not deliver the
 *      answer: the reminder intercept only consumes a confirmation when that
 *      session is idle, so a "yes" handed to an abandoned booking's select_date
 *      step came back as "❌ Booking cancelled." from a clinic the patient
 *      wasn't talking to.
 *
 * Run: node tests/askingTenant.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_QUEUE = 'true';
process.env.JWT_SECRET = 'unit-test-secret-at-least-32-chars-long!!';

const path = require('path');
const assert = require('assert');

// ── Scenario knobs, reset per test ────────────────────────────
const world = {
  pendingTenantId: 'tenant-a',   // who is waiting for an answer (null = nobody)
  currentState: 'idle',          // bot_sessions.state in the SELECTED clinic
  askingState: 'idle',           // bot_sessions.state in the ASKING clinic
  askingHasReminder: true,       // an unanswered reminder_confirmations row?
};

function rows(r) { return { rows: r, rowCount: r.length }; }

const TENANT_A = { id: 'tenant-a', slug: 'clinic-a', name: 'Clinic A', schema_name: 'tenant_a', status: 'active' };
const TENANT_B = { id: 'tenant-b', slug: 'clinic-b', name: 'Clinic B', schema_name: 'tenant_b', status: 'active' };

async function routeQuery(sql, params = []) {
  const q = String(sql).replace(/\s+/g, ' ').trim();
  if (q.includes('FROM global_pending_replies')) {
    return rows(world.pendingTenantId ? [{ tenant_id: world.pendingTenantId }] : []);
  }
  if (q.includes('FROM tenants WHERE id=')) {
    const t = [TENANT_A, TENANT_B].find(x => x.id === params[0]);
    return rows(t ? [t] : []);
  }
  return rows([]);
}

async function routeTenantQuery(schema, sql, params = []) {
  const q = String(sql).replace(/\s+/g, ' ').trim();
  if (q.includes('FROM bot_sessions')) {
    return rows([{ state: schema === TENANT_A.schema_name ? world.askingState : world.currentState }]);
  }
  if (q.includes('reminder_confirmations')) {
    return rows(world.askingHasReminder ? [{ '?column?': 1 }] : []);
  }
  return rows([]);
}

const mockDb = {
  pool: { connect: async () => { throw new Error('not used'); }, query: routeQuery, on() {}, totalCount: 0, options: { max: 20 } },
  query: (sql, params) => routeQuery(sql, params),
  tenantQuery: (schema, sql, params) => routeTenantQuery(schema, sql, params),
  tenantTransaction: async () => { throw new Error('not used'); },
};
const dbPath = path.resolve(__dirname, '../src/db/index.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const { resolveAskingTenant } = require('../src/routes/webhook');
const PHONE = '919333333333';

function scenario(overrides) {
  Object.assign(world, {
    pendingTenantId: 'tenant-a', currentState: 'idle', askingState: 'idle', askingHasReminder: true,
  }, overrides);
}

async function run() {
  let pass = 0, fail = 0;
  async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  }

  console.log('\nresolveAskingTenant — answers go back to whoever asked, but only when they can be heard\n');

  await test('a "yes" from an idle session is redirected to the clinic that asked', async () => {
    scenario({});
    const r = await resolveAskingTenant(PHONE, 'yes', TENANT_B);
    assert.strictEqual(r?.id, 'tenant-a');
  });

  await test('a rating from an idle session is redirected', async () => {
    scenario({ askingState: 'collect_feedback_rating' });
    const r = await resolveAskingTenant(PHONE, '4', TENANT_B);
    assert.strictEqual(r?.id, 'tenant-a');
  });

  await test('HIGH: a number typed at the selected clinic\'s MAIN MENU is never redirected', async () => {
    for (const digit of ['1', '2', '3', '4', '5']) {
      scenario({ currentState: 'main_menu', askingState: 'collect_feedback_rating' });
      const r = await resolveAskingTenant(PHONE, digit, TENANT_B);
      assert.strictEqual(r, null, `"${digit}" at main_menu was hijacked as a star rating`);
    }
  });

  await test('a "yes" at main_menu still redirects (not a menu option)', async () => {
    scenario({ currentState: 'main_menu' });
    const r = await resolveAskingTenant(PHONE, 'yes', TENANT_B);
    assert.strictEqual(r?.id, 'tenant-a');
  });

  await test('mid-conversation with the selected clinic, nothing is redirected', async () => {
    scenario({ currentState: 'select_slot' });
    assert.strictEqual(await resolveAskingTenant(PHONE, 'yes', TENANT_B), null);
    scenario({ currentState: 'select_slot', askingState: 'collect_feedback_rating' });
    assert.strictEqual(await resolveAskingTenant(PHONE, '4', TENANT_B), null);
  });

  await test('HIGH: a confirmation is NOT redirected into an asking clinic that is mid-flow', async () => {
    // Clinic A has an abandoned booking sitting at select_date. The reminder
    // intercept would refuse this message and drop it into A's state machine,
    // where handleSelectDate reads "yes" as an unusable answer.
    scenario({ askingState: 'select_date' });
    assert.strictEqual(await resolveAskingTenant(PHONE, 'yes', TENANT_B), null);
  });

  await test('a confirmation is still not redirected when no reminder is outstanding', async () => {
    scenario({ askingHasReminder: false });
    assert.strictEqual(await resolveAskingTenant(PHONE, 'yes', TENANT_B), null);
  });

  await test('a rating is not redirected unless the asker is on the rating step', async () => {
    scenario({ askingState: 'idle' });
    assert.strictEqual(await resolveAskingTenant(PHONE, '4', TENANT_B), null);
  });

  await test('nothing pending, or the asker IS the selected clinic → no redirect', async () => {
    scenario({ pendingTenantId: null });
    assert.strictEqual(await resolveAskingTenant(PHONE, 'yes', TENANT_B), null);
    scenario({ pendingTenantId: 'tenant-b' });
    assert.strictEqual(await resolveAskingTenant(PHONE, 'yes', TENANT_B), null);
  });

  await test('ordinary bot input is never classified as an answer', async () => {
    scenario({});
    for (const text of ['book', 'Smile Dental', '6', 'MB12AB3', '']) {
      assert.strictEqual(await resolveAskingTenant(PHONE, text, TENANT_B), null, `"${text}" was redirected`);
    }
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
