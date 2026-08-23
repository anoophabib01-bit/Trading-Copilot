'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAmdPhase } = require('../amd-phase.js');

const SESSION_START = 1000000;
const BAR_SEC = 15 * 60; // 15m bars
const t = (n) => SESSION_START + n * BAR_SEC; // nth bar's timestamp

test('no bias established → UNCLEAR, gate blocks the call', () => {
  const bars = [{ time: t(0), high: 100, low: 90, close: 95 }];
  const r = computeAmdPhase(bars, 'unclear', SESSION_START, 4);
  assert.equal(r.phase, 'UNCLEAR');
  assert.match(r.reason, /bias not established/);
});

test('no bars at all → UNCLEAR', () => {
  const r = computeAmdPhase([], 'bullish', SESSION_START, 4);
  assert.equal(r.phase, 'UNCLEAR');
  assert.match(r.reason, /no bars/);
});

test('fewer than 2 session bars → too early to judge', () => {
  const bars = [{ time: t(0), high: 100, low: 90, close: 95 }];
  const r = computeAmdPhase(bars, 'bullish', SESSION_START, 4);
  assert.equal(r.phase, 'UNCLEAR');
  assert.match(r.reason, /too early/);
});

test('still inside the opening range → ACCUMULATION', () => {
  const bars = [0, 1, 2].map((i) => ({ time: t(i), high: 100, low: 90, close: 95 }));
  const r = computeAmdPhase(bars, 'bullish', SESSION_START, 4);
  assert.equal(r.phase, 'ACCUMULATION');
  assert.equal(r.rangeHigh, 100);
  assert.equal(r.rangeLow, 90);
});

test('after opening range, price still contained → ACCUMULATION', () => {
  const opening = [0, 1, 2, 3].map((i) => ({ time: t(i), high: 100, low: 90, close: 95 }));
  const after = [{ time: t(4), high: 99, low: 91, close: 95 }]; // inside 90-100
  const r = computeAmdPhase([...opening, ...after], 'bullish', SESSION_START, 4);
  assert.equal(r.phase, 'ACCUMULATION');
  assert.match(r.reason, /still contained/);
});

test('bullish bias, sweep DOWN below range then reclaim → DISTRIBUTION (manipulation complete)', () => {
  const opening = [0, 1, 2, 3].map((i) => ({ time: t(i), high: 100, low: 90, close: 95 }));
  const sweep = { time: t(4), high: 91, low: 85, close: 88 };   // sweeps below rangeLow=90
  const reclaim = { time: t(5), high: 96, low: 92, close: 94 }; // closes back above rangeLow=90
  const r = computeAmdPhase([...opening, sweep, reclaim], 'bullish', SESSION_START, 4);
  assert.equal(r.phase, 'DISTRIBUTION');
  assert.equal(r.sweptTo, 85);
  assert.match(r.detail, /ENTRY-RELEVANT/);
});

test('bullish bias, sweep DOWN but no reclaim yet → MANIPULATION', () => {
  const opening = [0, 1, 2, 3].map((i) => ({ time: t(i), high: 100, low: 90, close: 95 }));
  const sweep = { time: t(4), high: 91, low: 85, close: 87 }; // sweeps below rangeLow, closes below it too
  const r = computeAmdPhase([...opening, sweep], 'bullish', SESSION_START, 4);
  assert.equal(r.phase, 'MANIPULATION');
  assert.equal(r.sweptTo, 85);
  assert.match(r.detail, /NOT yet an entry/);
});

test('bearish bias, sweep UP above range then reclaim → DISTRIBUTION', () => {
  const opening = [0, 1, 2, 3].map((i) => ({ time: t(i), high: 100, low: 90, close: 95 }));
  const sweep = { time: t(4), high: 105, low: 99, close: 102 };  // sweeps above rangeHigh=100
  const reclaim = { time: t(5), high: 99, low: 94, close: 96 };  // closes back below rangeHigh=100
  const r = computeAmdPhase([...opening, sweep, reclaim], 'bearish', SESSION_START, 4);
  assert.equal(r.phase, 'DISTRIBUTION');
  assert.equal(r.sweptTo, 105);
});

test('bullish bias, price runs WITH bias beyond range with no counter-sweep → DISTRIBUTION, no trap', () => {
  const opening = [0, 1, 2, 3].map((i) => ({ time: t(i), high: 100, low: 90, close: 95 }));
  const runUp = { time: t(4), high: 106, low: 96, close: 104 }; // breaks above rangeHigh, never swept low first
  const r = computeAmdPhase([...opening, runUp], 'bullish', SESSION_START, 4);
  assert.equal(r.phase, 'DISTRIBUTION');
  assert.match(r.reason, /no manipulation trap was set/);
});

test('THE HARD GATE: an unclear bias never produces a phase, no matter how clean the structure looks', () => {
  const opening = [0, 1, 2, 3].map((i) => ({ time: t(i), high: 100, low: 90, close: 95 }));
  const textbookSweepAndReclaim = [
    { time: t(4), high: 91, low: 85, close: 88 },
    { time: t(5), high: 96, low: 92, close: 94 },
  ];
  const r = computeAmdPhase([...opening, ...textbookSweepAndReclaim], 'unclear', SESSION_START, 4);
  assert.equal(r.phase, 'UNCLEAR');
});

test('bars before session start are excluded from the opening range', () => {
  const preSession = [{ time: t(-2), high: 500, low: 1, close: 200 }]; // would corrupt the range if included
  const opening = [0, 1, 2, 3].map((i) => ({ time: t(i), high: 100, low: 90, close: 95 }));
  const r = computeAmdPhase([...preSession, ...opening], 'bullish', SESSION_START, 4);
  assert.equal(r.rangeHigh, 100);
  assert.equal(r.rangeLow, 90);
});

test('garbage/malformed bars do not throw', () => {
  assert.doesNotThrow(() => computeAmdPhase(null, 'bullish', SESSION_START, 4));
  assert.doesNotThrow(() => computeAmdPhase([null, undefined, { time: 'x' }], 'bullish', SESSION_START, 4));
});

test('openingBars defaults to 4 when omitted/falsy', () => {
  const bars = [0, 1, 2].map((i) => ({ time: t(i), high: 100, low: 90, close: 95 }));
  const r = computeAmdPhase(bars, 'bullish', SESSION_START, 0);
  assert.equal(r.phase, 'ACCUMULATION');
  assert.match(r.reason, /opening 4-bar range/);
});
