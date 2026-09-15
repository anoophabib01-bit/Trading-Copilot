'use strict';
// G28 (2026-09-15): a positions table that renders its empty-state placeholder is
// NOT the same as a flat account. These pin the distinction that cost Anoop 16
// minutes of visibility on a live position.
const test = require('node:test');
const assert = require('node:assert');
const { classify } = require('../positions-read-quality.js');

test('a genuinely flat account (no rows, no evidence) is flat', () => {
  const v = classify({ positionsSuccess: true, positionCount: 0, workingExitOrders: 0, walkNetQty: 0, summaryOpenPnl: 0 });
  assert.strictEqual(v.state, 'flat');
  assert.strictEqual(v.contradiction, false);
});

test('open rows are open', () => {
  assert.strictEqual(classify({ positionsSuccess: true, positionCount: 1 }).state, 'open');
});

test('THE 2026-09-14 CASE: empty table + a working stop order is UNREADABLE, never flat', () => {
  const v = classify({ positionsSuccess: true, positionCount: 0, workingExitOrders: 2, walkNetQty: 0, summaryOpenPnl: 0 });
  assert.strictEqual(v.state, 'unreadable');
  assert.strictEqual(v.contradiction, true);
  assert.match(v.reason, /take-profit|stop-loss/);
});

test('empty table + a non-zero filled-order walk is UNREADABLE', () => {
  const v = classify({ positionsSuccess: true, positionCount: 0, workingExitOrders: 0, walkNetQty: 1 });
  assert.strictEqual(v.state, 'unreadable');
  assert.strictEqual(v.contradiction, true);
});

test('a SHORT net (-1) counts as evidence just like a long (+1)', () => {
  assert.strictEqual(classify({ positionsSuccess: true, positionCount: 0, walkNetQty: -1 }).state, 'unreadable');
});

test('open P&L alone is only suspect — a lagging close must not refuse the poll', () => {
  const v = classify({ positionsSuccess: true, positionCount: 0, workingExitOrders: 0, walkNetQty: 0, summaryOpenPnl: 98.5 });
  assert.strictEqual(v.state, 'suspect');
  assert.strictEqual(v.contradiction, false);
});

test('an unreadable table stays unreadable via the success flag', () => {
  const v = classify({ positionsSuccess: false, positionCount: 0 });
  assert.strictEqual(v.state, 'unreadable');
});

test('working exits beat a flat-looking walk — evidence of either is enough', () => {
  assert.strictEqual(classify({ positionsSuccess: true, positionCount: 0, workingExitOrders: 1, walkNetQty: 0 }).state, 'unreadable');
});

test('missing/undefined input degrades to flat rather than throwing', () => {
  assert.strictEqual(classify(undefined).state, 'flat');
  assert.strictEqual(classify({}).state, 'flat');
  assert.strictEqual(classify({ positionsSuccess: true, positionCount: 0, workingExitOrders: null, walkNetQty: undefined, summaryOpenPnl: NaN }).state, 'flat');
});
