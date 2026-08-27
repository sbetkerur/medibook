# Self-serve clinic signup

A dental clinic can create its own MediBook account without a super admin
provisioning it: verify the owner's WhatsApp number with a one-time code, then
run for **14 days on a card-free trial**. A card is only needed to continue past
the trial. **A super admin still approves every clinic** before its patients can
reach it.

Everything here is **off** until `SELF_SIGNUP_ENABLED=true` *and* the setup
below is done. Until then `/signup` reports itself unavailable and the "Create an
account" link is hidden on the login page.

---

## What the operator has to set up (once)

### 1. Razorpay

Even though the trial takes no card, self-serve signup needs Razorpay configured
so a trial can *convert* — a clinic that can never pay would just get suspended
at day 14.

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

In **dev** no template is needed — delivery falls back to `sendText`, which works
for any number that has messaged the number, and the code is also in the server
log.

### 3. Flip the switch

```
SELF_SIGNUP_ENABLED=true
SIGNUP_TRIAL_DAYS=14          # optional, default 14
SIGNUP_DUNNING_GRACE_DAYS=7   # optional, default 7
```

---

## The flow

```
/signup  (public)
  1. POST /signup/start       details + password → WhatsApp OTP to the owner
  2. POST /signup/verify-otp  code checked → Razorpay customer created (best effort)
  3. POST /signup/confirm     tenant provisioned at status 'pending_review',
                              14-day trial started, owner auto-logged-in → /onboarding

super admin
     POST /superadmin/tenants/:id/approve   pending_review → active (patients can now reach it)

owner, before day 14
     Settings › Billing → "Add card" → Razorpay Checkout → subscription active

day 14 with no card  →  billing_dunning cron: active → past_due  (owner can still log in + pay)
+ SIGNUP_DUNNING_GRACE_DAYS →  past_due → suspended
payment recovers (webhook or refresh)  →  past_due → active
```

### Tenant `status` values

| status | can log in | patients can reach | meaning |
|---|---|---|---|
| `pending_payment` | no | no | signup mid-provision (schema build failed) — cron retries |
| `pending_review` | **yes** | no | paid/trialing, awaiting super-admin approval |
| `active` | yes | yes | normal |
| `past_due` | **yes** | no | trial lapsed / payment failed — add a card |
| `suspended` | no | no | kill switch, or grace elapsed |
| `inactive` | no | no | deactivated |

`middleware/auth.js` `DASHBOARD_ALLOWED_STATUSES` and `routes/auth.js`
`LOGIN_ALLOWED_STATUSES` are the source of truth for column 2. Outreach crons
filter `status='active'`, so `pending_review` / `past_due` clinics send nothing
unsolicited.

---

## Abuse controls

- **WhatsApp OTP** proves the owner controls a real number. Per-phone: 45s
  cooldown, 4 codes/hour, 5 wrong guesses kills a code (`services/otp.js`).
- **Super-admin approval** — the human gate. A clinic is invisible to patients
  until approved (`POST /superadmin/tenants/:id/approve`).
- **Staged send caps** (`services/sendCaps.js`) — a fresh tenant may send at most
  **100** clinic-initiated patient messages / 24h for its first 7 days, **300**
  for its first 30, then uncapped. The clock starts at `activated_at` (approval).
  Enforced in `services/outbound.js` `sendPatientMessage`; reminders /
  confirmations are never capped. Fails open.
- **Kill switch** — `POST /superadmin/tenants/:id/suspend {reason}` /
  `.../resume`. Takes hold within ~5s (tenant cache TTL); the bot stops
  attaching patients on the next message.

---

## Operating notes

- **Approval queue**: `GET /superadmin/tenants?status=pending_review`, or the
  "Pending review" section in the super-admin dashboard.
- **"Paid but no clinic"**: if `/signup/confirm` provisions the tenant row but
  the schema build fails, the tenant sits at `pending_payment` and the
  `billing_dunning` cron (06:15 IST) retries it every day. Check the logs for
  `provisioning retry still failing`.
- **`billing_events`** dedups Razorpay webhook deliveries on the
  `x-razorpay-event-id` header — safe to let Razorpay retry.
- **Refund / cancel**: cancel the subscription in the Razorpay dashboard; the
  webhook (or the cron) moves the clinic to `past_due`, then `suspended` after
  the grace window. There is no self-serve "delete my clinic".
- **Turning it off**: `SELF_SIGNUP_ENABLED=false` disables new signups
  immediately. Existing self-serve clinics keep working; their billing lifecycle
  still runs.
