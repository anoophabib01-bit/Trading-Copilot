'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dropFormingBar, findPivots, validateEngulfPlaybookC } = require('../playbook-c.js');

// ── fixtures ────────────────────────────────────────────────────────────────
const B = (o, h, l, c) => ({ time: 0, open: o, high: h, low: l, close: c });

// Walk a zig-zag through a list of turning-point prices, `steps` bars per leg.
// 4 bars per leg keeps confirmed fractal pivots cleanly separated.
function zig(points, steps = 4) {
  const bars = [];
  for (let p = 0; p < points.length - 1; p++) {
    const from = points[p], to = points[p + 1];
    for (let s = 1; s <= steps; s++) {
      const a = from + (to - from) * (s - 1) / steps;
      const b = from + (to - from) * s / steps;
      bars.push(B(a, Math.max(a, b) + 0.4, Math.min(a, b) - 0.4, b));
    }
  }
  return bars;
}

// Append a two-bar engulf event so the engulfing bar makes a NEW local extreme.
function withEngulf(base, dir) {
  const bars = base.slice();
  const last = bars[bars.length - 1].close;
  if (dir === 'BULLISH') {
    bars.push(B(last, last + 0.5, last - 2, last - 1.8));            // red
    bars.push(B(last - 1.8, last + 1.0, last - 2.6, last + 0.9));    // green, engulfs high+low
  } else {
    bars.push(B(last, last + 2, last - 0.5, last + 1.8));            // green
    bars.push(B(last + 1.8, last + 2.6, last - 1.0, last - 0.9));    // red, engulfs high+low
  }
  return bars;
}

// HH-HL uptrend whose final pullback HOLDS above the prior swing high (132).
const UPTREND = zig([100, 120, 108, 132, 118, 140, 134]);
// LL-LH downtrend whose final bounce stays BELOW the prior swing low (108).
const DOWNTREND = zig([140, 120, 132, 108, 122, 100, 106]);

// ── dropFormingBar ──────────────────────────────────────────────────────────
const nowSec = () => Math.floor(Date.now() / 1000);
const bar = (t) => ({ time: t, open: 1, high: 2, low: 0, close: 1 });

test('dropFormingBar drops a still-forming candle', () => {
  const n = nowSec();
  assert.equal(dropFormingBar([bar(n - 3600), bar(n - 300)], '15').length, 1);
});

test('dropFormingBar keeps a closed candle', () => {
  const n = nowSec();
  assert.equal(dropFormingBar([bar(n - 3600), bar(n - 1200)], '15').length, 2);
});

test('dropFormingBar handles millisecond timestamps', () => {
  const n = nowSec();
  assert.equal(dropFormingBar([bar((n - 3600) * 1000), bar((n - 300) * 1000)], '15').length, 1);
});

test('dropFormingBar leaves non-intraday resolutions untouched', () => {
  const n = nowSec();
  // 'D' has no fixed minute count — guessing would silently discard real data.
  assert.equal(dropFormingBar([bar(n - 100), bar(n - 50)], 'D').length, 2);
});

test('dropFormingBar is safe on empty/null input', () => {
  assert.deepEqual(dropFormingBar([], '15'), []);
  assert.deepEqual(dropFormingBar(null, '15'), []);
});

// ── findPivots ──────────────────────────────────────────────────────────────
test('findPivots finds ascending pivots in an uptrend', () => {
  const { pivotHighs, pivotLows } = findPivots(UPTREND.slice(0, UPTREND.length - 2));
  assert.ok(pivotHighs.length >= 2, 'expected at least 2 pivot highs');
  assert.ok(pivotLows.length >= 2, 'expected at least 2 pivot lows');
  assert.ok(pivotHighs[pivotHighs.length - 1].price > pivotHighs[0].price);
});

test('findPivots does not double-count a plateau (equal highs)', () => {
  // Regression: `high === max(window)` registers BOTH bars of an equal-high
  // pair, the structure check then compares two equal prices, and every
  // flat-topped move reads as "mixed/ranging". Equal highs are common in futures.
  const flatTop = UPTREND.slice();
  flatTop[5] = B(flatTop[5].open, flatTop[4].high, flatTop[5].low, flatTop[5].close);
  const { pivotHighs } = findPivots(flatTop.slice(0, flatTop.length - 2));
  const prices = pivotHighs.map(p => p.price);
  assert.equal(new Set(prices).size, prices.length, 'duplicate pivot prices found');
});

// ── validateEngulfPlaybookC — the valid cases ───────────────────────────────
test('valid bullish: HH-HL structure, at a swing low, liquidity intact', () => {
  const r = validateEngulfPlaybookC(withEngulf(UPTREND, 'BULLISH'), 'BULLISH', { pdh: 300, pdl: 50 });
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.structure, 'HH-HL');
});

test('valid bearish: LL-LH structure, at a swing high, liquidity intact', () => {
  const r = validateEngulfPlaybookC(withEngulf(DOWNTREND, 'BEARISH'), 'BEARISH', { pdh: 300, pdl: 10 });
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.structure, 'LL-LH');
});

test('a valid setup survives a missing PDH/PDL', () => {
  const r = validateEngulfPlaybookC(withEngulf(UPTREND, 'BULLISH'), 'BULLISH', null);
  assert.equal(r.valid, true, r.reason);
});

// ── the four rejection paths ────────────────────────────────────────────────
test('rejects a bearish engulfing inside an HH-HL uptrend', () => {
  const r = validateEngulfPlaybookC(withEngulf(UPTREND, 'BEARISH'), 'BEARISH', { pdh: 300, pdl: 50 });
  assert.equal(r.valid, false);
  assert.match(r.reason, /needs an LL-LH structure/);
});

test('rejects when buy-side liquidity was already swept and rejected', () => {
  const bars = withEngulf(UPTREND, 'BULLISH');
  const closeP = bars[bars.length - 1].close;
  // PDH sits just above the close while recent bars traded through it → the
  // stops above are gone and price fell back. Too late to buy.
  const r = validateEngulfPlaybookC(bars, 'BULLISH', { pdh: closeP + 2, pdl: 50 });
  assert.equal(r.valid, false);
  assert.match(r.reason, /already swept and rejected/);
});

test('rejects a deep pullback that broke back below the prior swing high', () => {
  const deep = zig([100, 120, 108, 132, 118, 140, 126]); // pullback ends under 132
  const r = validateEngulfPlaybookC(withEngulf(deep, 'BULLISH'), 'BULLISH', { pdh: 300, pdl: 50 });
  assert.equal(r.valid, false);
  assert.match(r.reason, /already swept and rejected/);
});

test('rejects a mid-range entry (not at a swing low)', () => {
  const mid = UPTREND.slice();
  const lc = mid[mid.length - 1].close;
  mid.push(B(lc, lc + 0.5, lc - 1, lc - 0.8));
  mid.push(B(lc - 0.8, lc + 2, lc - 1.2, lc + 1.8));
  mid[mid.length - 3] = B(lc, lc + 0.5, lc - 9, lc - 0.8); // a much lower low earlier
  const r = validateEngulfPlaybookC(mid, 'BULLISH', { pdh: 300, pdl: 50 });
  assert.equal(r.valid, false);
  assert.match(r.reason, /not at a swing low/);
});

test('rejects a candle that does not take out BOTH sides of the previous one', () => {
  const nf = UPTREND.slice();
  const lc = nf[nf.length - 1].close;
  nf.push(B(lc, lc + 0.5, lc - 2, lc - 1.8));
  nf.push(B(lc - 1.8, lc + 1.0, lc - 1.0, lc + 0.9)); // does not undercut prev low
  const r = validateEngulfPlaybookC(nf, 'BULLISH', { pdh: 300, pdl: 50 });
  assert.equal(r.valid, false);
  assert.match(r.reason, /BOTH the high and low/);
});

test('rejects a ranging market as structure-unknown', () => {
  const flat = [];
  for (let i = 0; i < 20; i++) flat.push(B(100, 100.6, 99.4, 100 + (i % 2 ? 0.2 : -0.2)));
  flat.push(B(100, 100.5, 98, 98.2));
  flat.push(B(98.2, 100.8, 97.5, 100.4));
  const r = validateEngulfPlaybookC(flat, 'BULLISH', { pdh: 150, pdl: 50 });
  assert.equal(r.valid, false);
  assert.match(r.reason, /structure unknown|mixed\/ranging/);
});

test('rejects when there is too little history to read structure', () => {
  const r = validateEngulfPlaybookC([B(1, 2, 0, 1), B(1, 2, 0, 1)], 'BULLISH', null);
  assert.equal(r.valid, false);
  assert.match(r.reason, /not enough bar history/);
});

test('every rejection carries a human-readable reason', () => {
  const cases = [
    [[B(1, 2, 0, 1), B(1, 2, 0, 1)], 'BULLISH', null],
    [withEngulf(UPTREND, 'BEARISH'), 'BEARISH', { pdh: 300, pdl: 50 }]
  ];
  for (const [bars, dir, pd] of cases) {
    const r = validateEngulfPlaybookC(bars, dir, pd);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 10, 'reason too short to be useful in the UI');
  }
});
