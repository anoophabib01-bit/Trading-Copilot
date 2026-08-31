# Jr kilo — Trading Repositories Comparison & Enhancement Analysis

## 1. The 3 Modes (YOU / SHADOW / CONTROL)

### Current Status
All three modes exist in code but are **disabled** per Anoop's instruction (2026-08-26):
> "disable shadow mode and control mode until i start working on them and have a proper plan."

The hard kill switch is `rules.json` → `autonomyEnabled: false`. When false:
- CONTROL toggle is hidden in UI
- Autonomy WebSocket handlers refuse all requests
- Both shadow recorders and shadow resolver are inert
- `broadcastAutonomy()` returns `mode: 'off', effectiveMode: 'off'`

### Mode Definitions

| Mode | Badge | What Happens | Real Money? |
|------|-------|--------------|-------------|
| **YOU** | `YOU ARE TRADING` | App advises only. All 10 agents run, charts are watched, rules are enforced, but no orders are placed by the system. | No |
| **SHADOW** | `SHADOW — recording, not trading` | App records (a) every order it WOULD have sent with full market context, and (b) every human trade with behavioral context. Orders are resolved later against real price action using the same backtest engine. | No |
| **CONTROL** | `CLAUDE IS TRADING` | App may place real orders through `handleTradeConfirm`. Requires evidence gate to pass. | Yes |

### SHADOW Mode Deep Dive

SHADOW has TWO recording paths:

**Machine Shadow** (`shadowRecordMachineOrder` in server.js:6666):
- Triggered when detectors fire a signal
- Records exact order: playbook, direction, entry, stop, target, risk points, risk USD
- Records WHY the setup was confirmed (specific gates that passed with real values)
- Records market context at fire time (session tier, hour trend, ADX, news blackout)
- Blocked orders ARE recorded (with `blocked: 'risk-too-big'`) but excluded from evidence
- Multiple sizes recorded per signal (e.g., 4c and 6c from same setup)

**Human Shadow** (`shadowRecordHumanTrade` in server.js:6700):
- Triggered on every closed trade (winner or loser)
- Records: side, size, entry, exit, P&L, hold time, outcome (win/loss/breakeven)
- Behavioral context: trade number today, contracts so far, day P&L before, minutes since prev trade, prev trade outcome, fast re-entry after loss, size up after loss
- Market context: session tier, hour trend, 4H trend, ADX, news blackout, signal-backed, minutes from signal

**Shadow Resolver** (`resolveShadowOrders` in server.js:6768):
- Slow timer, only touches orders whose full horizon has elapsed
- Uses `backtest.simulateTrade` — the SAME function the 9-month backtest runs on
- One bar fetch per distinct timeframe (not per order)
- Anchors cutoff to the ENTRY bar's 03:00 IST flatten
- Writes outcomes to `shadow-outcomes.jsonl` (separate from proposals)

**Autonomy Store** (`autonomy-store.js`):
- All data in `DATA/autonomy/` folder
- `state.json` — toggle memory across restarts
- `shadow-orders.jsonl` — append-only proposals
- `shadow-outcomes.jsonl` — append-only resolutions
- `decisions.jsonl` — every request including refusals
- `daily/` — per-day rollups
- `evidence()` — cumulative numbers the gate reads (resolved trades, profit factor, max DD)

### CONTROL Mode Requirements (LIVE_REQUIREMENTS in autonomy-gate.js:52)

| Requirement | Value | Why |
|-------------|-------|-----|
| `minResolvedTrades` | 40 | Below this, win rate is noise |
| `minProfitFactor` | 1.3 | After commission and slippage |
| `minShadowDays` | 20 | Consecutive days in SHADOW with gate healthy |
| `maxDrawdownPctOfLimit` | 0.4 | Observed DD must stay under 40% of account limit |
| `requireHumanConfirm` | true | Anoop must flip it himself; no code may self-promote |

Only a **human armer** (allow-list: `['anoop']`) can arm LIVE. Scripted WebSocket messages were caught trying to bypass this on 2026-08-26.

---

## 2. DSH Backtesting Work (DSH backtesting/ folder)

### What Was Built
- 6 rounds of backtesting on ~7-9 months of real MNQ 1H data
- Pine strategies for TradingView Strategy Tester
- Custom JS backtest harness (test_*.js files)
- Regime analysis (trending vs range vs downtrend)
- Parameter robustness grids

### Key Findings (from FINAL_REPORT.md and STRATEGY_V2.md)

| Finding | Evidence |
|---------|----------|
| **Current playbooks A/B/C do NOT edge out** | Playbook A: 0 tradeable setups / 66 days; B: negative; C: gate only |
| **Shorting breakouts is broken** | Downtrend PF 0.26 even with ADX>=30 confirming |
| **Breakouts only work in strong trends** | ADX>=35 almost fully excludes choppy periods |
| **No simple rule is regime-independent** | Every positive result confined to one regime, flipped elsewhere |
| **"Short breakout" (PF 2.63) was regime artifact** | Lost $3,096 out-of-sample |

### DSH V2 Strategy (the most actionable output)

**Name:** ADX35 Breakout v3 (Long-only regime-switching)

**Rules:**
- Entry: LONG when close > 10-bar high AND close > open (Donchian breakout)
- Regime gate: ADX(14) >= 35 AND +DI > -DI (strong confirmed uptrend)
- Stop: 3 points below entry candle low
- Target: 2R from stop distance
- Daily cap: +$1,000 (enforces 40% rule)
- Hard flatten: 03:00 IST
- Size: 1-2 contracts

**Results (5 regimes, ~9 months real MNQ 1H data):**

| Regime | Trades | Win% | Net | PF | DD |
|--------|--------|------|-----|----|----|
| Sep-Nov (up) | 26 | 62% | +$1,090 | 2.49 | $372 |
| flat Nov-Jan | 3 | 0% | -$180 | 0 | $180 |
| downtrend Feb-Mar | 4 | 50% | +$108 | 1.90 | $120 |
| uptrend Apr-May | 23 | 57% | +$2,265 | 3.16 | $609 |
| in-sample Jun-Aug | 5 | 60% | +$1,043 | 4.63 | $181 |
| **AGGREGATE** | **61** | **~59%** | **+$4,326** | **2.83** | **$609** |

**Honest caveats:**
- IN-SAMPLE TUNED: ADX threshold, lookback, daily cap chosen by testing 4-5 values
- LOW FREQUENCY: 61 trades in ~9 months (~1.5/week) → ~$480/month gross
- SMALL SAMPLE: 61 trades total, per-regime cells 3-26 trades
- LONG-ONLY: dead money in bear market (but that's the point — stand aside)

### DSH's Honest Bottom Line
> "After 5 rounds and ~7 months of real MNQ 1H data across 3 market regimes, I could NOT find a robust, regime-independent intraday edge in any simple candle/breakout rule — including your existing playbooks A/B/C and the obvious replacements."

---

## 3. Comparison: 10 Open-Source Repos vs MNQ Co-Pilot

### Repo 1: Freqtrade
**What it is:** Python crypto bot with backtest, paper trade, live trade, web UI, Telegram controls.

**MNQ Co-Pilot has:**
- ✅ Backtest engine (backtest.js) that reuses EXACT live detectors
- ✅ Web UI (renderer/)
- ✅ Live order placement (handleTradeConfirm)
- ✅ Paper/simulated trading via SHADOW mode
- ✅ Telegram integration

**MNQ Co-Pilot lacks:**
- ❌ Crypto exchange connectors (CCXT integration) — but irrelevant, we trade futures via TradingView
- ❌ Strategy optimizer/ hyperopt — but our backtest is deliberately pessimistic and detector-exact

**Verdict:** Freqtrade's architecture is similar but less rigorous. Our backtest is better because it reuses live code. No enhancement needed.

### Repo 2: TradingAgents
**What it is:** Multi-agent AI framework where separate LLM agents handle news, sentiment, technicals, execution, then argue before trading.

**MNQ Co-Pilot has:**
- ✅ 10 distinct agents (Jessi, Jessi Livermore, Voice Jessi, Analysis, PO3, Discipline Jessi, Judge, Refuter, Post-Session Analyst, Scalper)
- ✅ Debate panel with parallel dispatch
- ✅ Judge synthesizes multiple arguments
- ✅ Fire-and-forget refuter for second opinions
- ✅ Multi-provider LLM fallback chain

**MNQ Co-Pilot lacks:**
- ❌ News/sentiment agents — but this is a futures co-pilot driven by chart structure, not news
- ❌ Execution agent — but we don't want an AI executing without evidence

**Verdict:** We already have a better multi-agent system for THIS use case. TradingAgents is generic; ours is purpose-built for prop trading discipline.

### Repo 3: Polymarket API
**What it is:** Python SDK for Polymarket prediction markets.

**MNQ Co-Pilot relevance:** Zero. We trade MNQ/MGC futures, not prediction markets.

**Verdict:** Not applicable.

### Repo 4: VectorBT
**What it is:** Vectorized backtesting on NumPy/Numba. Runs thousands of strategy variations in the time most tools take to run one.

**MNQ Co-Pilot has:**
- ✅ Event-driven backtest that reuses live detectors
- ✅ Pessimistic simulation (same-bar stop wins ties, limit entries must fill, etc.)
- ✅ Multi-timeframe alignment (no lookahead bias)

**MNQ Co-Pilot lacks:**
- ❌ Vectorized parameter sweeps — our backtest is bar-by-bar event-driven
- ❌ Fast batch testing of 1000+ parameter combinations

**Enhancement potential:** MEDIUM. DSH's robustness grid (16-cell parameter sweep) could benefit from VectorBT-style vectorization for faster regime analysis. But our event-driven approach is more accurate for complex multi-timeframe logic.

**Recommendation:** Consider VectorBT for pure parameter optimization (ADX thresholds, lookback periods) but keep the event-driven engine for final validation.

### Repo 5: Backtrader
**What it is:** Widely-used Python framework for backtesting trading strategies.

**MNQ Co-Pilot has:**
- ✅ Custom backtest engine that imports EXACT live detectors
- ✅ Commission and slippage modeling
- ✅ Multi-timeframe support
- ✅ Hard flatten rules
- ✅ Risk gates

**MNQ Co-Pilot lacks:**
- ❌ General-purpose framework — but we don't need one, we have a purpose-built engine

**Verdict:** Backtrader is a general framework. Our engine is better because it tests the actual code that runs live. No enhancement needed.

### Repo 6: Hummingbot
**What it is:** Open-source framework for market making and arbitrage.

**MNQ Co-Pilot relevance:** Low. We do directional trading (breakouts, FVGs, engulfing), not market making.

**Verdict:** Not applicable to current strategy families.

### Repo 7: CCXT
**What it is:** Unified API for 100+ crypto exchanges.

**MNQ Co-Pilot relevance:** Zero. We trade via TradingView/Tradovate, not crypto exchanges.

**Verdict:** Not applicable.

### Repo 8: FinRL-X
**What it is:** Next-gen RL trading framework with weight-centric architecture, live/paper trading via Alpaca.

**MNQ Co-Pilot has:**
- ✅ Live and paper trading paths
- ✅ Multi-source data
- ✅ Backtesting engine

**MNQ Co-Pilot lacks:**
- ❌ Reinforcement learning — but RL for intraday MNQ is unproven and likely overfit
- ❌ Alpaca integration — irrelevant for futures

**Enhancement potential:** LOW. RL is interesting for research but not suitable for a prop account with 6 blow-ups. The discipline-first approach is correct.

### Repo 9: NautilusTrader
**What it is:** High-performance, event-driven trading engine. 1M+ events/sec. 50+ exchanges, 10+ asset classes.

**MNQ Co-Pilot has:**
- ✅ Event-driven architecture
- ✅ WebSocket messaging
- ✅ Order management

**MNQ Co-Pilot lacks:**
- ❌ Institutional-grade throughput — we process one instrument, one connection
- ❌ Multi-exchange support — irrelevant
- ❌ Rust/C++ performance layer — Node.js is sufficient for our load

**Verdict:** Massive overkill. NautilusTrader solves problems we don't have (millions of events per second, 50 exchanges).

### Repo 10: Lumibot
**What it is:** Write strategy once, backtest/paper/live without rewriting.

**MNQ Co-Pilot has:**
- ✅ Same code runs in backtest and live (backtest.js imports detectors.js and playbook-c.js — the EXACT same functions)
- ✅ Paper trading via SHADOW mode
- ✅ Live trading via CONTROL mode
- ✅ Consistent logic across all paths

**MNQ Co-Pilot lacks:**
- ❌ Broker abstraction layer — but we go through TradingView, not direct broker APIs

**Verdict:** Lumibot's "write once, run everywhere" is exactly what our backtest engine achieves by importing live detectors. We already have this.

---

## 4. What CAN Enhance This Project

### High Value: DSH V2 Regime-Switching Strategy

The DSH V2 strategy is the most actionable finding:

| Feature | Current State | Enhancement |
|---------|--------------|-------------|
| Regime filter | ADX>=25 (loose) | ADX>=35 (strong trend only) |
| Direction | Long/short (both playbooks) | Long-only (stand aside in downtrends) |
| Entry | Playbook-specific (engulf/SFP/FVG) | Donchian breakout (close > 10-bar high) |
| Consistency | Unknown (playbooks untested) | PF 2.83, 59% WR on 61 trades |

**How to integrate:**
1. Add as **Playbook D** in `app/playbook-spec.js`
2. Add detector in `app/detectors.js` (ADX + Donchian breakout)
3. Wire into backtest engine (already supports new playbooks)
4. Wire into shadow recorder (already supports new playbooks)
5. Add to autonomy gate evidence tracking

**Caveat:** DSH's results are in-sample tuned. Must forward-test before any live consideration.

### Medium Value: VectorBT for Parameter Optimization

**Use case:** Fast regime analysis and ADX threshold optimization across 100+ parameter combinations.

**Implementation:** Use VectorBT to scan ADX 25-40, lookback 5-20, daily caps $500-$1500. Use our event-driven backtest for final validation of winners.

### Medium Value: Shadow Analysis (`app/scripts/shadow-analysis.js`)

**What it does:** Compares machine shadow vs human shadow to answer: "Does Anoop's discretion add value or subtract it?"

**Current state:** File exists but needs completion.

**Enhancement:** Complete the discriminator analysis (already built in `shadow-recorder.js:discriminate`). Compare win rates, R-multiples, and behavioral patterns between machine and human on the same signals.

### Low Value: Agent Architecture Improvements

TradingAgents' debate structure is already implemented and superior for this use case. No changes needed.

### Not Applicable
- Freqtrade, Hummingbot, CCXT, Polymarket, FinRL-X, NautilusTrader — all solve different problems or are overkill

---

## 5. Recommendations (Priority Order)

### Priority 1: Complete the SHADOW/CONTROL Infrastructure
**Why:** This is already 80% built. Completing it gives you a data-driven path to CONTROL without risking blown accounts #7-10.

**What's missing:**
- Front-end UI for shadow mode toggle (partially exists, hidden by kill switch)
- Shadow analysis dashboard (machine vs human comparison)
- Evidence threshold tracking (40 trades, PF 1.3, 20 days)

### Priority 2: Add DSH V2 as Playbook D
**Why:** The current playbooks A/B/C have NEGATIVE expectancy on real data. Adding a regime-switching long-only strategy gives the autonomy gate something that might actually earn LIVE status.

**What's needed:**
- New playbook spec in `app/playbook-spec.js`
- Detector in `app/detectors.js`
- Backtest validation on fresh data
- Shadow integration

**Risk:** DSH's results are in-sample. Forward test before any live consideration.

### Priority 3: Parameter Robustness Grid
**Why:** DSH tested 4-5 values of ADX threshold. A full grid (ADX 25-40, lookback 5-20, daily cap $500-$2000) would confirm whether the edge is stable.

**How:** Use existing backtest runner with parameterized configs.

### Priority 4: VectorBT for Speed (Optional)
**Why:** If parameter grids get large (>100 combinations), vectorized backtest would be faster.

**How:** Export bar data, run VectorBT sweep, import winners for event-driven validation.

---

## 6. What NOT To Do

| Repo | Why Not |
|------|---------|
| Freqtrade | Already have better backtest; crypto-only |
| TradingAgents | Already have better multi-agent system for this use case |
| Polymarket | Wrong asset class entirely |
| Backtrader | General framework; our detector-exact engine is superior |
| Hummingbot | Market making, not directional |
| CCXT | Crypto exchanges, not futures |
| FinRL-X | RL is unproven for intraday; discipline-first approach is correct |
| NautilusTrader | Overkill for single-instrument prop trading |
| Lumibot | Already have "write once, run everywhere" via detector imports |

---

## 7. Bottom Line

**The MNQ Co-Pilot project already has the most important pieces:**
- A backtest engine that tests the EXACT code that runs live (not a reimplementation)
- A shadow recorder that captures both machine and human behavior
- An autonomy gate that requires evidence before LIVE
- 10 purpose-built agents for prop trading discipline

**The most valuable external input is DSH's research:**
- Current playbooks A/B/C are broken mechanically
- A regime-switching long-only strategy (ADX>=35, Donchian breakout) showed promise in DSH's testing
- This could become Playbook D and give the autonomy gate a viable candidate

**The 10 open-source repos mostly solve problems we don't have** (crypto trading, market making, institutional throughput, generic frameworks). VectorBT is the only one that could tangibly help (parameter optimization speed), and even that is optional.
