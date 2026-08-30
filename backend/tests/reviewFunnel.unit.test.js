'use strict';
/**
 * DB-free unit test for the Google review funnel.
 *
 * A patient who rates a visit 4 or 5 — and only then, and only when the clinic
 * has set settings.google_review_url — is invited once to leave a public review
 * at the END of the rating flow (services/botEngine.js handleFeedbackComment).
 * Lower ratings are never asked and stay entirely internal.
 *
 * Mocks src/db before botEngine loads, stubs the WhatsApp sender, seeds a
 * session already parked at the feedback-comment step, and drives one reply.
 *
 * Run: node tests/reviewFunnel.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_QUEUE = 'true';
process.env.JWT_SECRET = 'unit-test-secret-at-least-32-chars-long!!';

const path = require('path');
const assert = require('assert');

const db = { sessions: new Map() };
function rows(r) { return { rows: r, rowCount: r.length }; }

async function routeQuery(sql, params = []) {
  const q = String(sql).replace(/\s+/g, ' ').trim();

  if (q.startsWith('INSERT INTO bot_sessions')) {
    const phone = params[0];
    if (q.includes('DO UPDATE')) {
      const s = db.sessions.get(phone) || { id: 's-' + phone, phone, context: {} };
      s.state = params[1];
      s.context = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
      db.sessions.set(phone, s);
    } else if (!db.sessions.has(phone)) {
      db.sessions.set(phone, { id: 's-' + phone, phone, state: 'idle', context: {} });
    }
    return rows([]);
  }
  if (q.startsWith('SELECT * FROM bot_sessions')) {
    const s = db.sessions.get(params[0]);
    return rows(s ? [{ ...s }] : []);
  }
  if (q.startsWith('UPDATE bot_sessions')) {
    const phone = params[params.length - 1];
    const s = db.sessions.get(phone) || { phone, context: {} };
    if (params.length >= 3) {
      s.state = params[0];
      s.context = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
    } else { s.state = 'idle'; s.context = {}; }
    db.sessions.set(phone, s);
    return rows([]);
  }

  // Not opted out; no prior feedback row; everything else empty.
  if (q.startsWith('SELECT opted_out')) return rows([]);
  if (q.includes('FROM patients WHERE phone')) return rows([]);
  if (q.includes('FROM appointment_feedback')) return rows([]);
  return rows([]);
}

const mockClient = {
  async query(sql, params) {
    const q = String(sql).trim().toUpperCase();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q) || q.startsWith('SET LOCAL') ||
        q.startsWith('SAVEPOINT') || q.startsWith('RELEASE') || q.startsWith('ROLLBACK TO')) {
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
  validateSchemaName: (s) => { if (!/^tenant_[a-z0-9_]+$/.test(s || '')) throw new Error(`Invalid schema: ${s}`); },
};

const dbPath = path.resolve(__dirname, '../src/db/index.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const wa = require('../src/services/whatsapp');
const sent = [];
wa.sendText = async (to, text) => { sent.push({ type: 'text', text }); };
wa.sendButtons = async (to, text, buttons, _t, _p, opts = {}) => {
  sent.push({ type: 'buttons', text, buttons, ...opts });
};
wa.sendList = async (to, text, label, sections, _t, _p, opts = {}) => {
  sent.push({ type: 'list', text, sections, ...opts });
};

const botEngine = require('../src/services/botEngine');

const REVIEW_URL = 'https://g.page/r/pragati-dental/review';
const PHONE = '919222222222';

function tenantWith(settings) {
  return { id: 'tenant-1', slug: 'demo', name: 'Demo Clinic', schema_name: 'tenant_demo', plan: 'starter', settings };
}

// Park the session at the comment step with a rating already chosen, exactly as
// handleFeedbackRating leaves it. Context is stored plain — botEngine accepts an
// unencrypted context (encrypting it on the next write).
function seedRatedSession(rating) {
  db.sessions.set(PHONE, {
    id: 's-' + PHONE, phone: PHONE, state: 'collect_feedback_comment',
    context: {
      feedback_rating: rating,
      feedback_appointment_id: 'appt-1',
      feedback_patient_id: 'pat-1',
      doctor_name: 'Meera Nair',
    },
  });
}

async function reply(text, tenant) {
  sent.length = 0;
  await botEngine.handle({ phone: PHONE, text, buttonId: null, tenant });
  return sent.slice();
}

async function run() {
  let pass = 0, fail = 0;
  const test = async (name, fn) => {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  };

  console.log('Google review funnel unit tests\n');

  await test('a 5-star rating with a review URL set gets the review invitation', async () => {
    seedRatedSession(5);
    const r = await reply('The team were lovely', tenantWith({ google_review_url: REVIEW_URL }));
    assert(r.some(m => m.type === 'text' && m.text.includes(REVIEW_URL)),
      'review link not sent: ' + JSON.stringify(r));
  });

  await test('a 4-star rating also gets it', async () => {
    seedRatedSession(4);
    const r = await reply('skip', tenantWith({ google_review_url: REVIEW_URL }));
    assert(r.some(m => m.type === 'text' && m.text.includes(REVIEW_URL)),
      'review link not sent for a 4-star rating (via Skip): ' + JSON.stringify(r));
  });

  await test('a 3-star rating is NEVER asked for a review', async () => {
    seedRatedSession(3);
    const r = await reply('It was okay', tenantWith({ google_review_url: REVIEW_URL }));
    assert(!r.some(m => (m.text || '').includes(REVIEW_URL)),
      'a low rating was funnelled to a public review: ' + JSON.stringify(r));
  });

  await test('a 5-star rating with NO review URL set sends no link', async () => {
    seedRatedSession(5);
    const r = await reply('Great', tenantWith({}));
    assert(!r.some(m => /https?:\/\//.test(m.text || '')),
      'a link was sent with no google_review_url configured: ' + JSON.stringify(r));
  });

  await test('the feedback thank-you is still sent regardless', async () => {
    seedRatedSession(3);
    const r = await reply('fine', tenantWith({ google_review_url: REVIEW_URL }));
    assert(r.some(m => /thank you/i.test(m.text || '')),
      'the closing thank-you message went missing: ' + JSON.stringify(r));
  });

  await test('a failing review-nudge send does not throw out of handle()', async () => {
    seedRatedSession(5);
    const original = wa.sendText;
    let calls = 0;
    wa.sendText = async (to, text) => {
      calls++;
      if (text && text.includes(REVIEW_URL)) throw new Error('simulated WhatsApp failure');
      sent.push({ type: 'text', text });
    };
    try {
      await botEngine.handle({ phone: PHONE, text: 'thanks', buttonId: null, tenant: tenantWith({ google_review_url: REVIEW_URL }) });
      assert(calls >= 2, 'expected the nudge send to have been attempted');
    } finally {
      wa.sendText = original;
    }
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
