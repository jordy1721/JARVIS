@echo off
rem Double-click this file to install (first time) and start JARVIS on Windows.
title JARVIS
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Download the LTS version from https://nodejs.org , install it, then run this file again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo  First start: installing JARVIS. This takes a few minutes...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  Installation failed. Scroll up to see the error.
    pause
    exit /b 1
  )
)

rem Make sure the Electron runtime has been downloaded (newer Electron versions don't do this during npm install).
call npx --no-install install-electron
if errorlevel 1 (
  echo.
  echo  Could not download the Electron runtime. Check your internet connection and run this file again.
  pause
  exit /b 1
)

echo.
echo  Starting JARVIS... (keep this window open while JARVIS is running)
echo.
call npm run dev
pause
