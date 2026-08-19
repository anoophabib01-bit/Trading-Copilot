'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkTradeAllowed } = require('../trade-confirm-rules.js');

const RULES = { sizeCap: 2, sizeFloor: 2, tradesPerDay: 5, dailyLossCap: 200, dayStop: { eval: 1500, funded: 200 } };

test('rejects an invalid/non-positive size', () => {
  assert.equal(checkTradeAllowed(RULES, 'funded', [], 0).allowed, false);
  assert.equal(checkTradeAllowed(RULES, 'funded', [], -1).allowed, false);
  assert.equal(checkTradeAllowed(RULES, 'funded', [], NaN).allowed, false);
});

test('rejects a size above sizeCap', () => {
  const r = checkTradeAllowed(RULES, 'funded', [], 3);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /exceeds sizeCap/);
});

test('rejects a size below sizeFloor', () => {
  const r = checkTradeAllowed(RULES, 'funded', [], 1);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /sizeFloor/);
});

test('allows a size within cap/floor with no other violations', () => {
  const r = checkTradeAllowed(RULES, 'funded', [], 2);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, null);
});

test('rejects once tradesPerDay is already hit', () => {
  const trades = Array.from({ length: 5 }, () => ({ size: 2, pnl: 50 }));
  const r = checkTradeAllowed(RULES, 'funded', trades, 2);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /already 5 trades/);
});

test('rejects once day P&L is at/past dailyLossCap (funded)', () => {
  const trades = [{ size: 2, pnl: -200 }];
  const r = checkTradeAllowed(RULES, 'funded', trades, 2);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /day-stop/);
});

test('falls back to dayStop[stage] when dailyLossCap is absent', () => {
  const rulesNoCap = { sizeCap: 2, sizeFloor: 2, tradesPerDay: 5, dayStop: { eval: 1500, funded: 200 } };
  const trades = [{ size: 2, pnl: -200 }];
  const r = checkTradeAllowed(rulesNoCap, 'funded', trades, 2);
  assert.equal(r.allowed, false);
  const rEval = checkTradeAllowed(rulesNoCap, 'eval', trades, 2);
  assert.equal(rEval.allowed, true); // -200 doesn't breach eval's -1500
});

test('rejects a size-up immediately after a loss', () => {
  const trades = [{ size: 2, pnl: -50 }];
  const r = checkTradeAllowed({ sizeCap: 4, sizeFloor: 1, tradesPerDay: 5, dailyLossCap: 1500 }, 'funded', trades, 3);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /size-up after a loss/);
});

test('allows the same size after a loss (not a size-up)', () => {
  const trades = [{ size: 2, pnl: -50 }];
  const r = checkTradeAllowed(RULES, 'funded', trades, 2);
  assert.equal(r.allowed, true);
});

test('a clean day at exactly sizeCap and under every other limit is allowed', () => {
  const trades = [{ size: 2, pnl: 60 }, { size: 2, pnl: -30 }];
  const r = checkTradeAllowed(RULES, 'funded', trades, 2);
  assert.equal(r.allowed, true);
});

test('missing/garbage rules object does not throw and fails safe (no cap = infinite, still checks size-freeze)', () => {
  assert.doesNotThrow(() => checkTradeAllowed(null, 'funded', [], 2));
  assert.doesNotThrow(() => checkTradeAllowed({}, 'funded', undefined, 2));
});
