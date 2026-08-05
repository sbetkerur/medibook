'use strict';
/**
 * Multi-department doctors — the normalisation rules for a doctor's bookable
 * treatment set.
 *
 * A dentist belongs to several departments (an Indian GP does simple root canals
 * and extractions alongside general dentistry), but doctors.department_id remains
 * the PRIMARY one, and every display join — receipts, reminders, "by treatment"
 * analytics — still reads it. That makes two rules load-bearing:
 *
 *  1. The primary is ALWAYS in the bookable set, and always first. Otherwise a
 *     doctor could be listed under a treatment their own department_id
 *     contradicts, and the boot-time backfill in tenantMigrate.js would silently
 *     re-add the primary the admin thought they had removed.
 *  2. Anything that isn't a UUID is reported, never dropped and never forwarded.
 *     Dropping it would book a doctor into fewer treatments than the admin asked
 *     for with a 200 OK; forwarding it makes Postgres raise a 500 on the ::uuid
 *     cast instead of the route returning a 400.
 *
 * Run: node tests/doctorDepartments.unit.test.js
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { normalizeDepartmentIds, MAX_DEPARTMENTS_PER_DOCTOR } = require('../src/utils/doctorDepartments');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`); failed++; }
}

const GENERAL  = '11111111-1111-4111-8111-111111111111';
const RCT      = '22222222-2222-4222-8222-222222222222';
const SURGERY  = '33333333-3333-4333-8333-333333333333';

const ids = (primary, list) => normalizeDepartmentIds(primary, list).ids;

console.log('\nMulti-department doctors — bookable set normalisation\n');

// ── The primary is always in the set, always first ───────────
check('primary leads the set',
  ids(GENERAL, [RCT, SURGERY]), [GENERAL, RCT, SURGERY]);
check('primary is added even when the caller omits it from the list',
  ids(GENERAL, [RCT]), [GENERAL, RCT]);
check('primary listed again is not duplicated',
  ids(GENERAL, [RCT, GENERAL]), [GENERAL, RCT]);
check('primary alone is a one-element set (the single-department doctor)',
  ids(GENERAL, undefined), [GENERAL]);
check('list-only promotes the first entry — it becomes the doctor primary',
  ids(null, [RCT, SURGERY]), [RCT, SURGERY]);

// ── Duplicates and casing ────────────────────────────────────
check('duplicates collapse',
  ids(GENERAL, [RCT, RCT, SURGERY, RCT]), [GENERAL, RCT, SURGERY]);
check('a differently-cased UUID is the SAME department, not a second row',
  // Postgres compares uuid values case-insensitively; JS string dedup does not,
  // so without lower-casing this would try to INSERT the same pair twice and
  // trip the primary key.
  ids(GENERAL, [RCT.toUpperCase()]), [GENERAL, RCT]);

// ── "No department" is a legitimate answer, not an error ─────
check('empty string from the dashboard select means no department',
  ids('', []), []);
check('null primary with an empty list is an empty set',
  ids(null, []), []);
check('blank entries inside the list are skipped, not flagged',
  normalizeDepartmentIds(GENERAL, ['', null, RCT]),
  { ids: [GENERAL, RCT], invalid: [], tooMany: false });

// ── Bad input is surfaced, never silently dropped ────────────
check('a non-UUID string is reported as invalid',
  normalizeDepartmentIds(GENERAL, ['root-canal']),
  { ids: [GENERAL], invalid: ['root-canal'], tooMany: false });
check('a non-string entry is reported rather than coerced',
  normalizeDepartmentIds(GENERAL, [42]),
  { ids: [GENERAL], invalid: [42], tooMany: false });
check('an invalid PRIMARY is reported too',
  normalizeDepartmentIds('not-a-uuid', [RCT]),
  { ids: [RCT], invalid: ['not-a-uuid'], tooMany: false });

// ── Upper bound ──────────────────────────────────────────────
const many = Array.from({ length: MAX_DEPARTMENTS_PER_DOCTOR + 1 },
  (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
check('over the cap is flagged so the route can 400',
  normalizeDepartmentIds(null, many).tooMany, true);
check('exactly at the cap is allowed',
  normalizeDepartmentIds(null, many.slice(0, MAX_DEPARTMENTS_PER_DOCTOR)).tooMany, false);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
