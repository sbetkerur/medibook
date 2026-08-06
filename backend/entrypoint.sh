#!/bin/sh
set -e

# pg_isready over spawning a full Node process 30 times — the client is already
# in the image for the backup cron. DATABASE_URL is understood directly.
echo "⏳ Waiting for PostgreSQL..."
db_ready=""
for i in $(seq 1 30); do
  if pg_isready -d "$DATABASE_URL" -q; then
    db_ready="yes"
    break
  fi
  echo "  Retry $i/30..."
  sleep 2
done

# The old loop ended in `|| { echo ...; sleep 2; }`, which made the LAST
# iteration exit 0 even when all 30 probes had failed — so `set -e` never fired
# and migrations ran against a database we already knew was unreachable, failing
# later and less legibly. Fail here, where the cause is still obvious.
if [ -z "$db_ready" ]; then
  echo "❌ PostgreSQL unreachable after 30 attempts — check DATABASE_URL."
  exit 1
fi

echo "Running migrations..."
node src/db/migrate.js

# Seeding is genuinely optional (prod sets SEED_DEMO_DATA=false and seed.js
# no-ops), so a non-zero exit must not stop the boot. But the old
# `|| echo "Seed skipped (may already exist)"` printed the same reassuring line
# for every possible failure, including seed.js's deliberate refusal to run with
# SEED_DEMO_DATA=true and no DEMO_ADMIN_PASSWORD. Report the actual status.
echo "Seeding initial data..."
seed_status=0
node src/db/seed.js || seed_status=$?
if [ "$seed_status" -eq 0 ]; then
  echo "Seed complete."
else
  echo "⚠️  Seed exited $seed_status — continuing boot. Check the lines above if this was not expected."
fi

echo "Starting MediBook API..."
exec node src/index.js
