'use strict';
/**
 * The template contract: docs/whatsapp-templates.md vs. the senders.
 *
 * A template invoked with the wrong number of parameters fails the send
 * ENTIRELY — and the plain-text fallback is then rejected by Meta for anyone
 * outside the 24-hour window, which is everyone these messages target. So a
 * doc that drifts from the code does not degrade the message, it silences it,
 * and nothing in production says so.
 *
 * Also enforces the two Meta body rules that are easy to break by editing copy:
 * no two variables separated by only whitespace, and no body that begins or
 * ends with one. Both were violated the moment the emoji were removed from
 * appointment_confirmed and appointment_reminder_24h — the emoji had been the
 * text between two variables.
 *
 * Run: node tests/templateContract.unit.test.js   (no DB, no network)
 */
const fs = require('fs');
// Normalised: the doc is CRLF and every anchor below matches on a bare \n.
const DOC = fs.readFileSync('C:/claude_projects/medibook/docs/whatsapp-templates.md', 'utf8')
  .split('\r\n').join('\n');

// name -> how many parameters the sender pushes, read off the source.
const SRC = {
  'appointment_confirmed':        ['src/services/whatsapp.js', 'sendBookingConfirmationTemplate'],
  'appointment_reminder_24h':     ['src/jobs/reminders.js', null],
  'appointment_reminder_2h':      ['src/jobs/reminders.js', null],
  'appointment_feedback_request': ['src/jobs/reminders.js', null],
  'appointment_missed_rebook':    ['src/jobs/reminders.js', null],
  'treatment_sitting_reminder':   ['src/jobs/treatmentNudges.js', null],
  'patient_recall_checkup':       ['src/jobs/recalls.js', null],
  'payment_receipt':              ['src/routes/treatmentPlans.js', null],
  'treatment_sitting_booked':     ['src/routes/treatmentPlans.js', null],
  'clinic_staff_alert':           ['src/services/bot/utils.js', null],
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { if (ok) { console.log(`  PASS  ${n}`); pass++; } else { console.log(`  FAIL  ${n} ${x}`); fail++; } };

// Highest {{n}} inside the template's own section of the doc.
function docVars(name) {
  const start = DOC.indexOf('`' + name + '`\n');
  if (start === -1) return null;
  const nextHeading = DOC.indexOf('\n## ', start);
  const section = DOC.slice(start, nextHeading === -1 ? undefined : nextHeading);
  const body = section.match(/\*\*Body\*\*\s*```([\s\S]*?)```/);
  if (!body) return null;
  const nums = [...body[1].matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

// Sample-value lines must equal the variable count, or the form is unsubmittable.
function docSamples(name) {
  const start = DOC.indexOf('`' + name + '`\n');
  const nextHeading = DOC.indexOf('\n## ', start);
  const section = DOC.slice(start, nextHeading === -1 ? undefined : nextHeading);
  const m = section.match(/\*\*Sample values\*\*[^\n]*\n```\n([\s\S]*?)```/);
  if (!m) return null;
  return m[1].trim().split('\n').filter(Boolean).length;
}

console.log('\nDoc vs. code — template parameter counts\n');
for (const [name, [file]] of Object.entries(SRC)) {
  const src = fs.readFileSync('C:/claude_projects/medibook/backend/' + file, 'utf8');
  // A template name appears more than once per file — in the doc-reference
  // comment above the call as well as in the call itself — so every occurrence
  // is tried and the first that yields a parameter block wins. Anchoring on
  // indexOf alone landed on the comment and found nothing.
  let codeCount = null;
  for (let idx = src.indexOf(name); idx !== -1; idx = src.indexOf(name, idx + 1)) {
    // Non-greedy to the FIRST ']' — a parameter entry is `{ type:'text', ... }`
    // and never contains one.
    const m = src.slice(idx, idx + 3000).match(/parameters:\s*\[([\s\S]*?)\]/);
    if (m) { codeCount = (m[1].match(/\{\s*type:\s*'text'/g) || []).length; break; }
  }
  if (codeCount === null && src.indexOf(name) === -1) {
    check(`${name} is sent by ${file}`, false, '→ name not found in source'); continue;
  }

  const documented = docVars(name);
  const samples = docSamples(name);

  check(`${name}: doc {{1}}..{{${documented}}} = code ${codeCount} params`,
    documented !== null && codeCount !== null && documented === codeCount,
    `→ doc ${documented}, code ${codeCount}`);
  if (samples !== null) {
    check(`${name}: ${samples} sample values for ${documented} variables`, samples === documented,
      `→ ${samples} vs ${documented}`);
  }
}

// Meta rejects two adjacent variables, and a body that starts or ends with one.
console.log('\nMeta body rules\n');
for (const name of Object.keys(SRC)) {
  const start = DOC.indexOf('`' + name + '`\n');
  const nextHeading = DOC.indexOf('\n## ', start);
  const section = DOC.slice(start, nextHeading === -1 ? undefined : nextHeading);
  const body = section.match(/\*\*Body\*\*\s*```\n([\s\S]*?)```/);
  if (!body) continue;
  const t = body[1].trim();
  check(`${name}: no adjacent variables`, !/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(t));
  check(`${name}: does not begin or end with a variable`,
    !/^\{\{\d+\}\}/.test(t) && !/\{\{\d+\}\}$/.test(t),
    `→ starts "${t.slice(0, 14)}" ends "${t.slice(-14)}"`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
