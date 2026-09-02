'use strict';
/**
 * Off-site backup upload + the backup dead-man's-switch ping.
 *
 * Both exist because the copies we already had die with the thing they protect:
 * the in-container backup with the Railway project, the laptop copy with the
 * laptop, and a backup that silently stops running with nobody's attention.
 * This pins the behaviour that matters during an incident:
 *   - "not configured" degrades to OFF, never a crash
 *   - a bucket outage during upload does NOT throw into the backup cron
 *   - retention deletes the OLDEST objects and only ever this project's own
 *   - the healthcheck ping hits /start and /fail, and swallows its own errors
 *
 * Run: node tests/backupUpload.unit.test.js   (no Postgres/Redis/network)
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Stub the AWS SDK before backupUpload loads it ────────────────────────────
const s3State = { objects: [], puts: [], deletes: [], sendImpl: null };
class FakeS3Client {
  constructor(opts) { this.opts = opts; }
  async send(cmd) {
    if (s3State.sendImpl) return s3State.sendImpl(cmd);
    if (cmd._type === 'put') { s3State.puts.push(cmd.input); return {}; }
    if (cmd._type === 'list') {
      return { Contents: s3State.objects.slice(), IsTruncated: false };
    }
    if (cmd._type === 'delete') {
      s3State.deletes.push(...cmd.input.Delete.Objects.map(o => o.Key));
      return {};
    }
    if (cmd._type === 'get') {
      const { Readable } = require('stream');
      return { Body: Readable.from([Buffer.from('ciphertext')]) };
    }
    return {};
  }
  destroy() {}
}
const cmd = type => class { constructor(input) { this.input = input; this._type = type; } };
const fakeSdk = {
  S3Client: FakeS3Client,
  PutObjectCommand: cmd('put'),
  ListObjectsV2Command: cmd('list'),
  DeleteObjectsCommand: cmd('delete'),
  GetObjectCommand: cmd('get'),
};
const sdkPath = require.resolve('@aws-sdk/client-s3');
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: fakeSdk };

// Quiet logger.
const logPath = require.resolve('../src/utils/logger');
require.cache[logPath] = {
  id: logPath, filename: logPath, loaded: true,
  exports: { info() {}, warn() {}, error() {} },
};

const backupUpload = require('../src/services/backupUpload');
const { pingHealthcheck } = require('../src/utils/healthPing');

// ── tiny runner ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
}

function configure(on) {
  if (on) {
    process.env.BACKUP_S3_BUCKET = 'medibook-dr';
    process.env.BACKUP_S3_ACCESS_KEY_ID = 'ak';
    process.env.BACKUP_S3_SECRET_ACCESS_KEY = 'sk';
    process.env.BACKUP_S3_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    process.env.BACKUP_S3_PREFIX = 'medibook-backups/';
  } else {
    delete process.env.BACKUP_S3_BUCKET;
    delete process.env.BACKUP_S3_ACCESS_KEY_ID;
    delete process.env.BACKUP_S3_SECRET_ACCESS_KEY;
  }
}
function reset() { s3State.objects = []; s3State.puts = []; s3State.deletes = []; s3State.sendImpl = null; }
function obj(name, ageDays) {
  return {
    Key: `medibook-backups/${name}`,
    Size: 4096,
    LastModified: new Date(Date.now() - ageDays * 86400_000),
  };
}

(async () => {
  console.log('Off-site backup upload unit tests\n');

  await test('isConfigured() is false with no env, true once bucket + creds are set', () => {
    configure(false);
    assert.strictEqual(backupUpload.isConfigured(), false);
    configure(true);
    assert.strictEqual(backupUpload.isConfigured(), true);
  });

  await test('uploadBackup() is a no-op that does not throw when unconfigured', async () => {
    configure(false); reset();
    const r = await backupUpload.uploadBackup('/nonexistent');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(s3State.puts.length, 0);
  });

  await test('uploadBackup() PUTs under the prefix with the file basename as key', async () => {
    configure(true); reset();
    const f = path.join(os.tmpdir(), `medibook-prod-${Date.now()}.dump.enc`);
    fs.writeFileSync(f, Buffer.alloc(1234, 7));
    try {
      const r = await backupUpload.uploadBackup(f);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(s3State.puts.length, 1);
      assert.strictEqual(s3State.puts[0].Key, `medibook-backups/${path.basename(f)}`);
      assert.strictEqual(s3State.puts[0].ContentLength, 1234);
    } finally { fs.unlinkSync(f); }
  });

  await test('uploadBackup() reports failure instead of throwing when the API errors', async () => {
    configure(true); reset();
    s3State.sendImpl = () => { throw new Error('bucket unreachable'); };
    const f = path.join(os.tmpdir(), `medibook-prod-${Date.now()}.dump.enc`);
    fs.writeFileSync(f, Buffer.alloc(10));
    try {
      const r = await backupUpload.uploadBackup(f);   // must not throw
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /unreachable/);
    } finally { fs.unlinkSync(f); }
  });

  await test('listRemote() returns this project\'s backups only, newest first', async () => {
    configure(true); reset();
    s3State.objects = [
      obj('medibook-prod-old.dump.enc', 10),
      obj('medibook-prod-new.dump.enc', 1),
      obj('medibook_backup_mid.sql.enc', 5),
      obj('unrelated-file.txt', 0),          // must be ignored
    ];
    const list = await backupUpload.listRemote();
    assert.deepStrictEqual(
      list.map(o => path.posix.basename(o.key)),
      ['medibook-prod-new.dump.enc', 'medibook_backup_mid.sql.enc', 'medibook-prod-old.dump.enc']);
  });

  await test('pruneRemote(keep) deletes exactly the oldest beyond keep', async () => {
    configure(true); reset();
    s3State.objects = [
      obj('medibook-prod-a.dump.enc', 1),
      obj('medibook-prod-b.dump.enc', 2),
      obj('medibook-prod-c.dump.enc', 3),
      obj('medibook-prod-d.dump.enc', 4),
      obj('medibook-prod-e.dump.enc', 5),
    ];
    const r = await backupUpload.pruneRemote(2);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.deleted, 3);
    assert.deepStrictEqual(s3State.deletes.map(k => path.posix.basename(k)),
      ['medibook-prod-c.dump.enc', 'medibook-prod-d.dump.enc', 'medibook-prod-e.dump.enc']);
  });

  await test('pruneRemote() never deletes a non-backup object sharing the bucket', async () => {
    configure(true); reset();
    s3State.objects = [
      obj('medibook-prod-a.dump.enc', 1),
      obj('company-secrets.txt', 9),
    ];
    const r = await backupUpload.pruneRemote(1);
    assert.strictEqual(r.deleted, 0);
    assert.strictEqual(s3State.deletes.length, 0);
  });

  await test('pruneRemote() reports failure without throwing on API error', async () => {
    configure(true); reset();
    s3State.objects = [obj('medibook-prod-a.dump.enc', 1), obj('medibook-prod-b.dump.enc', 2)];
    s3State.sendImpl = c => { if (c._type === 'delete') throw new Error('denied'); return { Contents: s3State.objects, IsTruncated: false }; };
    const r = await backupUpload.pruneRemote(1);
    assert.strictEqual(r.ok, false);
  });

  // ── healthPing ────────────────────────────────────────────────────────────
  await test('pingHealthcheck() suffixes /start and /fail, leaves success bare', async () => {
    const hits = [];
    global.fetch = async (url) => { hits.push(url); return { ok: true }; };
    await pingHealthcheck('https://hc.example/abc', { status: 'start' });
    await pingHealthcheck('https://hc.example/abc/', { status: 'success' });
    await pingHealthcheck('https://hc.example/abc', { status: 'fail' });
    assert.deepStrictEqual(hits, [
      'https://hc.example/abc/start',
      'https://hc.example/abc',
      'https://hc.example/abc/fail',
    ]);
  });

  await test('pingHealthcheck() swallows a rejected fetch and returns false', async () => {
    global.fetch = async () => { throw new Error('network down'); };
    const r = await pingHealthcheck('https://hc.example/abc', { status: 'success' });
    assert.strictEqual(r, false);
  });

  await test('pingHealthcheck() is a no-op with no URL', async () => {
    let called = false;
    global.fetch = async () => { called = true; return { ok: true }; };
    const r = await pingHealthcheck('', { status: 'success' });
    assert.strictEqual(r, false);
    assert.strictEqual(called, false);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
