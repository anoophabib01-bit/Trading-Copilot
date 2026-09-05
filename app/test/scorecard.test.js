'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeScorecard } = require('../renderer/scorecard.js');

test('empty inputs → all-zero buckets', () => {
  const s = computeScorecard([], []);
  assert.equal(s.byPlaybook.A.fired, 0);
  assert.equal(s.backed.count, 0);
});

test('fires/rejections/decisions land in the right buckets', () => {
  const signals = [
    { event: 'engulf-fire', playbook: 'A', valid: true },
    { event: 'playbook-c-reject', playbook: 'C', valid: false },
    { event: 'playbook-b-confirm', playbook: 'B', valid: true },
    { event: 'signal-decision', playbook: 'B', decision: 'took' },
    { event: 'signal-decision', playbook: 'A', decision: 'passed' },
    { event: 'signal-expired', playbook: 'C' },
    { event: 'po3-phase-change', playbook: 'PO3', valid: true },
  ];
  const s = computeScorecard([], signals);
  assert.equal(s.byPlaybook.A.fired, 1);
  assert.equal(s.byPlaybook.A.passed, 1);
  assert.equal(s.byPlaybook.B.fired, 1);
  assert.equal(s.byPlaybook.B.taken, 1);
  assert.equal(s.byPlaybook.C.rejected, 1);
  assert.equal(s.byPlaybook.C.ignored, 1);
  assert.equal(s.byPlaybook.PO3.fired, 1);
});

test('signal-backed vs freestyle split and per-playbook win math', () => {
  const rows = [
    { pnl: 40, signalBacked: true, playbook: 'A' },
    { pnl: -20, signalBacked: true, playbook: 'A' },
    { pnl: -50, signalBacked: false },
  ];
  const s = computeScorecard(rows, []);
  assert.equal(s.backed.count, 2);
  assert.equal(s.backed.wins, 1);
  assert.equal(s.backed.losses, 1);
  assert.equal(s.freestyle.count, 1);
  assert.equal(s.freestyle.losses, 1);
  assert.equal(s.byPlaybook.A.wins, 1);
  assert.equal(s.byPlaybook.A.losses, 1);
  assert.equal(s.byPlaybook.A.winPct, 50);
  assert.equal(s.byPlaybook.A.avgR, 2); // 40 / |−20|
  assert.equal(s.byPlaybook.A.net, 20);
});

test('avgR is null without a loss (no division by zero)', () => {
  const s = computeScorecard([{ pnl: 10, signalBacked: true, playbook: 'A' }], []);
  assert.equal(s.byPlaybook.A.winPct, 100);
  assert.equal(s.byPlaybook.A.avgR, null);
});

// ── ALERTS COUNT AS FIRED, NOT AS VALID (2026-09-03) ────────────────────────
// Playbook A alerts on every closed engulfing in both directions and arms only
// the ones that pass the full check, under two event names. The scorecard's
// two columns already mean exactly the two things: `fired` is what the app
// told him about, `valid` is what passed. Leaving engulf-alert out would have
// the panel report 1 fire on a day he was shown 3 — the surface whose job is
// to say whether the app is working, understating the app.
test('engulf-alert counts as fired but never as valid', () => {
  const s = computeScorecard([], [
    { event: 'engulf-fire', playbook: 'A', valid: true },
    { event: 'engulf-alert', playbook: 'A', valid: false },
    { event: 'engulf-alert', playbook: 'A', valid: false },
  ]);
  assert.equal(s.byPlaybook.A.fired, 3, 'he was shown three candles');
  assert.equal(s.byPlaybook.A.valid, 1, 'only one was a full Playbook A setup');
});
