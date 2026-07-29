'use strict';
/**
 * Tenant admin routes: dashboard, staff, settings, notifications, feedback,
 * onboarding, access/audit logs, queue stats, bot-session reset, direct
 * WhatsApp messaging and circuit-breaker reset.
 *
 * Appointments, doctors, hospitals/departments, patients, slots and leaves
 * live in their own route files (appointments.js, doctors.js, hospitals.js,
 * patients.js) which are mounted BEFORE this router in index.js. The old
 * duplicate copies of those routes that used to live here were unreachable
 * dead code and have been removed.
 *
 * Auth + tenant middleware are applied once in index.js for /api/admin and
 * /api/v1/admin — not re-applied here.
 */
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, tenantQuery } = require('../db');
const { validate, schemas } = require('../middleware/validate');
const { VALID_ROLES, UUID_RE, validateUUID, handleError } = require('../utils/errors');
const { adminOnly, writeAuditLog } = require('./adminHelpers');
const logger = require('../utils/logger');

// ── DASHBOARD STATS ───────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const tenantId = req.tenant.id;

    // Try stats cache first (valid if updated within 15 minutes)
    let cached = null;
    try {
      const cacheR = await query(`
        SELECT * FROM tenant_stats_cache
        WHERE tenant_id=$1 AND stat_date=CURRENT_DATE AND updated_at > NOW() - INTERVAL '15 minutes'
      `, [tenantId]);
      cached = cacheR.rows[0] || null;
    } catch (_) { /* cache miss */ }

    let statsData;
    if (cached) {
      statsData = {
        today_appointments: cached.appointments_today,
        total_patients: cached.patients_total,
        available_slots: cached.active_slots,
        appointments_month: cached.appointments_month,
      };
    }

    // Always run upcoming (time-sensitive) and today's schedule live
    const [upcoming, recentAppts, ...liveStats] = await Promise.allSettled([
      tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date>CURRENT_DATE AND status='confirmed'`),
      tenantQuery(s, `
        SELECT a.booking_id, a.appointment_date, a.appointment_time, a.status,
               p.name as patient_name, d.name as doctor_name
        FROM appointments a
        JOIN patients p ON p.id=a.patient_id
        JOIN doctors d ON d.id=a.doctor_id
        WHERE a.appointment_date=CURRENT_DATE
        ORDER BY a.appointment_time
        LIMIT 10
      `),
      // Only run heavy queries if cache miss
      ...(cached ? [] : [
        tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date=CURRENT_DATE AND status='confirmed'`),
        tenantQuery(s, `SELECT COUNT(*) FROM patients`),
        tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date>=CURRENT_DATE AND status='available'`),
        // IST month start — CURRENT_DATE is the UTC date, one day behind IST until 05:30
        tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')::date AND status IN ('confirmed','completed')`),
      ]),
    ]);

    const val = (r, field = 'count', fallback = null) =>
      r.status === 'fulfilled' ? (field === 'rows' ? r.value.rows : parseInt(r.value.rows[0]?.[field] ?? '0')) : fallback;

    if (!cached && liveStats.length >= 4) {
      statsData = {
        today_appointments: val(liveStats[0]),
        total_patients: val(liveStats[1]),
        available_slots: val(liveStats[2]),
        appointments_month: val(liveStats[3]),
      };
      // Async update cache (non-blocking)
      query(`
        INSERT INTO tenant_stats_cache (tenant_id, stat_date, appointments_today, appointments_month, patients_total, active_slots, updated_at)
        VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, NOW())
        ON CONFLICT (tenant_id, stat_date) DO UPDATE SET
          appointments_today=EXCLUDED.appointments_today, appointments_month=EXCLUDED.appointments_month,
          patients_total=EXCLUDED.patients_total, active_slots=EXCLUDED.active_slots, updated_at=NOW()
      `, [tenantId, statsData.today_appointments, statsData.appointments_month ?? 0, statsData.total_patients, statsData.available_slots])
        .catch(() => {});
    }

    // Log any rejected queries
    [upcoming, recentAppts, ...liveStats].forEach((r, i) => {
      if (r.status === 'rejected') logger.warn(`Dashboard query [${i}] failed`, { error: r.reason?.message });
    });

    res.json({
      today_appointments: statsData?.today_appointments ?? null,
      upcoming_appointments: val(upcoming),
      total_patients: statsData?.total_patients ?? null,
      available_slots: statsData?.available_slots ?? null,
      appointments_month: statsData?.appointments_month ?? null,
      todays_schedule: val(recentAppts, 'rows', []),
      cache_hit: !!cached,
    });
  } catch (err) { handleError(res, err); }
});

// ── STAFF ─────────────────────────────────────────────────────
router.get('/staff', async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT id, email, name, role, is_active, created_at FROM users ORDER BY created_at DESC`);
    res.json({ staff: r.rows });
  } catch (err) { handleError(res, err); }
});

router.post('/staff', adminOnly, validate(schemas.createStaff), async (req, res) => {
  try {
    const { name, email, password, role = 'staff' } = req.body;
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    const hash = await bcrypt.hash(password, 12);
    const r = await tenantQuery(req.tenant.schema_name,
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id,email,name,role,is_active,created_at`,
      [email.toLowerCase(), hash, name, role]);
    res.json({ staff: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    return handleError(res, err);
  }
});

router.patch('/staff/:id', adminOnly, validateUUID(), validate(schemas.updateStaff), async (req, res) => {
  try {
    const { name, email, password, role, is_active } = req.body;
    const updates = [];
    const params = [];
    if (name) { params.push(name); updates.push(`name=$${params.length}`); }
    if (email) { params.push(email.toLowerCase()); updates.push(`email=$${params.length}`); }
    if (password) { const h = await bcrypt.hash(password, 12); params.push(h); updates.push(`password_hash=$${params.length}`); }
    if (role && VALID_ROLES.includes(role)) { params.push(role); updates.push(`role=$${params.length}`); }
    if (typeof is_active === 'boolean') { params.push(is_active); updates.push(`is_active=$${params.length}`); }
    if (!updates.length) return res.json({ message: 'Nothing to update' });
    params.push(req.params.id);
    const r = await tenantQuery(req.tenant.schema_name,
      `UPDATE users SET ${updates.join(',')} WHERE id=$${params.length} RETURNING id,email,name,role,is_active`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Staff member not found' });

    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role,
      'UPDATE_STAFF', 'user', req.params.id, null, { role, is_active }, req.ip);

    res.json({ staff: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.delete('/staff/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });

    const targetR = await tenantQuery(req.tenant.schema_name,
      `SELECT role FROM users WHERE id=$1`, [req.params.id]);
    if (!targetR.rows[0]) return res.status(404).json({ error: 'Staff member not found' });

    if (targetR.rows[0].role === 'admin') {
      const adminCount = await tenantQuery(req.tenant.schema_name,
        `SELECT COUNT(*) FROM users WHERE role='admin' AND is_active=true AND id != $1`,
        [req.params.id]);
      if (parseInt(adminCount.rows[0].count) < 1) {
        return res.status(400).json({ error: 'Cannot deactivate the last admin account' });
      }
    }

    await tenantQuery(req.tenant.schema_name,
      `UPDATE users SET is_active=false WHERE id=$1`, [req.params.id]);

    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role,
      'DEACTIVATE_STAFF', 'user', req.params.id, null, null, req.ip);

    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── SETTINGS ──────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const t = req.tenant;
    const [hospR, planR, usageR, userR] = await Promise.allSettled([
      tenantQuery(t.schema_name, `SELECT * FROM hospitals LIMIT 1`),
      query(`SELECT * FROM plans WHERE id=$1`, [t.plan]),
      Promise.all([
        tenantQuery(t.schema_name, `SELECT COUNT(*) FROM doctors WHERE is_active=true`),
        tenantQuery(t.schema_name, `SELECT COUNT(*) FROM appointments WHERE created_at >= date_trunc('month', NOW())`),
      ]),
      tenantQuery(t.schema_name, `SELECT notify_phone FROM users WHERE id=$1`, [req.user.id]),
    ]);
    const hosp = hospR.status === 'fulfilled' ? (hospR.value.rows[0] || {}) : {};
    const planData = planR.status === 'fulfilled' ? planR.value.rows[0] : null;
    const [docCount, apptCount] = usageR.status === 'fulfilled' ? usageR.value : [null, null];
    const notifyPhone = userR.status === 'fulfilled' ? (userR.value.rows[0]?.notify_phone || '') : '';
    res.json({
      clinic_name: t.name,
      owner_email: t.owner_email,
      plan: t.plan,
      wa_configured: !!(process.env.META_PHONE_NUMBER_ID && process.env.META_ACCESS_TOKEN),
      notify_phone: notifyPhone,
      settings: t.settings || {},
      hospital: {
        address: hosp.address || '',
        city: hosp.city || '',
        phone: hosp.phone || '',
      },
      plan_limits: planData ? {
        name: planData.name,
        max_doctors: planData.max_doctors,
        max_appointments_per_month: planData.max_appointments_per_month,
        price_monthly: planData.price_monthly,
      } : null,
      usage: {
        active_doctors: docCount ? parseInt(docCount.rows[0].count) : null,
        appointments_this_month: apptCount ? parseInt(apptCount.rows[0].count) : null,
      },
    });
  } catch (err) { handleError(res, err); }
});

router.patch('/settings', adminOnly, validate(schemas.updateSettings), async (req, res) => {
  try {
    const { name, notification_prefs, notify_phone } = req.body;
    const updates = [];
    const params = [];
    if (name) { params.push(name); updates.push(`name=$${params.length}`); }
    if (notification_prefs) {
      params.push(JSON.stringify(notification_prefs));
      updates.push(`settings=settings || $${params.length}::jsonb`);
    }
    if (updates.length) {
      params.push(req.tenant.id);
      await query(`UPDATE tenants SET ${updates.join(',')} WHERE id=$${params.length}`, params);
    }
    if (notify_phone !== undefined) {
      const cleaned = notify_phone ? notify_phone.replace(/[+\s\-()]/g, '') : null;
      await tenantQuery(req.tenant.schema_name,
        `UPDATE users SET notify_phone=$1 WHERE id=$2`,
        [cleaned || null, req.user.id]);
    }

    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role,
      'UPDATE_SETTINGS', 'tenant', req.tenant.id,
      null, { name: !!name }, req.ip);

    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────
router.get('/notifications/recent', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s, `
      SELECT a.id, a.booking_id, a.created_at, a.appointment_date, a.appointment_time,
             p.name as patient_name, d.name as doctor_name
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      WHERE a.created_at >= NOW() - INTERVAL '5 minutes' AND a.status='confirmed'
      ORDER BY a.created_at DESC
      LIMIT 10
    `);
    res.json({ notifications: r.rows, count: r.rows.length });
  } catch (err) { handleError(res, err); }
});

// ── FEEDBACK ──────────────────────────────────────────────────
router.get('/feedback', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const { page = 1, limit = 25, doctor_id, min_rating, max_rating } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 25, 1), 100);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;
    if (doctor_id && !UUID_RE.test(doctor_id)) {
      return res.status(400).json({ error: 'Invalid doctor_id format' });
    }
    const where = ['1=1'];
    const params = [];
    if (doctor_id) { params.push(doctor_id); where.push(`a.doctor_id=$${params.length}`); }
    if (min_rating) { params.push(parseInt(min_rating)); where.push(`af.rating>=$${params.length}`); }
    if (max_rating) { params.push(parseInt(max_rating)); where.push(`af.rating<=$${params.length}`); }
    params.push(safeLimit, offset);
    const r = await tenantQuery(s, `
      SELECT af.*, p.name as patient_name, d.name as doctor_name,
             a.booking_id, a.appointment_date
      FROM appointment_feedback af
      JOIN patients p ON p.id=af.patient_id
      JOIN appointments a ON a.id=af.appointment_id
      JOIN doctors d ON d.id=a.doctor_id
      WHERE ${where.join(' AND ')}
      ORDER BY af.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    const [avgR, distR] = await Promise.all([
      tenantQuery(s, `SELECT ROUND(AVG(rating),1) as avg_rating, COUNT(*) as total FROM appointment_feedback`),
      tenantQuery(s, `SELECT rating, COUNT(*) as count FROM appointment_feedback GROUP BY rating ORDER BY rating DESC`),
    ]);
    res.json({
      feedback: r.rows,
      page: parseInt(page),
      has_more: offset + r.rows.length < parseInt(avgR.rows[0]?.total || 0),
      avg_rating: avgR.rows[0]?.avg_rating ? parseFloat(avgR.rows[0].avg_rating) : null,
      total: parseInt(avgR.rows[0]?.total || 0),
      distribution: distR.rows,
    });
  } catch (err) { handleError(res, err); }
});

// ── ONBOARDING ────────────────────────────────────────────────
router.get('/onboarding/status', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const [hospitalR, doctorR, slotR] = await Promise.all([
      tenantQuery(s, `SELECT COUNT(*) FROM hospitals WHERE is_active=true`),
      tenantQuery(s, `SELECT COUNT(*) FROM doctors WHERE is_active=true`),
      tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date >= CURRENT_DATE AND status='available'`),
    ]);
    const hospitals = parseInt(hospitalR.rows[0].count);
    const doctors = parseInt(doctorR.rows[0].count);
    const slots = parseInt(slotR.rows[0].count);
    const completed = req.tenant.onboarding_completed;
    const steps = [
      { id: 'hospital', label: 'Add your clinic/hospital', done: hospitals > 0 },
      { id: 'doctor', label: 'Add a doctor', done: doctors > 0 },
      { id: 'slots', label: 'Generate appointment slots', done: slots > 0 },
      { id: 'whatsapp', label: 'WhatsApp (shared — configured globally)', done: !!(process.env.META_PHONE_NUMBER_ID && process.env.META_ACCESS_TOKEN) },
    ];
    res.json({ steps, all_done: steps.every(s => s.done), onboarding_completed: completed });
  } catch (err) { handleError(res, err); }
});

router.post('/onboarding/complete', adminOnly, async (req, res) => {
  try {
    await query(`UPDATE tenants SET onboarding_completed=true WHERE id=$1`, [req.tenant.id]);
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── ACCESS LOGS ────────────────────────────────────────────────
router.get('/access-logs', adminOnly, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;
    const r = await query(`
      SELECT * FROM admin_access_logs
      WHERE tenant_id=$1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.tenant.id, safeLimit, offset]);
    res.json({ logs: r.rows });
  } catch (err) { handleError(res, err); }
});

// ── QUEUE STATS ───────────────────────────────────────────────
router.get('/queue/stats', adminOnly, async (req, res) => {
  try {
    const { getQueueStats } = require('../jobs/botWorker');
    const stats = await getQueueStats();
    res.json(stats);
  } catch (err) { handleError(res, err); }
});

// ── BOT SESSION MANAGEMENT ────────────────────────────────────
router.delete('/bot-sessions/:phone', adminOnly, async (req, res) => {
  try {
    const phone = req.params.phone.replace(/[^0-9+]/g, '');
    if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
    const existing = await tenantQuery(req.tenant.schema_name,
      `SELECT id FROM bot_sessions WHERE phone=$1`, [phone]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'No active session for that phone number' });
    // Reset through the sanctioned bot/utils.js helper (same encryption/upsert
    // path as every other session write) rather than a raw UPDATE.
    const { resetSessionToIdle } = require('../services/bot/utils');
    await resetSessionToIdle(req.tenant.schema_name, phone);
    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role, 'RESET_BOT_SESSION', 'bot_session', phone,
      null, null, req.ip);
    res.json({ success: true, message: `Bot session reset for ${phone}` });
  } catch (err) { handleError(res, err); }
});

// ── SEND WHATSAPP MESSAGE FROM DASHBOARD ──────────────────────
router.post('/messages/send', adminOnly, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });
    if (message.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' });
    if (!/^[0-9]{7,20}$/.test(phone.replace(/[+\s]/g, ''))) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    if (!process.env.META_PHONE_NUMBER_ID || !process.env.META_ACCESS_TOKEN) {
      return res.status(400).json({ error: 'WhatsApp not configured (META_PHONE_NUMBER_ID / META_ACCESS_TOKEN missing in env)' });
    }
    const wa = require('../services/whatsapp');
    const normalised = phone.replace(/[+\s]/g, '');
    await wa.sendText(normalised, message, null, null);
    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role,
      'SEND_WA_MESSAGE', 'patient', normalised, null, { message: message.slice(0, 100) }, req.ip);
    res.json({ success: true, phone: normalised });
  } catch (err) { handleError(res, err); }
});

// ── AUDIT LOGS ────────────────────────────────────────────────
router.get('/audit-logs', adminOnly, async (req, res) => {
  try {
    const { from, to, action, resource_type, page = 1, limit = 50, export: doExport } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;
    const s = req.tenant.schema_name;

    const conditions = ['1=1'];
    const params = [];

    if (from) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return res.status(400).json({ error: 'Invalid from date (YYYY-MM-DD)' });
      params.push(from);
      conditions.push(`created_at >= $${params.length}::date`);
    }
    if (to) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'Invalid to date (YYYY-MM-DD)' });
      params.push(to);
      conditions.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (action) {
      params.push(action.toUpperCase());
      conditions.push(`action = $${params.length}`);
    }
    if (resource_type) {
      params.push(resource_type.toLowerCase());
      conditions.push(`resource_type = $${params.length}`);
    }

    const where = conditions.join(' AND ');

    // Total count for pagination
    const countR = await tenantQuery(s, `SELECT COUNT(*) FROM audit_logs WHERE ${where}`, params);
    const total = parseInt(countR.rows[0].count);

    params.push(safeLimit, offset);
    const r = await tenantQuery(s, `
      SELECT id, actor_id, actor_role, action, resource_type, resource_id,
             old_values, new_values, ip_address, created_at
      FROM audit_logs
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    // CSV export
    if (doExport === 'csv') {
      const headers = ['timestamp', 'actor_role', 'action', 'resource_type', 'resource_id', 'ip_address'];
      const rows = r.rows.map(l => [
        l.created_at?.toISOString() || '',
        l.actor_role || '',
        l.action || '',
        l.resource_type || '',
        l.resource_id || '',
        l.ip_address || '',
      ]);
      const csv = [headers, ...rows].map(row =>
        row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
      ).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(csv);
    }

    res.json({ logs: r.rows, total, page: parseInt(page), limit: safeLimit, has_more: offset + r.rows.length < total });
  } catch (err) { handleError(res, err); }
});

// ── CIRCUIT BREAKER RESET ─────────────────────────────────────
// Call this after updating META_ACCESS_TOKEN to immediately unblock sends.
// (Path fixed: was '/admin/whatsapp/reset-circuit', which resolved to the
// unreachable /api/admin/admin/whatsapp/reset-circuit.)
router.post('/whatsapp/reset-circuit', adminOnly, async (req, res) => {
  try {
    const wa = require('../services/whatsapp');
    if (typeof wa.resetCircuit === 'function') {
      wa.resetCircuit(process.env.META_PHONE_NUMBER_ID);
      res.json({ success: true, message: 'Circuit breaker reset — bot will send again immediately.' });
    } else {
      res.status(501).json({ error: 'resetCircuit not exported from whatsapp service' });
    }
  } catch (err) { handleError(res, err); }
});

module.exports = router;
