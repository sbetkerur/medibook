const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { query, tenantQuery } = require('../db');
const botEngine = require('../services/botEngine');
const botWorker = require('../jobs/botWorker');
const wa = require('../services/whatsapp');
const { decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');

const testEndpointLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many test requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

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

    // In production, reject unsigned requests
    if (process.env.NODE_ENV === 'production' && !sig) {
      logger.warn('Unsigned webhook request rejected in production');
      return;
    }

    // Verify signature when present and secret is properly configured
    if (sig && META_APP_SECRET &&
        META_APP_SECRET !== 'PLACEHOLDER_REPLACE_WITH_APP_SECRET' &&
        META_APP_SECRET !== 'your_app_secret_here') {
      const expected = 'sha256=' + crypto
        .createHmac('sha256', META_APP_SECRET)
        .update(JSON.stringify(req.body))
        .digest('hex');
      if (sig !== expected) {
        logger.warn('Invalid Meta webhook signature — ignoring');
        return;
      }
    }

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Ignore status updates (delivered, read)
    if (value?.statuses) return;
    if (!value?.messages?.length) return;

    const msg = value.messages[0];
    // Normalize phone: strip leading '+' so '919876543210' and '+919876543210' map to same user
    const phone = (msg.from || '').replace(/^\+/, '');
    if (!/^\d{7,20}$/.test(phone)) {
      logger.warn('Webhook received invalid phone format', { phone: msg.from });
      return;
    }
    const msgId = msg.id;

    // Parse message content — keep unsupported types for later graceful fallback
    let text = '';
    let buttonId = null;
    let unsupportedType = null;

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
    } else {
      // Track unsupported type — we'll send a helpful response after tenant lookup
      unsupportedType = msg.type;
    }

    if (!text && !buttonId && !unsupportedType) return;

    // Find tenant by WhatsApp Phone Number ID
    const phoneNumberId = value.metadata?.phone_number_id;
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

    if (!tenant) {
      logger.warn('No tenant found for webhook', { phoneNumberId });
      return;
    }

    // If message type is unsupported (image, audio, document, sticker, etc.), send a helpful reply
    if (unsupportedType) {
      logger.info('Unsupported message type received', { phone, type: unsupportedType, tenant: tenant.slug });
      const waToken = tenant.wa_access_token_enc ? decrypt(tenant.wa_access_token_enc) : null;
      wa.sendText(phone,
        `Sorry, I can only process text messages. Please type *Hi* to start booking an appointment. 😊`,
        waToken, tenant.wa_phone_number_id
      ).catch(() => {});
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
      } catch (_) { /* if dedup fails, still process */ }
    }

    logger.info('Incoming WhatsApp message', { phone, tenant: tenant.slug, text: text.slice(0, 50) });

    if (botWorker.isQueueAvailable()) {
      // Backpressure check: fall back to sync if queue is saturated
      let waiting = 0;
      try { waiting = await botWorker.getQueue().getWaitingCount(); } catch (_) {}

      if (waiting > 10000) {
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

      await botEngine.handle({ phone, text: message, buttonId: button_id, tenant });

      waModule.sendText = origSendText;
      waModule.sendButtons = origSendButtons;
      waModule.sendList = origSendList;

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
