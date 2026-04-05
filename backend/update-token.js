/**
 * Run this script whenever you get a new Meta access token:
 *   node update-token.js <new_token>
 *
 * Updates the .env file with the new token (shared across all tenants).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const newToken = process.argv[2];
if (!newToken || newToken.length < 20) {
  console.error('Usage: node update-token.js <new_meta_access_token>');
  process.exit(1);
}

async function run() {
  // 1. Validate the token against Meta before saving anything
  const https = require('https');
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const valid = await new Promise((resolve) => {
    const url = `https://graph.facebook.com/v21.0/${phoneId}?access_token=${newToken}`;
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const j = JSON.parse(d);
        resolve(!j.error);
      });
    }).on('error', () => resolve(false));
  });

  if (!valid) {
    console.error('❌ Token validation failed — token is invalid or expired. Get a fresh one from developers.facebook.com');
    process.exit(1);
  }
  console.log('✅ Token validated with Meta API');

  // 2. Update .env file (the single source of truth for the shared token)
  const envPath = path.join(__dirname, '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  if (envContent.includes('META_ACCESS_TOKEN=')) {
    envContent = envContent.replace(/META_ACCESS_TOKEN=.*/, `META_ACCESS_TOKEN=${newToken}`);
  } else {
    envContent += `\nMETA_ACCESS_TOKEN=${newToken}`;
  }
  fs.writeFileSync(envPath, envContent);
  console.log('✅ .env updated');

  console.log('\n✅ Done. Restart the server: pm2 restart medibook-backend');
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
