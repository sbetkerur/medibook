const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const { addDays, format } = require('date-fns');
const logger = require('../utils/logger');

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
        duration: row.slot_duration_minutes || 30,
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

  const today = new Date();
  let count = 0;

  for (const [docId, doc] of Object.entries(docMap)) {
    // Generate 7 days ahead
    for (let i = 1; i <= 7; i++) {
      const date = addDays(today, i);
      const dow = date.getDay();
      const sched = doc.schedules.find(s => s.dow === dow);
      if (!sched) continue;

      const dateStr = format(date, 'yyyy-MM-dd');
      const [sh, sm] = sched.start.split(':').map(Number);
      const [eh, em] = sched.end.split(':').map(Number);
      let cur = sh * 60 + sm;
      const end = eh * 60 + em;

      // Parse lunch window in minutes (null = no lunch break)
      let lunchStart = null, lunchEnd = null;
      if (sched.lunchStart && sched.lunchEnd) {
        const [lsh, lsm] = sched.lunchStart.split(':').map(Number);
        const [leh, lem] = sched.lunchEnd.split(':').map(Number);
        lunchStart = lsh * 60 + lsm;
        lunchEnd   = leh * 60 + lem;
      }

      while (cur + doc.duration <= end) {
        // Skip slots that overlap the lunch window
        if (lunchStart !== null && cur < lunchEnd && cur + doc.duration > lunchStart) {
          cur = lunchEnd;
          continue;
        }
        const st = `${String(Math.floor(cur / 60)).padStart(2, '0')}:${String(cur % 60).padStart(2, '0')}`;
        const et = `${String(Math.floor((cur + doc.duration) / 60)).padStart(2, '0')}:${String((cur + doc.duration) % 60).padStart(2, '0')}`;
        await tenantQuery(schema, `
          INSERT INTO time_slots (doctor_id, hospital_id, slot_date, start_time, end_time, status)
          VALUES ($1,$2,$3,$4,$5,'available')
          ON CONFLICT (doctor_id, slot_date, start_time) DO NOTHING
        `, [docId, doc.hospital_id, dateStr, st, et]);
        cur += doc.duration;
        count++;
      }
    }
  }
  return count;
}

function startSlotGeneratorCron() {
  // Run daily at 11:30 PM IST (18:00 UTC)
  cron.schedule('0 18 * * *', async () => {
    logger.info('Starting nightly slot generation...');
    try {
      const tenants = await query(`SELECT schema_name, name FROM tenants WHERE status='active'`);
      let total = 0;
      for (const tenant of tenants.rows) {
        try {
          const n = await generateSlotsForTenant(tenant.schema_name);
          total += n;
          if (n > 0) logger.info(`Slots generated for ${tenant.name}: ${n}`);
        } catch (err) {
          logger.error(`Slot generation failed for ${tenant.name}`, { error: err.message });
        }
      }
      logger.info(`Nightly slot generation done: ${total} slots across ${tenants.rows.length} tenants`);
    } catch (err) {
      logger.error('Slot generator cron error', { error: err.message });
    }
  });
  logger.info('Slot generator cron registered (daily at 11:30 PM IST)');
}

module.exports = { startSlotGeneratorCron, generateSlotsForTenant };
