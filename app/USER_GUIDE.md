# Co-Pilot User Guide — what every part does and how to use it
*(2026-07-16 — written for the current build; open this file full-screen for comfortable reading)*

---

## 1. How data flows through the app (read this first)

There are **three sources of numbers**, and knowing which is which explains every "wrong balance" you'll ever see:

| Source | What it feeds | Trust level |
|---|---|---|
| **Your CSV uploads** | Balance, DD floor, cushion (left panel) · Insights history | Only as complete as the days you've uploaded — but ALWAYS wins over live for today if you've uploaded one (see below) |
| **Live feed** (TradingView broker panel, or Tradovate REST if enabled — whichever is connected) | Bottom HUD trade count / day P&L / max size, cooldowns · **2026-08-17: now ALSO feeds the left panel's Balance/DD floor for TODAY specifically, whenever you haven't uploaded a CSV for today yet** — marked with a "●" and a tooltip so it's never confused with a CSV-confirmed number | Real-time but session-only; balance-delta P&L math still not verified against a real trade with non-zero P&L (see TODOS.md) |
| **Ladder tab manual entries** | Ladder balance/floor/cushion **only** | Whatever you typed — completely separate from the CSVs |

That's why the left panel said **$148,990.5** while the Ladder said **$148,932** — they are two different trackers. The Ladder does NOT read your CSVs; it reads what you type into its "Actual Net" column.

**CSV upload is now optional for seeing today's Balance/DD-floor** (2026-08-17) — the live feed fills that gap automatically the moment it's connected. You still need to upload a CSV for: Insights history/scorecard, and to lock in the commission-accurate final number for the day (the live figure is an estimate). The Ladder tab remains entirely separate either way.

**Balance formula (left panel):** $150,000 + sum of each uploaded day's net P&L, where net = gross − contracts × $1.00 estimated commission. Two ways this drifts from real Tradovate:
1. **Days ingested before today's parser fix are stored wrong.** Your 07/09–07/15 uploads were processed by the old buggy parser and those wrong day-values are still saved. **Fix: re-upload the old CSVs once (any order) — each upload overwrites its days with corrected numbers.**
2. **The $1.00/contract commission is an estimate.** Real MNQ round-turn cost on your plan is different. Check your real Tradovate balance after re-uploading; whatever gap remains ÷ total contracts = your true commission rate. Tell Claude the real balance and the constant gets calibrated.

**"Evaluation stage didn't change" — that's correct behavior.** The DD floor ($145,500) is EOD-trailing: it only rises when your balance makes a **new high above $150,000**. You are below your starting balance, so the floor sits at its initial level. It will start trailing up the first day you close above $150K. Nothing is broken.

---

## 2. The left panel (always visible)

- **EVAL ACCOUNT block** — balance / DD floor / buffer / remaining-to-target / day cap / day stop. Fed by CSV uploads, OR (2026-08-17) by the live feed for today specifically if no CSV has been uploaded yet — a "●" marks a live-derived number. This is your survival dashboard: **Buffer** is the only number that matters intraday — it's how far you are from breach.
- **TODAY block** — GO/NO-GO verdict, day P&L, trades used vs limit (2/day in eval), recommended size, break timer.
- **NO-TRADE WINDOWS** — red-folder news events; the app forces NO-GO during blackouts.
- **Monitor toggles** (1H Engulf, FVG 15M, SFP) — background TradingView watchers that pop alerts + Telegram when your setups print. Turn on the ones matching today's playbook, ignore the rest.
- **Quick action buttons** — Pre-Session Check, Full Analysis (needs API key), Analyze Good Trade (needs API key — uploads a screenshot for vision review), **Update File** (mechanical, no AI — renamed 2026-08-17 from "Analyze CSV/PDF"; now also reads Excel `.xlsx`/`.xls` and plain-text `.txt`/`.tsv` broker exports, not just CSV/PDF), Mark London/NY Levels (draws PDH/PDL etc. on your TradingView chart), End Session.

## 3. Bottom HUD (the guardrail bar)

The strip at the very bottom is the **enforcement layer**:
- `✓ CLEAR — 0/2 trades` → you may trade.
- `⏳ COOLDOWN 14:32` → 15-min lockout running after a loss. No entries.
- `🚫 NEWS BLACKOUT` → red-folder event window. No entries.
- `⛔ STOPPED — DONE FOR THE DAY` → daily stop hit. It shows an overlay you must acknowledge by typing "i am done". **This fired today at −$300 and 21 more trades happened after the limit was passed. The bar can only tell you; the discipline is yours.**
- When the live feed (TradingView broker panel or Tradovate REST) is connected it says `● LIVE` and fills itself; otherwise log each trade manually in the small size/P&L boxes. Since 2026-08-17 the size-freeze-after-a-loss guard runs against live-detected trades too, not just manually logged ones.

## 4. The right-panel tabs, one by one

### ANALYSIS (default)
Market state: bias display, mechanical GO/NO-GO (session window + HTF alignment, no AI), monitor status/history, news list, Good-Trade Review image panel, and chat output lands here.
**Use:** glance before every entry — if mechanical check says NOGO, that's a stand-down.

### TRADES
Manual trade logger: direction / entry / stop / target / P&L. Writes to the daily session file (viewable in Log).
**Use it differently than you think:** not as a diary — as a **pre-commitment device**. Type entry/stop/target BEFORE you click in Tradovate, leave P&L blank. That forces you to have a stop and target planned. If you won't use it that way, ignore this tab — the CSV upload captures reality anyway.

### RULES
Static reference card of your own rulebook per mode (eval: 2 trades, 6 micros, −$300 stop, $2,500 day cap, 15-min break · funded: −$200 hard stop, scaling ladder, payout conditions).
**Use:** 10 seconds at session start, read it out loud once. It's your contract. Numbers now come from `rules.json` — edit that file to change your rules, never the code.

### LOG (sessions)
Archive of daily session files — plans and manually logged trades by date. Click a date to review.
**Use:** weekly review on Saturday. If you never log trades manually, this stays thin — that's fine.

### LADDER
The $150K eval pass-plan: 15 rows of planned daily +$700 steps with projected balance/floor/cushion. You type each day's **real net** in "Actual Net" and it recalculates. "Reset actuals" clears it.
**Use:** end of each trading day, type the real net from Tradovate (not the app's estimate). **Known flaw: it's disconnected from the CSV ledger — two balances on one screen. Unifying it is the next build task.**

### CHECKLIST
Pre-session ritual (ported from Edgedesk): session auto-detect, body check (poor sleep/no nap **halves your trade limit automatically**), playbook selector (A: Engulfing+4H · B: SFP+FVG · C: Liquidity raid), HTF/structure/risk checkboxes, 5-step framework, then **Mark Done** → GO / CAUTION / NO-GO verdict with readiness score /10. Risk Gate incomplete = automatic NO-GO. Saved daily, history kept 90 days.
**Use: this is the most important tab.** No entries until it says GO. Your Insights tab later shows readiness-vs-outcome — proof of whether the checklist predicts your green days.

### INSIGHTS
Everything your uploaded CSVs have taught the app: weekly scorecard (avg trades/day, over-size count, revenge count, discipline %, green days, best/worst day), **Pass Math** (cushion, to-target, consistency % vs the 50% rule), Coach's Notes (your most-repeated mistake, prime-day stats), per-day detail cards.
**Use:** after every CSV upload, read the "most-repeated mistake" line. That's tomorrow's single focus item. That is the 1%-a-day loop.

---

## 5. The daily loop (the only workflow that matters)

1. **Before session:** Checklist tab → complete it → need GO. Rules tab, 10-second read.
2. **During session:** trade only what the HUD allows. COOLDOWN/STOPPED/BLACKOUT = hands off. When it says 2/2 trades — done.
3. **After session (flat, platform closed):** export today's Performance report from Tradovate (CSV, Excel, or PDF all work) → "Update File" button → read the discipline report violations → Ladder tab: type real net → Insights: note the repeated mistake.
4. **Tomorrow:** yesterday's mistake is today's one improvement.

---

## 6. Current known issues (honest list)

1. **Old ledger days are wrong** until you re-upload the 07/09–07/15 CSVs (parser was fixed today at 14:36 + 21:00).
2. **Commission is an estimate** ($1.00/contract RT) — calibrate against real Tradovate balance.
3. **Ladder is a separate tracker** from the CSV ledger — two balances until they're unified.
4. **HUD "Day" figure is gross; chat report "net" includes estimated commission** — the −$268 vs −$438 you saw today. Same trades, different fee handling.
5. Enforcement is advisory — the app cannot block your Tradovate clicks. (A platform-lockout flow exists in your rules: STOPPED = close Tradovate itself.)
6. **(2026-08-17) Live balance overlay is new and unverified against a real trade's full P&L.** The "●" live Balance/DD-floor figure uses balance-delta-at-flat math that's never been checked against a real closed trade with non-zero P&L — treat it as directionally right, not exact, until confirmed. See TODOS.md.
7. **(2026-08-17) A semi-autonomous trade-confirm flow exists** (Debate mode → Judge says GO → a trade ticket appears → Confirm & Execute) — see TODOS.md's Phase 2 entries for what's built, what's live-verified, and what still needs testing before you trust it with real size.
