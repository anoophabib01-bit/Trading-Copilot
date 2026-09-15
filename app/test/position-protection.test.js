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
// --- G32 (2026-09-15): the parse that a live test caught. This broker prints losses with a
// UNICODE MINUS, and the old parser stripped it - turning -19.00 into +19.00, so the per-trade
// stop compared a PROFIT against a loss cap and never fired. These are the real string shapes.
const { parseMoney } = require('../position-protection.js');

test('parseMoney: a unicode-minus loss stays NEGATIVE (the bug this exists for)', () => {
  assert.equal(parseMoney('\u221219.00\nUSD'), -19);
  assert.equal(parseMoney('\u22122.50 USD'), -2.5);
  assert.equal(parseMoney('\u2212128.75'), -128.75);
});

test('parseMoney: profits and ASCII negatives', () => {
  assert.equal(parseMoney('+89.50\nUSD'), 89.5);
  assert.equal(parseMoney('-3.50 USD'), -3.5);
  assert.equal(parseMoney('0.00'), 0);
});

test('parseMoney: commas and accounting parentheses', () => {
  assert.equal(parseMoney('1,234.56'), 1234.56);
  assert.equal(parseMoney('(19.00)'), -19);
});

test('parseMoney: no number returns NULL, never 0 - a 0 would read as break-even', () => {
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney(undefined), null);
  assert.equal(parseMoney('USD'), null);
  assert.equal(parseMoney('\u2212'), null);
});
// --- G32 (2026-09-15): the casing bug that cost a live test. oversize-guard.netPosition returns
// side UPPERCASE, both guards compared it to lowercase, so the closing side was always null and
// the acting branch was skipped in silence. The per-trade stop never closed anything.
const { closingSideFor } = require('../position-protection.js');

test('closingSideFor: UPPERCASE (what netPosition actually returns) resolves', () => {
  assert.equal(closingSideFor('LONG'), 'sell');
  assert.equal(closingSideFor('SHORT'), 'buy');
});

test('closingSideFor: any casing or the broker wording works', () => {
  assert.equal(closingSideFor('long'), 'sell');
  assert.equal(closingSideFor('Long'), 'sell');
  assert.equal(closingSideFor('buy'), 'sell');
  assert.equal(closingSideFor('SELL'), 'buy');
  assert.equal(closingSideFor(' s '), 'buy');
});

test('closingSideFor: unknown returns NULL - never a guessed direction', () => {
  assert.equal(closingSideFor(''), null);
  assert.equal(closingSideFor(null), null);
  assert.equal(closingSideFor('?'), null);
  assert.equal(closingSideFor(undefined), null);
});