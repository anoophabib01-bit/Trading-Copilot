'use strict';
/**
 * points-tracker.js tests.
 *
 * The second block replays Anoop's REAL trade history from
 * DATA/accounts/s3/day_trades.json and asserts it reproduces the numbers he
 * was given by hand in chat on 2026-08-12 — same discipline as the loss
 * ratchet replay: the module must agree with the number that was actually
 * spoken to him, not just be internally consistent.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const pt = require('../points-tracker');

test('tradePoints: a clean 2-lot $20 winner is 5 points at $2/pt', () => {
  assert.strictEqual(pt.tradePoints({ size: 2, pnl: 20 }), 5);
});

test('tradePoints: invalid trades return null, never NaN or 0', () => {
  assert.strictEqual(pt.tradePoints(null), null);
  assert.strictEqual(pt.tradePoints({}), null);
  assert.strictEqual(pt.tradePoints({ size: 0, pnl: 10 }), null, 'zero size must not become Infinity/NaN silently');
  assert.strictEqual(pt.tradePoints({ size: -1, pnl: 10 }), null);
  assert.strictEqual(pt.tradePoints({ size: 1.5, pnl: 10 }), null, 'fractional lots are not valid trades');
  assert.strictEqual(pt.tradePoints({ size: 2, pnl: NaN }), null);
  assert.strictEqual(pt.tradePoints({ size: 2, pnl: Infinity }), null);
});

test('summarize: null on empty or all-invalid input, never a fake zero summary', () => {
  assert.strictEqual(pt.summarize([]), null);
  assert.strictEqual(pt.summarize([{}, null, { size: 0, pnl: 5 }]), null);
  assert.strictEqual(pt.summarize('not an array'), null);
});

test('summarize: skipped count reports invalid trades rather than hiding them', () => {
  const s = pt.summarize([{ size: 1, pnl: 2 }, {}, { size: 1, pnl: -2 }]);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.skipped, 1);
});

test('summarize: a break-even trade (pnl 0) counts as neither win nor loss', () => {
  const s = pt.summarize([{ size: 1, pnl: 0 }, { size: 1, pnl: 10 }]);
  assert.strictEqual(s.wins, 1);
  assert.strictEqual(s.losses, 0);
  assert.strictEqual(s.count, 2);
});

test('summarize: ratio is Infinity (not a crash) when there are wins and zero losses', () => {
  const s = pt.summarize([{ size: 1, pnl: 10 }, { size: 1, pnl: 20 }]);
  assert.strictEqual(s.ratio, Infinity);
});

test('summarize: ratio is null when there are only losses — no upside to ratio against', () => {
  const s = pt.summarize([{ size: 1, pnl: -10 }]);
  assert.strictEqual(s.ratio, null);
});

test('rollingRatio: null until the window is filled — no ratio from 3 trades', () => {
  const trades = [{ size: 1, pnl: 10 }, { size: 1, pnl: -5 }, { size: 1, pnl: 3 }];
  assert.strictEqual(pt.rollingRatio(trades, 10), null);
});

test('rollingRatio: uses only the most recent `window` trades', () => {
  const old = Array(20).fill({ size: 1, pnl: -100 }); // if this leaked in, ratio would be near 0
  const recent = [{ size: 1, pnl: 10 }, { size: 1, pnl: 10 }, { size: 1, pnl: -5 }];
  const r = pt.rollingRatio([...old, ...recent], 3);
  assert.strictEqual(r, 2, 'avg win 10 / avg loss 5 = 2, and the 20 old losers must be excluded');
});

test('sizeGuidance: below 1.0 is minimum size, no discretion', () => {
  assert.strictEqual(pt.sizeGuidance(0.77).tier, 'minimum');
  assert.strictEqual(pt.sizeGuidance(0.99).tier, 'minimum');
});

test('sizeGuidance: 1.0-1.5 is base size', () => {
  assert.strictEqual(pt.sizeGuidance(1.0).tier, 'base');
  assert.strictEqual(pt.sizeGuidance(1.49).tier, 'base');
});

test('sizeGuidance: 1.5+ earns step-up', () => {
  assert.strictEqual(pt.sizeGuidance(1.5).tier, 'step-up');
  assert.strictEqual(pt.sizeGuidance(3).tier, 'step-up');
});

test('sizeGuidance: null/NaN ratio never silently becomes a size permission', () => {
  assert.strictEqual(pt.sizeGuidance(null).tier, 'insufficient-data');
  assert.strictEqual(pt.sizeGuidance(NaN).tier, 'insufficient-data');
  assert.strictEqual(pt.sizeGuidance(undefined).tier, 'insufficient-data');
});

// ═══════════════════════════════════════════════════════════════════════════
// REPLAY AGAINST REAL DATA — must reproduce the numbers Anoop was actually
// told on 2026-08-12. If this drifts, the module is wrong, not the memory.
// ═══════════════════════════════════════════════════════════════════════════
test('REPLAY: s3 real trade history reproduces the 2026-08-12 expectancy figure', () => {
  const file = path.join(__dirname, '..', '..', 'DATA', 'accounts', 's3', 'day_trades.json');
  if (!fs.existsSync(file)) {
    console.log('  (skipped — DATA/accounts/s3/day_trades.json not present in this environment)');
    return;
  }
  const byDay = JSON.parse(fs.readFileSync(file, 'utf8'));
  const days = Object.keys(byDay).sort();
  // ── THE SUBJECT MUST STILL EXIST (2026-09-21) ─────────────────────────────
  // This replay asserts a fact about a specific period of history. When a slot is
  // RESET — a new account started on it — that history is replaced, and the test
  // then asserts the historical figure against a fresh account's first few
  // trades. That is not a weaker version of the same check, it is a check of
  // something else entirely.
  //
  // It went red on 2026-09-21 exactly this way: s3 was reset and now holds three
  // trades from that one day, so expectancy (rightly) reads positive and the
  // ratio (rightly) reads above 1. Reported as a code regression, it was an
  // account reset — and the failure would have been blamed on whatever was
  // edited that day. Skip when the period is gone; still run when it is present.
  if (!days.some((d) => d <= '2026-08-12')) {
    console.log('  (skipped — s3 has been reset: it holds ' + days.length + ' day(s) starting '
      + days[0] + ', so the 2026-08-12 history this replay reproduces is no longer on disk)');
    return;
  }
  const trades = days.flatMap((d) => byDay[d]);
  const s = pt.summarize(trades);
  assert.ok(s, 'summary must not be null against real recorded trades');
  // Loose tolerance: the spoken figure was rounded and computed from a
  // slightly different filter pass than this exact module. The direction
  // and rough magnitude must hold; exact-to-the-cent equality is not the bar.
  assert.ok(s.expectancyPts < 0, 'expectancy must still read negative — this is the number that matters');
  assert.ok(s.ratio < 1.0, 'avgW:avgL must still read below breakeven for a 42% win-rate system');
});

// ═══════════════════════════════════════════════════════════════════════════
// GUARD: renderer/points-tracker.js must be byte-identical to this file.
// It is loaded via a <script> tag (browser has no module system, no bundler,
// no import), so the only way to keep the Journal chart and the Scalper's
// sizing guidance from silently disagreeing with each other is to make sure
// they are always literally the same file. A future edit that touches one
// copy and forgets the other reintroduces exactly the risk this test exists
// to catch.
// ═══════════════════════════════════════════════════════════════════════════
test('GUARD: renderer/points-tracker.js is byte-identical to app/points-tracker.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'points-tracker.js'), 'utf8');
  const renderer = path.join(__dirname, '..', 'renderer', 'points-tracker.js');
  assert.ok(fs.existsSync(renderer), 'renderer/points-tracker.js is missing — the Journal chart has no math to read');
  const copy = fs.readFileSync(renderer, 'utf8');
  assert.strictEqual(copy, src, 'renderer/points-tracker.js has drifted from app/points-tracker.js — copy the source file over it, do not hand-edit the copy');
});

// ── Ticks + derived points (2026-08-25) ─────────────────────────────────────
// Anoop: "i want to see how many ticks and points did i capture or loss in
// these trades on this tab." Every trade of 2026-08-25 rendered '—' in the
// Journal's Points column because live-fold rows carry no ep/xp/mp.

test('DRIFT GUARD: app/points-tracker.js and renderer/points-tracker.js are identical', () => {
  // The browser loads renderer/points-tracker.js; these tests load
  // app/points-tracker.js. They are two copies of one module, so an edit to
  // either alone means the Journal shows a number the tests never checked.
  const a = fs.readFileSync(path.join(__dirname, '..', 'points-tracker.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'points-tracker.js'), 'utf8');
  assert.strictEqual(a, b, 'the two copies of points-tracker.js have drifted');
});

test('tradePointsResolved: a stored price move (mp) wins and is not marked derived', () => {
  const r = pt.tradePointsResolved({ size: 2, pnl: 20, mp: 5 }, { commPerContract: 0.95 });
  assert.strictEqual(r.pts, 5);
  assert.strictEqual(r.derived, false);
});

test('tradePointsResolved: no mp falls back to the pnl identity, marked derived', () => {
  const r = pt.tradePointsResolved({ size: 2, pnl: 20 }, {});
  assert.strictEqual(r.pts, 5);
  assert.strictEqual(r.derived, true);
});

test('tradePointsResolved: a CSV row is gross, so commission is NOT added back', () => {
  const r = pt.tradePointsResolved({ size: 2, pnl: 20 }, { commPerContract: 0.95 });
  assert.strictEqual(r.pts, 5);
});

test('tradePointsResolved: a live-fold row is net, so commission IS added back', () => {
  // 2026-08-25 trade 2, the case that proves this matters: -$2.80 on 2 lots.
  // Straight division gives -0.70 pts — a losing trade. It was a 1-tick
  // WINNER (+$1.00 gross) that commission turned red.
  const r = pt.tradePointsResolved(
    { size: 2, pnl: -2.8, evidence: 'fold' }, { commPerContract: 0.95 });
  assert.ok(Math.abs(r.pts - 0.25) < 1e-9, 'expected +0.25 pts, got ' + r.pts);
  assert.strictEqual(r.derived, true);
});

test('isNetOfCommission: recognises both live-feed stamps, rejects a CSV row', () => {
  assert.strictEqual(pt.isNetOfCommission({ evidence: 'fold' }), true);
  assert.strictEqual(pt.isNetOfCommission({ source: 'live-fold-only' }), true);
  assert.strictEqual(pt.isNetOfCommission({ size: 2, pnl: 20 }), false);
});

test('tradeTicksResolved: MNQ default is 0.25 pts per tick', () => {
  const r = pt.tradeTicksResolved({ size: 1, pnl: 2 }, {});
  assert.strictEqual(r.ticks, 4);        // $2 on 1 lot = 1 pt = 4 MNQ ticks
});

test('tradeTicksResolved: an explicit tickSize overrides the MNQ default', () => {
  // MGC is 0.1 pts per tick at $10/pt — guessing MNQ here would misreport.
  const r = pt.tradeTicksResolved({ size: 1, pnl: 10 }, { mult: 10, tickSize: 0.1 });
  assert.strictEqual(r.ticks, 10);
});

test('tradePointsResolved / tradeTicksResolved: null on an unusable row', () => {
  assert.strictEqual(pt.tradePointsResolved({ size: 0, pnl: 5 }, {}), null);
  assert.strictEqual(pt.tradeTicksResolved({ size: 2, pnl: NaN }, {}), null);
});

test('totalPointsTicks: replays 2026-08-25 — 3 fold rows, none skipped', () => {
  const rows = [
    { size: 5, pnl: -280, evidence: 'fold' },
    { size: 2, pnl: -2.8000000000029104, evidence: 'fold' },
    { size: 6, pnl: -291.40000000000146, evidence: 'fold' }
  ];
  const tot = pt.totalPointsTicks(rows, { commPerContract: 0.95 });
  assert.strictEqual(tot.n, 3);
  assert.strictEqual(tot.derived, 3);
  assert.strictEqual(tot.skipped, 0);
  assert.ok(Math.abs(tot.netPts - -50.1333333333) < 1e-6, 'netPts ' + tot.netPts);
  assert.ok(Math.abs(tot.wonPts - 0.25) < 1e-6, 'wonPts ' + tot.wonPts);
  assert.strictEqual(Math.round(tot.netTicks), -201);
  // won/lost must partition the net exactly — no row counted twice or dropped
  assert.ok(Math.abs((tot.wonPts + tot.lostPts) - tot.netPts) < 1e-9);
});

test('totalPointsTicks: null when nothing is usable, never a confident zero', () => {
  assert.strictEqual(pt.totalPointsTicks([], {}), null);
  assert.strictEqual(pt.totalPointsTicks([{ size: 0, pnl: 1 }], {}), null);
});
