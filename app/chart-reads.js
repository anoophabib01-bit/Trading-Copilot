'use strict';
/**
 * chart-reads.js — deterministic chart maths (2026-08-11, Anoop)
 *
 * Everything the Analysis and Power-of-3 agents report about candles, EMAs and
 * swing structure is computed HERE, in plain arithmetic, and handed to them as
 * a finished answer. The agents are never asked to eyeball a candle or count
 * swings from a bar list.
 *
 * That is a deliberate rule, not a style choice. On 2026-08-10 an agent asked
 * to produce per-trade data it could not actually see invented an entire table
 * of it. "Is this body small relative to the range?" is exactly the kind of
 * judgement a model will get quietly wrong and report with full confidence.
 * If it can be computed, it gets computed.
 *
 * These live in their own module (rather than inside server.js, which is an
 * entry point with no exports) purely so they can be unit-tested without a
 * live chart — see test/chart-reads.test.js.
 *
 * Bar shape throughout: { time, open, high, low, close }  (see
 * extractBarsArray in server.js, which normalises to exactly this).
 */

/**
 * Standard EMA on close.
 *
 * Computed from bars rather than read off the chart via data_get_study_values,
 * deliberately: that tool only sees indicators actually PLOTTED on the chart,
 * so reading it would (a) silently return nothing whenever the EMA isn't added,
 * and (b) consume one of TradingView's per-chart indicator slots — which
 * matters on the free plan's 2-3 limit if Essential is ever dropped. EMA is
 * deterministic, so computing it gives the same number with no chart dependency.
 *
 * Seeded with an SMA of the first `period` bars, the conventional seeding.
 */
// ══ INPUT VALIDATION — added 2026-08-12 after an audit, and the reason matters ══
// This module was written to stop a MODEL guessing at candles. The maths was
// tested; the INPUTS never were. An audit found that a single malformed bar
// from the TradingView feed did not produce an obvious NaN — it produced
// 65,750,116.55, a plausible-looking wrong EMA — and detectDoji() on NaN inputs
// returned {kind:'doji', bodyPct:null}: a Doji that never printed, reported to
// an agent Anoop is told to trust over his own eyes. A float `period` crashed
// outright.
//
// So the rule for this whole file is now: NEVER return a number that cannot be
// verified. Return null and let the caller say "unavailable". A missing read is
// recoverable; a confident wrong read is what loses money.
const isFiniteNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isPosInt = (n) => Number.isInteger(n) && n > 0;

/** A bar is usable only if all four prices are finite and high/low bracket the body. */
function isValidBar(b) {
  return !!b
    && isFiniteNum(b.open) && isFiniteNum(b.high)
    && isFiniteNum(b.low) && isFiniteNum(b.close)
    && b.high >= b.low;
}

/** Every bar valid, or the whole series is refused. One bad bar poisons an EMA. */
function allBarsValid(bars) {
  return Array.isArray(bars) && bars.length > 0 && bars.every(isValidBar);
}

function emaFromBars(bars, period) {
  // period must be a positive INTEGER: a float silently mismatched the seed
  // length against k, and indexed past the end of the array (a real crash).
  if (!isPosInt(period)) return null;
  if (!allBarsValid(bars) || bars.length < period) return null;
  const k = 2 / (period + 1);
  let ema = bars.slice(0, period).reduce((s, b) => s + b.close, 0) / period;
  for (let i = period; i < bars.length; i++) ema = bars[i].close * k + ema * (1 - k);
  return Number.isFinite(ema) ? ema : null;   // belt and braces: never emit NaN
}

/**
 * Doji: body is a small fraction of the full range.
 *
 * Zero-range bars (a dead tick, common overnight on MNQ) are NOT dojis — they
 * are bad data, and returning true there would fire the alert continuously.
 * Returns null for "not a doji" so callers can use it as a plain truthiness
 * check.
 */
function detectDoji(bar, bodyMaxPct = 0.10) {
  // Was `if (!bar)` — which a {} or {close:NaN} sailed straight through,
  // producing a reported doji with bodyPct:null. Now the bar must be real and
  // the threshold must be a sane fraction.
  if (!isValidBar(bar)) return null;
  if (!isFiniteNum(bodyMaxPct) || bodyMaxPct <= 0 || bodyMaxPct >= 1) return null;
  const range = bar.high - bar.low;
  if (!(range > 0)) return null;
  const body = Math.abs(bar.close - bar.open);
  const ratio = body / range;
  if (ratio > bodyMaxPct) return null;
  const upper = bar.high - Math.max(bar.open, bar.close);
  const lower = Math.min(bar.open, bar.close) - bar.low;
  // Sub-type is descriptive only — the trading meaning comes from WHERE it
  // forms, which is why callers pair this with nearestLevel().
  let kind = 'doji';
  if (lower > body * 2 && lower > upper * 2) kind = 'dragonfly doji (long lower wick)';
  else if (upper > body * 2 && upper > lower * 2) kind = 'gravestone doji (long upper wick)';
  else if (Math.abs(upper - lower) / range < 0.2) kind = 'neutral doji';
  return {
    kind,
    bodyPct: +(ratio * 100).toFixed(1),
    close: bar.close, high: bar.high, low: bar.low
  };
}

/**
 * Nearest level to a price, with distance in points.
 *
 * Answers "was that Doji AT something, or in open space?" — a Doji mid-range is
 * noise on MNQ (several an hour); one at PDH/PDL or a marked zone is a signal.
 * Accepts plain numbers or {price|value, label} objects. Returns null when
 * nothing is within maxDistance.
 */
function nearestLevel(price, levels, maxDistance) {
  if (!Array.isArray(levels) || !levels.length || !isFiniteNum(price) || price <= 0) return null;
  if (maxDistance != null && (!isFiniteNum(maxDistance) || maxDistance < 0)) return null;
  let best = null;
  for (const lv of levels) {
    const p = typeof lv === 'number' ? lv : Number(lv && (lv.price != null ? lv.price : lv.value));
    if (!(p > 0)) continue;
    const d = Math.abs(price - p);
    if (!best || d < best.distance) {
      best = { price: p, distance: +d.toFixed(2), label: (lv && lv.label) || null };
    }
  }
  if (!best) return null;
  if (maxDistance != null && best.distance > maxDistance) return null;
  return best;
}

/**
 * Swing-pivot structure: HH+HL (uptrend) vs LH+LL (downtrend).
 *
 * Uses a 5-bar pivot by default (leftRight=2), matching the pivot definition
 * classifyTrendStrength() in server.js already relies on, so the two never
 * disagree about what counts as a swing.
 */
function swingStructure(bars, leftRight = 2) {
  // leftRight must be a positive INTEGER: a negative or float value inverted
  // the inner loop bounds while still passing the length guard.
  if (!isPosInt(leftRight)) return null;
  if (!allBarsValid(bars) || bars.length < leftRight * 2 + 3) return null;
  const highs = [], lows = [];
  for (let i = leftRight; i < bars.length - leftRight; i++) {
    let isH = true, isL = true;
    for (let j = i - leftRight; j <= i + leftRight; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isH = false;
      if (bars[j].low <= bars[i].low) isL = false;
    }
    if (isH) highs.push(bars[i].high);
    if (isL) lows.push(bars[i].low);
  }
  if (highs.length < 2 || lows.length < 2) {
    return { pattern: 'unclear', reason: 'not enough swing pivots', swingHighs: highs.length, swingLows: lows.length };
  }
  const hh = highs[highs.length - 1] > highs[highs.length - 2];
  const hl = lows[lows.length - 1] > lows[lows.length - 2];
  let pattern;
  if (hh && hl) pattern = 'HH + HL (uptrend structure)';
  else if (!hh && !hl) pattern = 'LH + LL (downtrend structure)';
  else pattern = 'mixed (no clean structure — ' + (hh ? 'HH' : 'LH') + ' but ' + (hl ? 'HL' : 'LL') + ')';
  return {
    pattern,
    lastTwoHighs: [highs[highs.length - 2], highs[highs.length - 1]],
    lastTwoLows: [lows[lows.length - 2], lows[lows.length - 1]],
    swingHighs: highs.length, swingLows: lows.length
  };
}

/**
 * Name the direction when two timeframes agree, instead of just "aligned".
 * Anoop's ask: "when 1hr and 15 mins match the same direction it should
 * specify the direction" — an unlabelled "aligned" is useless at the moment of
 * entry because it doesn't tell you which way.
 */
function alignmentVerdict(higherTF, lowerTF, higherLabel = '1H', lowerLabel = '15m') {
  const h = higherTF && higherTF.direction, l = lowerTF && lowerTF.direction;
  if (!h || !l || h === 'unclear' || l === 'unclear') {
    return { aligned: false, direction: null, text: `NOT ALIGNED — ${higherLabel} ${h || 'unknown'} / ${lowerLabel} ${l || 'unknown'} (one or both unclear)` };
  }
  if (h !== l) {
    return { aligned: false, direction: null, text: `NOT ALIGNED — ${higherLabel} ${h} vs ${lowerLabel} ${l}` };
  }
  const dir = h === 'up' ? 'LONG' : h === 'down' ? 'SHORT' : h.toUpperCase();
  return { aligned: true, direction: dir, text: `ALIGNED ${dir} — ${higherLabel} ${h}, ${lowerLabel} ${l}` };
}

/**
 * 9-EMA confirmation filter (Anoop, 2026-08-11):
 *   "9EMA closing should match higher time frame which is 1hr, and 15 mins
 *    should close as direction as 1 hr"
 *
 * So the EMA is not a standalone read — it is a CONFIRMATION of the 1H bias:
 *   1H up   → the last closed 15m candle must close ABOVE the 15m 9-EMA
 *   1H down → it must close BELOW
 * Anything else is an explicit non-confirmation, which is a reason to stand
 * down rather than a detail to mention in passing.
 *
 * Returns confirmed:false with a reason when the data isn't there, so the
 * caller never has to guess whether "not confirmed" means "disagrees" or
 * "unknown" — those are very different at the moment of entry.
 */
function emaConfirmation(htfDirection, lastClosed15m, ema9) {
  // Was `!lastClosed15m` — a {close: undefined} passed, and close > ema9 and
  // close < ema9 were BOTH false, so it reported 'exactly at' and then issued a
  // confirm/non-confirm verdict off a NaN distance.
  if (!isValidBar(lastClosed15m) || !isFiniteNum(ema9) || ema9 <= 0) {
    return { confirmed: false, known: false, text: '9-EMA confirmation: UNKNOWN (no EMA or no closed 15m bar)' };
  }
  const close = lastClosed15m.close;
  const side = close > ema9 ? 'above' : close < ema9 ? 'below' : 'exactly at';
  const dist = +(close - ema9).toFixed(2);
  if (!htfDirection || htfDirection === 'unclear') {
    return { confirmed: false, known: true, side, distance: dist,
      text: `9-EMA: 15m close ${close} is ${side} the 15m 9-EMA ${ema9.toFixed(2)} (${dist > 0 ? '+' : ''}${dist} pts) — but 1H direction is unclear, so nothing to confirm` };
  }
  const want = htfDirection === 'up' ? 'above' : 'below';
  const ok = side === want;
  return {
    confirmed: ok, known: true, side, distance: dist,
    text: ok
      ? `9-EMA CONFIRMS 1H ${htfDirection}: 15m closed ${close} ${side} the 15m 9-EMA ${ema9.toFixed(2)} (${dist > 0 ? '+' : ''}${dist} pts)`
      : `9-EMA DOES NOT CONFIRM 1H ${htfDirection}: 15m closed ${close} ${side} the 15m 9-EMA ${ema9.toFixed(2)} (${dist > 0 ? '+' : ''}${dist} pts) — expected ${want}. Stand down.`
  };
}

/**
 * Doji-at-PDH/PDL, on the 1H, per Anoop's spec ("Doji at 1hr and PDH or PDL").
 * A Doji in open space is noise; the whole point is a Doji printing INTO
 * yesterday's high or low. Anything not within `tolerance` points of PDH/PDL
 * returns null and is never mentioned.
 */
function dojiAtKeyLevel(lastClosed1h, pdh, pdl, tolerance = 15, bodyMaxPct = 0.10) {
  if (!isFiniteNum(tolerance) || tolerance < 0) return null;
  const doji = detectDoji(lastClosed1h, bodyMaxPct);
  if (!doji) return null;
  const levels = [];
  if (isFiniteNum(pdh) && pdh > 0) levels.push({ price: pdh, label: 'PDH' });
  if (isFiniteNum(pdl) && pdl > 0) levels.push({ price: pdl, label: 'PDL' });
  const near = nearestLevel(lastClosed1h.close, levels, tolerance);
  if (!near) return null;
  return {
    ...doji, level: near.label, levelPrice: near.price, distance: near.distance,
    text: `1H DOJI AT ${near.label} — ${doji.kind}, body ${doji.bodyPct}% of range, closed ${doji.close}, ${near.distance} pts from ${near.label} ${near.price}`
  };
}

module.exports = {
  emaFromBars, detectDoji, nearestLevel, swingStructure,
  alignmentVerdict, emaConfirmation, dojiAtKeyLevel,
  // exported so callers/tests can ask 'is this feed trustworthy?' directly
  isValidBar, allBarsValid
};
