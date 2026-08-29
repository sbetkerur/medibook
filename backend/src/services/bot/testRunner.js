'use strict';
// Shared by the unauthenticated dev endpoint (routes/webhook.js, POST /webhook/test),
// the authenticated dashboard one (routes/admin.js, POST /admin/bot-test) and the
// public demo-chat widget (routes/demoChat.js) — all three run a message through
// the real bot engine with the WhatsApp senders CAPTURED instead of calling Meta.
// Factored out so no caller can drift on which sender methods get captured.
//
// Capture is per-call dependency injection now (botEngine.handle({ ..., senders })),
// NOT a monkey-patch of the shared whatsapp module. The old approach replaced
// waModule.sendText/sendButtons/sendList for the duration of botEngine.handle and
// serialised callers behind a module-level mutex so concurrent runs wouldn't stomp
// each other's patch. That also meant any REAL cron/webhook send that interleaved
// with a run (routine now the demo widget is public and always-on) was silently
// swallowed into the test's throwaway buffer. With injection there is no shared
// mutable state, so the mutex is gone too — concurrent runs are independent.

const botEngine = require('../botEngine');

// `welcome` mirrors what routes/webhook.js sets on a real QR scan (the ONE
// message that gets the clinic-name-in-body arrival banner via
// sendMainMenu) — plumbed through so a caller can synthesize that same
// arrival without going through entry-code routing. Optional: the two
// existing dev/admin callers don't pass it and are unaffected.
async function runBotTest({ tenant, phone, message, buttonId, welcome }) {
  const responses = [];

  const senders = {
    sendText: async (to, text) => { responses.push({ type: 'text', text }); },
    // Include the header/footer slots — without them this endpoint reports a
    // message the patient would never see, which is the opposite of its job.
    //
    // Mint reply ids in the SAME shape the real sendButtons sends to Meta
    // (`btn_${i}_${Date.now()}`, services/whatsapp.js), not just the label text.
    // A tap on a CONFIRM step (booking/cancel/reschedule) is checked against the
    // window `sendConfirmButtons` recorded around this very call
    // (bot/utils.js confirmButtonIndex) — a caller that echoes back anything
    // other than one of these ids gets read as a stale tap on an old message
    // and re-asked, never as the answer just given.
    sendButtons: async (to, text, buttons, _t, _p, opts = {}) => {
      responses.push({ type: 'buttons', text, buttons, ids: buttons.map((_, i) => `btn_${i}_${Date.now()}`), ...opts });
    },
    sendList: async (to, text, label, sections, _t, _p, opts = {}) => {
      responses.push({ type: 'list', text, label, sections, ...opts });
    },
  };

  await botEngine.handle({ phone, text: message, buttonId, tenant, welcome, senders });

  return responses;
}

module.exports = { runBotTest };
