'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { tenantQuery } = require('../db');
const { validateUUID, handleError, UUID_RE } = require('../utils/errors');
const { encryptJSON, decryptJSON } = require('../utils/encryption');
const { adminOnly, writeAuditLog } = require('./adminHelpers');

const { IST_TODAY_SQL } = require('../utils/dateTz');
const logger = require('../utils/logger');

// Auth + tenant middleware applied once in index.js for /api/admin and /api/v1/admin

// Populate tenantId on this request's AsyncLocalStorage context — see the
// matching comment in routes/appointments.js for why this lives per-route-file
// rather than once in index.js's request-context setup.
router.use((req, res, next) => {
  // (tenantId is stamped centrally by tenantMiddleware — see middleware/auth.js)
  next();
});

const patientLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

// ── LIST PATIENTS ─────────────────────────────────────────────
router.get('/patients', patientLimiter, async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const safePage = Math.max(parseInt(page) || 1, 1);
    const s = req.tenant.schema_name;
    let where = '';
    let params = [];
    if (search) {
      if (search.length > 100) return res.status(400).json({ error: 'search too long' });
      const escapedSearch = search.replace(/[%_\\]/g, '\\$&');
      params.push(`%${escapedSearch}%`);
      where = ` WHERE deleted_at IS NULL AND (name ILIKE $1 OR phone LIKE $1 OR email ILIKE $1)`;
    }
    else { where = ` WHERE deleted_at IS NULL`; }
    const countParams = [...params];
    params.push(25, (safePage - 1) * 25);
    const [r, countR] = await Promise.all([
      tenantQuery(s,
        `SELECT id, name, phone, email, gender, date_of_birth, visit_count, referral_source, created_at FROM patients${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params),
      tenantQuery(s, `SELECT COUNT(*) FROM patients${where}`, countParams),
    ]);
    const total = parseInt(countR.rows[0]?.count || 0);
    res.json({ patients: r.rows, total, page: safePage, limit: 25, has_more: (safePage - 1) * 25 + r.rows.length < total });
  } catch (err) { handleError(res, err); }
});

// ── GET PATIENT ───────────────────────────────────────────────
router.get('/patients/:id', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT id, name, phone, email, gender, date_of_birth, visit_count, referral_source, dental_history, created_at, updated_at FROM patients WHERE id=$1 AND deleted_at IS NULL`,
      [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    const patient = r.rows[0];
    // dental_history is encrypted at rest (utils/encryption.js encryptJSON) —
    // decrypt() returning null means the ciphertext exists but could not be
    // read back (wrong/rotated key, corrupted row), which must never be
    // silently shown as "no history."
    const medical_history = decryptJSON(patient.dental_history);
    delete patient.dental_history;
    if (medical_history === null) {
      logger.warn('dental_history decryption failed', { patient: req.params.id });
      return res.json({ patient: { ...patient, medical_history: null, medical_history_error: true } });
    }
    res.json({ patient: { ...patient, medical_history } });
  } catch (err) { handleError(res, err); }
});

// ── PATIENT APPOINTMENTS ──────────────────────────────────────
router.get('/patients/:id/appointments', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name, `
      SELECT a.*, d.name as doctor_name FROM appointments a
      JOIN doctors d ON d.id=a.doctor_id
      WHERE a.patient_id=$1 ORDER BY a.appointment_date DESC LIMIT 20
    `, [req.params.id]);
    res.json({ appointments: r.rows });
  } catch (err) { handleError(res, err); }
});

// ── UPDATE PATIENT ────────────────────────────────────────────
router.patch('/patients/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { name, email, gender, date_of_birth, referral_source } = req.body;
    const s = req.tenant.schema_name;
    // Which board, referral or listing actually brought them in. Set at the
    // DESK, not asked in the bot: the booking flow is long enough already, and
    // the receptionist knows the answer better than the patient does.
    const REFERRAL_SOURCES = ['walk_past', 'google', 'friend', 'doctor_referral', 'social', 'returning', 'other'];
    if (referral_source && !REFERRAL_SOURCES.includes(referral_source)) {
      return res.status(400).json({ error: `referral_source must be one of: ${REFERRAL_SOURCES.join(', ')}` });
    }
    const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (date_of_birth && !DOB_RE.test(date_of_birth)) return res.status(400).json({ error: 'date_of_birth must be YYYY-MM-DD' });
    const VALID_GENDERS = ['male', 'female', 'other'];
    if (gender && !VALID_GENDERS.includes(gender.toLowerCase())) {
      return res.status(400).json({ error: `gender must be one of: ${VALID_GENDERS.join(', ')}` });
    }
    const r = await tenantQuery(s, `
      UPDATE patients SET
        name=COALESCE($1,name), email=COALESCE($2,email),
        gender=COALESCE($3,gender), date_of_birth=COALESCE($4::date,date_of_birth),
        referral_source=COALESCE($6,referral_source), updated_at=NOW()
      WHERE id=$5 AND deleted_at IS NULL
      RETURNING id, name, phone, email, gender, date_of_birth, visit_count, referral_source
    `, [name || null, email || null, gender || null, date_of_birth || null, req.params.id,
        referral_source || null]);
    // deleted_at IS NULL, matching every other read in this file. Without it a
    // PATCH wrote name/email/DOB/gender straight back onto a row that DELETE
    // /patients/:id had anonymised — the record stayed hidden from the list
    // (deleted_at is still set) while carrying live PII again, which is the
    // worst of both states for something the clinic has attested is erased.
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_PATIENT', 'patient', req.params.id,
      null, { name, email, gender }, req.ip);
    res.json({ patient: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

// ── DELETE PATIENT (anonymise) ────────────────────────────────
router.delete('/patients/:id', adminOnly, validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const upcoming = await tenantQuery(s,
      `SELECT COUNT(*) FROM appointments WHERE patient_id=$1 AND status='confirmed' AND appointment_date >= ${IST_TODAY_SQL}`,
      [req.params.id]);
    if (parseInt(upcoming.rows[0].count) > 0) {
      return res.status(409).json({
        error: `Cannot delete patient — ${upcoming.rows[0].count} upcoming appointment(s) exist.`,
        upcoming_appointments: parseInt(upcoming.rows[0].count),
      });
    }
    // Scrub the phone too — it's the primary identifier, so keeping it made
    // "anonymised" records trivially re-identifiable. Replacement must satisfy
    // the phone CHECK (^[0-9]{7,20}$); the '000' prefix can't collide with a
    // real number (stored numbers never start with 0).
    // dental_history reset to a plain empty object rather than an encrypted
    // one — decryptJSON() already treats a row with no `_enc` key as legacy
    // plaintext, and there's nothing to protect in `{}` either way.
    const r = await tenantQuery(s, `
      UPDATE patients SET
        name='[Deleted]', email=NULL, date_of_birth=NULL, gender=NULL,
        phone='000' || lpad(floor(random() * 1e15)::bigint::text, 15, '0'),
        dental_history='{}', deleted_at=NOW(), opted_out=true, updated_at=NOW()
      WHERE id=$1 RETURNING id
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });

    // Free-text clinical notes about this person live outside the patients row
    // too — treatment plans carry a diagnosis and what was explained at the
    // chair, and can name relatives. Scrubbed for the same reason
    // dental_history is above. The structural record (what treatment, how many
    // sittings, what was paid) is deliberately KEPT: it is the clinic's medical
    // and financial record, which they are required to retain, and it no longer
    // identifies anyone once the patient row is anonymised.
    await tenantQuery(s,
      `UPDATE treatment_plans SET notes=NULL, updated_at=NOW() WHERE patient_id=$1 AND notes IS NOT NULL`,
      [req.params.id]).catch(err =>
        logger.warn('Treatment plan notes scrub failed during anonymisation',
          { patient: req.params.id, error: err.message }));
    await tenantQuery(s,
      `UPDATE lab_works SET notes=NULL, updated_at=NOW() WHERE patient_id=$1 AND notes IS NOT NULL`,
      [req.params.id]).catch(() => {});

    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_PATIENT', 'patient', req.params.id, null, null, req.ip);
    res.json({ success: true, message: 'Patient record anonymised (GDPR)' });
  } catch (err) { handleError(res, err); }
});

// ── MEDICAL HISTORY ───────────────────────────────────────────
// Deliberately NOT adminOnly, unlike the PATCH below. Two reasons:
//   1. `adminOnly` excludes the 'doctor' role, and blood type / allergies /
//      current medications are precisely what a dentist and a front-desk
//      check-in need to see. Hiding them from clinicians is a patient-safety
//      problem, not a privacy win.
//   2. It would be theatre anyway — GET /patients/:id and
//      GET /appointments/:id both return the same dental_history blob to every
//      role. Locking one of three doors protects nothing.
// What we DO add is the same access audit trail routes/appointments.js already
// writes, so a bulk walk of every patient's history is attributable after the
// fact. Raw uploaded files are a different matter — see the documents routes.
router.get('/patients/:id/medical-history', validateUUID(), async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s,
      `SELECT id, name, phone, dental_history FROM patients WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    const patient = r.rows[0];
    const medical_history = decryptJSON(patient.dental_history);
    delete patient.dental_history;
    if (medical_history === null) {
      // Never shown as "no history" — see decryptJSON's doc comment. A
      // dentist relying on this to check for an allergy must be told the read
      // failed, not handed an empty-looking, falsely reassuring record.
      logger.warn('dental_history decryption failed', { patient: req.params.id });
      return res.json({ patient: { ...patient, medical_history: null, medical_history_error: true } });
    }
    // Fire-and-forget, and only when there is actually something to read.
    // Masked patient id (first 8 chars) matches appointments.js so the audit
    // log itself doesn't become a second copy of the identifiers.
    if (Object.keys(medical_history).length > 0) {
      writeAuditLog(s, req.user.id, req.user.role, 'ACCESS_DENTAL_HISTORY', 'patient',
        String(req.params.id).slice(0, 8) + '…', null, null, req.ip)
        .catch(e => logger.warn('Medical history audit log failed', { error: e.message }));
    }
    res.json({ patient: { ...patient, medical_history } });
  } catch (err) { handleError(res, err); }
});

router.patch('/patients/:id/medical-history', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { medical_history } = req.body;
    if (!medical_history || typeof medical_history !== 'object') {
      return res.status(400).json({ error: 'medical_history object required' });
    }
    const s = req.tenant.schema_name;
    // Encrypted at rest (utils/encryption.js encryptJSON) — this column holds
    // blood type, allergies, chronic conditions and medications, and a raw
    // pg_dump backup of it must not be a plaintext copy of every patient's
    // sensitive health data across the whole clinic. See CLAUDE.md.
    const r = await tenantQuery(s,
      // deleted_at IS NULL for the same reason PATCH /patients/:id carries it:
      // DELETE /patients/:id anonymises the row and clears dental_history, and
      // without this guard a later PATCH writes live clinical data back onto a
      // record that every read path has stopped showing.
      `UPDATE patients SET dental_history=$1::jsonb, updated_at=NOW()
        WHERE id=$2 AND deleted_at IS NULL
        RETURNING id, name`,
      [JSON.stringify(encryptJSON(medical_history)), req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_MEDICAL_HISTORY', 'patient', req.params.id,
      null, { fields: Object.keys(medical_history) }, req.ip);
    res.json({ patient: { ...r.rows[0], medical_history } });
  } catch (err) { handleError(res, err); }
});

// ── PATIENT DOCUMENTS (Enhancement 6) ────────────────────────
const MAX_FILE_BASE64_LEN = 14 * 1024 * 1024; // ~10 MB after base64 overhead

// Metadata only — no file_data. Left open to every role on purpose: front-desk
// staff need to see THAT a scan or prescription exists (and its name/date) to
// do check-in, and the dashboard's patient modal fetches this for all roles.
router.get('/patients/:id/documents', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT id, file_name, file_type, file_size_bytes, notes, appointment_id, created_at
       FROM documents WHERE patient_id=$1 ORDER BY created_at DESC`,
      [req.params.id]);
    res.json({ documents: r.rows });
  } catch (err) { handleError(res, err); }
});

// The only route in this file that returns file_data — the full base64 blob of
// a scan/X-ray/prescription, up to 10 MB. It had neither a role gate nor a rate
// limit, so a 'staff' login could walk GET /patients for every UUID, list each
// patient's documents and then pull every raw file: a complete exfiltration of
// the clinic's uploaded medical records by a non-admin. Same reasoning that put
// adminOnly on GET /analytics/export (a bulk PHI extract reachable by any
// 'staff' or 'doctor' login), and it matches POST/DELETE on this same
// collection, which have always been admin-only.
// The limiter is the second half of the fix: adminOnly stops the non-admin
// walk, docLimiter bounds how fast a compromised ADMIN token can drain the
// archive. patientLimiter was only ever applied to the list route.
const docLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many document requests. Slow down and retry shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/patients/:id/documents/:docId', adminOnly, docLimiter, validateUUID(), async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.docId)) return res.status(400).json({ error: 'Invalid document ID' });
    const s = req.tenant.schema_name;
    // Explicit column list rather than SELECT *: this response carries PHI, so
    // any column added to `documents` later must be opted in deliberately.
    const r = await tenantQuery(s,
      `SELECT id, patient_id, appointment_id, file_name, file_type, file_data,
              file_size_bytes, notes, uploaded_by_user_id, created_at
       FROM documents WHERE id=$1 AND patient_id=$2`,
      [req.params.docId, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Document not found' });
    // Upload and delete are audited; reading the actual file was not, so a bulk
    // drain left no trace at all. Fire-and-forget so it can't stall the download.
    writeAuditLog(s, req.user.id, req.user.role, 'ACCESS_DOCUMENT', 'patient',
      String(req.params.id).slice(0, 8) + '…', null, { file_name: r.rows[0].file_name }, req.ip)
      .catch(e => logger.warn('Document access audit log failed', { error: e.message }));
    res.json({ document: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.post('/patients/:id/documents', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { file_name, file_type, file_data, file_size_bytes, notes, appointment_id } = req.body;
    if (!file_name || !file_data) return res.status(400).json({ error: 'file_name and file_data are required' });
    if (typeof file_data !== 'string') return res.status(400).json({ error: 'file_data must be a base64 string' });
    if (file_data.length > MAX_FILE_BASE64_LEN) return res.status(413).json({ error: 'File too large. Maximum 10 MB.' });
    if (appointment_id && !UUID_RE.test(appointment_id)) return res.status(400).json({ error: 'Invalid appointment_id' });

    const s = req.tenant.schema_name;
    const r = await tenantQuery(s,
      `INSERT INTO documents (patient_id, appointment_id, file_name, file_type, file_data, file_size_bytes, notes, uploaded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, file_name, file_type, file_size_bytes, notes, appointment_id, created_at`,
      [req.params.id, appointment_id || null, file_name.slice(0, 255), file_type || null,
       file_data, file_size_bytes || null, notes || null, req.user.id]);

    await writeAuditLog(s, req.user.id, req.user.role, 'UPLOAD_DOCUMENT', 'patient', req.params.id,
      null, { file_name, file_type }, req.ip);
    res.status(201).json({ document: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.delete('/patients/:id/documents/:docId', adminOnly, validateUUID(), async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.docId)) return res.status(400).json({ error: 'Invalid document ID' });
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s,
      `DELETE FROM documents WHERE id=$1 AND patient_id=$2 RETURNING id, file_name`,
      [req.params.docId, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Document not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_DOCUMENT', 'patient', req.params.id,
      { file_name: r.rows[0].file_name }, null, req.ip);
    res.json({ success: true });
  } catch (err) { handleError(res, err); }
});

// ── BULK IMPORT PATIENTS via CSV ──────────────────────────────
const { parse } = require('csv-parse/sync');

// Rows are validated/normalized synchronously (cheap), then written in chunks
// of IMPORT_CHUNK_SIZE via multi-row VALUES INSERT/UPDATE instead of one
// query per row — a 500-row import used to be ~1000 sequential round trips
// (one SELECT + one INSERT/UPDATE per row), risking a proxy/load-balancer
// timeout on large imports. If a chunk's batched queries fail for any reason,
// we fall back to the original row-by-row logic for just that chunk so a
// single bad row can't sink 99 good ones.
const IMPORT_CHUNK_SIZE = 100;

function normalizeImportRow(row, rowNum) {
  const phone = (row.phone || row.Phone || row.PHONE || '').toString().trim().replace(/\s+/g, '').replace(/^\+/, '');
  const name = (row.name || row.Name || row.NAME || '').toString().trim();
  const email = (row.email || row.Email || row.EMAIL || '').toString().trim() || null;
  const gender = (row.gender || row.Gender || row.GENDER || '').toString().trim().toLowerCase() || null;
  const dob = (row.date_of_birth || row.dob || row.DOB || row['Date of Birth'] || '').toString().trim() || null;

  if (!phone || !/^[+]?[0-9]{7,20}$/.test(phone)) {
    return { error: `Row ${rowNum}: invalid phone "${phone}"` };
  }
  if (!name || name.length < 1) {
    return { error: `Row ${rowNum}: missing name` };
  }

  const validGenders = ['male', 'female', 'other', null];
  const safeGender = validGenders.includes(gender) ? gender : null;

  // Normalize DOB to YYYY-MM-DD
  let safeDob = null;
  if (dob) {
    const ddmmyyyy = dob.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    const yyyymmdd = dob.match(/^\d{4}-\d{2}-\d{2}$/);
    if (ddmmyyyy) {
      safeDob = `${ddmmyyyy[3]}-${ddmmyyyy[2].padStart(2,'0')}-${ddmmyyyy[1].padStart(2,'0')}`;
    } else if (yyyymmdd) {
      safeDob = dob;
    }
  }

  return { row: { rowNum, phone, name, email, gender: safeGender, dob: safeDob } };
}

// Original per-row logic (SELECT then INSERT/UPDATE) — used as the fallback
// when a chunk's batched queries throw, so the failure can be isolated to
// whichever specific row(s) actually caused it.
async function importRowSingle(s, row) {
  // patients.phone is NON-unique (family booking) so ON CONFLICT (phone)
  // would raise 42P10. Update an existing profile matching phone+name, or
  // insert a new one — keeps CSV re-imports idempotent per (phone, name).
  const existing = await tenantQuery(s,
    `SELECT id FROM patients WHERE phone=$1 AND lower(name)=lower($2) AND deleted_at IS NULL
     ORDER BY created_at ASC LIMIT 1`,
    [row.phone, row.name]);
  if (existing.rows[0]) {
    await tenantQuery(s, `
      UPDATE patients SET
        name=$2, email=COALESCE($3, email), gender=COALESCE($4, gender),
        date_of_birth=COALESCE($5, date_of_birth), updated_at=NOW()
      WHERE id=$1
    `, [existing.rows[0].id, row.name, row.email, row.gender, row.dob]);
  } else {
    await tenantQuery(s, `
      INSERT INTO patients (phone, name, email, gender, date_of_birth)
      VALUES ($1, $2, $3, $4, $5)
    `, [row.phone, row.name, row.email, row.gender, row.dob]);
  }
}

// Batched happy-path for one chunk: one SELECT to find existing (phone, name)
// matches, one multi-row UPDATE for matches, one multi-row INSERT for the
// rest — 2-3 round trips instead of up to 2 * chunk.length.
async function importChunkBatched(s, chunk) {
  // Fold rows that share (phone, lower(name)) within THIS chunk — mirrors the
  // original sequential behaviour where a later duplicate row in the same CSV
  // updates whatever the earlier one already wrote (name always takes the
  // latest value; email/gender/dob keep the latest non-null value, matching
  // the COALESCE(new, existing) chain the row-by-row path produced).
  const merged = new Map();
  for (const row of chunk) {
    const key = `${row.phone}|${row.name.toLowerCase()}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...row });
    } else {
      prev.name = row.name;
      if (row.email != null) prev.email = row.email;
      if (row.gender != null) prev.gender = row.gender;
      if (row.dob != null) prev.dob = row.dob;
    }
  }
  const rows = [...merged.values()];
  if (!rows.length) return;

  const phones = rows.map(r => r.phone);
  const lnames = rows.map(r => r.name.toLowerCase());
  const existingR = await tenantQuery(s, `
    SELECT DISTINCT ON (phone, lower(name)) id, phone, lower(name) AS lname
    FROM patients
    WHERE deleted_at IS NULL
      AND (phone, lower(name)) IN (SELECT * FROM unnest($1::text[], $2::text[]))
    ORDER BY phone, lower(name), created_at ASC
  `, [phones, lnames]);
  const existingMap = new Map();
  for (const er of existingR.rows) existingMap.set(`${er.phone}|${er.lname}`, er.id);

  const toUpdate = [];
  const toInsert = [];
  for (const row of rows) {
    const key = `${row.phone}|${row.name.toLowerCase()}`;
    const existingId = existingMap.get(key);
    if (existingId) toUpdate.push({ ...row, id: existingId });
    else toInsert.push(row);
  }

  if (toUpdate.length) {
    await tenantQuery(s, `
      UPDATE patients AS p SET
        name = v.name,
        email = COALESCE(v.email, p.email),
        gender = COALESCE(v.gender, p.gender),
        date_of_birth = COALESCE(v.dob::date, p.date_of_birth),
        updated_at = NOW()
      FROM (
        SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])
        AS v(id, name, email, gender, dob)
      ) AS v
      WHERE p.id = v.id
    `, [
      toUpdate.map(r => r.id),
      toUpdate.map(r => r.name),
      toUpdate.map(r => r.email),
      toUpdate.map(r => r.gender),
      toUpdate.map(r => r.dob),
    ]);
  }

  if (toInsert.length) {
    await tenantQuery(s, `
      INSERT INTO patients (phone, name, email, gender, date_of_birth)
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::date[])
    `, [
      toInsert.map(r => r.phone),
      toInsert.map(r => r.name),
      toInsert.map(r => r.email),
      toInsert.map(r => r.gender),
      toInsert.map(r => r.dob),
    ]);
  }
}

// Tighter than patientLimiter: this is the heaviest endpoint in the file (up to
// 500 rows, a CSV parse and chunked multi-row writes per call) and was the only
// one with no rate limit at all.
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many import requests. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// adminOnly BEFORE importLimiter (same order as POST /slots/generate). The
// limiter counts per IP, and a whole clinic sits behind one NAT'd address, so
// with the limiter first a 'staff' user whose requests are rejected anyway
// still burns the hour's budget of 10 — ten clicks and the actual admin can't
// import until the window rolls over.
router.post('/patients/import', adminOnly, importLimiter, async (req, res) => {
  try {
    const { csv_data } = req.body; // base64 or raw CSV string
    if (!csv_data) return res.status(400).json({ error: 'csv_data is required (raw CSV or base64)' });
    // See the same guard in routes/doctors.js: .includes() below throws on a
    // non-string, turning a client mistake into a 500 with no explanation.
    if (typeof csv_data !== 'string') {
      return res.status(400).json({ error: 'csv_data must be a raw CSV or base64 string' });
    }

    let rawCsv = csv_data;
    // Detect base64
    if (!csv_data.includes('\n') && !csv_data.includes(',')) {
      try { rawCsv = Buffer.from(csv_data, 'base64').toString('utf8'); } catch (_) {}
    }

    const records = parse(rawCsv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    if (!records.length) return res.status(400).json({ error: 'No records found in CSV' });
    if (records.length > 500) return res.status(400).json({ error: 'Maximum 500 records per import' });

    const s = req.tenant.schema_name;
    let imported = 0;
    let skipped = 0;
    const errors = [];

    // Phase 1: validate & normalize every row (in-memory, no DB round trips).
    const validRows = [];
    for (let rowIdx = 0; rowIdx < records.length; rowIdx++) {
      const rowNum = rowIdx + 2; // +1 for the header line, +1 for 1-based numbering
      const { row, error } = normalizeImportRow(records[rowIdx], rowNum);
      if (error) {
        skipped++;
        errors.push(error);
      } else {
        validRows.push(row);
      }
    }

    // Phase 2: write valid rows in chunks, batched per chunk with a per-row
    // fallback if a chunk's batched queries throw.
    for (let i = 0; i < validRows.length; i += IMPORT_CHUNK_SIZE) {
      const chunk = validRows.slice(i, i + IMPORT_CHUNK_SIZE);
      try {
        await importChunkBatched(s, chunk);
        imported += chunk.length;
      } catch (batchErr) {
        for (const row of chunk) {
          try {
            await importRowSingle(s, row);
            imported++;
          } catch (rowErr) {
            skipped++;
            errors.push(`Row ${row.rowNum}: ${rowErr.message}`);
          }
        }
      }
    }

    await writeAuditLog(s, req.user.id, req.user.role, 'IMPORT_PATIENTS', 'patients', null,
      null, { imported, skipped }, req.ip);

    res.json({ imported, skipped, errors: errors.slice(0, 20) });
  } catch (err) { handleError(res, err); }
});

module.exports = router;
