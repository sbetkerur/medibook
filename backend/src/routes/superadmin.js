const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { query, tenantQuery, validateSchemaName } = require('../db');
const { createTenantSchema, runTenantMigrations } = require('../db/tenantMigrate');
const { authMiddleware, invalidateTenantCache } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const { validateUUID, UUID_RE } = require('../utils/errors');
const logger = require('../utils/logger');
const { handleError } = require('../utils/errors');
const { IST_TODAY_SQL, IST_MONTH_START_TS_SQL } = require('../utils/dateTz');
const { getClient: getRedisClient } = require('../utils/redisClient');

// v2: the meaning of total_appointments_30d / appointments_this_month changed
// (see GET /stats below). A v1 payload written by the previous deploy would be
// served for up to 60s with the OLD definitions under the NEW field names, so
// the key is bumped rather than reused.
const STATS_CACHE_KEY = 'superadmin:stats:v2';
const STATS_CACHE_TTL_S = 60; // 1 minute

// tenant_stats_cache freshness window for the platform dashboard.
// routes/admin.js uses 15 minutes because a clinic watching its own queue needs
// near-live numbers and refreshes the row itself on every miss. Here the row is
// normally written once a night by the slotGenerator cron, so 15 minutes would
// be a permanent miss; a full-day window is the opposite bug — it serves the
// 00:05 IST row at 22:00 IST, when patients_total is ~22 hours stale. 60 minutes
// lets a genuinely recent roll-up (cron, or a tenant dashboard refresh) save the
// heaviest query on this endpoint, and falls through to a live count otherwise.
const STATS_CACHE_FRESH_MINUTES = 60;

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
    // Return cached result if fresh (60s TTL) — this endpoint runs 6+ DB queries
    const redis = getRedisClient();
    try {
      const cached = redis ? await redis.get(STATS_CACHE_KEY) : null;
      if (cached) return res.json({ ...JSON.parse(cached), from_cache: true });
    } catch (_) {}

    const [total, active, plans, monthly, mrrR, newMonth] = await Promise.all([
      query(`SELECT COUNT(*) FROM tenants`),
      query(`SELECT COUNT(*) FROM tenants WHERE status='active'`),
      query(`SELECT plan, COUNT(*) as count FROM tenants GROUP BY plan ORDER BY count DESC`),
      query(`SELECT COUNT(*) as new_tenants FROM tenants WHERE created_at >= NOW() - INTERVAL '30 days'`),
      // billing_monthly first: Professional is priced PER BRANCH with a
      // negotiated discount, so a multi-branch group's real revenue is a
      // number only the deal knows. Falling straight through to price_monthly
      // would report one branch's list price for the largest customers.
      query(`SELECT COALESCE(SUM(COALESCE(t.billing_monthly, p.price_monthly)), 0) as mrr
               FROM tenants t LEFT JOIN plans p ON p.id=t.plan WHERE t.status='active'`),
      query(`SELECT COUNT(*) FROM tenants WHERE created_at >= ${IST_MONTH_START_TS_SQL}`),
    ]);
    const mrr = parseInt(mrrR.rows[0].mrr) || 0;

    const activeTenants = parseInt(active.rows[0].count);

    // ── Cross-tenant aggregates ───────────────────────────────
    // Every field below has exactly ONE definition whether or not the roll-up
    // cache is warm. Previously total_appointments_30d was served from
    // tenant_stats_cache.appointments_month on a hit and from a live
    // created_at >= NOW() - 30 days count on a miss — two different questions
    // (scheduled month-to-date vs created in the last 30 days) under one name,
    // so on the 2nd of the month the number silently dropped by ~90% depending
    // on whether the nightly cron had written a row.
    //
    // The cache can only honestly answer two of these:
    //   appointments_today  — appointment_date = IST today AND status='confirmed'
    //   patients_total      — patients WHERE deleted_at IS NULL
    // Its appointments_month column is appointment_date-based and status-filtered,
    // which is NOT the quota definition, so it is never read here.
    let totalPatients = null;
    let cacheHit = false;
    try {
      // Partial coverage must NOT be treated as a hit: SUM over whichever rows
      // happen to be fresh would silently omit every tenant whose row is stale
      // or missing, under-reporting the platform total with no error. Require a
      // fresh row for every active tenant, or compute the whole thing live.
      const cached = await query(`
        SELECT COUNT(*)::int AS fresh_tenants,
               COALESCE(SUM(c.patients_total), 0) AS patients_total
        FROM tenant_stats_cache c
        JOIN tenants t ON t.id = c.tenant_id AND t.status = 'active'
        WHERE c.stat_date = ${IST_TODAY_SQL}
          AND c.updated_at > NOW() - INTERVAL '${STATS_CACHE_FRESH_MINUTES} minutes'
      `);
      const row = cached.rows[0];
      if (activeTenants > 0 && row && row.fresh_tenants >= activeTenants) {
        totalPatients = parseInt(row.patients_total) || 0;
        cacheHit = true;
      }
    } catch (_) {}

    const SCHEMA_RE = /^tenant_[a-z0-9_]+$/;
    const tenantSchemas = await query(`SELECT schema_name FROM tenants WHERE status='active'`);
    const validSchemas = tenantSchemas.rows.filter(t => SCHEMA_RE.test(t.schema_name));
    const invalidCount = tenantSchemas.rows.length - validSchemas.length;
    if (invalidCount > 0) {
      logger.warn(`Cross-tenant stats: skipping ${invalidCount} tenant(s) with a schema_name that failed validation`, { invalidCount });
    }

    // Process ALL active tenants in fixed-size batches (rather than capping at
    // an arbitrary 100) so platform totals never silently undercount once there
    // are more tenants than a single UNION ALL query should reasonably hold.
    const BATCH_SIZE = 100;
    let appts30d = 0;
    let apptsMonth = 0;
    let apptsToday = 0;
    let patientTotal = 0;
    for (let i = 0; i < validSchemas.length; i += BATCH_SIZE) {
      const batch = validSchemas.slice(i, i + BATCH_SIZE);
      try {
        // All three appointment metrics come from ONE scan per tenant schema, so
        // computing the fast-moving ones live costs nothing beyond the 30-day
        // count this loop already ran.
        // - c_month uses IST_MONTH_START_TS_SQL against created_at with ALL
        //   statuses: it must equal the sum of the per-tenant quota panels
        //   (/tenants/:id/quota) and bookingCore.checkMonthlyQuota, which is the
        //   limit actually enforced at booking time. A cancelled appointment
        //   still consumed quota, so status must not be filtered.
        // - c_today matches the slotGenerator roll-up's definition exactly.
        const apptParts = batch.map(t => `
          SELECT
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS c_30d,
            COUNT(*) FILTER (WHERE created_at >= ${IST_MONTH_START_TS_SQL}) AS c_month,
            COUNT(*) FILTER (WHERE appointment_date = ${IST_TODAY_SQL} AND status = 'confirmed') AS c_today
          FROM "${t.schema_name}".appointments`);
        const apptR = await query(
          `SELECT SUM(c_30d)::bigint AS t_30d, SUM(c_month)::bigint AS t_month, SUM(c_today)::bigint AS t_today
           FROM (${apptParts.join(' UNION ALL ')}) x`
        );
        appts30d += parseInt(apptR.rows[0].t_30d) || 0;
        apptsMonth += parseInt(apptR.rows[0].t_month) || 0;
        apptsToday += parseInt(apptR.rows[0].t_today) || 0;
      } catch (err) {
        logger.warn('Cross-tenant appointment count failed for a batch', { error: err.message, batchStart: i, batchSize: batch.length });
      }
      if (cacheHit) continue; // patients_total already served from the roll-up
      try {
        // deleted_at IS NULL mirrors the cache writers (slotGenerator /
        // routes/admin.js); a bare COUNT(*) here made total_patients jump
        // upwards on a cache miss by counting soft-deleted patients.
        const patientParts = batch.map(t =>
          `SELECT COUNT(*) AS cnt FROM "${t.schema_name}".patients WHERE deleted_at IS NULL`
        );
        const patientR = await query(
          `SELECT SUM(cnt)::bigint AS total FROM (${patientParts.join(' UNION ALL ')}) x`
        );
        patientTotal += parseInt(patientR.rows[0].total) || 0;
      } catch (err) {
        logger.warn('Cross-tenant patient count failed for a batch', { error: err.message, batchStart: i, batchSize: batch.length });
      }
    }
    if (!cacheHit) totalPatients = patientTotal;

    const result = {
      total_tenants: parseInt(total.rows[0].count),
      active_tenants: activeTenants,
      new_tenants_this_month: parseInt(newMonth.rows[0].count),
      monthly_growth: parseInt(monthly.rows[0].new_tenants),
      by_plan: plans.rows,
      // Appointments CREATED in the trailing 30 days, all statuses, active tenants.
      total_appointments_30d: appts30d,
      // Active-tenant patients with deleted_at IS NULL.
      total_patients: totalPatients,
      // Appointments SCHEDULED for the IST calendar day today, status='confirmed'.
      appointments_today: apptsToday,
      // Appointments CREATED since the IST month start, all statuses — the quota
      // definition (bookingCore.checkMonthlyQuota), not a scheduled-in-month count.
      appointments_this_month: apptsMonth,
      mrr,
      // Honest: true only when total_patients came from a fresh, complete
      // tenant_stats_cache roll-up. Every other field above is always live.
      stats_cache_hit: cacheHit,
    };

    // Cache result for 60 seconds
    if (redis) { try { await redis.set(STATS_CACHE_KEY, JSON.stringify(result), 'EX', STATS_CACHE_TTL_S); } catch (_) {} }

    res.json(result);
  } catch (err) { handleError(res, err, 'GET /superadmin/stats'); }
});

// ── LIST ALL TENANTS ──────────────────────────────────────────
router.get('/tenants', async (req, res) => {
  try {
    const { page = 1, search, limit } = req.query;
    const safeLimit = Math.max(1, Math.min(parseInt(limit) || 20, 50));
    const offset = (Math.max(parseInt(page), 1) - 1) * safeLimit;

    let where = '';
    const params = [];
    if (search) {
      if (search.length > 100) return res.status(400).json({ error: 'search too long' });
      const escapedSearch = search.replace(/[%_\\]/g, '\\$&');
      params.push(`%${escapedSearch}%`);
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
  } catch (err) { handleError(res, err); }
});

// ── GET SINGLE TENANT ─────────────────────────────────────────
router.get('/tenants/:id', validateUUID(), async (req, res) => {
  try {
    const r = await query(`SELECT * FROM tenants WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ tenant: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

// ── CREATE TENANT ─────────────────────────────────────────────
router.post('/tenants', createTenantLimiter, validate(schemas.createTenant), async (req, res) => {
  try {
    const { name, slug, owner_email, owner_password, owner_name, plan, city } = req.body;

    const schema = 'tenant_' + slug.replace(/-/g, '_').toLowerCase();

    // Check slug uniqueness
    const existing = await query(`SELECT id FROM tenants WHERE slug=$1`, [slug]);
    if (existing.rows[0]) return res.status(409).json({ error: 'Slug already taken' });

    // Phase 1: insert tenant record (WA credentials are now global — no per-tenant fields)
    const r = await query(`
      INSERT INTO tenants (name, slug, schema_name, owner_email, plan, city)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [name, slug, schema, owner_email, plan || 'starter', city?.trim() || null]);
    const tenant = r.rows[0];

    // Phase 2 & 3: create schema + admin user — rollback both if either fails
    const effectivePassword = owner_password || crypto.randomBytes(8).toString('hex');
    try {
      await createTenantSchema(schema);
      await runTenantMigrations(schema);

      const hash = await bcrypt.hash(effectivePassword, 12);
      await tenantQuery(schema, `
        INSERT INTO users (email, password_hash, name, role)
        VALUES ($1,$2,$3,'admin')
      `, [owner_email, hash, owner_name || name + ' Admin']);
    } catch (setupErr) {
      // Rollback: drop schema and delete tenant record to leave no orphans
      logger.error('Tenant setup failed — rolling back', { slug, error: setupErr.message });
      // Defense-in-depth: validate the schema name before interpolating it into a
      // DROP SCHEMA statement, same as every other place that builds tenant SQL.
      // Joi validation upstream already constrains `slug`, so this should never
      // throw in practice — but a DROP SCHEMA typo here would be catastrophic.
      try {
        validateSchemaName(schema);
        await query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      } catch (validationErr) {
        logger.error('Refusing to drop schema — failed schema name validation', { schema, error: validationErr.message });
      }
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
    } catch (auditErr) { logger.warn('Audit log failed (CREATE_TENANT)', { error: auditErr.message }); }

    res.json({
      tenant,
      credentials: {
        email: owner_email,
        password: effectivePassword,
        tenant_slug: slug,
        login_url: `${require('../utils/appUrls').frontendBaseUrl()}/login`,
      },
      message: 'Tenant created successfully'
    });
  } catch (err) {
    // 23505 = unique_violation — slug or schema_name already exists (TOCTOU race)
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Slug already taken' });
    }
    handleError(res, err, 'POST /superadmin/tenants');
  }
});

// ── UPDATE TENANT ─────────────────────────────────────────────
router.patch('/tenants/:id', validateUUID(), async (req, res) => {
  try {
    const { status, plan, name, suspension_reason, city, billing_monthly } = req.body;

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
    // Keep in sync with the tiers seeded in db/migrate.js and with
    // validate.js's createTenant enum. 'enterprise' and 'growth' were retired
    // (migrations 22 and 23) and cannot be assigned again.
    const VALID_PLANS = ['starter', 'professional'];
    if (plan && !VALID_PLANS.includes(plan)) {
      return res.status(400).json({ error: `Invalid plan. Must be one of: ${VALID_PLANS.join(', ')}` });
    }
    if (plan) { params.push(plan); updates.push(`plan=$${params.length}`); }
    // `!== undefined`, not truthiness like the fields above: a wrong city must be
    // removable, and '' / null are the only ways to say "unset". The bot filters
    // on a non-null city, so it is stored as NULL rather than an empty string.
    if (city !== undefined) {
      params.push(typeof city === 'string' ? (city.trim() || null) : null);
      updates.push(`city=$${params.length}`);
    }
    // The negotiated monthly amount, overriding the tier's list price — set it
    // for any Professional tenant with more than one branch. `!== undefined`
    // like city above, because null is the meaningful "revert to list price"
    // value and truthiness would also swallow a deliberate 0 (a free pilot).
    if (billing_monthly !== undefined) {
      if (billing_monthly === null) {
        updates.push('billing_monthly=NULL');
      } else if (!Number.isInteger(billing_monthly) || billing_monthly < 0) {
        return res.status(400).json({ error: 'billing_monthly must be a non-negative integer (rupees per month) or null' });
      } else {
        params.push(billing_monthly);
        updates.push(`billing_monthly=$${params.length}`);
      }
    }

    if (!updates.length) return res.json({ message: 'Nothing to update' });

    // Fetch current plan before update so we can log the change
    let oldPlan = null;
    if (plan) {
      const cur = await query(`SELECT plan FROM tenants WHERE id=$1`, [req.params.id]);
      oldPlan = cur.rows[0]?.plan || null;
    }

    params.push(req.params.id);
    const r = await query(
      `UPDATE tenants SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Tenant not found' });

    // Log plan change for billing dashboard (Enhancement 13)
    if (plan && oldPlan && plan !== oldPlan) {
      query(`
        INSERT INTO plan_changes (tenant_id, old_plan, new_plan, changed_by)
        VALUES ($1,$2,$3,$4)
      `, [req.params.id, oldPlan, plan, req.user.id]).catch(err =>
        logger.warn('plan_changes insert failed', { error: err.message })
      );
    }

    // Immediately evict from tenant middleware cache so status changes (e.g. suspension) take effect without delay
    invalidateTenantCache(req.params.id);

    // Audit log
    try {
      await query(`
        INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, new_values, ip_address)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [req.user.id, 'super_admin', 'UPDATE_TENANT', 'tenant', req.params.id,
          JSON.stringify({ status, plan, name, suspension_reason }), req.ip]);
    } catch (auditErr) { logger.warn('Audit log failed (UPDATE_TENANT)', { error: auditErr.message }); }

    res.json({ tenant: r.rows[0] });
  } catch (err) { handleError(res, err); }
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
  } catch (err) { handleError(res, err); }
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
      tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date >= ${IST_TODAY_SQL} AND status='available'`),
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
      wa_configured: !!(process.env.META_PHONE_NUMBER_ID && process.env.META_ACCESS_TOKEN),
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
      },
    });
  } catch (err) { handleError(res, err); }
});

/**
 * Is a tenant's stored billing amount stale for its current branch count?
 *
 * Professional bills ₹1,799 for the first branch and a per-deal discount on
 * each additional one, so the real figure lives in tenants.billing_monthly and
 * NOTHING keeps it in step as branches are added. The exact expected amount
 * can't be recomputed (the discount isn't stored), but it is always bounded:
 * at worst no discount (price × branches), at best every extra branch free
 * (price). Outside that window means stale for today's branch count.
 *
 * Shared by GET /tenants/:id/quota and GET /billing so the per-tenant panel and
 * the revenue roll-up can never disagree about what counts as under-billed.
 *
 * @returns {null|'missing_override'|'outside_expected_range'}
 */
function billingDriftFlag({ listPrice, billingMonthly, branches }) {
  if (listPrice == null || branches == null || branches < 1) return null;
  // The certain case: several branches, still billing the list price of one.
  if (branches > 1 && billingMonthly == null) return 'missing_override';
  if (billingMonthly != null &&
      (billingMonthly < listPrice || billingMonthly > listPrice * branches)) {
    // Branches added since the amount was agreed — or removed, leaving the
    // clinic over-billed.
    return 'outside_expected_range';
  }
  return null;
}

// ── LIST PLANS ────────────────────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM plans ORDER BY price_monthly`);
    res.json({ plans: r.rows });
  } catch (err) { handleError(res, err); }
});

// ── BILLING DASHBOARD (Enhancement 13) ───────────────────────
router.get('/billing', async (req, res) => {
  try {
    const [planBreakdown, recentChanges] = await Promise.all([
      query(`
        -- SUM of per-tenant amounts, not tenant_count * list price: with
        -- Professional billed per branch and discounted per deal, the two
        -- diverge for exactly the tenants worth the most. COALESCE keeps
        -- Starter/Growth (billing_monthly NULL) on the list price.
        SELECT p.id, p.name, p.price_monthly,
               COUNT(t.id) AS tenant_count,
               COALESCE(SUM(COALESCE(t.billing_monthly, p.price_monthly)), 0) AS subtotal
        FROM plans p
        LEFT JOIN tenants t ON t.plan = p.id AND t.status = 'active'
        GROUP BY p.id, p.name, p.price_monthly
        ORDER BY p.price_monthly DESC
      `),
      query(`
        SELECT pc.id, pc.old_plan, pc.new_plan, pc.changed_at,
               t.name AS tenant_name, t.slug
        FROM plan_changes pc
        JOIN tenants t ON t.id = pc.tenant_id
        ORDER BY pc.changed_at DESC
        LIMIT 50
      `).catch(() => ({ rows: [] })), // graceful if table doesn't exist yet on old deployments
    ]);

    const mrr = planBreakdown.rows.reduce((sum, p) => sum + parseInt(p.subtotal || 0), 0);

    // ── Billing drift sweep ──────────────────────────────────
    // The MRR above is only as honest as tenants.billing_monthly, and nothing
    // updates that when a branch is added. This is the one screen where a
    // wrong revenue number actually gets looked at, so the tenants dragging it
    // out of true are listed right next to it.
    //
    // Branch counts live in each tenant's own schema, so this is one query per
    // active tenant — the same shape as bot/clinicBranches.listActiveBranches,
    // run concurrently and caught INDIVIDUALLY so a single schema mid-migration
    // degrades to "unknown branch count" instead of taking the billing page
    // down. Acceptable here because /billing is an on-demand admin view, not a
    // hot path.
    const billableR = await query(`
      SELECT t.id, t.name, t.slug, t.schema_name, t.plan, t.billing_monthly, p.price_monthly
        FROM tenants t LEFT JOIN plans p ON p.id = t.plan
       WHERE t.status = 'active'
    `);

    const alerts = (await Promise.all(billableR.rows.map(async (t) => {
      let branches = null;
      try {
        const r = await tenantQuery(t.schema_name,
          `SELECT COUNT(*) FROM hospitals WHERE is_active=true AND deleted_at IS NULL`);
        branches = parseInt(r.rows[0].count);
      } catch (err) {
        logger.warn('billing drift: branch count failed', { tenant: t.slug, error: err.message });
        return null; // unknown branch count — can't judge, don't guess
      }
      const listPrice = t.price_monthly ?? null;
      const flag = billingDriftFlag({ listPrice, billingMonthly: t.billing_monthly, branches });
      if (!flag) return null;
      return {
        tenant_id: t.id,
        name: t.name,
        slug: t.slug,
        plan: t.plan,
        branches,
        billing_monthly: t.billing_monthly ?? null,
        effective_monthly: t.billing_monthly ?? listPrice,
        expected_min: listPrice,
        expected_max: listPrice != null ? listPrice * branches : null,
        flag,
      };
    }))).filter(Boolean);

    res.json({
      mrr_total: mrr,
      by_plan: planBreakdown.rows.map(p => ({
        ...p,
        tenant_count: parseInt(p.tenant_count),
        subtotal: parseInt(p.subtotal || 0),
      })),
      recent_changes: recentChanges.rows,
      billing_alerts: alerts,
    });
  } catch (err) { handleError(res, err, 'GET /superadmin/billing'); }
});

// ── TENANT IMPERSONATION ──────────────────────────────────────
router.post('/tenants/:id/impersonate', validateUUID(), async (req, res) => {
  try {
    const tenantR = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [req.params.id]);
    if (!tenantR.rows[0]) return res.status(404).json({ error: 'Tenant not found or inactive' });
    const tenant = tenantR.rows[0];

    // Get the admin user for this tenant
    const adminR = await tenantQuery(tenant.schema_name,
      `SELECT id, email, name, role FROM users WHERE role='admin' AND is_active=true LIMIT 1`);
    if (!adminR.rows[0]) return res.status(404).json({ error: 'No admin user found for this tenant' });
    const adminUser = adminR.rows[0];

    const jwt = require('jsonwebtoken');
    // Short-lived 15-minute impersonation token
    const token = jwt.sign(
      {
        id: adminUser.id,
        email: adminUser.email,
        role: adminUser.role,
        tenant_id: tenant.id,
        tenant_slug: tenant.slug,
        impersonated_by: req.user.id,
        impersonation: true,
        // jti so the token participates in blacklist revocation like every
        // other access token — without it there is no way to kill a misused
        // impersonation session before its 15-minute expiry.
        jti: require('crypto').randomUUID(),
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    // Audit log
    try {
      await query(`
        INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, new_values, ip_address)
        VALUES ($1,'super_admin','IMPERSONATE_TENANT','tenant',$2,$3,$4)
      `, [req.user.id, tenant.id, JSON.stringify({ tenant_name: tenant.name, admin_email: adminUser.email }), req.ip]);
    } catch (_) {}

    res.json({
      token,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      user: { email: adminUser.email, name: adminUser.name, role: adminUser.role },
      expires_in: '15m',
      warning: 'This token grants full admin access to the tenant. Use responsibly.',
    });
  } catch (err) { handleError(res, err, 'POST /superadmin/tenants/:id/impersonate'); }
});

// ── ONBOARDING STATUS ─────────────────────────────────────────
router.get('/tenants/:id/onboarding', validateUUID(), async (req, res) => {
  try {
    const tenantR = await query(`SELECT * FROM tenants WHERE id=$1`, [req.params.id]);
    if (!tenantR.rows[0]) return res.status(404).json({ error: 'Tenant not found' });
    const t = tenantR.rows[0];
    const s = t.schema_name;

    const [hospitals, doctors, slots, bookings] = await Promise.allSettled([
      tenantQuery(s, `SELECT COUNT(*) FROM hospitals WHERE is_active=true`),
      tenantQuery(s, `SELECT COUNT(*) FROM doctors WHERE is_active=true`),
      tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date >= ${IST_TODAY_SQL} AND status='available'`),
      tenantQuery(s, `SELECT COUNT(*) FROM appointments`),
    ]);
    const v = (r) => r.status === 'fulfilled' ? parseInt(r.value.rows[0]?.count || 0) : 0;

    const steps = [
      { id: 'wa_configured', label: 'WhatsApp Connected (shared globally)', done: !!(process.env.META_PHONE_NUMBER_ID && process.env.META_ACCESS_TOKEN) },
      { id: 'hospital_added', label: 'Hospital/Clinic Added', done: v(hospitals) > 0 },
      { id: 'doctor_added', label: 'Doctor Added', done: v(doctors) > 0 },
      { id: 'slots_generated', label: 'Appointment Slots Generated', done: v(slots) > 0 },
      { id: 'test_booking_made', label: 'First Booking Received', done: v(bookings) > 0 },
    ];

    const done = steps.filter(s => s.done).length;
    const percent = Math.round((done / steps.length) * 100);

    res.json({
      tenant_id: t.id,
      onboarding_completed: t.onboarding_completed || percent === 100,
      percent_complete: percent,
      steps,
    });
  } catch (err) { handleError(res, err); }
});

router.patch('/tenants/:id/onboarding', validateUUID(), async (req, res) => {
  try {
    await query(`UPDATE tenants SET onboarding_completed=true WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── RATE LIMIT DASHBOARD ──────────────────────────────────────
router.get('/rate-limits', async (req, res) => {
  try {
    const blocked = await query(`
      SELECT ip, blocked_until, reason, offense_count, blocked_at
      FROM rate_limit_blocks
      WHERE blocked_until > NOW()
      ORDER BY offense_count DESC, blocked_at DESC
      LIMIT 100
    `);

    const redis = getRedisClient();
    let liveTraffic = [];
    try {
      const window = Math.floor(Date.now() / 60000);
      const tenants = await query(`SELECT id, name, slug, plan FROM tenants WHERE status='active'`);
      const keys = tenants.rows.map(t => `ratelimit:tenant:${t.id}:${window}`);
      if (redis && keys.length > 0) {
        const counts = await redis.mget(...keys);
        liveTraffic = tenants.rows.map((t, i) => ({
          tenant_id: t.id,
          tenant_name: t.name,
          tenant_slug: t.slug,
          plan: t.plan,
          requests_this_minute: parseInt(counts[i] || 0),
        })).filter(t => t.requests_this_minute > 0).sort((a, b) => b.requests_this_minute - a.requests_this_minute);
      }
    } catch (_) {}

    res.json({
      blocked_ips: blocked.rows,
      live_traffic: liveTraffic,
      timestamp: new Date().toISOString(),
    });
  } catch (err) { handleError(res, err); }
});

router.delete('/rate-limits/:ip', async (req, res) => {
  try {
    const ip = req.params.ip;
    if (!ip || ip.length > 45) return res.status(400).json({ error: 'Invalid IP' });
    await query(`DELETE FROM rate_limit_blocks WHERE ip=$1`, [ip]);
    res.json({ success: true, unblocked_ip: ip });
  } catch (err) { handleError(res, err); }
});

// ── DATABASE BACKUPS ──────────────────────────────────────────
router.get('/backups', async (req, res) => {
  try {
    const r = await query(`
      SELECT id, started_at, completed_at, status, file_path, size_bytes, duration_ms, error_message
      FROM backup_log ORDER BY started_at DESC LIMIT 30
    `);
    res.json({ backups: r.rows });
  } catch (err) { handleError(res, err); }
});

router.post('/backups/trigger', async (req, res) => {
  try {
    res.json({ message: 'Backup started', started_at: new Date().toISOString() });
    setImmediate(async () => {
      try {
        const { runBackup } = require('../jobs/backupManager');
        await runBackup();
        logger.info('Manual backup triggered by super admin');
      } catch (err) {
        logger.error('Manual backup failed', { error: err.message });
      }
    });
  } catch (err) { handleError(res, err); }
});

router.get('/backups/restore-instructions', async (req, res) => {
  try {
    const latest = await query(`
      SELECT file_path, size_bytes, started_at FROM backup_log WHERE status='success' ORDER BY started_at DESC LIMIT 1
    `);
    const latestBackup = latest.rows[0] || null;
    res.json({
      instructions: [
        '1. Download the backup file from the server (use SSH/SFTP)',
        '2. Run: psql $DATABASE_URL < <backup_file>',
        '3. Or for production: psql $DATABASE_URL -f medibook_backup_YYYYMMDD.sql',
      ],
      latest_backup: latestBackup,
      warning: 'Restore will overwrite ALL data. Create a fresh backup before restoring.',
      pg_restore_command: latestBackup ? `psql $DATABASE_URL < ${latestBackup.file_path}` : null,
    });
  } catch (err) { handleError(res, err); }
});

// ── FAILED WEBHOOKS MANAGEMENT ────────────────────────────────
router.get('/webhooks/failed', async (req, res) => {
  try {
    const { limit = 20, status = 'failed' } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 20, 100);
    const VALID_STATUSES = ['pending', 'processing', 'succeeded', 'failed'];
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const r = await query(`
      SELECT fw.id, fw.phone, fw.message_type, fw.error_message, fw.attempts,
             fw.max_attempts, fw.status, fw.created_at, fw.next_retry_at,
             fw.sanitized_payload,
             t.name as tenant_name, t.slug as tenant_slug
      FROM failed_webhooks fw
      JOIN tenants t ON t.id = fw.tenant_id
      WHERE fw.status = $1
      ORDER BY fw.created_at DESC
      LIMIT $2
    `, [status, safeLimit]);

    // Mask phones for security
    const rows = r.rows.map(r => ({
      ...r,
      phone: r.phone ? '*'.repeat(Math.max(0, r.phone.length - 4)) + r.phone.slice(-4) : '****',
    }));

    res.json({ webhooks: rows, count: rows.length });
  } catch (err) { handleError(res, err); }
});

router.post('/webhooks/:id/retry', validateUUID(), async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query(
      `UPDATE failed_webhooks
       SET status='pending', attempts=0, next_retry_at=NOW(), error_message=NULL
       WHERE id=$1 AND status IN ('failed','pending')
       RETURNING id`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Webhook not found or not in retryable state' });
    res.json({ success: true, id });
  } catch (err) { handleError(res, err); }
});

// ── FEATURE FLAGS ─────────────────────────────────────────────
router.get('/tenants/:id/feature-flags', validateUUID(), async (req, res) => {
  try {
    const { getAllFlags } = require('../utils/featureFlags');
    const flags = await getAllFlags(req.params.id);
    res.json({ flags });
  } catch (err) { handleError(res, err); }
});

router.post('/tenants/:id/feature-flags', validateUUID(), async (req, res) => {
  try {
    const { flag_key, enabled } = req.body;
    if (!flag_key || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'flag_key (string) and enabled (boolean) required' });
    }
    const { setFlag } = require('../utils/featureFlags');
    await setFlag(req.params.id, flag_key, enabled);
    res.json({ success: true, flag_key, enabled });
  } catch (err) { handleError(res, err); }
});

// ── QUOTA MONITORING ──────────────────────────────────────────
router.get('/tenants/:id/quota', validateUUID(), async (req, res) => {
  try {
    const tenantR = await query(
      // LEFT JOIN, not JOIN: `plans` can legitimately be empty (pricing is not
      // currently defined), and an inner join turned that into a 404 for every
      // tenant — the panel vanished rather than reporting "no limit". A missing
      // plan row now reads the same as an unlimited one, which is what the
      // NULL-limit handling below already expects.
      `SELECT t.*, p.max_appointments_per_month, p.max_doctors, p.max_branches, p.price_monthly
         FROM tenants t LEFT JOIN plans p ON p.id=t.plan WHERE t.id=$1`,
      [req.params.id]
    );
    if (!tenantR.rows[0]) return res.status(404).json({ error: 'Not found' });
    const t = tenantR.rows[0];

    const [apptCount, doctorCount, branchCount] = await Promise.all([
      // Must match bookingCore.checkMonthlyQuota exactly — this panel reports the
      // quota that route enforces, and a UTC month start made the two disagree
      // for the first 5.5 hours of the 1st.
      tenantQuery(t.schema_name, `SELECT COUNT(*) FROM appointments WHERE created_at >= ${IST_MONTH_START_TS_SQL}`),
      tenantQuery(t.schema_name, `SELECT COUNT(*) FROM doctors WHERE is_active=true`),
      // Same predicate as the branch cap in POST /hospitals and as
      // clinicBranches.listActiveBranches — three places counting "a live
      // branch" differently is how a clinic gets billed for a deleted one.
      tenantQuery(t.schema_name, `SELECT COUNT(*) FROM hospitals WHERE is_active=true AND deleted_at IS NULL`),
    ]);

    const appts = parseInt(apptCount.rows[0].count);
    const doctors = parseInt(doctorCount.rows[0].count);
    const branches = parseInt(branchCount.rows[0].count);
    // NULL limit = unlimited plan — report 0% and never recommend an upgrade
    const apptPct = t.max_appointments_per_month ? Math.round((appts / t.max_appointments_per_month) * 100) : 0;
    const doctorPct = t.max_doctors ? Math.round((doctors / t.max_doctors) * 100) : 0;
    const branchPct = t.max_branches ? Math.round((branches / t.max_branches) * 100) : 0;

    // Billing drift for this one tenant — same rule as the /billing sweep.
    const listPrice = t.price_monthly ?? null;
    const effectiveMonthly = t.billing_monthly ?? listPrice;
    const billingFlag = billingDriftFlag({
      listPrice, billingMonthly: t.billing_monthly, branches,
    });

    res.json({
      tenant_id: t.id,
      plan: t.plan,
      appointments: { used: appts, limit: t.max_appointments_per_month, percent: apptPct },
      doctors: { used: doctors, limit: t.max_doctors, percent: doctorPct },
      branches: { used: branches, limit: t.max_branches, percent: branchPct },
      billing: {
        list_price_per_branch: listPrice,
        billing_monthly: t.billing_monthly ?? null,   // the agreed override, if any
        effective_monthly: effectiveMonthly,          // what MRR counts for this tenant today
        // Bounds implied by today's branch count: no discount .. every extra branch free.
        expected_min: listPrice,
        expected_max: listPrice != null ? listPrice * Math.max(branches, 1) : null,
        flag: billingFlag,                            // null | 'missing_override' | 'outside_expected_range'
      },
      upgrade_recommended: apptPct >= 80 || doctorPct >= 80 || branchPct >= 80,
      upgrade_prompt: t.upgrade_prompt,
    });
  } catch (err) { handleError(res, err); }
});

// ── TENANT USERS + PASSWORD RECOVERY ──────────────────────────
// Self-service reset (/auth/forgot-password) delivers its link by email. When
// no email provider is configured that flow completes silently and the user
// never receives anything, leaving a locked-out clinic admin with no recovery
// path at all — the tenant's own admin can reset staff, but nobody can reset
// the admin. These two routes are that missing path.

router.get('/tenants/:id/users', validateUUID(), async (req, res) => {
  try {
    const tenantR = await query(`SELECT schema_name FROM tenants WHERE id=$1`, [req.params.id]);
    if (!tenantR.rows[0]) return res.status(404).json({ error: 'Tenant not found' });

    const users = await tenantQuery(tenantR.rows[0].schema_name,
      `SELECT id, email, name, role, is_active, created_at FROM users ORDER BY role, email`);
    res.json({ users: users.rows });
  } catch (err) { handleError(res, err, 'GET /superadmin/tenants/:id/users'); }
});

// Strict limiter: this hands out working credentials for someone else's clinic.
const resetTenantPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many password reset requests. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/tenants/:id/users/:userId/reset-password', resetTenantPasswordLimiter, validateUUID(), async (req, res) => {
  try {
    const { id: tenantId, userId } = req.params;
    // validateUUID() only checks :id, so :userId is validated explicitly — it is
    // interpolated into a tenant-scoped query below.
    if (!UUID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user id' });

    // slug is selected because the log line below prefers it — without it the
    // message always silently fell back to the tenant name.
    const tenantR = await query(`SELECT id, name, slug, schema_name FROM tenants WHERE id=$1`, [tenantId]);
    if (!tenantR.rows[0]) return res.status(404).json({ error: 'Tenant not found' });
    const tenant = tenantR.rows[0];

    const password = req.body?.password || crypto.randomBytes(9).toString('base64url');
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const hash = await bcrypt.hash(password, 12);
    const upd = await tenantQuery(tenant.schema_name,
      `UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id, email, name, role`, [hash, userId]);
    if (!upd.rows[0]) return res.status(404).json({ error: 'User not found in this clinic' });
    const user = upd.rows[0];

    // Same rationale as /auth/reset-password: recovery must end any session an
    // attacker (or the previous holder of the account) still has open.
    await query(`UPDATE refresh_tokens SET used=true WHERE user_id=$1 AND used=false`, [user.id])
      .catch(e => logger.warn('Refresh-token revocation failed after super admin reset', { error: e.message }));

    try {
      await query(`
        INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, new_values, ip_address)
        VALUES ($1,'super_admin','RESET_TENANT_USER_PASSWORD','user',$2,$3,$4)
      `, [req.user.id, user.id, JSON.stringify({ tenant_id: tenant.id, tenant_name: tenant.name, email: user.email }), req.ip]);
    } catch (_) {}

    logger.info('Super admin reset a tenant user password', {
      tenant: tenant.slug || tenant.name, email: user.email, actor: req.user.id,
    });

    // The generated password is returned ONCE so it can be handed over. It is
    // deliberately not stored or logged anywhere.
    res.json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      password,
      message: 'Password updated. Share it over a secure channel and ask them to change it.',
    });
  } catch (err) { handleError(res, err, 'POST /superadmin/tenants/:id/users/:userId/reset-password'); }
});

module.exports = router;

// Exported for tests — the rule that decides whether a clinic is being
// under-billed is pure, and it is the one piece of the per-branch pricing model
// with no other way to verify it (branch counts need a live tenant schema).
module.exports.billingDriftFlag = billingDriftFlag;
