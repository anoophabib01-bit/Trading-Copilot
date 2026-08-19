# Phase 2 — Semi-Autonomous Trade Confirm/Execute Flow

Spec, not code. Locked with Anoop 2026-08-17 via `/spec`-style interrogation, then reviewed via two independent adversarial voices (CEO-strategy + Eng-architecture, run against this doc 2026-08-17).

## REVISED SCOPE (2026-08-17, post-review) — 3-phase split

Both review voices independently converged on the same conclusion from different angles: this spec as originally written bundles safety-critical enforcement with an entirely unverified new capability (TP/SL DOM automation), and the execution path itself has two unaddressed critical bugs. Anoop chose the 3-phase split:

- **Phase 2a — DONE 2026-08-17:** `app/trade-confirm-rules.js`, shadow mode only, wired into `pollTVBrokerAccount()`. See TODOS.md for detail.
- **Phase 2b — DONE 2026-08-17 (built ahead of the "wait for shadow signal" recommendation, at Anoop's explicit request — see below):** full confirm/execute flow, wired end to end.
- **Phase 2c — DONE and LIVE-VERIFIED 2026-08-17:** TP/SL DOM automation, live-inspected and rewritten against the real TradingView order ticket once it became reachable this session (via `tv ui eval`). Checkbox-toggle + price-set + read-back confirmed working for both stop-loss and take-profit, draft-ticket-only, nothing submitted. Same pass also found and fixed a real bug in the previously-"verified" qty-setting code (`input[type="text"]` matches nothing on the current TradingView build — needed `.type === 'text'` instead). See `TODOS.md` for the full trail.

**2026-08-17 addendum:** Anoop asked for 2b and 2c to be built immediately, ahead of the shadow-mode validation period the CEO review recommended, specifically so he could run the full flow and check for bugs himself. Built with the two Eng-review critical fixes (concurrency lock, double-submit/idempotency guard) included from the start, plus a self bug-audit pass afterward (found and fixed 2 real issues: a lock-scope gap between symbol-resolution and order-placement, and an Object.assign key-override ordering issue in ws-client.js). Full build detail, what's verified vs. not, and exactly what to test first: see `TODOS.md`'s Phase 2 entry.

The rest of this document is the ORIGINAL full-scope spec draft, kept for reference — the actual implementation deviates from it where the CEO/Eng reviews or this addendum required (see TODOS.md for the authoritative current state).

## Context

The Debate feature (`handleDebateChat`, `server.js`) already runs three agents — Jessi (discipline), Technical Analysis, ICT Power of 3 — and a Judge (`JUDGE_PERSONA`) synthesizes them into a single GO/NO-GO verdict, badged in the chat via `go-verdict-detect.js`. That verdict is currently **dead-ended as chat text** — nothing surfaces it as an actionable trade, and nothing connects it to order execution.

`tradingview-mcp`'s `placeMarketOrder()` (confirmed live 2026-08-17: 1-lot buy, offsetting sell) can place a real market order, but only via CLI or the MCP tool (gated behind `TV_ALLOW_LIVE_ORDERS=1`), with **zero size/day-stop/guardrail check** — it takes a raw `qty` and submits. Its own registration comment in `tradingview-mcp/src/tools/trading.js:45-46` states plainly: *"The semi-autonomous confirm-per-trade flow this tool is meant to serve does not exist yet."*

This spec closes that gap: when the Judge says GO, a trade ticket surfaces for Anoop to review, edit size/stop/target, and confirm — and that confirm is enforced server-side against the same rules already protecting manual and live-feed trades (`rules.json`, `size-freeze-guard.js`, `tv-broker-feed.js`/`grIngestLive`), not duplicated or bypassed.

**Why now:** Anoop explicitly paused this line of work on 2026-08-17 (`TODOS.md`'s P1 entry) until the live-feed size-freeze-guard wiring was built — that's now done. This is the next piece, and given it's the piece that actually places real orders, it gets the same scrutiny (autoplan review) before code.

## Current State (verified 2026-08-17)

| Component | Exists? | Where |
|---|---|---|
| GO/NO-GO verdict synthesis | ✅ | `server.js` `JUDGE_PERSONA`, `handleDebateChat` (~line 2085) |
| Verdict badging in chat | ✅ | `go-verdict-detect.js`, tested |
| Trade-ticket UI / "surfaced trade" | ❌ | Does not exist anywhere in `app.js`/`index.html` |
| Confirm button wired to execution | ❌ | Does not exist |
| `placeMarketOrder()` (market entry, verified live) | ✅ | `tradingview-mcp/src/core/trading.js:225` |
| TP/SL attachment on order placement | ❌ | Not implemented — order-ticket TP/SL DOM fields noted (`trading.js:257` comment) but never driven |
| Size/day-stop check before order submission | ❌ | None — `placeMarketOrder`/the MCP tool take `qty` with no `rules.json` lookup |
| `TV_ALLOW_LIVE_ORDERS=1` env gate | ✅ | `tradingview-mcp/src/tools/trading.js:50` — off by default |
| Size-freeze-guard (manual + live) | ✅ | `size-freeze-guard.js`, wired into `grLog()` and `grIngestLive()` (2026-08-17 build) |

## Proposed Change

### Flow

1. Debate completes, Judge returns GO with side/entry/rationale (existing behavior, unchanged).
2. **New:** a trade-ticket card renders in the Debate panel (not a new UI surface) showing: side, symbol, suggested size (Judge-computed, editable), stop-loss $ price (optional, editable, small ticks/points shown alongside), take-profit $ price (optional, editable, small ticks/points shown alongside).
3. Anoop edits fields as needed, clicks **Confirm**.
4. Client sends a WS message (`trade-confirm-request`) with the ticket's current values — this is a *request*, not an execution.
5. **Server-side** (`server.js`), before calling anything: re-derives current guardrail state (`getActiveRules()`, today's live/manual trade history, `dayStop()`/loss-ratchet equivalent, `size-freeze-guard`'s `sizeUpAfterLossViolation` logic reused server-side) and validates the requested size against it.
   - Any violation → reject, send `trade-confirm-rejected` with the specific rule that blocked it. **No override path** (per Anoop's decision — matches size-freeze-guard's existing no-override hard stop).
   - Pass → call `trading_place_market_order` via `mcpBridge` (still requires `TV_ALLOW_LIVE_ORDERS=1` to be set — this is a second, independent gate, not replaced by the confirm click).
6. Result (fill confirmation or error) sent back to the client, rendered on the ticket card.

### Why server-side enforcement, not client-side

A disabled button in `app.js` is a UI courtesy, not a guarantee — any DevTools edit, stale cached JS, or future bug in the client check could submit an order the UI meant to block. `server.js` is the only place already trusted as the enforcement boundary (it's what actually calls `mcpBridge`), so the check has to live there to mean anything. The client-side check still runs too (fast feedback, greys out Confirm) but is advisory only — the server re-checks independently and is the only thing that can actually place the order.

## Implementation Details

### New WS message: `trade-confirm-request` (client → server)

```json
{
  "type": "trade-confirm-request",
  "side": "buy" | "sell",
  "symbol": "MNQU6",
  "qty": 2,
  "stopPrice": 24530.00,   // optional, absolute $ price
  "targetPrice": 24610.00, // optional, absolute $ price
  "sourceVerdictId": "..." // ties back to the Judge verdict that produced this ticket, for audit
}
```

### New server handler: `handleTradeConfirm(ws, msg)` in `server.js`

- Loads `getActiveRules()` (existing function — same `rules.json` sizeCap/dayStop/tradesPerDay/dailyLossTiers already used everywhere else).
- Loads today's combined trade history: manual (`s.trades`, sent up from client — needs client to include this in the request, OR server tracks its own mirror; **open question, see below**) + live (`tvBrokerFeedState`, already server-resident from the 2026-08-17 build).
- Runs the equivalent of `size-freeze-guard.js`'s `sizeUpAfterLossViolation()` server-side (port the pure function — it's already dependency-free, can `require()` it directly in `server.js` the same way `tv-broker-feed.js` is required).
- Checks `qty <= sizeCap`, `qty >= sizeFloor`, current-day cumulative P&L against `dayStop`, today's trade count against `tradesPerDay`.
- On pass: `mcpBridge.callTool('trading_place_market_order', { side, qty, symbol })`. TP/SL: **new capability needed in `placeMarketOrder()`** — not built yet, see Out of Scope note below on sequencing.
- Broadcasts result as `trade-confirm-result`.

### Open question (needs Anoop's answer before implementation, not blocking this spec doc)

Server needs "today's trades so far" to run the size-freeze check. The live feed (`tvBrokerFeedState`) already has this for live-detected trades. Manual `grLog()` trades live only in the browser's `localStorage` (`s.trades`), never sent to the server today. **Does the manual trade log need to become server-visible too (a new sync path), or is it acceptable that this check only sees live-feed-detected trades for its "was the last trade a loss" logic?** Recommend: only live-feed trades, since this flow only ever fires for live executions anyway — flag this explicitly rather than silently deciding it.

## Acceptance Criteria

1. A GO verdict from the Judge renders a trade-ticket card in the Debate panel with side/symbol/suggested-size/optional-stop/optional-target, all editable.
2. Clicking Confirm with a size exceeding `rules.json`'s `sizeCap` is rejected server-side with a specific message naming the limit — no order is placed (verify via `mcpBridge.callTool` call count in a test double).
3. Clicking Confirm when today's live-feed P&L is at/past `dayStop` is rejected server-side, same as #2.
4. Clicking Confirm immediately after a live-feed-detected loss, with a larger size than that loss's trade, is rejected server-side (reuses `sizeUpAfterLossViolation`).
5. Clicking Confirm with a valid size/state calls `trading_place_market_order` with exactly the side/qty/symbol shown on the ticket.
6. If `TV_ALLOW_LIVE_ORDERS` is not `1`, Confirm still fails (MCP tool isn't registered) — server returns a clear "live orders not enabled this session" message, not a silent no-op.
7. No client-side-only path can reach `trading_place_market_order` — grep-verifiable: the tool is only ever called from `handleTradeConfirm`, which always runs the rules check first.

## Testing Plan

| Layer | What | Count |
|---|---|---|
| Unit | Server-side rule-check function (pure, extracted like `tv-broker-feed.js`'s `fold`) — size cap, day-stop, size-freeze-after-loss, each pass/fail | +8 |
| Unit | `handleTradeConfirm` rejects on each violation type without calling `mcpBridge` | +4 |
| Integration | Full WS round-trip: `trade-confirm-request` → rejected/accepted → `trade-confirm-result`, against a fake `mcpBridge` | +3 |
| Manual (live, small size, supervised) | One real confirm-and-execute round-trip, same style as the existing verified buy/sell test | 1 |

## Rollback Plan

Entirely additive (new WS message type, new handler, new UI card) — nothing existing is modified except adding a `require()` for the extracted rule-check function. Revert = remove the new handler registration and the new UI card; `placeMarketOrder`/CLI/MCP-tool path keeps working exactly as it does today for manual/supervised use.

## Effort Estimate

- Server-side rule-check extraction + unit tests: ~1-2h (mirrors `tv-broker-feed.js` pattern already built)
- `handleTradeConfirm` handler + WS wiring: ~1h
- Client ticket-card UI in Debate panel: ~1.5-2h
- TP/SL support in `placeMarketOrder()` (new DOM automation, unverified territory): ~2-3h + live verification
- Integration test + one supervised live test: ~1h

## Files Reference

| File | Change |
|---|---|
| `app/server.js` | New `handleTradeConfirm`, new WS case, require the extracted rule-check module |
| `app/trade-confirm-rules.js` (new) | Pure, unit-tested: size cap / day-stop / size-freeze-after-loss check, given rules + today's trades |
| `app/test/trade-confirm-rules.test.js` (new) | Unit tests per Acceptance Criteria #2-4 |
| `app/renderer/app.js` | New trade-ticket card render/state in the Debate panel, `confirmTrade()` sending `trade-confirm-request` |
| `app/renderer/ws-client.js` | New `sendTradeConfirm`/`onTradeConfirmResult` |
| `tradingview-mcp/src/core/trading.js` | `placeMarketOrder()` extended to accept optional `stopPrice`/`targetPrice` and drive the ticket's TP/SL fields |

## Out of Scope

- Anything beyond market-entry orders with optional TP/SL (no limit orders, no scale-in/out, no position-flip logic).
- Closing/modifying an already-open position through this flow (entries only).
- Removing or loosening the `TV_ALLOW_LIVE_ORDERS=1` manual gate — stays required per Anoop's explicit decision.
- Full autonomy (auto-confirm without a human click) — out of scope entirely; this is confirm-per-trade, not autonomous.
- Resolving the "manual trades not server-visible" open question above with code — flagged for a decision, not solved in this pass.

## Related

- `TODOS.md` — "Finish size-freeze-guard's live-feed wiring" (P1, built 2026-08-17) — this spec is the next item in that same sequencing decision.
- `app/tv-broker-feed.js`, `app/renderer/size-freeze-guard.js` — reused, not duplicated, by this spec's server-side check.
