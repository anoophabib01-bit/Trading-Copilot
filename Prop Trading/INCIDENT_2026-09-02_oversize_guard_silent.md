# INCIDENT 2026-09-02 — the oversize guard was silent through a real 5-lot

## What happened

Anoop opened **5 contracts against a cap of 2**. The guard did nothing. It did
not reduce, it did not alarm, it did not log a stuck read. It produced **no
record of any kind** — `DATA/protocols/oversize-guard.jsonl` has no entry for
2026-09-02 at all.

This was not the alarm-only case. `/health` at the time:

```
tradingview: { bridgeReady: true, tvConnected: true, liveOrdersEnabled: true }
```

The guard was armed, `rules.json` had `oversizeGuard.enabled: true`, and
`TV_ALLOW_LIVE_ORDERS=1` was set. It could have sent the reducing order.

## Why

**It read the 5 as a 1.**

Tradovate's positions grid carries a **Position ID** column — it renders one row
**per position**, not one net row per symbol. Three independent readers all took
the *largest row* instead of the *sum*:

| Where | Code |
|---|---|
| `server.js` `largestPosition()` | `if (!prev \|\| abs > prev.size)` |
| `server.js` fold `openSize` | `positions.reduce((m,p) => Math.max(m, \|Qty\|), 0)` |
| `position-events.js` `indexBySymbol()` | `if (!prev \|\| r.qty > prev.qty)` |

Five 1-lot scale-ins therefore read as `1`, which is inside the cap, so the guard
correctly concluded there was nothing to do. Every store in the app agreed with
the wrong number: `tv_broker_feed_state.json` `maxSize: 1`, both session-log rows
"size 1", the position watch "OPENED LONG 1 MNQU6".

`position-events.js` even carried the comment *"the larger quantity is the safer
one to report (never under-state size)"*. True when comparing two readings of one
position. False when the rows **are** the position.

**The guard only ever worked for a position entered in a single order.** That is
why 2026-08-31 (`size: 5`) and 2026-09-01 (`size: 8`) fired correctly — those
were single orders, one row each. Nothing anywhere said the scale-in case was
unhandled.

## The second fault: it could not be seen

Two silences made this invisible rather than merely broken.

1. **`pollTVPositions` returned bare on an unreadable positions table.** No log,
   no broadcast, no notification. An unreadable table is indistinguishable from
   a flat account, so the guard could be blind for an entire session with
   nothing saying so. The integrity protocol caught the panel unmounting at
   14:36 IST that same day — and its auto-repair reported `success=false`.
2. **The renderer had no handler for `oversize-guard` at all.** The server had
   been broadcasting guard evidence since 2026-08-28 into a listener that did
   not exist. The only surface the guard ever had was a `console` line in a
   window Anoop never has open.

So "armed and watching" and "armed and blind" looked identical from outside, and
the one guard that can act on the account unasked had no way to be questioned.

## Fixes

**Reading** — the row arithmetic moved into `oversize-guard.js` as
`netPosition()`, summed **per (symbol, side)**, unit-tested next to the decision
that consumes it. `server.js` now aliases it and a wiring test asserts there is
no second copy. Bounds on the summing, both load-bearing:

- Never across symbols. Two 2-lot positions in different instruments are two
  trades at the cap, not one 4-lot breach — unchanged.
- A symbol showing **both** directions is a hedge whose net direction cannot be
  named, so it returns a **blank side**, which `evaluate()` already refuses.
  Guessing there would send an order the wrong way.
- A row whose qty will not parse is skipped and **counted** (`unparseableRows`),
  never assumed. That can only under-count — the direction that fails toward
  doing nothing.

Everything downstream is untouched: two confirming reads, one outstanding
reduction, the cooldown and the daily cap all still apply to the summed size.

**Seeing** — `noteOversizePositionRead()` runs on every tick. Three consecutive
unreadable reads (~15s) raise a **BLIND** alarm: console, UI banner, Telegram,
and a `mode: "blind"` line in the evidence log. Recovery is announced too.

**Stating** — a titlebar chip that is *always* rendered and always names the
state in words: `ARMED` / `ALARM-ONLY` / `BLIND` / `STUCK` / `OFF`. A missing
status reads **unknown**, never "armed" — claiming a protection we cannot
confirm is the failure this exists to end. Clicking it toggles a session-only
switch; turning it **off** is confirmed and announced, turning it back **on** is
one click. It never writes `rules.json`, so a disarm cannot outlive the session.

**Checking** — a new `oversize-guard` check in `feed-protocol.js`. The protocol
had asserted on every feed the guard *reads* and never on the guard itself; on
this day `panel-tables` passed all session while the guard was blind.
`alarm-only` is deliberately **not** a failure — it still shouts, and flagging it
would train him to ignore the line.

**Evidence** — every action now records `rowCount`, `mixedSides` and
`unparseableRows`. Without `rowCount` a 5-lot read as `1` and a 5-lot read as `5`
looked the same in this log, which is precisely why this went unnoticed.

## Still unconfirmed

The multi-row hypothesis is inferred from the Position ID column and from every
reader reporting 1 while 5 were held — **not** from a captured live read of a
scaled-in position. `rowCount` in the evidence log is what will confirm it: the
next time a position over 1 lot is open, `rowCount > 1` proves the grid splits
rows, `rowCount == 1` means the cause is elsewhere and this needs reopening.

## Tests

`test/oversize-guard.test.js` 36, `test/oversize-wiring.test.js` 18,
`test/feed-protocol.test.js` 23. Full suite 1537 passing.
