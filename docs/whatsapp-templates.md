# WhatsApp message templates

Every message MediBook sends to a patient **outside a 24-hour conversation
window** must be a template approved by Meta. That covers every cron: reminders,
feedback, treatment nudges and recalls. Without them those jobs fall back to
plain text, which Meta rejects for anyone who has not messaged the clinic in the
last 24 hours — i.e. exactly the people each job is trying to reach.

Create these in **Meta Business Manager → WhatsApp Manager → Message templates**.

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
| **Buttons** | max 3 | Quick replies. Label is what the patient sees; **payload** is what MediBook routes on. |

Emoji are used as *icons on facts* (📍 a place, 📅 a date) or as a single
leading glyph — never one per line for decoration. That restraint is what makes
a message read as designed rather than as an alert.

## Filling in the form

The **Create template** form asks for these, in this order. Everything below is
per-template; the values for each of the seven are in the sections after.

| Form field | What to do |
|---|---|
| **Category** | `Utility` for all seven. Not Marketing — it costs more and is suppressed for anyone who opted out of marketing, which would silently kill the recall. |
| **Name** | Copy the heading exactly, e.g. `appointment_reminder_24h`. Lowercase, digits and underscores only — the code looks it up by this string. |
| **Languages** | `English` → the code sends language code `en`. **Not** `English (US)`, which is `en_US` and will not match. |
| **Header** | Change the dropdown from `None` to **Text**, then paste the header line. Leave "Add variable" alone — all seven headers are static. |
| **Body** | Paste the body. Where the text shows `{{1}}`, `{{2}}` …, type them exactly like that — the form accepts them typed. They must be numbered in order with no gaps. |
| **Samples** ⚠️ | The form will refuse to submit until you fill the **"Add sample content"** box that appears under the body — one example value per variable. Each template section below gives them. This is the step that trips everyone up. |
| **Footer** | Paste the footer line. Plain text only — variables are not allowed here. |
| **Buttons** | Change the dropdown to **Quick reply**, then add one button per row and type the **Label**. |

### About the button labels

The form gives a quick-reply button **only a label** — there is no payload
field. The payload MediBook routes on is attached when the message is sent
(`quickReplyComponents` in `services/outbound.js`), so:

- **Type the label exactly as written** in each section. Meta matches buttons by
  position, so the ORDER matters — button 1, 2, 3 must be in the order listed.
- Do not reorder or delete a button without changing the matching
  `buttonPayloads` array in the code, or taps will trigger the wrong action.
- You can reword a label freely. You cannot reword a payload.

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

## 1. `appointment_confirmed`

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
🦷 *{{4}} at {{5}}*
with Dr. {{2}}

📍 {{3}}
🪪 Booking ID *{{1}}*

Please arrive 10 minutes early, and bring any previous X-rays or a list of the medicines you take.
```

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

## 2. `appointment_reminder_24h`

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
🦷 *{{2}} at {{3}}*
with Dr. {{1}}

📍 {{4}}

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

## 3. `appointment_reminder_2h`

A couple of hours before. `jobs/reminders.js` (2-hour block)

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Dentist name | `Kavitha Reddy` |
| `{{2}}` | Time | `11:30` |

**Header** — `⏰ Later today`

**Body**
```
Your appointment with Dr. {{1}} is at *{{2}}*.

See you shortly — we're ready for you.
```

**Sample values**
```
Kavitha Reddy
11:30
```

**Footer** — `Reply STOP to turn off reminders`

**Buttons** — none. Two hours out, a cancel button invites a cancellation the
clinic can no longer refill.

---

## 4. `appointment_feedback_request`

The day after a completed visit. Sent by BOTH `sendFeedbackRequests` and
`sendPostAppointmentFollowup` in `jobs/reminders.js`.

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Patient first name | `Priya` |
| `{{2}}` | Dentist name | `Kavitha Reddy` |

**Header** — `⭐ How did we do?`

**Body**
```
Hi {{1}}, we hope Dr. {{2}} took good care of you yesterday.

One tap tells us how it went — and helps us look after everyone a little better.
```

**Sample values**
```
Priya
Kavitha Reddy
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

## 5. `appointment_missed_rebook`

Sent instead of the feedback request when a visit was marked no-show.
`jobs/reminders.js` → `sendPostAppointmentFollowup`

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Patient first name | `Priya` |
| `{{2}}` | Dentist name | `Kavitha Reddy` |

**Header** — `We missed you`

**Body**
```
Hi {{1}}, you weren't able to make your appointment with Dr. {{2}} — that's alright, it happens.

Whenever you're ready we'll find you another time. Sooner is better if you were in any discomfort.
```

**Sample values**
```
Priya
Kavitha Reddy
```

**Footer** — `Reply STOP to turn off these messages`

**Buttons**

| Label | Payload |
|---|---|
| 📅 Book a new time | `Menu` |

> No guilt and no "you missed your appointment" — a patient who no-showed is
> often embarrassed, and a scolding message is the one they don't reply to.
> The discomfort line supplies the urgency instead.

---

## 6. `treatment_sitting_reminder`

"Your next sitting isn't booked yet." `jobs/treatmentNudges.js`

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | Treatment title | `Root canal 36` |
| `{{2}}` | Next sitting number | `2` |
| `{{3}}` | Total sittings | `3` |
| `{{4}}` | Treating dentist | `Arjun Sharma` |

**Header** — `🦷 About your treatment`

**Body**
```
Hi — your *{{1}}* isn't finished yet.

Sitting *{{2}}* of *{{3}}* with Dr. {{4}} still needs a date. Leaving a treatment part-done can undo the work already carried out, so let's get it in the diary.
```

**Sample values**
```
Root canal 36
2
3
Arjun Sharma
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

## 7. `patient_recall_checkup`

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

## Payload reference

Every payload below is a keyword MediBook already understands from a typed
reply, so template buttons need no new engine code.

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
