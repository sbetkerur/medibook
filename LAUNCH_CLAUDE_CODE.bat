@echo off
title MediBook — Claude Code Setup
color 0A

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║   MediBook — Claude Code Autonomous Setup            ║
echo  ║   All files are pre-built. Claude Code will verify   ║
echo  ║   and fix anything that needs attention.             ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

where claude >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Claude Code not installed!
    echo.
    echo  Install it: Open PowerShell as Admin and run:
    echo  irm https://claude.ai/install.ps1 ^| iex
    echo.
    pause & exit /b 1
)

where docker >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Docker not found. Install Docker Desktop first.
    pause & exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Docker Desktop not running. Open it and wait for green status.
    pause & exit /b 1
)

echo  ✅ Claude Code found
echo  ✅ Docker running
echo.
echo  ══════════════════════════════════════════════════════
echo  WHEN CLAUDE CODE OPENS, PASTE THIS MESSAGE:
echo.
echo  "Read CLAUDE.md and verify every phase is complete.
echo   Install npm packages, run migrations, seed data,
echo   run tests. Fix any errors you find. Make sure the
echo   frontend builds and both servers start correctly."
echo  ══════════════════════════════════════════════════════
echo.
echo  Press any key to launch Claude Code...
pause >nul

cd /d "%~dp0"
claude
