'use strict';
/**
 * Staged outbound caps for young tenants.
 *
 * Self-serve signup means clinics we have never spoken to can start sending on
 * the shared WhatsApp number within minutes. One bad actor blasting messages
 * degrades delivery — and the number's Meta quality rating — for EVERY clinic
 * (see docs/whatsapp-outage-plan.md). Manual onboarding used to be the implicit
 * filter; this is its replacement.
 *
 * A new tenant gets a low ceiling on CLINIC-INITIATED patient outreach that
 * rises automatically as it ages:
 *
 *     age < 7 days   → 100 / rolling 24h
 *     age < 30 days  → 300 / rolling 24h
 *     otherwise      → no cap
 *
 * Thresholds are generous enough that a genuine small practice never notices,
 * low enough that a spam run trips within the hour.
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

const TIERS = [
  { maxAgeDays: 7,  cap: 100 },
  { maxAgeDays: 30, cap: 300 },
];

// schema → { ageDays, checkedAt }. Age only matters near a day boundary, so
// 10-minute staleness is harmless and saves a tenants read per send.
const _ageCache = new Map();
const AGE_TTL_MS = 10 * 60 * 1000;

async function _tenantAgeDays(schema) {
  const cached = _ageCache.get(schema);
  if (cached && Date.now() - cached.checkedAt < AGE_TTL_MS) return cached.ageDays;
  try {
    const r = await query(
      `SELECT COALESCE(activated_at, created_at) AS since FROM tenants WHERE schema_name = $1`,
      [schema]
    );
    const since = r.rows[0]?.since;
    const ageDays = since ? Math.max(0, (Date.now() - new Date(since).getTime()) / 86400000) : Infinity;
    _ageCache.set(schema, { ageDays, checkedAt: Date.now() });
    return ageDays;
  } catch (err) {
    logger.warn('sendCaps: tenant age lookup failed — treating as uncapped', { error: err.message });
    return Infinity;
  }
}

/** The current 24h ceiling for this tenant, or null for "no cap". */
async function dailyCapFor(schema) {
  const age = await _tenantAgeDays(schema);
  for (const t of TIERS) if (age < t.maxAgeDays) return t.cap;
  return null;
}

/**
 * May this tenant send one more clinic-initiated patient message right now?
 * @param {string} schema  tenant schema
 * @returns {Promise<boolean>}
 */
async function withinDailyCap(schema) {
  const cap = await dailyCapFor(schema);
  if (cap == null) return true; // matured — uncapped
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
      logger.warn('Outbound suppressed — new-tenant daily cap reached', { schema, sent, cap });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('sendCaps check failed — allowing send', { schema, error: err.message });
    return true;
  }
}

function _clearCache() { _ageCache.clear(); }

module.exports = { withinDailyCap, dailyCapFor, TIERS, _clearCache };
