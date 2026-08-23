@echo off
title Co-Pilot Watchdog
cd /d "%~dp0"
echo.
echo  ========================================
echo   MNQ CO-PILOT WATCHDOG
echo   Polls http://localhost:7433 every ~45s.
echo   Leave this window open/minimized during
echo   a live session. Closing it stops the
echo   watchdog (the server itself keeps running).
echo  ========================================
echo.
node watchdog.js
pause
