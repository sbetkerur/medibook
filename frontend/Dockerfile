# Build v2
# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# BACKEND_URL must be available at build time so Next.js can compile it
# into the routes manifest (rewrites are resolved at build, not runtime).
ARG BACKEND_URL=https://backend-production-7df80.up.railway.app
ENV BACKEND_URL=${BACKEND_URL}

RUN npm run build

# Stage 2: Run (uses Next.js standalone output — much smaller image)
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV BACKEND_URL=https://backend-production-7df80.up.railway.app

# Standalone bundle includes only what's needed to run
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["node", "server.js"]
