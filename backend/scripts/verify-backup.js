/**
 * Restore a backup into a throwaway database and check it actually contains a
 * working MediBook.
 *
 *   node scripts/verify-backup.js            # newest backup
 *   node scripts/verify-backup.js <path>     # a specific one
 *
 * An untested backup is a hypothesis. This session already showed why: a restore
 * reported success twice while silently producing a corrupt result. So the check
 * is not "did pg_restore exit 0" but "are the platform tables, the plans, the
 * super admin and every tenant schema present afterwards".
 *
 * scripts/backup-prod.js now writes `.dump.enc` (AES-256-GCM) instead of a
 * plain `.dump` — this decrypts to a local temp file first (deleted when done,
 * success or failure) and restores THAT, same as always otherwise. A `.dump`
 * from before that change is still accepted as-is, unencrypted.
 *
 * Touches nothing real — it starts its own postgres:18-alpine container, restores
 * into that, and removes it again.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { decryptFile } = require('./decryptBackup');

const BACKUP_HOME = process.env.MEDIBOOK_BACKUP_DIR
  || path.join(os.homedir(), 'MediBookBackups');
const IMAGE = 'postgres:18-alpine';
const NAME = 'medibook-verify-restore';
const DB = 'postgresql://postgres:verify@localhost/verify';

const d = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 900000, ...opts });

function newest() {
  const files = fs.readdirSync(BACKUP_HOME)
    .filter(f => /^medibook-prod-.*\.dump(\.enc)?$/.test(f))
    .map(f => ({ p: path.join(BACKUP_HOME, f), t: fs.statSync(path.join(BACKUP_HOME, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error(`no backups found in ${BACKUP_HOME}`);
  return files[0].p;
}

(function main() {
  let file = process.argv[2] || newest();
  let decryptedTemp = null;
  if (file.endsWith('.enc')) {
    decryptedTemp = path.join(os.tmpdir(), `medibook-verify-${Date.now()}.dump`);
    console.log(`decrypting ${path.basename(file)}...`);
    decryptFile(file, decryptedTemp);
    file = decryptedTemp;
  }
  const size = fs.statSync(file).size;
  console.log(`verifying ${path.basename(process.argv[2] || file)} (${size.toLocaleString()} bytes)`);

  try { d(['rm', '-f', NAME], { stdio: 'ignore' }); } catch { /* not running */ }

  d(['run', '-d', '--name', NAME,
     '-e', 'POSTGRES_PASSWORD=verify', '-e', 'POSTGRES_DB=verify', IMAGE], { timeout: 120000 });

  try {
    // pg_isready reports success while the server is still in startup, so the
    // probe is an actual query. And the loop needs a real pause between tries —
    // without one it burns every attempt in milliseconds and gives up before
    // Postgres has finished initialising its data directory.
    const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      try {
        d(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'verify', '-c', 'select 1'],
          { stdio: 'ignore', timeout: 10000 });
        ready = true;
      } catch { sleep(1000); }
    }
    if (!ready) throw new Error('scratch postgres never became ready');

    d(['cp', file, `${NAME}:/tmp/verify.dump`], { timeout: 300000 });
    // pg_restore continues past errors by default; the assertions below are the
    // real gate, not its exit code.
    try {
      d(['exec', NAME, 'pg_restore', '--no-owner', '--no-acl', '-d', DB, '/tmp/verify.dump']);
    } catch (e) {
      console.log('  (pg_restore reported issues — checking contents anyway)');
    }

    const q = sql => d(['exec', NAME, 'psql', '-t', '-A', '-U', 'postgres', '-d', 'verify', '-c', sql]).trim();

    const checks = [
      ['platform tables', Number(q(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`)), n => n > 20],
      ['plans',           Number(q(`SELECT count(*) FROM plans`)),            n => n >= 2],
      ['super admins',    Number(q(`SELECT count(*) FROM super_admins`)),     n => n >= 1],
      ['migrations',      Number(q(`SELECT count(*) FROM schema_migrations`)), n => n > 15],
      ['tenants',         Number(q(`SELECT count(*) FROM tenants`)),          () => true],
      ['tenant schemas',  Number(q(`SELECT count(*) FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'`)), () => true],
    ];

    let failed = 0;
    for (const [label, value, pass] of checks) {
      const good = pass(value);
      if (!good) failed++;
      console.log(`  ${good ? '✓' : '✗'} ${label}: ${value}`);
    }

    // Tenant count and schema count must agree, or a restore dropped clinics
    // without dropping their rows — the exact silent corruption seen earlier.
    const tenants = checks[4][1], schemas = checks[5][1];
    if (tenants !== schemas) {
      failed++;
      console.log(`  ✗ MISMATCH: ${tenants} tenant rows but ${schemas} schemas`);
    } else {
      console.log(`  ✓ tenant rows and schemas agree (${tenants})`);
    }

    console.log(failed ? '\nBACKUP VERIFICATION FAILED' : '\nBACKUP VERIFIED — this file restores to a working MediBook');
    process.exitCode = failed ? 1 : 0;
  } finally {
    try { d(['rm', '-f', NAME], { stdio: 'ignore' }); } catch { /* gone */ }
    // The decrypted copy is plaintext PHI for every clinic — clean it up
    // whether verification passed or failed, not just on the happy path.
    if (decryptedTemp) { try { fs.unlinkSync(decryptedTemp); } catch { /* already gone */ } }
  }
})();
