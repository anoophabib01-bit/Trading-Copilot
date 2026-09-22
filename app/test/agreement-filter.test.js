'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const af = require('../agreement-filter');

const R = (answer, conf, at) => ({ answer, confidence: conf != null ? conf : 0.9, at: at != null ? at : Date.now() });
const ON = { enabled: true, minAgreeing: 4, minConfidence: 0.7, maxAgeMs: 30 * 60 * 1000 };
const series = (...rs) => rs.map((r) => R(r));

// ── the published setting is the default ───────────────────────────────────
test('the defaults ARE trade-jev\'s winning setting, not invented here', () => {
  // 0.7 cutoff and 4 agreeing answers are the two numbers that turned -$128,590
  // into +$20,795 in their 15-day NQ backtest.
  const s = af.filterSettings({});
  assert.equal(s.minAgreeing, 4);
  assert.equal(s.minConfidence, 0.7);
});

test('it ships OFF — a published lead is not a licence to act', () => {
  assert.equal(af.filterSettings({}).enabled, false);
  const r = af.shouldAct(series('buy', 'buy', 'buy', 'buy'), { enabled: false });
  assert.equal(r.act, false);
  assert.match(r.reason, /off/);
});

// ── the trailing run ───────────────────────────────────────────────────────
test('the run counted is the one still standing, not the best run of the day', () => {
  // buy x4, then a sell: the sell has broken the run, whatever came before.
  const run = af.trailingRun(series('buy', 'buy', 'buy', 'buy', 'sell'));
  assert.equal(run.answer, 'sell');
  assert.equal(run.length, 1);
});

test('the run reports the LOWEST confidence inside it, not the last one', () => {
  const run = af.trailingRun([R('buy', 0.95), R('buy', 0.71), R('buy', 0.9)]);
  assert.equal(run.length, 3);
  assert.equal(run.minConfidence, 0.71);
});

test('an empty or junk series has no run rather than throwing', () => {
  for (const bad of [[], null, undefined, 'x', [{}], [null]]) {
    assert.doesNotThrow(() => af.trailingRun(bad));
    assert.equal(af.trailingRun(bad).length, 0);
  }
});

// ── the two conditions, both required ──────────────────────────────────────
test('four agreeing reads at good confidence act', () => {
  const r = af.shouldAct(series('buy', 'buy', 'buy', 'buy'), ON);
  assert.equal(r.act, true);
  assert.equal(r.run.length, 4);
  assert.match(r.reason, /4 consecutive reads agree on "buy"/);
});

test('three agreeing reads do NOT — the run length is the whole point', () => {
  const r = af.shouldAct(series('buy', 'buy', 'buy'), ON);
  assert.equal(r.act, false);
  assert.match(r.reason, /only 3 agreeing read\(s\)/);
  assert.match(r.reason, /4 are required/);
});

test('a flip-flopping series never acts, however many reads it has', () => {
  // This is the failure trade-jev measured: Jev flips between snapshots, and
  // acting on that lost more than random trading.
  const r = af.shouldAct(series('buy', 'sell', 'buy', 'sell', 'buy', 'sell', 'buy'), ON);
  assert.equal(r.act, false);
  assert.equal(r.run.length, 1);
});

test('four agreeing reads with ONE weak read is not four agreeing answers', () => {
  // A run of four where one is at 0.51 is three and a shrug.
  const r = af.shouldAct([R('buy', 0.95), R('buy', 0.51), R('buy', 0.9), R('buy', 0.9)], ON);
  assert.equal(r.act, false);
  assert.match(r.reason, /below the 0.7 confidence floor/);
});

test('a read with NO confidence cannot satisfy the floor', () => {
  // Built literally, because the R() helper defaults a missing confidence to
  // 0.9 — the first version of this test could not express "no confidence" at
  // all and passed against a row that had one.
  const noConf = { answer: 'buy', confidence: null, at: Date.now() };
  const r = af.shouldAct([R('buy', 0.9), noConf, R('buy', 0.9), R('buy', 0.9)], ON);
  assert.equal(r.act, false);
  assert.match(r.reason, /below the/);
});

test('a longer agreeing run acts, and reports its true length', () => {
  const r = af.shouldAct(series('sell', 'sell', 'sell', 'sell', 'sell', 'sell'), ON);
  assert.equal(r.act, true);
  assert.equal(r.run.length, 6);
});

// ── staleness ──────────────────────────────────────────────────────────────
test('a stale newest read is refused — agreement across an hour is not agreement', () => {
  const now = 1_000_000_000;
  const old = now - (31 * 60 * 1000);
  const r = af.shouldAct([R('buy', 0.9, old), R('buy', 0.9, old), R('buy', 0.9, old), R('buy', 0.9, old)], ON, now);
  assert.equal(r.act, false);
  assert.match(r.reason, /stale/);
});

test('fresh reads inside the window are fine', () => {
  const now = 1_000_000_000;
  const fresh = now - 60_000;
  const r = af.shouldAct([R('buy', 0.9, fresh), R('buy', 0.9, fresh), R('buy', 0.9, fresh), R('buy', 0.9, fresh)], ON, now);
  assert.equal(r.act, true);
});

// ── the series builder ─────────────────────────────────────────────────────
test('addReading appends newest-last and keeps the original array untouched', () => {
  const s0 = [];
  const s1 = af.addReading(s0, { answer: 'buy', confidence: 0.9, at: 5 });
  assert.deepEqual(s0, [], 'the input must not be mutated');
  assert.equal(s1.length, 1);
  assert.equal(s1[0].answer, 'buy');
  const s2 = af.addReading(s1, { answer: 'sell', confidence: 0.8, at: 6 });
  assert.equal(s2[s2.length - 1].answer, 'sell');
});

test('a reading with no answer is ignored rather than stored as a blank', () => {
  assert.equal(af.addReading([], { confidence: 0.9 }).length, 0);
  assert.equal(af.addReading([], null).length, 0);
});

test('the series is BOUNDED — an unbounded poll series is a memory leak', () => {
  let s = [];
  for (let i = 0; i < 200; i++) s = af.addReading(s, { answer: 'buy', confidence: 0.9 });
  assert.ok(s.length <= 24, 'series length ' + s.length);
});

test('a missing timestamp is filled in rather than left undefined', () => {
  const s = af.addReading([], { answer: 'buy', confidence: 0.9 });
  assert.equal(typeof s[0].at, 'number');
});

// ── config surface ─────────────────────────────────────────────────────────
test('the thresholds are overridable and clamped', () => {
  assert.equal(af.filterSettings({ agreementFilter: { minAgreeing: 2 } }).minAgreeing, 2);
  assert.equal(af.filterSettings({ agreementFilter: { minAgreeing: 1 } }).minAgreeing, 4, 'a run of 1 is not agreement');
  assert.equal(af.filterSettings({ agreementFilter: { minAgreeing: 999 } }).minAgreeing, 20);
  assert.equal(af.filterSettings({ agreementFilter: { minConfidence: 5 } }).minConfidence, 0.7);
});

test('shouldAct never throws on junk', () => {
  for (const bad of [null, undefined, 42, {}, []]) assert.doesNotThrow(() => af.shouldAct(bad, ON));
});

test('the reason always names what was actually counted', () => {
  // A refusal that does not say how close it was is a refusal nobody can act on.
  const r = af.shouldAct(series('buy', 'buy'), ON);
  assert.match(r.reason, /2 agreeing/);
  assert.equal(/chance|probability|likely/i.test(r.reason), false);
});
