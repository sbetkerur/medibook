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
    // Duplicate the shared client for subscriber mode
    _subscriber = getClient().duplicate();
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
    await getClient().publish('medibook:sse', JSON.stringify({ tenantId, event, source: INSTANCE_ID }));
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

  // Heartbeat every 30 seconds to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) {}
  }, 30 * 1000);

  // Close the stream when the connecting token expires. Auth ran once at
  // connect; without this a revoked/expired session (e.g. fired staff) keeps
  // receiving live patient data for as long as the socket stays open. The
  // frontend reconnects with a fresh token on 'medibook:token-refreshed'.
  let expiryTimer = null;
  if (req.user?.exp) {
    const msUntilExpiry = req.user.exp * 1000 - Date.now();
    expiryTimer = setTimeout(() => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'token_expired' })}\n\n`);
        res.end();
      } catch (_) {}
    }, Math.max(msUntilExpiry, 0));
  }

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    if (expiryTimer) clearTimeout(expiryTimer);
    clientSet.delete(res);
    if (clientSet.size === 0) _clients.delete(tenantId);
    logger.info('SSE client disconnected', { tenantId, remaining: clientSet.size });
  });
});

module.exports = router;
module.exports.publish = publish;
