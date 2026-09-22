# FEATURE_DISCOVERY_PLAN.md — the two cookbooks, mapped to this app

*Written 2026-09-21. Sources: docs.typesafe.ai/cookbooks/consistency_noul_cookbook
and docs.typesafe.ai/cookbooks/autoresearch_feature_discovery. Both read in full;
this is what they can and cannot do for "finding good trades, importing playbooks
that work, and a probability on the chart".*

---

## 1. Autoresearch feature discovery — the important one

### What it actually does

```
free text  ->  N typed TypeSafe questions  ->  numeric columns  ->  CatBoost  ->  prediction
                        ^                                                              |
                        +------------- proposal loop reads the errors -----------------+
```

A Score answer becomes **TWO columns**: the average level it points at, *and how
spread out the distribution is around it*. A Noul is one column. Then a proposal
LLM reads which features the model used and which rows it still gets wrong, and
proposes new questions, rewordings and removals. Five rounds.

### Its own numbers (2,000 wine reviews, 800 held out)

| how the text becomes a score | RMSE |
|---|---|
| predict the training mean | 3.09 |
| CatBoost on word counts | 2.47 |
| **ask TypeSafe for the score itself** | **2.15** |
| 18 designed questions, one proposal call | 1.87 |
| 38 questions after five loop rounds | **1.77** |

**Two conclusions, and they point in opposite directions.**

**A. Decompose — do not ask for the answer.** Asking the model directly for the
target scored **2.15**, WORSE than 18 small questions combined (**1.87**). That
is measured evidence against the feature he asked for — "give me a probability
this trade wins" — and in favour of what this app already does: many small typed
judgments, combined in code, scored against real outcomes.

**B. The loop needs thousands of rows.** 1.87 → 1.77 cost 2,000 training rows and
five rounds. Most of the gain was in the FIRST proposal call.

### What this app actually has

Measured on 2026-09-21:

| | |
|---|---|
| ledger rows | 2,025 |
| **resolved outcomes** | **87** |
| joined to a fire-time state | **87 / 87** (0 unmatched) |
| distinct feature groups with n ≥ 30 | 2 |
| features that separate outcomes | **0** |

87 rows against 11 candidate features needs roughly **110** by the usual
10-rows-per-feature rule. **A gradient-boosted model here would fit the noise and
report a beautiful number.** `feature-separation.js` therefore refuses the model
and reports per-feature intervals instead — the cookbook's first half, which is
the half that survives a small sample.

### The false discovery it caught on the real ledger

```
htfBias   not-recorded: 46 (39%)    null: 37 (62%)
```

A naive read says "62% vs 39% — a real edge". It is not. Those two groups split
by **when the field started being recorded** (2026-09-03), not by market
condition. This is exactly the shape of the playbook he would have "imported
because it works". Any feature whose groups are separated in time rather than by
state has to be read with that in mind, and the module reports both groups
precisely so this is visible instead of flattering.

### The plan

| Step | When | What |
|---|---|---|
| 1 | **done** | `feature-separation.js` — join ledger to outcomes, per-feature Wilson separation, refusal below n=30, model-readiness arithmetic |
| 2 | now | Keep recording. Every armed setup now carries a router row and a composite; every resolved signal adds a labelled row |
| 3 | ~110 rows | Re-run. Any feature whose groups separate becomes a candidate CONDITION, not a rule |
| 4 | ~300 rows | A supervised model becomes defensible, with a held-out split by TIME (never random — adjacent trades are not independent) |
| 5 | later | The proposal loop, pointed at his own ledger: propose conditions, measure, keep what earns its place |

**Importing playbooks that work = step 5 plus the registry already built.** A new
playbook starts OFF, recording-only, tagged `unknown` in the UI, and earns
`enabled` only when its own bucket clears the measured bar
(`playbook-registry.js decideSwitch`).

---

## 2. Self-consistency: nouls — what it says about reliability

The cookbook runs one 14-question rubric 15 times per condition and checks
whether each answer holds still. Findings worth keeping:

- **LLM answers move between runs even at temperature 0**, and disagree with
  themselves on judgment calls.
- **TypeSafe's mean per-question probability SD was 0.0102** — below every LLM
  condition tested. That is the actual argument for Jev over a prompted model in
  this app: not that it is smarter, but that the same state answers the same way.
- Probabilities from **0.30 to 0.70** were routed to an explicit `uncertain`
  outcome for human review — **while keeping the underlying probability visible.**
- Each call carried a **fresh throwaway `uid`** so the repeats are independent
  samples rather than cache hits.

### Where that lands here

- **The uncertainty band is already the design.** The voice router (0.6 floor)
  and the debate gate (per-playbook bands) both do the cookbook's "route the
  middle to review" — and both keep the number visible beside the action.
- **A stability check is worth having and is cheap.** Run the journal rubric N
  times over a handful of his own past notes and report the standard deviation
  per question. A question that will not hold still is a badly written question,
  and the fix is to rewrite its criteria — not to distrust the model.
- **If that check is ever run, every repeat needs a fresh `uid`**, exactly as the
  cookbook does, or the repeats are one sample counted N times.

---

## 3. What "a probability on the chart" can honestly be

He asked for a probability of profit as a chart signal. The truthful version,
given everything above:

**It cannot come from the model.** The cookbook's own table says asking for the
outcome directly is the *worse* method, and this app's red line is that a
model's confidence is never quoted to him as a chance.

**It can come from his own outcomes, per condition**, which is what
`drift-edge.js`, the router evaluator and `feature-separation.js` all already
produce: a win rate with its n and a Wilson interval, per bucket, refused below
30. The chart signal would then read:

> **Long · London session · with-bias engulf — 58% over 48 resolved signals (95% CI 44–71%)**

with the interval shown, because at n=48 that interval is the honest half of the
claim. And it is a *condition*, not a playbook — which is the importable thing.

Nothing here is wired to a chart yet. It should not be until a condition actually
separates: a percentage on a chart that nobody has earned is the most expensive
way this app could be wrong.
