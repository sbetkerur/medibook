FROM node:20-alpine

# pg_dump for the backup cron. pg_dump can only dump from a server of the same
# or an older major version, so this client major must keep pace with Railway's
# Postgres (currently 18) — if backup_log starts showing "server version
# mismatch", pin the matching postgresqlNN-client rather than removing this.
RUN apk add --no-cache postgresql-client && pg_dump --version

WORKDIR /app

# Baked into the image rather than left to a Railway service variable. Every
# production guard in the codebase keys on this one value, and they all fail
# OPEN together if it is missing or mistyped: encryption.js accepts the
# published DEFAULT_KEY instead of exiting, migrate.js seeds the well-known
# super-admin password, seed.js creates the demo tenant, the unauthenticated
# /api/webhook/test endpoint (which drives the real bot engine as any phone,
# for any tenant_slug) is exposed, the auth rate limiter turns off, and the
# logger stops writing file transports. Note `npm install --only=production`
# does NOT set runtime NODE_ENV. Railway can still override it for a staging
# service; this only decides the default.
ENV NODE_ENV=production

# Install dependencies first (layer cache).
# `npm ci --omit=dev` over `npm install --only=production`: package-lock.json is
# committed, and ci installs exactly what it pins instead of silently resolving
# newer semver-compatible versions at build time.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy source
COPY src/ ./src/

# Copy entrypoint
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# NOT dropping to USER node yet, deliberately. Two things write at runtime and
# both would need ownership sorted out first, or the container crash-loops:
#   - logger.js does fs.mkdirSync('logs') relative to WORKDIR at module load
#     time in production, and /app is root-owned — every require() of the logger
#     would throw EACCES.
#   - BACKUP_DIR (backupManager.js) defaults to os.tmpdir(), which is fine, but
#     a mounted Railway volume would have to be writable by uid 1000.
# The fix is `RUN mkdir -p /app/logs && chown -R node:node /app` before `USER
# node`, plus confirming the volume's ownership. Worth doing as its own change.

EXPOSE 3001

ENTRYPOINT ["./entrypoint.sh"]
