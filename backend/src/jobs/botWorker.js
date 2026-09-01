const Redis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const botEngine = require('../services/botEngine');
const { query } = require('../db');
const logger = require('../utils/logger');
// Worker concurrency is 5: two rapid messages from the same phone can be picked
// up by two slots at once, both calling getSession/updateSession on the same row
// — a classic lost-update race. The lock (shared with the webhook's pre-tenant
// path, hence utils/) serialises per phone without affecting throughput across
// different phones.
const { acquirePhoneLock, releasePhoneLock } = require('../utils/phoneLock');

let botQueue = null;
let dlQueue = null;  // dead-letter queue for failed jobs
let botWorkerInstance = null; // stored so shutdown() can close it
let queueAvailable = false;
let workerStarted = false;
let watchdogStarted = false;
let shuttingDown = false;

function createConnection() {
  // Only reached after initQueue() has confirmed REDIS_URL is set.
  const conn = new Redis(process.env.REDIS_URL, {
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
  // No Redis configured — don't burn ~10s of connect timeout on a localhost
  // endpoint that isn't there. Matches the guard in utils/cronLock.js.
  if (!process.env.REDIS_URL) {
    logger.info('REDIS_URL not set — skipping BullMQ, using synchronous bot processing');
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
    queueAvailable = true;
    logger.info('BullMQ queues initialized (bot, with dead-letter queue)');

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
    const { phone, text, buttonId, tenantId, welcome } = job.data;
    const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [tenantId]);
    if (!r.rows[0]) return;

    // Serialize per phone (see acquirePhoneLock above) so two concurrent
    // worker slots never run getSession/updateSession for the same phone at
    // the same time. If we can't get the lock within the wait window (holder
    // still running, or Redis briefly unreachable), process anyway rather
    // than dropping the patient's message — better a rare race than silence.
    const lockKey = `botlock:${tenantId}:${phone}`;
    const { acquired, token, notConfigured } = await acquirePhoneLock(lockKey);
    if (!acquired && !notConfigured) {
      logger.warn('Phone lock not acquired before deadline — processing anyway', { phone, tenantId });
    }
    try {
      await botEngine.handle({ phone, text, buttonId, tenant: r.rows[0], welcome });
    } finally {
      if (acquired) await releasePhoneLock(lockKey, token);
    }
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

      // The dead-letter queue above is only inspected for DEPTH every 5
      // minutes (see the setInterval in setup()) — no per-message retry, no
      // admin alert. The sync fallback path in routes/webhook.js already has
      // exactly this problem solved: it inserts into failed_webhooks, and
      // jobs/retryWebhooks.js's cron picks rows up on a backoff schedule and
      // replays them via botEngine.handle({ phone, text, buttonId, tenant })
      // — the same call this worker itself makes — then emails super admins
      // if all retries are exhausted. Insert a matching row here so a bot job
      // that exhausted its BullMQ attempts gets the same automatic
      // retry-with-backoff and alerting instead of silently waiting in a
      // queue nobody actively drains.
      try {
        const { phone, text, buttonId, tenantId, welcome } = job.data || {};
        if (phone && tenantId) {
          await query(`
            INSERT INTO failed_webhooks (phone, tenant_id, text, button_id, message_type, welcome, error_message, next_retry_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '2 minutes')
          `, [phone, tenantId, text || null, buttonId || null, 'text', !!welcome, err.message?.slice(0, 500)]);
        }
      } catch (fwErr) {
        logger.error('Failed to record bot job failure in failed_webhooks', { error: fwErr.message });
      }
    }
  });

  botWorkerInstance.on('error', (err) => {
    logger.error('BullMQ worker error', { error: err.message });
  });

  // Watchdog: check every 2 minutes that the worker is still running.
  // BullMQ workers can silently stall after a Redis reconnect — if we detect
  // the worker is closed, restart it so the queue keeps processing.
  // Registered once: each watchdog-triggered restart re-enters this function,
  // and without the guard every restart stacked another interval and spawned a
  // duplicate email worker below.
  if (!watchdogStarted) {
    watchdogStarted = true;
    const watchdogInterval = setInterval(async () => {
      if (shuttingDown) return; // close() sets `closing` — don't fight shutdown
      if (!botWorkerInstance || botWorkerInstance.closing) {
        logger.warn('Bot worker watchdog: worker stopped — restarting...');
        workerStarted = false;
        startBotWorker();
      }
    }, 2 * 60 * 1000);
    watchdogInterval.unref();
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
  shuttingDown = true; // stop the watchdog from restarting workers mid-shutdown
  try {
    // Close workers first so in-flight jobs finish before queues are torn down
    if (botWorkerInstance) await botWorkerInstance.close();
    if (botQueue) await botQueue.close();
    if (dlQueue) await dlQueue.close();
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
