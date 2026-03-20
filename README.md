# MediBook — WhatsApp Appointment SaaS
## WhatsApp Cloud API (Meta) Edition — v2.0

Multi-tenant WhatsApp appointment booking system for Indian hospitals and clinics.
Patients book appointments by chatting on WhatsApp. Each clinic gets its own bot powered by Meta Cloud API.

---

## Quick Start

### Option A — Auto start everything (easiest)
1. Make sure Docker Desktop is running
2. Double-click `START.bat`
3. Open http://localhost:3000

### Option B — Manual
```bash
# 1. Start database + redis
docker-compose up postgres redis -d

# 2. Install dependencies
cd backend && npm install
cd ../frontend && npm install

# 3. Run migrations + seed
cd backend
node src/db/migrate.js
node src/db/seed.js

# 4. Run tests
node tests/bot.test.js

# 5. Start servers (2 terminals)
# Terminal 1:
cd backend && npm run dev

# Terminal 2:
cd frontend && npm run dev
```

---

## Login Credentials

| Role | Email | Password | Notes |
|------|-------|----------|-------|
| Super Admin | admin@medibook.com | SuperAdmin@123 | Platform management |
| Clinic Admin | demo@medibook.com | Demo@123456 | Clinic slug: `demo-clinic` |

---

## Test the Bot (no WhatsApp needed)

```bash
curl -X POST http://localhost:3001/api/webhook/test \
  -H "Content-Type: application/json" \
  -d '{"phone":"919999999999","message":"Hi"}'
```

Or use the **Bot Tester** tab inside the dashboard at http://localhost:3000/dashboard.

---

## Project Structure

```
medibook/
├── backend/
│   ├── src/
│   │   ├── db/
│   │   │   ├── index.js              # DB pool + tenantQuery + tenantTransaction helpers
│   │   │   ├── migrate.js            # Public schema migrations (tenants, plans, super_admins)
│   │   │   ├── tenantMigrate.js      # Per-tenant schema creator
│   │   │   └── seed.js               # Demo clinic seeder with 3 doctors + 30-day slots
│   │   ├── routes/
│   │   │   ├── auth.js               # Login endpoints (clinic + super admin)
│   │   │   ├── webhook.js            # Meta webhook + /webhook/test endpoint
│   │   │   ├── appointments.js       # CRUD for appointments (split from admin.js)
│   │   │   ├── doctors.js            # Doctor management (split from admin.js)
│   │   │   ├── hospitals.js          # Hospital management (split from admin.js)
│   │   │   ├── patients.js           # Patient management (split from admin.js)
│   │   │   ├── analytics.js          # 30-day analytics (split from admin.js)
│   │   │   ├── admin.js              # Dashboard, staff, settings, calendar, audit-log, bot-tester
│   │   │   ├── services.js           # Service catalog (A1) + holiday management (A4)
│   │   │   ├── events.js             # SSE real-time dashboard endpoint
│   │   │   ├── superadmin.js         # Platform management API
│   │   │   └── adminHelpers.js       # Shared middleware: adminOnly, writeAuditLog
│   │   ├── services/
│   │   │   ├── whatsapp.js           # Meta Cloud API client (text, buttons, lists, templates)
│   │   │   ├── email.js              # Transactional emails via Resend (with deduplication)
│   │   │   ├── sms.js                # SMS notifications (pluggable provider)
│   │   │   ├── translations.js       # Multi-language bot message strings
│   │   │   ├── botEngine.js          # WhatsApp conversation state machine entry point
│   │   │   └── bot/
│   │   │       ├── bookingFlow.js    # Booking flow steps
│   │   │       ├── appointmentFlow.js# Appointment management flow
│   │   │       └── utils.js          # Shared bot helpers (session, patient lookup, etc.)
│   │   ├── middleware/
│   │   │   ├── auth.js               # JWT + tenant middleware
│   │   │   ├── validate.js           # Joi request validation middleware
│   │   │   └── tenantRateLimit.js    # Per-tenant rate limiting for admin routes
│   │   ├── jobs/
│   │   │   ├── reminders.js          # 24h + 2h appointment reminder cron
│   │   │   ├── slotGenerator.js      # Nightly slot generation cron (11:30 PM IST)
│   │   │   ├── botWorker.js          # BullMQ worker for async bot message processing
│   │   │   ├── retryWebhooks.js      # Retry failed outgoing webhook deliveries
│   │   │   └── backupManager.js      # Nightly pg_dump backup cron
│   │   └── utils/
│   │       ├── logger.js             # Winston structured logger
│   │       ├── encryption.js         # AES-256 for WhatsApp token storage
│   │       ├── errors.js             # Shared error codes, constants, handleError helper
│   │       ├── metrics.js            # In-process request counters
│   │       ├── redisClient.js        # Shared ioredis client + healthCheck helper
│   │       ├── cronLock.js           # Redis-based distributed cron lock
│   │       ├── requestContext.js     # AsyncLocalStorage request ID propagation
│   │       ├── tenantUtils.js        # Tenant lookup + schema helpers
│   │       ├── featureFlags.js       # Per-tenant feature flag checks
│   │       └── telemetry.js          # Lightweight telemetry helpers
│   ├── tests/
│   │   └── bot.test.js               # Bot engine test suite (6 tests)
│   └── .env                          # Environment variables
├── frontend/
│   └── src/app/
│       ├── login/page.js             # Login page (clinic + super admin toggle)
│       ├── dashboard/page.js         # Full clinic admin dashboard
│       ├── doctor/page.js            # Doctor portal (schedule, today's appointments)
│       ├── reception/page.js         # Reception / check-in portal
│       ├── superadmin/page.js        # Platform management panel
│       ├── superadmin/new-tenant/    # New tenant creation wizard
│       └── reset-password/page.js    # Password reset flow
├── docker-compose.yml
├── CLAUDE.md                         # Claude Code master instructions
└── START.bat                         # One-click dev environment starter
```

---

## Environment Variables (backend/.env)

### Required
```
DATABASE_URL=postgresql://postgres:password@localhost:5432/medibook
REDIS_URL=redis://localhost:6379
JWT_SECRET=<min 32 chars — generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
ENCRYPTION_KEY=<32 chars — generate: node -e "console.log(require('crypto').randomBytes(16).toString('hex'))">
FRONTEND_URL=http://localhost:3000
```

### WhatsApp (Meta Cloud API)
```
META_ACCESS_TOKEN=your_token_here
META_PHONE_NUMBER_ID=your_phone_id_here
META_WEBHOOK_VERIFY_TOKEN=any_string_you_choose
META_APP_SECRET=your_app_secret_here
```
The bot works locally without these — use `/api/webhook/test` for testing.

### Optional services
```
RESEND_API_KEY=re_...              # Transactional emails (booking confirmations, reminders)
RESEND_FROM_EMAIL=noreply@...      # From address for emails
RESEND_WEBHOOK_SECRET=...          # Resend bounce webhook signature verification
SENTRY_DSN=https://...             # Sentry error tracking (install @sentry/node separately)
BACKUP_DIR=/tmp                    # Directory for pg_dump backups (default: os.tmpdir())
BACKUP_MAX_FILES=7                 # Number of backup files to retain (default: 7)
DISABLE_QUEUE=true                 # Force synchronous bot processing (bypass BullMQ)
LOG_LEVEL=info                     # Winston log level (debug/info/warn/error)
PORT=3001                          # Backend port (default: 3001)
```

---

## API Reference

All routes are available at both `/api/...` and `/api/v1/...` (versioned aliases).

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Clinic admin login |
| POST | `/api/auth/superadmin/login` | Super admin login |

### Appointments
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/appointments` | List appointments (filters: date, status, doctor_id, page, limit) |
| GET | `/api/admin/appointments/:id` | Get single appointment |
| PATCH | `/api/admin/appointments/:id` | Update appointment status |
| DELETE | `/api/admin/appointments/:id` | Cancel appointment |

### Doctors
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/doctors` | List all doctors |
| POST | `/api/admin/doctors` | Create doctor |
| PATCH | `/api/admin/doctors/:id` | Update doctor |
| DELETE | `/api/admin/doctors/:id` | Deactivate doctor |
| POST | `/api/admin/doctors/:id/schedule` | Set weekly schedule |
| POST | `/api/admin/slots/generate` | Generate time slots for a doctor |

### Hospitals & Services
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/hospitals` | List hospitals |
| POST | `/api/admin/hospitals` | Create hospital |
| GET | `/api/admin/services` | List service catalog |
| POST | `/api/admin/services` | Create service |
| PATCH | `/api/admin/services/:id` | Update service |

### Patients
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/patients` | List patients (search, page) |
| GET | `/api/admin/patients/:id` | Patient detail + appointment history |

### Analytics & Dashboard
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/dashboard` | Today's stats (appointments, patients, slots) |
| GET | `/api/admin/analytics` | 30-day appointment trends by day/doctor/status |
| GET | `/api/admin/events` | SSE stream for real-time dashboard updates |

### Super Admin
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/superadmin/tenants` | List all tenants |
| POST | `/api/superadmin/tenants` | Create new tenant + schema |
| PATCH | `/api/superadmin/tenants/:id` | Update tenant (status, plan, WA credentials) |
| GET | `/api/superadmin/stats` | Platform-wide statistics |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (DB pool, Redis, queue, memory) |
| GET | `/metrics` | Request counters + queue depth + tenant count |
| POST | `/api/webhook/whatsapp` | Meta webhook receiver |
| GET | `/api/webhook/whatsapp` | Meta webhook verification |
| POST | `/api/webhook/test` | Local bot testing (dev only) |
| GET | `/api/track/open` | Email open tracking pixel |
| POST | `/api/webhook/resend` | Resend bounce/complaint webhook |

---

## Key Architecture Features

- **Multi-tenant, schema-per-tenant**: Each clinic gets an isolated PostgreSQL schema (`tenant_<slug>`). No data mixing.
- **WhatsApp bot state machine**: Conversations tracked per phone number with full session context in `bot_sessions`.
- **Async bot processing**: Messages queued via BullMQ + Redis. Falls back to synchronous if Redis is unavailable (`DISABLE_QUEUE=true`).
- **Atomic slot booking**: `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available'` prevents double-bookings at the DB level.
- **Email deduplication**: Content-hash-based dedup guard prevents duplicate confirmation emails on BullMQ retries.
- **Real-time dashboard**: SSE endpoint (`/api/admin/events`) broadcasts new appointments via Redis pub/sub to all connected clients.
- **Distributed cron locks**: `cronLock.js` uses Redis SET NX to ensure cron jobs run on only one instance in multi-pod deployments.
- **Nightly backups**: `backupManager.js` runs `pg_dump` and retains the last N backup files.
- **Per-tenant rate limiting**: Admin routes enforce per-tenant request quotas separate from the global limiter.
- **Request ID propagation**: Every request gets a UUID (`X-Request-Id` header) propagated via AsyncLocalStorage for log correlation.

---

## Go Live Checklist

1. Create app at developers.facebook.com → Add WhatsApp product
2. Add your WhatsApp number to the app
3. Copy Phone Number ID + Access Token → update `backend/.env`
4. Set `FRONTEND_URL` in `backend/.env` to your deployed frontend URL
5. Deploy backend to Railway: `railway up`
6. Set webhook URL in Meta: `https://your-app.railway.app/api/webhook/whatsapp`
7. Subscribe to `messages` webhook field
8. Deploy frontend to Vercel: `vercel deploy`
9. Update `NEXT_PUBLIC_API_URL` in Vercel to your Railway URL
10. (Optional) Add `RESEND_API_KEY` for booking confirmation emails
11. (Optional) Add `SENTRY_DSN` + install `@sentry/node` for error tracking
12. Test by sending "Hi" to your WhatsApp number

---

*MediBook v2.0 — WhatsApp Cloud API Edition*
