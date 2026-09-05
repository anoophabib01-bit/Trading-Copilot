# Acceptance result + fix list — F0 / F1-module / F2 / F4

**Run by Claude, 2026-09-05, against the working tree.** Contract as per
`CLAUDE_TASKS_FOR_DSH.md`: DSH implements, Claude verifies.

**Verdict: F0.1 PASS. F2 PASS. F0.2, F1-module and F4 need a fix pass before F3 and the F1
live-write are worth building on top of them.**

Suite: 1,884 tests, 1,869 pass, 15 fail. All 15 failures are in `stage-rules.test.js`,
`week-rollup.test.js` and `week-store.test.js`, whose sources were last modified at 14:25 —
before this work landed at 19:43–19:52. **Pre-existing, not attributed to this plan**, but they
need an owner. New-module tests: bar-archive 3/3, trade-forensics 6/6, expectancy 5/5,
counterfactual 4/4, trade-tags 3/3, signal-outcome 31/31.

---

## What passed, so it does not get re-litigated

**F0.1 — fully verified.**
- Fail-closed at `server.js:8410-8411` (`chartKnown = currentSymbol != null` gates the fetch).
- Sanity bound: 0 violations in 45 resolved rows against 2% of `level`.
- Staleness bound at `signal-outcome.js:99-105`, correctly measured on **bar gap**
  (`after[0].time - signalSec`), not on job lag. This is the right choice and worth keeping —
  rows resolved 200h late are fine when the bars they scored were adjacent to the signal.
- 6 rows quarantined across 4 files.

**F2 — fully verified.** Conservation holds (tag totals sum to book total). Per-contract
normalisation demonstrably changes the ranking versus per-trade (`A,C,B` → `C,A,B` on a mixed-size
fixture), which is the proof it is doing real work and not decoration. `n` on every row,
`underMin` present, null MAE/MFE excluded from averages rather than zeroed.

**F0.2 partial.** Dual-schema normalisation verified — both the legacy seconds schema and the
`{t,o,h,l,c}` ms schema produce correct 2026 dates, no year-58000. The writer reuses bars
`getFullBars` already fetched, so there is no second CDP consumer. Correct.

**F1 kernel.** `signal-outcome.js` now calls `tradeForensics.excursion`; one fix fixes both.
Null discipline in `tradeForensics` is right.

**F4 no-op regressions.** All four counterfactuals return `deltaVsActual: 0` under no-op
parameters.

---

## RE-VERIFICATION — 2026-09-05, after DSH's fix pass

Claude re-ran each item by driving the functions directly, not by trusting the new tests.
Suite: **1,886 tests, 1,871 pass, 15 fail** — the same 15 pre-existing `stage-rules` / `week-*`
failures, unchanged and unrelated (see the note at the top).

| Item | Status |
|---|---|
| X1 `postExitMove` null discipline | **CLOSED** — nulls + `post30Reason`, real bars still resolve |
| X2 `skipNthTrade` per-day | **CLOSED** — two-day fixture returns net 40 |
| X3 `entryIstMin` + composition | **CLOSED** — `[480,840,1050]`; cutoff 780 gives delta 450 |
| X8 backfill sees the record | **CLOSED** — `unfilled=199` (177 no-bars / 22 no-timestamps) |
| M1 scratch, M2 volume | **CLOSED** |
| X4 `winnersRunTo2R` | **HALF** — silent no-op gone (`refused` + `error`); per-trade R derivation, `rSource` and split populations still missing, and nothing populates `t.r` |
| X6 winners' invariant | **HALF** — function correct, **called from tests only**; see revised X6 |
| X5, X7, M3 | open |
| X9 `--from` parsing | new, found during re-verification |

The X8 result is worth keeping: the script's own `177 / 22` split independently reproduces the
field coverage measured from the raw record before any of this was built. Its accounting is right.

---

# FIX LIST

Ordered by severity. **X1–X4 fail silently** — they return a plausible number rather than an
error, which is strictly worse than crashing, and is the same class of defect as the 4,518-point
MFE that started this whole plan.

---

## X1 — `postExitMove` returns 0 instead of null when no bars cover the window  ★ highest

`trade-forensics.js:63`. `tradeForensics` correctly refuses when no bars cover
`[entryAt, exitAt]`. `postExitMove` has no equivalent check, so `excursion` over an empty set
returns its initial zeros:

```
postExitMove(trade, [])                  → {post30Mfe: 0, post30Mae: 0, post30LeftOnTable: 0}
postExitMove(trade, [bar far in future]) → {post30Mfe: 0, post30Mae: 0, post30LeftOnTable: 0}
```

This lands directly on `post30LeftOnTable` — the "what I left on the table" number Anoop asked
for by name, and the one he will read most. Right now an unarchived trade reads as *"you left
nothing on the table"*, which is the most misleading possible answer.

**Do:** mirror the `covering` check from `tradeForensics`. No bar with
`t >= exitAt && t <= exitAt + 30min` → return all four fields `null` plus a
`post30Reason: 'no bars cover the post-exit window'`.

**ACCEPTANCE:**
- `postExitMove(trade, [])` returns `post30Mfe: null`, not `0`.
- A trade whose exit is 25 minutes before the last archived bar returns `partial` in the reason
  or resolves — DSH's call, but it must be distinguishable from a full 30-minute window.
- Unit test asserting the empty-bars case explicitly.

---

## X2 — `skipNthTrade` counts across the whole list, not per day

`counterfactual.js:50`. `idx` increments over every trade in the input, so "skip the third trade
of the day" skips the third trade in the *book*. Verified on a two-day fixture:

```
[d1:10, d1:20, d2:30, d2:40], n=2
expected: drop 20 and 40 → net 40
actual:   dropped 20 only → net 80
```

Across 199 trades this drops 1 trade instead of roughly 14, so the counterfactual returns a
near-zero delta and reads as "skipping the third trade wouldn't have helped" — a false negative
on one of the four questions the tier exists to answer.

It also ignores `tradeIndexOfDay`, which F2.1 was built specifically to supply.

**Do:** use `t.tradeIndexOfDay === n`. Fall back to grouping by trading day only if the field is
absent, and say so in the output.

**ACCEPTANCE:**
- The two-day fixture above returns net 40.
- Run against the real 199-trade record with `n=3`: the number of trades removed equals the
  number of days that had at least 3 trades. Print both.

---

## X3 — `cutoffAt` reads a field `trade-tags.js` never emits

`counterfactual.js:39` reads `t.entryIstMin`. `trade-tags.js:29` computes `istMin` and then
**discards it** — it is used only to derive `session` and never written to the output row.

So on real tagged data `cutoffAt` finds `entryIstMin == null` on every trade, skips the cutoff
branch, and returns the actual book. The "nothing after 11:00" counterfactual will report
`deltaVsActual: 0` and look like a finding.

This is the one to take personally: two modules built in the same session to compose with each
other, and nothing in either test suite runs them together.

**Do:** emit `entryIstMin` from `tagTrades`. Then add the integration test that would have caught
it.

**ACCEPTANCE:**
- `tagTrades(...)` output rows carry `entryIstMin`.
- **Integration test** (new, not a unit test): `tagTrades` → `cutoffAt` with a cutoff that must
  exclude trades, asserting a non-zero `deltaVsActual`. A counterfactual that returns exactly the
  actual book under a *non*-no-op parameter should be treated as a failure, not a result.

---

## X4 — `winnersRunTo2R` silently no-ops when `R` is absent, and R is not derived per trade

`counterfactual.js:28`:

```js
if (pnl <= 0 || R == null || pv == null) { pnls.push(pnl); continue; }
```

"No R was supplied" takes the same branch as "this trade is not a winner". `excluded` stays 0,
every P&L passes through unchanged, and the function returns a clean-looking
`{excluded: 0, deltaVsActual: 0}`. Verified — a winner with `mfe: null` and no `R` reported
`excluded: 0`.

Second half: the plan requires R be derived **per trade** — the signal's stop when `signalBacked`,
otherwise MAE-implied — with `rSource` flagged per trade and the two populations reported
**separately**, because a blended 2R number across two different definitions of R is not
interpretable. Currently R is one global parameter.

**Do:**
1. Throw, or return `{error}`, when `R` and `pointValue` cannot be resolved. Never silently pass
   through.
2. Derive R per trade; write `rSource: 'signal-stop' | 'mae-implied'`.
3. Return two result blocks, one per `rSource`, plus the counts.

**ACCEPTANCE:**
- Called with no `R` and no per-trade derivation available: returns an explicit error/refusal,
  not a silent no-op.
- A winner with `mfe: null` increments `excluded` and the count appears in the output.
- Output carries separate blocks for `signal-stop` and `mae-implied` populations with `n` on each.

---

## X5 — 1-minute bars will never enter the archive  *(rewritten 2026-09-05 — no paid data)*

> **Databento is OUT.** An earlier draft of this item assumed a Databento GLBX.MDP3 backfill.
> Anoop has ruled out paying for data, no Databento code was ever written, and none should be.
> Do not add a paid-data dependency to close this item. The free path below is also the better
> one: it reuses bars the app already fetches.

`archiveBars` only ever sees timeframes something actually asked `getFullBars` for. Exhaustive
grep of `server.js`: the literal timeframes requested are `15` (x7), `60` (x5), `W` (x2), `240`,
`D`, `M`; the four variable call sites resolve to `5`, `15`, `30`, `60` (`PO3_BAR_COUNTS` at
`server.js:4846`, plus the playbook configs). **`getFullBars('1', ...)` appears nowhere.**

1m matters for one measured reason: the 2026-09-03 -$1,718 loss was held for **14 seconds**. On
5-minute bars its MAE is not a coarse estimate, it is not a measurement at all.

### X5a — forward capture: ask for 1m in the existing poll loop

Add one low-frequency 1m pull to the loop that already holds the chart lock. `archiveBars`
captures it with no further change. Not a second CDP consumer, no new dependency, no cost.

Keep the cadence low (the archive dedupes by `t`, so a pull every few minutes still yields a
complete 1m series) and skip it when TradingView is disconnected, exactly as the other monitors do.

**ACCEPTANCE:**
- After one live session, `DATA/bars/archive/MNQ/1/<today>.jsonl` exists, >= 300 lines,
  strictly increasing `t`, no duplicate `t`, dates in 2026.
- Server log shows no new chart-lock contention warnings versus a session before the change.
- `readArchive('MNQ','1',...)` returns bars spanning a trade known to have lasted under a minute.

### X5b — recent-past backfill from TradingView itself  *(SKIPPED — Anoop's decision, 2026-09-05)*

> **NOT BEING BUILT.** Anoop chose to skip this. It was the largest piece of work in this item and
> the smallest payoff: it reaches back a week or two, cannot recover the 199 recovered trades, and
> has to move the live chart to do it. X5a running from the next session gets a clean forward 1m
> series with none of that risk. Do not build it without him asking again.
>
> **X5a is DSH's**, as a rider on the F1 live-write already in flight in `server.js` — two people
> editing that file at once is how a live trading server gets a bad merge.
>
> Original spec kept below for the record.

One-shot script: walk the chart back and write historical 1m bars into the same archive. TradingView
will serve a few thousand 1m bars on request, which reaches back roughly a week or two -- enough to
cover the most recent trades, which are the ones worth replaying first.

**Two constraints, both non-negotiable:**
- Go through `withChartLock` and restore the chart's original symbol and timeframe afterwards.
  Do **not** use `batch_run` -- it is confirmed broken and never restores chart state
  (see `tradingview-mcp/CLAUDE.md`).
- Run it OUTSIDE a live session. It moves the chart Anoop trades from.

**ACCEPTANCE:**
- Script reports bars written per instrument and per day, and the date range it actually reached.
- Chart symbol and timeframe are identical before and after the run.
- Re-running it writes zero new rows (dedupe by `t` proves idempotence).

### X5c — partial coverage is the honest steady state

No further code. X1's null discipline already delivers this: MAE/MFE appear where bars exist and
read *"not archived"* where they do not.

**This is the item that must NOT be "fixed".** The failure mode is a future change that fills the
gaps from whatever bars happen to be nearby -- which is the F0.1 defect rebuilt one layer down.
Historical MAE/MFE for the 199 recovered trades is **unavailable and stays unavailable**; the
Journal says so. `backfill --from=.../\_recovered\_20260904` reporting `unfilled=199` is a
**correct result**, not an outstanding bug.

---

## X6 — the winners' invariant exists but is armed to nothing  *(revised — partially done)*

`assertWinnerInvariant` now exists in `trade-forensics.js:85` and is correct in isolation.
Verified: `pnl $500` against an `mfe`-implied ceiling of `$4.00` returns
`{valid: false, reason: "..."}`; a plausible winner returns `{valid: true}`.

**But grep across the whole repo finds it called from its own test file and nowhere else.**
Not the backfill, not any write path, not `server.js`.

This is the check designed to catch MAE/MFE computed against the wrong bars -- the F0.1 failure
reappearing one layer down where nothing else would notice. Unwired, it is the "armed three weeks
ago, never fired" pattern this repo already has a module about.

**Do:** call it wherever a forensics row is written -- the backfill loop now, and the F1 live-write
when that lands. A violation is refused and records the reason, the same discipline as the F0.1
sanity bound. It must never downgrade to a console warning beside a row that got stored anyway.

**ACCEPTANCE:**
- `grep -rn assertWinnerInvariant` shows at least one **non-test** call site.
- A synthetic trade whose `pnl` exceeds its `mfe`-implied ceiling is **not written**, and the
  reason is reported in the backfill's breakdown.
- The refusal count appears in the backfill summary alongside `filled`/`unfilled`.

---

## X9 — `--from` silently ignores the space-separated form  *(new)*

`scripts/backfill-trade-forensics.js` parses only `--from=<dir>`. Invoked as
`--from <dir>` it silently falls back to the default `DATA/accounts` and reports a confident
`unfilled=36` -- a real-looking answer to a question that was never asked. This is what made
Claude's first re-run disagree with DSH's reported `unfilled=199`.

Same class as X3 and X4: a wrong invocation that returns a plausible number instead of an error.

**Do:** accept both forms, or reject an unrecognised argument with a non-zero exit.

**ACCEPTANCE:** `--from <dir>` either works identically to `--from=<dir>`, or exits non-zero with a
usage message. It never silently reads a different directory.

---

## X7 — `maeUsd` / `mfeUsd` missing

Points only today. The plan requires dollars alongside, using the point value
`point-value-verify.js` already cross-checks against TradingView — never a hardcoded multiplier.
`counterfactual.js:23` currently takes `pointValue` as a caller parameter, which puts the
multiplier in the caller's hands at every call site. That is how a wrong multiplier spreads.

**ACCEPTANCE:** `tradeForensics` returns `maeUsd`/`mfeUsd`, sourced from `point-value-verify.js`,
and `counterfactual.js` reads the same source rather than a parameter.

---

## X8 — the backfill script cannot see the 199 trades

`scripts/backfill-trade-forensics.js` reads `DATA/accounts/<slot>/day_trades.json`. **All five
slots are empty.** The historical record lives only in `DATA/_recovered_20260904/`. The script
therefore reports `filled=0 unfilled=0` and exits 0 — technically passing, actually vacuous.

The acceptance asked it to report **how many trades it could not fill and why**. `0 unfilled` is
not that answer; it means it never looked.

**Do:** add `--from <dir>`. Point it at the recovered set.

**ACCEPTANCE:** run against `DATA/_recovered_20260904/` and print a real breakdown — expect
roughly `unfilled=199, reason='no bars cover the trade window'` today, and a materially higher
`filled` count once X5's Databento backfill lands. **A large `unfilled` count is the correct,
honest result here** — the failure mode is a script that fills rows from bars that do not belong
to those trades.

---

## Minor — fix if cheap, do not block on

- **M1.** `expectancy.js:14` buckets `pnl === 0` as a loss. A scratch drags `avgLoss` toward zero,
  which *inflates* `payoff` for any tag containing one. Bucket scratches separately.
- **M2.** `bar-archive.normalizeBar` drops `volume`. The plan's record shape is `{t,o,h,l,c,v}`.
  Cheap to keep, impossible to recover later.
- **M3.** `trade-tags.js` uses IST calendar midnight for day boundaries; the rest of the app uses
  `dayRollup.tradingDayKey`. Two definitions of "day" will eventually disagree on a trade near the
  rollover, and `tradeIndexOfDay` is exactly where that will show up.

---

# Order

```
X1, X3, X4   silent-failure fixes — small, and they are what make X2/F3 trustworthy
X2           per-day indexing
X6, X7       write-time invariant + dollars (X6 before any live-write, it is the guard)
X5, X8       Databento backfill + the script that reads it — these two together are what
             finally make the historical record measurable
M1-M3        when convenient
```

**One note on sequencing that changed since the original plan.** F0.2 was ordered first because
bars only accrue forward and every lost session was unrecoverable. With Databento GLBX.MDP3 that
constraint dissolves for MNQ and MGC — the history is purchasable. That makes X5+X8 the highest-
leverage pair in this list, because they convert the entire 199-trade record from
"P&L only" into "P&L with MAE/MFE", which is what F3's replay and F4's counterfactuals were
always meant to run on.

---

# COORDINATION — Claude → DSH, 2026-09-05 (end of Claude's pass)

## 1. Files Claude touched. Pull before editing these.

**New (no conflict possible):**
- `app/forensics-report.js` — pure payload builder for the Forensics tab
- `app/test/forensics-report.test.js` — 9 tests, all passing
- `app/renderer/forensics.js` — the tab, presentation only

**Edited — `server.js` is the one to watch, DSH is also in it:**
- `app/server.js` — THREE small insertions only, all additive:
  1. line ~52, one `require('./forensics-report')`
  2. `sendForensicsReport()` inserted immediately **above** `sendWeekReport()`
  3. `case 'forensics-get':` inserted immediately **above** `case 'week-report-get':`
  Nothing existing was modified or moved. If DSH's F1 live-write conflicts, take
  DSH's side of the hunk and re-apply these three — they are independent of it.
- `app/renderer/ws-client.js` — one message case, one `api.forensics()` method
- `app/renderer/index.html` — tab button, `#tab-forensics` panel, script tag
- `app/renderer/app.js` — ONE line in `switchTab`
- `app/renderer/styles.css` — `.fx-*` block appended at the end

`forensics` is deliberately NOT in `CK_GATED_TABS`, matching `week`: a review
surface must open on a day he is not trading.

## 2. THE FIELD CONTRACT — read this before finishing the F1 live-write

The tab already reads these names off each row in
`DATA/accounts/<slot>/day_trades.json`. **Write exactly these names and the tab
lights up with no further UI work.** Write different ones and it will show a
column of em-dashes and look broken while the data is actually present — which
is the X3 defect (two modules built to compose that quietly do not) repeated on
a bigger surface.

```
mae, mfe                 numbers in POINTS, or null + forensicsReason
maeUsd, mfeUsd           X7 — still open
edgeRatio                mfe/mae, null when mae is 0
forensicsTf              which bar size measured it ('1', '5', ...)
forensicsReason          why mae/mfe are null
entryAt, exitAt          ms epoch
hold                     seconds
entryPctOfRange          0..1, NOT clamped — >1 means a break of the session high
post30Mfe, post30Mae, post30Close, post30LeftOnTable
post30Reason             why the post-exit fields are null
playbook, minutesFromSignal, session, dayOfWeek,
isReentry, afterLoss, tradeIndexOfDay, entryIstMin
```

The tab renders any missing value as an em-dash carrying `forensicsReason` /
`post30Reason` as its tooltip. **Never write 0 for "not measured"** — the whole
tab is built around that distinction.

## 3. Still owed by DSH

| Item | Note |
|---|---|
| **X5a** | 1m pull in the existing poll loop. Assigned to DSH because DSH is already in `server.js`. X5b is cancelled — do not build it. |
| **X4 remainder** | Per-trade R derivation, `rSource`, split populations. Nothing populates `t.r` today, so every winner hits `refused`. |
| **X6 arming** | The function is correct and called from tests only. Wire it into the backfill loop and the live-write. |
| **X7** | `maeUsd`/`mfeUsd` from `point-value-verify.js`, not a caller parameter. |
| **X9** | `--from <dir>` (space form) silently reads the wrong directory. |
| **M3** | `trade-tags` day boundary should use `dayRollup.tradingDayKey`. |

## 4. Open questions for Anoop, not for DSH

- `stageRules.funded.sizeCap` was raised 2 → 4 while that block's own comment
  still reads *"Fixed at 2 contracts — not a range"* and lists −$1,717 of losses
  at every size except 2. Value and evidence disagree. **Nobody should change
  this without him saying which he meant.**
- The 11 `stage-rules` test failures encode the superseded "its 2 everything"
  decision. They should assert the NEW invariant (effective cap always within
  2..6 after every overlay), which is a stronger test — but only after the
  funded question above is settled.
- The 4 `week-*` failures REPLAY against `DATA/accounts/s1`, which was reset on
  2026-09-04. Repoint them at `DATA/_recovered_20260904/` — do not delete them,
  they are the only guard that `week-rollup` reproduces a hand-checked week.

## 5. Status right now

Suite: **1,895 tests, 1,880 pass, 15 fail** — the 15 are the pre-existing
`stage-rules` / `week-*` failures above, unrelated to any of this work.

The Forensics tab is wired and tested but **the running server (started 14:49)
predates the handler**, so `forensics-get` currently gets no reply. It needs a
restart, which is Anoop's call, not an agent's.

Coverage on the live `s1` slot today: **0 of 18 trades measured**, 9 priced.
That is the correct and honest state, and it starts improving the session after
X5a lands.
