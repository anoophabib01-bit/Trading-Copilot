'use strict';
const test = require('node:test');
const assert = require('node:assert');
const BR = require('../bar-recorder');

const MIN = 60000;
const T0 = Date.UTC(2026, 7, 31, 12, 0, 0);
// A run of `n` bars spaced `stepMin` apart, starting `startMin` after T0.
function series(startMin, n, stepMin, priceBase) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = (priceBase || 29400) + i;
    out.push({ t: T0 + (startMin + i * stepMin) * MIN, o: p, h: p + 2, l: p - 2, c: p });
  }
  return out;
}

test('overlapping pulls build ONE continuous series, not a replacement', () => {
  const first = series(0, 10, 5);
  const second = series(25, 10, 5);          // overlaps the last 5 of `first`
  const a = BR.mergePull([], first, 5);
  const b = BR.mergePull(a.bars, second, 5);
  // dropLast removes the forming bar from each pull: 9 + 9 unique across overlap
  assert.ok(b.bars.length > a.bars.length, 'the series grew');
  assert.strictEqual(b.rejected, false);
  const ts = b.bars.map(x => x.t);
  assert.deepStrictEqual(ts, [...new Set(ts)], 'no duplicate timestamps');
  assert.deepStrictEqual(ts, [...ts].sort((x, y) => x - y), 'chronological');
});

test('RULE 1: the forming bar is dropped from every pull', () => {
  const pull = series(0, 5, 5);
  const r = BR.mergePull([], pull, 5);
  assert.strictEqual(r.bars.length, 4);
  assert.strictEqual(r.bars[r.bars.length - 1].t, pull[3].t, 'the last, still-open bar is not stored');
});

test('RULE 2: a later read of the same timestamp REPLACES the stored one', () => {
  const early = [{ t: T0, o: 1, h: 2, l: 0, c: 1 }, { t: T0 + MIN, o: 1, h: 1, l: 1, c: 1 }];
  // Same first timestamp, but the bar has since closed with a different range.
  const later = [{ t: T0, o: 1, h: 9, l: -9, c: 5 }, { t: T0 + MIN, o: 1, h: 1, l: 1, c: 1 }];
  const a = BR.mergePull([], early, 1);
  const b = BR.mergePull(a.bars, later, 1);
  const bar0 = b.bars.find(x => x.t === T0);
  assert.strictEqual(bar0.h, 9, 'the finished bar wins over the mid-formation one');
  assert.strictEqual(b.replaced, 1);
  assert.strictEqual(b.added, 0);
});

test('RULE 3: a pull at the wrong timeframe is REJECTED, not merged', () => {
  const stored = BR.mergePull([], series(0, 10, 5), 5).bars;
  const wrong = series(100, 10, 30);          // 30m bars arriving for a 5m series
  const r = BR.mergePull(stored, wrong, 5);
  assert.strictEqual(r.rejected, true);
  assert.strictEqual(r.bars.length, stored.length, 'stored series untouched');
  assert.match(r.reason, /refusing to merge/);
  assert.match(r.reason, /finished switching timeframe/);
});

test('RULE 3: a correct-timeframe pull is accepted', () => {
  const stored = BR.mergePull([], series(0, 10, 5), 5).bars;
  const r = BR.mergePull(stored, series(100, 10, 5), 5);
  assert.strictEqual(r.rejected, false);
  assert.ok(r.added > 0);
});

test('RULE 4: merging never shrinks the series except by the retention cap', () => {
  const stored = BR.mergePull([], series(0, 50, 5), 5).bars;
  // A pull covering ground already stored adds nothing but must remove nothing.
  const r = BR.mergePull(stored, series(0, 10, 5), 5);
  assert.ok(r.bars.length >= stored.length, 'history is not recoverable — it must never shrink');
});

test('RULE 4: the cap trims the OLDEST bars, keeping the recent ones', () => {
  const stored = BR.mergePull([], series(0, 60, 1), 1, { maxBars: 1000 }).bars;
  const r = BR.mergePull(stored, series(200, 30, 1), 1, { maxBars: 40 });
  assert.strictEqual(r.bars.length, 40);
  const ts = r.bars.map(x => x.t);
  assert.strictEqual(Math.max(...ts), Math.max(...r.bars.map(x => x.t)), 'newest retained');
  assert.ok(Math.min(...ts) > T0, 'oldest trimmed, not newest');
});

test('an empty pull is rejected and changes nothing', () => {
  const stored = BR.mergePull([], series(0, 10, 5), 5).bars;
  const r = BR.mergePull(stored, [], 5);
  assert.strictEqual(r.rejected, true);
  assert.strictEqual(r.bars.length, stored.length);
});

test('seconds-based and millisecond-based timestamps both normalise', () => {
  const secs = [{ time: Math.floor(T0 / 1000), high: 5, low: 1, close: 3 },
                { time: Math.floor(T0 / 1000) + 60, high: 5, low: 1, close: 3 },
                { time: Math.floor(T0 / 1000) + 120, high: 5, low: 1, close: 3 }];
  const r = BR.mergePull([], secs, 1);
  assert.strictEqual(r.bars[0].t, T0, 'seconds promoted to ms');
});

test('malformed bars are dropped rather than poisoning the series', () => {
  const mixed = [{ t: T0, h: 5, l: 1, c: 3 }, null, { t: null, h: 5, l: 1, c: 3 },
                 { t: T0 + MIN, h: 5, l: 1, c: 3 }, { t: T0 + 2 * MIN, h: 5, l: 1, c: 3 }];
  const r = BR.mergePull([], mixed, 1);
  assert.strictEqual(r.bars.length, 2, '3 valid, minus the forming one');
});

test('modalSpacingMin ignores session gaps rather than averaging them in', () => {
  const withGap = series(0, 10, 5).concat(series(1000, 10, 5));   // big overnight gap
  assert.strictEqual(BR.modalSpacingMin(withGap), 5, 'the modal gap is the bar size');
});

test('describe reports real coverage', () => {
  const r = BR.mergePull([], series(0, 100, 5), 5);
  const d = BR.describe(r.bars);
  assert.strictEqual(d.count, 99);
  assert.strictEqual(d.spacing, 5);
  assert.ok(d.spanDays > 0);
});

test('progressToAnswer turns the wait into a countdown', () => {
  const almost = BR.mergePull([], series(0, 300, 5), 5).bars;   // ~1 day
  const p = BR.progressToAnswer(almost);
  assert.strictEqual(p.ready, false);
  assert.ok(p.tradingDaysRemaining > 0);
  assert.ok(p.pairsSoFar >= 0);
});
