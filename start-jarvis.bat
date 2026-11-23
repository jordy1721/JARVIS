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

rem Close any JARVIS that is still running in the background (closing the window only hides
rem it in the tray). Otherwise the old copy keeps running and this one can't start.
echo  Closing any JARVIS already running...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -or $_.Name -eq 'node.exe') -and $_.CommandLine -match 'JARVIS' -and $_.CommandLine -match 'electron' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul

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
echo  Any problems will be printed here.
echo.
call npm start
pause
