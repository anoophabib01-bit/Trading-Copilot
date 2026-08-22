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

// ── THE LIVE INCIDENT (2026-08-20): an ENTRY fill scored as a closed trade ──
// Anoop's HUD read "9/3 TRADES — DONE" and locked him out of a session in
// which the broker's order history showed ~4 real round trips. The persisted
// state held 1 observed trade plus 8 `inferred` ones, and their timestamps
// line up one-per-FILL against the orders table rather than one-per-round-
// trip: 14:42:53 + 14:43:23 for the single 14:42:47→14:43:14 round trip,
// 19:16:47 + 19:19:27 + 19:19:37 for the single 19:16:44→19:19:26 one, and
// 19:45:59 + 19:46:59 for the single 19:45:56→19:46:48 one.
//
// Cause: `hasNewFill` proves an ORDER FILLED, not that a POSITION CLOSED, and
// an entry fill satisfies it just as well as an exit fill. `closedRoundTrips`
// (a signed-quantity net-position walk over the order history, which only
// emits on a genuine return to flat) is the evidence that actually
// distinguishes the two.
test('an ENTRY fill while the positions panel still reads flat is NOT scored as a trade', () => {
  let s = freshState();
  // Baseline: genuinely flat, no round trips closed yet today.
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, closedRoundTrips: 0 });
  // The 19:16:44 entry fills. Balance moves (commission) and a new fill
  // exists, but nothing has CLOSED — and the positions panel has not
  // rendered the new position yet, so isFlat still reads true.
  s = fold(s, { balance: 49997.64, isFlat: true, openSize: 0, nowMs: 4000, hasNewFill: true, closedRoundTrips: 0 });
  assert.equal(s.tradeCount, 0, 'an entry fill must never be scored as a completed trade');
  assert.equal(s.trades.length, 0);
});

test('the round trip is scored exactly once, when the order history shows it actually closed', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, closedRoundTrips: 0 });
  s = fold(s, { balance: 49997.64, isFlat: true, openSize: 0, nowMs: 4000, hasNewFill: true, closedRoundTrips: 0 }); // entry
  s = fold(s, { balance: 50064.64, isFlat: true, openSize: 0, nowMs: 7000, hasNewFill: true, closedRoundTrips: 1 }); // exit closes it
  assert.equal(s.tradeCount, 1);
  assert.equal(s.dayPnl.toFixed(2), '64.64', 'P&L is still the full flat-to-flat balance delta');
  // A split exit files more order rows for the SAME round trip — the walk
  // still reports 1, so no second trade may be scored off it.
  s = fold(s, { balance: 50064.64, isFlat: true, openSize: 0, nowMs: 10000, hasNewFill: true, closedRoundTrips: 1 });
  assert.equal(s.tradeCount, 1, 'a split exit must not score the same round trip twice');
});

test('a multi-order scale-in and split exit is one trade, not one per fill (the 14:42:47 sequence)', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, closedRoundTrips: 0 });
  // Six Sell 2 entries land across polls, building a 12-lot short. Nothing
  // has closed, so the walk still reports 0 no matter how many rows appear.
  for (let i = 1; i <= 6; i++) {
    s = fold(s, { balance: 50000 - i, isFlat: true, openSize: 0, nowMs: 1000 + i * 1000, hasNewFill: true, closedRoundTrips: 0 });
  }
  assert.equal(s.tradeCount, 0, 'six entry fills are still zero completed trades');
  // The single Buy 12 exit returns it to flat.
  s = fold(s, { balance: 50035.6, isFlat: true, openSize: 0, nowMs: 20000, hasNewFill: true, closedRoundTrips: 1 });
  assert.equal(s.tradeCount, 1);
});

test('the observed-transition path also advances the round-trip baseline, so the backstop cannot re-score its close', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, closedRoundTrips: 0 });
  s = fold(s, { balance: 50000, isFlat: false, openSize: 2, nowMs: 2000, closedRoundTrips: 0 }); // open, observed
  s = fold(s, { balance: 50120, isFlat: true, openSize: 0, nowMs: 3000, hasNewFill: true, closedRoundTrips: 1 }); // close, observed
  assert.equal(s.tradeCount, 1);
  assert.equal(s.trades[0].inferred, undefined, 'observed close, not inferred');
  // A later poll still seeing the same single round trip must not add another.
  s = fold(s, { balance: 50119, isFlat: true, openSize: 0, nowMs: 13000, hasNewFill: true, closedRoundTrips: 1 });
  assert.equal(s.tradeCount, 1);
});

test('a state persisted before closedRoundTripsScored existed adopts the current count instead of re-scoring the day', () => {
  // The real upgrade path: server restarts mid-day onto a state written by
  // the old build. Adopting 0 as the baseline would make all 4 of today's
  // already-completed round trips look new and fire the backstop for each.
  const legacy = {
    dayKeyMs: istDayStartMs(1000), balanceAtLastFlat: 50000, wasFlat: true,
    sizeSeenThisTrade: 0, dayPnl: 0, tradeCount: 4, maxSize: 2, lastLossTs: 0, trades: [],
    // note: no closedRoundTripsScored
  };
  const s = fold(legacy, { balance: 49990, isFlat: true, openSize: 0, nowMs: 2000, hasNewFill: true, closedRoundTrips: 4 });
  assert.equal(s.tradeCount, 4, 'must not re-score round trips that closed before this build took over');
});

test('when the orders table is unreadable, the fold falls back to the 2026-08-19 hasNewFill behavior', () => {
  // Degraded path (server.js passes null while ordersTableSuspect): still
  // guarded against pure balance drift, but able to over-count again. This
  // is deliberate — losing the poll-aliasing backstop entirely would let a
  // real scalp vanish, which is the worse of the two failures.
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, closedRoundTrips: null });
  s = fold(s, { balance: 50085, isFlat: true, openSize: 0, nowMs: 11000, hasNewFill: true, closedRoundTrips: null });
  assert.equal(s.tradeCount, 1);
  s = fold(s, { balance: 50085, isFlat: true, openSize: 0, nowMs: 21000, hasNewFill: false, closedRoundTrips: null });
  assert.equal(s.tradeCount, 1, 'drift with no fill is still never scored, even in the degraded path');
});

// ── Persisted-state schema invalidation (2026-08-20) ───────────────────────
// The over-counting fix is worthless if the inflated count it produced simply
// reloads from disk. Observed live: a state holding tradeCount 9 for ~4 real
// round trips kept the session locked at "9/3 TRADES — DONE", and the server
// rewrites that file every poll, so it would have survived until IST rollover.
const { isStateSchemaStale, STATE_SCHEMA_VERSION } = require('../tv-broker-feed.js');

test('a state written by the pre-fix fold is rejected', () => {
  assert.equal(isStateSchemaStale({ tradeCount: 9, trades: [], dayKeyMs: 1 }), true, 'no schemaVersion at all = v1 = buggy fold');
  assert.equal(isStateSchemaStale({ schemaVersion: 1, tradeCount: 9, trades: [] }), true);
});

test('a state written by the current fold is accepted', () => {
  assert.equal(isStateSchemaStale(freshState()), false);
  assert.equal(isStateSchemaStale({ schemaVersion: STATE_SCHEMA_VERSION, trades: [] }), false);
});

test('garbage persisted state is treated as stale, not restored', () => {
  assert.equal(isStateSchemaStale(null), true);
  assert.equal(isStateSchemaStale(undefined), true);
  assert.equal(isStateSchemaStale('nope'), true);
  assert.equal(isStateSchemaStale({}), true);
});

test('freshState carries the current schema version so it round-trips through disk', () => {
  assert.equal(freshState().schemaVersion, STATE_SCHEMA_VERSION);
  // fold() must preserve it, or every restart would discard a valid state.
  const s = fold(freshState(), { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, closedRoundTrips: 0 });
  assert.equal(s.schemaVersion, STATE_SCHEMA_VERSION, 'fold must not drop the version stamp');
  assert.equal(isStateSchemaStale(s), false);
});

// ── Round-trip evidence outranks flatness (2026-08-20 review) ──────────────
// Two CRITICALs, both silent UNDER-counts — the direction that lets him keep
// trading past a cap, which is worse than the lockout that started all this.

test('CRITICAL: a FLIP is counted — it never passes through flat', () => {
  // long 2 -> short 2 without going flat. Before the fix neither scoring
  // branch could fire (both required isFlat === true), so the broker booked a
  // completed round trip and the fold recorded nothing, permanently -1.
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true,  openSize: 0, nowMs: 1000, closedRoundTrips: 0 });
  s = fold(s, { balance: 50000, isFlat: false, openSize: 2, nowMs: 2000, closedRoundTrips: 0 }); // long 2
  // The reversal fills: the broker's walk books one closed round trip, but the
  // account is NOT flat — a new short is already on.
  s = fold(s, { balance: 50090, isFlat: false, openSize: 2, nowMs: 3000, hasNewFill: true, closedRoundTrips: 1 });
  assert.equal(s.tradeCount, 1, 'the closed leg of a flip must be counted');
  assert.equal(s.trades[0].pnl, 90);
  assert.equal(s.trades[0].size, 2, 'size was observed before the flip, so it is known');
  // The reversed leg then closes normally and must be its own trade.
  s = fold(s, { balance: 50150, isFlat: true, openSize: 0, nowMs: 4000, hasNewFill: true, closedRoundTrips: 2 });
  assert.equal(s.tradeCount, 2);
  assert.equal(s.trades[1].pnl, 60, 'second leg P&L measures from the flip, not from the original entry');
  assert.equal(s.trades[1].size, 2, 'the reversed leg carries the size open at the flip, not 0');
});

test('CRITICAL: a close is still scored when the fill edge was already burned', () => {
  // hasNewFill is an EDGE and one-shot (server.js burns the Order ID the first
  // time it sees the row); closedRoundTrips is a LEVEL. When they land on
  // different polls the old code fell through to the re-anchor, which threw
  // the pending P&L away AND never counted the trade.
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true,  openSize: 0, nowMs: 1000, closedRoundTrips: 0 });
  s = fold(s, { balance: 50000, isFlat: false, openSize: 3, nowMs: 2000, closedRoundTrips: 0 });
  s = fold(s, { balance: 50000, isFlat: false, openSize: 3, nowMs: 3000, hasNewFill: true, closedRoundTrips: 0 }); // edge burned here
  // Close observed a poll later, with no NEW fill left to report.
  s = fold(s, { balance: 50075, isFlat: true, openSize: 0, nowMs: 4000, hasNewFill: false, closedRoundTrips: 1 });
  assert.equal(s.tradeCount, 1, 'round-trip evidence alone must be enough to score');
  assert.equal(s.dayPnl, 75, 'and its P&L must not be discarded by the re-anchor');
});

test('the re-anchor never discards a balance delta that has unscored evidence behind it', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, closedRoundTrips: 0 });
  // Balance moved, no new fill — but the walk says a round trip DID close.
  // The old guard would have re-anchored and eaten it.
  s = fold(s, { balance: 50040, isFlat: true, openSize: 0, nowMs: 2000, hasNewFill: false, closedRoundTrips: 1 });
  assert.equal(s.tradeCount, 1);
  assert.equal(s.dayPnl, 40);
});

test('pure balance drift is still never scored when no round trip closed', () => {
  // The 2026-08-19 protection must survive the 2026-08-20 restructure.
  let s = freshState();
  s = fold(s, { balance: 49876.75, isFlat: true, openSize: 0, nowMs: 1000, closedRoundTrips: 0 });
  s = fold(s, { balance: 49874.75, isFlat: true, openSize: 0, nowMs: 4000, closedRoundTrips: 0 });
  s = fold(s, { balance: 49872.25, isFlat: true, openSize: 0, nowMs: 7000, hasNewFill: true, closedRoundTrips: 0 });
  assert.equal(s.tradeCount, 0, 'a fill with no completed round trip is an ENTRY, not a trade');
});

// ── H5 (2026-08-20 review): the order walk must report its own health ──────
// The fold now GATES on this walk's count, so a frozen count doesn't merely
// mis-report — it disables the poll-aliasing backstop for the rest of the day
// and pins the mismatch banner on. Both failure modes below leave the running
// sum permanently non-zero.
const { analyzeOrderWalk, isWalkDesynced } = require('../tv-broker-feed.js');

const IST = (hhmmss) => `2026-08-20 ${hhmmss}`;
const ord = (Symbol, Side, Qty, price, time) => ({
  Symbol, Side, Qty: String(Qty), 'Filled Qty': String(Qty),
  'Avg Fill Price': price, 'Update Time': IST(time), Status: 'Filled',
});
// IST midnight for 2026-08-20
const DAY = istDayStartMs(Date.UTC(2026, 7, 20, 12, 0, 0));

test('a clean day walks to zero net and reports no dropped rows', () => {
  const w = analyzeOrderWalk([
    ord('MNQU6', 'Buy', 2, '29,411.25', '19:16:44'),
    ord('MNQU6', 'Sell', 2, '29,438.00', '19:19:26'),
  ], DAY);
  assert.equal(w.closed.length, 1);
  assert.equal(w.droppedRows, 0);
  assert.deepEqual(w.netBySymbol, {}, 'nothing left open');
  assert.equal(isWalkDesynced(w.netBySymbol, []), false);
});

test('an unreadable fill price is counted as a dropped row, not silently ignored', () => {
  const bad = ord('MNQU6', 'Sell', 2, 'n/a', '19:19:26');
  const w = analyzeOrderWalk([ord('MNQU6', 'Buy', 2, '29,411.25', '19:16:44'), bad], DAY);
  assert.equal(w.droppedRows, 1, 'the row is real but unreadable — that is a defect, and must be visible');
  assert.equal(w.closed.length, 0, 'and the close cannot be booked');
  assert.deepEqual(w.netBySymbol, { MNQU6: 2 }, 'walk still thinks a long 2 is open');
});

test('desync is detected when the walk thinks a position is open but the broker is flat', () => {
  // This is the state that used to freeze the count for the rest of the day.
  assert.equal(isWalkDesynced({ MNQU6: 2 }, []), true);
  assert.equal(isWalkDesynced({ MNQU6: 2 }, [{ Symbol: 'MNQU6', Qty: '2' }]), false, 'genuinely open is NOT desync');
  assert.equal(isWalkDesynced({ MNQU6: 2 }, [{ Symbol: 'MNQU6', Qty: '5' }]), true, 'size disagreement is desync');
});

test('desync is detected when the broker shows a position the walk never saw', () => {
  // e.g. a position opened before IST midnight: the day filter drops its entry
  // but keeps the exit, leaving a permanent phantom.
  assert.equal(isWalkDesynced({}, [{ Symbol: 'MGCQ6', Qty: '1' }]), true);
});

test('a short position is matched on absolute size, not sign', () => {
  assert.equal(isWalkDesynced({ MNQU6: -12 }, [{ Symbol: 'MNQU6', Qty: '12' }]), false);
  assert.equal(isWalkDesynced({ MNQU6: -12 }, [{ Symbol: 'MNQU6', Qty: '-12' }]), false);
});

test('a fill that CROSSES zero books the close and opens the reversal', () => {
  // Sell 5 against a long 2: the old `st.qty === 0` test never fired, so the
  // reversal silently swallowed the round trip — the order-history twin of
  // the fold's own flip bug.
  const w = analyzeOrderWalk([
    ord('MNQU6', 'Buy', 2, '29,400.00', '19:16:44'),
    ord('MNQU6', 'Sell', 5, '29,420.00', '19:20:00'),
  ], DAY);
  assert.equal(w.closed.length, 1, 'the long 2 closed when the sell crossed through flat');
  assert.equal(w.closed[0].side, 'buy');
  assert.deepEqual(w.netBySymbol, { MNQU6: -3 }, 'and a short 3 is now open');
});

test('the reversal opened by a crossing fill can itself be closed later', () => {
  const w = analyzeOrderWalk([
    ord('MNQU6', 'Buy', 2, '29,400.00', '19:16:44'),
    ord('MNQU6', 'Sell', 5, '29,420.00', '19:20:00'), // closes long 2, opens short 3
    ord('MNQU6', 'Buy', 3, '29,410.00', '19:25:00'),  // closes short 3
  ], DAY);
  assert.equal(w.closed.length, 2, 'both round trips are booked');
  assert.deepEqual(w.netBySymbol, {}, 'flat at the end');
});

test('scale-in then one split-free exit is still exactly one round trip', () => {
  const w = analyzeOrderWalk([
    ord('MNQU6', 'Sell', 2, '29,518.75', '14:42:47'),
    ord('MNQU6', 'Sell', 2, '29,518.50', '14:42:47'),
    ord('MNQU6', 'Sell', 2, '29,518.75', '14:42:47'),
    ord('MNQU6', 'Buy', 6, '29,510.00', '14:43:14'),
  ], DAY);
  assert.equal(w.closed.length, 1, 'six lots in three orders, one exit, one trade');
  assert.deepEqual(w.netBySymbol, {});
});

test('analyzeOrderWalk never throws on garbage', () => {
  assert.deepEqual(analyzeOrderWalk(null, DAY).closed, []);
  assert.deepEqual(analyzeOrderWalk([null, {}, 'x'], DAY).closed, []);
  assert.equal(isWalkDesynced(null, null), false);
  assert.equal(isWalkDesynced({}, 'garbage'), false);
});

// ── Price-derived P&L cross-check (2026-08-20) ─────────────────────────────
// A second, independent derivation of a closed round trip's P&L, so the
// balance-delta fold stops being the only opinion in the system. Legitimate
// only because scripts/verify-fold.js established the point value from 117
// real broker-confirmed trades (117/117 exact at $0.50/tick, zero violations).
const { expectedPnlFromFills, pointValueFor, contractRoot } = require('../tv-broker-feed.js');

test('contract root is parsed out of the month/year code', () => {
  assert.equal(contractRoot('MNQU6'), 'MNQ');
  assert.equal(contractRoot('MGCQ6'), 'MGC');
  assert.equal(contractRoot('MNQ'), 'MNQ');
  assert.equal(contractRoot(''), '');
});

test('only VERIFIED point values are returned — no guessing', () => {
  assert.equal(pointValueFor('MNQU6'), 2.0, 'MNQ established from 117 real trades');
  assert.equal(pointValueFor('MGCQ6'), null, 'MGC has no trades in the checked history — must decline, not guess');
  assert.equal(pointValueFor('ZZZZ9'), null);
});

test('a SHORT round trip that fell in price is a profit (real 19:45 fills)', () => {
  // From the broker's own orders table on 2026-08-20:
  //   Sell 3 @ 29,338.50 (19:45:56)  ->  Buy 3 @ 29,335.50 (19:46:48)
  const r = expectedPnlFromFills(
    { symbol: 'MNQU6', side: 'sell', size: 3, entryPrice: 29338.50, exitPrice: 29335.50 },
    0.59 // rules.json commissionPerContractPerSide — never hardcoded elsewhere
  );
  assert.equal(r.gross, 18, '3.00 points x $2 x 3 lots');
  assert.equal(r.commission, 3.54, '0.59 x 3 lots x 2 sides');
  assert.equal(r.net, 14.46);
});

test('a LONG round trip that fell in price is a loss (real 19:16 fills)', () => {
  // Buy 2 @ 29,411.25 (19:16:44) -> exit averaged 29,370.875 across two sells
  const r = expectedPnlFromFills(
    { symbol: 'MNQU6', side: 'buy', size: 2, entryPrice: 29411.25, exitPrice: 29370.875 },
    0.59
  );
  assert.equal(r.gross, -161.5, '-40.375 points x $2 x 2 lots');
  assert.equal(r.net, -163.86);
});

test('a symbol with no verified multiplier returns null rather than a wrong number', () => {
  assert.equal(expectedPnlFromFills(
    { symbol: 'MGCQ6', side: 'buy', size: 1, entryPrice: 2400, exitPrice: 2405 }, 0.59), null);
});

test('incomplete or malformed round trips return null, never a partial figure', () => {
  assert.equal(expectedPnlFromFills(null, 0.59), null);
  assert.equal(expectedPnlFromFills({ symbol: 'MNQU6', side: 'buy', size: 1, entryPrice: 1 }, 0.59), null, 'no exit price');
  assert.equal(expectedPnlFromFills({ symbol: 'MNQU6', side: 'buy', size: 0, entryPrice: 1, exitPrice: 2 }, 0.59), null);
});

test('a missing commission rate degrades to gross rather than throwing', () => {
  const r = expectedPnlFromFills({ symbol: 'MNQU6', side: 'buy', size: 1, entryPrice: 100, exitPrice: 110 }, undefined);
  assert.equal(r.commission, 0);
  assert.equal(r.net, r.gross);
});

// ── D1 (2026-08-21): degraded-path trades are TAGGED, not silently equal ───
test('a trade scored on the degraded path carries evidence:degraded', () => {
  // closedRoundTrips === null means the orders table was unreadable, the walk
  // disagreed with the positions panel, or a row would not parse.
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, closedRoundTrips: null });
  s = fold(s, { balance: 50080, isFlat: true, openSize: 0, nowMs: 11000, hasNewFill: true, closedRoundTrips: null });
  assert.equal(s.tradeCount, 1, 'still scored — refusing would under-count and let him trade past the cap');
  assert.equal(s.trades[0].evidence, 'degraded', 'but tagged, so the cap can be advisory rather than a hard lock');
});

test('a trade scored on verified round-trip evidence carries NO degraded tag', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, closedRoundTrips: 0 });
  s = fold(s, { balance: 50000, isFlat: false, openSize: 2, nowMs: 2000, closedRoundTrips: 0 });
  s = fold(s, { balance: 50080, isFlat: true, openSize: 0, nowMs: 3000, hasNewFill: true, closedRoundTrips: 1 });
  assert.equal(s.tradeCount, 1);
  assert.equal(s.trades[0].evidence, undefined, 'observed close — full authority, hard-enforces');
});

// ── size is the PEAK position reached, not the first or last fill (2026-08-21) ──
// Found by the 2026-08-20 replay test using Anoop's real fills. Two wrong
// fixes preceded this: st.entry.qty (only the first fill's size — broke
// scale-in entries) and abs(before) at the closing fill (only the size right
// before the LAST fill — broke split exits). Peak absolute position size
// across the round trip's life is the only value correct for both shapes.
test('a scale-in entry reports the TOTAL accumulated size, not the first fill', () => {
  const w = analyzeOrderWalk([
    ord('MNQU6', 'Sell', 2, '29,518.75', '14:42:45'),
    ord('MNQU6', 'Sell', 2, '29,518.50', '14:42:46'),
    ord('MNQU6', 'Buy', 4, '29,518.00', '14:43:14'),
  ], DAY);
  assert.equal(w.closed.length, 1);
  assert.equal(w.closed[0].size, 4, 'the full 4-lot position, not 2 (the first fill alone)');
});

test('a split exit reports the size at PEAK, not the size of the final closing fill', () => {
  const w = analyzeOrderWalk([
    ord('MNQU6', 'Buy', 2, '29,411.25', '19:16:44'),
    ord('MNQU6', 'Sell', 1, '29,370.75', '19:19:26'),
    ord('MNQU6', 'Sell', 1, '29,371.00', '19:19:27'),
  ], DAY);
  assert.equal(w.closed.length, 1);
  assert.equal(w.closed[0].size, 2, 'the 2-lot position that was open, not 1 (the size of the last exit fill)');
});

test('a reversal reports each leg at its own peak size, independently', () => {
  const w = analyzeOrderWalk([
    ord('MNQU6', 'Buy', 2, '29,400.00', '19:16:44'),
    ord('MNQU6', 'Sell', 5, '29,420.00', '19:20:00'), // closes long 2, opens short 3
    ord('MNQU6', 'Buy', 1, '29,415.00', '19:21:00'),  // partial cover, short 2 remains
    ord('MNQU6', 'Buy', 2, '29,410.00', '19:22:00'),  // closes remaining short 2
  ], DAY);
  assert.equal(w.closed.length, 2);
  assert.equal(w.closed[0].size, 2, 'the long leg that closed on the reversal fill');
  assert.equal(w.closed[1].size, 3, 'the short leg peaked at 3, not 2 (the size of its final closing fill)');
});
