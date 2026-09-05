'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHourEdge } = require('../hour-edge.js');

test('buckets trades by IST entry hour with win/loss/net/winPct', () => {
  const days = [{ rows: [
    { t: Date.parse('2026-08-10T13:30:00+05:30'), pnl: 40 },  // 13:30 IST → hour 13
    { t: Date.parse('2026-08-10T13:45:00+05:30'), pnl: -20 }, // hour 13
    { t: Date.parse('2026-08-10T19:15:00+05:30'), pnl: 10 },  // 19:15 → hour 19
  ] }];
  const edge = buildHourEdge(days);
  assert.equal(edge[13].n, 2);
  assert.equal(edge[13].wins, 1);
  assert.equal(edge[13].losses, 1);
  assert.equal(edge[13].winPct, 50);
  assert.equal(edge[13].net, 20);
  assert.equal(edge[19].n, 1);
  assert.equal(edge[19].winPct, 100);
});

test('empty and malformed input are safe', () => {
  assert.deepEqual(buildHourEdge(null), {});
  assert.deepEqual(buildHourEdge([{ rows: [{ t: 'bad', pnl: 1 }, { t: 5 }] }]), {});
});

// ── Sample-size floor (2026-08-31 audit) ─────────────────────────────────────
// buildHourEdge always recorded `n` correctly; the CONSUMER dropped it, writing
// "hourEdge: 100" onto 13 real signal rows off a single 12:00 IST trade. These
// pin the floor so that annotation cannot come back.

test('reliableWinPct: refuses to quote a win% from a thin sample', () => {
  const { reliableWinPct, MIN_SAMPLE } = require('../hour-edge');
  assert.strictEqual(reliableWinPct({ n: 1, winPct: 100 }), null, 'one trade is not a 100% win rate');
  assert.strictEqual(reliableWinPct({ n: 2, winPct: 50 }), null);
  assert.strictEqual(reliableWinPct({ n: MIN_SAMPLE - 1, winPct: 50 }), null, 'just below the floor');
  assert.strictEqual(reliableWinPct({ n: MIN_SAMPLE, winPct: 40 }), 40, 'at the floor it may be quoted');
  assert.strictEqual(reliableWinPct({ n: 16, winPct: 69 }), 69);
});

test('reliableWinPct: null-safe, and never invents a number', () => {
  const { reliableWinPct } = require('../hour-edge');
  assert.strictEqual(reliableWinPct(null), null);
  assert.strictEqual(reliableWinPct(undefined), null);
  assert.strictEqual(reliableWinPct({}), null, 'no n means no quote');
  assert.strictEqual(reliableWinPct({ n: 99 }), null, 'n without winPct is still no quote');
  assert.strictEqual(reliableWinPct({ n: 10, winPct: 0 }), 0, 'a real 0% must survive — it is not missing data');
});

test('reliableWinPct: the floor is overridable but defaults conservatively', () => {
  const { reliableWinPct, MIN_SAMPLE } = require('../hour-edge');
  assert.ok(MIN_SAMPLE >= 5, 'the floor must not be loosened below 5 without re-deriving it');
  assert.strictEqual(reliableWinPct({ n: 3, winPct: 66 }, 3), 66, 'an explicit lower floor is honoured');
});
