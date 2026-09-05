const test = require('node:test');
const assert = require('node:assert');
const { shouldStopOut } = require('../per-trade-stop.js');

// ── The latch, extracted ────────────────────────────────────────────────────
// enforcePerTradeStop() in server.js cannot be imported (it needs the whole
// server), so this mirrors its latch exactly. If you change the latch there,
// change it here — the point of this file is that the SEQUENCE below stays
// protected, and that is what the shipped code got wrong.
function makeGuard(cap) {
  let state = { key: null, breachFired: false, blindFired: false };
  return function onPoll(pos) {
    const size = pos ? Number(pos.size) : 0;
    if (!Number.isFinite(size) || size === 0) {
      state = { key: null, breachFired: false, blindFired: false };   // flat → re-arm
      return { action: 'none', reason: 'flat' };
    }
    const v = shouldStopOut({ unrealisedUsd: pos.unrealised, perTradeMaxLoss: cap, size });
    if (v.stop === false) return { action: 'none', reason: 'inside cap' };
    const blind = v.stop === null;
    const key = String(pos.symbol || '?') + '|' + String(pos.side || '?');
    if (state.key !== key) state = { key, breachFired: false, blindFired: false };
    if (blind) {
      if (state.blindFired) return { action: 'none', reason: 'blind already alarmed' };
      state.blindFired = true;
      return { action: 'alarm-blind' };
    }
    if (state.breachFired) return { action: 'none', reason: 'already flattened' };
    state.breachFired = true;
    return { action: 'flatten' };
  };
}

const P = (over) => Object.assign({ symbol: 'MNQ1!', side: 'long', size: 2, unrealised: 0 }, over);

// ── THE REGRESSION ──────────────────────────────────────────────────────────
// 2026-09-03, the day s2 died. The shipped latch was one-shot-per-DAY, so the
// -$526 on trade 4 spent the only shot and the -$1,718 on trade 6 — the worst
// trade in the entire record — went through unprotected. Replayed, that one
// line cost $1,418 and turned the guard from +$910 into -$508.
test('REGRESSION 2026-09-03: a second losing trade is still protected', () => {
  const guard = makeGuard(300);
  // trade 4 breaches
  assert.strictEqual(guard(P({ size: 4, unrealised: -526 })).action, 'flatten');
  // it closes
  assert.strictEqual(guard(P({ size: 0 })).action, 'none');
  // trade 5, small loss, inside the cap
  assert.strictEqual(guard(P({ size: 15, unrealised: -61 })).action, 'none');
  assert.strictEqual(guard(P({ size: 0 })).action, 'none');
  // trade 6 — the 20-lot that killed the account. MUST still be protected.
  assert.strictEqual(guard(P({ size: 20, unrealised: -1718 })).action, 'flatten',
    'the -$1,718 trade must be stopped; the old per-day latch let it through');
});

test('one flatten attempt per position — polls do not spam orders', () => {
  const guard = makeGuard(300);
  assert.strictEqual(guard(P({ unrealised: -400 })).action, 'flatten');
  assert.strictEqual(guard(P({ unrealised: -450 })).action, 'none');
  assert.strictEqual(guard(P({ unrealised: -900 })).action, 'none');
});

test('going flat re-arms the guard for the next trade', () => {
  const guard = makeGuard(300);
  assert.strictEqual(guard(P({ unrealised: -400 })).action, 'flatten');
  assert.strictEqual(guard(P({ size: 0 })).reason, 'flat');
  assert.strictEqual(guard(P({ unrealised: -400 })).action, 'flatten');
});

// A blind alarm at 09:00 must not disarm the breach stop for the session. That
// is exactly the 2026-09-03 shape: the guard present, blind, and silent.
test('a blind alarm does NOT consume the breach shot', () => {
  const guard = makeGuard(300);
  assert.strictEqual(guard(P({ unrealised: null })).action, 'alarm-blind');
  assert.strictEqual(guard(P({ unrealised: null })).action, 'none', 'blind alarms do not repeat');
  // P&L becomes readable and breaches — the stop must still fire
  assert.strictEqual(guard(P({ unrealised: -800 })).action, 'flatten',
    'a blind alarm must not have spent the breach shot');
});

test('flipping side re-arms — a reversal is a new position', () => {
  const guard = makeGuard(300);
  assert.strictEqual(guard(P({ side: 'long', unrealised: -400 })).action, 'flatten');
  assert.strictEqual(guard(P({ side: 'short', unrealised: -400 })).action, 'flatten');
});

test('a different symbol has its own shot', () => {
  const guard = makeGuard(300);
  assert.strictEqual(guard(P({ symbol: 'MNQ1!', unrealised: -400 })).action, 'flatten');
  assert.strictEqual(guard(P({ symbol: 'MGC1!', unrealised: -400 })).action, 'flatten');
});

test('adding to a position does not re-arm it', () => {
  const guard = makeGuard(300);
  assert.strictEqual(guard(P({ size: 2, unrealised: -400 })).action, 'flatten');
  assert.strictEqual(guard(P({ size: 4, unrealised: -400 })).action, 'none',
    'same symbol+side is the same position — one flatten attempt');
});

// ── The money ───────────────────────────────────────────────────────────────
// The whole point of the fix, on the real record.
test('the fixed latch reproduces the accepted +$910, the old one did not', () => {
  const fs = require('fs');
  const path = require('path');
  const R = path.join(__dirname, '..', '..', 'DATA', '_recovered_20260904');
  if (!fs.existsSync(R)) return;   // recovered data not present — skip quietly
  const days = {};
  for (const f of ['s1_breached_20260829_day_trades.json', 's5_breached_20260904_day_trades.json']) {
    const fp = path.join(R, f);
    if (!fs.existsSync(fp)) return;
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const k of Object.keys(d)) days[k] = d[k] || [];
  }
  const CAP = 300;
  const run = (oneShotPerDay) => {
    let net = 0;
    for (const day of Object.keys(days).sort()) {
      let spent = false;
      for (const t of days[day]) {
        const pnl = Number(t.pnl) || 0;
        const v = shouldStopOut({ unrealisedUsd: pnl, perTradeMaxLoss: CAP, size: Number(t.size) || 1 });
        let eff = pnl;
        if (v.stop === true && !(oneShotPerDay && spent)) { eff = -CAP; spent = true; }
        net += eff;
      }
    }
    return Math.round(net);
  };
  assert.strictEqual(run(false), 910, 'every breach protected → the accepted +$910');
  assert.strictEqual(run(true), -508, 'one-shot-per-day → the bug this file exists to prevent');
});
