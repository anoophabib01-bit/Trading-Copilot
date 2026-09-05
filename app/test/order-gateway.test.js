const test = require('node:test');
const assert = require('node:assert');
const G = require('../order-gateway.js');

const LIVE = { liveOrdersEnabled: true, brokerReady: true };
const OPEN = { kind: 'open', side: 'buy', qty: 2, symbol: 'MNQ1!' };
const FLAT = { kind: 'flatten', side: 'sell', qty: 20, symbol: 'MNQ1!' };
const RED = { kind: 'reduce', side: 'sell', qty: 18, symbol: 'MNQ1!' };

// ── The distinction the whole module exists for ─────────────────────────────
// Blocking a flatten because the day-stop tripped would leave a losing position
// open at exactly the moment the rules wanted it gone. The oversize guard and
// the per-trade stop both emit these.
test('a blocked account can still FLATTEN — the day-stop must not trap a position', () => {
  const guard = { allowed: false, reason: 'day P&L -520 past the hard daily-loss tier -500' };
  assert.strictEqual(G.decideOrder(FLAT, { ...LIVE, guard }).allowed, true);
  assert.strictEqual(G.decideOrder(RED, { ...LIVE, guard }).allowed, true);
  assert.strictEqual(G.decideOrder(OPEN, { ...LIVE, guard }).allowed, false, 'but it cannot OPEN');
});

test('a risk-reducing order is not gated even with no guard result at all', () => {
  assert.strictEqual(G.decideOrder(FLAT, LIVE).allowed, true);
  assert.strictEqual(G.decideOrder({ ...FLAT, kind: 'close' }, LIVE).allowed, true);
});

// An unknown kind must gate, not wave through. Getting this backwards would
// make every future call site an unguarded one by default.
test('an unrecognised kind is treated as OPEN and gated', () => {
  const guard = { allowed: false, reason: 'size 20 exceeds sizeCap 2' };
  assert.strictEqual(G.decideOrder({ ...OPEN, kind: 'wibble' }, { ...LIVE, guard }).allowed, false);
  assert.strictEqual(G.decideOrder({ side: 'buy', qty: 2, symbol: 'MNQ1!' }, { ...LIVE, guard }).allowed, false,
    'a missing kind defaults to gated');
});

// ── The rules actually bite on an opening order ─────────────────────────────
test('REGRESSION 2026-09-03: a 20-lot against a cap of 2 is refused', () => {
  const guard = { allowed: false, reason: 'size 20 exceeds sizeCap 2' };
  const d = G.decideOrder({ kind: 'open', side: 'buy', qty: 20, symbol: 'MNQ1!' }, { ...LIVE, guard });
  assert.strictEqual(d.allowed, false);
  assert.match(d.reason, /sizeCap/);
});

test('REGRESSION 2026-08-28: standing down near the floor refuses new risk', () => {
  const guard = { allowed: false, reason: 'drawdown headroom $9 is at stand-down — session ended' };
  const d = G.decideOrder(OPEN, { ...LIVE, guard });
  assert.strictEqual(d.allowed, false);
  assert.match(d.reason, /headroom/);
});

test('a clean guard lets an opening order through', () => {
  assert.strictEqual(G.decideOrder(OPEN, { ...LIVE, guard: { allowed: true } }).allowed, true);
  assert.strictEqual(G.decideOrder(OPEN, LIVE).allowed, true);
});

// ── Preconditions ───────────────────────────────────────────────────────────
test('without the live-orders launcher nothing goes out, and it says why', () => {
  const d = G.decideOrder(FLAT, { liveOrdersEnabled: false, brokerReady: true });
  assert.strictEqual(d.allowed, false);
  assert.match(d.reason, /LIVE ORDERS/);
});

test('an unready broker blocks even a flatten', () => {
  assert.strictEqual(G.decideOrder(FLAT, { liveOrdersEnabled: true, brokerReady: false }).allowed, false);
});

test('malformed orders are refused before any of the rules run', () => {
  for (const bad of [
    { ...OPEN, qty: 0 }, { ...OPEN, qty: -3 }, { ...OPEN, qty: 2.5 },
    { ...OPEN, qty: null }, { ...OPEN, symbol: null }, { ...OPEN, side: null },
  ]) {
    assert.strictEqual(G.decideOrder(bad, LIVE).allowed, false, JSON.stringify(bad));
  }
  assert.strictEqual(G.decideOrder(null, LIVE).allowed, false);
  assert.strictEqual(G.decideOrder(undefined, undefined).allowed, false);
});

// ── The honesty flag ────────────────────────────────────────────────────────
// Every one of the five account-killing trades was placed by hand in
// TradingView. No surface may imply this gateway prevents that.
test('the module states plainly that it cannot prevent a manual order', () => {
  assert.strictEqual(G.preventsManualOrders, false);
});
