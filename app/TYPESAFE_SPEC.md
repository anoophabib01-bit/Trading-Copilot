# TYPESAFE_SPEC.md — Jev inside the Co-Pilot: what it is for, and what it must never touch

*Written 2026-09-19, after a full check of the API against the official docs and
a read of every module it could plausibly plug into. Phase 1 is BUILT and
tested; everything after it is a plan, and the plan is deliberately ordered so
that each step has to earn the next one.*

---

## 1. What Jev actually is (verified, not assumed)

`POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`,
`{ state, model: "jev-latest", questions }` → `{ model, answers, usage }`.

| Fact | Consequence here |
|---|---|
| `state` may be a **string, object or array** | his note fields go as structured JSON — no prose assembly |
| Questions are typed: **noul** (0–1 yes/no), **choice** (option + probabilities + confidence), **score** (level + probabilities + confidence) | citable, storable, countable — unlike a paragraph |
| **Text only** — no images | never the chart path; chart reading stays with the vision channel |
| **No prose generation, no tool calls** | it is not an agent and never a provider for `groq-agent.js` |
| **`confidence` is derived from how peaked the distribution is** | it is NOT calibration. A confidently wrong answer is possible |
| Errors are plain HTTP: **401 / 422 / 429** | every path fails open; the daily cap guards spend |

**The one sentence to keep:** Jev produces *typed opinions*. It does not produce
*your* probabilities — those come from your own recorded outcomes.

---

## 2. Phase 1 — BUILT: a loss day, turned into countable facts

**The gap it fills.** `pattern-memory.js` counts what the FLAGS catch (112
revenge re-entries, 89 oversize). It cannot count what he WRITES. So "I entered
early because I was bored" written on nine days is invisible as a trend, while
one oversize trade is an episode. Deva's doctrine calls the loss data the
non-negotiable half, and this app could read it but never count it.

| Piece | File | Notes |
|---|---|---|
| Transport | `app/typesafe-client.js` | pure decisions + thin I/O; fail-open; call ledger |
| Classifier | `app/typesafe-journal.js` | pure question/state/result builders + thin orchestration |
| Rubric | `rules.json` → `mistakeTaxonomy` | 13 observable mistake criteria + 3 state levels, as DATA |
| Switch + guard | `rules.json` → `typesafe` | `enabled: false` until a key exists; `maxCallsPerDay` spend guard |
| Hook | `server.js` `note-save` | fire-and-forget, never awaited, never able to disturb the save |
| Store | `accounts/<slot>/typesafe_notes.json` | BESIDE his words, never over them |
| Ledger | `DATA/typesafe/calls.jsonl` | every call: question ids, answers, confidence, latency, ok/reason |
| Tests | `test/typesafe-*.test.js` | 39 tests, mocked transport, no network |

**Nothing consumes the answers.** That is the point: the record has to exist
before anything is allowed to depend on it. A test caught a real bug during the
build — with no rubric the module still sent two boolean questions, recording a
half-classified day; the guard now returns no questions at all.

**To turn it on:** paste the key into `~/.trading-copilot-config.json` as
`typesafeApiKey` (or set `TYPESAFE_API_KEY`), then set
`rules.json.typesafe.enabled = true`. Nothing else changes.

---

## 3. The decision layer for MANY playbooks (the part he asked for)

The goal: import many playbooks in future, each switchable ON/OFF, without the
app becoming a pile of special cases.

**What already exists and should not be rebuilt:**

| Concern | Existing module |
|---|---|
| What a playbook IS | `playbook-spec.js` (A, B, C-as-a-gate, LTF-ENGULF) |
| Firing | `detectors.js` (engulf / FVG / SFP), one definition for live + backtest |
| Recording every fire | `signal-ledger.js` (including the ones he skips) |
| Scoring what happened next | `signal-outcome.js` — the counterfactual that makes per-playbook stats mean anything |
| Matching taken trades to signals | `signal-join.js` |
| Machine vs human at entry | `shadow-recorder.js` |
| Turning outcomes into edge | `drift-edge.js` — n, win rate, expectancy/contract, **Wilson interval** |
| Which playbooks may trade | `rules.json` → `autonomyModes.*.playbooks` (partial registry today) |

**The gap that a router fills:** with many detectors, several fire at once and
he reads a wall of alerts (Playbook A's own alert rate already went 8→30, 3.8×,
~⅓ of them against bias). Jev can collapse that into one ranked, typed read.

### Proposed shape — a playbook registry, and a score that has to prove itself

```
rules.json
  playbookRegistry: {
    "<playbook-id>": {
      label, specRef,               // what it is (playbook-spec.js is the truth)
      enabled: true|false,          // THE ON/OFF SWITCH he asked for
      shadowOnly: true|false,       // may record, may not place
      sizes: [2],                   // never wider than stageRules' cap
      router: { weight: 1 }         // how much Jev's score counts in ranking
    }, ...
  }
```

**The loop that decides ON/OFF — data, never the model:**

```
detector fires ─► signal-ledger records it (context at that moment)
      │
      ├─► Jev router: "which playbook does this state best match, and how sure?"
      │        (typed, logged on the SAME ledger row as one extra column)
      │
      └─► signal-outcome resolves MFE/MAE whether or not he traded it
               │
               └─► drift-edge buckets by playbook AND by Jev's score
                        │
                        └─► a per-playbook table: n, expectancy, interval
                                 │
                                 └─► ON/OFF is decided by that table
```

Rules for this loop:
1. **Jev's score is a column, never a verdict.** A playbook is switched on when
   its own bucket has enough n and a positive expectancy whose interval clears
   zero — the same bar `autonomy-gate.js` already applies to everything else.
2. **The router may rank and may escalate, never gate risk.** Ranking decides
   what he *reads first*; it never decides size, stop, or whether an order goes.
3. **Confidence-gated escalation** (the pattern the vendor documents): only fire
   the expensive Debate/Judge path when the router's confidence sits in a band —
   the same idea as the existing `autoTriggerDebate` mechanical gate, applied to
   the costly branch.
4. **A playbook with no measurement is OFF.** `enabled: true` and
   `shadowOnly: true` is the only state a new playbook may start in.

### The other jobs worth having (ranked, with the honest caveat)

| Job | Value | Verdict |
|---|---|---|
| Journal → typed labels (Phase 1) | counts his own writing; feeds every other module | **built** |
| Setup router / ranker | collapses N alerts into one ranked read | phase 2, shadow only |
| Confidence-gated escalation | saves tokens + latency on the costly path | phase 2, after the router proves useful |
| Composite scoring of a setup | replaces hand-tuned thresholds with a rubric | only if measured better than the thresholds |
| Pre-trade "does this match your written plan?" | the one advisory that could change the moment | advisory only, never blocking |
| Chat intent routing | replaces a regex in `chat-intent.js` | cheap, low value, last |

### Red lines — non-negotiable

- **Not in any enforcement path**: size freeze, oversize guard, autonomy modes,
  trade-confirm rules, F1–F5, daily stops, loss ratchet. Those stay deterministic.
- **Never quoted as a probability.** "Jev says 68%" is not a fact about the
  market and must never appear in chat, a verdict, or the HUD.
- **Never in provider-chain.js.** One provider rule plus the fallback alarm
  stays intact; a third vendor answering an agent silently is the exact failure
  that convention exists to prevent.
- **Never silent when it acts.** `typesafe.enabled` is the kill switch; every
  call is on the ledger; every skip carries a reason.

---

## 4. Cost, limits, failure

- `maxCallsPerDay` (default 40) is a spend guard; a journal-only load is ~1–3
  calls/day. A router on every detector fire would be the expensive shape —
  which is why it stays in shadow until its score shows it earns the spend.
- **429 / 401 / timeout all fail open**: the app behaves exactly as it does
  today, and the skip reason lands on the ledger.
- Pricing, quota and latency are **not documented publicly** — check the console
  (`console.typesafe.ai/keys`) before switch-on. The author's own numbers are
  unknown at the time of writing.

## 5. The acceptance test before Phase 2 is allowed to matter

After 2–3 weeks of journal classification:
1. Does the typed mistake **ever disagree usefully** with his own dropdown — or
   with `failure-chain.js`'s attribution? A category the flags never see is the
   signal that it is adding information.
2. Does `planFollowed` track `week-rollup.js`'s plan-adherence axis, or
   contradict it? A contradiction needs explaining before trust.
3. If it merely re-labels what flags already catch, **delete it** and lose the
   few dollars. That is a successful outcome, not a failed one.
