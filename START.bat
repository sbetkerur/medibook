@echo off
title MediBook — Startup
color 0B

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║   MediBook v2 — WhatsApp Cloud API Edition           ║
echo  ║   Starting development environment...                ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

:: Check required tools
where node >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js not found. Install from nodejs.org
    pause & exit /b 1
)

echo  ✅ Node.js available
echo.

:: Start PostgreSQL (portable)
set PGDIR=C:\Users\sande\pg_portable\pgsql
set PGDATA=C:\Users\sande\pg_portable\data
set PGLOG=C:\Users\sande\pg_portable\postgres.log

echo  Checking PostgreSQL...
"%PGDIR%\bin\pg_ctl.exe" status -D "%PGDATA%" >nul 2>&1
if errorlevel 1 (
    echo  Starting PostgreSQL...
    "%PGDIR%\bin\pg_ctl.exe" -D "%PGDATA%" -l "%PGLOG%" start
    timeout /t 3 /nobreak >nul
)
echo  ✅ PostgreSQL running

:: Start Redis (Windows service)
echo  Checking Redis...
sc query redis >nul 2>&1
if errorlevel 1 (
    echo  Starting Redis service...
    net start redis
) else (
    echo  ✅ Redis running
)
echo.

:: Install backend deps if needed
if not exist "%~dp0backend\node_modules" (
    echo  Installing backend dependencies...
    cd /d "%~dp0backend"
    call npm install
    if errorlevel 1 ( echo  ERROR: npm install failed. & pause & exit /b 1 )
    echo  ✅ Backend dependencies installed
)

:: Install frontend deps if needed
if not exist "%~dp0frontend\node_modules" (
    echo  Installing frontend dependencies...
    cd /d "%~dp0frontend"
    call npm install
    if errorlevel 1 ( echo  ERROR: npm install failed. & pause & exit /b 1 )
    echo  ✅ Frontend dependencies installed
)

:: Run migrations
echo  Running database migrations...
cd /d "%~dp0backend"
node src/db/migrate.js
if errorlevel 1 (
    echo  WARNING: Migration may have failed. Check above for errors.
)
echo.

:: Seed data
echo  Seeding demo clinic data...
node src/db/seed.js
echo.

:: Start backend in new terminal
echo  Starting backend server (port 3001)...
start "MediBook Backend" cmd /k "cd /d %~dp0backend && npm run dev"

:: Wait a moment for backend to start
timeout /t 3 /nobreak >nul

:: Start frontend in new terminal
echo  Starting frontend (port 3000)...
start "MediBook Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo  ══════════════════════════════════════════════════════
echo  MediBook is starting up!
echo.
echo  Dashboard:    http://localhost:3000
echo  API:          http://localhost:3001/health
echo  Bot Test:     POST http://localhost:3001/api/webhook/test
echo.
echo  Login (Clinic Admin):  demo@medibook.com / Demo@123456
echo  Login (Super Admin):   admin@medibook.com / SuperAdmin@123
echo  Clinic Slug:           demo-clinic
echo  ══════════════════════════════════════════════════════
echo.
echo  Both servers are starting in separate windows.
echo  Wait ~15 seconds then open: http://localhost:3000
echo.
pause
