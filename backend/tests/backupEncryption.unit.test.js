'use strict';
/**
 * DB-free unit tests for the backup encryption format shared by
 * jobs/backupManager.js, scripts/backup-prod.js and scripts/decryptBackup.js:
 *
 *   [12-byte IV][AES-256-GCM ciphertext][16-byte auth tag]
 *
 * Doesn't spawn pg_dump or touch Railway — those need a real Postgres/Railway
 * CLI this environment doesn't have. What IS fully testable, and matters
 * most: that a file built the way the writers build it (streamed, in
 * backupManager.js; whole-buffer, in backup-prod.js) is actually readable by
 * scripts/decryptBackup.js's decryptFile — a mismatch here means "the nightly
 * backup succeeded" and "the backup was decryptable" quietly stop meaning the
 * same thing.
 *
 * Run: node tests/backupEncryption.unit.test.js
 */

process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = 'unit-test-backup-encryption-key-32chars!!';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { getKeyBuffer } = require('../src/utils/encryption');
const { decryptFile } = require('../scripts/decryptBackup');

const { Readable } = require('stream');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'medibook-backup-test-'));

// Mirrors backupManager.js's ACTUAL streaming construction — not a whole-buffer
// shortcut. The order that matters and that a "simplification" could break:
// write the IV header, pipe cipher -> writeStream with { end: false }, then on
// the cipher's readable 'end' append getAuthTag() and close the file. If a
// regression writes the tag early or drops it, this round-trip fails; the
// whole-buffer version below would keep passing and hide it.
function writeEncryptedLikeBackupManager(plainBuf, outPath) {
  return new Promise((resolve, reject) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKeyBuffer(), iv);
    const ws = fs.createWriteStream(outPath);
    ws.on('error', reject);
    ws.on('finish', resolve);
    ws.write(iv);
    cipher.pipe(ws, { end: false });
    cipher.on('end', () => {
      try { ws.end(cipher.getAuthTag()); } catch (err) { reject(err); }
    });
    cipher.on('error', reject);
    // Feed it in two chunks through a real stream so cipher.update() is
    // exercised more than once, like a multi-chunk pg_dump stdout.
    const mid = Math.floor(plainBuf.length / 2);
    Readable.from([plainBuf.subarray(0, mid), plainBuf.subarray(mid)]).pipe(cipher);
  });
}

// Mirrors backup-prod.js's whole-file construction — same framing, built
// differently (read-whole-file-then-encrypt instead of streamed).
function writeEncryptedLikeBackupProd(plainBuf, outPath) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKeyBuffer(), iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(outPath, Buffer.concat([iv, ciphertext, tag]));
}

async function run() {
  let pass = 0, fail = 0;
  function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  }
  async function testAsync(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
  }

  console.log('\nBackup file encryption format (backupManager.js / backup-prod.js / decryptBackup.js)\n');

  await testAsync('a file built the way backupManager.js builds it (real streamed pipeline) decrypts correctly', async () => {
    const plain = Buffer.from('-- fake pg_dump output --\nCREATE TABLE patients (...);\n'.repeat(50));
    const encPath = path.join(TMP, 'a.sql.enc');
    const outPath = path.join(TMP, 'a.sql');
    await writeEncryptedLikeBackupManager(plain, encPath);
    decryptFile(encPath, outPath);
    assert(Buffer.compare(fs.readFileSync(outPath), plain) === 0, 'round-trip did not reproduce the original bytes');
  });

  test('a file built the way backup-prod.js builds it decrypts correctly', () => {
    const plain = crypto.randomBytes(200000); // stand-in for a binary custom-format dump
    const encPath = path.join(TMP, 'b.dump.enc');
    const outPath = path.join(TMP, 'b.dump');
    writeEncryptedLikeBackupProd(plain, encPath);
    decryptFile(encPath, outPath);
    assert(Buffer.compare(fs.readFileSync(outPath), plain) === 0, 'round-trip did not reproduce the original bytes');
  });

  await testAsync('an empty dump still round-trips (IV + empty ciphertext + tag, no content)', async () => {
    const encPath = path.join(TMP, 'empty.sql.enc');
    const outPath = path.join(TMP, 'empty.sql');
    await writeEncryptedLikeBackupManager(Buffer.alloc(0), encPath);
    decryptFile(encPath, outPath);
    assert.strictEqual(fs.statSync(outPath).size, 0);
  });

  await testAsync('CRITICAL: a corrupted backup file throws rather than silently returning garbage', async () => {
    const plain = Buffer.from('sensitive patient data');
    const encPath = path.join(TMP, 'c.sql.enc');
    await writeEncryptedLikeBackupManager(plain, encPath);
    const bytes = fs.readFileSync(encPath);
    bytes[20] ^= 0xff; // flip a bit in the ciphertext
    fs.writeFileSync(encPath, bytes);
    assert.throws(() => decryptFile(encPath, path.join(TMP, 'c.sql')),
      /Decryption failed/, 'a tampered backup must not decrypt silently');
  });

  test('a file that is too short to hold IV+tag is rejected outright', () => {
    const encPath = path.join(TMP, 'tiny.sql.enc');
    fs.writeFileSync(encPath, Buffer.from('short'));
    assert.throws(() => decryptFile(encPath, path.join(TMP, 'tiny.sql')), /too small/);
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

run();
