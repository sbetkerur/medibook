'use strict';
/**
 * The per-patient discretionary message budget.
 *
 * Every clinic shares ONE WhatsApp number, so one clinic over-messaging degrades
 * delivery for all of them. This is the only thing that looks at a patient as a
 * whole rather than per-cron, and the setting a platform operator reaches for
 * when Meta drops the number's quality rating is `message_budget_max`.
 *
 * The bug pinned here: `max` was accepted only when `> 0`, so the ONE value that
 * means "stop this clinic's outreach entirely" — zero — was thrown away and
 * silently replaced by the default allowance of 6.
 *
 * Run: node tests/messageBudget.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');

// Stub the db before messageBudget loads. `sent` is what wa_messages would
// return for the patient in the window.
let sent = 0;
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { tenantQuery: async () => ({ rows: [{ n: sent }], rowCount: 1 }) },
};

const { canSendDiscretionary, budgetFor, DEFAULT_MAX } = require('../src/services/messageBudget');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
}

(async () => {
  console.log('Message budget unit tests\n');

  await test('under the default allowance, a discretionary send is permitted', async () => {
    sent = 2;
    assert.strictEqual(await canSendDiscretionary('tenant_x', '91999', {}), true);
  });

  await test('at the default allowance it is suppressed', async () => {
    sent = DEFAULT_MAX;
    assert.strictEqual(await canSendDiscretionary('tenant_x', '91999', {}), false);
  });

  // ── The regression this file exists for ────────────────────────
  await test('max:0 means NOTHING discretionary, not "use the default"', async () => {
    sent = 0; // the patient has had no messages at all this week
    assert.strictEqual(await canSendDiscretionary('tenant_x', '91999', { max: 0, windowDays: 7 }), false,
      'zero was replaced by the default allowance — the halt switch did nothing');
  });

  await test('a clinic-set ceiling below the default is honoured', async () => {
    sent = 2;
    assert.strictEqual(await canSendDiscretionary('tenant_x', '91999', { max: 2 }), false);
    assert.strictEqual(await canSendDiscretionary('tenant_x', '91999', { max: 3 }), true);
  });

  await test('a nonsense ceiling falls back to the default rather than blocking everything', async () => {
    sent = 0;
    for (const bad of [null, undefined, -1, 'six', 1.5, NaN]) {
      assert.strictEqual(await canSendDiscretionary('tenant_x', '91999', { max: bad }), true,
        `max=${String(bad)} should fall back to the default, not suppress`);
    }
  });

  await test('budgetFor passes a clinic 0 through instead of defaulting it', async () => {
    assert.strictEqual(budgetFor({ settings: { message_budget_max: 0 } }).max, 0);
    assert.strictEqual(budgetFor({ settings: {} }).max, DEFAULT_MAX);
    assert.strictEqual(budgetFor(null).max, DEFAULT_MAX);
  });

  await test('it fails OPEN when the count cannot be read', async () => {
    const stub = require.cache[dbPath].exports.tenantQuery;
    require.cache[dbPath].exports.tenantQuery = async () => { throw new Error('db down'); };
    try {
      assert.strictEqual(await canSendDiscretionary('tenant_x', '91999', {}), true,
        'a budget check that cannot run must not silence the clinic');
    } finally { require.cache[dbPath].exports.tenantQuery = stub; }
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
