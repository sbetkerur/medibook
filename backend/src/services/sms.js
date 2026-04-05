'use strict';
/**
 * SMS fallback service using Twilio.
 * Only active when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER are configured.
 * Gate with feature flag 'sms_fallback_enabled' before calling.
 */
const logger = require('../utils/logger');

let twilioClient = null;

function getTwilio() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  if (!twilioClient) {
    try {
      const twilio = require('twilio');
      twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    } catch (_) {
      logger.warn('Twilio package not installed. Run: npm install twilio');
      return null;
    }
  }
  return twilioClient;
}

/**
 * Send SMS fallback message.
 * @param {string} to - Phone number in E.164 format (e.g. +919876543210)
 * @param {string} body - SMS body text (max 160 chars for single segment)
 */
async function sendSMS(to, body) {
  const client = getTwilio();
  if (!client) {
    logger.info('SMS not sent — Twilio not configured', { to: to?.slice(-4) });
    return false;
  }
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!fromNumber) {
    logger.warn('TWILIO_FROM_NUMBER not configured');
    return false;
  }
  // Ensure E.164 format
  const toE164 = to.startsWith('+') ? to : `+${to}`;
  try {
    await client.messages.create({ body: body.slice(0, 1600), from: fromNumber, to: toE164 });
    logger.info('SMS sent', { to: toE164.slice(-4) });
    return true;
  } catch (err) {
    logger.error('SMS send failed', { to: toE164.slice(-4), error: err.message });
    return false;
  }
}

/**
 * Send appointment booking confirmation via SMS.
 */
async function sendBookingConfirmationSMS(phone, { bookingId, doctorName, date, time, hospitalName }) {
  const body = `MediBook: Appointment confirmed!\nID: ${bookingId}\nDr. ${doctorName}\n${date} at ${time}\n${hospitalName}`;
  return sendSMS(phone, body);
}

/**
 * Alert clinic admin via SMS when a new appointment is booked.
 */
async function sendAdminBookingAlertSMS(phone, { bookingId, patientName, doctorName, date, time, hospitalName }) {
  const body = `New booking at ${hospitalName}\nPatient: ${patientName}\nDr. ${doctorName} · ${time}\n${date}\nRef: ${bookingId}`;
  return sendSMS(phone, body);
}

module.exports = { sendSMS, sendBookingConfirmationSMS, sendAdminBookingAlertSMS };
