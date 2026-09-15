'use strict';
// Trade protection: Anoop's dollar rule (200 stop / 600 target) turned into broker prices.
// The two things these pin: the POINT VALUE must come from rules.json per instrument
// (MGC is $10/pt, MNQ $2/pt - a points figure that is right on one is 5x wrong on the
// other), and the DIRECTION is easy to invert (a long stop belongs BELOW entry).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { bracketFor, pointsForUsd, pointValueForSymbol } = require('../trade-protection.js');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));

test('a LONG 1 lot MNQ: 200 dollars = 100 points below, 600 = 300 points above', () => {
  const b = bracketFor({ side: 'buy', qty: 1, entryPrice: 29200, pointValue: 2, stopLossUsd: 200, takeProfitUsd: 600 });
  assert.equal(b.stopPoints, 100);
  assert.equal(b.targetPoints, 300);
  assert.equal(b.stopPrice, 29100);
  assert.equal(b.targetPrice, 29500);
  assert.equal(b.ratio, 3);
});

test('the same dollars at 4 lots is a quarter of the distance', () => {
  const b = bracketFor({ side: 'buy', qty: 4, entryPrice: 29200, pointValue: 2, stopLossUsd: 200, takeProfitUsd: 600 });
  assert.equal(b.stopPoints, 25);
  assert.equal(b.targetPoints, 75);
  assert.equal(b.stopPrice, 29175);
});

test('a SHORT is the mirror - stop ABOVE entry, target BELOW', () => {
  const b = bracketFor({ side: 'sell', qty: 1, entryPrice: 29200, pointValue: 2, stopLossUsd: 200, takeProfitUsd: 600 });
  assert.equal(b.stopPrice, 29300);
  assert.equal(b.targetPrice, 28900);
});

test('MGC is 10 dollars a point, so the same rule is a fifth of the distance', () => {
  const b = bracketFor({ side: 'buy', qty: 1, entryPrice: 4477, pointValue: 10, stopLossUsd: 200, takeProfitUsd: 600, tickSize: 0.1 });
  assert.equal(b.stopPoints, 20);
  assert.equal(b.targetPoints, 60);
  assert.equal(b.stopPrice, 4457);
  assert.equal(b.targetPrice, 4537);
});

test('prices snap to the tick when one is given', () => {
  const b = bracketFor({ side: 'buy', qty: 3, entryPrice: 29200.13, pointValue: 2, stopLossUsd: 200, takeProfitUsd: 600, tickSize: 0.25 });
  assert.equal(b.stopPrice % 0.25, 0);
  assert.equal(b.targetPrice % 0.25, 0);
});

test('refuses nonsense rather than inventing a price', () => {
  assert.throws(() => bracketFor({ side: 'hold', qty: 1, entryPrice: 29200, pointValue: 2, stopLossUsd: 200, takeProfitUsd: 600 }), /side must be/);
  assert.throws(() => bracketFor({ side: 'buy', qty: 0, entryPrice: 29200, pointValue: 2, stopLossUsd: 200, takeProfitUsd: 600 }), /qty must be/);
  assert.throws(() => bracketFor({ side: 'buy', qty: 1, entryPrice: 0, pointValue: 2, stopLossUsd: 200, takeProfitUsd: 600 }), /entryPrice must be/);
  assert.throws(() => pointsForUsd(200, 1, 0), /pointValue must be/);
});

test('point values come from rules.json contracts, keyed by symbol', () => {
  assert.equal(pointValueForSymbol(rules, 'MNQ'), 2);
  assert.equal(pointValueForSymbol(rules, 'MGC'), 10);
});

test('a rolled contract still finds its instrument spec (MNQZ6 -> MNQ)', () => {
  assert.equal(pointValueForSymbol(rules, 'MNQZ6'), 2);
  assert.equal(pointValueForSymbol(rules, 'MNQU6'), 2);
});

test('an unknown symbol REFUSES - it does not assume MNQ', () => {
  assert.throws(() => pointValueForSymbol(rules, 'ESZ6'), /refusing to guess/);
  assert.throws(() => pointValueForSymbol(rules, ''), /symbol is required/);
});

test('Anoop 2026-09-15 values are the ones actually configured', () => {
  assert.equal(rules.autoProtection.stopLossUsd, 200);
  assert.equal(rules.autoProtection.takeProfitUsd, 600);
  assert.equal(rules.autoProtection.enabled, true);
});
// --- G32 (2026-09-15): the UI can now change these, so they are clamped server-side.
// A risk number a renderer can widen is not a risk number - the same reason sizeCap is clamped.
const { clampAutoProtection } = require('../trade-protection.js');
const cur = { autoProtection: { enabled: true, stopLossUsd: 200, takeProfitUsd: 600, _comment: 'keep me', _status: 'keep me too' } };

test('clamp: sane values pass through', () => {
  const r = clampAutoProtection({ stopLossUsd: 150, takeProfitUsd: 450 }, cur);
  assert.equal(r.stopLossUsd, 150);
  assert.equal(r.takeProfitUsd, 450);
});

test('clamp: a tiny stop cannot sneak under the floor', () => {
  assert.equal(clampAutoProtection({ stopLossUsd: 1 }, cur).stopLossUsd, 25);
  assert.equal(clampAutoProtection({ takeProfitUsd: 2 }, cur).takeProfitUsd, 25);
});

test('clamp: an absurd value is capped, not accepted', () => {
  assert.equal(clampAutoProtection({ stopLossUsd: 999999 }, cur).stopLossUsd, 5000);
  assert.equal(clampAutoProtection({ takeProfitUsd: 999999 }, cur).takeProfitUsd, 10000);
});

test('clamp: a BLANK or invalid box keeps the existing number - it never disables protection', () => {
  assert.equal(clampAutoProtection({ stopLossUsd: '' }, cur).stopLossUsd, 200);
  assert.equal(clampAutoProtection({ stopLossUsd: -50 }, cur).stopLossUsd, 200);
  assert.equal(clampAutoProtection({ takeProfitUsd: null }, cur).takeProfitUsd, 600);
  assert.equal(clampAutoProtection({}, cur).stopLossUsd, 200);
});

test('clamp: the block reasoning survives a UI write', () => {
  const r = clampAutoProtection({ stopLossUsd: 250 }, cur);
  assert.equal(r._comment, 'keep me');
  assert.equal(r._status, 'keep me too');
  assert.equal(r.enabled, true);
});

test('clamp: enabled:false from the UI is honoured', () => {
  assert.equal(clampAutoProtection({ enabled: false }, cur).enabled, false);
});