# Playbook C — ADX ≥ 35 Long-Only MNQ Breakout

> **Status (2026-09-01):** FORWARD TESTING — live in SHADOW mode. Backtested on ~9 months
> of real MNQ 1H data across 5 regimes; it has **never traded** and nothing in the app can
> place an order from it.
>
> **⚠️ Every headline number below was corrected on 2026-09-01** — the old 2-contract
> column was the 1-contract column doubled. Full detail and the research trail:
> `DSH backtesting/Playbook_C_ADX_Long_Only_Breakout.md`.

> **Naming (settled 2026-09-01):** this is **Playbook C (ADX)**, machine id **`C-ADX`**.
> The rulebook's existing Playbook C is the *Engulfing Bar Validity GATE* — a gate, not a
> setup — and keeps the bare id `C`. Older records carry `DSH-V2`, kept as an alias.

---

## 1. One-line definition

**Long MNQ only, during a strong confirmed uptrend (ADX ≥ 35, +DI > −DI), buying a
10-bar high breakout, stop 3 points beyond the entry candle, target 2R. Patient,
long-only, trend-following.**

---

## 2. Instrument & chart

- **Instrument:** MNQ (CME Micro Nasdaq) — **$2 per point per contract**.
- **Chart:** **1-HOUR** (60m) — validated. *(30m is UNTESTED — see section 8.)*
- **Indicators:** **DMI** (Directional Movement), length 14, ADX smoothing 14 →
  three lines: **ADX, +DI, −DI**. No other indicators needed.

---

## 3. Entry — ALL FOUR must be true at the 1H candle CLOSE

| # | Condition | Why |
|---|---|---|
| 1 | **ADX(14) ≥ 35** | Strong trend, not choppy/ranging |
| 2 | **+DI > −DI** | The strong trend is UP |
| 3 | **Close > highest high of the previous 10 bars** | Fresh breakout |
| 4 | **Close > open** | Bullish breakout candle |

If ANY fails → no trade. Wait for the next 1H close. Most hours you do nothing.

---

## 4. Stop & target (fixed at entry)

- **Stop** = entry candle's **LOW − 3 points**.
- **Risk** = entry − stop.
- **Target** = entry + **2 × risk** (fixed 2:1).

Worked example (MNQ ≈ 29,000):
- 1H candle: open 29,005 / close 29,050 / low 29,010, above prior 10-bar high 29,020;
  ADX = 38, +DI 28 > −DI 18. All four pass.
- **Entry** 29,050 | **Stop** 29,007 (29,010 − 3) | **Risk** 43 pts ($86/contract)
- **Target** 29,136 (+$172/contract).

---

## 5. Exits

1. Stop hit → exit (loss).
2. Target hit → exit (win).
3. 12 bars with neither → time-stop at 12th close.
4. 03:00 IST → flatten everything (hard no-overnight rule).

---

## 6. Position sizing & daily discipline

- **2 contracts. Not 1, not 3.** `rules.json` sets `sizeFloor: 2` *and* `sizeCap: 2` —
  one contract is **forbidden** (it lost money in both stages of his real history).
  > *The earlier "start 1, go 2 after it proves itself" line contradicted the rulebook and
  > is withdrawn — and it is why every old headline number was computed at an illegal size.*
- **$300 per-trade cap = a 75-point max stop at 2 contracts** (150 at 1). This is the
  binding constraint, and it changes which trades happen at all.
- **Stop for the day at +$1,000** (protects the 40% consistency rule — no day > $1,200).
- **Stop for the day at −$500**.
- **One instrument/day** — MNQ only.
- **15-minute break after every trade**.

---

## 7. Backtest evidence — CORRECTED 2026-09-01

Method: real MNQ 1H bars from CME, 5 regimes (Sep–Nov up, Nov–Jan flat, Feb–Mar down,
Apr–May up, Jun–Aug top), ~9 months, commission $0.95/side + 0.5pt slippage, 03:00 IST
flatten. Re-run: `cd app && node scripts/verify-dsh-strategy.js`.

| Metric | 1 contract *(forbidden size)* | **2 contracts** *(the only legal size)* |
|---|---|---|
| Net profit | +$4,326 | **+$3,051** |
| Win rate | 56% | **51%** |
| Profit factor | 2.83 | **1.95** |
| Max drawdown | $609 (30% of the $2,000 limit) | **$907 (45%)** |
| Trades | 61 | **43** |
| Consistency (best day ÷ total) | 31% | **40% — *on* the 40% limit, not under it** |
| Setups refused for stop width | 15 | **33** |
| Time to the $3,000 target | ~7 months (~$481/mo) | **~9 months (~$339/mo)** |

### ⚠️ What the previous version of this file got wrong

It reported the 2-contract column as **+$8,547, PF 2.65, DD $1,217, 66 trades**. Those
were the 1-contract figures **multiplied by two** — $4,326 × 2 ≈ $8,547, $609 × 2 = $1,218.
The tell is that win rate and profit factor were printed identically in both columns
(53%/53%, 2.65/2.65); a real re-run changes both, because doubling size does not scale a
result — it **changes which trades are permitted**. `perTradeMaxLoss` is $300, so 2
contracts cap the stop at 75 points instead of 150, and **33 of 76 setups are refused
instead of 15**. Net profit is over-stated by ~2.8×.

**Grid at 2 contracts:** all 16 cells stay positive, but **only 6 of 16 also clear the
40% consistency rule** — and consistency, not profit, is what fails an eval.

| lookback \ ADX | 25 | 30 | 35 | 40 |
|---|---|---|---|---|
| **5** | +$4,203 (1.49, 33%) | +$2,961 (1.52, 40%) | **+$4,021 (2.17, 30%)** | +$3,013 (2.13, 39%) |
| **10** | +$3,623 (1.49, 38%) | +$1,933 (1.38, 64%) | *+$3,051 (1.95, 40%)* | +$2,641 (1.98, 47%) |
| **15** | +$3,361 (1.49, 37%) | +$2,253 (1.49, 55%) | +$2,702 (1.82, 46%) | +$2,292 (1.83, 54%) |
| **20** | +$3,835 (1.63, 32%) | +$2,918 (1.75, 42%) | +$2,985 (1.99, 41%) | +$2,576 (2.03, 48%) |

*Italic = the published config. **Bold** = the cell that dominates it.*

**The published config (lookback 10 / ADX 35) is the worst of the consistency-safe
cells at 2 contracts.** `lookback 5 / ADX 35` beats it on net (+$4,021 vs +$3,051),
profit factor (2.17 vs 1.95) *and* consistency (30% vs 40%) simultaneously — dominance
on every axis, not a cherry-pick.

**It is being forward-tested at lookback 10 / ADX 35 anyway.** Re-tuning to the best cell
of a grid before a single forward trade exists is exactly the curve-fit the caveats warn
about. The published claim gets tested as published; `lookback 5` is a candidate the
forward data may promote, not a change to make on in-sample evidence.

---

## 8. Can it work on 30 minutes? — UNTESTED.

**Do NOT trade this on 30m until it is backtested on 30m data.**

- All validation was on **1H only**; there was no offline 30m source in this session.
- On 30m: ADX(14) = 7h trend read (vs 14h on 1H); 10-bar breakout = 5h (vs 10h).
- Expected: ~2× signals, but noisier → likely lower win rate and PF.
- **ADX ≥ 35 was tuned on 1H**; on 30m it is almost certainly the wrong threshold and
  would need its own re-sweep.

Honest prior: every finer-timeframe variant tested in this session was *worse* (noisier),
so 30m is expected to be equal or worse — not better — until proven otherwise.

To validate 30m: needs 30m MNQ data (CSV from TradingView/Tradovate or a credentialed
feed) + re-backtest + re-sweep the ADX threshold.

---

## 9. Parameter summary

Live config: `app/rules.json` → `playbookCAdx`. This table documents it, it does not
override it.

| Parameter | Value |
|---|---|
| Machine id | `C-ADX` |
| Direction | LONG only |
| Timeframe | 1H (validated) |
| ADX period / threshold | 14 / ≥ 35 |
| Direction filter | +DI > −DI |
| Breakout lookback | 10 bars |
| Stop / Target / Time-stop | candle low − 3pt / 2R / 12 bars |
| Flatten | 03:00 IST |
| **Size / max stop** | **2 contracts / 75 points** ($300 cap ÷ $2 ÷ 2) |
| Daily stops | +$1,000 profit, −$500 loss |
| Live status | SHADOW — records only, places nothing |

---

## 10. Files & code

- `DSH backtesting/strategy_v3_adx_breakout.pine` — Pine strategy (compiles clean).
- `DSH backtesting/TRADE_PLAN.md` — one-page trade plan.
- `DSH backtesting/ROBUSTNESS_GRID.md`, `STRATEGY_V2.md` — research trail.
- `DSH backtesting/test_grid.js`, `test_final_strategy.js` — re-runnable JS backtests.

---

## 11. Caveats (not verified)

1. **Validated at a size he cannot trade.** All published figures were 1 contract;
   `rules.json` mandates 2. Real 2-contract result: +$3,051 / PF 1.95, not +$8,547 / 2.65.
2. **Consistency sits exactly ON the 40% limit at 2 contracts** — no margin.
3. **Most signals are untradeable at 2 contracts.** In the last 65-day window, 8 of 9
   signals blew the $300 per-trade cap; 33 of 76 over the full 9 months. Expect a
   tradeable signal roughly once every two months.
4. In-sample tuned — and at 2 contracts the chosen cell is the *worst* consistency-safe one.
5. One ~9-month window; small sample (61 trades at 1c, 43 at 2c).
6. Long-only — dead money in bear markets.
7. 30m unproven (§8).
8. Forward test started 2026-09-01 — needs weeks of recorded signals to mean anything.

---

## 12. The one rule that keeps this alive

This edge exists **because it is patient**. Loosening ADX, adding shorts, or forcing
more trades to 'go faster' destroys it — the exact lever behind every blown account.

---

## 13. Live status (2026-09-01)

Running in **SHADOW** mode: a live 1H detector reads the TradingView MCP feed and records
the order it *would* have sent. It cannot place one.

The UI toggle offers **OFF** and **SHADOW** — switch to OFF during a New York session and
it stops on the next tick. Signals are not silenced, so detections surface immediately.

Most recorded rows will be `blocked: risk-too-big` (caveat 3); that is a finding about the
rule, not a fault. An empty record is not proof of a quiet market — run
`cd app && node scripts/verify-cadx-live-path.js` to confirm the path can still fire.
