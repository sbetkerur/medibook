# Railway DR — setup actions

The recovery *machinery* is in the repo and tested (`docs/railway-recovery-plan.md`).
This document is the other half: the account, bucket, monitor, DNS and 2FA work
that only a human can do. Each action says **why**, the **steps**, and how to
**verify** it. Work top to bottom.

`docs/railway-recovery-plan.md` has the tick-box version of this list — keep it
updated as you complete these.

Legend: 🔴 do this week · 🟡 this month · ⚪ later.

---

## 🔴 1. Create the off-site backup bucket

**Why.** The nightly backup writes to a Railway volume *in the same project as
the database*. The laptop copy needs the laptop switched on. Neither survives
"the Railway account is gone". A bucket on an unrelated provider does.

**Steps (Cloudflare R2 — recommended; Backblaze B2 or AWS S3 work identically):**

1. Cloudflare dashboard → **R2** → *Create bucket* → name it `medibook-dr`,
   location automatic.
2. In the bucket → **Settings** → enable **Object versioning** (protects against
   a bad object overwriting a good one).
3. Bucket → **Settings** → *Add lifecycle rule* → delete objects older than
   **35 days** (a backstop under `BACKUP_S3_KEEP`).
4. R2 → **Manage R2 API Tokens** → *Create API token* → permissions **Object
   Read & Write**, scoped to the `medibook-dr` bucket. Copy the
   **Access Key ID**, **Secret Access Key**, and the **S3 endpoint**
   (`https://<accountid>.r2.cloudflarestorage.com`).
5. Put the Access Key ID and Secret in your password manager now (they're shown
   once).

**Verify.** You have four values: bucket name, endpoint URL, access key ID,
secret access key. Region for R2 is the literal string `auto`.

---

## 🔴 2. Turn on off-site upload for the in-container backup

**Why.** With the bucket configured on the backend service, every nightly
`pg_dump` is mirrored off Railway automatically — no extra job to run.

**Steps.** Set these on the **backend** service, **production** environment —
Railway dashboard → backend → *Variables*, or the CLI:

```bash
railway variables --service backend --environment production \
  --set "BACKUP_S3_BUCKET=medibook-dr" \
  --set "BACKUP_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com" \
  --set "BACKUP_S3_REGION=auto" \
  --set "BACKUP_S3_ACCESS_KEY_ID=<key id>" \
  --set "BACKUP_S3_SECRET_ACCESS_KEY=<secret>" \
  --set "BACKUP_CRON=0 */6 * * *"
```

`BACKUP_CRON=0 */6 * * *` moves the in-container backup to every 6 hours (a
small dump is seconds of load); leave it unset for the nightly default.

Setting variables triggers a redeploy. If it doesn't, deploy manually
(`docs/railway-recovery-plan.md` / the deploy notes in `CLAUDE.md`).

**Verify.** After the redeploy, the backend log line
`Backup cron registered (0 */6 * * * IST, off-site upload ON)`. After the next
run, an object appears in the R2 bucket and the log shows
`Off-site backup uploaded: s3://medibook-dr/medibook-backups/...`.

---

## 🔴 3. Schedule the off-Railway backup on a machine that isn't Railway

**Why.** A second, independent copy that doesn't depend on the backend being
healthy or on Railway existing. This is the copy you restore from in a real
disaster.

**Steps (Windows Task Scheduler, on your machine):**

1. Confirm it runs by hand first:
   ```powershell
   cd C:\claude_projects\medibook\backend
   npm run backup:prod
   ```
   It needs the Railway CLI logged in (`railway login`) and either the
   PostgreSQL 18 client tools or Docker Desktop running.
2. Task Scheduler → *Create Task*:
   - **General:** "MediBook off-site backup", *Run whether user is logged on or
     not*.
   - **Triggers:** daily, every 6–12 hours.
   - **Actions:** Program `node`, arguments `scripts\backup-prod.js`, *Start in*
     `C:\claude_projects\medibook\backend`.
   - **Conditions:** untick *Start only on AC power* if it's a laptop.
3. Set the environment variables the task will see — either machine/user
   environment variables, or wrap the call in a `.cmd` that `set`s them:
   `BACKUP_S3_*` (same four values as action 2, so this copy also lands in R2),
   `HEALTHCHECK_BACKUP_PROD_URL` (action 4), optionally `MEDIBOOK_BACKUP_KEEP`.

**Verify.** `~/MediBookBackups/backup.log` gains a `backup OK` line on schedule,
and (if `BACKUP_S3_*` is set for the task) an `off-site: uploaded …` line.

---

## 🔴 4. Wire up alerting so a stalled backup can't go unnoticed

**Why.** A backup that silently stops is the worst failure it can have. Right
now nothing would tell you. `/api/status` would — but it's on Railway, so it's
gone in exactly the outage you care about.

**Steps (Healthchecks.io — free tier is enough):**

1. Create a project. Add four checks:
   | Check | Period / grace | Fed by |
   |---|---|---|
   | `medibook-backup-container` | 6h / 1h | `HEALTHCHECK_BACKUP_URL` on the backend service |
   | `medibook-backup-offsite` | 1d / 6h | `HEALTHCHECK_BACKUP_PROD_URL` on your machine (action 3) |
   | `medibook-api` (HTTP check) | 5m | polls `https://api.pragatisolutions.com/health` |
   | `medibook-app` (HTTP check) | 5m | polls `https://app.pragatisolutions.com/login` |
2. For each cron check, copy its **ping URL** and set it as the matching
   variable — `HEALTHCHECK_BACKUP_URL` on the backend service (Railway),
   `HEALTHCHECK_BACKUP_PROD_URL` in the scheduled task's environment.
3. **Integrations:** add **SMS**, a **phone call**, or **Telegram** — and email.
   **Do not** use WhatsApp; that's the channel that may be down (see
   `docs/whatsapp-outage-plan.md`).
4. Optionally also add a plain external uptime monitor (UptimeRobot / Better
   Stack) on the same two URLs for a second opinion.

**Verify.** The container-backup check goes green after the next run. Kill a run
deliberately (or wait past the grace period) and confirm the alert reaches your
phone.

---

## 🔴 5. Build the offline vault

**Why.** Recovery of a lost account starts with whatever you saved
*independently* of Railway. `restore-prod.js` and `decryptBackup.js` fetch
`ENCRYPTION_KEY` **through the Railway CLI** — useless if the account is gone.
Lose `ENCRYPTION_KEY` without a copy and **every backup is permanently
unreadable**.

**Steps.**

1. With the Railway CLI logged in:
   ```bash
   cd C:\claude_projects\medibook\backend
   npm run env:dump
   ```
   It writes `~/MediBookBackups/railway-env-snapshot-<timestamp>.txt` and checks
   that `ENCRYPTION_KEY` and `JWT_SECRET` are present for backend/production.
2. Move the entire contents into your password manager as a secure note
   ("MediBook — Railway environment", one entry). Include the R2 keys, the
   domain registrar login, and the Meta credentials if they aren't already
   there.
3. **Delete the snapshot file** from disk.

**Verify.** `npm run env:dump` prints
`ENCRYPTION_KEY and JWT_SECRET confirmed present for backend/production.`, and
the file is no longer on disk.

---

## 🔴 6. Turn on 2FA everywhere that can end the company

**Why.** Account takeover of any one of these is a catastrophe no backup fixes.

**Steps.** Enable 2FA (authenticator app, not SMS where possible) and store the
recovery codes in the vault (action 5) for:

- **Railway** — Account settings → Security.
- **GitHub** — the account/org that owns `medibook`.
- **Domain registrar** — whoever holds `pragatisolutions.com`.
- **Meta Business** — the business account behind the WhatsApp number.

**Verify.** Each account shows 2FA active; recovery codes are in the vault.

---

## 🟡 7. Lower DNS TTL and pre-stage the failover records

**Why.** During a cutover you don't want to also be waiting on DNS caches.

**Steps.**

1. At the DNS provider for `pragatisolutions.com`, set the TTL on
   `api.pragatisolutions.com` and `app.pragatisolutions.com` to **300 seconds**.
2. Decide the fallback host (see action 8) and pre-create the target A/AAAA or
   CNAME records — pointed at a holding page or disabled — so failover is a
   value change, not a new record.

**Verify.** `dig api.pragatisolutions.com` (or `nslookup`) shows TTL ≈ 300.

---

## 🟡 8. Prove the fallback stack works (game-day)

**Why.** An unrehearsed recovery plan is a document, not a capability. This also
tells you the real RTO number.

**Steps.**

1. Data layer, timed:
   ```bash
   cd C:\claude_projects\medibook\backend
   npm run dr:gameday -- --from-s3
   ```
   Records the elapsed restore+migrate time. (Already verified once locally at
   ~23s against a local backup; re-run against `--from-s3` once the bucket is
   live.)
2. App layer, once:
   ```bash
   cp backend/.env.prod.example backend/.env.prod   # fill [VAULT] values from action 5
   POSTGRES_PASSWORD=<pick> docker compose -f docker-compose.prod.yml up -d postgres redis
   cd backend && node scripts/restore-prod.js \
     --target "postgresql://postgres:<POSTGRES_PASSWORD>@localhost:5432/medibook" \
     --yes --migrate --from-s3
   POSTGRES_PASSWORD=<same> docker compose -f docker-compose.prod.yml up -d backend frontend
   curl http://localhost:3001/health && curl http://localhost:3000/login -I
   docker compose -f docker-compose.prod.yml down -v
   ```
3. Pick the real fallback host — a small VPS with Docker is the natural fit
   (the compose file runs anywhere). Note it in the config table at the bottom
   of `docs/railway-recovery-plan.md`.

**Verify.** `dr:gameday` prints `PASS`; the app-layer run returns HTTP 200 from
both `/health` and `/login`. Write the total time into the runbook.

---

## 🟡 9. Schedule the monthly backup verification

**Why.** Every backup should be *proven* restorable, not assumed.

**Steps.** A second Task Scheduler entry (or cron on the VPS), monthly:
`node scripts\verify-backup.js --from-s3`. Point its exit status at a
Healthchecks.io check so a failure pages you.

**Verify.** The check reports success after the first scheduled run.

---

## ⚪ 10. Split production into its own Railway project

**Why.** `production` and `dev` are two environments in **one project** today, so
a project-level delete, suspension or billing failure hits both, and a dev-side
mistake can reach prod.

**Steps.** Full procedure in `docs/railway-recovery-plan.md` §"Splitting prod
into its own Railway project" — new project, recreate the two services with
their Root Directory set, add Postgres 18 + Redis, copy variables from the
vault, keep the cross-environment forward vars correct, restore the latest
backup, move the custom domains, retire the old environment.

**Verify.** `railway status` on the new project; `/health` fresh uptime; a bot
test through the demo code still replies.

---

## ⚪ 11. Off-Railway logical replica + warm standby

**Why.** Takes RPO from hours to seconds and failover from "restore a dump" to
"promote + flip DNS".

**Steps.** Design and setup in `docs/railway-recovery-plan.md` §"The bigger
upgrade". Deferred on purpose — real monthly cost and replication monitoring,
not worth it until there are paying clinics.

---

## Billing hygiene (ongoing)

- A card with a long expiry on the Railway account, plus a backup payment
  method.
- Payment-failure email alerts enabled in Railway billing settings.
- A monthly calendar reminder to glance at Railway billing and the
  Healthchecks.io dashboard.
