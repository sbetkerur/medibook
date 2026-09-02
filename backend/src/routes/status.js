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
  feedback: 30,
  recalls: 30,
  treatment_nudges: 30,
  weekly_digest: 24 * 8,
  // Off-site backups — two independent copies, one row each, so one staying
  // fresh can't mask the other silently stopping. 48h budget: both are expected
  // at least daily, so two missed days is a real "go look" signal.
  //   offsite_backup        — scripts/backup-prod.js, on a machine that is NOT
  //                           Railway (the copy that survives losing the account)
  //   offsite_backup_volume — jobs/backupManager.js's Railway-side S3 upload
  // Either row stays `pending` until its producer is configured and runs.
  offsite_backup: 48,
  offsite_backup_volume: 48,
};

// Patient-facing crons are deliberately switched off on the dev environment
// (DISABLE_PATIENT_CRONS) — a stale row there is expected, not an incident, so
// don't let it colour the status.
const PATIENT_CRONS = new Set(['reminders', 'feedback', 'recalls', 'treatment_nudges', 'weekly_digest']);
const skipPatientCrons = String(process.env.DISABLE_PATIENT_CRONS || '') === 'true';

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
      if (skipPatientCrons && PATIENT_CRONS.has(row.job_name)) continue;
      const maxAgeH = CRON_MAX_AGE_HOURS[row.job_name] || 48;
      // Never run yet (a cron added in the deploy that is still before its first
      // scheduled fire) is "pending", not "down" — it must not drag the overall
      // status red for the first day after a release.
      if (!row.last_run_at) {
        jobs[row.job_name] = { ok: true, pending: true, last_run_at: null, last_status: null };
        continue;
      }
      const ageMs = Date.now() - new Date(row.last_run_at).getTime();
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
