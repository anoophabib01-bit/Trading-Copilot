@echo off
setlocal EnableDelayedExpansion
title MNQ Co-Pilot - start everything
color 0A

REM ============================================================================
REM  ONE launcher for the whole setup.  Built 2026-07-31.
REM
REM  Why this exists: the CDP connection kept dropping because TradingView was
REM  being opened from the taskbar/Start menu, which starts it WITHOUT the
REM  remote-debugging flag the Co-Pilot needs. Ordering also mattered and was
REM  easy to get wrong. This does both, in the right order, every time.
REM
REM    1. TradingView, always with --remote-debugging-port=9222
REM    2. The Co-Pilot server from G:
REM
REM  Use THIS and nothing else to start your trading setup.
REM ============================================================================
REM
REM  REWRITTEN 2026-08-29 after Anoop reported "it's taking so much time and
REM  TradingView did not auto start". Three separate faults, all measured:
REM
REM    1. STALE PATH. TV_EXE was hardcoded to the 3.3.0.0 WindowsApps folder.
REM       TradingView had auto-updated to 3.4.0.0 - a different folder - so the
REM       path no longer existed and this script silently skipped launching it.
REM       Now resolved at run time from the package registration, so a future
REM       update cannot break it. (scripts\ensure-tradingview.ps1)
REM
REM    2. THE READINESS CHECK COULD NEVER PASS. It probed
REM       http://localhost:9222 - and "localhost" resolves to the IPv6 loopback
REM       ::1 first here, while TradingView's debug port is IPv4 only. .NET does
REM       not fall back the way Node does, so every probe burned its full 2s
REM       timeout. 45 attempts, each in a FRESH powershell process (~1s start-up
REM       each) = over two minutes of waiting to reach the wrong answer. The
REM       probe now uses 127.0.0.1 and runs in ONE process. Measured on this
REM       machine: 135s -> 0.32s when TradingView is already up.
REM
REM    3. IT KILLED EVERY NODE PROCESS ON THE MACHINE. `taskkill /F /IM
REM       node.exe` took out MCP servers and other Node tooling on every single
REM       launch, silently. Now stops only the process holding port 7433 plus
REM       any leaked tradingview-mcp child of this repo.
REM       (scripts\stop-copilot-server.ps1)
REM
REM  If TradingView is ALREADY running with the debug port open, this now reuses
REM  it instead of killing a working chart and paying the cold start again.
REM ============================================================================

set "ROOT=G:\MNQ-CoPilot"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File"

echo.
echo  ============================================
echo    MNQ CO-PILOT
echo  ============================================

REM Say out loud which mode this is. Which shortcut you double-click is the
REM only thing that decides whether the oversize guard can actually close
REM contracts, so it must never be a guess. See oversize-guard.js.
if "%TV_ALLOW_LIVE_ORDERS%"=="1" (
    echo    LIVE ORDERS: ENABLED
    echo    The oversize guard can CLOSE contracts. Tickets can execute.
) else (
    echo    LIVE ORDERS: off  ^(alarm-only^)
    echo    The oversize guard will WARN but cannot close anything.
    echo    Use "START CO-PILOT ^(LIVE ORDERS^).bat" if you want it to act.
)
echo  ============================================
echo.

if not exist "%ROOT%\app\server.js" (
    echo  [X] Cannot find %ROOT%\app\server.js
    echo      Is the G: drive plugged in?
    pause & exit /b 1
)

REM ------------------------------------------------------------ TradingView ---
echo  [1/2] Making sure TradingView is up with the debug connection...
%PS% "%~dp0scripts\ensure-tradingview.ps1" -Port 9222 -TimeoutSec 90
if errorlevel 1 (
    echo.
    echo       [!] TradingView is not answering on port 9222.
    echo           Chart features will be down until it is. The server keeps
    echo           retrying on its own heartbeat, so it may still recover.
) else (
    echo       TradingView ready.
)

REM --------------------------------------------------------------- Co-Pilot ---
echo.
echo  [2/2] Starting the Co-Pilot server...
%PS% "%~dp0scripts\stop-copilot-server.ps1" -Port 7433 -RepoRoot "%ROOT%"
cd /d "%ROOT%\app"
start "Co-Pilot" cmd /k "node server.js"

echo.
echo  ============================================
echo   Browser opens at http://localhost:7433
echo   Data saves to  %ROOT%\DATA
echo.
echo   Watch the server window for this line:
echo     [oversize] guard ARMED ...
echo   It tells you whether the guard can act.
echo.
echo   If the red dot does not clear within a
echo   minute, just run this launcher again.
echo  ============================================
echo.
REM `timeout` fails outright when stdin is redirected ("input redirection is
REM not supported"), which is exactly what happens when this launcher is run
REM from a script or a test harness rather than double-clicked. ping is the
REM redirect-safe way to pause in batch.
ping -n 7 127.0.0.1 >nul
