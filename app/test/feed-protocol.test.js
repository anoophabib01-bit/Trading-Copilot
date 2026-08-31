'use strict';
// ── PROTOCOL 2 tests ───────────────────────────────────────────────────────
// Every scenario below is a fault that ACTUALLY OCCURRED on 2026-08-26..28 and
// that the app reported as healthy at the time. The protocol earns its keep
// only if it catches these, so they are the tests.
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, findDuplicateRows, SEV } = require('../feed-protocol.js');

const RULES = { commissionPerContractPerSide: 0.95 };
const healthy = () => ({
  cdpConnected: true, bridgeReady: true,
  panelTables: { positions: true, orders: true, summary: true },
  summaryPopulated: true,
  bars: { '5': { count: 12, spacingMin: 5, newestAgeMin: 2 }, '30': { count: 12, spacingMin: 30, newestAgeMin: 10 } },
  monitors: [{ id: 'engulf-30m', running: true, lastCheckAgeMs: 60000, expectedIntervalMs: 30 * 60000 }],
  foldState: { tradeCount: 1, dayPnl: 1.10, trades: [{ size: 1, pnl: 1.10 }], phantomFlats: 0 },
  todayRows: [{ t: 1, x: 2, size: 1, pnl: 1.10, side: 'SHORT', ep: 29611, xp: 29609.5 }],
  isFlat: true, brokerBalance: 51179.90, ledgerBalance: 51179.90,
  mcpTimeoutsRecent: 0,
});
const find = (r, key) => r.checks.find(c => c.key === key);

test('a healthy feed passes everything and says so', () => {
  const r = evaluate(healthy(), RULES);
  assert.strictEqual(r.failed, 0);
  assert.strictEqual(r.unknown, 0);
  assert.match(r.headline, /all checks passed/);
});

// ── the faults that were live and silent ───────────────────────────────────
test('catches the Account Summary that is MOUNTED but EMPTY', () => {
  // 2026-08-28: all three tables mounted, summary body said "no trading data
  // here yet", so day P&L silently fell back to the fold.
  const r = evaluate(Object.assign(healthy(), { summaryPopulated: false, dayPnlSource: 'fold' }), RULES);
  const c = find(r, 'summary-populated');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /understate/);
  assert.strictEqual(c.rectify, 'activate-summary-tab');
});

test('catches the phantom zero-P&L trade', () => {
  const obs = healthy();
  obs.foldState = { tradeCount: 2, dayPnl: 1.10, trades: [{ size: 1, pnl: 1.10 }, { size: 1, pnl: 0 }], phantomFlats: 0 };
  const c = find(evaluate(obs, RULES), 'fold-phantoms');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /NO FILL HAPPENED/);
  assert.strictEqual(c.rectify, 'drop-phantom-trades');
});

test('catches one trade stored as two rows (gross + net)', () => {
  const obs = healthy();
  obs.todayRows = [
    { t: 1, x: 2, size: 1, pnl: 3.00, side: 'SHORT', ep: 29611, xp: 29609.5 },   // walk, gross
    { t: 500000, x: 500000, size: 1, pnl: 1.10, side: null, ep: null, xp: null }, // fold, net
  ];
  const c = find(evaluate(obs, RULES), 'row-duplicates');
  assert.strictEqual(c.verdict, 'fail');
  assert.strictEqual(c.evidence.duplicates.length, 1);
  assert.match(c.evidence.duplicates[0].reason, /one commission apart/);
});

test('catches the timeframe race — right count, WRONG spacing', () => {
  const obs = healthy();
  obs.bars['30'] = { count: 12, spacingMin: 60, newestAgeMin: 10 };   // asked 30, got 60
  const c = find(evaluate(obs, RULES), 'bars-30');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /WRONG timeframe/);
});

test('catches a stalled bar feed', () => {
  const obs = healthy();
  obs.bars['30'] = { count: 12, spacingMin: 30, newestAgeMin: 200 };
  assert.strictEqual(find(evaluate(obs, RULES), 'bars-30').verdict, 'fail');
});

test('catches the SILENT TURN-OFF: running:true but no check in 3 intervals', () => {
  const obs = healthy();
  obs.monitors = [
    { id: 'engulf-30m', running: true, lastCheckAgeMs: 30 * 60000 * 4, expectedIntervalMs: 30 * 60000 },
    { id: 'fvg-30m', running: false, lastCheckAgeMs: null, expectedIntervalMs: 30 * 60000 },
  ];
  const c = find(evaluate(obs, RULES), 'watchers');
  assert.strictEqual(c.verdict, 'fail');
  assert.deepEqual(c.evidence.stalled, ['engulf-30m']);
  assert.deepEqual(c.evidence.stopped, ['fvg-30m']);
  assert.match(c.impact, /silently dead/);
});

test('catches unmounted panel tables and names which', () => {
  const obs = healthy();
  obs.panelTables = { positions: false, orders: true, summary: true };
  const c = find(evaluate(obs, RULES), 'panel-tables');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /IDENTICAL to a flat account/);
});

// ── the discipline that stops this becoming another green light ────────────
test('UNKNOWN is never counted as a pass', () => {
  const r = evaluate({ cdpConnected: null }, RULES);
  assert.strictEqual(find(r, 'cdp').verdict, 'unknown');
  assert.strictEqual(r.passed, 0);
  assert.match(r.headline, /unverifiable/);
});

test('balance is only compared when FLAT — mid-trade it cannot match', () => {
  const obs = Object.assign(healthy(), { isFlat: false, brokerBalance: 51000, ledgerBalance: 51410 });
  assert.strictEqual(find(evaluate(obs, RULES), 'balance-agreement'), undefined);
  const flat = Object.assign(healthy(), { isFlat: true, brokerBalance: 51000, ledgerBalance: 51410 });
  assert.strictEqual(find(evaluate(flat, RULES), 'balance-agreement').verdict, 'fail');
});

test('row-duplicate repair is REPORTED, never automatic', () => {
  const obs = healthy();
  obs.todayRows = [
    { t: 1, x: 2, size: 1, pnl: 3.00, side: 'SHORT', ep: 29611, xp: 29609.5 },
    { t: 500000, x: 500000, size: 1, pnl: 1.10 },
  ];
  const r = evaluate(obs, RULES);
  const rec = r.rectifications.find(x => x.key === 'row-duplicates');
  assert.strictEqual(rec.action, 'merge-duplicate-rows', 'the runner maps this to a report-only action');
});

test('every failing check states an impact and carries evidence', () => {
  const obs = healthy();
  obs.summaryPopulated = false;
  obs.panelTables = { positions: false, orders: true, summary: true };
  obs.foldState = { tradeCount: 2, dayPnl: 0, trades: [{ size: 1, pnl: 0 }], phantomFlats: 0 };
  for (const c of evaluate(obs, RULES).checks.filter(x => x.verdict === 'fail')) {
    assert.ok(c.impact && c.impact.length > 20, `${c.key} has no usable impact statement`);
    assert.ok(c.evidence, `${c.key} has no evidence`);
  }
});

test('critical failures are counted separately from degraded ones', () => {
  const obs = healthy();
  obs.cdpConnected = false;
  const r = evaluate(obs, RULES);
  assert.ok(r.critical >= 1);
  assert.strictEqual(find(r, 'cdp').severity, SEV.CRITICAL);
});

// ── duplicate detection ────────────────────────────────────────────────────
test('findDuplicateRows: identical prices, and commission-apart P&L', () => {
  const stale = { t: 1, x: 2, size: 1, pnl: 0, side: 'SHORT', ep: 29611, xp: 29609.5 };
  const real = { t: 3, x: 4, size: 1, pnl: 1.10, side: 'SHORT', ep: 29611, xp: 29609.5 };
  assert.strictEqual(findDuplicateRows([stale, real], 0.95).length, 1);
  const gross = { t: 1, x: 2, size: 1, pnl: 3.00 };
  const net = { t: 3, x: 4, size: 1, pnl: 1.10 };
  assert.strictEqual(findDuplicateRows([gross, net], 0.95).length, 1);
});

test('findDuplicateRows: genuinely different trades are not flagged', () => {
  const a = { t: 1, x: 2, size: 1, pnl: 50, side: 'LONG', ep: 100, xp: 125 };
  const b = { t: 3, x: 4, size: 1, pnl: -30, side: 'SHORT', ep: 200, xp: 215 };
  assert.strictEqual(findDuplicateRows([a, b], 0.95).length, 0);
});

test('findDuplicateRows: different sizes are never the same trade', () => {
  const a = { t: 1, x: 2, size: 1, pnl: 3.00 };
  const b = { t: 3, x: 4, size: 4, pnl: 1.10 };
  assert.strictEqual(findDuplicateRows([a, b], 0.95).length, 0);
});
