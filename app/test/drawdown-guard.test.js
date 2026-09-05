'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { headroomState } = require('../drawdown-guard');
const R = { sizeCap: 2, drawdownGuard: { reduceAt: 500, standDownAt: 250 } };
test('normal headroom', () => { const r = headroomState({ balance: 52000, floor: 50000, rules: R }); assert.equal(r.level, 'normal'); assert.equal(r.effectiveCap, 2); assert.equal(r.tradingAllowed, true); });
test('reduce at 500', () => { const r = headroomState({ balance: 50500, floor: 50000, rules: R }); assert.equal(r.level, 'reduce'); assert.equal(r.effectiveCap, 1); });
test('stand-down at 250', () => { const r = headroomState({ balance: 50250, floor: 50000, rules: R }); assert.equal(r.level, 'stand-down'); assert.equal(r.tradingAllowed, false); });
test('unreadable', () => { const r = headroomState({ balance: null, floor: 50000, rules: R }); assert.equal(r.level, null); assert.equal(r.tradingAllowed, null); });
