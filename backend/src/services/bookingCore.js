'use strict';
/**
 * Shared appointment-creation primitives.
 *
 * Used by the bot flow (bookingFlow.completeBooking), the admin walk-in route
 * (POST /appointments) and the follow-up route so that slot locking, booking-ID
 * generation/retry and monthly-quota semantics stay identical everywhere.
 */

const { genBookingId } = require('./bot/utils');
const { query, tenantQuery } = require('../db');
const { IST_MONTH_START_TS_SQL } = require('../utils/dateTz');
const logger = require('../utils/logger');

/**
 * "This slot's day is actually open" — a correlated guard for any query over
 * `time_slots` that runs AFTER a date has been chosen.
 *
 * The date-LIST queries have always excluded doctor leaves and clinic holidays,
 * but everything downstream of them trusted the chosen date. That trust was
 * misplaced: `_dates` is cached in the bot session, `getSession` has no TTL and
 * the cleanup cron only purges non-idle sessions after 7 days, so a patient can
 * tap a date row that was offered before the clinic declared a holiday on it.
 * Blocking the slots at declaration time (services.js POST /holidays) covers the
 * slots that existed then; this guard covers everything else, including any slot
 * created by a path that forgets to consult planDoctorSlots.
 *
 * Correlated on the slot's OWN doctor_id/hospital_id/slot_date rather than on
 * bound parameters: the reschedule flow never carried a hospital_id in its
 * session context, and a guard that silently degrades when the caller's context
 * is stale is exactly the failure this exists to prevent. Holidays are per
 * hospital OR clinic-wide (hospital_id IS NULL) — both must block.
 *
 * Interpolate into the WHERE clause; it binds no parameters. The table must be
 * referenced as `time_slots` (unaliased), which is how every call site spells it.
 */
const SLOT_DAY_OPEN_SQL = `
  NOT EXISTS (
    SELECT 1 FROM doctor_leaves dl
    WHERE dl.doctor_id = time_slots.doctor_id AND dl.leave_date = time_slots.slot_date
  )
  AND NOT EXISTS (
    SELECT 1 FROM clinic_holidays ch
    WHERE ch.holiday_date = time_slots.slot_date
      AND (ch.hospital_id IS NULL OR ch.hospital_id = time_slots.hospital_id)
  )`;

/**
 * Insert an appointment inside an existing transaction, retrying up to 3 times
 * on booking_id collision (unique constraint violation).
 *
 * Each attempt runs inside a SAVEPOINT: a failed INSERT aborts only the
 * savepoint, not the whole transaction, so the retry can actually succeed.
 * (Without the savepoint, the first 23505 would poison the transaction and
 * every subsequent statement would fail with 25P02.)
 *
 * @param {import('pg').PoolClient} client - client already inside BEGIN with tenant search_path
 * @param {object} f - appointment fields
 * @param {string} f.patientId
 * @param {string} f.doctorId
 * @param {string} f.hospitalId
 * @param {string|null} f.slotId
 * @param {string} f.appointmentDate - YYYY-MM-DD
 * @param {string} f.appointmentTime - HH:MM[:SS]
 * @param {string} [f.visitType='in_person']
 * @param {string|null} [f.notes=null]
 * @returns {Promise<{bookingId: string, row: object}>}
 */
async function insertAppointmentWithRetry(client, f) {
  let insertAttempts = 0;
  while (true) {
    const bookingId = genBookingId();
    try {
      await client.query('SAVEPOINT booking_insert');
      const r = await client.query(
        `INSERT INTO appointments
         (booking_id, patient_id, doctor_id, hospital_id, slot_id, appointment_date, appointment_time, visit_type, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9)
         RETURNING *`,
        [bookingId, f.patientId, f.doctorId, f.hospitalId, f.slotId || null,
         f.appointmentDate, f.appointmentTime, f.visitType || 'in_person', f.notes || null]);
      await client.query('RELEASE SAVEPOINT booking_insert');
      return { bookingId, row: r.rows[0] };
    } catch (insertErr) {
      // 23505 = unique_violation in PostgreSQL
      if (insertErr.code === '23505' && insertErr.constraint?.includes('booking_id') && ++insertAttempts < 4) {
        await client.query('ROLLBACK TO SAVEPOINT booking_insert');
        logger.warn('booking_id collision, retrying', { attempt: insertAttempts });
        continue;
      }
      throw insertErr; // re-throw if not a booking_id collision or max retries exceeded
    }
  }
}

/**
 * Check the tenant's monthly appointment quota (plans.max_appointments_per_month).
 * Counts appointments created this calendar month (any status — cancellations
 * still consumed a booking).
 *
 * Fails open on DB errors so a plans-table hiccup never blocks bookings.
 *
 * @param {object} tenant - row from public.tenants (needs schema_name + plan)
 * @returns {Promise<{allowed: boolean, used: number, limit: number|null}>}
 */
async function checkMonthlyQuota(tenant) {
  try {
    const planR = await query(`SELECT max_appointments_per_month FROM plans WHERE id=$1`, [tenant.plan]);
    const limit = planR.rows[0]?.max_appointments_per_month ?? null;
    if (limit === null) return { allowed: true, used: 0, limit: null };

    // Month boundary in IST (the product timezone), not UTC — with plain
    // date_trunc('month', NOW()) the quota would reset 5.5 hours late on the 1st.
    // Via the shared constant, not a hand-rolled copy: this is the number the
    // whole product agrees on (GET /settings' usage bar, the super admin's
    // quota panel and platform stats all report it), and three independent
    // transcriptions of the same expression is how they drift apart.
    const usedR = await tenantQuery(tenant.schema_name,
      `SELECT COUNT(*) FROM appointments WHERE created_at >= ${IST_MONTH_START_TS_SQL}`);
    const used = parseInt(usedR.rows[0].count);
    return { allowed: used < limit, used, limit };
  } catch (err) {
    logger.warn('checkMonthlyQuota failed — allowing booking', { tenant: tenant.slug, error: err.message });
    return { allowed: true, used: 0, limit: null };
  }
}

module.exports = { insertAppointmentWithRetry, checkMonthlyQuota, SLOT_DAY_OPEN_SQL };
