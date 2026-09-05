'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { winnersRunTo2R, cutoffAt, skipNthTrade, perTradeStop } = require('../counterfactual');
const TRADES = [
  { pnl: 60, size: 2, mfe: 100, entryIstMin: 600 },
  { pnl: -40, size: 2, mfe: 10, entryIstMin: 660 },
  { pnl: -300, size: 20, mfe: 5, entryIstMin: 720 },
  { pnl: 20, size: 2, mfe: 30, entryIstMin: 1200 },
];
test('no-op parameters return the actual record unchanged', () => {
  assert.equal(perTradeStop(TRADES, { stopUsd: Infinity }).deltaVsActual, 0);
  assert.equal(cutoffAt(TRADES, { cutoffMin: 1440 }).deltaVsActual, 0);
  assert.equal(skipNthTrade(TRADES, { n: 0 }).deltaVsActual, 0);
});
test('per-trade stop caps the -300 tail at -X', () => {
  const r = perTradeStop(TRADES, { stopUsd: 100 });
  assert.ok(r.net > -260);
  assert.ok(r.deltaVsActual > 0);
});
test('skip the 3rd trade removes it', () => {
  const r = skipNthTrade(TRADES, { n: 3 });
  assert.equal(r.deltaVsActual, 300);
});
// X4/X7: R is derived per trade (signal-stop when signalBacked, else
// MAE-implied), point value comes from point-value-verify.js, and the two
// populations are reported separately with n on each.
test('winnersRunTo2R derives R per trade and splits populations', () => {
  const t = [
    // signal-stop: R = |30200-30190| * $2 * 1 = $20; 2R needs 20 pts; mfe 15 < 20 → keeps pnl
    { pnl: 30, size: 1, symbol: 'MNQ', side: 'buy', ep: 30200, stop: 30190, signalBacked: true, mfe: 15 },
    // mae-implied: R = 5 pts * $2 * 1 = $10; 2R needs 10 pts; mfe 12 >= 10 → 2R = $20
    { pnl: 8, size: 1, symbol: 'MNQ', side: 'buy', ep: 30200, mae: 5, mfe: 12 },
  ];
  const r = winnersRunTo2R(t);
  assert.equal(r.rSources['signal-stop'], 1);
  assert.equal(r.rSources['mae-implied'], 1);
  assert.equal(r.signalStop.n, 1);
  assert.equal(r.maeImplied.n, 1);
  assert.equal(r.signalStop.deltaVsActual, 0);  // 15 < 20 pts, winner keeps its 30
  assert.equal(r.maeImplied.deltaVsActual, 12); // 20 (2R) - 8 (actual)
  assert.equal(r.deltaVsActual, 12);            // combined
});

test('winnersRunTo2R refuses a winner with no derivable R (never a silent no-op)', () => {
  const t = [{ pnl: 50, size: 1, symbol: 'MNQ', mfe: 20, mae: null, signalBacked: false, ep: 100, stop: null }];
  const r = winnersRunTo2R(t);
  assert.equal(r.refused, 1);
  assert.ok(r.error && r.error.indexOf('refused') >= 0);
  assert.equal(r.deltaVsActual, 0); // passed through unchanged, but flagged
});

test('winnersRunTo2R refuses when the instrument has no point value', () => {
  const t = [{ pnl: 50, size: 1, symbol: 'ZZZ', mfe: 20, mae: 5 }];
  const r = winnersRunTo2R(t);
  assert.equal(r.refused, 1);
  assert.ok(r.error && r.error.indexOf('no point value') >= 0);
});

test('winnersRunTo2R excludes null-mfe winners and reports the count', () => {
  const t = [{ pnl: 50, size: 1, symbol: 'MNQ', mfe: null, mae: 5 }, { pnl: -10, size: 1, symbol: 'MNQ', mfe: 2 }];
  const r = winnersRunTo2R(t);
  assert.equal(r.excluded, 1);
});