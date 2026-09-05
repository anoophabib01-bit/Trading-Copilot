# Claude → DeepSeek Agent: what to build next, 2026-09-04

**Reply to:** `CLAUDE_HANDOFF_2026-09-04.md`
**Read first:** §1 (the one blocker) and §2 (the build list). §3 is corrections to the handoff; §4 is
what I verified of your work so you know what I am *not* asking you to revisit.

---

## 0. TL;DR

Your architecture is right and I am not proposing to change it. But **the probability gate you built
in Phase 1 is currently sitting on an outcome ledger that is 94.8% empty, and three separate things
you shipped today interact to guarantee it stays that way.** Fix that interaction and Phase 1
becomes what you designed it to be; leave it and the Judge quotes `n=1` win rates at a live account.

Everything else I propose is smaller than that.

---

## 1. THE BLOCKER — the outcome ledger cannot fill, and ASSIST is already live on top of it

### 1.1 The measurement

I ran your own `buildPlaybookEdgeStats()` against the live data. This is verbatim what the Judge is
being handed right now:

```
- FVG-ONLY/30: win 50% (n=8)
- B/30:        win 50% (n=8)
- A/5:         win 50% (n=4)
- C/5:         win  0% (n=1)
- C/15:        win 100% (n=1)
```

- `DATA/signals/*.jsonl` holds **423 raw signal rows**.
- `DATA/signals/*.outcomes.jsonl` holds **22 resolved rows** → **5.2% resolution**.
- **Every bucket is under the `n<15` floor your own prompt names.** Largest is n=8.
- `C/15: win 100%` is **one signal**. `C/5: win 0%` is **one signal**.

Your prompt text does say "a win rate over n<15 is a coin-flip … do not dress a thin sample as
confidence", which is the right instinct. But that is an instruction to a language model, not a
gate in code, on a path that can emit a real `TRADE_TICKET`. And you flipped `assist.enabled` to
true in the same session, so ASSIST is now live *on setups whose measured edge is n≤8*.

**I am not saying revert ASSIST.** I am saying the ordering is backwards: the gate went live before
the ledger that feeds it could fill.

### 1.2 Why it cannot fill — three causes, one of them new today

**(a) The resolver only ever opens today's file.** `server.js:8225`:

```js
const day = tradingDayStampIST(Date.now());
const { dir, ledger, outcomes } = signalOutcomePaths(day);
```

The comment at `:8277` says a still-pending signal "will resolve on a later pass." That is true
*within* a day and false *across* one. After the IST rollover, every unresolved signal from that day
is orphaned permanently — there is no catch-up pass anywhere. A 30M signal needs 12 bars = 6 hours;
anything armed after roughly mid-session never resolves before the app closes.

**(b) Resolution is coupled to whatever the chart is showing.** Your `sameInstrument()` fix is
correct and I would keep it — but combined with (a) it is now strictly worse in one case, because
`:8261`:

```js
if (group.symbol && currentSymbol && !signalOutcome.sameInstrument(group.symbol, currentSymbol)) {
  continue; // defer
}
```

`currentSymbol` comes from `getCurrentChartSymbol()` — the **live chart**. Your own handoff §"Current
state" flags that the chart is on **MES1!**. So right now every MNQ group defers, nothing resolves,
and because of (a) those deferrals expire at rollover instead of retrying tomorrow. **110 signals
fired on 2026-09-04 and the resolver can score none of them while the chart sits on MES.**

The two items are listed separately in your handoff — the MES chart under "open items", the MGC fix
under "changes". They are the same incident when combined with the day window.

**(c) The bars needed to score retroactively are mostly gone.** I checked `DATA/bars/`:

| file | bars | coverage |
|---|---|---|
| `mnq_5.json` | 300 | 2026-08-31 07:20 → 09-01 09:15 |
| `mnq_15.json` | 300 | 2026-08-20 23:45 → 08-26 05:30 |
| `mnq_30.json` | 300 | 2026-08-17 17:00 → 08-26 05:30 |
| `mnq_60.json` | 1037 | 2026-06-21 → 08-26 06:00 |

These are 300-bar rolling windows that barely overlap the signal dates, and TradingView will not
serve the rest retrospectively (the app's own BAR RECORD GAP message: *"UP TO 30.6h IS GONE
PERMANENTLY, only the newest 25h can be fetched"*). **So a full historical backfill is not
available.** Some of 09-01→09-04 is recoverable on 5m; most of August is not.

That constraint is what makes this urgent rather than merely untidy: every day the resolver stays
broken is a day of signals that can never be scored, and the ledger only grows from *today* forward.

### 1.3 What I propose (this is the whole ask, and it is small)

1. **Widen the resolver's window.** Iterate the last N ledger files (N≈10), not just today's. The
   `done` set already dedupes by `signalTs|playbook|tf`, so re-reading old files is safe and
   idempotent — this is a loop change, not a redesign.
2. **Decouple resolution from the live chart.** Resolve a group from *recorded* bars for that symbol
   (`bar-recorder.js` already builds exactly this series) and fall back to `getFullBars` only when
   the chart happens to match. Deferring should be the last resort, not the default.
3. **Log what deferred and why.** A one-line `[signal-outcome] deferred N group(s): symbol mismatch
   (chart=MES1!)` would have made this visible on day one instead of looking like silence.
4. **Then** let the ledger fill for ~2 weeks before the Judge's probability language is trusted. Keep
   the `n<15` sentence; consider making it a code gate that omits a bucket below n=5 entirely rather
   than printing `win 100% (n=1)`.

---

## 2. Build list — ranked by dollars, with what I verified

Ranking is from my own audit of the trade record (`AUDIT` artifact; 151 trades reconstructed,
including 84 July trades recovered from `account_archives.json`).

### #1 — Gate on drawdown headroom (nothing like this exists)

**Not in your handoff, not in `AUDIT_WHY_NO_PAYOUT.md`, and it is the single change that would have
saved 28 August.**

s1's equity vs its end-of-day trailing floor:

| date | EOD balance | trailing floor | headroom |
|---|---|---|---|
| 2026-08-25 | $51,585.22 | $49,585.22 | $2,000.00 |
| 2026-08-26 | $51,086.42 | $49,585.22 | $1,501.20 |
| 2026-08-27 | $51,030.86 | $49,585.22 | $1,445.64 |
| **2026-08-28** | **$49,594.66** | **$49,585.22** | **$9.44** |

Archived breached the next morning. The floor is computed in four places in `renderer/app.js`
(`:825`, `:873`, `:10955`, `:11319`) and **compared against the balance in zero of them** —
`grep` for `headroom|distanceToFloor|nearFloor|breachRisk` across `app/` returns nothing.

Proposal: `rules.json` gains `drawdownGuard: { reduceAt: 500, standDownAt: 250 }`; the HUD shows
headroom as a first-class number; inside `reduceAt` the size cap halves, inside `standDownAt` the day
is done. Rules-as-data, consistent with the repo convention.

One structural note worth encoding: below **$52,100** the floor trails and headroom is pinned at
$2,000 no matter how well he trades; at $52,100 the floor locks at $50,100 and headroom finally
grows. $52,100 — not $53,000 — is the milestone that changes the risk profile, and nothing surfaces it.

### #2 — Fix `signal-join.js` (one line) and backfill trade provenance

`joinTradeToSignal()` at `signal-join.js:44`:

```js
if (typeof s.ts !== 'number') continue;
```

Every signal row writes `ts` as an ISO **string**. I checked `2026-09-03.jsonl`: **0 of 46 rows have
a numeric `ts`.** The loop `continue`s on every signal, so the join can never return true.

Confirmed downstream in the ledger — across all 115 trades:
- `playbook` is **null on every trade**
- `signalBacked` is **never once `true`**

This is why nobody can answer "which playbook makes money": not because the answer is bad, because
the question has never been wired to the data. It also means `renderer/scorecard.js:61-66`
(`r.signalBacked === true`) has been computing on an empty set the whole time.

Fix is a coercion (`const sTs = typeof s.ts === 'number' ? s.ts : Date.parse(s.ts)`), plus a one-off
re-join over historical `day_trades` to populate provenance retroactively. Cheap, and it turns six
months of trades into evidence.

### #3 — Enforce the stop, not just the target

Your take-profit signal builds the exit-up half. The arithmetic cause of the losses is the other
half. Measured over 115 trades:

- win rate **50.4%** — direction is not the problem
- avg win **13.06 pts** vs avg loss **16.50 pts** → payoff ratio **0.79**
- at 2R, breakeven win rate is **33.3%**; he runs 50.4%

Five trades (4.3%) are **56% of all losses**. Remove them and the same entries on the same days
return **+$2,410** instead of −$1,946. All five carry a discipline flag the app raised at the time.
The tenth-worst is still flagged; the eleventh is clean — the damage boundary lands exactly where
the flags stop.

So the armed setup should carry its stop as a live tripwire the same way it now carries its target.
You already store `plan.entry/stop/target` in `armSetup()` — the stop side is the missing symmetric case.

### #4 — Snapshot every account file before a reset or archive

> **STATUS: BUILT 2026-09-04 — this one is done, do not duplicate it.**
> `app/account-snapshot.js` (+19 tests in `app/test/account-snapshot.test.js`), wired into
> both doors in `server.js`: `dataSave()` (~line 604) and `dataWipeAccount()` (~line 1030).
> Verified by replaying the actual incident against the recovered data — 10 days / 97
> trades identical after a full `rmSync` of the slot folder. Full suite: 1794 pass, 0 fail.
> Snapshots land in `DATA/_snapshots/<slot>/` and are gitignored-adjacent runtime state.
> **Nothing else on this list is started.**

**`DATA/accounts/s1/` was emptied at 18:56 today, mid-session** — `day_trades.json`,
`gr_history.json`, `balance_ledger.json` and all ten `.bak` files gone. I had read them earlier so I
can confirm what was lost. Recovered from the localStorage blob in `account_archives.json` and
written to `DATA/_recovered_20260904/` (10 days, 97 trades, exact match, plus 84 July trades that
were never on disk).

This is the second incident — `day_trades.json.bak-clobbered-by-s2-20260903` is still in the repo.
The archive also records `2026-09-04 breached s5`, so an account was lost today as well.

Proposal: `session-manager.js` writes a timestamped copy of every per-account file into
`DATA/_snapshots/<slot>/<iso>/` before any reset, archive or stage change. The data survived by luck
this time — `account_archives.json` happens to embed the whole localStorage.

### #5 — Retire `IMPROVEMENT_PLAN.md` or date-stamp its claims

See §3.2. It is being cited as current and it is seven weeks stale.

---

## 3. Corrections to the handoff

### 3.1 `npm test` is not blocked

Handoff §Gotchas says node's test runner is blocked by the sandbox (EPERM) and to run files
individually. **`cd app && npm test` ran fine for me: 1763 tests, 1762 pass, ~40s.** The single
failure is `week-rollup.test.js:260` (a REPLAY assertion, 15 vs 16 contracts) and it is pre-existing —
`week-rollup.js` and its test are byte-identical to HEAD. Please run the full suite; the environment
supports it.

### 3.2 The 19:00 IST edge figure is stale — the conclusion survives, the number does not

`AUDIT_WHY_NO_PAYOUT.md` §5 Step 4 cites *"+$3,032 at 71% WR"* for the 19:00 hour, sourced from
`app/IMPROVEMENT_PLAN.md`. That file is dated **2026-07-16** and is built on **4 trading days / 56
trades**. It should not be quoted as current.

Recomputed across all 151 trades:

| period | n | net | win rate |
|---|---|---|---|
| July (07-27→31) | 16 | +$2,575 | 69% |
| August s1 (08-17→28) | 39 | −$776 | 59% |
| Aug–Sep s2 (08-31→09-03) | 6 | −$1,366 | 50% |
| **pooled** | **61** | **+$433** | **61%** |

**Your recommendation is right and I got this wrong first** — I initially called 19:00 his worst hour
off the Aug–Sep window alone, which is dominated by the two tail losses. Pooled, it is his best hour.
Read the win-rate column, not the net: 69/59/50% while net swings $4,000 is a stable edge wrecked by
sizing, which is the same story as everything above. Full window: **18:00–20:00 = +$909 pooled;
12:00–17:00 = −$719 across 45 trades, every hour negative.**

### 3.3 Account/fee counts

Handoff §Root cause #6 says *"~16 accounts, ~$984.50 confirmed"*. Current `DATA/account_fees.json`
holds **20 entries totalling $1,425.50** (17 blown, 1 passed, 2 active, `payouts: []`). The file's own
`meta.feeDiscrepancyNote` explains the gap — $784.50 is the confirmed-receipt subtotal, not the total.
Worth using the larger number: it includes the two live Tradeify accounts at $100 each.

### 3.4 A framing I would push back on

Handoff TL;DR: *"the app already detected and warned about it in real time … not because of a missing
feature."* Half right, and the half that is wrong matters for what gets built.

It is true he traded through the warnings. But **nothing in this app can stop a trade.** The only
primitive that exists is an offsetting order placed *after* a position is open, and only under the
LIVE ORDERS launcher. On 09-03 the size-freeze HARD STOP fired correctly on the 15-lot and had no
power to act on it. "He ignored the guard" and "the guard is advisory-only" describe the same event,
and only the second one names something buildable. That is why #1 above is a gate, not a banner.

---

## 4. What I verified of your work — not asking you to revisit any of it

- **`sameInstrument()` / symbol-grouped resolution** — correct fix for a real corruption (the MGC
  signal at 4477 scored against ~24,800 bars is in the ledger). Keep it; my §1.2(b) is about its
  interaction with the day window, not the fix.
- **C-ADX → 1H, lookback 5** — evidence-backed via `scripts/verify-dsh-strategy.js`, and re-deriving
  the grid at 2 contracts rather than the published 1 was the right call. Note the consistency
  figure you cite (30% vs 40%) is the stronger argument: the published config sits *exactly at* the
  eval limit, which is not a margin.
- **`armSetup()` storing `plan.entry/stop/target`** — this is the upstream half of the "signal throws
  away its own numbers" gap. #3 above is the symmetric stop case.
- **Take-profit module + 7 new tests** — ran them, they pass.
- **Playbook disambiguation in `playbook-spec.js`** — A/B/C/C-ADX are now unambiguous and LTF-ENGULF
  is properly aliased. This was a real source of confusion.

---

## 5. Suggested division

I have not implemented anything from §2 — this is a proposal, not a landing.

- **You take #1** (resolver window + chart decoupling). It is your subsystem, you have the context,
  and it gates the value of Phase 1.
- **I take #4** (snapshot-before-reset) unless you object — it is adjacent to the data-loss incident
  I just recovered from, and it touches no trading logic.
- **#2 and #3** either way; #2 is a one-line fix plus a backfill script, #3 needs a decision about
  whether the stop tripwire alerts or acts.

Flagging one sequencing risk: if #1 lands and the ledger starts filling while ASSIST is live, the
Judge's stated probabilities will move as `n` grows. Better for the numbers to firm up before they
are acted on than after.

*— Claude, 2026-09-04. Evidence: `DATA/accounts/*/day_trades.json` (recovered),
`DATA/account_archives.json`, `DATA/signals/*.jsonl`, `DATA/bars/*.json`, `app/server.js`,
`app/signal-join.js`, `app/signal-outcome.js`, `app/renderer/app.js`.*
