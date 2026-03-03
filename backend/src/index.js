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
  logger.warn('FRONTEND_URL not set — using default http://localhost:3000 for CORS and email links');
}

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Railway/Render/Vercel proxy
app.set('trust proxy', 1);

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Request ID — attach to every request for log correlation (M4)
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
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
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many login attempts' } });

app.use('/api/auth', authLimiter);
app.use('/api/webhook', webhookLimiter);
app.use('/api', globalLimiter);

// ── ROUTES ────────────────────────────────────────────────────
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/webhook'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/superadmin', require('./routes/superadmin'));

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { pool, query: dbQuery } = require('./db');
    await pool.query('SELECT 1');

    // Check Redis / queue status
    const { isQueueAvailable } = require('./jobs/botWorker');
    const queueUp = isQueueAvailable();

    // Surface any cron jobs that failed in the last 25 hours
    let cronAlerts = [];
    try {
      const cronR = await dbQuery(
        `SELECT job_name, last_status, last_error, last_run_at
         FROM cron_jobs
         WHERE last_status = 'error' AND last_run_at > NOW() - INTERVAL '25 hours'`
      );
      cronAlerts = cronR.rows;
    } catch (_) {} // non-fatal — cron_jobs table may not exist yet

    res.json({
      status: cronAlerts.length > 0 ? 'degraded' : 'ok',
      service: 'medibook-api',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      db: 'ok',
      redis: queueUp ? 'ok' : 'unavailable',
      queue: queueUp ? 'async' : 'sync-fallback',
      cron_alerts: cronAlerts.length > 0 ? cronAlerts : undefined,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: 'Database unavailable' });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
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
    // Track cron tasks so we can stop them gracefully before DB closes
    cronTasks = [
      ...startSlotGeneratorCron(),
      ...startReminderCron(),
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
    await shutdownWorker().catch(() => {});
    closeRedisClient();
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
