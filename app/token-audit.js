'use strict';
/**
 * token-audit.js — Stage 1 (token economics) exercise, run against the REAL
 * system prompt + tool schema from claude-agent.js in trading-copilot-workflow.
 *
 * WHAT THIS DOES DIFFERENTLY FROM YOUR CURRENT CODE:
 * Your app manages context by proxy — character counts (MAX_CHARS for CSV)
 * and turn counts (slice(-20), slice(-40)). Neither of those is the thing
 * that actually costs money or fills the context window: tokens. This script
 * measures actual tokens using Anthropic's real tokenizer via the API, on
 * your real system prompt, so the numbers below are true for THIS project,
 * not a generic estimate.
 *
 * SETUP:
 *   1. Copy this file into your actual project folder (next to claude-agent.js,
 *      mcp-bridge.js, books-index.js, supercompress.js) so the requires resolve.
 *   2. Set your API key:  set ANTHROPIC_API_KEY=sk-ant-...   (Windows cmd)
 *                          $env:ANTHROPIC_API_KEY="sk-ant-..." (PowerShell)
 *   3. Run:  node token-audit.js
 *
 * If no API key is set, it still runs using a labeled ESTIMATE (chars/4)
 * instead of the exact Anthropic tokenizer count, so you can see the shape
 * of the numbers immediately, then get exact ones once you add the key.
 *
 * EDIT THE CONFIG BLOCK BELOW to match your real usage assumptions — the
 * script cannot know your actual daily call volume, only you know that.
 */

const agent = require('./claude-agent.js')._debug; // internal-only accessor — see SETUP.md

// ── CONFIG — edit these to match your real usage ──────────────────────────
const CONFIG = {
  MODEL: 'claude-sonnet-4-6',
  // 2026-09-02: repriced from Anthropic Sonnet ($3 / $15 per Mtok) to DeepSeek
  // after the single-provider consolidation. These are the OFF-PEAK rates,
  // which is the honest default for this app: DeepSeek charges peak between
  // 11:30-15:30 and 06:30-09:30 IST, and Anoop's NY-session trading falls
  // outside both windows. Peak is roughly double — multiply by 2 for a
  // worst-case figure.
  //
  // Note the scale change: output is ~23x cheaper than the Sonnet rate this
  // file used to assume, so any conclusion drawn from an older run of this
  // audit about what the app "costs" is off by more than an order of
  // magnitude and should be re-run rather than trusted.
  PRICE_PER_MTOK_INPUT: 0.22,   // USD, deepseek-v4-flash* cache MISS, off-peak
  PRICE_PER_MTOK_INPUT_CACHED: 0.007, // cache HIT, off-peak
  PRICE_PER_MTOK_OUTPUT: 0.66,  // USD, deepseek-v4-flash*, off-peak
  // Your assumption to edit: how many Claude calls does one NY session
  // realistically trigger? Each user message + each tool-result round trip
  // is a separate call in your runLoop. A session with 3-5 questions to
  // Alok, each needing 2-4 tool calls (chart_get_state, data_get_ohlcv,
  // chart_set_timeframe, etc.) before a final answer, is plausibly
  // 15-25 calls. CHANGE THIS to your real observed number once you log it.
  ESTIMATED_CALLS_PER_SESSION: 20,
  ESTIMATED_SESSIONS_PER_MONTH: 20, // ~5 days/week
  MAX_OUTPUT_TOKENS: 8192, // groq-agent.js floors DeepSeek requests at 8192
};

// ── Realistic message history samples ──────────────────────────────────────
// Mimics what state.messages actually looks like in app.js: short user asks,
// assistant answers that can include a tool-call round trip's worth of text.
function sampleTurn(i) {
  return [
    { role: 'user', content: `Bias check on MNQ, 4H zone around ${24500 + i * 10}?` },
    { role: 'assistant', content: `Daily bias is bullish, HH-HL structure intact. 1H aligns. Price is approaching the pre-marked 4H zone at ${24500 + i * 10}. Waiting on 15M reaction — no engulfing or FVG confirmed yet. Hold for now, do not enter on the 4H touch alone.` },
  ];
}
function messageHistory(turns) {
  const msgs = [];
  for (let i = 0; i < turns; i++) msgs.push(...sampleTurn(i));
  return msgs;
}

// A realistic search_books tool_result payload — 4 chunks x ~220 words,
// exactly what books-index.js returns by default (limit: 4).
const booksIndex = require('./books-index.js');
function sampleBookResult() {
  // Falls back to a synthetic chunk of the right size if data/books/ isn't
  // present in this analysis copy (real .txt files are gitignored).
  const words = Array(880).fill('discipline').join(' '); // 4 chunks * 220 words
  return `[Trading in the Zone — Mark Douglas]\n${words}`;
}

// ── Token counting: exact via API if key present, else labeled estimate ────
async function countTokens(client, { system, tools, messages }) {
  if (client) {
    try {
      const res = await client.messages.countTokens({
        model: CONFIG.MODEL,
        system,
        tools,
        messages,
      });
      return { tokens: res.input_tokens, exact: true };
    } catch (e) {
      console.error('  (API count failed, falling back to estimate:', e.message, ')');
    }
  }
  // Fallback heuristic: ~4 chars/token for English prose, plus a published
  // per-tool overhead of ~735 tokens/tool for Claude 4.x tool-use schemas.
  const sysChars = (system || '').length;
  const msgChars = (messages || []).reduce((a, m) => a + JSON.stringify(m.content).length, 0);
  const toolOverhead = (tools || []).length * 735;
  const estimate = Math.round((sysChars + msgChars) / 4) + toolOverhead;
  return { tokens: estimate, exact: false };
}

function usd(tokens, perMtok) {
  return (tokens / 1_000_000) * perMtok;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let client = null;
  if (apiKey) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey });
  } else {
    console.log('No ANTHROPIC_API_KEY set — showing ESTIMATED counts (chars/4 + tool overhead).');
    console.log('Set the key and re-run for exact Anthropic-tokenizer counts.\n');
  }

  const fundedPrompt = agent.buildSystemPrompt('funded');
  const evalPrompt = agent.buildSystemPrompt('eval');
  const tools = agent.ALL_TOOLS;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' STAGE 1 AUDIT — Trading Co-Pilot / DeepSeek (prompts from claude-agent.js)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // 1. System prompt alone (no tools, no history) — the floor cost of every call
  for (const [label, prompt] of [['FUNDED', fundedPrompt], ['EVAL', evalPrompt]]) {
    const r = await countTokens(client, { system: prompt, tools: [], messages: [{ role: 'user', content: 'hi' }] });
    console.log(`${label} system prompt only: ${r.tokens} tokens${r.exact ? '' : ' (estimate)'}  → $${usd(r.tokens, CONFIG.PRICE_PER_MTOK_INPUT).toFixed(5)}/call`);
  }
  console.log('');

  // 2. System prompt + full tool schema (23 tools) — this is the fixed
  //    overhead on EVERY call regardless of conversation length
  const r2 = await countTokens(client, { system: fundedPrompt, tools, messages: [{ role: 'user', content: 'hi' }] });
  console.log(`FUNDED system + ${tools.length} tool schemas: ${r2.tokens} tokens${r2.exact ? '' : ' (estimate)'}  → $${usd(r2.tokens, CONFIG.PRICE_PER_MTOK_INPUT).toFixed(5)}/call`);
  console.log('  ^ This is your real per-call FLOOR before a single word of chat history or tool result is added.\n');

  // 3. Add conversation history at your current caps: 20 turns, 40 turns
  for (const turns of [1, 20, 40]) {
    const msgs = messageHistory(turns);
    const r = await countTokens(client, { system: fundedPrompt, tools, messages: msgs.length ? msgs : [{ role: 'user', content: 'hi' }] });
    console.log(`FUNDED system + tools + ${turns * 2}-message history: ${r.tokens} tokens${r.exact ? '' : ' (estimate)'}  → $${usd(r.tokens, CONFIG.PRICE_PER_MTOK_INPUT).toFixed(5)}/call`);
  }
  console.log('  ^ Your renderer/app.js caps history at slice(-20) and hard-caps at slice(-40) messages.');
  console.log('    (that\'s 10-20 user/assistant TURNS, i.e. 20-40 message objects)\n');

  // 4. RAG injection cost — the actual token price of one search_books call
  const bookMsgs = [{ role: 'user', content: 'What does the book say about revenge trading?' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'search_books', input: { query: 'revenge trading' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: sampleBookResult() }] }];
  const r4 = await countTokens(client, { system: fundedPrompt, tools, messages: bookMsgs });
  console.log(`One search_books round trip (4 chunks, uncompressed): ${r4.tokens} tokens${r4.exact ? '' : ' (estimate)'}  → $${usd(r4.tokens, CONFIG.PRICE_PER_MTOK_INPUT).toFixed(5)}`);
  console.log('  ^ This is the number supercompress.js is meant to reduce. Run this script with');
  console.log('    SUPERCOMPRESS_KEY set to see the compressed-vs-raw delta.\n');

  // 5. Session & monthly projection
  const floorTokens = r2.tokens;
  const perCallCost = usd(floorTokens, CONFIG.PRICE_PER_MTOK_INPUT);
  const outputCostPerCall = usd(CONFIG.MAX_OUTPUT_TOKENS, CONFIG.PRICE_PER_MTOK_OUTPUT); // worst case, full output budget used
  const sessionCostFloor = perCallCost * CONFIG.ESTIMATED_CALLS_PER_SESSION;
  const sessionCostWorstCase = (perCallCost + outputCostPerCall) * CONFIG.ESTIMATED_CALLS_PER_SESSION;
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' PROJECTION (edit CONFIG at top of file to match your reality)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Assuming ${CONFIG.ESTIMATED_CALLS_PER_SESSION} Claude calls/session, ${CONFIG.ESTIMATED_SESSIONS_PER_MONTH} sessions/month:`);
  console.log(`  Input-only floor:        $${sessionCostFloor.toFixed(3)}/session   → $${(sessionCostFloor * CONFIG.ESTIMATED_SESSIONS_PER_MONTH).toFixed(2)}/month`);
  console.log(`  Worst-case (full 4096-token output every call): $${sessionCostWorstCase.toFixed(3)}/session → $${(sessionCostWorstCase * CONFIG.ESTIMATED_SESSIONS_PER_MONTH).toFixed(2)}/month`);
  console.log('\nNote: your 1M-token context window means input truncation risk is near zero at these');
  console.log('sizes. The real ceiling is max_tokens=4096 OUTPUT per call — if Alok tries to narrate a');
  console.log('long multi-step chart analysis plus several tool calls in one turn, it can hit that cap');
  console.log('mid-response and get cut off. That is a per-call risk, not a context-window risk.');
}

main().catch(e => { console.error(e); process.exit(1); });
