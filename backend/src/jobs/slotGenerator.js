const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const { addDays, format } = require('date-fns');
const { toZonedTime } = require('../utils/dateTz');
const logger = require('../utils/logger');

const IST = 'Asia/Kolkata';
const { CRON_LOOKAHEAD_DAYS } = require('../utils/errors');
const { withCronLock } = require('../utils/cronLock');

const BATCH_SIZE = 100;
const PARALLEL_DOCTORS = 50;        // process up to 50 doctors concurrently
const TENANT_TIMEOUT_MS = 30_000;   // 30 s max per tenant

/** Wrap a promise with a hard timeout */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
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

// Cache Indian public holidays for a year (TTL: 24h in Redis)
async function fetchPublicHolidays(year) {
  const cacheKey = `holidays:IN:${year}`;
  try {
    const { getClient } = require('../utils/redisClient');
    const redis = getClient();
    const cached = await redis.get(cacheKey);
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
      await redis.set(cacheKey, JSON.stringify(dates), 'EX', 24 * 60 * 60);
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
          AND a.appointment_date >= CURRENT_DATE - INTERVAL '90 days'
          AND a.status IN ('no_show','completed','cancelled')
      )
      WHERE d.is_active = true
    `);
  } catch (err) {
    logger.warn('updateNoShowScores failed', { schema, error: err.message });
  }
}

async function generateSlotsForTenant(schema) {
  const doctors = await tenantQuery(schema,
    `SELECT d.id, d.hospital_id, d.slot_duration_minutes,
            s.day_of_week, s.start_time, s.end_time,
            s.lunch_start_time, s.lunch_end_time
     FROM doctors d
     JOIN doctor_schedules s ON s.doctor_id=d.id
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
  } catch (_) { /* doctor_leaves table may not exist in all schemas yet */ }

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
  } catch (_) { /* clinic_holidays table may not exist in all schemas yet */ }

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
    let localBatch = [];
    let localCount = 0;

    for (let i = 1; i <= CRON_LOOKAHEAD_DAYS; i++) {
      const date = addDays(today, i);
      const dow = date.getDay();
      const sched = doc.schedules.find(s => s.dow === dow);
      if (!sched) continue;

      const dateStr = format(date, 'yyyy-MM-dd');
      if (holidaySet.has(`${doc.hospital_id}:${dateStr}`) || clinicWideHolidays.has(dateStr)) continue; // hospital-specific or clinic-wide holiday
      if (publicHolidaySet.has(dateStr)) continue;      // Indian public holiday
      if (leaveSet.has(`${docId}:${dateStr}`)) continue; // doctor-specific leave

      const [sh, sm] = sched.start.split(':').map(Number);
      const [eh, em] = sched.end.split(':').map(Number);
      let cur = sh * 60 + sm;
      const end = eh * 60 + em;

      let lunchStart = null, lunchEnd = null;
      if (sched.lunchStart && sched.lunchEnd) {
        const [lsh, lsm] = sched.lunchStart.split(':').map(Number);
        const [leh, lem] = sched.lunchEnd.split(':').map(Number);
        lunchStart = lsh * 60 + lsm;
        lunchEnd   = leh * 60 + lem;
      }

      while (cur + doc.duration <= end) {
        if (lunchStart !== null && cur < lunchEnd && cur + doc.duration > lunchStart) {
          cur = lunchEnd;
          continue;
        }
        const st = `${String(Math.floor(cur / 60)).padStart(2, '0')}:${String(cur % 60).padStart(2, '0')}`;
        const et = `${String(Math.floor((cur + doc.duration) / 60)).padStart(2, '0')}:${String((cur + doc.duration) % 60).padStart(2, '0')}`;
        localBatch.push({ docId, hospitalId: doc.hospital_id, dateStr, st, et, maxCapacity: 1 });
        localCount++;
        cur += doc.duration;

        if (localBatch.length >= BATCH_SIZE) {
          await flushSlots(schema, localBatch);
          localBatch = [];
        }
      }
    }

    if (localBatch.length) await flushSlots(schema, localBatch);
    return localCount;
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
  try {
    const r = await tenantQuery(schema,
      `UPDATE time_slots SET status='expired'
       WHERE slot_date < CURRENT_DATE AND status='available'
       RETURNING id`);
    // Hard-delete expired slot records older than 90 days (prevents unbounded growth)
    await tenantQuery(schema,
      `DELETE FROM time_slots WHERE status='expired' AND slot_date < CURRENT_DATE - INTERVAL '90 days'`);
    // Purge bot sessions: inactive 30+ days OR stuck mid-flow for 7+ days
    await tenantQuery(schema,
      `DELETE FROM bot_sessions WHERE last_activity < NOW() - INTERVAL '30 days'
          OR (state != 'idle' AND last_activity < NOW() - INTERVAL '7 days')`);
    // Purge old wa_messages (keep 90 days to allow dedup lookups)
    await tenantQuery(schema,
      `DELETE FROM wa_messages WHERE created_at < NOW() - INTERVAL '90 days'`);
    return r.rows.length;
  } catch (err) {
    logger.error(`cleanupExpiredSlots failed for schema ${schema}`, { error: err.message });
    return 0;
  }
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
    // Prune email dedup log older than 48 hours (keep a grace window beyond EMAIL_DEDUP_WINDOW_HOURS)
    await query(`DELETE FROM email_sent_log WHERE sent_at < NOW() - INTERVAL '48 hours'`);
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
            const [todayAppts, monthAppts, totalPatients, activeSlots] = await Promise.allSettled([
              tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date = CURRENT_DATE AND status = 'confirmed'`),
              tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date >= date_trunc('month', CURRENT_DATE) AND status IN ('confirmed','completed')`),
              tenantQuery(s, `SELECT COUNT(*) FROM patients`),
              tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date >= CURRENT_DATE AND status = 'available'`),
            ]);
            await query(`
              INSERT INTO tenant_stats_cache (tenant_id, stat_date, appointments_today, appointments_month, patients_total, active_slots, updated_at)
              VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, NOW())
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

function startBackupReminderCron() {
  // Every Sunday at 2 AM IST (20:30 UTC Saturday)
  const backupTask = cron.schedule('30 20 * * 6', async () => {
    logger.info('Starting weekly database backup...');
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      const path = require('path');
      const fs = require('fs');

      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        logger.warn('DATABASE_URL not set — skipping backup');
        return;
      }

      // Parse DATABASE_URL to extract PGPASSWORD separately — avoids shell injection
      // when the password contains special characters like $, `, (), etc.
      let pgEnv = { ...process.env };
      try {
        const parsed = new URL(dbUrl);
        if (parsed.password) {
          pgEnv.PGPASSWORD = decodeURIComponent(parsed.password);
          parsed.password = '';
        }
        // Build a safe connection string without credentials for pg_dump
        pgEnv.PGSAFE_URL = parsed.toString();
      } catch (_) {
        // If URL parsing fails, fall back to passing dbUrl (no credentials in plain host:port form)
        pgEnv.PGSAFE_URL = dbUrl;
      }

      const backupDir = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
      // Create backup dir if needed
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().slice(0, 10);
      const backupFile = path.join(backupDir, `medibook_${timestamp}.sql`);

      await execAsync(
        `pg_dump "${pgEnv.PGSAFE_URL}" --no-password -f "${backupFile}"`,
        { timeout: 5 * 60 * 1000, env: pgEnv } // 5 min timeout
      );

      const stats = fs.statSync(backupFile);
      const sizeMb = Math.round(stats.size / 1024 / 1024 * 10) / 10;
      logger.info(`Database backup complete: ${backupFile} (${sizeMb} MB)`);

      // Update cron status
      await query(
        `UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='backup'`
      ).catch(() => {});

      // Prune backups older than 30 days
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const files = fs.readdirSync(backupDir).filter(f => f.startsWith('medibook_') && f.endsWith('.sql'));
      for (const f of files) {
        const fPath = path.join(backupDir, f);
        if (fs.statSync(fPath).mtimeMs < cutoff) {
          fs.unlinkSync(fPath);
          logger.info(`Pruned old backup: ${f}`);
        }
      }
    } catch (err) {
      logger.error('Database backup failed', { error: err.message });
      await query(
        `UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='backup'`,
        [err.message?.slice(0, 500)]
      ).catch(() => {});
    }
  });
  logger.info('Database backup cron registered (weekly Sunday 2AM IST)');
  return backupTask;
}

/**
 * Regenerate slots for a single doctor after their schedule changes.
 * Deletes future available/blocked slots then re-creates them from the new schedule.
 *
 * When dryRun=true, returns a preview object instead of inserting rows.
 *
 * @param {string} schema   - Tenant schema name
 * @param {string} doctorId - Doctor UUID
 * @param {boolean} dryRun  - If true, return preview without inserting
 * @returns {number|object} - Slot count, or dry-run preview object
 */
async function generateSlotsForDoctor(schema, doctorId, dryRun = false) {
  const docR = await tenantQuery(schema,
    `SELECT d.id, d.hospital_id, d.slot_duration_minutes,
            s.day_of_week, s.start_time, s.end_time,
            s.lunch_start_time, s.lunch_end_time
     FROM doctors d
     JOIN doctor_schedules s ON s.doctor_id=d.id
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
    })),
  };

  // Fetch leaves for this doctor in the lookahead window
  // Use IST "today" — same reason as generateSlotsForTenant.
  const today = toZonedTime(new Date(), IST);
  const lookaheadEnd = format(addDays(today, CRON_LOOKAHEAD_DAYS), 'yyyy-MM-dd');
  const todayStr = format(today, 'yyyy-MM-dd');
  let leaveSet = new Set();
  try {
    const leavesR = await tenantQuery(schema,
      `SELECT leave_date::text as leave_date FROM doctor_leaves
       WHERE doctor_id=$1 AND leave_date BETWEEN $2 AND $3`,
      [doctorId, todayStr, lookaheadEnd]);
    for (const l of leavesR.rows) leaveSet.add(l.leave_date);
  } catch (_) {}

  // Dry-run: collect slots into an array without inserting
  if (dryRun) {
    const previewSlots = [];
    let count = 0;

    for (let i = 1; i <= CRON_LOOKAHEAD_DAYS; i++) {
      const date = addDays(today, i);
      const dow = date.getDay();
      const sched = doc.schedules.find(s => s.dow === dow);
      if (!sched) continue;
      const dateStr = format(date, 'yyyy-MM-dd');
      if (leaveSet.has(dateStr)) continue;

      const [sh, sm] = sched.start.split(':').map(Number);
      const [eh, em] = sched.end.split(':').map(Number);
      let cur = sh * 60 + sm;
      const end = eh * 60 + em;
      let lunchStart = null, lunchEnd = null;
      if (sched.lunchStart && sched.lunchEnd) {
        const [lsh, lsm] = sched.lunchStart.split(':').map(Number);
        const [leh, lem] = sched.lunchEnd.split(':').map(Number);
        lunchStart = lsh * 60 + lsm;
        lunchEnd   = leh * 60 + lem;
      }

      while (cur + doc.duration <= end) {
        if (lunchStart !== null && cur < lunchEnd && cur + doc.duration > lunchStart) {
          cur = lunchEnd;
          continue;
        }
        const st = `${String(Math.floor(cur / 60)).padStart(2, '0')}:${String(cur % 60).padStart(2, '0')}`;
        const et = `${String(Math.floor((cur + doc.duration) / 60)).padStart(2, '0')}:${String((cur + doc.duration) % 60).padStart(2, '0')}`;
        if (previewSlots.length < 10) {
          previewSlots.push({ date: dateStr, start_time: st, end_time: et });
        }
        count++;
        cur += doc.duration;
      }
    }

    return { dry_run: true, would_generate: count, preview: previewSlots };
  }

  // Normal (non-dry-run) path
  let localBatch = [];
  let count = 0;

  for (let i = 1; i <= CRON_LOOKAHEAD_DAYS; i++) {
    const date = addDays(today, i);
    const dow = date.getDay();
    const sched = doc.schedules.find(s => s.dow === dow);
    if (!sched) continue;
    const dateStr = format(date, 'yyyy-MM-dd');
    if (leaveSet.has(dateStr)) continue;

    const [sh, sm] = sched.start.split(':').map(Number);
    const [eh, em] = sched.end.split(':').map(Number);
    let cur = sh * 60 + sm;
    const end = eh * 60 + em;
    let lunchStart = null, lunchEnd = null;
    if (sched.lunchStart && sched.lunchEnd) {
      const [lsh, lsm] = sched.lunchStart.split(':').map(Number);
      const [leh, lem] = sched.lunchEnd.split(':').map(Number);
      lunchStart = lsh * 60 + lsm;
      lunchEnd   = leh * 60 + lem;
    }

    while (cur + doc.duration <= end) {
      if (lunchStart !== null && cur < lunchEnd && cur + doc.duration > lunchStart) {
        cur = lunchEnd;
        continue;
      }
      const st = `${String(Math.floor(cur / 60)).padStart(2, '0')}:${String(cur % 60).padStart(2, '0')}`;
      const et = `${String(Math.floor((cur + doc.duration) / 60)).padStart(2, '0')}:${String((cur + doc.duration) % 60).padStart(2, '0')}`;
      localBatch.push({ docId: doctorId, hospitalId: doc.hospital_id, dateStr, st, et, maxCapacity: 1 });
      count++;
      cur += doc.duration;
      if (localBatch.length >= BATCH_SIZE) {
        await flushSlots(schema, localBatch);
        localBatch = [];
      }
    }
  }
  if (localBatch.length) await flushSlots(schema, localBatch);
  return count;
}

module.exports = {
  startSlotGeneratorCron,
  generateSlotsForTenant,
  generateSlotsForDoctor,
  updateNoShowScores,
  cleanupExpiredSlots,
  startBackupReminderCron,
};
