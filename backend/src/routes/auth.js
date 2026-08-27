const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { query, tenantQuery } = require('../db');
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const logger = require('../utils/logger');
const { handleError } = require('../utils/errors');

// Skip rate limits outside production — same policy as the global authLimiter
// in index.js. Without this, repeated local test runs exhaust the hourly
// forgot-password allowance and the test suite starts failing with 429s.
const skipInDev = () => process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';

// A tenant admin may sign in while the clinic is still being reviewed
// (self-serve signup, awaiting super-admin approval) or is past_due on payment —
// both need dashboard access to move forward. Same set middleware/auth.js
// enforces on every /api/admin request. 'suspended' / 'inactive' cannot log in.
const LOGIN_ALLOWED_STATUSES = ['active', 'pending_review', 'past_due'];

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
    if (!r.rows[0]) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH); // equalise timing
      return res.status(401).json({ error: 'Invalid credentials' });
    }
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
    const refreshToken = await issueRefreshToken(r.rows[0].id, 'super_admin')
      .catch(e => { logger.error('Refresh token issue failed', { user_id: r.rows[0].id, role: 'super_admin', error: e.message }); return null; });
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
    const tenantR = await query(
      `SELECT * FROM tenants WHERE slug=$1 AND status = ANY($2::text[])`,
      [normalizedSlug, LOGIN_ALLOWED_STATUSES]
    );
    if (!tenantR.rows[0]) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH); // equalise timing
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const tenant = tenantR.rows[0];
    const userR = await tenantQuery(tenant.schema_name,
      `SELECT * FROM users WHERE email=$1 AND is_active=true`, [normalizedEmail]);
    if (!userR.rows[0]) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH); // equalise timing
      return res.status(401).json({ error: 'Invalid credentials' });
    }
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
    // Logged, not swallowed. Returning 200 with a null refresh token is
    // defensible — the access token works and the user gets on with their day —
    // but the silence was not: an hour later they are bounced to the login
    // screen mid-shift with nothing anywhere explaining why.
    const refreshToken = await issueRefreshToken(userR.rows[0].id, userR.rows[0].role, tenant.id)
      .catch(e => { logger.error('Refresh token issue failed', { user_id: userR.rows[0].id, role: userR.rows[0].role, tenant: tenant.slug, error: e.message }); return null; });
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
      // tenant_status lets the dashboard show the right banner without an extra
      // round trip: 'pending_review' (awaiting super-admin approval — patients
      // can't reach the clinic yet) or 'past_due' (update payment).
      user: { email: userR.rows[0].email, name: userR.rows[0].name, role: userR.rows[0].role, tenant: tenant.name, tenant_slug: normalizedSlug, tenant_status: tenant.status }
    });
  } catch (err) {
    handleError(res, err);
  }
});

// Hash a refresh token for storage — a DB leak must not yield usable
// credentials. The raw token is sent to the client once and never stored.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Shared helper behind /auth/refresh: it needs to lock
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

// A real bcrypt hash of a value nobody knows, compared against on the
// user-not-found and tenant-not-found paths so all three login outcomes cost
// the same. Without it a 401 that skipped bcrypt returned in ~2ms while a wrong
// password took ~200ms (cost 12), which turns the login form into an oracle:
// fast means "no such clinic slug" or "no such staff email", slow means "that IS
// a live account here". The 10-per-15-min IP limiter slows enumeration but does
// not remove the signal, and the pairs it yields feed credential stuffing.
// Generated once at module load rather than per request.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equalisation-placeholder', 12);

// How recently a refresh token must have been redeemed for a second
// presentation of it to count as the user's own tabs racing rather than a
// replay. Long enough to cover a lock-less double refresh and a slow network,
// far shorter than any window a stolen token is used in.
const REFRESH_RACE_GRACE_SECONDS = 15;

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

/**
 * Mint a full session (access + refresh) for a tenant user — the same pair
 * POST /auth/login returns. Exported so routes/signup.js can drop a freshly
 * self-enrolled owner straight into the onboarding wizard without a second
 * password prompt. `tenant` is a tenants row; `user` is a tenant-schema users row.
 */
async function issueSession(user, tenant) {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, tenant_id: tenant.id, tenant_slug: tenant.slug, jti },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  const refresh_token = await issueRefreshToken(user.id, user.role, tenant.id).catch(() => null);
  return {
    token,
    refresh_token,
    user: { email: user.email, name: user.name, role: user.role, tenant: tenant.name, tenant_slug: tenant.slug, tenant_status: tenant.status },
  };
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
        if (!row) {
          // REUSE DETECTION. A miss has two very different causes: a token that
          // never existed, and one that was already redeemed. Rotation alone
          // does not protect a stolen token — the thief redeems RT1 first and
          // gets RT2, the real user's RT1 then 401s, they simply log in again,
          // and the thief keeps rotating RT2 -> RT3 -> ... for the full 30 days
          // with nothing anywhere recording that a used token was replayed.
          //
          // A replayed used token means the family is compromised, so the whole
          // family is revoked: both parties are forced to re-authenticate, which
          // is a minor annoyance for the legitimate user and the end of the
          // session for the thief. Looked up inside the same transaction as the
          // rotation so a concurrent redeem cannot slip between the two reads.
          const replayed = await client.query(
            `SELECT user_id, user_role, tenant_id,
                    (used_at IS NOT NULL AND used_at > NOW() - make_interval(secs => $2::int)) AS just_now
               FROM refresh_tokens
              WHERE token=$1 AND used=true`,
            [hashToken(refresh_token), REFRESH_RACE_GRACE_SECONDS]
          );
          const hit = replayed.rows[0];
          // A token redeemed moments ago is the user's own tabs racing, not a
          // thief. The client serialises refreshes with a Web Lock and carries
          // an explicit fallback for browsers without them, so this genuinely
          // happens — and treating it as theft would log people out of a working
          // session at random. The thief's replay comes minutes to days after
          // the redeem it followed, well outside this window, so detection is
          // kept. A plain 401 sends the racing tab down api.js's existing
          // "another tab already rotated it" recovery path.
          if (hit && !hit.just_now) {
            // Detected here, acted on after the transaction: `abort` ROLLBACKs,
            // so a revocation written inside it would be undone.
            return {
              abort: true, status: 401,
              body: { error: 'This session has been ended for security. Please sign in again.' },
              reuse: { userId: hit.user_id, userRole: hit.user_role, tenantId: hit.tenant_id },
            };
          }
          return { abort: true, status: 401, body: { error: 'Invalid or expired refresh token' } };
        }
        await client.query(`UPDATE refresh_tokens SET used=true, used_at=NOW() WHERE id=$1`, [row.id]);
        return { value: row };
      }
    );
    if (outcome.abort) {
      if (outcome.reuse) {
        // Revoke every outstanding token for this user, then record it where an
        // operator triaging the account will actually look.
        await query(
          `UPDATE refresh_tokens SET used=true WHERE user_id=$1 AND used=false`,
          [outcome.reuse.userId]
        ).catch(e => logger.error('Refresh reuse: family revocation failed', { error: e.message }));
        await query(
          `INSERT INTO admin_access_logs (user_id, tenant_id, event, ip_address, user_agent)
           VALUES ($1,$2,'refresh_token_reuse',$3,$4)`,
          [outcome.reuse.userId, outcome.reuse.tenantId, req.ip, req.headers['user-agent']]
        ).catch(e => logger.warn('Audit log failed', { error: e.message }));
        logger.warn('Refresh token reuse detected — revoked token family', {
          user_id: outcome.reuse.userId, role: outcome.reuse.userRole, ip: req.ip,
        });
      }
      return res.status(outcome.status).json(outcome.body);
    }
    const rt = outcome.value;

    let tokenPayload = { id: rt.user_id, role: rt.user_role };

    if (rt.user_role === 'super_admin') {
      const adminR = await query(`SELECT email, name FROM super_admins WHERE id=$1`, [rt.user_id]);
      if (!adminR.rows[0]) return res.status(401).json({ error: 'User not found' });
      tokenPayload.email = adminR.rows[0].email;
    } else {
      if (!rt.tenant_id) return res.status(401).json({ error: 'Invalid refresh token' });
      const tenantR = await query(`SELECT slug, schema_name, status FROM tenants WHERE id=$1`, [rt.tenant_id]);
      if (!tenantR.rows[0] || !LOGIN_ALLOWED_STATUSES.includes(tenantR.rows[0].status)) {
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



// ── PASSWORD RECOVERY — WHATSAPP CODE ────────────────────────
// The email-based /auth/forgot-password + /auth/reset-password were removed with
// services/email.js. This pair is their replacement over the ONLY channel this
// product has: a 6-digit code to the staff member's own `notify_phone`.
//
// It does NOT reintroduce a second delivery channel in the sense CLAUDE.md
// forbids — nothing patient-facing changes, no email, and the code is delivered
// through the same WhatsApp sender everything else uses. A user with no
// notify_phone on file still has the admin/super-admin reset paths.
//
// Enumeration-safe: the response is identical whether or not the account (or a
// phone) exists.
const { issueOtp, verifyOtp } = require('../services/otp');

const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Too many reset requests. Try again later.' },
  standardHeaders: true, legacyHeaders: false, skip: skipInDev,
});
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  message: { error: 'Too many attempts. Try again in an hour.' },
  standardHeaders: true, legacyHeaders: false, skip: skipInDev,
});

const GENERIC_FORGOT_REPLY = {
  message: 'If that account has a WhatsApp number on file, a reset code has been sent to it. It expires in 10 minutes.',
};

async function lookupResetTarget(tenant_slug, email) {
  const slug = String(tenant_slug || '').trim();
  const normEmail = String(email || '').trim().toLowerCase();
  if (!slug || !normEmail) return null;
  const tr = await query(
    `SELECT * FROM tenants WHERE slug=$1 AND status = ANY($2::text[])`,
    [slug, LOGIN_ALLOWED_STATUSES]
  );
  const tenant = tr.rows[0];
  if (!tenant) return null;
  const ur = await tenantQuery(tenant.schema_name,
    `SELECT id, email, notify_phone FROM users WHERE email=$1 AND is_active=true`, [normEmail]);
  const user = ur.rows[0];
  if (!user || !user.notify_phone) return { tenant, user: user || null };
  return { tenant, user };
}

router.post('/auth/forgot-password', forgotLimiter, async (req, res) => {
  try {
    const { tenant_slug, email } = req.body || {};
    const target = await lookupResetTarget(tenant_slug, email);
    if (target && target.user && target.user.notify_phone) {
      const phone = String(target.user.notify_phone).replace(/[^\d]/g, '');
      await issueOtp(phone, 'password_reset', {
        tenant_id: target.tenant.id, user_id: target.user.id,
      }).catch(e => logger.warn('forgot-password OTP issue failed', { error: e.message }));
      logger.info('Password reset code requested', { tenant: target.tenant.slug });
    }
    return res.json(GENERIC_FORGOT_REPLY);
  } catch (err) {
    // Never leak — still answer generically.
    logger.error('forgot-password error', { error: err.message });
    return res.json(GENERIC_FORGOT_REPLY);
  }
});

router.post('/auth/reset-password', resetLimiter, async (req, res) => {
  try {
    const { tenant_slug, email, code, new_password } = req.body || {};
    const policyErr = require('../middleware/validate').checkPasswordPolicy(new_password);
    if (policyErr) return res.status(400).json({ error: policyErr });

    const target = await lookupResetTarget(tenant_slug, email);
    if (!target || !target.user || !target.user.notify_phone) {
      return res.status(400).json({ error: 'Invalid or expired reset code.' });
    }
    const phone = String(target.user.notify_phone).replace(/[^\d]/g, '');
    const check = await verifyOtp(phone, 'password_reset', code);
    if (!check.ok) return res.status(400).json({ error: check.error || 'Invalid or expired reset code.' });
    // Bind the code to the exact account it was issued for.
    if (check.payload?.user_id && check.payload.user_id !== target.user.id) {
      return res.status(400).json({ error: 'Invalid or expired reset code.' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await tenantQuery(target.tenant.schema_name,
      `UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, target.user.id]);
    await query(`UPDATE refresh_tokens SET used=true WHERE user_id=$1 AND used=false`, [target.user.id])
      .catch(e => logger.warn('reset-password: token revocation failed', { error: e.message }));
    await query(
      `INSERT INTO admin_access_logs (user_id, email, tenant_id, event, ip_address, user_agent)
       VALUES ($1,$2,$3,'password_reset_whatsapp',$4,$5)`,
      [target.user.id, target.user.email, target.tenant.id, req.ip, req.headers['user-agent']]
    ).catch(() => {});
    logger.info('Password reset via WhatsApp code', { tenant: target.tenant.slug });
    res.json({ success: true, message: 'Password updated. Sign in with your new password.' });
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
module.exports.issueSession = issueSession;
module.exports.LOGIN_ALLOWED_STATUSES = LOGIN_ALLOWED_STATUSES;
