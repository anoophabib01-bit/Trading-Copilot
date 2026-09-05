'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../exit-bias-align');
const BT = require('../bias-tracker');

const drift = (verdict) => ({ verdict });
const rec = (bias, h4, h1) => BT.directionOfRecord({ bias, h4, h1 });

test('declared LONG + price drifted up = ALIGNED', () => {
  const a = A.alignExitDrift(drift('ABOVE'), rec('Bullish', 'Bullish', 'Bullish'), { sameDay: true });
  assert.strictEqual(a.status, A.ALIGN.ALIGNED);
  assert.strictEqual(a.biasDir, 'LONG');
  assert.strictEqual(a.driftDir, 'LONG');
});

test('declared SHORT + price drifted down = ALIGNED', () => {
  const a = A.alignExitDrift(drift('BELOW'), rec('Bearish', 'Bearish', 'Bearish'), { sameDay: true });
  assert.strictEqual(a.status, A.ALIGN.ALIGNED);
  assert.strictEqual(a.biasDir, 'SHORT');
});

test('declared LONG + price drifted down = DIVERGED', () => {
  const a = A.alignExitDrift(drift('BELOW'), rec('Bullish', 'Bullish', 'Bullish'), { sameDay: true });
  assert.strictEqual(a.status, A.ALIGN.DIVERGED);
  assert.match(a.note, /against that bias/);
});

// The guard that keeps this from becoming a confirmation-bias machine.
test('ALIGNED is worded as an observation, never as confirmation or a signal', () => {
  const a = A.alignExitDrift(drift('ABOVE'), rec('Bullish', 'Bullish', 'Bullish'), { sameDay: true });
  assert.match(a.note, /not confirmation/);
  assert.doesNotMatch(a.note, /confirms/i);
  assert.doesNotMatch(a.note, /\b(buy|sell|enter|take the trade|go long|go short)\b/i);
});

test('no checklist bias is NO_BIAS — it does not default to a direction', () => {
  const a = A.alignExitDrift(drift('ABOVE'), rec('', '', ''), { sameDay: true });
  assert.strictEqual(a.status, A.ALIGN.NO_BIAS);
  assert.strictEqual(a.biasDir, null);
});

test('a Conflicted daily bias yields no direction, so no comparison', () => {
  const a = A.alignExitDrift(drift('BELOW'), rec('Conflicted', 'Bullish', 'Bullish'), { sameDay: true });
  assert.strictEqual(a.status, A.ALIGN.NO_BIAS);
});

// The cooldown must not be routed around: no drift direction, no comparison.
test('COOLING / NO_READ / UNKNOWN drift never produces an alignment', () => {
  for (const v of ['COOLING', 'NO_READ', 'UNKNOWN']) {
    const a = A.alignExitDrift(drift(v), rec('Bullish', 'Bullish', 'Bullish'), { sameDay: true });
    assert.strictEqual(a.status, A.ALIGN.NO_DRIFT, v + ' must not yield an alignment');
    assert.strictEqual(A.formatAlign(a), null, v + ' must render nothing');
  }
});

test('a bias from a different day is flagged rather than silently compared', () => {
  const a = A.alignExitDrift(drift('ABOVE'), rec('Bullish', 'Bullish', 'Bullish'), { sameDay: false });
  assert.strictEqual(a.status, A.ALIGN.ALIGNED);
  assert.match(a.note, /declared on a different day/);
});

test('unknown sameDay adds no staleness claim in either direction', () => {
  const a = A.alignExitDrift(drift('ABOVE'), rec('Bullish', 'Bullish', 'Bullish'), {});
  assert.strictEqual(a.sameDay, null);
  assert.doesNotMatch(a.note, /different day/);
});

test('partial confidence is surfaced, not hidden', () => {
  const a = A.alignExitDrift(drift('ABOVE'), rec('Bullish', '', ''), { sameDay: true });
  assert.strictEqual(a.confidence, 'partial');
  assert.match(a.note, /partial confidence/);
});

test('an HTF pointing the other way shows as contradicted confidence', () => {
  const a = A.alignExitDrift(drift('ABOVE'), rec('Bullish', 'Bearish', 'Bullish'), { sameDay: true });
  assert.strictEqual(a.confidence, 'contradicted');
  assert.match(a.note, /contradicted confidence/);
});

test('missing drift or missing record never throws', () => {
  assert.strictEqual(A.alignExitDrift(null, null, {}).status, A.ALIGN.NO_DRIFT);
  assert.strictEqual(A.alignExitDrift(undefined, undefined).status, A.ALIGN.NO_DRIFT);
  assert.strictEqual(A.formatAlign(null), null);
});

test('DIVERGED renders with the plainest label', () => {
  const a = A.alignExitDrift(drift('BELOW'), rec('Bullish', 'Bullish', 'Bullish'), { sameDay: true });
  assert.match(A.formatAlign(a), /^BIAS DIVERGED — /);
});
