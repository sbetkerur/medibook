# MediBook — WhatsApp Appointment SaaS for Dental Clinics

Multi-tenant appointment booking for Indian dental clinics. Patients book by
chatting with a WhatsApp bot (Meta Cloud API); clinic staff manage everything
via a Next.js dashboard; a super admin manages tenants.

> This file describes the codebase AS IT IS. The original build-phase scaffold
> instructions it replaced are obsolete — trust the code, not old docs.

## Stack

- **Backend:** Node.js + Express (`backend/`), PostgreSQL (schema-per-tenant),
  Redis + BullMQ (bot queue, rate limits, caches, cron locks)
- **Frontend:** Next.js 14 App Router + Tailwind (`frontend/`)
- **Messaging:** Meta WhatsApp Cloud API (v21.0) — the ONLY channel; see below

## Commands

```bash
docker-compose up -d            # postgres + redis for local dev
cd backend && npm run dev       # API on :3001 (nodemon)
cd backend && npm run migrate   # public schema + per-tenant migrations (also runs demoData.js)
cd backend && npm run seed      # demo tenant + doctors + slots
cd backend && node src/db/demoData.js   # rebuild the pragati-demo scenario dataset (patients, appts, plans, …)
cd frontend && npm run dev      # dashboard on :3000
cd backend && node tests/bot.test.js        # bot flow tests (needs DB + seed)
cd backend && node tests/botFlow.unit.test.js
cd backend && node tests/entryCode.unit.test.js      # QR entry codes (the only way in)
cd backend && node tests/labelFit.unit.test.js       # long clinic names vs WhatsApp title caps
cd backend && node tests/templateContract.unit.test.js   # doc vs senders: template params
cd backend && node tests/entryFlow.test.js           # entry routing e2e (needs DB + seed
                                                     # AND a backend running on :3001)
cd backend && node tests/slotPlanner.unit.test.js
cd backend && node tests/billingDrift.unit.test.js   # per-branch billing staleness
cd backend && node tests/doctorDepartments.unit.test.js  # multi-department doctors
cd backend && node tests/treatmentPlan.unit.test.js      # multi-visit treatment courses
cd backend && node tests/circuitBreaker.unit.test.js     # HALF_OPEN lets ONE probe through
cd backend && node tests/messageBudget.unit.test.js      # budget 0 means none, not "default"
cd backend && node tests/rateLimitFallback.unit.test.js  # per-tenant cap with no Redis
cd backend && node tests/razorpaySignature.unit.test.js  # self-serve billing: checkout + webhook HMACs
cd backend && node tests/billing.unit.test.js            # GST split (inclusive, CGST/SGST vs IGST), FY, invoice numbering
cd backend && node tests/billingWebhook.unit.test.js     # mocked Razorpay: updateSubscription body + subscription.charged → GST invoice (idempotent)
cd backend && node tests/sendCaps.unit.test.js           # trial outbound cap: 50/24h until paying
cd backend && node tests/otp.unit.test.js                # WhatsApp OTP: attempts, cooldown, single-use
cd backend && node tests/readOnlyTenant.unit.test.js     # whole-tenant read-only guard (demo clinic)
cd backend && node tests/demoReadOnlyBot.unit.test.js    # same guard, extended into the bot engine itself
cd backend && node tests/askingTenant.unit.test.js       # answers redirect to the clinic that asked (confirmation/feedback/treatment/recall)
cd backend && node tests/dentalHistoryEncryption.unit.test.js  # dental_history encryption: round-trip, legacy fallback, tamper detection
cd backend && node tests/backupEncryption.unit.test.js   # backup file format shared by backupManager.js/backup-prod.js/decryptBackup.js
cd backend && node tests/reviewFunnel.unit.test.js       # Google review funnel: only rating >=4 + settings.google_review_url set
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

**Shared WhatsApp number, and the QR is the only way in.** All tenants share the
global `META_*` credentials, so every inbound message has to be resolved to a
clinic. Exactly one thing does that: the clinic's own **entry code**
(`utils/entryCode.js`), scanned off a QR that encodes a `wa.me` deep link with
the code pre-typed. There is deliberately no clinic-name search and no
browse-by-location — both existed, both worked, and both were removed because
they answered a clinic's own patients with a picker containing the competitors
down the road, which is not a product a clinic will pay for. A clinic whose QR
is not printed anywhere is unreachable; that is the accepted cost, and it is why
the QR panel leads the Settings tab.

Codes are 6 characters from an alphabet with no `0/O`, `1/I/L` or `U`
(`ALPHABET`), because a misread character cannot be recovered afterwards — an
"O" is an equally plausible misreading of both "Q" and "D". Input is therefore
case-folded and stripped of separators only, never character-substituted. The
code identifies a CLINIC and is printed in a public waiting room: it is a
routing hint, not a credential, and confers no authority — everything
downstream still authenticates the patient by phone number.

`extractEntryCode` returns two shapes and the difference is the whole safety
story. A **tagged** code (`#K7M2QX`, what the deep link pre-types) is honoured
from ANY state, including mid-booking with a different clinic — a patient who
scans another clinic's poster means it, and "finish your current booking first"
would be absurd. A **bare** code (the whole message and nothing else, what
typing off a printed card produces) is honoured only while no clinic is
attached, since mid-conversation six characters are far more likely to be an
answer. A candidate that resolves to no active tenant is answered with "that
code didn't match a clinic", not a generic welcome — a patient who scanned
something needs to know whether the scan or the clinic was the problem.

**Nothing a patient can type detaches them from their clinic.** With the QR as
the only way in, a detached patient with no poster in front of them has no way
back, so `global_bot_sessions.tenant_id` is cleared by exactly two things: a
successful scan of a DIFFERENT clinic's code, and the clinic being deactivated.
"Hi" no longer resets the clinic (it used to, when the reset landed on a
search); it now reaches the engine, which resets to that clinic's main menu —
which also means "start" reaches the engine with the clinic attached, so an
opted-out patient can still re-subscribe. "Switch clinic" (`SWITCH_CLINIC_RE`,
noun required so a bare "change" mid-booking doesn't fire) is answered with an
instruction to scan, and clears nothing. Selecting a clinic hands the engine a
synthesised "Hi" so it lands on that clinic's menu with a clean session, and the
patient's real message is preserved in `inboundContent` for clinic history.

Codes are minted at tenant creation (`POST /tenants`, `seed.js`) AND backfilled
unconditionally on every boot in `migrate.js` — migrate runs before seed, so a
tenant created without one would otherwise be unreachable until the next
restart. Uniqueness is settled by `idx_tenants_entry_code` with a retry, never
by a prior SELECT, which would race a concurrent create. The demo tenant's code
is fixed (`TESTME`) so the demo link survives a re-seed.

`GET /admin/clinic-qr` renders the SVG/PNG and the deep link for the dashboard;
regenerating is `adminOnly` and audited, because it is destructive in the
physical world — every card and poster already carrying the old code stops
working, and the clinic finds out when patients stop arriving. `buildEntryLink`
percent-encodes the `#`: left raw it becomes a URL fragment, never reaches
WhatsApp, and the QR silently degrades into a blank message to the shared
number. The link needs `WHATSAPP_PUBLIC_NUMBER` (the human-dialable number, not
`META_PHONE_NUMBER_ID`); without it the API reports `configured:false` with a
reason rather than printing a QR that goes nowhere.

Clinic city lives in `tenants.city` (public schema, indexed on `lower(city)`);
it is no longer used for routing but is still shown in admin views. Pass
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

**WhatsApp is the only channel out — there is no email and no SMS.**
`services/email.js` (Resend) and `services/sms.js` (Twilio) are gone, along with
the BullMQ email queue, the Resend bounce webhook, the open-tracking pixel, the
email unsubscribe flow and the weekly digest cron (which existed only to send
one). Do not reintroduce a second channel without a decision to: every patient
message must be reachable in `wa_messages`, and a channel that bypasses it is
invisible in clinic history.

Two consequences worth knowing. **Password recovery is no longer self-service** —
`/auth/forgot-password` and `/auth/reset-password` delivered a link by email and
are removed; the only path is `POST /superadmin/tenants/:id/users/:userId/reset-password`,
which returns the new password ONCE for a human to hand over. And `users.email`
stays throughout: it is the LOGIN identity, never a delivery address. So does
`notify_phone`, which has only ever fed `notifyAdminWhatsApp` — it was mislabelled
"SMS notification number" in the dashboard and never touched Twilio.

The DB schema is untouched: `patients.email`, `email_sent_log`,
`email_unsubscribes` and friends still exist. Nothing reads or writes them, and
dropping columns is the one irreversible step here — do it deliberately in a
migration if ever, not as a side effect.

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

**From the patient's side, this is the CLINIC's WhatsApp, not a platform.** The
number is shared, so nothing but copy sells that — and the copy has to hold the
line everywhere. Every interactive message carries the clinic's name in its
`header` (`sendMainMenu`), and a QR arrival additionally leads with it in the
BODY, because the header renders small and grey and the first thing someone who
scanned a poster needs is confirmation they reached the practice they are
standing in. That welcome is ONE message: the old "✅ Connecting you to X…"
handover is gone, since after a scan there is nothing to disambiguate and it put
a switchboard between the patient and the clinic. `welcome` is set by
`routes/webhook.js` only on the synthesised greeting after a scan and rides the
BullMQ job payload to `botEngine.handle` — an ordinary "Hi" or "Menu" later in
the thread is not an arrival and must not trigger it. No patient-facing copy may
mention MediBook, offer "a different clinic", or otherwise imply a roster
exists; the ONLY platform-branded surface is the prompt shown to someone with no
clinic attached, who by definition has no clinic to speak as.
`tests/botFlow.unit.test.js` pins all of this.

**If the bot says "call us", it must give the number.** `hospitals.phone`
existed for a long time and was read by nothing, while six messages — including
the emergency reply, where it is the ONLY useful instruction — told patients to
ring and left them to find the number themselves. `clinicPhoneLine`
(`bot/utils.js`) resolves the branch's number, falls back to any active branch,
and returns '' when the clinic stored none, so callers concatenate it
unconditionally. The third main-menu button is *Address & Phone*
(`showClinicInfo`); it replaced *Check Status*, which asked for a booking ID no
patient keeps in order to show what *My Appointments* already shows from their
phone number alone. "status" stays a keyword and now routes there too. Every
menu offering the three buttons must offer the SAME three — bookingFlow's two
cancelled-booking menus included, or the third option changes meaning depending
on how the patient arrived.

**The owner's week arrives on WhatsApp.** `sendWeeklyDigests` (Mondays 08:00
IST) is the one report that reaches a clinic owner without them logging in, and
an owner who is chairside all day does not log in. It was an email; it now goes
through `notifyAdminWhatsApp` to admins with a `notify_phone`. Deliberately
short — appointments, no-shows, revenue, and treatment advised but not booked —
and it sends nothing at all for a week with no appointments.

**And each dentist's day arrives the same way.** `sendDoctorDailySchedules`
(`jobs/reminders.js`, 07:30 IST, rides `startReminderCron`) WhatsApps each
dentist their own list for today — off by default, opt-in per clinic via
`settings.doctor_daily_schedule_enabled`, and only to dentists whose
`doctors.user_id` account has a `notify_phone` (otherwise unused). Staff-facing:
it goes through `sendStaffWhatsApp` (`services/bot/utils.js` — the
`clinic_staff_alert` template shared with the admin fan-out, text fallback,
logged as an `admin_alert` row) so it NEVER counts against a patient's message
budget. A dentist with nothing booked that day gets no message, same as the
weekly digest skips an empty week.

**Password recovery is the clinic's own.** `POST /admin/staff/:id/reset-password`
(`adminOnly`, audited) returns a new password ONCE and revokes that user's
refresh tokens. It refuses to reset your OWN account: `/auth/change-password` is
that path and it requires the current password, so allowing self-reset here
would turn a hijacked admin session into a permanent takeover. Removing email
left the SUPER admin as the only unlock, which meant a Saturday call to the
vendor before the front desk could take a booking.

**One shared number is the single point of failure.** See
`docs/whatsapp-outage-plan.md` — what to watch, what still works during an
outage (the whole dashboard; only patient messaging stops), and the
clinic-facing exports that mean nobody is trapped: `/analytics/export` with
`type=patients`, `type=appointments&days=all` or `type=treatments`, capped at
50k rows. One clinic's block rate degrades the number for EVERY clinic, which
is why the sending rules live in the platform and not in clinic hands.

**Error copy names the cause and gives exactly one way out.** "Sorry, something
went wrong. Please try again." appeared in four different phrasings and told a
patient nothing — most importantly not whether anything had been booked, which
is the only thing they actually want to know. Every failure message now says
whose fault it was ("at our end"), what state things are in ("nothing was
booked, so no time has been held for you") and the single next step. Emoji
prefixes on errors (⚠️ ❌ ❓) are gone: when every message shouts, none of them
does, and a patient who mistyped a date has not encountered a warning.

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
`getSession`/`updateSession` in `services/bot/utils.js`. **"Hi" and "Menu" both
mean the CURRENT clinic's main menu**, and neither detaches the patient —
`routes/webhook.js` no longer intercepts greetings at all, so every one of them
reaches the engine with the clinic attached (which is what lets "start"
re-subscribe an opted-out patient). Patient-facing copy should point at
`Reply *Menu*`; copy must NOT tell a patient that `*Hi*` changes clinic, because
only scanning another clinic's QR does that. Selecting a clinic hands the engine
a synthesised "Hi" so it lands on that clinic's main menu with a clean session,
and a greeting always resets to the main menu from any state.
Handlers live in `services/bot/bookingFlow.js`
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

**Cancelling offers to MOVE it first.** When a patient rings to cancel, the
receptionist says "what about Thursday?" and a good share take Thursday — the
bot used to automate only the losing half of that conversation, with "Schedule
conflict" sitting on the reason screen one tap from a red button. The confirm
step now leads with *Move it instead* and hands straight to
`handleRescheduleSelect`, which re-reads the booking by id so nothing is
destroyed on the way through. Every button index shifted by one as a result —
`btnIdx` 1 is cancel, 2 is keep, and the numbered text fallback moved with them
(`tests/staleConfirm.unit.test.js`). A stale tap still re-asks rather than
reaching the save.

**One message budget per patient, across every cron.** Each cron throttled
itself and nothing looked at the patient as a whole: a root-canal patient could
collect two reminders per sitting, a feedback request after each, three nudges
and a recall inside a few weeks. Blocks are what degrade a WhatsApp number, and
every clinic shares one — so one clinic's over-messaging degrades delivery for
all of them. `services/messageBudget.js` gates the DISCRETIONARY sends only
(feedback, post-visit follow-up, treatment nudges, recalls) at 6 per 7 days.
Reminders and confirmations are NEVER gated: a patient with an appointment
tomorrow wants that message, and suppressing it causes the no-show the reminder
exists to prevent. The COUNT includes everything the patient received, because
blocking is driven by total volume as they experience it — but `admin_alert`
rows go to STAFF and must never eat a patient's budget. Fails OPEN.

**`is_active` and `online_bookable` are different questions.** The first is
"does this dentist work here", the second is "may a PATIENT pick them in the
bot". A visiting orthodontist is very much active and takes referred cases, not
walk-in toothache off a menu; an owner usually wants new patients coming to them
rather than to whichever associate has a gap. Every bot query that lists
dentists filters on `online_bookable`; the dashboard deliberately does not, so
the desk can still book anyone. Defaults TRUE.

**Feedback is asked once a month per PATIENT, not once per visit.** Three
sittings in a month used to mean three rating requests — fatiguing, and it
manufactures a written archive of complaints. Keyed on `patient_id` rather than
phone, so a father's root canal does not silence his daughter's first visit. The
copy now states plainly that the answer goes only to the clinic.

**A high rating is the ONLY place patient copy links out.** When
`settings.google_review_url` is set, `handleFeedbackComment` (`botEngine.js` —
the single exit of the rating flow, reached by a typed comment or `Skip`) sends
one extra line inviting a patient who rated **4 or 5** to leave a Google review.
1–3 stars are never asked and stay entirely internal — which is what the rating
prompt promises. The link goes only to the clinic's own review page; it names no
platform and offers no roster (the patient-copy rules still hold). Its own
try/catch — the feedback row is already saved and a failed nudge must not read
as an error. Blank URL = feature off. `tests/reviewFunnel.unit.test.js`.

**Money leaves a trail the patient keeps.** Recording a `treatment_payment`
sends a receipt over WhatsApp — amount, method, paid-so-far and balance. It is
NOT a tax invoice and does not pretend to be; it is the payment slip a front
desk would hand over. Best-effort and non-blocking: the money is already
recorded, and a failed send must never fail the request or tempt the
receptionist into keying the payment twice. `POST /treatment-plans/:id/consent`
records that consent was taken, by whom and what was explained — the FACT, not a
signature — and is audited, because an unaudited consent record is worth little
if it is ever needed. Not `adminOnly`: the dentist who took it is usually not
the account owner.

**`GET /day-close` is the end-of-day count.** Consultation fees and treatment
payments stay SEPARATE (conflating them double-counts revenue). The
consultation half uses `COALESCE(NULLIF(a.effective_fee,0), d.consultation_fee)`
— the same expression the analytics queries and the weekly digest use.
`effective_fee` (an OVERRIDE; 0/unset means "use the doctor's rate") and
`payment_status`/`payment_method` all now have writers — `PATCH
/appointments/:id`, open to the same non-admin roles as marking an appointment
completed (front-desk work, not `adminOnly`). `payment_status` is `pending`
(the column default — a completed visit nobody has touched yet reads as this,
never as silently paid) → `paid` (stamps `payment_method`, defaulting to
`cash`, and `payment_collected_at=NOW()`) or `waived` (clears both — a waived
fee is not outstanding money). `collected_total` counts only fees actually
MARKED paid, plus treatment payments — not "every completed visit," which is
what an earlier version assumed before either column had a writer, and which
reported ₹0 every day once it tried to sum `effective_fee` raw. A completed
visit nobody has marked shows up in `appointments.fees_pending`/
`pending_count` instead, which the dashboard surfaces as an amber "still
marked unpaid" banner — the desk works that down before trusting the number,
same discipline as recording a treatment payment. Consultation fees also get
their own "by method" breakdown now (`consultation_payments.by_method`),
mirroring `treatment_payments.by_method`'s existing reconciliation. IST
throughout — `created_at` is a TIMESTAMPTZ and is compared in Asia/Kolkata, or
a clinic closing at 21:00 sees yesterday.

**On-demand PDF reports.** `utils/pdfReport.js` (pdfkit) is the only PDF path:
`streamReport` writes the clinic band + page numbers, `drawTable` paginates,
`rupees()` is the money format. Noto Sans (regular + bold) is embedded from
`src/assets/fonts/` and subset into every report — pdfkit's built-in Helvetica
has no ₹ glyph and would drop it silently, so callers use the logical fonts
`'body'`/`'bold'`, never `'Helvetica'`. The reports in `routes/reports.js`:
`GET /reports/schedule.pdf` (a day grouped by dentist; for a FUTURE date it also
carries each patient's 24h-reminder reply and a "confirmed / to call" count, so
tomorrow's schedule IS the evening call-list — there is no separate unconfirmed
report); `GET /reports/dues.pdf` (money owed — unpaid completed-visit
consultation fees AND treatment-plan balances, on one worklist; the treatment
half flags `stalled`); `GET /reports/recalls.pdf` (the check-up call-list —
recalls due/overdue in the next 45 days, last visit, and whether the WhatsApp
nudge went unanswered); `GET /reports/lab-works.pdf` (crowns/dentures out at the
lab, soonest-due first, overdue flagged); `GET /reports/dentist-activity.pdf`
and `GET /reports/period.pdf` (both `?from=&to=`, default current IST month via
`parseRange` — per-dentist seen/completed/no-show/fees/advised/rating, and the
month-end money-by-method + appointment-mix + revenue-by-dentist/treatment
summary; the money expressions match `day-close` exactly). Plus the `?format=pdf`
arms of `GET /day-close`, `GET /requests`, and `GET /treatment-plans`
(`routes/treatmentPlans.js` — the "advised but not booked / `stalled=true`"
worklist the weekly digest only quotes a count of; filtered on the derived
`withProgress` fields, not in SQL), and `GET /treatment-plans/:id/estimate.pdf`
(a printable quotation — cost, paid, balance, visits so far — that states on its
face it is NOT a tax invoice; the GST invoices under `/billing` are). All stream,
store nothing, and are NOT `adminOnly` — they are read views the front desk
prints (surfaced in `OverviewTab.js`'s Reports card); the bulk PHI extract that
is admin-gated (`/analytics/export`) does not go through here.

**Analytics has a treatment-conversion funnel.** `GET /analytics/funnel`
(consultation → advised → booked → started → completed → paid, plus per-dentist
and per-treatment breakdowns) is derived from the linked appointments/payments,
never a stored counter — same principle as `routes/treatmentPlans.js`. `GET
/analytics` also returns `by_source` (new patients by `patients.referral_source`
over the window) — the column already existed and is set at the desk via
`PATCH /patients/:id`; this is the reporting half.

**A working day is a LIST of sessions.** An Indian dentist routinely does 10–1
at one clinic and 5–9 at another on the SAME day; for a visiting endodontist it
is the default arrangement. `doctor_schedules` therefore keys on
`(doctor_id, day_of_week, start_time)` and carries its own `hospital_id` — a
schedule row IS a session. It used to be `UNIQUE(doctor_id, day_of_week)` while
`doctor_hospitals` was keyed per `(doctor, hospital, day)`, so two branches on
one weekday returned two joined rows and `planDoctorSlots` took the first with
`.find()`: the evening branch generated NO slots and nothing reported a problem.
The planner now `filter`s, each session carries its own branch, week-of-month
cadence and holiday check, and `POST /doctors/:id/schedule` rejects overlapping
sessions outright — otherwise the overlap is swallowed by the
`(doctor_id, slot_date, start_time)` unique index on `time_slots`, which is
exactly how the original bug stayed invisible. `doctor_hospitals` is now a
mirror for the `/locations` API only; `doctor_schedules.hospital_id` is what
slot generation reads. Days are REPLACED on save, not upserted, or a session the
admin deleted lingers and keeps generating slots.

**The grid is a guide, not the diary.** An Indian clinic does not turn a patient
away because the slot list is empty — the receptionist fits them in. So the two
places the bot used to dead-end (a dentist with nothing in the whole lookahead,
and a specific date that filled up) now offer a way through:
`services/bot/requestFlow.js` writes a `clinic_requests` row and alerts admins on
WhatsApp. `callback` is also a menu keyword in its own right. A partial unique
index keeps ONE open request per phone per kind — a patient who taps it on three
dates is one person wanting one appointment, not three items on the
receptionist's list. Clearing them is front-desk work, so `PATCH /requests/:id`
is deliberately NOT `adminOnly`: gate it behind the owner and the list is never
cleared and stops being trusted.

**Orthodontics is self-bookable, on its own monthly cadence.** Braces are 18–24
monthly adjustments over two years. Each adjustment is an ordinary chairside
visit — nothing about the visit itself needs the dentist to hand-pick a date —
so it goes through the same bot booking flow as any other sitting. What's
different is the PACE: chasing an orthodontic patient on the short-course
cadence (a nudge every week, up to 3 times) would nag them for an adjustment
that isn't due for weeks and is a fast way to get the clinic's shared number
blocked. `utils/treatmentPlan.js`'s `isOrthodonticDepartment` (a keyword match
on the plan's department name — clinics type their own department names, so
there's no id to key off) is checked in two places that must stay in step:
`services/bot/treatmentFlow.js`'s `getOpenPlans`, which offers an orthodontic
plan in the bot's treatment list regardless of `scheduling_mode`, and
`jobs/treatmentNudges.js`, which runs `findPlansNeedingNudge` a SECOND time
with its own thresholds — one nudge, 30 days after the last sitting, instead of
the ordinary 3-day quiet period and 3-nudge cap. "One nudge" is per GAP, not per
plan, and cannot be expressed with `nudge_count`, which only ever increments:
with `ORTHO_MAX_NUDGES_PER_PLAN` as the gate it meant one nudge for the whole
two-year course, so a patient chased once after sitting 3 was never chased again
for the remaining ~14 adjustments. The gate is instead "no nudge since the most
recent non-cancelled sitting", which resets each time the patient actually
attends; the constant survives only as a lifetime backstop. `treatment_plans.scheduling_mode`
(`patient` | `clinic`) still exists for any OTHER course type a dentist wants
scheduled purely at the chair (`clinic` plans stay excluded from the ordinary
nudge cadence and the bot's treatment list) — orthodontics is simply no longer
routed through it. `total_visits` caps at 60, not 30 — a two-year case is
monthly adjustments plus bonding, debond and retainer reviews.

**The consultation fee is quotable, not fixed.** Indian clinics waive it when the
patient takes treatment, and they negotiate. A firm number shown in WhatsApp and
not charged at the desk is an argument the receptionist has to have, so
`settings.show_consultation_fee` (default true, preserving existing behaviour)
switches it off everywhere — the dentist picker and the confirmation both read
`showFeesEnabled`, so the two cannot disagree. When shown it reads "payable at
the clinic", which leaves room for the waiver.

**The dashboard opens on today, because half the footfall walks in.** The landing
tab leads with today's queue and a `+ Walk-in` button, then the requests above,
then the stat row. Walk-in entry goes through ONE `openWalkinModal` callback
shared with the appointments tab so the two cannot prefill differently.

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
branch can't close the day the doctor spends at the other.

The `doctor_hospitals` fallback is scoped in FOUR places that must stay
identical — `tenantMigrate.js`'s backfill, both `slotGenerator` queries and
`GET /doctors/:id/schedule`. A session whose `hospital_id` is deliberately NULL
means "the doctor's PRIMARY branch", and `/doctors/:id/schedule` writes a
`doctor_hospitals` row only for a session that names a branch. So on a Tuesday
split "10–13 at branch B / 17–21 at primary (NULL)" there is exactly ONE `dh`
row, and joining it on weekday alone hands branch B to the evening session too:
the whole evening at the main clinic is generated, told to patients and
holiday-checked as B. The fallback therefore applies only where NO session that
weekday names a branch, and only where that weekday has exactly one `dh` row
(two would MULTIPLY the session and `ON CONFLICT DO NOTHING` would keep an
arbitrary branch).

Consequence for the desk: a walk-in with a visiting consultant is booked at the
branch they SIT at that day, not their primary. `POST /appointments` accepts any
branch the doctor works at (primary, `doctor_schedules` or `doctor_hospitals`) —
requiring the primary while the slot lock requires `time_slots.hospital_id` made
the two conditions unsatisfiable for a visiting doctor, so no combination could
book them into a real slot. `GET /doctors` returns `hospital_ids` (every branch
worked) for the same reason; filtering a dentist list on `hospital_id` alone
hides visiting consultants from the branch the patient is standing in. `POST
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
hashes only. Rotation alone does not protect a STOLEN refresh token — the thief
redeems first, the real user's 401 looks like an ordinary expiry, and the thief
rotates on for 30 days. So a miss is re-checked against `used=true`: a replay
revokes every outstanding token for that user and writes a
`refresh_token_reuse` row to `admin_access_logs`. A token redeemed within
`REFRESH_RACE_GRACE_SECONDS` is exempt — that is the user's own tabs racing
(the client serialises with a Web Lock but carries a fallback for browsers
without one), and treating it as theft would log people out at random. Auth + tenant + per-tenant rate-limit middleware are applied ONCE
in `index.js` for `/api/admin` and `/api/v1/admin` — route files must not
re-apply them. Mutating admin routes use `adminOnly`; validate route UUIDs with
`validateUUID()` / shared `UUID_RE` from `utils/errors.js`.

**Two roles, and authorization is binary.** `VALID_ROLES` is `['admin',
'doctor']` — `doctor` is shown as "Dentist" in the dashboard. There is no
`staff` role: it was permission-identical to `doctor` and folded into it by an
idempotent `UPDATE users SET role='doctor' WHERE role='staff'` in
`tenantMigrate.js`. A clinic may have any number of admins;
`routes/admin.js` refuses to demote or deactivate the LAST active one.
`adminOnly` (`role === 'admin'`) is the only gate — every route not carrying it
is open to a dentist login. That tier is deliberate, not lax: a dentist reads
everything and records clinical work (appointment notes, mark-complete/no_show,
treatment plans, consent, lab work, payments), while walk-in booking,
reschedule, **cancel** (`PATCH /appointments/:id` blocks a non-admin setting
`status='cancelled'`), bulk edits, patient/settings/staff mutation, QR regen and
PHI export are all `adminOnly`. Anyone who works the front desk must be an admin.

**A whole tenant can be READ-ONLY, orthogonal to the role split.**
`tenants.read_only` (default false) — `middleware/auth.js` `enforceReadOnlyTenant`
runs once in `index.js` after `tenantMiddleware` for `/api/admin` +
`/api/v1/admin` and 403s every non-`GET/HEAD/OPTIONS` request with
`{ read_only: true }`, whatever the user's role. `/auth/*` is not under that
prefix, so the login still works; `/auth/change-password` refuses a read-only
tenant on its own (a public demo login must not be able to lock everyone out).
Built for the shareable **demo clinic** (`pragati-demo` / "Pragati Dental
Studio", entry code `TRYMED`): `ensureDemoTenant` in `migrate.js` sets the flag
(and pre-accepts the ToS so the blocking `TermsGate` can't trap a visitor),
re-asserting it every boot from `DEMO_READ_ONLY` (default on; set `=false`,
restart, hand-edit the fixture, restart). `/auth/login` and `issueSession` both
return `read_only` in the `user` object; the dashboard shows
`components/ReadOnlyBanner.js`. `POST /auth/demo-session` (public, rate-limited)
mints a passwordless session for `DEMO_TENANT_SLUG` (default `pragati-demo`) —
but ONLY while that tenant is `read_only` + `active`, so it can never reach a
real clinic. The public site uses it: `frontend/src/app/page.js` is the
marketing landing page (root `/`; the old `/`→`/login` redirect is gone,
healthcheck is on `/login`) and `frontend/src/app/demo/page.js` is the "See a
live demo" button. Tests: `tests/readOnlyTenant.unit.test.js`.

`ensureDemoTenant` seeds only the STRUCTURE (branch, 4 departments, 3 dentists —
Ananya Rao / Vikram Shetty / Nisha Menon — schedules, admin user, slots).
`db/demoData.js` `seedDemoData()` then fills it with a **scenario dataset** so
every dashboard tab, report and chart shows real data: ~16 patients (every
`referral_source`, a father+child on one phone, encrypted `dental_history`, an
opted-out one), ~56 appointments across all four statuses and a 60-day span
(today's queue, tomorrow's reminder call-list, past history), all ten
`treatment_plans` states (proposed / on-track / **stalled** / completed /
overpaid / declined / cancelled / ortho / implant), payments in every method,
`lab_works` and `patient_recalls` in every status, a 1–5 feedback spread, and
open + handled `clinic_requests`. It runs on every boot right after
`ensureDemoTenant` (migrate.js), **clears and rebuilds** the demo tenant's
transactional rows (dates stay relative to "now"), and is gated by
`DEMO_SEED_DATA` (default on). Standalone: `node src/db/demoData.js`. It also
sets `settings.google_review_url` + `doctor_daily_schedule_enabled` so the
newest features read as on.

`enforceReadOnlyTenant` only ever covered the DASHBOARD (`/api/admin` +
`/api/v1/admin`) — nothing stopped the bot/webhook path from booking,
cancelling, rescheduling, or queuing a `clinic_requests` row (which also fires
a real WhatsApp alert to the clinic's own admin) against a read-only tenant.
Harmless while `pragati-demo`'s WhatsApp number was reachable only by its own
operators; not harmless once `frontend/src/components/WhatsAppDemoChat.js` (the
live, interactive "try the bot" widget in the marketing page's hero, backed by
`POST /api/demo/chat`) invokes the SAME bot engine as a public, unauthenticated
surface. `services/bot/utils.js` `isReadOnlyDemo(tenant)` extends the guarantee
down into the bot itself, checked immediately before each mutation rather than
earlier in the flow — browsing menus and picking a slot still works, only the
commit is blocked, replying with a "this is a live demo" message instead. Five
call sites: `bookingFlow.completeBooking`, `appointmentFlow.handleCancelConfirm`
+ `handleRescheduleConfirm`, and `requestFlow.handleCallbackRequest` +
`handleAppointmentRequest`. `routes/demoChat.js` is the second, narrower layer
that makes this reachable by the public in the first place: unlike
`POST /webhook/test` (whose free-form `tenant_slug` would, in the wrong hands,
return any patient's appointment details for ANY real tenant), it hardcodes
`DEMO_TENANT_SLUG` and re-verifies `read_only` + `active` on every call — the
same one-check safety story as `POST /auth/demo-session`. It runs the bot via
`services/bot/testRunner.js` (shared with `/webhook/test` and the authenticated
`/admin/bot-test`), keyed by a synthetic phone derived server-side from a
client-supplied per-tab session id — never a client-supplied phone. Neither
layer substitutes for the other. Tests: `tests/demoReadOnlyBot.unit.test.js`.

**Frontend.** All API calls go through the Next.js rewrite proxy
(`/api/proxy/*` → `BACKEND_URL`) — no API origin is baked into the bundle.
`lib/api.js` handles token attach, 401 → refresh rotation (queued), and
dispatches `medibook:token-refreshed` — long-lived consumers (the dashboard's
SSE `EventSource`, which carries the token in its URL) must listen and
reconnect. `dashboard/page.js` is one large file; if you touch it
substantially, prefer extracting tabs into `components/tabs/` (see
`SlotsTab.js`). The one third-party surface the CSP allows is
`checkout.razorpay.com` (billing) — added narrowly in `next.config.js`.

**Self-serve signup, and the super admin still approves.** A clinic can create
its own account (`routes/signup.js`, `/signup`). The super admin approves every
clinic AND that approval is what provisions it — see below. In production it is
off unless `SELF_SIGNUP_ENABLED=true` with a real Razorpay config; OUTSIDE
production `SELF_SIGNUP_ENABLED=true` alone opens it (`selfSignupEnabled()` only
checks `razorpay.isConfigured()` when `NODE_ENV=production`). Full walkthrough
and operator setup: `docs/self-serve-signup.md`.

Identity is proven by a **WhatsApp one-time code** to the owner's own number
(`services/otp.js`, `wa_otps`) — the ONLY verification channel this product has.
This is not the second delivery channel CLAUDE.md forbids: nothing
patient-facing changes and the code goes through the same WhatsApp sender.
`/auth/forgot-password` + `/auth/reset-password` are back on the SAME mechanism
(a code to the staff member's `notify_phone`) — the removed versions were
*email*-based. Delivery is template-first (`SIGNUP_OTP_TEMPLATE`), because an
owner is permanently outside Meta's 24-hour window.

**Nothing is provisioned until the super admin approves.** `/signup/confirm`
only REGISTERS the clinic: it INSERTs a `tenants` row at status `pending_review`
(with an entry code) and links it to the `pending_signups` row that carries the
owner's password hash. No PG schema, no admin user, no session, no trial — the
owner finishes on a "we'll WhatsApp you" screen and CANNOT log in.
`POST /superadmin/tenants/:id/approve` then does the rest: it builds the schema +
first admin user (`buildSelfServeTenantSchema`), starts the **card-free** trial
(`SIGNUP_TRIAL_DAYS`, default 14; `trial_end = now + N`), flips the tenant to
`active`, stamps `activated_at`, and WhatsApps the owner a login link
(`services/signupNotify.js`, `SIGNUP_APPROVED_TEMPLATE`, text fallback in dev).
It is idempotent (`CREATE SCHEMA IF NOT EXISTS` + `INSERT … ON CONFLICT DO
NOTHING`). A fresh schema has no hospital, doctor or schedule, so the owner's
FIRST admin login (`app/login/page.js`) checks `GET /admin/onboarding/status`
and routes to the guided wizard (`app/onboarding/page.js` — clinic details,
treatments, first dentist + weekly hours, then the QR code) instead of a bare
dashboard, rather than leaving the dashboard's own passive checklist banner
(`onboarding.steps`) as the only hint anything is left to do. Gated to
`role === 'admin'` and non-`read_only` — every wizard step is `adminOnly`
(hospital/doctor/schedule mutation), and the shareable demo tenant already has
all of it seeded so `all_done` is already true there regardless. Fails open to
`/dashboard` on any error; `POST /admin/onboarding/complete` marks it done
(and is what makes `all_done` stick — the dashboard banner keeps showing,
offering that button, until it's called explicitly). The card is only taken later, via `POST /admin/billing/subscribe` →
Razorpay Checkout → `/billing/subscribe/confirm`. `services/signupProvision.js`
holds all of it: `registerSelfServeTenant` (phase 1) +
`buildSelfServeTenantSchema` (phase 2) for self-serve, `provisionTenant` (one
shot) for the super-admin `POST /superadmin/tenants` route, and
`provisionSelfServeTenant` as a LEGACY recovery path for old-flow
`pending_payment` rows only (`jobs/billingDunning.js` `retryStuckProvisioning`).
Two copies of schema+migrations+first-admin+entry-code is exactly the drift not
to allow.

**Tenant `status` is now a lifecycle, not a boolean.** `pending_payment`
(LEGACY: old-flow signup whose inline schema build died, no login),
`pending_review` (signup submitted, awaiting
`POST /superadmin/tenants/:id/approve` — **no schema/user exists yet, cannot log
in**, patients can't reach it), `active`, `past_due` (trial lapsed / payment
failed — can log in and add a card), `suspended` (kill switch or grace elapsed),
`inactive`. `middleware/auth.js` `DASHBOARD_ALLOWED_STATUSES` and
`routes/auth.js` `LOGIN_ALLOWED_STATUSES` (both `active` + `past_due` only) are
the source of truth for who may log in; the bot's entry-code lookup still
requires `status='active'`, and every outreach cron filters `status='active'`
via `forEachActiveTenantParallel`, so a `past_due` clinic sends nothing
unsolicited without any cron change.

**Billing lifecycle.** `tenant_billing` (one row per self-serve tenant) is the
source of truth; `billing_events` dedups Razorpay webhooks on the
`x-razorpay-event-id` header. `routes/webhook.js` `POST /webhook/razorpay`
(HMAC-verified against `RAZORPAY_WEBHOOK_SECRET` on the raw body — same
`req.rawBody` hook as the Meta webhook) moves a tenant `active`⇄`past_due` as
the subscription's health changes, and never touches `pending_review` /
`suspended`. `jobs/billingDunning.js` (06:15 IST) is the backstop and the
enforcer: it ENDS lapsed card-free trials (`active` + `trialing` +
`trial_end` passed → `past_due`), reconciles subscriptions, and after
`SIGNUP_DUNNING_GRACE_DAYS` (default 7) moves `past_due` → `suspended`.

**Self-serve billing management** (`routes/billing.js`, tenant-facing under
`/api/admin`). A clinic runs its own subscription — no support ticket needed:
- **Cancel** (`POST /billing/cancel {reason}`) does NOT call Razorpay; it sets
  `tenant_billing.cancel_at_period_end`, and `billingDunning.js`
  `applyScheduledCancellations` issues the real Razorpay cancel once
  `current_period_end` passes. That makes `POST /billing/cancel/undo` a true
  undo (Razorpay has no un-cancel) and guarantees the clinic keeps every paid
  day. A trial (no subscription) just records the intent.
- **Plan change** (`POST /billing/change-plan {plan}`) — upgrade takes effect
  now (`razorpay.updateSubscription` with `schedule_change_at:'now'`), downgrade
  is scheduled for cycle end (`pending_plan_id` + `plan_change_at`, promoted by
  the `subscription.charged` webhook when Razorpay's live `plan_id` matches). A
  downgrade whose target plan can't fit current usage (3 dentists → 2-dentist
  plan) is refused with what to shed first.
- **Per-branch quantity.** Professional bills `plan_amount × active branches`.
  `services/billing.js` `syncSubscriptionQuantity` recomputes on every branch
  add/remove (`routes/hospitals.js`, fire-and-forget), pushes `quantity` to
  Razorpay (`schedule_change_at:'cycle_end'`), mirrors the rupee figure to
  `tenants.billing_monthly`, and `billingDunning.js` reconciles it daily.
- **GST tax invoices.** The Razorpay plan amount is GST-INCLUSIVE. The
  `subscription.charged` webhook writes one `billing_invoices` row per charge
  (`services/invoice.js`, idempotent on `razorpay_payment_id`) with the split
  back-computed by `services/billing.js` `splitGst` — CGST+SGST for a buyer in
  `SELLER_STATE_CODE`, IGST otherwise. `invoice_number` is
  `<INVOICE_NUMBER_PREFIX>/<FY>/<seq>` from `billing_invoice_seq`.
  `GET /billing/invoices[/:id]` (PDF via `utils/pdfReport.js`).
  `GET/PUT /billing/profile` captures the buyer's GSTIN / place of supply
  (`tenant_billing_profiles`); with none, the clinic is billed B2C and the
  invoice omits the buyer GSTIN. `billing_invoices.tenant_id` is
  `ON DELETE SET NULL` — a financial record outlives the clinic.
- `GET /billing` also returns `usage` (dentists/branches used vs plan limit),
  and the doctor/branch quota 403/409 now carries `code:'PLAN_LIMIT'` +
  `upgrade_to`.

**Signup review queue + rejection.** `SIGNUP_REVIEW_NOTIFY_PHONE` (comma list)
gets a WhatsApp ping when a clinic lands in `pending_review`
(`signupNotify.notifyReviewQueue`) — otherwise the queue stays dashboard-only.
`POST /superadmin/tenants/:id/reject {reason}` is the counterpart to `approve`:
valid ONLY for `pending_review` (no schema built yet), it deletes the `tenants`
row, frees the slug, and WhatsApps the owner.

**Tenant-initiated account deletion** (`routes/account.js`, `/api/admin`, so the
read-only demo can never reach it). `POST /account/deletion {password, confirm}`
(admin's own password + literal `"DELETE"`) sets `deletion_requested_at` +
`deletion_scheduled_for = now + ACCOUNT_DELETION_GRACE_DAYS` (default 14) and
flags the subscription to cancel. Nothing is scrubbed during the window — the
clinic works normally and `POST /account/deletion/cancel` fully reverses it.
`jobs/accountDeletion.js` (03:30 IST, after the backup) then `DROP SCHEMA …
CASCADE` + `DELETE FROM tenants` — the one irreversible cron, guarded by a
re-read, the `validateSchemaName` pattern, and a final backup existing first.

**Public status page.** `GET /api/status` (unauthenticated, no per-tenant data)
reports database reachability, cron freshness, webhook backlog and the shared
WhatsApp circuit-breaker state; `frontend/src/app/status/page.js` renders it.

**Trial send cap** (`services/sendCaps.js`). A self-serve tenant on the shared
number is throttled to **50** (`SIGNUP_TRIAL_SEND_CAP`) clinic-initiated patient
messages / rolling 24h **while on the card-free trial** — the cap is lifted the
moment a live Razorpay subscription is attached (`razorpay_subscription_id` set +
`subscription_status` active/authenticated). A lapsed trial with no card stays
capped; a super-admin-provisioned clinic (`signup_source <> 'self_serve'`) is
never capped. Enforced in `services/outbound.js` `sendPatientMessage` only (the
outreach path); appointment reminders and confirmations call the lower senders
directly and stay ungated, exactly as `services/messageBudget.js` treats them.
Fails OPEN.

**Kill switch.** `POST /superadmin/tenants/:id/suspend {reason}` / `.../resume`
— one call, audited, effective within the 5s tenant-cache TTL. `resume` on a
self-serve clinic returns it to `past_due` (still owes payment) unless
`?to=active`.

**`patients.dental_history` is encrypted at rest, and so is every backup.**
Blood type, allergies, chronic conditions and medications used to sit in
plain JSONB — readable straight out of a `SELECT *`, and swept into the
nightly backup as plaintext too, across every clinic on the platform in one
file. `routes/patients.js` and `routes/appointments.js` now read/write it
through `utils/encryption.js`'s `encryptJSON`/`decryptJSON` — the same
`{_enc: "v2:..."}` convention `services/botEngine.js` already used for
`bot_sessions.context`, reused rather than inventing a second format.
`decryptJSON` returns `null` on a decryption failure (wrong/rotated key,
corrupted row) — **never** `{}`: a dentist checking for an allergy must be
told the read failed, not handed a falsely-reassuring empty record. Every
route surfaces this as `medical_history_error: true`, and
`dashboard/page.js`'s patient modal already had the right instinct for a
*network* failure here (`medHistoryFailed`) — extended to treat a decryption
failure identically rather than silently rendering it as "none recorded." A
one-shot migration (`tenantMigrate.js`, `seed_markers` key
`encrypt_dental_history_v1`) encrypts every pre-existing plaintext row on the
next boot, per tenant; anything created or edited after that point is
encrypted automatically by the routes above.

Both backup paths are encrypted the same way (AES-256-GCM,
`[12-byte IV][ciphertext][16-byte auth tag]`, same `ENCRYPTION_KEY`):
`jobs/backupManager.js`'s nightly in-container `pg_dump` (streamed through a
cipher before it ever touches disk — `medibook_backup_*.sql.enc`) and
`scripts/backup-prod.js`'s off-Railway laptop copy (encrypted-then-deleted
after pg_dump writes it — `medibook-prod-*.dump.enc`), which is the more
exposed of the two: a full copy of every clinic's data sitting on a personal
machine rather than a server. `scripts/decryptBackup.js` reads either format
and fetches `ENCRYPTION_KEY` via the Railway CLI the same way
`backup-prod.js` already fetches `DATABASE_PUBLIC_URL`, so restoring needs no
separately-managed secret — but also means **losing or rotating
`ENCRYPTION_KEY` without keeping the old value makes every backup taken under
it permanently unreadable**, with no recovery path that doesn't start with
the original key. `scripts/verify-backup.js` decrypts to a temp file before
`pg_restore`ing it, and deletes that temp file whether verification passed or
failed. Tests: `tests/dentalHistoryEncryption.unit.test.js`,
`tests/backupEncryption.unit.test.js`.

## Environment variables

Required in prod (startup fails or warns otherwise): `DATABASE_URL`,
`JWT_SECRET` (≥32 chars), `ENCRYPTION_KEY` (≥32 chars, non-default),
`META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_WEBHOOK_VERIFY_TOKEN`,
`META_APP_SECRET`, `FRONTEND_URL` (locks CORS/CSP),
`WHATSAPP_PUBLIC_NUMBER` (the human-dialable number behind
`META_PHONE_NUMBER_ID`, digits or E.164 — every clinic's QR deep link is built
from it, so without it no clinic can be reached at all and the dashboard shows
`configured:false`). Optional: `REDIS_URL`
(queues, cron locks and shared rate-limit counters all degrade to in-process
fallbacks without it — nothing probes localhost; `tenantRateLimit` keeps a
per-process counter, which is a real limit for a single instance and the honest
bound for more than one, and logs the condition ONCE rather than per request), `OPENAI_API_KEY` (voice transcription),
`SENTRY_DSN`, `METRICS_SECRET`, `BACKUP_DIR`, `TIMEZONE`,
`WEBHOOK_RATE_LIMIT_PER_MIN` (default 2000; per-IP, and Meta delivers every
tenant's traffic from a shared IP pool, so this is effectively platform-wide).
Frontend: `BACKEND_URL` (server-side, Railway).

Self-serve signup (`docs/self-serve-signup.md`): `SELF_SIGNUP_ENABLED` (master
switch, default false — the ONLY one required outside production, where the flag
alone opens signup), `SIGNUP_TRIAL_DAYS` (default 14),
`SIGNUP_DUNNING_GRACE_DAYS` (default 7), `SIGNUP_TRIAL_SEND_CAP` (default 50 —
clinic-initiated patient messages / 24h while a self-serve tenant is on the
card-free trial; uncapped once paying), `SIGNUP_OTP_TEMPLATE` (+
`SIGNUP_OTP_TEMPLATE_HAS_BUTTON`, default true) — the WhatsApp template that
delivers verification/reset codes, `SIGNUP_APPROVED_TEMPLATE` — the template for
the go-live link sent on approval (two body vars: clinic name, login URL; text
fallback in dev), `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` /
`RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_STARTER` / `RAZORPAY_PLAN_PROFESSIONAL`
(the two recurring plan ids created in the Razorpay dashboard, mirrored to
`plans.razorpay_plan_id` on boot; the plan amount is GST-INCLUSIVE). In
production `index.js` warns at startup when `SELF_SIGNUP_ENABLED=true` but any
of these are missing, and `selfSignupEnabled()` reports the feature unavailable
without a real Razorpay config.

GST invoicing + lifecycle: `SELLER_LEGAL_NAME`, `SELLER_GSTIN`,
`SELLER_STATE_CODE` (default `29`, Karnataka — decides CGST+SGST vs IGST),
`SELLER_ADDRESS`, `INVOICE_NUMBER_PREFIX` (default `MB`);
`SIGNUP_REVIEW_NOTIFY_PHONE` (comma list, WhatsApp ping on a new
`pending_review` clinic; blank = dashboard-only queue);
`ACCOUNT_DELETION_GRACE_DAYS` (default 14).

## Testing without WhatsApp credentials

`POST /api/webhook/test` (`{phone, message, button_id, tenant_slug}`) runs a
message through the real bot engine and returns the replies it would have sent.
Enabled outside production or with `ENABLE_TEST_ENDPOINT=true`. It takes
`tenant_slug` directly, so it bypasses entry-code routing — to exercise the QR
path itself, send the code as the message (`#TESTME` for the demo tenant)
without a slug.
