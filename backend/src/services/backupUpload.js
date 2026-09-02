'use strict';
/**
 * Push an encrypted backup to S3-compatible object storage, and prune old ones.
 *
 * Why this exists: both backup paths we already have write to storage that dies
 * WITH the thing they protect. jobs/backupManager.js writes to a Railway volume
 * in the same project as the database; scripts/backup-prod.js writes to one
 * laptop that has to be switched on. Neither survives "the Railway account is
 * gone" plus "the laptop is off". An off-site bucket on an unrelated provider
 * (Cloudflare R2, Backblaze B2, AWS S3) does.
 *
 * The uploaded object is the SAME encrypted file the local paths produce
 * ([12-byte IV][AES-256-GCM ciphertext][16-byte tag], ENCRYPTION_KEY) — this
 * module never sees plaintext, and losing ENCRYPTION_KEY still makes every copy
 * unreadable (see scripts/decryptBackup.js). Restore with
 * scripts/restore-prod.js --from-s3.
 *
 * Configuration (all via env; unset BACKUP_S3_BUCKET disables everything here):
 *   BACKUP_S3_BUCKET             required
 *   BACKUP_S3_ACCESS_KEY_ID      required
 *   BACKUP_S3_SECRET_ACCESS_KEY  required
 *   BACKUP_S3_ENDPOINT           required for R2/B2/MinIO; omit for real AWS S3
 *   BACKUP_S3_REGION             default 'auto' (R2); use the real region for S3/B2
 *   BACKUP_S3_PREFIX             default 'medibook-backups/'
 *   BACKUP_S3_KEEP               default 30 — remote retention count
 *   BACKUP_S3_FORCE_PATH_STYLE   default 'true' — needed by B2/MinIO, harmless on R2
 *
 * @aws-sdk/client-s3 is require()d lazily so a deployment that doesn't use this
 * pays nothing for it, and a missing dependency degrades to "off", not a crash.
 */

const fs = require('fs');
const path = require('path');

// Only files this project's backup writers produce — so pruneRemote can never
// delete something else that happens to share the bucket.
const BACKUP_NAME_RE = /^(medibook_backup_.*\.sql\.enc|medibook-prod-.*\.dump\.enc)$/;

function log(...args) {
  try { require('../utils/logger').info(...args); }
  catch (_) { console.log('[backupUpload]', ...args); }
}
function logError(msg, meta) {
  try { require('../utils/logger').error(msg, meta); }
  catch (_) { console.error('[backupUpload]', msg, meta || ''); }
}

function cfg() {
  return {
    bucket: process.env.BACKUP_S3_BUCKET || '',
    accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY || '',
    endpoint: process.env.BACKUP_S3_ENDPOINT || undefined,
    region: process.env.BACKUP_S3_REGION || 'auto',
    prefix: normalisePrefix(process.env.BACKUP_S3_PREFIX || 'medibook-backups/'),
    keep: Math.max(1, parseInt(process.env.BACKUP_S3_KEEP, 10) || 30),
    forcePathStyle: String(process.env.BACKUP_S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
  };
}

function normalisePrefix(p) {
  if (!p) return '';
  return p.replace(/^\/+/, '').replace(/\/*$/, '/');
}

/** True when enough is configured to talk to a bucket. */
function isConfigured() {
  const c = cfg();
  return Boolean(c.bucket && c.accessKeyId && c.secretAccessKey);
}

let _mod = null;
/** Lazy-load the SDK. Returns null (and logs once) if it isn't installed. */
function sdk() {
  if (_mod !== null) return _mod;
  try {
    _mod = require('@aws-sdk/client-s3');
  } catch (_) {
    _mod = false;
    logError(
      '@aws-sdk/client-s3 is not installed — off-site backup upload is disabled. ' +
      'Run `npm install` in backend/ to enable it.'
    );
  }
  return _mod || null;
}

function client() {
  const S3 = sdk();
  if (!S3) return null;
  const c = cfg();
  return new S3.S3Client({
    region: c.region,
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
}

/**
 * Upload one encrypted backup file. Best-effort: never throws — returns
 * { ok, key?, error? } so a caller (a cron) can log and carry on.
 * @param {string} localPath
 * @param {{prefix?: string}} [opts]
 */
async function uploadBackup(localPath, opts = {}) {
  if (!isConfigured()) return { ok: false, error: 'not configured' };
  const S3 = sdk();
  const s3 = client();
  if (!S3 || !s3) return { ok: false, error: 'sdk unavailable' };

  const c = cfg();
  const prefix = opts.prefix != null ? normalisePrefix(opts.prefix) : c.prefix;
  const base = path.basename(localPath);
  const key = prefix + base;

  let size;
  try {
    size = fs.statSync(localPath).size;
  } catch (err) {
    return { ok: false, error: `cannot stat ${localPath}: ${err.message}` };
  }

  try {
    // A plain ReadStream needs ContentLength or the SDK buffers the whole file
    // to compute it — fine for a small DB, but explicit is cheaper and clearer.
    await s3.send(new S3.PutObjectCommand({
      Bucket: c.bucket,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentLength: size,
      ContentType: 'application/octet-stream',
    }));
    log(`Off-site backup uploaded: s3://${c.bucket}/${key} (${Math.round(size / 1024)}KB)`);
    return { ok: true, key, size };
  } catch (err) {
    logError('Off-site backup upload failed', { key, error: err.message });
    return { ok: false, error: err.message, key };
  } finally {
    try { s3.destroy(); } catch (_) {}
  }
}

/**
 * List this project's backup objects, newest first.
 * Throws on API failure (callers that list are doing a restore and must fail loudly).
 * @returns {Promise<Array<{key:string,size:number,lastModified:Date}>>}
 */
async function listRemote(opts = {}) {
  if (!isConfigured()) throw new Error('object storage is not configured (BACKUP_S3_* env)');
  const S3 = sdk();
  const s3 = client();
  if (!S3 || !s3) throw new Error('@aws-sdk/client-s3 is not installed');

  const c = cfg();
  const prefix = opts.prefix != null ? normalisePrefix(opts.prefix) : c.prefix;
  const out = [];
  let ContinuationToken;
  try {
    do {
      const page = await s3.send(new S3.ListObjectsV2Command({
        Bucket: c.bucket, Prefix: prefix, ContinuationToken,
      }));
      for (const obj of page.Contents || []) {
        if (BACKUP_NAME_RE.test(path.posix.basename(obj.Key))) {
          out.push({ key: obj.Key, size: obj.Size, lastModified: obj.LastModified });
        }
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  } finally {
    try { s3.destroy(); } catch (_) {}
  }
  out.sort((a, b) => b.lastModified - a.lastModified);
  return out;
}

/**
 * Delete all but the newest `keep` backup objects. Best-effort — returns
 * { ok, deleted, kept, error? }.
 */
async function pruneRemote(keep, opts = {}) {
  if (!isConfigured()) return { ok: false, error: 'not configured' };
  const S3 = sdk();
  const s3 = client();
  if (!S3 || !s3) return { ok: false, error: 'sdk unavailable' };

  const c = cfg();
  const limit = Math.max(1, keep || c.keep);
  let objects;
  try {
    objects = await listRemote(opts);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const stale = objects.slice(limit);
  if (!stale.length) return { ok: true, deleted: 0, kept: objects.length };

  try {
    // DeleteObjects caps at 1000 keys/request; a backup bucket never approaches
    // that, but chunk anyway rather than assume.
    for (let i = 0; i < stale.length; i += 1000) {
      const chunk = stale.slice(i, i + 1000);
      await s3.send(new S3.DeleteObjectsCommand({
        Bucket: c.bucket,
        Delete: { Objects: chunk.map(o => ({ Key: o.key })), Quiet: true },
      }));
    }
    log(`Off-site retention: ${Math.min(objects.length, limit)} kept, ${stale.length} pruned`);
    return { ok: true, deleted: stale.length, kept: Math.min(objects.length, limit) };
  } catch (err) {
    logError('Off-site backup prune failed', { error: err.message });
    return { ok: false, error: err.message };
  } finally {
    try { s3.destroy(); } catch (_) {}
  }
}

/**
 * Download the newest backup object into `destDir`. Returns the local path.
 * Throws on any failure — this is the restore path.
 */
async function downloadLatest(destDir, opts = {}) {
  const objects = await listRemote(opts);
  if (!objects.length) throw new Error('no backup objects found in the bucket');
  const newest = objects[0];

  const S3 = sdk();
  const s3 = client();
  const c = cfg();
  const dest = path.join(destDir, path.posix.basename(newest.key));

  try {
    const res = await s3.send(new S3.GetObjectCommand({ Bucket: c.bucket, Key: newest.key }));
    await new Promise((resolve, reject) => {
      const w = fs.createWriteStream(dest);
      res.Body.on('error', reject);
      w.on('error', reject);
      w.on('finish', resolve);
      res.Body.pipe(w);
    });
  } finally {
    try { s3.destroy(); } catch (_) {}
  }
  log(`Downloaded newest off-site backup: ${newest.key} -> ${dest}`);
  return dest;
}

module.exports = {
  isConfigured,
  uploadBackup,
  pruneRemote,
  listRemote,
  downloadLatest,
  _cfg: cfg, // exported for tests
};
