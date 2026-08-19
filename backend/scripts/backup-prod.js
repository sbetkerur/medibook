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
 * Writes  <BACKUP_HOME>/medibook-prod-YYYY-MM-DDTHH-MM-SS.dump  (custom format,
 * so pg_restore -j can be used) and keeps the most recent KEEP files.
 *
 * WHICH pg_dump: production runs Postgres 18 and a client older than the server
 * refuses to dump at all. A native pg_dump of version 18+ is used when one is on
 * PATH; otherwise the work happens inside postgres:18-alpine, which means Docker
 * Desktop has to be running. Installing the PostgreSQL 18 client tools removes
 * that dependency and makes this work headless.
 */
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

/** A native pg_dump new enough for the server, or null. */
function nativeDump() {
  try {
    const v = execFileSync('pg_dump', ['--version'], { encoding: 'utf8', timeout: 15000 });
    const major = Number((v.match(/(\d+)/) || [])[1]);
    return major >= MIN_SERVER_MAJOR ? major : null;
  } catch { return null; }
}

function dockerReady() {
  try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 30000 }); return true; }
  catch { return false; }
}

function dumpNative(url, target) {
  execFileSync('pg_dump', ['-Fc', '--no-owner', '--no-acl', '-d', url, '-f', target],
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

function main() {
  fs.mkdirSync(BACKUP_HOME, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `medibook-prod-${stamp}.dump`;
  const target = path.join(BACKUP_HOME, name);

  const native = nativeDump();
  const useDocker = !native;
  if (useDocker && !dockerReady()) {
    throw new Error(
      'no usable pg_dump: Docker Desktop is not running, and no native pg_dump '
      + `${MIN_SERVER_MAJOR}+ is on PATH. Start Docker Desktop, or install the `
      + 'PostgreSQL 18 client tools to make this work without Docker.');
  }
  log(`starting backup -> ${name}  (via ${native ? `native pg_dump ${native}` : 'docker ' + IMAGE})`);

  const url = prodUrl();
  if (native) dumpNative(url, target); else dumpDocker(url, target);

  const size = fs.statSync(target).size;
  // A custom-format dump of an empty-but-migrated database is still tens of KB.
  // Anything tiny means the dump aborted and wrote a stub — fail loudly rather
  // than quietly keeping a useless file and pruning a good one.
  if (size < 5000) {
    try { fs.unlinkSync(target); } catch { /* leave it */ }
    throw new Error(`backup suspiciously small (${size} bytes) — discarded and treated as failed`);
  }
  log(`wrote ${name} (${size.toLocaleString()} bytes)`);

  const files = fs.readdirSync(BACKUP_HOME)
    .filter(f => /^medibook-prod-.*\.dump$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(BACKUP_HOME, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  let pruned = 0;
  for (const old of files.slice(KEEP)) {
    fs.unlinkSync(path.join(BACKUP_HOME, old.f));
    pruned++;
  }
  log(`retention: ${Math.min(files.length, KEEP)} kept, ${pruned} pruned`);
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
