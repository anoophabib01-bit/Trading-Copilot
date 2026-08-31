# DSH Backtesting - Round 2 findings (60-day real-data backtest)

## What changed: solved the 60-day data problem (non-disturbing)
- The live TradingView chart moved to 15M (actively in use) - left untouched.
- Found that DSH get_history reaches MNQ=F (CME) intraday 1h + daily via Yahoo.
- Stitched 5 explicit windows -> 66 days of 1H (1037 bars, 2026-06-21 -> 08-26) and
  reconstructed 4H (289 bars) by 4-bar aggregation. Wrote DATA/bars/mnq_60.json + mnq_240.json.
- 30M data still only 8.5 days (get_history has no 30m interval; 30M needs the live chart).

## 60-day result (JS harness, exact live detectors, 1 contract, $0.95/side, 3AM flatten)

| Playbook | Data | Setups | Resolved | Win | Net | PF |
|---|---|---|---|---|---|---|
| A (4H + 1H engulf) | 66d | 80 cand. (79 gate-rej, 1 risk-blocked) | 0 | - | - | - |
| B (SFP+FVG) | 8.5d* | 17 | 4 | 50% | -$103.10 | 0.44 |
| LTF-ENGULF | 8.5d* | 1 | 1 | 0% | -$74.40 | 0 |

*30M-based playbooks still on the old 8.5-day 30M data (30M intraday not obtainable offline).

## THE HEADLINE FINDING (honest)
Playbook A produced ZERO resolved trades in 66 days: 80 engulf candidates detected, 79
rejected by the gates, 1 blocked by the risk rule, 0 tradeable. The 'quality over quantity'
gates - as the live detectors code them - are so strict they produce ~1 trade per 2+ months.
A strategy that fires ~0 times cannot clear a $3,000 eval, let alone in a week.

Two candidate root causes (both testable, both improvable):
1. OVER-STRICT GATES: requiring (simultaneously) full-range engulf + body >= 0.3x ATR +
   4H HH/HL structure + 'takes out BOTH extremes' + 'liquidity not already swept' filters
   out ~99% of engulf candles. The research scorecard (trade >=5/6 confirmations) is
   calibrated looser than this.
2. B DETECTOR MISFIRE (from round 1): 11/17 B setups blocked because raid+displacement are
   the SAME bar (risk-too-small) or stop too wide (risk-too-big). The detector fires on
   non-playbook patterns.

## Conclusion for the plan
- As coded, NONE of the playbooks edges out on real data. This is the evidence the
  harness exists to produce - it is the opposite of what a sell-side backtest would show.
- The path to 'profitable' is NOT 'keep the gates and hope' - it is a PARAMETER SWEEP:
  relax/retune the gates and the B detector, re-run, and find the strictness level that
  yields enough tradeable setups to clear the eval WITHOUT reverting to noise.
- The Pine v1 (strategy_v1.pine, compiles clean) has every gate as an INPUT - it is the
  right tool for that sweep. But it needs the live chart to run 60 days of 30M.

## Still blocked / next
- 30M intraday for 60 days: not obtainable offline (get_history=1h max; chart=live).
- Next round options: (a) run the Pine sweep on the live chart WITH full restore, or
  (b) rework the JS detectors (relax gates, fix B same-bar rule) and re-run on the
  66-day 1H data for A + 8.5-day 30M for B.
