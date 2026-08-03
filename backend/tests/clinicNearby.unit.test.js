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
const { matchCity, normalizeCity, buildCityChoices, DEFAULT_CITIES } = require('../src/services/bot/clinicSearch');
const { NEARBY_RE, CITY_ROW_PREFIX, isNearbyTrigger } = require('../src/routes/webhook');

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

// ── 4. The picker's rows: real cities, padded with the defaults ──
// The defaults exist so the picker is never empty and the location button can
// always be offered. They must never cost a real clinic its row.
check('no clinics anywhere → the six defaults, in listed order',
  buildCityChoices([]), DEFAULT_CITIES);
check('null input is treated as no clinics',
  buildCityChoices(null), DEFAULT_CITIES);
check('Kolkata is spelled canonically',
  DEFAULT_CITIES.includes('Kolkata'), true);

// A clinic city outside the six must stay reachable — the defaults ADD to the
// list, they never replace it.
check('a non-default clinic city is kept, and sorts ahead of the padding',
  buildCityChoices(['Pune']), ['Pune', ...DEFAULT_CITIES]);
check('real cities sort alphabetically among themselves',
  buildCityChoices(['Pune', 'Goa']).slice(0, 2), ['Goa', 'Pune']);

// Dedup is on normalizeCity: the city filter downstream is case-insensitive, so
// a second row would just show the same clinics twice.
check('a clinic in a default city does not double the row',
  buildCityChoices(['Mumbai']), ['Mumbai', 'New Delhi', 'Chennai', 'Kolkata', 'Bengaluru', 'Hyderabad']);
check('case variant of a default is deduped, tenant spelling wins',
  buildCityChoices(['bengaluru']).filter(c => normalizeCity(c) === 'bengaluru'), ['bengaluru']);
check('two tenants in the same city, different case → one row',
  buildCityChoices(['Pune', 'pune']).filter(c => normalizeCity(c) === 'pune'), ['Pune']);
check('spacing variant of a default is deduped',
  buildCityChoices(['new  delhi']).filter(c => normalizeCity(c) === 'new delhi'), ['new  delhi']);
check('blank and null clinic cities are ignored',
  buildCityChoices(['', null, '   ']), DEFAULT_CITIES);

// A default city with no clinics is still a valid pick — the caller answers
// "no clinics in X yet". matchCity has to resolve it for the typed fallback.
check('a padded default resolves when typed',
  matchCity(buildCityChoices([]), 'chennai'), 'Chennai');
check('"newdelhi" reaches the padded "New Delhi"',
  matchCity(buildCityChoices([]), 'newdelhi'), 'New Delhi');

// ── 5. TAPPING the button, not just typing the phrase ────────
// The regression that made the feature look dead: wa.sendButtons sends an
// opaque `btn_0_<ts>` id alongside the title, so a guard of `!buttonId` threw
// away the tap the button exists for and the phrase fell through to the clinic
// name search ("no clinic found matching '📍 Clinics near me'").
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const tap = (over) => isNearbyTrigger({
  text: '📍 Clinics near me', buttonId: 'btn_0_1234567890',
  cityRowId: null, tenantIds: [TENANT_A], ...over,
});

check('TAPPING the button opens the picker', tap(), true);
check('typing the phrase still opens the picker',
  tap({ buttonId: null }), true);
check('the numbered text fallback ("near me") opens it',
  tap({ text: 'near me', buttonId: null }), true);

// Ids we DO recognise must win over the phrase.
check('a city row is an ANSWER to the picker, not a request to reopen it',
  tap({ text: 'Hyderabad', buttonId: 'city:Hyderabad', cityRowId: 'Hyderabad' }), false);
check('a clinic row tap is never hijacked by its title',
  isNearbyTrigger({ text: 'Nearby', buttonId: TENANT_A, cityRowId: null, tenantIds: [TENANT_A] }), false);
// ...but an unrecognised id is not evidence of anything — the text decides.
check('an unknown button id does not suppress the phrase',
  tap({ buttonId: 'btn_2_999' }), true);

// The guards that already held must keep holding through the new predicate.
check('a greeting is not a nearby trigger', tap({ text: 'hi', buttonId: null }), false);
check('bare "city" is still a name search', tap({ text: 'city', buttonId: null }), false);
check('a real clinic name is still a name search',
  tap({ text: 'Smile Dental', buttonId: null }), false);
check('empty text is not a trigger', tap({ text: '', buttonId: null }), false);
check('null text is not a trigger', tap({ text: null, buttonId: null }), false);
check('missing tenantIds does not throw',
  isNearbyTrigger({ text: 'near me', buttonId: 'btn_0_1', cityRowId: null }), true);

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
