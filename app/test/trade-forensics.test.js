'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tradeForensics, entryPctOfRange, postExitMove, assertWinnerInvariant } = require('../trade-forensics');
const LONG_BARS = [
  { time: 1000, high: 100, low: 97, close: 98 },
  { time: 1001, high: 99, low: 96, close: 97 },
  { time: 1002, high: 101, low: 98, close: 100 },
  { time: 1003, high: 105, low: 100, close: 104 },
  { time: 1004, high: 106, low: 103, close: 105 },
];
test('long that goes against then works', () => {
  const t = { side: 'buy', ep: 99, entryAt: 1000000, exitAt: 1004000 };
  const r = tradeForensics(t, LONG_BARS, { tf: '1' });
  assert.equal(r.mae, 3);
  assert.equal(r.mfe, 7);
  assert.equal(r.forensicsTf, '1');
});
test('short mirrors the sign', () => {
  const t = { side: 'sell', ep: 100, entryAt: 1000000, exitAt: 1004000 };
  const r = tradeForensics(t, LONG_BARS, { tf: '1' });
  assert.equal(r.mae, 6);
  assert.equal(r.mfe, 4);
});
test('no bars covering is null with a reason, never zero', () => {
  const r = tradeForensics({ side: 'buy', ep: 99, entryAt: 9999000, exitAt: 99999000 }, LONG_BARS);
  assert.equal(r.mae, null);
  assert.match(r.forensicsReason, /no bars/);
});
test('missing side is null with a reason', () => {
  const r = tradeForensics({ ep: 99, entryAt: 1000000, exitAt: 1004000 }, LONG_BARS);
  assert.equal(r.mae, null);
  assert.match(r.forensicsReason, /missing/);
});
test('entryPctOfRange 0/1/breakout', () => {
  assert.equal(entryPctOfRange(100, 110, 100), 0);
  assert.equal(entryPctOfRange(110, 110, 100), 1);
  assert.equal(entryPctOfRange(120, 110, 100), 2);
});
test('postExitMove 30-min anchored at exit', () => {
  const t = { side: 'buy', xp: 104, exitAt: 1004000 };
  const bars = [{ time: 1005, high: 108, low: 103, close: 107 }, { time: 1006, high: 109, low: 106, close: 108 }];
  const r = postExitMove(t, bars);
  assert.equal(r.post30Mfe, 5);
  assert.equal(r.post30Close, 108);
});test('X6: a winner whose pnl exceeds its mfe ceiling is refused', () => {
  const r = assertWinnerInvariant({ pnl: 500, size: 1 }, { mfe: 2 }, 1);
  assert.equal(r.valid, false);
  assert.match(r.reason, /ceiling/);
});
test('X6: a plausible winner passes the invariant', () => {
  const r = assertWinnerInvariant({ pnl: 20, size: 2 }, { mfe: 15 }, 1);
  assert.equal(r.valid, true);
});
