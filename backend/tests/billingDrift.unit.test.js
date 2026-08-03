'use strict';
/**
 * Per-branch billing drift — the rule that decides whether a clinic is being
 * under-billed.
 *
 * Professional lists at ₹1,799 for the FIRST branch; every additional branch is
 * billed at ₹1,799 less a discount agreed per deal, applied per added branch:
 *
 *     monthly = 1799 + (branches - 1) × 1799 × (1 - discount)
 *
 * The discount is not stored anywhere, so the exact figure can never be
 * recomputed — only bounded. At worst there is no discount at all
 * (price × branches); at best every extra branch is free (price). Those bounds
 * are the whole test surface:
 *
 *  1. Adding a branch and forgetting the override is the money-losing case, and
 *     it must be caught with certainty — not merely "looks odd".
 *  2. A ONE-branch tenant must never be flagged for having no override. Its
 *     list price is already exact, and a false alarm on every single-location
 *     clinic (which is most of them) would train the operator to ignore the
 *     warning entirely.
 *  3. Anything the bounds cannot judge — no price, no branch count — returns
 *     null rather than guessing. Guessing here means dunning a real customer.
 *
 * Run: node tests/billingDrift.unit.test.js
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { billingDriftFlag } = require('../src/routes/superadmin');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  if (actual === expected) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}\n     expected: ${expected}\n     actual:   ${actual}`); failed++; }
}

const PRICE = 1799;
const flag = (branches, billingMonthly) =>
  billingDriftFlag({ listPrice: PRICE, billingMonthly, branches });

console.log('\nBilling drift — per-branch pricing\n');

// ── The case this whole feature exists for ───────────────────
check('2 branches with no agreed amount is caught',
  flag(2, null), 'missing_override');
check('5 branches with no agreed amount is caught',
  flag(5, null), 'missing_override');

// ── Single branch: list price is already exact ───────────────
check('1 branch with no override is fine (not every clinic is multi-branch)',
  flag(1, null), null);
check('1 branch billed exactly list price is fine',
  flag(1, PRICE), null);

// ── Inside the bounds for the branch count ───────────────────
check('3 branches at full list price (no discount) is the upper bound, allowed',
  flag(3, PRICE * 3), null);
check('3 branches at 20% off extras sits inside the range',
  flag(3, Math.round(PRICE + 2 * PRICE * 0.8)), null); // 4677
check('3 branches with extras given away free is the lower bound, allowed',
  flag(3, PRICE), null);

// ── Outside the bounds ───────────────────────────────────────
check('amount agreed for 2 branches goes stale when a 3rd is added',
  // ₹3,238 was inside the range at 2 branches; at 3 it is still ≥ price and
  // ≤ price × 3, so bounds alone cannot catch this one — documented below.
  flag(3, 3238), null);
check('below a single branch price is flagged (under-billing)',
  flag(3, PRICE - 1), 'outside_expected_range');
check('above no-discount list for the branch count is flagged (over-billing)',
  flag(3, PRICE * 3 + 1), 'outside_expected_range');
check('branches removed leaves an over-billed clinic flagged',
  flag(1, PRICE * 3), 'outside_expected_range');

// ── Refuses to guess ─────────────────────────────────────────
check('no list price (plan row missing) returns null rather than guessing',
  billingDriftFlag({ listPrice: null, billingMonthly: null, branches: 4 }), null);
check('unknown branch count (schema unreadable) returns null',
  billingDriftFlag({ listPrice: PRICE, billingMonthly: null, branches: null }), null);
check('zero branches returns null — nothing to bill for yet',
  flag(0, null), null);

// ── A deliberate ₹0 pilot is a deviation worth surfacing ─────
check('free pilot on one branch is flagged as outside range',
  flag(1, 0), 'outside_expected_range');

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
