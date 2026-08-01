const Redis = require('ioredis');
const crypto = require('crypto');
const { Queue, Worker } = require('bullmq');
const botEngine = require('../services/botEngine');
const { query } = require('../db');
const logger = require('../utils/logger');
const { getClient: getLockRedisClient } = require('../utils/redisClient');

// ── Per-phone job lock ────────────────────────────────────────────
// Worker concurrency is 5: two rapid messages from the same phone can be
// picked up by two slots at once, both calling getSession/updateSession on
// the same row — a classic lost-update race (second writer's stale context
// clobbers the first writer's progress). A short Redis lock keyed by
// tenant+phone serializes processing per phone without affecting throughput
// across different phones.
const PHONE_LOCK_TTL_MS = 15000;       // safety net if a holder crashes before releasing
const PHONE_LOCK_MAX_WAIT_MS = 12000;  // give the current holder time to finish its turn
const PHONE_LOCK_POLL_MS = 250;

// Atomic release: only DEL if our token still owns the lock (mirrors
// utils/cronLock.js) — otherwise a slow job could delete a lock that has since
// expired and been re-acquired by someone else.
const RELEASE_PHONE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire a short-lived per-phone lock, polling for up to PHONE_LOCK_MAX_WAIT_MS
 * if another job currently holds it. Fails OPEN (returns as if acquired) on
 * Redis errors so a Redis blip never blocks bot replies entirely — the queue's
 * own Redis connection already governs whether jobs run at all.
 * @returns {Promise<{acquired: boolean, token: string|null}>}
 */
async function acquirePhoneLock(lockKey) {
  const client = getLockRedisClient();
  // No Redis configured — single-instance, and BullMQ itself can't be running
  // either (it needs the same Redis), so there is nothing to serialise against.
  if (!client) return { acquired: false, token: null, notConfigured: true };
  const token = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + PHONE_LOCK_MAX_WAIT_MS;
  while (true) {
    try {
      const result = await client.set(lockKey, token, 'NX', 'PX', PHONE_LOCK_TTL_MS);
      if (result === 'OK') return { acquired: true, token };
    } catch (err) {
      logger.warn('Phone lock acquire failed, processing without lock', { error: err.message });
      return { acquired: false, token: null, redisError: true };
    }
    if (Date.now() >= deadline) return { acquired: false, token: null };
    await sleep(PHONE_LOCK_POLL_MS);
  }
}

async function releasePhoneLock(lockKey, token) {
  if (!token) return;
  const client = getLockRedisClient();
  if (!client) return;
  try {
    await client.eval(RELEASE_PHONE_LOCK_SCRIPT, 1, lockKey, token);
  } catch (err) {
    logger.warn('Phone lock release failed (will expire via TTL)', { error: err.message });
  }
}

let botQueue = null;
let dlQueue = null;  // dead-letter queue for failed jobs
let emailQueue = null;
let botWorkerInstance = null; // stored so shutdown() can close it
let emailWorker = null;
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
      await botEngine.handle({ phone, text, buttonId, tenant: r.rows[0] });
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
        const { phone, text, buttonId, tenantId } = job.data || {};
        if (phone && tenantId) {
          await query(`
            INSERT INTO failed_webhooks (phone, tenant_id, text, button_id, message_type, error_message, next_retry_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '2 minutes')
          `, [phone, tenantId, text || null, buttonId || null, 'text', err.message?.slice(0, 500)]);
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

  // Email worker — processes email-jobs queue (create once; watchdog restarts
  // must not orphan a healthy instance)
  if (emailQueue && !emailWorker) {
    const emailConn = createConnection();
    const emailSvc = require('../services/email');
    emailWorker = new Worker('email-jobs', async (job) => {
      const type = job.name;
      // rethrow:true — a failed send must throw so BullMQ's 3-attempt backoff
      // actually retries it (see queueEmail's job options in services/email.js)
      if (type === 'booking_confirmation') {
        await emailSvc.sendBookingConfirmation(job.data.toEmail, job.data.data, { rethrow: true });
      } else if (type === 'reminder') {
        await emailSvc.sendReminderEmail(job.data.toEmail, job.data.data, { rethrow: true });
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
  shuttingDown = true; // stop the watchdog from restarting workers mid-shutdown
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
