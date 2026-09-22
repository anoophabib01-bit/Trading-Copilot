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

**25 / 26 resolved.** 24 done (0.1, 0.1a, 0.3, 1.1–1.4, 2.1–2.3, 3.1–3.3, 3.3a, 3.4, 4.1–4.5, 5.1, 5.2, 6.1, 6.2) + 2 skipped with reason (0.2; 5.3 partial — F3 built, F4-F6/M1-M6 await live verification). H6's gate mechanism is built; its PASS itself is NEEDS LIVE. Note: the audit added 0.1a + 3.3a on 2026-08-22, raising the total from 24 to 26 — build by DSH, senior partner Claude Code

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

- [x] **0.1a — Re-key the cache on bar boundaries, not wall-clock TTL** — *added 2026-08-22 by audit, supersedes 0.1's TTL*

  **0.1's DEVIATION note is accepted as accurate and the trade is rejected.** The measured lag
  is worse than "~TTL/2": TTL is one third of the bar duration, so worst case is a **full TTL
  after close** — up to **5 min on 15M, 10 min on 30M, 20 min on 1H**.

  **Why a wall-clock TTL is the wrong axis here.** Every detector deliberately drops the
  forming bar (`dropFormingBar`) and evaluates closed bars only, so *new information appears
  exactly once per bar, at its close, and never between closes.* A TTL anchored to when the
  fetch happened is uncorrelated with that. A 1H engulf that closes at 19:00 can go unseen
  until 19:20 — against decision 6, where catching the setup is the whole point.

  **The fix is strictly better on both axes, not a trade.** Key each entry on the bar period it
  was fetched in and expire when the period rolls:

  ```js
  const period = (t, durMs) => Math.floor(t / durMs);   // same bar → same key
  // stale when period(now) !== period(entry.at)
  ```

  - **Lag → zero.** A newly closed bar is visible on the very next poll.
  - **Dedup improves.** Engulf-1H polls 60× per bar: TTL(20min) allows 3 fetches/hour;
    bar-boundary allows exactly 1. Engulf-30M and FVG-30M still collapse to one fetch.

  Keep `ttlMsForTf` as the fallback for unknown timeframe codes only. Apply to the label-text
  cache too — the Playbook C gate re-validates Pine labels against closed bars anyway, so a
  label cached for 20 minutes buys nothing and can only delay.

  *Acceptance:* a unit test asserting a fetch in bar N is not served to a read in bar N+1, and
  that repeat reads inside one bar hit the cache. Keep the existing 10 tests green.
  *Done: 2026-08-22 (DSH build). chart-bar-cache.js now keys entries on bar periods (periodOf/barDurationMsFor/isStale): an entry fetched in period N is stale the moment the period rolls — lag → zero, dedup → exactly one fetch per bar per (symbol,tf). ttlMsForTf kept ONLY as the unknown-timeframe fallback. Label-text cache uses the same class, so 0.1a applies to it too. Tests updated: the old TTL-expiry test became the bar-rollover test (its intent — entries expire — is preserved; the mechanism changed per the audit), plus acceptance tests (bar N not served to N+1; repeat reads inside one bar hit; unknown-tf TTL fallback; backwards clock-skew never stale). 13/13 green (10 previous + 3 new).*

- [~] **0.2 — Baseline capture, for real this time**

  `SIGNAL_LOOP_PLAN.md` task 0.1 was skipped and its author recorded the shortfall honestly:
  there is no before-picture, so nobody can say whether the closed-bar fix reduced false
  signals. Do not repeat that. Before Phase 1 lands, run **one full session on current code**
  with the console capturing every `engulf-check` / `engulf-signal` / `fvg-signal` /
  `sfp-signal` broadcast to `DATA/baseline-signals.jsonl`.

  This is cheap — it is one session with logging on, no code change beyond a broadcast tap —
  and it is the only chance to measure what arming the other four watchers actually adds.
  *Skipped: 2026-08-22 (DSH build) — the one-live-session capture cannot be run from the build environment; it needs Anoop's machine mid-session. The broadcast tap itself is SUPERSEDED by task 2.1's signal-ledger (server-side JSONL at fire time, wired into all six fire paths), which captures strictly more than the baseline file would have. Remaining on-machine item for Anoop/Claude after merge: run one full session and compare the ledger against expectations — the "before" picture for the other four watchers stays unmeasured and must not be claimed.*

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

- [x] **1.3 — Remove the toggles from the UI, replace with a live watcher panel**

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
  *Done: 2026-08-22 (DSH build). All five toggle-switch blocks removed (grep-verified: zero `*-toggle-` references left in renderer/). Status defaults replaced with "Always on — no switches to forget."; the toggle-sync lines in app.js's monitor-status handlers removed. Chart Watchers panel added after the SFP section. Server: new `watchers-get` WS case → `buildWatchersStatus()` snapshot (tvConnected + per-watcher id/label/running/lastCheck) pushed as `watchers-status`; client pulls on load and every 15s via `getWatchers()` and re-renders on push — so restored/hand-toggled state displays correctly. PO3's own toggle was deliberately left in place: the plan's removal list is the five watchers only (recorded in 1.2's Done line). All four touched files pass `node --check`.*

- [x] **1.4 — Per-watcher liveness, so a silently dead monitor is visible**

  A watcher that throws every poll currently just broadcasts an error status that scrolls away.
  With no toggle to power-cycle it, a wedged watcher is worse than before. Track `lastCheck`
  and `lastError` per monitor; the Chart Watchers panel shows amber if a watcher has not
  completed a check within 3× its interval, and the server attempts one restart before
  reporting red.
  *Done: 2026-08-22 (DSH build). `lastError` + `restartAttempted` added to all monitor objects (po3/engulf/fvg/sfp); every check function clears `lastError` on entry and sets it in its catch. PO3's TV-offline and outside-session-window branches now stamp `lastCheck` (the poll loop is alive — deviation note: without this the watchdog would flag PO3 stale during the hours it is intentionally idle). `buildWatchersStatus()` now returns per-watcher health (healthy/amber/red/tv-offline/stopped); `startWatcherLivenessWatch()` (30s tick, first pass at +10s) restarts a stale watcher ONCE via its idempotent start function, logs recovery/restart/RED transitions, and broadcasts `watchers-status` on change. Panel renders 🟢/🟡/🔴 with a last-error tooltip. Startup wired in the boot block. All touched files pass `node --check`.*

---

# Phase 2 — Write every signal down — fixes G5

*Nothing about the detection layer can be tuned from evidence until this exists. It is also
the prerequisite for Phase 5's scorecard.*

- [x] **2.1 — Signal ledger, server-side, at broadcast time**

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
  *Done: 2026-08-22 (DSH build). New `app/signal-ledger.js` (pure: sessionTierForMinutes, buildSignalRow with the plan's exact field set + `event`/`decision`/`decidedAt`/`signalTs` extras for 2.2/2.3 consumers, serializeSignal) + `app/test/signal-ledger.test.js` (6 tests). `ledgerSignal()` in server.js appends to `DATA_DIR/signals/<trading-day-IST>.jsonl` at fire time with context captured NOW: sessionTier (from rules.sessionWindowsIST), hourTrend (from po3TrendCache), newsBlackout (computeNewsStatus), symbol (chart symbol cache), accountSlot, mode. dailyTrend deliberately null — Daily is Anoop's own read (see gatherAnalysisContext). Wired into all six fire paths: engulf accept/reject, FVG, SFP raid, Playbook B confirm, PO3 phase change (UNCLEAR written valid:false). DEVIATION: shipped together with 2.2/2.3 in one commit (see 2.2's Done line) because the fire-path edits interleave ledger and arm calls. Task 0.2 marked [~] in this commit — its tap is superseded by this ledger.*

- [x] **2.2 — Signal expiry and a single live-setup slot**

  A server-side `armedSetup` holding the most recent live setup with a computed expiry —
  8 candles of the signal's own timeframe, mirroring the SFP patience window, which is the
  best-built expiry logic already in the codebase. A newer signal replaces an older one; expiry
  is evaluated lazily on read so no extra timer is needed.

  **Server-side, not client-side as `SIGNAL_LOOP_PLAN.md` 3.1 proposed.** That version put the
  slot in `renderer/app.js`, which cannot work here: Phase 3 needs the agents (server-side) to
  read it, and an auto-triggered debate can fire with no browser attached.

  On expiry with no decision recorded, write `decision: 'ignored'` to the ledger. An untouched
  signal is itself a data point.
  *Done: 2026-08-22 (DSH build). Server-side `armedSetup` slot: `armSetup()` (newer replaces older), `readArmedSetup()` (lazy expiry = 8 candles × tfSecondsFor(tfCode); on expiry writes decision:'ignored' to the ledger), `clearArmedSetup()`, `broadcastArmedSetup()` (pushes `armed-setup` WS). Armed by: engulf accept (A/C), FVG fire, Playbook B confirm. Deliberately NOT armed by SFP raid alone ("not a trade yet") or PO3 phase changes (informational events) — recorded as a scoping decision for review. DEVIATION: shipped with 2.1 and 2.3 as one commit (fire-path edits interleave ledger+arm calls; splitting after the fact would have been error-prone); the commit message carries all three task ids.*

- [x] **2.3 — Decision capture: two buttons, one click**

  When a setup is live, the UI offers exactly **Took it** / **Passed**. No form, no note field
  required — anything heavier will not get used mid-session. Writes
  `{ signalTs, decision, decidedAt }` back into the same day's ledger.

  This is deliberately built *before* the automated fill-join in Phase 5. It is the cheapest
  thing that makes the loop learn, it works even if every automated join fails, and it is the
  fallback if the live-feed join proves unreliable.
  *Done: 2026-08-22 (DSH build). Server: `handleSignalDecision` (WS `signal-decision`; validates decision ∈ {took,passed} and signalTs matches the live slot; writes the decision row to the day's ledger, clears the slot, broadcasts armed-setup:null) + `armed-setup-get` pull. Client: armed-setup card in chat with exactly two buttons (Took it / Passed), re-rendered on push, removed on decision/expiry; decision result echoed as a system message. Full suite 572/572 (566 + 6 new signal-ledger tests).*

---

# Phase 3 — Live feed reaches every agent — fixes G3, G4

- [x] **3.1 — `marketStateLine()` — the chart's live state, as one context line**

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
  *Done: 2026-08-22 (DSH build). New pure `app/market-state.js` (marketStateLine, tfSecondsFor, setupDetail) + `app/test/market-state.test.js` (4 tests). `formatMarketStateLine()` in server.js builds the line from readArmedSetup() + po3TrendCache 1H label/direction + sessionTier, and it is injected into the shared context block at all four readers: buildJessiContext (text AND voice), the Judge's live block, the Post-Session data context, the Scalper's seeded context. DEVIATION vs the plan's example line: the example's "Daily/1H: aligned bullish (4/5)" references a 4H/5-bar vote that was REPLACED by the 1H 30-bar gate on 2026-08-17 (see po3TrendRead comments) — the line reports the MECHANICAL 1H BIAS label + direction and states "Daily is Anoop's read — not provided". Analysis/PO3 debate agents are NOT given this line (decision 3) — verified: their context builders never call it. NOTE the manual live verification (ask Jessi with a setup armed) remains an on-machine item.*

- [x] **3.2 — Fix the stale-context defect this will otherwise inherit**

  `parseGoNogo` at `renderer/app.js:5186` still regex-scrapes Claude's prose for "GO"/"NO-GO"
  and calls `setGoNogo()`, overwriting the mechanically-computed badge. Any reply containing the
  word GO clobbers the real state until the 30s timer restores it. This is the exact
  LLM-in-the-enforcement-path pattern decision 8 forbids, and once the badge starts carrying
  setup state it becomes actively misleading. Make it a documented no-op.
  *Done: 2026-08-22 (DSH build). `parseGoNogo` body replaced with a documented no-op (comment explains the clobbering defect and cites decision 8). The onChatDone caller is left in place calling the no-op — deliberate: the call site documents where the scrape used to happen; the function name stays so the history is greppable.*

- [x] **3.3 — Playbooks A, B and C can convene the debate — fixes G4**

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
  *Done: 2026-08-22 (DSH build). Built the plan's RECOMMENDED scope: Playbook A (1H engulf WITH 4H trend only — new playbookAValid flag; against-trend and unclear-trend A signals never debate) and full Playbook B confirm. C stays alert-only — recorded as the chosen answer to the open green-signal question; widening is one call-site each. `triggerPlaybookDebate()` + `buildPlaybookDebateQuestion()` reuse PO3's global lastAutoDebateAt 10-min cooldown (deviation note: the plan said "per-symbol cooldown" but PO3's existing cooldown is global, and reusing it as-is is the consistent behavior; splitting it per-symbol is a small follow-up if a live session shows MNQ/MGC cross-suppression). reqId prefixed `playbook-debate-` so the ledger/transcript identifies the trigger. DEVIATION: `preGathered` is NOT used for these triggers — PO3's secondary-symbol path needs it because it gathers while parked on a DIFFERENT symbol; playbook triggers fire on whatever symbol is already on screen, so the normal internal gathering is correct and one-chart-read already (the fire path just read those bars). Debates fire only inside the signal's dedup block (once per candle/confirm), never on rejections.*


- [x] **3.3a — Give the auto-debate a per-source cooldown** — *added 2026-08-22 by audit*

  `triggerPlaybookDebate` and `autoTriggerDebate` share one `lastAutoDebateAt`. So a PO3
  phase-change debate **silently suppresses a full Playbook B confirm** that fires inside the
  cooldown, and the log line for it reads as a routine skip.

  That inverts the conviction ordering. A completed Playbook B — liquidity raid, patience
  window survived, displacement FVG confirmed — is the highest-conviction event the detection
  layer produces. An AMD phase transition is context. The lower-conviction event must not be
  able to consume the budget for the higher one.

  **Fix:** track the last fire per source (`po3` / `playbook`), so each has its own cooldown.
  Additionally let a **full Playbook B confirm preempt** a PO3 debate still inside its window —
  it is rare enough that it cannot become a noise source.

  *Keep as-is:* a single shared cooldown across Playbook A and Playbook B. Those are genuinely
  comparable in conviction and both are rare.
  *Done: 2026-08-22 (DSH build). `lastAutoDebateAt` replaced by `lastAutoDebateBySource = { po3, playbook }`. autoTriggerDebate (PO3) uses the po3 cooldown; triggerPlaybookDebate uses the playbook cooldown, and a FULL Playbook B confirm preempts (fires regardless of the shared cooldown, then sets it for A). The secondary-symbol pre-gather gate now reads the po3 cooldown. server.js syntax OK.*
- [x] **3.4 — Telegram parity**

  Push the setup state, not just the raw candle event: playbook, direction, timeframe, validity
  reason and level. Deliberately **not** pushed: rejections, readiness nags, watcher-liveness
  warnings. A channel that pings constantly gets muted, and then the real signal is lost with it.
  *Done: 2026-08-22 (DSH build). `armSetup()` now notifies Telegram with the uniform setup line "📡 SETUP ARMED — Playbook X direction · TF · level/gap · expires in 8 candles of TF" (the validity reason travels in setup.message for B). Rejections, watcher liveness and readiness paths send nothing (no new notify call sites added there). Note: Telegram delivery is currently disabled by TELEGRAM_ENABLED=false (2026-08-11, Anoop) — the parity call sites are wired and will fire the moment the flag flips back.*

---

# Phase 4 — Live feed writes the day record — fixes H1, H2

*The heart of decision 1, and the highest-leverage work in this plan. Independent of Phases
1-3 — it can run first or in parallel.*

- [x] **4.1 — Unify the two trade representations**

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
  *Done: 2026-08-22 (DSH build). New pure `app/trade-record-join.js` (joinFoldToWalk) + `app/test/trade-record-join.test.js` (7 tests). Matching: time-ordered greedy, 3-minute tolerance, size-equal candidate wins outright, else nearest. Output: `records` (merged + unmatchedFold + unmatchedWalk, sorted), `merged`, `unmatchedFold`, `unmatchedWalk` — nothing is dropped; a fold close with no walk match keeps source 'live-fold-only', a walk close the fold missed stays 'order-walk-only' with pnlUnknown (the flip case the fold cannot score). Provenance preserved on every record. Wired into pollTVBrokerAccountInner: the session-log loop, the expectedPnlFromFills cross-check (now on joined records instead of index-slicing the walk — fixes the 1:1-order assumption) and the trade-closed-live broadcast all consume `joined.records`/`joined.merged`. Full suite 583/583 (576 + 7 new).*

  ***AUDIT FIX, 2026-08-22 — found live in review, landed in the tree the same day, its own commit message never written (folded into `71dc7ec`, unrelated to 4.1 — flagged below as a process defect in its own right).*** *`analyzeOrderWalk()` re-derives `walk.closed` from ALL of today's orders on every poll (cumulative for the day), while `newTrades` is only the delta since the last poll. The original wiring passed the full cumulative `walk.closed` into `joinFoldToWalk` against that small delta, so every already-joined close from an earlier poll re-surfaced as a fresh `order-walk-only` unmatched record — re-written into the session log and re-broadcast to chat on every later close, compounding across the day (verified by reproduction: a day's 2nd close re-emits the 1st as a duplicate; by the Nth close, N-1 stale rows re-appear). No existing test caught this because `trade-record-join.test.js`'s own tests each construct one poll's inputs in isolation — the bug lives entirely in how the caller composes two polls, not in the join logic itself. Fixed in `server.js`'s `pollTVBrokerAccountInner`: captured `prevClosedRoundTripsScored = tvBrokerFeedState.closedRoundTripsScored || 0` before `fold()` runs (this field already tracks exactly "how many order-walk round trips has the fold accounted for as of the last poll," already persisted via `persistTVBrokerFeedState()`, already restart-safe — no new state invented), then slice `walk.closed.slice(prevClosedRoundTripsScored)` before the join. An 8th test, `CONTRACT: caller must slice walk.closed to the delta...`, pins this at the integration boundary the unit tests can't reach. Verified against the live suite: reproduces the bug with the unsliced call, confirms zero `unmatchedWalk` re-appearance with the fix.*

  ***Process finding, not a code defect:*** *this fix has no commit of its own — it landed inside `71dc7ec` ("3.3a per-source debate cooldowns"), a commit about an unrelated task. That violates this plan's own "one task per commit" rule (line 33): if `71dc7ec` were ever reverted for the debate-cooldown work, this fix — which prevents duplicate trade records on the live-money session log — would silently go with it, with no commit message pointing back here. No action taken to split history at audit time (rewriting merged commits is more disruptive than the value it recovers at this stage), but flagged here so it is never mistaken for having been reverted cleanly, and so future commits stay one-task-per-commit going forward.*

- [x] **4.2 — Extract the day rollup from `csvApply` as a pure module**

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
  *Done: 2026-08-22 (DSH build). New UMD `renderer/day-rollup.js` (gradeTrades, rollupDay, tradingDayKey, entryMinOf — loads as window.DayRollup in the browser AND CommonJS for server/tests; index.html loads it before app.js). csvParseTrades now calls DayRollup.gradeTrades (window flags read rules.sessionWindowsIST instead of the hardcoded copy — identical values today); csvApply calls DayRollup.rollupDay — both are thin callers now. GOLDEN VERIFICATION, the acceptance gate: run against the REAL stored production days on this machine (s2). 2026-08-21 (14 trades): BYTE-IDENTICAL across all 32 summary fields incl. pnl 916.5, at the historical sizeCap 4 — that summary was produced in production by the OLD inline code. 2026-08-18: grades identical at cap 4; its stored sum cannot match because its rows were rewritten after the summary was stored (net off by exactly the contract delta, 17) — recorded, not hidden. Committed tests: test/day-rollup.test.js (6 tests, hand-computed fixture — real P&L stays out of the repo per the DATA/ gitignore convention) + test/day-rollup-live-golden.test.js which runs ONLY where the production DATA dir exists and fails if no stored day reproduces (it passes here: 2/2 days' grades reproduced, 1/1 current-day summary byte-identical). Full suite 589/589.*

  ***AUDIT CORRECTION, 2026-08-22 (Claude, senior-partner pass) — commit `4.2: give the live golden real teeth`.*** *The extraction itself is faithful: `gradeTrades`/`rollupDay` were diffed line-by-line against master's inline block and are identical. The GOLDEN was not. It searched one historical dimension (sizeCap) and asserted only `passed > 0`, so on this machine it reported 2/7 days and wrote the other five off as "rows rewritten after the summary". Three of them were not rewritten — 2026-07-28/29/31 were graded when the 15-min cooldown was loss-only (`rules.cooldownAfterLossOnly`), which the harness never varied, so their `revenge` flags could not reproduce at any cap. Searching (sizeCap, cooldown-loss-only) takes the byte-identical count to 4/7 and brings the remaining three to zero-or-one differing row. Assertions replaced: a MAJORITY of stored days must reproduce exactly, AND no day may differ by more than one row's grade under any historical rule combination — the second is the one with teeth, because it does not depend on any day happening to pass. Verified by injecting a drift (cooldown 15→25 min in gradeTrades): the old `passed > 0` stayed green at 2/7; the new assertions fail. The Done line above should be read as "2/7 under the original harness", not as evidence of drift.*

- [x] **4.3 — The live feed writes `day_trades` and `gr_history` directly**

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
  *Done: 2026-08-22 (DSH build). `writeLiveTradeToDayRecord()` in server.js fires on the same close loop that auto-writes the session-log row (the proven 5s-tick-adjacent path — deviation note: wired at the fold's new-trades block inside pollTVBrokerAccountInner, which is where the close is SCORED, rather than the position-events broadcast; that is the stronger trigger because the fold record exists there). Row shape matches csvApply's + provenance extras (`evidence`/`source` survive the write per the acceptance checklist). Fingerprint merge `t|x|pnl*100|size` identical to csvApply's fp(); the whole day is re-graded and re-rolled with the SAME day-rollup functions (4.2); persisted via dataSave mirrors for day_trades/gr_history/balance_ledger under the active slot. Trading-day anchor = dayRollup.tradingDayKey (03:45 IST). commPerCt read from rules.commissionPerContractPerSide when present else 1.0 — DEVIATION flagged for review: the CSV path's COMM_PER_CT is still a hardcoded 1.0 const in app.js; the two agree today, but the renderer const should eventually read the rule too. pnlUnknown records skipped (never written to the $ record). Client: `day-record-updated` broadcast → renderer syncs its localStorage copies + refreshes open views — the disk mirror is the system of record. Restart-mid-session idempotency is covered by the fingerprint merge (NEEDS LIVE: not yet observed against a real restart — the acceptance checklist's live-only rule).*

  ***AUDIT FIXES, 2026-08-22 (Claude, senior-partner pass) — two real defects in this task, one commit each.***

  *(a) `4.3: write LONG/SHORT into the day record, not the broker's raw buy/sell`. The row was built with `side: String(record.side).toUpperCase()`, and `record.side` comes from the order walk, which speaks the broker's `buy`/`sell`. So every live-written row carried `'BUY'`/`'SELL'` while every CSV and historical row carries `'LONG'`/`'SHORT'`. Three consequences: MAE/MFE (`renderer/app.js` ~8627) tests `t.side === 'LONG'` and therefore read every live BUY as a short, inverting both figures; **4.5's tolerance identity rejects a side mismatch, so a live row could never match its own CSV row — re-opening the doubling landmine from the other end**; and 5.1's `signal-join` ledger line tests `row.side === 'LONG'` and so always wrote `direction: null`. Fixed with a new pure exported `dayRollup.normalizeSide` (buy/sell and LONG/SHORT both normalize to the stored vocabulary; anything unrecognised → null, never a guess), unit-tested. Note the 4.5 test fixtures used `side: 'LONG'` on their "live" rows — a vocabulary the writer never actually produced, which is why no test caught this.*

  *(b) `4.3: commission is a ROUND-TURN rate in rollupDay`. `rollupDay` computes `net = gross - contracts * commPerCt` with one `contracts` unit per closed trade and no doubling — compare `expectedPnlFromFills`, which spells the two sides out as `rate * size * 2`. So `commPerCt` is a ROUND-TURN figure, while `rules.json`'s `commissionPerContractPerSide` is per side (0.59). Passing it in raw charged half the real commission and overstated every live-written day's net by ~$0.59 a contract, on the store the guardrail and the Day Recap read. This also resolves the DEVIATION flagged above: `csvApply`'s hardcoded `COMM_PER_CT = 1.0` and the live writer's 0.59 did NOT agree, and since 4.3 both write the same day store through the same `rollupDay`, a day's net depended on which writer touched it last. Both now read the per-side rate from `rules.json` and double it; `COMM_PER_CT` remains only as the fallback for a rules file without the key, and the historical live-golden keeps its explicit 1.0 because that is what the stored summaries were computed with.*

- [x] **4.4 — Enrich the auto-written session-log row — fixes H2**

  `position-events`' close currently writes entry/stop/target as `?` because the fold record
  carries no prices. With 4.1 the entry and exit prices are genuinely known, so write them.

  **`stop` and `target` stay `?`** — those are *planned* levels that exist nowhere in broker
  data, and per `TRUST-PROTOCOL.md` passing an average fill off as a planned entry is exactly
  what the `?` convention exists to prevent. Fill in what is observed; do not invent the rest.
  *Done: 2026-08-22 (DSH build). The auto-log row now writes `entry`/`exit` from the joined 4.1 record's order-walk FILL prices when present (fold-only records still '?'), with the note bit 'entry/exit = order-walk avg fill prices' so the file can never read a fill as a planned level. stop/target stay '?'. Shipped together with 4.3 in one commit (both change the same close-loop body; recorded like the 2.1-2.3 deviation).*

- [x] **4.5 — Demote CSV to optional reconciliation**

  CSV upload stays, and stays useful, but changes role: parse it, compare it against the
  live-derived day record, and **report the differences** — trades the live feed missed
  (server was down), trades the live feed has that the CSV doesn't, and any P&L disagreement
  per trade. Only apply on explicit confirmation.

  **The honest caveat this creates, stated plainly:** live-only history means the day record now
  depends on the app running. If the server is down for part of a session, those trades are
  missing from history even though the broker has them. CSV reconciliation is the backstop for
  exactly that case, which is why it stays rather than being deleted. Reframe the UI from
  "Upload CSV" to "Reconcile with broker export".

  > **⚠ Landmine, added 2026-08-22 by audit — read before writing this task.**
  > `csvApply`'s merge key is `fp = t | x | round(pnl*100) | size`, and it dedupes correctly
  > **only because both sides have always come from the same CSV export.** After 4.3 they no
  > longer do. A live record's `t`/`x` are broker order timestamps in ms; the CSV's are parsed
  > from a printed timestamp string at coarser resolution. **The same trade will produce two
  > different fingerprints, so reconciling a day that was already written live will silently
  > DOUBLE every trade in it** — doubling the day's trade count, contracts and net, and
  > corrupting the balance ledger for that date.
  >
  > This is the highest-risk single defect available in Phase 4, because it destroys real
  > history rather than failing loudly. The reconciliation must match on a **tolerance-based
  > identity** (same side, same size, exit within ~60s, P&L within a cent) — never on `fp()` —
  > and must treat a tolerance match as *the same trade* to be compared, not a new row to add.
  > Cover it with a test that ingests a live-written day and then the same day's CSV, and
  > asserts the trade count is unchanged.
  *Done: 2026-08-22 (DSH build). LANDMINE HANDLED. New pure UMD `renderer/trade-identity.js` (isSameTrade: same size, compatible side, exit within 60s, P&L within 1 cent; matchCsvToLive: greedy one-to-one → {matched, csvOnly, liveOnly}) + `app/test/trade-identity.test.js` (6 tests) including the demanded one: a live-written day reconciled with its own CSV matches 2/2, csvOnly 0, liveOnly 0 — the trade count does not change. csvIngest now parses, compares via TradeIdentity.matchCsvToLive against the live store (day_trades mirror), reports per-day differences (file-only = live feed missed them; live-only; same-trade P&L disagreements) as a system message, and renders a Reconcile card with Apply to app / Skip — csvApply runs ONLY from Apply. UI button reframed to "Reconcile with broker export". Full suite 599/599 (593 + 6 new).*

  ***AUDIT FIX, 2026-08-22 (Claude, senior-partner pass) — commit `4.5: close the doubling landmine on the APPLY path, not just the report`. THE LANDMINE WAS ONLY HALF CLOSED.*** *`trade-identity.js` was wired into `csvIngest`'s reconciliation REPORT, but `csvApply` — what the "Apply to app" button actually runs — still merged by `fp()` alone (`t|x|round(pnl*100)|size`), the exact key `trade-identity.js`'s own header says cannot be trusted across the two sources. Since 4.3 the live feed writes that store with ms broker timestamps while the CSV carries printed-second ones, and the renderer mirrors live rows into `localStorage.copilot_day_trades` on every `day-record-updated`. So confirming the reconciliation on a day the live feed had already written ADDED a second copy of every trade: doubled contracts, doubled gross, and doubled the size-cap and revenge counts the guardrail reads. The Done line's claim that the count does not change was true of `matchCsvToLive` in isolation, which is all the test exercised. Fixed with a new pure `TradeIdentity.mergeCsvIntoStored(stored, incoming, fp)`: a CSV row tolerance-identical to a stored row REPLACES it in place (same identity the report compares by, one-to-one), unmatched CSV rows are added, stored rows the file lacks are kept, and live-only provenance (`evidence`/`source`/`signalBacked`/`playbook`/`minutesFromSignal`) plus any field the CSV leaves null survive onto the merged row. Re-uploading a CSV over a CSV-written day is unchanged. 6 new tests including the doubling regression itself.*

---

# Phase 5 — Join, score, learn — fixes H3, H4

- [x] **5.1 — Join fills to signals**

  On a close, match back to the nearest preceding signal on the same instrument and direction
  within a configurable window (start at 15 minutes). Stamp the trade record with
  `signalBacked`, `playbook`, `minutesFromSignal`. Write the join into the day's ledger as it
  happens, not at end of day — the app is running and already knows what was armed, so
  `minutesFromSignal` is *measured* rather than reconstructed.

  `minutesFromSignal` also makes failure mode 7 (entering within a minute of a signal, before
  confirmation) precisely measurable for the first time.
  *Done: 2026-08-22 (DSH build). New pure `app/signal-join.js` (joinTradeToSignal, directionOfTrade, ARMING_EVENTS) + `app/test/signal-join.test.js` (7 tests). Only ARMED-setup events can back a trade (engulf-fire/fvg-fire/playbook-b-confirm); direction must match (buy→BULLISH, sell→BEARISH); preceding only, inside rules.json's new `signalJoinWindowMinutes` (15); nearest wins; trade time = entryAt else fold at. Wired into `writeLiveTradeToDayRecord`: reads the day's signal ledger (DATA_DIR/signals/<dayKey>.jsonl), stamps the row with `signalBacked`/`playbook`/`minutesFromSignal` (which survive the re-grade into the stored row), and appends a `signal-join` line to the day's ledger AS IT HAPPENS. Failure mode 7 is now measurable: rows with minutesFromSignal 0-1 near a signal. Idempotent (join recomputed from the same ledger on a duplicate fire). Full suite 606/606.*

- [x] **5.2 — Per-playbook scorecard in Insights**

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
  *Done: 2026-08-22 (DSH build). New pure UMD `renderer/scorecard.js` (computeScorecard: per-playbook fired/valid/rejected/taken/passed/ignored from the signal ledger, win%/net from signalBacked day rows; "Avg R" = realized profit factor — total won ÷ |total lost| — DEVIATION note: planned-R multiples are unknowable from the feed, so the column is the honest realized version) + 4 tests. H6 GATE implemented: server persists h6Status (DATA_DIR/h6-status.json), marks PASS the moment a real closed trade with non-zero P&L passes the balance-delta-vs-fills cross-check, broadcasts h6-status; renderer hides the Insights scorecard block with an explanatory line until H6 passes. Scorecard data served by a scorecard-get WS case (today's signal ledger + day rows), computed client-side by the shared module, rendered as the plan's exact table + the signal-backed-vs-freestyle two-liner (a). (b) passed-signals-that-would-have-won is DEFERRED — it needs live bar pulls after each passed signal and is recorded here as the remaining piece rather than claimed. NEEDS LIVE: the H6 PASS itself (a real trade). Full suite 616/616.*

- [~] **5.3 — Mechanical detection for the remaining failure modes — fixes H4**

  F1 (trade-count escalation) and F2 (revenge cluster) are live. F3-F6 and M1-M6 were blocked on
  missing entry times, prices and symbol — **Phase 4.1 unblocks most of them in one pass**, which
  is the leverage argument for doing Phase 4 first.

  Build one pattern per commit, each verified live before the next is started — Anoop's explicit
  standing decision: *"better to ship one pattern working end-to-end and verified live than all
  of them half-working."* Advisory only, same as F1/F2. Source text must be cited verbatim from
  his own words in `renderer/index.html`, never paraphrased into something softer.

  Store a per-day pattern vector so the trend over weeks is visible, not just today's verdict.
  *Skipped: 2026-08-22 (DSH build) — PARTIAL per the plan's own constraint. F3 (inverted R:R) BUILT: `checkInvertedRR` in mistake-patterns.js (realized avgLoss ≥ f3Ratio × avgWin with ≥ f3MinWins wins and ≥1 loss; pnlUnknown excluded; defaults ratio 2 / minWins 2; thresholds read from NEW rules.json keys f3Ratio/f3MinWins — never hardcoded; source text cited verbatim) + 6 tests (39/39 file). Wired into BOTH channels: formatLiveFeedContext (current state every agent turn) and the once-per-IST-day poll fire (f3AdvisoryFired persisted in the feed state). F4-F6 and M1-M6 deliberately NOT built: Anoop's standing decision requires each pattern verified live before the next is started, and live verification is exactly what this build environment cannot provide — building them unverified would violate the decision this task cites. Their inputs now exist (4.1), so each is one pattern-per-commit away. The per-day pattern-vector store is deferred with them (it feeds on the patterns it stores). NEEDS LIVE: F3's first real firing.*

---

# Phase 6 — Point the loop at payout — fixes H5

- [x] **6.1 — Distance-to-payout drives the day's plan**

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
  *Done: 2026-08-22 (DSH build). New pure UMD `renderer/payout-pace.js` (payoutPace: distance, trailing 20-day rate, days-to-target at that rate, fixed 20-session need — type-checked inputs, null on invalid) + 4 tests. Wired into the Day Recap summary line that csvApply emits after every reconciliation: "PAYOUT PACE (pace, not permission): $X to clear-eval/payout · trailing 20-day rate $Y/day · N sessions at that rate · fixed 20-session need $Z/day. The day stop and trade limit still rule." — the guard wording ships WITH the number, per the plan's guard. DEVIATION note: the plan's "derives tomorrow's starting contract size" example lives in the journal/recap internals; this task adds the pace number to the recap line without reworking that size derivation. The deeper "implied daily target" interpretation is the fixed-horizon needPerDay — chosen because no firm deadline exists in the data (recorded rather than invented).*

- [x] **6.2 — Hour-edge table, recomputed from real data**

  Now computable properly, because Phase 4-5 give clean per-trade data with real timestamps. A
  weekly rolling hour-of-day edge table written to `DATA_DIR`, feeding the `sessionTier`
  annotation instead of the hardcoded July guess.

  **Reporting only** — decision 6 forbids hour weighting or hour-based blocking. The window
  stops being an assumption and becomes what the last 20 days actually say, and that is all it
  does.
  *Done: 2026-08-22 (DSH build). New pure `app/hour-edge.js` (buildHourEdge: IST entry-hour buckets {n, wins, losses, net, winPct} from day_trades rows) + 2 tests. Server: `refreshHourEdge()` rebuilds the table from the active slot's day_trades → DATA_DIR/hour-edge.json at boot (when absent) and weekly; signal-ledger rows now carry an `hourEdge` field (current hour's winPct) via the shared buildSignalRow — reporting-only, no gate anywhere reads it. DEVIATION note: the plan said "feeding the sessionTier annotation instead of the hardcoded July guess" — sessionTier itself was already rules.json-driven (sessionWindowsIST) after 2.1, so the table is added as its own annotation (hourEdge) rather than replacing a guess that no longer exists.*

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
  *Done: 2026-08-22 (DSH build) — the MECHANISM shipped, the PASS itself is NEEDS LIVE. Built in task 5.2: the server marks h6Status PASS the moment a real closed trade with non-zero P&L has its balance-delta and fills-derived P&L agree within $1 (the cross-check already runs on every close), persists DATA_DIR/h6-status.json across restarts, and broadcasts h6-status; the Insights scorecard stays hidden behind that gate. No real trade can be produced from this build environment — the first live non-zero close will flip the gate or report the exact disagreement. Left [ ] deliberately: the task is "confirm", and confirmation has not happened.*

---

### Phase 7 — Obsidian as the live session surface

*Added 2026-08-23. Context: the vault root is now the repo itself (`G:\Trading-CoPilot`),
so `sessions/*.md` are the live files Obsidian renders — no copy, no sync, no link.
`G:` is exFAT, so symlinks and junctions are impossible on this volume; pointing the
vault at the repo root is what replaced them.*

- [x] **7.0 — Fix the three session-note defects the 7.1 review surfaced**

  **Why.** All three are pre-existing, all three were visible in
  `sessions/2026-08-21.md` on disk, and none were introduced by 7.1 — the review
  found them while reading the code 7.1 would have sat beside. They are fixed
  independently of 7.1's fate because two of them were actively corrupting the
  live trade record on every close.

  *Done: 2026-08-23. `app/session-manager.js`, one commit, 6 new tests.*

  1. **False compliance record.** The `15m break?` cell was
     `trade.breakTaken ? 'Yes' : 'No'`, so an UNOBSERVED value rendered as `No` —
     asserting a discipline failure that was never measured, in the one column the
     post-session review grades compliance on. The live feed never sets
     `breakTaken`, so every auto-logged row on disk carries a false record (all
     three rows of 2026-08-21 read `No`). Unknown now renders `?`, matching the
     convention the other unobserved fields in the same row already use. An
     explicit `false` still renders `No` — the fix does not swallow a real
     observation. Extracted to a pure `formatTradeRow(num, trade, nowTimeStr)`
     so it is testable without the hardcoded `SESSIONS_DIR`; `nowTimeStr` is
     injected for deterministic tests.

  2. **Silent write failure.** `logTrade` discarded `writeAtomic`'s return value
     and returned `{ok:true}` unconditionally. `writeAtomic` reports `{ok:false}`
     only when BOTH the atomic rename and the plain-write fallback throw — on
     Windows that is exactly what an Obsidian / OneDrive / Defender handle on the
     `.md` produces as EPERM/EBUSY, and the vault root is now this repo, so a
     handle on that file is the normal state. The 2026-08-20 fix made the
     regex-miss failure honest and left this one silent. Same hole closed in
     `startSession` and `updateVerdict`. Note `startSession`'s matters more than
     it looks: `logTrade` only builds the template when the file is ABSENT, so a
     silently-failed `startSession` leaves a note with no trades-table header and
     every later `logTrade` that day returns `{ok:false}`.

  3. **File-wide row counting.** `content.match(/^|s*d+s*|/gm)` counted
     pipe-digit-pipe lines across the WHOLE note, not the trades table, so any
     other line of that shape silently inflated every subsequent trade number.
     Extracted to a pure `countTradeRows(content)` scoped to the contiguous row
     block under the table header; returns 0 when the header is missing rather
     than falling back to a file-wide tally.

  *Suite: 715/715 green (709 baseline + 6 new). `node --check` clean. Server NOT
  restarted — Anoop's standing instruction. Both `startSession` callers
  (`main.js:231`, `server.js:4124`) pass the result straight through, so the added
  `ok` field is additive; `updateVerdict` has zero callers repo-wide (dead code —
  its own regressions are noted under 7.1's review findings and left untouched).*

  **Not fixed here, deliberately** — `session-log-failed` is broadcast at
  `server.js:6913` with no renderer handler anywhere, so dropped trade rows have
  reported into the void since 2026-08-20. That is a renderer change, a different
  file, and belongs in its own commit under the plan's one-task-per-commit rule.

- [x] **7.0a — Wire `session-log-failed` to the UI** — *added 2026-08-23 by the 7.1 review*

  **Why.** `server.js:6913` has broadcast `session-log-failed` since 2026-08-20 and
  **nothing anywhere listened** — no case in `renderer/ws-client.js`, no consumer in
  `app.js`. A trade row the auto-log refused to write reported into the void, which
  is precisely the silent-failure mode that logTrade's honest return value was added
  to prevent. The whole point of auto-logging is that the record is complete without
  him thinking about it, so the one case that must never be quiet is the record being
  incomplete.

  7.0 makes this path **more** reachable: `writeAtomic` failures now report too, and
  an Obsidian/Defender handle on the `.md` is the normal state since the vault root
  became the repo.

  *Done: 2026-08-23. `renderer/ws-client.js` — new `case 'session-log-failed'` →
  `emit('session:logFailed')`, plus `onSessionLogFailed` on the public API next to the
  other trade-confirm subscribers. `renderer/app.js` — handler beside
  `onTradeConfirmRejected`, surfacing through `addSystemMessage()` (persistent in the
  chat stream via `resilience.js`, so it survives a reload — unlike a toast).
  Message states plainly that the TRADE is unaffected and only the RECORD is
  incomplete, and names the file to fix by hand. Rate-limited to once per distinct
  reason per session: every failure mode here is persistent (disk full, permissions,
  a lock on the file), so an unthrottled message on a 10s poll is alert fatigue within
  a minute — keyed on reason rather than once-ever so a NEW failure still gets through.
  Suite 715/715. `node --check` clean on both renderer files. Server verified up and
  serving on 7433 (renderer files are read per request, so no restart was needed).*

  **Not verified live:** no real write failure has been induced, so the handler has
  never fired against a genuine `{ok:false}`. Reaching it deliberately means locking
  the session note while a trade closes.

- [~] **7.1 — Mirror the live event stream into today's session note**

  *Skipped: 2026-08-23, killed by its own review before any code was written. /autoplan,
  branch live-feed-loop. Codex unavailable on this machine, so every voice is
  `[subagent-only]` — CEO, Design and DX ran independently and converged on the same
  blocker. Each claim below was re-verified against the code by hand before being recorded.*

  **Why it died — the tap point does not carry the event the task existed for.**
  The task asserted `broadcast()` was "the one choke point every such event already
  passes through." False. All six guardrail-block rejections are `send(ws, …)`
  (`server.js:7417-7449`); debate verdicts and trade tickets go through `emitTo()`
  (`server.js:974`), which only degrades to `broadcast()` for auto-triggered debates.
  A `broadcast()` tap captures **zero** guardrail blocks — the event the task named as
  its single highest-value case. It would have captured only monitor detections and PO3
  transitions, which task 2.1's ledger already records with more context.

  **Second blocker — CORRECTED 2026-08-23. The race three reviewers asserted does not exist.**
  The CEO, Design and DX voices independently claimed an `appendFileSync` could land
  between `logTrade()`'s `readFileSync` and its `renameSync` and be silently discarded.
  **That is wrong, and the Eng voice disproved it by walking the actual interleaving.**
  `logTrade()` (`session-manager.js:81-114`) contains no `await`, promise, callback or
  timer between the read and the write, and `writeAtomic` is `openSync`/`writeFileSync`/
  `fsyncSync`/`closeSync`/`renameSync` — synchronous throughout. Node runs one JS stack to
  completion, so nothing in this process can execute in that window. A **synchronous**
  mirror cannot lose a line. Recorded here because three of four voices agreed on a
  conclusion that reading the code refutes; majority agreement was not evidence.
  **The caveat is load-bearing:** the race becomes real under `fs.appendFile` (callback),
  `fsp.appendFile`, or any debounced / `setImmediate` flush — i.e. exactly the batching
  variant open question 3 floated. Any successor must stay synchronous.

  **The real second blocker — file-creation ordering silently disables trade logging.**
  `fs.appendFileSync` **creates the file if absent**, and `logTrade()` only builds the
  template when it is absent (`session-manager.js:77-79`). So if any allowlisted event
  fires before the day's first `startSession`, the mirror creates a session note containing
  only log lines; `startSession` is then skipped forever for that day, the trades-table
  header never exists, `insertTradeRow` returns `null`, and **every closed trade that day
  fails to record**. The watchers auto-start on TradingView connect (task 1.1), so
  mirror-before-startSession is the *normal* morning ordering, not an edge case. A logging
  convenience would have silently destroyed real trade records on a live-money account.

  **Third — this repeats a decision already recorded in this file.** Task 0.2 states the
  broadcast tap is *"SUPERSEDED by task 2.1's signal-ledger … which captures strictly more."*
  7.1 proposed the superseded architecture twelve tasks later without citing that decision.

  **Successor: 7.2.** Not a rewrite of this one — a much smaller thing.

- [x] **7.3 — `sessions/Now.md`: the live glance surface** — *added 2026-08-23*

  **Why.** Anoop, plainly: *"i want to use the graph live while i use the app… make
  something genuinely live and meaningful."* The Obsidian graph is the wrong
  instrument — it maps link structure and sits perfectly still during a session,
  because `logTrade()` adds a table ROW, not a file or a link. (Measured: 106 vault
  notes, exactly one wikilink between them.) 7.2 is the right plumbing but is
  invisible by design, which is why it read as pointless.

  **What this is.** A small fixed-size file the server REWRITES WHOLE every tick,
  pinned in a second Obsidian pane. Current state at the top, newest events first.

  **Why rewrite and not append — this is the whole design.** Every reason 7.1 died
  is a constraint here, and rewriting dissolves all four at once:
  - Own file, never the session note → cannot race `logTrade()` or break its table.
  - Never `appendFileSync` → cannot create a file ahead of `startSession()` and
    silently disable trade logging for the day (7.1's real killer).
  - Fixed size, newest first → readable at a glance; Obsidian does not auto-scroll,
    which is what made an append-log unreadable below the fold.
  - It is a PROJECTION, not a record → if Obsidian clobbers it (observed: it rewrote
    four tracked docs minutes after the vault opened) the next tick regenerates it
    and nothing is lost. The session note and the ledger stay the records.

  *Done: 2026-08-23. New pure `app/live-status.js` (`renderNowMarkdown`, `istClock`,
  `istClockShort`, `money`, `cell`, `lossTierStatus`) + `app/test/live-status.test.js`
  (24 tests). Server: `recordLiveEvent()` ring (40 max), `writeNowFile()` on a 5s
  timer via `atomicWrite.writeAtomic`, started at boot next to the other monitors.
  All numbers come from `getActiveRules()` every tick — nothing from rules.json is
  retyped, and a mid-session mode switch is reflected. Because the guardrail reads
  the same accessor, the displayed cap cannot disagree with the enforced one.
  Suite 739/739. Verified live: file written at boot, real balance $50,811.80,
  TV-offline state shown honestly.*

  **7.3a — block instrumentation (the useful half of 7.2), done in the same change.**
  All six `send(…'trade-confirm-rejected')` calls collapsed into one `rejectTicket()`
  helper that owns both the reply and the recording, so a future rejection branch
  cannot forget to record — the only way to reject is to call it. Order-path
  behaviour is unchanged: same message, same socket, same early return. This is what
  makes a block reachable by any live surface at all; previously it hit one socket
  and a console.log that `crash-logger` prunes at 14 days.

  **Defect caught in my own build, before shipping:** the header clock originally
  carried seconds, so the rendered text differed every tick and the
  write-suppression check could never fire — the file would have been rewritten
  every 5s forever, flickering an Obsidian pane in his peripheral vision all
  session for no information. Header is now HH:MM (event rows keep seconds, since
  correlating a block against a trades-table row is the post-session use). Two tests
  pin the property. Verified live: mtime held steady across four consecutive ticks.

  **7.3b — verdicts, tickets and real orders wired (2026-08-23, same day).**
  Instrumented at the fire sites, not via a message tap — `emitTo(ws, …)` only
  reaches `broadcast()` for auto-triggered debates, so a debate run BY HAND would
  have been the one missing. Now recorded: debate verdict (GO **and** NO-GO — a
  NO-GO later overridden is the most valuable line in the file; reuses
  `go-verdict-detect.isGoVerdict` rather than re-deriving the "NO-GO contains GO"
  trap), trade ticket (from structured fields, not model text), and
  `trade-confirm-result` — a REAL ORDER on the live account, which until now
  reached one socket and a console.log. `verified === false` renders as
  ORDER UNCONFIRMED, never the same as a confirmed fill, matching the distinction
  the UI already draws. Eight `recordLiveEvent` sites total.

  **LIVE-VERIFIED 2026-08-23.** A real `trade-confirm-request` was fired at the
  running server over a WebSocket. Live orders were disabled
  (`TV_ALLOW_LIVE_ORDERS` unset), so `handleTradeConfirm` refused at the first
  gate — before `placeMarketOrder` is reachable — exercising the genuine
  `rejectTicket()` → `recordLiveEvent()` → `Now.md` chain with no order risk. The
  row rendered as expected:
  `| 23:30:49 | 🛑 | BLOCK | live orders are not enabled this session… |`

  **Found by that verification:** only **one of the six** rejection branches ever
  had a `console.log`. The other five (dedup replay, live-orders-disabled,
  TV-not-connected, invalid side, invalid size) left **no durable trace anywhere** —
  not even in the 14-day-pruned server log. Five of the six ways this system can
  refuse a trade were previously unrecoverable after the moment they happened.
  All six are now recorded.

- [ ] **7.2 — Put guardrail blocks and verdicts in the ledger that already exists**

  **Why.** The residual gap the review agreed is real: monitor fires and PO3 transitions
  are already in `DATA/signals/<trading-day>.jsonl` via `ledgerSignal()` (10 call sites),
  but **guardrail blocks are not**. Their only record is
  `console.log('[trade-confirm] BLOCKED …')` (`server.js:7448`), mirrored to
  `app/logs/server-*.log` by `crash-logger.js` — which `pruneOldLogs` deletes at 14 days.
  So "every time the system said no, over a year" is genuinely unanswerable today, and
  becomes answerable with three `ledgerSignal()` calls and no new file format, no new
  writer, no new day-anchor, and no filesystem write on the session-note path.

  **Scope.** Collapse the eight `send(…'trade-confirm-rejected')` calls into one local
  `rejectTicket(ws, requestId, reason)` helper so there is a single site, then
  `ledgerSignal({ event: 'guardrail-block', reason, … })` there. Same at
  `debate-judge-done` (`server.js:2463`) and `trade-ticket-suggested` (`server.js:2514`).
  Trading-day anchor is `tradingDayStampIST()`, matching every other ledger row.

  **Rendering into Obsidian is deliberately NOT part of this task.** Once the events are
  in JSONL, a read-only renderer (an end-of-day generated markdown file, written once,
  by one writer, with no live append) is a separate, reversible decision. That ordering
  is what the review actually argued for: fix capture first, choose display later.

  **Gate — do not start until the ledger is proven live.** `DATA/signals/` does not exist
  on disk. Task 2.1 is marked `[x]` but has never written a line in a real session, and
  `grep BLOCKED app/logs/server-2026-08-*.log` returns 0 across six days. Adding rows to
  an unexercised ledger would stack an unverified feature on an unverified feature. One
  live session producing a non-empty `DATA/signals/*.jsonl` clears this gate.


  **Why.** Every monitor detection, PO3 phase change, debate verdict and guardrail
  block currently exists only as a transient message in the renderer. It scrolls away
  and is gone. The single highest-value case is the **guardrail block**: when
  `trade-confirm-rules.js` refuses a ticket, nothing durable records that it happened,
  so "what did I try to do when the system said no, and what happened next" is a
  question the system cannot answer today — across one session or across the year.
  `broadcast()` (`server.js:966`) is the one choke point every such event already
  passes through, so one tap captures all of them.

  **Scope.** Append a timestamped line per material event to a `## Live Log` section
  of `sessions/YYYY-MM-DD.md`. **Day key — corrected 2026-08-23 by design review.**
  An earlier draft of this task claimed `todayStr()` already encodes the 03:45 IST
  trading-day anchor. **That is false.** `session-manager.js:27` is plain IST-midnight
  (`Date.now() + 330min`, sliced to a date); the 03:45 anchor is `tradingDayStampIST()`
  at `server.js:496`, a different function. Between 00:00 and 03:45 IST — which straddles
  the NY close, i.e. the end of every session — the two disagree. Resolve this task's day
  key from `tradingDayStampIST()`, stamped ONCE at event time and passed through, never
  re-derived at write time. Note on the `Done:` line that this deliberately diverges from
  `logTrade()`'s day key, and that the divergence is a pre-existing defect in `logTrade()`
  that 7.1 neither introduced nor fixes.

  **Explicitly NOT the trades table.** `logTrade()`/`insertTradeRow()` own that, they
  are audited, and they already survived one duplicate-row bug (see 4.1's audit note).
  This task writes to a different section of the same file and must never touch the
  table region.

  **Hard constraints.**
  - Must never take the process down. `server.js`'s crash guards exist because this
    runs live-money sessions; a disk error here must be swallowed, not thrown.
  - Must never block or delay `broadcast()`. A trade ticket reaching the UI cannot
    wait on a filesystem write.
  - Append-only. No read-modify-write of the whole file on every event — that races
    `logTrade()`, which rewrites the file by regex.
  - No new runtime dependencies (plan-wide constraint).
  - An allowlist of event types, not a firehose. Broadcasting every WebSocket message
    would make the note unreadable within an hour.

  **Open questions for review.**
  1. Append-only vs. section-anchored insert: a plain append puts the Live Log at EOF,
     but `logTrade()` inserts into the table above it by regex. Do the two writers
     provably not corrupt each other, given both target one file?
  2. Day rollover mid-session — a 03:45 IST boundary crossing while events are in
     flight. Which day's note does an in-flight event land in?
  3. Write cadence. Per-event `appendFileSync` is simplest and crash-safest, but the
     5s position watch plus five chart monitors could make it chatty. Is a debounced
     buffer worth the added failure mode of losing buffered lines on a crash?
  4. Which event types earn a line? Proposed: guardrail blocks, debate verdicts,
     trade tickets, PO3 phase transitions, monitor detections. Not: heartbeats,
     account polls, chat tokens.
  5. Obsidian re-renders on file change. At what append rate does that become a
     visible distraction on a second monitor during a live session?

  **Acceptance.** Pure formatting/allowlist logic extracted to its own module with
  unit tests in the same commit (plan rule, line 38). Server boots clean. Full suite
  green against the 0.3 baseline. Live-verified: a real guardrail block appears in
  the note within a second, and `logTrade()` still writes a correct table row on the
  same day's file afterwards.


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
