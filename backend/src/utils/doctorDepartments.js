const { UUID_RE } = require('./errors');

// A doctor's bookable department set. Kept small on purpose — a dental branch has
// a handful of treatment categories, and an unbounded array here would let one
// PATCH write thousands of join rows.
const MAX_DEPARTMENTS_PER_DOCTOR = 25;

/**
 * Normalise the department set for a doctor.
 *
 * The doctor's PRIMARY department (doctors.department_id) is always part of the
 * bookable set and always first — the invariant every read depends on. Without
 * it, a doctor could be listed under "Orthodontics" while their receipts and
 * analytics rows (which still join on department_id) said "General Dentistry",
 * and the boot-time backfill in tenantMigrate.js would keep re-adding the
 * primary behind the admin's back.
 *
 * Pure: no DB access, so the ordering/dedup rules are unit-testable.
 *
 * @returns {{ids: string[], invalid: string[], tooMany: boolean}}
 *   `ids` lower-cased and deduped, primary first. `invalid` collects anything
 *   that isn't a UUID so the caller can 400 rather than letting Postgres throw.
 */
function normalizeDepartmentIds(primaryId, departmentIds) {
  const raw = [];
  if (primaryId !== undefined && primaryId !== null) raw.push(primaryId);
  if (Array.isArray(departmentIds)) raw.push(...departmentIds);

  const ids = [];
  const invalid = [];
  for (const value of raw) {
    // '' and null are how the dashboard sends "no department" — not an error.
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string') { invalid.push(value); continue; }
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!UUID_RE.test(trimmed)) { invalid.push(trimmed); continue; }
    const id = trimmed.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, invalid, tooMany: ids.length > MAX_DEPARTMENTS_PER_DOCTOR };
}

/**
 * Replace a doctor's bookable department set. Must run inside a transaction that
 * also writes doctors.department_id, or a failure between the two leaves the
 * primary out of the set.
 */
async function syncDoctorDepartments(client, doctorId, ids) {
  await client.query(
    `DELETE FROM doctor_departments WHERE doctor_id=$1 AND NOT (department_id = ANY($2::uuid[]))`,
    [doctorId, ids]);
  if (ids.length) {
    await client.query(
      `INSERT INTO doctor_departments (doctor_id, department_id)
       SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
      [doctorId, ids]);
  }
}

module.exports = { normalizeDepartmentIds, syncDoctorDepartments, MAX_DEPARTMENTS_PER_DOCTOR };
