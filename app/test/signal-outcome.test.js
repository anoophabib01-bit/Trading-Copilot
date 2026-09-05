'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSignalOutcome, aggregateOutcomes, isArmingEvent } = require('../signal-outcome');

const T0 = Date.parse('2026-08-20T10:00:00Z') / 1000;
function bar(i, high, low, close) { return { time: T0 + (i + 1) * 60, high, low, close }; }
function sig(extra) {
  return Object.assign({
    ts: '2026-08-20T10:00:00Z', event: 'engulf-fire', playbook: 'A',
    tf: '15', direction: 'BULLISH', level: 100,
  }, extra || {});
}

test('BULLISH: MFE is the best high above the level, MAE the worst low below', () => {
  const bars = [bar(0, 103, 99, 102), bar(1, 107, 101, 106), bar(2, 105, 97, 104)];
  const r = resolveSignalOutcome(sig(), bars, { horizonBars: 3 });
  assert.equal(r.resolved, true);
  assert.equal(r.mfe, 7);   // 107 - 100
  assert.equal(r.mae, 3);   // 100 - 97
  assert.equal(r.atHorizon, 4); // 104 - 100
  assert.equal(r.favourable, true);
});

test('BEARISH: the signs invert — down is favourable', () => {
  const bars = [bar(0, 101, 95, 96), bar(1, 102, 92, 93), bar(2, 99, 94, 95)];
  const r = resolveSignalOutcome(sig({ direction: 'BEARISH' }), bars, { horizonBars: 3 });
  assert.equal(r.mfe, 8);   // 100 - 92
  assert.equal(r.mae, 2);   // 102 - 100
  assert.equal(r.atHorizon, 5); // (95 - 100) * -1
  assert.equal(r.favourable, true);
});

test('a signal that went straight against you scores as unfavourable', () => {
  const bars = [bar(0, 100.5, 96, 97), bar(1, 98, 93, 94), bar(2, 96, 90, 91)];
  const r = resolveSignalOutcome(sig(), bars, { horizonBars: 3 });
  assert.equal(r.mfe, 0.5);
  assert.equal(r.mae, 10);
  assert.equal(r.atHorizon, -9);
  assert.equal(r.favourable, false);
});

test('SAME-BAR AMBIGUITY resolves to the STOP, never the target', () => {
  // One bar spans both levels; bar data cannot say which was touched first.
  // Assuming the target is how backtests invent edges that die live.
  const bars = [bar(0, 120, 90, 110), bar(1, 121, 119, 120), bar(2, 122, 120, 121)];
  const r = resolveSignalOutcome(sig(), bars, { horizonBars: 3, targetPoints: 10, stopPoints: 5 });
  assert.equal(r.hit, 'stop');
  assert.equal(r.hitBarIndex, 0);
});

test('a clean target hit before any stop touch is recorded as a target', () => {
  const bars = [bar(0, 104, 99, 103), bar(1, 112, 103, 111), bar(2, 113, 110, 112)];
  const r = resolveSignalOutcome(sig(), bars, { horizonBars: 3, targetPoints: 10, stopPoints: 5 });
  assert.equal(r.hit, 'target');
  assert.equal(r.hitBarIndex, 1);
});

test('the FIRST hit wins — a later stop does not overwrite an earlier target', () => {
  const bars = [bar(0, 111, 99, 110), bar(1, 111, 90, 92), bar(2, 95, 90, 91)];
  const r = resolveSignalOutcome(sig(), bars, { horizonBars: 3, targetPoints: 10, stopPoints: 5 });
  assert.equal(r.hit, 'target');
  assert.equal(r.hitBarIndex, 0);
});

test('bars at or before the signal are excluded — no peeking at pre-signal action', () => {
  // A huge favourable bar BEFORE the signal must not inflate MFE.
  const pre = { time: T0 - 60, high: 500, low: 100, close: 400 };
  const at = { time: T0, high: 400, low: 100, close: 300 };
  const bars = [pre, at, bar(0, 102, 99, 101), bar(1, 103, 100, 102)];
  const r = resolveSignalOutcome(sig(), bars, { horizonBars: 2 });
  assert.equal(r.mfe, 3, 'only post-signal bars may contribute');
});

test('unsorted bars are handled — order is by time, not array position', () => {
  const bars = [bar(2, 105, 97, 104), bar(0, 103, 99, 102), bar(1, 107, 101, 106)];
  const r = resolveSignalOutcome(sig(), bars, { horizonBars: 3 });
  assert.equal(r.atHorizon, 4, 'the last bar by TIME must supply the closing price');
});

test('a partial window refuses to resolve rather than reporting a biased number', () => {
  // Scoring 3 of 12 bars is a different measurement, not a small sample of the
  // same one — mixing them biases aggregates toward the least-resolved signals.
  const bars = [bar(0, 103, 99, 102), bar(1, 104, 100, 103)];
  const r = resolveSignalOutcome(sig(), bars, { horizonBars: 12 });
  assert.equal(r.resolved, false);
  assert.equal(r.pending, true);
  assert.match(r.reason, /2\/12 bars/);
});

test('non-arming events are never scored', () => {
  for (const ev of ['playbook-c-reject', 'raid', 'phase-change', 'signal']) {
    const r = resolveSignalOutcome(sig({ event: ev }), [bar(0, 103, 99, 102)], { horizonBars: 1 });
    assert.equal(r.resolved, false);
    assert.match(r.reason, /not an arming event/);
  }
  assert.equal(isArmingEvent('engulf-fire'), true);
  assert.equal(isArmingEvent('playbook-c-reject'), false);
});

test('a malformed signal is refused, not guessed at', () => {
  const bars = [bar(0, 103, 99, 102)];
  assert.equal(resolveSignalOutcome(sig({ direction: null }), bars, { horizonBars: 1 }).resolved, false);
  assert.equal(resolveSignalOutcome(sig({ level: null }), bars, { horizonBars: 1 }).resolved, false);
  assert.equal(resolveSignalOutcome(sig({ ts: null }), bars, { horizonBars: 1 }).resolved, false);
});

test('no bars yet is pending, not a zero-outcome', () => {
  const r = resolveSignalOutcome(sig(), [], { horizonBars: 3 });
  assert.equal(r.resolved, false);
  assert.match(r.reason, /no bars after the signal/);
});

test('edgeRatio is null rather than Infinity when nothing went against the signal', () => {
  // An Infinity here would poison any average computed over a batch.
  const bars = [bar(0, 105, 100, 104), bar(1, 106, 101, 105)];
  const r = resolveSignalOutcome(sig(), bars, { horizonBars: 2 });
  assert.equal(r.mae, 0);
  assert.equal(r.edgeRatio, null);
});

test('bars with non-numeric prices are skipped without poisoning the result', () => {
  const bars = [bar(0, 103, 99, 102), { time: T0 + 120, high: null, low: 'x', close: 1 }, bar(2, 106, 100, 105)];
  const r = resolveSignalOutcome(sig(), bars, { horizonBars: 3 });
  assert.equal(r.resolved, true);
  assert.equal(Number.isFinite(r.mfe), true);
  assert.equal(r.mfe, 6);
});

// ── aggregation ─────────────────────────────────────────────────────────────

test('aggregateOutcomes buckets by playbook+timeframe and computes rates', () => {
  const rows = [
    { resolved: true, playbook: 'A', tf: '15', favourable: true, mfe: 10, mae: 2, atHorizon: 5, hit: 'target' },
    { resolved: true, playbook: 'A', tf: '15', favourable: false, mfe: 2, mae: 8, atHorizon: -4, hit: 'stop' },
    { resolved: true, playbook: 'B', tf: '5', favourable: true, mfe: 6, mae: 3, atHorizon: 3, hit: null },
  ];
  const agg = aggregateOutcomes(rows);
  const a = agg.find((x) => x.playbook === 'A');
  assert.equal(a.n, 2);
  assert.equal(a.winRate, 0.5);
  assert.equal(a.avgMfe, 6);
  assert.equal(a.avgAtHorizon, 0.5);
  assert.equal(a.targetRate, 0.5);
});

test('unresolved rows are excluded from aggregates, never counted as neutral', () => {
  const rows = [
    { resolved: true, playbook: 'A', tf: '15', favourable: true, mfe: 10, mae: 2, atHorizon: 5 },
    { resolved: false, playbook: 'A', tf: '15', pending: true },
    null,
  ];
  const agg = aggregateOutcomes(rows);
  assert.equal(agg.length, 1);
  assert.equal(agg[0].n, 1, 'a pending signal must not dilute the sample');
  assert.equal(agg[0].winRate, 1);
});

test('targetRate is null when no stops or targets were configured', () => {
  const rows = [{ resolved: true, playbook: 'C', tf: '60', favourable: true, mfe: 4, mae: 1, atHorizon: 2, hit: null }];
  const agg = aggregateOutcomes(rows);
  assert.equal(agg[0].targetRate, null);
});

test('aggregate ordering puts the largest sample first', () => {
  const rows = [
    { resolved: true, playbook: 'B', tf: '5', favourable: true, mfe: 1, mae: 1, atHorizon: 1 },
    { resolved: true, playbook: 'A', tf: '15', favourable: true, mfe: 1, mae: 1, atHorizon: 1 },
    { resolved: true, playbook: 'A', tf: '15', favourable: true, mfe: 1, mae: 1, atHorizon: 1 },
  ];
  assert.equal(aggregateOutcomes(rows)[0].playbook, 'A');
});

// ── AN ALERT IS NOT AN ARMED SETUP (2026-09-03) ─────────────────────────────
// The Playbook A alert/setup split is carried by the EVENT NAME because three
// separate modules key on it and none of them checks `valid`. If engulf-alert
// ever leaks into ARMING_EVENTS, every bare against-bias candle gets scored as
// a Playbook A signal and the forward test silently starts measuring a rule
// nobody trades — pooled with, and outnumbering ~4:1, the setups he does take.
test('engulf-alert is NOT an arming event — alerts must not be scored as setups', () => {
  assert.equal(isArmingEvent('engulf-alert'), false);
  assert.equal(isArmingEvent('engulf-fire'), true);
});
