# TradeZella vs MNQ Co-Pilot — Gap Analysis & 3–4 Day Build Plan
*(2026-07-16 · researched from tradezella.com: homepage, /trading-journal, /prop-firm-sync)*

---

## 1. Positioning: don't chase parity

TradeZella is a **retrospective analytics platform** for 100K traders. Your Co-Pilot is a
**real-time enforcement cockpit** for one trader with known failure modes. Your edge over
TradeZella is everything that happens DURING the session: live TradingView integration,
mechanical GO/NO-GO, news blackout, guardrail HUD, Telegram alerts. TradeZella has none of
that depth. What TradeZella does better is the **after-session feedback loop** — that's
what to steal. Skip their backtesting, community/Spaces, university, and broker auto-sync
(you don't want APIs; your TradingView MCP already has replay tools).

## 2. Feature-by-feature comparison

| TradeZella feature | You have | Gap worth closing? |
|---|---|---|
| Auto broker sync (500+ brokers) | CSV upload + optional Tradovate live feed | No — CSV is deliberate, API-free |
| **Zella Score** (0–100 composite: profitability, risk, consistency, discipline) | disc% only (rule-points ÷ max) | **YES — #1 gap.** One number/day, trend over time |
| **50+ reports, cross-analysis** (tag × time-of-day × symbol) | Fixed insights cards | Partially — you need 3 reports, not 50 (hour-edge, playbook-edge, mistake-frequency) |
| **Strategy/playbook tagging → per-setup stats** ("which setup actually prints") | Playbooks A/B/C defined but never linked to trades | **YES — #2 gap.** You can't see if Playbook B beats A |
| **MAE/MFE analysis** (how far trades went against/for you) | Nothing | **YES — #3 gap.** And you can compute it FREE via TradingView OHLCV — TradeZella needs their data feed, you already have one |
| Running P&L per trade / drawdown story | Nothing visual | Partial — day equity curve with peak + giveback marker |
| **Consistency heatmap** (discipline over time, calendar) | Nothing | Yes — cheap, high-feedback |
| Daily checklist + pre-market templates | Checklist tab (yours is better — body check, hard risk gate) | No |
| **End-of-day summary + weekly Monday digest** | Chat report on CSV upload only | **YES.** Auto EOD file + Monday digest to Telegram |
| Trade rating + notes/screenshots per trade | Good-trade screenshot (AI) only | Yes — Edgedesk review modal port (rate + "followed plan?") |
| Economic calendar | News blackout (yours is better — enforced) | No |
| **Prop Firm Sync: real-time rule monitor, consistency % tracking** | Ladder + guardrails (yours is real-time already) | Consistency % live tracking — small add |
| **Prop firm failure-reason analytics** ("67% of your failures come from overtrading") | Blown-account analysis lives in Claude's memory, not the app | **YES — #4 gap.** Auto-categorize every red day |
| **Eval spend / payout ROI tracker** | Excel file + memory ($784.50 spent, $0 payouts) | Yes — one card in the app. Brutal, motivating |
| Pass-rate forecasting / challenge simulator | insPassMath (deterministic) | Later — Monte Carlo pass-probability from your actual trade distribution |
| Zella AI agents (habit/risk/sentiment) | Claude co-pilot chat + mechanical guards | No — your on-demand AI toggle covers it API-free |
| Trade replay tick-by-tick | TradingView replay tools already in your MCP | No — wire a "Replay this trade" button later |

## 3. The 3–4 day build plan (all mechanical, no APIs, testable immediately)

### Day 1 — Discipline Score + failure categorization (the feedback core)
1. **Co-Pilot Score (0–100)** computed per day from stored history:
   - Rule adherence 40% (trade count vs limit, size cap, session window, cooldown, news)
   - Risk quality 30% (avg loss vs perTradeMaxLoss, giveback, day stop respected)
   - Edge quality 20% (PF, win rate vs your 20-day baseline)
   - Process 10% (checklist done before first trade)
   - Shown big in the HUD + after every CSV upload. Trend arrow vs last 7 days.
2. **Red-day auto-categorization**: every negative day gets a primary cause tag —
   OVERTRADE / OVERSIZE / REVENGE / GIVEBACK / TAIL-LOSS / NEWS. Insights shows:
   "8 of your last 10 red days = TAIL-LOSS + OVERSIZE." Fix the right problem.

### Day 2 — Playbook tagging + consistency heatmap + weekly digest
3. **Tag trades with playbook A/B/C** at EOD (one dropdown per trade in a review list;
   bulk-tag supported). New Insights block: per-playbook WR, PF, avg hold, net P&L.
   After ~2 weeks you'll know which setup pays your bills.
4. **Consistency heatmap**: calendar grid colored by Co-Pilot Score (not P&L) — the
   TradeZella habit view. Green streaks = discipline streaks.
5. **Monday digest**: auto-generated weekly file + Telegram message — score trend,
   best/worst day, top mistake, one focus for the week.

### Day 3 — MAE/MFE via TradingView (your unfair advantage)
6. For each CSV trade, pull 1-min OHLCV for the holding window from the TradingView MCP
   and compute: max adverse excursion (heat taken) and max favorable excursion (profit
   available). Two lines you currently can't see:
   - "Winners: you captured 34% of available move (avg exit 1.4min, move kept running)"
   - "Losers: avg heat −$310 before you cut — your stop discipline, quantified"
   This directly attacks your known R:R inversion (avg win $209 < avg loss $230).

### Day 4 — EOD review ritual + eval economics
7. **EOD review modal** (Edgedesk port): after CSV ingest, rate each trade 1–5 +
   "followed plan?" toggle + playbook tag in one pass. 2 minutes, stored forever.
8. **Eval economics card**: total spent on evals ($784.50 + new), payouts received,
   net ROI, cost per failure reason. Seeded from your tracker, updated in-app.

### Test protocol (starting the day after each build)
- Upload the daily CSV as usual; each new block must appear with correct numbers.
- Success after 4 trading days = you can answer, from the app alone:
  "What's my score trend? Which playbook earns? What % of available move am I capturing?
  What causes my red days? What has this eval cost me so far?"
  TradeZella can't answer the third one as cheaply as you can.

## 4. Deliberately NOT copying
Backtesting engine (use TradingView replay), Spaces/community, Zella University,
broker auto-sync APIs, cloud AI agents (your on-demand API toggle is the right call),
mobile app. Every one of these is scope creep against a 3-week eval deadline.
