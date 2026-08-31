# Autonomy Modes — MYSELF / SHADOW / CONTROL

**Written 2026-08-29** at Anoop's request: *"i want to continue building the 3
mode Myself, shadow, control ... give me the exact details of each and how they
function ... each should be separate and should function differently but will
share the same data of the account ... how we can go from manual to fully
automatic trading?"*

Supersedes `FULL_AUTONOMOUS_SYSTEM_PLAN.md` (written before `autonomy-gate.js`
existed). That file's circuit-breaker and audit-trail arguments still hold and
are folded in below.

---

## 1. Where this actually stands today (audited, not remembered)

The three modes are **already in the code**. What is missing is not the toggle —
it is everything the toggle was supposed to switch between.

| | Built? | Reality |
|---|---|---|
| **MYSELF** (`off`) | Complete | This is the whole app you run daily. Monitors, alerts, guardrails, Jessi, day record, mistake patterns. Nothing to build. |
| **SHADOW** | Records, never scores | It writes orders. It has **never produced a single scored result.** |
| **CONTROL** (`live`) | Gate only, no engine | The gate that grants LIVE exists. **Nothing connects it to placing an order.** |

### The kill switch is already off — the live-trading confusion is already gone

`rules.json` → `autonomyEnabled: false` (set 2026-08-26 at your instruction).
While that is false: the CONTROL toggle is **hidden in the UI**, the WebSocket
handlers refuse, both recorders are inert, and the resolver never ticks. You are
in MYSELF mode and cannot accidentally leave it. Keeping it false during this
build costs nothing structurally — every module stays under test.

### The finding that matters most: SHADOW cannot currently produce evidence

`DATA/autonomy/` right now:

```
state.json              mode: off, shadowDays: 2
decisions.jsonl         9 mode requests
shadow-orders.jsonl     5 rows -> 2 machine orders, 3 of your own trades
shadow-outcomes.jsonl   DOES NOT EXIST
```

**Both machine orders were auto-blocked**, and the reason is structural:

- `rules.json` `perTradeMaxLoss` = **$300**; MNQ = **$2/point**
- `dshV2.shadowSizes` = **[4, 6]** contracts
- Max survivable stop: **37.5 pts at 4c**, **25 pts at 6c** (75 pts at your real 2c cap)
- The Playbook B setup that fired had a **79.5-point stop** → $636 at 4c, $954 at 6c

Every Playbook B setup is wider than the risk limit allows at those sizes, so
every one gets stamped `blocked: risk-too-big`. Blocked orders are excluded from
`pendingMachineOrders()`, so the resolver has **nothing to resolve, ever**.

> SHADOW could run for a year and the CONTROL gate would still read
> *"needs 40 resolved trades, has 0."* This is the first thing to fix, and it is
> a config/sizing bug, not a rewrite.

### Two more gaps worth naming before designing on top

1. **`handleTradeConfirm` never consults `autonomy-gate`.** The only code path
   that can place an order is gated by `TV_ALLOW_LIVE_ORDERS`, `trade-confirm-rules`
   and the dedup guard — but not by the CONTROL toggle. Granting LIVE today
   changes a badge and nothing else.
2. **`oversize-guard` already acts on the account autonomously**, outside the
   gate entirely. It is the one piece of real autonomy shipped, and it is not
   under the switch that is supposed to govern autonomy.
3. `evaluateAutonomy('B')` **hardcodes Playbook B**. Evidence from A and C is
   collected and then never read by the gate.

---

## 2. Three modes is one rung short — the missing step is why it feels like a cliff

Manual → fully automatic is not a two-step journey. Between *"the app watches"*
and *"the app trades unattended"* sits the step where **the app decides and you
approve, one trade at a time.** That step already half-exists in this repo (the
Debate Judge's `TRADE_TICKET` → your Confirm click → `handleTradeConfirm`), it is
just not wired to the mode system.

Proposed ladder — **four rungs, each a superset of the last**:

```
  MYSELF  -->   SHADOW   -->   ASSIST    -->   CONTROL
    you        machine        machine         machine
  decides      decides        decides         decides
    you        nothing      YOU APPROVE       machine
  executes     executes       each one       executes
```

Each rung adds exactly **one** new thing that can go wrong. That is the whole
point of the ladder: when something breaks you know which capability broke.

---

## 3. Exact definition of each mode

Shared vocabulary: a **setup** is what a detector confirms; a **plan** is
`playbook-spec.planEntry()`'s entry/stop/target; a **ticket** is a plan sized to
contracts; an **order** is a ticket submitted to the broker.

### 3.1 MYSELF — `mode: 'off'` (today, and the fallback forever)

| | |
|---|---|
| **Who decides** | You |
| **Who sizes** | You |
| **Who enters/exits** | You, by hand in TradingView |
| **App's job** | Detect, warn, coach, record, enforce discipline |
| **Can place an order?** | **No** |
| **Writes to** | day record, signal ledger, journal, mistake patterns |
| **Badge** | `YOU ARE TRADING` |
| **Failure mode** | The app is wrong and you ignore it. Costs nothing. |

Everything already built lives here. **This rung never gets removed** — every
higher rung must be able to fall back to it in one action.

### 3.2 SHADOW — `mode: 'shadow'` (the evidence engine)

| | |
|---|---|
| **Who decides** | Machine — silently, in parallel with you |
| **Who sizes** | Machine, from a risk-derived size (see §5.1) |
| **Who enters/exits** | Nobody. Simulated against real bars by `backtest.simulateTrade` |
| **Can place an order?** | **No — architecturally incapable** |
| **Writes to** | `DATA/autonomy/shadow/{orders,outcomes}.jsonl`, `daily/` |
| **Badge** | `SHADOW — recording, not trading` |
| **Failure mode** | Records a trade that could never have been placed → a fake track record. This is the *only* real risk of SHADOW, and §5 Phase 0/1 exist to close it. |

**It records two independent streams, and the third thing is the prize:**

- **Machine shadow** — the exact order the app *would* have sent, scored by price.
- **Human shadow** — every trade *you* actually took, with market **and behavioural**
  context at entry (trade number today, minutes since last loss, size-up-after-loss,
  day P&L before). Winners *and* losers — a feature only predicts if it **separates**
  the two, so the losers are the control group.
- **The delta between them** — on the same market, did your discretion **add or
  subtract** value versus the mechanical version? Nothing in this repo can
  currently answer that, and it is the single number that should decide whether
  you ever hand over control.

SHADOW is the only rung that can run **at the same time as** you trading. It
should be **silent by default** while it does — no chat tickets, no badge
changes — precisely because that noise is what confused you during a live session.

### 3.3 ASSIST — `mode: 'assist'` (NEW — the missing rung)

| | |
|---|---|
| **Who decides** | Machine |
| **Who sizes** | Machine (risk-derived, hard-capped at `sizeCap`) |
| **Who approves** | **You — every single trade, explicitly** |
| **Who enters** | Machine, after your click, via `handleTradeConfirm` |
| **Who exits** | Bracket set at entry (TP/SL, already live-verified) + you |
| **Can place an order?** | **Yes — one click, one order** |
| **Writes to** | `DATA/autonomy/assist/` + the normal day record |
| **Badge** | `ASSIST — you approve every trade` |
| **Failure mode** | A bad ticket you approve on autopilot. Bounded by the size cap and by the fact that you saw it. |

This rung is worth more than it looks. Every ticket you **reject** is a labelled
data point: *the machine wanted this, you said no, here is what happened next.*
That is a supervised signal you cannot get from SHADOW (where you never see the
ticket) or CONTROL (where you never get asked).

Most of the plumbing exists: `trade-confirm-rules.js`, `trade-confirm-dedup.js`,
`trade-ticket-parse.js`, the ticket UI, and the TP/SL DOM automation. What is
missing is feeding it from the **detectors** rather than only from a Debate
verdict, and putting it behind the mode switch.

### 3.4 CONTROL — `mode: 'live'` (fully automatic, inside an envelope)

| | |
|---|---|
| **Who decides** | Machine |
| **Who sizes** | Machine |
| **Who approves** | Nobody — pre-authorised by the envelope you set in advance |
| **Who enters/exits** | Machine, including managed exits |
| **Can place an order?** | **Yes, unattended** |
| **Writes to** | `DATA/autonomy/control/` + day record + a live event stream |
| **Badge** | `CLAUDE IS TRADING` |
| **Failure mode** | Every bug costs real un-reviewed money on **every** occurrence, not just the ones you happen to be watching. |

CONTROL is not "ASSIST without the click." It needs three things ASSIST does not:

1. **Managed exits** — nobody is watching the position.
2. **A dumb circuit breaker** — hardcoded, not in `rules.json`, so no config or
   prompt drift can raise it.
3. **Reconciliation** — after every order, verify the broker actually holds the
   position the app thinks it does.

---

## 4. Separation model — separate machinery, one account truth

Your requirement: *"each should be separate and should function differently but
will share the same data of the account."* That splits cleanly.

### SHARED — one source of truth, never forked per mode

- `tv-broker-feed.js` — live positions, balance, P&L
- `rules.json` — every limit
- `DATA/day_trades__<slot>` — the day record (all fills, whoever placed them)
- `DATA/signals/` — the signal ledger
- `detectors.js` + `playbook-spec.js` — setup detection and plan building
- `mcp-bridge` / `barCache` — the single TradingView connection

**Why:** the moment two modes disagree about what the account holds, every
guardrail built on that number is guessing. One account, one truth.

### SEPARATE — per mode, and deliberately not merged

```
DATA/autonomy/
  state.json                 <- which mode is active, who armed it, when
  decisions.jsonl            <- every mode request, granted or refused
  shadow/   orders.jsonl  outcomes.jsonl  daily/
  assist/   orders.jsonl  outcomes.jsonl  daily/  + approvals.jsonl
  control/  orders.jsonl  outcomes.jsonl  daily/  + interventions.jsonl
  human/    trades.jsonl     <- your own trades, all modes, one stream
```

**The rule that makes this work:**

> **Evidence is transferable between modes only when the
> `(playbook, size, exitPolicy)` tuple is identical.**

SHADOW's profit factor at 1 contract with simulated fills does **not** describe
CONTROL at 2 contracts with real slippage and a different exit rule. Merging
those records would let a good shadow number promote a system that has never
existed. Separate folders make that mistake impossible to make by accident.

Each mode also gets its **own enable flag**, so SHADOW can run while CONTROL is
not merely off but **not rendered**.

---

## 5. What is missing — the build list, in dependency order

### Phase 0 — make SHADOW capable of producing evidence — **BUILT 2026-08-29**

| # | Work | Status |
|---|---|---|
| 0.1 | **Shadow sizing fixed** — sizes now come from `autonomyModes`, pinned to `[2]`, replacing the `dshV2.shadowSizes` `[4,6]` that made every setup unrecordable. | ✅ All 6 measured Playbook B setups now record (was 0). |
| 0.2 | **Silent shadow** — `autonomySilent()` suppresses the chat ticket; the record is still written. Silence suppresses the *notification*, never the data. | ✅ |
| 0.3 | **Resolver off the hot path** — 15-min cadence (was 5), and it skips entirely during a session window or while an order is in flight. | ✅ |
| 0.4 | **Per-playbook evidence** — `evaluateAutonomy()` no longer hardcodes `'B'`; it evaluates every configured playbook and reports each one's verdict and blockers. | ✅ Autonomy is now granted **per playbook**. |
| 0.5 | **CONTROL risk-cap filter** — evidence read for LIVE excludes rows over CONTROL's $200 cap. | ✅ §8.1 requirement enforced. |
| 0.6 | **ASSIST rung** — added to the gate and the UI, gated on a human but not on the evidence bar. | ✅ |
| 0.7 | **Per-mode enable flags** — a mode that is not enabled cannot be entered even by a hand-crafted WebSocket message, and gets no button. | ✅ |

**Deferred deliberately:** the per-mode **folder split** (§4). Rows now carry a
`mode` field instead, which gives the same separation semantically at a
fraction of the churn. The folder split belongs in Phase 2, when ASSIST
actually starts writing a second stream — splitting now would touch every read
and write path in `autonomy-store.js` for no functional gain while only SHADOW
produces data.

**Two real bugs were found and fixed while building this**, both the same
shape: `Number(null)` is `0`, and `0` passes every risk cap. An order whose
risk failed to compute was being treated as the *safest* order in the file
rather than the most suspect — once in `checkOrderRisk`, once in the evidence
filter. Caught by the first run of the new test file, not by inspection.

### Phase 1 — make the record describe a system that could actually exist

| # | Work | Why |
|---|---|---|
| 1.1 | **`exit-policy.js`** — one pure module: initial bracket, break-even move, partial, trail, time stop, hard flatten at `flattenByISTMinutes`. | Nothing manages an open position today. *"Enter **and exit with profits**"* is half unbuilt. |
| 1.2 | Use it in **all three** consumers: `backtest.js`, the shadow resolver, and the live path. | If backtest and shadow score differently, the track record describes neither. |
| 1.3 | Stamp an `exitPolicy` id on every order row; key evidence on `(playbook, size, exitPolicy)`. | Makes §4's transferability rule enforceable instead of aspirational. |

### Phase 2 — the ASSIST rung

| # | Work |
|---|---|
| 2.1 | Add `'assist'` to `MODES`; gate returns it; UI gets a fourth button. |
| 2.2 | `handleTradeConfirm` **consults the gate** — refuse unless mode is `assist` or `live`. Single choke point preserved. |
| 2.3 | Feed tickets from `armSetup` (detectors), not only from a Debate verdict. |
| 2.4 | Record **approve / reject / expire** to `assist/approvals.jsonl` — the discretion-vs-machine signal. |

### Phase 3 — CONTROL

| # | Work | Why |
|---|---|---|
| 3.1 | `autonomousExecute()` — the no-click path, still routed through the one order choke point. | |
| 3.2 | **Dumb circuit breaker**, hardcoded in the module, **not** `rules.json`: max autonomous trades/day, max autonomous daily loss, consecutive-loss halt, one position at a time. | Rules-based limits are "smart" and readable by agents. This layer must be un-reasonable-around. |
| 3.3 | **Auto-demote to SHADOW** on: breaker trip, feed stale, TV disconnect, unresolved position mismatch, server restart. Requires explicit re-arm — never a timer. | |
| 3.4 | **Position reconciliation** after every order: read the broker back, compare to intent, halt on mismatch. | Nothing reconciles today. |
| 3.5 | **One-action kill from anywhere** — Telegram `/flatten` + `/control off`, tested weekly. | You will not always be at the desk. |
| 3.6 | **Bring `oversize-guard` under the gate** as CONTROL's first sanctioned autonomous action. | It is already autonomous and currently outside the switch meant to govern autonomy. |

---

## 6. The promotion ladder — and the honest timeline

Current LIVE bar (`autonomy-gate.js` `LIVE_REQUIREMENTS`): 40 resolved trades,
profit factor ≥ 1.3 after costs, 20 shadow days, observed drawdown < 40% of the
account limit, armed by a human.

**Measured setup rate from your own signal ledger, 24–29 Aug: 6 confirms over 6
trading days ≈ 1 per day.**

> **40 resolved trades ≈ 40 trading days ≈ 8 trading weeks — and the clock has
> not started, because nothing has resolved yet.**

That number is the most decision-relevant thing in this document. Full automation
is a **two-to-three month evidence project**, not a build. The build is the small
part. Which is exactly why Phase 0 should ship first and SHADOW should start
running immediately, silently, while the rest gets built — otherwise the 8 weeks
starts *after* the build instead of during it.

Proposed gates for each promotion — each mode earns the next on its **own** record:

| Promotion | Requires |
|---|---|
| MYSELF → SHADOW | Nothing. It cannot lose money. |
| SHADOW → ASSIST | 20 resolved machine orders, PF ≥ 1.0, and you have read a week of tickets and agree they are tradeable |
| ASSIST → CONTROL | The existing bar (40 trades / PF 1.3 / 20 days / DD < 40%) **plus** 15 consecutive sessions with zero execution incidents, **plus** the exit policy proven on real fills, **plus** reconciliation clean 100% |
| Any → MYSELF | One click, always, from anywhere |

---

## 7. Keeping it disabled while it gets built

Keep `autonomyEnabled: false` as the master switch. Add **per-mode flags
underneath it** so the modes can be finished and turned on one at a time:

```jsonc
"autonomyEnabled": false,        // master — false = MYSELF only, toggle hidden
"autonomyModes": {
  "shadow":  { "enabled": false, "silent": true },
  "assist":  { "enabled": false },
  "control": { "enabled": false }
}
```

A mode with `enabled:false` is **not rendered at all** — not a greyed-out button.
A visible switch that does nothing invites a click that silently fails.

**Recommendation, and the one thing here worth pushing on:** finish Phase 0,
then turn on **`shadow` with `silent: true` only**, with ASSIST and CONTROL still
hard-off and invisible. It cannot reach the broker, it cannot show you anything
mid-session, and it starts the 8-week clock now instead of in November.
Everything else can be built at whatever pace you want while it quietly
accumulates the record that decides whether any of this is worth switching on at
all.

---

## 8. Decisions — LOCKED 2026-08-29

| # | Decision | Anoop's answer |
|---|---|---|
| 1 | Accept the 4th rung (ASSIST)? | **Yes** |
| 2 | Shadow sizing | **Pinned to the real `sizeCap` of 2** |
| 3 | CONTROL daily loss ceiling | **$200** |
| 4 | Which playbooks may CONTROL trade | **All three** |

### 8.1 Decision 3 needs one more number, because $200 is smaller than one trade

Measured stop distances, running the real detectors over the cached bar sets
(`DATA/bars/`, `scratchpad/risk-dist.js`):

| Playbook | Setups | Median stop | Risk @2c | Range @2c |
|---|---|---|---|---|
| **B** (30m, ~9 days) | 6 | 48.3 pts | **$193** | $155 – $291 |
| **LTF-ENGULF** (60m, ~43 days) | 1 | 29.0 pts | $116 | — |
| **A** (60m, ~43 days) | **0** | — | — | — |

**One typical Playbook B trade at 2 contracts risks $193. The stated daily
ceiling is $200.** So as written, CONTROL takes one trade, and if it loses, the
day is over — and in the widest case it loses **$291, overshooting the $200
ceiling by 46%** before anything can stop it.

A daily loss limit is only a *ceiling* if per-trade risk divides into it.
Otherwise it is a *halt trigger* that fires after the damage.

**1 contract is not the escape hatch.** `rules.json` `sizeFloor: 2` exists
because one-contract trading was measured as a loser in both stages (eval 25%
win rate / -$361 over 12 trades; funded -$345 over 13) — *"sizing down to 1 is
not caution, it is what hesitation looks like in the ledger."* CONTROL must
trade 2.

**Resolution — add a CONTROL-specific per-trade risk cap of $200** (tighter than
the general `perTradeMaxLoss` of $300):

```
CONTROL per-trade risk cap : $200   (= 50 pts max stop at 2 contracts)
CONTROL daily loss ceiling : $200   (hardcoded in the breaker)
=> exactly ONE full loser per day, and $200 is a REAL ceiling
   (overshoot is slippage only, ~$5-10, not $91)
```

Cost of this: CONTROL skips the widest ~33% of Playbook B setups (2 of the 6
measured were $200–291). That is the price of the ceiling being true, and it is
the right trade — an ambiguous limit on an unattended system is worse than a
tight one.

**Consequence for SHADOW:** shadow records at 2c under the general $300 cap, so
it will record setups CONTROL would have skipped. Evidence read *for CONTROL*
must therefore be filtered to rows with `riskUsd <= 200`. Cheap — a filter at
evidence time, no extra shadow sizes needed — but it must not be forgotten, or
CONTROL gets promoted on a record containing trades it is not allowed to take.

### 8.2 Decision 4 — "all three" is really two, and one of them is unsanctioned

- **Playbook C is a GATE, not a setup.** `playbook-spec.js` marks it
  `isGate: true` and `planEntry()` explicitly refuses it: *"Playbook C is a
  validity gate, not a setup — it proposes no entry."* It filters A; it cannot
  produce a trade. What the UI calls "Playbook C" maps to the **LTF-ENGULF**
  spec, which is separately marked **"UNSANCTIONED, under evaluation."**
- **Playbook A produced 0 setups in ~43 days** of 60m bars — it needs 4H
  alignment and is genuinely rare.

So the grant in practice is: **B (the workhorse, ~1/day) + LTF-ENGULF (rare,
unsanctioned) + A (rarer still).** Worth confirming you intend CONTROL to trade
LTF-ENGULF given its own spec calls it unsanctioned — see §9.

---

## 9. Follow-up decisions — LOCKED 2026-08-29

| # | Decision | Anoop's answer |
|---|---|---|
| 5 | Does CONTROL trade LTF-ENGULF despite its "UNSANCTIONED" marking? | **Yes** |
| 6 | Does the $200 daily stop auto-reset next day, or require re-arming? | **Manual re-arm** |

Manual re-arm is the stronger choice and worth stating plainly: once CONTROL
takes its one full loser, **it stays in SHADOW until Anoop personally switches it
back on.** No timer, no midnight rollover. A breaker that resets itself lets a
bad week run five unattended days; this one cannot.

---

## 10. The settled configuration

```
MYSELF   always available, always the fallback, one click from anywhere
SHADOW   size 2 (= real sizeCap), general $300/trade cap, SILENT by default
ASSIST   size 2, general $300/trade cap, Anoop approves every ticket
CONTROL  size 2 (sizeFloor forbids 1)
         per-trade risk cap  $200   <- tighter than the general $300
         daily loss ceiling  $200   <- hardcoded breaker, = one full loser
         on trip             demote to SHADOW, MANUAL re-arm only
         playbooks           A + B + LTF-ENGULF
```

Evidence read for CONTROL must filter shadow rows to `riskUsd <= 200`, since
SHADOW records under the looser $300 cap (see §8.1).
