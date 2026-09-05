# MNQ Co-Pilot — Improvement Plan (2026-07-16)

> **SUPERSEDED SNAPSHOT (T5.3, 2026-09-04):** built on 4 days / 56 trades. The hour-edge
> conclusion survives the 151-trade pooled sample, but the exact per-hour numbers here
> (e.g. +$3,032 at 19:00 IST) do not — the pooled figure is +$433 at 61%. Read as history, not current.

Based on: full code review of MNQ-CoPilot-App, Edgedesk review, and 4 trading days
(07/09, 07/13, 07/14, 07/15) reconstructed from your 6 Performance CSVs.

---

## Part 1 — What your data actually says (deduplicated, fill-grouped)

Your 6 CSVs contained **71 duplicate rows** (overlapping exports) and the raw rows are
fill-pairs, not trades. After dedup + grouping by fill ID: **135 fills = 56 real trades over 4 days**.

| Metric | Value |
|---|---|
| Win rate | 55.4% (31/56) |
| Avg win / Avg loss | $209 / −$230 (**R:R inverted**) |
| Profit factor | 1.18 |
| Net P&L | +$978 |
| Max single win / loss | +$1,205 / **−$1,070** |
| Median hold (win/loss) | 1.4 min / 1.5 min |
| Avg size / max | 3.7 / 6 contracts |

### Per day
| Day | Trades | P&L | Intraday peak | Intraday trough | WR |
|---|---|---|---|---|---|
| 07/09 | 12 | **−$928** | +$847 | −$928 | 50% |
| 07/13 | 17 | +$638 | +$638 | **−$1,045** | 59% |
| 07/14 | 17 | +$597 | +$597 | −$807 | 47% |
| 07/15 | 10 | +$671 | +$671 | −$170 | 70% |

### By hour (IST entry)
| Hour | Trades | P&L | WR |
|---|---|---|---|
| 18:00 | 12 | **−$1,242** | 42% |
| **19:00** | 24 | **+$3,032** | **71%** |
| 20:00 | 15 | **−$843** | 40% |
| 12–14 | 5 | +$32 | 60% |

**The entire edge lives in the 19:00 IST hour (NY open).** Every other hour is net negative
or noise. 07/15 (your best-behaved day: 10 trades, no big loss, tight trough) is the template.

### Key behavioral findings
1. **Tail losses are the account-killer, not win rate.** One −$1,070 trade = five average
   winners. Your rules say −$200 daily hard stop; you hit troughs of −$1,045 and −$807 and
   traded through them.
2. **07/09 giveback: +$847 peak → −$928 close = $1,775 given back.** No giveback rule exists
   in the app.
3. **Trade count: 10–17/day vs your own eval limit of 2/day.** The guardrail exists in code;
   it is advisory and depends on manual logging.
4. **Counterintuitive:** your fast (<2 min) re-entries after a loss averaged **+$65** (n=14)
   while waited re-entries averaged −$18 (n=9). Small sample — but it suggests your problem
   is not re-entry speed, it's **size and hold-time on losers**. The 15-min rule may be
   treating the wrong symptom.
5. Long vs short roughly symmetric (57% vs 54% WR). No directional bias problem.

### The "1% per day" goal — reality check
Prop firms pay for **low variance**, not daily compounding. With PF 1.18 and single-day
swings of ±$1,000+, the binding constraints on your payout are: consistency rules
(best day ≤ 40–50% of total profit at most firms), trailing drawdown, and blowup days.
Reframe "1% better each day" as **one behavioral metric improved per week**, measured
mechanically. That is what this plan builds.

---

## Part 2 — The 10 improvements (priority order)

### 1. Fix the trade-grouping bug in the CSV scorer (CRITICAL — everything depends on it)
`computeCsvDisciplineReport()` and `csvParseTrades()` treat each CSV row as one trade.
Rows are **fill-pairs**: your scaled exits make 1 trade look like 7. Result: the 20/day
check, revenge detection, and avg win/loss are all computed on wrong numbers.
Fix: group rows by shared `buyFillId`/`sellFillId` (union-find), and dedup rows by
`(buyFillId, sellFillId)` across re-uploaded/overlapping exports. I found 71 duplicate
rows in your own uploads — the app would have double-counted them.

### 2. Move all history out of localStorage into a local `data/` folder
Guardrail history, checklist history, and insights live in renderer `localStorage` —
wiped by a cache clear, invisible to scripts, locked to one UI. Create
`data/trades.json` (or SQLite), `data/days/YYYY-MM-DD.json`, `data/rules.json`.
This is also what makes your planned **redesign/new app safe**: the engine and data
survive; only the UI is disposable. Edgedesk already proved the pattern with
`PreTradeLog.csv`.

### 3. Codify your rules in one `rules.json` — single source of truth
Right now rules are scattered: hardcoded tiers (−100/−150/−200) in the scorer, SIZE_CAP=6
in guardrails, session windows in two places (and they disagree — scorer allows
London 13:30–15:00 + NY 19:00–21:00; guardrail `sessWindow()` uses UTC 13:30–15:30).
One editable file, loaded by scorer, guardrails, and daily report. Your "fixed rules I've
made" become data, not code.

### 4. Hour-edge gate: block or warn outside 19:00–20:00 IST
Your data: hour 19 = +$3,032, hours 18 and 20 = −$2,085 combined. Add an auto-computed
hour-of-day edge table from stored history; when your live clock is in a historically
negative hour, the HUD shows "NEGATIVE-EDGE HOUR — half size or stand down."
Recompute weekly so it adapts as data grows.

### 5. Giveback lockout
New rule: if day P&L peaked above +$X (e.g. $400) and you retrace 50% of the peak,
day is locked (same overlay as daily stop). On 07/09 alone this saves ~$1,300–1,700.
This is the single highest-$ improvement available from 4 days of data.

### 6. Per-trade max-loss siren
Max single loss −$1,070 ≈ 5 avg winners. Add per-trade loss cap (e.g. −$200) to the
live Tradovate ingest: when an open position's drawdown crosses it, full-screen red
overlay + Telegram ping. The daily stop can't save you if one trade IS the daily stop.

### 7. Make live enforcement the default, manual logging the fallback
`grIngestLive()` already exists and fires the same guards from real Tradovate fills —
but the manual size/P&L input is the primary path. Invert it: auto-connect the live feed
at launch, grey out manual logging when connected, and have CSV upload act as end-of-day
**reconciliation** (live vs CSV mismatch = flagged). Discipline tools that require
discipline to operate don't work.

### 8. Daily auto-report + one focus metric (the actual "1%/day" loop)
On CSV drop (or session close), write `data/reports/YYYY-MM-DD.md` locally:
rule-by-rule verdict from `rules.json`, day stats, comparison vs your trailing 20-day
baseline, and **one** auto-picked focus item for tomorrow (worst-scoring rule).
Next morning, the pre-trade checklist shows yesterday's focus item at the top.
Fully mechanical, zero API. This file trail is your improvement ledger.

### 9. Port from Edgedesk: end-of-day review modal + weekly report + payout math
Worth taking: (a) the trade review modal (`showReviewModal`/`setRating`/`setRvFollowed`) —
rate each trade, mark "followed plan?", persist it; (b) `weeklyAlokReport()` — weekly
rollup; (c) multi-account switching (`switchAcct`) for running multiple evals;
(d) extend your existing `insPassMath` into a live **payout eligibility panel**:
consistency % (best day / total), trailing drawdown headroom, days remaining.
Skip: the Railway cloud monitor (your Electron engulf/FVG/SFP monitors already cover it).

### 10. Two-mode AI switch + secrets hygiene
Build the workflow you described into the UI: default mode = 100% mechanical/local
(scorer, guardrails, reports — no network). A "Deep Analysis" button prompts for the
API key, runs one bounded analysis on the *grouped* trade data (not raw CSV text —
cheaper and more accurate than the current 12,000-char CSV dump), then clears the key
from memory. **Security flag:** Edgedesk has a Telegram bot token hardcoded in
`monitor.py` and a `notion.key` file in the repo root. Revoke/rotate both; never
commit keys. Keep the co-pilot's key only in `~/.mnq-copilot-config.json` (already
outside the repo — good).

---

## Part 3 — Sequencing

Week 1: #1 (grouping bug) → #3 (rules.json) → #2 (data folder). Nothing else is
trustworthy until the numbers are right.
Week 2: #5 (giveback) + #6 (per-trade cap) + #7 (live-first). These are the $-saving guards.
Week 3: #8 (daily report loop) + #4 (hour gate).
Week 4: #9 (Edgedesk ports) + #10 (AI switch), then start the redesign on top of the
now-separated engine + data layer.

## Housekeeping
- 20+ `.bak`/`.pre-*` files in the repo — move to a `backups/` folder or use git.
- The redesign rule: **engine (rules + data + scorer) in its own module**, UI talks to it
  over the existing WebSocket. Then "change the whole design" costs you nothing.
