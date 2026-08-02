# Build v2
# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# BACKEND_URL must be available at build time so Next.js can compile it
# into the routes manifest (rewrites are resolved at build, not runtime).
#
# The Railway service variable is what should drive this; the default is only a
# fallback for a build that supplies nothing. It pointed at
# backend-production-7df80 long after that service stopped existing (it answers
# 404 "Application not found"), so any build that fell back to it produced a
# frontend whose every proxied API call failed. Keep this in step with the live
# backend service, or a missing build variable fails silently instead of loudly.
ARG BACKEND_URL=https://backend-production-f66a.up.railway.app
ENV BACKEND_URL=${BACKEND_URL}

RUN npm run build

# Stage 2: Run (uses Next.js standalone output — much smaller image)
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Runtime fallback, same rationale as the build ARG above — the Railway service
# variable overrides it. Was also pointing at the retired 7df80 service.
ENV BACKEND_URL=https://backend-production-f66a.up.railway.app

# Standalone bundle includes only what's needed to run
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["node", "server.js"]
