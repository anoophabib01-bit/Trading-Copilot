'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const d = require('../prop-firm-doctrine');

// ── streakRisk ─────────────────────────────────────────────────────────────
// The published table from "The Math of Winning in Prop Firms": at a 45% win
// rate the chance of 4 losses in a row is ~9.2%, at 55% ~4.1%, at 65% ~1.5%.
// If these drift, the numbers every agent quotes stop matching the source.
test('streakRisk reproduces the source table at 4 consecutive losses', () => {
  assert.equal((d.streakRisk(0.45, 4) * 100).toFixed(1), '9.2');
  assert.equal((d.streakRisk(0.55, 4) * 100).toFixed(1), '4.1');
  assert.equal((d.streakRisk(0.65, 4) * 100).toFixed(1), '1.5');
});

test('streakRisk is (1 - winRate)^n', () => {
  assert.equal(d.streakRisk(0.5, 1), 0.5);
  assert.equal(d.streakRisk(0.5, 2), 0.25);
  assert.equal(d.streakRisk(0.5, 3), 0.125);
});

test('streakRisk refuses invalid input rather than guessing', () => {
  assert.equal(d.streakRisk(null, 4), null);
  assert.equal(d.streakRisk(1.5, 4), null);
  assert.equal(d.streakRisk(-0.1, 4), null);
  assert.equal(d.streakRisk(0.5, 0), null);
  assert.equal(d.streakRisk(0.5, 2.5), null);
  assert.equal(d.streakRisk(0.5, '4'), 0.0625); // a numeric string is converted, same as Number() elsewhere in the repo
});

// ── breakevenWinRate ───────────────────────────────────────────────────────
test('break-even win rate follows the 50/33/25% table', () => {
  assert.equal(d.breakevenWinRate(1), 0.5);
  assert.equal(Math.round(d.breakevenWinRate(2) * 100), 33);
  assert.equal(d.breakevenWinRate(3), 0.25);
});

test('break-even win rate is null for a non-positive payoff', () => {
  assert.equal(d.breakevenWinRate(0), null);
  assert.equal(d.breakevenWinRate(-1), null);
  assert.equal(d.breakevenWinRate(null), null);
});

// ── winRateFromRows ────────────────────────────────────────────────────────
test('winRateFromRows counts wins and losses, ignoring scratches', () => {
  const rows = [{ pnl: 100 }, { pnl: -50 }, { pnl: 0 }, { pnl: 20 }, { pnl: -10 }, { pnl: 5 }];
  const r = d.winRateFromRows(rows, 5);
  assert.equal(r.n, 5);          // the scratch is neither
  assert.equal(r.winRate, 0.6);  // 3 wins / 5 decided
});

test('winRateFromRows stays silent below the minimum sample', () => {
  assert.equal(d.winRateFromRows([{ pnl: 1 }, { pnl: -1 }], 10), null);
  assert.equal(d.winRateFromRows([], 1), null);
  assert.equal(d.winRateFromRows(null, 1), null);
});

test('winRateFromRows ignores rows with no usable pnl', () => {
  const rows = [{ pnl: 'abc' }, {}, { pnl: null }, { pnl: 10 }, { pnl: -10 }];
  const r = d.winRateFromRows(rows, 2);
  assert.equal(r.n, 2);
  assert.equal(r.winRate, 0.5);
});

// ── formatSurvivalMath ─────────────────────────────────────────────────────
test('survival math states the streak odds, the stop cost and the real account', () => {
  const s = d.formatSurvivalMath({ winRate: 0.45, nTrades: 120, perTradeStopUsd: 200, dailyLossLimit: 1000, drawdownLimit: 2000 });
  assert.match(s, /win rate 45% across 120 decided trades/);
  assert.match(s, /4 consecutive losses is 9\.2%/);
  assert.match(s, /\$200 per-trade stop/);
  assert.match(s, /\$800/);                       // 4 stops
  assert.match(s, /80% of the \$1,000 daily loss limit/);
  assert.match(s, /5 consecutive full stops = \$1,000/);
  assert.match(s, /10 consecutive full stops = \$2,000/);
  assert.match(s, /drawdown IS the real account/);
});

test('survival math omits the win-rate claim when it is not measurable', () => {
  const s = d.formatSurvivalMath({ winRate: null, perTradeStopUsd: 200, dailyLossLimit: 1000, drawdownLimit: 2000 });
  assert.match(s, /Win rate not yet measurable/);
  assert.doesNotMatch(s, /lifetime win rate/);
  assert.match(s, /5 consecutive full stops = \$1,000/);   // the risk math still stands
});

test('survival math survives a rules.json with no firm limits', () => {
  const s = d.formatSurvivalMath({ winRate: 0.5, nTrades: 40, perTradeStopUsd: 200 });
  assert.match(s, /The real account is the drawdown/);
  assert.doesNotMatch(s, /daily loss limit/);
});

test('survival math wears the caller prefix', () => {
  const s = d.formatSurvivalMath({ winRate: 0.5, nTrades: 40, perTradeStopUsd: 200, prefix: 'DRAWDOWN AMMUNITION — ' });
  assert.ok(s.startsWith('DRAWDOWN AMMUNITION — '));
});

test('survival math flags a win rate below the 1:1 break-even line', () => {
  const s = d.formatSurvivalMath({ winRate: 0.4, nTrades: 40, perTradeStopUsd: 200 });
  assert.match(s, /below the 50% break-even line at 1:1/);
  const ok = d.formatSurvivalMath({ winRate: 0.6, nTrades: 40, perTradeStopUsd: 200 });
  assert.doesNotMatch(ok, /below the 50% break-even line/);
});

// ── realReturnLine ─────────────────────────────────────────────────────────
test('real return is payouts minus every account fee', () => {
  const s = d.realReturnLine({ fees: 15000, payouts: 12000, feeCount: 100 });
  assert.match(s, /100 account\(s\) bought for \$15,000\.00/);
  assert.match(s, /payouts \$12,000\.00/);
  assert.match(s, /NET -\$3,000\.00/);
  assert.match(s, /net-negative/);
});

test('real return says so when payouts cover the attempts', () => {
  const s = d.realReturnLine({ fees: 1000, payouts: 2500, feeCount: 4 });
  assert.match(s, /NET \$1,500\.00/);
  assert.match(s, /cover the cost of the attempts/);
});

// ── Doctrine text ──────────────────────────────────────────────────────────
// These guard against a silent trim: the whole point of putting the doctrine
// in one module is that every surface gets the same copy. If a future edit
// deletes a load-bearing line, that should fail here rather than quietly
// vanish from an agent's prompt.
function assertHas(text, needle, label) {
  assert.ok(typeof text === 'string' && text.length > 0, label + ' must be a non-empty string');
  assert.ok(text.indexOf(needle) !== -1, label + ' must mention: ' + needle);
}

test('Deva doctrine keeps its load-bearing advice', () => {
  assertHas(d.DEVA_DOCTRINE, 'Small is big, less is more', 'DEVA_DOCTRINE');
  assertHas(d.DEVA_DOCTRINE, 'physically remove yourself', 'DEVA_DOCTRINE');
  assertHas(d.DEVA_DOCTRINE, 'satisfaction number', 'DEVA_DOCTRINE');
  assertHas(d.DEVA_DOCTRINE, '5-6 days', 'DEVA_DOCTRINE');
  assertHas(d.DEVA_DOCTRINE, 'Two journals', 'DEVA_DOCTRINE');
  assertHas(d.DEVA_DOCTRINE, 'Post-payout relapse', 'DEVA_DOCTRINE');
  assertHas(d.DEVA_DOCTRINE, 'profitable character', 'DEVA_DOCTRINE');
  assertHas(d.DEVA_DOCTRINE, 'mental capital', 'DEVA_DOCTRINE');
});

test('the math doctrine keeps the real-account and expectancy claims', () => {
  assertHas(d.MATH_DOCTRINE, 'THE REAL ACCOUNT', 'MATH_DOCTRINE');
  assertHas(d.MATH_DOCTRINE, 'winRate x avgWin - lossRate x avgLoss', 'MATH_DOCTRINE');
  assertHas(d.MATH_DOCTRINE, '50% at 1:1, 33% at 2:1, 25% at 3:1', 'MATH_DOCTRINE');
  assertHas(d.MATH_DOCTRINE, 'ORDER', 'MATH_DOCTRINE');
  assertHas(d.MATH_DOCTRINE, 'REAL RETURN', 'MATH_DOCTRINE');
});

test('every per-surface block is populated and on-message', () => {
  assertHas(d.LOOP_DOCTRINE, 'drawdown must last 5-6 days', 'LOOP_DOCTRINE');
  assertHas(d.LOOP_PERSONA_SECTION, 'SURVIVAL MATH', 'LOOP_PERSONA_SECTION');
  assertHas(d.JESSI_MATH_SECTION, 'PROP-FIRM MATH', 'JESSI_MATH_SECTION');
  assertHas(d.DEVA_JESSI_SECTION, "DEVA'S DOCTRINE", 'DEVA_JESSI_SECTION');
  assertHas(d.DEVA_SCALPER_SECTION, 'never a third', 'DEVA_SCALPER_SECTION');
  assertHas(d.POST_SESSION_SECTION, 'DRAWDOWN AMMUNITION', 'POST_SESSION_SECTION');
});
