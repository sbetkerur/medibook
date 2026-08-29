'use strict';

const { tenantQuery, query } = require('../../db');
const logger = require('../../utils/logger');
const { format } = require('date-fns');
const { toZonedTime } = require('../../utils/dateTz');

const IST = 'Asia/Kolkata';

const STATES = {
  IDLE: 'idle',
  MAIN_MENU: 'main_menu',
  SELECT_HOSPITAL: 'select_hospital',
  SELECT_DEPARTMENT: 'select_department',
  SELECT_DOCTOR: 'select_doctor',
  SELECT_DATE: 'select_date',
  SELECT_SLOT: 'select_slot',
  COLLECT_NAME: 'collect_name',
  COLLECT_DOB: 'collect_dob',
  COLLECT_GENDER: 'collect_gender',
  CONFIRM_BOOKING: 'confirm_booking',
  MY_APPOINTMENTS: 'my_appointments',
  RESCHEDULE_SELECT: 'reschedule_select',
  RESCHEDULE_DATE: 'reschedule_date',
  RESCHEDULE_SLOT: 'reschedule_slot',
  RESCHEDULE_CONFIRM: 'reschedule_confirm',
  CANCEL_SELECT: 'cancel_select',
  CANCEL_REASON: 'cancel_reason',
  CANCEL_CONFIRM: 'cancel_confirm',
  SELECT_PATIENT: 'select_patient',
  COLLECT_EMAIL: 'collect_email',
  COLLECT_CHIEF_COMPLAINT: 'collect_chief_complaint',
  CHECK_BOOKING_STATUS: 'check_booking_status',
  COLLECT_FEEDBACK_RATING: 'collect_feedback_rating',
  COLLECT_FEEDBACK_COMMENT: 'collect_feedback_comment',
  RESUME_CONFIRM: 'resume_confirm',
  SELECT_TREATMENT_PLAN: 'select_treatment_plan',
};

function genBookingId() {
  const { randomUUID } = require('crypto');
  // 10 hex chars = 40 bits of entropy. Using 8 previously gave ~1-in-4-billion
  // collision rate; 10 reduces it to ~1-in-trillion which is safe at scale.
  return 'MB' + randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
}

// Simple Levenshtein distance for fuzzy matching
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

/**
 * Parse a "reply with a number" selection, STRICTLY.
 *
 * parseInt() is wrong here: it parses a leading digit run out of anything, so
 * parseInt('3c1b2d3e-…') === 3 and parseInt('09:30 – 10:00') === 9. WhatsApp
 * keeps earlier list rows tappable forever, so a stale tap delivers a UUID row
 * id or a formatted row title into a handler expecting "1".."N" — which used to
 * silently select an unrelated date or time slot and carry on booking.
 *
 * Returns NaN unless the whole (trimmed) string is digits.
 */
function parseChoiceNumber(input) {
  const s = String(input == null ? '' : input).trim();
  return /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
}

/**
 * Mask a phone number for logging — last 4 digits only.
 *
 * utils/logger.js writes logs/combined.log in production, so an unmasked number
 * is a patient identifier persisted to disk (and shipped to whatever tails it).
 * Lives here rather than in routes/webhook.js, where it started, because the
 * webhook, the bot engine, the booking flow and the reminder cron all log the
 * same value and were each masking it (or not) on their own.
 */
function maskPhone(phone) {
  const s = String(phone == null ? '' : phone);
  if (s.length < 4) return '****';
  return '*'.repeat(Math.min(s.length - 4, 8)) + s.slice(-4);
}

// ── DESTRUCTIVE-CONFIRM BUTTON BINDING ────────────────────────
//
// whatsapp.js mints reply ids positionally — `btn_${i}_${Date.now()}` — and
// WhatsApp keeps every button it has ever delivered tappable forever. So a bare
// "btn_0" means "the first button of SOME message we once sent this phone", not
// "the button on the question you are answering". Matching it as a substring in
// a cancel/reschedule confirm step meant a patient scrolling up and tapping the
// old "🔄 Reschedule" button (btn_0 of the My Appointments card) answered "yes"
// to "This cannot be undone. Are you sure?" — appointment cancelled, slot
// released, admin alerted, with no confirmation from the patient at all.
//
// The fix binds the answer to the question: the confirm prompt records WHEN its
// buttons were minted, and only an id whose timestamp falls inside that window
// can act as a positional answer. Typed "yes"/"no"/"1"/"2" are unaffected —
// they carry their own intent and are matched by the callers' text patterns.

/** Send a confirm prompt and remember which buttons it minted. */
async function sendConfirmButtons(send, ctx, bodyText, buttons, opts) {
  const from = Date.now();
  await send.buttons(bodyText, buttons, opts);
  // Same process, same clock as whatsapp.js's Date.now() — the ids this send
  // just created are exactly those with a timestamp in [from, to].
  ctx._confirm_btns = { from, to: Date.now() };
}

/**
 * Classify a reply against the buttons the current confirm prompt rendered.
 *
 * @returns {number|null} null — not a positional button reply at all (typed
 *   text, or a list-row id); -1 — a positional button reply that does NOT
 *   belong to this prompt (a stale tap: re-ask, never act on it); otherwise the
 *   0-based index of the button on the prompt we just sent.
 */
function confirmButtonIndex(ctx, choice) {
  const m = /^btn_(\d+)_(\d+)$/.exec(String(choice == null ? '' : choice));
  if (!m) return null;
  const w = ctx && ctx._confirm_btns;
  const ts = Number(m[2]);
  // No window recorded (context write lost, or a prompt that predates this
  // binding) — fail CLOSED. An unverifiable tap on a destructive question is
  // exactly the case this exists for.
  if (!w || !(ts >= w.from && ts <= w.to)) return -1;
  return Number(m[1]);
}

// Substring matching below this length is not evidence of intent — it is a
// coin flip. "a" is a substring of most names, so a one-character reply used to
// resolve to whichever doctor happened to be first in the list.
const MIN_SUBSTRING_MATCH_LEN = 3;

/**
 * Resolve free-text input to one of `items`.
 *
 * Returns null when the input is too short to be meaningful, matches nothing,
 * or matches MORE THAN ONE item. Ambiguity must never be resolved by list
 * order: this picks the doctor a patient is booked with, so a wrong guess is
 * worse than asking again.
 */
function fuzzyFind(items, input, nameField = 'name') {
  if (!input || input.length === 0) return null;
  const lower = input.toLowerCase();
  const nameOf = item => (item[nameField] || '').toLowerCase();

  // Exact name match wins outright, at any length, and is unambiguous by intent.
  const exact = items.filter(item => nameOf(item) === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // two identically-named items — ask instead

  // Substring match: long enough to be intentional, and unique.
  if (lower.length >= MIN_SUBSTRING_MATCH_LEN) {
    const partial = items.filter(item => nameOf(item).includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) return null; // e.g. "sha" matching two doctors
  }

  // Guard: skip levenshtein for very long inputs to prevent O(m*n) DoS
  if (lower.length < MIN_SUBSTRING_MATCH_LEN || lower.length > 50) return null;

  let best = null, bestDist = Infinity, bestTied = false;
  for (const item of items) {
    // Truncate long item names so levenshtein stays bounded
    const name = nameOf(item).slice(0, 50);
    const dist = levenshtein(lower, name);
    const threshold = Math.max(2, Math.floor(name.length * 0.4));
    if (dist > threshold) continue;
    if (dist < bestDist) { bestDist = dist; best = item; bestTied = false; }
    else if (dist === bestDist) { bestTied = true; }
  }
  // A tie means two names are equally close — no basis to prefer either.
  return bestTied ? null : best;
}

async function getSession(schemaName, phone) {
  // Atomic upsert — avoids a race condition where two concurrent webhook
  // deliveries for the same phone both SELECT no rows and both try INSERT,
  // causing a unique constraint violation on the second attempt.
  await tenantQuery(schemaName,
    `INSERT INTO bot_sessions (phone, state, context) VALUES ($1, 'idle', '{}')
     ON CONFLICT (phone) DO NOTHING`,
    [phone]);
  const r = await tenantQuery(schemaName,
    `SELECT * FROM bot_sessions WHERE phone = $1`, [phone]);
  return r.rows[0];
}

async function updateSession(schemaName, phone, state, context) {
  const { LIMITS } = require('../../utils/errors');
  const plainJson = JSON.stringify(context || {});
  const byteLen = Buffer.byteLength(plainJson, 'utf8');
  if (byteLen > LIMITS.SESSION_CONTEXT_MAX_BYTES) {
    logger.warn(`Session context too large (${byteLen} bytes), resetting to idle`, { phone: maskPhone(phone) });
    await tenantQuery(schemaName,
      `UPDATE bot_sessions SET state='idle', context='{}', last_activity=NOW() WHERE phone=$1`, [phone]);
    // The reset is deliberate; the SILENCE was not. The caller has already sent
    // the next prompt ("Who is this appointment for?"), so without this the
    // patient answers a question whose session no longer exists and gets the
    // main menu back with no explanation — and it happens exactly at the end of
    // a long booking (a multi-branch clinic's ctx carries _hospitals + _depts +
    // _doctors + _dates + _slots + _patients of 36-char UUIDs, which crosses the
    // limit around the patient-selection step).
    // Lazy require: services/outbound.js requires THIS module for logMessage.
    try {
      const { sendPatientText } = require('../outbound');
      await sendPatientText(schemaName, phone,
        'This conversation got too long for me to follow, so I have started it fresh.\n\n' +
        'Nothing was booked. Reply *Menu* to pick up again.');
    } catch (err) {
      logger.warn('Session-reset notice failed to send', { phone: maskPhone(phone), error: err.message });
    }
    return;
  }
  // Encrypt context before storage to protect PII (patient names, DOB, selected options)
  const { encrypt } = require('../../utils/encryption');
  let encryptedContext;
  try {
    encryptedContext = JSON.stringify({ _enc: encrypt(plainJson) });
  } catch (encErr) {
    logger.warn('Session context encryption failed, resetting to idle', { error: encErr.message });
    await tenantQuery(schemaName,
      `UPDATE bot_sessions SET state='idle', context='{}', last_activity=NOW() WHERE phone=$1`, [phone]);
    return;
  }
  // UPSERT, not UPDATE: the greeting fast-path in botEngine calls updateSession
  // BEFORE getSession has created a row. A plain UPDATE silently no-ops for a
  // brand-new phone, so the first "Hi" left no session and the patient's first
  // "Book" tap landed in idle state — re-showing the menu instead of booking.
  await tenantQuery(schemaName,
    `INSERT INTO bot_sessions (phone, state, context, last_activity)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (phone) DO UPDATE SET state=$2, context=$3::jsonb, last_activity=NOW()`,
    [phone, state, encryptedContext]);
}

/**
 * Reset a bot session to idle with empty context. Thin wrapper around
 * updateSession() so every reset site — botEngine's opt-out handler, the
 * admin bot-session-reset route, and the sessionCleaner cron — goes through
 * the same encryption/upsert/size-check guarantees instead of hand-rolling a
 * raw `UPDATE bot_sessions SET state='idle', context='{}' ...`. Those raw
 * writes were harmless while context was always literally empty, but would
 * silently skip encryption if ever reused to reset with non-empty context.
 */
async function resetSessionToIdle(schemaName, phone) {
  return updateSession(schemaName, phone, STATES.IDLE, {});
}

/**
 * Has this patient opted out of this clinic's WhatsApp messages?
 *
 * botEngine enforces opt-out at the top of _handleInner, but several sends
 * never reach it: the webhook's unsupported-type reply (fires on every image),
 * the clinic-selection confirmation, and the voice path (which used to pay for
 * a Meta media download and a Whisper call before handle() dropped the
 * message). They all need the same answer, so they all ask here.
 *
 * Non-fatal: an unreadable patients table returns false, i.e. behave exactly as
 * before rather than going silent on every patient.
 *
 * "Any profile" rather than "the first profile": a phone can carry several
 * family profiles, and both the opt-out and the re-subscribe writes set the
 * flag on ALL rows for the phone, so the two readings agree — but this one does
 * not depend on which row an unordered SELECT happens to return first.
 */
async function isOptedOut(schemaName, phone) {
  try {
    const r = await tenantQuery(schemaName,
      `SELECT opted_out FROM patients WHERE phone=$1 AND opted_out=true LIMIT 1`, [phone]);
    return r.rows.length > 0;
  } catch (_) {
    return false;
  }
}

async function getPatient(schemaName, phone) {
  const r = await tenantQuery(schemaName,
    `SELECT id, phone, name, email, date_of_birth, gender, visit_count FROM patients WHERE phone=$1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`, [phone]);
  return r.rows[0] || null;
}

async function getPatients(schemaName, phone) {
  const r = await tenantQuery(schemaName,
    `SELECT id, phone, name, date_of_birth, gender, visit_count FROM patients WHERE phone=$1 AND deleted_at IS NULL ORDER BY created_at ASC`, [phone]);
  return r.rows;
}

async function logMessage(schemaName, phone, direction, type, content, waMessageId) {
  try {
    // Only a real Meta id (a "wamid...." string) belongs in this column. The
    // /api/webhook/test endpoint and the bot tests monkey-patch the senders with
    // stubs that return whatever their body evaluates to (undefined, an array
    // length, …); writing those would poison the unique index with junk ids.
    const msgId = typeof waMessageId === 'string' && waMessageId ? waMessageId : null;
    // wa_message_id carries a UNIQUE partial index (idx_wa_messages_msg_id).
    // Inbound and outbound ids are separate Meta namespaces so a clash is a
    // freak event — but an unguarded INSERT would turn one into a thrown error
    // in the middle of a booking, losing the patient's reply over a history row.
    await tenantQuery(schemaName,
      `INSERT INTO wa_messages (phone, direction, message_type, content, wa_message_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
      [phone, direction, type, content, msgId]);
  } catch (err) {
    logger.warn('logMessage failed', { phone: maskPhone(phone), direction, error: err.message });
  }
}

// The staff-facing template. See docs/whatsapp-templates.md.
const STAFF_ALERT_TEMPLATE = 'clinic_staff_alert';

/**
 * Send a WhatsApp alert to all admin users who have notify_phone set.
 *
 * TEMPLATE-FIRST, and this is not optional here. Meta only allows free-form
 * text inside the 24-hour customer service window, and a clinic owner NEVER
 * messages the shared number — that is the entire point of the QR entry. So an
 * owner is permanently outside the window, and the plain `wa.sendText` this
 * used to be failed 100% of the time in production: every "new booking" alert,
 * and every Monday summary, silently rejected while the log recorded a
 * per-admin warning nobody reads.
 *
 * The template carries the whole alert body in one variable. That is unusual,
 * and deliberate: these messages are genuinely free-form (a booking, a
 * cancellation, a weekly summary) and inventing a template per alert type would
 * mean a Meta re-approval every time the wording changed.
 *
 * Never throws — logs warnings on failure.
 */
async function notifyAdminWhatsApp(schema, tenant, message, opts = {}) {
  try {
    // opts.senders is the test-harness capture object (services/bot/testRunner.js)
    // when this runs under /webhook/test or /admin/bot-test — routes the alert
    // into the captured output instead of a real WhatsApp send. Real runs pass
    // nothing and fall through to the wa module below.
    const injected = opts.senders || null;
    const adminUsers = await tenantQuery(schema,
      // ORDER BY, and a ceiling that is a safety valve rather than a policy.
      // This function is documented — and named — as fanning out to ALL admins
      // with a notify_phone, but it was `LIMIT 3` with no ORDER BY: a
      // four-partner practice had one partner silently cut out of every booking
      // and cancellation alert, and because an unordered LIMIT may return rows
      // in any order, WHICH partner could change from one call to the next. The
      // row count is bounded by the clinic's own admin staff anyway.
      `SELECT notify_phone FROM users
        WHERE role = 'admin' AND is_active = true AND notify_phone IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 10`);
    if (!adminUsers.rows.length) return;
    // Shared phone — use global META_* env vars. `injected` (test harness) wins.
    const wa = injected || require('../whatsapp');
    const clinicName = String(tenant?.name || 'your clinic').slice(0, 60);

    for (const admin of adminUsers.rows) {
      let waMessageId = null;
      try {
        waMessageId = await wa.sendTemplate(admin.notify_phone, STAFF_ALERT_TEMPLATE, [{
          type: 'body',
          parameters: [
            { type: 'text', text: clinicName },
            // Meta rejects newlines in a template parameter, so the body is
            // flattened. The alert stays readable — it is a short list of
            // facts, not prose — and the dashboard has the full detail.
            { type: 'text', text: String(message).replace(/\s*\n+\s*/g, ' · ').slice(0, 900) },
          ],
        }], null, null);
      } catch (_templateErr) {
        // Falls back to text, which still works for the minority of staff who
        // HAVE messaged the number recently (during onboarding, say). Better a
        // best-effort send than none while the template awaits approval.
        try {
          waMessageId = await wa.sendText(admin.notify_phone, message, null, null);
        } catch (err) {
          logger.warn('Admin WhatsApp alert failed', { error: err.message });
          continue;
        }
      }
      // Recorded like any other outbound message, but under its own type so a
      // conversation view can keep staff alerts out of patient threads — and so
      // services/messageBudget.js never counts a staff alert against a
      // PATIENT's budget, which matters when a staff member is also a patient.
      // The Meta id is what delivery receipts key on.
      await logMessage(schema, admin.notify_phone, 'out', 'admin_alert', message, waMessageId)
        .catch(() => {});
    }
  } catch (err) {
    logger.warn('notifyAdminWhatsApp failed', { error: err.message });
  }
}

/**
 * The clinic's phone number, for the messages that tell a patient to ring.
 *
 * The bot says "please call the clinic" in half a dozen places — including the
 * emergency reply, where it is the ONLY useful instruction — and used to give
 * no number at all, leaving someone in pain to go and find it. `hospitals.phone`
 * has been in the schema the whole time and was never read.
 *
 * Prefers the branch the patient is dealing with; falls back to any active
 * branch that has a number, because a patient who has not chosen a branch yet
 * still needs someone to ring. Returns null when the clinic has stored no
 * number anywhere, so callers can omit the line rather than print an empty one.
 */
async function clinicPhone(schemaName, hospitalId) {
  try {
    if (hospitalId) {
      const r = await tenantQuery(schemaName,
        `SELECT phone FROM hospitals WHERE id=$1 AND is_active=true AND deleted_at IS NULL`, [hospitalId]);
      const p = r.rows[0]?.phone?.trim();
      if (p) return p;
    }
    const any = await tenantQuery(schemaName,
      `SELECT phone FROM hospitals
        WHERE is_active=true AND deleted_at IS NULL AND phone IS NOT NULL AND btrim(phone) <> ''
        ORDER BY created_at LIMIT 1`);
    return any.rows[0]?.phone?.trim() || null;
  } catch (err) {
    // Never fatal: a missing phone line must not break the message it was
    // meant to improve.
    logger.warn('clinicPhone lookup failed', { error: err.message });
    return null;
  }
}

/**
 * A ready-to-append "call us on X" line, or '' when no number is stored.
 * Leading newlines included so callers can concatenate unconditionally.
 */
async function clinicPhoneLine(schemaName, hospitalId) {
  const phone = await clinicPhone(schemaName, hospitalId);
  return phone ? `\n\n📞 *${phone}*` : '';
}

/**
 * Would jobs/reminders.js's 24h reminder actually fire for an appointment on
 * this date? Mirrors its own eligibility check exactly: the tenant must have
 * 24h reminders on (default true), and the date must be strictly in the
 * FUTURE — a same-day appointment gets no reminder at all (the 2-hour
 * reminder that used to cover that case is gone). "We'll remind you the day
 * before" is only true when both hold; promising it otherwise (a same-day
 * booking or reschedule, or a clinic that has turned reminders off) is a
 * promise the cron will never keep.
 *
 * Read fresh rather than trusted off the `tenant` object passed down — a bot
 * session can sit open for hours after an admin flips the setting.
 */
async function reminder24hApplies(schemaName, appointmentDateStr) {
  try {
    const r = await query(`SELECT settings FROM tenants WHERE schema_name=$1`, [schemaName]);
    if (r.rows[0]?.settings?.reminder_24h_enabled === false) return false;
  } catch (err) {
    logger.warn('Reminder-setting lookup failed — assuming reminders are on', { error: err.message });
  }
  const todayStr = format(toZonedTime(new Date(), IST), 'yyyy-MM-dd');
  return appointmentDateStr > todayStr;
}

/**
 * Whole-tenant read-only guard, extended from the dashboard's `tenants.read_only`
 * flag (`middleware/auth.js` `enforceReadOnlyTenant`) down into the bot engine.
 * That HTTP-layer guard only ever covered `/api/admin` + `/api/v1/admin` — the
 * bot/webhook path was never touched, so a read-only tenant's data was only
 * "read-only" from the dashboard. The bot could still book, cancel, reschedule,
 * or queue a `clinic_requests` row (which also fires a real WhatsApp alert to
 * the clinic's own admin). That gap was harmless while the read-only demo
 * tenant's WhatsApp number was unreachable by anyone but its own operators;
 * it stops being harmless the moment a public "try the bot" widget invokes
 * this SAME bot engine against the SAME shared tenant every dashboard demo
 * visitor also sees.
 *
 * Callers check this immediately before the write they're about to make — the
 * booking insert, the cancel/reschedule UPDATE, the clinic-request INSERT —
 * not earlier in the flow, so browsing menus and picking a slot still works
 * and only the commit is blocked.
 */
function isReadOnlyDemo(tenant) {
  return tenant?.read_only === true;
}

const READ_ONLY_DEMO_MESSAGE =
  'This is a live demo — booking is disabled here so the calendar stays the same for everyone trying it.\n\n' +
  'Reply *Menu* to keep exploring.';

module.exports = {
  STATES,
  genBookingId,
  levenshtein,
  fuzzyFind,
  parseChoiceNumber,
  maskPhone,
  sendConfirmButtons,
  confirmButtonIndex,
  getSession,
  updateSession,
  resetSessionToIdle,
  isOptedOut,
  getPatient,
  getPatients,
  logMessage,
  notifyAdminWhatsApp,
  clinicPhone,
  clinicPhoneLine,
  reminder24hApplies,
  isReadOnlyDemo,
  READ_ONLY_DEMO_MESSAGE,
};
