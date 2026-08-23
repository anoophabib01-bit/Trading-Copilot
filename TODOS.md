# TODOS

## Replay verification against a REAL day — 2026-08-20 reconciled exactly, and a real size bug found

Anoop supplied ground truth this session: Tradeify's own P&L calendar (-$264.10 for 2026-08-20, "11 trades") and the raw Tradovate fill export (11 buy/sell-matched rows). Both independent of this codebase, both far stronger evidence than anything available before.

**First finding: the earlier "dayPnl was probably still correct" claim is disproven, not just unverified.** The pre-fix persisted state for that exact day read tradeCount:9, dayPnl:-44.65. Real total is -$264.10 — a $219 gap, far beyond commission or the documented "baseline at first poll" blind spot. The entry-fill mis-scoring bug corrupted the balance-delta running anchor too, not just the count.

**Reconciliation, verified to the penny:** every one of the 11 raw fills matches $2.00/point exactly (11/11, zero exceptions) — the strongest confirmation of the MNQ point value yet. Grouping fills into real position transitions gives 5 round trips (not 11 — Tradeify's badge counts fill-match pairs, same category of miscount as the order-rows-vs-round-trips bug already fixed, one level up). Gross -$228.00; the $36.10 gap to Tradeify's net divides across 19 traded contracts at exactly $1.90/contract-round-trip — clean enough to be Tradeify's real all-in fee, running higher than the $0.59/side ($1.18/RT) currently coded in `rules.json` (flagged, not changed — a live-enforcement constant, needs Anoop's sign-off).

**`test/replay-2026-08-20.test.js`** replays these exact real fills, at realistic poll cadence (including landing mid-scale-in and mid-split-exit, the shapes that broke the old code), through the CURRENT fixed `fold()`/`analyzeOrderWalk()`. Reconstructs tradeCount:5 and dayPnl:-264.10 exactly, matching every individual round trip's P&L, zero degraded-evidence trades.

**Second finding, a real bug the replay caught (not present before this session, since `analyzeOrderWalk` was itself new):** the closed round trip's `size` field was wrong for any multi-fill entry OR exit. Three attempts: `st.entry.qty` only captured the first fill's size (RT3's 6-fill, 12-lot scale-in reported 2); `abs(before)` at the closing fill fixed that but broke split exits the same way in reverse (RT4's 2-lot position, closed via 2 separate fills, reported 1). Correct answer: the PEAK absolute position size reached anywhere in the round trip's life, tracked per-fill but deliberately NOT updated on the crossing fill itself (that fill's resulting position belongs to the NEW leg on a reversal, and folding it into the peak would corrupt the leg that's closing). This bug fed two real consumers before being caught: the backfill (wrong size on any multi-fill round trip recovered after a restart) and `expectedPnlFromFills`' P&L cross-check (wrong gross P&L for exactly scale-ins/split-exits/reversals — the trade shapes most likely to trigger it). 3 new focused unit tests pin the mechanism directly.

538/538 tests pass (9 new this pass: 3 replay + 3 size-tracking + 3 fee-model). This is the first time any part of this subsystem has been checked against real, independently-sourced ground truth rather than the app's own prior output.

## The four deferred decisions — DECIDED and BUILT 2026-08-21

**D1 — degraded feed: score it, tag it, enforce advisory.** `fold()` now stamps `evidence: 'degraded'` on any trade scored by the fill-edge fallback (orders table unreadable, walk desynced, or an unparseable row). The trade is still recorded — refusing would under-count and silently let him trade past the cap, the failure direction that costs money rather than time — but it is marked.

**D2 — provenance, and only verified numbers hard-enforce.** `checkTradeAllowed` downgrades the `tradesPerDay` cap to `{allowed:true, advisory:true, warning}` when any trade behind the count is degraded. **Deliberately NOT downgraded:** `dayStop` and the size rules, which read BALANCE and SIZE — both directly observed and independent of how many trades we think happened. Only the count is uncertain, so only the count loses its teeth. No general override path was added: D1's tagging removes the need for one, because a number we cannot stand behind never reaches a hard lock. The HUD shows `~COUNT PROVISIONAL (n scored on a degraded feed — cap is advisory)` or `⚠ FEED DEGRADED`.

**D3 — only `closed` and `flipped` speak in chat.** `opened`/`scaled` now update the HUD silently (a `SIDE QTY SYMBOL ·` prefix on the meta line — the highest-priority thing during a session). Crucially this shipped **with** the missing half: `formatOpenPositionContext()` puts the live position into every agent's context, so Jessi, the Judge, the Scalper and the Post-Session Analyst still know a trade is on. Without that, cutting the chat lines would have made her blind to open positions — the opposite of what was asked for. A flip still banners, because it reverses risk without passing through flat: no cooldown, no re-entry check, no fresh decision in between.

**D4 — the review's premise was wrong; only the hand-off is skipped.** Order placement runs on `withChartLock` (it must serialise against `chart_set_symbol`, or an interleaving switch could place an order on the **wrong instrument**); the position watch runs on `withBrokerLock`. Different locks — they never queue behind each other, and that split is a deliberate 2026-08-19 fix for a real "poll queued for minutes behind chart monitors" bug. Suspending the watch would have undone it. The genuine residual is narrower: mid-placement the orders table is being rewritten, so the watch's follow-up **full account read** can catch it half-rendered and drop the feed into degraded mode at the worst possible moment. Only that hand-off is now deferred (`tvOrderPlacementInFlight`, cleared in a `finally` so a throw cannot wedge it on). The 5s positions read keeps running — that is exactly when you most want to see the fill appear.

532/532 tests pass (6 new). Still no live verification of any of it.

## Fold verification — 2026-08-21, the long-standing blocker is PARTLY closed

Run it yourself: `cd app && node scripts/verify-fold.js --broker-balance <broker figure>`, or audit a past day with `--day-pnl <fold dayPnl> --day-start <balance at that day's open>`.

**CONFIRMED — the point value.** 117/117 realized P&L values across 9 days of broker-confirmed history in `day_trades.json` are exact multiples of $0.50, zero violations, and they reconcile **exactly** to `balance_ledger.json` gross on all 9/9 days. MNQ is $2.00/point (0.25 tick = $0.50/tick). This retires the "no verified per-contract multiplier exists in this codebase" caveat that `tv-broker-feed.js` cited as its reason for refusing to compute price-derived P&L.

**CONFIRMED — the balance-delta arithmetic at the endpoint.** On 2026-08-20 the fold's `balanceAtLastFlat` read 49,953.80 against a broker panel showing 49,953.80. Exact to the cent.

**PARTIAL — the day total.** Fold `dayPnl` -44.65 vs the account's true day delta of -46.20 (49,953.80 against a 50,000 start). A **$1.55 gap**, in the direction of the documented "baseline at first poll" blind spot — the fold's implied day-start is 49,998.45. Plausible, **not proven**: $1.55 is not a clean multiple of the $0.59/contract/side commission, so it is not fully accounted for. The script reports this as FAIL by design rather than waving it through.

**NOT CLOSED — per-trade attribution**, which is the one that matters: `size-freeze-guard` and the cooldown read per-trade `pnl` and `lastLossTs`, not the day total. A correct day total does not make the SPLIT correct, and the split is exactly what the count bug broke. 2026-08-20's own partition cannot be used to test this — it was produced by the buggy fold.

**So the system now verifies itself instead of waiting on another manual audit.** `expectedPnlFromFills()` derives a second, independent P&L for every closed round trip from its fill prices (now that the point value is established), and `pollTVBrokerAccount` compares it against the balance delta on every close. Agreement is logged; disagreement over $1 raises a banner and a chat line. **Enforcement still uses the balance delta** — it is the account and it captures fees. This is a cross-check, not a replacement, same discipline as the round-trip count reconciliation. Deliberately silent on agreement: a confirmation toast on every trade is the alert-fatigue pattern that made the old banner worthless.

Symbols with no verified multiplier (MGC — no trades in the checked history) return `null` and are skipped rather than guessed.

**What closes the remaining gap:** one real closed MNQ trade with non-zero P&L. The cross-check will report PASS or the exact dollar disagreement in the log and the UI, with no further work needed.

Also settled today: the IST rollover cleared the poisoned `tradeCount: 9`, and the server has since been restarted onto the fixed code (its state file now carries `schemaVersion: 2`), so the lockout is gone by both routes.

## Live trade events + /autoplan review — 2026-08-20, all built, ZERO live verification

Plan + full review report: `LIVE_TRADE_EVENTS_PLAN.md`. Built this session, then reviewed via /autoplan (Claude subagent voices only — **codex is not installed on this machine**, so no dual-voice consensus; DX phase skipped as this is not a developer product).

**Feature:** 5s `trading_get_positions` watch (`app/position-events.js`, pure + 12 tests) emitting open/close/scale/flip, handing off to an immediate full account poll. Closed trades auto-write a session-log row and announce in chat. Telegram deliberately not wired.

**Eight defects found and fixed during review** — three CRITICAL, all silent UNDER-counts (the direction that lets him over-trade, worse than the lockout that started this):
- A **flip was never counted** — both fold branches required `isFlat`, so long→short never scored and the eventual close folded two round trips into one.
- The backstop needed the fill **edge** and the round-trip **level** in the same poll; when they split, the re-anchor discarded the P&L *and* the count.
- `pollTVBrokerAccount` had **no in-flight guard** and four callers — duplicate session-log rows were reachable. Now coalesced with one trailing re-run.
- `STATE_SCHEMA_VERSION` bump so the poisoned `tradeCount: 9` cannot reload from disk after the fix.
- `tvLastClosedSide[t.symbol]` was **dead code** (fold records carry no `symbol`), so every auto-logged row took the global fallback — a confident wrong direction on a two-symbol day.
- Session log used a **UTC** day in an IST app (H7): a 01:00 IST close appended to yesterday's file.
- Order-walk desync (H5): one unreadable row froze the count for the rest of the day, silently disabling the backstop. Walk now reports `droppedRows`/`netBySymbol` and is cross-checked against the positions panel; on disagreement the fold takes the degraded path instead of gating on a known-wrong number. Zero-crossing fills now book their close.
- `logTrade` (H6) numbered rows ascending but inserted at the top, and returned success when its regex silently no-opped. Insert logic extracted as pure `insertTradeRow`; failures now surface as `session-log-failed`.

519/519 tests pass (24 new). **Nothing here is live-verified.** Needs a real session with a scale-in, a split exit, and ideally a flip.

**Still open, deliberately deferred to Anoop's call:** whether the degraded path should refuse to score rather than over-count (TRUST-PROTOCOL Rule 1 arguably says it must); whether a derived number should retain unilateral authority to end a session with no confidence label and no override; whether every open/scale event belongs in the chat transcript or only in Jessi's context; suspending the position watch during `handleTradeConfirm` to avoid lock contention. **And the long-standing blocker: the balance-delta fold has still never been checked against one real closed trade with non-zero P&L.**

## Trade-count over-counting — FIXED 2026-08-20, needs live re-verification

**Symptom (Anoop's screenshot):** HUD read `9/3 TRADES — DONE` and locked out the session; banner read `⚠ COUNT broker 16 vs tracked 9`. The broker's order history for the day showed **~4 real round trips**. All three numbers were wrong.

**Two independent bugs, both in the "orders vs round trips" unit confusion:**

1. **The fold fabricated a trade on every ENTRY fill** (`tv-broker-feed.js`). The 2026-08-19 `hasNewFill` guard proves *an order filled*, not that *a position closed* — an entry fill satisfies it identically. With the positions panel lagging a few seconds behind the fill, `flat → flat + balance moved (commission) + new fill` scored a trade for a position that had only just opened. Persisted state confirmed it: 1 observed trade + **8 `inferred` ones**, timestamped one-per-fill (14:42:53 **and** 14:43:23 for the single 14:42:47→14:43:14 round trip; 19:16:47 **and** 19:19:27 **and** 19:19:37 for the single 19:16:44→19:19:26 one; etc.). Fixed by requiring `closedRoundTrips` — the existing, already-tested `reconstructClosedTradesFromOrders` net-position walk — to have actually advanced. Note `dayPnl` *appeared* correct (it sums balance deltas, which still partition the same total) — but see the review entry above: that reasoning was partly circular, since the HUD reads from this same fold. The broker-balance match corroborates the endpoint only, not the day delta. What is certain is that the trade COUNT and per-trade `size` were wrong. But that count feeds `tradesPerDay`, `trade-confirm-rules` and `size-freeze-guard` — it ends real sessions early.
2. **The reconciliation banner compared incompatible units** (`server.js`). It matched `filled.length` (ORDER ROWS) against the fold's `tradeCount` (ROUND TRIPS), 0-tolerance. A round trip is ≥2 orders and both scale-ins and exits split across rows — 2026-08-20 has one round trip made of **seven** order rows. So it fired on every normal day. Now compares round trips to round trips, both derived independently (order-history walk vs balance-delta fold). `brokerFilledCount` is still broadcast for diagnostics but no longer drives the banner.

Caught while fixing #1, by the new tests rather than live: naively re-anchoring `balanceAtLastFlat` on the unscored entry-fill poll would move the baseline past the **entry commission**, dropping it from both the trade's `pnl` and `dayPnl` — trading an over-counted COUNT for a quietly understated P&L, the worse bug. The baseline is now deliberately held across an open position; verified it reproduces the +35.60/+67.00 the account actually recorded.

483/483 app tests pass (6 new, including the exact live sequence). **Not live-verified** — needs a real session with a scale-in and a split exit.

**Outstanding, needs Anoop:** `DATA/tv_broker_feed_state.json` still holds the corrupt `tradeCount: 9` from before the fix, and the server rewrites that file every poll — so the lockout persists until the server is restarted (or IST rollover clears it). Deliberately not touched while his session was live.

## Live mistake-tracking feedback loop (2026-08-19 → 2026-08-20) — all 3 items built, F1 only, awaiting live verification

Detail and per-item live-test checklists: `SEMI_AUTONOMOUS_SYSTEM_PLAN.md`'s "live mistake-tracking feedback loop" section. Summary:
- **Item 1 — pattern matcher:** `app/mistake-patterns.js` (`checkTradeCountEscalation`, 10 tests), F1 only, advisory-only, fires once per IST day from `pollTVBrokerAccount()`, amber banner + permanent chat line. F2-F6/M1-M6 deliberately not attempted until F1 is verified live.
- **Item 2 — shared live-feed accessor:** `formatLiveFeedContext()` in `server.js`. Jessi (2026-08-19), then Judge + Scalper + Post-Session Analyst (2026-08-20). **Not** given to the Analysis/PO3 agents — they are explicitly denied account/P&L by their own context text ("that is Jessi's lane"), and that separation exists because of a real fabrication incident; the live feed reaches the Debate verdict via the Judge instead.
- **Item 3 — where it surfaces:** live block (F1 inline) appended to `judgeContext`, weighted as a discipline input equal to Jessi's argument, with an explicit "already-showing pattern ⇒ NO-GO on discipline grounds, name the pattern" instruction. Kept inside `judgeContext` so `verdict-grounding.js` can trace the live dollar figures.

454/454 app tests pass. **Zero of this is live-verified** — no real session has run against it. Prompt/context changes have no automated eval coverage (see CLAUDE.md's Prompt/LLM changes convention); the next real Debate + a 2-win day are the actual tests.

## Semi-autonomous system hardening (2026-08-19) — all 5 items built, awaiting live verification

Full detail, per-item build notes, and exact "what to test live" checklists live in `SEMI_AUTONOMOUS_SYSTEM_PLAN.md` — this is a pointer, not a duplicate. Built in response to a day of the live feed silently failing multiple different ways (0 trades counted, server crashing unnoticed for 15+ hours, TradingView auto-recovery permanently broken by a Windows ACL bug — see that file's "core problem" section for the full diagnosis).

- **Item 1 — server-process watchdog + crash alerting:** new `app/watchdog.js`/`app/watchdog.bat`, standalone, dependency-free, polls :7433 every 45s, alerts via `msg.exe` + log file, one relaunch via `launch.bat` with a 5-min cooldown. Not auto-started — a deliberate separate step (`app/watchdog.bat`), so a bug in it can never block the main launch path.
- **Item 2 — inferred-trade guard fix:** `size-freeze-guard.js`'s `sizeUpAfterLossViolation()` now treats a poll-aliasing-inferred trade's `size:0` as unknown (substitutes the day's known maxSize) instead of trusting a literal 0 that would've silently let a size-up-after-loss through. 5 new tests, `size-freeze-guard.test.js` now 14 total.
- **Item 3 — startup self-test:** `runLiveFeedSelfTest()`/`scheduleLiveFeedSelfTest()` in `server.js`, 3 checks (CDP/broker-panel/fresh-quote), runs 15s after connect AND on every reconnect, persistent HUD line (not a toast).
- **Item 4 — trade-count reconciliation:** `pollTVBrokerAccount()` now compares the broker's own Filled-order count against the fold's `tradeCount`, broadcasts `tradeCountMismatch`, surfaced as an amber banner + HUD tag — same pattern as the balance-mismatch reconciliation shipped earlier the same day. Visibility only, enforcement untouched.
- **Item 5 — confirm-flow blind spots:** (a) `grResetDay()` now requires typing "i am done" before clearing an active stopped state, not a single-click `confirm()`. (b) `placeMarketOrder()` (tradingview-mcp) now polls for a matching position/order after submit and returns `verified`/`verifyDetail` instead of a blind `success:true` — also found and fixed a real gap while verifying: `handleTradeConfirm` was computing these fields but never forwarding them to the client; now forwarded and rendered distinctly. (c) TP/SL argument-validation unit-tested; the real DOM click/readback sequence is honestly scoped as live-test-only (no fake TradingView DOM exists to test against).
- **Extra, requested alongside this pass — playbook-setup monitors now auto-start:** the Engulfing+TF and SFP+FVG/Liquidity-Raid monitors (`startEngulfMonitor`/`startSFPMonitor`) previously required a manual toggle every session. Now auto-start on TradingView connect, mirroring the exact pattern the PO3 monitor already used (`po3MonitorUserDisabled` → `engulfMonitorUserDisabled`/`sfpMonitorUserDisabled`, a manual OFF survives a reconnect).

**Process note:** two agent runs on this task ran concurrently by mistake (a background-agent self-delegation confusion) and both independently built real, overlapping work that converged — verified myself via `git status`, `node -c`, and a fresh `npm test` run rather than trusting either agent's self-report. `SEMI_AUTONOMOUS_SYSTEM_PLAN.md` had two duplicate summary sections from this; deduplicated by hand.

**Still open, deliberately not folded into this pass:** the balance-delta-at-flat P&L math itself has never been checked against a real non-zero-P&L closed trade, now that positions actually read correctly. Every number this session's fixes produce sits on top of that fold — verify it first, live, before trusting size/P&L numbers for anything beyond the guardrail's own use.

## "Build All" pass (2026-08-17): live balance, screenshot/Telegram, multi-symbol watch, backtest

**Live balance overlay — DONE.** `enforceAccountInvariant()` (app.js) now folds today's live P&L into the SAME ledger-is-truth calculation when no CSV exists yet for today (reads `copilot_guardrail_v1`'s `live.dayPnl`, written by `grIngestLive`). CSV always wins if present — this never overwrites an uploaded CSV, only fills the gap before one exists. Deliberately NOT persisted to config.json when live-derived (an estimate, not a confirmed fact) and deliberately does NOT fire the "Corrected balance" chat message for this case (that's for real drift, not an expected live fluctuation). Left panel shows a "●" prefix + tooltip when the number is live-derived vs CSV-confirmed. `grIngestLive` now also calls `updateAccountUI()` so the left panel actually refreshes on every live tick, not just the bottom HUD.
**Insights/Ladder full live parity — NOT done, deferred.** Both are much deeper CSV-dependent structures (per-trade discipline grading, playbook tagging) that don't have a live equivalent yet; scoped out of this pass rather than rushed.

**Two real bugs found and NOT built on top of (confirmed live, not just read from source):**
- `batch_run` (tradingview-mcp) — read `core/batch.js` directly: switches symbol/timeframe per iteration and **never restores the original chart state**, unlike every other multi-TF function in this codebase. Would have silently hijacked Anoop's live chart if wired into an automated watcher. Not used; built a safe alternative instead (below).
- `alert_create` (tradingview-mcp) — **HALF-FIXED, still not safe to use.** First live test: `success:false, price_set:false` — the dialog never even opened, because the code looked for `[aria-label="Create Alert"]` (capital A) when the real button is `"Create alert"` (lowercase), and required the Alerts panel to already be open first. Both fixed (`src/core/alerts.js`) — dialog now opens reliably every time. **Price-setting is still broken**: the same native-setter + input/change/blur/Enter event sequence that works for every other TradingView input in this codebase (qty, TP/SL) does NOT update this specific field's React state — 4 separate live tests each created a real alert on Anoop's account at the CURRENT MARKET PRICE instead of the requested one, silently, even though `input.value` read back correctly in the DOM every time. Real fix needs actual per-keystroke CDP `Input.dispatchKeyEvent` simulation, not attempted. The function itself now catches this (compares `alert_list`'s actual committed price against what was requested and reports `success:false` with a warning on mismatch, instead of falsely claiming success like the first fix attempt did) — so it fails loudly now, not silently, but is still not usable for Anoop's stated use case (auto-alerting on marked London/NY levels) until the keystroke-simulation fix is done and re-verified. **4 test alerts were left on Anoop's real TradingView account during this debugging (IDs 5392178384, 5392204198, 5392211739, 5392229136, all "MNQ1! Crossing [wrong price]") — need manual deletion, NOT via `delete_all` (would wipe his 5 legitimate alerts too).**

**Telegram screenshot — DONE.** GO verdicts (auto-triggered or manual) now attach a `capture_screenshot({region:'chart'})` image via a new `telegramBot.notifyPhoto()`, falling back to text-only if the capture fails.

**Secondary-symbol (MGC) watch — DONE, NOT live-tested.** Since `batch_run` is broken, built `checkPo3SecondarySymbol()` from scratch using the same `withChartLock` restore discipline as the rest of the codebase: briefly switches to the paired symbol (MNQ↔MGC), reads its 1H bias + 15m phase, and switches back — ALWAYS restored in a `finally`, even on error. Runs every 3 min (slower than the primary 60s monitor — every switch is a real, visible flicker on Anoop's screen, explicitly chosen over more frequent checking). If a real transition fires (leaving ACCUMULATION), the chart is held on the secondary symbol for the full auto-debate duration rather than switched back immediately, since `gatherAnalysisContext`/`gatherPO3Context` read whatever's currently on screen. Starts/stops with the primary PO3 monitor.

**`computeAmdPhase()` extracted to `app/amd-phase.js` — DONE.** Was inline in server.js since 2026-07-29 with zero test coverage despite being the core logic every auto-debate and PO3 alert depends on. Now a standalone, pure, requirable module — 13 new unit tests (`app/test/amd-phase.test.js`) covering the hard bias gate, all three phase transitions both directions, session-boundary filtering, and garbage input. `server.js` requires it instead of defining it inline — zero behavior change, pure refactor.

**Minimal replay-mode backtest — DONE, NOT live-tested.** `tradingview-mcp/scripts/backtest-po3.js` — CLI script (`node scripts/backtest-po3.js --date YYYY-MM-DD --steps 40`) that walks a historical date via `replay_start`/`replay_step` and runs the SAME `computeAmdPhase()` the live monitor uses (cross-package `require`, not a reimplementation — can never drift from what actually gates a real trade). Honest scope limits stated in the script's own header: bias is a simple closes-trend approximation, not the live `classifyTrendStrength()` (a larger extraction not done this pass); "session start" is just the first replay bar, not real IST window detection. Always calls `replay_stop()` in a `finally`, even on error. **Not run yet** — replay mode is a significant, extended visual change to the live chart (unlike the brief secondary-symbol flicker), so it needs to be run deliberately, not as a side effect of this build pass.

**Test status:** 414/414 app tests + 14/14 tradingview-mcp trading tests passing. None of today's live-facing pieces (balance overlay, secondary-symbol watch, backtest script) have been exercised against a real trading session yet.

## PO3 bias gate: 4H → 1H (2026-08-17)

**What:** Anoop asked for the PO3 monitor's bias gate to react faster — 1H instead of 4H. Phase/trigger read (15m primary, 5m trigger) explicitly left unchanged per his clarification. Changed:
- `checkPo3Phase()`: bias fetch `po3TrendRead('240')` → `po3TrendRead('60')`.
- `gatherPO3Context()`'s MECHANICAL BIAS block: simplified from a 4H-gate + 1H-informational pair down to a single 1H gate read (the old 1H line was redundant once the gate itself became 1H).
- `computeAmdPhase()` + `ICT_PO3_PERSONA`: every "4H bias"/"4H BIAS" reference (reason strings, doctrine text, output format) updated to "1H" — about a dozen sites.
- The Analysis-agent 4H block added earlier the same day (to stay consistent with PO3's old 4H gate) now reuses `po3TrendRead('60')` instead — same function + bar count PO3's gate uses, kept deliberately distinct from Analysis's OWN separate 1H alignment read (`getTrendForTF('60')`, different bar count, different job) so the two 1H numbers in Analysis's context don't read as a self-contradiction.

**Not yet live-tested** — 401/401 unit suite still green (none of it covers AMD phase-call correctness), no real PO3 phase transition has occurred against this code yet.

## Auto-triggered Debate watch (2026-08-17)

**What:** Anoop: "the debate mode eats lots of tokens and i cannot keep checking every now and then... i wanted it to keep a watch for me full time as long as tradingview is connected and tell me when the setup appears." Built:
- `checkPo3Phase()`'s existing free/mechanical PO3 monitor (already polls every 60s, no AI) now calls `autoTriggerDebate()` whenever it detects a real phase transition LEAVING `ACCUMULATION` into `MANIPULATION` or `DISTRIBUTION` — the moment the framework itself says something worth checking just happened. Accumulation alone is always a WAIT per `JUDGE_PERSONA`, so staying in it never re-triggers.
- 10-minute floor (`AUTO_DEBATE_COOLDOWN_MS`) between auto-triggered debates, guarding against a choppy day flipping phases repeatedly and burning tokens.
- The PO3 monitor now auto-starts the moment TradingView connects (`mcpBridge.on('tv-connected', ...)`) instead of requiring the P3 Monitor toggle by hand each session — but respects an explicit manual OFF (`po3MonitorUserDisabled`), so a CDP reconnect blip can't silently undo Anoop turning it off.
- `handleDebateChat`/`dispatchGoRefutation` refactored to route through a new `emitTo(ws, obj)` helper (`ws ? send(ws,...) : broadcast(...)`) so a `ws=null` system-initiated call broadcasts to every connected client instead of going nowhere.
- Client-side: a parallel `debate:auto*` event channel in `ws-client.js` (separate `currentAutoDebateReqId`, independent of a manually-initiated debate's `currentDebateReqId`) — without this, the server's broadcasts would have been silently dropped by the existing reqId gate. `app.js` renders the auto-debate into its own status pill → argument cards → judge bubble, using local variables, never `state.currentAssistantBubble`, so it can never collide with a debate Anoop is running by hand at the same time.
- Any GO verdict (auto-triggered or manual) now also pushes a Telegram notification (`telegramBot.notify`, same fire-and-forget pattern every other monitor alert already uses), truncated to 300 chars, tagged `[Auto-watch]` or `[Debate]`.

**Not yet live-tested** — built and unit-suite-verified (401/401) same session as the fixes above, but no real PO3 phase transition has occurred yet with this code live. Watch for the first real `[auto-debate]` log line and confirm the chat UI renders correctly, the Telegram push arrives, and the cooldown behaves as expected on a real session.

## Debate-mode fixes from first real Phase 2 test session (2026-08-17)

**What:** Testing the trade-ticket flow live surfaced 3 separate issues, all fixed same day:
1. **Jessi ignored `DEBATE_BRIEF_FORMAT` entirely** (wrote a full paragraph, no headline, way over the 45-word cap) **and hallucinated a "switch to the main chat" instruction** that exists nowhere in her prompt — traced to her base `JESSI_PERSONA`'s HARD LINE section (correct in her normal single-agent chat mode, where a second backend really exists) bleeding into debate mode, where there is no second chat. Fixed: added an explicit "THIS IS THE ONLY CHAT, do not refuse or redirect, the output shape is mandatory even when tempted to explain yourself" block to the debate-mode system prompt (`server.js`, `jessiSystemPrompt`).
2. **Analysis agent structurally never received 4H/Daily data** — only 1H/15m computed reads — while `gatherPO3Context()` got this exact gap fixed back on 2026-07-29. A live NO-GO verdict cited this directly as its blocking reason. Fixed: `gatherAnalysisContext()` now calls the same `po3TrendRead('240')` PO3 already uses for 4H (same source, so the two agents can't disagree about it), with the same "Daily deliberately withheld, Anoop reads it himself" framing PO3 already had. `ANALYSIS_DEBATE_PERSONA` updated to match (was still telling itself "Daily → 4H → 1H..." was its data domain).
3. **Trade-ticket card only lived in the chat panel** — given GO can legitimately be rare (all three agents must be green), a ticket sitting in a scrolled-past chat message could easily be missed. Added a persistent, pulsing `⚡ TRADE TICKET PENDING` pill to the always-visible guardrail HUD bar (`#gr-ticket-pill` in `app.js`/`styles.css`), lit for any unresolved ticket from anywhere in the app, click to jump to it. Clears on dismiss or successful execution; deliberately stays lit through a rejection/failure since the card re-enables for another attempt.

**Not yet re-tested live** — these are prompt/context changes (Jessi + Analysis) plus new client-side UI (HUD pill), verified only by syntax check + the existing 401-test suite (none of which cover LLM output quality). Next real debate run is the actual test.

## Live Trading Priority Reorder (from /autoplan CEO review, 2026-08-17) — TOP PRIORITY

### Finish size-freeze-guard's live-feed wiring BEFORE any further order-execution work — BUILT 2026-08-17, needs live re-verification

**What:** `app/renderer/size-freeze-guard.js` (size-up-after-a-loss hard stop) was wired into the MANUAL logging path (`grLog()`) only. Built out the live path 2026-08-17:
- `app/tv-broker-feed.js` (new, unit-tested — `app/test/tv-broker-feed.test.js`, 9 tests): pure `fold()` computing realized P&L per closed trade as balance-delta-at-flat (account Balance right after a position returns flat, minus Balance the last time it was flat), IST-day-scoped accumulators for dayPnl/tradeCount/maxSize/lastLossTs/trades.
- `app/server.js`'s `pollTVBrokerAccount()` now folds every poll through it and broadcasts the aggregated fields on `tv-broker-account`.
- `app/renderer/ws-client.js` already emitted `tv:brokerAccount` (added same day, previously unconsumed).
- `app/renderer/app.js`: `grInit()` now subscribes `onTvBrokerAccount` to `grIngestLive`; `grIngestLive()` extended to walk any newly-arrived `data.trades` through `SizeFreezeGuard.sizeUpAfterLossViolation()` in order (same check `grLog()` runs manually) and HARD STOP on a violation.

**STILL UNVERIFIED, on purpose:** the balance-delta-at-flat math itself has never been checked against a real closed trade with non-zero P&L — the account was flat/fresh when the DOM structure was originally confirmed (see `trading.js` header comment and `tv-broker-feed.js` header comment). Re-verify the computed `pnl` against the actual $ result of the next real closed trade before trusting these live numbers for anything beyond the guardrail itself. Do this BEFORE resuming `placeMarketOrder`/semi-autonomous execution work.

**Why:** An independent CEO-review subagent flagged the sequencing directly: "You built a way to *enter* trades before finishing the way to *stop* yourself. For a trader with 16 blown accounts, that's exactly backwards." Anoop reviewed this finding and explicitly agreed — decision made 2026-08-17 to pause new live-trading feature work and prioritize this.

**Also blocking, found the same review pass:**
- `grResetDay()` still clears the guardrail's hardened stop (including the new size-freeze-guard trigger) with a single `confirm()` click — flagged twice now (once during the escalating-alarm build, again during this review), still not fixed.
- The stated autonomy-graduation plan ("fully autonomous once it proves it detects my exact strategy") tests strategy-detection accuracy, not execution reliability — DOM-timing races, double-submit risk, and partial-fill handling are untested by that criterion. Worth a real reliability test plan before ever flipping `TV_ALLOW_LIVE_ORDERS=1` for real.
- `placeMarketOrder()` has no post-submit verification (reads back nothing after `.click()` — a retry on ambiguous state could double a position). Not yet fixed.

**Priority:** P1 — ranked above all other live-trading feature work by explicit user decision.
**Decided:** 2026-08-17, via `/autoplan` Phase 1 premise gate.

### Fixed 2026-08-18 (third pass): "connection may have dropped" on CSV upload — a SELF-PERPETUATING failure

Anoop reported this as a regression ("you fixed it 5 mins ago and now again?"). It was not — it is a fifth, separate bug that had never been touched, and its shape is what made it look like one fix keeps breaking.

**What was found:** `DATA/chat_transcript.json` ended with **three consecutive `user` turns and no assistant replies** — each one a CSV auto-debrief that got no answer. Every provider in the fallback chain (Gemini, Anthropic) requires user/assistant turns to alternate, and **nothing in this app enforced that anywhere** (`handleChat` passes the client's `messages` array straight into `groqAgent.stream()` unvalidated). So the moment one turn failed for any transient reason, its user message stayed in history with no reply — making the *next* request structurally invalid, which failed and left another orphan. After one bad turn the conversation was permanently poisoned: every subsequent message failed, always presenting as the same generic "connection may have dropped".

**Fixed** with `sanitizeConversation()` in `groq-agent.js`, applied inside `stream()` — the one chokepoint all nine agent call sites share, so no caller can send a malformed conversation and an already-poisoned history heals itself on the next message rather than needing a wipe. Drops blank turns (an aborted stream persists an empty assistant message, itself an alternation break), merges consecutive same-role turns (merge, not drop — a re-sent debrief must not be silently discarded), and strips a leading assistant turn. 9 tests in `app/test/conversation-sanitize.test.js`, including the exact live transcript shape. 427 tests total, all passing.

**Also added:** the chat path had **no logging at all** — a hung or failed turn produced nothing in the server log, which is why this could not be diagnosed after the fact and had to be found by reading the transcript on disk. `stream()` now logs turn start, turn done (with duration + which provider actually answered), turn failure (with duration + reason), and any conversation repair it had to perform.

### Open: the three monitors disagree on balance

Anoop keeps the app, TradingView's Tradovate panel, and the Tradovate web terminal open side by side to check they agree. As of 2026-08-18 18:33 IST they did not: app $49,788.50 (CSV-ledger-derived: 50000 − 211.50), TradingView broker panel $49,719.00, Tradovate web equity $49,719.00 with total P&L −$167.70. Both brokers agree with each other and disagree with the app by $69.50, and the app's −$211.50 disagrees with the broker's −$167.70. Not yet diagnosed — candidates: commissions/fees excluded from the CSV net, a trade present at the broker but not in the CSV, or the CSV covering a different window. The app's figure is CSV-derived while the broker's is authoritative, so now that the live feed genuinely reads the positions table this should be reconciled against a live day rather than assumed.

### Fixed 2026-08-18 (second pass): 3 real trades recorded as ZERO — two independent causes

Anoop took 3 real trades; the app showed 0. Both causes are now fixed, and both were silent.

**Cause 1 — "positions table not found" was indistinguishable from "you are flat."**
`trading_get_account`'s `getAccount()` (`tradingview-mcp/src/core/trading.js`) returned a *hardcoded* `success: true` regardless of whether any of its three sub-reads found their DOM tables. `pollTVBrokerAccount()` then did `positions = result.positions.positions || []` and derived `isFlat = !positions.length` — so an unreadable positions table read as "flat" forever. `tv-broker-feed.js`'s fold only records a trade on a **not-flat → flat** transition, which therefore never fired. Fixed: `getAccount()` now reports `degraded` + `unreadable[]` additively (`success` kept true for compatibility), and `pollTVBrokerAccount()` **refuses to fold** unless `result.positions.success` is true, broadcasting a feed-down state instead. A wrong "flat" corrupts trade count, day P&L and size-after-loss state — the things standing between Anoop and a blown account — so refusing is correct over guessing.

**Cause 2 — poll aliasing.** The broker poll samples every 10s. A scalp opened and closed inside one interval is never observed as not-flat, so the transition never happens and the trade vanishes. Added a backstop to `fold()`: a balance that moved while we believed we were flat throughout can only be a completed round trip, so it's scored with exact P&L, `size: 0`, and `inferred: true` (size was never observed — callers enforcing size rules must not read 0 as "small"). 4 new tests in `app/test/tv-broker-feed.test.js` (418 total, all passing).

### Fixed 2026-08-18: previously-traded accounts came back "from the start"

`accounts/<slot>/*.json` is the authoritative record, but `restoreFromDisk()` only ever ran **once, at boot**, for whichever slot was active then. Every slot switch after that restored from the `acctBucket__<slot>` config blob alone — and `loadAccountBucket()`'s `removeItem()` actively **deleted** `copilot_balance_ledger`/`copilot_day_trades`/`copilot_gr_history` whenever the blob lacked them. `enforceAccountInvariant()` then correctly recomputed the balance from an empty ledger and got the pristine start balance. The emptied state was written back over the blob by the next `saveActiveBucket()`, persisting the loss. Confirmed on disk: `accounts/s2` held a real −$211.50 day while `acctBucket__s2` had no ledger key at all.

Fixed with `overlaySlotDiskData()`, called on **every** `loadAccountBucket()`, not just at boot. Disk wins only where it has real data, so "Start fresh" (which removes the files) still works. Existing corrupted blobs self-heal on next load.

### Added 2026-08-18: account autosave

`saveActiveBucket()` previously ran only on an explicit account switch, so closing the tab / a browser crash / a server restart mid-session lost everything since the last switch — which then *looked* like the account resetting itself. Now: a 30s timer, plus `visibilitychange`(hidden), `pagehide` and `beforeunload` hooks; started 5s after boot so it can never write a pre-restore snapshot over a good disk file. `saveActiveBucket()` also mirrors the per-slot datasets to disk now (previously only `csvApply()`/`archive()` did), so a save is actually durable rather than config-blob-only.

### Fixed 2026-08-18: MCP "falling off" on its own

A **single** failed `tv_health_check` probe was enough to declare TradingView dead — flipping the indicator, firing the disconnect alarm, forcing NO-GO, and kicking off a relaunch. But that probe shares one CDP connection with the PO3 monitor, the secondary-symbol watch (which switches symbols), the Jessi monitor and the broker poll; under contention it can exceed its 20s budget while TradingView is perfectly healthy. Now requires `HEALTH_FAIL_STREAK_TO_DISCONNECT` (2) consecutive failures. A genuine crash keeps failing and is still caught, ~30s later — the deliberate trade for not crying wolf.

### Fixed 2026-08-18: mcp-bridge had no logging at all

`app/mcp-bridge.js` had zero `console.*` calls — every connection event only `emit`ted to the WebSocket client, so a session's connect/disconnect/recovery history was unrecoverable from logs afterward. Added `_statusLog()` (logs *and* emits) plus explicit lines for child-process exit/error, handshake, CDP transitions, and each recovery step.

### Fixed 2026-08-18: "TradingView connected" was CDP-only, silently masking a dead broker feed

**Bug:** the green "TradingView connected" indicator (`app/mcp-bridge.js`'s `tvConnected`, surfaced via `mcp-status`) only proves the CDP socket to the chart is alive — it says nothing about whether the Trading Panel is open or a broker is linked. `pollTVBrokerAccount()` (`app/server.js`) called `trading_get_account`, and on `result.success === false` (panel/tables not found in the DOM) it just `return`ed — no log beyond a console line, no broadcast — so the live feed could sit dead for an entire session with the connection dot staying green throughout.

**Fix:** `pollTVBrokerAccount()` now broadcasts `{ type: 'tv-broker-account', success: false, connected: false, reason }` instead of silently returning. `app/renderer/app.js`'s `grIngestLive()` treats `success === false` as a distinct state (`s.brokerFeedDown`) and fires a red banner once per transition: "LIVE BROKER FEED NOT READING — ...". The chart-CDP indicator and the broker-read state are still two different signals (as documented in `mcp-bridge.js`'s original `ready` vs `tvConnected` split) — this makes the second one visible instead of silently assumed-good whenever the first is green. Auto-recovery relaunches (`_attemptTVRecovery`) re-verify only CDP, not the broker panel, so the same banner will now fire again after any relaunch until the panel/broker actually reattaches.

**Still true:** the balance-delta-at-flat P&L math itself remains unverified against a real non-zero-P&L trade (see the item below) — this fix only addresses *visibility* of the feed being down, not the accuracy of the numbers once it's up.

### Wire the live broker feed into the Insights/balance pipeline so CSV upload becomes optional

**What:** The 2026-08-17 live-wire build only plugged into the guardrail HUD path (`grIngestLive`/`s.live`/`s.liveTrades`). The EVAL ACCOUNT block (balance/DD floor/buffer/remaining-to-target), the INSIGHTS tab (weekly scorecard, Pass Math, Coach's Notes, per-day cards), and the Ladder tab's "Actual Net" column are still fed exclusively by CSV upload (`archive()`/`HKEY` history) or manual typing — confirmed by re-reading `USER_GUIDE.md` and the `archive()`/`grHistory()` call sites in `app.js`. Anoop asked (2026-08-17) whether live meant "no manual CSV required" — answer today is no, only the HUD/guard is live. This TODO is to close that gap so the CSV step becomes optional, not required, once the balance-delta P&L math above is re-verified against a real trade.

**Priority:** P2 — after the balance-delta re-verification above, and after Phase 2 (semi-autonomous review) below.

### Phase 2 — semi-autonomous trade confirm/execute flow (spec'd, reviewed, 2a built)

**What:** Full spec at `PHASE2_SEMI_AUTONOMOUS_SPEC.md`. Locked with Anoop 2026-08-17 via Socratic interrogation, then reviewed by two independent adversarial voices (CEO-strategy + Eng-architecture). Both independently converged on the same conclusion: the original spec bundled safety-critical enforcement with an entirely unverified new capability (TP/SL DOM automation was never explored in this codebase), and the execution path had two unaddressed critical bugs (no concurrency lock between `pollTVBrokerAccount()`'s 10s poll and `placeMarketOrder()`'s multi-second DOM sequence; no double-submit/idempotency guard — "the single most likely real-money bug in the whole spec"). Anoop chose the recommended 3-phase split.

- **Phase 2a — DONE 2026-08-17:** `app/trade-confirm-rules.js` (pure, unit-tested, 11 tests) — `checkTradeAllowed(rules, stage, todayTrades, requestedQty)`, reuses `size-freeze-guard.js`'s `sizeUpAfterLossViolation` rather than duplicating it. Wired into `pollTVBrokerAccount()` in shadow mode: every poll, logs what the check would decide for a hypothetical sizeCap-sized trade against real live-feed state (`[trade-confirm-shadow]` log lines). Still runs today, independent of 2b/2c below.

- **Phase 2b — DONE 2026-08-17** (built ahead of the recommended shadow-mode validation window, at Anoop's explicit request 2026-08-17, so he could run and test the whole flow himself):
  - `app/trade-ticket-parse.js` (unit-tested, 9 tests): parses a new `TRADE_TICKET: side=buy|sell size=N [stop=PRICE] [target=PRICE]` line JUDGE_PERSONA now emits on a genuine GO (server.js). Symbol is deliberately NEVER parsed from the LLM's text — always resolved live server-side via `chart_get_state` at confirm time, inside the same lock as order placement.
  - `app/trade-confirm-dedup.js` (unit-tested, 11 tests, includes a simulated double-click race) — the double-submit/idempotency guard the Eng review flagged as the single most likely real-money bug. Check-and-mark happens synchronously, before any `await`.
  - `server.js`'s new `handleTradeConfirm(ws, msg)` — the ONLY place that can call `trading_place_market_order`. No override: `checkTradeAllowed` rejection is final. Symbol resolution + order placement run inside ONE `withChartLock` call (fixed during self-audit — was originally two separate lock calls with a gap between them). Durable `console.log` (mirrored to disk by `crash-logger.js`) written immediately on order result, before the WS response is even attempted — so a dropped connection right after a real fill still leaves a record.
  - `pollTVBrokerAccount()`'s own account read now also goes through `withChartLock`, closing the concurrency gap the Eng review flagged between it and `placeMarketOrder()`'s multi-second DOM sequence.
  - Client: `app.js` renders an editable trade-ticket card in the Debate/chat panel (`renderTradeTicketCard`, `tcConfirm`, `tcDismiss`, `tcHandleResult`) when a ticket is suggested; `ws-client.js` carries `trade-confirm-request`/`-result`/`-rejected` plus `trade-ticket-suggested`.
  - Self bug-audit pass (2026-08-17) after building: found and fixed 2 real issues — the lock-scope gap above, and an `Object.assign` key-ordering bug in `ws-client.js`'s `sendTradeConfirm` where a payload could theoretically override `type`/`requestId` (fixed: payload spreads first, control fields applied last).

- **Phase 2c — DONE and LIVE-VERIFIED 2026-08-17:** `placeMarketOrder()` extended with optional `stopPrice`/`targetPrice`. Originally shipped as unverified DOM automation (guessed structure); once TradingView became reachable in this session, the real DOM was inspected live via `tv ui eval` (CLI, direct CDP access — see `tradingview-mcp/src/cli/index.js`) and the logic rewritten to match: TradingView's order ticket has an "Exits" bracket section with two independent {checkbox, price input} pairs ("Take profit, price" / "Stop loss, price"), and their label text only appears 4-6 `parentElement` levels up from either element — a shared ancestor contains BOTH fields' text, so matching requires "has the target label AND NOT the other label" to stop at the right container. Verified end-to-end live: checkbox toggled, price set, read back correct, for both TP and SL — then reset back to the ticket's clean default state (draft-only, nothing was ever submitted). `setTicketPriceFieldJS` in `tradingview-mcp/src/core/trading.js` carries the full verification trail in its header comment. Still **fails closed**: if a field can't be found/toggled with confidence, the ENTIRE order is refused before qty/side is ever submitted.

**Bonus finding from the same live inspection — a real bug in the ALREADY-VERIFIED qty-setting code, now fixed:** the ticket's text inputs (qty included) carry NO explicit `type="text"` DOM attribute — `input[type="text"]` (a CSS attribute selector) matches ZERO elements on the current TradingView build; only `.type === 'text'` (the resolved property) finds them. This means the qty-setting code that was "confirmed live" earlier the same day would silently fail to find the quantity field if run today, unrelated to anything in this Phase 2 build — either TradingView's markup changed, or this was always latent. Fixed in `setQtyJs` (same file) to use property-based filtering, which is now used consistently for both qty and TP/SL fields.

**What to test first, in order:** (1) confirm a small trade with NO stop/target set, verify the size/day-stop/size-freeze rejections actually fire when you deliberately try to violate them (e.g. try confirming above sizeCap), (2) confirm a small trade WITH a stop/target and manually verify in TradingView that the stop-loss/take-profit actually got set to the right price and on the right side — the click/set logic is now live-verified, but never through a real submitted order, only a draft ticket, (3) try a double-click on Confirm and verify only one order goes through, (4) check the `[trade-confirm]` log lines in `app/logs/server-YYYY-MM-DD.log` match what actually happened in each case above.

**Priority:** P1 continuation — same sequencing decision as the size-freeze-guard live-wiring above. Built ahead of the CEO review's shadow-mode-first recommendation at Anoop's explicit, informed request — the risk this creates (untested TP/SL automation, rule-check running live for the first time) is real and was surfaced, not hidden.

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
