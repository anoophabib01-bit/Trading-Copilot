# DSH Backtesting - STRATEGY V2 (regime-switching, built from the deep-dive)

## The deep-dive insight (what 'option 3' actually revealed)
Re-examining WHY the playbooks fail produced three facts that no amount of gate-tuning
could have shown:
1. SHORTING BREAKDOWNS IS A BROKEN ENTRY. Short breakouts lost in BOTH clean trends
   (downtrend PF 0.26 even with ADX>=30 confirming the downtrend). Stop chasing shorts.
2. BREAKOUTS WIN IN STRONG TRENDS, LOSE IN RANGES. The 4th regime (flat Nov-Jan) killed
   every unfiltered entry. A range filter is mandatory, not optional.
3. ADX IS A USEFUL BUT INCOMPLETE REGIME FILTER. ADX>=25 still admits choppy periods;
   ADX>=35 (strong trend) almost fully excludes them.

## The refined strategy (V2) - 'long-only, strong-uptrend, breakout'
- ENTRY: LONG when close > 10-bar high AND close > open (Donchian breakout).
- REGIME GATE: only when ADX(14) >= 30-35 AND +DI > -DI (strong confirmed uptrend).
  Stand aside everywhere else (ranges, downtrends, chop).
- STOP: beyond the entry candle (bar low - 3pt) - matches 'stop beyond entry candle'.
- TARGET: 2R from the stop distance.
- DAILY CAP: stop new trades once the day is >= +$1,000 (enforces the 40% rule).
- HARD FLATTEN: 03:00 IST (already in rules.json).
- SIZE: 1 contract. Commission $0.95/side. Slippage 0.5pt.

## Results (5 regimes, ~9 months real MNQ 1H data, out-of-sample aware)
ADX>=35, +DI>-DI, daily $1,000 cap:
| Regime | Trades | Win% | Net | PF | DD |
|---|---|---|---|---|---|
| 5th Sep-Nov (up) | 26 | 62% | +$1,090 | 2.49 | $372 |
| flat Nov-Jan | 3 | 0% | -$180 | 0 | $180 |
| downtrend Feb-Mar | 4 | 50% | +$108 | 1.90 | $120 |
| uptrend Apr-May | 23 | 57% | +$2,265 | 3.16 | $609 |
| in-sample Jun-Aug | 5 | 60% | +$1,043 | 4.63 | $181 |
| AGGREGATE | 61 | ~59% | +$4,326 | 2.83 | $609 |

Consistency: 31% (best day $1,330 vs $4,326 total) - UNDER the 40% rule.
Max drawdown: $609 - well under the ~$2,000 limit.

ADX>=30 variant: +$3,303, PF 1.77, DD $759, consistency 45% (more trades, slightly
over the 40% line - the $35 threshold is what buys the consistency headroom).

## HONEST CAVEATS (do not skip these)
1. IN-SAMPLE TUNED: ADX threshold (30 vs 35), lookback (10), and the daily cap were
   chosen by testing 4-5 values on this data. This is curve-fitting risk, mitigated
   by the 5th held-out regime (Sep-Nov) holding up, but NOT eliminated.
2. LOW FREQUENCY: 61 trades in ~9 months (~1.5/week). At +$4,326 that is ~$480/month
   -> clearing $3,000 takes ~6-7 months. Slow, but consistent with most evals.
3. SMALL SAMPLE: 61 trades total; per-regime cells are 3-26 trades. The PF 2.83 is
   real but the confidence interval is wide.
4. LONG-ONLY: it will NOT make money in a bear market (it stands aside, which is the
   point, but a long-only strategy is dead money in a downtrend).

## Next steps (to trust this before any live size)
1. FORWARD/VALIDATION: run it on a brand-new period never used in tuning, or paper
   trade it live for 2-4 weeks before real size.
2. 30M confirmation: this is 1H; the confirmed spec's signal TF (30M) needs a
   credentialed feed or the live chart to confirm the edge persists at 30M.
3. Parameter robustness: confirm the edge survives lookback 5-20 and ADX 30-40
   without cherry-picking (a small grid, reported honestly).
