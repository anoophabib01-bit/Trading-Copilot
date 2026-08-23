'use strict';
/**
 * points-tracker.js — deterministic points-per-trade math. No model, no
 * eyeballing: same discipline as chart-reads.js (validate inputs, refuse to
 * guess, return null rather than invent).
 *
 * WHY THIS EXISTS (2026-08-12/13)
 * --------------------------------
 * Anoop: "what are my average points that I am capturing? How should I
 * behave when I capture less? How should I size accordingly? That should be
 * my main goal."
 *
 * On 2026-08-12 that question was answered once, by hand, in chat: 38 trades,
 * 42% win rate, avg win +13.2 pts, avg loss -17.1 pts, ratio 0.77:1,
 * expectancy -2.99 pts/trade. Then nothing was built to keep producing that
 * number — the next morning he had to ask for it again. This module is the
 * fix: the app computes it, not me.
 *
 * MULT = $2 per point per MNQ contract, derived from 127 of Anoop's own
 * trades (chat_transcript.json, 2026-08-12) where pnl / (size * mp) agreed
 * exactly. Do not change this without re-deriving it the same way.
 */

const MULT_DEFAULT = 2;

function isFiniteNum(n) { return typeof n === 'number' && Number.isFinite(n); }
function isPosInt(n) { return Number.isInteger(n) && n > 0; }

/** A trade is usable only if size is a positive integer and pnl is finite. */
function isValidTrade(t) {
  return !!t && isPosInt(t.size) && isFiniteNum(t.pnl);
}

/**
 * Points captured on one trade. Returns null (never NaN, never 0) for a
 * trade that cannot be trusted — a missing read must never look like a
 * flat trade.
 */
function tradePoints(t, mult) {
  const m = isFiniteNum(mult) && mult > 0 ? mult : MULT_DEFAULT;
  if (!isValidTrade(t)) return null;
  return t.pnl / (m * t.size);
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

/**
 * Full summary over a list of trades (chronological order assumed, oldest
 * first — callers pass whatever slice they want summarized).
 *
 * Returns null only when there is nothing usable at all. Otherwise always
 * returns an object — `skipped` reports how many trades were dropped as
 * invalid so a caller can surface that rather than silently under-counting.
 */
function summarize(trades, mult) {
  if (!Array.isArray(trades)) return null;
  const pts = [];
  let skipped = 0;
  for (const t of trades) {
    const p = tradePoints(t, mult);
    if (p === null) { skipped++; continue; }
    pts.push(p);
  }
  if (!pts.length) return null;

  const wins = pts.filter((p) => p > 0);
  const losses = pts.filter((p) => p < 0);
  const winRate = wins.length / pts.length;
  const avgWinPts = mean(wins);
  const avgLossPts = mean(losses); // negative or 0
  // Bug fixed 2026-08-13: the original guard only checked losses.length, so
  // an all-losses set (wins.length === 0) fell into the ternary's true branch
  // as Math.abs(0 / avgLossPts) = 0 — a confident, wrong "ratio of zero"
  // instead of "no ratio exists." Caught by its own test. Both conditions
  // must be checked explicitly:
  let ratio;
  if (!wins.length) ratio = null;               // nothing to rate a ratio against
  else if (!losses.length) ratio = Infinity;     // wins with zero losses
  else ratio = Math.abs(avgWinPts / avgLossPts);

  return {
    count: pts.length,
    skipped,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWinPts,
    avgLossPts,
    medianWinPts: median(wins),
    medianLossPts: median(losses),
    ratio,
    expectancyPts: mean(pts)
  };
}

/**
 * Rolling avgW:avgL over the most recent `window` trades. This is the number
 * that should drive sizing — see sizeGuidance(). Returns null until there is
 * at least `window` trades of history so an early, noisy ratio never drives
 * a size decision.
 */
function rollingRatio(trades, window, mult) {
  const w = isPosInt(window) ? window : 10;
  if (!Array.isArray(trades) || trades.length < w) return null;
  const slice = trades.slice(-w);
  const s = summarize(slice, mult);
  return s ? s.ratio : null;
}

/**
 * Sizing tier from the rolling ratio. This is deliberately the ONLY input —
 * Anoop's own framing (2026-08-12): "size follows the ratio, not the
 * feeling." A good morning or a bad one does not change the tier; only the
 * measured ratio does.
 */
function sizeGuidance(ratio) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) {
    return { tier: 'insufficient-data', label: 'Not enough trades yet', maxSize: 1 };
  }
  if (ratio === Infinity) {
    return { tier: 'step-up', label: 'No losses in window — earned tier, but recheck sample size', maxSize: null };
  }
  if (ratio < 1.0) {
    return { tier: 'minimum', label: 'Ratio below 1.0 — minimum size, no discretion', maxSize: 1 };
  }
  if (ratio < 1.5) {
    return { tier: 'base', label: 'Ratio 1.0-1.5 — base size', maxSize: null };
  }
  return { tier: 'step-up', label: 'Ratio 1.5+ — step up permitted', maxSize: null };
}

const EXPORTS = {
  MULT_DEFAULT,
  isValidTrade,
  tradePoints,
  summarize,
  rollingRatio,
  sizeGuidance,
  _debug: { median, mean }
};

// Dual-mode export — this file is loaded BOTH by Node (server.js, unit tests)
// and directly by the browser via a <script> tag (the renderer has no module
// system). One file, not two copies: the Journal chart and the number Anoop
// was given in chat must always agree, the same reasoning as loss-ratchet.js
// and volume-budget.js.
if (typeof module !== 'undefined' && module.exports) module.exports = EXPORTS;
if (typeof window !== 'undefined') window.PointsTracker = EXPORTS;
