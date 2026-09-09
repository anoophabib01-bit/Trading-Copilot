# Project Handoff — DSH takes ownership, 2026-09-09

**You are now the primary builder on this repo.** This document is not a code tour — `HANDOVER.md`,
`ARCHITECTURE.md` and `AGENTS.md` already do that well; read them, in that order, before writing
anything. This document is everything a code tour can't tell you: who this is for, what already
went wrong twice, what's live right now, and the discipline that keeps a real account safe while
you work on it.

**Read `DSH_START_HERE.md` next.** It has the live verification status of your first day's work
(1925 tests, one restored test file, the G5/G7/G16 dependency you found) and the current build
queue. This document explains *why* those rules exist; that one tells you *what to build next*.

---

## 1. Who this is for, and what "done" means here

**Anoop Habib** trades MNQ and MGC futures on an **Apex Trader Funding 50K EOD Drawdown
Evaluation**, opened 2026-09-07. This is not a demo account and not a backtest harness — every
number this app shows him during a session can change what he does with real money, in real time,
against a firm that will fail his evaluation if he touches a $48,000 floor.

That changes what "done" means for you:

- **A feature that is 90% right and silent about the 10% is worse than no feature.** The
  recurring theme of everything found in the 2026-09-08 audit — the HTF gate blocking 96% of setups
  for "can't read" and saying nothing, a positions table reading FLAT when it was just unrendered,
  a playbook arming setups with no trade plan for its entire life — is not "we found bugs." It is
  "the app was confidently wrong and nothing told him." Fix the wrongness AND the confidence
  problem. A refusal that explains itself is fine. A refusal that looks like success is not.
- **Every trading number lives in `rules.json`, never in code.** This is stated in `CLAUDE.md` and
  it is not a style preference — a hardcoded size cap or commission rate that drifts out of sync
  with the file is how three separate real incidents happened (see §3).
- **"It compiles and the tests pass" is necessary, not sufficient.** Read §4 before touching
  anything that touches money.

---

## 2. The one-copy rule — read this before you open anything

`G:\MNQ-CoPilot` is the **only** copy of this project. Not a mirror, not a working copy — the one
that runs. This has gone wrong twice before you (see `CLAUDE.md`'s own header): once when old
copies under `C:\` and `D:\` were never actually removed after a "move to G", and once when an
entire debugging session was spent editing a stale copy under `C:\Users\Admin\Claude\Projects\`
before discovering the real server runs from here. Real fixes had to be redone.

**Before your first edit in any session: confirm you are reading and writing under
`G:\MNQ-CoPilot`.** If you ever see a second `rules.json`, `server.js` or `DATA/` directory
anywhere else on this machine, stop and ask before touching either copy.

---

## 3. Three live incidents from the last 48 hours — why the rules below exist

These are not hypotheticals from an audit. They happened, on the account he is trading right now,
while this handoff was being written.

### Incident A — the account went blind on a real position
2026-09-07: Anoop was long, and the app's live-feed self-test reported **3/3 PASSED** while
`tvBrokerFeedState` showed `wasFlat: true`. The positions table had a `<table>` element in the DOM
but zero rendered rows — TradingView only paints rows for the currently-visible broker sub-tab, and
`getPositions()` returned `success: true` regardless. While the app believed the account was flat,
**the $300 per-trade stop and the size cap were both silently disabled**, because the guard that
exists to alarm on exactly this state (`noteOversizePositionRead`) classified an empty array as a
*successful* read (`if (rows) {` — `[]` is truthy in JS). This is fixed (G2/G3 in the plan) but it
is the reason "a check that can be silently green" is now treated as a category of bug on its own,
not a missing feature.

### Incident B — two account slots almost got mixed
Anoop opened a new Apex account and the app's picker showed only `"$50K EVAL ACCOUNT"` — identical
text for two different slots that happened to be the same size and stage. He caught it before
trading on the wrong one. The fix was naming the slot explicitly everywhere an action could rewrite
its history. **Ambiguity in an account-selection UI is a live-money bug, not a cosmetic one.**

### Incident C — a CSV re-upload silently duplicated a day's trades (2026-09-09, still being
repaired as this is written)
He uploaded two days of Apex broker CSVs. One merged perfectly. The other duplicated: 18 rows became
27, because a live-fold-recorded trade and its CSV-recorded twin didn't match on size (the live fold
observed 8 lots on a scale-in the CSV correctly split into two 4-lot fills), so the importer's
identity check treated them as two different trades. Every downstream tab — Journal, Forensics,
Week, Insights, the equity curve, the calendar — read the same corrupted store and showed a
consistent, confident, **wrong** day. It took reading the actual TradingView broker panel over CDP
and reconciling against a raw order-fill CSV, contract by contract, to find the true number.
**The lesson: two numbers agreeing across five tabs is not evidence they're correct — they all read
from the same one store.** See G26 in the plan for the underlying bug (still open) and §7 below for
how to verify data claims that matter.

---

## 4. Before touching any of these, stop and ask — don't guess

- **A trading-rule number** (size caps, loss tiers, commission rate, trade limits). These belong in
  `rules.json`. If you think one is wrong, say so and propose the change — do not silently correct
  it, and never assume a number from a different broker/era still applies. The commission rate
  alone has been wrong THREE times in one week (0.59 → 0.95 for Tradeify, then 0.49 vs 0.95 vs the
  actual Apex rate of ~$0.52/side — each guess was defended with a plausible-sounding source that
  turned out not to be the current account).
- **Anything in the `EXCLUDED` section of `DSH_GATE_AND_FEED_FIXES_PLAN.md`.** Two things there are
  blocked, not forgotten, and each has a written reason. Building them anyway wastes the exact
  effort that section exists to prevent.
- **Any UI surface Anoop trades off mid-session.** No UI change lands while he's actively trading.
  If you're unsure whether a change is "mid-session safe," it isn't — ask.
- **Deleting a test.** See §6.
- **A persona/prompt file** (`claude-agent.js`, the `*_PERSONA` constants in `server.js`,
  `buildContextMessage()` in `renderer/app.js`). These are literally what Jessi/the Judge/the
  Scalper say to him during a live session. `CLAUDE.md`'s "Prompt/LLM changes" section has a
  5-step checklist before any of these ship — follow it exactly, including the manual smoke test
  with the actual observed response pasted into the PR.

---

## 5. The architecture, in the shape that matters for building features

Full detail is in `ARCHITECTURE.md` and `HANDOVER.md §3`. The shape that matters when you're adding
or fixing a playbook:

```
                    ┌─────────────────────────────┐
                    │   HTF GATE (htf-alignment.js) │   ONE read, computed once/cycle
                    │   15M decides · 1H is evidence │   Anoop: "above every playbook"
                    └───────────┬─────────────────┘
                                │
          ┌─────────┬──────────┼──────────┬─────────────┬───────────┐
          ▼         ▼          ▼          ▼             ▼           ▼
     Playbook A  Playbook B  Playbook C  C-ADX       FVG-ONLY      PO3
     (engulf)    (SFP+FVG)   (validity   (1H strong  (30M gap,    (AMD phase,
     evidence     HARD       gate for    uptrend,    alert only,  own 1H read,
     only, both   gated      A candles,  HARD gated, no gate)     auto-triggers
     directions              no entry)   shadow only)             the Debate)
          │            │                      │
          └────────────┴──────────────────────┘
                        ▼
              armSetup() → playbookSpec.planEntry()
              entry / stop / target, from rules.json
                        ▼
              shadowRecordMachineOrder()  (forward-test ledger)
                        ▼
         [ autonomy ladder — currently ALL RUNGS DISABLED ]
                        ▼
              handleTradeConfirm()  — the ONLY path that can
              place a REAL order, and only when TV_ALLOW_LIVE_ORDERS='1'
```

**Three things worth internalizing before you build on this:**

1. **`armSetup` is the single choke point.** Every confirmed setup, from every playbook, passes
   through it on the way to being recorded as a shadow order. If a playbook's call to `armSetup`
   omits the trigger bar (as Playbook A's did for its entire existence until G1), the planner
   silently returns `plannable: false` and every downstream system — the shadow ledger, the ticket
   push, the live take-profit wiring — no-ops with no visible error. **Always trace a new detector's
   `armSetup` call through to a real `planEntry()` result before considering it done.**

2. **The gate is not uniformly applied, and that's deliberate — but it means "gate is shut" never
   means "nothing can fire."** Only Playbook B and C-ADX are hard-gated. Playbook A, FVG, and PO3
   are not. If you add a new detector, decide explicitly which category it's in and say why in a
   comment — don't let it default to gated or ungated by accident.

3. **The signal ledger (`DATA/signals/*.jsonl`) is append-only and is the only audit trail.**
   Every `armSetup`, every gate rejection, every fire should write a row. C-ADX went 16 days
   without writing a single fire row (only rejections) — its own block rate was unmeasurable. If
   your new code doesn't write to the ledger, its behavior cannot be measured later, which in this
   codebase's own words is "the app failing to READ, wearing the costume of a rule refusing a
   trade" — except for a feature that doesn't exist yet, it's failing to be MEASURED.

---

## 6. Testing discipline — this is not optional here

**Extend test files. Never replace them.** This is rule 8 in `DSH_START_HERE.md` for a specific
reason: on 2026-09-08, `test/htf-alignment.test.js` went from 21 tests to 7 during a refactor. All
21 deleted tests passed against the new code — they weren't obsolete, they were discarded. They
pinned load-bearing doctrine: *"the 15M decides, the 1H cannot veto," "a setup against the bias is
refused under every policy," "missing data refuses distinctly from a rule refusal."* They were
restored. If you ever think a test looks obsolete:

1. Run it against your new code.
2. If it fails, that's your evidence — paste it into the PR and explain what changed and why the
   old assertion is now wrong.
3. If it passes, it stays. You don't get to delete a passing test because it's inconvenient to keep
   updating, or because the file "should" be smaller.

**A green suite that got green by losing tests is worse than a red one, because it lies.**

Before calling anything done:
```
node --check <every file you touched>
npm test                              # full suite, from app/
```
Read the actual failure, not just the pass/fail count. `LIVE GOLDEN` (`day-rollup-live-golden.test.js`)
replays the real production `DATA/` directory — if it fails, check whether today's stored data is
corrupt (very possible, see Incident C) before assuming your code broke it. Its own header explains
how to tell the difference.

---

## 7. How to verify a claim about live data, properly

You will be asked, or will need to check yourself, "is this number right." The wrong way is to trust
whichever tab shows it — as Incident C proved, five tabs agreeing is not five independent checks,
it's one store read five times. The right way, in order of authority:

1. **The broker's own record**, read live. TradingView exposes its account tables via
   `document.querySelector('table[data-name$="positions-table"]')` etc. — reachable over CDP on
   `127.0.0.1:9222` when TradingView is running with `--remote-debugging-port=9222` (the launcher
   sets this; a manually-started TradingView will not have it). The Performance Center panel and a
   raw order-fill CSV export are the two most authoritative sources available.
2. **A raw order-fill CSV**, reconstructed by hand (group fills into round trips, sum by day) —
   this is what actually caught Incident C. `csvApply` (`renderer/app.js:11016`) is the app's own
   implementation of this and is the only writer that should ever touch `day_trades.json` under
   normal operation.
3. **`DATA/accounts/<slot>/day_trades.json`** — the merged trade-level store every tab reads.
4. **`DATA/accounts/<slot>/gr_history.json`** — the derived daily rollup (via `rollupDay`).
5. Everything else (chat messages, UI tabs, Jessi's commentary) is downstream of #3/#4 and proves
   nothing on its own.

**If the server is running while you're diagnosing a data problem, say so before touching any
file.** `tv_broker_feed_state.json` and the day stores can be rewritten by the live poll loop
mid-diagnosis — a fix applied while the process is up may be silently overwritten within seconds,
and you won't get an error, you'll just see your fix "not stick." Confirm with the user whether
it's safe to `taskkill /F /IM node.exe` before doing hand-repair on live data.

---

## 8. Key features — what they actually do, briefly

(Full behavior is in `HANDOVER.md §3` and the playbook detail is in the published
[Playbook Mechanics](https://claude.ai/code/artifact/2c61c644-d571-4de8-b4a8-3ffe12888625) artifact
— read that before touching any detector.)

- **Jessi** — the chat coaching persona (`claude-agent.js` + `server.js`'s `handleChat`), backed by
  DeepSeek (`groq-agent.js`, provider-agnostic despite the filename). One AI backend as of
  2026-09-02 — do not reintroduce a second provider without registering it in BOTH
  `provider-chain.js` AND `groq-agent.js`, or it fails silently.
- **The Debate** — a multi-agent argument (bull case / bear case / Judge) that can emit a machine-
  readable `TRADE_TICKET` on a GO verdict. Auto-triggered by PO3 phase transitions and full Playbook
  A/B setups. The Judge's ticket is the only thing that reaches `handleTradeConfirm`.
- **The Scalper** — a separate faster-cadence persona/rule overlay (`scalperRules` in `rules.json`)
  for a different trading style than the standard mode.
- **Live chart monitors** — background timers polling TradingView via `mcpBridge` for each playbook.
  Serialized through `withChartLock` so they don't race each other over the single TradingView
  connection.
- **The oversize guard, size-freeze guard, per-trade stop** — live enforcement that reads the
  broker's actual position table on a timer and can flatten/alarm. These are the guards Incident A
  exposed as blindable; treat any change near them as safety-critical by default.
- **Autonomy ladder** (`autonomy-modes.js`) — four rungs from fully-manual to fully-autonomous
  order placement. **Currently all rungs disabled.** Do not enable one without Anoop explicitly
  asking, and never as a side effect of an unrelated change.
- **Pattern memory / THE LOOP** — an agent that lives inside the trade history and speaks up when a
  mistake or a good pattern repeats, citing the specific prior trade. Positives are first-class: a
  losing trade with zero rule violations is filed as `disciplined-loss`, not a failure.
- **Week / Forensics / Journal tabs** — weekend and per-trade review surfaces, all reading the same
  `day_trades.json` / `gr_history.json` stores described in §7. If one is wrong, check whether the
  store is wrong before assuming the tab's rendering logic is.

---

## 9. Standing instructions

1. Read `HANDOVER.md`, `ARCHITECTURE.md`, `AGENTS.md`, `CLAUDE.md`, then `DSH_START_HERE.md`, then
   this file's §3-§7 again, before your first commit each session if it's been more than a day.
2. Every task has a machine-checkable ACCEPTANCE block in the plan. Run it. Don't mark a task done
   from reading your own diff.
3. `rules.json` is the only home for a trading number. No exceptions, no "just this once."
4. If you find something wrong that isn't in the current plan — like G26, found live mid-repair —
   write it into `DSH_GATE_AND_FEED_FIXES_PLAN.md` with the same rigor as the existing tasks:
   what's wrong, the evidence, the fix, the risk, and an ACCEPTANCE block. Don't just fix it inline
   and move on; an undocumented fix to a live-money bug is itself a small version of the problem
   this whole document is about.
5. When in doubt about whether something is safe to change, additive, or reversible — ask. This is
   a live production tool. The cost of a clarifying question is much lower than the cost of a wrong
   guess reaching a real account.
