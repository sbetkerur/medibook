'use strict';
const { incrWithTTL } = require('../utils/redisClient');
const { query } = require('../db');
const logger = require('../utils/logger');
const axios = require('axios');

// API requests per minute. Deliberately NOT read from the `plans` table: this
// is an abuse guard, not a product quota, and it has to answer on every request
// without a DB round-trip. Keys must stay in sync with the tiers seeded in
// db/migrate.js — an unknown plan falls back to the starter limit below.
const PLAN_LIMITS = {
// Professional keeps a real ceiling even though it is the top tier and has
// unlimited APPOINTMENTS and DOCTORS. Those are product quotas; this is an
// abuse guard, and the old unlimited entry existed for a ₹9,999 tier that no
// longer does. 300/min is ~5 requests a second — far above any real dashboard.
  starter: 60,
  professional: 300,
};

// Per-endpoint overrides (req.path pattern -> max per minute)
// Tenant can store { "/admin/appointments": 200 } in settings.rate_limits.
// NOTE: this middleware is mounted at /api/admin, so req.path is the path AFTER
// the mount point (e.g. "/appointments"). Accept patterns with or without the
// "/admin" prefix so the documented settings format actually matches.
function getEndpointLimit(tenant, reqPath, planLimit) {
  const customLimits = tenant?.settings?.rate_limits;
  if (!customLimits || typeof customLimits !== 'object') return planLimit;
  // Check exact path match, or a full path-segment prefix match (the configured
  // path followed by "/" or end-of-string). Plain startsWith() would let a limit
  // configured for "/appointments" also match "/appointments-export".
  for (const [pattern, limit] of Object.entries(customLimits)) {
    const normalized = pattern.replace(/^\/admin(?=\/)/, '');
    if (reqPath === normalized || reqPath.startsWith(normalized + '/')) {
      return typeof limit === 'number' ? limit : planLimit;
    }
  }
  return planLimit;
}

// Debounce rate-limit alert webhooks per tenant — without this, a tenant sitting
// above 90% usage gets a webhook POST on every single request (dozens per minute),
// flooding their alert endpoint. Mirrors the last-sent-timestamp debounce pattern
// used for the DB pool-exhaustion warning in db/index.js.
const ALERT_DEBOUNCE_MS = 5 * 60 * 1000; // at most one alert per tenant per 5 minutes
const lastAlertSentAt = new Map(); // tenantId -> timestamp

// ── In-process fallback counter ───────────────────────────────────────────────
// REDIS_URL is documented as optional, and utils/redisClient.js says callers
// "already treat a throw as fall back to the in-process limiter". Nothing here
// did: incrWithTTL threw REDIS_NOT_CONFIGURED on EVERY request, the catch below
// logged a warning and called next(), and so a Redis-less deployment had no
// per-tenant limit at all — the plan cap, the 90%-usage alert and the IP-abuse
// block were all unreachable — while writing one warn line per request into a
// 10 MB × 5 rotating log.
//
// Single-process only, which is the honest bound: without Redis there is no
// shared counter to have. It is a real limit for the common single-instance
// deployment, and strictly better than none for any other.
const _localCounts = new Map(); // key -> count
let _localWindow = 0;

function localIncr(key) {
  const window = Math.floor(Date.now() / 60000);
  if (window !== _localWindow) {
    // Whole-map clear on rollover: every key embeds the window, so nothing from
    // a previous minute can still be wanted, and this keeps the map from
    // growing without bound on a busy multi-tenant instance.
    _localCounts.clear();
    _localWindow = window;
  }
  const n = (_localCounts.get(key) || 0) + 1;
  _localCounts.set(key, n);
  return n;
}

// Logged once per process, not once per request.
let _warnedNoRedis = false;
function noteRedisUnavailable(err, tenantId) {
  if (err?.code === 'REDIS_NOT_CONFIGURED') {
    if (!_warnedNoRedis) {
      _warnedNoRedis = true;
      logger.warn('tenantRateLimit: REDIS_URL unset — using the in-process counter (per-instance, not shared)');
    }
    return 'fallback';
  }
  logger.warn('tenantRateLimit: Redis error, failing open', { tenantId, error: err.message });
  return 'open';
}

// Send alert webhook (fire-and-forget)
async function sendRateLimitAlert(tenant, endpoint, count, limit) {
  const alertUrl = tenant?.settings?.alert_webhook_url;
  if (!alertUrl || typeof alertUrl !== 'string' || !alertUrl.startsWith('https://')) return;

  const now = Date.now();
  const lastSent = lastAlertSentAt.get(tenant.id) || 0;
  if (now - lastSent < ALERT_DEBOUNCE_MS) return;
  lastAlertSentAt.set(tenant.id, now);

  try {
    await axios.post(alertUrl, {
      event: 'rate_limit_warning',
      tenant: tenant.slug,
      endpoint,
      count,
      limit,
      percent: Math.round((count / limit) * 100),
      timestamp: new Date().toISOString(),
    }, { timeout: 3000 });
  } catch (_) { /* fire-and-forget */ }
}

// Check and potentially block an abusive IP
async function checkIPBlock(ip) {
  if (!ip) return false;
  try {
    const r = await query(
      `SELECT 1 FROM rate_limit_blocks WHERE ip=$1 AND blocked_until > NOW()`,
      [ip]
    );
    return r.rows.length > 0;
  } catch (_) {
    return false; // fail open if DB unavailable
  }
}

async function recordIPAbuse(ip, reason) {
  if (!ip) return;
  try {
    await query(`
      INSERT INTO rate_limit_blocks (ip, blocked_until, reason, offense_count)
      VALUES ($1, NOW() + INTERVAL '1 hour', $2, 1)
      ON CONFLICT (ip) DO UPDATE SET
        offense_count = rate_limit_blocks.offense_count + 1,
        blocked_until = NOW() + ((rate_limit_blocks.offense_count + 1)::text || ' hours')::INTERVAL,
        reason = EXCLUDED.reason
    `, [ip, reason?.slice(0, 200)]);
  } catch (_) {}
}

module.exports = async function tenantRateLimit(req, res, next) {
  const tenantId = req.user?.tenant_id;
  if (!tenantId) return next();

  // Check IP block first
  const clientIp = req.ip || req.connection?.remoteAddress;
  if (clientIp && await checkIPBlock(clientIp)) {
    return res.status(429).json({
      error: 'Your IP has been temporarily blocked due to excessive requests.',
      retry_after: 3600,
    });
  }

  const plan = req.tenant?.plan || 'starter';
  const planLimit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.starter;
  if (planLimit === null) return next(); // no tier is unlimited today; kept for future tiers

  const limit = getEndpointLimit(req.tenant, req.path, planLimit);

  try {
    const window = Math.floor(Date.now() / 60000);
    const key = `ratelimit:tenant:${tenantId}:${window}`;

    // Atomic INCR + EXPIRE — avoids leaving a TTL-less counter if the process
    // dies between the two calls (which would rate-limit the tenant forever).
    // With no Redis configured this falls back to the in-process counter above
    // rather than failing open on every request; a genuine Redis ERROR (a blip
    // on a configured instance) still fails open, which is the right call for a
    // guard that must never take the dashboard down.
    let count;
    try {
      count = await incrWithTTL(key, 65);
    } catch (err) {
      if (noteRedisUnavailable(err, tenantId) !== 'fallback') return next();
      count = localIncr(key);
    }

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));
    res.setHeader('X-RateLimit-Plan', plan);

    if (count > limit) {
      // Track IP abuse — block after 10 exceedances
      const abuseKey = `ratelimit:abuse:${clientIp}`;
      let abuseCount = 0;
      try {
        try {
          abuseCount = await incrWithTTL(abuseKey, 5 * 60);
        } catch (err) {
          if (err?.code !== 'REDIS_NOT_CONFIGURED') throw err;
          abuseCount = localIncr(abuseKey);
        }
        if (abuseCount >= 10) {
          await recordIPAbuse(clientIp, `Rate limit exceeded ${abuseCount} times for tenant ${tenantId}`);
        }
      } catch (_) {}

      return res.status(429).json({
        error: 'Rate limit exceeded for your plan',
        limit,
        plan,
        retry_after: 60,
        // 'professional' is the top tier now — offering it an upgrade points at
        // nothing to buy.
        upgrade_hint: plan !== 'professional' ? 'Upgrade your plan for a higher request limit.' : undefined,
      });
    }

    // Alert at 90% usage
    if (count > limit * 0.9 && req.tenant) {
      setImmediate(() => sendRateLimitAlert(req.tenant, req.path, count, limit));
    }
  } catch (err) {
    // Anything else that went wrong in here (a DB read for the IP block, a
    // header write) must not take the clinic's dashboard offline.
    logger.warn('tenantRateLimit: failing open', { tenantId, error: err.message });
  }

  next();
};
