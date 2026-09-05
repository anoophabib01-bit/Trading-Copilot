# Playbook C — ADX ≥ 35 Long-Only MNQ Breakout

> **Status (2026-09-01):** FORWARD TESTING — live in SHADOW mode. Backtested on ~9
> months of real MNQ 1H data across 5 market regimes; it has **never traded** and
> nothing in the app can place an order from it. It is now wired to a live detector
> that records the order it WOULD have sent, so the record builds while he trades
> his own account. See §13.
>
> **⚠️ Every headline number in this file was corrected on 2026-09-01.** The previous
> version's 2-contract column was the 1-contract column multiplied by two, which is not
> what happens when you double size (see §7). Corrected figures come from
> `app/scripts/verify-dsh-strategy.js`, re-run against the same data.

> **Naming (settled 2026-09-01):** this is **Playbook C (ADX)**, machine id **`C-ADX`**.
> `app/playbook-spec.js` keeps `C` for the *Engulfing Bar Validity GATE* — a gate, not a
> setup — and `autonomy-modes.js` aliases a bare `'C'` to `LTF-ENGULF`, so this setup
> could not safely take the bare id. Rows written before the rename carry `DSH-V2`, which
> survives as an alias rather than being rewritten.

---

## 1. One-line definition

**Long MNQ only, during a strong confirmed uptrend (ADX ≥ 35, +DI > −DI), buying a
10-bar high breakout, stop 3 points beyond the entry candle, target 2R. Patient,
long-only, trend-following.**

---

## 2. Instrument & chart

- **Instrument:** MNQ (CME Micro Nasdaq) — **$2 per point per contract**.
- **Chart:** **1-HOUR** (60m). *(30m is UNTESTED — see section 8.)*
- **Indicators:** **DMI** (Directional Movement), length 14, ADX smoothing 14 —
  gives three lines: **ADX, +DI, −DI**. No other indicators needed.

---

## 3. Entry — ALL FOUR must be true at the 1H candle CLOSE

| # | Condition | Why it matters |
|---|---|---|
| 1 | **ADX(14) ≥ 35** | Strong trend (not choppy/ranging) |
| 2 | **+DI > −DI** | The strong trend is UP |
| 3 | **Close > highest high of the previous 10 bars** | Fresh breakout |
| 4 | **Close > open** | The breakout candle is bullish |

If ANY fails → no trade. Wait for the next 1H close and re-check. This is the whole
discipline: most hours you do nothing.

---

## 4. Stop & target (fixed at entry)

- **Stop** = entry candle's **LOW − 3 points**.
- **Risk** = entry price − stop.
- **Target** = entry price + **2 × risk** (a fixed 2:1 reward:risk).

Worked example (MNQ ≈ 29,000):
- 1H candle closes: open 29,005 / close 29,050 / low 29,010, above the prior 10-bar
  high of 29,020; ADX = 38, +DI 28 > −DI 18. All four pass.
- **Entry** = 29,050 | **Stop** = 29,010 − 3 = **29,007** | **Risk** = 43 pts ($86/contract)
- **Target** = 29,050 + 86 = **29,136** (+$172/contract).

---

## 5. Exits

1. **Stop hit** → exit (loss).
2. **Target hit** → exit (win).
3. **12 bars (12 hours) with neither** → exit at the 12th close (time-stop; do not hold losers).
4. **03:00 IST** → flatten everything, no exceptions (Anoop's hard no-overnight rule).

---

## 6. Position sizing & daily discipline

- **2 contracts. Not 1, not 3.** `rules.json` sets `sizeFloor: 2` *and* `sizeCap: 2`.
  One-contract trading is **forbidden**, for a documented reason: it lost money in both
  stages of Anoop's real history (eval 25% win rate / −$361 over 12 trades; funded 54%
  but still −$345 over 13) because the wins were too small to pay for the losses.
  > *An earlier version of this file said "start 1, go 2 only after it proves itself on
  > paper." That contradicted the rulebook and is withdrawn. It also meant every headline
  > number here was computed at a size he is not permitted to trade — see §7.*
- **The $300 per-trade cap is the binding constraint at this size.** At $2/point and 2
  contracts, $300 permits a **75-point stop**; at 1 contract the same limit permits 150.
  That is not a scaling difference — it changes *which trades happen at all* (§7).
- **Stop for the day at +$1,000** (protects the 40% consistency rule — no day > $1,200).
- **Stop for the day at −$500** (hard daily loss cut).
- **One instrument/day** — MNQ only while running this.
- **15-minute break after every trade**.

---

## 7. Backtest evidence — CORRECTED 2026-09-01

**Method:** real MNQ 1H bars from CME (`get_history`), 5 regimes (Sep–Nov up, Nov–Jan
flat, Feb–Mar down, Apr–May up, Jun–Aug top/correction), ~9 months, commission
$0.95/side + 0.5pt slippage, 03:00 IST flatten. Re-run with
`node scripts/verify-dsh-strategy.js`.

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

### Robustness grid — re-derived at 2 contracts

Published at 1 contract as "all 16 cells positive, PF 1.31–2.94". That still holds. At 2
contracts all 16 remain positive, but **only 6 of 16 also clear the 40% consistency rule**
— and consistency, not profit, is what fails an eval.

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

## 8. Can it work on 30 minutes? — UNTESTED. Read carefully.

**Short answer: I could not test 30m, so it must be treated as UNPROVEN, not assumed.
Do NOT trade this on 30m until it is backtested on 30m data.**

**Why untested:** this session had no offline 30m source (the data feed gives 1H minimum
for MNQ futures; the TradingView chart loads only ~300 bars in memory and the
Pine-editor injection tool was broken). All validation was on **1H bars only**.

**What would change on 30m (theoretical, not measured):**
1. **ADX(14) on 30m = 7 hours** of trend context (vs 14 hours on 1H) — a shorter,
   noisier trend read that reacts faster.
2. **10-bar breakout on 30m = 5 hours** (vs 10 hours) — roughly **2× the signals**,
   but also ~2× the false breakouts (finer timeframe = more noise).
3. **The ADX ≥ 35 threshold was tuned on 1H.** On 30m the ADX distribution is
   different, so ≥35 is almost certainly the *wrong* value — it would need its own
   re-sweep (likely a higher or lower threshold).

**Expected direction (not a promise):** 30m would likely trade more often but with a
lower win rate and lower PF. The honest prior, given every finer-timeframe variant
tested in this session was *worse* (noisier), is that 30m would be **equal or worse**,
not better.

**To actually validate 30m:** needs 30m MNQ data (CSV export from TradingView/Tradovate
or a credentialed feed), then re-run the backtest and re-sweep the ADX threshold. Only
then can a 30m answer be given.

---

## 9. Parameter summary (single source of truth)

Live config lives in `app/rules.json` → `playbookCAdx`. This table documents it; it does
not override it.

| Parameter | Value |
|---|---|
| Machine id | `C-ADX` |
| Direction | LONG only |
| Timeframe | 1H (60m) — validated |
| ADX period / threshold | 14 / ≥ 35 |
| Direction filter | +DI > −DI |
| Breakout lookback | 10 bars |
| Stop | entry candle low − 3 pts |
| Target | 2R |
| Time-stop | 12 bars |
| Flatten | 03:00 IST |
| **Size** | **2 contracts** (`sizeFloor` = `sizeCap` = 2; 1 is forbidden) |
| **Max stop at that size** | **75 points** ($300 `perTradeMaxLoss` ÷ $2 ÷ 2) |
| Daily profit stop | +$1,000 |
| Daily loss stop | −$500 |
| Live status | SHADOW — records only, cannot place an order |

---

## 10. Files & code

- `DSH backtesting/TRADE_PLAN.md` — the one-page trade plan.
- `DSH backtesting/strategy_v3_adx_breakout.pine` — TradingView Pine strategy
  (compiles clean, 0 errors) implementing the exact rules above.
- `DSH backtesting/STRATEGY_V2.md` + `ROBUSTNESS_GRID.md` — the full research trail.
- `DSH backtesting/test_grid.js`, `test_final_strategy.js`, `test_refined.js` —
  the re-runnable JS backtests.

---

## 11. Caveats & what is NOT verified (read before trusting with real size)

1. **The size it was validated at is a size he cannot trade.** Every published figure was
   1 contract; `rules.json` mandates 2. Corrected in §7 — the real 2-contract result is
   +$3,051 / PF 1.95, not +$8,547 / PF 2.65.
2. **Consistency lands exactly ON the 40% limit at 2 contracts**, not under it. No margin
   is left for a single outsized day.
3. **Most signals are untradeable at 2 contracts.** In the most recent 65-day window, **8
   of 9 signals exceeded the $300 per-trade cap** and would be recorded as blocked rather
   than traded (`node scripts/verify-cadx-live-path.js`). Over the full 9 months it is 33
   of 76. Expect a *tradeable* signal roughly once every two months — the forward test
   will be slow to produce evidence, and an empty stretch is not a verdict.
4. **In-sample tuned** (ADX 35, lookback 10 chosen by testing 4–5 values). Mitigated by
   the 16-cell grid + held-out regimes, but NOT eliminated — and at 2 contracts the chosen
   cell is the *worst* consistency-safe one (§7).
5. **One ~9-month window** — no multi-year confirmation.
6. **Small sample** — 61 trades at 1c, 43 at 2c; PF has a wide confidence interval.
7. **Long-only** — makes nothing in a bear market (it stands aside, which is the point,
   but dead money while it waits).
8. **30m is unproven** (§8).
9. **Forward test only just started** (2026-09-01). Needs weeks of recorded signals before
   any of this is more than a backtest.

---

## 12. The one rule that keeps this alive

This edge exists **because it is patient**. It wins by trading rarely (only strong
uptrends), cutting losers at 3 points + a time-stop, and standing aside everywhere else.
The moment ADX is loosened, shorts are added, or trades are forced 'to go faster', the
edge is destroyed — that is the exact lever behind every blown account in the record.

---

## 13. The live forward test (started 2026-09-01)

**What is running.** `detectors.detectAdxBreakoutFromBars()` evaluates the four gates on
each closed 1H bar; `cadxCheckOnce()` in `server.js` arms the setup through `armSetup()`
— the same choke point A, B and LTF-ENGULF pass through — so the shadow recorder writes
the order it *would* have sent. Data comes from the **live TradingView MCP feed** via
`getFullBars('60', 120)`, cached within the hour, so it costs roughly one fetch per hour.

**What it cannot do.** Place an order. `shadowOnly: true`, `liveSize: null`, and both
`assist` and `control` remain `enabled: false`.

**Anoop's controls.** The UI toggle renders **OFF** and **SHADOW**. Switching to OFF
during a New York session stops the work on the next tick (`cadxCheckOnce()` returns
`inactive`) rather than merely hiding it. Signals are **not** silenced
(`shadow.silent: false`, his instruction of 2026-09-01), so a detection surfaces
immediately.

**Two things that must be read honestly:**

1. **A blocked row is not a signal that didn't happen.** Most signals will be recorded as
   `blocked: risk-too-big` (caveat 3). They are still written, deliberately — how often a
   rule proposes an untradeable setup is itself a finding about the rule.
2. **An empty file is not evidence of a quiet market.** Shadow mode's entire first life
   recorded zero orders because of a sizing misconfiguration, and nothing noticed.
   `node scripts/verify-cadx-live-path.js` exists to assert the path *can* fire — and it
   caught a real instance of exactly that failure on the day it was written (a
   milliseconds-vs-seconds mismatch that would have produced a permanently silent monitor
   reporting a healthy "no-signal").

**Files:** `app/detectors.js` (detector), `app/server.js` (`cadxCheckOnce`),
`app/rules.json` → `playbookCAdx`, `app/scripts/verify-cadx-live-path.js` (live-path
check), `app/test/detectors.adx.test.js` (18 tests).
