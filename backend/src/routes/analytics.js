'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { tenantQuery } = require('../db');
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');

router.use(authMiddleware, tenantMiddleware);

const { LIMITS } = require('../utils/errors');
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
        SELECT d.name, COUNT(a.id) as count, SUM(d.consultation_fee) as revenue
        FROM appointments a JOIN doctors d ON d.id=a.doctor_id
        WHERE a.created_at >= NOW() - ($1 || ' days')::INTERVAL AND a.status='confirmed'
        GROUP BY d.name ORDER BY count DESC LIMIT 10
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ANALYTICS SUMMARY ─────────────────────────────────────────
router.get('/analytics/summary', analyticsLimiter, async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const d = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const [rev, noShow, total, waitlist, feedbackAvg] = await Promise.allSettled([
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
      tenantQuery(s, `SELECT COUNT(*) FROM waiting_list WHERE notified=false`),
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
      waiting_list_count: safeVal(waitlist, r => parseInt(r?.count) || 0) ?? 0,
      avg_feedback_rating: safeVal(feedbackAvg, r => r?.avg ? parseFloat(r.avg) : null),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
