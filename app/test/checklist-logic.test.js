const test = require('node:test');
const assert = require('node:assert');
const CL = require('../renderer/checklist-logic.js');

// Fixed instants (UTC) used throughout so nothing depends on the clock.
const utc = (s) => Date.parse(s);

test('tradingDayIST rolls at 03:30 IST, not midnight IST', () => {
  // CHANGED 2026-08-15 (Anoop): a completion logged at 01:00 IST used to
  // count as "today" the instant the calendar flipped at midnight, unlocking
  // the gate for a session he had not started yet. Now the checklist day
  // doesn't roll until 03:30 IST, matching how trade records already treat
  // 00:00-03:30/03:45 IST as still "last night" (tradingDayStampIST in
  // server.js).
  // 22:05 UTC Thu = 03:35 IST Fri → past the cutoff, already Friday.
  assert.strictEqual(CL.tradingDayIST(utc('2026-08-13T22:05:00Z')), '2026-08-14');
  // 18:35 UTC Thu = 00:05 IST Fri → before the cutoff, still Thursday.
  assert.strictEqual(CL.tradingDayIST(utc('2026-08-13T18:35:00Z')), '2026-08-13');
  // 18:25 UTC Thu = 23:55 IST Thu → still Thursday.
  assert.strictEqual(CL.tradingDayIST(utc('2026-08-13T18:25:00Z')), '2026-08-13');
});

test('THE BUG THIS PREVENTS: a 01:00 IST completion does NOT satisfy the NEXT day\'s gate', () => {
  // 2026-08-13 19:30 UTC == 2026-08-14 01:00 IST — before the 03:30 cutoff,
  // so this checklist is still filed under 2026-08-13, and must NOT unlock
  // the gate once the calendar flips to 2026-08-14 at midnight.
  const t = utc('2026-08-13T19:30:00Z');
  const day = CL.tradingDayIST(t);
  assert.strictEqual(day, '2026-08-13');
  // A day later, still before that new day's 03:30 cutoff — must stay locked.
  const nextMorning = utc('2026-08-14T04:00:00Z'); // 09:30 IST
  assert.strictEqual(CL.ckGateOpen([{ date: day, tier: 'GO', done: true }], CL.tradingDayIST(nextMorning)), false);
});

test('sessionFromUTC boundaries are half-open', () => {
  assert.strictEqual(CL.sessionFromUTC(utc('2026-08-13T07:59:00Z')), '');
  assert.strictEqual(CL.sessionFromUTC(utc('2026-08-13T08:00:00Z')), 'london');
  assert.strictEqual(CL.sessionFromUTC(utc('2026-08-13T09:29:00Z')), 'london');
  assert.strictEqual(CL.sessionFromUTC(utc('2026-08-13T09:30:00Z')), '');
  assert.strictEqual(CL.sessionFromUTC(utc('2026-08-13T13:29:00Z')), '');
  assert.strictEqual(CL.sessionFromUTC(utc('2026-08-13T13:30:00Z')), 'ny');
  assert.strictEqual(CL.sessionFromUTC(utc('2026-08-13T15:29:00Z')), 'ny');
  assert.strictEqual(CL.sessionFromUTC(utc('2026-08-13T15:30:00Z')), '');
});

test('no session on a closed market — Saturday inside the NY window', () => {
  // 2026-08-15 is a Saturday. The old ckSessFromUTC returned 'ny' here and told
  // him to start a screen recording for a market that is shut.
  assert.strictEqual(new Date(utc('2026-08-15T13:45:00Z')).getUTCDay(), 6);
  assert.strictEqual(CL.sessionFromUTC(utc('2026-08-15T13:45:00Z')), '');
  assert.strictEqual(CL.isWeekendIST(utc('2026-08-15T13:45:00Z')), true);
});

test('isoWeekKey is stable across a week and increments across the boundary', () => {
  const thu = CL.isoWeekKey(utc('2026-08-13T06:00:00Z'));
  const fri = CL.isoWeekKey(utc('2026-08-14T06:00:00Z'));
  assert.strictEqual(thu, fri);
  assert.match(thu, /^2026-W\d{2}$/);
  const nextMon = CL.isoWeekKey(utc('2026-08-17T06:00:00Z'));
  assert.notStrictEqual(thu, nextMon);
});

// ── Scoring ───────────────────────────────────────────────────────────────────

test('a fully satisfied playbook reaches 10/10 GO', () => {
  const r = CL.ckScore({ selPb: 1, htfDone: 3, structDone: 3, riskDone: 4, riskTotal: 4, fwDone: 5 });
  assert.strictEqual(r.score, 10);
  assert.strictEqual(r.tier, 'GO');
  assert.strictEqual(r.total, 15);
  assert.strictEqual(r.label, 'Engulfing + TF');
});

test('THE DIVERGENCE THIS PREVENTS: risk count comes from the caller, never hardcoded', () => {
  // ckUpdateVerdict hardcoded 4 risk items; ckMarkDone read riskTotal from the
  // DOM. With 5 risk items in index.html the banner said x/15 while the saved
  // score used /16. One function, one total.
  const four = CL.ckScore({ selPb: 1, htfDone: 3, structDone: 3, riskDone: 4, riskTotal: 4, fwDone: 5 });
  const five = CL.ckScore({ selPb: 1, htfDone: 3, structDone: 3, riskDone: 5, riskTotal: 5, fwDone: 5 });
  assert.strictEqual(four.total, 15);
  assert.strictEqual(five.total, 16);
  assert.strictEqual(five.tier, 'GO');
});

test('Risk Gate is a hard gate — 10/10 elsewhere is still NO-GO if one risk item is missing', () => {
  const r = CL.ckScore({ selPb: 1, htfDone: 3, structDone: 3, riskDone: 3, riskTotal: 4, fwDone: 5 });
  assert.strictEqual(r.tier, 'NO-GO');
  assert.strictEqual(r.riskFull, false);
  assert.match(r.verdict, /Risk Gate incomplete \(3\/4\)/);
});

test('an empty risk block reads NO-GO, never cleared', () => {
  const r = CL.ckScore({ selPb: 1, htfDone: 3, structDone: 3, riskDone: 0, riskTotal: 0, fwDone: 5 });
  assert.strictEqual(r.riskFull, false);
  assert.strictEqual(r.tier, 'NO-GO');
});

test('no playbook selected scores 0 and is NO-GO', () => {
  const r = CL.ckScore({ htfDone: 3, riskDone: 4, riskTotal: 4, fwDone: 5 });
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.tier, 'NO-GO');
  assert.match(r.verdict, /No playbook selected/);
});

test('news blackout overrides everything, including a perfect card', () => {
  const r = CL.ckScore({ selPb: 1, htfDone: 3, structDone: 3, riskDone: 4, riskTotal: 4, fwDone: 5, blackout: true });
  assert.strictEqual(r.tier, 'NO-GO');
  assert.match(r.verdict, /blackout/);
});

test('tier boundaries: >=8 GO, 5-7 CAUTION, <5 NO-GO', () => {
  const mk = (structDone, fwDone) => CL.ckScore({
    selPb: 2, htfDone: 3, structDone, riskDone: 4, riskTotal: 4, fwDone
  });
  // total = 3 + 4 + 4 + 5 = 16
  assert.strictEqual(mk(4, 5).score, 10);         // 16/16
  assert.strictEqual(mk(4, 5).tier, 'GO');
  assert.strictEqual(mk(1, 4).score, 8);          // 12/16 → 7.5 rounds to 8
  assert.strictEqual(mk(1, 4).tier, 'GO');
  assert.strictEqual(mk(0, 2).score, 6);          // 9/16 → 5.6 rounds to 6
  assert.strictEqual(mk(0, 2).tier, 'CAUTION');
  assert.strictEqual(mk(0, 0).score, 4);          // 7/16 → 4.4 rounds to 4
  assert.strictEqual(mk(0, 0).tier, 'NO-GO');
});

// ── Gate predicate ────────────────────────────────────────────────────────────

test('gate opens on a completed checklist for today', () => {
  assert.strictEqual(CL.ckGateOpen([{ date: '2026-08-13', tier: 'GO', done: true }], '2026-08-13'), true);
});

test('gate opens on an honest NO-GO — completion is what counts, not the verdict', () => {
  // Anoop 2026-08-13: gating on GO would give him a reason to fudge ticks.
  assert.strictEqual(CL.ckGateOpen([{ date: '2026-08-13', tier: 'NO-GO', done: true }], '2026-08-13'), true);
});

test('gate opens on an explicit SKIPPED — the escape hatch must work', () => {
  assert.strictEqual(CL.ckGateOpen([{ date: '2026-08-13', tier: 'SKIPPED' }], '2026-08-13'), true);
});

test('gate stays shut when only yesterday was completed', () => {
  assert.strictEqual(CL.ckGateOpen([{ date: '2026-08-12', tier: 'GO', done: true }], '2026-08-13'), false);
});

test('gate stays shut on an empty history', () => {
  assert.strictEqual(CL.ckGateOpen([], '2026-08-13'), false);
});

test('THE LOCKOUT THIS PREVENTS: the gate fails OPEN on anything malformed', () => {
  // This predicate controls access to his own app during a live session. A
  // corrupt localStorage value must never be able to brick it. Contrast with
  // the go/no-go badge, which correctly fails CLOSED because it only advises.
  assert.strictEqual(CL.ckGateOpen(null, '2026-08-13'), true);
  assert.strictEqual(CL.ckGateOpen(undefined, '2026-08-13'), true);
  assert.strictEqual(CL.ckGateOpen('not an array', '2026-08-13'), true);
  assert.strictEqual(CL.ckGateOpen({}, '2026-08-13'), true);
  assert.strictEqual(CL.ckGateOpen([{ date: '2026-08-13' }], null), true);
});

test('null entries in history do not throw', () => {
  assert.strictEqual(CL.ckGateOpen([null, undefined, { date: '2026-08-13', tier: 'GO' }], '2026-08-13'), true);
  assert.strictEqual(CL.ckGateOpen([null], '2026-08-13'), false);
});

// ── Streak ────────────────────────────────────────────────────────────────────

test('streak counts consecutive completed weekdays', () => {
  const h = [
    { date: '2026-08-13', tier: 'GO' },
    { date: '2026-08-12', tier: 'NO-GO' },
    { date: '2026-08-11', tier: 'CAUTION' }
  ];
  assert.strictEqual(CL.ckStreak(h, '2026-08-13'), 3);
});

test('a SKIPPED day breaks the streak', () => {
  const h = [
    { date: '2026-08-13', tier: 'GO' },
    { date: '2026-08-12', tier: 'SKIPPED' },
    { date: '2026-08-11', tier: 'GO' }
  ];
  assert.strictEqual(CL.ckStreak(h, '2026-08-13'), 1);
});

test('the weekend does not break the streak', () => {
  // 2026-08-14 Fri, 15 Sat, 16 Sun, 17 Mon.
  const h = [
    { date: '2026-08-17', tier: 'GO' },
    { date: '2026-08-14', tier: 'GO' }
  ];
  assert.strictEqual(CL.ckStreak(h, '2026-08-17'), 2);
});

test("today not done yet does not zero yesterday's streak", () => {
  const h = [{ date: '2026-08-12', tier: 'GO' }, { date: '2026-08-11', tier: 'GO' }];
  assert.strictEqual(CL.ckStreak(h, '2026-08-13'), 2);
});

test('streak on empty/garbage history is 0 and does not throw', () => {
  assert.strictEqual(CL.ckStreak([], '2026-08-13'), 0);
  assert.strictEqual(CL.ckStreak(null, '2026-08-13'), 0);
  assert.strictEqual(CL.ckStreak([{ date: '2026-08-13', tier: 'GO' }], null), 0);
});
