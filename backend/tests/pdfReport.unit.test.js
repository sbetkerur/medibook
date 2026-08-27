'use strict';
/**
 * The shared PDF plumbing behind the on-demand front-desk reports
 * (src/utils/pdfReport.js): the daily schedule, unconfirmed list, day-close and
 * pending-requests PDFs all stream through `streamReport` + `drawTable`.
 *
 * These assert the mechanics that are easy to break silently:
 *   - a real, non-empty PDF actually reaches the response stream
 *   - a table longer than one page paginates instead of overflowing
 *   - money renders with the ₹ sign and Indian digit grouping (the embedded
 *     Noto Sans has the U+20B9 glyph; pdfkit's built-in Helvetica does not, so
 *     this only works because streamReport registers the TTF)
 *   - the embedded font actually lands in the PDF (a FontFile2 stream)
 *   - the Content-Disposition filename is sanitised
 *
 * Run: node tests/pdfReport.unit.test.js   (no Postgres/Redis required)
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const { Writable } = require('stream');
const { streamReport, drawTable, rupees, istStamp } = require('../src/utils/pdfReport');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (err) { console.log(`  ❌ ${name}: ${err.message}`); fail++; }
}

// Collect a streamed PDF into a Buffer, capturing headers set along the way.
function renderToBuffer(meta, body) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const headers = {};
    const res = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
    res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
    res.headersSent = false;
    res.on('finish', () => resolve({ buf: Buffer.concat(chunks), headers }));
    res.on('error', reject);
    try { streamReport(res, meta, body); } catch (err) { reject(err); }
  });
}

(async () => {
  console.log('PDF report unit tests\n');

  await test('streamReport emits a valid, non-empty PDF', async () => {
    const { buf } = await renderToBuffer(
      { clinicName: 'Smile Dental', title: 'Today’s Schedule', filename: 'schedule-2026-08-27' },
      doc => doc.text('One line of body copy.')
    );
    assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-', 'missing PDF magic bytes');
    assert.ok(buf.length > 500, `PDF unexpectedly small: ${buf.length} bytes`);
    assert.ok(buf.slice(-8).toString().includes('%%EOF'), 'PDF not terminated with %%EOF');
  });

  await test('sets an application/pdf content type and a sanitised filename', async () => {
    const { headers } = await renderToBuffer(
      { clinicName: 'X', title: 'Y', filename: 'day-close/../secret 2026' },
      doc => doc.text('.')
    );
    assert.strictEqual(headers['content-type'], 'application/pdf');
    const m = headers['content-disposition'].match(/^attachment; filename="(.+)"$/);
    assert.ok(m, `unexpected disposition: ${headers['content-disposition']}`);
    assert.match(m[1], /^[\w.-]+\.pdf$/, `filename not sanitised: ${m[1]}`);
  });

  await test('a table longer than one page paginates', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      time: `10:${String(i % 60).padStart(2, '0')}`,
      patient: `Patient number ${i} with a deliberately long name to force wrapping`,
      status: i % 3 ? 'confirmed' : 'completed',
    }));
    const { buf } = await renderToBuffer(
      { clinicName: 'Smile Dental', title: 'Schedule', filename: 's' },
      doc => drawTable(doc, [
        { key: 'time', label: 'Time', width: 5 },
        { key: 'patient', label: 'Patient', width: 20 },
        { key: 'status', label: 'Status', width: 7 },
      ], rows)
    );
    // "Page 1 of N" is stamped once per page with N > 1; the /Count entry in the
    // Pages tree is the load-bearing signal that more than one page was added.
    const text = buf.toString('latin1');
    const m = text.match(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/);
    assert.ok(m, 'no Pages tree found in PDF');
    assert.ok(Number(m[1]) >= 2, `expected multi-page output, got Count ${m && m[1]}`);
  });

  await test('rupees() renders the ₹ sign and Indian digit grouping', () => {
    assert.strictEqual(rupees(1500), '₹1,500');
    assert.strictEqual(rupees(1234567), '₹12,34,567');
    assert.strictEqual(rupees(0), '₹0');
    assert.strictEqual(rupees(null), '₹0');
    assert.strictEqual(rupees('900.7'), '₹901');
  });

  await test('the embedded font is subset into the PDF (FontFile2 stream)', async () => {
    const { buf } = await renderToBuffer(
      { clinicName: 'Smile Dental', title: 'Day Close', filename: 'd' },
      doc => doc.text(`Collected: ${rupees(1234567)}`)
    );
    const text = buf.toString('latin1');
    assert.ok(/FontFile2/.test(text), 'no embedded TrueType font found in PDF');
    assert.ok(/NotoSans/.test(text), 'embedded font is not Noto Sans');
  });

  await test('istStamp() is defensive about bad input', () => {
    assert.match(istStamp(new Date('2026-08-27T12:00:00Z')), /2026/);
    assert.strictEqual(typeof istStamp('not a date'), 'string');
    assert.strictEqual(typeof istStamp(undefined), 'string');
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
