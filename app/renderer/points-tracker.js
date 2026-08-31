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

/* ── Ticks, and points for rows with no prices (2026-08-25) ─────────────────
 * Anoop: "i want to see how many ticks and points did i capture or loss in
 * these trades on this tab."
 *
 * The Journal's Points column read t.mp — the price-derived move persisted by
 * csvApply. Rows written by the LIVE fold have no ep/xp/mp at all (the fold
 * infers a closed trade from a balance delta at flat; it never sees a price),
 * so every trade of a live-only day rendered "—". The information was not
 * missing, though: pnl and size are known, and pnl = mult * size * points is
 * the same identity MULT_DEFAULT was derived from.
 *
 * The catch that makes this non-trivial: the two writers disagree on what
 * `pnl` means. A CSV row's pnl is GROSS (rollupDay subtracts commission once,
 * at day level). A fold row's pnl is a balance delta, so it is already NET of
 * commission. Dividing both by mult*size would silently report a fee as price
 * movement — on 2026-08-25's trade 2 that is -0.70 pts against a true +0.25,
 * a sign flip on a winning trade. So commission is added back for fold rows
 * before the division, and never for CSV rows.
 */

// MNQ: 0.25 points per tick ($0.50 at $2/point). Anything else must be passed
// in explicitly — the stored rows carry no symbol, and guessing MGC's 0.1 for
// an MNQ trade would misreport by 2.5x.
const TICK_DEFAULT = 0.25;

// A row whose pnl is already net of commission. The live feed stamps both of
// these; either one alone is enough to identify the writer.
function isNetOfCommission(t) {
  return !!t && (t.evidence === 'fold' || t.source === 'live-fold-only');
}

/**
 * Points on one trade, preferring the price-derived move and falling back to
 * the pnl identity. Returns { pts, derived } or null when neither is
 * available — same discipline as tradePoints(): a missing read must never
 * look like a flat trade.
 *
 * opts: { mult, commPerContract }  commPerContract is PER SIDE; a round turn
 * is two sides, matching rules.json's commissionPerContractPerSide.
 */
function tradePointsResolved(t, opts) {
  const o = opts || {};
  if (t && isFiniteNum(t.mp)) return { pts: t.mp, derived: false };
  if (!isValidTrade(t)) return null;
  const m = isFiniteNum(o.mult) && o.mult > 0 ? o.mult : MULT_DEFAULT;
  const comm = isFiniteNum(o.commPerContract) && o.commPerContract >= 0 ? o.commPerContract : 0;
  const gross = isNetOfCommission(t) ? t.pnl + t.size * comm * 2 : t.pnl;
  return { pts: gross / (m * t.size), derived: true };
}

/** Ticks on one trade. Same contract as tradePointsResolved. */
function tradeTicksResolved(t, opts) {
  const o = opts || {};
  const r = tradePointsResolved(t, o);
  if (!r) return null;
  const tick = isFiniteNum(o.tickSize) && o.tickSize > 0 ? o.tickSize : TICK_DEFAULT;
  return { ticks: r.pts / tick, derived: r.derived };
}

/**
 * Day (or any slice) total: points and ticks captured vs lost, plus how many
 * rows had to be derived. `derived` is surfaced rather than hidden so the UI
 * can mark the number as inferred instead of presenting it as a chart read.
 */
function totalPointsTicks(trades, opts) {
  if (!Array.isArray(trades)) return null;
  let pts = 0, won = 0, lost = 0, n = 0, derived = 0, skipped = 0;
  for (const t of trades) {
    const r = tradePointsResolved(t, opts);
    if (!r) { skipped++; continue; }
    n++;
    if (r.derived) derived++;
    pts += r.pts;
    if (r.pts > 0) won += r.pts; else lost += r.pts;
  }
  if (!n) return null;
  const o = opts || {};
  const tick = isFiniteNum(o.tickSize) && o.tickSize > 0 ? o.tickSize : TICK_DEFAULT;
  return {
    n, derived, skipped,
    netPts: pts, wonPts: won, lostPts: lost,
    netTicks: pts / tick, wonTicks: won / tick, lostTicks: lost / tick
  };
}

const EXPORTS = {
  MULT_DEFAULT,
  TICK_DEFAULT,
  isValidTrade,
  tradePoints,
  tradePointsResolved,
  tradeTicksResolved,
  totalPointsTicks,
  isNetOfCommission,
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
