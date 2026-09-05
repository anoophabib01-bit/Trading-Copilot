'use strict';
// ── Take-profit signal (live) ──────────────────────────────────────────────
// Answers, for the CURRENTLY ARMED setup, one question in real time: has the
// live price reached the plan's target?
//
// WHY THIS EXISTS — signal-outcome.js already resolves hit:'target' AFTER the
// fact, on the outcome ledger. But that tells Anoop the setup would have hit
// its target — twelve bars later, in a weekly review. It never says it WHILE
// the trade is live, which is the moment "take the profit" is an action and
// not a statistic. The rulebook's own gap: entries are detected plentifully,
// but the exit side ("exit at marker levels") is hand-drawn and unreadable to
// code. This module makes the TARGET part of the exit machine-readable.
//
// PURE. No I/O, no TradingView, no clock. The caller supplies the live price
// (from quote_get) and this decides whether it crosses the target. Unit-tested.

function dirSign(direction) {
  const d = String(direction || '').toUpperCase();
  if (d === 'BULLISH' || d === 'LONG') return 1;
  if (d === 'BEARISH' || d === 'SHORT') return -1;
  return 0;
}

/**
 * Has the live price crossed the setup's target?
 *
 * @param {object} setup  armed setup: { direction, target, entry }
 * @param {number} price  current price (any scale — points, not dollars)
 * @returns {boolean}
 */
function hitTarget(setup, price) {
  const sign = dirSign(setup && setup.direction);
  // Strict: a missing target or an unreadable price is "no", never "yes".
  // Number(null) is 0, so plain Number() would read a MISSING target as $0 and
  // fire a take-profit on the first tick — the exact phantom-trade class this
  // repo has already paid for once. Same rule as signal-outcome.js.
  const target = setup != null && setup.target != null && setup.target !== '' ? Number(setup.target) : NaN;
  const p = Number(price);
  if (!sign || !Number.isFinite(target) || !Number.isFinite(p)) return false;
  // Bullish: target is ABOVE entry, hit when price reaches or exceeds it.
  // Bearish: target is BELOW entry, hit when price reaches or falls under it.
  return sign === 1 ? p >= target : p <= target;
}

/**
 * Symmetric stop-loss check — the same arithmetic on the other side, exposed
 * for a future "STOP HIT — flatten now" line and so the pair is tested together
 * rather than one being an untested half.
 */
function hitStop(setup, price) {
  const sign = dirSign(setup && setup.direction);
  const stop = setup != null && setup.stop != null && setup.stop !== '' ? Number(setup.stop) : NaN;
  const p = Number(price);
  if (!sign || !Number.isFinite(stop) || !Number.isFinite(p)) return false;
  return sign === 1 ? p <= stop : p >= stop;
}

module.exports = { hitTarget, hitStop, dirSign };
