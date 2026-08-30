'use strict';
/**
 * On-demand PDF reports for the front desk.
 *
 * Each route is a plain GET that streams a PDF and stores nothing. These are
 * read views the desk prints when locking up, so — like /day-close and
 * /requests, whose ?format=pdf arms live in their own files — they are NOT
 * adminOnly: a dentist login prints the day's list too. The one report that
 * IS admin-gated, /analytics/export, is a bulk PHI extract and does not belong
 * here.
 *
 *   - /reports/schedule.pdf — a day's appointments, grouped by dentist. For a
 *     FUTURE date it also carries each patient's reminder-reply status and a
 *     "confirmed / to call" summary, so "tomorrow's schedule" and the evening
 *     call-list are one report, not two. (A same-day appointment gets no 24h
 *     reminder — jobs/reminders.js only fires for strictly future dates — so
 *     the column is omitted for today and the past.)
 *   - /reports/dues.pdf — money owed: unpaid completed-visit consultation fees
 *     AND treatment-plan balances (estimated_cost − payments), on one worklist.
 *   - /reports/treatments.pdf — see routes/treatmentPlans.js: the ?format=pdf
 *     arm of GET /treatment-plans, the "advised but not booked / stalled"
 *     worklist the weekly digest only quotes a count of.
 *   - /reports/recalls.pdf — the check-up call-list: recalls due (and overdue),
 *     last visit, and whether the WhatsApp nudge has gone unanswered.
 *   - /reports/lab-works.pdf — crowns and dentures out at the lab: what's due
 *     back and what's overdue, so a sitting isn't booked before the work is in.
 *   - /reports/dentist-activity.pdf?from=&to= — per dentist over a period:
 *     seen / completed / no-show, consultation fees, treatments advised, rating.
 *   - /reports/period.pdf?from=&to= — the month-end summary: money collected by
 *     method, appointment mix, new patients, revenue by dentist and treatment.
 *
 * plus /day-close?format=pdf (routes/dayClose.js) and /requests?format=pdf
 * (routes/requests.js).
 *
 * Auth + tenant middleware are applied once in index.js — not re-applied here.
 */
const router = require('express').Router();
const { tenantQuery } = require('../db');
const { handleError, UUID_RE } = require('../utils/errors');
const { toZonedTime, IST_TODAY_SQL } = require('../utils/dateTz');
const { format } = require('date-fns');
const { streamReport, drawTable, kv, rupees, prettyDate } = require('../utils/pdfReport');

const IST = 'Asia/Kolkata';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function istToday() {
  return format(toZonedTime(new Date(), IST), 'yyyy-MM-dd');
}

function istMonthStart() {
  return format(toZonedTime(new Date(), IST), 'yyyy-MM-01');
}

// Shared `?from=&to=` parsing for the period-style reports. Defaults to the
// current IST month; caps the span so a bad request can't ask for a decade of
// rows. Returns { from, to } strings, or { error } for the caller to 400.
function parseRange(req) {
  const to = req.query.to || istToday();
  const from = req.query.from || istMonthStart();
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return { error: 'from and to must be YYYY-MM-DD' };
  }
  if (from > to) return { error: 'from must not be after to' };
  const spanDays = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000;
  if (spanDays > 400) return { error: 'range must be 400 days or less' };
  return { from, to };
}

function rangeLabel(from, to) {
  try {
    return `${format(new Date(from + 'T00:00:00'), 'd MMM yyyy')} – ${format(new Date(to + 'T00:00:00'), 'd MMM yyyy')}`;
  } catch {
    return `${from} to ${to}`;
  }
}

// "yes" to the 24h reminder, in the shapes reminders.js records.
const CONFIRMED_REPLIES = new Set(['yes', 'y', 'confirm', 'confirmed']);
function isConfirmedReply(resp) {
  return resp != null && CONFIRMED_REPLIES.has(String(resp).trim().toLowerCase());
}

/**
 * Clinic name (from req.tenant, the full tenants row) plus a branch name and
 * phone for the PDF band. A named hospital_id wins; otherwise a branch label is
 * only shown when the clinic has exactly one active branch, so a multi-branch
 * "all branches" report doesn't mislabel itself.
 */
async function clinicHeader(req, hospitalId) {
  const s = req.tenant.schema_name;
  let branchName = null;
  let phone = null;
  try {
    if (hospitalId) {
      const h = await tenantQuery(s, `SELECT name, phone FROM hospitals WHERE id = $1`, [hospitalId]);
      if (h.rows[0]) {
        branchName = h.rows[0].name;
        phone = h.rows[0].phone || null;
      }
    } else {
      const h = await tenantQuery(
        s,
        `SELECT name, phone FROM hospitals WHERE is_active = true AND deleted_at IS NULL ORDER BY created_at LIMIT 2`
      );
      if (h.rows.length === 1) {
        branchName = h.rows[0].name;
        phone = h.rows[0].phone || null;
      }
    }
  } catch {
    /* header bits are decoration — never fail a report over them */
  }
  return { clinicName: req.tenant.name, branchName, phone };
}

// ── A DAY'S SCHEDULE (+ confirmation status for future dates) ──
router.get('/reports/schedule.pdf', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const date = req.query.date || istToday();
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const hospitalId = req.query.hospital_id || null;
    if (hospitalId && !UUID_RE.test(hospitalId)) {
      return res.status(400).json({ error: 'hospital_id must be a UUID' });
    }

    const today = istToday();
    const isFuture = date > today;

    const params = [date];
    let branchFilter = '';
    if (hospitalId) {
      params.push(hospitalId);
      branchFilter = `AND a.hospital_id = $${params.length}`;
    }

    const r = await tenantQuery(
      s,
      `
      SELECT a.appointment_time, a.status, a.visit_type, a.reminder_24h_sent,
             p.name AS patient_name, p.phone AS patient_phone, p.visit_count,
             d.name AS doctor_name,
             dep.name AS department_name,
             h.name AS hospital_name,
             rc.response AS reminder_response
      FROM appointments a
      JOIN patients p ON p.id = a.patient_id
      JOIN doctors d ON d.id = a.doctor_id
      LEFT JOIN departments dep ON dep.id = COALESCE(a.department_id, d.department_id)
      JOIN hospitals h ON h.id = a.hospital_id
      LEFT JOIN LATERAL (
        SELECT response
        FROM reminder_confirmations
        WHERE appointment_id = a.id
        ORDER BY responded_at DESC NULLS LAST
        LIMIT 1
      ) rc ON true
      WHERE a.appointment_date = $1 ${branchFilter}
      ORDER BY d.name, a.appointment_time
      `,
      params
    );

    const head = await clinicHeader(req, hospitalId);
    const all = r.rows;
    const active = all.filter(x => x.status !== 'cancelled');
    const cancelled = all.length - active.length;

    // For a future day, how many of the still-live appointments has the patient
    // actually confirmed?
    const confirmable = active.filter(x => x.status === 'confirmed');
    const confirmedCount = confirmable.filter(x => isConfirmedReply(x.reminder_response)).length;
    const toCall = confirmable.length - confirmedCount;

    let subtitle = `${prettyDate(date)}   ·   ${active.length} appointment${active.length === 1 ? '' : 's'}`;
    if (cancelled) subtitle += `   ·   ${cancelled} cancelled`;
    if (isFuture && confirmable.length) {
      subtitle += `   ·   ${confirmedCount} confirmed, ${toCall} to call`;
    }

    const columns = [
      { key: 'time', label: 'Time', width: 5 },
      { key: 'patient', label: 'Patient', width: 15 },
      { key: 'phone', label: 'Phone', width: 10 },
      { key: 'treatment', label: 'Treatment', width: 11 },
      { key: 'visit', label: 'Visit #', width: 5, align: 'right' },
      { key: 'status', label: 'Status', width: 7 },
    ];
    if (isFuture) columns.push({ key: 'reminder', label: 'Confirmed?', width: 10 });

    streamReport(
      res,
      {
        ...head,
        title: date === today ? "Today's Schedule" : 'Appointment Schedule',
        subtitle,
        filename: `schedule-${date}`,
      },
      doc => {
        if (!all.length) {
          doc.font('body').fontSize(11).fillColor('#666').text('No appointments on this day.');
          return;
        }
        const byDoctor = {};
        for (const x of all) (byDoctor[x.doctor_name] = byDoctor[x.doctor_name] || []).push(x);
        Object.keys(byDoctor)
          .sort()
          .forEach((docName, idx) => {
            if (idx) doc.moveDown(0.8);
            doc.font('bold').fontSize(11).fillColor('#000').text(`Dr. ${docName}`);
            doc.moveDown(0.3);
            drawTable(
              doc,
              columns,
              byDoctor[docName].map(x => {
                const row = {
                  time: (x.appointment_time || '').slice(0, 5) || '—',
                  patient: x.patient_name || '—',
                  phone: x.patient_phone || '—',
                  treatment: x.department_name || 'General',
                  visit: x.visit_count == null ? '—' : String(x.visit_count),
                  status: x.status,
                };
                if (isFuture) {
                  row.reminder =
                    x.status !== 'confirmed'
                      ? '—'
                      : isConfirmedReply(x.reminder_response)
                        ? 'yes'
                        : x.reminder_response
                          ? `replied "${x.reminder_response}"`
                          : x.reminder_24h_sent
                            ? 'CALL — no reply'
                            : 'CALL — not sent';
                }
                return row;
              })
            );
          });
      }
    );
  } catch (err) {
    if (!res.headersSent) handleError(res, err);
  }
});

// ── MONEY OWED ────────────────────────────────────────────────
// The "who owes us" worklist the product never had. Two streams, kept apart the
// same way day-close keeps them apart: a per-visit consultation fee marked
// unpaid, and a treatment course billed as a whole with a balance outstanding.
router.get('/reports/dues.pdf', async (req, res) => {
  try {
    const s = req.tenant.schema_name;

    const [plansR, visitsR] = await Promise.all([
      // Treatment balances. estimated_cost 0/unset means "no quote yet" — not a
      // debt — so it's excluded. status filters to live courses; a cancelled or
      // completed plan is not an open receivable.
      tenantQuery(s, `
        SELECT p.name AS patient_name, p.phone AS patient_phone,
               COALESCE(NULLIF(tp.title,''), dep.name, 'Treatment') AS treatment,
               COALESCE(dt.name, da.name) AS dentist,
               tp.estimated_cost::int AS estimated_cost,
               COALESCE(pay.paid, 0)::int AS paid,
               (tp.estimated_cost - COALESCE(pay.paid, 0))::int AS balance,
               lastvis.d::text AS last_visit,
               -- Same test as withProgress()/derivePlanStatus (utils/treatmentPlan.js),
               -- which the Treatment Plans tab and the stalled-treatment worklist
               -- use, so the two "stalled" lists agree: work actually STARTED (a
               -- completed visit — done_n > 0, not just a no-show), nothing is
               -- booked ahead, and the last sitting was 30+ days ago.
               (lastvis.done_n > 0
                 AND lastvis.d IS NOT NULL
                 AND lastvis.d < ${IST_TODAY_SQL} - INTERVAL '30 days'
                 AND next_up.d IS NULL) AS stalled
        FROM treatment_plans tp
        JOIN patients p ON p.id = tp.patient_id AND p.deleted_at IS NULL
        LEFT JOIN departments dep ON dep.id = tp.department_id
        LEFT JOIN doctors dt ON dt.id = tp.treating_doctor_id
        LEFT JOIN doctors da ON da.id = tp.advised_by_doctor_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(amount), 0) AS paid
          FROM treatment_payments WHERE treatment_plan_id = tp.id
        ) pay ON TRUE
        LEFT JOIN LATERAL (
          SELECT MAX(appointment_date) FILTER (WHERE status IN ('completed','no_show')) AS d,
                 COUNT(*) FILTER (WHERE status = 'completed') AS done_n
          FROM appointments WHERE treatment_plan_id = tp.id
        ) lastvis ON TRUE
        LEFT JOIN LATERAL (
          SELECT MIN(appointment_date) AS d
          FROM appointments WHERE treatment_plan_id = tp.id AND status = 'confirmed'
            AND appointment_date >= ${IST_TODAY_SQL}
        ) next_up ON TRUE
        WHERE tp.status IN ('proposed','in_progress')
          AND tp.estimated_cost > 0
          AND tp.estimated_cost - COALESCE(pay.paid, 0) > 0
        ORDER BY balance DESC
      `),
      // Completed visits whose consultation fee is still pending (the column
      // default). Bounded to a year: a two-year-old unpaid visit is not
      // collectible and only clutters the list the desk actually works.
      // Treatment-course sittings are excluded UNLESS they carry an explicit
      // per-visit fee (effective_fee > 0): a course is billed as a whole on the
      // treatment-balance list above, and falling back to the doctor's
      // consultation_fee for every root-canal sitting would invent a debt and
      // list the same patient twice.
      tenantQuery(s, `
        SELECT a.appointment_date::text AS appointment_date,
               p.name AS patient_name, p.phone AS patient_phone,
               d.name AS dentist,
               COALESCE(NULLIF(a.effective_fee, 0), d.consultation_fee, 0)::int AS fee
        FROM appointments a
        JOIN patients p ON p.id = a.patient_id AND p.deleted_at IS NULL
        LEFT JOIN doctors d ON d.id = a.doctor_id
        WHERE a.status = 'completed'
          AND (a.payment_status IS NULL OR a.payment_status = 'pending')
          AND (a.treatment_plan_id IS NULL OR NULLIF(a.effective_fee, 0) IS NOT NULL)
          AND a.appointment_date >= ${IST_TODAY_SQL} - INTERVAL '365 days'
        ORDER BY a.appointment_date
      `),
    ]);

    const head = await clinicHeader(req, null);
    const planRows = plansR.rows;
    const visitRows = visitsR.rows;
    const treatmentOwed = planRows.reduce((n, r) => n + (r.balance || 0), 0);
    const feesOwed = visitRows.reduce((n, r) => n + (r.fee || 0), 0);

    streamReport(res, {
      ...head,
      title: 'Money Owed',
      subtitle: `${rupees(treatmentOwed + feesOwed)} outstanding` +
        `   ·   ${rupees(feesOwed)} in visit fees, ${rupees(treatmentOwed)} in treatment balances`,
      filename: `dues-${istToday()}`,
    }, doc => {
      doc.font('bold').fontSize(11).fillColor('#000').text('Treatment balances');
      doc.moveDown(0.3);
      if (planRows.length) {
        drawTable(doc, [
          { key: 'patient', label: 'Patient', width: 13 },
          { key: 'phone', label: 'Phone', width: 9 },
          { key: 'treatment', label: 'Treatment', width: 12 },
          { key: 'dentist', label: 'Dentist', width: 10 },
          { key: 'est', label: 'Estimate', width: 7, align: 'right' },
          { key: 'paid', label: 'Paid', width: 7, align: 'right' },
          { key: 'balance', label: 'Balance', width: 7, align: 'right' },
          { key: 'last', label: 'Last visit', width: 8 },
        ], planRows.map(r => ({
          patient: r.patient_name || '—',
          phone: r.patient_phone || '—',
          treatment: r.treatment,
          dentist: r.dentist ? `Dr. ${r.dentist}` : '—',
          est: rupees(r.estimated_cost),
          paid: rupees(r.paid),
          balance: rupees(r.balance) + (r.stalled ? ' *' : ''),
          last: r.last_visit || '—',
        })));
        if (planRows.some(r => r.stalled)) {
          doc.font('body').fontSize(8).fillColor('#777')
            .text('*  stalled — work started, nothing booked, last sitting over 30 days ago.');
        }
        doc.moveDown(0.6);
      } else {
        doc.font('body').fontSize(10).fillColor('#666').text('No treatment balances outstanding.');
        doc.moveDown(0.8);
      }

      doc.font('bold').fontSize(11).fillColor('#000').text('Unpaid completed visits (consultation fees)');
      doc.moveDown(0.3);
      if (visitRows.length) {
        drawTable(doc, [
          { key: 'date', label: 'Date', width: 8 },
          { key: 'patient', label: 'Patient', width: 16 },
          { key: 'phone', label: 'Phone', width: 10 },
          { key: 'dentist', label: 'Dentist', width: 12 },
          { key: 'fee', label: 'Fee', width: 7, align: 'right' },
        ], visitRows.map(r => ({
          date: r.appointment_date,
          patient: r.patient_name || '—',
          phone: r.patient_phone || '—',
          dentist: r.dentist ? `Dr. ${r.dentist}` : '—',
          fee: rupees(r.fee),
        })));
      } else {
        doc.font('body').fontSize(10).fillColor('#666').text('Every completed visit is marked paid or waived.');
      }
    });
  } catch (err) {
    if (!res.headersSent) handleError(res, err);
  }
});

// ── CHECK-UP CALL-LIST ───────────────────────────────────────
// Recalls due now and in the next 45 days, plus a "already nudged, no reply"
// column so the desk can phone the ones WhatsApp couldn't bring back.
router.get('/reports/recalls.pdf', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      SELECT rc.due_date::text AS due_date, rc.reason, rc.send_count::int AS send_count,
             rc.last_sent_at,
             p.name AS patient_name, p.phone AS patient_phone, p.opted_out,
             (rc.due_date <= ${IST_TODAY_SQL}) AS overdue,
             lastv.d::text AS last_visit
      FROM patient_recalls rc
      JOIN patients p ON p.id = rc.patient_id AND p.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT MAX(appointment_date) AS d
        FROM appointments WHERE patient_id = rc.patient_id AND status = 'completed'
      ) lastv ON TRUE
      WHERE rc.status = 'due'
        AND rc.due_date <= ${IST_TODAY_SQL} + INTERVAL '45 days'
      ORDER BY rc.due_date
    `);
    const head = await clinicHeader(req, null);
    const rows = r.rows;
    const overdue = rows.filter(x => x.overdue).length;
    const nudgedNoReply = rows.filter(x => (x.send_count || 0) > 0).length;

    streamReport(res, {
      ...head,
      title: 'Check-up Call-list',
      subtitle: `${rows.length} due in the next 45 days` +
        (overdue ? `   ·   ${overdue} overdue` : '') +
        (nudgedNoReply ? `   ·   ${nudgedNoReply} already messaged, no booking` : ''),
      filename: `recalls-${istToday()}`,
    }, doc => {
      if (!rows.length) {
        doc.font('body').fontSize(11).fillColor('#666').text('Nobody is due for a check-up in the next 45 days.');
        return;
      }
      drawTable(doc, [
        { key: 'due', label: 'Due', width: 8 },
        { key: 'patient', label: 'Patient', width: 15 },
        { key: 'phone', label: 'Phone', width: 10 },
        { key: 'reason', label: 'For', width: 12 },
        { key: 'last', label: 'Last visit', width: 8 },
        { key: 'nudged', label: 'Messaged', width: 8 },
      ], rows.map(x => ({
        due: (x.overdue ? 'OVERDUE ' : '') + x.due_date,
        patient: x.patient_name || '—',
        phone: x.opted_out ? `${x.patient_phone || '—'} (opted out)` : (x.patient_phone || '—'),
        reason: x.reason || 'Check-up',
        last: x.last_visit || '—',
        nudged: x.send_count ? `${x.send_count}×` : '—',
      })));
    });
  } catch (err) {
    if (!res.headersSent) handleError(res, err);
  }
});

// ── LAB REGISTER ─────────────────────────────────────────────
// Crowns / dentures still out at the lab, soonest-due first, overdue flagged.
router.get('/reports/lab-works.pdf', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      SELECT lw.expected_date::text AS expected_date, lw.sent_date::text AS sent_date,
             lw.item, lw.lab_name, lw.status,
             p.name AS patient_name, p.phone AS patient_phone,
             tp.title AS treatment,
             (lw.expected_date IS NOT NULL AND lw.expected_date < ${IST_TODAY_SQL}) AS overdue
      FROM lab_works lw
      LEFT JOIN patients p ON p.id = lw.patient_id
      LEFT JOIN treatment_plans tp ON tp.id = lw.treatment_plan_id
      WHERE lw.status IN ('pending','sent')
      ORDER BY lw.expected_date NULLS LAST, lw.created_at
    `);
    const head = await clinicHeader(req, null);
    const rows = r.rows;
    const overdue = rows.filter(x => x.overdue).length;

    streamReport(res, {
      ...head,
      title: 'Lab Register',
      subtitle: `${rows.length} item${rows.length === 1 ? '' : 's'} out at the lab` +
        (overdue ? `   ·   ${overdue} overdue` : ''),
      filename: `lab-works-${istToday()}`,
    }, doc => {
      if (!rows.length) {
        doc.font('body').fontSize(11).fillColor('#666').text('Nothing is out at the lab.');
        return;
      }
      drawTable(doc, [
        { key: 'due', label: 'Expected', width: 9 },
        { key: 'item', label: 'Item', width: 12 },
        { key: 'lab', label: 'Lab', width: 10 },
        { key: 'patient', label: 'Patient', width: 13 },
        { key: 'phone', label: 'Phone', width: 10 },
        { key: 'sent', label: 'Sent', width: 8 },
        { key: 'status', label: 'Status', width: 7 },
      ], rows.map(x => ({
        due: x.expected_date ? (x.overdue ? 'OVERDUE ' : '') + x.expected_date : '—',
        item: x.item || '—',
        lab: x.lab_name || '—',
        patient: x.patient_name || '—',
        phone: x.patient_phone || '—',
        sent: x.sent_date || '—',
        status: x.status,
      })));
    });
  } catch (err) {
    if (!res.headersSent) handleError(res, err);
  }
});

// ── DENTIST ACTIVITY ─────────────────────────────────────────
// Per dentist over a period — the reconciliation an associate is paid against.
router.get('/reports/dentist-activity.pdf', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const range = parseRange(req);
    if (range.error) return res.status(400).json({ error: range.error });
    const { from, to } = range;

    const r = await tenantQuery(s, `
      SELECT d.name AS dentist,
             COUNT(a.id) FILTER (WHERE a.status IN ('completed','confirmed'))::int AS seen,
             COUNT(a.id) FILTER (WHERE a.status = 'completed')::int AS completed,
             COUNT(a.id) FILTER (WHERE a.status = 'no_show')::int AS no_show,
             COALESCE(SUM(COALESCE(NULLIF(a.effective_fee,0), d.consultation_fee))
                        FILTER (WHERE a.status = 'completed'), 0)::int AS fees,
             adv.n_advised::int AS advised,
             fb.avg_rating AS avg_rating,
             fb.n_rated::int AS n_rated
      FROM doctors d
      LEFT JOIN appointments a ON a.doctor_id = d.id
        AND a.appointment_date BETWEEN $1 AND $2
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS n_advised FROM treatment_plans tp
        WHERE tp.advised_by_doctor_id = d.id
          AND (tp.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1 AND $2
      ) adv ON TRUE
      LEFT JOIN LATERAL (
        SELECT ROUND(AVG(af.rating), 1) AS avg_rating, COUNT(*) AS n_rated
        FROM appointment_feedback af
        JOIN appointments aa ON aa.id = af.appointment_id
        WHERE aa.doctor_id = d.id
          AND (af.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1 AND $2
      ) fb ON TRUE
      WHERE d.is_active = true
      GROUP BY d.id, d.name, adv.n_advised, fb.avg_rating, fb.n_rated
      ORDER BY completed DESC, seen DESC
    `, [from, to]);
    const head = await clinicHeader(req, null);
    const rows = r.rows;

    streamReport(res, {
      ...head,
      title: 'Dentist Activity',
      subtitle: rangeLabel(from, to),
      filename: `dentist-activity-${from}_${to}`,
    }, doc => {
      if (!rows.length) {
        doc.font('body').fontSize(11).fillColor('#666').text('No active dentists.');
        return;
      }
      drawTable(doc, [
        { key: 'dentist', label: 'Dentist', width: 16 },
        { key: 'seen', label: 'Seen', width: 6, align: 'right' },
        { key: 'completed', label: 'Completed', width: 7, align: 'right' },
        { key: 'no_show', label: 'No-show', width: 6, align: 'right' },
        { key: 'fees', label: 'Consultation fees', width: 10, align: 'right' },
        { key: 'advised', label: 'Advised', width: 6, align: 'right' },
        { key: 'rating', label: 'Rating', width: 7, align: 'right' },
      ], rows.map(x => ({
        dentist: `Dr. ${x.dentist}`,
        seen: String(x.seen),
        completed: String(x.completed),
        no_show: String(x.no_show),
        fees: rupees(x.fees),
        advised: String(x.advised || 0),
        rating: x.avg_rating != null ? `${x.avg_rating} (${x.n_rated})` : '—',
      })));
      doc.font('body').fontSize(8).fillColor('#777').text(
        'Consultation fees only — treatment-payment revenue is billed against the course, not the dentist. ' +
        'Rating: mean of 1–5 feedback in the period, with the number of ratings in brackets.'
      );
    });
  } catch (err) {
    if (!res.headersSent) handleError(res, err);
  }
});

// ── PERIOD / MONTH-END SUMMARY ───────────────────────────────
// The owner-and-accountant page: money collected by method, the appointment
// mix, new patients, and revenue split by dentist and by treatment — the same
// expressions day-close and the analytics queries use, over an arbitrary range.
router.get('/reports/period.pdf', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const range = parseRange(req);
    if (range.error) return res.status(400).json({ error: range.error });
    const { from, to } = range;
    const FEE = `COALESCE(NULLIF(a.effective_fee, 0), d.consultation_fee)`;

    const [apptR, consultR, treatR, patientsR, byDoctorR, byTreatmentR, funnelR] = await Promise.all([
      tenantQuery(s, `
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status='completed')::int AS completed,
               COUNT(*) FILTER (WHERE status='no_show')::int   AS no_show,
               COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled
        FROM appointments WHERE appointment_date BETWEEN $1 AND $2
      `, [from, to]),
      tenantQuery(s, `
        SELECT COALESCE(a.payment_method,'cash') AS method,
               COUNT(*)::int AS count,
               COALESCE(SUM(${FEE}),0)::int AS amount
        FROM appointments a LEFT JOIN doctors d ON d.id=a.doctor_id
        WHERE a.appointment_date BETWEEN $1 AND $2
          AND a.status='completed' AND a.payment_status='paid'
        GROUP BY COALESCE(a.payment_method,'cash') ORDER BY amount DESC
      `, [from, to]),
      tenantQuery(s, `
        SELECT method, COUNT(*)::int AS count, COALESCE(SUM(amount),0)::int AS amount
        FROM treatment_payments
        WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1 AND $2
        GROUP BY method ORDER BY amount DESC
      `, [from, to]),
      tenantQuery(s, `
        SELECT COUNT(*)::int AS new_patients
        FROM patients
        WHERE deleted_at IS NULL
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1 AND $2
      `, [from, to]),
      tenantQuery(s, `
        SELECT d.name AS dentist,
               COUNT(*) FILTER (WHERE a.status='completed')::int AS completed,
               COALESCE(SUM(${FEE}) FILTER (WHERE a.status='completed'),0)::int AS fees
        FROM appointments a JOIN doctors d ON d.id=a.doctor_id
        WHERE a.appointment_date BETWEEN $1 AND $2 AND a.status IN ('completed','confirmed')
        GROUP BY d.name ORDER BY fees DESC
      `, [from, to]),
      tenantQuery(s, `
        SELECT COALESCE(dep.name,'General') AS treatment,
               COUNT(*) FILTER (WHERE a.status='completed')::int AS completed,
               COALESCE(SUM(${FEE}) FILTER (WHERE a.status='completed'),0)::int AS fees
        FROM appointments a
        JOIN doctors d ON d.id=a.doctor_id
        LEFT JOIN departments dep ON dep.id=COALESCE(a.department_id, d.department_id)
        WHERE a.appointment_date BETWEEN $1 AND $2 AND a.status IN ('completed','confirmed')
        GROUP BY COALESCE(dep.name,'General') ORDER BY fees DESC
      `, [from, to]),
      tenantQuery(s, `
        SELECT COUNT(*)::int AS advised,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM appointments a
                  WHERE a.treatment_plan_id = tp.id AND a.status <> 'cancelled'))::int AS booked
        FROM treatment_plans tp
        WHERE tp.status <> 'cancelled'
          AND (tp.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1 AND $2
      `, [from, to]),
    ]);

    const head = await clinicHeader(req, null);
    const ap = apptR.rows[0] || {};
    const consultRows = consultR.rows;
    const treatRows = treatR.rows;
    const consultTotal = consultRows.reduce((n, r) => n + r.amount, 0);
    const treatTotal = treatRows.reduce((n, r) => n + r.amount, 0);
    const fn = funnelR.rows[0] || {};

    const METHOD_LABELS = {
      cash: 'Cash', card: 'Card', upi: 'UPI',
      bank_transfer: 'Bank transfer', cheque: 'Cheque', other: 'Other',
    };

    streamReport(res, {
      ...head,
      title: 'Period Summary',
      subtitle: rangeLabel(from, to),
      filename: `period-${from}_${to}`,
    }, doc => {
      doc.font('bold').fontSize(14).fillColor('#000')
        .text(`Collected: ${rupees(consultTotal + treatTotal)}`);
      doc.moveDown(0.2);
      doc.font('body').fontSize(9).fillColor('#555').text(
        `${rupees(consultTotal)} in consultation fees marked paid, plus ${rupees(treatTotal)} in treatment payments. The two streams are added once.`
      );
      doc.moveDown(1);

      doc.font('bold').fontSize(11).fillColor('#000').text('Appointments');
      doc.moveDown(0.3);
      kv(doc, 'Booked', String(ap.total ?? 0));
      kv(doc, 'Completed', String(ap.completed ?? 0));
      kv(doc, 'No-show', String(ap.no_show ?? 0));
      kv(doc, 'Cancelled', String(ap.cancelled ?? 0));
      doc.moveDown(0.3);
      kv(doc, 'New patients', String(patientsR.rows[0]?.new_patients ?? 0));
      kv(doc, 'Treatments advised', String(fn.advised ?? 0));
      kv(doc, '  of those, a visit booked', String(fn.booked ?? 0));
      doc.moveDown(1);

      const methodTable = (rows, total) => drawTable(doc, [
        { key: 'method', label: 'Method', width: 12 },
        { key: 'count', label: 'Payments', width: 8, align: 'right' },
        { key: 'amount', label: 'Amount', width: 10, align: 'right' },
      ], rows.map(m => ({
        method: METHOD_LABELS[m.method] || m.method,
        count: String(m.count),
        amount: rupees(m.amount),
      })).concat([{ method: 'Total', count: '', amount: rupees(total) }]));

      doc.font('bold').fontSize(11).fillColor('#000').text('Consultation fees by method (marked paid)');
      doc.moveDown(0.3);
      if (consultRows.length) methodTable(consultRows, consultTotal);
      else { doc.font('body').fontSize(10).fillColor('#666').text('None marked paid in this period.'); doc.moveDown(0.6); }
      doc.moveDown(0.4);

      doc.font('bold').fontSize(11).fillColor('#000').text('Treatment payments by method');
      doc.moveDown(0.3);
      if (treatRows.length) methodTable(treatRows, treatTotal);
      else { doc.font('body').fontSize(10).fillColor('#666').text('No treatment payments in this period.'); doc.moveDown(0.6); }
      doc.moveDown(0.4);

      if (byDoctorR.rows.length) {
        doc.font('bold').fontSize(11).fillColor('#000').text('By dentist (consultation)');
        doc.moveDown(0.3);
        drawTable(doc, [
          { key: 'dentist', label: 'Dentist', width: 16 },
          { key: 'completed', label: 'Completed', width: 8, align: 'right' },
          { key: 'fees', label: 'Consultation fees', width: 10, align: 'right' },
        ], byDoctorR.rows.map(x => ({
          dentist: `Dr. ${x.dentist}`, completed: String(x.completed), fees: rupees(x.fees),
        })));
        doc.moveDown(0.4);
      }

      if (byTreatmentR.rows.length) {
        doc.font('bold').fontSize(11).fillColor('#000').text('By treatment (consultation)');
        doc.moveDown(0.3);
        drawTable(doc, [
          { key: 'treatment', label: 'Treatment', width: 16 },
          { key: 'completed', label: 'Completed', width: 8, align: 'right' },
          { key: 'fees', label: 'Consultation fees', width: 10, align: 'right' },
        ], byTreatmentR.rows.map(x => ({
          treatment: x.treatment, completed: String(x.completed), fees: rupees(x.fees),
        })));
      }

      if (byDoctorR.rows.length || byTreatmentR.rows.length) {
        doc.moveDown(0.3);
        doc.font('body').fontSize(8).fillColor('#777').text(
          'Fees here are consultation fees on every COMPLETED visit in the period, whether or not the fee is '
          + 'marked paid yet — a workload split, not a collections split. The "Collected" figure at the top counts '
          + 'only fees actually marked paid; the gap is what the desk still has to reconcile.'
        );
        doc.fillColor('#000');
      }
    });
  } catch (err) {
    if (!res.headersSent) handleError(res, err);
  }
});

module.exports = router;
