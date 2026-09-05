'use strict';
/**
 * token-usage-report.js — reads DATA/token-usage.jsonl (written by
 * call-logger.js, one line per real API call) and prints real
 * calls/session and calls/day numbers, so CONFIG.ESTIMATED_CALLS_PER_SESSION
 * and CONFIG.ESTIMATED_SESSIONS_PER_MONTH in token-audit.js can be measured
 * instead of guessed.
 *
 * Run after a few real trading sessions:
 *   node token-usage-report.js
 */

const fs = require('fs');
const path = require('path');
const { LOG_PATH } = require('./call-logger');

function loadEntries() {
  if (!fs.existsSync(LOG_PATH)) return [];
  return fs.readFileSync(LOG_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// A "session" = a run of calls with no gap longer than SESSION_GAP_MIN
// between them. This app restarts node per trading session (START CO-PILOT.bat
// kills/relaunches), but the log persists across restarts, so gap-based
// session grouping is more reliable than "since process start."
const SESSION_GAP_MIN = 45;

function groupIntoSessions(entries) {
  const sessions = [];
  let current = null;
  for (const e of entries) {
    const t = new Date(e.ts).getTime();
    if (!current || (t - current.lastTs) / 60000 > SESSION_GAP_MIN) {
      current = { calls: [], lastTs: t };
      sessions.push(current);
    }
    current.calls.push(e);
    current.lastTs = t;
  }
  return sessions;
}

function main() {
  const entries = loadEntries();
  if (!entries.length) {
    console.log(`No usage data yet at ${LOG_PATH}.`);
    console.log('Use the app for at least one real session, then re-run this.');
    return;
  }

  const sessions = groupIntoSessions(entries);
  const totalInput = entries.reduce((a, e) => a + (e.input_tokens || 0), 0);
  const totalOutput = entries.reduce((a, e) => a + (e.output_tokens || 0), 0);
  const totalCacheWrite = entries.reduce((a, e) => a + (e.cache_creation_input_tokens || 0), 0);
  const totalCacheRead = entries.reduce((a, e) => a + (e.cache_read_input_tokens || 0), 0);
  const callsWithCacheRead = entries.filter(e => (e.cache_read_input_tokens || 0) > 0).length;
  const days = new Set(entries.map(e => e.ts.slice(0, 10))).size;

  // Gap between consecutive calls WITHIN a session (not across session
  // boundaries) — directly answers the question the deferred tool-scoping
  // TODO depends on: are calls typically inside the 5-min cache TTL, or do
  // they mostly miss it? See TODOS.md "Revisit per-turn tool-scoping".
  const CACHE_TTL_MIN = 5;
  const gapsMin = [];
  for (const s of sessions) {
    for (let i = 1; i < s.calls.length; i++) {
      gapsMin.push((new Date(s.calls[i].ts).getTime() - new Date(s.calls[i - 1].ts).getTime()) / 60000);
    }
  }
  const avgGapMin = gapsMin.length ? gapsMin.reduce((a, b) => a + b, 0) / gapsMin.length : null;
  const withinTtlPct = gapsMin.length ? (gapsMin.filter(g => g <= CACHE_TTL_MIN).length / gapsMin.length) * 100 : null;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' REAL USAGE REPORT — from', LOG_PATH);
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`Total logged calls:   ${entries.length}`);
  console.log(`Distinct days used:   ${days}`);
  console.log(`Sessions detected:    ${sessions.length}  (gap > ${SESSION_GAP_MIN}min = new session)\n`);

  const callsPerSession = sessions.map(s => s.calls.length);
  const avgCallsPerSession = callsPerSession.reduce((a, b) => a + b, 0) / sessions.length;
  const maxCallsPerSession = Math.max(...callsPerSession);

  console.log(`Avg calls/session:    ${avgCallsPerSession.toFixed(1)}`);
  console.log(`Max calls/session:    ${maxCallsPerSession}`);
  console.log(`Avg sessions/day:     ${(sessions.length / days).toFixed(1)}\n`);

  console.log(`Total input tokens logged:  ${totalInput.toLocaleString()}`);
  console.log(`Total output tokens logged: ${totalOutput.toLocaleString()}\n`);

  console.log('── Prompt caching (added 2026-08-03) ────────────────────────');
  if (totalCacheWrite === 0 && totalCacheRead === 0) {
    console.log('  No cache activity logged yet — either caching is off (kill switch on)');
    console.log('  or no calls have run since it was enabled. Re-run after a live session.\n');
  } else {
    const hitRate = entries.length ? (callsWithCacheRead / entries.length) * 100 : 0;
    // 2026-09-02: these two counters are Anthropic-shaped
    // (cache_creation_input_tokens / cache_read_input_tokens). DeepSeek does
    // not report them, so on the current provider they read 0 — that is the
    // API being silent, NOT evidence that caching is off.
    console.log(`  Cache write tokens: ${totalCacheWrite.toLocaleString()}  (Anthropic-only counter — DeepSeek does not report this)`);
    console.log(`  Cache read tokens:  ${totalCacheRead.toLocaleString()}  (Anthropic-only counter — DeepSeek does not report this)`);
    console.log(`  NOTE: DeepSeek caches automatically by hashing the request prefix, with no`);
    console.log(`        markers and no usage counters. Cache hits bill at ~$0.007/Mtok vs $0.22`);
    console.log(`        on a miss. This app's system prompt currently embeds live P&L and`);
    console.log(`        timestamps, so the prefix changes every turn and hits are rare.`);
    console.log(`  Calls with a cache hit: ${callsWithCacheRead}/${entries.length} (${hitRate.toFixed(0)}%)`);
    if (avgGapMin != null) {
      console.log(`  Avg gap between calls in a session: ${avgGapMin.toFixed(1)} min (${withinTtlPct.toFixed(0)}% of gaps ≤ ${CACHE_TTL_MIN}min cache TTL)`);
      console.log(`  ^ This is the number that decides the deferred tool-scoping TODO: if most gaps`);
      console.log(`    are well inside the TTL, caching alone likely covers the token-cost problem.`);
    }
    console.log('');
  }

  console.log('── Suggested CONFIG for token-audit.js ─────────────────────');
  console.log(`  ESTIMATED_CALLS_PER_SESSION: ${Math.round(avgCallsPerSession)},`);
  console.log(`  ESTIMATED_SESSIONS_PER_MONTH: ${Math.round((sessions.length / days) * 20)}, // scaled to a ~20 trading-day month`);
}

main();
