'use strict';
// ── The bar record's startup self-repair (2026-09-02) ──────────────────────
// Written after a real hole: the server stopped at 20:15 IST on 2026-09-01 and
// came back at 11:31 IST the next day, so the once-daily 21:30 IST recorder run
// never happened and that day was never recorded at all.
//
// The load-bearing property here is NOT "does it repair" — it is "does it tell
// the truth about what it CANNOT repair". TradingView will not serve this
// history retrospectively, so a gap wider than one pull's reach is permanently
// lost, and a protocol that quietly fetched the reachable part while logging
// success would leave the hole AND hide it.
const test = require('node:test');
const assert = require('node:assert');
const rec = require('../bar-recovery.js');

const MIN = 60 * 1000;
const NOW = Date.parse('2026-09-02T06:00:00Z');
const file = (tf, spacing, agoMinutes, count = 300) => ({
  tf, spacing, count,
  lastBarMs: agoMinutes == null ? null : NOW - agoMinutes * MIN,
});

test('a record only one bar behind is CURRENT — that is the forming candle', () => {
  const r = rec.assessFile(file('5', 5, 5), NOW);
  assert.equal(r.status, rec.STATUS.CURRENT);
  assert.equal(rec.assess([file('5', 5, 5)], NOW).needsRepair, false);
});

test('a gap inside the pull reach is RECOVERABLE', () => {
  // 5m x 300 = 1500 min reach (25h). A 3h gap sits well inside it.
  const r = rec.assessFile(file('5', 5, 180), NOW);
  assert.equal(r.status, rec.STATUS.RECOVERABLE);
  assert.equal(r.unreachableMinutes, 0, 'nothing is lost when the gap fits');
  assert.equal(r.reachMinutes, 1500);
});

test('a gap WIDER than the reach reports the permanent loss, not just the fix', () => {
  // 1m x 300 = 300 min reach (5h). The real incident was ~15h.
  const r = rec.assessFile(file('1', 1, 15 * 60), NOW);
  assert.equal(r.status, rec.STATUS.PARTIAL);
  assert.equal(r.reachMinutes, 300);
  assert.equal(r.unreachableMinutes, 15 * 60 - 300, '10 hours are beyond reach');

  const a = rec.assess([file('1', 1, 15 * 60)], NOW);
  assert.equal(a.anyPermanentLoss, true);
  assert.match(a.summary, /GONE PERMANENTLY/);
  // and it must STILL pull — refusing because part is lost throws away the rest
  assert.equal(a.needsRepair, true);
});

test('the real 2026-09-01 incident: 5m survives the gap, 1m does not', () => {
  // Server down 20:15 IST -> 11:31 IST is ~15.25h.
  const gap = Math.round(15.25 * 60);
  const a = rec.assess([file('5', 5, gap), file('1', 1, gap)], NOW);
  const five = a.files.find(f => f.tf === '5');
  const one = a.files.find(f => f.tf === '1');
  assert.equal(five.status, rec.STATUS.RECOVERABLE, '25h reach covers a 15h gap');
  assert.equal(one.status, rec.STATUS.PARTIAL, '5h reach does not');
  assert.equal(a.needsRepair, true);
  assert.equal(a.anyPermanentLoss, true);
});

test('a file that never existed is NEVER_RECORDED, not a zero-length gap', () => {
  const r = rec.assessFile(file('1', 1, null, 0), NOW);
  assert.equal(r.status, rec.STATUS.NEVER);
  assert.equal(r.gapMinutes, null, 'there is no gap to measure from nothing');
  assert.equal(rec.assess([file('1', 1, null, 0)], NOW).needsRepair, true);
  assert.match(rec.summarize([r]), /NEVER RECORDED/);
});

test('garbage timestamps are treated as never-recorded, never as current', () => {
  for (const bad of [NaN, Infinity, undefined, 0]) {
    const r = rec.assessFile({ tf: '5', spacing: 5, count: 1, lastBarMs: bad }, NOW);
    assert.equal(r.status, rec.STATUS.NEVER, `${bad} must not read as a healthy record`);
  }
});

test('PULL_COUNT is the single source of the reach', () => {
  // If the server ever pulls a different count, the reach must move with it —
  // an assumed-larger reach would UNDER-report the permanent loss.
  const big = rec.assessFile(file('5', 5, 400), NOW);        // default 300 bars = 1500 min
  assert.equal(big.status, rec.STATUS.RECOVERABLE, '400 min fits a 1500 min reach');

  const small = rec.assessFile(file('5', 5, 400), NOW, 60);  // 60 bars = 300 min
  assert.equal(small.reachMinutes, 300, 'reach follows the count actually pulled');
  assert.equal(small.status, rec.STATUS.PARTIAL,
    'the SAME gap becomes a permanent loss when the pull reaches less far');
  assert.equal(small.unreachableMinutes, 100);
});

// ── describeOutcome: "attempted" is not "fixed" ────────────────────────────
test('a pull that added nothing is reported as NOT filled, not as success', () => {
  const before = rec.assess([file('5', 5, 180)], NOW).files;
  const out = rec.describeOutcome(before, [{ tf: '5', added: 0, replaced: 0 }]);
  assert.equal(out.ok, false);
  assert.equal(out.repaired, 0);
  assert.match(out.text, /0 new bars — the gap was NOT filled/);
});

test('a pull that recovered bars says how many', () => {
  const before = rec.assess([file('5', 5, 180)], NOW).files;
  const out = rec.describeOutcome(before, [{ tf: '5', added: 36, replaced: 1 }]);
  assert.equal(out.ok, true);
  assert.equal(out.repaired, 1);
  assert.match(out.text, /\+36 bars recovered/);
});

test('rejected and errored pulls are distinguished, not merged into "failed"', () => {
  const before = rec.assess([file('5', 5, 180), file('1', 1, 180)], NOW).files;
  const out = rec.describeOutcome(before, [
    { tf: '5', rejected: true, reason: 'spacing mismatch' },
    { tf: '1', error: 'MCP timeout' },
  ]);
  assert.equal(out.ok, false);
  assert.equal(out.failed, 2);
  assert.match(out.text, /REJECTED — spacing mismatch/);
  assert.match(out.text, /FAILED — MCP timeout/);
});

test('a timeframe that was never attempted is not silently counted as fine', () => {
  const before = rec.assess([file('5', 5, 180), file('1', 1, 180)], NOW).files;
  const out = rec.describeOutcome(before, [{ tf: '5', added: 10 }]);
  assert.match(out.text, /1m: NOT ATTEMPTED/);
  assert.equal(out.ok, false, 'a partial attempt is not an ok outcome');
});

test('files that were already current are left out of the outcome entirely', () => {
  const before = rec.assess([file('5', 5, 5)], NOW).files;
  const out = rec.describeOutcome(before, []);
  assert.equal(out.text, 'nothing needed repair');
  assert.equal(out.failed, 0);
});
