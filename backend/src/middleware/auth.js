const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { ERRORS } = require('../utils/errors');
const logger = require('../utils/logger');

// ── In-memory tenant cache (5s TTL) ──────────────────────────
// Avoids a DB round-trip on every authenticated request.
// 5s TTL means a suspended tenant is blocked within 5 seconds
// even without an explicit cache invalidation call.
const TENANT_CACHE_TTL_MS = 5000;
const tenantCache = new Map(); // key: tenantId → { tenant, expiresAt }

async function authMiddleware(req, res, next) {
  // Support token in Authorization header (normal) or ?token= query param (SSE, EventSource)
  const token = ((req.headers.authorization || '').replace('Bearer ', '') || req.query.token || '').trim();
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
      if (cached.tenant.status !== 'active') {
        tenantCache.delete(tenantId);
        return res.status(403).json({ error: 'Tenant not found or inactive' });
      }
      req.tenant = cached.tenant;

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

    const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [tenantId]);
    if (!r.rows[0]) return res.status(403).json({ error: 'Tenant not found or inactive' });

    req.tenant = r.rows[0];
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
    // Other DB errors — fail open so a DB blip doesn't lock out all admins
    logger.warn('checkIPAllowlist DB error, allowing through', { error: err.message });
    return true;
  }
}

module.exports = { authMiddleware, tenantMiddleware, invalidateTenantCache, checkIPAllowlist };
