#!/usr/bin/env pwsh
# ============================================================
#  MediBook — Complete Verification & Auto-Fix Script
#  Runs: npm install, migrate, seed, syntax checks, tests
#  Then starts both servers and runs live API checks
# ============================================================

$ErrorActionPreference = "Continue"
$Root = $PSScriptRoot
$Pass = 0
$Fail = 0
$Fixes = @()

function Write-Header($text) {
    Write-Host ""
    Write-Host "  ══════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host "  ══════════════════════════════════════════" -ForegroundColor Cyan
}

function Write-Step($text) {
    Write-Host ""
    Write-Host "  ▶ $text" -ForegroundColor Yellow
}

function Write-OK($text) {
    Write-Host "    ✅  $text" -ForegroundColor Green
    $script:Pass++
}

function Write-FAIL($text) {
    Write-Host "    ❌  $text" -ForegroundColor Red
    $script:Fail++
}

function Write-FIXED($text) {
    Write-Host "    🔧  $text" -ForegroundColor Magenta
    $script:Fixes += $text
}

function Write-INFO($text) {
    Write-Host "    ℹ   $text" -ForegroundColor Gray
}

Clear-Host
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║  MediBook — Automated Verification & Fix Suite   ║" -ForegroundColor Cyan
Write-Host "  ║  WhatsApp Cloud API Edition                      ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan

# ── PHASE 1: PREREQUISITES ────────────────────────────────────
Write-Header "PHASE 1 — Prerequisites"

# Node.js
Write-Step "Checking Node.js..."
try {
    $nodeVer = node --version 2>$null
    $major = [int]($nodeVer -replace 'v(\d+)\..*','$1')
    if ($major -ge 18) {
        Write-OK "Node.js $nodeVer (v18+ required)"
    } else {
        Write-FAIL "Node.js $nodeVer is too old — need v18+. Download from nodejs.org"
    }
} catch {
    Write-FAIL "Node.js not found — install from nodejs.org"
}

# Docker
Write-Step "Checking Docker..."
try {
    $null = docker info 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-OK "Docker Desktop is running"
    } else {
        Write-FAIL "Docker Desktop not running — open it and wait for green status"
    }
} catch {
    Write-FAIL "Docker not found — install Docker Desktop"
}

# Required files
Write-Step "Checking project files..."
$requiredFiles = @(
    "backend\package.json",
    "backend\.env",
    "backend\src\index.js",
    "backend\src\db\index.js",
    "backend\src\db\migrate.js",
    "backend\src\db\seed.js",
    "backend\src\db\tenantMigrate.js",
    "backend\src\services\botEngine.js",
    "backend\src\services\whatsapp.js",
    "backend\src\routes\webhook.js",
    "backend\src\routes\admin.js",
    "backend\src\routes\auth.js",
    "backend\src\routes\superadmin.js",
    "backend\src\middleware\auth.js",
    "backend\src\jobs\reminders.js",
    "backend\src\jobs\slotGenerator.js",
    "backend\src\utils\logger.js",
    "backend\src\utils\encryption.js",
    "backend\tests\bot.test.js",
    "frontend\package.json",
    "frontend\src\app\layout.js",
    "frontend\src\app\login\page.js",
    "frontend\src\app\dashboard\page.js",
    "frontend\src\lib\api.js",
    "docker-compose.yml"
)

$missingFiles = @()
foreach ($f in $requiredFiles) {
    $full = Join-Path $Root $f
    if (-not (Test-Path $full)) {
        $missingFiles += $f
    }
}
if ($missingFiles.Count -eq 0) {
    Write-OK "All $($requiredFiles.Count) required files present"
} else {
    Write-FAIL "Missing $($missingFiles.Count) files:"
    $missingFiles | ForEach-Object { Write-Host "       - $_" -ForegroundColor Red }
}

# ── PHASE 2: ENV CHECK & FIX ──────────────────────────────────
Write-Header "PHASE 2 — Environment Variables"

Write-Step "Checking backend/.env..."
$envPath = Join-Path $Root "backend\.env"
$envContent = ""
if (Test-Path $envPath) {
    $envContent = Get-Content $envPath -Raw
    Write-OK ".env file exists"
} else {
    # Create default .env
    $envContent = @"
DATABASE_URL=postgresql://postgres:password@localhost:5432/medibook
REDIS_URL=redis://localhost:6379
JWT_SECRET=medibook_jwt_secret_dev_placeholder_32chars_ok
ENCRYPTION_KEY=medibook_enc_key_16c
META_ACCESS_TOKEN=PLACEHOLDER
META_PHONE_NUMBER_ID=PLACEHOLDER
META_WEBHOOK_VERIFY_TOKEN=medibook_verify_2024
META_APP_SECRET=PLACEHOLDER
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
LOG_LEVEL=info
"@
    Set-Content $envPath $envContent
    Write-FIXED "Created missing backend/.env with default values"
}

# Verify critical vars are present
$criticalVars = @("DATABASE_URL", "REDIS_URL", "JWT_SECRET", "ENCRYPTION_KEY")
foreach ($v in $criticalVars) {
    if ($envContent -match "$v=\S+") {
        Write-OK "$v is set"
    } else {
        # Auto-fix: add the variable
        $defaultVal = switch ($v) {
            "DATABASE_URL" { "postgresql://postgres:password@localhost:5432/medibook" }
            "REDIS_URL" { "redis://localhost:6379" }
            "JWT_SECRET" { "medibook_jwt_dev_secret_placeholder_abc123" }
            "ENCRYPTION_KEY" { "medibook_enc_16chr" }
        }
        Add-Content $envPath "`n$v=$defaultVal"
        Write-FIXED "Added missing $v to .env"
    }
}

# ── PHASE 3: DOCKER ───────────────────────────────────────────
Write-Header "PHASE 3 — Docker Services"

Write-Step "Starting PostgreSQL and Redis..."
Set-Location $Root
try {
    $result = docker-compose up -d postgres redis 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-OK "PostgreSQL and Redis started"
    } else {
        Write-FAIL "docker-compose failed: $($result | Select-Object -Last 3)"
    }
} catch {
    Write-FAIL "docker-compose error: $_"
}

Write-Step "Waiting for Postgres to be ready..."
$ready = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    $check = docker exec $(docker-compose ps -q postgres) pg_isready -U postgres 2>$null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
}
if ($ready) {
    Write-OK "PostgreSQL is ready"
} else {
    Write-FAIL "PostgreSQL did not become ready in 15s (may still work)"
}

# ── PHASE 4: NPM INSTALL ──────────────────────────────────────
Write-Header "PHASE 4 — NPM Dependencies"

Write-Step "Installing backend dependencies..."
Set-Location (Join-Path $Root "backend")
$installResult = npm install 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-OK "Backend npm install successful"
} else {
    Write-FAIL "Backend npm install failed"
    Write-INFO ($installResult | Select-Object -Last 5 | Out-String)
}

Write-Step "Installing frontend dependencies..."
Set-Location (Join-Path $Root "frontend")
$installResult = npm install 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-OK "Frontend npm install successful"
} else {
    Write-FAIL "Frontend npm install failed"
    Write-INFO ($installResult | Select-Object -Last 5 | Out-String)
}

# ── PHASE 5: SYNTAX CHECKS ────────────────────────────────────
Write-Header "PHASE 5 — Syntax Checks (node --check)"

$jsFiles = @(
    "backend\src\index.js",
    "backend\src\db\index.js",
    "backend\src\db\migrate.js",
    "backend\src\db\tenantMigrate.js",
    "backend\src\db\seed.js",
    "backend\src\services\whatsapp.js",
    "backend\src\services\botEngine.js",
    "backend\src\routes\auth.js",
    "backend\src\routes\webhook.js",
    "backend\src\routes\admin.js",
    "backend\src\routes\superadmin.js",
    "backend\src\middleware\auth.js",
    "backend\src\jobs\reminders.js",
    "backend\src\jobs\slotGenerator.js",
    "backend\src\utils\logger.js",
    "backend\src\utils\encryption.js",
    "backend\tests\bot.test.js"
)

Set-Location $Root
$syntaxErrors = @()
foreach ($f in $jsFiles) {
    $full = Join-Path $Root $f
    if (Test-Path $full) {
        $check = node --check $full 2>&1
        if ($LASTEXITCODE -ne 0) {
            $syntaxErrors += $f
            Write-FAIL "Syntax error in $f"
            Write-Host "       $check" -ForegroundColor Red
        }
    }
}
if ($syntaxErrors.Count -eq 0) {
    Write-OK "All $($jsFiles.Count) JS files pass syntax check"
}

# ── PHASE 6: MIGRATE ─────────────────────────────────────────
Write-Header "PHASE 6 — Database Migration"

Write-Step "Running migrations..."
Set-Location (Join-Path $Root "backend")
$migrateResult = node src/db/migrate.js 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-OK "Migrations completed successfully"
    Write-INFO ($migrateResult | Select-Object -Last 4 | Out-String).Trim()
} else {
    Write-FAIL "Migration failed"
    Write-INFO ($migrateResult | Select-Object -Last 8 | Out-String)
}

# ── PHASE 7: SEED ────────────────────────────────────────────
Write-Header "PHASE 7 — Seed Test Data"

Write-Step "Seeding demo clinic..."
$seedResult = node src/db/seed.js 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-OK "Seed completed successfully"
    Write-INFO ($seedResult | Select-Object -Last 5 | Out-String).Trim()
} else {
    Write-FAIL "Seed failed"
    Write-INFO ($seedResult | Select-Object -Last 8 | Out-String)
}

# ── PHASE 8: BOT TESTS ───────────────────────────────────────
Write-Header "PHASE 8 — Bot Engine Tests"

Write-Step "Running bot test suite (8 tests)..."
$testResult = node tests/bot.test.js 2>&1
$testOutput = $testResult | Out-String
if ($LASTEXITCODE -eq 0) {
    Write-OK "All bot tests passed!"
} else {
    Write-FAIL "Some bot tests failed"
}
Write-Host $testOutput -ForegroundColor Gray

# ── PHASE 9: FRONTEND BUILD ───────────────────────────────────
Write-Header "PHASE 9 — Frontend Build"

Write-Step "Building Next.js frontend (this takes ~30s)..."
Set-Location (Join-Path $Root "frontend")
$buildResult = npm run build 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-OK "Frontend build successful"
} else {
    Write-FAIL "Frontend build failed"
    $buildErrors = $buildResult | Where-Object { $_ -match "error|Error|failed" } | Select-Object -Last 10
    $buildErrors | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }
}

# ── PHASE 10: LIVE SERVER TEST ────────────────────────────────
Write-Header "PHASE 10 — Live Server Tests"

Write-Step "Starting backend server..."
Set-Location (Join-Path $Root "backend")
$backendJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    node src/index.js
} -ArgumentList (Join-Path $Root "backend")

Write-INFO "Waiting 5 seconds for server to start..."
Start-Sleep -Seconds 5

# Health check
Write-Step "Testing /health endpoint..."
try {
    $health = Invoke-RestMethod -Uri "http://localhost:3001/health" -Method GET -TimeoutSec 5
    if ($health.status -eq "ok") {
        Write-OK "Health check passed: $($health.status) — $($health.service)"
    } else {
        Write-FAIL "Health returned unexpected status: $($health | ConvertTo-Json)"
    }
} catch {
    Write-FAIL "Health check failed: server may not have started. Error: $_"
}

# Super admin login
Write-Step "Testing super admin login..."
try {
    $loginBody = @{ email = "admin@medibook.com"; password = "SuperAdmin@123" } | ConvertTo-Json
    $login = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/superadmin/login" -Method POST `
        -Body $loginBody -ContentType "application/json" -TimeoutSec 5
    if ($login.token) {
        Write-OK "Super admin login successful — JWT token received"
        $script:adminToken = $login.token
    } else {
        Write-FAIL "Login succeeded but no token returned"
    }
} catch {
    Write-FAIL "Super admin login failed: $_"
}

# Tenant admin login
Write-Step "Testing clinic admin login..."
try {
    $loginBody = @{ email = "demo@medibook.com"; password = "Demo@123456"; tenant_slug = "demo-clinic" } | ConvertTo-Json
    $login = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/login" -Method POST `
        -Body $loginBody -ContentType "application/json" -TimeoutSec 5
    if ($login.token) {
        Write-OK "Clinic admin login successful"
        $script:clinicToken = $login.token
    } else {
        Write-FAIL "Clinic login succeeded but no token returned"
    }
} catch {
    Write-FAIL "Clinic admin login failed: $_"
}

# Bot test
Write-Step "Testing WhatsApp bot (send 'Hi')..."
try {
    $botBody = @{ phone = "919999999999"; message = "Hi" } | ConvertTo-Json
    $bot = Invoke-RestMethod -Uri "http://localhost:3001/api/webhook/test" -Method POST `
        -Body $botBody -ContentType "application/json" -TimeoutSec 5
    if ($bot.responses -and $bot.responses.Count -gt 0) {
        $firstMsg = $bot.responses[0].text
        Write-OK "Bot responded with $($bot.responses.Count) message(s)"
        Write-INFO "First message: $($firstMsg.Substring(0, [Math]::Min(80, $firstMsg.Length)))..."
    } else {
        Write-FAIL "Bot returned no responses"
    }
} catch {
    Write-FAIL "Bot test failed: $_"
}

# Dashboard stats (with clinic token)
if ($script:clinicToken) {
    Write-Step "Testing dashboard API..."
    try {
        $headers = @{ Authorization = "Bearer $($script:clinicToken)" }
        $dash = Invoke-RestMethod -Uri "http://localhost:3001/api/admin/dashboard" -Headers $headers -TimeoutSec 5
        Write-OK "Dashboard API works — $($dash.total_patients) patients, $($dash.available_slots) slots"
    } catch {
        Write-FAIL "Dashboard API failed: $_"
    }
}

# Stop background server
Stop-Job $backendJob -ErrorAction SilentlyContinue
Remove-Job $backendJob -ErrorAction SilentlyContinue

# ── FINAL REPORT ──────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║              VERIFICATION COMPLETE               ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$total = $Pass + $Fail
$pct = if ($total -gt 0) { [Math]::Round($Pass / $total * 100) } else { 0 }

if ($Fail -eq 0) {
    Write-Host "  🎉  ALL CHECKS PASSED ($Pass/$total — $pct%)" -ForegroundColor Green
} else {
    Write-Host "  ⚠️   $Pass passed, $Fail failed ($pct% pass rate)" -ForegroundColor Yellow
}

if ($Fixes.Count -gt 0) {
    Write-Host ""
    Write-Host "  🔧  Auto-fixed $($Fixes.Count) issue(s):" -ForegroundColor Magenta
    $Fixes | ForEach-Object { Write-Host "     • $_" -ForegroundColor Magenta }
}

Write-Host ""
Write-Host "  ─────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  NEXT STEPS:" -ForegroundColor White
Write-Host ""
Write-Host "  1. Run START.bat to launch the full app" -ForegroundColor Green
Write-Host "  2. Open: http://localhost:3000" -ForegroundColor Green
Write-Host "  3. Login: demo@medibook.com / Demo@123456 / demo-clinic" -ForegroundColor Green
Write-Host ""
Write-Host "  For production:" -ForegroundColor Yellow
Write-Host "  • Get Meta WhatsApp API keys from developers.facebook.com" -ForegroundColor Gray
Write-Host "  • Update META_* vars in backend/.env" -ForegroundColor Gray
Write-Host "  • Deploy backend to Railway, frontend to Vercel" -ForegroundColor Gray
Write-Host ""

Set-Location $Root
Read-Host "  Press Enter to close"
