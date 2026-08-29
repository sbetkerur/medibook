# ── pg_dump 18 for the backup cron ───────────────────────────────────────────
# pg_dump refuses to dump from a server NEWER than itself. Railway runs
# Postgres 18, but Alpine's `postgresql-client` metapackage lagged at 16/17, so
# every nightly backup was exiting 1 with "server version mismatch" (backup_log
# / cron_jobs.last_error). Alpine has no pg18 client in a stable repo yet, so
# take just the pg_dump 18 BINARY from the official postgres:18-alpine image
# (same musl/Alpine ABI) and let it link Alpine's own libpq — pg_dump only uses
# libpq's stable public API and gates on the SERVER version, not libpq's, so a
# pg18 pg_dump with Alpine's slightly-older libpq is fine. Copying pg18's own
# libpq instead drags in a GSSAPI/LDAP-enabled build whose krb5/openldap
# sonames aren't in this base. Bump the tag when Railway's Postgres major moves.
FROM postgres:18-alpine AS pgclient

FROM node:20-alpine

COPY --from=pgclient /usr/local/bin/pg_dump /usr/local/bin/pg_dump
# `pg_dump --version` here fails the build if a .so is missing, so a broken
# image never reaches prod.
RUN apk add --no-cache libpq zstd-libs lz4-libs && pg_dump --version

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
