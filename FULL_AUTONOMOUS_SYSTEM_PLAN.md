# Full-Autonomous System — Roadmap (future, not active)

Status: **not started, not scoped for near-term work.** This is the roadmap
for what comes after the semi-autonomous system (see
`SEMI_AUTONOMOUS_SYSTEM_PLAN.md`) is hardened and has run reliably for a real
stretch of live sessions. Building autonomy on top of an unreliable feed
just automates the unreliability — everything here assumes the semi-auto
plan's Priority 1-4 items are done and proven first.

## What "full-autonomous" means here, precisely

Today: Judge says GO → ticket appears → **you click Confirm** → order placed.

Full-autonomous: Judge says GO → rules gate passes → **order placed with no
human click**, within limits you set in advance.

This is a materially different risk category — every bug in the semi-auto
system today has been "annoying, cost you visibility." A bug in the
full-autonomous path costs real, un-reviewed money on every single
occurrence, not just the ones you happen to be watching for.

## Precondition: an honest track record, not a feeling

Before any code here gets written, the semi-autonomous system needs a
**measured** track record, not a subjective "it feels stable now":

- N consecutive live sessions (suggest N=15-20 trading days) with zero
  feed-integrity incidents (per the self-test in the semi-auto plan) and
  zero confirm-flow bugs.
- The Judge's GO/NO-GO accuracy tracked against what you actually would have
  done, logged and reviewed weekly — not just "did the order place
  correctly" but "was the verdict itself good."
- A written incident log (even a single markdown file) of every near-miss —
  a ticket that would have been wrong if you hadn't caught it — reviewed
  before graduating any single rule from semi- to full-auto.

This mirrors the "autonomy-graduation" idea already referenced in
`TODOS.md` ("fully autonomous once it proves it detects my exact
strategy") — but that note also flags its own gap: strategy-detection
accuracy is not the same as execution reliability. Both need separate,
explicit sign-off criteria.

## Proposed architecture

### 1. Autonomy is per-rule, not global
Not "auto-trade everything the Judge approves." Instead, a small allowlist
of specific, narrow, mechanically-verifiable setups get to skip the confirm
click — everything else still requires it. Example candidate for first
autonomy grant: "PO3 DISTRIBUTION phase confirmed + 1H bias aligned + size
at exactly the account's floor size (1 contract)" — small, mechanical,
low-damage-ceiling even if wrong. Nothing involving discretionary technical
judgment (the Analysis agent's read) graduates first.

### 2. A hard, non-overridable circuit breaker, separate from rules.json
Rules-based limits (`size-freeze-guard`, day-stop) are "smart" — they read
context. Full autonomy needs one more layer that is deliberately dumb and
cannot be reasoned around by any agent or any prompt change:
- Max N autonomous trades per day, hardcoded, not in `rules.json` (so no
  prompt/config drift can quietly raise it).
- Any single autonomous-path loss beyond $X immediately and permanently (for
  that calendar day) drops the system back to semi-auto — requires your
  explicit re-enable, not a timer.
- A physical/OS-level kill switch reachable in one action from anywhere
  (global hotkey, a Telegram command, a second always-on-top button) that
  flattens all positions and disables autonomous execution — tested
  regularly, not just built once.

### 3. Full audit trail, structured for post-hoc review
Every autonomous decision — not just executed trades, but *every* GO/NO-GO
the autonomous rule set evaluated, including the ones it correctly skipped —
logged with: full agent reasoning, all inputs (chart snapshot, live feed
state at decision time), the rule-check result, and the outcome. This
already exists in nascent form (`saveReviewRecord`, `data/reviews/`); it
needs to become mandatory and structured enough for a weekly "would a human
have made the same call" review, not just a debugging aid.

### 4. Two-stage rollout inside "full auto" itself
Don't jump from "confirm click" to "no click, real money" in one step.
- **Stage A — shadow-autonomous:** the autonomous rule fires exactly as it
  would in production, computes what it WOULD have done, but still requires
  your confirm click. Compare its decision to your actual click (did you
  confirm what it would have auto-fired, every time?) for the full N-session
  precondition window above.
- **Stage B — live-autonomous, capped:** real execution, but capped at the
  smallest possible size/frequency (e.g., 1 contract, max 1/day) regardless
  of what the strategy would otherwise call for, for a further defined
  window before the cap lifts.

### 5. Observability requirements are strictly higher than semi-auto's
Everything in the semi-auto plan's items 1-3 (watchdog, startup self-test,
reconciliation) becomes a **hard precondition to trade**, not just a nice
signal: if the watchdog can't confirm the process is healthy, if the
startup self-test hasn't passed in the last N minutes, or if the three-way
balance/trade-count reconciliation shows any mismatch, the autonomous path
refuses to fire — falls back to semi-auto (ticket surfaces, waits for your
click) rather than either blocking entirely or (worse) firing on stale data.

## Explicit non-goals for v1 of full-autonomy

- No autonomous position sizing beyond the smallest fixed unit initially —
  scaling is a later graduation, not part of the first autonomous rule.
- No autonomous handling of an open position once placed (no autonomous
  trail-stop adjustment, no autonomous scale-out) — entries only, same
  scope boundary the semi-auto spec already drew.
- No autonomous trading outside your declared session windows
  (`sessionWindowsIST`) — this stays a hard rule-engine boundary, not
  something the autonomous path can reason its way around.
- No removal of the manual kill switch or `TV_ALLOW_LIVE_ORDERS` gate —
  full autonomy adds a layer of automatic decision-making, it does not
  remove any existing manual safety layer underneath it.

## Sequencing relative to the semi-auto plan

```
Semi-auto plan items 1-4 (watchdog, inferred-trade guard,
startup self-test, P&L re-verification)
        │
        ▼
N sessions of measured, incident-free semi-auto operation
        │
        ▼
Full-auto precondition met → THIS document's Stage A (shadow) begins
        │
        ▼
Stage A track record reviewed → Stage B (capped live) begins
        │
        ▼
Cap lifts only after a further explicit, deliberate decision — never a timer
```

Nothing in this document should be built before the semi-auto plan's
priority items 1-2 ship and item 4 (P&L re-verification) is confirmed
against a real trade. Building autonomy on top of unverified P&L math is
building on top of a number nobody has confirmed is even correct.
