'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const as = require('../answer-store');

const REC = (ts, conf, outcome, points) => ({
  ts, setupId: 's' + ts, question: 'match', answer: 'A', probabilities: { A: conf, B: 1 - conf },
  confidence: conf, outcome: outcome === undefined ? true : outcome, points: points != null ? points : 10, costs: 2,
});

// ── the record ─────────────────────────────────────────────────────────────
test('the record stores the DISTRIBUTION, not just the winning option', () => {
  // This is the whole mechanism: a threshold needs the probabilities, so an
  // answer stored without them can never be re-scored, only re-asked.
  const r = as.buildRecord({ answer: { choice: 'A', probabilities: { A: 0.8, B: 0.2 }, confidence: 0.8 } });
  assert.deepEqual(r.probabilities, { A: 0.8, B: 0.2 });
  assert.equal(r.answer, 'A');
  assert.equal(r.confidence, 0.8);
});

test('a noul answer and a score answer both store their value', () => {
  assert.equal(as.buildRecord({ answer: { noul: 0.42 } }).answer, 0.42);
  assert.equal(as.buildRecord({ answer: { score: 2.07 } }).answer, 2.07);
});

test('an unresolved outcome is null — PENDING, never a loss', () => {
  assert.equal(as.buildRecord({}).outcome, null);
  assert.equal(as.buildRecord({ outcome: false }).outcome, false);
});

test('buildRecord never throws on junk', () => {
  for (const bad of [null, undefined, 42, 'x', {}]) assert.doesNotThrow(() => as.buildRecord(bad));
});

// ── replay needs no model ──────────────────────────────────────────────────
test('a higher floor takes FEWER records — replay is arithmetic, not inference', () => {
  const recs = [REC('1', 0.9), REC('2', 0.75), REC('3', 0.65), REC('4', 0.55)];
  assert.equal(as.score(recs, { minConfidence: 0.5 }, { minSamples: 1 }).taken, 4);
  assert.equal(as.score(recs, { minConfidence: 0.7 }, { minSamples: 1 }).taken, 2);
  assert.equal(as.score(recs, { minConfidence: 0.95 }, { minSamples: 1 }).taken, 0);
});

test('the score refuses a win rate below the sample floor', () => {
  const recs = Array.from({ length: 10 }, (_, i) => REC(String(i), 0.9, i < 6));
  const s = as.score(recs, { minConfidence: 0.5 }, { minSamples: 30 });
  assert.equal(s.winRate, null);
  assert.equal(s.ci, null);
  assert.match(s.note, /30 are needed/);
});

test('NET points subtract costs, because a filter can raise the win rate and still lose', () => {
  // The exact shape trade-jev measured: acting on everything at -$128,590.
  const recs = Array.from({ length: 40 }, () => REC('x', 0.9, true, 10));
  const s = as.score(recs, { minConfidence: 0.5 }, {});
  assert.equal(s.pointsGross, 400);
  assert.equal(s.pointsNet, 320, '40 records x (10 points - 2 cost)');
});

test('a record with no resolved outcome is never counted as a loss', () => {
  const recs = [REC('1', 0.9, true), as.buildRecord({ ts: '2', answer: { choice: 'A', confidence: 0.9 } })];
  const s = as.score(recs, { minConfidence: 0.5 }, { minSamples: 1 });
  assert.equal(s.considered, 1);
  assert.equal(s.taken, 1);
});

// ── the split, and why it is by TIME ───────────────────────────────────────
test('the split is by TIME, never random — clustered signals are not independent', () => {
  const recs = [REC('2026-09-01', 0.9), REC('2026-09-05', 0.9), REC('2026-09-10', 0.9), REC('2026-09-20', 0.9)];
  const s = as.splitByTime(recs, 0.5);
  assert.equal(s.tune.length, 2);
  assert.equal(s.test.length, 2);
  assert.equal(s.tune[1].ts, '2026-09-05');
  assert.equal(s.test[0].ts, '2026-09-10');
});

test('every tuning record precedes every test record', () => {
  const recs = Array.from({ length: 20 }, (_, i) => REC('2026-09-' + String(i + 1).padStart(2, '0'), 0.9));
  const s = as.splitByTime(recs, 0.6);
  const lastTune = s.tune[s.tune.length - 1].ts;
  for (const r of s.test) assert.ok(r.ts >= lastTune, 'test record ' + r.ts + ' precedes the cut ' + lastTune);
});

test('an empty or single-record series splits without throwing', () => {
  assert.doesNotThrow(() => as.splitByTime([], 0.6));
  assert.equal(as.splitByTime([REC('1', 0.9)], 0.6).test.length, 0);
});

// ── the sweep, and the overfit verdict ─────────────────────────────────────
const series = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

test('the sweep reports the tuning result AND the held-out result, always', () => {
  const recs = series(80, (i) => REC('2026-09-' + String(Math.floor(i / 4) + 1).padStart(2, '0'), i % 2 ? 0.9 : 0.6, i % 3 !== 0));
  const r = as.sweep(recs, { minConfidence: [0.5, 0.7, 0.9] }, { minSamples: 5 });
  assert.equal(r.settingsTried, 3);
  assert.ok(r.best);
  assert.ok(r.best.tune && r.best.test, 'both halves must be reported for the winner');
});

test('a setting that wins only on the half it was chosen from is called OVERFIT', () => {
  // Constructed so the high-confidence records win early and lose late — the
  // signature of a setting fitted to its own data.
  const tune = series(60, (i) => REC('2026-09-01T0' + (i % 9) + ':00:00Z', 0.95, i % 5 !== 0));
  const test = series(60, (i) => REC('2026-09-20T0' + (i % 9) + ':00:00Z', 0.95, i % 5 === 0));
  const r = as.sweep(tune.concat(test), { minConfidence: [0.9] }, { minSamples: 5 });
  assert.equal(r.verdict, 'OVERFIT');
  assert.match(r.summary, /noise, not a result/);
});

test('a setting that holds up on both halves is called a LEAD, not an edge', () => {
  const recs = series(80, (i) => REC('2026-09-' + String(Math.floor(i / 4) + 1).padStart(2, '0'), 0.9, i % 5 !== 0));
  const r = as.sweep(recs, { minConfidence: [0.5, 0.6, 0.7, 0.8, 0.9] }, { minSamples: 5 });
  assert.equal(r.verdict, 'HELD_UP');
  assert.match(r.summary, /lead worth testing forward on new days — not an edge/);
});

test('the sweep states how many settings were tried — the multiple-comparison count', () => {
  const recs = series(80, (i) => REC('2026-09-' + String(Math.floor(i / 4) + 1).padStart(2, '0'), 0.9, i % 5 !== 0));
  const r = as.sweep(recs, { minConfidence: [0.5, 0.6, 0.7, 0.8, 0.9] }, { minSamples: 5 });
  assert.equal(r.settingsTried, 5);
  // Stated in BOTH branches: a winner from a five-way search is still a winner of
  // a five-way search, even when it holds up.
  assert.match(r.summary, /5 settings were tried on the same data/);
});

test('no tuneable candidate says so rather than picking one anyway', () => {
  const r = as.sweep([REC('1', 0.9)], { minConfidence: [0.9] }, { minSamples: 30 });
  assert.equal(r.verdict, 'INSUFFICIENT');
  assert.equal(r.best, null);
});

test('sweep never throws on junk', () => {
  for (const bad of [null, undefined, 42, []]) assert.doesNotThrow(() => as.sweep(bad, {}, {}));
});

// ── io ─────────────────────────────────────────────────────────────────────
test('records round-trip through the store, append-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ans-'));
  try {
    assert.equal(as.appendRecords(dir, [REC('1', 0.9), REC('2', 0.8)]), 2);
    assert.equal(as.appendRecords(dir, REC('3', 0.7)), 1);
    const back = as.readRecords(dir);
    assert.equal(back.length, 3);
    assert.equal(back[0].confidence, 0.9);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an empty store reads as an empty list, not a throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ans2-'));
  try { assert.deepEqual(as.readRecords(dir), []); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('outcomes are attached by setupId, and a missing one leaves the record pending', () => {
  const recs = [REC('1', 0.9), REC('2', 0.9)];
  recs[0].setupId = 'a'; recs[1].setupId = 'b';
  recs[0].outcome = null; recs[1].outcome = null;
  const out = as.withOutcomes(recs, { a: { outcome: true, points: 42 } });
  assert.equal(out[0].outcome, true);
  assert.equal(out[0].points, 42);
  assert.equal(out[1].outcome, null, 'a record with no outcome stays pending');
});

test('the store path is under typesafe/, beside the call ledger', () => {
  assert.match(as.storePath('/x'), /typesafe[\\/]answers\.jsonl$/);
});
