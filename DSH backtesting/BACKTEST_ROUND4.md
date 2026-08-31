# DSH Backtesting - Round 4 findings (entry search + OUT-OF-SAMPLE disqualification)

## What I did
Round 3 showed the existing playbooks (engulf, SFP+FVG) have no edge. Round 4 searched
for a DIFFERENT entry: tested displacement-strength, mean-reversion, and momentum
breakout on the 65-day 1H data, then - critically - ran the winner OUT-OF-SAMPLE.

## 1. The candidate edge (in-sample, June-Aug 65 days)
Momentum breakout (close beyond N-bar high/low, stop beyond the breakout candle) was
the first positive result in 4 rounds:
  short-only L10 + $1000/day cap: 46 trades, 54% win, +$5,059, PF 2.63, DD $1,521,
  consistency 25% (best day $1,268).
The edge was almost ENTIRELY short-side (short +$5,332 vs long -$830).

## 2. The regime map (daily MNQ over ~10 months)
  2025-11..2026-01: flat/slight up
  2026-02..03: DOWNTREND (-$1,300, low 22,961)
  2026-04..05: STRONG UPTREND (+$6,500 to 30,405)
  2026-06: top | 2026-07: correction | 2026-08: chop
The in-sample (June-Aug) was a TOP + CORRECTION + CHOP regime - exactly where shorts
should win. That is the red flag that demanded an out-of-sample test.

## 3. OUT-OF-SAMPLE result (the decisive test)
Ran the SAME breakout rules on two held-out regimes:

| Regime | LONG breakout | SHORT breakout |
|---|---|---|
| UPTREND (Apr-May) | +$2,695 PF 1.52 (45%) | -$551 PF 0.76 |
| DOWNTREND (Feb-Mar) | +$540 PF 1.16 | -$3,096 PF 0.49 |

THE SHORT EDGE FLIPS SIGN OUT-OF-SAMPLE: shorts LOST in the downtrend (-$3,096, PF 0.49)
and lost in the uptrend (-$551). The +$5,332 short result from the in-sample was a
REGIME ARTIFACT of the June-Aug top/correction/chop, not a durable edge.

## 4. THE HONEST CONCLUSION (4 rounds of evidence)
1. No simple 1H candle/breakout entry (engulf, SFP+FVG, displacement, mean-reversion,
   momentum breakout) shows a ROBUST, regime-independent edge on MNQ.
2. Every 'positive' result was regime-specific and flipped on out-of-sample testing.
3. The out-of-sample test did its job: it DISQUALIFIED a PF 2.63 strategy that would
   have lost ~$3,000 if deployed into a downtrend. This is the process working.

## What remains (honest options)
A. TREND-FILTERED: LONG breakout only in uptrends (the one cell that is positive in
   both its own regime and the downtrend), with a hard trend filter. Narrow but the
   only surviving candidate.
B. Accept that a robust intraday edge for simple 1H rules may not exist in this data,
   and pivot to a higher-TF swing approach or a fundamentally different model.
C. Get more/different data (30M, or a credentialed feed) before concluding.

## Meta-finding (the part that matters most)
Four rounds of HONEST backtesting have produced more protection than profit: they have
shown that Anoop's playbooks do not edge out, and that the obvious replacements are
regime-locked. 'Profitable within a week' is not supported by the evidence. The
discipline of out-of-sample testing just prevented a real-money loss - which is the
exact opposite of what a sell-side backtest or a curve-fit would have delivered.
