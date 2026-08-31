# DSH Backtesting - FINAL REPORT (5 rounds, ~7 months of real MNQ data)

Prepared for Anoop. Goal: find a quality-focused MNQ intraday strategy that clears the
Lucid $50K eval ($3,000 target, 40% consistency = $1,200/day cap, all trades flat by
03:00 IST), backtested on real market data. NOTHING below touches live trading.

## EXECUTIVE SUMMARY (the honest bottom line)
After 5 rounds and ~7 months of real MNQ 1H data across 3 market regimes, I could NOT
find a robust, regime-independent intraday edge in any simple candle/breakout rule -
including your existing playbooks A/B/C and the obvious replacements. The evidence
says 'profitable within a week' is not supported, and shipping any of the tested
entries live would most likely cost money.

## What was tested (all with real data, commission $0.95/side, slippage, 03:00 IST flatten)
| # | Entry family | Result |
|---|---|---|
| 1 | Playbook A (4H + 1H engulf) | 0 tradeable setups / 66 days; even fully relaxed, PF 0.75 |
| 2 | Playbook B (SFP + FVG) | negative (1H: -$342; 30M: -$103) |
| 3 | Gate strictness sweep | 4H trend gate is 72% 'unclear' (noise); no level profitable |
| 4 | SFP + displacement (strength sweep) | negative at every threshold |
| 5 | Mean-reversion (fade support/resistance) | strongly negative (PF 0.32-0.42) |
| 6 | Momentum breakout (Donchian) | +in-sample, but FLIPS negative out-of-sample |
| 7 | Trend-filtered LONG breakout | filter does not rescue it; still regime-dependent |

## The three things that matter
1. YOUR PLAYBOOKS DO NOT EDGE OUT. A/C fire ~once per 2 months; B is net negative. This
   is the answer to 'do my current playbooks actually work?' - on real data, no.
2. THE 'SHORT BREAKOUT' THAT LOOKED GREAT (PF 2.63) WAS A REGIME ARTIFACT. Out-of-sample
   it lost $3,096 in the downtrend. The out-of-sample discipline just prevented a
   real-money loss.
3. NO SIMPLE 1H RULE IS REGIME-INDEPENDENT. Every positive result was confined to one
   market regime and flipped elsewhere.

## The realistic path forward (your decision)
A. MORE / BETTER DATA - a credentialed intraday feed (30M + more history) to do a
   genuine regime study. The 30M signal TF was never testable offline (only 8.5 days).
B. HIGHER TIMEFRAME - daily/4H swing (edges are more persistent than 1H intraday),
   aligning with your Rule #1 (Daily sets bias).
C. ACCEPT AND PROTECT - the current playbooks should NOT go live as-is; keep them as
   discretionary context, not a mechanical system, until something actually backtests.

## What this delivered (worth more than a fake green number)
A documented, evidence-backed answer to 'do my playbooks work?' (no), a demonstration
that out-of-sample testing catches what a curve-fit misses, and a hard stop on deploying
a strategy that would have lost money. That is the entire point of an honest harness.

## Artifacts in this folder
QUESTIONNAIRE.md, STRATEGY_BRIEF.md, CONFIRMED_SPEC.md, PLAYBOOK_CHECK.md,
BACKTEST_ROUND1..5.md, strategy_v1.pine (compiles clean), sweep_gates.js,
entry_experiments.js, test_breakout.js, characterize_breakout.js, consistency_fix.js,
test_regime.js, test_trendfilter.js, test_b_1h.js

---
## ROUND 6 UPDATE - the search is complete and conclusive

Added 3 more experiments (session-time filter, a 4th held-out regime, a trendiness
filter) to the search. The result strengthens the conclusion rather than changing it:

- LONG NY-session breakout was positive in 3 regimes (PF 1.37-3.40) - the most robust
  candidate found - but LOST $2,193 (PF 0.28) in the flat Nov-Jan regime.
- A trendiness (efficiency-ratio) filter could not rescue the flat regime and
  actually HURT the downtrend.

FINAL VERDICT (unchanged, now stronger): no simple, regime-independent MNQ intraday
edge exists in the tested rule space. Breakout/candle rules win in trends and lose in
ranges, and no simple filter reliably separates the two ahead of time.

THE ACTIONABLE PATH (what WOULD be needed, in order of realism):
1. A REGIME-SWITCHING model (e.g. ADX-based: trade breakouts only when ADX confirms
   trend, stand aside in ranges) - this is the ONLY thing the evidence points to, and
   it is beyond a simple rule; it needs careful out-of-sample validation.
2. A credentialed intraday feed (30M + more history) to test the actual signal TF.
3. Accept the finding: the current playbooks are discretionary context, not a system.
