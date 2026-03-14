const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { ERRORS } = require('../utils/errors');

// ── In-memory tenant cache (5s TTL) ──────────────────────────
// Avoids a DB round-trip on every authenticated request.
// 5s TTL means a suspended tenant is blocked within 5 seconds
// even without an explicit cache invalidation call.
const TENANT_CACHE_TTL_MS = 5000;
const tenantCache = new Map(); // key: tenantId → { tenant, expiresAt }

async function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
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
  } catch {
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
      return next();
    }

    const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [tenantId]);
    if (!r.rows[0]) return res.status(403).json({ error: 'Tenant not found or inactive' });

    req.tenant = r.rows[0];
    tenantCache.set(tenantId, { tenant: r.rows[0], expiresAt: Date.now() + TENANT_CACHE_TTL_MS });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Tenant lookup failed' });
  }
}

function invalidateTenantCache(tenantId) {
  tenantCache.delete(tenantId);
}

module.exports = { authMiddleware, tenantMiddleware, invalidateTenantCache };
