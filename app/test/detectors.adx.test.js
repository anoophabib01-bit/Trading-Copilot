'use strict';
// ── ADX / breakout detector tests (2026-08-26) ─────────────────────────────
// These back Playbook C (ADX), the first strategy in this repo with out-of-sample
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

// ── detectAdxBreakoutFromBars — the four gates as one decision ─────────────
// Added 2026-09-01 with the live monitor for Playbook C (ADX). The gates were
// only ever exercised through the offline backtests before this; the live path
// now shares the same function, and these pin the behaviour that makes that
// safe — above all that it reads the last CLOSED bar, never the forming one.
const { detectAdxBreakoutFromBars } = require('../detectors.js');

// A long clean uptrend, then a caller-shaped final two bars. `bars.length-2`
// is the bar under test; the last bar stands in for the forming one.
function withTail(closedBar, formingBar) {
  const base = up(80);
  const last = base[base.length - 1];
  const t = last.time;
  return base.concat([
    Object.assign({ time: t + 3600 }, closedBar),
    Object.assign({ time: t + 7200, open: 0, high: 0, low: 0, close: 0 }, formingBar || {}),
  ]);
}
// A bar that clears the prior 10-bar high of the `up()` series and closes green.
const BREAKOUT = { open: 180, high: 400, low: 179, close: 390 };

test('fires when all four gates pass', () => {
  const s = detectAdxBreakoutFromBars(withTail(BREAKOUT), { adxMin: 35, lookback: 10, period: 14 });
  assert.ok(s, 'expected a signal');
  assert.equal(s.playbook, 'C-ADX');
  assert.equal(s.direction, 'BULLISH');
  assert.equal(s.entryRef, 390, 'entry reference is the closed bar close');
  assert.ok(s.adx >= 35 && s.plusDI > s.minusDI);
  assert.ok(s.bar.close > s.priorHigh, 'must clear the prior high it reports');
});

test('gate 4: a RED breakout candle is refused', () => {
  const red = { open: 395, high: 400, low: 179, close: 390 };   // clears the high, closes down
  assert.equal(detectAdxBreakoutFromBars(withTail(red), { adxMin: 35, lookback: 10 }), null);
});

test('gate 3: closing at or below the prior high is not a breakout', () => {
  const inside = { open: 150, high: 175, low: 149, close: 174 };
  assert.equal(detectAdxBreakoutFromBars(withTail(inside), { adxMin: 35, lookback: 10 }), null);
});

test('gate 1: the same bar is refused once the ADX floor is raised above the reading', () => {
  const s = detectAdxBreakoutFromBars(withTail(BREAKOUT), { adxMin: 35, lookback: 10 });
  assert.ok(s, 'baseline should fire');
  assert.equal(detectAdxBreakoutFromBars(withTail(BREAKOUT), { adxMin: s.adx + 5, lookback: 10 }), null);
});

// Gate 2 is tested on REAL bars rather than a fabricated downtrend. The
// obvious synthetic — a big green bar inside a falling series — does not test
// what it looks like it tests: a 270-point up-move generates enough +DM to
// legitimately flip +DI above -DI on that very bar, so the detector fires and
// is RIGHT to. Wilder's DI responds to the current bar, and a test that
// asserts otherwise pins a bug, not a rule. The cached window contains 13 bars
// that pass gates 1, 3 and 4, of which 3 fail gate 2 — so this measures the
// gate doing real work on real data.
test('gate 2: bars that clear every other gate but have -DI on top are refused', () => {
  const fs = require('node:fs'), path = require('node:path');
  const f = path.join(__dirname, '..', '..', 'DATA', 'bars', 'mnq_60.json');
  if (!fs.existsSync(f)) return;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const bars = (raw.bars || raw).filter((b) => b && Number.isFinite(b.close));
  const { adx, plusDI, minusDI } = adxSeries(bars, 14);
  let checked = 0;
  for (let i = 30; i < bars.length - 1; i++) {
    const ph = priorHigh(bars, i, 10);
    if (!Number.isFinite(adx[i]) || !Number.isFinite(ph)) continue;
    const others = adx[i] >= 35 && bars[i].close > ph && bars[i].close > bars[i].open;
    if (!others || plusDI[i] > minusDI[i]) continue;      // only gate-2-only failures
    checked++;
    assert.equal(detectAdxBreakoutFromBars(bars.slice(0, i + 2), { adxMin: 35, lookback: 10 }), null,
      `bar ${i} passed 1/3/4 but -DI >= +DI — LONG ONLY means this must not fire`);
  }
  assert.ok(checked > 0, 'expected the cached window to contain gate-2-only rejections');
});

test('THE REPAINT GUARD: it judges the last CLOSED bar, never the forming one', () => {
  // Forming bar is a monster breakout; closed bar is nothing. Must not fire.
  const s = detectAdxBreakoutFromBars(withTail({ open: 150, high: 152, low: 149, close: 151 }, BREAKOUT),
    { adxMin: 35, lookback: 10 });
  assert.equal(s, null, 'a forming bar must never produce a signal');
  // And the signal it DOES report is the closed bar's own price.
  const s2 = detectAdxBreakoutFromBars(withTail(BREAKOUT, { open: 999, high: 9999, low: 1, close: 9000 }),
    { adxMin: 35, lookback: 10 });
  assert.ok(s2 && s2.entryRef === 390, 'entry must come from the closed bar, not the forming one');
});

test('refuses rather than guesses on short history', () => {
  assert.equal(detectAdxBreakoutFromBars(up(20), { adxMin: 35, lookback: 10 }), null);
  assert.equal(detectAdxBreakoutFromBars(null, {}), null);
  assert.equal(detectAdxBreakoutFromBars([], {}), null);
});

test('refuses a bar with a non-finite price instead of scoring it', () => {
  const bad = detectAdxBreakoutFromBars(withTail({ open: 180, high: 400, low: 179, close: NaN }), { adxMin: 35, lookback: 10 });
  assert.equal(bad, null);
});

test('the detector agrees with the backtest on REAL bars — one rule, not two', () => {
  // The whole reason this lives in detectors.js: if the live monitor and the
  // offline harness disagree about what a signal is, the forward test measures
  // something other than what was backtested. Replays real cached MNQ 1H bars
  // one bar at a time and checks the detector reproduces exactly the gates the
  // verify script applies.
  const fs = require('node:fs'), path = require('node:path');
  const f = path.join(__dirname, '..', '..', 'DATA', 'bars', 'mnq_60.json');
  if (!fs.existsSync(f)) return;   // data is not committed everywhere; skip rather than fail
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const bars = (raw.bars || raw).filter((b) => b && Number.isFinite(b.close));
  const { adx, plusDI, minusDI } = adxSeries(bars, 14);
  let detected = 0, expected = 0;
  for (let i = 30; i < bars.length - 1; i++) {
    const ph = priorHigh(bars, i, 10);
    const want = Number.isFinite(adx[i]) && Number.isFinite(ph)
      && adx[i] >= 35 && plusDI[i] > minusDI[i]
      && bars[i].close > ph && bars[i].close > bars[i].open;
    if (want) expected++;
    // Feed the detector history ending with bar i CLOSED and i+1 forming.
    const got = detectAdxBreakoutFromBars(bars.slice(0, i + 2), { adxMin: 35, lookback: 10, period: 14 });
    if (got) { detected++; assert.equal(got.barTime, bars[i].time, 'signal must name the bar it fired on'); }
    assert.equal(!!got, want, `disagreement at bar ${i} (${new Date(bars[i].time * 1000).toISOString()})`);
  }
  assert.equal(detected, expected);
  assert.ok(expected > 0, 'the cached window should contain at least one real signal');
});
