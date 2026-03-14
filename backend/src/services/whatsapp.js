const axios = require('axios');
const logger = require('../utils/logger');

function getClient(accessToken, phoneNumberId) {
  const token = accessToken || process.env.META_ACCESS_TOKEN;
  const phoneId = phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  const base = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  return { base, headers };
}

async function sendText(to, text, accessToken, phoneNumberId) {
  const { base, headers } = getClient(accessToken, phoneNumberId);
  try {
    await axios.post(base, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    }, { headers });
  } catch (err) {
    logger.error('sendText failed', { to, error: err.response?.data || err.message });
    throw err;
  }
}

async function sendButtons(to, bodyText, buttons, accessToken, phoneNumberId) {
  const btns = buttons.slice(0, 3);
  const { base, headers } = getClient(accessToken, phoneNumberId);
  try {
    await axios.post(base, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText.slice(0, 1024) },
        action: {
          buttons: btns.map((b, i) => ({
            type: 'reply',
            reply: { id: `btn_${i}_${Date.now()}`, title: String(b).slice(0, 20) },
          })),
        },
      },
    }, { headers });
  } catch (err) {
    // Fallback to numbered text list
    const numbered = buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
    await sendText(to, `${bodyText}\n\n${numbered}\n\nReply with number to choose.`, accessToken, phoneNumberId);
  }
}

async function sendList(to, bodyText, buttonLabel, sections, accessToken, phoneNumberId) {
  const { base, headers } = getClient(accessToken, phoneNumberId);
  try {
    await axios.post(base, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText.slice(0, 1024) },
        action: {
          button: String(buttonLabel).slice(0, 20),
          sections,
        },
      },
    }, { headers });
  } catch (err) {
    // Fallback to text
    const lines = sections.flatMap((s, si) =>
      s.rows.map((r, ri) => `${si * 10 + ri + 1}. ${r.title}${r.description ? ' — ' + r.description : ''}`)
    );
    await sendText(to, `${bodyText}\n\n${lines.join('\n')}\n\nReply with number to choose.`, accessToken, phoneNumberId);
  }
}

async function sendTemplate(to, templateName, components = [], accessToken, phoneNumberId) {
  const { base, headers } = getClient(accessToken, phoneNumberId);
  try {
    await axios.post(base, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en' },
        components,
      },
    }, { headers });
  } catch (err) {
    logger.error('sendTemplate failed', { to, templateName, error: err.response?.data || err.message });
    throw err;
  }
}

async function markRead(messageId, accessToken, phoneNumberId) {
  const phoneId = phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  const token = accessToken || process.env.META_ACCESS_TOKEN;
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${phoneId}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (_) { /* non-critical */ }
}

module.exports = { sendText, sendButtons, sendList, sendTemplate, markRead };
