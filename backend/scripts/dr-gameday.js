/**
 * Disaster-recovery game-day: rehearse a restore end to end and TIME it, so
 * "RTO: a few hours" stops being a guess.
 *
 *   node scripts/dr-gameday.js                 # newest local backup
 *   node scripts/dr-gameday.js --from-s3       # newest object in the bucket (the real DR path)
 *   node scripts/dr-gameday.js --source <file>
 *   node scripts/dr-gameday.js --keep          # leave the scratch DB up for inspection
 *
 * What it does — nothing touches anything real:
 *   1. starts a throwaway postgres:18-alpine container
 *   2. runs scripts/restore-prod.js against it (--migrate) — exercises the
 *      ACTUAL restore tooling and procedure, not just pg_restore
 *   3. asserts the result is a working MediBook (platform tables, plans, the
 *      super admin, and one schema per tenant row — the silent-corruption check
 *      from verify-backup.js)
 *   4. prints wall-clock elapsed as the measured data-layer RTO
 *   5. removes the container
 *
 * Booting the app itself on the alternate manifest is the next manual step:
 *   docker compose -f docker-compose.prod.yml up     (see docs/railway-recovery-plan.md)
 *
 * Needs Docker. Run it quarterly and record the number.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const { assertMediBook } = require('./lib/assertMediBook');

const BACKEND = path.resolve(__dirname, '..');
const IMAGE = 'postgres:18-alpine';
const NAME = 'medibook-gameday-db';
const PORT = 55432;
const PW = 'gameday';
const URL = `postgresql://postgres:${PW}@localhost:${PORT}/medibook`;

const args = process.argv.slice(2);
const keep = args.includes('--keep');
// Forward source selection to restore-prod.js verbatim.
const passThrough = [];
if (args.includes('--from-s3')) passThrough.push('--from-s3');
const si = args.indexOf('--source');
if (si !== -1 && args[si + 1]) passThrough.push('--source', args[si + 1]);

const d = (a, o = {}) => execFileSync('docker', a, { encoding: 'utf8', timeout: 900000, ...o });
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const step = m => console.log(`\n=== ${m} ===`);

function fmt(ms) {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const t0 = Date.now();
let ok = false;
try {
  try { d(['rm', '-f', NAME], { stdio: 'ignore' }); } catch { /* not running */ }

  step('1/3  starting scratch postgres');
  d(['run', '-d', '--name', NAME, '-p', `${PORT}:5432`,
     '-e', `POSTGRES_PASSWORD=${PW}`, '-e', 'POSTGRES_DB=medibook', IMAGE], { timeout: 120000 });

  let ready = false;
  for (let i = 0; i < 45 && !ready; i++) {
    try {
      d(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'medibook', '-c', 'select 1'],
        { stdio: 'ignore', timeout: 10000 });
      ready = true;
    } catch { sleep(1000); }
  }
  if (!ready) throw new Error('scratch postgres never became ready');

  step('2/3  restoring via scripts/restore-prod.js  (--migrate)');
  const tRestore = Date.now();
  execFileSync('node', ['scripts/restore-prod.js',
    '--target', URL, '--yes', '--migrate', '--clean', ...passThrough], {
    cwd: BACKEND, stdio: 'inherit', timeout: 40 * 60 * 1000,
  });
  const restoreMs = Date.now() - tRestore;

  step('3/3  asserting a working MediBook');
  const q = sql => d(['exec', NAME, 'psql', '-t', '-A', '-U', 'postgres', '-d', 'medibook', '-c', sql]).trim();
  const asserted = assertMediBook(q);
  asserted.lines.forEach(l => console.log(l));
  ok = asserted.ok;

  const total = Date.now() - t0;
  console.log('\n' + '-'.repeat(60));
  console.log(`  restore + migrate : ${fmt(restoreMs)}`);
  console.log(`  full rehearsal    : ${fmt(total)}   <- measured data-layer RTO`);
  console.log(`  result            : ${ok ? 'PASS - this backup restores to a working MediBook' : 'FAIL - see failed checks above'}`);
  console.log('-'.repeat(60));
  console.log('  Next manual step: boot the app on the alternate host —');
  console.log('    docker compose -f docker-compose.prod.yml up   (docs/railway-recovery-plan.md)');
} catch (err) {
  console.error(`\nGAME-DAY FAILED: ${err.message}`);
} finally {
  if (keep) {
    console.log(`\nscratch DB left running: ${URL}\n  tear down with:  docker rm -f ${NAME}`);
  } else {
    try { d(['rm', '-f', NAME], { stdio: 'ignore' }); } catch { /* gone */ }
  }
}
process.exit(ok ? 0 : 1);
