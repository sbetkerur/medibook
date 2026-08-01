FROM node:20-alpine

# pg_dump for the backup cron. pg_dump can only dump from a server of the same
# or an older major version, so this client major must keep pace with Railway's
# Postgres (currently 18) — if backup_log starts showing "server version
# mismatch", pin the matching postgresqlNN-client rather than removing this.
RUN apk add --no-cache postgresql-client && pg_dump --version

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm install --only=production --no-audit --no-fund

# Copy source
COPY src/ ./src/

# Copy entrypoint
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

EXPOSE 3001

ENTRYPOINT ["./entrypoint.sh"]
