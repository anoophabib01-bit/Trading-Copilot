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

// ── size 0 means "not observed", not "zero contracts" (2026-08-24) ──────────
// Anoop asked, before importing: "if I reconcile while the live feed is
// active, it shouldn't copy trades again." It did. tv-broker-feed.js records
// a poll-aliased round trip with size 0 + inferred:true because it never saw
// the position open — a sentinel, not a quantity. isSameTrade compared it
// literally, so it could never match the CSV's real size and the same trade
// survived the merge twice: doubled contracts, doubled gross, and doubled the
// size-cap/revenge counts the guardrail enforces on.
const fpKey = r => r.t + '|' + r.x + '|' + Math.round(r.pnl * 100) + '|' + r.size;

test('a live row with unobserved size (0) still matches its CSV counterpart', () => {
  const live = { t: 1000, x: 2000, pnl: 20.5, size: 0, side: 'buy', inferred: true };
  const csv = { t: 1001, x: 2030, pnl: 20.5, size: 1, side: 'buy' };
  assert.equal(isSameTrade(csv, live), true);
});

test('reconciling does not duplicate a trade the fold recorded with size 0', () => {
  const stored = [{ t: 1000, x: 2000, pnl: 20.5, size: 0, side: 'buy', src: 'live-fold-only', inferred: true }];
  const incoming = [{ t: 1001, x: 2030, pnl: 20.5, size: 1, side: 'buy' }];
  const merged = mergeCsvIntoStored(stored, incoming, fpKey);
  assert.equal(merged.length, 1, 'the same trade must not survive the merge twice');
  assert.equal(merged[0].size, 1, "the CSV's real size replaces the unobserved 0");
  assert.equal(merged[0].src, 'live-fold-only', 'live provenance survives the reconciliation');
});

test('two genuinely different sizes are still a mismatch', () => {
  const live = { t: 1000, x: 2000, pnl: 20.5, size: 2, side: 'buy' };
  const csv = { t: 1001, x: 2030, pnl: 20.5, size: 3, side: 'buy' };
  assert.equal(isSameTrade(csv, live), false, 'the wildcard must apply ONLY to an unobserved size');
});

test('re-importing the same CSV over CSV-written rows replaces, never appends', () => {
  const stored = [
    { t: 1000, x: 2000, pnl: 20.5, size: 1, side: 'buy' },
    { t: 3000, x: 4000, pnl: -12.0, size: 2, side: 'sell' },
  ];
  const merged = mergeCsvIntoStored(stored, stored.map(r => Object.assign({}, r)), fpKey);
  assert.equal(merged.length, 2);
});

// ── Gross vs net: the duplication mechanism (2026-08-26) ───────────────────
// Anoop after re-importing a day the live feed had already recorded: "it
// overread again and calculated wrong ... it should overlap excisiting with
// new information."
const LIVE_NET = { t: 1000, x: 1000, size: 2, pnl: -2.80, pnlBasis: 'net' };
const CSV_GROSS = { t: 900, x: 1000, size: 2, pnl: 1.00, side: 'LONG' };
const RATE = { commPerContract: 0.95 };

test('a live NET row matches its own CSV GROSS row once the rate is known', () => {
  // They differ by exactly the round turn: 2 lots x $0.95 x 2 sides = $3.80,
  // which is 380x the $0.01 tolerance. Before this they could never match, so
  // the importer kept both and doubled the trade.
  assert.strictEqual(isSameTrade(CSV_GROSS, LIVE_NET, RATE), true);
});

test('without a rate it still matches, erring toward a merge not a duplicate', () => {
  // A missed match costs one line in a reconcile report. A false duplicate
  // corrupts contracts, gross, and the size-cap counts the guardrail enforces.
  assert.strictEqual(isSameTrade(CSV_GROSS, LIVE_NET, {}), true);
});

test('the widened tolerance does NOT swallow a genuinely different trade', () => {
  const other = { t: 900, x: 1000, size: 2, pnl: 500, side: 'LONG' };
  assert.strictEqual(isSameTrade(other, LIVE_NET, RATE), false);
  assert.strictEqual(isSameTrade(other, LIVE_NET, {}), false);
});

test('two rows on the SAME basis keep the strict $0.01 tolerance', () => {
  const a = { t: 900, x: 1000, size: 2, pnl: 100.00 };
  const b = { t: 1000, x: 1000, size: 2, pnl: 100.50 };
  assert.strictEqual(isSameTrade(a, b, RATE), false, 'both gross — 50c apart is a different trade');
});

test('pnlBasisOf: explicit stamp wins, provenance is the fallback', () => {
  const TI = require('../renderer/trade-identity.js');
  assert.strictEqual(TI.pnlBasisOf({ pnlBasis: 'net' }), 'net');
  assert.strictEqual(TI.pnlBasisOf({ pnlBasis: 'gross', evidence: 'fold' }), 'gross');
  assert.strictEqual(TI.pnlBasisOf({ evidence: 'fold' }), 'net');
  assert.strictEqual(TI.pnlBasisOf({ source: 'live-fold-only' }), 'net');
  assert.strictEqual(TI.pnlBasisOf({}), 'gross');
  assert.strictEqual(TI.pnlBasisOf(null), 'gross');
});

test('mergeCsvIntoStored: re-importing a live-written day adds NO copies', () => {
  const TI = require('../renderer/trade-identity.js');
  const fp = r => r.t + '|' + r.x + '|' + Math.round(r.pnl * 100) + '|' + r.size;
  const merged = TI.mergeCsvIntoStored([LIVE_NET], [CSV_GROSS], fp, RATE);
  assert.strictEqual(merged.length, 1, 'one trade must stay one trade');
  // The CSV wins the VALUE — it is the broker's own official export, with the
  // side and prices the fold never saw. What matters is that the basis label
  // follows the value: a gross number must not inherit the live row's 'net'
  // stamp, or the rollup would add commission back to it and inflate the day.
  assert.strictEqual(merged[0].pnl, 1.00);
  assert.strictEqual(merged[0].pnlBasis, 'gross');
  assert.strictEqual(merged[0].side, 'LONG');
});

test('day-rollup and trade-identity agree on what a row basis is', () => {
  // Two copies of this rule exist by design (load-order independence). They
  // must never drift, or a row counted as net by one and gross by the other
  // produces a day total that reconciles against nothing.
  const TI = require('../renderer/trade-identity.js');
  const DR = require('../renderer/day-rollup.js');
  [{ pnlBasis: 'net' }, { pnlBasis: 'gross' }, { evidence: 'fold' },
   { source: 'live-fold-only' }, {}, null].forEach(row => {
    assert.strictEqual(TI.pnlBasisOf(row), DR.pnlBasisOf(row), JSON.stringify(row));
  });
});
