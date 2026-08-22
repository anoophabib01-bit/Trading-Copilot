'use strict';
// 4.5 landmine test: the same trade expressed in live-ms and CSV-coarse
// timestamps must match by tolerance identity — reconciling a live-written
// day with its own CSV must NOT double the trade count.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSameTrade, matchCsvToLive } = require('../renderer/trade-identity.js');

const liveRow = { t: 1787054976000, x: 1787299474000, size: 3, pnl: 12, side: 'LONG' };

test('same trade matches across live-ms vs CSV-coarse timestamps', () => {
  const csvRow = { t: 1787054970000, x: 1787299465000, size: 3, pnl: 12, side: 'LONG' };
  assert.equal(isSameTrade(csvRow, liveRow), true);
});

test('a different trade does not match (exit too far, size differs)', () => {
  assert.equal(isSameTrade({ t: 0, x: 1787299474000 + 5 * 60000, size: 3, pnl: 12, side: 'LONG' }, liveRow), false);
  assert.equal(isSameTrade({ t: 0, x: 1787299474000, size: 2, pnl: 12, side: 'LONG' }, liveRow), false);
  assert.equal(isSameTrade({ t: 0, x: 1787299474000, size: 3, pnl: 12, side: 'SHORT' }, liveRow), false);
});

test('P&L disagreement beyond a cent does not match by identity', () => {
  assert.equal(isSameTrade({ t: 0, x: 1787299474000, size: 3, pnl: 12.5, side: 'LONG' }, liveRow), false);
});

test('reconciling a live-written day with its own CSV doubles nothing', () => {
  const live = [
    { t: 1787054976000, x: 1787299474000, size: 3, pnl: 12, side: 'LONG' },
    { t: 1787055000000, x: 1787300000000, size: 2, pnl: -5, side: 'SHORT' },
  ];
  const csv = [
    { t: 1787054970000, x: 1787299465000, size: 3, pnl: 12, side: 'LONG' },   // coarse timestamps
    { t: 1787054994000, x: 1787299994000, size: 2, pnl: -5, side: 'SHORT' },
  ];
  const r = matchCsvToLive(csv, live);
  assert.equal(r.matched.length, 2);
  assert.equal(r.csvOnly.length, 0);
  assert.equal(r.liveOnly.length, 0);
});

test('a CSV-only trade is reported, not silently dropped or doubled', () => {
  const r = matchCsvToLive([{ t: 0, x: 1787400000000, size: 1, pnl: 7, side: 'LONG' }], [liveRow]);
  assert.equal(r.matched.length, 0);
  assert.equal(r.csvOnly.length, 1);
  assert.equal(r.liveOnly.length, 1);
});

test('one-to-one: two identical CSV rows cannot both match one live row', () => {
  const csv = [
    { t: 1787054970000, x: 1787299465000, size: 3, pnl: 12, side: 'LONG' },
    { t: 1787054970000, x: 1787299465000, size: 3, pnl: 12, side: 'LONG' },
  ];
  const r = matchCsvToLive(csv, [liveRow]);
  assert.equal(r.matched.length, 1);
  assert.equal(r.csvOnly.length, 1);
});

// ── mergeCsvIntoStored: the APPLY side of the landmine (audit, 2026-08-22) ──
// The matchCsvToLive tests above only cover the reconciliation REPORT.
// csvApply — what the "Apply to app" button runs — merged by fp() alone,
// which is precisely the key that cannot be trusted across the two sources.
const { mergeCsvIntoStored } = require('../renderer/trade-identity.js');
const FP = r => r.t + '|' + r.x + '|' + Math.round(r.pnl * 100) + '|' + r.size;

test('APPLY: a CSV over a live-written day does not double the trades', () => {
  const stored = [
    { t: 1787054976000, x: 1787299474000, size: 3, pnl: 12, side: 'LONG', source: 'live' },
    { t: 1787055000000, x: 1787300000000, size: 2, pnl: -5, side: 'SHORT', source: 'live' },
  ];
  const incoming = [
    { t: 1787054970000, x: 1787299465000, size: 3, pnl: 12, side: 'LONG', g: 'A', flags: [] },
    { t: 1787054994000, x: 1787299994000, size: 2, pnl: -5, side: 'SHORT', g: 'B', flags: ['revenge'] },
  ];
  // The old fp()-only merge produced 4 rows here — that was the bug.
  assert.equal(new Map([...stored, ...incoming].map(r => [FP(r), r])).size, 4);
  const merged = mergeCsvIntoStored(stored, incoming, FP);
  assert.equal(merged.length, 2);
  assert.equal(merged.reduce((a, r) => a + r.size, 0), 5);
  assert.equal(merged.reduce((a, r) => a + r.pnl, 0), 7);
});

test('APPLY: the CSV row wins on the fields it has, live provenance survives', () => {
  const stored = [{ t: 1787054976000, x: 1787299474000, size: 3, pnl: 12, side: 'LONG', source: 'live', evidence: 'order-walk', signalBacked: true, playbook: 'B', minutesFromSignal: 4 }];
  const incoming = [{ t: 1787054970000, x: 1787299465000, size: 3, pnl: 12, side: 'LONG', g: 'A', flags: [], ep: 100, xp: 104 }];
  const merged = mergeCsvIntoStored(stored, incoming, FP);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].t, 1787054970000, 'the CSV timestamp wins — the export is the broker record');
  assert.equal(merged[0].g, 'A');
  assert.equal(merged[0].ep, 100);
  assert.equal(merged[0].source, 'live');
  assert.equal(merged[0].evidence, 'order-walk');
  assert.equal(merged[0].signalBacked, true);
  assert.equal(merged[0].playbook, 'B');
  assert.equal(merged[0].minutesFromSignal, 4);
});

test('APPLY: a genuinely new CSV trade is ADDED, a stored row the file lacks is KEPT', () => {
  const stored = [{ t: 1000, x: 2000, size: 1, pnl: 5, side: 'LONG' }];
  const incoming = [{ t: 500000, x: 900000, size: 2, pnl: -9, side: 'SHORT' }];
  const merged = mergeCsvIntoStored(stored, incoming, FP);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(r => r.pnl), [5, -9]);
});

test('APPLY: re-uploading the same CSV over a CSV-written day is still a no-op', () => {
  const rows = [{ t: 1000, x: 2000, size: 1, pnl: 5, side: 'LONG', g: 'A', flags: [] }];
  const merged = mergeCsvIntoStored(rows, rows.map(r => Object.assign({}, r)), FP);
  assert.equal(merged.length, 1);
});

test('APPLY: two same-shaped CSV rows cannot both collapse onto one stored row', () => {
  const stored = [{ t: 1787054976000, x: 1787299474000, size: 3, pnl: 12, side: 'LONG' }];
  const incoming = [
    { t: 1787054970000, x: 1787299465000, size: 3, pnl: 12, side: 'LONG' },
    { t: 1787054971000, x: 1787299466000, size: 3, pnl: 12, side: 'LONG' },
  ];
  const merged = mergeCsvIntoStored(stored, incoming, FP);
  assert.equal(merged.length, 2, 'the second CSV row is a distinct trade, not a re-match');
});

test('APPLY: empty/garbage inputs are safe', () => {
  assert.deepEqual(mergeCsvIntoStored(null, null, FP), []);
  assert.equal(mergeCsvIntoStored([], [{ t: 1, x: 2, size: 1, pnl: 1 }], FP).length, 1);
  assert.equal(mergeCsvIntoStored([{ t: 1, x: 2, size: 1, pnl: 1 }], [], FP).length, 1);
  assert.equal(mergeCsvIntoStored([{ t: 1, x: 2, size: 1, pnl: 1 }], []).length, 1, 'default fp when none supplied');
});
