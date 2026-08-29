'use strict';
/**
 * DB-free unit tests for services/billing.js — the money maths behind the
 * self-serve module. Nothing here touches Postgres or Razorpay.
 *
 *  1. GST split is INCLUSIVE (the plan price already contains the tax) and the
 *     parts must always re-sum to the exact charged total — an off-by-a-paisa
 *     invoice is one an accountant bounces.
 *  2. Intra-state → CGST + SGST at half-rate each; inter-state → IGST at the
 *     full rate. The seller state code decides which.
 *  3. Financial year is the Indian Apr–Mar year, and the invoice number is
 *     `<PREFIX>/<FY>/<zero-padded seq>`.
 *
 * Run: node tests/billing.unit.test.js
 */
process.env.NODE_ENV = 'test';
process.env.SELLER_STATE_CODE = '29';       // Karnataka
process.env.SELLER_GSTIN = '29ABCDE1234F1Z5';
process.env.INVOICE_NUMBER_PREFIX = 'MB';

const assert = require('assert');
const billing = require('../src/services/billing');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); failed++; }
}

console.log('\nBilling maths (services/billing.js)\n');

// ── GST split ────────────────────────────────────────────────
test('inclusive split of ₹799 (79900 paise) intra-state re-sums exactly', () => {
  const s = billing.splitGst(79900, '29');
  assert.strictEqual(s.taxable_paise + s.cgst_paise + s.sgst_paise + s.igst_paise, 79900);
  assert.strictEqual(s.igst_paise, 0);
  assert.ok(s.cgst_paise === s.sgst_paise || Math.abs(s.cgst_paise - s.sgst_paise) === 1,
    'CGST and SGST are equal (±1 paise of rounding)');
  // 79900 / 1.18 = 67711.86 → floor 67711 taxable, 12189 tax
  assert.strictEqual(s.taxable_paise, 67711);
});

test('inter-state charge produces IGST only, no CGST/SGST', () => {
  const s = billing.splitGst(179900, '27'); // buyer in Maharashtra
  assert.strictEqual(s.cgst_paise, 0);
  assert.strictEqual(s.sgst_paise, 0);
  assert.strictEqual(s.taxable_paise + s.igst_paise, 179900);
  assert.strictEqual(s.inter_state, true);
});

test('buyer in the seller state is intra-state even when place_of_supply given', () => {
  const s = billing.splitGst(179900, '29');
  assert.strictEqual(s.igst_paise, 0);
  assert.ok(s.cgst_paise > 0 && s.sgst_paise > 0);
});

test('null place_of_supply defaults to intra-state (conservative)', () => {
  const s = billing.splitGst(79900, null);
  assert.strictEqual(s.igst_paise, 0);
});

test('a zero / negative total never produces negative components', () => {
  const s = billing.splitGst(0, '29');
  assert.strictEqual(s.taxable_paise, 0);
  assert.strictEqual(s.cgst_paise + s.sgst_paise + s.igst_paise, 0);
  const n = billing.splitGst(-500, '29');
  assert.strictEqual(n.taxable_paise, 0);
});

test('taxable value is never more than the total', () => {
  for (const amt of [1, 99, 100, 79900, 179900, 460000, 12345678]) {
    const s = billing.splitGst(amt, '29');
    assert.ok(s.taxable_paise <= amt, `taxable ${s.taxable_paise} <= ${amt}`);
    assert.strictEqual(s.taxable_paise + s.cgst_paise + s.sgst_paise + s.igst_paise, amt);
  }
});

// ── Financial year ───────────────────────────────────────────
test('financialYear: April 2025 → 2025-26', () => {
  assert.strictEqual(billing.financialYear(new Date('2025-04-01T00:00:00Z')), '2025-26');
});
test('financialYear: mid-March 2025 IST → 2024-25 (still the prior FY)', () => {
  assert.strictEqual(billing.financialYear(new Date('2025-03-15T06:00:00Z')), '2024-25');
});
test('financialYear: computed in IST, not UTC — 31 Mar 20:00 UTC is 1 Apr IST → new FY', () => {
  // 2026-03-31 20:00 UTC = 2026-04-01 01:30 IST → FY 2026-27
  assert.strictEqual(billing.financialYear(new Date('2026-03-31T20:00:00Z')), '2026-27');
});
test('financialYear: 31 Mar 17:00 UTC is still 31 Mar IST (22:30) → old FY', () => {
  assert.strictEqual(billing.financialYear(new Date('2026-03-31T17:00:00Z')), '2025-26');
});
test('financialYear: Jan 2026 → 2025-26', () => {
  assert.strictEqual(billing.financialYear(new Date('2026-01-15T00:00:00Z')), '2025-26');
});
test('financialYear rolls the century: Dec 2099 → 2099-00', () => {
  assert.strictEqual(billing.financialYear(new Date('2099-12-01T00:00:00Z')), '2099-00');
});

// ── Invoice number ──────────────────────────────────────────
test('nextInvoiceNumber formats as PREFIX/FY/000042', async () => {
  let seq = 41;
  const fakeClient = { query: async () => ({ rows: [{ n: ++seq }] }) };
  const num = await billing.nextInvoiceNumber(fakeClient, new Date('2025-06-01T00:00:00Z'));
  assert.strictEqual(num, 'MB/2025-26/000042');
});

test('nextInvoiceNumber zero-pads to at least 6 digits and grows past it', async () => {
  const fakeClient = { query: async () => ({ rows: [{ n: 1234567 }] }) };
  const num = await billing.nextInvoiceNumber(fakeClient, new Date('2025-06-01T00:00:00Z'));
  assert.strictEqual(num, 'MB/2025-26/1234567');
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
