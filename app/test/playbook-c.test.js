'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dropFormingBar, findPivots, validateEngulfPlaybookC, STAGE, PBC_NEAR_LEVEL_TOL } = require('../playbook-c.js');
const detectors = require('../detectors.js');

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

// ── Structure comes from the 1H, not the trigger timeframe (2026-09-01) ────
// Anoop: "Higher high, higher low ... analysis should be done only in 1 hour,
// which should also sync with 4 hour time frame."
//
// Requirement 3 used to be computed from `bars` — whatever timeframe the
// watcher was polling. On the 30M/15M/5M engulf watchers that meant reading
// structure off a chart he does not read structure on. The 4th argument lets
// the caller hand in the 1H verdict instead.

test('injected 1H structure OVERRIDES the local pivot read', () => {
  // A local DOWNTREND, but the 1H says bullish. A bullish engulf must now pass
  // requirement 3 on the 1H's word, not the trigger timeframe's.
  const bars = withEngulf(DOWNTREND, 'BULLISH');
  const local = validateEngulfPlaybookC(bars, 'BULLISH', { pdh: 300, pdl: 10 });
  const withHtf = validateEngulfPlaybookC(bars, 'BULLISH', { pdh: 300, pdl: 10 }, 'bullish');

  assert.equal(local.valid, false, 'local read should reject a bullish engulf in an LL-LH series');
  assert.match(local.reason, /HH-HL/);
  // The 15M read replaces the structure verdict; whether it ultimately passes
  // depends on the remaining local requirements, but it must no longer be
  // rejected FOR STRUCTURE.
  if (!withHtf.valid) assert.doesNotMatch(withHtf.reason, /needs an HH-HL structure/);
  assert.match(withHtf.structure, /15M/, 'the label must say which read decided');
});

test('injected 15M structure can REFUSE what the local read would have allowed', () => {
  const bars = withEngulf(UPTREND, 'BULLISH');
  const local = validateEngulfPlaybookC(bars, 'BULLISH', { pdh: 300, pdl: 50 });
  assert.equal(local.valid, true, 'baseline: passes on its own timeframe');

  const against = validateEngulfPlaybookC(bars, 'BULLISH', { pdh: 300, pdl: 50 }, 'bearish');
  assert.equal(against.valid, false, 'a bearish 15M must disqualify a bullish engulf');
  assert.match(against.reason, /HH-HL/);
  assert.equal(against.structure, 'LL-LH (15M)');
});

test('omitting the argument preserves the old local-pivot behaviour exactly', () => {
  const bars = withEngulf(UPTREND, 'BULLISH');
  const a = validateEngulfPlaybookC(bars, 'BULLISH', { pdh: 300, pdl: 50 });
  const b = validateEngulfPlaybookC(bars, 'BULLISH', { pdh: 300, pdl: 50 }, null);
  const c = validateEngulfPlaybookC(bars, 'BULLISH', { pdh: 300, pdl: 50 }, 'unclear');
  assert.deepEqual(a, b, 'null must not change behaviour');
  assert.deepEqual(a, c, 'an unclear 15M falls back to the local read rather than refusing');
});

test('the candle-level requirements still bind regardless of the 1H', () => {
  // A non-engulfing candle is not rescued by a friendly higher timeframe.
  const notEngulf = UPTREND.concat([B(100, 101, 99, 100.5), B(100.5, 100.8, 100.2, 100.6)]);
  const r = validateEngulfPlaybookC(notEngulf, 'BULLISH', { pdh: 300, pdl: 50 }, 'bullish');
  assert.equal(r.valid, false);
  assert.doesNotMatch(r.reason, /HH-HL/, 'should fail on the candle, not on structure');
});

// ── THE VETO / EVIDENCE SPLIT (2026-09-03) ──────────────────────────────────
// Anoop: "playbook A should be active in both direction and should intimate me
// when any engulfing in any direction takes place after which i will decide
// manually which side should i take the entry at."
//
// server.js's engulf monitor now alerts on a CONTEXT failure and still refuses
// a SHAPE failure. That split is only safe if `stage` is exactly right, so
// these pin each class to the reason that produces it. Get one wrong in the
// SHAPE direction and the app announces engulfings that are not engulfings;
// get one wrong in the CONTEXT direction and he silently stops being told
// about candles again, which is the bug this whole change exists to fix.
test('a candle that is not an engulfing at all is a SHAPE failure', () => {
  const base = UPTREND;
  const last = base[base.length - 1].close;

  // wrong colour sequence: green then green
  const noFlip = base.concat([
    B(last, last + 2, last - 0.5, last + 1.5),
    B(last + 1.5, last + 3, last + 1, last + 2.5),
  ]);
  const r1 = validateEngulfPlaybookC(noFlip, 'BULLISH', null, 'bullish');
  assert.equal(r1.valid, false);
  assert.equal(r1.stage, STAGE.SHAPE, 'a colour-flip failure must never reach the alert');

  // colour flips, but the second bar does not take out both extremes
  const noRange = base.concat([
    B(last, last + 3, last - 3, last - 2.5),                       // red, wide
    B(last - 2.5, last + 1, last - 2, last + 0.5),                 // green, inside
  ]);
  const r2 = validateEngulfPlaybookC(noRange, 'BULLISH', null, 'bullish');
  assert.equal(r2.valid, false);
  assert.equal(r2.stage, STAGE.SHAPE);

  // takes out both extremes with WICKS, but the body does not cover the body
  const wickOnly = base.concat([
    B(last, last + 0.6, last - 0.6, last - 0.5),                   // red, small body
    B(last - 0.52, last + 3, last - 3, last - 0.48),               // green, huge wicks, tiny body
  ]);
  const r3 = validateEngulfPlaybookC(wickOnly, 'BULLISH', null, 'bullish');
  assert.equal(r3.valid, false);
  assert.equal(r3.stage, STAGE.SHAPE, 'the 2026-08-27 body-engulf check is part of the definition');
});

test('a real engulfing in the wrong CONTEXT is a context failure, not a shape one', () => {
  // A genuine bullish engulfing candle, judged against a bearish 15M bias.
  // Every shape requirement holds; only requirement 3 fails.
  const bars = withEngulf(UPTREND, 'BULLISH');
  const r = validateEngulfPlaybookC(bars, 'BULLISH', { pdh: 300, pdl: 50 }, 'bearish');
  assert.equal(r.valid, false);
  assert.equal(r.stage, STAGE.CONTEXT,
    'the candle is real — only its location is wrong, and that is his call now');
  assert.match(r.reason, /HH-HL/, 'and the reason must name what he is overriding');
});

test('a full pass is stamped OK, so "valid" and "alertable" stay separable', () => {
  const bars = withEngulf(UPTREND, 'BULLISH');
  const r = validateEngulfPlaybookC(bars, 'BULLISH', { pdh: 300, pdl: 50 });
  assert.equal(r.valid, true);
  assert.equal(r.stage, STAGE.OK);
});

test('too little history is DATA, which is neither a pass nor a rejection', () => {
  const r = validateEngulfPlaybookC([B(1, 2, 0, 1), B(1, 2, 0, 1)], 'BULLISH', null, 'bullish');
  assert.equal(r.valid, false);
  assert.equal(r.stage, STAGE.DATA,
    'the caller must be able to tell "could not look" from "looked and said no"');
});

test('every rejection carries a stage — an untagged one would silently alert', () => {
  // The failure mode this guards: server.js treats anything that is not SHAPE
  // or DATA as alertable. A reason added later with no stage would therefore
  // default into the alerting path rather than out of it.
  const cases = [
    [withEngulf(UPTREND, 'BULLISH'), 'BULLISH', { pdh: 300, pdl: 50 }, 'bearish'],
    [withEngulf(DOWNTREND, 'BEARISH'), 'BEARISH', { pdh: 300, pdl: 10 }, 'bullish'],
    [withEngulf(UPTREND, 'BULLISH'), 'BULLISH', null, null],
    [UPTREND.concat([B(100, 101, 99, 100.5), B(100.5, 101, 100, 100.8)]), 'BULLISH', null, 'bullish'],
    [[B(1, 2, 0, 1)], 'BULLISH', null, null],
  ];
  for (const [bars, dir, pdh, htf] of cases) {
    const r = validateEngulfPlaybookC(bars, dir, pdh, htf);
    assert.ok(Object.values(STAGE).includes(r.stage),
      'unstaged result: ' + JSON.stringify(r));
  }
});

// ── G21: LEVEL_TOL has ONE declaration ─────────────────────────────────────
test('G21: detectors and playbook-c resolve to the SAME tolerance, never two copies', () => {
  assert.strictEqual(detectors.LEVEL_TOL, 0.0005, 'the value is unchanged by this task');
  assert.strictEqual(PBC_NEAR_LEVEL_TOL, detectors.LEVEL_TOL, 'playbook-c aliases detectors.LEVEL_TOL');
});
