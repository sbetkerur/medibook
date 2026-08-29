'use strict';
/**
 * DB-free unit tests for utils/encryption.js's encryptJSON/decryptJSON —
 * the encryption now applied to patients.dental_history (blood type,
 * allergies, chronic conditions, medications) in routes/patients.js and
 * routes/appointments.js, using the same `{_enc: "v2:..."}` convention
 * services/botEngine.js already established for bot_sessions.context.
 *
 * The one behaviour worth pinning hardest: a decryption FAILURE must never
 * come back looking like "no history recorded" ({}) — a dentist checking for
 * an allergy needs to be told the read failed, not handed a falsely
 * reassuring empty record. See the doc comment on decryptJSON.
 *
 * Run: node tests/dentalHistoryEncryption.unit.test.js
 */

process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = 'unit-test-encryption-key-at-least-32-chars!!';

const assert = require('assert');
const { encryptJSON, decryptJSON, encrypt } = require('../src/utils/encryption');

async function run() {
  let pass = 0, fail = 0;
  function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  }

  console.log('\ndental_history encryption (encryptJSON/decryptJSON)\n');

  test('round-trips a real medical-history shape', () => {
    const history = { blood_type: 'O+', allergies: ['Penicillin'], chronic_conditions: ['Diabetes'], medications: ['Metformin'] };
    const stored = encryptJSON(history);
    assert(stored._enc && stored._enc.startsWith('v2:'), 'not wrapped in the expected {_enc: "v2:..."} shape');
    assert.deepStrictEqual(decryptJSON(stored), history);
  });

  test('an empty object round-trips to an empty object, not null', () => {
    assert.deepStrictEqual(decryptJSON(encryptJSON({})), {});
  });

  test('encryptJSON(undefined/null) stores an empty object', () => {
    assert.deepStrictEqual(decryptJSON(encryptJSON(undefined)), {});
    assert.deepStrictEqual(decryptJSON(encryptJSON(null)), {});
  });

  test('a legacy PLAINTEXT row (no _enc key) is returned as-is', () => {
    const legacy = { allergies: ['Latex'] };
    assert.deepStrictEqual(decryptJSON(legacy), legacy);
  });

  test('a bare {} row (legacy default, never encrypted) decrypts to {}', () => {
    assert.deepStrictEqual(decryptJSON({}), {});
  });

  test('null/undefined input is treated as empty, not a failure', () => {
    assert.deepStrictEqual(decryptJSON(null), {});
    assert.deepStrictEqual(decryptJSON(undefined), {});
  });

  test('CRITICAL: tampered ciphertext decrypts to null, never to {}', () => {
    const stored = encryptJSON({ allergies: ['Penicillin'] });
    const tampered = { _enc: stored._enc.slice(0, -4) + 'dead' };
    assert.strictEqual(decryptJSON(tampered), null,
      'a corrupted allergy record must never silently read as "no allergies"');
  });

  test('CRITICAL: a malformed _enc value decrypts to null, not {}', () => {
    assert.strictEqual(decryptJSON({ _enc: 'not-a-real-ciphertext' }), null);
  });

  test('two encryptions of the same value produce different ciphertext (random IV)', () => {
    const a = encrypt(JSON.stringify({ allergies: ['Penicillin'] }));
    const b = encrypt(JSON.stringify({ allergies: ['Penicillin'] }));
    assert.notStrictEqual(a, b, 'identical plaintext must not produce identical ciphertext');
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
