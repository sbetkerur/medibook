'use strict';
/**
 * Shared PDF plumbing for the on-demand front-desk reports (src/routes/reports.js,
 * plus the ?format=pdf arms of /day-close and /requests).
 *
 * Nothing here is stored — every caller streams straight to the Express
 * response. Reports are read views the desk prints when closing up, so the
 * routes that use this are NOT adminOnly; the bulk PHI extract that IS
 * (/analytics/export) does not go through here.
 *
 * Fonts: Noto Sans (regular + bold) is embedded and subset into every report so
 * the ₹ sign renders — pdfkit's built-in Helvetica (AFM, WinAnsi) has no glyph
 * for U+20B9 and would silently drop it. The two TTFs live in src/assets/fonts
 * so `COPY src/ ./src/` in the Dockerfile picks them up. Callers use the logical
 * names 'body' and 'bold', never 'Helvetica'.
 */
const path = require('path');
const PDFDocument = require('pdfkit');
const { format } = require('date-fns');
const { toZonedTime } = require('./dateTz');

const IST = 'Asia/Kolkata';
const PAGE_MARGIN = 40;
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'NotoSans-Regular.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'NotoSans-Bold.ttf');

function rupees(n) {
  return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
}

function istStamp(d = new Date()) {
  try {
    return format(toZonedTime(d instanceof Date ? d : new Date(d), IST), "d MMM yyyy, HH:mm 'IST'");
  } catch {
    return '';
  }
}

function prettyDate(dateStr) {
  try {
    return format(new Date(dateStr + 'T00:00:00'), 'EEEE, d MMMM yyyy');
  } catch {
    return dateStr;
  }
}

/**
 * A minimal table. `columns` is [{ key, label, width, align }] — widths are
 * relative and scaled to fill the page. Handles the header row, zebra striping,
 * cell wrapping and page breaks (the header repeats on each new page).
 */
function drawTable(doc, columns, rows, opts = {}) {
  const startX = doc.page.margins.left;
  const usableW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const declared = columns.reduce((s, c) => s + (c.width || 1), 0);
  const scale = usableW / declared;
  const cols = columns.map(c => ({ ...c, w: (c.width || 1) * scale }));
  const fontSize = opts.fontSize || 9;
  const pad = 4;

  function headerRow() {
    const y = doc.y;
    doc.save().rect(startX, y, usableW, 18).fill('#eef0f2').restore();
    let x = startX;
    doc.font('bold').fontSize(fontSize).fillColor('#333');
    for (const c of cols) {
      doc.text(c.label, x + pad, y + 5, { width: c.w - pad * 2, align: c.align || 'left', lineBreak: false });
      x += c.w;
    }
    doc.y = y + 18;
    doc.fillColor('#000');
  }

  headerRow();
  doc.font('body').fontSize(fontSize);

  rows.forEach((row, i) => {
    const texts = cols.map(c => (row[c.key] == null ? '' : String(row[c.key])));
    let rowH = fontSize + pad * 2;
    texts.forEach((t, ci) => {
      const h = doc.heightOfString(t, { width: cols[ci].w - pad * 2 }) + pad * 2;
      if (h > rowH) rowH = h;
    });
    if (doc.y + rowH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      headerRow();
      doc.font('body').fontSize(fontSize);
    }
    const y = doc.y;
    if (i % 2 === 1) doc.save().rect(startX, y, usableW, rowH).fill('#fafbfc').restore();
    let x = startX;
    doc.fillColor('#000');
    cols.forEach((c, ci) => {
      doc.text(texts[ci], x + pad, y + pad, { width: c.w - pad * 2, align: c.align || 'left' });
      x += c.w;
    });
    doc.y = y + rowH;
  });

  doc.save().moveTo(startX, doc.y).lineTo(startX + usableW, doc.y).lineWidth(0.5).stroke('#cccccc').restore();
  doc.moveDown(0.6);
}

/** A "Label: value" line pair used by the day-close summary blocks. */
function kv(doc, label, value, opts = {}) {
  doc.font('body').fontSize(opts.size || 10).fillColor('#555').text(label, { continued: true });
  doc.font(opts.bold ? 'bold' : 'body').fillColor('#000').text('  ' + value);
}

/**
 * Open an A4 report, draw the clinic/title band, run `render(doc)` for the body,
 * stamp page numbers, and end the stream. `res` must not have been written to.
 */
function streamReport(res, meta, render) {
  const { clinicName, branchName, phone, title, subtitle, filename } = meta;
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  doc.registerFont('body', FONT_REGULAR);
  doc.registerFont('bold', FONT_BOLD);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${String(filename || 'report').replace(/[^\w.-]/g, '_')}.pdf"`
  );
  doc.pipe(res);

  doc.font('bold').fontSize(16).fillColor('#000').text(clinicName || 'Clinic');
  const sub = [branchName, phone].filter(Boolean).join('   ·   ');
  if (sub) doc.font('body').fontSize(9).fillColor('#666').text(sub);
  doc.moveDown(0.6);
  doc.font('bold').fontSize(13).fillColor('#000').text(title);
  if (subtitle) doc.font('body').fontSize(9).fillColor('#555').text(subtitle);
  doc.font('body').fontSize(8).fillColor('#999').text(`Generated ${istStamp()}`);
  doc.moveDown(1);
  doc.fillColor('#000');

  render(doc);

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc
      .font('body')
      .fontSize(8)
      .fillColor('#999')
      .text(
        `Page ${i + 1} of ${range.count}`,
        doc.page.margins.left,
        doc.page.height - doc.page.margins.bottom + 12,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center' }
      );
  }

  doc.end();
}

module.exports = { streamReport, drawTable, kv, rupees, istStamp, prettyDate };
