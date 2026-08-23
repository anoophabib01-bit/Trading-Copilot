'use strict';
/**
 * call-logger.js — lightweight, append-only log of every real Claude API
 * call this app makes (one line per call in claude-agent.js's runLoop, i.e.
 * every recursive tool-use round trip counts separately, same as the API
 * billing does). Exists to replace the guessed CONFIG.ESTIMATED_CALLS_PER_
 * SESSION / ESTIMATED_SESSIONS_PER_MONTH in token-audit.js with real numbers
 * — read the log with token-usage-report.js once you've used the app for a
 * few real sessions.
 *
 * Deliberately dumb: fs.appendFile, fire-and-forget, swallows its own errors.
 * Never throws, never blocks, never slows down a live trading session — this
 * is observability, not a feature, so a logging failure must be invisible.
 */

const fs = require('fs');
const path = require('path');
const { resolveDataDir } = require('./resolve-data-dir');

// Shares server.js's real DATA_DIR resolution (real trade/account data, not
// checked into the repo — see .gitignore) via resolve-data-dir.js, so usage
// logs land in the same place as everything else this app persists —
// including when a custom dataDir is configured, which the old inline
// existsSync check here used to silently ignore.
const DATA_DIR = resolveDataDir().dir;
const LOG_PATH = path.join(DATA_DIR, 'token-usage.jsonl');

// One counter per process lifetime — resets when the server restarts, which
// in practice means "per trading session" since START CO-PILOT.bat kills and
// relaunches node each time.
let sessionCallCount = 0;
const sessionStartedAt = new Date().toISOString();

function logCall({ mode, usage, stopReason, toolCallCount, latencyMs, provider, model }) {
  sessionCallCount += 1;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      mode: mode || null,
      input_tokens: (usage && usage.input_tokens) || null,
      output_tokens: (usage && usage.output_tokens) || null,
      cache_creation_input_tokens: (usage && usage.cache_creation_input_tokens) || null,
      cache_read_input_tokens: (usage && usage.cache_read_input_tokens) || null,
      stop_reason: stopReason || null,
      tool_call_count: toolCallCount || 0,
      // 2026-08-12 (task #8): wall-clock latency per call, plus provider/model
      // split out of the free-text `mode` field so they can be aggregated.
      // This is the metric that would have caught the free-model failure on
      // 08-10 IMMEDIATELY — those models took 14-20s on a one-word prompt and
      // blew a 90s timeout under real load, and nothing was recording it.
      latency_ms: (typeof latencyMs === 'number' && latencyMs >= 0) ? Math.round(latencyMs) : null,
      provider: provider || null,
      model: model || null,
      session_call_index: sessionCallCount,
    };
    fs.appendFile(LOG_PATH, JSON.stringify(entry) + '\n', () => {});
  } catch (e) {
    // Never let logging break a live trading session.
  }
}

function getSessionStats() {
  return { callsThisSession: sessionCallCount, sessionStartedAt };
}

module.exports = { logCall, getSessionStats, LOG_PATH };
