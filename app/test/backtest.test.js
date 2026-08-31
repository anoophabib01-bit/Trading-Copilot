'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { simulateTrade, score, htfBarsAsOf, runPlaybookB } = require('../backtest.js');

const bar = (t, h, l, c) => ({ time: t, open: c, high: h, low: l, close: c });
const RULES = {
  playbooks: { stopBufferPoints: 3, targetR: 2, fvgFillWindowBars: 8, sfpToFvgMaxBars: 3, outcomeHorizonBars: 12, minRiskPoints: 8 },
  perTradeMaxLoss: 300, sizeCap: 2, commissionPerContractPerSide: 0.95,
  eval: { profitTarget: 3000, maxDrawdown: 2000 },
};

const marketPlan = { direction: 'BULLISH', entry: 100, stop: 90, target: 120, riskPoints: 10, requiresFill: false, fillWindowBars: 0 };
const limitPlan = { ...marketPlan, requiresFill: true, fillWindowBars: 4 };

// ── The look-ahead bug this harness shipped with, now pinned ────────────────
test('a limit entry NEVER fills on the signal bar itself', () => {
  // The signal bar's range covers the entry price. If the fill scan included
  // it, this would fill at offset 0 — which is the bug that reported Playbook
  // B at a 73% win rate on prices that could not have been traded.
  const bars = [bar(0, 105, 95, 104)];                 // signal bar spans the entry
  for (let i = 1; i <= 20; i++) bars.push(bar(i, 130, 125, 128)); // never returns to 100
  const r = simulateTrade(limitPlan, bars, 0, { horizonBars: 12, slippagePoints: 0 });
  assert.equal(r.outcome, 'nofill');
  assert.equal(r.filled, false);
});

test('a limit entry DOES fill on a later bar that trades through it', () => {
  const bars = [bar(0, 105, 102, 104), bar(1, 103, 99, 101)];
  for (let i = 2; i <= 20; i++) bars.push(bar(i, 125, 118, 124));
  const r = simulateTrade(limitPlan, bars, 0, { horizonBars: 12, slippagePoints: 0 });
  assert.equal(r.filled, true);
  assert.equal(r.entryIdx, 1);
});

test('an unfilled setup scores ZERO points — never a win, never a loss', () => {
  const bars = [bar(0, 105, 95, 104)];
  for (let i = 1; i <= 20; i++) bars.push(bar(i, 130, 125, 128));
  const r = simulateTrade(limitPlan, bars, 0, { horizonBars: 12, slippagePoints: 0 });
  assert.equal(r.points, 0);
  const sc = score([r], RULES, {});
  assert.equal(sc.filled, 0);
  assert.equal(sc.noFill, 1);
  assert.equal(sc.netUsd, 0);          // it must not touch P&L at all
});

// ── Pessimistic resolution ──────────────────────────────────────────────────
test('a bar spanning BOTH stop and target resolves as the STOP', () => {
  const bars = [bar(0, 101, 99, 100), bar(1, 125, 85, 110)];
  for (let i = 2; i <= 20; i++) bars.push(bar(i, 101, 99, 100));
  const r = simulateTrade(marketPlan, bars, 0, { horizonBars: 12, slippagePoints: 0 });
  assert.equal(r.outcome, 'stop');
});

test('slippage is charged on both sides, making a winner smaller and a loser bigger', () => {
  const win = [bar(0, 101, 99, 100)];
  for (let i = 1; i <= 20; i++) win.push(bar(i, 121, 119, 120));
  const clean = simulateTrade(marketPlan, win, 0, { horizonBars: 12, slippagePoints: 0 });
  const slipped = simulateTrade(marketPlan, win, 0, { horizonBars: 12, slippagePoints: 0.5 });
  assert.equal(clean.points, 20);
  assert.equal(slipped.points, 19);    // 20 - 2*0.5
});

test('an unresolved horizon returns null and is EXCLUDED, not scratched', () => {
  const bars = [bar(0, 101, 99, 100), bar(1, 101, 99, 100)];
  assert.equal(simulateTrade(marketPlan, bars, 0, { horizonBars: 12 }), null);
});

test('neither level touched inside the horizon closes at the horizon bar', () => {
  const bars = [bar(0, 101, 99, 100)];
  for (let i = 1; i <= 20; i++) bars.push(bar(i, 106, 104, 105));
  const r = simulateTrade(marketPlan, bars, 0, { horizonBars: 12, slippagePoints: 0 });
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.points, 5);
});

// ── No look-ahead across timeframes ─────────────────────────────────────────
test('htfBarsAsOf excludes an HTF bar that had not yet closed', () => {
  const htf = [{ time: 0 }, { time: 3600 }, { time: 7200 }];
  // at t=7200 the 4H bar opened at 7200 is still running; the one at 3600 is
  // only closed if 3600 + 14400 <= 7200, which it is not
  const asOf = htfBarsAsOf(htf, 7200, 14400);
  assert.deepEqual(asOf.map((b) => b.time), []);
  const later = htfBarsAsOf(htf, 25000, 14400);
  assert.deepEqual(later.map((b) => b.time), [0, 3600, 7200]);
});

test('an HTF bar closing exactly at the signal instant IS visible', () => {
  assert.equal(htfBarsAsOf([{ time: 0 }], 14400, 14400).length, 1);
});

// ── Risk gating against Anoop's own rules ───────────────────────────────────
test('a setup risking more than perTradeMaxLoss is blocked, not traded', () => {
  // 200pt stop at 2 contracts x $2 = $800, over the $300 limit
  const bars = [];
  for (let i = 0; i < 200; i++) bars.push(bar(i * 1800, 100 + i, 90 + i, 95 + i));
  const r = runPlaybookB(bars, RULES, { contracts: 2 });
  for (const b of r.blocked) assert.ok(['risk-too-small', 'risk-too-big'].includes(b.code));
  // and nothing blocked ever appears in trades
  const blockedTimes = new Set(r.blocked.map((b) => b.time));
  for (const t of r.trades) assert.equal(blockedTimes.has(t.time), false);
});

// ── Scoring ─────────────────────────────────────────────────────────────────
test('net P&L subtracts real commission on both sides at size', () => {
  const t = { filled: true, points: 10, outcome: 'target', time: 0 };
  const sc = score([t], RULES, { contracts: 2 });
  // 10pt * $2 * 2 = $40 gross, minus 0.95 * 2 sides * 2 contracts = $3.80
  assert.equal(sc.netUsd, 36.2);
});

test('drawdown tracks the worst peak-to-trough of the equity path, not the worst trade', () => {
  const mk = (pts) => ({ filled: true, points: pts, outcome: pts > 0 ? 'target' : 'stop', time: 0 });
  const sc = score([mk(50), mk(-20), mk(-20), mk(40)], RULES, { contracts: 1 });
  // peak after trade 1 = 100 - 1.9 = 98.1; trough after trade 3
  assert.ok(sc.maxDrawdownUsd > 80 && sc.maxDrawdownUsd < 90, `unexpected DD ${sc.maxDrawdownUsd}`);
});

test('eval is NOT projected from a thin or negative sample (TRUST-PROTOCOL Rule 1)', () => {
  const few = [{ filled: true, points: 10, outcome: 'target', time: 0 }];
  assert.equal(score(few, RULES, {}).evalProjection, null);

  const losing = Array.from({ length: 15 }, () => ({ filled: true, points: -5, outcome: 'stop', time: 0 }));
  assert.equal(score(losing, RULES, {}).evalProjection, null);

  const good = Array.from({ length: 15 }, () => ({ filled: true, points: 10, outcome: 'target', time: 0 }));
  assert.ok(score(good, RULES, {}).evalProjection, 'a real sample with positive expectancy should project');
});

test('frequency is reported even on a sample too thin to score expectancy', () => {
  // The point of frequency: it needs far less data to be believable, and it
  // is what decides whether a target is reachable at all.
  const two = [{ filled: true, points: 5, outcome: 'target', time: 0 }, { filled: true, points: -5, outcome: 'stop', time: 0 }];
  const sc = score(two, RULES, { spanDays: 10 });
  assert.equal(sc.evalProjection, null);
  assert.equal(sc.frequency.tradeableSetupsPerDay, 0.2);
  assert.ok(sc.frequency.requiredExpectancyFor30Days > 0);
});

test('an empty result set scores cleanly instead of dividing by zero', () => {
  const sc = score([], RULES, { spanDays: 5 });
  assert.equal(sc.filled, 0);
  assert.equal(sc.winRate, null);
  assert.equal(sc.expectancyUsd, null);
  assert.equal(sc.netUsd, 0);
});

// ── Overnight flatten (Anoop's 3 AM IST rule) ───────────────────────────────
const { nextFlattenSec } = require('../backtest.js');
const IST = 5.5 * 3600;
const istHour = (sec) => new Date((sec + IST) * 1000).getUTCHours();

test('nextFlattenSec always lands on 03:00 IST', () => {
  for (const t of [0, 1787000000, 1787040000, 1787123456]) {
    assert.equal(istHour(nextFlattenSec(t, 180)), 3);
  }
});

test('a trade entered just before the cutoff gets minutes; just after gets a full day', () => {
  const cutoff = nextFlattenSec(1787000000, 180);
  const justBefore = nextFlattenSec(cutoff - 600, 180);
  const justAfter = nextFlattenSec(cutoff + 600, 180);
  assert.equal(justBefore, cutoff, 'still today’s cutoff');
  assert.equal(justAfter - cutoff, 86400, 'rolls to tomorrow’s');
});

test('a position open at 03:00 IST is FLATTENED, not allowed to run to target', () => {
  const cutoff = nextFlattenSec(1787000000, 180);
  const start = cutoff - 3 * 1800;                       // 3 bars before the cutoff
  const bars = [{ time: start, open: 100, high: 101, low: 99, close: 100 }];
  for (let i = 1; i <= 20; i++) {
    // price runs to target AFTER the cutoff — must not be credited
    const hi = i >= 3 ? 200 : 101;
    bars.push({ time: start + i * 1800, open: 100, high: hi, low: 99, close: 100 });
  }
  const r = simulateTrade(marketPlan, bars, 0, { horizonBars: 12, slippagePoints: 0, flattenByISTMinutes: 180 });
  assert.equal(r.outcome, 'flattened');
  assert.equal(r.points, 0, 'closed at the last pre-cutoff close, not at the post-cutoff spike');
});

test('with no flatten configured the same trade reaches its target — the rule is what changes it', () => {
  const cutoff = nextFlattenSec(1787000000, 180);
  const start = cutoff - 3 * 1800;
  const bars = [{ time: start, open: 100, high: 101, low: 99, close: 100 }];
  for (let i = 1; i <= 20; i++) bars.push({ time: start + i * 1800, open: 100, high: i >= 3 ? 200 : 101, low: 99, close: 100 });
  const r = simulateTrade(marketPlan, bars, 0, { horizonBars: 12, slippagePoints: 0 });
  assert.equal(r.outcome, 'target');
});

test('a limit entry that would only fill after the cutoff never opens', () => {
  const cutoff = nextFlattenSec(1787000000, 180);
  const start = cutoff - 2 * 1800;
  const bars = [{ time: start, open: 104, high: 105, low: 102, close: 104 }];
  for (let i = 1; i <= 20; i++) {
    const touches = i >= 2;                              // only trades to 100 after the cutoff
    bars.push({ time: start + i * 1800, open: 104, high: 105, low: touches ? 99 : 102, close: 104 });
  }
  const r = simulateTrade(limitPlan, bars, 0, { horizonBars: 12, slippagePoints: 0, flattenByISTMinutes: 180 });
  assert.equal(r.outcome, 'nofill');
});
