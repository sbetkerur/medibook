'use strict';
const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { query } = require('../db');
const logger = require('../utils/logger');
const { withCronLock } = require('../utils/cronLock');

const BACKUP_DIR = process.env.BACKUP_DIR || os.tmpdir();
const MAX_BACKUP_FILES = parseInt(process.env.BACKUP_MAX_FILES) || 7;

async function runBackup() {
  const startedAt = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `medibook_backup_${timestamp}.sql`;
  const filePath = path.join(BACKUP_DIR, fileName);

  let logId = null;
  try {
    const r = await query(`
      INSERT INTO backup_log (status, file_path) VALUES ('running', $1) RETURNING id
    `, [filePath]);
    logId = r.rows[0]?.id;
  } catch (_) {}

  return new Promise((resolve, reject) => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      const err = new Error('DATABASE_URL not set');
      reject(err);
      return;
    }

    let sizeBytes = 0;
    const writeStream = fs.createWriteStream(filePath);
    const pgdump = spawn('pg_dump', [dbUrl, '--no-password'], {
      env: { ...process.env, PGPASSWORD: '' },
      timeout: 10 * 60 * 1000,
    });

    pgdump.stdout.on('data', (chunk) => {
      sizeBytes += chunk.length;
      writeStream.write(chunk);
    });

    pgdump.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.toLowerCase().includes('error')) {
        logger.warn('pg_dump stderr', { message: msg.trim() });
      }
    });

    pgdump.on('close', async (code) => {
      writeStream.end();
      const durationMs = Date.now() - startedAt;

      if (code === 0) {
        logger.info(`Backup completed: ${fileName} (${Math.round(sizeBytes / 1024)}KB, ${durationMs}ms)`);
        try {
          await query(`
            UPDATE backup_log SET status='success', completed_at=NOW(), size_bytes=$1, duration_ms=$2
            WHERE id=$3
          `, [sizeBytes, durationMs, logId]);
          await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='backup'`).catch(() => {});
        } catch (_) {}

        try {
          const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('medibook_backup_') && f.endsWith('.sql'))
            .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);
          for (const f of files.slice(MAX_BACKUP_FILES)) {
            try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (_) {}
          }
        } catch (_) {}

        resolve({ filePath, sizeBytes, durationMs });
      } else {
        const errMsg = `pg_dump exited with code ${code}`;
        logger.error('Backup failed', { code, durationMs });
        try {
          await query(`
            UPDATE backup_log SET status='failed', completed_at=NOW(), error_message=$1, duration_ms=$2
            WHERE id=$3
          `, [errMsg, durationMs, logId]);
          await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='backup'`, [errMsg]).catch(() => {});
        } catch (_) {}
        try { fs.unlinkSync(filePath); } catch (_) {}
        reject(new Error(errMsg));
      }
    });

    pgdump.on('error', async (err) => {
      writeStream.end();
      const durationMs = Date.now() - startedAt;
      const errMsg = err.message;
      logger.error('Backup spawn error', { error: errMsg });
      try {
        await query(`
          UPDATE backup_log SET status='failed', completed_at=NOW(), error_message=$1, duration_ms=$2
          WHERE id=$3
        `, [errMsg, durationMs, logId]);
      } catch (_) {}
      try { fs.unlinkSync(filePath); } catch (_) {}
      reject(err);
    });
  });
}

function startBackupCron() {
  const task = cron.schedule('0 21 * * *', async () => {
    await withCronLock('cron:backup', 3600, async () => {
      logger.info('Starting scheduled database backup...');
      try {
        const result = await runBackup();
        logger.info(`Backup cron complete: ${result.filePath}`);
      } catch (err) {
        logger.error('Backup cron failed', { error: err.message });
      }
    });
  });
  logger.info('Backup cron registered (daily at 2:30 AM IST)');
  return task;
}

module.exports = { startBackupCron, runBackup };
