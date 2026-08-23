'use strict';
// ── Quality/invariant tests for point-value-verify.js (2026-08-23) ─────────
// Randomised, seed-reproducible property checks. Small module, but it feeds
// the number every P&L figure in the app is multiplied by — a fuzz pass here
// is cheap insurance against a boundary the hand-written cases didn't think
// to try.
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyPointValue, tickSizeFrom } = require('../point-value-verify');

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
const N_TRIALS = 500;
const STATUSES = new Set(['unknown', 'untracked', 'match', 'mismatch']);

function fmtSeed(i) { return `seed=${SEED} trial=${i}`; }

test(`PROPERTY: status is always one of the four known values, and ok is false iff status is "mismatch" (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const expected = rand() < 0.2 ? null : Math.round(rand() * 20 * 100) / 100;
    const info = rand() < 0.15 ? null : {
      pointvalue: rand() < 0.15 ? null : Math.round(rand() * 20 * 100) / 100,
      minmov: Math.round(rand() * 100),
      pricescale: [1, 10, 100, 1000][Math.floor(rand() * 4)],
    };
    const r = verifyPointValue('MNQU6', expected, info);
    assert.ok(STATUSES.has(r.status), `${fmtSeed(i)}: unknown status "${r.status}"`);
    assert.equal(r.ok, r.status !== 'mismatch', `${fmtSeed(i)}: ok/status inconsistency — status=${r.status} ok=${r.ok}`);
  }
});

test(`PROPERTY: the "expected" input is always echoed back UNCHANGED, regardless of what TradingView reports (${N_TRIALS} trials)`, () => {
  // The single highest-stakes property of this module: it must never
  // substitute its own opinion for the app's configured value.
  for (let i = 0; i < N_TRIALS; i++) {
    const expected = rand() < 0.2 ? null : Math.round(rand() * 20 * 10000) / 10000;
    const info = { pointvalue: Math.round(rand() * 20 * 10000) / 10000, minmov: 25, pricescale: 100 };
    const r = verifyPointValue('MNQU6', expected, info);
    assert.equal(r.expected, expected, `${fmtSeed(i)}: expected value was altered — this module must be advisory-only`);
  }
});

test(`PROPERTY: equal expected/reported (within float tolerance) always reports "match", never "mismatch" (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const base = rand() * 20;
    const noise = (rand() - 0.5) * 1e-10; // well under the module's 1e-9 epsilon
    const r = verifyPointValue('MNQU6', base, { pointvalue: base + noise, minmov: 1, pricescale: 1 });
    assert.equal(r.status, 'match', `${fmtSeed(i)}: equal-within-tolerance values (${base} vs ${base + noise}) reported as ${r.status}`);
  }
});

test(`PROPERTY: a reported value more than 1% off the expected one is always flagged as "mismatch" (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const expected = 0.5 + rand() * 20;
    const direction = rand() < 0.5 ? 1 : -1;
    const reported = expected + direction * expected * (0.05 + rand() * 0.5); // 5%-55% off
    const r = verifyPointValue('MNQU6', expected, { pointvalue: reported, minmov: 1, pricescale: 1 });
    assert.equal(r.status, 'mismatch', `${fmtSeed(i)}: expected=${expected} reported=${reported} should mismatch`);
  }
});

test(`PROPERTY: tickValue, when computable, always equals tickSize * reported exactly (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const pointvalue = Math.round(rand() * 50 * 100) / 100;
    const minmov = 1 + Math.floor(rand() * 100);
    const pricescale = [1, 10, 100, 1000, 10000][Math.floor(rand() * 5)];
    const r = verifyPointValue('SYM', pointvalue, { pointvalue, minmov, pricescale });
    if (r.tickValue == null) continue;
    const expectedTickValue = (minmov / pricescale) * pointvalue;
    assert.ok(Math.abs(r.tickValue - expectedTickValue) < 1e-9, `${fmtSeed(i)}: tickValue mismatch — got ${r.tickValue}, expected ${expectedTickValue}`);
  }
});

test(`PROPERTY: no field is ever NaN or Infinity, across fully adversarial "info" shapes (${N_TRIALS} trials)`, () => {
  const junkValues = [null, undefined, NaN, Infinity, -Infinity, 'x', '5', {}, [], 0, -1];
  for (let i = 0; i < N_TRIALS; i++) {
    const info = {
      pointvalue: junkValues[Math.floor(rand() * junkValues.length)],
      minmov: junkValues[Math.floor(rand() * junkValues.length)],
      pricescale: junkValues[Math.floor(rand() * junkValues.length)],
    };
    const expected = rand() < 0.3 ? null : rand() * 10;
    const r = verifyPointValue('SYM', expected, info);
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number') {
        assert.ok(Number.isFinite(v), `${fmtSeed(i)}: field "${k}"=${v} is not finite for info=${JSON.stringify(info)}`);
      }
    }
  }
});

test(`PROPERTY: verifyPointValue never mutates the "info" object it is given (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const info = Object.freeze({ pointvalue: rand() * 10, minmov: 25, pricescale: 100 });
    assert.doesNotThrow(() => verifyPointValue('SYM', rand() * 10, info), `${fmtSeed(i)}: must not mutate a frozen info object`);
  }
});

test(`PROPERTY: calling twice with identical inputs is fully deterministic (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const expected = rand() * 10;
    const info = { pointvalue: rand() * 10, minmov: 25, pricescale: 100 };
    const a = verifyPointValue('SYM', expected, info);
    const b = verifyPointValue('SYM', expected, info);
    assert.deepEqual(a, b, `${fmtSeed(i)}: identical inputs must produce identical output`);
  }
});

test(`PROPERTY: tickSizeFrom is always minmov/pricescale exactly, or null when pricescale is 0/absent (${N_TRIALS} trials)`, () => {
  for (let i = 0; i < N_TRIALS; i++) {
    const minmov = rand() * 100;
    const pricescale = rand() < 0.1 ? 0 : rand() * 1000;
    const r = tickSizeFrom({ minmov, pricescale });
    if (pricescale === 0) {
      assert.equal(r, null, `${fmtSeed(i)}: division by zero pricescale must return null, not Infinity/NaN`);
    } else {
      assert.ok(Math.abs(r - minmov / pricescale) < 1e-12, `${fmtSeed(i)}: tickSizeFrom arithmetic mismatch`);
    }
  }
});
