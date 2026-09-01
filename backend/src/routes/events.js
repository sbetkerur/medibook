'use strict';
/**
 * Server-Sent Events (SSE) endpoint for real-time dashboard updates.
 * Clients connect to GET /admin/events and receive a stream of JSON events.
 * Events are published via Redis pub/sub so all backend instances can broadcast.
 */

const router = require('express').Router();
const logger = require('../utils/logger');

// Unique ID for this process — used to ignore our own Redis pub/sub messages.
// Without it, the publishing instance would deliver every event twice: once via
// the direct in-process broadcast and again when its own subscriber receives
// the message back from Redis.
const INSTANCE_ID = require('crypto').randomUUID();

// In-process SSE client registry: tenantId -> Set<res>
const _clients = new Map();

// Cap concurrent SSE streams per tenant so a single account (or a runaway client
// opening many EventSource connections) can't exhaust sockets/memory.
const MAX_SSE_CLIENTS_PER_TENANT = 50;

// Redis subscriber connection (separate from the shared client to allow blocking subscribe)
let _subscriber = null;

function getSubscriber() {
  if (_subscriber) return _subscriber;
  try {
    const { getClient } = require('../utils/redisClient');
    const base = getClient();
    // No Redis — SSE still works in-process (single instance); publish() falls
    // back to the direct broadcast it always does first.
    if (!base) return null;
    // Duplicate the shared client for subscriber mode
    _subscriber = base.duplicate();
    _subscriber.subscribe('medibook:sse', (err) => {
      if (err) logger.warn('SSE Redis subscribe error', { error: err.message });
    });
    _subscriber.on('message', (_channel, raw) => {
      try {
        const { tenantId, event, source } = JSON.parse(raw);
        if (source === INSTANCE_ID) return; // already broadcast in-process by publish()
        broadcastToTenant(tenantId, event);
      } catch (_) {}
    });
    _subscriber.on('error', (err) => {
      logger.warn('SSE Redis subscriber error', { error: err.message });
    });
  } catch (_) {
    // Redis unavailable — SSE will work in-process only (single instance)
  }
  return _subscriber;
}

/**
 * Broadcast an event to all connected SSE clients for a tenant.
 * Called from within this process (in-process fan-out).
 */
function broadcastToTenant(tenantId, event) {
  const clients = _clients.get(tenantId);
  if (!clients || clients.size === 0) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch (_) {}
  }
}

/**
 * Publish an event to ALL backend instances via Redis pub/sub.
 * Falls back to in-process broadcast if Redis is unavailable.
 *
 * @param {string} tenantId - UUID of the tenant whose dashboard should update
 * @param {object} event    - { type: string, payload: object }
 */
async function publish(tenantId, event) {
  if (!tenantId) return;
  // Always do in-process broadcast (covers single-instance setups)
  broadcastToTenant(tenantId, event);
  // Cross-instance fan-out via Redis — tagged with our instance ID so our own
  // subscriber skips the message (it was already broadcast above).
  try {
    const { getClient } = require('../utils/redisClient');
    const client = getClient();
    if (client) {
      await client.publish('medibook:sse', JSON.stringify({ tenantId, event, source: INSTANCE_ID }));
    }
  } catch (_) {}
}

// ── GET /admin/events ─────────────────────────────────────────
// Auth + tenant middleware applied in index.js before this router
router.get('/events', (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(403).json({ error: 'Tenant not found' });

  // Enforce the per-tenant connection cap BEFORE switching to the SSE stream so
  // we can still respond with a normal JSON error status.
  const existing = _clients.get(tenantId);
  if (existing && existing.size >= MAX_SSE_CLIENTS_PER_TENANT) {
    logger.warn('SSE connection limit reached for tenant', { tenantId, active: existing.size });
    return res.status(429).json({ error: 'Too many active dashboard connections. Close other tabs and retry.' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Register client
  if (!_clients.has(tenantId)) _clients.set(tenantId, new Set());
  const clientSet = _clients.get(tenantId);
  clientSet.add(res);
  logger.info('SSE client connected', { tenantId, total: clientSet.size });

  // Start Redis subscriber (lazy init) for cross-instance events
  try { getSubscriber(); } catch (_) {}

  // Send initial heartbeat so the browser doesn't wait for data
  res.write(`data: ${JSON.stringify({ type: 'connected', tenantId })}\n\n`);

  // Tear the stream down, telling the client why in the ONE shape it handles:
  // dashboard/page.js closes the EventSource on type === 'token_expired' and
  // waits for 'medibook:token-refreshed' to reconnect. Any other type would be
  // ignored and the browser would reconnect forever with the same dead token.
  let closed = false;
  const endStream = (reason) => {
    if (closed) return;
    closed = true;
    logger.info('SSE stream ended by server', { tenantId, reason });
    try {
      res.write(`data: ${JSON.stringify({ type: 'token_expired' })}\n\n`);
      res.end();
    } catch (_) {}
  };

  // Heartbeat every 30 seconds to keep the connection alive through proxies —
  // and, on the same tick, re-authorise the stream.
  //
  // The stream outlives the request that authenticated it: auth runs once at
  // connect, and the only other teardown is the expiry timer below, up to 60
  // minutes out. So an EventSource opened before a clinic deactivated a fired
  // staff member — or before a super admin suspended the tenant — kept
  // receiving every publish(), i.e. new bookings with patient names and phone
  // numbers, for the rest of the hour. Both of those correctly block new
  // requests within 5s, and POST /auth/logout blacklists the jti and burns the
  // refresh tokens, yet none of it touched the live socket.
  //
  // One round-trip covers both conditions. Transient DB errors do NOT kill the
  // stream on the first failure: a blip would otherwise close every dashboard's
  // feed and, because the client then waits for a token refresh that may be
  // ~an hour away, leave it stale far longer than the outage. Two consecutive
  // failures is treated as "cannot authorise" and closes — the exposure stays
  // bounded by the expiry timer either way.
  let consecutiveCheckFailures = 0;
  const revalidate = async () => {
    if (closed) return;
    try {
      const { query } = require('../db');
      const r = await query(
        `SELECT (SELECT status FROM tenants WHERE id=$1) AS tenant_status,
                EXISTS(SELECT 1 FROM token_blacklist WHERE jti=$2 AND expires_at > NOW()) AS revoked`,
        [tenantId, req.user?.jti || null]
      );
      consecutiveCheckFailures = 0;
      const row = r.rows[0] || {};
      if (row.revoked) return endStream('token_revoked');
      // Match middleware/auth.js DASHBOARD_ALLOWED_STATUSES, not a bare
      // 'active' check: 'past_due' is a legitimate dashboard state (lapsed
      // trial / failed card, owner needs in to fix payment). Killing the
      // stream for it made every past_due clinic's live feed flap every 30s —
      // the client sees {type:'token_expired'}, closes the EventSource and
      // waits for a token refresh that is up to an hour away, then reconnects
      // (tenantMiddleware lets past_due through) only to be killed again.
      if (row.tenant_status !== 'active' && row.tenant_status !== 'past_due') {
        return endStream('tenant_inactive');
      }
    } catch (err) {
      // Table absent on a first deploy is not a revocation — same carve-out as
      // middleware/auth.js's blacklist check.
      if (err.code === '42P01') return;
      consecutiveCheckFailures++;
      logger.warn('SSE revalidation failed', { tenantId, error: err.message, consecutiveCheckFailures });
      if (consecutiveCheckFailures >= 2) endStream('revalidation_unavailable');
    }
  };

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) {}
    revalidate();
  }, 30 * 1000);

  // Close the stream when the connecting token expires. The frontend
  // reconnects with a fresh token on 'medibook:token-refreshed'.
  let expiryTimer = null;
  if (req.user?.exp) {
    const msUntilExpiry = req.user.exp * 1000 - Date.now();
    expiryTimer = setTimeout(() => endStream('token_expired'), Math.max(msUntilExpiry, 0));
  }

  // Cleanup on disconnect
  req.on('close', () => {
    closed = true; // stops any in-flight revalidate from writing to a dead socket
    clearInterval(heartbeat);
    if (expiryTimer) clearTimeout(expiryTimer);
    clientSet.delete(res);
    if (clientSet.size === 0) _clients.delete(tenantId);
    logger.info('SSE client disconnected', { tenantId, remaining: clientSet.size });
  });
});

module.exports = router;
module.exports.publish = publish;
