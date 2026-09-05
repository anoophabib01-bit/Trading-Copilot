// Regression tests for today-status.js — the 2026-09-03 "you have already
// placed 6 trades today" false NO-GO. See the module header for the incident.
const test = require('node:test');
const assert = require('node:assert');
const { resolveTodayStatus } = require('../today-status');

// The exact shape of the live data at 13:06 IST on 2026-09-03: three rolled-up
// days ending 2026-09-02 (n:6, pnl:747.7), no rows at all for 2026-09-03.
const REAL_GR = [
  { date: '2026-08-31', n: 2, pnl: -62.9, disc: 63 },
  { date: '2026-09-01', n: 4, pnl: 70.8, disc: 69 },
  { date: '2026-09-02', n: 6, pnl: 747.7, disc: 88 }
];
const REAL_DT = { '2026-08-31': [{}, {}], '2026-09-01': [{}, {}, {}, {}], '2026-09-02': [{}, {}, {}, {}, {}, {}] };

test('THE BUG: a fresh day never inherits yesterday\'s trade count', () => {
  const st = resolveTodayStatus({
    grHistory: REAL_GR, dayTrades: REAL_DT, accTradeCount: 0, todayKey: '2026-09-03'
  });
  assert.strictEqual(st.n, 0, 'reported 6 (yesterday) as today — the live NO-GO bug');
  assert.strictEqual(st.hasTodayData, false);
  assert.strictEqual(st.today, null);
});

test('the last completed day is still available, but dated and separate', () => {
  const st = resolveTodayStatus({ grHistory: REAL_GR, dayTrades: REAL_DT, todayKey: '2026-09-03' });
  assert.strictEqual(st.prevDay.date, '2026-09-02');
  assert.strictEqual(st.prevDay.n, 6);
});

test('once today IS rolled up, today\'s own row wins', () => {
  const gr = REAL_GR.concat([{ date: '2026-09-03', n: 2, pnl: 15, disc: 90 }]);
  const st = resolveTodayStatus({ grHistory: gr, dayTrades: REAL_DT, accTradeCount: 99, todayKey: '2026-09-03' });
  assert.strictEqual(st.n, 2);
  assert.strictEqual(st.source, 'gr_history');
  assert.strictEqual(st.hasTodayData, true);
  assert.strictEqual(st.prevDay.date, '2026-09-02', 'prevDay must exclude today');
});

test('mid-session: per-trade rows count before the day is rolled up', () => {
  const dt = Object.assign({}, REAL_DT, { '2026-09-03': [{}, {}, {}] });
  const st = resolveTodayStatus({ grHistory: REAL_GR, dayTrades: dt, accTradeCount: 0, todayKey: '2026-09-03' });
  assert.strictEqual(st.n, 3);
  assert.strictEqual(st.source, 'day_trades');
  assert.strictEqual(st.hasTodayData, true);
});

test('falls back to the client counter only when today has no rows', () => {
  const st = resolveTodayStatus({ grHistory: REAL_GR, dayTrades: REAL_DT, accTradeCount: 2, todayKey: '2026-09-03' });
  assert.strictEqual(st.n, 2);
  assert.strictEqual(st.source, 'account');
  assert.strictEqual(st.hasTodayData, false, 'a client counter is not a logged record');
});

test('a re-rolled day uses the LAST row for that date, not the first', () => {
  const gr = [{ date: '2026-09-03', n: 1 }, { date: '2026-09-03', n: 4 }];
  assert.strictEqual(resolveTodayStatus({ grHistory: gr, todayKey: '2026-09-03' }).n, 4);
});

test('a future-dated row can never become prevDay', () => {
  const gr = REAL_GR.concat([{ date: '2026-09-09', n: 40, pnl: -9999 }]);
  const st = resolveTodayStatus({ grHistory: gr, dayTrades: REAL_DT, todayKey: '2026-09-03' });
  assert.strictEqual(st.prevDay.date, '2026-09-02');
  assert.strictEqual(st.n, 0);
});

test('empty / missing inputs degrade to a clean slate, never throw', () => {
  for (const arg of [undefined, {}, { grHistory: null, dayTrades: null, todayKey: '2026-09-03' }]) {
    const st = resolveTodayStatus(arg);
    assert.strictEqual(st.n, 0);
    assert.strictEqual(st.hasTodayData, false);
    assert.strictEqual(st.prevDay, null);
  }
});

test('the trading day is whatever the caller says — no clock read in here', () => {
  // A 01:00 IST turn belongs to the previous trading day (03:45 rollover).
  const st = resolveTodayStatus({ grHistory: REAL_GR, dayTrades: REAL_DT, todayKey: '2026-09-02' });
  assert.strictEqual(st.n, 6);
  assert.strictEqual(st.prevDay.date, '2026-09-01');
});
