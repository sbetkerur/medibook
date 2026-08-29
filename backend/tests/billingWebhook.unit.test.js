'use strict';
/**
 * DB-free integration test for the two spots that talk to Razorpay's actual
 * payload/request shapes — the parts that could only otherwise be validated by
 * pushing a real subscription through test mode:
 *
 *   1. services/razorpay.js updateSubscription() — the PATCH body sent for a
 *      plan swap / quantity change (plan_id, quantity, schedule_change_at,
 *      remaining_count).
 *   2. services/invoice.js recordInvoiceFromCharge() — reading a realistic
 *      `subscription.charged` event (payment.amount in paise, unix-second
 *      timestamps, subscription.current_start/end) and the INSERT it builds:
 *      GST split, invoice number, period, buyer fields, idempotency.
 *
 * Both `../db` and `axios` are stubbed in the require cache before the modules
 * under test load. No Postgres, no network.
 *
 * Run: node tests/billingWebhook.unit.test.js
 */
process.env.NODE_ENV = 'test';
process.env.SELLER_STATE_CODE = '29';
process.env.SELLER_GSTIN = '29ABCDE1234F1Z5';
process.env.INVOICE_NUMBER_PREFIX = 'MB';
process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
process.env.RAZORPAY_KEY_SECRET = 'secret_xyz';
process.env.RAZORPAY_PLAN_PROFESSIONAL = 'plan_pro_live';
process.env.RAZORPAY_PLAN_STARTER = 'plan_starter_live';

const assert = require('assert');
const path = require('path');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); failed++; }
}

// ── Stub axios (for razorpay.js) ─────────────────────────────
const axiosPath = require.resolve('axios');
let lastPatch = null;
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: {
    create: () => ({
      patch: async (url, body) => { lastPatch = { url, body }; return { data: { id: 'sub_1', status: 'active', plan_id: body.plan_id || 'plan_pro_live', quantity: body.quantity || 1 } }; },
      post: async () => ({ data: {} }), get: async () => ({ data: {} }),
    }),
  },
};

// ── Stub ../db (for invoice.js + billing.js) ─────────────────
const dbPath = require.resolve('../src/db');
const dbState = {
  existingInvoice: null,   // what the "SELECT * FROM billing_invoices WHERE razorpay_payment_id" check returns
  billingRow: null,        // the tenant_billing JOIN tenants row
  profileRow: null,        // tenant_billing_profiles row
  seq: 6,                  // billing_invoice_seq counter
  lastInsert: null,        // captured INSERT params
};
function fakeQuery(sql, params) {
  const s = String(sql);
  if (/nextval\('billing_invoice_seq'\)/.test(s)) { dbState.seq += 1; return Promise.resolve({ rows: [{ n: dbState.seq }] }); }
  if (/SELECT \* FROM billing_invoices WHERE razorpay_payment_id/.test(s)) {
    return Promise.resolve({ rows: dbState.existingInvoice ? [dbState.existingInvoice] : [] });
  }
  if (/FROM tenant_billing b JOIN tenants t/.test(s)) {
    return Promise.resolve({ rows: dbState.billingRow ? [dbState.billingRow] : [] });
  }
  if (/FROM tenant_billing_profiles/.test(s)) {
    return Promise.resolve({ rows: dbState.profileRow ? [dbState.profileRow] : [] });
  }
  if (/INSERT INTO billing_invoices/.test(s)) {
    dbState.lastInsert = params;
    // params is the 20-element array from invoice.js (SQL literals 'razorpay' /
    // 'INR' / 'paid' are NOT params). Order matches that array exactly.
    const [tenant_id, invoice_number, financial_year, razorpay_payment_id, razorpay_subscription_id,
      period_start, period_end, total_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise, gst_rate,
      place_of_supply, buyer_legal_name, buyer_gstin, plan_id, quantity, issued_at] = params;
    const row = { tenant_id, invoice_number, financial_year, razorpay_payment_id, razorpay_subscription_id,
      period_start, period_end, total_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise, gst_rate,
      place_of_supply, buyer_legal_name, buyer_gstin, plan_id, quantity, issued_at, status: 'paid' };
    dbState.existingInvoice = row; // a subsequent call now finds it (idempotency)
    return Promise.resolve({ rows: [row] });
  }
  return Promise.resolve({ rows: [] });
}
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: fakeQuery, tenantQuery: fakeQuery, pool: {}, validateSchemaName: () => true },
};

// Now safe to load the modules under test.
const razorpay = require('../src/services/razorpay');
const invoice = require('../src/services/invoice');
const billing = require('../src/services/billing');

// A realistic Razorpay `subscription.charged` event's inner entities.
function chargedEvent({ amount = 179900, created_at = 1751328000, sub = {} } = {}) {
  return {
    payment: { id: 'pay_' + amount + '_' + created_at, amount, currency: 'INR', created_at, subscription_id: 'sub_1', status: 'captured' },
    subscription: { id: 'sub_1', plan_id: 'plan_pro_live', quantity: 2, current_start: 1750723200, current_end: 1753315200, ...sub },
  };
}

(async () => {
  console.log('\nBilling webhook / Razorpay payload shapes\n');

  // ── razorpay.updateSubscription body ──────────────────────
  await test('updateSubscription: plan swap sends plan_id + remaining_count + schedule_change_at:now', async () => {
    lastPatch = null;
    await razorpay.updateSubscription('sub_1', { planId: 'professional', scheduleChangeAt: 'now' });
    assert.strictEqual(lastPatch.url, '/subscriptions/sub_1');
    assert.strictEqual(lastPatch.body.plan_id, 'plan_pro_live', 'maps the internal plan id to the Razorpay plan id');
    assert.strictEqual(lastPatch.body.schedule_change_at, 'now');
    assert.ok(lastPatch.body.remaining_count > 0, 'a plan change carries remaining_count');
  });

  await test('updateSubscription: quantity-only change defaults to cycle_end, no plan_id', async () => {
    lastPatch = null;
    await razorpay.updateSubscription('sub_1', { quantity: 3 });
    assert.strictEqual(lastPatch.body.quantity, 3);
    assert.strictEqual(lastPatch.body.schedule_change_at, 'cycle_end');
    assert.ok(!('plan_id' in lastPatch.body), 'no plan_id when only quantity changes');
    assert.ok(!('remaining_count' in lastPatch.body), 'no remaining_count without a plan change');
  });

  await test('updateSubscription: quantity is floored to a minimum of 1', async () => {
    lastPatch = null;
    await razorpay.updateSubscription('sub_1', { quantity: 0 });
    assert.strictEqual(lastPatch.body.quantity, 1);
  });

  // ── invoice.recordInvoiceFromCharge ──────────────────────
  await test('records an interstate charge as IGST, reading paise + unix-second timestamps', async () => {
    dbState.existingInvoice = null; dbState.lastInsert = null; dbState.seq = 41;
    dbState.billingRow = { tenant_id: 't1', tenant_name: 'Acme Dental', tenant_plan: 'professional', quantity: 2, razorpay_subscription_id: 'sub_1' };
    dbState.profileRow = { tenant_id: 't1', place_of_supply: '27', gstin: '27AAAAA0000A1Z5', legal_name: 'Acme Dental Pvt Ltd' };

    const ev = chargedEvent({ amount: 179900, created_at: 1751328000 });
    const row = await invoice.recordInvoiceFromCharge({ subscriptionId: 'sub_1', payment: ev.payment, subscription: ev.subscription });

    assert.ok(row, 'returns the created row');
    assert.strictEqual(row.total_paise, 179900);
    assert.strictEqual(row.cgst_paise, 0);
    assert.strictEqual(row.sgst_paise, 0);
    assert.strictEqual(row.taxable_paise + row.igst_paise, 179900, 'IGST + taxable re-sum to the charge');
    assert.strictEqual(row.place_of_supply, '27');
    assert.strictEqual(row.buyer_gstin, '27AAAAA0000A1Z5');
    assert.strictEqual(row.buyer_legal_name, 'Acme Dental Pvt Ltd');
    assert.strictEqual(row.quantity, 2);
    assert.strictEqual(row.plan_id, 'professional');
    assert.strictEqual(row.invoice_number, `MB/${billing.financialYear(new Date(1751328000 * 1000))}/000042`);
    assert.ok(row.period_start instanceof Date && row.period_start.getTime() === 1750723200 * 1000, 'period_start is current_start*1000');
    assert.ok(row.issued_at instanceof Date && row.issued_at.getTime() === 1751328000 * 1000, 'issued_at is payment.created_at*1000');
  });

  await test('no billing profile → billed intra-state (CGST+SGST), buyer name falls back to tenant name', async () => {
    dbState.existingInvoice = null; dbState.lastInsert = null; dbState.seq = 100;
    dbState.billingRow = { tenant_id: 't2', tenant_name: 'Bright Smile', tenant_plan: 'starter', quantity: 1, razorpay_subscription_id: 'sub_1' };
    dbState.profileRow = null;

    const ev = chargedEvent({ amount: 79900 });
    const row = await invoice.recordInvoiceFromCharge({ subscriptionId: 'sub_1', payment: ev.payment, subscription: ev.subscription });
    assert.strictEqual(row.igst_paise, 0);
    assert.ok(row.cgst_paise > 0 && row.sgst_paise > 0);
    assert.strictEqual(row.cgst_paise + row.sgst_paise + row.taxable_paise, 79900);
    assert.strictEqual(row.buyer_gstin, null);
    assert.strictEqual(row.buyer_legal_name, 'Bright Smile');
    assert.strictEqual(row.place_of_supply, '29', 'defaults to the seller state');
  });

  await test('idempotent: a duplicate subscription.charged does not issue a second invoice', async () => {
    dbState.existingInvoice = null; dbState.seq = 200;
    dbState.billingRow = { tenant_id: 't3', tenant_name: 'C', tenant_plan: 'starter', quantity: 1, razorpay_subscription_id: 'sub_1' };
    dbState.profileRow = null;
    const ev = chargedEvent({ amount: 79900, created_at: 1752000000 });

    const first = await invoice.recordInvoiceFromCharge({ subscriptionId: 'sub_1', payment: ev.payment, subscription: ev.subscription });
    const seqAfterFirst = dbState.seq;
    const second = await invoice.recordInvoiceFromCharge({ subscriptionId: 'sub_1', payment: ev.payment, subscription: ev.subscription });
    assert.strictEqual(second.invoice_number, first.invoice_number, 'same invoice returned');
    assert.strictEqual(dbState.seq, seqAfterFirst, 'the sequence was NOT advanced again');
  });

  await test('a zero-amount payment issues nothing', async () => {
    dbState.existingInvoice = null;
    dbState.billingRow = { tenant_id: 't4', tenant_name: 'D', tenant_plan: 'starter', quantity: 1, razorpay_subscription_id: 'sub_1' };
    const ev = chargedEvent({ amount: 0 });
    const row = await invoice.recordInvoiceFromCharge({ subscriptionId: 'sub_1', payment: ev.payment, subscription: ev.subscription });
    assert.strictEqual(row, null);
  });

  await test('unknown subscription (no tenant_billing) issues nothing', async () => {
    dbState.existingInvoice = null; dbState.billingRow = null;
    const ev = chargedEvent();
    const row = await invoice.recordInvoiceFromCharge({ subscriptionId: 'sub_unknown', payment: ev.payment, subscription: ev.subscription });
    assert.strictEqual(row, null);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
