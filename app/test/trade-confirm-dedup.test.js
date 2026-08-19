'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDedupState, checkAndMark, consumeVerdict } = require('../trade-confirm-dedup.js');

test('a fresh requestId is accepted and marked seen', () => {
  const s = createDedupState();
  const r = checkAndMark(s, 'tc-1', null, 1000, 1800000);
  assert.equal(r.ok, true);
  assert.equal(s.seen.has('tc-1'), true);
});

test('the exact same requestId sent twice is rejected the second time', () => {
  const s = createDedupState();
  const r1 = checkAndMark(s, 'tc-1', null, 1000, 1800000);
  const r2 = checkAndMark(s, 'tc-1', null, 1500, 1800000);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /duplicate/);
});

test('THE RACE: two "simultaneous" calls for the same requestId — only the first wins', () => {
  // Simulates a double-click / replayed WS message: both calls happen with
  // no await between check and mark (this is the actual safety property —
  // synchronous check-then-mark, no interleaving window).
  const s = createDedupState();
  const results = ['tc-double', 'tc-double'].map((id) => checkAndMark(s, id, null, 1000, 1800000));
  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, 1, 'exactly one of the two identical requests must be accepted');
});

test('a requestId is forgotten once the dedup window has passed', () => {
  const s = createDedupState();
  checkAndMark(s, 'tc-1', null, 1000, 1000); // window = 1000ms
  const r = checkAndMark(s, 'tc-1', null, 1000 + 1001, 1000); // now well past cutoff
  assert.equal(r.ok, true, 'an old requestId outside the window is treated as new');
});

test('a requestId just inside the window is still rejected', () => {
  const s = createDedupState();
  checkAndMark(s, 'tc-1', null, 1000, 1000);
  const r = checkAndMark(s, 'tc-1', null, 1000 + 999, 1000);
  assert.equal(r.ok, false);
});

test('missing/garbage requestId is rejected without throwing', () => {
  const s = createDedupState();
  assert.equal(checkAndMark(s, null, null, 1000, 1800000).ok, false);
  assert.equal(checkAndMark(s, undefined, null, 1000, 1800000).ok, false);
  assert.equal(checkAndMark(s, '', null, 1000, 1800000).ok, false);
  assert.equal(checkAndMark(s, 42, null, 1000, 1800000).ok, false);
});

test('a fresh sourceVerdictId is not blocked by consumedVerdicts', () => {
  const s = createDedupState();
  const r = checkAndMark(s, 'tc-1', 'verdict-A', 1000, 1800000);
  assert.equal(r.ok, true);
});

test('reusing an already-consumed sourceVerdictId is rejected, even with a brand-new requestId', () => {
  const s = createDedupState();
  checkAndMark(s, 'tc-1', 'verdict-A', 1000, 1800000);
  consumeVerdict(s, 'verdict-A'); // simulates the order actually going through
  const r = checkAndMark(s, 'tc-2', 'verdict-A', 2000, 1800000); // different requestId, same verdict
  assert.equal(r.ok, false);
  assert.match(r.reason, /already been confirmed/);
});

test('a rejected rules-check (verdict never consumed) does not block a later legitimate retry with a new requestId', () => {
  const s = createDedupState();
  checkAndMark(s, 'tc-1', 'verdict-A', 1000, 1800000);
  // verdict-A is NOT consumed here — simulates the rules check itself
  // rejecting the trade (size cap etc.), which happens AFTER checkAndMark
  // in server.js and never calls consumeVerdict.
  const r = checkAndMark(s, 'tc-2', 'verdict-A', 2000, 1800000);
  assert.equal(r.ok, true, 'an unconsumed verdict must still allow a later attempt');
});

test('null sourceVerdictId never collides with anything', () => {
  const s = createDedupState();
  checkAndMark(s, 'tc-1', null, 1000, 1800000);
  const r = checkAndMark(s, 'tc-2', null, 2000, 1800000);
  assert.equal(r.ok, true);
});

test('cleanup does not throw on an empty state', () => {
  const s = createDedupState();
  assert.doesNotThrow(() => checkAndMark(s, 'tc-1', null, 1000, 1800000));
});
