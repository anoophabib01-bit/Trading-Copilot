#!/usr/bin/env node
'use strict';
// ── Bar puller for the backtest (2026-08-26) ───────────────────────────────
// Snapshots MNQ bars from the live TradingView chart into DATA/bars/ so the
// backtest runs on a fixed, re-runnable input instead of whatever the chart
// happens to be showing.
//
// TWO THINGS IT IS CAREFUL ABOUT, both learned the hard way in this repo:
//
// 1. IT ALWAYS PUTS THE CHART BACK. Original symbol AND timeframe are read
//    first and restored in a finally block, even on error. Leaving Anoop's
//    chart on the wrong timeframe mid-session is a real cost, and
//    `batch_run` is documented in tradingview-mcp/CLAUDE.md as broken for
//    exactly this reason.
// 2. IT WAITS FOR THE SWITCH TO ACTUALLY LAND. chart_set_timeframe returns
//    before the chart has finished switching, so an immediate OHLCV read
//    silently returns bars from the PREVIOUS timeframe — caught live on
//    2026-07-22 (server.js:_getFullBarsUnlocked carries the full note). This
//    polls chart state until the reported resolution matches, then verifies
//    the modal bar spacing of what came back before writing it. A file of
//    60M bars named mnq_30.json would corrupt every number downstream and
//    look completely normal.
//
// Usage: node scripts/pull-bars.js [--tfs 15,30,60,240] [--count 500] [--out <dir>]
// Requires TradingView Desktop running with --remote-debugging-port=9222.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', '..', 'tradingview-mcp', 'src', 'cli', 'index.js');
// 1 and 5 added 2026-08-31: Anoop enters on 15m and 5m and his median gap
// between trades is 6.6 min, so 15m and coarser cannot describe the window
// between an exit and the next entry — the drift backtest built 4 usable pairs
// out of 120 on 15m for exactly that reason.
const EXPECTED_SPACING_MIN = { '1': 1, '5': 5, '15': 15, '30': 30, '60': 60, '240': 240 };

function tv(args) {
  const raw = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000 });
  return JSON.parse(raw);
}

function state() { return tv(['state']); }

function setTfAndVerify(tf, tries = 12) {
  tv(['timeframe', String(tf)]);
  for (let i = 0; i < tries; i++) {
    try {
      const s = state();
      if (String(s.resolution) === String(tf)) return true;
    } catch (e) { /* transient during a switch */ }
  }
  return false;
}

// Modal gap between consecutive bars, in minutes. The independent check that
// what we received is actually the timeframe we asked for.
function modalSpacingMinutes(bars) {
  const counts = new Map();
  for (let i = 1; i < bars.length; i++) {
    const d = Math.round((bars[i].time - bars[i - 1].time) / 60);
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = null, bestN = -1;
  for (const [d, n] of counts) if (n > bestN) { best = d; bestN = n; }
  return best;
}

function main() {
  const argv = process.argv;
  let tfs = ['15', '30', '60', '240'], count = 500;
  let outDir = path.join(__dirname, '..', '..', 'DATA', 'bars');
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--tfs') tfs = argv[++i].split(',');
    else if (argv[i] === '--count') count = parseInt(argv[++i], 10);
    else if (argv[i] === '--out') outDir = argv[++i];
  }

  let original = null;
  try { original = state(); } catch (e) {
    console.error('Cannot reach TradingView on :9222 — is TradingView Desktop running with CDP enabled?');
    process.exit(2);
  }
  console.log(`chart: ${original.symbol} @ ${original.resolution}  (will be restored)`);
  fs.mkdirSync(outDir, { recursive: true });

  const written = [];
  try {
    for (const tf of tfs) {
      if (!setTfAndVerify(tf)) { console.warn(`  ${tf}: chart never reported this timeframe — SKIPPED (not written)`); continue; }
      const d = tv(['ohlcv', '-n', String(count)]);
      const bars = (d && d.bars) || [];
      if (bars.length < 3) { console.warn(`  ${tf}: only ${bars.length} bars — SKIPPED`); continue; }

      const spacing = modalSpacingMinutes(bars);
      const expected = EXPECTED_SPACING_MIN[tf];
      if (expected && spacing !== expected) {
        // Refuse rather than write a mislabelled file. See header note 2.
        console.warn(`  ${tf}: REFUSED — bars are spaced ${spacing}min, expected ${expected}min (chart had not finished switching)`);
        continue;
      }

      const file = path.join(outDir, `mnq_${tf}.json`);
      fs.writeFileSync(file, JSON.stringify({
        symbol: original.symbol, timeframe: tf, pulledAt: new Date().toISOString(),
        bar_count: bars.length, spacingMinutes: spacing, bars,
      }, null, 0), 'utf8');
      const from = new Date(bars[0].time * 1000).toISOString().slice(0, 16);
      const to = new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 16);
      console.log(`  ${tf}: ${bars.length} bars ${from} → ${to} UTC  → ${path.basename(file)}`);
      written.push(tf);
    }
  } finally {
    try {
      tv(['symbol', original.symbol]);
      setTfAndVerify(original.resolution);
      console.log(`restored: ${original.symbol} @ ${original.resolution}`);
    } catch (e) {
      console.error(`!! COULD NOT RESTORE CHART to ${original.symbol} @ ${original.resolution} — set it back manually.`);
    }
  }
  console.log(written.length ? `\nwrote ${written.length} timeframe(s) to ${outDir}` : '\nnothing written');
}

main();
