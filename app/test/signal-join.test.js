'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { joinTradeToSignal, directionOfTrade } = require('../signal-join.js');

const trade = (side, entryAt) => ({ side, entryAt, at: entryAt + 60000, pnl: 20 });

test('directionOfTrade maps buy/sell to BULLISH/BEARISH', () => {
  assert.equal(directionOfTrade({ side: 'buy' }), 'BULLISH');
  assert.equal(directionOfTrade({ side: 'sell' }), 'BEARISH');
  assert.equal(directionOfTrade({ side: null }), null);
});

test('nearest preceding arming signal in the window backs the trade', () => {
  const t = trade('buy', 1000000);
  const signals = [
    { event: 'engulf-fire', playbook: 'A', direction: 'BULLISH', ts: 900000 },      // 100s before — in window
    { event: 'playbook-b-confirm', playbook: 'B', direction: 'BULLISH', ts: 960000 } // 40s before — nearest
  ];
  const r = joinTradeToSignal(t, signals, { windowMinutes: 15 });
  assert.equal(r.signalBacked, true);
  assert.equal(r.playbook, 'B');
  assert.equal(r.minutesFromSignal, 1); // 40s → 1 min (rounded)
});

test('direction mismatch never backs a trade', () => {
  const t = trade('buy', 1000000);
  const r = joinTradeToSignal(t, [{ event: 'fvg-fire', playbook: 'B', direction: 'BEARISH', ts: 960000 }], { windowMinutes: 15 });
  assert.equal(r.signalBacked, false);
});

test('signals after the entry or outside the window never back a trade', () => {
  const t = trade('sell', 1000000);
  const r = joinTradeToSignal(t, [
    { event: 'engulf-fire', playbook: 'A', direction: 'BEARISH', ts: 1005000 }, // after entry
    { event: 'engulf-fire', playbook: 'A', direction: 'BEARISH', ts: 99999 },   // 900001ms before — one ms past the 15-min window
  ], { windowMinutes: 15 });
  assert.equal(r.signalBacked, false);
});

test('non-arming events (rejections, raids, phase changes) never back a trade', () => {
  const t = trade('buy', 1000000);
  const r = joinTradeToSignal(t, [
    { event: 'playbook-c-reject', playbook: 'C', direction: 'BULLISH', ts: 960000 },
    { event: 'sfp-raid', playbook: 'B', direction: 'BULLISH', ts: 970000 },
    { event: 'po3-phase-change', playbook: 'PO3', direction: 'bullish', ts: 980000 },
  ], { windowMinutes: 15 });
  assert.equal(r.signalBacked, false);
});

test('freestyle trade (no signal at all) reports cleanly', () => {
  const r = joinTradeToSignal(trade('buy', 1000000), [], { windowMinutes: 15 });
  assert.deepEqual(r, { signalBacked: false, playbook: null, minutesFromSignal: null, signalTs: null });
});

test('entryAt missing falls back to the fold close stamp', () => {
  const t = { side: 'buy', at: 1000000 };
  const r = joinTradeToSignal(t, [{ event: 'engulf-fire', playbook: 'A', direction: 'BULLISH', ts: 950000 }], { windowMinutes: 15 });
  assert.equal(r.signalBacked, true);
  assert.equal(r.minutesFromSignal, 1);
});
