'use strict';
// ── Quality/invariant tests for payout-eligibility.js (2026-08-23) ─────────
// The companion test/payout-eligibility.test.js checks known examples (the
// firm's own worked cases, hand-picked boundaries). This file instead checks
// PROPERTIES that must hold for every input, using randomised fuzzing over a
// seeded PRNG — deterministic (a failure always reproduces from its printed
// seed) but exercising inputs no one would think to hand-write.
//
// Why this matters here specifically: this module's output feeds a real
// payout decision. A property that silently breaks (a ratio going negative,
// a NaN slipping through, mutation of the caller's data) is exactly the kind
// of bug hand-picked examples don't catch because the person writing the
// examples already knows what "normal" looks like.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computePayoutEligibility, resolveTier } = require('../payout-eligibility');

// mulberry32 — tiny, dependency-free seeded PRNG. Reproducibility matters
// more than distribution quality for this purpose.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260823;
const rand = mulberry32(SEED);
const N_TRIALS = 500;

function randomDay(i, rng) {
  // Profits and losses on a realistic MNQ scale, including exact zero.
  const roll = rng();
  let pnl;
  if (roll < 0.1) pnl = 0;
  else if (roll < 0.55) pnl = Math.round(rng() * 2000 * 100) / 100;       // green day
  else pnl = -Math.round(rng() * 1500 * 100) / 100;                       // red day
  return { date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, pnl, gross: pnl };
}

function randomDays(rng, n) {
  return Array.from({ length: n }, (_, i) => randomDay(i, rng));
}

function fmtSeed(trial) { return `seed=${SEED} trial=${trial}`; }

test(`PROPERTY: consistencyPct is null or a positive finite number, never NaN/Infinity/negative (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const days = randomDays(rand, 1 + Math.floor(rand() * 15));
    const limit = 10 + Math.floor(rand() * 90);
    const e = computePayoutEligibility(days, [], { consistencyPct: limit });
    if (e.consistencyPct !== null) {
      assert.ok(Number.isFinite(e.consistencyPct), `${fmtSeed(i)}: consistencyPct must be finite, got ${e.consistencyPct}`);
      assert.ok(e.consistencyPct > 0, `${fmtSeed(i)}: consistencyPct must be positive when not null, got ${e.consistencyPct}`);
    }
  }
});

test(`PROPERTY: eligible implies consistencyOk AND qualifyingDaysNeeded === 0 (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const days = randomDays(rand, 1 + Math.floor(rand() * 20));
    const cfg = {
      consistencyPct: 10 + Math.floor(rand() * 90),
      minProfitableDays: Math.floor(rand() * 8),
      minDayProfit: Math.floor(rand() * 300),
    };
    const e = computePayoutEligibility(days, [], cfg);
    if (e.eligible) {
      assert.equal(e.consistencyOk, true, `${fmtSeed(i)}: eligible=true but consistencyOk=false`);
      assert.equal(e.qualifyingDaysNeeded, 0, `${fmtSeed(i)}: eligible=true but qualifyingDaysNeeded=${e.qualifyingDaysNeeded}`);
    }
  }
});

test(`PROPERTY: no output field is ever NaN, regardless of how adversarial the input is (${N_TRIALS} trials)`, () => {
  const junk = [null, undefined, {}, { date: 'x' }, { date: 'x', pnl: NaN }, { date: 'x', pnl: Infinity }, { date: 'x', pnl: -Infinity }, { date: 'x', pnl: 'abc' }, { date: 'x', pnl: '100' }, 5, 'oops', []];
  for (let i = 0; i < N_TRIALS; i++) {
    const n = 1 + Math.floor(rand() * 6);
    const days = Array.from({ length: n }, () => junk[Math.floor(rand() * junk.length)]);
    const e = computePayoutEligibility(days, [], { consistencyPct: 35, minProfitableDays: 5, minDayProfit: 100 });
    for (const [k, v] of Object.entries(e)) {
      if (typeof v === 'number') {
        assert.ok(!Number.isNaN(v), `${fmtSeed(i)}: field "${k}" is NaN with junk input ${JSON.stringify(days)}`);
      }
    }
  }
});

test(`PROPERTY: adding a losing day never IMPROVES (decreases) consistencyPct, while totalProfit stays positive (${N_TRIALS} trials)`, () => {
  // This is the counter-intuitive rule stated as a general law, not a single
  // hand-picked example: shrinking the denominator can only push the ratio
  // up or leave it unchanged, never down.
  for (let i = 0; i < N_TRIALS; i++) {
    const days = randomDays(rand, 2 + Math.floor(rand() * 8)).filter((d) => d.pnl > 0);
    if (days.length < 1) continue;
    const before = computePayoutEligibility(days, [], { consistencyPct: 35 });
    if (before.consistencyPct == null) continue;
    const loss = -Math.round(rand() * 500 * 100) / 100;
    const after = computePayoutEligibility(days.concat([{ date: 'zz', pnl: loss, gross: loss }]), [], { consistencyPct: 35 });
    if (after.totalProfit <= 0) continue; // undefined regime, not what this property claims
    assert.ok(after.consistencyPct >= before.consistencyPct - 1e-9,
      `${fmtSeed(i)}: a loss must not improve consistency — before=${before.consistencyPct} after=${after.consistencyPct}`);
  }
});

test(`PROPERTY: adding a new green day no larger than the current biggest day never worsens (increases) consistencyPct (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const days = randomDays(rand, 2 + Math.floor(rand() * 8)).filter((d) => d.pnl > 0);
    if (days.length < 1) continue;
    const before = computePayoutEligibility(days, [], { consistencyPct: 35 });
    if (before.consistencyPct == null || before.biggestDay <= 0) continue;
    const smallGreen = Math.round(rand() * before.biggestDay * 100) / 100; // in [0, biggestDay]
    const after = computePayoutEligibility(days.concat([{ date: 'zz', pnl: smallGreen, gross: smallGreen }]), [], { consistencyPct: 35 });
    assert.ok(after.consistencyPct <= before.consistencyPct + 1e-9,
      `${fmtSeed(i)}: a day <= the current biggest must not worsen consistency — before=${before.consistencyPct} after=${after.consistencyPct} addedDay=${smallGreen}`);
  }
});

test(`PROPERTY: maxNewDayProfit, when added as a new day, lands consistencyPct within float tolerance of the limit (${N_TRIALS / 2} trials)`, () => {
  for (let i = 0; i < N_TRIALS / 2; i++) {
    const days = randomDays(rand, 1 + Math.floor(rand() * 10)).filter((d) => d.pnl > 0);
    if (!days.length) continue;
    const limit = 5 + Math.floor(rand() * 60);
    const e = computePayoutEligibility(days, [], { consistencyPct: limit });
    if (!e.maxNewDayProfit || e.maxNewDayProfit <= 0) continue;
    const withNew = computePayoutEligibility(
      days.concat([{ date: 'zz', pnl: e.maxNewDayProfit, gross: e.maxNewDayProfit }]),
      [], { consistencyPct: limit },
    );
    // Only a meaningful check when the new day IS the biggest — otherwise the
    // ceiling formula does not apply (an existing bigger day still governs).
    if (withNew.biggestDay !== e.maxNewDayProfit) continue;
    assert.ok(Math.abs(withNew.consistencyPct - limit) < 1e-6,
      `${fmtSeed(i)}: maxNewDayProfit should land exactly on the limit ${limit}, got ${withNew.consistencyPct}`);
  }
});

test(`PROPERTY: the function never mutates its inputs (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const days = randomDays(rand, 1 + Math.floor(rand() * 10));
    const payouts = rand() < 0.5 ? [] : [{ date: '2026-08-01', amount: 100 }];
    const cfg = { consistencyPct: 35, minProfitableDays: 5, minDayProfit: 100 };
    Object.freeze(cfg);
    days.forEach(Object.freeze);
    Object.freeze(days);
    payouts.forEach(Object.freeze);
    Object.freeze(payouts);
    // Freezing means an in-place mutation attempt THROWS in strict mode,
    // which computePayoutEligibility runs under — so this is a hard assert,
    // not a heuristic diff.
    assert.doesNotThrow(() => computePayoutEligibility(days, payouts, cfg), `${fmtSeed(i)}: must not mutate frozen inputs`);
  }
});

test(`PROPERTY: calling twice with identical (non-frozen) inputs is fully deterministic (${N_TRIALS} trials)`, () => {
  // No Date.now()/Math.random() anywhere in the module under test — this
  // guards against one being introduced later, which would make the payout
  // line in Jessi's context nondeterministic between renders of the same day.
  for (let i = 0; i < N_TRIALS; i++) {
    const days = randomDays(rand, 1 + Math.floor(rand() * 10));
    const cfg = { consistencyPct: 35, minProfitableDays: 5, minDayProfit: 100 };
    const a = computePayoutEligibility(days, [], cfg);
    const b = computePayoutEligibility(days, [], cfg);
    assert.deepEqual(a, b, `${fmtSeed(i)}: identical inputs must produce identical output`);
  }
});

test('PROPERTY: resolveTier never returns a consistencyPct outside (0, 100] or null, for every tier actually configured', () => {
  const rules = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'rules.json'), 'utf8'));
  for (const mode of ['eval', 'funded']) {
    const t = resolveTier(rules, mode);
    if (!t) continue;
    const v = t.consistencyPct;
    assert.ok(v === null || (Number.isFinite(v) && v > 0 && v <= 100), `mode=${mode} tier=${t.key} has an invalid consistencyPct: ${v}`);
  }
});
