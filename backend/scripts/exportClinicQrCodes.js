'use strict';
/**
 * Export every clinic's WhatsApp QR code to disk.
 *
 * Each clinic reaches its patients through one thing: the QR encoding a `wa.me`
 * deep link with its entry code pre-typed (see src/utils/entryCode.js). The
 * dashboard renders that one clinic at a time, which is the wrong shape for
 * onboarding a batch — printing counter cards for twenty clinics, or attaching
 * a PNG to twenty handover emails.
 *
 * Writes, per run:
 *   <out>/<slug>.png    one 800px PNG per clinic, ready to print or send
 *   <out>/<slug>.svg    vector, for anyone sending artwork to a print shop
 *   <out>/index.html    all clinics as printable counter cards, one per page
 *   <out>/clinics.csv   slug, name, code and link — for a mail merge
 *
 * Usage:
 *   node scripts/exportClinicQrCodes.js
 *   node scripts/exportClinicQrCodes.js --out ./qr --number 917795676142 --all
 *
 *   --out <dir>      output directory (default ./qr-codes)
 *   --number <num>   overrides WHATSAPP_PUBLIC_NUMBER
 *   --all            include suspended clinics too (default: active only)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { query, pool } = require('../src/db');
const { buildEntryLink, buildEntryMessage, publicWhatsAppNumber } = require('../src/utils/entryCode');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const INCLUDE_ALL = process.argv.includes('--all');
const OUT_DIR = path.resolve(arg('out', './qr-codes'));

const esc = s => String(s ?? '').replace(/[<>&"]/g, c => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
// Filenames come from the slug, which is already [a-z0-9-], but this is written
// to disk so it is re-checked rather than trusted.
const safeName = s => String(s || 'clinic').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60) || 'clinic';
const csvCell = s => `"${String(s ?? '').replace(/"/g, '""')}"`;

(async () => {
  const number = String(arg('number', publicWhatsAppNumber() || '')).replace(/\D/g, '');
  if (!number) {
    console.error(
      'No WhatsApp number configured.\n' +
      'Every QR encodes wa.me/<number>, so without it the codes would point nowhere.\n' +
      'Set WHATSAPP_PUBLIC_NUMBER in .env, or pass --number 917795676142.'
    );
    process.exit(1);
  }

  const { rows } = await query(`
    SELECT name, slug, entry_code, city, status
      FROM tenants
     ${INCLUDE_ALL ? '' : "WHERE status = 'active'"}
     ORDER BY name
  `);

  if (!rows.length) {
    console.error('No clinics found. Run: npm run migrate && npm run seed');
    process.exit(1);
  }

  // A clinic with no code cannot be reached at all, so it is reported loudly
  // rather than quietly skipped — that is a broken clinic, not an empty row.
  const missing = rows.filter(t => !t.entry_code);
  const usable = rows.filter(t => t.entry_code);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const cards = [];
  for (const t of usable) {
    const link = buildEntryLink(t.entry_code, t.name, number);
    const file = safeName(t.slug);

    // 'Q' error correction (25%): these get printed and live on a reception
    // counter, where a scuffed or partly covered code still has to scan.
    const png = await QRCode.toBuffer(link, { errorCorrectionLevel: 'Q', margin: 2, width: 800 });
    const svg = await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'Q', margin: 2 });
    fs.writeFileSync(path.join(OUT_DIR, `${file}.png`), png);
    fs.writeFileSync(path.join(OUT_DIR, `${file}.svg`), svg);

    cards.push({ ...t, link, dataUri: `data:image/png;base64,${png.toString('base64')}` });
    console.log(`  ${t.entry_code}  ${file}.png  ${t.name}`);
  }

  // One self-contained HTML holding every card — no external files, so it can
  // be emailed or opened straight from the folder and printed in one go.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Clinic QR codes</title>
<style>
  @page { margin: 12mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px;
         color: #111; background: #f5f5f5; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #666; font-size: 13px; margin: 0 0 24px; }
  .card { background: #fff; border: 2px solid #111; border-radius: 18px; padding: 28px 24px;
          max-width: 420px; margin: 0 auto 24px; text-align: center; break-inside: avoid; }
  .card h2 { font-size: 20px; margin: 0 0 2px; }
  .sub { font-size: 13px; color: #555; margin: 0 0 18px; }
  img { width: 260px; height: 260px; }
  .steps { text-align: left; display: inline-block; margin: 16px auto 0; font-size: 13px; line-height: 1.7; }
  .code { margin-top: 14px; font-size: 11px; color: #666; letter-spacing: .09em; }
  @media print {
    body { background: #fff; padding: 0; }
    h1, .meta { display: none; }
    .card { page-break-after: always; margin: 0 auto; border-width: 2px; }
  }
</style></head><body>
<h1>Clinic QR codes</h1>
<p class="meta">${cards.length} clinic${cards.length === 1 ? '' : 's'} &middot; WhatsApp ${esc(number)} &middot; generated ${new Date().toISOString().slice(0, 10)}</p>
${cards.map(c => `<div class="card">
  <h2>${esc(c.name)}</h2>
  <p class="sub">Book your appointment on WhatsApp${c.city ? ` &middot; ${esc(c.city)}` : ''}</p>
  <img src="${c.dataUri}" alt="WhatsApp booking QR code for ${esc(c.name)}">
  <div class="steps">
    1. Open your phone camera<br>
    2. Point it at this code<br>
    3. Tap the WhatsApp link, then press send
  </div>
  <p class="code">No app to install &middot; Code ${esc(c.entry_code)}</p>
</div>`).join('\n')}
</body></html>`;
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);

  const csv = ['slug,name,city,entry_code,link,status']
    .concat(cards.map(c => [c.slug, c.name, c.city || '', c.entry_code, c.link, c.status].map(csvCell).join(',')))
    .join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'clinics.csv'), csv);

  console.log(`\n${cards.length} clinic${cards.length === 1 ? '' : 's'} written to ${OUT_DIR}`);
  console.log(`  index.html   all cards, print-ready (one per page)`);
  console.log(`  clinics.csv  slug, name, code and link`);
  if (missing.length) {
    console.warn(`\n⚠️  ${missing.length} clinic(s) have NO entry code and cannot be reached by patients at all:`);
    for (const t of missing) console.warn(`     ${t.slug} — ${t.name}`);
    console.warn('   Boot the backend once (migrate backfills codes), or regenerate from the clinic dashboard.');
  }
  await pool.end();
})().catch(async err => {
  console.error('Export failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
