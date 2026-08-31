# TRADE PLAN — DSH ADX35 Breakout v3 (Long-only)

## The strategy in one line
Long MNQ breakouts ONLY during strong confirmed uptrends, hard stop + 2R target,
capped at +$1,000/day, all trades flat by 03:00 IST.

## Instrument & chart
- MNQ (Micro Nasdaq) — MNQ1! / MNQ=F
- **1-HOUR chart** (this is a 1H strategy, not 15M/30M)

## ENTRY (LONG only — never short)
All FOUR must be true at the 1H bar CLOSE:
1. ADX(14) >= 35
2. +DI > -DI
3. Close > highest high of the previous 10 bars
4. Close > open (bullish candle)

## STOP & TARGET
- Stop: 3 points BELOW the entry candle's low.
- Target: 2R (2x the stop distance).
- If neither hit within 12 bars, exit at the 12-bar close.

## DAILY DISCIPLINE (the part that keeps you funded)
- MAX 2 contracts per trade. NEVER 3.
- Stop trading for the day once you're up +$1,000 (protects the 40% consistency rule).
- Daily loss tiers: -$250 yellow / -$350 red / -$500 STOP for the day.
- Flatten everything by 03:00 IST. NO overnight.
- Max 10 trades/day (you will almost never get near this).
- ONE instrument/day — MNQ only while running this.

## EXPECTED NUMBERS (from 10.6 months of real backtest, honest)
- Win rate ~53%, payoff ~2:1, profit factor ~2.65.
- ~1.4 trades/week (it is PATIENT — most days NO trade).
- 2 contracts: ~$800/month gross edge; ~$530-610/month with the daily cap.
- Max drawdown ~$1,200. Biggest trade ~+$1,000 / -$540.
- To clear $3,000: ~5 months (NOT 30 days — the 40% rule + low frequency make 30 days impossible).

## BEFORE ANY REAL MONEY
1. Paper trade 2-4 weeks. Log every trade.
2. Forward-test on a fresh period.
3. If it holds (~50% win, ~2:1, PF > 1.5), start 1 contract, then 2.

## THE ONE RULE THAT KEEPS THIS ALIVE
This edge exists BECAUSE it is patient. The moment you loosen ADX or force more trades
to 'make $3,000 faster', you destroy it. Trade the setup, not the dollar target.

## Files
- strategy_v3_adx_breakout.pine — the TradingView strategy (compiles clean, 0 errors).
- STRATEGY_V2.md — the research behind it.
- ROBUSTNESS_GRID.md — the 16-cell parameter grid that proved it is not a curve-fit.
