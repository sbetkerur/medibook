/**
 * Snapshot every Railway variable to one file, for the offline vault.
 *
 *   node scripts/dump-env.js
 *
 * scripts/backup-prod.js and scripts/decryptBackup.js both read ENCRYPTION_KEY
 * and the DB URL *through the Railway CLI* — which is exactly what you do NOT
 * have if the Railway account is gone. Recovery then starts with whatever you
 * saved independently. This writes that: all vars for every service and
 * environment into
 *
 *   ~/MediBookBackups/railway-env-snapshot-<timestamp>.txt
 *
 * WHICH IS SECRETS IN PLAINTEXT. Move the contents into a password manager and
 * DELETE the file. It is written outside the repo and matched by .gitignore, but
 * it should not linger on disk regardless.
 *
 * Also asserts ENCRYPTION_KEY and JWT_SECRET are present for backend/production
 * — losing ENCRYPTION_KEY makes every backup permanently unreadable, so a
 * snapshot that silently missed it would be worse than none.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..');
const OUT_DIR = process.env.MEDIBOOK_BACKUP_DIR || path.join(os.homedir(), 'MediBookBackups');

// (service, environment) pairs to capture. Postgres/Redis carry the connection
// strings; backend/frontend carry app config and every secret.
const TARGETS = [
  ['backend', 'production'],
  ['frontend', 'production'],
  ['Postgres', 'production'],
  ['Redis', 'production'],
  ['backend', 'dev'],
  ['frontend', 'dev'],
  ['Postgres', 'dev'],
  ['Redis', 'dev'],
];

const REQUIRED_IN = { 'backend/production': ['ENCRYPTION_KEY', 'JWT_SECRET'] };

function fetchKv(service, environment) {
  try {
    const out = execFileSync('railway',
      ['variables', '--service', service, '--environment', environment, '--kv'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    return { ok: true, lines: out.split(/\r?\n/).filter(l => l.includes('=')) };
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message || err).trim() };
  }
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(OUT_DIR, `railway-env-snapshot-${stamp}.txt`);

  const chunks = [
    '# MediBook — Railway variable snapshot',
    `# taken ${new Date().toISOString()}`,
    '#',
    '# SECRETS IN PLAINTEXT. Put these in a password manager, then DELETE this file.',
    '# Recovery of an offline account starts here — see docs/railway-recovery-plan.md.',
    '',
  ];

  const missing = [];
  let anyOk = false;

  for (const [service, environment] of TARGETS) {
    const key = `${service}/${environment}`;
    const res = fetchKv(service, environment);
    chunks.push('='.repeat(64), `# ${key}`, '='.repeat(64));
    if (!res.ok) {
      chunks.push(`# (could not read: ${res.error})`, '');
      continue;
    }
    anyOk = true;
    chunks.push(...res.lines, '');

    const need = REQUIRED_IN[key] || [];
    const present = new Set(res.lines.map(l => l.slice(0, l.indexOf('=')).trim()));
    for (const varName of need) {
      if (!present.has(varName)) missing.push(`${key}:${varName}`);
    }
  }

  if (!anyOk) {
    console.error('Could not read ANY Railway variables. Run `railway login`, then retry.');
    process.exit(1);
  }

  fs.writeFileSync(outPath, chunks.join('\n'), { mode: 0o600 });
  try { fs.chmodSync(outPath, 0o600); } catch { /* Windows */ }

  console.log(`\nWrote ${outPath}`);
  console.log('  -> move into a password manager, then delete this file.\n');

  if (missing.length) {
    console.error(`WARNING: expected variables not found: ${missing.join(', ')}`);
    console.error('  Verify the service/environment names and that the vars are actually set.');
    process.exit(1);
  }
  console.log('ENCRYPTION_KEY and JWT_SECRET confirmed present for backend/production.');
}

main();
