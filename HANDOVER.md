# MNQ Co-Pilot — Handover

**Audience:** an AI agent (or engineer) picking this project up cold, with no prior
session context, expected to understand every part of it and build further.

**Written:** 2026-08-20. Facts below were verified against the working tree on that
date; treat line numbers as approximate anchors, not guarantees.

---

## 0. Read this first: the one-copy rule

`G:\MNQ-CoPilot` is the **only** live copy of this project. Every other copy on this
machine has been archived (see `CLAUDE.md` for the full list and the two incidents
that made this necessary — one where an entire debugging session was spent editing a
stale copy on `C:\`, and the fixes had to be redone here).

Before your first edit in any session: confirm the absolute path you are writing to
starts with `G:\MNQ-CoPilot`.

## 0.1 What kind of software this is

A **personal, single-user, live-money trading tool** for Anoop Habib, trading MNQ
(Micro Nasdaq) and MGC (Micro Gold) futures. It:

- watches a live TradingView Desktop chart over Chrome DevTools Protocol,
- enforces hand-authored trading-discipline rules,
- runs ~10 purpose-built LLM agents (coach, debate panel, scalper, post-session analyst),
- and, on a strict opt-in path, **can place real market orders on a real account**.

Consequences for how you work:
- A bug here can lose real money. Prefer additive, reversible changes.
- The crash guards at the top of `app/server.js` (`uncaughtException` /
  `unhandledRejection` that log and deliberately *keep the process alive*) exist
  because this process runs monitors and bridges during a live session. Never remove them.
- There is no CI, no staging, no build step. Verification is `npm test` plus running
  the real app.

## 0.2 The document map

| File | What it holds | When to read it |
|---|---|---|
| `CLAUDE.md` (root) | Canonical agent instructions: one-copy rule, launch path, conventions, the Prompt/LLM-change checklist. | Every session, first. |
| `ARCHITECTURE.md` | Process model, WebSocket protocol, click→trade data flow. | Before touching `server.js`. |
| `AGENTS.md` | Per-agent reference: trigger, handler, backend, prompt location, tools, output, for all ten LLM agents. | Before touching any persona/prompt/tool schema. |
| `TODOS.md` | What is built vs. what is **live-verified**. Also records known-broken things (`batch_run`, `alert_create` price-setting). | Before trusting any subsystem, especially trading. |
| `TRUST-PROTOCOL.md` | The anti-fabrication rules, written after agents invented trade data and shipped subtly-wrong numbers. | Before writing anything that reports numbers to the user. |
| `SEMI_AUTONOMOUS_SYSTEM_PLAN.md`, `PHASE2_SEMI_AUTONOMOUS_SPEC.md`, `FULL_AUTONOMOUS_SYSTEM_PLAN.md`, `MISTAKE_PATTERNS_PLAN.md` | Design docs for the autonomy roadmap, in increasing order of ambition. | When extending the trading-automation path. |
| `tradingview-mcp/CLAUDE.md` | Full tool-by-tool decision tree for the chart driver. | Before touching anything under `tradingview-mcp/`. |
| `Prop Trading/CLAUDE.md` | The **trading rulebook** (not a coding doc). | Only when reasoning about trading rules/strategy. |
| `app/USER_GUIDE.md`, `app/TOKEN_AUDIT_SETUP.md` | End-user guide; token-cost tooling setup. | As needed. |

This handover is the index. The files above are the detail; do not duplicate their
contents into new documents — extend them in place.

---

## 1. Repository layout

```
G:\MNQ-CoPilot\
├── START CO-PILOT.bat              ← the ONLY supported launch path
├── START CO-PILOT (LIVE ORDERS).bat← same, with TV_ALLOW_LIVE_ORDERS=1
├── CLAUDE.md ARCHITECTURE.md AGENTS.md TODOS.md TRUST-PROTOCOL.md HANDOVER.md
├── app/                            ← THE PRODUCT (Node server + browser UI)
├── tradingview-mcp/                ← standalone MCP server driving TradingView over CDP
├── Prop Trading/                   ← non-code: rules, playbooks, session logs
├── DATA/                           ← runtime state (default DATA_DIR)
├── sessions/                       ← session recordings
├── roster.json, roster-backups/    ← account roster
├── hive/                           ← auxiliary/experimental
└── _backups/, _backup_before_move/ ← historical, do not edit
```

Three parts run independently: `app/` (day-to-day product), `tradingview-mcp/` (its own
npm project with its own tests), `Prop Trading/` (documents only).

### 1.1 A note on `.bak` files

`app/` and `app/renderer/` contain many `*.bak`, `*.pre-<feature>.bak`, `*.synccheck`
files. These are historical snapshots, **not** live code and not loaded by anything.
The live files are exactly: `server.js`, `renderer/app.js`, `renderer/index.html`,
`renderer/styles.css`, `renderer/ws-client.js`, and the modules listed in §3.
When searching, exclude `*.bak` or you will read dead code and "fix" nothing.

---

## 2. Running it

**Primary path (what Anoop uses):**

```
"G:\MNQ-CoPilot\START CO-PILOT.bat"
```

This batch file: kills any running TradingView/node processes → relaunches TradingView
Desktop with `--remote-debugging-port=9222` → waits ~30s for boot → runs `node server.js`
from `app/` → opens Chrome at `http://localhost:7433`.

**The CDP port is not optional.** Launching TradingView from the Start menu or taskbar
starts it *without* `--remote-debugging-port=9222`, and the entire chart bridge silently
fails to connect. Nearly every "TradingView isn't working" report traces back to this.

**Iterating on server code only:**

```
cd G:\MNQ-CoPilot\app
node server.js            # or: launch.bat  (kills :7433, starts, polls, opens Chrome)
```

**Live orders** are gated by the environment variable `TV_ALLOW_LIVE_ORDERS`. The plain
launcher does not set it; `START CO-PILOT (LIVE ORDERS).bat` does. Never set it in code
or in a default.

**Anoop decision 2026-09-09:** `START CO-PILOT (LIVE ORDERS).bat` is the operative default
for his sessions — the oversize guard must have hands (`canAct: true`), not alarm-only.

**Tests:**

```
cd app && npm test                  # node --test against app/test/*.test.js
cd tradingview-mcp && npm run test:unit   # no live TradingView needed
cd tradingview-mcp && npm run test:e2e    # REQUIRES live TradingView on :9222
```

`app/npm test` uses Node's built-in test runner — no Jest, no Mocha, no external
framework. As of 2026-08-20, `TODOS.md` reports 454 passing tests across 28 test files.

**Process supervision:** `app/watchdog.bat` / `app/watchdog.js` is a standalone,
dependency-free watchdog that polls `:7433` every 45s and relaunches once with a 5-minute
cooldown. It is **deliberately not auto-started** by the main launcher, so a bug in the
watchdog can never block the app from starting. Starting it is a separate manual step.

---

## 3. `app/` — module-by-module

### 3.1 The core process

**`server.js` (~6,300 lines, single file).** A raw `http` server + `ws` `WebSocketServer`.
`express` is a listed dependency but there is **no Express routing** — do not add any;
match the existing style. Everything is one process. Structure:

- **Crash guards** (top of file) — keep the process alive on uncaught errors. Do not remove.
- **`CONFIG_PATH`** = `~/.mnq-copilot-config.json` — holds `apiKey`, `dataDir`, current
  `mode`, etc. Read via `loadConfig()`, written via `atomic-write.js`.
- **Static file server** (~line 687) — serves `renderer/` over plain HTTP. `/` → `index.html`.
- **The single WebSocket dispatcher** at `ws.on('message', ...)` (~line 774) — a `switch`
  on `msg.type` (see §4 for the full table). Every client→server interaction goes here.
- **`send(ws, obj)` / `broadcast(obj)` / `emitTo(ws, obj)`** — reply to one client, push to
  all, or push to all when `ws` is null (used by system-initiated flows like `autoTriggerDebate`).
- **Handler functions** — `handleChat`, `handleJessiChat`, `handleDebateChat`,
  `handlePostSessionReview`, `handleScalperChat`, `handleJessiVoiceSend`, `handleIctPo3`,
  `handleTradeConfirm`, `handleModeSwitch`, `handleConfigSet`, `handleSessionStart/Trade`,
  `handleScreenshot`, `handleJournalAdd`, `handleChecklistDone`, `handleJourneyAction/List`,
  `handleAccountDbRebuild`, `handleEngulfToggle`/`handleFVGToggle`/`handleSFPToggle`,
  `handleMCPCall`, `handleTtsSpeak`, `handleCancelRequest`, `handleTvTest`.
- **Background monitors** (server-owned timers that `broadcast()` unsolicited) —
  `startEngulfMonitor`, `startFVGMonitor`, `startSFPMonitor`, `startPo3Monitor`,
  `startJessiTVMonitor`, `startMechanicalAnalysis`, `startNewsTracking`,
  `startTVBrokerMonitor`, `startEndDayAutosaveWatch`, `startSessionPrepScheduler`,
  `startTradovate`, `startMCP`.
- **Personas / prompt strings** — `JESSI_PERSONA`, `JESSI_PERSONA_VOICE`, `SCALPER_PERSONA`,
  `ANALYSIS_DEBATE_PERSONA`, `ICT_PO3_PERSONA`, `JUDGE_PERSONA`,
  `POST_SESSION_ANALYST_PERSONA`, plus `buildJessiContext()`, `formatAlignmentNotes()`,
  `formatLiveFeedContext()`. See §6 before editing any of these.

**`withChartLock`** serializes concurrent chart-reading calls. There is exactly one
TradingView connection; without the lock the monitors race each other and corrupt each
other's chart state. Any new code that reads or writes the chart **must** go through it.

### 3.2 AI backend  *(single provider since 2026-09-02)*

Every AI call site in the app runs on **DeepSeek**, model
`deepseek-v4-flash-vision-exp`. Anthropic, Groq, OmniRoute and local Ollama were
removed in the consolidation — Anoop's reason was that five providers behind four
key fields with non-obvious precedence "is creating a lot of confusion".

- **`groq-agent.js`** — despite the name, this is now the single
  provider-agnostic transport: OpenAI-shaped request, SSE parser, and the
  tool-execution loop shared by every persona. Holds `BLOCKED_TOOLS` (trade
  execution can never be reached from a chat reply) and the DeepSeek request
  branch.
  - **It sends `thinking: {type:'disabled'}` and floors `max_tokens` at 8192.
    Do not remove either without the other.** DeepSeek V4 streams
    `reasoning_content` out of the SAME budget as the visible answer; at 4096 a
    heavy prompt spends the whole ceiling thinking and returns **zero content on
    a 200 OK**, which the transport reads as a dead model and fails over. That
    happened live on 2026-09-02 (the Power-of-3 debate agent silently swapped to
    Gemini). Re-enabling thinking requires raising `max_tokens` to ~16000.
    Pinned by `test/deepseek-request.test.js`.
- **`provider-chain.js`** — pure, unit-tested provider selection. DeepSeek
  primary, then `deepseek-v4-flash` → `gemini-3.5-flash`. The first step stays
  inside DeepSeek so a retired `-exp` model ID is survivable without changing
  vendor mid-verdict; **Gemini is break-glass only**, kept at Anoop's request for
  "credits ran out" / vendor outage.
  - **TWO REGISTRIES MUST AGREE**: `provider-chain.js`'s `KNOWN_PROVIDERS` and
    `groq-agent.js`'s `VALID_PROVIDERS`. A provider in one and not the other is
    **skipped, not rejected** (`pushCandidate` skips unknown providers), so a
    configured paid key can serve zero requests while the console says it
    loaded. `provider-chain.test.js` cross-checks the two real arrays.
- **`claude-agent.js`** — **no longer an agent.** Kept its filename; contains only
  `EVAL_RULES`, `FUNDED_RULES`, `SHARED_RULES`, `buildSystemPrompt()` and the
  `TV_TOOLS` + `BOOK_TOOLS` = `ALL_TOOLS` schemas, imported via `_debug` by
  `handleChat` and `telegram-bot.js` (converted Anthropic→OpenAI tool shape
  inline) so there is exactly one copy of the Claude-path prompt in the repo.
  The SDK client, `stream()` and the cache breakpoints are gone, as is
  `anthropic-native.js` and the `@anthropic-ai/sdk` dependency.
- **Fallback is ALARMED, not logged.** `modelBadgeHtml()` in `renderer/app.js`
  flags any reply not from DeepSeek with an amber FALLBACK badge plus a
  one-per-target chat notice. It lives there because that one function is what
  every agent surface renders through — the Debate path never passed
  `onFallback` at all, which is why the 2026-09-02 swap was silent.
- **Voice needs no speech vendor**: STT is the browser's own recognition
  (`msg.transcript`), TTS is Edge neural → local Windows SAPI → browser voice.
  DeepSeek has no audio API; Groq Whisper/Orpheus are gone.

- **`call-logger.js`** — writes `token-usage.jsonl` into the resolved `DATA_DIR`.
- **`token-audit.js` / `token-usage-report.js`** — cost tooling (see `TOKEN_AUDIT_SETUP.md`).
- **`supercompress.js`** — context/data compression helper.
- **`books-index.js`** — indexed reference library backing the `search_books` tool.

### 3.3 The TradingView bridge

- **`mcp-bridge.js`** — spawns `tradingview-mcp/src/server.js` as a **child process** and
  speaks newline-delimited JSON-RPC over stdio. `tradingview-mcp` is *not* an npm
  dependency of `app/`; it is a sibling project launched by path.
  It tracks **two independent states**: `ready` (our child process is up) and `tvConnected`
  (a heartbeat, `HEARTBEAT_MS`, independently confirms TradingView's CDP is alive). These
  two diverged in the past and produced a false "connected" indicator — keep them separate.
- **`chart-reads.js`** — pure candle/EMA/pattern math. Has input validation added after an
  audit found one malformed bar producing an EMA of 65,750,116.55 and a phantom Doji.
  Any new indicator math belongs here, with validation, not inline in `server.js`.
- **`amd-phase.js`** — the pure PO3 (accumulation/manipulation/distribution) mechanical
  phase detector. Unit-tested, and reused by `tradingview-mcp/scripts/backtest-po3.js`.

### 3.4 Live trading (the dangerous part)

- **`tv-broker-feed.js`** — reads the connected broker account from TradingView's broker
  panel and folds live P&L using a **balance-delta-at-flat** approach. **Caveat carried in
  `TODOS.md`: this fold has never been verified against a real non-zero-P&L closed trade.**
  Everything downstream sits on top of it.
- **`trade-confirm-rules.js`** — the gate. No override path.
- **`trade-confirm-dedup.js`** — double-submit guard.
- **`trade-ticket-parse.js`** — parses the machine-readable `TRADE_TICKET` line the Judge
  emits on a GO verdict.
- **`handleTradeConfirm`** (`server.js` ~6093) — **the only code path in this repo that can
  call `trading_place_market_order`.** Keep it that way. Real orders can also be
  auto-triggered off the PO3 detector leaving ACCUMULATION (`autoTriggerDebate`).
- **`tradovate.js`** — Tradovate REST integration, largely superseded by the
  TradingView-broker-panel feed.
- **`size-freeze-guard.js`** (also mirrored in `renderer/`) — blocks sizing up after a loss.
- **`mistake-patterns.js`** — live mistake-pattern matcher. Currently **F1 only**
  (`checkTradeCountEscalation`), advisory-only, fires once per IST day from
  `pollTVBrokerAccount()`. F2–F6 / M1–M6 are deliberately unbuilt until F1 is live-verified.

### 3.5 State, data, rules

- **`rules.json`** — **the single source of truth for every discipline rule.** Size caps,
  trade limits, daily loss tiers, session windows, commissions, giveback, eval targets.
  Read at runtime by `loadRules()` / `getActiveRules()`. Every numeric field has a sibling
  `_<field>_comment` recording *why* it is that number and what data changed it. Preserve
  those comments — they are the institutional memory of this file.
- **`stage-rules.js`** — the `eval` vs `funded` risk layer, applied **after** `scalperRules`.
  `eval` permits upward from the base; `funded` can only ever *tighten* (one-way ratchet).
- **`resolve-data-dir.js`** — one resolver for `DATA_DIR`, shared by `server.js`,
  `call-logger.js`, and `token-usage-report.js`. Default `G:\MNQ-CoPilot\DATA`, overridable
  via `cfg.dataDir`, falling back to `app/data/`. It exists because a duplicated,
  incomplete copy of this logic once wrote logs to a different directory silently.
- **`atomic-write.js`** — write-temp-then-rename. Use it for anything persisted.
- **`account-db.js`**, **`session-manager.js`**, **`unified-data.js`**,
  **`journey-tracker.js`**, **`bias-tracker.js`**, **`points-tracker.js`**,
  **`post-session-orchestrator.js`**, **`verdict-grounding.js`**, **`go-verdict-detect.js`**,
  **`chat-intent.js`**, **`crash-logger.js`** — single-purpose modules, most with tests.

`bias-tracker.js` note: **no judged data exists before 2026-08-13.** Any analysis that
implies a longer history is wrong.

### 3.6 Voice / notifications

- **`edge-tts.js`** — cloud TTS. **`local-tts.js`** — offline Windows SAPI fallback.
  Diagnose both in one step with the `tts-diagnose` WS message (from the browser console:
  `window.api.ttsDiagnose().then(console.log)`).
- **`telegram-bot.js`** — `notify()` for text, `notifyPhoto()` for a chart screenshot
  alongside a GO verdict. Gated by `TELEGRAM_ENABLED`.

### 3.7 The browser UI (`app/renderer/`)

Plain HTML/JS/CSS served over HTTP — no bundler, no framework, no build. Scripts are
loaded by `<script src>` tags at the bottom of `index.html` in dependency order:

`compromise.js` → `loss-ratchet.js` → `checklist-logic.js` → `volume-budget.js` →
`size-freeze-guard.js` → `stop-alarm.js` → `points-tracker.js` → `ws-client.js` →
`app.js` → `resilience.js`

- **`app.js` (~9,800 lines)** — the whole UI. Also owns `buildContextMessage()` (the
  client-built context for the Claude path) and `enforceAccountInvariant()` (ledger-is-truth
  balance calculation; CSV always wins over the live-derived estimate).
- **`ws-client.js`** — the socket wrapper and message router on the client side.
- **The extracted pure-logic modules** (`checklist-logic.js`, `loss-ratchet.js`,
  `volume-budget.js`, `size-freeze-guard.js`, `stop-alarm.js`, `points-tracker.js`) use a
  **dual-export shape** — `module.exports` for Node tests, `window.*` for the browser —
  so one copy of the logic is both tested and run. This is the established pattern:
  **when you find decision-making logic trapped inside a DOM handler, extract it into a
  module of this shape and test it.** `checklist-logic.js`'s header documents three real
  defects (infinite recursion silently discarding 19 days of ticks; the score total computed
  twice with different formulas; three disagreeing definitions of "today") that all lived in
  DOM handlers and are exactly why this pattern exists.
- **`g5-premium.css` / `styles.css`** — theme. A pre-paint inline script in `<head>`
  applies the saved theme class before first paint to avoid a flash.
- **`left-panel.js` / `left-panel.css`** (2026-09-03) — the left column. Account /
  Today / No-Trade Windows are collapsed to one summary row each and open as a
  flyout over the chat; "Since your last exit" is pinned open (Anoop asked for it
  to be "constant"); Pattern Monitor was removed. The flyout bodies are the
  ORIGINAL sections — nothing was moved in the DOM, so every id inside them is
  still written by the same code as before, open or shut. `left-panel.js` only
  MIRRORS those sections into the rows, via a MutationObserver rather than calls
  added to each update path (same reasoning as `chat-archive.js`). Note the
  specificity trap: `g5-premium.css` scopes its card rules as
  `#left-panel .panel-section`, so a bare class in `left-panel.css` loses **even
  with `!important`** — new rules there must carry the `#left-panel` /
  `#quick-actions` prefix.
- **`day-pnl.js` owns every "today" number** (2026-09-04). The bottom HUD and the
  left panel's Today row each computed P&L, trade count and the break timer
  separately and drifted: the panel read **+$127** while the HUD read
  **-$2,308** on the same day, and the panel's Trades sat at 0 all session.
  Cause in both cases: the panel's fields were written only on the MANUAL
  "Log trade" path, plus an `enforceAccountInvariant` branch that assigned
  nothing once today had a ledger entry. **These were enforcement bugs, not
  display ones** — `acc.profit` feeds `computeMechanicalGoNogo()`'s `dayStopHit`
  and the size ladder; `acc.tradeCount` feeds its `overTradeLimit`. Both gates
  were reading numbers unrelated to the account. Precedence is live → ledger →
  manual; the ledger tier is new to the HUD and deliberate (its own 2026-08-11
  comment records a hand-typed -$637 against a CSV -$855.50). Whether the day
  is STOPPED still keys off the live feed alone — enforcement precedence is not
  display precedence.
- **The size cap is user-adjustable 2..6 with a hard ceiling** (2026-09-04).
  `sizeCapMin`/`sizeCapMax` in `rules.json`, clamped by
  `stageRules.clampSizeCap()` on every `rules-set`, with
  `enforceSizeCapCeiling()` applied in `getActiveRules()` **after** the stage and
  scalper layers so nothing can exceed it. Note the trap this works around:
  `applyStageRules` writes the stage block's value verbatim in eval, so a cap
  raised only at the top level is reverted on the next read — the handler
  writes both stage blocks too. See `Prop Trading/CLAUDE.md` rule 2 for why the
  cap moved and why the evidence still says 2.
- **`account-snapshot.js` — snapshot-before-destroy** (2026-09-04). Two paths could
  destroy an account's record and both now copy it out first, to
  `DATA/_snapshots/<slot>/<stamp>__<reason>/` — deliberately OUTSIDE the slot folder,
  because every per-file `.bak` this repo wrote lived inside the thing being deleted.
  Door 1 is `dataSave()` writing an empty store over a full one (a breach/clear/payout
  reset); door 2 is `dataWipeAccount()`'s `fs.rmSync`, which emptied `DATA/accounts/s1/`
  at 18:56 on 2026-09-04 and took all ten `.bak` files with it. The policy half
  (`isDestructiveSave`) is pure and answers ONE question: is this write shrinking real
  data? A GROWING write must not trigger it — `dataSave()` runs on every logged trade, so
  a guard that fired there would write thousands of snapshots and bury the four that
  matter. And it can never throw into its caller: it runs immediately before a reset the
  user asked for, and a backup that turns "start fresh" into a crash on a live trading
  account is worse than the loss it prevents. Retention keeps the newest 20 per slot and
  `prunePlan()` is written so it can never return "delete everything".
- **No-Trade Windows shows the WHOLE ForexFactory week** (2026-09-03). The feed
  the server already polls (`ff_calendar_thisweek.json`) always carried the full
  Sun-Sat week; `computeNewsStatus()` was discarding everything but today. It now
  also returns `week` (grouped by IST day, server-side, so there is one
  definition of which day an event belongs to), `todayIst` and
  `weekRedRemaining`. `upcoming`/`holidaysToday` keep their exact today-only
  meaning — the chart marker, the Jessi context and the Telegram alert read them.
  There is **no next-week feed**: `ff_calendar_nextweek.json`, `_lastweek` and
  `_thismonth` all 404 at `nfs.faireconomy.media` and `cdn-nfs.…` does not
  resolve (probed 2026-09-03), so do not add a next-week section that renders
  empty. The renderer orders upcoming days first and puts already-printed ones
  under an "Earlier this week" divider; it publishes today's counts on
  `#news-list`'s dataset so the collapsed rail row keeps meaning TODAY.

### 3.8 `main.js` / `preload.js`

An Electron shell. `electron` is **not** in `app/package.json` dependencies and is not part
of the launch path. Treat as legacy/secondary; the real app is a browser page.

---

## 4. The WebSocket protocol

One socket, one dispatcher, `msg.type` selects the handler. Requests that expect a reply
carry a `reqId` which is echoed back. Full list as of 2026-08-20:

**Chat / agents:** `chat-send`, `jessi-chat-send`, `debate-chat-send`, `scalper-chat-send`,
`post-session-review`, `ict-po3`, `jessi-voice-send`, `cancel-request`
→ stream back as `chat-token` / `chat-tool-start` / `chat-tool-done` / `chat-done`.

**Agent→client callback:** `jessi-app-action` (server→client) / `jessi-app-action-result`
(client→server). The Jessi agent's `app_do` tool cannot mutate UI state directly — it asks
the connected browser to perform the action, with a 15s timeout (`runAppActionOnClient`).

**Voice:** `tts-speak`, `tts-diagnose` → `tts-diagnose-result`.

**Config / rules / mode:** `config-set`, `mode-switch`, `rules-get`, `rules-set`,
`trading-mode-get`, `trading-mode-set` → `rules`, `trading-mode`.

**Data:** `data-save`, `data-load`, `data-wipe-account`, `data-end-day`, `data-dir-get`,
`note-save`, `shot-save`, `shot-list`, `shot-read`, `reviews-load`, `pdf-extract`,
`xlsx-extract`, `journal-add`, `account-db-rebuild`.

**Sessions:** `session-start`, `session-trade`, `session-read`, `session-list`,
`checklist-done`, `journey-action`, `journey-list`.

**Chart / monitors:** `mcp-call`, `mcp-reconnect`, `screenshot-get`,
`engulf-monitor-toggle`, `engulf-check-now`, `fvg-monitor-toggle`, `fvg-check-now`,
`sfp-monitor-toggle`, `sfp-check-now`, `po3-monitor-toggle`, `po3-check-now`,
`mark-london-levels`, `mark-ny-levels`, `mark-news-times`, `news-refresh`,
`mechanical-check`.

**Broker / trading:** `tv-broker-check-now`, `trade-confirm-request`, `tradovate-test`,
`tradovate-restart`.

**To add a message type:** add a `case` to the switch, write the `handle*` function near
its peers, and add the client side in `ws-client.js` / `app.js`. Do not introduce a second
dispatcher or an HTTP endpoint for it.

### 4.1 Monitor auto-start and the "user disabled" flag

The PO3, Engulfing, and SFP monitors auto-start on TradingView connect. Each keeps an
explicit `*MonitorUserDisabled` flag so that a CDP blip → heartbeat recovery → re-fired
`tv-connected` event cannot silently re-enable a monitor the user deliberately turned off.
Replicate this pattern for any new auto-starting monitor.

---

## 5. Data on disk

| Path | Contents |
|---|---|
| `~/.mnq-copilot-config.json` | API key, `dataDir`, current mode (`eval`/`funded`), user config. **Not in the repo.** |
| `DATA/` (default `G:\MNQ-CoPilot\DATA`) | The live dataset: `accounts/`, `account_fees.json`, `account_journeys.json`, `align_notes.json`, `balance_ledger.json`, `day_trades.json`, `eval_milestones.json`, `maemfe.json`, `charts/`, `history/`, `reviews/`, `books/`, `chat_transcript.json`, `token-usage.jsonl`, `tv_broker_feed_state.json`, `loop_state.json`. |
| `sessions/` | Session recordings. |
| `app/data/` | Fallback `DATA_DIR` if the configured one isn't writable. |
| `app/logs/` | Runtime logs. |
| `roster.json`, `roster-backups/` | Account roster. |

Two axes of mode, frequently confused:
- **`mode`**: `eval` \| `funded` — which account's rules/data apply. Persisted in
  `~/.mnq-copilot-config.json`, switched by `handleModeSwitch`, layered by `stage-rules.js`.
- **`tradingMode`**: `standard` \| `scalper` — trading style. Persisted in `rules.json`,
  applied as the `scalperRules` overlay.

Order of application: base `rules.json` → `scalperRules` (if scalper) → `stageRules`
(eval permits / funded clamps). Contract **size** is owned by the stage axis; trade
**count** is owned by the trading-mode axis. That split is deliberate — it exists because
switching to scalper mode on a funded account used to silently raise the size cap.

---

## 6. Working conventions (non-negotiable)

1. **Never hardcode a trading number that lives in `rules.json`.** A hardcoded `sizeCap`
   drifting out of sync with the file is a bug this project has already shipped once, and
   it cost a real eval account breach. Change the number in `rules.json`, then check
   whether `Prop Trading/CLAUDE.md`'s documented rules need to move in lockstep — they
   have drifted apart before.
2. **All timestamps and session windows are IST wall-clock.** `sessionWindowsIST` entries
   are minutes since midnight IST. The **trading day rolls over at 03:30 IST**, not
   midnight. There is one definition of "today" — in `checklist-logic.js`. Do not write a
   fourth one.
3. **Prefer additive, reversible changes.** This runs during live sessions.
4. **Extract pure logic and test it** (§3.7's dual-export pattern) rather than adding to a
   DOM handler or to `server.js`'s bulk.
5. **Chart access goes through `withChartLock`.**
6. **Never report a number you did not compute from real data.** See `TRUST-PROTOCOL.md`.
   The rule exists because an agent once invented a five-row P&L table and presented it as
   fact, and because a validated-arithmetic module shipped without input validation and
   produced plausible-looking wrong numbers.
7. **Distinguish "built" from "live-verified"** in everything you write. `TODOS.md` is
   organised around exactly this distinction; keep it that way.

### 6.1 Prompt/LLM changes — a stricter checklist

These files drive real trading decisions on a live-money account, so a bad edit is
higher-stakes than an equivalent rendering bug. Files that count:

- `app/claude-agent.js` — `EVAL_RULES`, `FUNDED_RULES`, `SHARED_RULES`,
  `buildSystemPrompt()`, `ALL_TOOLS` (**tool descriptions are prompt content** — the model
  reads them as instructions).
- `app/server.js` — every `*_PERSONA` constant, `buildJessiContext()`,
  `formatAlignmentNotes()`, `formatLiveFeedContext()`, and the `JESSI_TOOLS` /
  `JESSI_TV_TOOLS` / `JESSI_APP_TOOLS` / `JESSI_VOICE_TOOL_NAMES` / `SCALPER_TOOLS` schemas.
- `app/renderer/app.js` — `buildContextMessage()`.

Before shipping such a change:

1. **Read the diff as if you were the agent receiving it.** Did a word flip the meaning
   ("never" → "rarely")?
2. **Check for drift against `rules.json` and `Prop Trading/CLAUDE.md`.** Any concrete
   number in prose must match `rules.json`, and shouldn't be there at all if the code can
   read it.
3. **Manual smoke test.** Run the app, trigger the exact agent path you touched, read the
   real response. There is no eval suite; a prompt change with no observed response is
   unverified.
4. **If tool schemas changed:** `node token-audit.js` for token cost, and
   `node token-usage-report.js` after a live session to confirm prompt caching didn't break.
5. **If the change is behavioral** (when a persona escalates, what `app_do` may do): state
   the failure mode it fixes or introduces; prefer additive over rewriting a working persona.

There is deliberately **one separation to preserve**: the Analysis and PO3 agents are denied
account/P&L data by their own context text ("that is Jessi's lane"). That exists because of
a real fabrication incident. Live account data reaches the Debate verdict via the Judge,
not by giving it to those two agents.

---

## 7. Known-broken and known-unverified

Read `TODOS.md` for the current list. Standing items as of 2026-08-20:

- **`batch_run` (tradingview-mcp) — confirmed broken, do not use.** It switches
  symbol/timeframe per iteration and never restores the original chart state, unlike every
  other multi-TF path here. Wiring it into a watcher would hijack the live chart.
- **`alert_create` price-setting — half-fixed, not safe.** The dialog now opens reliably,
  but the native-setter + input/change/blur/Enter sequence that works for every other
  TradingView input does not update this field's React state. Four live tests each created
  a real alert at the *current market price* instead of the requested one. The function now
  detects the mismatch and fails loudly rather than falsely reporting success — but it is
  unusable for auto-alerting until real per-keystroke CDP `Input.dispatchKeyEvent`
  simulation is implemented and re-verified. (Note: `alert_create`/`alert_delete` were
  since rerouted through the pricealerts REST API — commit `173c804`; re-check current
  state before relying on either path.)
- **Balance-delta-at-flat P&L fold — never verified against a real non-zero-P&L closed
  trade.** Every live size/P&L number sits on this. Verify it live before trusting those
  numbers for anything beyond the guardrail's internal use.
- **The whole Phase-2 confirm/execute flow and the mistake-pattern matcher are built but
  not live-verified.** Do not increase their autonomy before the existing surface is
  verified in a real session.

---

## 8. How to extend this project

**Adding a feature that needs a new client↔server interaction:**
1. Add a `case` to the dispatcher in `server.js` and a `handle*` function beside its peers.
2. Add the client half in `ws-client.js` / `app.js`.
3. If it makes a *decision*, put that decision in a small pure module with the dual-export
   shape and a `app/test/<name>.test.js`.
4. If it reads the chart, go through `mcpBridge` inside `withChartLock`.
5. If it persists anything, use `atomic-write.js` and the resolved `DATA_DIR`.

**Adding a new agent:** copy the shape of an existing one in `AGENTS.md` — persona constant
+ context builder + tool schema subset + a handler that calls `groqAgent.stream()` — then
add its row to `AGENTS.md`. Decide explicitly what data it may and may not see (§6.1).

**Changing a trading rule:** `rules.json` only, with a `_comment` explaining the evidence.
Check `stage-rules.js` and `scalperRules` for interaction, and `Prop Trading/CLAUDE.md`
for documentation drift.

**Extending the mistake-pattern matcher:** F1 is the template. Do not add F2–F6 until F1
has fired correctly in a real session.

**Before you ship anything:** `cd app && npm test`, then run the real app and exercise the
path you touched. Report what you verified and what you did not — honestly, with the
distinction between "built" and "verified" made explicit.

---

## 9. Fast orientation checklist for a new agent

1. Confirm you are in `G:\MNQ-CoPilot`.
2. Read `CLAUDE.md`, then this file, then `ARCHITECTURE.md` and `AGENTS.md`.
3. Skim `TODOS.md` for what is unverified, and `TRUST-PROTOCOL.md` for how to report numbers.
4. `cd app && npm test` — confirm the suite is green before you change anything.
5. Open `app/rules.json` and read the `_comment` fields; they explain most of the app's behaviour.
6. Find the dispatcher (`ws.on('message'` in `server.js`) — that switch is the map of
   everything the app can do.
7. Exclude `*.bak` from every search.
