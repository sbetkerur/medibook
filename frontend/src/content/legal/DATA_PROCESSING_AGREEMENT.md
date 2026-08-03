# MediBook — Data Processing Agreement

<!-- INTERNAL -->
**DRAFT — requires review by an Indian advocate before use.**
DPDP Act s.8(2) permits a Fiduciary to engage a Processor **only under a valid
contract**. This is that contract, and the document a clinic's lawyer will read
line by line. Do not trim further without advice.

**Placeholders:** `{{ENTITY}}` · `{{ENTITY_TYPE}}` · `{{ADDRESS}}` · `{{CITY}}` ·
`{{STATE}}` · `{{DATE}}` · `{{SUPPORT_EMAIL}}` · `{{SECURITY_EMAIL}}`
<!-- /INTERNAL -->

**Effective:** {{DATE}} · **Version:** 1.0

## 1. Parties, scope and roles

This DPA forms part of the MediBook Terms of Service between **{{ENTITY}}**
({{ENTITY_TYPE}}), {{ADDRESS}} (the "**Processor**", "we") and the subscribing
clinic (the "**Fiduciary**", "you"). It applies wherever we process personal
data on your behalf and prevails over the Terms on personal data matters.

You are the **Data Fiduciary**: you determine the purpose and means of
processing patient data and are responsible for its lawfulness, including
consent and notice. We are the **Data Processor**: we process only on your
documented instructions. Where we determine purpose and means ourselves — data
about your staff's use of our site and billing — we act as Fiduciary and our
Privacy Policy governs.

## 2. Details of processing

**Subject matter:** provision of the MediBook service. **Duration:** the
subscription term plus the deletion period in Clause 8. **Nature and purpose:**
taking appointment requests over WhatsApp; storing and displaying appointments,
patients, dentists, branches and schedules; sending confirmations, reminders and
feedback requests; generating availability; storing clinical notes you enter;
reporting; backups and audit logs.

**Data Principals:** your patients and their nominated contacts; your Authorised
Users.

| Category | Examples |
|---|---|
| Identity | Name, date of birth, gender |
| Contact | Phone, email |
| Appointment | Booking references, dates, dentist, branch, status |
| Communications | WhatsApp message content, delivery receipts |
| Feedback | Ratings and comments |
| Health-related | Blood type, allergies, chronic conditions, medications, clinical notes — **only where you choose to record them** |
| Preference | Messaging opt-out status |
| Staff | Names, emails, roles, authentication and audit records |

Health-related data is optional to the Service. Record only what you need.

## 3. Our obligations

1. **Process only on instruction** — solely to provide the Service, per your
   documented instructions and configuration, except where law requires
   otherwise (we tell you first unless prohibited).
2. **Confidentiality** — personnel bound by confidentiality, access limited to
   what duties require.
3. **Security** — maintain Annexure A and not materially reduce it.
4. **Sub-processors** — per Clause 4.
5. **Assistance** — with Data Principal requests, your breach notifications, and
   any security assessment.
6. **No independent use** — no sale, advertising, model training, or purpose
   beyond providing the Service.
7. **Deletion or return** — per Clause 8.
8. **Records** of processing carried out for you.

## 4. Sub-processors

You authorise those in Annexure B. We give **30 days' notice** before adding a
sub-processor handling patient data. If you object on reasonable data protection
grounds we will seek a solution in good faith; if none exists you may terminate
the affected part without penalty and receive a pro-rata refund. We remain
responsible for our sub-processors and impose obligations no less protective
than this DPA.

## 5. Breach notification

On becoming aware of a personal data breach affecting data we process for you,
we will **notify you within 72 hours** at your registered and security contacts,
stating so far as known: nature, categories and approximate numbers affected,
likely consequences, and measures taken. We will update as more is known and
cooperate in mitigation. Notification is not an admission of liability.

**You** remain responsible for notifying the Data Protection Board and affected
Data Principals as Fiduciary; we supply what you reasonably need. Report
suspected issues to {{SECURITY_EMAIL}}.

## 6. Data Principal requests

Use the Service's own access, correction, export and deletion functions first.
If a Data Principal contacts us directly we will acknowledge, direct them to you
and inform you promptly, without responding substantively.

**Exception:** we always honour a request to stop WhatsApp messages, since doing
otherwise risks harm and breaches platform policy. We record it and tell you.

Where the Service cannot fulfil a request we assist at no charge for reasonable
volumes.

## 7. Audit and transfers

On request, once per 12 months, we provide information reasonably necessary to
demonstrate compliance, including our security measures and any certifications.
Where insufficient for a documented regulatory obligation you may audit: at your
cost, on 30 days' notice, in business hours, without disrupting the Service or
other customers' confidentiality, by an independent auditor bound by
confidentiality and reasonably acceptable to us.

Some sub-processors operate outside India, so data may be processed outside
India. We do not transfer to territories restricted by the Central Government.

## 8. Deletion and return

On termination, for **30 days** you may request an export in a common
machine-readable format. After that we delete personal data from the live
Service. Data in routine backups is overwritten on the rotation in Annexure A
and stays subject to this DPA until then. We may retain what law requires, for
as long as required, under continuing confidentiality obligations. We confirm
deletion on request.

## 9. Your obligations

You warrant that: you have a lawful basis for the processing you instruct and
have obtained required consent and given required notice; your instructions will
not cause us to breach law; you record only data you genuinely need, especially
health data; you secure your own systems, devices and credentials and manage
user access diligently; and where a patient is a child, you have verifiable
parental or guardian consent.

## 10. Liability and law

Liability is subject to the limitations in the Terms of Service. Governed by the
laws of India; courts at {{CITY}}, {{STATE}} have exclusive jurisdiction.

---

# Annexure A — Security measures

**Tenant isolation** — dedicated PostgreSQL schema per clinic; schema names
validated against a strict pattern; search path set per transaction, so a query
cannot reach another tenant's data.

**Encryption** — TLS for all application and API traffic; bot conversation
context encrypted at rest with AES-256-GCM; storage encryption as provided by
our hosting provider.

**Authentication and access** — bcrypt password hashes; SHA-256 hashes for reset
and refresh tokens; access tokens expire hourly and are revocable; refresh
tokens single-use and rotating; role-based admin, reception and dentist views;
administrative actions restricted to admin accounts.

**Application security** — inbound WhatsApp webhooks verified by HMAC-SHA256
against the raw body, with message-ID deduplication against replay; per-tenant
rate limiting on auth and API endpoints; input and identifier validation; CSP
and CORS locked to the configured origin.

**Monitoring** — audit log of dashboard changes and the responsible account;
error monitoring with limited log retention.

**Resilience** — automated database backups on a rolling schedule retaining the
7 most recent; automatic clearing of inactive sessions; failed webhook records
purged after 7 days.

<!-- INTERNAL -->
> ⚠️ **VERIFY BEFORE PUBLISHING — two claims above are not currently true.**
> (1) Backups are produced by `pg_dump` and written **unencrypted**; do not
> claim encrypted backups until they are. (2) Backup retention holds only if
> `BACKUP_DIR` is set to a mounted volume in production — if unset, backups go
> to a temp directory and are lost on redeploy. A false security representation
> here is one you are contractually liable for.
<!-- /INTERNAL -->

**Organisational** — production data access limited to personnel who need it,
under confidentiality obligations; changes version-controlled and reviewed
before release.

*Measures as at the effective date. May be updated provided protection is not
materially reduced.*

---

# Annexure B — Sub-processors

| Sub-processor | Purpose | Data | Location |
|---|---|---|---|
| Meta Platforms | WhatsApp messaging | Phone, message content | Outside India |
| Railway | Hosting | All hosted data | Outside India |
| Resend | Transactional email | Email, message content | Outside India |
| Twilio | SMS fallback *(where enabled)* | Phone, message content | Outside India |
| OpenAI | Voice note transcription *(where enabled)* | Audio content | Outside India |
| Sentry | Error monitoring | Technical logs | Outside India |

*Current as at the effective date. Changes notified under Clause 4.*

---

# Annexure C — Contacts

Data protection queries: {{SUPPORT_EMAIL}} · Security incidents:
{{SECURITY_EMAIL}}

**Your security contact** — give us an email for breach notification; otherwise
we use your registered account address.
