# DSH — START HERE

**Updated 2026-09-09 by Claude. You are now the primary builder on this project — read
`DSH_PROJECT_HANDOFF.md` first, it explains why the rules below exist, including three live
incidents from the last 48 hours you should know before touching anything.**

You are picking up a live trading tool mid-queue. Read `DSH_PROJECT_HANDOFF.md`, then this page,
then open the plan.

```
OWNERSHIP:  DSH_PROJECT_HANDOFF.md               (read FIRST — who this is for, live incidents, discipline)
THE PLAN:   DSH_GATE_AND_FEED_FIXES_PLAN.md      (repo root, ~1,300 lines, 26 tasks — G26 is new, live-sourced)
CONTRACT:   CLAUDE_TASKS_FOR_DSH.md              (same as always — you implement, Claude verifies)
REPO RULES: CLAUDE.md                            (read the Prompt/LLM section before touching personas)
CODE TOUR:  HANDOVER.md · ARCHITECTURE.md · AGENTS.md   (module-by-module, read once, referenced always)
```

---

## 1. Your first pass was verified. Here is the result.

**Everything you shipped is correct.** Nothing was reverted.

```
node --check   all 14 touched JS files                       ALL PASS
npm test       1920 tests · 1919 pass · 1 fail  (the 1 is DATA, see 5)
```

| Task | Verdict |
|---|---|
| **G2** `visible: !!t.visible` in trading.js | ✅ correct |
| **G2** `panel-positions` CRITICAL check | ✅ correct — the tricky part (`prc.empty` is the placeholder *text*, not the `empty` boolean) you got right |
| **G2** `isFlat` left ungated | ✅ **right call**, the plan says alarm-only for one session first |
| **G3** blind read + early return | ✅ correct — `result.emptyStateText` is the right nesting *at that call site*, and the early return does stop `enforcePerTradeStop([])` clearing the latch |
| **G1** armSetup passes bar/setupId | ✅ correct, including the **explicit** `setupId` rather than the `na:na` fallback |
| **G10** contracts block + helpers | ✅ partial as you stated; no hardcoded `$2/pt` remains |
| **G7** htf-reject dedup | ⚠️ **works, but see §2** |

**The one failing test is not yours.** `day-rollup-live-golden` fails because it replays the live
`DATA/` directory, and today's stored day is corrupt. Proof: its only code dependency
(`renderer/day-rollup.js`) is unmodified, and it fails identically at commission 0.95 and 0.49.
**Do not try to fix it in code.**

**Your work log under-reported the file list, and that was fine** — `renderer/app.js`,
`ws-client.js`, `index.html`, `styles.css`, `forensics.js` were already dirty from unrelated Market
Brief / India Desk work before you started. You did not touch them.

---

## 2. One defect found in G7 — read this before continuing

G7 dedups on `blockBar = htfLastBarMs || null`. But `server.js:9603` does:

```js
htfLastBarMs = t == null ? null : (t > 1e12 ? t : t * 1000);
```

…so a **failed** read nulls it. During a TradingView outage `blockBar` stays `null`, the dedup key
stops changing, and **every block for the whole outage collapses into one ledger row** — you lose
the evidence that it persisted.

That is exactly the clobber **G16** exists to fix. So the order changed:

```
   WAS:   G7 ──▶ G6
   NOW:   G16 + G7 ──▶ G6
```

**G7 is not done until G16 lands.** And **G6 must not ship until both have**, or the new HELD row
inherits the same blind spot.

---

## 3. Build this next, in this order

**STATUS 2026-09-08 23:55** — you have already landed work on **G4, G6, G7, G8, G9, G15,
G16, G19, G20, G23, G24**. G4 shipped exactly to spec (default `refuse`, C-ADX-only relaxation).
The table below was written before that pass; treat any row you have finished as done and keep going.

| # | Task | Note |
|---|---|---|
| 1 | **G16 + G7** | closes the null-bar defect above; unblocks G6 |
| 2 | **G6** | now safe — one row per block instead of 30 |
| 3 | **G5** | one line (`mon.pending = null`), biggest visible win: 113 raids → 9 confirms |
| 4 | **G2 part 2** | gate `isFlat` — only after one clean alarm-only session |
| 5 | **G10 finish** | helpers exist at 2 call sites; finish the rest |
| 6 | **G4** | last of the sevens; enforcement-adjacent, C-ADX shadow rung ONLY |

Then **P5** (G8 → G11 → G9) · **P6** (G12 → G13 → G14) · **P7** (G15, G17-G22) · **P8** (G23-G25).

**G23-G25 are new**, added 2026-09-08 from the verification run. They are all cases of the app
disagreeing with itself: per-era commission, the phantom detector under-counting, and no daily
reconciliation between the broker feed and the stored day.

---

## 4. Rules that are not negotiable

1. **`rules.json` is the only place a trading number lives.** Never hardcode a limit that exists
   there. `pointValue` included — resolve it from `contracts` and REFUSE on an unknown symbol.
2. **Do not renumber the G-tasks.** Numbers are stable identity referenced from the ordering graph,
   the UI section and commit messages. Tiers are execution order; the two are deliberately different
   (which is why G10 sits in P1).
3. **No UI change lands mid-session.** Twelve tasks touch surfaces Anoop trades off. See the
   **UI CHANGES** section of the plan for the complete before/after table.
4. **G12, G13, G14 are Prompt/LLM changes** per `CLAUDE.md`. They need the manual smoke test and the
   observed response pasted into the PR. A prompt change with no observed response is unverified.
5. **Every task has a machine-checkable ACCEPTANCE block. Run it.** 115+ checks across the plan.
6. **Line numbers in the plan drift.** Re-grep before editing — one had already moved between the
   audit and the plan being written (G18: 14043 → 14063). The plan marks which claims were
   hand-verified (✅) and which are agent-reported (⚠).
7. **Additive and reversible over clever.** This process runs Anoop's monitors, Jessi, and the
   TradingView bridge during live sessions. Do not remove the crash guards at the top of
   `server.js`.
8. **EXTEND test files. Never replace them.** If a test looks obsolete, **prove it fails against
   your change before deleting it** — paste the failure into the PR. A test suite is the only thing
   standing between a refactor and a live-money bug, and a green suite that got green by losing
   tests is worse than a red one, because it lies. If your change makes an old assertion genuinely
   wrong, change that assertion and say why in the diff; do not drop the test.
   **See §6 — this already happened once.**

---

## 5. Known live problems that are NOT yours to fix in code

**Today's `DATA/` is corrupt and is being actively rewritten.** Four stores, four answers for
2026-09-08:

```
tv_broker_feed_state.dayPnl   -231.12    (tradeCount 13, but 16 rows in trades[])
gr_history.pnl                -378.88    ← read -340.24 minutes earlier. It MOVED under us.
day_trades row sum            -378.88
broker order history          -435.40    (the truth)
```

Plus 4 feed rows with no entry price, 5 size-0 rows in `day_trades`, and `maxSize: 12` against a
`sizeCap` of 4.

**The repair is a broker CSV through `csvApply` (`renderer/app.js:11016`), not hand-edited JSON**,
and it cannot run until `taskkill /F /IM node.exe`. G24 and G25 make this class of problem *visible*
in future; they do not repair this instance.

**Also open, for Anoop not you:** `app/rules.json.probe` sits next to the real `rules.json` and is
**not** a copy — it carries `commissionPerContractPerSide: 0.49` and `stageRules.funded.sizeCap: 4`.
Both are values Anoop has explicitly rejected (the file itself records *"No, funded stays at 2"*).
Awaiting his decision to delete or rename. **Never copy it over `rules.json`.**

---

## 6. ⚠ `test/htf-alignment.test.js` was restored — do not re-save over it

**Read this before you touch that file.** Your G4 pass left it with 7 tests. It had 21 before, and
they were not moved anywhere — they were gone from the whole `test/` directory.

Before restoring I checked whether G4 had broken them. It had not:

```
git show HEAD:app/test/htf-alignment.test.js  →  run against your current code
ℹ tests 21   ℹ pass 21   ℹ fail 0
```

**All 21 pass against your new code.** So they were discarded, not obsoleted — on the module its own
header calls *"the ONE gate above every playbook."* What went with them:

- *"the 15M decides the bias; the 1H cannot veto"* — the core doctrine
- *"a setup against the bias is refused"* — direction gating
- *"missing 15M data REFUSES, and says so distinctly from a rule refusal"*
- *"too few 15M bars is treated as missing, not as unclear"*
- *"structure is read from SWING PIVOTS, not consecutive candles"*
- *"a ledger row written before 2026-09-03 still explains itself"* — the historical reason-code resolver

The file is now **28 tests (21 restored + your 7), all green**, with a note inside saying the same
thing. **Your 7 G4 tests were kept verbatim — nothing of yours was lost.**

**If you have that file open in an editor, reload it before saving** or you will wipe the restore.

---

## 7. The thing that is blocked, so you do not go build it

Anoop's original ask was a better **Playbook C (ADX) entry**. Three proposals exist
(`Size-Derived`, `Cap-Fitted Retest`, `C-SOR`) and **all three adversarial verifiers died on a
session limit before returning a verdict.** They are unverified and each author flagged something
that looks fatal. See **EXCLUDED → X2** in the plan.

**Do not build any of them.** But **do build G19** — C-ADX currently writes *zero* ledger rows when
it fires, so none of the three can be measured against live behaviour until it does. G19 is the
prerequisite regardless of which one eventually wins.
