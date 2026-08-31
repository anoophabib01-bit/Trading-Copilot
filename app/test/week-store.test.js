'use strict';
/**
 * week-store.js tests — the disk half of the Weekly Report.
 *
 * Everything writes into a scratch DATA dir, never the real one. A test that
 * can freeze over DATA/weekly/2026-W35.json would destroy the record the tab
 * exists to preserve.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WS = require('../week-store');
const WR = require('../week-rollup');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'week-store-test-'));
}

/** A completed week with one clean profitable day and one oversize losing day. */
function sampleWeek(todayKey) {
  return WR.rollupWeek('2026-08-24', {
    grDays: [
      { date: '2026-08-24', pnl: 300, n: 2, over: 0, revenge: 0, maxSize: 2, giveback: 0, wins: 2, losses: 0, disc: 100 },
      { date: '2026-08-25', pnl: -500, n: 7, over: 3, revenge: 1, maxSize: 8, giveback: 200, wins: 2, losses: 5, disc: 55 }
    ],
    tradesByDay: {
      '2026-08-24': [{ pnl: 300, size: 2, flags: [] }],
      '2026-08-25': [{ pnl: -500, size: 8, flags: ['oversize', 'revenge'] }]
    },
    ledger: { '2026-08-24': { net: 300 }, '2026-08-25': { net: -500 } },
    account: { start: 50000, maxDrawdown: 2000, profitTarget: 3000, minTradingDays: 3 },
    todayKey: todayKey || '2026-08-29'
  });
}

// ── Doctrine ─────────────────────────────────────────────────────────────────

test('doctrine: round-trips verbatim, and a missing file is empty rather than an error', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(WS.loadDoctrine(dir), { text: '', updatedAt: null });
  const text = 'Two lots.\nTwo losses = platform closed.\n$2,000 is the whole life of this account.';
  WS.saveDoctrine(dir, text, 1787900000000);
  const back = WS.loadDoctrine(dir);
  assert.strictEqual(back.text, text, 'not reflowed, not trimmed, not regenerated');
  assert.strictEqual(back.updatedAt, new Date(1787900000000).toISOString());
});

test('doctrine is account-wide, not per slot — the mind does not change with the slot', () => {
  const dir = tmpDir();
  WS.saveDoctrine(dir, 'one mind', 1);
  assert.ok(WS.doctrinePath(dir).indexOf(path.join('weekly', 'doctrine.json')) >= 0);
  assert.ok(WS.doctrinePath(dir).indexOf('s1') < 0);
});

// ── Commitments ──────────────────────────────────────────────────────────────

test('normalizeCommitment: coerces junk rather than storing it', () => {
  const c = WS.normalizeCommitment({
    maxSize: '2', maxTradesPerDay: 0, stopTheWeekAt: 800,
    allowedSetups: ['A', 'B', '<script>', 'C'], focus: 'x'.repeat(900)
  }, '2026-W36', 1);
  assert.strictEqual(c.maxSize, 2, 'numeric string is fine');
  assert.strictEqual(c.maxTradesPerDay, null, 'zero is not a valid cap');
  assert.strictEqual(c.stopTheWeekAt, -800, 'a stop is stored negative however it was typed');
  assert.deepStrictEqual(c.allowedSetups, ['A', 'B', 'C'], 'unsafe setup labels dropped');
  assert.strictEqual(c.focus.length, 400, 'focus is bounded');
  assert.strictEqual(c.weekKey, '2026-W36');
});

test('saveCommitment: rejects a malformed week key instead of writing a stray file', () => {
  const dir = tmpDir();
  assert.strictEqual(WS.saveCommitment(dir, 's1', 'not-a-week', { maxSize: 2 }, 1), null);
  assert.strictEqual(WS.saveCommitment(dir, 's1', '2026-W36', { maxSize: 2 }, 1).maxSize, 2);
  assert.strictEqual(WS.loadCommitment(dir, 's1', '2026-W36').maxSize, 2);
  assert.strictEqual(WS.loadCommitment(dir, 's1', '2026-W99'), null);
});

test('gradeCommitment: grades what it can see and refuses to grade what it cannot', () => {
  const week = sampleWeek();
  const c = WS.normalizeCommitment(
    { maxSize: 2, maxTradesPerDay: 4, stopTheWeekAt: 800, allowedSetups: ['A'], focus: 'no entries before London open' },
    '2026-W35', 1);
  const g = WS.gradeCommitment(week, c);

  const by = {};
  g.checks.forEach(x => { by[x.key] = x; });
  assert.strictEqual(by.maxSize.kept, false, 'week hit 8 lots against a promised 2');
  assert.strictEqual(by.maxSize.actual, 8);
  assert.strictEqual(by.maxTradesPerDay.kept, false, '7 trades on 2026-08-25');
  assert.strictEqual(by.stopTheWeekAt.kept, true, 'week net -200 is inside a -800 stop');
  assert.strictEqual(g.checkable, 3);
  assert.strictEqual(g.kept, 1);
  assert.strictEqual(g.allKept, false);

  // The two things the app cannot verify must not carry a verdict.
  assert.strictEqual(g.setupsGradable, false, 'playbook tags do not exist on rows yet');
  assert.strictEqual(g.focusSelfAssessed, true);
  assert.strictEqual(g.focus, 'no entries before London open');
  assert.strictEqual(g.checks.find(x => x.key === 'focus'), undefined,
    'the focus item must never appear among the graded checks — the app cannot verify it');
});

test('gradeCommitment: a week that honoured everything reports allKept', () => {
  const week = WR.rollupWeek('2026-08-24', {
    grDays: [{ date: '2026-08-24', pnl: 120, n: 2, over: 0, revenge: 0, maxSize: 2, wins: 2, losses: 0, disc: 100 }],
    tradesByDay: { '2026-08-24': [{ pnl: 120, size: 2, flags: [] }] },
    ledger: { '2026-08-24': { net: 120 } },
    account: { maxDrawdown: 2000 },
    todayKey: '2026-08-29'
  });
  const g = WS.gradeCommitment(week, WS.normalizeCommitment({ maxSize: 2, maxTradesPerDay: 4, stopTheWeekAt: 800 }, '2026-W35', 1));
  assert.strictEqual(g.allKept, true);
  assert.strictEqual(g.kept, 3);
});

test('gradeCommitment: no commitment means no grade — not a passing grade', () => {
  assert.strictEqual(WS.gradeCommitment(sampleWeek(), null), null);
});

// ── Freezing ─────────────────────────────────────────────────────────────────

test('freezeWeek: refuses to freeze a week that has not finished', () => {
  const dir = tmpDir();
  const midWeek = sampleWeek('2026-08-26');       // Wednesday
  assert.strictEqual(midWeek.complete, false);
  assert.strictEqual(WS.freezeWeek(dir, 's1', midWeek, null, null, 1), null);
  assert.deepStrictEqual(WS.listFrozen(dir, 's1'), []);
});

test('freezeWeek: writes the record, and re-freezing preserves the ORIGINAL frozenAt', () => {
  const dir = tmpDir();
  const week = sampleWeek('2026-08-29');
  const f = WR.weekFindings(week, null);

  const first = WS.freezeWeek(dir, 's1', week, f, null, 1787900000000);
  assert.strictEqual(first.weekKey, '2026-W35');
  assert.strictEqual(first.refreezeCount, 0);
  assert.strictEqual(first.refrozenAt, null);

  const second = WS.freezeWeek(dir, 's1', week, f, null, 1787999999999);
  assert.strictEqual(second.frozenAt, first.frozenAt, 'the day he actually reviewed it must not move');
  assert.strictEqual(second.refreezeCount, 1);
  assert.ok(second.refrozenAt);

  assert.deepStrictEqual(WS.listFrozen(dir, 's1'), ['2026-W35']);
  assert.strictEqual(WS.loadFrozen(dir, 's1', '2026-W35').week.money.net, -200);
});

test('freezeWeek: slots are isolated — one account cannot read another back', () => {
  const dir = tmpDir();
  WS.freezeWeek(dir, 's1', sampleWeek('2026-08-29'), null, null, 1);
  assert.deepStrictEqual(WS.listFrozen(dir, 's2'), []);
  assert.strictEqual(WS.loadFrozen(dir, 's2', '2026-W35'), null);
});

test('a path-traversal slot cannot escape the weekly directory', () => {
  const dir = tmpDir();
  const p = WS.frozenPath(dir, '../../etc', '2026-W35');
  assert.ok(p.indexOf(path.join('weekly', 's1')) >= 0, 'an unsafe slot falls back to s1');
});

// ── Markdown ─────────────────────────────────────────────────────────────────

test('markdown: states the account damage, the blame, and refuses to invent positives', () => {
  const week = sampleWeek();
  const f = WR.weekFindings(week, null);
  const md = WS.renderWeekMarkdown(week, f, null, { slot: 's1' });

  assert.ok(md.indexOf('# Week 2026-W35') === 0);
  assert.ok(/Drawdown allowance \| \$2,000\.00/.test(md));
  assert.ok(/Oversize/.test(md), 'the blame slice is named');
  assert.ok(/Self-inflicted/.test(md), 'the losing day carries its quadrant');
  assert.ok(/## Positives/.test(md));
  assert.ok(/Best clean day/.test(md), 'the clean profitable day IS credited');
  assert.ok(md.indexOf('Sun | 2026-08-30') < 0, 'future days are omitted, not rendered as blanks');
});

test('markdown: a week with nothing good says so explicitly rather than leaving a gap', () => {
  const week = WR.rollupWeek('2026-08-24', {
    grDays: [{ date: '2026-08-24', pnl: -500, n: 5, over: 3, revenge: 2, maxSize: 8, giveback: 50, sizedUpIntoLoss: true, wins: 1, losses: 4, disc: 40 }],
    tradesByDay: { '2026-08-24': [{ pnl: -500, size: 8, flags: ['oversize'] }] },
    ledger: { '2026-08-24': { net: -500 } },
    account: { maxDrawdown: 2000 },
    todayKey: '2026-08-24'      // Monday: nothing else has happened, so no held-fire credit
  });
  const md = WS.renderWeekMarkdown(week, WR.weekFindings(week, null), null, { slot: 's1' });
  assert.ok(/Not a rendering gap/.test(md), 'the empty positives section explains itself');
});

test('markdown: a store disagreement is surfaced, never quietly resolved', () => {
  const week = WR.rollupWeek('2026-08-24', {
    grDays: [{ date: '2026-08-26', pnl: -673.6, n: 13, over: 1, revenge: 1 }],
    tradesByDay: { '2026-08-26': [{ pnl: -498.8, size: 1, flags: [] }] },
    ledger: { '2026-08-26': { net: -498.8 } },
    account: { maxDrawdown: 2000 },
    todayKey: '2026-08-29'
  });
  const md = WS.renderWeekMarkdown(week, WR.weekFindings(week, null), null, { slot: 's1' });
  assert.ok(/## Data note/.test(md));
  assert.ok(/gr_history -\$673\.60/.test(md));
});

test('markdown: the doctrine is quoted verbatim, not paraphrased', () => {
  const week = sampleWeek();
  const doctrine = { text: 'Two lots.\nTwo losses = platform closed.' };
  const md = WS.renderWeekMarkdown(week, WR.weekFindings(week, null), null, { slot: 's1', doctrine: doctrine });
  assert.ok(/> Two lots\./.test(md));
  assert.ok(/> Two losses = platform closed\./.test(md));
  assert.ok(/Where you drifted from it this week/.test(md));
});

test('writeWeekMarkdown: lands as sessions/Week-<key>.md', () => {
  const dir = tmpDir();
  const week = sampleWeek();
  const fp = WS.writeWeekMarkdown(dir, week, WR.weekFindings(week, null), null, { slot: 's1' });
  assert.strictEqual(path.basename(fp), 'Week-2026-W35.md');
  assert.ok(fs.readFileSync(fp, 'utf8').indexOf('# Week 2026-W35') === 0);
});

test('telegramSummary: short, and leads with the damage', () => {
  const week = sampleWeek();
  const s = WS.telegramSummary(week, WR.weekFindings(week, null));
  assert.ok(s.length < 600, 'a push notification, not the report');
  assert.ok(/-\$200\.00/.test(s));
  assert.ok(/Open the Week tab/.test(s));
});

// ── Building from real stores ────────────────────────────────────────────────

test('buildWeek: a slot with no stores yields an honest empty week, not a throw', () => {
  const dir = tmpDir();
  const w = WS.buildWeek(dir, 's9', '2026-08-26', '2026-08-29', { maxDrawdown: 2000 });
  assert.strictEqual(w.weekKey, '2026-W35');
  assert.strictEqual(w.behaviour.tradedDays, 0);
  assert.strictEqual(w.money.net, 0);
  assert.strictEqual(WR.weekFindings(w, null).headline, 'No trades this week.');
});

test('buildWeek: replays the real 2026-W35 from DATA/accounts/s1', { skip: !fs.existsSync(path.join(__dirname, '..', '..', 'DATA', 'accounts', 's1', 'gr_history.json')) }, () => {
  const DATA = path.join(__dirname, '..', '..', 'DATA');
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
  const w = WS.buildWeek(DATA, 's1', '2026-08-26', '2026-08-29', rules.eval);
  assert.strictEqual(w.money.net, -1392.08);
  assert.strictEqual(w.behaviour.trades, 49);
  assert.strictEqual(w.days[0].checklist.tier, 'NO-GO', 'ck_history is wired in');
  assert.ok(w.days[0].note, 'journal notes are wired in');
});
