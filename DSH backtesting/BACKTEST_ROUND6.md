# DSH Backtesting - Round 6 findings (session + regime filters, 4th regime test)

## The NY-session candidate (looked robust across 3 regimes)
LONG breakout (close > 10-bar high), NY session hours, stop beyond candle, 2R target:
  Uptrend: +$2,901 PF 3.40 | Downtrend: +$253 PF 1.40 | In-sample: +$452 PF 1.37
First time an edge was positive in 3 regimes. Window sensitivity was acceptable
(12-17 and 13-17 UTC both positive; only the narrower 13-15 flipped negative).

## The 4th regime killed it (flat Nov 2025 - Jan 2026)
  LONG NY-session breakout: -$2,193 PF 0.28  (28 trades, 21% win)
  LONG all-hours:          -$2,472 PF 0.62
The flat/chop period destroyed the breakout rule - breakouts keep failing in a range.

## Trendiness (Kaufman ER20) filter - the natural response - did NOT rescue it
  flat regime after ER>=0.3 filter: still -$1,316 to -$1,263
  AND the filter made the downtrend WORSE (+$540 -> -$322).

## DEFINITIVE CONCLUSION (6 rounds, 4 regimes, ~8 months of real MNQ 1H data)
No simple 1H entry (engulf, SFP+FVG, displacement, mean-reversion, breakout) combined
with any simple filter (gate, trend-SMA, session-time, trendiness-ER) produces a
robust, regime-independent edge. Every candidate was positive in SOME regimes and
negative in OTHERS - the signature of regime-dependence, not a durable edge.

The single most common failure: breakout/candle rules work in TRENDING regimes and
fail in RANGING/CHOP regimes (flat Nov-Jan, top Jun-Aug). A simple filter cannot
reliably separate the two in advance.
