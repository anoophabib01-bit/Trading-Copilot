# DSH Backtesting - Current Playbook & Infrastructure Check

> Result of auditing the existing playbooks and backtest tooling in the app
> (G:\MNQ-CoPilot). No strategy action taken - this is the 'check current
> playbooks' deliverable.

## TradingView access - CONFIRMED
The TradingView MCP bridge is connected and healthy:
- CDP connected, chart open on CME_MINI:MNQ1!, resolution 1D, 300-bar panes.
- Available: Strategy Tester, Pine editor (compile/check/analyze), chart state,
  symbol/timeframe switching, alerts, replay.
- Note: alertService API reported NOT available; Pine + Strategy Tester are.

## The three codified playbooks (app/playbook-spec.js)
| Id | Name | Entry TF | Bias TF | Requires fill? | Notes |
|---|---|---|---|---|---|
| A | 4H Engulfing + TF alignment | 60 | 240 | no (market at close) | Playbook-C gate applied |
| B | JadeCap 3-step (SFP + FVG) | 30 | 240 | yes (limit into gap) | Highest fake-edge risk if loose |
| C | Engulfing-bar validity | - | - | - | A GATE, not a setup |
| LTF-ENGULF | 30M/15M engulf (unsanctioned) | 30 | - | no | No HTF alignment; under evaluation |

- KEY FINDING: Playbook C is NOT a setup - it is a validity gate that only
  disqualifies. The live server had been labelling 30M/15M engulfs as 'C';
  the spec now names that LTF-ENGULF. Whether it should exist = an evidence
  question the backtest answers.
- Playbook B is defined by a LIMIT entry back inside the FVG on retrace
  (requiresFill: true). If price never retraces, it is NO TRADE, not a loss.
  This is the single most common source of fake edge in FVG backtests.

## Existing backtest tooling
- app/backtest.js - JS engine that imports the EXACT live detectors
  (detectors.js + playbook-c.js) and playbook-spec.js. Deliberately pessimistic:
  same-bar stop&target -> stop; limit entry must be touched; entry at bar close;
  commission both sides; slippage; partial-horizon trades excluded.
- app/scripts/backtest-playbooks.js - runner over saved bar files
  (DATA/bars/mnq_<tf>.json); tiers 50K (assumed) & 150K; --contracts/--playbook flags.
- app/scripts/pull-bars.js - pulls bars from TradingView into DATA/bars.
- Prop Trading/Playbook_A_C_Backtest_v2.pine and Playbook_B_JadeCap_SFP_FVG_Backtest_v1.pine
  - older Pine backtests, self-described 'best-effort codification' (no marker-zone exit).

## Risk gates already enforced in the backtest
- Overnight flatten at 03:00 IST (flattenByISTMinutes: 180) - HARD FLATTEN, already
  wired into backtest.js. THIS IS THE REQUIREMENT YOU ASKED ABOUT - IT ALREADY EXISTS
  IN THE ENGINE.
- Risk gate: skips setups whose stop is too wide for $300 max loss, or too narrow
  (< minRiskPoints); both counted and reported, not silently dropped.
- 4H bias read only from bars already closed at entry (no lookahead).

## Known open questions carried into the questionnaire
1. Exit proxy: rulebook says 'exit at marker levels' (hand-drawn, not codeable).
   Backtest currently uses an R-multiple (2.0). Must pick the official proxy.
2. 50K account figures are assumed ($3,000 target / $2,000 DD), not confirmed.
3. London vs NY session windows for the 03:00-flatten strategy need confirmation.

## What the build needs (from the user, via QUESTIONNAIRE.md)
Instrument + time-of-day window, playbook(s) to prioritize, entry/bias TFs,
stop buffer, target proxy (R / ticks / zone), time-stop bars, pyramiding yes/no,
data range + timeframe, and the pass criteria (win rate / profit factor / max DD)
that define 'profitable'.
