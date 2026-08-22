'use strict';
// 4.5 landmine test: the same trade expressed in live-ms and CSV-coarse
// timestamps must match by tolerance identity — reconciling a live-written
// day with its own CSV must NOT double the trade count.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSameTrade, matchCsvToLive } = require('../renderer/trade-identity.js');

const liveRow = { t: 1787054976000, x: 1787299474000, size: 3, pnl: 12, side: 'LONG' };

test('same trade matches across live-ms vs CSV-coarse timestamps', () => {
  const csvRow = { t: 1787054970000, x: 1787299465000, size: 3, pnl: 12, side: 'LONG' };
  assert.equal(isSameTrade(csvRow, liveRow), true);
});

test('a different trade does not match (exit too far, size differs)', () => {
  assert.equal(isSameTrade({ t: 0, x: 1787299474000 + 5 * 60000, size: 3, pnl: 12, side: 'LONG' }, liveRow), false);
  assert.equal(isSameTrade({ t: 0, x: 1787299474000, size: 2, pnl: 12, side: 'LONG' }, liveRow), false);
  assert.equal(isSameTrade({ t: 0, x: 1787299474000, size: 3, pnl: 12, side: 'SHORT' }, liveRow), false);
});

test('P&L disagreement beyond a cent does not match by identity', () => {
  assert.equal(isSameTrade({ t: 0, x: 1787299474000, size: 3, pnl: 12.5, side: 'LONG' }, liveRow), false);
});

test('reconciling a live-written day with its own CSV doubles nothing', () => {
  const live = [
    { t: 1787054976000, x: 1787299474000, size: 3, pnl: 12, side: 'LONG' },
    { t: 1787055000000, x: 1787300000000, size: 2, pnl: -5, side: 'SHORT' },
  ];
  const csv = [
    { t: 1787054970000, x: 1787299465000, size: 3, pnl: 12, side: 'LONG' },   // coarse timestamps
    { t: 1787054994000, x: 1787299994000, size: 2, pnl: -5, side: 'SHORT' },
  ];
  const r = matchCsvToLive(csv, live);
  assert.equal(r.matched.length, 2);
  assert.equal(r.csvOnly.length, 0);
  assert.equal(r.liveOnly.length, 0);
});

test('a CSV-only trade is reported, not silently dropped or doubled', () => {
  const r = matchCsvToLive([{ t: 0, x: 1787400000000, size: 1, pnl: 7, side: 'LONG' }], [liveRow]);
  assert.equal(r.matched.length, 0);
  assert.equal(r.csvOnly.length, 1);
  assert.equal(r.liveOnly.length, 1);
});

test('one-to-one: two identical CSV rows cannot both match one live row', () => {
  const csv = [
    { t: 1787054970000, x: 1787299465000, size: 3, pnl: 12, side: 'LONG' },
    { t: 1787054970000, x: 1787299465000, size: 3, pnl: 12, side: 'LONG' },
  ];
  const r = matchCsvToLive(csv, [liveRow]);
  assert.equal(r.matched.length, 1);
  assert.equal(r.csvOnly.length, 1);
});
