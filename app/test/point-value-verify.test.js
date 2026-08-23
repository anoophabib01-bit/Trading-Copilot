'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyPointValue, tickSizeFrom } = require('../point-value-verify');

// The MNQ fixture is the ACTUAL symbol_info payload captured live from
// TradingView Desktop on 2026-08-23, not an invented one.
const MNQ_LIVE = { pointvalue: 2, minmov: 25, pricescale: 100, currency_code: 'USD' };

test('LIVE FIXTURE: TradingView independently corroborates MNQ at $2.00/point', () => {
  const r = verifyPointValue('MNQU6', 2.0, MNQ_LIVE);
  assert.equal(r.status, 'match');
  assert.equal(r.ok, true);
  assert.equal(r.reported, 2);
});

test('LIVE FIXTURE: tick derives to 0.25 and $0.50/tick, matching the 117-fill evidence', () => {
  const r = verifyPointValue('MNQU6', 2.0, MNQ_LIVE);
  assert.equal(r.tickSize, 0.25);
  assert.ok(Math.abs(r.tickValue - 0.5) < 1e-9);
});

test('a mismatch is flagged, and the message says the app did NOT change anything', () => {
  const r = verifyPointValue('MNQU6', 2.0, { pointvalue: 20, minmov: 25, pricescale: 100 });
  assert.equal(r.status, 'mismatch');
  assert.equal(r.ok, false);
  assert.match(r.message, /MISMATCH/);
  assert.match(r.message, /NOT changed automatically/);
});

test('a mismatch never mutates the expected value it was given', () => {
  // The whole safety property: this module reports, it does not decide.
  const r = verifyPointValue('MNQU6', 2.0, { pointvalue: 20 });
  assert.equal(r.expected, 2.0, 'the app-configured value must survive untouched');
  assert.equal(r.reported, 20);
});

test('an untracked symbol reports what TradingView says without adopting it', () => {
  // MGC is deliberately absent from VERIFIED_POINT_VALUE — no trades to
  // validate against, and a guessed multiplier is worse than none.
  const r = verifyPointValue('MGCQ6', null, { pointvalue: 10, minmov: 1, pricescale: 10 });
  assert.equal(r.status, 'untracked');
  assert.equal(r.ok, true, 'untracked is not a failure');
  assert.match(r.message, /Not adopted automatically/);
});

test('missing TradingView metadata is silence, not an alarm', () => {
  for (const info of [null, {}, { pointvalue: null }, { pointvalue: 0 }, { pointvalue: 'x' }]) {
    const r = verifyPointValue('MNQU6', 2.0, info);
    assert.equal(r.status, 'unknown');
    assert.equal(r.ok, true, 'thin metadata must not cry wolf');
    assert.equal(r.message, null);
  }
});

test('float noise at equality does not manufacture a mismatch', () => {
  const r = verifyPointValue('MNQU6', 0.1 + 0.2, { pointvalue: 0.30000000000000004 });
  assert.equal(r.status, 'match');
});

test('tickSizeFrom refuses to divide by a zero or absent pricescale', () => {
  assert.equal(tickSizeFrom({ minmov: 25, pricescale: 0 }), null);
  assert.equal(tickSizeFrom({ minmov: 25 }), null);
  assert.equal(tickSizeFrom(null), null);
  assert.equal(tickSizeFrom({ minmov: 25, pricescale: 100 }), 0.25);
});

test('the app value stays authoritative — a match still reports the app number', () => {
  const r = verifyPointValue('MNQU6', 2.0, MNQ_LIVE);
  assert.equal(r.expected, 2.0);
});
