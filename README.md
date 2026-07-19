# MediBook — WhatsApp Appointment SaaS
## WhatsApp Cloud API (Meta) Edition — v2.0

Multi-tenant WhatsApp appointment booking for Indian dental clinics.
Patients book by chatting with a WhatsApp bot; clinic staff manage everything
via a Next.js dashboard; a super admin manages tenants. All tenants share one
global WhatsApp number — incoming messages are routed to the right clinic via
`global_bot_sessions` (the patient picks a clinic by name on first contact).

---

## Quick Start

### Option A — Auto start everything (easiest)
1. Make sure Docker Desktop is running
2. Double-click `START.bat`
3. Open http://localhost:3000

### Option B — Manual
```bash
# 1. Start database + redis
docker-compose up -d

# 2. Install dependencies
cd backend && npm install
cd ../frontend && npm install

# 3. Run migrations + seed (from backend/)
npm run migrate
npm run seed

# 4. Run tests (need DB + seed)
node tests/bot.test.js            # bot flow tests
node tests/botFlow.unit.test.js   # bot flow unit tests
node tests/api.test.js            # API tests
node tests/smoke.test.js          # smoke tests

# 5. Start servers (2 terminals)
# Terminal 1:
cd backend && npm run dev         # API on :3001

# Terminal 2:
cd frontend && npm run dev        # dashboard on :3000
```

---

## Login Credentials (seed data)

| Role | Email | Password | Notes |
|------|-------|----------|-------|
| Super Admin | admin@medibook.com | SuperAdmin@123 | Platform management |
| Clinic Admin | demo@medibook.com | Demo@123456 | Clinic slug: `demo-clinic` |

---

## Test the Bot (no WhatsApp needed)

```bash
curl -X POST http://localhost:3001/api/webhook/test \
  -H "Content-Type: application/json" \
  -d '{"phone":"917795676142","message":"Hi","tenant_slug":"demo-clinic"}'
```

Body fields: `phone`, `message`, optional `button_id` (simulate a button tap)
and `tenant_slug`. The message runs through the real bot engine and the
response contains the replies the bot would have sent. Enabled outside
production, or in production with `ENABLE_TEST_ENDPOINT=true`.

Or use the **Bot Tester** tab inside the dashboard at http://localhost:3000/dashboard.

---

## Project Structure

```
medibook/
├── backend/
│   ├── src/
│   │   ├── db/
│   │   │   ├── index.js              # PG pool + tenantQuery/tenantTransaction (schema-per-tenant)
│   │   │   ├── migrate.js            # Public schema migrations (tenants, plans, super_admins, …)
│   │   │   ├── tenantMigrate.js      # Per-tenant schema creator + versioned migrations
│   │   │   └── seed.js               # Demo clinic seeder (doctors + 30-day slots)
│   │   ├── routes/
│   │   │   ├── auth.js               # Login, refresh, logout, forgot/change/reset password
│   │   │   ├── webhook.js            # Meta webhook (HMAC verify, dedup, enqueue) + /webhook/test
│   │   │   ├── appointments.js       # Appointment CRUD, bulk updates, walk-ins, follow-ups, receipts
│   │   │   ├── doctors.js            # Doctor management, schedules, leaves, slot generation
│   │   │   ├── hospitals.js          # Hospital/branch management
│   │   │   ├── patients.js           # Patient list + detail
│   │   │   ├── analytics.js          # 30-day analytics
│   │   │   ├── admin.js              # Dashboard, staff, settings, audit logs, bot tester, feedback
│   │   │   ├── services.js           # Service catalog + holiday management
│   │   │   ├── events.js             # SSE real-time dashboard endpoint
│   │   │   ├── superadmin.js         # Tenants, plans, billing, backups, failed webhooks, feature flags
│   │   │   └── adminHelpers.js       # Shared middleware: adminOnly, writeAuditLog
│   │   ├── services/
│   │   │   ├── whatsapp.js           # Meta Cloud API client (text, buttons, lists, templates)
│   │   │   ├── bookingCore.js        # Shared booking logic (atomic slot lock + insertAppointmentWithRetry)
│   │   │   ├── botEngine.js          # WhatsApp conversation state machine entry point
│   │   │   ├── email.js              # Transactional emails via Resend (with deduplication)
│   │   │   ├── sms.js                # SMS notifications (Twilio fallback)
│   │   │   ├── translations.js       # Multi-language bot message strings
│   │   │   └── bot/
│   │   │       ├── bookingFlow.js    # Booking flow steps
│   │   │       ├── appointmentFlow.js# Appointment management flow
│   │   │       └── utils.js          # Session get/update (encrypted context), patient lookup
│   │   ├── middleware/
│   │   │   ├── auth.js               # JWT + tenant middleware
│   │   │   ├── validate.js           # Joi request validation middleware
│   │   │   └── tenantRateLimit.js    # Per-tenant rate limiting for admin routes
│   │   ├── jobs/                     # All crons wrap in withCronLock(name, ttlSeconds, fn)
│   │   │   ├── slotGenerator.js      # Slot generation — single source of truth for slot creation
│   │   │   ├── reminders.js          # 24h + 2h appointment reminders, feedback, digests
│   │   │   ├── sessionCleaner.js     # Expires bot sessions after 4h inactivity
│   │   │   ├── botWorker.js          # BullMQ worker for async bot message processing
│   │   │   ├── retryWebhooks.js      # Retry cron for failed_webhooks
│   │   │   └── backupManager.js      # Nightly pg_dump backup cron
│   │   └── utils/
│   │       ├── logger.js             # Winston structured logger
│   │       ├── encryption.js         # AES-256-GCM (bot session context, WA tokens)
│   │       ├── errors.js             # Error codes, APPOINTMENT_TRANSITIONS, UUID_RE, handleError
│   │       ├── dateTz.js             # IST timezone helpers (toZonedTime shim)
│   │       ├── cronLock.js           # Redis-based distributed cron lock
│   │       ├── redisClient.js        # Shared ioredis client + healthCheck
│   │       ├── requestContext.js     # AsyncLocalStorage request ID propagation
│   │       ├── tenantUtils.js        # Tenant lookup + schema helpers
│   │       ├── featureFlags.js       # Per-tenant feature flag checks
│   │       ├── metrics.js            # In-process request counters
│   │       └── telemetry.js          # Lightweight telemetry helpers
│   ├── tests/
│   │   ├── bot.test.js               # Bot engine flow tests
│   │   ├── botFlow.unit.test.js      # Bot flow unit tests
│   │   ├── api.test.js               # API tests
│   │   └── smoke.test.js             # Smoke tests
│   ├── entrypoint.sh                 # Railway boot: migrate → seed → start
│   └── .env                          # Environment variables
├── frontend/
│   └── src/
│       ├── app/
│       │   ├── login/page.js         # Login page (clinic + super admin toggle)
│       │   ├── dashboard/page.js     # Full clinic admin dashboard
│       │   ├── doctor/page.js        # Doctor portal (schedule, today's appointments)
│       │   ├── reception/page.js     # Reception / check-in portal
│       │   ├── superadmin/           # Platform management panel + new tenant wizard
│       │   └── reset-password/page.js
│       ├── components/
│       │   ├── tabs/                 # Dashboard tabs extracted from page.js (SlotsTab, …)
│       │   └── ui/                   # Badge, Modal, ConfirmModal, StatCard
│       └── lib/api.js                # Fetch wrapper: token attach, 401 → refresh rotation
├── docker-compose.yml
├── package.json                      # Root deploy scripts (deploy:backend / deploy:frontend)
├── CLAUDE.md                         # Architecture invariants for Claude Code
└── START.bat                         # One-click dev environment starter
```

---

## Environment Variables (backend/.env)

### Required in production (startup fails or warns otherwise)
```
DATABASE_URL=postgresql://postgres:password@localhost:5432/medibook
JWT_SECRET=<min 32 chars — generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
ENCRYPTION_KEY=<min 32 chars, non-default — same generator>
FRONTEND_URL=http://localhost:3000     # locks CORS/CSP
META_ACCESS_TOKEN=your_token_here      # shared across all tenants
META_PHONE_NUMBER_ID=your_phone_id_here
META_WEBHOOK_VERIFY_TOKEN=any_string_you_choose
META_APP_SECRET=your_app_secret_here
```
The bot works locally without the `META_*` values — use `/api/webhook/test`.

### Optional services
```
REDIS_URL=redis://localhost:6379   # Queues/caches; degrade to sync processing without it
RESEND_API_KEY=re_...              # Transactional emails (confirmations, reminders)
RESEND_FROM_EMAIL=noreply@...      # From address for emails
RESEND_WEBHOOK_SECRET=...          # Resend bounce webhook signature verification
TWILIO_ACCOUNT_SID=...             # SMS fallback (with TWILIO_AUTH_TOKEN, TWILIO_FROM)
OPENAI_API_KEY=sk-...              # Voice note transcription
SENTRY_DSN=https://...             # Sentry error tracking
METRICS_SECRET=...                 # Protects /metrics endpoint
ENABLE_TEST_ENDPOINT=true          # Allow /api/webhook/test in production
BACKUP_DIR=/tmp                    # Directory for pg_dump backups (default: os.tmpdir())
BACKUP_MAX_FILES=7                 # Number of backup files to retain (default: 7)
DISABLE_QUEUE=true                 # Force synchronous bot processing (bypass BullMQ)
TIMEZONE=Asia/Kolkata              # Product timezone (servers run UTC)
LOG_LEVEL=info                     # Winston log level (debug/info/warn/error)
PORT=3001                          # Backend port (default: 3001)
```

Frontend (Railway): `BACKEND_URL` — server-side only, used by the Next.js
rewrite proxy (`/api/proxy/*`). No API origin is baked into the bundle.

---

## API Reference

All routes are available at both `/api/...` and `/api/v1/...` (versioned aliases).
Mutating admin routes require the `admin` role (`adminOnly`).

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Clinic admin login (returns 1h JWT + 30d rotating refresh token) |
| POST | `/api/auth/superadmin/login` | Super admin login |
| POST | `/api/auth/refresh` | Rotate refresh token, get new JWT |
| POST | `/api/auth/logout` | Revoke JWT (jti blacklist) + refresh token |
| POST | `/api/auth/forgot-password` | Send password reset email |
| POST | `/api/auth/reset-password` | Reset password with token |
| POST | `/api/auth/change-password` | Change password (authenticated) |

### Appointments
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/appointments` | List (filters: date, status, doctor_id, page, limit) |
| GET | `/api/admin/appointments/:id` | Get single appointment |
| POST | `/api/admin/appointments` | Create walk-in appointment |
| PATCH | `/api/admin/appointments/:id` | Update status (enforces allowed transitions) |
| PATCH | `/api/admin/appointments/bulk` | Bulk status update |
| POST | `/api/admin/appointments/:id/followup` | Book follow-up appointment |
| GET | `/api/admin/appointments/:id/receipt` | Appointment receipt |
| POST | `/api/admin/appointments/:id/sms` | Send SMS to patient |

### Doctors & Slots
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/doctors` | List all doctors |
| POST | `/api/admin/doctors` | Create doctor |
| PATCH | `/api/admin/doctors/:id` | Update doctor |
| DELETE | `/api/admin/doctors/:id` | Deactivate doctor |
| GET/POST | `/api/admin/doctors/:id/schedule` | Get / set weekly schedule |
| GET/POST | `/api/admin/doctors/:id/leaves` | Get / add doctor leaves (blocks slots) |
| DELETE | `/api/admin/doctors/:id/leaves/:date` | Remove leave (releases blocked slots) |

### Hospitals, Services & Patients
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/admin/hospitals` | List / create hospitals (branches) |
| GET/POST | `/api/admin/services` | Service catalog |
| PATCH | `/api/admin/services/:id` | Update service |
| GET | `/api/admin/patients` | List patients (search, page) |
| GET | `/api/admin/patients/:id` | Patient detail + appointment history |

### Analytics & Dashboard
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/dashboard` | Today's stats (appointments, patients, slots) |
| GET | `/api/admin/analytics` | 30-day appointment trends by day/doctor/status |
| GET | `/api/admin/events` | SSE stream for real-time dashboard updates |
| GET | `/api/admin/audit-logs` | Admin action audit trail |
| GET | `/api/admin/feedback` | Patient feedback |

### Super Admin
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/superadmin/tenants` | List / create tenants (+ schema) |
| PATCH | `/api/superadmin/tenants/:id` | Update tenant (status, plan) |
| GET | `/api/superadmin/tenants/:id/stats` `/health` `/quota` | Per-tenant diagnostics |
| POST | `/api/superadmin/tenants/:id/impersonate` | Log in as tenant admin |
| GET/POST | `/api/superadmin/tenants/:id/feature-flags` | Per-tenant feature flags |
| GET | `/api/superadmin/stats` | Platform-wide statistics |
| GET | `/api/superadmin/billing` | Billing overview |
| GET | `/api/superadmin/webhooks/failed` | Failed webhook queue |
| POST | `/api/superadmin/webhooks/:id/retry` | Retry a failed webhook |
| GET | `/api/superadmin/backups` | List backups (`POST /backups/trigger` to run now) |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (DB pool, Redis, queue, memory) |
| GET | `/metrics` | Request counters + queue depth (protect with `METRICS_SECRET`) |
| POST | `/api/webhook/whatsapp` | Meta webhook receiver (HMAC-verified, deduped) |
| GET | `/api/webhook/whatsapp` | Meta webhook verification |
| POST | `/api/webhook/test` | Local bot testing (dev, or `ENABLE_TEST_ENDPOINT=true`) |
| GET | `/api/track/open` | Email open tracking pixel |
| POST | `/api/webhook/resend` | Resend bounce/complaint webhook |

---

## Key Architecture Features

- **Multi-tenant, schema-per-tenant**: Each clinic gets an isolated PostgreSQL schema (`tenant_<slug>`). All tenant SQL goes through `tenantQuery`/`tenantTransaction`, which validate the schema name and set a transaction-scoped `search_path`.
- **Shared WhatsApp number**: All tenants share the global `META_*` credentials; `global_bot_sessions` routes each patient's chat to the clinic they picked. "switch clinic" resets the routing; "Hi" always resets the bot to the main menu.
- **WhatsApp bot state machine**: Conversations tracked per phone in `bot_sessions` with the context stored AES-256-GCM encrypted. Sessions auto-expire after 4 hours of inactivity.
- **Atomic slot booking**: `UPDATE time_slots SET status='booked' … AND status='available'` inside a transaction, shared by the bot, admin walk-in and follow-up routes via `bookingCore.insertAppointmentWithRetry`. Status changes enforce `APPOINTMENT_TRANSITIONS`.
- **Async bot processing**: Messages queued via BullMQ + Redis, with a sync fallback (failures land in `failed_webhooks` for the retry cron). Meta webhooks are ACKed immediately, HMAC-verified against the raw body, and deduped by `wa_message_id`.
- **IST-aware scheduling**: Servers run UTC; all "today"/reminder computations use `Asia/Kolkata` via `utils/dateTz.js`, and date+time comparisons happen as IST timestamps in SQL.
- **Slot generation single source of truth**: `jobs/slotGenerator.js` handles doctor leaves, clinic holidays and (feature-flagged) public holidays; every slot-creating path delegates to it.
- **Auth**: 1h JWTs with `jti` blacklist revocation + rotating one-time 30d refresh tokens; refresh and reset tokens stored as SHA-256 hashes only.
- **Real-time dashboard**: SSE endpoint (`/api/admin/events`) broadcasts updates via Redis pub/sub; the frontend reconnects on token refresh.
- **Distributed cron locks**: Every cron wraps in `withCronLock(name, ttlSeconds, fn)` (Redis SET NX) so jobs run on only one instance.
- **Nightly backups**: `backupManager.js` runs `pg_dump` and retains the last N files; super admin can trigger/list backups.
- **Per-tenant rate limiting** and **request ID propagation** (`X-Request-Id` via AsyncLocalStorage) on all admin routes.

---

## Deploy (Railway)

Both backend and frontend deploy to Railway. `backend/entrypoint.sh` runs
migrate → seed → start on every boot, so migrations must stay idempotent.

> **Important:** plain `railway up` archives the git root (which has no start
> script) and fails the build with "No start command detected". Always pass
> the service dir with `--path-as-root`, or use the root package.json scripts:

```bash
npm run deploy:backend    # railway up ./backend  --path-as-root --service backend  --detach
npm run deploy:frontend   # railway up ./frontend --path-as-root --service frontend --detach
railway deployment list --service backend --json   # poll status (detached mode doesn't wait)
```

### Go Live Checklist

1. Create app at developers.facebook.com → Add WhatsApp product
2. Add your WhatsApp number to the app
3. Set the `META_*` variables on the Railway backend service
4. Set `FRONTEND_URL` on the backend and `BACKEND_URL` on the frontend service
5. Deploy: `npm run deploy:backend && npm run deploy:frontend`
6. Set webhook URL in Meta: `https://your-app.railway.app/api/webhook/whatsapp`
   (verify token = `META_WEBHOOK_VERIFY_TOKEN`)
7. Subscribe to the `messages` webhook field
8. (Optional) Add `RESEND_API_KEY` for booking confirmation emails
9. (Optional) Add `SENTRY_DSN` for error tracking
10. Test by sending "Hi" to your WhatsApp number

---

*MediBook v2.0 — WhatsApp Cloud API Edition*
