const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const F = require('../account-floor.js');

const EVAL = { start: 50000, maxDrawdown: 2000, floorLocksAt: 50100 };

// ── THE REAL CASE ───────────────────────────────────────────────────────────
// s1's ten closed days. The archive records it BREACHED on 2026-08-29 at a
// balance of $49,594.66, so the floor on that morning must be just under it.
test('REPLAY s1: reproduces the floor the account actually breached against', () => {
  const R = path.join(__dirname, '..', '..', 'DATA', '_recovered_20260904', 's1_breached_20260829_balance_ledger.json');
  if (!fs.existsSync(R)) return;   // recovered data absent — skip quietly
  const ledger = JSON.parse(fs.readFileSync(R, 'utf8'));
  const nets = Object.keys(ledger).sort().map((d) => ledger[d].net);

  const r = F.computeTrailingFloor({ ...EVAL, dailyNets: nets });
  assert.strictEqual(r.peakBalance, 51585.22, 'peak EOD balance was 2026-08-25');
  assert.strictEqual(r.floor, 49585.22, 'the floor s1 actually died against');
  assert.strictEqual(r.balanceAfterClosedDays, 49594.66, 'matches the archived breach balance');

  // The $9.44 that ended six months of work.
  const h = F.floorAndHeadroom({ ...EVAL, dailyNets: nets, liveBalance: 49594.66 });
  assert.strictEqual(h.headroom, 9.44);
});

// ── The mechanic ────────────────────────────────────────────────────────────
test('a fresh account starts one full drawdown above the floor', () => {
  const r = F.computeTrailingFloor({ ...EVAL, dailyNets: [] });
  assert.strictEqual(r.floor, 48000);
  assert.strictEqual(r.locked, false);
});

test('the floor ratchets UP with a new peak and never comes back down', () => {
  const up = F.computeTrailingFloor({ ...EVAL, dailyNets: [1000] });
  assert.strictEqual(up.floor, 49000);
  // give it all back — the floor must NOT follow
  const back = F.computeTrailingFloor({ ...EVAL, dailyNets: [1000, -1000] });
  assert.strictEqual(back.floor, 49000, 'a losing day cannot lower the floor');
});

// The insight nothing in the app surfaces: below $52,100 headroom is pinned at
// $2,000 however well he trades, because the floor climbs with him.
test('below the lock, headroom is pinned at exactly the drawdown', () => {
  for (const gain of [0, 500, 1000, 1585.22, 2000]) {
    const h = F.floorAndHeadroom({ ...EVAL, dailyNets: [gain], liveBalance: 50000 + gain });
    assert.strictEqual(h.headroom, 2000, 'gain of ' + gain + ' still leaves exactly $2,000');
  }
});

test('at $52,100 the floor locks and headroom finally grows', () => {
  assert.strictEqual(F.headroomUnlockBalance(EVAL), 52100);
  const at = F.floorAndHeadroom({ ...EVAL, dailyNets: [2100], liveBalance: 52100 });
  assert.strictEqual(at.floor, 50100);
  assert.strictEqual(at.locked, true);
  assert.strictEqual(at.headroom, 2000);
  const past = F.floorAndHeadroom({ ...EVAL, dailyNets: [3000], liveBalance: 53000 });
  assert.strictEqual(past.floor, 50100, 'floor stops trailing at the lock');
  assert.strictEqual(past.headroom, 2900, 'headroom now grows with the balance');
});

test('intraday balance does not move the floor — only closed days do', () => {
  const nets = [1000];
  const a = F.floorAndHeadroom({ ...EVAL, dailyNets: nets, liveBalance: 51500 });
  const b = F.floorAndHeadroom({ ...EVAL, dailyNets: nets, liveBalance: 49200 });
  assert.strictEqual(a.floor, b.floor, 'same closed days → same floor');
  assert.strictEqual(b.headroom, 200, 'only the headroom moves intraday');
});

test('a live balance below the floor reports negative headroom, not zero', () => {
  const h = F.floorAndHeadroom({ ...EVAL, dailyNets: [1000], liveBalance: 48800 });
  assert.strictEqual(h.headroom, -200, 'already breached must read as breached');
});

// ── Failing safe ────────────────────────────────────────────────────────────
test('bad inputs return null rather than a confident wrong floor', () => {
  assert.strictEqual(F.computeTrailingFloor({}).floor, null);
  assert.strictEqual(F.computeTrailingFloor({ start: 50000 }).floor, null);
  assert.strictEqual(F.computeTrailingFloor({ start: 50000, maxDrawdown: 0 }).floor, null);
  assert.strictEqual(F.computeTrailingFloor(null).floor, null);
  assert.strictEqual(F.headroomUnlockBalance({}), null);
});

test('an unreadable live balance gives a floor but no headroom', () => {
  const h = F.floorAndHeadroom({ ...EVAL, dailyNets: [1000], liveBalance: null });
  assert.strictEqual(h.floor, 49000);
  assert.strictEqual(h.headroom, null, 'never guess headroom from a missing balance');
});

test('a corrupt ledger row is skipped, not treated as zero-and-continue-wrong', () => {
  const r = F.computeTrailingFloor({ ...EVAL, dailyNets: [1000, null, 'x', 500] });
  assert.strictEqual(r.balanceAfterClosedDays, 51500);
  assert.strictEqual(r.floor, 49500);
});

test('floorLocksAt defaults to start + 100 when the rules omit it', () => {
  const r = F.computeTrailingFloor({ start: 50000, maxDrawdown: 2000, dailyNets: [5000] });
  assert.strictEqual(r.floor, 50100);
});
