'use strict';
/**
 * Unit tests for the terms-acceptance rules. No DB — these cover the decision
 * logic that decides whether a clinic is under contract, which is the part
 * that has legal consequences if it silently goes wrong.
 *
 * Run: node tests/termsAcceptance.unit.test.js
 */
const assert = require('assert');
const { CURRENT_TERMS_VERSION, hasAcceptedCurrentTerms } = require('../src/config/terms');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\nhasAcceptedCurrentTerms');

test('a tenant that never accepted is not accepted', () => {
  assert.strictEqual(hasAcceptedCurrentTerms({}), false);
  assert.strictEqual(hasAcceptedCurrentTerms({ terms_accepted_at: null, terms_version: null }), false);
});

test('a tenant on the current version is accepted', () => {
  assert.strictEqual(
    hasAcceptedCurrentTerms({ terms_accepted_at: new Date(), terms_version: CURRENT_TERMS_VERSION }),
    true
  );
});

test('a tenant on an OLDER version is NOT accepted — this is what re-prompts', () => {
  // The whole point of storing the version: bumping CURRENT_TERMS_VERSION must
  // put every tenant back behind the gate. If this ever returns true, a terms
  // change silently binds customers to text they never saw.
  assert.strictEqual(
    hasAcceptedCurrentTerms({ terms_accepted_at: new Date(), terms_version: '0.9' }),
    false
  );
});

test('a timestamp with no version does not count', () => {
  // Guards against a half-written row or a backfill that set only the date.
  assert.strictEqual(hasAcceptedCurrentTerms({ terms_accepted_at: new Date() }), false);
});

test('a version with no timestamp does not count', () => {
  assert.strictEqual(hasAcceptedCurrentTerms({ terms_version: CURRENT_TERMS_VERSION }), false);
});

test('null/undefined tenant is handled, not thrown', () => {
  // The route 404s on a missing tenant, but this must not be the thing that
  // throws first and turns a clean 404 into a 500.
  assert.strictEqual(hasAcceptedCurrentTerms(null), false);
  assert.strictEqual(hasAcceptedCurrentTerms(undefined), false);
});

console.log('\nCURRENT_TERMS_VERSION');

test('is a non-empty string', () => {
  assert.strictEqual(typeof CURRENT_TERMS_VERSION, 'string');
  assert.ok(CURRENT_TERMS_VERSION.length > 0);
});

test('fits the VARCHAR(20) column in migration 24', () => {
  // A longer value would be silently rejected by Postgres at accept time,
  // failing the write and leaving the tenant permanently gated.
  assert.ok(
    CURRENT_TERMS_VERSION.length <= 20,
    `version "${CURRENT_TERMS_VERSION}" exceeds the 20-char column`
  );
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures)' : ''}\n`);
