const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { query, tenantQuery } = require('../db');
const botEngine = require('../services/botEngine');
const botWorker = require('../jobs/botWorker');
const wa = require('../services/whatsapp');
const { decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');
const { handleReminderConfirmation } = require('../jobs/reminders');
const { isEnabled } = require('../utils/featureFlags');

const testEndpointLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many test requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting — uses Redis (INCR+EXPIRE) when available so limits are
// shared across all backend instances. Falls back to in-process Maps when
// Redis is unavailable (e.g. local dev with old Redis).
const { getClient: getRedisClient } = require('../utils/redisClient');

const tenantMsgCounts = new Map(); // fallback: tenant_id -> { count, resetAt }
const phoneMsgCounts  = new Map(); // fallback: phone     -> { count, resetAt }

async function checkRateLimitRedis(key, maxPerMinute) {
  try {
    const redis = getRedisClient();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60); // set TTL on first increment
    return count <= maxPerMinute;
  } catch (_) {
    return null; // Redis unavailable — caller uses in-memory fallback
  }
}

// Max entries per in-memory map to prevent memory exhaustion if Redis is down
// and thousands of unique phones message simultaneously.
const IN_MEMORY_MAP_MAX_SIZE = 5000;

function checkRateLimitInMemory(map, key, maxPerMinute) {
  const now = Date.now();
  let entry = map.get(key);
  if (!entry || now > entry.resetAt) {
    // If map is at capacity and this is a new key, fail open (allow) to avoid blocking
    // legitimate users. The cleanup interval will shrink it shortly.
    if (!entry && map.size >= IN_MEMORY_MAP_MAX_SIZE) return true;
    entry = { count: 0, resetAt: now + 60000 };
    map.set(key, entry);
  }
  entry.count++;
  return entry.count <= maxPerMinute;
}

async function checkTenantRateLimit(tenantId) {
  const result = await checkRateLimitRedis(`rl:tenant:${tenantId}`, 60);
  if (result !== null) return result;
  return checkRateLimitInMemory(tenantMsgCounts, tenantId, 60);
}

async function checkPhoneRateLimit(phone) {
  const result = await checkRateLimitRedis(`rl:phone:${phone}`, 30);
  if (result !== null) return result;
  return checkRateLimitInMemory(phoneMsgCounts, phone, 30);
}

// Cleanup in-memory fallback maps every 5 minutes to prevent memory leak
const _rlCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of tenantMsgCounts.entries()) {
    if (now > val.resetAt + 60000) tenantMsgCounts.delete(key);
  }
  for (const [key, val] of phoneMsgCounts.entries()) {
    if (now > val.resetAt + 60000) phoneMsgCounts.delete(key);
  }
}, 5 * 60 * 1000);
_rlCleanupInterval.unref(); // don't block process exit

// Mask phone for logging: show only last 4 digits
function maskPhone(phone) {
  if (!phone || phone.length < 4) return '****';
  return '*'.repeat(Math.min(phone.length - 4, 8)) + phone.slice(-4);
}

// Startup warning if META_APP_SECRET looks like a placeholder
const { META_APP_SECRET } = process.env;
if (!META_APP_SECRET || META_APP_SECRET === 'PLACEHOLDER_REPLACE_WITH_APP_SECRET' || META_APP_SECRET === 'your_app_secret_here') {
  logger.warn('META_APP_SECRET is not configured — webhook signature verification is disabled. Set it in production!');
}

// ── META WEBHOOK VERIFICATION (GET) ──────────────────────────
router.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified by Meta ✅');
    return res.status(200).send(challenge);
  }
  logger.warn('Webhook verification failed', { mode, token });
  res.sendStatus(403);
});

// ── INCOMING MESSAGES (POST) ──────────────────────────────────
router.post('/webhook/whatsapp', async (req, res) => {
  // Acknowledge immediately — Meta requires response within 3 seconds
  res.sendStatus(200);

  try {
    const sig = req.headers['x-hub-signature-256'];
    const hasRealSecret = META_APP_SECRET &&
      META_APP_SECRET !== 'PLACEHOLDER_REPLACE_WITH_APP_SECRET' &&
      META_APP_SECRET !== 'your_app_secret_here';

    // If META_APP_SECRET is properly configured, always require and verify the signature
    // regardless of NODE_ENV — this prevents unsigned requests even in staging/dev if
    // a real secret is present.
    if (hasRealSecret) {
      if (!sig) {
        logger.warn('Unsigned webhook request rejected — META_APP_SECRET is configured');
        return;
      }
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
      const expected = 'sha256=' + crypto
        .createHmac('sha256', META_APP_SECRET)
        .update(rawBody)
        .digest('hex');
      if (sig !== expected) {
        logger.warn('Invalid Meta webhook signature — ignoring');
        return;
      }
    } else if (process.env.NODE_ENV === 'production' && !sig) {
      // Fallback: in production without a configured secret, still warn on unsigned requests
      logger.warn('Unsigned webhook request in production (META_APP_SECRET not configured)');
    }

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Handle both statuses and messages — need tenant for status tracking
    const phoneNumberId = value?.metadata?.phone_number_id;
    let tenant = null;

    if (phoneNumberId) {
      const r = await query(
        `SELECT * FROM tenants WHERE wa_phone_number_id=$1 AND status='active'`,
        [phoneNumberId]
      );
      tenant = r.rows[0] || null;
    }

    // Dev fallback
    if (!tenant && process.env.NODE_ENV !== 'production') {
      const r = await query(`SELECT * FROM tenants WHERE status='active' LIMIT 1`);
      tenant = r.rows[0] || null;
    }

    // Process delivery/read status updates (track in wa_messages)
    if (value?.statuses?.length) {
      if (tenant) {
        for (const status of value.statuses) {
          if (status.id) {
            wa.updateMessageStatus(tenant.schema_name, status.id, status.status).catch(() => {});
          }
        }
      }
      return;
    }

    if (!value?.messages?.length) return;

    if (!tenant) {
      logger.warn('No tenant found for webhook', { phoneNumberId });
      return;
    }

    const msg = value.messages[0];
    // Normalize phone: strip leading '+' so '919876543210' and '+919876543210' map to same user
    const phone = (msg.from || '').replace(/^\+/, '');
    if (!/^\d{7,20}$/.test(phone)) {
      logger.warn('Webhook received invalid phone format', { phone: maskPhone(msg.from || '') });
      return;
    }
    const msgId = msg.id;

    // Parse message content — keep unsupported types for later graceful fallback
    let text = '';
    let buttonId = null;
    let unsupportedType = null;
    let audioId = null;

    if (msg.type === 'text') {
      text = msg.text?.body || '';
    } else if (msg.type === 'interactive') {
      const inter = msg.interactive;
      if (inter.type === 'button_reply') {
        buttonId = inter.button_reply.id;
        text = inter.button_reply.title;
      } else if (inter.type === 'list_reply') {
        buttonId = inter.list_reply.id;
        text = inter.list_reply.title;
      }
    } else if (msg.type === 'button') {
      text = msg.button?.text || '';
    } else if (msg.type === 'audio') {
      audioId = msg.audio?.id || null;
      unsupportedType = 'audio';
    } else {
      // Track unsupported type — we'll send a helpful response after tenant lookup
      unsupportedType = msg.type;
    }

    if (!text && !buttonId && !unsupportedType) return;

    // Per-tenant rate limiting: max 60 messages/minute (Redis-backed, multi-instance safe)
    if (!await checkTenantRateLimit(tenant.id)) {
      logger.warn(`Rate limit exceeded for tenant ${tenant.name}`, { tenantId: tenant.id });
      return; // Already sent 200, just drop the message
    }

    // Per-phone rate limiting: max 5 messages/minute per phone number (Redis-backed)
    if (!await checkPhoneRateLimit(phone)) {
      logger.warn('Per-phone rate limit exceeded — dropping message', { phone: maskPhone(phone), tenant: tenant.slug });
      return;
    }

    // Audio messages → Whisper transcription (if feature flag enabled)
    if (unsupportedType === 'audio' && audioId) {
      const voiceEnabled = await isEnabled(tenant.id, 'voice_transcription_enabled').catch(() => false);
      if (voiceEnabled) {
        logger.info('Audio message → dispatching to Whisper transcription', { phone, audioId, tenant: tenant.slug });
        botEngine.handleVoiceMessage({ phone, audioId, tenant }).catch(err => {
          logger.error('Voice transcription failed', { error: err.message });
        });
        return;
      }
      // Voice disabled — fall through to unsupported message reply
    }

    // If message type is unsupported (image, document, sticker, etc.), send a helpful reply
    if (unsupportedType) {
      logger.info('Unsupported message type received', { phone, type: unsupportedType, tenant: tenant.slug });
      const waToken = tenant.wa_access_token_enc ? decrypt(tenant.wa_access_token_enc) : null;
      wa.sendText(phone,
        `Sorry, I can only process text messages. Please type *Hi* to start booking an appointment. 😊`,
        waToken, tenant.wa_phone_number_id
      ).catch(err => logger.warn('Failed to send unsupported-type reply', { phone, type: unsupportedType, error: err.message }));
      return;
    }

    // Idempotency — atomic INSERT dedup using the unique partial index on wa_message_id
    if (msgId) {
      try {
        const inserted = await tenantQuery(
          tenant.schema_name,
          `INSERT INTO wa_messages (phone, direction, message_type, content, wa_message_id)
           VALUES ($1,'in',$2,$3,$4)
           ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [phone, msg.type, (text || buttonId || '').slice(0, 500), msgId]
        );
        if (!inserted.rows[0]) {
          logger.info('Duplicate message skipped', { msgId, phone });
          return;
        }
      } catch (dupErr) {
        // Non-conflict errors (e.g. DB down) — log and still process rather than silently drop
        logger.warn('Message dedup check failed, processing anyway', { msgId, error: dupErr.message });
      }
    }

    // Mark message as read — shows blue double tick to user
    if (msgId) {
      const waToken = tenant.wa_access_token_enc ? decrypt(tenant.wa_access_token_enc) : null;
      wa.markRead(msgId, waToken, tenant.wa_phone_number_id).catch(() => {});
    }

    logger.info('Incoming WhatsApp message', { phone: maskPhone(phone), tenant: tenant.slug, type: msg.type });
    try { require('../utils/metrics').increment('webhook_messages_total'); } catch (_) {}

    // Reminder confirmation check: if user replied YES/NO to a 24h reminder,
    // handle it directly without going through the full bot state machine.
    // NOTE: "cancel" and "reschedule" are intentionally excluded — they are
    // standalone bot commands (cancel appointment, reschedule) and must NOT be
    // intercepted here even when a pending confirmation exists. The reminder
    // confirmation handler only accepts pure yes/no-style replies.
    if (text) {
      const isConfirmReply = /^(yes|no|confirm|haan|nahi|1|2)\b/i.test(text.trim());
      if (isConfirmReply) {
        const confirmResult = await handleReminderConfirmation(tenant.schema_name, phone, text).catch(() => false);
        if (confirmResult) {
          const waToken = tenant.wa_access_token_enc ? decrypt(tenant.wa_access_token_enc) : null;
          if (confirmResult === 'yes') {
            wa.sendText(phone,
              `✅ Thank you for confirming! We'll see you at your appointment. 😊\n\nIf plans change, reply *Reschedule* or *Cancel Appointment*.`,
              waToken, tenant.wa_phone_number_id
            ).catch(() => {});
          } else {
            wa.sendText(phone,
              `Got it! Reply *Cancel Appointment* to cancel your booking, or *Reschedule* to pick a new time. 🙏\n\nReply *Hi* for the main menu.`,
              waToken, tenant.wa_phone_number_id
            ).catch(() => {});
          }
          return;
        }
      }
    }

    const forceSync = process.env.DISABLE_QUEUE === 'true';
    if (!forceSync && botWorker.isQueueAvailable()) {
      // Backpressure check: fall back to sync if queue is saturated
      let waiting = 0;
      try { waiting = await botWorker.getQueue().getWaitingCount(); } catch (_) {}

      const { LIMITS } = require('../utils/errors');
      if (waiting > LIMITS.QUEUE_BACKPRESSURE_THRESHOLD) {
        logger.warn(`Bot queue backpressure: ${waiting} jobs waiting — processing synchronously`);
        botEngine.handle({ phone, text, buttonId, tenant }).catch(err => {
          logger.error('Sync bot processing error (backpressure fallback)', { error: err.message });
        });
      } else {
        await botWorker.getQueue().add('process', { phone, text, buttonId, tenantId: tenant.id }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        });
      }
    } else {
      // Sync fallback: process inline
      botEngine.handle({ phone, text, buttonId, tenant }).catch(err => {
        logger.error('Sync bot processing error', { error: err.message });
        // Save to failed_webhooks for retry
        query(`
          INSERT INTO failed_webhooks (phone, tenant_id, text, button_id, message_type, error_message, next_retry_at)
          VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '2 minutes')
        `, [phone, tenant.id, text || null, buttonId || null, msg?.type || 'text', err.message?.slice(0, 500)])
          .catch(dbErr => logger.warn('Failed to save webhook to retry queue', { error: dbErr.message }));
      });
    }

  } catch (err) {
    logger.error('Webhook handler error', {
      error: err.message,
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    });
  }
});

// ── DEV TEST ENDPOINT ─────────────────────────────────────────
if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_TEST_ENDPOINT === 'true') {
  router.post('/webhook/test', testEndpointLimiter, async (req, res) => {
    const { phone = '919999999999', message = 'Hi', button_id, tenant_slug } = req.body;
    try {
      const r = tenant_slug
        ? await query(`SELECT * FROM tenants WHERE slug=$1 AND status='active'`, [tenant_slug])
        : await query(`SELECT * FROM tenants WHERE status='active' ORDER BY created_at LIMIT 1`);
      if (!r.rows[0]) {
        return res.status(400).json({ error: 'No tenants found. Run: npm run seed' });
      }
      const tenant = r.rows[0];

      const responses = [];
      const waModule = require('../services/whatsapp');
      const origSendText = waModule.sendText;
      const origSendButtons = waModule.sendButtons;
      const origSendList = waModule.sendList;

      waModule.sendText = async (to, text) => { responses.push({ type: 'text', text }); };
      waModule.sendButtons = async (to, text, buttons) => { responses.push({ type: 'buttons', text, buttons }); };
      waModule.sendList = async (to, text, label, sections) => { responses.push({ type: 'list', text, label, sections }); };

      try {
        await botEngine.handle({ phone, text: message, buttonId: button_id, tenant });
      } finally {
        waModule.sendText = origSendText;
        waModule.sendButtons = origSendButtons;
        waModule.sendList = origSendList;
      }

      res.json({ ok: true, phone, message, tenant: tenant.name, responses });
    } catch (err) {
      res.status(500).json({
        error: err.message,
        stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
      });
    }
  });
}

module.exports = router;
