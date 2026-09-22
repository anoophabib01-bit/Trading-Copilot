@echo off
setlocal
title Create desktop shortcut - Trading Co-Pilot (G:)
color 0B

REM ============================================================================
REM  Creates ONE desktop shortcut pointing at G:\Trading-CoPilot\START CO-PILOT.bat
REM  and renames any old C:-pointing shortcuts out of the way so they cannot be
REM  clicked by mistake. Built 2026-07-31.
REM ============================================================================

set "ROOT=G:\Trading-CoPilot"
REM The project folder was renamed 2026-09-18. Prefer the new name, fall back to
REM the old one, so this launcher works whether or not the rename has happened.
if not exist "%ROOT%\app\server.js" if exist "G:\MNQ-CoPilot\app\server.js" set "ROOT=G:\MNQ-CoPilot"
set "TARGET=%ROOT%\START CO-PILOT.bat"
set "LIVE_TARGET=%ROOT%\START CO-PILOT (LIVE ORDERS).bat"

if not exist "%TARGET%" (
    echo  [X] Cannot find "%TARGET%" - is the G: drive plugged in?
    pause & exit /b 1
)
if not exist "%LIVE_TARGET%" (
    echo  [X] Cannot find "%LIVE_TARGET%" - is the G: drive plugged in?
    pause & exit /b 1
)

echo.
echo  Retiring old shortcuts that point at C:...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$sh = New-Object -ComObject WScript.Shell;" ^
  "$desks = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:PUBLIC 'Desktop')) | Select-Object -Unique;" ^
  "foreach ($d in $desks) {" ^
  "  if (-not (Test-Path $d)) { continue }" ^
  "  Get-ChildItem -Path $d -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {" ^
  "    try {" ^
  "      $lnk = $sh.CreateShortcut($_.FullName);" ^
  "      $t = ($lnk.TargetPath + ' ' + $lnk.Arguments);" ^
  "      if ($t -match 'MNQ-CoPilot-App' -or $t -match 'tradingview-mcp') {" ^
  "        if ($t -notmatch '^G:' -and $t -notmatch 'G:\\Trading-CoPilot') {" ^
  "          Rename-Item $_.FullName ($_.BaseName + ' (OLD - do not use).lnk') -ErrorAction SilentlyContinue;" ^
  "          Write-Host ('   retired: ' + $_.Name);" ^
  "        }" ^
  "      }" ^
  "    } catch {}" ^
  "  }" ^
  "}"

echo.
echo  Creating the shortcuts (two of them)...
REM TWO shortcuts on purpose, with DIFFERENT icons. Which one you double-click is
REM the only thing standing in for "did I mean to allow real orders this session"
REM (see START CO-PILOT (LIVE ORDERS).bat). They must never look alike.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$sh = New-Object -ComObject WScript.Shell;" ^
  "$d = [Environment]::GetFolderPath('Desktop');" ^
  "$a = $sh.CreateShortcut((Join-Path $d 'Trading Co-Pilot.lnk'));" ^
  "$a.TargetPath = '%TARGET%';" ^
  "$a.WorkingDirectory = '%ROOT%';" ^
  "$a.Description = 'Trading Co-Pilot - normal session. Live orders OFF (alarm only).';" ^
  "$a.IconLocation = 'shell32.dll,137';" ^
  "$a.Save();" ^
  "Write-Host '   created: Trading Co-Pilot.lnk             (alarm only)';" ^
  "$b = $sh.CreateShortcut((Join-Path $d 'Trading Co-Pilot (LIVE ORDERS).lnk'));" ^
  "$b.TargetPath = '%LIVE_TARGET%';" ^
  "$b.WorkingDirectory = '%ROOT%';" ^
  "$b.Description = 'LIVE ORDERS ENABLED - the oversize guard can CLOSE contracts and tickets can execute.';" ^
  "$b.IconLocation = 'imageres.dll,101';" ^
  "$b.Save();" ^
  "Write-Host '   created: Trading Co-Pilot (LIVE ORDERS).lnk'  -ForegroundColor Yellow;" ^
  "Write-Host '            (this one CAN place real orders)' -ForegroundColor Yellow"

echo.
echo  ============================================
echo   Done. Desktop now has TWO shortcuts:
echo.
echo    Trading Co-Pilot              alarm only
echo      runs: %TARGET%
echo.
echo    Trading Co-Pilot (LIVE ORDERS)
echo      runs: %LIVE_TARGET%
echo      ^>^> this one CAN place real orders
echo.
echo   Any old C: shortcuts were renamed to
echo   "... (OLD - do not use)" - delete them
echo   whenever you like. An older
echo   "MNQ Co-Pilot (LIVE ORDERS)" shortcut
echo   still works but is now redundant.
echo  ============================================
echo.
pause
