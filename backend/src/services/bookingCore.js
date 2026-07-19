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
const logger = require('../utils/logger');

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
    const usedR = await tenantQuery(tenant.schema_name,
      `SELECT COUNT(*) FROM appointments
       WHERE created_at >= timezone('Asia/Kolkata', date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata'))`);
    const used = parseInt(usedR.rows[0].count);
    return { allowed: used < limit, used, limit };
  } catch (err) {
    logger.warn('checkMonthlyQuota failed — allowing booking', { tenant: tenant.slug, error: err.message });
    return { allowed: true, used: 0, limit: null };
  }
}

module.exports = { insertAppointmentWithRetry, checkMonthlyQuota };
