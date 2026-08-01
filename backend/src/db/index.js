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
  // Increased from 3s — brief Railway proxy hiccups (DB connection renegotiation,
  // cold-start latency) were causing 3s timeouts to fail spuriously and cascade into
  // bot job failures even when the DB itself was healthy.
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '10000'),
  // Prevent runaway queries from blocking the pool indefinitely.
  // Reduced from 30s — bot queries should never take > 10s; a slow query holding a
  // connection for 30s can starve the pool under concurrent load.
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '10000'),
  // Keep TCP connections alive so Railway's proxy doesn't silently drop idle ones.
  // Without this, an idle pool connection can be killed at the network layer and
  // the next query on it fails with ECONNRESET, which looks like a bot crash.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
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

// PostgreSQL truncates EVERY identifier — including double-quoted ones — to
// NAMEDATALEN-1 = 63 bytes, silently. Two tenants whose schema names differ
// only after byte 63 therefore resolve to the SAME physical schema:
// CREATE SCHEMA IF NOT EXISTS no-ops for the second, its users land in the
// first tenant's tables, and SET LOCAL search_path points both at one schema.
// Every tenancy control in this codebase is downstream of the schema NAME, so
// that single collision defeats all of them at once. Bound it here, where all
// tenant SQL funnels through, rather than trusting each caller.
const MAX_SCHEMA_NAME_LEN = 63;

// Validate schema name to prevent SQL injection via interpolation
function validateSchemaName(schemaName) {
  if (!schemaName || !/^tenant_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error(`Invalid schema name: "${schemaName}"`);
  }
  if (Buffer.byteLength(schemaName, 'utf8') > MAX_SCHEMA_NAME_LEN) {
    throw new Error(
      `Schema name exceeds PostgreSQL's ${MAX_SCHEMA_NAME_LEN}-byte identifier limit ` +
      `and would collide with another tenant after truncation: "${schemaName}"`
    );
  }
}

// Safe tenant query — uses SET LOCAL (transaction-scoped, safe under pooling)
async function tenantQuery(schemaName, sql, params = []) {
  validateSchemaName(schemaName);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schemaName}", public`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // ROLLBACK itself can throw on a broken connection — never let that mask
    // the original query error.
    await client.query('ROLLBACK').catch(() => {});
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
  validateSchemaName(schemaName);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schemaName}", public`);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tenantQuery, tenantTransaction, validateSchemaName };
