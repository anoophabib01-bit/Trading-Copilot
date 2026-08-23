'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computePayoutEligibility, summarizePayout, daysSinceLastPayout } = require('../payout-eligibility');

// Cases are taken from Tradeify's own published worked examples wherever one
// exists, so this suite is checking the app against the FIRM's arithmetic
// rather than against my reading of it.
// https://help.tradeify.co/en/articles/10468320-rules-consistency-rule

const GROWTH = { consistencyPct: 35, minProfitableDays: 5, minDayProfit: 150 };

function d(date, pnl) { return { date, pnl, gross: pnl }; }

test("FIRM EXAMPLE: $4,000 biggest of $10,000 total = 40% — fails a 35% rule", () => {
  const days = [d('2026-08-01', 4000), d('2026-08-02', 2000), d('2026-08-03', 2000), d('2026-08-04', 1000), d('2026-08-05', 1000)];
  const e = computePayoutEligibility(days, [], GROWTH);
  assert.equal(e.totalProfit, 10000);
  assert.equal(e.biggestDay, 4000);
  assert.equal(e.consistencyPct, 40);
  assert.equal(e.consistencyOk, false);
  assert.equal(e.eligible, false);
});

test("FIRM EXAMPLE: +$1,500 on day 11 → $4,000 of $11,500 = 34.7%, now eligible", () => {
  const days = [d('2026-08-01', 4000), d('2026-08-02', 2000), d('2026-08-03', 2000), d('2026-08-04', 1000), d('2026-08-05', 1000), d('2026-08-06', 1500)];
  const e = computePayoutEligibility(days, [], GROWTH);
  assert.equal(e.totalProfit, 11500);
  assert.ok(Math.abs(e.consistencyPct - 34.78) < 0.01);
  assert.equal(e.consistencyOk, true);
  assert.equal(e.eligible, true, 'six qualifying days clears the 5-day minimum too');
});

test('FIRM EXAMPLE: required total = biggest / limit ($2,682.10 at 20% → $13,410.50)', () => {
  const days = [d('2026-08-01', 2682.10)];
  const e = computePayoutEligibility(days, [], { consistencyPct: 20, minProfitableDays: 0, minDayProfit: 0 });
  assert.ok(Math.abs(e.requiredTotal - 13410.50) < 0.01);
});

test('BOUNDARY: at-or-below passes — 19.97% and exactly 20.00% both meet a 20% rule', () => {
  // The source is explicit that only STRICTLY ABOVE fails.
  // Biggest day must be the one under test, so the rest is spread thinner.
  const under = computePayoutEligibility(
    [d('a', 1997), d('b', 1600.6), d('c', 1600.6), d('d', 1600.6), d('e', 1600.6), d('f', 1600.6)],
    [], { consistencyPct: 20 });
  assert.equal(under.biggestDay, 1997);
  assert.ok(Math.abs(under.consistencyPct - 19.97) < 0.001);
  assert.equal(under.consistencyOk, true);

  const exact = computePayoutEligibility(
    [d('a', 2000), d('b', 1600), d('c', 1600), d('d', 1600), d('e', 1600), d('f', 1600)],
    [], { consistencyPct: 20 });
  assert.equal(exact.biggestDay, 2000);
  assert.ok(Math.abs(exact.consistencyPct - 20) < 1e-9);
  assert.equal(exact.consistencyOk, true, 'exactly at the limit must PASS, not fail');
});

test('BOUNDARY: float noise at the limit must not manufacture a breach', () => {
  // 0.1+0.2 arithmetic can land a hair above the limit; the epsilon exists so
  // that never reads as ineligible.
  const e = computePayoutEligibility([d('a', 35), d('b', 32.5), d('c', 32.5)], [], { consistencyPct: 35 });
  assert.equal(e.biggestDay, 35);
  assert.equal(e.totalProfit, 100);
  assert.equal(e.consistencyOk, true);
});

test('a single profitable day is always 100% and can never be eligible', () => {
  const e = computePayoutEligibility([d('2026-08-01', 900)], [], GROWTH);
  assert.equal(e.consistencyPct, 100);
  assert.equal(e.consistencyOk, false);
  assert.equal(e.eligible, false);
});

test('COUNTER-INTUITIVE #2: a losing day makes consistency WORSE by shrinking the denominator', () => {
  // The firm's own FAQ example: biggest $1,000 of $1,500 = 66.7%; a $300 loss
  // drops the total to $1,200 and pushes consistency to 83.3%.
  const before = computePayoutEligibility([d('a', 1000), d('b', 500)], [], { consistencyPct: 20 });
  assert.ok(Math.abs(before.consistencyPct - 66.67) < 0.01);

  const after = computePayoutEligibility([d('a', 1000), d('b', 500), d('c', -300)], [], { consistencyPct: 20 });
  assert.ok(Math.abs(after.consistencyPct - 83.33) < 0.01);
  assert.ok(after.consistencyPct > before.consistencyPct, 'a losing day must worsen the ratio');
  assert.equal(after.losingDays, 1);
});

test('maxNewDayProfit is the ceiling at which a new day does not itself breach', () => {
  // total 10,000 at 35%: d <= 0.35*10000/(1-0.35) = 5384.615...
  const days = [d('a', 3000), d('b', 3000), d('c', 4000)];
  const e = computePayoutEligibility(days, [], { consistencyPct: 35 });
  assert.ok(Math.abs(e.maxNewDayProfit - 5384.6153) < 0.01);
  // Sanity: a day of exactly that size lands the ratio ON the limit.
  const withNew = computePayoutEligibility(days.concat([d('dd', e.maxNewDayProfit)]), [], { consistencyPct: 35 });
  assert.ok(Math.abs(withNew.consistencyPct - 35) < 1e-6);
  assert.equal(withNew.consistencyOk, true, 'landing exactly on the limit stays compliant');
});

test('the period resets after a payout — earlier days stop counting', () => {
  const days = [d('2026-08-01', 5000), d('2026-08-10', 1000), d('2026-08-11', 1000)];
  const payouts = [{ date: '2026-08-05', amount: 4000 }];
  const e = computePayoutEligibility(days, payouts, { consistencyPct: 35 });
  assert.equal(e.periodStartAfter, '2026-08-05');
  assert.equal(e.daysInPeriod, 2);
  assert.equal(e.totalProfit, 2000, 'the pre-payout $5,000 day must be excluded');
  assert.equal(e.biggestDay, 1000);
});

test('a day ON the payout date belongs to the previous period', () => {
  const days = [d('2026-08-05', 5000), d('2026-08-06', 1000)];
  const e = computePayoutEligibility(days, [{ date: '2026-08-05', amount: 1 }], { consistencyPct: 35 });
  assert.equal(e.daysInPeriod, 1);
  assert.equal(e.totalProfit, 1000);
});

test('the LATEST payout wins when several are recorded out of order', () => {
  const days = [d('2026-08-01', 500), d('2026-08-08', 700), d('2026-08-12', 300)];
  const payouts = [{ date: '2026-08-10', amount: 1 }, { date: '2026-08-02', amount: 1 }];
  const { cutoff, days: kept } = daysSinceLastPayout(days, payouts);
  assert.equal(cutoff, '2026-08-10');
  assert.equal(kept.length, 1);
});

test('qualifying days count only days above the firm floor, not every green day', () => {
  const days = [d('a', 200), d('b', 100), d('c', 160), d('d', 5), d('e', 300)];
  const e = computePayoutEligibility(days, [], { consistencyPct: 90, minProfitableDays: 5, minDayProfit: 150 });
  assert.equal(e.profitableDays, 5);
  assert.equal(e.qualifyingDays, 3, '$100 and $5 are green but below the $150 floor');
  assert.equal(e.qualifyingDaysNeeded, 2);
  assert.equal(e.eligible, false, 'consistency alone does not release a payout');
});

test('no profit banked reports consistency as null, never as a compliant 0%', () => {
  const e = computePayoutEligibility([d('a', -300), d('b', -100)], [], GROWTH);
  assert.equal(e.consistencyPct, null);
  assert.equal(e.consistencyOk, false);
  assert.equal(e.eligible, false);
  assert.match(summarizePayout(e), /no net profit banked/);
});

test('an unconfigured limit is never treated as satisfied', () => {
  const e = computePayoutEligibility([d('a', 100), d('b', 100)], [], { consistencyPct: undefined });
  assert.equal(e.consistencyLimitPct, null);
  assert.equal(e.eligible, false);
  assert.match(summarizePayout(e), /no consistency limit configured/);
});

test('profitField selects net vs gross, and defaults to the conservative net', () => {
  const days = [{ date: 'a', pnl: 900, gross: 1000 }, { date: 'b', pnl: 900, gross: 1000 }];
  const net = computePayoutEligibility(days, [], { consistencyPct: 35 });
  assert.equal(net.profitField, 'pnl');
  assert.equal(net.totalProfit, 1800);
  const gross = computePayoutEligibility(days, [], { consistencyPct: 35, profitField: 'gross' });
  assert.equal(gross.totalProfit, 2000);
});

test('malformed rows are ignored rather than poisoning the total with NaN', () => {
  const days = [d('a', 500), { date: 'b', pnl: null }, { date: 'c', pnl: 'oops' }, null, { pnl: 100 }];
  const e = computePayoutEligibility(days, [], { consistencyPct: 35 });
  assert.equal(Number.isFinite(e.totalProfit), true);
  assert.equal(e.totalProfit, 500);
});

test('summary names the concrete next step, not just the percentage', () => {
  const days = [d('a', 1000), d('b', 200)];
  const e = computePayoutEligibility(days, [], GROWTH);
  const s = summarizePayout(e);
  assert.match(s, /83\.3%/);
  assert.match(s, /more profit spread over other days/);
  assert.match(s, /no single new day above/);
});

// ── tier resolution ─────────────────────────────────────────────────────────

const { resolveTier } = require('../payout-eligibility');
const REAL_RULES = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'rules.json'), 'utf8'));

test('resolveTier picks the family+mode block', () => {
  const t = resolveTier(REAL_RULES, 'eval');
  assert.equal(t.key, 'selectEval');
  assert.equal(t.consistencyPct, 40);
  assert.equal(t.minProfitableDays, 3);
});

test('resolveTier switches on funded mode', () => {
  const t = resolveTier(REAL_RULES, 'funded');
  assert.equal(t.key, 'selectFunded');
  assert.equal(t.consistencyPct, null, 'Select has no consistency rule once funded');
});

test('a null consistencyPct is NOT treated as automatically satisfied', () => {
  // The dangerous reading of "no limit" would be "always eligible". It must
  // instead be "cannot compute" — the app never green-lights a payout on the
  // basis of a missing number.
  const t = resolveTier(REAL_RULES, 'funded');
  const e = computePayoutEligibility([d('a', 500), d('b', 500)], [], t);
  assert.equal(e.consistencyLimitPct, null);
  assert.equal(e.eligible, false);
  assert.match(summarizePayout(e), /no consistency limit configured/);
});

test('resolveTier returns null rather than guessing when the family is unset', () => {
  assert.equal(resolveTier({ payout: { tiers: {} } }, 'eval'), null);
  assert.equal(resolveTier({}, 'eval'), null);
  assert.equal(resolveTier(null, 'eval'), null);
});

test('REGRESSION: the dead, wrong consistencyPctMax is gone from rules.json', () => {
  // It was 50 — matching no published Tradeify tier — and read by no code.
  assert.equal(REAL_RULES.eval.consistencyPctMax, undefined);
  assert.ok(REAL_RULES.payout && REAL_RULES.payout.tiers, 'a real payout block must replace it');
});

test('every configured tier is either a usable number or an explicit null', () => {
  for (const [k, t] of Object.entries(REAL_RULES.payout.tiers)) {
    const v = t.consistencyPct;
    assert.ok(v === null || (Number.isFinite(v) && v > 0 && v <= 100), `${k} consistencyPct is neither null nor a valid percent: ${v}`);
  }
});
