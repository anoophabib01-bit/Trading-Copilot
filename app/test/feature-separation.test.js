'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsep = require('../feature-separation');

const L = (over) => Object.assign({ ts: '2026-09-20T10:00:00.000Z', playbook: 'A', tf: '15', direction: 'BULLISH' }, over || {});
const O = (over) => Object.assign({ resolved: true, signalTs: '2026-09-20T10:00:00.000Z', playbook: 'A', tf: '15', atHorizon: 10, favourable: true, hit: null }, over || {});

// ── the join ───────────────────────────────────────────────────────────────
test('ledger rows join to outcomes on the key the resolver already writes', () => {
  const j = fsep.joinLedger([L()], [O()]);
  assert.equal(j.joined.length, 1);
  assert.equal(j.unmatched.length, 0);
});

test('a signal whose outcome has not resolved is not joined, and is reported', () => {
  const j = fsep.joinLedger([L()], [O({ signalTs: '2026-09-20T11:00:00.000Z' })]);
  assert.equal(j.joined.length, 0);
  assert.equal(j.unmatched.length, 1);
  assert.equal(j.unmatched[0].playbook, 'A');
});

test('the FIRST ledger row wins, so a re-fire cannot overwrite the fire-time state', () => {
  // The state captured when the signal fired is the one that must be measured.
  const j = fsep.joinLedger([L({ htfBias: 'BULLISH' }), L({ htfBias: 'BEARISH' })], [O()]);
  assert.equal(j.joined[0].ledger.htfBias, 'BULLISH');
});

test('an unresolved outcome is skipped rather than counted', () => {
  const j = fsep.joinLedger([L()], [O({ resolved: false })]);
  assert.equal(j.joined.length, 0);
  assert.equal(j.unmatched.length, 0);
});

test('a missing feature reads as its own group, never as a value', () => {
  // "The ledger did not record this" and "the ledger recorded null" are
  // different facts, and collapsing them invents a group.
  // htfBias present-and-null vs sessionTier absent entirely are DIFFERENT facts.
  const rows = fsep.featureRows(fsep.joinLedger([L({ htfBias: null })], [O()]).joined, { featureKeys: ['htfBias', 'sessionTier'] });
  assert.equal(rows[0].features.htfBias, 'null');
  assert.equal(rows[0].features.sessionTier, 'not-recorded');
});

test('a boolean feature becomes a string group rather than a 0/1 column', () => {
  const rows = fsep.featureRows(fsep.joinLedger([L({ newsBlackout: false })], [O()]).joined, { featureKeys: ['newsBlackout'] });
  assert.equal(rows[0].features.newsBlackout, 'false');
});

// ── the outcome, decided pessimistically ───────────────────────────────────
test('a stop is a loss even when the horizon closed green', () => {
  const rows = fsep.featureRows(fsep.joinLedger([L()], [O({ hit: 'stop', favourable: true })]).joined);
  assert.equal(rows[0].win, false);
});

test('a target is a win even when the horizon closed red', () => {
  const rows = fsep.featureRows(fsep.joinLedger([L()], [O({ hit: 'target', favourable: false })]).joined);
  assert.equal(rows[0].win, true);
});

test('with no hit recorded, the horizon direction decides', () => {
  const w = fsep.featureRows(fsep.joinLedger([L()], [O({ favourable: true })]).joined);
  const l = fsep.featureRows(fsep.joinLedger([L()], [O({ favourable: false })]).joined);
  assert.equal(w[0].win, true);
  assert.equal(l[0].win, false);
});

// ── separating one feature ─────────────────────────────────────────────────
const mk = (value, wins, n, pts) => Array.from({ length: n }, (_, i) => ({
  features: { x: value }, win: i < wins, points: pts != null ? pts : 10,
}));

test('a group below the floor reports NO win rate at all', () => {
  const r = fsep.separateFeature(mk('a', 8, 10), 'x');
  assert.equal(r.groups[0].winRate, null);
  assert.equal(r.groups[0].ci, null);
  assert.match(r.groups[0].note, /needs 30/);
});

test('a group below the display floor is marked unshown', () => {
  const r = fsep.separateFeature(mk('a', 2, 3), 'x');
  assert.equal(r.groups[0].shown, false);
});

test('two groups with overlapping intervals are NO_EDGE however different they look', () => {
  const r = fsep.separateFeature(mk('a', 20, 40).concat(mk('b', 17, 40)), 'x');
  assert.equal(r.verdict, 'NO_EDGE');
  assert.equal(r.separation.intervalsDisjoint, false);
});

test('disjoint intervals are the only thing that CONFIRMS a feature', () => {
  const r = fsep.separateFeature(mk('a', 32, 40).concat(mk('b', 8, 40)), 'x');
  assert.equal(r.verdict, 'CONFIRMED');
  assert.equal(r.separation.best, 'a');
  assert.equal(r.separation.worst, 'b');
});

test('one group alone can never separate from anything', () => {
  assert.equal(fsep.separateFeature(mk('a', 30, 40), 'x').verdict, 'INSUFFICIENT');
});

test('expectancy is points per signal, and is withheld below the floor too', () => {
  const few = fsep.separateFeature(mk('a', 5, 10, 12), 'x');
  assert.equal(few.groups[0].expectancyPoints, null);
  const many = fsep.separateFeature(mk('a', 20, 40, 12), 'x');
  assert.equal(many.groups[0].expectancyPoints, 12);
});

test('groups are ordered by size, so the sample you actually have is first', () => {
  const r = fsep.separateFeature(mk('small', 3, 6).concat(mk('big', 20, 40)), 'x');
  assert.equal(r.groups[0].value, 'big');
});

// ── the multiple-comparison honesty ────────────────────────────────────────
test('a confirmed feature is reported WITH the number of features tested beside it', () => {
  // Testing eleven things at once means a winner is expected by chance.
  const rows = mk('a', 32, 40).concat(mk('b', 8, 40));
  for (const r of rows) r.features.y = 'same';
  const rep = fsep.separateAll(rows, { featureKeys: ['x', 'y'] });
  assert.equal(rep.tested, 2);
  assert.match(rep.summary, /2 features were tested at once/);
  assert.match(rep.summary, /not as a rule/);
});

test('no data at all says so rather than printing a tidy zero', () => {
  const rep = fsep.separateAll([]);
  assert.match(rep.summary, /No joined signals yet/);
  assert.equal(rep.confirmed.length, 0);
});

test('data with no rateable group says so, and says why', () => {
  const rep = fsep.separateAll(mk('a', 3, 6), { featureKeys: ['x'] });
  assert.match(rep.summary, /answers itself with time/);
});

test('the rep always carries the floor it used, so no caller can quote it without the bar', () => {
  assert.equal(fsep.separateAll([], {}).minSamples, 30);
});

// ── the model-readiness check ──────────────────────────────────────────────
test('a small sample is refused a trained model, with the arithmetic shown', () => {
  const s = fsep.sampleCheck(87, 11);
  assert.equal(s.ready, false);
  assert.equal(s.needed, 110);
  assert.match(s.verdict, /fit the noise/);
});

test('enough rows clears the same bar', () => {
  const s = fsep.sampleCheck(2000, 11);
  assert.equal(s.ready, true);
  assert.match(s.verdict, /held-out split/);
});

// ── against the live ledger ────────────────────────────────────────────────
test('it runs over the real signal ledger without throwing, whatever is in it', () => {
  const dir = require('node:path').join(__dirname, '..', '..', 'DATA', 'signals');
  if (!fs.existsSync(dir)) return;   // a clean checkout has no runtime data
  const files = fs.readdirSync(dir);
  const read = (f) => fs.readFileSync(require('node:path').join(dir, f), 'utf8').split('\n')
    .filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const ledger = [];
  for (const f of files.filter((f) => f.endsWith('.jsonl') && !f.includes('.outcomes') && !f.includes('.router'))) ledger.push(...read(f));
  const outcomes = [];
  for (const f of files.filter((f) => f.endsWith('.outcomes.jsonl'))) outcomes.push(...read(f));
  const rep = fsep.separateAll(fsep.featureRows(fsep.joinLedger(ledger, outcomes).joined));
  assert.ok(typeof rep.summary === 'string' && rep.summary.length > 0);
});
