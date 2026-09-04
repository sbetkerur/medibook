'use strict';
/**
 * Public "try the WhatsApp bot" widget for the marketing site.
 *
 * Runs a message through the REAL bot engine via the same harness as the dev
 * POST /webhook/test and the authenticated POST /admin/bot-test
 * (services/bot/testRunner.js) — the WhatsApp senders are monkey-patched to
 * capture output instead of calling Meta, so no real WhatsApp number or
 * message is ever involved.
 *
 * UNLIKE /webhook/test, this route is reachable by anyone with no secret —
 * so it must NEVER take a tenant slug from the request. /webhook/test's own
 * doc comment says exactly what a free-form tenant_slug means: "returns any
 * patient's appointment details (and can book/cancel as any patient) keyed
 * only by phone number" for ANY tenant. This route hardcodes DEMO_TENANT_SLUG
 * and re-verifies read_only + active on every call — the same one-check
 * safety story as POST /auth/demo-session, so a misconfigured env var leaves
 * the widget offline rather than pointed at a real clinic.
 *
 * Second layer, inside the bot itself: every mutation point the bot could
 * reach (booking, cancel, reschedule, callback/appointment requests) already
 * refuses to write for a read_only tenant — see isReadOnlyDemo in
 * services/bot/utils.js. This route's tenant lock is what makes that
 * guarantee reachable by the public in the first place; neither layer
 * substitutes for the other.
 */
const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const logger = require('../utils/logger');
const { runBotTest } = require('../services/bot/testRunner');
const { LIMITS } = require('../utils/errors');

// Each call runs the full bot engine (DB queries against the demo schema), so
// this needs a real ceiling despite being unauthenticated by nature — there is
// no shared secret to gate it the way /webhook/test is gated in production.
// Not skipped in dev/test: unlike the internal test endpoint, this route only
// exists to be public.
const demoChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many messages — please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * One synthetic phone per browser session, derived server-side from a
 * client-supplied session id — never taken from the client directly, so
 * nobody can address a real number. Not that pragati-demo has any real
 * patient data to reach: nothing has ever written a `patients` row there
 * (the dashboard's read-only guard always blocked the admin walk-in route,
 * and the bot's own read-only guard now blocks its own booking path too), so
 * this can only ever address empty state. The result is 18 digits — always
 * longer than any real 10-digit Indian mobile number — so a synthetic phone
 * reads unmistakably fake in any log line it ends up in.
 */
function syntheticPhone(sessionId) {
  const hash = crypto.createHash('sha256').update(String(sessionId)).digest('hex');
  // 17 digits of hash entropy behind the fake '9' prefix (18 total, well inside
  // the ^[0-9]{7,20}$ CHECK). An 8-digit space collided at ~1% around 1,500
  // distinct sessions — two visitors sharing one bot_sessions row would see
  // each other's half-filled booking context.
  const digits = BigInt('0x' + hash.slice(0, 20)) % (10n ** 17n);
  return '9' + digits.toString().padStart(17, '0');
}

router.post('/demo/chat', demoChatLimiter, async (req, res) => {
  try {
    const slug = (process.env.DEMO_TENANT_SLUG || 'pragati-demo').trim();
    const tR = await query(`SELECT * FROM tenants WHERE slug=$1`, [slug]);
    const tenant = tR.rows[0];
    if (!tenant || tenant.read_only !== true || tenant.status !== 'active') {
      return res.status(404).json({ error: 'The live demo is not available right now.' });
    }

    let { session_id, message, button_id, is_first } = req.body || {};
    session_id = String(session_id || '').slice(0, 128);
    if (!session_id) return res.status(400).json({ error: 'session_id is required.' });
    message = String(message == null ? '' : message).slice(0, LIMITS.BOT_INPUT_MAX_LENGTH);
    button_id = button_id == null ? undefined : String(button_id).slice(0, 256);
    // The widget's opening turn carries neither — is_first synthesizes its own
    // "Hi" below. Only a non-first turn genuinely needs input.
    if (!message && !button_id && !is_first) return res.status(400).json({ error: 'message is required.' });

    const phone = syntheticPhone(session_id);
    // The widget's own opening turn — same synthesized "Hi" + welcome flag a
    // real QR scan produces (routes/webhook.js), so the first reply carries
    // the clinic-name arrival banner instead of looking like mid-conversation.
    const responses = is_first
      ? await runBotTest({ tenant, phone, message: 'Hi', welcome: true })
      : await runBotTest({ tenant, phone, message, buttonId: button_id });

    res.json({ ok: true, responses });
  } catch (err) {
    logger.error('Demo chat failed', { error: err.message });
    res.status(500).json({ error: 'Something went wrong at our end. Please try again.' });
  }
});

module.exports = router;
