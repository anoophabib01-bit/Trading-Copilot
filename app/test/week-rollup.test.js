'use strict';
/**
 * week-rollup.js tests.
 *
 * Two blocks, same discipline as points-tracker.test.js:
 *   1. Pure behaviour on hand-built input — the rules the module promises.
 *   2. A REPLAY against Anoop's real DATA/accounts/s1 stores, asserting the
 *      numbers a human already checked by hand on 2026-08-29. A module that is
 *      only internally consistent can still be confidently wrong about his week.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const W = require('../week-rollup');

// 2026-09-05: was DATA/accounts/s1, which was archived and reset on 2026-09-04
// — the replays below went red because the week they assert moved out from
// under them. They now read the FROZEN _recovered_20260904 snapshot, so the
// hand-checked figures stay assertable forever. See test/helpers/recovered-fixture.js.
const recovered = require('./helpers/recovered-fixture');
const DATA = recovered.available()
  ? recovered.accountDir()
  : path.join(__dirname, '..', '..', 'DATA', 'accounts', 's1');

// Function declaration, not a const: the replay tests are spread through the
// file and a `const` would be in its temporal dead zone for the earlier ones.
function haveRealData() {
  return fs.existsSync(path.join(DATA, 'gr_history.json'))
    && fs.existsSync(path.join(DATA, 'day_trades.json'));
}

// ── ISO week identity ────────────────────────────────────────────────────────

test('isoWeekKey: the week Anoop reviews on 2026-08-29 is 2026-W35', () => {
  assert.strictEqual(W.isoWeekKey('2026-08-24'), '2026-W35');
  assert.strictEqual(W.isoWeekKey('2026-08-28'), '2026-W35');
  assert.strictEqual(W.isoWeekKey('2026-08-30'), '2026-W35', 'Sunday belongs to the week that started Monday');
  assert.strictEqual(W.isoWeekKey('2026-08-31'), '2026-W36');
});

test('isoWeekKey: year boundaries follow ISO-8601 (the week owning Thursday owns the year)', () => {
  // 2027-01-01 is a Friday; its week began Mon 2026-12-28 and its Thursday is
  // 2026-12-31, so ISO puts the whole week in 2026.
  assert.strictEqual(W.isoWeekKey('2027-01-01'), '2026-W53');
  assert.strictEqual(W.isoWeekKey('2026-12-28'), '2026-W53');
  // 2026-01-01 is a Thursday, so its week is genuinely week 1 of 2026.
  assert.strictEqual(W.isoWeekKey('2026-01-01'), '2026-W01');
  assert.strictEqual(W.isoWeekKey('2025-12-29'), '2026-W01', 'Monday of that week is still 2026-W01');
});

test('weekDates: seven days, Monday first, Sunday last', () => {
  const d = W.weekDates('2026-08-28');
  assert.strictEqual(d.length, 7);
  assert.strictEqual(d[0], '2026-08-24');
  assert.strictEqual(d[4], '2026-08-28');
  assert.strictEqual(d[6], '2026-08-30');
  assert.strictEqual(W.weekStart('2026-08-24'), '2026-08-24', 'a Monday is its own week start');
  assert.strictEqual(W.prevWeekStart('2026-08-26'), '2026-08-17');
});

// ── Loss attribution ─────────────────────────────────────────────────────────

test('attributeLosses: a trade flagged both ways is blamed ONCE, on the worse breach', () => {
  const r = W.attributeLosses([{ pnl: -300, flags: ['revenge', 'oversize'] }]);
  const byKey = {};
  r.slices.forEach(s => { byKey[s.key] = s.loss; });
  assert.strictEqual(byKey.oversize, -300, 'oversize outranks revenge');
  assert.strictEqual(byKey.revenge, undefined, 'the same $300 must not appear twice');
  assert.strictEqual(r.totalLoss, -300);
});

test('attributeLosses: slices sum to the total loss exactly — a pie that lies is worse than no pie', () => {
  const rows = [
    { pnl: -300, flags: ['revenge', 'oversize'] },
    { pnl: -120, flags: ['revenge'] },
    { pnl: -50, flags: [] },
    { pnl: -10, flags: ['out-of-window'] },
    { pnl: 900, flags: ['oversize'] }   // a winner, however dirty, costs nothing
  ];
  const r = W.attributeLosses(rows);
  const sum = r.slices.reduce((a, s) => a + s.loss, 0);
  assert.strictEqual(Math.round(sum * 100) / 100, r.totalLoss);
  assert.strictEqual(r.totalLoss, -480, 'the +900 winner is excluded from loss attribution');
  assert.strictEqual(r.losingRows, 4);
});

test('attributeLosses: an unflagged row is "clean", a row with NO flags array is "unattributed"', () => {
  // These are different facts and collapsing them would let missing data
  // masquerade as disciplined trading.
  const r = W.attributeLosses([{ pnl: -100, flags: [] }, { pnl: -200 }]);
  const byKey = {};
  r.slices.forEach(s => { byKey[s.key] = s.loss; });
  assert.strictEqual(byKey.clean, -100);
  assert.strictEqual(byKey.unattributed, -200);
  assert.strictEqual(r.unattributedRows, 1);
  assert.strictEqual(r.coveragePct, 33.3, 'coverage must state how much of the loss it could NOT explain');
});

test('attributeLosses: no losses at all reports 100% coverage, not a divide-by-zero', () => {
  const r = W.attributeLosses([{ pnl: 50, flags: [] }]);
  assert.strictEqual(r.totalLoss, 0);
  assert.strictEqual(r.coveragePct, 100);
  assert.strictEqual(r.slices.length, 0);
});

// ── Quadrant ─────────────────────────────────────────────────────────────────

test('quadrantOf: all four cells, and breakeven-with-breaches is NOT "earned"', () => {
  assert.strictEqual(W.quadrantOf(500, 0), 'earned');
  assert.strictEqual(W.quadrantOf(500, 3), 'gotAway');
  assert.strictEqual(W.quadrantOf(-500, 0), 'badLuck');
  assert.strictEqual(W.quadrantOf(-500, 3), 'selfInflicted');
  assert.strictEqual(W.quadrantOf(0, 0), 'earned');
  assert.strictEqual(W.quadrantOf(0, 1), 'gotAway', 'churning to flat with a breach is not earning it');
});

// ── Flat days ────────────────────────────────────────────────────────────────

test('heldFire: an untraded WEEKDAY is a win; a weekend never is; the future never is', () => {
  const w = W.rollupWeek('2026-08-24', {
    grDays: [], tradesByDay: {}, ledger: {}, todayKey: '2026-08-26'
  });
  const by = {};
  w.days.forEach(d => { by[d.date] = d; });
  assert.strictEqual(by['2026-08-24'].heldFire, true, 'Monday, no trades, already past');
  assert.strictEqual(by['2026-08-26'].heldFire, false,
    'TODAY is not restraint yet — the session has not finished. It flips to a win at the next rollover.');
  assert.strictEqual(by['2026-08-27'].heldFire, false, 'Thursday has not happened yet');
  assert.strictEqual(by['2026-08-27'].future, true);
  assert.strictEqual(by['2026-08-29'].heldFire, false, 'Saturday: the market is shut, that is not restraint');
  assert.strictEqual(by['2026-08-30'].heldFire, false, 'Sunday likewise');
  assert.strictEqual(w.behaviour.heldFireDays, 2, 'Mon and Tue only — Wed is today and still running');
});

test('heldFire is NOT credited before the account has any records at all', () => {
  // The four-week window on 2026-08-31 reached back to 2026-W33, a week before
  // this account's first record (2026-08-17), and reported "Days held fire: 5"
  // — five days of discipline invented for a week he was not using the app.
  const w = W.rollupWeek('2026-08-10', {
    grDays: [], tradesByDay: {}, ledger: {},
    dataStart: '2026-08-17',
    todayKey: '2026-08-31'
  });
  assert.strictEqual(w.behaviour.heldFireDays, 0, 'no records means no restraint to credit');
  assert.strictEqual(w.behaviour.preHistoryDays, 5, 'reported as pre-history instead');
  assert.strictEqual(w.days[0].preHistory, true);
  assert.strictEqual(W.weekHasData(w), false, 'and the week must not count as a data week');
});

test('with no dataStart supplied, nothing is treated as pre-history', () => {
  // A caller that cannot determine a horizon must not have every day silently
  // disqualified — the horizon is an improvement, not a precondition.
  const w = W.rollupWeek('2026-08-10', {
    grDays: [], tradesByDay: {}, ledger: {}, todayKey: '2026-08-31'
  });
  assert.strictEqual(w.behaviour.preHistoryDays, 0);
  assert.strictEqual(w.behaviour.heldFireDays, 5);
  assert.strictEqual(w.dataStart, null);
});

test('complete: the week closes when Friday is past, so a Saturday review is not "still running"', () => {
  const src = { grDays: [], tradesByDay: {}, ledger: {} };
  assert.strictEqual(W.rollupWeek('2026-08-24', Object.assign({ todayKey: '2026-08-28' }, src)).complete, false, 'Friday itself');
  assert.strictEqual(W.rollupWeek('2026-08-24', Object.assign({ todayKey: '2026-08-29' }, src)).complete, true, 'Saturday — review day');
});

// ── Three-way reconciliation ─────────────────────────────────────────────────

test('reconcile: a day where the three stores disagree is reported, never silently averaged', () => {
  const w = W.rollupWeek('2026-08-24', {
    grDays: [{ date: '2026-08-26', pnl: -673.6, n: 13, over: 0, revenge: 0 }],
    tradesByDay: { '2026-08-26': [{ pnl: -498.8, size: 1, flags: [] }] },
    ledger: { '2026-08-26': { net: -498.8 } },
    todayKey: '2026-08-29'
  });
  assert.strictEqual(w.money.reconcile.disagreeDays.length, 1);
  assert.strictEqual(w.money.reconcile.disagreeDays[0].date, '2026-08-26');
  assert.strictEqual(w.money.reconcile.disagreeDays[0].grHistory, -673.6);
  assert.strictEqual(w.money.net, -673.6, 'gr_history wins — it is the only store that applies commission correctly');
});

test('money source: gr_history beats balance_ledger, because only it survives a MIXED-basis day', () => {
  // The real 2026-08-26: 13 rows, 96 contracts, rows carrying BOTH
  // pnlBasis 'gross' (CSV import) and 'net' (live fold). balance_ledger stored
  // the raw row sum in gross AND net, so commission was never subtracted;
  // gr_history ran it through day-rollup, which normalises basis and charges
  // commission once. Preferring the ledger understated the week by $174.80.
  //
  // This test exists because the ledger is the intuitive choice ("the broker's
  // own number") and the intuition is wrong. If it ever flips back, the week
  // total silently loses commission on every mixed-basis day.
  const w = W.rollupWeek('2026-08-24', {
    grDays: [{ date: '2026-08-26', pnl: -673.6, n: 13, over: 0, revenge: 0, contracts: 96 }],
    tradesByDay: {
      '2026-08-26': [
        { pnl: -400, size: 48, flags: [], pnlBasis: 'gross' },
        { pnl: -98.8, size: 48, flags: [], pnlBasis: 'net' }
      ]
    },
    ledger: { '2026-08-26': { gross: -498.8, net: -498.8, contracts: 96 } },
    todayKey: '2026-08-29'
  });
  assert.strictEqual(w.money.net, -673.6);
  assert.strictEqual(w.days[2].sources.ledger, -498.8, 'the ledger figure is still REPORTED, just not trusted');
  assert.strictEqual(w.days[2].sources.agree, false);
});

test('reconcile: agreeing stores produce an empty disagreeDays, not a false alarm', () => {
  const w = W.rollupWeek('2026-08-24', {
    grDays: [{ date: '2026-08-26', pnl: -100, n: 1, over: 0, revenge: 0 }],
    tradesByDay: { '2026-08-26': [{ pnl: -100, size: 1, flags: [] }] },
    ledger: { '2026-08-26': { net: -100 } },
    todayKey: '2026-08-29'
  });
  assert.deepStrictEqual(w.money.reconcile.disagreeDays, []);
});

// ── Adherence split ──────────────────────────────────────────────────────────

test('adherenceSplit: compares PER CONTRACT — per-trade would just measure bet size', () => {
  // Same edge per contract, wildly different size. A per-trade comparison would
  // call the 10-lot arm ten times better; per contract they are identical.
  const r = W.adherenceSplit([
    { pnl: 20, size: 1, flags: [] },
    { pnl: 200, size: 10, flags: ['oversize'] }
  ]);
  assert.strictEqual(r.clean.perContract, 20);
  assert.strictEqual(r.breached.perContract, 20);
  assert.strictEqual(r.perContractEdge, 0, 'identical per-contract edge must read as no difference');
  assert.strictEqual(r.clean.perTrade, 20);
  assert.strictEqual(r.breached.perTrade, 200, 'the per-trade figure is still exposed, just not the basis');
});

test('adherenceSplit: refuses to call a small sample an edge', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push({ pnl: 100, size: 1, flags: [] });
  for (let i = 0; i < 5; i++) rows.push({ pnl: -100, size: 1, flags: ['revenge'] });
  const r = W.adherenceSplit(rows);
  assert.strictEqual(r.disciplinePays, true, 'the direction is still reported');
  assert.strictEqual(r.reliable, false, 'but 5 v 5 is not an edge');
  assert.ok(/direction, not a proven edge/.test(r.note));
});

test('adherenceSplit: reliable once both arms clear the threshold', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ pnl: 10, size: 1, flags: [] });
  for (let i = 0; i < 40; i++) rows.push({ pnl: -10, size: 1, flags: ['oversize'] });
  const r = W.adherenceSplit(rows);
  assert.strictEqual(r.reliable, true);
  assert.strictEqual(r.perContractEdge, 20);
});

test('adherenceSplit: ungraded and zero-size rows are excluded and counted, not guessed at', () => {
  const r = W.adherenceSplit([
    { pnl: 10, size: 1, flags: [] },
    { pnl: -50, size: 1 },          // no flags array — cannot be graded
    { pnl: -50, size: 0, flags: [] } // size 0 — would divide by zero per contract
  ]);
  assert.strictEqual(r.gradedTrades, 1, 'only the flagged, sized row is usable');
  assert.strictEqual(r.ungradedTrades, 1, 'no flags array — never scored');
  assert.strictEqual(r.unsizedTrades, 1, 'size 0 — cannot be normalised per contract');
  assert.strictEqual(r.clean.trades, 1, 'the size-0 row never reaches an arm');
  assert.strictEqual(r.clean.perContract, 10);
});

test('REPLAY adherenceSplit: on the real rows, discipline pays but is NOT yet proven', { skip: !haveRealData() }, () => {
  const dt = JSON.parse(fs.readFileSync(path.join(DATA, 'day_trades.json'), 'utf8'));
  const all = [];
  Object.keys(dt).forEach(d => (dt[d] || []).forEach(t => all.push(t)));
  const r = W.adherenceSplit(all);
  assert.strictEqual(r.clean.trades, 16);
  assert.strictEqual(r.breached.trades, 81);
  assert.strictEqual(r.clean.perContract, 3.72);
  assert.strictEqual(r.breached.perContract, -1.3);
  assert.strictEqual(r.disciplinePays, true);
  assert.strictEqual(r.reliable, false, '16 clean trades is a direction, not an edge — the tab must say so');
  assert.strictEqual(r.breached.worst, -1322, 'the size-5 trade that took 66% of the allowance');
});

// ── Findings ─────────────────────────────────────────────────────────────────

test('weekFindings: NEVER manufactures a positive on a week that had none', () => {
  const w = W.rollupWeek('2026-08-24', {
    grDays: [{ date: '2026-08-24', pnl: -500, n: 5, over: 3, revenge: 2, maxSize: 8, giveback: 100, tradedPast3Losses: true, sizedUpIntoLoss: true, wins: 1, losses: 4, disc: 40 }],
    tradesByDay: { '2026-08-24': [{ pnl: -500, size: 8, flags: ['oversize'] }] },
    ledger: { '2026-08-24': { net: -500 } },
    account: { start: 50000, maxDrawdown: 2000, profitTarget: 3000 },
    todayKey: '2026-08-24'
  });
  const f = W.weekFindings(w, null);
  assert.strictEqual(f.positives.length, 0, 'an empty positives list is the honest answer, not a bug');
  assert.ok(f.mistakes.length > 0);
  assert.ok(f.mistakes[0].title.indexOf('Oversize') >= 0, 'most expensive breach leads');
});

test('weekFindings: a genuinely clean profitable day IS credited', () => {
  const w = W.rollupWeek('2026-08-24', {
    grDays: [{ date: '2026-08-24', pnl: 300, n: 2, over: 0, revenge: 0, maxSize: 2, giveback: 0, wins: 2, losses: 0, disc: 100 }],
    tradesByDay: { '2026-08-24': [{ pnl: 300, size: 2, flags: [] }] },
    ledger: { '2026-08-24': { net: 300 } },
    account: { start: 50000, maxDrawdown: 2000, profitTarget: 3000 },
    todayKey: '2026-08-28'
  });
  const f = W.weekFindings(w, null);
  const keys = f.positives.map(p => p.key);
  assert.ok(keys.indexOf('clean-days') >= 0);
  assert.ok(keys.indexOf('earned') >= 0);
  assert.ok(keys.indexOf('best-clean-day') >= 0);
  assert.strictEqual(w.behaviour.heldFireDays, 3, 'Tue-Thu untraded and past; Fri is today, still running');
});

/** A finished week with data — the only kind that may be scored. */
function stubWeek(net, giveback, trades, opts) {
  const o = opts || {};
  return {
    weekKey: o.weekKey || '2026-W35',
    start: o.start || '2026-08-24',
    complete: o.complete !== false,
    money: { net: net },
    behaviour: {
      giveback: giveback, trades: trades, maxSize: o.maxSize || 2,
      oversizeTrades: 0, revengeTrades: 0, cleanDays: 0, heldFireDays: o.heldFireDays || 0,
      tradedDays: o.tradedDays != null ? o.tradedDays : 5
    }
  };
}

test('compareWeeks: knows which direction is GOOD for each field', () => {
  const t = {};
  W.compareWeeks(stubWeek(100, 50, 10), stubWeek(50, 80, 5)).forEach(x => { t[x.key] = x; });
  assert.strictEqual(t.net.good, true, 'more money is better');
  assert.strictEqual(t.giveback.good, true, 'LESS giveback is better');
  assert.strictEqual(t.trades.good, false, 'MORE trades is worse for an overtrader');
});

test('compareWeeks: an EMPTY IN-PROGRESS week is never scored as an improvement', () => {
  // The Monday-morning bug: opening the tab on a week with no trades yet
  // scored "Trades taken 49 -> 0, better. Biggest size 18 -> 0, better.
  // Giveback $2,505 -> $0, better." Doing nothing yet is not progress.
  const monday = stubWeek(0, 0, 0, { weekKey: '2026-W36', complete: false, tradedDays: 0, maxSize: 0 });
  const lastWeek = stubWeek(-1392, 2505, 49, { maxSize: 18 });
  const t = {};
  W.compareWeeks(monday, lastWeek).forEach(x => { t[x.key] = x; });

  assert.strictEqual(t.trades.delta, -49, 'the raw delta is still reported — the numbers are real');
  assert.strictEqual(t.trades.good, null, 'but it carries NO verdict');
  assert.strictEqual(t.giveback.good, null);
  assert.strictEqual(t.maxSize.good, null);
  assert.strictEqual(t.net.good, null);
  assert.strictEqual(t.net.scoreable, false);
});

test('weekHasData / weeksComparable: the gate itself', () => {
  const traded = stubWeek(100, 0, 5);
  const held = stubWeek(0, 0, 0, { tradedDays: 0, heldFireDays: 3 });
  const nothing = stubWeek(0, 0, 0, { tradedDays: 0 });
  const live = stubWeek(100, 0, 5, { complete: false });

  assert.strictEqual(W.weekHasData(traded), true);
  assert.strictEqual(W.weekHasData(held), true, 'a week spent holding fire is a week with data');
  assert.strictEqual(W.weekHasData(nothing), false);
  assert.strictEqual(W.weekHasData(null), false);

  assert.strictEqual(W.weeksComparable(traded, held), true);
  assert.strictEqual(W.weeksComparable(traded, nothing), false, 'nothing to compare against');
  assert.strictEqual(W.weeksComparable(live, traded), false, 'an unfinished week cannot be scored');
});

// ── Four-week trend ──────────────────────────────────────────────────────────

test('trendSeries: keeps a gap week as an aligned empty column, never closes it up', () => {
  const weeks = [
    stubWeek(100, 0, 5, { weekKey: '2026-W33', start: '2026-08-10' }),
    stubWeek(0, 0, 0, { weekKey: '2026-W34', start: '2026-08-17', tradedDays: 0 }),  // untouched week
    stubWeek(-200, 0, 9, { weekKey: '2026-W35', start: '2026-08-24' }),
    stubWeek(0, 0, 0, { weekKey: '2026-W36', start: '2026-08-31', complete: false, tradedDays: 0 })
  ];
  const s = W.trendSeries(weeks);
  const net = s.find(x => x.key === 'net');
  assert.strictEqual(net.points.length, 4, 'four calendar columns, always');
  assert.strictEqual(net.points[1].hasData, false, 'the gap week stays a gap');
  assert.strictEqual(net.points[1].value, null);
  assert.strictEqual(net.points[3].inProgress, true);
  assert.strictEqual(net.points[0].weekKey, '2026-W33', 'oldest first');
});

test('trendSeries: scores the two most recent FINISHED weeks, skipping the live one', () => {
  const weeks = [
    stubWeek(100, 0, 5, { weekKey: '2026-W34', start: '2026-08-17' }),
    stubWeek(-200, 0, 9, { weekKey: '2026-W35', start: '2026-08-24' }),
    stubWeek(0, 0, 0, { weekKey: '2026-W36', start: '2026-08-31', complete: false, tradedDays: 0 })
  ];
  const net = W.trendSeries(weeks).find(x => x.key === 'net');
  assert.strictEqual(net.latestWeekKey, '2026-W35', 'the live week is not the latest SCORED week');
  assert.strictEqual(net.priorWeekKey, '2026-W34');
  assert.strictEqual(net.delta, -300);
  assert.strictEqual(net.good, false);
  assert.strictEqual(net.scoredWeeks, 2);
});

test('trendSeries: a single week of data yields no verdict at all', () => {
  const s = W.trendSeries([stubWeek(100, 0, 5, { weekKey: '2026-W35' })]);
  s.forEach(x => {
    assert.strictEqual(x.good, null);
    assert.strictEqual(x.delta, null);
    assert.strictEqual(x.priorWeekKey, null);
  });
});

test('trendSeries: empty input does not throw', () => {
  assert.deepStrictEqual(W.trendSeries([]).length, W.TREND_FIELDS.length);
  assert.deepStrictEqual(W.trendSeries(null).length, W.TREND_FIELDS.length);
});

test('compareWeeks: with no previous week, deltas are null rather than a fake zero', () => {
  const w = W.rollupWeek('2026-08-24', { grDays: [], tradesByDay: {}, ledger: {}, todayKey: '2026-08-29' });
  W.compareWeeks(w, null).forEach(t => {
    assert.strictEqual(t.delta, null);
    assert.strictEqual(t.good, null);
  });
});

// ── Replay against the real stores ───────────────────────────────────────────
// Numbers below were checked by hand against DATA/accounts/s1 on 2026-08-29.
// If a future data repair changes them, that is a signal to re-check the repair,
// not to loosen the assertion.

const haveReal = fs.existsSync(path.join(DATA, 'gr_history.json'))
  && fs.existsSync(path.join(DATA, 'day_trades.json'));

test('REPLAY 2026-W35: reproduces the week Anoop reviewed on 2026-08-29', { skip: !haveReal }, () => {
  const L = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  const ck = {};
  L('ck_history.json').forEach(c => { ck[c.date] = c; });
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
  const w = W.rollupWeek('2026-08-26', {
    grDays: L('gr_history.json'),
    tradesByDay: L('day_trades.json'),
    ledger: L('balance_ledger.json'),
    ckByDate: ck,
    notesByDate: L('notes.json'),
    account: rules.eval,
    todayKey: '2026-08-29'
  });

  assert.strictEqual(w.weekKey, '2026-W35');
  assert.strictEqual(w.start, '2026-08-24');
  assert.strictEqual(w.complete, true);
  assert.strictEqual(w.money.net, -1392.08, 'gr_history-truth week net — see the mixed-basis test above for why not the ledger');
  assert.strictEqual(w.behaviour.tradedDays, 5);
  assert.strictEqual(w.behaviour.trades, 49);
  assert.strictEqual(w.behaviour.maxSize, 18, '18 lots against a 2-lot ceiling — real, not a parse error');
  assert.strictEqual(w.behaviour.cleanDays, 0);
  assert.strictEqual(w.account.worstDayPctOfDrawdown, 71.8, '2026-08-28 ate 71.8% of the $2,000 allowance');

  // The drift this module found on its first real run.
  assert.strictEqual(w.money.reconcile.disagreeDays.length, 1);
  assert.strictEqual(w.money.reconcile.disagreeDays[0].date, '2026-08-26');

  // Attribution must still add up on real, messy rows.
  const sum = w.attribution.slices.reduce((a, s) => a + s.loss, 0);
  assert.strictEqual(Math.round(sum * 100) / 100, w.attribution.totalLoss);
  assert.strictEqual(w.attribution.slices[0].key, 'oversize', 'oversize was the dominant blame once overlap was resolved');

  // Quadrants: 2 got-away, 3 self-inflicted, nothing earned.
  assert.strictEqual(w.quadrants.earned.length, 0);
  assert.strictEqual(w.quadrants.selfInflicted.length, 3);
  assert.strictEqual(w.quadrants.gotAway.length, 2);

  const f = W.weekFindings(w, null);
  assert.strictEqual(f.positives.length, 0, 'that week genuinely had nothing to celebrate');
  assert.ok(/self-inflicted/.test(f.headline));
});

test('REPLAY 2026-W34: the prior week, and the trend between them', { skip: !haveReal }, () => {
  const L = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
  const src = {
    grDays: L('gr_history.json'),
    tradesByDay: L('day_trades.json'),
    ledger: L('balance_ledger.json'),
    account: rules.eval,
    todayKey: '2026-08-29'
  };
  const prev = W.rollupWeek('2026-08-19', src);
  const cur = W.rollupWeek('2026-08-26', src);
  assert.strictEqual(prev.weekKey, '2026-W34');
  assert.strictEqual(prev.money.net, 811.94, 'the winning week');
  assert.strictEqual(cur.money.net, -1392.08);

  const t = {};
  W.compareWeeks(cur, prev).forEach(x => { t[x.key] = x; });
  assert.strictEqual(t.net.good, false);
  assert.strictEqual(t.giveback.good, false, 'giveback more than quintupled');
  assert.strictEqual(t.maxSize.now, 18);
  assert.strictEqual(t.maxSize.prev, 15);
});
