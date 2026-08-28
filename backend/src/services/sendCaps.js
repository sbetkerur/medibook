'use strict';
/**
 * Trial outbound cap for self-serve tenants.
 *
 * Self-serve signup means clinics we have never spoken to can start sending on
 * the shared WhatsApp number within minutes. One bad actor blasting messages
 * degrades delivery — and the number's Meta quality rating — for EVERY clinic
 * (see docs/whatsapp-outage-plan.md). Manual onboarding used to be the implicit
 * filter; this is its replacement.
 *
 * THE RULE. A self-serve tenant on the card-free trial gets a low ceiling on
 * CLINIC-INITIATED patient outreach:
 *
 *     self-serve + not yet paying  → 50 / rolling 24h   (SIGNUP_TRIAL_SEND_CAP)
 *     paying (live subscription)   → no cap
 *     super-admin provisioned      → no cap  (went through a human already)
 *
 * "Paying" = a Razorpay subscription id is attached AND its status is healthy
 * (active / authenticated). A lapsed trial with no card still counts as "not
 * paying" and stays capped — the safe direction.
 *
 * WHAT COUNTS. Every `wa_messages` row with direction='out' in the last 24h
 * except `admin_alert` (those go to staff). Broader than
 * services/messageBudget.js (per-PATIENT, exempts reminders) on purpose: the
 * risk here is aggregate volume from one tenant.
 *
 * WHERE IT IS ENFORCED. services/outbound.js `sendPatientMessage` — the
 * clinic-initiated outreach path (treatment nudges, recalls, feedback,
 * post-visit). Appointment reminders and confirmations call the lower-level
 * senders directly and stay ungated, matching the messageBudget rule: a patient
 * with an appointment tomorrow always gets that message.
 *
 * FAILS OPEN. A cap check that cannot run must not silence a clinic.
 */
const { tenantQuery, query } = require('../db');
const logger = require('../utils/logger');

const TRIAL_DAILY_CAP = Math.max(
  0,
  parseInt(process.env.SIGNUP_TRIAL_SEND_CAP || '50', 10) || 50
);

// A subscription in one of these states is a live paying customer.
const PAYING_SUB_STATUSES = new Set(['active', 'authenticated']);

// schema → { cap, checkedAt }. cap is a number or null ("no cap"). The billing
// state changes rarely, so 10-minute staleness is harmless and saves a
// tenants/tenant_billing read per send. Bounded so a platform with thousands of
// schemas can't grow this without limit — when it fills, the whole map is
// dropped (every entry re-populates in one query on next use).
const _capCache = new Map();
const CAP_TTL_MS = 10 * 60 * 1000;
const CAP_CACHE_MAX = 5000;

/**
 * The current 24h ceiling for this tenant, or null for "no cap".
 *
 * Capped only while a SELF-SERVE tenant is on its card-free trial (or has let it
 * lapse without paying). Anything else — a paying self-serve subscription, or a
 * super-admin-provisioned clinic — is uncapped.
 */
async function dailyCapFor(schema) {
  const cached = _capCache.get(schema);
  if (cached && Date.now() - cached.checkedAt < CAP_TTL_MS) return cached.cap;
  if (_capCache.size >= CAP_CACHE_MAX) _capCache.clear();

  let cap;
  try {
    const r = await query(
      `SELECT t.signup_source,
              b.razorpay_subscription_id,
              b.subscription_status
         FROM tenants t
         LEFT JOIN tenant_billing b ON b.tenant_id = t.id
        WHERE t.schema_name = $1`,
      [schema]
    );
    const row = r.rows[0];
    if (!row || row.signup_source !== 'self_serve') {
      cap = null; // unknown tenant, or admin-provisioned — no cap
    } else {
      const paying =
        !!row.razorpay_subscription_id &&
        PAYING_SUB_STATUSES.has(row.subscription_status);
      cap = paying ? null : TRIAL_DAILY_CAP;
    }
  } catch (err) {
    logger.warn('sendCaps: billing lookup failed — treating as uncapped', { error: err.message });
    cap = null;
  }

  _capCache.set(schema, { cap, checkedAt: Date.now() });
  return cap;
}

/**
 * May this tenant send one more clinic-initiated patient message right now?
 * @param {string} schema  tenant schema
 * @returns {Promise<boolean>}
 */
async function withinDailyCap(schema) {
  const cap = await dailyCapFor(schema);
  if (cap == null) return true; // paying / vetted — uncapped
  try {
    const r = await tenantQuery(schema, `
      SELECT COUNT(*)::int AS n
        FROM wa_messages
       WHERE direction = 'out'
         AND message_type <> 'admin_alert'
         AND created_at >= NOW() - INTERVAL '24 hours'
    `);
    const sent = r.rows[0]?.n ?? 0;
    if (sent >= cap) {
      logger.warn('Outbound suppressed — trial daily cap reached', { schema, sent, cap });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('sendCaps check failed — allowing send', { schema, error: err.message });
    return true;
  }
}

function _clearCache() { _capCache.clear(); }

module.exports = { withinDailyCap, dailyCapFor, TRIAL_DAILY_CAP, _clearCache };
