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

// Warn about optional services that are not configured
if (!process.env.RESEND_API_KEY) {
  logger.warn('RESEND_API_KEY not set — booking confirmation emails will not be sent');
}
if (!process.env.META_PHONE_NUMBER_ID || !process.env.META_ACCESS_TOKEN) {
  logger.warn('META credentials not configured — WhatsApp messaging requires real credentials in production');
}
if (!process.env.FRONTEND_URL) {
  if (process.env.NODE_ENV === 'production') {
    logger.error('FRONTEND_URL is required in production (CORS will block all frontend requests). Set it and restart.');
    process.exit(1);
  }
  logger.warn('FRONTEND_URL not set — using default http://localhost:3000 for CORS and email links');
}

const app = express();
const PORT = process.env.PORT || 3001;

// Validate and resolve FRONTEND_URL early — needed by both helmet CSP and CORS
const rawFrontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
try { new URL(rawFrontendUrl); } catch {
  logger.error(`Invalid FRONTEND_URL "${rawFrontendUrl}" — must be a valid URL. Exiting.`);
  process.exit(1);
}

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
      connectSrc: ["'self'", rawFrontendUrl],
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
  origin: rawFrontendUrl,
  credentials: true,
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

// Raw body for webhook signature verification
app.use('/api/webhook', express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.json({ limit: '12mb' })); // increased for document base64 uploads (Enhancement 6)
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false });
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 2000 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many login attempts' }, skip: () => process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development' });

app.use('/api/auth', authLimiter);
const webhookIpLimiter = rateLimit({ windowMs: 60 * 1000, max: 100, keyGenerator: (req) => req.ip, message: { error: 'Too many requests from this IP' } });
app.use('/api/webhook', webhookIpLimiter);
app.use('/api/webhook', webhookLimiter);
app.use('/api', globalLimiter);

// ── PER-TENANT RATE LIMITING (Enhancement 15) ────────────────
// Applied globally to all admin routes — runs after auth+tenant middleware set req.user and req.tenant
const tenantRateLimit = require('./middleware/tenantRateLimit');
const { authMiddleware: _auth, tenantMiddleware: _tenant } = require('./middleware/auth');
app.use('/api/admin', _auth, _tenant, tenantRateLimit);

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

// POST /api/webhook/resend — Resend bounce/complaint webhook
app.post('/api/webhook/resend', express.json(), async (req, res) => {
  // Verify Resend webhook signature if secret is configured
  if (process.env.RESEND_WEBHOOK_SECRET) {
    const sig = req.headers['resend-signature'];
    if (!sig) { logger.warn('Unsigned Resend webhook rejected'); return res.sendStatus(403); }
    const expected = crypto.createHmac('sha256', process.env.RESEND_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body)).digest('hex');
    if (sig !== expected) { logger.warn('Invalid Resend webhook signature'); return res.sendStatus(403); }
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
      cron_alerts: isDegraded ? cronAlerts : undefined,
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
    const { startSlotGeneratorCron, startBackupReminderCron } = require('./jobs/slotGenerator');
    const { startReminderCron } = require('./jobs/reminders');
    const { startBotWorker } = require('./jobs/botWorker');
    const { startWebhookRetryCron } = require('./jobs/retryWebhooks');
    const { startBackupCron } = require('./jobs/backupManager');
    // Track cron tasks so we can stop them gracefully before DB closes
    cronTasks = [
      ...startSlotGeneratorCron(),
      ...startReminderCron(),
      startBackupReminderCron(),
      startWebhookRetryCron(),
      startBackupCron(),
    ];
    startBotWorker();
  }
});

// Graceful shutdown — stop crons first, close queues/Redis, then close DB pool
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  // Stop all cron tasks so no new DB queries are issued
  cronTasks.forEach(t => { try { t.stop(); } catch (_) {} });
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
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = app;
