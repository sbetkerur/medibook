'use strict';
/**
 * Assert a freshly-restored database actually contains a working MediBook:
 * platform tables, the plans, the super admin, the migration history, and ONE
 * tenant schema per tenant that is supposed to have one.
 *
 * Shared by scripts/verify-backup.js and scripts/dr-gameday.js so the
 * "did the restore silently drop something" check is defined once — an earlier
 * copy-paste had the two drift, and both carried a tenant/schema check that
 * false-failed on pending signups.
 *
 * @param {(sql: string) => string} q  runs one SQL statement, returns the
 *   trimmed scalar result (psql -t -A). Caller owns how that reaches Postgres.
 * @returns {{ ok: boolean, lines: string[] }}  lines are ready to print as-is.
 */
function assertMediBook(q) {
  const num = (sql) => Number(q(sql));
  const lines = [];
  let failed = 0;

  const checks = [
    ['platform tables', num(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`), (n) => n > 20],
    ['plans',           num(`SELECT count(*) FROM plans`),            (n) => n >= 2],
    ['super admins',    num(`SELECT count(*) FROM super_admins`),     (n) => n >= 1],
    ['migrations',      num(`SELECT count(*) FROM schema_migrations`), (n) => n > 15],
    ['tenants',         num(`SELECT count(*) FROM tenants`),          () => true],
    ['tenant schemas',  num(`SELECT count(*) FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'`), () => true],
  ];
  for (const [label, value, pass] of checks) {
    const good = pass(value);
    if (!good) failed++;
    lines.push(`  ${good ? '✓' : '✗'} ${label}: ${value}`);
  }

  // Every tenant that is SUPPOSED to have a schema must have one, or a restore
  // dropped clinics without dropping their rows — the exact silent corruption
  // this check exists for. `pending_review` / `pending_payment` tenants
  // deliberately have a `tenants` row and no schema yet (see CLAUDE.md), so a
  // backup taken while a signup is in the review queue would otherwise fail a
  // perfectly good restore.
  const expectingSchema = num(
    `SELECT count(*) FROM tenants WHERE status NOT IN ('pending_review','pending_payment')`);
  const schemas = num(
    `SELECT count(*) FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'`);
  if (expectingSchema !== schemas) {
    failed++;
    lines.push(`  ✗ MISMATCH: ${expectingSchema} tenant(s) expecting a schema but ${schemas} schema(s)`);
  } else {
    lines.push(`  ✓ tenant rows and schemas agree (${schemas})`);
  }

  return { ok: failed === 0, lines };
}

module.exports = { assertMediBook };
