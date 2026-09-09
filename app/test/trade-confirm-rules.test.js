'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkTradeAllowed } = require('../trade-confirm-rules.js');

const RULES = { sizeCap: 2, sizeFloor: 2, tradesPerDay: 5, dailyLossCap: 200, dayStop: { eval: 1500, funded: 200 } };

test('rejects an invalid/non-positive size', () => {
  assert.equal(checkTradeAllowed(RULES, 'funded', [], 0).allowed, false);
  assert.equal(checkTradeAllowed(RULES, 'funded', [], -1).allowed, false);
  assert.equal(checkTradeAllowed(RULES, 'funded', [], NaN).allowed, false);
});

test('rejects a size above sizeCap', () => {
  const r = checkTradeAllowed(RULES, 'funded', [], 3);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /exceeds sizeCap/);
});

test('rejects a size below sizeFloor', () => {
  const r = checkTradeAllowed(RULES, 'funded', [], 1);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /sizeFloor/);
});

test('allows a size within cap/floor with no other violations', () => {
  const r = checkTradeAllowed(RULES, 'funded', [], 2);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, null);
});

// ── G9: stop-distance risk on the live order path ──────────────────────────
test('G9: a 400-pt stop at 2 contracts is refused (over per-trade cap)', () => {
  const r = checkTradeAllowed(RULES, 'funded', [], 2, null, {
    side: 'buy', stopPrice: 100, lastPrice: 500, pointValue: 2, riskCapUsd: 300,
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /risks \$1600/);
  assert.match(r.reason, /over the \$300/);
});

test('G9: a buy stop on the wrong side (at/above entry) is refused', () => {
  const r = checkTradeAllowed(RULES, 'funded', [], 2, null, {
    side: 'buy', stopPrice: 500, lastPrice: 400, pointValue: 2, riskCapUsd: 300,
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /wrong side/);
});

test('G9: a stopless ticket is refused', () => {
  const r = checkTradeAllowed(RULES, 'funded', [], 2, null, {
    side: 'buy', stopPrice: null, lastPrice: 400, pointValue: 2, riskCapUsd: 300,
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /no stop supplied/);
});

test('G9: an in-cap, right-side stop is allowed', () => {
  const r = checkTradeAllowed(RULES, 'funded', [], 2, null, {
    side: 'buy', stopPrice: 390, lastPrice: 400, pointValue: 2, riskCapUsd: 300,
  });
  // 10pt * $2 * 2 = $40 risk
  assert.equal(r.allowed, true);
});

test('rejects once tradesPerDay is already hit', () => {
  const trades = Array.from({ length: 5 }, () => ({ size: 2, pnl: 50 }));
  const r = checkTradeAllowed(RULES, 'funded', trades, 2);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /already 5 trades/);
});

test('rejects once day P&L is at/past dailyLossCap (funded)', () => {
  const trades = [{ size: 2, pnl: -200 }];
  const r = checkTradeAllowed(RULES, 'funded', trades, 2);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /day-stop/);
});

test('falls back to dayStop[stage] when dailyLossCap is absent', () => {
  const rulesNoCap = { sizeCap: 2, sizeFloor: 2, tradesPerDay: 5, dayStop: { eval: 1500, funded: 200 } };
  const trades = [{ size: 2, pnl: -200 }];
  const r = checkTradeAllowed(rulesNoCap, 'funded', trades, 2);
  assert.equal(r.allowed, false);
  const rEval = checkTradeAllowed(rulesNoCap, 'eval', trades, 2);
  assert.equal(rEval.allowed, true); // -200 doesn't breach eval's -1500
});

test('rejects a size-up immediately after a loss', () => {
  const trades = [{ size: 2, pnl: -50 }];
  const r = checkTradeAllowed({ sizeCap: 4, sizeFloor: 1, tradesPerDay: 5, dailyLossCap: 1500 }, 'funded', trades, 3);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /size-up after a loss/);
});

test('allows the same size after a loss (not a size-up)', () => {
  const trades = [{ size: 2, pnl: -50 }];
  const r = checkTradeAllowed(RULES, 'funded', trades, 2);
  assert.equal(r.allowed, true);
});

test('a clean day at exactly sizeCap and under every other limit is allowed', () => {
  const trades = [{ size: 2, pnl: 60 }, { size: 2, pnl: -30 }];
  const r = checkTradeAllowed(RULES, 'funded', trades, 2);
  assert.equal(r.allowed, true);
});

test('missing/garbage rules object does not throw and fails safe (no cap = infinite, still checks size-freeze)', () => {
  assert.doesNotThrow(() => checkTradeAllowed(null, 'funded', [], 2));
  assert.doesNotThrow(() => checkTradeAllowed({}, 'funded', undefined, 2));
});

// ── D1/D2 (2026-08-21): a count built on degraded evidence is advisory ─────
// The "9/3 TRADES — DONE" lockout was a derived number with unilateral
// authority to end a live session. Two independent derivations now exist, so
// a count that rests partly on the fill-edge fallback no longer hard-blocks.
test('the trades-per-day cap still HARD-blocks when every trade is verified', () => {
  const rules = { sizeCap: 4, sizeFloor: 1, tradesPerDay: 3 };
  const trades = [{ size: 2, pnl: 10 }, { size: 2, pnl: 10 }, { size: 2, pnl: 10 }];
  const r = checkTradeAllowed(rules, 'eval', trades, 2);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /already 3 trades today/);
});

test('the cap DOWNGRADES to advisory when any trade was scored on a degraded feed', () => {
  const rules = { sizeCap: 4, sizeFloor: 1, tradesPerDay: 3 };
  const trades = [{ size: 2, pnl: 10 }, { size: 0, pnl: 5, evidence: 'degraded' }, { size: 2, pnl: 10 }];
  const r = checkTradeAllowed(rules, 'eval', trades, 2);
  assert.equal(r.allowed, true, 'must not end a live session on a number we cannot stand behind');
  assert.equal(r.advisory, true);
  assert.match(r.warning, /degraded feed/);
  assert.match(r.warning, /3\/3/);
});

test('dayStop still HARD-blocks even when the count is degraded — it reads balance, not the count', () => {
  const rules = { sizeCap: 4, sizeFloor: 1, tradesPerDay: 10, dailyLossCap: 300 };
  const trades = [{ size: 2, pnl: -200, evidence: 'degraded' }, { size: 2, pnl: -150 }];
  const r = checkTradeAllowed(rules, 'eval', trades, 2);
  assert.equal(r.allowed, false, 'the money rule is directly observed and keeps its teeth');
  assert.match(r.reason, /day-stop/);
});

test('the size cap still HARD-blocks when the count is degraded', () => {
  const rules = { sizeCap: 2, sizeFloor: 1, tradesPerDay: 10 };
  const r = checkTradeAllowed(rules, 'eval', [{ size: 2, pnl: 5, evidence: 'degraded' }], 6);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /exceeds sizeCap/);
});
