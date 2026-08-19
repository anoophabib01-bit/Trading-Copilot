#!/usr/bin/env node
// ── PO3 mechanical phase-detector backtest (2026-08-17) ─────────────────────
// Anoop: "Build All including... replay_* i want to use its to full
// potential." Minimal, CLI-driven first version (his own choice over a full
// spec pass, given the size a real backtest harness would otherwise be):
// walks a historical date bar-by-bar via TradingView's replay mode and runs
// the SAME computeAmdPhase() function the live PO3 monitor uses — imported
// directly from app/amd-phase.js, not a reimplementation, so this can never
// silently drift from what actually gates a real auto-triggered debate.
//
// SCOPE, STATED HONESTLY:
// - Validates the CORE, novel A/M/D phase-transition logic (computeAmdPhase)
//   against real history. Does NOT reproduce the live 1H-bias classifier
//   (classifyTrendStrength, still inline in app/server.js) — that's a
//   larger extraction not done in this pass. Bias here is a simple closes-
//   trend approximation over the lookback window, clearly logged as such at
//   the top of every run's output. Treat phase CALLS as a real validation of
//   the AMD logic; treat the specific BIAS DIRECTION shown as indicative,
//   not identical to what the live monitor would have said that day.
// - "Session start" here is simply the first bar of the replay run, not the
//   live monitor's actual London/NY IST window detection — you choose the
//   window by which date/how many steps you run, so this is a deliberate
//   simplification for a manual backtest tool, not a bug.
// - ALWAYS calls replay_stop() in a finally block, even on error — must
//   never leave TradingView Desktop stuck in replay mode.
//
// Usage:
//   node scripts/backtest-po3.js --date 2026-07-15 --steps 40 [--symbol MNQ1!] [--opening-bars 4]
//
// Requires: TradingView Desktop running with --remote-debugging-port=9222
// (same requirement as every other tool in this project).

import * as replayCore from '../src/core/replay.js';
import * as chartCore from '../src/core/chart.js';
import * as dataCore from '../src/core/data.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Cross-package require of the SAME pure function app/server.js's live PO3
// monitor uses — see this script's header comment for why that matters.
const { computeAmdPhase } = require('../../app/amd-phase.js');

function parseArgs(argv) {
  const out = { steps: 40, openingBars: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i];
    else if (a === '--steps') out.steps = parseInt(argv[++i], 10);
    else if (a === '--symbol') out.symbol = argv[++i];
    else if (a === '--opening-bars') out.openingBars = parseInt(argv[++i], 10);
  }
  return out;
}

// Deliberately simple: linear direction of closes over the lookback window.
// NOT the live classifyTrendStrength() — see header comment.
function approximateBias(bars) {
  if (!bars || bars.length < 5) return 'unclear';
  const closes = bars.map((b) => b.close);
  const first = closes[0], last = closes[closes.length - 1];
  const range = Math.max(...bars.map((b) => b.high)) - Math.min(...bars.map((b) => b.low));
  if (range <= 0) return 'unclear';
  const movePct = (last - first) / range;
  if (movePct > 0.15) return 'bullish';
  if (movePct < -0.15) return 'bearish';
  return 'unclear';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.date) {
    console.error('Usage: node scripts/backtest-po3.js --date YYYY-MM-DD [--steps 40] [--symbol MNQ1!] [--opening-bars 4]');
    process.exit(1);
  }

  console.log(`[backtest-po3] APPROXIMATE BIAS MODE — see script header. Not the live classifyTrendStrength().`);
  console.log(`[backtest-po3] Starting replay at ${args.date}${args.symbol ? ' on ' + args.symbol : ''}...`);

  let started = false;
  const transitions = [];
  let lastPhase = null;
  let sessionStartUnix = null;

  try {
    if (args.symbol) await chartCore.setSymbol({ symbol: args.symbol });
    await chartCore.setTimeframe({ timeframe: '15' });
    await replayCore.start({ date: args.date });
    started = true;

    for (let i = 0; i < args.steps; i++) {
      await replayCore.step();
      const { bars } = await dataCore.getOhlcv({ count: 60 });
      if (!bars || !bars.length) continue;
      if (sessionStartUnix === null) sessionStartUnix = bars[0].time;

      const bias = approximateBias(bars.slice(-20)); // recent-window bias, cheap proxy for "1H-ish" context
      const res = computeAmdPhase(bars, bias, sessionStartUnix, args.openingBars);
      const lastBar = bars[bars.length - 1];
      const barTime = new Date(lastBar.time * 1000).toISOString();

      if (res.phase !== lastPhase) {
        transitions.push({ step: i + 1, time: barTime, from: lastPhase, to: res.phase, bias, reason: res.reason, close: lastBar.close });
        console.log(`  step ${i + 1} [${barTime}] ${lastPhase || 'none'} -> ${res.phase} (bias=${bias}, close=${lastBar.close}) — ${res.reason}`);
        lastPhase = res.phase;
      }
    }
  } catch (e) {
    console.error('[backtest-po3] error:', e.message);
  } finally {
    if (started) {
      try { await replayCore.stop(); console.log('[backtest-po3] replay stopped, chart returned to realtime.'); }
      catch (e) { console.error('[backtest-po3] FAILED TO STOP REPLAY — check TradingView manually:', e.message); }
    }
  }

  console.log(`\n[backtest-po3] ${transitions.length} phase transition(s) over ${args.steps} steps from ${args.date}:`);
  console.table(transitions.map((t) => ({ step: t.step, time: t.time, from: t.from, to: t.to, bias: t.bias, close: t.close })));
}

main();
