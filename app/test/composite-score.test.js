'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cs = require('../composite-score');
const realRules = require('../rules.json');

const SC = (v, conf) => ({ type: 'score', score: v, confidence: conf != null ? conf : 0.8 });
const RULES = (over) => Object.assign({}, over || {});

// ── the questions ──────────────────────────────────────────────────────────
test('four atomic Score questions, each with its own ordered levels', () => {
  const q = cs.buildScoreQuestions(RULES());
  assert.deepEqual(Object.keys(q).sort(), ['level_quality', 'session_quality', 'trend_alignment', 'trigger_quality']);
  for (const k of Object.keys(q)) {
    assert.equal(q[k].type, 'score', k + ' must be a Score — a grade on an ordered scale');
    assert.ok(Array.isArray(q[k].criteria) && q[k].criteria.length >= 2, k + ' needs at least two levels');
    assert.ok(q[k].instructions.length > 20, k + ' needs a real instruction');
  }
});

test('every level is a concrete situation, not a degree of a hidden scale', () => {
  // Each level is judged on its own against the state, so "good/better/best"
  // would be meaningless to the model. They must name situations.
  const q = cs.buildScoreQuestions(RULES());
  for (const k of Object.keys(q)) {
    for (const lvl of q[k].criteria) {
      assert.ok(lvl.split(/\s+/).length >= 4, k + ' level too terse to stand alone: "' + lvl + '"');
      assert.equal(/^(very |somewhat |quite )?(good|bad|better|best|worse|worst|high|medium|low)$/i.test(lvl.trim()), false,
        k + ' level is an adjective, not a situation: "' + lvl + '"');
    }
  }
});

test('a disabled block asks nothing, so a caller can spread it safely', () => {
  assert.deepEqual(cs.buildScoreQuestions({ routerScoring: { enabled: false } }), {});
});

test('levels and weights are overridable from rules.json — data, not prompts', () => {
  const q = cs.buildScoreQuestions({ routerScoring: { dimensions: { session_quality: { levels: ['a situation here', 'another one here'] } } } });
  assert.deepEqual(q.session_quality.criteria, ['a situation here', 'another one here']);
});

test('a malformed levels array falls back to the default rather than shipping a one-level scale', () => {
  const q = cs.buildScoreQuestions({ routerScoring: { dimensions: { session_quality: { levels: ['only one'] } } } });
  assert.equal(q.session_quality.criteria.length, 4);
});

test('the level count is capped at the API limit of ten', () => {
  const many = Array.from({ length: 20 }, (_, i) => 'situation number ' + i + ' described');
  const q = cs.buildScoreQuestions({ routerScoring: { dimensions: { trigger_quality: { levels: many } } } });
  assert.equal(q.trigger_quality.criteria.length, cs.MAX_LEVELS);
});

// ── normalising one answer ─────────────────────────────────────────────────
test('a score is normalised against the levels that were actually sent', () => {
  // 3 of 0..3 is 1.0. The top comes from the criteria length, so a shortened
  // scale cannot silently change what "top" means.
  assert.equal(cs.normaliseAnswer(SC(3), ['a', 'b', 'c', 'd']).value, 1);
  assert.equal(cs.normaliseAnswer(SC(0), ['a', 'b', 'c', 'd']).value, 0);
  assert.equal(cs.normaliseAnswer(SC(1.43), ['a', 'b', 'c']).value, 0.715);
});

test('an out-of-range score is clamped, not passed through', () => {
  assert.equal(cs.normaliseAnswer(SC(9), ['a', 'b']).value, 1);
  assert.equal(cs.normaliseAnswer(SC(-4), ['a', 'b']).value, 0);
});

test('a missing or wrong-typed answer normalises to null, never to zero', () => {
  // The whole point: "no read" and "the worst level" are different facts.
  assert.equal(cs.normaliseAnswer(null, ['a', 'b']), null);
  assert.equal(cs.normaliseAnswer(undefined, ['a', 'b']), null);
  assert.equal(cs.normaliseAnswer({ type: 'noul', noul: 0.9 }, ['a', 'b']), null);
  assert.equal(cs.normaliseAnswer({ type: 'score' }, ['a', 'b']), null);
});

test('the distribution rides along, because equal scores can hide opposite shapes', () => {
  // The docs: a score of 1.0 can be all-on-level-1, or half-on-0 and half-on-2.
  const a = cs.normaliseAnswer({ type: 'score', score: 1, probabilities: { 0: 0, 1: 1, 2: 0 }, confidence: 1 }, ['x', 'y', 'z']);
  const b = cs.normaliseAnswer({ type: 'score', score: 1, probabilities: { 0: 0.5, 1: 0, 2: 0.5 }, confidence: 0 }, ['x', 'y', 'z']);
  assert.equal(a.value, b.value, 'same normalised value...');
  assert.notDeepEqual(a.probabilities, b.probabilities, '...and the evidence to tell them apart is kept');
  assert.equal(a.confidence, 1);
  assert.equal(b.confidence, 0);
});

// ── combining ──────────────────────────────────────────────────────────────
test('all four dimensions combine by the configured weights', () => {
  const r = cs.combine({
    trend_alignment: SC(3), level_quality: SC(3), session_quality: SC(3), trigger_quality: SC(3),
  }, RULES());
  assert.equal(r.composite, 1);
  assert.equal(r.coverage.answered, 4);
  assert.equal(r.coverage.total, 4);
  assert.equal(r.reason, null);
});

test('a missing dimension is EXCLUDED and the rest renormalised, not counted as zero', () => {
  // Three perfect dimensions and no session read must not read as 75%.
  const r = cs.combine({
    trend_alignment: SC(3), level_quality: SC(3), trigger_quality: SC(3),
  }, RULES());
  assert.equal(r.composite, 1, 'a missing read must not drag the composite down');
  assert.equal(r.coverage.answered, 3);
  assert.equal(r.coverage.total, 4);
  assert.equal(Object.keys(r.weightsUsed).length, 3, 'only the answered dimensions get weight');
  const sum = Object.values(r.weightsUsed).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, 'the effective weights must still sum to 1');
});

test('nothing answered yields null with a reason, never a zero', () => {
  const r = cs.combine({}, RULES());
  assert.equal(r.composite, null);
  assert.equal(r.coverage.answered, 0);
  assert.match(r.reason, /no dimension answered/);
});

test('all-zero weights fall back to EQUAL weighting rather than to nothing', () => {
  // A config typo must not silently disable the feature while looking like it ran.
  const zero = { weights: { trend_alignment: 0, level_quality: 0, session_quality: 0, trigger_quality: 0 } };
  const r = cs.combine({ trend_alignment: SC(3), level_quality: SC(0) }, { routerScoring: zero });
  assert.equal(r.equalWeights, true);
  assert.equal(r.composite, 0.5, 'one perfect and one floor, weighted equally');
  assert.ok(Math.abs(r.weightsUsed.trend_alignment - 0.5) < 0.01);
});

test('a negative weight is clamped to zero rather than inverting the dimension', () => {
  const r = cs.combine({ trend_alignment: SC(3), level_quality: SC(3) },
    { routerScoring: { weights: { trend_alignment: 1, level_quality: -5, session_quality: 0, trigger_quality: 0 } } });
  assert.equal(r.composite, 1);
  assert.equal(r.weightsUsed.level_quality, 0);
});

test('the effective weights are reported, so the UI shows what was APPLIED', () => {
  const r = cs.combine({ trend_alignment: SC(3), level_quality: SC(0) }, RULES());
  assert.deepEqual(Object.keys(r.weightsUsed).sort(), ['level_quality', 'trend_alignment']);
  assert.ok(r.weightsUsed.trend_alignment > r.weightsUsed.level_quality);
  const sum = Object.values(r.weightsUsed).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.01);
});

test('every part keeps its raw score and confidence for provenance', () => {
  const r = cs.combine({ trend_alignment: { type: 'score', score: 2, confidence: 0.42 } }, RULES());
  const p = r.parts.find((x) => x.key === 'trend_alignment');
  assert.equal(p.answered, true);
  assert.equal(p.raw, 2);
  assert.equal(p.confidence, 0.42);
  assert.equal(typeof p.value, 'number');
});

// ── the one-line explanation ───────────────────────────────────────────────
test('the explanation never claims a chance of winning', () => {
  const r = cs.combine({ trend_alignment: SC(3) }, RULES());
  const line = cs.explain(r);
  assert.match(line, /not a chance of winning/);
  assert.match(line, /1 of 4 dimensions/);
});

test('the explanation names the weakest answered dimension and the missing ones', () => {
  const r = cs.combine({ trend_alignment: SC(3), level_quality: SC(0) }, RULES());
  const line = cs.explain(r);
  assert.match(line, /weakest: Level quality \(0%\)/);
  assert.match(line, /no read for: Session quality, Trigger quality/);
});

test('nothing answered explains itself rather than printing a number', () => {
  assert.match(cs.explain(cs.combine({}, RULES())), /nothing to combine/);
});

// ── config surface, against his live file ──────────────────────────────────
test('the shipped default weights are all non-negative and sum to roughly one', () => {
  const sum = Object.values(cs.DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.001, 'defaults must sum to 1, got ' + sum);
  for (const k of Object.keys(cs.DEFAULT_WEIGHTS)) assert.ok(cs.DEFAULT_WEIGHTS[k] >= 0);
});

test('the module still builds against his live rules file, whatever it says', () => {
  const q = cs.buildScoreQuestions(realRules);
  assert.ok(Object.keys(q).length >= 1);
  const r = cs.combine({ trend_alignment: SC(2) }, realRules);
  assert.equal(typeof r.composite, 'number');
});
