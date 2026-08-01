'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const mcpBridge = require('./mcp-bridge');
const booksIndex = require('./books-index');
const supercompress = require('./supercompress');

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
Playbook A — 4H Engulfing + TF Alignment:
- Mark all levels. Check 4H: HH/HL = bullish, LL/LH = bearish.
- Wait for engulfing at 1H close. IF WITH 4H → Entry 1 with 1H SL → if profitable, Entry 2 + move SL to BE → exit at marker levels.
- IF AGAINST 4H → NO ACTION.
- Validity check: any engulfing candle used for entry (here or elsewhere) must pass Playbook C before it counts as valid.

Playbook B — JadeCap 3-Step (SFP + FVG):
- Daily HTF bias. Mark PH/PL, PDH/PDL, equal H&L.
- Liquidity Raid (SFP): Price pushes through key level, closes back inside.
- Displacement/FVG Entry: Strong move post-SFP leaves FVG. Enter on retrace. SL beyond SFP wick.
- Avoid: neutral/range day, against major trend, equal liquidity both sides.

Playbook C — Engulfing Bar Validity Rules (gates Playbook A and any other engulfing-based entry):
- Bullish valid: forms at a swing low in an HH-HL pattern, closes above the previous candle on 4H, takes out BOTH the low AND the high of the previous candle. NEVER take a bullish engulfing AFTER buy-side liquidity has already been swept.
- Bearish valid: forms at a swing high in an LL-LH pattern, closes below the previous candle on 4H, takes out BOTH the high AND the low of the previous candle. NEVER take a bearish engulfing AFTER sell-side liquidity has already been swept.

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

Today is 2026-07-02. London Session: 1:30–3:00 PM IST (prep/small-size). NY Session: 7:00–9:00 PM IST (13:30–15:30 UTC, primary).
Primary: MNQ1!. Secondary: MGC (NEVER both on the same day, even across sessions).
Long-term mission: erase $10,784.50 lifetime losses → payouts → 3 evals simultaneously → copy trading.

NOTE TO SELF: "Today is" above is a static string — it will go stale again. When reasoning about dates, prefer the actual current date from context/tools over this hardcoded value if they ever disagree.`;

function buildSystemPrompt(mode) {
  const modeBlock = mode === 'eval' ? EVAL_RULES : FUNDED_RULES;
  return `You are Anoop Habib's real-time trading co-pilot. You have live access to his TradingView Desktop chart via MCP tools. Your job: analyze live charts, enforce rules, call out violations, guide entries, and log sessions.\n${modeBlock}\n${SHARED_RULES}`;
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
const ALL_TOOLS = [...TV_TOOLS, ...BOOK_TOOLS];

class ClaudeAgent {
  constructor() {
    this.client = null;
    this.apiKey = null;
  }

  init(apiKey) {
    this.apiKey = apiKey;
    this.client = new Anthropic({ apiKey });
  }

  isReady() { return !!this.client; }

  async stream(messages, { mode = 'funded', onToken, onToolStart, onToolDone, onDone, onError } = {}) {
    if (!this.client) {
      onError && onError('API key not configured. Please enter your Anthropic API key in Settings.');
      return;
    }

    const systemPrompt = buildSystemPrompt(mode);
    const abortCtrl = new AbortController();

    // 5-minute global timeout — prevents infinite hangs
    const globalTimer = setTimeout(() => {
      abortCtrl.abort();
      onError && onError('Response timed out after 5 minutes. Try a shorter request or check TradingView connection.');
    }, 5 * 60 * 1000);

    const runLoop = async (msgs) => {
      let stream;
      try {
        stream = await this.client.messages.stream({
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          system: systemPrompt,
          tools: ALL_TOOLS,
          messages: msgs
        }, { signal: abortCtrl.signal });
      } catch (e) {
        clearTimeout(globalTimer);
        onError && onError(e.name === 'AbortError' ? 'Request cancelled.' : e.message);
        return;
      }

      let fullText = '';
      let toolUseBlocks = [];
      let currentToolId = null;
      let currentToolName = null;
      let currentToolInputRaw = '';

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            currentToolId   = event.content_block.id;
            currentToolName = event.content_block.name;
            currentToolInputRaw = '';
            onToolStart && onToolStart(currentToolName, currentToolId);
          }
        } else if (event.type === 'content_block_delta') {
          const d = event.delta;
          if (d.type === 'text_delta') {
            fullText += d.text;
            onToken && onToken(d.text);
          } else if (d.type === 'input_json_delta') {
            currentToolInputRaw += d.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolName) {
            let input = {};
            try { input = JSON.parse(currentToolInputRaw || '{}'); } catch {}
            toolUseBlocks.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input });
            currentToolName = null;
            currentToolId   = null;
            currentToolInputRaw = '';
          }
        }
      }

      const finalMsg   = await stream.finalMessage();
      const stopReason = finalMsg.stop_reason;

      if (stopReason === 'tool_use' && toolUseBlocks.length > 0) {
        const assistantContent = finalMsg.content;
        const toolResults = [];

        for (const block of toolUseBlocks) {
          let resultText;
          try {
            if (block.name === 'search_books') {
              const query = (block.input && block.input.query) || '';
              const results = query.trim()
                ? booksIndex.searchBooks(query, { limit: 4, book: (block.input && block.input.book) || null })
                : [];
              resultText = results.length
                ? results.map(r => `[${r.title}]\n${r.text}`).join('\n\n---\n\n')
                : `No passages found for "${query}" in the book library.`;
              if (results.length && supercompress.isReady()) {
                resultText = await supercompress.compress(resultText, query);
              }
            } else {
              const raw = await mcpBridge.callTool(block.name, block.input);
              resultText = (raw && raw.content) ? raw.content.map(c => c.text || '').join('\n') : JSON.stringify(raw);
            }
            onToolDone && onToolDone(block.name, block.id, true, resultText);
          } catch (e) {
            resultText = `Error: ${e.message}`;
            onToolDone && onToolDone(block.name, block.id, false, resultText);
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultText });
        }

        await runLoop([
          ...msgs,
          { role: 'assistant', content: assistantContent },
          { role: 'user', content: toolResults }
        ]);
      } else {
        clearTimeout(globalTimer);
        onDone && onDone(fullText);
      }
    };

    try {
      await runLoop(messages);
    } catch (e) {
      clearTimeout(globalTimer);
      onError && onError(e.message);
    }
  }
}

module.exports = new ClaudeAgent();
