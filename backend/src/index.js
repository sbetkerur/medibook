require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Railway/Render/Vercel proxy so rate limiting & IP detection work correctly
app.set('trust proxy', 1);

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

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
    const { pool } = require('./db');
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      service: 'medibook-api',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: 'Database unavailable' });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

// ── START SERVER ──────────────────────────────────────────────
const server = app.listen(PORT, () => {
  logger.info(`🚀 MediBook API running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  logger.info(`   Health: http://localhost:${PORT}/health`);
  logger.info(`   Webhook test: POST http://localhost:${PORT}/api/webhook/test`);

  if (process.env.NODE_ENV !== 'test') {
    const { startSlotGeneratorCron } = require('./jobs/slotGenerator');
    const { startReminderCron } = require('./jobs/reminders');
    startSlotGeneratorCron();
    startReminderCron();
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  server.close(async () => {
    const { pool } = require('./db');
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
