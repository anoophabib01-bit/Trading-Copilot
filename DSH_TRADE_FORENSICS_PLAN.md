# Build queue for DSH — trade forensics + replay, 2026-09-05

**Contract:** same as `CLAUDE_TASKS_FOR_DSH.md`. DSH implements, Claude verifies. Every task has a
machine-checkable **ACCEPTANCE** block.

**Goal, in Anoop's words:** per-trade MAE/MFE, time-in-trade, entry vs session range, and what price
did for 30 minutes after the exit — all sitting in the Journal day data next to P&L. Then a replay
that steps through each trade with surrounding chart context, seeded from real fills. Then
conditional expectancy per tag, then counterfactuals against the real record.

**Ordering is forced by one measured fact, not by preference.** Read F0 before anything else.

---

## Reference — what the data actually looks like today

Measured 2026-09-05 against `DATA/_recovered_20260904/` (199 trades) and `DATA/bars/`.

**The trade side is in better shape than expected:**

```
side                 177/199
ep (entry price)     177/199
xp (exit price)      176/199
hold (seconds)       177/199
playbook               0/199   ← join was broken until 2026-09-04
minutesFromSignal      0/199   ← field exists, never populated
```

**The bar side is the problem:**

```
DATA/bars/mnq_5.json    300 bars   2026-08-31 → 2026-09-01
DATA/bars/mnq_15.json   300 bars   2026-08-20 → 2026-08-26
DATA/bars/mnq_1.json    300 bars   2026-09-01 only
```

Fixed-size rolling snapshots, overwritten in place. **There is no bar history to compute MAE/MFE
against for past trades, and none to replay them from.** Every task below except F0 is blocked on
fixing that, and F0 is the reason this plan starts where it does rather than with the analytics.

**Two incompatible bar schemas are already on disk.** `mnq_15.json` uses
`{time,open,high,low,close,volume}` with `time` in **seconds**; `mnq_30_live.json` and
`mnq_60_live.json` use `{t,o,h,l,c}` with `t` in **milliseconds**. Reading the second with the
first's reader produces dates in the year 58,000. Any new reader must normalise both or refuse.

---

# TIER F0 — the blocker

## F0.1 — Fix the cross-instrument bar bug in signal outcomes  ★ do this first

The excursion arithmetic in `app/signal-outcome.js` is correct and will be reused verbatim by F1.
It is currently being handed the wrong bars, and 7 of 46 scored outcomes are corrupt:

```
level 29189.25 (MNQ), mfe 24726.45   ← scored against MGC bars (~4,462)
level  4477.10 (MGC), mfe 24801.90   ← scored against MNQ bars (~29,279)
```

Cause, at `app/server.js:8381`:

```js
const chartMatches = !group.symbol || !currentSymbol || sameInstrument(group.symbol, currentSymbol);
if (chartMatches) bars = await getFullBars(group.tf, ...);
```

`getFullBars(tf, count)` takes **no symbol** — it returns whatever the chart is currently showing.
`getCurrentChartSymbol()` is wrapped in `.catch(() => null)` at `:8365`, so when it fails
`!currentSymbol` is true, `chartMatches` is true, and an MNQ signal is scored on gold bars.
`sameInstrument()`'s "unknown must not block" contract is right for that function and wrong as the
only gate in front of a bar fetch.

**Do:**
1. Fail **closed**: when `currentSymbol` is null, do not use `getFullBars`. Fall through to
   `readRecordedBars(symRoot, tf)`, which is symbol-keyed, or defer.
2. Sanity-bound at write time, **relative not absolute**: refuse to persist an outcome where
   `mfe` or `mae` exceeds ~2% of `level` over a 12-bar horizon. A flat 500-point bound breaks the
   day MNQ re-scales.
3. Add a staleness bound: refuse when `window[0].time - signalSec` exceeds a few bar-widths of `tf`.
   An Aug-28 signal was resolved on Sep-05 against Sep-05 bars (`mae 633.5`).
4. Quarantine the 7 existing bad rows to `*.outcomes.quarantine.jsonl`. Do not attempt repair — the
   correct bars were never recorded.

**Why it matters beyond tidiness:** with the 7 rows excluded the conclusions invert. B/30M is not
the disaster it appeared (MAE 1,596 → 100); the actually-weak book is A/5M at 20% favourable,
MFE 19.5 vs MAE 76.5 — which the corruption was hiding.

**ACCEPTANCE:**
- `node -e` over all `DATA/signals/*.outcomes.jsonl`: zero rows where `mfe > 0.02*level` or
  `mae > 0.02*level`.
- With TradingView on MGC, a pending MNQ signal logs `[chart off-instrument]` or resolves from
  recorded bars — never from the gold chart. Verifiable from server log on one pass.
- Existing `test/signal-outcome.test.js` and `.property.test.js` still pass.

## F0.2 — Durable bar archive  ★ nothing below this line is possible without it

Add `app/bar-archive.js` + a writer in the server.

**Shape:** append-only NDJSON per instrument+timeframe+day,
`DATA/bars/archive/<ROOT>/<tf>/<YYYY-MM-DD>.jsonl`, one normalised bar per line:
`{t, o, h, l, c, v}` with **`t` in milliseconds, always**. Dedupe by `t` on write (a re-poll of the
same forming bar overwrites; a closed bar is immutable).

**Which series:** MNQ and MGC at 1m, 5m, 15m, 30m, 60m. 1m is non-negotiable — it is what makes
MAE/MFE meaningful inside a 14-second trade (the 2026-09-03 −$1,718 held for 14 seconds; on 5m bars
its MAE is unmeasurable).

**Where from:** the existing poll loop already holds the chart lock. Do not add a second CDP
consumer — extend the existing `withChartLock` path and write what it already fetched.

**Volume:** 1m for two instruments, RTH+, is roughly 1,400 bars/day ≈ 120 KB/day uncompressed.
Do not trim, do not cap, do not rotate. This file *is* the forward-testing dataset.

**ACCEPTANCE:**
- After one live session, `DATA/bars/archive/MNQ/1/<today>.jsonl` exists with ≥ 300 lines,
  strictly increasing `t`, no duplicate `t`.
- A reader helper `readArchive(root, tf, fromMs, toMs)` returns bars for a range spanning two days
  and normalises the legacy `{time,open,...}` seconds files without producing a year-58,000 date.
- Restarting the server mid-session appends rather than truncating.

---

# TIER F1 — the four numbers, in the Journal day data

Every task here writes into the existing per-trade row in `DATA/accounts/<slot>/day_trades.json`,
alongside `pnl`/`size`/`side`/`ep`/`xp`. **Additive only** — never rewrite or drop an existing field.
Write via the existing `writeLiveTradeToDayRecord` (`server.js:9649`) merge-by-fingerprint path, so
a double-call cannot duplicate a row.

## F1.1 — MAE / MFE per trade

New module `app/trade-forensics.js`, pure, no I/O. Reuse the excursion loop from
`signal-outcome.js:113-115` — do **not** re-derive it, and do not import `signal-outcome.js` either;
extract the shared kernel into `trade-forensics.js` and have `signal-outcome.js` call it, so one bug
fix fixes both.

Difference from signal scoring: the window is **the trade's own life**, `[entryAt, exitAt]`, not a
fixed 12-bar horizon. Anchor is `ep`, sign from `side` (buy → +1, sell → −1).

Write: `mae`, `mfe` (points), `maeUsd`, `mfeUsd` (points × the point value
`point-value-verify.js` already cross-checks — never a hardcoded multiplier), and `edgeRatio`.

Two honesty rules, both learned already elsewhere in this repo:
- **Refuse rather than approximate.** No bars covering `[entryAt, exitAt]` → write
  `{mae: null, mfe: null, forensicsReason: 'no bars'}`. A null is a fact; a zero is a lie that
  averages into every aggregate below.
- **Bar granularity must be recorded.** Write `forensicsTf`. An MAE computed on 5m bars for a
  14-second trade is not a small-sample version of the 1m answer, it is a different number.

## F1.2 — Time in trade

`hold` already exists (seconds, 177/199). Do not recompute it — validate it. Add `entryAt`/`exitAt`
as explicit ms stamps if absent, since F1.1, F1.4 and the replay all need the exact window and
`t`/`x` are currently doing double duty.

## F1.3 — Entry position within the session range

At entry time, compute the high/low of the **current session so far** (session boundaries from
`rules.json` `sessionWindowsIST` — do not hardcode, they move twice a year with DST) and write:

```
sessionRangeHigh, sessionRangeLow,
entryPctOfRange   // 0 = at session low, 1 = at session high, may exceed [0,1] on a breakout
sessionTier       // the label the signal ledger already uses
```

`entryPctOfRange > 1` or `< 0` is meaningful, not an error — it says he entered on a break of the
session extreme. Do not clamp.

## F1.4 — Post-exit 30 minutes

From the archive, the 30 minutes of bars **after** `exitAt`. Write:

```
post30Mfe, post30Mae     // in the trade's original direction, anchored at xp
post30Close              // close 30 min after exit
post30LeftOnTable        // post30Mfe, i.e. what continuing would have paid
```

This is the "how much did I leave on the table" number and it needs its own anchor (`xp`, not `ep`)
or it silently double-counts the trade's own move.

**Backfill:** a one-shot `scripts/backfill-trade-forensics.js` that runs F1.1–F1.4 over historical
`day_trades.json` and fills only what the archive actually covers. Expect it to fill **almost
nothing** for pre-2026-09-05 trades. That is the correct outcome — say so in its output rather than
producing plausible numbers from the wrong bars, which is precisely the F0.1 failure.

**ACCEPTANCE for all of F1:**
- After one live session with ≥ 1 trade, that trade's row in `day_trades.json` carries
  `mae`, `mfe`, `maeUsd`, `mfeUsd`, `forensicsTf`, `entryAt`, `exitAt`, `entryPctOfRange`,
  `post30Mfe`, `post30LeftOnTable` — each either a finite number or an explicit `null` with a
  `forensicsReason`.
- Invariants, checkable over the whole store: `mae >= 0`, `mfe >= 0`, and for a **winning** trade
  `mfe*pointValue*size >= pnl` (you cannot book more than the best excursion offered) — allowing a
  documented tolerance for commission and bar granularity. A row violating this is a bug, not a
  result; assert at write time.
- The backfill script reports how many trades it could NOT fill and why, and exits 0.
- Unit tests in `app/test/trade-forensics.test.js`: a long that goes against then works, a short,
  a trade with no bars, a trade spanning a session boundary, a trade shorter than one bar.

---

# TIER F2 — tags and conditional expectancy

## F2.1 — Tag every trade

Add to each row, at write time:

```
playbook          // from signal-join.js — now works, was 0/199 before 2026-09-04
session           // asia | london | ny-open | lunch | pm  (from rules.json windows)
dayOfWeek
isReentry         // same instrument + same direction, within N minutes of the previous exit
afterLoss         // previous trade of the day was a loser
tradeIndexOfDay   // 1-based; the "third trade of the day" counterfactual needs this
minutesFromSignal // field exists, never populated — populate it
```

`isReentry` needs a defined window in `rules.json`, not a constant in code.

## F2.2 — Expectancy per tag

New module `app/expectancy.js`, pure. Given tagged trades, return per tag value:

```
n, winRate, avgWin, avgLoss, payoff, expectancyPerTrade, expectancyPerContract, totalPnl,
avgMae, avgMfe, avgHold
```

**Three rules, all of which this repo has already had to learn the hard way:**
- **Per contract, never per trade**, exactly as `week-rollup.js`'s `adherenceSplit()` does.
  Comparing per-trade across sizes measures how big he bet, not how well he traded.
- **`n` is displayed next to every number, always.** A tag with n=3 is not a finding.
- Publish a **minimum n** below which the UI greys the row rather than ranking it. With 199 trades
  across 6 playbooks × 5 sessions, most cells will be under it. Showing that honestly is the point.

**ACCEPTANCE:**
- `expectancy.js` unit-tested including: single-trade tag, all-losers tag, mixed sizes (proves the
  per-contract normalisation actually changes the answer vs per-trade).
- Sum of `totalPnl` across any single tag dimension equals the book total — no double-count,
  same doctrine as `failure-chain.js` cause attribution.
- A Journal panel renders the table sorted by `expectancyPerContract`, with `n` on every row and
  under-minimum rows visibly de-ranked.

---

# TIER F3 — the replay

**This is the piece that belongs in EdgeDesk and nowhere else** — seeded from real fills, not a date
picker.

## F3.1 — Replay data endpoint

`replay-load` over the existing WebSocket: given `{slot, day, tradeIndex}`, return from the archive
the bars for `[entryAt - lookbackBars, exitAt + 30min]` plus the trade's own markers
(entry, exit, MAE point, MFE point, session high/low, and the signal that armed it if
`signalBacked`).

Serve **1m** by default with the option to step out to 5m/15m. Include an explicit
`coverage: 'full' | 'partial' | 'none'` — a replay that silently shows fewer bars than the trade
lived through is worse than one that refuses.

## F3.2 — Replay UI

New tab or Journal sub-panel. A lightweight candlestick canvas — do **not** pull in a charting
library; the CSP/dependency footprint is not worth it for OHLC rectangles and five markers.

Controls: step back / step forward one bar, play/pause with speed, jump-to-entry, jump-to-exit.
Bars **after** the entry are hidden until stepped into, so the pre-entry read is honest — that is
the whole reason to replay rather than look at a static chart.

Overlays: entry, exit, MAE, MFE, session high/low, and the 30-minutes-after region shaded.

Navigation: prev/next trade within the day, and prev/next day. He should be able to walk a whole
week of fills without leaving the panel.

**ACCEPTANCE:**
- Open the Journal, click a trade, the replay opens at that fill with bars up to entry visible and
  later bars hidden.
- Stepping forward reveals bars one at a time; the MAE and MFE markers appear at the bars the F1.1
  numbers claim, and the marker prices equal the stored `mae`/`mfe` values. This is the cross-check
  that F1.1 is not lying.
- A trade with `coverage: 'none'` shows "no bars archived for this trade" — never an empty chart.

---

# TIER F4 — counterfactuals

New module `app/counterfactual.js`, pure, operating on the tagged+forensic trade list. Each
counterfactual is a function `(trades, params) => {net, ev, winRate, payoff, deltaVsActual}`,
returning the same shape as the table at the top of `CLAUDE_TASKS_FOR_DSH.md` so the two are
directly comparable.

Ship these four, which are the ones asked for:

1. **Every winner runs to 2R** — needs `mfe` and a defined R. R comes from the signal's stop when
   `signalBacked`, else from the trade's own MAE-implied risk; **flag which was used per trade** and
   report the two populations separately. A blended number here is not interpretable.
2. **Nothing after 11:00** (parameterised cutoff, IST wall-clock).
3. **Skip the Nth trade of the day** (parameterised, needs `tradeIndexOfDay`).
4. **Per-trade stop at $X** — already implemented for the T1.1 analysis; port it here so all
   counterfactuals live in one module with one output shape.

**The rule that keeps this honest:** a counterfactual may only use information available **at or
before** the moment it acts. "Every winner runs to 2R" is a legitimate exit-rule test because it
acts on a position already open. "Skip trades that turned out to be losers" is not a counterfactual.
Put that sentence in the module header, and reject any future counterfactual that violates it.

Second rule: counterfactuals **compound wrong**. Skipping trade 3 changes what trade 4's `afterLoss`
tag would have been, and changes the day's headroom, which changes whether a guardrail would have
fired. Do not silently chain them. Either model one at a time, or state explicitly in the output
that interactions are not modelled — the T1.2 finding (cap alone worse than stop alone, both
together worse than stop alone) is exactly what happens when interactions are real.

**ACCEPTANCE:**
- Each counterfactual returns the actual record unchanged when its parameter is set to a no-op
  (cutoff 23:59, stop $∞, skip index 0). This is the regression test that the harness itself is not
  altering the book.
- Output table matches the format already in `CLAUDE_TASKS_FOR_DSH.md`.
- Running counterfactual 1 on trades where `mfe` is null excludes them and **reports the exclusion
  count**, rather than treating null as zero.

---

# Order of work, and why

```
F0.1  fix cross-instrument bars      — the excursion kernel F1 reuses is currently fed wrong bars
F0.2  bar archive                    — everything else is blocked on it; start it TODAY, it only
                                       accrues forward
F1    the four numbers               — needs F0.2 running for a few sessions to be worth reading
F2    tags + expectancy              — F2.1 tagging can start in parallel with F1, it needs no bars
F3    replay                         — needs F0.2 + F1
F4    counterfactuals                — needs F1 (mfe) + F2.1 (tradeIndexOfDay, session)
```

F0.2 and F2.1 are both pure-forward: every day they are not running is a day of data that cannot be
recovered later. Ship those two before anything that produces a chart.

**One expectation to set now:** for the first two or three weeks the tables in F2 and F4 will be
mostly greyed-out under-minimum rows. That is the honest state of a 199-trade record split six ways,
and the app saying so is the feature. The failure mode to avoid is a confident expectancy ranking
built on n=3 — the same class of error as the 4,518-point MFE that started this.
