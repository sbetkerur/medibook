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
const { IST_TODAY_SQL, IST_MONTH_START_SQL, IST_MONTH_START_TS_SQL } = require('../utils/dateTz');
const { CURRENT_TERMS_VERSION, hasAcceptedCurrentTerms } = require('../config/terms');
const logger = require('../utils/logger');
const QRCode = require('qrcode');
const { generateEntryCode, buildEntryLink, buildEntryMessage,
        publicWhatsAppNumber } = require('../utils/entryCode');

// ── TERMS OF SERVICE ACCEPTANCE ───────────────────────────────
// The evidence trail behind the click-wrap contract. See config/terms.js and
// migration 24 for why this exists; in short, DPDP s.8(2) requires a contract
// between the clinic (Data Fiduciary) and us (Processor), and an unproven
// acceptance is not one.

router.get('/terms', async (req, res) => {
  try {
    // Fresh SELECT, deliberately NOT req.tenant. tenantMiddleware caches the
    // tenants row (see middleware/auth.js), so req.tenant can hold a
    // pre-acceptance copy for the rest of the cache TTL — an admin who just
    // accepted would keep being re-prompted. Do not "optimise" this away.
    const r = await query(
      `SELECT terms_accepted_at, terms_version, terms_accepted_by FROM tenants WHERE id = $1`,
      [req.user.tenant_id]
    );
    const tenant = r.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json({
      accepted: hasAcceptedCurrentTerms(tenant),
      current_version: CURRENT_TERMS_VERSION,
      accepted_version: tenant.terms_version || null,
      accepted_at: tenant.terms_accepted_at || null,
      accepted_by: tenant.terms_accepted_by || null,
      can_accept: req.user.role === 'admin',
    });
  } catch (err) {
    handleError(res, err);
  }
});

// adminOnly: accepting binds the whole clinic to the contract, so reception
// and dentist accounts must not be able to do it on the owner's behalf.
router.post('/terms/accept', adminOnly, async (req, res) => {
  try {
    const { version } = req.body || {};
    // A missing version is a malformed request, not a stale client. Separating
    // them matters: 409 tells the UI to reload and re-prompt, which would be
    // the wrong remedy — and a misleading "terms have been updated" message —
    // for a caller that simply never sent the field.
    if (!version) {
      return res.status(400).json({ error: 'version is required' });
    }
    // Reject a stale version outright rather than silently recording the
    // current one. A client that has been open across a terms change would
    // otherwise POST the version the user actually READ while we store the
    // newer one — an acceptance of text they were never shown.
    if (version !== CURRENT_TERMS_VERSION) {
      return res.status(409).json({
        error: 'Terms have been updated. Please reload and review the current version.',
        current_version: CURRENT_TERMS_VERSION,
      });
    }

    // First acceptance wins. Re-accepting the SAME version must not overwrite
    // the original timestamp — the evidence of when the contract was formed is
    // the whole point, and a later click would quietly move that date forward.
    // A NEW version does overwrite, which is correct: that is a fresh contract.
    const r = await query(
      `UPDATE tenants
          SET terms_accepted_at = NOW(),
              terms_version     = $2,
              terms_accepted_ip = $3,
              terms_accepted_by = $4
        WHERE id = $1
          AND (terms_version IS DISTINCT FROM $2)
        RETURNING terms_accepted_at, terms_version`,
      [req.user.tenant_id, CURRENT_TERMS_VERSION, req.ip, req.user.email]
    );

    // No row updated means this version was already accepted — idempotent,
    // not an error. Return the existing record.
    if (!r.rows[0]) {
      const existing = await query(
        `SELECT terms_accepted_at, terms_version FROM tenants WHERE id = $1`,
        [req.user.tenant_id]
      );
      return res.json({ accepted: true, already: true, ...existing.rows[0] });
    }

    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role,
      'ACCEPT_TERMS', 'tenant', req.user.tenant_id,
      null, { version: CURRENT_TERMS_VERSION, accepted_by: req.user.email }, req.ip);

    logger.info('Terms accepted', {
      tenant_id: req.user.tenant_id,
      version: CURRENT_TERMS_VERSION,
      by: req.user.email,
    });

    res.json({ accepted: true, ...r.rows[0] });
  } catch (err) {
    handleError(res, err);
  }
});

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
        WHERE tenant_id=$1 AND stat_date=${IST_TODAY_SQL} AND updated_at > NOW() - INTERVAL '15 minutes'
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

    // Always run upcoming (time-sensitive) and today's schedule live.
    // "Today" is the IST calendar day, not CURRENT_DATE (the UTC date, which is
    // a day behind IST between 00:00 and 05:30 IST — the dashboard used to show
    // yesterday's queue for the first 5.5 hours of every clinic day).
    // `outstanding` is destructured explicitly: it sits before the cache-gated
    // block, so folding it into ...liveStats would shift every index the
    // statsData mapping below depends on.
    const [upcoming, recentAppts, outstanding, ...liveStats] = await Promise.allSettled([
      tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date>${IST_TODAY_SQL} AND status='confirmed'`),
      tenantQuery(s, `
        SELECT a.booking_id, a.appointment_date, a.appointment_time, a.status,
               p.name as patient_name, d.name as doctor_name
        FROM appointments a
        JOIN patients p ON p.id=a.patient_id
        JOIN doctors d ON d.id=a.doctor_id
        WHERE a.appointment_date=${IST_TODAY_SQL}
        ORDER BY a.appointment_time
        LIMIT 10
      `),
      // Treatment advised and never booked. This is the number an owner cares
      // about most — it is revenue already agreed and sitting idle — so it runs
      // live rather than off the 15-minute stats cache. Counted on BOOKED
      // sittings, not completed: a course whose remaining visits are already on
      // the calendar is not outstanding work.
      // The per-plan HAVING has to run in a subquery: grouping by tp.id makes
      // every group one row, so COUNT(*) at that level is always 1.
      tenantQuery(s, `
        SELECT COUNT(*)::int AS plans, COALESCE(SUM(estimated_cost), 0)::int AS value
        FROM (
          SELECT tp.id, tp.estimated_cost
          FROM treatment_plans tp
          LEFT JOIN appointments a ON a.treatment_plan_id = tp.id AND a.status <> 'cancelled'
          WHERE tp.status IN ('proposed','in_progress')
          GROUP BY tp.id, tp.estimated_cost, tp.total_visits
          HAVING COUNT(a.id) < tp.total_visits
        ) open_plans
      `),
      // Only run heavy queries if cache miss
      ...(cached ? [] : [
        tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date=${IST_TODAY_SQL} AND status='confirmed'`),
        tenantQuery(s, `SELECT COUNT(*) FROM patients WHERE deleted_at IS NULL`),
        tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date>=${IST_TODAY_SQL} AND status='available'`),
        tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date >= ${IST_MONTH_START_SQL} AND status IN ('confirmed','completed')`),
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
        VALUES ($1, ${IST_TODAY_SQL}, $2, $3, $4, $5, NOW())
        ON CONFLICT (tenant_id, stat_date) DO UPDATE SET
          appointments_today=EXCLUDED.appointments_today, appointments_month=EXCLUDED.appointments_month,
          patients_total=EXCLUDED.patients_total, active_slots=EXCLUDED.active_slots, updated_at=NOW()
      `, [tenantId, statsData.today_appointments, statsData.appointments_month ?? 0, statsData.total_patients, statsData.available_slots])
        .catch(() => {});
    }

    // Log any rejected queries
    [upcoming, recentAppts, outstanding, ...liveStats].forEach((r, i) => {
      if (r.status === 'rejected') logger.warn(`Dashboard query [${i}] failed`, { error: r.reason?.message });
    });

    res.json({
      today_appointments: statsData?.today_appointments ?? null,
      upcoming_appointments: val(upcoming),
      total_patients: statsData?.total_patients ?? null,
      available_slots: statsData?.available_slots ?? null,
      appointments_month: statsData?.appointments_month ?? null,
      todays_schedule: val(recentAppts, 'rows', []),
      outstanding_treatments: val(outstanding, 'plans', null),
      outstanding_treatment_value: val(outstanding, 'value', null),
      cache_hit: !!cached,
    });
  } catch (err) { handleError(res, err); }
});

// ── STAFF ─────────────────────────────────────────────────────
// adminOnly, matching every mutating sibling below. This is a user-management
// view, not a directory: it hands out the email address, role and active flag
// of every account in the clinic, which is exactly the input for a targeted
// phish at whoever holds 'admin'. A non-admin who reaches this tab can do
// nothing with the result — StaffTab renders no actions unless isAdmin.
// NOTE: the dashboard's NAV does not yet hide the Staff tab from non-admins
// (it only filters 'audit'), so until it does, a staff/doctor login opening
// that tab sees a "Failed to load staff" toast instead of a list.
router.get('/staff', adminOnly, async (req, res) => {
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

    // Lockout guards — DELETE /staff/:id has always had these; PATCH wrote
    // is_active and role straight through, so a sole admin could deactivate or
    // demote themselves and lock the clinic out permanently. There is no API
    // recovery: no super admin route reactivates a user or changes a role, so
    // the only remedy was manual SQL against production.
    const demotingSelf = req.params.id === req.user.id &&
      ((typeof is_active === 'boolean' && !is_active) || (role && role !== 'admin'));
    if (demotingSelf) {
      return res.status(400).json({ error: 'You cannot deactivate or demote your own admin account' });
    }

    const losingAdmin = (typeof is_active === 'boolean' && !is_active) || (role && role !== 'admin');
    if (losingAdmin) {
      const targetR = await tenantQuery(req.tenant.schema_name,
        `SELECT role, is_active FROM users WHERE id=$1`, [req.params.id]);
      if (!targetR.rows[0]) return res.status(404).json({ error: 'Staff member not found' });

      if (targetR.rows[0].role === 'admin' && targetR.rows[0].is_active) {
        const others = await tenantQuery(req.tenant.schema_name,
          `SELECT COUNT(*) FROM users WHERE role='admin' AND is_active=true AND id != $1`,
          [req.params.id]);
        if (parseInt(others.rows[0].count) < 1) {
          return res.status(400).json({ error: 'Cannot deactivate or demote the last admin account' });
        }
      }
    }
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

// ── RESET A STAFF MEMBER'S PASSWORD ──────────────────────────
// Self-service reset was delivered by email and is gone with it, which left the
// SUPER admin as the only person who could unlock a locked-out account — a
// Saturday-morning call to the vendor before the front desk can take bookings.
// A clinic admin already controls every other aspect of their staff accounts;
// this closes the gap without reintroducing a delivery channel.
//
// adminOnly, and never for yourself: /auth/change-password is the path for your
// own password and it requires the current one. Allowing self-reset here would
// turn any hijacked admin session into a permanent takeover with no need to
// know the existing password.
router.post('/staff/:id/reset-password', adminOnly, validateUUID(), async (req, res) => {
  try {
    const crypto = require('crypto');
    const s = req.tenant.schema_name;

    if (req.params.id === req.user.id) {
      return res.status(400).json({
        error: 'Use Change Password for your own account — it needs your current password.',
      });
    }

    const password = req.body?.password || crypto.randomBytes(9).toString('base64url');
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const hash = await bcrypt.hash(password, 12);
    const upd = await tenantQuery(s,
      `UPDATE users SET password_hash=$1 WHERE id=$2 AND is_active=true
       RETURNING id, email, name, role`, [hash, req.params.id]);
    if (!upd.rows[0]) return res.status(404).json({ error: 'Staff member not found' });
    const user = upd.rows[0];

    // Recovery must end any session still open on that account — otherwise the
    // reason for the reset (a shared or leaked password) survives it.
    await query(`UPDATE refresh_tokens SET used=true WHERE user_id=$1 AND used=false`, [user.id])
      .catch(e => logger.warn('Refresh-token revocation failed after staff reset', { error: e.message }));

    await writeAuditLog(s, req.user.id, req.user.role,
      'RESET_STAFF_PASSWORD', 'user', user.id, null, { email: user.email }, req.ip);

    // Returned ONCE so it can be handed over in person. Never stored or logged.
    res.json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      password,
      message: 'Password updated. Give it to them directly and ask them to change it.',
    });
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

// ── CLINIC QR CODE ────────────────────────────────────────────
// The clinic's only patient-facing entry point. All tenants share one WhatsApp
// number, so a scan is what tells the bot which clinic the patient means — see
// utils/entryCode.js. Readable by any signed-in staff member: the receptionist
// who needs to reprint the card is usually not an admin, and the code is
// printed on a poster in a public waiting room, so it is not a secret.
router.get('/clinic-qr', async (req, res) => {
  try {
    // Read fresh rather than trusting req.tenant, which is cached by the tenant
    // middleware and would serve a stale code straight after a regenerate.
    const r = await query(`SELECT name, entry_code FROM tenants WHERE id=$1`, [req.tenant.id]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Clinic not found' });

    const number = publicWhatsAppNumber();
    const link = buildEntryLink(row.entry_code, row.name, number);

    // Both shapes are reported rather than an error, so the dashboard can
    // explain WHICH half is missing: a clinic with no code needs a regenerate,
    // a deployment with no WHATSAPP_PUBLIC_NUMBER needs an env var, and telling
    // a receptionist "QR unavailable" for either is useless.
    if (!link) {
      return res.json({
        code: row.entry_code || null,
        link: null,
        configured: false,
        reason: !row.entry_code ? 'no_entry_code' : 'no_public_number',
      });
    }

    // 'Q' error correction (25%) rather than the default 'M': this gets printed
    // on a card that lives on a reception counter, and a scuffed or partly
    // covered code that still scans is worth the extra modules.
    const [svg, png] = await Promise.all([
      QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'Q', margin: 2 }),
      QRCode.toDataURL(link, { errorCorrectionLevel: 'Q', margin: 2, width: 512 }),
    ]);

    res.json({
      code: row.entry_code,
      clinic_name: row.name,
      link,
      message: buildEntryMessage(row.entry_code, row.name),
      whatsapp_number: number,
      configured: true,
      svg,
      png,
    });
  } catch (err) { handleError(res, err); }
});

// Mint a new code. adminOnly and audited because it is destructive in the
// physical world: every card, poster and website link already carrying the old
// code stops working the moment this succeeds, and the clinic will not find
// out from the dashboard — it finds out when patients stop arriving. The old
// code is recorded in the audit entry so a regenerate done by mistake can be
// undone by hand.
router.post('/clinic-qr/regenerate', adminOnly, async (req, res) => {
  try {
    const prev = await query(`SELECT entry_code FROM tenants WHERE id=$1`, [req.tenant.id]);
    if (!prev.rows[0]) return res.status(404).json({ error: 'Clinic not found' });
    const oldCode = prev.rows[0].entry_code;

    // Retry against the unique index rather than pre-checking for a free code:
    // a SELECT-then-UPDATE would race another clinic being created.
    let code = null;
    for (let attempt = 0; attempt < 5 && !code; attempt++) {
      const candidate = generateEntryCode();
      try {
        await query(`UPDATE tenants SET entry_code=$1 WHERE id=$2`, [candidate, req.tenant.id]);
        code = candidate;
      } catch (e) {
        if (e.code !== '23505') throw e;
      }
    }
    if (!code) return res.status(503).json({ error: 'Could not allocate a new code. Please retry.' });

    await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role,
      'REGENERATE_CLINIC_QR', 'tenant', req.tenant.id, { entry_code: oldCode },
      { entry_code: code }, req.ip);

    res.json({ code, message: 'New code issued. Reprint any QR codes already on display.' });
  } catch (err) { handleError(res, err); }
});

// ── SETTINGS ──────────────────────────────────────────────────
// tenants.settings is a mixed jsonb blob: tenant-editable notification prefs
// sit alongside SERVER-controlled keys. PATCH /settings deliberately allowlists
// notification_prefs (see schemas.updateSettings) "so a tenant admin can never
// inject rate_limits or alert_webhook_url" — but the read side used to hand the
// whole blob to any role. alert_webhook_url is the URL the platform POSTs
// rate-limit alerts to (middleware/tenantRateLimit.js) and can carry a bearer
// token in its query string, so it must not leave the server at all; rate_limits
// is the per-tenant throttle configuration, useful only for probing where the
// ceilings are. Both are stripped for EVERY role, including admins, who have no
// way to set them and no UI that reads them.
const PLATFORM_ONLY_SETTINGS_KEYS = ['rate_limits', 'alert_webhook_url'];
// Non-admins get only what the dashboard actually consumes:
// frontend/src/components/tabs/SettingsTab.js reads exactly this from
// `settings.settings` and nothing else (the toggle is admin-write anyway).
const NON_ADMIN_SETTINGS_KEYS = ['reminder_24h_enabled'];

function visibleSettings(rawSettings, role) {
  const src = rawSettings || {};
  const out = {};
  if (role === 'admin') {
    for (const [k, v] of Object.entries(src)) {
      if (!PLATFORM_ONLY_SETTINGS_KEYS.includes(k)) out[k] = v;
    }
    return out;
  }
  for (const k of NON_ADMIN_SETTINGS_KEYS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

router.get('/settings', async (req, res) => {
  try {
    const t = req.tenant;
    const [hospR, planR, usageR, userR] = await Promise.allSettled([
      // ORDER BY is required for "primary hospital" to mean the same row here as
      // it does in PATCH /settings — an unordered LIMIT 1 can return either row.
      tenantQuery(t.schema_name,
        `SELECT * FROM hospitals WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`),
      query(`SELECT * FROM plans WHERE id=$1`, [t.plan]),
      Promise.all([
        tenantQuery(t.schema_name, `SELECT COUNT(*) FROM doctors WHERE is_active=true`),
        // Must use the SAME month boundary as bookingCore.checkMonthlyQuota (IST,
        // not UTC) — otherwise on the 1st of the month this counter and the limit
        // actually being enforced disagree for 5.5 hours, and the clinic sees
        // "3/500 used" while bookings are rejected as over quota.
        tenantQuery(t.schema_name,
          `SELECT COUNT(*) FROM appointments
           WHERE created_at >= ${IST_MONTH_START_TS_SQL}`),
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
      settings: visibleSettings(t.settings, req.user?.role),
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
    const { name, notification_prefs, notify_phone, address, city, phone } = req.body;
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

    // Clinic address/city/phone live on the hospital row, not on tenants.
    // These were accepted by the Joi schema and reported back by GET /settings
    // but never written — an admin editing them got a 200 and no change.
    // Targets the same "primary" hospital GET /settings reads.
    if (address !== undefined || city !== undefined || phone !== undefined) {
      const hospUpdates = [];
      const hospParams = [];
      if (address !== undefined) { hospParams.push(address || null); hospUpdates.push(`address=$${hospParams.length}`); }
      if (city !== undefined)    { hospParams.push(city || null);    hospUpdates.push(`city=$${hospParams.length}`); }
      if (phone !== undefined)   { hospParams.push(phone || null);   hospUpdates.push(`phone=$${hospParams.length}`); }
      const updated = await tenantQuery(req.tenant.schema_name, `
        UPDATE hospitals SET ${hospUpdates.join(',')}
        WHERE id = (SELECT id FROM hospitals WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1)
        RETURNING id
      `, hospParams);
      if (!updated.rows[0]) {
        return res.status(409).json({ error: 'No clinic record exists yet — add a clinic first.' });
      }
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
    // Validated, not just parsed. parseInt('abc') is NaN, which node-postgres
    // serialises as the string "NaN"; Postgres rejects it for an integer column
    // and a normal dashboard tab answered 500 for a typo in a query string.
    // Every other filter here is validated first — these two were not.
    const ratingBound = (v) => {
      const n = parseInt(v, 10);
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
    };
    if (min_rating !== undefined && ratingBound(min_rating) === null) {
      return res.status(400).json({ error: 'min_rating must be an integer between 1 and 5' });
    }
    if (max_rating !== undefined && ratingBound(max_rating) === null) {
      return res.status(400).json({ error: 'max_rating must be an integer between 1 and 5' });
    }
    if (doctor_id) { params.push(doctor_id); where.push(`a.doctor_id=$${params.length}`); }
    if (min_rating !== undefined) { params.push(ratingBound(min_rating)); where.push(`af.rating>=$${params.length}`); }
    if (max_rating !== undefined) { params.push(ratingBound(max_rating)); where.push(`af.rating<=$${params.length}`); }
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
    // The count must carry the SAME filters as the page query. It used to be an
    // unfiltered COUNT(*) over appointment_feedback, so filtering by doctor or
    // rating left `total` and `has_more` describing a different result set: the
    // "Load more" button stayed live past the last row and then paged into
    // nothing. avg_rating/distribution stay clinic-wide on purpose — they are
    // the headline numbers, not a property of the current filter.
    const countParams = params.slice(0, params.length - 2);
    const [filteredCountR, avgR, distR] = await Promise.all([
      tenantQuery(s, `
        SELECT COUNT(*) as total
        FROM appointment_feedback af
        JOIN appointments a ON a.id=af.appointment_id
        WHERE ${where.join(' AND ')}
      `, countParams),
      tenantQuery(s, `SELECT ROUND(AVG(rating),1) as avg_rating, COUNT(*) as total FROM appointment_feedback`),
      tenantQuery(s, `SELECT rating, COUNT(*) as count FROM appointment_feedback GROUP BY rating ORDER BY rating DESC`),
    ]);
    const total = parseInt(filteredCountR.rows[0]?.total || 0);
    res.json({
      feedback: r.rows,
      page: parseInt(page),
      has_more: offset + r.rows.length < total,
      avg_rating: avgR.rows[0]?.avg_rating ? parseFloat(avgR.rows[0].avg_rating) : null,
      total,
      total_all: parseInt(avgR.rows[0]?.total || 0),
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
      tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date >= ${IST_TODAY_SQL} AND status='available'`),
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

// ── BOT TESTER (dashboard "Test Bot" tab) ──────────────────────
// Runs a message through the real bot engine for the LOGGED-IN admin's own
// tenant, same as POST /api/webhook/test but authenticated by the dashboard's
// JWT instead of a shared secret — that route is registered only outside
// production (or with ENABLE_TEST_ENDPOINT=true), which prod normally doesn't
// set, so the dashboard must not depend on it. See services/bot/testRunner.js.
const botTestLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many test requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
router.post('/bot-test', botTestLimiter, async (req, res) => {
  try {
    const { phone, message, button_id } = req.body;
    if (!phone || !/^[0-9]{7,20}$/.test(String(phone).replace(/[+\s]/g, ''))) {
      return res.status(400).json({ error: 'Valid phone (7-20 digits) is required' });
    }
    if (!message && !button_id) return res.status(400).json({ error: 'message is required' });
    const { runBotTest } = require('../services/bot/testRunner');
    const responses = await runBotTest({
      tenant: req.tenant, phone, message: message || '', buttonId: button_id,
    });
    res.json({ ok: true, phone, message, tenant: req.tenant.name, responses });
  } catch (err) { handleError(res, err, 'POST /admin/bot-test'); }
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
    const normalised = phone.replace(/[+\s]/g, '');

    // The WhatsApp number is SHARED across all tenants, so an unrestricted
    // "send to any number" endpoint let one clinic's admin message the general
    // public using platform credentials — and Meta's quality rating (which
    // governs delivery for EVERY tenant) is a shared resource. Restrict sends to
    // numbers this tenant already has a relationship with: one of its own
    // patients, or a staff member's configured notify_phone.
    const knownR = await tenantQuery(req.tenant.schema_name, `
      SELECT 1 FROM patients WHERE phone=$1 AND deleted_at IS NULL
      UNION ALL
      SELECT 1 FROM users WHERE notify_phone=$1 AND is_active=true
      LIMIT 1
    `, [normalised]);
    if (!knownR.rows[0]) {
      return res.status(403).json({
        error: 'That number is not a patient or staff member of this clinic. The WhatsApp number is shared across clinics, so messages can only be sent to your own contacts.',
      });
    }

    // Opted-out patients must not be messaged (bot honours this; so must staff).
    const optedR = await tenantQuery(req.tenant.schema_name,
      `SELECT 1 FROM patients WHERE phone=$1 AND opted_out=true LIMIT 1`, [normalised]);
    if (optedR.rows[0]) {
      return res.status(403).json({ error: 'This patient has opted out of WhatsApp messages.' });
    }

    // Recorded in wa_messages: a message a staff member sent by hand is part of
    // the patient's conversation, and it used to be the one outbound message
    // that left no trace anywhere except the audit log.
    const { sendPatientText } = require('../services/outbound');
    await sendPatientText(req.tenant.schema_name, normalised, message);
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

    // audit_logs.created_at is TIMESTAMPTZ and servers run UTC, so a bare
    // `created_at >= $1::date` coerces the date literal at UTC — putting the
    // boundary at 05:30 IST. Filtering a single day therefore HID everything
    // logged before 05:30 that day and silently INCLUDED 00:00-05:30 of the
    // next one; every audit query and its CSV export was shifted 5.5 hours.
    // For a log whose entire purpose is attribution, "the action isn't in the
    // log for the day it happened" is the wrong answer. Build the boundary as
    // an IST wall-clock timestamp and let Postgres convert it back.
    if (from) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return res.status(400).json({ error: 'Invalid from date (YYYY-MM-DD)' });
      params.push(from);
      conditions.push(`created_at >= (($${params.length}::date)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
    }
    if (to) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'Invalid to date (YYYY-MM-DD)' });
      params.push(to);
      conditions.push(`created_at < ((($${params.length}::date + INTERVAL '1 day'))::timestamp AT TIME ZONE 'Asia/Kolkata')`);
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
// NOTE: the circuit breaker is keyed by the SHARED META_PHONE_NUMBER_ID, so this
// is a platform-wide reset triggered from a tenant-scoped route. That's
// intentional — it's the documented escape hatch after rotating the Meta token,
// and the failure mode of an unnecessary reset is mild (one extra send attempt).
// It is audit-logged so a tenant repeatedly resetting a genuinely-open circuit
// is visible rather than silent.
router.post('/whatsapp/reset-circuit', adminOnly, async (req, res) => {
  try {
    const wa = require('../services/whatsapp');
    if (typeof wa.resetCircuit === 'function') {
      wa.resetCircuit(process.env.META_PHONE_NUMBER_ID);
      await writeAuditLog(req.tenant.schema_name, req.user.id, req.user.role,
        'RESET_WA_CIRCUIT', 'platform', process.env.META_PHONE_NUMBER_ID || null,
        null, { scope: 'shared_phone_number' }, req.ip);
      logger.warn('WhatsApp circuit breaker reset by tenant admin (affects all tenants on the shared number)', {
        tenant: req.tenant.slug, userId: req.user.id,
      });
      res.json({ success: true, message: 'Circuit breaker reset — bot will send again immediately.' });
    } else {
      res.status(501).json({ error: 'resetCircuit not exported from whatsapp service' });
    }
  } catch (err) { handleError(res, err); }
});

module.exports = router;
