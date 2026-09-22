# MNQ Co-Pilot — Deep Audit: Why No Payout, What's Missing, and the Path to $3,000 / $4,000

*Audited 2026-09-04 by a third party, from the code + the on-disk trading ledger (DATA/) + the
rulebook (Prop Trading/CLAUDE.md) + app/rules.json + external prop-firm research. Every claim
below is anchored to a file or a log line that was actually read.*

---
## 0. The one-paragraph truth

The app is not the reason the account blew. The app is correct and it warned him — on the breach
day it issued a NO-GO at 13:05 IST ("you have already traded 6 times today", F2 two-consecutive-
losses triggered), and after the damage the Judge said "YOU FUCKED UP — TWENTY LOTS … the 20c loss
alone is -$1,718". He traded 20 contracts against his own 2-contract cap anyway and closed the day
at -$2,296, breaching the account. That is not a missing feature. That is a guard he ignored. No
amount of new signal code fixes a trader who ignores the signal that already fires. So the audit
splits into two honest halves: (A) the behavioral cause, which is the real blocker, and (B) the
product gaps — which are real, fixable, and worth fixing AFTER (A).

---
## 1. The evidence — the account breached while the app was screaming

### 1.1 The s2 account ("Tradify 02", 50K eval) — day by day from DATA/accounts/s2/CLOSED_breached.json

| Date | Trades | Net P&L | Max size | Over cap | Discipline | Sized up into loss |
|---|---|---|---|---|---|---|
| 2026-08-31 | 2 | −$62.9 | 5 | 2 | 63 | no |
| 2026-09-01 | 4 | +$70.8 | 8 | 2 | 69 | yes |
| 2026-09-02 | 6 | +$747.7 | 4 | 1 | 88 | yes |
| 2026-09-03 | 6 | −$2,296.3 | 20 | 4 | 75 | yes |

Final balance $48,459.3 vs $50,000 start. Worst single trade −$1,680. Day giveback $2,231 (the day
peaked +$24 and gave it all back plus $2,200 more). 47 contracts traded in a day his own rules cap
at 12.

The shape is identical to every one of the 6 blown accounts documented in the rulebook: a green,
well-behaved day (+$747.7, disc 88) is followed the very next day by the tilt — size 4→15→20, one
−$1,680 tail loss, and the whole drawdown gone. The account was not lost because he can't find
entries. It was lost because he sized up after a loss.

### 1.2 The app saw it coming — and he ignored it (from DATA/reviews/2026-09-03.json)

- 13:05 IST, pre-session (scalper lane): "VERDICT: NO-GO … You have already traded 6 times today.
  The session cap is 5. … The F2 protocol (2 consecutive losses = close platform) was triggered on
  all three of the last three days."
- 19:37 IST, after (judge): "YOU FUCKED UP — TWENTY LOTS … today shows 15c and 20c trades … the
  20c loss alone is -$1,718."
- Analysis lane, same moment: "NO ALIGNMENT — STRUCTURE INVALID … 9-EMA confirms nothing."

So the machine answered the question "why am I not getting payouts" in real time and he traded
through it.

### 1.3 The numbers also can't be fully trusted yet (data-integrity gap)

The Judge refused to finalize a verdict on the breach day for a reason that matters:

> "The app's record shows 6 trades and 47 contracts, but the broker's order history shows 4 trades
> and 41 contracts. That's a contradiction I cannot reconcile."

And in DATA/signals/2026-09-03.outcomes.jsonl, a Micro Gold (MGC) signal entered at 4477.1 was
resolved against prices of ~24,801 — a different instrument's feed. If the outcome ledger grades
signals against the wrong bars, then the app's "is this playbook actually profitable" answer is
wrong, and that undermines the one thing the app must get right for him to trust it.

---
## 2. The seven root causes (ranked by the dollars they cost)

#1 — Escalation after loss / revenge oversizing. This is the account-killer. The 150K eval breach
on 07-21 was 5 lots doubled to 10 chasing a −$260 loss. The s2 breach on 09-03 was 4→15→20. His own
failure-chain.js already attributes the damage this way: on its first run, "escalation-after-loss
owns -$1,779, 77% of the day." Sizing up while red is a forced hard stop in code — and it still
happened. The rule exists; the stop was ignored.

#2 — The size cap is a request, not a cap, because he treats it as one. On 09-03 he took 20 lots
against a cap of 2. His response on 09-04 was to ask for the cap to be "changeable 2→6" — but his
own ledger (quoted in rules.json and stage-rules.js) shows every funded size except 2 loses money
(1c −$345, 3c −$437, 4c −$103, 5-6c −$384, 7c+ −$449 = −$1,717 over 31 trades). The evidence says
the problem was never that 2 was too small; it was that he didn't stay at 2.

#3 — Giveback: green peaks get handed back. 09-03 giveback was $2,231. The 07-09 day was +$847 peak
→ −$928 close = $1,775 given back. A giveback rule exists (giveback.armAtProfit 400 / retracePct 50)
and would have locked the day. It is not being obeyed at the moment of the retrace.

#4 — Trading outside his edge window. His own data (app/IMPROVEMENT_PLAN.md) says the entire edge
lives in the 19:00 IST hour (NY open): +$3,032 at 71% WR, while 18:00 is −$1,242 and 20:00 is −$843.
Yet on the breach day most signals fired "outside-session" (06:10–09:00 UTC = London/midday IST),
and the damage happened outside the proven edge.

#5 — Inverted reward:risk on the days that matter. Across the earlier 4-day reconstruction: avg win
$209 vs avg loss −$230 (R:R inverted), and on blow-up days it gets far worse (avg win $15.75 vs avg
loss $246 in the rulebook's blown-account history). Winners are cut early, losers are held.

#6 — Account churn instead of behavior change. ~16 accounts bought (Lucid + Apex + Tradeify), ~$984.50
confirmed in eval fees, $0 in payouts (DATA/account_fees.json, payouts: []). He is now on slot s5
labeled "paper". Buying the next $100 eval before fixing #1–#3 just funds the same outcome again.

#7 — There is no single, actionable ENTRY signal (the feature gap he is asking about). This is real
and is covered in Part 3 — but it is the LAST cause, not the first. Even a perfect signal would have
been overridden by the 20-lot tilt.

---
## 3. What is actually MISSING in the app (the product gaps, concretely)

Gap 1 — Detection ≠ signal. The app fires raw patterns, not a decision. In
DATA/signals/2026-09-03.jsonl every fired signal carries decision: null, decidedAt: null, signalTs:
null. The monitors (engulf / FVG / SFP / PO3) detect a pattern and log it; nothing collapses it into
one line that says "ENTER: BUY 2 MNQ @ 29189, stop 29211, target 29145 — A+ — GO".
autonomyModes.assist and autonomyModes.control are both enabled: false; only shadow (record-only)
is on. So the app records what it saw but never tells him to act at the right moment with size +
stop + target.

Gap 2 — "Playbook C" is three different things and nobody knows which to trade. playbook-spec.js
states it plainly: the rulebook's "C" is a validity gate (disqualifies engulfing candles), the live
server was tagging 30M/15M engulfs as "C" (a fourth thing, renamed LTF-ENGULF), and then there is
"C (ADX) — Long-Only Breakout", a separate shadow-tested strategy that has never fired because
ADX≥35 on 30M is too strict (0 signals in 300 bars, per its own comment). Three "Playbook C"s = a
trader who cannot state what he is waiting for.

Gap 3 — There is no profit-taking / exit signal. The entry detectors are plentiful; the exit side
is a hand-drawn "exit at marker levels" that no code can read. The app tells him when a pattern
forms but has no equivalent "TAKE PROFIT NOW — you have captured 40% of the available move, target
reached" signal. This is why "not taking profits" is a real, literal gap, not just a discipline
slogan.

Gap 4 — Signal noise is not filtered. On the breach day the PO3 monitor fired "still inside the
opening 4-bar range" ~8 times in ~40 minutes during a ranging market. That is a heartbeat, not a
setup, and it trains him to ignore the chime — the exact opposite of a signal.

Gap 5 — The funded target and payout math are not one clean, correct number. The user's goal is
$3,000 eval / $4,000 funded, and renderer/app.js:134 has the funded account at $100K with payout
target $104,000 (i.e. $4,000). But ~/.trading-copilot-config.json still carries stale Lucid numbers
(top-level payoutTarget: 52000, fundedTargetMin 800–1200) that contradict the per-slot Tradeify
values (evalTarget 53000, fundedTargetMin 150–300). There is no single HUD number that says "funded
= $104,000, you are at $X, you need $Y, your consistency allows $Z today." (Note: rules.json's
payout block already researched Tradeify Select correctly — 40% consistency, 3 profitable days, no
daily loss limit — but it is not surfaced at the moment of trade.)

Gap 6 — The broker reconciliation is not automatic. The app-vs-broker mismatch (6 vs 4 trades, 47 vs
41 contracts) means the discipline scores are computed on numbers that can drift from reality. A
discipline score on wrong numbers is worse than no score.

Gap 7 — Housekeeping / hygiene. Plain-text API keys (sk-ant-…, gsk_…, Gemini, OmniRoute) sit in
~/.trading-copilot-config.json; the rulebook still names "Lucid" as the firm while the live accounts are
Tradeify; Prop Trading/CLAUDE.md and app/rules.json describe different daily-loss tiers (−250/−350/−500
vs −200/−300/−400). Drift between the rulebook and the engine is exactly the class of bug that already
cost him a breach (the size cap that was "documented but never enforced").

---
## 4. The prop-firm reality (external comparison)

Researched from Tradeify's help centre and third-party reviews (quantcrawler.com/learn/tradeify-rules,
fundedscore.com/firms/tradeify, proptradingvibes.com/prop-firms/tradeify, Tradeify payout psychology).

1. The firm is not the problem; the consistency rule is the design. Tradeify Select eval: $3,000
   profit target, $2,000 end-of-day trailing drawdown, 40% consistency (no single day's profit may
   exceed 40% of total), minimum 3 profitable days. That means he cannot pass by having one big day —
   the structure forces small, repeatable days, which is the opposite of his current swing-from-+$747
   -to-−$2,296 behavior.
2. There is NO broker-side daily loss limit on Select eval (the app's own rules.json notes this as
   "the dangerous part"). Nothing but the app stops a bad day until the full $2,000 drawdown is gone.
   This is precisely why his −$2,296 day was able to happen in one session.
3. Industry pass rates are single-digit. Most funded-firm marketing and third-party estimates put
   eval pass rates near or below 10%, and the dominant stated failure cause across firms is
   overtrading and oversizing — not a lack of entries. The app's failure taxonomy already matches the
   industry's.
4. The payout path is a grind, not a swing. With a 40% consistency cap, the clean path is ~6–10 green
   days of $300–$750 each, never exceeding 40% in one day. The app's payout block already knows this;
   it just isn't shown as the daily target.

---
## 5. The path to the first payout (step by step, in order)

Step 0 — Stop buying accounts until #1–#3 are fixed. Every new $100 eval before the behavior is fixed
is a donation. Use the existing "paper" slot (s5) as the proving ground. One live account at a time.

Step 1 — Freeze size at 2 contracts, permanently, for the eval. The ledger is unambiguous: 2 is the
only size that survives. The 2→6 dial was a concession to the tilt; set it back to 2 and leave it.
The broker allows 40 micros; he should never go near it.

Step 2 — Make the "sizing up while red" stop physically binding. This is already a forced hard stop
in code. The gap is that it can be ignored. The fix is to make the oversize guard flatten to the cap
automatically and lock the day (not just warn), and to have the daily loss tiers close the platform,
not just show a banner.

Step 3 — Fix the data first, then trust the scores. Reconcile the app's trade count/contracts against
the broker's order history before scoring any day. A discipline score on wrong numbers is worthless
and it is currently eroding trust in the whole system (see Gap 6).

Step 4 — Turn the "edge window" into a gate, not a hint. His edge is the NY open (19:00 IST). The app
already computes an hour-edge table (hour-edge.js). Make it a hard gate: outside the proven edge
hours, half size or stand down. This alone removes most of the "outside-session" noise.

Step 5 — Ship the one missing feature: a single, decisive ENTRY/EXIT signal. This is Gap 1–4 and is
the thing he is explicitly asking for. Concretely: filter the raw detections, require (a) inside the
NY session, (b) 1H-aligned, (c) Playbook A or B — not the bare "candle only" and not the repeated
"still in range" PO3 heartbeat — and collapse it to one line with entry + stop + target + size 2. And
add the symmetric take-profit signal (exit at target, or "captured X% of the move — take it").

Step 6 — Grade the day on plan-adherence, not P&L (rule #14), and let the app enforce it. The green
+$747.7 day was a FAILED session by his own rule because the plan was broken. The app should carry
that verdict, not celebrate the green number.

Step 7 — Target the consistency rule explicitly. Set the daily target as "between $300 and $750, never
a day that exceeds 40% of my running total profit," and show that number live in the HUD against the
$3,000 eval / $4,000 funded goals.

---
## 6. What to change in the app (prioritized, smallest first)

| # | Change | File(s) | Effect |
|---|---|---|---|
| 1 | Set sizeCap back to 2; default 2 | app/rules.json | Removes the #1 killer |
| 2 | Reconcile app trades vs broker before scoring; flag drift | app/tv-broker-feed.js | Trust in numbers |
| 3 | Oversize guard: flatten-to-cap + lock day (no warn-only path) | app/oversize-guard.js | Killer becomes un-ignorable |
| 4 | Gate signals to NY edge window + 1H alignment; drop PO3 heartbeat chime | app/signal-alert.js | Noise → signal |
| 5 | Enable autonomyModes.assist (entry+exit) size 2; add take-profit signal | app/autonomy-modes.js, app/playbook-spec.js | The "signal me to enter" ask |
| 6 | One payout HUD number (funded $104,000, current, distance, consistency allowance) | app/renderer/app.js | Goal clarity |
| 7 | Retire "Lucid" → Tradeify; reconcile daily-loss tiers with rules.json | Prop Trading/CLAUDE.md | Remove drift |
| 8 | Remove plain-text keys from config | ~/.trading-copilot-config.json | Hygiene |

---
## 7. Bottom line

The app already detects the exact pattern that kills him, already warns him in real time, and already
has the rules to prevent every blow-up. It is being ignored, not missing. The single highest-$ fix is
not new code — it is obeying the existing size cap and daily stop. The genuinely missing piece he is
asking for — a decisive intraday entry/exit signal — is real and worth building, but it must come
AFTER the size cap is honored, because a better entry signal that feeds a 20-lot tilt just loses the
next account faster.

*Evidence sources: DATA/accounts/s2/*, DATA/reviews/2026-09-03.json, DATA/signals/2026-09-03*.jsonl,
DATA/account_fees.json, app/rules.json, app/playbook-spec.js, app/renderer/signal-alert.js,
app/IMPROVEMENT_PLAN.md, Prop Trading/CLAUDE.md.*