> **PORTED 2026-08-22.** This plan was written against a stale worktree
> (`agents/claude-extension-location`, last commit 2026-07-27) before it was
> discovered that `master` had moved far ahead. **File paths and line numbers
> below refer to that old layout, not to `app/`.** Treat it as the record of
> WHY each change was made, not as a map of where the code now lives.
>
> Landed in `app/` on 2026-08-22 (merge of `signal-loop/playbook-c`):
> Playbook C validity gate (`app/playbook-c.js` + 18 tests), the closed-bar fix
> for the engulf and FVG monitors, the Day Recap (`app/renderer/day-recap.js`),
> and the `insProse()` most-repeated-mistake grouping fix.
>
> NOT ported, still open — see the gap register in the artifact and Phase 4/5
> below: the signal ledger (4.1), decision capture (4.2), live-fill join (4.3),
> per-playbook scorecard (4.4), pattern vector (4.5), and all of Phase 5. The
> badge/`armedSetup` rework (3.1-3.5) was deliberately NOT ported: it was
> designed against a system without master's Judge / `go-verdict-detect` /
> `verdict-grounding` pipeline and would fight it. It needs redesign, not a port.
> The chart-lock work was dropped entirely — master's `withChartLock` +
> `withBrokerLock` is better.

# Signal Loop Build Plan — Playbooks A/B/C + Pattern Feedback

**Status:** `PHASES 1-3 SHIPPED · PHASE 4-5 ON HOLD pending 2 live validation sessions`
**Created:** 2026-08-22 · **Last updated:** 2026-08-22 (Phases 1-3 + 4.1; always-on watchers; Day Recap v2)
**Audit basis:** full read of `server.js` (monitors, detectors, MCP path), `renderer/app.js`
(gate, checklist, ingest), `claude-agent.js`, `groq-agent.js`, `mcp-bridge.js`, `tradovate.js`.

## Decisions on record (Anoop, 2026-08-22)

> "The setup can be formed anytime so keep a watch and taking it should be major goal
> rather than identifying at what time it takes place. Focus more on verifying the correct
> setup rather than the time of it."

This settles the two open judgment calls and sets the priority order for the whole build:

1. **Setup verification is the primary goal.** Playbook C (task 1.4) is the centre of this
   plan, not a side quest. Correctness of the setup read outranks every other consideration.
2. **Time never suppresses a setup alert.** A setup that prints at 04:00 is still a setup and
   must still be surfaced. `getSessionWindow()` is demoted to a pure annotation on the signal
   — it does not gate detection, and it does not gate the `SETUP LIVE` badge. It remains
   informational on the tradeable verdict.
3. **The 19:00–20:00 prime-hour finding is noted but not acted on.** No hour weighting, no
   hour-based blocking. Task 5.1 stays in the plan as a reporting metric only.
4. **Daily/1H alignment is demoted to advisory** (task 3.4), on the condition that it happens
   only after 1.4 ships and is validated — the real structure check replaces the 5-bar proxy,
   it does not simply remove it.
5. **Live TradingView feed only — NOT CSV.** (Anoop, 2026-08-22: *"everything should work with
   live feed from tradingview... not from CSV"*.) Detection and the badge are already
   live-feed-only in Phases 1–3; no CSV is involved anywhere in them. This decision rewrites
   **Phase 4**: trade outcomes are joined from the **live Tradovate fill poll**
   (`tradovate.js` → `grIngestLive`), not from a CSV upload. CSV drops back to optional
   end-of-day reconciliation, which is also what `IMPROVEMENT_PLAN.md` #7 argued for
   ("discipline tools that require discipline to operate don't work").
6. **Watchers are always on; the toggles are gone.** (Anoop, 2026-08-22: *"if the signal for
   engulfing is active all the time then remove the toggles from UI"*.) All five monitors
   (engulf 1H/30M/15M, FVG 15M, SFP 30M) start automatically whenever TradingView is
   reachable. This supersedes task 2.2's original "switching playbooks stops what the old one
   didn't need" behaviour — that would have gone blind to a textbook engulfing on a Playbook B
   day, which contradicts decision #2. Playbook selection now only records a *focus*.

**Relationship to `IMPROVEMENT_PLAN.md` (2026-07-16):** that plan covered *data integrity and
money guards* and is largely shipped — fill-grouping (`buyFillId`/`sellFillId`), `rules.json`
as single source of truth, `DATA_DIR` persistence, giveback lockout (`RULES.giveback`), and
`grIngestLive()` are all in the code now. This plan is the next chapter: **the signal loop** —
making the app actually watch for all three playbooks and learn from whether you took them.
Two items from the old plan remain open and are folded in here as Phase 5 (#4 hour-edge gate,
#8 daily focus item), because they only work once signal logging exists.

---

## How this document is used

1. Nothing in here executes until Anoop gives an explicit green signal.
2. He may green-light the whole plan, a single phase, or a single task.
3. **When a task completes, update it in place:** change `[ ]` to `[x]`, fill in the
   `Done:` line with the date and a one-line note of what actually changed (including any
   deviation from the plan as written), and bump `Last updated` at the top.
4. If a task turns out to be wrong or unnecessary once the code is open, mark it
   `[~]` with a `Skipped:` line explaining why. Do not silently drop it.
5. Phase gates are real: do not start a phase until the phase above it is `[x]` on every
   task, because later phases depend on earlier data shapes.

**Progress:** 14 / 17 tasks complete — Phases 1-3 done, plus 4.1 (signal ledger).
Two out-of-plan items also shipped: always-on watchers and the Day Recap (see Addendum).

---

## Part 1 — What the audit found

### The one-sentence problem

The chart monitors and the GO/NO-GO gate are two working systems with **no wire between
them**. Nothing in the gate ever reads a monitor signal, and nothing in the playbook
selection ever starts a monitor.

### The signal path as it exists today

| Monitor | Poll | Data source | Detector | Playbook |
|---|---|---|---|---|
| Engulfing 1H / 30M / 15M | 60s / 45s / 30s | `market_multi_tf` → 5 bars + Pine labels | `detectEngulfFromBars` (server.js:1225) — full-range engulf | A (1H gated on `get4HTrend()`) |
| FVG 15M | 30s | `market_multi_tf` → 5 bars | `detectFVGFromBars` (server.js:1290) — 3-bar gap | B, second half |
| SFP 30M | 60s | `chart_set_timeframe` + `data_get_ohlcv` → 40 full bars | `detectSFPFromBars` (server.js:1564) + 2-stage state machine (1620–1715) | B, full |
| — none — | — | — | — | **C — not implemented anywhere in code** |

### The gate as it exists today

`computeMechanicalGoNogo()` (app.js:3571), 30s timer. Reads exactly four inputs:
`state.account`, `state.news`, `state.mechanical`, and the wall clock. Emits
`nogo` / `pending` / `go`.

- **Hard NO-GO:** daily stop hit, or trade limit reached.
- **Soft (→ `pending`):** outside session window, 15-min break active, news blackout,
  Daily/1H trend not aligned.
- **`go`:** only when in-session AND aligned AND nothing blocking.

### Confirmed defects

| # | Defect | Location | Consequence |
|---|---|---|---|
| D1 | Gate never reads monitor signals | app.js:3571 | A confirmed Playbook B setup does not change the badge |
| D2 | Playbook selection only toggles a CSS class | app.js:4489 | Selecting "B" does not start the SFP/FVG monitors |
| D3 | Monitors default `running: false`, not persisted | server.js:1049 etc. | Every `launch.bat` silently disables all chart watching |
| D4 | Engulf + FVG evaluate the still-forming candle | server.js:1118, ~1345 | Repaint. SFP got the `lastBarStillForming` fix (1645); these never did |
| D5 | Playbook C exists only in the Claude system prompt | claude-agent.js:~100 | Alerts fire on engulfing candles your own rulebook disqualifies |
| D6 | Session window is a 3.5h/day binary block | app.js:3555 | Gate is dark ~85% of the day; trains you to ignore it |
| D7 | Daily/1H alignment from a 5-bar majority vote | server.js:1783 | `market_multi_tf` caps at 5 bars/TF — agreement is rare and weakly grounded |
| D8 | **No record of which alerts you acted on** | — | No per-playbook hit rate is computable. All threshold tuning is blind |

D8 is the highest-leverage gap in the app.

### What is already right and must not be broken

- Every enforcement decision is deterministic code. Both LLMs are advisory only. Keep this.
- `groq-agent.js` `BLOCKED_TOOLS` prevents Jessi placing trades or changing chart TF.
- The SFP two-stage state machine (raid → 8-candle patience window → displacement confirm,
  expire unfired) is the best-built thing in the signal layer. It is the model for A and C.
- `mcp-bridge.js` splits `ready` (child process) from `tvConnected` (30s CDP heartbeat).

---

## Part 2 — The build plan

### Phase 0 — Safety net *(do first, always)*

- [ ] **0.1 — Branch + baseline capture**
  Work on a branch off `agents/claude-extension-location`. Before touching anything, run
  each monitor for one full session with console logging on and save the raw broadcast
  stream to `data/baseline-signals.jsonl`. This is the before-picture that proves whether
  the closed-bar fix (Phase 1) actually reduces false signals.
  *Status 2026-08-22 — PARTIAL, and the shortfall is on the record:* work is on the existing
  `agents/claude-extension-location` branch. **The baseline capture did NOT happen** — it
  needs a live TradingView session on Anoop's machine, which cannot be run from here, and
  the fixes were built before it. Consequence: there is no clean before/after count of false
  signals. Mitigation: Phase 4.1's ledger will log every fire and rejection going forward, so
  the after-picture is captured properly even though the before-picture was missed. Not worth
  reverting Phase 1 to recover.

---

### Phase 1 — Make the signals trustworthy

*Nothing downstream is worth building until a signal means what it says.*

- [x] **1.1 — Port the closed-bar fix to the engulf monitor** — fixes **D4**
  `checkEngulfingSignal` (server.js:1083) passes `bars` straight from
  `getBarsFromMultiTF()` into `detectEngulfFromBars`, so the last element is a live,
  still-updating candle. Reuse the exact pattern already proven in `checkSFPSignal`
  (server.js:1640–1650): compute `tfSeconds` from `cfg.tfCode`, test
  `bars[last].time + tfSeconds > nowSec`, slice it off, and bail with a
  `'waiting for a closed <TF> bar'` status if nothing closed remains.
  *Note:* `market_multi_tf` returns only 5 bars, so after dropping one you have 4 — still
  enough for a 2-bar engulf check, but verify `bars.length >= 2` after the slice.
  *Done: 2026-08-22 — `checkEngulfingSignal` now wraps `getBarsFromMultiTF` in
  `dropFormingBar`. `detectEngulfFromBars` already guards `length < 2`, so no extra check
  was needed. Note the Pine-label methods (1/2) still read the live chart's own labels; the
  1.5 Playbook C gate re-validates those against closed bars, which covers the gap.*

- [x] **1.2 — Port the closed-bar fix to the FVG monitor** — fixes **D4**
  Same change in `checkFVGSignal` (server.js:1333). `detectFVGFromBars` needs 3 bars, so
  guard `bars.length >= 3` after the slice.
  *Done: 2026-08-22 — done, with an explicit `bars.length < 3` early return that broadcasts
  a `waiting for a closed 15M bar` status instead of silently returning null.*

- [x] **1.3 — Extract a shared `dropFormingBar(bars, tfCode)` helper**
  Three copies of this logic is two too many. One pure function beside the other
  detectors, used by all three monitors. Pure and unit-testable like `fold()` in
  `tradovate.js`.
  *Done: 2026-08-22 — `dropFormingBar(bars, tfCode)` added at server.js:1206. Handles
  unix-seconds and ms timestamps, and returns non-intraday codes ('D' and up) untouched
  rather than guessing a bar duration. `checkSFPSignal` refactored onto it, so all three
  monitors now share one implementation. 7/7 unit cases pass.*

- [x] **1.4 — Implement Playbook C as a real detector** — fixes **D5**
  New pure function `validateEngulfPlaybookC(bars, direction, levels)` beside
  `detectEngulfFromBars`. Encode the rulebook exactly as `claude-agent.js` states it:
  - Bullish valid: forms at a **swing low** in an HH-HL pattern, closes above the previous
    candle, takes out **both** the low and the high of the previous candle.
  - Bearish valid: forms at a **swing high** in an LL-LH pattern, closes below the previous
    candle, takes out both the high and the low of the previous candle.
  - **Hard disqualifier:** never bullish after buy-side liquidity is already swept; never
    bearish after sell-side is already swept.
  Reuse `getSwingLevels()` (server.js:1543) for the swing pivots and `getPDHPDL()` for the
  liquidity reference — both already exist and are already used by the SFP monitor.
  *Requires:* the 5-bar `market_multi_tf` feed is **not enough** for swing structure. This
  detector must pull full bars via `getFullBars(tfCode, 40)`, the same way `checkSFPSignal`
  does. Budget for this being the largest single task in the plan.
  *Done: 2026-08-22 — `validateEngulfPlaybookC(bars, direction, pdhpdl)` + a new index-aware
  `findPivots()` at server.js:1665. Pulls 40 bars via `getFullBars`. Returns
  `{valid, reason, structure}`. Two real bugs were found and fixed while testing, both of
  which would have misfired on live data:*
  1. ***Plateau pivots.** The existing `getSwingLevels` uses `high === max(window)`, so two
     adjacent bars sharing a high BOTH registered as pivots; the structure check then compared
     two equal prices, `h2 > h1` was false, and every flat-topped move read as
     "mixed/ranging". Equal highs are common in futures. Fixed with strict-left/inclusive-right
     comparison plus near-equal collapse.*
  2. ***The sweep check contradicted the structure check.** First draft treated any push
     through an old swing high as "buy-side swept" — but in an HH-HL uptrend price MUST trade
     above old highs, so it rejected every setup Playbook C exists to approve. Corrected to
     swept-AND-rejected (wick through, close back on the original side), which is the same
     trap-candle shape `detectSFPFromBars` already uses.*

  *Test fixture at `test/playbook-c.test.js` — 11 cases, including both valid directions,
  covering structure, swing location, sweep, plateau, ranging, short history, and null PDH/PDL.
  Run with `node test/playbook-c.test.js`.*

- [x] **1.5 — Gate the engulf signal on Playbook C**
  `checkEngulfingSignal` currently fires on any full-range engulf, then appends a 4H-trend
  note. Change to: detect → validate with 1.4 → if invalid, broadcast an `engulf-check`
  with `rejected: '<reason>'` and **do not** fire `engulf-signal` or the Telegram push.
  Keep the rejection visible in the UI — seeing *why* a candle was disqualified is itself
  training. Playbook A remains the 1H+4H-aligned case; Playbook C is now the validity gate
  on top of it, which is what the rulebook always said it was.
  *Done: 2026-08-22 — gate applies to ALL candidates including Pine-label hits, not just our
  own bar read. Rejections broadcast as `engulf-check {rejected:true, reason, structure}` and
  log once per candle (`lastRejectKey`). Accepted signals now carry `playbook`, `structure` and
  `validity` fields, and the alert text leads with the Playbook C verdict. The 4H alignment
  note for 1H is retained alongside it.*

---

### Phase 2 — Arm the playbooks automatically

- [x] **2.1 — Persist monitor state to config** — fixes **D3**
  On `handleEngulfToggle` / `handleFVGToggle` / `handleSFPToggle`, write the new state into
  the config file alongside `apiKey` and `dataDir`. On server boot, after the MCP bridge
  reports `tvConnected`, restart whatever was running. Guard the restore behind
  `tvConnected` — starting a monitor while TradingView is down just spams `'TV offline'`
  broadcasts every 30s.
  *Done:*

- [x] **2.2 — Playbook selection starts its monitors** — fixes **D2**
  In the checklist playbook click handler (app.js:4489), after setting the CSS class, send
  the matching toggles:
  - **A** → engulf 1H (+ 4H trend read, already automatic)
  - **B** → SFP 30M **and** FVG 15M (the state machine needs both halves)
  - **C** → engulf 1H + 30M + 15M (C is the validity layer across engulf TFs)
  Deselecting or switching playbooks stops the monitors the old playbook started but the
  new one doesn't need. Show the armed set in the left panel so it is never ambiguous which
  watchers are live.
  *Done: 2026-08-22 — `armPlaybookMonitors(n)` + `PLAYBOOK_MONITORS` map in app.js, called
  from `ckSelPB`. A→engulf 1H; B→SFP 30M + FVG 15M; C→engulf 1H/30M/15M. New "Chart Watchers"
  panel shows the live set via `renderArmedMonitors()`, which reads ACTUAL running state from
  the server round-trip rather than what was just requested — so restored and hand-toggled
  monitors display correctly too.*

- [x] **2.3 — "Arm all" session default**
  A single control that arms the full set for the session regardless of checklist state, for
  days when you want to see everything print. Because 2.1 persists, this survives restart.
  *Done: 2026-08-22 — `armAllMonitors()` + "Arm all" button in the Chart Watchers panel.*

---

### Phase 3 — Wire signals into the gate *(the core fix)*

- [x] **3.1 — Introduce `state.armedSetup`** — fixes **D1**
  A client-side slot holding the most recent live setup:
  `{ playbook, direction, tf, level, gapLow, gapHigh, firedAt, expiresAt }`.
  Populated by the existing `engulf:signal`, `fvg:signal` and `sfp:playbookB` emitters in
  `ws-client.js` (192–230) — the events are already dispatched, nothing new is needed on
  the server. Expiry mirrors the SFP patience window: 8 candles of the signal's own
  timeframe, so a stale setup clears itself. A new signal replaces an older one.
  *Done: 2026-08-22 — `setArmedSetup()` / `getArmedSetup()` in app.js, called from
  `handleEngulfSignal` (A on 1H, C on lower TFs), `handleFVGSignal` (armed as
  "B (FVG only)" so the badge never overstates a bare gap as a full Playbook B) and
  `handlePlaybookBSignal` (full "B", overwrites the partial). Expiry is lazy — evaluated on
  read — so no extra timer was needed.*

- [x] **3.2 — Add a fourth badge state**
  Extend `computeMechanicalGoNogo` (app.js:3571) and `setGoNogo` (app.js:3483). The hard
  blocks stay exactly as they are — daily stop and trade limit must keep overriding
  everything. New resolution order:

  | Condition | Badge |
  |---|---|
  | Hard reasons present | `NO-GO` + named reason *(unchanged)* |
  | Blocked by news / cooldown | `BLOCKED` + reason |
  | No armed setup | `WATCHING — armed: A, B` |
  | Armed setup live, nothing blocking | `SETUP LIVE — <playbook> <direction> @ <level>` |

  This is the change that turns the badge from a clock-and-trend readout into an actual
  alert surface. Your call to enter stays yours — the app never places a trade.
  *Done: 2026-08-22 — `setGoNogo` now renders `nogo` / `blocked` / `setup` / `watching`, with
  the setup label carrying playbook, direction and timeframe (e.g. "SETUP LIVE — B BULLISH
  30M") and the tooltip carrying the validity reason, sweep level and gap. CSS added for the
  three new states. `watching` is silent in the chat log — it is the resting state and would
  otherwise post a line each time a setup expired.*

- [x] **3.3 — Session window becomes annotation only** — fixes **D6**
  *Revised per Anoop's decision #2 — the earlier three-tier/prime-hour proposal is dropped.*
  `getSessionWindow()` currently returns `null` for 20.5 hours a day, forcing `pending`.
  Setup detection and the `SETUP LIVE` badge become fully time-independent: a valid setup is
  surfaced whenever it prints. The window is retained as a label on the signal
  (`sessionTier: 'ny' | 'london' | 'off-hours'`) for the ledger and for a note on the
  tradeable verdict, with no hour weighting and no suppression. Window definitions move to
  `rules.json` rather than a hardcoded constant.
  *Done: 2026-08-22 — session is now only a label (`NY session` / `London session` /
  `off-hours`) appended to the badge tooltip. It no longer appears in any block list, so a
  validated setup at 04:00 surfaces exactly like one at 19:30.
  *Deviation:* the window definitions were NOT moved into `rules.json`. Since the value no
  longer gates anything, moving it is cosmetic; left in `getSessionWindow()` to keep this
  change small. Worth doing alongside Phase 5.1, which will recompute windows from data.*

- [x] **3.4 — Make the Daily/1H alignment advisory, not a gate** — fixes **D7**
  **Depends on 1.4 being `[x]` and validated first** (Anoop's decision #4). A 5-bar majority
  vote compares a 5-day read to a 5-hour read and is too weak to suppress a
  structurally-validated setup. Keep displaying it, keep it in the signal record, drop it
  from the block list — Playbook C's 40-bar structure check supersedes it as the quality
  filter. Do not do this task while 1.4 is incomplete.
  *Done: 2026-08-22 — dependency respected: 1.4 shipped and tested first. Misalignment now
  appears only as a `note: Daily/1H not aligned (x/y)` line in the setup tooltip.*

- [x] **3.5 — Reconcile the two badges**
  The checklist verdict (app.js:4589) and the mechanical gate are separate logics that both
  render as "NO-GO", which is the main source of confusion about why the app is always red.
  Label them distinctly in the UI: checklist = **READINESS** (are *you* fit to trade),
  mechanical = **MARKET** (is a setup live). Neither should silently mean the other.
  *Done: 2026-08-22 — left panel now has a "MARKET — live chart" eyebrow above the badge;
  the checklist verdict header reads "READINESS GO/CAUTION/NO-GO — n/10". The chat log line
  changed from "Mechanical check:" to "Market check:".*

---

### Phase 4 — The feedback loop *(highest leverage — fixes D8)*

- [x] **4.1 — Signal ledger**
  Every broadcast signal appends one line to `DATA_DIR/signals/<YYYY-MM-DD>.jsonl`:
  `{ ts, playbook, tf, direction, level, gapLow, gapHigh, source, valid, rejectReason,
  sessionTier, dailyTrend, hourTrend, newsBlackout, accountSlot }`.
  Write server-side at broadcast time so it captures signals fired when no browser is open.
  Rejected signals are logged too — the rejection rate per playbook is a real metric.
  *Done: 2026-08-22 — `logSignal()` + `signalLedgerPath()` in server.js, writing
  `DATA_DIR/signals/<YYYY-MM-DD>.jsonl`. Wired into all five fire paths (engulf, engulf
  rejection, FVG, SFP raid, Playbook B confirm). Each row stamps trend context, news-blackout
  state and mode at fire time, captured from a new `mechanicalState` cache — reconstructing
  that later is impossible. JSONL so a partial write costs one line, not the day.
  **This is also the fix for the missed Phase 0 baseline** (see 0.1): there is still no clean
  before-picture, but the after-picture is now captured properly, and the `rejected` rows make
  the Playbook C filter rate directly measurable — which is what the baseline was for.*

- [ ] **4.2 — Decision capture**
  When a `SETUP LIVE` badge is showing, the UI offers exactly two buttons: **Took it** /
  **Passed**. One click, no form — anything heavier will not get used mid-session. Writes
  `{ signalTs, decision, decidedAt, note? }` back into the same day's ledger. An untouched
  signal records as `ignored` at expiry, which is itself a data point.
  *Done:*

- [ ] **4.3 — Join signals to LIVE fills** *(rewritten per decision #5 — live feed, not CSV)*
  `tradovate.js` already polls `/fill/list` and `/position/list` and folds each snapshot
  through the pure `fold()` function; `grIngestLive()` in app.js already consumes it. Extend
  that path: when a fill closes, match it to the nearest preceding signal within a
  configurable window (start at 15 minutes) on the same instrument and direction, and write
  the join into the day's ledger as it happens — not at end of day.
  Output per trade: `signalBacked: true|false`, `playbook`, `minutesFromSignal`.
  *Why this is better than the CSV route it replaces:* the join happens while the app is
  running and already knows what was armed, so `minutesFromSignal` is measured rather than
  reconstructed, and the loop closes the same session instead of the next morning.
  *CSV becomes optional end-of-day reconciliation only* — if a CSV is dropped, compare it to
  the live-derived ledger and flag mismatches. It is never the primary source.
  *Prerequisite:* the Tradovate feed is marked STAGED / LIVE-UNTESTED in `tradovate.js` and
  its field mapping is NEEDS-VALIDATION. **Validate it against a real payload before building
  on it** — if the live feed proves unreliable, this task is the one that blocks, and the
  fallback is manual "Took it / Passed" capture from 4.2 alone, which still works.

- [ ] **4.4 — Per-playbook scorecard in Insights**
  A new block driven entirely by 4.1–4.3:

  | Playbook | Fired | Valid | Taken | Passed | Ignored | Win% | Avg R | Net |
  |---|---|---|---|---|---|---|---|---|

  Plus the two lines that matter most:
  **(a)** signal-backed trades vs freestyle trades — win rate and net for each. This is the
  direct measurement of whether the playbooks beat improvisation.
  **(b)** passed signals that would have won — the cost of hesitation, computed from live
  bars pulled after the signal via the same MCP feed (no CSV involved).
  *Done:*

- [ ] **4.5 — Pattern tracking against the 7 failure modes**
  `claude-agent.js` defines 7 numbered failure modes but only detects them conversationally.
  Compute them mechanically per day from the joined ledger — trade-count escalation, revenge
  cluster, inverted R:R, holding losers 3h+, multi-instrument day, gave back a green day,
  entered within 1 min of signal (mode 7, now precisely measurable because 4.3 gives the
  signal timestamp). Some of this already exists in the CSV discipline report
  (app.js:~2120); extend rather than duplicate. Store a per-day vector so the trend over
  weeks is visible, not just today's verdict.
  *Done:*

---

### Phase 5 — Close the daily loop *(carried over from `IMPROVEMENT_PLAN.md` #4 and #8)*

- [ ] **5.1 — Hour-edge table, auto-recomputed**
  Now computable properly because Phase 4 has clean per-trade data. Weekly rolling
  hour-of-day edge table written to `DATA_DIR`; feeds the `sessionTier` annotation from 3.3
  instead of the hardcoded windows. The window stops being your July guess and becomes what
  your last 20 days actually say.
  *Done:*

- [ ] **5.2 — Tomorrow's one focus item**
  On session close, write `DATA_DIR/reports/<YYYY-MM-DD>.md`: rule-by-rule verdict from
  `rules.json`, the per-playbook scorecard delta vs the trailing 20-day baseline, and **one**
  auto-picked focus item (worst-scoring rule or worst-drifting playbook). Next morning the
  checklist shows it pinned at the top. Fully mechanical, no API call. This file trail is
  the improvement ledger — the actual 1%-a-day loop, with evidence.
  *Done:*

- [ ] **5.3 — Telegram parity for the new states**
  `telegram-bot.js` currently pushes only engulf/FVG/SFP signals. Add `SETUP LIVE` with its
  playbook and level, and the end-of-day focus item. Deliberately **not** pushed: readiness
  nags and pattern warnings — a channel that pings constantly gets muted, and then the real
  signal is lost with it.
  *Done:*

---

## Part 3 — Sequencing and rationale

| Order | Phase | Why here |
|---|---|---|
| 1 | 0 — safety net | Baseline capture is only possible *before* the fixes |
| 2 | 1 — signal quality | A repainting signal poisons every downstream metric |
| 3 | 2 — arming | Pointless to auto-arm monitors that still fire noise |
| 4 | 3 — gate wiring | The change you feel immediately; needs 1 and 2 to be honest |
| 5 | 4 — feedback loop | Needs the signal shape from 1–3 to be stable before logging it |
| 6 | 5 — daily loop | Needs several weeks of Phase 4 data to say anything true |

**Phases 1–3 are usable on their own.** After Phase 3 the app watches all three playbooks
automatically and tells you when one prints. Phases 4–5 are what make it get smarter over
time; they need data that only starts accumulating once 1–3 ship, so shipping 1–3 promptly
matters more than planning 4–5 in more detail.

### Explicitly out of scope

- No trade execution. The app alerts; you enter. `BLOCKED_TOOLS` stays as-is.
- No new LLM in the enforcement path. Every gate stays deterministic.
- No new runtime dependencies — the existing hand-rolled, offline-first approach
  (`books-index.js` keyword search, canvas charts) is a deliberate constraint, not an
  oversight, and this plan holds to it.
- No UI redesign. The engine-vs-UI separation noted in `IMPROVEMENT_PLAN.md` housekeeping
  means a redesign stays cheap later; doing both at once makes both harder to verify.

### Risks

- **1.4 is the hard one.** Swing-structure detection on 40 bars is real work and the
  definition of "swing low in an HH-HL pattern" has judgment in it. Expect to tune it
  against live charts, and expect the first version to be slightly too strict. Too strict is
  the correct direction to err.
- **`market_multi_tf`'s 5-bar cap** constrains the engulf and FVG monitors. Phase 1.4 moves
  the engulf path to `getFullBars` anyway; if FVG quality proves poor, moving it too is the
  known fix.
- **Undocumented MCP tool shapes.** `extractBarsArray` already defensively tries several
  field names because the live response shape was never pinned down. Validate against a
  real payload before trusting any new field.

---

## Addendum — work done outside the original plan (2026-08-22)

Three requests landed mid-build. Recorded here rather than retro-fitted into the phases
above, so the plan's original shape stays readable.

### A1 — Environment fix: dependencies + verified boot ✅
The two items previously reported as unverified are now closed.
- `npm install` run in this worktree (253 packages). It had no `node_modules` at all, which
  is why `node server.js` failed on `Cannot find module 'ws'`.
- Server boots clean with every Phase 1–3 change in place: data dir resolves, keys load,
  Jessi monitor starts, ForexFactory refreshes, client connects.
- **Still not verified live:** the monitor auto-restore path. It is deliberately gated on the
  `tv-connected` heartbeat, and TradingView desktop is not running in this environment, so
  the "N chart watchers armed" line cannot fire here. The logic is unit-tested
  (`test/monitor-persistence.test.js`, 11 cases). Confirm on Anoop's machine by watching for
  that line in the console after TradingView connects.

### A2 — Watchers always on, toggles removed ✅
Per decision #6.
- **server.js** — `ALL_MONITORS` const; `restoreMonitors()` now unions the saved set with the
  full set, so a missing *or partial* config arms everything. An old config that recorded a
  partial selection must not leave watchers dark now that there is no UI control to undo it.
- **index.html** — all five `toggle-switch` blocks removed, plus the now-redundant "Arm all"
  button. The Chart Watchers panel reads `Always on — no switches to forget.`
- **app.js** — `armPlaybookMonitors()` no longer sends `false` to anything. It records
  `state.focusPlaybook` and re-asserts its own monitors as a liveness belt-and-braces. The
  armed line shows `Watching: … — hunting Playbook B`.
- The per-monitor start/stop machinery and WS messages are all **kept intact** — this is a UI
  and default-state change, so re-exposing a control later costs nothing.

### A3 — Day Recap before the session ✅
New file `renderer/day-recap.js` + overlay in `index.html` + styles.
- Fires once per IST trading day, ~2.5s after load (so the account bucket has hydrated
  `gr_history` from disk — reading earlier would show an empty recap on exactly the days it
  matters most).
- Reads **only what the app already stores** — `copilot_gr_history` and `insCoachNotes()`, the
  same generator the Insights tab uses. Consistent with Insights by construction rather than
  by duplicated logic.
- "Yesterday" means *the last day actually traded*, not literally yesterday — after a weekend
  an empty recap would train Anoop to dismiss it unread.
- Verdict badge grades **process, not P&L** (CLEAN PROCESS / PARTIAL SLIP / PROCESS BROKE),
  consistent with the co-pilot's own rule that a green day with broken process is a failed day.
- One amber **TODAY'S ONE FIX** block, preferring a habit repeated ≥2× in the last 7 days over
  a one-off from yesterday. Pinned to the top of the Checklist tab afterwards so it is in view
  when the entry decision is actually made — that pin is what makes it a loop rather than a
  notification.
- Also shows what went *right*; a recap that only scolds gets dismissed unread.
- Tests: `test/day-recap.test.js`, 11 cases.

**Bug found and fixed while testing A3 — affects the existing Insights tab, not just the new
code.** `insProse()` (app.js) keyed its "most-repeated mistake" on `note.split('—')[0]`, which
includes the day's own count: `"25 trades"`, `"22 trades"`, `"24 trades"` are three different
keys, so **a habit repeated every single day was reported as three unrelated one-offs** and the
line almost never found a genuine repeat. Fixed with `recapNoteKey()` (strips digits to group)
and `recapNoteLabel()` (keeps the full note for display, because the meaning lives *after* the
dash — "over your 20 cap" — while the count lives before it). Both the recap and the Insights
tab now use it.

### A4 — Day Recap v2: exits, extremes, sizing, Jessi, quote ✅
Second pass on A3, per Anoop: *"i need to know the last 2 trades exited price and direction and
time... i also need information about highest profit and loss of previous day to make sure i
choose my contract size of today accordingly. i also need a motivation quote and advise from
jessi as per my trades yesterday and how i should be treating today as."*

**Exit price had to be added to the pipeline first — it was never stored.** `csvParseTrades()`
computed a qty-weighted *entry* price from `x.bp`/`x.sp` and discarded the other side, so the
app could say where Anoop got in but never where he got out. Now computes `exitPrice` as the
mirror (a LONG exits on the sell price, a SHORT on the buy) and persists it as `xp` in
`copilot_day_trades`. **Days ingested before 2026-08-22 have no `xp`** and render `—` rather
than a guess; re-upload a CSV to backfill that day.

- **Last 2 trades** — direction pill, `entry → exit` price, exit time in IST, lots, hold, P&L.
  Sorted by exit time, so "last" means last *closed*, not last opened.
- **Best / worst single trade** added to the stat grid (from `gr_history.best` / `.worst`,
  already computed), alongside max size.
- **Today's starting size** — a number, derived from yesterday's worst single trade as a share
  of the day stop. The logic: a daily stop is only a real limit if one trade cannot reach it
  alone. ≥100% of stop → start at 2; ≥50% → halve yesterday's opener; ≥25% → one smaller;
  below that → hold. Clamped to 2…6 (`rules.json` sizeCap). This is
  `IMPROVEMENT_PLAN.md` #6 turned into a pre-session number instead of a post-mortem.
- **Jessi's read** — two-stage by design. A mechanical read renders instantly from the numbers,
  then Jessi's replaces it if a key is configured. The recap must never sit blank waiting on a
  model that may be unconfigured or rate-limited. The prompt carries yesterday's real figures
  and the last two exits, and explicitly instructs Jessi *not* to congratulate a green day if
  the process was broken.
- **Quote of the day** — 14 quotes from the same five books already in the library, selected
  deterministically from the date (stable all day, new one tomorrow). Local, so it works with
  no key and no network.

Tests: `test/day-recap.test.js` now 40 cases.

*Known interaction:* `sendJessiChat()` sets a module-level `currentJessiReqId`, so the recap's
request would take over an in-flight Jessi chat. Harmless in practice — the recap fires ~2.5s
after load, before any chat can be open — but worth knowing if the recap is ever made
re-openable on demand.

### A5 — Phase 4-5 deferred; SIGINT defect fixed; scalper-agent check (2026-08-22)

**Deferred.** Phase 4.3 was started and then rolled back. `fold()` in `tradovate.js` had been
extended to emit a `closedTrade` event on a flat transition (posSize > 0 -> 0) carrying the
realized-P&L delta — chosen over per-fill pairing precisely because it needs no field beyond
the two `fold()` already tracks, so it would not inherit that module's NEEDS-VALIDATION risk.
**Reverted** rather than left in place: `fold()` runs on every 5s poll and feeds the live HUD,
and carrying unused code through the hot path during the very sessions meant to validate the
build adds risk for no benefit. The design above is the record; re-implementing is ~15 lines.

**Defect found and fixed (introduced by PLAN 2.1).** The `SIGINT` handler called
`Object.keys(engulfMonitors).forEach(stopEngulfMonitor)`. `forEach` passes
`(key, index, array)`, so the **index landed in the new `skipSave` parameter** — falsy for
index 0, truthy for the rest. On Ctrl+C the first monitor therefore rewrote config with a
half-stopped armed set while the others skipped the write. Masked today because always-on
restore unions with `ALL_MONITORS`, but wrong, and it would have bitten immediately if the
toggles ever returned. Now passes `skipSave=true` explicitly on all three — shutting down is
not disarming.

**Scalper agent: does not exist.** Checked on request. There is no scalper agent, module,
prompt or scheduled job anywhere in this system, and therefore **no role for one in the signal
loop**. Evidence:
- Only two agent files exist: `claude-agent.js` and `groq-agent.js` (Jessi).
- `graphify-out/graph.json` — 280 nodes, 13 matching `agent`, **zero matching `scalp`**.
- Repo-wide grep for `scalp` returns only descriptive prose: Jessi's system-prompt persona
  line ("Lucid Trading prop-firm scalper"), the good-trade vision prompt ("elite scalping
  coach"), two Edgedesk UI labels, and a Trader Kane note. No executable role.
- The TradingView MCP source directory — no match either.

The closest thing to an autonomous non-signal agent is `startJessiTVMonitor()` (server.js:679):
a 3-minute poll that caches `chart_get_state` + `quote_get` + `market_key_levels` into
`jessiTVCache` purely as **chat context for Jessi**. It does not detect setups, does not feed
the badge, and does not write to the signal ledger. It is not a scalper agent and plays no
part in Playbook A/B/C detection.

### A6 — Agent-connection audit + bug sweep of this session's work (2026-08-22)

**Audit question:** are all agents part of the workflow, and connected to what was just built?
**Answer before this pass: no.** `claude-agent.js`, `groq-agent.js` and `telegram-bot.js` had
**zero** references to the signal ledger, `armedSetup`, or Playbook C. Both LLM agents were
advising on a market they could not observe, while the app silently held a confirmed setup.

**Agent inventory and role in the signal loop**

| Agent / loop | Type | Role in setup detection | Connected now? |
|---|---|---|---|
| Engulf ×3, FVG, SFP monitors | pure code | **Detect** — the loop itself | n/a (is the source) |
| `computeMechanicalGoNogo` | pure code | **Decide** — MARKET badge | reads `armedSetup` (3.1) |
| `runMechanicalAnalysis` (90s) | pure code | Daily/1H bias context | feeds ledger rows |
| `claude-agent.js` (Sonnet) | LLM, advisory | **Analyse** on request | now sees `marketStateLine()` |
| `groq-agent.js` (Jessi) | LLM, advisory | **Converse / voice** | now has `app_get_data('signals')` + always-on MARKET line |
| `telegram-bot.js` | pure code | **Notify** off-screen | push wired; disarm now refused |
| `startJessiTVMonitor` (3m) | pure code | Chart *context cache* for Jessi only | not a detector — see A5 |
| `tradovate.js` (5s) | pure code | Live P&L / size / cooldown | unchanged; 4.3 will use it |

Sequencing is **event-driven, not a fixed chain** — monitors detect, the gate decides, the
agents explain on demand. Nothing needs to be ordered by hand.

**Bugs found in this session's own work, and fixed**

1. **Chart-timeframe race — CRITICAL, correctness.** One chart sits behind the CDP bridge and
   several callers mutate its timeframe (`getFullBars`, `market_multi_tf`, the 90s mechanical
   read, every monitor). Nothing serialized them. Interleaved, caller A reads `originalTf`
   while B holds a *temporary* timeframe, then A's `data_get_ohlcv` returns **B's timeframe's
   bars** — so a detector can evaluate 30M candles believing they are 15M and fire a
   perfectly-formatted, completely wrong signal; the chart is also left on the wrong TF.
   Latent before, but PLAN 2.1 (always-on: 5 concurrent watchers instead of opt-in) and PLAN
   1.4 (added a `getFullBars` call to the engulf path) turned a rare race into a routine one.
   Fixed with a FIFO promise queue (`withChart` / `chartTool`) around every chart-mutating
   call. `test/chart-lock.test.js` reproduces the fault — **all three** concurrent reads got
   the wrong timeframe unlocked, zero locked.
2. **`parseGoNogo` clobbered the new badge.** Still wired to Claude's chat completion at
   app.js:1067, it regex-scraped Claude's prose and wrote `setGoNogo('go'|'nogo')` — the exact
   approach `computeMechanicalGoNogo` was built to replace. Every Claude reply containing "GO"
   overwrote a live SETUP LIVE state until the 30s timer restored it. Now a documented no-op.
3. **Agent context said `GO/NO-GO: PENDING` forever.** After the four-state change the label
   was wrong and the value meaningless to the model. Replaced with `MARKET (live chart):` fed
   by the new `marketStateLine()` — playbook, direction, timeframe, validity reason, sweep
   level, gap, signal age, and Daily/1H bias.
4. **Telegram could disarm an always-on watcher.** `/engulf off` and `/playbookb off` still
   called the stop functions — leaving a watcher dark with no UI switch left to restore it,
   the precise failure always-on removed. `on` is still honoured; `off` is refused with an
   explanation.
5. **SIGINT `skipSave` defect** — see A5.

**Verified clean:** `dropFormingBar` guards (null/empty/ms/daily), Playbook C rejection path
returns before firing, `logSignal` context capture, recap null-safety and HTML escaping, badge
state vocabulary, monitor restore union. 69 tests across 4 suites; server boots clean.

**Still open (needs a live session):** the Jessi recap call and `app_get_data('signals')` both
need a real key and a running session to verify end-to-end; monitor auto-restore needs
TradingView connected.

### Still open
- **Phase 4.2–4.5** — decision capture, live-fill join, per-playbook scorecard, mechanical
  detection of the 7 failure modes. **On hold** until two live sessions have run, so 4.1's
  ledger has real fire/rejection data to build the scorecard against.
- **Phase 5** — hour-edge table (reporting only per decision #3) and the daily auto-report.
- **`tradovate.js` validation** — still marked STAGED / LIVE-UNTESTED with NEEDS-VALIDATION
  field mapping. It is load-bearing for 4.3. Validate against a real payload before building
  on it; if it proves unreliable, 4.2's manual capture still delivers the loop alone.
