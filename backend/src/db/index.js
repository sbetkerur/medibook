const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err.message);
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

module.exports = { pool, query, tenantQuery };
