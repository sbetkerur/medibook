'use strict';
/**
 * Billing maths and orchestration for the self-serve module.
 *
 * The Razorpay plan amount is GST-INCLUSIVE (a "₹799" plan charges ₹799, and
 * the tax invoice back-computes ₹677 taxable + ₹122 GST). So nothing here ever
 * *adds* tax on top — it splits an already-final total. `splitGst` is the only
 * place that split lives; the webhook invoice writer and the PDF both read it.
 *
 * Professional is billed plan_price × (number of active branches). The count is
 * `time_slots`-adjacent state that only exists in the tenant schema, so
 * `syncSubscriptionQuantity` recomputes it whenever a branch is added or
 * removed and pushes the new `quantity` to Razorpay (and mirrors the agreed
 * rupee figure to `tenants.billing_monthly`, which superadmin MRR reads).
 */
const { query, tenantQuery } = require('../db');
const logger = require('../utils/logger');
const razorpay = require('./razorpay');

const GST_RATE = 0.18;

// The selling entity, from env — one place, read by the invoice writer and PDF.
// STATE_CODE decides CGST+SGST (buyer in the same state) vs IGST (interstate).
function seller() {
  return {
    legalName: (process.env.SELLER_LEGAL_NAME || 'Pragati Solutions').trim(),
    gstin: (process.env.SELLER_GSTIN || '').trim(),
    stateCode: (process.env.SELLER_STATE_CODE || '29').trim(), // 29 = Karnataka
    address: (process.env.SELLER_ADDRESS || 'A202, Mantri Lithos, Manyata Tech Park, Bengaluru 560045').trim(),
    invoicePrefix: (process.env.INVOICE_NUMBER_PREFIX || 'MB').trim(),
  };
}

/**
 * Split a GST-INCLUSIVE total (paise) into taxable value + tax components.
 * Intra-state → CGST + SGST at half the rate each; inter-state → IGST at the
 * full rate. Rounding: taxable is floored, the tax lines take the remainder so
 * the parts always re-sum to `totalPaise` exactly (a ₹1 rounding gap on an
 * invoice is the kind of thing an accountant bounces).
 */
function splitGst(totalPaise, buyerStateCode, rate = GST_RATE) {
  const total = Math.max(0, Math.round(Number(totalPaise) || 0));
  const taxable = Math.floor(total / (1 + rate));
  const taxTotal = total - taxable;
  const sellerState = seller().stateCode;
  const interState = !!buyerStateCode && String(buyerStateCode) !== sellerState;
  if (interState) {
    return { taxable_paise: taxable, cgst_paise: 0, sgst_paise: 0, igst_paise: taxTotal, gst_rate: rate, inter_state: true };
  }
  const cgst = Math.floor(taxTotal / 2);
  return { taxable_paise: taxable, cgst_paise: cgst, sgst_paise: taxTotal - cgst, igst_paise: 0, gst_rate: rate, inter_state: false };
}

/** Indian financial year for a date — "2025-26" for anything Apr 2025–Mar 2026. */
function financialYear(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getUTCFullYear();
  const startYear = dt.getUTCMonth() >= 3 ? y : y - 1; // month 3 = April (0-indexed)
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Next invoice number, e.g. "MB/2025-26/000042". Uses billing_invoice_seq so
 * two concurrent charges can never collide; the sequence is monotonic across
 * financial years (simpler to reason about than a per-FY reset, and GST law
 * only requires the series be unique and sequential, not FY-scoped).
 */
async function nextInvoiceNumber(client, issuedAt = new Date()) {
  const q = client || { query: (...a) => query(...a) };
  const r = await q.query(`SELECT nextval('billing_invoice_seq') AS n`);
  const n = String(r.rows[0].n).padStart(6, '0');
  return `${seller().invoicePrefix}/${financialYear(issuedAt)}/${n}`;
}

/**
 * How many units this tenant's subscription should bill for. Professional is
 * per-branch; everything else is a flat 1. A soft-deleted branch does not count
 * (it matches how routes/hospitals.js enforces max_branches).
 */
async function branchQuantity(schemaName, planId) {
  if (planId !== 'professional') return 1;
  try {
    const r = await tenantQuery(schemaName,
      `SELECT COUNT(*)::int AS n FROM hospitals WHERE is_active = true AND deleted_at IS NULL`);
    return Math.max(1, r.rows[0]?.n || 1);
  } catch (e) {
    logger.warn('branchQuantity: count failed, defaulting to 1', { schema: schemaName, error: e.message });
    return 1;
  }
}

/** List price (paise) for a plan × quantity, from the plans table. */
async function agreedMonthlyPaise(planId, quantity) {
  const r = await query(`SELECT price_monthly FROM plans WHERE id=$1`, [planId]);
  const perUnit = Number(r.rows[0]?.price_monthly || 0);
  return Math.round(perUnit * Math.max(1, quantity) * 100);
}

/**
 * Recompute the branch quantity for a self-serve tenant and, if it changed,
 * push it to Razorpay and mirror the agreed monthly figure to
 * `tenants.billing_monthly`. Fire-and-forget from routes/hospitals.js — a
 * branch add/remove must not fail because Razorpay was briefly unreachable;
 * jobs/billingDunning.js reconciles quantity on its daily pass as the backstop.
 */
async function syncSubscriptionQuantity(tenantId) {
  const tR = await query(`SELECT id, slug, plan, schema_name, signup_source FROM tenants WHERE id=$1`, [tenantId]);
  const tenant = tR.rows[0];
  if (!tenant || tenant.signup_source !== 'self_serve') return;

  const bR = await query(`SELECT * FROM tenant_billing WHERE tenant_id=$1`, [tenantId]);
  const billing = bR.rows[0];
  if (!billing) return;

  const qty = await branchQuantity(tenant.schema_name, tenant.plan);
  const agreedPaise = await agreedMonthlyPaise(tenant.plan, qty);

  if ((billing.quantity || 1) === qty) {
    // Quantity unchanged — still keep billing_monthly honest (plan price may
    // have moved, or a prior sync half-finished).
    await query(`UPDATE tenants SET billing_monthly=$1 WHERE id=$2 AND billing_monthly IS DISTINCT FROM $1`,
      [Math.round(agreedPaise / 100), tenantId]).catch(() => {});
    return;
  }

  if (billing.razorpay_subscription_id && razorpay.isConfigured()) {
    try {
      await razorpay.updateSubscription(billing.razorpay_subscription_id, {
        quantity: qty,
        // A branch added mid-cycle should be charged from the next cycle, not
        // prorated mid-month — clinics find proration lines confusing and it is
        // a tiny sum. Downgrades (branch removed) also take effect next cycle.
        scheduleChangeAt: 'cycle_end',
      });
    } catch (e) {
      logger.warn('syncSubscriptionQuantity: Razorpay update failed — will retry via dunning', {
        slug: tenant.slug, from: billing.quantity, to: qty, error: e.message,
      });
      return; // leave tenant_billing.quantity as-is so the dunning cron retries
    }
  }

  await query(`UPDATE tenant_billing SET quantity=$1, updated_at=NOW() WHERE tenant_id=$2`, [qty, tenantId]);
  await query(`UPDATE tenants SET billing_monthly=$1 WHERE id=$2`, [Math.round(agreedPaise / 100), tenantId]).catch(() => {});
  logger.info('billing: subscription quantity synced', { slug: tenant.slug, quantity: qty });
}

module.exports = {
  GST_RATE,
  seller,
  splitGst,
  financialYear,
  nextInvoiceNumber,
  branchQuantity,
  agreedMonthlyPaise,
  syncSubscriptionQuantity,
};
