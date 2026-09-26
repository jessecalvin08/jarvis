@echo off
title J.A.R.V.I.S.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist .env (
  copy .env.example .env >nul
  echo.
  echo Created .env - add your ANTHROPIC_API_KEY to it, save, then close Notepad.
  notepad .env
)

call npm start
pause
