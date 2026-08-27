'use strict';
/**
 * On-demand PDF reports for the front desk.
 *
 * Each route is a plain GET that streams a PDF and stores nothing. These are
 * read views the desk prints when locking up, so — like /day-close and
 * /requests, whose ?format=pdf arms live in their own files — they are NOT
 * adminOnly: a dentist login prints the day's list too. The one report that
 * IS admin-gated, /analytics/export, is a bulk PHI extract and does not belong
 * here.
 *
 *   - /reports/schedule.pdf — a day's appointments, grouped by dentist. For a
 *     FUTURE date it also carries each patient's reminder-reply status and a
 *     "confirmed / to call" summary, so "tomorrow's schedule" and the evening
 *     call-list are one report, not two. (A same-day appointment gets no 24h
 *     reminder — jobs/reminders.js only fires for strictly future dates — so
 *     the column is omitted for today and the past.)
 *
 * plus /day-close?format=pdf (routes/dayClose.js) and /requests?format=pdf
 * (routes/requests.js).
 *
 * Auth + tenant middleware are applied once in index.js — not re-applied here.
 */
const router = require('express').Router();
const { tenantQuery } = require('../db');
const { handleError, UUID_RE } = require('../utils/errors');
const { toZonedTime } = require('../utils/dateTz');
const { format } = require('date-fns');
const { streamReport, drawTable, prettyDate } = require('../utils/pdfReport');

const IST = 'Asia/Kolkata';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function istToday() {
  return format(toZonedTime(new Date(), IST), 'yyyy-MM-dd');
}

// "yes" to the 24h reminder, in the shapes reminders.js records.
const CONFIRMED_REPLIES = new Set(['yes', 'y', 'confirm', 'confirmed']);
function isConfirmedReply(resp) {
  return resp != null && CONFIRMED_REPLIES.has(String(resp).trim().toLowerCase());
}

/**
 * Clinic name (from req.tenant, the full tenants row) plus a branch name and
 * phone for the PDF band. A named hospital_id wins; otherwise a branch label is
 * only shown when the clinic has exactly one active branch, so a multi-branch
 * "all branches" report doesn't mislabel itself.
 */
async function clinicHeader(req, hospitalId) {
  const s = req.tenant.schema_name;
  let branchName = null;
  let phone = null;
  try {
    if (hospitalId) {
      const h = await tenantQuery(s, `SELECT name, phone FROM hospitals WHERE id = $1`, [hospitalId]);
      if (h.rows[0]) {
        branchName = h.rows[0].name;
        phone = h.rows[0].phone || null;
      }
    } else {
      const h = await tenantQuery(
        s,
        `SELECT name, phone FROM hospitals WHERE is_active = true AND deleted_at IS NULL ORDER BY created_at LIMIT 2`
      );
      if (h.rows.length === 1) {
        branchName = h.rows[0].name;
        phone = h.rows[0].phone || null;
      }
    }
  } catch {
    /* header bits are decoration — never fail a report over them */
  }
  return { clinicName: req.tenant.name, branchName, phone };
}

// ── A DAY'S SCHEDULE (+ confirmation status for future dates) ──
router.get('/reports/schedule.pdf', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const date = req.query.date || istToday();
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const hospitalId = req.query.hospital_id || null;
    if (hospitalId && !UUID_RE.test(hospitalId)) {
      return res.status(400).json({ error: 'hospital_id must be a UUID' });
    }

    const today = istToday();
    const isFuture = date > today;

    const params = [date];
    let branchFilter = '';
    if (hospitalId) {
      params.push(hospitalId);
      branchFilter = `AND a.hospital_id = $${params.length}`;
    }

    const r = await tenantQuery(
      s,
      `
      SELECT a.appointment_time, a.status, a.visit_type, a.reminder_24h_sent,
             p.name AS patient_name, p.phone AS patient_phone, p.visit_count,
             d.name AS doctor_name,
             dep.name AS department_name,
             h.name AS hospital_name,
             rc.response AS reminder_response
      FROM appointments a
      JOIN patients p ON p.id = a.patient_id
      JOIN doctors d ON d.id = a.doctor_id
      LEFT JOIN departments dep ON dep.id = COALESCE(a.department_id, d.department_id)
      JOIN hospitals h ON h.id = a.hospital_id
      LEFT JOIN LATERAL (
        SELECT response
        FROM reminder_confirmations
        WHERE appointment_id = a.id
        ORDER BY responded_at DESC NULLS LAST
        LIMIT 1
      ) rc ON true
      WHERE a.appointment_date = $1 ${branchFilter}
      ORDER BY d.name, a.appointment_time
      `,
      params
    );

    const head = await clinicHeader(req, hospitalId);
    const all = r.rows;
    const active = all.filter(x => x.status !== 'cancelled');
    const cancelled = all.length - active.length;

    // For a future day, how many of the still-live appointments has the patient
    // actually confirmed?
    const confirmable = active.filter(x => x.status === 'confirmed');
    const confirmedCount = confirmable.filter(x => isConfirmedReply(x.reminder_response)).length;
    const toCall = confirmable.length - confirmedCount;

    let subtitle = `${prettyDate(date)}   ·   ${active.length} appointment${active.length === 1 ? '' : 's'}`;
    if (cancelled) subtitle += `   ·   ${cancelled} cancelled`;
    if (isFuture && confirmable.length) {
      subtitle += `   ·   ${confirmedCount} confirmed, ${toCall} to call`;
    }

    const columns = [
      { key: 'time', label: 'Time', width: 5 },
      { key: 'patient', label: 'Patient', width: 15 },
      { key: 'phone', label: 'Phone', width: 10 },
      { key: 'treatment', label: 'Treatment', width: 11 },
      { key: 'visit', label: 'Visit #', width: 5, align: 'right' },
      { key: 'status', label: 'Status', width: 7 },
    ];
    if (isFuture) columns.push({ key: 'reminder', label: 'Confirmed?', width: 10 });

    streamReport(
      res,
      {
        ...head,
        title: date === today ? "Today's Schedule" : 'Appointment Schedule',
        subtitle,
        filename: `schedule-${date}`,
      },
      doc => {
        if (!all.length) {
          doc.font('body').fontSize(11).fillColor('#666').text('No appointments on this day.');
          return;
        }
        const byDoctor = {};
        for (const x of all) (byDoctor[x.doctor_name] = byDoctor[x.doctor_name] || []).push(x);
        Object.keys(byDoctor)
          .sort()
          .forEach((docName, idx) => {
            if (idx) doc.moveDown(0.8);
            doc.font('bold').fontSize(11).fillColor('#000').text(`Dr. ${docName}`);
            doc.moveDown(0.3);
            drawTable(
              doc,
              columns,
              byDoctor[docName].map(x => {
                const row = {
                  time: (x.appointment_time || '').slice(0, 5) || '—',
                  patient: x.patient_name || '—',
                  phone: x.patient_phone || '—',
                  treatment: x.department_name || 'General',
                  visit: x.visit_count == null ? '—' : String(x.visit_count),
                  status: x.status,
                };
                if (isFuture) {
                  row.reminder =
                    x.status !== 'confirmed'
                      ? '—'
                      : isConfirmedReply(x.reminder_response)
                        ? 'yes'
                        : x.reminder_response
                          ? `replied "${x.reminder_response}"`
                          : x.reminder_24h_sent
                            ? 'CALL — no reply'
                            : 'CALL — not sent';
                }
                return row;
              })
            );
          });
      }
    );
  } catch (err) {
    if (!res.headersSent) handleError(res, err);
  }
});

module.exports = router;
