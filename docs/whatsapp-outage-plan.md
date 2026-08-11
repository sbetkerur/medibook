# If the WhatsApp number goes down

WhatsApp is the only channel MediBook has. Email (Resend) and SMS (Twilio) were
removed deliberately, and every clinic shares one Meta phone number. That buys
the thing clinics actually wanted — a patient scans a QR and reaches their own
dentist, with no directory and no competitors — at the cost of a single point of
failure that takes **every clinic down at once**.

This document is the answer to the question a clinic will ask before signing:
*"what happens the day Meta restricts that number?"* It is written to be shown to
them.

## What can actually happen

| Failure | What patients see | Typical cause |
|---|---|---|
| **Quality rating drops to Red** | Messaging limits fall; template sends start failing | Too many blocks/reports relative to sends |
| **Template paused** | That one template stops; others keep working | A specific template earns repeated negative feedback |
| **Number restricted** | Nothing sends; inbound still arrives | Policy violation, or sustained Red quality |
| **WABA disabled** | Total outage, inbound and outbound | Severe or repeated policy violation |
| **Meta platform outage** | Total outage, ours or theirs | Not our doing; hours, not days |

The realistic one is the first three, and they are all **earned gradually** —
which means they are visible before they bite.

## Watch these, weekly

- **Quality rating** — WhatsApp Manager → Phone numbers. Green is fine. Yellow
  is a warning that patients are blocking or reporting messages. Never let it
  sit at Yellow.
- **Messaging limit tier** — if it drops, the cause is upstream in quality.
- **Template status** — a paused template is a silent failure: the code falls
  back to plain text, which Meta then rejects for anyone outside the 24-hour
  window. See `docs/whatsapp-templates.md`.
- **`failed_webhooks` depth and the bot dead-letter queue** — a rise here means
  inbound processing, not Meta.

## What keeps the rating green

Most of this is already enforced in code, and it is worth knowing why:

- **Every clinic-initiated message is a template**, and templates are Utility,
  not Marketing (`sendPatientMessage`). Marketing sends to someone who did not
  ask are what earns blocks.
- **Opt-out is honoured before anything sends** — `isOptedOut` is checked at the
  top of the engine and in every cron.
- **Nudges are throttled** — treatment nudges never fire within 7 days, never
  more than 3 times, never when a sitting is already booked
  (`jobs/treatmentNudges.js`). Recalls close themselves if the patient has
  already booked (`jobs/recalls.js`).
- **Every message names the clinic.** A patient who cannot tell who is messaging
  them reports it as spam. This is the single biggest driver of blocks on a
  shared number, and it is why the clinic name is in the body of the QR welcome
  and in every cron template.

**One clinic's behaviour damages every other clinic on the number.** That is the
uncomfortable consequence of sharing, and it is the argument for keeping the
sending rules in the platform rather than letting clinics compose their own
broadcasts.

## If it happens

1. **Confirm it is Meta, not us.** `GET /health` covers the API, DB and Redis. If
   those are green and sends are failing, check WhatsApp Manager.
2. **Tell the clinics, by phone.** They have patients in the waiting room and
   will find out from them otherwise. `notify_phone` is no use — it is WhatsApp.
   Keep a phone list outside the system; `leads/` and the clinics CSV from
   `npm run qr:export` both carry numbers.
3. **The desk keeps working.** The dashboard, walk-in booking, the calendar and
   the day list are all unaffected — nothing there touches Meta. Only patient
   messaging stops. Clinics should be told this explicitly, because their
   assumption will be that everything is down.
4. **Inbound may still arrive.** A restricted number often still receives. Those
   messages queue and the bot answers when sending resumes; nothing is lost.
5. **Reminders self-heal.** `reminder_24h_sent` is only set after a successful
   send, so the hourly cron retries. A multi-day outage means some reminders
   are simply skipped — it does not mean a stuck queue.

## Getting a clinic's data out

A clinic must never need us to leave, and must never lose its record because our
channel is down. All exports are `adminOnly` and available to the clinic itself:

```
GET /api/admin/analytics/export?type=patients
GET /api/admin/analytics/export?type=appointments&days=all
GET /api/admin/analytics/export?type=treatments
```

`days=all` lifts the 365-day window; all three are capped at 50,000 rows. Add
`&format=json` for JSON. Nightly database backups are separate
(`jobs/backupManager.js`, `BACKUP_DIR`).

## The real fix, when it is worth it

Per-clinic WhatsApp numbers. `services/whatsapp.js` already threads optional
`accessToken` / `phoneNumberId` through every sender, so the outbound half is
done; the missing half is routing inbound by the receiving `phone_number_id`.
That converts a platform-wide outage into a single-clinic one, and removes the
"one clinic's spam complaints hurt everyone" problem entirely.

It is not free — each clinic needs its own Meta business verification — which is
why the shared number exists. Treat it as the upgrade path, not the default.
