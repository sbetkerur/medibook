const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const { addDays, format } = require('date-fns');
const { toZonedTime, IST_TODAY_SQL, IST_MONTH_START_SQL } = require('../utils/dateTz');
const logger = require('../utils/logger');

const IST = 'Asia/Kolkata';
const { CRON_LOOKAHEAD_DAYS } = require('../utils/errors');
const { withCronLock } = require('../utils/cronLock');

const BATCH_SIZE = 100;
const PARALLEL_DOCTORS = 50;        // process up to 50 doctors concurrently
const TENANT_TIMEOUT_MS = 30_000;   // 30 s max per tenant

/**
 * Compute the slot start/end times for one working day.
 * Single source of truth for the slot arithmetic — previously duplicated in
 * four places (nightly cron, per-doctor regen, dry-run preview, admin route),
 * which had already started to drift.
 *
 * @param {string} startTime  - schedule start, "HH:MM[:SS]"
 * @param {string} endTime    - schedule end, "HH:MM[:SS]"
 * @param {number} duration   - slot length in minutes
 * @param {string|null} lunchStartTime - optional lunch window start
 * @param {string|null} lunchEndTime   - optional lunch window end
 * @returns {Array<{st: string, et: string}>} slot boundaries as "HH:MM"
 */
function computeDaySlotTimes(startTime, endTime, duration, lunchStartTime = null, lunchEndTime = null) {
  const toMinutes = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
  };
  const toHHMM = (mins) =>
    `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

  let cur = toMinutes(startTime);
  const end = toMinutes(endTime);
  let lunchStart = null, lunchEnd = null;
  if (lunchStartTime && lunchEndTime) {
    lunchStart = toMinutes(lunchStartTime);
    lunchEnd = toMinutes(lunchEndTime);
  }

  const slots = [];
  while (cur + duration <= end) {
    // Skip any slot that would overlap the lunch window
    if (lunchStart !== null && cur < lunchEnd && cur + duration > lunchStart) {
      cur = lunchEnd;
      continue;
    }
    slots.push({ st: toHHMM(cur), et: toHHMM(cur + duration) });
    cur += duration;
  }
  return slots;
}

/**
 * Plan every slot a doctor should have over the lookahead window.
 *
 * SINGLE SOURCE OF TRUTH for the day loop. The nightly tenant sweep and the
 * per-doctor regeneration used to carry their own copies of this loop, which
 * is exactly how the per-doctor path ended up ignoring clinic holidays.
 *
 * Day 0 (TODAY) is included, with only the slots still ahead of the current IST
 * time. Starting at day 1 meant a dentist added — or a schedule extended — this
 * morning had no bookable slots at all until the 23:30 cron ran, so same-day
 * booking, the case a patient in pain actually needs, silently failed.
 *
 * @param {object}   doc          - { hospital_id, duration, schedules[] }
 * @param {Date}     today        - IST "now"
 * @param {number}   days         - how many days PAST today to plan
 * @param {Function} isBlockedDay - (dateStr, hospitalId) => boolean; leave/holiday
 *   check. Takes the branch because clinic holidays are per hospital, and a
 *   visiting doctor's day can belong to a different branch than their primary.
 * @returns {Array<{dateStr: string, st: string, et: string, hospitalId: string}>}
 */
function planDoctorSlots(doc, today, days, isBlockedDay) {
  // "HH:MM" strings compare correctly lexicographically, which is why the slot
  // times computed below can be filtered against it directly.
  const nowHHMM = format(today, 'HH:mm');
  const planned = [];

  for (let i = 0; i <= days; i++) {
    const date = addDays(today, i);
    // filter, NOT find. A working day is a LIST of sessions: an Indian dentist
    // routinely does 10–1 at one branch and 5–9 at another on the same day, and
    // `.find()` silently dropped every session after the first — so the second
    // branch generated no slots and reported no error.
    const sessions = doc.schedules.filter(s => s.dow === date.getDay());
    if (!sessions.length) continue;

    const dateStr = format(date, 'yyyy-MM-dd');

    for (const sched of sessions) {
    // A visiting consultant who comes on the 1st and 3rd Saturday. Empty or
    // absent means every week, which is what every schedule meant before this
    // existed — so an unset value must never filter anything out.
    if (!matchesWeekOfMonth(sched.weeksOfMonth, date)) continue;

    // The branch for THIS session, falling back to the doctor's primary.
    // Stamped per slot rather than per doctor: one doctor row can serve Monday
    // morning at one branch and Monday evening at another.
    const hospitalId = sched.hospitalId || doc.hospital_id;

    // Per branch: a holiday at one branch must not close the session the
    // doctor spends at the other, even on the same day.
    if (isBlockedDay(dateStr, hospitalId)) continue;

      for (const { st, et } of computeDaySlotTimes(sched.start, sched.end, doc.duration, sched.lunchStart, sched.lunchEnd)) {
        // Today only: skip slots whose start time has already passed. Booking
        // rejects them anyway (see completeBooking's time predicate), so
        // generating them would just show patients times they cannot take.
        if (i === 0 && st <= nowHHMM) continue;
        planned.push({ dateStr, st, et, hospitalId });
      }
    }
  }
  return planned;
}

/**
 * Which occurrence of its weekday this date is within the month: the 1st
 * Saturday is 1, the 2nd is 2, and so on up to 5.
 *
 * Counted by day-of-month rather than by calendar week, which is what "1st and
 * 3rd Saturday" means to a clinic — the 1st Saturday is simply the first one
 * that falls in the month, regardless of where the week boundary lands.
 */
function weekOfMonth(date) {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}

/**
 * Does this date fall on one of the weeks the doctor attends?
 *
 * Fails OPEN on anything empty or malformed: a doctor whose schedule carries no
 * week restriction (every existing row) must keep generating every week. The
 * failure mode of getting this backwards is a specialist silently losing their
 * entire calendar, which nobody would notice until a patient couldn't book.
 */
function matchesWeekOfMonth(weeks, date) {
  if (!Array.isArray(weeks) || weeks.length === 0) return true;
  return weeks.includes(weekOfMonth(date));
}

/**
 * Wrap a promise with a hard REPORTING deadline.
 *
 * Note what this does and does not do. Promise.race abandons the slow promise;
 * it cannot cancel it, so the tenant's generation keeps running (and keeps
 * holding pool connections) after the cron has logged a timeout and moved on.
 * That is a known limit — bounding the work itself needs a cancellation flag
 * threaded into generateSlotsForTenant.
 *
 * What it must not also do is leak the timer. The handle was never cleared, so
 * every tenant that finished quickly still left a live 30s timeout behind: at
 * 500 tenants that is 500 pending timers per run, all of which keep the event
 * loop alive and delay a SIGTERM shutdown by up to the full timeout.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Flush accumulated slot tuples in a single multi-value INSERT
async function flushSlots(schema, batch) {
  if (!batch.length) return;
  const values = [];
  const params = [];
  for (const s of batch) {
    const i = params.length;
    values.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},'available',0)`);
    params.push(s.docId, s.hospitalId, s.dateStr, s.st, s.et, s.maxCapacity || 1);
  }
  await tenantQuery(schema, `
    INSERT INTO time_slots (doctor_id, hospital_id, slot_date, start_time, end_time, max_capacity, status, booked_count)
    VALUES ${values.join(',')}
    ON CONFLICT (doctor_id, slot_date, start_time) DO NOTHING
  `, params);
}

/**
 * Insert planned slots in BATCH_SIZE chunks. Returns the number planned.
 * Shared by both generation paths so batching/flushing can't drift either.
 */
async function flushPlanned(schema, planned, docId, hospitalId) {
  let batch = [];
  for (const p of planned) {
    const { dateStr, st, et } = p;
    // Per-slot branch (a visiting doctor's Wednesday can be at another branch);
    // the argument is the doctor's primary, used when the day carries none.
    batch.push({ docId, hospitalId: p.hospitalId || hospitalId, dateStr, st, et, maxCapacity: 1 });
    if (batch.length >= BATCH_SIZE) {
      await flushSlots(schema, batch);
      batch = [];
    }
  }
  if (batch.length) await flushSlots(schema, batch);
  return planned.length;
}

// Cache Indian public holidays for a year (TTL: 24h in Redis)
async function fetchPublicHolidays(year) {
  const cacheKey = `holidays:IN:${year}`;
  try {
    const { getClient } = require('../utils/redisClient');
    const redis = getClient();
    const cached = redis ? await redis.get(cacheKey) : null;
    if (cached) return new Set(JSON.parse(cached));
  } catch (_) {}

  try {
    const axios = require('axios');
    const res = await axios.get(
      `https://date.nager.at/api/v3/PublicHolidays/${year}/IN`,
      { timeout: 5000 }
    );
    const dates = (res.data || []).map(h => h.date); // "YYYY-MM-DD" strings
    const set = new Set(dates);

    // Cache in Redis for 24h
    try {
      const { getClient } = require('../utils/redisClient');
      const redis = getClient();
      if (redis) await redis.set(cacheKey, JSON.stringify(dates), 'EX', 24 * 60 * 60);
    } catch (_) {}

    return set;
  } catch (err) {
    logger.warn('Failed to fetch Indian public holidays', { year, error: err.message });
    return new Set(); // fail open — don't block slot generation
  }
}

// Update no-show scores for all doctors (called nightly)
async function updateNoShowScores(schema) {
  try {
    await tenantQuery(schema, `
      UPDATE doctors d SET no_show_score = (
        SELECT COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE a.status='no_show') / NULLIF(COUNT(*), 0), 2), 0)
        FROM appointments a
        WHERE a.doctor_id = d.id
          AND a.appointment_date >= ${IST_TODAY_SQL} - INTERVAL '90 days'
          AND a.status IN ('no_show','completed','cancelled')
      )
      WHERE d.is_active = true
    `);
  } catch (err) {
    logger.warn('updateNoShowScores failed', { schema, error: err.message });
  }
}

async function generateSlotsForTenant(schema) {
  // One row per SESSION. `doctor_schedules.hospital_id` is now the branch for
  // that session, so a dentist can have two rows for one weekday — 10–1 here,
  // 5–9 there. It is only joined back to doctor_hospitals for rows written
  // before that column existed and never backfilled; NULL in both still means
  // the doctor's primary branch, which is every non-visiting doctor.
  //
  // The join is scoped to the SESSION's branch, not just the weekday. Matching
  // on weekday alone is what produced the original bug: two branch rows for one
  // day multiplied every schedule row in two.
  const doctors = await tenantQuery(schema,
    `SELECT d.id, d.hospital_id, d.slot_duration_minutes,
            s.day_of_week, s.start_time, s.end_time,
            s.lunch_start_time, s.lunch_end_time, s.week_of_month,
            COALESCE(s.hospital_id, dh.hospital_id) AS day_hospital_id
     FROM doctors d
     JOIN doctor_schedules s ON s.doctor_id=d.id
     LEFT JOIN doctor_hospitals dh
       ON dh.doctor_id = d.id AND dh.day_of_week = s.day_of_week
      AND s.hospital_id IS NULL
      -- Scoped exactly as tenantMigrate.js's backfill scopes itself, and for
      -- the same reason. /doctors/:id/schedule writes a doctor_hospitals row
      -- ONLY for a session that names a branch, so a Tuesday split of
      -- "10-13 at branch B / 17-21 at primary (NULL)" has exactly ONE dh row.
      -- Joining on weekday alone hands that row to the 17:00 session too, and
      -- the whole evening at the main clinic is generated, told to patients,
      -- and holiday-checked as branch B. If any session that weekday names a
      -- branch, the NULLs beside it mean "primary branch" and must be left
      -- alone; only a genuinely legacy weekday (every session NULL) may fall
      -- back to dh.
      AND NOT EXISTS (
        SELECT 1 FROM doctor_schedules s2
         WHERE s2.doctor_id = d.id AND s2.day_of_week = s.day_of_week
           AND s2.hospital_id IS NOT NULL
      )
      -- And only when that weekday is unambiguous. Two dh rows for one day
      -- would otherwise MULTIPLY the session into two planned rows, and
      -- flushSlots' ON CONFLICT DO NOTHING would keep whichever branch landed
      -- first — the original two-branch bug, re-entering through the join
      -- instead of the schedule table.
      AND (SELECT COUNT(*) FROM doctor_hospitals dh2
            WHERE dh2.doctor_id = d.id AND dh2.day_of_week = s.day_of_week) = 1
     WHERE d.is_active=true AND s.is_working=true`);

  if (!doctors.rows.length) return 0;

  // Group by doctor
  const docMap = {};
  for (const row of doctors.rows) {
    if (!docMap[row.id]) {
      docMap[row.id] = {
        hospital_id: row.hospital_id,
        duration: Math.max(5, Math.min(480, row.slot_duration_minutes || 30)),
        schedules: [],
      };
    }
    docMap[row.id].schedules.push({
      dow: row.day_of_week,
      start: row.start_time,
      end: row.end_time,
      lunchStart: row.lunch_start_time || null,
      lunchEnd:   row.lunch_end_time   || null,
      weeksOfMonth: row.week_of_month || null,
      hospitalId: row.day_hospital_id || null,
    });
  }

  // Fetch all doctor leaves for the lookahead window (single query, not per-doctor)
  // Use IST "today" — UTC servers can be up to 5.5 hours behind IST, meaning
  // new Date() gives "yesterday" in IST for the 5.5h window after IST midnight.
  const today = toZonedTime(new Date(), IST);
  const lookaheadEnd = format(addDays(today, CRON_LOOKAHEAD_DAYS), 'yyyy-MM-dd');
  const todayStr = format(today, 'yyyy-MM-dd');
  let leaveSet = new Set(); // Set of "docId:dateStr"
  try {
    const leavesR = await tenantQuery(schema,
      `SELECT doctor_id, leave_date::text as leave_date FROM doctor_leaves
       WHERE leave_date BETWEEN $1 AND $2`, [todayStr, lookaheadEnd]);
    for (const l of leavesR.rows) {
      leaveSet.add(`${l.doctor_id}:${l.leave_date}`);
    }
  } catch (err) {
    // Fail CLOSED. This used to swallow every error and leave leaveSet empty,
    // after which nothing was skipped — so a transient statement timeout on
    // this SELECT generated a full day of bookable slots for every date a
    // dentist is on leave, and patients booked with an absent dentist. The
    // count looked HIGHER than normal and the cron reported success.
    // 42P01 (undefined_table) is the only tolerable case: a schema created
    // before doctor_leaves existed genuinely has no leaves to honour.
    if (err.code !== '42P01') throw err;
    logger.warn('doctor_leaves table missing — skipping leave checks', { schema });
  }

  // Build holiday sets — hospital-specific (hospitalId:date) and clinic-wide (null hospital_id)
  let holidaySet = new Set(); // Set of "hospitalId:dateStr"
  let clinicWideHolidays = new Set(); // Set of dateStr where hospital_id IS NULL (applies to all)
  try {
    const holidaysR = await tenantQuery(schema,
      `SELECT hospital_id::text, holiday_date::text FROM clinic_holidays
       WHERE holiday_date BETWEEN $1 AND $2`, [todayStr, lookaheadEnd]);
    for (const h of holidaysR.rows) {
      if (h.hospital_id) {
        holidaySet.add(`${h.hospital_id}:${h.holiday_date}`);
      } else {
        clinicWideHolidays.add(h.holiday_date);
      }
    }
  } catch (err) {
    // Fail closed for the same reason as doctor_leaves: an empty holiday set
    // means slots get generated on days the clinic is shut, and patients book
    // appointments nobody will be there for.
    if (err.code !== '42P01') throw err;
    logger.warn('clinic_holidays table missing — skipping holiday checks', { schema });
  }

  // Optionally skip Indian public holidays (feature flag: skip_public_holidays)
  let publicHolidaySet = new Set();
  try {
    const { isEnabled } = require('../utils/featureFlags');
    const tenantRecord = await query(`SELECT id FROM tenants WHERE schema_name=$1`, [schema]);
    const tenantId = tenantRecord.rows[0]?.id;
    if (tenantId && await isEnabled(tenantId, 'skip_public_holidays')) {
      const thisYear = new Date().getFullYear();
      const nextYear = thisYear + 1;
      const [h1, h2] = await Promise.all([
        fetchPublicHolidays(thisYear),
        fetchPublicHolidays(nextYear),
      ]);
      publicHolidaySet = new Set([...h1, ...h2]);
    }
  } catch (_) {}

  /** Generate slots for a single doctor and flush them. Returns slot count. */
  async function generateForDoctor(docId, doc) {
    // Same planner the per-doctor path uses; only the blocked-day lookup differs,
    // because this sweep prefetches leaves/holidays for every doctor at once.
    const planned = planDoctorSlots(doc, today, CRON_LOOKAHEAD_DAYS, (dateStr, hospitalId) =>
      holidaySet.has(`${hospitalId}:${dateStr}`) ||       // holiday at the branch worked THAT day
      clinicWideHolidays.has(dateStr) ||                  // clinic-wide holiday
      publicHolidaySet.has(dateStr) ||                    // Indian public holiday
      leaveSet.has(`${docId}:${dateStr}`)                 // doctor-specific leave
    );

    return flushPlanned(schema, planned, docId, doc.hospital_id);
  }

  // Process doctors in parallel batches (PARALLEL_DOCTORS at a time)
  const doctorEntries = Object.entries(docMap);
  let count = 0;

  for (let i = 0; i < doctorEntries.length; i += PARALLEL_DOCTORS) {
    const batch = doctorEntries.slice(i, i + PARALLEL_DOCTORS);
    const counts = await Promise.all(
      batch.map(([docId, doc]) =>
        generateForDoctor(docId, doc).catch(err => {
          logger.warn(`Slot gen failed for doctor ${docId}`, { error: err.message });
          return 0;
        })
      )
    );
    count += counts.reduce((a, b) => a + b, 0);
  }

  return count;
}

// Mark past available slots as expired; purge old records; clean stale sessions
async function cleanupExpiredSlots(schema) {
  // Each purge is isolated. These used to share one try block, so the first
  // failure skipped every later statement — permanently, since the failing
  // condition (a slot older than 90 days) stays true on every subsequent night.
  // The session and message purges silently stopped running as a result.
  const step = async (label, sql) => {
    try {
      await tenantQuery(schema, sql);
    } catch (err) {
      logger.error(`cleanupExpiredSlots: ${label} failed`, { schema, error: err.message });
    }
  };

  let expiredCount = 0;
  try {
    const r = await tenantQuery(schema,
      `UPDATE time_slots SET status='expired'
       WHERE slot_date < (timezone('Asia/Kolkata', NOW()))::date AND status='available'
       RETURNING id`);
    expiredCount = r.rows.length;
  } catch (err) {
    logger.error(`cleanupExpiredSlots: expiry sweep failed`, { schema, error: err.message });
  }

  // Hard-delete expired slot records older than 90 days (prevents unbounded growth).
  // appointments.slot_id REFERENCES time_slots(id) with NO ACTION, and cancelling
  // an appointment releases the slot WITHOUT clearing slot_id — so a cancelled
  // appointment keeps pointing at a slot that later expires. Deleting it raises
  // 23503. Same guard as deleteFutureUnreferencedSlots() in routes/doctors.js.
  await step('expired-slot purge', `
    DELETE FROM time_slots
    WHERE status='expired'
      AND slot_date < ${IST_TODAY_SQL} - INTERVAL '90 days'
      AND id NOT IN (SELECT slot_id FROM appointments WHERE slot_id IS NOT NULL)`);

  // Purge bot sessions: inactive 30+ days OR stuck mid-flow for 7+ days
  await step('bot_sessions purge', `
    DELETE FROM bot_sessions WHERE last_activity < NOW() - INTERVAL '30 days'
       OR (state != 'idle' AND last_activity < NOW() - INTERVAL '7 days')`);

  // Purge old wa_messages (keep 90 days to allow dedup lookups)
  await step('wa_messages purge',
    `DELETE FROM wa_messages WHERE created_at < NOW() - INTERVAL '90 days'`);

  return expiredCount;
}

// Clean up public-schema housekeeping: expired tokens, old audit logs, stale password resets
async function cleanupTokenBlacklist() {
  try {
    await query(`DELETE FROM token_blacklist WHERE expires_at < NOW()`);
  } catch (_) { /* non-fatal */ }
  try {
    await query(`DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '1 year'`);
  } catch (_) { /* non-fatal */ }
  try {
    // Remove used or expired password reset tokens older than 24 hours
    await query(`DELETE FROM password_resets WHERE used=true OR expires_at < NOW() - INTERVAL '24 hours'`);
  } catch (_) { /* non-fatal */ }
  try {
    // Trim admin_access_logs older than 6 months
    await query(`DELETE FROM admin_access_logs WHERE created_at < NOW() - INTERVAL '6 months'`);
  } catch (_) { /* non-fatal */ }
  try {
    // Remove used or expired refresh tokens older than 7 days
    await query(`DELETE FROM refresh_tokens WHERE used=true OR expires_at < NOW() - INTERVAL '7 days'`);
  } catch (_) { /* non-fatal */ }
  try {
    // Expired "this clinic is waiting for a reply" hints (services/pendingReply.js).
    // They are consulted only while unexpired, so old rows are pure noise.
    await query(`DELETE FROM global_pending_replies WHERE expires_at < NOW()`);
  } catch (_) { /* non-fatal */ }
  try {
    // Prune email log after 30 days. Dedup only needs EMAIL_DEDUP_WINDOW_HOURS,
    // but this table also backs open-rate tracking (open_count via the tracking
    // pixel) — the old 48-hour purge silently erased those stats. One row per
    // email sent keeps the table small even at 30-day retention.
    await query(`DELETE FROM email_sent_log WHERE sent_at < NOW() - INTERVAL '30 days'`);
  } catch (_) { /* non-fatal */ }
}

function startSlotGeneratorCron() {
  // Run daily at 11:30 PM IST (18:00 UTC)
  const slotTask = cron.schedule('0 18 * * *', async () => {
    await withCronLock('cron:slot_generator', 7200, async () => {
      logger.info('Starting nightly slot generation...');
      try {
        const tenants = await query(`SELECT schema_name, name FROM tenants WHERE status='active'`);
        let total = 0;
        for (const tenant of tenants.rows) {
          try {
            const n = await withTimeout(
              generateSlotsForTenant(tenant.schema_name),
              TENANT_TIMEOUT_MS,
              tenant.name
            );
            total += n;
            if (n > 0) logger.info(`Slots generated for ${tenant.name}: ${n}`);
          } catch (err) {
            logger.error(`Slot generation failed for ${tenant.name}`, { error: err.message });
          }

          // Update no-show scores for this tenant after slot generation
          await updateNoShowScores(tenant.schema_name).catch(() => {});
        }
        logger.info(`Nightly slot generation done: ${total} slots across ${tenants.rows.length} tenants`);

        // Update stats cache for each tenant
        const allTenants = await query(`SELECT id, schema_name, name FROM tenants WHERE status='active'`);
        for (const tenant of allTenants.rows) {
          try {
            const s = tenant.schema_name;
            // Every date boundary here is IST — keep in lockstep with the live
            // queries in routes/admin.js. Writing the cache row under the UTC
            // CURRENT_DATE while the reader looked it up under the same UTC date
            // meant the row written at 23:30 IST was still served as "today" for
            // the first 5.5 hours of the NEXT IST day.
            const [todayAppts, monthAppts, totalPatients, activeSlots] = await Promise.allSettled([
              tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date = ${IST_TODAY_SQL} AND status = 'confirmed'`),
              tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date >= ${IST_MONTH_START_SQL} AND status IN ('confirmed','completed')`),
              tenantQuery(s, `SELECT COUNT(*) FROM patients WHERE deleted_at IS NULL`),
              tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date >= ${IST_TODAY_SQL} AND status = 'available'`),
            ]);
            await query(`
              INSERT INTO tenant_stats_cache (tenant_id, stat_date, appointments_today, appointments_month, patients_total, active_slots, updated_at)
              VALUES ($1, ${IST_TODAY_SQL}, $2, $3, $4, $5, NOW())
              ON CONFLICT (tenant_id, stat_date) DO UPDATE SET
                appointments_today = EXCLUDED.appointments_today,
                appointments_month = EXCLUDED.appointments_month,
                patients_total = EXCLUDED.patients_total,
                active_slots = EXCLUDED.active_slots,
                updated_at = NOW()
            `, [
              tenant.id,
              todayAppts.status === 'fulfilled' ? parseInt(todayAppts.value.rows[0].count) : 0,
              monthAppts.status === 'fulfilled' ? parseInt(monthAppts.value.rows[0].count) : 0,
              totalPatients.status === 'fulfilled' ? parseInt(totalPatients.value.rows[0].count) : 0,
              activeSlots.status === 'fulfilled' ? parseInt(activeSlots.value.rows[0].count) : 0,
            ]);
          } catch (e) {
            logger.warn(`Stats cache update failed for ${tenant.name}`, { error: e.message });
          }
        }

        try {
          await query(
            `UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='slot_generator'`
          );
        } catch (_) {}
      } catch (err) {
        logger.error('Slot generator cron error', { error: err.message });
        try {
          await query(
            `UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='slot_generator'`,
            [err.message.slice(0, 500)]
          );
        } catch (_) {}
      }
    });
  });

  // Cleanup expired slots daily at midnight IST (18:30 UTC)
  const cleanupTask = cron.schedule('30 18 * * *', async () => {
    await withCronLock('cron:slot_cleanup', 3600, async () => {
      logger.info('Running slot expiry cleanup...');
      try {
        const tenants = await query(`SELECT schema_name FROM tenants WHERE status='active'`);
        let total = 0;
        for (const tenant of tenants.rows) {
          const n = await cleanupExpiredSlots(tenant.schema_name);
          total += n;
        }
        await cleanupTokenBlacklist();
        logger.info(`Slot expiry cleanup done: ${total} slots expired`);
      } catch (err) {
        logger.error('Slot expiry cleanup error', { error: err.message });
      }
    });
  });

  logger.info('Slot generator cron registered (daily at 11:30 PM IST)');
  logger.info('Slot expiry cleanup cron registered (daily at midnight IST)');
  return [slotTask, cleanupTask];
}

// NOTE: the weekly backup cron that used to live here (startBackupReminderCron,
// exec()-based pg_dump) was removed — it duplicated jobs/backupManager.js's
// spawn()-based daily backup cron (startBackupCron), and the two independent
// implementations drifted (different schedules, different job_name in
// cron_jobs, no stream error/backpressure handling here vs. proper handling
// there). backupManager.js's cron is now the single source of truth; see its
// registration in index.js.

/**
 * Regenerate slots for a single doctor after their schedule changes.
 * Deletes future available/blocked slots then re-creates them from the new schedule.
 *
 * When dryRun=true, returns a preview object instead of inserting rows.
 *
 * @param {string} schema   - Tenant schema name
 * @param {string} doctorId - Doctor UUID
 * @param {boolean} dryRun  - If true, return preview without inserting
 * @param {number} days     - Lookahead window in days (defaults to the cron window)
 * @returns {number|object} - Slot count, or dry-run preview object
 *
 * The doctor query below must stay IDENTICAL in shape to the tenant sweep's
 * (see the note above it): a schedule row IS a session, so the session's own
 * hospital_id wins and doctor_hospitals is consulted only when it is NULL.
 * This path had drifted — it read dh.hospital_id alone and joined on weekday
 * only, so a dentist with two branches on one weekday matched both dh rows,
 * multiplied 2 sessions into 4, and stamped the evening session with the
 * MORNING branch (flushSlots' ON CONFLICT DO NOTHING keeps whichever lands
 * first). It runs on every schedule save, and the nightly sweep could not
 * repair it for the same ON CONFLICT reason.
 */
async function generateSlotsForDoctor(schema, doctorId, dryRun = false, days = CRON_LOOKAHEAD_DAYS) {
  const docR = await tenantQuery(schema,
    `SELECT d.id, d.hospital_id, d.slot_duration_minutes,
            s.day_of_week, s.start_time, s.end_time,
            s.lunch_start_time, s.lunch_end_time, s.week_of_month,
            COALESCE(s.hospital_id, dh.hospital_id) AS day_hospital_id
     FROM doctors d
     JOIN doctor_schedules s ON s.doctor_id=d.id
     LEFT JOIN doctor_hospitals dh
       ON dh.doctor_id = d.id AND dh.day_of_week = s.day_of_week
      AND s.hospital_id IS NULL
      -- Scoped exactly as tenantMigrate.js's backfill scopes itself, and for
      -- the same reason. /doctors/:id/schedule writes a doctor_hospitals row
      -- ONLY for a session that names a branch, so a Tuesday split of
      -- "10-13 at branch B / 17-21 at primary (NULL)" has exactly ONE dh row.
      -- Joining on weekday alone hands that row to the 17:00 session too, and
      -- the whole evening at the main clinic is generated, told to patients,
      -- and holiday-checked as branch B. If any session that weekday names a
      -- branch, the NULLs beside it mean "primary branch" and must be left
      -- alone; only a genuinely legacy weekday (every session NULL) may fall
      -- back to dh.
      AND NOT EXISTS (
        SELECT 1 FROM doctor_schedules s2
         WHERE s2.doctor_id = d.id AND s2.day_of_week = s.day_of_week
           AND s2.hospital_id IS NOT NULL
      )
      -- And only when that weekday is unambiguous. Two dh rows for one day
      -- would otherwise MULTIPLY the session into two planned rows, and
      -- flushSlots' ON CONFLICT DO NOTHING would keep whichever branch landed
      -- first — the original two-branch bug, re-entering through the join
      -- instead of the schedule table.
      AND (SELECT COUNT(*) FROM doctor_hospitals dh2
            WHERE dh2.doctor_id = d.id AND dh2.day_of_week = s.day_of_week) = 1
     WHERE d.id=$1 AND d.is_active=true AND s.is_working=true`,
    [doctorId]);

  if (!docR.rows.length) return dryRun ? { dry_run: true, would_generate: 0, preview: [] } : 0;

  // Build schedule list from rows
  const doc = {
    hospital_id: docR.rows[0].hospital_id,
    duration: Math.max(5, Math.min(480, docR.rows[0].slot_duration_minutes || 30)),
    schedules: docR.rows.map(r => ({
      dow: r.day_of_week,
      start: r.start_time,
      end: r.end_time,
      lunchStart: r.lunch_start_time || null,
      lunchEnd: r.lunch_end_time || null,
      weeksOfMonth: r.week_of_month || null,
      hospitalId: r.day_hospital_id || null,
    })),
  };
  // Every branch this doctor works at, so the holiday lookup below covers the
  // one they are at on each day rather than only their primary.
  const doctorHospitalIds = [...new Set(
    [doc.hospital_id, ...doc.schedules.map(s => s.hospitalId)].filter(Boolean))];

  // Fetch leaves for this doctor in the lookahead window
  // Use IST "today" — same reason as generateSlotsForTenant.
  const today = toZonedTime(new Date(), IST);
  const lookaheadEnd = format(addDays(today, days), 'yyyy-MM-dd');
  const todayStr = format(today, 'yyyy-MM-dd');
  let leaveSet = new Set();
  try {
    const leavesR = await tenantQuery(schema,
      `SELECT leave_date::text as leave_date FROM doctor_leaves
       WHERE doctor_id=$1 AND leave_date BETWEEN $2 AND $3`,
      [doctorId, todayStr, lookaheadEnd]);
    for (const l of leavesR.rows) leaveSet.add(l.leave_date);
  } catch (err) {
    // Fail closed — same reasoning as the nightly path. Generating a full day
    // of bookable slots on a dentist's leave date is worse than failing loudly.
    if (err.code !== '42P01') throw err;
    logger.warn('doctor_leaves table missing — skipping leave checks', { schema });
  }

  // Fetch clinic holidays (hospital-specific + clinic-wide) — the nightly cron
  // skips these, but this per-doctor path previously did not, so regenerating
  // after a schedule change quietly recreated bookable slots on declared holidays.
  // Keyed "hospitalId:date", plus a clinic-wide set: a visiting doctor can be at
  // a different branch on different days, and a holiday at one branch must not
  // wipe out the day they spend at the other.
  const holidaySet = new Set();
  const clinicWideHolidays = new Set();
  try {
    const holidaysR = await tenantQuery(schema,
      `SELECT hospital_id::text, holiday_date::text as holiday_date FROM clinic_holidays
       WHERE holiday_date BETWEEN $1 AND $2 AND (hospital_id = ANY($3::uuid[]) OR hospital_id IS NULL)`,
      [todayStr, lookaheadEnd, doctorHospitalIds]);
    for (const h of holidaysR.rows) {
      if (h.hospital_id) holidaySet.add(`${h.hospital_id}:${h.holiday_date}`);
      else clinicWideHolidays.add(h.holiday_date);
    }
  } catch (err) {
    // Fail closed for the same reason as doctor_leaves: an empty holiday set
    // means slots get generated on days the clinic is shut, and patients book
    // appointments nobody will be there for.
    if (err.code !== '42P01') throw err;
    logger.warn('clinic_holidays table missing — skipping holiday checks', { schema });
  }

  // Indian public holidays (same feature flag the nightly cron honours)
  let publicHolidaySet = new Set();
  try {
    const { isEnabled } = require('../utils/featureFlags');
    const tenantRecord = await query(`SELECT id FROM tenants WHERE schema_name=$1`, [schema]);
    const tenantId = tenantRecord.rows[0]?.id;
    if (tenantId && await isEnabled(tenantId, 'skip_public_holidays')) {
      const thisYear = new Date().getFullYear();
      const [h1, h2] = await Promise.all([
        fetchPublicHolidays(thisYear),
        fetchPublicHolidays(thisYear + 1),
      ]);
      publicHolidaySet = new Set([...h1, ...h2]);
    }
  } catch (_) {}

  const isBlockedDay = (dateStr, hospitalId) =>
    leaveSet.has(dateStr) ||
    holidaySet.has(`${hospitalId}:${dateStr}`) ||
    clinicWideHolidays.has(dateStr) ||
    publicHolidaySet.has(dateStr);

  // One plan, used by both the preview and the insert — a dry run that walked
  // its own loop could report slots the real run would not create.
  const planned = planDoctorSlots(doc, today, days, isBlockedDay);

  if (dryRun) {
    return {
      dry_run: true,
      would_generate: planned.length,
      preview: planned.slice(0, 10).map(p => ({ date: p.dateStr, start_time: p.st, end_time: p.et })),
    };
  }

  return flushPlanned(schema, planned, doctorId, doc.hospital_id);
}

module.exports = {
  startSlotGeneratorCron,
  generateSlotsForTenant,
  generateSlotsForDoctor,
  computeDaySlotTimes,
  planDoctorSlots,
  weekOfMonth,
  matchesWeekOfMonth,
  updateNoShowScores,
  cleanupExpiredSlots,
};
