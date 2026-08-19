# Trust Protocol

**Written 2026-08-12, at Anoop's instruction, after an audit found real defects
in code I had shipped that morning and told him to trust over his own judgement.**

The request was: *"build a protocol inside the app that can help me trust you."*

A protocol that asks you to trust me is worthless. This one is designed so you
**don't have to**. Every rule below is either enforced by code or verifiable by
you in under a minute.

---

## The failure this exists to prevent

On 2026-08-10 an agent was asked about your last five trades, had only
day-level totals, and invented a five-row table of P&L that exists nowhere.
You were shown it as fact.

On 2026-08-12 I wrote `chart-reads.js` *specifically* to stop a model guessing
at candles — tested the arithmetic, wrote 20 tests, and never validated the
inputs. An audit found that one malformed bar from the TradingView feed
produced an EMA of **65,750,116.55** (a plausible-looking wrong number, not an
obvious NaN), and that NaN inputs produced a **reported Doji that never
printed**.

Both are the same bug: **a component stating something it could not actually
verify.** Not lying — worse. Being confidently wrong, in a format that looks
identical to being right.

---

## Rule 1 — No component may state a number it cannot verify

Enforced in code, not by convention.

| Component | Behaviour when the input is bad |
|---|---|
| `chart-reads.js` | Returns `null`. Every price must be a finite number and `high >= low`; `period`/`leftRight` must be positive integers. One bad bar refuses the **whole series** — a poisoned EMA is worse than a missing one. |
| `loss-ratchet.js` | Falls back to the normal daily stop. Never returns "no cap". |
| `volume-budget.js` | A missing or zero cap reads as *off*, never as *instantly breached*. |
| `provider-chain.js` | `null`/garbage config degrades to Gemini instead of throwing. Unknown provider names no longer silently become `gemini`. |
| Debate agents | Given a blunt no-invention header directly above the data, plus an explicit "you have NO TOOLS, ignore any instruction to fetch." |
| The Judge | **Data-integrity halt**: if two agents report different numbers for the same trades, the verdict is forced to NO-GO and declared untrustworthy. It may not average, reconcile, or proceed. |

**A missing read is recoverable. A confident wrong read is what loses money.**

---

## Rule 2 — Verification means execution, never inspection

`node -c` proves syntax. It proves nothing about behaviour. Both bugs that
nearly shipped today passed it:

- `atomicWrite` required at line 3481, **after** the functions using it
- `providerChain` required **nowhere at all** — undefined at runtime
- `reqStartedAt` referenced but never declared

Every one would have thrown on a real request. So the standard is:

1. `npm test` — currently **135 tests**
2. Load every module and confirm it resolves
3. Exercise the actual behaviour — replay a real stream, kill a process
   mid-write, race an abort against a timer
4. For anything touching your data: **replay it against your real trade history**

That last one is not ceremony. Replaying the loss ratchet against your real days
is what found that it was reading a **stale data source** — `gr_history` had one
entry from 08-05 while `balance_ledger` had five days through 08-11. The unit
tests all passed. Your data caught it.

---

## Rule 3 — Corrections are louder than claims

When I get a number wrong, the correction leads.

Today I told you the loss ratchet would have saved **$722** on 08-10. That
assumed it could stop you *at* the cap. It cannot — no rule closes a position
that is already open. The honest figure is **$413.50**. I corrected it
unprompted, and the replay script that produces it is in the repo so you can
re-run it yourself.

I also claimed your five days "split perfectly" on contract count. They don't —
08-05 sits exactly **on** the 12-contract line. A test caught the overstatement
and the test now documents the real behaviour.

---

## Rule 4 — Independent audits are welcome and get verified, not accepted

The 2026-08-12 audit was run by a different model. I did not take it on faith:

- **C2** (null config → TypeError) — reproduced. Real. Fixed.
- **H5** (NaN propagation) — reproduced, and **worse than reported**: not NaN, a
  plausible wrong number. Fixed.
- **H7** (float period) — reproduced, and **worse**: a crash, not a mis-seed. Fixed.
- **C1** (NaN port) — **the audit was wrong.** The live code already reads
  `u.port ? parseInt(u.port, 10) : 80`. Not "fixed", because it was not broken.

Reporting the audit's error matters as much as fixing its findings. An audit you
accept uncritically is just a second opinion you also can't check.

---

## Rule 5 — Changes are small, and verified before the next one starts

Broken on 2026-08-11/12: roughly forty changes went to disk without a single
restart. If any had misbehaved, nothing could have identified which.

The rule now: **one change, restart, verify, then the next.** This is also why
the `server.js` and `renderer/app.js` refactors (audit items #2/#7) are HELD —
they are 12,600 lines of restructuring with zero user-visible benefit, and every
extraction that *did* earn its place (`chart-reads`, `provider-chain`,
`atomic-write`, `loss-ratchet`, `volume-budget`, `anthropic-native` — 810 lines,
8 test files) happened because it bought testability.

---

## Rule 6 — What the app must never do, regardless of instruction

1. Execute a trade. `BLOCKED_TOOLS` in `groq-agent.js` refuses
   `trade_submit`/`trade_open_limit`/`trade_dismiss` even if a model asks.
2. Show **GO** on stale or absent chart data. Disconnection and staleness are
   hard NO-GO, ranked with the daily stop.
3. Present a hand-typed P&L as broker-verified. The HUD labels it
   `manual — unverified`.
4. Talk you into a trade. The coaching protocol permits encouragement toward
   calm and patience, never toward entry.

---

## How to check me in 60 seconds

```
cd G:\MNQ-CoPilot\app
npm test                       # expect: 135 pass, 0 fail
node -e "require('./server.js')" # (or just restart the app)
curl http://localhost:7433/health
```

`/health` reports the live provider, the full fallback chain, which keys are
configured (never their values), bridge-vs-CDP state separately, and monitor
counts.

And the number that matters most: **`DATA/token-usage.jsonl`**. If it does not
exist, nothing has actually run, and no claim about this app has been tested in
reality — including mine.

---

## The honest bottom line

I will make more mistakes. The three P0 defects fixed today were all in code I
wrote hours earlier and had already told you was tested.

What changed is not my reliability. It is that the app now refuses to state
things it cannot verify, the tests cover malformed input rather than only clean
input, and every claim I make about your money is replayed against your actual
trade history before I make it.

**Don't trust the app. Check it.** These rules exist to make checking cheap.
