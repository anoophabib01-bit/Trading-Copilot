'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { joinFoldToWalk, DEFAULT_TOLERANCE_MS } = require('../trade-record-join.js');

const foldT = (at, size, pnl, extra) => Object.assign({ at, size, pnl, evidence: 'fold', inferred: false, pnlUnknown: false }, extra);
const walkT = (exitAt, size, extra) => Object.assign({
  symbol: 'MNQU6', side: 'buy', size, entryPrice: 21800, exitPrice: 21820,
  entryAt: exitAt - 60000, exitAt, at: exitAt, pnl: 0, pnlUnknown: true, source: 'backfilled-from-orders'
}, extra);

test('exact pair joins into one record carrying both halves', () => {
  const r = joinFoldToWalk([foldT(1000000, 2, 35.5)], [walkT(1005000, 2)]);
  assert.equal(r.merged.length, 1);
  assert.equal(r.unmatchedWalk.length, 0);
  const rec = r.merged[0];
  assert.equal(rec.symbol, 'MNQU6');
  assert.equal(rec.side, 'buy');
  assert.equal(rec.pnl, 35.5);
  assert.equal(rec.entryPrice, 21800);
  assert.equal(rec.exitPrice, 21820);
  assert.equal(rec.source, 'live-fold+order-walk');
  assert.equal(rec.pnlUnknown, false);
  assert.equal(rec.evidence, 'fold');
});

test('size mismatch loses to size-equal even when further in time', () => {
  const folds = [foldT(1000000, 3, -10)];
  const walks = [
    walkT(1010000, 5, { side: 'sell' }),   // closer in time, wrong size
    walkT(1150000, 3, { side: 'sell' }),   // 2.5 min away, right size — still within tolerance
  ];
  const r = joinFoldToWalk(folds, walks);
  assert.equal(r.merged.length, 1);
  assert.equal(r.merged[0].side, 'sell');
  assert.equal(r.merged[0].size, 3);
  assert.equal(r.unmatchedWalk.length, 1); // the size-5 close stays as order-walk-only
});

test('walk close outside tolerance stays a separate order-walk-only record', () => {
  const r = joinFoldToWalk([foldT(1000000, 2, 10)], [walkT(20000000, 2)]);
  assert.equal(r.merged.length, 0);
  assert.equal(r.unmatchedWalk.length, 1);
  assert.equal(r.records.length, 2);
  assert.equal(r.records.find(x => x.source === 'order-walk-only').pnlUnknown, true);
});

test('degraded provenance survives the join', () => {
  const r = joinFoldToWalk([foldT(1000000, 0, -44.65, { evidence: 'degraded', inferred: true, size: 0 })], [walkT(1005000, 0)]);
  const rec = r.merged[0];
  assert.equal(rec.evidence, 'degraded');
  assert.equal(rec.inferred, true);
});

test('records are sorted by close time across both sources', () => {
  const folds = [foldT(3000000, 1, 5), foldT(1000000, 1, 4)];
  const walks = [walkT(20000000, 1, { symbol: 'MGCQ6' })];
  const r = joinFoldToWalk(folds, walks);
  const times = r.records.map(x => x.at || x.exitAt);
  assert.deepEqual(times, [1000000, 3000000, 20000000]);
});

test('empty inputs are safe', () => {
  assert.deepEqual(joinFoldToWalk(null, null).records, []);
  assert.deepEqual(joinFoldToWalk([], []).records, []);
});

test('default tolerance is 3 minutes', () => {
  assert.equal(DEFAULT_TOLERANCE_MS, 3 * 60 * 1000);
});

// ── Cross-poll caller contract (audit, 2026-08-22) ──────────────────────────
// analyzeOrderWalk() re-derives walk.closed from ALL of today's orders on
// EVERY poll — it is cumulative for the day. newTrades (the fold side) is
// only the delta since the last poll. server.js's pollTVBrokerAccountInner
// MUST slice walk.closed to the same delta window (via
// closedRoundTripsScored, captured before fold() runs) before calling
// joinFoldToWalk — passing the full cumulative walk.closed against a small
// delta re-surfaces every already-joined earlier close as a fresh
// order-walk-only record, which server.js then re-writes to the session log
// and re-broadcasts to chat, compounding on every later close of the day.
// This module has no way to enforce that at its own boundary (it correctly
// joins whatever two arrays it's given) — this test pins the CONTRACT so a
// future caller-side regression is caught here, not live.
test('CONTRACT: caller must slice walk.closed to the delta, or old closes duplicate as order-walk-only', () => {
  // Poll 1: one round trip closes.
  const walk1 = [walkT(5000, 2)];
  const fold1 = [foldT(5200, 2, 35.5)];
  const p1 = joinFoldToWalk(fold1, walk1);
  assert.equal(p1.records.length, 1);
  assert.equal(p1.unmatchedWalk.length, 0);

  // Poll 2: a second round trip closes. walk.closed is CUMULATIVE (as
  // analyzeOrderWalk always returns it) — both trips. newTrades is only
  // the new one, matching what pollTVBrokerAccountInner actually passes.
  const walk2 = walk1.concat([walkT(12000, 1, { side: 'sell' })]);
  const fold2 = [foldT(12200, 1, -20)];

  // WRONG (what shipped in the 4.1 commit before this audit): pass the full
  // cumulative walk.closed. The first trip re-appears as unmatched.
  const wrong = joinFoldToWalk(fold2, walk2);
  assert.equal(wrong.unmatchedWalk.length, 1, 'documents the bug this pins against — remove if joinFoldToWalk itself changes its matching contract');

  // RIGHT (the fix): the caller slices walk.closed by how many entries were
  // already accounted for as of the previous poll (walk1.length here,
  // standing in for closedRoundTripsScored captured before fold()).
  const alreadyJoined = walk1.length;
  const right = joinFoldToWalk(fold2, walk2.slice(alreadyJoined));
  assert.equal(right.records.length, 1);
  assert.equal(right.unmatchedWalk.length, 0, 'no stale close should re-appear once the caller slices to the delta');
  assert.equal(right.merged[0].pnl, -20);
});
