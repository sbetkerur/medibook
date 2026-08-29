'use strict';
/**
 * GST tax invoices for self-serve subscription charges.
 *
 * One `billing_invoices` row per successful Razorpay charge — written from the
 * `subscription.charged` webhook (routes/webhook.js). Idempotent on
 * `razorpay_payment_id`, so a webhook retry never double-issues. The amount
 * Razorpay charged is GST-INCLUSIVE (see services/billing.js): the invoice
 * shows the back-computed taxable value and the CGST+SGST / IGST split.
 *
 * This is a proper tax invoice (unlike the WhatsApp payment *receipt* a clinic
 * hands a patient) — it carries the seller's GSTIN, the buyer's GSTIN when they
 * gave one, place of supply, HSN/SAC, and a sequential invoice number. Clinics
 * need it for input-tax credit.
 */
const { query } = require('../db');
const logger = require('../utils/logger');
const billing = require('./billing');
const { streamReport, drawTable, rupees, istStamp } = require('../utils/pdfReport');

const SAC_CODE = '998314'; // "Information technology (IT) design and development services"

/**
 * Create the invoice row for a charge, if one does not already exist.
 * @param {object} args
 * @param {string} args.subscriptionId  razorpay_subscription_id
 * @param {object} args.payment         payload.payment.entity from the webhook
 * @param {object} [args.subscription]  payload.subscription.entity (for the period)
 * @returns {Promise<object|null>} the invoice row, or null if nothing to do
 */
async function recordInvoiceFromCharge({ subscriptionId, payment, subscription }) {
  if (!payment || !payment.id) return null;

  const existing = await query(
    `SELECT * FROM billing_invoices WHERE razorpay_payment_id=$1`, [payment.id]);
  if (existing.rows[0]) return existing.rows[0];

  const bR = await query(
    `SELECT b.*, t.id AS tenant_id, t.name AS tenant_name, t.plan AS tenant_plan
       FROM tenant_billing b JOIN tenants t ON t.id = b.tenant_id
      WHERE b.razorpay_subscription_id=$1`, [subscriptionId]);
  const billingRow = bR.rows[0];
  if (!billingRow) {
    logger.info('invoice: no tenant_billing for subscription — skipping', { subscriptionId });
    return null;
  }

  const profR = await query(
    `SELECT * FROM tenant_billing_profiles WHERE tenant_id=$1`, [billingRow.tenant_id]);
  const profile = profR.rows[0] || null;

  const totalPaise = Math.round(Number(payment.amount) || 0); // Razorpay amounts are paise
  if (totalPaise <= 0) return null;

  const placeOfSupply = (profile?.place_of_supply || billing.seller().stateCode);
  const split = billing.splitGst(totalPaise, profile?.place_of_supply || null);

  const periodStart = subscription?.current_start ? new Date(subscription.current_start * 1000) : null;
  const periodEnd = subscription?.current_end ? new Date(subscription.current_end * 1000) : null;
  const issuedAt = payment.created_at ? new Date(payment.created_at * 1000) : new Date();

  // A consumed nextval() is never returned to the sequence (Postgres does not
  // roll sequence advances back, even inside a transaction), so a duplicate
  // webhook or a caught error that skips the INSERT leaves a GAP in the invoice
  // series. That is acceptable under GST rules (the series must be unique and
  // sequential; documented gaps from voided/duplicate issuance are fine) — what
  // must never happen is a REUSED number, and the razorpay_payment_id unique
  // index + ON CONFLICT DO NOTHING guarantee that.
  const invoiceNumber = await billing.nextInvoiceNumber(null, issuedAt);
  try {
    const ins = await query(`
      INSERT INTO billing_invoices (
        tenant_id, invoice_number, financial_year, provider,
        razorpay_payment_id, razorpay_subscription_id,
        period_start, period_end, currency,
        total_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise, gst_rate,
        place_of_supply, buyer_legal_name, buyer_gstin, plan_id, quantity,
        status, issued_at, payload
      ) VALUES (
        $1,$2,$3,'razorpay',
        $4,$5,
        $6,$7,'INR',
        $8,$9,$10,$11,$12,$13,
        $14,$15,$16,$17,$18,
        'paid',$19,$20
      )
      ON CONFLICT (razorpay_payment_id) DO NOTHING
      RETURNING *
    `, [
      billingRow.tenant_id, invoiceNumber, billing.financialYear(issuedAt),
      payment.id, subscriptionId,
      periodStart, periodEnd,
      totalPaise, split.taxable_paise, split.cgst_paise, split.sgst_paise, split.igst_paise, split.gst_rate,
      placeOfSupply, profile?.legal_name || billingRow.tenant_name, profile?.gstin || null,
      billingRow.tenant_plan, billingRow.quantity || 1,
      // A Razorpay payment + subscription entity is a few KB — stored whole (a
      // slice here would risk truncating mid-string and failing the ::jsonb cast).
      issuedAt, JSON.stringify({ payment, subscription: subscription || null }),
    ]);
    const row = ins.rows[0];
    if (row) logger.info('invoice: issued', { number: invoiceNumber, tenant: billingRow.tenant_id, total_paise: totalPaise });
    else {
      const again = await query(`SELECT * FROM billing_invoices WHERE razorpay_payment_id=$1`, [payment.id]);
      return again.rows[0] || null;
    }
    return row;
  } catch (err) {
    logger.error('invoice: insert failed', { subscriptionId, payment: payment.id, error: err.message });
    return null;
  }
}

function paise(p) { return rupees(Math.round((Number(p) || 0) / 100)); }

/**
 * Stream a one-page A4 tax invoice PDF to `res`. Reuses the report plumbing
 * (embedded Noto Sans for the ₹ glyph, page band, page numbers).
 */
function renderInvoicePdf(res, { invoice, tenant }) {
  const s = billing.seller();
  const interState = invoice.igst_paise > 0;

  streamReport(res, {
    clinicName: s.legalName,
    branchName: s.gstin ? `GSTIN ${s.gstin}` : null,
    phone: s.address,
    title: 'Tax Invoice',
    subtitle: `${invoice.invoice_number}  ·  issued ${istStamp(invoice.issued_at)}`,
    filename: `invoice-${String(invoice.invoice_number).replace(/[^\w.-]+/g, '-')}`,
  }, (doc) => {
    doc.font('bold').fontSize(10).fillColor('#000').text('Billed to');
    doc.font('body').fontSize(10).fillColor('#222')
      .text(invoice.buyer_legal_name || tenant?.name || '—');
    if (invoice.buyer_gstin) doc.text(`GSTIN: ${invoice.buyer_gstin}`);
    doc.text(`Place of supply: ${invoice.place_of_supply || '—'}`);
    doc.moveDown(0.8);

    const period = [invoice.period_start, invoice.period_end]
      .filter(Boolean)
      .map(d => istStamp(d).replace(/,.*/, ''))
      .join(' – ');

    drawTable(doc, [
      { key: 'desc', label: 'Description', width: 44 },
      { key: 'sac', label: 'SAC', width: 12, align: 'center' },
      { key: 'qty', label: 'Qty', width: 8, align: 'right' },
      { key: 'amount', label: 'Taxable value', width: 18, align: 'right' },
    ], [{
      desc: `MediBook subscription — ${invoice.plan_id || 'plan'}${period ? `\n${period}` : ''}`,
      sac: SAC_CODE,
      qty: String(invoice.quantity || 1),
      amount: paise(invoice.taxable_paise),
    }]);

    doc.moveDown(0.4);
    const right = (label, value, bold) => {
      doc.font(bold ? 'bold' : 'body').fontSize(10).fillColor('#000')
        .text(`${label}   ${value}`, { align: 'right' });
    };
    right('Taxable value', paise(invoice.taxable_paise));
    if (interState) {
      right(`IGST @ ${(Number(invoice.gst_rate) * 100).toFixed(0)}%`, paise(invoice.igst_paise));
    } else {
      right(`CGST @ ${(Number(invoice.gst_rate) * 50).toFixed(0)}%`, paise(invoice.cgst_paise));
      right(`SGST @ ${(Number(invoice.gst_rate) * 50).toFixed(0)}%`, paise(invoice.sgst_paise));
    }
    right('Total', paise(invoice.total_paise), true);

    doc.moveDown(1);
    doc.font('body').fontSize(8).fillColor('#777').text(
      'Amount charged is inclusive of GST. This is a computer-generated tax invoice and needs no signature. ' +
      `Payment reference: ${invoice.razorpay_payment_id || '—'}.`,
      { align: 'left' }
    );
  });
}

module.exports = { recordInvoiceFromCharge, renderInvoicePdf, SAC_CODE };
