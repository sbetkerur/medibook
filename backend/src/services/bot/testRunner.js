'use strict';
// Shared by the unauthenticated dev endpoint (routes/webhook.js, POST /webhook/test)
// and the authenticated dashboard one (routes/admin.js, POST /admin/bot-test) — both
// run a message through the real bot engine with the WhatsApp senders monkey-patched
// to capture output instead of calling Meta. Factored out so the two callers can't
// drift on the module-level mutex or which sender methods get patched.

const botEngine = require('../botEngine');

// Serializes calls — concurrent test runs would otherwise stomp on each other's
// monkey-patch of the whatsapp module's exports.
let _mutex = Promise.resolve();

async function runBotTest({ tenant, phone, message, buttonId }) {
  const responses = [];
  const waModule = require('../whatsapp');

  let releaseMutex;
  const prevMutex = _mutex;
  _mutex = new Promise(resolve => { releaseMutex = resolve; });
  await prevMutex;

  const origSendText = waModule.sendText;
  const origSendButtons = waModule.sendButtons;
  const origSendList = waModule.sendList;

  waModule.sendText = async (to, text) => { responses.push({ type: 'text', text }); };
  // Include the header/footer slots — without them this endpoint reports a
  // message the patient would never see, which is the opposite of its job.
  waModule.sendButtons = async (to, text, buttons, _t, _p, opts = {}) =>
    { responses.push({ type: 'buttons', text, buttons, ...opts }); };
  waModule.sendList = async (to, text, label, sections, _t, _p, opts = {}) =>
    { responses.push({ type: 'list', text, label, sections, ...opts }); };

  try {
    await botEngine.handle({ phone, text: message, buttonId, tenant });
  } finally {
    waModule.sendText = origSendText;
    waModule.sendButtons = origSendButtons;
    waModule.sendList = origSendList;
    releaseMutex();
  }

  return responses;
}

module.exports = { runBotTest };
