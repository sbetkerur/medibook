'use strict';
// Compatibility shim for date-fns-tz v2 and v3
// v2 uses: utcToZonedTime, zonedTimeToUtc
// v3 uses: toZonedTime, fromZonedTime
const dateFnsTz = require('date-fns-tz');

const toZonedTime = dateFnsTz.toZonedTime || dateFnsTz.utcToZonedTime;
const fromZonedTime = dateFnsTz.fromZonedTime || dateFnsTz.zonedTimeToUtc;

module.exports = { toZonedTime, fromZonedTime };
