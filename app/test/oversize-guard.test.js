'use strict';
// ── OVERSIZE GUARD tests ───────────────────────────────────────────────────
// This is the first code in the app that can move real money without being
// asked, so the tests are written around what it must REFUSE to do, not what
// it does. Grounded in 2026-08-28: a size-5 short against a 2-lot cap lost
// $1,322 — 66% of the entire $2,000 drawdown a 50K Select evaluation gets.
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, rollDay, DEFAULTS } = require('../oversize-guard.js');

const CFG = { enabled: true, sizeCap: 2, confirmReads: 2, maxPerDay: 6, cooldownMs: 30000 };
const S0 = { confirmCount: 0, lastActionAt: 0, actionsToday: 0, lastSeenSize: null };
// Two polls at the same size = confirmed.
const twice = (pos, cfg, st) => {
  const a = evaluate(pos, st || S0, cfg || CFG, 1000);
  return evaluate(pos, a.state, cfg || CFG, 6000);
};

// ── the case it exists for ─────────────────────────────────────────────────
test("today's size-5 short reduces by 3, leaving the 2-lot cap", () => {
  const r = twice({ size: 5, side: 'SHORT' });
  assert.strictEqual(r.act, true);
  assert.strictEqual(r.reduceBy, 3);
  assert.strictEqual(r.side, 'buy', 'buying reduces a short');
  assert.match(r.reason, /over the 2 cap/);
});

test('an oversized LONG is reduced by selling', () => {
  const r = twice({ size: 5, side: 'LONG' });
  assert.strictEqual(r.act, true);
  assert.strictEqual(r.side, 'sell');
  assert.strictEqual(r.reduceBy, 3);
});

test('a position AT the cap is left alone', () => {
  assert.strictEqual(twice({ size: 2, side: 'LONG' }).act, false);
  assert.strictEqual(twice({ size: 1, side: 'LONG' }).act, false);
});

// ── what it must REFUSE ────────────────────────────────────────────────────
test('ONE reading is never enough — a single misread cannot act', () => {
  const r = evaluate({ size: 5, side: 'SHORT' }, S0, CFG, 1000);
  assert.strictEqual(r.act, false);
  assert.match(r.reason, /1\/2/);
});

test('UNREADABLE size does nothing — unknown is not zero', () => {
  // The fold logged size:0 four times on 2026-08-28 while real positions of
  // 1, 2, 3 and 5 lots were open. Acting on that is acting blind.
  for (const bad of [0, null, undefined, NaN, 'x', {}]) {
    const r = twice({ size: bad, side: 'SHORT' });
    assert.strictEqual(r.act, false, `size ${JSON.stringify(bad)} must not act`);
  }
  assert.match(twice({ size: 0, side: 'SHORT' }).reason, /not readable/);
});

test('an UNREADABLE SIDE does nothing — guessing would OPEN a position', () => {
  const r = twice({ size: 5, side: null });
  assert.strictEqual(r.act, false);
  assert.match(r.reason, /side not readable/);
});

test('a position that is still SCALING is not acted on mid-scale', () => {
  // 3 then 5 is a moving number, not a confirmed oversize. Acting at 3 would
  // sell contracts the next poll would have justified.
  let s = S0;
  let r = evaluate({ size: 3, side: 'LONG' }, s, CFG, 1000);
  assert.strictEqual(r.act, false);
  r = evaluate({ size: 5, side: 'LONG' }, r.state, CFG, 6000);
  assert.strictEqual(r.act, false, 'the size changed — confirmation restarts');
  r = evaluate({ size: 5, side: 'LONG' }, r.state, CFG, 11000);
  assert.strictEqual(r.act, true, 'two polls at the SAME size confirms');
  assert.strictEqual(r.reduceBy, 3);
});

test('the order can NEVER flip or exceed the position', () => {
  // The property that makes this incapable of opening a trade.
  for (let size = 3; size <= 40; size++) {
    for (const side of ['LONG', 'SHORT']) {
      const r = twice({ size, side });
      if (!r.act) continue;
      assert.ok(r.reduceBy > 0, `reduceBy must be positive (size ${size})`);
      assert.ok(r.reduceBy < size, `reduceBy ${r.reduceBy} must be less than the position ${size}`);
      assert.strictEqual(size - r.reduceBy, CFG.sizeCap, 'what remains is exactly the cap');
      assert.strictEqual(r.side, side === 'LONG' ? 'sell' : 'buy', 'always the CLOSING direction');
    }
  }
});

test('disabled does nothing at all', () => {
  assert.strictEqual(twice({ size: 20, side: 'LONG' }, Object.assign({}, CFG, { enabled: false })).act, false);
});

test('a missing or nonsense cap does nothing rather than assuming one', () => {
  for (const cap of [null, 0, -1, NaN, 'x']) {
    assert.strictEqual(twice({ size: 20, side: 'LONG' }, Object.assign({}, CFG, { sizeCap: cap })).act, false);
  }
});

// ── runaway protection ─────────────────────────────────────────────────────
test('cooldown stops it firing again while the first order is still filling', () => {
  const first = twice({ size: 5, side: 'SHORT' });
  assert.strictEqual(first.act, true);
  const soon = evaluate({ size: 5, side: 'SHORT' }, first.state, CFG, 6000 + 1000);
  assert.strictEqual(soon.act, false);
  assert.match(soon.reason, /cooldown/);
});

test('the daily intervention cap bounds a runaway', () => {
  // Selling three lots every five seconds would be far worse than the problem.
  let st = Object.assign({}, S0, { actionsToday: CFG.maxPerDay });
  const r = twice({ size: 5, side: 'SHORT' }, CFG, st);
  assert.strictEqual(r.act, false);
  assert.match(r.reason, /daily intervention cap/);
});

test('the day roll resets the counters', () => {
  const used = { dayKey: '2026-08-28', confirmCount: 1, lastActionAt: 5, actionsToday: 6, lastSeenSize: 5 };
  const fresh = rollDay(used, '2026-08-29');
  assert.strictEqual(fresh.actionsToday, 0);
  assert.strictEqual(fresh.lastActionAt, 0);
  assert.strictEqual(fresh.lastSeenSize, null);
  assert.deepEqual(rollDay(used, '2026-08-28'), used, 'same day is untouched');
});

test('going flat clears a pending confirmation', () => {
  const one = evaluate({ size: 5, side: 'SHORT' }, S0, CFG, 1000);
  assert.strictEqual(one.state.confirmCount, 1);
  const flat = evaluate(null, one.state, CFG, 2000);
  assert.strictEqual(flat.state.confirmCount, 0, 'a stale confirmation must not carry into the next position');
});

// ── what today would have cost with the guard on ───────────────────────────
test("REPLAY 2026-08-28: the -$1,322 short becomes roughly -$529", () => {
  const r = twice({ size: 5, side: 'SHORT' });
  const lossPerContract = -1322.00 / 5;
  const kept = CFG.sizeCap * lossPerContract;
  assert.strictEqual(r.act, true);
  assert.strictEqual(r.reduceBy, 3);
  assert.ok(kept > -530 && kept < -528, `expected about -$529, got ${kept.toFixed(2)}`);
});

test('REPLAY: the +$174 size-3 long keeps its 2 lots rather than being flattened', () => {
  // A guard that costs you your winners gets switched off, and a switched-off
  // guard protects nothing.
  const r = twice({ size: 3, side: 'LONG' });
  assert.strictEqual(r.act, true);
  assert.strictEqual(r.reduceBy, 1, 'sell 1, keep 2 — not closed out');
});

test('defaults ship DISABLED', () => {
  assert.strictEqual(DEFAULTS.enabled, false, 'a guard that can send orders must be opt-in');
});
