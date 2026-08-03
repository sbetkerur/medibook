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

// Unsubscribe is unauthenticated AND its handler walks every active tenant
// schema, so an unthrottled caller could turn one HTTP request into N database
// round-trips across the whole platform. Kept deliberately tighter than the
// global 500/min limiter; a real recipient clicks the link once.
const unsubscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { error: 'Too many unsubscribe attempts. Try again in an hour.' },
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
      // normalizedSlug, not the raw body value — the client stores this and
      // sends it back on subsequent logins, so returning an untrimmed copy
      // would hand back a slug that no longer matches the one we looked up.
      // Deliberately NO terms status here. It was added on the theory that it
      // saved a round trip, but the dashboard reads GET /admin/terms on mount
      // anyway, so this only duplicated the rule in a second place where it
      // could drift. One source of truth; see routes/admin.js.
      user: { email: userR.rows[0].email, name: userR.rows[0].name, role: userR.rows[0].role, tenant: tenant.name, tenant_slug: normalizedSlug }
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

// Shared helper behind /auth/refresh and /auth/reset-password: both need to lock
// a single-use token row (SELECT ... FOR UPDATE) inside a transaction so two
// simultaneous requests can't both consume the same token, then let the caller
// validate the row and any related state before deciding whether to commit.
//
// `callback(client, row)` runs inside BEGIN/COMMIT (row is undefined if no match)
// and must return either:
//   - { abort: true, status, body } to ROLLBACK and have the route send that response, or
//   - { value } to COMMIT and continue processing `value` after the transaction closes.
async function withRowLock(selectSql, selectParams, callback) {
  const { pool } = require('../db');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(selectSql, selectParams);
    const outcome = await callback(client, r.rows[0]);
    if (outcome.abort) {
      await client.query('ROLLBACK');
      return outcome;
    }
    await client.query('COMMIT');
    return outcome;
  } catch (txErr) {
    await client.query('ROLLBACK').catch(() => {});
    throw txErr;
  } finally {
    client.release();
  }
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
    const outcome = await withRowLock(
      `SELECT * FROM refresh_tokens
       WHERE token=$1 AND used=false AND expires_at > NOW()
       FOR UPDATE`,
      [hashToken(refresh_token)],
      async (client, row) => {
        if (!row) return { abort: true, status: 401, body: { error: 'Invalid or expired refresh token' } };
        await client.query(`UPDATE refresh_tokens SET used=true WHERE id=$1`, [row.id]);
        return { value: row };
      }
    );
    if (outcome.abort) return res.status(outcome.status).json(outcome.body);
    const rt = outcome.value;

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
// Public, unauthenticated capability probe. /auth/forgot-password deliberately
// returns success regardless of whether the address exists (to prevent account
// enumeration) — which means that with no email provider configured it also
// reports success while delivering nothing. The login page uses this to hide
// the "Forgot your password?" link rather than send users into that dead end.
router.get('/auth/capabilities', (req, res) => {
  res.json({ password_reset_enabled: !!process.env.RESEND_API_KEY });
});

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

      // frontendBaseUrl(), not the raw env var: FRONTEND_URL may list several
      // origins, and interpolating the whole list produces a reset link nobody
      // can open — which locks every user out of password recovery.
      const resetUrl = `${require('../utils/appUrls').frontendBaseUrl()}/reset-password?token=${token}`;
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

    // Revoke all outstanding refresh tokens — a password change must evict
    // anyone holding a stolen refresh token. The current session keeps its
    // access token until expiry (≤1h) and then must log in again.
    await query(`UPDATE refresh_tokens SET used=true WHERE user_id=$1 AND used=false`, [id])
      .catch(e => logger.warn('Refresh-token revocation failed after password change', { error: e.message }));

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
    const outcome = await withRowLock(
      // Lookup is HASH-ONLY — same rationale as /auth/refresh: a raw-value
      // fallback would let a leaked stored hash be replayed as the token itself.
      // Pre-hashing rows are converted by migration 18 (hash_plaintext_tokens).
      `SELECT * FROM password_resets WHERE token=$1 AND used=false AND expires_at > NOW() FOR UPDATE`,
      [hashToken(token)],
      async (client, row) => {
        if (!row) return { abort: true, status: 400, body: { error: 'Invalid or expired reset token' } };

        let tenantSchema = null;
        if (row.tenant_id) {
          // Tenant user — verify tenant still exists and is active before consuming the token
          const tenantR = await client.query(`SELECT schema_name, status FROM tenants WHERE id=$1`, [row.tenant_id]);
          if (!tenantR.rows[0]) {
            return { abort: true, status: 410, body: { error: 'This clinic no longer exists. Contact support.' } };
          }
          if (tenantR.rows[0].status !== 'active') {
            return { abort: true, status: 403, body: { error: 'This clinic account is suspended. Contact support.' } };
          }
          tenantSchema = tenantR.rows[0].schema_name;
        }

        await client.query(`UPDATE password_resets SET used=true WHERE id=$1`, [row.id]);
        return { value: { reset: row, tenantSchema } };
      }
    );
    if (outcome.abort) return res.status(outcome.status).json(outcome.body);
    const { reset, tenantSchema } = outcome.value;

    const hash = await bcrypt.hash(password, 12);

    let resetUserId = null;
    if (tenantSchema) {
      const upd = await tenantQuery(tenantSchema,
        `UPDATE users SET password_hash=$1 WHERE email=$2 RETURNING id`, [hash, reset.email]);
      resetUserId = upd.rows[0]?.id || null;
    } else {
      // Super admin
      const upd = await query(`UPDATE super_admins SET password_hash=$1 WHERE email=$2 RETURNING id`, [hash, reset.email]);
      resetUserId = upd.rows[0]?.id || null;
    }

    // Revoke all outstanding refresh tokens — resetting the password is the
    // account-recovery path, so it must end any session an attacker holds.
    if (resetUserId) {
      await query(`UPDATE refresh_tokens SET used=true WHERE user_id=$1 AND used=false`, [resetUserId])
        .catch(e => logger.warn('Refresh-token revocation failed after password reset', { error: e.message }));
    }

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    handleError(res, err);
  }
});

// ── EMAIL UNSUBSCRIBE ─────────────────────────────────────────
// Public and unauthenticated: the only thing the caller holds is the token
// embedded in the footer of a booking-confirmation / reminder email
// (services/email.js → generateUnsubscribeUrl).
//
// `email_unsubscribes` is a PER-TENANT table and there is no tenant context on
// an emailed link — no cookie, no JWT, no slug — so the token has to be looked
// up by sweeping the active tenants, the same shape as the Resend bounce
// handler in index.js. Every schema name is re-validated before use and all
// tenant SQL goes through tenantQuery; a schema name is never interpolated.
const UNSUB_TOKEN_RE = /^[a-f0-9]{64}$/;      // crypto.randomBytes(32).toString('hex')
const UNSUB_SCHEMA_RE = /^tenant_[a-z0-9_]+$/;

router.post('/unsubscribe', unsubscribeLimiter, async (req, res) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim().toLowerCase() : '';
    // Shape check first: without it every stray querystring value would trigger
    // a full sweep of every tenant schema, which is the expensive path.
    if (!UNSUB_TOKEN_RE.test(token)) {
      return res.status(400).json({ error: 'This unsubscribe link is invalid or incomplete.' });
    }

    const tenants = await query(`SELECT id, schema_name FROM tenants WHERE status='active'`);
    for (const t of tenants.rows) {
      if (!UNSUB_SCHEMA_RE.test(t.schema_name)) continue; // never touch an unvalidated schema name
      try {
        // COALESCE, not a bare NOW(): a second click (mail clients and security
        // scanners routinely re-fetch links) must stay idempotent and keep the
        // ORIGINAL opt-out timestamp rather than sliding it forward.
        const upd = await tenantQuery(t.schema_name,
          `UPDATE email_unsubscribes
              SET unsubscribed_at = COALESCE(unsubscribed_at, NOW())
            WHERE token = $1
            RETURNING id`,
          [token]);
        if (upd.rows[0]) {
          logger.info('Email unsubscribe recorded', { tenant_id: t.id });
          break; // tokens are globally unique — first match is the only match
        }
      } catch (err) {
        // One tenant schema failing (older schema without the table, a lock
        // timeout) must not abort the sweep and strand the recipient's opt-out
        // in a schema further down the list.
        logger.warn('Unsubscribe lookup failed for a tenant schema', { tenant_id: t.id, error: err.message });
      }
    }

    // Identical response whether or not the token matched — a "not found" here
    // would make this endpoint an oracle for guessing valid unsubscribe tokens,
    // each of which identifies a real patient at a real clinic.
    res.json({ success: true, message: 'You have been unsubscribed from these emails.' });
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
