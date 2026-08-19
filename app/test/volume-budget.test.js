'use strict';
/**
 * Tests for volume-budget.js — the contracts-per-day cap.
 *
 * The final block replays Anoop's five real logged days, because the entire
 * justification for this rule is that his own data splits on it. If the code
 * doesn't reproduce that split, the rule is wrong.
 */
const test = require('node:test');
const assert = require('node:assert');
const { volumeStatus, wouldBreach, contractsUsed } = require('../renderer/volume-budget');

const CFG = { enabled: true, max: 12, warnAtPct: 75 };

// ── volumeStatus ─────────────────────────────────────────────────────────────
test('well under the cap reads OK with room left', () => {
  const s = volumeStatus(4, CFG);
  assert.strictEqual(s.level, 'ok');
  assert.strictEqual(s.remaining, 8);
});

test('at 75% it WARNS and cites the green-day size', () => {
  const s = volumeStatus(9, CFG);
  assert.strictEqual(s.level, 'warn');
  assert.strictEqual(s.pctUsed, 75);
  assert.match(s.text, /10-11 contracts/);
});

test('hitting the cap STOPS', () => {
  const s = volumeStatus(12, CFG);
  assert.strictEqual(s.level, 'stop');
  assert.strictEqual(s.remaining, 0);
});

test('overshooting still STOPS and never reports negative room', () => {
  const s = volumeStatus(29, CFG);
  assert.strictEqual(s.level, 'stop');
  assert.strictEqual(s.remaining, 0);
  assert.strictEqual(s.pctUsed, 242);
});

test('disabled in rules.json never blocks', () => {
  assert.strictEqual(volumeStatus(100, { ...CFG, enabled: false }).level, 'ok');
});

test('a zero/missing cap is treated as off, not as "instantly breached"', () => {
  assert.strictEqual(volumeStatus(5, { enabled: true, max: 0 }).level, 'ok');
  assert.strictEqual(volumeStatus(5, {}).level, 'ok');
});

test('negative/garbage input does not produce a false STOP', () => {
  assert.strictEqual(volumeStatus(-5, CFG).level, 'ok');
  assert.strictEqual(volumeStatus(NaN, CFG).level, 'ok');
});

// ── wouldBreach — the pre-trade question ─────────────────────────────────────
test('a 2-lot at 10 used WOULD breach a cap of 12? no — it lands exactly on it', () => {
  const r = wouldBreach(10, 2, CFG);
  assert.strictEqual(r.breach, false, '12 is allowed; 13 is not');
  assert.strictEqual(r.projected, 12);
});

test('a 2-lot at 11 used DOES breach', () => {
  const r = wouldBreach(11, 2, CFG);
  assert.strictEqual(r.breach, true);
  assert.match(r.text, /past your 12 cap/);
});

test('the 08-10 9-lot would have been refused outright', () => {
  // by that point in the day he had already traded 3+1+1 = 5 contracts
  const r = wouldBreach(5, 9, CFG);
  assert.strictEqual(r.breach, true);
  assert.strictEqual(r.projected, 14);
});

test('wouldBreach is inert when the cap is disabled', () => {
  assert.strictEqual(wouldBreach(50, 20, { ...CFG, enabled: false }).breach, false);
});

// ── contractsUsed ────────────────────────────────────────────────────────────
test('sums sizes across a day, ignoring sign', () => {
  assert.strictEqual(contractsUsed([{ size: 1 }, { size: 3 }, { size: -9 }]), 13);
});

test('tolerates empty/garbage trade lists', () => {
  assert.strictEqual(contractsUsed([]), 0);
  assert.strictEqual(contractsUsed(null), 0);
  assert.strictEqual(contractsUsed([{}, { size: 'x' }]), 0);
});

// ── replay of the five real days ─────────────────────────────────────────────
test("REPLAY: both profitable days pass the cap untouched", () => {
  // The honest version of the claim. 08-05 (12 contracts, -$142) lands EXACTLY
  // on the cap and therefore stops — which is the correct outcome, not a false
  // positive: it ends a losing day at -$142 instead of letting it run. The
  // split is at the boundary, not side-of-boundary, and the test says so.
  assert.notStrictEqual(volumeStatus(10, CFG).level, 'stop', '08-06 (+$440) must not be blocked');
  assert.notStrictEqual(volumeStatus(11, CFG).level, 'stop', '08-07 (+$157.50) must not be blocked');
});

test('REPLAY: the boundary day stops AT the cap, ending a small loss early', () => {
  const s = volumeStatus(12, CFG); // 2026-08-05, -$142
  assert.strictEqual(s.level, 'stop');
  assert.strictEqual(s.remaining, 0);
});

test('REPLAY: both account-damaging days are stopped LONG before they finished', () => {
  // 08-10 finished at 24 contracts / -$879.50 and 08-11 at 29 / -$572.50.
  // What matters is not that the cap catches the final number, but that it
  // would have fired at 12 — less than half way through each day's volume.
  for (const [contracts, pnl] of [[24, -879.5], [29, -572.5]]) {
    assert.strictEqual(volumeStatus(12, CFG).level, 'stop',
      `would have stopped at 12 of the eventual ${contracts} contracts ($${pnl})`);
    assert.ok(contracts > 12 * 1.9, 'these days ran to roughly double the cap or more');
  }
});

test('REPLAY: the cap would have caught both big losing days and neither green day', () => {
  const stopped = [10, 11, 12, 24, 29].filter(c => volumeStatus(c, CFG).level === 'stop');
  assert.deepStrictEqual(stopped, [12, 24, 29],
    'the two -$800/-$572 days are caught; the +$440 and +$157 days are not');
});
