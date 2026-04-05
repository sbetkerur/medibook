const Redis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const botEngine = require('../services/botEngine');
const { query } = require('../db');
const logger = require('../utils/logger');

let botQueue = null;
let dlQueue = null;  // dead-letter queue for failed jobs
let emailQueue = null;
let botWorkerInstance = null; // stored so shutdown() can close it
let emailWorker = null;
let queueAvailable = false;
let workerStarted = false;

function createConnection() {
  const conn = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
    keepAlive: 30000,         // Send TCP keepalive every 30s to prevent Railway proxy from dropping idle connections
    connectTimeout: 10000,
    // NOTE: do NOT set commandTimeout here. BullMQ uses blocking Redis commands
    // (XREAD BLOCK, BRPOP) that intentionally run for many seconds while waiting
    // for new jobs. A commandTimeout would kill those and break the queue entirely.
    // Retry Redis connection with exponential backoff, capped at 10s, max 20 attempts.
    // Without this, a brief Redis restart would make the queue permanently unavailable
    // until the backend process was restarted.
    retryStrategy: (times) => {
      if (times > 20) return null; // give up after ~100s total — fall back to sync
      return Math.min(times * 500, 10000);
    },
  });
  conn.on('error', () => { /* suppress connection noise */ });
  return conn;
}

async function initQueue() {
  if (process.env.DISABLE_QUEUE === 'true') {
    logger.info('DISABLE_QUEUE=true — skipping BullMQ, using synchronous bot processing');
    return false;
  }
  try {
    const connection = createConnection();
    await connection.connect();
    // Check Redis version compatibility (BullMQ requires >= 5.0.0)
    const info = await connection.info('server');
    const versionMatch = info.match(/redis_version:(\d+)/);
    const majorVersion = versionMatch ? parseInt(versionMatch[1]) : 0;
    if (majorVersion < 5) {
      logger.warn(`BullMQ requires Redis >= 5.0.0, current: ${versionMatch?.[0]?.split(':')[1] || 'unknown'}. Falling back to synchronous bot processing.`);
      await connection.quit();
      return false;
    }
    await connection.quit();
    return true;
  } catch (err) {
    logger.warn('Redis not available for BullMQ, falling back to synchronous bot processing', { error: err.message });
    return false;
  }
}

async function setup() {
  const compatible = await initQueue();
  if (!compatible) {
    queueAvailable = false;
    return;
  }
  try {
    const connection = createConnection();
    botQueue = new Queue('bot-messages', { connection });
    // Dead-letter queue — stores jobs that failed all 3 attempts for manual inspection
    dlQueue = new Queue('bot-messages-failed', { connection });
    // Email queue — async sending with 3-attempt exponential backoff retry
    emailQueue = new Queue('email-jobs', { connection });
    // Wire email service to use queue
    require('../services/email').setEmailQueue(emailQueue);
    queueAvailable = true;
    logger.info('BullMQ queues initialized (bot + email, with dead-letter queue)');

    // Start worker immediately now that queue is ready (avoids race condition
    // where startBotWorker() is called from index.js before setup() completes)
    startBotWorker();

    // Alert if dead-letter queue grows too large (check every 5 minutes)
    const DLQ_ALERT_THRESHOLD = 50;
    setInterval(async () => {
      if (!dlQueue) return;
      try {
        const counts = await dlQueue.getJobCounts('waiting');
        const depth = counts.waiting || 0;
        if (depth >= DLQ_ALERT_THRESHOLD) {
          logger.error('Dead-letter queue depth exceeded threshold — manual intervention required', {
            queue: 'bot-messages-failed',
            depth,
            threshold: DLQ_ALERT_THRESHOLD,
          });
        }
      } catch (_) {}
    }, 5 * 60 * 1000).unref(); // .unref() prevents this timer from keeping the process alive
  } catch (err) {
    logger.warn('BullMQ queue init failed, using sync fallback', { error: err.message });
    queueAvailable = false;
  }
}

function startBotWorker() {
  if (!queueAvailable || !botQueue) {
    logger.info('BullMQ not available — bot messages processed synchronously');
    return null;
  }
  if (workerStarted) return null; // already running — called from both setup() and index.js
  workerStarted = true;

  const connection = createConnection();
  botWorkerInstance = new Worker('bot-messages', async (job) => {
    const { phone, text, buttonId, tenantId } = job.data;
    const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [tenantId]);
    if (!r.rows[0]) return;
    await botEngine.handle({ phone, text, buttonId, tenant: r.rows[0] });
  }, {
    connection,
    concurrency: 5,
  });

  botWorkerInstance.on('failed', async (job, err) => {
    logger.error('Bot job failed', { jobId: job?.id, attempts: job?.attemptsMade, error: err.message });
    // Move to dead-letter queue after all retries exhausted.
    // job.opts.attempts is set to 2 when jobs are enqueued (see webhook.js).
    // Fall back to 1 (BullMQ default) so we don't use 2 as a magic constant
    // that could diverge from the actual queue config.
    if (job && job.attemptsMade >= (job.opts?.attempts ?? 1) && dlQueue) {
      try {
        await dlQueue.add('failed', {
          original: job.data,
          error: err.message,
          attempts: job.attemptsMade,
          failed_at: new Date().toISOString(),
        }, { removeOnComplete: false, removeOnFail: false });
        logger.warn('Job moved to dead-letter queue', { jobId: job.id, phone: job.data?.phone });
      } catch (dlErr) {
        logger.error('Failed to write to dead-letter queue', { error: dlErr.message });
      }
    }
  });

  botWorkerInstance.on('error', (err) => {
    logger.error('BullMQ worker error', { error: err.message });
  });

  // Watchdog: check every 2 minutes that the worker is still running.
  // BullMQ workers can silently stall after a Redis reconnect — if we detect
  // the worker is closed, restart it so the queue keeps processing.
  const watchdogInterval = setInterval(async () => {
    if (!botWorkerInstance || botWorkerInstance.closing) {
      logger.warn('Bot worker watchdog: worker stopped — restarting...');
      workerStarted = false;
      startBotWorker();
    }
  }, 2 * 60 * 1000);
  watchdogInterval.unref();

  // Email worker — processes email-jobs queue
  if (emailQueue) {
    const emailConn = createConnection();
    const emailSvc = require('../services/email');
    emailWorker = new Worker('email-jobs', async (job) => {
      const type = job.name;
      if (type === 'booking_confirmation') {
        await emailSvc.sendBookingConfirmation(job.data.toEmail, job.data.data);
      } else if (type === 'reminder') {
        await emailSvc.sendReminderEmail(job.data.toEmail, job.data.data);
      } else if (type === 'admin_booking_alert') {
        await emailSvc.sendAdminBookingAlert(job.data);
      } else {
        logger.warn('Unknown email job type', { type });
      }
    }, { connection: emailConn, concurrency: 3 });

    emailWorker.on('failed', (job, err) => {
      logger.error('Email job failed', { jobId: job?.id, type: job?.name, attempts: job?.attemptsMade, error: err.message });
    });
    emailWorker.on('completed', (job) => {
      logger.info('Email job completed', { jobId: job?.id, type: job?.name });
    });
    logger.info('BullMQ email worker started (concurrency: 3)');
  }

  logger.info('BullMQ bot worker started (concurrency: 5)');
  return botWorkerInstance;
}

function isQueueAvailable() {
  return queueAvailable;
}

function getQueue() {
  return botQueue;
}

async function getQueueStats() {
  if (!queueAvailable || !botQueue) return { available: false };
  try {
    const [mainCounts, dlCounts] = await Promise.all([
      botQueue.getJobCounts('waiting', 'active', 'failed', 'completed', 'delayed'),
      dlQueue ? dlQueue.getJobCounts('waiting') : Promise.resolve({ waiting: 0 }),
    ]);
    return {
      available: true,
      main_queue: mainCounts,
      dead_letter_pending: dlCounts.waiting || 0,
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

async function shutdown() {
  try {
    // Close workers first so in-flight jobs finish before queues are torn down
    if (botWorkerInstance) await botWorkerInstance.close();
    if (emailWorker) await emailWorker.close();
    if (botQueue) await botQueue.close();
    if (dlQueue) await dlQueue.close();
    if (emailQueue) await emailQueue.close();
    logger.info('BullMQ workers and queues closed');
  } catch (err) {
    logger.warn('Error closing BullMQ on shutdown', { error: err.message });
  }
}

// Run setup immediately (non-blocking)
setup().catch((err) => {
  logger.error('BullMQ setup failed', { error: err.message });
  queueAvailable = false;
});

module.exports = { startBotWorker, isQueueAvailable, getQueue, getQueueStats, shutdown };
