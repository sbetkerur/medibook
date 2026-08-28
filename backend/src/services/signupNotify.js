'use strict';
/**
 * Telling a self-serve clinic owner their account is live.
 *
 * A self-serve signup now provisions NOTHING until a super admin approves it
 * (routes/signup.js → POST /superadmin/tenants/:id/approve). The owner finished
 * signup on a "we'll message you on WhatsApp" screen and has no way back in
 * until they hear from us — this is that message.
 *
 * TEMPLATE-FIRST, same discipline as services/otp.js: the owner never messages
 * the shared number, so they are permanently outside Meta's 24-hour free-form
 * window and a plain sendText is rejected in production. SIGNUP_APPROVED_TEMPLATE
 * names an approved UTILITY template with two body variables:
 *   {{1}} = clinic name, {{2}} = login URL
 * The sendText fallback still runs — it works in dev and for any number that has
 * written in — so local testing needs no template.
 */
const wa = require('./whatsapp');
const logger = require('../utils/logger');
const { frontendBaseUrl } = require('../utils/appUrls');

const TEMPLATE = () => (process.env.SIGNUP_APPROVED_TEMPLATE || '').trim();

/**
 * @param {string} phone       the owner's verified WhatsApp number (E.164-ish)
 * @param {object} opts
 * @param {string} opts.clinicName
 * @param {string} opts.slug    the clinic ID the owner logs in with
 */
async function notifyOwnerApproved(phone, { clinicName, slug }) {
  if (!phone) return;
  const loginUrl = `${frontendBaseUrl()}/login`;
  const text =
    `${clinicName} is approved and live on MediBook. ` +
    `Sign in at ${loginUrl} with your Clinic ID "${slug}" and the password you chose at signup, ` +
    `then finish setting up your dentists and hours. Your free trial has started now.`;

  const tpl = TEMPLATE();
  if (tpl) {
    try {
      const components = [{
        type: 'body',
        parameters: [
          { type: 'text', text: clinicName },
          { type: 'text', text: loginUrl },
        ],
      }];
      await wa.sendTemplate(phone, tpl, components, null, null);
      return;
    } catch (err) {
      logger.warn('Approval template send failed — falling back to text', {
        template: tpl, error: err.response?.data?.error?.message || err.message,
      });
    }
  } else if (process.env.NODE_ENV === 'production') {
    logger.error('SIGNUP_APPROVED_TEMPLATE is not set — an approved owner outside the 24h window will not be told their clinic is live');
  }

  try {
    await wa.sendText(phone, text, null, null);
  } catch (err) {
    // Best-effort: the clinic is already active. Surface it so an operator can
    // hand the owner the link by another route.
    logger.warn('Approval text send failed — owner not notified', {
      slug, error: err.response?.data?.error?.message || err.message,
    });
  }
}

module.exports = { notifyOwnerApproved };
