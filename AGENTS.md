# MNQ Co-Pilot — AI Agents Reference

Ten distinct LLM "agents" (persona + prompt + tool set) run in this app, all
dispatched from the single WebSocket message handler in `app/server.js`
(see `ARCHITECTURE.md` for the overall data flow). This file documents each
one: what triggers it, which backend runs it, its system prompt location,
what tools it can call, and what happens to its output.

Unless noted, "Backend: groq-agent" means execution goes through
`groqAgent.stream()` (`app/groq-agent.js`), which builds an ordered
multi-provider fallback chain (`app/provider-chain.js`) — not a single fixed
provider. Persona text and tool schemas are still frequently *defined* in
`app/claude-agent.js` and reused, even when `claude-agent.js` isn't the thing
executing the call.

---

## 1. Jessi (main chat)

- **Trigger:** the main chat input box in the app UI.
- **Handler:** `handleChat` (`server.js:1080`)
- **Backend:** `groqAgent.stream()`. Reuses `claudeAgent._debug.buildSystemPrompt(currentMode)` and `claudeAgent._debug.ALL_TOOLS` (converted from Anthropic tool-shape to OpenAI tool-shape inline, `server.js:1112-1117`).
- **System prompt:** `app/claude-agent.js:225-228` (`buildSystemPrompt()`) = `EVAL_RULES` (52-79) or `FUNDED_RULES` (81-118), plus `SHARED_RULES` (120-209), plus a live IST date anchor (`istDateLine()`, 211-223).
- **Tools:** `TV_TOOLS` (`claude-agent.js:231-254` — 20 TradingView chart tools: read state, draw, set alerts, `chart_set_symbol`, `chart_set_timeframe`) + `BOOK_TOOLS` (`search_books`, 259-261) = `ALL_TOOLS` (262).
- **Data in:** TradingView chart via `mcp-bridge.js`; book library via `books-index.js`.
- **Data out:** streamed to the client as `chat-token` / `chat-tool-start` / `chat-tool-done` / `chat-done` WS messages.
- **Note:** this is the "main co-pilot chat" — distinct from the "Jessi Livermore" coaching persona below, despite the shared name.

## 2. Jessi Livermore (accountability coach)

- **Trigger:** the dedicated "Jessi" companion tab.
- **Handler:** `handleJessiChat` (`server.js:1795`)
- **Backend:** `groqAgent.stream()`.
- **System prompt:** `JESSI_PERSONA` (`server.js:1142-1213`).
- **Context:** `buildJessiContext()` (1692-1760) — verified account balance (`jessiVerifyBalance` recomputes from the ledger, doesn't trust a cached number), chart snapshot cache, recent day history, journal entries, scalper notes, Alignment notes (`formatAlignmentNotes`, 1612-1622), bias-adherence cross-check (`biasTodayContext`, 1670-1690, via `bias-tracker.js`).
- **Tools:** `JESSI_TOOLS` = `JESSI_TV_TOOLS` (1218-1230 — read/draw/alert only, no symbol/timeframe switch, no execution) + `JESSI_APP_TOOLS` (1239-1261: `app_get_data`, `app_do`, `search_books`).
- **Special path:** `app_do` (a destructive/UI-mutating action) round-trips to the connected browser client itself via `runAppActionOnClient` (1292-1304, `jessi-app-action` WS message, 15s timeout) — the agent can't touch app UI state directly, only ask the client to do it.
- **Data out:** same `chat-*` streaming shape; Alignment/journal writes persist via `dataSave`/`dataLoad`.

## 3. Jessi (voice)

- **Trigger:** voice mode — mic input.
- **Pipeline:** STT (Groq Whisper via `groqAgent.transcribeAudio`) → the same Jessi turn → TTS (Groq Orpheus via `groqAgent.synthesizeSpeech`). Handler area starts around `server.js:3631`.
- **System prompt:** `JESSI_PERSONA_VOICE` (1278-1283) — a condensed variant that hard-enforces 1–3 sentence spoken replies.
- **Tools:** `JESSI_VOICE_TOOLS` (1273-1276) — only 3 read tools (`chart_get_state`, `quote_get`, `market_key_levels`) + the full `JESSI_APP_TOOLS`. Draw/alert tools are deliberately dropped to fit inside Groq's free-tier TPM budget.
- **Context:** `buildJessiContext(true)` — the minimal path (1722).
- **Backend:** Groq specifically for STT/TTS; chat completion goes through the same `groqAgent.stream()` chain as everything else.

## 4. Debate panel: Technical Analysis agent

- **Trigger:** a Debate-mode question, or auto-fired (`autoTriggerDebate`, `server.js:2672`) when the PO3 monitor sees a mechanical phase transition ACCUMULATION → MANIPULATION/DISTRIBUTION (`checkPo3Phase`, 2705-2811, cooldown-gated).
- **Handler:** `handleDebateChat` (2163), part of the parallel dispatch in `runDebateAgent` (2141-2161).
- **System prompt:** `ANALYSIS_DEBATE_PERSONA` (1885-1903) — technical/structure lane only, deliberately excludes P&L/account data and Daily bias (Anoop reads Daily himself, by design).
- **Context:** `gatherAnalysisContext()` (1993-2136) — live chart snapshot, `COMPUTED READS` (arithmetic via `chart-reads.js`: alignment, EMA confirmation, doji-at-key-level), `MECHANICAL 1H BIAS` (from `po3TrendRead`, the same source PO3's own gate uses), Alignment notes.
- **Tools:** none — all context is pre-fetched, not tool-called.
- **Backend:** `groqAgent.stream()`.

## 5. Debate panel: ICT Power of 3 agent

- **System prompt:** `ICT_PO3_PERSONA` (`server.js:2398+`) plus `ICT_PO3_DEBATE_SUFFIX` when inside a debate. Judges AMD (Accumulation/Manipulation/Distribution) phase using the same mechanical 1H bias gate as the Analysis agent.
- **Context:** `gatherPO3Context()`.
- **Also runs standalone** (outside a debate) — `istDateAnchor() + ICT_PO3_PERSONA` at `server.js:3083`.
- **Tools:** none.
- **Backend:** `groqAgent.stream()`.

## 6. Debate panel: Jessi (discipline lane)

- **System prompt:** the same `JESSI_PERSONA` plus a debate-mode discipline-only addendum (`server.js:2185-2197`) and `DEBATE_BRIEF_FORMAT`.
- **Context:** `jessiDataContext` — real per-trade data is pre-seeded directly into context (2210-2246), because debate agents run with `tools:[]` and this lane previously fabricated numbers when it had to guess (fixed after a 2026-08-10 incident).
- **Backend:** `groqAgent.stream()`.

## 7. Judge (Expert Judge)

- **System prompt:** `JUDGE_PERSONA` (1905-1955) — synthesizes the Jessi / Analysis / PO3 arguments above using a fixed decision hierarchy: **discipline overrides technical overrides P&L**. On a genuine GO, emits a machine-readable line: `TRADE_TICKET: side=buy|sell size=N [stop=PRICE] [target=PRICE]`.
- **Context:** `judgeContext` (2281) = all three debate arguments + the bias-adherence block (`biasTodayContext`).
- **Post-processing:** `verdict-grounding.js`'s `checkGrounding()` (referenced 2298-2311) appends a hedge warning if any cited figure isn't traceable back to `judgeContext` or `rules.json` — a guard against the model inventing numbers.
- **Downstream consumers:**
  - `saveReviewRecord` (persists the verdict)
  - on GO: `dispatchGoRefutation` fires the Refuter agent (2327), fire-and-forget
  - Telegram: `telegramBot.notifyPhoto`/`notify` (2337-2349)
  - `tradeTicketParse.parseTradeTicket()` → `trade-ticket-suggested` WS message → a ticket appears in the UI → clicking Confirm calls `handleTradeConfirm` (2354-2375) — the only path to a real order (see `ARCHITECTURE.md`).
- **Backend:** `groqAgent.stream()`.

## 8. Refuter (second-opinion agent)

- **Trigger:** only ever fired after a GO verdict (`dispatchGoRefutation`, 1979-1990), and never awaited — pure fire-and-forget.
- **System prompt:** `REFUTER_PERSONA` (1969-1977) — actively tries to find a genuine objection to the GO; replies exactly `NO OBJECTION` if it can't find one, in which case nothing is shown to the user.
- **Backend:** `runDebateAgent` → `groqAgent.stream()`, no tools.

## 9. Post-Session Analyst

- **Trigger:** `handlePostSessionReview` (3286) — after a Performance CSV upload, or an explicit end-of-session review request.
- **System prompt:** `POST_SESSION_ANALYST_PERSONA` (3194-3228) — forensic tone, fixed 7-section output format, leads with a deterministic summary before any LLM interpretation.
- **Context:** `runPostSessionWorkers()` (3239-3284) — a deterministic session summary from `post-session-orchestrator.js`, plus dynamically-selected pattern-check "worker" sub-agents (an orchestrator-workers pattern: each worker is its own `runDebateAgent` call with a topic-specific persona chosen by `selectWorkers()`), plus the full account data, Jessi context, scalper notes, chart cache, and the last 5 session-history JSON files.
- **Tools:** none. Same grounding check as the Judge is applied to its output.
- **Backend:** `groqAgent.stream()`.

## 10. The Scalper

- **Trigger:** `handleScalperChat` (3573) — the dedicated scalping-specialist tab, active when `tradingMode === 'scalper'`.
- **System prompt:** `SCALPER_PERSONA` (3421-3472) — sourced scalping doctrine (disposition effect, time-stop rule) plus hard enforcement duties it must apply itself: size cap, size-up-after-loss, cooldown, trade-count limit, cross-instrument checks, session-window checks.
- **Tools:** `SCALPER_TOOLS` (3518-3547) — `app_get_data`, `scalp_note_add`/`scalp_note_get` (a durable per-account notebook via `scalperNotesAdd`/`scalperNotesRead`, 3477-3513), `search_books`. Deliberately no chart-draw tool and no execution tool.
- **Executor:** `makeScalperToolExecutor()` (3549-3567).
- **Backend:** `groqAgent.stream()`.

---

## Agent trigger origins, at a glance

| Origin | Agent(s) fired |
|---|---|
| User types in main chat | Jessi (main chat) |
| User opens "Jessi" tab | Jessi Livermore |
| User speaks (voice mode) | Jessi (voice) |
| User asks a Debate question | Analysis, PO3, Jessi (discipline), then Judge |
| PO3 mechanical phase transition (market structure, no user action) | full Debate panel → Judge → (on GO) Refuter, Telegram, trade ticket |
| Judge emits a GO verdict | Refuter (async), Telegram notify, trade ticket surfaced to UI |
| User confirms a trade ticket | `handleTradeConfirm` — not an LLM call, a deterministic gated pipeline |
| Performance CSV uploaded / session ended | Post-Session Analyst (+ worker sub-agents) |
| User opens Scalper tab, `tradingMode = scalper` | The Scalper |

## Not an agent, but agent-adjacent

- **`app/amd-phase.js`** — pure arithmetic PO3 phase detector, no LLM involved. Its output is what *triggers* the Debate panel above; it doesn't reason about anything itself.
- **`app/telegram-bot.js`** — a consumer of Judge output (`notify`/`notifyPhoto`), plus a separate, less-documented two-way Telegram chat loop that goes through `claude-agent.js` + `session-manager.js` directly (not covered in the numbered list above — same underlying model, different entry point).
- **`app/chat-intent.js`** — a heuristic that flags a mismatch between chat text and the active trading mode (`mode-hint` WS message); it never rewrites or intercepts any agent's prompt.
- **`app/verdict-grounding.js`** — not itself an agent; a post-hoc checker applied to Judge and Post-Session Analyst output.

For full system-prompt text, tool schema definitions, and the confirm/execute
order-placement pipeline in detail, read `app/server.js` at the line ranges
cited above, and `ARCHITECTURE.md` for how the WebSocket/MCP layers connect
everything.
