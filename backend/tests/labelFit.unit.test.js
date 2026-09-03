'use strict';
/**
 * Fitting clinic-entered names into WhatsApp's interactive slots.
 *
 * WhatsApp caps a reply-button title at 20 characters and a list-row title at
 * 24, and services/whatsapp.js SLICES to those caps rather than let Meta reject
 * the whole message. So an over-length name is never an error anywhere — it just
 * silently reaches the patient cut in half ("Dr. Padmanabhan Venk"). Nothing but
 * this suite would catch a regression.
 *
 * The rule under test: no title slot anywhere in the API is wider than 24, so a
 * longer name CANNOT be shown whole in the title. It is shown whole in the row
 * DESCRIPTION (72), and the title carries a shortened form that must still let a
 * patient tell two rows apart — which is the actual requirement.
 *
 * Run: node tests/labelFit.unit.test.js   (no Postgres/Redis required)
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'unit-test-secret-at-least-32-chars-long!!';
process.env.DISABLE_QUEUE = 'true';

const assert = require('assert');
const { fitPersonName, fitTitle, fitRows } = require('../src/services/bot/bookingFlow');

const BUTTON_MAX = 20;
const LIST_TITLE_MAX = 24;
const LIST_DESC_MAX = 72;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

console.log('\nlabel fitting — long clinic names in WhatsApp pickers\n');

// ── Names that already fit are untouched ─────────────────────
test('a short name is passed through unchanged', () => {
  assert.strictEqual(fitPersonName('Priya Sharma'), 'Dr. Priya Sharma');
  assert.strictEqual(fitTitle('General Dentistry'), 'General Dentistry');
});

test('a name landing exactly on the cap is NOT shortened', () => {
  // "Dr. Padmanabhan Krishnan" is 24 — the last length that fits whole.
  const fitted = fitPersonName('Padmanabhan Krishnan');
  assert.strictEqual(fitted, 'Dr. Padmanabhan Krishnan');
  assert.strictEqual(fitted.length, LIST_TITLE_MAX);
});

// ── The reason names are abbreviated rather than cut ──────────
// A blind cut turns both of these into "Dr. Padmanabhan…", and the picker stops
// being a choice at all. This is the case the whole design exists for.
test('two dentists sharing a long given name stay TELLABLE APART', () => {
  const a = fitPersonName('Padmanabhan Venkatesh');
  const b = fitPersonName('Padmanabhan Sundaram');
  assert.notStrictEqual(a, b, `both names fitted to the same title: ${a}`);
  assert(a.includes('Venkatesh'), `surname lost: ${a}`);
  assert(b.includes('Sundaram'), `surname lost: ${b}`);
});

test('given names are abbreviated to initials, surname kept whole', () => {
  assert.strictEqual(fitPersonName('Padmanabhan Venkatesh'), 'Dr. P. Venkatesh');
  assert.strictEqual(fitPersonName('Sai Krishna Chaitanya Reddy'), 'Dr. S. K. C. Reddy');
});

test('a single name with nothing to abbreviate falls back to a cut', () => {
  const fitted = fitPersonName('Venkatanarasimharajuvaripeta');
  assert(fitted.length <= LIST_TITLE_MAX, `over the cap: ${fitted} (${fitted.length})`);
  assert(fitted.endsWith('…'), `a cut name must show it was cut: ${fitted}`);
});

test('an empty or malformed name does not throw', () => {
  assert.strictEqual(fitPersonName(''), 'Dr.');
  assert.strictEqual(fitPersonName(null), 'Dr.');
  assert.strictEqual(fitPersonName('   '), 'Dr.');
});

// ── Treatments and branches: word-boundary cuts ───────────────
test('a long treatment cuts at a word boundary, not mid-word', () => {
  assert.strictEqual(fitTitle('Oral and Maxillofacial Surgery'), 'Oral and Maxillofacial…');
});

test('a boundary too far back is ignored in favour of the distinguishing word', () => {
  // Breaking at 15 gives "Restorative and…" — ends on a conjunction and drops
  // the word that separates this from plain restorative work.
  const fitted = fitTitle('Restorative and Cosmetic Dentistry');
  assert(/Cosmet/.test(fitted), `distinguishing word lost: ${fitted}`);
  assert(fitted.length <= LIST_TITLE_MAX);
});

test('a name with no spaces at all still fits', () => {
  const fitted = fitTitle('RestorativeAndCosmeticDentistry');
  assert(fitted.length <= LIST_TITLE_MAX, `over the cap: ${fitted} (${fitted.length})`);
});

test('emoji count double against the cap and are still handled', () => {
  // A surrogate pair is two UTF-16 units, which is what whatsapp.js slices on.
  const fitted = fitTitle('🩺 Consultation / Not sure');
  assert(fitted.length <= LIST_TITLE_MAX, `over the cap: ${fitted} (${fitted.length})`);
});

// ── The full name still reaches the patient ───────────────────
test('a shortened title puts the FULL name first in the description', () => {
  const [row] = fitRows([{
    id: 'doc-1',
    title: fitPersonName('Padmanabhan Venkatesh'),
    fullTitle: 'Dr. Padmanabhan Venkatesh',
    description: 'Endodontist • BDS, MDS • ₹700',
  }]);
  assert.strictEqual(row.title, 'Dr. P. Venkatesh');
  assert(row.description.startsWith('Dr. Padmanabhan Venkatesh'),
    `full name must lead the description: ${row.description}`);
  assert(/Endodontist/.test(row.description), 'caller detail was dropped');
});

test('a title that fits does NOT repeat itself in the description', () => {
  const [row] = fitRows([{
    id: 'doc-2',
    title: fitPersonName('Priya Sharma'),
    fullTitle: 'Dr. Priya Sharma',
    description: 'General Dentist • BDS • ₹500',
  }]);
  assert.strictEqual(row.description, 'General Dentist • BDS • ₹500');
});

test('a long treatment carries its full name in the description too', () => {
  const [row] = fitRows([{ id: 'd1', title: 'Oral and Maxillofacial Surgery' }]);
  assert.strictEqual(row.title, 'Oral and Maxillofacial…');
  assert.strictEqual(row.description, 'Oral and Maxillofacial Surgery');
});

test('a row with nothing to add carries no description at all', () => {
  const [row] = fitRows([{ id: 'd2', title: 'General Dentistry' }]);
  assert.strictEqual(row.description, undefined);
});

// ── Two long labels sharing a prefix must not fit to the same title ──
// Regression: a clinic's ONLY branch ("Pragati Dental Studio") and a SECOND
// branch named after it plus a locality ("Pragati Dental Studio — Whitefield")
// both fitted to "Pragati Dental Studio…" — the word-boundary snap-back landed
// right before the branch's own distinguishing suffix, so the patient's branch
// picker showed what looked like the same clinic twice — the second row still
// worked once picked, but nothing on the row let a patient pick it correctly.
test('two branches sharing a long name prefix stay TELLABLE APART', () => {
  const rows = fitRows([
    { id: 'br-1', title: 'Pragati Dental Studio', description: 'Bengaluru' },
    { id: 'br-2', title: 'Pragati Dental Studio — Whitefield', description: 'Bengaluru' },
  ]);
  assert.notStrictEqual(rows[0].title, rows[1].title,
    `both branches fitted to the same title: ${rows[0].title}`);
  // Also guard the confusable case a plain Set misses: one title an exact
  // prefix of the other plus "…" reads identically to a scanning patient.
  const stripEllipsis = t => (t.endsWith('…') ? t.slice(0, -1) : t);
  assert.notStrictEqual(stripEllipsis(rows[0].title), stripEllipsis(rows[1].title),
    `branches are visually indistinguishable: "${rows[0].title}" vs "${rows[1].title}"`);
  assert(rows[1].description.includes('Whitefield'), 'full branch name must still reach the patient');
  for (const r of rows) assert(r.title.length <= LIST_TITLE_MAX, `title over cap: ${r.title}`);
});

// ── Nothing may exceed a cap, whatever the input ──────────────
test('no fitted row can exceed the caps, however long the source', () => {
  const monstrous = 'Advanced Restorative Cosmetic and Maxillofacial Reconstructive Dentistry Unit';
  const rows = fitRows([
    { id: '1', title: monstrous },
    { id: '2', title: fitPersonName(monstrous), fullTitle: `Dr. ${monstrous}`, description: monstrous },
  ]);
  for (const r of rows) {
    assert(r.title.length <= LIST_TITLE_MAX, `title over cap: ${r.title} (${r.title.length})`);
    assert(!r.description || r.description.length <= LIST_DESC_MAX,
      `description over cap: ${r.description.length}`);
  }
});

test('every fitted person name fits a list row', () => {
  for (const n of ['Priya Sharma', 'Padmanabhan Venkatesh', 'Sai Krishna Chaitanya Reddy',
    'Venkatanarasimharajuvaripeta', 'Chandrashekharan', 'A', 'Ram Kumar Singh Rathore Chauhan']) {
    const f = fitPersonName(n);
    assert(f.length <= LIST_TITLE_MAX, `"${n}" fitted to ${f.length}: ${f}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
