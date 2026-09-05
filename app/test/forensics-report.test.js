'use strict';
const test = require('node:test');
const assert = require('node:assert');
const FR = require('../forensics-report');

// The store shape the server actually holds: { "YYYY-MM-DD": [row, ...] }.
function store(rows) { return { '2026-09-01': rows }; }

const IST = [
  { name: 'London', startMin: 750, endMin: 840 },
  { name: 'NY', startMin: 1140, endMin: 1260 },
];
const OPTS = { sessionWindowsIST: IST, pointValue: 2 };

test('flattenDayTrades stamps the day and orders by entry', () => {
  const flat = FR.flattenDayTrades({
    '2026-09-02': [{ t: 3000, pnl: 1 }],
    '2026-09-01': [{ t: 2000, pnl: 2 }, { t: 1000, pnl: 3 }],
  });
  assert.deepStrictEqual(flat.map((r) => r.entryAt), [1000, 2000, 3000]);
  assert.strictEqual(flat[0].day, '2026-09-01');
  assert.strictEqual(flat[2].day, '2026-09-02');
});

test('coverage counts what is MEASURED, and 0 is a real answer', () => {
  const c = FR.coverageOf([
    { ep: 100, side: 'buy' },                        // priced, unmeasured
    { ep: 100, side: 'buy', mae: 5, mfe: 9 },        // measured
    { forensicsReason: 'no bars cover the trade window' },
  ]);
  assert.strictEqual(c.trades, 3);
  assert.strictEqual(c.withPrices, 2);
  assert.strictEqual(c.withMaeMfe, 1);
  assert.strictEqual(c.reasons['no bars cover the trade window'], 1);
  assert.ok(/1 of 3/.test(c.note));
});

test('a record with NO measured trade says so instead of implying zero', () => {
  const c = FR.coverageOf([{ pnl: -100 }, { pnl: 50 }]);
  assert.strictEqual(c.withMaeMfe, 0);
  assert.strictEqual(c.maeMfePct, 0);
  assert.ok(/No trade on record has MAE\/MFE/.test(c.note));
});

// The defect this whole tab is defensive about: an unmeasured value must never
// arrive at the renderer as 0, because 0 is a legible, believable number.
test('tradeRows passes NULL through — never a zero — for missing measurements', () => {
  const [r] = FR.tradeRows([{ pnl: -100, size: 2, forensicsReason: 'no bars' }]);
  assert.strictEqual(r.mae, null);
  assert.strictEqual(r.mfe, null);
  assert.strictEqual(r.post30LeftOnTable, null);
  assert.strictEqual(r.forensicsReason, 'no bars');
  assert.strictEqual(r.pnl, -100);
});

test('buildForensicsReport returns coverage, trades, expectancy and counterfactuals', () => {
  const rep = FR.buildForensicsReport(store([
    { t: Date.parse('2026-09-01T08:00:00Z'), x: Date.parse('2026-09-01T08:05:00Z'), side: 'buy', ep: 100, xp: 105, pnl: 100, size: 2 },
    { t: Date.parse('2026-09-01T09:00:00Z'), x: Date.parse('2026-09-01T09:10:00Z'), side: 'sell', ep: 105, xp: 110, pnl: -400, size: 4 },
  ]), OPTS);
  assert.strictEqual(rep.trades.length, 2);
  assert.strictEqual(rep.coverage.trades, 2);
  assert.ok(rep.expectancy.length > 0);
  assert.ok(rep.counterfactuals.length > 0);
  // Tagging composed: the index within the day must be present, since the
  // skip-Nth counterfactual reads it.
  assert.deepStrictEqual(rep.trades.map((t) => t.tradeIndexOfDay), [1, 2]);
});

test('expectancy totals reconcile with the book — no double counting', () => {
  const rows = [
    { t: 1, pnl: 100, size: 1, side: 'buy', ep: 1 },
    { t: 2, pnl: -50, size: 2, side: 'buy', ep: 1 },
    { t: 3, pnl: 30, size: 1, side: 'sell', ep: 1 },
  ];
  const rep = FR.buildForensicsReport(store(rows), OPTS);
  const book = rows.reduce((a, r) => a + r.pnl, 0);
  for (const table of rep.expectancy) {
    const sum = table.rows.reduce((a, r) => a + r.totalPnl, 0);
    assert.ok(Math.abs(sum - book) < 1e-9, table.key + ' must sum to the book total');
  }
});

// A cutoff that removes EVERY trade always shows a delta equal to the whole
// loss, which reads like the best idea on the page. It is "stop trading".
test('a cutoff that removes every trade is reported as degenerate, not as a win', () => {
  // 18:00 IST entry — after both cutoffs.
  const rep = FR.buildForensicsReport(store([
    { t: Date.parse('2026-09-01T12:30:00Z'), pnl: -500, size: 2, side: 'buy', ep: 100 },
  ]), OPTS);
  const cut = rep.counterfactuals.filter((c) => c.id.indexOf('cutoff-') === 0);
  assert.ok(cut.length >= 1);
  for (const c of cut) {
    assert.ok(c.degenerate, 'expected a degenerate flag, got ' + JSON.stringify(c));
    assert.strictEqual(c.deltaVsActual, undefined, 'must not publish a delta it cannot honestly claim');
  }
});

// The 2R counterfactual reads excursion. With no MFE anywhere it must refuse —
// returning the book unchanged would read as "running winners would not help".
test('2R refuses when no trade has an MFE, rather than returning the book', () => {
  const rep = FR.buildForensicsReport(store([
    { t: 1, pnl: 100, size: 1, side: 'buy', ep: 100 },
  ]), OPTS);
  const r2 = rep.counterfactuals.find((c) => c.id === 'run-2r');
  assert.ok(r2.unavailable, 'expected unavailable, got ' + JSON.stringify(r2));
  assert.strictEqual(r2.net, undefined);
});

test('an empty store builds a valid, honest, empty report', () => {
  const rep = FR.buildForensicsReport({}, OPTS);
  assert.strictEqual(rep.trades.length, 0);
  assert.strictEqual(rep.coverage.trades, 0);
  assert.ok(Array.isArray(rep.counterfactuals));
  assert.ok(Array.isArray(rep.expectancy));
});
