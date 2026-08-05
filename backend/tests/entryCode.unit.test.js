'use strict';
/**
 * Entry codes are the ONLY way a patient reaches a clinic on the shared
 * WhatsApp number — there is no name search and no browse-by-location any more.
 * That makes two failure modes expensive:
 *
 *   - a code that fails to be recognised strands a patient who is standing in
 *     the clinic holding their phone at its poster, with no fallback path; and
 *   - a code recognised too eagerly hijacks a patient mid-conversation, or
 *     silently moves them to a clinic they never asked for.
 *
 * So the rules under test are about WHEN a candidate is honoured, not just
 * whether the characters parse.
 *
 * Run: node tests/entryCode.unit.test.js
 */
const {
  ALPHABET, CODE_LEN, generateEntryCode, normalizeEntryCode, isValidEntryCode,
  extractEntryCode, buildEntryMessage, buildEntryLink,
} = require('../src/utils/entryCode');
const { SWITCH_CLINIC_RE } = require('../src/routes/webhook');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`); failed++; }
}

console.log('\nentryCode — what attaches a patient to a clinic\n');

// ── The printed alphabet ─────────────────────────────────────
// The whole reason input needs no lookalike mapping is that the ambiguous
// characters are never printed in the first place. If one creeps back into the
// alphabet, a misread "0" for "O" becomes unrecoverable.
console.log(' alphabet');
for (const bad of ['0', 'O', '1', 'I', 'L', 'U']) {
  check(`"${bad}" is never printed`, ALPHABET.includes(bad), false);
}
check('codes are 6 characters', CODE_LEN, 6);

let generatedOk = true;
const seen = new Set();
for (let i = 0; i < 500; i++) {
  const c = generateEntryCode();
  if (c.length !== CODE_LEN || ![...c].every(ch => ALPHABET.includes(ch))) generatedOk = false;
  seen.add(c);
}
check('generated codes stay inside the alphabet', generatedOk, true);
// Not a uniqueness guarantee (the unique index is), just a check that the
// generator is not degenerate — a constant or near-constant generator would
// make every clinic collide.
check('generated codes vary', seen.size > 450, true);

// ── Normalising what a patient typed ─────────────────────────
console.log('\n separators and case');
check('lowercase is folded', normalizeEntryCode('k7m2qx'), 'K7M2QX');
check('spaces are dropped', normalizeEntryCode('K7M 2QX'), 'K7M2QX');
check('hyphens are dropped', normalizeEntryCode('K7M-2QX'), 'K7M2QX');
check('null is empty, not a crash', normalizeEntryCode(null), '');
check('a real code validates', isValidEntryCode('K7M2QX'), true);
check('too short is invalid', isValidEntryCode('K7M2Q'), false);
check('too long is invalid', isValidEntryCode('K7M2QXZ'), false);
// The excluded characters must not sneak back in through the validator either.
check('a code containing O is invalid', isValidEntryCode('K7MOQX'), false);
check('a code containing 1 is invalid', isValidEntryCode('K7M1QX'), false);

// ── TAGGED: what the deep link sends ─────────────────────────
// This is the shape scanning a QR produces, and the one honoured from any
// state — including mid-booking with a different clinic.
console.log('\n tagged codes (a scan)');
check('the exact deep-link message',
  extractEntryCode("Hi Sri Sai Dental Care, I'd like to book an appointment. #K7M2QX"),
  { code: 'K7M2QX', tagged: true });
check('code alone with its marker', extractEntryCode('#K7M2QX'), { code: 'K7M2QX', tagged: true });
check('lowercase from a keyboard', extractEntryCode('hi #k7m2qx'), { code: 'K7M2QX', tagged: true });
check('a space after the hash', extractEntryCode('# K7M2QX'), { code: 'K7M2QX', tagged: true });
check('trailing punctuation', extractEntryCode('booking #K7M2QX!'), { code: 'K7M2QX', tagged: true });
// A longer run of characters is not a code with something appended — treating
// it as one would attach the patient to whichever clinic owns the prefix.
check('an over-long tagged run is not a code', extractEntryCode('#K7M2QXZZ'), null);

// ── BARE: typed off a printed card ───────────────────────────
// Honoured by the webhook only while NO clinic is attached, because six
// characters mid-conversation are far more likely to be an answer.
console.log('\n bare codes (typed off a card)');
check('the whole message is the code', extractEntryCode('K7M2QX'), { code: 'K7M2QX', tagged: false });
check('lowercase, whole message', extractEntryCode('k7m2qx'), { code: 'K7M2QX', tagged: false });
check('hyphenated as printed', extractEntryCode('K7M-2QX'), { code: 'K7M2QX', tagged: false });
// A sentence that merely CONTAINS six valid characters is prose. Reading it as
// a code would move a patient to another clinic mid-sentence.
check('a sentence is not a bare code', extractEntryCode('is DENTAL open today'), null);
check('a spaced-out sentence is not a bare code', extractEntryCode('K7 M2 QX please'), null);
check('empty input', extractEntryCode(''), null);
check('null input', extractEntryCode(null), null);
// Ordinary bot replies must never parse as codes, or a patient answering a
// question would be yanked out of their booking.
for (const reply of ['yes', 'no', '2', 'menu', 'Hi', 'tomorrow', 'treatment']) {
  check(`"${reply}" is not a code`, extractEntryCode(reply), null);
}

// ── The link the QR encodes ──────────────────────────────────
// The `#` MUST arrive as %23. Left raw it becomes a URL fragment, never reaches
// WhatsApp, and the QR silently degrades into a blank message to the shared
// number — the exact failure this feature exists to prevent.
console.log('\n deep link');
const link = buildEntryLink('K7M2QX', 'Sri Sai Dental Care', '+91 77956 76142');
check('the hash is percent-encoded', link.includes('%23K7M2QX'), true);
check('no raw hash survives', link.includes('#'), false);
check('the number is reduced to digits', link.startsWith('https://wa.me/917795676142?text='), true);
check('no number configured means no link', buildEntryLink('K7M2QX', 'X', ''), null);
check('no code means no link', buildEntryLink(null, 'X', '917795676142'), null);
// Round trip: whatever the link carries must be something the bot recognises.
const decoded = decodeURIComponent(link.split('?text=')[1]);
check('the pre-typed message extracts back to the code',
  extractEntryCode(decoded), { code: 'K7M2QX', tagged: true });
check('a clinic with no name still round-trips',
  extractEntryCode(buildEntryMessage('K7M2QX', '')), { code: 'K7M2QX', tagged: true });
// The clinic name in the message is cosmetic — routing is on the code alone, so
// a rename must not invalidate the posters already on the wall.
check('an apostrophe in the clinic name does not break extraction',
  extractEntryCode(buildEntryMessage('K7M2QX', "Dr Rao's Dental")), { code: 'K7M2QX', tagged: true });

// ── Nothing typed may detach a patient ───────────────────────
// With the QR as the only way in, a patient left with no clinic and no poster
// in front of them has no way back. "switch clinic" is answered with an
// instruction to scan; it does not clear the session.
console.log('\n switch-clinic keyword');
check('"switch clinic" is recognised', SWITCH_CLINIC_RE.test('switch clinic'), true);
check('"change branch" is recognised', SWITCH_CLINIC_RE.test('change branch'), true);
// The noun is required: a bare "change" mid-booking means the date, not the clinic.
check('bare "change" is not', SWITCH_CLINIC_RE.test('change'), false);
check('"change the date" is not', SWITCH_CLINIC_RE.test('change the date'), false);
check('"hi" is not', SWITCH_CLINIC_RE.test('hi'), false);

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
