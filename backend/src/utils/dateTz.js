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
const IST_MONTH_START_SQL = `date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

module.exports = { toZonedTime, fromZonedTime, IST_TODAY_SQL, IST_MONTH_START_SQL };
