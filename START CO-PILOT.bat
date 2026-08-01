@echo off
setlocal
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
REM    2. Wait for it to finish booting
REM    3. The Co-Pilot server from G:
REM
REM  Use THIS and nothing else to start your trading setup.
REM ============================================================================

set "ROOT=G:\MNQ-CoPilot"
set "TV_EXE=C:\Program Files\WindowsApps\31178TradingViewInc.TradingView_3.3.0.0_x64__q4jpyh43s5mv6\TradingView.exe"

echo.
echo  ============================================
echo    MNQ CO-PILOT
echo  ============================================
echo.

if not exist "%ROOT%\app\server.js" (
    echo  [X] Cannot find %ROOT%\app\server.js
    echo      Is the G: drive plugged in?
    pause & exit /b 1
)

REM ------------------------------------------------------------ TradingView ---
echo  [1/3] Starting TradingView with the debug connection enabled...
taskkill /IM TradingView.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

if not exist "%TV_EXE%" (
    echo.
    echo  [!] TradingView.exe not found at the expected path.
    echo      It has probably auto-updated to a new version folder.
    echo      Tell Claude and the path will be updated.
    echo      Continuing without it - the chart features will not work.
    timeout /t 4 >nul
) else (
    start "" "%TV_EXE%" --remote-debugging-port=9222
    echo       Launched.
)

echo.
echo  [2/3] Waiting for TradingView to boot ^(about 30 seconds^)...
timeout /t 30 /nobreak >nul

REM --------------------------------------------------------------- Co-Pilot ---
echo.
echo  [3/3] Starting the Co-Pilot server...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 1 /nobreak >nul
cd /d "%ROOT%\app"
start "Co-Pilot" cmd /k "node server.js"

echo.
echo  ============================================
echo   Both are starting.
echo.
echo   Browser opens at http://localhost:7433
echo   Data saves to  %ROOT%\DATA
echo.
echo   If the red dot does not clear within a
echo   minute, just run this launcher again.
echo  ============================================
echo.
timeout /t 6 >nul
