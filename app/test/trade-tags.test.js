'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tagTrades, classifySession } = require('../trade-tags');
const WIN = [{ name: 'London', startMin: 750, endMin: 840 }, { name: 'NY', startMin: 1140, endMin: 1260 }];
test('session classification across the day', () => {
  assert.equal(classifySession(600, WIN), 'asia');
  assert.equal(classifySession(800, WIN), 'london');
  assert.equal(classifySession(1000, WIN), 'lunch');
  assert.equal(classifySession(1200, WIN), 'ny-open');
  assert.equal(classifySession(1300, WIN), 'pm');
});
test('tradeIndexOfDay resets per day and afterLoss tracks the previous trade', () => {
  const t1 = { entryAt: Date.parse('2026-09-05T13:30:00Z'), exitAt: Date.parse('2026-09-05T13:32:00Z'), side: 'buy', symbol: 'MNQ', pnl: -50 };
  const t2 = { entryAt: Date.parse('2026-09-05T13:40:00Z'), exitAt: Date.parse('2026-09-05T13:42:00Z'), side: 'buy', symbol: 'MNQ', pnl: 30 };
  const tagged = tagTrades([t1, t2], { sessionWindowsIST: WIN });
  assert.equal(tagged[0].tradeIndexOfDay, 1);
  assert.equal(tagged[0].afterLoss, false);
  assert.equal(tagged[1].tradeIndexOfDay, 2);
  assert.equal(tagged[1].afterLoss, true);
});
test('M3: day boundary uses the 03:45 IST rollover, not calendar midnight', () => {
  // 23:00 IST on Sep 4 and 02:00 IST on Sep 5 are DIFFERENT calendar days but
  // the SAME trading day (02:00 is pre-rollover). tradeIndexOfDay must not reset.
  const t1 = { entryAt: Date.parse('2026-09-04T17:30:00Z'), exitAt: Date.parse('2026-09-04T17:32:00Z'), side: 'buy', symbol: 'MNQ', pnl: 10 };
  const t2 = { entryAt: Date.parse('2026-09-04T20:30:00Z'), exitAt: Date.parse('2026-09-04T20:32:00Z'), side: 'buy', symbol: 'MNQ', pnl: 20 };
  const tagged = tagTrades([t1, t2], { sessionWindowsIST: WIN });
  assert.equal(tagged[0].tradeIndexOfDay, 1);
  assert.equal(tagged[1].tradeIndexOfDay, 2);
  assert.equal(tagged[0].dayOfWeek, tagged[1].dayOfWeek);
});

test('isReentry fires when same symbol+direction within the window', () => {
  const t1 = { entryAt: Date.parse('2026-09-05T13:30:00Z'), exitAt: Date.parse('2026-09-05T13:32:00Z'), side: 'buy', symbol: 'MNQ', pnl: 10 };
  const t2 = { entryAt: Date.parse('2026-09-05T13:33:00Z'), exitAt: Date.parse('2026-09-05T13:34:00Z'), side: 'buy', symbol: 'MNQ', pnl: 20 };
  const tagged = tagTrades([t1, t2], { sessionWindowsIST: WIN, isReentryWindowMin: 5 });
  assert.equal(tagged[1].isReentry, true);
});