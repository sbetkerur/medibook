'use strict';
/**
 * WhatsApp one-time codes (services/otp.js) — the only verification channel this
 * product has, used for self-serve signup and WhatsApp password reset.
 *
 * What matters:
 *   - a live code can't be brute-forced (attempts are counted, then the row dies)
 *   - a resend supersedes the previous code
 *   - the per-phone cooldown and hourly cap actually bite
 *   - a correct code is single-use and returns the parked payload
 *   - delivery failure never throws (the row is written; the client can resend)
 *
 * Run: node tests/otp.unit.test.js   (no Postgres/Redis/Meta required)
 */
process.env.NODE_ENV = 'test';

const assert = require('assert');
const crypto = require('crypto');

// ── In-memory wa_otps behind a stubbed ../src/db ────────────
let rows = [];
let nowOffsetMs = 0;
const NOW = () => new Date(Date.now() + nowOffsetMs);

function handle(sql, params) {
  const s = sql.replace(/\s+/g, ' ').trim();

  // rate check: COUNT(*) FILTER (...) in_cooldown / sent_last_hour
  if (s.startsWith('SELECT COUNT(*) FILTER')) {
    const [phone, purpose, cooldownSecs] = params;
    const cutoffCooldown = NOW().getTime() - cooldownSecs * 1000;
    const cutoffHour = NOW().getTime() - 3600 * 1000;
    const mine = rows.filter(r => r.phone === phone && r.purpose === purpose);
    return { rows: [{
      in_cooldown: String(mine.filter(r => r.created_at.getTime() > cutoffCooldown).length),
      sent_last_hour: String(mine.filter(r => r.created_at.getTime() > cutoffHour).length),
    }] };
  }
  // supersede live codes
  if (s.startsWith('UPDATE wa_otps SET consumed_at = NOW() WHERE phone')) {
    const [phone, purpose] = params;
    rows.forEach(r => {
      if (r.phone === phone && r.purpose === purpose && !r.consumed_at && r.expires_at.getTime() > NOW().getTime()) {
        r.consumed_at = NOW();
      }
    });
    return { rows: [] };
  }
  // insert
  if (s.startsWith('INSERT INTO wa_otps')) {
    const [phone, purpose, code_hash, payload, max_attempts, expires_at] = params;
    rows.push({
      id: crypto.randomUUID(), phone, purpose, code_hash,
      payload: typeof payload === 'string' ? JSON.parse(payload) : payload,
      attempts: 0, max_attempts, consumed_at: null,
      expires_at: new Date(expires_at), created_at: NOW(),
    });
    return { rows: [] };
  }
  // verify: newest live row
  if (s.startsWith('SELECT * FROM wa_otps WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > NOW()')) {
    const [phone, purpose] = params;
    const live = rows
      .filter(r => r.phone === phone && r.purpose === purpose && !r.consumed_at && r.expires_at.getTime() > NOW().getTime())
      .sort((a, b) => b.created_at - a.created_at);
    return { rows: live.slice(0, 1) };
  }
  if (s.startsWith('UPDATE wa_otps SET consumed_at = NOW() WHERE id = $1')) {
    const r = rows.find(x => x.id === params[0]); if (r) r.consumed_at = NOW();
    return { rows: [] };
  }
  if (s.startsWith('UPDATE wa_otps SET attempts = attempts + 1 WHERE id = $1')) {
    const r = rows.find(x => x.id === params[0]); if (r) r.attempts += 1;
    return { rows: [] };
  }
  if (s.startsWith('DELETE FROM wa_otps')) { rows = []; return { rows: [] }; }
  throw new Error('unexpected SQL in stub: ' + s.slice(0, 80));
}

const dbPath = require.resolve('../src/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: async (sql, params) => handle(sql, params), tenantQuery: async () => ({ rows: [] }) },
};

// ── Stub the WhatsApp sender ────────────────────────────────
let sendShouldThrow = false;
let lastSentCode = null;
const waPath = require.resolve('../src/services/whatsapp');
require.cache[waPath] = {
  id: waPath, filename: waPath, loaded: true,
  exports: {
    sendText: async (_to, text) => { if (sendShouldThrow) throw new Error('meta down'); lastSentCode = (text.match(/\b(\d{6})\b/) || [])[1]; return 'wamid.x'; },
    sendTemplate: async (_to, _tpl, comps) => { if (sendShouldThrow) throw new Error('meta down'); lastSentCode = comps?.[0]?.parameters?.[0]?.text || null; return 'wamid.x'; },
  },
};

const otp = require('../src/services/otp');

let pass = 0, fail = 0;
async function test(name, fn) {
  rows = []; nowOffsetMs = 0; sendShouldThrow = false; lastSentCode = null;
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
}

(async () => {
  console.log('OTP unit tests\n');

  await test('issueOtp sends a 6-digit code and reports ok', async () => {
    const r = await otp.issueOtp('919000000001', 'signup', { slug: 'x' });
    assert.strictEqual(r.ok, true);
    assert.ok(/^\d{6}$/.test(lastSentCode), 'a 6-digit code was delivered');
  });

  await test('the correct code verifies once and returns the payload', async () => {
    await otp.issueOtp('919000000002', 'signup', { slug: 'acme', owner_email: 'a@b.com' });
    const ok = await otp.verifyOtp('919000000002', 'signup', lastSentCode);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.payload.slug, 'acme');
    // single-use
    const again = await otp.verifyOtp('919000000002', 'signup', lastSentCode);
    assert.strictEqual(again.ok, false);
  });

  await test('a wrong code is rejected and counts against the attempt budget', async () => {
    await otp.issueOtp('919000000003', 'signup', {});
    for (let i = 0; i < otp.MAX_ATTEMPTS; i++) {
      const bad = await otp.verifyOtp('919000000003', 'signup', '000000' === lastSentCode ? '111111' : '000000');
      assert.strictEqual(bad.ok, false);
    }
    // budget exhausted — even the RIGHT code no longer works
    const right = await otp.verifyOtp('919000000003', 'signup', lastSentCode);
    assert.strictEqual(right.ok, false);
  });

  await test('a resend supersedes the previous code', async () => {
    await otp.issueOtp('919000000004', 'signup', {});
    const first = lastSentCode;
    nowOffsetMs = (otp.RESEND_COOLDOWN_SECONDS + 1) * 1000; // past the cooldown
    await otp.issueOtp('919000000004', 'signup', {});
    const second = lastSentCode;
    assert.notStrictEqual(first, second);
    assert.strictEqual((await otp.verifyOtp('919000000004', 'signup', first)).ok, false, 'old code dead');
    assert.strictEqual((await otp.verifyOtp('919000000004', 'signup', second)).ok, true, 'new code works');
  });

  await test('the resend cooldown bites', async () => {
    await otp.issueOtp('919000000005', 'signup', {});
    const r = await otp.issueOtp('919000000005', 'signup', {});
    assert.strictEqual(r.ok, false);
    assert.ok(r.retryAfter > 0);
  });

  await test('the hourly cap bites after 4 live codes', async () => {
    for (let i = 0; i < 4; i++) {
      nowOffsetMs = i * (otp.RESEND_COOLDOWN_SECONDS + 1) * 1000;
      const r = await otp.issueOtp('919000000006', 'signup', {});
      assert.strictEqual(r.ok, true, `code ${i + 1}`);
    }
    nowOffsetMs = 5 * (otp.RESEND_COOLDOWN_SECONDS + 1) * 1000;
    const capped = await otp.issueOtp('919000000006', 'signup', {});
    assert.strictEqual(capped.ok, false);
  });

  await test('an expired code cannot be verified', async () => {
    await otp.issueOtp('919000000007', 'signup', {});
    const code = lastSentCode;
    nowOffsetMs = (otp.CODE_TTL_MINUTES + 1) * 60 * 1000;
    const r = await otp.verifyOtp('919000000007', 'signup', code);
    assert.strictEqual(r.ok, false);
  });

  await test('a delivery failure does not throw — the row still exists to retry', async () => {
    sendShouldThrow = true;
    const r = await otp.issueOtp('919000000008', 'signup', {});
    assert.strictEqual(r.ok, true, 'issue still succeeds; client can resend');
  });

  await test('verifyOtp rejects a non-6-digit code without touching the store', async () => {
    const r = await otp.verifyOtp('919000000009', 'signup', 'abcd');
    assert.strictEqual(r.ok, false);
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
