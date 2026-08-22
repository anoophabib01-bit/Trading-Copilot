'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { payoutPace, HORIZON_SESSIONS } = require('../renderer/payout-pace.js');

test('computes distance, trailing rate, days-to-target and fixed-horizon need', () => {
  const p = payoutPace({ balance: 52100, payoutTarget: 52600, trailing20DayNet: 500 });
  assert.equal(p.distance, 500);
  assert.equal(p.dailyRate, 25);       // 500/20
  assert.equal(p.daysToTarget, 20);    // 500/25
  assert.equal(p.needPerDay, 25);      // 500/20
});

test('negative distance (already past target) is zero need, null days', () => {
  const p = payoutPace({ balance: 53000, payoutTarget: 52600, trailing20DayNet: 100 });
  assert.equal(p.distance, -400);
  assert.equal(p.daysToTarget, null);
  assert.equal(p.needPerDay, 0);
});

test('zero or negative trailing rate → daysToTarget null (honest, not divided)', () => {
  const p = payoutPace({ balance: 52000, payoutTarget: 52600, trailing20DayNet: -200 });
  assert.equal(p.dailyRate, -10);
  assert.equal(p.daysToTarget, null);
  assert.equal(p.needPerDay, 30);
});

test('invalid inputs → null', () => {
  assert.equal(payoutPace({ balance: null, payoutTarget: 52600 }), null);
  assert.equal(payoutPace({ balance: 52000 }), null);
});
