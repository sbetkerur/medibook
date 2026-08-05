'use strict';
/**
 * Multi-visit treatment plans — the pure rules.
 *
 * A plan is the HEAD of a course of treatment ("root canal, 3 visits, upper
 * left 6"); each visit is an ordinary appointment carrying `treatment_plan_id`.
 * Progress is DERIVED from those appointments rather than stored on the plan,
 * so a cancelled visit cannot leave a counter claiming work that didn't happen.
 *
 * No DB access here — the arithmetic and the state machine are the parts worth
 * testing on their own, and both routes and the completion hook share them.
 */

const PLAN_STATUSES = ['proposed', 'in_progress', 'completed', 'declined', 'cancelled'];

/**
 * Allowed status moves, in the shape of APPOINTMENT_TRANSITIONS (utils/errors.js)
 * so the two read the same way.
 *
 * `proposed → completed` is legitimate: a single-visit treatment carried out in
 * the same sitting it was advised in is recorded after the fact.
 *
 * `declined` and `cancelled` are terminal. A patient who changes their mind gets
 * a NEW plan rather than a resurrected one — reviving the old row would silently
 * re-date the advice and lose why it was turned down the first time.
 */
const PLAN_TRANSITIONS = {
  proposed:    ['in_progress', 'completed', 'declined', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed:   [],
  declined:    [],
  cancelled:   [],
};

/**
 * Where a plan stands.
 *
 * @param {object} p
 * @param {number} p.totalVisits      - visits the treatment is expected to take
 * @param {number} p.completedVisits  - linked appointments marked completed
 * @param {number} p.bookedVisits     - linked appointments not cancelled
 *                                      (includes the completed ones)
 * @param {number[]} [p.usedVisitNumbers] - visit_number of every NON-CANCELLED
 *   linked appointment. Supply it wherever the result is written to the DB.
 * @returns {{visitsDone:number, visitsBooked:number, visitsUnbooked:number,
 *            nextVisitNumber:number, canBookNext:boolean, isComplete:boolean}}
 */
function planProgress({ totalVisits, completedVisits, bookedVisits, usedVisitNumbers }) {
  const total = Math.max(1, toInt(totalVisits, 1));
  const done = Math.max(0, toInt(completedVisits, 0));
  const booked = Math.max(done, toInt(bookedVisits, 0)); // completed implies booked

  return {
    visitsDone: done,
    visitsBooked: booked,
    // Clamped at 0: a clinic that needed fewer visits than estimated (or booked
    // an extra one) must not show a negative "still to book".
    visitsUnbooked: Math.max(0, total - booked),
    nextVisitNumber: nextFreeVisitNumber(usedVisitNumbers, booked),
    canBookNext: booked < total,
    isComplete: done >= total,
  };
}

/**
 * The ordinal to stamp on the next sitting: the lowest positive integer no
 * LIVE visit already holds.
 *
 * This used to be `bookedVisits + 1`, which is the right way to count progress
 * and the wrong way to derive a label. `bookedVisits` excludes cancellations, so
 * on a 3-visit course with visits 1-2-3 booked, cancelling visit 2 dropped the
 * count to 2 and handed the rebooking the number 3 — which visit 3 already had.
 * Nothing stopped it: the plan's index on treatment_plan_id is not unique. The
 * result was two appointments labelled "visit 3 of 3" in the plan view, the
 * appointment notes, the 24h reminder and the patient's confirmation, with no
 * visit 2 anywhere.
 *
 * Filling the gap rather than taking MAX+1 keeps the label inside the course:
 * MAX+1 would have numbered that same rebooking "visit 4 of 3".
 *
 * Falls back to the old count-based answer when the caller has no list to give,
 * so read-only progress displays need not query for one.
 */
function nextFreeVisitNumber(usedVisitNumbers, bookedVisits) {
  if (!Array.isArray(usedVisitNumbers)) return bookedVisits + 1;
  const taken = new Set(
    usedVisitNumbers.map(n => toInt(n, 0)).filter(n => n > 0)
  );
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

/**
 * The status a plan should hold given its visits — used after a visit is booked
 * or completed, so staff never have to move a plan through its own lifecycle by
 * hand.
 *
 * Returns the CURRENT status unchanged when nothing should move, including from
 * every terminal state: a late completion arriving on a cancelled plan must not
 * quietly reopen it.
 */
function derivePlanStatus(currentStatus, { totalVisits, completedVisits, bookedVisits }) {
  if (!PLAN_TRANSITIONS[currentStatus] || PLAN_TRANSITIONS[currentStatus].length === 0) {
    return currentStatus;
  }
  const { isComplete, visitsBooked } = planProgress({ totalVisits, completedVisits, bookedVisits });
  if (isComplete && PLAN_TRANSITIONS[currentStatus].includes('completed')) return 'completed';
  if (visitsBooked > 0 && PLAN_TRANSITIONS[currentStatus].includes('in_progress')) return 'in_progress';
  return currentStatus;
}

/** Is this status move legal? */
function canTransitionPlan(from, to) {
  return Boolean(PLAN_TRANSITIONS[from]?.includes(to));
}

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  PLAN_STATUSES,
  PLAN_TRANSITIONS,
  planProgress,
  nextFreeVisitNumber,
  derivePlanStatus,
  canTransitionPlan,
};
