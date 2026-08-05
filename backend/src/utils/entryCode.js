'use strict';
/**
 * Per-tenant entry codes — the QR-code way into the shared WhatsApp number, and
 * the ONLY way a patient is attached to a clinic.
 *
 * All tenants share one number, so every inbound message has to be resolved to a
 * clinic somehow. The clinic prints a QR whose payload is a `wa.me` deep link
 * with its code pre-typed; the patient taps, hits send, and lands directly on
 * that clinic's menu.
 *
 * This replaced a clinic-name search and a browse-by-city picker. Both worked,
 * and both were wrong for the paying customer: a clinic's own patient should not
 * have to name the clinic they are physically standing inside, and no clinic
 * wants to pay for a product that answers its patients with a list of the
 * competitors down the road.
 *
 * The code identifies the CLINIC, not the patient — it is printed on a board in
 * a public waiting room, so it is a routing hint and nothing more. It confers no
 * authority: everything downstream still authenticates the patient by phone
 * number exactly as it did before.
 */
const crypto = require('crypto');

/**
 * Deliberately excludes 0/O, 1/I/L and U. The first two pairs are the ones
 * people misread off a printed card, and this is the only fix that works at the
 * source — recovering from a misread AFTERWARDS is impossible, because an "O"
 * is an equally plausible misreading of both "Q" and "D". Removing the
 * ambiguity from what gets printed means input needs no lookalike mapping at
 * all, only case folding. U is dropped so a random code cannot spell something
 * a clinic would refuse to print.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 6;

// 30^6 ≈ 729M. Codes are public and unguessability is not a security property
// here (see above), so this length is chosen to stay readable and to make
// collisions rare enough that the unique-index retry is a formality.
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LEN}}$`);

// `#` anywhere in the message. This is what the deep link pre-types, and the
// marker is what makes it safe to honour mid-conversation: a patient three
// steps into a booking with clinic A who scans clinic B's poster means it.
const TAGGED_RE = new RegExp(`#\\s*([${ALPHABET}]{${CODE_LEN}})(?![${ALPHABET}])`, 'i');

/**
 * A new code. Uses `randomInt` rather than `randomBytes % ALPHABET.length`,
 * which would bias the first 16 characters of a 30-character alphabet.
 */
function generateEntryCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/**
 * Fold what a patient typed onto the stored form. Case and the separators
 * people add when copying off a card ("k7m 2qx", "K7M-2QX") only; no character
 * substitution, for the reason given on ALPHABET.
 */
function normalizeEntryCode(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function isValidEntryCode(value) {
  return CODE_RE.test(normalizeEntryCode(value));
}

/**
 * Pull a clinic's entry code out of an inbound message.
 *
 * Two shapes, and the difference between them matters to the caller:
 *
 *  - `tagged` — a `#K7M2QX` sitting anywhere in the text, which is what the
 *    deep link produces. Explicit enough to act on from ANY session state.
 *  - `bare`   — the whole message is nothing but the code, which is what a
 *    patient typing it off a printed card produces. Honoured only while no
 *    clinic is attached, so a 6-character answer mid-booking can never be
 *    mistaken for a request to change clinic.
 *
 * Returns `{ code, tagged }` or null. A returned code is a CANDIDATE only —
 * `bare` in particular can collide with a real clinic-name search ("CHARMS" is
 * six alphabet characters), so the caller must fall through to the name search
 * when the lookup finds no tenant.
 */
function extractEntryCode(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;

  const tagged = raw.match(TAGGED_RE);
  if (tagged) return { code: normalizeEntryCode(tagged[1]), tagged: true };

  const bare = normalizeEntryCode(raw);
  // Length-checked against the RAW text too: "K7 M2 QX" normalizes to a valid
  // code, but a message with spaces in it is a sentence, not a scanned token.
  if (raw.length <= CODE_LEN + 2 && CODE_RE.test(bare)) return { code: bare, tagged: false };

  return null;
}

/**
 * The message the deep link pre-types. The clinic's name is cosmetic — routing
 * is on the code alone, so a clinic that renames does not invalidate the QR
 * codes already printed and stuck to its wall.
 */
function buildEntryMessage(code, clinicName) {
  const who = String(clinicName || '').trim();
  return who
    ? `Hi ${who}, I'd like to book an appointment. #${code}`
    : `Hi, I'd like to book an appointment. #${code}`;
}

/**
 * The `wa.me` URL the QR encodes. Returns null when no public number is
 * configured, so callers surface "not set up yet" rather than printing a QR
 * that goes nowhere.
 *
 * `encodeURIComponent` is doing load-bearing work: it turns the `#` into `%23`.
 * Left raw, everything from the `#` onwards becomes a URL fragment, never
 * reaches WhatsApp, and the deep link silently degrades into an ordinary
 * message to the shared number — the exact failure this feature exists to
 * prevent, and invisible in testing unless you check what actually got sent.
 */
function buildEntryLink(code, clinicName, publicNumber) {
  const number = String(publicNumber == null ? '' : publicNumber).replace(/\D/g, '');
  if (!number || !code) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(buildEntryMessage(code, clinicName))}`;
}

/** The configured public WhatsApp number, digits only, or null. */
function publicWhatsAppNumber() {
  const n = String(process.env.WHATSAPP_PUBLIC_NUMBER || '').replace(/\D/g, '');
  return n || null;
}

module.exports = {
  ALPHABET,
  CODE_LEN,
  generateEntryCode,
  normalizeEntryCode,
  isValidEntryCode,
  extractEntryCode,
  buildEntryMessage,
  buildEntryLink,
  publicWhatsAppNumber,
};
