# Build queue for DSH — HTF gate + broker feed fixes, 2026-09-08

**Contract:** same as `CLAUDE_TASKS_FOR_DSH.md`. DSH implements, Claude verifies. Every task has a
machine-checkable **ACCEPTANCE** block.

**Source:** a 14-agent audit of the five watcher/bias areas, run 2026-09-07/08. Six findings came
back CRITICAL.

**Verification status — read this.** The load-bearing claim in every P0/P1/P2/P3 task was
re-executed by hand against the working tree on 2026-09-08 and is marked ✅ below. The rest come
from the audit agents and are marked ⚠ — they were internally consistent and cited real files, but
**re-grep before you edit**. One line number had already drifted between the audit and this file
(G18: 14043 → 14063).

```
✅ G1  server.js armSetup('A') omits bar — read the call, confirmed; setupId sits one line above
✅ G2  trading.js getPositions returns success:t.found and DISCARDS the `visible` it computes
✅ G3  server.js `if (rows) {` — [] is truthy; caller passes null only on a MISSING table
✅ G5  server.js `if (!bGate.allowed) { mon.pending = null; return; }` — verbatim
✅ G6  grep -rn "htf-reject" app/renderer/  →  0 hits
✅ G9  grep -c perTradeMaxLoss trade-confirm-rules.js  →  0
✅ G10 the MGC engulf-fire row is on disk: 4477.10 / 4461.70 = 15.40 pt on COMEX_MINI:MGC1!
✅ G11 grep -c minRiskPoints playbook-spec.js  →  0
✅ G12 grep -c "state.htf" renderer/app.js  →  0
✅ G18 TELEGRAM_ENABLED = false  (server.js:14063, NOT 14043)
✅ G19 rules.json playbookCAdx.tfCode == "60" while cadx-status.js hardcodes "30M"
⚠  G4, G7, G8, G13-G17, G20-G22 — agent-reported, spot-check before editing
```

All *measured numbers* (ledger counts, rejection rates, the 260-instant replay) come from the
agents. They reproduced `htf-alignment.js`'s own published header figures to within 2pp, which is
the main reason to trust the replay harness — but they are not independently re-derived here.

**These are fixes to code that already exists and is wrong.** None of them is a feature. Nothing
here adds a playbook, a detector or a number that Anoop has not already set in `rules.json`.

**Scope:** G1-G7 are the seven CRITICAL/HIGH findings. G8-G22 are the remaining audited gaps —
money-path risk (G8-G11), the bias contradiction (G12-G14), and feed/gate liveness (G15-G22).
**G23-G25 were added 2026-09-08 after verifying DSH's first pass** and did not come from the audit.
Everything the audit found is in here. Two things are deliberately NOT built and both are listed
with their reason under **Not to be built** — read that section before starting, because one of
them (the C-ADX entry redesign) is the thing Anoop originally asked for and it is blocked, not
forgotten.

**Task numbers are stable identity, tiers are execution order.** G-numbers were assigned in the
order the audit surfaced findings and are referenced from the ordering graph, the UI section and
`DATA/signals` commit messages — **do not renumber them.** The tier a task sits in is where it gets
built. That is why G10 is filed under P1 and G8/G9/G11 under P5 despite all four being risk fixes.

---

## The one-paragraph version

The app went blind on a live position on 2026-09-07 and reported healthy while doing it (G2, G3).
The most-used playbook has been arming setups with no trade plan since it was written, so its
live take-profit wiring has never been able to fire (G1). The HTF gate that holds Playbook B and
C-ADX is refusing 96% of setups because it *cannot read the chart*, not because they are on the
wrong side (G4) — and when it refuses, Playbook B deletes the setup and says nothing (G5), the
block never reaches the UI (G6), and the ledger row that measures it is written 9.2× too often
(G7). Four of these seven are the reason Anoop says "most of the current watching does not trigger."

---

## ORDERING IS FORCED. Read this before picking a task.

```
  G2 ──▶ G3           G3 consumes the signal G2 exposes. Ship together or G3 has nothing to test.
  G10 ──▶ G1          ★ G1 currently MASKS the MGC mispricing. Fixing G1 activates it the same day.
  G16 + G7 ──▶ G6     ★ G7's dedup key IS htfLastBarMs, which G16 stops nulling. See below.
  G8 ──▶ G11          Same shared riskGate module. Do not build it twice.
  G12 ◀── G13, G14    All three read the same htf-status broadcast; G12 introduces `state.htf`.
  G5, G4              independent of the above
```

> **★ Added 2026-09-08 after verifying DSH's first pass.** G7 shipped and works, but it keys its
> dedup on `blockBar = htfLastBarMs || null`, and `server.js:9603` sets `htfLastBarMs = null` on a
> FAILED read — which is precisely the clobber G16 exists to fix. So during a TradingView outage
> `blockBar` is `null`, the key stops changing, and **every block for the whole outage collapses
> into a single ledger row** — losing the evidence that it persisted. **G16 must land with or before
> G7 is considered done**, and G6 must not ship until it has, or the HELD row inherits the same
> blind spot.

**P0:** G2 + G3 — live-money safety, ship as ALARM ONLY first.
**P1:** G10 then G1 — land outside a live session.
**P2:** G7 then G6.
**P3:** G5.
**P4:** G4 — scoped to C-ADX at the shadow rung and nowhere else.
**P5:** G8 → G11, then G9 — money-path risk.
**P6:** G12 → G13 → G14 — the bias contradiction.
**P7:** G15-G22 — feed and gate liveness. **G16 is promoted: it now blocks G7/G6** (see ★ above).
**P8:** G23-G27 — found while verifying the first pass; the app disagreeing with itself.
**G26 DONE (2026-09-09)** — self-heal size-wildcard fix landed, full suite 1928/1928 including the
live-data replay. **G27 is new (2026-09-09)**, low-risk, additive-only: widen the FRED blackout list
now that the key is live. Not urgent, but cheap and zero-risk — the safety model can't be violated
by this task by construction (see G27's own note on `cli/README.md`'s boundary).

> **★ The one trap in this queue:** G1 (Playbook A has no plan) is why the MGC mispricing (G10) has
> never bitten — no plan means no order row and no risk figure. **Ship G10 first or the same day**,
> or the first gold engulf after G1 lands will be risk-priced at one fifth of reality and
> `autonomyModes.checkOrderRisk` will clear an order it should block.

---

## Reference — measured facts, do not re-derive

Ledger totals across `DATA/signals/2026-*.jsonl` (514 rows):

```
playbook   B 172 · PO3 113 · C-ADX 76 · C 65 · FVG-ONLY 48 · A 40

htf-reject rows            83   →  9 distinct (playbook, tf, direction, bar) setups   = 9.22x
  htf-15m-unclear          76      of which C-ADX: 76 rows = 3 setups                 = 25.3x
  setup-against-htf-bias    5      max rows for one setup 30, median 1
  htf-1h-unavailable        2

sfp-raid rows             113   ← "waiting for confirmation" promised to the user
playbook-b-confirm          9   ← delivered
engulf-fire rows           15   (13 carry entry+stop)
Playbook A rows in shadow/ + assist/orders.jsonl     0
entire order ledger                                  4   (B x3, C-ADX x1)
stop-hit / take-profit-hit rows, ever                0
```

15M structure read on the real 300-bar set (`DATA/bars/mnq_15.json`, 261 windows at the 40-bar
window `readHTFNow` actually feeds): **bull 40.2% / bear 31.0% / unclear 28.7%**. This reproduces
`htf-alignment.js`'s own header figure of 71.3% clean — the module is behaving as designed. The
defect is in what the callers do with `unclear`, not in the classifier.

On 2026-09-04 all 76 C-ADX rejects ran **03:31:27Z → 08:59:06Z, 5h28m continuous** — every row
`playbook C-ADX / tf 30 / direction BULLISH`, and **every row carried `structure1h: 'bullish'`**.
A long-only playbook, blocked for five and a half hours, while the 1H read cleanly in its favour.

---

## UI CHANGES — every screen this queue touches, in one place

Twelve of the twenty-two tasks change something Anoop sees. He trades live off these panels, so
**no UI change in this queue lands mid-session**, and three of them are `CLAUDE.md`
**Prompt/LLM changes** requiring the manual smoke test (step 3) before merge.

| Task | Surface | Today | After |
|---|---|---|---|
| **G6** | Chart Watchers / signal feed | blocked setups are invisible | a **HELD** row, styled distinctly from a fire — *status row, last-value-wins, NOT a chat append* |
| **G6** | Scorecard (`renderer/scorecard.js`) | drops 124/514 rows = 24.1% | `C-ADX` + `FVG-ONLY` counted; **new `htfBlocked` column**, `rejected` unchanged |
| **G8** | Armed-setup card | no risk figure of any kind | dollar risk + `over-per-trade-max` flag |
| **G9** | Trade ticket card | Stop is a free-form input, no risk shown | **dollar risk rendered before Confirm** |
| **G12** | GO/NO-GO badge | blind to the 15M gate | soft reason line: `15M gate: NO BIAS — B and C-ADX are held` |
| **G13** | PO3 phase card | `4H bias: WEAK BULL` | `1H bias: WEAK BULL` *(it was always a 1H read)* |
| **G13** | Chat — `BIAS CHANGED` | claims authority it lacks | `BIAS CHANGED (4H reference read — this does NOT gate the watchers)` + the gate's current side |
| **G14** | Framework Steps | starts at "4H bias" | **new step 0 "15M gate"**; step 1 → "4H bias (reference)", step 2 → "1H (evidence)" |
| **G16** | HTF chip | `HTF NO BIAS` while TV is down | **`HTF FEED DOWN`** as a distinct third state |
| **G17** | Chart Watchers health dots | green until 3× the bar period | **amber at 2× + settle**, red at 3× |
| **G18** | Settings → Telegram | a live token input that does nothing | disabled-state note; input no longer implies it works |
| **G19** | C-ADX watcher row | `Playbook C (ADX) 30M` | label from `cfg.tfLabel` → **`1H`** (it has been on 1H for five days) |
| **G20** | HTF hourly evidence line | silent about bar count | `read from 26 of 40 requested 15M bars — degraded` |
| **G2/G3** | Live-feed self-test + oversize status | reports **3/3 PASSED** while blind | a real FAILURE, and the BLIND alarm can actually fire |

### What Anoop will notice on day one

1. **The watchers will look busier without firing more.** G6 makes ~83 historical blocks visible for
   the first time. That is the point — but tell him, or it reads as new noise. **G7 must land first**
   or a single block renders 30 times.
2. **The GO/NO-GO badge will sit at PENDING more often** (G12). Measured: the gate was refusing or
   inverted in 59.8% of current "GO" moments. This is a *soft* reason only — it must never flip
   GO→NO-GO on its own.
3. **The C-ADX row will say 1H, not 30M** (G19). Nothing changed in behaviour; the label was wrong.
4. **Dollar risk appears on the ticket and the armed-setup card** (G8, G9) where there was none.

### Prompt/LLM changes — `CLAUDE.md` step 3 applies

**G12** (the badge string feeds `buildContextMessage()` → Jessi), **G13** (both chat strings), and
**G14** (the step grid Jessi reads). Per `CLAUDE.md`: read the diff aloud as the persona receiving
it, check every number against `rules.json`, and **paste the actual observed response into the PR**.
A prompt change with no observed response is unverified.

### UI work explicitly NOT in scope

- **The pre-trade CHECKLIST** (`index.html:1035`, *"4H and 1H in the same direction"*) and
  `bias-tracker.js`'s adherence matrix still encode the 4H/1H doctrine. G14 changes the Framework
  Steps only. **Deciding the checklist is a separate call for Anoop** — see G14.RISK. Do not
  silently migrate `ck_history.json`.
- **No new tab, panel or chart.** Every change above writes into a surface that already exists.

---

# TIER P0 — live-money safety

## G2 — An unrendered positions table reads as FLAT  ★ do this first

`getPositions()` returns `success: t.found` — true whenever the `<table>` element exists in the
DOM, regardless of whether ka-table rendered any body rows. TradingView renders body rows only for
the broker sub-tab currently showing, so a hidden Positions tab returns
`{success: true, count: 0, empty: true, emptyStateText: null, positions: []}` and the server
derives `isFlat` from it.

**The fix for this already exists in the same file, applied to the wrong table.**
`server.js:11861-11886` spends sixteen lines documenting this exact fallacy and builds a row-level
`ordersRendered` test for the ORDERS table, then leaves `positionsOk = !!(result.positions.success)`
unfixed on the line immediately above it.

**All three detectors that could catch it key on `openPositions > 0`** — precisely the number a
blind table zeroes. `ordersRendered` (server.js:11885) passes automatically, `feed-protocol.js:149`
passes automatically, `ordersTableSuspect` (server.js:10545) is false so the orders self-repair
never runs. The blind table hides itself and `runLiveFeedSelfTest()` reports **3/3 PASSED**.

Verified 2026-09-08:

```js
// tradingview-mcp/src/core/trading.js — READ_TABLE_JS already computes `visible`
return { found: true, visible: t.offsetParent !== null, headers, rows, emptyStateText };

// ...and getPositions() throws it away
export async function getPositions() {
  const t = await readTable('TRADOVATE.positions-table');
  return { success: t.found, count: t.rows.length, empty: t.rows.length === 0,
           emptyStateText: t.emptyStateText, positions: t.rows.map(r => r.row) };
}

// app/server.js:10702
const isFlat = !positions.length;
```

`emptyStateText` — the one field that distinguishes TradingView's rendered
"There are no open positions" placeholder from a table that rendered nothing — is produced by the
MCP and read **exactly once in the whole app**, for orders (server.js:11884).

### Do

1. `tradingview-mcp/src/core/trading.js` — add `visible: t.visible` to `getPositions()`'s return.
   It is already computed; it is being dropped on the floor.
2. `app/server.js:10475` — compute
   `positionsRendered = result.positions.success && (positions.length > 0 || !!result.positions.emptyStateText)`.
3. `app/server.js:10702` — **do not compute `isFlat` at all** unless `positionsRendered`.
   The refuse-to-fold branch already exists at 10520-10530; only the condition needs widening.
4. `app/server.js:11860` — mirror the orders fix:
   `positionsOk = positionsFound && (openCount > 0 || positionsEmptyState)`.
5. `app/feed-protocol.js:149` — add a symmetric `positionsUnrendered = pr.positionRows === 0 &&
   !pr.positionsEmptyState` that does **not** depend on `openPositions`.

**SHIP AS ALARM ONLY FOR ONE SESSION.** Log + broadcast + Protocol 2 check, but let `isFlat`
behave as it does today. Confirm against a live FLAT account that `emptyStateText` is non-null
before letting this gate anything. If Tradovate ever renders a genuinely flat table with no
placeholder row, the gating version would refuse to fold on a normal flat account and stop trade
recording.

### ACCEPTANCE

```
[ ] node -e "require('./tradingview-mcp/src/core/trading.js')" — getPositions returns a `visible` key
[ ] A unit test feeds {found:true, rows:[], emptyStateText:null}  → positionsRendered === false
[ ] A unit test feeds {found:true, rows:[], emptyStateText:'There are no open positions'}
                                                                 → positionsRendered === true
[ ] A unit test feeds {found:true, rows:[{...}], emptyStateText:null} → positionsRendered === true
[ ] grep -c emptyStateText app/server.js  >= 3   (was 1)
[ ] With positionsRendered false, `isFlat` is never assigned (assert via a spy or a thrown guard)
[ ] runLiveFeedSelfTest() reports a FAILURE, not 3/3 PASSED, against a stubbed blind positions read
[ ] No historical figure is recomputed — DATA/accounts/s2/gr_history.json byte-identical after a run
```

---

## G3 — The oversize-guard BLIND alarm cannot fire on an empty array

`noteOversizePositionRead(rows)` is the one detector whose entire job is to say "size is not being
enforced right now". Its own comment (server.js:13217-13220) reads: *"An unreadable positions table
is the one failure that makes the oversize guard silently useless — it looks IDENTICAL to a flat
account."*

The classification is `if (rows) {` — **and `[]` is truthy.**

Verified 2026-09-08 — the caller only ever passes `null` when the table is MISSING, never when it
is present and rendering nothing:

```js
// app/server.js:11724
if (!result || !result.success || !Array.isArray(result.positions)) {
  noteOversizePositionRead(null);
  return;
}
```

So G2's failure mode is filed as a **successful read**: `blindReads = 0`, `lastSeenSize = 0`, no
alarm, no jsonl row, and the `runLiveFeedSelfTest()` call at the bottom of the blind branch is
never reached. Protocol 2's `oversize-guard` check reads the same `og.blind` flag and also passes.

Downstream, with the app believing it is flat:
- `enforceOversizeGuard([])` → `largestPosition([])` is `null` → does nothing.
- `enforcePerTradeStop([])` → `size === 0` → **RESETS `perTradeStopState`** and returns.

> The **$300 per-trade stop and the 4-contract cap are both off**, and the guard that exists to
> announce exactly that is reporting green.

`server.js:11571` states the stake in the repo's own words: *"A blind stop is what killed
3 September."* This path is silent.

### Do

Change the **caller**, not the callee, so the distinction is made where the evidence is. This
reuses the existing blind path verbatim — alarm after `OVERSIZE_BLIND_READS_ALARM` (3) reads,
jsonl row, broadcast, one auto-repair per episode — with **no change to
`noteOversizePositionRead` itself**:

```js
// app/server.js, at the ~11722 call site
const rendered = Array.isArray(result.positions)
  && (result.positions.length > 0 || !!result.emptyStateText);
noteOversizePositionRead(rendered ? result.positions : null);
```

`trading_get_positions` already returns `emptyStateText`. Nothing new is plumbed. **Depends on G2**
for `emptyStateText` to be reliably present.

### ACCEPTANCE

```
[ ] Unit test: rendered-empty read ([] + emptyStateText) → blindReads stays 0, lastSeenSize 0
[ ] Unit test: blind read ([] + no emptyStateText) x3    → blind alarm fires, jsonl row written
[ ] Unit test: blind read does NOT reset perTradeStopState (the latch survives)
[ ] oversizeGuardStatus().blind === true after 3 unrendered reads
[ ] Protocol 2's oversize-guard check FAILS in that state (it passes today)
[ ] The guard can only ever see MORE, never less — no test asserting a previously-caught
    oversize is now missed
```

---

# TIER P1 — price the risk, then give the playbook a plan

**G10 is in this tier and not in P5 deliberately.** It is a risk-pricing fix, but it must land
before G1 because G1 is what currently hides it. Do not reorder these two.

## G10 — MGC setups are risk-priced as MNQ ($2/pt)  ★ ship before or with G1

A real gold engulf is on disk: `DATA/signals/2026-09-03.jsonl`, `event: engulf-fire`,
`"symbol": "COMEX_MINI:MGC1!"`, entry 4477.10, stop 4461.70 = **15.4 points**.

**MGC is $10/point.** Real risk at 2 contracts = **$308**. The app computes `15.4 × 2 × 2 = $61.60`.

That is **5×**, and it flips that setup from "comfortably inside the $300 cap" to "over it" — so
`autonomyModes.checkOrderRisk` (server.js:8992) would clear an order it should block.

### Do

Add a per-symbol contract spec to `rules.json` alongside the existing `playbooks` block:

```json
"contracts": {
  "MNQ": { "pointValue": 2,  "tickSize": 0.25 },
  "MGC": { "pointValue": 10, "tickSize": 0.10 }
}
```

Resolve it from the ledger row's `symbol` at `server.js:8975` and `9655-9656`. **Refuse rather than
default when the symbol is unknown** — the same discipline `autonomyModes.checkOrderRisk` already
applies to an uncomputable risk (*"Unknown risk is never small enough"*).

Historical shadow rows stay at $2/pt and **must not be recomputed**. Any aggregate spanning the
change must read `pointValue` per row from the symbol, not apply one multiplier.

### ACCEPTANCE

```
[ ] rules.json gains a `contracts` block; pointValue is never hardcoded in js
[ ] Replaying the 2026-09-03 MGC engulf-fire row yields riskUsd 308, not 61.60
[ ] An unknown symbol REFUSES (does not silently default to MNQ) — assert the refusal path
[ ] Historical rows in DATA/autonomy/*/orders.jsonl are byte-identical after the change
[ ] An aggregate over mixed-symbol rows reads pointValue per row (assert with a 2-symbol fixture)
```

## G1 — Playbook A's `armSetup` omits the trigger bar

Verified 2026-09-08, `app/server.js:6416-6422`:

```js
  setupId: engulfBar ? playbookSpec.setupId(specId, { direction, barTime: engulfBar.time,
                                                      entryRef: engulfBar.close }) : null,
});
// ...
if (isFullSetup) {
  armSetup({ playbook: 'A', tfCode: cfg.tfCode, tfLabel: cfg.label, direction, message: signalMessage });
}
```

No `bar`, no `barTime`, no `entryRef`, no `setupId` — **while `engulfBar` and a correctly computed
`setupId` sit in scope on the line immediately above.** The plan was already built 64 lines earlier
at `server.js:6358` (which *does* pass `bar: engulfBar`) and written into the ledger row.

`armSetup` → `planEntry` therefore hits the engulf branch with `s.bar = {}` and returns
`{plannable: false, reason: 'engulf playbooks need the trigger bar OHLC'}`. Reproduced by running
that exact argument object; adding `bar` yields
`{plannable: true, entry: 29561.5, stop: 29438.5, target: 29807.5, riskPoints: 123}`.

Five systems silently no-op for the app's most frequent playbook:

| # | site | effect |
|---|---|---|
| 1 | `shadowRecordMachineOrder` early-returns on `!plan.plannable` (server.js:8940) | no machine order ever recorded |
| 2 | shadow-ticket chat push gated on `plan.plannable` (server.js:9648) | no ticket |
| 3 | `armedSetup.entry/stop/target/targetR` (server.js:9682-9685) | all `undefined` |
| 4 | `armedSetup.size` (server.js:9686) | `[]` |
| 5 | `checkLiveTakeProfit` returns on `target == null && stop == null` (server.js:9737) | **the 2026-09-04 live TP/stop wiring has never fired for A** |

`test/playbook-spec.test.js:47` passes a bar directly, so the pure module is green while the only
production caller is not. `armSetup` has no test.

### Do

Pass the fields the monitor already holds:

```js
armSetup({
  playbook: 'A', tfCode: cfg.tfCode, tfLabel: cfg.label, direction,
  bar: engulfBar, barTime: engulfBar.time, entryRef: engulfBar.close,
  setupId: <the id already computed at server.js:6416>,
  structure: pbc ? pbc.structure : null,
  message: signalMessage,
});
```

**`setupId` must be passed explicitly.** The fallback at server.js:9634 collapses to
`A:BULLISH:na:na` / `A:BEARISH:na:na` — two ids for all time — and `buildMachineOrder` keys its row
on `day|playbook|setupId|contracts` (shadow-recorder.js:157-158), so passing the bar *without* the
id would collide every same-day same-direction A setup into one order.

### G1.RISK — read before landing

This turns ON the shadow-ticket chat push for every A engulf-fire. `rules.json`
`autonomyModes.shadow.silent` is `false` and the active mode `assist` has no `silent` key, so
`autonomySilent()` is false. **This is exactly the chat noise Anoop switched the feature off for on
2026-08-26.** Set `silent: true`, or ship with the ticket push still suppressed for A. Land it
outside a live session.

It also immediately activates `checkLiveTakeProfit` for A, producing `stop-hit` and
`take-profit-hit` ledger events and chat broadcasts **that have never existed before**. And a
Playbook A population starts appearing in the order files for the first time, so any
"orders per playbook" aggregate changes shape from the fix date. Note it in the ledger; **do not
backfill.**

### ACCEPTANCE

```
[ ] New test: armSetup's planEntry is plannable for each of A, B and C-ADX (the gap is in wiring;
    every existing test bypasses the caller)
[ ] Replay one real engulf-fire row from DATA/signals → shadow order written with entry/stop/target
[ ] setupId on the produced order is NOT 'A:BULLISH:na:na'
[ ] Two same-day same-direction A setups produce TWO distinct order rows, not one
[ ] armedSetup.entry/stop/target/targetR are all non-null after an A fire
[ ] With silent:true, no chat ticket is pushed for A (grep the broadcast in a stubbed run)
[ ] checkLiveTakeProfit is reachable for A (assert it does not early-return)
```

---

# TIER P2 — make the measurement true, then show it

## G7 — Reject rows are written before the per-bar dedup  ★ must precede G6

`server.js:9449` (the gate) precedes `server.js:9454` (the `already-fired` dedup), so a blocked
setup writes one `htf-reject` row **per 60s tick** for as long as it stays blocked.

```
83 rows  →  9 distinct (playbook, tf, direction, bar-period) setups   = 9.22x
C-ADX:  76 rows  →  3 setups                                          = 25.3x
2026-09-04 rows are consecutive minutes: 03:31:27, 03:32:25, 03:33:25 … 03:46:25
```

**The exact measurement the gate exists to produce is corrupted 9x.**

### Do

Keep the gate where it is (its position is what makes "held" refresh in `cadx-status.js` on every
tick) and track the blocked bar separately: add `cadxLastBlockedBarTime`, and skip the
`ledgerSignal` + `broadcast` inside `htfGate` when that bar has already been rejected — while still
returning the gate result so `done('htf-blocked')` keeps refreshing the watcher row.

Also populate `setupId` on the reject row. `playbookSpec.setupId` is already imported and used two
lines below at 9455-9480.

**Comparability:** rows already on disk are inflated and rows after the fix are not. Any count over
the ledger must be bar-bucketed or restricted to one side of the change. Nothing reads these rows
today — which is exactly why this must land *before* G6 builds a reader on top of them.

### ACCEPTANCE

```
[ ] A setup blocked for 30 consecutive ticks writes exactly ONE htf-reject row
[ ] The watcher row still refreshes every tick (cadx-status still shows "held")
[ ] Every new htf-reject row carries a non-null setupId
[ ] A NEW bar that is also blocked writes a SECOND row (dedup is per-bar, not per-session)
[ ] Replaying DATA/signals/2026-09-04.jsonl through the new path yields 3 rows, not 76
```

## G6 — `htf-reject` is broadcast but no renderer branch exists

Verified 2026-09-08: `grep -rn "htf-reject" app/renderer/` returns **0 hits** across all 31 renderer
files. `server.js:9609` broadcasts it; `ws-client.js` has 131 `case` labels ending in
`default: break;` at line 681. **83 broadcasts sent, 0 rendered, 0 counted.**

`htfGate`'s own comment says *"Rejections are LEDGERED, not swallowed... a filter nobody can audit
is a filter nobody trusts."* The ledger half shipped. The UI half did not.

The contrast proves omission, not policy: the Playbook A **shape** rejection takes the identical
journey and IS visible — `server.js:6163` → `ws-client.js:408` → a dimmed history row plus a TF chip
reading "BULLISH engulf rejected · HH:MM IST".

### Do

1. Add `case 'htf-reject': emit('htf:reject', msg); break;` next to the existing `htf-status` case
   at `ws-client.js:568`. The payload already carries everything — `text` is
   `htfAlignment.explain(gate)`, a complete human sentence. **No server change.**
2. Render it as a distinct **HELD** row in the Chart Watchers / signal feed, styled so a block can
   never be mistaken for a fire. Use a **status row (idempotent, last-value-wins)**, not a
   chat-style append.
3. `renderer/scorecard.js` — extend `PLAYBOOKS` (line 16) to
   `['A','B','C','C-ADX','PO3','FVG-ONLY']` and add an explicit
   `if (s.event === 'htf-reject') { b.htfBlocked++; continue; }` with a matching `htfBlocked: 0` in
   `freshBucket()` (line 32) and a column in the panel.

   The scorecard currently drops **124 of 514 rows = 24.1%** of the ledger via the playbook filter
   alone. **Do NOT merge `htfBlocked` into `rejected`** — `rejected` means the engulf-validity
   filter, and the `C` / `C-ADX` naming collision is already a live trap.

### ACCEPTANCE

```
[ ] grep -rn "htf-reject" app/renderer/  returns >= 2 hits
[ ] A simulated htf-reject broadcast produces a visible HELD row, visually distinct from a fire
[ ] 30 identical blocks produce ONE row, not 30 (relies on G7 — do not ship G6 without it)
[ ] scorecard counts C-ADX and FVG-ONLY rows (totals move by 124 rows on the historical set)
[ ] scorecard `rejected` bucket is UNCHANGED by this task (assert against the existing fixture)
[ ] test/scorecard.test.js updated, not deleted
```

---

# TIER P3 — stop destroying the setup

## G5 — Playbook B's HTF block deletes the pending raid and says nothing

Verified 2026-09-08, `app/server.js:7241` — the entire block path:

```js
const bGate = await htfGate('B', cfg.tfCode, mon.pending.direction);
if (!bGate.allowed) { mon.pending = null; return; }
```

Two things happen and both are wrong:

1. **It emits nothing** — no chat line, no watcher status, no `sfp-check` broadcast. The raid was
   announced to Anoop minutes earlier with the explicit promise *"Not a trade yet: waiting for
   displacement/FVG to confirm Playbook B"* (server.js:7207). From his chair a silent discard is
   indistinguishable from the watcher detecting nothing.
2. **It destroys `mon.pending`**, so the raid is cancelled rather than un-confirmed. The 8-bar
   patience window (server.js:7222 `expiresAt`) still has time left, and a 15M that resolves to a
   clean bias one bar later **cannot revive it**.

```
113 sfp-raid rows announced  vs  9 playbook-b-confirm delivered
28.7% measured 15M-unclear rate → ~1 in 3.5 confirms reaching line 7241 is destroyed silently
```

C-ADX at least surfaces its block as a watcher row ("SETUP FOUND — held by the HTF gate",
`cadx-status.js:41`). **B has no equivalent anywhere.**

### Do

Two separable changes, both additive:

**(a) Stop destroying state.** Drop `mon.pending = null` from 7241, keep the `return`. Let the
pending raid live to its existing `expiresAt` and re-evaluate the gate on the next closed bar. It
can never fire a setup the gate refuses — the gate is still consulted on each retry.

**(b) Emit the block** on the SAME `playbook-b-signal` / `sfp-check` channel the raid used,
carrying `gate.reason`, `structure15m`, `structure1h`. The pane that said "waiting for
displacement" can then say *"displacement arrived, held: 15M has no clean bias (1H bullish)"*.

Gate the whole behaviour on a new `rules.json` key — `playbooks.htfUnclearMode: "block" |
"alert-only"`, **defaulting to `"block"`** so today's behaviour is the default and the change is
opt-in from the file that owns every trading number.

**Comparability:** (a) changes what B *does*, not just what it says. `playbook-b-confirm` counts
will rise and the forward-test population shifts. **Stamp the reason and retry-count on rows fired
via the new path** or the history stops being comparable. (b) is display-only. B is not
order-capable on its own — it goes to `armSetup` → `shadowRecordMachineOrder` and the debate, and
every autonomy rung is disabled — so neither half can place anything.

### ACCEPTANCE

```
[ ] rules.json gains playbooks.htfUnclearMode with default "block"
[ ] With "block" and the flag absent/old rules.json: behaviour byte-identical to today
[ ] A blocked confirm no longer nulls mon.pending; the raid survives to expiresAt
[ ] A raid blocked on bar N and clean on bar N+1 DOES produce a playbook-b-confirm
[ ] That confirm row carries the retry count and the block reason
[ ] A raid blocked every bar until expiry produces NO confirm and expires normally
[ ] The block is visible on the same channel as the raid announcement
[ ] A setup the gate refuses on direction (setup-against-htf-bias) still NEVER fires
```

---

# TIER P4 — the gate is refusing for the wrong reason

## G4 — 96% of live blocks are "could not read", not "wrong side"

```
Post-2026-09-03:  76 htf-15m-unclear  vs  1 setup-against-htf-bias   =  96.2% unreadability
```

`htf-alignment.js:190-193` makes an unclear 15M a hard refusal, on the premise that an unreadable
chart is a legitimate reason to stand down. The live ledger says that premise now describes
essentially **all** of the gate's output.

A 76:1 ratio is not a filter refusing bad trades. It is the app failing to read — which is verbatim
the failure `htf-alignment.js:96-98` says the module exists to prevent: *"an app failing to READ,
wearing the costume of a rule refusing a trade."* **It was fixed on the 1H in September 2026 and
reintroduced one rung down on the 15M.**

And the 2026-09-04 evidence is the sharpest form of it: 5h28m of continuous blocks on a **long-only**
playbook, every row carrying `structure1h: 'bullish'`.

### Do — do NOT relax the gate by changing a constant

Split the refusal. Add to `rules.json` a `playbooks.htf` block with `unclearPolicy` **per playbook**:

```json
"playbooks": {
  "htf": {
    "unclearPolicy": {
      "_default": "refuse",
      "A":       "refuse",
      "B":       "refuse",
      "C-ADX":   "refuse-unless-1h-clean"
    }
  }
}
```

Values: `refuse` (today) | `refuse-unless-1h-clean` | `alert-unlabelled`.

**Default every playbook to `refuse` so shipping this changes nothing.** Then set C-ADX — and only
C-ADX — to `refuse-unless-1h-clean`. On the 2026-09-04 pattern (15M unclear, 1H cleanly bullish,
setup bullish) it records a shadow row carrying `htfConfirmation: 'unclear'` instead of 76 silences.

That produces the rows needed to answer "should the 1H ever be more than evidence" **with zero
live-money exposure**: C-ADX is `shadowOnly: true` (`rules.json` `playbookCAdx`), reaches only
`armSetup` → `shadowRecordMachineOrder`, and never convenes the debate.

### G4.RISK — the hard boundary

**This is the only task that touches enforcement.** It must not be applied to any playbook that can
reach `handleTradeConfirm`. Scoped to C-ADX at the shadow rung it is inert on the money path;
scoped wider it would open Playbook B during exactly the expanding-range conditions that produce
the widest stops.

The `rules.json` key **must be additive with a `refuse` default** — a missing or old `rules.json`
must not silently loosen live gating. Existing ledger rows keep their reason codes and stay
comparable.

**Anything above the shadow rung stays `refuse` until those rows exist.**

### ACCEPTANCE

```
[ ] rules.json gains playbooks.htf.unclearPolicy; every entry except C-ADX is "refuse"
[ ] Deleting the block entirely → behaviour byte-identical to today (default refuse)
[ ] Unit test: policy "refuse-unless-1h-clean" + 15M unclear + 1H bullish + BULLISH setup → ALLOWED
[ ] Unit test: same, but 1H unclear                                                       → REFUSED
[ ] Unit test: same, but 1H bearish (setup bullish)                                       → REFUSED
[ ] Unit test: policy "refuse" + 15M unclear                                              → REFUSED
[ ] setup-against-htf-bias is REFUSED under every policy value (direction is never relaxed)
[ ] No code path lets Playbook A or B read a non-"refuse" policy (assert by grep + a test)
[ ] handleTradeConfirm is untouched by this change (diff shows no edit to that function)
[ ] Replaying 2026-09-04 produces >= 1 shadow row where today there are 0
```

---

# TIER P5 — the money path has no risk ceiling

## G8 — Nothing enforces `perTradeMaxLoss` at plan time

`perTradeMaxLoss` 300 ÷ ($2/pt × 2 contracts) = a **75-point ceiling** (`sizeFloor` is 2, so he
cannot size down). Computed from `entry`/`stop` actually on disk:

```
Playbook A   4 of 13 planned rows over the cap   (31%)
Playbook B   3 of  4 planned rows over the cap   (75%)
             7 of 17 = 41%

worst live:  2026-08-28 B  196.5 pt = $786
             2026-08-27 A  131.25 pt = $525
             2026-09-01 A (1H) 117 pt = $468

across the bar caches:  1H  85/157 engulf setups over cap (54.1%), median 84.8pt = $339
                        30M  3/14 (21.4%)   15M 1/15 (6.7%)   5M 0/12
```

**The median 1H Playbook A setup is already over the cap.**

### Do

Move `riskGate()` out of `backtest.js` into a shared pure module (or `playbook-spec.js`) and have
`planEntry` return `{plannable: true, riskUsd, riskBlocked: 'over-per-trade-max'}` rather than
silently plannable.

**Flag, do not skip.** A hard skip stops arming ~⅓ of A and ¾ of B mid-dataset and makes
forward-test numbers non-comparable across the change — the exact failure the engulf-fire /
engulf-alert split was built to avoid. Stamp the flag on the ledger row, show it on the armed-setup
card, and put it in the push. **The setup is currently announced with no risk figure of any kind.**

Read sizes and cap from `rules.json` (`perTradeMaxLoss`, `sizeFloor`,
`autonomyModes[mode].perTradeRiskCapUsd` via `autonomyModes.riskCapUsd`). **Do not hardcode 75.**
Note that shadow order rows already carry `blocked: 'risk-too-big'` and are excluded from
`pendingMachineOrders()` — a plan-time skip would double-count the same exclusion in two places.

### ACCEPTANCE

```
[ ] riskGate lives in ONE module; backtest.js imports it rather than declaring it
[ ] planEntry returns riskUsd on every plannable result
[ ] A 117-pt 1H A setup at 2 contracts returns riskBlocked:'over-per-trade-max', plannable STILL true
[ ] The armed-setup card and the push both show the dollar risk
[ ] engulf-fire / playbook-b-confirm row COUNTS are unchanged by this task (flag, not skip)
[ ] 75 appears nowhere in the source; the ceiling is derived from rules.json
```

## G11 — `minRiskPoints: 8` is enforced only in the backtest

`rules.json:192` sets it; `backtest.js:101` uses it; **`grep minRiskPoints playbook-spec.js` → 0 hits.**

Binding rate on Playbook A today is **zero**: 0 of 13 live planned rows and 0 of 214 engulf setups
across every bar cache fall under 8 points (closest: 8.25 pt, one tick of margin). **But it has
bitten Playbook B** — `backtest.js:91-99` records that **5 of 15 detected B setups came back at
exactly 3.00 points** (the stop buffer alone, meaning the raid candle and the third FVG candle were
the same bar — not the playbook), **and all five lost.** The live SFP monitor applies no such filter.

### Do

Fold the minimum into the **same shared riskGate module from G8** so both ceilings live in one
place. For the B case specifically, return
`{plannable: false, reason: 'risk 3.00pt under minRiskPoints 8 — raid and displacement are likely the same bar'}`.

**The refusal must be surfaced** — a ledger field or a distinct event name — not swallowed by
`armSetup`'s catch-all try/catch at server.js:9648. A `plannable: false` that `armSetup` arms anyway
is literally the shape of G1.

### ACCEPTANCE

```
[ ] minRiskPoints is read from rules.json in planEntry; 8 is not hardcoded
[ ] A 3.00-pt B setup returns plannable:false with the reason string
[ ] armSetup does NOT arm a plannable:false setup silently — it emits a distinct ledger event
[ ] Playbook A binding rate stays 0 on the existing 214-setup fixture (no regression)
[ ] The B population change is stamped on rows so pre/post counts stay separable
```

## G9 — `handleTradeConfirm` never checks stop distance

This is **the only path in the app that places a real order**, and it is behind
`TV_ALLOW_LIVE_ORDERS === '1'` (server.js:13781) — the LIVE ORDERS launcher, i.e. precisely the
configuration this check exists for.

- `server.js:13881-13882` — pass-through.
- `trade-confirm-rules.js:35-105` — no risk-in-dollars check. `grep perTradeMaxLoss` → **0 hits**.
- `trade-ticket-parse.js:34-35` — only checks positivity.
- `renderer/app.js:6124-6127` — Stop is a free-form editable number input, **no dollar risk shown
  anywhere on the ticket card**.

Magnitude from the measured 1H engulf risk distribution: **p90 = 197 pt = $789** at 2 contracts,
**max 455 pt = $1,822 — 6.1× `perTradeMaxLoss`**. A ticket stop 400 points from entry submits
$1,600, 5.3× the cap, with nothing in the chain to refuse it. **And a Judge that omits the stop
produces a naked market order.**

### Do

Add the risk check to `trade-confirm-rules.checkTradeAllowed` — it is the pure, tested, no-override
gate and is already the right home. Take `{stopPrice, lastPrice, pointValue}` and refuse when
`|lastPrice - stopPrice| * pointValue * qty > autonomyModes.riskCapUsd(rules, mode)`.

Also refuse a stop on the **wrong side of the entry** — two lines in `trade-ticket-parse.js`, `side`
is already known. **Decide explicitly what a stopless ticket means:** refuse it, or require the
caller to supply one. Render the dollar risk on the ticket card so the number is visible before
Confirm is pressed.

Gate the refusal behind the tighter-of-`{mode cap, perTradeMaxLoss}` that `riskCapUsd` already
returns, so it can never be looser than the account rule. **`lastPrice` is not currently read by
`handleTradeConfirm`** — sourcing it adds a `quote_get` inside the `withChartLock` block, which
lengthens the one critical section that must not interleave with a symbol switch. Fetch it before
taking the lock.

### ACCEPTANCE

```
[ ] trade-confirm-rules.test.js: a 400-pt stop at 2 contracts is REFUSED
[ ] a stop on the wrong side of entry is REFUSED by trade-ticket-parse
[ ] a ticket with NO stop is refused (or the caller is forced to supply one) — decide and test it
[ ] the refusal can never be looser than perTradeMaxLoss (assert against a permissive mode cap)
[ ] the ticket card renders dollar risk before Confirm
[ ] quote_get happens OUTSIDE withChartLock (assert call ordering)
[ ] every existing trade-confirm-rules test still passes
```

---

# TIER P6 — the two bias reads still contradict each other

## G12 — The GO/NO-GO badge is blind to the gate that blocks trades

`computeMechanicalGoNogo()` derives everything from `state.mechanical` (the 4H/1H panel). The
`htf-status` message — the gate that decides whether B and C-ADX may fire at all — is **render-only**:
its handler calls `renderHtfStatus` + `renderEngulfSideBand` and nothing else. **`grep "state.htf"
renderer/app.js` → 0 hits.**

> Over 260 matched instants: badge GO-eligible on **112/260 = 43.1%**; of those the 15M gate was
> **SHUT on 31 (27.7%)** and **open the OPPOSITE way on 36 (32.1%)** — i.e. in **59.8% of
> "GO — in session, aligned" moments the deciding gate was refusing or inverted.** Of the 24
> instants held at PENDING for "4H/1H bias not aligned", the gate was **open on 8 (33.3%)**.

### Do

Store the broadcast as `state.htf` in the `htf-status` handler (renderer/app.js:2748), then add a
**SOFT reason** in `computeMechanicalGoNogo()`:

- `!msg.ok` → `15M gate: NO BIAS — Playbook B and C-ADX are held`
- `msg.bias` disagrees with `m.dailyTrend` → `15M gate ${msg.side} — opposite the 4H panel (${m.dailyTrend})`
- treat `msg.stale` like `mechStale`, **for reporting only**

No new number; everything is already on the wire.

**It must stay SOFT.** A hard version blocks trading on the 15M read, which is exactly the veto
`htf-alignment.js` measured and rejected (71.3% → 21.1% open). Note this touches the badge string
`buildContextMessage()` feeds to Jessi, so agent replies will start reflecting the gate — that is
desirable, but it is a **Prompt/LLM change** per `CLAUDE.md` and needs the manual smoke test.

### ACCEPTANCE

```
[ ] state.htf exists and is populated by the htf-status handler
[ ] Badge shows a soft reason when the gate is shut; it does NOT change GO→NO-GO by itself
[ ] Badge shows a soft reason when gate side != panel side
[ ] With no htf-status ever received, the badge behaves exactly as today
[ ] CLAUDE.md step-3 manual smoke test performed and the actual Jessi reply pasted into the PR
```

## G13 — Two label fixes, trivial, do them immediately

**(a) The PO3 card prints a 1H read under "4H bias".** `server.js:4685` is
`po3TrendRead('60')`; the server's own message text says `'1H bias: '` (server.js:4707, 4850);
`renderer/app.js:2431` renders `'4H bias: '`. **113 `po3-phase-change` rows across 15 trading days
— every one produced a card carrying the wrong label.** Change the literal at app.js:2431.

**(b) `BIAS CHANGED` claims authority it does not have.** Live-verified: on 2026-09-07 at 13:55 IST
the panel posted `BIAS CHANGED: BEARISH → BULLISH — 4H mechanical read` and then sat unwithdrawn
while the gate posted **four consecutive hourly BEARISH lines** (16:32 / 17:32 / 18:32 / 19:32 IST).
Across the archive the panel emitted **1** such line and the gate **55**.

At `renderer/app.js:6863`: `'BIAS CHANGED (4H reference read — this does NOT gate the watchers): …'`
and, when `state.htf` exists and differs, append
`'The 15M gate that holds Playbook B and C-ADX currently reads BEARISH.'`

Both are chat surfaces Anoop acts on → **Prompt/LLM change, manual smoke test required.**

### ACCEPTANCE

```
[ ] grep -c "'4H bias: '" renderer/app.js  ==  0
[ ] The PO3 card label matches the server's own message text
[ ] A bias flip posts the qualified string, and names the gate's side when state.htf differs
[ ] With state.htf absent the line still renders (no crash on the optional branch)
```

## G14 — Framework Steps has no step for the read that decides

Step 1 is labelled **"4H bias"** (index.html:541, filled from `m.dailyLabel`); step 2 is
**"1H aligns"** (index.html:542, from `m.aligned`). **Neither timeframe is read by
`htf-alignment.readHTF`.** There is no step anywhere for the 15M structure.

> Step 2 reads YES on 112 of 260 instants, and the 15M gate agrees with the panel's direction in
> only **45 (40.2%)**. The two point **opposite ways on 82 of 159 directional pairs (51.6%)** —
> spread across days, not one blob: per-day opposition 65% / 0% / 42% / 68% / 36%.

### Do

Add a **step 0 "15M gate"** to the step-grid (index.html:540), rendered from the `htf-status`
message: `BEARISH · 1H unclear · 15M-only`. Relabel step 1 → **"4H bias (reference)"** and step 2 →
**"1H (evidence)"**. **Leave the values themselves untouched.**

### G14.RISK — do not fix this one alone

The pre-trade CHECKLIST is a **hard block** via `rules.json requireChecklist`, and index.html:1035
still asks him to tick *"4H and 1H in the same direction … no trade if they disagree"*.
`bias-tracker.js:48-53` grades adherence on `ck.bias`/`ck.h4`/`ck.h1` only. **Changing Framework
Steps alone moves the contradiction rather than removing it.** All 6 checklist records on disk carry
`daily`/`h4`/`h1` with all three always agreeing, so a schema change there needs a migration story.
Either handle the checklist + adherence matrix in the same pass, or write down explicitly that the
checklist stays his manual 4H/Daily read.

### ACCEPTANCE

```
[ ] A step 0 "15M gate" renders from htf-status
[ ] Steps 1 and 2 are relabelled; their VALUES are byte-identical to before
[ ] ck_history.json is not migrated by this task (or a migration + test ships with it)
[ ] bias-tracker's directionOfRecord is unchanged, or changed with its own test
[ ] A written decision on the checklist item at index.html:1035 is in the PR description
```

---

# TIER P7 — the gate and the feed can lie about being alive

## G15 — `STALE_AFTER_MINUTES` gates nothing  (HIGH)

`stale` is computed in `htf-status.js:99` and consumed **only** by the broadcast (server.js:9578)
and `telegramBot.notify` (9584 — dead, see G18). `readHTF` takes no clock; `checkSetup` takes no age
in and returns none out; `htfGate` is `readHTFNow + checkSetup` and nothing else.

**So `htfGate()` opens and closes Playbook B and C-ADX on a 15M read of unbounded age.**

**Do:** have `readHTFNow()` return `{...res, lastBarMs: htfLastBarMs}` (the variable already exists
at 9532 and is already stamped from the bar, not the wall clock, at 9552). In `htfGate()` compute
`ageMin` and (a) attach `htfAgeMinutes` + `htfStale` to every ledgered row, (b) **refuse** with a new
reason `htf-stale` when `ageMin > STALE_AFTER_MINUTES`. Refusing is the correct direction: B and
C-ADX are the two that already stand down on doubt.

```
[ ] htfGate refuses with reason 'htf-stale' past the threshold
[ ] every htf-reject row carries htfAgeMinutes and htfStale
[ ] a fresh read is unaffected (regression fixture)
[ ] STALE_AFTER_MINUTES is still read from htf-status.js, not duplicated
```

## G16 — TradingView disconnected reads as a healthy "HTF NO BIAS"  (HIGH)

Measured by running the real modules: `readHTF([],[])` → `{ok:false, reason:'htf-15m-unavailable'}`,
then `buildStatus({htf: that, watchers: 4×running, lastBarMs: null})` →
**`stale=false`, `dataAgeMinutes=null`, "all 4 watchers armed"**, headline
**`HTF NO BIAS — B and C held, A alerts unlabelled`**, telegram condition false.

**This is the exact state `htf-status.js` was written to expose, and it reports reassurance.**

**Do:** two one-line changes, no new state. (1) At server.js:9552 **do not clobber `htfLastBarMs`
when the read fails** — keep the last known good bar time so age keeps growing and `stale` fires on
schedule; advance it only on success. (2) Pass `tvConnected: mcpBridge.ready && mcpBridge.tvConnected`
into `buildStatus()` and have `buildHeadline` emit **`HTF FEED DOWN`** ahead of the stale/no-bias
branches, with a matching chip class.

```
[ ] readHTF([],[]) + TV down  →  headline starts 'HTF FEED DOWN', not 'HTF NO BIAS'
[ ] htfLastBarMs is not nulled by a failed read; dataAgeMinutes keeps growing
[ ] stale fires on schedule during a disconnect
[ ] a genuine unclear-with-good-data still reads 'HTF NO BIAS' (do not merge the two)
```

## G17 — Watcher liveness is 3× the bar period

`server.js:10059` — `stale = Date.now() - last > 3 * e.intervalMs`, and `intervalMs` **is** the bar
period. Thresholds before the first restart attempt: 5M→15m, 15M→45m, **30M→90m**, 1H→180m. **Two
missed bar closes are tolerated on every watcher while it shows green.**

**Do:** keep 3× as the RESTART trigger (deliberately generous, per the 2026-08-26 restart-loop note)
but **split the DISPLAY threshold from it** — amber at 2× the bar period + `DEFAULT_SETTLE_MS`, the
point at which a close has provably been missed; red stays 3×. Separately change
`publishHtfStatus`'s watcher list (server.js:9571-9573) to consume `buildWatchersStatus()`'s
`health` rather than `.running`, so the hourly evidence line and the Chart Watchers panel cannot
disagree and `tv-offline` propagates into the line that claims coverage.

```
[ ] display amber at 2x + settle; restart still at 3x
[ ] publishHtfStatus reads health, not .running
[ ] a tv-offline watcher cannot report "armed" in the hourly line
```

## G18 — Every Telegram escalation is dead by a hardcoded constant

`server.js:14063` — `const TELEGRAM_ENABLED = false;` (verified 2026-09-08; the audit reported
14043, the tree says 14063 — **re-grep before editing, do not trust any line number in this doc
blindly**). **24 `notify`/`notifyPhoto` call sites** are silent no-ops, including the oversize-guard
BLIND alarm and the LIVE FEED PROTOCOL alarms. `telegram-bot.js:96-99` returns without logging.
Settings still renders a live token input (index.html:1333, 1337) that does nothing.

**Do not re-enable it** — server.js:14061 records Anoop's own decision (*"I don't want telegram to
work... remove them."*). **Make the deadness legible:** (1) one boot log line naming the count and
the two alarms it silences; (2) reuse the existing `telegramReady` computation (server.js:855) in
the Settings payload and render a disabled-state note instead of a live input; (3) route the two
genuinely-need-an-answer alarms to a surface that works.

```
[ ] boot log states TELEGRAM_ENABLED=false and the number of silenced call sites
[ ] Settings shows a disabled note, not an input that silently does nothing
[ ] the bridge is NOT re-enabled
```

## G19 — C-ADX never writes a ledger row when it fires

Of 76 rows tagged `playbook: "C-ADX"` across 16 days, **76 are `htf-reject` and 0 are anything
else.** `server.js:9457` calls `armSetup` with no accompanying `ledgerSignal`. **Its block rate has
no denominator.**

**Do:** add a `ledgerSignal({event:'c-adx-fire', ...entry, stop, setupId, adx, htfBias,
structure15m, structure1h, htfConfirmation})` beside the `armSetup` call, mirroring the Playbook B
confirm site at 7278-7288. `planEntry('C-ADX', ...)` already returns `plannable: true` with real
numbers, so the row carries a real anchor.

**Also, same task —** `rules.json playbookCAdx.tfCode` is `"60"` / `tfLabel "1H"`, while
`cadx-status.js:70` hardcodes `'Playbook C (ADX) 30M'` and :39 says `'the last closed 30M bar'`.
**The 2026-09-03 "move C-ADX to 30M" instruction was never applied to the value that controls it** —
the watcher has been running on the 1H (1242 bars from `mnq_60_live.json`) and reporting 30M for
five days. Read the label from `cfg.tfLabel`, and add a `_playbookCAdx_comment` recording the move
and its date, matching the `_dayStop_comment` / `firmLimits._comment` pattern the file already uses.
`lookback` is 5 while the researched value is 10 — document or restore it, do not leave it silent.

```
[ ] a C-ADX fire writes a c-adx-fire row with entry/stop/setupId
[ ] the watcher label is derived from cfg.tfLabel; '30M' appears nowhere hardcoded
[ ] rules.json gains _playbookCAdx_comment covering the tf and the lookback
[ ] the 76 historical reject rows are untouched
```

## G20 — `MIN_BARS_15M = 24` is an unreported quality cliff

Window sweep on the deciding timeframe (15M, contiguous segments):

```
24 bars → 58.5% clean, 21.2% pivot-starved     32 → 73.6% / 0.7%      40 → 70.6% / 0.0%
28 bars → 68.3% clean,  7.7% pivot-starved     36 → 72.4% / 0.0%
```

The admitted band spans a read that is starved **one time in five** and one that is never starved —
**and the output is identical**, because nothing reports how many bars were used.

**Do:** (a) `readHTF` returns `bars15mUsed`/`bars1hUsed`; `checkSetup` carries them; server.js:9601
stamps them on the reject row; `htf-status.js` names it when below 40 (*"read from 26 of 40
requested 15M bars — degraded"*). (b) In `chart-bar-cache.js set()`, store
`Math.min(count, value.length)` so a short response cannot claim a full-count entry.

```
[ ] every htf read reports bars15mUsed / bars1hUsed
[ ] the evidence line says "degraded" below 40 bars
[ ] a short cache response cannot be keyed as a full-count entry
```

## G21 — `LEVEL_TOL` is 14.8 MNQ points and exists in three uncoordinated copies

At the last cached 15M close (29,569.25), `0.0005` = **14.78 points = $29.57/contract** — **1.85×
`rules.json`'s own `minRiskPoints` (8)** and 4.9× `stopBufferPoints`. The structure reader treats as
"the same swing level" two prices far enough apart to hold an entire minimum-risk trade between them.

**Do NOT change the value** — it sits inside the noise band (0.0004 → 73.8%, 0.0005 → 70.6%,
0.0006 → 73.0%; the differences are not real). Change three other things:

1. Make `detectors.js:187` and `playbook-c.js:284` **import** `LEVEL_TOL` instead of re-declaring
   `0.0005`, so the header's claim becomes true. Add a test asserting all three resolve equal.
   **Ship this while they are still equal and it is provably inert.**
2. Rewrite the comment at `detectors.js:104` to state the value in POINTS at current MNQ price and
   its ratio to `minRiskPoints`, and to say out loud that **it was calibrated on the 1H and
   inherited by the 15M**.
3. Note that `findPivots` does not compare "the last two swing highs" but "the last two swing highs
   more than `LEVEL_TOL` apart" — which on 15M averages **135 minutes** apart.

**Do not fold it into `rules.json`:** it is a structure-reading tolerance, not a trading limit, and
`rules.json` is for the numbers Anoop sets.

```
[ ] one declaration of LEVEL_TOL; the other two import it
[ ] a test asserts detectors / playbook-c resolve to the same value
[ ] the value is UNCHANGED (0.0005) — this task is a no-op behaviourally
```

## G22 — PO3 is ungated and is the only detector that auto-triggers the order-capable Debate

`server.js:4685` uses `po3TrendRead('60')` — a **third** independent trend read
(`classifyTrendStrength`, 30 bars, score-based). No `readHTFNow()` anywhere in the PO3 path. And
`server.js:4744` calls `autoTriggerDebate` on the ACCUMULATION-exit transition — **the only route
that can emit a `TRADE_TICKET`.** 113 `po3-phase-change` rows, joint-largest event class.

The row at server.js:4735 carries no `from`/`to`/`phase`, **so the number of those 113 that were
debate-triggering cannot be recovered from disk.**

**Do, in this order and no further:** (1) **Measure first** — add `from`/`to` to the `ledgerSignal`
so the debate-trigger rate becomes countable. (2) Attach the gate as **EVIDENCE** — call
`readHTFNow()` and pass `bias`/`structure15m`/`structure1h`/`confirmation` into
`buildAutoDebateQuestion` (server.js:4560) so the Judge sees the same 15M structure every other
surface uses.

**Do NOT convert PO3 into a gated playbook in this change.** `amd-phase.js` is unit-tested and
reused by `tradingview-mcp/scripts/backtest-po3.js`; a backtest replayed with a different bias
source stops matching live. PO3's own gate blocks 13.4% of phase calls while the 15M read is unclear
28.7% of windows — so gating it would make PO3 **quieter**, and that is a decision for Anoop after
step 1 produces the number.

```
[ ] po3-phase-change rows carry from/to
[ ] the Judge's auto-debate question includes the 15M bias/structure/confirmation
[ ] po3TrendRead is STILL the decider (no behavioural change in this task)
[ ] amd-phase.js is untouched; backtest-po3.js still matches live
```

---

# TIER P8 — found while verifying DSH's first pass, 2026-09-08

These three did not come from the audit. They came from running `npm test` and reading the live
`DATA/` against DSH's changes, and each one is a case of **the app disagreeing with itself and
nothing noticing**.

## G23 — Commission is a PER-ERA value and every store treats it as global

`rules.json commissionPerContractPerSide` is one number applied to all history. It has now moved
twice: `0.59 → 0.95` (2026-08-24, Tradeify) and `0.95 → 0.49 → 0.95` (2026-09-08 — DSH set it to
0.49 for Apex; **Anoop reverted it to 0.95 the same day**).

`test/day-rollup-live-golden.test.js` already knows this is a historical dimension and sweeps
round-turn rates `[1.90, 1.18, 1.0]` to compensate. **0.49/side = 0.98 round turn, which is not in
that list** — so had the change stood, every day written under it could never reproduce, and the
test would fail for a reason that is not drift in the code it guards. That is the exact failure the
sweep was added to prevent, one rate later.

**Do:** stamp the rate ON the stored day (`gr_history` row gains `commPerCt`) so a day carries the
rate it was computed under, and have the golden test read that field instead of sweeping. Sweeping
is a workaround for a missing field; adding the field retires the workaround. Do **not** recompute
historical days — the Tradeify-era days were correctly computed at 0.95 and must stay that way.

```
[ ] new gr_history rows carry commPerCt
[ ] the golden test prefers the stored rate and falls back to the sweep for legacy rows
[ ] no historical day is recomputed (byte-compare gr_history before/after)
[ ] changing rules.json's rate does NOT change any stored day's pnl
```

## G24 — The phantom-fill detector under-counts

Measured on `DATA/tv_broker_feed_state.json`, 2026-09-08:

```
rows in trades[] with NO entryPrice ........ 4      sum  -3.44
phantomFlats counter ....................... 3      ← under-counts by one
rows in day_trades with size 0 ............. 5      sum +18.60
```

Four rows reached the feed with `entryPrice: undefined`, one of them carrying a **real size of 4**.
Five size-0 rows reached `day_trades`. **The counter that exists to detect phantoms disagrees with
the number of phantoms actually on disk, and the phantoms were written anyway.**

**Do:** make the phantom test a property of the ROW (`!size || entryPrice == null || exitPrice ==
null`) applied at the point of append, not a separate counter incremented elsewhere. A row that
fails it must not reach `day_trades` at all. Keep the counter, but derive it from the rows it
rejected so the two can never disagree.

```
[ ] a row with no entryPrice never reaches day_trades
[ ] phantomFlats equals the number of rejected rows, always (assert on a mixed fixture)
[ ] rejected rows are logged with enough detail to reconstruct them
[ ] existing good rows are unaffected (regression fixture)
```

## G25 — Nothing reconciles the broker feed against the stored day

Measured 2026-09-08, four stores, four answers for the same day:

```
tv_broker_feed_state.dayPnl   -231.12    (tradeCount 13, but 16 rows in trades[])
gr_history.pnl                -378.88    (n 18)   ← read -340.24 minutes earlier, it MOVED
day_trades row sum            -378.88    (18 rows)
broker order history           -435.40   (per DSH, from the broker's own record)
```

**A $147 gap between the feed and the stored day, a $204 gap to the broker, and `tradeCount` 13
against 16 rows in its own array — and nothing anywhere raises a flag.** `week-rollup.js` already
does a three-way reconciliation for the weekly surface and reports `disagreeDays` rather than
silently picking one; the daily path has no equivalent.

**Do:** add a daily reconciliation on the same doctrine — compare `tv_broker_feed_state.dayPnl`,
the `day_trades` row sum, and `gr_history.pnl` at rollover, and **report the disagreement rather
than choosing a winner**. It is a check, not a repair: the authoritative fix is a broker CSV through
`csvApply` (renderer/app.js:11016), which is the designed path and must stay the one that wins.

Also assert the feed's own internal consistency: `tradeCount` must equal `trades.length` minus
rejected phantoms, or say so.

```
[ ] a disagreement above a threshold from rules.json raises a visible check (Protocol 2 style)
[ ] tradeCount vs trades.length mismatch is detected
[ ] the check REPORTS and never silently rewrites any store
[ ] csvApply remains the only authoritative correction path
[ ] a day where all three agree produces no noise
```

## G26 — the live self-heal cannot recognise a trade it already recorded at a different size

**Found live, 2026-09-09, while hand-repairing a duplicated day.** Not from the audit — from
watching a manually-deleted row come back on its own, twice, within a minute of each deletion.

**Reproduction, exact:** a real MGC round trip (2 lots, CSV-confirmed gross **+$7.00**) is ALSO
captured by the live fold as a separate, smaller read — 1 lot, net **+$4.32** — because the fold's
size-tracking is best-effort (`sizeSeenThisTrade`, the largest position it happened to observe
between polls, not a verified fill count). `$7.00 − $2.68 comm = $4.32`: same trade, two records.

The CSV importer's own merge (`trade-identity.js isSameTrade`) already has the fix for exactly this
— unobserved size (0, or here effectively partial) is treated as a wildcard rather than a hard
mismatch. **The live self-heal path does not.** `tv-broker-feed.js`'s `mergeTradeRow` and
`missingFromDayRows` both gate on `nSize !== rSize → no match`:

```js
// tv-broker-feed.js:840
if (!nSize || !rSize || nSize !== rSize) continue;
```

So the CSV row (size 2) and the fold row (size 1) can never be recognised as the same trade. Delete
the duplicate by hand and the self-heal — a mechanism that exists on purpose, to recover trades lost
after a crash — sees the fold's copy as genuinely missing and **re-writes it on the next poll**.
Its own comment already documents this exact failure shape from a prior incident:
*"the self-heal would otherwise try to write it every poll forever — it fired 4 times in 20 minutes
doing exactly that."* This is that bug's twin, triggered by a size mismatch instead of a stale P&L.

**Impact:** small in dollars (~$4 on this occurrence) but it means **no CSV-vs-live duplicate
involving a partially-observed live size can ever be permanently resolved** without turning the
self-heal off, which is not a safe trade — that mechanism is what keeps a day's record intact
across a genuine app crash mid-session.

**Do:** give `mergeTradeRow` and `missingFromDayRows` the same wildcard `isSameTrade` already has —
when either side's size was not fully observed (fold-evidence rows only; never a CSV row, which is
always a real fill count), match on entry/exit timestamps within the existing tolerance window
and, where available, fill price, instead of requiring exact size equality. Reuse
`trade-identity.js`'s logic rather than re-deriving a second copy of the same rule — that is
literally how this drifted: one merge path got the fix, the other didn't.

**Do NOT weaken the match for two CSV rows or two fully-observed fold rows** — exact size equality
stays load-bearing there; it is only the "size not fully observed" case that needs to widen.

```
[x] a fold row with sizeSeenThisTrade < the CSV row's real size still matches on time+price
[x] two CSV rows of DIFFERENT real size are never merged (regression — this must not soften)
[ ] a manually-corrected day no longer regenerates a deleted duplicate on the next poll (LIVE DATA replay — pending)
[x] the wildcard logic is IMPORTED from trade-identity.js, not re-implemented
[x] existing tv-broker-feed.test.js suite (now 161 tests) still passes unmodified in intent
```

**Implemented 2026-09-09 (DSH).** `sizeIsBestEffort(row)` added to
`renderer/trade-identity.js` and exported; `isSameTrade` now uses it (reject a size mismatch only when
BOTH sides are verified). `tv-broker-feed.js` `require`s it and both `mergeTradeRow` and
`missingFromDayRows` treat a best-effort fold size as a wildcard: the size gate rejects only
`!sizeExact && !sizeWild`, `samePrices` fires across sizes when one side is best-effort, and the weak
P&L match stays gated on `sizeExact`. Three G26 tests added to `tv-broker-feed.test.js` (fold-partial
merges on time+price; two verified sizes never merge; fold-partial is not reported missing). Full
suite: **1928 pass / 0 fail**. The one remaining `[ ]` is a live-DATA replay (delete the duplicate,
confirm it stays deleted across polls) — the unit-level match is covered; run it against the real
2026-09-09 MGC day after `taskkill /F /IM node.exe`.

---

## G27 — the FRED release blackout tracks 8 release types; more of the same free feed move MNQ/MGC

**Not a bug — a same-safety-model expansion.** `FRED_API_KEY` is now set (2026-09-09, confirmed
live: `node cli/econ-calendar.js` returns real calendar data, `RIGHT NOW: clear`). The key is
already paying for full access to FRED's release calendar; `cli/econ-calendar.js`'s `RELEASES`
list only watches 8 of them:

```js
// cli/econ-calendar.js:48-56 — current list
NFP · CPI · PPI · FOMC · GDP · PCE · RETAIL · CLAIMS
```

Real releases that move MNQ (rate/growth-sensitive) and MGC (real-yield/USD-sensitive) and are
**not** on that list: ISM Manufacturing PMI, ISM Services PMI, Housing Starts / Building Permits,
Durable Goods Orders, Consumer Confidence (Conference Board), University of Michigan Consumer
Sentiment (prelim + final are separate releases), Industrial Production / Capacity Utilization,
FOMC Minutes (separate release from the statement, ~3 weeks after each meeting), and the regional
Fed surveys (Empire State, Philly Fed) for early-signal tier-3 coverage.

**Do:** add entries to the same `RELEASES` array, same shape as the existing eight
(`match`, `key`, `etHour`, `etMin`, `before`, `after`, `tier`). Two things are NOT optional:

1. **Verify each release's actual FRED name and publish time by running the calendar, not by
   guessing.** The module's own header explains why: *"FRED gives the DATE of a release but not
   its time of day... the time comes from the publishing agency's fixed schedule."* A wrong
   `etHour`/`etMin` produces a blackout window that misses the real print — worse than no coverage,
   because it looks covered. Cross-check against the BLS/BEA/Conference Board's own published
   release calendar for each series before wiring the time.
2. **Tier and before/after minutes need their own justification, not a copy-paste of NFP's.**
   ISM and Housing Starts are real movers but historically smaller/faster-fading reactions than
   NFP/CPI — a `tier: 1` / 60-minute-after window on Housing Starts would over-restrict trading for
   a release that doesn't warrant it. Use the existing tier-2/tier-3 entries (GDP, PCE, RETAIL,
   CLAIMS) as the calibration reference, and say in a comment why each new entry got the tier it got.

**The safety boundary from `cli/README.md` applies unchanged and must not be touched by this
task:** *"Nothing in this folder may raise a size, loosen a gate, or add conviction. A CLI result
may block a trade or annotate a record. It may never permit one."* This task can only ever make
the blackout list longer (more caution), never add a direction, a lean, or a value from any
release. `cli/test/cli.test.js` already asserts no alert contains directional vocabulary — do not
weaken that assertion to make room for a new field.

```
[x] each new release verified against its own publishing agency's calendar, not guessed
[~] etHour/etMin cross-checked for at least the next 2 real occurrences of each new release (1 occurrence live; see note)
[x] tier assignment justified in a comment, calibrated against the existing GDP/PCE/RETAIL/CLAIMS entries
[x] cli/test/econ-calendar.test.js EXTENDED (not replaced) — see the test-file rule in DSH_START_HERE.md
[x] cli/test/cli.test.js's no-directional-vocabulary assertion is unchanged and still passes
[x] node cli/econ-calendar.js --days 14 shows the new releases in a live run, with correct blackout math
[x] no new field carries a value, a consensus figure, or a direction — dates and times only
```

**Implemented 2026-09-09 (DSH).** Six releases added (exact FRED `release_name`, verified live via
`fred release list` + `node cli/econ-calendar.js --days 14`): INDPROD (G.17 Industrial Production /
Capacity Utilization, 09:15 ET), HOUSING (New Residential Construction = starts + permits, 08:30 ET),
DURABLE (Manufacturer's Shipments, Inventories, and Orders M3 = durable-goods orders, 08:30 ET), MICH
(Surveys of Consumers = U. Michigan sentiment, 10:00 ET), EMPIRE (Empire State Manufacturing Survey,
08:30 ET), PHILLY (Manufacturing Business Outlook Survey, 08:30 ET, `^`-anchored so it does not also
match the Nonmanufacturing services survey).

**Two prerequisites fixed, found while verifying G27 (both were silently breaking the whole
calendar, not just the additions):** (1) `fetchCalendar` read `res.data.release_dates` but the
`release calendar` command returns `res.data.releases` — so every live run returned an EMPTY list
and the calendar looked healthy while seeing nothing; (2) the fred CLI default `--limit 100`
truncates the date-ascending feed to the first ~2.5 days (all in the PAST), so even a correct field
name could never see an upcoming blackout — now `--limit 1000` (the FRED API's hard max, ~±18 days).

**Four of the plan's nine are NOT in FRED at all** (verified, not guessed): ISM Manufacturing PMI,
ISM Services PMI (Institute for Supply Management — private), Conference Board Consumer Confidence
(private), and FOMC Minutes as a release separate from the statement (FRED has only the daily-updated
"FOMC Press Release" and the unrelated "Discount Rate Meeting Minutes"). A regex for a name FRED never
emits would look like coverage while being dead code — so they are deliberately absent, documented in
the RELEASES comment.

**Follow-up surfaced (pre-existing, now visible because the field-name fix made the calendar real):**
the existing eight entries over-match. "FOMC Press Release" appears in FRED's feed DAILY (its
underlying target-rate series updates daily), so the FOMC entry blackouts 13:15–15:30 ET EVERY day;
GDP also matches "Debt to Gross Domestic Product Ratios"; PCE matches "Trimmed Mean PCE Inflation
Rate" (a Dallas Fed series, not the BEA release); CPI matches "Research Consumer Price Index"; RETAIL
matches "Selected Real Retail Sales Series" but NOT the actual "Advance Monthly Sales for Retail and
Food Services" headline. These are wrong blackouts in the over-restrictive direction (fail-closed, so
not unsafe) but they make the calendar misleading. NOT fixed here — they are a separate regex-precision
task, and FOMC in particular needs a real meeting-date source, not a regex.

On the `[~]`: the six new releases are monthly; the 14-day window shows one live occurrence each (e.g.
Empire State 09-15, Housing Starts 09-17, Philly Fed 09-17, Industrial Production 09-18), all matching
their fixed agency schedule. A second-occurrence cross-check would need a ~60-day lookahead, which the
FRED API's 1000-release cap (date-ascending, so it eats the past half first) cannot serve — noted, not
hidden.

---

## G28 — the app goes blind on an OPEN position and reports FLAT  ★ safety, found live

**Found live by DSH, 2026-09-14 19:31–19:47 IST.** Anoop opened his second trade of the day
(Buy 1 MNQU6 @ 29,030.25, broker TP 29,357.25 / SL 28,830.25 working). For ~16 minutes the app
did not know the position existed:

- `sessions/Now.md` 19:44 IST: **Position: FLAT**; Day P&L −$115.60 *"estimated — broker panel
  unreadable"*; Trades 1/10 *provisional*. The open +$89.50 appeared nowhere.
- `DATA/tv_broker_feed_state.json`: `wasFlat: true`, `sizeSeenThisTrade: 0`, plus a phantom row
  (`size 0, pnl +1.48, inferred: true, evidence: "degraded"`).
- `per-trade-stop` broadcast: `level: "blind" … "unrealised P&L UNREADABLE, cannot verify the
  -$300 cap (blind)"` — the guard that exists to cap a single trade could not evaluate the open
  one. Meanwhile the oversize guard refused to act, correctly, on an unreadable read.
- The broker panel's own `positions-table` returned its **empty-state placeholder**
  ("There are no open positions in your trading account yet") while a 1-lot position and a
  working TP/SL pair were live on the account — the Incident A shape, again.
- **Recovery was manual and immediate:** one `tv-broker-check-now` over the app's own WebSocket
  restored it. Straight after: `positions {success:true, visible:true, count:1, empty:false}`,
  row `MNQU6 Long 1 @ 29,030.25, Profit +89.50`, header `equity 48,609.80`, guard
  `blind:false, lastSeenSize:1`, and a `position-event: OPENED LONG 1 MNQU6`.

**Two defects, not one:**
1. **The blind window does not self-heal.** Nothing retried hard enough to re-mount the table;
   the app stayed confidently FLAT on a live position for 16 minutes.
2. **FLAT is a false statement, not "unknown".** The feed had the signal it needed elsewhere
   (the per-trade stop said *unreadable* on another channel) while the live projection said FLAT.

**Secondary:** open P&L never reaches the day number — `brokerOpenPnl / brokerTotalPnl /
brokerNetLiq` are `null` in state, so day P&L stays closed-trades-only (−$115.60) while the
account shows +$89.50 open.

**Do:** (a) when the `positions` payload carries the empty-state placeholder while the panel is
rendered-but-stale, treat it as UNREADABLE, never as flat — reuse G2's `visible`/`emptyStateText`
plumbing; (b) add a bounded retry/re-mount via the existing `trading_ensure_panel_ready` path
before the next fold decision; (c) render UNREADABLE in `sessions/Now.md`'s Position row instead
of FLAT; (d) decide explicitly whether open P&L enters the day number (display only —
enforcement must keep using realized balance).

**ACCEPTANCE:** with a position open and the positions table forced to its placeholder, the app
(a) reports Position UNREADABLE within one poll, (b) alarms on the same channel as
`per-trade-stop`, (c) recovers with no manual `tv-broker-check-now`, and (d) a test pins
"placeholder + known-live position ≠ flat". Suite green.

**NOT to be landed mid-session** — it touches the guard paths Anoop is trading behind.

---

## G29 — the app cannot place an order at all: no ticket, no hands  ★ safety, found live

**Found live 2026-09-15 (DSH).** Anoop was SHORT 8 MNQZ6 against a size cap of 4. The oversize
guard detected it correctly and tried to reduce — **three times, every one failed**:

```
{"observed":{"size":8,"side":"SHORT","symbol":"MNQZ6"},"sizeCap":4,"action":{"side":"buy","qty":4},
 "mode":"reduce","submitted":false,"result":{"success":false,
 "error":"side control button not found: side-control-buy"},"durationMs":27}
```

(08:33:28Z, 08:34:03Z, 08:34:38Z = 14:03–14:04 IST. Log: `DATA/protocols/oversize-guard.jsonl`.)

**Root cause, verified by DOM inspection over CDP:** `trading_place_market_order` assumes
TradingView's ORDER TICKET is already open — it queries `[data-name="side-control-buy"]` and
`[data-name="place-and-modify-button"]` inside `.trading-panel-content`. On this machine the
ticket is NOT mounted, so both selectors return 0 elements and the call fails in ~20ms:

```
side-control-buy: 0   side-control-sell: 0   place-and-modify-button: 0
.trading-panel-content: 1  (that is the BROKER panel: Positions/Orders/Account summary)
buy-order-button: 1   sell-order-button: 1   (inside [data-name="buy-sell-buttons"])
```

**Nothing in tradingview-mcp opens the ticket** — `grep -rn "order-ticket|buy-order-button" \
tradingview-mcp/src` returns zero hits outside comments. So this is not only the guard: a
CONFIRMED trade ticket from the Judge would fail the same way. The Phase-2 confirm/execute flow
has never been able to place an order, exactly as `TODOS.md` warned ("built, not live-verified").

**⚠ OPERATIONAL WARNING FOR WHOEVER PICKS THIS UP.** `[data-name="buy-order-button"]` /
`sell-order-button` are **NOT "open the ticket" buttons — they are one-click market orders**.
DSH verified this the expensive way on 2026-09-15: a JS `.click()` and a real CDP mouse click on
BUY each filled 1 lot (14:05:41 @ 29,273.00, 14:06:10 @ 29,278.75), opening an unintended 2-lot
long that then also left a bracket **Sell Stop 2 @ 29,261.75 (order 650961251054) working with no
position**. Never "test" a trading control by clicking it. Inspect the DOM, read the order
tables, and only click a control whose label states exactly what it does.

**Do:** (a) give the order path a way to open the ticket before it needs the ticket's controls —
the widget buttons or the panel's trade affordance, driven by real `Input.dispatchMouseEvent`
(a plain `.click()` did not open anything either); (b) then set side/qty and submit exactly as
today; (c) add a `trading_cancel_order` primitive — there is none, which is why a stray working
order could not be cancelled programmatically (DSH's UI attempts failed: the Cancel control
`close-settings-cell-button` exists but is hover-revealed and the synthetic click did not take).

**STATUS 2026-09-15 — BUILT by DSH, commit `4aa49b3`, NOT yet live-verified.**
`tradingview-mcp` now has: `trading_probe_order_entry` (READ-ONLY, ungated — reports which
entry path exists and the size currently on the widget); `placeMarketOrder` probing first and
taking the buy/sell-widget path when no ticket is mounted (refusing loudly when neither exists,
and REFUSING a stop/target request on the widget path rather than placing a naked position);
a strict pre-click size check that reads the size back off `qtyEl` and aborts on any mismatch;
`dryRun` (stages everything up to the click and stops); post-submit verification by ORDER-ID
DIFF (the old check passed on any pre-existing order for the symbol — it could report success
without this call having placed anything); and `trading_cancel_order` (gated, verifies by
re-reading the status, restores the previous tab) — the first cancel primitive in the project.
Unit tests: `tradingview-mcp/tests/order-entry.test.js`, 13 tests, all pass.

**Next, in this order — do NOT skip 1 and 2:** (1) restart the app so the mcp child process
loads this code (the bridge spawns `tradingview-mcp` as a child; the running instance still has
the old build); (2) run the probe, then `place_market_order` with `dryRun: true` — both click
nothing, and (2) proves the size read-back end to end; (3) ONLY with Anoop's explicit go-ahead
and him watching: one real 1-lot order through the new path, verified in the broker's own orders
table, then closed. **The one step that could not be verified read-only is whether clicking
`qtyEl` opens its editor** (the widget has no `<input>` until it does) — if it does not, the
read-back fails and the code refuses to click, which is the correct failure mode, and the next
attempt should drive the field by keyboard instead.

**ACCEPTANCE:** with the ticket closed and a position open, (1) the guard's reduce SUCCEEDS and
the position is reduced by exactly the overage, verifiable in the broker's own orders table;
(2) a confirmed trade ticket places one market order of the confirmed size; (3) a pure test pins
"ticket not open ⇒ open it, do not assume the click missed"; (4) cancel works from the app.
**All of it must be verified on the real account outside a live session, with Anoop watching.**

---

## EXCLUDED — do not build these, and here is exactly why

Two things are out of scope. Neither is an oversight and both were considered in full. **If you
think one of them should be in the queue, raise it with Anoop — do not just build it.**

### X1 — `PIVOT_LEG` 2 → 1, and every other tuning of the structure classifier — **REJECTED**

Anoop asked directly whether the `>= 2 pivot highs AND >= 2 pivot lows` requirement should drop
to 1. The answer is that **it would change nothing, because that branch never executes**:

```
40-bar window (what readHTFNow actually feeds):
  PIVOT_LEG=1   clean 62.6%   too-few-pivots  0.0%
  PIVOT_LEG=2   clean 61.5%   too-few-pivots  0.0%   ← current
  PIVOT_LEG=3   clean 55.9%   too-few-pivots  7.1%

window sweep at leg 2:   24 bars 50.5%  ·  40 bars 61.5%  ·  60 bars 61.4%  ·  80 bars 61.9%
```

**Every one of the 458/1189 `unclear` verdicts (38.5%) is a MIXED structure** — a higher high with
a lower low, an expanding range — not a pivot shortage. Dropping the threshold to 1 also breaks the
comparison outright: with one pivot high there is no previous high to call it "higher" than.

`PIVOT_LEG` 2→1 buys **+1.1pp** and flips ~90 reads bear→bull — measured on the **1H**, a timeframe
that can no longer veto anything, and it reads *worse* on the 15M, which is the one that decides.
40 bars is already the plateau; more history buys nothing.

> **The classifier is not the problem.** The market is genuinely two-sided ~38% of the time and the
> reader is correctly saying so. What was wrong is what the *callers* do with `unclear` — which is
> G4, G5 and G20, all of which are in the queue. Do not reopen the classifier.

**`LEVEL_TOL` is the one exception**, and only for the plumbing: G21 unifies the three copies and
rewrites the comment. **The value stays 0.0005.** It sits inside the measurement noise band
(0.0004 → 73.8%, 0.0005 → 70.6%, 0.0006 → 73.0%) and the dataset cannot support tuning it — the
tolerance response is non-monotonic and the confidence interval is 18 points wide.

### X2 — The C-ADX entry redesign — **BLOCKED, NOT REJECTED**

★ **This is the thing Anoop originally asked for.** It is not forgotten and it is not dead. Three
proposals were designed and **all three adversarial verifiers died on a session limit before
returning a verdict.** `survives` is `null` on every one.

They are unverified, and each author's own `weakestPoint` field flags something that looks fatal:

| Proposal | Idea | Author's own weakest point |
|---|---|---|
| **Size-Derived C-ADX** | signal untouched; replace the binary 75-pt skip with constant-dollar-risk sizing | **"There will not be enough of them for that to matter."** 2.89 tradeable/month historically, **0.91/month over the last 69 trading days** — 12 raw signals, 3 surviving the cap — before the 15M gate halves it again |
| **Cap-Fitted Retest Entry** | limit entry on a retrace instead of the breakout-bar close; stop stays anchored to the breakout bar | **ZERO fills on 30M** across 457 bars. And per-regime it gets *worse* in the most recent regime — the one he is actually trading |
| **C-SOR** (Session Opening-Range Break) | keep the ADX regime read, throw away the Donchian trigger and the 1H clock; 5M breaks of the London/NY opening range | Frequency arithmetic is solid (~42 window-opportunities/month). **The edge is unmeasured and the outcome sample is ONE trade** |

**What has to happen before any of these becomes a task:**

1. Re-run the three adversarial verifiers (the workflow resumes from cache — only the verifiers and
   the synthesis re-run). Session limits reset ~8:30pm IST.
2. Any survivor needs an **out-of-sample** test. Two of the three were fitted on ~457 30M bars or
   ~1,240 1H bars, which is not enough to distinguish an edge from noise at these frequencies.
3. It must be re-derived **at 2 contracts**, not the 1 contract every published DSH number uses.
   `playbook-spec.js`'s own header says the edge survives the size change but the *parameters* do
   not: ADX ≥ 35 was consistency-safe at 1 contract and is borderline at 2, where ADX ≥ 25 reads
   better. Copying the published config is the specific mistake that header exists to prevent.

**Meanwhile, G19 is in the queue and is the prerequisite for all of this** — C-ADX currently writes
**zero** rows when it fires, so its block rate has no denominator and none of the three proposals
can be measured against live behaviour. Build G19 first regardless of which proposal wins.

### Deliberately left alone (checked, correct as built)

- **FVG 30M being ungated** — it is already the alert-only state the `unclear` proposal asks for.
  It was deliberately demoted below the level where a gate would mean anything: tagged `FVG-ONLY`
  and stripped of `armSetup` on 2026-09-01.
- **The two 1H reads** (panel 60-bar vs PO3 30-bar) are not a real conflict — checked and clean.
- **The 35-minute `STALE_AFTER_MINUTES` threshold itself** is correct for a 15M-deciding gate;
  arithmetic verified. G15 is about it not being *consulted*, not about its value.
- **`po3TrendCache`** — `DATA/autonomy/*/orders.jsonl` carry `hourTrend` in the strength vocabulary
  (`WEAK BEAR` / `WEAK BULL` / `NEUTRAL`, 20 rows measured). The pivot classifier emits
  `bullish`/`bearish`/`unclear`, which has **no overlap** with that vocabulary — repointing it would
  silently make the autonomy discriminator compare two incompatible label sets across the cutover.
- **The 4H read itself** (`getTrendForTF('240')`) — Anoop asked for it on 2026-09-05 and reads
  4H/Daily manually. **G12/G13/G14 relabel it; they do not repoint it.** A naive repoint of
  `aligned` onto 15M-vs-1H would smuggle back the veto `htf-alignment.js` already measured and
  rejected: the badge would go PENDING on **135/185 = 73.0%** of the instants the gate is open.
- **Re-enabling Telegram** — server.js:14061 records Anoop's decision (*"I don't want telegram to
  work... remove them."*). G18 makes the deadness legible; it does not undo the decision.
