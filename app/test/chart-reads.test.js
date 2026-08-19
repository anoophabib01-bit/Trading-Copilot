'use strict';
/**
 * Unit tests for chart-reads.js — the deterministic chart maths behind what the
 * Analysis and Power-of-3 agents report.
 *
 * These matter more than most tests in this repo: the whole reason this maths
 * lives in code rather than in a prompt is that a model asked to eyeball a Doji
 * or count swings will occasionally be wrong and say it confidently. That
 * argument only holds if the code is actually right.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  emaFromBars, detectDoji, nearestLevel, swingStructure,
  alignmentVerdict, emaConfirmation, dojiAtKeyLevel
} = require('../chart-reads');

const bar = (o, h, l, c, t = 0) => ({ time: t, open: o, high: h, low: l, close: c });

// ── emaFromBars ──────────────────────────────────────────────────────────────
test('emaFromBars: flat series returns that same value', () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(100, 100, 100, 100, i));
  assert.strictEqual(emaFromBars(bars, 9), 100);
});

test('emaFromBars: matches hand-computed EMA', () => {
  // 9 seed bars at 10, then one bar at 20. k = 2/10 = 0.2
  // seed SMA = 10; ema = 20*0.2 + 10*0.8 = 12
  const bars = [...Array.from({ length: 9 }, (_, i) => bar(10, 10, 10, 10, i)), bar(20, 20, 20, 20, 9)];
  assert.strictEqual(emaFromBars(bars, 9), 12);
});

test('emaFromBars: returns null when there are fewer bars than the period', () => {
  assert.strictEqual(emaFromBars([bar(1, 1, 1, 1)], 9), null);
  assert.strictEqual(emaFromBars(null, 9), null);
});

// ── detectDoji ───────────────────────────────────────────────────────────────
test('detectDoji: classic doji — tiny body, big range', () => {
  const d = detectDoji(bar(100, 110, 90, 100.5));
  assert.ok(d, 'should be a doji');
  assert.strictEqual(d.bodyPct, 2.5);
});

test('detectDoji: a big-bodied candle is not a doji', () => {
  assert.strictEqual(detectDoji(bar(100, 110, 90, 109)), null);
});

test('detectDoji: zero-range bar is NOT a doji (dead tick, not a signal)', () => {
  assert.strictEqual(detectDoji(bar(100, 100, 100, 100)), null);
});

test('detectDoji: dragonfly — long lower wick', () => {
  const d = detectDoji(bar(110, 110.5, 90, 110));
  assert.ok(d);
  assert.match(d.kind, /dragonfly/);
});

test('detectDoji: gravestone — long upper wick', () => {
  const d = detectDoji(bar(90, 110, 89.5, 90));
  assert.ok(d);
  assert.match(d.kind, /gravestone/);
});

// ── nearestLevel ─────────────────────────────────────────────────────────────
test('nearestLevel: picks the closest and reports distance', () => {
  const n = nearestLevel(100, [{ price: 90, label: 'PDL' }, { price: 104, label: 'PDH' }]);
  assert.strictEqual(n.label, 'PDH');
  assert.strictEqual(n.distance, 4);
});

test('nearestLevel: respects maxDistance', () => {
  assert.strictEqual(nearestLevel(100, [{ price: 200, label: 'PDH' }], 15), null);
});

// ── swingStructure ───────────────────────────────────────────────────────────
test('swingStructure: rising market reads HH + HL', () => {
  // staircase up with clear 5-bar pivots
  const bars = [];
  let base = 100;
  for (let i = 0; i < 6; i++) {
    bars.push(bar(base, base + 1, base - 1, base, bars.length));
    bars.push(bar(base + 2, base + 5, base + 1, base + 4, bars.length)); // pivot high
    bars.push(bar(base + 2, base + 3, base - 2, base + 1, bars.length));
    bars.push(bar(base, base + 1, base - 3, base, bars.length));         // pivot low
    base += 6;
  }
  const s = swingStructure(bars);
  assert.ok(s, 'structure should be computed');
  assert.match(s.pattern, /HH \+ HL/);
});

test('swingStructure: falling market reads LH + LL', () => {
  // Mirror of the rising fixture above: same intra-cycle shape, descending base,
  // so each cycle leaves one isolated 5-bar pivot high and one pivot low.
  const bars = [];
  let base = 200;
  for (let i = 0; i < 6; i++) {
    bars.push(bar(base, base + 1, base - 1, base, bars.length));
    bars.push(bar(base - 2, base - 1, base - 5, base - 4, bars.length)); // pivot low
    bars.push(bar(base - 2, base + 2, base - 3, base + 1, bars.length));
    bars.push(bar(base, base + 3, base - 1, base, bars.length));         // pivot high
    base -= 6;
  }
  const s = swingStructure(bars);
  assert.ok(s);
  assert.match(s.pattern, /LH \+ LL/);
  // and the pivots themselves must actually be descending
  assert.ok(s.lastTwoHighs[1] < s.lastTwoHighs[0], 'highs should be lower');
  assert.ok(s.lastTwoLows[1] < s.lastTwoLows[0], 'lows should be lower');
});

test('swingStructure: too few bars returns null rather than guessing', () => {
  assert.strictEqual(swingStructure([bar(1, 1, 1, 1), bar(1, 1, 1, 1)]), null);
});

// ── alignmentVerdict ─────────────────────────────────────────────────────────
test('alignmentVerdict: agreement NAMES the direction (Anoop\'s core ask)', () => {
  const v = alignmentVerdict({ direction: 'up' }, { direction: 'up' });
  assert.strictEqual(v.aligned, true);
  assert.strictEqual(v.direction, 'LONG');
  assert.match(v.text, /ALIGNED LONG/);
});

test('alignmentVerdict: down + down is SHORT', () => {
  assert.strictEqual(alignmentVerdict({ direction: 'down' }, { direction: 'down' }).direction, 'SHORT');
});

test('alignmentVerdict: disagreement is not aligned and has no direction', () => {
  const v = alignmentVerdict({ direction: 'up' }, { direction: 'down' });
  assert.strictEqual(v.aligned, false);
  assert.strictEqual(v.direction, null);
});

test('alignmentVerdict: unclear on either side never reports aligned', () => {
  assert.strictEqual(alignmentVerdict({ direction: 'unclear' }, { direction: 'up' }).aligned, false);
});

// ── emaConfirmation ──────────────────────────────────────────────────────────
test('emaConfirmation: 1H up + 15m closes ABOVE the EMA = confirmed', () => {
  const r = emaConfirmation('up', bar(100, 106, 99, 105), 100);
  assert.strictEqual(r.confirmed, true);
  assert.match(r.text, /CONFIRMS/);
});

test('emaConfirmation: 1H up but 15m closes BELOW the EMA = stand down', () => {
  const r = emaConfirmation('up', bar(100, 101, 90, 95), 100);
  assert.strictEqual(r.confirmed, false);
  assert.match(r.text, /DOES NOT CONFIRM/);
  assert.match(r.text, /Stand down/);
});

test('emaConfirmation: 1H down + 15m closes BELOW = confirmed', () => {
  assert.strictEqual(emaConfirmation('down', bar(100, 101, 90, 95), 100).confirmed, true);
});

test('emaConfirmation: missing EMA reports UNKNOWN, not "disagrees"', () => {
  const r = emaConfirmation('up', bar(100, 101, 99, 100), null);
  assert.strictEqual(r.confirmed, false);
  assert.strictEqual(r.known, false);
  assert.match(r.text, /UNKNOWN/);
});

// ── dojiAtKeyLevel ───────────────────────────────────────────────────────────
test('dojiAtKeyLevel: doji printing into PDH is reported', () => {
  const r = dojiAtKeyLevel(bar(20000, 20010, 19990, 20000.5), 20002, 19800, 15);
  assert.ok(r, 'should report');
  assert.strictEqual(r.level, 'PDH');
  assert.match(r.text, /1H DOJI AT PDH/);
});

test('dojiAtKeyLevel: doji in open space is IGNORED (noise, not signal)', () => {
  assert.strictEqual(dojiAtKeyLevel(bar(20000, 20010, 19990, 20000.5), 20500, 19500, 15), null);
});

test('dojiAtKeyLevel: big-bodied candle at PDH is not reported', () => {
  assert.strictEqual(dojiAtKeyLevel(bar(19990, 20010, 19985, 20009), 20010, 19800, 15), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// INPUT VALIDATION (added 2026-08-12 after an audit found the original tests
// covered only WELL-FORMED input).
//
// The bug these exist to prevent is not a crash. It is a CONFIDENT WRONG
// ANSWER: a string `close` produced an EMA of 65,750,116.55, and NaN inputs
// produced a reported doji with bodyPct:null — handed to an agent the trader
// is told to trust over his own eyes. Every case below must return null.
// ═══════════════════════════════════════════════════════════════════════════
const { isValidBar, allBarsValid } = require('../chart-reads');
const mkBars = (n, o) => Array.from({ length: n }, (_, i) => ({ time: i, open: 10, high: 12, low: 8, close: 10, ...(o || {}) }));

test('VALIDATION: one string price poisons nothing — the series is refused', () => {
  const bars = mkBars(12); bars[3].close = 'x';
  assert.strictEqual(emaFromBars(bars, 9), null, 'must refuse, not return 65750116.55');
});

test('VALIDATION: null/undefined/missing prices are refused', () => {
  for (const bad of [{ close: null }, { close: undefined }, { high: NaN }, { low: Infinity }]) {
    const bars = mkBars(12); Object.assign(bars[5], bad);
    assert.strictEqual(emaFromBars(bars, 9), null, JSON.stringify(bad) + ' must be refused');
  }
});

test('VALIDATION: a bar whose high is below its low is refused', () => {
  const bars = mkBars(12); bars[2].high = 1; bars[2].low = 99;
  assert.strictEqual(emaFromBars(bars, 9), null);
});

test('VALIDATION: non-integer period returns null instead of CRASHING', () => {
  assert.doesNotThrow(() => emaFromBars(mkBars(12), 2.5));
  assert.strictEqual(emaFromBars(mkBars(12), 2.5), null);
  assert.strictEqual(emaFromBars(mkBars(12), -3), null);
  assert.strictEqual(emaFromBars(mkBars(12), 0), null);
});

test('VALIDATION: a clean series still computes (the guard is not over-eager)', () => {
  assert.ok(typeof emaFromBars(mkBars(12), 9) === 'number');
});

test('VALIDATION: detectDoji refuses NaN rather than reporting a phantom doji', () => {
  assert.strictEqual(detectDoji({ open: NaN, high: 10, low: 0, close: NaN }), null);
  assert.strictEqual(detectDoji({}), null);
  assert.strictEqual(detectDoji({ open: 1, high: 2, low: 0, close: '1' }), null);
});

test('VALIDATION: detectDoji refuses a nonsense threshold', () => {
  const bar = { open: 100, high: 110, low: 90, close: 100.5 };
  assert.strictEqual(detectDoji(bar, -0.1), null, 'negative would make every bar a doji');
  assert.strictEqual(detectDoji(bar, 1.5), null);
  assert.ok(detectDoji(bar, 0.10), 'a sane threshold still works');
});

test('VALIDATION: swingStructure refuses negative/float leftRight', () => {
  assert.strictEqual(swingStructure(mkBars(20), -1), null);
  assert.strictEqual(swingStructure(mkBars(20), 1.5), null);
});

test('VALIDATION: swingStructure refuses a series with any bad bar', () => {
  const bars = mkBars(20); bars[7].low = 'x';
  assert.strictEqual(swingStructure(bars), null);
});

test('VALIDATION: emaConfirmation reports UNKNOWN on a bad bar, never a verdict', () => {
  const r = emaConfirmation('up', { close: undefined, high: 1, low: 0, open: 1 }, 100);
  assert.strictEqual(r.confirmed, false);
  assert.strictEqual(r.known, false);
  assert.match(r.text, /UNKNOWN/);
});

test('VALIDATION: emaConfirmation refuses a NaN EMA', () => {
  assert.strictEqual(emaConfirmation('up', { open: 1, high: 2, low: 0, close: 1 }, NaN).known, false);
});

test('VALIDATION: dojiAtKeyLevel refuses NaN PDH/PDL instead of guessing', () => {
  const bar = { open: 20000, high: 20010, low: 19990, close: 20000.5 };
  assert.strictEqual(dojiAtKeyLevel(bar, NaN, NaN, 15), null);
  assert.strictEqual(dojiAtKeyLevel(bar, 20002, 19800, -5), null, 'negative tolerance refused');
});

test('VALIDATION: nearestLevel refuses NaN price', () => {
  assert.strictEqual(nearestLevel(NaN, [{ price: 100 }]), null);
});

test('VALIDATION: isValidBar / allBarsValid are usable as a feed-health check', () => {
  assert.strictEqual(isValidBar({ open: 1, high: 2, low: 0, close: 1 }), true);
  assert.strictEqual(isValidBar({ open: 1, high: 2, low: 0, close: 'x' }), false);
  assert.strictEqual(allBarsValid(mkBars(5)), true);
  assert.strictEqual(allBarsValid([]), false);
  const bad = mkBars(5); bad[1].high = null;
  assert.strictEqual(allBarsValid(bad), false);
});
