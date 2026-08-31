'use strict';
// ── OVERSIZE GUARD wiring tests ────────────────────────────────────────────
// oversize-guard.test.js proves the DECISION is right. These prove the parts
// that live in server.js — reading the broker row, and knowing whether this
// session can actually act — are right too, because on 2026-08-28 both of
// them were wrong in ways no unit test of the decision could ever catch:
//
//   1. largestPosition() read p.symbol/p.side/p.qty in lowercase. Real broker
//      rows are keyed by the RAW TABLE HEADER TEXT ('Symbol', 'Side', 'Qty')
//      because readTable() builds each object with `key = headerCells[i]`.
//      Every field was undefined, so the armed guard would have sat there and
//      silently never fired.
//   2. trading_place_market_order is only REGISTERED by tradingview-mcp when
//      TV_ALLOW_LIVE_ORDERS=1. Launched the plain way, the guard detects the
//      breach perfectly and then cannot do anything about it.
//
// Both are the same failure class: a guard that looks armed and isn't. These
// tests read the real functions out of server.js rather than re-typing them,
// so a change there fails here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));

function extract(fromMarker, toMarker, exportNames) {
  const a = SRC.indexOf(fromMarker);
  const b = SRC.indexOf(toMarker);
  assert.ok(a >= 0, 'could not find ' + fromMarker + ' in server.js');
  assert.ok(b > a, 'could not find ' + toMarker + ' in server.js');
  const mod = { exports: {} };
  const stubRules = () => RULES;
  const quiet = { log() {}, warn() {}, error() {} };
  new Function('module', 'getActiveRules', 'console',
    SRC.slice(a, b) + '\nmodule.exports = { ' + exportNames.join(', ') + ' };')(mod, stubRules, quiet);
  return mod.exports;
}

const { largestPosition } = extract(
  'function pickField(row, names)', 'function enforceOversizeGuard(rows)', ['pickField', 'largestPosition']);
const { oversizeConfig } = extract(
  'function oversizeConfig() {', '// The largest single position on the account.',
  ['oversizeConfig', 'announceOversizeGuard']);

// ── reading the real broker row ────────────────────────────────────────────
test('THE BUG: a real broker row uses capitalised headers and MUST be read', () => {
  // This exact shape is what trading_get_positions returns — the tool's own
  // description names the columns "Symbol, Side, Qty, Avg Fill Price, ...".
  const pos = largestPosition([{ Symbol: 'MNQZ6', Side: 'SELL', Qty: '5', 'Avg Fill Price': '23450.25' }]);
  assert.ok(pos, 'a real broker row must not read as flat — that is the silent no-op');
  assert.strictEqual(pos.symbol, 'MNQZ6');
  assert.strictEqual(pos.side, 'SELL');
  assert.strictEqual(pos.size, 5);
});

test('lowercase keys still work — a header casing change cannot disarm it', () => {
  const pos = largestPosition([{ symbol: 'MNQZ6', side: 'short', qty: 5 }]);
  assert.strictEqual(pos.size, 5);
  assert.strictEqual(pos.side, 'SHORT');
});

test('display formatting in the quantity is parsed, not rejected', () => {
  assert.strictEqual(largestPosition([{ Symbol: 'X', Side: 'BUY', Qty: '1,000' }]).size, 1000);
  assert.strictEqual(largestPosition([{ Symbol: 'X', Side: 'SELL', Qty: '-3' }]).size, 3, 'size is absolute');
});

test('an unreadable quantity reads as FLAT, never as a position to act on', () => {
  for (const bad of ['', null, undefined, 'n/a', '--']) {
    assert.strictEqual(largestPosition([{ Symbol: 'X', Side: 'BUY', Qty: bad }]), null,
      'qty ' + JSON.stringify(bad) + ' must not produce a position');
  }
});

test('sizes are compared PER SYMBOL, never summed across instruments', () => {
  // Two 2-lot positions in different instruments are two trades at the cap,
  // not one 4-lot breach. Summing them would flatten a legal position.
  const pos = largestPosition([{ Symbol: 'MNQZ6', Side: 'BUY', Qty: '2' }, { Symbol: 'MGCZ6', Side: 'SELL', Qty: '2' }]);
  assert.strictEqual(pos.size, 2, 'the LARGEST single position, not the total');
  const worst = largestPosition([{ Symbol: 'MNQZ6', Side: 'BUY', Qty: '2' }, { Symbol: 'MGCZ6', Side: 'SELL', Qty: '4' }]);
  assert.strictEqual(worst.symbol, 'MGCZ6', 'the breaching symbol is the one reported');
  assert.strictEqual(worst.size, 4);
});

test('garbage input does not throw — this runs inside a live position poll', () => {
  for (const junk of [null, undefined, {}, 'x', [null], [undefined]]) {
    assert.doesNotThrow(() => largestPosition(junk));
  }
});

// ── knowing whether it can act ─────────────────────────────────────────────
test('canAct is FALSE without TV_ALLOW_LIVE_ORDERS — the order tool is not registered', () => {
  const prev = process.env.TV_ALLOW_LIVE_ORDERS;
  delete process.env.TV_ALLOW_LIVE_ORDERS;
  try {
    assert.strictEqual(oversizeConfig().canAct, false,
      'claiming it can act when the MCP tool does not exist is the failure this catches');
  } finally { if (prev !== undefined) process.env.TV_ALLOW_LIVE_ORDERS = prev; }
});

test('canAct is TRUE only for the exact string "1"', () => {
  const prev = process.env.TV_ALLOW_LIVE_ORDERS;
  try {
    process.env.TV_ALLOW_LIVE_ORDERS = '1';
    assert.strictEqual(oversizeConfig().canAct, true);
    for (const v of ['true', 'yes', '0', '']) {
      process.env.TV_ALLOW_LIVE_ORDERS = v;
      assert.strictEqual(oversizeConfig().canAct, false, JSON.stringify(v) + ' must not enable live orders');
    }
  } finally {
    if (prev === undefined) delete process.env.TV_ALLOW_LIVE_ORDERS;
    else process.env.TV_ALLOW_LIVE_ORDERS = prev;
  }
});

test('the guard reads its size cap from the top-level sizeCap, not a duplicate', () => {
  // One size rule in rules.json, not two that can drift apart. A duplicated
  // cap drifting out of sync is a bug this repo has already had.
  assert.strictEqual(oversizeConfig().sizeCap, RULES.sizeCap);
  assert.strictEqual(RULES.oversizeGuard.sizeCap, undefined, 'sizeCap must NOT be duplicated inside oversizeGuard');
});

// ── the wiring itself ──────────────────────────────────────────────────────
test('the guard is called from the position watch, on a read already proven good', () => {
  const hook = SRC.indexOf('enforceOversizeGuard(rows)');
  assert.ok(hook > 0, 'the guard must actually be called from server.js');
  const before = SRC.slice(Math.max(0, hook - 1200), hook);
  assert.match(before, /!Array\.isArray\(result\.positions\)\) return/,
    'the unreadable-panel guard clause must return BEFORE the oversize guard runs');
});

test('the call is wrapped so a throw cannot kill the position watch', () => {
  const i = SRC.indexOf('enforceOversizeGuard(rows)');
  assert.match(SRC.slice(i - 60, i + 120), /try \{[^}]*enforceOversizeGuard\(rows\);[^}]*\} catch/,
    'this runs inside a live poll during a trading session');
});

test('the boot announcement runs at startup so the mode is never a surprise', () => {
  assert.ok(/\n\s*announceOversizeGuard\(\);/.test(SRC),
    'a guard whose inability to act is discovered mid-breach is the bug this prevents');
});

test('alarm-only mode never attempts an order it cannot send', () => {
  // Firing a doomed call would bury the one thing that matters — there are too
  // many contracts on RIGHT NOW — inside an "unknown tool" stack trace.
  const i = SRC.indexOf('if (!cfg.canAct) {');
  assert.ok(i > 0, 'the alarm-only branch must exist');
  const branch = SRC.slice(i, SRC.indexOf('trading_place_market_order', i));
  assert.match(branch, /return;/, 'the alarm-only branch must return before the order call');
  assert.match(branch, /CLOSE .*CONTRACTS YOURSELF|CLOSE .*YOURSELF/,
    'it must tell him plainly to close the excess himself');
});
