'use strict';
// Tests for the MGC-only brief. Run with:  node --test "cli/test/*.test.js"
//
// The ratioSeries cases are the ones that matter. MGC and SI are separate
// contracts on separate books: they do not always print a bar at the same
// second, and either can be missing a bar the other has. Pairing by ARRAY
// INDEX — the obvious implementation — is correct right up until the first
// gap, after which every subsequent pair is silently off by one bar and the
// gold/silver ratio is computed from two different moments in time. Nothing
// about the output would look wrong; the number would just quietly be a lie.
// These tests pin the nearest-timestamp pairing that avoids that.

const test = require('node:test');
const assert = require('node:assert');

const MB = require('../market-brief');
const Y = require('../yahoo');

const bar = (t, c) => ({ t, o: c, h: c, l: c, c, v: 1 });

// ── ratioSeries ────────────────────────────────────────────────────────────
test('ratioSeries pairs aligned bars and divides A by B', () => {
  const a = [bar(1000, 4400), bar(1300, 4410)];
  const b = [bar(1000, 100), bar(1300, 100)];
  const r = MB.ratioSeries(a, b);
  assert.equal(r.length, 2);
  assert.equal(r[0].ratio, 44);
  assert.equal(r[1].ratio, 44.1);
  assert.equal(r[0].t, 1000, 'timestamp comes from the A series');
});

test('ratioSeries survives a gap in B without going off by one', () => {
  // B is missing the bar at 1300. Index-pairing would match A@1300 with
  // B@1600 and then A@1600 with nothing — every later pair misaligned.
  const a = [bar(1000, 4400), bar(1300, 4410), bar(1600, 4420)];
  const b = [bar(1000, 100), /* 1300 missing */ bar(1600, 110)];
  const r = MB.ratioSeries(a, b);

  assert.equal(r.length, 2, 'the unmatched A bar is dropped, not mispaired');
  assert.deepEqual(r.map((x) => x.t), [1000, 1600]);
  assert.equal(r[1].ratio, 4420 / 110, 'A@1600 pairs with B@1600, not B@1000');
});

test('ratioSeries drops a pair whose skew exceeds the bound', () => {
  // 400s apart — beyond the 150s default. Treating these as simultaneous
  // would compute a ratio across a real data hole.
  const a = [bar(1000, 4400)];
  const b = [bar(1400, 100)];
  assert.equal(MB.ratioSeries(a, b).length, 0);
  // …but an explicit wider bound admits it.
  assert.equal(MB.ratioSeries(a, b, 600).length, 1);
});

test('ratioSeries picks the NEAREST B bar, not merely the first in range', () => {
  const a = [bar(1000, 4400)];
  const b = [bar(910, 100), bar(1010, 200)];   // 90s away vs 10s away
  const r = MB.ratioSeries(a, b);
  assert.equal(r.length, 1);
  assert.equal(r[0].ratio, 22, 'must pair with the 1010 bar (4400/200), not 910');
});

test('ratioSeries never divides by zero or a negative price', () => {
  const a = [bar(1000, 4400), bar(1300, 4410)];
  const b = [bar(1000, 0), bar(1300, 100)];
  const r = MB.ratioSeries(a, b);
  assert.equal(r.length, 1, 'the zero-priced bar is skipped, not turned into Infinity');
  assert.ok(Number.isFinite(r[0].ratio));
});

test('ratioSeries handles empty inputs without throwing', () => {
  assert.deepEqual(MB.ratioSeries([], []), []);
  assert.deepEqual(MB.ratioSeries([bar(1, 1)], []), []);
  assert.deepEqual(MB.ratioSeries([], [bar(1, 1)]), []);
});

// ── the gold context list ──────────────────────────────────────────────────
test('GOLD_CONTEXT is distinct from the combined-brief context', () => {
  const gold = Y.GOLD_CONTEXT.map((c) => c.y);
  const combined = Y.CONTEXT.map((c) => c.y);
  assert.ok(gold.length >= 3);
  for (const y of gold) {
    assert.ok(!combined.includes(y),
      y + ' appears in both lists — the gold brief would just repeat the combined one');
  }
});

test('every GOLD_CONTEXT entry carries the fields the renderer reads', () => {
  for (const c of Y.GOLD_CONTEXT) {
    assert.ok(c.y && c.label && c.name && c.why, 'incomplete entry: ' + JSON.stringify(c));
    assert.ok(['index', 'future'].includes(c.kind),
      c.label + ' has kind "' + c.kind + '" — analyseContext branches on this, and an '
      + 'unknown kind would silently take the index path (last-vs-previous daily close), '
      + 'which reports 0% on a continuous future while the market is shut');
  }
});

test('TIP is documented as a real-yield proxy, not a nominal one', () => {
  // The sign convention is the trap: DXY and 10Y in the combined brief are
  // INVERSE to gold, but TIP's price is inverse to real yields, so TIP up is
  // gold-bullish. If someone rewrites `why` without that, the next person to
  // add an alert rule will get the direction backwards.
  const tip = Y.GOLD_CONTEXT.find((c) => c.label === 'TIP');
  assert.ok(tip, 'TIP missing from GOLD_CONTEXT');
  assert.match(tip.why, /real yield/i);
});

// ── buildBrief's new narrowing options ─────────────────────────────────────
test('buildBrief accepts a symbol subset without breaking the default', () => {
  // Pure structural check — no network. Confirms the signature the gold brief
  // depends on still exists and that Y.SYMBOLS has the key it passes.
  assert.equal(typeof MB.buildBrief, 'function');
  assert.ok(Y.SYMBOLS.MGC, 'gold-brief.js calls buildBrief({symbols:["MGC"]})');
  assert.equal(Y.SYMBOLS.MGC.y, 'MGC=F');
});
