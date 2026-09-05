'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { statsFor, expectancyBy } = require('../expectancy');

test('single-trade tag', () => {
  const s = statsFor([{ pnl: 100, size: 2 }]);
  assert.equal(s.n, 1);
  assert.equal(s.winRate, 1);
  assert.equal(s.totalPnl, 100);
  assert.equal(s.expectancyPerContract, 50);
});

test('all-losers tag', () => {
  const s = statsFor([{ pnl: -50, size: 1 }, { pnl: -100, size: 2 }]);
  assert.equal(s.winRate, 0);
  assert.equal(s.avgWin, null);
  assert.equal(s.avgLoss, 75);
});

test('mixed sizes prove per-contract normalisation changes the answer', () => {
  // Same 2 trades, but re-sized: per-trade expectancy is identical, per-contract differs.
  const big = statsFor([{ pnl: 100, size: 10 }, { pnl: -50, size: 5 }]);
  const small = statsFor([{ pnl: 100, size: 1 }, { pnl: -50, size: 1 }]);
  assert.equal(big.expectancyPerTrade, small.expectancyPerTrade); // both 25
  assert.notEqual(big.expectancyPerContract, small.expectancyPerContract);
});

test('sum of totalPnl across a dimension equals the book total', () => {
  const trades = [
    { pnl: 100, size: 2, playbook: 'A' },
    { pnl: -40, size: 2, playbook: 'B' },
    { pnl: 60, size: 2, playbook: 'A' },
  ];
  const byPb = expectancyBy(trades, (t) => t.playbook);
  const sum = byPb.reduce((a, r) => a + r.totalPnl, 0);
  assert.equal(sum, 120); // no double count
});

test('underMin flag when n below the minimum', () => {
  const trades = [{ pnl: 10, size: 1, tag: 'x' }];
  const r = expectancyBy(trades, (t) => t.tag, 5);
  assert.equal(r[0].underMin, true);
});