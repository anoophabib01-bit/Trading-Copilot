@echo off
REM ============================================================================
REM  One-click launcher WITH TV_ALLOW_LIVE_ORDERS=1 set (2026-08-17).
REM
REM  This is the ONLY thing this file does differently from the normal
REM  "START CO-PILOT.bat" — it sets the env var, then calls that same script
REM  so there's only one copy of the actual launch logic to maintain.
REM
REM  TV_ALLOW_LIVE_ORDERS gates whether the confirm-and-execute trade flow can
REM  actually place a real order (see tradingview-mcp/src/tools/trading.js).
REM  It's deliberately NOT made permanent (no setx) — the choice of WHICH
REM  shortcut you double-click is what stands in for "did I mean to enable
REM  live orders this session," so it can never be silently left on. Use the
REM  plain "START CO-PILOT.bat" for a normal session where you don't intend
REM  to confirm/execute a real trade.
REM ============================================================================

set "TV_ALLOW_LIVE_ORDERS=1"
call "%~dp0START CO-PILOT.bat"
