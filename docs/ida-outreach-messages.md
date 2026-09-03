# IDA cold outreach — text only

One-shot text to dentists in the IDA directory (SMS/DLT or the IDA channel).
**Plain text only — no links, no attachments, no images.** Both website
addresses are given as plain text for the dentist to open themselves.

**Body-only channel — there is no subject line and no sender field.** The
`Subject:` under each variant below is an internal label for this doc, never
sent. The dentist sees only the message body, and the first ~6 words of it are
the entire "preview" (see *Why the opening words matter*) — so nothing that
would have gone in a subject can be assumed read. Each variant's body already
stands on its own without one.

The message does not pitch or explain MediBook. Its only job is to make the
dentist *curious enough to look*.

## The two addresses, and why both are in the message

Every variant carries the same two, in the same order:

- **`pragatisolutions.com`** — "See it." The marketing site: what the product
  does, how it works, pricing, the MediBook FAQ, and a *Request access* button.
  This is the page a dentist reads to decide it's real and worth a look.
- **`demo.pragatisolutions.com`** — "Try it." The live, read-only demo: click
  *Try the demo* to land inside a working clinic dashboard (seeded with a real
  practice's data), and use the actual WhatsApp booking bot in the browser. No
  login, no card.

They do different jobs — one explains, one proves — so the message labels each
(`See it:` / `Try it:`) and the dentist chooses. A dentist who only opens one
still lands somewhere useful.

> `try.pragatisolutions.com` is a working alias of `demo.pragatisolutions.com`
> (same page). If you'd rather send that word, swap it in every variant — but
> pick one and keep it consistent across the whole campaign so the split-test
> stays clean.

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
  Indian dental practices, the trial takes no card, and they can test the whole
  thing themselves in under a minute.
- `{sender}` should be someone who can honestly write "I built" / "I work on"
  this. If not, drop that phrasing.

## Why the opening words matter

A dentist sees only the first ~6 words in the notification preview. Each variant
is built so those words already create the pull:

- A — "what happens when a patient wants to book at 9pm…" → a real gap in their day
- B — "how many patients didn't show up last week?" → a number about their own clinic
- C — "your clinic probably has a WhatsApp number already…" → a reframe of what they own
- D — "of the root canals and implants you advised last month…" → follow-through they can't quantify

All four end with the same two plain-text addresses: `pragatisolutions.com` to
read, `demo.pragatisolutions.com` to use.

## Merge fields — fill before sending

- `{surname}` — "Dr. Rao". Personalising line 1 is what stops it reading as a
  blast. This is the ONLY per-recipient field the copy uses.
- `{sender}` — your real name (see honesty rules above).
- The two URLs are **fixed in the copy**, not merge fields — don't parametrise
  them. `pragatisolutions.com` and `demo.pragatisolutions.com`, no `https://`,
  no path, in that order. They type them by hand, so every extra character is
  friction and cost.

`{state}` / `{city}` are **not** used in the current variants — the honesty
rules rule out faked localisation and the copy has no room for it. Personalise
on the surname alone.

### Why no WhatsApp number in the cold message

- The shared production number does not route a bare "Hi" to the demo — an
  inbound with no entry code hits the "scan a QR" dead end. Reaching the demo
  clinic needs `#TRYMED`, which is friction and reads like a spam keyword.
- A cold blast pointing thousands of strangers at that number invites
  spam-reports/blocks, which degrade its delivery quality for **every** live
  clinic sharing it.
- The number is a conversion dead end; `demo.pragatisolutions.com` carries the
  same bot engine in the browser plus the dashboard, so they lose nothing by
  trying it there.
- Give the real number (or a `wa.me/…?text=%23TRYMED` deep link / their own QR)
  only in the **warm 1:1 follow-up**, once a dentist has replied or signed up.

---

## Variant A — the after-hours gap  *(default)*

**Subject (internal label — not sent):** After-hours booking gap

> Dr. {surname}, what happens when a patient wants to book at your clinic at 9pm,
> after you close? Right now they wait till morning, call around, or forget. I
> built a system for it: patients book by chatting on WhatsApp, day or night - no
> app, no call to the desk, and they get an automatic reminder before every
> visit. Plans start at Rs799/month, no setup fee, no per-booking charge, and the
> first 14 days are free with no card needed. See it working in under a minute.
> See it: pragatisolutions.com. Try it: demo.pragatisolutions.com. {sender}.
> Reply STOP to opt out.

Why it works: a specific, real moment they recognise, and the proof is them
testing it in under a minute — no claim to take on trust. `demo.pragatisolutions.com`
runs the live bot, so "try it" is literally true. The pricing and no-setup-fee
line are real published terms (pragatisolutions.com), not a claim — a dentist
who checks finds it holds up.

---

## Variant B — a number they can't answer

**Subject (internal label — not sent):** Missed appointments last week

> Dr. {surname}, how many patients didn't show up at your clinic last week? Most
> clinics don't track it, so it's easy to miss how much chair time actually sits
> empty and how much that costs in lost fees. This WhatsApp booking system sends
> automatic 24-hour reminders with one-tap confirm, flags who hasn't replied so
> the desk can follow up before the slot goes to waste, and tracks the day's
> collections so nothing is guessed at. Plans start at Rs799/month with a 14-day
> free trial, no card needed. See it: pragatisolutions.com. Try it:
> demo.pragatisolutions.com. {sender}. Reply STOP to opt out.

Why it works: the question is about *their* practice and has no ready answer, so
the loop stays open until they look. The reminder-and-confirm and day-close
tracking are real features, stated plainly, and turn a vague worry ("we lose
patients") into two concrete things the product actually does about it.
**Longest of the four and closest to the 5th-segment boundary** — see sending
notes before a bulk send.

---

## Variant C — your WhatsApp number is sitting idle

**Subject (internal label — not sent):** Your WhatsApp number is sitting idle

> Dr. {surname}, your clinic probably has a WhatsApp number already. Right now it
> likely just sits there between calls. On Meta's official WhatsApp Business
> platform, it could instead be taking bookings any time of day, sending
> reminders, texting you each morning's schedule, and answering basic questions
> like your address and hours - instead of your front desk repeating them all
> day, all for Rs799/month with a free 14-day trial and no card needed. See it:
> pragatisolutions.com. Try it: demo.pragatisolutions.com. {sender}. Reply STOP
> to opt out.

Why it works: reframes something they already own as wasted — no new thing to
buy in the framing, so the guard stays down. Every capability named is real
(booking, reminders, the per-dentist morning schedule, address & hours), and
naming Meta's official platform plus the price answers the "is this legitimate,
what does it cost" question before it's even asked.

---

## Variant D — the treatments that never got finished  *(revenue angle)*

**Subject (internal label — not sent):** Treatments advised but never finished

> Dr. {surname}, of the root canals and implants you advised last month, how many
> patients came back to finish? More slip away than most notice, especially
> multi-visit cases. This system tracks each course as one plan, nudges the
> patient on WhatsApp when the next sitting is due, and lets them book it
> themselves - no phone tag needed from your desk, and no separate app for them
> to install. Free for 14 days, no card, from Rs799/month after. See it:
> pragatisolutions.com. Try it: demo.pragatisolutions.com. {sender}. Reply STOP
> to opt out.

Why it works: names a real, expensive gap and makes the dentist supply the
number themselves — no fabricated statistic. Tracking the course "as one plan"
and the nudge-and-self-book mechanism are real features, and naming the price
turns curiosity into something they can act on immediately. **Shortest of the
four** — most headroom before the next segment boundary; see sending notes.

---

## After they look

- **`pragatisolutions.com`** — what it does, how it works, the MediBook FAQ,
  pricing, and a *Request access* button (opens an email to
  `contactus@pragatisolutions.com`) plus the contact form. No call needed to
  start a conversation.
- **`demo.pragatisolutions.com`** — *Try the demo* drops them into a read-only
  clinic dashboard with real-looking data, and the WhatsApp bot widget runs the
  actual engine. This is the "oh, it's real" moment.
- If a dentist **replies to the text**, treat it as a warm lead: reply within
  minutes with the same two addresses and one line. This is where you can also
  hand over the real WhatsApp number or a `wa.me/…?text=%23TRYMED` deep link — a
  warm, opted-in context where a spam-report is near-zero. One follow-up after
  2 days, then stop.

## Sending notes

- **Keep it ASCII.** These variants use straight quotes and `-`, no em dashes or
  arrows, so they encode as GSM-7. The bodies were expanded again in this pass
  to carry real pricing/product data (not just more words) and, with both URLs,
  now run ~535–595 characters (measuring the merge tokens `{surname}`/`{sender}`
  at their literal length, same convention as before) = **4 SMS segments** each
  (153 chars/segment when concatenated, up to 612 total) — up from 2 segments
  before this pass. Variant D is shortest (~540 chars, most headroom) and
  Variant B is longest (~595 chars, closest to the 612-char/5th-segment
  boundary) — a long `{surname}` or `{sender}` merge value can tip B past it;
  check your final, merged text in the DLT console before the bulk send. Each
  extra segment is still cheap (~₹0.10–0.15 more per recipient); losing GSM-7 is
  not — a single curly apostrophe or arrow flips the whole message to Unicode
  (70 chars/segment) and roughly doubles the segment count for the same text.
  This also means each variant needs its own DLT template re-registered before
  it can be sent — the previously-registered 2-segment templates don't cover
  this longer text, and template approval isn't instant.
- **Compliance:** DLT-registered template, `STOP` opt-out in every message, send
  11:00–18:00 IST, throttle to a volume you can support.
- **Do not send this over WhatsApp** to numbers that haven't opted in — the
  *sending* number gets banned. Inbound "Hi" to the demo bot is fine; that's the
  product.
- **Watch the demo under load.** `demo.pragatisolutions.com` runs on the dev
  Railway environment (behind Cloudflare, static assets cached at the edge).
  It's sized for demo traffic, not a spike — start with a small batch, watch the
  Cloudflare Analytics + Railway metrics for the demo services, and scale send
  volume up only once it's holding.
- **Split-test:** send A / B / C to three equal random slices of the first
  ~1,500. Both URLs are bare domains with no per-slice tag, so you can't
  attribute a hit to a variant from server logs alone — measure at the slice
  level: Cloudflare page-view counts for the window, demo "Try it" / bot "Hi"
  starts, and *Request access* emails/form submissions, per slice. Send the
  winner (and D, to owner-heavy segments) to the rest.
