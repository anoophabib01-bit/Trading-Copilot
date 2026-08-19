'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTradeTicket } = require('../trade-ticket-parse.js');

test('parses a full ticket line with stop and target', () => {
  const r = parseTradeTicket('GO. Alignment confirmed.\n\n## ONE CONCRETE FIX FOR TOMORROW\nCap size.\n\nTRADE_TICKET: side=buy size=2 stop=24530.00 target=24610.00');
  assert.deepEqual(r, { side: 'buy', size: 2, stopPrice: 24530.00, targetPrice: 24610.00 });
});

test('parses a ticket line with no stop/target', () => {
  const r = parseTradeTicket('GO.\nTRADE_TICKET: side=sell size=1');
  assert.deepEqual(r, { side: 'sell', size: 1, stopPrice: null, targetPrice: null });
});

test('returns null when no TRADE_TICKET line is present (NO-GO case)', () => {
  assert.equal(parseTradeTicket('NO-GO. Discipline violation: revenge trade.'), null);
});

test('returns null on garbage/non-string input', () => {
  assert.equal(parseTradeTicket(null), null);
  assert.equal(parseTradeTicket(undefined), null);
  assert.equal(parseTradeTicket(42), null);
});

test('rejects an invalid side', () => {
  assert.equal(parseTradeTicket('TRADE_TICKET: side=long size=2'), null);
});

test('rejects a non-integer or non-positive size', () => {
  assert.equal(parseTradeTicket('TRADE_TICKET: side=buy size=2.5'), null);
  assert.equal(parseTradeTicket('TRADE_TICKET: side=buy size=0'), null);
  assert.equal(parseTradeTicket('TRADE_TICKET: side=buy size=-1'), null);
  assert.equal(parseTradeTicket('TRADE_TICKET: side=buy'), null);
});

test('ignores a zero/garbage stop or target rather than propagating it', () => {
  const r = parseTradeTicket('TRADE_TICKET: side=buy size=2 stop=0 target=abc');
  assert.deepEqual(r, { side: 'buy', size: 2, stopPrice: null, targetPrice: null });
});

test('is case-insensitive on the side value', () => {
  const r = parseTradeTicket('TRADE_TICKET: side=BUY size=2');
  assert.equal(r.side, 'buy');
});

test('does not pick up a TRADE_TICKET-like phrase embedded mid-sentence', () => {
  // Only matches when the line actually starts with "TRADE_TICKET:"
  assert.equal(parseTradeTicket('I will not use a TRADE_TICKET: this is just prose'), null);
});
