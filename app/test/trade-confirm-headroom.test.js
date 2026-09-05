'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkTradeAllowed } = require('../trade-confirm-rules');
const R = { sizeCap: 2, sizeFloor: 2, tradesPerDay: 5, drawdownGuard: { reduceAt: 500, standDownAt: 250 } };
test('headroom stand-down blocks orders', () => {
  const r = checkTradeAllowed(R, 'eval', [], 2, { balance: 50250, floor: 50000 });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /stand-down/);
});
test('headroom reduce halves the cap', () => {
  const r = checkTradeAllowed(R, 'eval', [], 2, { balance: 50500, floor: 50000 });
  assert.equal(r.allowed, false); // qty 2 > effectiveCap 1
  assert.match(r.reason, /reduces the size cap/);
});
test('headroom normal does not block', () => {
  const r = checkTradeAllowed(R, 'eval', [], 2, { balance: 52000, floor: 50000 });
  assert.equal(r.allowed, true);
});
test('no account passed → headroom gate skipped', () => {
  const r = checkTradeAllowed(R, 'eval', [], 2);
  assert.equal(r.allowed, true);
});
