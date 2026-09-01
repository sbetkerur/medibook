'use strict';
/**
 * Opt-out / re-subscribe keyword recognition.
 *
 * The bot used to only recognise a BARE, exactly-matching token
 * (/^(stop|unsubscribe|opt.?out|block)$/i). "Stop." with a full stop, or
 * "stop please", fell straight through to normal handling — a patient telling
 * their dentist to stop was answered with the main menu. It now normalises a
 * leading/trailing "please" and trailing `. ! ,` before matching, while a real
 * sentence ("stop sending me to the wrong dentist") is still handled normally.
 *
 * Run: node tests/optOutKeywords.unit.test.js   (no Postgres/Redis required)
 */
process.env.NODE_ENV = 'test';
process.env.DISABLE_QUEUE = 'true';
process.env.JWT_SECRET = 'unit-test-secret-at-least-32-chars-long!!';

const path = require('path');
const assert = require('assert');

// ── minimal in-memory tenant db ──────────────────────────────
const state = { optedOut: false, queries: [] };
function rows(r) { return { rows: r, rowCount: r.length }; }

function routeQuery(sql, params = []) {
  const q = String(sql).replace(/\s+/g, ' ').trim();
  state.queries.push(q);
  if (q.startsWith('INSERT INTO bot_sessions')) return rows([]);
  if (q.startsWith('SELECT * FROM bot_sessions')) {
    return rows([{ phone: params[0], state: 'idle', context: {}, last_activity: new Date() }]);
  }
  if (q.startsWith('UPDATE bot_sessions')) return rows([]);
  if (/UPDATE patients SET opted_out=true/i.test(q)) { state.optedOut = true; return rows([]); }
  if (/UPDATE patients SET opted_out=false/i.test(q)) { state.optedOut = false; return rows([]); }
  if (/SELECT opted_out/i.test(q)) return rows([{ opted_out: state.optedOut }]);
  if (/FROM patients WHERE phone/i.test(q)) return rows([]);
  if (/FROM users WHERE role/i.test(q)) return rows([]);
  return rows([]);
}

const mockDb = {
  pool: { connect: async () => ({ query: async () => rows([]), release() {} }), query: async (...a) => routeQuery(...a), on() {}, totalCount: 0, options: { max: 20 } },
  query: async (sql, params) => routeQuery(sql, params),
  tenantQuery: async (_s, sql, params) => routeQuery(sql, params),
  tenantTransaction: async (_s, cb) => cb({ query: async () => rows([]) }),
  validateSchemaName: () => {},
};
const dbPath = path.resolve(__dirname, '../src/db/index.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const wa = require('../src/services/whatsapp');
const sent = [];
wa.sendText = async (_to, text) => { sent.push(text); };
wa.sendButtons = async (_to, text) => { sent.push(text); };
wa.sendList = async (_to, text) => { sent.push(text); };

const botEngine = require('../src/services/botEngine');
const tenant = { id: 't-1', slug: 'demo', name: 'Demo Clinic', schema_name: 'tenant_demo', plan: 'starter', settings: {} };
const PHONE = '919000000001';

async function feed(text) {
  sent.length = 0; state.queries.length = 0;
  await botEngine.handle({ phone: PHONE, text, buttonId: null, tenant });
  return { replies: sent.join(' | '), optOutWritten: state.queries.some(q => /UPDATE patients SET opted_out=true/i.test(q)) };
}

(async () => {
  let pass = 0, fail = 0;
  const test = async (name, fn) => {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.log(`  ❌ ${name}: ${e.message}`); fail++; }
  };

  console.log('\nOpt-out / re-subscribe keyword tests\n');

  for (const kw of ['stop', 'Stop.', 'STOP!', 'stop please', 'please stop', 'unsubscribe', 'opt out', 'opt-out', 'block', '  stop  ']) {
    await test(`"${kw}" opts the patient out`, async () => {
      state.optedOut = false;
      const { optOutWritten, replies } = await feed(kw);
      assert(optOutWritten, `no opt-out write for "${kw}" — replies: ${replies}`);
    });
  }

  await test('"stop sending me to the wrong dentist" is NOT an opt-out', async () => {
    state.optedOut = false;
    const { optOutWritten } = await feed('stop sending me to the wrong dentist');
    assert(!optOutWritten, 'a full sentence containing "stop" wrongly opted the patient out');
  });

  await test('"start" / "Start." re-subscribes an opted-out patient', async () => {
    for (const kw of ['start', 'Start.', 'start please']) {
      state.optedOut = true;
      state.queries.length = 0;
      await botEngine.handle({ phone: PHONE, text: kw, buttonId: null, tenant });
      assert(state.queries.some(q => /UPDATE patients SET opted_out=false/i.test(q)),
        `"${kw}" did not re-subscribe`);
    }
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
