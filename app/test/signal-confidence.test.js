'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scoreSignal, evidenceFromAggregates, MIN_SAMPLE_FOR_HIT_RATE } = require('../signal-confidence.js');

const RULES = { perTradeMaxLoss: 300 };
const full = {
  playbook: 'B', tf: '30', direction: 'BULLISH',
  structure: 'HH-HL', hourTrend: 'STRONG BULL', sessionTier: 'NY',
  newsBlackout: false, liquiditySwept: false, riskUsd: 200, isRefire: false,
};

test('a setup meeting every condition reads as FULL AGREEMENT', () => {
  const r = scoreSignal(full, RULES);
  assert.equal(r.confluence, 1);
  assert.equal(r.band, 'FULL AGREEMENT');
  assert.equal(r.reasons.length, 0);
});

test('a conflicting setup names WHICH conditions failed', () => {
  const r = scoreSignal({ ...full, structure: 'LL-LH', hourTrend: 'STRONG BEAR', newsBlackout: true }, RULES);
  assert.ok(r.confluence < 0.6);
  assert.equal(r.band, 'CONFLICTS WITH PLAYBOOK');
  assert.ok(r.reasons.some((x) => /structure/i.test(x)));
  assert.ok(r.reasons.some((x) => /news/i.test(x)));
});

// ── The distinction the whole module exists to protect ──────────────────────
test('confluence is NEVER presented as a probability, and says so', () => {
  const r = scoreSignal(full, RULES);
  assert.match(r.caveat, /NOT probability/);
  assert.equal(r.measured, null, 'no evidence supplied → no hit rate');
});

test('a hit rate is withheld below the minimum sample, with the reason attached', () => {
  const r = scoreSignal(full, RULES, { n: MIN_SAMPLE_FOR_HIT_RATE - 1, targetRate: 0.9 });
  assert.equal(r.measured, null);
  assert.match(r.measuredUnavailableReason, /needs >=20/);
});

test('a hit rate IS returned once the sample is real', () => {
  const r = scoreSignal(full, RULES, { n: 40, targetRate: 0.55, source: 'backtest' });
  assert.deepEqual(r.measured, { targetRate: 0.55, n: 40, source: 'backtest' });
});

test('a perfect confluence score with no evidence still yields no hit rate', () => {
  // The exact failure mode this design prevents: 7/7 conditions met must not
  // become "high confidence" in the sense a trader would act on.
  const r = scoreSignal(full, RULES);
  assert.equal(r.confluence, 1);
  assert.equal(r.measured, null);
});

// ── Unknown must not be treated as adverse ──────────────────────────────────
test('unevaluable factors are excluded from the denominator, not counted against', () => {
  const partial = { playbook: 'B', tf: '30', direction: 'BULLISH', structure: 'HH-HL', sessionTier: 'NY', newsBlackout: false };
  const r = scoreSignal(partial, RULES);
  assert.equal(r.confluenceApplicable, 3);
  assert.equal(r.confluenceMet, 3);
  assert.equal(r.confluence, 1, 'a chart-feed outage must not look like a bad setup');
  assert.ok(r.components.some((c) => c.value === null && /not evaluable/.test(c.note)));
});

test('a NEUTRAL or mixed trend reads as unknown, not as disagreement', () => {
  const r = scoreSignal({ ...full, hourTrend: 'NEUTRAL', structure: 'mixed/ranging' }, RULES);
  const structure = r.components.find((c) => c.key === 'structure');
  const bias = r.components.find((c) => c.key === 'htfBias');
  assert.equal(structure.value, null);
  assert.equal(bias.value, null);
});

test('too few evaluable factors is reported as such rather than scored', () => {
  const r = scoreSignal({ playbook: 'B', tf: '30', direction: 'BULLISH', sessionTier: 'NY' }, RULES);
  assert.equal(r.band, 'TOO LITTLE DATA');
});

test('an empty signal never throws and never invents a score', () => {
  const r = scoreSignal({}, RULES);
  assert.equal(r.confluence, null);
  assert.equal(r.band, 'UNKNOWN');
  assert.equal(r.measured, null);
});

// ── Individual factors ──────────────────────────────────────────────────────
test('risk over the per-trade limit fails the riskFits factor', () => {
  const r = scoreSignal({ ...full, riskUsd: 500 }, RULES);
  assert.equal(r.components.find((c) => c.key === 'riskFits').value, false);
});

test('a re-fired setup fails the freshness factor', () => {
  const r = scoreSignal({ ...full, isRefire: true }, RULES);
  assert.equal(r.components.find((c) => c.key === 'freshness').value, false);
});

test('outside-session fails, a named session passes', () => {
  assert.equal(scoreSignal({ ...full, sessionTier: 'outside-session' }, RULES).components.find((c) => c.key === 'session').value, false);
  assert.equal(scoreSignal({ ...full, sessionTier: 'London' }, RULES).components.find((c) => c.key === 'session').value, true);
});

test('bearish direction agrees with a bearish structure and not a bullish one', () => {
  const bear = scoreSignal({ ...full, direction: 'BEARISH', structure: 'LL-LH', hourTrend: 'STRONG BEAR' }, RULES);
  assert.equal(bear.components.find((c) => c.key === 'structure').value, true);
  const mismatched = scoreSignal({ ...full, direction: 'BEARISH' }, RULES);
  assert.equal(mismatched.components.find((c) => c.key === 'structure').value, false);
});

// ── evidenceFromAggregates ──────────────────────────────────────────────────
test('evidence is matched on playbook AND timeframe together', () => {
  const agg = [{ playbook: 'B', tf: '30', n: 40, targetRate: 0.5 }, { playbook: 'B', tf: '15', n: 9, targetRate: 0.9 }];
  assert.equal(evidenceFromAggregates(agg, 'B', '30').n, 40);
  assert.equal(evidenceFromAggregates(agg, 'B', '15').targetRate, 0.9);
  assert.equal(evidenceFromAggregates(agg, 'A', '30').n, 0, 'an unknown bucket must report zero, never borrow another bucket');
});

test('missing aggregates yield zero, never a guess', () => {
  assert.deepEqual(evidenceFromAggregates(null, 'B', '30'), { n: 0, targetRate: null });
});
