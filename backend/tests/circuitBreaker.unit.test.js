'use strict';
/**
 * The WhatsApp circuit breaker's HALF_OPEN gate.
 *
 * One number is shared by every clinic, so when Meta starts failing the breaker
 * is what stops the platform hammering it. Its recovery rule is "after the reset
 * window, let exactly ONE call through and see what happens" — and that rule was
 * unreachable for a long time: the HALF_OPEN test was nested inside
 * `if (state === 'OPEN')`, where `state !== 'HALF_OPEN'` is always true, so the
 * `return cb.probing` line could never run. Worse, once the first caller flipped
 * the state to HALF_OPEN, every later caller failed the `=== 'OPEN'` test
 * entirely and fell through to "allowed". With the hourly crons running tenants
 * five at a time, "test one call" meant five or more.
 *
 * Run: node tests/circuitBreaker.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const wa = require('../src/services/whatsapp');

const PHONE_ID = 'test-phone-id';
const THRESHOLD = 8; // CB_FAILURE_THRESHOLD

let pass = 0, fail = 0;
function test(name, fn) {
  try { wa.resetCircuit(PHONE_ID); fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
}

/** Drive the breaker to OPEN the way a real Meta outage would. */
function openTheCircuit() {
  for (let i = 0; i < THRESHOLD; i++) wa.recordFailure(PHONE_ID);
}

console.log('WhatsApp circuit breaker unit tests\n');

test('a healthy circuit allows calls', () => {
  assert.strictEqual(wa.isCircuitOpen(PHONE_ID), false);
});

test('it stays closed below the failure threshold', () => {
  for (let i = 0; i < THRESHOLD - 1; i++) wa.recordFailure(PHONE_ID);
  assert.strictEqual(wa.isCircuitOpen(PHONE_ID), false,
    'the breaker opened early — transient blips must not trip it');
});

test('it opens once the threshold is reached, and blocks', () => {
  openTheCircuit();
  assert.strictEqual(wa.isCircuitOpen(PHONE_ID), true);
  assert.strictEqual(wa.isCircuitOpen(PHONE_ID), true, 'still open on a second ask');
});

test('a success closes it again and clears the failure count', () => {
  openTheCircuit();
  wa.recordSuccess(PHONE_ID);
  assert.strictEqual(wa.isCircuitOpen(PHONE_ID), false);
});

// ── The regression this file exists for ──────────────────────────
test('after the reset window, exactly ONE caller is let through', () => {
  openTheCircuit();
  // Fast-forward rather than sleeping 30s. The reset test is
  // `Date.now() - openedAt > CB_RESET_MS`, so moving the clock is equivalent and
  // keeps the suite instant — which is what stops people learning to ignore it.
  const probe = (() => {
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;
    try {
      return {
        first:  wa.isCircuitOpen(PHONE_ID), // flips to HALF_OPEN, allowed
        second: wa.isCircuitOpen(PHONE_ID), // must be BLOCKED
        third:  wa.isCircuitOpen(PHONE_ID), // must be BLOCKED
      };
    } finally { Date.now = realNow; }
  })();

  assert.strictEqual(probe.first, false, 'the probe call itself must be allowed through');
  assert.strictEqual(probe.second, true,
    'the SECOND caller was allowed through — this is the thundering herd the gate exists to stop');
  assert.strictEqual(probe.third, true, 'the third caller was allowed through too');
});

test('a failed probe re-opens the circuit rather than leaving it half-open', () => {
  openTheCircuit();
  const realNow = Date.now;
  Date.now = () => realNow() + 31_000;
  try {
    assert.strictEqual(wa.isCircuitOpen(PHONE_ID), false, 'probe should be allowed');
  } finally { Date.now = realNow; }
  wa.recordFailure(PHONE_ID);        // the probe failed
  assert.strictEqual(wa.isCircuitOpen(PHONE_ID), true, 'a failed probe must close the door again');
});

test('a successful probe reopens the circuit for everyone', () => {
  openTheCircuit();
  const realNow = Date.now;
  Date.now = () => realNow() + 31_000;
  try { wa.isCircuitOpen(PHONE_ID); } finally { Date.now = realNow; }
  wa.recordSuccess(PHONE_ID);        // the probe worked
  assert.strictEqual(wa.isCircuitOpen(PHONE_ID), false);
  assert.strictEqual(wa.isCircuitOpen(PHONE_ID), false, 'and stays open for the next caller');
});

test('a probe that never reports does not wedge the breaker shut forever', () => {
  openTheCircuit();
  const realNow = Date.now;
  // Take the probe, then never call recordSuccess/recordFailure.
  Date.now = () => realNow() + 31_000;
  try {
    assert.strictEqual(wa.isCircuitOpen(PHONE_ID), false, 'probe allowed');
    assert.strictEqual(wa.isCircuitOpen(PHONE_ID), true, 'others blocked while it is in flight');
  } finally { Date.now = realNow; }
  // Well past CB_PROBE_TIMEOUT_MS with still no outcome recorded.
  Date.now = () => realNow() + 200_000;
  try {
    assert.strictEqual(wa.isCircuitOpen(PHONE_ID), false,
      'an abandoned probe must eventually allow a fresh one, or the number goes dark permanently');
  } finally { Date.now = realNow; }
});

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
