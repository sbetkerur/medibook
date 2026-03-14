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
    const existing = await dbQuery(
      `SELECT 1 FROM email_sent_log WHERE content_hash=$1 AND sent_at > NOW() - (INTERVAL '1 hour' * $2)`,
      [hash, windowHours]
    );
    if (existing.rows[0]) return true; // duplicate — skip
    await dbQuery(
      `INSERT INTO email_sent_log (content_hash) VALUES ($1) ON CONFLICT (content_hash) DO NOTHING`,
      [hash]
    );
    return false;
  } catch (_) {
    return false; // DB unavailable — allow sending rather than silently drop
  }
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

async function sendBookingConfirmation(toEmail, data) {
  const resend = getResend();
  if (!resend || !toEmail) return;
  const { bookingId, patientName, doctorName, date, time, hospitalName, visitType } = data;
  if (!toEmail) { logger.info(`Booking ${bookingId} has no patient email — skipping confirmation`); return; }

  // Deduplication: skip if same booking confirmation sent within the window
  const dedupHash = crypto.createHash('sha256')
    .update(`booking_confirmation:${toEmail}:${bookingId}`).digest('hex');
  if (await checkAndMarkEmailSent(dedupHash)) {
    logger.info(`Booking confirmation email deduped (already sent): ${bookingId}`);
    return;
  }

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
              <tr><td style="padding:6px 0;color:#64748b;">Hospital</td><td>${h(hospitalName)}</td></tr>
              <tr><td style="padding:6px 0;color:#64748b;">Date</td><td style="font-weight:600;">${h(date)}</td></tr>
              <tr><td style="padding:6px 0;color:#64748b;">Time</td><td style="font-weight:600;">${h(time)}</td></tr>
              <tr><td style="padding:6px 0;color:#64748b;">Type</td><td>${visitType === 'video' ? '📱 Video Consultation' : '🏥 In-Person'}</td></tr>
            </table>
          </div>
          <p style="font-size:13px;color:#94a3b8;">You'll receive a WhatsApp reminder 24 hours before your appointment. Reply <strong>Hi</strong> on WhatsApp to reschedule or cancel.</p>
        </div>
      `,
    });
    logger.info(`Confirmation email sent to ${toEmail} for ${bookingId}`);
    try { require('../utils/metrics').increment('emails_sent_total'); } catch (_) {}
  } catch (err) {
    logger.warn(`Email send failed for ${bookingId}`, { error: err.message });
    try { require('../utils/metrics').increment('emails_failed_total'); } catch (_) {}
    // Non-fatal — don't throw
  }
}

async function sendReminderEmail(toEmail, data) {
  const resend = getResend();
  if (!resend || !toEmail) return;
  const { bookingId, patientName, doctorName, date, time, hoursUntil } = data;

  // Deduplication: skip if same reminder sent within the window
  const dedupHash = crypto.createHash('sha256')
    .update(`reminder:${toEmail}:${bookingId}:${hoursUntil}`).digest('hex');
  if (await checkAndMarkEmailSent(dedupHash)) return;

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
        </div>
      `,
    });
  } catch (err) {
    logger.warn(`Reminder email failed for ${bookingId}`, { error: err.message });
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
            <tr style="background:#f9fafb"><td style="padding:8px;color:#666">Hospital</td><td style="padding:8px">${h(hospitalName)}</td></tr>
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

module.exports = { sendBookingConfirmation, sendReminderEmail, sendAdminBookingAlert, setEmailQueue, queueEmail };
