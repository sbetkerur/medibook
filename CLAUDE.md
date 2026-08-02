# MediBook — WhatsApp Appointment SaaS for Dental Clinics

Multi-tenant appointment booking for Indian dental clinics. Patients book by
chatting with a WhatsApp bot (Meta Cloud API); clinic staff manage everything
via a Next.js dashboard; a super admin manages tenants.

> This file describes the codebase AS IT IS. The original build-phase scaffold
> instructions it replaced are obsolete — trust the code, not old docs.

## Stack

- **Backend:** Node.js + Express (`backend/`), PostgreSQL (schema-per-tenant),
  Redis + BullMQ (bot/email queues, rate limits, caches, cron locks)
- **Frontend:** Next.js 14 App Router + Tailwind (`frontend/`)
- **Messaging:** Meta WhatsApp Cloud API (v21.0), Resend (email), Twilio (SMS fallback)

## Commands

```bash
docker-compose up -d            # postgres + redis for local dev
cd backend && npm run dev       # API on :3001 (nodemon)
cd backend && npm run migrate   # public schema + per-tenant migrations
cd backend && npm run seed      # demo tenant + doctors + slots
cd frontend && npm run dev      # dashboard on :3000
cd backend && node tests/bot.test.js        # bot flow tests (needs DB + seed)
cd backend && node tests/botFlow.unit.test.js
cd backend && node tests/clinicSearch.unit.test.js
```

Deploy (Railway): `backend/entrypoint.sh` runs migrate → seed → start on every
boot, so schema changes in `migrate.js` / `tenantMigrate.js` must be idempotent
(`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / versioned `runMigration`).

Deploying via CLI — `railway up` archives the **git root** by default (even
when run from inside `backend/`), which has no start script, so the build
fails with Railpack "No start command detected" and an empty `configFile` in
the deployment meta. ALWAYS pass the service dir with `--path-as-root`
(from the repo root, or use `npm run deploy:backend` / `deploy:frontend`):

```bash
railway up ./backend  --path-as-root --service backend  --detach
railway up ./frontend --path-as-root --service frontend --detach
railway deployment list --service backend --json   # poll status (detached mode doesn't wait)
```

Seed credentials: super admin `admin@medibook.com` / `SuperAdmin@123`;
tenant admin `demo@medibook.com` / `Demo@123456` (slug `demo-clinic`).

## Architecture invariants — do not break these

**Tenancy.** Every clinic lives in its own PG schema (`tenant_<slug>`). All
tenant SQL goes through `tenantQuery` / `tenantTransaction` (`src/db/index.js`),
which validate the schema name (`/^tenant_[a-z0-9_]+$/`) and use
transaction-scoped `SET LOCAL search_path` (pool-safe). Never interpolate a
schema name without that validation. Public-schema tables (tenants, plans,
refresh_tokens, global_bot_sessions, …) use plain `query`.

**Shared WhatsApp number.** All tenants share the global `META_*` credentials.
Incoming messages are routed to a tenant via `global_bot_sessions` (patient
SEARCHES for their clinic on first contact; "switch clinic" resets). The tenant
roster is never listed — `services/bot/clinicSearch.js` matches the typed query
and only matches are shown (≥2 as a numbered shortlist parked on
`global_bot_sessions.search_matches`, >`MAX_SHORTLIST` asks them to narrow it
down). "Dental"/"clinic" are stripped from both the query and the tenant names,
so a query of only those words is refused rather than matching everyone. The
search runs even when exactly ONE tenant is active — there is deliberately no
auto-assign shortcut, so the entry step doesn't change shape as clinics are
onboarded. Pass
`null, null` for token/phoneId to the `whatsapp.js` senders — they fall back to
env vars. `notifyAdminWhatsApp()` fans out to ALL admins with a `notify_phone`
— call it once per event, never inside a per-admin loop.

**Bot engine.** `services/botEngine.js` is a state machine over
`bot_sessions.state` with context stored ENCRYPTED (`{_enc: ...}`, AES-256-GCM
via `utils/encryption.js`). Always read/write context through
`getSession`/`updateSession` in `services/bot/utils.js`. "Hi" must always reset
to the main menu from any state. Handlers live in `services/bot/bookingFlow.js`
and `appointmentFlow.js`. In confirm steps, check negative intent ("no",
"don't", "keep") BEFORE positive keywords. `fuzzyFind` (`bot/utils.js`)
returns null when input is under 3 chars or matches more than one item — it
must never resolve ambiguity by list order, since that picks the dentist a
patient is booked with. Callers re-prompt on null; they must not cancel the
booking (see `tests/fuzzyFind.unit.test.js`).

**Booking integrity.** Slot locking is the atomic
`UPDATE time_slots SET status='booked' WHERE ... AND status='available'`
pattern inside a transaction; appointment inserts go through
`bookingCore.insertAppointmentWithRetry` (SAVEPOINT + booking-ID collision
retry). The bot flow, admin walk-in route and follow-up route all share it.
Appointment status changes must respect `APPOINTMENT_TRANSITIONS`
(`utils/errors.js`) — single and bulk routes both enforce it.

**Webhook processing.** `routes/webhook.js` ACKs Meta immediately, verifies
the `x-hub-signature-256` HMAC against the RAW body, dedups by `wa_message_id`
(partial unique index), then enqueues to BullMQ. Every sync fallback must go
through `processSyncWithRetryFallback` so failures land in `failed_webhooks`
for the retry cron.

**Crons.** All crons wrap in `withCronLock(lockName, ttlSeconds, fn)` — the
TTL argument is REQUIRED (omitting it silently breaks the cron). Slot
generation, reminders, feedback, digests, session cleanup, webhook retry and
backups are registered from `index.js`; tasks are returned so SIGTERM can stop
them.

**Timezone.** Servers run UTC (`TZ=UTC`; startup warns otherwise); the product
is IST. Use `toZonedTime(new Date(), 'Asia/Kolkata')` (via `utils/dateTz.js`
shim) for any "today" computation, and compare appointment date+time as a
`timezone('Asia/Kolkata', ts)` timestamp in SQL — never date-only or time-only.
In SQL, never write bare `CURRENT_DATE`/`date_trunc('month', NOW())` for a
clinic-facing "today"/"this month" — it's the UTC date, a day behind IST until
05:30. Interpolate `IST_TODAY_SQL` / `IST_MONTH_START_SQL` from
`utils/dateTz.js` instead. Against a TIMESTAMPTZ column (`created_at`) use
`IST_MONTH_START_TS_SQL` — comparing a timestamptz to the `::date` form
coerces it at the server timezone (UTC) and reintroduces the same 5.5-hour
skew. Monthly quota counts must match `bookingCore.checkMonthlyQuota`. Past-slot guards must AND the same-day test
(`slot_date > today OR (slot_date = today AND start_time > now)`); the
two-clause `OR start_time > now` form matches past dates.
DATE columns are returned as strings (type parser in `db/index.js`).

**Slot generation.** `jobs/slotGenerator.js` is the single source of truth
(`computeDaySlotTimes`, `generateSlotsForDoctor`). Any path that creates slots
must skip doctor leaves, clinic holidays and (feature-flagged) public
holidays — delegate to `generateSlotsForDoctor`, don't re-implement the loop.
Slots blocked by a doctor leave carry `blocked_by_leave=true`; removing a leave
only releases those.

**Auth.** JWTs (1h, `jti` for blacklist-based revocation) + rotating one-time
refresh tokens (30d). Refresh AND password-reset tokens are stored as SHA-256
hashes only. Auth + tenant + per-tenant rate-limit middleware are applied ONCE
in `index.js` for `/api/admin` and `/api/v1/admin` — route files must not
re-apply them. Mutating admin routes use `adminOnly`; validate route UUIDs with
`validateUUID()` / shared `UUID_RE` from `utils/errors.js`.

**Frontend.** All API calls go through the Next.js rewrite proxy
(`/api/proxy/*` → `BACKEND_URL`) — no API origin is baked into the bundle.
`lib/api.js` handles token attach, 401 → refresh rotation (queued), and
dispatches `medibook:token-refreshed` — long-lived consumers (the dashboard's
SSE `EventSource`, which carries the token in its URL) must listen and
reconnect. `dashboard/page.js` is one large file; if you touch it
substantially, prefer extracting tabs into `components/tabs/` (see
`SlotsTab.js`).

## Environment variables

Required in prod (startup fails or warns otherwise): `DATABASE_URL`,
`JWT_SECRET` (≥32 chars), `ENCRYPTION_KEY` (≥32 chars, non-default),
`META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_WEBHOOK_VERIFY_TOKEN`,
`META_APP_SECRET`, `FRONTEND_URL` (locks CORS/CSP). Optional: `REDIS_URL`
(queues, cron locks and shared rate-limit counters all degrade to in-process
fallbacks without it — nothing probes localhost), `RESEND_API_KEY`,
`PUBLIC_API_URL` (this API's public origin; required for email open-tracking
pixels to resolve — omit rather than pointing at localhost),
`RESEND_WEBHOOK_SECRET`, `TWILIO_*`, `OPENAI_API_KEY` (voice transcription),
`SENTRY_DSN`, `METRICS_SECRET`, `BACKUP_DIR`, `TIMEZONE`,
`WEBHOOK_RATE_LIMIT_PER_MIN` (default 2000; per-IP, and Meta delivers every
tenant's traffic from a shared IP pool, so this is effectively platform-wide).
Frontend: `BACKEND_URL` (server-side, Railway).

## Testing without WhatsApp credentials

`POST /api/webhook/test` (`{phone, message, button_id, tenant_slug}`) runs a
message through the real bot engine and returns the replies it would have sent.
Enabled outside production or with `ENABLE_TEST_ENDPOINT=true`.
