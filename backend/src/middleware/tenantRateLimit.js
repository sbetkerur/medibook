'use strict';
const { getClient } = require('../utils/redisClient');
const { query } = require('../db');
const logger = require('../utils/logger');
const axios = require('axios');

const PLAN_LIMITS = {
  starter: 60,
  growth: 120,
  professional: 300,
  enterprise: null, // unlimited
};

// Per-endpoint overrides (req.path pattern -> max per minute)
// Tenant can store { "/admin/appointments": 200 } in settings.rate_limits
function getEndpointLimit(tenant, reqPath, planLimit) {
  const customLimits = tenant?.settings?.rate_limits;
  if (!customLimits || typeof customLimits !== 'object') return planLimit;
  // Check exact path match or prefix match
  for (const [pattern, limit] of Object.entries(customLimits)) {
    if (reqPath === pattern || reqPath.startsWith(pattern)) {
      return typeof limit === 'number' ? limit : planLimit;
    }
  }
  return planLimit;
}

// Send alert webhook (fire-and-forget)
async function sendRateLimitAlert(tenant, endpoint, count, limit) {
  const alertUrl = tenant?.settings?.alert_webhook_url;
  if (!alertUrl || typeof alertUrl !== 'string' || !alertUrl.startsWith('https://')) return;
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
  if (planLimit === null) return next(); // enterprise: unlimited

  const limit = getEndpointLimit(req.tenant, req.path, planLimit);

  try {
    const redis = getClient();
    const window = Math.floor(Date.now() / 60000);
    const key = `ratelimit:tenant:${tenantId}:${window}`;

    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 65);

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));
    res.setHeader('X-RateLimit-Plan', plan);

    if (count > limit) {
      // Track IP abuse — block after 10 exceedances
      const abuseKey = `ratelimit:abuse:${clientIp}`;
      let abuseCount = 0;
      try {
        abuseCount = await redis.incr(abuseKey);
        if (abuseCount === 1) await redis.expire(abuseKey, 5 * 60);
        if (abuseCount >= 10) {
          await recordIPAbuse(clientIp, `Rate limit exceeded ${abuseCount} times for tenant ${tenantId}`);
        }
      } catch (_) {}

      return res.status(429).json({
        error: 'Rate limit exceeded for your plan',
        limit,
        plan,
        retry_after: 60,
        upgrade_hint: plan !== 'enterprise' ? 'Upgrade your plan for a higher request limit.' : undefined,
      });
    }

    // Alert at 90% usage
    if (count > limit * 0.9 && req.tenant) {
      setImmediate(() => sendRateLimitAlert(req.tenant, req.path, count, limit));
    }
  } catch (err) {
    logger.warn('tenantRateLimit: Redis error, failing open', { tenantId, error: err.message });
  }

  next();
};
