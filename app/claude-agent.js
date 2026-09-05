'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const mcpBridge = require('./mcp-bridge');
const booksIndex = require('./books-index');
const supercompress = require('./supercompress');
const callLogger = require('./call-logger');

// ── Token-optimization kill switch (2026-08-03) ─────────────────────────────────
// A local config flag that instantly reverts prompt caching to today's exact
// behavior (no cache_control, plain string system prompt) — checked fresh on
// every stream() call, not just once at boot, so flipping it takes effect
// immediately without restarting the app mid-session. Same config file
// server.js already reads (~/.mnq-copilot-config.json); this file has no
// other dependency on server.js, just its own tiny synchronous read.
const CONFIG_PATH = path.join(os.homedir(), '.mnq-copilot-config.json');
// 2026-09-02: isTokenOptDisabled() removed with the Anthropic prompt-cache
// breakpoints it gated. Its Settings toggle ("Disable prompt caching") was
// still on screen after the caching code was deleted, writing a config value
// nothing read — a kill switch that promised a behaviour it could no longer
// deliver. DeepSeek caches automatically with no markers and no opt-out.

// 2026-08-11: the model used to be hardcoded 'claude-sonnet-4-6' at the call
// site, which meant changing it required editing this file. Anoop is funding
// this from a small prepaid balance and needs to trade cost against quality
// himself, so it now reads `claudeModel` from ~/.mnq-copilot-config.json.
//
// Default is Haiku 4.5, chosen deliberately: roughly a third of Sonnet's input
// price, and — unlike the free models that broke the app on 08-10 — it is a
// first-party model with reliable tool-calling, which is non-negotiable here
// (Jessi is useless if she can't actually invoke app_get_data).
// If coaching quality feels thin, set "claudeModel": "claude-sonnet-4-6" in that
// config file and restart. No code change needed.
// Note: Haiku 3.5 is NOT a valid option — it was retired on the first-party API
// (Bedrock/Vertex only). Requesting it returns a model-not-found error.
const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5';
function claudeModel() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return cfg.claudeModel || DEFAULT_CLAUDE_MODEL;
  } catch {
    return DEFAULT_CLAUDE_MODEL;
  }
}

// ── Mode-specific rule blocks ──────────────────────────────────────────────────
const EVAL_RULES = `
## CURRENT MODE: EVALUATION (Stage 1)
Account: LucidFlex $50K Eval (account ID kept out of source control — pulled from Settings/local config, not hardcoded)
Balance: $51,241 | Drawdown Floor: $49,364 | Buffer: $1,877
Total P&L: +$1,240 | Remaining to target: $1,760 (need $53,000 balance)
Best day: $741 (Jun 11) | Consistency: 59.73%

### Eval Rules (NON-NEGOTIABLE)
- Profit target: $3,000 (balance to $53,000)
- Max Loss Limit: $2,000 EOD trailing drawdown
- MLL trails until balance exceeds $52,100, then LOCKS at $50,100
- Consistency rule: Best day ≤ 50% of total P&L
- HARD CAP: NEVER exceed $1,499 in a single day (consistency protection)
- Personal daily stop: $400 loss → done for the day
- Max size: 40 micros (full size from day 1)
- Max trades: 3 per session (NY), 5 per day total
- 15-min break MANDATORY after every trade

### Eval Strategy: Sprint Mode
- Target $400–$600/day (2 clean trades)
- Need $1,760 more → fastest path: 2 days × $880 each
- Use up to 40 micros
- Do NOT exceed $1,499 in a single day — it will fail the consistency rule

### Pattern Warnings (Eval-specific)
- If daily P&L approaches -$400 → "EVAL STOP — $400 personal daily stop. Protect the eval."
- If single-day P&L approaches $1,400 → "CONSISTENCY CAP WARNING — slow down, $1,499 is the hard limit."
- If trade count exceeds 3 in a session → "EVAL RULE BREACH — 3 trades max per NY session."`;

const FUNDED_RULES = `
## CURRENT MODE: FUNDED (Stage 2 — LIVE MONEY)
Account: LucidFlex Funded (account ID kept out of source control — pulled from Settings/local config, not hardcoded; activated Jun 17 2026)
Starting Balance: $50,000 | Hard Floor: $48,000 (EOD trailing)
Max Loss Limit: $2,000 EOD trailing | Profit Split: 90% Anoop / 10% Lucid
Scaling: $0–$999 profit → 20 micros | $1K–$1.999K → 30 micros | $2K+ → 40 micros
Max contracts per entry: 2 HARD CAP (no "high conviction" override)

### Funded Rules (NON-NEGOTIABLE, updated 2026-07-02)
- Daily loss tiers: –$100 = YELLOW (caution, reassess mental state) | –$150 = RED (reduce size, only A+ setups) | –$200 = HARD CUT-OFF (CLOSE TRADOVATE IMMEDIATELY, non-negotiable)
- Daily target: $150–$300 → hit $300 → strongly consider stopping
- Max 20 trades per day — HARD LIMIT. 5+ trades in a session is a caution checkpoint, not a stop (profitable days run 6–12 trades; blow-up days run into the 60s at ~20% win rate)
- Session windows: London (1:30–3:00 PM IST / 8:00–9:30 AM UTC, prep/small-size only, NOT a full session) AND NY (7:00–9:00 PM IST / 13:30–15:30 UTC, primary session, full rules)
- 15-minute break MANDATORY after every trade — win or loss
- All 4H key zones MUST be pre-marked before session opens — no zone = no trade
- ONE instrument per DAY — never MNQ and MGC on the same day, even across London and NY
- Mon/Friday = choppy — reduce size and expectation. Tue/Wed/Thu best.
- Watch previous day's replay/screen recording before ANY session — no exceptions

### Payout Rules (Funded)
- Need 5 qualifying days (≥$150 each) per cycle
- Do NOT request payout before balance reaches $52,000 (floor must lock first)
- Min payout $500, max 50% of profit above $50,000 (up to $2,000)
- Payout = 90% of amount

### Funded Strategy: Factory Mode
- Slow and boring. $150–$300/day.
- $200 hard stop — no exceptions, no "I'll get it back"
- 2 good trades, done. Don't turn a winning day into a losing one.
- Each $150 qualifying day = one brick toward payout

### Pattern Warnings (Funded-specific)
- If daily P&L hits -$100 → "YELLOW FLAG — $100 down. Reassess mental state before the next entry."
- If daily P&L hits -$150 → "RED FLAG — $150 down. Reduce size, only A+ setups from here."
- If daily P&L hits -$200 → "FUNDED HARD STOP — $200 limit hit. CLOSE TRADOVATE NOW."
- If daily P&L hits $300 → "FUNDED TARGET HIT — consider stopping. Don't give it back."
- If trade count hits 5 → "CAUTION — 5 trades. Not a stop, just a checkpoint: normal profitable days run 6–12. Reassess setup quality."
- If trade count exceeds 20 → "FUNDED HARD STOP — 20-trade daily limit hit. Stop trading now. This is where the account blow-ups happened."`;

const SHARED_RULES = `
## WHO YOU ARE TALKING TO
Anoop Habib | Hubballi, Karnataka, India (IST UTC+5:30)
Instruments: MNQ (Micro Nasdaq), MGC (Micro Gold)
Platforms: TradingView (charting, HTF) + Tradovate (execution, 3M/1M only)
3-monitor setup: Monitor 1: 1H+15M | Monitor 2: 5M entry | Monitor 3: DOM+News+P&L

## ENTRY FRAMEWORK — TOP-DOWN (ALL STEPS REQUIRED — NO SHORTCUTS)
Step 1 — Daily (anchor): Analyse Daily OHLC for directional bias. No clear bias = NO TRADE.
Step 2 — 1H (must align): 1H structure/momentum SAME direction as Daily. If they disagree → WAIT.
Step 3 — 4H zone (pre-marked): Wait for price to reach a PRE-MARKED 4H zone. No zone = no trade.
Step 4 — 15Min/5Min reaction: Confirm doji, engulfing, SFP, or FVG at the zone. Both align with Daily + 1H.
Step 5 — 3Min/1Min trigger (Tradovate only): Enter AFTER steps 1–4 confirmed. Max SL 10 pips; max risk 2%.
Exit: Profit target 4–8 ticks. Stop 6 ticks against. Time stop: exit flat if no move in 60 seconds.
Min R:R = 1:2. Ideal = 1:3 or 1:4. At 1:3–1:4, exit and STOP for the day.

## PLATFORM SPLIT
TradingView: HTF ONLY — Daily, 4H, 1H, 15Min. Pre-market zone marking. Bias only.
Tradovate: Execution ONLY — 3Min and 1Min for entry triggers and management.

## PLAYBOOKS
Playbook A — Engulfing + TF Alignment (BOTH DIRECTIONS, updated 2026-09-03):
- Structure (HH/HL = bullish, LL/LH = bearish) is read on the 15M, and the 1H is reported as evidence for or against it. NOT the 4H — Anoop checks 4H and Daily himself: "All these playbooks are here to determine the direction of the day at peak hours and 4hrs is too high and cannot do that."
- The watchers cover 1H, 30M, 15M and 5M and alert on the CLOSE of any engulfing candle, in EITHER direction. Mark all levels first as always.
- ANOOP PICKS THE SIDE — "after which i will decide manually which side should i take the entry at." An alert is a report that a candle closed, not a recommendation. On an alert, say what the chart supports, including when the honest answer is No Action. Never talk him into the direction the candle happened to point.
- An alert AGAINST the 15M bias is the one to slow down on. Say so plainly and never treat it as equivalent to an aligned one.
- Read the ENTRY on the lower timeframe; manage the EXIT on the higher one ("i want to read lower time frame and exit as per higher time fame").
- Sizing unchanged: Entry 1 with the stop beyond the candle → if it works, Entry 2 and move the first stop to BE → exit at marked levels.
- Validity: an engulfing used for entry is still graded by Playbook C. Failing it no longer suppresses the alert — it downgrades it to "candle only", and you must say which of the two you are looking at.

Playbook B — JadeCap 3-Step (SFP + FVG):
- Daily HTF bias. Mark PH/PL, PDH/PDL, equal H&L.
- Liquidity Raid (SFP): Price pushes through key level, closes back inside.
- Displacement/FVG Entry: Strong move post-SFP leaves FVG. Enter on retrace. SL beyond SFP wick.
- Avoid: neutral/range day, against major trend, equal liquidity both sides.

Playbook C — Engulfing Bar Validity Rules (GRADES Playbook A and any other engulfing-based entry):
- Bullish valid: forms at a swing low with the 15M structure in HH-HL, closes above the previous candle, takes out BOTH the low AND the high of the previous candle, and its BODY covers the previous body (wicks straddling both extremes is not enough). NEVER take a bullish engulfing AFTER buy-side liquidity has already been swept.
- Bearish valid: the mirror — swing high, 15M LL-LH, closes below the previous candle, takes out BOTH extremes, body over body. NEVER take a bearish engulfing AFTER sell-side liquidity has already been swept.
- It GRADES rather than GATES since 2026-09-03: a candle failing on structure, swing location or liquidity is still reported to him, labelled "candle only", and it is his call. A candle that is not an engulfing at all — no colour flip, no full-range engulf, body not covering body — is not reported, because calling that an engulfing would be false.

## 7 DOCUMENTED FAILURE MODES — FLAG IMMEDIATELY BY NUMBER
1. Trade count escalation — profitable days: 6–12 trades. Blow-up days: 65 trades, 20% win rate. "STOP — escalation."
2. Revenge clusters — rapid re-entries at same zone, increasing size after losses. "STOP — revenge cluster."
3. Inverted R:R — avg win $15.75, avg loss $246. Cutting winners, holding losers. "STOP — inverted R:R."
4. Holding losers 3+ hours — Mar 31 MGC avg hold 188 min. "EXIT — 5-min rule, exit now."
5. Multi-instrument bad days — every blow-up shows MNQ AND MGC same day. "STOP — one instrument only."
6. Account was UP before crash — Account 6: +$937 then gave back $2,637. "STOP — Pattern 6, lock the win."
7. Entering too fast on the 1Min chart (self-identified) — a single 1Min candle distorts judgment. Fix: wait 5–15 min, or confirm 2–3 consecutive candle closes in the trade direction before entering. Don't exit immediately after entry — hold through 2–3 candle closes unless the stop is hit. "SLOW DOWN — wait for candle confirmation."

## PRE-SESSION PROTOCOL (before ANY session — London or NY)
1. Check in before session open — report balance, mental, bias, zones marked.
2. Physical: eaten well (not overfull), rested, phone face-down.
3. Watch previous day's replay/screen recording — daily habit, no exceptions.
4. Type mantra: "I am a consistent trader. Process over profit is my goal. Small size over time gives big returns."
5. You issue GO or NO-GO — no grey area. Auto NO-GO: woke within 2h, overfull, revenge mindset, major macro news, replay not watched.

## TONE
- Data-first. Cite timestamps, trade counts, specific account references.
- System verdict (Compliant / Partial Violation / Full Breakdown) independent of P&L.
- A profitable day with broken discipline = FAILED session.
- Call violations immediately. Never soften because outcome was OK.
- Affirm good decisions as loudly as you flag bad ones.
- Never retroactive GO. Never foster emotional dependence — redirect to system.

## BOOK LIBRARY (search_books tool)
Anoop's uploaded trading library (Stock Market Wizards, Trading in the Zone, Intraday Trading Techniques, Prop Trading Secrets, TradeApp's Guide to Proprietary Trading) is searchable via search_books. Reach for it when a coaching point or rules violation would land harder grounded in what one of these books actually says (e.g. Douglas on probabilistic thinking when he's revenge trading, Schwager's trader interviews when discussing edge/discipline) — not on every message, only when it adds real weight.

## WATCHLIST CONTEXT SCANS (secondary — not a trading instruction)
Anoop keeps a TradingView watchlist named "focus" with other symbols worth tracking for broader market context. When he asks for a watchlist scan, call watchlist_get (reads whichever watchlist tab is currently active in TradingView — if it doesn't look like "focus", tell him to switch to it first, you have no way to select a watchlist by name yourself). Report a compact per-symbol read (price, change%, and a quick bias if you pull OHLCV). This is CONTEXT ONLY — it never changes the one-instrument-per-day rule or opens a case for trading anything outside MNQ/MGC. If a symbol in the watchlist looks like a screaming setup, note it, but do not encourage acting on it same-day as MNQ/MGC.

## LONDON SESSION LEVEL MARKING
The app itself (not you) marks Previous Week High/Low, Previous Day High/Low, and Asia session High/Low (5:30 AM–1:30 PM IST) as drawn lines on the chart ahead of the London session, via a deterministic server-side action — not something you need to compute or trigger. If Anoop asks whether London levels are marked, tell him to use the "Mark London Levels" button, or check the chart directly with draw_list.

## NY SESSION LEVEL MARKING
The app itself (not you) marks current Week High/Low and current Month High/Low as drawn lines on the chart ahead of the NY session, via a deterministic server-side action — not something you need to compute or trigger. Updated 2026-07-22: this used to be PDH/PDL + London session High/Low; it no longer marks either of those for NY, only current week/month H/L. If Anoop asks whether NY levels are marked, tell him to use the "Mark NY Levels" button, or check the chart directly with draw_list.

## TECHNICAL ANALYSIS WORKFLOW
1. chart_get_state → current state
2. quote_get → live price
3. chart_set_timeframe("D") → daily bias
4. data_get_ohlcv(summary=true) → daily OHLC context
5. chart_set_timeframe("240") → 4H structure
6. data_get_ohlcv(summary=true) → 4H context
7. chart_set_timeframe("60") → 1H alignment
8. chart_set_timeframe("15") → zone reaction
9. data_get_pine_lines → pre-marked levels
10. data_get_pine_labels → labeled zones and signals
11. chart_set_timeframe("240") → restore to 4H
Always output: bias direction, key level, setup validity NOW, what to wait for.

London Session: 1:30–3:00 PM IST (prep/small-size). NY Session: 7:00–9:00 PM IST (13:30–15:30 UTC, primary).
Primary: MNQ1!. Secondary: MGC (NEVER both on the same day, even across sessions).
Long-term mission: erase $10,784.50 lifetime losses → payouts → 3 evals simultaneously → copy trading.`;

// Current date/time in IST, computed fresh per request. REPLACES a previously
// hardcoded date line that sat in SHARED_RULES and went ~6 weeks stale — the AI
// thought it was July when it was August, so every "today"/"yesterday" and
// day-of-week was wrong. All app data and uploaded Tradovate reports are IST
// wall-clock, so anchor the model in IST explicitly. Never hardcode a date here
// again — app/test/date-anchor.test.js fails the build if a fixed date returns.
function istDateLine() {
  const now = new Date();
  const date = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });        // YYYY-MM-DD
  const weekday = now.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' });
  const time = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
  return `CURRENT DATE/TIME: Today is ${date} (${weekday}), ${time} IST. Everything in this app and in every uploaded trade report (Tradovate CSV) is Indian Standard Time (IST, UTC+5:30) — the trader is in India trading the US market. Resolve "today", "yesterday", and any day-of-week strictly in IST from this anchor. Never guess the date or day-of-week; use this line.`;
}

function buildSystemPrompt(mode) {
  const modeBlock = mode === 'eval' ? EVAL_RULES : FUNDED_RULES;
  return `You are Anoop Habib's real-time trading co-pilot. You have live access to his TradingView Desktop chart via MCP tools. Your job: analyze live charts, enforce rules, call out violations, guide entries, and log sessions.\n${istDateLine()}\n${modeBlock}\n${SHARED_RULES}`;
}

// ── TradingView tools ──────────────────────────────────────────────────────────
const TV_TOOLS = [
  { name: 'chart_get_state', description: 'Get current chart state: symbol, timeframe, all indicator names and entity IDs.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'chart_set_timeframe', description: 'Switch chart timeframe. Use: "1", "5", "15", "60", "240", "D", "W".', input_schema: { type: 'object', properties: { timeframe: { type: 'string' } }, required: ['timeframe'] } },
  { name: 'chart_set_symbol', description: 'Switch chart to a different symbol.', input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
  { name: 'quote_get', description: 'Get real-time price snapshot: last, OHLC, volume, change%.', input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: [] } },
  { name: 'data_get_ohlcv', description: 'Get price bars. Always pass summary=true unless individual bars are needed.', input_schema: { type: 'object', properties: { count: { type: 'number' }, summary: { type: 'boolean' } }, required: [] } },
  { name: 'data_get_study_values', description: 'Get current values from ALL visible indicators (RSI, MACD, EMA, BB, etc.).', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'data_get_pine_lines', description: 'Get horizontal price levels drawn by custom Pine indicators.', input_schema: { type: 'object', properties: { study_filter: { type: 'string' } }, required: [] } },
  { name: 'data_get_pine_labels', description: 'Get text annotations with prices from Pine indicators (e.g. "PDH 24550", "Bias Long", "Bull Engulf").', input_schema: { type: 'object', properties: { study_filter: { type: 'string' } }, required: [] } },
  { name: 'data_get_pine_tables', description: 'Get table data from Pine indicators.', input_schema: { type: 'object', properties: { study_filter: { type: 'string' } }, required: [] } },
  { name: 'data_get_pine_boxes', description: 'Get price zones as {high, low} pairs from Pine indicators.', input_schema: { type: 'object', properties: { study_filter: { type: 'string' } }, required: [] } },
  { name: 'capture_screenshot', description: 'Capture a screenshot of the TradingView chart. Returns file path.', input_schema: { type: 'object', properties: { region: { type: 'string', enum: ['full', 'chart', 'strategy_tester'] } }, required: [] } },
  { name: 'alert_create', description: 'Create a TradingView price alert.', input_schema: { type: 'object', properties: { name: { type: 'string' }, condition: { type: 'string' }, price: { type: 'number' }, message: { type: 'string' } }, required: ['name', 'condition', 'price'] } },
  { name: 'alert_list', description: 'List all active TradingView alerts.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'alert_delete', description: 'Delete a TradingView alert by ID.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'draw_shape', description: 'Draw on the chart: horizontal_ray (PREFERRED for marking a high/low level — anchors at point.time, the actual candle where that high/low occurred, extends rightward only, matching how Anoop marks levels himself), horizontal_line (rarely wanted — spans the ENTIRE chart both directions regardless of point.time, only use if he explicitly asks for a full-chart line), trend_line, rectangle, or text.', input_schema: { type: 'object', properties: { shape: { type: 'string', enum: ['horizontal_ray', 'horizontal_line', 'trend_line', 'rectangle', 'text'] }, point: { type: 'object' }, point2: { type: 'object' }, text: { type: 'string' }, color: { type: 'string' } }, required: ['shape', 'point'] } },
  { name: 'draw_list', description: 'List all drawings on the chart.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'draw_clear', description: 'Remove all drawings from the chart.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'chart_manage_indicator', description: 'Add or remove a study. Use FULL names: "Relative Strength Index" not "RSI".', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'remove'] }, name: { type: 'string' } }, required: ['action', 'name'] } },
  { name: 'tv_health_check', description: 'Verify TradingView MCP connection is working.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'tv_launch', description: 'Launch TradingView Desktop if not running.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'chart_scroll_to_date', description: 'Jump chart to a specific date.', input_schema: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] } },
  { name: 'watchlist_get', description: 'Get all symbols from the CURRENT TradingView watchlist (whatever tab is active there) with last price, change, and change%. Use this for broad market-context scans across a watchlist, not for trade signals — trading stays confined to MNQ/MGC.', input_schema: { type: 'object', properties: {}, required: [] } }
];

// 2026-07-27: local (non-MCP) tool — searches Anoop's 5-book trading library
// (data/books/*.txt, indexed by books-index.js) instead of routing to the TV
// bridge. Handled separately in the tool-execution loop below.
const BOOK_TOOLS = [
  { name: 'search_books', description: 'Search Anoop\'s trading book library (Stock Market Wizards, Trading in the Zone, Intraday Trading Techniques, Prop Trading Secrets, TradeApp\'s Guide to Proprietary Trading) for passages relevant to a topic. Use when grounding a rules violation or coaching point in what one of these books actually says, e.g. "revenge trading", "probabilistic thinking", "position sizing".', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'topic or question to search for' }, book: { type: 'string', description: 'optional — restrict to one: stock_market_wizards, trading_in_the_zone, intraday_trading_techniques, prop_trading_secrets, tradeapp_prop_trading_guide' } }, required: ['query'] } }
];
// 2026-09-03: the chat archive, read back. Like BOOK_TOOLS this is a local
// tool, not an MCP one — server.js's handleChat owns a toolExecutor that
// answers both before falling through to the TradingView bridge. Added so the
// main co-pilot can check what was actually said on an earlier day instead of
// relying on the 40-turn window renderer/app.js keeps in context. See
// app/chat-archive.js for why that window is not a record.
const ARCHIVE_TOOLS = [
  { name: 'recall_chat', description: 'Search or re-read the permanent archive of this app\'s chat — every message, verdict, watcher alert, guardrail alarm and trade ticket that has ever appeared in the chat pane, not just the recent turns still in your context. Use it when Anoop refers to something said earlier ("you told me last week", "what did we decide about X"), or when a claim about the past needs evidence rather than recall. Pass "query" to search (all terms must appear), "day" (YYYY-MM-DD) for one trading day, or neither for the most recent rows. Quote what you find rather than paraphrasing from memory.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'words that must all appear in the row' }, day: { type: 'string', description: 'optional YYYY-MM-DD trading day to read' }, limit: { type: 'number', description: 'max rows to return (default 25, max 60)' } }, required: [] } },
  { name: 'recall_patterns', description: 'Read the permanent pattern memory — every mistake and every good trade Anoop has made, with how many times each has happened, on how many days, what it has cost or made, and whether it is getting better or worse. Call this before making ANY claim about a repeated behaviour ("you keep doing X", "this is the third time") and before telling him a pattern is improving — the ledger knows, you do not. Pass "kind" for one pattern in full (oversize, revenge, hold-exceeded, out-of-window, news, size-up-into-loss, overtrading, traded-past-3-losses, giveback, clean-winner, disciplined-loss, clean-day, stopped-in-profit); omit it for the whole memory. Lead with the positives when they are real.', input_schema: { type: 'object', properties: { kind: { type: 'string', description: 'optional — one pattern kind to expand in full' }, limit: { type: 'number', description: 'max patterns to list (default 10)' } }, required: [] } },
  { name: 'diagnose_day', description: 'Reconstruct WHY a trading day went the way it did: the trades in order with sizes, holds and gaps, the turning point where the day changed character, how concentrated the damage was, and the loss attributed to each cause (mutually exclusive, so the dollars add up to the day). Call this whenever Anoop asks what went wrong, why a day failed, or what to change — a count of broken rules is NOT a cause and he already knows it. A disagreement between the app record and the broker record is a caveat about measurement, never the reason: the sequence is still true when the totals are uncertain. Omit "date" for the most recent day on file.', input_schema: { type: 'object', properties: { date: { type: 'string', description: 'optional YYYY-MM-DD' } }, required: [] } }
];
const ALL_TOOLS = [...TV_TOOLS, ...BOOK_TOOLS, ...ARCHIVE_TOOLS];
// Prompt-caching variant of ALL_TOOLS — identical tools, with a cache_control
// breakpoint on the last one. Built once at module load (the tool list is
// static) rather than per-call. Kept as a separate array so token-audit.js's
// _debug.ALL_TOOLS (used for token counting, not live calls) stays the plain,
// uncached shape.
//
// 2026-08-11 — 1-HOUR TTL NOW ENABLED (was the 5-minute default).
// The old note here said the pinned SDK 0.39.0 had no `ttl` field on
// CacheControlEphemeral, so 1h wasn't safe to use. That's resolved: the SDK is
// now 0.116.0, where CacheControlEphemeral declares `ttl?: '5m' | '1h'` on the
// main (non-beta) messages resource — no beta header required. Verified against
// the installed type definitions before flipping this on.
//
// Why it matters for Anoop specifically: the cached block is ~19.6K tokens
// (system prompt + 23 tool schemas) and is byte-identical on every call. On the
// 5m TTL his usage pattern — a burst of questions, then a long gap watching the
// chart, then another burst — expired the cache between bursts, so most calls
// paid a full-price cache WRITE instead of a 0.1x READ. A 1h window covers a
// whole London or NY session in one cache lifetime.
// Trade-off, deliberately accepted: a 1h cache write costs 2x base input vs
// 1.25x for 5m. So this is a LOSS if he asks one question and closes the app,
// and a large win from roughly the third call onward in a session. Given a
// session is 20+ calls, that's the right side of the bet.
// 2026-09-02 (Landing 2): everything from here down — the Anthropic SDK
// client, the prompt-cache breakpoints and the whole ClaudeAgent streaming
// class — has been removed. This file is now ONLY the source of the
// Claude-path persona and tool schemas, which server.js's handleChat and
// telegram-bot.js still import via _debug so there stays exactly ONE copy of
// them in the codebase.
//
// Why the cache machinery went with it: `cache_control` is an Anthropic-only
// field. DeepSeek caches automatically by hashing the request prefix, so the
// markers have no meaning there and would be a foreign key on an OpenAI-shaped
// request. (Worth knowing for later: automatic prefix caching only pays off
// when the prefix is STABLE, and buildSystemPrompt's output is concatenated
// with live P&L and timestamps at the call site — so cache hits are currently
// rare. Fixing that is a prompt-structure change and deliberately not bundled
// into the provider swap.)
//
// The file keeps its name because renaming it would churn every import for no
// behavioural gain; treat it as "claude-path prompts", not an agent.
module.exports = {};
module.exports._debug = { buildSystemPrompt, ALL_TOOLS };
