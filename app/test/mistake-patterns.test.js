'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { checkTradeCountEscalation, F1_WIN_THRESHOLD } = require('../mistake-patterns.js');

test('F1_WIN_THRESHOLD is 2, matching the documented "stop at 2 good trades" text', () => {
  assert.equal(F1_WIN_THRESHOLD, 2);
});

test('no trades: no match', () => {
  const r = checkTradeCountEscalation([]);
  assert.equal(r.matched, false);
  assert.equal(r.winCount, 0);
  assert.equal(r.message, null);
});

test('one winning trade: no match yet', () => {
  const r = checkTradeCountEscalation([{ pnl: 50 }]);
  assert.equal(r.matched, false);
  assert.equal(r.winCount, 1);
});

test('two winning trades: matches, cites the pattern text', () => {
  const r = checkTradeCountEscalation([{ pnl: 50 }, { pnl: 20 }]);
  assert.equal(r.matched, true);
  assert.equal(r.winCount, 2);
  assert.match(r.message, /PATTERN F1/);
  assert.match(r.message, /stop at 2 good trades/i);
  assert.match(r.message, /2 winning trades today/);
});

test('losses do not count toward the win threshold', () => {
  const r = checkTradeCountEscalation([{ pnl: -50 }, { pnl: -20 }, { pnl: -10 }]);
  assert.equal(r.matched, false);
  assert.equal(r.winCount, 0);
});

test('a mix of wins and losses: only wins count', () => {
  const r = checkTradeCountEscalation([{ pnl: 50 }, { pnl: -20 }, { pnl: 30 }, { pnl: -5 }]);
  assert.equal(r.winCount, 2);
  assert.equal(r.matched, true);
  assert.equal(r.totalCount, 4);
});

test('a zero-pnl trade (breakeven) does not count as a win', () => {
  const r = checkTradeCountEscalation([{ pnl: 0 }, { pnl: 0 }, { pnl: 0 }]);
  assert.equal(r.winCount, 0);
  assert.equal(r.matched, false);
});

test('backfilled trades with pnlUnknown are excluded from the win count', () => {
  const r = checkTradeCountEscalation([
    { pnl: 0, pnlUnknown: true, source: 'backfilled-from-orders' },
    { pnl: 50 },
  ]);
  assert.equal(r.winCount, 1, 'the pnlUnknown trade must not be counted as a win just because pnl is 0');
  assert.equal(r.matched, false);
});

test('three wins still matches (threshold is >=, not exact)', () => {
  const r = checkTradeCountEscalation([{ pnl: 10 }, { pnl: 10 }, { pnl: 10 }]);
  assert.equal(r.matched, true);
  assert.equal(r.winCount, 3);
});

test('garbage input never throws', () => {
  assert.equal(checkTradeCountEscalation(null).matched, false);
  assert.equal(checkTradeCountEscalation(undefined).matched, false);
  assert.equal(checkTradeCountEscalation('nope').matched, false);
  assert.equal(checkTradeCountEscalation([null, undefined, {}, { pnl: 'x' }]).matched, false);
});
