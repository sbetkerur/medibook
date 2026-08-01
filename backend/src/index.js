require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');

// ── OPTIONAL SENTRY ERROR TRACKING ────────────────────────────
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'development' });
    logger.info('Sentry initialized');
  } catch (_) {
    logger.warn('Sentry SDK not installed — install @sentry/node to enable error tracking');
  }
}

// Read version from package.json at startup (M8)
const { version: APP_VERSION } = require('../package.json');

// ── STARTUP VALIDATION ────────────────────────────────────────
// Importing encryption validates ENCRYPTION_KEY and exits in production if default
require('./utils/encryption');

// JWT_SECRET is required for all token signing/verification — fail fast in production
// rather than issuing tokens that can be forged with an empty/default secret.
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    logger.error('FATAL: JWT_SECRET environment variable is not set. All authentication will fail. Exiting.');
    process.exit(1);
  } else {
    const insecureDefault = 'dev-only-insecure-jwt-secret-change-before-production';
    logger.warn(`JWT_SECRET not set — using insecure default for local dev. DO NOT use in production.`);
    process.env.JWT_SECRET = insecureDefault;
  }
} else if (process.env.JWT_SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    logger.error('FATAL: JWT_SECRET is too short (minimum 32 characters). Use a strong random value. Exiting.');
    process.exit(1);
  } else {
    logger.warn(`JWT_SECRET is short (${process.env.JWT_SECRET.length} chars) — use at least 32 characters in production.`);
  }
}

// The IST date logic throughout the app (toZonedTime + date-fns local getters in
// slotGenerator/botEngine, and the SQL date expressions in utils/dateTz.js)
// assumes the PROCESS runs in UTC. A non-UTC host timezone shifts slot
// generation and "today" labels by a day, silently and only for part of each day.
const _processTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const _tzOffsetMinutes = new Date().getTimezoneOffset();
if (_tzOffsetMinutes !== 0) {
  logger.warn(
    `Process timezone is "${_processTz}" (UTC offset ${-_tzOffsetMinutes} min), not UTC. ` +
    `Date handling assumes UTC — set TZ=UTC to avoid off-by-one-day slot generation and date labels.`
  );
}

// Warn about optional services that are not configured
if (!process.env.RESEND_API_KEY) {
  logger.warn('RESEND_API_KEY not set — booking confirmation emails will not be sent');
}
if (!process.env.META_PHONE_NUMBER_ID || !process.env.META_ACCESS_TOKEN) {
  logger.warn('META credentials not configured — WhatsApp messaging requires real credentials in production');
}
// Without a real META_APP_SECRET the webhook route cannot verify signatures and
// would process forged POSTs — an attacker spoofing messages[].from could drive
// the bot as any patient. Fail fast in production instead of failing open.
if (process.env.NODE_ENV === 'production' &&
    !require('./utils/errors').isRealAppSecret(process.env.META_APP_SECRET)) {
  logger.error('FATAL: META_APP_SECRET is not set (or is a placeholder). Webhook signatures cannot be verified. Exiting.');
  process.exit(1);
}
if (!process.env.FRONTEND_URL) {
  if (process.env.NODE_ENV === 'production') {
    logger.warn('FRONTEND_URL is not set — CORS will allow all origins. Set FRONTEND_URL=https://your-frontend.up.railway.app to restrict access.');
  } else {
    logger.warn('FRONTEND_URL not set — using default http://localhost:3000 for CORS and email links');
  }
}

const app = express();
const PORT = process.env.PORT || 3001;

// Validate and resolve FRONTEND_URL early — needed by both helmet CSP and CORS.
// If not set, fall back to permissive '*' so the first Railway deploy doesn't crash.
// Set FRONTEND_URL=https://your-frontend.up.railway.app to lock it down.
// FRONTEND_URL accepts a COMMA-SEPARATED list of origins, which .env.example has
// always documented but the code did not implement: `new URL()` was called on
// the whole string, so a second origin threw and hit process.exit(1) below —
// taking the API down on boot. Multiple origins are needed for real cutovers
// (custom domain alongside the old *.up.railway.app one) and for staging.
const frontendOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

for (const origin of frontendOrigins) {
  let parsed;
  try { parsed = new URL(origin); } catch {
    logger.error(`Invalid FRONTEND_URL entry "${origin}" — each comma-separated value must be a valid URL. Exiting.`);
    process.exit(1);
  }
  // In production, reject localhost/loopback origins — a misconfigured FRONTEND_URL would
  // silently open CORS to any local process on the server.
  if (process.env.NODE_ENV === 'production') {
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      logger.error(`FRONTEND_URL entry "${origin}" points to localhost — this is not allowed in production. Set it to your actual frontend domain. Exiting.`);
      process.exit(1);
    }
  }
}

// Origins are stored without a trailing slash; browsers send the bare origin.
const rawFrontendUrl = frontendOrigins.length ? frontendOrigins[0] : null;

// Trust Railway/Render/Vercel proxy
app.set('trust proxy', 1);

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(require('compression')());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      // No unsafe-inline: the API server serves JSON, not HTML with inline styles.
      // If an error page ever renders HTML, use a nonce instead.
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      // Allow the frontend origin to connect to the API (applies to any HTML served by the API)
      connectSrc: frontendOrigins.length ? ["'self'", ...frontendOrigins] : ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  hsts: {
    maxAge: 31536000,      // 1 year
    includeSubDomains: true,
    preload: true,
  },
  // Disabled: some health check tools and proxies don't support this header
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  // If FRONTEND_URL is set, restrict to that origin. Otherwise allow all (open during initial deploy).
  // Array form: the cors package matches the request Origin against any entry.
  // Passing the raw comma-joined string matched literally and rejected both.
  origin: frontendOrigins.length ? frontendOrigins : '*',
  credentials: frontendOrigins.length > 0, // credentials:true requires specific origins, not '*'
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Metrics counters
const metrics = require('./utils/metrics');

// Request ID + AsyncLocalStorage context propagation
const { runWithContext } = require('./utils/requestContext');
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  metrics.increment('requests_total');
  runWithContext({ requestId: req.id }, next);
});

// Raw body for webhook signature verification (both mount paths — the /v1
// alias previously got the generic parser, so its signatures never matched)
const webhookJsonParser = express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
});
app.use('/api/webhook', webhookJsonParser);
app.use('/api/v1/webhook', webhookJsonParser);
app.use(express.json({ limit: '12mb' })); // increased for document base64 uploads (Enhancement 6)
app.use(express.urlencoded({ extended: true }));

// ── RATE LIMITING ─────────────────────────────────────────────
// Webhook traffic needs a much higher ceiling than ordinary API traffic: Meta
// delivers every tenant's inbound messages from a SMALL POOL OF SHARED SOURCE
// IPs, so a per-IP limit is effectively a platform-wide limit.
//
// There used to be two stacked webhook limiters — max:2000 and max:100 — both
// keyed by IP (express-rate-limit's default key IS req.ip, so the explicit
// keyGenerator changed nothing). The tighter one always won, silently capping
// the entire platform at 100 inbound messages/minute and 429-ing Meta; the
// 2000 was dead config. One limiter now, at the intended ceiling.
const WEBHOOK_PATHS = ['/api/webhook', '/api/v1/webhook'];
// NOTE: use originalUrl, not req.path — inside `app.use('/api', globalLimiter)`
// Express strips the mount point, so req.path is '/webhook/whatsapp' and a
// '/api/webhook' prefix test would never match.
const isWebhookPath = (req) => {
  const path = (req.originalUrl || '').split('?')[0];
  return WEBHOOK_PATHS.some(p => path === p || path.startsWith(p + '/'));
};

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.WEBHOOK_RATE_LIMIT_PER_MIN || '2000'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many webhook requests' },
});

// The global limiter must SKIP webhook paths — mounted on '/api' it also
// matched /api/webhook, so its max:500 quietly overrode the webhook ceiling.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isWebhookPath,
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many login attempts' }, skip: () => process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development' });

app.use('/api/auth', authLimiter);
app.use('/api/v1/auth', authLimiter); // auth routes are also mounted under /api/v1
// Both webhook mount points get the limiter — /api/v1/webhook previously had no
// webhook-specific limit at all, only the generic 500/min global one.
app.use('/api/webhook', webhookLimiter);
app.use('/api/v1/webhook', webhookLimiter);
app.use('/api', globalLimiter);

// ── AUTH + PER-TENANT RATE LIMITING (Enhancement 15) ─────────
// Auth, tenant resolution and per-tenant rate limiting are applied ONCE here
// for all admin routes (legacy and /v1 alias). The individual route files do
// NOT re-apply them — previously they did, which ran JWT verification, the
// token-blacklist query, the tenant lookup and the IP-allowlist check twice
// on every single admin request.
const tenantRateLimit = require('./middleware/tenantRateLimit');
const { authMiddleware: _auth, tenantMiddleware: _tenant } = require('./middleware/auth');
app.use('/api/admin', _auth, _tenant, tenantRateLimit);
app.use('/api/v1/admin', _auth, _tenant, tenantRateLimit);

// ── ROUTES ────────────────────────────────────────────────────
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/webhook'));
// Split route files registered first so they take priority over legacy admin.js for their domains
app.use('/api/admin', require('./routes/appointments'));
app.use('/api/admin', require('./routes/doctors'));
app.use('/api/admin', require('./routes/hospitals'));
app.use('/api/admin', require('./routes/patients'));
app.use('/api/admin', require('./routes/analytics'));
// admin.js: dashboard, staff, settings, feedback, audit-logs, bot-tester, calendar
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin', require('./routes/services'));  // A1 service catalog + A4 holidays
app.use('/api/admin', require('./routes/events'));    // SSE real-time dashboard
app.use('/api/superadmin', require('./routes/superadmin'));

// ── EMAIL TRACKING ────────────────────────────────────────────
// GET /api/track/open?h=<hash> — 1×1 transparent pixel, increments open_count
app.get('/api/track/open', async (req, res) => {
  // Transparent 1×1 GIF
  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'
  );
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.end(pixel);

  // Update open count in background (non-blocking)
  const token = req.query.h;
  if (token) {
    const { query: dbQuery } = require('./db');
    dbQuery(
      `UPDATE email_sent_log SET open_count = open_count + 1
       WHERE content_hash = $1`,
      [token]
    ).catch(() => {});
  }
});

// Verify a Svix webhook signature (used by Resend).
// Svix signs `${svix-id}.${svix-timestamp}.${rawBody}` with HMAC-SHA256 using the
// base64-decoded portion of the `whsec_…` secret, and sends one or more
// space-separated `v1,<base64sig>` values in the `svix-signature` header.
function verifySvixSignature(req, secret) {
  const svixId = req.headers['svix-id'];
  const svixTimestamp = req.headers['svix-timestamp'];
  const svixSignature = req.headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Reject stale/future timestamps (±5 min) to prevent replay attacks
  const ts = parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  let key;
  try {
    key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  } catch { return false; }

  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', key).update(signedContent).digest();

  // Header may contain multiple signatures: "v1,<sig> v1,<sig>"
  for (const part of String(svixSignature).split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    let candidate;
    try { candidate = Buffer.from(sig, 'base64'); } catch { continue; }
    if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
      return true;
    }
  }
  return false;
}

// POST /api/webhook/resend — Resend bounce/complaint webhook (signed via Svix)
app.post('/api/webhook/resend', express.json(), async (req, res) => {
  if (process.env.RESEND_WEBHOOK_SECRET) {
    if (!verifySvixSignature(req, process.env.RESEND_WEBHOOK_SECRET)) {
      logger.warn('Invalid or missing Svix signature on Resend webhook — rejected');
      return res.sendStatus(403);
    }
  }

  res.sendStatus(200);
  try {
    const { type, data } = req.body || {};
    if (type === 'email.bounced' || type === 'email.complained') {
      const email = data?.to?.[0] || data?.email_address;
      if (!email) return;
      // Mark patient email as bounced across all active tenant schemas
      const SCHEMA_RE = /^tenant_[a-z0-9_]+$/;
      const { pool: dbPool } = require('./db');
      const tenants = await dbPool.query(`SELECT schema_name FROM tenants WHERE status='active'`);
      for (const t of tenants.rows) {
        if (!SCHEMA_RE.test(t.schema_name)) continue; // skip invalid schema names
        await dbPool.query(
          `UPDATE "${t.schema_name}".patients SET email_status='bounced' WHERE email=$1`,
          [email]
        ).catch(() => {});
      }
      logger.info('Resend bounce handled', { type });
    }
  } catch (err) {
    logger.warn('Resend webhook handler error', { error: err.message });
  }
});

// ── API v1 ALIASES ────────────────────────────────────────────
// Mount the same routers under /api/v1/ so clients can adopt the versioned
// path without a flag-day migration.  /api/ continues to work unchanged.
app.use('/api/v1',          require('./routes/auth'));
app.use('/api/v1',          require('./routes/webhook'));
app.use('/api/v1/admin',    require('./routes/appointments'));
app.use('/api/v1/admin',    require('./routes/doctors'));
app.use('/api/v1/admin',    require('./routes/hospitals'));
app.use('/api/v1/admin',    require('./routes/patients'));
app.use('/api/v1/admin',    require('./routes/analytics'));
app.use('/api/v1/admin',    require('./routes/admin'));
app.use('/api/v1/admin',    require('./routes/services'));
app.use('/api/v1/admin',    require('./routes/events'));
app.use('/api/v1/superadmin', require('./routes/superadmin'));

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { pool, query: dbQuery } = require('./db'); // pool needed for stats in response
    await pool.query('SELECT 1');

    // Check Redis / queue status with write round-trip
    const { isQueueAvailable } = require('./jobs/botWorker');
    const queueUp = isQueueAvailable();
    const { redisHealthCheck } = require('./utils/redisClient');
    const redisStatus = await redisHealthCheck();

    // Surface any cron jobs that failed in the last hour
    let cronAlerts = [];
    try {
      const cronR = await dbQuery(
        `SELECT job_name, last_status, last_error, last_run_at
         FROM cron_jobs
         WHERE last_status = 'error' AND last_run_at > NOW() - INTERVAL '1 hour'`
      );
      cronAlerts = cronR.rows;
    } catch (_) {} // non-fatal — cron_jobs table may not exist yet

    const isDegraded = cronAlerts.length > 0;
    const mem = process.memoryUsage();
    const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);
    const heapPercent = Math.round((mem.heapUsed / mem.heapTotal) * 100);
    const isMemoryHigh = heapPercent > 85 && heapUsedMb > 200;
    const isAnyDegraded = isDegraded || isMemoryHigh;

    res.status(isAnyDegraded ? 503 : 200).json({
      status: isAnyDegraded ? 'degraded' : 'ok',
      service: 'medibook-api',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      uptime_seconds: Math.floor(process.uptime()),
      db: {
        status: 'ok',
        pool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
          max: pool.options.max,
          utilization_percent: Math.round((pool.totalCount / pool.options.max) * 100),
        },
      },
      redis: redisStatus,
      queue: queueUp ? 'async' : 'sync-fallback',
      memory: {
        heap_used_mb: heapUsedMb,
        heap_total_mb: heapTotalMb,
        heap_percent: heapPercent,
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        status: isMemoryHigh ? 'high' : 'ok',
      },
      cron_alerts: isDegraded ? cronAlerts.map(({ last_error: _, ...a }) => a) : undefined,
      backup_hint: process.env.NODE_ENV !== 'production'
        ? `pg_dump $DATABASE_URL > medibook_$(date +%Y%m%d).sql`
        : undefined,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: 'Database unavailable' });
  }
});

// ── METRICS ENDPOINT ──────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  if (process.env.METRICS_SECRET) {
    const crypto = require('crypto');
    const auth = Buffer.from((req.headers.authorization || '').replace('Bearer ', ''));
    const secret = Buffer.from(process.env.METRICS_SECRET);
    if (auth.length !== secret.length || !crypto.timingSafeEqual(auth, secret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  try {
    const { pool: dbPool } = require('./db');
    await dbPool.query('SELECT 1');

    let queueDepth = 0;
    try {
      const { getQueue, isQueueAvailable } = require('./jobs/botWorker');
      if (isQueueAvailable() && getQueue()) {
        queueDepth = await getQueue().getWaitingCount();
      }
    } catch (_) {}

    const tenantCount = await dbPool.query(`SELECT COUNT(*) FROM tenants WHERE status='active'`);

    res.json({
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      counters: metrics.getAll(),
      queue: { depth: queueDepth },
      tenants: { active: parseInt(tenantCount.rows[0].count) },
      memory: {
        heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
      node_version: process.version,
    });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// 404 handler
app.use('*', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not found' });
  } else {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
  }
});

// Global error handler — includes request ID for log correlation
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { reqId: req.id, error: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ error: 'Internal server error', reqId: req.id });
});

// ── START SERVER ──────────────────────────────────────────────
let cronTasks = [];

const server = app.listen(PORT, () => {
  logger.info(`🚀 MediBook API v${APP_VERSION} running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  logger.info(`   Health: http://localhost:${PORT}/health`);
  logger.info(`   Webhook test: POST http://localhost:${PORT}/api/webhook/test`);

  if (process.env.NODE_ENV !== 'test') {
    const { startSlotGeneratorCron } = require('./jobs/slotGenerator');
    const { startReminderCron } = require('./jobs/reminders');
    const { startBotWorker } = require('./jobs/botWorker');
    const { startWebhookRetryCron } = require('./jobs/retryWebhooks');
    const { startBackupCron } = require('./jobs/backupManager');
    const { startSessionCleanerCron } = require('./jobs/sessionCleaner');
    // Track cron tasks so we can stop them gracefully before DB closes.
    // Only ONE backup cron is registered (backupManager's spawn()-based daily
    // job) — slotGenerator.js's exec()-based weekly startBackupReminderCron was
    // removed as a duplicate, drifting implementation of the same job.
    cronTasks = [
      ...startSlotGeneratorCron(),
      ...startReminderCron(),
      startWebhookRetryCron(),
      startBackupCron(),
      startSessionCleanerCron(),
    ];
    startBotWorker();
  }
});

// Graceful shutdown — stop crons first, close queues/Redis, then close DB pool
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  // Stop all cron tasks so no new DB queries are issued
  cronTasks.forEach(t => { try { t.stop(); } catch (_) {} });
  // server.close() only completes once every connection is idle — SSE streams
  // (dashboard EventSource) are never idle, so force-close connections after a
  // short drain and hard-exit as a failsafe so Railway doesn't have to SIGKILL
  // us with the pool/queues still open.
  setTimeout(() => { try { server.closeAllConnections?.(); } catch (_) {} }, 5000).unref();
  setTimeout(() => { logger.error('Graceful shutdown timed out — forcing exit'); process.exit(1); }, 15000).unref();
  server.close(async () => {
    const { pool } = require('./db');
    const { shutdown: shutdownWorker } = require('./jobs/botWorker');
    const { closeRedisClient } = require('./utils/cronLock');
    const { closeClient: closeSharedRedis } = require('./utils/redisClient');
    await shutdownWorker().catch(() => {});
    closeRedisClient();
    closeSharedRedis();
    await pool.end();
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  try { require('./utils/metrics').increment('uncaught_exceptions_total'); } catch (_) {}
  // Port already in use or out of memory — can't recover, must exit so PM2 can restart cleanly
  const FATAL_CODES = ['ENOMEM', 'EADDRINUSE', 'EACCES'];
  const isFatal = FATAL_CODES.includes(err.code) || FATAL_CODES.some(c => err.message.includes(c));
  if (isFatal) {
    logger.error('Fatal system error — exiting for PM2 restart', { code: err.code, error: err.message });
    process.exit(1);
  }
  // Non-fatal: log and keep running — a bad cron callback shouldn't take the whole bot offline
  logger.error('Uncaught exception — server continuing', { error: err.message, stack: err.stack });
});

// Unhandled promise rejections (async throws that escaped all try-catch blocks)
// are the most common cause of silent process crashes in Node >= 15.
// Log them but keep the server up — the error boundary in botEngine handles
// per-request failures; these are background tasks that can be re-tried.
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error('Unhandled promise rejection — server continuing', { error: msg, stack });
  try { require('./utils/metrics').increment('unhandled_rejections_total'); } catch (_) {}
});

module.exports = app;
