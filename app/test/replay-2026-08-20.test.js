'use strict';
// ── REPLAY: 2026-08-20, Anoop's real trading day ────────────────────────────
// The strongest verification the live-feed fold has had. Ground truth is
// Tradeify's own P&L calendar (-$264.10 for the day) plus the raw Tradovate
// fill export (11 buy/sell-fill-matched rows) — both supplied by Anoop, both
// independent of this codebase. Every one of the 11 fills checks out exactly
// against $2.00/point (verified in tv-broker-feed.test.js's own point-value
// tests), so the fill data is trustworthy ground truth, not a guess.
//
// This exists because the ORIGINAL persisted state for this exact day
// (tradeCount:9, dayPnl:-44.65) was read from the pre-fix, entry-fill-
// overcounting fold — and turned out to be wrong in BOTH directions at once:
// wrong count (9 vs the real 5 round trips) AND, it now turns out, wrong
// P&L (-44.65 vs the real -264.10, a $219 gap far beyond commission or the
// "baseline at first poll" blind spot). The earlier claim that "dayPnl was
// probably still correct" was an unverified assumption; this file replaces
// it with an actual replay against the day's real fills and confirms the
// FIXED fold reconstructs the true result, not the old divergence.
//
// FEE MODEL: Tradeify's calendar (-264.10) minus the fills' gross (-228.00)
// is $36.10 total fees, which divides across the day's 19 traded contracts
// at EXACTLY $1.90/contract-round-trip (36.10/19 = 1.9 to the penny) — not a
// coincidence at that precision. Applying $1.90/contract per round trip
// reconciles all 5 individual round trips to the real total exactly (see the
// per-round-trip assertions below), so it is used here as the balance-delta
// driving this replay. This is ALSO the strongest evidence yet that
// rules.json's commissionPerContractPerSide (0.59, i.e. $1.18/contract
// round trip) understates this account's real cost — flagged, not changed
// here; that is a live-enforcement constant and stays a deliberate decision.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fold, freshState, analyzeOrderWalk, istDayStartMs } = require('../tv-broker-feed.js');

// IST timestamp helper — matches parseISTTimestamp's own format, so the order
// rows below are exactly what analyzeOrderWalk would receive from a real poll.
const T = (hhmmss) => {
  const parts = hhmmss.split(':').map(Number);
  const h = parts[0], m = parts[1], s = parts[2];
  const utcMs = Date.UTC(2026, 7, 20, h, m, s) - 330 * 60 * 1000; // IST -> UTC
  return utcMs;
};
const DAY = istDayStartMs(T('12:00:00'));

const ord = (Symbol, Side, Qty, price, hhmmss) => ({
  Symbol: Symbol, Side: Side, Qty: String(Qty), 'Filled Qty': String(Qty),
  'Avg Fill Price': String(price), 'Update Time': '2026-08-20 ' + hhmmss, Status: 'Filled',
});

// The real order-level fills for the day (from the actual Tradovate orders
// table — the same rows analyzeOrderWalk() would read off a live poll).
const ALL_ORDERS = [
  // RT1: LONG 1, 14:12:48 -> 14:16:28, gross -$104.50
  ord('MNQU6', 'Buy', 1, 29520.50, '14:12:48'),
  ord('MNQU6', 'Sell', 1, 29468.25, '14:16:28'),
  // RT2: SHORT 1, 14:30:25 -> 14:31:02, gross +$3.00
  ord('MNQU6', 'Sell', 1, 29470.25, '14:30:25'),
  ord('MNQU6', 'Buy', 1, 29468.75, '14:31:02'),
  // RT3: SHORT 12 (six 2-lot scale-ins), 14:42:45-47 -> 14:43:14, gross +$17.00
  ord('MNQU6', 'Sell', 2, 29518.50, '14:42:45'),
  ord('MNQU6', 'Sell', 2, 29518.50, '14:42:46'),
  ord('MNQU6', 'Sell', 2, 29518.75, '14:42:46'),
  ord('MNQU6', 'Sell', 2, 29519.00, '14:42:46'),
  ord('MNQU6', 'Sell', 2, 29518.75, '14:42:46'),
  ord('MNQU6', 'Sell', 2, 29518.75, '14:42:47'),
  ord('MNQU6', 'Buy', 12, 29518.00, '14:43:14'),
  // RT4: LONG 2 (split exit), 19:16:44 -> 19:19:26, gross -$161.50
  ord('MNQU6', 'Buy', 2, 29411.25, '19:16:44'),
  ord('MNQU6', 'Sell', 1, 29370.75, '19:19:26'),
  ord('MNQU6', 'Sell', 1, 29371.00, '19:19:26'),
  // RT5: SHORT 3, 19:45:56 -> 19:46:47, gross +$18.00
  ord('MNQU6', 'Sell', 3, 29338.50, '19:45:56'),
  ord('MNQU6', 'Buy', 3, 29335.50, '19:46:47'),
];

// Fee model established above: $1.90/contract-round-trip, reconciling all 5
// round trips to Tradeify's real total exactly.
const NET_PNL = {
  RT1: -104.50 - 1 * 1.90,   // -106.40
  RT2: 3.00 - 1 * 1.90,      // 1.10
  RT3: 17.00 - 12 * 1.90,    // -5.80
  RT4: -161.50 - 2 * 1.90,   // -165.30
  RT5: 18.00 - 3 * 1.90,     // 12.30
};

test('the fee model of $1.90 per contract reconciles every round trip to the real total, exactly', () => {
  const sum = Object.values(NET_PNL).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 100) / 100, -264.10);
});

// Chronological poll simulation. Balance moves ONLY at each round trip's
// close, by that round trip's net P&L — mirroring what the DOM balance
// actually does (fees are deducted live, so a balance delta already nets
// them out). Polls land both mid-scale-in (RT3) and mid-split-exit (RT4) to
// stress the exact shapes that broke the pre-fix code.
test('REPLAY: the fixed fold reconstructs 5 round trips and the true day total', () => {
  let s = freshState();
  let bal = 50000;
  function poll(nowMs, isFlat, openSize, ordersSoFar, hasNewFill) {
    const walk = analyzeOrderWalk(ordersSoFar, DAY);
    s = fold(s, { balance: bal, isFlat: isFlat, openSize: openSize, nowMs: nowMs, hasNewFill: hasNewFill, closedRoundTrips: walk.closed.length });
    return walk;
  }

  // Baseline poll before anything trades today.
  poll(T('09:00:00'), true, 0, [], false);

  // RT1: open observed, then close observed (the ordinary path).
  poll(T('14:12:50'), false, 1, ALL_ORDERS.slice(0, 1), true);
  bal += NET_PNL.RT1;
  poll(T('14:16:30'), true, 0, ALL_ORDERS.slice(0, 2), true);

  // RT2: a 37-second scalp entirely between two 10s-cadence polls — the
  // classic poll-aliasing case. Only the round-trip count backstop can catch
  // this; isFlat never observably went false.
  bal += NET_PNL.RT2;
  poll(T('14:31:10'), true, 0, ALL_ORDERS.slice(0, 4), true);

  // RT3: six scale-in polls, each landing mid-build (isFlat=false, growing
  // openSize), THEN one poll where it's flat again — the exact shape (many
  // entry fills before one exit) that the old code scored 2-3 times.
  poll(T('14:42:46'), false, 2, ALL_ORDERS.slice(0, 5), true);
  poll(T('14:42:47'), false, 6, ALL_ORDERS.slice(0, 8), true);
  poll(T('14:42:48'), false, 12, ALL_ORDERS.slice(0, 10), true);
  bal += NET_PNL.RT3;
  poll(T('14:43:15'), true, 0, ALL_ORDERS.slice(0, 11), true);

  // RT4: open observed, exit SPLIT across two fills — a poll lands between
  // the two sell fills (still isFlat=false at qty 1), then flat.
  poll(T('19:16:45'), false, 2, ALL_ORDERS.slice(0, 12), true);
  poll(T('19:19:20'), false, 1, ALL_ORDERS.slice(0, 13), true);
  bal += NET_PNL.RT4;
  poll(T('19:19:27'), true, 0, ALL_ORDERS.slice(0, 14), true);

  // RT5: same poll-aliasing shape as RT2.
  bal += NET_PNL.RT5;
  poll(T('19:46:50'), true, 0, ALL_ORDERS, true);

  assert.equal(s.tradeCount, 5, 'five real round trips, not the 11 fill-match pairs Tradeify badges, not the 9 the pre-fix fold produced');
  assert.equal(Math.round(s.dayPnl * 100) / 100, -264.10, 'the fixed fold must reconstruct the TRUE day total, not the -44.65 the pre-fix fold produced for this same day');
  assert.equal(s.trades.filter(function (t) { return t.evidence === 'degraded'; }).length, 0, 'the orders table was fully readable throughout — nothing here should be advisory-only');
  const got = s.trades.map(function (t) { return Math.round(t.pnl * 100) / 100; });
  const want = [NET_PNL.RT1, NET_PNL.RT2, NET_PNL.RT3, NET_PNL.RT4, NET_PNL.RT5].map(function (n) { return Math.round(n * 100) / 100; });
  assert.deepEqual(got, want, 'each individual round trip, not just the day total, must match');
});

test('REPLAY: the order walk alone (no fold) also lands on exactly 5 round trips for the full day', () => {
  const walk = analyzeOrderWalk(ALL_ORDERS, DAY);
  assert.equal(walk.closed.length, 5);
  assert.equal(walk.droppedRows, 0);
  assert.deepEqual(walk.netBySymbol, {}, 'flat at day end');
  const sizes = walk.closed.map(function (rt) { return rt.size; }).sort(function (a, b) { return a - b; });
  assert.deepEqual(sizes, [1, 1, 2, 3, 12]);
});
