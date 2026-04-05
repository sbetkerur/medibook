FROM node:20-alpine

# Install postgresql-client for pg_dump (used by backup cron)
RUN apk add --no-cache postgresql-client

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
