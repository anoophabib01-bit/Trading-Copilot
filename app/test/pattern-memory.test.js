'use strict';
// Tests for pattern-memory.js — the durable episode ledger and its recurrence
// math (2026-09-03).
//
// The load-bearing decisions, and the tests that pin them:
//   - a rule-break that MADE money is still an episode (cost 0, not a gain)
//   - a losing trade with no flags is a POSITIVE, not a failure
//   - mistakes speak on the 2nd occurrence; positives need a streak
//   - one trade, one correction: pickPrimary never lets a bad trade fire twice
//   - ids are deterministic, so a backfill re-run duplicates nothing

const test = require('node:test');
const assert = require('node:assert');
const pm = require('../pattern-memory');

const T = (over) => Object.assign({ t: 1, x: 2, size: 1, pnl: 0, g: 'A', flags: [], side: 'LONG', hold: 60 }, over);

test('a flagged trade produces one episode per known flag', () => {
  const eps = pm.tradeEpisodes(T({ size: 20, pnl: -1718, flags: ['oversize', 'revenge'] }), { date: '2026-09-03', index: 5 });
  assert.deepStrictEqual(eps.map(e => e.kind).sort(), ['oversize', 'revenge']);
  eps.forEach(e => {
    assert.strictEqual(e.type, 'mistake');
    assert.strictEqual(e.cost, -1718);
    assert.strictEqual(e.date, '2026-09-03');
  });
});

test('an unknown flag is ignored, never reinterpreted as something it is not', () => {
  const eps = pm.tradeEpisodes(T({ pnl: -10, flags: ['some-future-flag'] }), { date: '2026-09-03', index: 0 });
  // No known flag matched, but flags is non-empty, so this is neither a
  // recorded mistake nor a clean trade. Recording nothing is the honest answer.
  assert.deepStrictEqual(eps, []);
});

test('a rule-break that MADE money is still an episode, with zero cost', () => {
  // JESSI_PERSONA's JadeCap mechanism 7: a profitable rule-break is the
  // dangerous one, because it gets filed as "that works". It must be counted.
  const eps = pm.tradeEpisodes(T({ size: 8, pnl: 240, flags: ['oversize'] }), { date: '2026-09-01', index: 2 });
  assert.strictEqual(eps.length, 1);
  assert.strictEqual(eps[0].kind, 'oversize');
  assert.strictEqual(eps[0].cost, 0);            // it did no damage...
  assert.strictEqual(eps[0].profitedAnyway, true); // ...and that is the point
});

test('a LOSING trade with no flags is a positive, not a failure', () => {
  const eps = pm.tradeEpisodes(T({ pnl: -85, flags: [] }), { date: '2026-09-02', index: 1 });
  assert.strictEqual(eps.length, 1);
  assert.strictEqual(eps[0].kind, 'disciplined-loss');
  assert.strictEqual(eps[0].type, 'positive');
  assert.strictEqual(eps[0].gain, 0);
  assert.strictEqual(eps[0].cost, -85);
});

test('a winning trade with no flags is a clean-winner', () => {
  const eps = pm.tradeEpisodes(T({ pnl: 180, flags: [] }), { date: '2026-09-02', index: 0 });
  assert.strictEqual(eps[0].kind, 'clean-winner');
  assert.strictEqual(eps[0].gain, 180);
});

test('day episodes read the shapes a single trade cannot show', () => {
  const day = {
    date: '2026-09-03', n: 6, pnl: -2296.3, maxSize: 20, disc: 75,
    over: 4, revenge: 1, sizedUpIntoLoss: true, tradedPast3Losses: false, peak: 24,
    giveback: 2231,
  };
  const kinds = pm.dayEpisodes(day, { rules: { tradesPerDay: 5 } }).map(e => e.kind).sort();
  assert.deepStrictEqual(kinds, ['giveback', 'overtrading', 'size-up-into-loss']);
});

test('giveback needs a day that was actually green first', () => {
  // A day that was never up has nothing to give back; calling its drawdown
  // "giveback" would be a second accusation for one losing day.
  const neverGreen = { date: '2026-09-03', n: 3, pnl: -500, peak: 0, giveback: 0, disc: 80, over: 0, revenge: 0 };
  assert.strictEqual(pm.dayEpisodes(neverGreen, { rules: { tradesPerDay: 5 } }).some(e => e.kind === 'giveback'), false);

  const wasGreen = { date: '2026-09-03', n: 3, pnl: -500, peak: 300, giveback: 800, disc: 80, over: 0, revenge: 0 };
  assert.strictEqual(pm.dayEpisodes(wasGreen, { rules: { tradesPerDay: 5 } }).some(e => e.kind === 'giveback'), true);
});

test('a clean day needs BOTH no violations and the green discipline bar', () => {
  const base = { date: '2026-09-01', n: 3, pnl: 100, disc: 85, over: 0, revenge: 0, sizedUpIntoLoss: false, peak: 100 };
  assert.ok(pm.dayEpisodes(base, { rules: { tradesPerDay: 5 } }).some(e => e.kind === 'clean-day'));
  // Same day, one over-cap trade: no longer clean.
  assert.ok(!pm.dayEpisodes({ ...base, over: 1 }, { rules: { tradesPerDay: 5 } }).some(e => e.kind === 'clean-day'));
  // Same day, discipline below the bar: no longer clean.
  assert.ok(!pm.dayEpisodes({ ...base, disc: 60 }, { rules: { tradesPerDay: 5 } }).some(e => e.kind === 'clean-day'));
});

test('overtrading is measured against the rule, never a hardcoded number', () => {
  const day = { date: '2026-09-03', n: 6, pnl: -100, disc: 70, over: 0, revenge: 0, peak: 0 };
  assert.ok(pm.dayEpisodes(day, { rules: { tradesPerDay: 5 } }).some(e => e.kind === 'overtrading'));
  assert.ok(!pm.dayEpisodes(day, { rules: { tradesPerDay: 10 } }).some(e => e.kind === 'overtrading'));
  // No rule supplied = no claim made.
  assert.ok(!pm.dayEpisodes(day, { rules: {} }).some(e => e.kind === 'overtrading'));
});

test('episode ids are deterministic, so a backfill re-run duplicates nothing', () => {
  const input = {
    tradesByDay: { '2026-09-03': [T({ pnl: -100, flags: ['oversize'] }), T({ pnl: 50 })] },
    days: [{ date: '2026-09-03', n: 2, pnl: -50, disc: 80, over: 1, revenge: 0, peak: 0 }],
    rules: { tradesPerDay: 5 },
  };
  const a = pm.buildEpisodes(input).map(e => e.id);
  const b = pm.buildEpisodes(input).map(e => e.id);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(new Set(a).size, a.length, 'ids must be unique within one build');
});

test('recurrence counts occurrences, distinct days and cumulative damage', () => {
  const eps = pm.buildEpisodes({
    tradesByDay: {
      '2026-09-01': [T({ pnl: -100, flags: ['oversize'] }), T({ pnl: 200, flags: ['oversize'] })],
      '2026-09-02': [T({ pnl: -300, flags: ['oversize'] })],
    },
    days: [], rules: {},
  });
  const r = pm.recurrence(eps, 'oversize');
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.days, 2);
  assert.strictEqual(r.totalCost, -400);        // the winner contributes 0
  assert.strictEqual(r.profitedAnywayCount, 1);
  assert.strictEqual(r.firstSeen, '2026-09-01');
  assert.strictEqual(r.lastSeen, '2026-09-02');
  assert.strictEqual(r.isRepeat, true);
  assert.strictEqual(r.worst.cost, -300);
});

test('trend compares a rate, not a raw count — trading more is not getting worse', () => {
  // 12 trading days. Oversize on 2 of the first 6, then on 5 of the last 5.
  const tradesByDay = {};
  for (let i = 1; i <= 12; i++) {
    const date = '2026-09-' + String(i).padStart(2, '0');
    const flagged = (i <= 6) ? (i <= 2) : true;
    tradesByDay[date] = [T({ pnl: -10, flags: flagged ? ['oversize'] : [] })];
  }
  const eps = pm.buildEpisodes({ tradesByDay, days: [], rules: {} });
  const r = pm.recurrence(eps, 'oversize', { windowDays: 5 });
  assert.strictEqual(r.recentWindowDays, 5);
  assert.strictEqual(r.recentDaysWithIt, 5);
  assert.strictEqual(r.trend, 'worsening');
});

test('a single-day pattern reads as new, not as a trend', () => {
  const eps = pm.buildEpisodes({ tradesByDay: { '2026-09-03': [T({ pnl: -10, flags: ['revenge'] })] }, days: [], rules: {} });
  const r = pm.recurrence(eps, 'revenge');
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.isRepeat, false);
  assert.strictEqual(r.trend, 'new');
});

test('a MISTAKE speaks on the second occurrence, never the first', () => {
  const first = pm.buildEpisodes({ tradesByDay: { '2026-09-01': [T({ pnl: -50, flags: ['revenge'] })] }, days: [], rules: {} });
  const ep = first[0];
  const decideFirst = pm.shouldIntervene(ep, pm.recurrence(first, 'revenge'), { firedToday: {} });
  assert.strictEqual(decideFirst.intervene, false);
  assert.match(decideFirst.reason, /first occurrence/);

  const twice = pm.buildEpisodes({
    tradesByDay: { '2026-09-01': [T({ pnl: -50, flags: ['revenge'] })], '2026-09-02': [T({ pnl: -60, flags: ['revenge'] })] },
    days: [], rules: {},
  });
  const decideSecond = pm.shouldIntervene(twice[1], pm.recurrence(twice, 'revenge'), { firedToday: {} });
  assert.strictEqual(decideSecond.intervene, true);
  assert.match(decideSecond.reason, /repeat #2/);
});

test('once per kind per day — today\'s fourth oversize is not four things to say', () => {
  const eps = pm.buildEpisodes({
    tradesByDay: { '2026-09-02': [T({ pnl: -10, flags: ['oversize'] })], '2026-09-03': [T({ pnl: -20, flags: ['oversize'] })] },
    days: [], rules: {},
  });
  const rec = pm.recurrence(eps, 'oversize');
  assert.strictEqual(pm.shouldIntervene(eps[1], rec, { firedToday: {} }).intervene, true);
  const blocked = pm.shouldIntervene(eps[1], rec, { firedToday: { oversize: true } });
  assert.strictEqual(blocked.intervene, false);
  assert.match(blocked.reason, /already spoken/);
});

test('a worsening repeat is escalated to high severity', () => {
  const tradesByDay = {};
  for (let i = 1; i <= 12; i++) {
    const date = '2026-09-' + String(i).padStart(2, '0');
    tradesByDay[date] = [T({ pnl: -10, flags: (i <= 6 ? (i <= 1 ? ['revenge'] : []) : ['revenge']) })];
  }
  const eps = pm.buildEpisodes({ tradesByDay, days: [], rules: {} });
  const rec = pm.recurrence(eps, 'revenge', { windowDays: 5 });
  assert.strictEqual(rec.trend, 'worsening');
  const d = pm.shouldIntervene(eps.find(e => e.kind === 'revenge' && e.date === '2026-09-12'), rec, { firedToday: {} });
  assert.strictEqual(d.intervene, true);
  assert.strictEqual(d.severity, 'high');
});

test('POSITIVES need a streak, because congratulating every clean trade is noise', () => {
  const one = pm.buildEpisodes({ tradesByDay: { '2026-09-03': [T({ pnl: 50 }), T({ pnl: 60 })] }, days: [], rules: {} });
  const rec2 = pm.recurrence(one, 'clean-winner');
  const notYet = pm.shouldIntervene(one[1], rec2, { firedToday: {}, todayEpisodes: one });
  assert.strictEqual(notYet.intervene, false, 'two clean winners is not yet a streak');

  const three = pm.buildEpisodes({ tradesByDay: { '2026-09-03': [T({ pnl: 50 }), T({ pnl: 60 }), T({ pnl: 70 })] }, days: [], rules: {} });
  const rec3 = pm.recurrence(three, 'clean-winner');
  const now = pm.shouldIntervene(three[2], rec3, { firedToday: {}, todayEpisodes: three });
  assert.strictEqual(now.intervene, true);
  assert.strictEqual(now.severity, 'positive');
});

test('onlyFromDay is what stops a backfill replaying history into chat', () => {
  // The live bug this exists for (2026-09-03, first run): switching to the
  // scalper trade cap reclassified eight OLD days as fresh episodes, and the
  // agent opened with an "eighth green day" compliment on an afternoon he was
  // down $2,296. "New to the ledger" is not "just happened".
  const added = [
    { id: 'a', kind: 'stopped-in-profit', type: 'positive', date: '2026-08-24' },
    { id: 'b', kind: 'oversize', type: 'mistake', date: '2026-09-03' },
    { id: 'c', kind: 'revenge', type: 'mistake', date: '2026-08-31' },
  ];
  const fresh = pm.onlyFromDay(added, '2026-09-03');
  assert.strictEqual(fresh.length, 1);
  assert.strictEqual(fresh[0].id, 'b');
  // No day, no trigger — never fall open and announce everything.
  assert.deepStrictEqual(pm.onlyFromDay(added, null), []);
  assert.deepStrictEqual(pm.onlyFromDay(null, '2026-09-03'), []);
});

test('recurrence still counts every day even though only today can trigger', () => {
  const eps = pm.buildEpisodes({
    tradesByDay: {
      '2026-08-31': [T({ pnl: -10, flags: ['oversize'] })],
      '2026-09-03': [T({ pnl: -20, flags: ['oversize'] })],
    },
    days: [], rules: {},
  });
  assert.strictEqual(pm.onlyFromDay(eps, '2026-09-03').length, 1);
  assert.strictEqual(pm.recurrence(eps, 'oversize').count, 2, 'history still counts toward the number');
});

test('pickPrimary gives ONE correction per trade, worst first', () => {
  // JESSI_PERSONA rule 5: one correction per reply. A 20-lot revenge entry is
  // two real failures, but the reply must lead with the size.
  const eps = pm.tradeEpisodes(T({ size: 20, pnl: -1718, flags: ['revenge', 'oversize', 'hold-exceeded'] }), { date: '2026-09-03', index: 5 });
  const primary = pm.pickPrimary(eps, eps);
  assert.strictEqual(primary.kind, 'oversize');   // severity 100 > revenge 95 > hold 60
});

test('pickPrimary breaks a severity tie on how entrenched the pattern is', () => {
  const ledger = pm.buildEpisodes({
    tradesByDay: {
      '2026-09-01': [T({ pnl: -10, flags: ['news'] }), T({ pnl: -10, flags: ['news'] })],
      '2026-09-02': [T({ pnl: -10, flags: ['out-of-window'] })],
    },
    days: [], rules: {},
  });
  // 'out-of-window' (55) outranks 'news' (50) on severity outright.
  const today = pm.tradeEpisodes(T({ pnl: -10, flags: ['news', 'out-of-window'] }), { date: '2026-09-03', index: 0 });
  assert.strictEqual(pm.pickPrimary(today, ledger).kind, 'out-of-window');
});

test('summarize orders by how often it happens, mistakes and positives together', () => {
  const eps = pm.buildEpisodes({
    tradesByDay: {
      '2026-09-01': [T({ pnl: -10, flags: ['oversize'] }), T({ pnl: -10, flags: ['oversize'] }), T({ pnl: 5 })],
      '2026-09-02': [T({ pnl: -10, flags: ['revenge'] })],
    },
    days: [], rules: {},
  });
  const s = pm.summarize(eps);
  assert.strictEqual(s[0].kind, 'oversize');
  assert.strictEqual(s[0].count, 2);
  assert.ok(s.some(r => r.type === 'positive'));
});

test('formatRecurrence names the profitable-rule-break trap explicitly', () => {
  const eps = pm.buildEpisodes({
    tradesByDay: { '2026-09-01': [T({ pnl: 200, flags: ['oversize'] })], '2026-09-02': [T({ pnl: -300, flags: ['oversize'] })] },
    days: [], rules: {},
  });
  const txt = pm.formatRecurrence(pm.recurrence(eps, 'oversize'));
  assert.match(txt, /Cumulative damage[^\n]*-\$300/);
  assert.match(txt, /1 of these MADE money/);
  assert.match(txt, /that works/);
  assert.match(txt, /Signal source/);
});

test('formatMemory leads mistakes and positives separately, and survives an empty ledger', () => {
  assert.match(pm.formatMemory([]), /empty/);
  const eps = pm.buildEpisodes({
    tradesByDay: { '2026-09-01': [T({ pnl: -10, flags: ['oversize'] }), T({ pnl: 40 })] },
    days: [], rules: {},
  });
  const txt = pm.formatMemory(eps);
  assert.match(txt, /MISTAKES/);
  assert.match(txt, /POSITIVES/);
});

test('money formats a signed dollar figure the same way everywhere', () => {
  assert.strictEqual(pm.money(-1718), '-$1,718');
  assert.strictEqual(pm.money(0), '$0');
  assert.strictEqual(pm.money(1294.5), '$1,294.5');
});

test('every KIND declares a type, a severity, a label and a source', () => {
  // A pattern with no cited source is an accusation the app cannot back up.
  Object.keys(pm.KINDS).forEach(k => {
    const info = pm.KINDS[k];
    assert.ok(info.type === 'mistake' || info.type === 'positive', k + ' needs a type');
    assert.ok(Number.isFinite(info.severity), k + ' needs a severity');
    assert.ok(info.label && info.label.length > 3, k + ' needs a label');
    assert.ok(info.source && info.source.length > 10, k + ' needs a cited source');
  });
});

test('replays his real 2026-09-03 trades end to end', () => {
  // The six live trades from DATA/accounts/s2/day_trades.json for that day.
  const real = [
    { size: 2, pnl: 9.2, g: 'A', flags: [], hold: 118 },
    { size: 4, pnl: -1.6, g: 'B', flags: ['oversize'], hold: 16 },
    { size: 2, pnl: 1.2, g: 'B', flags: ['hold-exceeded'], hold: 2134 },
    { size: 4, pnl: -526.1, g: 'B', flags: ['oversize'], hold: 120 },
    { size: 15, pnl: -61, g: 'C', flags: ['oversize', 'revenge'], hold: 37 },
    { size: 20, pnl: -1718, g: 'B', flags: ['oversize'], hold: 14 },
  ];
  const eps = pm.buildEpisodes({
    tradesByDay: { '2026-09-03': real },
    days: [{ date: '2026-09-03', n: 6, pnl: -2296.3, maxSize: 20, disc: 75, over: 4, revenge: 1, sizedUpIntoLoss: true, peak: 24, giveback: 2231 }],
    rules: { tradesPerDay: 5 },
  });
  const over = pm.recurrence(eps, 'oversize');
  assert.strictEqual(over.count, 4);
  // -1.6 + -526.1 + -61 + -1718. The 15-lot is oversize AND revenge, so its
  // -61 counts toward both totals — the double-count is deliberate: dropping
  // it from either would understate that pattern's real damage.
  assert.strictEqual(over.totalCost, -2306.7);
  assert.strictEqual(pm.recurrence(eps, 'revenge').totalCost, -61);
  // The 2-lot winner is the one clean trade of the day.
  assert.strictEqual(pm.recurrence(eps, 'clean-winner').count, 1);
  // The day-level shapes are all present.
  const kinds = new Set(eps.map(e => e.kind));
  assert.ok(kinds.has('size-up-into-loss'));
  assert.ok(kinds.has('overtrading'));
  assert.ok(kinds.has('giveback'));
});
