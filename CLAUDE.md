# MediBook — WhatsApp Appointment SaaS for Dental Clinics
## Claude Code Master Instruction File
## WhatsApp Cloud API (Meta) Edition

> Read this entire file before taking any action.
> Execute all phases in order. Fix every error before moving to the next phase.
> Do not ask for confirmation unless you hit something genuinely unresolvable.

---

## PROJECT OVERVIEW

Multi-tenant WhatsApp appointment booking SaaS for Indian dental clinics and chains.
- Patients book appointments by chatting on WhatsApp
- Each clinic gets its own WhatsApp bot powered by Meta Cloud API
- Clinic admins manage everything via a web dashboard
- Super admin manages all tenants

**Stack:** Node.js + Express (backend), Next.js + Tailwind (frontend), PostgreSQL (schema-per-tenant), Redis + BullMQ (queues), Meta WhatsApp Cloud API (messaging)

---

## ENVIRONMENT VARIABLES NEEDED

Before starting, check that backend/.env exists with at least:
```
DATABASE_URL=postgresql://postgres:password@localhost:5432/medibook
REDIS_URL=redis://localhost:6379
JWT_SECRET=<32+ char random string>
ENCRYPTION_KEY=<32 char random string>
META_ACCESS_TOKEN=<from Meta Developer Console>
META_PHONE_NUMBER_ID=<from Meta Developer Console>
META_WEBHOOK_VERIFY_TOKEN=<any string you choose>
META_APP_SECRET=<from Meta Developer Console>
```

If META vars are missing, use placeholder values for now — the bot engine will still work for local testing via the test endpoint.

---

## PHASE 1 — PROJECT SCAFFOLD & DEPENDENCIES

### 1A. Create directory structure
```
medibook/
├── backend/
│   ├── src/
│   │   ├── db/
│   │   ├── routes/
│   │   ├── middleware/
│   │   ├── services/
│   │   ├── jobs/
│   │   ├── utils/
│   │   └── index.js
│   ├── tests/
│   ├── .env
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   ├── components/
│   │   └── lib/
│   ├── public/
│   ├── next.config.js
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   └── package.json
└── docker-compose.yml
```

### 1B. docker-compose.yml
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: medibook
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
volumes:
  pgdata:
```

### 1C. backend/package.json
```json
{
  "name": "medibook-backend",
  "version": "1.0.0",
  "scripts": {
    "dev": "nodemon src/index.js",
    "start": "node src/index.js",
    "migrate": "node src/db/migrate.js",
    "seed": "node src/db/seed.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "pg": "^8.11.3",
    "ioredis": "^5.3.2",
    "bullmq": "^4.14.0",
    "axios": "^1.6.2",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "express-rate-limit": "^7.1.5",
    "dotenv": "^16.3.1",
    "winston": "^3.11.0",
    "node-cron": "^3.0.3",
    "crypto-js": "^4.2.0",
    "date-fns": "^2.30.0",
    "date-fns-tz": "^2.0.0",
    "joi": "^17.11.0",
    "resend": "^2.0.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  }
}
```

### 1D. frontend/package.json
```json
{
  "name": "medibook-frontend",
  "version": "1.0.0",
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "14.0.4",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "axios": "^1.6.2",
    "react-hot-toast": "^2.4.1",
    "lucide-react": "^0.294.0",
    "date-fns": "^2.30.0",
    "recharts": "^2.10.1",
    "@headlessui/react": "^1.7.17"
  },
  "devDependencies": {
    "tailwindcss": "^3.3.6",
    "autoprefixer": "^10.4.16",
    "postcss": "^8.4.32",
    "@types/node": "^20.10.0",
    "@types/react": "^18.2.43"
  }
}
```

### 1E. frontend/next.config.js
```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001',
  },
}
module.exports = nextConfig
```

### 1F. frontend/tailwind.config.js
```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50:'#eff6ff', 500:'#3b82f6', 600:'#2563eb', 700:'#1d4ed8' }
      }
    }
  },
  plugins: [],
}
```

### 1G. frontend/postcss.config.js
```js
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } }
```

### 1H. frontend/.env.local
```
NEXT_PUBLIC_API_URL=http://localhost:3001
```

### 1I. Run installs
```bash
cd backend && npm install
cd ../frontend && npm install && npm run build
```
Fix every build error before proceeding.

**Verification:** `npm run build` in frontend completes with 0 errors.

---

## PHASE 2 — DATABASE SCHEMA

### 2A. backend/src/db/index.js
```javascript
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Safe tenant query — uses SET LOCAL (transaction-scoped, safe under pooling)
async function tenantQuery(schemaName, sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schemaName}", public`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Public schema query
async function query(sql, params = []) {
  return pool.query(sql, params);
}

module.exports = { pool, query, tenantQuery };
```

### 2B. backend/src/db/migrate.js
```javascript
require('dotenv').config();
const { pool } = require('./index');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');

    // Public schema — platform-level tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        schema_name VARCHAR(100) UNIQUE NOT NULL,
        wa_phone_number_id VARCHAR(100),
        wa_access_token_enc TEXT,
        wa_webhook_verify_token VARCHAR(255),
        plan VARCHAR(50) DEFAULT 'starter',
        status VARCHAR(50) DEFAULT 'active',
        owner_email VARCHAR(255) NOT NULL,
        settings JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS plans (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        max_doctors INTEGER DEFAULT 5,
        max_appointments_per_month INTEGER DEFAULT 500,
        price_monthly INTEGER DEFAULT 0,
        features JSONB DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS super_admins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
      CREATE INDEX IF NOT EXISTS idx_tenants_wa_phone ON tenants(wa_phone_number_id);
      CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
    `);

    // Seed plans
    await client.query(`
      INSERT INTO plans (id, name, max_doctors, max_appointments_per_month, price_monthly) VALUES
        ('starter',      'Starter',      3,    200,  0),
        ('growth',       'Growth',       10,   1000, 1999),
        ('professional', 'Professional', 25,   5000, 4999),
        ('enterprise',   'Enterprise',   999,  99999,9999)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed super admin
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('SuperAdmin@123', 12);
    await client.query(`
      INSERT INTO super_admins (email, password_hash, name)
      VALUES ('admin@medibook.com', $1, 'Super Admin')
      ON CONFLICT (email) DO NOTHING;
    `, [hash]);

    console.log('✅ Public schema migrations complete');
    console.log('✅ Plans seeded (starter, growth, professional, enterprise)');
    console.log('✅ Super admin created: admin@medibook.com / SuperAdmin@123');

  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => { console.error('Migration failed:', err); process.exit(1); });
```

### 2C. backend/src/db/tenantMigrate.js — creates schema for new tenant
```javascript
const { pool } = require('./index');

async function createTenantSchema(schemaName) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}"`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'staff',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS hospitals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        address TEXT,
        city VARCHAR(100),
        phone VARCHAR(20),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS doctors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
        department_id UUID REFERENCES departments(id),
        name VARCHAR(255) NOT NULL,
        specialization VARCHAR(255),
        qualification VARCHAR(255),
        consultation_fee INTEGER DEFAULT 0,
        slot_duration_minutes INTEGER DEFAULT 30,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS doctor_schedules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        is_working BOOLEAN DEFAULT true,
        UNIQUE(doctor_id, day_of_week)
      );

      CREATE TABLE IF NOT EXISTS time_slots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,
        hospital_id UUID REFERENCES hospitals(id),
        slot_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available','booked','blocked','expired')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(doctor_id, slot_date, start_time)
      );

      CREATE TABLE IF NOT EXISTS patients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(255),
        date_of_birth DATE,
        gender VARCHAR(20),
        email VARCHAR(255),
        visit_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_id VARCHAR(20) UNIQUE NOT NULL,
        patient_id UUID REFERENCES patients(id),
        doctor_id UUID REFERENCES doctors(id),
        hospital_id UUID REFERENCES hospitals(id),
        slot_id UUID REFERENCES time_slots(id),
        appointment_date DATE NOT NULL,
        appointment_time TIME NOT NULL,
        status VARCHAR(50) DEFAULT 'confirmed' CHECK (status IN ('confirmed','completed','cancelled','no_show')),
        cancellation_reason TEXT,
        visit_type VARCHAR(50) DEFAULT 'in_person',
        notes TEXT,
        reminder_24h_sent BOOLEAN DEFAULT false,
        reminder_2h_sent BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bot_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) NOT NULL,
        state VARCHAR(100) DEFAULT 'idle',
        context JSONB DEFAULT '{}',
        last_activity TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(phone)
      );

      CREATE TABLE IF NOT EXISTS wa_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) NOT NULL,
        direction VARCHAR(10) NOT NULL CHECK (direction IN ('in','out')),
        message_type VARCHAR(50),
        content TEXT,
        wa_message_id VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_slots_date_status ON time_slots(slot_date, status);
      CREATE INDEX IF NOT EXISTS idx_slots_doctor ON time_slots(doctor_id);
      CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(appointment_date);
      CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);
      CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id);
      CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
      CREATE INDEX IF NOT EXISTS idx_bot_sessions_phone ON bot_sessions(phone);
    `);

    console.log(`✅ Schema "${schemaName}" created successfully`);
  } finally {
    client.release();
  }
}

module.exports = { createTenantSchema };
```

### 2D. Run migration
```bash
cd backend && node src/db/migrate.js
```

**Verification:** Output shows all 3 ✅ lines.

---

## PHASE 3 — WHATSAPP CLOUD API SERVICE

### 3A. backend/src/services/whatsapp.js
```javascript
const axios = require('axios');
const logger = require('../utils/logger');

function getClient(accessToken, phoneNumberId) {
  const token = accessToken || process.env.META_ACCESS_TOKEN;
  const phoneId = phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  const base = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
  return { base, headers };
}

async function sendText(to, text, accessToken, phoneNumberId) {
  const { base, headers } = getClient(accessToken, phoneNumberId);
  try {
    await axios.post(base, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text }
    }, { headers });
  } catch (err) {
    logger.error('sendText failed', { to, error: err.response?.data || err.message });
    throw err;
  }
}

async function sendButtons(to, bodyText, buttons, accessToken, phoneNumberId) {
  // Max 3 buttons for WhatsApp
  const btns = buttons.slice(0, 3);
  const { base, headers } = getClient(accessToken, phoneNumberId);
  try {
    await axios.post(base, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: btns.map((b, i) => ({
            type: 'reply',
            reply: { id: `btn_${i}_${Date.now()}`, title: b.slice(0, 20) }
          }))
        }
      }
    }, { headers });
  } catch (err) {
    // Fallback to text if interactive fails
    const numbered = buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
    await sendText(to, `${bodyText}\n\n${numbered}`, accessToken, phoneNumberId);
  }
}

async function sendList(to, bodyText, buttonLabel, sections, accessToken, phoneNumberId) {
  const { base, headers } = getClient(accessToken, phoneNumberId);
  try {
    await axios.post(base, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: { button: buttonLabel.slice(0, 20), sections }
      }
    }, { headers });
  } catch (err) {
    // Fallback to text
    const lines = sections.flatMap(s =>
      s.rows.map((r, i) => `${i + 1}. ${r.title}`)
    );
    await sendText(to, `${bodyText}\n\n${lines.join('\n')}`, accessToken, phoneNumberId);
  }
}

async function sendTemplate(to, templateName, components = [], accessToken, phoneNumberId) {
  const { base, headers } = getClient(accessToken, phoneNumberId);
  try {
    await axios.post(base, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en' },
        components
      }
    }, { headers });
  } catch (err) {
    logger.error('sendTemplate failed', { to, templateName, error: err.response?.data || err.message });
    throw err;
  }
}

// Mark message as read
async function markRead(messageId, accessToken, phoneNumberId) {
  const { base, headers } = getClient(accessToken, phoneNumberId);
  const phoneId = phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneId}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers }
    );
  } catch (_) { /* non-critical */ }
}

module.exports = { sendText, sendButtons, sendList, sendTemplate, markRead };
```

### 3B. backend/src/utils/logger.js
```javascript
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

module.exports = logger;
```

### 3C. backend/src/utils/encryption.js
```javascript
const CryptoJS = require('crypto-js');

const KEY = process.env.ENCRYPTION_KEY || 'default-dev-key-32-chars-padding!';

function encrypt(text) {
  if (!text) return null;
  return CryptoJS.AES.encrypt(text, KEY).toString();
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const bytes = CryptoJS.AES.decrypt(ciphertext, KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

module.exports = { encrypt, decrypt };
```

---

## PHASE 4 — BOT ENGINE

### 4A. backend/src/services/botEngine.js
```javascript
const { tenantQuery, query } = require('../db');
const wa = require('./whatsapp');
const { decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');
const { format, addDays, parseISO } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');

const IST = 'Asia/Kolkata';

// ── STATE MACHINE ─────────────────────────────────────────────
const STATES = {
  IDLE: 'idle',
  MAIN_MENU: 'main_menu',
  SELECT_HOSPITAL: 'select_hospital',
  SELECT_VISIT_TYPE: 'select_visit_type',
  SELECT_DEPARTMENT: 'select_department',
  SELECT_DOCTOR: 'select_doctor',
  SELECT_DATE: 'select_date',
  SELECT_SLOT: 'select_slot',
  COLLECT_NAME: 'collect_name',
  COLLECT_DOB: 'collect_dob',
  COLLECT_GENDER: 'collect_gender',
  CONFIRM_BOOKING: 'confirm_booking',
  MY_APPOINTMENTS: 'my_appointments',
  RESCHEDULE_SELECT: 'reschedule_select',
  RESCHEDULE_DATE: 'reschedule_date',
  RESCHEDULE_SLOT: 'reschedule_slot',
  CANCEL_SELECT: 'cancel_select',
  CANCEL_CONFIRM: 'cancel_confirm',
};

async function getSession(schemaName, phone) {
  const r = await tenantQuery(schemaName,
    `SELECT * FROM bot_sessions WHERE phone = $1`, [phone]);
  if (r.rows.length === 0) {
    const ins = await tenantQuery(schemaName,
      `INSERT INTO bot_sessions (phone, state, context) VALUES ($1, $2, $3) RETURNING *`,
      [phone, STATES.IDLE, JSON.stringify({})]);
    return ins.rows[0];
  }
  return r.rows[0];
}

async function updateSession(schemaName, phone, state, context) {
  await tenantQuery(schemaName,
    `UPDATE bot_sessions SET state=$1, context=$2, last_activity=NOW() WHERE phone=$3`,
    [state, JSON.stringify(context), phone]);
}

async function getPatient(schemaName, phone) {
  const r = await tenantQuery(schemaName,
    `SELECT * FROM patients WHERE phone=$1`, [phone]);
  return r.rows[0] || null;
}

function genBookingId() {
  return 'MB' + Date.now().toString(36).toUpperCase().slice(-6);
}

// ── MAIN HANDLER ──────────────────────────────────────────────
async function handle({ phone, text, buttonId, tenant }) {
  if (!text && !buttonId) return;

  const schema = tenant.schema_name;
  const waToken = tenant.wa_access_token_enc ? decrypt(tenant.wa_access_token_enc) : null;
  const waPhoneId = tenant.wa_phone_number_id;

  const send = {
    text: (t) => wa.sendText(phone, t, waToken, waPhoneId),
    buttons: (t, btns) => wa.sendButtons(phone, t, btns, waToken, waPhoneId),
    list: (t, label, sections) => wa.sendList(phone, t, label, sections, waToken, waPhoneId),
  };

  const input = (text || '').trim();
  const lowerInput = input.toLowerCase();

  // Reset on "hi", "hello", "menu", "start"
  const isGreeting = /^(hi|hello|hey|menu|start|helo|hy)$/i.test(input);

  let session = await getSession(schema, phone);
  let ctx = typeof session.context === 'string'
    ? JSON.parse(session.context) : session.context;

  // ── GREETING → MAIN MENU ────────────────────────────────────
  if (isGreeting || session.state === STATES.IDLE) {
    const patient = await getPatient(schema, phone);
    const name = patient?.name ? `, ${patient.name.split(' ')[0]}` : '';

    await send.buttons(
      `👋 Welcome${name} to *${tenant.name}*!\n\nHow can I help you today?`,
      ['📅 Book Appointment', '🗓 My Appointments', 'ℹ️ Info & Help']
    );
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return;
  }

  // ── MAIN MENU ────────────────────────────────────────────────
  if (session.state === STATES.MAIN_MENU) {
    const choice = buttonId || lowerInput;
    if (choice.includes('book') || choice === '1' || /^btn_0/.test(choice)) {
      return handleBook(phone, schema, tenant, send, ctx, waToken, waPhoneId);
    }
    if (choice.includes('appointment') || choice === '2' || /^btn_1/.test(choice)) {
      return handleMyAppointments(phone, schema, tenant, send, ctx);
    }
    if (choice.includes('info') || choice === '3' || /^btn_2/.test(choice)) {
      await send.text(`ℹ️ *${tenant.name}*\n\nFor assistance, contact us or reply with any of:\n• *Book* — Book an appointment\n• *Status* — Check your appointments\n• *Hi* — Return to main menu`);
      return;
    }
    await send.text('Please select an option from the menu. Reply *Hi* to start over.');
    return;
  }

  // ── BOOKING FLOW ─────────────────────────────────────────────
  if ([STATES.SELECT_HOSPITAL, STATES.SELECT_VISIT_TYPE, STATES.SELECT_DEPARTMENT,
       STATES.SELECT_DOCTOR, STATES.SELECT_DATE, STATES.SELECT_SLOT,
       STATES.COLLECT_NAME, STATES.COLLECT_DOB, STATES.COLLECT_GENDER,
       STATES.CONFIRM_BOOKING].includes(session.state)) {
    return handleBookingStep(phone, schema, tenant, send, session.state, ctx, input, buttonId, waToken, waPhoneId);
  }

  // ── MY APPOINTMENTS FLOW ─────────────────────────────────────
  if ([STATES.MY_APPOINTMENTS, STATES.RESCHEDULE_SELECT, STATES.RESCHEDULE_DATE,
       STATES.RESCHEDULE_SLOT, STATES.CANCEL_SELECT, STATES.CANCEL_CONFIRM].includes(session.state)) {
    return handleAppointmentMgmt(phone, schema, tenant, send, session.state, ctx, input, buttonId);
  }

  // Fallback
  await send.text('Sorry, I didn\'t understand that. Reply *Hi* to start over.');
  await updateSession(schema, phone, STATES.IDLE, {});
}

// ── BOOKING FLOW STEPS ────────────────────────────────────────
async function handleBook(phone, schema, tenant, send, ctx, waToken, waPhoneId) {
  // Fetch hospitals
  const hospitals = await tenantQuery(schema,
    `SELECT id, name, city FROM hospitals WHERE is_active=true ORDER BY name`);

  if (hospitals.rows.length === 0) {
    await send.text('No dental clinics are currently available. Please try again later.');
    await tenantQuery(schema,
      `UPDATE bot_sessions SET state='idle' WHERE phone=$1`, [phone]);
    return;
  }

  if (hospitals.rows.length === 1) {
    ctx.hospital_id = hospitals.rows[0].id;
    ctx.hospital_name = hospitals.rows[0].name;
    return askVisitType(phone, schema, send, ctx);
  }

  const sections = [{
    title: 'Our Locations',
    rows: hospitals.rows.map(h => ({ id: h.id, title: h.name, description: h.city || '' }))
  }];
  await send.list('🦷 *Select a Dental Clinic/Branch*\n\nChoose your preferred location:', 'View Locations', sections);
  await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
    [STATES.SELECT_HOSPITAL, JSON.stringify(ctx), phone]);
}

async function askVisitType(phone, schema, send, ctx) {
  await send.buttons(
    '🦷 *Type of Visit*\n\nWhat type of dental consultation do you need?',
    ['🦷 In-Clinic Visit', '📱 Video Consultation']
  );
  await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
    [STATES.SELECT_VISIT_TYPE, JSON.stringify(ctx), phone]);
}

async function handleBookingStep(phone, schema, tenant, send, state, ctx, input, buttonId, waToken, waPhoneId) {
  const choice = buttonId || input;

  if (state === STATES.SELECT_HOSPITAL) {
    // Find hospital by id (from list reply) or name match
    const hospitals = await tenantQuery(schema,
      `SELECT id, name FROM hospitals WHERE is_active=true`);
    const h = hospitals.rows.find(r => r.id === choice || r.name.toLowerCase().includes(input.toLowerCase()));
    if (!h) {
      await send.text('Please select a location from the list.');
      return;
    }
    ctx.hospital_id = h.id;
    ctx.hospital_name = h.name;
    return askVisitType(phone, schema, send, ctx);
  }

  if (state === STATES.SELECT_VISIT_TYPE) {
    const isVideo = /video|online|digital|btn_1/i.test(choice);
    ctx.visit_type = isVideo ? 'video' : 'in_person';
    ctx.visit_label = isVideo ? 'Video Consultation' : 'In-Clinic Visit';

    // Fetch departments
    const depts = await tenantQuery(schema,
      `SELECT DISTINCT d.id, d.name FROM departments d
       JOIN doctors doc ON doc.department_id=d.id
       WHERE d.hospital_id=$1 AND d.is_active=true AND doc.is_active=true
       ORDER BY d.name`, [ctx.hospital_id]);

    if (depts.rows.length === 0) {
      await send.text('No dental services available right now. Please contact the clinic directly.');
      await tenantQuery(schema, `UPDATE bot_sessions SET state='idle' WHERE phone=$1`, [phone]);
      return;
    }

    if (depts.rows.length <= 3) {
      await send.buttons(
        '🦷 *Select Treatment Type*\n\nWhat dental service do you need?',
        depts.rows.map(d => d.name)
      );
    } else {
      const sections = [{ title: 'Dental Specialties', rows: depts.rows.map(d => ({ id: d.id, title: d.name })) }];
      await send.list('🦷 *Select Treatment Type*\n\nWhat dental service do you need?', 'View Services', sections);
    }
    await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
      [STATES.SELECT_DEPARTMENT, JSON.stringify({ ...ctx, _depts: depts.rows }), phone]);
    return;
  }

  if (state === STATES.SELECT_DEPARTMENT) {
    const depts = ctx._depts || [];
    const dept = depts.find(d => d.id === choice || d.name.toLowerCase().includes(input.toLowerCase()));
    if (!dept) {
      await send.text('Please select a specialty from the options.');
      return;
    }
    ctx.department_id = dept.id;
    ctx.department_name = dept.name;

    const doctors = await tenantQuery(schema,
      `SELECT id, name, qualification, consultation_fee FROM doctors
       WHERE department_id=$1 AND hospital_id=$2 AND is_active=true ORDER BY name`,
      [dept.id, ctx.hospital_id]);

    if (doctors.rows.length === 0) {
      await send.text(`No dentists available for ${dept.name}. Please choose another service.\n\nReply *Hi* to start over.`);
      return;
    }

    if (doctors.rows.length <= 3) {
      await send.buttons(
        `🦷 *Select Dentist*\n\nAvailable ${dept.name} dentists:`,
        doctors.rows.map(d => `Dr. ${d.name}`)
      );
    } else {
      const sections = [{
        title: `${dept.name} Dentists`,
        rows: doctors.rows.map(d => ({
          id: d.id,
          title: `Dr. ${d.name}`,
          description: `${d.qualification || ''} ${d.consultation_fee ? '• ₹' + d.consultation_fee : ''}`.trim()
        }))
      }];
      await send.list(`🦷 *Select Dentist*`, 'View Dentists', sections);
    }
    await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
      [STATES.SELECT_DOCTOR, JSON.stringify({ ...ctx, _doctors: doctors.rows }), phone]);
    return;
  }

  if (state === STATES.SELECT_DOCTOR) {
    const doctors = ctx._doctors || [];
    const doc = doctors.find(d =>
      d.id === choice ||
      `Dr. ${d.name}`.toLowerCase() === input.toLowerCase() ||
      d.name.toLowerCase().includes(input.toLowerCase().replace('dr.', '').trim())
    );
    if (!doc) {
      await send.text('Please select a doctor from the options.');
      return;
    }
    ctx.doctor_id = doc.id;
    ctx.doctor_name = doc.name;

    // Show next 7 days with available slots
    const today = toZonedTime(new Date(), IST);
    const dates = [];
    for (let i = 0; i < 14; i++) {
      const d = addDays(today, i + 1);
      const dateStr = format(d, 'yyyy-MM-dd');
      const count = await tenantQuery(schema,
        `SELECT COUNT(*) FROM time_slots WHERE doctor_id=$1 AND slot_date=$2 AND status='available'`,
        [doc.id, dateStr]);
      if (parseInt(count.rows[0].count) > 0) {
        dates.push({ date: dateStr, label: format(d, 'EEE, d MMM'), slots: count.rows[0].count });
        if (dates.length >= 7) break;
      }
    }

    if (dates.length === 0) {
      await send.text(`No available slots for Dr. ${doc.name} in the next 14 days.\n\nReply *Hi* to choose a different doctor.`);
      return;
    }

    const sections = [{
      title: 'Available Dates',
      rows: dates.map(d => ({ id: d.date, title: d.label, description: `${d.slots} slots available` }))
    }];
    await send.list(`📅 *Select Date*\n\nAvailable dates for Dr. ${doc.name}:`, 'Choose Date', sections);
    await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
      [STATES.SELECT_DATE, JSON.stringify(ctx), phone]);
    return;
  }

  if (state === STATES.SELECT_DATE) {
    // Accept date from list reply (YYYY-MM-DD) or text
    let dateStr = choice;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      await send.text('Please select a date from the options.');
      return;
    }
    ctx.appointment_date = dateStr;

    const slots = await tenantQuery(schema,
      `SELECT id, start_time, end_time FROM time_slots
       WHERE doctor_id=$1 AND slot_date=$2 AND status='available'
       ORDER BY start_time`, [ctx.doctor_id, dateStr]);

    if (slots.rows.length === 0) {
      await send.text('No slots left for that date. Please choose another date.\n\nReply *Hi* to restart.');
      return;
    }

    const sections = [{
      title: 'Available Slots',
      rows: slots.rows.map(s => ({
        id: s.id,
        title: s.start_time.slice(0, 5),
        description: `${s.start_time.slice(0,5)} - ${s.end_time.slice(0,5)}`
      }))
    }];
    await send.list(`⏰ *Select Time Slot*\n\nAvailable slots on ${format(parseISO(dateStr), 'EEE, d MMM')}:`, 'Choose Time', sections);
    await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
      [STATES.SELECT_SLOT, JSON.stringify({ ...ctx, _slots: slots.rows }), phone]);
    return;
  }

  if (state === STATES.SELECT_SLOT) {
    const slots = ctx._slots || [];
    const slot = slots.find(s => s.id === choice || s.start_time.slice(0,5) === input);
    if (!slot) {
      await send.text('Please select a time slot from the options.');
      return;
    }
    ctx.slot_id = slot.id;
    ctx.appointment_time = slot.start_time;

    // Check if returning patient
    const patient = await getPatient(schema, phone);
    if (patient && patient.name) {
      ctx.patient_id = patient.id;
      ctx.patient_name = patient.name;
      ctx.existing_patient = true;
      return showConfirmation(phone, schema, send, ctx);
    }

    // New patient — collect details
    await send.text(`👤 *Your Name*\n\nPlease enter your full name:`);
    await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
      [STATES.COLLECT_NAME, JSON.stringify(ctx), phone]);
    return;
  }

  if (state === STATES.COLLECT_NAME) {
    if (input.length < 2) {
      await send.text('Please enter your full name (at least 2 characters).');
      return;
    }
    ctx.patient_name = input;
    await send.text(`🎂 *Date of Birth*\n\nPlease enter your date of birth:\nFormat: DD/MM/YYYY\n\nExample: 15/08/1990`);
    await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
      [STATES.COLLECT_DOB, JSON.stringify(ctx), phone]);
    return;
  }

  if (state === STATES.COLLECT_DOB) {
    const dobMatch = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (!dobMatch) {
      await send.text('Invalid format. Please enter as DD/MM/YYYY\nExample: 15/08/1990');
      return;
    }
    const [_, d, m, y] = dobMatch;
    ctx.patient_dob = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    await send.buttons('👤 *Gender*', ['Male', 'Female', 'Other']);
    await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
      [STATES.COLLECT_GENDER, JSON.stringify(ctx), phone]);
    return;
  }

  if (state === STATES.COLLECT_GENDER) {
    const genderMap = { male: 'male', female: 'female', other: 'other', btn_0: 'male', btn_1: 'female', btn_2: 'other' };
    const gender = genderMap[lowerInput] || (choice.includes('btn_0') ? 'male' : choice.includes('btn_1') ? 'female' : 'other');
    ctx.patient_gender = gender;
    return showConfirmation(phone, schema, send, ctx);
  }

  if (state === STATES.CONFIRM_BOOKING) {
    const yes = /yes|confirm|ok|sure|haan|ha|btn_0/i.test(choice);
    const no = /no|cancel|nahi|nope|btn_1/i.test(choice);

    if (yes) {
      return completeBooking(phone, schema, tenant, send, ctx);
    }
    if (no) {
      await send.text('Booking cancelled. Reply *Hi* to start over anytime.');
      await tenantQuery(schema, `UPDATE bot_sessions SET state='idle', context='{}' WHERE phone=$1`, [phone]);
      return;
    }
    await send.buttons('Please confirm your booking:', ['✅ Confirm', '❌ Cancel']);
    return;
  }
}

async function showConfirmation(phone, schema, send, ctx) {
  const date = format(parseISO(ctx.appointment_date), 'EEEE, d MMMM yyyy');
  const time = ctx.appointment_time.slice(0, 5);
  const summary = `📋 *Booking Summary*\n\n` +
    `🦷 Clinic: ${ctx.hospital_name}\n` +
    `👨‍⚕️ Dentist: Dr. ${ctx.doctor_name}\n` +
    `🏷 Service: ${ctx.department_name}\n` +
    `📅 Date: ${date}\n` +
    `⏰ Time: ${time}\n` +
    `🩺 Type: ${ctx.visit_label}\n` +
    `👤 Patient: ${ctx.patient_name}\n\n` +
    `Confirm this booking?`;

  await send.buttons(summary, ['✅ Confirm', '❌ Cancel']);
  await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
    [STATES.CONFIRM_BOOKING, JSON.stringify(ctx), phone]);
}

async function completeBooking(phone, schema, tenant, send, ctx) {
  // Atomic slot lock
  const slotUpdate = await tenantQuery(schema,
    `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available' RETURNING id`,
    [ctx.slot_id]);

  if (slotUpdate.rows.length === 0) {
    await send.text('⚠️ Sorry, that slot was just taken. Please choose another time.\n\nReply *Hi* to start over.');
    await tenantQuery(schema, `UPDATE bot_sessions SET state='idle', context='{}' WHERE phone=$1`, [phone]);
    return;
  }

  // Upsert patient
  let patientId = ctx.patient_id;
  if (!patientId) {
    const patientRes = await tenantQuery(schema,
      `INSERT INTO patients (phone, name, date_of_birth, gender, visit_count)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (phone) DO UPDATE SET
         name=EXCLUDED.name, date_of_birth=EXCLUDED.date_of_birth,
         gender=EXCLUDED.gender, visit_count=patients.visit_count+1, updated_at=NOW()
       RETURNING id`,
      [phone, ctx.patient_name, ctx.patient_dob, ctx.patient_gender]);
    patientId = patientRes.rows[0].id;
  } else {
    await tenantQuery(schema,
      `UPDATE patients SET visit_count=visit_count+1, updated_at=NOW() WHERE id=$1`, [patientId]);
  }

  // Create appointment
  const bookingId = genBookingId();
  await tenantQuery(schema,
    `INSERT INTO appointments
     (booking_id, patient_id, doctor_id, hospital_id, slot_id, appointment_date, appointment_time, visit_type, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed')`,
    [bookingId, patientId, ctx.doctor_id, ctx.hospital_id, ctx.slot_id,
     ctx.appointment_date, ctx.appointment_time, ctx.visit_type || 'in_person']);

  const date = format(parseISO(ctx.appointment_date), 'EEE, d MMM yyyy');
  const time = ctx.appointment_time.slice(0, 5);

  await send.text(
    `✅ *Appointment Confirmed!*\n\n` +
    `Booking ID: *${bookingId}*\n` +
    `👨‍⚕️ Dr. ${ctx.doctor_name}\n` +
    `📅 ${date} at ${time}\n` +
    `🦷 ${ctx.hospital_name}\n\n` +
    `We'll send you a reminder 24 hours before your appointment.\n\n` +
    `Reply *Hi* to book another appointment.`
  );

  await tenantQuery(schema, `UPDATE bot_sessions SET state='idle', context='{}' WHERE phone=$1`, [phone]);
  logger.info(`Booking confirmed: ${bookingId} for ${phone} at ${tenant.name}`);
}

// ── MY APPOINTMENTS ───────────────────────────────────────────
async function handleMyAppointments(phone, schema, tenant, send, ctx) {
  const patient = await getPatient(schema, phone);
  if (!patient) {
    await send.text('No appointments found. Reply *Hi* to book your first appointment.');
    return;
  }

  const appts = await tenantQuery(schema,
    `SELECT a.booking_id, a.appointment_date, a.appointment_time, a.status,
            d.name as doctor_name, h.name as hospital_name
     FROM appointments a
     JOIN doctors d ON d.id=a.doctor_id
     JOIN hospitals h ON h.id=a.hospital_id
     WHERE a.patient_id=$1 AND a.appointment_date >= CURRENT_DATE
     ORDER BY a.appointment_date, a.appointment_time LIMIT 5`,
    [patient.id]);

  if (appts.rows.length === 0) {
    await send.text('No upcoming appointments found.\n\nReply *Hi* to book a new appointment.');
    return;
  }

  const list = appts.rows.map((a, i) =>
    `${i+1}. *${a.booking_id}*\n   Dr. ${a.doctor_name}\n   ${format(parseISO(a.appointment_date), 'd MMM')} at ${a.appointment_time.slice(0,5)}\n   Status: ${a.status}`
  ).join('\n\n');

  await send.buttons(
    `📅 *Your Upcoming Appointments*\n\n${list}\n\nWhat would you like to do?`,
    ['🔄 Reschedule', '❌ Cancel', '🏠 Main Menu']
  );
  await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
    [STATES.MY_APPOINTMENTS, JSON.stringify({ ...ctx, _appts: appts.rows, patient_id: patient.id }), phone]);
}

async function handleAppointmentMgmt(phone, schema, tenant, send, state, ctx, input, buttonId) {
  const choice = buttonId || input;

  if (state === STATES.MY_APPOINTMENTS) {
    if (/reschedule|btn_0/i.test(choice)) {
      await send.text('Enter the Booking ID you want to reschedule (e.g. MB12AB3):');
      await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
        [STATES.RESCHEDULE_SELECT, JSON.stringify(ctx), phone]);
      return;
    }
    if (/cancel|btn_1/i.test(choice)) {
      await send.text('Enter the Booking ID you want to cancel (e.g. MB12AB3):');
      await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
        [STATES.CANCEL_SELECT, JSON.stringify(ctx), phone]);
      return;
    }
    // Main menu
    await tenantQuery(schema, `UPDATE bot_sessions SET state='idle' WHERE phone=$1`, [phone]);
    const { handle } = require('./botEngine');
    return handle({ phone, text: 'hi', tenant });
  }

  // Reschedule / cancel flows simplified — get appointment, release slot, rebook
  if (state === STATES.CANCEL_SELECT) {
    const appt = await tenantQuery(schema,
      `SELECT a.*, d.name as doctor_name FROM appointments a JOIN doctors d ON d.id=a.doctor_id
       WHERE a.booking_id=$1 AND a.status='confirmed'`, [input.toUpperCase()]);
    if (!appt.rows[0]) {
      await send.text('Booking ID not found or already cancelled. Please check and try again.');
      return;
    }
    const a = appt.rows[0];
    ctx.cancel_appt_id = a.id;
    ctx.cancel_slot_id = a.slot_id;
    await send.buttons(
      `❌ *Cancel Appointment*\n\nBooking: ${a.booking_id}\nDr. ${a.doctor_name}\n${format(parseISO(a.appointment_date), 'd MMM')} at ${a.appointment_time.slice(0,5)}\n\nAre you sure?`,
      ['Yes, Cancel', 'No, Keep It']
    );
    await tenantQuery(schema, `UPDATE bot_sessions SET state=$1, context=$2 WHERE phone=$3`,
      [STATES.CANCEL_CONFIRM, JSON.stringify(ctx), phone]);
    return;
  }

  if (state === STATES.CANCEL_CONFIRM) {
    if (/yes|cancel|btn_0/i.test(choice)) {
      await tenantQuery(schema,
        `UPDATE appointments SET status='cancelled', updated_at=NOW() WHERE id=$1`, [ctx.cancel_appt_id]);
      await tenantQuery(schema,
        `UPDATE time_slots SET status='available' WHERE id=$1`, [ctx.cancel_slot_id]);
      await send.text('✅ Your appointment has been cancelled.\n\nReply *Hi* to book a new appointment anytime.');
    } else {
      await send.text('Your appointment is kept. Reply *Hi* for the main menu.');
    }
    await tenantQuery(schema, `UPDATE bot_sessions SET state='idle', context='{}' WHERE phone=$1`, [phone]);
    return;
  }
}

module.exports = { handle };
```

### 4B. Verification
After writing this file, do a syntax check:
```bash
cd backend && node -e "require('./src/services/botEngine'); console.log('botEngine OK')"
```

---

## PHASE 5 — API ROUTES

### 5A. backend/src/middleware/auth.js
```javascript
const jwt = require('jsonwebtoken');
const { query } = require('../db');

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

async function tenantMiddleware(req, res, next) {
  try {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return res.status(403).json({ error: 'No tenant' });
    const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [tenantId]);
    if (!r.rows[0]) return res.status(403).json({ error: 'Tenant not found' });
    req.tenant = r.rows[0];
    next();
  } catch (err) {
    res.status(500).json({ error: 'Tenant lookup failed' });
  }
}

module.exports = { authMiddleware, tenantMiddleware };
```

### 5B. backend/src/routes/webhook.js
```javascript
const router = require('express').Router();
const crypto = require('crypto');
const { query } = require('../db');
const botEngine = require('../services/botEngine');
const logger = require('../utils/logger');

// ── META WEBHOOK VERIFICATION ─────────────────────────────────
router.get('/webhook/whatsapp', (req, res) => {
  const mode  = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    logger.info('Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── INCOMING MESSAGES ─────────────────────────────────────────
router.post('/webhook/whatsapp', async (req, res) => {
  // Acknowledge immediately — Meta requires <3s response
  res.sendStatus(200);

  try {
    // Optional: verify Meta signature
    const sig = req.headers['x-hub-signature-256'];
    if (sig && process.env.META_APP_SECRET) {
      const expected = 'sha256=' + crypto
        .createHmac('sha256', process.env.META_APP_SECRET)
        .update(JSON.stringify(req.body))
        .digest('hex');
      if (sig !== expected) {
        logger.warn('Invalid Meta signature');
        return;
      }
    }

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Status updates (delivered, read) — ignore
    if (value?.statuses) return;
    if (!value?.messages) return;

    const msg = value.messages[0];
    const phone = msg.from; // e.g. "919876543210"
    const toNumber = value.metadata?.display_phone_number;

    let text = '';
    let buttonId = null;

    if (msg.type === 'text') {
      text = msg.text?.body || '';
    } else if (msg.type === 'interactive') {
      const interactive = msg.interactive;
      if (interactive.type === 'button_reply') {
        buttonId = interactive.button_reply.id;
        text = interactive.button_reply.title;
      } else if (interactive.type === 'list_reply') {
        buttonId = interactive.list_reply.id;
        text = interactive.list_reply.title;
      }
    } else if (msg.type === 'button') {
      text = msg.button?.text || '';
    }

    if (!text && !buttonId) return;

    // Find tenant by phone number ID
    const phoneNumberId = value.metadata?.phone_number_id;
    let tenant = null;

    if (phoneNumberId) {
      const r = await query(
        `SELECT * FROM tenants WHERE wa_phone_number_id=$1 AND status='active'`,
        [phoneNumberId]);
      tenant = r.rows[0];
    }

    // Dev fallback — use first active tenant
    if (!tenant && process.env.NODE_ENV !== 'production') {
      const r = await query(`SELECT * FROM tenants WHERE status='active' LIMIT 1`);
      tenant = r.rows[0];
    }

    if (!tenant) {
      logger.warn(`No tenant for phone_number_id: ${phoneNumberId}`);
      return;
    }

    await botEngine.handle({ phone, text, buttonId, tenant });

  } catch (err) {
    logger.error('Webhook handler error', { error: err.message, stack: err.stack });
  }
});

// ── DEV TEST ENDPOINT ─────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  router.post('/webhook/test', async (req, res) => {
    const { phone = '919999999999', message = 'Hi', button_id } = req.body;
    try {
      const r = await query(`SELECT * FROM tenants WHERE status='active' LIMIT 1`);
      if (!r.rows[0]) return res.status(400).json({ error: 'No tenants found. Run seed first.' });

      // Intercept outgoing messages for test response
      const responses = [];
      const wa = require('../services/whatsapp');
      const origText = wa.sendText;
      const origBtns = wa.sendButtons;
      const origList = wa.sendList;

      wa.sendText = async (to, text) => { responses.push({ type: 'text', text }); };
      wa.sendButtons = async (to, text, btns) => { responses.push({ type: 'buttons', text, buttons: btns }); };
      wa.sendList = async (to, text, label, sections) => { responses.push({ type: 'list', text, label, sections }); };

      await botEngine.handle({ phone, text: message, buttonId: button_id, tenant: r.rows[0] });

      wa.sendText = origText;
      wa.sendButtons = origBtns;
      wa.sendList = origList;

      res.json({ phone, message, responses });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = router;
```

### 5C. backend/src/routes/auth.js
```javascript
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, tenantQuery } = require('../db');

// Super admin login
router.post('/auth/superadmin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await query(`SELECT * FROM super_admins WHERE email=$1`, [email]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: r.rows[0].id, email, role: 'super_admin' },
      process.env.JWT_SECRET, { expiresIn: '24h' }
    );
    res.json({ token, user: { email, role: 'super_admin', name: r.rows[0].name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tenant admin login
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password, tenant_slug } = req.body;
    const tenantR = await query(`SELECT * FROM tenants WHERE slug=$1 AND status='active'`, [tenant_slug]);
    if (!tenantR.rows[0]) return res.status(404).json({ error: 'Clinic not found' });
    const tenant = tenantR.rows[0];
    const userR = await tenantQuery(tenant.schema_name,
      `SELECT * FROM users WHERE email=$1 AND is_active=true`, [email]);
    if (!userR.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, userR.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: userR.rows[0].id, email, role: userR.rows[0].role, tenant_id: tenant.id, tenant_slug },
      process.env.JWT_SECRET, { expiresIn: '24h' }
    );
    res.json({ token, user: { email, role: userR.rows[0].role, name: userR.rows[0].name, tenant: tenant.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

### 5D. backend/src/routes/admin.js
```javascript
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, tenantQuery } = require('../db');
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const adminLimiter = rateLimit({ windowMs: 60*1000, max: 120 });
router.use(adminLimiter);
router.use(authMiddleware);
router.use(tenantMiddleware);

// ── DASHBOARD ─────────────────────────────────────────────────
router.get('/admin/dashboard', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const [todayAppts, totalPatients, upcomingAppts, availableSlots] = await Promise.all([
      tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date=CURRENT_DATE AND status='confirmed'`),
      tenantQuery(s, `SELECT COUNT(*) FROM patients`),
      tenantQuery(s, `SELECT COUNT(*) FROM appointments WHERE appointment_date>CURRENT_DATE AND status='confirmed'`),
      tenantQuery(s, `SELECT COUNT(*) FROM time_slots WHERE slot_date>=CURRENT_DATE AND status='available'`),
    ]);
    res.json({
      today_appointments: parseInt(todayAppts.rows[0].count),
      total_patients: parseInt(totalPatients.rows[0].count),
      upcoming_appointments: parseInt(upcomingAppts.rows[0].count),
      available_slots: parseInt(availableSlots.rows[0].count),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── APPOINTMENTS ──────────────────────────────────────────────
router.get('/admin/appointments', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const { date, status, page = 1, limit = 20 } = req.query;
    let where = ['1=1'];
    let params = [];
    if (date) { params.push(date); where.push(`a.appointment_date=$${params.length}`); }
    if (status) { params.push(status); where.push(`a.status=$${params.length}`); }
    params.push(parseInt(limit), (parseInt(page)-1)*parseInt(limit));
    const r = await tenantQuery(s, `
      SELECT a.*, p.name as patient_name, p.phone as patient_phone,
             d.name as doctor_name, h.name as hospital_name
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      JOIN hospitals h ON h.id=a.hospital_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.appointment_date DESC, a.appointment_time DESC
      LIMIT $${params.length-1} OFFSET $${params.length}
    `, params);
    res.json({ appointments: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DOCTORS ───────────────────────────────────────────────────
router.get('/admin/doctors', async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name, `
      SELECT d.*, dep.name as department_name, h.name as hospital_name,
             (SELECT COUNT(*) FROM appointments a WHERE a.doctor_id=d.id AND a.status='confirmed') as total_appointments
      FROM doctors d
      LEFT JOIN departments dep ON dep.id=d.department_id
      LEFT JOIN hospitals h ON h.id=d.hospital_id
      WHERE d.is_active=true ORDER BY d.name
    `);
    res.json({ doctors: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/admin/doctors', async (req, res) => {
  try {
    const { name, specialization, qualification, department_id, hospital_id,
            consultation_fee, slot_duration_minutes } = req.body;
    const r = await tenantQuery(req.tenant.schema_name, `
      INSERT INTO doctors (name, specialization, qualification, department_id, hospital_id, consultation_fee, slot_duration_minutes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [name, specialization, qualification, department_id, hospital_id, consultation_fee || 0, slot_duration_minutes || 30]);
    res.json({ doctor: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Doctor schedule
router.post('/admin/doctors/:id/schedule', async (req, res) => {
  try {
    const { schedules } = req.body; // [{day_of_week, start_time, end_time, is_working}]
    for (const s of schedules) {
      await tenantQuery(req.tenant.schema_name, `
        INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (doctor_id, day_of_week) DO UPDATE SET
          start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, is_working=EXCLUDED.is_working
      `, [req.params.id, s.day_of_week, s.start_time, s.end_time, s.is_working]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── HOSPITALS ─────────────────────────────────────────────────
router.get('/admin/hospitals', async (req, res) => {
  try {
    const r = await tenantQuery(req.tenant.schema_name,
      `SELECT * FROM hospitals WHERE is_active=true ORDER BY name`);
    res.json({ hospitals: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/admin/hospitals', async (req, res) => {
  try {
    const { name, address, city, phone } = req.body;
    const r = await tenantQuery(req.tenant.schema_name,
      `INSERT INTO hospitals (name, address, city, phone) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, address, city, phone]);
    res.json({ hospital: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ANALYTICS ─────────────────────────────────────────────────
router.get('/admin/analytics', async (req, res) => {
  try {
    const s = req.tenant.schema_name;
    const [byDay, byDoctor, byStatus] = await Promise.all([
      tenantQuery(s, `
        SELECT appointment_date::text as date, COUNT(*) as count
        FROM appointments WHERE appointment_date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY appointment_date ORDER BY appointment_date
      `),
      tenantQuery(s, `
        SELECT d.name, COUNT(a.id) as count
        FROM appointments a JOIN doctors d ON d.id=a.doctor_id
        WHERE a.created_at >= NOW() - INTERVAL '30 days'
        GROUP BY d.name ORDER BY count DESC LIMIT 10
      `),
      tenantQuery(s, `
        SELECT status, COUNT(*) as count FROM appointments
        WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY status
      `),
    ]);
    res.json({ by_day: byDay.rows, by_doctor: byDoctor.rows, by_status: byStatus.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATIENTS ──────────────────────────────────────────────────
router.get('/admin/patients', async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    let sql = `SELECT * FROM patients`;
    let params = [];
    if (search) { params.push(`%${search}%`); sql += ` WHERE name ILIKE $1 OR phone LIKE $1`; }
    params.push(20, (parseInt(page)-1)*20);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`;
    const r = await tenantQuery(req.tenant.schema_name, sql, params);
    res.json({ patients: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
```

### 5E. backend/src/routes/superadmin.js
```javascript
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, tenantQuery } = require('../db');
const { createTenantSchema } = require('../db/tenantMigrate');
const { authMiddleware } = require('../middleware/auth');
const { encrypt } = require('../utils/encryption');

function superAdminOnly(req, res, next) {
  if (req.user?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

router.use(authMiddleware, superAdminOnly);

// List tenants
router.get('/superadmin/tenants', async (req, res) => {
  try {
    const r = await query(`SELECT t.*, p.name as plan_name FROM tenants t LEFT JOIN plans p ON p.id=t.plan ORDER BY t.created_at DESC`);
    res.json({ tenants: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create tenant
router.post('/superadmin/tenants', async (req, res) => {
  try {
    const { name, slug, owner_email, owner_password, plan, wa_phone_number_id, wa_access_token } = req.body;
    const schema = 'tenant_' + slug.replace(/-/g, '_');

    // Create public record
    const waTokenEnc = wa_access_token ? encrypt(wa_access_token) : null;
    const r = await query(`
      INSERT INTO tenants (name, slug, schema_name, owner_email, plan, wa_phone_number_id, wa_access_token_enc)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [name, slug, schema, owner_email, plan || 'starter', wa_phone_number_id, waTokenEnc]);
    const tenant = r.rows[0];

    // Create schema
    await createTenantSchema(schema);

    // Create admin user in tenant schema
    const hash = await bcrypt.hash(owner_password || 'Admin@123456', 12);
    await tenantQuery(schema, `
      INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,'admin')
    `, [owner_email, hash, name + ' Admin']);

    res.json({ tenant, message: `Tenant created. Admin login: ${owner_email}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update tenant
router.patch('/superadmin/tenants/:id', async (req, res) => {
  try {
    const { status, plan, wa_phone_number_id, wa_access_token } = req.body;
    const updates = [];
    const params = [];
    if (status) { params.push(status); updates.push(`status=$${params.length}`); }
    if (plan) { params.push(plan); updates.push(`plan=$${params.length}`); }
    if (wa_phone_number_id) { params.push(wa_phone_number_id); updates.push(`wa_phone_number_id=$${params.length}`); }
    if (wa_access_token) { params.push(encrypt(wa_access_token)); updates.push(`wa_access_token_enc=$${params.length}`); }
    if (!updates.length) return res.json({ message: 'Nothing to update' });
    params.push(req.params.id);
    await query(`UPDATE tenants SET ${updates.join(',')} WHERE id=$${params.length}`, params);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stats
router.get('/superadmin/stats', async (req, res) => {
  try {
    const tenants = await query(`SELECT COUNT(*) FROM tenants`);
    const active = await query(`SELECT COUNT(*) FROM tenants WHERE status='active'`);
    res.json({ total_tenants: parseInt(tenants.rows[0].count), active_tenants: parseInt(active.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
```

### 5F. backend/src/routes/slots.js
```javascript
const router = require('express').Router();
const { tenantQuery } = require('../db');
const { authMiddleware, tenantMiddleware } = require('../middleware/auth');
const { addDays, format } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');

router.use(authMiddleware, tenantMiddleware);

// Generate slots for a doctor
router.post('/admin/slots/generate', async (req, res) => {
  try {
    const { doctor_id, days = 60 } = req.body;
    const s = req.tenant.schema_name;
    const doctor = await tenantQuery(s, `SELECT * FROM doctors WHERE id=$1`, [doctor_id]);
    if (!doctor.rows[0]) return res.status(404).json({ error: 'Doctor not found' });

    const schedules = await tenantQuery(s,
      `SELECT * FROM doctor_schedules WHERE doctor_id=$1 AND is_working=true`, [doctor_id]);
    if (!schedules.rows.length) return res.status(400).json({ error: 'No schedule set for doctor' });

    const docInfo = doctor.rows[0];
    const duration = docInfo.slot_duration_minutes || 30;
    const ist = 'Asia/Kolkata';
    const today = toZonedTime(new Date(), ist);
    let generated = 0;

    for (let i = 1; i <= days; i++) {
      const date = addDays(today, i);
      const dow = date.getDay();
      const sched = schedules.rows.find(s => s.day_of_week === dow);
      if (!sched) continue;

      const dateStr = format(date, 'yyyy-MM-dd');
      const [sh, sm] = sched.start_time.split(':').map(Number);
      const [eh, em] = sched.end_time.split(':').map(Number);
      let cur = sh * 60 + sm;
      const end = eh * 60 + em;

      while (cur + duration <= end) {
        const st = `${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}`;
        const et = `${String(Math.floor((cur+duration)/60)).padStart(2,'0')}:${String((cur+duration)%60).padStart(2,'0')}`;
        await tenantQuery(s, `
          INSERT INTO time_slots (doctor_id, hospital_id, slot_date, start_time, end_time, status)
          VALUES ($1,$2,$3,$4,$5,'available') ON CONFLICT (doctor_id, slot_date, start_time) DO NOTHING
        `, [doctor_id, docInfo.hospital_id, dateStr, st, et]);
        cur += duration;
        generated++;
      }
    }
    res.json({ generated, days, doctor_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
```

---

## PHASE 6 — JOBS & CRONS

### 6A. backend/src/jobs/slotGenerator.js
```javascript
const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const { addDays, format } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');
const logger = require('../utils/logger');

async function generateSlotsForTenant(schema) {
  const doctors = await tenantQuery(schema,
    `SELECT d.*, s.day_of_week, s.start_time, s.end_time
     FROM doctors d
     JOIN doctor_schedules s ON s.doctor_id=d.id
     WHERE d.is_active=true AND s.is_working=true`);

  const ist = 'Asia/Kolkata';
  const today = toZonedTime(new Date(), ist);
  let count = 0;

  const doctorMap = {};
  for (const row of doctors.rows) {
    if (!doctorMap[row.id]) {
      doctorMap[row.id] = { ...row, schedules: [] };
    }
    doctorMap[row.id].schedules.push({
      day: row.day_of_week, start: row.start_time, end: row.end_time
    });
  }

  for (const [did, doc] of Object.entries(doctorMap)) {
    const duration = doc.slot_duration_minutes || 30;
    for (let i = 1; i <= 60; i++) {
      const date = addDays(today, i);
      const dow = date.getDay();
      const sched = doc.schedules.find(s => s.day === dow);
      if (!sched) continue;
      const dateStr = format(date, 'yyyy-MM-dd');
      const [sh, sm] = sched.start.split(':').map(Number);
      const [eh, em] = sched.end.split(':').map(Number);
      let cur = sh * 60 + sm;
      const end = eh * 60 + em;
      while (cur + duration <= end) {
        const st = `${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}`;
        const et = `${String(Math.floor((cur+duration)/60)).padStart(2,'0')}:${String((cur+duration)%60).padStart(2,'0')}`;
        await tenantQuery(schema, `
          INSERT INTO time_slots (doctor_id, hospital_id, slot_date, start_time, end_time, status)
          VALUES ($1,$2,$3,$4,$5,'available') ON CONFLICT (doctor_id, slot_date, start_time) DO NOTHING
        `, [did, doc.hospital_id, dateStr, st, et]);
        cur += duration;
        count++;
      }
    }
  }
  return count;
}

function startSlotGeneratorCron() {
  // Run at 11:30 PM IST (18:00 UTC)
  cron.schedule('0 18 * * *', async () => {
    logger.info('Starting nightly slot generation...');
    try {
      const tenants = await query(`SELECT * FROM tenants WHERE status='active'`);
      let total = 0;
      for (const tenant of tenants.rows) {
        try {
          const n = await generateSlotsForTenant(tenant.schema_name);
          total += n;
        } catch (err) {
          logger.error(`Slot gen failed for ${tenant.name}`, { error: err.message });
        }
      }
      logger.info(`Slot generation complete: ${total} slots across ${tenants.rows.length} tenants`);
    } catch (err) {
      logger.error('Slot generation cron error', { error: err.message });
    }
  });
  logger.info('Slot generator cron registered (11:30 PM IST daily)');
}

module.exports = { startSlotGeneratorCron, generateSlotsForTenant };
```

### 6B. backend/src/jobs/reminders.js
```javascript
const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const wa = require('../services/whatsapp');
const { decrypt } = require('../utils/encryption');
const { format, parseISO } = require('date-fns');
const logger = require('../utils/logger');

async function sendReminders() {
  const tenants = await query(`SELECT * FROM tenants WHERE status='active'`);

  for (const tenant of tenants.rows) {
    const waToken = tenant.wa_access_token_enc ? decrypt(tenant.wa_access_token_enc) : null;
    const waPhoneId = tenant.wa_phone_number_id;
    if (!waToken || !waPhoneId) continue;

    try {
      // 24-hour reminders
      const r24 = await tenantQuery(tenant.schema_name, `
        SELECT a.*, p.phone, p.name as patient_name, d.name as doctor_name, h.name as hospital_name
        FROM appointments a
        JOIN patients p ON p.id=a.patient_id
        JOIN doctors d ON d.id=a.doctor_id
        JOIN hospitals h ON h.id=a.hospital_id
        WHERE a.status='confirmed' AND a.reminder_24h_sent=false
          AND a.appointment_date = CURRENT_DATE + INTERVAL '1 day'
      `);

      for (const appt of r24.rows) {
        try {
          await wa.sendText(appt.phone,
            `🔔 *Appointment Reminder*\n\nYou have an appointment tomorrow!\n\n` +
            `👨‍⚕️ Dr. ${appt.doctor_name}\n` +
            `📅 ${format(parseISO(appt.appointment_date), 'EEE, d MMM')} at ${appt.appointment_time.slice(0,5)}\n` +
            `🦷 ${appt.hospital_name}\n\n` +
            `Reply *Hi* to reschedule or cancel.`,
            waToken, waPhoneId
          );
          await tenantQuery(tenant.schema_name,
            `UPDATE appointments SET reminder_24h_sent=true WHERE id=$1`, [appt.id]);
        } catch (err) {
          logger.error(`24h reminder failed for ${appt.booking_id}`, { error: err.message });
        }
      }

      // 2-hour reminders
      const r2 = await tenantQuery(tenant.schema_name, `
        SELECT a.*, p.phone, p.name as patient_name, d.name as doctor_name
        FROM appointments a
        JOIN patients p ON p.id=a.patient_id
        JOIN doctors d ON d.id=a.doctor_id
        WHERE a.status='confirmed' AND a.reminder_2h_sent=false
          AND a.appointment_date=CURRENT_DATE
          AND (a.appointment_time - INTERVAL '2 hours') <= (CURRENT_TIME AT TIME ZONE 'Asia/Kolkata')
          AND a.appointment_time > (CURRENT_TIME AT TIME ZONE 'Asia/Kolkata')
      `);

      for (const appt of r2.rows) {
        try {
          await wa.sendText(appt.phone,
            `⏰ *2-Hour Reminder*\n\nYour appointment is in 2 hours!\n\n` +
            `👨‍⚕️ Dr. ${appt.doctor_name} at ${appt.appointment_time.slice(0,5)}\n\n` +
            `Please arrive 10 minutes early with any relevant reports.`,
            waToken, waPhoneId
          );
          await tenantQuery(tenant.schema_name,
            `UPDATE appointments SET reminder_2h_sent=true WHERE id=$1`, [appt.id]);
        } catch (err) {
          logger.error(`2h reminder failed for ${appt.booking_id}`, { error: err.message });
        }
      }

    } catch (err) {
      logger.error(`Reminder sweep failed for tenant ${tenant.name}`, { error: err.message });
    }
  }
}

function startReminderCron() {
  cron.schedule('0 * * * *', async () => {
    try { await sendReminders(); } catch (err) {
      logger.error('Reminder cron error', { error: err.message });
    }
  });
  logger.info('Reminder cron registered (hourly)');
}

module.exports = { startReminderCron, sendReminders };
```

---

## PHASE 7 — MAIN SERVER

### 7A. backend/src/index.js
```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3001;

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Rate limits
const globalLimiter = rateLimit({ windowMs: 60*1000, max: 500, standardHeaders: true });
const webhookLimiter = rateLimit({ windowMs: 60*1000, max: 1000 });
app.use('/api', globalLimiter);
app.use('/api/webhook', webhookLimiter);

// ── ROUTES ────────────────────────────────────────────────────
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/webhook'));
app.use('/api', require('./routes/admin'));
app.use('/api', require('./routes/superadmin'));
app.use('/api', require('./routes/slots'));

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { pool } = require('./db');
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'medibook-api' });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  logger.info(`MediBook API running on port ${PORT}`);
  if (process.env.NODE_ENV !== 'test') {
    const { startSlotGeneratorCron } = require('./jobs/slotGenerator');
    const { startReminderCron } = require('./jobs/reminders');
    startSlotGeneratorCron();
    startReminderCron();
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  server.close(() => {
    require('./db').pool.end();
    logger.info('Server closed');
    process.exit(0);
  });
});

module.exports = app;
```

### 7B. Verify backend starts
```bash
cd backend && npm run dev
```
Check logs show: "MediBook API running on port 3001" and both crons registered.
Then test health:
```bash
curl http://localhost:3001/health
```
Expected: `{"status":"ok",...}`

---

## PHASE 8 — FRONTEND

### 8A. frontend/src/app/layout.js
```javascript
import { Inter } from 'next/font/google'
import './globals.css'
import { Toaster } from 'react-hot-toast'

const inter = Inter({ subsets: ['latin'] })

export const metadata = { title: 'MediBook Admin', description: 'Dental Clinic WhatsApp Appointment Management' }

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Toaster position="top-right" />
        {children}
      </body>
    </html>
  )
}
```

### 8B. frontend/src/app/globals.css
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

### 8C. frontend/src/lib/api.js
```javascript
import axios from 'axios'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

const api = axios.create({ baseURL: `${API_URL}/api` })

api.interceptors.request.use(config => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.clear()
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default api
```

### 8D. frontend/src/app/login/page.js
```javascript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import api from '@/lib/api'
import toast from 'react-hot-toast'

export default function LoginPage() {
  const router = useRouter()
  const [form, setForm] = useState({ email: '', password: '', tenant_slug: '' })
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleLogin(e) {
    e.preventDefault()
    setLoading(true)
    try {
      const endpoint = isSuperAdmin ? '/auth/superadmin/login' : '/auth/login'
      const payload = isSuperAdmin
        ? { email: form.email, password: form.password }
        : { email: form.email, password: form.password, tenant_slug: form.tenant_slug }
      const { data } = await api.post(endpoint, payload)
      localStorage.setItem('token', data.token)
      localStorage.setItem('user', JSON.stringify(data.user))
      toast.success(`Welcome, ${data.user.name || data.user.email}!`)
      router.push(isSuperAdmin ? '/superadmin' : '/dashboard')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">🦷</div>
          <h1 className="text-2xl font-bold text-gray-900">MediBook</h1>
          <p className="text-gray-500 text-sm mt-1">Dental Clinic WhatsApp Booking</p>
        </div>

        <div className="flex rounded-lg bg-gray-100 p-1 mb-6">
          <button onClick={() => setIsSuperAdmin(false)}
            className={`flex-1 py-2 rounded-md text-sm font-medium transition-all ${!isSuperAdmin ? 'bg-white shadow text-blue-600' : 'text-gray-500'}`}>
            Clinic Admin
          </button>
          <button onClick={() => setIsSuperAdmin(true)}
            className={`flex-1 py-2 rounded-md text-sm font-medium transition-all ${isSuperAdmin ? 'bg-white shadow text-blue-600' : 'text-gray-500'}`}>
            Super Admin
          </button>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          {!isSuperAdmin && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Clinic ID</label>
              <input value={form.tenant_slug} onChange={e => setForm({...form, tenant_slug: e.target.value})}
                placeholder="e.g. demo-clinic"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})}
              placeholder="admin@example.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input type="password" value={form.password} onChange={e => setForm({...form, password: e.target.value})}
              placeholder="••••••••"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" required />
          </div>
          <button type="submit" disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50">
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className="text-center text-xs text-gray-400 mt-6">
          Super Admin: admin@medibook.com / SuperAdmin@123
        </p>
      </div>
    </div>
  )
}
```

### 8E. frontend/src/app/dashboard/page.js
```javascript
'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import api from '@/lib/api'
import toast from 'react-hot-toast'
import { format } from 'date-fns'

const NAV = [
  { id: 'overview', label: 'Overview', icon: '📊' },
  { id: 'appointments', label: 'Appointments', icon: '📅' },
  { id: 'doctors', label: 'Dentists', icon: '🦷' },
  { id: 'patients', label: 'Patients', icon: '👥' },
  { id: 'analytics', label: 'Analytics', icon: '📈' },
]

function StatCard({ label, value, icon, color }) {
  return (
    <div className={`bg-white rounded-xl p-5 border-l-4 ${color} shadow-sm`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">{label}</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">{value ?? '—'}</p>
        </div>
        <span className="text-3xl">{icon}</span>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const router = useRouter()
  const [tab, setTab] = useState('overview')
  const [stats, setStats] = useState(null)
  const [appointments, setAppointments] = useState([])
  const [doctors, setDoctors] = useState([])
  const [patients, setPatients] = useState([])
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('token')
    const u = localStorage.getItem('user')
    if (!token) { router.push('/login'); return; }
    setUser(u ? JSON.parse(u) : null)
    fetchStats()
  }, [])

  useEffect(() => {
    if (tab === 'appointments') fetchAppointments()
    if (tab === 'doctors') fetchDoctors()
    if (tab === 'patients') fetchPatients()
  }, [tab])

  async function fetchStats() {
    try {
      const { data } = await api.get('/admin/dashboard')
      setStats(data)
    } catch { toast.error('Failed to load stats') }
    finally { setLoading(false) }
  }

  async function fetchAppointments() {
    try {
      const { data } = await api.get('/admin/appointments?limit=50')
      setAppointments(data.appointments || [])
    } catch { toast.error('Failed to load appointments') }
  }

  async function fetchDoctors() {
    try {
      const { data } = await api.get('/admin/doctors')
      setDoctors(data.doctors || [])
    } catch { toast.error('Failed to load doctors') }
  }

  async function fetchPatients() {
    try {
      const { data } = await api.get('/admin/patients')
      setPatients(data.patients || [])
    } catch { toast.error('Failed to load patients') }
  }

  function exportCSV() {
    if (!appointments.length) return toast.error('No appointments to export')
    const headers = ['Booking ID','Patient','Phone','Doctor','Date','Time','Status']
    const rows = appointments.map(a => [
      a.booking_id, a.patient_name, a.patient_phone,
      `Dr. ${a.doctor_name}`,
      a.appointment_date, a.appointment_time?.slice(0,5), a.status
    ])
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `appointments_${format(new Date(),'yyyyMMdd')}.csv`
    a.click()
    toast.success('CSV downloaded!')
  }

  function logout() {
    localStorage.clear()
    router.push('/login')
  }

  const statusColor = (s) => ({
    confirmed: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-700',
    completed: 'bg-blue-100 text-blue-700',
    no_show: 'bg-gray-100 text-gray-600',
  }[s] || 'bg-gray-100 text-gray-600')

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-5 border-b border-gray-100">
          <div className="text-xl font-bold text-blue-600">🦷 MediBook</div>
          <div className="text-xs text-gray-400 mt-1">{user?.tenant || 'Admin Portal'}</div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map(item => (
            <button key={item.id} onClick={() => setTab(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${tab === item.id ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}>
              <span>{item.icon}</span> {item.label}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-100">
          <button onClick={logout} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-500 hover:text-red-500 transition-colors">
            <span>🚪</span> Sign Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">
            {NAV.find(n => n.id === tab)?.label || 'Dashboard'}
          </h1>
          <div className="text-sm text-gray-500">
            {user?.name || user?.email}
          </div>
        </header>

        <div className="p-6">
          {/* OVERVIEW */}
          {tab === 'overview' && (
            <div className="space-y-6">
              {loading ? (
                <div className="text-center text-gray-400 py-12">Loading...</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatCard label="Today's Appointments" value={stats?.today_appointments} icon="📅" color="border-blue-500" />
                    <StatCard label="Upcoming" value={stats?.upcoming_appointments} icon="🗓" color="border-green-500" />
                    <StatCard label="Total Patients" value={stats?.total_patients} icon="👥" color="border-purple-500" />
                    <StatCard label="Available Slots" value={stats?.available_slots} icon="⏰" color="border-orange-500" />
                  </div>
                  <div className="bg-white rounded-xl p-5 shadow-sm">
                    <h3 className="font-semibold text-gray-800 mb-3">Quick Actions</h3>
                    <div className="flex gap-3 flex-wrap">
                      <button onClick={() => setTab('appointments')} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition">View Appointments</button>
                      <button onClick={() => setTab('doctors')} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition">Manage Dentists</button>
                      <button onClick={() => { setTab('appointments'); setTimeout(exportCSV, 500); }} className="px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition">Export CSV</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* APPOINTMENTS */}
          {tab === 'appointments' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">{appointments.length} appointments loaded</p>
                <button onClick={exportCSV} className="px-4 py-2 border border-gray-300 text-sm rounded-lg hover:bg-gray-50 flex items-center gap-2">
                  📥 Export CSV
                </button>
              </div>
              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        {['Booking ID','Patient','Doctor','Date','Time','Status'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {appointments.map(a => (
                        <tr key={a.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-mono text-xs font-medium">{a.booking_id}</td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-gray-900">{a.patient_name}</div>
                            <a href={`https://wa.me/${a.patient_phone}`} target="_blank" className="text-xs text-green-600 hover:underline">{a.patient_phone}</a>
                          </td>
                          <td className="px-4 py-3 text-gray-700">Dr. {a.doctor_name}</td>
                          <td className="px-4 py-3 text-gray-600">{a.appointment_date}</td>
                          <td className="px-4 py-3 text-gray-600">{a.appointment_time?.slice(0,5)}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColor(a.status)}`}>{a.status}</span>
                          </td>
                        </tr>
                      ))}
                      {!appointments.length && (
                        <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No appointments found</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* DENTISTS */}
          {tab === 'doctors' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {doctors.map(d => (
                  <div key={d.id} className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="font-semibold text-gray-900">Dr. {d.name}</h3>
                        <p className="text-sm text-blue-600">{d.specialization}</p>
                      </div>
                      <span className="text-2xl">🦷</span>
                    </div>
                    <p className="text-xs text-gray-500">{d.qualification}</p>
                    <p className="text-xs text-gray-500 mt-1">{d.hospital_name}</p>
                    {d.consultation_fee > 0 && (
                      <p className="text-sm font-medium text-green-600 mt-2">₹{d.consultation_fee}</p>
                    )}
                    <p className="text-xs text-gray-400 mt-2">{d.total_appointments} appointments</p>
                  </div>
                ))}
                {!doctors.length && (
                  <div className="col-span-3 text-center text-gray-400 py-12">No doctors found</div>
                )}
              </div>
            </div>
          )}

          {/* PATIENTS */}
          {tab === 'patients' && (
            <div className="bg-white rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {['Name','Phone','Gender','Visits','Joined'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {patients.map(p => (
                      <tr key={p.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{p.name || '—'}</td>
                        <td className="px-4 py-3">
                          <a href={`https://wa.me/${p.phone}`} target="_blank" className="text-green-600 hover:underline">{p.phone}</a>
                        </td>
                        <td className="px-4 py-3 text-gray-600 capitalize">{p.gender || '—'}</td>
                        <td className="px-4 py-3 text-gray-600">{p.visit_count}</td>
                        <td className="px-4 py-3 text-gray-400 text-xs">{p.created_at?.slice(0,10)}</td>
                      </tr>
                    ))}
                    {!patients.length && (
                      <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No patients found</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ANALYTICS */}
          {tab === 'analytics' && (
            <div className="bg-white rounded-xl p-6 shadow-sm">
              <h3 className="font-semibold text-gray-800 mb-4">30-Day Appointment Trends</h3>
              <p className="text-sm text-gray-400">Analytics charts will load here. Data available via /api/admin/analytics</p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
```

### 8F. frontend/src/app/page.js
```javascript
import { redirect } from 'next/navigation'
export default function Home() { redirect('/login') }
```

### 8G. Build frontend
```bash
cd frontend && npm run build
```
Fix every error. Common fixes needed:
- Missing 'use client' on pages that use hooks
- Import path issues (@/ alias)

---

## PHASE 9 — SEED TEST DATA

### 9A. backend/src/db/seed.js
```javascript
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, tenantQuery, pool } = require('./index');
const { createTenantSchema } = require('./tenantMigrate');
const { encrypt } = require('../utils/encryption');
const { addDays, format } = require('date-fns');

async function seed() {
  console.log('Seeding test data...');

  const slug = 'demo-clinic';
  const schema = 'tenant_demo_clinic';

  // Create or get tenant
  let tenant = (await query(`SELECT * FROM tenants WHERE slug=$1`, [slug])).rows[0];
  if (!tenant) {
    const r = await query(`
      INSERT INTO tenants (name, slug, schema_name, owner_email, plan, status)
      VALUES ('Demo Clinic Hyderabad', $1, $2, 'demo@medibook.com', 'growth', 'active')
      RETURNING *
    `, [slug, schema]);
    tenant = r.rows[0];
    await createTenantSchema(schema);
    console.log('✅ Tenant created: Smile Dental Clinic Hyderabad');
  } else {
    console.log('✅ Tenant already exists, skipping...');
  }

  // Create admin user
  const hash = await bcrypt.hash('Demo@123456', 12);
  await tenantQuery(schema, `
    INSERT INTO users (email, password_hash, name, role)
    VALUES ('demo@medibook.com', $1, 'Demo Admin', 'admin')
    ON CONFLICT (email) DO NOTHING
  `, [hash]);

  // Create dental clinic
  let hospital = (await tenantQuery(schema, `SELECT * FROM hospitals LIMIT 1`)).rows[0];
  if (!hospital) {
    const r = await tenantQuery(schema, `
      INSERT INTO hospitals (name, address, city, phone)
      VALUES ('Smile Dental Clinic Hyderabad', 'Banjara Hills, Road No. 12', 'Hyderabad', '040-12345678')
      RETURNING *
    `);
    hospital = r.rows[0];
  }

  // Create dental departments/specialties
  const deptNames = ['General Dentistry', 'Orthodontics', 'Oral Surgery'];
  const deptIds = {};
  for (const name of deptNames) {
    const existing = await tenantQuery(schema, `SELECT id FROM departments WHERE name=$1`, [name]);
    if (existing.rows[0]) { deptIds[name] = existing.rows[0].id; continue; }
    const r = await tenantQuery(schema, `
      INSERT INTO departments (hospital_id, name) VALUES ($1,$2) RETURNING id
    `, [hospital.id, name]);
    deptIds[name] = r.rows[0].id;
  }

  // Create dental doctors
  const doctorDefs = [
    { name: 'Priya Sharma', spec: 'General Dentist', qual: 'BDS, MDS', dept: 'General Dentistry', fee: 500, duration: 30 },
    { name: 'Rajesh Kumar', spec: 'Orthodontist', qual: 'BDS, MDS (Orthodontics)', dept: 'Orthodontics', fee: 800, duration: 30 },
    { name: 'Anita Reddy', spec: 'Oral & Maxillofacial Surgeon', qual: 'BDS, MDS (Oral Surgery)', dept: 'Oral Surgery', fee: 1000, duration: 45 },
  ];

  const doctorIds = [];
  for (const d of doctorDefs) {
    const existing = await tenantQuery(schema, `SELECT id FROM doctors WHERE name=$1`, [d.name]);
    if (existing.rows[0]) { doctorIds.push(existing.rows[0].id); continue; }
    const r = await tenantQuery(schema, `
      INSERT INTO doctors (hospital_id, department_id, name, specialization, qualification, consultation_fee, slot_duration_minutes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [hospital.id, deptIds[d.dept], d.name, d.spec, d.qual, d.fee, d.duration]);
    doctorIds.push(r.rows[0].id);
  }

  // Create schedules (Mon-Sat, 9AM-5PM)
  for (const docId of doctorIds) {
    for (let dow = 1; dow <= 6; dow++) {
      await tenantQuery(schema, `
        INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working)
        VALUES ($1,$2,'09:00','17:00',true)
        ON CONFLICT (doctor_id, day_of_week) DO NOTHING
      `, [docId, dow]);
    }
  }

  // Generate slots for 30 days
  let slotCount = 0;
  const today = new Date();
  for (const docId of doctorIds) {
    const docInfo = doctorDefs[doctorIds.indexOf(docId)];
    const duration = docInfo.duration;
    for (let i = 1; i <= 30; i++) {
      const date = addDays(today, i);
      const dow = date.getDay();
      if (dow === 0) continue; // Skip Sunday
      const dateStr = format(date, 'yyyy-MM-dd');
      let cur = 9 * 60; // 9:00 AM
      while (cur + duration <= 17 * 60) { // until 5:00 PM
        const st = `${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}`;
        const et = `${String(Math.floor((cur+duration)/60)).padStart(2,'0')}:${String((cur+duration)%60).padStart(2,'0')}`;
        await tenantQuery(schema, `
          INSERT INTO time_slots (doctor_id, hospital_id, slot_date, start_time, end_time, status)
          VALUES ($1,$2,$3,$4,$5,'available') ON CONFLICT (doctor_id, slot_date, start_time) DO NOTHING
        `, [docId, hospital.id, dateStr, st, et]);
        cur += duration;
        slotCount++;
      }
    }
  }

  console.log('✅ 3 doctors created with schedules');
  console.log(`✅ ${slotCount} time slots generated for 30 days`);
  console.log('');
  console.log('─────────────────────────────────────');
  console.log('TEST CREDENTIALS:');
  console.log('Super Admin:  admin@medibook.com / SuperAdmin@123');
  console.log('Clinic Admin: demo@medibook.com / Demo@123456');
  console.log('Clinic Slug:  demo-clinic');
  console.log('─────────────────────────────────────');

  await pool.end();
}

seed().catch(err => { console.error('Seed failed:', err.message); process.exit(1); });
```

### 9B. Run seed
```bash
cd backend && node src/db/seed.js
```

---

## PHASE 10 — TESTS

### 10A. backend/tests/bot.test.js
```javascript
require('dotenv').config();
const botEngine = require('../src/services/botEngine');
const { query } = require('../src/db');

let tenant;
const TEST_PHONE = '919111111111';

async function getTenant() {
  const r = await query(`SELECT * FROM tenants WHERE slug='demo-clinic'`);
  return r.rows[0];
}

async function sendMsg(text, buttonId) {
  const responses = [];
  const wa = require('../src/services/whatsapp');
  const origText = wa.sendText;
  const origBtns = wa.sendButtons;
  const origList = wa.sendList;
  wa.sendText = async (to, t) => responses.push({ type: 'text', text: t });
  wa.sendButtons = async (to, t, btns) => responses.push({ type: 'buttons', text: t, buttons: btns });
  wa.sendList = async (to, t, label, sections) => responses.push({ type: 'list', text: t, sections });
  await botEngine.handle({ phone: TEST_PHONE, text, buttonId, tenant });
  wa.sendText = origText;
  wa.sendButtons = origBtns;
  wa.sendList = origList;
  return responses;
}

async function resetSession() {
  const { tenantQuery } = require('../src/db');
  await tenantQuery(tenant.schema_name,
    `UPDATE bot_sessions SET state='idle', context='{}' WHERE phone=$1`, [TEST_PHONE]);
}

async function runTests() {
  console.log('Running bot flow tests...\n');
  tenant = await getTenant();
  if (!tenant) { console.error('❌ No demo-clinic tenant. Run seed first.'); process.exit(1); }

  let pass = 0;
  let fail = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      pass++;
    } catch (err) {
      console.log(`  ❌ ${name}: ${err.message}`);
      fail++;
    }
  }

  // Test 1: Greeting
  await test('Greeting shows main menu', async () => {
    await resetSession();
    const r = await sendMsg('Hi');
    if (!r.length) throw new Error('No response');
    if (!r[0].text.includes('Welcome')) throw new Error('No welcome message');
    if (!r[0].buttons?.some(b => b.includes('Book'))) throw new Error('No book button');
  });

  // Test 2: Book flow starts
  await test('Book button starts dental clinic/visit type selection', async () => {
    await resetSession();
    await sendMsg('Hi');
    const r = await sendMsg('', 'btn_0_test');
    if (!r.length) throw new Error('No response after book button');
  });

  // Test 3: Session persists
  await test('Session state persists between messages', async () => {
    await resetSession();
    await sendMsg('Hi');
    const { tenantQuery } = require('../src/db');
    const s = await tenantQuery(tenant.schema_name,
      `SELECT state FROM bot_sessions WHERE phone=$1`, [TEST_PHONE]);
    if (!s.rows[0]) throw new Error('No session created');
    if (s.rows[0].state !== 'main_menu') throw new Error(`Wrong state: ${s.rows[0].state}`);
  });

  // Test 4: Invalid input gets fallback
  await test('Unknown input returns fallback message', async () => {
    await resetSession();
    const r = await sendMsg('xyzrandomgarbage12345');
    if (!r.length) throw new Error('No response to garbage input');
  });

  // Test 5: Hi resets flow
  await test('Hi resets any state back to main menu', async () => {
    const { tenantQuery } = require('../src/db');
    await tenantQuery(tenant.schema_name,
      `UPDATE bot_sessions SET state='select_doctor', context='{}' WHERE phone=$1`, [TEST_PHONE]);
    const r = await sendMsg('Hi');
    if (!r[0]?.text?.includes('Welcome')) throw new Error('Hi did not reset to welcome');
  });

  // Test 6: Slot booking is atomic
  await test('Slot booking is atomic (race condition safe)', async () => {
    const { tenantQuery } = require('../src/db');
    const slotR = await tenantQuery(tenant.schema_name,
      `SELECT id FROM time_slots WHERE status='available' LIMIT 1`);
    if (!slotR.rows[0]) { console.log('    (skipped - no available slots)'); return; }
    const slotId = slotR.rows[0].id;
    const results = await Promise.all([
      tenantQuery(tenant.schema_name,
        `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available' RETURNING id`, [slotId]),
      tenantQuery(tenant.schema_name,
        `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available' RETURNING id`, [slotId]),
    ]);
    const successes = results.filter(r => r.rows.length > 0);
    if (successes.length !== 1) throw new Error(`Expected 1 success, got ${successes.length}`);
    // Restore
    await tenantQuery(tenant.schema_name,
      `UPDATE time_slots SET status='available' WHERE id=$1`, [slotId]);
  });

  console.log(`\n─────────────────────────────────`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) { process.exit(1); } else { console.log('All tests passed! 🎉'); }

  const { pool } = require('../src/db');
  await pool.end();
}

runTests().catch(err => { console.error(err); process.exit(1); });
```

### 10B. Run tests
```bash
cd backend && node tests/bot.test.js
```
All 6 tests must pass before continuing.

---

## PHASE 11 — FINAL INTEGRATION CHECK

### 11A. Start everything
Open two terminals:
```bash
# Terminal 1
docker-compose up postgres redis -d
cd backend && npm run dev

# Terminal 2
cd frontend && npm run dev
```

### 11B. Test checklist
Run each of these and verify:

```bash
# Health check
curl http://localhost:3001/health
# Expected: {"status":"ok",...}

# Test bot via test endpoint
curl -X POST http://localhost:3001/api/webhook/test \
  -H "Content-Type: application/json" \
  -d '{"phone":"919999999999","message":"Hi"}'
# Expected: {"responses":[{"type":"buttons","text":"Welcome..."},...]}

# Super admin login
curl -X POST http://localhost:3001/api/auth/superadmin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@medibook.com","password":"SuperAdmin@123"}'
# Expected: {"token":"eyJ...","user":{...}}
```

Open browser: http://localhost:3000
Login with demo@medibook.com / Demo@123456 / demo-clinic
Verify dashboard loads with stats.

### 11C. Update this file status
When all checks pass, add this line at the top of CLAUDE.md:
```
## STATUS: ALL PHASES COMPLETE ✅ — $(date)
```

---

## KNOWN ISSUES & FIXES

**Error: "Cannot find module '../utils/logger'"**
→ Create the file at backend/src/utils/logger.js (Phase 3B)

**Error: "relation does not exist"**
→ Run migrations first: `node src/db/migrate.js`

**Error: "date-fns-tz: toZonedTime is not a function"**
→ Use: `const { toZonedTime } = require('date-fns-tz')` (v2 API)
→ Or install: `npm install date-fns-tz@2`

**Error: "ENCRYPTION_KEY must be 32 chars"**
→ Generate: `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`

**Frontend build error: Module not found '@/lib/api'"**
→ Add to next.config.js:
```js
const path = require('path')
module.exports = {
  webpack: (config) => {
    config.resolve.alias['@'] = path.join(__dirname, 'src')
    return config
  }
}
```

**WhatsApp messages not sending in dev**
→ Normal — META_ env vars are placeholders. Use /webhook/test endpoint for local testing.
→ Real messages only work after you add actual Meta credentials from developers.facebook.com

---

## PRODUCTION CHECKLIST (after all phases done locally)

1. Get Meta developer account → Create App → Add WhatsApp product
2. Copy Phone Number ID and Access Token to .env
3. Set META_WEBHOOK_VERIFY_TOKEN to any string
4. Deploy backend to Railway: `railway up`
5. Set webhook URL in Meta console: https://your-railway-url/api/webhook/whatsapp
6. Subscribe to "messages" webhook field
7. Deploy frontend to Vercel: `vercel deploy`
8. Update NEXT_PUBLIC_API_URL to Railway backend URL
9. Add real WhatsApp number as test recipient in Meta console
10. Send "Hi" and verify bot responds

---

*End of CLAUDE.md — Execute all phases in order. You've got this.*
