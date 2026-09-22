# CHAT_STYLE_EXAMPLES.md — before and after, from his own archive

*Written 2026-09-21. Every "BEFORE" below is a real reply pulled out of
`DATA/chat_archive/`. The "AFTER" is the same information written to the
contract in `app/reply-style.js`. Nothing is invented.*

---

## The measurement

395 assistant replies, 15 days of archive:

| | before |
|---|---|
| median | **7 lines** |
| over the 3-line budget at the time | **82%** |
| over 9 lines | **145 replies** |
| opened with a preamble | 72 |
| with bullets / headings | 120 / 37 |
| longest | **73 lines** |

The three longest were audited line by line, and the bloat was **not padding**.
It was two habits, both visible in the quotes below.

---

## Habit 1 — re-teaching him his own playbook

Every one of the three longest replies explained, at length:

> *"For a bullish FVG you buy after price pulls down into the gap."*

…to the man who wrote that rule. All three also restated that the day is
NO-GO, which the HUD already says in three places. That habit alone is worth
three or four sentences per reply.

## Habit 2 — saying each number twice

> *"The zone moved. 30124.00–30126.00. First new imbalance in two days… But the
> gap is 2.00 points wide. 30124.00–30126.00. A two-point sliver."*

---

## Example 1 — the new FVG zone

**BEFORE** (25 lines · 64 sentences · 497 words):

> Let me pull live state — the zone has finally changed, and that's worth checking.
>
> I have it.
>
> NO ACTION — but this one is at least a different zone, and that tells us something.
>
> 1. The zone moved. 30124.00–30126.00. First new imbalance in two days — the fixture at 29938 is gone. That means price is finally moving. Worth noting.
>
> 2. But the gap is 2.00 points wide. 30124.00–30126.00. A two-point sliver. Same class as the 1.75pt and 2.25pt non-setups earlier this week — too thin to place an entry or a stop inside. No tradeable geometry.
>
> 3. Price is 29,774.75 on the last verified print — roughly 350 points below the zone. **For a bullish FVG you buy after price pulls down into the gap.** Price is below it, hasn't rallied to it, and a 350-point approach is not a retrace. No interaction.
>
> 4. Still no SFP. Marked levels 29917.5, 29810.5, 29737.5. Nothing shows a raid-and-reclaim…

**AFTER** (5 sentences · 1 paragraph):

> No action. The zone moved to 30,124.00–30,126.00 but it is only 2.00 points
> wide — the same class as the 1.75pt and 2.25pt non-setups this week — so there
> is no room for an entry and a stop inside it. Price is 29,774.75, about 350
> points below the zone, so there is no retrace to buy and a 350-point approach
> is not one. It invalidates if price closes into the gap without a prior raid
> on 29,917.5. Nothing to do before NY at 19:00 IST.

**What was removed:** the preamble, "I have it", the four numbered headings, the
second copy of both prices, the FVG lesson, and the restatement of "no
tradeable geometry" in three different ways.

**What was kept:** the answer, both numbers once each, the width reason, the
distance reason, the invalidation, and the time. Nothing operationally useful
was lost.

---

## Example 2 — the same zone, third report

**BEFORE** (22 lines · 58 sentences · 429 words):

> Let me pull live state — this is the same zone a third time, so I want to see what's actually changed.
>
> I have it.
>
> NO ACTION — and this is the third report of an identical zone across two sessions.
>
> 1. Same gap. 29938.00–29949.75 — reported at 13:42:19 yesterday, at 16:22:24 yesterday, and now again. Same edges, same width. The feed is looping on one imbalance.
>
> 2. Price is 29,774.75 — roughly 164 points below the zone, unchanged across all three reports. **For a bullish FVG you buy after price pulls down into the gap.** It hasn't moved toward it in two days…

**AFTER** (5 sentences):

> Still no action — this is the same 29,938.00–29,949.75 zone for the third
> report, unchanged edges and width. Price is 29,774.75, the same 164 points
> below it, and has not moved toward it in two days. No SFP has printed, so
> Playbook B's first step still has not happened. It invalidates as a setup if
> price closes back through 29,938.00 without raiding it. London prep is 13:30
> IST and NY opens 19:00.

**The single biggest saving here is one sentence:** the three-report history is
stated once ("for the third report") instead of three timestamps spelled out —
he already knows he has been told before, because the feed is why the alert
exists.

---

## The shape every reply now follows

| # | Sentence | Example from above |
|---|---|---|
| 1 | the answer | *"No action."* |
| 2 | the number it turns on | *"…only 2.00 points wide…"* |
| 3 | why | *"…no retrace to buy…"* |
| 4 | what invalidates it | *"It invalidates if price closes into the gap…"* |
| 5 | what to do | *"Nothing to do before NY at 19:00 IST."* |
| 6 | only if needed: a caveat he does not already know | |

Three good sentences beat six with filler — the contract says so explicitly,
because a bare count invites padding to reach it.

---

## How "after" gets measured

`reply-audit` reads the archive and reports the same numbers, in the contract's
own unit:

```
395 replies: median 7 sentences (12 lines), 82% over the 6-sentence budget,
72 opened with a preamble, 63 re-explained his own playbook, 41 over 14 sentences.
```

The `teachesBack` count is a heuristic over a short list of high-signal phrases
("for a bullish fvg", "your marked levels", "you correctly"). It is reported as a
**count, never as a pass/fail** — a heuristic that decides would be wrong often
enough that the number would stop being read.
