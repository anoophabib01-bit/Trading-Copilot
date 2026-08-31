'use strict';
// ── ADX / breakout detector tests (2026-08-26) ─────────────────────────────
// These back DSH-V2, the first strategy in this repo with out-of-sample
// evidence. The regime gate IS the strategy — an ADX that silently reads 0
// during warm-up, or that peeks forward, would turn "stand aside in ranges"
// into "trade everything" without changing a single visible number.
const test = require('node:test');
const assert = require('node:assert');
const { adxSeries, priorHigh } = require('../detectors.js');

const up = (n) => Array.from({ length: n }, (_, i) => ({ time: i * 3600, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));
const flat = (n) => Array.from({ length: n }, (_, i) => ({ time: i * 3600, open: 100, high: 101, low: 99, close: 100 }));

test('warm-up values are NaN, never 0 — a 0 would silently pass an ADX floor', () => {
  const { adx } = adxSeries(up(60), 14);
  for (let i = 0; i < 28; i++) assert.ok(Number.isNaN(adx[i]), `index ${i} should be NaN during warm-up`);
  assert.ok(Number.isFinite(adx[28]), 'first real value at period*2');
  // the comparison the strategy actually makes must be false during warm-up
  assert.equal(adx[10] >= 35, false);
});

test('a clean uptrend reads high ADX with +DI above -DI', () => {
  const { adx, plusDI, minusDI } = adxSeries(up(60), 14);
  assert.ok(adx[59] > 30, `expected strong trend, got ${adx[59]}`);
  assert.ok(plusDI[59] > minusDI[59]);
});

test('a flat range reads low ADX — which is what makes it a range filter', () => {
  const { adx } = adxSeries(flat(60), 14);
  assert.ok(!(adx[59] >= 35), `a dead-flat series must not pass an ADX>=35 gate, got ${adx[59]}`);
});

test('ADX is CAUSAL — appending future bars never changes an earlier value', () => {
  // The property that makes precomputing the series inside a backtest safe.
  const base = up(60);
  const extended = base.concat(up(30).map((b, i) => ({ ...b, time: (60 + i) * 3600, high: 500, low: 400, close: 450, open: 410 })));
  const a = adxSeries(base, 14).adx;
  const b = adxSeries(extended, 14).adx;
  for (let i = 0; i < base.length; i++) {
    if (Number.isNaN(a[i])) { assert.ok(Number.isNaN(b[i])); continue; }
    assert.equal(a[i], b[i], `index ${i} changed when future bars were appended — look-ahead`);
  }
});

test('one malformed bar refuses the WHOLE series rather than poisoning it', () => {
  const bars = up(60);
  bars[30] = { time: 30 * 3600, open: 'x', high: null, low: undefined, close: NaN };
  const { adx } = adxSeries(bars, 14);
  assert.ok(adx.every((v) => Number.isNaN(v)), 'a poisoned ADX is worse than a missing one');
});

test('too little history returns all-NaN instead of throwing', () => {
  assert.doesNotThrow(() => adxSeries(up(5), 14));
  assert.ok(adxSeries(up(5), 14).adx.every((v) => Number.isNaN(v)));
  assert.ok(adxSeries([], 14).adx.length === 0);
});

test('priorHigh EXCLUDES the signal bar — else every strong bar breaks out of itself', () => {
  const bars = up(40);
  const ph = priorHigh(bars, 20, 10);
  assert.equal(ph, bars[19].high);
  assert.ok(ph < bars[20].high, 'the signal bar must not be in its own lookback window');
});

test('priorHigh refuses rather than guessing when history or data is short/bad', () => {
  assert.equal(priorHigh(up(40), 3, 10), null);
  const bad = up(40); bad[15] = { high: null };
  assert.equal(priorHigh(bad, 20, 10), null);
});

// ── Non-array inputs (found by Protocol 1's stress pass, 2026-08-28) ───────
// `!bars || bars.length < 2` passes anything without a .length: {} gives
// `undefined < 2` === false, the guard is bypassed, and the next line throws
// on bars[-1].open. Every real caller passes an array — which is precisely why
// this survived until a protocol fed it garbage deliberately.
test('every detector refuses a non-array instead of throwing', () => {
  const d = require('../detectors.js');
  for (const junk of [null, undefined, {}, 'x', 0, 42, true, { length: 'no' }]) {
    assert.doesNotThrow(() => d.detectEngulfFromBars(junk), `detectEngulfFromBars(${JSON.stringify(junk)})`);
    assert.doesNotThrow(() => d.detectFVGFromBars(junk), `detectFVGFromBars(${JSON.stringify(junk)})`);
    assert.doesNotThrow(() => d.detectSFPFromBars(junk, { highs: [], lows: [] }));
    assert.doesNotThrow(() => d.classifyTrendFromBars(junk));
    assert.doesNotThrow(() => d.getSwingLevels(junk));
    assert.doesNotThrow(() => d.adxSeries(junk, 14));
    assert.strictEqual(d.detectEngulfFromBars(junk), null);
    assert.strictEqual(d.detectFVGFromBars(junk), null);
    assert.strictEqual(d.classifyTrendFromBars(junk), 'unclear');
    assert.deepEqual(d.getSwingLevels(junk), { swingHighs: [], swingLows: [] });
  }
});
