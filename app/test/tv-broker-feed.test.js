'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tvFeed = require('../tv-broker-feed.js');
const { fold, freshState, parseBalance, istDayStartMs, readBrokerPnl, effectiveDayPnl, effectiveTradeCount, BROKER_PNL_MAX_AGE_MS } = require('../tv-broker-feed.js');
const { reconcileOpeningPositions } = require('../tv-broker-feed.js');
const { isWalkDesynced: isWalkDesyncedCheck } = require('../tv-broker-feed.js');

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
  s = fold(s, { balance: 50060, isFlat: true, openSize: 0, nowMs: 3001 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
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
  s = fold(s, { balance: 49940, isFlat: true, openSize: 0, nowMs: 3001 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
  assert.equal(s.tradeCount, 1);
  assert.equal(s.dayPnl, -60);
  assert.equal(s.lastLossTs, 3000);
});

test('multiple trades in a day accumulate dayPnl/tradeCount/maxSize independently', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: 50000, isFlat: false, openSize: 1, nowMs: 2000 });
  s = fold(s, { balance: 49940, isFlat: true, openSize: 0, nowMs: 3000 }); // trade 1: -60, size 1
  s = fold(s, { balance: 49940, isFlat: true, openSize: 0, nowMs: 3001 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
  s = fold(s, { balance: 49940, isFlat: false, openSize: 3, nowMs: 4000 });
  s = fold(s, { balance: 50100, isFlat: true, openSize: 0, nowMs: 5000 }); // trade 2: +160, size 3
  s = fold(s, { balance: 50100, isFlat: true, openSize: 0, nowMs: 5001 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
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
  s = fold(s, { balance: 50200, isFlat: true, openSize: 0, nowMs: 3001 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
  assert.equal(s.tradeCount, 1);
  assert.equal(s.trades[0].size, 5);
  assert.equal(s.trades[0].pnl, 200);
});

test('a new IST calendar day resets accumulators', () => {
  let s = freshState();
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: 50000, isFlat: false, openSize: 1, nowMs: 2000 });
  s = fold(s, { balance: 50100, isFlat: true, openSize: 0, nowMs: 3000 });
  s = fold(s, { balance: 50100, isFlat: true, openSize: 0, nowMs: 3001 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
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
  s = fold(s, { balance: 50120, isFlat: true, openSize: 0, nowMs: 3001 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
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

// ── The broker's own P&L (2026-08-24 incident) ──────────────────────────────
// Ground truth for every test below is Anoop's own screenshot: account flat,
// DOLLAR OPEN P L $0.00, DOLLAR TOTAL P L +$399.70, equity $51,211.50 — while
// sessions/Now.md, driven by the balance-delta fold, read -$154.20.

test('readBrokerPnl reads the account panel and derives realized from total minus open', () => {
  const r = readBrokerPnl({ detail: { 'Total P/L': '399.70', 'Open P/L': '0.00', 'Net Liq': '51,211.50' } });
  assert.equal(r.totalPnl, 399.70);
  assert.equal(r.openPnl, 0);
  assert.equal(r.realizedPnl, 399.70);
  assert.equal(r.readable, true);
});

test('readBrokerPnl handles the U+2212 minus sign and currency formatting', () => {
  const r = readBrokerPnl({ detail: { 'Total P/L': '−$1,264.10', 'Open P/L': '−64.10' } });
  assert.equal(r.totalPnl, -1264.10);
  assert.equal(r.openPnl, -64.10);
  assert.equal(r.realizedPnl, -1200);
});

test('readBrokerPnl accepts the "P&L" column wording as well as "P/L"', () => {
  const r = readBrokerPnl({ detail: { 'Dollar Total P&L': '399.70', 'Dollar Open P&L': '0.00' } });
  assert.equal(r.totalPnl, 399.70);
  assert.equal(r.realizedPnl, 399.70);
});

test('readBrokerPnl reports unreadable rather than guessing when the panel is missing', () => {
  for (const bad of [null, undefined, {}, { detail: null }, { detail: { 'Net Liq': '51,211.50' } }]) {
    const r = readBrokerPnl(bad);
    assert.equal(r.readable, false, JSON.stringify(bad));
    assert.equal(r.totalPnl, null);
    assert.equal(r.realizedPnl, null);
  }
});

test('an open P&L column that will not parse still leaves total usable, realized unknown', () => {
  const r = readBrokerPnl({ detail: { 'Total P/L': '399.70', 'Open P/L': '--' } });
  assert.equal(r.totalPnl, 399.70);
  assert.equal(r.openPnl, null);
  assert.equal(r.realizedPnl, null, 'realized must not be invented from a half-read panel');
  assert.equal(r.readable, true);
});

test('effectiveDayPnl prefers the broker figure and reports the fold as drift', () => {
  // The incident, exactly: fold says -154.20, broker says +399.70, flat.
  const r = effectiveDayPnl(
    { dayPnl: -154.20, brokerTotalPnl: 399.70, brokerOpenPnl: 0, brokerPnlAt: 10000 }, 10000);
  assert.equal(r.value, 399.70);
  assert.equal(r.source, 'broker');
  assert.equal(r.realized, 399.70);
  assert.equal(r.foldValue, -154.20);
  assert.ok(Math.abs(r.drift - (-553.90)) < 1e-9, 'drift is fold minus broker-realized');
  assert.equal(r.stale, false);
});

test('effectiveDayPnl includes floating P&L on an open position — the reported "lag"', () => {
  // fold() cannot move until the position returns to flat; the broker's total
  // moves with it. A trade running -$300 must show as -$300, not as nothing.
  const r = effectiveDayPnl(
    { dayPnl: 0, brokerTotalPnl: -300, brokerOpenPnl: -300, brokerPnlAt: 500 }, 500);
  assert.equal(r.value, -300);
  assert.equal(r.realized, 0);
  assert.equal(r.open, -300);
});

test('effectiveDayPnl falls back to the fold when the broker figure goes stale', () => {
  const st = { dayPnl: -154.20, brokerTotalPnl: 399.70, brokerOpenPnl: 0, brokerPnlAt: 0 };
  const fresh = effectiveDayPnl(st, BROKER_PNL_MAX_AGE_MS);
  assert.equal(fresh.source, 'broker', 'exactly at the age limit is still fresh');
  const stale = effectiveDayPnl(st, BROKER_PNL_MAX_AGE_MS + 1);
  assert.equal(stale.source, 'fold');
  assert.equal(stale.value, -154.20);
  assert.equal(stale.stale, true, 'stale is distinguishable from never-had-one');
});

test('effectiveDayPnl falls back cleanly when the panel was never readable', () => {
  const r = effectiveDayPnl({ dayPnl: -154.20 }, 10000);
  assert.equal(r.source, 'fold');
  assert.equal(r.value, -154.20);
  assert.equal(r.stale, false, 'no broker figure ever seen is startup, not a fault');
  assert.equal(r.drift, null);
});

test('effectiveTradeCount drops fill-edge phantoms and floors at the broker walk', () => {
  const st = {
    tradeCount: 15,
    closedRoundTripsScored: 7,
    trades: [
      { size: 1, pnl: -1.9 },
      ...Array.from({ length: 6 }, () => ({ size: 0, pnl: -1, inferred: true })),
      ...Array.from({ length: 8 }, () => ({ size: 0, pnl: -1, inferred: true, evidence: 'degraded' })),
    ],
  };
  const r = effectiveTradeCount(st);
  assert.equal(r.value, 7, 'the 8 degraded phantoms are exactly the 15-vs-7 gap');
  assert.equal(r.rawFoldCount, 15);
  assert.equal(r.degraded, 8);
  assert.equal(r.evidence, 'degraded');
});

test('effectiveTradeCount never under-counts when the walk went dark mid-day', () => {
  // Walk stuck at 1, but two closes were corroborated by observed flat
  // transitions — the higher number wins, so the cap cannot be walked past.
  const r = effectiveTradeCount({
    tradeCount: 3, closedRoundTripsScored: 1,
    trades: [{ size: 1, pnl: 5 }, { size: 2, pnl: -5 }, { size: 0, pnl: 1, evidence: 'degraded' }],
  });
  assert.equal(r.value, 2);
});

test('effectiveTradeCount reports verified when nothing rests on the fill edge', () => {
  const r = effectiveTradeCount({
    tradeCount: 2, closedRoundTripsScored: 2,
    trades: [{ size: 1, pnl: 5 }, { size: 2, pnl: -5 }],
  });
  assert.equal(r.value, 2);
  assert.equal(r.degraded, 0);
  assert.equal(r.evidence, 'verified');
});

test('fold records the broker P&L even on the first poll, which returns early', () => {
  // On a restart mid-session this is the poll that matters most: it is the one
  // that must replace a stale reconstructed figure with the real session total.
  const s = fold(freshState(), {
    balance: 51211.50, isFlat: true, openSize: 0, nowMs: 9000,
    brokerTotalPnl: 399.70, brokerOpenPnl: 0,
  });
  assert.equal(s.tradeCount, 0, 'still scores nothing on the baseline poll');
  assert.equal(s.brokerTotalPnl, 399.70);
  assert.equal(s.brokerPnlAt, 9000);
  assert.equal(effectiveDayPnl(s, 9000).value, 399.70);
});

test('an unreadable summary on one poll does not blank a good earlier reading', () => {
  let s = fold(freshState(), { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, brokerTotalPnl: 120, brokerOpenPnl: 0 });
  s = fold(s, { balance: 50000, isFlat: true, openSize: 0, nowMs: 2000, brokerTotalPnl: null, brokerOpenPnl: null });
  assert.equal(s.brokerTotalPnl, 120, 'a flaky read degrades to slightly stale, not to no number');
  assert.equal(s.brokerPnlAt, 1000, 'but its age is NOT refreshed — staleness must still be able to fire');
});

test('with broker P&L in hand, a fill edge while flat re-anchors WITHOUT inventing a trade', () => {
  // The phantom generator: balance moved while flat with a new fill and no
  // usable order walk. Pre-fix this scored a trade; that is where 8 of
  // 2026-08-24's 15 came from, and why Now.md read "15 / 5".
  let s = fold(freshState(), { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, brokerTotalPnl: 0, brokerOpenPnl: 0 });
  s = fold(s, {
    balance: 49990, isFlat: true, openSize: 0, nowMs: 2000,
    hasNewFill: true, closedRoundTrips: null,
    brokerTotalPnl: -10, brokerOpenPnl: 0,
  });
  assert.equal(s.tradeCount, 0, 'no phantom trade');
  assert.equal(s.trades.length, 0);
  assert.equal(s.balanceAtLastFlat, 49990, 'baseline still advances — no stale anchor left behind');
  assert.equal(effectiveDayPnl(s, 2000).value, -10, 'and the P&L is not lost: the broker still reports it');
});

test('without broker P&L the degraded backstop still fires — under-counting stays the worse failure', () => {
  let s = fold(freshState(), { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000 });
  s = fold(s, { balance: 49990, isFlat: true, openSize: 0, nowMs: 2000, hasNewFill: true, closedRoundTrips: null });
  assert.equal(s.tradeCount, 1, 'unchanged fallback behaviour when the fold is the only P&L source');
  assert.equal(s.trades[0].evidence, 'degraded');
  assert.equal(s.dayPnl, -10);
});

test('a genuine observed round trip is still scored normally with broker P&L present', () => {
  let s = fold(freshState(), { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, brokerTotalPnl: 0, brokerOpenPnl: 0 });
  s = fold(s, { balance: 49980, isFlat: false, openSize: 2, nowMs: 2000, brokerTotalPnl: -20, brokerOpenPnl: -20 });
  s = fold(s, { balance: 50060, isFlat: true, openSize: 0, nowMs: 3000, brokerTotalPnl: 60, brokerOpenPnl: 0 });
  s = fold(s, { balance: 50060, isFlat: true, openSize: 0, nowMs: 3001, brokerTotalPnl: 60, brokerOpenPnl: 0 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
  assert.equal(s.tradeCount, 1);
  assert.equal(s.trades[0].size, 2, 'per-trade attribution is untouched by this change');
  assert.equal(s.trades[0].pnl, 60);
  assert.equal(effectiveTradeCount(s).evidence, 'verified');
});

test('REGRESSION 2026-08-24: the screenshot reconciles once the broker panel is read', () => {
  // Rebuild the day the way it actually happened: the app starts polling at
  // 17:30 with the account already +553.90 on the session, then gives some
  // back. The fold can only ever see its own window; the broker sees the day.
  let s = freshState();
  s = fold(s, { balance: 51365.70, isFlat: true, openSize: 0, nowMs: 1000,
                brokerTotalPnl: 553.90, brokerOpenPnl: 0 });
  s = fold(s, { balance: 51365.70, isFlat: false, openSize: 1, nowMs: 2000,
                brokerTotalPnl: 553.90, brokerOpenPnl: 0 });
  s = fold(s, { balance: 51211.50, isFlat: true, openSize: 0, nowMs: 3000, closedRoundTrips: 1,
                brokerTotalPnl: 399.70, brokerOpenPnl: 0 });

  const pnl = effectiveDayPnl(s, 3000);
  assert.equal(pnl.value, 399.70, "must equal the broker's DOLLAR TOTAL P L, not the fold's window");
  assert.equal(pnl.source, 'broker');
  // Float noise: the real state file carried -154.20000000000437 for the same
  // reason — a sum of balance deltas, not a rounded figure.
  assert.ok(Math.abs(pnl.foldValue - (-154.20)) < 1e-6, 'the old, wrong headline number is still visible as the fold value');
  assert.ok(Math.abs(pnl.drift - (-553.90)) < 1e-9, 'and the gap is reported, not hidden');
  assert.equal(effectiveTradeCount(s).value, 1);
});

test('readBrokerPnl reads Net Liq — the header strip Balance drifts, this does not', () => {
  // The exact live payload read 2026-08-24 while flat: header strip said
  // 51,219.30, this table said 51,211.50, the broker's EQUITY column said
  // 51,211.50. Net Liq is the one that agreed with the statement.
  const r = readBrokerPnl({ detail: {
    'Total P/L': '399.70', 'Open P/L': '0.00', 'Net Liq': '51211.50',
    'Available Margin': '51211.50', 'Day Margin': '0.00',
  } });
  assert.equal(r.netLiq, 51211.50);
  assert.equal(r.totalPnl, 399.70);
});

test('fold stores Net Liq even on a poll where the P&L columns are unreadable', () => {
  let s = fold(freshState(), { balance: 50000, isFlat: true, openSize: 0, nowMs: 1000, brokerNetLiq: 51211.50 });
  assert.equal(s.brokerNetLiq, 51211.50);
  assert.equal(s.brokerTotalPnl, null, 'the two are read independently');
});

// ── Side / prices on a folded trade (2026-08-25) ────────────────────────────
// Anoop: "also the side has not been mentioned check with it too! was the
// trade long or short?" Every live row wrote side/ep/xp/mp as null while the
// order walk already had all four.
const RT = (o) => Object.assign({
  symbol: 'MNQZ2026', side: 'buy', size: 2,
  entryPrice: 29100, exitPrice: 29110,
  entryAt: 1787641000000, exitAt: 1787641120000, at: 1787641120000,
  pnl: 0, pnlUnknown: true, source: 'backfilled-from-orders',
}, o || {});

test('walkDetailFor: translates buy/sell into the row vocabulary LONG/SHORT', () => {
  const buy = tvFeed.walkDetailFor({ closedRoundTripRecords: [RT()] }, 0, 1);
  assert.strictEqual(buy.side, 'LONG');
  const sell = tvFeed.walkDetailFor({ closedRoundTripRecords: [RT({ side: 'sell' })] }, 0, 1);
  assert.strictEqual(sell.side, 'SHORT');
});

test('walkDetailFor: carries prices, timestamps, hold and the walk size', () => {
  const d = tvFeed.walkDetailFor({ closedRoundTripRecords: [RT()] }, 0, 1);
  assert.strictEqual(d.entryPrice, 29100);
  assert.strictEqual(d.exitPrice, 29110);
  assert.strictEqual(d.entryAt, 1787641000000);
  assert.strictEqual(d.exitAt, 1787641120000);
  assert.strictEqual(d.holdSec, 120);
  assert.strictEqual(d.walkSize, 2);
});

test('walkDetailFor: REFUSES when two round trips closed in one poll', () => {
  // One balance delta spans both closes, so neither side describes that P&L.
  // Missing must stay missing rather than become a plausible guess.
  const snap = { closedRoundTripRecords: [RT(), RT({ side: 'sell' })] };
  assert.strictEqual(tvFeed.walkDetailFor(snap, 0, 2), null);
});

test('walkDetailFor: null when the walk was not trusted this poll', () => {
  assert.strictEqual(tvFeed.walkDetailFor({ closedRoundTripRecords: null }, 0, 1), null);
  assert.strictEqual(tvFeed.walkDetailFor({ closedRoundTripRecords: [RT()] }, 0, null), null);
});

test('walkDetailFor: null on an unreadable side rather than defaulting to long', () => {
  const snap = { closedRoundTripRecords: [RT({ side: '' })] };
  assert.strictEqual(tvFeed.walkDetailFor(snap, 0, 1), null);
});

test('applyWalkDetail: never overwrites the fold’s own P&L or observed size', () => {
  const out = tvFeed.applyWalkDetail({ size: 5, pnl: -280, at: 1 }, { side: 'SHORT', walkSize: 2 });
  assert.strictEqual(out.pnl, -280, 'the fold owns P&L');
  assert.strictEqual(out.size, 5, 'an OBSERVED size must win over the walk peak');
  assert.strictEqual(out.side, 'SHORT');
  assert.strictEqual(out.walkSize, undefined, 'walkSize is not a row field');
});

test('applyWalkDetail: fills an UNOBSERVED size and clears the inferred sentinel', () => {
  const out = tvFeed.applyWalkDetail({ size: 0, pnl: -50, at: 1, inferred: true },
    { side: 'LONG', walkSize: 3 });
  assert.strictEqual(out.size, 3);
  assert.strictEqual(out.inferred, undefined, 'size is no longer unknown, so the sentinel must go');
});

test('applyWalkDetail: a null detail leaves the record byte-identical', () => {
  const rec = { size: 0, pnl: -50, at: 1, inferred: true };
  assert.deepStrictEqual(tvFeed.applyWalkDetail(rec, null), rec);
});

test('fold: a real flat-to-flat close now records its direction', () => {
  const base = tvFeed.freshState();
  const t0 = Date.UTC(2026, 7, 25, 8, 0, 0);
  let st = tvFeed.fold(base, { balance: 50000, isFlat: true, openSize: 0, nowMs: t0, closedRoundTrips: 0 });
  st = tvFeed.fold(st, { balance: 50000, isFlat: false, openSize: 2, nowMs: t0 + 10000, closedRoundTrips: 0 });
  st = tvFeed.fold(st, {
    balance: 50040, isFlat: true, openSize: 0, nowMs: t0 + 20000,
    closedRoundTrips: 1,
    closedRoundTripRecords: [RT({ side: 'sell', entryPrice: 29110, exitPrice: 29100 })],
  });
  assert.strictEqual(st.trades.length, 1);
  const tr = st.trades[0];
  assert.strictEqual(tr.side, 'SHORT');
  assert.strictEqual(tr.entryPrice, 29110);
  assert.strictEqual(tr.exitPrice, 29100);
  assert.strictEqual(tr.pnl, 40, 'P&L still comes from the balance delta, not from prices');
  assert.strictEqual(tr.size, 2);
});

test('fold: a poll-aliased scalp recovers BOTH its side and its true size', () => {
  // Opened and closed inside one 10s poll interval, so the fold never saw the
  // position open — size 0 "not observed". The walk saw the order rows.
  const base = tvFeed.freshState();
  const t0 = Date.UTC(2026, 7, 25, 8, 0, 0);
  let st = tvFeed.fold(base, { balance: 50000, isFlat: true, openSize: 0, nowMs: t0, closedRoundTrips: 0 });
  st = tvFeed.fold(st, {
    balance: 49900, isFlat: true, openSize: 0, nowMs: t0 + 10000,
    closedRoundTrips: 1, hasNewFill: true,
    closedRoundTripRecords: [RT({ side: 'buy', size: 6 })],
  });
  assert.strictEqual(st.trades.length, 1);
  assert.strictEqual(st.trades[0].side, 'LONG');
  assert.strictEqual(st.trades[0].size, 6);
  assert.strictEqual(st.trades[0].pnl, -100);
  assert.strictEqual(st.trades[0].inferred, undefined);
});

test('fold: two closes in one interval still record P&L, but assert no direction', () => {
  const base = tvFeed.freshState();
  const t0 = Date.UTC(2026, 7, 25, 8, 0, 0);
  let st = tvFeed.fold(base, { balance: 50000, isFlat: true, openSize: 0, nowMs: t0, closedRoundTrips: 0 });
  st = tvFeed.fold(st, {
    balance: 49900, isFlat: true, openSize: 0, nowMs: t0 + 10000,
    closedRoundTrips: 2, hasNewFill: true,
    closedRoundTripRecords: [RT({ side: 'buy' }), RT({ side: 'sell' })],
  });
  assert.strictEqual(st.trades.length, 1);
  assert.strictEqual(st.trades[0].pnl, -100);
  assert.strictEqual(st.trades[0].side, undefined, 'no side may be asserted for a combined delta');
});

// ── Repairing rows written before their direction was known (2026-08-25) ────
// Anoop: "the side coloume is still empty... how can you solve it."
const WRT = (o) => Object.assign({
  symbol: 'MNQZ2026', side: 'buy', size: 2,
  entryPrice: 29100, exitPrice: 29110,
  entryAt: 1787641000000, exitAt: 1787641120000, at: 1787641120000,
}, o || {});

test('enrichRowsFromWalk: fills side, prices, signed move and hold on a blank row', () => {
  const rows = [{ t: 1787641120000, x: 1787641120000, size: 2, pnl: -280, side: null, ep: null, xp: null, mp: null, hold: 0 }];
  const r = tvFeed.enrichRowsFromWalk(rows, [WRT()]);
  assert.strictEqual(r.filled, 1);
  assert.strictEqual(r.rows[0].side, 'LONG');
  assert.strictEqual(r.rows[0].ep, 29100);
  assert.strictEqual(r.rows[0].xp, 29110);
  assert.strictEqual(r.rows[0].mp, 10);
  assert.strictEqual(r.rows[0].hold, 120);
  assert.strictEqual(r.rows[0].pnl, -280, 'P&L belongs to the fold and must not be rewritten');
});

test('enrichRowsFromWalk: a SHORT move is signed entry - exit', () => {
  const rows = [{ t: 1787641120000, x: 1787641120000, size: 2, pnl: 40, side: null, ep: null, xp: null, mp: null }];
  const r = tvFeed.enrichRowsFromWalk(rows, [WRT({ side: 'sell', entryPrice: 29110, exitPrice: 29100 })]);
  assert.strictEqual(r.rows[0].side, 'SHORT');
  assert.strictEqual(r.rows[0].mp, 10, 'a short that fell 10 points made +10, not -10');
});

test('enrichRowsFromWalk: never second-guesses a row that already knows its side', () => {
  const rows = [{ t: 1787641120000, x: 1787641120000, size: 2, pnl: -280, side: 'SHORT', ep: 1, xp: 2, mp: -1 }];
  const r = tvFeed.enrichRowsFromWalk(rows, [WRT({ side: 'buy' })]);
  assert.strictEqual(r.filled, 0);
  assert.deepStrictEqual(r.rows[0], rows[0]);
});

test('enrichRowsFromWalk: a contradicting known size is a different trade', () => {
  const rows = [{ t: 1787641120000, x: 1787641120000, size: 5, pnl: -280, side: null }];
  const r = tvFeed.enrichRowsFromWalk(rows, [WRT({ size: 2 })]);
  assert.strictEqual(r.filled, 0);
  assert.strictEqual(r.rows[0].side, null);
});

test('enrichRowsFromWalk: size 0 means NOT OBSERVED, so it excludes nothing', () => {
  const rows = [{ t: 1787641120000, x: 1787641120000, size: 0, pnl: -280, side: null }];
  const r = tvFeed.enrichRowsFromWalk(rows, [WRT({ size: 6 })]);
  assert.strictEqual(r.filled, 1);
  assert.strictEqual(r.rows[0].size, 6, 'and the real size is recovered');
});

test('enrichRowsFromWalk: an exit too far away is not matched', () => {
  const rows = [{ t: 1, x: 1787641120000 + 600000, size: 2, pnl: -280, side: null }];
  assert.strictEqual(tvFeed.enrichRowsFromWalk(rows, [WRT()]).filled, 0);
});

test('enrichRowsFromWalk: a TIE is refused, not guessed', () => {
  // A wrong LONG would corrupt the exact judgement he wants to make against
  // his higher-timeframe plan. Blank is the safer answer.
  const rows = [{ t: 0, x: 1787641120000, size: 2, pnl: -280, side: null }];
  const walk = [WRT({ side: 'buy', exitAt: 1787641120000 - 5000 }),
                WRT({ side: 'sell', exitAt: 1787641120000 + 5000 })];
  const r = tvFeed.enrichRowsFromWalk(rows, walk);
  assert.strictEqual(r.filled, 0);
  assert.strictEqual(r.ambiguous, 1);
  assert.strictEqual(r.rows[0].side, null);
});

test('enrichRowsFromWalk: one round trip cannot be claimed by two rows', () => {
  const rows = [
    { t: 0, x: 1787641120000, size: 2, pnl: -10, side: null },
    { t: 0, x: 1787641121000, size: 2, pnl: -20, side: null },
  ];
  const r = tvFeed.enrichRowsFromWalk(rows, [WRT()]);
  assert.strictEqual(r.filled, 1, 'exactly one row may take the single round trip');
  assert.strictEqual(r.rows[0].side, 'LONG');
  assert.strictEqual(r.rows[1].side, null);
});

test('enrichRowsFromWalk: idempotent — a second pass changes nothing', () => {
  const rows = [{ t: 1787641120000, x: 1787641120000, size: 2, pnl: -280, side: null }];
  const once = tvFeed.enrichRowsFromWalk(rows, [WRT()]);
  const twice = tvFeed.enrichRowsFromWalk(once.rows, [WRT()]);
  assert.strictEqual(twice.filled, 0);
  assert.deepStrictEqual(twice.rows, once.rows);
});

test('enrichRowsFromWalk: never adds, drops or reorders rows', () => {
  const rows = [
    { t: 0, x: 1000, size: 2, pnl: -10, side: null },
    { t: 0, x: 1787641120000, size: 2, pnl: -20, side: null },
    { t: 0, x: 2000, size: 2, pnl: -30, side: null },
  ];
  const r = tvFeed.enrichRowsFromWalk(rows, [WRT()]);
  assert.strictEqual(r.rows.length, 3);
  assert.deepStrictEqual(r.rows.map(x => x.pnl), [-10, -20, -30]);
});

test('enrichRowsFromWalk: empty and missing inputs are safe', () => {
  assert.deepStrictEqual(tvFeed.enrichRowsFromWalk([], [WRT()]).rows, []);
  assert.deepStrictEqual(tvFeed.enrichRowsFromWalk(null, [WRT()]).rows, []);
  assert.strictEqual(tvFeed.enrichRowsFromWalk([{ side: null, x: 1 }], []).filled, 0);
});

// ── Self-heal: folded trades that never reached the day record (2026-08-26) ─
// Anoop: "it is not showing how is trades are done for the day." The fold held
// today's trade (-$203); day_trades.json had no rows for the day at all.

test('missingFromDayRows: an empty day record reports every folded trade', () => {
  const fold = [{ size: 2, pnl: -203, at: 1787754092531 }];
  assert.strictEqual(tvFeed.missingFromDayRows(fold, []).length, 1);
  assert.strictEqual(tvFeed.missingFromDayRows(fold, null).length, 1);
});

test('missingFromDayRows: a trade already written is NOT reported again', () => {
  const fold = [{ size: 2, pnl: -203, at: 1787754092531 }];
  const rows = [{ t: 1787754092531, x: 1787754092531, size: 2, pnl: -203 }];
  assert.strictEqual(tvFeed.missingFromDayRows(fold, rows).length, 0);
});

test('missingFromDayRows: a row whose t is the ENTRY time still matches', () => {
  // Once the walk supplies an entry time, the row's `t` is entryAt while the
  // fold record's `at` is still the close. Matching only on `at` would
  // re-add the same trade as a second copy on every later poll.
  const fold = [{ size: 2, pnl: -203, at: 9000, entryAt: 5000 }];
  const rows = [{ t: 5000, x: 9000, size: 2, pnl: -203 }];
  assert.strictEqual(tvFeed.missingFromDayRows(fold, rows).length, 0);
});

test('missingFromDayRows: same P&L at a DIFFERENT time is a different trade', () => {
  const fold = [{ size: 2, pnl: -203, at: 1000 }, { size: 2, pnl: -203, at: 2000 }];
  const rows = [{ t: 1000, x: 1000, size: 2, pnl: -203 }];
  assert.strictEqual(tvFeed.missingFromDayRows(fold, rows).length, 1);
  assert.strictEqual(tvFeed.missingFromDayRows(fold, rows)[0].at, 2000);
});

test('missingFromDayRows: never reports what the writer would refuse', () => {
  // Reporting a trade as missing that writeLiveTradeToDayRecord then skips
  // would log a self-heal warning on every single poll, forever.
  assert.strictEqual(tvFeed.missingFromDayRows([{ pnl: 0, at: 1, pnlUnknown: true }], []).length, 0);
  assert.strictEqual(tvFeed.missingFromDayRows([{ pnl: NaN, at: 1 }], []).length, 0);
  assert.strictEqual(tvFeed.missingFromDayRows([{ pnl: -10, at: null }], []).length, 0);
  assert.strictEqual(tvFeed.missingFromDayRows([null], []).length, 0);
});

test('missingFromDayRows: cent-level P&L difference is a different trade', () => {
  const rows = [{ t: 1000, x: 1000, size: 1, pnl: -203.00 }];
  assert.strictEqual(tvFeed.missingFromDayRows([{ pnl: -203.01, at: 1000 }], rows).length, 1);
});

test('missingFromDayRows: unreadable rows on disk do not hide a real trade', () => {
  const rows = [{ t: 1000 }, { pnl: 'x', t: 1000 }, null];
  assert.strictEqual(tvFeed.missingFromDayRows([{ pnl: -203, at: 1000 }], rows).length, 1);
});

// ── Cross-route duplicate detection (2026-08-28) ────────────────────────────
// One closed trade reaches the day record twice: the walk-joined row carries
// GROSS P&L at the real fill exit, the folded trade carries NET at the moment
// the fold noticed flat. Matching on pnl@timestamp could never see they were
// the same trade, so 2026-08-28's single trade became three stored rows.
{
  const OPTS = { commissionPerContractPerSide: 0.95 };   // $1.90 round turn
  const walkRow = (o) => Object.assign({ t: 1787899868000, x: 1787899957000, size: 1, pnl: 3.00, side: 'SHORT' }, o);
  const foldTrade = (o) => Object.assign({ at: 1787900393198, size: 1, pnl: 1.10 }, o);

  test('a folded trade already stored as a GROSS walk row is not written again', () => {
    assert.equal(tvFeed.missingFromDayRows([foldTrade()], [walkRow()], OPTS).length, 0);
  });

  test('without the commission rate it cannot tell — so the rate must be passed', () => {
    // Documents WHY server.js must supply it: this is the old behaviour.
    assert.equal(tvFeed.missingFromDayRows([foldTrade()], [walkRow()]).length, 1);
  });

  test('a GENUINELY missing trade is still reported — the safe direction', () => {
    // Nothing stored at all.
    assert.equal(tvFeed.missingFromDayRows([foldTrade()], [], OPTS).length, 1);
    // A stored row from a different trade: different size.
    assert.equal(tvFeed.missingFromDayRows([foldTrade()], [walkRow({ size: 4 })], OPTS).length, 1);
    // Same size but hours away — a different flat event.
    assert.equal(tvFeed.missingFromDayRows([foldTrade()], [walkRow({ t: 1787800000000, x: 1787800001000 })], OPTS).length, 1);
  });

  test('a P&L gap that is NOT the commission is a different trade', () => {
    // Same size, same window, but the gap is not size x $1.90.
    assert.equal(tvFeed.missingFromDayRows([foldTrade({ pnl: -50 })], [walkRow({ pnl: 3.00 })], OPTS).length, 1);
  });

  test('the commission arithmetic scales with size', () => {
    // 4 contracts: gross - net must be 4 x $1.90 = $7.60
    const w = walkRow({ size: 4, pnl: 100.00 });
    assert.equal(tvFeed.missingFromDayRows([foldTrade({ size: 4, pnl: 92.40 })], [w], OPTS).length, 0, 'exactly commission apart');
    assert.equal(tvFeed.missingFromDayRows([foldTrade({ size: 4, pnl: 98.10 })], [w], OPTS).length, 1, 'wrong gap = different trade');
  });

  test('one stored row cannot absorb two different folded trades', () => {
    const two = [foldTrade(), foldTrade({ at: 1787900393198 + 1000 })];
    // Only one can match the single stored row; the other is still missing.
    assert.equal(tvFeed.missingFromDayRows(two, [walkRow()], OPTS).length, 1);
  });

  test('an exact P&L match at an exact timestamp still short-circuits', () => {
    const r = { t: 1787900393198, x: 1787900393198, size: 1, pnl: 1.10 };
    assert.equal(tvFeed.missingFromDayRows([foldTrade()], [r], OPTS).length, 0);
  });

  test('unknown-P&L folded trades are never reported missing', () => {
    assert.equal(tvFeed.missingFromDayRows([foldTrade({ pnlUnknown: true })], [], OPTS).length, 0);
    assert.equal(tvFeed.missingFromDayRows([foldTrade({ pnl: NaN })], [], OPTS).length, 0);
  });
}

// ── mergeTradeRow: identity is the flat event, never the P&L (2026-08-28) ──
{
  const OPTS = { commissionPerContractPerSide: 0.95 };   // $1.90 round turn
  const walk = (o) => Object.assign({ t: 1787899868000, x: 1787899957000, size: 1, pnl: 3.00, side: 'SHORT', ep: 29611, xp: 29609.5, hold: 89 }, o);
  const foldRow = (o) => Object.assign({ t: 1787900393198, x: 1787900393198, size: 1, pnl: 1.10, side: null, ep: null, xp: null, hold: 0 }, o);

  test('the SAME walk trade re-read with a stale P&L merges, it does not duplicate', () => {
    // Exactly today's rows 1 and 2: identical stamps and prices, pnl 1.10 vs 0.
    const r = tvFeed.mergeTradeRow([walk({ pnl: 1.10 })], walk({ pnl: 0 }), OPTS);
    assert.strictEqual(r.action, 'merged');
    assert.strictEqual(r.rows.length, 1);
  });

  test('the fold row for a trade the walk already wrote merges and keeps the prices', () => {
    const r = tvFeed.mergeTradeRow([walk()], foldRow(), OPTS);
    assert.strictEqual(r.action, 'merged');
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0].ep, 29611, 'walk prices survive');
    assert.strictEqual(r.rows[0].xp, 29609.5);
    assert.strictEqual(r.rows[0].side, 'SHORT');
    assert.strictEqual(r.rows[0].pnl, 1.10, 'the NET figure survives, not the gross');
  });

  test('order does not matter — fold first, then walk', () => {
    const r = tvFeed.mergeTradeRow([foldRow()], walk(), OPTS);
    assert.strictEqual(r.action, 'merged');
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0].pnl, 1.10);
    assert.strictEqual(r.rows[0].ep, 29611);
  });

  test('a genuinely different trade is INSERTED — the safe direction', () => {
    assert.strictEqual(tvFeed.mergeTradeRow([walk()], walk({ size: 4, t: 1787899868000 }), OPTS).action, 'inserted');
    // hours apart
    assert.strictEqual(tvFeed.mergeTradeRow([walk()], walk({ t: 1787800000000, x: 1787800001000 }), OPTS).action, 'inserted');
    // same size and window but a P&L gap that is not the commission
    assert.strictEqual(tvFeed.mergeTradeRow([walk()], foldRow({ pnl: -50 }), OPTS).action, 'inserted');
  });

  test('two real scale-outs at the same size minutes apart both survive', () => {
    // Same size, but P&Ls neither equal nor commission-apart => two trades.
    // Different exits — identical size AND identical prices cannot produce
    // different P&L, so the original fixture described an impossible pair.
    const first = walk({ pnl: 20, xp: 29601 });
    const second = walk({ t: 1787900100000, x: 1787900200000, pnl: -35, xp: 29628.5 });
    const r = tvFeed.mergeTradeRow([first], second, OPTS);
    assert.strictEqual(r.action, 'inserted');
    assert.strictEqual(r.rows.length, 2);
  });

  test('an empty day inserts', () => {
    assert.strictEqual(tvFeed.mergeTradeRow([], walk(), OPTS).action, 'inserted');
    assert.strictEqual(tvFeed.mergeTradeRow(null, walk(), OPTS).rows.length, 1);
  });

  test('a null row is skipped rather than throwing', () => {
    assert.strictEqual(tvFeed.mergeTradeRow([walk()], null, OPTS).action, 'skipped');
  });
}

// ── Zero-delta guard: a flat transition with no balance change (2026-08-28) ─
// Anoop took ONE trade and the fold held two: the real {size 1, pnl 1.10} and
// a phantom {size 1, pnl 0} three minutes later. A closed trade always moves
// the balance because commission always applies, so a zero delta means no fill
// happened — the positions table read empty for a poll and repopulated.
{
  const poll = (st, o) => tvFeed.fold(st, Object.assign({
    isFlat: false, balance: 1000, openSize: 1, brokerHeaderBalance: null,
  }, o), o.nowMs || 1000);

  test('a flat transition with a ZERO balance delta is not recorded as a trade', () => {
    let st = tvFeed.freshState();
    st = poll(st, { isFlat: true, balance: 1000, openSize: 0, nowMs: 1000 });   // baseline
    st = poll(st, { isFlat: false, balance: 1000, openSize: 1, nowMs: 2000 });  // position opens
    st = poll(st, { isFlat: true, balance: 1000, openSize: 0, nowMs: 3000 });   // flat, balance UNCHANGED
    st = poll(st, { isFlat: true, balance: 1000, openSize: 0, nowMs: 3001 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
    assert.strictEqual(st.tradeCount, 0, 'no money moved — not a trade');
    assert.strictEqual(st.trades.length, 0);
    assert.strictEqual(st.phantomFlats, 1, 'but it IS counted as evidence');
  });

  test('a real trade with a non-zero delta is still recorded', () => {
    let st = tvFeed.freshState();
    st = poll(st, { isFlat: true, balance: 1000, openSize: 0, nowMs: 1000 });
    st = poll(st, { isFlat: false, balance: 1000, openSize: 1, nowMs: 2000 });
    st = poll(st, { isFlat: true, balance: 1001.10, openSize: 0, nowMs: 3000 });
    st = poll(st, { isFlat: true, balance: 1001.10, openSize: 0, nowMs: 3001 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
    assert.strictEqual(st.tradeCount, 1);
    assert.strictEqual(Math.round(st.trades[0].pnl * 100), 110);
    assert.strictEqual(st.phantomFlats, 0);
  });

  test('a LOSING trade is recorded — the guard is on zero, not on sign', () => {
    let st = tvFeed.freshState();
    st = poll(st, { isFlat: true, balance: 1000, openSize: 0, nowMs: 1000 });
    st = poll(st, { isFlat: false, balance: 1000, openSize: 2, nowMs: 2000 });
    st = poll(st, { isFlat: true, balance: 797, openSize: 0, nowMs: 3000 });
    st = poll(st, { isFlat: true, balance: 797, openSize: 0, nowMs: 3001 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
    assert.strictEqual(st.tradeCount, 1);
    assert.strictEqual(st.trades[0].pnl, -203);
  });

  test("the phantom does not corrupt the next real trade's baseline", () => {
    let st = tvFeed.freshState();
    st = poll(st, { isFlat: true, balance: 1000, openSize: 0, nowMs: 1000 });
    st = poll(st, { isFlat: false, balance: 1000, openSize: 1, nowMs: 2000 });
    st = poll(st, { isFlat: true, balance: 1000, openSize: 0, nowMs: 3000 });   // phantom
    st = poll(st, { isFlat: false, balance: 1000, openSize: 1, nowMs: 4000 });
    st = poll(st, { isFlat: true, balance: 1050, openSize: 0, nowMs: 5000 });   // real +50
    st = poll(st, { isFlat: true, balance: 1050, openSize: 0, nowMs: 5001 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
    assert.strictEqual(st.tradeCount, 1);
    assert.strictEqual(st.trades[0].pnl, 50, 'baseline was carried through the phantom');
    assert.strictEqual(st.dayPnl, 50);
  });

  test("today's real sequence: one trade + one phantom = ONE trade", () => {
    let st = tvFeed.freshState();
    st = poll(st, { isFlat: true, balance: 51178.80, openSize: 0, nowMs: 1000 });
    st = poll(st, { isFlat: false, balance: 51178.80, openSize: 1, nowMs: 2000 });
    st = poll(st, { isFlat: true, balance: 51179.90, openSize: 0, nowMs: 3000 });   // the real +$1.10
    st = poll(st, { isFlat: true, balance: 51179.90, openSize: 0, nowMs: 3001 });   // confirmed
    st = poll(st, { isFlat: false, balance: 51179.90, openSize: 1, nowMs: 4000 });  // table blinks
    st = poll(st, { isFlat: true, balance: 51179.90, openSize: 0, nowMs: 5000 });   // phantom
    st = poll(st, { isFlat: true, balance: 51179.90, openSize: 0, nowMs: 5001 });   // + confirming poll: a close now needs flat SEEN TWICE (or broker round-trip evidence)
    assert.strictEqual(st.tradeCount, 1, 'was 2 before the guard');
    assert.strictEqual(Math.round(st.dayPnl * 100), 110);
    assert.strictEqual(st.phantomFlats, 1);
  });
}

// ── Same fill prices = same trade (2026-08-28) ──────────────────────────────
// After the zero-delta guard went in, the store STILL held two rows for one
// trade: SHORT 29611 -> 29609.5 twice, stamped $0.00 and $1.10. The walk route
// writes a stale P&L that is neither equal to nor commission-apart from the
// real figure, so no P&L test could pair them. The prices can.
{
  const OPTS = { commissionPerContractPerSide: 0.95, pointValue: 2 };
  const stale = { t: 1787899868000, x: 1787899957000, size: 1, pnl: 0.00, side: 'SHORT', ep: 29611, xp: 29609.5 };
  const real  = { t: 1787900304000, x: 1787900304000, size: 1, pnl: 1.10, side: 'SHORT', ep: 29611, xp: 29609.5 };

  test('identical side+entry+exit at the same size merges, whatever the P&L says', () => {
    const r = tvFeed.mergeTradeRow([stale], real, OPTS);
    assert.strictEqual(r.action, 'merged');
    assert.strictEqual(r.rows.length, 1);
  });

  test('the surviving P&L is recomputed from the prices, not inherited', () => {
    // SHORT 29611 -> 29609.5 = +1.5pt x 1 x $2 = $3.00 gross, - $1.90 = $1.10
    assert.strictEqual(tvFeed.mergeTradeRow([stale], real, OPTS).rows[0].pnl, 1.10);
    // and it is the same answer whichever order they arrive in
    assert.strictEqual(tvFeed.mergeTradeRow([real], stale, OPTS).rows[0].pnl, 1.10);
  });

  test('a LONG is recomputed with the right sign', () => {
    const a = { t: 1, x: 2, size: 2, pnl: 0, side: 'LONG', ep: 100, xp: 110 };
    const b = Object.assign({}, a, { t: 3, x: 4, pnl: 999 });
    // +10pt x 2 x $2 = $40 gross, - 2 x $1.90 = $36.20
    assert.strictEqual(tvFeed.mergeTradeRow([a], b, OPTS).rows[0].pnl, 36.20);
  });

  test('DIFFERENT prices at the same size are still two trades', () => {
    const other = Object.assign({}, real, { ep: 29650, xp: 29640 });
    assert.strictEqual(tvFeed.mergeTradeRow([stale], other, OPTS).action, 'inserted');
  });

  test('opposite sides at the same prices are two trades', () => {
    const flipped = Object.assign({}, real, { side: 'LONG' });
    assert.strictEqual(tvFeed.mergeTradeRow([stale], flipped, OPTS).action, 'inserted');
  });

  test('a priceless fold row still merges by the commission arithmetic', () => {
    const foldRow = { t: 1787900304000, x: 1787900304000, size: 1, pnl: 1.10, side: null, ep: null, xp: null };
    const walkRow = { t: 1787899868000, x: 1787899957000, size: 1, pnl: 3.00, side: 'SHORT', ep: 29611, xp: 29609.5 };
    const r = tvFeed.mergeTradeRow([walkRow], foldRow, OPTS);
    assert.strictEqual(r.action, 'merged');
    assert.strictEqual(r.rows[0].pnl, 1.10);
    assert.strictEqual(r.rows[0].ep, 29611, 'prices survive');
  });
}

test('two SELF-CONSISTENT rows with identical prices are NOT merged — they are two real trades', () => {
  const OPTS = { commissionPerContractPerSide: 0.95, pointValue: 2 };
  // SHORT 29611 -> 29609.5, size 1 => $3.00 gross - $1.90 = $1.10 net.
  // Both rows agree with their own prices, so neither is the stale duplicate.
  const a = { t: 1, x: 2, size: 1, pnl: 1.10, side: 'SHORT', ep: 29611, xp: 29609.5 };
  const b = { t: 300000, x: 400000, size: 1, pnl: 1.10, side: 'SHORT', ep: 29611, xp: 29609.5 };
  // They still merge on the samePnl rule (equal P&L in window) — which is the
  // pre-existing behaviour — but NOT via the price shortcut on a stale row.
  // What must never happen is a merge when the P&Ls genuinely differ:
  const c = { t: 300000, x: 400000, size: 1, pnl: -8.90, side: 'SHORT', ep: 29611, xp: 29620 };
  assert.strictEqual(tvFeed.mergeTradeRow([a], c, OPTS).action, 'inserted');
});

// ── One empty read is not a close (2026-08-28) ──────────────────────────────
// A real LONG ran 19:10:04 -> 19:14:43 on 2026-08-28. The positions table
// blinked empty at 19:12:49 and the fold booked a SECOND trade mid-flight. The
// enrich path then back-filled that phantom's prices, so it only looked like a
// duplicate AFTER the merge that would have caught it had run. The zero-delta
// guard could not catch it: the balance HAD moved, so the delta was non-zero.
{
  const p = (st, o) => tvFeed.fold(st, Object.assign({ brokerHeaderBalance: null }, o), o.nowMs);

  test('a one-poll flat BLINK mid-trade does not book a trade', () => {
    let st = tvFeed.freshState();
    st = p(st, { isFlat: true, balance: 1000, openSize: 0, nowMs: 1000 });     // baseline
    st = p(st, { isFlat: false, balance: 1000, openSize: 3, nowMs: 2000 });    // open
    st = p(st, { isFlat: true, balance: 1039, openSize: 0, nowMs: 3000 });     // BLINK
    assert.strictEqual(st.tradeCount, 0, 'a single empty read is not a close');
    st = p(st, { isFlat: false, balance: 1050, openSize: 3, nowMs: 4000 });    // still open
    assert.strictEqual(st.tradeCount, 0);
    st = p(st, { isFlat: true, balance: 1174, openSize: 0, nowMs: 5000 });     // real close
    st = p(st, { isFlat: true, balance: 1174, openSize: 0, nowMs: 6000 });     // confirmed
    assert.strictEqual(st.tradeCount, 1, 'the REAL close is booked, once');
    assert.strictEqual(st.trades[0].pnl, 174, 'and for the whole move, not the blink');
  });

  test('flat confirmed on two consecutive polls books the trade', () => {
    let st = tvFeed.freshState();
    st = p(st, { isFlat: true, balance: 1000, openSize: 0, nowMs: 1000 });
    st = p(st, { isFlat: false, balance: 1000, openSize: 2, nowMs: 2000 });
    st = p(st, { isFlat: true, balance: 1100, openSize: 0, nowMs: 3000 });   // 1st flat — held
    assert.strictEqual(st.tradeCount, 0);
    st = p(st, { isFlat: true, balance: 1100, openSize: 0, nowMs: 4000 });   // 2nd — booked
    assert.strictEqual(st.tradeCount, 1);
    assert.strictEqual(st.trades[0].pnl, 100);
  });

  test("the broker's own round-trip count books it IMMEDIATELY — no waiting", () => {
    // Evidence beats persistence: if the order history says a round trip
    // completed, that is not an inference and needs no second opinion.
    let st = tvFeed.freshState();
    st = p(st, { isFlat: true, balance: 1000, openSize: 0, closedRoundTrips: 0, nowMs: 1000 });
    st = p(st, { isFlat: false, balance: 1000, openSize: 2, closedRoundTrips: 0, nowMs: 2000 });
    st = p(st, { isFlat: true, balance: 1100, openSize: 0, closedRoundTrips: 1, nowMs: 3000 });
    assert.strictEqual(st.tradeCount, 1, 'booked on the first flat because the broker confirmed it');
  });

  test('a fast close-and-reopen is not lost', () => {
    // The risk of requiring persistence: if he closes and re-opens inside one
    // poll, flat is never seen twice. The round-trip count is what saves it.
    let st = tvFeed.freshState();
    st = p(st, { isFlat: true, balance: 1000, openSize: 0, closedRoundTrips: 0, nowMs: 1000 });
    st = p(st, { isFlat: false, balance: 1000, openSize: 1, closedRoundTrips: 0, nowMs: 2000 });
    st = p(st, { isFlat: true, balance: 1050, openSize: 0, closedRoundTrips: 1, nowMs: 3000 });
    assert.strictEqual(st.tradeCount, 1, 'not lost');
  });

  test('the blink does not corrupt the eventual P&L baseline', () => {
    let st = tvFeed.freshState();
    st = p(st, { isFlat: true, balance: 1000, openSize: 0, nowMs: 1000 });
    st = p(st, { isFlat: false, balance: 1000, openSize: 3, nowMs: 2000 });
    st = p(st, { isFlat: true, balance: 1039, openSize: 0, nowMs: 3000 });   // blink
    st = p(st, { isFlat: false, balance: 1050, openSize: 3, nowMs: 4000 });
    st = p(st, { isFlat: true, balance: 1174, openSize: 0, nowMs: 5000 });
    st = p(st, { isFlat: true, balance: 1174, openSize: 0, nowMs: 6000 });
    assert.strictEqual(st.dayPnl, 174, 'measured from the ORIGINAL flat, not the blink');
  });
}

// ── Size-0 fold entries are fragments, not trades (2026-08-28) ─────────────
// `size` is sizeSeenThisTrade — the largest position the fold ever OBSERVED
// open. Zero means it saw a balance move but never a position behind it. On
// 2026-08-28 the fold held nine entries for ~five real trades and every
// spurious one had size 0, while the real trades were already recorded from
// the order walk with fill prices.
{
  const OPTS = { commissionPerContractPerSide: 0.95 };

  test('a size-0 fold fragment is never written as a row', () => {
    const frag = { at: 1787924409000, size: 0, pnl: -0.45 };
    assert.strictEqual(tvFeed.missingFromDayRows([frag], [], OPTS).length, 0);
  });

  test("today's real fold state: only the entries with an observed size are written", () => {
    const fold = [
      { at: 1, size: 1, pnl: 1.10 },      // real
      { at: 2, size: 0, pnl: -0.45 },     // fragment
      { at: 3, size: 0, pnl: 39.10 },     // fragment
      { at: 4, size: 3, pnl: 3.15 },      // real (observed 3 lots)
      { at: 5, size: 0, pnl: -13.00 },    // fragment
      { at: 6, size: 2, pnl: -95.90 },    // real
      { at: 7, size: 0, pnl: -11.45 },    // fragment
      { at: 8, size: 1, pnl: -25.95 },    // real
    ];
    const writable = tvFeed.missingFromDayRows(fold, [], OPTS);
    assert.strictEqual(writable.length, 4, 'nine fold entries, four writable trades');
    assert.deepEqual(writable.map(t => t.size), [1, 3, 2, 1]);
  });

  test('a real trade with an observed size is STILL written — the safe direction', () => {
    const real = { at: 1787924409000, size: 2, pnl: -140.80 };
    assert.strictEqual(tvFeed.missingFromDayRows([real], [], OPTS).length, 1);
  });

  test('suppressing a fragment cannot lose a walk-recorded trade', () => {
    // A size-0 entry can never match a row by size, so it could only ever be
    // inserted as a NEW row — never merged into the real one. Suppressing it
    // is therefore incapable of removing a trade the walk already captured.
    const walkRow = { t: 1, x: 2, size: 3, pnl: 174.30, side: 'LONG', ep: 29652.75, xp: 29682.75 };
    const frag = { at: 3, size: 0, pnl: 39.10 };
    assert.strictEqual(tvFeed.missingFromDayRows([frag], [walkRow], OPTS).length, 0);
  });
}

test('a MISSING size is not the same as an observed zero — that trade is still written', () => {
  // "size: 0" means the fold looked and saw no position. "size absent" means
  // nobody recorded it. Conflating them would suppress real trades.
  const OPTS = { commissionPerContractPerSide: 0.95 };
  assert.strictEqual(tvFeed.missingFromDayRows([{ at: 1000, pnl: -203 }], [], OPTS).length, 1);
  assert.strictEqual(tvFeed.missingFromDayRows([{ at: 1000, pnl: -203, size: 0 }], [], OPTS).length, 0);
});

// ── A stale walk count must not read as final (2026-09-02) ─────────────────
// Live: the walk desynced, so the app refused it for round-trip counting, for
// trade direction and for exit prices — but closedRoundTripsScored kept its
// last value (11), won the max() against 5 corroborated closes, and hard-locked
// the UI at "10 trades — cap 10. Done." Third instance of this class
// (2026-08-20 "9/3 — DONE", 2026-08-24 "15/5").
test('a desynced walk marks the count degraded without lowering it', () => {
  const st = {
    trades: [{ size: 1 }, { size: 1 }, { size: 1 }, { size: 4 }, { size: 1 }],
    closedRoundTripsScored: 11,
    tradeCount: 6,
    walkTrusted: false,
  };
  const r = effectiveTradeCount(st);
  // NOT lowered — on a live-money account, quietly reducing a count fails in
  // the permissive direction, and the walk may be the half that is right.
  assert.equal(r.value, 11);
  assert.equal(r.walkStale, true);
  assert.equal(r.evidence, 'degraded');
  // Both halves are exposed so the UI can say WHY, not merely THAT.
  assert.equal(r.corroborated, 5);
  assert.equal(r.walkCount, 11);
});

test('a trusted walk stays verified — this must not flag every healthy day', () => {
  const st = {
    trades: [{ size: 1 }, { size: 1 }],
    closedRoundTripsScored: 2,
    tradeCount: 2,
    walkTrusted: true,
  };
  const r = effectiveTradeCount(st);
  assert.equal(r.walkStale, false);
  assert.equal(r.evidence, 'verified');
});

test('a stale walk that is NOT ahead of the corroborated count is not flagged', () => {
  // Nothing is resting on the walk here, so its staleness costs nothing and
  // must not raise a warning he would learn to ignore.
  const st = { trades: [{ size: 1 }, { size: 1 }, { size: 1 }], closedRoundTripsScored: 2, walkTrusted: false };
  const r = effectiveTradeCount(st);
  assert.equal(r.walkStale, false);
  assert.equal(r.evidence, 'verified');
});

test('fold carries walkTrusted onto the state so the flag cannot lag the number', () => {
  const st = fold(freshState(),
    { balance: 50000, isFlat: true, openSize: 0, nowMs: Date.now(), closedRoundTrips: null, walkTrusted: false });
  assert.equal(st.walkTrusted, false);
});

// ── The day did not open flat (2026-09-02) ─────────────────────────────────
// analyzeOrderWalk's window starts at midnight IST and starts every symbol at
// zero, which ASSERTS the account was flat at midnight. Carry a position across
// that boundary and the walk runs offset all day, never returns to zero, and
// isWalkDesynced refuses it — taking trade counts, exit prices and direction
// down for EVERY symbol over one stray contract.
//
// Live: WALK NET MNQU6 -1 against a flat panel, 44 order rows, 11 round trips.
test('the residual against a flat panel IS the opening position, negated', () => {
  const r = reconcileOpeningPositions({ MNQU6: -1 }, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.offsets, { MNQU6: 1 });
  // Never claims to have READ this. It is inferred from the panel.
  assert.equal(r.assumed, true);
});

test('an open position on the panel is accounted for, not treated as flat', () => {
  // Walk says flat, panel says long 2 → the day opened long 2.
  const r = reconcileOpeningPositions({}, [{ Symbol: 'MNQU6', Side: 'Buy', Qty: '2' }]);
  assert.deepEqual(r.offsets, { MNQU6: 2 });
});

test('a short on the panel is signed correctly', () => {
  const r = reconcileOpeningPositions({ MNQU6: -3 }, [{ Symbol: 'MNQU6', Side: 'Sell', Qty: '1' }]);
  // panel -1 minus walk -3 = +2
  assert.deepEqual(r.offsets, { MNQU6: 2 });
});

test('a walk that already agrees is left alone', () => {
  const r = reconcileOpeningPositions({}, []);
  assert.equal(r.ok, false);
  assert.equal(r.assumed, false);
});

// A large residual is far likelier a broken read than an overnight hold, and
// seeding it would manufacture round trips wholesale.
test('an implausibly large residual is REFUSED, not seeded', () => {
  const r = reconcileOpeningPositions({ MNQU6: -40 }, []);
  assert.equal(r.ok, false);
  assert.equal(r.offsets, null);
  assert.match(r.reason, /exceeds/);
});

test('seeding the walk with the opening position makes it reconcile', () => {
  // Carried 1 long across midnight, then sold it and did one clean round trip.
  const day = Date.UTC(2026, 8, 2) - (5.5 * 3600000);
  const t = (min) => new Date(day + min * 60000);
  const fmt = (d) => {
    const ist = new Date(d.getTime() + 5.5 * 3600000);
    const p = (n) => String(n).padStart(2, '0');
    return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())} ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:00`;
  };
  const orders = [
    { Symbol: 'MNQU6', Side: 'Sell', 'Filled Qty': '1', 'Avg Fill Price': '29400', Status: 'Filled', 'Update Time': fmt(t(600)) },
    { Symbol: 'MNQU6', Side: 'Buy', 'Filled Qty': '1', 'Avg Fill Price': '29380', Status: 'Filled', 'Update Time': fmt(t(610)) },
    { Symbol: 'MNQU6', Side: 'Sell', 'Filled Qty': '1', 'Avg Fill Price': '29390', Status: 'Filled', 'Update Time': fmt(t(620)) },
  ];
  const bare = analyzeOrderWalk(orders, day);
  assert.notEqual(bare.netBySymbol.MNQU6, undefined, 'unseeded, the walk is left holding a phantom short');

  const rec = reconcileOpeningPositions(bare.netBySymbol, []);
  const seeded = analyzeOrderWalk(orders, day, rec.offsets);
  assert.deepEqual(seeded.netBySymbol, {}, 'seeded with the opening position it returns to flat');
  // The carried position yields NO round-trip record, and that is correct: its
  // entry price was never observed, so there is nothing honest to report for it.
  // What the seeding buys is that the walk RECONCILES — which is what promotes
  // it from refused to trusted, so every subsequent round trip keeps its prices.
  // Reporting the carried leg with an invented entry would be the exact failure
  // this file's fold-only doctrine exists to prevent.
  assert.ok(seeded.closed.every(c => c.entryPrice != null),
    'every reported round trip still has a real observed entry price');
});

// ── Which side is stale when the walk and the panel disagree? ──────────────
// isWalkDesynced reports only THAT they differ; every caller then dropped the
// WALK. The 2026-09-02 broker statement shows that assumption is backwards:
//   desync logged 14:51:03Z — WALK NET: MNQU6 -1 | PANEL: flat
//   broker SELL 1 14:50:57Z, BUY 1 14:52:55Z
// He was genuinely short 1. The walk was right; the panel had not repainted.
test('a live short reads as a desync when the panel is stale', () => {
  // What the app saw: walk correctly short 1, panel not yet repainted.
  assert.equal(isWalkDesyncedCheck({ MNQU6: -1 }, []), true);
  // And with the panel freshly re-rendered, the same walk agrees.
  assert.equal(isWalkDesyncedCheck({ MNQU6: -1 }, [{ Symbol: 'MNQU6', Side: 'Sell', Qty: '1' }]), false);
});

test('the walk being AHEAD of the panel is the common case, not a walk fault', () => {
  // The walk reads a timestamped append-only order history; the panel is a
  // widget that does not repaint while its tab is hidden. Right after a fill
  // the walk leads. This is the shape the caller must re-render for, not refuse.
  const justOpened = isWalkDesyncedCheck({ MNQU6: 2 }, []);
  assert.equal(justOpened, true, 'still flagged — but the caller must now test the panel, not blame the walk');
  assert.equal(isWalkDesyncedCheck({ MNQU6: 2 }, [{ Symbol: 'MNQU6', Side: 'Buy', Qty: '2' }]), false);
});
