const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { ERRORS } = require('../utils/errors');
const logger = require('../utils/logger');
const { setTenantId } = require('../utils/requestContext');

// ── In-memory tenant cache (5s TTL) ──────────────────────────
// Avoids a DB round-trip on every authenticated request.
// 5s TTL means a suspended tenant is blocked within 5 seconds
// even without an explicit cache invalidation call.
const TENANT_CACHE_TTL_MS = 5000;
const tenantCache = new Map(); // key: tenantId → { tenant, expiresAt }

// Which tenant statuses may reach the dashboard at all.
//   active         — normal, live to patients.
//   pending_review — a self-serve tenant that has paid and provisioned but is
//                    NOT yet approved by a super admin. Let IN so the owner can
//                    complete the onboarding wizard; the bot's entry-code lookup
//                    still requires status='active', so patients cannot reach it
//                    until POST /superadmin/tenants/:id/approve flips it.
//   past_due       — a self-serve tenant whose card later failed. Let IN so the
//                    owner can update payment (routes/billing.js);
//                    jobs/billingDunning.js escalates it to 'suspended' after
//                    the grace window.
// Blocked: 'suspended' (kill switch / abuse), 'inactive' (deactivated),
// 'pending_payment' (signup started, schema not built — no user row exists).
// Outreach crons filter status='active' on their own, so pending_review /
// past_due tenants are already excluded from every unsolicited send.
const DASHBOARD_ALLOWED_STATUSES = new Set(['active', 'pending_review', 'past_due']);

async function authMiddleware(req, res, next) {
  // Support token in Authorization header (normal) or ?token= query param.
  // The query-param form exists ONLY for EventSource (SSE), which can't set
  // headers — accepting it everywhere would let tokens leak into proxy access
  // logs, browser history and Referer headers on any admin call.
  // Exact match, not endsWith: this middleware is mounted on /api/admin and
  // /api/v1/admin, so req.path is router-relative and the SSE route is exactly
  // '/events'. endsWith admitted the query-param token on ANY path ending in
  // those characters — no current route abuses it, but the comment above states
  // the header-only intent and that surface grows with every route added.
  const isSSE = req.path === '/events';
  const headerToken = (req.headers.authorization || '').replace('Bearer ', '');
  const token = (headerToken || (isSSE ? req.query.token : '') || '').trim();
  if (!token) return res.status(401).json({ error: ERRORS.NO_TOKEN });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // JWT revocation check via token_blacklist table
    if (decoded.jti) {
      try {
        const bl = await query(
          `SELECT 1 FROM token_blacklist WHERE jti=$1 AND expires_at > NOW()`,
          [decoded.jti]
        );
        if (bl.rows.length > 0) {
          return res.status(401).json({ error: ERRORS.TOKEN_REVOKED });
        }
      } catch (err) {
        // Only silently allow through if the table doesn't exist yet (first deploy).
        // Use the PostgreSQL error code for "undefined_table" (more reliable than message matching).
        // Any other DB error fails CLOSED (denies the request) — kept consistent
        // with checkIPAllowlist below, which now also fails closed on DB errors.
        if (err.code === '42P01') {
          // table not yet created — allow through
        } else {
          return res.status(401).json({ error: ERRORS.TOKEN_VALIDATION_UNAVAILABLE });
        }
      }
    }

    req.user = decoded;
    req.token = token;
    next();
  } catch (err) {
    logger.warn('JWT verification failed', { error: err.message });
    res.status(401).json({ error: ERRORS.TOKEN_INVALID });
  }
}

async function tenantMiddleware(req, res, next) {
  try {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return res.status(403).json({ error: 'No tenant associated with this token' });

    // Check cache first — also recheck status in case tenant was suspended since last fetch
    const cached = tenantCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
      if (!DASHBOARD_ALLOWED_STATUSES.has(cached.tenant.status)) {
        tenantCache.delete(tenantId);
        return res.status(403).json({ error: 'Tenant not found or inactive' });
      }
      req.tenant = cached.tenant;
      setTenantId(cached.tenant.id);

      // IP allowlist check (only if tenant has allowlist configured)
      const clientIp = (req.ip || req.connection?.remoteAddress || '').replace('::ffff:', '');
      const allowed = await checkIPAllowlist(req.tenant.id, clientIp);
      if (!allowed) {
        return res.status(403).json({
          error: 'Access denied: your IP address is not in the allowed list for this account.',
          ip: clientIp,
        });
      }

      return next();
    }

    const r = await query(`SELECT * FROM tenants WHERE id=$1`, [tenantId]);
    if (!r.rows[0] || !DASHBOARD_ALLOWED_STATUSES.has(r.rows[0].status)) {
      return res.status(403).json({ error: 'Tenant not found or inactive' });
    }

    req.tenant = r.rows[0];
    // Stamped HERE, on both the cache-hit and cache-miss paths, because this is
    // the one place every /api/admin request resolves its tenant. It used to be
    // called from routes/appointments.js and routes/patients.js only, so a 500
    // raised in any of the other dozen admin routers logged a requestId with no
    // tenantId — and an operator triaging a multi-clinic incident could not tell
    // which clinic the failure belonged to. Worse than absent: present for two
    // routers and missing for the rest reads as an unreliable field.
    setTenantId(r.rows[0].id);
    tenantCache.set(tenantId, { tenant: r.rows[0], expiresAt: Date.now() + TENANT_CACHE_TTL_MS });

    // IP allowlist check (only if tenant has allowlist configured)
    const clientIp = (req.ip || req.connection?.remoteAddress || '').replace('::ffff:', '');
    const allowed = await checkIPAllowlist(req.tenant.id, clientIp);
    if (!allowed) {
      return res.status(403).json({
        error: 'Access denied: your IP address is not in the allowed list for this account.',
        ip: clientIp,
      });
    }

    next();
  } catch (err) {
    res.status(500).json({ error: 'Tenant lookup failed' });
  }
}

function invalidateTenantCache(tenantId) {
  tenantCache.delete(tenantId);
  allowlistExistsCache.delete(tenantId);
}

// Cache whether a tenant has ANY IP allowlist rows (60s TTL). The vast
// majority of tenants have none, so this skips a DB round-trip on every
// authenticated request. When rows exist we still query per-request to
// match the client IP against CIDR ranges.
const ALLOWLIST_CACHE_TTL_MS = 60 * 1000;
const allowlistExistsCache = new Map(); // tenantId → { exists, expiresAt }

async function checkIPAllowlist(tenantId, clientIp) {
  if (!tenantId) return true; // no allowlist to check for this request
  if (!clientIp) return false; // cannot determine client IP — fail closed

  const cached = allowlistExistsCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now() && cached.exists === false) {
    return true; // no allowlist configured — allow all (cached)
  }

  try {
    // Normalise IPv4-mapped IPv6 addresses (e.g. "::ffff:192.168.1.1" → "192.168.1.1")
    const normalizedIp = clientIp.replace(/^::ffff:/i, '');

    // Delegate CIDR matching to PostgreSQL's built-in inet/cidr operators.
    // <<= means "is contained within or equal to" (handles both exact IPs and CIDR ranges).
    // We also check whether any allowlist exists at all in the same query to avoid
    // an extra round-trip.
    const r = await query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE $2::inet <<= cidr::inet) AS matched
       FROM tenant_ip_allowlist
       WHERE tenant_id=$1`,
      [tenantId, normalizedIp]
    );

    const total = parseInt(r.rows[0]?.total || 0);
    allowlistExistsCache.set(tenantId, { exists: total > 0, expiresAt: Date.now() + ALLOWLIST_CACHE_TTL_MS });
    if (total === 0) return true; // no allowlist configured — allow all

    const matched = parseInt(r.rows[0]?.matched || 0);
    return matched > 0;
  } catch (err) {
    // If the IP string is not valid inet format, PostgreSQL throws a cast error.
    // Treat invalid client IPs as blocked (fail closed) to prevent bypass via
    // malformed X-Forwarded-For headers.
    if (err.message && err.message.includes('invalid input syntax for type inet')) {
      logger.warn('checkIPAllowlist: invalid client IP format', { clientIp });
      return false;
    }
    // Fail closed ONLY for tenants that actually have an allowlist. For the
    // vast majority that have never configured one, denying on an unrelated DB
    // blip locked every admin out of a feature they do not use — and reported
    // it as "your IP address is not in the allowed list", which sends whoever
    // debugs it in completely the wrong direction. A stale "no allowlist
    // exists" reading is sufficient evidence here: the worst case is that a
    // brand-new allowlist is not enforced for up to ALLOWLIST_CACHE_TTL_MS,
    // which is already true of the fast path above.
    if (cached && cached.exists === false) {
      logger.warn('checkIPAllowlist DB error — tenant has no allowlist (stale cache), allowing', { error: err.message });
      return true;
    }
    logger.warn('checkIPAllowlist DB error, denying access (fail closed)', { error: err.message });
    return false;
  }
}

module.exports = { authMiddleware, tenantMiddleware, invalidateTenantCache, checkIPAllowlist };
