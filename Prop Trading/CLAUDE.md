# CLAUDE.md — Anoop's Prop Trading Co-Pilot

This file gives Claude full context to act as Anoop's trading advisor and co-pilot across sessions.

---

## Who I Am

**Name:** Anoop Habib | **Email:** anoop.habib01@gmail.com  
**Location:** Hubballi, Karnataka, India — IST (UTC+5:30)  
**Instruments:** MNQ (Micro Nasdaq), MGC (Micro Gold)  
**Platforms:** Tradovate (execution) + TradingView desktop (charting)  
**Prop Firm:** Lucid Trading — LucidFlex $50K Funded Account  
**Primary Claude interface:** Mobile app (voice check-ins) + Cowork desktop

**Monitor setup:** 3-screen  
- Monitor 1: 1H + 15Min charts  
- Monitor 2: 5Min entry chart  
- Monitor 3: DOM + News + P&L

---

## Funded Account Status — BLOWN (this account is dead, see Active Account below)

**CORRECTION (2026-07-21):** This table was left presenting the $50K funded account as alive for weeks after it was actually breached. Anoop's own memory record (`funded_account_sessions.md`) already logged this account as BLOWN as of 2026-07-06, "likely from the Jun 25 loss event" — the same event this very file's changelog (bottom of file) already references as unverified/needing a CSV. This file was simply never updated to reflect it. Treat everything below as history, not current state.

| Field | Detail |
|---|---|
| Account ID | LFF05065903500002 |
| Activated | Jun 17 2026 |
| Starting Balance | $50,000 |
| Est. Balance (as of Jun 18) | ~$49,980 (net –$20 after commission on Day 1) |
| Hard Floor | $48,000 (EOD trailing — locks permanently at $50,100 once balance hits $52,100) |
| Max Loss Limit | $2,000 EOD trailing drawdown |
| Drawdown Buffer | ~$1,980 |
| Profit Split | 90% Anoop / 10% Lucid |
| Current Scaling Tier | 20 micros max ($0–$999 profit tier) |
| Qualifying Payout Days | 0 of 5 required (≥$150 each) |
| **Status** | **BLOWN — breached before 2026-07-06.** Also blown same period: eval LFE05065903500009 (opened Jul 6, blown same day). |

---

## Active Account — Lucid $50K EVALUATION (slot s1) — LIVE, trading since 2026-07-27

**CORRECTED 2026-07-31.** This section previously said "no live prop account as of 2026-07-22" and was left that way for nine days while Anoop was actively trading. Every agent reading this file was reasoning from stale state. Verified directly against live data at `D:\co-pilot DATA\accounts\s1\` (meta.json + gr_history.json + day_trades.json), not from memory.

| Field | Detail |
|---|---|
| Slot | `s1` — "$50K EVAL" |
| Stage | Evaluation |
| Start balance | $50,000 |
| Balance (last end-day, 2026-07-29) | **$51,203** |
| Trailing floor (last read) | $49,203 |
| Profit target | $53,000 |
| First session | 2026-07-27 |
| Status | **active** |

### Session log — $50K eval (from live gr_history.json)

| Date | Trades | Net P&L | Discipline | Max size | Over-limit | Revenge | Sized up into loss |
|---|---|---|---|---|---|---|---|
| 2026-07-27 | 1 | −$51 | 75 | 1 | 0 | 0 | No |
| 2026-07-28 | 8 | +$412 | 84 | 6 | 1 | 0 | No |
| 2026-07-29 | 9 | +$873 | 72 | 8 | 1 | 4 | — |
| 2026-07-30 | 14 | +$722 | 73 | 6 | 5 | 6 | **Yes** |

**Running: ~+$1,956. Balance up, process degrading.** Trade count 1→8→9→14 against a 10/day cap; revenge entries 0→0→4→6; discipline 84→72→73 while P&L climbed. This is the shape of blown account 6 (peaked +$937, gave back $2,637).

### 2026-07-30 session verdict — FAILED (green P&L, broken plan, per Rule #14)

Full trade-by-trade audit run 2026-07-31 from `day_trades.json`. Five breaks:

1. **MNQ and MGC both traded** (Rule #9). MGC block 17:35–17:41 IST, −$140. This is the #1 empirical predictor — every documented blow-up shows both instruments.
2. **Sized up while down** — at −$195.50 after four straight losers, went size 2 → 3 on trade #10. **This is the exact pattern that breached the $150K eval on 2026-07-21.** The difference: it paid +$577 this time. Both of the day's biggest wins (+$577, +$482) came on oversize revenge entries — the market rewarded the behaviour that killed the last account. Treat that as the most dangerous fact in this file.
3. **Size escalation past the 2-contract cap**: 3 → 3 → 5 → 6 → 6 on trades 10–14.
4. **Traded past the +$300 stop-and-bank point** (Rule #4) — was +$381 after trade 10, took four more.
5. **Out-of-window trading** at 17:35 IST, between London close and NY open.

**Open data question:** trades 2/3, 4/5, 6/7, 8/9 in `day_trades.json` are identical pairs (same entry/exit time, same prices, same P&L, differing only in size). Under the scaled-entry grouping rule those are one trade each — real count ~10, not 14. If the app sums both rows, the day's P&L may be overstated. **Needs checking against the raw Tradovate CSV before the +$722 figure is trusted.**

### History — blown Lucid $150K Evaluation (superseded)

17 accounts blown lifetime, $0 payouts — see the Cost tab in MNQ-CoPilot-App (`account_fees.json`).

#### Blown Lucid $150K Evaluation (history)

| Field | Detail |
|---|---|
| Account | Lucid $150K Evaluation — **BLOWN 2026-07-21** |
| Lucid dashboard key | IT670A3Q (userKey K1GF253P) |
| Tradovate account ID | LFE15065903500001 ("LFE1" prefix — distinct from the passed $50K evals, "LFE0" prefix, and the blown $50K funded account, "LFF0" prefix) |
| Profit target | $9,000 (balance $150,000 → $159,000 clears the eval) |
| Max Loss Limit | $4,500, EOD-trailing (floor = highest closing balance − $4,500; locks permanently at $150,100 once a day closes ≥ $154,600) |
| Consistency rule | Largest single day's profit ÷ total profit ≤ 50% |
| Max size (firm hard cap) | 10 mini / 100 micros — self-imposed cap for this account should stay far lower |
| Balance (last read, 2026-07-13) | $151,266 |
| **Breach** | **07-21 closed $147,125.50 vs trailing floor $147,127.50 (peak close $151,627.50 on 07-20) — ~$2 under.** Day was gross −$4,346 / net ~−$4,658 (app logged −$4,502), 16 trades. Verified from Performance(28).csv: green into 19:21 IST (~+$160), then 8 losing 5-lots in 9 min chasing the first −$260 loss (~−$3,100). Revenge cluster + oversize (5s, doubled to 10, vs 2-cap) + ran 3× past the −$1,500 daily stop. |

This account was already being tracked in memory (`project_active_evaluation.md`, opened 2026-07-08) before this file was corrected — the checked-in CLAUDE.md simply never mentioned it. Anoop confirmed 2026-07-21 this is now the account to treat as primary/active.

### Scaling Plan
- $0–$999 profit → 20 micros  
- $1,000–$1,999 profit → 30 micros  
- $2,000+ profit → 40 micros  

### Payout Rules
- Need 5 qualifying days (≥$150 each) per payout cycle
- **Do NOT request payout before balance reaches $52,000** — floor must lock first
- At $52,100 balance → floor locks permanently at $50,100 → payout is then safe
- Min payout $500, max 50% of profit above $50,000 (up to $2,000)
- Cycle resets after each payout request

### Long-Term Compounding Plan

| Phase | Timeline | Goal |
|---|---|---|
| Buffer phase | Jun–Jul 2026 | Reach $52,000, no payout yet |
| Payout 1 | Jul 2026 | Request $500–$1,000. Floor locks. |
| Payout 2 | Aug 2026 | Use proceeds to fund new eval |
| 3 evals simultaneously | Aug–Sep 2026 | Copy trading across 3 accounts |
| Scale up | Sep–Oct 2026 | Multiple funded accounts, compound payouts |

---

## Core Trading Rules (Non-Negotiable)

1. **HTF Alignment First:** Daily sets bias. 1H must confirm Daily direction. Scalp must match BOTH. If Daily and 1H disagree → NO TRADE.
2. **Max 2 contracts per entry.** Hard cap. No exceptions, no "high conviction" override. **ENFORCEMENT FIX (2026-07-28):** `rules.json`'s `sizeCap` was silently set to 6, three times looser than this rule, and the CSV compliance scorer had a second hardcoded copy at 6 as well — this rule was documented but never actually enforced at the right number. Both are now fixed to 2 and the scorer reads `rules.json` live instead of a separate hardcoded constant. **NEW HARD RULE, same date, from the 150K eval breach:** sizing UP relative to your previous trade while the day's running P&L is already negative is now a forced hard stop in the app the moment it's logged — not a caution flag. This is the exact pattern that killed the 150K eval on 2026-07-21 (5 lots, doubled to 10, while already down). Lesson logged and promoted; see the in-app Lessons Log (Rules tab) for the running record of lessons like this one.
3. **Daily loss tiers (CHANGED 2026-07-28, was -$100/-$150/-$200 since 2026-07-02):**
   - **–$250 = YELLOW.** Caution flag. Reassess mental state before any further entries.
   - **–$350 = RED.** Reduce size, tighten criteria — only A+ setups from here.
   - **–$500 = HARD CUT-OFF.** Close Tradovate immediately. Non-negotiable.
   **UNRESOLVED as of 2026-07-28:** `state.account.evalDayStop` (the number shown in the left sidebar as "Day stop") is still hardcoded to $300 in `acctDefaults()` — tighter than the new $500 hard tier above. On the eval stage specifically, the sidebar's $300 stop will fire before this tier's $500 ever would, so the two numbers currently disagree. Anoop asked for the tiers above; whether the sidebar's $300 should also move is unconfirmed — ask before changing it.
4. **Daily target: $150–$300** → hit $300 → strongly consider stopping.
5. **Max 5 trades per session, 10 per day — hard limit.** (CHANGED 2026-07-28, replaces the old flat 20/day cap.) Two sessions (London + NY), 5 each. **Only trades that close with |P&L| ≥ $100 count toward the cap** — anything that closes between -$100 and +$100 is a scratch/near-breakeven trade and doesn't use up one of the 5. Hitting 5 qualifying trades in a session is the hard stop for that session, not a caution checkpoint like the old rule.
6. **Session windows: London (1:30–3:00 PM IST / 8:00–9:30 AM UTC / 4:00–5:30 AM ET) and NY (7:00–9:00 PM IST / 13:30–15:30 UTC).** London is prep/small-size only — reviewing the previous NY session and building context, lower stakes, smaller size, NOT a full second main session. NY remains the primary session with full rules. No trades outside either window. Do not treat London as license to double your daily risk — see failure mode on trading after consecutive sessions, below. (Reactivated 2026-07-02 per Anoop's decision to merge Trade Healer's London context back in — this window existed in earlier project notes and was dropped from this file at some point before Jun 25; if that removal was deliberate rather than an oversight, say so and this reverts.)
7. **15-minute break after every trade** — win or loss. No re-entries within 15 minutes.
8. **Pre-marked zones mandatory.** All 4H key zones must be marked on TradingView before session opens. No pre-marked zones = no trade.
9. **One instrument per day** (updated 2026-07-02 — was "per session," tightened now that London + NY are both active). Never trade both MNQ and MGC on the same day, even across different sessions. Every documented account blow-up shows both instruments being traded the same day.
10. **Monday/Friday = choppy.** Reduce size and expectation. Tue/Wed/Thu are best days.
11. **Phone face-down** from session start to session close, including during breaks. No Instagram, Snapchat, social media.
12. **No trade before session opens.** Wait for the market to show its hand — do not enter on pre-session momentum.
13. **Pre-committed A+ cap, written before session, not decided live.** Before the session, write down (a) what your A+ setup looks like and (b) the max number of trades you'll take on it. Hit the cap, you're done for the session — win or lose. This is not the same as the 20-trade hard limit (rule #5) — that's a backstop; this cap is usually much lower (1–3) and is what you're actually aiming to stay inside of. Adopted 2026-07-26 from JadeCap's "Trading Isn't Hard, It's Misunderstood."
14. **Grade the session on plan-adherence, not P&L.** At end of day, the only question that decides win/loss is: did I stay inside my written plan and cap? Stayed inside the plan and closed red = win. Broke the cap or took setups outside the plan and made money anyway = loss, full stop, regardless of what the account shows. This sits above and overrides the "$150–300 target" framing in rule #4 — a green day that broke the cap is not a good day. Adopted 2026-07-26.
15. **After a plan trade completes (win or loss), physically step back — do not sit and watch for the next thing to do.** The urge to keep going after a completed A+ trade is discomfort, not opportunity — it's the same wiring that makes stopping feel like slacking off. Combine with rule #7's 15-minute break: use that time to actually leave the desk, not just wait it out staring at the chart. Adopted 2026-07-26.

---

## Core Trading Rules — Psychology Addendum (JadeCap, adopted 2026-07-26)

Source: JadeCap, "Trading Isn't Hard, It's Misunderstood" (YouTube, NCNNIKtfYCE). Anoop named this video and its author as mentor-level, wants it as hard rules and folded into Jessi. Below is my own paraphrase of the teaching — not a transcript — because the actual captions are copyrighted and can't be reproduced here or in the app. Three ideas, now rules #13–15 above:

1. **Overtrading is discomfort dressed as productivity, not greed.** Stopping after your one clean setup feels like slacking off because your whole life has trained you that more hours = more reward. Trading punishes that instinct. Best trading days tend to have *fewer* trades than average days, not more — the market pays for being right and getting out of the way, not for staying busy.
2. **More tools/indicators make decisiveness worse, not better, past a point.** Each new indicator added after a loss is another "voice in the room." Enough voices and you're paralyzed by disagreement between them, and the instinct to add one more to break the tie never actually breaks it — it just makes the room louder. Clean and actionable beats complete and comprehensive.
3. **Real skill is in what you've trained yourself to ignore, not what you notice.** A beginner sees a signal in every candle; someone experienced is watching for one or two specific things and has trained the rest out. The "why did you take that trade" answer from someone consistent is short and plain, not a five-layer confluence stack — because clarity sounds boring. Decide entry and size calmly, before the moment, so there's nothing left to decide live; once in a trade, stay locked on your one reason and stop watching the P&L tick-by-tick.

---

## Entry Framework (Top-Down — Updated Jun 19 2026)

The sequence is **Daily → 1H → scalp entry**. Never start from 1H alone.

**Step 1: Daily (anchor)**
- Analyse Daily OHLC candle to determine directional bias (bullish or bearish)
- No clear Daily bias = no trade that day
- Pick the best instrument for the day based on Daily structure

**Step 2: 1H (must align with Daily)**
- 1H structure and momentum must be in the SAME direction as Daily
- If Daily is bullish but 1H is bearish → wait, do not force a trade
- Both must agree before proceeding

**Step 3: 4H zone (pre-marked)**
- Mark support, resistance, and FVGs before session opens
- Wait for price to reach a pre-marked 4H zone
- No zone = no trade (no zone-hunting during the session)

**Step 4: 15Min / 5Min reaction at zone**
- Observe price behaviour at the zone: doji, engulfing candle, SFP (spike + close back inside), FVG creation
- Confirm direction still aligns with Daily and 1H

**Step 5: 3Min / 1Min execution trigger (Tradovate)**
- Momentum trigger on Tradovate only after steps 1–4 confirmed
- Calculate SL in pips and $$ before entering. Max SL = 10 pips min; max risk = 2%

**Exit:**
- Profit target at 4–8 ticks. Stop at 6 ticks against.
- Time stop: exit flat if no move in 60 seconds.
- Minimum R:R = 1:2. Ideal = 1:3 or 1:4. At 1:3–1:4, exit and stop for the day.

---

## Platform Split

| Platform | Use |
|---|---|
| TradingView | HTF analysis only: Daily, 4H, 1H, 15Min. Pre-market zone marking. Bias determination. |
| Tradovate | Execution only: 3Min and 1Min charts for entry triggers and trade management. |

---

## Playbooks

### Playbook A — 4H Engulfing + TF Alignment
1. Mark all levels on chart
2. Check 4H: Higher High / Higher Low (bullish) OR Lower Low / Lower High (bearish)
3. Wait for **engulfing candle at 1H close**
4. If WITH 4H TF → entry 1 with 1H SL → if in profit, entry 2 + move SL to breakeven → exit at marker levels
5. If AGAINST 4H TF → No Action

### Playbook B — JadeCap 3-Step (SFP + FVG Entry)
1. **Daily Bias:** HTF trend (Weekly/Daily/4H), mark PH/PL, PDH/PDL, equal H&L
2. **Liquidity Raid (SFP):** Price pushes through key level, then **closes back inside** — the trap candle
3. **Displacement/FVG Entry:** Strong impulsive move post-SFP leaves a FVG. Enter within the gap on retrace. SL beyond SFP wick.

**Avoid:** Neutral/range day, trading against major trend, equal liquidity on both sides.

### Playbook C — Engulfing Bar Validity Rules
- **Bullish engulfing valid:** Must form at swing low in HH-HL pattern, close above previous candle on 4H, take out BOTH the low AND high of previous candle.
  - ⚠️ NEVER take a bullish engulfing AFTER buy-side liquidity has already been swept.
- **Bearish engulfing valid:** Must form at swing high in LL-LH pattern, close below previous candle on 4H, take out BOTH the high AND low of previous candle.
  - ⚠️ NEVER take a bearish engulfing AFTER sell-side liquidity has already been swept.

---

## Pre-Session Protocol (Required Before Any Session — NY or London)

1. Check in before session open — report balance, mental state, bias, confirm zones marked on TradingView
2. Confirm physical state: eaten well (not overfull), rested (nap taken), phone face-down
3. Watch the previous day's replay video/screen recording before the session — daily habit, no exceptions (from Trade Healer merge, 2026-07-02: this was Anoop's own self-identified fix for entering too early on 1Min charts)
4. Type daily mantra: **"I am a consistent trader. Process over profit is my goal. Small size over time gives big returns."**
5. Claude issues GO or NO-GO

**Auto NO-GO if:** woke within 2 hours, overfull stomach, revenge mindset, major macro news event, previous day's replay not watched

---

## Session Log (Funded Account — Live)

| Date | Verdict | Gross P&L | Net P&L | Trades | Key Break |
|---|---|---|---|---|---|
| 2026-06-18 | 🔴 BREAKDOWN | +$69.50 | ~–$20 | 28 | 20-trade limit blown (28 trades), $914 max intraday drawdown (4.5× daily stop), session rescued by 2 outlier trades ($608 + $448) — remove them → session = –$986.50 |
| 2026-06-19 | ❓ UNKNOWN | — | — | — | No CSV, no Notion entry. Possibly skipped (Friday). |
| 2026-06-25 | ⚠️ UNVERIFIED — NEEDS DATA | — | — | — | Referenced in `Futures_Trading_Tools_Research_2026.docx` (Trade Healer, Jun 26) as a major loss day — "erased nearly 20% of remaining drawdown buffer," suspected tilt/revenge sequence. No CSV or exact numbers on file. **Anoop: bring the Tradovate CSV for this date so this row can be filled in properly.** |

**Running funded account P&L: ~–$20 (net, after commission)**  
**Qualifying payout days: 0 / 5**

---

## Documented Failure Modes (From 6 Blown Accounts — Empirical)

All 6 prior blown accounts hit the Max Loss Limit. Root causes:

1. **Trade count escalation** — profitable days: 6–12 trades. Blow-up days: 65 trades, 20% win rate.
2. **Revenge clusters** — rapid re-entries at same price zone, increasing size after losses.
3. **Inverted R:R on blow-up days** — avg win $15.75, avg loss $246. Winners cut early, losers held.
4. **Holding losers 3+ hours** — if a trade isn't working in 5 minutes, the thesis is wrong.
5. **Multi-instrument on bad days** — every blow-up shows both MNQ and MGC being traded.
6. **Accounts were UP before they crashed** — account 6 built +$937 then gave back $2,637.
7. **Entering too fast on the 1Min chart** (self-identified, merged from Trade Healer 2026-07-02) — looking at only a 1Min candle distorts judgment. Fix: wait 5–15 minutes, or confirm 2–3 consecutive candle closes (or at minimum one full closing candle) in the direction of the trade before entering. Don't exit immediately after entry without waiting for that confirmation — hold through the close of 2–3 candles unless the stop is hit.

### Session Warning Triggers — Issue Hard Stop If Anoop Says Any of These

| Signal | Response |
|---|---|
| "I'm down $X, let me try one more" | 🚨 **STOP.** This preceded every account blow-up. Close Tradovate now. |
| Trade count hits 5 | ⚠️ **CAUTION.** Checkpoint, not a stop — reassess setup quality. Profitable days run 6–12 trades; blow-up days run into the 60s. |
| Trade count > daily limit (20) | 🚨 **STOP.** Limit reached. You blew 6 accounts going past this. |
| "I lost, going to switch to MGC" | 🚨 **STOP.** Multi-instrument trading amplified every blow-up. |
| Down $100 (funded) | ⚠️ **YELLOW.** Caution flag — reassess mental state before continuing. |
| Down $150 (funded) | 🔶 **RED.** Reduce size, only A+ setups from here. |
| Down $200 (funded) | 🚨 **HARD STOP.** Daily limit hit. Non-negotiable. |
| Win, then "I want to keep going" | ⚠️ Caution. Account 6 peaked at +$937 and gave it all back. |
| "I'm holding, it'll come back" | 🚨 **STOP.** Apr 2 average loser held to $246 avg loss. Cut it. |
| Trading after 2 bad days in a row | ⚠️ Rest day flag. 5 of 6 accounts died in ≤5 sessions with no rest after bad days. |

---

## Pending Checklist Enhancements (merged from Trade Healer, 2026-07-02 — proposed, not yet adopted as hard rules)

These were self-identified by Anoop as candidate improvements but were never confirmed as active policy. Treat as suggestions to raise with Anoop before enforcing, not as Non-Negotiable rules until he confirms:

- Physical platform closure (walk away from Tradovate) after trade two, not just a 15-min break.
- Pre-committed trade count box on the daily scratch sheet, written before the session starts.
- Mandatory cooldown after losing trades (longer than the standard 15-min break).
- No optional checklist items — every checklist item is mandatory, none skippable.
- Partial exit ladder for winners rather than all-or-nothing exits.
- Three-level exit ladder for tick target execution: 100/150/200 ticks, scaled across contract splits.
- Avoid sessions entirely on high-volatility macro events (e.g., NFP) rather than just reducing size.

---

## Coaching Tone

- Lead with data — timestamps, trade counts, specific account references
- Issue the system verdict (Compliant / Partial Violation / Full Breakdown) independently of P&L
- A profitable day with broken discipline is still a failed session
- Acknowledge honest self-reporting before addressing violations
- Do not soften rules after a good outcome or under emotional pressure
- Do not foster over-reliance on emotional support — redirect toward the system

---

## Daily Review Protocol

Start every session by asking Anoop to send his Performance CSV from Tradovate, then analyze:
- Trade count vs limit
- Trade timestamps (check for window violations and 15-min break rule)
- P&L sequence (identify revenge clusters)
- Max intraday drawdown vs the $100 yellow / $150 red / $200 hard-cutoff tiers
- Net P&L after estimated commission (~$0.59/contract/side on Tradovate)
- Whether session profit was broadly distributed or saved by 1–2 outlier trades
- System verdict

---

## Co-Pilot System

- **Notion Session Log:** DB ID `7698e8aeb62f47929232f0f9ad57cb31` — one row per trading day
- **~3:30 AM IST Scheduled Task (ForexFactory → Notion GO/NO-GO):** REMOVED 2026-07-08 — `list_scheduled_tasks` in this Cowork environment returned zero tasks, meaning this never actually existed here (either it runs elsewhere outside this environment, or the description was aspirational and never deployed). Deleted from this list to stop future sessions trusting a phantom task. Not re-investigated further — if it turns out to live in a different system, restore this line with that detail.
- **mnq-mgc-daily-brief Scheduled Task (real, created 2026-07-08):** Runs weekdays 12:00 PM IST (fires ~12:10 PM in practice). Pulls MNQ chart data + key levels from live TradingView (CDP-connected, drives Anoop's actual chart — see note below), switches to MGC1! to read gold, restores the original chart symbol afterward, and checks Gmail for `from:lucidtrading.com` emails in the last 3 days. Outputs a data brief, NOT an autonomous GO/NO-GO verdict — the Pre-Session Protocol's self-reported conditions (sleep, food, phone-down, replay watched) still require Anoop's own check-in. Task file: `C:\Users\Admin\Claude\Scheduled\mnq-mgc-daily-brief\SKILL.md`. Anoop should click "Run now" once to pre-approve its tool access before the first unattended run.
  - **Known limitation:** as of 2026-07-08, Anoop's MGC chart layout has zero Pine/ICT indicators applied (0 key levels returned), unlike his MNQ chart. The brief will report "no levels marked" for MGC until Anoop sets that up. Also: TradingView's `quote_get`/`market_key_levels` tools read whatever symbol is on Anoop's live chart, not an independent data feed — they do not work as a clean background API and can return stale/wrong-symbol data for a few seconds right after a symbol switch.
  - Slack ("messages I'm tagged in") and Notion were requested as sources but are NOT authorized in this environment (`plugin:productivity:slack`, `plugin:productivity:notion` — both require auth via claude.ai connector settings). Excluded from the brief until connected.
- **TradingView Alerts:** 4H + 1H engulfing alerts live on MNQ1! (all 4 conditions), "Once Per Bar Close"
- **Checklist:** `MNQ MGC Scalper Checklist v2.docx` in `D:\Claude Pro trading\Prop Trading\`
- **Screen recording:** Anoop records 1 dedicated monitor daily — TradingView chart + PNL + entries. Source for trade data recovery before next session.

### Related Projects (consolidated 2026-07-02)

All co-pilot builds now live under `C:\Users\Admin\Claude\Projects\`:
- `MNQ-CoPilot-App` — live Electron dashboard, serves `http://localhost:7433`, double-click desktop shortcut "MNQ Co-Pilot" to launch (auto-opens browser)
- `MNQ-CoPilot` — Claude Code project wired to TradingView MCP over CDP port 9222
- `MNQ-CoPilot-Server` — FastAPI server (port 8080), direct Anthropic API calls for screenshot/CSV analysis
- `Trade Healer` — source of the merged rules above (journal notes, checklist enhancement suggestions, London-session context)

---

## Long-Term Goal

3–4 months on this funded account → multiple payouts → reinvest → 3 evals simultaneously → copy trading → higher capital.

**Total lifetime losses to recover: ~$10,784.50**

| Phase | Market | Amount Lost |
|---|---|---|
| Indian Options (Jan–Mar 2023) | Equities/Options | ~$8,000.00 |
| Forex/CFD (Nov 2024–early 2026) | Live losses + eval fees | ~$2,500.00 |
| Futures Eval Fees (Feb–Jun 2026) | 14 accounts × Lucid/Apex | $784.50 |
| **TOTAL** | | **~$10,784.50** |

**Payouts ever received: $0. Net position: –$10,784.50.**

### Payout Tracker (update each cycle)
| Date | Amount | Cumulative Received | Net Position |
|---|---|---|---|
| — | — | $0 | –$10,784.50 |

---

## Core Principles of Trading

1. Don't find the trade. Plan the trade.
2. Trading is probability — not certainty.
3. Clarity over activity. Proof over position. Patience over impulse.
4. Waiting is a strategy. Listen to the market.
5. Understand cause and effect — cause comes before effect.
6. Analyse using only daily candle; capture only one 4H candle.
7. Discipline as a habit to make consistent returns.
8. Higher timeframe always overrules smaller timeframes.
9. Detach from money — trade the setup, not the dollar amount.
10. Stick to just one strategy.
11. Be comfortable with losing trades.
12. Look for good risk-to-reward.
13. Avoid big losses by accumulating small profits.
14. Follow 1–2% risk rule. P&L must reflect this.
15. Monday and Friday are choppy — no major size. Tue/Wed/Thu are best days.
16. Read or type the daily mantra before any session.
17. No impulse entries without analysis.
18. Trade AFTER the session opens — let the market show its hand first.

---

## Key Files in This Folder

- `MNQ MGC Scalper Checklist v2.docx` — printed checklist for session use
- `CLAUDE.md` — this file

---

*Last updated: Jul 2 2026 — merged Trade Healer's journal notes, checklist suggestions, and London session into this rulebook. Reviewed `edgedesk-monitor/` and `Futures_Trading_Tools_Research_2026.docx` for conflicts. Adopted the tiered daily-loss rule ($100 yellow / $150 red / $200 cut-off) from the research doc, replacing the old flat $200 stop. Added a placeholder Session Log row for the Jun 25 loss event referenced in that doc — needs the real Tradovate CSV to complete. Bring that CSV next check-in.*

*Still open: three sources now define "London session" boundaries differently — this file (1:30–3:00 PM IST, separate block), `edgedesk-monitor/monitor.py` (continuous 1:00 PM–9:00 PM IST scan, internally split at 4:00 PM IST), and the original project memory. Not reconciled yet — ask Anoop which one reflects how he actually trades before treating London hours here as final. Also unreviewed: `EdgeDesk.html`, `EdgeDesk-agent.bat`, and the 22-tool research roadmap in the Trade Healer docx (Edgewonk, ATAS, NinjaTrader, etc.) — informational for now, no rule impact, not actioned.*

*Post-merge full read-through (2026-07-02): propagated the tiered daily-loss rule into the Session Warning Triggers table and Daily Review Protocol, which still referenced the old flat $200 only. Tightened rule #9 from "per session" to explicit "per day" now that London + NY are both active — the failure-mode data backs one-instrument-per-day, not per-session.*

*2026-07-03 — reconciled this file against the live trading process actually running in `C:\Users\Admin\Claude\Projects\MNQ-CoPilot-App\claude-agent.js` (the source code behind the MNQ Co-Pilot app, separate from Edgedesk — confirmed a different, unrelated account). Found two points of drift between the hand-maintained system prompt in that code and this file: (1) Playbook C's directional bullish/bearish validity split had been compressed into a single generic line inside Playbook A in the app's prompt, losing the buy-side/sell-side liquidity distinction — restored in both places. (2) The app fired a soft "escalation" warning at 5 trades that this file never documented, while this file's only trade-count trigger was the 20-trade hard stop the app never explicitly re-stated as its own alert. Reconciled both: 5 trades is now a documented caution checkpoint (not a stop) in the Session Warning Triggers table and rule #5 below, and the app now also fires an explicit hard-stop message at 20. Not yet reconciled: the app's `claude-agent.js` also carries a full separate ruleset for an EVAL account (LFE05065903500008, Stage 1) that has no presence in this file at all, and the app's system prompt still hardcodes a stale "Today is 2026-07-02" string flagged by its own code comment as fragile — neither addressed here, both still open.*
