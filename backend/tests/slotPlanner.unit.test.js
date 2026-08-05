'use strict';
/**
 * planDoctorSlots decides which slots exist. Two rules matter:
 *
 *  1. TODAY is included, but only the slots still ahead of the current IST
 *     time. Starting at tomorrow meant a dentist added this morning had no
 *     bookable slots at all until the 23:30 cron ran.
 *  2. Leaves and holidays block a whole day, on every path — this planner is
 *     shared by the nightly sweep and the per-doctor regeneration precisely so
 *     the two cannot drift.
 *
 * Run: node tests/slotPlanner.unit.test.js
 */
const { planDoctorSlots, computeDaySlotTimes, weekOfMonth, matchesWeekOfMonth } = require('../src/jobs/slotGenerator');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`); failed++; }
}

// A doctor working every day, 10:00–13:00, 60-minute slots → 10:00, 11:00, 12:00
const doc = {
  hospital_id: 'h1',
  duration: 60,
  schedules: [0, 1, 2, 3, 4, 5, 6].map(dow => ({
    dow, start: '10:00', end: '13:00', lunchStart: null, lunchEnd: null,
  })),
};
const never = () => false;
// Fixed "IST now" so the test does not depend on when it runs.
const at = (hhmm) => new Date(`2026-03-10T${hhmm}:00`);
const onDay = (planned, dateStr) => planned.filter(p => p.dateStr === dateStr).map(p => p.st);

console.log('\nplanDoctorSlots — same-day generation and blocked days\n');

// ── Day 0 is generated, from the current time forward ────────
check('mid-morning keeps only later slots today',
  onDay(planDoctorSlots(doc, at('10:30'), 2, never), '2026-03-10'), ['11:00', '12:00']);
check('before opening keeps the whole day',
  onDay(planDoctorSlots(doc, at('07:00'), 2, never), '2026-03-10'), ['10:00', '11:00', '12:00']);
check('after closing keeps nothing today',
  onDay(planDoctorSlots(doc, at('18:00'), 2, never), '2026-03-10'), []);
// A slot starting exactly now is already gone — booking rejects start_time <= now.
check('slot starting exactly now is excluded',
  onDay(planDoctorSlots(doc, at('11:00'), 2, never), '2026-03-10'), ['12:00']);

// ── Future days are unaffected by the time of day ────────────
check('tomorrow is always full',
  onDay(planDoctorSlots(doc, at('18:00'), 2, never), '2026-03-11'), ['10:00', '11:00', '12:00']);
check('horizon covers today plus N days',
  [...new Set(planDoctorSlots(doc, at('07:00'), 2, never).map(p => p.dateStr))],
  ['2026-03-10', '2026-03-11', '2026-03-12']);

// ── Blocked days ─────────────────────────────────────────────
const blockToday = (d) => d === '2026-03-10';
check('a leave/holiday on today blocks it entirely',
  onDay(planDoctorSlots(doc, at('07:00'), 2, blockToday), '2026-03-10'), []);
check('blocking today does not affect tomorrow',
  onDay(planDoctorSlots(doc, at('07:00'), 2, blockToday), '2026-03-11'), ['10:00', '11:00', '12:00']);
check('every day blocked yields nothing',
  planDoctorSlots(doc, at('07:00'), 5, () => true), []);

// ── Days the doctor does not work are skipped ────────────────
const tuesdayOnly = { ...doc, schedules: [{ dow: 2, start: '10:00', end: '13:00', lunchStart: null, lunchEnd: null }] };
// 2026-03-10 is a Tuesday; 2026-03-11 a Wednesday.
check('non-working day produces no slots',
  [...new Set(planDoctorSlots(tuesdayOnly, at('07:00'), 3, never).map(p => p.dateStr))], ['2026-03-10']);

// ── The slot arithmetic itself still honours lunch ───────────
check('lunch window is skipped',
  computeDaySlotTimes('10:00', '14:00', 60, '12:00', '13:00').map(s => s.st),
  ['10:00', '11:00', '13:00']);

// ── Visiting consultants ─────────────────────────────────────
// The specialist who comes on the 1st and 3rd Saturday, or does Monday at one
// branch and Wednesday at another. Both are the norm in Indian dental practice.

// March 2026: Saturdays fall on the 7th (1st), 14th (2nd), 21st (3rd), 28th (4th).
check('the 7th is the 1st Saturday of the month', weekOfMonth(new Date('2026-03-07T00:00:00')), 1);
check('the 21st is the 3rd Saturday', weekOfMonth(new Date('2026-03-21T00:00:00')), 3);
check('the 1st of a month is always week 1', weekOfMonth(new Date('2026-03-01T00:00:00')), 1);
check('the 29th is week 5', weekOfMonth(new Date('2026-03-29T00:00:00')), 5);

// FAIL OPEN. Every schedule row that predates this column has no restriction,
// and reading "no restriction" as "no weeks" would silently erase the calendar
// of every dentist in every clinic.
check('no restriction means every week (null)', matchesWeekOfMonth(null, new Date('2026-03-14T00:00:00')), true);
check('no restriction means every week (empty array)', matchesWeekOfMonth([], new Date('2026-03-14T00:00:00')), true);
check('malformed value does not blank the calendar', matchesWeekOfMonth('1,3', new Date('2026-03-14T00:00:00')), true);

const alternateSaturdays = {
  ...doc,
  schedules: [{ dow: 6, start: '10:00', end: '13:00', lunchStart: null, lunchEnd: null, weeksOfMonth: [1, 3] }],
};
check('a 1st-and-3rd-Saturday consultant generates only those Saturdays',
  // From Tue 10 Mar over 25 days: Saturdays 14th (2nd), 21st (3rd), 4th Apr (1st).
  [...new Set(planDoctorSlots(alternateSaturdays, at('07:00'), 25, never).map(p => p.dateStr))],
  ['2026-03-21', '2026-04-04']);

const everySaturday = {
  ...doc,
  schedules: [{ dow: 6, start: '10:00', end: '13:00', lunchStart: null, lunchEnd: null }],
};
check('without the restriction the same doctor gets EVERY Saturday',
  [...new Set(planDoctorSlots(everySaturday, at('07:00'), 25, never).map(p => p.dateStr))],
  ['2026-03-14', '2026-03-21', '2026-03-28', '2026-04-04']);

// ── Per-day branch ───────────────────────────────────────────
const twoBranches = {
  hospital_id: 'h1',
  duration: 60,
  schedules: [
    { dow: 1, start: '10:00', end: '11:00', lunchStart: null, lunchEnd: null, hospitalId: 'h2' },
    { dow: 3, start: '10:00', end: '11:00', lunchStart: null, lunchEnd: null }, // primary
  ],
};
const planned = planDoctorSlots(twoBranches, at('07:00'), 7, never);
check('Monday is stamped with the visiting branch',
  planned.filter(p => p.dateStr === '2026-03-16').map(p => p.hospitalId), ['h2']);
check('Wednesday falls back to the primary branch',
  planned.filter(p => p.dateStr === '2026-03-11').map(p => p.hospitalId), ['h1']);

// A holiday at one branch must not close the day the doctor spends at the other.
const h2Closed = (dateStr, hospitalId) => hospitalId === 'h2';
const afterHoliday = planDoctorSlots(twoBranches, at('07:00'), 7, h2Closed);
check('a holiday at the visiting branch blocks only that day',
  [...new Set(afterHoliday.map(p => p.dateStr))], ['2026-03-11']);

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
