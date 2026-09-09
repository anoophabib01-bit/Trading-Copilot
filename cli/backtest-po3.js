'use strict';
// ── backtest-po3.js — base rates for the PO3 phase detector ─────────────────
//
//   node cli/backtest-po3.js                       # MNQ, 15m, first hour = range
//   node cli/backtest-po3.js --symbol MGC=F
//   node cli/backtest-po3.js --interval 5m --opening-bars 12
//   node cli/backtest-po3.js --json
//
// ── WHAT THIS ANSWERS ──────────────────────────────────────────────────────
// app/amd-phase.js decides, mechanically, whether a session is ACCUMULATING,
// being MANIPULATED, or DISTRIBUTING. Its DISTRIBUTION call is flagged in its
// own source as "ENTRY-RELEVANT: this is the reversal out of manipulation" —
// and on that call the app can auto-trigger a debate whose Judge can emit a
// real TRADE_TICKET.
//
// Nobody has ever counted how often that call is followed by the move it
// implies. This script counts it, across every session in the local corpus.
// The output is a FREQUENCY, not an opinion: of N sessions where the detector
// reached DISTRIBUTION, price went on to make X points in favour before it
// made Y against, this often.
//
// ── HOW IT RELATES TO THE EXISTING BACKTEST ────────────────────────────────
// tradingview-mcp/scripts/backtest-po3.js already imports the same
// computeAmdPhase(), and that is deliberate — there must never be a second
// implementation of the phase logic. But it drives TradingView Desktop through
// replay mode, so it needs the app running, needs a CDP connection, and does
// ONE date per invocation. This runs offline against cli/corpus/, so it can do
// every session at once and produce a distribution rather than an anecdote.
//
// ── THE BIAS CAVEAT — READ THIS BEFORE TRUSTING A NUMBER ───────────────────
// computeAmdPhase()'s hard gate is a 1H bias direction; without 'bullish' or
// 'bearish' every call is UNCLEAR. The LIVE bias comes from
// classifyTrendStrength(), which is still inline in app/server.js (~line 7269)
// and is not exported — importing it would boot the whole server, its
// WebSocket, its monitors and the MCP bridge.
//
// So bias here is approximated, using THE SAME formula as the existing
// TradingView backtest (a closes-direction read over a lookback window),
// copied rather than reinvented so the repo has two bias approximations and
// not three. One improvement over that script: it applies the formula to the
// same timeframe it is walking and calls that "1H-ish"; this applies it to
// REAL 1H bars from the corpus, which is what the gate actually specifies.
//
// The consequence, stated plainly: treat the PHASE-TRANSITION counts as a
// genuine measurement of the AMD logic, and treat the BIAS-DEPENDENT outcome
// rates as indicative. They will not match live behaviour exactly until
// classifyTrendStrength() is extracted from server.js the way amd-phase.js
// was. That extraction is the obvious next step and is not done here.

const fs = require('node:fs');
const path = require('node:path');
const { computeAmdPhase } = require('../app/amd-phase');
const { fileFor, readExisting } = require('./corpus-pull');
const { sessionize, percentileOf, mean } = require('./market-brief');
const Y = require('./yahoo');

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : Number(v.toFixed(d)));

// Copied verbatim from tradingview-mcp/scripts/backtest-po3.js so the two
// backtests agree. NOT the live classifyTrendStrength() — see header.
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

function loadCorpus(symbol, interval) {
  const file = fileFor(symbol, interval);
  if (!fs.existsSync(file)) {
    throw new Error('no corpus for ' + symbol + ' ' + interval
      + '. Run: node cli/corpus-pull.js --symbol "' + symbol + '" --interval ' + interval);
  }
  return [...readExisting(file).values()].sort((a, b) => a.t - b.t);
}

// amd-phase.js expects {time, high, low, close}; the corpus stores {t,o,h,l,c,v}.
const toAmd = (b) => ({ time: b.t, high: b.h, low: b.l, close: b.c, open: b.o });

function runSession(session, biasBars, openingBars, spec) {
  const rth = session.rth.slice().sort((a, b) => a.t - b.t);
  if (rth.length < openingBars + 3) return null;

  const bias = approximateBias(biasBars.map(toAmd));
  const sessionStart = rth[0].t;
  const amdBars = rth.map(toAmd);

  // Walk the session forward, exactly as the live monitor polls it: at each
  // step the detector sees only the bars that had printed by then. Anything
  // else would be lookahead.
  const transitions = [];
  let lastPhase = null;
  let firstDistIdx = -1;

  for (let i = 2; i <= amdBars.length; i++) {
    const res = computeAmdPhase(amdBars.slice(0, i), bias, sessionStart, openingBars);
    if (res.phase !== lastPhase) {
      transitions.push({ idx: i - 1, t: rth[i - 1].t, from: lastPhase, to: res.phase });
      if (res.phase === 'DISTRIBUTION' && firstDistIdx === -1) firstDistIdx = i - 1;
      lastPhase = res.phase;
    }
  }

  const out = {
    day: session.day, bias, finalPhase: lastPhase,
    bars: rth.length, transitions: transitions.length,
    path: transitions.map((t) => t.to).join('>'),
    sweptThenReclaimed: transitions.some((t) => t.from === 'MANIPULATION' && t.to === 'DISTRIBUTION'),
    entry: null,
  };

  // Did the FIRST DISTRIBUTION arrive out of a completed manipulation trap?
  // This split is the whole point. amd-phase.js flags only one of its two
  // routes into DISTRIBUTION as "ENTRY-RELEVANT: this is the reversal out of
  // manipulation". The other route — range broken WITH bias, no counter-sweep
  // first — carries the reason "distributing, but no manipulation trap was
  // set" and is explicitly not that setup. Pooling them measures a signal the
  // app never claimed to have.
  const idxOfFirstDist = transitions.findIndex((t) => t.to === 'DISTRIBUTION');
  out.viaTrap = idxOfFirstDist > 0
    && transitions[idxOfFirstDist].from === 'MANIPULATION';

  // Forward outcome from the first DISTRIBUTION call — the bar on which the
  // live app would have had an ENTRY-RELEVANT signal in hand.
  if (firstDistIdx >= 0 && firstDistIdx < rth.length - 1) {
    const entryBar = rth[firstDistIdx];
    const forward = rth.slice(firstDistIdx + 1);
    const long = bias === 'bullish';
    const entry = entryBar.c;

    let mfe = 0, mae = 0;
    for (const b of forward) {
      const up = b.h - entry, down = entry - b.l;
      const fav = long ? up : down;
      const adv = long ? down : up;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;
    }
    const exit = forward[forward.length - 1].c;
    const pnlPts = long ? exit - entry : entry - exit;

    out.entry = {
      viaTrap: out.viaTrap,
      atBar: firstDistIdx, at: Y.fmtBoth(entryBar.t),
      price: round(entry, 2), side: long ? 'long' : 'short',
      barsRemaining: forward.length,
      mfe: round(mfe, 2), mae: round(mae, 2),
      mfeUsd: round(mfe / spec.tick * spec.tickValue, 0),
      maeUsd: round(mae / spec.tick * spec.tickValue, 0),
      closePnl: round(pnlPts, 2),
      closePnlUsd: round(pnlPts / spec.tick * spec.tickValue, 0),
    };
  }
  return out;
}

// ── R-multiple base rates ──────────────────────────────────────────────────
// For a stop of R points, did MFE reach k*R before MAE reached R? MFE and MAE
// are bar extremes and carry no ordering, so a session where BOTH were hit is
// counted as a LOSS. That is the pessimistic assumption and it is the correct
// one to make: assuming the target filled first would inflate every number
// here, and this file exists to produce something trustworthy.
function baseRates(entries, rPoints, multiples) {
  const rows = [];
  for (const k of multiples) {
    let win = 0, loss = 0, ambiguous = 0;
    for (const e of entries) {
      const hitTarget = e.mfe >= k * rPoints;
      const hitStop = e.mae >= rPoints;
      if (hitTarget && !hitStop) win++;
      else if (hitStop) { loss++; if (hitTarget) ambiguous++; }
      else loss++; // neither hit: closed inside the band, treated as not-a-win
    }
    const n = entries.length;
    rows.push({
      target: k + 'R', rPoints,
      wins: win, losses: loss, n,
      winRate: n ? Math.round((win / n) * 100) : null,
      ambiguous,
      expectancyR: n ? round(((win * k) - (loss * 1)) / n, 2) : null,
    });
  }
  return rows;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

  const symbol = flag('--symbol', 'MNQ=F');
  const interval = flag('--interval', '15m');
  const openingBars = parseInt(flag('--opening-bars', '4'), 10);
  const spec = Object.values(Y.SYMBOLS).find((s) => s.y === symbol)
    || { label: symbol, tick: 0.25, tickValue: 0.5 };

  const bars = loadCorpus(symbol, interval);
  const hourly = loadCorpus(symbol, '1h');
  const sessions = [...sessionize(bars).values()]
    .filter((s) => s.rth.length > 0)
    .sort((a, b) => a.day.localeCompare(b.day));

  const results = [];
  for (const s of sessions) {
    const open = s.rth[0].t;
    // The 20 completed 1H bars before the bell — the gate's own timeframe.
    const biasBars = hourly.filter((h) => h.t < open).slice(-20);
    const r = runSession(s, biasBars, openingBars, spec);
    if (r) results.push(r);
  }

  const gated = results.filter((r) => r.bias === 'unclear');
  const judged = results.filter((r) => r.bias !== 'unclear');
  const entries = judged.filter((r) => r.entry).map((r) => r.entry);

  // Stop distance: the median MAE across signals is a defensible, data-derived
  // R rather than a number picked to make the table look good.
  const maes = entries.map((e) => e.mae).sort((a, b) => a - b);
  const medMae = maes.length ? maes[Math.floor(maes.length / 2)] : 0;
  const rPoints = round(Math.max(medMae, 1), 1);

  const report = {
    symbol, interval, openingBars,
    corpus: {
      bars: bars.length, sessions: results.length,
      from: results[0] && results[0].day, to: results[results.length - 1] && results[results.length - 1].day,
    },
    biasGate: {
      judged: judged.length, unclear: gated.length,
      unclearPct: results.length ? Math.round((gated.length / results.length) * 100) : null,
    },
    phasePaths: (() => {
      const counts = {};
      for (const r of judged) counts[r.path] = (counts[r.path] || 0) + 1;
      return Object.entries(counts).sort((a, b) => b[1] - a[1])
        .map(([path, n]) => ({ path, n, pct: Math.round((n / judged.length) * 100) }));
    })(),
    trapRate: {
      sessions: judged.length,
      sweptThenReclaimed: judged.filter((r) => r.sweptThenReclaimed).length,
      pct: judged.length
        ? Math.round((judged.filter((r) => r.sweptThenReclaimed).length / judged.length) * 100) : null,
    },
    signals: {
      n: entries.length,
      ofJudged: judged.length ? Math.round((entries.length / judged.length) * 100) : null,
      medianMfe: entries.length ? round(maes.length ? entries.map((e) => e.mfe).sort((a, b) => a - b)[Math.floor(entries.length / 2)] : 0, 2) : null,
      medianMae: round(medMae, 2),
      meanClosePnl: entries.length ? round(mean(entries.map((e) => e.closePnl)), 2) : null,
      meanClosePnlUsd: entries.length ? round(mean(entries.map((e) => e.closePnlUsd)), 0) : null,
    },
    baseRates: entries.length ? baseRates(entries, rPoints, [1, 1.5, 2, 3]) : [],
    segmented: {
      trap: (() => {
        const e = entries.filter((x) => x.viaTrap);
        // Each segment is scored against ITS OWN median adverse excursion. A
        // pooled stop would be far too wide for the trap route (median MAE
        // 48.5) and far too tight for the other (130.75), which flatters one
        // and punishes the other for reasons that have nothing to do with
        // whether the setup works.
        const segR = e.length
          ? Math.max(round(e.map((x) => x.mae).sort((a, b) => a - b)[Math.floor(e.length / 2)], 1), 1) : 1;
        return { n: e.length, stop: segR, rates: e.length ? baseRates(e, segR, [1, 1.5, 2]) : [],
          medianMfe: e.length ? round(e.map((x) => x.mfe).sort((a, b) => a - b)[Math.floor(e.length / 2)], 2) : null,
          medianMae: e.length ? round(e.map((x) => x.mae).sort((a, b) => a - b)[Math.floor(e.length / 2)], 2) : null,
          meanClosePnl: e.length ? round(mean(e.map((x) => x.closePnl)), 2) : null };
      })(),
      noTrap: (() => {
        const e = entries.filter((x) => !x.viaTrap);
        const segR = e.length
          ? Math.max(round(e.map((x) => x.mae).sort((a, b) => a - b)[Math.floor(e.length / 2)], 1), 1) : 1;
        return { n: e.length, stop: segR, rates: e.length ? baseRates(e, segR, [1, 1.5, 2]) : [],
          medianMfe: e.length ? round(e.map((x) => x.mfe).sort((a, b) => a - b)[Math.floor(e.length / 2)], 2) : null,
          medianMae: e.length ? round(e.map((x) => x.mae).sort((a, b) => a - b)[Math.floor(e.length / 2)], 2) : null,
          meanClosePnl: e.length ? round(mean(e.map((x) => x.closePnl)), 2) : null };
      })(),
    },
    sessionsDetail: results,
  };

  if (argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return; }

  const L = [];
  const bar = '─'.repeat(70);
  L.push('');
  L.push('  PO3 BASE RATES — ' + spec.label + ' ' + interval
    + '   opening range = ' + openingBars + ' bars');
  L.push('  corpus ' + report.corpus.bars.toLocaleString() + ' bars, '
    + report.corpus.sessions + ' sessions, ' + report.corpus.from + ' -> ' + report.corpus.to);
  L.push(bar);
  L.push('  BIAS GATE');
  L.push('    judged  ' + report.biasGate.judged
    + '    unclear (gate blocked) ' + report.biasGate.unclear
    + '  (' + report.biasGate.unclearPct + '% of sessions)');
  L.push('');
  L.push('  PHASE PATHS  (judged sessions only)');
  for (const p of report.phasePaths.slice(0, 8)) {
    L.push('    ' + String(p.n).padStart(3) + '  ' + String(p.pct + '%').padStart(4) + '   ' + p.path);
  }
  L.push('');
  L.push('  MANIPULATION -> DISTRIBUTION (the trap completing)');
  L.push('    ' + report.trapRate.sweptThenReclaimed + ' of ' + report.trapRate.sessions
    + ' sessions  (' + report.trapRate.pct + '%)');
  L.push('');
  L.push('  ENTRY-RELEVANT SIGNALS');
  L.push('    ' + report.signals.n + ' sessions reached DISTRIBUTION with room left to trade ('
    + report.signals.ofJudged + '% of judged)');
  L.push('    median MFE ' + report.signals.medianMfe + ' pts     median MAE '
    + report.signals.medianMae + ' pts');
  L.push('    mean P&L holding to session close: ' + report.signals.meanClosePnl
    + ' pts  ($' + report.signals.meanClosePnlUsd + '/contract)');
  L.push('');
  if (report.baseRates.length) {
    L.push('  BASE RATES   stop = ' + rPoints + ' pts (median adverse excursion)');
    L.push('    target   win rate      wins/losses     expectancy');
    for (const r of report.baseRates) {
      L.push('    ' + String(r.target).padEnd(9) + String(r.winRate + '%').padEnd(14)
        + String(r.wins + '/' + r.losses).padEnd(16) + r.expectancyR + 'R');
    }
    L.push('');
    L.push('    A session where BOTH target and stop were touched counts as a LOSS —');
    L.push('    bar extremes carry no ordering, so the pessimistic read is the only');
    L.push('    honest one. ' + report.baseRates[0].ambiguous + ' of ' + report.signals.n
      + ' signals were ambiguous in that way.');
  }
  L.push('');
  L.push('  SPLIT BY ROUTE INTO DISTRIBUTION');
  for (const [key, label] of [['trap', 'VIA MANIPULATION TRAP  (the ENTRY-RELEVANT case)'],
                              ['noTrap', 'NO TRAP — range broke with bias, no counter-sweep']]) {
    const seg = report.segmented[key];
    L.push('');
    L.push('    ' + label);
    if (!seg.n) { L.push('      no signals'); continue; }
    L.push('      n=' + seg.n + '   median MFE ' + seg.medianMfe
      + '   median MAE ' + seg.medianMae
      + '   mean close P&L ' + seg.meanClosePnl + ' pts');
    L.push('      stop for this segment = ' + seg.stop + ' pts (its own median MAE)');
    for (const r of seg.rates) {
      L.push('      ' + String(r.target).padEnd(7) + String(r.winRate + '%').padEnd(8)
        + String(r.wins + '/' + r.losses).padEnd(10) + r.expectancyR + 'R');
    }
  }
  L.push('');
  L.push(bar);
  L.push('  CAVEAT: bias is APPROXIMATED, not the live classifyTrendStrength()');
  L.push('  (still inline in app/server.js). Phase-transition counts are a real');
  L.push('  measurement of the AMD logic; bias-dependent outcome rates are');
  L.push('  indicative until that function is extracted. See this file\'s header.');
  L.push('');
  console.log(L.join('\n'));
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { approximateBias, runSession, baseRates, loadCorpus };
