const router = require('express').Router();
const crypto = require('crypto');
const { query } = require('../db');
const botEngine = require('../services/botEngine');
const logger = require('../utils/logger');

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
    // Verify Meta signature (optional but recommended in production)
    const sig = req.headers['x-hub-signature-256'];
    if (sig && process.env.META_APP_SECRET && process.env.META_APP_SECRET !== 'PLACEHOLDER_REPLACE_WITH_APP_SECRET') {
      const expected = 'sha256=' + crypto
        .createHmac('sha256', process.env.META_APP_SECRET)
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
    const phone = msg.from; // e.g. "919876543210"

    // Parse message content
    let text = '';
    let buttonId = null;

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
      // Unsupported message type (image, audio, etc.)
      return;
    }

    if (!text && !buttonId) return;

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

    // Dev fallback — use first active tenant when phone ID not matched
    if (!tenant && process.env.NODE_ENV !== 'production') {
      const r = await query(`SELECT * FROM tenants WHERE status='active' LIMIT 1`);
      tenant = r.rows[0] || null;
    }

    if (!tenant) {
      logger.warn('No tenant found for webhook', { phoneNumberId });
      return;
    }

    logger.info('Incoming WhatsApp message', { phone, tenant: tenant.slug, text: text.slice(0, 50) });
    await botEngine.handle({ phone, text, buttonId, tenant });

  } catch (err) {
    logger.error('Webhook handler error', { error: err.message, stack: err.stack });
  }
});

// ── DEV TEST ENDPOINT ─────────────────────────────────────────
// Allows testing bot without real WhatsApp connection
if (process.env.NODE_ENV !== 'production') {
  router.post('/webhook/test', async (req, res) => {
    const { phone = '919999999999', message = 'Hi', button_id } = req.body;
    try {
      const r = await query(`SELECT * FROM tenants WHERE status='active' LIMIT 1`);
      if (!r.rows[0]) {
        return res.status(400).json({ error: 'No tenants found. Run: npm run seed' });
      }
      const tenant = r.rows[0];

      // Intercept outgoing messages and capture them
      const responses = [];
      const waModule = require('../services/whatsapp');
      const origSendText = waModule.sendText;
      const origSendButtons = waModule.sendButtons;
      const origSendList = waModule.sendList;

      waModule.sendText = async (to, text) => {
        responses.push({ type: 'text', text });
      };
      waModule.sendButtons = async (to, text, buttons) => {
        responses.push({ type: 'buttons', text, buttons });
      };
      waModule.sendList = async (to, text, label, sections) => {
        responses.push({ type: 'list', text, label, sections });
      };

      await botEngine.handle({ phone, text: message, buttonId: button_id, tenant });

      // Restore originals
      waModule.sendText = origSendText;
      waModule.sendButtons = origSendButtons;
      waModule.sendList = origSendList;

      res.json({ ok: true, phone, message, tenant: tenant.name, responses });
    } catch (err) {
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  });
}

module.exports = router;
