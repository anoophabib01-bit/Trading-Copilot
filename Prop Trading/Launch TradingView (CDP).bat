@echo off
REM ============================================================
REM Launch TradingView (CDP) — Anoop's Co-Pilot launcher
REM Always starts TradingView with remote debugging enabled so
REM the MNQ Co-Pilot app can connect, no matter which one you
REM open first. Safe to run even if TradingView is already open
REM (it will be closed and restarted WITH the debug port).
REM ============================================================
setlocal
set "TV_EXE=C:\Program Files\WindowsApps\31178TradingViewInc.TradingView_3.3.0.0_x64__q4jpyh43s5mv6\TradingView.exe"

echo Closing any existing TradingView instance...
taskkill /IM TradingView.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

if not exist "%TV_EXE%" (
    echo.
    echo TradingView.exe not found at the expected path:
    echo   %TV_EXE%
    echo TradingView may have updated to a new version folder.
    echo Tell Claude the version changed so this script can be updated.
    pause
    exit /b 1
)

echo Starting TradingView with remote debugging enabled (port 9222)...
start "" "%TV_EXE%" --remote-debugging-port=9222

echo.
echo Done. TradingView is launching with CDP enabled.
echo Open (or switch to) the MNQ Co-Pilot app now — it will connect automatically.
timeout /t 3 >nul
