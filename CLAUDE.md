# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **New to this project?** Read `HANDOVER.md` (repo root) after this file — it's the
> full cold-start handover: document map, module-by-module tour of `app/`, the complete
> WebSocket message table, on-disk data layout, known-broken/unverified list, and how to
> extend each subsystem. `ARCHITECTURE.md` and `AGENTS.md` are the deeper dives it indexes.

## ⚠️ THIS IS THE ONLY COPY — READ BEFORE TOUCHING ANYTHING

**`G:\MNQ-CoPilot` is the single, canonical, live copy of this project. Nowhere else.**
Anoop confirmed this explicitly on 2026-08-05: "everything should be only in this
[G:\MNQ-CoPilot], nowhere else... it should run from the desktop app location
Desktop MNQ co-pilot."

This matters because it has gone wrong twice already:
- 2026-07-31: everything was copied from C:\ and D:\ onto G:\ (script:
  `Prop Trading\_ARCHIVED_2026-08-05_DUPLICATE_USE_G_DRIVE\MOVE TO G DRIVE.bat`,
  preserved for history), but the old originals were never actually removed.
- 2026-08-05: a Claude session spent an entire debugging pass editing
  `C:\Users\Admin\Claude\Projects\MNQ-CoPilot-App` — a stale copy — before
  discovering the real server runs from here. Real fixes (Jessi's empty-reply
  bug, G5 restyle) had to be redone on this copy after the mistake was found.

**As of 2026-08-05, every other copy has been retired** (renamed/moved, never
deleted — see each location's own `README_START_HERE.md` for what to do with
it):
- `C:\Users\Admin\Claude\Projects\MNQ-CoPilot-App` — contents moved into
  `_ARCHIVED_2026-08-05_DUPLICATE_USE_G_DRIVE\` inside itself.
- `D:\Claude Pro trading\Prop Trading` — contents moved into
  `_ARCHIVED_2026-08-05_DUPLICATE_USE_G_DRIVE\` inside itself (was confirmed
  byte-identical to `G:\MNQ-CoPilot\Prop Trading` before archiving).
- `C:\Users\Admin\tradingview-mcp` → renamed to `tradingview-mcp_OLD_DUPLICATE_SEE_G_DRIVE`.
- `C:\Users\Admin\sessions` → renamed to `sessions_OLD_DUPLICATE_SEE_G_DRIVE`.
- Desktop shortcut "MNQ Co-Pilot" now points at `G:\MNQ-CoPilot\START CO-PILOT.bat`
  (any shortcut still pointing at C: was auto-retired as "... (OLD - do not use)").

**Before editing anything in a future session: confirm you're reading/writing
under `G:\MNQ-CoPilot`, not a path that merely looks similar.**

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

`app/` has a test suite (added 2026-08-06, grown steadily since): `cd app && npm test` runs Node's built-in test runner (`node --test`, no external framework) against `app/test/*.test.js` — 414 tests as of 2026-08-17. Covers pure-logic pieces pulled out of `server.js`/`groq-agent.js` as they're extracted: the fallback-loop cap decision, `size-freeze-guard.js`, `tv-broker-feed.js` (balance-delta-at-flat live P&L fold), `trade-confirm-rules.js`/`trade-confirm-dedup.js`/`trade-ticket-parse.js` (the Phase 2 confirm/execute flow), `amd-phase.js` (the PO3 mechanical phase detector), `verdict-grounding.js`, `go-verdict-detect.js`, `bias-tracker.js`, and more. Not exhaustive — extend it as more pure-logic pieces get pulled out.

## Architecture of `app/server.js` (~4000 lines, single file)

Everything is one process: a raw `http` server + `ws` WebSocketServer, no Express routing despite `express` being a listed dependency. Structure to know before editing:

- **Rules are data, not code.** `rules.json` at `app/rules.json` is the single source of truth for every discipline rule (size cap, trades/session, daily loss tiers, session windows, etc.) — `loadRules()`/`getActiveRules()` read it at runtime. Never hardcode a limit that already exists in `rules.json`; past bugs came from exactly that (a hardcoded `sizeCap` drifting out of sync with the file). `tradingMode` (`standard` | `scalper`) selects `scalperRules` as an overlay on top of the base rules.
- **Modes**: `eval` vs `funded` (persisted in `~/.mnq-copilot-config.json`, switched via `handleModeSwitch`) select which account's rules/data apply — this is separate from `tradingMode`/scalper.
- **WebSocket protocol**: all client↔server messages flow through the single `ws.on('message', ...)` handler (~line 427) which dispatches on `msg.key`/message type to `handle*` functions (`handleConfigSet`, `handleModeSwitch`, `handleJournalAdd`, `handleSessionStart`, `handleSessionTrade`, `handleScreenshot`, `handleEngulfToggle`, `handleFVGToggle`, `handleSFPToggle`, ...). `send(ws, obj)` / `broadcast(obj)` push back to client(s).
- **Two AI backends, not simple alternates**: `claude-agent.js` (`@anthropic-ai/sdk`) is the main "Jessi" analysis agent — mode-specific system prompts (`EVAL_RULES`/`FUNDED_RULES`/`SHARED_RULES`) plus `TV_TOOLS`/`BOOK_TOOLS` (via `books-index.js`) as Claude tool-use tools, calling TradingView through `mcp-bridge.js`. `groq-agent.js` is a multi-provider fallback (Groq, Gemini, local Ollama, with a `BLOCKED_TOOLS` set) also wired to `mcp-bridge.js`, used for voice turns (STT/TTS), scalper chat, and other lighter/alternate paths when Claude isn't wanted or available.
- **Live chart monitors** (`startEngulfMonitor`, `startFVGMonitor`, `startSFPMonitor`, `startPo3Monitor`, `startJessiTVMonitor`, `startMechanicalAnalysis`) poll TradingView via `mcpBridge` on a timer and push detections to clients. `withChartLock` serializes concurrent chart-reading calls so monitors don't race each other over the single TradingView connection. `startPo3Monitor` (2026-08-17) also auto-starts the moment TradingView connects (respecting an explicit manual OFF via `po3MonitorUserDisabled`) and now runs a secondary-symbol watch (`checkPo3SecondarySymbol`, MNQ↔MGC) alongside the primary — restore-safe via the same `withChartLock` discipline, unlike `batch_run` (confirmed broken, never restores chart state — see `tradingview-mcp/CLAUDE.md`).
- **Live trading — real orders can be placed.** `pollTVBrokerAccount()` reads the connected broker account via `tv-broker-feed.js` (balance-delta-at-flat P&L fold) and feeds the guardrail's live enforcement path. A semi-autonomous confirm/execute flow exists: the Debate feature's Judge can emit a machine-readable `TRADE_TICKET` line on a GO verdict, which surfaces a ticket in the UI; confirming it runs `handleTradeConfirm` — the ONLY code path that can call `tradingview-mcp`'s `trading_place_market_order`, gated by `trade-confirm-rules.js` (no override) and `trade-confirm-dedup.js` (double-submit guard) — and can also auto-trigger off the mechanical `amd-phase.js` PO3 phase detector leaving ACCUMULATION (`autoTriggerDebate`). See TODOS.md for what's live-verified vs. not before trusting any of this with real size.
- **`mcp-bridge.js`**: owns the child process for `tradingview-mcp/src/server.js`, plus a heartbeat (`HEARTBEAT_MS`) that independently verifies TradingView's CDP connection is alive (`tvConnected`), separate from whether the bridge's own child process is up (`ready`) — these two states diverged before and caused false "connected" indicators.
- **Crash guards** at the top of `server.js`: `uncaughtException`/`unhandledRejection` handlers log and deliberately keep the process alive rather than crash — this process runs monitors, Jessi, and the Telegram/TradingView bridges for a live trading session, so don't remove these or let a new code path be the one that finally takes it down.
- Other single-purpose modules: `session-manager.js` (session/account state persistence), `telegram-bot.js` (Telegram bridge — `notify()` for text, `notifyPhoto()` for a chart screenshot alongside a GO verdict), `tradovate.js` (Tradovate REST integration — largely superseded by the TradingView-broker-panel live feed), `books-index.js` (indexed reference material for Jessi), `edge-tts.js`/`local-tts.js` (cloud TTS + offline Windows SAPI fallback), `supercompress.js` (context/data compression helper), `amd-phase.js` (pure PO3 mechanical phase-detector, unit-tested, also reused by `tradingview-mcp/scripts/backtest-po3.js`), `tv-broker-feed.js`/`trade-confirm-rules.js`/`trade-confirm-dedup.js`/`trade-ticket-parse.js` (the live-feed + Phase 2 confirm/execute pieces above). `armed-detectors.js` (self-authored guardrails, 2026-08-25 — the Lessons tab can attach a bounded, machine-checkable condition to a lesson; promoting it ARMS a live check that fires on the same broadcast channel as `mistake-patterns.js`'s F1-F4. Templates only, never free-form logic, and capped at `MAX_ARMED` — read its header for why both ceilings exist before loosening either. Lessons persist to `DATA/lessons_log.json`; the server writes `fireCount`/`lastFiredAt` back, which is what lets the tab say "armed 3 weeks ago, never fired" instead of implying coverage). `journal-notes.js` (Daily Journal notes -> coaching context, 2026-08-25 — the Journal tab's mood/plan/mistake/lesson fields were write-only until this). `live-status.js` (pure renderer for `sessions/Now.md`, the live glance surface — a rewritten-whole projection of state, never a record; see its header for why it is not an append). `week-rollup.js` + `week-store.js` (the Week tab, 2026-08-29 — a weekend review surface. `week-rollup.js` is pure: it folds `gr_history`/`day_trades`/`balance_ledger`/`ck_history`/`notes` into one week, and its three load-bearing choices are documented in its header — the verdict is a **money × process quadrant** rather than a single score because Anoop's disc% and P&L are inversely correlated in his own data; an untraded weekday scores as a **win** (`heldFire`); and loss attribution is **mutually exclusive** by a fixed severity order, because flags overlap and summing per-flag P&L double-counts. It also reconciles the three P&L stores three-way and reports `disagreeDays` rather than silently picking one — which on its first run found that **`balance_ledger` is the wrong store on a mixed-`pnlBasis` day**: 2026-08-26 summed raw into both its gross and net fields, so commission was never charged, while `gr_history` (the output of `rollupDay()`) got it right. Money therefore reads `gr_history` first. `adherenceSplit()` answers “does discipline pay” **per contract, never per trade** — per-trade comparison across sizes measures how big he bet, not how well he traded, and reading his rows per-trade falsely suggests oversizing is his most profitable behaviour. `week-store.js` owns the disk: frozen weeks in `DATA/weekly/<slot>/<weekKey>.json` (immutable — the week he made a decision from must still say the same thing later), commitments graded only where machine-checkable, the never-regenerated doctrine, and `sessions/Week-<key>.md`. The server auto-freezes a finished week hourly, so the weekend note exists whether or not he opens the app.)

## Working conventions specific to this repo

- When changing any trading-rule number (size caps, loss tiers, trade limits), change it in `rules.json`, not in `server.js` — and check whether `Prop Trading/CLAUDE.md`'s documented rules need to move in lockstep (they've drifted out of sync before).
- Timestamps/session windows are IST wall-clock; `sessionWindowsIST` entries are minutes since midnight IST.
- This is a live production tool used during real trading sessions — prefer non-breaking, additive changes and keep the crash guards intact.

## Prompt/LLM changes

These files define what the AI agents actually say and enforce — they drive real trading-discipline decisions on a live-money account, so a bad edit here is higher-stakes than an equivalent bug in, say, a rendering helper.

**Files that count as "Prompt/LLM changes":**
- `app/claude-agent.js` — `EVAL_RULES`, `FUNDED_RULES`, `SHARED_RULES`, `buildSystemPrompt()`, `ALL_TOOLS` (tool schemas double as prompt content — the model reads tool descriptions as instructions).
- `app/server.js` — `JESSI_PERSONA`, `JESSI_PERSONA_VOICE`, `SCALPER_PERSONA`, `ANALYSIS_DEBATE_PERSONA`, `ICT_PO3_PERSONA`, `JUDGE_PERSONA`, `POST_SESSION_ANALYST_PERSONA`, `buildJessiContext()`, `formatAlignmentNotes()`, `JESSI_TOOLS`/`JESSI_TV_TOOLS`/`JESSI_APP_TOOLS`/`JESSI_VOICE_TOOL_NAMES`/`SCALPER_TOOLS` schemas.
- `app/renderer/app.js` — `buildContextMessage()` (client-built context for the Claude path).

**Before shipping a change to any of the above:**
1. **Read the diff aloud as if you were Jessi/the Scalper/the Judge receiving it.** Does it still say what you meant, or did a word change flip the meaning (e.g. "never" → "rarely")?
2. **Check for drift against `rules.json` and `Prop Trading/CLAUDE.md`.** Any concrete number (size caps, loss tiers, session windows) mentioned in prose must match `rules.json` — never hardcode a number in a persona/context string that already exists in `rules.json`.
3. **Manual smoke test, not a full eval suite** (this repo doesn't have one — see `## Running the app`'s test-suite note): run the app, trigger the specific agent/path you touched (text chat, voice, Scalper, Debate, Post-Session Analyst — whichever persona changed), and read the actual response. A prompt change with no observed response is unverified.
4. **If the change affects tool schemas** (`ALL_TOOLS`, `JESSI_TOOLS`, `SCALPER_TOOLS`, etc.): confirm token cost with `node token-audit.js` (uses the real tokenizer if `ANTHROPIC_API_KEY` is set, else a labeled estimate) and check `node token-usage-report.js` after a live session to confirm cache behavior wasn't broken (see `app/TOKEN_AUDIT_SETUP.md`).
5. **If the change is behavioral** (not just wording — e.g. changing when a persona escalates, what it's allowed to do via `app_do`), treat it like any other code change: state the failure mode it fixes or introduces, and prefer additive/reversible over rewriting a working persona wholesale.

No formal automated eval suite exists for prompt regressions today — this is a manual-verification convention, not a CI gate. If prompt-related bugs start recurring, that's the signal to build one (a fixed set of test conversations + expected-behavior assertions), not to skip step 3 above.

## GBrain Search Guidance (configured by /sync-gbrain)
<!-- gstack-gbrain-search-guidance:start -->

GBrain is set up and synced on this machine. The agent should prefer gbrain
over Grep when the question is semantic or when you don't know the exact
identifier yet.

**This worktree is pinned to a worktree-scoped code source** via the
`.gbrain-source` file in the repo root (kubectl-style context).
`gbrain code-def`, `code-refs`, `code-callers`, `code-callees`, `search`, and
`query` from anywhere under this worktree route to that source by default —
no `--source` flag needed (gbrain >= 0.41.38.0; on older gbrain the call-graph
commands need `--source "$(cat .gbrain-source)"`). Conductor sibling worktrees
of the same repo each have their own pin and their own indexed pages, so
semantic results match the code on disk here.

Call-graph queries (`code-callers`/`code-callees`) also need the graph to be
built first — run `/sync-gbrain --dream` (or `--full`) if they return
`count: 0`. This only works if this source's gbrain schema pack extracts code
symbols; on a non-code-aware pack `--dream` completes but the graph stays empty
and reports a WARN. `code-def`/`code-refs` need the same extraction.

Two indexed corpora available via the `gbrain` CLI:
- This worktree's code (auto-pinned via `.gbrain-source`).
- `~/.gstack/` curated memory (registered as `gstack-brain-<user>` source via
  the existing federation pipeline).

Prefer gbrain when:
- "Where is X handled?" / semantic intent, no exact string yet:
    `gbrain search "<terms>"` or `gbrain query "<question>"`
- "Where is symbol Y defined?" / symbol-based code questions:
    `gbrain code-def <symbol>` or `gbrain code-refs <symbol>`
- "What calls Y?" / "What does Y depend on?":
    `gbrain code-callers <symbol>` / `gbrain code-callees <symbol>`
- "What did we decide last time?" / past plans, retros, learnings:
    `gbrain search "<terms>" --source gstack-brain-<user>`

Grep is still right for known exact strings, regex, multiline patterns, and
file globs. Run `/sync-gbrain` after meaningful code changes; for ongoing
auto-sync across all worktrees, run `gbrain autopilot --install` once per
machine — gbrain's daemon handles incremental refresh on a schedule.

Safety: don't run `/sync-gbrain` while `gbrain autopilot` is active — the
orchestrator refuses destructive source ops when it detects a running autopilot
to avoid racing it (#1734). Prefer registering user repos with `gbrain sources
add --path <dir>` (no `--url`): URL-managed sources can auto-reclone, and the
sync code walk for them requires an explicit `--allow-reclone` opt-in.

<!-- gstack-gbrain-search-guidance:end -->
