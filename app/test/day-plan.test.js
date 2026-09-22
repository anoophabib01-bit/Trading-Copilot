'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dp = require('../day-plan');

// ── consecutiveLosses ──────────────────────────────────────────────────────
test('counts the losing run at the end of the day', () => {
  const t = [{ pnl: 100, at: 1 }, { pnl: -50, at: 2 }, { pnl: -60, at: 3 }, { pnl: -70, at: 4 }];
  assert.equal(dp.consecutiveLosses(t), 3);
});

test('a win ends the streak', () => {
  const t = [{ pnl: -50, at: 1 }, { pnl: -60, at: 2 }, { pnl: 20, at: 3 }];
  assert.equal(dp.consecutiveLosses(t), 0);
});

test('a scratch ends the streak but is not itself a loss', () => {
  // pnl 0 is neither: the run stops there rather than counting him as losing.
  const t = [{ pnl: -50, at: 1 }, { pnl: -60, at: 2 }, { pnl: 0, at: 3 }];
  assert.equal(dp.consecutiveLosses(t), 0);
});

test('orders by close time, and tolerates an unsorted array', () => {
  const t = [{ pnl: -70, at: 4 }, { pnl: -50, at: 2 }, { pnl: -60, at: 3 }];
  assert.equal(dp.consecutiveLosses(t), 3);
  const byOpen = [{ pnl: -50, t: 10 }, { pnl: -60, t: 20 }];
  assert.equal(dp.consecutiveLosses(byOpen), 2);
});

test('ignores rows with no usable pnl rather than counting them', () => {
  const t = [{ pnl: -50, at: 1 }, { pnl: null, at: 2 }, { pnl: 'abc', at: 3 }];
  assert.equal(dp.consecutiveLosses(t), 1);
  assert.equal(dp.consecutiveLosses(null), 0);
});

// ── satisfactionStatus ─────────────────────────────────────────────────────
test('satisfaction is reached at or above the target, and says what to do', () => {
  const s = dp.satisfactionStatus({ cfg: { enabled: true, amountUsd: 300 }, dayPnl: 300 });
  assert.equal(s.reached, true);
  assert.equal(s.pct, 100);
  assert.match(s.text, /SATISFACTION NUMBER HIT/);
  assert.match(s.text, /\$300/);
  assert.match(s.text, /leave the desk/);
});

test('satisfaction below target reports the distance, not a verdict', () => {
  const s = dp.satisfactionStatus({ cfg: { enabled: true, amountUsd: 300 }, dayPnl: 120 });
  assert.equal(s.reached, false);
  assert.equal(s.pct, 40);
  assert.equal(s.remaining, 180);
  assert.match(s.text, /\$180 to go/);
});

test('a losing day never reads as a satisfaction day', () => {
  const s = dp.satisfactionStatus({ cfg: { enabled: true, amountUsd: 300 }, dayPnl: -40 });
  assert.equal(s.reached, false);
  assert.equal(s.pct, 0);
});

test('a red day gets no satisfaction sentence at all', () => {
  // "$580 to go" on a losing day frames it as a shortfall against a profit
  // goal — exactly the pressure this number exists to remove.
  assert.equal(dp.satisfactionStatus({ cfg: { enabled: true, amountUsd: 300 }, dayPnl: -280 }).text, '');
  assert.notEqual(dp.satisfactionStatus({ cfg: { enabled: true, amountUsd: 300 }, dayPnl: 0 }).text, '');
});

test('satisfaction is silent when disabled or unconfigured', () => {
  assert.equal(dp.satisfactionStatus({ cfg: { enabled: false, amountUsd: 300 }, dayPnl: 500 }).text, '');
  assert.equal(dp.satisfactionStatus({ cfg: { enabled: true }, dayPnl: 500 }).enabled, false);
  assert.equal(dp.satisfactionStatus({ cfg: { enabled: true, amountUsd: 300 } }).text, '');
});

// ── evalPlan ───────────────────────────────────────────────────────────────
test('eval chunk is the live distance to target divided by the plan days, in whole dollars', () => {
  const p = dp.evalPlan({ cfg: { enabled: true, days: 4 }, balance: 51400, targetBalance: 53000 });
  assert.equal(p.remaining, 1600);
  assert.equal(p.chunk, 400);
  // 1790 / 4 = 447.5 — a plan number, not a quota, so it rounds to the dollar.
  assert.equal(dp.evalPlan({ cfg: { enabled: true, days: 4 }, balance: 51210, targetBalance: 53000 }).chunk, 448);
  assert.match(p.text, /\$400 a day/);
});

test('eval pace compares today against the chunk', () => {
  const short = dp.evalPlan({ cfg: { enabled: true, days: 4 }, balance: 51500, targetBalance: 53000, todayPnl: 100 });
  assert.match(short.text, /short of today's chunk/);
  const made = dp.evalPlan({ cfg: { enabled: true, days: 4 }, balance: 51500, targetBalance: 53000, todayPnl: 380 });
  assert.match(made.text, /already made/);
});

test('the pace line stops prodding once the day is already won', () => {
  const block = dp.todayPlanBlock({
    satisfaction: { enabled: true, amountUsd: 300 },
    evalPlanCfg: { enabled: true, days: 4 },
    dayPnl: 340, balance: 51340, targetBalance: 53000,
  });
  assert.match(block, /SATISFACTION NUMBER HIT/);
  assert.doesNotMatch(block, /short of today's chunk/);
});

test('a reached target says so instead of printing a zero chunk', () => {
  const p = dp.evalPlan({ cfg: { enabled: true, days: 4 }, balance: 53000, targetBalance: 53000 });
  assert.equal(p.reached, true);
  assert.equal(p.chunk, 0);
  assert.match(p.text, /EVAL TARGET REACHED/);
});

test('eval plan refuses to compute without a balance, a target or days', () => {
  assert.equal(dp.evalPlan({ cfg: { enabled: true, days: 4 }, balance: null, targetBalance: 53000 }).enabled, false);
  assert.equal(dp.evalPlan({ cfg: { enabled: true, days: 4 }, balance: 51000 }).enabled, false);
  assert.equal(dp.evalPlan({ cfg: { enabled: true, days: 0 }, balance: 51000, targetBalance: 53000 }).enabled, false);
  assert.equal(dp.evalPlan({ cfg: { enabled: false, days: 4 }, balance: 51000, targetBalance: 53000 }).enabled, false);
});

// ── streakGate ─────────────────────────────────────────────────────────────
test('the gate stays silent below the threshold', () => {
  const g = dp.streakGate({
    cfg: { enabled: true, afterLosses: 4 },
    trades: [{ pnl: -10, at: 1 }, { pnl: -10, at: 2 }, { pnl: -10, at: 3 }],
    perTradeStopUsd: 200, dailyLossLimit: 1000, drawdownLimit: 2000, dayPnl: -30,
  });
  assert.equal(g.matched, false);
  assert.equal(g.text, '');
});

test('the gate states the remaining room in STOPS, not just dollars', () => {
  const g = dp.streakGate({
    cfg: { enabled: true, afterLosses: 4 },
    trades: [{ pnl: -100, at: 1 }, { pnl: -80, at: 2 }, { pnl: -60, at: 3 }, { pnl: -40, at: 4 }],
    perTradeStopUsd: 200, dailyLossLimit: 1000, drawdownLimit: 2000, dayPnl: -280,
  });
  assert.equal(g.matched, true);
  assert.equal(g.losses, 4);
  assert.equal(g.roomToDll, 720);
  assert.equal(g.stopsToDll, 3);            // 720 / 200
  assert.match(g.text, /3 full \$200 stops/);
  assert.match(g.text, /5-6 days, never one/);
});

test('the gate clamps room at the limit rather than reporting more than exists', () => {
  const g = dp.streakGate({
    cfg: { enabled: true, afterLosses: 4 },
    trades: [{ pnl: -10, at: 1 }, { pnl: -10, at: 2 }, { pnl: -10, at: 3 }, { pnl: -10, at: 4 }],
    perTradeStopUsd: 200, dailyLossLimit: 1000, drawdownLimit: 2000, dayPnl: 500,
  });
  assert.equal(g.roomToDll, 1000);          // a green day cannot exceed the limit
  assert.equal(g.stopsToDll, 5);
});

test('the gate falls back to drawdown stops when no daily limit is configured', () => {
  const g = dp.streakGate({
    cfg: { enabled: true, afterLosses: 4 },
    trades: [{ pnl: -1, at: 1 }, { pnl: -1, at: 2 }, { pnl: -1, at: 3 }, { pnl: -1, at: 4 }],
    perTradeStopUsd: 200, drawdownLimit: 2000, dayPnl: -4,
  });
  assert.equal(g.stopsToDrawdown, 10);
  assert.match(g.text, /10 stops in total/);
});

test('the gate admits when it cannot measure the room instead of implying safety', () => {
  const g = dp.streakGate({
    cfg: { enabled: true, afterLosses: 4 },
    trades: [{ pnl: -1, at: 1 }, { pnl: -1, at: 2 }, { pnl: -1, at: 3 }, { pnl: -1, at: 4 }],
    dayPnl: -4,
  });
  assert.equal(g.matched, true);
  assert.match(g.text, /unknown, not as room/);
});

test('the gate honours a custom threshold and can be disabled', () => {
  const two = dp.streakGate({ cfg: { enabled: true, afterLosses: 2 }, trades: [{ pnl: -1, at: 1 }, { pnl: -1, at: 2 }], dayPnl: -2 });
  assert.equal(two.matched, true);
  assert.equal(two.afterLosses, 2);
  assert.equal(dp.streakGate({ cfg: { enabled: false }, trades: [{ pnl: -1, at: 1 }] }).matched, false);
});

// ── resolveTarget ─────────────────────────────────────────────────────────
test('resolveTarget prefers a live eval target over the profile fallback', () => {
  const live = dp.resolveTarget({ mode: 'eval', liveTarget: 53250, startBalance: 50000, profitTarget: 3000 });
  assert.equal(live, 53250);
});

test('resolveTarget falls back to start + profit when the live eval target is missing', () => {
  // The 2026-09-21 bug: on a Tradovate 50K account acc.evalTarget is null, so
  // the left card showed $53,000 while the Day Plan rendered "—" and Coach's
  // Notes would have said $159,000. This is the single definition that ends it.
  const t = dp.resolveTarget({ mode: 'eval', liveTarget: null, startBalance: 50000, profitTarget: 3000 });
  assert.equal(t, 53000);
  assert.equal(dp.resolveTarget({ mode: 'eval', liveTarget: 0, startBalance: 50000, profitTarget: 3000 }), 53000);
  assert.equal(dp.resolveTarget({ mode: 'eval', liveTarget: undefined, startBalance: 50000, profitTarget: 3000 }), 53000);
});

test('resolveTarget returns null when nothing eval is known, never a hardcoded 150K', () => {
  assert.equal(dp.resolveTarget({ mode: 'eval', liveTarget: null, startBalance: null, profitTarget: null }), null);
  assert.equal(dp.resolveTarget({ mode: 'eval' }), null);
});

test('resolveTarget resolves the funded target through its own precedence', () => {
  assert.equal(dp.resolveTarget({ mode: 'funded', liveTarget: 51800, startBalance: 50000, payoutProfileTarget: 52000 }), 51800);
  assert.equal(dp.resolveTarget({ mode: 'funded', liveTarget: null, startBalance: 50000, payoutProfileTarget: 52000 }), 52000);
  assert.equal(dp.resolveTarget({ mode: 'funded', liveTarget: null, startBalance: 50000, payoutProfileTarget: null }), 53000); // start + 3000
  assert.equal(dp.resolveTarget({ mode: 'funded' }), null);
});

// ── todayPlanBlock ─────────────────────────────────────────────────────────
test('the combined block carries the voices that apply to a red day', () => {
  const block = dp.todayPlanBlock({
    satisfaction: { enabled: true, amountUsd: 300 },
    evalPlanCfg: { enabled: true, days: 4 },
    streakCfg: { enabled: true, afterLosses: 4 },
    dayPnl: -300, balance: 51400, targetBalance: 53000,
    trades: [{ pnl: -100, at: 1 }, { pnl: -80, at: 2 }, { pnl: -60, at: 3 }, { pnl: -60, at: 4 }],
    perTradeStopUsd: 200, dailyLossLimit: 1000, drawdownLimit: 2000,
  });
  assert.match(block, /^TODAY'S PLAN — /);
  assert.match(block, /EVAL PACE/);
  assert.match(block, /STREAK GATE/);
  // dayPnl is -300: a red day carries NO satisfaction sentence. Framing a
  // losing day as a shortfall against a profit goal is the pressure the number
  // exists to remove — the streak gate and the loss tiers own this state.
  assert.doesNotMatch(block, /satisfaction number/);
});

test('on a green day the satisfaction line leads the block', () => {
  const block = dp.todayPlanBlock({
    satisfaction: { enabled: true, amountUsd: 300 },
    evalPlanCfg: { enabled: true, days: 4 },
    streakCfg: { enabled: true, afterLosses: 4 },
    dayPnl: 180, balance: 51300, targetBalance: 53000,
    trades: [{ pnl: 180, at: 1 }],
    perTradeStopUsd: 200, dailyLossLimit: 1000, drawdownLimit: 2000,
  });
  assert.match(block, /satisfaction number/);
  assert.match(block, /EVAL PACE/);
  assert.doesNotMatch(block, /STREAK GATE/);   // one trade is not a streak
});

test('the combined block is empty rather than a bare heading', () => {
  assert.equal(dp.todayPlanBlock({}), '');
});
