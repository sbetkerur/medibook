# MediBook — WhatsApp Appointment SaaS
## WhatsApp Cloud API (Meta) Edition — Complete Codebase

Multi-tenant WhatsApp appointment booking system for Indian hospitals and clinics.
Patients book appointments by chatting on WhatsApp. Zero WATI fees during development.

---

## Quick Start (2 ways)

### Option A — Auto start everything (easiest)
1. Make sure Docker Desktop is running
2. Double-click `START.bat`
3. Open http://localhost:3000

### Option B — Claude Code verification
1. Double-click `LAUNCH_CLAUDE_CODE.bat`
2. Paste the message shown on screen
3. Claude Code verifies and fixes everything automatically

---

## Manual Start

```bash
# 1. Start database + redis
docker-compose up postgres redis -d

# 2. Install dependencies
cd backend && npm install
cd ../frontend && npm install

# 3. Run migrations + seed
cd backend
node src/db/migrate.js
node src/db/seed.js

# 4. Run tests
node tests/bot.test.js

# 5. Start servers (2 terminals)
# Terminal 1:
cd backend && npm run dev

# Terminal 2:
cd frontend && npm run dev
```

---

## Login Credentials

| Role | Email | Password | Notes |
|------|-------|----------|-------|
| Super Admin | admin@medibook.com | SuperAdmin@123 | Platform management |
| Clinic Admin | demo@medibook.com | Demo@123456 | Clinic slug: `demo-clinic` |

---

## Test the Bot (no WhatsApp needed)

```bash
curl -X POST http://localhost:3001/api/webhook/test \
  -H "Content-Type: application/json" \
  -d '{"phone":"919999999999","message":"Hi"}'
```

Or use the **Bot Tester** tab inside the dashboard at http://localhost:3000/dashboard.

---

## Project Structure

```
medibook/
├── backend/
│   ├── src/
│   │   ├── db/
│   │   │   ├── index.js          # DB pool + tenant query helper
│   │   │   ├── migrate.js        # Public schema migrations
│   │   │   ├── tenantMigrate.js  # Per-tenant schema creator
│   │   │   └── seed.js           # Demo clinic seeder
│   │   ├── routes/
│   │   │   ├── auth.js           # Login endpoints
│   │   │   ├── webhook.js        # Meta webhook + test endpoint
│   │   │   ├── admin.js          # Clinic admin REST API
│   │   │   └── superadmin.js     # Platform management API
│   │   ├── services/
│   │   │   ├── whatsapp.js       # Meta Cloud API client
│   │   │   └── botEngine.js      # WhatsApp conversation state machine
│   │   ├── middleware/
│   │   │   └── auth.js           # JWT + tenant middleware
│   │   ├── jobs/
│   │   │   ├── reminders.js      # 24h + 2h reminder cron
│   │   │   └── slotGenerator.js  # Nightly slot generation cron
│   │   ├── utils/
│   │   │   ├── logger.js         # Winston logger
│   │   │   └── encryption.js     # AES for WhatsApp tokens
│   │   └── index.js              # Express main server
│   ├── tests/
│   │   └── bot.test.js           # 8-test bot engine suite
│   └── .env                      # Environment variables
├── frontend/
│   └── src/app/
│       ├── login/page.js         # Login (clinic + super admin)
│       ├── dashboard/page.js     # Full clinic admin dashboard
│       └── superadmin/page.js    # Platform management panel
├── docker-compose.yml
├── CLAUDE.md                     # Claude Code master instructions
├── START.bat                     # One-click dev environment starter
└── LAUNCH_CLAUDE_CODE.bat        # Claude Code launcher
```

---

## Environment Variables (backend/.env)

```
DATABASE_URL=postgresql://postgres:password@localhost:5432/medibook
REDIS_URL=redis://localhost:6379
JWT_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
ENCRYPTION_KEY=<generate with: node -e "console.log(require('crypto').randomBytes(16).toString('hex'))">

# Meta WhatsApp Cloud API (get from developers.facebook.com)
META_ACCESS_TOKEN=your_token_here
META_PHONE_NUMBER_ID=your_phone_id_here
META_WEBHOOK_VERIFY_TOKEN=any_string_you_choose
META_APP_SECRET=your_app_secret_here
```

The bot works locally without META vars — use `/api/webhook/test` for testing.

---

## Go Live Checklist

1. Create app at developers.facebook.com → Add WhatsApp product
2. Add your WhatsApp number to the app
3. Copy Phone Number ID + Access Token → update `backend/.env`
4. Deploy backend to Railway: `railway up`
5. Set webhook URL in Meta: `https://your-app.railway.app/api/webhook/whatsapp`
6. Subscribe to `messages` webhook field
7. Deploy frontend to Vercel: `vercel deploy`
8. Update `NEXT_PUBLIC_API_URL` in Vercel to your Railway URL
9. Test by sending "Hi" to your WhatsApp number

---

## Key URLs

| URL | Description |
|-----|-------------|
| http://localhost:3000 | Frontend dashboard |
| http://localhost:3001/health | Backend health check |
| POST /api/webhook/test | Test bot locally |
| POST /api/auth/login | Clinic admin login |
| POST /api/auth/superadmin/login | Super admin login |
| GET /api/admin/dashboard | Dashboard stats |
| GET /api/admin/appointments | Appointment list |
| GET /api/admin/doctors | Doctor list |
| GET /api/admin/analytics | 30-day analytics |

---

*MediBook v2.0 — WhatsApp Cloud API Edition*
