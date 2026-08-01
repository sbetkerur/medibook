'use strict';
// Compatibility shim for date-fns-tz v2 and v3
// v2 uses: utcToZonedTime, zonedTimeToUtc
// v3 uses: toZonedTime, fromZonedTime
const dateFnsTz = require('date-fns-tz');

const toZonedTime = dateFnsTz.toZonedTime || dateFnsTz.utcToZonedTime;
const fromZonedTime = dateFnsTz.fromZonedTime || dateFnsTz.zonedTimeToUtc;

// ── SQL date expressions ──────────────────────────────────────
// Servers run UTC; the product is IST. `CURRENT_DATE` is therefore a day behind
// IST between 00:00 and 05:30 IST, so using it for "today" showed the previous
// day's appointments/slots for the first 5.5 hours of every clinic day.
// Inline these instead of CURRENT_DATE / date_trunc('month', NOW()) in any query
// that means "the current calendar day/month for the clinic".
const IST_TODAY_SQL = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

// For comparing against a DATE column.
const IST_MONTH_START_SQL = `date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

// For comparing against a TIMESTAMPTZ column (created_at and friends).
// IST_MONTH_START_SQL must NOT be used for this: comparing a timestamptz to a
// date coerces the date at the SERVER timezone (UTC), which lands on 05:30 IST
// on the 1st — reintroducing the same 5.5-hour skew the constants exist to
// prevent. timezone('Asia/Kolkata', ts) reads the IST wall-clock month start
// back as a proper timestamptz.
const IST_MONTH_START_TS_SQL = `timezone('Asia/Kolkata', date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata'))`;

module.exports = {
  toZonedTime, fromZonedTime,
  IST_TODAY_SQL, IST_MONTH_START_SQL, IST_MONTH_START_TS_SQL,
};
