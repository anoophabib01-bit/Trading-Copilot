const test = require('node:test');
const assert = require('node:assert');
const SA = require('../renderer/stop-alarm.js');

// ── Escalation cadence ───────────────────────────────────────────────────

test('phase 1 (reps 0-3) uses the 30s cadence, matching the existing TV-disconnect alarm', () => {
  assert.strictEqual(SA.nextAlarmDelayMs(0), 30000);
  assert.strictEqual(SA.nextAlarmDelayMs(3), 30000);
  assert.strictEqual(SA.alarmPhase(0), 1);
  assert.strictEqual(SA.alarmPhase(3), 1);
});

test('phase 2 (rep 4+) tightens to 15s — genuinely escalating, not just repeating', () => {
  assert.strictEqual(SA.nextAlarmDelayMs(4), 15000);
  assert.strictEqual(SA.nextAlarmDelayMs(29), 15000);
  assert.strictEqual(SA.alarmPhase(4), 2);
});

test('THE POINT OF ESCALATION: phase 2 is strictly faster than phase 1', () => {
  assert.ok(SA.nextAlarmDelayMs(10) < SA.nextAlarmDelayMs(0));
});

// ── shouldContinueAlarm — the safety cap ────────────────────────────────

test('the alarm stops itself well before it would run forever unattended', () => {
  assert.strictEqual(SA.shouldContinueAlarm(0), true);
  assert.strictEqual(SA.shouldContinueAlarm(SA.CONST.MAX_REPEATS - 1), true);
  assert.strictEqual(SA.shouldContinueAlarm(SA.CONST.MAX_REPEATS), false);
  assert.strictEqual(SA.shouldContinueAlarm(SA.CONST.MAX_REPEATS + 5), false);
});

test('the alarm cap is a real safety bound, not accidentally infinite (garbage never continues)', () => {
  assert.strictEqual(SA.shouldContinueAlarm(NaN), false);
  assert.strictEqual(SA.shouldContinueAlarm(Infinity), false);
  assert.strictEqual(SA.shouldContinueAlarm(null), false);
  assert.strictEqual(SA.shouldContinueAlarm(undefined), false);
  assert.strictEqual(SA.shouldContinueAlarm('nonsense'), false);
});

// ── ackDelayRemainingMs — the mandatory pause, and its fail-open guarantee ─

test('immediately after the stop, the full delay remains', () => {
  const t = 1_000_000;
  assert.strictEqual(SA.ackDelayRemainingMs(t, t), SA.CONST.ACK_DELAY_MS);
});

test('the delay counts down to exactly zero, never negative', () => {
  const t = 1_000_000;
  assert.strictEqual(SA.ackDelayRemainingMs(t, t + SA.CONST.ACK_DELAY_MS), 0);
  assert.strictEqual(SA.ackDelayRemainingMs(t, t + SA.CONST.ACK_DELAY_MS + 5000), 0, 'must never go negative');
});

test('midway through the delay, the remaining time is correct', () => {
  const t = 1_000_000;
  assert.strictEqual(SA.ackDelayRemainingMs(t, t + 3000), SA.CONST.ACK_DELAY_MS - 3000);
});

test('THE FAIL-OPEN GUARANTEE: a missing/garbage trigger timestamp never traps him behind the delay', () => {
  // This app's established philosophy (checklist gate, journey guards) is:
  // corrupt/missing state must never be the thing that locks him out. A stop
  // triggered before this feature existed, or with a corrupted stoppedAt,
  // must unlock immediately rather than becoming a permanent 8-second (or
  // NaN-forever) trap.
  assert.strictEqual(SA.ackDelayRemainingMs(null, Date.now()), 0);
  assert.strictEqual(SA.ackDelayRemainingMs(undefined, Date.now()), 0);
  assert.strictEqual(SA.ackDelayRemainingMs('nonsense', Date.now()), 0);
  assert.strictEqual(SA.ackDelayRemainingMs(NaN, Date.now()), 0);
  assert.strictEqual(SA.ackDelayRemainingMs(1000, NaN), 0);
  assert.strictEqual(SA.ackDelayRemainingMs(1000, undefined), 0);
});

test('the delay is a real, deliberate pause — not near-zero and not longer than a minute', () => {
  // Guards against a future casual edit accidentally making this either a
  // no-op (defeats the purpose) or genuinely punitive (violates the
  // never-trap-him rule this whole codebase holds elsewhere).
  assert.ok(SA.CONST.ACK_DELAY_MS >= 5000, 'too short to interrupt a reflexive dismiss');
  assert.ok(SA.CONST.ACK_DELAY_MS <= 60000, 'must never approach feeling like a lockout');
});
