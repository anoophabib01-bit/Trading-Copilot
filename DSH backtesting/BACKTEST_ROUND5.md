# DSH Backtesting - Round 5 findings (trend-filtered LONG breakout)

Tested the last surviving candidate: LONG breakout (close > 10-bar high), trend-filtered
to only trade above a 1H SMA, across all three regimes.

| Regime | LONG no filter | +SMA100 | +SMA200 |
|---|---|---|---|
| Uptrend (Apr-May) | +$2,695 PF 1.52 | +$3,087 PF 1.69 | +$1,211 PF 1.31 |
| Downtrend (Feb-Mar) | +$540 PF 1.16 | -$122 PF 0.92 | +$187 PF 1.15 |
| In-sample (Jun-Aug) | -$740 PF 0.89 | -$354 PF 0.91 | -$342 PF 0.90 |

The trend filter DOES NOT rescue it:
- In-sample still negative after filtering (July correction was -$1,822, unavoidable).
- SMA100 vs SMA200 give inconsistent results (the filter itself is noise).
- The uptrend edge (+$2.7-3.1K) is regime-specific, not a durable signal.

FINAL VERDICT: no simple 1H candle/breakout rule produces a robust, regime-independent
edge on MNQ. The search over ~7 months / 3 regimes is now exhausted for simple rules.
