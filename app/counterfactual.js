'use strict';
// F4 counterfactuals. Each is (trades, params) => {net, ev, winRate, payoff,
// deltaVsActual}. Two rules: (1) a counterfactual may only use information
// available AT or BEFORE the moment it acts; (2) counterfactuals compound
// wrong — model one at a time, never chain. A no-op parameter must return the
// actual record unchanged (deltaVsActual === 0).
const pointValueVerify = require('./point-value-verify');
function num(v) { if (typeof v === 'number') return Number.isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; } return null; }
function toMs(v) { if (typeof v === 'number') return v; if (typeof v === 'string' && v.trim() !== '') { const n = Date.parse(v); return Number.isFinite(n) ? n : null; } return null; }
function actualTotal(trades) { return (trades || []).reduce((a, t) => a + (num(t.pnl) || 0), 0); }
function summarize(pnls, actualTotal) {
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const net = pnls.reduce((a, p) => a + p, 0);
  const gw = wins.reduce((a, p) => a + p, 0);
  const gl = -losses.reduce((a, p) => a + p, 0);
  return { net, ev: n ? net / n : 0, winRate: n ? wins.length / n : 0, payoff: gl > 0 ? gw / gl : null, deltaVsActual: net - actualTotal };
}

// 1. Every winner runs to 2R. R is derived PER TRADE and flagged, never one
// global number: the signal's stop when signalBacked, otherwise the trade's own
// MAE-implied risk. Point value ALWAYS comes from point-value-verify.js (X7) —
// never a caller-supplied multiplier, which is how a wrong number spreads.
// Winners with a null mfe are excluded and counted; winners with no derivable R
// are refused and counted. Neither is ever treated as zero or passed silently.
function deriveR(t, pv, size) {
  // Explicit rSource-tagged R (the F1 live-write will populate both) wins first.
  if (num(t.r) != null && (t.rSource === 'signal-stop' || t.rSource === 'mae-implied')) {
    return { r: num(t.r), rSource: t.rSource };
  }
  // signal-stop: the armed setup's stop distance, in dollars.
  const ep = num(t.ep), stop = num(t.stop);
  if (t.signalBacked === true && ep != null && stop != null && pv != null) {
    return { r: Math.abs(ep - stop) * pv * size, rSource: 'signal-stop' };
  }
  // mae-implied: the risk the trade actually took.
  const mae = num(t.mae);
  if (mae != null && mae > 0 && pv != null) {
    return { r: mae * pv * size, rSource: 'mae-implied' };
  }
  return {
    r: null,
    rSource: null,
    reason: pv == null
      ? 'no point value for ' + String(t.symbol || 'unknown symbol')
      : 'no R derivable (no signal stop, no mae)',
  };
}

function winnersRunTo2R(trades, params) {
  const pop = {
    'signal-stop': { n: 0, net: 0, deltaVsActual: 0 },
    'mae-implied': { n: 0, net: 0, deltaVsActual: 0 },
  };
  const pnls = [];
  let excluded = 0, refused = 0;
  const refusedReasons = {};
  for (const t of (trades || [])) {
    const pnl = num(t.pnl) || 0;
    if (pnl <= 0) { pnls.push(pnl); continue; }
    const pv = pointValueVerify.pointValueFor(t.symbol);
    const size = num(t.size) || 1;
    const d = deriveR(t, pv, size);
    if (d.r == null) {
      refused++;
      const why = d.reason || 'no R derivable';
      refusedReasons[why] = (refusedReasons[why] || 0) + 1;
      pnls.push(pnl);
      continue;
    }
    if (num(t.mfe) == null) { excluded++; pnls.push(pnl); continue; }
    const neededPoints = (2 * d.r) / (pv * size);
    const p2 = num(t.mfe) >= neededPoints ? 2 * d.r : pnl;
    pnls.push(p2);
    pop[d.rSource].n++;
    pop[d.rSource].net += p2;
    pop[d.rSource].deltaVsActual += (p2 - pnl);
  }
  const result = Object.assign({ excluded, refused }, summarize(pnls, actualTotal(trades)));
  result.rSources = { 'signal-stop': pop['signal-stop'].n, 'mae-implied': pop['mae-implied'].n };
  result.signalStop = pop['signal-stop'];
  result.maeImplied = pop['mae-implied'];
  if (refused) {
    const breakdown = Object.entries(refusedReasons).map(([k, v]) => k + ': ' + v).join('; ');
    result.error = 'R/pointValue unresolved for ' + refused + ' winner(s) — passed through unchanged (refused, not a silent no-op)'
      + (breakdown ? ' [' + breakdown + ']' : '');
  }
  return result;
}

// 2. Nothing after a cutoff (IST wall-clock minutes).
function cutoffAt(trades, params) {
  const cutoff = params && params.cutoffMin != null ? num(params.cutoffMin) : null;
  const pnls = [];
  for (const t of (trades || [])) {
    const min = num(t.entryIstMin);
    if (cutoff != null && min != null && min >= cutoff) continue;
    pnls.push(num(t.pnl) || 0);
  }
  return summarize(pnls, actualTotal(trades));
}

// 3. Skip the Nth trade of the day (1-based). n=0 skips nothing.
function skipNthTrade(trades, params) {
  const n = params && params.n != null ? Math.floor(num(params.n)) : 0;
  const pnls = [];
  let idxOfDay = 0, lastDay = null;
  for (const t of (trades || [])) {
    // X2: skip the Nth trade OF EACH DAY, not of the whole book. Prefer the
    // F2.1 tradeIndexOfDay field; fall back to grouping by day when absent.
    if (t.tradeIndexOfDay != null) {
      if (n > 0 && t.tradeIndexOfDay === n) continue;
    } else {
      const day = t.day || (t.entryAt != null ? new Date(toMs(t.entryAt)).toISOString().slice(0, 10) : null);
      if (day !== lastDay) { lastDay = day; idxOfDay = 0; }
      idxOfDay++;
      if (n > 0 && idxOfDay === n) continue;
    }
    pnls.push(num(t.pnl) || 0);
  }
  return summarize(pnls, actualTotal(trades));
}

// 4. Per-trade stop at $X — cap each loss at -X.
function perTradeStop(trades, params) {
  const stop = params && params.stopUsd != null ? num(params.stopUsd) : null;
  const pnls = [];
  for (const t of (trades || [])) {
    const pnl = num(t.pnl) || 0;
    pnls.push(stop != null && pnl < -stop ? -stop : pnl);
  }
  return summarize(pnls, actualTotal(trades));
}

module.exports = { winnersRunTo2R, cutoffAt, skipNthTrade, perTradeStop, actualTotal };