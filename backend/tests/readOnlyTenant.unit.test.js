'use strict';
/**
 * The whole-tenant read-only guard (middleware/auth.js `enforceReadOnlyTenant`).
 *
 * A tenant with `read_only=true` (the shareable demo clinic) must let every
 * safe/read request through and 403 every mutation, regardless of role — it is
 * NOT the admin/doctor split. A tenant without the flag is untouched.
 *
 * Run: node tests/readOnlyTenant.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const { enforceReadOnlyTenant } = require('../src/middleware/auth');

function run(method, tenant) {
  const res = {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let nexted = false;
  enforceReadOnlyTenant({ method, tenant }, res, () => { nexted = true; });
  return { allowed: nexted, status: res.statusCode, body: res.body };
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
}

console.log('Read-only tenant guard\n');

test('a normal tenant is never touched — writes pass', () => {
  assert.strictEqual(run('POST', { read_only: false }).allowed, true);
  assert.strictEqual(run('DELETE', {}).allowed, true);
  assert.strictEqual(run('PATCH', undefined).allowed, true);
});

test('read-only tenant: GET / HEAD / OPTIONS pass', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) {
    assert.strictEqual(run(m, { read_only: true }).allowed, true, `${m} should pass`);
  }
});

test('read-only tenant: POST / PUT / PATCH / DELETE are 403 with read_only flag', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = run(m, { read_only: true });
    assert.strictEqual(r.allowed, false, `${m} must be blocked`);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.read_only, true);
    assert.ok(/read-only demo/i.test(r.body.error), 'error names the cause');
  }
});

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
