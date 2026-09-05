// Volume-weighted entry/exit prices in analyzeOrderWalk (2026-09-03).
//
// THE LIVE CASE. Anoop's Tradovate "Performance (78).csv" for 2026-09-03 shows
// THREE round trips, but the app recorded two — because a 4-lot long was
// exited in two 2-lot fills and this net-position walk only emits on a return
// to flat. It reported the LAST fill's price as the exit price of the whole
// 4 lots, turning a -$6.00 gross into a +$6.00 one. That row then fed
// mergeTradeRow's "a row must not contradict its own prices" repair, which
// recomputed the P&L from the wrong price and overwrote the correct
// balance-derived -$13.60 with -$1.60 on every poll — 683 self-heal warnings
// in one afternoon, none of which could ever converge.
const test = require('node:test');
const assert = require('node:assert');
const { reconstructClosedTradesFromOrders, parseISTTimestamp, istDayStartMs } = require('../tv-broker-feed.js');

const F = (side, qty, price, time) => ({
  Symbol: 'MNQU6', Side: side, Type: 'Market', Qty: String(qty),
  'Filled Qty': String(qty), 'Avg Fill Price': String(price),
  Status: 'Filled', 'Update Time': '2026-09-03 ' + time
});
const DAY = () => istDayStartMs(parseISTTimestamp('2026-09-03 12:00:00'));
const walk = (orders) => reconstructClosedTradesFromOrders(orders, DAY());

// Exactly the fills behind the statement's three rows. The 29283 entry is one
// 4-lot buy; the two sells that close it share that buy fill in the broker's
// own pairing (buyFillId 642677961223 appears on both).
const REAL_2026_09_03 = [
  F('Buy',  2, '29,260.75', '13:33:37'),
  F('Sell', 2, '29,264.00', '13:35:35'),
  F('Buy',  4, '29,283.00', '13:37:17'),
  F('Sell', 2, '29,280.75', '13:37:27'),
  F('Sell', 2, '29,283.75', '13:37:33'),
];

test('THE LIVE CASE: a split exit reports the volume-weighted exit price', () => {
  const closed = walk(REAL_2026_09_03);
  assert.equal(closed.length, 2, 'two flat-to-flat round trips (the broker pairs them as three fills)');

  const [a, b] = closed;
  assert.equal(a.size, 2);
  assert.equal(a.entryPrice, 29260.75);
  assert.equal(a.exitPrice, 29264.00, 'a single-fill exit is unchanged by weighting');

  assert.equal(b.size, 4);
  assert.equal(b.entryPrice, 29283.00);
  assert.equal(b.exitPrice, 29282.25, 'was 29283.75 — the last fill only; (29280.75*2 + 29283.75*2)/4');
});

test('THE CONSEQUENCE: the weighted price now yields the P&L the broker charged', () => {
  const b = walk(REAL_2026_09_03)[1];
  const POINT = 2, COMM_SIDE = 0.95;
  const gross = (b.exitPrice - b.entryPrice) * b.size * POINT;
  const net = gross - b.size * COMM_SIDE * 2;
  assert.equal(Math.round(gross * 100) / 100, -6.00, 'the statement: -$9.00 + $3.00');
  assert.equal(Math.round(net * 100) / 100, -13.60, 'matches the balance-derived fold exactly');
  // The number the old code produced, which nothing could reconcile.
  const oldGross = (29283.75 - 29283.00) * 4 * POINT;
  assert.equal(Math.round((oldGross - 4 * COMM_SIDE * 2) * 100) / 100, -1.60);
});

test('the whole day reconciles to the statement total', () => {
  const POINT = 2, COMM_SIDE = 0.95;
  const net = walk(REAL_2026_09_03).reduce((s, c) =>
    s + (c.exitPrice - c.entryPrice) * c.size * POINT - c.size * COMM_SIDE * 2, 0);
  assert.equal(Math.round(net * 100) / 100, -4.40, 'the day P&L the app displayed all along');
});

test('an ordinary single-fill round trip is untouched', () => {
  const closed = walk([F('Buy', 1, '29,565.00', '12:53:55'), F('Sell', 1, '29,564.75', '12:58:29')]);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].entryPrice, 29565.00);
  assert.equal(closed[0].exitPrice, 29564.75);
});

test('a scale-IN reports the weighted entry, not the first fill', () => {
  // Three 2-lot buys at rising prices, one 6-lot exit.
  const closed = walk([
    F('Buy',  2, '29,000.00', '13:00:00'),
    F('Buy',  2, '29,010.00', '13:01:00'),
    F('Buy',  2, '29,020.00', '13:02:00'),
    F('Sell', 6, '29,030.00', '13:03:00'),
  ]);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].size, 6);
  assert.equal(closed[0].entryPrice, 29010.00, 'was 29000 — the first fill only');
  assert.equal(closed[0].exitPrice, 29030.00);
});

test('an uneven split is a true VWAP, never snapped to a tick', () => {
  // 3 lots out at 29000, 1 lot out at 29004 -> 29001, exact.
  const closed = walk([
    F('Buy',  4, '28,990.00', '13:00:00'),
    F('Sell', 3, '29,000.00', '13:01:00'),
    F('Sell', 1, '29,004.00', '13:02:00'),
  ]);
  assert.equal(closed[0].exitPrice, 29001.00);
  // 1 lot at 29000, 2 at 29001 -> 29000.666667, deliberately NOT rounded to 0.25.
  const odd = walk([
    F('Buy',  3, '28,990.00', '14:00:00'),
    F('Sell', 1, '29,000.00', '14:01:00'),
    F('Sell', 2, '29,001.00', '14:02:00'),
  ]);
  assert.equal(odd[0].exitPrice, 29000.666667);
});

test('a REVERSAL splits the crossing fill between the two legs', () => {
  // Long 2, then sell 5: 2 close the long, 3 open a short. The short's entry
  // price is that same fill; the long's exit must not borrow the short's size.
  const closed = walk([
    F('Buy',  2, '29,000.00', '13:00:00'),
    F('Sell', 5, '29,010.00', '13:01:00'),
    F('Buy',  3, '29,020.00', '13:02:00'),
  ]);
  assert.equal(closed.length, 2);
  assert.equal(closed[0].side, 'buy');
  assert.equal(closed[0].size, 2);
  assert.equal(closed[0].exitPrice, 29010.00);
  assert.equal(closed[1].side, 'sell');
  assert.equal(closed[1].size, 3);
  assert.equal(closed[1].entryPrice, 29010.00, 'the residual opened the short at the crossing fill price');
  assert.equal(closed[1].exitPrice, 29020.00);
});

test('a partial exit followed by a scale back up still weights both sides', () => {
  const closed = walk([
    F('Buy',  4, '29,000.00', '13:00:00'),
    F('Sell', 2, '29,010.00', '13:01:00'),   // partial out
    F('Buy',  2, '29,020.00', '13:02:00'),   // back up to 4
    F('Sell', 4, '29,030.00', '13:03:00'),   // flat
  ]);
  assert.equal(closed.length, 1);
  // entry: 4 @ 29000 + 2 @ 29020 = 6 lots, 174040/6
  assert.equal(closed[0].entryPrice, Math.round((29000 * 4 + 29020 * 2) / 6 * 1e6) / 1e6);
  // exit: 2 @ 29010 + 4 @ 29030 = 6 lots
  assert.equal(closed[0].exitPrice, Math.round((29010 * 2 + 29030 * 4) / 6 * 1e6) / 1e6);
  assert.equal(closed[0].size, 4, 'size is still the PEAK position, not the total volume');
});
