@echo off
setlocal
title Co-Pilot cleanup - remove old C: copies
color 0E

REM ============================================================================
REM  Removes the OLD app + MCP + sessions folders from C:.
REM  Built 2026-07-31, after the move to G:\MNQ-CoPilot was verified working.
REM
REM  ONLY CODE IS REMOVED HERE. Nothing irreplaceable is touched:
REM    - D:\co-pilot DATA          NOT touched (your trades/balances)
REM    - D:\Claude Pro trading     NOT touched (rulebook)
REM  Everything deleted below exists on G: and can be copied back.
REM
REM  Renames to *_OLD first, so you can verify the app still runs before the
REM  real delete. Two stages on purpose.
REM ============================================================================

echo.
echo  Stage 1: rename the old C: folders (reversible)
echo  Stage 2: delete them for good (run this script again and choose 2)
echo.
echo   1 = RENAME to *_OLD  (safe, reversible)
echo   2 = DELETE the *_OLD folders permanently
echo   3 = Undo a rename (put them back)
echo.
set /p CH=Choose 1, 2 or 3:

if not exist "G:\MNQ-CoPilot\app\server.js" (
    echo.
    echo  [X] G:\MNQ-CoPilot\app\server.js not found.
    echo      Refusing to touch C: while the G: copy is missing.
    pause & exit /b 1
)

echo.
echo  Closing any running server first...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

if "%CH%"=="1" goto RENAME
if "%CH%"=="2" goto DELETE
if "%CH%"=="3" goto UNDO
echo Invalid choice. & pause & exit /b 1

:RENAME
if exist "C:\Users\Admin\Claude\Projects\MNQ-CoPilot-App" ren "C:\Users\Admin\Claude\Projects\MNQ-CoPilot-App" "MNQ-CoPilot-App_OLD"
if exist "C:\Users\Admin\tradingview-mcp"                  ren "C:\Users\Admin\tradingview-mcp"                  "tradingview-mcp_OLD"
if exist "C:\Users\Admin\sessions"                         ren "C:\Users\Admin\sessions"                         "sessions_OLD"
echo.
echo  Renamed. Now launch the app from G: and run a normal session.
echo  If anything breaks, run this script again and choose 3 to undo.
echo  Once you are happy, run it again and choose 2 to delete for good.
goto END

:DELETE
echo.
echo  This permanently deletes the *_OLD folders on C:. No undo.
set /p OK=Type YES to confirm:
if /I not "%OK%"=="YES" ( echo Cancelled. & goto END )
if exist "C:\Users\Admin\Claude\Projects\MNQ-CoPilot-App_OLD" rmdir /S /Q "C:\Users\Admin\Claude\Projects\MNQ-CoPilot-App_OLD"
if exist "C:\Users\Admin\tradingview-mcp_OLD"                 rmdir /S /Q "C:\Users\Admin\tradingview-mcp_OLD"
if exist "C:\Users\Admin\sessions_OLD"                        rmdir /S /Q "C:\Users\Admin\sessions_OLD"
echo  Deleted. G:\MNQ-CoPilot is now the only copy of the app.
goto END

:UNDO
if exist "C:\Users\Admin\Claude\Projects\MNQ-CoPilot-App_OLD" ren "C:\Users\Admin\Claude\Projects\MNQ-CoPilot-App_OLD" "MNQ-CoPilot-App"
if exist "C:\Users\Admin\tradingview-mcp_OLD"                 ren "C:\Users\Admin\tradingview-mcp_OLD"                 "tradingview-mcp"
if exist "C:\Users\Admin\sessions_OLD"                        ren "C:\Users\Admin\sessions_OLD"                        "sessions"
echo  Restored.
goto END

:END
echo.
echo  REMINDER - still deliberately kept:
echo     D:\co-pilot DATA        your only off-G copy of trades/balances
echo     D:\Claude Pro trading   rulebook
echo  Delete these ONLY after one full session from G: AND a backup that is
echo  not on the G: drive.
echo.
pause
