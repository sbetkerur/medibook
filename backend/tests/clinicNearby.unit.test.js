'use strict';
/**
 * "Clinics near me" — the second entry point on the shared WhatsApp number, for
 * a patient who knows where they are but not what their clinic is called.
 *
 * Three rules matter, and each has a sharp edge:
 *
 *  1. The trigger must not swallow a real search. "City Dental Care" and
 *     "Garden City Dental" are plausible tenant names, so a bare "city" (or a
 *     bare "near") has to stay a NAME search — the picker is only reached by an
 *     unambiguous phrase.
 *  2. A city is resolved exactly or by a unique prefix, never fuzzily.
 *     "Mysore" and "Mysuru" are different rows here; typo tolerance would
 *     silently hand a patient the wrong city's clinics.
 *  3. Ambiguity is answered by asking, not by guessing — matchCity returns null
 *     when two cities match, the same contract as fuzzyFind and searchTenants.
 *
 * Run: node tests/clinicNearby.unit.test.js
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { matchCity, normalizeCity } = require('../src/services/bot/clinicSearch');
const { NEARBY_RE, CITY_ROW_PREFIX } = require('../src/routes/webhook');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`); failed++; }
}

console.log('\nclinics near me — trigger safety and city resolution\n');

// ── 1. The trigger phrase ────────────────────────────────────
// The button title itself must round-trip: wa.sendButtons mints opaque reply
// ids, so the tap is recognised by its TEXT.
check('button title matches', NEARBY_RE.test('📍 Clinics near me'), true);
check('button title without the emoji', NEARBY_RE.test('Clinics near me'), true);
check('singular form', NEARBY_RE.test('clinic near me'), true);
check('case insensitive', NEARBY_RE.test('CLINICS NEAR ME'), true);
check('"near me"', NEARBY_RE.test('near me'), true);
check('"nearby"', NEARBY_RE.test('nearby'), true);
check('"near by" spaced', NEARBY_RE.test('near by'), true);
check('"my city"', NEARBY_RE.test('my city'), true);

// These are the edge: each is a plausible clinic-name query and must NOT be
// hijacked into the city picker.
check('bare "city" stays a name search', NEARBY_RE.test('city'), false);
check('bare "near" stays a name search', NEARBY_RE.test('near'), false);
check('"City Dental Care" stays a name search', NEARBY_RE.test('City Dental Care'), false);
check('"Garden City" stays a name search', NEARBY_RE.test('Garden City'), false);
check('"city dental" stays a name search', NEARBY_RE.test('city dental'), false);
// Anchored at both ends — a sentence that merely contains the phrase is a
// search, not a command.
check('phrase inside a longer message is not the trigger',
  NEARBY_RE.test('is there a clinic near me in Pune'), false);

// ── 2. City row ids are namespaced ───────────────────────────
// The clinic shortlist uses raw tenant UUIDs as row ids; the city picker must
// never collide with one.
check('city row id prefix', CITY_ROW_PREFIX, 'city:');
check('a prefixed id is not a UUID',
  /^[0-9a-f-]{36}$/i.test(CITY_ROW_PREFIX + 'Bengaluru'), false);

// ── 3. Resolving a typed city ────────────────────────────────
// Mysore/Mysuru are both present ON PURPOSE: they are 2 edits apart, so any
// fuzzy matching would collapse them.
const cities = ['Bengaluru', 'Mumbai', 'Mysore', 'Mysuru', 'Pune'];
const pick = (q) => matchCity(cities, q);

check('exact', pick('Pune'), 'Pune');
check('exact, different case', pick('pune'), 'Pune');
check('exact, padded', pick('  Mumbai  '), 'Mumbai');
check('unique prefix', pick('beng'), 'Bengaluru');
check('unique prefix, lowercased', pick('mumb'), 'Mumbai');
check('punctuation normalised away', pick('beng-aluru'), 'Bengaluru');
// Multi-word cities get written both ways in practice.
check('multi-word city typed without the space',
  matchCity(['New Delhi', 'Pune'], 'newdelhi'), 'New Delhi');
check('multi-word city typed with the space',
  matchCity(['New Delhi', 'Pune'], 'new delhi'), 'New Delhi');

// An exact hit wins even when it is also a prefix of nothing else — and
// crucially, "Mysore" must not drift to "Mysuru".
check('exact wins over near-neighbour', pick('Mysore'), 'Mysore');
check('the other near-neighbour resolves to itself', pick('Mysuru'), 'Mysuru');
check('shared prefix of two cities is ambiguous → null', pick('mys'), null);
check('no typo tolerance: one edit off is not a match', pick('Punee'), null);
check('unknown city', pick('Chennai'), null);
check('single char is not evidence of intent', pick('P'), null);
check('empty input', pick(''), null);
check('null input', pick(null), null);
check('null city list', matchCity(null, 'Pune'), null);
check('blank entries in the list are ignored', matchCity(['', null, 'Pune'], 'Pune'), 'Pune');

// normalizeCity must NOT strip "dental"/"clinic" the way the clinic-name
// normalizer does — those are noise in a clinic name, not in a place name.
check('city normalizer keeps every word', normalizeCity('Clinic Town'), 'clinic town');

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
