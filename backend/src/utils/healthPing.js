'use strict';
/**
 * Dead-man's-switch pings for a monitoring service (Healthchecks.io style).
 *
 * A backup that stops running is the worst failure a backup can have, because
 * nobody notices until the day it is needed. `/api/status` already surfaces the
 * IN-CONTAINER backup cron's freshness (src/routes/status.js reads cron_jobs) —
 * but the OFF-Railway copy (scripts/backup-prod.js) runs on a laptop with no
 * such signal, and during a Railway outage `/api/status` is down anyway.
 *
 * So each backup path also pings an external URL: once when it starts, once on
 * success, once (to `<url>/fail`) on failure. If the success ping does not
 * arrive on schedule the monitoring service alerts a human — by SMS, phone or
 * Telegram, NOT WhatsApp, since WhatsApp is exactly the channel that may be down
 * (see docs/whatsapp-outage-plan.md).
 *
 * URL conventions (Healthchecks.io, and compatible with Better Stack / Cronitor):
 *   <base>        → job succeeded
 *   <base>/start  → job started (lets the monitor measure run duration)
 *   <base>/fail   → job failed
 *
 * Best-effort by design: a monitoring outage must never fail a backup, so every
 * error here is swallowed. Unset URL = no-op.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @param {string|undefined} baseUrl  the check's ping URL; unset → no-op
 * @param {object}  [opts]
 * @param {'start'|'success'|'fail'} [opts.status='success']
 * @param {string}  [opts.message]  short body, shown in the monitor's event log
 * @param {number}  [opts.timeoutMs]
 * @returns {Promise<boolean>} true if the ping was accepted, false otherwise
 */
async function pingHealthcheck(baseUrl, opts = {}) {
  if (!baseUrl || typeof baseUrl !== 'string') return false;

  const status = opts.status || 'success';
  let url = baseUrl.replace(/\/+$/, '');
  if (status === 'start') url += '/start';
  else if (status === 'fail') url += '/fail';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'text/plain' },
      body: (opts.message || '').slice(0, 10_000),
    });
    return res.ok;
  } catch (_) {
    // Network error, DNS failure, abort, `fetch` missing on an ancient Node —
    // none of it matters enough to disturb a backup.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { pingHealthcheck };
