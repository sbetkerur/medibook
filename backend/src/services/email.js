const logger = require('../utils/logger');

// Prevent HTML injection in email templates from user-supplied data (doctor/patient names etc.)
function h(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let resendClient = null;

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

async function sendBookingConfirmation(toEmail, data) {
  const resend = getResend();
  if (!resend || !toEmail) return;
  const { bookingId, patientName, doctorName, date, time, hospitalName, visitType } = data;
  if (!toEmail) { logger.info(`Booking ${bookingId} has no patient email — skipping confirmation`); return; }
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
  } catch (err) {
    logger.warn(`Email send failed for ${bookingId}`, { error: err.message });
    // Non-fatal — don't throw
  }
}

async function sendReminderEmail(toEmail, data) {
  const resend = getResend();
  if (!resend || !toEmail) return;
  const { bookingId, patientName, doctorName, date, time, hoursUntil } = data;
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

module.exports = { sendBookingConfirmation, sendReminderEmail };
