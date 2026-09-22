@echo off
setlocal
title Trading Co-Pilot - Setup

cd /d "%~dp0"

echo.
echo   Trading Co-Pilot - Setup Wizard
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js was not found on this machine.
  echo.
  echo   Install the LTS version from https://nodejs.org
  echo   then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "app\rules.json" (
  echo   Note: no app\rules.json yet. The wizard will create one.
  echo.
)

echo   Starting the setup server...
echo   A browser window should open by itself.
echo   If it does not, go to:  http://127.0.0.1:7434/
echo.
echo   Leave this window open. Press Ctrl+C when done.
echo.

node "setup\server.js"

echo.
echo   Setup server stopped.
pause
