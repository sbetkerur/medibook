const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { query, tenantQuery } = require('../db');
const botEngine = require('../services/botEngine');
const botWorker = require('../jobs/botWorker');
const wa = require('../services/whatsapp');
const logger = require('../utils/logger');
const { handleReminderConfirmation } = require('../jobs/reminders');
const { isEnabled } = require('../utils/featureFlags');

const testEndpointLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many test requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Limit only matters when the endpoint is exposed in production via
  // ENABLE_TEST_ENDPOINT; in dev/test it just breaks longer smoke-test runs
  // (the full booking+cancel conversation is 30+ calls in under a minute).
  skip: () => process.env.NODE_ENV !== 'production',
});

// Rate limiting — uses Redis (atomic INCR+EXPIRE via incrWithTTL) when
// available so limits are shared across all backend instances. Falls back to
// in-process Maps when Redis is unavailable (e.g. local dev with old Redis).
const { incrWithTTL } = require('../utils/redisClient');

const tenantMsgCounts = new Map(); // fallback: tenant_id -> { count, resetAt }
const phoneMsgCounts  = new Map(); // fallback: phone     -> { count, resetAt }

async function checkRateLimitRedis(key, maxPerMinute) {
  try {
    const count = await incrWithTTL(key, 60);
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
    // If map is at capacity and this is a new key, try to evict the oldest expired entry first.
    // If no expired entry is found, fail closed to prevent unbounded memory growth from DoS.
    if (!entry && map.size >= IN_MEMORY_MAP_MAX_SIZE) {
      // Evict the oldest expired entry; if none found, fail closed to prevent DoS via memory exhaustion
      let evicted = false;
      for (const [k, v] of map.entries()) {
        if (now > v.resetAt) { map.delete(k); evicted = true; break; }
      }
      if (!evicted) return false;
    }
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

// Process a bot message synchronously (fire-and-forget). On failure, persist to
// failed_webhooks so the retry cron replays it — used by ALL sync fallback paths
// (queue unavailable, queue saturated, queue add failed). Previously only the
// queue-unavailable path saved failures; the other two silently lost messages.
function processSyncWithRetryFallback({ phone, text, buttonId, tenant, messageType, context }) {
  botEngine.handle({ phone, text, buttonId, tenant }).catch(err => {
    logger.error(`Sync bot processing error (${context})`, { error: err.message });
    query(`
      INSERT INTO failed_webhooks (phone, tenant_id, text, button_id, message_type, error_message, next_retry_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '2 minutes')
    `, [phone, tenant.id, text || null, buttonId || null, messageType || 'text', err.message?.slice(0, 500)])
      .catch(dbErr => logger.warn('Failed to save webhook to retry queue', { error: dbErr.message }));
  });
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
      // Constant-time comparison — a plain !== leaks timing information that
      // could help an attacker forge signatures byte by byte.
      const sigBuf = Buffer.from(String(sig));
      const expectedBuf = Buffer.from(expected);
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
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

    // ── STATUS UPDATES (delivery receipts) ───────────────────────
    // For status updates we need to find the tenant — use global_bot_sessions for routing.
    if (value?.statuses?.length) {
      const statusPhone = value.statuses[0]?.recipient_id;
      if (statusPhone) {
        const gs = await query(`SELECT tenant_id FROM global_bot_sessions WHERE phone=$1`, [statusPhone]).catch(() => null);
        if (gs?.rows[0]?.tenant_id) {
          const tr = await query(`SELECT schema_name FROM tenants WHERE id=$1`, [gs.rows[0].tenant_id]).catch(() => null);
          if (tr?.rows[0]) {
            for (const status of value.statuses) {
              if (status.id) {
                wa.updateMessageStatus(tr.rows[0].schema_name, status.id, status.status).catch(() => {});
              }
            }
          }
        }
      }
      return;
    }

    if (!value?.messages?.length) return;

    const msg = value.messages[0];
    // Normalize phone: strip leading '+' so '917795676142' and '+917795676142' map to same user
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

    // ── GLOBAL SESSION ROUTING (shared WhatsApp number) ──────────
    // All tenants share one phone number. Route each patient to their chosen clinic
    // via the global_bot_sessions table. New patients see a clinic selector first.
    let tenant = null;

    const isSwitchClinic = /^(switch|change)\s*(clinic|hospital|branch)?$/i.test((text || '').trim());
    if (isSwitchClinic) {
      await query(
        `UPDATE global_bot_sessions SET tenant_id=NULL, state='select_tenant', last_activity=NOW() WHERE phone=$1`,
        [phone]
      ).catch(() => {});
    }

    const gs = await query(`SELECT * FROM global_bot_sessions WHERE phone=$1`, [phone]).catch(() => null);
    const globalSession = gs?.rows[0] || null;

    if (!globalSession || !globalSession.tenant_id || globalSession.state === 'select_tenant') {
      // Load all active tenants
      const tenantsR = await query(
        `SELECT id, name, settings->>'city' as city FROM tenants WHERE status='active' ORDER BY name`
      );
      const activeTenants = tenantsR.rows;

      if (activeTenants.length === 0) {
        logger.warn('No active tenants — dropping incoming message', { phone: maskPhone(phone) });
        return;
      }

      if (activeTenants.length === 1) {
        // Auto-assign single tenant — no selection needed
        await query(
          `INSERT INTO global_bot_sessions (phone, tenant_id, state, last_activity)
           VALUES ($1,$2,'active',NOW())
           ON CONFLICT (phone) DO UPDATE SET tenant_id=$2, state='active', last_activity=NOW()`,
          [phone, activeTenants[0].id]
        );
        const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [activeTenants[0].id]);
        tenant = r.rows[0] || null;
      } else {
        // Multi-tenant: check if patient is selecting a clinic right now
        let selected = null;

        // buttonId from list/button reply may be a tenant UUID
        if (buttonId) {
          selected = activeTenants.find(t => t.id === buttonId);
        }

        if (!selected && text) {
          // Exact match only (case-insensitive) — patient must type the clinic name as listed
          const trimmed = text.trim();
          selected = activeTenants.find(t => t.name.toLowerCase() === trimmed.toLowerCase());
        }

        if (selected) {
          // Patient matched a clinic — confirm and route
          await query(
            `INSERT INTO global_bot_sessions (phone, tenant_id, state, last_activity)
             VALUES ($1,$2,'active',NOW())
             ON CONFLICT (phone) DO UPDATE SET tenant_id=$2, state='active', last_activity=NOW()`,
            [phone, selected.id]
          );
          await wa.sendText(phone, `✅ Clinic selected: *${selected.name}*`, null, null)
            .catch(err => logger.warn('Failed to send clinic confirmation', { error: err.message }));
          const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [selected.id]);
          tenant = r.rows[0] || null;
        } else {
          // No match — show clinic list as plain text and wait for typed reply
          await query(
            `INSERT INTO global_bot_sessions (phone, state, last_activity)
             VALUES ($1,'select_tenant',NOW())
             ON CONFLICT (phone) DO UPDATE SET tenant_id=NULL, state='select_tenant', last_activity=NOW()`,
            [phone]
          ).catch(() => {});

          const isRetry = globalSession?.state === 'select_tenant' && text &&
            !/^(hi|hello|hey|start|menu)$/i.test(text.trim());
          const prompt = isRetry
            ? `❌ No clinic found matching *"${text.trim()}"*.\n\nPlease type your clinic name and try again.`
            : `👋 Welcome to MediBook!\n\nPlease type the name of your clinic to get started.`;

          await wa.sendText(phone, prompt, null, null)
            .catch(err => logger.error('Failed to send clinic selection prompt', { error: err.message }));
          return;
        }
      }
    } else {
      // Patient already assigned to a tenant
      const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [globalSession.tenant_id]);
      tenant = r.rows[0] || null;

      if (!tenant) {
        // Tenant was deactivated — reset and re-run selection on next message
        await query(
          `UPDATE global_bot_sessions SET tenant_id=NULL, state='select_tenant', last_activity=NOW() WHERE phone=$1`,
          [phone]
        ).catch(() => {});
        logger.warn('Tenant deactivated — global session reset', { phone: maskPhone(phone) });
        return;
      }
    }

    if (!tenant) {
      logger.warn('Could not resolve tenant for phone', { phone: maskPhone(phone) });
      return;
    }

    // Per-tenant rate limiting: max 60 messages/minute (Redis-backed, multi-instance safe)
    if (!await checkTenantRateLimit(tenant.id)) {
      logger.warn(`Rate limit exceeded for tenant ${tenant.name}`, { tenantId: tenant.id });
      return; // Already sent 200, just drop the message
    }

    // Per-phone rate limiting: max 30 messages/minute per phone number (Redis-backed)
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
      wa.sendText(phone,
        `Sorry, I can only process text messages. Please type *Hi* to start booking an appointment. 😊`,
        null, null
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
      wa.markRead(msgId, null, null).catch(() => {});
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
      const isConfirmReply = /^(yes|no|confirm|haan|nahi|ha|ok|sure|nope)\b/i.test(text.trim());
      // Only treat a yes/no as a reminder confirmation when the patient is NOT in
      // the middle of a bot conversation. Otherwise an "ok"/"yes" that's really a
      // booking step (e.g. confirming a slot) would be hijacked and consumed here.
      // null = state unknown (lookup failed) — do NOT intercept in that case, so
      // a mid-conversation reply is never consumed here on a DB blip.
      let botSessionState = null;
      if (isConfirmReply) {
        try {
          const sr = await tenantQuery(tenant.schema_name, `SELECT state FROM bot_sessions WHERE phone=$1`, [phone]);
          botSessionState = sr.rows[0]?.state || 'idle';
        } catch (_) { /* leave null — fall through to bot engine below */ }
      }
      if (isConfirmReply && botSessionState === 'idle') {
        const confirmResult = await handleReminderConfirmation(tenant.schema_name, phone, text).catch(() => false);
        if (confirmResult) {
          if (confirmResult === 'yes') {
            wa.sendText(phone,
              `✅ Thank you for confirming! We'll see you at your appointment. 😊\n\nIf plans change, reply *Reschedule* or *Cancel Appointment*.`,
              null, null
            ).catch(() => {});
          } else {
            wa.sendText(phone,
              `Got it! Reply *Cancel Appointment* to cancel your booking, or *Reschedule* to pick a new time. 🙏\n\nReply *Hi* for the main menu.`,
              null, null
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
        processSyncWithRetryFallback({ phone, text, buttonId, tenant, messageType: msg?.type, context: 'backpressure fallback' });
      } else {
        try {
          await botWorker.getQueue().add('process', { phone, text, buttonId, tenantId: tenant.id }, {
            attempts: 2,
            backoff: { type: 'fixed', delay: 1000 },
            removeOnComplete: 100,
            removeOnFail: 50,
          });
        } catch (queueErr) {
          // Queue add failed (Redis timeout/disconnect) — fall back to sync so the
          // message is never silently dropped. This is the most common cause of
          // "bot not responding" when Redis has a blip.
          logger.warn('Queue add failed, falling back to sync processing', { error: queueErr.message });
          processSyncWithRetryFallback({ phone, text, buttonId, tenant, messageType: msg?.type, context: 'queue fallback' });
        }
      }
    } else {
      // Sync fallback: process inline
      processSyncWithRetryFallback({ phone, text, buttonId, tenant, messageType: msg?.type, context: 'queue unavailable' });
    }

  } catch (err) {
    logger.error('Webhook handler error', {
      error: err.message,
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    });
  }
});

// ── DEV TEST ENDPOINT ─────────────────────────────────────────
// Mutex to serialize /webhook/test calls — prevents concurrent requests from
// corrupting each other's module-level monkey-patch of the whatsapp module.
let _testEndpointMutex = Promise.resolve();

if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_TEST_ENDPOINT === 'true') {
  router.post('/webhook/test', testEndpointLimiter, async (req, res) => {
    const { phone = '917795676142', message = 'Hi', button_id, tenant_slug } = req.body;
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

      // Acquire mutex — wait for any in-flight test to finish before patching module globals
      let releaseMutex;
      const prevMutex = _testEndpointMutex;
      _testEndpointMutex = new Promise(resolve => { releaseMutex = resolve; });
      await prevMutex;

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
        releaseMutex();
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
