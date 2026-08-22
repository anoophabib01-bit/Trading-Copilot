'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSignalRow, serializeSignal, sessionTierForMinutes } = require('../signal-ledger.js');

test('sessionTierForMinutes maps minutes to the active session window', () => {
  const wins = [{ name: 'London', startMin: 810 }, { name: 'NY', startMin: 1140 }];
  assert.equal(sessionTierForMinutes(600, wins), 'outside-session');
  assert.equal(sessionTierForMinutes(830, wins), 'London');
  assert.equal(sessionTierForMinutes(1150, wins), 'NY');
  assert.equal(sessionTierForMinutes(1300, wins), 'NY'); // after NY end but after its start → still NY until midnight
  assert.equal(sessionTierForMinutes(100, wins), 'outside-session'); // before London
});

test('sessionTierForMinutes tolerates empty/garbage windows', () => {
  assert.equal(sessionTierForMinutes(500, null), 'outside-session');
  assert.equal(sessionTierForMinutes(500, []), 'outside-session');
  assert.equal(sessionTierForMinutes(500, [{ startMin: 300 }]), 'session');
});

test('buildSignalRow fills defaults and never invents fields', () => {
  const row = buildSignalRow({ event: 'engulf-fire', playbook: 'A', tf: '60', direction: 'BULLISH' }, {
    sessionTier: 'London', dailyTrend: null, hourTrend: 'STRONG BEAR', newsBlackout: false,
    symbol: 'MNQ1!', accountSlot: 's2', mode: 'eval'
  });
  assert.equal(row.event, 'engulf-fire');
  assert.equal(row.playbook, 'A');
  assert.equal(row.valid, true);
  assert.equal(row.level, null);
  assert.equal(row.rejectReason, null);
  assert.equal(row.sessionTier, 'London');
  assert.equal(row.dailyTrend, null);
  assert.equal(row.hourTrend, 'STRONG BEAR');
  assert.equal(row.newsBlackout, false);
  assert.equal(row.symbol, 'MNQ1!');
  assert.equal(row.mode, 'eval');
  assert.ok(typeof row.ts === 'string' && row.ts.length > 0);
});

test('buildSignalRow marks rejections with valid:false and keeps the reason', () => {
  const row = buildSignalRow({ event: 'playbook-c-reject', playbook: 'C', tf: '15', direction: 'BEARISH', valid: false, rejectReason: 'no sweep before reversal', structure: 'LL-LH' }, {});
  assert.equal(row.valid, false);
  assert.equal(row.rejectReason, 'no sweep before reversal');
  assert.equal(row.structure, 'LL-LH');
  assert.equal(row.newsBlackout, false); // !!undefined → false
});

test('decision fields pass through (2.2/2.3 consumers)', () => {
  const row = buildSignalRow({ event: 'signal-decision', decision: 'took', decidedAt: '2026-08-22T10:00:00.000Z', signalTs: 1756000000000, playbook: 'B' }, {});
  assert.equal(row.decision, 'took');
  assert.equal(row.signalTs, 1756000000000);
  assert.equal(row.valid, true);
});

test('serializeSignal emits exactly one JSON line', () => {
  const row = buildSignalRow({ event: 'fvg-fire', playbook: 'B', tf: '30', direction: 'BULLISH', gapLow: 21847.25 }, {});
  const line = serializeSignal(row);
  assert.equal(line.endsWith('\n'), true);
  assert.equal((line.match(/\n/g) || []).length, 1);
  const parsed = JSON.parse(line);
  assert.equal(parsed.playbook, 'B');
  assert.equal(parsed.gapLow, 21847.25);
});
