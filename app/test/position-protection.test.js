'use strict';
// App-side protection: close at -200 / +600. These pin the three things that decide whether
// a live trade is protected or quietly abandoned: the DIRECTION of the P&L, the ONE-attempt
// latch, and that unreadable is reported as blind rather than as nothing-to-do.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { decide, unrealisedUsd } = require('../position-protection.js');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
const base = { side: 'Long', size: 1, entryPrice: 29200, pointValue: 2, stopLossUsd: 200, takeProfitUsd: 600 };

test('a long at -200 closes', () => {
  const d = decide(Object.assign({}, base, { unrealisedUsd: -200 }));
  assert.equal(d.action, 'close');
  assert.match(d.reason, /^STOP/);
});

test('a long at +600 closes', () => {
  const d = decide(Object.assign({}, base, { unrealisedUsd: 600 }));
  assert.equal(d.action, 'close');
  assert.match(d.reason, /^TARGET/);
});

test('inside the band does nothing', () => {
  assert.equal(decide(Object.assign({}, base, { unrealisedUsd: 120 })).action, 'none');
  assert.equal(decide(Object.assign({}, base, { unrealisedUsd: -199.99 })).action, 'none');
});

test('derives the P&L from prices when the broker figure is missing', () => {
  const d = decide(Object.assign({}, base, { unrealisedUsd: null, lastPrice: 29100 }));
  assert.equal(d.unrealisedUsd, -200);
  assert.equal(d.action, 'close');
  assert.equal(d.source, 'prices');
});

test('a SHORT profits when price falls - the direction must not be inverted', () => {
  const d = decide({ side: 'Short', size: 2, entryPrice: 29200, lastPrice: 29100, pointValue: 2, unrealisedUsd: null, stopLossUsd: 200, takeProfitUsd: 600 });
  assert.equal(d.unrealisedUsd, 400);
  assert.equal(d.action, 'none');
  const stop = decide({ side: 'Short', size: 2, entryPrice: 29200, lastPrice: 29300, pointValue: 2, unrealisedUsd: null, stopLossUsd: 200, takeProfitUsd: 600 });
  assert.equal(stop.action, 'close');
});

test('the latch: one attempt per position, never a machine gun', () => {
  const d = decide(Object.assign({}, base, { unrealisedUsd: -900, alreadyAttempted: true }));
  assert.equal(d.action, 'none');
  assert.equal(d.source, 'latch');
});

test('unreadable P&L is BLIND, not nothing-to-do', () => {
  const d = decide({ side: 'Long', size: 1, unrealisedUsd: null, stopLossUsd: 200, takeProfitUsd: 600, pointValue: 2 });
  assert.equal(d.action, 'blind');
  assert.match(d.reason, /unreadable/i);
});

test('flat does nothing and says so', () => {
  assert.equal(decide(Object.assign({}, base, { size: 0, unrealisedUsd: 0 })).action, 'none');
});

test('disabled in rules.json does nothing', () => {
  assert.equal(decide(Object.assign({}, base, { enabled: false, unrealisedUsd: -5000 })).action, 'none');
});

test('at 4 lots the same dollars are a quarter of the point distance', () => {
  const four = { side: 'Long', size: 4, entryPrice: 29200, pointValue: 2, unrealisedUsd: null, stopLossUsd: 200, takeProfitUsd: 600 };
  assert.equal(decide(Object.assign({}, four, { lastPrice: 29175 })).action, 'close');
  assert.equal(decide(Object.assign({}, four, { lastPrice: 29180 })).action, 'none');
});

test('the configured rule is the one these tests assume', () => {
  assert.equal(rules.autoProtection.stopLossUsd, 200);
  assert.equal(rules.autoProtection.takeProfitUsd, 600);
});