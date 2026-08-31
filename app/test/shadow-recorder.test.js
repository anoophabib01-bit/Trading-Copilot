'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildHumanTradeRecord, buildMachineOrder, discriminate } = require('../shadow-recorder.js');

const trade = (o) => Object.assign({ at: 1000, side: 'LONG', size: 2, ep: 100, xp: 110, pnl: 200, hold: 600 }, o);
const ctx = (o) => Object.assign({ day: '2026-08-26', breakEvenBandUsd: 100, sessionTier: 'NY' }, o);

// ── outcome classification ──────────────────────────────────────────────────
test('a trade inside the break-even band is neither a win nor a loss', () => {
  assert.equal(buildHumanTradeRecord(trade({ pnl: 50 }), ctx()).outcome, 'breakeven');
  assert.equal(buildHumanTradeRecord(trade({ pnl: -50 }), ctx()).outcome, 'breakeven');
  assert.equal(buildHumanTradeRecord(trade({ pnl: 200 }), ctx()).outcome, 'win');
  assert.equal(buildHumanTradeRecord(trade({ pnl: -200 }), ctx()).outcome, 'loss');
});

test('an unknown P&L yields a null outcome, never a default', () => {
  assert.equal(buildHumanTradeRecord(trade({ pnl: undefined }), ctx()).outcome, null);
});

// ── behavioural derivations ─────────────────────────────────────────────────
test('fast re-entry after a loss is flagged; after a win it is not', () => {
  assert.equal(buildHumanTradeRecord(trade(), ctx({ prevTradeOutcome: 'loss', minutesSincePrevTrade: 5 })).fastReentryAfterLoss, true);
  assert.equal(buildHumanTradeRecord(trade(), ctx({ prevTradeOutcome: 'loss', minutesSincePrevTrade: 60 })).fastReentryAfterLoss, false);
  assert.equal(buildHumanTradeRecord(trade(), ctx({ prevTradeOutcome: 'win', minutesSincePrevTrade: 5 })).fastReentryAfterLoss, null);
});

test('sizing up after a loss is flagged only when both sizes are known', () => {
  assert.equal(buildHumanTradeRecord(trade({ size: 4 }), ctx({ prevTradeOutcome: 'loss', prevSize: 2 })).sizeUpAfterLoss, true);
  assert.equal(buildHumanTradeRecord(trade({ size: 2 }), ctx({ prevTradeOutcome: 'loss', prevSize: 2 })).sizeUpAfterLoss, false);
  assert.equal(buildHumanTradeRecord(trade({ size: 4 }), ctx({ prevTradeOutcome: 'loss' })).sizeUpAfterLoss, null);
});

test('missing context never becomes a fabricated value', () => {
  const r = buildHumanTradeRecord(trade(), {});
  for (const k of ['sessionTier', 'hourTrend', 'adx', 'tradeNumberToday', 'dayPnlBefore', 'signalBacked']) {
    assert.equal(r[k], null, `${k} should be null when unknown`);
  }
});

// ── machine orders ──────────────────────────────────────────────────────────
test('a machine order is born unresolved and carries no P&L', () => {
  const o = buildMachineOrder({ playbook: 'DSH-V2', direction: 'BULLISH', entry: 100, stop: 90, riskPoints: 10 }, { contracts: 4, pointValue: 2 });
  assert.equal(o.resolved, false);
  assert.equal(o.netUsd, null);
  assert.equal(o.riskUsd, 80);   // 10pt * $2 * 4
});

test('risk in dollars is null rather than NaN when size or risk is unknown', () => {
  assert.equal(buildMachineOrder({ entry: 100 }, { contracts: 4, pointValue: 2 }).riskUsd, null);
  assert.equal(buildMachineOrder({ riskPoints: 10 }, {}).riskUsd, null);
});

// ── THE DISCRIMINATOR — the part that makes "copy good trades" real ─────────
const mk = (outcome, o) => Object.assign({ outcome, side: 'LONG' }, o);

test('a feature present equally in winners and losers is called out as worthless', () => {
  // 10 wins and 10 losses, ALL signal-backed. Naive "what did my winners have
  // in common?" would report signal-backed at 100% and call it the edge.
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(mk('win', { signalBacked: true }));
  for (let i = 0; i < 10; i++) rows.push(mk('loss', { signalBacked: true }));
  const d = discriminate(rows, { minSample: 5 });
  const f = d.find((x) => /signal-backed/.test(x.feature));
  assert.equal(f.winRate, 1);
  assert.equal(f.lossRate, 1);
  assert.equal(f.lift, 0);
  assert.match(f.verdict, /no separation/);
});

test('a feature that genuinely separates is identified with its direction', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(mk('win', { tradeNumberToday: 1 }));      // winners early
  for (let i = 0; i < 10; i++) rows.push(mk('loss', { tradeNumberToday: 9 }));     // losers late
  const d = discriminate(rows, { minSample: 5 });
  const f = d.find((x) => /first 3 trades/.test(x.feature));
  assert.equal(f.lift, 1);
  assert.match(f.verdict, /MORE common in winners/);
});

test('a feature concentrated in losers is flagged as such, not hidden', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(mk('win', { fastReentryAfterLoss: false }));
  for (let i = 0; i < 10; i++) rows.push(mk('loss', { fastReentryAfterLoss: true }));
  const f = discriminate(rows, { minSample: 5 }).find((x) => /fast re-entry/.test(x.feature));
  assert.equal(f.lift, -1);
  assert.match(f.verdict, /MORE common in losers/);
});

test('break-even trades are excluded from both groups', () => {
  const rows = [mk('win', { signalBacked: true }), mk('loss', { signalBacked: false })];
  for (let i = 0; i < 50; i++) rows.push(mk('breakeven', { signalBacked: true }));
  const f = discriminate(rows, { minSample: 1 }).find((x) => /signal-backed/.test(x.feature));
  assert.equal(f.n, 2, 'only the win and the loss should count');
});

test('a thin sample reports the lift but REFUSES to interpret it', () => {
  const rows = [mk('win', { tradeNumberToday: 1 }), mk('loss', { tradeNumberToday: 9 })];
  const f = discriminate(rows, { minSample: 20 }).find((x) => /first 3 trades/.test(x.feature));
  assert.equal(f.lift, 1);
  assert.match(f.verdict, /too few trades/);
});

test('unknown values are excluded, not counted as absent', () => {
  const rows = [mk('win', { adx: 30 }), mk('win', {}), mk('loss', { adx: 10 }), mk('loss', {})];
  const f = discriminate(rows, { minSample: 1 }).find((x) => /ADX/.test(x.feature));
  assert.equal(f.n, 2, 'the two trades with no ADX reading must not be scored as "not trending"');
  assert.equal(f.lift, 1);
});

test('no winners or no losers yields "no data" rather than a divide-by-zero', () => {
  const onlyWins = [mk('win', { signalBacked: true }), mk('win', { signalBacked: true })];
  for (const f of discriminate(onlyWins, { minSample: 1 })) {
    assert.ok(f.lift === null || f.verdict === 'no data', 'a winners-only sample can support no conclusion at all');
  }
});

// ── The vocabulary bug the first production trade exposed ──────────────────
test('a human record is built from the ROW shape (ep/xp/hold/side), not the raw fold record', () => {
  // The live fold's `record` speaks entryPrice/exitPrice/entryAt + a raw side;
  // the `row` speaks ep/xp/hold + normalized LONG/SHORT. Hooked on the wrong
  // one, the first real captured trade had null side, entry, exit and hold —
  // silently disabling three discriminator features.
  const row = { t: 1000, x: 2000, size: 2, pnl: -203, side: 'SHORT', ep: 29200, xp: 29250, hold: 340 };
  const r = buildHumanTradeRecord(Object.assign({}, row, { at: 2000, entryAt: row.t }), ctx());
  assert.equal(r.side, 'SHORT');
  assert.equal(r.entry, 29200);
  assert.equal(r.exit, 29250);
  assert.equal(r.holdSeconds, 340);
  assert.equal(r.outcome, 'loss');
});

test('with side present, the trend-agreement features become evaluable', () => {
  const { discriminate } = require('../shadow-recorder.js');
  const withSide = [
    { outcome: 'win', side: 'LONG', hourTrend: 'STRONG BULL' },
    { outcome: 'loss', side: 'LONG', hourTrend: 'STRONG BEAR' },
  ];
  const f = discriminate(withSide, { minSample: 1 }).find((x) => /1H trend/.test(x.feature));
  assert.equal(f.n, 2, 'both trades scoreable once side is known');
  assert.equal(f.lift, 1);

  const noSide = withSide.map((r) => Object.assign({}, r, { side: null }));
  const g = discriminate(noSide, { minSample: 1 }).find((x) => /1H trend/.test(x.feature));
  assert.equal(g.n, 0, 'without side the feature is correctly unevaluable, not guessed');
});

// ── Ticket units: dollars AND ticks (2026-08-26, Anoop's request) ──────────
const { riskUnits, DEFAULT_TICK_SIZE } = require('../shadow-recorder.js');

test('MNQ tick math: 0.25 points per tick, $0.50 per tick per contract', () => {
  assert.equal(DEFAULT_TICK_SIZE, 0.25);
  const u = riskUnits(10, 0.25, 2, 1);
  assert.equal(u.points, 10);
  assert.equal(u.ticks, 40);        // 10 / 0.25
  assert.equal(u.usd, 20);          // 10 * $2 * 1
});

test('ticks are size-independent; dollars are not', () => {
  const one = riskUnits(79.5, 0.25, 2, 1);
  const four = riskUnits(79.5, 0.25, 2, 4);
  assert.equal(one.ticks, four.ticks, 'the stop is the same distance whatever the size');
  assert.equal(four.usd, one.usd * 4);
});

test('the real setup that fired on 2026-08-26 converts correctly', () => {
  const stop = riskUnits(79.5, 0.25, 2, 4);
  assert.equal(stop.ticks, 318);
  assert.equal(stop.usd, 636);      // and $636 > the $300 limit — correctly blocked
});

test('a non-finite distance yields null, never NaN ticks', () => {
  assert.equal(riskUnits(NaN, 0.25, 2, 4), null);
  assert.equal(riskUnits(undefined, 0.25, 2, 4), null);
});

test('a bad tick size falls back to the MNQ default instead of dividing by zero', () => {
  assert.equal(riskUnits(10, 0, 2, 1).ticks, 40);
  assert.equal(riskUnits(10, null, 2, 1).ticks, 40);
});

test('the ticket carries direction, both distances and the reasoning', () => {
  const o = buildMachineOrder(
    { playbook: 'B', direction: 'BEARISH', entry: 29174.25, stop: 29253.75, target: 29015.25, riskPoints: 79.5 },
    { day: 'D', contracts: 4, pointValue: 2, tickSize: 0.25, why: ['raid swept 29253.75', 'FVG in the raid direction'] });
  assert.equal(o.direction, 'BEARISH');
  assert.equal(o.stopDistance.ticks, 318);
  assert.equal(o.targetDistance.ticks, 636);
  assert.equal(o.rMultiple, 2);
  assert.equal(o.why.length, 2);
});

test('why defaults to an empty array, never undefined', () => {
  assert.deepEqual(buildMachineOrder({ entry: 1, target: 2, riskPoints: 1 }, {}).why, []);
});
