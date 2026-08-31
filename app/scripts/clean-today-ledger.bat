@echo off
title Clean today's poisoned ledger entry
cd /d "%~dp0.."
echo.
echo  ============================================
echo   CLEAN TODAY'S LEDGER ENTRY
echo  ============================================
echo.
echo  Close the Co-Pilot browser tab BEFORE running
echo  this, or the app writes the bad data back.
echo.
pause
echo.
node scripts\clean-today-ledger.js %1 %2
echo.
echo  ============================================
echo   Now reopen http://localhost:7433
echo  ============================================
echo.
pause
