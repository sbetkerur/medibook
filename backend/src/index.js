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

// Request ID — attach to every request for log correlation (M4)
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  metrics.increment('requests_total');
  next();
});

// Raw body for webhook signature verification
app.use('/api/webhook', express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false });
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 2000 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many login attempts' }, skip: () => process.env.NODE_ENV === 'test' });

app.use('/api/auth', authLimiter);
app.use('/api/webhook', webhookLimiter);
app.use('/api', globalLimiter);

// ── ROUTES ────────────────────────────────────────────────────
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/webhook'));
// Split route files registered first so they take priority over legacy admin.js for their domains
app.use('/api/admin', require('./routes/appointments'));
app.use('/api/admin', require('./routes/doctors'));
app.use('/api/admin', require('./routes/hospitals'));
app.use('/api/admin', require('./routes/patients'));
app.use('/api/admin', require('./routes/analytics'));
// admin.js: dashboard, staff, settings, waitlist, feedback, audit-logs, bot-tester, calendar
app.use('/api/admin', require('./routes/admin'));
app.use('/api/superadmin', require('./routes/superadmin'));

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
app.use('/api/v1/superadmin', require('./routes/superadmin'));

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { pool, query: dbQuery } = require('./db');
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
    res.status(isDegraded ? 503 : 200).json({
      status: isDegraded ? 'degraded' : 'ok',
      service: 'medibook-api',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      db: 'ok',
      redis: redisStatus,
      redis_write: redisStatus,
      queue: queueUp ? 'async' : 'sync-fallback',
      cron_alerts: isDegraded ? cronAlerts : undefined,
      backup_hint: process.env.NODE_ENV !== 'production'
        ? `pg_dump "${process.env.DATABASE_URL}" > medibook_$(date +%Y%m%d).sql`
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
    // Track cron tasks so we can stop them gracefully before DB closes
    cronTasks = [
      ...startSlotGeneratorCron(),
      ...startReminderCron(),
      startBackupReminderCron(),
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
