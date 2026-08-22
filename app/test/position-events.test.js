'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diffPositions, describeEvent } = require('../position-events.js');

const row = (Symbol, Side, Qty) => ({ Symbol, Side, Qty: String(Qty) });

test('the first read of a session is a baseline, not a change', () => {
  // Restarting mid-position is a realistic case (it is exactly what the
  // fold's persistence exists to survive). Reporting the already-open
  // position as freshly "opened" would fire a false alert and, once wired to
  // the session log, write a phantom row on every reconnect.
  assert.deepEqual(diffPositions(null, [row('MNQU6', 'Buy', 2)]), []);
  assert.deepEqual(diffPositions(undefined, [row('MNQU6', 'Buy', 2)]), []);
});

test('flat → open is one opened event', () => {
  const ev = diffPositions([], [row('MNQU6', 'Buy', 2)]);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0], { kind: 'opened', symbol: 'MNQU6', side: 'buy', qty: 2, prevQty: 0 });
});

test('open → flat is one closed event carrying the size that closed', () => {
  const ev = diffPositions([row('MNQU6', 'Buy', 2)], []);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0], { kind: 'closed', symbol: 'MNQU6', side: 'buy', qty: 0, prevQty: 2 });
});

test('no change produces no events (the common case, every tick)', () => {
  const rows = [row('MNQU6', 'Buy', 2)];
  assert.deepEqual(diffPositions(rows, [row('MNQU6', 'Buy', 2)]), []);
});

test('a scale-in and a partial exit are distinguishable from each other', () => {
  const inEv = diffPositions([row('MNQU6', 'Sell', 2)], [row('MNQU6', 'Sell', 12)]);
  assert.deepEqual(inEv[0], { kind: 'scaled', symbol: 'MNQU6', side: 'sell', qty: 12, prevQty: 2 });
  assert.match(describeEvent(inEv[0]), /SCALED IN/);

  const outEv = diffPositions([row('MNQU6', 'Sell', 12)], [row('MNQU6', 'Sell', 4)]);
  assert.deepEqual(outEv[0], { kind: 'scaled', symbol: 'MNQU6', side: 'sell', qty: 4, prevQty: 12 });
  assert.match(describeEvent(outEv[0]), /SCALED OUT/);
});

test('a side reversal without passing through flat is a flip, not open+close', () => {
  const ev = diffPositions([row('MNQU6', 'Buy', 2)], [row('MNQU6', 'Sell', 2)]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'flipped');
  assert.equal(ev[0].side, 'sell');
});

test('MNQ and MGC are tracked independently (the secondary-symbol watch case)', () => {
  const ev = diffPositions(
    [row('MNQU6', 'Buy', 2)],
    [row('MNQU6', 'Buy', 2), row('MGCQ6', 'Sell', 1)]
  );
  assert.equal(ev.length, 1, 'the unchanged MNQ position must not produce an event');
  assert.equal(ev[0].kind, 'opened');
  assert.equal(ev[0].symbol, 'MGCQ6');
});

test('one symbol closing while another opens yields both, in a stable order', () => {
  const ev = diffPositions([row('MNQU6', 'Buy', 2)], [row('MGCQ6', 'Sell', 1)]);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].kind, 'closed', 'a close is reported before an open');
  assert.equal(ev[1].kind, 'opened');
});

test('a zero-qty row is not an open position', () => {
  // Observed shape: TradingView can leave a settled row rendered with Qty 0
  // rather than removing it. Treating that as open would mean the eventual
  // real removal fires a second, duplicate "closed".
  assert.deepEqual(diffPositions([], [row('MNQU6', 'Buy', 0)]), []);
  const ev = diffPositions([row('MNQU6', 'Buy', 2)], [row('MNQU6', 'Buy', 0)]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'closed');
});

test('quantity is read regardless of sign and of thousands formatting', () => {
  const ev = diffPositions([], [{ Symbol: 'MNQU6', Side: 'Sell', Qty: '-12' }]);
  assert.equal(ev[0].qty, 12, 'a short leg rendered as -12 is a 12-lot position');
});

test('malformed rows never throw inside the live timer', () => {
  assert.deepEqual(diffPositions([], null), []);
  assert.deepEqual(diffPositions([], [null, undefined, 'nope', {}, { Symbol: '' }]), []);
  assert.deepEqual(diffPositions('garbage', 'garbage'), []);
  assert.equal(describeEvent(null), '');
  assert.equal(describeEvent({ kind: 'unknown' }), '');
});

test('describeEvent renders each kind for the chat line', () => {
  assert.equal(describeEvent({ kind: 'opened', symbol: 'MNQU6', side: 'buy', qty: 2, prevQty: 0 }), 'OPENED BUY 2 MNQU6');
  assert.equal(describeEvent({ kind: 'closed', symbol: 'MNQU6', side: 'buy', qty: 0, prevQty: 1 }), 'CLOSED MNQU6 (was 1 lot)');
  assert.equal(describeEvent({ kind: 'closed', symbol: 'MNQU6', side: 'buy', qty: 0, prevQty: 2 }), 'CLOSED MNQU6 (was 2 lots)');
});
