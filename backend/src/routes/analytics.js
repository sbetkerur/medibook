'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { tenantQuery, query } = require('../db');
const { adminOnly } = require('./adminHelpers');

// Auth + tenant middleware applied once in index.js for /api/admin and /api/v1/admin

const { LIMITS, handleError } = require('../utils/errors');
const { IST_TODAY_SQL } = require('../utils/dateTz');
// One rateLimit() instance is ONE shared counter. Attaching a single instance
// to all seven analytics endpoints meant the Analytics tab — which fires three
// requests on every mount — exhausted the whole budget by its second visit
// inside a minute, and the dashboard showed "Failed to load analytics" with a
// 429 the user cannot distinguish from a server fault. Each endpoint gets its
// own bucket; the shared budget is what was wrong, not the limit itself.
const makeAnalyticsLimiter = () => rateLimit({
  windowMs: 60 * 1000, max: LIMITS.ANALYTICS_RATE_LIMIT_PER_MIN,
  keyGenerator: (req) => req.user?.id || req.ip, // per-user, not per-IP
  message: { error: 'Too many analytics requests. Slow down.' },
  standardHeaders: true,
});

// ── MAIN ANALYTICS ────────────────────────────────────────────
router.get('/analytics', makeAnalyticsLimiter(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const d = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    // Bounded at BOTH ends, like /analytics/summary and /analytics/revenue.
    // Without the upper bound, every FUTURE confirmed appointment (slots are
    // generated 60 days out) counted toward a chart labelled "(30 days)" — so
    // "Top Dentists (30 days)" silently included bookings for next month, and
    // its revenue figure double-counted them as money already taken, same as
    // the bug already fixed on the other two endpoints.
    const [byDay, byDoctor, byStatus, byDept] = await Promise.all([
      tenantQuery(s, `
        SELECT appointment_date::text as date, COUNT(*) as count
        FROM appointments WHERE appointment_date >= ${IST_TODAY_SQL} - ($1::text || ' days')::INTERVAL
          AND appointment_date <= ${IST_TODAY_SQL}
          AND status IN ('confirmed', 'completed')
        GROUP BY appointment_date ORDER BY appointment_date
      `, [d]),
      tenantQuery(s, `
        SELECT d.name, COUNT(a.id) as count, SUM(COALESCE(NULLIF(a.effective_fee, 0), d.consultation_fee)) as revenue
        FROM appointments a JOIN doctors d ON d.id=a.doctor_id
        WHERE a.appointment_date >= ${IST_TODAY_SQL} - ($1::text || ' days')::INTERVAL
          AND a.appointment_date <= ${IST_TODAY_SQL}
          AND a.status IN ('confirmed', 'completed')
        GROUP BY d.name ORDER BY count DESC LIMIT 10
      `, [d]),
      tenantQuery(s, `
        SELECT status, COUNT(*) as count FROM appointments
        WHERE appointment_date >= ${IST_TODAY_SQL} - ($1::text || ' days')::INTERVAL
          AND appointment_date <= ${IST_TODAY_SQL}
          AND status != 'cancelled' GROUP BY status
      `, [d]),
      tenantQuery(s, `
        SELECT COALESCE(dep.name, 'General') as name, COUNT(a.id) as count FROM appointments a
        JOIN doctors d ON d.id=a.doctor_id
        LEFT JOIN departments dep ON dep.id=COALESCE(a.department_id, d.department_id)
        WHERE a.appointment_date >= ${IST_TODAY_SQL} - ($1::text || ' days')::INTERVAL
          AND a.appointment_date <= ${IST_TODAY_SQL}
          AND a.status IN ('confirmed', 'completed')
        GROUP BY COALESCE(dep.name, 'General') ORDER BY count DESC
      `, [d]),
    ]);
    res.json({ by_day: byDay.rows, by_doctor: byDoctor.rows, by_status: byStatus.rows, by_department: byDept.rows });
  } catch (err) { handleError(res, err); }
});

// ── ANALYTICS SUMMARY ─────────────────────────────────────────
router.get('/analytics/summary', makeAnalyticsLimiter(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const d = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const [rev, noShow, total, feedbackAvg] = await Promise.allSettled([
      // Bounded at BOTH ends. These are "how did the last N days go?" figures —
      // the dashboard labels them "Revenue (30d)" and "% no-show". Without the
      // upper bound the window ran from N days ago to the end of the booking
      // horizon, so every future confirmed appointment (slots are generated 60
      // days out) counted as revenue already taken, and diluted the no-show rate
      // with appointments nobody could have missed yet.
      tenantQuery(s, `
        SELECT COALESCE(SUM(COALESCE(NULLIF(a.effective_fee, 0), doc.consultation_fee)), 0) as revenue
        FROM appointments a JOIN doctors doc ON doc.id=a.doctor_id
        WHERE a.status IN ('confirmed','completed')
          AND a.appointment_date >= ${IST_TODAY_SQL} - ($1::text || ' days')::INTERVAL
          AND a.appointment_date <= ${IST_TODAY_SQL}
      `, [d]),
      tenantQuery(s, `
        SELECT COUNT(*) FILTER (WHERE status='no_show') as no_show_count, COUNT(*) as total_count
        FROM appointments WHERE appointment_date >= ${IST_TODAY_SQL} - ($1::text || ' days')::INTERVAL
          AND appointment_date <= ${IST_TODAY_SQL}
          AND status != 'cancelled'
      `, [d]),
      tenantQuery(s, `SELECT COUNT(*) FROM appointments
         WHERE appointment_date >= ${IST_TODAY_SQL} - ($1::text || ' days')::INTERVAL
           AND appointment_date <= ${IST_TODAY_SQL} AND status != 'cancelled'`, [d]),
      tenantQuery(s, `SELECT ROUND(AVG(rating),1) as avg FROM appointment_feedback WHERE created_at >= NOW() - ($1::text || ' days')::INTERVAL`, [d]),
    ]);
    const safeVal = (r, fn) => r.status === 'fulfilled' ? fn(r.value.rows[0]) : null;
    const ns = noShow.status === 'fulfilled' ? noShow.value.rows[0] : null;
    const noShowRate = ns && parseInt(ns.total_count) > 0
      ? Math.round((parseInt(ns.no_show_count) / parseInt(ns.total_count)) * 100)
      : 0;
    res.json({
      revenue: safeVal(rev, r => parseInt(r?.revenue) || 0) ?? 0,
      no_show_rate: noShowRate,
      no_show_count: ns ? parseInt(ns.no_show_count) : 0,
      total_appointments: safeVal(total, r => parseInt(r?.count) || 0) ?? 0,
      avg_feedback_rating: safeVal(feedbackAvg, r => r?.avg ? parseFloat(r.avg) : null),
    });
  } catch (err) { handleError(res, err); }
});

// ── HEATMAP ───────────────────────────────────────────────────
router.get('/analytics/heatmap', makeAnalyticsLimiter(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const d = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 90);
    const r = await tenantQuery(s, `
      SELECT
        EXTRACT(DOW FROM appointment_date)::int as day_of_week,
        EXTRACT(HOUR FROM appointment_time)::int as hour,
        COUNT(*) as count
      FROM appointments
      WHERE appointment_date >= ${IST_TODAY_SQL} - ($1::text || ' days')::INTERVAL
        AND status IN ('confirmed', 'completed')
      GROUP BY day_of_week, hour ORDER BY day_of_week, hour
    `, [d]);
    res.json({ heatmap: r.rows });
  } catch (err) { handleError(res, err); }
});

// ── REVENUE DASHBOARD (A6) ────────────────────────────────────
// All three queries below are bounded at BOTH ends. Without the upper bound
// every confirmed FUTURE appointment counted as revenue already taken — and
// slots are generated 60 days ahead, so a clinic with 40 confirmed bookings
// next month saw that month appear as banked income and a total inflated by
// the same amount. /analytics/summary was fixed for exactly this and this
// endpoint — the one actually labelled "revenue" — was not, so the two figures
// on the same dashboard did not reconcile and the larger one was wrong.
router.get('/analytics/revenue', makeAnalyticsLimiter(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const months = Math.min(Math.max(parseInt(req.query.months) || 6, 1), 24);
    const [monthly, byTreatment, byDoctor] = await Promise.all([
      tenantQuery(s, `
        SELECT TO_CHAR(DATE_TRUNC('month', a.appointment_date), 'Mon YYYY') AS month,
               DATE_TRUNC('month', a.appointment_date) AS month_date,
               COUNT(*)::int AS appointments,
               COALESCE(SUM(COALESCE(NULLIF(a.effective_fee, 0), d.consultation_fee)), 0)::int AS revenue
        FROM appointments a JOIN doctors d ON d.id=a.doctor_id
        WHERE a.status IN ('confirmed','completed')
          AND a.appointment_date >= ${IST_TODAY_SQL} - ($1 * INTERVAL '1 month')
          AND a.appointment_date <= ${IST_TODAY_SQL}
        GROUP BY DATE_TRUNC('month', a.appointment_date)
        ORDER BY month_date
      `, [months]),
      tenantQuery(s, `
        SELECT COALESCE(dep.name, 'General') AS category,
               COUNT(*)::int AS appointments,
               COALESCE(SUM(COALESCE(NULLIF(a.effective_fee, 0), d.consultation_fee)), 0)::int AS revenue
        FROM appointments a
        JOIN doctors d ON d.id=a.doctor_id
        LEFT JOIN departments dep ON dep.id=COALESCE(a.department_id, d.department_id)
        WHERE a.status IN ('confirmed','completed')
          AND a.appointment_date >= ${IST_TODAY_SQL} - ($1 * INTERVAL '1 month')
          AND a.appointment_date <= ${IST_TODAY_SQL}
        GROUP BY COALESCE(dep.name, 'General') ORDER BY revenue DESC
      `, [months]),
      tenantQuery(s, `
        SELECT d.id AS doctor_id, d.name AS doctor_name,
               COALESCE(MAX(dep.name), d.specialization, 'General') AS specialization,
               COUNT(*)::int AS appointments,
               COALESCE(SUM(COALESCE(NULLIF(a.effective_fee, 0), d.consultation_fee)), 0)::int AS revenue
        FROM appointments a
        JOIN doctors d ON d.id=a.doctor_id
        LEFT JOIN departments dep ON dep.id=COALESCE(a.department_id, d.department_id)
        WHERE a.status IN ('confirmed','completed')
          AND a.appointment_date >= ${IST_TODAY_SQL} - ($1 * INTERVAL '1 month')
          AND a.appointment_date <= ${IST_TODAY_SQL}
        -- Grouped by doctor ONLY (not department): a doctor spanning several
        -- departments (CLAUDE.md's multi-department dentists) previously split
        -- into one row per department here, understating their true revenue
        -- and duplicating them in the ranking / React key.
        GROUP BY d.id, d.name, d.specialization
        ORDER BY revenue DESC LIMIT 10
      `, [months]),
    ]);
    const totalRevenue = monthly.rows.reduce((sum, r) => sum + r.revenue, 0);
    res.json({
      total_revenue: totalRevenue,
      months,
      monthly: monthly.rows,
      by_treatment: byTreatment.rows,
      by_doctor: byDoctor.rows,
    });
  } catch (err) { handleError(res, err); }
});

// ── NO-SHOW RISK SCORING ──────────────────────────────────────
router.get('/analytics/noshowrisk', makeAnalyticsLimiter(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    // Upcoming appointments with patient's historical no-show rate
    const r = await tenantQuery(s, `
      SELECT
        a.booking_id, a.appointment_date, a.appointment_time::text, a.id,
        d.name as doctor_name,
        p.name as patient_name, p.phone as patient_phone,
        COUNT(prev.id) FILTER (WHERE prev.status = 'no_show') as no_show_count,
        COUNT(prev.id) as total_past,
        CASE
          WHEN COUNT(prev.id) = 0 THEN 0
          ELSE ROUND(100.0 * COUNT(prev.id) FILTER (WHERE prev.status = 'no_show') / COUNT(prev.id))
        END as no_show_rate
      FROM appointments a
      JOIN patients p ON p.id = a.patient_id
      JOIN doctors d ON d.id = a.doctor_id
      LEFT JOIN appointments prev ON prev.patient_id = a.patient_id
        AND prev.appointment_date < a.appointment_date
        AND prev.status IN ('no_show', 'completed', 'cancelled')
      WHERE a.status = 'confirmed'
        AND a.appointment_date BETWEEN ${IST_TODAY_SQL} AND ${IST_TODAY_SQL} + INTERVAL '7 days'
      GROUP BY a.id, a.booking_id, a.appointment_date, a.appointment_time, d.name, p.name, p.phone
      ORDER BY no_show_rate DESC, a.appointment_date, a.appointment_time
    `);
    res.json({ appointments: r.rows });
  } catch (err) { handleError(res, err); }
});

// ── PATIENT COHORT ANALYSIS ───────────────────────────────────
router.get('/analytics/cohorts', makeAnalyticsLimiter(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const d = Math.min(Math.max(parseInt(req.query.days) || 90, 7), 365);
    const [cohortStats, newVsReturning, monthlyNew] = await Promise.all([
      tenantQuery(s, `
        SELECT
          COALESCE(p.patient_type, 'new') as patient_type,
          COUNT(DISTINCT a.patient_id)::int as patients,
          COUNT(a.id)::int as appointments,
          COUNT(a.id) FILTER (WHERE a.status = 'no_show')::int as no_shows,
          COUNT(a.id) FILTER (WHERE a.status = 'completed')::int as completed
        FROM appointments a
        JOIN patients p ON p.id = a.patient_id
        WHERE a.created_at >= NOW() - ($1::text || ' days')::INTERVAL
        GROUP BY COALESCE(p.patient_type, 'new')
      `, [d]),
      tenantQuery(s, `
        SELECT
          COUNT(DISTINCT CASE WHEN p.visit_count = 1 THEN p.id END)::int as new_patients,
          COUNT(DISTINCT CASE WHEN p.visit_count > 1 THEN p.id END)::int as returning_patients
        FROM patients p
        WHERE p.created_at >= NOW() - ($1::text || ' days')::INTERVAL
      `, [d]),
      tenantQuery(s, `
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') as month,
          COUNT(*) FILTER (WHERE visit_count = 1)::int as new_patients,
          COUNT(*) FILTER (WHERE visit_count > 1)::int as returning_patients
        FROM patients
        WHERE created_at >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY DATE_TRUNC('month', created_at)
      `),
    ]);
    res.json({
      by_type: cohortStats.rows,
      summary: newVsReturning.rows[0] || { new_patients: 0, returning_patients: 0 },
      monthly_cohorts: monthlyNew.rows,
      days: d,
    });
  } catch (err) { handleError(res, err); }
});

// ── DATA EXPORT ───────────────────────────────────────────────
// adminOnly: this is a bulk PHI extract — up to 10,000 rows of patient name,
// phone, gender and date of birth in a single request. Every other bulk
// or sensitive endpoint is admin-gated (audit logs, access logs, patient import,
// patient edit); this one was reachable by any 'staff' or 'doctor' login.
router.get('/analytics/export', adminOnly, makeAnalyticsLimiter(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const { format = 'csv', type = 'appointments', days = 30 } = req.query;
    // `days=all` lifts the window entirely. It exists for continuity, not
    // analysis: WhatsApp is the only channel this product has, so a clinic must
    // be able to walk away with its whole appointment book — not just the last
    // year of it — without asking us for a database dump.
    const allTime = String(days).toLowerCase() === 'all';
    const d = allTime ? null : Math.min(Math.max(parseInt(days) || 30, 1), 365);
    // Raised from 10,000 for the same reason. Still bounded: an unbounded
    // export is a way to take the API down with one request.
    const ROW_CAP = 50000;

    let rows = [];
    let headers = [];
    let keys = []; // explicit column order — avoids relying on Object.values() insertion order
    let filename = '';

    if (type === 'appointments') {
      const r = await tenantQuery(s, `
        SELECT a.booking_id, p.name as patient_name, p.phone as patient_phone,
               d.name as doctor_name, h.name as hospital_name,
               a.appointment_date::text, a.appointment_time::text,
               a.status, a.visit_type, a.effective_fee,
               a.payment_status, a.created_at::text
        FROM appointments a
        JOIN patients p ON p.id = a.patient_id
        JOIN doctors d ON d.id = a.doctor_id
        JOIN hospitals h ON h.id = a.hospital_id
        ${allTime ? '' : "WHERE a.created_at >= NOW() - ($1::text || ' days')::INTERVAL"}
        ORDER BY a.appointment_date DESC, a.appointment_time DESC
        LIMIT ${ROW_CAP}
      `, allTime ? [] : [d]);
      rows = r.rows;
      headers = ['Booking ID','Patient','Phone','Doctor','Hospital','Date','Time','Status','Type','Fee','Payment Status','Created At'];
      keys = ['booking_id','patient_name','patient_phone','doctor_name','hospital_name','appointment_date','appointment_time','status','visit_type','effective_fee','payment_status','created_at'];
      filename = allTime ? 'appointments_all' : `appointments_${d}d`;
    } else if (type === 'patients') {
      const r = await tenantQuery(s, `
        SELECT p.name, p.phone, p.gender,
               p.date_of_birth::text, p.visit_count,
               p.patient_type, p.created_at::text
        FROM patients p
        WHERE p.deleted_at IS NULL
        ORDER BY p.created_at DESC
        LIMIT ${ROW_CAP}
      `);
      rows = r.rows;
      headers = ['Name','Phone','Gender','Date of Birth','Total Visits','Type','Joined'];
      keys = ['name','phone','gender','date_of_birth','visit_count','patient_type','created_at'];
      filename = `patients`;
    } else if (type === 'treatments') {
      const r = await tenantQuery(s, `
        SELECT tp.title, tp.tooth_ref, p.name AS patient_name, p.phone AS patient_phone,
               -- The TREATING dentist, falling back to whoever advised it: the
               -- course is often handed to a visiting specialist, and it is the
               -- person doing the work the clinic needs on this list.
               COALESCE(dt.name, da.name) AS doctor_name,
               tp.status, tp.total_visits,
               COUNT(a.id) FILTER (WHERE a.status <> 'cancelled')::int AS booked_visits,
               COUNT(a.id) FILTER (WHERE a.status = 'completed')::int AS completed_visits,
               tp.estimated_cost, tp.created_at::text
        FROM treatment_plans tp
        JOIN patients p ON p.id = tp.patient_id
        LEFT JOIN doctors dt ON dt.id = tp.treating_doctor_id
        LEFT JOIN doctors da ON da.id = tp.advised_by_doctor_id
        LEFT JOIN appointments a ON a.treatment_plan_id = tp.id
        GROUP BY tp.id, p.name, p.phone, dt.name, da.name
        ORDER BY tp.created_at DESC
        LIMIT ${ROW_CAP}
      `);
      rows = r.rows;
      headers = ['Treatment','Tooth','Patient','Phone','Dentist','Status','Total Visits','Booked','Completed','Estimated Cost','Started'];
      keys = ['title','tooth_ref','patient_name','patient_phone','doctor_name','status','total_visits','booked_visits','completed_visits','estimated_cost','created_at'];
      filename = 'treatment_plans';
    } else {
      return res.status(400).json({ error: 'Invalid type. Use: appointments, patients, treatments' });
    }

    if (format === 'csv') {
      const escape = (v) => {
        let s = String(v ?? '');
        // Trim leading whitespace before formula-char check — " =foo" bypasses a
        // leading-char test but Excel still evaluates it as a formula after trimming.
        const trimmed = s.trimStart();
        if (trimmed.length > 0 && '=+-@\t\r'.includes(trimmed[0])) s = "'" + s;
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csvLines = [
        headers.join(','),
        ...rows.map(r => keys.map(k => escape(r[k])).join(',')),
      ];
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      return res.send(csvLines.join('\n'));
    }

    // JSON fallback
    res.json({ headers, rows, count: rows.length });
  } catch (err) { handleError(res, err); }
});

// (There was a POST /settings/sheets-webhook here. It is gone, along with the
// `google_sheets_export` feature flag that gated a push nobody wrote — see
// migration 27. Nothing read google_sheets_webhook_url, no dashboard screen
// called the route, and it was the one write into tenants.settings that bypassed
// the deliberate Joi allowlist on PATCH /settings: any https:// string of any
// length went straight in. That blob is loaded and cached by tenantMiddleware on
// EVERY request for the tenant and returned in full by GET /settings, so a
// multi-megabyte value there degrades every request the clinic makes. If the
// Sheets push is ever built, add the key to the updateSettings schema so there
// stays exactly one write path into settings.)

module.exports = router;
