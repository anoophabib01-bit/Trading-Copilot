# DSH Backtesting - Strategy Questionnaire

> Created for the 'DSH backtesting' folder (G:\MNQ-CoPilot\DSH backtesting).
> Purpose: gather the parameters needed to build a profitable, backtested strategy
> whose EVERY trade is forced flat by 03:00 IST. That overnight flatten is already a hard
> rule in the app: app/rules.json -> flattenByISTMinutes: 180.
>
> NO STRATEGY ACTION HAS BEEN TAKEN. This is a planning artifact.

## A. Non-negotiables already locked in (confirmed from the app, not re-asking)

| Item | Current value | Source |
|---|---|---|
| Overnight flatten | 03:00 IST hard flatten (flattenByISTMinutes: 180) | rules.json |
| Instruments | MNQ (Micro Nasdaq) + MGC (Micro Gold) | rules.json / CLAUDE.md |
| Account | Lucid $50K eval (50K tier assumed: $3,000 target / $2,000 DD) | backtest harness |
| MNQ point value | $2 / point / contract | point-value-verify.js |
| Commission | $0.95 / contract / side (round turn ~$1.90) | rules.json |
| Max size | 2 contracts per entry (hard cap) | Rule #2 |
| Trade caps | 5 / session, 10 / day | Rule #5 |
| Per-trade max loss | $300 (skip if stop too wide) | rules.json perTradeMaxLoss |
| Min risk points | 8 pts (Playbook B guard) | rules.json playbooks.minRiskPoints |
| Break-even band | +-$100 (outside it = a real trade) | Rule #8 / F4 |
| Daily loss tiers | -$250 yellow / -$350 red / -$500 hard stop | Rule #3 |

The 03:00 IST flatten is the single most important input. It caps every playbook's
horizon (a 12-bar 30M horizon = 6h, so any setup arming after ~21:00 IST cannot run
its full distance). We must pick setups and times-of-day whose edge pays out INSIDE
that window, not after it.

## B. Instrument & market selection

1. Which instrument should this strategy trade?  [ ] MNQ only  [ ] MGC only  [ ] Both (never same day - Rule #9)
2. If both, how is the day's instrument chosen (Daily bias / cleaner structure / fixed weekday rule)?
3. Entry time-of-day window (IST) - which hours may it open a trade?
   Current windows: London 13:30-15:00 IST, NY 19:00-21:00 IST. Given the 03:00 flatten,
   are we NY-only, or a different window?
4. Days of week to trade? (Rule #10: Mon/Fri choppy - exclude them?)
5. Filter on high-impact news (NFP, FOMC, CPI) windows?

## C. Playbook / setup choice

| Playbook | What it is | Entry | Notes |
|---|---|---|---|
| A | 4H structure + 1H engulf | at 1H engulf close | needs 4H HTF alignment + Playbook-C gate |
| B | JadeCap: SFP raid + FVG | LIMIT back inside FVG on retrace | requires fill; highest fake-edge risk |
| C | Engulfing-bar validity | - (a GATE, not a setup) | qualifies/disqualifies A's engulf |
| LTF-ENGULF | 30M/15M engulf (unsanctioned) | at engulf close | no HTF alignment - under evaluation |

6. Which playbook(s) to build & backtest first? (A / B / C / all)
7. Higher-timeframe bias filter (Daily/4H/1H)? Must it agree with entry direction (Rule #1)?
8. Additional discretionary filters to codify (doji at zone, volume/OBV, ATR floor on body)?

## D. Entry / exit / risk parameters

9. Entry timeframes - signal TF (e.g. 30M) and bias TF (e.g. 240):  entryTf = ___, biasTf = ___
10. Stop placement:
    - A: beyond engulf bar extreme + buffer. Buffer in points? (currently 3.0)
    - B: beyond SFP wick. Fallback to swept level if wick not captured - OK?
11. Target/exit: rulebook says 'exit at marker levels' (not codeable). Pick a backtest proxy:
    [ ] Fixed R multiple (currently 2.0) - what R?   [ ] Fixed tick target (4-8 ticks)
    [ ] Next swing / liquidity pool (needs a zone-finder)   [ ] Trailing stop
12. Time stop: exit flat if no progress within N bars? N = ___
13. Second entry / pyramiding (Playbook A: entry 2 + SL to BE) - code it, or single-entry for v1?
14. Minimum R:R before acceptable? (currently 2.0; Entry Framework min 1:2, ideal 1:3-1:4)
15. Max risk per trade (default $300) and at how many contracts?

## E. The 03:00 IST flatten & intraday handling (core requirement)

16. Confirm flatten time 03:00 IST. Position still open at that instant is closed at market - correct?
17. Additional intraday hard exits: daily-loss tier hit (-$500) stop for day; trade-cap hit stop for
    session; NY window close (21:00 IST) flatten?
18. Playbook B limit entry: if retrace never fills before flatten/window close, setup expires UNFIRED
    (NO trade) - correct, or mark a scratch?

## F. Data & backtest methodology

19. Data source / range: saved bars in DATA/bars/*.json (via app/scripts/pull-bars.js) or fresh?
    How many days of history (recommend >= 30 trading days)?
20. Timeframe resolution: 30M / 15M / 1H / 5M?
21. Which engine gives the official number?
    [ ] JS harness (app/backtest.js - reuses EXACT live detectors; pessimistic fills; commission+slippage; recommended)
    [ ] TradingView Strategy Tester (Pine - existing Playbook_*_Backtest*.pine) for visual sanity
22. Pass criteria for 'profitable': min win rate? ___  min profit factor? ___  min Sharpe? ___
    max drawdown? ___  must clear commission AND the +-$100 band on most trades?

## G. Deliverables & governance

23. Where should strategy config live so live monitors + backtest both read it? (Convention: app/rules.json playbooks block)
24. Wire into live monitors after it backtests well, or research-only for now?
25. Confirm no guardrails relaxed: max 2 contracts, 5/session 10/day caps, loss tiers,
    +-$100 band, one-instrument/day.

*Answer the bracketed/blank items. Everything else is confirmed from the app and will be baked
in as-is. Once you answer, I will turn this into an executable backtest spec in this folder - still no live action.*
