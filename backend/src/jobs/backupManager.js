'use strict';
/**
 * Nightly full-database backup — encrypted on disk.
 *
 * pg_dump's stdout used to go straight to a plaintext .sql file. That file is
 * every clinic's entire schema in one place — including patients.dental_history
 * (blood type, allergies, chronic conditions, medications) — and unlike the
 * live database it has no query layer, no access control and no audit log
 * around it: a single leaked copy (a misconfigured volume snapshot, server
 * compromise, insider disk access) hands over every patient's health data for
 * every clinic on the platform, not just one. See CLAUDE.md.
 *
 * File format (medibook_backup_<ts>.sql.enc):
 *   [12-byte IV][AES-256-GCM ciphertext of the pg_dump stream][16-byte auth tag]
 * Same key derivation as utils/encryption.js (ENCRYPTION_KEY), so there is no
 * second secret to provision — but that also means it is exactly as
 * consequential to lose or rotate: an old ENCRYPTION_KEY that no longer
 * exists makes every backup taken under it permanently unreadable. Restore
 * with scripts/decryptBackup.js.
 */
const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { query } = require('../db');
const logger = require('../utils/logger');
const { withCronLock } = require('../utils/cronLock');
const { getKeyBuffer } = require('../utils/encryption');

// Defaults to os.tmpdir() only so local dev works without configuration. In a
// container that is an EPHEMERAL path — every deploy discards the dumps, so the
// retention logic below silently guards an empty directory. Point BACKUP_DIR at
// a mounted volume in any deployment whose backups need to survive a restart.
const BACKUP_DIR = process.env.BACKUP_DIR || os.tmpdir();
const MAX_BACKUP_FILES = parseInt(process.env.BACKUP_MAX_FILES) || 7;

if (process.env.NODE_ENV === 'production' && !process.env.BACKUP_DIR) {
  logger.warn(
    'BACKUP_DIR not set — backups are being written to a temporary directory ' +
    'and will be lost on the next deploy. Mount a volume and set BACKUP_DIR.'
  );
}

async function runBackup() {
  const startedAt = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // .sql.enc, not .sql: this is no longer a file `psql` can read directly, and
  // the extension has to say so before anyone tries.
  const fileName = `medibook_backup_${timestamp}.sql.enc`;
  const filePath = path.join(BACKUP_DIR, fileName);

  // A mounted volume starts empty, so a nested BACKUP_DIR (e.g. /data/backups)
  // will not exist on first run — createWriteStream would ENOENT.
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  } catch (err) {
    logger.error('Cannot create backup directory', { dir: BACKUP_DIR, error: err.message });
    throw err;
  }

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

    // AES-256-GCM, streamed: a full pg_dump can run to hundreds of MB, far too
    // large to hold in memory the way utils/encryption.js's encrypt() does for
    // a single string. Same key derivation (getKeyBuffer), so ENCRYPTION_KEY
    // is the only secret this needs — see the file-format note at the top.
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKeyBuffer(), iv);

    // Pass the connection string via PGDATABASE rather than argv: process
    // arguments are world-readable via /proc (any `ps` in the container), and
    // DATABASE_URL embeds the Postgres password. libpq accepts a full URI in
    // PGDATABASE, so pg_dump needs no connection argument at all.
    const pgdump = spawn('pg_dump', ['--no-password'], {
      env: { ...process.env, PGDATABASE: dbUrl },
      timeout: 10 * 60 * 1000,
    });

    // A disk-full/permission error here was previously an unhandled 'error'
    // event while pg_dump still exited 0 — the truncated backup got recorded
    // as success.
    let streamError = null;
    writeStream.on('error', (err) => {
      streamError = err;
      logger.error('Backup write stream error', { error: err.message });
      try { pgdump.kill(); } catch (_) {}
    });
    cipher.on('error', (err) => {
      streamError = err;
      logger.error('Backup cipher stream error', { error: err.message });
      try { pgdump.kill(); } catch (_) {}
      writeStream.end();
    });

    // IV first, as a fixed-size header decryptBackup.js knows to read before
    // anything else — it has to travel with the file since it's random per
    // backup (GCM must never reuse an IV under the same key).
    writeStream.write(iv);

    pgdump.stdout.on('data', (chunk) => { sizeBytes += chunk.length; });
    // pipe() gives backpressure (manual write() buffered the whole dump in
    // memory on slow disks) and ends cipher's writable side when pg_dump's
    // stdout ends — but NOT writeStream (`{ end: false }`): the GCM auth tag
    // is only available once the cipher has fully finished, so writeStream
    // has to stay open until it's appended below.
    pgdump.stdout.pipe(cipher);
    cipher.pipe(writeStream, { end: false });

    // The cipher's readable side emits 'end' once every encrypted byte has
    // been produced and pushed downstream — the earliest point getAuthTag()
    // is valid. Appending it here, then ending writeStream, is what finally
    // lets the `pgdump.on('close')` handler below observe
    // `writeStream.writableFinished` and finalize.
    cipher.on('end', () => {
      if (streamError) return; // already tearing down
      try {
        writeStream.end(cipher.getAuthTag());
      } catch (err) {
        streamError = err;
        logger.error('Backup auth-tag write failed', { error: err.message });
        writeStream.end();
      }
    });

    pgdump.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.toLowerCase().includes('error')) {
        logger.warn('pg_dump stderr', { message: msg.trim() });
      }
    });

    pgdump.on('close', (code) => {
      // Only report success once the file is fully flushed to disk.
      if (writeStream.writableFinished || streamError) finalize(code);
      else {
        writeStream.once('finish', () => finalize(code));
        writeStream.once('error', () => finalize(code));
      }
    });

    async function finalize(code) {
      const durationMs = Date.now() - startedAt;

      if (code === 0 && !streamError) {
        // Record the actual on-disk artifact size, not the plaintext dump byte
        // count — the file is [12B IV][ciphertext][16B tag], and a `stat` / `du`
        // during an audit should match what backup_log says.
        let fileBytes = sizeBytes;
        try { fileBytes = fs.statSync(filePath).size; } catch (_) {}
        logger.info(`Backup completed: ${fileName} (${Math.round(fileBytes / 1024)}KB on disk, ${Math.round(sizeBytes / 1024)}KB dump, ${durationMs}ms)`);
        try {
          await query(`
            UPDATE backup_log SET status='success', completed_at=NOW(), size_bytes=$1, duration_ms=$2
            WHERE id=$3
          `, [fileBytes, durationMs, logId]);
          await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='backup'`).catch(() => {});
        } catch (_) {}

        try {
          // .sql.enc only — an old plaintext .sql from before this change is
          // left alone rather than silently swept into the same rotation, and
          // an operator who spots one still lying around knows exactly why.
          const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('medibook_backup_') && f.endsWith('.sql.enc'))
            .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);
          for (const f of files.slice(MAX_BACKUP_FILES)) {
            try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (_) {}
          }
        } catch (_) {}

        resolve({ filePath, sizeBytes, durationMs });
      } else {
        const errMsg = streamError
          ? `backup write failed: ${streamError.message}`
          : `pg_dump exited with code ${code}`;
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
    }

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
