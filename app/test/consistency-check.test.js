'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cc = require('../consistency-check');

const NOUL = (v) => ({ ok: true, answers: { q: { type: 'noul', noul: v } } });
const RUNS = (vals) => vals.map((v) => NOUL(v));

// ── the sample floor ───────────────────────────────────────────────────────
test('below the repeat floor nothing is reported', () => {
  const r = cc.summariseQuestion('q', [0.7, 0.72], {});
  assert.equal(r.verdict, 'INSUFFICIENT');
  assert.equal(r.sd, null);
  assert.match(r.note, /5 are needed/);
});

// ── the four verdicts ──────────────────────────────────────────────────────
test('a question that holds still is STABLE', () => {
  const r = cc.summariseQuestion('q', [0.96, 0.96, 0.96, 0.96, 0.96], {});
  assert.equal(r.verdict, 'STABLE');
  assert.equal(r.sd, 0);
});

test('real spread AWAY from a threshold is MOVING, not a failure', () => {
  // No decision sits near 0.2, so the wobble costs nothing operationally.
  const r = cc.summariseQuestion('q', [0.18, 0.22, 0.25, 0.20, 0.15], {});
  assert.equal(r.verdict, 'MOVING');
  assert.ok(r.sd > 0.02);
});

test('repeats landing on BOTH sides of a real threshold is the loud verdict', () => {
  // The whole point: a spread of 0.04 looks harmless until it straddles 0.5.
  const r = cc.summariseQuestion('q', [0.46, 0.52, 0.49, 0.55, 0.48], {});
  assert.equal(r.verdict, 'FLIPS_AT_THRESHOLD');
  assert.equal(r.crossings.find((c) => c.at === 0.5).crossed, true);
  assert.match(r.note, /either way/);
});

test('a question that never crosses but reaches the margin is NEAR_THRESHOLD', () => {
  const r = cc.summariseQuestion('q', [0.62, 0.63, 0.64, 0.63, 0.62], {});
  assert.equal(r.verdict, 'NEAR_THRESHOLD');
  assert.match(r.note, /within/);
});

test('only thresholds the APP gates on are considered, and the reason is carried', () => {
  const r = cc.summariseQuestion('q', [0.46, 0.52, 0.49, 0.55, 0.48], {});
  for (const c of r.crossings) assert.ok(c.why && c.why.length > 10, 'a threshold must explain itself');
  assert.ok(r.crossings.some((c) => c.why.includes('voice router')));
});

test('a caller can supply its own thresholds', () => {
  const r = cc.summariseQuestion('q', [0.14, 0.16, 0.15, 0.17, 0.15], { thresholds: [{ at: 0.15, why: 'a custom gate' }] });
  assert.equal(r.verdict, 'FLIPS_AT_THRESHOLD');
});

// ── choice answers ─────────────────────────────────────────────────────────
test('a choice that picked the same option every time is STABLE', () => {
  const runs = Array.from({ length: 5 }, () => ({ ok: true, answers: { intent: { type: 'choice', choice: 'account_status', confidence: 0.9 } } }));
  const r = cc.summariseRun(runs, {});
  assert.equal(r.questions[0].kind, 'categorical');
  assert.equal(r.questions[0].verdict, 'STABLE');
});

test('a choice that picked DIFFERENT options is MOVING — there is no mean of two answers', () => {
  const runs = ['account_status', 'day_status', 'account_status', 'account_status', 'day_status']
    .map((c) => ({ ok: true, answers: { intent: { type: 'choice', choice: c, confidence: 0.5 } } }));
  const r = cc.summariseRun(runs, {});
  assert.equal(r.questions[0].verdict, 'MOVING');
  assert.equal(r.questions[0].distinct, 2);
  assert.match(r.questions[0].note, /2 different options/);
});

test('choice CONFIDENCE is deliberately not the value being compared', () => {
  // Confidence describes the distribution; the value is what flips a gate.
  const r = cc.valueOf({ type: 'choice', choice: 'B', confidence: 0.11 });
  assert.equal(r, 'B');
});

// ── the whole run ──────────────────────────────────────────────────────────
test('a run reports the worst spread and names which questions flip', () => {
  const runs = [0.46, 0.52, 0.49, 0.55, 0.48].map((v) => ({ ok: true, answers: {
    flippy: { type: 'noul', noul: v },
    solid: { type: 'noul', noul: 0.96 },
  } }));
  const r = cc.summariseRun(runs, {});
  assert.deepEqual(r.flipping, ['flippy']);
  assert.equal(r.questions[0].id, 'flippy', 'the loudest question sorts first');
  assert.match(r.summary, /UNSAFE TO GATE ON/);
});

test('all-stable runs say so plainly', () => {
  const runs = [0.96, 0.96, 0.96, 0.96, 0.96].map((v) => ({ ok: true, answers: { q: { type: 'noul', noul: v } } }));
  const r = cc.summariseRun(runs, {});
  assert.match(r.summary, /held still across 5 repeats/);
  assert.equal(r.worstSd, 0);
});

test('failed repeats are counted, not silently averaged in', () => {
  const runs = RUNS([0.5, 0.5]).concat([{ ok: false, reason: 'HTTP 503' }]);
  const r = cc.summariseRun(runs, {});
  assert.equal(r.failed, 1);
  assert.equal(r.repeats, 2, 'only the successful repeats are measured');
  assert.match(r.summary, /2 repeat\(s\) captured \(1 failed\)/);
});

test('a run of nothing but failures says so', () => {
  const r = cc.summariseRun([{ ok: false }, { ok: false }], {});
  assert.equal(r.repeats, 0);
  assert.match(r.summary, /No successful repeats/);
});

test('no repeats at all does not throw', () => {
  assert.doesNotThrow(() => cc.summariseRun(null, {}));
  assert.doesNotThrow(() => cc.summariseRun([], {}));
});

// ── the statistics ─────────────────────────────────────────────────────────
test('sd is the population standard deviation, matching the cookbook', () => {
  // The cookbook reported a mean per-question probability sd of 0.0102.
  assert.equal(cc.sd([1, 1, 1, 1]), 0);
  assert.ok(Math.abs(cc.sd([0.70, 0.72, 0.74]) - 0.01633) < 0.001);
});

test('a single repeat has no spread to report', () => {
  assert.equal(cc.sd([0.5]), 0);
});

test('range and mean are reported beside the sd, because sd alone hides a bimodal draw', () => {
  const r = cc.summariseQuestion('q', [0.1, 0.1, 0.9, 0.9, 0.5], {});
  assert.equal(r.min, 0.1);
  assert.equal(r.max, 0.9);
  assert.equal(r.range, 0.8);
  assert.equal(r.mean, 0.5);
});

test('it never claims a probability of being correct — only spread', () => {
  const r = cc.summariseRun(RUNS([0.5, 0.5, 0.5, 0.5, 0.5]), {});
  assert.equal(/chance|probability of being|accurate/i.test(r.summary), false);
});
