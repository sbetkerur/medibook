const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, tenantQuery } = require('../db');

// Super admin login
router.post('/auth/superadmin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const r = await query(`SELECT * FROM super_admins WHERE email=$1`, [email.toLowerCase()]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: r.rows[0].id, email: r.rows[0].email, role: 'super_admin' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token, user: { email: r.rows[0].email, name: r.rows[0].name, role: 'super_admin' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tenant admin login
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password, tenant_slug } = req.body;
    if (!email || !password || !tenant_slug) {
      return res.status(400).json({ error: 'Email, password and clinic ID required' });
    }
    const tenantR = await query(`SELECT * FROM tenants WHERE slug=$1 AND status='active'`, [tenant_slug]);
    if (!tenantR.rows[0]) return res.status(404).json({ error: 'Clinic not found' });
    const tenant = tenantR.rows[0];
    const userR = await tenantQuery(tenant.schema_name,
      `SELECT * FROM users WHERE email=$1 AND is_active=true`, [email.toLowerCase()]);
    if (!userR.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, userR.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: userR.rows[0].id, email: userR.rows[0].email, role: userR.rows[0].role, tenant_id: tenant.id, tenant_slug },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({
      token,
      user: { email: userR.rows[0].email, name: userR.rows[0].name, role: userR.rows[0].role, tenant: tenant.name, tenant_slug }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
