// Regression tests for session-windows.js — the DST drift found 2026-09-03,
// when the app's "London" window opened an hour after London actually did.
const test = require('node:test');
const assert = require('node:assert');
const sw = require('../session-windows');

// The live declaration, kept in step with rules.json's sessionWindows.
const WINDOWS = [
  { name: 'London', tz: 'Europe/London', startLocal: '08:00', endLocal: '09:30' },
  { name: 'NY', tz: 'America/New_York', startLocal: '09:30', endLocal: '11:30' }
];

const at = (istDate) => Date.parse(istDate + 'T12:00:00+05:30'); // midday IST that day
const byName = (rows, n) => rows.find(r => r.name === n);
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

// name, IST date, expected London open IST, expected NY open IST
const CASES = [
  ['BST + EDT — the day the bug was found', '2026-09-03', '12:30', '19:00'],
  ['last day of BST',                       '2026-10-24', '12:30', '19:00'],
  ['London back on GMT, NY still EDT',      '2026-10-26', '13:30', '19:00'],
  ['still the one-week overlap',            '2026-10-31', '13:30', '19:00'],
  ['NY on EST — both on standard time',     '2026-11-02', '13:30', '20:00'],
  ['deep winter',                           '2027-01-15', '13:30', '20:00'],
  ['US DST starts before UK, 2027',         '2027-03-16', '13:30', '19:00'],
  ['UK caught up, both on summer time',     '2027-04-01', '12:30', '19:00']
];

for (const [label, date, london, ny] of CASES) {
  test(`${date}: ${label}`, () => {
    const r = sw.resolveWindowsIST(WINDOWS, at(date));
    assert.strictEqual(hhmm(byName(r, 'London').startMin), london, 'London open IST');
    assert.strictEqual(hhmm(byName(r, 'NY').startMin), ny, 'NY open IST');
  });
}

test('THE BUG: the old fixed values were wrong on the day it was found', () => {
  const r = sw.resolveWindowsIST(WINDOWS, at('2026-09-03'));
  assert.notStrictEqual(byName(r, 'London').startMin, 810, 'London was pinned at 810 (13:30) — an hour late');
  assert.strictEqual(byName(r, 'London').startMin, 750); // 12:30
  assert.strictEqual(byName(r, 'NY').startMin, 1140);    // 19:00 — correct that day, by luck of the season
});

test('durations are preserved exactly — this moves opens, never lengths', () => {
  for (const [, date] of CASES) {
    const r = sw.resolveWindowsIST(WINDOWS, at(date));
    assert.strictEqual(byName(r, 'London').endMin - byName(r, 'London').startMin, 90, date);
    assert.strictEqual(byName(r, 'NY').endMin - byName(r, 'NY').startMin, 120, date);
  }
});

test('output is sorted by open time and keeps the consumer-facing shape', () => {
  const r = sw.resolveWindowsIST(WINDOWS, at('2026-09-03'));
  assert.deepStrictEqual(r.map(w => w.name), ['London', 'NY']);
  r.forEach(w => {
    assert.strictEqual(typeof w.startMin, 'number');
    assert.strictEqual(typeof w.endMin, 'number');
    assert.strictEqual(w.crossesIstMidnight, false);
  });
});

test('a fixed-IST window (no tz) passes through untouched', () => {
  const r = sw.resolveWindowsIST([{ name: 'Fixed', startMin: 810, endMin: 900 }], at('2026-09-03'));
  assert.strictEqual(r[0].startMin, 810);
  assert.strictEqual(r[0].endMin, 900);
});

test('malformed entries are dropped, never turned into a 00:00 window', () => {
  const r = sw.resolveWindowsIST([null, {}, { name: 'X', tz: 'Europe/London' }, WINDOWS[0]], at('2026-09-03'));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, 'London');
});

test('empty / non-array input yields an empty list, never a throw', () => {
  for (const v of [null, undefined, {}, [], 'nope']) {
    assert.deepStrictEqual(sw.resolveWindowsIST(v, at('2026-09-03')), []);
  }
});

test('tzOffsetMinutes agrees with the platform tz database', () => {
  assert.strictEqual(sw.tzOffsetMinutes('Europe/London', at('2026-09-03')), 60);   // BST
  assert.strictEqual(sw.tzOffsetMinutes('Europe/London', at('2026-11-02')), 0);    // GMT
  assert.strictEqual(sw.tzOffsetMinutes('America/New_York', at('2026-09-03')), -240); // EDT
  assert.strictEqual(sw.tzOffsetMinutes('America/New_York', at('2026-11-02')), -300); // EST
  assert.strictEqual(sw.tzOffsetMinutes('Asia/Kolkata', at('2026-09-03')), 330);   // never shifts
});

test('the resolved open really is the exchange open, round-tripped', () => {
  // Independent check: convert back and confirm the local wall clock reads 08:00 / 09:30.
  for (const [, date] of CASES) {
    const utcL = sw.zonedWallTimeToUtc(date, '08:00', 'Europe/London');
    const utcN = sw.zonedWallTimeToUtc(date, '09:30', 'America/New_York');
    const loc = (ms, tz) => new Date(ms).toLocaleString('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
    assert.strictEqual(loc(utcL, 'Europe/London'), '08:00', date);
    assert.strictEqual(loc(utcN, 'America/New_York'), '09:30', date);
  }
});
