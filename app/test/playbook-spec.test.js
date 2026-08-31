'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PLAYBOOKS, getPlaybook, planEntry, setupId } = require('../playbook-spec.js');

const RULES = { playbooks: { stopBufferPoints: 3, targetR: 2, fvgFillWindowBars: 8 }, perTradeMaxLoss: 300 };
const bar = (o, h, l, c, t = 1000) => ({ open: o, high: h, low: l, close: c, time: t });

// ── The identity question this module exists to settle ──────────────────────
test('Playbook C is a GATE and refuses to propose an entry', () => {
  const r = planEntry('C', { direction: 'BULLISH', bar: bar(10, 12, 8, 11) }, RULES);
  assert.equal(r.plannable, false);
  assert.match(r.reason, /gate, not a setup/);
});

test('the 30M engulf the app labels "Playbook C" is exposed as its own unsanctioned id', () => {
  const pb = getPlaybook('LTF-ENGULF');
  assert.equal(pb.unsanctioned, true);
  assert.match(pb.source, /appears in no rulebook/);
  // and it explicitly documents the absence of an HTF gate — the thing that
  // distinguishes it from Playbook A
  assert.ok(pb.steps.some((s) => /NO higher-timeframe alignment/.test(s.text)));
});

test('every playbook has ordered, numbered steps', () => {
  for (const id of Object.keys(PLAYBOOKS)) {
    const steps = PLAYBOOKS[id].steps;
    assert.ok(steps.length > 0, `${id} has no steps`);
    steps.forEach((s, i) => assert.equal(s.n, i + 1, `${id} step ${i} misnumbered`));
  }
});

// ── Entry geometry ──────────────────────────────────────────────────────────
test('engulf entry is the trigger bar close; stop is beyond its extreme', () => {
  const r = planEntry('A', { direction: 'BULLISH', bar: bar(100, 110, 95, 108) }, RULES);
  assert.equal(r.entry, 108);
  assert.equal(r.stop, 92);            // low 95 - buffer 3
  assert.equal(r.riskPoints, 16);
  assert.equal(r.target, 108 + 32);    // 2R
  assert.equal(r.requiresFill, false);
});

test('bearish engulf mirrors', () => {
  const r = planEntry('A', { direction: 'BEARISH', bar: bar(110, 115, 100, 102) }, RULES);
  assert.equal(r.entry, 102);
  assert.equal(r.stop, 118);
  assert.equal(r.riskPoints, 16);
  assert.equal(r.target, 102 - 32);
});

test('Playbook B enters at the NEAR gap edge — the first price a retrace touches', () => {
  // bullish gap spans [gapLow, gapHigh]; price sits ABOVE it, so it falls to gapHigh first
  const r = planEntry('B', { direction: 'BULLISH', gapLow: 100, gapHigh: 105, wick: 96 }, RULES);
  assert.equal(r.entry, 105);
  assert.equal(r.stop, 93);            // wick 96 - buffer 3
  assert.equal(r.requiresFill, true);
  assert.equal(r.fillWindowBars, 8);

  const s = planEntry('B', { direction: 'BEARISH', gapLow: 100, gapHigh: 105, wick: 109 }, RULES);
  assert.equal(s.entry, 100);          // price sits BELOW, rises to gapLow first
  assert.equal(s.stop, 112);
});

test('Playbook B stop uses the SFP WICK, not the swept level', () => {
  const withWick = planEntry('B', { direction: 'BULLISH', gapLow: 100, gapHigh: 105, wick: 90, level: 98 }, RULES);
  assert.equal(withWick.stop, 87);
  assert.equal(withWick.stopSource, 'sfp-wick');
});

test('missing wick falls back to the level but SAYS SO — a tighter stop must not pass silently', () => {
  const r = planEntry('B', { direction: 'BULLISH', gapLow: 100, gapHigh: 105, level: 98 }, RULES);
  assert.equal(r.stop, 95);
  assert.match(r.stopSource, /WICK NOT CAPTURED/);
});

// ── TRUST-PROTOCOL Rule 1: refuse rather than guess ─────────────────────────
test('refuses when the stop would land on the wrong side of the entry', () => {
  // a bullish setup whose "wick" is above the entry produces negative risk
  const r = planEntry('B', { direction: 'BULLISH', gapLow: 100, gapHigh: 105, wick: 200 }, RULES);
  assert.equal(r.plannable, false);
  assert.match(r.reason, /not beyond entry/);
});

test('refuses on missing prices rather than returning a plan built on NaN', () => {
  assert.equal(planEntry('A', { direction: 'BULLISH', bar: { close: 100 } }, RULES).plannable, false);
  assert.equal(planEntry('B', { direction: 'BULLISH', gapLow: 100 }, RULES).plannable, false);
  assert.equal(planEntry('B', { direction: 'BULLISH', gapLow: 100, gapHigh: 105 }, RULES).plannable, false); // no stop reference
  assert.equal(planEntry('A', { direction: null, bar: bar(1, 2, 0, 1) }, RULES).plannable, false);
  assert.equal(planEntry('NOPE', { direction: 'BULLISH', bar: bar(1, 2, 0, 1) }, RULES).plannable, false);
});

test('never returns a non-finite price', () => {
  const r = planEntry('A', { direction: 'BULLISH', bar: bar(100, 110, 95, 108) }, RULES);
  for (const k of ['entry', 'stop', 'target', 'riskPoints']) {
    assert.ok(Number.isFinite(r[k]), `${k} is not finite`);
  }
});

test('falls back to safe defaults when rules are absent, never throwing', () => {
  const r = planEntry('A', { direction: 'BULLISH', bar: bar(100, 110, 95, 108) }, null);
  assert.equal(r.plannable, true);
  assert.ok(r.riskPoints > 0);
});

// ── setupId: the fix for the re-fire bug seen in the live ledger ────────────
test('the same gap yields the same id no matter how often it is re-detected', () => {
  const s = { direction: 'BULLISH', gapLow: 29137.5, gapHigh: 29156.75, level: 29100 };
  assert.equal(setupId('B', s), setupId('B', { ...s }));
});

test('different gaps yield different ids', () => {
  const a = setupId('B', { direction: 'BULLISH', gapLow: 100, gapHigh: 105, level: 98 });
  const b = setupId('B', { direction: 'BULLISH', gapLow: 100, gapHigh: 106, level: 98 });
  assert.notEqual(a, b);
});

test('an engulf is identified by its own bar time, so re-polling one candle is one setup', () => {
  const a = setupId('A', { direction: 'BULLISH', barTime: 1700000000, entryRef: 100 });
  const b = setupId('A', { direction: 'BULLISH', barTime: 1700000000, entryRef: 100 });
  const c = setupId('A', { direction: 'BULLISH', barTime: 1700001800, entryRef: 100 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('direction is part of identity — opposite setups never collide', () => {
  const bull = setupId('B', { direction: 'BULLISH', gapLow: 100, gapHigh: 105, level: 98 });
  const bear = setupId('B', { direction: 'BEARISH', gapLow: 100, gapHigh: 105, level: 98 });
  assert.notEqual(bull, bear);
});
