const { Pool, types } = require('pg');

// Return DATE columns as ISO date strings (e.g. "2024-03-15") instead of
// JavaScript Date objects. Without this, node-pg returns Date objects at
// midnight UTC, which when used in template literals like
// `${a.appointment_date}T${a.appointment_time}` produces invalid ISO strings
// that cause fromZonedTime() to return Invalid Date — breaking the 2-hour
// cancel/reschedule notice check.
types.setTypeParser(1082, (val) => val); // OID 1082 = date

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '20'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 3000,
  // Prevent runaway queries from blocking the pool indefinitely
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000'),
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err.message);
});

// Log a warning when the pool is nearly exhausted (≥ 80% of max connections in use).
// Debounce to 30s to avoid log spam when connections churn rapidly under load.
const POOL_WARN_THRESHOLD = Math.floor((parseInt(process.env.DB_POOL_MAX || '20')) * 0.8);
let _lastPoolWarnTime = 0;
pool.on('connect', () => {
  const total = pool.totalCount;
  const now = Date.now();
  if (total >= POOL_WARN_THRESHOLD && now - _lastPoolWarnTime > 30000) {
    _lastPoolWarnTime = now;
    console.warn(`DB pool nearing capacity: ${total}/${pool.options.max} connections in use`);
  }
});

// Safe tenant query — uses SET LOCAL (transaction-scoped, safe under pooling)
async function tenantQuery(schemaName, sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schemaName}", public`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Public schema query
async function query(sql, params = []) {
  return pool.query(sql, params);
}

// Run multiple queries in a single tenant-scoped transaction.
// callback receives (client) and must call client.query() directly.
async function tenantTransaction(schemaName, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schemaName}", public`);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tenantQuery, tenantTransaction };
