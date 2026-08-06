/**
 * Template quick-reply labels → the keywords the bot engine acts on.
 *
 * A quick-reply button on a TEMPLATE has no payload of its own: the label the
 * patient sees is also what arrives in `msg.button.payload`. Our labels read
 * like sentences and carry an emoji ("📅 Book my next sitting") while the
 * engine's keyword tests are anchored (`/^treatment$/i`), so the tap arrives as
 * unrecognised text and does nothing at all — silently, which is the worst
 * version of this: the patient taps, the clinic sees a message, and no flow
 * starts.
 *
 * Senders also pass a send-time payload override (`quickReplyComponents` in
 * `services/outbound.js`). Where that override lands, `text` is ALREADY the
 * keyword and `normalizeTemplateButton` passes it through untouched — the two
 * mechanisms agree rather than compete. This map is what makes the buttons work
 * without depending on the override.
 *
 * Keyed on the label with emoji, punctuation variants and casing normalised
 * away, because the label is copy: it gets reworded, and a curly apostrophe
 * pasted from a doc must not be the difference between a working button and a
 * dead one. Anything unrecognised is returned unchanged, so a patient who types
 * a real keyword is never rewritten.
 *
 * Keep in step with the Buttons tables in docs/whatsapp-templates.md —
 * tests/templateContract.unit.test.js pins every documented label to its
 * documented payload through this function.
 */

// Emoji, variation selectors and ZWJ out; curly quotes and dashes folded to
// ASCII; case and inner whitespace flattened. Deliberately NOT stripping
// punctuation wholesale — "Yes, I'll be there" keeps its comma so a reworded
// label that drops it is a miss we notice, not a silent near-match.
function canonical(label) {
  return String(label || '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[–—−]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// label (canonical form) -> keyword the engine already understands.
const LABEL_TO_KEYWORD = {
  // 1 appointment_confirmed_v3, 2 appointment_reminder_24h_v3,
  // 9 treatment_sitting_booked
  'reschedule': 'Reschedule',
  'cancel appointment': 'Cancel appointment',
  // 2 appointment_reminder_24h_v3
  "yes, i'll be there": 'Yes',
  // 4 appointment_feedback_request — the rating IS the payload
  'great': '5',
  'okay': '3',
  'not good': '1',
  // 5 appointment_missed_rebook
  'book a new time': 'Menu',
  // 6 treatment_sitting_reminder
  'book my next sitting': 'Treatment',
  // 7 patient_recall_checkup
  'book a check-up': 'Menu',
};

/**
 * @param {string} incoming - `msg.button.payload`, which for our templates is
 *   the label; or an already-correct keyword when a send-time override landed.
 * @returns {string} the keyword to feed the engine, or `incoming` unchanged.
 */
function normalizeTemplateButton(incoming) {
  return LABEL_TO_KEYWORD[canonical(incoming)] || incoming;
}

module.exports = { normalizeTemplateButton, canonical, LABEL_TO_KEYWORD };
