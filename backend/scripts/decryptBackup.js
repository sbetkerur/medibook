/**
 * Decrypt a MediBook backup — either source:
 *   - jobs/backupManager.js's nightly in-container dump (medibook_backup_*.sql.enc)
 *   - scripts/backup-prod.js's off-Railway laptop copy (medibook-prod-*.dump.enc)
 *
 * Both use the same on-disk format and the same key (ENCRYPTION_KEY):
 *   [12-byte IV][AES-256-GCM ciphertext][16-byte auth tag]
 *
 *   node scripts/decryptBackup.js <input.enc> [output]
 *
 * Losing or rotating ENCRYPTION_KEY without keeping the old value makes every
 * backup taken under it permanently unreadable — there is no recovery path
 * that doesn't start with the original key. Store it somewhere that survives
 * independently of the server it protects (a password manager, not just the
 * Railway variable).
 *
 * Also exported for scripts/verify-backup.js, which needs to decrypt a backup
 * before it can pg_restore it, and for anything else that needs the same
 * "find ENCRYPTION_KEY, then decrypt" logic without re-deriving it.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * ENCRYPTION_KEY, in priority order: already in the environment, then the
 * backend service's Railway variable (same mechanism backup-prod.js already
 * uses for DATABASE_PUBLIC_URL — no separate credential to manage).
 */
function getEncryptionKey() {
  if (process.env.ENCRYPTION_KEY) return process.env.ENCRYPTION_KEY;
  let out;
  try {
    out = execSync(
      'railway variables --service backend --environment production --kv',
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  } catch (err) {
    // The common failure — CLI not logged in, not linked, or timing out —
    // used to surface as a bare "Command failed" with no hint. Keep stderr so
    // the fix (railway login / link) is actually visible during an incident.
    const detail = String(err.stderr || err.message || '').trim();
    throw new Error(
      `Could not read ENCRYPTION_KEY from Railway (${detail || 'unknown error'}). ` +
      'Run `railway login` and `railway link` to the backend/production service, ' +
      'or set ENCRYPTION_KEY yourself if you have it saved elsewhere (a password manager).'
    );
  }
  const line = out.split(/\r?\n/).find(l => l.startsWith('ENCRYPTION_KEY='));
  if (!line) {
    throw new Error(
      'ENCRYPTION_KEY is not set on the backend service in Railway. ' +
      'Set it there, or provide it via the ENCRYPTION_KEY env var if you have it saved elsewhere.'
    );
  }
  return line.slice(line.indexOf('=') + 1).trim();
}

/** Decrypt an encrypted backup file to `outPath`. Whole-file, not streamed —
 * restores are rare, manual, operator-driven actions, and correctness matters
 * far more here than memory use for what is (for now) a small-to-mid database. */
function decryptFile(inPath, outPath) {
  const data = fs.readFileSync(inPath);
  if (data.length < IV_LEN + TAG_LEN) {
    throw new Error(`${inPath} is too small to be a valid encrypted backup (${data.length} bytes)`);
  }
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(data.length - TAG_LEN);
  const ciphertext = data.subarray(IV_LEN, data.length - TAG_LEN);

  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || getEncryptionKey();
  // Lazy require: only after ENCRYPTION_KEY is set, since utils/encryption.js
  // reads it once at module-load time.
  const { getKeyBuffer } = require(path.join(__dirname, '..', 'src', 'utils', 'encryption'));
  const crypto = require('crypto');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKeyBuffer(), iv);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new Error(
      `Decryption failed — wrong ENCRYPTION_KEY, or the file is corrupted/truncated. (${err.message})`
    );
  }
  fs.writeFileSync(outPath, plaintext);
  return outPath;
}

function defaultOutputPath(inPath) {
  return inPath.endsWith('.enc') ? inPath.slice(0, -4) : `${inPath}.decrypted`;
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node scripts/decryptBackup.js <input.enc> [output]');
    process.exit(1);
  }
  const output = process.argv[3] || defaultOutputPath(input);
  try {
    decryptFile(input, output);
    const size = fs.statSync(output).size;
    console.log(`Decrypted -> ${output} (${size.toLocaleString()} bytes)`);
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { decryptFile, getEncryptionKey, defaultOutputPath };
