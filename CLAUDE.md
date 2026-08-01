# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A personal trading co-pilot for Anoop Habib, trading MNQ (Micro Nasdaq) and MGC (Micro Gold) futures. It has three independently-runnable parts:

- **`app/`** — the actual product: a Node.js WebSocket/HTTP server ("MNQ Co-Pilot") that talks to Claude and Groq/Gemini for AI coaching ("Jessi"), bridges to a live TradingView Desktop chart via the `tradingview-mcp` subproject, and enforces Anoop's trading discipline rules. **This is what runs day-to-day.**
- **`tradingview-mcp/`** — a standalone MCP server that drives TradingView Desktop over the Chrome DevTools Protocol. It has its own `CLAUDE.md` with a full tool decision-tree — read that before touching anything under this directory. `app/mcp-bridge.js` spawns this as a child process; it is not a plain npm dependency of `app/`.
- **`Prop Trading/`** — non-code: trading rules, playbooks, checklists, session logs. Its `CLAUDE.md` is a living trading rulebook (not a coding doc) — only relevant if asked to reason about trading rules/strategy, not when editing `app/` code.

`DATA/` and `sessions/` hold runtime state (account fees, chat transcripts, session recordings) — not source.

## Running the app

There is no build step. The only supported launch path is the batch launcher at the repo root:

```
"START CO-PILOT.bat"
```

This kills any running TradingView/node processes, relaunches TradingView with `--remote-debugging-port=9222` (required for the CDP bridge — launching TradingView from the Start menu/taskbar breaks the connection), waits ~30s for it to boot, then runs `node server.js` from `app/`. The server listens on `http://localhost:7433`; the app is a plain browser page (a fresh Chrome window is opened at that URL), not a packaged app.

For iterating on server code directly, `app/launch.bat` kills anything on port 7433, starts `node server.js`, polls until the port is listening, then opens Chrome — or just:
```
cd app
node server.js
```

`app/main.js` + `preload.js` are an Electron shell (uses `app`, `BrowserWindow` from `electron`) but `electron` is **not** in `app/package.json` dependencies and is not part of the actual launch path above — treat as a secondary/legacy entry point, not the primary one.

### tradingview-mcp (separate project)
```
cd tradingview-mcp
npm test            # runs e2e + pine_analyze tests
npm run test:unit   # pine_analyze + cli tests only (no live TradingView needed)
npm run test:e2e    # requires a live TradingView Desktop instance with CDP on :9222
```
See `tradingview-mcp/CLAUDE.md` for the full tool-by-tool guide.

There is no test suite for `app/`.

## Architecture of `app/server.js` (~4000 lines, single file)

Everything is one process: a raw `http` server + `ws` WebSocketServer, no Express routing despite `express` being a listed dependency. Structure to know before editing:

- **Rules are data, not code.** `rules.json` at `app/rules.json` is the single source of truth for every discipline rule (size cap, trades/session, daily loss tiers, session windows, etc.) — `loadRules()`/`getActiveRules()` read it at runtime. Never hardcode a limit that already exists in `rules.json`; past bugs came from exactly that (a hardcoded `sizeCap` drifting out of sync with the file). `tradingMode` (`standard` | `scalper`) selects `scalperRules` as an overlay on top of the base rules.
- **Modes**: `eval` vs `funded` (persisted in `~/.mnq-copilot-config.json`, switched via `handleModeSwitch`) select which account's rules/data apply — this is separate from `tradingMode`/scalper.
- **WebSocket protocol**: all client↔server messages flow through the single `ws.on('message', ...)` handler (~line 427) which dispatches on `msg.key`/message type to `handle*` functions (`handleConfigSet`, `handleModeSwitch`, `handleJournalAdd`, `handleSessionStart`, `handleSessionTrade`, `handleScreenshot`, `handleEngulfToggle`, `handleFVGToggle`, `handleSFPToggle`, ...). `send(ws, obj)` / `broadcast(obj)` push back to client(s).
- **Two AI backends, not simple alternates**: `claude-agent.js` (`@anthropic-ai/sdk`) is the main "Jessi" analysis agent — mode-specific system prompts (`EVAL_RULES`/`FUNDED_RULES`/`SHARED_RULES`) plus `TV_TOOLS`/`BOOK_TOOLS` (via `books-index.js`) as Claude tool-use tools, calling TradingView through `mcp-bridge.js`. `groq-agent.js` is a multi-provider fallback (Groq, Gemini, local Ollama, with a `BLOCKED_TOOLS` set) also wired to `mcp-bridge.js`, used for voice turns (STT/TTS), scalper chat, and other lighter/alternate paths when Claude isn't wanted or available.
- **Live chart monitors** (`startEngulfMonitor`, `startFVGMonitor`, `startSFPMonitor`, `startPo3Monitor`, `startJessiTVMonitor`, `startMechanicalAnalysis`) poll TradingView via `mcpBridge` on a timer and push detections to clients. `withChartLock` serializes concurrent chart-reading calls so monitors don't race each other over the single TradingView connection.
- **`mcp-bridge.js`**: owns the child process for `tradingview-mcp/src/server.js`, plus a heartbeat (`HEARTBEAT_MS`) that independently verifies TradingView's CDP connection is alive (`tvConnected`), separate from whether the bridge's own child process is up (`ready`) — these two states diverged before and caused false "connected" indicators.
- **Crash guards** at the top of `server.js`: `uncaughtException`/`unhandledRejection` handlers log and deliberately keep the process alive rather than crash — this process runs monitors, Jessi, and the Telegram/TradingView bridges for a live trading session, so don't remove these or let a new code path be the one that finally takes it down.
- Other single-purpose modules: `session-manager.js` (session/account state persistence), `telegram-bot.js` (Telegram bridge), `tradovate.js` (Tradovate integration), `books-index.js` (indexed reference material for Jessi), `edge-tts.js`/`local-tts.js` (cloud TTS + offline Windows SAPI fallback), `supercompress.js` (context/data compression helper).

## Working conventions specific to this repo

- When changing any trading-rule number (size caps, loss tiers, trade limits), change it in `rules.json`, not in `server.js` — and check whether `Prop Trading/CLAUDE.md`'s documented rules need to move in lockstep (they've drifted out of sync before).
- Timestamps/session windows are IST wall-clock; `sessionWindowsIST` entries are minutes since midnight IST.
- This is a live production tool used during real trading sessions — prefer non-breaking, additive changes and keep the crash guards intact.
