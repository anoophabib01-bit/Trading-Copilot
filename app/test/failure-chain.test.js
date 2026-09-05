'use strict';
// Tests for failure-chain.js — the causal reconstruction that answers WHY a
// day failed (2026-09-03).
//
// Anoop's complaint this exists for: "the judge always describes the mismatch
// between platforms and not real solution to the problem". The load-bearing
// behaviours, and the tests that pin them:
//   - attribution is MUTUALLY EXCLUSIVE, so the dollars add up to the day
//   - a day of clean losses has NO core reason and must not be given one
//   - the turning point is where size escalated, not the biggest loser
//   - every claim is a measurement, never an inference about intent

const test = require('node:test');
const assert = require('node:assert');
const fc = require('../failure-chain');

// t/x in ms, deliberately spaced so gaps are meaningful.
let clock = 1788400000000;
function T(over) {
  const t = over.t != null ? over.t : (clock += 600000);
  const hold = over.hold != null ? over.hold : 120;
  return Object.assign({ t, x: t + hold * 1000, size: 2, pnl: 0, side: 'LONG', flags: [], hold }, over);
}
const RULES = { sizeCap: 2, cooldownMinutes: 15, dayStop: 1500 };

test('buildChain orders trades and annotates what each inherited', () => {
  clock = 1788400000000;
  const chain = fc.buildChain([
    T({ pnl: 100, size: 2 }),
    T({ pnl: -50, size: 4 }),
    T({ pnl: -30, size: 8 }),
  ]);
  assert.deepStrictEqual(chain.map(s => s.n), [1, 2, 3]);
  assert.deepStrictEqual(chain.map(s => s.runningPnl), [100, 50, 20]);
  assert.strictEqual(chain[0].isPeak, true, 'the day peaked on trade 1');
  assert.strictEqual(chain[1].afterLoss, false, 'trade 2 followed a WINNER');
  assert.strictEqual(chain[2].afterLoss, true, 'trade 3 followed a loss');
  assert.strictEqual(chain[2].sizeChange, 4);
  assert.strictEqual(chain[2].consecLossesAfter, 2);
});

test('buildChain measures the gap from the previous EXIT, not the previous entry', () => {
  // The cooldown starts when the position closes. Measuring entry-to-entry
  // would count the hold itself as cooling off.
  const chain = fc.buildChain([
    { t: 1000000, x: 1000000 + 300000, size: 2, pnl: -10, hold: 300 },   // 5-min hold
    { t: 1000000 + 360000, x: 1000000 + 400000, size: 2, pnl: -10, hold: 40 },
  ]);
  assert.strictEqual(chain[1].gapSec, 60, 'exit at +300s, entry at +360s = 60s gap');
});

test('buildChain sorts out-of-order rows', () => {
  const chain = fc.buildChain([
    { t: 3000, x: 3100, size: 1, pnl: 5 },
    { t: 1000, x: 1100, size: 1, pnl: 10 },
    { t: 2000, x: 2100, size: 1, pnl: -2 },
  ]);
  assert.deepStrictEqual(chain.map(s => s.pnl), [10, -2, 5]);
});

test('the turning point is where SIZE escalated after a loss, not the biggest loser', () => {
  clock = 1788400000000;
  const chain = fc.buildChain([
    T({ pnl: 10, size: 2 }),
    T({ pnl: -500, size: 4 }),    // the loss that changed the day
    T({ pnl: -60, size: 15 }),    // size x3.75 -> this is the escalation
    T({ pnl: -1700, size: 20 }),  // the biggest loser, but downstream
  ]);
  const tp = fc.findTurningPoint(chain);
  assert.strictEqual(tp.kind, 'escalation-after-loss');
  assert.strictEqual(chain[tp.index].n, 2, 'the turning point is trade 2, not trade 4');
  assert.match(tp.why, /4 to 15 contracts/);
});

test('with no escalation, the turning point falls back to peak-then-giveback', () => {
  clock = 1788400000000;
  const chain = fc.buildChain([
    T({ pnl: 300, size: 2 }),
    T({ pnl: -100, size: 2 }),
    T({ pnl: -400, size: 2 }),
  ]);
  const tp = fc.findTurningPoint(chain);
  assert.strictEqual(tp.kind, 'peak-then-giveback');
  assert.strictEqual(chain[tp.index].n, 1);
});

test('attribution is MUTUALLY EXCLUSIVE — the dollars add up to the day', () => {
  clock = 1788400000000;
  const chain = fc.buildChain([
    T({ pnl: -100, size: 8, hold: 5 }),    // over cap AND a 5s reaction
    T({ pnl: -200, size: 20, hold: 300 }), // over cap AND sized up after a loss
  ]);
  const causes = fc.attribute(chain, RULES);
  const total = causes.reduce((s, c) => s + c.damage, 0);
  assert.strictEqual(Math.round(total * 100) / 100, -300, 'every losing dollar is attributed exactly once');
  // No trade appears under two causes.
  const all = causes.flatMap(c => c.trades);
  assert.strictEqual(new Set(all).size, all.length);
});

test('precedence: escalating after a loss outranks the cap breach it chose', () => {
  clock = 1788400000000;
  const chain = fc.buildChain([
    T({ pnl: -50, size: 4 }),
    T({ pnl: -1700, size: 20 }),   // over cap, but the cause is the escalation
  ]);
  const causes = fc.attribute(chain, RULES);
  const escalation = causes.find(c => c.id === 'size-escalation-after-loss');
  assert.ok(escalation, 'escalation claimed it');
  assert.deepStrictEqual(escalation.trades, [2]);
  const overCap = causes.find(c => c.id === 'over-cap');
  assert.ok(!overCap || overCap.trades.indexOf(2) === -1, 'trade 2 is not counted twice');
});

test('a day of clean losses has NO core reason, and must not be given one', () => {
  // The mirror of pattern-memory's `disciplined-loss`. Manufacturing a failure
  // out of a rule-abiding red day teaches that following the rules is also
  // punished.
  // Spaced 30 minutes apart: inside the cap, past the 15-minute cooldown, and
  // held long enough to be decisions. Nothing here is a rule break.
  const d = fc.diagnose([
    { t: 1788400000000, x: 1788400400000, size: 2, pnl: -40, side: 'LONG', hold: 400, flags: [] },
    { t: 1788402200000, x: 1788402700000, size: 2, pnl: -60, side: 'SHORT', hold: 500, flags: [] },
  ], RULES);
  assert.strictEqual(d.primary, null, 'no core reason on a clean day');
  assert.ok(d.cleanLosses, 'the losses are recorded as taken inside the rules');
  assert.match(fc.formatDiagnosis(d), /CORE REASON: none/);
  assert.match(fc.formatDiagnosis(d), /process win/);
});

test('a winning day produces no causes at all', () => {
  clock = 1788400000000;
  const d = fc.diagnose([T({ pnl: 50 }), T({ pnl: 120 })], RULES);
  assert.strictEqual(d.causes.length, 0);
  assert.strictEqual(d.primary, null);
  assert.strictEqual(d.concentration, null);
});

test('concentration finds the one trade that was most of the damage', () => {
  clock = 1788400000000;
  const d = fc.diagnose([
    T({ pnl: -100, size: 2 }),
    T({ pnl: -1700, size: 20, hold: 14 }),
  ], RULES);
  assert.strictEqual(d.concentration.worstTrade, 2);
  assert.strictEqual(d.concentration.worstPnl, -1700);
  assert.strictEqual(d.concentration.share, 94);
  assert.strictEqual(d.concentration.worstHold, 14);
});

test('hold collapse is measured, and needs enough trades to mean anything', () => {
  clock = 1788400000000;
  const collapsed = fc.holdCollapse(fc.buildChain([
    T({ hold: 300, pnl: 1 }), T({ hold: 280, pnl: 1 }),
    T({ hold: 30, pnl: -1 }), T({ hold: 14, pnl: -1 }),
  ]));
  assert.strictEqual(collapsed.collapsed, true);
  assert.strictEqual(collapsed.firstHalfMedian, 290);
  assert.strictEqual(collapsed.secondHalfMedian, 22);

  // Three trades is not a trend.
  assert.strictEqual(fc.holdCollapse(fc.buildChain([T({ hold: 300 }), T({ hold: 20 }), T({ hold: 15 })])), null);
});

test('direction persistence only condemns one-way trading that LOST', () => {
  clock = 1788400000000;
  const lost = fc.directionPersistence(fc.buildChain([
    T({ side: 'LONG', pnl: -100 }), T({ side: 'LONG', pnl: -50 }), T({ side: 'LONG', pnl: -30 }),
  ]));
  assert.strictEqual(lost.persistedIntoLoss, true);
  assert.strictEqual(lost.side, 'LONG');

  // Same one-way conviction, but it worked. Not a failure.
  clock = 1788400000000;
  const won = fc.directionPersistence(fc.buildChain([
    T({ side: 'LONG', pnl: 100 }), T({ side: 'LONG', pnl: 50 }), T({ side: 'LONG', pnl: 30 }),
  ]));
  assert.strictEqual(won.oneWay, true);
  assert.strictEqual(won.persistedIntoLoss, false);
});

test('an empty day diagnoses as empty rather than throwing', () => {
  const d = fc.diagnose([], RULES);
  assert.strictEqual(d.empty, true);
  assert.strictEqual(d.primary, null);
  assert.match(fc.formatDiagnosis(d), /nothing to diagnose/);
  assert.match(fc.formatChain([]), /No trades to sequence/);
});

test('missing timestamps and sizes degrade instead of throwing', () => {
  const d = fc.diagnose([{ pnl: -100 }, { pnl: -50, size: null, hold: null }], RULES);
  assert.strictEqual(d.empty, false);
  assert.strictEqual(d.chain.length, 2);
  assert.strictEqual(d.chain[1].gapSec, null, 'no timestamps means no gap claim');
});

test('caps come from the rules passed in, never hardcoded', () => {
  clock = 1788400000000;
  const trades = [T({ pnl: -100, size: 8, hold: 400 })];
  const strict = fc.diagnose(trades, { sizeCap: 2, cooldownMinutes: 15, dayStop: 1500 });
  assert.strictEqual(strict.primary.id, 'over-cap');
  const loose = fc.diagnose(trades, { sizeCap: 20, cooldownMinutes: 15, dayStop: 1500 });
  assert.strictEqual(loose.primary, null, 'inside a bigger cap it is an ordinary loss');
});

test('REPLAY 2026-09-03: names the real core reason, not the platform mismatch', () => {
  // The exact six live trades. This is the day whose Judge verdict opened with
  // "the app says 6 trades and 47 contracts, the broker says 4 and 41" and
  // never reached a cause.
  const real = [
    { t: 1788422617000, x: 1788422735000, size: 2, pnl: 9.2, side: 'LONG', hold: 118, flags: [] },
    { t: 1788422837000, x: 1788422853000, size: 4, pnl: -1.6, side: 'LONG', hold: 16, flags: ['oversize'] },
    { t: 1788442316021, x: 1788442316021, size: 2, pnl: 1.2, side: 'LONG', hold: 2134, flags: ['hold-exceeded'] },
    { t: 1788442467000, x: 1788442587000, size: 4, pnl: -526.1, side: 'LONG', hold: 120, flags: ['oversize'] },
    { t: 1788443101000, x: 1788443138000, size: 15, pnl: -61, side: 'LONG', hold: 37, flags: ['oversize', 'revenge'] },
    { t: 1788444049000, x: 1788444063000, size: 20, pnl: -1718, side: 'LONG', hold: 14, flags: ['oversize'] },
  ];
  const d = fc.diagnose(real, { sizeCap: 2, cooldownMinutes: 15, dayStop: 1500 });

  assert.strictEqual(d.primary.id, 'size-escalation-after-loss');
  assert.strictEqual(d.primary.damage, -1779);          // trades 5 and 6
  assert.deepStrictEqual(d.primary.trades, [5, 6]);
  assert.strictEqual(Math.abs(d.primary.shareOfLoss), 77);

  // The turning point is trade 4 — the -$526 that preceded the escalation —
  // NOT trade 6, which is merely where the money went.
  assert.strictEqual(d.chain[d.turningPoint.index].n, 4);
  assert.strictEqual(d.turningPoint.kind, 'escalation-after-loss');

  assert.strictEqual(d.concentration.worstTrade, 6);
  assert.strictEqual(d.concentration.share, 74);
  assert.strictEqual(d.holds.collapsed, true);
  assert.strictEqual(d.direction.persistedIntoLoss, true);
  assert.strictEqual(d.direction.side, 'LONG');

  // And the attribution reconciles to the day's real losing total.
  const total = d.causes.reduce((s, c) => s + c.damage, 0);
  assert.strictEqual(Math.round(total * 10) / 10, -2306.7);
});
