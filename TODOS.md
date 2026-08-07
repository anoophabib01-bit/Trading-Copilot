# TODOS

## Token Audit / Reliability Hardening (from /plan-ceo-review, 2026-08-03)

### Revisit per-turn tool-scoping (originally T4), gated on real call-spacing data

**What:** Build the per-turn tool-scoping classifier (only send the full 23-tool schema when a turn plausibly needs it) — but only after `token-usage-report.js` (extended in this plan to break out cache-read/write) shows real call-spacing data from live 4+ hour sessions.

**Why:** An outside-voice review of this plan found that prompt caching (shipping now) already covers most of tool-scoping's token savings within the cache TTL window — tool-scoping only pays off on cache misses (session start, or gaps longer than the TTL). Its risk (a misclassified turn silently losing chart-tool access mid-trade) doesn't shrink even though its value might mostly be redundant. Decided to measure real cache-hit/miss cadence before building this, rather than guess.

**Context:** If `token-usage-report.js` shows sessions have long gaps between calls (cache frequently expires before the next call), tool-scoping still has real, measurable value and should be built — with a deterministic keyword/structural classifier (never a pre-flight LLM call, which would add cost and defeat the purpose), fail-open on any ambiguity, every scope-down logged. If gaps are consistently short, this can likely stay permanently deferred.

**Effort:** M
**Priority:** P2
**Depends on:** Token-usage-report.js cache-stats extension (ships in the token-audit/reliability plan) running against real session data

## Completed

### Audit the Scalper agent and Post-Session Analyst for the same tool-schema-bloat issue

**What:** Checked whether `SCALPER_PERSONA`'s chat handler (`handleScalperChat` in server.js) and the Groq-backed Jessi path send an unnecessarily large tool schema per call.

**Finding — no bloat found, both already well-scoped:**
- `SCALPER_TOOLS` ([server.js:2264](app/server.js#L2264)): 4 tools only (`app_get_data`, `scalp_note_add`, `scalp_note_get`, `search_books`) — no chart/TradingView tools at all.
- `handleJessiChat`'s Groq path uses `JESSI_TOOLS` ([server.js:716](app/server.js#L716)), a *separate, smaller* 14-tool set (`JESSI_TV_TOOLS` + `JESSI_APP_TOOLS`), not claude-agent.js's 23-tool `ALL_TOOLS`.
- Bonus find: voice mode already has an even further-reduced set, `JESSI_VOICE_TOOL_NAMES` ([server.js:719-724](app/server.js#L719-L724)) — a **deliberate, dated (2026-07-23) static tool-scoping precedent**, explicitly done to cut per-turn tokens for Groq's free-tier TPM cap. Worth citing as prior art if the deferred "revisit per-turn tool-scoping" TODO above ever gets built — a caller-declared mode split (like this) is safer than a content-guessing classifier.
- Conclusion: the 23-tool bloat this plan fixed (caching) was specific to `claude-agent.js`'s Anthropic-backed path — the Groq-backed paths were already optimized.

**Completed:** 2026-08-03 (same session as the token-audit/reliability plan)

### Minimal test harness for app/, starting with the fallback-loop cap/cancel logic

**What:** Stood up `node --test` (Node's built-in runner, zero new dependencies) with `npm test`. Extracted the fallback-loop's cap decision into pure, exported functions (`shouldLoopChain`, `loopGiveUpReason` in `groq-agent.js`) and wrote `app/test/fallback-loop.test.js` — 11 tests covering retryable/non-retryable status codes, lap-cap boundary, time-budget boundary, single-candidate chains, and both caps interacting.

**Completed:** 2026-08-06 — all 11 tests passing (`npm test` in `app/`).

### Wire real end-to-end request cancellation into groq-agent.js (currently client-side-only)

**What:** Built the full feature: `server.js` now has an `activeRequests` Map (reqId → AbortController) with a `cancel-request` WS message type; `handleChat`, `handleJessiChat`, `handleScalperChat`, `handleDebateChat` (+ its 3 parallel sub-agents and the Judge), and `handleJessiVoiceSend` all register/pass/unregister a signal. `groqAgent.stream()` checks the signal before every attempt (covers chain-advance and lap-loop) and threads it into the actual `http.request()` call so an in-flight request aborts immediately, not just future retries. `claudeAgent.stream()` accepts the same external signal and reuses its existing internal `AbortController`. All 5 client-side cancel functions in `ws-client.js` (`cancelChat`, `cancelJessiChat`, `cancelScalperChat`, `cancelJessiVoice`, `cancelDebateChat`) now actually send the cancel message instead of only clearing local UI state.

**Completed:** 2026-08-06 — smoke-tested with a pre-aborted signal against both agents (confirmed no network call attempted, clean error surfaced); existing 11-test suite still green throughout.

### Settings-UI checkbox for the token-optimization kill switch

**What:** Added a checkbox in Settings ("Token Optimization" section) bound to the same `disableTokenOpt` config key `claude-agent.js`'s kill switch already reads live per-call. Populated on open (`openSettings()`), persisted on save (`saveSettings()` → `window.api.setConfig`) — same IPC path every other setting uses, so no new plumbing.

**Completed:** 2026-08-06

### Define a "Prompt/LLM changes" file-pattern and eval-suite convention in CLAUDE.md

**What:** Added a `## Prompt/LLM changes` section to CLAUDE.md naming every persona/context-building file (`claude-agent.js`'s rule blocks, `server.js`'s personas + `buildJessiContext()`/`formatAlignmentNotes()`, `app.js`'s `buildContextMessage()`) and a 5-step manual-verification checklist (read-aloud check, rules.json drift check, manual smoke test, tool-schema token/cache check, behavioral-change framing). No automated eval suite exists yet — documented as a manual convention with a trigger for when to build a real one (recurring prompt bugs).

**Completed:** 2026-08-06
