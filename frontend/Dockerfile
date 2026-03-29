# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# BACKEND_URL is consumed by Next.js rewrites at request time (server-side),
# not baked into the JS bundle. Set it as a Railway environment variable.
# No build ARG needed — rewrites read process.env.BACKEND_URL when the server starts.

RUN npm run build

# Stage 2: Run (uses Next.js standalone output — much smaller image)
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone bundle includes only what's needed to run
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["node", "server.js"]
