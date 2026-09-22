'use strict';
// App-side protection: close at -200 / +600. These pin the three things that decide whether
// a live trade is protected or quietly abandoned: the DIRECTION of the P&L, the ONE-attempt
// latch, and that unreadable is reported as blind rather than as nothing-to-do.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { decide, unrealisedUsd, resolveAutoProtection } = require('../position-protection.js');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
const base = { side: 'Long', size: 1, entryPrice: 29200, pointValue: 2, stopLossUsd: 200, takeProfitUsd: 600 };

test('a long at -200 closes', () => {
  const d = decide(Object.assign({}, base, { unrealisedUsd: -200 }));
  assert.equal(d.action, 'close');
  assert.match(d.reason, /^STOP/);
});

test('a long at +600 closes', () => {
  const d = decide(Object.assign({}, base, { unrealisedUsd: 600 }));
  assert.equal(d.action, 'close');
  assert.match(d.reason, /^TARGET/);
});

test('inside the band does nothing', () => {
  assert.equal(decide(Object.assign({}, base, { unrealisedUsd: 120 })).action, 'none');
  assert.equal(decide(Object.assign({}, base, { unrealisedUsd: -199.99 })).action, 'none');
});

test('derives the P&L from prices when the broker figure is missing', () => {
  const d = decide(Object.assign({}, base, { unrealisedUsd: null, lastPrice: 29100 }));
  assert.equal(d.unrealisedUsd, -200);
  assert.equal(d.action, 'close');
  assert.equal(d.source, 'prices');
});

test('a SHORT profits when price falls - the direction must not be inverted', () => {
  const d = decide({ side: 'Short', size: 2, entryPrice: 29200, lastPrice: 29100, pointValue: 2, unrealisedUsd: null, stopLossUsd: 200, takeProfitUsd: 600 });
  assert.equal(d.unrealisedUsd, 400);
  assert.equal(d.action, 'none');
  const stop = decide({ side: 'Short', size: 2, entryPrice: 29200, lastPrice: 29300, pointValue: 2, unrealisedUsd: null, stopLossUsd: 200, takeProfitUsd: 600 });
  assert.equal(stop.action, 'close');
});

test('the latch: one attempt per position, never a machine gun', () => {
  const d = decide(Object.assign({}, base, { unrealisedUsd: -900, alreadyAttempted: true }));
  assert.equal(d.action, 'none');
  assert.equal(d.source, 'latch');
});

test('unreadable P&L is BLIND, not nothing-to-do', () => {
  const d = decide({ side: 'Long', size: 1, unrealisedUsd: null, stopLossUsd: 200, takeProfitUsd: 600, pointValue: 2 });
  assert.equal(d.action, 'blind');
  assert.match(d.reason, /unreadable/i);
});

test('flat does nothing and says so', () => {
  assert.equal(decide(Object.assign({}, base, { size: 0, unrealisedUsd: 0 })).action, 'none');
});

test('disabled in rules.json does nothing', () => {
  assert.equal(decide(Object.assign({}, base, { enabled: false, unrealisedUsd: -5000 })).action, 'none');
});

test('at 4 lots the same dollars are a quarter of the point distance', () => {
  const four = { side: 'Long', size: 4, entryPrice: 29200, pointValue: 2, unrealisedUsd: null, stopLossUsd: 200, takeProfitUsd: 600 };
  assert.equal(decide(Object.assign({}, four, { lastPrice: 29175 })).action, 'close');
  assert.equal(decide(Object.assign({}, four, { lastPrice: 29180 })).action, 'none');
});

test('autoProtection is configured sanely — but the exact dollars are HIS to set', () => {
  // REWRITTEN 2026-09-21. This used to pin stopLossUsd === 200 and
  // takeProfitUsd === 600 against the LIVE app/rules.json. Both are settable
  // from Settings -> Trading, and he changed the stop to 201 while testing the
  // panel, so the suite went red reporting his own preference as a code
  // regression — the third time this class of test has done that (the playbook
  // registry and the s3 replay were the others).
  //
  // What is actually worth asserting about a user-set number: that it is there,
  // that it is a positive finite dollar amount, and that the module UNDER TEST
  // reads it rather than a hardcoded literal. The exact value belongs to him.
  const ap = rules.autoProtection || {};
  assert.equal(ap.enabled, true, 'auto-protection must be ON');
  // Per-stage since 2026-09-21: eval and funded each carry their own band.
  for (const stage of ['eval', 'funded']) {
    const eff = resolveAutoProtection(ap, stage);
    for (const k of ['stopLossUsd', 'takeProfitUsd']) {
      assert.ok(Number.isFinite(Number(eff[k])), stage + '.' + k + ' must be a number, got ' + JSON.stringify(eff[k]));
      assert.ok(Number(eff[k]) > 0, stage + '.' + k + ' must be positive, got ' + eff[k]);
      assert.ok(Number(eff[k]) <= 100000, stage + '.' + k + ' is implausibly large: ' + eff[k]);
    }
    for (const k of ['breakEvenAtUsd', 'trailDistanceUsd']) {
      assert.ok(Number.isFinite(Number(eff[k])), stage + '.' + k + ' must be a number');
      assert.ok(Number(eff[k]) >= 0, stage + '.' + k + ' must be >= 0 (0 = trail off)');
    }
  }
});
// ── Trailing stop (2026-09-21) ──────────────────────────────────────────────
test('trail: below the break-even trigger the fixed stop still applies', () => {
  // entry 30000, last 29900 → -100 pts × $2 = -$200 unrealised. Trail not armed.
  const r = decide({ side: 'Long', size: 1, entryPrice: 30000, lastPrice: 29900, pointValue: 2, stopLossUsd: 200, takeProfitUsd: 600, breakEvenAtUsd: 150, trailDistanceUsd: 150, peakUsd: null });
  assert.equal(r.action, 'close');
  assert.match(r.reason, /STOP/);
});

test('trail: once the peak reached the trigger, falling into the trail CLOSES (banks the winner)', () => {
  // peak +$300, trail $150 → stop at +$150. Observed +$140 is at/past it.
  const r = decide({ side: 'Long', size: 1, entryPrice: 30000, pointValue: 2, unrealisedUsd: 140, stopLossUsd: 200, takeProfitUsd: 600, breakEvenAtUsd: 150, trailDistanceUsd: 150, peakUsd: 300 });
  assert.equal(r.action, 'close');
  assert.match(r.reason, /TRAIL/);
  assert.equal(r.stopLevelUsd, 150);
});

test('trail: above the trailing stop the position is HELD — no early exit', () => {
  // stop at +$150 (300−150), observed +$200 → hold.
  const r = decide({ side: 'Long', size: 1, entryPrice: 30000, pointValue: 2, unrealisedUsd: 200, stopLossUsd: 200, takeProfitUsd: 600, breakEvenAtUsd: 150, trailDistanceUsd: 150, peakUsd: 300 });
  assert.equal(r.action, 'none');
  assert.match(r.reason, /trailing stop armed at \+150/);
});

test('trail: at the trigger the stop is break-even when be == trail', () => {
  // peak == be == 150, trail 150 → stop = max(0, 150−150) = 0 (break-even lock).
  const r = decide({ side: 'Long', size: 1, entryPrice: 30000, pointValue: 2, unrealisedUsd: 150, stopLossUsd: 200, takeProfitUsd: 600, breakEvenAtUsd: 150, trailDistanceUsd: 150, peakUsd: 150 });
  assert.equal(r.action, 'none');
  assert.equal(r.stopLevelUsd, 0);
});

test('trail: the peak only rises, and is returned for the caller to persist', () => {
  const base = { side: 'Long', size: 1, entryPrice: 30000, pointValue: 2, stopLossUsd: 200, takeProfitUsd: 600, breakEvenAtUsd: 150, trailDistanceUsd: 150 };
  assert.equal(decide(Object.assign({}, base, { unrealisedUsd: 80, peakUsd: 200 })).peakUsd, 200);
  assert.equal(decide(Object.assign({}, base, { unrealisedUsd: 250, peakUsd: 200 })).peakUsd, 250);
});

test('trail disabled (0 trail) behaves exactly like the fixed stop/target', () => {
  const r = decide({ side: 'Long', size: 1, entryPrice: 30000, lastPrice: 30250, pointValue: 2, stopLossUsd: 200, takeProfitUsd: 600, breakEvenAtUsd: 0, trailDistanceUsd: 0, peakUsd: null });
  // +250 pts → +$500, inside the fixed band → hold (no trail).
  assert.equal(r.action, 'none');
  assert.equal(r.stopLevelUsd, -200);
});

// ── resolveAutoProtection (2026-09-21) ──────────────────────────────────────
test('resolveAutoProtection: per-stage override, flat fallback, and trailEnabled derivation', () => {
  const ap = {
    enabled: true, stopLossUsd: 199,
    eval: { stopLossUsd: 201, takeProfitUsd: 600, breakEvenAtUsd: 150, trailDistanceUsd: 150 },
    funded: { stopLossUsd: 200, takeProfitUsd: 300, breakEvenAtUsd: 0, trailDistanceUsd: 0 },
  };
  const e = resolveAutoProtection(ap, 'eval');
  assert.equal(e.stopLossUsd, 201);
  assert.equal(e.takeProfitUsd, 600);
  assert.equal(e.trailEnabled, true);
  const f = resolveAutoProtection(ap, 'funded');
  assert.equal(f.stopLossUsd, 200);
  assert.equal(f.takeProfitUsd, 300);
  assert.equal(f.trailEnabled, false); // 0 trail → off
  const flat = resolveAutoProtection({ enabled: true, stopLossUsd: 199, takeProfitUsd: 500 }, 'eval');
  assert.equal(flat.stopLossUsd, 199);
  assert.equal(flat.trailEnabled, false);
});

// --- G32 (2026-09-15): the parse that a live test caught. This broker prints losses with a
// UNICODE MINUS, and the old parser stripped it - turning -19.00 into +19.00, so the per-trade
// stop compared a PROFIT against a loss cap and never fired. These are the real string shapes.
const { parseMoney } = require('../position-protection.js');

test('parseMoney: a unicode-minus loss stays NEGATIVE (the bug this exists for)', () => {
  assert.equal(parseMoney('\u221219.00\nUSD'), -19);
  assert.equal(parseMoney('\u22122.50 USD'), -2.5);
  assert.equal(parseMoney('\u2212128.75'), -128.75);
});

test('parseMoney: profits and ASCII negatives', () => {
  assert.equal(parseMoney('+89.50\nUSD'), 89.5);
  assert.equal(parseMoney('-3.50 USD'), -3.5);
  assert.equal(parseMoney('0.00'), 0);
});

test('parseMoney: commas and accounting parentheses', () => {
  assert.equal(parseMoney('1,234.56'), 1234.56);
  assert.equal(parseMoney('(19.00)'), -19);
});

test('parseMoney: no number returns NULL, never 0 - a 0 would read as break-even', () => {
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney(undefined), null);
  assert.equal(parseMoney('USD'), null);
  assert.equal(parseMoney('\u2212'), null);
});
// --- G32 (2026-09-15): the casing bug that cost a live test. oversize-guard.netPosition returns
// side UPPERCASE, both guards compared it to lowercase, so the closing side was always null and
// the acting branch was skipped in silence. The per-trade stop never closed anything.
const { closingSideFor } = require('../position-protection.js');

test('closingSideFor: UPPERCASE (what netPosition actually returns) resolves', () => {
  assert.equal(closingSideFor('LONG'), 'sell');
  assert.equal(closingSideFor('SHORT'), 'buy');
});

test('closingSideFor: any casing or the broker wording works', () => {
  assert.equal(closingSideFor('long'), 'sell');
  assert.equal(closingSideFor('Long'), 'sell');
  assert.equal(closingSideFor('buy'), 'sell');
  assert.equal(closingSideFor('SELL'), 'buy');
  assert.equal(closingSideFor(' s '), 'buy');
});

test('closingSideFor: unknown returns NULL - never a guessed direction', () => {
  assert.equal(closingSideFor(''), null);
  assert.equal(closingSideFor(null), null);
  assert.equal(closingSideFor('?'), null);
  assert.equal(closingSideFor(undefined), null);
});