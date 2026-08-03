# MediBook — Privacy Policy

<!-- INTERNAL -->
**DRAFT — requires review by an Indian advocate. The DPDP Act requires you to
name a Grievance Officer.**
**Placeholders:** `{{ENTITY}}` · `{{ENTITY_TYPE}}` · `{{ADDRESS}}` ·
`{{DATE}}` · `{{SUPPORT_EMAIL}}` · `{{GRIEVANCE_OFFICER}}` · `{{GRIEVANCE_EMAIL}}`
<!-- /INTERNAL -->

**Effective:** {{DATE}} · **Version:** 1.0

## 1. Who we are

{{ENTITY}} ({{ENTITY_TYPE}}), {{ADDRESS}}, operates MediBook — a WhatsApp
appointment booking and clinic management service for Indian dental practices.
This policy complies with the Digital Personal Data Protection Act, 2023
("DPDP Act").

## 2. Our two roles

**Data Fiduciary** — for data about our customers, their staff and website
visitors. This policy governs it.

**Data Processor** — for **patient** data in a clinic's account. The **clinic**
is the Fiduciary; we act only on its instructions and never use patient data for
our own purposes.

> **Patients:** contact **your clinic** to access, correct or delete your data —
> they control it. We will always honour a request to stop WhatsApp messages
> (Section 6).

## 3. What we collect

**Clinic users** — name, email, phone, clinic name and address; password
(bcrypt hash only), role, session and login records; plan, branches and
invoices; support correspondence; IP address, device and browser data, error
reports, dashboard audit records.

**Patient data** — the clinic decides what is recorded. The Service can store
name, phone, email, date of birth, gender; appointment history and status;
WhatsApp messages with the assistant; feedback and ratings; opt-out status; and
any clinical notes the clinic enters, which may include blood type, allergies,
chronic conditions and medications. No clinical data is required for the Service
to work.

## 4. Why, and who we share it with

As Fiduciary we process clinic-user data to provide and administer the Service,
authenticate and secure accounts, bill, support you, prevent fraud and abuse,
improve the Service using aggregated statistics, market to business customers,
and meet legal obligations — on the basis of our contract with you, legitimate
use, consent, or legal obligation as applicable.

As Processor, patient data is used solely to provide the Service under our Data
Processing Agreement. **We do not sell personal data, use it for advertising, or
use it to train machine learning models.**

| Sub-processor | Function |
|---|---|
| Meta (WhatsApp Business Platform) | Patient messaging |
| Railway | Hosting |
| Resend | Transactional email |
| Twilio | SMS fallback, where enabled |
| OpenAI | Voice note transcription, where enabled |
| Sentry | Error monitoring |

We may also disclose to advisers under confidentiality, where law requires, or
to a successor on a sale of the business (on notice). Some sub-processors are
outside India, so data may be processed outside India; we do not transfer to
territories restricted by the Central Government. We give notice before adding a
sub-processor handling patient data.

## 5. How we protect it

Separate database schema per clinic, with validated schema names and
per-transaction scoping; TLS throughout; AES-256-GCM encryption of bot
conversation context at rest; bcrypt password hashes and SHA-256 token hashes;
hourly-expiring revocable access tokens and single-use rotating refresh tokens;
role-based admin, reception and dentist views; audit logging of dashboard
changes; HMAC-verified webhooks; rate limiting; and automated database backups
on a rolling schedule.

<!-- INTERNAL -->
> ⚠️ **VERIFY BEFORE PUBLISHING.** Backups are written unencrypted by `pg_dump`
> and lost on redeploy unless `BACKUP_DIR` points at a mounted volume. Do not
> describe them as encrypted until they are.
<!-- /INTERNAL -->

No system is perfectly secure. We will notify affected parties and the Data
Protection Board of India of a breach as the DPDP Act requires.

## 6. WhatsApp opt-out

Patients can stop messages any time by replying **STOP**; **START**
re-subscribes. We send nothing further except direct replies to messages they
initiate. The clinic remains responsible for obtaining consent before messaging.

## 7. Retention

| Data | Retention |
|---|---|
| Clinic account and data | Subscription, then 30 days for export, then deleted |
| Patient data | As the clinic instructs; deleted on closure per the DPA |
| Bot session state | Cleared after inactivity |
| Failed webhook records | 7 days |
| Backups | Rolling window of the 7 most recent |
| Billing records | As tax and accounting law requires |

## 8. Your rights

Under the DPDP Act you may **access** a summary of your data and its
processing, **correct** inaccurate or incomplete data, **erase** data no longer
needed, **nominate** someone to exercise these rights on death or incapacity,
and have a **grievance** addressed before approaching the Data Protection Board.

Clinic users: {{GRIEVANCE_EMAIL}}. Patients: contact your clinic (Section 2).

## 9. Grievance Officer

**{{GRIEVANCE_OFFICER}}** · {{GRIEVANCE_EMAIL}} · {{ADDRESS}}

We aim to acknowledge within 72 hours and resolve within the period prescribed
by law. If unsatisfied, you may complain to the Data Protection Board of India.

## 10. Cookies, children and changes

**Cookies** — only what keeps you signed in and secure; no advertising or
third-party tracking in the application.

**Children** — the Service is for clinics. Where a patient is a child, the
clinic must obtain verifiable parental consent. We do not carry out tracking,
behavioural monitoring or targeted advertising directed at children, and clinics
must not use the Service to do so.

**Changes** — material changes notified by email and dashboard notice 30 days
before taking effect.

---
**Contact:** {{SUPPORT_EMAIL}} · **Grievances:** {{GRIEVANCE_EMAIL}}
