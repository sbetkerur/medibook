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
 *     OVERRIDE (a negotiated or waived fee); it defaults to 0, and now has a
 *     writer — the dashboard's fee-override control (`POST`/`PATCH
 *     /appointments`) — but most appointments still carry no override, so the
 *     fee actually charged is usually the doctor's `consultation_fee`.
 *     Summing effective_fee raw — which this route used to do, back when
 *     nothing wrote it — reported ₹0 of consultation income every single day,
 *     and the drawer never matched. Use the same
 *     `COALESCE(NULLIF(effective_fee,0), consultation_fee)` expression the five
 *     analytics queries and the weekly digest already use, or day-close and the
 *     revenue chart disagree about the same day.
 *   - TREATMENT payments, recorded against a course as a whole
 *
 * Broken down by method, because that is the actual reconciliation: cash in the
 * drawer must match the cash line, and UPI must match the phone.
 *
 * `appointments.payment_status`/`payment_method` also now have writers (PATCH
 * /appointments/:id) — the desk marks a completed visit paid/pending/waived,
 * same as recording a treatment payment already worked. `collected_total`
 * counts only what's actually marked paid; a completed visit nobody has
 * touched shows up in `fees_pending`/`pending_count` instead of being silently
 * assumed collected.
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
  const consultByMethod = payload.consultation_payments?.by_method || [];
  const consultPaidTotal = payload.consultation_payments?.total || 0;
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
        `${rupees(consultPaidTotal)} in consultation fees marked paid, ` +
        `plus ${rupees(treatmentTotal)} in treatment payments. The two streams are added once.`
      );
      if (a.pending_count > 0) {
        doc.moveDown(0.2);
        doc.font('body').fontSize(9).fillColor('#b45309').text(
          `${a.pending_count} completed appointment${a.pending_count === 1 ? ' is' : 's are'} still marked ` +
          `unpaid (${rupees(a.fees_pending)}) — mark them paid or waived before this total can be trusted.`
        );
      }
      doc.moveDown(1);

      doc.font('bold').fontSize(11).fillColor('#000').text('Appointments');
      doc.moveDown(0.3);
      kv(doc, 'Booked', String(a.total ?? 0));
      kv(doc, 'Completed', String(a.completed ?? 0));
      kv(doc, 'Still open', String(a.still_open ?? 0));
      kv(doc, 'No-show', String(a.no_show ?? 0));
      kv(doc, 'Cancelled', String(a.cancelled ?? 0));
      doc.moveDown(1);

      doc.font('bold').fontSize(11).fillColor('#000').text('Consultation fees by method (marked paid)');
      doc.moveDown(0.3);
      if (consultByMethod.length) {
        drawTable(doc, [
          { key: 'method', label: 'Method', width: 12 },
          { key: 'count', label: 'Payments', width: 8, align: 'right' },
          { key: 'amount', label: 'Amount', width: 10, align: 'right' },
        ], consultByMethod.map(m => ({
          method: METHOD_LABELS[m.method] || m.method,
          count: String(m.count),
          amount: rupees(m.amount),
        })).concat([{ method: 'Total', count: '', amount: rupees(consultPaidTotal) }]));
      } else {
        doc.font('body').fontSize(10).fillColor('#666').text('No consultation fees marked paid yet.');
        doc.moveDown(0.6);
      }
      doc.moveDown(0.4);

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

    // The fee expression every consultation-money query below shares — kept as
    // one literal repeated in each SELECT (Postgres has no named-expression
    // syntax cheap enough to bother with here) rather than a helper that builds
    // strings, which would just be a second place for the expression to drift
    // from the one every other revenue query in the product already uses.
    const FEE_EXPR = `COALESCE(NULLIF(a.effective_fee, 0), d.consultation_fee)`;

    const [appts, consultByMethod, treatment, byDoctor] = await Promise.all([
      // Consultation fees. Counted on appointments that actually HAPPENED —
      // a cancelled booking collects nothing, and a confirmed one that never
      // arrived is a no-show, not revenue.
      //
      // paid/pending/waived split appointments.payment_status, which the desk
      // now has a way to write (PATCH /appointments/:id) — 'pending' is also
      // the column DEFAULT, so a completed visit nobody has touched yet reads
      // as pending, not as silently paid. NULL is treated the same as
      // 'pending' defensively; nothing writes NULL, but a report that breaks
      // on it instead of just under-counting is the wrong failure mode.
      tenantQuery(s, `
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed,
               COUNT(*) FILTER (WHERE a.status = 'no_show')::int   AS no_show,
               COUNT(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled,
               COUNT(*) FILTER (WHERE a.status = 'confirmed')::int AS still_open,
               COALESCE(SUM(${FEE_EXPR})
                          FILTER (WHERE a.status = 'completed'), 0)::int AS fees_completed,
               COUNT(*) FILTER (WHERE a.status = 'completed' AND a.payment_status = 'paid')::int AS paid_count,
               COALESCE(SUM(${FEE_EXPR})
                          FILTER (WHERE a.status = 'completed' AND a.payment_status = 'paid'), 0)::int AS fees_paid,
               COUNT(*) FILTER (WHERE a.status = 'completed' AND a.payment_status = 'waived')::int AS waived_count,
               COALESCE(SUM(${FEE_EXPR})
                          FILTER (WHERE a.status = 'completed' AND a.payment_status = 'waived'), 0)::int AS fees_waived,
               COUNT(*) FILTER (WHERE a.status = 'completed' AND (a.payment_status IS NULL OR a.payment_status = 'pending'))::int AS pending_count,
               COALESCE(SUM(${FEE_EXPR})
                          FILTER (WHERE a.status = 'completed' AND (a.payment_status IS NULL OR a.payment_status = 'pending')), 0)::int AS fees_pending
          FROM appointments a
          -- LEFT, not INNER: the counts above are of APPOINTMENTS, and an inner
          -- join would silently drop any row whose doctor was hard-deleted,
          -- making the day's headline count wrong to fix the money column.
          LEFT JOIN doctors d ON d.id = a.doctor_id
         WHERE a.appointment_date = ${dayExpr}
      `, params),

      // Consultation fees actually MARKED paid, by method — the same
      // reconciliation treatment_payments gets below, now possible because
      // payment_method has a writer. COALESCE guards a paid row saved before
      // this column existed, or any future write that omits it; grouping on
      // NULL would otherwise open its own silent "method: null" bucket.
      tenantQuery(s, `
        SELECT COALESCE(a.payment_method, 'cash') AS method,
               COUNT(*)::int AS count,
               COALESCE(SUM(${FEE_EXPR}), 0)::int AS amount
          FROM appointments a
          LEFT JOIN doctors d ON d.id = a.doctor_id
         WHERE a.appointment_date = ${dayExpr}
           AND a.status = 'completed' AND a.payment_status = 'paid'
         GROUP BY COALESCE(a.payment_method, 'cash')
         ORDER BY amount DESC
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
               COALESCE(SUM(${FEE_EXPR})
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
      // Mirrors treatment_payments' shape below on purpose — the two are the
      // same kind of fact (money actually collected, by method) now that
      // payment_status/payment_method have writers.
      consultation_payments: { by_method: consultByMethod.rows, total: a.fees_paid || 0 },
      treatment_payments: { by_method: treatment.rows, total: treatmentTotal },
      by_doctor: byDoctor.rows,
      // The number to count the drawer against. Consultation money now means
      // fees actually MARKED paid — not "every completed visit," which is what
      // this counted before per-appointment marking existed (see git history:
      // that version summed effective_fee raw before anything wrote it, and
      // reported ₹0 every day). Un-marked completed visits show up instead in
      // `appointments.fees_pending` / `pending_count` below, which the desk
      // works down before closing rather than the drawer silently disagreeing
      // with a number that assumed every visit was paid.
      collected_total: (a.fees_paid || 0) + treatmentTotal,
    };

    if (req.query.format === 'pdf') return renderDayClosePdf(res, req, payload);
    res.json(payload);
  } catch (err) { if (!res.headersSent) handleError(res, err); }
});

module.exports = router;
