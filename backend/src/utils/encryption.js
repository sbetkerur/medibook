const CryptoJS = require('crypto-js');

const DEFAULT_KEY = 'medibook-default-dev-key-32chars!';
const KEY = process.env.ENCRYPTION_KEY || DEFAULT_KEY;

// Startup key validation
if (KEY === DEFAULT_KEY) {
  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.error('FATAL: ENCRYPTION_KEY is the default insecure value in production. Set a strong 32-char key in environment variables.');
    process.exit(1);
  } else {
    // Lazy require to avoid circular dependency at module load time
    process.nextTick(() => {
      try { require('./logger').warn('ENCRYPTION_KEY is using the default dev value — set a real key before production'); } catch (_) {}
    });
  }
}

// Minimum key length check (applies only to custom keys, not the default placeholder)
if (KEY !== DEFAULT_KEY && KEY.length < 32) {
  const msg = `ENCRYPTION_KEY is too short (${KEY.length} chars) — use at least 32 characters for adequate security`;
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

function encrypt(text) {
  if (!text) return null;
  return CryptoJS.AES.encrypt(text, KEY).toString();
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, KEY);
    return bytes.toString(CryptoJS.enc.Utf8) || null;
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt, KEY };
