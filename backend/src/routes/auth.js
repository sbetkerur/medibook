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
const { handleError } = require('../utils/errors');

// Skip rate limits outside production — same policy as the global authLimiter
// in index.js. Without this, repeated local test runs exhaust the hourly
// forgot-password allowance and the test suite starts failing with 429s.
const skipInDev = () => process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';

// ── Login rate limiter — 10 attempts per 15 minutes per IP ────
// Prevents brute-force and credential-stuffing attacks against both
// tenant admin and super admin login endpoints.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only count failed/all requests toward the limit
  skip: skipInDev,
});

// Strict limiters for unauthenticated sensitive endpoints
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many password reset requests. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInDev,
});

const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many reset attempts. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInDev,
});

const changePasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many password change attempts. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInDev,
});

// ── SUPER ADMIN LOGIN ─────────────────────────────────────────
router.post('/auth/superadmin/login', loginLimiter, validate(schemas.loginStrict), async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = (email || '').trim().toLowerCase();
    const r = await query(`SELECT * FROM super_admins WHERE email=$1`, [normalizedEmail]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!valid) {
      await query(`INSERT INTO admin_access_logs (email, event, ip_address, user_agent) VALUES ($1,'login_failed',$2,$3)`,
        [normalizedEmail, req.ip, req.headers['user-agent']]).catch(e => logger.warn('Audit log failed', { error: e.message }));
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const jti = crypto.randomUUID();
    const token = jwt.sign(
      { id: r.rows[0].id, email: r.rows[0].email, role: 'super_admin', jti },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    await query(`INSERT INTO admin_access_logs (user_id, email, event, ip_address, user_agent) VALUES ($1,$2,'login_success',$3,$4)`,
      [r.rows[0].id, r.rows[0].email, req.ip, req.headers['user-agent']]).catch(e => logger.warn('Audit log failed', { error: e.message }));
    const refreshToken = await issueRefreshToken(r.rows[0].id, 'super_admin').catch(() => null);
    res.json({ token, refresh_token: refreshToken, user: { email: r.rows[0].email, name: r.rows[0].name, role: 'super_admin' } });
  } catch (err) {
    handleError(res, err);
  }
});

// ── TENANT ADMIN LOGIN ────────────────────────────────────────
router.post('/auth/login', loginLimiter, validate(schemas.login), async (req, res) => {
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
        [normalizedEmail, tenant.id, req.ip, req.headers['user-agent']]).catch(e => logger.warn('Audit log failed', { error: e.message }));
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const jti = crypto.randomUUID();
    const token = jwt.sign(
      { id: userR.rows[0].id, email: userR.rows[0].email, role: userR.rows[0].role, tenant_id: tenant.id, tenant_slug: normalizedSlug, jti },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    await query(`INSERT INTO admin_access_logs (user_id, email, tenant_id, event, ip_address, user_agent) VALUES ($1,$2,$3,'login_success',$4,$5)`,
      [userR.rows[0].id, userR.rows[0].email, tenant.id, req.ip, req.headers['user-agent']]).catch(e => logger.warn('Audit log failed', { error: e.message }));
    const refreshToken = await issueRefreshToken(userR.rows[0].id, userR.rows[0].role, tenant.id).catch(() => null);
    res.json({
      token,
      refresh_token: refreshToken,
      user: { email: userR.rows[0].email, name: userR.rows[0].name, role: userR.rows[0].role, tenant: tenant.name, tenant_slug }
    });
  } catch (err) {
    handleError(res, err);
  }
});

// Hash a token for storage (refresh tokens AND password-reset tokens) — a DB
// leak must not yield usable credentials. The raw token is sent to the client
// once and never stored.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Helper: issue a refresh token (30-day, one-time-use). Only the SHA-256 hash
// is persisted; the raw token goes to the client.
async function issueRefreshToken(userId, userRole, tenantId = null) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await query(
    `INSERT INTO refresh_tokens (user_id, user_role, tenant_id, token, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [userId, userRole, tenantId, hashToken(token), expiresAt]
  );
  return token;
}

// ── REFRESH TOKEN ─────────────────────────────────────────────
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: { error: 'Too many refresh attempts. Please wait and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/auth/refresh', refreshLimiter, async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token || typeof refresh_token !== 'string') {
      return res.status(400).json({ error: 'refresh_token required' });
    }

    // SELECT FOR UPDATE inside a transaction prevents the race condition where two
    // simultaneous refresh calls both see used=false before either writes used=true.
    // Lookup is HASH-ONLY. Never add a raw-value fallback (`token IN (hash, raw)`):
    // it lets anyone who reads the stored hash replay it as the token itself,
    // defeating the point of hashing. Tokens issued before hashing are converted
    // in place by public-schema migration 18 (hash_plaintext_tokens).
    const { pool } = require('../db');
    const client = await pool.connect();
    let rt;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT * FROM refresh_tokens
         WHERE token=$1 AND used=false AND expires_at > NOW()
         FOR UPDATE`,
        [hashToken(refresh_token)]
      );
      if (!r.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Invalid or expired refresh token' });
      }
      rt = r.rows[0];
      await client.query(`UPDATE refresh_tokens SET used=true WHERE id=$1`, [rt.id]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    let tokenPayload = { id: rt.user_id, role: rt.user_role };

    if (rt.user_role === 'super_admin') {
      const adminR = await query(`SELECT email, name FROM super_admins WHERE id=$1`, [rt.user_id]);
      if (!adminR.rows[0]) return res.status(401).json({ error: 'User not found' });
      tokenPayload.email = adminR.rows[0].email;
    } else {
      if (!rt.tenant_id) return res.status(401).json({ error: 'Invalid refresh token' });
      const tenantR = await query(`SELECT slug, schema_name, status FROM tenants WHERE id=$1`, [rt.tenant_id]);
      if (!tenantR.rows[0] || tenantR.rows[0].status !== 'active') {
        return res.status(401).json({ error: 'Tenant not found or inactive' });
      }
      const userR = await tenantQuery(tenantR.rows[0].schema_name,
        `SELECT email, role FROM users WHERE id=$1 AND is_active=true`, [rt.user_id]);
      if (!userR.rows[0]) return res.status(401).json({ error: 'User not found or deactivated' });
      tokenPayload = {
        ...tokenPayload,
        email: userR.rows[0].email,
        role: userR.rows[0].role,
        tenant_id: rt.tenant_id,
        tenant_slug: tenantR.rows[0].slug,
      };
    }

    const jti = crypto.randomUUID();
    const newAccessToken = jwt.sign(
      { ...tokenPayload, jti },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const newRefreshToken = await issueRefreshToken(rt.user_id, rt.user_role, rt.tenant_id);

    res.json({ token: newAccessToken, refresh_token: newRefreshToken });
  } catch (err) {
    handleError(res, err);
  }
});

// ── LOGOUT (blacklist access token + revoke refresh tokens) ───
router.post('/auth/logout', authMiddleware, async (req, res) => {
  try {
    const { jti, exp, id: userId } = req.user;

    // Blacklist the current access token so it can't be reused before expiry
    if (jti && exp) {
      const expiresAt = new Date(exp * 1000).toISOString();
      await query(
        `INSERT INTO token_blacklist (jti, expires_at) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING`,
        [jti, expiresAt]
      ).catch(() => {});
    }

    // Revoke all active refresh tokens for this user so an attacker who
    // previously exfiltrated a refresh token can't issue new access tokens.
    await query(
      `UPDATE refresh_tokens SET used=true WHERE user_id=$1 AND used=false`,
      [userId]
    ).catch(() => {});

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    handleError(res, err);
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
      // Store only the SHA-256 hash — the raw token goes into the email link once.
      await query(
        `INSERT INTO password_resets (email, tenant_id, token, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [foundEmail, tenantId, hashToken(token), expiresAt]
      );

      const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${token}`;
      await emailService.sendPasswordReset(foundEmail, resetUrl);
    } catch (err) {
      logger.error('Forgot password background error', { error: err.message });
    }
  } catch (err) {
    handleError(res, err);
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
      [id, email || req.user.email, req.ip, req.headers['user-agent']]).catch(e => logger.warn('Audit log failed', { error: e.message }));

    logger.info('Password changed', { user_id: id, role });
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    handleError(res, err);
  }
});

// ── RESET PASSWORD ────────────────────────────────────────────
router.post('/auth/reset-password', resetPasswordLimiter, validate(schemas.resetPassword), async (req, res) => {
  try {
    const { token, password } = req.body;

    // Use SELECT FOR UPDATE inside a transaction to prevent two simultaneous
    // reset requests from both consuming the same token. Tenant validity is
    // checked BEFORE marking the token used — otherwise a suspended-clinic
    // user's only reset token would be burned by a failed attempt.
    const { pool } = require('../db');
    const client = await pool.connect();
    let reset;
    let tenantSchema = null;
    try {
      await client.query('BEGIN');
      // Lookup is HASH-ONLY — same rationale as /auth/refresh: a raw-value
      // fallback would let a leaked stored hash be replayed as the token itself.
      // Pre-hashing rows are converted by migration 18 (hash_plaintext_tokens).
      const r = await client.query(
        `SELECT * FROM password_resets WHERE token=$1 AND used=false AND expires_at > NOW() FOR UPDATE`,
        [hashToken(token)]
      );
      if (!r.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid or expired reset token' });
      }
      reset = r.rows[0];

      if (reset.tenant_id) {
        // Tenant user — verify tenant still exists and is active before consuming the token
        const tenantR = await client.query(`SELECT schema_name, status FROM tenants WHERE id=$1`, [reset.tenant_id]);
        if (!tenantR.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(410).json({ error: 'This clinic no longer exists. Contact support.' });
        }
        if (tenantR.rows[0].status !== 'active') {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'This clinic account is suspended. Contact support.' });
        }
        tenantSchema = tenantR.rows[0].schema_name;
      }

      await client.query(`UPDATE password_resets SET used=true WHERE id=$1`, [reset.id]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    const hash = await bcrypt.hash(password, 12);

    if (tenantSchema) {
      await tenantQuery(tenantSchema,
        `UPDATE users SET password_hash=$1 WHERE email=$2`, [hash, reset.email]);
    } else {
      // Super admin
      await query(`UPDATE super_admins SET password_hash=$1 WHERE email=$2`, [hash, reset.email]);
    }

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
