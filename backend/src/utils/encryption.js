/**
 * Encryption utilities — AES-256-GCM via Node's native crypto module.
 *
 * Format:  v2:<iv_hex>:<ciphertext_hex>:<tag_hex>
 *   - 12-byte random IV per encryption (GCM best practice)
 *   - 16-byte authentication tag (detects tampering)
 *   - No repeated ciphertext for identical plaintexts (IND-CPA secure)
 *
 * Backward-compat: values that don't start with "v2:" are decrypted via the
 * legacy CryptoJS path so existing DB rows keep working until re-encrypted.
 */

const crypto = require('crypto');

const DEFAULT_KEY = 'medibook-default-dev-key-32chars!';
const RAW_KEY = process.env.ENCRYPTION_KEY || DEFAULT_KEY;

// ── Startup validation ────────────────────────────────────────
if (RAW_KEY === DEFAULT_KEY) {
  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.error('FATAL: ENCRYPTION_KEY is the default insecure value in production. Set a strong random key.');
    process.exit(1);
  } else {
    process.nextTick(() => {
      try { require('./logger').warn('ENCRYPTION_KEY is using the default dev value — set a real key before production'); } catch (_) {}
    });
  }
} else if (RAW_KEY.length < 32) {
  const msg = `ENCRYPTION_KEY is too short (${RAW_KEY.length} chars) — use at least 32 characters`;
  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  } else {
    process.nextTick(() => {
      try { require('./logger').warn(msg); } catch (_) {}
    });
  }
}

/**
 * Derive a 32-byte Buffer from the raw key string.
 * - If the key is exactly 64 hex chars → treat as raw 32-byte hex.
 * - Otherwise → SHA-256 hash to normalise any length to 32 bytes.
 */
function getKeyBuffer() {
  if (/^[0-9a-fA-F]{64}$/.test(RAW_KEY)) {
    return Buffer.from(RAW_KEY, 'hex');
  }
  return crypto.createHash('sha256').update(RAW_KEY).digest();
}

// ── Encrypt (AES-256-GCM) ─────────────────────────────────────
function encrypt(text) {
  if (!text) return null;
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(12); // 96-bit IV — recommended for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 128-bit authentication tag
  return `v2:${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

// ── Decrypt (GCM + legacy CryptoJS fallback) ──────────────────
function decrypt(ciphertext) {
  if (!ciphertext) return null;

  // ── New format: v2:<iv>:<data>:<tag> ─────────────────────────
  if (ciphertext.startsWith('v2:')) {
    try {
      const parts = ciphertext.split(':');
      if (parts.length !== 4) return null;
      const [, ivHex, dataHex, tagHex] = parts;
      const key = getKeyBuffer();
      const iv = Buffer.from(ivHex, 'hex');
      const data = Buffer.from(dataHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
      return decrypted.toString('utf8');
    } catch {
      return null; // tampered or wrong key
    }
  }

  // ── Legacy CryptoJS format (ECB) — backward compatibility only ──
  // Used to decrypt values stored before this upgrade. New writes always
  // use AES-256-GCM above. Remove this block once all rows are re-encrypted.
  try {
    const CryptoJS = require('crypto-js');
    const bytes = CryptoJS.AES.decrypt(ciphertext, RAW_KEY);
    const result = bytes.toString(CryptoJS.enc.Utf8);
    return result || null;
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
