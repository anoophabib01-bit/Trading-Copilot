@echo off
setlocal EnableDelayedExpansion
title MNQ Co-Pilot - Move to G: drive
color 0B

REM ============================================================================
REM  MNQ Co-Pilot — consolidate everything onto G:\MNQ-CoPilot
REM  Built 2026-07-31.  Anoop: "keep them all in one place so that there is
REM  no confusion in future."
REM
REM  SAFETY DESIGN — read this before running:
REM    * This script COPIES. It never deletes or moves your originals.
REM      If anything goes wrong, your current setup on C: and D: still works.
REM    * It takes a full backup of your trading data FIRST, before anything else.
REM    * node_modules is deliberately NOT copied — it contains machine-compiled
REM      binaries. It is reinstalled fresh with npm install at the end.
REM    * After it finishes, TEST the new copy. Only delete the originals once
REM      you have run a full session from G: successfully.
REM ============================================================================

set "ROOT=G:\MNQ-CoPilot"
set "SRC_APP=C:\Users\Admin\Claude\Projects\MNQ-CoPilot-App"
set "SRC_MCP=C:\Users\Admin\tradingview-mcp"
set "SRC_DATA=D:\co-pilot DATA"
set "SRC_RULES=D:\Claude Pro trading\Prop Trading"
set "SRC_SESS=C:\Users\Admin\sessions"

echo.
echo  ============================================================
echo   MNQ Co-Pilot  ^-^-^>  %ROOT%
echo  ============================================================
echo.
echo   This will COPY (not move):
echo     app         ^<- %SRC_APP%
echo     tv-mcp      ^<- %SRC_MCP%
echo     DATA        ^<- %SRC_DATA%
echo     rulebook    ^<- %SRC_RULES%
echo     sessions    ^<- %SRC_SESS%
echo.
echo   Your originals are NOT touched.
echo.
pause

REM ---------------------------------------------------------------- checks ---
if not exist "G:\" (
    echo.
    echo  [X] G: drive not found. Plug in the SSD and run this again.
    pause & exit /b 1
)
if not exist "%SRC_APP%\server.js" (
    echo  [X] Cannot find the app at %SRC_APP%
    pause & exit /b 1
)
if not exist "%SRC_MCP%\src\server.js" (
    echo  [X] Cannot find the TradingView MCP server at %SRC_MCP%
    pause & exit /b 1
)

echo.
echo  [1/7] Closing the Co-Pilot server if it is running...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM --------------------------------------------------------------- backup ---
echo.
echo  [2/7] BACKUP of your trading data (this happens before anything else)...
set "BK=%ROOT%\_backup_before_move"
if exist "%SRC_DATA%" (
    robocopy "%SRC_DATA%" "%BK%\co-pilot DATA" /E /R:2 /W:2 /NFL /NDL /NJH /NJS >nul
    if errorlevel 8 (
        echo  [X] BACKUP FAILED. Stopping — nothing else will be done.
        pause & exit /b 1
    )
    echo      OK - trading data backed up to %BK%
) else (
    echo      [!] %SRC_DATA% not found - skipping ^(check this^)
)

REM ----------------------------------------------------------------- copy ---
echo.
echo  [3/7] Copying the app ^(skipping node_modules^)...
robocopy "%SRC_APP%" "%ROOT%\app" /E /XD node_modules .git /R:2 /W:2 /NFL /NDL /NJH /NJS >nul
if errorlevel 8 ( echo  [X] App copy failed. & pause & exit /b 1 )
echo      OK

echo.
echo  [4/7] Copying the TradingView MCP server ^(skipping node_modules^)...
robocopy "%SRC_MCP%" "%ROOT%\tradingview-mcp" /E /XD node_modules .git /R:2 /W:2 /NFL /NDL /NJH /NJS >nul
if errorlevel 8 ( echo  [X] MCP copy failed. & pause & exit /b 1 )
echo      OK

echo.
echo  [5/7] Copying data, rulebook and sessions...
robocopy "%SRC_DATA%"  "%ROOT%\DATA"          /E /R:2 /W:2 /NFL /NDL /NJH /NJS >nul
robocopy "%SRC_RULES%" "%ROOT%\Prop Trading"  /E /R:2 /W:2 /NFL /NDL /NJH /NJS >nul
if exist "%SRC_SESS%" robocopy "%SRC_SESS%" "%ROOT%\sessions" /E /R:2 /W:2 /NFL /NDL /NJH /NJS >nul
echo      OK

REM ------------------------------------------------------- patch the paths ---
REM Four absolute paths are hardcoded in the source. Patched in the COPIES
REM only - the originals on C:/D: keep working exactly as they do today.
echo.
echo  [6/7] Repointing hardcoded paths in the new copy...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$r='%ROOT%';" ^
  "$f='%ROOT%\app\mcp-bridge.js';      (Get-Content $f -Raw) -replace [regex]::Escape('C:\\Users\\Admin\\tradingview-mcp\\src\\server.js'), ($r -replace '\\','\\')+'\\tradingview-mcp\\src\\server.js' | Set-Content $f -NoNewline;" ^
  "$f='%ROOT%\app\server.js';          (Get-Content $f -Raw) -replace [regex]::Escape('D:\\co-pilot DATA'), ($r -replace '\\','\\')+'\\DATA' | Set-Content $f -NoNewline;" ^
  "$f='%ROOT%\app\session-manager.js'; (Get-Content $f -Raw) -replace [regex]::Escape('C:\\Users\\Admin\\sessions'), ($r -replace '\\','\\')+'\\sessions' | Set-Content $f -NoNewline;"
if errorlevel 1 (
    echo  [!] Path patching reported a problem - check the three files by hand:
    echo      %ROOT%\app\mcp-bridge.js       line 5
    echo      %ROOT%\app\server.js           line 96
    echo      %ROOT%\app\session-manager.js  line 5
) else (
    echo      OK
)

echo.
echo      Verifying the patch actually applied:
findstr /C:"MCP_SERVER_PATH" "%ROOT%\app\mcp-bridge.js"
findstr /C:"DEFAULT_DATA_DIR" "%ROOT%\app\server.js"
findstr /C:"SESSIONS_DIR" "%ROOT%\app\session-manager.js"
echo.
echo      ^^ All three lines above should now say G:\MNQ-CoPilot\...
echo.

REM -------------------------------------------------------------- install ---
echo.
echo  [7/7] Installing dependencies fresh on G: ^(this takes a few minutes^)...
pushd "%ROOT%\app"
call npm install
popd
pushd "%ROOT%\tradingview-mcp"
call npm install
popd

REM --------------------------------------------------------------- finish ---
echo.
echo  ============================================================
echo   DONE.
echo  ============================================================
echo.
echo   New home:  %ROOT%
echo     app\              the Co-Pilot ^(run: node server.js^)
echo     tradingview-mcp\  chart control
echo     DATA\             trades, balances, transcripts, reviews
echo     Prop Trading\     CLAUDE.md rulebook + Pine file
echo     sessions\
echo     _backup_before_move\   safety copy of your trading data
echo.
echo   NEXT STEPS - do these before deleting anything:
echo     1. Launch:  cd /d %ROOT%\app  ^&^&  node server.js
echo     2. Check the browser opens and the account shows $51,203.
echo     3. Check TradingView connects ^(no red dot^).
echo     4. Run one full session from G: before deleting the originals.
echo     5. In Claude Cowork, re-add the new G: folders and remove the old ones.
echo.
echo   Your originals on C: and D: are untouched and still work.
echo.
pause
