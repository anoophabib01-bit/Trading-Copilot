# DSH Backtesting - Strategy Brief (recorded from Anoop's answers)

> NO strategy action taken. This is the consolidated spec the build/study will follow.

## Your answers (verbatim intent, organized)

1. Playbooks: ALL (A, B, C) - study all three, then keep what works.
2. Trading window: Monday London session through Friday New York session (full week, both sessions).
3. Exit: AT KEY LEVELS. No fixed R multiple - it depends on market momentum.
4. Signal timeframe: 30M. Bias timeframe: 4H.
5. Data: 60 days. Contract size: 1 always, until you ask to change it.
6. Must clear the +-$100 break-even band; reward:risk 1:1 or 1:2; max 10 trades/day; must clear commission.
7. Exact risk model (stop beyond entry candle, etc.).
8. Quality over quantity: fewer trades = better quality. 1H timeframe is the KEY DRIVING factor
   for ALL trades. Stop-loss and take-profit placed above/below the ENTRY candle. Leave scope for
   modification and keep improving via research.

## Overarching goals
- Clear the evaluation: 40% consistency rule = $1,200/day cap on a 50K account.
  (i.e. 40% of the $3,000 profit target = $1,200 max single-day contribution; >=3 profitable days.)
- Primary source: REAL MARKET DATA backtested.
- Gather more TradingView tools if necessary.
- DO NOT build yet - study which setups work first, then improve upon them.
- Results that generate profit within a week (keep losses in mind).

## Inferred strategy shape (to confirm with Anoop)
- Bias: 4H market structure (HH-HL / LL-LH).
- Key driver: 1H structure + confirmation must agree with 4H.
- Entry trigger: 30M (engulf / SFP+FVG / engulf-gate per playbook A/B/C).
- Exit: nearest key level in the direction of the trade (no fixed R).
- Stop: beyond the entry candle's extreme (above/below the entry candle).
- Filters: skip if key level is closer than ~1:1 R; +-$100 break-even band; <=10 trades/day.
- Flatten: 03:00 IST hard flatten (already in app/rules.json).

## Data-source reality (found this turn)
- TradingView MCP OHLCV is capped at 500 bars (~10 days of 30M) - NOT enough for 60 days.
- DSH built-in market-data provider: NOT mounted (list_symbols ENOENT).
- EastMoney kline_history: no MNQ/NQ futures.
- => The 60-day real-data backtest will run in TradingView's Pine Strategy Tester,
   which holds full intraday history. Existing Pine backtests already target 1H/30M.

## Open questions (asked to Anoop)
- R:R vs key-level exit reconciliation.
- Which key levels define the exit.
- How 1H fits between 4H bias and 30M signal.
- Confirm consistency math ($3,000 target / $1,200 day cap).
- Instrument (MNQ only?) and 60 trading vs calendar days.
