/**
 * Unit tests for the G29 order-entry logic — no TradingView connection needed.
 *
 * Exists because of a live failure and a live mistake on 2026-09-15:
 *   1. The app's oversize guard tried to reduce an 8-lot breach against a 4 cap
 *      three times and failed every attempt with "side control button not found:
 *      side-control-buy" — the order ticket was never mounted, and nothing in
 *      this project opened it or fell back to anything else.
 *   2. While diagnosing that, clicking the buy/sell widget's BUY button placed a
 *      real 1-lot market order (twice) on a live account, because it is a
 *      ONE-CLICK ORDER BUTTON, not a way to open the ticket.
 *
 * So these tests pin the two rules that must never regress: pick the path the
 * build actually has, and never treat "an order exists for this symbol" as proof
 * that THIS call placed one.
 *
 * Run: node --test tests/order-entry.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQtyText, orderIdsOf, newOrderIds, chooseOrderPath, orderStatusOf } from '../src/core/trading.js';

describe('parseQtyText', () => {
  it('reads the size off the widget qty element', () => {
    assert.equal(parseQtyText('1'), 1);
    assert.equal(parseQtyText(' 12 '), 12);
    assert.equal(parseQtyText('2 contracts'), 2);
  });
  it('returns null rather than 0 when there is no number', () => {
    assert.equal(parseQtyText(''), null);
    assert.equal(parseQtyText(null), null);
    assert.equal(parseQtyText(undefined), null);
  });
  it('REGRESSION GUARD: a widget reading "1" must never be read as "0.5" or 0', () => {
    assert.equal(parseQtyText('29,269.75 SELL 0.50 1 29,270.25 BUY'), 29);
    // ^ that whole-widget string is not what we pass in production (we pass
    //   qtyEl), but the first number wins and it is never 0 — which is the
    //   property that matters for the pre-submit size check.
    assert.notEqual(parseQtyText('1'), 0);
  });
});

describe('order id diffing — the post-submit proof', () => {
  const orders = [
    { 'Order ID': '650961251054', Status: 'Working', Symbol: 'MNQZ6' },
    { 'Order ID': '650961250956', Status: 'Filled', Symbol: 'MNQZ6' },
  ];
  it('collects ids and ignores rows without one', () => {
    const s = orderIdsOf(orders.concat([{ Status: 'Filled' }, null]));
    assert.equal(s.size, 2);
    assert.ok(s.has('650961251054'));
  });
  it('THE REASON THIS EXISTS: a pre-existing filled order is NOT proof this call placed one', () => {
    const before = orderIdsOf(orders);
    assert.equal(newOrderIds(before, orders).length, 0);
  });
  it('finds only the genuinely new order', () => {
    const before = orderIdsOf(orders);
    const after = orders.concat([{ 'Order ID': '650961259999', Status: 'Filled', Symbol: 'MNQZ6' }]);
    const fresh = newOrderIds(before, after);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]['Order ID'], '650961259999');
  });
  it('accepts a Set or a raw array for before', () => {
    assert.equal(newOrderIds(orders, orders.concat([{ 'Order ID': 'x', Status: 'Filled' }])).length, 1);
  });
});

describe('chooseOrderPath — take the path this build actually has', () => {
  it('ticket wins when the ticket is mounted', () => {
    assert.equal(chooseOrderPath({ ticketSideControl: 2, placeButton: 1, widgetQtyEl: 1, widgetSideButton: 2 }).path, 'ticket');
  });
  it('THE 2026-09-15 CASE: no ticket, widget present -> widget', () => {
    const r = chooseOrderPath({ ticketSideControl: 0, placeButton: 0, widgetQtyEl: 1, widgetSideButton: 2 });
    assert.equal(r.path, 'widget');
    assert.match(r.reason, /ticket not mounted/);
  });
  it('neither present -> none, never a silent guess', () => {
    assert.equal(chooseOrderPath({ ticketSideControl: 0, placeButton: 0, widgetQtyEl: 0, widgetSideButton: 0 }).path, 'none');
    assert.equal(chooseOrderPath(null).path, 'none');
  });
  it('a half-mounted ticket is NOT a ticket', () => {
    assert.equal(chooseOrderPath({ ticketSideControl: 2, placeButton: 0, widgetQtyEl: 1, widgetSideButton: 2 }).path, 'widget');
  });
});

describe('orderStatusOf — cancel is verified, not assumed', () => {
  const orders = [{ 'Order ID': '650961251054', Status: 'Cancelled' }, { 'Order ID': '2', Status: 'Working' }];
  it('reads the status of the named order', () => {
    assert.equal(orderStatusOf(orders, '650961251054'), 'cancelled');
    assert.equal(orderStatusOf(orders, 2), 'working');
  });
  it('an id that vanished counts as absent (still cancelled in effect)', () => {
    assert.equal(orderStatusOf(orders, 'does-not-exist'), 'absent');
  });
});
