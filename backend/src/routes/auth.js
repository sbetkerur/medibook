const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { query, tenantQuery } = require('../db');
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const emailService = require('../services/email');
const logger = require('../utils/logger');

// Strict limiters for unauthenticated sensitive endpoints
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many password reset requests. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many reset attempts. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const changePasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many password change attempts. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── SUPER ADMIN LOGIN ─────────────────────────────────────────
router.post('/auth/superadmin/login', validate(schemas.loginStrict), async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = (email || '').trim().toLowerCase();
    const r = await query(`SELECT * FROM super_admins WHERE email=$1`, [normalizedEmail]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!valid) {
      await query(`INSERT INTO admin_access_logs (email, event, ip_address, user_agent) VALUES ($1,'login_failed',$2,$3)`,
        [normalizedEmail, req.ip, req.headers['user-agent']]).catch(() => {});
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const jti = crypto.randomUUID();
    const token = jwt.sign(
      { id: r.rows[0].id, email: r.rows[0].email, role: 'super_admin', jti },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    await query(`INSERT INTO admin_access_logs (user_id, email, event, ip_address, user_agent) VALUES ($1,$2,'login_success',$3,$4)`,
      [r.rows[0].id, r.rows[0].email, req.ip, req.headers['user-agent']]).catch(() => {});
    res.json({ token, user: { email: r.rows[0].email, name: r.rows[0].name, role: 'super_admin' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TENANT ADMIN LOGIN ────────────────────────────────────────
router.post('/auth/login', validate(schemas.login), async (req, res) => {
  try {
    const { email, password, tenant_slug } = req.body;
    const normalizedEmail = (email || '').trim().toLowerCase();
    const normalizedSlug = (tenant_slug || '').trim();
    if (!normalizedSlug) return res.status(400).json({ error: 'Clinic ID required' });
    const tenantR = await query(`SELECT * FROM tenants WHERE slug=$1 AND status='active'`, [normalizedSlug]);
    if (!tenantR.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const tenant = tenantR.rows[0];
    const userR = await tenantQuery(tenant.schema_name,
      `SELECT * FROM users WHERE email=$1 AND is_active=true`, [normalizedEmail]);
    if (!userR.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, userR.rows[0].password_hash);
    if (!valid) {
      await query(`INSERT INTO admin_access_logs (email, tenant_id, event, ip_address, user_agent) VALUES ($1,$2,'login_failed',$3,$4)`,
        [normalizedEmail, tenant.id, req.ip, req.headers['user-agent']]).catch(() => {});
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const jti = crypto.randomUUID();
    const token = jwt.sign(
      { id: userR.rows[0].id, email: userR.rows[0].email, role: userR.rows[0].role, tenant_id: tenant.id, tenant_slug: normalizedSlug, jti },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    await query(`INSERT INTO admin_access_logs (user_id, email, tenant_id, event, ip_address, user_agent) VALUES ($1,$2,$3,'login_success',$4,$5)`,
      [userR.rows[0].id, userR.rows[0].email, tenant.id, req.ip, req.headers['user-agent']]).catch(() => {});
    res.json({
      token,
      user: { email: userR.rows[0].email, name: userR.rows[0].name, role: userR.rows[0].role, tenant: tenant.name, tenant_slug }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LOGOUT (blacklist token) ──────────────────────────────────
router.post('/auth/logout', authMiddleware, async (req, res) => {
  try {
    const { jti, exp } = req.user;
    if (jti && exp) {
      const expiresAt = new Date(exp * 1000).toISOString();
      await query(
        `INSERT INTO token_blacklist (jti, expires_at) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING`,
        [jti, expiresAt]
      );
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FORGOT PASSWORD ───────────────────────────────────────────
router.post('/auth/forgot-password', forgotPasswordLimiter, validate(schemas.forgotPassword), async (req, res) => {
  try {
    const { email, tenant_slug } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    // Always return success to prevent email enumeration
    res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });

    // Find user (either super admin or tenant user)
    let foundEmail = null;
    let tenantId = null;

    try {
      if (tenant_slug) {
        const tenantR = await query(`SELECT * FROM tenants WHERE slug=$1 AND status='active'`, [tenant_slug]);
        if (tenantR.rows[0]) {
          const userR = await tenantQuery(tenantR.rows[0].schema_name,
            `SELECT email FROM users WHERE email=$1 AND is_active=true`, [email.toLowerCase()]);
          if (userR.rows[0]) {
            foundEmail = userR.rows[0].email;
            tenantId = tenantR.rows[0].id;
          }
        }
      } else {
        const adminR = await query(`SELECT email FROM super_admins WHERE email=$1`, [email.toLowerCase()]);
        if (adminR.rows[0]) foundEmail = adminR.rows[0].email;
      }

      if (!foundEmail) return;

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

      // Invalidate any existing unused tokens for this email/tenant before creating a new one
      await query(
        `UPDATE password_resets SET used=true WHERE email=$1 AND tenant_id IS NOT DISTINCT FROM $2 AND used=false`,
        [foundEmail, tenantId]
      );
      await query(
        `INSERT INTO password_resets (email, tenant_id, token, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [foundEmail, tenantId, token, expiresAt]
      );

      const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${token}`;
      await emailService.sendPasswordReset(foundEmail, resetUrl);
    } catch (err) {
      logger.error('Forgot password background error', { error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CHANGE PASSWORD (authenticated) ──────────────────────────
router.post('/auth/change-password', changePasswordLimiter, authMiddleware, validate(schemas.changePassword), async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    const { role, id, email, tenant_id } = req.user;
    let currentHash;
    let tenantSchemaName = null;

    if (role === 'super_admin') {
      const r = await query(`SELECT password_hash FROM super_admins WHERE id=$1`, [id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
      currentHash = r.rows[0].password_hash;
    } else {
      // Fetch schema once, reuse for both SELECT and UPDATE
      const tenantR = await query(`SELECT schema_name FROM tenants WHERE id=$1`, [tenant_id]);
      if (!tenantR.rows[0]) return res.status(404).json({ error: 'Tenant not found' });
      tenantSchemaName = tenantR.rows[0].schema_name;
      const userR = await tenantQuery(tenantSchemaName,
        `SELECT password_hash FROM users WHERE id=$1`, [id]);
      if (!userR.rows[0]) return res.status(404).json({ error: 'User not found' });
      currentHash = userR.rows[0].password_hash;
    }

    const valid = await bcrypt.compare(current_password, currentHash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 12);

    if (role === 'super_admin') {
      await query(`UPDATE super_admins SET password_hash=$1 WHERE id=$2`, [hash, id]);
    } else {
      await tenantQuery(tenantSchemaName,
        `UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, id]);
    }

    // Audit log
    await query(`INSERT INTO admin_access_logs (user_id, email, event, ip_address, user_agent) VALUES ($1,$2,'password_changed',$3,$4)`,
      [id, email || req.user.email, req.ip, req.headers['user-agent']]).catch(() => {});

    logger.info('Password changed', { user_id: id, role });
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RESET PASSWORD ────────────────────────────────────────────
router.post('/auth/reset-password', resetPasswordLimiter, validate(schemas.resetPassword), async (req, res) => {
  try {
    const { token, password } = req.body;

    const r = await query(
      `SELECT * FROM password_resets WHERE token=$1 AND used=false AND expires_at > NOW()`,
      [token]
    );
    if (!r.rows[0]) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const reset = r.rows[0];
    const hash = await bcrypt.hash(password, 12);

    if (reset.tenant_id) {
      // Tenant user — verify tenant still exists and is active
      const tenantR = await query(`SELECT schema_name, status FROM tenants WHERE id=$1`, [reset.tenant_id]);
      if (!tenantR.rows[0]) {
        return res.status(410).json({ error: 'This clinic no longer exists. Contact support.' });
      }
      if (tenantR.rows[0].status !== 'active') {
        return res.status(403).json({ error: 'This clinic account is suspended. Contact support.' });
      }
      await tenantQuery(tenantR.rows[0].schema_name,
        `UPDATE users SET password_hash=$1 WHERE email=$2`, [hash, reset.email]);
    } else {
      // Super admin
      await query(`UPDATE super_admins SET password_hash=$1 WHERE email=$2`, [hash, reset.email]);
    }

    await query(`UPDATE password_resets SET used=true WHERE id=$1`, [reset.id]);
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
