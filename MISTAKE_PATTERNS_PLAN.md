# Live Mistake-Pattern Detection — F1-F6 and M1-M6, in detail

Build plan for `app/mistake-patterns.js`. One pattern per pass, each verified
live before the next is started — Anoop's explicit decision (2026-08-19,
reaffirmed 2026-08-20): *"better to ship one pattern working end-to-end and
verified live than all of them half-working."*

The source text for every pattern below is **his own**, written by him, in
`app/renderer/index.html` (the "6 Documented Failure Modes — From Your Own
History" and "Live Mistake Log — Scalping" cards, ~lines 636-660). Detection
code cites it verbatim in its message, never paraphrased into something
softer. If the source text ever changes, the detector's message must change
with it.

---

## The constraint that shapes everything: what a trade record actually contains

`tv-broker-feed.js`'s `fold()` is the only source of live executed trades.
Each entry it pushes is:

```js
// live fold (position observed open, then flat):
{ size, pnl, at }
// poll-aliased round trip — size NOT observed, 0 means "unknown", P&L exact:
{ size: 0, pnl, at, inferred: true }
// backfilled from the broker's order history — P&L sign unknown, but RICH:
{ symbol, side, size, entryPrice, exitPrice, entryAt, exitAt, at, pnl: 0,
  pnlUnknown: true, source: 'backfilled-from-orders' }
```

**CORRECTED 2026-08-20 (review pass — the first version of this table was
materially wrong and was driving the build order).** The two record types have
*complementary* gaps, which the original table missed entirely by describing
only the live-fold shape:

| Field | Live-fold record | Backfilled record | Real status |
|---|---|---|---|
| `pnl` (confirmed $) | ✅ exact | ❌ unknown | split |
| `symbol` | ❌ | ✅ already emitted | **NOT missing** — F5 was wrongly labelled BLOCKED |
| entry time / hold duration | ❌ | ✅ `entryAt` + `exitAt` | **NOT missing** — F4/M4 were wrongly labelled BLOCKED |
| entry/exit price | ❌ | ✅ `entryPrice`/`exitPrice` | **NOT missing** — only *planned* stop/target are absent |
| peak intraday P&L | ❌ | ❌ | genuinely absent, but derivable from the trade array — no new accumulator needed |

So the honest infrastructure task is **not** "add `openedAt`/`symbol` to the
fold" (greenfield). It is **"unify the two trade representations"** — one
record type carrying the broker's times/symbol/prices *and* the fold's
confirmed P&L. That single pass replaces three separate "BLOCKED" passes and
improves F2b from close-to-close to true entry-to-close.

**Rule for this build:** a detector is only written once its inputs genuinely
exist — and "genuinely exist" means *verified against the code*, not against
this document. The original version of this table was written from memory of
the live-fold path and never checked against
`reconstructClosedTradesFromOrders()`; two independent reviewers caught it.
Every existing bug in this feed (fabricated trades from balance drift, 0
trades from a filtered orders tab, size:0 read as "small") came from the same
class of unchecked assumption.

**Prerequisite that outranks every pattern below (added 2026-08-20):** the
balance-delta-at-flat P&L math has still never been reconciled against a real
closed trade with non-zero P&L — `tv-broker-feed.js`'s own header says so.
F1, F2a, F3, F6 and M6 are all pure functions of that number's sign and
magnitude. A wrong "two losses back to back, close the platform" on a day that
had no loss streak does not just fail to help; it burns the only channel any
of this could ever work through. **Reconcile a full day's fold P&L against the
broker's own statement, trade by trade, before building pattern 3.**

---

## Shared design rules for every detector

1. **Pure function, no I/O, no clock.** Signature `check<Name>(trades, opts)`
   → `{ matched, ...evidence, message }`. `opts` carries anything from
   `rules.json` (never hardcode a number that lives there). Same shape as
   `checkTradeCountEscalation` and `size-freeze-guard.js`, so wiring is
   identical every time.
2. **`pnlUnknown` trades are excluded from any win/loss reasoning.** We do not
   know their sign. They still count toward raw trade *count*.
3. **`size: 0` means "not observed", never "small".** Any size-based detector
   must substitute the day's known `maxSize` (the fix already made in
   `size-freeze-guard.js`) or decline to judge.
4. **Advisory only.** Nothing here stops a trade. Promoting any pattern to a
   hard stop is a separate, explicit decision per pattern — the existing hard
   stops (`size-freeze-guard`, day-stop, `trade-confirm-rules`) stay the only
   enforcement.
5. **Fires once per IST day, persisted.** A repeated banner becomes noise and
   noise gets ignored, which is worse than not firing. State lives in
   `tv_broker_feed_state.json` so a restart never re-fires mid-session.
6. **No duplication of an existing hard stop.** Where a rule is already
   enforced (size-up-after-loss, `tradesPerDay`, `maxHoldSeconds`), the
   detector covers only the part the hard stop does *not* — see F2 below for
   the worked example.
7. **Surfaces in three places, automatically**, via the generic
   `mistake-pattern` WS message already built: amber HUD banner + permanent
   chat line (`app.js`), and inside `formatLiveFeedContext()` → every agent
   whose lane includes his record (Jessi, Judge, Scalper, Post-Session).

---

## F1 — Trade count escalation ✅ BUILT 2026-08-19, live-unverified

> *"Trade count escalation — profitable days: 6-12 trades. Blow-up days: 65
> trades, 20% win rate. More trades = more damage. Stop at 2 good trades.
> Done."*

- **Signal:** count of confirmed WINNING trades ≥ 2.
- **Why win count, not trade count:** his own text is about continuing after
  already winning. `rules.json`'s `tradesPerDay` (5) is a separate ceiling on
  volume regardless of outcome — F1 should and does warn well before it.
- **Function:** `checkTradeCountEscalation(trades)`, 10 tests.
- **Live test:** two winning trades in a real session → banner + chat line
  fire exactly once; a third winner does not re-fire.

---

## F2 — Revenge clusters ✅ BUILT 2026-08-20, live-unverified

> *"Revenge clusters — rapid re-entries at same zone, increasing size after
> losses. Two losses in a row = close platform. Non-negotiable."*

Three distinct sub-signals in that text. **The size half is already a hard
stop** (`size-freeze-guard.js`'s `sizeUpAfterLossViolation`, no override) —
re-detecting it here would just double-alert on something already blocked.
F2 therefore covers the two halves nothing watches:

- **F2a — consecutive losses:** the last two confirmed trades both lost. This
  is Risk Protocol rule 08 ("close the platform, stop for the session") and
  4 of 6 blown accounts. Advisory here, deliberately: the *stop* it argues for
  is his decision, and a forced stop on a 2-loss streak is a bigger behavioral
  change than this pass should make unilaterally.
- **F2b — rapid re-entry after a loss:** a trade closes within
  `rules.cooldownMinutes` (15 standard / 5 scalper, read from `rules.json`)
  of the previous *losing* trade's close.
  **Honest limitation:** the feed records close times only, so this measures
  close-to-close. That makes it a strict *lower bound* — a trade that closed
  inside the cooldown certainly also entered inside it, so every match is
  real, but a slow trade entered immediately after a loss is missed. Entry
  timestamps (see the table above) would close that gap; not added in this
  pass.
- **Precedence:** F2a is reported when both match — a loss streak is the more
  serious of the two and its instruction ("close the platform") supersedes.
- **Function:** `checkRevengeCluster(trades, { cooldownMinutes })`.

---

## F3 — Inverted R:R — NOT STARTED (buildable today)

> *"Inverted R:R — avg win $15.75, avg loss $246. Cutting winners, holding
> losers. Use time stop: exit flat if no move in 60 seconds. Never move stop
> away."*

- **Signal (realized, not planned):** with ≥1 confirmed win and ≥1 confirmed
  loss today, fire when `avgLoss >= F3_RATIO × avgWin`. Proposed
  `F3_RATIO = 2` — his documented ratio is ~15.6:1, so 2:1 is a deliberately
  early warning, not a re-statement of the disaster.
- **Data:** available now (`pnl` alone).
- **Open question for Anoop before building:** minimum sample. One $5 win and
  one $200 loss is a 40:1 ratio on two trades — technically the pattern, but
  it may just be one bad trade rather than a behavior. Recommend requiring
  ≥2 wins and ≥1 loss, and stating the counts in the message so he can judge.
- **Explicitly NOT covered:** the "time stop / never move stop away" halves —
  those need entry timestamps and stop-modification events, neither of which
  the feed sees.

---

## F4 — Holding losers 3+ hours — BLOCKED on entry timestamps

> *"Holding losers 3+ hours — MGC Mar 31 avg hold 188 minutes. 5-minute rule:
> if price hasn't moved your way in 5 minutes, exit now."*

- **Signal:** an OPEN losing position held past `rules.maxHoldSeconds`
  (1800 standard / 900 scalper) — this one is most valuable *while the trade
  is still open*, not after it closes.
- **Blocked on:** `openedAt` per trade, plus an open-position hold clock in
  `fold()`. `st.wasFlat === false` already marks "a position is open"; the
  timestamp of that transition is not retained.
- **Prerequisite pass:** add `openedAt` to fold state + trade records
  (survives restart via the existing persistence), with its own tests. Then
  F4 becomes a poll-time check on the open position, not a trade-close check —
  the first detector in this set that fires *during* a trade.
- **Note:** this is the pattern most likely to be worth promoting from
  advisory to something louder, since `maxHoldSeconds` is already a documented
  rule with data behind it (see `rules.json`'s `_maxHoldSeconds_comment`).

---

## F5 — Multi-instrument bad days — BLOCKED on per-trade symbol

> *"Multi-instrument bad days — every blow-up shows MNQ AND MGC same day. One
> instrument per session. Never switch after a loss."*

- **Signal:** two distinct root symbols traded in one IST day. Stronger
  variant: the switch happened *after* a loss.
- **Blocked on:** `symbol` per trade. Cheapest of the missing fields —
  `pollTVBrokerAccount()` already reads `o.Symbol` on every new filled order
  and logs it; it just never reaches `fold()`.
- **Prerequisite pass:** thread the fill's symbol into the fold's snapshot and
  stamp it on the trade record. Watch the root-symbol normalization (`MNQ1!`
  vs `MNQU6` vs `MNQZ5` are the same instrument; a naive string compare would
  fire on a contract roll).

---

## F6 — Winning day turned losing — needs a `peakDayPnl` accumulator

> *"Account was UP then crashed — Account 6: +$937 then gave back $2,637. Lock
> the win. Hit target → stop. A winning day that becomes a losing day is
> Pattern 6."*

- **Signal:** `peakDayPnl` was meaningfully positive and current `dayPnl` has
  given back a material share of it. Two thresholds to lock with Anoop:
  what counts as "was up" (a $20 peak is noise) and what counts as "gave it
  back" (50%? crossing back through zero?). Recommend: peak ≥ the qualifying-
  day figure his own payout rules use (`$150`), fire at 50% givebackzz, fire
  again — the one deliberate exception to the once-per-day rule — if it
  crosses back through zero, because that is a categorically worse state.
- **Blocked on:** a `peakDayPnl` running max in `fold()` (LOW cost, one line
  + tests), which must be persisted or a restart resets the peak and the
  pattern silently stops being detectable for the rest of the day.
- **Relationship to existing code:** the guardrail's day-stop tiers watch
  absolute loss; nothing anywhere watches *giveback*. A day that goes +$400 →
  −$100 never trips a loss tier but is exactly F6.

---

## M1 / M2 — 1M entries, and 1M tunnel vision — NOT detectable from the trade feed

> M1: *"Entering on 1M — banned."* M2: *"Tunnel vision: watching only 1M warps
> your judgment."*

These are about **what he was looking at**, not what he traded. The trade feed
cannot see a chart timeframe.

- **Available signal instead:** `chart_get_state` (already polled by the PO3
  monitor and every context builder) returns the current chart timeframe.
  M1/M2 become a *chart-state* detector, not a trade detector: current TF is
  `1` at the moment a fill lands (M1), or the chart has been on `1` for longer
  than some window (M2).
- **Design consequence:** this belongs in a separate module or a clearly
  separate section — its input is chart state on a timer, not the trades
  array. Do not force it into `check*(trades)`'s shape.
- **M2 caveat worth raising with him before building:** a continuously-firing
  "you've been on 1M for 12 minutes" is exactly the noise rule 5 above warns
  about. Probably a once-per-session nudge, or only when it coincides with an
  open position.

---

## M3 — TF drill-down order (15M → 5M/3M, never reversed) — chart-state, sequential

> *"15M gives direction. 5M/3M gives the entry candle. Skipping 15M means
> you're guessing the direction from the noise layer."*

- **Signal:** the sequence of chart timeframes visited before a fill. If no
  `15` appears in the recent history before an entry on `3`/`5`, the ladder
  was skipped.
- **Needs:** a small rolling log of `{tf, at}` from the existing chart polls.
  Cheap, but it is new state with its own restart/day-boundary semantics.
- **Sequenced after M1/M2** — same input source, and M1 is the simpler first
  proof that chart-state detection works at all.

---

## M4 / M5 — Hold at least 2-3 closed 3M candles / decision-point rule

> M4: *"Exiting after 1 candle because it moved against you is not a decision
> — it's panic."* M5: *"3 consecutive candles OR 1 clear close in your
> direction = decision point."*

- **Signal (M4):** a trade whose hold time is shorter than 2-3 closed 3M
  candles (~6-9 minutes) AND which closed at a loss. A fast *winner* is not
  this pattern — cutting a runner is F3's lane, panicking out of a fresh entry
  is this one.
- **Blocked on:** the same `openedAt` field F4 needs. **Build F4's prerequisite
  once and M4 comes nearly free** — this is the strongest argument for doing
  the `openedAt` pass before any further pattern work.
- **M5 is a decision *procedure*, not an observable outcome.** It describes how
  to make the hold/exit call, and no record shows whether he followed a
  procedure. Recommend M5 stay reference text for the agents (which already
  read it) rather than becoming a detector — flagged here so a future session
  doesn't spend a pass trying to detect the undetectable.

---

## M6 — The Breakeven Trap — needs `openedAt` + session clock

> *"3M + 1M entries → loss → increase size → breakeven → stop for the day.
> This loop wastes hours without real losses — but it IS a loss. Time is
> capital. Fix: 2 losses = done for the session."*

- **Signal:** many trades, hours elapsed, and `dayPnl` hovering near zero —
  the distinctive shape is *high activity, no damage, no progress*. Proposed:
  `tradeCount >= 6` AND `|dayPnl| < $50` AND ≥2 hours elapsed since the first
  trade.
- **Data:** trade count and `dayPnl` exist; elapsed time is derivable from
  `trades[0].at` — so this is **buildable today** without new fold fields.
- **Overlap note:** its "2 losses = done" fix is the same instruction as F2a.
  The *detection* is entirely different (F2a is two adjacent losses; M6 is a
  long flat grind), so both are worth having — but their messages should not
  both fire on the same day saying the same thing. Worth a suppression rule:
  if F2a already fired today, M6's message drops the "2 losses" line.

---

## Recommended build order — REVISED 2026-08-20 after review

The original order (F1 → F2 → F3 → infrastructure → …) was rejected by both
reviewers for the same reason: it schedules seven more detectors on top of an
unverified P&L source, an unchecked data inventory, and an intervention model
that has never been shown to change anything. Revised:

0. **Reconcile fold P&L against a real broker statement**, trade by trade.
   Everything below is a function of this number. Blocking.
1. **Replay harness** — feed recorded poll snapshots + historical order tables
   through `fold()` and every detector, print what *would* have fired on the
   last N sessions. Converts "wait for two real losses in a row" into a
   five-minute check, and answers the F1 false-positive question below with
   data instead of argument. Worth more than any three detectors.
2. **Unify the two trade record types** (see the corrected table above) —
   kills three "BLOCKED" labels at once and improves F2b's precision.
3. **Pattern registry + dispatcher.** Today each pattern costs two hand-copied
   call sites (a gated broadcast in `pollTVBrokerAccount()`, an ungated
   re-check in `formatLiveFeedContext()`); the two have *already* diverged
   after two patterns (F2 has a try/catch, F1 doesn't). More importantly both
   sit inside `if (tradeCount > prevTradeCount)`, which structurally **cannot
   host F4 (open-position hold clock) or F6 (giveback)** — neither fires on a
   trade close. That break arrives at pattern 5 of 9 whether or not it's
   planned for. Registry entries carry `trigger: 'on-close' | 'every-poll'`,
   one severity ranking, and a cap of one banner at a time.
4. **Instrument every fire** with what he did in the following 30 minutes
   (traded again / stopped / sized up). One number decides whether advisory
   detection works at all.
5. **Re-tune F1 with replay evidence** (see the open question below).
6. **F4**, **F6**, **M4**, **M6**, **F5** — in that order, all cheap once 2-3
   land.
7. **Chart-state detection** → **M1**, then **M2**, then **M3**.
8. **M5** — recommend NOT building; reference text only (see above).

### Open question the review raised about F1, unresolved

`F1_WIN_THRESHOLD = 2` on a documented profitable day of 6-12 trades means F1
fires on essentially every *good* day, at trade 2 or 3 — and at that moment a
clean day and a 65-trade blowup day are indistinguishable. That is either
exactly right (his own text says "stop at 2 good trades, done") or the single
largest noise source in the feature, and noise is what makes the whole channel
get ignored. The replay harness (item 1) answers this with his real history
rather than by argument. A reframe worth considering: at 2 wins, show a green
"you've won — bank it" with a one-click flatten-and-stop, not an amber
warning. Behaviourally those are not the same message.

Nothing in this list is live-verified. Every item's real test is a real
session, and per the standing convention, an item is only "done" once Anoop
has personally seen it fire correctly — not when its tests pass.

---

# GSTACK REVIEW REPORT

`/autoplan`, 2026-08-20. Phases run: **CEO + Eng**. Design skipped (no genuine
UI scope — every keyword hit was inside "inform"/"informed"). DX skipped (this
is a personal app, not a developer tool). Codex unavailable on this machine
(binary not installed), so each phase ran `[subagent-only]` — one independent
voice, not two. Consensus columns below say so rather than implying agreement
that was never tested.

Restore point: `~/.gstack/projects/MNQ-CoPilot/master-autoplan-restore-20260820-145527.md`

## Consensus tables

```
CEO — one voice only (codex unavailable)
  1. Premises valid?                    Claude: NO      Codex: n/a
  2. Right problem to solve?            Claude: PARTIAL Codex: n/a
  3. Scope calibration correct?         Claude: NO      Codex: n/a
  4. Alternatives explored?             Claude: NO      Codex: n/a
  5. Success metric defined?            Claude: NO      Codex: n/a
  6. 6-month trajectory sound?          Claude: NO      Codex: n/a

ENG — one voice only (codex unavailable)
  1. Architecture sound?                Claude: NO (breaks at pattern 5)
  2. Test coverage sufficient?          Claude: NO (7 named gaps)
  3. Edge cases handled?                Claude: NO (1 critical, 2 high)
  4. Detector correctness (F1/F2)?      Claude: PARTIAL (1 real bug)
  5. Plan's data claims accurate?       Claude: NO (materially wrong)
  6. Deployment risk manageable?        Claude: YES (advisory-only, additive)
```

## Fixed during this review (code, not just notes)

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | F2a fabricated a loss streak across a trade whose P&L sign is unknown — `loss → (backfilled, maybe a WIN) → loss` reported "2 back to back" and told him to close the platform | HIGH | Unknown neighbour now BREAKS the walk and returns `indeterminate: true` (`mistake-patterns.js`) |
| 2 | F2b measured the re-entry gap straight across an intervening unknown trade, while its message asserted the real gap was "even shorter" | MEDIUM | Adjacency now read off the raw list, not the filtered one |
| 3 | Cross-day contamination: the backfill block stamped today's `dayKeyMs` onto yesterday's state before `fold()` ran, so yesterday's trades/losses could be enforced as today's by `checkTradeAllowed` and `size-freeze-guard` | **CRITICAL** | Explicit unconditional IST-rollover reset at the top of `pollTVBrokerAccount()` (`server.js`) |
| 4 | A rapid-reentry match permanently consumed F2's once-per-day slot, silencing the far more serious consecutive-losses message for the rest of the day | HIGH | Fired-flag keyed per sub-signal (`f2FiredKinds`) |
| 5 | Backfilled records carried `entryAt`/`exitAt` but no `at` — every future time-based detector would silently skip them on a guard it believed was passing | HIGH | `at: exitAt` stamped in `reconstructClosedTradesFromOrders()` |
| 6 | Plan's data-availability table was materially wrong (`symbol`, entry times and prices already exist on backfilled records), which is what produced three bogus "BLOCKED" passes | HIGH | Table corrected; build order rewritten around record unification |

7 regression tests added (477 total, all passing), including a fixture built by
calling the real `reconstructClosedTradesFromOrders()` so the two modules
cannot drift apart silently.

## Open — NOT fixed, needs a decision

- **Backfill can double-count a trade the live fold already recorded** (HIGH).
  When `ordersTableSuspect` delays the backfill past a real close, the same
  round trip lands twice — once with real P&L, once as `pnlUnknown` — and
  `tradeCount` inflates into the `tradesPerDay` enforcement path. F1/F2 are
  immune (they filter `pnlUnknown`); enforcement is not. Fix needs a dedupe
  rule (by `exitAt` proximity, or gate the backfill to round trips closing
  before this instance's first poll) — a judgement call about a live-money
  path, deliberately not guessed at here.
- **Advisory-only is an untested premise** — see below.
- **`formatLiveFeedContext()` goes silent on a TradingView disconnect**
  (MEDIUM), so a persisted, still-true 3-loss streak vanishes from every
  agent's context rather than showing as stale. The Judge can emit a
  `TRADE_TICKET`; silence is worse than staleness there.
- **Backfill timestamp provenance is asserted, not verified** (MEDIUM):
  `tv-broker-feed.js` claims TradingView's order "Update Time" is IST wall
  clock. If it's exchange or browser-profile time, the day-window filter
  admits or drops the wrong day's trades.

## Decisions (Anoop, 2026-08-20, at the /autoplan gate)

**D1 — Advisory-only stays, but gets instrumented.** The reviewers' challenge
(you already wrote F1-F6 yourself and blew 16 accounts holding them, so
"he doesn't notice" may be the wrong premise) is not resolved by argument.
Every pattern fire now needs to log `{pattern, at, dayPnl, tradeCount}` plus
**what happened in the following 30 minutes** — traded again / stopped / sized
up. One number ("fired and he traded anyway", as a percentage) decides whether
advisory detection is worth continuing past pattern 3, or whether F2a should
get real friction (block `handleTradeConfirm`, typed reason, 10-minute timer,
Telegram on clear). Chosen over building the friction now: the lockout gets
imposed on evidence of his own behavior, not on a reviewer's hypothesis.

**D2 — Next passes: reconcile P&L, then the replay harness.** Not F3.
Everything that scores a win or a loss is a function of a fold the codebase
itself marks unverified, on an account whose Balance visibly drifts while
flat. Reconcile a full day trade-by-trade against the broker's statement
first. Then the replay harness, which turns "wait for two real losses in a
row" into a five-minute check and answers the F1-fires-on-every-good-day
question with his own history instead of an argument.

**D3 — Backfill double-count: gated on the first-poll boundary.** DONE
2026-08-20 (`server.js`, `tvBrokerFirstPollAt`). Only round trips closing
before this instance's first poll are reconstructed; anything later belongs to
the live fold. Chosen over exit-timestamp proximity matching because the two
record types stamp their times from different clocks (one of which has an
unverified timezone assumption), so a fuzzy match could silently drop a real
trade. A trade the fold misses now surfaces as a `tradeCountMismatch` banner
instead of a silent duplicate inflating `tradesPerDay` enforcement.
