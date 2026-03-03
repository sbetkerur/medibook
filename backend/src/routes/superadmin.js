const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { query, tenantQuery } = require('../db');
const { createTenantSchema } = require('../db/tenantMigrate');
const { authMiddleware, invalidateTenantCache } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { encrypt } = require('../utils/encryption');
const { validateUUID } = require('../utils/errors');
const logger = require('../utils/logger');

// Strict limiter for tenant creation — each call provisions a full DB schema
const createTenantLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many tenant creation requests. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function superAdminOnly(req, res, next) {
  if (req.user?.role !== 'super_admin') return res.status(403).json({ error: 'Super admin access required' });
  next();
}

router.use(authMiddleware, superAdminOnly);

// ── PLATFORM STATS ────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [total, active, plans, monthly] = await Promise.all([
      query(`SELECT COUNT(*) FROM tenants`),
      query(`SELECT COUNT(*) FROM tenants WHERE status='active'`),
      query(`SELECT plan, COUNT(*) as count FROM tenants GROUP BY plan ORDER BY count DESC`),
      query(`SELECT COUNT(*) as new_tenants FROM tenants WHERE created_at >= NOW() - INTERVAL '30 days'`),
    ]);

    // Cross-tenant counts — single UNION ALL query per metric (avoid N+1)
    // Schema names are server-generated as 'tenant_<slug>' — validate before interpolating
    const SCHEMA_RE = /^tenant_[a-z0-9_]+$/;
    const tenantSchemas = await query(`SELECT schema_name FROM tenants WHERE status='active'`);
    const validSchemas = tenantSchemas.rows.filter(t => SCHEMA_RE.test(t.schema_name));
    // Limit UNION size to prevent excessively large query strings on large deployments
    const schemasForUnion = validSchemas.slice(0, 100);
    let totalAppointments = 0;
    let totalPatients = 0;

    if (schemasForUnion.length > 0) {
      try {
        const apptParts = schemasForUnion.map(t =>
          `SELECT COUNT(*) FROM "${t.schema_name}".appointments WHERE created_at >= NOW() - INTERVAL '30 days'`
        );
        const apptR = await query(
          `SELECT SUM(cnt)::bigint as total FROM (${apptParts.map(q => `(${q}) cnt`).join(' UNION ALL ')}) x`
        );
        totalAppointments = parseInt(apptR.rows[0].total) || 0;
      } catch (err) {
        logger.warn('Cross-tenant appointment count failed', { error: err.message });
      }

      try {
        const patientParts = schemasForUnion.map(t =>
          `SELECT COUNT(*) FROM "${t.schema_name}".patients`
        );
        const patientR = await query(
          `SELECT SUM(cnt)::bigint as total FROM (${patientParts.map(q => `(${q}) cnt`).join(' UNION ALL ')}) x`
        );
        totalPatients = parseInt(patientR.rows[0].total) || 0;
      } catch (err) {
        logger.warn('Cross-tenant patient count failed', { error: err.message });
      }
    }

    // MRR — sum of price_monthly for all active tenants (COALESCE prevents NULL when no rows)
    let mrr = 0;
    try {
      const mrrR = await query(`
        SELECT COALESCE(SUM(p.price_monthly), 0) as mrr
        FROM tenants t LEFT JOIN plans p ON p.id=t.plan
        WHERE t.status='active'
      `);
      mrr = parseInt(mrrR.rows[0].mrr) || 0;
    } catch (_) {}

    res.json({
      total_tenants: parseInt(total.rows[0].count),
      active_tenants: parseInt(active.rows[0].count),
      monthly_growth: parseInt(monthly.rows[0].new_tenants),
      by_plan: plans.rows,
      total_appointments_30d: totalAppointments,
      total_patients: totalPatients,
      mrr,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LIST ALL TENANTS ──────────────────────────────────────────
router.get('/tenants', async (req, res) => {
  try {
    const { page = 1, search, limit } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 20, 50);
    const offset = (Math.max(parseInt(page), 1) - 1) * safeLimit;

    let where = '';
    const params = [];
    if (search) {
      if (search.length > 100) return res.status(400).json({ error: 'search too long' });
      params.push(`%${search}%`);
      where = ` WHERE t.name ILIKE $1 OR t.slug ILIKE $1`;
    }

    const countParams = [...params];
    params.push(safeLimit, offset);

    const [r, countR] = await Promise.all([
      query(
        `SELECT t.*, p.name as plan_name FROM tenants t LEFT JOIN plans p ON p.id=t.plan${where} ORDER BY t.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      query(`SELECT COUNT(*) FROM tenants t${where}`, countParams),
    ]);

    res.json({
      tenants: r.rows,
      total: parseInt(countR.rows[0].count),
      page: parseInt(page),
      limit: safeLimit,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET SINGLE TENANT ─────────────────────────────────────────
router.get('/tenants/:id', validateUUID(), async (req, res) => {
  try {
    const r = await query(`SELECT * FROM tenants WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ tenant: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CREATE TENANT ─────────────────────────────────────────────
router.post('/tenants', createTenantLimiter, validate(schemas.createTenant), async (req, res) => {
  try {
    const { name, slug, owner_email, owner_password, owner_name, plan, wa_phone_number_id, wa_access_token } = req.body;

    const schema = 'tenant_' + slug.replace(/-/g, '_').toLowerCase();

    // Check slug uniqueness
    const existing = await query(`SELECT id FROM tenants WHERE slug=$1`, [slug]);
    if (existing.rows[0]) return res.status(409).json({ error: 'Slug already taken' });

    const waTokenEnc = wa_access_token ? encrypt(wa_access_token) : null;

    // Phase 1: insert tenant record
    const r = await query(`
      INSERT INTO tenants (name, slug, schema_name, owner_email, plan, wa_phone_number_id, wa_access_token_enc)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [name, slug, schema, owner_email, plan || 'starter', wa_phone_number_id || null, waTokenEnc]);
    const tenant = r.rows[0];

    // Phase 2 & 3: create schema + admin user — rollback both if either fails
    const effectivePassword = owner_password || crypto.randomBytes(8).toString('hex');
    try {
      await createTenantSchema(schema);

      const hash = await bcrypt.hash(effectivePassword, 12);
      await tenantQuery(schema, `
        INSERT INTO users (email, password_hash, name, role)
        VALUES ($1,$2,$3,'admin')
      `, [owner_email, hash, owner_name || name + ' Admin']);
    } catch (setupErr) {
      // Rollback: drop schema and delete tenant record to leave no orphans
      logger.error('Tenant setup failed — rolling back', { slug, error: setupErr.message });
      await query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await query(`DELETE FROM tenants WHERE id=$1`, [tenant.id]).catch(() => {});
      throw setupErr;
    }

    // Audit log
    try {
      await query(`
        INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, new_values, ip_address)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [req.user.id, 'super_admin', 'CREATE_TENANT', 'tenant', tenant.id,
          JSON.stringify({ name, slug, plan: plan || 'starter' }), req.ip]);
    } catch (_) {}

    res.json({
      tenant,
      credentials: {
        email: owner_email,
        password: effectivePassword,
        tenant_slug: slug,
        login_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`,
      },
      message: 'Tenant created successfully'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── UPDATE TENANT ─────────────────────────────────────────────
router.patch('/tenants/:id', validateUUID(), async (req, res) => {
  try {
    const { status, plan, wa_phone_number_id, wa_access_token, name, suspension_reason } = req.body;

    const VALID_STATUSES = ['active', 'suspended', 'inactive'];
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const updates = [];
    const params = [];

    if (name) { params.push(name); updates.push(`name=$${params.length}`); }
    if (status) {
      params.push(status); updates.push(`status=$${params.length}`);
      if (status === 'suspended') {
        params.push(suspension_reason || null); updates.push(`suspension_reason=$${params.length}`);
        updates.push('suspended_at=NOW()');
      } else if (status === 'active') {
        // Clear suspension info when reactivating
        updates.push('suspension_reason=NULL', 'suspended_at=NULL');
      }
    }
    if (plan) { params.push(plan); updates.push(`plan=$${params.length}`); }
    if (wa_phone_number_id) { params.push(wa_phone_number_id); updates.push(`wa_phone_number_id=$${params.length}`); }
    if (wa_access_token) { params.push(encrypt(wa_access_token)); updates.push(`wa_access_token_enc=$${params.length}`); }

    if (!updates.length) return res.json({ message: 'Nothing to update' });

    params.push(req.params.id);
    const r = await query(
      `UPDATE tenants SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );

    // Immediately evict from tenant middleware cache so status changes (e.g. suspension) take effect without delay
    invalidateTenantCache(req.params.id);

    // Audit log
    try {
      await query(`
        INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, new_values, ip_address)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [req.user.id, 'super_admin', 'UPDATE_TENANT', 'tenant', req.params.id,
          JSON.stringify({ status, plan, name, suspension_reason }), req.ip]);
    } catch (_) {}

    res.json({ tenant: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TENANT USAGE STATS ────────────────────────────────────────
router.get('/tenants/:id/stats', validateUUID(), async (req, res) => {
  try {
    const tenantR = await query(`SELECT * FROM tenants WHERE id=$1`, [req.params.id]);
    if (!tenantR.rows[0]) return res.status(404).json({ error: 'Not found' });
    const s = tenantR.rows[0].schema_name;

    const [appts, patients, doctors] = await Promise.all([
      tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE created_at >= NOW() - INTERVAL '30 days'`),
      tenantQuery(s, `SELECT COUNT(*) FROM patients`),
      tenantQuery(s, `SELECT COUNT(*) FROM doctors WHERE is_active=true`),
    ]);
    res.json({
      appointments_30d: parseInt(appts.rows[0].count),
      total_patients: parseInt(patients.rows[0].count),
      active_doctors: parseInt(doctors.rows[0].count),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TENANT HEALTH ──────────────────────────────────────────────
router.get('/tenants/:id/health', validateUUID(), async (req, res) => {
  try {
    const tenantR = await query(`SELECT * FROM tenants WHERE id=$1`, [req.params.id]);
    if (!tenantR.rows[0]) return res.status(404).json({ error: 'Not found' });
    const t = tenantR.rows[0];
    const s = t.schema_name;

    const [appts30d, appts7d, lastAppt, patients, doctors, slots] = await Promise.allSettled([
      tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE created_at >= NOW() - INTERVAL '30 days'`),
      tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE created_at >= NOW() - INTERVAL '7 days'`),
      tenantQuery(s, `SELECT MAX(created_at) as last FROM appointments`),
      tenantQuery(s, `SELECT COUNT(*) FROM patients`),
      tenantQuery(s, `SELECT COUNT(*) FROM doctors WHERE is_active=true`),
      tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date >= CURRENT_DATE AND status='available'`),
    ]);
    const v = (r, col = 'count') => r.status === 'fulfilled' ? (parseInt(r.value.rows[0]?.[col]) || 0) : 0;
    const lastActive = lastAppt.status === 'fulfilled' ? lastAppt.value.rows[0]?.last : null;

    // Health flags
    const hasZeroAppts = v(appts30d) === 0;
    const hasFewSlots = v(slots) < 5;
    const isNewTenant = (Date.now() - new Date(t.created_at).getTime()) < 7 * 24 * 60 * 60 * 1000;

    res.json({
      tenant_id: t.id,
      name: t.name,
      status: t.status,
      plan: t.plan,
      wa_configured: !!t.wa_phone_number_id,
      onboarding_completed: t.onboarding_completed,
      appointments_30d: v(appts30d),
      appointments_7d: v(appts7d),
      total_patients: v(patients),
      active_doctors: v(doctors),
      available_slots: v(slots),
      last_appointment_at: lastActive,
      flags: {
        no_recent_activity: hasZeroAppts && !isNewTenant,
        low_slots: hasFewSlots,
        no_whatsapp: !t.wa_phone_number_id,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LIST PLANS ────────────────────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM plans ORDER BY price_monthly`);
    res.json({ plans: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
