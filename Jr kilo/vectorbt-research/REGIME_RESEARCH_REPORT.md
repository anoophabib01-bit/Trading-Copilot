# Regime-Adaptive Strategy Research Report

## Executive Summary

**My point of view: The edge is in the regime filter, not the entry rule.**

After running a fresh 54-combo sweep across breakout and pullback strategies, with ATR-based position sizing and regime filtering, the data conclusively shows:

1. **No robustly profitable mechanical system exists** in the current 1H bar dataset
2. **The regime filter IS the edge** — but it only activates 4.7% of the time
3. **Small-sample outliers dominate** — the "best" results are 1-2 trade anomalies

---

## Data Reality Check

### What we actually have
- **4,589 1H bars** from `DATA/bars/` (merged from 8 files)
- **Date range**: 2025-09-08 to 2026-08-26 (~11.5 months)
- **Gaps**: Files are separate snapshots, not a continuous tape
- **Instrument**: MNQ only

### Regime Distribution (from `regime_classifier.py`)
| Regime | Bars | % of Data |
|---|---|---|
| RANGE | 2,814 | 61.3% |
| TREND_DOWN | 1,344 | 29.3% |
| VOLATILE | 201 | 4.4% |
| TREND_UP | 217 | 4.7% |
| UNKNOWN | 13 | 0.3% |

**Key insight**: MNQ spends 61% of its time in RANGE and 29% in TREND_DOWN. A long-only breakout strategy only trades 4.7% of bars.

---

## What the Sweeps Found

### DSH V2 (fixed-stop, fixed-size) — 16 combos
**Result: 0/16 profitable**
- Best: ADX>=30, lookback=15 → 22 trades, -$42.55, PF 0.58
- Every combo had profit factor < 1.0
- Daily cap ($500 for 1 contract) and 03:00 IST flatten destroyed the edge

### Regime-Adaptive (ATR-stop, breakout) — 54 combos
**Result: 2/54 profitable, both 1-trade outliers**
- Best: ADX>=35, lookback=15 → 1 trade, +$10.10, PF inf
- Most combos: 0 trades in RANGE/VOLATILE regimes
- TREND_UP regime produced 13 trades max, net -$36 to +$367 depending on params
- With fixed PnL bug corrected, only statistical noise remains

### Node.js Backtest (regime-separated files)
**Result: +$3,777 aggregate, PF 1.45**
- BUT: runs on 5 separate regime files, not a unified dataset
- Sep-Nov uptrend: +$1,598 (47 trades)
- Nov-Jan flat: -$1,234 (23 trades) ← regime kill
- Apr-May uptrend: +$2,527 (42 trades)
- This is the "regime-dependent" signature: works in trends, dies in ranges

---

## Why No Strategy Is Profitable (My Analysis)

### 1. The data is too thin
- 4,589 1H bars = ~11.5 months of data
- Only 217 bars (4.7%) are TREND_UP
- A strategy that only trades TREND_UP has a sample size problem, not an edge

### 2. The 1H timeframe is the wrong resolution for MNQ
- MNQ is a high-liquidity futures contract with microstructure on 5-15min
- 1H bars smooth over too many intra-bar reversals
- The "breakout" signal fires on the CLOSE of a 1H bar, meaning we enter 1 hour late
- By entry, much of the move has already happened

### 3. Commission destroys small edges
- $0.95/side = $1.90 round trip per contract
- MNQ moves ~15-30 points per hour on average
- With a 3pt stop and 6pt target (2R), gross profit per win = ~$6
- After commission: $6 - $1.90 = $4.10 net
- One stop loss: -$3 - $1.90 = -$4.90
- You need ~55% win rate just to break even on 2R

### 4. The 03:00 IST flatten is a hidden cost
- MNQ trades 23.5 hours/day
- Hard flatten at 03:00 IST (21:30 UTC) closes positions before market close
- Many "winning" trades would have hit target if allowed to run overnight
- But overnight gap risk on a prop account is real

### 5. Regime classification is lagging
- ADX(14) on 1H = 14 hours of lag
- By the time ADX confirms a trend, the trend is often mature
- Late entry = smaller residual move = worse R:R

---

## What Would Actually Work (My Point of View)

### A. Better Data
- **30M bars** are the signal timeframe per STRATEGY_BRIEF.md
- We only have ~300 30M bars (8.5 days) — not enough
- Need 60+ days of 30M data minimum
- A credentialed feed (not TradingView's 500-bar cap) is essential

### B. Multi-Timeframe Confluence
- 4H trend direction (bias)
- 30M entry trigger (engulf/SFP/FVG)
- 1H position management (stop/target adjustment)
- The edge comes from alignment, not a single indicator

### C. Volatility-Targeted Position Sizing
- Fixed 1 contract is naive
- Size = (max daily risk) / (ATR * point_value)
- Example: $100 max risk, ATR=20pts, MNQ=$2/pt → size = 100/(20*2) = 2.5 contracts
- This keeps risk CONSTANT regardless of volatility

### D. Adaptive Exits
- Fixed 2R target is suboptimal
- In trends: trail stop at 1x ATR
- In ranges: take profit at key level (not a fixed R)
- The exit should match the regime, not fight it

### E. Accept That Simple Mechanical Systems Don't Edge MNQ 1H
- The FINAL_REPORT.md is correct: "no simple 1H rule is regime-independent"
- This is NOT a failure of the strategy — it's a feature of the market
- MNQ is too efficient, too liquid, too arbitraged for simple rules to work
- The edge, if it exists, is in:
  - Order flow / footprint data (not available)
  - Cross-instrument relative value (not tested)
  - Liquidity sweeps at microstructure level (needs 5-15min data)

---

## My Honest Verdict

**DSH V2 and the regime-adaptive variants are NOT profitable standalone strategies** on the current data.

The new research approach confirms what the 6 rounds of DSH backtesting already showed:
- The edge is regime-dependent
- The data is insufficient to verify it
- 1H bars are the wrong resolution for this instrument

**The path forward is NOT another parameter sweep.** It is:
1. Acquire real 30M history (60+ days minimum)
2. Build a 4H→30M→1H multi-TF framework
3. Accept that live trading this as a "set and forget" system is unlikely to work
4. Use the research to inform discretionary decisions, not automate them

The VectorBT pipeline is now operational and can test any new approach. But the data limitations are the constraint, not the code.
