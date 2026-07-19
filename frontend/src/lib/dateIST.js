// IST date helpers — the product timezone is Asia/Kolkata regardless of the
// device timezone (reception displays / laptops may be set to UTC or abroad).
// Using the browser's local date for "today" showed the wrong day's queue
// between local midnight and 05:30 IST.
const IST = 'Asia/Kolkata';

/** Today's date in IST as 'yyyy-MM-dd' (en-CA locale formats as YYYY-MM-DD). */
export function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(new Date());
}

/** Human-readable "today" in IST, e.g. "Saturday, 19 July 2026". */
export function todayISTDisplay() {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: IST,
  }).format(new Date());
}
