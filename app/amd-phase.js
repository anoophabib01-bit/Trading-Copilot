'use strict';
// ── MECHANICAL AMD PHASE DETECTOR (no AI) — extracted 2026-08-17 ────────────
// Was inline in server.js since 2026-07-29; pulled out here so it's directly
// unit-testable (previously had zero test coverage despite being the core
// logic every auto-triggered debate and the PO3 monitor's alerts depend on)
// and reusable outside app/ — specifically tradingview-mcp's replay-mode
// backtest script, which requires this same function so a historical
// validation run can never silently drift from what actually runs live.
//
// 2026-07-29 (Anoop): "i want it to trigger me and give my an output in lower
// time frames as confirmation for my trade entry", polling every 60s, alert on
// ANY phase change.
//
// Deliberately NOT an LLM call per poll: at 60s that's ~60 Gemini requests an
// hour, which is exactly the quota exhaustion that took Jessi down twice. This
// is pure arithmetic on bars — free, instant, deterministic, and it produces
// the same A/M/D verdict the agent would. The LLM is only used afterwards to
// narrate a trigger that has already fired.
//
// Phase logic, from Anoop's ICT Power of 3 PDF:
//   ACCUMULATION  — price still inside the opening range built after session open
//   MANIPULATION  — that range broken AGAINST the 1H bias (liquidity swept)
//   DISTRIBUTION  — after such a sweep, price displaces back through the range
//                   in the direction OF the 1H bias
// Anything without an established 1H bias is UNCLEAR (the hard gate).
// (2026-08-17: bias gate tightened from 4H to 1H.)
//
// `openingBars` = how many bars after session open define the accumulation
// range. 4 x 15m = the first hour of the session.

/**
 * @param {Array<{time:number, high:number, low:number, close:number}>} bars
 * @param {'bullish'|'bearish'|string} biasDirection
 * @param {number} sessionStartUnix
 * @param {number} openingBars
 * @returns {{phase:string, reason:string|null, rangeHigh:number|null, rangeLow:number|null, sweptTo:number|null, detail:string|null}}
 */
function computeAmdPhase(bars, biasDirection, sessionStartUnix, openingBars) {
  const out = { phase: 'UNCLEAR', reason: null, rangeHigh: null, rangeLow: null, sweptTo: null, detail: null };
  if (biasDirection !== 'bullish' && biasDirection !== 'bearish') {
    out.reason = '1H bias not established — gate blocks the phase call';
    return out;
  }
  if (!Array.isArray(bars) || !bars.length) {
    out.reason = 'no bars available';
    return out;
  }

  // Bars from the current session only.
  const sess = bars.filter(b => b && typeof b.time === 'number' && b.time >= sessionStartUnix);
  if (sess.length < 2) {
    out.reason = 'session just opened (fewer than 2 bars) — too early to judge';
    return out;
  }

  const nOpen = Math.max(1, openingBars || 4);
  const opening = sess.slice(0, nOpen);
  const rangeHigh = Math.max(...opening.map(b => b.high));
  const rangeLow = Math.min(...opening.map(b => b.low));
  out.rangeHigh = rangeHigh;
  out.rangeLow = rangeLow;

  // Still inside the opening window itself → by definition accumulating.
  if (sess.length <= nOpen) {
    out.phase = 'ACCUMULATION';
    out.reason = 'still inside the opening ' + nOpen + '-bar range (' + rangeLow + '–' + rangeHigh + ')';
    return out;
  }

  const after = sess.slice(nOpen);
  // On a bullish bias, manipulation runs DOWN (sweeps sell-side liquidity).
  // On a bearish bias, manipulation runs UP (sweeps buy-side liquidity).
  const sweepIsDown = biasDirection === 'bullish';

  let sweepIdx = -1, sweepExtreme = null;
  for (let i = 0; i < after.length; i++) {
    const b = after[i];
    if (sweepIsDown && b.low < rangeLow) { sweepIdx = i; sweepExtreme = b.low; break; }
    if (!sweepIsDown && b.high > rangeHigh) { sweepIdx = i; sweepExtreme = b.high; break; }
  }

  if (sweepIdx === -1) {
    // No sweep against bias yet. If price has instead already run WITH bias
    // beyond the range, the session is distributing without a clean trap.
    const ranWithBias = sweepIsDown
      ? after.some(b => b.high > rangeHigh)
      : after.some(b => b.low < rangeLow);
    if (ranWithBias) {
      out.phase = 'DISTRIBUTION';
      out.reason = 'broke the opening range in the direction of 1H bias without a counter-sweep first — distributing, but no manipulation trap was set';
      return out;
    }
    out.phase = 'ACCUMULATION';
    out.reason = 'price still contained within the opening range (' + rangeLow + '–' + rangeHigh + '); no liquidity swept yet';
    return out;
  }

  out.sweptTo = sweepExtreme;

  // Sweep happened. Has price displaced back through the range with bias?
  const post = after.slice(sweepIdx + 1);
  const reclaimed = sweepIsDown
    ? post.some(b => b.close > rangeLow)   // bullish: closed back above the swept low
    : post.some(b => b.close < rangeHigh); // bearish: closed back below the swept high

  if (reclaimed) {
    out.phase = 'DISTRIBUTION';
    out.reason = 'liquidity swept to ' + sweepExtreme + ' (' + (sweepIsDown ? 'below' : 'above') +
      ' the opening range), then price closed back ' + (sweepIsDown ? 'above ' + rangeLow : 'below ' + rangeHigh) +
      ' — manipulation complete, distributing with 1H bias (' + biasDirection + ')';
    out.detail = 'ENTRY-RELEVANT: this is the reversal out of manipulation.';
    return out;
  }

  out.phase = 'MANIPULATION';
  out.reason = 'liquidity being swept to ' + sweepExtreme + ' (' + (sweepIsDown ? 'below' : 'above') +
    ' the opening range) against 1H bias (' + biasDirection + ') — trap in progress, no reclaim yet';
  out.detail = 'NOT yet an entry — wait for the close back inside the range.';
  return out;
}

module.exports = { computeAmdPhase };
