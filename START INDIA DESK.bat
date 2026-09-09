@echo off
setlocal
cd /d "%~dp0"
set "INDIA_PORT=7434"
set "URL=http://localhost:7434"

rem Launch the India Desk on its own port (7434). Independent of the co-pilot:
rem does NOT kill node, does NOT touch TradingView, does NOT assume the co-pilot
rem is running.
start "India Desk (7434)" node cli\india-desk\server.js

rem Wait up to ~20s for the port to listen, then open the browser.
set /a tries=0
:wait
ping -n 2 127.0.0.1 >nul
set /a tries+=1
netstat -ano | findstr ":7434" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto open
if %tries% lss 20 goto wait

:open
start "" "%URL%"
endlocal
