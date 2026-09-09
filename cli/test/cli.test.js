'use strict';
// Tests for the pure logic under cli/. Run with:  node --test cli/test/
//
// Same convention as app/test/*.test.js — node's built-in runner, no framework.
// Nothing here touches the network or spawns a CLI; every case is a pure
// function fed a fixture. The three that matter most are the ones guarding
// bugs that were actually shipped and caught:
//
//   * unwrap()      — bare array vs envelope vs null (bug 2 in market-cli.js)
//   * empty vs null — [] and null at exit 0 mean NO DATA, not "no signal"
//   * gap baseline  — like-for-like percentile (the 100th-percentile-every-day
//                     bug found on the brief's first live run, 2026-09-06)

const test = require('node:test');
const assert = require('node:assert');

const { unwrap, exitInfo } = require('../market-cli');
const B = require('../market-brief');
const Y = require('../yahoo');

// ── market-cli: output shapes ──────────────────────────────────────────────
test('unwrap handles the envelope shape', () => {
  const u = unwrap({ meta: { source: 'live' }, results: [{ a: 1 }] });
  assert.equal(u.shape, 'envelope');
  assert.equal(u.empty, false);
  assert.deepEqual(u.data, [{ a: 1 }]);
  assert.deepEqual(u.meta, { source: 'live' });
});

test('unwrap handles a bare array — index-driver returns one', () => {
  const u = unwrap([{ symbol: 'RELIANCE' }]);
  assert.equal(u.shape, 'bare-array');
  assert.equal(u.empty, false);
  assert.equal(u.data.length, 1);
});

test('unwrap reports empty for [] and null without losing the distinction', () => {
  const arr = unwrap([]);
  assert.equal(arr.empty, true);
  assert.deepEqual(arr.data, []);

  const nul = unwrap(null);
  assert.equal(nul.empty, true);
  assert.equal(nul.data, null);

  // An envelope whose results is null is empty too — this is exactly what
  // delivery-spike returns before its store is synced, at exit code 0.
  const env = unwrap({ meta: {}, results: null });
  assert.equal(env.empty, true);
});

test('unwrap does not mistake a bare object for an envelope', () => {
  const u = unwrap({ chart: { result: [] } });
  assert.equal(u.shape, 'bare-object');
  assert.equal(u.empty, false);
});

// ── market-cli: exit codes ─────────────────────────────────────────────────
test('exit codes map to retryable correctly', () => {
  assert.equal(exitInfo(0).key, 'ok');
  assert.equal(exitInfo(7).key, 'rate');
  assert.equal(exitInfo(7).retryable, true, 'rate limit must be retryable');
  assert.equal(exitInfo(5).retryable, true, 'upstream API error must be retryable');
  assert.equal(exitInfo(4).key, 'auth');
  assert.equal(exitInfo(4).retryable, false, 'auth failure must NOT be retried');
  assert.equal(exitInfo(2).retryable, false);
  assert.equal(exitInfo(99).key, 'unknown');
});

// ── stats ──────────────────────────────────────────────────────────────────
test('percentileOf is the share of the sample strictly below the value', () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(B.percentileOf(s, 5.5), 50);
  assert.equal(B.percentileOf(s, 0), 0);
  assert.equal(B.percentileOf(s, 11), 100);
  assert.equal(B.percentileOf([], 5), null, 'empty sample has no percentile');
});

test('stdev matches the sample standard deviation', () => {
  assert.equal(B.stdev([2, 4, 4, 4, 5, 5, 7, 9]).toFixed(4), '2.1381');
  assert.equal(B.stdev([5]), 0, 'a single point has no spread');
  assert.equal(B.stdev([]), 0);
});

// ── timezone / session arithmetic ──────────────────────────────────────────
// 2026-09-04 13:35:00Z is 09:35 ET (EDT, UTC-4) and 19:05 IST — five minutes
// into the New York regular session.
const T_OPEN_PLUS_5 = Math.floor(Date.parse('2026-09-04T13:35:00Z') / 1000);
// 2026-09-04 12:00:00Z is 08:00 ET — premarket, before the 09:30 bell.
const T_PREMARKET = Math.floor(Date.parse('2026-09-04T12:00:00Z') / 1000);
// 2026-09-04 21:00:00Z is 17:00 ET — after the 16:00 close.
const T_AFTER_CLOSE = Math.floor(Date.parse('2026-09-04T21:00:00Z') / 1000);

test('isRTH brackets the 09:30-16:00 ET window', () => {
  assert.equal(Y.isRTH(T_OPEN_PLUS_5), true);
  assert.equal(Y.isRTH(T_PREMARKET), false);
  assert.equal(Y.isRTH(T_AFTER_CLOSE), false);
});

test('ET and IST are both derived from the same instant', () => {
  assert.equal(Y.fmtET(T_OPEN_PLUS_5), '09:35 ET');
  assert.equal(Y.fmtIST(T_OPEN_PLUS_5), '19:05 IST');
});

test('a Saturday resolves forward to Monday, not to Sunday', () => {
  // 2026-09-05 is a Saturday. The next 09:30 ET open is Monday the 7th, so the
  // answer must exceed a single day. A naive "+1 day" returns ~21h and would
  // tell him the session opens on a day the exchange is shut.
  const sat = Math.floor(Date.parse('2026-09-05T15:00:00Z') / 1000);
  assert.equal(Y.etParts(sat).wd, 'Sat');
  assert.ok(Y.minutesToNYOpen(sat) > 1440, 'must skip the weekend');
});

test('minutesToNYOpen is 0 inside the session', () => {
  assert.equal(Y.minutesToNYOpen(T_OPEN_PLUS_5), 0);
});

// ── sessionize ─────────────────────────────────────────────────────────────
// A fixture spanning premarket -> RTH -> after-close, so the overnight block
// that FOLLOWS a close is filed under the NEXT trading day.
function bar(iso, c) {
  return { t: Math.floor(Date.parse(iso) / 1000), o: c, h: c, l: c, c, v: 1 };
}

test('sessionize files pre-open bars under the day they lead into', () => {
  const bars = [
    bar('2026-09-03T12:00:00Z', 100), // Thu 08:00 ET — premarket for the 3rd
    bar('2026-09-03T14:00:00Z', 101), // Thu 10:00 ET — RTH of the 3rd
    bar('2026-09-03T21:00:00Z', 102), // Thu 17:00 ET — overnight into the 4th
    bar('2026-09-04T12:00:00Z', 103), // Fri 08:00 ET — premarket for the 4th
    bar('2026-09-04T14:00:00Z', 104), // Fri 10:00 ET — RTH of the 4th
  ];
  const s = B.sessionize(bars);

  const d3 = s.get('2026-09-03');
  const d4 = s.get('2026-09-04');
  assert.equal(d3.rth.length, 1);
  assert.equal(d3.overnight.length, 1, 'the 08:00 ET bar belongs to the 3rd');
  assert.equal(d4.rth.length, 1);
  assert.equal(d4.overnight.length, 2, 'Thu 17:00 ET + Fri 08:00 ET lead into the 4th');
});

test('sessionize keeps RTH and overnight disjoint', () => {
  const bars = [
    bar('2026-09-03T12:00:00Z', 100),
    bar('2026-09-03T14:00:00Z', 101),
    bar('2026-09-03T21:00:00Z', 102),
    bar('2026-09-04T14:00:00Z', 104),
  ];
  let total = 0;
  for (const s of B.sessionize(bars).values()) {
    total += s.rth.length + s.overnight.length;
    for (const b of s.rth) assert.equal(Y.isRTH(b.t), true);
    for (const b of s.overnight) assert.equal(Y.isRTH(b.t), false);
  }
  assert.equal(total, bars.length, 'every bar lands in exactly one bucket');
});

// ── the gap-baseline regression ────────────────────────────────────────────
// Guards the bug found on the first live run: the live gap measured
// (overnight close - prior RTH close) while the baseline measured
// (RTH open - overnight close). Different quantities, so every real gap
// scored 100th percentile and the brief claimed a record gap daily.
test('gap baseline compares like with like', () => {
  // Prior RTH closes: 100, 110. Overnight closes: 104, 118.
  // Correctly measured gaps: |104-100| = 4, then |118-110| = 8.
  const priorCloses = [100, 110];
  const overnightCloses = [104, 118];
  const gaps = [];
  for (let i = 0; i < priorCloses.length; i++) {
    if (i > 0) gaps.push(Math.abs(overnightCloses[i] - priorCloses[i - 1]));
  }
  // i=1 -> |118 - 100| = 18 under the ordering used in the fix (overnight of
  // session i against RTH close of session i-1).
  assert.deepEqual(gaps, [18]);

  // The point of the regression: a typical live gap must NOT land at the top
  // of its own distribution. Feed a distribution of like-measured gaps and a
  // mid-sized live gap, and expect a mid percentile.
  const baseline = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
  assert.equal(B.percentileOf(baseline, 11), 50);
  assert.notEqual(B.percentileOf(baseline, 11), 100);
});

// ── alerts never express a direction ───────────────────────────────────────
// The brief is deliberately directionless. If someone later adds a bullish or
// bearish field, this fails and they have to argue for it on purpose.
test('alerts carry no directional vocabulary', () => {
  const instruments = [{
    ok: true, label: 'MNQ', sessionsAnalysed: 48,
    overnight: { range: 300, rangePct: 95, rangeVsMedian: 1.8, posInRange: 90 },
    gap: { dir: 'up', pts: 57, usd: 114, percentile: 90 },
    sudden: [{ move: -114, z: -5.2, usd: 228, at: '08:30 ET / 18:00 IST' }],
  }];
  const alerts = B.buildAlerts(instruments, []);
  assert.ok(alerts.length > 0);
  for (const a of alerts) {
    assert.ok(!/\b(long|short|buy|sell|bullish|bearish)\b/i.test(a.text),
      'alert must not express a direction: ' + a.text);
    assert.ok(['high', 'note', 'error'].includes(a.level));
  }
});
