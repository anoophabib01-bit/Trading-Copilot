'use strict';
// ── priority-lock tests ─────────────────────────────────────────────────────
// The scenario these exist for, from 2026-09-02: the broker lock reached a
// queue depth of 7, the 5s position watch that feeds the oversize guard sat
// behind six diagnostics, and he reached 16 contracts against a cap of 2 while
// the app recorded a peak of 4.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeLock } = require('../priority-lock.js');

const tick = () => new Promise((r) => setTimeout(r, 5));
// A job that records its own start order and finishes on demand.
function job(log, tag, ms) {
  return () => new Promise((r) => setTimeout(() => { log.push(tag); r(tag); }, ms == null ? 1 : ms));
}

test('operations run one at a time, in order, by default', async () => {
  const lock = makeLock('t');
  const log = [];
  await Promise.all([lock(job(log, 'a')), lock(job(log, 'b')), lock(job(log, 'c'))]);
  assert.deepEqual(log, ['a', 'b', 'c']);
});

test('a high-priority caller jumps every queued normal caller', async () => {
  const lock = makeLock('t');
  const log = [];
  // 'a' starts immediately and holds the lock; b/c/d queue behind it.
  const running = lock(job(log, 'a', 20));
  const queued = [lock(job(log, 'b')), lock(job(log, 'c')), lock(job(log, 'd'))];
  // The position watch arrives last but must be served first.
  const urgent = lock(job(log, 'POSITION'), { priority: 'high' });
  await Promise.all([running, urgent, ...queued]);
  assert.equal(log[0], 'a', 'the running operation is never cut in half');
  assert.equal(log[1], 'POSITION', 'the urgent read goes next, ahead of three queued calls');
});

test('the running operation is NEVER preempted', async () => {
  // Cutting an order placement or a mid-flight table read in half would
  // reintroduce exactly the interleaving the broker lock exists to prevent.
  const lock = makeLock('t');
  const log = [];
  const slow = lock(() => new Promise((r) => setTimeout(() => { log.push('slow-end'); r(); }, 30)));
  await tick();
  const urgent = lock(job(log, 'urgent'), { priority: 'high' });
  await Promise.all([slow, urgent]);
  assert.deepEqual(log, ['slow-end', 'urgent']);
});

test('two high-priority callers keep their order relative to each other', async () => {
  const lock = makeLock('t');
  const log = [];
  const running = lock(job(log, 'a', 20));
  lock(job(log, 'normal'));
  const h1 = lock(job(log, 'h1'), { priority: 'high' });
  const h2 = lock(job(log, 'h2'), { priority: 'high' });
  await Promise.all([running, h1, h2]);
  assert.deepEqual(log.slice(0, 3), ['a', 'h1', 'h2']);
});

// ── Anti-starvation ────────────────────────────────────────────────────────
// The position watch fires every 5s forever. Unbounded priority would let it
// jump the queue indefinitely and starve the ACCOUNT POLL — which is what
// records trades and P&L. A starved account poll trades a stale guard for a
// missing trade record, which is not a trade worth making.
test('a normal waiter can only be overtaken maxJumps times, then it is immune', async () => {
  const lock = makeLock('t', { maxJumps: 2 });
  const log = [];
  const running = lock(job(log, 'holding', 40));
  const normal = lock(job(log, 'ACCOUNT-POLL'));
  await tick();
  const h = [];
  for (let i = 0; i < 4; i++) h.push(lock(job(log, 'hi' + i), { priority: 'high' }));
  await Promise.all([running, normal, ...h]);
  const idx = log.indexOf('ACCOUNT-POLL');
  // Overtaken exactly twice, then served — never pushed back forever.
  assert.equal(log.slice(0, idx).filter(t => t.startsWith('hi')).length, 2);
  assert.ok(idx < log.length - 1, 'the account poll still runs, ahead of later high-priority calls');
});

// ── Everything the old FIFO lock guaranteed, preserved ─────────────────────
test('a timeout releases the lock instead of freezing the feed', async () => {
  const lock = makeLock('t', { timeoutMs: 20 });
  const log = [];
  const stuck = lock(() => new Promise(() => {}));   // never settles
  await assert.rejects(stuck, /exceeded 20ms/);
  // The next caller still gets served — this is the whole point.
  await lock(job(log, 'after'));
  assert.deepEqual(log, ['after']);
});

test('the timeout error names the CALL SITE, not the timeout site', async () => {
  // Every timeout error is otherwise identical, which is what made the
  // 2026-08-19 crash undiagnosable from the log alone.
  const lock = makeLock('t', { timeoutMs: 20 });
  await lock(() => new Promise(() => {})).catch((e) => {
    assert.match(e.stack, /withLock\(\) was CALLED from/);
    assert.match(e.stack, /priority-lock\.test\.js/);
  });
});

test('a late result from a timed-out operation is discarded, not delivered', async () => {
  const lock = makeLock('t', { timeoutMs: 20 });
  let lateResolve;
  const stuck = lock(() => new Promise((r) => { lateResolve = r; }));
  await assert.rejects(stuck, /exceeded/);
  lateResolve('too late');
  await tick();
  // Nothing throws, nothing is delivered — a later caller must never wait on
  // a call this lock already gave up on.
  assert.ok(true);
});

test('a fire-and-forget caller cannot turn a timeout into an unhandled rejection', async () => {
  // This crashed the process live on 2026-08-19. The process runs the monitors,
  // Jessi and the broker bridge during a live session — it must not die here.
  const lock = makeLock('t', { timeoutMs: 20 });
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on('unhandledRejection', onUnhandled);
  lock(() => new Promise(() => {}));    // deliberately not awaited or caught
  await new Promise((r) => setTimeout(r, 60));
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, null);
});

test('a throwing function rejects its caller and still frees the lock', async () => {
  const lock = makeLock('t');
  const log = [];
  await assert.rejects(lock(() => { throw new Error('boom'); }), /boom/);
  await lock(job(log, 'next'));
  assert.deepEqual(log, ['next']);
});

test('queue depth and jump count are observable', async () => {
  const lock = makeLock('t');
  const log = [];
  const running = lock(job(log, 'a', 20));
  lock(job(log, 'b'));
  const urgent = lock(job(log, 'c'), { priority: 'high' });
  assert.ok(lock.queueDepth() >= 3);
  await Promise.all([running, urgent]);
  assert.ok(lock.maxQueueDepth() >= 3);
  assert.equal(lock.highJumps(), 1);
});

test('a timeout streak resets on the next success', async () => {
  const lock = makeLock('t', { timeoutMs: 20 });
  await lock(() => new Promise(() => {})).catch(() => {});
  assert.equal(lock.timeoutStreak(), 1);
  await lock(() => Promise.resolve('ok'));
  assert.equal(lock.timeoutStreak(), 0);
});

// ── Wait time, which is the number that actually matters ───────────────────
// Depth is a proxy; WAIT is the fault. A read that waits 21s answers "what was
// open 21 seconds ago?" — long enough on 2026-09-02 for a 16-lot to open and
// close unseen. And it is invisible to every timeout, because each queued call
// completed well inside its own budget.
test('wait time is measured, not inferred', async () => {
  // Injected clock, not wall-clock: measuring elapsed real time inside a test
  // that shares a process with 1500 others is a coin flip under load, and a
  // flaky assertion on a safety-critical lock is worse than no assertion —
  // it trains you to re-run the suite instead of reading the failure.
  let t = 1000;
  const lock = makeLock('t', { now: () => t });
  let release;
  const holding = lock(() => new Promise((r) => { release = r; }));
  const queued = lock(() => Promise.resolve('x'));   // queued at t=1000
  t = 1021;                                          // ...and sits for 21 units
  release();                                         // holder finishes; queued runs now
  await Promise.all([holding, queued]);
  assert.equal(lock.maxWaitMs(), 21, 'the queued caller waited 21 units and it is recorded');
  assert.equal(lock.lastWaitMs(), 21);
});

test('a slow wait fires the callback even though nothing timed out', async () => {
  // The exact 2026-09-02 signature: successful calls, zero timeouts, stale data.
  const slow = [];
  let t = 0;
  const lock = makeLock('t', { timeoutMs: 5000, slowWaitMs: 8000, now: () => t, onSlowWait: (n, ms) => slow.push(ms) });
  let release;
  const holding = lock(() => new Promise((r) => { release = r; }));
  const queued = lock(() => Promise.resolve('x'));
  t = 21000;
  release();
  await Promise.all([holding, queued]);
  assert.deepEqual(slow, [21000], 'reported as a slow WAIT, not as a timeout');
  assert.equal(lock.timeoutStreak(), 0, 'and nothing timed out — that is the whole point');
});

test('the fast lane actually cuts the wait it was built to cut', async () => {
  const lock = makeLock('t');
  const holding = lock(() => new Promise((r) => setTimeout(r, 40)));
  await tick();
  for (let i = 0; i < 5; i++) lock(() => new Promise((r) => setTimeout(r, 20)));
  const t0 = Date.now();
  const urgent = lock(() => Promise.resolve('position'), { priority: 'high' });
  await urgent;
  const waited = Date.now() - t0;
  // Waits only for the RUNNING op (~40ms), not for the five queued 20ms ones.
  assert.ok(waited < 100, 'served after the holder, ahead of five queued calls; waited ' + waited + 'ms');
});

test('wait stats can be reset at day rollover', async () => {
  let t = 0;
  const lock = makeLock('t', { now: () => t });
  let release;
  const holding = lock(() => new Promise((r) => { release = r; }));
  const queued = lock(() => Promise.resolve());
  t = 5000;
  release();
  await Promise.all([holding, queued]);
  assert.ok(lock.maxWaitMs() > 0);
  lock.resetWaitStats();
  assert.equal(lock.maxWaitMs(), 0);
});

// ── Per-call timeouts ──────────────────────────────────────────────────────
// One global budget cannot fit both callers. A chart timeframe switch takes
// 8-15s legitimately and cutting it short leaves the chart on the wrong
// timeframe; a position read is worthless after ~5s because the next one is
// already due. The budget must match how fast the answer goes stale.
test('a per-call timeout overrides the lock default', async () => {
  const lock = makeLock('t', { timeoutMs: 5000 });
  const t0 = Date.now();
  await assert.rejects(lock(() => new Promise(() => {}), { timeoutMs: 30 }), /exceeded 30ms/);
  assert.ok(Date.now() - t0 < 500, 'gave up on its own short budget, not the lock default');
});

test('callers without a per-call budget are unaffected', async () => {
  const lock = makeLock('t', { timeoutMs: 40 });
  await assert.rejects(lock(() => new Promise(() => {})), /exceeded 40ms/);
});

test('a short-budget call abandoning early lets the NEXT one through fast', async () => {
  // The point of a short budget on the position read: a hung one must not hold
  // the guard's view stale while a fresher read is already due.
  const lock = makeLock('t', { timeoutMs: 5000 });
  const log = [];
  const hung = lock(() => new Promise(() => {}), { timeoutMs: 30, priority: 'high' });
  await hung.catch(() => {});
  await lock(job(log, 'fresher-read'), { priority: 'high' });
  assert.deepEqual(log, ['fresher-read']);
});
