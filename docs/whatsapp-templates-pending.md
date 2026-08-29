# WhatsApp templates still to be created

Action list, not a reference doc — the full spec, rules and rationale for
every template live in `docs/whatsapp-templates.md`. This file exists so
whoever has WhatsApp Manager access can create these four without reading the
whole reference doc first. As of 2026-08-29, `docs/whatsapp-templates.md`
records these as **never submitted**. Re-check WhatsApp Manager before acting
on this list — if they've since been created, delete this file.

All four: **Category = Utility**, **Language = English** (sends as `en` —
`English (US)` is `en_US` and will not match). Create each, fill the sample
values, submit, and cross it off.

## Why this matters — read #3 first

Every one of these currently means the message is **silently rejected** and
falls back to a plain-text send, which Meta refuses for anyone outside the
24-hour window (i.e. almost every recipient these four are for). Nothing
surfaces this failure anywhere a human looks — the log gets a per-attempt
warning, the code path otherwise completes normally, and the clinic believes
the message went out.

`clinic_staff_alert` is the one to prioritize: a clinic owner never messages
the shared number (the QR is for patients), so they are **permanently**
outside the window — this one fails **100% of the time**, not occasionally.
Every new-booking alert, cancellation alert and Monday revenue summary is
currently going nowhere.

---

## 1. `payment_receipt`

Sent when a payment is recorded against a treatment course.
(`routes/treatmentPlans.js` → `POST /treatment-plans/:id/payments`)

- **Header:** `✅ Payment received`
- **Body:**
  ```
  We have received {{1}} by {{2}} for *{{3}}*.

  Paid so far: {{4}}
  Balance: {{5}}

  Thank you — {{6}}. Please keep this message for your records.
  ```
- **Sample values:** `₹4,000` / `upi` / `Crown 46` / `₹4,000 of ₹9,000` / `₹5,000` / `Smile Dental Clinic`
- **Footer:** `Not a tax invoice`
- **Buttons:** none

## 2. `treatment_sitting_booked`

Sent when the desk books the next sitting of a course.
(`routes/treatmentPlans.js` → `POST /treatment-plans/:id/visits`)

- **Header:** `✅ Your next visit is booked`
- **Body:**
  ```
  Your *{{1}}* continues — visit {{2}} of {{3}}.

  {{4}} at {{5}}
  with Dr. {{6}} at {{7}}

  Please arrive 10 minutes early.
  ```
- **Sample values:** `Root canal 36` / `2` / `3` / `Wed, 12 Aug 2026` / `11:30` / `Kavitha Reddy` / `Smile Dental - Banjara Hills`
- **Footer:** `Reply Menu to see all your appointments`
- **Buttons:** `📅 Reschedule` → payload `Reschedule` · `Cancel appointment` → payload `Cancel appointment`

## 3. `clinic_staff_alert` ⚠️ prioritize this one

Every alert to the clinic's own staff — new booking, cancellation, the Monday
summary. (`services/bot/utils.js` → `notifyAdminWhatsApp`)

- **Header:** `🔔 Clinic update`
- **Body:**
  ```
  Update for *{{1}}*:

  {{2}}

  Open the dashboard for the full detail.
  ```
- **Sample values:** `Smile Dental Clinic` / `📊 Last week · 26 appointments · 4 completed · 2 no-shows · ₹11,000 booked`
- **Footer:** `Staff notification`
- **Buttons:** none

## 4. `appointment_rescheduled_v1`

Sent when the desk moves a confirmed appointment (most often a doctor's leave
colliding with it). (`routes/appointments.js` → `PATCH /appointments/:id/reschedule`)

- **Header:** `🔄 Your appointment was moved`
- **Body:**
  ```
  Your visit on {{1}} at {{2}} could not go ahead — {{6}}.

  We've moved it to *{{3}} at {{4}}* with Dr. {{5}} at {{7}}.
  ```
- **Sample values:** `Wed, 12 Aug 2026` / `11:30` / `Thu, 13 Aug 2026` / `10:00` / `Kavitha Reddy` / `the dentist is on leave that day` / `Smile Dental - Banjara Hills`
- **Footer:** `Reply Menu to see all your appointments`
- **Buttons:** `📅 Reschedule` → payload `Reschedule` · `Cancel appointment` → payload `Cancel appointment`

---

Once all four are approved, update `docs/whatsapp-templates.md`'s intro
paragraph (currently: *"7, 8, 9 and 10 have never been submitted"*) and delete
this file.
