'use strict';
/**
 * Unit tests for loss-ratchet.js.
 *
 * This decides when Anoop is told to stop on a live funded account, so the
 * edge cases matter more than the happy path — particularly the one where the
 * rule as originally described would have LOOSENED risk after a big green day.
 */
const test = require('node:test');
const assert = require('node:assert');
const { computeCap, statusFor } = require('../renderer/loss-ratchet');

const CFG = { enabled: true, mode: 'min', floor: 100, warnAtPct: 50 };
const BASE = 200; // funded dayStop

// ── computeCap ───────────────────────────────────────────────────────────────
test('THE KEY CASE: a big green day does NOT loosen tomorrow', () => {
  // $800 profit yesterday. The naive rule would allow an $800 loss today — 4x
  // the $200 rule, exactly after the good day that precedes a blow-up.
  const c = computeCap(800, BASE, CFG);
  assert.strictEqual(c.cap, 200, 'cap must stay at the base stop, not rise to 800');
  assert.strictEqual(c.tightened, false);
});

test('a small green day TIGHTENS tomorrow below the normal stop', () => {
  const c = computeCap(120, BASE, CFG);
  assert.strictEqual(c.cap, 120);
  assert.strictEqual(c.tightened, true);
  assert.match(c.reason, /may not lose more than \$120/);
});

test('the floor stops a tiny green day making tomorrow untradeable', () => {
  const c = computeCap(20, BASE, CFG);
  assert.strictEqual(c.cap, 100, 'floor of 100 applies, not 20');
});

test('a RED yesterday leaves the normal stop in force (never zero)', () => {
  const c = computeCap(-855, BASE, CFG);
  assert.strictEqual(c.cap, 200);
  assert.strictEqual(c.source, 'dayStop');
  assert.match(c.reason, /not green/);
});

test('a FLAT yesterday leaves the normal stop in force', () => {
  assert.strictEqual(computeCap(0, BASE, CFG).cap, 200);
});

test('disabled in rules.json falls back to the plain daily stop', () => {
  const c = computeCap(120, BASE, { ...CFG, enabled: false });
  assert.strictEqual(c.cap, 200);
  assert.strictEqual(c.tightened, false);
});

test("mode 'raw' honours the literal original phrasing (documented, not recommended)", () => {
  assert.strictEqual(computeCap(800, BASE, { ...CFG, mode: 'raw' }).cap, 800);
});

test('capNegative is the signed form the HUD compares against', () => {
  assert.strictEqual(computeCap(120, BASE, CFG).capNegative, -120);
});

// ── statusFor ────────────────────────────────────────────────────────────────
test('under the warn threshold reads OK', () => {
  const cap = computeCap(120, BASE, CFG);
  const s = statusFor(-30, cap, CFG);
  assert.strictEqual(s.level, 'ok');
  assert.strictEqual(s.remaining, 90);
});

test('at 50% of the cap it WARNS, naming the giveback', () => {
  const cap = computeCap(120, BASE, CFG);
  const s = statusFor(-60, cap, CFG);
  assert.strictEqual(s.level, 'warn');
  assert.strictEqual(s.pctUsed, 50);
  assert.match(s.text, /given back/);
});

test('reaching the cap STOPS and says yesterday is undone', () => {
  const cap = computeCap(120, BASE, CFG);
  const s = statusFor(-120, cap, CFG);
  assert.strictEqual(s.level, 'stop');
  assert.strictEqual(s.remaining, 0);
  assert.match(s.text, /all of yesterday's \$120 profit/);
});

test('overshooting the cap still reads STOP, never negative remaining', () => {
  const s = statusFor(-500, computeCap(120, BASE, CFG), CFG);
  assert.strictEqual(s.level, 'stop');
  assert.strictEqual(s.remaining, 0);
});

test('a green day so far is OK with full room', () => {
  const s = statusFor(150, computeCap(120, BASE, CFG), CFG);
  assert.strictEqual(s.level, 'ok');
  assert.strictEqual(s.lost, 0);
  assert.strictEqual(s.remaining, 120);
});

test('non-ratcheted days get plain wording, not giveback wording', () => {
  const cap = computeCap(-100, BASE, CFG); // red yesterday -> base stop
  assert.match(statusFor(-200, cap, CFG).text, /hit your \$200 daily limit/);
});

// ── the real 2026-08-10 scenario ─────────────────────────────────────────────
test('replay 08-10: -$855.50 against a $200 cap stops immediately', () => {
  const cap = computeCap(-130, BASE, CFG); // 08-05 was red, so base applies
  const s = statusFor(-855.50, cap, CFG);
  assert.strictEqual(s.level, 'stop');
  assert.strictEqual(s.cap, 200);
});
