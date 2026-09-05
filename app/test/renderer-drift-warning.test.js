'use strict';
// ── Balance-drift warning: flat-only, and say it once (2026-08-28) ─────────
// Caught live while Anoop was IN a trade: the warning fired on EVERY poll,
// producing a dozen identical chat lines. Two distinct bugs.
//
//  1. It compared mid-trade. An open position marks the broker balance to
//     market, so it moves every tick while the ledger holds only CLOSED
//     trades. Those are different quantities and can never agree.
//     Anoop: "when live trade is on it can never match — after closing the
//     trade it should synch."
//  2. It deduped on the ROUNDED gap, which changed a dollar or two per poll,
//     so every poll looked new.
//
// The logic is replicated here rather than imported because it lives inside
// enforceAccountInvariant, which needs a DOM. The constants and the decision
// are the thing under test.
const test = require('node:test');
const assert = require('node:assert');

const DRIFT_MIN_USD = 1;
const DRIFT_RESAY_USD = 25;
const LEDGER = 51410.56;

function runPolls(polls) {
  let lastWarn = null;
  const said = [];
  for (const p of polls) {
    const drift = p.broker - LEDGER;
    if (p.isFlat !== true) continue;                       // only while flat
    if (!(Math.abs(drift) > DRIFT_MIN_USD)) continue;
    if (lastWarn == null || Math.abs(drift - lastWarn) >= DRIFT_RESAY_USD) {
      lastWarn = drift;
      said.push(Math.round(Math.abs(drift) * 100) / 100);
    }
  }
  return said;
}

// The twelve balances from the live screenshot, every one mid-trade.
const MID_TRADE = [51180.45, 51181.95, 51185.95, 51193.45, 51192.95, 51185.45,
                   51188.45, 51191.45, 51190.95, 51189.45, 51191.45, 51193.95]
  .map(b => ({ broker: b, isFlat: false }));

test('says NOTHING while a position is open — it cannot match mid-trade', () => {
  assert.deepEqual(runPolls(MID_TRADE), []);
});

test('says it ONCE after the trade closes', () => {
  const after = MID_TRADE.concat([51193.95, 51193.95, 51193.95].map(b => ({ broker: b, isFlat: true })));
  assert.strictEqual(runPolls(after).length, 1);
});

test('a steady gap is never repeated, however many flat polls arrive', () => {
  const polls = Array.from({ length: 50 }, () => ({ broker: 51193.95, isFlat: true }));
  assert.strictEqual(runPolls(polls).length, 1, 'one message, not fifty');
});

test('small tick-by-tick movement while flat does not re-trigger it', () => {
  // A few dollars of jitter is not new information.
  const polls = [51193.95, 51195.10, 51192.40, 51196.00].map(b => ({ broker: b, isFlat: true }));
  assert.strictEqual(runPolls(polls).length, 1);
});

test('a MATERIALLY different gap does speak again — a real change is still reported', () => {
  const polls = [{ broker: 51193.95, isFlat: true }, { broker: 51500.00, isFlat: true }];
  assert.strictEqual(runPolls(polls).length, 2);
});

test('unknown flatness is NOT treated as flat', () => {
  // positions unreadable => null. Unknown must never license a warning that
  // requires certainty; that is how a feed glitch becomes a false alarm.
  const polls = MID_TRADE.map(p => Object.assign({}, p, { isFlat: null }));
  assert.deepEqual(runPolls(polls), []);
});

test('a gap under a dollar is rounding, not drift', () => {
  assert.deepEqual(runPolls([{ broker: LEDGER + 0.40, isFlat: true }]), []);
});

test('the reconciled case is silent', () => {
  assert.deepEqual(runPolls([{ broker: LEDGER, isFlat: true }]), []);
});
