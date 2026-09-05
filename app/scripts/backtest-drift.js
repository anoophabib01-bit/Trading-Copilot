'use strict';
/* ── backtest-drift.js — does the post-exit drift score predict the next trade? ─
 *
 * (2026-08-31, Anoop: "everything here has to be tested against whether your
 * next trade actually wins.")
 *
 * Rebuilds the exit-drift score retrospectively for every consecutive pair of
 * trades in his real history, then asks drift-edge.js whether the score
 * separates winners from losers.
 *
 * ── TIMEFRAME IS NOT A DETAIL HERE ──────────────────────────────────────────
 * The score is computed from bars, so it MEANS something different on every
 * timeframe: ATR differs, the 0.5-ATR threshold differs, and the number of bars
 * between two trades differs. Pooling timeframes would average three different
 * questions into one meaningless answer.
 *
 * So this runs SEPARATELY per timeframe and reports each on its own, and it
 * refuses to run a timeframe whose bars are coarser than the gaps being
 * measured: if he re-entered 4 minutes after an exit, a 60-minute bar cannot
 * describe what happened in between. That check is `--min-bars`, and dropping
 * below it is reported as skipped rather than silently included — a pair scored
 * from one straddling bar is not evidence, it is a rounding error.
 *
 *   node scripts/backtest-drift.js
 *   node scripts/backtest-drift.js --bars DATA/bars --json
 */
const fs = require('fs');
const path = require('path');
const ED = require('../exit-drift');
const DE = require('../drift-edge');
const LS = require('../lifetime-store');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'DATA');

function args(argv) {
  const o = { bars: path.join(DATA, 'bars'), json: false, minBars: 2, symbol: 'mnq' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bars') o.bars = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--min-bars') o.minBars = Number(argv[++i]) || 2;
    else if (a === '--symbol') o.symbol = String(argv[++i] || 'mnq').toLowerCase();
  }
  return o;
}

const toMs = (v) => (v == null ? null : (v < 1e12 ? v * 1000 : v));

/** Load one timeframe's bars, normalised to {t,h,l,c}. */
function loadBars(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = Array.isArray(d) ? d : (d.bars || []);
    return raw.map((b) => ({
      t: toMs(b.t != null ? b.t : b.time),
      h: Number(b.h != null ? b.h : b.high),
      l: Number(b.l != null ? b.l : b.low),
      c: Number(b.c != null ? b.c : b.close),
    })).filter((b) => b.t && Number.isFinite(b.c)).sort((a, b) => a.t - b.t);
  } catch { return []; }
}

/** Every real trade, chronological, that carries what the score needs. */
function loadTrades() {
  const lt = LS.buildLifetime(DATA);
  const rows = [];
  Object.keys(lt.trades || {}).sort().forEach((date) => {
    (lt.trades[date] || []).forEach((t) => {
      if (!t) return;
      rows.push(Object.assign({}, t, { date, x: toMs(t.x), t: toMs(t.t) }));
    });
  });
  // Fold-derived rows have no exit price; they cannot anchor a drift and must
  // not quietly become pairs. Counted so the coverage report is honest.
  const usable = rows.filter((r) => r.xp != null && r.x != null);
  return { all: rows, usable: usable.sort((a, b) => (a.x || 0) - (b.x || 0)), dropped: rows.length - usable.length };
}

function runTimeframe(label, bars, trades, minBars) {
  const scored = [];
  let skippedNoBars = 0, skippedRefused = 0, crossDay = 0;

  for (let i = 0; i < trades.length - 1; i++) {
    const a = trades[i], b = trades[i + 1];
    if (a.date !== b.date) { crossDay++; continue; }
    const entryMs = b.t || b.x;
    if (!a.x || !entryMs || entryMs <= a.x) { skippedNoBars++; continue; }

    // Bars strictly between his exit and his NEXT entry — that is the window
    // the score would actually have been standing on when he took the trade.
    const between = bars.filter((bar) => bar.t > a.x && bar.t <= entryMs);
    if (between.length < minBars) { skippedNoBars++; continue; }

    // ATR from a trailing window on the SAME timeframe, so the threshold and
    // the drift are always measured in the same units.
    const priorIdx = bars.findIndex((bar) => bar.t > a.x);
    const prior = bars.slice(Math.max(0, priorIdx - 15), Math.max(1, priorIdx));
    const atr = ED.atrFromBars(prior.concat(between), 14);

    const d = ED.computeExitDrift({
      lastTrade: a, bars: between, atr, nowMs: entryMs,
      cfg: { cooldownMinutes: 0 },   // backtest measures the signal, not the UI gate
    });
    if (!d.strength) { skippedRefused++; continue; }
    scored.push({ score: d.strength.score, trade: b });
  }

  const pairs = scored.map((s) => ({
    score: s.score,
    nextWin: Number(s.trade.pnl) > 0,
    nextPnl: Number(s.trade.pnl),
    nextPnlPerContract: Math.round((Number(s.trade.pnl) / (Number(s.trade.size) || 1)) * 100) / 100,
    date: s.trade.date,
  }));

  return {
    timeframe: label,
    barSpan: bars.length ? [new Date(bars[0].t).toISOString().slice(0, 10), new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)] : null,
    barCount: bars.length,
    pairsBuilt: pairs.length,
    skippedNoBars, skippedRefused, crossDay,
    edge: DE.evaluateDriftEdge(pairs),
  };
}

function main() {
  const o = args(process.argv);
  const { usable, dropped, all } = loadTrades();

  // Gap distribution first: it decides which timeframes can answer at all.
  const gaps = [];
  for (let i = 0; i < usable.length - 1; i++) {
    const a = usable[i], b = usable[i + 1];
    if (a.date !== b.date) continue;
    const g = ((b.t || b.x) - a.x) / 60000;
    if (g > 0) gaps.push(g);
  }
  gaps.sort((x, y) => x - y);
  const median = gaps.length ? gaps[gaps.length >> 1] : null;

  const files = fs.existsSync(o.bars) ? fs.readdirSync(o.bars).filter((f) => f.startsWith(o.symbol + '_') && f.endsWith('.json')) : [];
  const results = files.map((f) => {
    const label = f.replace(/^.*?_/, '').replace(/\.json$/, '');
    return runTimeframe(label, loadBars(path.join(o.bars, f)), usable, o.minBars);
  });

  const report = {
    tradesTotal: all.length,
    tradesUsable: usable.length,
    tradesDroppedNoExitPrice: dropped,
    medianGapMinutes: median == null ? null : Math.round(median * 10) / 10,
    timeframes: results,
  };

  if (o.json) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log('\n  POST-EXIT DRIFT — RETROSPECTIVE');
  console.log('  ' + '-'.repeat(66));
  console.log('  trades on record      : ' + all.length);
  console.log('  usable (have exit px) : ' + usable.length + '   dropped (fold-only): ' + dropped);
  console.log('  median gap between    : ' + (median == null ? 'n/a' : Math.round(median * 10) / 10 + ' min'));
  console.log('\n  A timeframe can only describe the gap if its bars are SHORTER than it.');
  results.forEach((r) => {
    console.log('\n  [' + r.timeframe + ']  ' + r.barCount + ' bars  '
      + (r.barSpan ? r.barSpan[0] + ' -> ' + r.barSpan[1] : 'none'));
    console.log('    pairs built ' + r.pairsBuilt
      + '   skipped: no-bars ' + r.skippedNoBars + ', score-refused ' + r.skippedRefused + ', cross-day ' + r.crossDay);
    console.log('    ' + r.edge.verdict + ' — ' + r.edge.summary);
    r.edge.buckets.forEach((b) => {
      console.log('      ' + b.label.padEnd(16) + ' n=' + String(b.n).padStart(3)
        + (b.winRate != null
          ? '  win ' + Math.round(b.winRate * 100) + '%  ci ' + Math.round(b.ci.lo * 100) + '-' + Math.round(b.ci.hi * 100) + '%  exp $' + b.expectancy
          : '  ' + (b.note || '')));
    });
  });
  console.log('');
}

main();
