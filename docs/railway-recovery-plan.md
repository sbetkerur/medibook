# If Railway goes down (or away)

WhatsApp has its own runbook (`docs/whatsapp-outage-plan.md`). This one is for
the other single point of failure: **the host**. MediBook's backend, frontend,
Postgres and Redis all live in one Railway project — `production` and `dev` both.
A Railway problem can therefore take down the dashboard, the bot and the public
status page at once, which is strictly worse than a WhatsApp outage (there, only
messaging stops).

The realistic failures run from trivial to existential, and the response is
different for each. Know which one you're in before acting.

## Severity tiers

| Tier | Looks like | Response | Data loss |
|---|---|---|---|
| **Container restart** | brief 502s, then fine | none — `restartPolicyType=ON_FAILURE` (3 retries) + healthchecks handle it | none |
| **Railway platform outage** | everything 5xx, [status.railway.app](https://status.railway.app) is red | wait it out (hours, not days); phone the clinics; nothing to fix on our side | none |
| **Bad migration / DB corruption** | app up, data wrong or missing | restore from the volume backup or the off-site copy into a fresh DB | since last backup |
| **Railway loses our data** | managed Postgres empty / unrecoverable | `restore-prod.js --from-s3` into a new DB | since last off-site backup (~6–24h) |
| **Project / account / billing lost** | can't log in to Railway at all; services gone | full DR: new host, restore from off-site, repoint DNS | since last off-site backup |

The bottom two rows are the ones this document exists for. They are unlikely
(~2–5%/year, dominated by billing lapse and human error), and cheap to make
survivable.

## The recovery commands

All from `backend/`:

```bash
# Inspect what's in the off-site bucket
node -e "require('./src/services/backupUpload').listRemote().then(l=>l.forEach(o=>console.log(o.lastModified, o.key)))"

# Prove the newest backup restores to a working MediBook (throwaway container)
npm run backup:verify -- --from-s3

# Restore into a specific target DB (guard-railed; refuses prod-looking hosts)
npm run restore:prod -- --target <postgres-url> --yes --migrate --from-s3

# Full timed rehearsal (starts its own scratch DB, tears it down)
npm run dr:gameday -- --from-s3

# Snapshot every Railway variable for the offline vault
npm run env:dump
```

`restore-prod.js` accepts either backup shape — the custom-format `.dump.enc`
from `scripts/backup-prod.js` (→ `pg_restore`) and the plain-SQL `.sql.enc` from
the in-container nightly (→ `psql`). A `.enc` file is decrypted to an OS-temp
file first (`ENCRYPTION_KEY`) and that temp file is deleted whether the restore
passes or fails.

---

## Preparedness checklist

The source of truth for "are we actually ready". Re-check quarterly.
**`docs/railway-dr-setup.md` is the step-by-step for every item below** — why it
matters, exactly what to do, and how to verify it.

### Backups

- [ ] **Off-site bucket exists** on a provider unrelated to Railway — Cloudflare
      R2 (recommended), Backblaze B2, or AWS S3. A dedicated bucket, versioning
      on, a lifecycle rule as a backstop to `BACKUP_S3_KEEP`.
- [ ] `BACKUP_S3_BUCKET` / `BACKUP_S3_ENDPOINT` / `BACKUP_S3_REGION` /
      `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` set on the
      **backend** service in Railway (production). Then the nightly cron uploads
      every dump off-site automatically.
- [ ] `BACKUP_CRON="0 */6 * * *"` on the backend service (RPO drops from ~24h to
      ~6h; a small DB dump is seconds of load).
- [ ] `BACKUP_DIR` points at a **mounted volume** (not the ephemeral container
      layer) — check the Railway volume is attached.
- [ ] `scripts/backup-prod.js` runs on a **schedule on a machine that is not
      Railway** (laptop Task Scheduler / a VPS cron), at least daily. Confirm
      `~/MediBookBackups/backup.log` has recent `backup OK` lines.
- [ ] `MEDIBOOK_BACKUP_KEEP` and disk headroom on that machine are sane.

### Alerting (so a stalled backup can't go unnoticed)

- [ ] **Healthchecks.io** (or Better Stack / Cronitor) checks created for:
      the in-container backup (`HEALTHCHECK_BACKUP_URL` on the backend service),
      the off-Railway backup (`HEALTHCHECK_BACKUP_PROD_URL` in that machine's
      environment), plus simple HTTP checks on
      `https://api.pragatisolutions.com/health` and
      `https://app.pragatisolutions.com/login`.
- [ ] Those alerts go to **SMS / phone call / Telegram / email — NOT WhatsApp**
      (WhatsApp is exactly the channel that may be down; see the WhatsApp
      outage plan).
- [ ] An **external uptime monitor** (UptimeRobot / Better Stack) on `/health`
      and `/login`, checking from outside Railway. `/api/status` is on Railway
      too, so it's useless during a Railway outage.
- [ ] `/api/status` now carries an `offsite_backup` freshness row — it goes red
      if `backup-prod.js` hasn't checked in for 48h.

### The offline vault (recovery is impossible without it)

- [ ] `npm run env:dump` run; contents moved into a password manager; the
      snapshot file deleted from disk.
- [ ] `ENCRYPTION_KEY` and `JWT_SECRET` confirmed present in the vault.
      **Losing `ENCRYPTION_KEY` makes every backup permanently unreadable** —
      there is no recovery path that doesn't start with it. `restore-prod.js`
      and `decryptBackup.js` fetch it *via the Railway CLI*, which is exactly
      what you don't have if the account is gone.
- [ ] The bucket's access keys, the domain registrar login, and the Meta
      credentials are in the vault too.

### Account & billing hardening

- [ ] **2FA on Railway, GitHub, the domain registrar, and the Meta Business
      account.** Recovery codes for each stored in the vault. Account takeover
      of any of these is a catastrophe no backup fixes.
- [ ] Railway billing: a card with a long expiry, a backup payment method, and
      payment-failure email alerts enabled. A lapsed card + ignored dunning is
      the single most likely way the project is lost.
- [ ] (Optional, medium effort) **prod split into its own Railway project** —
      see below. Isolates it from a dev-side mistake and from shared billing.

### DNS & failover readiness

- [ ] TTL on `api.pragatisolutions.com` and `app.pragatisolutions.com` set to
      **300s** now, so a cutover isn't also waiting on propagation.
- [ ] The fallback host chosen (a VPS with Docker is the natural fit — the repo
      ships `docker-compose.prod.yml`). Target A/CNAME records pre-created,
      disabled or pointed at a holding page.
- [ ] `docker-compose.prod.yml` **tested once end-to-end** via a game-day.
- [ ] `backend/.env.prod` prepared from `backend/.env.prod.example` and stored
      in the vault (it is `.gitignore`d).

### Rehearsal

- [ ] `npm run dr:gameday -- --from-s3` run at least once; the printed RTO
      recorded. Re-run quarterly.
- [ ] `npm run backup:verify` scheduled monthly with alerting on failure.

---

## Catastrophe runbook — the project or account is gone

Target: back online on a new host from the off-site backup.

1. **Stand up the host.** A VPS with Docker + Docker Compose. Clone the repo.
2. **Create `backend/.env.prod`** from `backend/.env.prod.example`, filling every
   `[VAULT]` value from the password manager — the **same `ENCRYPTION_KEY`** the
   backups were taken under, and the same `JWT_SECRET` (a new one just logs
   everyone out; a new encryption key means the backups won't decrypt).
   Also set `BACKUP_S3_*` so the restore can pull from the bucket.
3. **Bring up the data layer:**
   ```bash
   POSTGRES_PASSWORD=<pick one> docker compose -f docker-compose.prod.yml up -d postgres redis
   ```
4. **Restore:**
   ```bash
   cd backend && node scripts/restore-prod.js \
     --target postgresql://postgres:<POSTGRES_PASSWORD>@localhost:5432/medibook \
     --yes --migrate --from-s3
   ```
   `--migrate` brings an older backup up to the current schema.
5. **Bring up the app:**
   ```bash
   POSTGRES_PASSWORD=<same> BACKEND_URL=https://api.pragatisolutions.com \
     docker compose -f docker-compose.prod.yml up -d backend frontend
   ```
   (Set `BACKEND_URL` before this — Next.js compiles the API proxy target at
   build time.)
6. **Repoint DNS.** `api.pragatisolutions.com` → the new host (put a TLS
   terminator / reverse proxy in front, or run Caddy). `app.pragatisolutions.com`
   → the new host. Low TTL means minutes.
7. **Verify.** `curl https://api.pragatisolutions.com/health` (fresh
   `uptime_seconds`), `curl https://app.pragatisolutions.com/api/proxy/health`
   (proxy reaches the backend), then send a real WhatsApp message through the
   demo entry code and confirm a reply.

**Meta needs no change** as long as you keep the `api.pragatisolutions.com`
domain — the webhook callback URL and verify token are unchanged. If you can't
keep the domain immediately, update the callback URL in the Meta app dashboard
(WhatsApp → Configuration) and re-verify with `META_WEBHOOK_VERIFY_TOKEN`.

**Expectations:** data loss (RPO) ≈ time since the last off-site backup (~6–24h).
Time to recover (RTO) ≈ the number from your last game-day, plus DNS propagation.

---

## Quarterly game-day

```bash
cd backend && npm run dr:gameday -- --from-s3
```

It starts a throwaway Postgres, runs the real `restore-prod.js` against it with
`--migrate`, asserts a working MediBook (platform tables, plans, the super
admin, and one schema per tenant row — the silent-corruption check), prints the
elapsed time as the measured data-layer RTO, and tears the container down.

Then do the manual half once: `docker compose -f docker-compose.prod.yml up`
against the restored data and confirm `/health` and `/login`. Record the total.

---

## Splitting prod into its own Railway project

Today `production` and `dev` are two *environments* in one *project*, so a
project-level delete, suspension or billing failure hits both, and a dev-side
mistake can reach prod. Moving prod to its own project isolates all of that.
Medium effort:

1. New Railway project, e.g. `medibook-prod`.
2. Recreate the `backend` and `frontend` services from
   `github.com/<owner>/medibook@master`, each with its **Root Directory** set
   (`/backend`, `/frontend`) so `railway.toml`/Dockerfile resolve — see
   `CLAUDE.md`'s deploy notes and the "must NOT use --path-as-root" memory.
3. Add Postgres 18 and Redis plugins.
4. Copy every variable from the vault (`npm run env:dump` output) into the new
   services.
5. Update the cross-environment forward vars: prod's `TEST_ROUTE_URL` still
   points at dev's `/api/webhook/whatsapp`; keep `TEST_ENTRY_CODES=TRYMED`; dev
   must still have **neither** var (that absence is what stops a forwarded
   message being forwarded again — see the two-environments design in CLAUDE.md).
6. Restore the latest backup into the new Postgres (`restore-prod.js`).
7. Move the custom domains (`api.` / `app.`) to the new services; verify.
8. Retire the old `production` environment.

---

## The bigger upgrade — deferred until there are paying clinics

**Off-Railway logical replica + warm standby.** Native Postgres logical
replication (`CREATE PUBLICATION` on Railway's Postgres → `CREATE SUBSCRIPTION`
on an external Postgres — Neon, Supabase, or a VPS) gives a seconds-behind copy
that survives the Railway account entirely, taking RPO from hours to seconds.
Pair it with a scaled-to-zero `docker-compose.prod.yml` deployment on a second
provider pointed at the replica: failover becomes "promote the replica + flip
DNS" rather than "restore from a dump".

Real ongoing cost and complexity (~$10–30/mo, plus replication monitoring), so
it's not worth it while prod has a handful of clinics. Documented here so it
isn't re-derived from scratch when it is.

---

## Config reference (fill in the blanks for your setup)

| Thing | Value |
|---|---|
| Frontend (prod) | `https://app.pragatisolutions.com` (Railway alias `frontend-production-2f2d.up.railway.app`) |
| Backend (prod) | `https://api.pragatisolutions.com` (alias `backend-production-f66a.up.railway.app`) |
| Backend health | `GET /health` — fresh `uptime_seconds` confirms migrate→seed→start ran |
| Frontend proxy health | `GET /api/proxy/health` — proves the Next.js rewrite reaches the backend |
| Public status | `GET https://api.pragatisolutions.com/api/status` |
| Meta webhook callback | `https://api.pragatisolutions.com/api/webhook/whatsapp` (verify token = `META_WEBHOOK_VERIFY_TOKEN`) |
| DNS registrar | _(fill in)_ |
| Off-site bucket | _(fill in: provider, bucket, region/endpoint)_ |
| Healthchecks project | _(fill in URL)_ |
| Fallback host | _(fill in)_ |
