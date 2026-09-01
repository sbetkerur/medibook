'use strict';
/**
 * The no-Redis fallback for IP-abuse escalation.
 *
 * `localIncr` (the per-minute request counter) clears its WHOLE map on every
 * minute rollover — every key embeds the window, so that is correct for it. The
 * IP-abuse counter must NOT ride that wipe: escalation needs ~10 rate-limit
 * exceedances inside a rolling 5-minute window, and a slow abuser only racks up
 * two or three per minute, so the whole-map clear reset them to ~0 every minute
 * and `recordIPAbuse` never fired without Redis. `localAbuseIncr` keeps its own
 * map with a real per-key expiry.
 *
 * Run: node tests/rateLimitAbuse.unit.test.js   (no Postgres/Redis required)
 */
process.env.NODE_ENV = 'test';

const assert = require('assert');
const mw = require('../src/middleware/tenantRateLimit');
const { _localAbuseIncr: incr, _resetLocalAbuse: reset } = mw;

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); fail++; }
}

console.log('\nIP-abuse fallback counter (no Redis)\n');

test('accumulates across many calls for one IP — reaches the block threshold', () => {
  reset();
  let n = 0;
  for (let i = 0; i < 10; i++) n = incr('ratelimit:abuse:1.2.3.4');
  assert.strictEqual(n, 10, `expected 10, got ${n}`);
  assert(n >= 10, 'never reaches the >=10 escalation threshold');
});

test('counts are per-IP, not shared', () => {
  reset();
  incr('ratelimit:abuse:1.1.1.1');
  incr('ratelimit:abuse:1.1.1.1');
  const other = incr('ratelimit:abuse:9.9.9.9');
  assert.strictEqual(other, 1, `a different IP started at ${other}, not 1`);
});

test('a key resets once its window has expired', () => {
  reset();
  const KEY = 'ratelimit:abuse:5.5.5.5';
  // Reach into the private map via a fresh require to fake an expired entry.
  incr(KEY);
  incr(KEY);
  // Simulate 6 minutes passing by monkey-patching Date.now for one call.
  const realNow = Date.now;
  Date.now = () => realNow() + mw._ABUSE_WINDOW_MS + 1000;
  try {
    const n = incr(KEY);
    assert.strictEqual(n, 1, `an expired window did not reset (got ${n})`);
  } finally {
    Date.now = realNow;
  }
});

test('within the window, the count keeps climbing (does NOT reset per minute)', () => {
  reset();
  const KEY = 'ratelimit:abuse:7.7.7.7';
  const realNow = Date.now;
  let n = 0;
  try {
    for (let minute = 0; minute < 4; minute++) {
      Date.now = () => realNow() + minute * 60 * 1000; // advance one minute
      n = incr(KEY); n = incr(KEY); // ~2 exceedances/minute
    }
  } finally {
    Date.now = realNow;
  }
  assert.strictEqual(n, 8, `per-minute wipe leaked back in: got ${n}, expected 8`);
});

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
