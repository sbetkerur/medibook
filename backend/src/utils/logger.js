const winston = require('winston');
const { getRequestId, getTenantId } = require('./requestContext');

// Pulls requestId (and tenantId, once tenant resolution has populated it) out
// of the AsyncLocalStorage context set up in index.js and stamps them onto
// every log line emitted during that request/async chain, so related log
// lines can be correlated end to end. Runs as part of the base logger format
// (before transport-specific formats), so both the JSON file transports and
// the Console transport's printf (which spreads remaining fields into
// `extras`) pick these up automatically.
const addRequestContext = winston.format((info) => {
  const requestId = getRequestId();
  if (requestId) info.requestId = requestId;
  const tenantId = getTenantId();
  if (tenantId) info.tenantId = tenantId;
  return info;
});

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ level, message, timestamp, ...meta }) => {
        const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `${timestamp} ${level}: ${message}${extras}`;
      })
    )
  }),
];

// File transports in production only
if (process.env.NODE_ENV === 'production') {
  const fs = require('fs');
  if (!fs.existsSync('logs')) fs.mkdirSync('logs', { recursive: true });
  transports.push(
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  );
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    addRequestContext(),
    winston.format.json()
  ),
  transports,
});

module.exports = logger;
