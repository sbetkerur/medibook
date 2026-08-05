'use strict';
/**
 * Multi-visit treatment plans — progress arithmetic and the plan state machine.
 *
 * A plan ("root canal, 3 visits") is the head of a course of appointments. Two
 * things carry the weight:
 *
 *  1. Progress is DERIVED from the linked appointments, never stored. A stored
 *     counter drifts the first time a visit is cancelled, and the drift shows up
 *     as a clinic being told a treatment is finished when a visit was called off
 *     — or as a plan vanishing from the "advised but never booked" queue, which
 *     is the report the whole feature exists to produce.
 *  2. Terminal statuses stay terminal. A completion arriving late on a cancelled
 *     plan must not quietly reopen it.
 *
 * Run: node tests/treatmentPlan.unit.test.js
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const {
  planProgress, derivePlanStatus, canTransitionPlan, PLAN_TRANSITIONS,
} = require('../src/utils/treatmentPlan');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`); failed++; }
}

const p = (totalVisits, completedVisits, bookedVisits) =>
  planProgress({ totalVisits, completedVisits, bookedVisits });

console.log('\nTreatment plans — progress and lifecycle\n');

// ── The ordinary course of a root canal ──────────────────────
check('nothing booked yet: all three visits outstanding, next is visit 1',
  p(3, 0, 0), { visitsDone: 0, visitsBooked: 0, visitsUnbooked: 3, nextVisitNumber: 1, canBookNext: true, isComplete: false });
check('first visit booked but not done: next is visit 2',
  p(3, 0, 1), { visitsDone: 0, visitsBooked: 1, visitsUnbooked: 2, nextVisitNumber: 2, canBookNext: true, isComplete: false });
check('two done, third booked: nothing left to book, not yet complete',
  p(3, 2, 3), { visitsDone: 2, visitsBooked: 3, visitsUnbooked: 0, nextVisitNumber: 4, canBookNext: false, isComplete: false });
check('all three done: complete',
  p(3, 3, 3), { visitsDone: 3, visitsBooked: 3, visitsUnbooked: 0, nextVisitNumber: 4, canBookNext: false, isComplete: true });

// ── A cancelled visit is the case a stored counter gets wrong ─
check('cancelling the only booked visit puts the work back on the outstanding list',
  // The appointment row still exists with status cancelled; bookedVisits counts
  // only non-cancelled rows, so the plan is bookable again.
  p(3, 0, 0).canBookNext, true);
check('a cancelled second visit re-opens exactly one slot of work',
  p(3, 1, 1), { visitsDone: 1, visitsBooked: 1, visitsUnbooked: 2, nextVisitNumber: 2, canBookNext: true, isComplete: false });

// ── Reality diverging from the estimate ──────────────────────
check('2 of an estimated 3 visits done is NOT complete, even with nothing booked',
  // Deliberate. "Every booked visit is done" is not the same as "the treatment
  // is finished" — it is the normal state between visits. A dentist who
  // genuinely finished early lowers total_visits, which the PATCH route allows.
  p(3, 2, 2).isComplete, false);
check('an extra visit beyond the estimate never reports negative work left',
  p(2, 3, 3), { visitsDone: 3, visitsBooked: 3, visitsUnbooked: 0, nextVisitNumber: 4, canBookNext: false, isComplete: true });
check('single-visit treatment: one and done',
  p(1, 1, 1), { visitsDone: 1, visitsBooked: 1, visitsUnbooked: 0, nextVisitNumber: 2, canBookNext: false, isComplete: true });

// ── Defensive: counts arriving as strings or nulls from SQL ──
check('COUNT() coming back as a string still computes',
  p('3', '1', '2'), { visitsDone: 1, visitsBooked: 2, visitsUnbooked: 1, nextVisitNumber: 3, canBookNext: true, isComplete: false });
check('null counts (no linked appointments) read as zero',
  p(2, null, null), { visitsDone: 0, visitsBooked: 0, visitsUnbooked: 2, nextVisitNumber: 1, canBookNext: true, isComplete: false });
check('completed can never exceed booked in the output',
  // A completed visit is by definition booked; trusting a caller that says
  // otherwise would make nextVisitNumber collide with an existing visit.
  p(3, 2, 0).visitsBooked, 2);

// ── The ordinal a new sitting gets ───────────────────────────
// Counting non-cancelled visits is the right way to measure PROGRESS and the
// wrong way to pick a LABEL: cancel a middle sitting and the count hands the
// replacement a number an existing visit already holds. Nothing in the schema
// stopped that, so the plan view, the appointment notes, the reminder and the
// patient's confirmation all showed two "visit 3 of 3" and no visit 2.
const used = (totalVisits, completedVisits, bookedVisits, usedVisitNumbers) =>
  planProgress({ totalVisits, completedVisits, bookedVisits, usedVisitNumbers });

check('REGRESSION: cancelling the middle sitting does not reuse visit 3',
  used(3, 0, 2, [1, 3]).nextVisitNumber, 2);
check('REGRESSION: cancelling the first sitting does not reuse visit 2',
  used(3, 0, 1, [2]).nextVisitNumber, 1);
check('an untouched course still starts at 1', used(3, 0, 0, []).nextVisitNumber, 1);
check('the ordinary case is unchanged', used(3, 1, 2, [1, 2]).nextVisitNumber, 3);
check('the gap is filled rather than taking MAX+1 — the label stays inside the course',
  used(3, 0, 2, [1, 3]).nextVisitNumber <= 3, true);
check('a cancellation still puts the work back on the queue',
  used(3, 0, 2, [1, 3]).canBookNext, true);
check('legacy rows with no visit_number do not consume an ordinal',
  used(3, 0, 1, []).nextVisitNumber, 1);
check('junk in the used list is ignored rather than shifting the ordinal',
  used(3, 0, 1, [null, 0, -2, 'x']).nextVisitNumber, 1);
check('omitting the list falls back to the count-based answer',
  p(3, 0, 1).nextVisitNumber, 2);

// ── Status derivation ────────────────────────────────────────
check('booking the first visit moves a proposed plan to in_progress',
  derivePlanStatus('proposed', { totalVisits: 3, completedVisits: 0, bookedVisits: 1 }), 'in_progress');
check('a proposed plan with nothing booked stays proposed',
  derivePlanStatus('proposed', { totalVisits: 3, completedVisits: 0, bookedVisits: 0 }), 'proposed');
check('completing the last visit completes the plan',
  derivePlanStatus('in_progress', { totalVisits: 2, completedVisits: 2, bookedVisits: 2 }), 'completed');
check('a single-visit treatment done in the same sitting completes straight from proposed',
  derivePlanStatus('proposed', { totalVisits: 1, completedVisits: 1, bookedVisits: 1 }), 'completed');
check('mid-course stays in_progress',
  derivePlanStatus('in_progress', { totalVisits: 3, completedVisits: 1, bookedVisits: 2 }), 'in_progress');

// ── Terminal states are terminal ─────────────────────────────
check('a late completion does NOT reopen a cancelled plan',
  derivePlanStatus('cancelled', { totalVisits: 2, completedVisits: 2, bookedVisits: 2 }), 'cancelled');
check('a declined plan is not revived by a booking',
  derivePlanStatus('declined', { totalVisits: 2, completedVisits: 0, bookedVisits: 1 }), 'declined');
check('a completed plan stays completed',
  derivePlanStatus('completed', { totalVisits: 3, completedVisits: 1, bookedVisits: 1 }), 'completed');

check('cancelled has no way out', PLAN_TRANSITIONS.cancelled, []);
check('declined has no way out', PLAN_TRANSITIONS.declined, []);
check('in_progress cannot be declined — the patient already started',
  canTransitionPlan('in_progress', 'declined'), false);
check('in_progress can still be cancelled', canTransitionPlan('in_progress', 'cancelled'), true);
check('a completed plan cannot go back to in_progress',
  canTransitionPlan('completed', 'in_progress'), false);
check('an unknown status transitions nowhere', canTransitionPlan('nonsense', 'completed'), false);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
