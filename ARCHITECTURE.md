# MNQ Co-Pilot — Architecture Overview

This document explains how the whole app fits together for someone who has never
seen the codebase: the process model, the WebSocket protocol, and the path a
message takes from a click in the browser to a real trade on TradingView.
For per-agent detail (personas, prompts, tools), see `AGENTS.md`.

## What this is

A personal trading co-pilot for MNQ (Micro Nasdaq) and MGC (Micro Gold) futures.
It watches a live TradingView Desktop chart, enforces hand-authored discipline
rules, and runs several purpose-built LLM "agents" (an AI coach, a debate panel,
a scalping specialist, a post-session analyst) that read that chart and the
trader's own data to produce coaching output — and, on a strict opt-in path, can
place real market orders.

## Process model

There is no build step and no framework routing — it's one long-running Node
process plus one child process:

```
"START CO-PILOT.bat"
  → launches TradingView Desktop with --remote-debugging-port=9222 (CDP)
  → waits ~30s for it to boot
  → node app/server.js         (main process, listens on :7433)
       └─ spawns tradingview-mcp/src/server.js as a child process
            (communicates via newline-delimited JSON-RPC over stdio)
            └─ drives TradingView Desktop over Chrome DevTools Protocol
  → opens a plain browser window at http://localhost:7433
```

`app/server.js` is a raw `http` server + `ws` WebSocketServer (~4000+ lines,
single file) — `express` is a listed dependency but there is no Express
routing. The browser UI (`app/renderer/index.html` + `app.js` + `ws-client.js`)
is a plain page, not a packaged Electron app; `app/main.js`/`preload.js` are a
secondary/legacy Electron shell not used by the primary launch path.

## The WebSocket protocol

Every client→server interaction — chat messages, mode switches, config
changes, session logging, screenshot requests, trade confirmations — flows
through **one** dispatcher:

```
client (app.js / ws-client.js)
  → ws.on('message', ...)  in server.js (~line 427)
      dispatches on msg.key / message type
  → handle*() functions (handleChat, handleJessiChat, handleDebateChat,
    handlePostSessionReview, handleScalperChat, handleTradeConfirm,
    handleModeSwitch, handleConfigSet, handleSessionStart/Trade,
    handleScreenshot, handleEngulfToggle/FVGToggle/SFPToggle, ...)
```

`send(ws, obj)` replies to one client; `broadcast(obj)` pushes to all
connected clients. The server also runs its own timers (chart monitors,
broker polling) that `broadcast()` unsolicited updates — the client doesn't
have to ask.

## Rules are data, not code

`app/rules.json` is the single source of truth for every discipline number
(size cap, trades/session, daily loss tiers, session windows in IST minutes,
etc.). `loadRules()`/`getActiveRules()` read it at runtime; `tradingMode`
(`standard` | `scalper`) selects `scalperRules` as an overlay. **No agent
persona or prompt should ever hardcode a number that already lives here** —
past bugs came from exactly that drift.

Two independent axes select state:
- **`mode`** (`eval` | `funded`) — which account's rules/data apply, persisted
  in `~/.trading-copilot-config.json`, switched via `handleModeSwitch`.
- **`tradingMode`** (`standard` | `scalper`) — whether the Scalper overlay is
  active. Independent of `mode`.

## One AI backend  *(consolidated 2026-09-02)*

Every persona in `AGENTS.md` runs on **DeepSeek**
(`deepseek-v4-flash-vision-exp`). Anthropic, Groq, OmniRoute and local Ollama
were removed; so were `app/anthropic-native.js` and the `@anthropic-ai/sdk`
dependency.

- **`app/claude-agent.js`** — prompts and tool schemas ONLY. It defines
  `EVAL_RULES`, `FUNDED_RULES`, `SHARED_RULES`, `buildSystemPrompt()` and
  `TV_TOOLS`/`BOOK_TOOLS` → `ALL_TOOLS`, which other agents reuse via `_debug`.
  It no longer talks to any API and holds no client.
- **`app/groq-agent.js`** — the actual execution engine for every persona. Its
  name is now historical: it is the single provider-agnostic transport.
  `stream()` builds the fail-open chain from `app/provider-chain.js`
  (`deepseek-v4-flash-vision-exp` → `deepseek-v4-flash` → `gemini-3.5-flash`,
  Gemini being break-glass only), parses one OpenAI-shaped SSE stream — no
  translation layer is needed any more, since both remaining providers speak it
  natively — and runs the tool-execution loop,
  dispatching each tool call to either a custom `toolExecutor` (e.g. the
  Scalper's notebook tools) or straight through to `mcpBridge.callTool(name,
  args)`. `BLOCKED_TOOLS` prevents specific tools from reaching specific
  providers/personas (e.g. no chart-mutating tools in voice mode).

## The TradingView bridge

`app/mcp-bridge.js` owns the child process for `tradingview-mcp/src/server.js`
and exposes two **independently tracked** health signals that have diverged
before and caused real bugs:

- **`ready`** — the bridge's own child process is up and has completed its
  JSON-RPC handshake.
- **`tvConnected`** — a 30-second heartbeat (`tv_health_check`) independently
  confirms the CDP socket to TradingView Desktop is actually alive.

The UI's "TradingView connected" indicator (`mcp-status`, `tv-status-text`)
is gated on `ready && tvConnected` — i.e. it proves the **chart** is
reachable. It does **not** prove the **broker account/Trading Panel** is
readable — see the note below, this exact conflation caused a live bug fixed
2026-08-18 (see `TODOS.md`).

`tradingview-mcp` (a standalone MCP server, own `CLAUDE.md`) then drives
TradingView Desktop over CDP on port 9222: chart state/quotes/OHLCV, Pine
line/label/table/box readers, drawing, alerts, indicator management, replay
mode, and — gated to a single caller — `trading_place_market_order`. Two
tools are documented as broken/unreliable in its own `CLAUDE.md`:
`batch_run` (never restores chart state) and `alert_create` (price-setting
unreliable).

Auto-recovery (`_attemptTVRecovery`) relaunches TradingView when the
heartbeat sees CDP drop — session-window-aware (destructive relaunch outside
trading hours, non-destructive `tv_launch{kill_existing:false}` inside) —
but only re-verifies CDP, not the broker panel, before declaring
`tv-connected` again.

## Live chart monitors

Several timers poll TradingView on their own schedule and push detections to
clients: `startEngulfMonitor`, `startFVGMonitor`, `startSFPMonitor`,
`startPo3Monitor`, `startJessiTVMonitor`, `startMechanicalAnalysis`.
`withChartLock` serializes every chart-reading/mutating call so these
monitors — and order placement — never race each other over the single
TradingView connection.

`startPo3Monitor` polls `app/amd-phase.js` (pure mechanical PO3 phase
detector, no AI) every ~60s. Its ACCUMULATION→MANIPULATION/DISTRIBUTION
transition can auto-fire the Debate agent panel (`autoTriggerDebate`,
cooldown-gated) — this is the one place an agent invocation is triggered by
market structure rather than a user action.

## Live trading — real orders can be placed

`pollTVBrokerAccount()` polls the connected broker account (via
`app/tv-broker-feed.js`'s balance-delta-at-flat P&L fold) every 10s and feeds
the guardrail's live enforcement path (`size-freeze-guard.js`, cooldowns,
size caps).

A semi-autonomous confirm/execute flow exists end-to-end:

```
Judge agent emits a machine-readable TRADE_TICKET line on a GO verdict
  → trade-ticket-parse.js parses it (symbol is NEVER trusted from LLM text —
    always resolved live server-side at confirm time)
  → trade-ticket-suggested WS message surfaces a ticket card in the UI
  → user clicks Confirm → handleTradeConfirm (server.js), the ONLY code path
    that can call tradingview-mcp's trading_place_market_order:
      1. trade-confirm-dedup.js — double-submit/replay guard (check-and-mark
         synchronous, before any await)
      2. TV_ALLOW_LIVE_ORDERS env gate
      3. TradingView-connected check
      4. trade-confirm-rules.js — checkTradeAllowed(rules, stage, trades, qty)
         — a NO-OVERRIDE rules gate reusing size-freeze-guard's
         sizeUpAfterLossViolation check
      5. consume the verdict (dedup can't be replayed)
      6. withChartLock resolves the live symbol and calls
         trading_place_market_order atomically
      7. logs to disk BEFORE notifying the client
  → trade-confirm-result sent back to client
```

`amd-phase.js`'s PO3 phase detector can also auto-trigger the Debate panel
(`autoTriggerDebate`), which is how a GO verdict — and therefore a
`TRADE_TICKET` — can originate from market structure rather than a user
question.

See `TODOS.md` for what parts of this flow are live-verified vs. still
flagged as unverified (in particular: the balance-delta P&L math itself has
never been checked against a real non-zero-P&L closed trade).

## Crash guards

`uncaughtException`/`unhandledRejection` handlers at the top of `server.js`
log and deliberately **keep the process alive** rather than crash — this
process runs monitors, the AI agents, and the Telegram/TradingView bridges
for a live trading session. Any new code path added to this file must not be
the one that finally brings the process down.

## Supporting modules (pure logic, not AI)

| Module | Role |
|---|---|
| `session-manager.js` | Session/account state persistence (start/log/read/list) |
| `telegram-bot.js` | Telegram bridge (`notify()` text, `notifyPhoto()` chart+verdict); its two-way chat was repointed onto the shared DeepSeek transport 2026-09-02 and is dormant (no bot token) |
| `tradovate.js` | Tradovate REST integration — largely superseded by the TradingView broker-panel live feed |
| `books-index.js` | Offline keyword-chunk search over reference trading books, backs `search_books` for every persona |
| `edge-tts.js` / `local-tts.js` | Cloud TTS + offline Windows SAPI fallback for voice mode |
| `amd-phase.js` | Pure PO3 mechanical phase detector (ACCUMULATION/MANIPULATION/DISTRIBUTION/UNCLEAR), unit-tested, also reused by `tradingview-mcp/scripts/backtest-po3.js` |
| `tv-broker-feed.js` | Pure balance-delta-at-flat P&L fold from broker account polling |
| `trade-confirm-rules.js` | Pure no-override trade-allow gate |
| `trade-confirm-dedup.js` | Pure double-submit/replay guard |
| `trade-ticket-parse.js` | Pure regex parser for the Judge's `TRADE_TICKET:` line |
| `bias-tracker.js` | Declared-bias-vs-actual-trades adherence matrix |
| `journey-tracker.js` | Eval→funded account lifecycle events (breach/cleared/payout) |
| `points-tracker.js` | Trade-quality scoring/summarization helpers |
| `chat-intent.js` | Advisory-only heuristic: flags a chat/mode mismatch, never rewrites a prompt |
| `go-verdict-detect.js` | One-line heuristic gate: does this text count as a GO verdict |
| `chart-reads.js` | Pure arithmetic chart reads (EMA, doji, swing structure, alignment) fed into the Analysis debate agent |
| `stage-rules.js` | Applies eval/funded stage tightening to `rules.json` values |
| `post-session-orchestrator.js` | Decides which pattern-check sub-agent personas to dispatch post-session (orchestrator-workers pattern) |
| `provider-chain.js` | Central LLM-provider routing policy used by every `groqAgent.stream()` call |
| `crash-logger.js` | Mirrors console output to rotated log files, loaded first |
| `account-db.js` | Rebuilds a consolidated account DB/CSV/HTML report from per-slot JSON, offline reporting only |
| `atomic-write.js` | Crash-safe file writes used throughout |

## Where to look next

- **Per-agent detail** (personas, exact system prompts, tools, triggers,
  downstream consumers): `AGENTS.md`
- **TradingView MCP tool-by-tool guide**: `tradingview-mcp/CLAUDE.md`
- **Trading rulebook** (not code): `Prop Trading/CLAUDE.md`
- **Known gaps / in-flight work**: `TODOS.md`
