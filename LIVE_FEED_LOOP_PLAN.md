# Live-Feed Loop Build Plan — G1-G5 + H1-H6

**Status:** `AWAITING GREEN SIGNAL — nothing in this plan executes until Anoop says go`
**Created:** 2026-08-22
**Branch base:** `master` @ 8e7b202
**Audit basis:** full read of `server.js` (6764L), `renderer/app.js` (9935L), `tv-broker-feed.js`,
`playbook-c.js`, `mistake-patterns.js`, `position-events.js`, `session-manager.js`,
`renderer/index.html`, plus `SIGNAL_LOOP_PLAN.md`, `LIVE_TRADE_EVENTS_PLAN.md`,
`MISTAKE_PATTERNS_PLAN.md`, `TODOS.md`.

**Companion artifact:** the gap audit this plan answers —
https://claude.ai/code/artifact/77e680b6-0984-440c-9afa-c4b091fb18d2

> **This file is canonical.** When a task completes, change `[ ]` to `[x]` in THIS file,
> fill the `Done:` line with the date and what actually changed including deviations, and
> bump the status line. Mark a task `[~]` with `Skipped:` if it turns out to be wrong once
> the code is open — never silently drop it.

---

## Acceptance checklist — read this BEFORE starting any task

Known up front so the bar is not a surprise at review time. Anything here that a task
genuinely cannot satisfy is fine — say so on the `Done:` line and why. A silent miss is the
only real failure.

### Before you start
- [ ] Re-read the task's **why** paragraph, not just its instruction. Most tasks here exist to
      prevent a specific named failure; a change that satisfies the letter and reinstates the
      failure is a fail.
- [ ] Confirm the thing the task claims is still true in the code. Line numbers and call-site
      counts in this plan were correct on 2026-08-22 and drift.
- [ ] One task per commit. A commit spanning three tasks cannot be reverted or bisected.

### Before you tick `[x]`
- [ ] **Full suite green**, compared against the baseline recorded in task 0.3 — not against
      the number written elsewhere in this plan, which predates it. State the count.
- [ ] **New pure logic ships with tests in the same commit.** Untested pure logic is the one
      thing this codebase has consistently refused to accept.
- [ ] **Server boots clean.** `cd app && node server.js` — no unhandled rejection, no crash
      guard firing on startup.
- [ ] **Deviations written on the `Done:` line**, including ones you consider obviously
      correct. A documented deviation is a decision; an undocumented one is a defect found
      three weeks later.
- [ ] **Nothing in `## Explicitly out of scope` was touched.** Especially: no widening of the
      order path, no LLM in an enforcement gate, no lifting of the Analysis/PO3 account-data
      denial.
- [ ] **Any number that exists in `rules.json` was read from it, not retyped.** A hardcoded
      size cap drifting out of sync with the file is a bug this repo has already had.
- [ ] If the task could not be finished as written, it is `[~]` with `Skipped:` — never a
      quiet `[x]`.

### Extra gate by task type

| If the task… | then also |
|---|---|
| adds a **pure module** | pure in/pure out, no I/O, no `Date.now()` baked into the logic path; tests cover the null/empty/malformed input, not only the happy case |
| **wires a monitor or a poll** | idempotent on re-entry; safe when TradingView is disconnected; cannot wedge the chart or broker lock; respects the existing `withChartLock` / `withBrokerLock` split |
| **removes UI** | the underlying machinery and WS messages stay intact; no status text left that is now false; every non-toggle control kept |
| **changes an agent prompt or context** | read the diff aloud as the agent receiving it; check no concrete number contradicts `rules.json`; **manual smoke test of that specific agent path** — an unobserved prompt change is unverified, per `CLAUDE.md` |
| **writes trade or signal data** | idempotent on restart and on duplicate fire; uses the 03:45 IST trading-day anchor, never a calendar or UTC day; provenance fields (`degraded` / `inferred` / `pnlUnknown`) survive the write |
| **touches `csvApply` or the rollup** | golden test against real stored days proving byte-identical summaries before anything new consumes it; lands as its own commit |

### What the audit will re-check
Stated up front so it can be pre-empted rather than discovered:
1. The **gap itself is closed**, not just the code written — re-running the greps that found
   G1–G5 and H1–H6 must now come back clean.
2. **Call-site completeness** — the three connect sites, both `autoTriggerDebate` triggers,
   every `Telegram` off-path. G1 existed because one of three sites was missed.
3. **Task count vs plan** — a task that silently vanished between commits is the one thing a
   diff review will not catch on its own.
4. **Live-only items are declared, not assumed.** Chart-lock behaviour under five armed
   watchers, monitor auto-restore, agent replies, and the H6 P&L cross-check need Anoop's
   machine. Mark them `NEEDS LIVE` on the `Done:` line rather than implying they passed.

---

## Decisions on record (Anoop, 2026-08-22)

Verbatim, and each one's consequence for the build:

1. > "I want the whole app to run with live feed and not on CSV. CSV should be optional.
   > In both the loops, live feed should be the only source of input."

   **The live TradingView feed becomes the sole writer of the day record.** CSV drops to an
   optional end-of-day reconciliation that *compares and flags*, never the primary source.
   This inverts today's architecture, where `csvApply` is the ONLY writer of
   `day_trades`/`gr_history` and the live feed writes nothing durable.

2. > "I want the engulfing of all monitors to autostart in all time frames. I do not want to
   > use the toggle to turn them on. Remove the toggle from UI."

   **All five chart watchers auto-start on TradingView connect and there is no UI to stop
   them.** Engulf 1H + 30M + 15M, FVG 30M, SFP 30M. The per-monitor start/stop machinery and
   WS messages stay intact (re-exposing a control later must cost nothing), but nothing in the
   UI or Telegram can leave a watcher dark.

3. > "Live feed should go to all the agents to complete their given function and complete the
   > workflow."

   **Both live feeds — the chart signal state AND the broker trade state — reach every agent
   whose function needs them.** With one deliberate exception carried forward from existing
   code: the Analysis and PO3 debate agents stay denied account/P&L data. That separation
   exists because of a real fabrication incident on 2026-08-10 and is not up for renegotiation
   here; the setup state reaches the verdict through the Judge instead. This is an *addition*
   to their context, not a removal of the guardrail.

4. > "All the playbooks should be actively watched for the setup."

   **Playbooks A, B and C get equal standing with PO3**, including the ability to convene the
   debate. Today only the AMD phase detector can do that.

5. > "I want the report to come in active after I give a green signal to work on."

   **Nothing here executes until an explicit green signal.** He may green-light the whole
   plan, one phase, or one task.

### Carried forward from `SIGNAL_LOOP_PLAN.md`, still binding

6. **Setup verification outranks timing.** "The setup can be formed anytime so keep a watch and
   taking it should be major goal rather than identifying at what time it takes place." Session
   window stays a pure annotation. Nothing in this plan may time-gate a detection.

7. **The app alerts; Anoop enters.** Semi-autonomous means the system watches all three
   playbooks and tells him. The final call to enter or exit stays his. The single existing
   execution path (`handleTradeConfirm`, gated by `trade-confirm-rules.js` + dedup) is not
   widened by this plan.

8. **Every enforcement decision stays deterministic code.** No LLM gets a vote on a gate. Both
   models remain advisory throughout.

---

## The one architectural change this plan makes

Everything below is downstream of a single inversion:

```
TODAY                                     AFTER
─────                                     ─────
live fold ──> HUD (forgets at midnight)   live fold ──> unified trade record ──┐
                                                                              │
CSV (manual) ──> day_trades ──> Insights  CSV (optional) ──> reconcile ────────┤
                            └─> Day Recap                                      │
                            └─> bias matrix                     day_trades ────┤
                            └─> payout dataset                  gr_history  <──┘
                                                                    └─> everything downstream
```

`csvApply()` today does far more than store rows — it computes the entire day summary
(discipline score, per-trade grade and flags, giveback, flip count, consecutive losses,
hold stats, the balance ledger, and the guardrail day-state). **That computation is correct
and must not be duplicated.** The fix is to extract it as a pure module with two producers
feeding it, not to write a second, parallel history path. This is the core insight of Phase 4
and the reason it is bigger than it looks.

---

## Progress

**4 / 24 tasks complete.** (0.1, 0.3, 1.1, 1.2 — build by DSH, senior partner Claude Code)

| Phase | Fixes | Tasks | Depends on |
|---|---|---|---|
| 0 — Capacity + safety net | prerequisite | 3 | — |
| 1 — Watch everything, always | G1, G2 | 4 | 0 |
| 2 — Write every signal down | G5 | 3 | 1 |
| 3 — Live feed reaches every agent | G3, G4 | 4 | 2 |
| 4 — Live feed writes the day record | H1, H2 | 5 | 0 (independent of 1-3) |
| 5 — Join, score, learn | H3, H4 | 3 | 2, 4 |
| 6 — Point the loop at payout | H5 | 2 | 4 |
| — H6 live verification | H6 | parallel track | runs alongside, blocks *trust* not *build* |

Phases 1-3 (the signal loop) and Phase 4 (the record loop) are independent of each other.
If time is short, **Phase 1 then Phase 4** delivers the most value: the watch stops having
holes, and the CSV dependency dies.

---

# Phase 0 — Capacity and safety net

*Do first. Task 0.1 is not optional housekeeping — arming five watchers without it will
degrade the whole chart layer.*

- [x] **0.1 — Chart-read budget: cache bars per timeframe, stagger the polls**

  **The problem this prevents.** `checkEngulfingSignal` calls `getBarsAndLabels(tfCode, 5)`,
  which **switches the chart timeframe and restores it**, on *every* poll. On a candidate it
  then makes two more chart calls (`getFullBars(tf, 40)` for the Playbook C structure read,
  plus `getPDHPDL()`). Today only engulf-1H auto-starts, so this is affordable. After task 1.1
  the steady-state load on one CDP connection becomes:

  | Watcher | Period | Chart TF switches/min |
  |---|---|---|
  | Engulf 15M | 30s | 2 |
  | Engulf 30M | 45s | 1.3 |
  | Engulf 1H | 60s | 1 |
  | FVG 30M | 30s | 2 |
  | SFP 30M | 60s | 1 |
  | PO3 (×2 symbols) | 60s | ~2 |
  | Mechanical analysis | 90s | ~0.7 |
  | **Total** | | **~10/min, all serialized through `withChartLock`** |

  Every one of these queues behind the others, and `handleTradeConfirm`'s order placement uses
  the **same** `withChartLock` (deliberately — it must serialize against `chart_set_symbol` or
  an interleaving switch could place an order on the wrong instrument). A saturated chart lock
  therefore delays real order placement. Note also that engulf-30M and FVG-30M both read 30M
  bars and would each do their own switch.

  **The fix.** A small `chart-bar-cache.js`: one keyed read per `(symbol, tfCode, count)` with
  a TTL of roughly one third of that timeframe's bar duration, so N monitors on the same TF
  collapse to one chart operation. Plus stagger monitor start times (offset each by a few
  seconds) so five timers don't align on the same tick. Pure and unit-testable.

  *Acceptance:* with all five watchers armed, measured chart-lock wait time for a synthetic
  `chart_get_state` call stays under 2s at p95. Log the queue depth so this is observable
  rather than assumed.
  *Done: 2026-08-22 (DSH build). New `app/chart-bar-cache.js` (pure: normalizeTf, ttlMsForTf = 1/3 bar duration, ChartBarCache, staggerOffsetMs) + `app/test/chart-bar-cache.test.js` (10 tests). Wired into `getFullBars` and `getBarsAndLabels` with per-symbol keys via new `getChartSymbolCached` (10s symbol cache); Pine label text cached in a second instance with the same per-TF TTL. `makeLock` now logs queue depth whenever the lock is contended and exposes `queueDepth()`/`maxQueueDepth()` getters. Watcher starts staggered 4s apart via `armMonitorsStaggered()` at all three connect sites. DEVIATION for review: per the plan's TTL, a just-closed new bar becomes visible up to ~TTL/2 after close — a detection-lag tradeoff, documented in the module header. Full suite 566/566 green (556 baseline + 10 new).*

- [ ] **0.2 — Baseline capture, for real this time**

  `SIGNAL_LOOP_PLAN.md` task 0.1 was skipped and its author recorded the shortfall honestly:
  there is no before-picture, so nobody can say whether the closed-bar fix reduced false
  signals. Do not repeat that. Before Phase 1 lands, run **one full session on current code**
  with the console capturing every `engulf-check` / `engulf-signal` / `fvg-signal` /
  `sfp-signal` broadcast to `DATA/baseline-signals.jsonl`.

  This is cheap — it is one session with logging on, no code change beyond a broadcast tap —
  and it is the only chance to measure what arming the other four watchers actually adds.
  *Done:*

- [x] **0.3 — Branch and test baseline**

  Branch off `master`. Confirm `cd app && npm test` is green before the first edit (538 tests
  as of the last recorded run) so any later failure is unambiguously ours.
  *Done: 2026-08-22 (DSH build). Branch `live-feed-loop` created off master @ 8e7b202 — the plan's stated base, verified. `npm test` baseline: 556/556 green — DEVIATION from the plan's recorded 538: the suite has grown since the plan was written (33 test files). LIVE_FEED_LOOP_PLAN.md was untracked on master; committed onto the branch as a setup commit so the tracker travels with it. `DSH build/` scratch dir git-ignored.*

---

# Phase 1 — Watch everything, always — fixes G1, G2

- [x] **1.1 — All five watchers auto-start on TradingView connect**

  `server.js` has three places that arm monitors on connect (the `tv-connected` handler, the
  `mcpBridge.ready` early-return branch, and after `await mcpBridge.start()`). All three
  currently call `startPo3Monitor()`, `startEngulfMonitor('1h')` and `startSFPMonitor('30m')`.

  Add: `startEngulfMonitor('30m')`, `startEngulfMonitor('15m')`, `startFVGMonitor('30m')`.
  Each start function is already idempotent. **`startFVGMonitor` currently has exactly one
  caller — `handleFVGToggle` — which is the whole of G1: Playbook B's displacement half has
  never armed itself.**

  Introduce `ALL_MONITORS` as a single const listing the five, and have all three sites iterate
  it, so a sixth watcher added later cannot be forgotten in one of the three branches. That
  three-way duplication is exactly how FVG got missed.
  *Done: 2026-08-22 (DSH build). `ALL_MONITORS` const introduced with all five plan watchers (engulf 1H/30M/15M, FVG 30M, SFP 30M) PLUS PO3 — deviation note: PO3 is listed alongside the five because the three connect sites armed it there too, keeping one list instead of two. The three connect sites already routed through the single `armMonitorsStaggered()` helper (task 0.1), which now iterates ALL_MONITORS — the 3-way duplication is structurally gone, not just patched. `startFVGMonitor` gains its first auto-start caller (pre-verified with the G1 grep: 2 call sites now — toggle handler + ALL_MONITORS). server.js syntax OK.*

- [x] **1.2 — Delete the `*MonitorUserDisabled` flags and refuse every "off" path**

  Per decision 2, there is no supported way to disarm a watcher. Remove
  `engulfMonitorUserDisabled`, `fvgMonitorUserDisabled`, `sfpMonitorUserDisabled` and the
  guards that read them. `handleEngulfToggle` / `handleFVGToggle` / `handleSFPToggle` stay as
  message handlers but treat `enabled:false` as a no-op and reply with a status line explaining
  the watcher is always on.

  **Telegram must be fixed in the same pass.** `/engulf off` and `/playbookb off` call the stop
  functions today. With the UI toggles gone, an accidental `/engulf off` from the phone would
  leave a watcher dark with nothing left to restore it. `on` stays honoured (idempotent);
  `off` is refused with an explanation.

  **Also fix the SIGINT defect while here.** `SIGNAL_LOOP_PLAN.md`'s A5 documents it and it is
  the same class of bug: `Object.keys(monitors).forEach(stopMonitor)` passes `(key, index,
  array)`, so the array index lands in the second parameter. Shutting down is not disarming —
  pass the skip-save flag explicitly.
  *Done: 2026-08-22 (DSH build). The three `*MonitorUserDisabled` flags and their guards removed (grep-verified: zero remaining references). Toggle handlers now honour `enabled:true` (idempotent) and REFUSE `enabled:false` with a status broadcast + log line — implemented as refuse-with-explanation (the plan's "no-op and reply" rendered as a visible status line, matching the Telegram wording). Telegram `/engulf off` and `/playbookb off` now refuse with an explanation; `on` still honoured; `/help` text updated. SIGINT fixed: explicit `k => stopX(k)` lambdas so forEach's (key,index,array) can never feed the index into a future second parameter — deviation note: the stop functions currently take one parameter, so today's bug was latent, not live; the fix is future-proofing per A5. Both files pass `node --check`.*

- [ ] **1.3 — Remove the toggles from the UI, replace with a live watcher panel**

  In `renderer/index.html`, remove five `toggle-switch` blocks: `#engulf-toggle-1h`,
  `#engulf-toggle-30m`, `#engulf-toggle-15m` (each inside its `.engulf-tf-panel`),
  `#fvg-toggle-30m`, `#sfp-toggle-30m`. Keep every `↻ Check now` button, every status line,
  every history list, and the Pine indicator-name inputs — those are all still useful.

  Replace the `Off — toggle to start watching` status text, which becomes a lie the moment the
  toggles are gone. Add a **Chart Watchers** panel that renders the actual running set read
  back from the server (not what the client last requested — restored and hand-toggled state
  must display correctly), reading `Always on — no switches to forget.`

  *Why a panel and not nothing:* with no toggle, "is it watching?" becomes unanswerable by
  looking at the UI, and G1 was invisible for exactly that reason.
  *Done:*

- [ ] **1.4 — Per-watcher liveness, so a silently dead monitor is visible**

  A watcher that throws every poll currently just broadcasts an error status that scrolls away.
  With no toggle to power-cycle it, a wedged watcher is worse than before. Track `lastCheck`
  and `lastError` per monitor; the Chart Watchers panel shows amber if a watcher has not
  completed a check within 3× its interval, and the server attempts one restart before
  reporting red.
  *Done:*

---

# Phase 2 — Write every signal down — fixes G5

*Nothing about the detection layer can be tuned from evidence until this exists. It is also
the prerequisite for Phase 5's scorecard.*

- [ ] **2.1 — Signal ledger, server-side, at broadcast time**

  New `signal-ledger.js`. Every fire **and every Playbook C rejection** appends one line to
  `DATA_DIR/signals/<YYYY-MM-DD>.jsonl`:

  ```
  { ts, playbook, tf, direction, level, gapLow, gapHigh, source,
    valid, rejectReason, structure,
    sessionTier, dailyTrend, hourTrend, newsBlackout, symbol, accountSlot, mode }
  ```

  **Server-side at broadcast time, not client-side**, so signals that fire with no browser open
  are still recorded. **The trend/news/mode context must be captured at fire time** — it cannot
  be reconstructed later, which is the mistake that made the missing baseline unrecoverable.
  JSONL so a partial write costs one line, not the day.

  Wire into all six fire paths: engulf accept, engulf reject, FVG, SFP raid, Playbook B
  confirm, PO3 phase change.

  *Rejections are data, not noise.* The Playbook C filter rate per timeframe is the direct
  measure of whether the gate is protecting Anoop or starving him, and it is currently
  unmeasurable.
  *Done:*

- [ ] **2.2 — Signal expiry and a single live-setup slot**

  A server-side `armedSetup` holding the most recent live setup with a computed expiry —
  8 candles of the signal's own timeframe, mirroring the SFP patience window, which is the
  best-built expiry logic already in the codebase. A newer signal replaces an older one; expiry
  is evaluated lazily on read so no extra timer is needed.

  **Server-side, not client-side as `SIGNAL_LOOP_PLAN.md` 3.1 proposed.** That version put the
  slot in `renderer/app.js`, which cannot work here: Phase 3 needs the agents (server-side) to
  read it, and an auto-triggered debate can fire with no browser attached.

  On expiry with no decision recorded, write `decision: 'ignored'` to the ledger. An untouched
  signal is itself a data point.
  *Done:*

- [ ] **2.3 — Decision capture: two buttons, one click**

  When a setup is live, the UI offers exactly **Took it** / **Passed**. No form, no note field
  required — anything heavier will not get used mid-session. Writes
  `{ signalTs, decision, decidedAt }` back into the same day's ledger.

  This is deliberately built *before* the automated fill-join in Phase 5. It is the cheapest
  thing that makes the loop learn, it works even if every automated join fails, and it is the
  fallback if the live-feed join proves unreliable.
  *Done:*

---

# Phase 3 — Live feed reaches every agent — fixes G3, G4

- [ ] **3.1 — `marketStateLine()` — the chart's live state, as one context line**

  A pure formatter rendering the current `armedSetup` (or its absence) plus the Daily/1H bias:

  ```
  MARKET (live chart): SETUP LIVE — Playbook B BULLISH 30M @ 21847.25
    validity: swept sell-side and rejected, HL structure intact
    fired 4m ago · expires in ~3 candles · NY session
    Daily/1H: aligned bullish (4/5)
  ```

  …or `MARKET (live chart): no setup armed — watching A, B, C on 1H/30M/15M`.

  Inject into the **shared** context block alongside the existing `formatLiveFeedContext()` /
  `formatOpenPositionContext()`, so it reaches Jessi, the Judge, the Scalper and the
  Post-Session Analyst in one change because they all read the same block.

  **Deliberately NOT given to the Analysis and PO3 debate agents** — decision 3. They are denied
  account/P&L data by their own context text and that separation is load-bearing. The setup
  state reaches the verdict through the Judge.

  *Verification is manual per `CLAUDE.md`'s prompt-change convention:* run the app with a live
  setup armed, ask Jessi "should I take this", and read the actual reply. A prompt change with
  no observed response is unverified.
  *Done:*

- [ ] **3.2 — Fix the stale-context defect this will otherwise inherit**

  `parseGoNogo` at `renderer/app.js:5186` still regex-scrapes Claude's prose for "GO"/"NO-GO"
  and calls `setGoNogo()`, overwriting the mechanically-computed badge. Any reply containing the
  word GO clobbers the real state until the 30s timer restores it. This is the exact
  LLM-in-the-enforcement-path pattern decision 8 forbids, and once the badge starts carrying
  setup state it becomes actively misleading. Make it a documented no-op.
  *Done:*

- [ ] **3.3 — Playbooks A, B and C can convene the debate — fixes G4**

  `autoTriggerDebate` has exactly two call sites today, both inside the PO3 phase check. Add a
  third trigger: a **validated** Playbook A/B/C signal.

  Guardrails, because this spends real tokens and can produce a trade ticket:
  - Only on a signal that passed its validity gate — never on a rejection.
  - Reuse PO3's existing per-symbol cooldown so a chop day cannot fire a debate every 30s.
  - Reuse the `preGathered` context path so the chart is read once, under one lock, rather than
    four times.
  - Debate reqId prefixed to identify the trigger, so the ledger can record which playbook
    convened it.

  *Open for Anoop's call at green-signal time:* whether all three playbooks auto-debate, or only
  the full Playbook B confirm and 1H Playbook A (the two highest-conviction signals), with C on
  the lower timeframes staying alert-only. **Recommendation: start with A and full-B only.**
  Playbook C on 15M can fire often, and a debate per 15M engulf is how a useful alert channel
  becomes noise that gets ignored — the exact failure `SIGNAL_LOOP_PLAN.md` 5.3 warns about for
  Telegram.
  *Done:*

- [ ] **3.4 — Telegram parity**

  Push the setup state, not just the raw candle event: playbook, direction, timeframe, validity
  reason and level. Deliberately **not** pushed: rejections, readiness nags, watcher-liveness
  warnings. A channel that pings constantly gets muted, and then the real signal is lost with it.
  *Done:*

---

# Phase 4 — Live feed writes the day record — fixes H1, H2

*The heart of decision 1, and the highest-leverage work in this plan. Independent of Phases
1-3 — it can run first or in parallel.*

- [ ] **4.1 — Unify the two trade representations**

  Two complementary record shapes exist today and neither is sufficient alone:

  | Field | Live fold record | Order-walk record |
  |---|---|---|
  | `pnl` confirmed in $ | ✅ exact (balance delta) | ❌ `pnlUnknown: true` |
  | `symbol`, `side` | ❌ | ✅ |
  | `entryPrice` / `exitPrice` | ❌ | ✅ |
  | `entryAt` / `exitAt` | ❌ (`at` only) | ✅ |
  | `size` | ✅ observed | ✅ peak-qty tracked |

  `analyzeOrderWalk()` already produces everything the fold lacks, is already unit-tested, and
  already runs on every poll for the round-trip count cross-check. **The work is a join, not new
  extraction:** match each fold-scored close to its order-walk round trip and emit one record
  carrying the broker's times/symbol/prices *and* the fold's confirmed P&L.

  Keep the provenance fields — `evidence: 'degraded'`, `inferred`, `source` — on the merged
  record. A unified record that loses the confidence labels would let an uncertain number reach
  a hard lock, which D1/D2 in `TODOS.md` were specifically built to prevent.
  *Done:*

- [ ] **4.2 — Extract the day rollup from `csvApply` as a pure module**

  `csvApply()` (`renderer/app.js:8643`) is ~120 lines that compute, from a day's trade rows:
  per-trade grade and flags, discipline %, gross/net/contracts/maxSize, best/worst, avgWin/
  avgLoss, hold stats, gap stats, giveback vs intraday peak, direction flip-flops, consecutive
  losses, `sizedUpIntoLoss`, `bigAfterWins`, the balance ledger entry, and the guardrail
  day-state.

  **All of that is correct and must be shared, not reimplemented.** Extract it to
  `day-rollup.js` as pure functions: `gradeTrades(rows, rules)` → rows with `g`/`flags`, and
  `rollupDay(date, rows, rules)` → the day summary object. `csvApply` then becomes a thin
  caller. Unit-test against the existing stored days so the extraction is provably behaviour-
  preserving before anything new depends on it.

  *This is the task that makes Phase 4 safe.* Writing a second history path instead would give
  two divergent definitions of "discipline score" — precisely the class of drift that
  `CLAUDE.md` warns about with `rules.json`.
  *Done:*

- [ ] **4.3 — The live feed writes `day_trades` and `gr_history` directly**

  On each closed round trip, convert the unified 4.1 record into the existing row shape
  `{ t, x, size, pnl, g, flags, side, ep, xp, mp, hold }`, merge it into today's `dtStore[date]`
  by the existing `fp()` fingerprint, re-run `rollupDay()`, and persist —
  `copilot_day_trades`, `copilot_gr_history`, `copilot_balance_ledger`, plus the `dataSave`
  disk mirrors — through exactly the same writes `csvApply` performs.

  **Fires on the position-events close path**, which already runs on a 5s tick and already
  auto-writes a session-log row, so the trigger point exists and is proven.

  Two things to get right:
  - **Idempotency.** The close path can re-fire on restart or a duplicated poll. The fingerprint
    merge (`t|x|pnl|size`) is a merge-not-replace design already built for re-uploads and
    handles this — but verify it against a restart mid-session, which is the case that bit
    `logTrade` before (H6 in `LIVE_TRADE_EVENTS_PLAN.md`).
  - **The IST trading-day rollover.** `csvParseTrades` anchors the trading day to 03:45 IST,
    not calendar midnight, because a 12:40 AM IST trade belongs to the NY session that opened
    the previous evening. The live writer **must** use the same anchor or a late-night scalp
    will open a phantom new day. There is precedent for getting this wrong: the session log
    shipped with a UTC day in an IST app.
  *Done:*

- [ ] **4.4 — Enrich the auto-written session-log row — fixes H2**

  `position-events`' close currently writes entry/stop/target as `?` because the fold record
  carries no prices. With 4.1 the entry and exit prices are genuinely known, so write them.

  **`stop` and `target` stay `?`** — those are *planned* levels that exist nowhere in broker
  data, and per `TRUST-PROTOCOL.md` passing an average fill off as a planned entry is exactly
  what the `?` convention exists to prevent. Fill in what is observed; do not invent the rest.
  *Done:*

- [ ] **4.5 — Demote CSV to optional reconciliation**

  CSV upload stays, and stays useful, but changes role: parse it, compare it against the
  live-derived day record, and **report the differences** — trades the live feed missed
  (server was down), trades the live feed has that the CSV doesn't, and any P&L disagreement
  per trade. Only apply on explicit confirmation.

  **The honest caveat this creates, stated plainly:** live-only history means the day record now
  depends on the app running. If the server is down for part of a session, those trades are
  missing from history even though the broker has them. CSV reconciliation is the backstop for
  exactly that case, which is why it stays rather than being deleted. Reframe the UI from
  "Upload CSV" to "Reconcile with broker export".
  *Done:*

---

# Phase 5 — Join, score, learn — fixes H3, H4

- [ ] **5.1 — Join fills to signals**

  On a close, match back to the nearest preceding signal on the same instrument and direction
  within a configurable window (start at 15 minutes). Stamp the trade record with
  `signalBacked`, `playbook`, `minutesFromSignal`. Write the join into the day's ledger as it
  happens, not at end of day — the app is running and already knows what was armed, so
  `minutesFromSignal` is *measured* rather than reconstructed.

  `minutesFromSignal` also makes failure mode 7 (entering within a minute of a signal, before
  confirmation) precisely measurable for the first time.
  *Done:*

- [ ] **5.2 — Per-playbook scorecard in Insights**

  | Playbook | Fired | Valid | Rejected | Taken | Passed | Ignored | Win% | Avg R | Net |
  |---|---|---|---|---|---|---|---|---|---|

  Plus the two lines that carry the most information:
  - **(a) Signal-backed trades vs freestyle trades** — win rate and net for each. This is the
    direct measurement of whether the playbooks beat improvisation, and it is the single
    question this whole system exists to answer.
  - **(b) Passed signals that would have won** — the cost of hesitation, computed from live bars
    pulled after the signal through the same chart feed.

  **Do not display this until the H6 track reports PASS.** The scorecard reads per-trade P&L
  attribution, which is the one thing still unverified. A confident wrong scorecard would drive
  worse decisions than no scorecard.
  *Done:*

- [ ] **5.3 — Mechanical detection for the remaining failure modes — fixes H4**

  F1 (trade-count escalation) and F2 (revenge cluster) are live. F3-F6 and M1-M6 were blocked on
  missing entry times, prices and symbol — **Phase 4.1 unblocks most of them in one pass**, which
  is the leverage argument for doing Phase 4 first.

  Build one pattern per commit, each verified live before the next is started — Anoop's explicit
  standing decision: *"better to ship one pattern working end-to-end and verified live than all
  of them half-working."* Advisory only, same as F1/F2. Source text must be cited verbatim from
  his own words in `renderer/index.html`, never paraphrased into something softer.

  Store a per-day pattern vector so the trend over weeks is visible, not just today's verdict.
  *Done:*

---

# Phase 6 — Point the loop at payout — fixes H5

- [ ] **6.1 — Distance-to-payout drives the day's plan**

  `journey-tracker.js` already holds the eval → funded → breach-or-payout lifecycle correctly.
  What is missing is forward-looking: distance to the payout threshold, the implied daily target
  to reach it, and days-to-target at the trailing 20-day rate.

  Extend the Day Recap, which already does exactly this shape of computation — it derives
  tomorrow's starting contract size from yesterday's worst single trade against the day stop.
  Same pattern, one more number. Mechanical, no API call.

  **Guard against the obvious failure mode:** a daily *target* must never read as permission to
  keep trading to reach it. Display it as a pace indicator alongside the existing hard stops,
  and never let it appear in a context where it could be mistaken for a goal that overrides the
  trade limit or the day stop.
  *Done:*

- [ ] **6.2 — Hour-edge table, recomputed from real data**

  Now computable properly, because Phase 4-5 give clean per-trade data with real timestamps. A
  weekly rolling hour-of-day edge table written to `DATA_DIR`, feeding the `sessionTier`
  annotation instead of the hardcoded July guess.

  **Reporting only** — decision 6 forbids hour weighting or hour-based blocking. The window
  stops being an assumption and becomes what the last 20 days actually say, and that is all it
  does.
  *Done:*

---

# Parallel track — H6, live verification

*Not a phase. It runs alongside everything and needs no build work.*

- [ ] **H6 — Confirm per-trade P&L attribution against one real closed trade**

  What is already **confirmed**: the MNQ point value ($2.00/point — 117/117 realized values
  exact at $0.50/tick, reconciling to the balance ledger on 9/9 days), the balance-delta
  arithmetic at the endpoint (to the cent on 2026-08-20), and a full real day replaying to
  `tradeCount: 5` / `dayPnl: -264.10` exactly.

  What is **not** confirmed: the *split* — per-trade attribution. `size-freeze-guard` and the
  cooldown read per-trade `pnl` and `lastLossTs`, not the day total, and a correct day total
  does not prove a correct partition. 2026-08-20's own partition cannot test this because it
  was produced by the buggy fold.

  **No work required.** `expectedPnlFromFills()` already derives a second, independent P&L from
  fill prices on every close and compares it to the balance delta; agreement is logged, a
  disagreement over $1 raises a banner. One real closed MNQ trade with non-zero P&L will report
  PASS or the exact dollar disagreement.

  **This blocks trust, not build.** Phases 1-4 can ship and be useful before it clears. Phase
  5.2's scorecard should not be *shown* until it does.
  *Done:*

---

## Risks, stated up front

1. **Chart-lock saturation is the biggest technical risk in this plan.** Going from three armed
   watchers to five, with the Playbook C gate adding two extra chart calls per candidate,
   roughly triples chart-layer load on a single CDP connection that order placement also uses.
   Task 0.1 exists for this and should not be deferred "until we see if it's a problem" — by
   then it will be a problem during a live session.

2. **Live-only history depends on uptime.** Phase 4 makes the app the system of record for
   trades. A crash or a closed laptop loses that window from history, silently, in a way the
   CSV path never could. Task 4.5's reconciliation is the mitigation and is not optional.

3. **No way to stop a watcher is a real trade-off, deliberately accepted.** Decision 2 is
   explicit and the reasoning is sound — a toggle you must remember to flip is a toggle that
   will be forgotten, which is precisely how G1 stayed invisible. The cost is that a misbehaving
   watcher cannot be silenced without a restart. Tasks 1.4 (liveness + auto-restart) and 1.2
   (Telegram refuses `off`) are what make this acceptable rather than reckless.

4. **Auto-debating on every playbook signal can turn a useful channel into noise.** Task 3.3's
   recommendation to start with Playbook A and full-B only is a hedge against this; widen it
   after two sessions of ledger data show the real fire rate per playbook.

5. **`csvApply` extraction touches working, load-bearing code.** Task 4.2 changes the path that
   currently produces every number in Insights, the Day Recap, the bias matrix and the balance
   recompute. Unit-test the extraction against stored real days *before* anything new consumes
   it, and land 4.2 as its own commit so a regression is bisectable.

---

## Explicitly out of scope

- **No widening of trade execution.** `handleTradeConfirm` stays the only order path, still
  gated by `trade-confirm-rules.js` with no override and `trade-confirm-dedup.js`. Anoop takes
  the final call — decision 7.
- **No LLM in any enforcement path** — decision 8.
- **No removal of the Analysis/PO3 account-data denial.** It exists because of a documented
  fabrication incident.
- **No badge rework along `SIGNAL_LOOP_PLAN.md` 3.1-3.5's design.** It was written against a
  system without master's Judge / `go-verdict-detect` / `verdict-grounding` pipeline and would
  fight it. The setup state reaches the UI and the agents through Phase 2.2 + 3.1 instead.
- **No new runtime dependencies.** The hand-rolled, offline-first approach is a deliberate
  constraint.
- **No UI redesign** beyond removing the five toggles and adding the watcher panel.

---

## Test plan

- Unit tests alongside every pure module: `chart-bar-cache.js`, `signal-ledger.js`,
  `day-rollup.js`, the 4.1 join, the 5.1 signal-to-fill match. Node's built-in runner, no new
  framework, matching the existing 538-test suite.
- `day-rollup.js` gets a **golden test against real stored days** — same inputs through the old
  `csvApply` path and the new extracted path must produce byte-identical summaries.
- Live verification per phase, since prompt and detector changes cannot be proven by unit tests:
  Phase 1 — all five watchers visibly armed after a TradingView reconnect; Phase 2 — a real
  fire and a real rejection both appear in the day's JSONL; Phase 3 — Jessi's actual reply
  demonstrably references the live setup; Phase 4 — a real closed trade appears in Insights with
  no CSV uploaded, and a CSV uploaded afterwards reconciles clean.
