'use strict';
// ── Quality/invariant tests for signal-outcome.js (2026-08-23) ─────────────
// Randomised, seed-reproducible checks of properties that must hold for
// EVERY input, complementing the hand-picked cases in
// test/signal-outcome.test.js. This module scores every armed signal
// (taken or not) against real bars — a quiet sign error or an off-by-one
// here would bias every per-playbook statistic without ever throwing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSignalOutcome, aggregateOutcomes } = require('../signal-outcome');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260823;
const rand = mulberry32(SEED);
const N_TRIALS = 400;
const T0 = Date.parse('2026-08-20T10:00:00Z') / 1000;

function fmtSeed(i) { return `seed=${SEED} trial=${i}`; }

// Random OHLC-consistent bar: high >= max(open,close), low <= min(open,close).
function randomBar(rng, idx, center) {
  const range = 2 + rng() * 8;
  const o = center + (rng() - 0.5) * range;
  const c = center + (rng() - 0.5) * range;
  const hi = Math.max(o, c) + rng() * range;
  const lo = Math.min(o, c) - rng() * range;
  return { time: T0 + (idx + 1) * 60, open: o, close: c, high: hi, low: lo };
}

function randomBars(rng, n, center) {
  return Array.from({ length: n }, (_, i) => randomBar(rng, i, center));
}

function sig(overrides) {
  return Object.assign({
    ts: '2026-08-20T10:00:00Z', event: 'engulf-fire', playbook: 'A', tf: '15',
    direction: 'BULLISH', level: 100,
  }, overrides || {});
}

test(`PROPERTY: mfe and mae are always >= 0, for any bars and direction (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const dir = rand() < 0.5 ? 'BULLISH' : 'BEARISH';
    const level = 50 + rand() * 100;
    const bars = randomBars(rand, 12, level);
    const r = resolveSignalOutcome(sig({ direction: dir, level }), bars, { horizonBars: 12 });
    if (!r.resolved) continue;
    assert.ok(r.mfe >= 0, `${fmtSeed(i)}: mfe must never be negative, got ${r.mfe}`);
    assert.ok(r.mae >= 0, `${fmtSeed(i)}: mae must never be negative, got ${r.mae}`);
  }
});

test(`PROPERTY: reflection symmetry — mirroring bars about the level and flipping direction gives identical mfe/mae (${N_TRIALS} trials)`, () => {
  // If BULLISH favourable excursion is (high - level), then reflecting every
  // bar about the level (hi' = 2*level - lo, lo' = 2*level - hi) and scoring
  // BEARISH must reproduce EXACTLY the same mfe/mae. This is a structural
  // property of the sign-handling code, not a numeric coincidence — a sign
  // bug in one branch but not the other would break this while every
  // hand-picked example still happened to pass.
  for (let i = 0; i < N_TRIALS; i++) {
    const level = 50 + rand() * 100;
    const bars = randomBars(rand, 12, level);
    const mirrored = bars.map((b) => ({
      time: b.time,
      high: 2 * level - b.low,
      low: 2 * level - b.high,
      close: 2 * level - b.close,
    }));
    const bull = resolveSignalOutcome(sig({ direction: 'BULLISH', level }), bars, { horizonBars: 12 });
    const bear = resolveSignalOutcome(sig({ direction: 'BEARISH', level }), mirrored, { horizonBars: 12 });
    if (!bull.resolved || !bear.resolved) continue;
    assert.ok(Math.abs(bull.mfe - bear.mfe) < 1e-9, `${fmtSeed(i)}: mfe should be reflection-symmetric — bull=${bull.mfe} bear=${bear.mfe}`);
    assert.ok(Math.abs(bull.mae - bear.mae) < 1e-9, `${fmtSeed(i)}: mae should be reflection-symmetric — bull=${bull.mae} bear=${bear.mae}`);
  }
});

test(`PROPERTY: only bars strictly after the signal ever affect the result (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const level = 100;
    const real = randomBars(rand, 12, level);
    const withPreBar = [{ time: T0 - 60, high: level + 10000, low: level - 10000, close: level }, ...real];
    const a = resolveSignalOutcome(sig({ level }), real, { horizonBars: 12 });
    const b = resolveSignalOutcome(sig({ level }), withPreBar, { horizonBars: 12 });
    if (!a.resolved || !b.resolved) continue;
    assert.deepEqual(a.mfe, b.mfe, `${fmtSeed(i)}: a bar at/before the signal must not change mfe`);
    assert.deepEqual(a.mae, b.mae, `${fmtSeed(i)}: a bar at/before the signal must not change mae`);
  }
});

test(`PROPERTY: bar order in the input array never matters — only bar TIME does (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const bars = randomBars(rand, 10, 100);
    const shuffled = bars.slice();
    // Fisher-Yates using the same seeded generator.
    for (let k = shuffled.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
    }
    const a = resolveSignalOutcome(sig(), bars, { horizonBars: 10 });
    const b = resolveSignalOutcome(sig(), shuffled, { horizonBars: 10 });
    if (!a.resolved || !b.resolved) continue;
    assert.equal(a.mfe, b.mfe, `${fmtSeed(i)}: shuffled input order changed mfe`);
    assert.equal(a.mae, b.mae, `${fmtSeed(i)}: shuffled input order changed mae`);
    assert.equal(a.atHorizon, b.atHorizon, `${fmtSeed(i)}: shuffled input order changed atHorizon`);
  }
});

test(`PROPERTY: the function never mutates the bars array or its objects (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const bars = randomBars(rand, 10, 100).map(Object.freeze);
    Object.freeze(bars);
    assert.doesNotThrow(() => resolveSignalOutcome(sig(), bars, { horizonBars: 10 }), `${fmtSeed(i)}: must not mutate frozen bars`);
  }
});

test(`PROPERTY: edgeRatio is always null or a non-negative finite number, never Infinity/NaN (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const bars = randomBars(rand, 12, 100);
    const r = resolveSignalOutcome(sig(), bars, { horizonBars: 12 });
    if (!r.resolved) continue;
    if (r.edgeRatio !== null) {
      assert.ok(Number.isFinite(r.edgeRatio), `${fmtSeed(i)}: edgeRatio must be finite, got ${r.edgeRatio}`);
      assert.ok(r.edgeRatio >= 0, `${fmtSeed(i)}: edgeRatio must be non-negative, got ${r.edgeRatio}`);
    }
  }
});

test(`PROPERTY: hit, when non-null, always has a valid index within the scored window (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const bars = randomBars(rand, 12, 100);
    const target = 2 + rand() * 8;
    const stop = 2 + rand() * 8;
    const r = resolveSignalOutcome(sig(), bars, { horizonBars: 12, targetPoints: target, stopPoints: stop });
    if (!r.resolved || r.hit == null) continue;
    assert.ok(Number.isInteger(r.hitBarIndex) && r.hitBarIndex >= 0 && r.hitBarIndex < 12,
      `${fmtSeed(i)}: hitBarIndex ${r.hitBarIndex} out of window range for a hit of "${r.hit}"`);
  }
});

test(`PROPERTY: shrinking the horizon can only change "resolved" from true to a pending state, never fabricate a different resolved outcome (${N_TRIALS / 2} trials)`, () => {
  // Resolving at horizon 12 and re-deriving at horizon 6 from the SAME first
  // six bars must agree on mfe/mae computed over those six bars — the
  // function must not be reading anything beyond the window it claims.
  for (let i = 0; i < N_TRIALS / 2; i++) {
    const bars = randomBars(rand, 12, 100);
    const full = resolveSignalOutcome(sig(), bars, { horizonBars: 12 });
    const short = resolveSignalOutcome(sig(), bars.slice(0, 6), { horizonBars: 6 });
    if (!full.resolved || !short.resolved) continue;
    // mfe/mae over 6 bars must be <= the values over 12 bars (excursions can
    // only grow or stay flat as more bars are added).
    assert.ok(short.mfe <= full.mfe + 1e-9, `${fmtSeed(i)}: 6-bar mfe (${short.mfe}) exceeds 12-bar mfe (${full.mfe})`);
    assert.ok(short.mae <= full.mae + 1e-9, `${fmtSeed(i)}: 6-bar mae (${short.mae}) exceeds 12-bar mae (${full.mae})`);
  }
});

// ── aggregateOutcomes ────────────────────────────────────────────────────────

test(`PROPERTY: aggregate winRate and targetRate are always in [0, 1] or null (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const rows = Array.from({ length: 1 + Math.floor(rand() * 20) }, () => ({
      resolved: true,
      playbook: rand() < 0.5 ? 'A' : 'B',
      tf: rand() < 0.5 ? '15' : '5',
      favourable: rand() < 0.5,
      mfe: rand() * 10,
      mae: rand() * 10,
      atHorizon: (rand() - 0.5) * 10,
      hit: rand() < 0.3 ? 'target' : (rand() < 0.5 ? 'stop' : null),
    }));
    for (const agg of aggregateOutcomes(rows)) {
      assert.ok(agg.winRate === null || (agg.winRate >= 0 && agg.winRate <= 1), `${fmtSeed(i)}: winRate out of range: ${agg.winRate}`);
      assert.ok(agg.targetRate === null || (agg.targetRate >= 0 && agg.targetRate <= 1), `${fmtSeed(i)}: targetRate out of range: ${agg.targetRate}`);
      assert.ok(agg.n > 0, `${fmtSeed(i)}: a bucket must never be empty`);
    }
  }
});

test(`PROPERTY: aggregate n always equals the count of resolved rows in that bucket, unresolved rows never counted (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const rows = [];
    const expectedN = new Map();
    const total = 1 + Math.floor(rand() * 20);
    for (let k = 0; k < total; k++) {
      const playbook = rand() < 0.5 ? 'A' : 'B';
      const tf = rand() < 0.5 ? '15' : '5';
      const resolved = rand() < 0.7;
      if (resolved) {
        const key = `${playbook}|${tf}`;
        expectedN.set(key, (expectedN.get(key) || 0) + 1);
      }
      rows.push({ resolved, playbook, tf, favourable: rand() < 0.5, mfe: 1, mae: 1, atHorizon: 1 });
    }
    for (const agg of aggregateOutcomes(rows)) {
      const key = `${agg.playbook}|${agg.tf}`;
      assert.equal(agg.n, expectedN.get(key), `${fmtSeed(i)}: bucket ${key} count mismatch`);
    }
  }
});
