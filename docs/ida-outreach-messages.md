# IDA cold outreach — text only

One-shot text to dentists in the IDA directory (SMS/DLT or the IDA channel).
**Plain text only — no links, no attachments, no images.** The website address
is given as plain text for the dentist to open themselves.

The message does not pitch or explain MediBook. Its only job is to make the
dentist *curious enough to look*.

## Honesty rules for this campaign

- **No invented people or anecdotes.** No "a dentist in {city} showed me…", no
  "I didn't believe it till I tried it" unless it literally happened.
- **No social proof yet.** There is no base of live clinics to cite, so nothing
  may say "other clinics already use this", "a few {state} practices run on it",
  etc. Add that only when it is true and you can name numbers.
- **No unsourced statistics.** Don't assert "30–40% of treatments aren't
  finished" as fact. Pose it as a question the dentist answers for themselves.
- **What you CAN say, because it's demonstrable:** the product exists and works
  (the demo proves it), what it does (the features are real), it's built for
  Indian dental practices, there's a free trial with no card, and they can test
  the whole thing in 30 seconds themselves.
- `{sender}` should be someone who can honestly write "I built" / "I work on"
  this. If not, drop that phrasing.

## Why the opening words matter

A dentist sees only the first ~6 words in the notification preview. Each variant
is built so those words already create the pull:

- A — "what happens when a patient wants to book at 9pm…" → a real gap in their day
- B — "how many patients didn't show up last week?" → a number about their own clinic
- C — "your clinic probably has a WhatsApp number already…" → a reframe of what they own
- D — "of the root canals and implants you advised last month…" → follow-through they can't quantify

All four send the dentist to `{website}`, where the embedded chat widget lets
them try the actual WhatsApp bot and the dashboard demo sits alongside it.

## Merge fields — fill before sending

- `{surname}` — "Dr. Rao". Personalising line 1 is what stops it reading as a blast.
- `{state}` / `{city}` — the recipient's own state or nearest metro.
- `{sender}` — your real name (see honesty rules above).
- `{website}` — plain text, no `https://`, no path. Use **demo.pragatisolutions.com**
  (live). Switch to `try.pragatisolutions.com` once its DNS is up. Keep it short —
  they type it by hand. This is the ONLY destination in the message.

### Why no WhatsApp number in the cold message

- The shared production number does not route a bare "Hi" to the demo — an
  inbound with no entry code hits the "scan a QR" dead end. Reaching the demo
  clinic needs `#TRYMED`, which is friction and reads like a spam keyword.
- A cold blast pointing thousands of strangers at that number invites
  spam-reports/blocks, which degrade its delivery quality for **every** live
  clinic sharing it.
- The number is a conversion dead end; the website carries the trial funnel and
  both halves of the product. The site's embedded chat widget already runs the
  real bot engine, so they lose nothing by trying it there.
- Give the real number (or a `wa.me/…?text=%23TRYMED` deep link / their own QR)
  only in the **warm 1:1 follow-up**, once a dentist has replied or signed up.

---

## Variant A — the after-hours gap  *(default)*

> Dr. {surname}, what happens when a patient wants to book at your clinic at 9pm,
> after you've closed? I've built a system that handles it - patients book by
> chatting on WhatsApp, no app, no call to the front desk. You can try the bot
> yourself in a minute: {website}. {sender}. Reply STOP to opt out.

Why it works: a specific, real moment they recognise, and the proof is them
testing it in 30 seconds — no claim to take on trust. The site's chat widget is
the live bot, so "try the bot yourself" is literally true.

---

## Variant B — a number they can't answer

> Dr. {surname}, quick question: how many patients didn't show up at your clinic
> last week? Most clinics don't track it. This is a WhatsApp booking system that
> sends 24-hour reminders with one-tap confirm, so the desk knows before a chair
> sits empty. See it: {website}. {sender}. Reply STOP to opt out.

Why it works: the question is about *their* practice and has no ready answer, so
the loop stays open until they look. The reminder-and-confirm behaviour is a
real feature, stated plainly, not dressed up.

---

## Variant C — your WhatsApp number is sitting idle

> Dr. {surname}, your clinic probably has a WhatsApp number already. It could be
> taking bookings, sending reminders, and messaging you your day's schedule each
> morning - instead of just sitting there. See it working: {website}. {sender}.
> Reply STOP to opt out.

Why it works: reframes something they already own as wasted - no new thing to
buy in the framing, so the guard stays down. Every capability named is real
(booking, reminders, the per-dentist morning schedule).

---

## Variant D — the treatments that never got finished  *(revenue angle)*

> Dr. {surname}, of the root canals and implants you advised last month, how many
> patients came back to finish? More slip away than most clinics notice. This
> system nudges them on WhatsApp and lets them book the next sitting themselves.
> Have a look: {website}. {sender}. Reply STOP to opt out.

Why it works: names a real, expensive gap and makes the dentist supply the
number themselves - no fabricated statistic. The nudge-and-self-book mechanism
is a real feature.

---

## After they look

- `{website}` opens the read-only live demo (chat widget = the real bot, plus
  the dashboard demo) and the "Start free trial, no card" path — the whole
  self-serve journey runs from there, no call needed.
- If a dentist **replies to the text**, treat it as a warm lead: reply within
  minutes with the same address and one line. This is where you can also hand
  over the real WhatsApp number or a `wa.me/…?text=%23TRYMED` deep link — a
  warm, opted-in context where a spam-report is near-zero. One follow-up after
  2 days, then stop.

## Sending notes

- **Keep it ASCII.** These variants use straight quotes and `-`, no em dashes or
  arrows, so they encode as GSM-7: ~250-280 characters = **2 SMS segments**.
  Pasting a curly apostrophe or an arrow flips the message to Unicode
  (70 chars/segment) and roughly doubles the cost.
- **Compliance:** DLT-registered template, `STOP` opt-out in every message, send
  11:00-18:00 IST, throttle to a volume you can support.
- **Do not send this over WhatsApp** to numbers that haven't opted in — the
  *sending* number gets banned. Inbound "Hi" to the demo bot is fine; that's the
  product.
- **Split-test:** send A / B / C to three equal random slices of the first
  ~1,500. Measure site visits + bot "Hi"s + signups per slice. Send the winner
  (and D, to owner-heavy segments) to the rest.
