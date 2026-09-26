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
  echo Installing dependencies - first run only, this can take a few minutes...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist .env (
  call npm run setup
  if not exist .env (
    copy .env.example .env >nul
    echo Created .env - add your ANTHROPIC_API_KEY to it, save, then close Notepad.
    notepad .env
  )
) else (
  rem Using Claude but no key saved yet? Run setup again instead of starting a Jarvis that can't think.
  findstr /b /c:"LLM_PROVIDER=anthropic" .env >nul
  if not errorlevel 1 (
    findstr /b /c:"ANTHROPIC_API_KEY=sk-" .env >nul
    if errorlevel 1 (
      echo.
      echo No Claude API key in .env yet - starting setup. Answer y to replace the old settings.
      call npm run setup
    )
  )
)

call npm start
pause
