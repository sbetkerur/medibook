const Redis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const botEngine = require('../services/botEngine');
const { query } = require('../db');
const logger = require('../utils/logger');

let botQueue = null;
let dlQueue = null;  // dead-letter queue for failed jobs
let emailQueue = null;
let emailWorker = null;
let queueAvailable = false;

function createConnection() {
  const conn = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
    keepAlive: 30000,         // Send TCP keepalive every 30s to prevent Railway proxy from dropping idle connections
    connectTimeout: 10000,
    commandTimeout: 30000,
  });
  conn.on('error', () => { /* suppress connection noise */ });
  return conn;
}

async function initQueue() {
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

  const connection = createConnection();
  const worker = new Worker('bot-messages', async (job) => {
    const { phone, text, buttonId, tenantId } = job.data;
    const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [tenantId]);
    if (!r.rows[0]) return;
    await botEngine.handle({ phone, text, buttonId, tenant: r.rows[0] });
  }, {
    connection,
    concurrency: 5,
  });

  worker.on('failed', async (job, err) => {
    logger.error('Bot job failed', { jobId: job?.id, attempts: job?.attemptsMade, error: err.message });
    // Move to dead-letter queue after all retries exhausted
    if (job && job.attemptsMade >= (job.opts?.attempts || 3) && dlQueue) {
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

  // Email worker — processes email-jobs queue
  if (emailQueue) {
    const emailConn = createConnection();
    const emailSvc = require('../services/email');
    emailWorker = new Worker('email-jobs', async (job) => {
      const { type, data: jobData } = job;
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
  return worker;
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
    if (emailWorker) await emailWorker.close();
    if (botQueue) await botQueue.close();
    if (dlQueue) await dlQueue.close();
    if (emailQueue) await emailQueue.close();
    logger.info('BullMQ queues closed');
  } catch (err) {
    logger.warn('Error closing BullMQ queues on shutdown', { error: err.message });
  }
}

// Run setup immediately (non-blocking)
setup().catch((err) => {
  logger.error('BullMQ setup failed', { error: err.message });
  queueAvailable = false;
});

module.exports = { startBotWorker, isQueueAvailable, getQueue, getQueueStats, shutdown };
