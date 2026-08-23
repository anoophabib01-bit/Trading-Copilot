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
