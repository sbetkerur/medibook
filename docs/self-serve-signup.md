# Self-serve clinic signup

A dental clinic can apply for its own MediBook account: verify the owner's
WhatsApp number with a one-time code, choose a plan, and submit. **A super admin
approves every clinic**, and approval is also what actually builds it — the PG
schema, the owner's login, and the **14-day card-free trial** are all created at
approval, not at signup. A card is only needed to continue past the trial.

Until approval there is nothing to log into: the owner finishes signup on a
"we'll message you on WhatsApp" screen and gets a login link once approved.

**In production** everything here is **off** until `SELF_SIGNUP_ENABLED=true`
*and* the setup below is done — until then `/signup` reports itself unavailable
and the "Create an account" link is hidden on the login page. **Outside
production** `SELF_SIGNUP_ENABLED=true` alone opens signup; Razorpay and the
WhatsApp templates are optional and fall back (see notes inline below).

---

## What the operator has to set up (once)

### 1. Razorpay

Even though the trial takes no card, **production** self-serve signup needs
Razorpay configured so a trial can *convert* — a clinic that can never pay would
just get suspended at day 14. (Outside production this is skipped:
`selfSignupEnabled()` only checks `razorpay.isConfigured()` when
`NODE_ENV=production`.)

1. **API keys** — Razorpay Dashboard → Settings → API Keys. Set
   `RAZORPAY_KEY_ID` (`rzp_live_…` / `rzp_test_…`) and `RAZORPAY_KEY_SECRET`.
2. **Plans** — create **one recurring Plan per tier** (monthly), amount in
   paise:
   | Tier | Amount | Env var |
   |---|---|---|
   | Starter | `79900` (₹799) | `RAZORPAY_PLAN_STARTER` |
   | Professional | `179900` (₹1,799) | `RAZORPAY_PLAN_PROFESSIONAL` |
   Paste each plan id into the matching env var. They are also written to
   `plans.razorpay_plan_id` on every boot.
   > Professional is billed per **first branch** here. Multi-branch negotiated
   > pricing stays a manual super-admin job (`tenants.billing_monthly`) — a
   > self-serve signup always takes the list price.
3. **Webhook** — Dashboard → Settings → Webhooks → add
   `https://<backend-host>/api/webhook/razorpay`, subscribe to the
   `subscription.*` events (`activated`, `charged`, `pending`, `halted`,
   `cancelled`, `completed`, `paused`, `resumed`). Paste its secret into
   `RAZORPAY_WEBHOOK_SECRET`.
   Without the webhook the daily dunning cron is the only reconciliation
   (fine, just slower).

### 2. The OTP WhatsApp template

A clinic owner never messages the shared number, so they are permanently outside
Meta's 24-hour free-form window — the signup code can only arrive as a
**template**. Create one in WhatsApp Manager (see `docs/whatsapp-templates.md`
for where):

- **Category** AUTHENTICATION (or UTILITY).
- **Body**: one variable, e.g. `{{1}} is your MediBook verification code.`
- AUTHENTICATION templates get a copy-code button automatically — keep
  `SIGNUP_OTP_TEMPLATE_HAS_BUTTON=true`. For a plain UTILITY template with just
  the body variable, set it to `false`.

Set `SIGNUP_OTP_TEMPLATE` to the template name.

You also need a **second template** for the go-live message sent when a super
admin approves the clinic — since nothing is provisioned until approval, this is
the owner's only way to learn they can now log in:

- **Category** UTILITY.
- **Body**: two variables, e.g.
  `{{1}} is approved on MediBook. Sign in here: {{2}}` — `{{1}}` = clinic name,
  `{{2}}` = login URL.
- No button.

Set `SIGNUP_APPROVED_TEMPLATE` to that template name.

In **dev** neither template is needed — delivery falls back to `sendText`, which
works for any number that has messaged the number, and the OTP is also in the
server log.

### 3. Flip the switch

```
SELF_SIGNUP_ENABLED=true
SIGNUP_TRIAL_DAYS=30          # optional, default 30
SIGNUP_DUNNING_GRACE_DAYS=7   # optional, default 7
```

---

## The flow

```
/signup  (public)
  1. POST /signup/start       details + password → WhatsApp OTP to the owner
  2. POST /signup/verify-otp  code checked → Razorpay customer created (best effort)
  3. POST /signup/confirm     REGISTER ONLY: a `tenants` row at status
                              'pending_review' + an entry code, linked to the
                              pending_signups row. NO schema, NO login, NO trial.
                              Owner sees "we'll WhatsApp you" and stops here.

super admin
     POST /superadmin/tenants/:id/approve
         builds the PG schema + first admin user (from pending_signups),
         starts the 30-day card-free trial (trial_end = now + SIGNUP_TRIAL_DAYS),
         pending_review → active, stamps activated_at,
         WhatsApps the owner a login link (SIGNUP_APPROVED_TEMPLATE)

owner  (after the go-live message)
     /login with Clinic ID + chosen password → /onboarding

owner, before day 14
     Settings › Billing → "Add card" → Razorpay Checkout → subscription active

day 14 with no card  →  billing_dunning cron: active → past_due  (owner can still log in + pay)
+ SIGNUP_DUNNING_GRACE_DAYS →  past_due → suspended
payment recovers (webhook or refresh)  →  past_due → active
```

### Tenant `status` values

| status | can log in | patients can reach | meaning |
|---|---|---|---|
| `pending_payment` | no | no | legacy: old-flow signup whose inline schema build died — cron retries |
| `pending_review` | **no** | no | signup submitted, awaiting super-admin approval — no schema/user exists yet |
| `active` | yes | yes | normal |
| `past_due` | **yes** | no | trial lapsed / payment failed — add a card |
| `suspended` | no | no | kill switch, or grace elapsed |
| `inactive` | no | no | deactivated |

`middleware/auth.js` `DASHBOARD_ALLOWED_STATUSES` and `routes/auth.js`
`LOGIN_ALLOWED_STATUSES` (both now just `active` + `past_due`) are the source of
truth for column 2. Outreach crons filter `status='active'`, so a `past_due`
clinic sends nothing unsolicited.

---

## Abuse controls

- **WhatsApp OTP** proves the owner controls a real number. Per-phone: 45s
  cooldown, 4 codes/hour, 5 wrong guesses kills a code (`services/otp.js`).
- **Super-admin approval** — the human gate. A clinic is invisible to patients
  until approved (`POST /superadmin/tenants/:id/approve`).
- **Trial send cap** (`services/sendCaps.js`) — while a self-serve clinic is on
  the card-free trial it may send at most **50** (`SIGNUP_TRIAL_SEND_CAP`)
  clinic-initiated patient messages / rolling 24h. The cap is lifted the moment a
  live subscription is attached; a lapsed trial with no card stays capped, and a
  super-admin-provisioned clinic is never capped. Enforced in
  `services/outbound.js` `sendPatientMessage`; reminders / confirmations are
  never capped. Fails open.
- **Kill switch** — `POST /superadmin/tenants/:id/suspend {reason}` /
  `.../resume`. Takes hold within ~5s (tenant cache TTL); the bot stops
  attaching patients on the next message.

---

## Operating notes

- **Approval queue**: `GET /superadmin/tenants?status=pending_review`, or the
  "Pending review" section in the super-admin dashboard. Approving is what
  builds the clinic — expect the approve call to take a beat while the schema
  migrations run.
- **Approve failed the schema build**: the approve route reports a 500 and
  leaves the tenant at `pending_review` (nothing half-built — `CREATE SCHEMA IF
  NOT EXISTS` + `INSERT ... ON CONFLICT DO NOTHING`). Retry the approve; check
  the logs for `approve: schema build failed`.
- **Owner didn't get the go-live message**: the clinic is still `active` and
  fine — the WhatsApp send is best-effort. Look for `approve: owner notify
  failed`, and hand the owner the login URL + Clinic ID directly. In prod this
  usually means `SIGNUP_APPROVED_TEMPLATE` is missing or unapproved.
- **Legacy `pending_payment`**: only old-flow signups reach this. The
  `billing_dunning` cron (06:15 IST) retries the build daily; look for
  `provisioning retry still failing`.
- **`billing_events`** dedups Razorpay webhook deliveries on the
  `x-razorpay-event-id` header — safe to let Razorpay retry.
- **Turning it off**: `SELF_SIGNUP_ENABLED=false` disables new signups
  immediately. Existing self-serve clinics keep working; their billing lifecycle
  still runs.

---

## Self-serve billing management

Everything below is tenant-facing (Settings → Billing) and needs no operator
action.

- **Cancel / undo**: `POST /api/admin/billing/cancel {reason}` flags
  `cancel_at_period_end` — it does **not** call Razorpay. `billing_dunning`
  issues the real Razorpay cancel once `current_period_end` passes, so
  `POST /api/admin/billing/cancel/undo` before then is a genuine undo. The
  dashboard shows an amber "subscription ends on …" bar in the interim.
- **Plan change**: `POST /api/admin/billing/change-plan {plan}`. Upgrade is
  immediate (proration on); downgrade is scheduled for the next cycle
  (`tenant_billing.pending_plan_id` + `plan_change_at`, applied by the
  `subscription.charged` webhook). A downgrade the current dentist/branch count
  won't fit is refused (`code: DOWNGRADE_BLOCKED`).
- **Per-branch billing**: Professional = plan amount × active branches.
  `services/billing.js` `syncSubscriptionQuantity` runs on branch add/remove and
  pushes `quantity` to Razorpay at cycle end; `billing_dunning` reconciles it
  daily and keeps `tenants.billing_monthly` in step for MRR.
- **GST tax invoices**: one `billing_invoices` row per `subscription.charged`
  (idempotent on `razorpay_payment_id`). The Razorpay plan amount is
  **GST-inclusive**; `splitGst` back-computes the taxable value and the
  CGST+SGST (buyer in `SELLER_STATE_CODE`) or IGST (interstate) split.
  Invoice number: `<INVOICE_NUMBER_PREFIX>/<FY>/<seq>` from
  `billing_invoice_seq`. `GET /api/admin/billing/invoices[/:id]` (PDF).
  `GET/PUT /api/admin/billing/profile` captures the buyer GSTIN / place of
  supply; with none, the invoice is raised B2C (no buyer GSTIN line).
  Set `SELLER_LEGAL_NAME` / `SELLER_GSTIN` / `SELLER_STATE_CODE` /
  `SELLER_ADDRESS` for the seller block.

## Rejecting and deleting

- **Reject a signup**: `POST /api/superadmin/tenants/:id/reject {reason}` — only
  for `pending_review` (no schema exists yet). Deletes the `tenants` row, frees
  the slug, WhatsApps the owner. Use it for spam / duplicates instead of leaving
  the row in the queue.
- **Notify on new signups**: set `SIGNUP_REVIEW_NOTIFY_PHONE` (comma-separated
  WhatsApp numbers) so the queue pings an operator rather than waiting to be
  noticed.
- **Tenant "delete my clinic"**: `POST /api/admin/billing`… → Settings → Billing
  → *Close this clinic*. Requires the admin's password + typing `DELETE`. Sets
  `deletion_scheduled_for = now + ACCOUNT_DELETION_GRACE_DAYS` (default 14);
  nothing is scrubbed during the window and `POST
  /api/admin/account/deletion/cancel` reverses it. `jobs/accountDeletion.js`
  (03:30 IST) then `DROP SCHEMA … CASCADE` + deletes the row — recoverable only
  from the ≤30-day encrypted backups. `billing_invoices` rows survive
  (`tenant_id` → NULL).

## Status page

`GET /api/status` (public, no auth, no per-tenant data) — DB reachability, cron
freshness, webhook backlog, shared-number circuit-breaker state. Rendered at
`/status` on the frontend.
