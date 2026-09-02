/**
 * Restore a MediBook backup into a target database — the scripted half of
 * disaster recovery, so nobody is hand-typing pg_restore during an incident.
 *
 *   node scripts/restore-prod.js --target <postgres-url> --yes [options]
 *
 * Options:
 *   --target <url>     REQUIRED. Where to restore TO. Explicit, never inferred.
 *   --yes             REQUIRED. Without it, prints the plan and exits.
 *   --source <path>   A specific backup file. Default: newest local backup in
 *                     MEDIBOOK_BACKUP_DIR (~/MediBookBackups).
 *   --from-s3         Ignore local files; pull the newest object from the
 *                     configured bucket (BACKUP_S3_*). This is the catastrophe
 *                     path — Railway and the laptop are both gone.
 *   --migrate         After restoring, run src/db/migrate.js against --target
 *                     (brings an older backup up to the current schema).
 *   --clean           Pass --clean --if-exists to pg_restore (custom-format
 *                     dumps only) so a non-empty target is overwritten.
 *   --i-really-mean-prod   Bypass the "target looks like production" guard.
 *
 * Accepts either backup shape:
 *   *.dump[.enc]  — custom format from scripts/backup-prod.js  → pg_restore
 *   *.sql[.enc]   — plain SQL stream from jobs/backupManager.js → psql
 * A .enc file is decrypted to an OS-temp file first (ENCRYPTION_KEY, same as
 * scripts/decryptBackup.js) and that temp file — plaintext PHI for every
 * clinic — is deleted in a finally, pass or fail.
 *
 * Uses a native pg_restore/psql 18+ when present, else a postgres:18-alpine
 * container (same fallback as scripts/backup-prod.js / verify-backup.js).
 */
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { decryptFile } = require('./decryptBackup');
const backupUpload = require('../src/services/backupUpload');

const REPO = path.resolve(__dirname, '..', '..');
const BACKEND = path.resolve(__dirname, '..');
const BACKUP_HOME = process.env.MEDIBOOK_BACKUP_DIR
  || path.join(os.homedir(), 'MediBookBackups');
const IMAGE = 'postgres:18-alpine';
const MIN_MAJOR = 18;
const PROD_HOST_RE = /rlwy\.net|railway\.app|railway\.internal|\.proxy\.rlwy/i;

function die(msg) { console.error(`\n${msg}\n`); process.exit(1); }

function parseArgs(argv) {
  const a = { migrate: false, yes: false, fromS3: false, clean: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--target') a.target = argv[++i];
    else if (k === '--source') a.source = argv[++i];
    else if (k === '--yes') a.yes = true;
    else if (k === '--from-s3') a.fromS3 = true;
    else if (k === '--migrate') a.migrate = true;
    else if (k === '--clean') a.clean = true;
    else if (k === '--i-really-mean-prod') a.force = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else die(`unknown argument: ${k}`);
  }
  return a;
}

function usage() {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
}

/** A native tool (pg_restore / psql) new enough for the server, or null. */
function nativeTool(name) {
  const cands = [];
  if (name === 'pg_restore' && process.env.PG_RESTORE) cands.push(process.env.PG_RESTORE);
  if (name === 'psql' && process.env.PSQL) cands.push(process.env.PSQL);
  cands.push(name);
  for (const base of ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL']) {
    try {
      for (const ver of fs.readdirSync(base).sort((x, y) => Number(y) - Number(x))) {
        cands.push(path.join(base, ver, 'bin', `${name}.exe`));
      }
    } catch { /* not installed there */ }
  }
  for (const exe of cands) {
    try {
      const v = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 15000 });
      const major = Number((v.match(/(\d+)/) || [])[1]);
      if (major >= MIN_MAJOR) return exe;
    } catch { /* not there / too old */ }
  }
  return null;
}

function dockerReady() {
  try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 30000 }); return true; }
  catch { return false; }
}

async function resolveSource(a, tmpDir) {
  if (a.source) {
    if (!fs.existsSync(a.source)) die(`--source not found: ${a.source}`);
    return path.resolve(a.source);
  }
  if (a.fromS3) {
    if (!backupUpload.isConfigured()) die('--from-s3 needs BACKUP_S3_* configured');
    console.log('fetching newest object from the backup bucket...');
    // MUST be awaited here, not returned as a Promise — the caller does string
    // ops (`srcFile.startsWith`) on the result straight away.
    return await backupUpload.downloadLatest(tmpDir); // throws if none / on error
  }
  const local = fs.existsSync(BACKUP_HOME)
    ? fs.readdirSync(BACKUP_HOME)
      .filter(f => /^(medibook-prod-.*\.dump|medibook_backup_.*\.sql)(\.enc)?$/.test(f))
      .map(f => ({ p: path.join(BACKUP_HOME, f), t: fs.statSync(path.join(BACKUP_HOME, f)).mtimeMs }))
      .sort((x, y) => y.t - x.t)
    : [];
  if (!local.length) {
    die(`no backups in ${BACKUP_HOME}. Pass --source <file>, or --from-s3 to pull from the bucket.`);
  }
  return local[0].p;
}

function isCustomFormat(name) {
  return /\.dump(\.enc)?$/.test(name);
}

function restoreNative(exe, custom, target, file, clean) {
  if (custom) {
    const args = ['--no-owner', '--no-acl', '-d', target];
    if (clean) args.push('--clean', '--if-exists');
    args.push(file);
    execFileSync(exe, args, { stdio: 'inherit', timeout: 30 * 60 * 1000 });
  } else {
    execFileSync(exe, ['-v', 'ON_ERROR_STOP=0', '-d', target, '-f', file],
      { stdio: 'inherit', timeout: 30 * 60 * 1000 });
  }
}

function restoreDocker(custom, target, file, clean) {
  // Inside this throwaway container, `localhost` is the container itself, not
  // wherever the target DB is. Rewrite a host-local target and give the
  // container a route to the host (works on Docker Desktop and Engine 20.10+).
  const hostTarget = target.replace(/@(localhost|127\.0\.0\.1)([:/])/, '@host.docker.internal$2');
  const inner = custom
    ? `pg_restore --no-owner --no-acl ${clean ? '--clean --if-exists ' : ''}-d "$T" /tmp/in`
    : `psql -v ON_ERROR_STOP=0 -d "$T" -f /tmp/in`;
  const cid = execFileSync('docker', [
    'run', '-d', '--add-host=host.docker.internal:host-gateway',
    '-e', `T=${hostTarget}`, '--entrypoint', 'sh', IMAGE,
    '-c', 'sleep 900',
  ], { encoding: 'utf8', timeout: 60000 }).trim();
  try {
    execFileSync('docker', ['cp', file, `${cid}:/tmp/in`], { timeout: 300000 });
    execFileSync('docker', ['exec', cid, 'sh', '-c', inner], { stdio: 'inherit', timeout: 30 * 60 * 1000 });
  } finally {
    try { execFileSync('docker', ['rm', '-f', cid], { stdio: 'ignore' }); } catch { /* gone */ }
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) return usage();
  if (!a.target) die('--target <postgres-url> is required. (Use --help.)');

  // ── Guard: never let this be pointed at production by accident ────────────
  if (PROD_HOST_RE.test(a.target) && !a.force) {
    die(`--target looks like a Railway/production host:\n    ${a.target}\n`
      + 'Restoring OVERWRITES it. If that is genuinely what you want, re-run with '
      + '--i-really-mean-prod.');
  }
  try {
    const known = execSync('railway variables --service Postgres --environment production --kv',
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
    const line = known.split(/\r?\n/).find(l => l.startsWith('DATABASE_PUBLIC_URL='));
    if (line) {
      const prodHost = new URL(line.slice(line.indexOf('=') + 1).trim()).host;
      if (a.target.includes(prodHost) && !a.force) {
        die(`--target matches the live production database host (${prodHost}). Refusing.`);
      }
    }
  } catch { /* CLI not available — the regex guard above still stands */ }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medibook-restore-'));
  const cleanup = [];
  try {
    const srcFile = await resolveSource(a, tmpDir);
    if (srcFile.startsWith(tmpDir)) cleanup.push(srcFile);

    let restoreFile = srcFile;
    if (srcFile.endsWith('.enc')) {
      restoreFile = path.join(tmpDir, path.basename(srcFile).replace(/\.enc$/, ''));
      console.log(`decrypting ${path.basename(srcFile)} ...`);
      decryptFile(srcFile, restoreFile);          // throws on wrong key / corruption
      cleanup.push(restoreFile);
    }

    const custom = isCustomFormat(srcFile);
    const size = fs.statSync(restoreFile).size;

    console.log('\n  RESTORE PLAN');
    console.log(`  source : ${srcFile}`);
    console.log(`  format : ${custom ? 'custom  (pg_restore)' : 'plain SQL (psql)'}`);
    console.log(`  size   : ${size.toLocaleString()} bytes`);
    console.log(`  target : ${a.target}`);
    console.log(`  clean  : ${a.clean ? 'yes (--clean --if-exists)' : 'no — target should be empty'}`);
    console.log(`  migrate: ${a.migrate ? 'yes (run migrate.js after)' : 'no'}\n`);

    if (!a.yes) die('Dry run. Re-run with --yes to execute.');

    for (let s = 3; s > 0; s--) { process.stdout.write(`  starting in ${s}...\r`); await sleep(1000); }
    console.log('  starting now       ');

    const exe = nativeTool(custom ? 'pg_restore' : 'psql');
    if (exe) {
      console.log(`restoring via native ${path.basename(exe)} ...`);
      restoreNative(exe, custom, a.target, restoreFile, a.clean);
    } else if (dockerReady()) {
      console.log(`restoring via ${IMAGE} container ...`);
      restoreDocker(custom, a.target, restoreFile, a.clean);
    } else {
      die(`no usable ${custom ? 'pg_restore' : 'psql'} ${MIN_MAJOR}+ and Docker is not running.`);
    }

    if (a.migrate) {
      console.log('\nrunning migrations against the target ...');
      execFileSync('node', ['src/db/migrate.js'], {
        cwd: BACKEND, stdio: 'inherit', timeout: 20 * 60 * 1000,
        env: { ...process.env, DATABASE_URL: a.target },
      });
    }

    console.log('\nRESTORE COMPLETE. Verify: connect and check plans, super_admins, and tenant_ schemas.');
  } finally {
    for (const f of cleanup) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    try { fs.rmdirSync(tmpDir); } catch { /* not empty / gone */ }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => die(`RESTORE FAILED: ${err.message}`));
