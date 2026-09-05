'use strict';
const test = require('node:test');
const assert = require('node:assert');
const DE = require('../drift-edge');

// Build n pairs in a score bucket, `wins` of which won.
function pairs(score, n, wins, pnl) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const win = i < wins;
    out.push({ score, nextWin: win, nextPnl: win ? (pnl || 50) : -(pnl || 50), nextPnlPerContract: win ? (pnl || 50) : -(pnl || 50), date: '2026-08-17' });
  }
  return out;
}

test('a bucket under minSamples reports NO probability at all', () => {
  const out = DE.evaluateDriftEdge(pairs(9, 12, 7));
  const dec = out.buckets.find(b => b.key === 'decisive');
  assert.strictEqual(dec.n, 12);
  assert.strictEqual(dec.winRate, null, 'a provisional rate is the one that gets acted on');
  assert.strictEqual(dec.verdict, DE.VERDICT.INSUFFICIENT);
  assert.match(dec.note, /needs 30/);
});

test('overlapping intervals are NOT an edge, however tempting the gap looks', () => {
  // 68% vs 53% on n=40 each — a 15-point gap that is still just noise.
  const out = DE.evaluateDriftEdge(pairs(9, 40, 27).concat(pairs(2, 40, 21)));
  assert.strictEqual(out.verdict, DE.VERDICT.NO_EDGE);
  assert.strictEqual(out.separation.intervalsDisjoint, false);
  assert.match(out.summary, /OVERLAP/);
  assert.match(out.summary, /consistent with chance/);
});

test('a genuine, large separation IS confirmed', () => {
  const out = DE.evaluateDriftEdge(pairs(9, 60, 51).concat(pairs(2, 60, 15)));
  assert.strictEqual(out.verdict, DE.VERDICT.CONFIRMED);
  assert.strictEqual(out.separation.intervalsDisjoint, true);
  assert.match(out.summary, /do not overlap/);
});

test('one usable bucket is not enough to compare anything', () => {
  const out = DE.evaluateDriftEdge(pairs(9, 60, 40));
  assert.strictEqual(out.verdict, DE.VERDICT.INSUFFICIENT);
  assert.match(out.summary, /answers itself with time, not with argument/);
});

test('no pairs at all is handled honestly', () => {
  const out = DE.evaluateDriftEdge([]);
  assert.strictEqual(out.verdict, DE.VERDICT.INSUFFICIENT);
  assert.strictEqual(out.pairs, 0);
});

test('Wilson interval stays inside [0,1] where the normal approximation would not', () => {
  const w = DE.wilson(12, 12, 1.96);   // 100% on n=12
  assert.ok(w.hi <= 1, 'never above 1');
  assert.ok(w.lo < 1, 'and does not claim certainty from 12 samples');
  assert.ok(w.lo < 0.8, 'a 12-for-12 run is still not proof of an 80% edge');
});

test('buildPairs never pairs across a day boundary', () => {
  const trades = [
    { x: 1, pnl: 10, size: 1, date: '2026-08-17' },
    { x: 2, pnl: -5, size: 1, date: '2026-08-17' },
    { x: 3, pnl: 20, size: 1, date: '2026-08-18' },   // new day — no pair from the previous
  ];
  const built = DE.buildPairs(trades, () => 7);
  assert.strictEqual(built.length, 1);
  assert.strictEqual(built[0].nextPnl, -5);
});

test('buildPairs drops pairs where the drift refused to read', () => {
  const trades = [
    { x: 1, pnl: 10, size: 1, date: 'd' }, { x: 2, pnl: -5, size: 1, date: 'd' }, { x: 3, pnl: 8, size: 1, date: 'd' },
  ];
  const built = DE.buildPairs(trades, (i) => (i === 0 ? null : 6));
  assert.strictEqual(built.length, 1, 'a null score is not a zero score');
  assert.strictEqual(built[0].nextPnl, 8);
});

test('outcomes are measured PER CONTRACT, not per trade', () => {
  const trades = [
    { x: 1, pnl: 10, size: 1, date: 'd' },
    { x: 2, pnl: 100, size: 4, date: 'd' },
  ];
  const built = DE.buildPairs(trades, () => 8);
  assert.strictEqual(built[0].nextPnlPerContract, 25, 'else the score is credited for how big he bet');
});

test('sizeSuggestion returns nothing until the edge is CONFIRMED', () => {
  const noEdge = DE.evaluateDriftEdge(pairs(9, 40, 27).concat(pairs(2, 40, 21)));
  assert.strictEqual(DE.sizeSuggestion(noEdge, 9, { sizeCap: 2 }), null);
  assert.strictEqual(DE.sizeSuggestion(null, 9, { sizeCap: 2 }), null);
});

test('sizeSuggestion NEVER exceeds sizeCap, even on a confirmed edge', () => {
  const edge = DE.evaluateDriftEdge(pairs(9, 60, 51).concat(pairs(2, 60, 15)));
  const s = DE.sizeSuggestion(edge, 9, { sizeCap: 2, sizeFloor: 1 });
  assert.ok(s, 'a confirmed edge does produce a suggestion');
  assert.strictEqual(s.size, 2);
  assert.strictEqual(s.cappedAt, 2);
  assert.match(s.because, /never the cap itself/);
});

test('a confirmed edge suggests nothing for a score OUTSIDE the winning bucket', () => {
  const edge = DE.evaluateDriftEdge(pairs(9, 60, 51).concat(pairs(2, 60, 15)));
  assert.strictEqual(DE.sizeSuggestion(edge, 2, { sizeCap: 2 }), null, 'the losing bucket earns nothing');
});

test('expectancy is reported alongside win rate, since a high win rate can still lose money', () => {
  // 70% winners at +$10, 30% losers at -$100 — wins often, loses overall.
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ score: 9, nextWin: i < 28, nextPnl: i < 28 ? 10 : -100, nextPnlPerContract: i < 28 ? 10 : -100, date: 'd' });
  const out = DE.evaluateDriftEdge(rows);
  const dec = out.buckets.find(b => b.key === 'decisive');
  assert.strictEqual(dec.winRate, 0.7);
  assert.ok(dec.expectancy < 0, 'win rate alone would have called this a good bucket');
});
