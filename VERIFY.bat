@echo off
:: ============================================================
::  MediBook — 1-Click Verification
::  Double-click this file. It will:
::  1. Check all prereqs (Node, Docker)
::  2. Start PostgreSQL + Redis
::  3. npm install (backend + frontend)
::  4. Syntax check all JS files
::  5. Run migrations + seed
::  6. Run 8 bot tests
::  7. Build Next.js frontend
::  8. Start server + run live API tests
:: ============================================================

title MediBook — Verification

:: Self-elevate if not admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    PowerShell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

PowerShell -ExecutionPolicy Bypass -File "%~dp0VERIFY.ps1"
