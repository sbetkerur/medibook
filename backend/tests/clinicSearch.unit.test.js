'use strict';
/**
 * Clinic search backs the shared-WhatsApp-number entry point. Two rules matter:
 *
 *  1. "dental" and "clinic" are noise — typing them, or leaving them out, must
 *     make no difference to what is found.
 *  2. An ambiguous query returns EVERY match, never a best guess. The caller
 *     auto-selects only on a single hit; anything else is disambiguated by
 *     asking (same contract as fuzzyFind).
 *
 * Run: node tests/clinicSearch.unit.test.js
 */
const { searchTenants, isQueryTooGeneric, normalize, shortLabel } = require('../src/services/bot/clinicSearch');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`); failed++; }
}

const tenants = [
  { id: '1', name: 'Smile Dental Clinic', city: 'Bengaluru' },
  { id: '2', name: 'Sunrise Dentistry', city: 'Pune' },
  { id: '3', name: 'Apollo Dental Clinic Koramangala', city: 'Bengaluru' },
  { id: '4', name: 'Apollo Dental Clinic Indiranagar', city: 'Bengaluru' },
  { id: '5', name: 'City Dental Care', city: 'Mumbai' },
];
const found = (q) => searchTenants(tenants, q).map(t => t.name);

console.log('\nclinicSearch — noise words, ambiguity and entry safety\n');

// ── "dental" / "clinic" are ignored on both sides ────────────
check('bare distinctive word', found('smile'), ['Smile Dental Clinic']);
check('with "clinic" appended', found('smile clinic'), ['Smile Dental Clinic']);
check('with "dental" appended', found('smile dental'), ['Smile Dental Clinic']);
check('full name as listed', found('Smile Dental Clinic'), ['Smile Dental Clinic']);
check('noise word in the middle', found('apollo dental koramangala'), ['Apollo Dental Clinic Koramangala']);
check('noise words reordered', found('clinic smile'), ['Smile Dental Clinic']);
check('normalize strips noise words', normalize('Smile Dental Clinic'), 'smile');
// A clinic whose whole name IS noise keeps its words when indexed (stripping
// them would leave it with no searchable text at all)…
check('name made only of noise words keeps its words', normalize('Dental Clinic'), 'dental clinic');
// …but a query of nothing but noise is still refused: it would match half the
// roster, and dumping that is exactly what search replaced.
check('noise-only query is refused even if a name matches it',
  searchTenants([{ id: 'x', name: 'Dental Clinic' }], 'dental clinic'), []);

// ── The entry-point rule: never answer with the whole roster ──
check('"clinic" alone is too generic', isQueryTooGeneric('clinic'), true);
check('"dental clinic" alone is too generic', isQueryTooGeneric('dental clinic'), true);
check('a real name is not too generic', isQueryTooGeneric('smile dental'), false);
check('too-generic query returns no matches', found('dental clinic'), []);
check('empty query returns no matches', found(''), []);
check('one-letter query returns no matches', found('s'), []);
check('two-letter query returns no matches', found('sm'), []);
check('overlong query is rejected (DoS guard)', found('x'.repeat(80)), []);

// ── Ambiguity surfaces as a choice, not a guess ──────────────
check('shared brand returns both branches', found('apollo'),
  ['Apollo Dental Clinic Koramangala', 'Apollo Dental Clinic Indiranagar']);
check('branch name narrows it to one', found('apollo indiranagar'),
  ['Apollo Dental Clinic Indiranagar']);
check('no match at all', found('zzzzzz'), []);

// ── Ordinary search behaviour ────────────────────────────────
check('prefix of a word', found('sunr'), ['Sunrise Dentistry']);
check('"dent" prefix does not drag in every clinic', found('sunrise dent'), ['Sunrise Dentistry']);
check('spaces collapsed', found('smiledental'), ['Smile Dental Clinic']);
check('typo within threshold', found('sunrize'), ['Sunrise Dentistry']);
check('case insensitive', found('CITY care'), ['City Dental Care']);
check('empty tenant list', found.call(null, 'smile') && searchTenants([], 'smile'), []);

// ── Shortlist row titles survive WhatsApp's 24-char cut ──────
// Both Apollo branches would otherwise render as "Apollo Dental Clinic Ko…".
check('short name is left alone', shortLabel('Smile Dental Clinic'), 'Smile Dental Clinic');
check('long name drops the noise words', shortLabel('Apollo Dental Clinic Koramangala'), 'Apollo Koramangala');
check('two branches stay distinguishable within 24 chars',
  ['Apollo Dental Clinic Koramangala', 'Apollo Dental Clinic Indiranagar']
    .map(n => shortLabel(n).slice(0, 24)),
  ['Apollo Koramangala', 'Apollo Indiranagar']);
// Stripping must not leave a stub that identifies nothing.
check('name that strips down to a stub keeps its full form',
  shortLabel('The Dental Clinic Dental Clinic'), 'The Dental Clinic Dental Clinic');

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
