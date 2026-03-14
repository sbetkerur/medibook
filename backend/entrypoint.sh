#!/bin/sh
set -e

echo "⏳ Waiting for PostgreSQL..."
for i in $(seq 1 30); do
  node -e "
    const { Pool } = require('pg');
    const p = new Pool({ connectionString: process.env.DATABASE_URL });
    p.query('SELECT 1')
      .then(() => { p.end(); process.exit(0); })
      .catch(() => process.exit(1));
  " && break || { echo "  Retry $i/30..."; sleep 2; }
done

echo "Running migrations..."
node src/db/migrate.js

echo "Seeding initial data..."
node src/db/seed.js || echo "Seed skipped (may already exist)"

echo "Starting MediBook API..."
exec node src/index.js
