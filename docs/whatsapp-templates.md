# WhatsApp message templates

Every message MediBook sends to a patient **outside a 24-hour conversation
window** must be a template approved by Meta. That covers every cron: reminders,
feedback, treatment nudges and recalls. Without them those jobs fall back to
plain text, which Meta rejects for anyone who has not messaged the clinic in the
last 24 hours — i.e. exactly the people each job is trying to reach. It also
covers the desk: receipts, sittings booked at reception, and the alerts sent to
the clinic's own staff.

Create these in **Meta Business Manager → WhatsApp Manager → Message templates**.

## Every template that must exist

Ten. Create them all — the product has a message for each and **none of them
reaches anybody without its template**, because every one is sent outside a
conversation the patient started.

| # | Name | Vars | Sent by | Buttons |
|---|---|---|---|---|
| 1 | `appointment_confirmed_v4` | 5 | booking completes | 2 |
| 2 | `appointment_reminder_24h_v3` | 4 | the day before | 3 |
| 3 | `appointment_feedback_request` | 3 | day after a completed visit | 3 |
| 4 | `appointment_missed_rebook` | 3 | day after a no-show | 1 |
| 5 | `treatment_sitting_reminder` | 5 | course unfinished, nothing booked | 1 |
| 6 | `patient_recall_checkup` | 2 | six-month check-up loop | 1 |
| 7 | `payment_receipt` | 6 | a payment is recorded | — |
| 8 | `treatment_sitting_booked` | 7 | the desk books the next sitting | 2 |
| 9 | `clinic_staff_alert` | 2 | alerts + Monday summary, **to staff** | — |
| 10 | `appointment_rescheduled_v1` | 7 | the desk moves an appointment (e.g. a doctor's leave) | 2 |

**1 carries a `_v4` suffix, 2 a `_v3` one, and 7, 8, 9 and 10 have never been
submitted.** Six of the ten, then, are names Meta has not approved yet — until
it does, those messages do not arrive at all.

A template cannot be renamed in WhatsApp Manager. **1 and 2 are therefore
created fresh under the new names**, and the previous `appointment_confirmed_v3`
and `appointment_reminder_24h` keep working right up until this code deploys, at
which point they are dead — nothing looks them up. Create and get the new names
approved BEFORE deploying, or every booking confirmation and every reminder
falls back to plain text in the gap, which Meta rejects for anyone outside the
24-hour window. Delete the superseded ones only once the new ones are live; a
deleted template cannot be recovered, and while they exist they are a working
rollback.

> **The 2-hour reminder and the 1-2h post-appointment follow-up are retired.**
> `appointment_reminder_2h_v3` (and the old `appointment_reminder_2h`) is no
> longer sent by any code path — `jobs/reminders.js` no longer has a 2-hour
> block at all, and the post-appointment follow-up cron that used to fire
> `appointment_feedback_request` early is gone too. Delete both from WhatsApp
> Manager whenever convenient; nothing looks them up any more, so there is no
> cutover to coordinate. A same-day booking now gets no appointment reminder at
> all — the 24-hour one is gated on a future date, and there is currently no
> substitute for same-day.

The other four:

- **9 is the urgent one.** It fails *100% of the time*, not occasionally. A
  clinic owner never messages the shared number — that is the point of the QR —
  so they are permanently outside the 24-hour window. Every booking alert and
  every Monday summary is currently rejected in silence.
- **7** fails whenever a payment is recorded more than 24 hours after the
  patient last wrote, which is most of them.
- **8** fails whenever the receptionist books a sitting for a patient who is not
  mid-conversation, which is most of them.
- **10** fails the same way, for the same reason — a doctor's leave is added by
  the desk, not by the patient asking, so they are very often not mid-conversation
  when their appointment moves.

3–6 were re-submitted on 2026-08-05 (clinic name added to 3, 4 and 5). If you
have not done that yet, do it in the same sitting as the `_v3` two.

> **Deploy the code and the approvals together.** An approved template invoked
> with the wrong number of parameters fails the send *entirely*, and the
> plain-text fallback is then rejected for anyone outside the window. A mismatch
> silences the message rather than degrading it.

## These are the messages patients see most

A patient meets the booking flow once. They get reminders, recalls and
confirmations for years, and those land in a busy inbox next to messages from
friends. Every template below therefore has the same four parts the in-session
messages use:

| Part | Limit | Notes |
|---|---|---|
| **Header** | 60 chars | Rendered above the body in bold. Static text — a variable here works but complicates approval for no gain. |
| **Body** | 1024 chars | `*bold*`, `_italic_` and emoji all work. |
| **Footer** | 60 chars | Small grey text. **No variables allowed.** Where the opt-out line goes. |
| **Buttons** | max 3 | Quick replies. Both fields are typed in the form: the **label** is what the patient sees, the **payload** is what MediBook routes on. The form prefills the payload from the label — overwrite it. |

**At most one emoji per message, in the header.** Bodies carry none. The bodies
used to open each fact with its own icon (🦷 a time, 📍 a place, 🪪 an ID) and it
read as an alert rather than as a message from a dentist — six glyphs is not
emphasis, it is noise, and it made every template look like every other one.
Bold does the emphasis instead: the WHEN and the WHO, which is what a patient
scrolls back to check.

## Filling in the form

The **Create template** form asks for these, in this order. Everything below is
per-template; the values for each of the ten are in the sections after.

| Form field | What to do |
|---|---|
| **Category** | `Utility` for all ten. Not Marketing — it costs more and is suppressed for anyone who opted out of marketing, which would silently kill the recall. |
| **Name** | Copy the heading exactly, e.g. `appointment_reminder_24h_v3`. Lowercase, digits and underscores only — the code looks it up by this string, `_v3` suffix included. |
| **Languages** | `English` → the code sends language code `en`. **Not** `English (US)`, which is `en_US` and will not match. |
| **Header** | Change the dropdown from `None` to **Text**, then paste the header line. Leave "Add variable" alone — every header is static. |
| **Body** | Paste the body. Where the text shows `{{1}}`, `{{2}}` …, type them exactly like that — the form accepts them typed. They must be numbered in order with no gaps. |
| **Samples** ⚠️ | The form will refuse to submit until you fill the **"Add sample content"** box that appears under the body — one example value per variable. Each template section below gives them. This is the step that trips everyone up. |
| **Footer** | Paste the footer line. Plain text only — variables are not allowed here. |
| **Buttons** | Change the dropdown to **Quick reply**, then add one button per row. Each row has TWO fields — **Label** and **Payload** — and the payload auto-fills with whatever you type as the label. Overwrite it with the Payload column from the section below. |

### About the button labels and payloads

A quick-reply row in the form has both a **Label** (what the patient sees) and a
**Payload** (what arrives in the webhook when they tap it). **The form prefills
the payload with the label as you type it, and that default is wrong for every
button here** — our labels carry an emoji and read like sentences ("📅 Book my
next sitting"), while the payload has to be the bare keyword the engine matches
(`Treatment`). The keyword tests are anchored (`/^reschedule$/i`), so a payload
left as "📅 Reschedule" matches nothing and the tap does nothing at all.

So, per button:

- **Type the label exactly as written** in each section, then **clear the
  payload field and type the Payload value** from the same table. Never leave
  the prefilled label there.
- Meta matches buttons by position, so the ORDER matters — button 1, 2, 3 must
  be in the order listed.
- You can reword a label freely. You cannot reword a payload.

MediBook also sends a payload override on every template that has buttons
(`quickReplyComponents` in `services/outbound.js`, index-aligned with the
buttons), which is what the patient's tap actually carries. **The two must
agree.** The override is the belt; the payload you type in the form is the
braces, and it is what a button gets if a sender is ever added without one.
Do not reorder or delete a button without changing the matching
`buttonPayloads` array in the code, or taps will trigger the wrong action.

### Roughly how long it takes

About 5 minutes per template. Approval is usually under an hour for Utility
templates, occasionally a day. Until each is approved the corresponding message
still goes out as plain text — see the fallback note at the end.

## Rules that will bite you

- **Variable order is fixed by the code.** `{{1}}`, `{{2}}` … must line up with
  the `parameters` array in the sender. The tables below are the source of
  truth; the file that sends each one is named so you can check.
- **Name and language must match exactly.** The code sends `en`
  (`sendTemplate`, `services/whatsapp.js:246`). Creating a template as `en_US`
  fails the send and silently falls back to plain text.
- **No two variables adjacent, and don't begin or end the body with one.**
  Every body below already satisfies this — keep it that way if you edit them.
- Category **UTILITY** for all of these. They follow a real appointment or
  treatment relationship. MARKETING costs more and is suppressed for users who
  opted out of marketing, which would silently kill the recall.
- **Footers cannot contain variables.** That is why the clinic name never
  appears there.

---

## 1. `appointment_confirmed_v4`

Sent the moment a booking completes.
`services/bot/bookingFlow.js` → `wa.sendBookingConfirmationTemplate`

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Booking ID | `MB81B39084DE` |
| `{{2}}` | Dentist name | `Kavitha Reddy` |
| `{{3}}` | Branch name | `Smile Dental - Banjara Hills` |
| `{{4}}` | Date | `Wed, 5 Aug 2026` |
| `{{5}}` | Time | `11:30` |

**Header** — `✅ You're booked`

**Body**
```
*{{4}}*
*{{5}}* with Dr. {{2}}

At {{3}}
Booking ID *{{1}}*

Please arrive 10 minutes early, and bring any previous X-rays or a list of the medicines you take.
```

> Matches `confirmationText` in `bookingFlow.js` line for line. It has to: that
> string is what patients get when the template is not approved, and a clinic
> should not have two different-looking confirmations in circulation.

**Sample values** (the form asks for one per variable, in order)
```
MB81B39084DE
Kavitha Reddy
Smile Dental - Banjara Hills
Wed, 5 Aug 2026
11:30
```

**Footer** — `We'll remind you the day before`

**Buttons**

| Label | Payload |
|---|---|
| 📅 Reschedule | `Reschedule` |
| Cancel appointment | `Cancel appointment` |

---

## 2. `appointment_reminder_24h_v3`

The day before. `jobs/reminders.js` (24-hour block)

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Dentist name | `Kavitha Reddy` |
| `{{2}}` | Date | `Wed, 5 Aug` |
| `{{3}}` | Time | `11:30` |
| `{{4}}` | Branch name | `Smile Dental - Banjara Hills` |

**Header** — `🔔 Your appointment is tomorrow`

**Body**
```
*{{2}} at {{3}}*
with Dr. {{1}}

At {{4}}

Arriving 10 minutes early helps us start on time. If you can't make it, tell us now and we'll offer the slot to someone who's waiting.
```

**Sample values**
```
Kavitha Reddy
Wed, 5 Aug
11:30
Smile Dental - Banjara Hills
```

**Footer** — `Reply STOP to turn off reminders`

**Buttons**

| Label | Payload | Why |
|---|---|---|
| ✅ Yes, I'll be there | `Yes` | Matches `CONFIRMATION_REPLY_RE`, closes the `reminder_confirmations` row |
| 📅 Reschedule | `Reschedule` | Enters the reschedule flow |
| Cancel appointment | `Cancel appointment` | Enters the cancel flow |

> The last body line does the work: it gives a reason to answer that isn't about
> the patient. "Let us know if you can't make it" is ignored; "we'll give your
> slot to someone who's waiting" is not.
>
> Do not shorten the payload `Cancel appointment` to `Cancel` — the engine reads
> a bare "cancel" as "abandon the current step".

---

## 3. `appointment_feedback_request`

The day after a completed visit. Sent by `sendFeedbackRequests` in
`jobs/reminders.js`.

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Patient first name | `Priya` |
| `{{2}}` | Dentist name | `Kavitha Reddy` |
| `{{3}}` | Clinic name | `Smile Dental Clinic` |

**Header** — `⭐ How did we do?`

**Body**
```
Hi {{1}}, we hope Dr. {{2}} at {{3}} took good care of you yesterday.

One tap tells us how it went — and helps us look after everyone a little better.
```

**Sample values**
```
Priya
Kavitha Reddy
Smile Dental Clinic
```

**Footer** — `Your answer goes only to the clinic`

**Buttons**

| Label | Payload |
|---|---|
| 😀 Great | `5` |
| 🙂 Okay | `3` |
| 😕 Not good | `1` |

> Meta caps quick replies at three, so the 1–5 scale collapses to three taps.
> Typing any number 1–5 still works — both land in `collect_feedback_rating`.

---

## 4. `appointment_missed_rebook`

Sent instead of the feedback request when a visit was marked no-show.
`jobs/reminders.js` → `sendFeedbackRequests`

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Patient first name | `Priya` |
| `{{2}}` | Dentist name | `Kavitha Reddy` |
| `{{3}}` | Clinic name | `Smile Dental Clinic` |

**Header** — `We missed you`

**Body**
```
Hi {{1}}, you weren't able to make your appointment with Dr. {{2}} at {{3}} — that's alright, it happens.

Whenever you're ready we'll find you another time. Sooner is better if you were in any discomfort.
```

**Sample values**
```
Priya
Kavitha Reddy
Smile Dental Clinic
```

> This template and `appointment_feedback_request` are chosen between at the
> same call site in `sendFeedbackRequests`, so their parameter lists must
> stay the same shape — `{{3}}` was added to both together.

**Footer** — `Reply STOP to turn off these messages`

**Buttons**

| Label | Payload |
|---|---|
| 📅 Book a new time | `Menu` |

> No guilt and no "you missed your appointment" — a patient who no-showed is
> often embarrassed, and a scolding message is the one they don't reply to.
> The discomfort line supplies the urgency instead.

---

## 5. `treatment_sitting_reminder`

"Your next sitting isn't booked yet." `jobs/treatmentNudges.js`

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Treatment title | `Root canal 36` |
| `{{2}}` | Next sitting number | `2` |
| `{{3}}` | Total sittings | `3` |
| `{{4}}` | Treating dentist | `Arjun Sharma` |
| `{{5}}` | Clinic name | `Smile Dental Clinic` |

**Header** — `🦷 About your treatment`

**Body**
```
Hi — your *{{1}}* at {{5}} isn't finished yet.

Sitting *{{2}}* of *{{3}}* with Dr. {{4}} still needs a date. Leaving a treatment part-done can undo the work already carried out, so let's get it in the diary.
```

**Sample values**
```
Root canal 36
2
3
Arjun Sharma
Smile Dental Clinic
```

**Footer** — `Reply STOP to turn off these messages`

**Buttons**

| Label | Payload |
|---|---|
| 📅 Book my next sitting | `Treatment` |

> `Treatment` is the keyword `TREATMENT_KEYWORD_RE` (botEngine.js:58) and
> `TREATMENT_REPLY_RE` (webhook.js:341) both match. Those two must stay
> identical — the webhook decides which clinic the reply belongs to, the engine
> acts on it.

---

## 6. `patient_recall_checkup`

The six-month check-up loop. `jobs/recalls.js`

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Patient first name | `Priya` |
| `{{2}}` | Clinic / branch name | `Smile Dental - Banjara Hills` |

**Header** — `🦷 Time for a check-up`

**Body**
```
Hi {{1}}, it's been a while since we saw you at {{2}}.

A check-up takes about twenty minutes and catches small problems while they're still small — and still cheap to fix. Shall we find you a time?
```

**Sample values**
```
Priya
Smile Dental - Banjara Hills
```

**Footer** — `Reply STOP to turn off check-up reminders`

**Buttons**

| Label | Payload |
|---|---|
| 📅 Book a check-up | `Menu` |

---

---

## 7. `payment_receipt`

Sent the moment a payment is recorded against a treatment.
`routes/treatmentPlans.js` → `POST /treatment-plans/:id/payments`

**Why it needs a template:** a payment is routinely recorded days after the
patient last messaged. Outside the 24-hour window a plain text send is rejected
and the patient gets nothing, while the clinic believes they were sent a receipt.

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Amount paid now | `₹4,000` |
| `{{2}}` | Method | `upi` |
| `{{3}}` | Treatment | `Crown 46` |
| `{{4}}` | Paid so far | `₹4,000 of ₹9,000` |
| `{{5}}` | Balance phrase | `₹5,000` |
| `{{6}}` | Clinic name | `Smile Dental Clinic` |

**Header** — `✅ Payment received`

**Body**
```
We have received {{1}} by {{2}} for *{{3}}*.

Paid so far: {{4}}
Balance: {{5}}

Thank you — {{6}}. Please keep this message for your records.
```

**Sample values**
```
₹4,000
upi
Crown 46
₹4,000 of ₹9,000
₹5,000
Smile Dental Clinic
```

**Footer** — `Not a tax invoice`

**Buttons** — none. There is nothing for the patient to do.

> `{{4}}` and `{{5}}` are composed in code, not assembled from separate
> variables, because their SHAPE changes: a course with no estimate has no
> balance to state, and a template cannot carry a conditional line. `{{5}}`
> arrives as `₹5,000`, `nothing further to pay` or
> `we will confirm the total with you`.
>
> This is deliberately **not** a tax invoice and the footer says so. MediBook
> does not issue those (see the GST note in `leads/outreach_email.txt`); this is
> the payment slip a front desk would hand over.

---

## 8. `treatment_sitting_booked`

The receptionist books the next sitting of a course from the dashboard.
`routes/treatmentPlans.js` → `POST /treatment-plans/:id/visits`

**Why it needs a template:** this is booked AT THE DESK, so the patient is very
often not mid-conversation. Same 24-hour problem as above.

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Treatment | `Root canal 36` |
| `{{2}}` | This visit number | `2` |
| `{{3}}` | Total visits | `3` |
| `{{4}}` | Date | `Wed, 12 Aug 2026` |
| `{{5}}` | Time | `11:30` |
| `{{6}}` | Dentist | `Kavitha Reddy` |
| `{{7}}` | Branch | `Smile Dental - Banjara Hills` |

**Header** — `✅ Your next visit is booked`

**Body**
```
Your *{{1}}* continues — visit {{2}} of {{3}}.

{{4}} at {{5}}
with Dr. {{6}} at {{7}}

Please arrive 10 minutes early.
```

**Sample values**
```
Root canal 36
2
3
Wed, 12 Aug 2026
11:30
Kavitha Reddy
Smile Dental - Banjara Hills
```

**Footer** — `Reply Menu to see all your appointments`

**Buttons**

| Label | Payload |
|---|---|
| 📅 Reschedule | `Reschedule` |
| Cancel appointment | `Cancel appointment` |

> `{{7}}` falls back to the literal string `the clinic` when a plan has no
> branch. Meta rejects the whole send on an EMPTY parameter, so no variable here
> is ever allowed to resolve to `''`.

---

## 9. `clinic_staff_alert`

Every alert to the clinic's own staff: new booking, cancellation, and the Monday
summary. `services/bot/utils.js` → `notifyAdminWhatsApp`

**Why it needs a template — read this one:** a clinic owner **never** messages
the shared number. That is the entire point of the QR entry: patients scan, the
owner uses the dashboard. So an owner is *permanently* outside the 24-hour
window, and the plain-text send this used to be failed **100% of the time** in
production. Every "new booking" alert and every Monday summary was silently
rejected while the log recorded a per-admin warning nobody reads.

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Clinic name | `Smile Dental Clinic` |
| `{{2}}` | The alert body, flattened | `📊 Last week · 26 appointments · 4 completed · ₹11,000 booked` |

**Header** — `🔔 Clinic update`

**Body**
```
Update for *{{1}}*:

{{2}}

Open the dashboard for the full detail.
```

**Sample values**
```
Smile Dental Clinic
📊 Last week · 26 appointments · 4 completed · 2 no-shows · ₹11,000 booked
```

**Footer** — `Staff notification`

**Buttons** — none. Staff act in the dashboard, not in WhatsApp.

> **One variable carries the whole body, which is unusual and deliberate.**
> These alerts are genuinely free-form — a booking, a cancellation, a weekly
> summary — and minting a template per alert type would mean a Meta re-approval
> every time the wording changed.
>
> Meta rejects newlines inside a parameter, so `notifyAdminWhatsApp` flattens
> the message to ` · ` separators and truncates at 900 characters. The alerts
> are short lists of facts rather than prose, so they survive it; the dashboard
> has the detail either way.
>
> This is the only template addressed to STAFF. It is still `Utility` — it
> follows a real event in the business's own account.

---

## 10. `appointment_rescheduled_v1`

The desk moves a confirmed appointment to a new slot — most commonly because a
doctor's leave was just added and collided with it, but the endpoint is generic.
`routes/appointments.js` → `PATCH /appointments/:id/reschedule`

**Why it needs a template:** the desk does this on ITS OWN schedule (reacting to
a leave, a holiday, a doctor going home sick), not in response to the patient
writing in. The patient is very often not mid-conversation, same 24-hour problem
as every other desk-initiated send.

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Old date | `Wed, 12 Aug 2026` |
| `{{2}}` | Old time | `11:30` |
| `{{3}}` | New date | `Thu, 13 Aug 2026` |
| `{{4}}` | New time | `10:00` |
| `{{5}}` | Dentist | `Kavitha Reddy` |
| `{{6}}` | Reason | `the dentist is on leave that day` |
| `{{7}}` | Branch | `Smile Dental - Banjara Hills` |

**Header** — `🔄 Your appointment was moved`

**Body**
```
Your visit on {{1}} at {{2}} could not go ahead — {{6}}.

We've moved it to *{{3}} at {{4}}* with Dr. {{5}} at {{7}}.
```

**Sample values**
```
Wed, 12 Aug 2026
11:30
Thu, 13 Aug 2026
10:00
Kavitha Reddy
the dentist is on leave that day
Smile Dental - Banjara Hills
```

**Footer** — `Reply Menu to see all your appointments`

**Buttons**

| Label | Payload |
|---|---|
| 📅 Reschedule | `Reschedule` |
| Cancel appointment | `Cancel appointment` |

> `{{6}}` and `{{7}}` fall back to the literal strings `the clinic needed to make
> a change` and `the clinic` respectively when no reason or branch is available —
> Meta rejects the whole send on an EMPTY parameter, so neither variable here is
> ever allowed to resolve to `''`.

## Payload reference

Every payload below is a keyword MediBook already understands from a typed
reply, so template buttons need no new engine code. These are the exact strings
to type into the form's **Payload** field — case is not significant (the engine
matches case-insensitively), but the wording and spacing are, and no payload may
carry an emoji or any leading/trailing space.

| Payload | What it does | Handled in |
|---|---|---|
| `Menu` | Opens the current clinic's main menu | `botEngine.js:221` |
| `Hi` | Full restart — clears the clinic and re-runs the search | `routes/webhook.js` |
| `Yes` | Confirms a 24-hour reminder | `handleReminderConfirmation` |
| `Reschedule` | Asks for a booking ID, then the reschedule flow | `botEngine.js:326` |
| `Cancel appointment` | Asks for a booking ID, then the cancel flow | `botEngine.js:337` |
| `Treatment` | Lists the patient's unbooked treatment sittings | `bot/treatmentFlow.js` |
| `1`–`5` | A feedback rating | `collect_feedback_rating` |
| `Start` | Re-subscribes an opted-out patient | `botEngine.js:201` |
| `Stop` | Opts the patient out of all messages | `botEngine.js:201` |

## Known limitation: `Menu` and the shared number

All clinics share one WhatsApp number, and inbound messages route to whichever
clinic the patient last selected (`global_bot_sessions`). `Menu` is a navigation
command, not an answer to a question, so it is NOT redirected back to the clinic
that sent the template.

For the patients who only ever deal with one clinic this is invisible. For a
patient who used clinic A and later searched for clinic B, tapping **Book a
check-up** on a recall from A opens **B's** menu. They can still book — at the
wrong clinic.

`treatment_sitting_reminder` does not have this problem: the treatment nudge
records a pending reply (`KINDS.TREATMENT`) and `resolveAskingTenant` sends the
`Treatment` payload back to the clinic that asked, after re-checking that clinic
still has an unbooked sitting.

Fixing it for the recall means the same three pieces: a `KINDS.RECALL` pending
reply written by `jobs/recalls.js`, a matching regex in `routes/webhook.js`, and
a keyword the engine acts on from a resting state. Worth doing before a clinic
has patients who use two practices on the number; not worth blocking launch on.

## Verifying a template once approved

`POST /api/webhook/test` runs the engine but does not send real WhatsApp
messages, so it cannot prove a template works. To check a live one:

1. Approve the template in WhatsApp Manager.
2. Trigger its cron (or wait for the schedule).
3. ```sql
   SELECT content, wa_message_id, status FROM tenant_<slug>.wa_messages
   WHERE direction='out' ORDER BY created_at DESC LIMIT 5;
   ```
   A template that sent has a `wa_message_id`. If the row shows the plain-text
   body instead, the template send failed and `sendPatientMessage` fell back.
