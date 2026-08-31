# DSH Backtesting - Parameter Robustness Grid (de-risks the curve-fit concern)

Grid: LONG-only breakout, +DI>-DI, daily $1,000 cap, 2R target, 5 regimes (~9 months).
Cell = net$ (PF, maxDD$, consistency%).

| lookback \\ ADX | 25 | 30 | 35 | 40 |
|---|---|---|---|---|
| 5 | $2857 (1.31, $1621, 48%) | $3405 (1.70, $745, 44%) | $4398 (2.57, $624, 30%) | $3197 (2.40, $587, 35%) |
| 10 | $2659 (1.33, $1685, 51%) | $3303 (1.77, $759, 45%) | $4326 (2.83, $609, 31%) | $3423 (2.75, $433, 34%) |
| 15 | $3111 (1.43, $1447, 44%) | $3713 (1.99, $709, 40%) | $4164 (2.76, $609, 32%) | $3262 (2.67, $433, 36%) |
| 20 | $2802 (1.42, $1977, 49%) | $3902 (2.15, $723, 38%) | $4306 (2.94, $609, 31%) | $3404 (2.88, $433, 34%) |

## THE KEY FINDING - the edge is NOT cherry-picked
ALL 16 cells are POSITIVE (net $2,659 to $4,398; PF 1.31 to 2.94; maxDD $433 to $1,977).
A sharp peak at ONE parameter combo is the signature of overfitting; a BROAD PLATEAU
across the whole grid is the signature of a real edge. This is a broad plateau.

## The consistency story (why ADX>=35 wins)
- ADX 25: consistency 44-51% - FAILS the 40% rule (trades too much chop).
- ADX 30: consistency 38-45% - borderline, over 40% in 2 of 4 cells.
- ADX 35: consistency 30-32% - cleanly under 40%, at every lookback.
- ADX 40: consistency 34-36% - under 40%, but fewer trades (no extra benefit).

## Recommended config (robust, consistency-safe)
ADX >= 35, +DI > -DI, lookback 10-20, daily $1,000 cap, 2R target, stop beyond candle.
Representative: lookback 15, ADX 35 -> +$4,164, PF 2.76, maxDD $609, consistency 32%.

## HONEST REMAINING CAVEATS (still not zero-risk)
1. SAME DATA PERIOD: the grid is robust across parameters but still on the SAME ~9 months.
   The strongest remaining test is a NEW period (forward) or paper trading live.
2. LOW FREQUENCY: 61-90 trades in ~9 months (~$400-500/month). Clearing $3,000 takes
   ~6-7 months - realistic for an eval, but not fast.
3. SMALL SAMPLE: ~60-90 trades. PF 2.5-2.9 is real, but the confidence interval is
   wide enough that live could run PF 1.5-2.0 for a while.

## Verdict
This is a REAL, robust, regime-aware edge - the first one to survive every test I could
throw at it (4 held-out regimes, a 16-cell parameter grid). It is slow, long-only, and
still wants forward validation, but it is the opposite of a curve-fit.
