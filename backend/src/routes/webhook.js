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
const { isRealAppSecret } = require('../utils/errors');
const { parseChoiceNumber } = require('../services/bot/utils');
const { acquirePhoneLock, releasePhoneLock } = require('../utils/phoneLock');
const { KINDS, findPendingReplyTenant, clearPendingReply } = require('../services/pendingReply');
const { IST_TODAY_SQL } = require('../utils/dateTz');
const { searchTenants, isQueryTooGeneric, shortLabel, MAX_SHORTLIST } = require('../services/bot/clinicSearch');

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
if (!isRealAppSecret(META_APP_SECRET)) {
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
    // Shared with index.js's startup fail-fast — see isRealAppSecret().
    const hasRealSecret = isRealAppSecret(META_APP_SECRET);

    // If META_APP_SECRET is properly configured, always require and verify the signature
    // regardless of NODE_ENV — this prevents unsigned requests even in staging/dev if
    // a real secret is present.
    if (hasRealSecret) {
      if (!sig) {
        logger.warn('Unsigned webhook request rejected — META_APP_SECRET is configured');
        return;
      }
      // req.rawBody is captured by the express.json() verify callback mounted on
      // /api/webhook and /api/v1/webhook in index.js. If it's ever missing (e.g.
      // future middleware reordering, or this route mounted under a path that
      // parses JSON without the verify hook), re-serializing req.body will NEVER
      // byte-match what Meta actually signed — that failure must be diagnosable
      // as "rawBody missing", not lumped in with genuinely forged signatures.
      if (!req.rawBody) {
        logger.error('Webhook rawBody missing — check middleware mount order/verify callback wiring; falling back to re-serialized body (signature check will likely fail)');
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
        if (!req.rawBody) {
          logger.error('Webhook signature check failed with fallback rawBody — root cause is very likely the missing rawBody logged above, not a forged signature');
        } else {
          logger.warn('Invalid Meta webhook signature — ignoring');
        }
        return;
      }
    } else if (process.env.NODE_ENV === 'production' && !sig) {
      // Fallback: in production without a configured secret, still warn on unsigned requests
      logger.warn('Unsigned webhook request in production (META_APP_SECRET not configured)');
    }

    // Meta batches deliveries: one POST can carry several entries/changes and
    // several messages per value (rapid consecutive texts, coalesced redelivery
    // after downtime). Only entry[0]/changes[0]/messages[0] used to be
    // processed — everything else was ACKed and silently dropped.
    for (const entry of req.body?.entry || []) {
      for (const change of entry?.changes || []) {
        const value = change?.value;
        if (!value) continue;

        // ── STATUS UPDATES (delivery receipts) ───────────────────
        // Route each status by ITS recipient — a batch can span patients whose
        // sessions point at different tenants.
        for (const status of value.statuses || []) {
          if (!status?.id || !status.recipient_id) continue;
          const gs = await query(`SELECT tenant_id FROM global_bot_sessions WHERE phone=$1`, [status.recipient_id]).catch(() => null);
          if (!gs?.rows[0]?.tenant_id) continue;
          const tr = await query(`SELECT schema_name FROM tenants WHERE id=$1`, [gs.rows[0].tenant_id]).catch(() => null);
          if (tr?.rows[0]) {
            wa.updateMessageStatus(tr.rows[0].schema_name, status.id, status.status).catch(err => {
              logger.error('Failed to persist WhatsApp delivery status update', {
                waMessageId: status.id,
                status: status.status,
                tenantSchema: tr.rows[0].schema_name,
                error: err.message,
              });
            });
          }
        }

        // A value can carry both statuses and messages — process both.
        for (const msg of value.messages || []) {
          try {
            await processIncomingMessageSerialized(msg);
          } catch (msgErr) {
            logger.error('Webhook message processing failed', { msgId: msg?.id, error: msgErr.message });
          }
        }
      }
    }
  } catch (err) {
    logger.error('Webhook handler error', {
      error: err.message,
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    });
  }
});

// A bare "yes" or "4" is only meaningful as an answer to something. These are
// the two questions a CLINIC asks unprompted, via the reminder and feedback
// crons — the only cases where the sender, not the patient, decides which
// clinic the message belongs to.
const CONFIRMATION_REPLY_RE = /^(yes|no|confirm|haan|nahi|ha|ok|sure|nope)\b/i;
const RATING_REPLY_RE = /^[1-5]$/;

/**
 * If this message is an answer to a question a DIFFERENT clinic asked, return
 * that clinic. Otherwise null (the overwhelmingly common case).
 *
 * Both ends are verified before redirecting, because "1".."5" and "yes" are
 * also ordinary bot input — a patient mid-booking replying "2" to pick a date
 * must never be dragged into another clinic:
 *   - the CURRENT clinic must have nothing in flight (session idle), and
 *   - the OTHER clinic must actually be waiting for exactly this answer.
 * Any failure returns null and processing continues unchanged.
 */
async function resolveAskingTenant(phone, text, currentTenant) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  const kind = RATING_REPLY_RE.test(trimmed) ? KINDS.FEEDBACK
    : CONFIRMATION_REPLY_RE.test(trimmed) ? KINDS.CONFIRMATION
    : null;
  if (!kind) return null;

  try {
    const askingTenantId = await findPendingReplyTenant(phone, kind);
    if (!askingTenantId || askingTenantId === currentTenant.id) return null;

    // The patient is mid-conversation with their selected clinic — that
    // conversation owns the message, whatever it looks like.
    const cur = await tenantQuery(currentTenant.schema_name,
      `SELECT state FROM bot_sessions WHERE phone=$1`, [phone]);
    const curState = cur.rows[0]?.state || 'idle';
    if (curState !== 'idle' && curState !== 'main_menu') return null;

    const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [askingTenantId]);
    const asking = r.rows[0];
    if (!asking) return null;

    // Confirm the other clinic is genuinely still waiting. The pending row is a
    // hint with a TTL; this is the authoritative check.
    if (kind === KINDS.FEEDBACK) {
      const s = await tenantQuery(asking.schema_name,
        `SELECT state FROM bot_sessions WHERE phone=$1`, [phone]);
      if (s.rows[0]?.state !== 'collect_feedback_rating') return null;
    } else {
      const c = await tenantQuery(asking.schema_name, `
        SELECT 1 FROM reminder_confirmations rc
        JOIN appointments a ON a.id = rc.appointment_id
        WHERE rc.phone=$1 AND rc.response IS NULL AND a.status='confirmed'
          AND a.appointment_date >= ${IST_TODAY_SQL}
        LIMIT 1`, [phone]);
      if (!c.rows.length) return null;
    }
    return asking;
  } catch (err) {
    logger.warn('Asking-tenant lookup failed — using the selected clinic', { error: err.message });
    return null;
  }
}

// Per-phone serialisation for the PRE-TENANT stretch of processing.
//
// botWorker's lock only starts once a clinic is known, so everything before it
// — the global-session read, the clinic search, the shortlist write, the
// wa_messages dedup insert — ran unserialised. Two messages arriving together
// from a new patient therefore both searched, both wrote the session, and could
// both send the prompt. The window is short, so the wait is short too: on
// timeout we process anyway rather than delay the rest of Meta's batch.
//
// Note the lock covers the ENQUEUE, not the bot's own handling of the message —
// the sync fallback deliberately runs fire-and-forget, exactly as before.
const PRE_TENANT_LOCK = { ttlMs: 10000, maxWaitMs: 4000 };

async function processIncomingMessageSerialized(msg) {
  const phone = (msg?.from || '').replace(/^\+/, '');
  if (!phone) return processIncomingMessage(msg);

  const lockKey = `waphone:${phone}`;
  const { acquired, token } = await acquirePhoneLock(lockKey, PRE_TENANT_LOCK);
  try {
    return await processIncomingMessage(msg);
  } finally {
    if (acquired) await releasePhoneLock(lockKey, token);
  }
}

// One incoming patient message end-to-end: parse → tenant routing → dedup →
// rate limits → enqueue/sync. Extracted so the POST handler can iterate over
// Meta's batched payloads; early `return`s skip just this message.
async function processIncomingMessage(msg) {
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

    // Noun is REQUIRED — a bare "change" mid-booking ("change the date") must
    // not silently reset the patient's clinic selection.
    const isSwitchClinic = /^(switch|change)\s+(clinic|hospital|branch)$/i.test((text || '').trim());
    if (isSwitchClinic) {
      await query(
        `UPDATE global_bot_sessions SET tenant_id=NULL, state='select_tenant',
           search_matches=NULL, last_activity=NOW() WHERE phone=$1`,
        [phone]
      ).catch(() => {});
    }

    const gs = await query(`SELECT * FROM global_bot_sessions WHERE phone=$1`, [phone]).catch(() => null);
    const globalSession = gs?.rows[0] || null;

    // Pre-tenant idempotency. The wa_messages dedup below is the real one, but it
    // lives in a TENANT schema and so can't run until the clinic is resolved —
    // meaning a Meta redelivery of a first-contact message re-sent the clinic
    // prompt. global_bot_sessions.last_wa_message_id covers that window.
    if (msgId && globalSession?.last_wa_message_id === msgId) {
      logger.info('Duplicate pre-tenant message skipped', { msgId, phone: maskPhone(phone) });
      return;
    }

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

      // The patient SEARCHES for their clinic. The roster is never listed —
      // only the matches for what they typed, and only when there is more than
      // one of them. This runs even when a single tenant is onboarded: the
      // entry step must not change shape as clinics are added, and a patient
      // messaging the shared number should never be silently attached to a
      // clinic they did not name.
      let selected = null;
      const trimmed = (text || '').trim();
      const isGreeting = /^(hi|hello|hey|start|menu)$/i.test(trimmed);

      // 1. Tap on a shortlist row — row id is the tenant UUID.
      if (buttonId) {
        selected = activeTenants.find(t => t.id === buttonId) || null;
      }

      // 2. "2" — a pick from the numbered shortlist we last sent this phone.
      //    Re-checked against activeTenants so a stale reply can't select a
      //    tenant that has since been deactivated.
      const shortlist = Array.isArray(globalSession?.search_matches) ? globalSession.search_matches : [];
      if (!selected && trimmed && shortlist.length) {
        const n = parseChoiceNumber(trimmed);
        if (n >= 1 && n <= shortlist.length) {
          selected = activeTenants.find(t => t.id === shortlist[n - 1]) || null;
        }
      }

      // 3. Otherwise treat the message as a search query.
      let matches = [];
      let tooGeneric = false;
      if (!selected && trimmed && !isGreeting) {
        if (isQueryTooGeneric(trimmed)) tooGeneric = true;
        else {
          matches = searchTenants(activeTenants, trimmed);
          if (matches.length === 1) selected = matches[0];
        }
      }

      if (selected) {
        // Patient matched a clinic — confirm and route
        await query(
          `INSERT INTO global_bot_sessions (phone, tenant_id, state, last_activity, last_wa_message_id)
           VALUES ($1,$2,'active',NOW(),$3)
           ON CONFLICT (phone) DO UPDATE SET tenant_id=$2, state='active',
             search_matches=NULL, last_activity=NOW(),
             last_wa_message_id=EXCLUDED.last_wa_message_id`,
          [phone, selected.id, msgId || null]
        );
        await wa.sendText(phone, `✅ Clinic selected: *${selected.name}*`, null, null)
          .catch(err => logger.warn('Failed to send clinic confirmation', { error: err.message }));
        const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [selected.id]);
        tenant = r.rows[0] || null;
      } else {
        // No single match — re-prompt. Shown matches are stored in render
        // order so a numbered reply resolves; a search that matched nothing
        // clears the previous shortlist so an old "2" can't resurface.
        const shown = matches.length > 1 && matches.length <= MAX_SHORTLIST ? matches : [];

        // Record the message id so a Meta redelivery doesn't re-send this prompt.
        await query(
          `INSERT INTO global_bot_sessions (phone, state, last_activity, last_wa_message_id, search_matches)
           VALUES ($1,'select_tenant',NOW(),$2,$3::jsonb)
           ON CONFLICT (phone) DO UPDATE SET tenant_id=NULL, state='select_tenant',
             last_activity=NOW(), last_wa_message_id=EXCLUDED.last_wa_message_id,
             search_matches=EXCLUDED.search_matches`,
          [phone, msgId || null, shown.length ? JSON.stringify(shown.map(t => t.id)) : null]
        ).catch(() => {});

        if (shown.length) {
          const body = `🔍 ${matches.length} clinics match *"${trimmed}"*.\n\nPick yours:`;
          await wa.sendList(phone, body, 'Select clinic', [{
            title: 'Matching clinics',
            rows: shown.map(t => ({
              id: t.id,
              title: shortLabel(t.name),
              description: t.city ? `${t.name} — ${t.city}` : t.name,
            })),
          }], null, null).catch(err =>
            logger.error('Failed to send clinic shortlist', { error: err.message }));
          return;
        }

        let prompt;
        if (tooGeneric) {
          prompt = `🔍 Almost — nearly every clinic here is a "dental clinic".\n\n` +
            `Please send the distinctive part of your clinic's name (e.g. *Smile* for "Smile Dental Clinic").`;
        } else if (matches.length > MAX_SHORTLIST) {
          prompt = `🔍 *"${trimmed}"* matches ${matches.length} clinics — too many to show.\n\n` +
            `Please send a bit more of your clinic's name.`;
        } else if (trimmed && !isGreeting) {
          prompt = `❌ No clinic found matching *"${trimmed}"*.\n\n` +
            `Please check the spelling and send your clinic's name again. ` +
            `You can leave out "dental" and "clinic".`;
        } else {
          prompt = `👋 Welcome to MediBook!\n\n` +
            `🔍 Please send your clinic's name to search for it. ` +
            `A few letters are enough — you can leave out "dental" and "clinic".`;
        }

        await wa.sendText(phone, prompt, null, null)
          .catch(err => logger.error('Failed to send clinic selection prompt', { error: err.message }));
        return;
      }
    } else {
      // Patient already assigned to a tenant
      const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [globalSession.tenant_id]);
      tenant = r.rows[0] || null;

      if (!tenant) {
        // Tenant was deactivated — reset and re-run selection on next message.
        // search_matches is cleared too: a shortlist from an earlier search is
        // no longer on the patient's screen, and leaving it would let a stray
        // "2" pick a clinic they were never shown.
        await query(
          `UPDATE global_bot_sessions SET tenant_id=NULL, state='select_tenant',
             search_matches=NULL, last_activity=NOW() WHERE phone=$1`,
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

    // ── ANSWERS GO BACK TO WHOEVER ASKED ─────────────────────────
    // Everything above routes by the clinic the PATIENT chose. Reminders and
    // feedback requests are asked by a CLINIC, and the answer ("yes", "4")
    // names nobody — so for a patient who has since switched clinics it landed
    // in the wrong schema and was silently dropped. Hand it back to the asker
    // for this message only; the patient's selected clinic is left alone.
    const redirect = await resolveAskingTenant(phone, text, tenant);
    if (redirect) {
      logger.info('Reply redirected to the clinic that asked', {
        phone: maskPhone(phone), from: tenant.slug, to: redirect.slug,
      });
      tenant = redirect;
    }

    // Idempotency — atomic INSERT dedup using the unique partial index on
    // wa_message_id. This must run BEFORE rate limits and the voice/unsupported
    // branches: Meta redelivers on missed ACKs, and a redelivered voice message
    // used to be transcribed and fed through the state machine twice.
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
      // Same pattern resolveAskingTenant classifies on — one definition, so the
      // "is this a confirmation?" question can't be answered two ways.
      const isConfirmReply = CONFIRMATION_REPLY_RE.test(text.trim());
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
          // Answered — stop treating this clinic as waiting. (The feedback
          // equivalent needs no explicit clear: once the rating is recorded the
          // session leaves collect_feedback_rating, which is what
          // resolveAskingTenant verifies, and the row expires on its own.)
          await clearPendingReply(phone, tenant.id, KINDS.CONFIRMATION);
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
}

// ── DEV TEST ENDPOINT ─────────────────────────────────────────
// Mutex to serialize /webhook/test calls — prevents concurrent requests from
// corrupting each other's module-level monkey-patch of the whatsapp module.
let _testEndpointMutex = Promise.resolve();

if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_TEST_ENDPOINT === 'true') {
  router.post('/webhook/test', testEndpointLimiter, async (req, res) => {
    // In production the endpoint additionally requires a shared secret — it is
    // otherwise unauthenticated and returns any patient's appointment details
    // (and can book/cancel as any patient) keyed only by phone number.
    if (process.env.NODE_ENV === 'production') {
      const secret = process.env.TEST_ENDPOINT_SECRET || '';
      const provided = String(req.headers['x-test-secret'] || '');
      const a = Buffer.from(provided);
      const b = Buffer.from(secret);
      if (!secret || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'Unauthorized — set TEST_ENDPOINT_SECRET and send it as X-Test-Secret' });
      }
    }
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
