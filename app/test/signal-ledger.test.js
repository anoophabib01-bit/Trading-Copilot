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

// ── THE FIELDS THAT WERE BEING DROPPED (2026-09-03) ─────────────────────────
// buildSignalRow is a whitelist. Between 2026-09-01 and 2026-09-03 every gated
// call site PASSED htfBias / structure4h / htfConfirmation and this builder
// silently discarded all three — including at the engulf fire site, whose own
// comment says storing htfConfirmation is what makes "how do 15M-only fires
// perform against confirmed ones" answerable. The field it named never reached
// disk, so nine days of rows record a verdict with none of the evidence.
//
// A whitelist that drops unknown keys without complaint cannot fail loudly, so
// the only protection is a test that asserts each field actually survives.
// These are pinned individually rather than with a loop over Object.keys so
// that adding a field to the builder is not mistaken for adding it to the
// contract.
test('the higher-timeframe evidence survives into the row', () => {
  const r = buildSignalRow({
    event: 'engulf-fire', playbook: 'A', tf: '15', direction: 'BULLISH',
    structure: 'HH-HL (15M)', structure15m: 'bullish', structure1h: 'bearish',
    htfBias: 'bullish', htfConfirmation: 'disagrees',
  }, {});
  assert.strictEqual(r.structure15m, 'bullish');
  assert.strictEqual(r.structure1h, 'bearish');
  assert.strictEqual(r.htfBias, 'bullish');
  assert.strictEqual(r.htfConfirmation, 'disagrees');
  assert.strictEqual(r.structure, 'HH-HL (15M)', 'the deciding read keeps its own field');
});

test('the Playbook A context verdict survives, so a candle is separable from a setup', () => {
  // Since 2026-09-03 Playbook A alerts on both directions, so `valid` alone no
  // longer partitions the rows — a bare candle and a full setup would both
  // read true if `quality` were dropped, and the forward test would be pooling
  // two different populations under one name.
  const setup = buildSignalRow({ event: 'engulf-fire', valid: true, quality: 'valid HH-HL (15M) swing-low engulfing, liquidity intact' }, {});
  const candle = buildSignalRow({ event: 'engulf-fire', valid: false, quality: 'not at a swing low — mid-range entry' }, {});
  assert.match(setup.quality, /liquidity intact/);
  assert.match(candle.quality, /mid-range entry/);
  assert.strictEqual(setup.valid, true);
  assert.strictEqual(candle.valid, false);
});

test('a row with no higher-timeframe read stores nulls, never undefined', () => {
  // Rows are JSON.stringify'd one per line; an undefined field vanishes from
  // the object entirely, so a reader cannot tell "not read" from "key never
  // existed in this version of the app".
  const r = buildSignalRow({ event: 'sfp-raid' }, {});
  for (const k of ['structure15m', 'structure1h', 'htfBias', 'htfConfirmation', 'quality']) {
    assert.strictEqual(r[k], null, k + ' must be present and null');
    assert.ok(Object.prototype.hasOwnProperty.call(JSON.parse(serializeSignal(r)), k),
      k + ' must survive serialization');
  }
});
