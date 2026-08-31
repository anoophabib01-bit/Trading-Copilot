'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { checkTradeCountEscalation, F1_WIN_THRESHOLD, checkInvertedRR } = require('../mistake-patterns.js');

test('F1_WIN_THRESHOLD is 2, matching the documented "stop at 2 good trades" text', () => {
  assert.equal(F1_WIN_THRESHOLD, 2);
});

test('no trades: no match', () => {
  const r = checkTradeCountEscalation([]);
  assert.equal(r.matched, false);
  assert.equal(r.winCount, 0);
  assert.equal(r.message, null);
});

test('one winning trade: no match yet', () => {
  const r = checkTradeCountEscalation([{ pnl: 50 }]);
  assert.equal(r.matched, false);
  assert.equal(r.winCount, 1);
});

test('two winning trades: matches, cites the pattern text', () => {
  const r = checkTradeCountEscalation([{ pnl: 50 }, { pnl: 20 }]);
  assert.equal(r.matched, true);
  assert.equal(r.winCount, 2);
  assert.match(r.message, /PATTERN F1/);
  assert.match(r.message, /stop at 2 good trades/i);
  assert.match(r.message, /2 winning trades today/);
});

test('losses do not count toward the win threshold', () => {
  const r = checkTradeCountEscalation([{ pnl: -50 }, { pnl: -20 }, { pnl: -10 }]);
  assert.equal(r.matched, false);
  assert.equal(r.winCount, 0);
});

test('a mix of wins and losses: only wins count', () => {
  const r = checkTradeCountEscalation([{ pnl: 50 }, { pnl: -20 }, { pnl: 30 }, { pnl: -5 }]);
  assert.equal(r.winCount, 2);
  assert.equal(r.matched, true);
  assert.equal(r.totalCount, 4);
});

test('a zero-pnl trade (breakeven) does not count as a win', () => {
  const r = checkTradeCountEscalation([{ pnl: 0 }, { pnl: 0 }, { pnl: 0 }]);
  assert.equal(r.winCount, 0);
  assert.equal(r.matched, false);
});

test('backfilled trades with pnlUnknown are excluded from the win count', () => {
  const r = checkTradeCountEscalation([
    { pnl: 0, pnlUnknown: true, source: 'backfilled-from-orders' },
    { pnl: 50 },
  ]);
  assert.equal(r.winCount, 1, 'the pnlUnknown trade must not be counted as a win just because pnl is 0');
  assert.equal(r.matched, false);
});

test('three wins still matches (threshold is >=, not exact)', () => {
  const r = checkTradeCountEscalation([{ pnl: 10 }, { pnl: 10 }, { pnl: 10 }]);
  assert.equal(r.matched, true);
  assert.equal(r.winCount, 3);
});

test('garbage input never throws', () => {
  assert.equal(checkTradeCountEscalation(null).matched, false);
  assert.equal(checkTradeCountEscalation(undefined).matched, false);
  assert.equal(checkTradeCountEscalation('nope').matched, false);
  assert.equal(checkTradeCountEscalation([null, undefined, {}, { pnl: 'x' }]).matched, false);
});

// ── F2: revenge clusters (2026-08-20) ──────────────────────────────────────
const { checkRevengeCluster, F2_LOSS_STREAK } = require('../mistake-patterns.js');

const MIN = 60000;
const OPTS = { cooldownMinutes: 15 }; // rules.json standard mode

test('F2_LOSS_STREAK is 2, matching "two losses in a row = close platform"', () => {
  assert.equal(F2_LOSS_STREAK, 2);
});

test('F2: no trades / one trade: no match', () => {
  assert.equal(checkRevengeCluster([], OPTS).matched, false);
  assert.equal(checkRevengeCluster([{ pnl: -100, at: 0 }], OPTS).matched, false);
});

test('F2a: two consecutive losses match and cite the platform-close rule', () => {
  const r = checkRevengeCluster([{ pnl: -100, at: 0 }, { pnl: -80, at: 60 * MIN }], OPTS);
  assert.equal(r.matched, true);
  assert.equal(r.kind, 'consecutive-losses');
  assert.equal(r.lossStreak, 2);
  assert.match(r.message, /PATTERN F2/);
  assert.match(r.message, /close platform/i);
});

test('F2a: a win between two losses breaks the streak', () => {
  const r = checkRevengeCluster(
    [{ pnl: -100, at: 0 }, { pnl: 40, at: 60 * MIN }, { pnl: -50, at: 120 * MIN }], OPTS);
  assert.equal(r.matched, false);
  assert.equal(r.lossStreak, 1);
});

test('F2a: streak is counted from the END, not anywhere in the day', () => {
  // two early losses, then a win — the day is no longer in a streak
  const r = checkRevengeCluster(
    [{ pnl: -10, at: 0 }, { pnl: -10, at: 30 * MIN }, { pnl: 5, at: 60 * MIN }], OPTS);
  assert.equal(r.matched, false);
  assert.equal(r.lossStreak, 0);
});

test('F2a: three consecutive losses still match, streak reported honestly', () => {
  const r = checkRevengeCluster(
    [{ pnl: -10, at: 0 }, { pnl: -10, at: 20 * MIN }, { pnl: -10, at: 40 * MIN }], OPTS);
  assert.equal(r.matched, true);
  assert.equal(r.lossStreak, 3);
  assert.match(r.message, /3 losing trades back to back/);
});

test('F2b: a trade closing inside the cooldown after a loss matches', () => {
  const r = checkRevengeCluster([{ pnl: -100, at: 0 }, { pnl: 20, at: 4 * MIN }], OPTS);
  assert.equal(r.matched, true);
  assert.equal(r.kind, 'rapid-reentry');
  assert.equal(r.gapMinutes, 4);
  assert.match(r.message, /15-minute cooldown/);
});

test('F2b: outside the cooldown does not match', () => {
  const r = checkRevengeCluster([{ pnl: -100, at: 0 }, { pnl: 20, at: 20 * MIN }], OPTS);
  assert.equal(r.matched, false);
});

test('F2b: a fast re-entry after a WIN is not revenge, no match', () => {
  const r = checkRevengeCluster([{ pnl: 100, at: 0 }, { pnl: 20, at: 2 * MIN }], OPTS);
  assert.equal(r.matched, false);
});

test('F2b: uses the cooldown it is GIVEN (scalper mode is tighter)', () => {
  const trades = [{ pnl: -100, at: 0 }, { pnl: 20, at: 8 * MIN }];
  assert.equal(checkRevengeCluster(trades, { cooldownMinutes: 15 }).matched, true, '8 min is inside a 15-min cooldown');
  assert.equal(checkRevengeCluster(trades, { cooldownMinutes: 5 }).matched, false, '8 min is outside a 5-min cooldown');
});

test('F2b: no cooldown supplied disables F2b but leaves F2a working', () => {
  assert.equal(checkRevengeCluster([{ pnl: -100, at: 0 }, { pnl: 20, at: 1 * MIN }]).matched, false);
  assert.equal(checkRevengeCluster([{ pnl: -100, at: 0 }, { pnl: -20, at: 1 * MIN }]).matched, true);
});

test('F2: consecutive losses take precedence over rapid re-entry', () => {
  // both would match — a fast re-entry that also lost
  const r = checkRevengeCluster([{ pnl: -100, at: 0 }, { pnl: -20, at: 2 * MIN }], OPTS);
  assert.equal(r.kind, 'consecutive-losses');
});

test('F2: pnlUnknown backfills are never scored as losses', () => {
  const r = checkRevengeCluster(
    [{ pnl: 0, pnlUnknown: true, at: 0 }, { pnl: 0, pnlUnknown: true, at: 10 * MIN }], OPTS);
  assert.equal(r.matched, false);
  assert.equal(r.lossStreak, 0);
});

test('F2: inferred (poll-aliased) trades ARE scored — their P&L is exact', () => {
  const r = checkRevengeCluster(
    [{ pnl: -30, at: 0, size: 0, inferred: true }, { pnl: -15, at: 5 * MIN, size: 0, inferred: true }], OPTS);
  assert.equal(r.matched, true);
  assert.equal(r.kind, 'consecutive-losses');
});

test('F2b: out-of-order or identical timestamps are not treated as a fast re-entry', () => {
  assert.equal(checkRevengeCluster([{ pnl: -100, at: 10 * MIN }, { pnl: 20, at: 10 * MIN }], OPTS).matched, false);
  assert.equal(checkRevengeCluster([{ pnl: -100, at: 10 * MIN }, { pnl: 20, at: 2 * MIN }], OPTS).matched, false);
});

test('F2: garbage input never throws', () => {
  assert.equal(checkRevengeCluster(null, OPTS).matched, false);
  assert.equal(checkRevengeCluster('nope', OPTS).matched, false);
  assert.equal(checkRevengeCluster([null, undefined, {}, { pnl: 'x' }], OPTS).matched, false);
  assert.equal(checkRevengeCluster([{ pnl: -1, at: 0 }, { pnl: -1, at: 1 }], { cooldownMinutes: NaN }).matched, true);
});

// ── Regression tests for the two F2 bugs found in review, 2026-08-20 ───────
// Both were live-reachable and neither was covered by the tests above.

test('F2a: an UNKNOWN-P&L trade between two losses does NOT fabricate a streak', () => {
  // The bug: pnlUnknown trades were filtered out first, closing the gap the
  // middle trade left behind — so loss -> (backfilled trade, possibly a WIN)
  // -> loss reported "2 losing trades back to back" and told him to close the
  // platform. Backfilled trades are exactly the fast scalps the 10s poll
  // aliases past, so this sequence is common.
  const r = checkRevengeCluster([
    { pnl: -100, at: 0 },
    { pnl: 0, pnlUnknown: true, at: 5 * MIN },
    { pnl: -50, at: 30 * MIN },
  ], OPTS);
  assert.equal(r.matched, false, 'must not claim a streak across a trade whose outcome is unknown');
  assert.equal(r.indeterminate, true, '"cannot tell" must be distinguishable from "no streak"');
});

test('F2a: a REAL streak after an unknown trade still fires', () => {
  // The unknown trade is older than the two confirmed losses, so it never
  // enters the walk — declining to judge here would be over-correction.
  const r = checkRevengeCluster([
    { pnl: 0, pnlUnknown: true, at: 0 },
    { pnl: -100, at: 30 * MIN },
    { pnl: -50, at: 60 * MIN },
  ], OPTS);
  assert.equal(r.matched, true);
  assert.equal(r.kind, 'consecutive-losses');
});

test('F2b: gap is NOT measured across an unknown trade sitting between the two', () => {
  // Without raw-list adjacency, prev/last would be the two confirmed trades
  // 4 minutes apart — while a real trade actually closed in between, making
  // the "the real gap was even shorter" claim in the message false.
  const r = checkRevengeCluster([
    { pnl: -100, at: 0 },
    { pnl: 0, pnlUnknown: true, at: 2 * MIN },
    { pnl: 20, at: 4 * MIN },
  ], OPTS);
  assert.equal(r.matched, false);
});

test('F2b: boundary — exactly at the cooldown does not match, one ms under does', () => {
  assert.equal(checkRevengeCluster([{ pnl: -1, at: 0 }, { pnl: 1, at: 15 * MIN }], OPTS).matched, false);
  assert.equal(checkRevengeCluster([{ pnl: -1, at: 0 }, { pnl: 1, at: 15 * MIN - 1 }], OPTS).matched, true);
});

test('F2b: a breakeven previous trade (pnl 0) is not a loss, so no rapid-reentry', () => {
  assert.equal(checkRevengeCluster([{ pnl: 0, at: 0 }, { pnl: 20, at: 2 * MIN }], OPTS).matched, false);
});

test('F2b: sub-minute gap uses the "under a minute" wording', () => {
  const r = checkRevengeCluster([{ pnl: -100, at: 0 }, { pnl: 20, at: 30000 }], OPTS);
  assert.equal(r.matched, true);
  assert.match(r.message, /under a minute/);
});

test('F2: a backfilled record built by the REAL reconstructor is treated as unknown', () => {
  // Fixture built by calling the actual producer rather than hand-writing the
  // shape — the two modules cannot drift apart without this test failing.
  const { reconstructClosedTradesFromOrders, istDayStartMs } = require('../tv-broker-feed.js');
  const dayKey = istDayStartMs(Date.parse('2026-08-19T06:00:00Z'));
  const built = reconstructClosedTradesFromOrders([
    { Status: 'Filled', Symbol: 'MNQ1!', Side: 'Buy', 'Filled Qty': '2', 'Avg Fill Price': '24500.00', 'Update Time': '2026-08-19 13:08:15', 'Order ID': '1' },
    { Status: 'Filled', Symbol: 'MNQ1!', Side: 'Sell', 'Filled Qty': '2', 'Avg Fill Price': '24510.00', 'Update Time': '2026-08-19 13:10:15', 'Order ID': '2' },
  ], dayKey);
  assert.equal(built.length, 1, 'reconstructor should produce one closed round trip');
  assert.equal(built[0].pnlUnknown, true);
  assert.equal(typeof built[0].at, 'number', 'backfilled records must carry `at` — every consumer reads it');
  // Between two losses, this real record must block the streak.
  const r = checkRevengeCluster([{ pnl: -100, at: dayKey }, built[0], { pnl: -20, at: dayKey + 60 * MIN }], OPTS);
  assert.equal(r.matched, false);
  assert.equal(r.indeterminate, true);
});

// ── F3 — inverted R:R (LIVE_FEED_LOOP_PLAN 5.3) ─────────────────────────────
test('F3: fewer than f3MinWins wins never fires', () => {
  const r = checkInvertedRR([{ pnl: 5 }, { pnl: -200 }, { pnl: -10 }], { f3Ratio: 2, f3MinWins: 2 });
  assert.equal(r.matched, false);
});

test('F3: no loss never fires', () => {
  const r = checkInvertedRR([{ pnl: 15 }, { pnl: 25 }], { f3Ratio: 2, f3MinWins: 2 });
  assert.equal(r.matched, false);
});

test('F3: fires when avgLoss >= ratio × avgWin with enough wins', () => {
  const r = checkInvertedRR([{ pnl: 10 }, { pnl: 12 }, { pnl: -45 }], { f3Ratio: 2, f3MinWins: 2 });
  assert.equal(r.matched, true);
  assert.equal(r.winCount, 2);
  assert.equal(r.lossCount, 1);
  assert.equal(r.avgWin, 11);
  assert.equal(r.avgLoss, 45);
  assert.match(r.message, /PATTERN F3/);
});

test('F3: does NOT fire when losses are small relative to wins', () => {
  const r = checkInvertedRR([{ pnl: 50 }, { pnl: 60 }, { pnl: -45 }], { f3Ratio: 2, f3MinWins: 2 });
  assert.equal(r.matched, false);
  assert.equal(r.message, null);
});

test('F3: pnlUnknown trades are excluded from the win/loss math', () => {
  const r = checkInvertedRR([{ pnl: 10 }, { pnl: 12 }, { pnl: 0, pnlUnknown: true }, { pnl: -45 }], { f3Ratio: 2, f3MinWins: 2 });
  assert.equal(r.matched, true); // the unknown trade neither helps nor blocks the ratio
  assert.equal(r.winCount, 2);
  assert.equal(r.lossCount, 1);
});

test('F3: defaults apply when opts are missing (ratio 2, minWins 2)', () => {
  const r = checkInvertedRR([{ pnl: 10 }, { pnl: 10 }, { pnl: -40 }], null);
  assert.equal(r.matched, true);
});

// ── F4: break-even churn (2026-08-25) ───────────────────────────────────────
// Anoop: "Consider anything below 100$ and above -100$ as not a trade... After
// 5 break even trades, I want you to remind me."
const { checkBreakEvenChurn } = require('../mistake-patterns.js');
const F4OPTS = { breakEvenBandUsd: 100, breakEvenReminderCount: 5, commissionPerContractPerSide: 0.95 };

test('F4: replays his real 2026-08-25 day — 8 of 11 landed inside the band', () => {
  const rows = [
    { size: 5, pnl: -280 }, { size: 2, pnl: -2.8 }, { size: 6, pnl: -291.4 },
    { size: 2, pnl: -25.8 }, { size: 8, pnl: -15.6 }, { size: 6, pnl: -26.4 },
    { size: 8, pnl: 20.3 }, { size: 12, pnl: 23.2 }, { size: 1, pnl: 5.6 },
    { size: 2, pnl: -0.8 }, { size: 8, pnl: 907.8 },
  ];
  const r = checkBreakEvenChurn(rows, F4OPTS);
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.breakEvenCount, 8);
  assert.strictEqual(r.realCount, 3);
  assert.strictEqual(r.totalCount, 11);
  assert.strictEqual(r.feesRisked, 77.9);
  assert.ok(r.message.includes('8 of your 11'), r.message);
});

test('F4: does NOT fire below his stated count of 5', () => {
  const rows = [{ size: 1, pnl: 5 }, { size: 1, pnl: -5 }, { size: 1, pnl: 5 }, { size: 1, pnl: -5 }];
  const r = checkBreakEvenChurn(rows, F4OPTS);
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.breakEvenCount, 4);
  assert.strictEqual(r.message, null);
});

test('F4: fires exactly AT 5', () => {
  const rows = Array.from({ length: 5 }, () => ({ size: 1, pnl: 5 }));
  assert.strictEqual(checkBreakEvenChurn(rows, F4OPTS).matched, true);
});

test('F4: the band is exclusive — exactly $100 is a REAL trade', () => {
  const rows = Array.from({ length: 5 }, () => ({ size: 1, pnl: 100 }));
  const r = checkBreakEvenChurn(rows, F4OPTS);
  assert.strictEqual(r.breakEvenCount, 0);
  assert.strictEqual(r.realCount, 5);
});

test('F4: a big LOSS is a real trade, not break-even', () => {
  const rows = Array.from({ length: 5 }, () => ({ size: 1, pnl: -250 }));
  assert.strictEqual(checkBreakEvenChurn(rows, F4OPTS).breakEvenCount, 0);
});

test('F4: reads the band from rules, not from a hardcoded 100', () => {
  const rows = Array.from({ length: 5 }, () => ({ size: 1, pnl: 150 }));
  const wide = checkBreakEvenChurn(rows, { breakEvenBandUsd: 200, breakEvenReminderCount: 5 });
  assert.strictEqual(wide.breakEvenCount, 5);
  assert.strictEqual(wide.band, 200);
});

test('F4: pnlUnknown rows are counted neither way', () => {
  const rows = [].concat(Array.from({ length: 5 }, () => ({ size: 1, pnl: 5 })),
                         [{ size: 1, pnl: 0, pnlUnknown: true }]);
  const r = checkBreakEvenChurn(rows, F4OPTS);
  assert.strictEqual(r.totalCount, 5);
  assert.strictEqual(r.breakEvenCount, 5);
});

test('F4: fees stay null when any size was unobserved, never a partial sum', () => {
  const rows = [].concat(Array.from({ length: 4 }, () => ({ size: 1, pnl: 5 })), [{ size: 0, pnl: 5 }]);
  const r = checkBreakEvenChurn(rows, F4OPTS);
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.feesRisked, null);
  assert.ok(!/commission/.test(r.message), 'must not claim a fee total it cannot compute');
});

test('F4: an empty day is not a match', () => {
  assert.strictEqual(checkBreakEvenChurn([], F4OPTS).matched, false);
  assert.strictEqual(checkBreakEvenChurn(null, F4OPTS).matched, false);
});
