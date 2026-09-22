'use strict';
// ── PROTOCOL 2 tests ───────────────────────────────────────────────────────
// Every scenario below is a fault that ACTUALLY OCCURRED on 2026-08-26..28 and
// that the app reported as healthy at the time. The protocol earns its keep
// only if it catches these, so they are the tests.
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, findDuplicateRows, dailyReconciliationCheck, SEV } = require('../feed-protocol.js');

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

// ── The guard-watching check (2026-09-02) ──────────────────────────────────
// This protocol had checked every feed the oversize guard reads, and never the
// guard itself. On the day it mattered, panel-tables passed all session while
// the guard was blind to a 5-lot.
const OG = (over) => Object.assign({
  armed: true, configEnabled: true, userDisabled: false, canAct: true, sizeCap: 2,
  mode: 'armed', blind: false, blindReads: 0, lastReadAt: Date.now(),
  lastReadAgeMs: 3000, lastSeenSize: 0, lastRowCount: 0, actionsToday: 0,
  stuck: false, expectedReadIntervalMs: 5000,
}, over || {});

test('a guard that is armed and reading fresh passes', () => {
  const c = find(evaluate({ oversizeGuard: OG() }, RULES), 'oversize-guard');
  assert.strictEqual(c.verdict, 'pass');
});

test('alarm-only is NOT a failure — it still shouts', () => {
  // Flagging this as broken would train him to ignore the line, and the line
  // is the only thing standing between him and an unenforced cap.
  const c = find(evaluate({ oversizeGuard: OG({ canAct: false, mode: 'alarm-only' }) }, RULES), 'oversize-guard');
  assert.strictEqual(c.verdict, 'pass');
});

test('blind fails, and names why an unreadable table is the dangerous case', () => {
  const c = find(evaluate({ oversizeGuard: OG({ blind: true, mode: 'blind', blindReads: 4 }) }, RULES), 'oversize-guard');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /IDENTICAL to a flat account/);
  assert.strictEqual(c.rectify, 'mount-panel-tables');
});

test('switched off is reported but never auto-reverted', () => {
  const c = find(evaluate({ oversizeGuard: OG({ armed: false, userDisabled: true, mode: 'off' }) }, RULES), 'oversize-guard');
  assert.strictEqual(c.verdict, 'fail');
  assert.strictEqual(c.rectify, null, 'undoing a decision he made is not the protocol\'s business');
  assert.match(c.impact, /switched OFF/);
});

test('a stopped position watch is caught even though reads once worked', () => {
  const c = find(evaluate({ oversizeGuard: OG({ lastReadAgeMs: 120000 }) }, RULES), 'oversize-guard');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /stopped ticking/);
});

test('never having read at all is a failure, not a pass by default', () => {
  const c = find(evaluate({ oversizeGuard: OG({ lastReadAt: null, lastReadAgeMs: null }) }, RULES), 'oversize-guard');
  assert.strictEqual(c.verdict, 'fail');
  assert.match(c.impact, /never completed a position read/);
});

test('no guard observation at all emits no check rather than a false pass', () => {
  const c = find(evaluate({}, RULES), 'oversize-guard');
  assert.strictEqual(c, undefined);
});

// ── The 2026-09-01/02 fault: MOUNTED IS NOT RENDERED ───────────────────────
// The exact observation set the app had while printing "3/3 checks passed" for
// two full sessions. Every table mounted, summary populated, CDP up — and the
// orders table returning zero rows behind a hidden tab, which cost every trade
// its entry/exit price and left the drift panel on a two-day-old anchor.
const unrenderedOrders = () => Object.assign(healthy(), {
  panelRows: { orderRows: 0, ordersEmptyState: false, openPositions: 1, positionsEmptyState: false },
});

test('an orders table with no rows FAILS even though every table is mounted', () => {
  const r = evaluate(unrenderedOrders(), RULES);
  const c = r.checks.find(x => x.key === 'panel-rows');
  assert.equal(c.verdict, 'fail');
  assert.equal(c.severity, SEV.CRITICAL);
  // The old mount check must still pass — that is the whole point: this fault
  // is invisible to it, so the new check has to be the thing that catches it.
  assert.equal(r.checks.find(x => x.key === 'panel-tables').verdict, 'pass');
});

test('the impact names what is actually lost, not just the table', () => {
  const c = evaluate(unrenderedOrders(), RULES).checks.find(x => x.key === 'panel-rows');
  assert.match(c.impact, /no entry price/i);
  assert.match(c.impact, /drift/i);
  assert.equal(c.rectify, 'render-orders-table');
});

// mount-panel-tables answers "is the table in the DOM" and would report SUCCESS
// against this fault while changing nothing — the precise failure that let it
// survive two sessions. The repair must be the row-rendering one.
test('the rectification is the row-render, never the mount check that cannot see it', () => {
  const r = evaluate(unrenderedOrders(), RULES);
  const rec = r.rectifications.find(x => x.key === 'panel-rows');
  assert.equal(rec.action, 'render-orders-table');
  assert.notEqual(rec.action, 'mount-panel-tables');
});

test("TradingView's own empty-state placeholder is RENDERED, not the fault", () => {
  const obs = Object.assign(healthy(), {
    panelRows: { orderRows: 0, ordersEmptyState: true, openPositions: 1, positionsEmptyState: false },
  });
  assert.equal(evaluate(obs, RULES).checks.find(x => x.key === 'panel-rows').verdict, 'pass');
});

test('a flat account with no orders is not a fault', () => {
  const obs = Object.assign(healthy(), {
    panelRows: { orderRows: 0, ordersEmptyState: false, openPositions: 0, positionsEmptyState: true },
  });
  assert.equal(evaluate(obs, RULES).checks.find(x => x.key === 'panel-rows').verdict, 'pass');
});

test('no row observation at all is UNKNOWN, never folded into a pass', () => {
  const r = evaluate(healthy(), RULES);
  assert.equal(r.checks.find(x => x.key === 'panel-rows'), undefined);
  const obs = Object.assign(healthy(), { panelRows: { orderRows: null, ordersEmptyState: false, openPositions: null } });
  assert.equal(evaluate(obs, RULES).checks.find(x => x.key === 'panel-rows').verdict, 'unknown');
});

// ── The downstream proof: did the trades keep their prices? ─────────────────
// panel-rows can pass at startup on a flat account and the fault still appear
// the moment a position opens. This reads the OUTCOME, which is what actually
// demonstrates the fix rather than asserting it.
test("today's fold-only rows are caught by their missing exit price", () => {
  const obs = Object.assign(healthy(), {
    todayRows: [
      { t: 1, x: 2, size: 1, pnl: -55.90, side: null, ep: null, xp: null },
      { t: 3, x: 4, size: 1, pnl: -3.90, side: null, ep: null, xp: null },
      { t: 5, x: 6, size: 1, pnl: 11.30, side: 'LONG', ep: 29400, xp: 29411 },
    ],
  });
  const c = evaluate(obs, RULES).checks.find(x => x.key === 'trade-detail');
  assert.equal(c.verdict, 'fail');
  assert.deepEqual(c.evidence, { total: 3, priced: 1, foldOnly: 2 });
  // Degraded, not critical: the NET of a fold row is real and the money
  // guardrails still work. What is lost is every per-trade fact.
  assert.equal(c.severity, SEV.DEGRADED);
});

test('a fully priced day passes', () => {
  assert.equal(evaluate(healthy(), RULES).checks.find(x => x.key === 'trade-detail').verdict, 'pass');
});

test('a day with no trades yet raises nothing — an empty day is not a broken day', () => {
  const obs = Object.assign(healthy(), { todayRows: [] });
  assert.equal(evaluate(obs, RULES).checks.find(x => x.key === 'trade-detail'), undefined);
});

// ── Contention below the timeout threshold (2026-09-02) ────────────────────
// The existing 'contention' check only fires once starvation has become an
// outright MCP timeout. The regime that actually did the damage raised none:
// a broker lock 7 deep turned the 5s position watch into an effective 20-30s,
// and he reached 16 contracts against a cap of 2 while the app logged 4.
test('a saturated broker lock FAILS even with zero MCP timeouts', () => {
  const obs = Object.assign(healthy(), {
    mcpTimeoutsRecent: 0,
    lockDepth: { brokerNow: 1, brokerMax: 7, chartNow: 2, chartMax: 13, positionFastLaneUses: 0, warnAt: 4 },
  });
  const r = evaluate(obs, RULES);
  assert.equal(r.checks.find(x => x.key === 'contention').verdict, 'pass', 'no timeouts — the old check sees nothing');
  assert.equal(r.checks.find(x => x.key === 'lock-queue').verdict, 'fail', 'the queue depth is the fault');
});

test('the impact says what the guard cannot see, not just a number', () => {
  const obs = Object.assign(healthy(), {
    lockDepth: { brokerMax: 7, chartMax: 13, warnAt: 4 },
  });
  const c = evaluate(obs, RULES).checks.find(x => x.key === 'lock-queue');
  assert.match(c.impact, /oversize guard/);
  assert.match(c.impact, /position watch/);
  // Deliberately no auto-repair: the fix is fewer or cheaper chart reads, a
  // design decision rather than something to attempt mid-session.
  assert.equal(c.rectify, null);
});

test('a healthy lock passes — this must not warn every session', () => {
  const obs = Object.assign(healthy(), {
    lockDepth: { brokerNow: 1, brokerMax: 2, chartNow: 1, chartMax: 3, positionFastLaneUses: 12, warnAt: 4 },
  });
  assert.equal(evaluate(obs, RULES).checks.find(x => x.key === 'lock-queue').verdict, 'pass');
});

test('no lock observation is UNKNOWN, never folded into a pass', () => {
  const obs = Object.assign(healthy(), { lockDepth: { brokerMax: null, warnAt: 4 } });
  assert.equal(evaluate(obs, RULES).checks.find(x => x.key === 'lock-queue').verdict, 'unknown');
});

// A queue two deep behind ONE slow call starves the guard worse than a queue
// five deep of fast ones. Depth is the proxy; the wait is the fault.
test('a long WAIT fails the check even when the queue never got deep', () => {
  const obs = Object.assign(healthy(), {
    mcpTimeoutsRecent: 0,
    lockDepth: { brokerNow: 1, brokerMax: 2, brokerMaxWaitMs: 21000, warnAt: 4, warnWaitMs: 8000 },
  });
  const c = evaluate(obs, RULES).checks.find(x => x.key === 'lock-queue');
  assert.equal(c.verdict, 'fail');
  assert.match(c.impact, /waited 21s/);
  // The impact must say why raising the timeout is the wrong instinct.
  assert.match(c.impact, /NOTHING TIMED OUT/);
  assert.match(c.impact, /would make this WORSE/);
});

test('a fast queue passes on both measures', () => {
  const obs = Object.assign(healthy(), {
    lockDepth: { brokerNow: 1, brokerMax: 3, brokerMaxWaitMs: 900, warnAt: 4, warnWaitMs: 8000 },
  });
  assert.equal(evaluate(obs, RULES).checks.find(x => x.key === 'lock-queue').verdict, 'pass');
});

// ── G25: daily reconciliation (2026-09-08) ─────────────────────────────────
// The three P&L stores must agree, and the feed's tradeCount must equal
// trades.length. Phantoms are NOT a subtraction term — see the note in
// dailyReconciliationCheck. Report, never rewrite.
test('G25: agreeing stores reconcile and make no noise', () => {
  const c = dailyReconciliationCheck({
    dayPnl: -231.12, dayTradesSum: -231.12, grHistoryPnl: -231.12,
    tradeCount: 13, tradesLength: 13, phantomFlats: 0,
  });
  assert.strictEqual(c.verdict, 'pass');
});

test('G25: the three P&L stores disagreeing is reported, never averaged', () => {
  const c = dailyReconciliationCheck({
    dayPnl: -231.12, dayTradesSum: -378.88, grHistoryPnl: -231.12,
    tradeCount: 13, tradesLength: 13, phantomFlats: 0,
  });
  assert.strictEqual(c.verdict, 'fail');
  assert.strictEqual(c.severity, SEV.CRITICAL);
  assert.match(c.impact, /disagree by \$147\.76/);
  assert.match(c.impact, /csvApply is the only fix/);
});

test('G25: tradeCount vs trades.length-minus-phantoms mismatch is detected', () => {
  const c = dailyReconciliationCheck({
    dayPnl: 0, dayTradesSum: 0, grHistoryPnl: 0,
    tradeCount: 13, tradesLength: 16, phantomFlats: 0,
  });
  assert.strictEqual(c.verdict, 'fail');
  assert.strictEqual(c.key, 'daily-count');
});

test('G25: rejected phantoms are excluded from BOTH counts, so they are not subtracted', () => {
  // The 2026-09-21 live bug. tradeCount and trades.length move together —
  // tv-broker-feed.js pushes a row AND increments the count in the same branch,
  // and the phantom branch returns before either happens. Subtracting
  // phantomFlats therefore counted the same exclusion twice, so once any
  // phantom occurred the check failed for the rest of the day: it fired five
  // times as the counter grew 1..5, reporting "tradeCount 7 does not equal 7
  // rows minus 2 rejected phantom(s) (5)" about a day whose count was correct.
  // Every pre-existing test here passed phantomFlats: 0, which is precisely
  // why it shipped — the only covered case was the one where the bug is silent.
  const c = dailyReconciliationCheck({
    dayPnl: 381.70, dayTradesSum: 381.70, grHistoryPnl: 381.70,
    tradeCount: 7, tradesLength: 7, phantomFlats: 2,
  });
  assert.strictEqual(c.verdict, 'pass');
});

test('G25: a genuine count mismatch still fails with phantoms present, and says so', () => {
  const c = dailyReconciliationCheck({
    dayPnl: 0, dayTradesSum: 0, grHistoryPnl: 0,
    tradeCount: 5, tradesLength: 7, phantomFlats: 2,
  });
  assert.strictEqual(c.verdict, 'fail');
  assert.strictEqual(c.key, 'daily-count');
  assert.match(c.impact, /does not equal 7 stored row\(s\)/);
  assert.match(c.impact, /already excluded from both/);
});

test('G25: the check REPORTS and never rewrites — no rectify action', () => {
  const c = dailyReconciliationCheck({
    dayPnl: -231.12, dayTradesSum: -378.88, grHistoryPnl: -231.12,
    tradeCount: 13, tradesLength: 13, phantomFlats: 0,
  });
  assert.strictEqual(c.rectify, null, 'reconciliation is report-only; csvApply stays the correction');
});
