@echo off
title Co-Pilot
cd /d "%~dp0"
echo.
echo  ========================================
echo   MNQ CO-PILOT
echo  ========================================
echo.

REM ── Kill any stale server still holding port 7433 ──────────────────────────
REM Without this, a previous node server keeps running OLD code and the new
REM launch silently fails to bind the port — so the browser talks to the old
REM server. This was the "restarted but still got the old model / 429" bug.
REM Surgical: only kills whatever process owns :7433, not every node.exe.
echo  [1/3] Stopping any old server...
set KILLED=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :7433 ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
  set KILLED=1
)
if "%KILLED%"=="1" (echo        Old server stopped.) else (echo        Nothing was running.)

REM ── Start fresh, then WAIT until the port is actually listening ────────────
REM 2026-07-25: this used to be a blind "timeout 3". On a slow start Chrome
REM opened before the server was up and showed a connection error, which looked
REM like the restart had failed. Now it polls for up to 20s and says honestly
REM whether the server actually came up.
echo  [2/3] Starting fresh server (loads the new code)...
start "" /B node server.js

set TRIES=0
:WAITPORT
set /a TRIES+=1
netstat -ano | findstr :7433 | findstr LISTENING >nul 2>&1
if not errorlevel 1 goto PORTUP
if %TRIES% GEQ 20 goto PORTFAIL
timeout /t 1 /nobreak >nul
goto WAITPORT

:PORTFAIL
echo.
echo  *** SERVER DID NOT START ***
echo  To see the actual error, run:   node server.js
echo.
pause
exit /b 1

:PORTUP
echo        Server is up on port 7433.

REM ── Open a FRESH Chrome window every launch (not reuse an open tab) ─────────
echo  [3/3] Opening a new window at http://localhost:7433
start "" chrome --new-window "http://localhost:7433"

echo.
echo  ========================================
echo   RUNNING. You can close this window;
echo   the app stays open.
echo.
echo   Then in the app:
echo     1. Account button - Rebuild list
echo     2. Start fresh on the 50K slot
echo     3. JOURNAL tab - the top line shows
echo        where data is saved. It should say
echo        G:\Trading-CoPilot\DATA
echo  ========================================
timeout /t 8 /nobreak >nul
