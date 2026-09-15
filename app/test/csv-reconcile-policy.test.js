'use strict';
// Policy for auto-applying a broker CSV upload — 2026-09-15 (Anoop): an upload made
// while the app was NOT running must pick up the missing trades by itself, without
// ever being able to change a row that was already recorded.
const test = require('node:test');
const assert = require('node:assert');
const { decide } = require('../renderer/csv-reconcile-policy.js');

test('auto-applies when the only difference is trades the app never saw', () => {
  const v = decide({ dates: [{ date: '2026-09-14', csvOnly: 1, liveOnly: 0, disagree: 0, matched: 0, csvCount: 1 }] });
  assert.strictEqual(v.action, 'auto-apply');
  assert.strictEqual(v.added, 1);
});

test('auto-applies when the app has NO record of the day at all (server was down all day)', () => {
  const v = decide({ dates: [{ date: '2026-09-13', csvOnly: 3, liveOnly: 0, disagree: 0, matched: 0, csvCount: 3 }] });
  assert.strictEqual(v.action, 'auto-apply');
  assert.strictEqual(v.added, 3);
});

test('auto-applies when the file adds a new trade alongside ones that already match', () => {
  const v = decide({ dates: [{ date: '2026-09-14', csvOnly: 1, liveOnly: 0, disagree: 0, matched: 1, csvCount: 2 }] });
  assert.strictEqual(v.action, 'auto-apply');
  assert.strictEqual(v.matched, 1);
});

test('NEVER auto-applies when a matched trade has a different P&L — that rewrites a recorded number', () => {
  const v = decide({ dates: [{ date: '2026-09-14', csvOnly: 1, liveOnly: 0, disagree: 2, matched: 2 }] });
  assert.strictEqual(v.action, 'confirm');
});

test('NEVER auto-applies when the store holds trades the file does not mention', () => {
  const v = decide({ dates: [{ date: '2026-09-14', csvOnly: 1, liveOnly: 1, disagree: 0, matched: 0 }] });
  assert.strictEqual(v.action, 'confirm');
});

test('reports no-op when the file matches the record exactly (no pointless rewrite)', () => {
  const v = decide({ dates: [{ date: '2026-09-14', csvOnly: 0, liveOnly: 0, disagree: 0, matched: 2, csvCount: 2 }] });
  assert.strictEqual(v.action, 'no-op');
});

test('an empty upload is a no-op, not a confirm', () => {
  assert.strictEqual(decide({ dates: [] }).action, 'no-op');
  assert.strictEqual(decide({}).action, 'no-op');
  assert.strictEqual(decide(null).action, 'no-op');
});

test('counts aggregate across multiple dates in one file', () => {
  const v = decide({
    dates: [
      { date: '2026-09-13', csvOnly: 2, liveOnly: 0, disagree: 0 },
      { date: '2026-09-14', csvOnly: 1, liveOnly: 0, disagree: 0 },
    ],
  });
  assert.strictEqual(v.action, 'auto-apply');
  assert.strictEqual(v.added, 3);
});

test('one disagreeing day among additive days still forces the confirm card', () => {
  const v = decide({
    dates: [
      { date: '2026-09-13', csvOnly: 2, liveOnly: 0, disagree: 0 },
      { date: '2026-09-14', csvOnly: 0, liveOnly: 0, disagree: 1, matched: 1 },
    ],
  });
  assert.strictEqual(v.action, 'confirm');
});
