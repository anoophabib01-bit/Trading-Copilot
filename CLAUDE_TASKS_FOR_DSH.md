# Build queue for DSH — everything Claude would build, 2026-09-04

**Contract:** DSH implements, Claude verifies. Every task below has an **ACCEPTANCE** block that is
machine-checkable — write the code, then Claude re-runs the check and confirms or rejects.

**Ordering is by measured dollar impact on the real 115-trade record, not by effort.** T1 is the only
tier that changes whether the account makes money. Everything else protects it or makes it
measurable. If you only do one thing, do **T1.1**.

**One instruction that overrides the ordering:** do not build T1.2 (size cap) without T1.1 (stop).
Measured, the size cap *alone* is worse than the stop alone, and both together are worse than the
stop alone. See the table in T1.2 before touching it.

---

## Reference numbers — every claim below traces here

Recovered from `DATA/_recovered_20260904/` (115 trades, 14 days, accounts s1+s2):

```
as traded                  net −$1,946   EV −$16.92/trade   win 50.4%   payoff 0.74
size cap 2 enforced        net   −$943   EV  −$8.20         win 50%     payoff 0.75
per-trade stop $300        net   +$910   EV  +$7.91         win 50%     payoff 1.17   ← only sign flip
both enforced              net   −$708   EV  −$6.16         win 50%     payoff 0.79
```

Trades that lost more than $300: **5 of 115 (4.3%)**, combined −$4,356. All five carry an
`oversize` or `revenge` flag. Capping those five at $300 is the entire +$2,856 swing.

```
2026-09-03  20c  −$1,718   14s   oversize
2026-08-28   5c  −$1,322  480s   oversize+revenge
2026-09-03   4c    −$526  120s   oversize
2026-08-26  14c    −$484   38s   oversize+revenge
2026-08-17   2c    −$306  894s   revenge
```

Both account deaths, simulated:

| | 28 Aug actual −$1,436 | 3 Sep actual −$2,296 |
|---|---|---|
| size cap 2 | −$701 | **−$433** |
| per-trade stop $300 | **−$414** | −$652 |
| headroom gate $500 | **fires at trade 6 — too late** | **fires at trade 6, headroom already −$296** |

---

# TIER 1 — the only tier that changes the sign

## T1.1 — Enforce a per-trade max loss  ★ highest value in the queue

> **LATCH BUG FIXED BY CLAUDE 2026-09-04 — do not re-fix.**
> `enforcePerTradeStop` latched one shot per DAY and never reset, so on 2026-09-03 the
> $526 loss on trade 4 spent the only shot and the $1,718 on trade 6 went unprotected.
> Replayed against the real record: +$910 became -$508 — a $1,418 cost.
>
> Now latched per POSITION (symbol+side), reset on the flat path, with SEPARATE breach and
> blind shots so a "P&L unreadable" alarm cannot disarm the stop for the rest of the session.
> One flatten attempt per position is preserved, so polling still cannot spam orders.
>
> New file `app/test/per-trade-stop-latch.test.js` (8 tests) pins the exact 09-03 sequence and
> asserts BOTH +$910 (fixed) and -$508 (old behaviour) against `DATA/_recovered_20260904/`,
> so a regression fails loudly rather than quietly costing money.
>
> Suite after: 1829 tests, 1824 pass, 5 fail — all 5 pre-existing (4 = week-rollup/week-store
> REPLAY reading the reset s1 slot, not your code; 1 = T3.1 signal-alert, still open).
>
> **Nothing further open on T1.1.** Nearby and still yours: **T3.1** (its own test fails —
> emits `@ unknown / stop unknown / target unknown`) and the **T4.1 caller** (one argument at
> `server.js:13337`).

`rules.json` already carries `perTradeMaxLoss: 300`. **Nothing enforces it.** This is the single
change that flips the record from −$1,946 to +$910 and it touches 5 trades out of 115.

**Build:**
- A live tripwire on the open position: when unrealised loss on a single trade reaches
  `perTradeMaxLoss` (dollars, at the traded size), fire a loud, un-ignorable alert **and** — under
  the LIVE ORDERS launcher — flatten that position via the same primitive `oversize-guard.js` uses.
- Read the dollar figure from `rules.json`. Never hardcode it.
- The armed setup already stores `plan.stop` (you added this today). Use it as the *price* tripwire
  where a plan exists; the dollar cap is the backstop for trades taken without one.
- It must work when the broker panel is unreadable — if unrealised P&L cannot be read, say so
  loudly rather than failing silent. A blind stop is the failure mode that killed 3 September.

**ACCEPTANCE:**
1. A pure, unit-tested module exposing something like
   `shouldStopOut({unrealisedUsd, perTradeMaxLoss, size})` → `{stop: bool, reason}`.
2. Tests cover: at the cap, past the cap, unreadable P&L (must NOT silently return `stop:false`),
   size 0, and a rules value of `null`/missing.
3. Replay check Claude will run: applying the cap to the 5 tail trades reproduces **+$910 net,
   payoff 1.17** across the recovered record.
4. `node --check app/server.js` clean; full suite still 0 fail.

**Do not** implement this as a chat message only. A message next to a decision already made is what
this repo already has, and it is what failed on 3 September.

---

## T1.2 — Size cap: enforce it, but understand what it does and does not do

**Read this before building.** The cap is a *survival* device, not a profit device:

- size cap 2 alone: **−$943** (still negative)
- per-trade stop alone: **+$910**
- both: **−$708** — worse than the stop alone

Scaling size down pro-rata shrinks the winners too: the 8-lot trades made **+$1,708 at 71% win**.
So the cap must not be sold as, or tuned as, an expectancy fix.

**Build:**
- Enforce the cap at order time, not after fill. Today the only primitive is an offsetting order
  *after* a position exists (`oversize-guard.js`), and only under one launcher.
- The bounded cap already exists: `sizeCap` is user-adjustable 2–6 with a hard ceiling of 6
  (`stage-rules.js: clampSizeCap / enforceSizeCapCeiling`, applied in `getActiveRules()` after every
  other layer). Do not re-derive it; consume it.
- Keep the ceiling un-raisable from the UI.

**ACCEPTANCE:**
1. An attempted order above the effective cap is **blocked or reduced before it reaches the broker**,
   with a test proving it.
2. `stage-rules` tests still pass unchanged (20 exist; do not weaken them).
3. Claude will re-run: `clampSizeCap(20, rules) === 6` and `enforceSizeCapCeiling({sizeCap:20}).sizeCap === 6`.

---

## T1.3 — Give the app the ability to refuse a trade

T1.1 and T1.2 both depend on this and it does not exist. **Nothing in this app can stop a trade.**
The only primitive is an offsetting order after the fact, under the LIVE ORDERS launcher. On
3 September the size-freeze HARD STOP fired correctly on the 15-lot and had no power to act.

**Build:** one refusal primitive that the guards call, with an honest name and an honest failure
mode. If the app genuinely cannot block at the broker, then the primitive must (a) flatten
immediately, and (b) state plainly in the UI that it is *reacting*, not *preventing*, so the
distinction is never blurred again.

**ACCEPTANCE:** a single documented entry point; every guard routes through it; a test that a
blocked order never reaches `trading_place_market_order`.

---

# TIER 2 — make the edge measurable (this is your Phase 1's foundation)

## T2.1 — Widen the outcome resolver's window  ★ unblocks your probability gate

`server.js:8225` opens **only today's ledger**: `const day = tradingDayStampIST(Date.now())`. The
comment at `:8277` says a pending signal "will resolve on a later pass" — true within a day, false
across one. After IST rollover every unresolved signal is orphaned. Result: **423 raw signals,
22 resolved = 5.2%.**

**Build:** iterate the last N ledger files (N≈10). The `done` set already dedupes on
`signalTs|playbook|tf`, so re-reading old files is idempotent. This is a loop change.

**ACCEPTANCE:** Claude re-runs `buildPlaybookEdgeStats()`; resolution rate must rise materially above
5.2% and no duplicate outcome rows may appear (checked by `signalTs|playbook|tf` uniqueness).

## T2.2 — Decouple resolution from the live chart symbol

`:8261` defers any group whose symbol ≠ `getCurrentChartSymbol()`. Your `sameInstrument()` fix is
correct and should stay — but combined with T2.1's day window it means **nothing resolves at all
while the chart sits on MES1!**, and the deferrals expire at rollover instead of retrying.

**Build:** resolve from *recorded* bars for the signal's own symbol (`bar-recorder.js` already builds
this series); fall back to `getFullBars` only when the chart happens to match. Defer last, not first.

**ACCEPTANCE:** with the chart on a foreign symbol, MNQ signals still resolve. Test with a stubbed
bar source.

## T2.3 — Log every deferral with its reason

One line: `[signal-outcome] deferred N group(s): symbol mismatch (chart=MES1!)`. This failure looked
like silence for weeks.

**ACCEPTANCE:** a deferral emits exactly one log line naming the count and the reason.

## T2.4 — Suppress statistically meaningless buckets in the probability block

`buildPlaybookEdgeStats()` currently hands the Judge `C/15: win 100% (n=1)`. Your prompt says
"n<15 is a coin-flip" — that is an instruction to a language model on a path that can emit a real
`TRADE_TICKET`. Make it a code gate.

**Build:** omit any bucket below `n=5` entirely; label 5 ≤ n < 15 explicitly as provisional.

**ACCEPTANCE:** with today's ledger, no `n=1` bucket appears in the block Claude prints.

## T2.5 — Reconcile against the broker before scoring a day

The Judge refused to rule on the breach day because the app said 6 trades / 47 contracts and the
broker said 4 / 41. A discipline score computed on wrong numbers is worse than no score.

**ACCEPTANCE:** a day whose app record disagrees with the broker is flagged `unreconciled` and its
discipline score is withheld rather than published.

---

# TIER 3 — the entry/exit signal he actually asked for

## T3.1 — Make a signal an instruction, not a notification

Today a fired signal produces a chime and "engulf detected". Entry, stop and target are computed
upstream and dropped. You already store `plan.entry/stop/target` in `armSetup()` — carry them
through to the alert.

**Build:** one line, complete: `LONG 2 MNQ @ 29189 · stop 29174 (−15pt/−$60) · target 29219
(+30pt/+$120) · 2.0R · Playbook A 15M · edge n=N`. Direction, size, entry, stop, target, R, and the
sample size behind it. If any field is unknown, say `unknown` — never omit it silently.

**ACCEPTANCE:** every alert on the wire carries entry, stop, target, size, R and playbook, or an
explicit `unknown`. Test on a synthetic fired signal.

## T3.2 — Symmetric stop tripwire on the armed setup

You built `checkLiveTakeProfit()` + a 30s interval for the target side. Build the mirror for the
stop side, using the same interval and the same broadcast channel. This is the live half of T1.1.

**ACCEPTANCE:** an armed setup whose price crosses `plan.stop` broadcasts a `stop-hit` message and
clears the setup, with a unit test mirroring the 5 take-profit tests.

## T3.3 — Filter the heartbeat out of the signal channel

On the breach day the PO3 monitor fired "still inside the opening 4-bar range" ~8 times in ~40
minutes. That is a heartbeat, not a setup, and it trains him to ignore the chime.

**Build:** a state-change filter — announce a phase only when it *changes*, and suppress repeats of
an unchanged state entirely.

**ACCEPTANCE:** replaying `DATA/signals/2026-09-03.jsonl` through the filter produces at most one
alert per distinct phase transition.

## T3.4 — Gate signals to the measured edge window

Pooled across all 151 recovered trades (July + Aug + Sep):

```
18:00 IST  n=12  +$313   58% win
19:00 IST  n=61  +$433   61% win     ← NY open, best hour, most traded
20:00 IST  n=25  +$663   52% win
12:00–17:00  n=45  −$719  every hour negative
```

**Build:** outside 18:00–20:00 IST, mark a signal `outside-edge-window` and require an explicit
override to act. Read the window from `rules.json`, not code.

**ACCEPTANCE:** a signal fired at 14:00 IST carries the flag; one at 19:15 does not.

---

# TIER 4 — protection

## T4.1 — Drawdown headroom gate  *(demoted — read why)*

I originally ranked this #1 on the strength of s1 closing $9.44 above its floor. **I tested it and it
would have saved neither account.** Simulated at a $500 threshold it fires at trade 6 on both death
days, and on 3 September headroom was already −$296 by then. Both accounts opened those days with the
full $2,000 and lost it in one session; a headroom gate only catches gradual cross-day erosion.

Still build it — it is a real last line for a death that has not happened yet — but **after Tier 1**,
and do not let it displace T1.1.

**Build:** `rules.json` gains `drawdownGuard: { reduceAt: 500, standDownAt: 250 }`; headroom becomes a
first-class HUD number; inside `reduceAt` the effective size cap halves; inside `standDownAt` the day
ends.

Also surface this, which nothing currently does: **below $52,100 the trailing floor follows every
gain, so headroom is pinned at $2,000 no matter how well he trades. At $52,100 the floor locks at
$50,100 and headroom finally grows.** $52,100 — not $53,000 — is the number that changes the risk
profile.

**ACCEPTANCE:** a pure `headroomState({balance, floor, rules})` → `{level, effectiveCap, tradingAllowed}`
with tests at each boundary; HUD shows live headroom; Claude re-runs the two death days and confirms
the reported firing points match the table above.

## T4.2 — Daily loss stop that actually stops

`rules.json` has `dailyLossTiers: {yellow −250, red −350, hard −500}` and `dayStop`. These are
displayed, never enforced.

**ACCEPTANCE:** crossing `hard` ends the session in code — no new orders accepted — not just a banner.

---

# TIER 5 — small, do them whenever

- **T5.1** Remove plain-text API keys from `~/.trading-copilot-config.json` (`sk-ant-…`, `gsk_…`, Gemini,
  OmniRoute). Move to env or an OS keystore.
- **T5.2** Reconcile the daily-loss tiers: `Prop Trading/CLAUDE.md` says −250/−350/−500,
  `rules.json` says something else. Rulebook/engine drift is what produced the unenforced size cap.
- **T5.3** Retire or date-stamp `app/IMPROVEMENT_PLAN.md`. It is dated 2026-07-16, built on 4 days /
  56 trades, and its hour-edge table is being cited as current. The conclusion survives the larger
  sample; the numbers do not.
- **T5.4** `DATA/` is fully gitignored, so snapshots and recovered data are local-only. If off-machine
  durability matters, that is a separate decision — flag it, do not silently assume it.
- **T5.5** Delete the stale `.bak` sprawl in `app/renderer/` (`app.js.pre-*.bak` ×9, etc.) now that
  real snapshots exist. Low value, real confusion.

---

# Already done — do not rebuild

| Item | By | Where |
|---|---|---|
| Snapshot-before-destroy (both destructive doors) | Claude | `app/account-snapshot.js` + 19 tests, wired at `server.js:604` and `:1030` |
| `signal-join.js` ISO-string `ts` coercion | DSH | `signal-join.js:44` + tests |
| Size cap bounded 2–6, hard ceiling, server-clamped | Claude | `stage-rules.js`, `rules.json`, `server.js` rules-set |
| Unified today's P&L / trades / break across HUD + panel | Claude | `renderer/day-pnl.js` + tests |
| Take-profit signal + 30s checker | DSH | `app/take-profit-signal.js` |
| `sameInstrument()` outcome fix | DSH | `signal-outcome.js` |
| C-ADX → 1H, lookback 5 | DSH | `rules.json`, `server.js` |
| Left panel rail/flyouts, folded chat messages, week-ahead news | Claude | `renderer/left-panel.*`, `app.js`, `styles.css` |

---

# How Claude will verify

For each task, in order: `node --check` on every touched file → the task's own tests → the full
suite (`cd app && npm test`, currently **1798 tests / 1794 pass / 0 fail / 4 skipped** — that is the
bar) → the task's ACCEPTANCE block re-run against `DATA/_recovered_20260904/`.

Claude will reject a task that: adds a chat message where the ACCEPTANCE asks for an enforcement
action; weakens an existing test to pass; hardcodes a number that belongs in `rules.json`; or
reports success on a path that was never executed.

**Note for DSH:** your handoff says `npm test` is blocked by the sandbox (EPERM). It is not — it runs
here in ~40s. Please run the full suite rather than individual files.

*— Claude, 2026-09-04.*
