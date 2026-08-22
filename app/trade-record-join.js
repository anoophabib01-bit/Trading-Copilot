'use strict';
// ── Trade record join (LIVE_FEED_LOOP_PLAN.md task 4.1) ─────────────────────
// The live fold scores realized P&L exactly (balance delta at flat) but knows
// no symbol/side/prices. The order walk knows symbol/side/prices/times but no
// $. joinFoldToWalk matches each fold-scored close to its order-walk round
// trip and emits ONE record carrying both. The work is a join, not new
// extraction — analyzeOrderWalk already runs on every poll.
//
// Provenance is preserved, never upgraded silently: a merged record keeps
// evidence/inferred/pnlUnknown from the fold, and unmatched records keep
// their origin ('live-fold-only' / 'order-walk-only'). A record that was
// scored on a degraded feed must STILL read as degraded after the join —
// that label is what keeps an uncertain number from reaching a hard lock.
//
// Matching is greedy and time-ordered: both inputs are sorted by close time;
// each fold record takes the nearest unconsumed walk close within tolerance,
// with size equality preferred (a size-identical match within tolerance wins
// over a closer time with a different size). Unmatched walk closes still
// appear in the output as order-walk-only records (pnlUnknown) — the walk
// seeing a close the fold missed (e.g. a flip) must not vanish.

const DEFAULT_TOLERANCE_MS = 3 * 60 * 1000;

function joinFoldToWalk(foldTrades, walkClosed, opts) {
  const tol = (opts && typeof opts.toleranceMs === 'number') ? opts.toleranceMs : DEFAULT_TOLERANCE_MS;
  const folds = Array.isArray(foldTrades) ? foldTrades.slice() : [];
  const walks = Array.isArray(walkClosed) ? walkClosed.slice() : [];
  const merged = [];
  const unmatchedFold = [];
  const usedWalk = new Set();
  for (const f of folds) {
    let best = -1;
    let bestD = Infinity;
    let bestEqualD = Infinity;
    // Two passes: a size-equal close within tolerance wins outright (nearest
    // among equals); only when none exists does the nearest in-tolerance
    // close of any size match.
    for (let i = 0; i < walks.length; i++) {
      if (usedWalk.has(i)) continue;
      const w = walks[i];
      if (typeof w.exitAt !== 'number' || typeof f.at !== 'number') continue;
      const d = Math.abs(w.exitAt - f.at);
      if (d > tol) continue;
      if (w.size === f.size && d < bestEqualD) { bestEqualD = d; best = i; }
      if (bestEqualD === Infinity && d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      usedWalk.add(best);
      const w = walks[best];
      merged.push({
        symbol: w.symbol || null,
        side: w.side || null,
        size: f.size,
        pnl: f.pnl,
        at: f.at,
        entryPrice: w.entryPrice,
        exitPrice: w.exitPrice,
        entryAt: w.entryAt,
        exitAt: w.exitAt,
        evidence: f.evidence || 'fold',
        inferred: !!f.inferred,
        pnlUnknown: f.pnlUnknown === true,
        source: 'live-fold+order-walk',
      });
    } else {
      // A fold-scored close with no walk match is still a real record (the
      // fold is the $ truth) — it goes to unmatchedFold, NOT into merged.
      unmatchedFold.push({
        symbol: null, side: null,
        size: f.size, pnl: f.pnl, at: f.at,
        entryPrice: null, exitPrice: null, entryAt: null, exitAt: null,
        evidence: f.evidence || 'fold',
        inferred: !!f.inferred,
        pnlUnknown: f.pnlUnknown === true,
        source: 'live-fold-only',
      });
    }
  }
  const unmatchedWalk = walks
    .filter((_, i) => !usedWalk.has(i))
    .map(w => Object.assign({}, w, { source: 'order-walk-only' }));
  const records = merged.concat(unmatchedFold, unmatchedWalk).sort((a, b) => (a.at || a.exitAt || 0) - (b.at || b.exitAt || 0));
  return { records, merged, unmatchedFold, unmatchedWalk };
}

module.exports = { joinFoldToWalk, DEFAULT_TOLERANCE_MS };
