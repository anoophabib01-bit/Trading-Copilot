# Incident: the oversize guard placed six live sell orders on a stale read

**Date:** 2026-08-31 · **Account:** Tradify 02 (slot `s2`, 50K eval, day 1)
**Severity:** high — autonomous orders were submitted to a live account
**Status:** cause identified, fix written and now loaded

---

## What happened

```
19:25:30  Anoop opens        BUY x5 MNQU6
19:25:33  guard: "oversize seen 1/2 — waiting for confirmation"
19:25:38  guard ACTS         SELL 1   logged "REDUCED 5 -> 4"
19:25:49  ⚠ order-history walk DESYNCED from the positions panel
19:26:14  guard ACTS         SELL 1   logged "REDUCED 5 -> 4"
19:26:54  guard ACTS         SELL 1   logged "REDUCED 5 -> 4"
19:27:33  guard ACTS         SELL 1   logged "REDUCED 5 -> 4"
19:28:08  guard ACTS         SELL 1   logged "REDUCED 5 -> 4"
19:28:43  guard ACTS         SELL 1   logged "REDUCED 5 -> 4"
19:28:43+ "daily intervention cap reached (6) — reporting only"
```

Six times it read `size: 5`, sold one contract, and logged a reduction from 5 to 4.
**The read was stale every time.** The fills were real, so the true position walked
`5 → 4 → 3 → 2 → 1 → FLAT → SHORT 1`. Only `maxPerDay: 6` stopped it going further short.

## Why the safety checks did not catch it

Nothing in the guard was bypassed. Everything passed *on its own terms*:

- **Two confirming reads** — passed. Two stale reads of the same stale number agree perfectly.
- **30s cooldown** — passed. The staleness outlasted it.
- **Reduce-only, never flip** — passed *per order*. It is arithmetic on ONE reading, and
  across six actions on a frozen reading it is simply untrue. Six reductions of 1 reversed
  a 5-lot long.
- **Order verification** — passed. Each order really was submitted and filled.

The invariant that was missing: it has to hold **over the whole episode**, not per order.

## Root cause

TradingView's broker panel stopped re-rendering. The app detected and logged this
three separate times:

> `the account-summary table has FALLEN BEHIND: header balance 49960.1 vs its Net Liq
> 49996 (gap $-35.90) ... Click the Account Summary tab in the broker panel to force it
> to re-render.`

and once:

> `order-history walk is out of step with the positions panel (desynced=true) ...
> Treating its round-trip count as unavailable — the fold falls back to fill-edge
> detection, which can over-count.`

So the position read froze at 5 while the real position drained underneath it.

## Knock-on effects

- **Trade count read 0 all evening.** The feed scores a trade only when the position
  returns to flat. `wasFlat` stayed `false` and `sizeSeenThisTrade` stayed `5`, so no
  round-trip ever closed. `closedRoundTripsScored: 0`.
- **Journal, Insights and Week were empty for the day** — nothing was scored, so nothing
  was written to `day_trades__s2`.
- After the 20:01 restart the feed recovered enough to score **one** trade
  (`size 5, -$61.40`) out of roughly **15 fills**.

## The day's record is contaminated — deliberately not reconstructed

Roughly 15 fills are interleaved between Anoop's own entries and the guard's six forced
sells, against a desynced order history. The stores disagree:

| Source | Says |
|---|---|
| Feed fold (`s2/gr_history`) | 2 trades, **-$62.90** |
| Broker's own session total | **-$4.00** |
| Fills in the server log | ~15 |

**No trade list was reconstructed for 2026-08-31, and none should be.** Separating his
trades from the guard's would require guessing, and a plausible-looking invented trade
list is worse than an acknowledged gap — it would be indistinguishable from real history
next month. Treat this date as *known-incomplete*, not as a clean losing day.

## Fix

`app/oversize-guard.js` gained a `sentQty` interlock: **one outstanding reduction at a
time.** Having sent contracts for a position, it refuses to send more until the position
is *seen* to shrink. If the read never updates it now alarms forever instead of selling
forever — the correct failure direction, because an un-actioned oversize costs what the
market does, while a compounding one costs the account.

The fix was written at 19:39, after the incident. The server running at the time (PID
9004, started 18:08) did **not** have it; it was inert for the rest of that day only
because it had spent all six of its daily actions. The 20:01 restart (PID 13872) loaded it.

## Open items

1. **The stale panel is a TradingView-side fault and is not fixed by a restart.**
   `brokerSummaryStale: true` persisted after the 20:01 restart. Clicking the Account
   Summary tab in the broker panel forces a re-render.
2. **`maxPerDay: 6` deserves review.** Six autonomous orders is a lot of rope for a
   subsystem that has now demonstrated it can act on bad data. The interlock should make
   the cap unreachable in this failure mode, but the cap is the last backstop, not the
   first.
3. **Consider refusing to act at all while `brokerSummaryStale` is true.** The guard
   already knows the panel is behind — it logged it three times — and acted anyway.
   That signal exists and is currently unused by the decision path.

## Related

- `app/oversize-guard.js` — the interlock and its incident comment
- `app/tv-broker-feed.js` — the flat-confirmation fold that stalled
- `app/logs/server-2026-08-31.log` — full timeline, lines 7748–7810
