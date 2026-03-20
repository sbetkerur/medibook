'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { tenantQuery, query } = require('../db');
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');

router.use(authMiddleware, tenantMiddleware);

const { LIMITS, handleError } = require('../utils/errors');
const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000, max: LIMITS.ANALYTICS_RATE_LIMIT_PER_MIN,
  keyGenerator: (req) => req.user?.id || req.ip, // per-user, not per-IP
  message: { error: 'Too many analytics requests. Slow down.' },
  standardHeaders: true,
});

// ── MAIN ANALYTICS ────────────────────────────────────────────
router.get('/analytics', analyticsLimiter, async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const d = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const [byDay, byDoctor, byStatus, byDept] = await Promise.all([
      tenantQuery(s, `
        SELECT appointment_date::text as date, COUNT(*) as count
        FROM appointments WHERE appointment_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
        GROUP BY appointment_date ORDER BY appointment_date
      `, [d]),
      tenantQuery(s, `
        SELECT d.name, COUNT(a.id) as count, SUM(d.consultation_fee) as revenue, d.no_show_score
        FROM appointments a JOIN doctors d ON d.id=a.doctor_id
        WHERE a.created_at >= NOW() - ($1 || ' days')::INTERVAL AND a.status='confirmed'
        GROUP BY d.name, d.no_show_score ORDER BY count DESC LIMIT 10
      `, [d]),
      tenantQuery(s, `
        SELECT status, COUNT(*) as count FROM appointments
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL GROUP BY status
      `, [d]),
      tenantQuery(s, `
        SELECT dep.name, COUNT(a.id) as count FROM appointments a
        JOIN doctors d ON d.id=a.doctor_id
        LEFT JOIN departments dep ON dep.id=d.department_id
        WHERE a.created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY dep.name ORDER BY count DESC
      `, [d]),
    ]);
    res.json({ by_day: byDay.rows, by_doctor: byDoctor.rows, by_status: byStatus.rows, by_department: byDept.rows });
  } catch (err) { handleError(res, err); }
});

// ── ANALYTICS SUMMARY ─────────────────────────────────────────
router.get('/analytics/summary', analyticsLimiter, async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const d = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const [rev, noShow, total, feedbackAvg] = await Promise.allSettled([
      tenantQuery(s, `
        SELECT COALESCE(SUM(doc.consultation_fee), 0) as revenue
        FROM appointments a JOIN doctors doc ON doc.id=a.doctor_id
        WHERE a.status IN ('confirmed','completed') AND a.created_at >= NOW() - ($1 || ' days')::INTERVAL
      `, [d]),
      tenantQuery(s, `
        SELECT COUNT(*) FILTER (WHERE status='no_show') as no_show_count, COUNT(*) as total_count
        FROM appointments WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
      `, [d]),
      tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL`, [d]),
      tenantQuery(s, `SELECT ROUND(AVG(rating),1) as avg FROM appointment_feedback`),
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
router.get('/analytics/heatmap', analyticsLimiter, async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const d = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 90);
    const r = await tenantQuery(s, `
      SELECT
        EXTRACT(DOW FROM appointment_date)::int as day_of_week,
        EXTRACT(HOUR FROM appointment_time)::int as hour,
        COUNT(*) as count
      FROM appointments
      WHERE appointment_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
        AND status IN ('confirmed', 'completed')
      GROUP BY day_of_week, hour ORDER BY day_of_week, hour
    `, [d]);
    res.json({ heatmap: r.rows });
  } catch (err) { handleError(res, err); }
});

// ── REVENUE DASHBOARD (A6) ────────────────────────────────────
router.get('/analytics/revenue', analyticsLimiter, async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const months = Math.min(Math.max(parseInt(req.query.months) || 6, 1), 24);
    const [monthly, byTreatment, byDoctor] = await Promise.all([
      tenantQuery(s, `
        SELECT TO_CHAR(DATE_TRUNC('month', a.appointment_date), 'Mon YYYY') AS month,
               DATE_TRUNC('month', a.appointment_date) AS month_date,
               COUNT(*)::int AS appointments,
               COALESCE(SUM(d.consultation_fee), 0)::int AS revenue
        FROM appointments a JOIN doctors d ON d.id=a.doctor_id
        WHERE a.status IN ('confirmed','completed')
          AND a.appointment_date >= CURRENT_DATE - ($1 * INTERVAL '1 month')
        GROUP BY DATE_TRUNC('month', a.appointment_date)
        ORDER BY month_date
      `, [months]),
      tenantQuery(s, `
        SELECT dep.name AS category,
               COUNT(*)::int AS appointments,
               COALESCE(SUM(d.consultation_fee), 0)::int AS revenue
        FROM appointments a
        JOIN doctors d ON d.id=a.doctor_id
        LEFT JOIN departments dep ON dep.id=d.department_id
        WHERE a.status IN ('confirmed','completed')
          AND a.appointment_date >= CURRENT_DATE - ($1 * INTERVAL '1 month')
        GROUP BY dep.name ORDER BY revenue DESC
      `, [months]),
      tenantQuery(s, `
        SELECT d.name AS doctor_name,
               COALESCE(dep.name, d.specialization, 'General') AS specialization,
               COUNT(*)::int AS appointments,
               COALESCE(SUM(d.consultation_fee), 0)::int AS revenue
        FROM appointments a
        JOIN doctors d ON d.id=a.doctor_id
        LEFT JOIN departments dep ON dep.id=d.department_id
        WHERE a.status IN ('confirmed','completed')
          AND a.appointment_date >= CURRENT_DATE - ($1 * INTERVAL '1 month')
        GROUP BY d.name, dep.name, d.specialization
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
router.get('/analytics/noshowrisk', analyticsLimiter, async (req, res) => {
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
        AND a.appointment_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
      GROUP BY a.id, a.booking_id, a.appointment_date, a.appointment_time, d.name, p.name, p.phone
      ORDER BY no_show_rate DESC, a.appointment_date, a.appointment_time
    `);
    res.json({ appointments: r.rows });
  } catch (err) { handleError(res, err); }
});

// ── PATIENT COHORT ANALYSIS ───────────────────────────────────
router.get('/analytics/cohorts', analyticsLimiter, async (req, res) => {
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
        WHERE a.created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY COALESCE(p.patient_type, 'new')
      `, [d]),
      tenantQuery(s, `
        SELECT
          COUNT(DISTINCT CASE WHEN p.visit_count = 1 THEN p.id END)::int as new_patients,
          COUNT(DISTINCT CASE WHEN p.visit_count > 1 THEN p.id END)::int as returning_patients
        FROM patients p
        WHERE p.created_at >= NOW() - ($1 || ' days')::INTERVAL
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
router.get('/analytics/export', analyticsLimiter, async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const { format = 'csv', type = 'appointments', days = 30 } = req.query;
    const d = Math.min(Math.max(parseInt(days) || 30, 1), 365);

    let rows = [];
    let headers = [];
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
        WHERE a.created_at >= NOW() - ($1 || ' days')::INTERVAL
        ORDER BY a.appointment_date DESC, a.appointment_time DESC
        LIMIT 10000
      `, [d]);
      rows = r.rows;
      headers = ['Booking ID','Patient','Phone','Doctor','Hospital','Date','Time','Status','Type','Fee','Payment Status','Created At'];
      filename = `appointments_${d}d`;
    } else if (type === 'patients') {
      const r = await tenantQuery(s, `
        SELECT p.name, p.phone, p.email, p.gender,
               p.date_of_birth::text, p.visit_count,
               p.patient_type, p.created_at::text
        FROM patients p
        WHERE p.deleted_at IS NULL
        ORDER BY p.created_at DESC
        LIMIT 10000
      `);
      rows = r.rows;
      headers = ['Name','Phone','Email','Gender','Date of Birth','Total Visits','Type','Joined'];
      filename = `patients`;
    } else {
      return res.status(400).json({ error: 'Invalid type. Use: appointments, patients' });
    }

    if (format === 'csv') {
      const escape = (v) => {
        const s = String(v ?? '');
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csvLines = [
        headers.join(','),
        ...rows.map(r => Object.values(r).map(escape).join(',')),
      ];
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      return res.send(csvLines.join('\n'));
    }

    // JSON fallback
    res.json({ headers, rows, count: rows.length });
  } catch (err) { handleError(res, err); }
});

// ── GOOGLE SHEETS WEBHOOK PUSH ────────────────────────────────
router.post('/admin/settings/sheets-webhook', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.startsWith('https://')) {
      return res.status(400).json({ error: 'Invalid webhook URL — must be https://' });
    }
    // Store in tenant settings
    await query(
      `UPDATE tenants SET settings = settings || $1 WHERE id = $2`,
      [JSON.stringify({ google_sheets_webhook_url: url }), req.tenant.id]
    );
    res.json({ success: true, message: 'Google Sheets webhook URL saved' });
  } catch (err) { handleError(res, err); }
});

module.exports = router;
