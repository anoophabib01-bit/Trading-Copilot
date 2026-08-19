'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fold, freshState, parseBalance, istDayStartMs } = require('../tv-broker-feed.js');

test('parseBalance strips currency formatting and handles the U+2212 minus sign', () => {
  assert.equal(parseBalance('$50,123.45'), 50123.45);
  assert.equal(parseBalance('−0.50'), -0.5);
  assert.equal(parseBalance(''), null);
  assert.equal(parseBalance(null), null);
});

test('first poll establishes baseline, scores nothing', () => {
  const s = fold(freshState(), { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  assert.equal(s.balanceAtLastFlat, 50000);
  assert.equal(s.tradeCount, 0);
  assert.deepEqual(s.trades, []);
});

test('open -> flat transition scores one trade via balance delta', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });   // baseline
  s = fold(s, { balance: 49990, isFlat: false, openSize: 2, nowMs: 2000 });  // position opens, floating loss
  s = fold(s, { balance: 50060, isFlat: true, openSize: 0, nowMs: 3000 });   // closes flat, up overall
  assert.equal(s.tradeCount, 1);
  assert.equal(s.dayPnl, 60);
  assert.equal(s.maxSize, 2);
  assert.equal(s.trades.length, 1);
  assert.equal(s.trades[0].pnl, 60);
  assert.equal(s.trades[0].size, 2);
  assert.equal(s.lastLossTs, 0);
});

test('a losing trade sets lastLossTs and accumulates a negative dayPnl', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: 50000, isFlat: false, openSize: 1, nowMs: 2000 });
  s = fold(s, { balance: 49940, isFlat: true, openSize: 0, nowMs: 3000 });
  assert.equal(s.tradeCount, 1);
  assert.equal(s.dayPnl, -60);
  assert.equal(s.lastLossTs, 3000);
});

test('multiple trades in a day accumulate dayPnl/tradeCount/maxSize independently', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: 50000, isFlat: false, openSize: 1, nowMs: 2000 });
  s = fold(s, { balance: 49940, isFlat: true, openSize: 0, nowMs: 3000 }); // trade 1: -60, size 1
  s = fold(s, { balance: 49940, isFlat: false, openSize: 3, nowMs: 4000 });
  s = fold(s, { balance: 50100, isFlat: true, openSize: 0, nowMs: 5000 }); // trade 2: +160, size 3
  assert.equal(s.tradeCount, 2);
  assert.equal(s.dayPnl, 100);
  assert.equal(s.maxSize, 3);
  assert.equal(s.trades.map(t => t.pnl).join(','), '-60,160');
});

test('staying flat across polls does not fabricate a trade', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 2000 });
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 3000 });
  assert.equal(s.tradeCount, 0);
});

test('an unreadable balance mid-trade still tracks max size and does not crash', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: null, isFlat: false, openSize: 5, nowMs: 2000 });
  assert.equal(s.sizeSeenThisTrade, 5);
  assert.equal(s.tradeCount, 0);
  s = fold(s, { balance: 50200, isFlat: true, openSize: 0, nowMs: 3000 });
  assert.equal(s.tradeCount, 1);
  assert.equal(s.trades[0].size, 5);
  assert.equal(s.trades[0].pnl, 200);
});

test('a new IST calendar day resets accumulators', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: 50000, isFlat: false, openSize: 1, nowMs: 2000 });
  s = fold(s, { balance: 50100, isFlat: true, openSize: 0, nowMs: 3000 });
  assert.equal(s.tradeCount, 1);

  const nextDayMs = istDayStartMs(3000) + 24 * 3600000 + 1000; // well into the next IST day
  s = fold(s, { balance: 50100, isFlat: true, openSize: 0, nowMs: nextDayMs });
  assert.equal(s.tradeCount, 0);
  assert.equal(s.dayPnl, 0);
  assert.deepEqual(s.trades, []);
});

test('fold never mutates its prevState argument', () => {
  const initial = freshState();
  const frozen = JSON.stringify(initial);
  fold(initial, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  assert.equal(JSON.stringify(initial), frozen);
});

// ── Poll-aliasing backstop (2026-08-18) ──────────────────────────────────
// Anoop took 3 real trades and the app recorded ZERO. One of the two causes
// was sampling: pollTVBrokerAccount reads every 10s, so a scalp opened and
// closed inside one interval is never observed as not-flat and the
// transition-based branch never fires. A balance that moved while we
// believed we were flat throughout can only be a completed round trip.
test('a round trip completed entirely between two polls is still scored (with a matching new fill)', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 }); // baseline, flat
  s = fold(s, { balance: 50085, isFlat: true, openSize: 0, nowMs: 11000, hasNewFill: true }); // still flat, but richer, AND a real fill was seen
  assert.equal(s.tradeCount, 1);
  assert.equal(s.trades[0].pnl, 85);
  assert.equal(s.dayPnl, 85);
  assert.equal(s.trades[0].inferred, true);
  assert.equal(s.trades[0].size, 0, 'size is unknown, not zero-sized — must be flagged inferred');
});

test('an inferred LOSS between polls still arms the cooldown (with a matching new fill)', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: 49900, isFlat: true, openSize: 0, nowMs: 11000, hasNewFill: true });
  assert.equal(s.tradeCount, 1);
  assert.equal(s.trades[0].pnl, -100);
  assert.equal(s.lastLossTs, 11000, 'a missed-between-polls loss must still set lastLossTs');
});

test('an unchanged balance while flat still fabricates nothing', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 11000, hasNewFill: true });
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 21000, hasNewFill: true });
  assert.equal(s.tradeCount, 0);
});

// ── THE LIVE INCIDENT (2026-08-19): balance drift with NO real fill must
// NOT be scored ────────────────────────────────────────────────────────────
// Anoop's real account: polled 4x, 3s apart, zero trading activity, and
// Balance drifted on its own (49,876.75 -> 49,874.75 -> 49,872.25 ->
// 49,871.75) while Equity stayed perfectly constant — a UI-settle/demo-
// account quirk, not a real trade. Before this fix, the poll-aliasing
// backstop fired on ANY balance change while flat and fabricated 20 fake
// trades in under 4 minutes from exactly this kind of drift. hasNewFill
// (tied to a REAL new Filled order in the same poll's orders-table read)
// is what tells the difference between "a trade actually happened" and
// "the number moved on its own."
test('balance drift while flat with NO new fill is NOT scored as a trade', () => {
  let s = freshState();
  s = fold(s, { balance: 49876.75, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: 49874.75, isFlat: true, openSize: 0, nowMs: 4000 }); // no hasNewFill — pure drift
  s = fold(s, { balance: 49872.25, isFlat: true, openSize: 0, nowMs: 7000 });
  s = fold(s, { balance: 49871.75, isFlat: true, openSize: 0, nowMs: 10000 });
  assert.equal(s.tradeCount, 0, 'balance moving with no matching fill must never fabricate a trade');
  assert.equal(s.trades.length, 0);
});

test('drift re-anchors the baseline so a LATER real fill scores from the settled balance, not a stale one', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: 49980, isFlat: true, openSize: 0, nowMs: 11000 }); // drift, no fill, no score
  assert.equal(s.tradeCount, 0);
  // A later GENUINE flat-to-flat round trip with a real fill must compute
  // its delta from the re-anchored (49980) balance, not the original 50000
  // — otherwise the earlier unscored drift would be silently absorbed into
  // this trade's P&L, inflating or deflating a real number.
  s = fold(s, { balance: 49950, isFlat: true, openSize: 0, nowMs: 21000, hasNewFill: true });
  assert.equal(s.tradeCount, 1);
  assert.equal(s.trades[0].pnl, -30, 'must be 49950-49980, not 49950-50000');
});

test('the observed-transition path still wins and is NOT marked inferred', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: 50000, isFlat: false, openSize: 4, nowMs: 2000 });
  s = fold(s, { balance: 50120, isFlat: true, openSize: 0, nowMs: 3000 });
  assert.equal(s.tradeCount, 1);
  assert.equal(s.trades[0].size, 4);
  assert.equal(s.trades[0].pnl, 120);
  assert.equal(s.trades[0].inferred, undefined);
});

// ── Backfill from orders table (2026-08-19) ──────────────────────────────
// Regression test using Anoop's ACTUAL live order history from today: a
// closed round trip (Buy 12:53:55 -> Sell 12:58:29) that fully finished
// before this server instance's first poll, plus a still-open position
// (Buy 13:08:15) that must NOT be reconstructed as closed.
const { reconstructClosedTradesFromOrders, parseISTTimestamp, istDayStartMs: dayStart } = require('../tv-broker-feed.js');

const REAL_ORDERS_2026_08_19 = [
  { Symbol: 'MNQU6', Side: 'Sell', Type: 'Stop Loss', Qty: '1', 'Filled Qty': '', 'Avg Fill Price': '', Status: 'Working', 'Update Time': '2026-08-19 13:08:15' },
  { Symbol: 'MNQU6', Side: 'Sell', Type: 'Take Profit', Qty: '1', 'Filled Qty': '', 'Avg Fill Price': '', Status: 'Working', 'Update Time': '2026-08-19 13:08:15' },
  { Symbol: 'MNQU6', Side: 'Buy', Type: 'Market', Qty: '1', 'Filled Qty': '1', 'Avg Fill Price': '29,575.75', Status: 'Filled', 'Update Time': '2026-08-19 13:08:15' },
  { Symbol: 'MNQU6', Side: 'Sell', Type: 'Market', Qty: '1', 'Filled Qty': '1', 'Avg Fill Price': '29,564.75', Status: 'Filled', 'Update Time': '2026-08-19 12:58:29' },
  { Symbol: 'MNQU6', Side: 'Sell', Type: 'Stop Loss', Qty: '1', 'Filled Qty': '', 'Avg Fill Price': '', Status: 'Cancelled', 'Update Time': '2026-08-19 12:58:29' },
  { Symbol: 'MNQU6', Side: 'Sell', Type: 'Take Profit', Qty: '1', 'Filled Qty': '', 'Avg Fill Price': '', Status: 'Cancelled', 'Update Time': '2026-08-19 12:58:29' },
  { Symbol: 'MNQU6', Side: 'Buy', Type: 'Market', Qty: '1', 'Filled Qty': '1', 'Avg Fill Price': '29,565.00', Status: 'Filled', 'Update Time': '2026-08-19 12:53:55' },
];

test('THE LIVE CASE: reconstructs the closed round trip, leaves the open position alone', () => {
  const dayKeyMs = dayStart(parseISTTimestamp('2026-08-19 12:00:00'));
  const closed = reconstructClosedTradesFromOrders(REAL_ORDERS_2026_08_19, dayKeyMs);
  assert.equal(closed.length, 1, 'exactly one closed round trip — the open position must not appear');
  assert.equal(closed[0].side, 'buy');
  assert.equal(closed[0].size, 1);
  assert.equal(closed[0].entryPrice, 29565.00);
  assert.equal(closed[0].exitPrice, 29564.75);
  assert.equal(closed[0].pnlUnknown, true);
  assert.equal(closed[0].pnl, 0, 'pnl stays numerically neutral, never guessed');
  assert.equal(closed[0].source, 'backfilled-from-orders');
});

test('ignores non-Filled rows (Working/Cancelled TP/SL legs)', () => {
  const dayKeyMs = dayStart(parseISTTimestamp('2026-08-19 12:00:00'));
  const closed = reconstructClosedTradesFromOrders(REAL_ORDERS_2026_08_19, dayKeyMs);
  // 7 raw rows, only 3 Filled, only 1 of those pairs closes — already
  // covered above, this test asserts it explicitly against a hand-built
  // all-noise list too.
  const onlyNoise = REAL_ORDERS_2026_08_19.filter(o => o.Status !== 'Filled');
  assert.deepEqual(reconstructClosedTradesFromOrders(onlyNoise, dayKeyMs), []);
});

test('an order from a PRIOR day is excluded even if the array includes it', () => {
  const dayKeyMs = dayStart(parseISTTimestamp('2026-08-19 12:00:00'));
  const yesterday = [
    { Symbol: 'MNQU6', Side: 'Buy', Qty: '2', 'Filled Qty': '2', 'Avg Fill Price': '29,000.00', Status: 'Filled', 'Update Time': '2026-08-18 10:00:00' },
    { Symbol: 'MNQU6', Side: 'Sell', Qty: '2', 'Filled Qty': '2', 'Avg Fill Price': '29,050.00', Status: 'Filled', 'Update Time': '2026-08-18 10:05:00' },
  ];
  assert.deepEqual(reconstructClosedTradesFromOrders(yesterday, dayKeyMs), []);
});

test('two independent closed round trips on the same day are both recovered, in order', () => {
  const dayKeyMs = dayStart(parseISTTimestamp('2026-08-19 12:00:00'));
  const two = [
    { Symbol: 'MGC1!', Side: 'Buy', Qty: '1', 'Filled Qty': '1', 'Avg Fill Price': '4400.0', Status: 'Filled', 'Update Time': '2026-08-19 09:00:00' },
    { Symbol: 'MGC1!', Side: 'Sell', Qty: '1', 'Filled Qty': '1', 'Avg Fill Price': '4405.0', Status: 'Filled', 'Update Time': '2026-08-19 09:05:00' },
    { Symbol: 'MGC1!', Side: 'Sell', Qty: '1', 'Filled Qty': '1', 'Avg Fill Price': '4390.0', Status: 'Filled', 'Update Time': '2026-08-19 10:00:00' },
    { Symbol: 'MGC1!', Side: 'Buy', Qty: '1', 'Filled Qty': '1', 'Avg Fill Price': '4388.0', Status: 'Filled', 'Update Time': '2026-08-19 10:05:00' },
  ];
  const closed = reconstructClosedTradesFromOrders(two, dayKeyMs);
  assert.equal(closed.length, 2);
  assert.equal(closed[0].side, 'buy');
  assert.equal(closed[1].side, 'sell');
});

test('garbage/malformed rows never throw', () => {
  assert.deepEqual(reconstructClosedTradesFromOrders(null, 0), []);
  assert.deepEqual(reconstructClosedTradesFromOrders([null, {}, { Status: 'Filled' }], 0), []);
  assert.deepEqual(reconstructClosedTradesFromOrders(REAL_ORDERS_2026_08_19, null), []);
});

// ── isFilledOrderRow (2026-08-19) ────────────────────────────────────────
// Regression test using the SECOND live bug found in the same debugging
// session: TradingView's orders table only populates a Status value when
// the "All" sub-tab is active. Anoop's UI was on the "Filled" sub-tab live —
// those rows have Filled Qty and Avg Fill Price but NO Status field at all.
const { isFilledOrderRow } = require('../tv-broker-feed.js');

test('THE LIVE CASE: a row with no Status but real Filled Qty/Avg Fill Price counts as filled', () => {
  const row = { Symbol: 'MNQU6', Side: 'Buy', Qty: '1', 'Filled Qty': '1', 'Avg Fill Price': '29,575.75', 'Update Time': '2026-08-19 13:08:15' };
  assert.equal(isFilledOrderRow(row), true);
});

test('an explicit Status still works (the "All" tab case)', () => {
  assert.equal(isFilledOrderRow({ Status: 'Filled', 'Filled Qty': '1', 'Avg Fill Price': '29,575.75' }), true);
  assert.equal(isFilledOrderRow({ Status: 'filled', 'Filled Qty': '1', 'Avg Fill Price': '29,575.75' }), true, 'case-insensitive');
});

test('an explicit non-filled Status is authoritative even with stray fields', () => {
  assert.equal(isFilledOrderRow({ Status: 'Working', 'Filled Qty': '0', 'Avg Fill Price': '' }), false);
  assert.equal(isFilledOrderRow({ Status: 'Cancelled', 'Filled Qty': '', 'Avg Fill Price': '' }), false);
});

test('a blank-Status row with no real fill data is NOT filled (a Working/Cancelled row seen without its Status column)', () => {
  assert.equal(isFilledOrderRow({ Symbol: 'MNQU6', 'Filled Qty': '', 'Avg Fill Price': '' }), false);
  assert.equal(isFilledOrderRow({ Symbol: 'MNQU6', 'Filled Qty': '0', 'Avg Fill Price': '' }), false);
});

test('garbage input never throws', () => {
  assert.equal(isFilledOrderRow(null), false);
  assert.equal(isFilledOrderRow(undefined), false);
  assert.equal(isFilledOrderRow('nope'), false);
  assert.equal(isFilledOrderRow({}), false);
});
