# Clinic QR codes

Every clinic's WhatsApp entry code, as a printable QR. Scanning one opens
WhatsApp with that clinic's code pre-typed; the patient presses send and lands
on that clinic's menu. It is the **only** way a patient reaches a clinic — see
the entry-code invariant in `CLAUDE.md`.

Generated **2026-08-05** from the **production** database, against WhatsApp
number **+91 77956 76142** (`Pragati Solutions`, quality GREEN).

## What is here

| File | Use |
|---|---|
| `index.html` | All eight clinics as counter cards, one per printed page. Images are embedded, so it prints straight from the folder with no network. |
| `<slug>.png` | 800px, for sending to a clinic or dropping into a document. |
| `<slug>.svg` | Vector, for a print shop. |
| `clinics.csv` | slug, name, city, code, link — for a mail merge. |

## Regenerating

These are **build artefacts and they go stale.** A clinic that regenerates its
code from Settings → *Issue a new code* invalidates the QR here immediately, and
nothing in this folder will tell you.

```bash
cd backend
npm run qr:export -- --out ../docs/clinic-qr-codes          # local database
```

Against production, pass the public proxy URL from the Railway `postgres`
service (`DATABASE_PUBLIC_URL`) and the live number:

```bash
DATABASE_URL="<DATABASE_PUBLIC_URL>" WHATSAPP_PUBLIC_NUMBER=917795676142 \
  node scripts/exportClinicQrCodes.js --out ../docs/clinic-qr-codes
```

The script refuses to run without a number rather than emitting QR codes that
point nowhere, and it reports loudly — instead of skipping — any clinic with no
entry code, because such a clinic cannot be reached by patients at all.

## Note on what these currently are

All eight tenants in production today are demo and test clinics. When real
clinics are onboarded, regenerate: the export reads whatever is in the database
at the time, and a card printed for a clinic that has since changed its code is
worse than no card.

Entry codes are **not secrets** — they are printed on a board in a public
waiting room, and they confer no authority. Everything downstream still
authenticates the patient by phone number.
