'use strict';
// 2026-08-27 — the two behaviour changes Anoop asked for on the engulf
// watchers: the BODY must be fully engulfed (not just the high/low range),
// and the alert must name the key levels the candle actually traded through.
const test = require('node:test');
const assert = require('node:assert');
const { detectEngulfFromBars } = require('../detectors');
const playbookC = require('../playbook-c');

// The exact shape the old range-only check let through: curr takes out both
// extremes with its WICKS, but its body sits inside prev's body. A wide
// indecision candle, not a reversal.
const wickOnly = [
  { time: 1, open: 100, close: 90,  high: 101, low: 89 },   // bearish body 90-100
  { time: 2, open: 92,  close: 98,  high: 110, low: 80 },   // body 92-98 — inside
];
const realBull = [
  { time: 1, open: 100, close: 90,  high: 101, low: 89 },
  { time: 2, open: 89,  close: 102, high: 103, low: 88 },   // body 89-102 — covers
];
const realBear = [
  { time: 1, open: 90,  close: 100, high: 101, low: 89 },
  { time: 2, open: 102, close: 88,  high: 103, low: 87 },
];

test('wick-only engulf is REJECTED — range engulf does not imply body engulf', () => {
  assert.strictEqual(detectEngulfFromBars(wickOnly), null);
});

test('a real body engulf still fires, both directions', () => {
  assert.deepStrictEqual(detectEngulfFromBars(realBull), { direction: 'BULLISH' });
  assert.deepStrictEqual(detectEngulfFromBars(realBear), { direction: 'BEARISH' });
});

test('body must cover BOTH ends — covering only one end is not an engulf', () => {
  const halfCover = [
    { time: 1, open: 100, close: 90, high: 101, low: 89 },
    { time: 2, open: 91,  close: 105, high: 106, low: 88 },  // top covered, bottom (90) not
  ];
  assert.strictEqual(detectEngulfFromBars(halfCover), null);
});

test('the Playbook C gate rejects the same wick-only candle, with a reason that says why', () => {
  // Pad with enough history that the gate reaches the body check rather than
  // bailing early on "not enough bar history".
  const hist = [];
  for (let i = 0; i < 40; i++) hist.push({ time: i, open: 100, close: 100.5, high: 101, low: 99.5 });
  const bars = hist.concat(wickOnly.map((b, i) => ({ ...b, time: 100 + i })));
  const res = playbookC.validateEngulfPlaybookC(bars, 'BULLISH', null);
  assert.strictEqual(res.valid, false);
  assert.match(res.reason, /body does not fully engulf/);
});

test('nearbyKeyLevels: a level inside the candle range is reported, one outside is not', () => {
  const bar = { open: 90, close: 102, high: 103, low: 88 };
  const hits = playbookC.nearbyKeyLevels(bar, [
    { name: 'PDL', price: 89 },
    { name: 'PDH', price: 250 },   // nowhere near — must not appear
  ]);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].name, 'PDL');
});

test('nearbyKeyLevels: nearest-to-close first, and one price is named once', () => {
  const bar = { open: 90, close: 102, high: 103, low: 88 };
  const hits = playbookC.nearbyKeyLevels(bar, [
    { name: 'PDL', price: 89 },
    { name: 'swing low', price: 89 },      // same line — must collapse to one
    { name: 'swing high', price: 101.5 },  // closest to the 102 close
  ]);
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits[0].name, 'swing high');
});

test('nearbyKeyLevels never throws on junk — it annotates, it must not cost an alert', () => {
  assert.deepStrictEqual(playbookC.nearbyKeyLevels(null, [{ name: 'x', price: 1 }]), []);
  assert.deepStrictEqual(playbookC.nearbyKeyLevels({ high: 1, low: 0, close: 0.5 }, null), []);
  const bar = { open: 90, close: 102, high: 103, low: 88 };
  assert.deepStrictEqual(playbookC.nearbyKeyLevels(bar, [null, { name: 'bad', price: NaN }, { price: 0 }]), []);
});

// ── Guards: 5M / 15M / 30M must stay identical to each other ────────────────
// Anoop's requirement 2026-08-27: the three lower timeframes are one class.
// Playbook C, armed, alerted — and NO debate. Only the 1H engulf (Playbook A,
// with its 4H trend filter) may convene one. These are source-level guards
// because the behaviour lives inside checkEngulfingSignal, which cannot be
// imported without booting the whole trading server.
const fs = require('fs');
const path = require('path');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('GUARD: only a 1H engulf can convene the debate', () => {
  const calls = SERVER.match(/triggerPlaybookDebate\(\{\s*playbook:\s*'A'/g) || [];
  assert.ok(calls.length >= 1, 'the Playbook A debate trigger disappeared entirely');
  // Every engulf-path debate trigger must sit behind a key === '1h' test.
  assert.match(SERVER, /if \(key === '1h' && playbookAFullyAligned\) \{\s*\n\s*triggerPlaybookDebate/);
});

// 2026-09-01: the engulf TRIGGER was loosened to fire on a 1H bias alone, with
// the 4H's answer attached as evidence rather than used as a veto. The debate
// deliberately did NOT follow, because it is the path that can emit a
// TRADE_TICKET — the only route in this app to a real order — and inheriting a
// ~6.7x looser trigger would have multiplied order-adjacent activity off an
// instruction that was about alerts. This guards that gap from being closed by
// accident: closing it is a decision, and should have to edit this test too.
test('GUARD: the debate still requires a CONFIRMED 4H, not merely a 1H bias', () => {
  const decl = SERVER.match(/const playbookAFullyAligned = [^;]+;/);
  assert.ok(decl, 'playbookAFullyAligned disappeared — did the debate silently follow the trigger?');
  assert.match(decl[0], /htfRead\.ok/);
  assert.match(decl[0], /CONFIRMATION\.CONFIRMED/,
    'the debate must require the 4H to have actually confirmed');
});

test('GUARD: all four engulf timeframes are registered and auto-armed', () => {
  for (const tf of ["'1h'", "'30m'", "'15m'", "'5m'"]) {
    assert.ok(SERVER.includes('startEngulfMonitor(' + tf + ')'),
      tf + ' is not armed in ALL_MONITORS — a watcher that is not in that list never auto-starts');
  }
  assert.match(SERVER, /'5m':\s*\{\s*tfCode:\s*'5'/, '5M is missing from ENGULF_TFS');
});

test('GUARD: the fire path still drops the forming bar — alerts are closed-candle only', () => {
  assert.ok(SERVER.includes('playbookC.dropFormingBar'),
    'dropFormingBar vanished from the engulf path — alerts could fire mid-candle');
});
