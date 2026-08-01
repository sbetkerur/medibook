'use strict';
/**
 * fuzzyFind resolves a patient's free-text reply to a hospital, treatment or
 * dentist. Getting it wrong books someone with the wrong dentist, so the rule
 * under test is: when the input is not clear evidence of intent, return null
 * and let the caller re-prompt. Never resolve ambiguity by list order.
 *
 * Run: node tests/fuzzyFind.unit.test.js
 */
const { fuzzyFind } = require('../src/services/bot/utils');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const a = actual === null ? null : (actual && actual.name);
  if (a === expected) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}\n     expected: ${expected}\n     actual:   ${a}`); failed++; }
}

const doctors = [
  { id: '1', name: 'Anjali Verma' },
  { id: '2', name: 'Arjun Sharma' },
  { id: '3', name: 'Sanjay Shah' },
  { id: '4', name: 'Priya Nair' },
];

console.log('\nfuzzyFind — ambiguity and short-input safety\n');

// ── The bug this guards against ──────────────────────────────
// "a" is a substring of every name above. This used to return the first item.
check('single letter matches nothing', fuzzyFind(doctors, 'a'), null);
check('two letters match nothing', fuzzyFind(doctors, 'an'), null);
check('stray vowel matches nothing', fuzzyFind(doctors, 'e'), null);

// ── Ambiguity must not be resolved by order ──────────────────
// "sha" appears in both "Arjun Sharma" and "Sanjay Shah".
check('ambiguous substring returns null', fuzzyFind(doctors, 'sha'), null);
// "an" would hit Anjali/Arjun/Sanjay — already covered by the length floor,
// but confirm a longer ambiguous fragment behaves too.
check('ambiguous longer fragment returns null', fuzzyFind(doctors, 'anj'), null);

// ── Legitimate input must still resolve ──────────────────────
check('exact full name', fuzzyFind(doctors, 'Anjali Verma'), 'Anjali Verma');
check('exact match is case-insensitive', fuzzyFind(doctors, 'priya nair'), 'Priya Nair');
check('unique substring resolves', fuzzyFind(doctors, 'sharma'), 'Arjun Sharma');
check('unique substring, partial surname', fuzzyFind(doctors, 'nair'), 'Priya Nair');
check('typo within threshold still resolves', fuzzyFind(doctors, 'priya nayr'), 'Priya Nair');

// ── Edge cases ───────────────────────────────────────────────
check('empty input', fuzzyFind(doctors, ''), null);
check('null input', fuzzyFind(doctors, null), null);
check('no match at all', fuzzyFind(doctors, 'zzzzzz'), null);
check('overlong input is rejected (DoS guard)', fuzzyFind(doctors, 'x'.repeat(80)), null);
check('empty item list', fuzzyFind([], 'sharma'), null);

// Two identically-named items cannot be told apart — ask rather than guess.
check('duplicate exact names return null',
  fuzzyFind([{ id: '1', name: 'Rahul Rao' }, { id: '2', name: 'Rahul Rao' }], 'Rahul Rao'), null);

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
