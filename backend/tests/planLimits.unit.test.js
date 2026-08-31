'use strict';
/**
 * DB-free unit test for utils/planLimits.js — the ONE place that resolves a
 * tenant's effective dentist / branch ceiling from a negotiated
 * tenants.max_*_override on top of the tier's plans.max_*.
 *
 * Run: node tests/planLimits.unit.test.js
 */

const assert = require('assert');
const { effectiveDoctorLimit, effectiveBranchLimit } = require('../src/utils/planLimits');

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); fail++; }
};

console.log('planLimits resolver unit tests\n');

// ── doctors ──────────────────────────────────────────────────
test('no override → the plan limit (Starter 2)', () => {
  assert.strictEqual(effectiveDoctorLimit({ max_doctors_override: null }, { max_doctors: 2 }), 2);
});

test('override wins over a lower plan limit (Starter + negotiated 4)', () => {
  assert.strictEqual(effectiveDoctorLimit({ max_doctors_override: 4 }, { max_doctors: 2 }), 4);
});

test('override caps an unlimited plan (Professional + negotiated 4)', () => {
  assert.strictEqual(effectiveDoctorLimit({ max_doctors_override: 4 }, { max_doctors: null }), 4);
});

test('override of 0 is honoured literally (frozen pilot)', () => {
  assert.strictEqual(effectiveDoctorLimit({ max_doctors_override: 0 }, { max_doctors: 2 }), 0);
});

test('no override + unlimited plan → null (no limit)', () => {
  assert.strictEqual(effectiveDoctorLimit({ max_doctors_override: null }, { max_doctors: null }), null);
});

test('undefined override key behaves like null', () => {
  assert.strictEqual(effectiveDoctorLimit({}, { max_doctors: 2 }), 2);
});

test('missing plan row (pricing not seeded) → null', () => {
  assert.strictEqual(effectiveDoctorLimit({ max_doctors_override: null }, null), null);
});

test('missing plan row but an override set → the override', () => {
  assert.strictEqual(effectiveDoctorLimit({ max_doctors_override: 3 }, null), 3);
});

test('null tenant → plan limit', () => {
  assert.strictEqual(effectiveDoctorLimit(null, { max_doctors: 2 }), 2);
});

// ── branches ─────────────────────────────────────────────────
test('branch: no override → plan limit (Starter 1)', () => {
  assert.strictEqual(effectiveBranchLimit({ max_branches_override: null }, { max_branches: 1 }), 1);
});

test('branch: negotiated 2 on a single-branch tier', () => {
  assert.strictEqual(effectiveBranchLimit({ max_branches_override: 2 }, { max_branches: 1 }), 2);
});

test('branch: unlimited plan, no override → null', () => {
  assert.strictEqual(effectiveBranchLimit({ max_branches_override: null }, { max_branches: null }), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
