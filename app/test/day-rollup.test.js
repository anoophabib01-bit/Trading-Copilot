'use strict';
// day-rollup.js — committed tests (4.2). The committed fixture is hand-crafted
// (real P&L never goes in the repo — see DATA/ in .gitignore). The REAL-data
// golden verification lives in day-rollup-live-golden.test.js and runs only
// where the production DATA dir exists; its first run on Anoop's machine
// passed byte-identical on the real 2026-08-21 day (14 trades, all 32 fields,
// historical sizeCap 4) and matched grades on 2026-08-18 — recorded in the
// plan's 4.2 Done line.
const test = require('node:test');
const assert = require('node:assert/strict');
const { gradeTrades, rollupDay, tradingDayKey } = require('../renderer/day-rollup.js');
const dayRollup = require('../renderer/day-rollup.js');

const WINS = [{ name: 'London', startMin: 810, endMin: 900 }, { name: 'NY', startMin: 1140, endMin: 1260 }];
// 2026-08-10 is a Monday. Times are IST wall-clock.
const base = Date.parse('2026-08-10T00:00:00+05:30');
const mk = (h, m) => base + (h * 60 + m) * 60000;
const ROWS = [
  { entryMs: mk(9, 0),  exitMs: mk(9, 5),  entryMin: 540,  holdSec: 300,  size: 2, pnl: 40 },
  { entryMs: mk(9, 20), exitMs: mk(9, 40), entryMin: 560,  holdSec: 1200, size: 5, pnl: -60 },
  { entryMs: mk(13, 30), exitMs: mk(13, 40), entryMin: 810, holdSec: 600,  size: 2, pnl: 25 },
  { entryMs: mk(13, 45), exitMs: mk(13, 48), entryMin: 825, holdSec: 180,  size: 3, pnl: -15 },
  { entryMs: mk(19, 10), exitMs: mk(19, 12), entryMin: 1150, holdSec: 120,  size: 2, pnl: -10 },
  { entryMs: mk(19, 15), exitMs: mk(19, 16), entryMin: 1155, holdSec: 60,   size: 6, pnl: -20 },
  { entryMs: mk(19, 40), exitMs: mk(19, 44), entryMin: 1180, holdSec: 240,  size: 2, pnl: 50 },
];
const SIDES = ['LONG', 'LONG', 'SHORT', 'SHORT', 'LONG', 'LONG', 'SHORT'];
const gradedRows = () => gradeTrades(ROWS.map((r, i) => Object.assign({}, r, { side: SIDES[i] })), {
  tradingMode: 'standard', sessionWindowsIST: WINS, sizeCapCsv: 4
});

test('gradeTrades reproduces the production grading rules', () => {
  const g = gradedRows();
  assert.deepEqual(g.map(r => r.g), ['B', 'C', 'A', 'B', 'A', 'C', 'A']);
  assert.deepEqual(g[0].flags, ['out-of-window']);
  assert.deepEqual(g[1].flags, ['oversize', 'out-of-window']);
  assert.deepEqual(g[2].flags, []);
  assert.deepEqual(g[3].flags, ['revenge']);
  assert.deepEqual(g[4].flags, []);
  assert.deepEqual(g[5].flags, ['oversize', 'revenge']);
  assert.deepEqual(g[6].flags, []);
});

test('gradeTrades is pure — input rows are not mutated', () => {
  const input = ROWS.map(r => Object.assign({}, r));
  gradeTrades(input, { tradingMode: 'standard', sessionWindowsIST: WINS, sizeCapCsv: 4 });
  assert.equal(input[0].g, undefined);
  assert.equal(input[0].flags, undefined);
});

test('scalper mode adds the hold-exceeded flag and loss-only cooldown', () => {
  const rows = [
    { entryMs: mk(19, 0), exitMs: mk(19, 1), entryMin: 1140, holdSec: 2000, size: 1, pnl: -5 },
    { entryMs: mk(19, 3), exitMs: mk(19, 4), entryMin: 1143, holdSec: 300, size: 1, pnl: 10 },
  ];
  const g = gradeTrades(rows, { tradingMode: 'scalper', cooldownAfterLossOnly: true, maxHoldSeconds: 1800, sessionWindowsIST: WINS, sizeCapCsv: 4 });
  assert.deepEqual(g[0].flags, ['hold-exceeded']); // loss itself → cooldown starts AFTER it
  // loss-only cooldown: the second entry 3 min after the LOSS exit is revenge
  assert.ok(g[1].flags.includes('revenge'));
});

test('rollupDay reproduces the hand-computed day summary exactly', () => {
  const rows = gradedRows().map(r => ({
    t: r.entryMs, x: r.exitMs, size: r.size, pnl: r.pnl, g: r.g, flags: r.flags,
    side: r.side, ep: null, xp: null, mp: null, hold: r.holdSec
  }));
  const sum = rollupDay('2026-08-10', rows, { commPerCt: 1.0, sizeCapCsv: 4, tradingMode: 'standard' });
  assert.deepEqual(sum, {
    date: '2026-08-10', dow: 1, n: 7, pnl: -12, gross: 10, contracts: 22,
    maxSize: 6, over: 2, revenge: 2, disc: 79, best: 50, worst: -60,
    avgWin: 115 / 3, avgLoss: -105 / 4, avgHold: 386, medHold: 240,
    avgGap: 5990, firstThreeMax: 5, sizedUpIntoLoss: true, bigAfterWins: false,
    under5: 4, over15: 1, wins: 3, losses: 4, peak: 40, giveback: 30,
    flips: 0, maxConsecLoss: 3, tradedPast3Losses: true,
    tradingMode: 'standard', holdExceeded: 0, commPerCt: 1.0
  });
});

test('tradingDayKey anchors to the 03:45 IST rollover', () => {
  assert.equal(tradingDayKey(Date.parse('2026-08-18T09:00:00+05:30')), '2026-08-18');
  assert.equal(tradingDayKey(Date.parse('2026-08-18T00:30:00+05:30')), '2026-08-17'); // 00:30 IST is pre-rollover
  assert.equal(tradingDayKey(Date.parse('2026-08-18T03:46:00+05:30')), '2026-08-18');
});

// ── normalizeSide (4.3 audit fix) ───────────────────────────────────────────
// The stored row vocabulary is LONG/SHORT; the live broker feed speaks
// buy/sell. Writing the raw broker word into the row made MAE/MFE read every
// live BUY as a short and made the 4.5 tolerance identity reject a live row
// against its own CSV (side mismatch) — re-opening the doubling landmine.
test('normalizeSide maps the broker vocabulary onto the stored row vocabulary', () => {
  assert.equal(dayRollup.normalizeSide('buy'), 'LONG');
  assert.equal(dayRollup.normalizeSide('sell'), 'SHORT');
  assert.equal(dayRollup.normalizeSide('BUY'), 'LONG');
  assert.equal(dayRollup.normalizeSide('Sell'), 'SHORT');
});

test('normalizeSide passes the stored vocabulary through untouched', () => {
  assert.equal(dayRollup.normalizeSide('LONG'), 'LONG');
  assert.equal(dayRollup.normalizeSide('short'), 'SHORT');
});

test('normalizeSide returns null rather than guessing on absent/garbage input', () => {
  assert.equal(dayRollup.normalizeSide(null), null);
  assert.equal(dayRollup.normalizeSide(undefined), null);
  assert.equal(dayRollup.normalizeSide(''), null);
  assert.equal(dayRollup.normalizeSide('  '), null);
  assert.equal(dayRollup.normalizeSide('flat'), null);
  assert.equal(dayRollup.normalizeSide(0), null);
});
