const crypto = require('crypto');
const logger = require('../utils/logger');
const { LIMITS } = require('../utils/errors');

// Prevent HTML injection in email templates from user-supplied data (doctor/patient names etc.)
function h(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Deduplication guard — prevents duplicate emails when BullMQ retries a job.
 * Uses email_sent_log table with a content hash + time window.
 * Returns true if the email was already sent recently (should be skipped).
 */
async function checkAndMarkEmailSent(hash) {
  try {
    const { query: dbQuery } = require('../db');
    const windowHours = Math.max(1, parseInt(LIMITS.EMAIL_DEDUP_WINDOW_HOURS) || 2);
    // INSERT-first: atomically claim the slot. If another process already inserted
    // (ON CONFLICT), check whether the existing record is within the dedup window.
    // This eliminates the SELECT-then-INSERT race where two concurrent retries both
    // see no row and both proceed to send.
    const inserted = await dbQuery(
      `INSERT INTO email_sent_log (content_hash) VALUES ($1)
       ON CONFLICT (content_hash) DO NOTHING
       RETURNING id`,
      [hash]
    );
    if (inserted.rows[0]) return false; // fresh insert — not a duplicate, send it

    // Hash already existed — check if it's within the dedup window
    const existing = await dbQuery(
      `SELECT 1 FROM email_sent_log WHERE content_hash=$1 AND sent_at > NOW() - (INTERVAL '1 hour' * $2)`,
      [hash, windowHours]
    );
    if (existing.rows[0]) return true; // within window — skip
    // Stale row: refresh sent_at so THIS send is deduped going forward —
    // otherwise dedup for this hash stays permanently disabled once stale.
    await dbQuery(`UPDATE email_sent_log SET sent_at=NOW() WHERE content_hash=$1`, [hash]).catch(() => {});
    return false;
  } catch (_) {
    return false; // DB unavailable — allow sending rather than silently drop
  }
}

// Release a dedup claim after a FAILED send. The claim is taken before the
// send (to close the concurrent-send race), so without this a transient
// Resend error left the hash claimed and every retry within the window was
// skipped as a "duplicate" — the email was permanently lost.
async function releaseEmailClaim(hash) {
  try {
    const { query: dbQuery } = require('../db');
    await dbQuery(`DELETE FROM email_sent_log WHERE content_hash=$1`, [hash]);
  } catch (_) { /* best-effort */ }
}

// ── DB-STORED TEMPLATE SUPPORT ────────────────────────────────
async function getTemplate(schemaName, templateId) {
  if (!schemaName) return null;
  try {
    const { tenantQuery } = require('../db');
    const r = await tenantQuery(schemaName,
      `SELECT subject, html_body FROM email_templates WHERE id=$1`, [templateId]);
    return r.rows[0] || null;
  } catch (_) {
    return null; // table may not exist in older schemas
  }
}

// ── UNSUBSCRIBE TOKEN ─────────────────────────────────────────
async function generateUnsubscribeUrl(schemaName, patientId) {
  if (!schemaName || !patientId) return null;
  try {
    const { tenantQuery } = require('../db');
    // Reuse existing token if one exists
    const existing = await tenantQuery(schemaName,
      `SELECT token FROM email_unsubscribes WHERE patient_id=$1 AND unsubscribed_at IS NULL LIMIT 1`,
      [patientId]);
    let token = existing.rows[0]?.token;
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      await tenantQuery(schemaName,
        `INSERT INTO email_unsubscribes (patient_id, token) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [patientId, token]);
    }
    // One origin, not the raw comma-separated list (see utils/appUrls.js).
    const base = require('../utils/appUrls').frontendBaseUrl();
    return `${base}/unsubscribe?token=${token}`;
  } catch (_) {
    return null;
  }
}

// Should we mail this patient at all? ONE gate, covering both reasons not to:
//
//   - they used the footer link to opt out (email_unsubscribes), and
//   - the address hard-bounced or drew a spam complaint (patients.email_status),
//     recorded by the Resend webhook in index.js.
//
// The bounce half in particular was write-only: email_status was set by the
// webhook and read by NOTHING, so a confirmed-dead address kept receiving every
// confirmation and reminder — burning sender reputation on mail that cannot be
// delivered. Both reasons are answered here so a new send path can't honour one
// and forget the other.
//
// Fails OPEN (returns false → send anyway) on a DB error, matching how the
// other optional lookups in this file degrade: a PG blip must not swallow a
// booking confirmation. It does NOT fail open when the lookup succeeds and
// reports a suppression — that is a deliberate answer, not an outage.
async function isSuppressed(schemaName, patientId, toEmail) {
  if (!schemaName) return false;
  try {
    const { tenantQuery } = require('../db');
    if (patientId) {
      const r = await tenantQuery(schemaName,
        `SELECT 1 FROM email_unsubscribes WHERE patient_id=$1 AND unsubscribed_at IS NOT NULL LIMIT 1`,
        [patientId]);
      if (r.rows[0]) return 'unsubscribed';
    }
    if (toEmail) {
      // lower(email), matching the webhook writer: addresses are stored verbatim
      // by the admin patient edit and the CSV import, so a case-sensitive compare
      // would miss exactly the rows an operator entered by hand.
      const b = await tenantQuery(schemaName,
        `SELECT 1 FROM patients WHERE lower(email)=lower($1) AND email_status='bounced' LIMIT 1`,
        [toEmail]);
      if (b.rows[0]) return 'bounced';
    }
    return false;
  } catch (err) {
    logger.warn('Email suppression check failed — sending anyway', { error: err.message });
    return false;
  }
}

// Back-compat alias: `isUnsubscribed` was the narrower predecessor of the gate
// above and is still the name that reads best at a call site asking only about
// the opt-out link.
const isUnsubscribed = (schemaName, patientId) => isSuppressed(schemaName, patientId, null);

// ── OPEN TRACKING ─────────────────────────────────────────────
async function trackEmailOpen(contentHash) {
  try {
    const { query: dbQuery } = require('../db');
    await dbQuery(
      `UPDATE email_sent_log SET open_count = open_count + 1 WHERE content_hash = $1`,
      [contentHash]
    );
  } catch (_) {}
}

// NOTE: the bounce handler that used to live here was removed. It was exported
// and called by nothing — index.js's Resend webhook route carries the only live
// implementation — and the two had already drifted apart on the one detail that
// matters (this copy compared `email = $1`, which misses the mixed-case rows the
// admin patient edit and the CSV import store verbatim). Two copies of a
// cross-tenant write, one of them dead and wrong, is a trap for whoever edits
// next; the reader side is `isSuppressed()` above.

// Helper to build tracking pixel HTML.
//
// The pixel is fetched by the RECIPIENT'S mail client, so the URL must be this
// API's externally reachable origin — never a localhost default. The previous
// `API_URL || NEXT_PUBLIC_API_URL || 'http://localhost:3001'` chain referenced
// two env vars that exist nowhere else in the repo, so in production every
// email shipped a broken <img> pointing at localhost and open_count was never
// incremented (making GET /api/track/open dead code).
//
// No configured origin now means NO pixel rather than a dead one.
const PUBLIC_API_ORIGIN = (() => {
  const raw = (process.env.PUBLIC_API_URL || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    logger.warn('PUBLIC_API_URL is not a valid URL — email open tracking disabled', { value: raw });
    return null;
  }
})();

function trackingPixel(contentHash) {
  if (!PUBLIC_API_ORIGIN) return '';
  return `<img src="${PUBLIC_API_ORIGIN}/api/track/open?h=${encodeURIComponent(contentHash)}" width="1" height="1" alt="" style="display:none">`;
}

// Helper to build unsubscribe footer
function unsubscribeFooter(unsubUrl) {
  if (!unsubUrl) return '';
  return `<p style="font-size:11px;color:#cbd5e1;margin-top:16px;text-align:center">
    <a href="${h(unsubUrl)}" style="color:#94a3b8;text-decoration:underline">Unsubscribe from these emails</a>
  </p>`;
}

let resendClient = null;
let emailQueue = null;

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

// Called by botWorker after the email BullMQ queue is initialized
function setEmailQueue(q) {
  emailQueue = q;
}

// Route email through queue if available (with retries), otherwise send directly
async function queueEmail(type, payload) {
  if (emailQueue) {
    try {
      await emailQueue.add(type, payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      });
      logger.info(`Email queued: ${type}`, { bookingId: payload.bookingId || payload.data?.bookingId });
      return;
    } catch (err) {
      logger.warn(`Email queue failed, sending directly: ${err.message}`);
    }
  }
  // Fallback: send immediately (no retry)
  if (type === 'booking_confirmation') await sendBookingConfirmation(payload.toEmail, payload.data);
  else if (type === 'reminder') await sendReminderEmail(payload.toEmail, payload.data);
  else if (type === 'admin_booking_alert') await sendAdminBookingAlert(payload);
}

async function sendBookingConfirmation(toEmail, data, opts = {}) {
  const resend = getResend();
  if (!resend) return;
  const { bookingId, patientName, doctorName, date, time, hospitalName, visitType, patientId, schemaName } = data;
  if (!toEmail) { logger.info(`Booking ${bookingId} has no patient email — skipping confirmation`); return; }

  // Checked BEFORE the dedup claim below: claiming the hash and then bailing
  // would burn the dedup slot for a send that never happened, so a later
  // re-subscribe within the window would be silently deduped away.
  const bookingSuppression = await isSuppressed(schemaName, patientId, toEmail);
  if (bookingSuppression) {
    logger.info(`Booking confirmation skipped (${bookingSuppression}): ${bookingId}`);
    return;
  }

  // Deduplication: skip if same booking confirmation sent within the window
  const dedupHash = crypto.createHash('sha256')
    .update(`booking_confirmation:${toEmail}:${bookingId}`).digest('hex');
  if (await checkAndMarkEmailSent(dedupHash)) {
    logger.info(`Booking confirmation email deduped (already sent): ${bookingId}`);
    return;
  }

  // Generate unsubscribe URL and tracking pixel (non-blocking — failures ignored)
  const unsubUrl = await generateUnsubscribeUrl(schemaName, patientId);
  const pixel = trackingPixel(dedupHash);
  const footer = unsubscribeFooter(unsubUrl);

  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'appointments@medibook.care',
      to: toEmail,
      subject: `Appointment Confirmed — ${h(bookingId)}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:12px;">
          <h2 style="color:#2563eb;margin-bottom:4px;">✅ Appointment Confirmed</h2>
          <p style="color:#64748b;margin-top:0;">Hi ${h(patientName)}, your appointment is booked!</p>
          <div style="background:white;border-radius:8px;padding:16px;margin:16px 0;border:1px solid #e2e8f0;">
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr><td style="padding:6px 0;color:#64748b;">Booking ID</td><td style="font-weight:600;font-family:monospace;">${h(bookingId)}</td></tr>
              <tr><td style="padding:6px 0;color:#64748b;">Doctor</td><td style="font-weight:600;">Dr. ${h(doctorName)}</td></tr>
              <tr><td style="padding:6px 0;color:#64748b;">Clinic</td><td>${h(hospitalName)}</td></tr>
              <tr><td style="padding:6px 0;color:#64748b;">Date</td><td style="font-weight:600;">${h(date)}</td></tr>
              <tr><td style="padding:6px 0;color:#64748b;">Time</td><td style="font-weight:600;">${h(time)}</td></tr>
              <tr><td style="padding:6px 0;color:#64748b;">Type</td><td>🦷 In-Clinic Visit</td></tr>
            </table>
          </div>
          <p style="font-size:13px;color:#94a3b8;">You'll receive a WhatsApp reminder 24 hours before your appointment. Reply <strong>Hi</strong> on WhatsApp to reschedule or cancel.</p>
          ${footer}
          ${pixel}
        </div>
      `,
    });
    logger.info(`Confirmation email sent to ${toEmail} for ${bookingId}`);
    try { require('../utils/metrics').increment('emails_sent_total'); } catch (_) {}
  } catch (err) {
    logger.warn(`Email send failed for ${bookingId}`, { error: err.message });
    try { require('../utils/metrics').increment('emails_failed_total'); } catch (_) {}
    await releaseEmailClaim(dedupHash); // failed send must not consume the dedup slot
    // Queue worker passes rethrow:true so BullMQ retries; sync callers
    // (booking flow) must not crash on a failed email.
    if (opts.rethrow) throw err;
  }
}

async function sendReminderEmail(toEmail, data, opts = {}) {
  const resend = getResend();
  if (!resend || !toEmail) return;
  const { bookingId, patientName, doctorName, date, time, hoursUntil, patientId, schemaName } = data;

  // Before the dedup claim — same reason as sendBookingConfirmation.
  const reminderSuppression = await isSuppressed(schemaName, patientId, toEmail);
  if (reminderSuppression) {
    logger.info(`Reminder email skipped (${reminderSuppression}): ${bookingId}`);
    return;
  }

  // Deduplication: skip if same reminder sent within the window
  const dedupHash = crypto.createHash('sha256')
    .update(`reminder:${toEmail}:${bookingId}:${hoursUntil}`).digest('hex');
  if (await checkAndMarkEmailSent(dedupHash)) return;

  // Generate unsubscribe URL and tracking pixel (non-blocking — failures ignored)
  const unsubUrl = await generateUnsubscribeUrl(schemaName, patientId);
  const pixel = trackingPixel(dedupHash);
  const footer = unsubscribeFooter(unsubUrl);

  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'appointments@medibook.care',
      to: toEmail,
      subject: `Reminder: Appointment in ${hoursUntil} hour${hoursUntil > 1 ? 's' : ''} — ${h(bookingId)}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#fefce8;border-radius:12px;">
          <h2 style="color:#d97706;">⏰ Appointment Reminder</h2>
          <p>Hi ${h(patientName)}, you have an appointment <strong>in ${hoursUntil} hour${hoursUntil > 1 ? 's' : ''}</strong>!</p>
          <div style="background:white;border-radius:8px;padding:16px;margin:16px 0;border:1px solid #fde68a;">
            <p style="margin:0 0 4px;"><strong>Dr. ${h(doctorName)}</strong></p>
            <p style="margin:0;color:#64748b;">${h(date)} at ${h(time)}</p>
            <p style="margin:8px 0 0;font-family:monospace;font-size:12px;color:#94a3b8;">${h(bookingId)}</p>
          </div>
          <p style="font-size:13px;color:#94a3b8;">Please arrive 10 minutes early with any relevant reports.</p>
          ${footer}
          ${pixel}
        </div>
      `,
    });
  } catch (err) {
    logger.warn(`Reminder email failed for ${bookingId}`, { error: err.message });
    await releaseEmailClaim(dedupHash); // failed send must not consume the dedup slot
    if (opts.rethrow) throw err;
  }
}

async function sendAdminBookingAlert({ toEmail, bookingId, patientName, doctorName, hospitalName, date, time, visitType }) {
  const resend = getResend();
  if (!resend) { logger.info('Email skipped (no RESEND_API_KEY): admin booking alert'); return; }
  if (!toEmail) { logger.info('Admin booking alert skipped: no email address'); return; }
  try {
    const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'appointments@medibook.care';
    await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `New Booking: ${h(bookingId)} — Dr. ${h(doctorName)}`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:auto">
          <h2 style="color:#2563eb">📅 New Appointment Booked</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px;color:#666">Booking ID</td><td style="padding:8px;font-weight:bold">${h(bookingId)}</td></tr>
            <tr style="background:#f9fafb"><td style="padding:8px;color:#666">Patient</td><td style="padding:8px">${h(patientName)}</td></tr>
            <tr><td style="padding:8px;color:#666">Doctor</td><td style="padding:8px">Dr. ${h(doctorName)}</td></tr>
            <tr style="background:#f9fafb"><td style="padding:8px;color:#666">Clinic</td><td style="padding:8px">${h(hospitalName)}</td></tr>
            <tr><td style="padding:8px;color:#666">Date</td><td style="padding:8px">${h(date)}</td></tr>
            <tr style="background:#f9fafb"><td style="padding:8px;color:#666">Time</td><td style="padding:8px">${h(time ? String(time).slice(0,5) : '')}</td></tr>
            <tr><td style="padding:8px;color:#666">Type</td><td style="padding:8px">${h(visitType || 'in_person')}</td></tr>
          </table>
          <p style="color:#9ca3af;font-size:12px;margin-top:24px">MediBook Admin Notification</p>
        </div>
      `
    });
  } catch (err) {
    logger.error('sendAdminBookingAlert failed', { toEmail, error: err.message });
  }
}

async function sendPasswordReset(toEmail, resetUrl) {
  const resend = getResend();
  if (!resend) { logger.info('Password reset email skipped (no RESEND_API_KEY)'); return; }
  if (!toEmail) { logger.info('Password reset email skipped: no email address'); return; }
  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'appointments@medibook.care',
      to: toEmail,
      subject: 'Reset Your MediBook Password',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:12px;">
          <h2 style="color:#2563eb;">🔐 Password Reset</h2>
          <p>You requested a password reset for your MediBook account.</p>
          <p>Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
          <a href="${h(resetUrl)}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
            Reset Password
          </a>
          <p style="font-size:13px;color:#94a3b8;">If you didn't request this, you can safely ignore this email.</p>
          <p style="font-size:12px;color:#cbd5e1;">Or copy this link: ${h(resetUrl)}</p>
        </div>
      `,
    });
    logger.info(`Password reset email sent to ${toEmail}`);
  } catch (err) {
    logger.warn(`Password reset email failed for ${toEmail}`, { error: err.message });
    throw err; // re-throw so caller knows email failed
  }
}

// ── WEEKLY DENTIST PERFORMANCE DIGEST (Q6) ────────────────────
async function sendWeeklyDigest(toEmail, tenantName, stats) {
  const resend = getResend();
  if (!resend || !toEmail) return;
  const { weekStart, weekEnd, doctors } = stats;
  const totalAppts = doctors.reduce((s, d) => s + d.total, 0);
  const totalRevenue = doctors.reduce((s, d) => s + d.revenue, 0);
  const rows = doctors.map(d => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">Dr. ${h(d.name)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${d.total}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;color:#22c55e">${d.completed}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;color:#ef4444">${d.no_show}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;color:#f59e0b">${d.cancelled}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;font-weight:600">₹${d.revenue.toLocaleString('en-IN')}</td>
    </tr>`).join('');
  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'appointments@medibook.care',
      to: toEmail,
      subject: `📊 Weekly Digest — ${h(tenantName)} (${weekStart} to ${weekEnd})`,
      html: `
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:12px">
          <h2 style="color:#0066cc;margin-bottom:4px">🦷 Weekly Performance Digest</h2>
          <p style="color:#64748b;margin-top:0">${h(tenantName)} · ${weekStart} – ${weekEnd}</p>
          <div style="display:flex;gap:12px;margin:16px 0">
            <div style="flex:1;background:white;border-radius:8px;padding:14px;text-align:center;border:1px solid #e2e8f0">
              <div style="font-size:24px;font-weight:700;color:#0066cc">${totalAppts}</div>
              <div style="font-size:12px;color:#94a3b8">Total Appointments</div>
            </div>
            <div style="flex:1;background:white;border-radius:8px;padding:14px;text-align:center;border:1px solid #e2e8f0">
              <div style="font-size:24px;font-weight:700;color:#22c55e">₹${totalRevenue.toLocaleString('en-IN')}</div>
              <div style="font-size:12px;color:#94a3b8">Total Revenue</div>
            </div>
          </div>
          <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0">
            <thead>
              <tr style="background:#f0f7ff">
                <th style="padding:10px 8px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase">Dentist</th>
                <th style="padding:10px 8px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase">Total</th>
                <th style="padding:10px 8px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase">Done</th>
                <th style="padding:10px 8px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase">No-show</th>
                <th style="padding:10px 8px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase">Cancelled</th>
                <th style="padding:10px 8px;text-align:right;font-size:12px;color:#64748b;text-transform:uppercase">Revenue</th>
              </tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="6" style="padding:16px;text-align:center;color:#94a3b8">No appointments this week</td></tr>'}</tbody>
          </table>
          <p style="font-size:12px;color:#94a3b8;margin-top:20px;text-align:center">MediBook · Weekly Auto-Digest every Monday 8 AM IST</p>
        </div>
      `,
    });
    logger.info(`Weekly digest sent to ${toEmail} for ${tenantName}`);
  } catch (err) {
    logger.warn(`Weekly digest email failed for ${tenantName}`, { error: err.message });
  }
}

module.exports = {
  sendBookingConfirmation, sendReminderEmail, sendAdminBookingAlert,
  sendPasswordReset, sendWeeklyDigest, setEmailQueue, queueEmail,
  getTemplate, generateUnsubscribeUrl, isSuppressed, isUnsubscribed, trackEmailOpen,
};
