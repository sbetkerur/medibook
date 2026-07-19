'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { tenantQuery } = require('../db');
const { validateUUID, handleError, UUID_RE } = require('../utils/errors');
const { adminOnly, writeAuditLog } = require('./adminHelpers');

// Auth + tenant middleware applied once in index.js for /api/admin and /api/v1/admin

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
        `SELECT id, name, phone, email, gender, date_of_birth, visit_count, created_at FROM patients${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
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
      `SELECT id, name, phone, email, gender, date_of_birth, visit_count, dental_history as medical_history, created_at, updated_at FROM patients WHERE id=$1 AND deleted_at IS NULL`,
      [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    res.json({ patient: r.rows[0] });
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
    const { name, email, gender, date_of_birth } = req.body;
    const s = req.tenant.schema_name;
    const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (date_of_birth && !DOB_RE.test(date_of_birth)) return res.status(400).json({ error: 'date_of_birth must be YYYY-MM-DD' });
    const VALID_GENDERS = ['male', 'female', 'other'];
    if (gender && !VALID_GENDERS.includes(gender.toLowerCase())) {
      return res.status(400).json({ error: `gender must be one of: ${VALID_GENDERS.join(', ')}` });
    }
    const r = await tenantQuery(s, `
      UPDATE patients SET
        name=COALESCE($1,name), email=COALESCE($2,email),
        gender=COALESCE($3,gender), date_of_birth=COALESCE($4::date,date_of_birth), updated_at=NOW()
      WHERE id=$5 RETURNING id, name, phone, email, gender, date_of_birth, visit_count
    `, [name || null, email || null, gender || null, date_of_birth || null, req.params.id]);
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
      `SELECT COUNT(*) FROM appointments WHERE patient_id=$1 AND status='confirmed' AND appointment_date >= CURRENT_DATE`,
      [req.params.id]);
    if (parseInt(upcoming.rows[0].count) > 0) {
      return res.status(409).json({
        error: `Cannot delete patient — ${upcoming.rows[0].count} upcoming appointment(s) exist.`,
        upcoming_appointments: parseInt(upcoming.rows[0].count),
      });
    }
    const r = await tenantQuery(s, `
      UPDATE patients SET
        name='[Deleted]', email=NULL, date_of_birth=NULL, gender=NULL,
        dental_history='{}', deleted_at=NOW(), opted_out=true, updated_at=NOW()
      WHERE id=$1 RETURNING id
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'DELETE_PATIENT', 'patient', req.params.id, null, null, req.ip);
    res.json({ success: true, message: 'Patient record anonymised (GDPR)' });
  } catch (err) { handleError(res, err); }
});

// ── MEDICAL HISTORY ───────────────────────────────────────────
router.get('/patients/:id/medical-history', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT id, name, phone, dental_history as medical_history FROM patients WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    res.json({ patient: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

router.patch('/patients/:id/medical-history', adminOnly, validateUUID(), async (req, res) => {
  try {
    const { medical_history } = req.body;
    if (!medical_history || typeof medical_history !== 'object') {
      return res.status(400).json({ error: 'medical_history object required' });
    }
    const s = req.tenant.schema_name;
    const r = await tenantQuery(s,
      `UPDATE patients SET dental_history=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, dental_history as medical_history`,
      [JSON.stringify(medical_history), req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Patient not found' });
    await writeAuditLog(s, req.user.id, req.user.role, 'UPDATE_MEDICAL_HISTORY', 'patient', req.params.id,
      null, { fields: Object.keys(medical_history) }, req.ip);
    res.json({ patient: r.rows[0] });
  } catch (err) { handleError(res, err); }
});

// ── PATIENT DOCUMENTS (Enhancement 6) ────────────────────────
const MAX_FILE_BASE64_LEN = 14 * 1024 * 1024; // ~10 MB after base64 overhead

router.get('/patients/:id/documents', validateUUID(), async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT id, file_name, file_type, file_size_bytes, notes, appointment_id, created_at
       FROM documents WHERE patient_id=$1 ORDER BY created_at DESC`,
      [req.params.id]);
    res.json({ documents: r.rows });
  } catch (err) { handleError(res, err); }
});

router.get('/patients/:id/documents/:docId', validateUUID(), async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.docId)) return res.status(400).json({ error: 'Invalid document ID' });
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT * FROM documents WHERE id=$1 AND patient_id=$2`,
      [req.params.docId, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Document not found' });
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

router.post('/patients/import', adminOnly, async (req, res) => {
  try {
    const { csv_data } = req.body; // base64 or raw CSV string
    if (!csv_data) return res.status(400).json({ error: 'csv_data is required (raw CSV or base64)' });

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

    for (let rowIdx = 0; rowIdx < records.length; rowIdx++) {
      const row = records[rowIdx];
      const rowNum = rowIdx + 2; // +1 for the header line, +1 for 1-based numbering
      try {
        const phone = (row.phone || row.Phone || row.PHONE || '').toString().trim().replace(/\s+/g, '').replace(/^\+/, '');
        const name = (row.name || row.Name || row.NAME || '').toString().trim();
        const email = (row.email || row.Email || row.EMAIL || '').toString().trim() || null;
        const gender = (row.gender || row.Gender || row.GENDER || '').toString().trim().toLowerCase() || null;
        const dob = (row.date_of_birth || row.dob || row.DOB || row['Date of Birth'] || '').toString().trim() || null;

        if (!phone || !/^[+]?[0-9]{7,20}$/.test(phone)) {
          skipped++;
          errors.push(`Row ${rowNum}: invalid phone "${phone}"`);
          continue;
        }
        if (!name || name.length < 1) {
          skipped++;
          errors.push(`Row ${rowNum}: missing name`);
          continue;
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

        // patients.phone is NON-unique (family booking) so ON CONFLICT (phone)
        // would raise 42P10. Update an existing profile matching phone+name, or
        // insert a new one — keeps CSV re-imports idempotent per (phone, name).
        const existing = await tenantQuery(s,
          `SELECT id FROM patients WHERE phone=$1 AND lower(name)=lower($2) AND deleted_at IS NULL
           ORDER BY created_at ASC LIMIT 1`,
          [phone, name]);
        if (existing.rows[0]) {
          await tenantQuery(s, `
            UPDATE patients SET
              name=$2,
              email=COALESCE($3, email),
              gender=COALESCE($4, gender),
              date_of_birth=COALESCE($5, date_of_birth),
              updated_at=NOW()
            WHERE id=$1
          `, [existing.rows[0].id, name, email, safeGender, safeDob]);
        } else {
          await tenantQuery(s, `
            INSERT INTO patients (phone, name, email, gender, date_of_birth)
            VALUES ($1, $2, $3, $4, $5)
          `, [phone, name, email, safeGender, safeDob]);
        }
        imported++;
      } catch (rowErr) {
        skipped++;
        errors.push(`Row ${rowNum}: ${rowErr.message}`);
      }
    }

    await writeAuditLog(s, req.user.id, req.user.role, 'IMPORT_PATIENTS', 'patients', null,
      null, { imported, skipped }, req.ip);

    res.json({ imported, skipped, errors: errors.slice(0, 20) });
  } catch (err) { handleError(res, err); }
});

module.exports = router;
