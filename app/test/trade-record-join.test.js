'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { joinFoldToWalk, DEFAULT_TOLERANCE_MS } = require('../trade-record-join.js');

const foldT = (at, size, pnl, extra) => Object.assign({ at, size, pnl, evidence: 'fold', inferred: false, pnlUnknown: false }, extra);
const walkT = (exitAt, size, extra) => Object.assign({
  symbol: 'MNQU6', side: 'buy', size, entryPrice: 21800, exitPrice: 21820,
  entryAt: exitAt - 60000, exitAt, at: exitAt, pnl: 0, pnlUnknown: true, source: 'backfilled-from-orders'
}, extra);

test('exact pair joins into one record carrying both halves', () => {
  const r = joinFoldToWalk([foldT(1000000, 2, 35.5)], [walkT(1005000, 2)]);
  assert.equal(r.merged.length, 1);
  assert.equal(r.unmatchedWalk.length, 0);
  const rec = r.merged[0];
  assert.equal(rec.symbol, 'MNQU6');
  assert.equal(rec.side, 'buy');
  assert.equal(rec.pnl, 35.5);
  assert.equal(rec.entryPrice, 21800);
  assert.equal(rec.exitPrice, 21820);
  assert.equal(rec.source, 'live-fold+order-walk');
  assert.equal(rec.pnlUnknown, false);
  assert.equal(rec.evidence, 'fold');
});

test('size mismatch loses to size-equal even when further in time', () => {
  const folds = [foldT(1000000, 3, -10)];
  const walks = [
    walkT(1010000, 5, { side: 'sell' }),   // closer in time, wrong size
    walkT(1150000, 3, { side: 'sell' }),   // 2.5 min away, right size — still within tolerance
  ];
  const r = joinFoldToWalk(folds, walks);
  assert.equal(r.merged.length, 1);
  assert.equal(r.merged[0].side, 'sell');
  assert.equal(r.merged[0].size, 3);
  assert.equal(r.unmatchedWalk.length, 1); // the size-5 close stays as order-walk-only
});

test('walk close outside tolerance stays a separate order-walk-only record', () => {
  const r = joinFoldToWalk([foldT(1000000, 2, 10)], [walkT(20000000, 2)]);
  assert.equal(r.merged.length, 0);
  assert.equal(r.unmatchedWalk.length, 1);
  assert.equal(r.records.length, 2);
  assert.equal(r.records.find(x => x.source === 'order-walk-only').pnlUnknown, true);
});

test('degraded provenance survives the join', () => {
  const r = joinFoldToWalk([foldT(1000000, 0, -44.65, { evidence: 'degraded', inferred: true, size: 0 })], [walkT(1005000, 0)]);
  const rec = r.merged[0];
  assert.equal(rec.evidence, 'degraded');
  assert.equal(rec.inferred, true);
});

test('records are sorted by close time across both sources', () => {
  const folds = [foldT(3000000, 1, 5), foldT(1000000, 1, 4)];
  const walks = [walkT(20000000, 1, { symbol: 'MGCQ6' })];
  const r = joinFoldToWalk(folds, walks);
  const times = r.records.map(x => x.at || x.exitAt);
  assert.deepEqual(times, [1000000, 3000000, 20000000]);
});

test('empty inputs are safe', () => {
  assert.deepEqual(joinFoldToWalk(null, null).records, []);
  assert.deepEqual(joinFoldToWalk([], []).records, []);
});

test('default tolerance is 3 minutes', () => {
  assert.equal(DEFAULT_TOLERANCE_MS, 3 * 60 * 1000);
});
