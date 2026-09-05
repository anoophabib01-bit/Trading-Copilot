# Probability + Self-Correction Loop — Findings & Design

Requested 2026-09-04: (1) 2-6 contracts should be profitable, (2) audit the playbooks for
reading issues, (3) read charts -> analyse direction -> multi-agent discussion -> probability with
higher success rate -> if it fails, note the mistake, refix, retry, (4) DeepSeek as the core brain
with a learning loop from bad trades to good trades.

---
## 1. Playbook reading audit — what I found

The reading stack is SOUND. It is deterministic, unit-tested, and refuses to return a confident
wrong number (chart-reads.js, detectors.js, playbook-c.js). The definitions are now unambiguous
(playbook-spec.js): A = engulf + TF alignment, B = SFP+FVG limit entry, C = engulf VALIDITY GATE,
C-ADX = long-only breakout, LTF-ENGULF retired -> aliased to A.

Two CONCRETE issues found:

1. C-ADX SIZE MISMATCH (headline). The backtests were run at 1 contract, but the app enforces
   sizeFloor = sizeCap = 2. playbook-spec.js documents it verbatim: at 2 contracts perTradeMaxLoss
   caps the stop at 75 points (not 150), which refuses 33 of 76 setups, drops profit factor 2.83 ->
   1.95 and pushes consistency 31% -> 40% (onto the eval limit). The tuned threshold ADX>=35 was the
   consistency-safe choice at 1 contract and is BORDERLINE at 2, where ADX>=25 reads better.
   This is the direct, mechanical reason a good-looking playbook can look dead at your real size.
   It also ties straight to ask #1: the parameters, not the size dial, are what decide profit.

2. MGC OUTCOME RESOLVED AGAINST THE WRONG FEED. In DATA/signals/2026-09-03.outcomes.jsonl a Micro
   Gold signal entered at 4477.1 was resolved against prices of ~24,801 — a different instrument's
   bars. The outcome ledger grades signals against the wrong data for cross-instrument setups, which
   makes the per-playbook win rate (the number any probability must rest on) wrong for MGC.

---
## 2. The honest answer to "2-6 contracts should be profitable"

Size is not the lever. His own ledger already proves it: only 2 contracts is net profitable across
both stages; 3c -$437, 4c -$103, 5-6c -$384, 7c+ -$449. A size dial between 2 and 6 does not turn
losing entries into winners — it turns them into bigger losers. What makes 2-6 profitable is ENTRY
QUALITY, which is exactly what the probability gate below is for: take only the setups whose
measured win rate clears the bar, at any size in the allowed range.

---
## 3. What already exists (the vision is 70% built)

- DeepSeek as core brain: YES — every agent (Jessi, Analysis, PO3, Judge, Refuter, Scalper, THE
  LOOP) runs on DeepSeek via groq-agent.js / provider-chain.js.
- Read charts deterministically: YES — chart-reads.js (EMA/doji), detectors.js (pivots/engulf/FVG/
  SFP), amd-phase.js (PO3), htf-alignment.js (HTF gate).
- Multi-agent discussion: YES — the Debate panel (Analysis + PO3 + Jessi-discipline) -> Judge
  synthesises -> Refuter second-opinions -> TRADE_TICKET. verdict-grounding.js stops the Judge from
  inventing numbers.
- Note the mistakes: YES — failure-chain.js (causal day attribution), pattern-memory.js + store
  (episode ledger), signal-outcome.js (per-setup win rate), THE LOOP (speaks on repeats),
  armed-detectors.js, mistake-patterns.js.

---
## 4. The two genuinely-missing pieces

### A. A PROBABILITY at decision time (missing)
The Judge says GO / NO-GO but attaches no number. The per-playbook win rate ALREADY EXISTS in
signal-outcome.aggregateOutcomes() (winRate, targetRate, sample n) but is never handed to the Judge
or shown on the ticket. The fix is wiring, not new maths:
  1. Feed each playbook's rolling win rate + sample size into the Judge context (judgeContext /
     gatherAnalysisContext).
  2. The Judge then states a probability GROUNDED in that number (e.g. "GO, ~62% from n=31 — but
     n is thin, treat as coin-flip"), instead of vibes.
  3. Surface the same number on the trade ticket and the HUD, so a weak-probability setup is
     visibly a weak setup before the click.

### B. The REFIX-and-RETRY loop (missing)
Learning today is POST-HOC: it records and reports, but nothing automatically revises and retries.
The C-ADX shadow forward-test is the prototype of the right shape — record every setup, score the
outcome, and let the evidence move the parameters. Generalise it:
  1. A rolling outcome window per playbook (win rate, target rate, sample n) — signal-outcome
     already computes this.
  2. A demote rule: if a playbook's rolling win rate falls below its floor for N samples, drop it
     from "armed" to "shadow" (stop proposing it) and log the reason.
  3. A retune rule: if a playbook is live but a neighbouring parameter cell has a better rolling
     win rate at the traded size, propose the retune (never auto-apply on thin data).
  4. The loop writes its own decision to the episode ledger, so "refixed X because Y" is a
     permanent, reviewable record — same doctrine as pattern-memory.

---
## 5. Phased plan (what I recommend building next)

Phase 1 — PROBABILITY (small, safe, additive): wire aggregateOutcomes() win rate into the Judge
  context + verdict + ticket. No change to the GO/NO-GO logic, only richer input. ~1 session.

Phase 2 — FIX THE TWO DATA BUGS: (a) re-derive C-ADX at 2 contracts (ADX>=25 is the candidate, but
  it must be forward-tested before it becomes live — do not copy the 1-contract config);
  (b) make signal-outcome resolve against the CORRECT instrument's bars (fix the MGC feed bug).

Phase 3 — REFIX LOOP: demote-on-underperformance + retune-on-evidence, gated exactly like the
  autonomy modes (human in the loop for anything that can place an order).

Phase 4 — RUN ON SAMPLE TRADES: as you said, let it run, then take the call on what changes.

---
## 6. The one sentence that matters

DeepSeek already reads the chart, discusses with the agents, and notes the mistakes. What it does
not yet do is put a number on the decision and automatically revise when the number says the setup
stopped working — those two wires are the whole gap, and both are small relative to what is already
built.
