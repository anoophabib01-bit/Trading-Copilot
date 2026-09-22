# COMPOSITE_SCORING_PLAN.md — the two docs rules, applied to this app

*Written 2026-09-21, from docs.typesafe.ai (the TypeSafe skill's own guidance).
Two rules came out of the deep dive that are worth acting on. This is what each
one actually demands here, what I am building first, and what must NOT change.*

---

## Rule 1 — "Ask for one snap judgment per question"

The docs are blunt about the anti-pattern:

> *"'Does this message convey urgency?' is a good question. 'Analyze this message
> and determine the best course of action' is not. That needs slow reasoning, and
> it is a signal to break the task into small questions and compose the answers
> in code."*

Three places in this app ask one question that carries several judgments:

| Where | Today | What it should be |
|---|---|---|
| **The setup router** | ONE Choice: *"which playbook does this state most resemble?"* | several atomic Scores, combined in code |
| **Voice** | every utterance goes to the full Jessi agent (tools + whole context) | a typed intent + its arguments, then a deterministic route |
| **The journal classifier** | already correct — mistake / state / plan / entry are separate questions on one request | leave alone |

## Rule 2 — "Composite scoring"

> *"Break the judgment into independent dimensions, score each one separately,
> and combine them with weights you control in code."*

The value the docs claim is not accuracy, it is **transparency and control**:
*"you can adjust the weights to find the right balance"* without rewriting a
prompt, and you can see *how* the final number was built.

That is exactly what the router lacks today. A single Choice gives one number
and no breakdown: when it ranks B above A there is no way to ask *why*, and no
way to say "trend alignment matters more than session quality this month"
without rewriting an instruction string.

---

## What I am building first: composite scoring for the setup router

**Shape.** One request, four atomic Score questions over the same state:

| Question | Levels (0..3) | Why this dimension |
|---|---|---|
| `trend_alignment` | against / unclear / with / with-and-accelerating | the HTF gate already judges this deterministically; the Score grades it |
| `level_quality` | no level / minor / marked / pre-marked major | his own doctrine: no pre-marked zone is a named mistake |
| `session_quality` | outside / edge / inside / prime | the session windows are already data |
| `trigger_quality` | absent / weak / clean / textbook | what the detector saw |

**Combined in code**, per the docs' own example (`score / top_level`, then
weights):

```
composite = w.trend*trend_n + w.level*level_n + w.session*session_n + w.trigger*trigger_n
```

**Weights live in `rules.json`**, not in a prompt — `router.weights`. Changing
one is a data edit that needs no redeploy and no prompt rewrite.

### The rules this build is held to

1. **It is a COLUMN, not a verdict.** The existing Choice ranking keeps running
   unchanged beside it. Nothing reorders, hides or vetoes on the composite until
   the measurement says it can — the same bar every other measured thing here
   has passed.
2. **Same measurement, no new maths.** The composite lands on the router's shadow
   row and is bucketed by the existing Wilson evaluator, at the same
   `minSamples: 30`, with the same non-overlapping-interval requirement for a
   CONFIRMED verdict.
3. **It never reaches risk.** No size, no stop, no confirm path, no guard.
   `canExecute()` does not know it exists.
4. **The levels must stand alone.** Each Score level is judged on its own, so
   they are written as concrete situations ("a level marked before the session"),
   never as degrees of a hidden scale ("good / better / best").
5. **A missing dimension is null, not zero.** A state with no session read must
   not be scored as "outside the session" — absence is not evidence, and the
   composite reports how many dimensions actually answered so a 2-of-4 number is
   never read as a 4-of-4 one.

### Acceptance before it is allowed to matter

- n >= 30 scored setups on the composite, **and**
- the top composite bucket's Wilson lower bound above the bottom bucket's upper
  bound **and** positive expectancy per contract.

If it never separates, delete it. The Choice ranking stays either way.

---

## Second application: voice command routing

The docs' flagship confidence example is literally a **voice** interface (voice
banking commands: a 0.6 floor, then per-action thresholds — "check balance" at
0.6, "approve transfer" at 0.85+). That maps onto this app almost exactly.

Today every spoken word becomes a full Jessi agent turn: persona + tools + the
whole account context, 10-90s observed on the debate path and seconds on chat.
Many utterances are not questions at all — they are **commands**.

Proposed: a typed router in front of voice.

| Utterance | Routed to | Gate |
|---|---|---|
| "what's my cushion" | `app_get_data` — deterministic read, spoken | confident -> answer |
| "close the ticket" | the existing confirm path, which already validates | mid -> speak back "close the ticket, confirm?" |
| "mark my exit" | the chart tool | mid -> confirm |
| "why did I lose today" | the full Jessi agent | always — this genuinely needs the coach |
| anything unclear | the full agent (fail open) | never silently dropped |

Rules: the router **only chooses a handler**; every handler validates exactly as
it does today, and anything that could place or change an order still goes
through the deterministic gates and a spoken confirmation. Low confidence never
guesses — it falls back to the agent, which is today's behaviour.

**Why this is the best fit for Jev in this app:** it is fast (~100-400ms vs a
full agent turn), it is cheap, mishearing is the dominant error mode in voice and
a confidence floor is exactly the right instrument for it, and it *reduces* the
number of ways an agent can improvise around a command.

---

## Order of work

1. `app/composite-score.js` — pure: normalise, weight, combine, explain. +tests
2. Weights + level definitions into `rules.json` as data
3. Router sends the four Scores on the SAME request as the existing Choice
4. Composite onto the shadow row; extend the evaluator with a composite axis
5. UI: show the breakdown beside the ranking (so *why* is visible)
6. **Only then** voice intent routing, reusing the same module and the same
   confidence machinery
