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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

    res.json({
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
    });
  } catch (err) { handleError(res, err); }
});

module.exports = router;
