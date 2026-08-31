# TradingView MCP — full tool audit, and what each autonomy mode can actually do

**Written 2026-08-29** at Anoop's request: *"do a complete research on tools
tradingview MCP has and all the access you can have by auditing each tool in
detail and how can we use them in each mode. if need gather more tools that can
help us going further."*

Method: read `tradingview-mcp/src/tools/*.js` (the registry) and
`src/core/*.js` (the implementations) directly, plus every `callTool(...)` site
in `app/`. Claims about reliability come from the code's own verification
comments, which in this repo carry the live-test trail.

---

## 0. The headline

**78 tools exist. The app uses 20. And the six that matter most for autonomy
are missing entirely.**

> **You can OPEN a position. You cannot MODIFY or CANCEL one.**
>
> `trading_place_market_order` is the only write tool in the entire MCP surface.
> There is no `cancel_order`, no `modify_order`, no `close_position`, no
> `flatten`, and no limit/stop order entry. Verified by grep across
> `src/tools/` and `src/core/` — the matches are zero.

This single fact reshapes the mode plan:

- **SHADOW** — unaffected. It never places anything.
- **ASSIST** — workable *today*. One click, one market order, bracket attached
  at entry. If the bracket is wrong you fix it by hand, and you are sitting there.
- **CONTROL** — **not buildable on the current toolset.** An unattended system
  that cannot move a stop, cannot cancel a resting order, and cannot flatten
  except by guessing an offsetting market order is not a trading system. It is
  a position-opener with no brakes.

Everything below is the detail behind that.

---

## 1. Every tool, by module

Legend — **Reliability** is what the code's own verification trail supports:
**✅ live-verified** (a comment records a real successful live test) ·
**⚠ partial** (verified in one direction / one state only) ·
**❓ unverified** (built, never exercised live) · **❌ broken**.

### 1.1 `trading/` — the broker account (6 tools) — **the autonomy-critical set**

| Tool | What it does | Reliability | Notes |
|---|---|---|---|
| `trading_get_account` | Summary + positions + orders in one call | ✅ used constantly by the app | The workhorse; `pollTVBrokerAccount()` reads this |
| `trading_get_positions` | Open positions table | ⚠ | Reads a DOM `<table>`. **Position size is the least reliable field in the system** — `oversize-guard.js` records it logging `size:0` four times on 2026-08-28 while real 1/2/3/5-lot positions were open |
| `trading_get_orders` | Orders table, optional status filter | ⚠ headers only | **UNUSED by the app.** Filters client-side so it never disturbs the screen. This is the tool CONTROL's reconciliation needs |
| `trading_get_account_summary` | Total P/L, Open P/L, Net Liq, margins | ✅ | |
| `trading_ensure_panel_ready` | Detects + repairs a collapsed bottom panel | ✅ live-verified | Load-bearing: collapsing the panel unmounts **all four tables at once**, which is what left the live feed dark for a full session on 2026-08-23 |
| `trading_place_market_order` | **Places a real market order** | ⚠ see below | Gated behind `TV_ALLOW_LIVE_ORDERS=1` |

**`trading_place_market_order` in detail** — the only tool that moves money:

- **Market only.** No limit, no stop-entry. Playbook B's plan is *a limit back
  into the FVG* (`planEntry` sets `requiresFill: true`), so **the MCP cannot
  place the entry Playbook B actually specifies.** Shadow simulates a limit
  fill; a live order would be a market fill at a different price. That is a
  silent mismatch between the track record and the system it would promote.
- **Optional `stopPrice` / `targetPrice`** set TradingView's "Exits" bracket at
  entry. The DOM path was live-verified on a *draft ticket* (2026-08-17) — the
  checkbox toggles, the price sets, it reads back correct — but **never through
  a real submitted order.**
- **Fails closed**, correctly: if a bracket field can't be found with
  confidence, the *entire* order is refused rather than placing a naked position.
- **Verifies before submitting** by reading the submit button's own label
  ("Buy 1 MNQU6 MARKET"), which mirrors side, qty and symbol at once. Worth
  knowing: that check contained a regex bug making the quantity assertion
  permanently unmatchable, found by review, never by testing — the two prior
  "verified live" trades failed earlier in the sequence and never reached it.

### 1.2 `data/` — reading the market (12 tools)

| Tool | Use | Reliability |
|---|---|---|
| `data_get_ohlcv` | Price bars. **Always `summary:true`** unless you need bars. Capped 500 | ✅ (app's `getFullBars`) |
| `quote_get` | Real-time price snapshot, ~200 bytes | ✅ |
| `data_get_study_values` | Current numeric values from every visible indicator | ✅ |
| `data_get_pine_lines` | Horizontal levels drawn by custom Pine (deduped, sorted) | ✅ |
| `data_get_pine_labels` | Text annotations with prices ("PDH 24550") | ✅ |
| `data_get_pine_boxes` | Price zones as {high, low} | ✅ |
| `data_get_pine_tables` | Table data as rows | ❓ unused by the app |
| `data_get_indicator` | Indicator config/inputs | ⚠ returns encoded blobs on protected scripts — the MCP's own docs say use `data_get_study_values` instead |
| `data_get_strategy_results` | Strategy Tester performance metrics | ❓ **unused — see §4.2** |
| `data_get_trades` | Strategy Tester trade list (cap 20/req) | ❓ **unused — see §4.2** |
| `data_get_equity` | Strategy Tester equity curve | ❓ **unused — see §4.2** |
| `depth_get` | Order book / DOM | ❓ unused; requires the DOM panel open |

All Pine graphics tools require the indicator to be **visible** on the chart.

### 1.3 `chart/` — reading and changing the chart (10 tools)

`chart_get_state` (call once, reuse entity IDs) · `chart_set_symbol` ·
`chart_set_timeframe` · `chart_set_type` · `chart_manage_indicator` (needs
**full** names — "Relative Strength Index", not "RSI") · `chart_scroll_to_date` ·
`chart_get_visible_range` · `chart_set_visible_range` · `symbol_info` ·
`symbol_search`.

⚠ **Every symbol/timeframe change moves Anoop's live chart.** The app wraps
these in `withChartLock` + a `finally` restore (`getFullBars`,
`checkPo3SecondarySymbol`). Any new automation must do the same.

### 1.4 `alerts/` — (3 tools) — **the most underused capability here**

| Tool | Reliability |
|---|---|
| `alert_create` | ✅ **live-verified via TradingView's `pricealerts` REST API** |
| `alert_list` | ✅ REST, not DOM |
| `alert_delete` | ✅ by id or all |

This matters more than it looks. The REST path was adopted *because* DOM
automation of the alert dialog proved impossible on this build — React ignores
synthetic events, `Input.insertText` **and** per-keystroke `dispatchKeyEvent`,
all verified live; the committed alert always landed at market price. The REST
endpoint commits the requested price **exactly** (`actual_price === requested_price`,
verified), and `alert_create` re-reads `alert_list` to return `price_verified`.

**So: alerts are the one write path in this MCP that is both live-verified and
not DOM-fragile.** See §4.1.

### 1.5 `replay/` — (6 tools)

`replay_start` (at a date) · `replay_step` · `replay_autoplay` (speed in ms) ·
`replay_trade` (buy/sell/close) · `replay_status` (position, P&L, date) ·
`replay_stop`.

❓ Unused by the app. **A paper-trading harness driven by TradingView's own bar
replay, with no money at risk** — relevant to SHADOW (§4.3).

### 1.6 `pine/` — (13 tools)

`pine_new` · `pine_open` · `pine_set_source` · `pine_smart_compile` ·
`pine_compile` · `pine_check` · `pine_get_errors` · `pine_get_console` ·
`pine_get_source` (⚠ can return 200KB+) · `pine_save` · `pine_list_scripts` ·
`pine_analyze` · `internal_api`.

❓ Unused by the app. Relevant because a playbook expressed as a Pine **strategy**
gets scored by TradingView's own backtester — an independent check on
`backtest.js` (§4.2).

### 1.7 `ui/`, `pane/`, `tab/`, `watchlist/`, `capture/`, `health/`, `drawing/`, `indicators/`, `batch/`

| Module | Tools | Verdict for autonomy |
|---|---|---|
| `health` | `tv_launch`, `tv_health_check`, `tv_discover`, `tv_ui_state` | ✅ Used. `tv_health_check` is CONTROL's liveness gate |
| `capture` | `capture_screenshot` (regions: full/chart/strategy_tester) | ✅ Used once. Returns a path, ~300 bytes — cheap audit evidence |
| `drawing` | `draw_shape`, `draw_list`, `draw_remove_one`, `draw_clear`, `draw_get_properties` | ✅ Used for news marks. Useful for *showing* a mode's intent on the chart |
| `ui` | 12 tools incl. `ui_evaluate` (arbitrary JS in the TV page) | ⚠ Powerful, unstructured. `ui_evaluate` is the escape hatch every missing tool below can be built on |
| `indicators` | `indicator_set_inputs`, `indicator_toggle_visibility` | ❓ Unused |
| `pane`/`tab`/`watchlist` | 10 tools | Low value for autonomy |
| `batch` | `batch_run` | ❌ **BROKEN — never restores chart state.** Do not wire into anything automated |

---

## 2. What each mode needs, and whether it exists

| Capability | MYSELF | SHADOW | ASSIST | CONTROL | Exists? |
|---|---|---|---|---|---|
| Read bars / quote / indicators | ✅ | ✅ | ✅ | ✅ | **Yes** |
| Read custom Pine levels | ✅ | ✅ | ✅ | ✅ | **Yes** |
| Read account, positions, P&L | ✅ | ✅ | ✅ | ✅ | **Yes** (size field unreliable) |
| Detect TV disconnect | ✅ | ✅ | ✅ | ✅ | **Yes** — `tv_health_check` + bridge heartbeat |
| Repair a collapsed panel | ✅ | ✅ | ✅ | ✅ | **Yes** — `trading_ensure_panel_ready` |
| Screenshot for the record | – | ✅ | ✅ | ✅ | **Yes** |
| Place a market order | – | – | ✅ | ✅ | **Yes**, gated |
| Attach stop + target at entry | – | – | ✅ | ✅ | ⚠ Verified on a draft only |
| **Place a LIMIT order** | – | – | ⚠ | ✅ | ❌ **NO** — and Playbook B's entry *is* a limit |
| **Read back open orders to reconcile** | – | – | ⚠ | ✅ | ⚠ Tool exists (`trading_get_orders`), **unused** |
| **Move / modify a stop** | – | – | – | ✅ | ❌ **NO** |
| **Cancel a resting order** | – | – | – | ✅ | ❌ **NO** |
| **Flatten a position** | – | – | – | ✅ | ❌ **NO** (only an offsetting market order, guessed from an unreliable size field) |
| **Partial exit / scale out** | – | – | – | ✅ | ❌ **NO** |
| Server-side price trigger | – | – | – | ✅ | ⚠ **`alert_create` could serve this** — see §4.1 |

**Read: complete. Write: one tool.**

---

## 3. The six missing tools, in priority order

Every one is buildable on `ui_evaluate` + CDP against the same Trading Panel
DOM `trading.js` already parses. Priority is by what unblocks which mode.

| # | Tool | Why it blocks | Blocks |
|---|---|---|---|
| 1 | **`trading_cancel_order(orderId)`** | Without it, a resting bracket cannot be withdrawn. A stale stop from a closed position can re-enter the market | CONTROL |
| 2 | **`trading_modify_order(orderId, {stopPrice, limitPrice, qty})`** | The whole of `exit-policy.js` — break-even moves, trailing, tightening — is unimplementable without it | CONTROL, Phase 1 |
| 3 | **`trading_close_position(symbol, qty?)`** | Today "flatten" means computing an offsetting market order from `positions.Qty` — **the field that logged `size:0` against real open positions.** A flatten built on that can double a position instead of closing it | CONTROL, oversize-guard |
| 4 | **`trading_place_limit_order(...)`** | Playbook B's specified entry. Without it, live execution differs from what SHADOW scored | ASSIST, CONTROL |
| 5 | **`trading_get_fills(since)`** | Reconciliation and per-trade realized P&L. Today P&L is inferred by balance-delta-at-flat, **still unverified against a real non-zero-P&L trade** | All executing modes |
| 6 | **`trading_flatten_all()`** | The panic button. Must be reachable from Telegram | CONTROL |

**Build order:** 3 and 1 first (they are the brakes), then 2 (enables Phase 1's
exit policy), then 5, then 4, then 6.

⚠ **Every one of these is DOM automation against a React UI**, the same class of
work that produced the alert-dialog dead end and the qty-selector bug. Each
needs the treatment `placeMarketOrder` got: verify intent against the UI's own
label before committing, fail closed, and live-verify on a draft ticket before
a real one.

---

## 4. Three capabilities already present that we are not using

### 4.1 Alerts as a broker-independent safety net — **highest value, lowest effort**

`alert_create` is the only **live-verified, non-DOM-fragile write path** in this
MCP. It commits an exact price server-side, and it fires **whether or not the
app, the bridge, or TradingView Desktop is still running.**

Every existing guardrail depends on the app being alive. The one failure that
has actually happened — the server dying unnoticed for 15+ hours, the feed dark
for a full session — takes every guardrail with it. An alert does not care.

Concretely: whenever CONTROL or ASSIST opens a position, also create a price
alert at the stop level. It costs one REST call, and it converts "the app will
warn you" into "TradingView will warn you even if the app is gone."

### 4.2 The Strategy Tester as an independent check on `backtest.js`

`data_get_strategy_results` / `data_get_trades` / `data_get_equity` read
TradingView's own backtester. Express a playbook as a Pine **strategy** (the
13-tool `pine/` module can inject and compile it) and you get a second,
independent scoring of the same rules.

Right now `backtest.js` is scored only by `backtest.js`. Every number the
promotion ladder rests on comes from one implementation with no external check.
Two implementations disagreeing is a finding; one implementation agreeing with
itself is not evidence.

### 4.3 Bar replay as a zero-risk execution rehearsal

`replay_start` → `replay_trade` → `replay_status` is a paper-trading harness
inside TradingView, on historical bars, with no money at risk.

SHADOW proves the *idea* works. It cannot prove the *execution* works, because
it never submits anything. Replay sits between them: it exercises an actual
order-submission sequence against a real UI, repeatedly, without a broker. It is
the cheapest possible way to rehearse the exit policy and the reconciliation
loop before either meets a live account.

---

## 5. What this changes about the plan

1. **ASSIST is reachable now.** Market order + bracket-at-entry + a human
   watching is enough. Phase 2 stands.
2. **CONTROL is gated on tools, not just evidence.** The 8-week evidence clock
   and the missing-tools work are independent and can run in parallel — but
   CONTROL cannot ship when the evidence arrives if the brakes still do not
   exist. **Start the tool work now.**
3. **Phase 1's `exit-policy.js` needs tool #2 to be more than a simulation.**
   The pure module is still worth building first (backtest and shadow can use it
   immediately), but it cannot drive a live position until `trading_modify_order`
   exists.
4. **Playbook B's limit entry is an unresolved mismatch.** SHADOW scores a limit
   fill; live can only place a market order. Either build tool #4, or record
   Playbook B in shadow as a market entry so the record describes what could
   actually be executed. **This should be decided before shadow accumulates 40
   trades**, not after — the whole sample is affected.
5. **Add the alert safety net to ASSIST from day one** (§4.1). One REST call per
   position, and it survives the app dying.

---

## 6. Correction made during this audit

`app/server.js`'s `gatherPO3Context()` header claimed it used `market_multi_tf`,
"which switches timeframes and AUTO-RESTORES the original." **That tool has
never existed** in tradingview-mcp — confirmed against the full registry and git
history. The code was fixed on 2026-08-06; only the comment was left behind,
still naming a non-existent tool as the safety mechanism that stops the live
chart being left on the wrong timeframe. Corrected — it goes through
`getFullBars()`, which does its own switch-read-restore under `withChartLock`.

No live call sites remain; every other `market_multi_tf` mention in the file is
a historical fix note.
