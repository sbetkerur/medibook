'use strict';
/**
 * End of day: what came in, so the receptionist can count the cash against it.
 *
 * Every clinic does this before locking up, and it was the one front-desk
 * ritual the product had no answer for. The two money streams are deliberately
 * kept apart, because conflating them double-counts revenue (see
 * `treatment_payments` in CLAUDE.md):
 *
 *   - CONSULTATION fees, per appointment. `appointments.effective_fee` is an
 *     OVERRIDE (a negotiated or waived fee); it defaults to 0 and no code path
 *     writes it today, so the fee actually charged is the doctor's
 *     `consultation_fee`. Summing effective_fee raw — which this route used to
 *     do — therefore reported ₹0 of consultation income every single day, and
 *     the drawer never matched. Use the same
 *     `COALESCE(NULLIF(effective_fee,0), consultation_fee)` expression the five
 *     analytics queries and the weekly digest already use, or day-close and the
 *     revenue chart disagree about the same day.
 *   - TREATMENT payments, recorded against a course as a whole
 *
 * Broken down by method, because that is the actual reconciliation: cash in the
 * drawer must match the cash line, and UPI must match the phone.
 *
 * Auth + tenant middleware applied once in index.js.
 */
const router = require('express').Router();
const { tenantQuery } = require('../db');
const { handleError } = require('../utils/errors');
const { IST_TODAY_SQL } = require('../utils/dateTz');
const { streamReport, drawTable, kv, rupees, prettyDate } = require('../utils/pdfReport');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const METHOD_LABELS = {
  cash: 'Cash', card: 'Card', upi: 'UPI',
  bank_transfer: 'Bank transfer', cheque: 'Cheque', other: 'Other',
};

// Same branch-label rule as routes/reports.js: a name only when the clinic has
// exactly one active branch, so a multi-branch total isn't mislabelled.
async function soleBranch(schema) {
  try {
    const h = await tenantQuery(schema,
      `SELECT name, phone FROM hospitals WHERE is_active = true AND deleted_at IS NULL ORDER BY created_at LIMIT 2`);
    if (h.rows.length === 1) return { branchName: h.rows[0].name, phone: h.rows[0].phone || null };
  } catch { /* decoration only */ }
  return { branchName: null, phone: null };
}

function renderDayClosePdf(res, req, payload) {
  const a = payload.appointments || {};
  const byMethod = payload.treatment_payments?.by_method || [];
  const treatmentTotal = payload.treatment_payments?.total || 0;
  const dateStr = payload.date || 'today';

  return soleBranch(req.tenant.schema_name).then(({ branchName, phone }) => {
    streamReport(res, {
      clinicName: req.tenant.name,
      branchName,
      phone,
      title: 'Day Close',
      subtitle: payload.date ? prettyDate(payload.date) : 'Today',
      filename: `day-close-${dateStr}`,
    }, doc => {
      doc.font('bold').fontSize(14).fillColor('#000')
        .text(`Collected: ${rupees(payload.collected_total)}`);
      doc.moveDown(0.3);
      doc.font('body').fontSize(9).fillColor('#555').text(
        `${rupees(a.fees_completed)} in consultation fees for ${a.completed || 0} appointment(s) seen, ` +
        `plus ${rupees(treatmentTotal)} in treatment payments. The two streams are added once.`
      );
      doc.moveDown(1);

      doc.font('bold').fontSize(11).fillColor('#000').text('Appointments');
      doc.moveDown(0.3);
      kv(doc, 'Booked', String(a.total ?? 0));
      kv(doc, 'Completed', String(a.completed ?? 0));
      kv(doc, 'Still open', String(a.still_open ?? 0));
      kv(doc, 'No-show', String(a.no_show ?? 0));
      kv(doc, 'Cancelled', String(a.cancelled ?? 0));
      doc.moveDown(1);

      doc.font('bold').fontSize(11).fillColor('#000').text('Treatment payments by method');
      doc.moveDown(0.3);
      if (byMethod.length) {
        drawTable(doc, [
          { key: 'method', label: 'Method', width: 12 },
          { key: 'count', label: 'Payments', width: 8, align: 'right' },
          { key: 'amount', label: 'Amount', width: 10, align: 'right' },
        ], byMethod.map(m => ({
          method: METHOD_LABELS[m.method] || m.method,
          count: String(m.count),
          amount: rupees(m.amount),
        })).concat([{ method: 'Total', count: '', amount: rupees(treatmentTotal) }]));
      } else {
        doc.font('body').fontSize(10).fillColor('#666').text('No treatment payments taken.');
        doc.moveDown(0.6);
      }

      if (payload.by_doctor?.length) {
        doc.moveDown(0.4);
        doc.font('bold').fontSize(11).fillColor('#000').text('By dentist');
        doc.moveDown(0.3);
        drawTable(doc, [
          { key: 'name', label: 'Dentist', width: 16 },
          { key: 'seen', label: 'Patients', width: 6, align: 'right' },
          { key: 'fees', label: 'Consultation fees', width: 10, align: 'right' },
        ], payload.by_doctor.map(d => ({
          name: `Dr. ${d.doctor_name}`,
          seen: String(d.seen),
          fees: rupees(d.fees),
        })));
      }
    });
  });
}

router.get('/day-close', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const { date } = req.query;
    if (date && !DATE_RE.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    // IST, never CURRENT_DATE: the UTC date is a day behind IST until 05:30, so
    // a clinic closing up at 21:00 would otherwise be shown yesterday's takings.
    const day = date || null;
    const dayExpr = day ? '$1::date' : IST_TODAY_SQL;
    const params = day ? [day] : [];

    const [appts, treatment, byDoctor] = await Promise.all([
      // Consultation fees. Counted on appointments that actually HAPPENED —
      // a cancelled booking collects nothing, and a confirmed one that never
      // arrived is a no-show, not revenue.
      tenantQuery(s, `
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed,
               COUNT(*) FILTER (WHERE a.status = 'no_show')::int   AS no_show,
               COUNT(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled,
               COUNT(*) FILTER (WHERE a.status = 'confirmed')::int AS still_open,
               COALESCE(SUM(COALESCE(NULLIF(a.effective_fee, 0), d.consultation_fee))
                          FILTER (WHERE a.status = 'completed'), 0)::int AS fees_completed
          FROM appointments a
          -- LEFT, not INNER: the counts above are of APPOINTMENTS, and an inner
          -- join would silently drop any row whose doctor was hard-deleted,
          -- making the day's headline count wrong to fix the money column.
          LEFT JOIN doctors d ON d.id = a.doctor_id
         WHERE a.appointment_date = ${dayExpr}
      `, params),

      // Treatment payments taken today, whatever course they belong to.
      // created_at is a TIMESTAMPTZ, so it is compared in IST rather than
      // coerced at the server timezone — the same 5.5-hour trap as above.
      tenantQuery(s, `
        SELECT method,
               COUNT(*)::int AS count,
               COALESCE(SUM(amount), 0)::int AS amount
          FROM treatment_payments
         WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${dayExpr}
         GROUP BY method
         ORDER BY amount DESC
      `, params),

      tenantQuery(s, `
        SELECT d.name AS doctor_name,
               COUNT(*)::int AS seen,
               COALESCE(SUM(COALESCE(NULLIF(a.effective_fee, 0), d.consultation_fee))
                          FILTER (WHERE a.status = 'completed'), 0)::int AS fees
          FROM appointments a JOIN doctors d ON d.id = a.doctor_id
         WHERE a.appointment_date = ${dayExpr}
           AND a.status IN ('completed', 'confirmed')
         GROUP BY d.name
         ORDER BY seen DESC
      `, params),
    ]);

    const treatmentTotal = treatment.rows.reduce((sum, r) => sum + r.amount, 0);
    const a = appts.rows[0] || {};

    const payload = {
      date: day,
      appointments: a,
      treatment_payments: { by_method: treatment.rows, total: treatmentTotal },
      by_doctor: byDoctor.rows,
      // The number to count the drawer against: consultation fees for the
      // appointments that actually happened today, plus treatment money taken
      // today — the two streams added ONCE, which is the whole reason they are
      // reported separately above.
      //
      // There is deliberately no paid/unpaid split. `payment_status` exists on
      // the table but nothing in the product writes it, so the old
      // `fees_collected` was structurally always 0 and the dashboard told every
      // clinic that 100% of its consultation fees were unpaid. Reporting one
      // honest number beats reporting a distinction the product cannot make; if
      // per-appointment payment marking is ever added, split this again then.
      collected_total: (a.fees_completed || 0) + treatmentTotal,
    };

    if (req.query.format === 'pdf') return renderDayClosePdf(res, req, payload);
    res.json(payload);
  } catch (err) { if (!res.headersSent) handleError(res, err); }
});

module.exports = router;
