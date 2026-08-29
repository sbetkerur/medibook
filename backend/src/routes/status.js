'use strict';
/**
 * Public, unauthenticated platform status — the one surface a clinic can check
 * during an incident without logging in. Mounted under /api.
 *
 * Deliberately coarse: it reports whether the moving parts ran recently and
 * whether the shared WhatsApp number's circuit breaker is open, NOT any
 * per-tenant data. `docs/whatsapp-outage-plan.md` is the human runbook; this is
 * the machine-readable "is it me or is it them".
 */
const router = require('express').Router();
const { query } = require('../db');

// A cron is "stale" if it hasn't succeeded within this multiple of its cadence.
const CRON_MAX_AGE_HOURS = {
  reminders: 3,
  slot_generator: 30,
  billing_dunning: 30,
  backup: 30,
  webhook_retry: 3,
  account_deletion: 30,
};

router.get('/status', async (req, res) => {
  const out = { ok: true, checked_at: new Date().toISOString(), components: {} };

  // Database
  try {
    await query('SELECT 1');
    out.components.database = { ok: true };
  } catch (e) {
    out.components.database = { ok: false };
    out.ok = false;
  }

  // Crons — last success recency
  try {
    const r = await query(`SELECT job_name, last_run_at, last_status FROM cron_jobs`);
    const jobs = {};
    for (const row of r.rows) {
      const maxAgeH = CRON_MAX_AGE_HOURS[row.job_name] || 48;
      const ageMs = row.last_run_at ? Date.now() - new Date(row.last_run_at).getTime() : Infinity;
      const fresh = ageMs <= maxAgeH * 3600 * 1000;
      const healthy = fresh && row.last_status !== 'error';
      jobs[row.job_name] = { ok: healthy, last_run_at: row.last_run_at, last_status: row.last_status || null };
      if (!healthy) out.ok = false;
    }
    out.components.crons = jobs;
  } catch (e) {
    out.components.crons = { ok: false };
  }

  // Webhook processing backlog
  try {
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM failed_webhooks WHERE resolved_at IS NULL`);
    const backlog = r.rows[0]?.n ?? 0;
    out.components.webhook_queue = { ok: backlog < 50, unresolved: backlog };
    if (backlog >= 50) out.ok = false;
  } catch (e) {
    out.components.webhook_queue = { ok: true, unresolved: null };
  }

  // Shared WhatsApp number — circuit breaker
  try {
    const { isCircuitOpen } = require('../services/whatsapp');
    const open = !!isCircuitOpen(process.env.META_PHONE_NUMBER_ID);
    out.components.whatsapp = { ok: !open, circuit_open: open };
    if (open) out.ok = false;
  } catch (e) {
    out.components.whatsapp = { ok: true };
  }

  res.status(out.ok ? 200 : 503).json(out);
});

module.exports = router;
