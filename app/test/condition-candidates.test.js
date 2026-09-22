'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cond = require('../condition-candidates');

// rows: {features:{...}, win, points, date}
const row = (f, win, pts, date) => ({ features: f, win: !!win, points: pts != null ? pts : 10, date: date || null });
const many = (n, f, wins, pts, date) => Array.from({ length: n }, (_, i) => row(f, i < wins, pts, date));

// ── candidate generation ───────────────────────────────────────────────────
test('a value that matches EVERY row is not a condition — it is the baseline', () => {
  const rows = many(20, { s: 'NY' }, 10);
  const made = cond.makeConditions(rows, { minSupport: 5 });
  assert.equal(made.conditions.length, 0);
});

test('a value below the support floor is never a candidate', () => {
  const rows = many(20, { s: 'NY' }, 10).concat(many(2, { s: 'London' }, 1));
  const made = cond.makeConditions(rows, { minSupport: 5 });
  assert.equal(made.conditions.some((c) => c.pairs[0].value === 'London'), false);
});

test('pairs are generated across features but never within one', () => {
  // Rows must share a schema, exactly as feature-separation.featureRows builds
  // them — a row carrying only its own key makes every other feature look
  // 'undefined', which was a real bug this test caught.
  const rows = many(20, { s: 'NY', t: '15' }, 10)
    .concat(many(20, { s: 'London', t: '15' }, 5))
    .concat(many(20, { s: 'NY', t: '30' }, 12))
    .concat(many(20, { s: 'London', t: '30' }, 9));
  const made = cond.makeConditions(rows, { minSupport: 5 });
  for (const c of made.conditions) {
    if (c.arity === 2) assert.notEqual(c.pairs[0].key, c.pairs[1].key);
  }
  assert.ok(made.conditions.some((c) => c.arity === 2), 'a valid pair must be generated');
});

test('a feature missing from some rows never becomes an undefined candidate', () => {
  // The phantom group: every row lacking the key buckets together, and that
  // bucket then looks like the best-supported condition in the whole table.
  const rows = many(30, { s: 'NY' }, 15).concat(many(30, { s: 'London', t: '15' }, 15));
  const made = cond.makeConditions(rows, { minSupport: 5 });
  for (const c of made.conditions) {
    for (const p of c.pairs) assert.notEqual(p.value, undefined, 'no condition may be built on a missing key');
  }
});

test('the pairwise sweep is bounded, and says when it was cut short', () => {
  // A SHARED schema, as the real feature table has: every row carries every key.
  const rows = [];
  for (let j = 0; j < 24; j++) {
    const f = {};
    for (let i = 0; i < 12; i++) f['f' + i] = (j % 2 === 0) ? 'a' : 'b';
    rows.push(row(f, j % 3 === 0));
  }
  const made = cond.makeConditions(rows, { minSupport: 5, maxPairs: 20 });
  assert.ok(made.pairsTested <= 20, 'the bound applies to PAIRS, got ' + made.pairsTested);
  assert.equal(made.truncated, true);
  assert.ok(made.singles > 0, 'singles are never dropped by the pair bound');
});

// ── the sample floor ───────────────────────────────────────────────────────
test('a condition with too few matches reports NO rate at all', () => {
  const rows = many(40, { s: 'NY' }, 20).concat(many(9, { s: 'London' }, 7));
  const m = cond.measureCondition(rows, { pairs: [{ key: 's', value: 'London' }], arity: 1 });
  assert.equal(m.verdict, 'INSUFFICIENT');
  assert.equal(m.winRate, null);
  assert.equal(m.ci, null);
  assert.match(m.note, /30 are needed/);
});

// ── ELIGIBLE means the WHOLE interval above baseline ───────────────────────
test('a condition whose whole interval sits above the baseline is ELIGIBLE', () => {
  // baseline 30/70 = 43%; the condition wins 32/40 and its lower bound clears 43%.
  const rows = many(70, { s: 'NY' }, 30).concat(many(40, { s: 'London' }, 32));
  const m = cond.measureCondition(rows, { pairs: [{ key: 's', value: 'London' }], arity: 1 });
  assert.equal(m.verdict, 'ELIGIBLE');
  assert.ok(m.ci.lo > m.baseline);
  assert.match(m.note, /whole interval sits above the baseline/);
});

test('a higher point estimate with an overlapping interval is only PROMISING', () => {
  const rows = many(40, { s: 'NY' }, 18).concat(many(40, { s: 'London' }, 23));
  const m = cond.measureCondition(rows, { pairs: [{ key: 's', value: 'London' }], arity: 1 });
  assert.equal(m.verdict, 'PROMISING');
  assert.match(m.note, /consistent with average/);
});

test('the baseline is the sample own rate, and lift is reported against it', () => {
  const rows = many(50, { s: 'NY' }, 10).concat(many(50, { s: 'London' }, 40));
  const m = cond.measureCondition(rows, { pairs: [{ key: 's', value: 'London' }], arity: 1 });
  assert.equal(m.baseline, 0.5);
  assert.ok(m.lift > 0.2);
});

// ── the temporal confound (found on the real ledger) ───────────────────────
test('a condition whose matches all sit on one side of a recording change is flagged', () => {
  // The real ledger did exactly this: htfBias split 39% vs 62% because the field
  // only started being recorded on 2026-09-03. Both groups are whole eras.
  // many(n, f, wins, POINTS, DATE) — the first version of this test passed the
  // date as `pts`, so no row had a date and the confound could never fire.
  const rows = many(40, { htf: 'null' }, 25, 10, '2026-09-10').concat(many(40, { htf: 'not-recorded' }, 10, 10, '2026-08-20'));
  const rep = cond.rankConditions(rows, { featureKeys: ['htf'], minSupport: 8, splitDate: '2026-09-01' });
  const old = rep.conditions.find((c) => c.key === 'htf=not-recorded');
  assert.equal(old.timeConfounded, true, 'an era-bound match must be flagged');
  assert.deepEqual(old.dateSpan, { first: '2026-08-20', last: '2026-08-20', dated: 40 });
});

test('a confounded condition is demoted out of ELIGIBLE even if its interval clears', () => {
  const rows = many(60, { htf: 'yes' }, 15, 10, '2026-08-01').concat(many(60, { htf: 'no' }, 45, 10, '2026-09-10'));
  const rep = cond.rankConditions(rows, { featureKeys: ['htf'], minSupport: 8, splitDate: '2026-09-01' });
  for (const c of rep.conditions) {
    if (c.timeConfounded) assert.notEqual(c.verdict, 'ELIGIBLE', c.key + ' must not be eligible while confounded');
  }
});

test('a condition spread across both eras keeps its verdict', () => {
  const rows = many(30, { s: 'London' }, 24, 10, '2026-08-10').concat(many(30, { s: 'London' }, 24, 10, '2026-09-10'))
    .concat(many(60, { s: 'NY' }, 20, 10, '2026-09-01'));
  const rep = cond.rankConditions(rows, { featureKeys: ['s'], minSupport: 8, splitDate: '2026-09-01' });
  const lon = rep.conditions.find((c) => c.key === 's=London');
  assert.equal(lon.timeConfounded, false);
});

// ── the summary's honesty about multiple comparisons ───────────────────────
test('the number of conditions tested is reported beside every result', () => {
  const rows = many(70, { s: 'NY' }, 30).concat(many(40, { s: 'London' }, 32));
  const rep = cond.rankConditions(rows, { featureKeys: ['s'], minSupport: 8 });
  assert.ok(rep.tested >= 1);
  assert.match(rep.summary, /were tested at once/);
  assert.match(rep.summary, /not a rule/);
});

test('no data says so rather than printing a tidy zero', () => {
  const rep = cond.rankConditions([], {});
  assert.match(rep.summary, /No joined signals yet/);
});

test('nothing rateable says so, and names the floor', () => {
  const rows = many(10, { s: 'NY' }, 5).concat(many(9, { s: 'London' }, 4));
  const rep = cond.rankConditions(rows, { featureKeys: ['s'], minSupport: 8 });
  assert.equal(rep.eligible.length, 0);
  assert.match(rep.summary, /none has the 30 matches/);
  assert.equal(rep.minSamples, 30);
});

// ── the gate: default ALLOW ────────────────────────────────────────────────
test('with no condition armed the gate allows everything — today s behaviour', () => {
  const g = cond.gate([], { s: 'NY' });
  assert.equal(g.allowed, true);
  assert.match(g.reason, /no condition is armed/);
});

test('a condition that exists but is NOT armed does not gate', () => {
  const g = cond.gate([{ key: 's=London', pairs: [{ key: 's', value: 'London' }], armed: false }], { s: 'NY' });
  assert.equal(g.allowed, true);
});

test('an armed condition admits a matching signal and refuses a non-matching one', () => {
  const armed = [{ key: 's=London', pairs: [{ key: 's', value: 'London' }], armed: true }];
  assert.equal(cond.gate(armed, { s: 'London' }).allowed, true);
  const not = cond.gate(armed, { s: 'NY' });
  assert.equal(not.allowed, false);
  assert.match(not.reason, /no armed condition matched/);
});

test('gate never throws on junk', () => {
  for (const bad of [null, undefined, 'x', {}]) {
    assert.doesNotThrow(() => cond.gate(bad, null));
    assert.equal(cond.gate(bad, null).allowed, true);
  }
});
