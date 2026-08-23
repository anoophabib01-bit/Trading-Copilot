# Loop Improvement Research — evidence, gaps, and a gated plan

Written 2026-08-23. Companion to `LIVE_FEED_LOOP_PLAN.md` (what was built) and
`SIGNAL_LOOP_PLAN.md` (the earlier worktree plan).

**Standing constraint from Anoop (2026-08-23):** *"green signal will be given only
when the current setups fail and rebuilding is necessary."* Everything in Part D is
therefore built as **propose-only**. Nothing in this document changes a playbook.
The machinery's job is to prove, on evidence, whether a setup has failed — and to
have the replacement ready and backtested *for the moment you ask*, not before.

---

## Part A — What the TradingView MCP already gives you (and what is unused)

The MCP exposes **86 tools**. The detection loop currently uses roughly a dozen.
The unused remainder is not filler — it contains a complete backtesting pipeline.

### A1. A full backtest engine already exists. It has never been used.

| Tool | What it does |
|---|---|
| `pine_new`, `pine_set_source`, `pine_save` | author a Pine script from the app |
| `pine_smart_compile`, `pine_compile`, `pine_check`, `pine_get_errors` | compile it and read errors back |
| `pine_analyze` | static analysis (already unit-tested in this repo) |
| `data_get_strategy_results` | net profit, win rate, profit factor, max drawdown |
| `data_get_trades` | every backtest trade, individually |
| `data_get_equity` | the equity curve |

**This is the headline finding.** You asked whether the system can backtest setups
"as it has access to all the tools already." It can, today, with **no new
infrastructure**: encode Playbook A/B/C as a Pine strategy, compile it, run it on
the chart, and read exact performance statistics back into the app. The gap is
purely that nothing calls these tools.

### A2. Structured signal reading — the accuracy fix

| Tool | What it unlocks |
|---|---|
| `data_get_pine_labels`, `data_get_pine_boxes`, `data_get_pine_lines`, `data_get_pine_tables` | read the **drawing objects** a Pine indicator emits |

Today, detection re-derives structure (swings, engulfing validity, FVGs) in
JavaScript from polled OHLCV, on every poll. A Pine indicator computing the same
conditions **on TradingView's own bar data**, emitting a label per detection,
turns detection into a *read* instead of a *re-computation*. One definition of a
setup instead of two that can drift — and the same Pine file is then what you
backtest, so **the thing you test is literally the thing that fires live.** That
equivalence is the single biggest accuracy win available.

### A3. Replay — walk-forward and coaching on historical bars

`replay_start`, `replay_step`, `replay_autoplay`, `replay_trade`, `replay_status`,
`replay_stop`, plus `chart_scroll_to_date` / `chart_set_visible_range`.

Lets you step a past session bar-by-bar and watch what the detector *would* have
fired, without waiting for live market hours. This is how a proposed setup change
gets tested against real tape in an evening rather than over weeks.

### A4. Other unused tools worth wiring

- `symbol_info` — **verify tick size and point value programmatically.** MNQ's
  $2.00/point is currently a hardcoded constant validated once against 117 fills.
  It is correct today; it is not *self-checking*, and it silently governs every
  P&L figure. One call removes the assumption.
- `data_get_indicator`, `data_get_study_values`, `chart_manage_indicator`,
  `indicator_set_inputs` — ATR/volume context for the volatility work in C2.
- `alert_create` / `alert_list` / `alert_delete` — **server-side** alerts fire
  inside TradingView even if the app's polling stalls. Cheap redundancy for the
  detection loop, and independent of the CDP bridge being healthy.
- `depth_get` — order-book depth, if you ever want confirmation at the entry.
- `tv_health_check`, `tv_discover` — should feed the 3-step startup check.

---

## Part B — Loop 2 (history / coaching): the payout gap

I researched Tradeify's actual published rules rather than working from the repo's
copy. **The single hard gate between you and a payout is not tracked anywhere in
the app.**

### B1. The Consistency Rule — untracked, and the one config number is wrong

Source: [Tradeify Help Center — Rules: Consistency Rule](https://help.tradeify.co/en/articles/10468320-rules-consistency-rule)

> "no single day's profit ... should exceed a set percentage of the trader's total
> profits over a given period."
>
> `Biggest End of Day PnL / Consistency % = Total Balance Needed`

Published thresholds:

| Account type | Consistency limit |
|---|---|
| Growth Sim Funded | **35%** |
| Select Evaluation | **40%** (evaluation phase only — none once funded) |
| Lightning Funded (bought after 2025-09-12) | **20%** → 25% → 30% by payout number |
| Lightning Funded (bought before) | 20% flat |

**What the repo says:** `rules.json` line 59 — `"consistencyPctMax": 50`.

Two problems, both real:

1. **50% matches no Tradeify tier.** It is looser than every published limit, so
   it would report you compliant while you are in fact blocked from a payout.
2. **It is dead config.** `grep -rn "consistencyPctMax"` returns exactly one hit —
   its own definition in `rules.json`. No code reads it. Nothing computes it.

Your connected account is `TDFYSL50413184562` (read live from the broker panel
today). The `TDFY`+`SL` prefix reads as **Tradeify Select**, which would put you
on the 40%-during-evaluation / none-when-funded track — but **confirm this against
your Tradeify dashboard before any number is wired in.** Do not let me guess your
account tier into a rule file; that is precisely the class of drift that put a
wrong 50 in there.

### B2. Why this matters more than any detection improvement

The consistency rule inverts the intuitive path to a payout. From the source:

> "if your total profit is $10,000, your biggest single-day profit must not exceed
> $2,000" (20% example)
>
> "**losing days can hurt your consistency percentage** ... Losing days reduce your
> total profits (the denominator), which makes your consistency percentage go up."

Consequences the coach should be saying out loud and currently cannot:

- **After a big green day, the fastest route to payout is more *small* green days.**
  A second big day makes the ratio *worse*, not better. This is the opposite of
  what a P&L-maximising instinct suggests.
- **A losing day damages payout eligibility twice** — the loss itself, plus the
  denominator shrinking and pushing your ratio up.
- **One profitable day = 100% consistency = never eligible.** Spread is mandatory.
- Growth Funded also needs **5+ trading days with profit above a floor**
  ($150 on 50k, $200 on 100k), and the day count **resets after each payout**
  ([Growth Funded payout policy](https://help.tradeify.co/en/articles/11083796-growth-funded-account-payout-policy)).

### B3. What to build (Loop 2)

1. **A live payout-eligibility panel.** `biggest winning day / total profit since
   last payout`, against the *correct* threshold for your tier. Plus the derived
   number that actually helps: **"you need $X more profit, spread over ≥N more
   days, with no day above $Y."** That is a direct, mechanical answer to "how do I
   reach payout" — computed, not estimated.
2. **Qualifying-day counter** — days above the profit floor, reset on payout.
3. **Feed both into the Post-Session Analyst and Jessi**, so end-of-day coaching
   is about *payout distance*, not just discipline score.
4. **Fix `rules.json`**: replace the dead `consistencyPctMax: 50` with the real
   per-tier value, and make code actually read it — per this repo's own convention
   that rules are data, never hardcoded.

### B4. Coaching is never scored

Jessi produces advice every session; nothing measures whether following it changed
anything. There is no record of *advice given → was it followed → what happened*.
Until that exists, the coaching half of the history loop cannot improve — it can
only accumulate. This is the same missing-measurement problem as C3 below, and it
has the same fix: write the prediction down before the outcome is known.

*(Also fixed today: the recap rendered a literal `[object Object]` under "JESSI —
ON YESTERDAY" — `sendJessiChat` resolves `{text, answeredBy}`, not a string.)*

---

## Part C — Loop 1 (setup detection): gaps

### C1. Detection and backtest are two different definitions of the same setup

Live detection is JS; any backtest would be Pine. Two implementations of "valid
engulfing" *will* drift, and then your backtest is measuring something that isn't
what fires. **Fix: one Pine definition, read live via `data_get_pine_labels`,
tested via `data_get_strategy_results`.** Same file, both paths.

### C2. No volatility context — but do not assume a filter helps

Playbooks fire identically in dead lunchtime tape and in an expansion. An ATR gate
is the obvious candidate, and there is support for it —

> "trading during low ATR periods increases false breakout rates by 30-40%
> compared to high ATR periods" — [AlfaTactix](https://alfatactix.com/academy/market-filters/atr-average-true-range)

— **but the honest counter-evidence deserves equal billing:**

> "Most regime filters don't improve trading performance ... with a momentum
> signal, a regime filter might not improve average trade quality much — momentum
> already self-selects for trending conditions"
> — [r/algotrading discussion](https://www.reddit.com/r/algotrading/comments/1skdizm/most_regime_filters_dont_improve_trading/)

Your playbooks are structure-based, which plausibly self-selects for volatility
already. So: **do not add an ATR gate on faith.** Measure it with the backtest
pipeline in A1, and adopt it only if it clears the bar in D3. This is exactly the
kind of change that feels obviously right and is worth nothing.

### C3. Nothing scores the detector — this is the foundational gap

> **CORRECTED 2026-08-23, after checking the code rather than trusting this
> document.** The claim below that "detections are broadcast and then forgotten"
> was **wrong**. `signal-ledger.js` exists, is wired, and is unit-tested: it
> writes every watcher fire *and* every Playbook C rejection to
> `DATA_DIR/signals/<date>.jsonl` with the context captured at fire time. And
> `signal-join.js` already matches taken trades back to the signal that armed
> them. I grepped for the wrong symbol names in an earlier session and trusted
> that null result.
>
> **The real gap is narrower and worth stating precisely: selection bias.**
> Signals are recorded, and *taken* signals are scored — but signals Anoop
> skipped are never resolved. Judging a detector on the trades it produced
> judges it on the subset his discretion already filtered, which measures the
> filter, not the detector. Built 2026-08-23 as `signal-outcome.js`: MFE/MAE
> and at-horizon outcome for **every** armed signal, taken or not.

There is no record of *"the detector fired at 14:32 → price did X over the next
N bars."* Detections are broadcast and then forgotten.

**You cannot adapt what you do not score.** Every adaptive ambition in your request
depends on this one ledger existing first, and it is the cheapest thing on this
list: append a row per detection, then evaluate it N bars later.

Fields worth capturing per detection: timestamp, playbook, symbol, timeframe,
direction, price, the AMD phase at the time, ATR at the time, whether you took it,
and — resolved later — MFE, MAE, and the outcome at a fixed horizon.

That ledger is simultaneously:
- the accuracy measurement for Loop 1,
- the training data for any adaptation,
- and the "which playbook actually makes money" attribution Loop 2 is missing.

### C4. Point value is an unverified constant

$2.00/point for MNQ is correct, and was validated against 117 fills. It is still a
constant that governs every P&L figure in the app. `symbol_info` makes it
self-checking. Small change, removes a whole class of silent error.

---

## Part D — The adaptation mechanism (propose-only, per your constraint)

This is how the system earns the right to ask for a green signal.

### D1. Score first (prerequisite — C3)

No adaptation until the detection ledger has been running and resolving outcomes.
Everything below reads from it.

### D2. Declare failure thresholds *in advance*

A setup is "failing" only against a number written down **before** the data
arrives — otherwise the threshold gets rationalised to fit whatever happened.
Per playbook, pre-commit to: minimum sample size, expectancy floor, win-rate
floor, and a maximum consecutive-loss count. Store them in `rules.json`.

Until a playbook breaches its own declared threshold, **the system stays silent.**
No suggestions, no nudging. That is what your constraint requires.

### D3. Only on breach: build and test candidates

When a playbook does breach, the system assembles the case *before* involving you:

1. Encode the current playbook in Pine; reproduce the failure in backtest — if the
   backtest cannot reproduce the live failure, the diagnosis is wrong and it stops
   there.
2. Generate a small number of candidate variants (one parameter at a time).
3. Walk-forward, not a single fit. Optimise on in-sample, evaluate on untouched
   out-of-sample data
   ([walk-forward optimisation](https://algotrading101.com/learn/walk-forward-optimization/);
   [rigorous WF validation framework](https://arxiv.org/html/2512.12924v1)).
4. Apply anti-overfitting discipline
   ([7 tips to avoid overfitting](https://fortraders.com/blog/avoid-overfitting-trading-rules)):
   few parameters, prefer simple rules, require **sensitivity** — a setting that
   only works at exactly 14 and collapses at 13 and 15 is curve-fit, not an edge.
5. Present: what failed, the evidence it failed, candidates, out-of-sample results,
   and an explicit recommendation — **then stop and wait for your green signal.**

### D4. What the system must never do

- Change a playbook parameter without a green signal.
- Propose a change on in-sample results alone.
- Treat a losing streak inside declared tolerance as failure. Normal variance is
  not a signal, and reacting to it is how a working edge gets destroyed.

---

## Part E — External sources, over time

You asked for external inputs so both loops improve as days pass. Three that are
already reachable from this machine:

1. **Economic calendar / news blackout.** The FMP connector exposes `calendar`,
   `economics`, `marketHours`. A high-impact release during a setup is context the
   detector currently has no access to — and "was there news?" is one of the most
   common explanations for a clean setup failing.
2. **Commitment of Traders** (`commitmentOfTraders`) — slow-moving positioning
   context for the weekly review, not for intraday.
3. **Tradeify rule monitoring.** The consistency rules *changed on 2025-09-12*
   (the Lightning tiers were re-tiered). Your config drifting out of sync with
   your prop firm's actual rules has already happened once — that is what the
   wrong `50` is. A Firecrawl monitor on the Tradeify help pages would catch the
   next change instead of discovering it at payout time.

---

## Recommended order (nothing here is started)

Ordered by *payout impact per unit of work*, not by technical interest.

| # | Work | Loop | Why first |
|---|---|---|---|
| ~~1~~ ✅ | Payout eligibility tracking + fix the wrong/dead `consistencyPctMax` | 2 | **BUILT 2026-08-23** — payout-eligibility.js, 23 tests against the firm's own worked examples. |
| ~~2~~ ✅ | Signal outcome resolution (C3 — ledger already existed; the gap was selection bias) | 1 | **BUILT 2026-08-23** — signal-outcome.js, 18 tests. |
| ~~3~~ ✅ | `symbol_info` point-value verification | both | **BUILT 2026-08-23** — point-value-verify.js, 9 tests. Fixed a live MCP bug: symbol_info threw on every call. |
| 4 | Pine-based single definition + `data_get_pine_labels` | 1 | Makes live detection and backtest the same thing. |
| 5 | Backtest harness on `data_get_strategy_results` | 1 | The capability you asked for; mostly wiring. |
| 6 | Per-playbook attribution in the recap | 2 | Falls out of #2 nearly free. |
| 7 | Failure thresholds in `rules.json` + propose-only pipeline | both | The green-signal machinery. Needs #2 and #5 first. |
| 8 | ATR/volatility context — **measured, not assumed** | 1 | Only after #5 can tell you whether it helps at all. |
| 9 | News/calendar context | 1 | Useful; least certain payoff. |

Items 1–3 are independent of each other and of everything else. Item 8 is
deliberately last: it is the change most likely to feel productive and turn out to
be worthless, and #5 is what would prove it either way.

**Items 1-3 are built (2026-08-23); 4-9 are not started.** Say which you want next.

**Open question, blocking nothing but worth settling:** `rules.json`'s
`payout.accountFamily` is set to `select`, inferred from the live account id
`TDFYSL50413184562`. Confirm it against your Tradeify dashboard — an inferred
tier quietly becoming fact is exactly how the wrong `50` got into the config.
If it is wrong, change that one value; every threshold follows from it.
