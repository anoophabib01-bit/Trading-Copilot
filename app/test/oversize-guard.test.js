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
test('it does not fire again while the first order is still filling', () => {
  const first = twice({ size: 5, side: 'SHORT' });
  assert.strictEqual(first.act, true);
  const soon = evaluate({ size: 5, side: 'SHORT' }, first.state, CFG, 6000 + 1000);
  assert.strictEqual(soon.act, false, 'the important property: no second order');
  // 2026-08-31: this used to assert /cooldown/. It now refuses for a STRONGER
  // reason — the one-outstanding-reduction rule, which is checked first and
  // holds for as long as the read stays put, whereas cooldown expires after
  // 30s. Cooldown alone was what let the incident fire six times.
  assert.match(soon.reason, /already sent/);
  assert.strictEqual(soon.state.stale, true);
});

test('cooldown still applies in its own right, once the read is moving again', () => {
  // Exercised where the episode rule is NOT in play: the position has been
  // seen to shrink, so sentQty is cleared and cooldown is the active bound.
  const first = twice({ size: 9, side: 'SHORT' });
  assert.strictEqual(first.act, true, '9 -> 2');
  let st = first.state;
  // Position genuinely shrinks to 6, seen twice → episode clears, confirmation rebuilds.
  let v = evaluate({ size: 6, side: 'SHORT' }, st, CFG, 7000); st = v.state;
  assert.strictEqual(st.sentQty, 0, 'a real shrink clears the outstanding reduction');
  v = evaluate({ size: 6, side: 'SHORT' }, st, CFG, 8000);
  assert.strictEqual(v.act, false);
  assert.match(v.reason, /cooldown/, 'now cooldown is the binding constraint');
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

// ═══════════════════════════════════════════════════════════════════════════
// THE 2026-08-31 INCIDENT — replayed as a permanent regression test.
//
// Live: opened LONG 5. Six polls, each reading size 5, each selling 1, each
// submitted AND "verified". The fills were real; the READ was frozen. True
// position walked 5 -> 4 -> 3 -> 2 -> 1 -> FLAT -> SHORT 1. Only maxPerDay=6
// stopped it. Every other safety property behaved exactly as designed.
// ═══════════════════════════════════════════════════════════════════════════

const CFG_LIVE = { enabled: true, sizeCap: 2, confirmReads: 2, maxPerDay: 6, cooldownMs: 30000 };

test('INCIDENT 2026-08-31: a frozen read can no longer walk a long into a short', () => {
  const pos = { size: 5, side: 'LONG', symbol: 'MNQU6' };
  let st = rollDay({}, '2026-08-31');
  let sold = 0, truePos = 5, acts = 0, t = 0;

  // Twenty polls at the real 35s spacing — far more than the six it took live.
  for (let i = 0; i < 20; i++) {
    t += 35000;
    const v = evaluate(pos, st, CFG_LIVE, t);   // `pos` NEVER changes: the frozen read
    st = v.state;
    if (v.act) { acts++; sold += v.reduceBy; truePos -= v.reduceBy; }
  }

  assert.equal(acts, 1, 'exactly ONE order may be sent against a read that never moves');
  assert.equal(sold, 3, 'and it must be the full 5->2 reduction, not a drip');
  assert.equal(truePos, 2, 'true position lands exactly on the cap');
  assert.ok(truePos > 0, 'a reduction must never cross zero into a short');
});

test('INCIDENT: the refusal is explicit and flagged stale, not a silent no-op', () => {
  const pos = { size: 5, side: 'LONG', symbol: 'MNQU6' };
  let st = rollDay({}, '2026-08-31');
  let t = 0, stuck = null;
  for (let i = 0; i < 5; i++) {
    t += 35000;
    const v = evaluate(pos, st, CFG_LIVE, t);
    st = v.state;
    if (!v.act && v.state.stale) { stuck = v; break; }
  }
  assert.ok(stuck, 'a stuck episode must surface a stale verdict for the server to alarm on');
  assert.match(stuck.reason, /already sent 3/);
  assert.match(stuck.reason, /close the excess yourself/i);
});

test('a reduction that DOES land lets the guard act again on a still-oversized position', () => {
  // The stale latch must not become a permanent lockout when the feed is healthy.
  let st = rollDay({}, '2026-08-31');
  let t = 0;
  const poll = (size) => { t += 35000; const v = evaluate({ size, side: 'LONG', symbol: 'MNQU6' }, st, CFG_LIVE, t); st = v.state; return v; };

  poll(9); const first = poll(9);
  assert.equal(first.act, true);
  assert.equal(first.reduceBy, 7, '9 -> 2');

  // Broker only filled part of it; position is now 6 — genuinely smaller.
  const seen = poll(6);
  assert.equal(seen.act, false, 'the move re-arms confirmation but does not act on the first sight');
  const again = poll(6);
  assert.equal(again.act, true, 'a confirmed, genuinely smaller position may be reduced again');
  assert.equal(again.reduceBy, 4, '6 -> 2');
});

test('a position that GROWS while a reduction is unconfirmed is refused, not chased', () => {
  let st = rollDay({}, '2026-08-31');
  let t = 0;
  const poll = (size) => { t += 35000; const v = evaluate({ size, side: 'LONG', symbol: 'MNQU6' }, st, CFG_LIVE, t); st = v.state; return v; };
  poll(5); assert.equal(poll(5).act, true, 'first reduction goes out');
  const grew = poll(8);
  assert.equal(grew.act, false, 'scaling up mid-flight is ambiguous — alarm, never compound');
  assert.equal(grew.state.stale, true);
});

test('going flat clears the episode so the NEXT oversize starts clean', () => {
  let st = rollDay({}, '2026-08-31');
  let t = 0;
  const poll = (pos) => { t += 35000; const v = evaluate(pos, st, CFG_LIVE, t); st = v.state; return v; };
  poll({ size: 5, side: 'LONG' }); assert.equal(poll({ size: 5, side: 'LONG' }).act, true);
  poll(null);                                    // flat
  assert.equal(st.sentQty, 0, 'flat clears the outstanding reduction');
  poll({ size: 5, side: 'SHORT' });
  const v = poll({ size: 5, side: 'SHORT' });
  assert.equal(v.act, true, 'a brand-new position is not blocked by the previous episode');
  assert.equal(v.side, 'buy', 'reducing a short buys');
  assert.equal(v.reduceBy, 3);
});

test('returning within the cap clears the episode too', () => {
  let st = rollDay({}, '2026-08-31');
  let t = 0;
  const poll = (size) => { t += 35000; const v = evaluate({ size, side: 'LONG', symbol: 'M' }, st, CFG_LIVE, t); st = v.state; return v; };
  poll(5); assert.equal(poll(5).act, true);
  poll(2);
  assert.equal(st.sentQty, 0, 'back inside the cap ends the episode');
  assert.equal(st.sizeAtLastAction, null);
});

test('the daily cap is no longer what saves us — one order per episode is', () => {
  // With maxPerDay raised absurdly high, the episode invariant must still hold.
  const loose = Object.assign({}, CFG_LIVE, { maxPerDay: 999 });
  const pos = { size: 5, side: 'LONG', symbol: 'MNQU6' };
  let st = rollDay({}, '2026-08-31');
  let acts = 0, t = 0;
  for (let i = 0; i < 100; i++) { t += 35000; const v = evaluate(pos, st, loose, t); st = v.state; if (v.act) acts++; }
  assert.equal(acts, 1, '100 polls, no daily cap, still exactly one order');
});

// ── READING THE POSITIONS TABLE (netPosition) ──────────────────────────────
// Added 2026-09-02 after the guard sat silent through a real 5-lot. The old
// reader took the LARGEST ROW per symbol; Tradovate renders one row PER
// POSITION, so five 1-lot scale-ins read as `1` and the breach was invisible.
//
// These tests are written around the two directions of failure, which are not
// symmetric: under-reading means an oversize goes unenforced (what happened),
// over-reading means selling contracts he was entitled to keep (worse).
const { netPosition } = require('../oversize-guard.js');

const row = (sym, side, qty) => ({ Symbol: sym, Side: side, Qty: String(qty), 'Position ID': String(Math.random()) });

test('THE 2026-09-02 BUG: five 1-lot rows are one 5-lot position, not a 1-lot one', () => {
  const rows = [row('MNQU6', 'Long', 1), row('MNQU6', 'Long', 1), row('MNQU6', 'Long', 1),
    row('MNQU6', 'Long', 1), row('MNQU6', 'Long', 1)];
  const p = netPosition(rows);
  assert.strictEqual(p.size, 5, 'the old max-per-row reader returned 1 here');
  assert.strictEqual(p.side, 'LONG');
  assert.strictEqual(p.rowCount, 5, 'rowCount is what makes the fault visible in the evidence log');
});

test('and it still reduces: 5 against a cap of 2 sells 3', () => {
  const rows = [row('MNQU6', 'Long', 1), row('MNQU6', 'Long', 1), row('MNQU6', 'Long', 1),
    row('MNQU6', 'Long', 1), row('MNQU6', 'Long', 1)];
  const p = netPosition(rows);
  const a = evaluate(p, S0, CFG, 1000);
  const b = evaluate(p, a.state, CFG, 6000);
  assert.strictEqual(b.act, true);
  assert.strictEqual(b.reduceBy, 3);
  assert.strictEqual(b.side, 'sell');
});

test('the single-order case that DID work still works (08-31 and 09-01 in the log)', () => {
  const p = netPosition([row('MNQU6', 'Long', 5)]);
  assert.strictEqual(p.size, 5);
  assert.strictEqual(p.rowCount, 1);
  const q = netPosition([row('MNQU6', 'Sell', 8)]);
  assert.strictEqual(q.size, 8);
  assert.strictEqual(q.side, 'SHORT');
});

test('Buy/Long and Sell/Short are the SAME direction, not a hedge', () => {
  // If these normalised to different keys, an ordinary scaled-in position
  // whose rows label differently would read as mixed-sided and disarm the
  // guard — a silent failure dressed up as caution.
  const p = netPosition([row('MNQU6', 'Buy', 2), row('MNQU6', 'Long', 3)]);
  assert.strictEqual(p.size, 5);
  assert.strictEqual(p.side, 'LONG');
  assert.strictEqual(p.mixedSides, false);
});

// ── what it must REFUSE ────────────────────────────────────────────────────
test('two symbols at the cap is two trades at the cap, NOT one 4-lot breach', () => {
  const p = netPosition([row('MNQU6', 'Long', 2), row('MGCZ6', 'Short', 2)]);
  assert.strictEqual(p.size, 2, 'summing ACROSS symbols would invent a breach');
  const r = evaluate(p, S0, CFG, 1000);
  assert.strictEqual(r.act, false);
});

test('a symbol showing both directions has no nameable side, so the guard refuses', () => {
  const p = netPosition([row('MNQU6', 'Long', 3), row('MNQU6', 'Short', 2)]);
  assert.strictEqual(p.mixedSides, true);
  assert.strictEqual(p.side, '', 'guessing here would send an order the wrong way');
  const a = evaluate(p, S0, CFG, 1000);
  const b = evaluate(p, a.state, CFG, 6000);
  assert.strictEqual(b.act, false);
  assert.match(b.reason, /side not readable/);
});

test('an unparseable qty is skipped and counted, never assumed', () => {
  // Under-counting is the safe direction: it can only fail to act.
  const p = netPosition([row('MNQU6', 'Long', 2), { Symbol: 'MNQU6', Side: 'Long', Qty: '--' }]);
  assert.strictEqual(p.size, 2);
  assert.strictEqual(p.unparseableRows, 1, 'the evidence log must show the total was partial');
});

test('display formatting does not break the sum', () => {
  const p = netPosition([row('MNQU6', 'Long', '1,000'), row('MNQU6', 'Long', '−2')]);
  assert.strictEqual(p.size, 1002, 'commas stripped, unicode minus treated as sign not garbage');
});

test('no rows is flat, and flat is null (never a zero-size position object)', () => {
  assert.strictEqual(netPosition([]), null);
  assert.strictEqual(netPosition(null), null);
  assert.strictEqual(netPosition([{}]), null);
});

test('headers are matched case-insensitively so a capitalisation change cannot disarm it', () => {
  const p = netPosition([{ symbol: 'MNQU6', SIDE: 'long', qty: '5' }]);
  assert.strictEqual(p.size, 5);
  assert.strictEqual(p.side, 'LONG');
});

test('zero-qty rows are closed positions, not open ones', () => {
  const p = netPosition([row('MNQU6', 'Long', 0), row('MNQU6', 'Long', 2)]);
  assert.strictEqual(p.size, 2);
  assert.strictEqual(p.rowCount, 1);
});

// ── The latch has to survive a restart (2026-09-02) ────────────────────────
// Live incident: the guard sent SELL 2 against a 4-lot, correctly refused to
// send more, was restarted, and sent SELL 2 again against the same unchanged
// read. Four contracts against a position that read 4 both times. sentQty and
// sizeAtLastAction were in-memory only, so a restart reset the exact fields
// that make "one outstanding reduction at a time" mean anything.
//
// server.js now persists the state. These tests pin the two properties that
// makes safe: the latch is honoured when restored, and it cannot outlive the
// position it was set for.
const RESTART_CFG = { sizeCap: 2, confirmReads: 2, cooldownMs: 30000, maxPerDay: 3, canAct: true, enabled: true };

test('a restored outstanding reduction still refuses a second send', () => {
  // Exactly what was on disk between 11:56 and 12:30.
  const restored = { dayKey: '2026-09-02', confirmCount: 0, lastActionAt: 0, actionsToday: 1,
    lastSeenSize: 4, sentQty: 2, sizeAtLastAction: 4 };
  const v = evaluate({ size: 4, side: 'long', symbol: 'MNQU6' }, restored, RESTART_CFG, Date.now());
  assert.equal(v.act, false, 'a restart must not license a second reduction on the same read');
  assert.equal(v.state.stale, true);
  assert.match(v.reason, /already sent 2/);
});

test('the latch clears the moment the position is seen FLAT — it cannot outlive its episode', () => {
  const restored = { dayKey: '2026-09-02', confirmCount: 0, lastActionAt: 0, actionsToday: 1,
    lastSeenSize: 4, sentQty: 2, sizeAtLastAction: 4 };
  const flat = evaluate(null, restored, RESTART_CFG, Date.now());
  assert.equal(flat.state.sentQty, 0, 'a new episode always begins from flat');
  assert.equal(flat.state.sizeAtLastAction, null);
});

test('a restored latch releases once the position is actually seen to shrink', () => {
  const restored = { dayKey: '2026-09-02', confirmCount: 0, lastActionAt: 0, actionsToday: 1,
    lastSeenSize: 4, sentQty: 2, sizeAtLastAction: 4 };
  const v = evaluate({ size: 2, side: 'long', symbol: 'MNQU6' }, restored, RESTART_CFG, Date.now());
  assert.equal(v.state.sentQty, 0, 'the earlier order landed — the reading is live again');
});
