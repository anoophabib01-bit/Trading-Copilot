@echo off
setlocal
title Create desktop shortcut - MNQ Co-Pilot (G:)
color 0B

REM ============================================================================
REM  Creates ONE desktop shortcut pointing at G:\MNQ-CoPilot\START CO-PILOT.bat
REM  and renames any old C:-pointing shortcuts out of the way so they cannot be
REM  clicked by mistake. Built 2026-07-31.
REM ============================================================================

set "ROOT=G:\MNQ-CoPilot"
set "TARGET=%ROOT%\START CO-PILOT.bat"

if not exist "%TARGET%" (
    echo  [X] Cannot find "%TARGET%" - is the G: drive plugged in?
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
  "        if ($t -notmatch '^G:' -and $t -notmatch 'G:\\MNQ-CoPilot') {" ^
  "          Rename-Item $_.FullName ($_.BaseName + ' (OLD - do not use).lnk') -ErrorAction SilentlyContinue;" ^
  "          Write-Host ('   retired: ' + $_.Name);" ^
  "        }" ^
  "      }" ^
  "    } catch {}" ^
  "  }" ^
  "}"

echo.
echo  Creating the new shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$sh = New-Object -ComObject WScript.Shell;" ^
  "$p = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MNQ Co-Pilot.lnk';" ^
  "$s = $sh.CreateShortcut($p);" ^
  "$s.TargetPath = '%TARGET%';" ^
  "$s.WorkingDirectory = '%ROOT%';" ^
  "$s.Description = 'Start TradingView (with CDP) and the MNQ Co-Pilot from G:';" ^
  "$s.IconLocation = 'shell32.dll,137';" ^
  "$s.Save();" ^
  "Write-Host ('   created: ' + $p)"

echo.
echo  ============================================
echo   Done.
echo.
echo   Desktop now has:  MNQ Co-Pilot
echo   It runs:          %TARGET%
echo.
echo   Any old C: shortcuts were renamed to
echo   "... (OLD - do not use)" - delete them
echo   whenever you like.
echo  ============================================
echo.
pause
