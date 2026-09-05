'use strict';
// F2.2 conditional expectancy per tag. Per-contract normalisation (never
// per-trade): comparing per-trade across sizes measures how big he bet, not
// how well he traded. n is always beside every number; a low-n tag is not a
// finding. Null MAE/MFE (from F1's null discipline) is EXCLUDED from averages,
// never counted as zero.
function num(v) { if (typeof v === 'number') return Number.isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; } return null; }

function statsFor(trades) {
  const n = trades.length;
  if (!n) return null;
  const wins = trades.filter((t) => (num(t.pnl) || 0) > 0);
  const losses = trades.filter((t) => (num(t.pnl) || 0) < 0); // M1: scratch (pnl===0) is neither win nor loss
  const totalPnl = trades.reduce((a, t) => a + (num(t.pnl) || 0), 0);
  const totalContracts = trades.reduce((a, t) => a + (num(t.size) || 0), 0);
  const gw = wins.reduce((a, t) => a + (num(t.pnl) || 0), 0);
  const gl = -losses.reduce((a, t) => a + (num(t.pnl) || 0), 0);
  const avgWin = wins.length ? gw / wins.length : null;
  const avgLoss = losses.length ? gl / losses.length : null;
  const payoff = avgWin != null && avgLoss != null && avgLoss > 0 ? avgWin / avgLoss : null;
  const maeVals = trades.map((t) => num(t.mae)).filter((v) => v != null);
  const mfeVals = trades.map((t) => num(t.mfe)).filter((v) => v != null);
  const holdVals = trades.map((t) => num(t.hold)).filter((v) => v != null);
  return {
    n,
    winRate: wins.length / n,
    avgWin, avgLoss, payoff,
    expectancyPerTrade: totalPnl / n,
    expectancyPerContract: totalContracts > 0 ? totalPnl / totalContracts : null,
    totalPnl, totalContracts,
    avgMae: maeVals.length ? maeVals.reduce((a, b) => a + b, 0) / maeVals.length : null,
    avgMfe: mfeVals.length ? mfeVals.reduce((a, b) => a + b, 0) / mfeVals.length : null,
    avgHold: holdVals.length ? holdVals.reduce((a, b) => a + b, 0) / holdVals.length : null,
  };
}

function expectancyBy(trades, tagFn, minN) {
  const groups = new Map();
  for (const t of Array.isArray(trades) ? trades : []) {
    const k = tagFn(t);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = [];
  for (const [tag, group] of groups) {
    const s = statsFor(group);
    if (!s) continue;
    out.push(Object.assign({ tag, underMin: minN != null && s.n < minN }, s));
  }
  out.sort((a, b) => (b.expectancyPerContract || 0) - (a.expectancyPerContract || 0));
  return out;
}

module.exports = { statsFor, expectancyBy, num };