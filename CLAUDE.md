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
cd backend && node tests/clinicNearby.unit.test.js   # "clinics near me" entry
cd backend && node tests/clinicNearbyFlow.test.js    # entry routing e2e (needs DB;
                                                     # seeds + drops its own tenants)
cd backend && node tests/slotPlanner.unit.test.js
cd backend && node tests/restartGreeting.unit.test.js
cd backend && node tests/billingDrift.unit.test.js   # per-branch billing staleness
cd backend && node tests/doctorDepartments.unit.test.js  # multi-department doctors
cd backend && node tests/treatmentPlan.unit.test.js      # multi-visit treatment courses
```

Deploy (Railway): `backend/entrypoint.sh` runs migrate → seed → start on every
boot, so schema changes in `migrate.js` / `tenantMigrate.js` must be idempotent
(`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / versioned `runMigration`).

Deploying via CLI — `railway up` archives the **git root**, which is exactly
what both services expect: each has `rootDirectory` set in Railway (`/backend`,
`/frontend`) and finds its own `railway.toml` and `Dockerfile` under it. Run it
from the repo root with no path argument (or `npm run deploy:backend` /
`deploy:frontend`):

```bash
railway up --service backend  --detach
railway up --service frontend --detach
railway deployment list --service backend --json   # poll status (detached mode doesn't wait)
```

Do NOT pass `--path-as-root ./backend`. It used to be required, but the
services now set `rootDirectory` themselves, so Railway applies `/backend` on
top of an archive whose root is ALREADY `backend/` and the build fails in
seconds. The tell is `configFile: "/railway.toml"` in the deployment meta
where a working deploy shows `"/backend/railway.toml"`. `railway logs --build`
shows only "scheduling build on Metal builder" for this failure — the real
cause is only visible in the deployment `meta`, via the GraphQL API
(`backboard.railway.com/graphql/v2`, bearer `user.accessToken` from
`~/.railway/config.json`; note `user.token` is empty).

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
onboarded.

**"Clinics near me" is the second entry, never the first.** The name search
stays the primary path; the entry prompt merely ALSO offers a location button
(`NEARBY_RE` in `routes/webhook.js`). The picker is padded with
`DEFAULT_CITIES` (`bot/clinicSearch.js` — the six metros), so it is never empty
and the button is always offered; a picked city with no clinics is answered
("no clinics in X yet") rather than dead-ending. `buildCityChoices` puts cities
that actually HAVE clinics first and appends the defaults — the padding never
replaces real data, and the >`MAX_CITY_ROWS` "type your city" fallback is
tested on the real-city count so padding can never push a real city off the
list. Dedup is on `normalizeCity`, so a tenant storing "bengaluru" doesn't
double the row. Tapping it parks the session in
`select_city` and asks for a city; picking one lists that city's **branches**
(≤10, WhatsApp's row cap) into the same `search_matches` shortlist the name
search uses, so a numbered reply resolves identically. Two rules carry over
unchanged: a city with exactly ONE branch is still shown as a list rather than
auto-attached (choosing a city is not naming a clinic), and the full roster is
still never listed.

Rows are BRANCHES, not clinics — a clinic with two branches in one city is two
rows, since "which of your branches?" three steps later is the question picking
by location was meant to answer. `services/bot/clinicBranches.js`
(`listActiveBranches`) reads `hospitals` from every active tenant's schema; it
is one `tenantQuery` per clinic, run concurrently and caught INDIVIDUALLY so one
broken schema can't take the entry step down. It is therefore loaded LAZILY —
never on a plain name search, and never for the entry prompt (which offers the
button unconditionally). A branch with no `city` falls back to `tenants.city`.
Consequence: a clinic with NO `hospitals` row is invisible to this path.
Row ids are `br:<tenantId>:<hospitalId>` (`resolveBranchRef`, which re-checks
the tenant is still active — a shortlist outlives the message that sent it).
The chosen branch is parked on `global_bot_sessions.pending_hospital_id`, NOT in
the tenant session context, because selecting a clinic hands the engine a
synthesised "Hi" and a greeting resets that context to empty;
`bookingFlow.startBooking` consumes it one-shot (cleared even when it no longer
resolves, so a deactivated branch can't wedge every future booking) and skips
the branch question. Every path that clears the clinic clears it too. The trigger is matched on message TEXT, not the interactive
reply id — `wa.sendButtons` mints its own opaque ids — and deliberately does NOT
accept a bare "city"/"near", which would shadow real searches like "City Dental
Care". That match lives in `isNearbyTrigger` (exported for tests): a tap sends
BOTH an opaque `btn_0_<ts>` id and the title as the body, so gating on
"no buttonId" silently limits the button to typed text only — the ids that
suppress it are the ones we mint and recognise (a `city:` row, which is an
ANSWER to the picker, and a tenant-UUID row, so a clinic named "Nearby Dental"
can't have its tap hijacked), never the mere presence of an id. Clinic city lives in `tenants.city` (public schema, indexed on
`lower(city)`); it was previously read from `settings->>'city'`, which nothing
ever wrote. A clinic with no city is invisible to this path. Pass
`null, null` for token/phoneId to the `whatsapp.js` senders — they fall back to
env vars. `notifyAdminWhatsApp()` fans out to ALL admins with a `notify_phone`
— call it once per event, never inside a per-admin loop.

**Answers go back to whoever asked.** Inbound routing follows the patient's
SELECTED clinic, which is wrong for anything a clinic asked unprompted: a
reminder's "yes" or a feedback "4" from a patient who has since switched
clinics used to be looked up in the wrong schema and silently dropped. Crons
that ask a question record it via `services/pendingReply.js`
(`global_pending_replies`); `resolveAskingTenant` in `routes/webhook.js`
redirects just that message back to the asker, only when the current clinic's
session is idle AND the asking clinic is verifiably still waiting. Any new
clinic-initiated question needs the same `recordPendingReply` call.

**Cron sends must be logged, AND template-first.** Patient-facing messages sent
outside botEngine go through `services/outbound.js`, which writes to
`wa_messages`. `wa.sendText`/`sendTemplate` on their own record nothing, so
anything using them directly is invisible in clinic history and has no row for
delivery receipts to attach to. Beyond that: Meta only allows free-form text
inside the 24-hour customer service window, and every cron here messages
patients who by definition have NOT written recently — so a clinic-initiated
send must use `sendPatientMessage` (template, falling back to text), never
`sendPatientText` alone. The reminders always did this inline; the feedback,
post-visit and treatment-nudge crons did not and would have gone silent in
production while logging a per-patient error. Any retry bookkeeping around such
a send must advance on the ATTEMPT, not on success — counting only successes
turns a permanently-failing send into an unbounded daily retry that never
reaches its own cap (`jobs/treatmentNudges.js`).

**Conversation design.** Interactive messages use WhatsApp's real `header` and
`footer` slots (`wa.sendButtons`/`sendList` take a 6th `{header, footer}` arg,
both capped at 60 chars by Meta). The step title goes in the header, the
"Step N of 5 · Reply Menu" hint in the footer, and the body carries only
information — previously all three were crammed into one bold-text block, which
is what made every message look identical. Copy is a question, not a form label
("And your date of birth?" not "🎂 *Date of Birth*\n\nEnter your DOB…"), one
glyph per message at most, and the confirmation leads with WHEN and WHO because
that is what a patient scrolls back to check. Tests must assert against the
message's meaning, not its wording — botFlow's mock exposes `m.all`
(header+body+footer) for exactly this, so moving copy between slots doesn't
break a suite.

**Bot engine.** `services/botEngine.js` is a state machine over
`bot_sessions.state` with context stored ENCRYPTED (`{_enc: ...}`, AES-256-GCM
via `utils/encryption.js`). Always read/write context through
`getSession`/`updateSession` in `services/bot/utils.js`. **"Hi" restarts the
whole conversation** — `routes/webhook.js` intercepts it before the engine,
clears the clinic and re-runs the search; selecting a clinic then hands the
engine a synthesised "Hi" so it lands on that clinic's main menu with a clean
session. "Menu" is the one-step reset to the CURRENT clinic's menu and is what
patient-facing copy must point at (`Reply *Menu*`); `*Hi*` in copy means start
over / change clinic. "Start" is NOT a restart word — it is the re-subscribe
keyword and must reach the engine with the clinic attached, or an opted-out
patient can never opt back in (`tests/restartGreeting.unit.test.js`). Inside the engine, a greeting still always resets to the
main menu from any state. Handlers live in `services/bot/bookingFlow.js`
and `appointmentFlow.js`. In confirm steps, check negative intent ("no",
"don't", "keep") BEFORE positive keywords. `fuzzyFind` (`bot/utils.js`)
returns null when input is under 3 chars or matches more than one item — it
must never resolve ambiguity by list order, since that picks the dentist a
patient is booked with. Callers re-prompt on null; they must not cancel the
booking (see `tests/fuzzyFind.unit.test.js`).

**A dentist belongs to several treatments.** `departments` are treatment
categories, and the bookable pairing is many-to-many via `doctor_departments` —
an Indian GP routinely renders simple root canals and extractions alongside
general dentistry, with the specialist on staff taking the hard cases.
`doctors.department_id` remains the PRIMARY department and is ALWAYS mirrored
into the join table (`utils/doctorDepartments.js` — `normalizeDepartmentIds`
puts it first); that invariant is what makes the boot-time backfill in
`tenantMigrate.js` a permanent no-op instead of something that resurrects a
department an admin removed. The bot lists treatments and dentists through the
join table only (`bot/bookingFlow.js`), so any path that creates a doctor must
write the join row in the SAME statement/transaction — migrate runs before seed
on boot, so a doctor created without one is unbookable over WhatsApp until the
next restart (`POST /doctors`, the CSV import and `seed.js` all do this).
Departments are per-branch, so a doctor's set is validated against their own
`hospital_id`. Consequence: the treatment can no longer be derived from the
doctor, so `appointments.department_id` records what was booked FOR, and every
display join reads `COALESCE(a.department_id, d.department_id)` — receipts,
reminder checklists and "by treatment" analytics. Pass `departmentId` to
`bookingCore.insertAppointmentWithRetry` wherever the patient chose a treatment;
it falls back to the doctor's primary otherwise (the walk-in desk).

**The clinical flow.** A patient books a CONSULTATION with the clinic — any
dentist, no treatment named, because only the dentist can name it. The treatment
picker therefore leads with `GENERAL_CONSULT` ("not sure"), a sentinel that
matches no department and lists every dentist at the branch; the named
treatments stay for patients who do know. The dentist then advises a treatment,
which may be done in the same sitting or over several, by them or by a
specialist on staff. The FIRST sitting is booked at the desk; every one after it
is the patient's own — they get a nudge and reply *Treatment*
(`services/bot/treatmentFlow.js`), which pre-fills branch/treatment/dentist from
the plan and hands over to `bookingFlow.handleSelectDoctor` so dates, slots and
the slot lock stay in one place. `jobs/treatmentNudges.js` sends the nudge
(daily 10:30 IST, throttled: never within 7 days, never more than 3 times, never
when a sitting is already on the calendar or one happened in the last 3 days).
It is clinic-initiated, so it calls `recordPendingReply(KINDS.TREATMENT)` and
`resolveAskingTenant` re-checks that the asking clinic still has an open course;
`TREATMENT_REPLY_RE` there and `TREATMENT_KEYWORD_RE` in botEngine must stay
identical or the redirect lands somewhere the engine won't act on it.

**Treatments run over several visits.** A root canal is 2–3 appointments and an
implant is months of them, rendered by the diagnosing dentist OR by a specialist
on staff. `treatment_plans` is the head of that course; each visit is an
ordinary appointment carrying `treatment_plan_id` + `visit_number`
(`routes/treatmentPlans.js`). A plan's `department_id` is what labels every
sitting's receipt: explicit value first, then the TREATING dentist's specialty,
and only then the originating visit — inheriting the origin first made every
sitting of a root canal diagnosed at a general consultation read "General
Dentistry". Progress is **derived** from those appointments
(`utils/treatmentPlan.js` — `planProgress`, `derivePlanStatus`), never stored as
a counter: a cancelled visit must put the work straight back on the "advised but
not booked" queue (`GET /treatment-plans?outstanding=true`), which a stored
count silently gets wrong. `derivePlanStatus` refuses to move a terminal plan,
so a late completion can't reopen a cancelled course; it runs both when a visit
is booked and from the appointment status PATCH. Booking a visit re-counts under
`SELECT … FOR UPDATE` on the plan — locks go **plan → slot** in BOTH writers
(the admin route and `bookingFlow.completeBooking`), since a receptionist and
the patient can be booking the same sitting at once — and goes through the
shared `insertAppointmentWithRetry` +
atomic slot lock + `checkMonthlyQuota` — a 3-visit course is 3 appointments, not
a back door around the cap. The patient confirmation goes through
`services/outbound.js`; it is a STATEMENT, so it needs no `recordPendingReply` —
add one if a clinic-initiated *question* is ever sent from here.

**Visiting consultants.** The specialist is usually a visiting doctor: at one
branch on Tuesdays, another on Thursdays, and often only on some weeks of the
month. Three pieces carry this. (1) `doctor_hospitals(doctor_id, hospital_id,
day_of_week, …)` decides WHICH BRANCH a weekday belongs to — it existed for a
long time written by the API and read by nothing, so every slot was stamped with
`doctors.hospital_id`; both `slotGenerator` paths now LEFT JOIN it and
`planDoctorSlots` emits `hospitalId` per slot. A doctor without those rows
behaves exactly as before. (2) `doctor_schedules.week_of_month INTEGER[]` is the
cadence: `{1,3}` = the 1st and 3rd occurrence of that weekday in the month,
alternate weeks are `{1,3,5}`, and NULL/empty means every week —
`matchesWeekOfMonth` FAILS OPEN on anything empty or malformed, because reading
"no restriction" as "no weeks" would erase a dentist's whole calendar.
(3) `isBlockedDay(dateStr, hospitalId)` takes the branch, so a holiday at one
branch can't close the day the doctor spends at the other. `POST
/doctors/:id/schedule` writes both tables together and is the only UI for
either; `seed.js` clears both so a re-seed is a true reset. The
`(doctor_id, slot_date, start_time)` unique index also means a visiting doctor
can never hold slots at two branches at the same moment.

Consequence for the bot: a doctor's next clinic is routinely more than
`SLOT_LOOKAHEAD_DAYS` (14) away. `handleSelectDoctor` therefore falls back to
`CRON_LOOKAHEAD_DAYS` when the two-week window is empty and says so, rather than
dead-ending — which for a treatment sitting was a hard dead end, since the
dentist list holds exactly one entry and there is no alternative to offer.

**Money, lab work and recare hang off the treatment plan.** `treatment_payments`
is the course billed as a WHOLE — deliberately separate from
`appointments.effective_fee`/`payment_status`, which is the per-visit
consultation fee; conflating them double-counts revenue. Balance is derived
(`estimated_cost − SUM(amount)`), clamped at 0, with `overpaid` surfaced rather
than hidden — it usually means a stale estimate. Recording a payment is open to
the front desk; DELETING one is `adminOnly` and audited, since it is the only
operation that reduces recorded revenue. `lab_works` tracks crowns and dentures
out at the lab, because a sitting that depends on one cannot be booked on slot
availability alone. `patient_recalls` is the six-month check-up loop, created
automatically when a visit is marked completed (the only moment the clinic
reliably knows a patient is between courses) with a partial unique index on
`(patient_id, reason) WHERE status='due'` so three visits in a month cannot
queue three identical reminders; `jobs/recalls.js` closes any recall the patient
has already acted on BEFORE sending, or it chases people who have booked. A
plan is `stalled` when work has started, nothing is booked, and the last sitting
was ≥30 days ago — different from "advised yesterday", and usually the case with
money outstanding.

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
for the retry cron. Processing is serialised per phone by `utils/phoneLock.js`
— once before tenant routing (the clinic search and session writes) and again
in `jobs/botWorker.js` once the clinic is known. Both fail OPEN: a Redis blip
must never silence the bot.

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
(`computeDaySlotTimes`, `planDoctorSlots`, `generateSlotsForDoctor`). Any path
that creates slots must skip doctor leaves, clinic holidays and
(feature-flagged) public holidays — delegate to `planDoctorSlots`, don't
re-implement the day loop; the nightly sweep and the per-doctor regen both use
it. The window starts at TODAY, keeping only slots later than the current IST
time (`tests/slotPlanner.unit.test.js`) — starting at tomorrow meant a dentist
added this morning had no same-day availability. Any path that clears slots
before regenerating must therefore clear today's REMAINING slots too, or the
old grid survives alongside the new one.
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
