/**
 * Simple in-process metrics counters.
 * Counters reset on process restart — for production use, emit to a time-series store.
 */
const counters = {
  requests_total: 0,
  webhook_messages_total: 0,
  appointments_booked_total: 0,
  bot_errors_total: 0,
  uncaught_exceptions_total: 0,
  unhandled_rejections_total: 0,
};

function increment(key) {
  if (Object.prototype.hasOwnProperty.call(counters, key)) counters[key]++;
}

function getAll() { return { ...counters }; }

module.exports = { increment, getAll };
