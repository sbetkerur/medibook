const { Pool } = require('pg');

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

// Log a warning when the pool is nearly exhausted (≥ 80% of max connections in use)
// so operators have early warning before requests start timing out.
const POOL_WARN_THRESHOLD = Math.floor((parseInt(process.env.DB_POOL_MAX || '20')) * 0.8);
pool.on('connect', () => {
  const total = pool.totalCount;
  if (total >= POOL_WARN_THRESHOLD) {
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
