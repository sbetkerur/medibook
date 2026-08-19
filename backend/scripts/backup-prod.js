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
 * pg_dump runs inside postgres:18-alpine because production is Postgres 18 and a
 * client older than the server refuses to dump at all.
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

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `${ts}  ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(BACKUP_HOME, 'backup.log'), line + '\n'); } catch { /* pre-mkdir */ }
}

function prodUrl() {
  const out = execSync(
    'railway variables --service Postgres --environment production --kv',
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 });
  const line = out.split(/\r?\n/).find(l => l.startsWith('DATABASE_PUBLIC_URL='));
  if (!line) throw new Error('DATABASE_PUBLIC_URL not found — is the Railway CLI still logged in?');
  return line.slice(line.indexOf('=') + 1).trim();
}

(function main() {
  fs.mkdirSync(BACKUP_HOME, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `medibook-prod-${stamp}.dump`;
  const target = path.join(BACKUP_HOME, name);

  log(`starting backup -> ${target}`);

  const url = prodUrl();

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

  const size = fs.statSync(target).size;
  // A custom-format dump of an empty-but-migrated database is still tens of KB.
  // Anything tiny means the dump aborted and wrote a stub — fail loudly rather
  // than quietly keeping a useless file and pruning a good one.
  if (size < 5000) throw new Error(`backup suspiciously small (${size} bytes) — treating as failed`);
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
})();
