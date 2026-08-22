<!-- /autoplan restore point: /c/Users/Admin/.gstack/projects/MNQ-CoPilot/master-autoplan-restore-20260820-214341.md -->
# Live Trade Events — Plan

**Status:** built 2026-08-20, zero live verification. Written after the fact, as input to a full review pass.
**Owner:** Anoop Habib. **Branch:** master. **Subsystem:** `app/tv-broker-feed.js`, `app/position-events.js`, `app/server.js` broker poll, `app/renderer/app.js` HUD/chat.

Related: `SEMI_AUTONOMOUS_SYSTEM_PLAN.md` (the wider autonomy roadmap this sits under), `PHASE2_SEMI_AUTONOMOUS_SPEC.md` (the confirm/execute flow that consumes these counts), `TRUST-PROTOCOL.md` (the anti-fabrication rules this plan is bound by), `TODOS.md` (built-vs-verified ledger).

---

## 1. The problem

Anoop's HUD read `9/3 TRADES — DONE` and locked him out of a live session. The broker's own order history showed roughly **four** real round trips. The reconciliation banner read `⚠ COUNT broker 16 vs tracked 9`. All three numbers disagreed, and none was right.

Diagnosis from the persisted feed state (`DATA/tv_broker_feed_state.json`) plus the broker's orders table:

**Bug 1 — the fold scored a trade on every ENTRY fill.** `tv-broker-feed.js`'s poll-aliasing backstop fired on `flat → flat + balance moved + hasNewFill`. `hasNewFill` proves *an order filled*, not that *a position closed* — an entry fill satisfies it identically. With TradingView's positions panel lagging a few seconds behind the fill, an entry produced: balance moves (commission), new fill exists, panel still reads flat → scored as a completed trade. State held 1 observed trade plus **8 inferred ones**, timestamped one-per-fill:

| Broker round trip | Fold scored |
|---|---|
| 14:42:47 sells → 14:43:14 Buy 12 | 14:42:53, 14:43:23 |
| 19:16:44 Buy 2 → 19:19:26 sells | 19:16:47, 19:19:27, 19:19:37 |
| 19:45:56 Sell 3 → 19:46:48 Buy 3 | 19:45:59, 19:46:59 |

`dayPnl` **appears** correct (it sums balance deltas, which still partition the same total), and the state's `balanceAtLastFlat` of 49,953.80 matches the broker panel's own displayed Account Balance of 49,953.80 exactly. **Corrected during review:** that is weaker evidence than first claimed. Matching the HUD proves nothing — the HUD reads from this same fold, so it is circular. The broker-balance match corroborates only the *endpoint*, not the day *delta*; the day's opening balance was never independently captured. Treat "only the COUNT was wrong" as an assumption still to be tested, not an established fact. What is certain is that the count was wrong, and that count feeds `tradesPerDay`, `trade-confirm-rules.js` and `size-freeze-guard.js`, so it ends real sessions early.

**Bug 2 — the reconciliation banner compared incompatible units.** It matched `filled.length` (ORDER ROWS) against the fold's `tradeCount` (ROUND TRIPS), at zero tolerance. A round trip is at minimum two orders, and both scale-ins and split exits fan out across rows — this day has one round trip made of **seven** order rows. The banner therefore fired on every normal trading day. The pre-existing code comment acknowledged this as an "honest caveat" and shipped anyway.

**Gap 3 — opens were invisible, and everything was slow.** The only live trade signal was the 10s `pollTVBrokerAccount` cadence, and the fold only ever emits on a CLOSE. A position *opening* produced no event at all, so no rule could be checked and no coaching could land while the trade was still on.

## 2. What was built

**Fix 1 — round-trip evidence for the backstop.** `reconstructClosedTradesFromOrders` (already in the file, already tested) is a per-symbol signed-quantity net-position walk that emits only on a genuine return to flat — immune to scale-ins and split exits. It was wired to neither consumer. The backstop now requires that count to have *advanced* since the last trade scored (`closedRoundTripsScored` in state). Both scoring branches advance the baseline so neither can double-count one close. Degrades to the old `hasNewFill`-only behavior when the orders table is unreadable (`ordersTableSuspect`), which can over-count but never loses a real scalp.

**Fix 2 — like-for-like reconciliation.** Banner and HUD now compare round trips to round trips, derived two independent ways (order-history walk vs balance-delta fold). `brokerFilledCount` still broadcasts for diagnostics.

**Caught by the new tests, not live:** naively re-anchoring `balanceAtLastFlat` on the unscored entry-fill poll moves the baseline past the **entry commission**, dropping it from both the trade's `pnl` and `dayPnl` — trading a visibly-wrong count for a quietly understated P&L, the worse bug. The baseline is now deliberately held across an open position. Verified it reproduces the +$35.60 / +$67.00 the account actually recorded.

**Feature — the fast position watch.** New pure module `position-events.js` (`diffPositions`, `describeEvent`) plus a 5s `trading_get_positions` tick in `server.js`. Emits `opened` / `closed` / `scaled` / `flipped` per symbol. A null baseline emits nothing, so a mid-position restart is silent. On any change it broadcasts `position-event` immediately, then triggers a full `pollTVBrokerAccount()` in the same beat so the authoritative fold catches up. Deliberately computes no P&L and touches no trade count — the fold stays the single source of truth, because a second thing that also counts trades is exactly how Bug 1 happened, and this one runs twice as often.

**Workflow integration** (scope chosen by Anoop): HUD/guardrail update instantly; a closed trade auto-writes a row into today's session log via `sessionMgr.logTrade`; both open and close announce in chat so Jessi's context has them while the next decision is still live. Telegram deliberately **not** wired. Per `TRUST-PROTOCOL.md`, the auto-logged row fills only what is actually known — size (when observed) and realized P&L — and writes `?` for entry/stop/target rather than passing an average fill off as a planned entry. Direction comes from the watch's own `closed` event; the fold never records side.

**Tests:** 495/495 pass. 6 new fold tests including the exact live sequence, 12 new `position-events` tests.

## 3. Open questions this review should press on

1. **The 5s watch doubles CDP read load** against a single TradingView connection already shared by the chart monitors and `placeMarketOrder`'s multi-second click sequence. It uses the same `withBrokerLock`, but is lock contention now a real risk during order placement?
2. **Auto-writing to the session log is a data write on every close.** Is a phantom or duplicate row possible — restart, day rollover, backfill interaction? `logTrade` appends by regex into a markdown table.
3. **The degraded path can still over-count.** When `ordersTableSuspect` is true we fall back to `hasNewFill`-only. Is silently-permissive right here, or should it refuse to score?
4. **`tvLastClosedSide.__any`** is a single-instrument shortcut leaning on `rules.json`'s `oneInstrumentPerDay`. What breaks on an MNQ+MGC day?
5. **The corrupt `tradeCount: 9` is still on disk** and the server rewrites that file every poll, so the lockout persists until restart or IST rollover. Untouched deliberately while his session was live.
6. **None of this is live-verified.** The balance-delta fold itself has still never been checked against a real non-zero-P&L closed trade (long-standing item in `TODOS.md`). Everything here sits on top of that.

## 4. Explicitly not in scope

Telegram notifications (declined). Raising autonomy of the confirm/execute path. F2–F6 / M1–M6 mistake patterns (gated on F1 verifying live). Backfilling P&L for reconstructed round trips (no verified per-contract multiplier exists in this codebase; inventing one would replace a visible gap with an invisible wrong number).

---

## GSTACK REVIEW REPORT

Run: /autoplan, 2026-08-20, branch master, commit 173c804.
Voices: Claude subagent per phase. **Codex unavailable on this machine (binary not installed)** — every phase is `[subagent-only]`, not `[codex+subagent]`. DX phase skipped: this is a single-user personal tool, not a developer product; the module-contract concerns it would have raised were routed into the Eng phase instead.

### Consensus tables

Single-voice runs, so "consensus" is one independent reviewer against the primary analysis. Marked honestly rather than inflated to CONFIRMED.

| CEO dimension | Claude | Codex | Consensus |
|---|---|---|---|
| Premises valid? | NO — "dayPnl was correct" was circular | N/A | single-voice, corrected |
| Right problem? | PARTIAL — fixes arithmetic, not the authority model | N/A | single-voice |
| Scope calibration | NO — features shipped over an unverified fold | N/A | single-voice |
| Alternatives explored | NO — 4 unexamined | N/A | single-voice |
| 6-month trajectory | RISK — unverified P&L laundered into history | N/A | single-voice |

| Eng dimension | Claude | Codex | Consensus |
|---|---|---|---|
| Architecture sound? | PARTIAL — right split, fold fails closed | N/A | single-voice |
| Test coverage | NO — 7 named gaps | N/A | single-voice |
| Error paths | NO — 3 silent under-count paths | N/A | single-voice |
| Concurrency | NO — no in-flight guard | N/A | single-voice, FIXED |

### Fixed during this review

| # | Severity | Finding | Fix |
|---|---|---|---|
| C1 | CRITICAL | A **flip was never counted** — both scoring branches required `isFlat`, so long→short never scored and the eventual close folded two round trips into one | Round-trip evidence now scores regardless of flatness |
| C2 | CRITICAL | Backstop needed the fill **edge** and the round-trip **level** in the same poll; when they split, the re-anchor discarded the P&L *and* the count | When the walk is available it alone decides; `hasNewFill` is degraded-path only |
| C3 | CRITICAL | `pollTVBrokerAccount` had no in-flight guard and now has four callers — duplicate session-log rows reachable | Coalescing guard + one trailing re-run so the watch's hand-off is never dropped |
| F5 | HIGH | The corrupt `tradeCount: 9` survives the fix on disk and keeps enforcing until IST rollover | `STATE_SCHEMA_VERSION` bump; pre-fix state discarded on load |
| H4 | HIGH | `tvLastClosedSide[t.symbol]` was **dead code** (fold records carry no `symbol`) — every row took the global fallback, writing a confident wrong side on a two-symbol day | Falls back to `?` unless today was genuinely single-symbol |
| H7 | HIGH | Session log used a **UTC** day in an IST app — a 01:00 IST close appends to yesterday's file | IST-based `todayStr()` |
| H8 | HIGH | `trades.slice(prevTradeCount)` used a count as an index while the backfill prepends | Slice by `trades.length` |
| F4 | HIGH | "dayPnl stayed correct" was circular (HUD reads the same fold) | Claim corrected in §1 to an assumption |

503/503 tests pass, including 4 new regression tests for C1/C2 and 4 for the schema bump.

### H5 and H6 — fixed in a follow-up pass (2026-08-20)

**H5 — the order walk now reports its own health.** `analyzeOrderWalk()` replaces the bare `reconstructClosedTradesFromOrders` (kept as a wrapper for the backfill) and returns `{closed, netBySymbol, droppedRows}`. Two defects closed:

- A row that passes `isFilledOrderRow` but fails to parse (unreadable fill price or timestamp) is now **counted** as `droppedRows` rather than silently discarded. Previously the running sum never returned to zero afterwards, so every later round trip in that symbol was invisible — and because the fold now gates on this count, that froze the count and disabled the backstop for the rest of the day.
- The close test was `st.qty === 0` exactly, so a fill that **crossed** zero (sell 5 against a long 2) reversed the position without booking the close — the order-history twin of the fold flip bug. Crossing now books the close and opens the reversal as the next round trip's entry.

`isWalkDesynced(netBySymbol, positions)` cross-checks the walk against the broker's own positions panel. On disagreement — or on any dropped row — `server.js` passes `closedRoundTrips: null`, so the fold takes the documented degraded path instead of gating on a number known to be wrong. Logged once per state transition, naming the specific remedy.

**H6 — `logTrade` no longer writes backwards or lies about success.** The insert logic is extracted as the pure, exported `insertTradeRow(content, row)` (same extract-the-decision pattern as `checklist-logic.js`), and:

- Rows now **append after existing rows** instead of directly under the header, so ascending numbering matches reading order. The old behaviour put the newest trade at the top carrying the highest number.
- A header it cannot locate returns `null`, so `logTrade` returns `{ok:false, reason}` instead of rewriting the file unchanged and reporting `{num, path}` as success. The auto-log caller checks this and broadcasts `session-log-failed` — a dropped trade is now visible rather than vanishing.

**Caught by the new tests, not live:** the first header regex used `[-s|:]+`, and `s` matches newlines — so the match swallowed the blank line after the separator and the row landed *outside* the table, breaking it as markdown. Narrowed to `[-|: 	]+`.

519/519 tests pass (16 new: 9 for the walk, 7 for the session log — that file had no test coverage at all before this).

### Open — carried to the approval gate, still NOT fixed

- **M11/M12/M14, CEO F2/F11, Design F1/F4** — see the gate.
