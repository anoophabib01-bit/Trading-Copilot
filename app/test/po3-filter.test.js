'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { filterPo3Transitions } = require('../po3-filter');
test('repeats collapse to one transition', () => {
  const out = filterPo3Transitions([
    { event: 'po3-phase-change', symbol: 'MNQ', direction: 'bullish' },
    { event: 'po3-phase-change', symbol: 'MNQ', direction: 'bullish' },
    { event: 'po3-phase-change', symbol: 'MNQ', direction: 'bullish' },
    { event: 'po3-phase-change', symbol: 'MNQ', direction: 'bearish' },
    { event: 'po3-phase-change', symbol: 'MNQ', direction: 'bearish' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].direction, 'bullish');
  assert.equal(out[1].direction, 'bearish');
});
test('per-symbol, not global', () => {
  assert.equal(filterPo3Transitions([
    { event: 'po3-phase-change', symbol: 'MNQ', direction: 'bullish' },
    { event: 'po3-phase-change', symbol: 'MGC', direction: 'bullish' },
  ]).length, 2);
});
test('non-po3 events ignored', () => {
  assert.equal(filterPo3Transitions([{ event: 'fvg-fire' }, { event: 'po3-phase-change', symbol: 'MNQ', direction: 'bullish' }]).length, 1);
});
