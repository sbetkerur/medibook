const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, tenantQuery } = require('../db');
const { createTenantSchema } = require('../db/tenantMigrate');
const { authMiddleware } = require('../middleware/auth');
const { encrypt } = require('../utils/encryption');

function superAdminOnly(req, res, next) {
  if (req.user?.role !== 'super_admin') return res.status(403).json({ error: 'Super admin access required' });
  next();
}

router.use(authMiddleware, superAdminOnly);

// Platform stats
router.get('/stats', async (req, res) => {
  try {
    const [total, active, plans] = await Promise.all([
      query(`SELECT COUNT(*) FROM tenants`),
      query(`SELECT COUNT(*) FROM tenants WHERE status='active'`),
      query(`SELECT plan, COUNT(*) as count FROM tenants GROUP BY plan ORDER BY count DESC`),
    ]);
    res.json({
      total_tenants: parseInt(total.rows[0].count),
      active_tenants: parseInt(active.rows[0].count),
      by_plan: plans.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List all tenants
router.get('/tenants', async (req, res) => {
  try {
    const { page = 1, search } = req.query;
    let sql = `SELECT t.*, p.name as plan_name FROM tenants t LEFT JOIN plans p ON p.id=t.plan`;
    const params = [];
    if (search) { params.push(`%${search}%`); sql += ` WHERE t.name ILIKE $1 OR t.slug ILIKE $1`; }
    params.push(20, (parseInt(page) - 1) * 20);
    sql += ` ORDER BY t.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const r = await query(sql, params);
    res.json({ tenants: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get single tenant
router.get('/tenants/:id', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM tenants WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ tenant: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create new tenant (clinic onboarding)
router.post('/tenants', async (req, res) => {
  try {
    const { name, slug, owner_email, owner_password, owner_name, plan, wa_phone_number_id, wa_access_token } = req.body;
    if (!name || !slug || !owner_email) {
      return res.status(400).json({ error: 'name, slug, and owner_email are required' });
    }

    const schema = 'tenant_' + slug.replace(/-/g, '_').toLowerCase();

    // Check slug uniqueness
    const existing = await query(`SELECT id FROM tenants WHERE slug=$1`, [slug]);
    if (existing.rows[0]) return res.status(409).json({ error: 'Slug already taken' });

    const waTokenEnc = wa_access_token ? encrypt(wa_access_token) : null;

    const r = await query(`
      INSERT INTO tenants (name, slug, schema_name, owner_email, plan, wa_phone_number_id, wa_access_token_enc)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [name, slug, schema, owner_email, plan || 'starter', wa_phone_number_id || null, waTokenEnc]);
    const tenant = r.rows[0];

    // Create tenant schema and tables
    await createTenantSchema(schema);

    // Create admin user in tenant schema
    const hash = await bcrypt.hash(owner_password || 'Admin@123456', 12);
    await tenantQuery(schema, `
      INSERT INTO users (email, password_hash, name, role)
      VALUES ($1,$2,$3,'admin')
    `, [owner_email, hash, owner_name || name + ' Admin']);

    res.json({
      tenant,
      credentials: {
        email: owner_email,
        password: owner_password || 'Admin@123456 (please change)',
        tenant_slug: slug,
        login_url: 'http://localhost:3000/login',
      },
      message: 'Tenant created successfully'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update tenant
router.patch('/tenants/:id', async (req, res) => {
  try {
    const { status, plan, wa_phone_number_id, wa_access_token, name } = req.body;
    const updates = [];
    const params = [];

    if (name) { params.push(name); updates.push(`name=$${params.length}`); }
    if (status) { params.push(status); updates.push(`status=$${params.length}`); }
    if (plan) { params.push(plan); updates.push(`plan=$${params.length}`); }
    if (wa_phone_number_id) { params.push(wa_phone_number_id); updates.push(`wa_phone_number_id=$${params.length}`); }
    if (wa_access_token) { params.push(encrypt(wa_access_token)); updates.push(`wa_access_token_enc=$${params.length}`); }

    if (!updates.length) return res.json({ message: 'Nothing to update' });

    params.push(req.params.id);
    const r = await query(
      `UPDATE tenants SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    res.json({ tenant: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tenant usage stats (cross-schema)
router.get('/tenants/:id/stats', async (req, res) => {
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

// List plans
router.get('/plans', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM plans ORDER BY price_monthly`);
    res.json({ plans: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
