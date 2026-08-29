/**
 * Pull a production backup to this machine.
 *
 * The nightly pg_dump the backend already runs writes to a Railway volume
 * attached to the same project as the database it protects — so it survives a
 * bad migration, but not the loss of the project, the account or the billing.
 * This is the off-Railway copy, and it deliberately needs no new credentials:
 * it reuses the Postgres connection string the Railway CLI already has.
 *
 *   node scripts/backup-prod.js
 *
 * Writes  <BACKUP_HOME>/medibook-prod-YYYY-MM-DDTHH-MM-SS.dump.enc  and keeps
 * the most recent KEEP files. ENCRYPTED — this is a full copy of every
 * clinic's data (including patients' health records) sitting on a personal
 * machine rather than a server, which is a softer target than Railway's own
 * infrastructure, not a safer one. Same AES-256-GCM/ENCRYPTION_KEY scheme as
 * jobs/backupManager.js's in-container backup — fetched via the Railway CLI
 * (scripts/decryptBackup.js's getEncryptionKey), the same way this script
 * already fetches DATABASE_PUBLIC_URL, so nothing new to configure by hand.
 * Decrypt with `node scripts/decryptBackup.js <file>` before pg_restore.
 *
 * WHICH pg_dump: production runs Postgres 18 and a client older than the server
 * refuses to dump at all. A native pg_dump 18+ is used when one can be found —
 * which is the normal path, since the PostgreSQL 18 client tools are installed
 * on this machine. Docker is only the fallback for a machine without them, and
 * is never needed for a routine backup. (Restoring still uses a container: see
 * verify-backup.js, which needs a throwaway server to restore INTO.)
 */
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { getEncryptionKey } = require('./decryptBackup');

const REPO = path.resolve(__dirname, '..', '..');
const BACKUP_HOME = process.env.MEDIBOOK_BACKUP_DIR
  || path.join(os.homedir(), 'MediBookBackups');
const KEEP = Number(process.env.MEDIBOOK_BACKUP_KEEP || 14);
const IMAGE = 'postgres:18-alpine';
const MIN_SERVER_MAJOR = 18;

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `${ts}  ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(BACKUP_HOME, { recursive: true });
    fs.appendFileSync(path.join(BACKUP_HOME, 'backup.log'), line + '\n');
  } catch { /* nothing we can do — stdout already has it */ }
}

function prodUrl() {
  const out = execSync(
    'railway variables --service Postgres --environment production --kv',
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 });
  const line = out.split(/\r?\n/).find(l => l.startsWith('DATABASE_PUBLIC_URL='));
  if (!line) throw new Error('DATABASE_PUBLIC_URL not found — is the Railway CLI still logged in? Run: railway login');
  return line.slice(line.indexOf('=') + 1).trim();
}

/**
 * Locate a native pg_dump new enough for the server: {exe, major} or null.
 *
 * Deliberately does NOT rely on PATH alone. The Windows PostgreSQL installer
 * does not add itself to PATH, and a scheduled task runs with a different
 * environment from an interactive shell — so "it works in my terminal" is not
 * evidence the nightly job will find it. Well-known install locations are
 * probed directly, and PG_DUMP override wins over everything.
 */
function nativeDump() {
  const candidates = [];
  if (process.env.PG_DUMP) candidates.push(process.env.PG_DUMP);
  candidates.push('pg_dump');                       // PATH, if it happens to be there
  for (const base of ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL']) {
    try {
      for (const ver of fs.readdirSync(base).sort((a, b) => Number(b) - Number(a))) {
        candidates.push(path.join(base, ver, 'bin', 'pg_dump.exe'));
      }
    } catch { /* not installed there */ }
  }
  for (const exe of candidates) {
    try {
      const v = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 15000 });
      const major = Number((v.match(/(\d+)/) || [])[1]);
      if (major >= MIN_SERVER_MAJOR) return { exe, major };
    } catch { /* not there, or too old */ }
  }
  return null;
}

function dockerReady() {
  try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 30000 }); return true; }
  catch { return false; }
}

function dumpNative(exe, url, target) {
  execFileSync(exe, ['-Fc', '--no-owner', '--no-acl', '-d', url, '-f', target],
    { timeout: 900000, stdio: ['ignore', 'ignore', 'pipe'] });
}

function dumpDocker(url, target) {
  // Dump inside the container, then copy the file out. Writing straight to a
  // bind mount would be simpler, but Docker Desktop's path translation on
  // Windows has bitten this project before, and a silently empty file is the
  // worst possible outcome for a backup.
  const cid = execFileSync('docker', [
    'run', '-d', '-e', `PGCONN=${url}`, IMAGE,
    'sh', '-c', 'pg_dump -Fc --no-owner --no-acl -d "$PGCONN" -f /tmp/out.dump && echo DUMP_OK',
  ], { encoding: 'utf8', timeout: 120000 }).trim();
  try {
    const code = execFileSync('docker', ['wait', cid], { encoding: 'utf8', timeout: 900000 }).trim();
    const logs = execFileSync('docker', ['logs', cid], { encoding: 'utf8' });
    if (code !== '0' || !logs.includes('DUMP_OK')) {
      throw new Error(`pg_dump failed (exit ${code}): ${logs.trim().slice(0, 300)}`);
    }
    execFileSync('docker', ['cp', `${cid}:/tmp/out.dump`, target], { timeout: 300000 });
  } finally {
    try { execFileSync('docker', ['rm', '-f', cid], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
}

/**
 * Encrypt `plainPath` to `encPath` (AES-256-GCM, same [iv][ciphertext][tag]
 * format as jobs/backupManager.js and scripts/decryptBackup.js), then delete
 * the plaintext. Whole-file rather than streamed, unlike the in-container
 * backup: pg_dump here already writes a complete file to disk before this
 * runs (native and Docker both do), so there is no stdout stream to intercept
 * without restructuring how pg_dump is invoked — and that restructuring is
 * exactly the kind of change that's risky to make without a live Railway
 * connection to test it against. The cost is a brief window where the
 * plaintext dump sits on disk before this deletes it; acceptable for a
 * routine, human-run backup, not for the unattended nightly one.
 */
function encryptFileInPlace(plainPath, encPath, keyBuffer) {
  const data = fs.readFileSync(plainPath);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(encPath, Buffer.concat([iv, ciphertext, tag]));
  fs.unlinkSync(plainPath);
}

function main() {
  fs.mkdirSync(BACKUP_HOME, { recursive: true });

  // Fetched FIRST and fails fast — no point running a multi-minute pg_dump
  // only to discover at the end there's nothing to encrypt it with.
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || getEncryptionKey();
  const { getKeyBuffer } = require('../src/utils/encryption');
  const keyBuffer = getKeyBuffer();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const plainName = `medibook-prod-${stamp}.dump`;
  const encName = `${plainName}.enc`;
  const plainTarget = path.join(BACKUP_HOME, plainName);
  const encTarget = path.join(BACKUP_HOME, encName);

  const native = nativeDump();
  const useDocker = !native;
  if (useDocker && !dockerReady()) {
    throw new Error(
      'no usable pg_dump: Docker Desktop is not running, and no native pg_dump '
      + `${MIN_SERVER_MAJOR}+ is on PATH. Start Docker Desktop, or install the `
      + 'PostgreSQL 18 client tools to make this work without Docker.');
  }
  log(`starting backup -> ${encName}  (via ${native ? `pg_dump ${native.major}` : 'docker ' + IMAGE})`);

  const url = prodUrl();
  if (native) dumpNative(native.exe, url, plainTarget); else dumpDocker(url, plainTarget);

  // A custom-format dump of an empty-but-migrated database is still tens of KB.
  // Anything tiny means the dump aborted and wrote a stub — fail loudly rather
  // than quietly keeping a useless file and pruning a good one. Checked on the
  // PLAINTEXT file, before encryption ever touches it.
  const plainSize = fs.statSync(plainTarget).size;
  if (plainSize < 5000) {
    try { fs.unlinkSync(plainTarget); } catch { /* leave it */ }
    throw new Error(`backup suspiciously small (${plainSize} bytes) — discarded and treated as failed`);
  }

  encryptFileInPlace(plainTarget, encTarget, keyBuffer);
  const size = fs.statSync(encTarget).size;
  log(`wrote ${encName} (${size.toLocaleString()} bytes)`);

  const files = fs.readdirSync(BACKUP_HOME)
    .filter(f => /^medibook-prod-.*\.dump\.enc$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(BACKUP_HOME, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  let pruned = 0;
  for (const old of files.slice(KEEP)) {
    fs.unlinkSync(path.join(BACKUP_HOME, old.f));
    pruned++;
  }
  log(`retention: ${Math.min(files.length, KEEP)} kept, ${pruned} pruned`);

  // Retention only matches `.dump.enc` now. Any plaintext `.dump` left over from
  // before encryption existed is the exact PHI exposure this change removes — it
  // will never be pruned and is not auto-deleted here (the operator may want to
  // encrypt it first). Say so loudly so it doesn't sit forgotten.
  const legacyPlain = fs.readdirSync(BACKUP_HOME)
    .filter(f => /^medibook-prod-.*\.dump$/.test(f));
  if (legacyPlain.length) {
    log(`WARNING: ${legacyPlain.length} UNENCRYPTED legacy dump(s) still in ${BACKUP_HOME} ` +
        `(${legacyPlain.join(', ')}) — each is a full plaintext copy of every clinic's data. ` +
        `Encrypt or delete them.`);
  }

  log('backup OK');
}

// A backup that fails silently is worse than no backup, because it is believed.
// Every failure lands in backup.log next to the successes, so one file answers
// "when did this last actually work".
try {
  main();
} catch (err) {
  log(`BACKUP FAILED: ${err.message}`);
  process.exit(1);
}
