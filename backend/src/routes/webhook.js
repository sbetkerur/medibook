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
// maskPhone moved to services/bot/utils.js — the bot engine, the booking flow
// and the reminder cron log the same value and each needed it too.
const { maskPhone, isOptedOut, logMessage } = require('../services/bot/utils');
const { acquirePhoneLock, releasePhoneLock } = require('../utils/phoneLock');
const { KINDS, findPendingReplyTenant, clearPendingReply } = require('../services/pendingReply');
const { IST_TODAY_SQL } = require('../utils/dateTz');
const { sendPatientText } = require('../services/outbound');
const { extractEntryCode } = require('../utils/entryCode');
const { normalizeTemplateButton } = require('../utils/templateButtons');

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

// Process a bot message synchronously (fire-and-forget). On failure, persist to
// failed_webhooks so the retry cron replays it — used by ALL sync fallback paths
// (queue unavailable, queue saturated, queue add failed). Previously only the
// queue-unavailable path saved failures; the other two silently lost messages.
function processSyncWithRetryFallback({ phone, text, buttonId, tenant, messageType, context, welcome }) {
  botEngine.handle({ phone, text, buttonId, tenant, welcome }).catch(err => {
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
        //
        // Meta emits sent + delivered + read for EVERY outbound message, so this
        // is the highest-volume path in the webhook. It used to run two
        // sequential public-schema round-trips (global_bot_sessions, then
        // tenants) per status; resolving the whole batch's distinct recipients
        // with one joined query collapses that to a single query per POST.
        const statuses = (value.statuses || []).filter(s => s?.id && s.recipient_id);
        if (statuses.length) {
          const recipients = [...new Set(statuses.map(s => s.recipient_id))];
          const sr = await query(
            `SELECT g.phone, t.schema_name
               FROM global_bot_sessions g
               JOIN tenants t ON t.id = g.tenant_id
              WHERE g.phone = ANY($1::text[])`,
            [recipients]).catch(() => null);
          // A failed lookup drops the receipts rather than the whole POST — the
          // messages in this same value still have to be processed.
          const schemaByPhone = new Map((sr?.rows || []).map(r => [r.phone, r.schema_name]));

          for (const status of statuses) {
            const schemaName = schemaByPhone.get(status.recipient_id);
            if (!schemaName) continue;
            wa.updateMessageStatus(schemaName, status.id, status.status).catch(err => {
              logger.error('Failed to persist WhatsApp delivery status update', {
                waMessageId: status.id,
                status: status.status,
                tenantSchema: schemaName,
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

// A greeting restarts the whole conversation, clinic choice included.
//
// A patient asking to move to a different clinic. The noun is REQUIRED — a bare
// "change" mid-booking ("change the date") must not be read as this.
//
// Nothing here DETACHES them, because a QR scan is the only way to attach and a
// detached patient with no poster in front of them would have no way back. The
// answer is an instruction to scan, and scanning the other clinic's code is
// itself the switch — `entryCode` routing below honours a tagged code from any
// state, including mid-booking with someone else.
const SWITCH_CLINIC_RE = /^(switch|change)\s+(clinic|hospital|branch)$/i;

// A bare "yes" or "4" is only meaningful as an answer to something. These are
// the two questions a CLINIC asks unprompted, via the reminder and feedback
// crons — the only cases where the sender, not the patient, decides which
// clinic the message belongs to.
const CONFIRMATION_REPLY_RE = /^(yes|no|confirm|haan|nahi|ha|ok|sure|nope)\b/i;
const RATING_REPLY_RE = /^[1-5]$/;
// The third clinic-initiated question: "your next sitting isn't booked yet",
// sent by jobs/treatmentNudges.js. Must match botEngine's TREATMENT_KEYWORD_RE
// — the redirect and the handler have to agree on what counts as the answer, or
// the message is handed to a clinic whose engine will not act on it.
const TREATMENT_REPLY_RE = /^(my )?(treatment|treatments|sitting|next sitting|book treatment|book my treatment)$/i;
// The fourth: the six-month check-up recall (jobs/recalls.js), which tells the
// patient to reply *Menu*. Months can pass between the ask and the answer, so
// the chance the patient has since searched for a different clinic on the
// shared number is higher here than anywhere else — and "Menu" is the one word
// that is ALSO a perfectly ordinary instruction to the current clinic. The
// state checks below are what keep the two apart: a redirect only happens when
// the current clinic has nothing in flight AND the asking clinic still has an
// open recall.
const RECALL_REPLY_RE = /^(menu|book|book appointment|checkup|check up|check-up)$/i;

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

  // RECALL is tested LAST: its vocabulary ("book", "menu") is the broadest, and
  // a word that is also a confirmation or a treatment reply belongs to the
  // narrower question.
  const kind = RATING_REPLY_RE.test(trimmed) ? KINDS.FEEDBACK
    : TREATMENT_REPLY_RE.test(trimmed) ? KINDS.TREATMENT
    : CONFIRMATION_REPLY_RE.test(trimmed) ? KINDS.CONFIRMATION
    : RECALL_REPLY_RE.test(trimmed) ? KINDS.RECALL
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
    // At main_menu the digits ARE the menu: botEngine reads '1' as Book, '2' as
    // My Appointments, '3' as Check Status — and RATING_REPLY_RE matches all
    // three. A patient who picked a new clinic, landed on its menu and typed
    // '1' to book had that '1' filed as a 1-star review against the clinic they
    // left, and never got the booking they asked for. A rating and a menu pick
    // are indistinguishable here, so the clinic the patient is looking at keeps
    // it. ("yes"/"no" are not menu options, so those still redirect.)
    if (curState === 'main_menu' && kind === KINDS.FEEDBACK) return null;

    const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [askingTenantId]);
    const asking = r.rows[0];
    if (!asking) return null;

    // Confirm the other clinic is genuinely still waiting, AND that it can
    // actually receive the answer. Redirecting into a clinic that is mid-flow
    // does not deliver the answer — it feeds it to that clinic's state machine:
    // a "yes" handed to an abandoned booking's select_date step came back as
    // "❌ Booking cancelled." from a clinic the patient wasn't even talking to.
    // The pending row is a hint with a TTL; these are the authoritative checks.
    if (kind === KINDS.FEEDBACK) {
      const s = await tenantQuery(asking.schema_name,
        `SELECT state FROM bot_sessions WHERE phone=$1`, [phone]);
      if (s.rows[0]?.state !== 'collect_feedback_rating') return null;
    } else if (kind === KINDS.TREATMENT) {
      // botEngine only accepts the *Treatment* keyword from a resting state, so
      // redirecting into a clinic that is mid-flow would feed the word to that
      // flow's current step instead of opening the treatment list.
      const s = await tenantQuery(asking.schema_name,
        `SELECT state FROM bot_sessions WHERE phone=$1`, [phone]);
      const st = s.rows[0]?.state || 'idle';
      if (st !== 'idle' && st !== 'main_menu') return null;
      // The pending row is a hint with a TTL; this is the authoritative check.
      // A course the clinic has since booked, finished or cancelled is not
      // waiting for anything, and the word belongs to the current clinic.
      const openPlan = await tenantQuery(asking.schema_name, `
        SELECT 1
        FROM treatment_plans tp
        JOIN patients p ON p.id = tp.patient_id
        LEFT JOIN appointments a ON a.treatment_plan_id = tp.id AND a.status <> 'cancelled'
        WHERE p.phone = $1 AND p.deleted_at IS NULL
          AND tp.status IN ('proposed','in_progress')
        GROUP BY tp.id
        HAVING COUNT(a.id) < tp.total_visits
        LIMIT 1`, [phone]);
      if (!openPlan.rows.length) return null;
    } else if (kind === KINDS.RECALL) {
      // Same resting-state rule as TREATMENT: "Menu" handed to a clinic that is
      // mid-flow resets THAT flow instead of opening the menu the recall meant.
      const s = await tenantQuery(asking.schema_name,
        `SELECT state FROM bot_sessions WHERE phone=$1`, [phone]);
      const st = s.rows[0]?.state || 'idle';
      if (st !== 'idle' && st !== 'main_menu') return null;
      // Authoritative check: a recall the patient has already acted on (the
      // cron's closeActedOnRecalls flips it to 'booked') is not waiting for
      // anything, and the word belongs to the clinic they are looking at.
      const openRecall = await tenantQuery(asking.schema_name, `
        SELECT 1 FROM patient_recalls r
        JOIN patients p ON p.id = r.patient_id
        WHERE p.phone = $1 AND p.deleted_at IS NULL
          AND r.status = 'due' AND r.last_sent_at IS NOT NULL
        LIMIT 1`, [phone]);
      if (!openRecall.rows.length) return null;
    } else {
      // Mirror the reminder intercept further down, which only consumes a
      // confirmation when the session is idle and otherwise falls through into
      // the state machine. Both consumers of this question must agree on when
      // an answer is deliverable, or the redirect hands it somewhere the
      // intercept will refuse to take it.
      const s = await tenantQuery(asking.schema_name,
        `SELECT state FROM bot_sessions WHERE phone=$1`, [phone]);
      if ((s.rows[0]?.state || 'idle') !== 'idle') return null;
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
    // What a template quick-reply actually SAID, when routing uses its payload.
    let templateButtonLabel = null;

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
      // A quick-reply tap on a TEMPLATE (not an interactive message — those
      // arrive as type 'interactive'). A template button has no payload of its
      // own: the LABEL is what arrives, so "📅 Book my next sitting" reaches the
      // engine, whose keyword tests are anchored (/^treatment$/i) and match
      // none of it. `normalizeTemplateButton` maps the labels back to the
      // keywords; a send-time payload override, where one lands, is already a
      // keyword and passes through untouched.
      //
      // Deliberately fed in as `text`, NOT as buttonId: several steps gate on
      // the ABSENCE of a buttonId (the *Treatment* keyword, the clinics-near-me
      // trigger), so a template tap must behave exactly as if the patient had
      // typed it.
      templateButtonLabel = msg.button?.text || '';
      text = normalizeTemplateButton(msg.button?.payload || templateButtonLabel);
    } else if (msg.type === 'audio') {
      audioId = msg.audio?.id || null;
      unsupportedType = 'audio';
    } else {
      // Track unsupported type — we'll send a helpful response after tenant lookup
      unsupportedType = msg.type;
    }

    if (!text && !buttonId && !unsupportedType) return;

    // What the patient ACTUALLY sent, captured before routing may rewrite
    // `text` (see the clinic-selection branch). The message history must show
    // the clinic name they typed, not the greeting we synthesised from it.
    // The label first: for a template quick-reply, `text` has been replaced by
    // the payload, and clinic history must show what the patient tapped, not
    // the token it routed on.
    const inboundContent = (templateButtonLabel || text || buttonId || '').slice(0, 500);

    // ── GLOBAL SESSION ROUTING (shared WhatsApp number) ──────────
    // All tenants share one phone number, so every inbound message has to be
    // routed to a clinic. The ONLY thing that attaches a patient to one is the
    // clinic's own entry code, scanned off its QR (utils/entryCode.js) — there
    // is deliberately no name search and no browse-by-location, so a clinic's
    // patients are never shown another clinic's existence. Once attached, the
    // session persists: a returning patient just messages and carries on.
    let tenant = null;

    const trimmedText = (text || '').trim();
    const isSwitchClinic = SWITCH_CLINIC_RE.test(trimmedText);

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

    // ── ENTRY CODE (the clinic's QR) ─────────────────────────────
    // The one and only way a patient becomes attached to a clinic.
    //
    // A TAGGED code (`#K7M2QX`, which is what the deep link pre-types) is
    // honoured from ANY state: a patient half-way through a booking who scans a
    // different clinic's poster means it, and being told "please finish your
    // current booking first" would be absurd. A BARE code — the whole message
    // and nothing else, which is what typing it off a printed card produces —
    // is honoured only while no clinic is attached, because mid-conversation
    // six characters are far more likely to be an answer to a question.
    const entryRef = extractEntryCode(text);
    const attachedTenantId = globalSession?.tenant_id || null;
    // Set when this message is the scan itself, so the main menu that follows
    // can open with the clinic's name instead of the ordinary greeting. It must
    // survive the handoff to the engine — which happens through BullMQ, so it
    // rides on the job payload, not on a closure.
    let isQrArrival = false;

    let scannedTenant = null;
    if (entryRef && (entryRef.tagged || !attachedTenantId)) {
      // Only active clinics resolve. A suspended clinic's posters are still on
      // its wall, and attaching a patient to it would strand them somewhere
      // that cannot answer.
      const codeR = await query(
        `SELECT * FROM tenants WHERE entry_code=$1 AND status='active'`, [entryRef.code]
      ).catch(() => null);
      scannedTenant = codeR?.rows[0] || null;
    }

    if (scannedTenant) {
      // `pending_hospital_id` is written NULL rather than left alone: one code
      // identifies a CLINIC, not a branch, so booking must ask which branch. A
      // value parked by some earlier path must not leak into this booking.
      await query(
        `INSERT INTO global_bot_sessions (phone, tenant_id, state, last_activity, last_wa_message_id, pending_hospital_id)
         VALUES ($1,$2,'active',NOW(),$3,NULL)
         ON CONFLICT (phone) DO UPDATE SET tenant_id=$2, state='active',
           last_activity=NOW(), last_wa_message_id=EXCLUDED.last_wa_message_id,
           pending_hospital_id=NULL`,
        [phone, scannedTenant.id, msgId || null]
      );
      tenant = scannedTenant;

      // No "connecting you to…" handover line. It made sense when a patient had
      // SEARCHED and needed to be told which of several matches they got; after
      // a scan there is nothing to disambiguate — they pointed a camera at that
      // clinic's own poster. Sending it anyway put a switchboard between the
      // patient and the clinic, which is exactly the impression this product
      // must not give: from the patient's side this is the clinic's WhatsApp,
      // and the first thing they should see is the clinic's own welcome. The
      // engine's main menu follows immediately and carries the clinic's name in
      // its header, so nothing is lost by staying quiet here.

      // Hand the engine a greeting rather than the scanned message. The message
      // body is prose plus a code — not a valid answer to whatever step an old
      // session was on — and a greeting is what resets that session and opens
      // the clinic's main menu, which is where scanning a QR should land.
      text = 'Hi';
      buttonId = null;
      isQrArrival = true;
    } else if (attachedTenantId) {
      const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [attachedTenantId]);
      tenant = r.rows[0] || null;

      if (!tenant) {
        // Clinic was deactivated. Detach, and let the next message fall through
        // to the prompt below rather than answering as a clinic that is gone.
        await query(
          `UPDATE global_bot_sessions SET tenant_id=NULL, state='select_tenant',
             pending_hospital_id=NULL, last_activity=NOW() WHERE phone=$1`,
          [phone]
        ).catch(() => {});
        logger.warn('Tenant deactivated — global session reset', { phone: maskPhone(phone) });
        return;
      }

      // Asked to move clinics while attached. Nothing is detached: with the QR
      // as the only way in, a patient left with no clinic and no poster in
      // front of them would have no way back. Scanning the other clinic's code
      // IS the switch, and the tagged branch above already honours it from here.
      // Answered from inside the clinic's own voice. It deliberately does NOT
      // advertise that other clinics exist here — no roster, no "other clinics
      // on MediBook", not even the word "switch". The patient asked, so they
      // are told the one thing they need (scan the other place's code), framed
      // as this clinic pointing them elsewhere rather than as a directory
      // offering alternatives.
      if (isSwitchClinic) {
        await sendPatientText(tenant.schema_name, phone,
          `This is *${tenant.name}*.\n\nIf you're trying to reach a different practice, scan the QR code at their reception and it will open a chat with them.\n\nReply *Menu* to carry on here.`
        ).catch(err => logger.warn('Failed to send switch-clinic reply', { error: err.message }));
        return;
      }
    } else {
      // No clinic, and nothing in this message attaches one. Record the message
      // id first so a Meta redelivery does not re-send the prompt.
      await query(
        `INSERT INTO global_bot_sessions (phone, state, last_activity, last_wa_message_id, pending_hospital_id)
         VALUES ($1,'select_tenant',NOW(),$2,NULL)
         ON CONFLICT (phone) DO UPDATE SET tenant_id=NULL, state='select_tenant',
           last_activity=NOW(), last_wa_message_id=EXCLUDED.last_wa_message_id,
           pending_hospital_id=NULL`,
        [phone, msgId || null]
      ).catch(() => {});

      // Distinguish "your code is wrong" from "you haven't sent one". A patient
      // who scanned something and got a generic welcome has no idea whether the
      // scan failed or the clinic is not on MediBook.
      const header = entryRef ? "That code didn't match a clinic" : 'Welcome to MediBook';
      const body = entryRef
        ? `No clinic is using the code *${entryRef.code}*. The poster may be out of date — worth asking at the clinic's front desk for their current QR code.`
        : `Scan your clinic's QR code to start — it's at their reception desk, and usually on their card and website too.\n\nScanning opens this chat with everything already filled in; just press send.`;

      // Plain text, not buttons: there is nothing here for the patient to pick.
      // wa.sendText directly (not services/outbound.js) because no clinic is
      // attached, so there is no tenant schema to log the message into.
      await wa.sendText(phone, `*${header}*\n\n${body}`, null, null)
        .catch(err => logger.error('Failed to send entry prompt', { error: err.message }));
      return;
    }

    if (!tenant) {
      logger.warn('Could not resolve tenant for phone', { phone: maskPhone(phone) });
      return;
    }

    // Idempotency — atomic INSERT dedup using the unique partial index on
    // wa_message_id. This must run BEFORE rate limits and the voice/unsupported
    // branches: Meta redelivers on missed ACKs, and a redelivered voice message
    // used to be transcribed and fed through the state machine twice.
    //
    // Keyed on the patient's SELECTED clinic, and therefore deliberately BEFORE
    // the pending-reply redirect below. The redirect is not stable across
    // redeliveries: it fires only while the asking clinic is still waiting, and
    // handling the reply clears that pending row. So with the dedup running
    // after it, the first delivery wrote its marker in clinic A's schema and the
    // redelivery — no longer redirected — looked for that marker in clinic B's,
    // found nothing, and processed the same message a second time, sending B's
    // main menu to a patient who was never talking to B. The selected clinic is
    // the one value that is the same on both passes.
    if (msgId) {
      try {
        const inserted = await tenantQuery(
          tenant.schema_name,
          `INSERT INTO wa_messages (phone, direction, message_type, content, wa_message_id)
           VALUES ($1,'in',$2,$3,$4)
           ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [phone, msg.type, inboundContent, msgId]
        );
        if (!inserted.rows[0]) {
          logger.info('Duplicate message skipped', { msgId, phone: maskPhone(phone) });
          return;
        }
      } catch (dupErr) {
        // Non-conflict errors (e.g. DB down) — log and still process rather than silently drop
        logger.warn('Message dedup check failed, processing anyway', { msgId, error: dupErr.message });
      }
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
      // The answer belongs in the ASKING clinic's history too — it is the reply
      // to a message only they sent, and the dedup row above lives in the other
      // schema. Different schema, so the unique index cannot collide; logMessage
      // swallows its own errors, so history never blocks handling the reply.
      await logMessage(redirect.schema_name, phone, 'in', msg.type, inboundContent, msgId);
      tenant = redirect;
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
        logger.info('Audio message → dispatching to Whisper transcription', { phone: maskPhone(phone), audioId, tenant: tenant.slug });
        botEngine.handleVoiceMessage({ phone, audioId, tenant }).catch(err => {
          logger.error('Voice transcription failed', { error: err.message });
        });
        return;
      }
      // Voice disabled — fall through to unsupported message reply
    }

    // If message type is unsupported (image, document, sticker, etc.), send a helpful reply
    if (unsupportedType) {
      logger.info('Unsupported message type received', { phone: maskPhone(phone), type: unsupportedType, tenant: tenant.slug });
      // This reply is sent outside botEngine, so it never met the engine's
      // opt-out check — an unsubscribed patient sending a photo got an answer
      // from the clinic, and this line fires on EVERY image.
      if (!await isOptedOut(tenant.schema_name, phone)) {
        sendPatientText(tenant.schema_name, phone,
          `I can only read typed messages, I am afraid.\n\nPlease type *Menu* to get started.`
        ).catch(err => logger.warn('Failed to send unsupported-type reply', { phone: maskPhone(phone), type: unsupportedType, error: err.message }));
      }
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
          const ack = confirmResult === 'yes'
            ? `✅ Thank you for confirming! We'll see you at your appointment. 😊\n\nIf plans change, reply *Reschedule* or *Cancel Appointment*.`
            : `Got it! Reply *Cancel Appointment* to cancel your booking, or *Reschedule* to pick a new time. 🙏\n\nReply *Menu* for the main menu.`;
          sendPatientText(tenant.schema_name, phone, ack).catch(() => {});
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
        processSyncWithRetryFallback({ phone, text, buttonId, tenant, messageType: msg?.type, context: 'backpressure fallback', welcome: isQrArrival });
      } else {
        try {
          await botWorker.getQueue().add('process', { phone, text, buttonId, tenantId: tenant.id, welcome: isQrArrival }, {
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
          processSyncWithRetryFallback({ phone, text, buttonId, tenant, messageType: msg?.type, context: 'queue fallback', welcome: isQrArrival });
        }
      }
    } else {
      // Sync fallback: process inline
      processSyncWithRetryFallback({ phone, text, buttonId, tenant, messageType: msg?.type, context: 'queue unavailable', welcome: isQrArrival });
    }
}

// ── DEV TEST ENDPOINT ─────────────────────────────────────────
// The mutex and sender monkey-patching live in services/bot/testRunner.js,
// shared with the authenticated /admin/bot-test route (routes/admin.js) that
// the dashboard's Bot Tester tab actually calls — this one stays unauthenticated
// (behind NODE_ENV/secret below) for local dev and the entry-code test flows
// documented in CLAUDE.md, which take tenant_slug directly.
const { runBotTest } = require('../services/bot/testRunner');

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

      const responses = await runBotTest({ tenant, phone, message, buttonId: button_id });

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
// Exported for tests: when a reply belongs to the clinic that ASKED rather than
// the one the patient selected is a decision with two sharp edges — a menu pick
// must never be read as a star rating, and an answer must never be handed to a
// clinic whose session cannot receive it (see tests/askingTenant.unit.test.js).
module.exports.resolveAskingTenant = resolveAskingTenant;
// Exported for tests: nothing a patient can TYPE may detach them from their
// clinic — with the QR as the only way in, a detached patient with no poster in
// front of them has no way back (see tests/entryCode.unit.test.js).
module.exports.SWITCH_CLINIC_RE = SWITCH_CLINIC_RE;
