# DSH Backtesting - Round 1 findings (2026-08-27)

## 1. JS harness result (real MNQ data, exact live detectors)
Ran 'node scripts/backtest-playbooks.js --account 50k --contracts 1' on DATA/bars.
Bar spans: 30M=8.5 days, 1H=19 days, 4H=70 days (30M/1H too short for 60-day signal test).

| Playbook | Setups | Blocked | Filled | Win rate | Net (1c) | Profit factor |
|---|---|---|---|---|---|---|
| A (4H+1H engulf) | 1 | 20 gate-rejects | 1 | 0% | -$61.90 | 0 |
| B (SFP+FVG) | 17 | 11 risk-gate | 4 | 50% (2W/2L) | -$103.10 | 0.44 |
| LTF-ENGULF | 1 | 23 gate-rejects | 1 | 0% | -$74.40 | 0 |

HONEST CONCLUSION: none of the playbooks shows a positive edge on this sample, and
the sample is far too small to conclude anything (1-4 resolved trades each). The
harness correctly refuses to project an eval (needs >=10 resolved trades + positive
expectancy - TRUST-PROTOCOL Rule 1).

## 2. Key finding about the Playbook B DETECTOR
Playbook B saw 88 liquidity raids but produced only 4 resolved trades because:
- 11/17 detected setups were BLOCKED by the risk gate:
  - 7 'risk-too-small' = the raid candle and the displacement FVG third candle are the
    SAME BAR (no displacement leg between them) -> not the playbook.
  - 4 'risk-too-big' = stop wider than the $300 per-trade max loss.
- 2 'never filled' = the retrace into the FVG never came (correctly NOT a loss).
Interpretation: the live detector fires on lots of things that are NOT the actual
JadeCap SFP+FVG playbook. The detector needs tightening, not just the strategy.
This is exactly what the harness exists to reveal.

## 3. 60-day Pine strategy - WRITTEN + COMPILES CLEAN
File: strategy_v1.pine (this folder). Confirmed by TradingView server compile:
compiled=true, error_count=0, warning_count=0.

What it codes (matching CONFIRMED_SPEC.md):
- 4H bias: pivot HH-HL (bull) / LL-LH (bear) via request.security 240.
- 1H confirmation (key driver): 1H close above/below SMA20 + displacement body >=1.5x 1H ATR.
- 30M entry: A = engulf (+ C gate: liquidity not already swept); B = SFP sweep + displacement.
- Stop beyond the entry candle (+3pt buffer); target = fixed 1.5R (input 1.0-2.0).
- 03:00 IST hard flatten (strategy.close_all at the 03:00 IST bar).
- 1 contract, commission $0.95/side, slippage 2.

## 4. Next step (round 2) - run it on 60 days
The 60-day backtest must run in TradingView's Strategy Tester (the MCP OHLCV read is
capped at 500 bars, so the JS harness cannot pull 60 days of 30M). Plan:
1. Save current chart state (symbol + timeframe) and current Pine editor source.
2. Inject strategy_v1.pine, compile to chart, set 30M timeframe + 60-day visible range.
3. Read Strategy Tester results (net profit, win rate, profit factor, trades/day).
4. RESTORE chart timeframe + original Pine editor source (do not leave the live chart
   disturbed - it is Anoop's live workspace).

NOTE: step 2-4 touches the LIVE chart. Flagged for explicit care / user awareness.
