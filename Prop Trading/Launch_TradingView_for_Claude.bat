@echo off
title Launching TradingView in Claude Debug Mode...
echo =====================================================
echo   MNQ Co-Pilot: Starting TradingView + Claude Link
echo =====================================================
echo.

REM Close any existing TradingView instance first
taskkill /f /im "TradingView.exe" >nul 2>&1
timeout /t 2 /nobreak >nul

REM -------------------------------------------------------
REM TradingView installation path — check which one exists
REM -------------------------------------------------------
set TV1="%LOCALAPPDATA%\Programs\TradingView\TradingView.exe"
set TV2="%LOCALAPPDATA%\TradingView\TradingView.exe"
set TV3="C:\Program Files\TradingView\TradingView.exe"
set TV4="C:\Program Files (x86)\TradingView\TradingView.exe"

if exist %TV1% (
    echo Found TradingView at: %TV1%
    start "" %TV1% --remote-debugging-port=9222
    goto :done
)
if exist %TV2% (
    echo Found TradingView at: %TV2%
    start "" %TV2% --remote-debugging-port=9222
    goto :done
)
if exist %TV3% (
    echo Found TradingView at: %TV3%
    start "" %TV3% --remote-debugging-port=9222
    goto :done
)
if exist %TV4% (
    echo Found TradingView at: %TV4%
    start "" %TV4% --remote-debugging-port=9222
    goto :done
)

REM If none found, ask user to set path manually
echo.
echo [ERROR] TradingView.exe not found in common locations.
echo.
echo Please edit this file and set YOUR_PATH below:
echo   set TVPATH="C:\YOUR\PATH\TO\TradingView.exe"
echo.
echo To find the path: right-click your TradingView desktop
echo icon ^> Properties ^> look at "Target" field.
echo.
pause
goto :end

:done
echo.
echo TradingView launched in debug mode on port 9222.
echo Claude can now connect via TradingView MCP.
echo.
echo Next step: open Claude and type your request.
echo (Wait ~5 seconds for TradingView to fully load first)
echo.
timeout /t 3 /nobreak >nul

:end
