'use strict';
// Tests for the live-feed fix. The scheduling math decides whether a watcher
// fires at all, so a wrong boundary here is a silently dark monitor.
const test = require('node:test');
const assert = require('node:assert');
const { msUntilNextBarClose, startBarAlignedPoll, barMsFor, MIN_DELAY_MS, DEFAULT_SETTLE_MS } = require('../bar-schedule.js');

const at = (iso) => Date.parse(iso);

test('lands just after the next real bar close', () => {
  // 30M bars close at :00 and :30 UTC
  const d = msUntilNextBarClose('30', at('2026-08-26T14:07:00Z'), 5000);
  assert.equal(d, 23 * 60 * 1000 + 5000);   // 23 min to 14:30, plus settle
});

test('every aligned timeframe resolves to a genuine boundary', () => {
  const now = at('2026-08-26T14:07:13Z');
  for (const tf of ['1', '3', '5', '15', '30', '60']) {
    const d = msUntilNextBarClose(tf, now, 0);
    const landing = new Date(now + d);
    assert.equal(landing.getTime() % barMsFor(tf), 0, `tf ${tf} did not land on a bar boundary`);
  }
});

test('sitting exactly ON a close targets the NEXT bar, not the one just gone', () => {
  const d = msUntilNextBarClose('30', at('2026-08-26T14:30:00Z'), 0);
  assert.equal(d, 30 * 60 * 1000, 'must not fire immediately for a bar already evaluated');
});

test('waking inside the settle margin skips to the following bar, not a tight loop', () => {
  // 1ms before a close: the naive delay would be ~0 and would re-fire for a
  // period already handled.
  const d = msUntilNextBarClose('5', at('2026-08-26T14:04:59.999Z'), 5000);
  assert.ok(d >= MIN_DELAY_MS, `delay ${d} would busy-loop`);
});

test('the delay never exceeds one bar period plus the margin', () => {
  for (const tf of ['5', '15', '30', '60']) {
    for (let m = 0; m < 60; m++) {
      const d = msUntilNextBarClose(tf, at('2026-08-26T14:00:00Z') + m * 60000, DEFAULT_SETTLE_MS);
      assert.ok(d <= barMsFor(tf) + DEFAULT_SETTLE_MS + MIN_DELAY_MS, `tf ${tf} min ${m} gave ${d}`);
      assert.ok(d > 0);
    }
  }
});

test('a non-epoch-aligned timeframe returns null so the caller keeps its interval', () => {
  // 4H MNQ bars sit at 22:00/02:00 UTC — NOT epoch-4h aligned, so computing a
  // boundary here would schedule reads at times that are not bar closes.
  assert.equal(msUntilNextBarClose('240', Date.now(), 0), null);
  assert.equal(msUntilNextBarClose('D', Date.now(), 0), null);
  assert.equal(msUntilNextBarClose(null, Date.now(), 0), null);
});

// ── the poller ──────────────────────────────────────────────────────────────
test('a slow run can never stack a second copy of itself', async () => {
  // DETERMINISTIC, not timing-based. The property under test is that tick()
  // AWAITS run() before scheduling the next one, so a read slower than its own
  // interval can never have two copies in flight — which is what saturated the
  // chart lock. An earlier version of this test asserted "several ticks fired
  // in 250ms" and went flaky under full-suite load: a timing assertion that
  // fails when the machine is busy tests the machine, not the code.
  let inFlight = 0, maxConcurrent = 0, started = 0;
  let release;
  const gate = () => new Promise((r) => { release = r; });

  const h = startBarAlignedPoll('999', async () => {      // unaligned -> fallback interval
    started++; inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight);
    await gate();
    inFlight--;
  }, { fallbackIntervalMs: 1 });

  // Wait until the first run has actually begun and is parked inside run().
  while (started < 1) await new Promise((r) => setTimeout(r, 5));
  // Give the scheduler ample opportunity to start a second one. It must not:
  // the next tick is only scheduled after this one settles.
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(started, 1, 'a second run was started while the first was still in flight');
  assert.strictEqual(maxConcurrent, 1, 'overlapping reads are what saturated the chart lock');

  release();                                              // let it finish
  await new Promise((r) => setTimeout(r, 30));
  h.stop();
});

test('a throwing run does not stop the schedule', async () => {
  // WAITS for the condition instead of sleeping a fixed time. The earlier
  // version slept 120ms and asserted "at least 3 runs happened", which fails
  // under full-suite load — that tests the machine, not the scheduler.
  let runs = 0;
  const h = startBarAlignedPoll('999', async () => { runs++; throw new Error('boom'); },
    { fallbackIntervalMs: 5 });
  const deadline = Date.now() + 3000;
  while (runs < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  h.stop();
  assert.ok(runs >= 3, `a throwing run must not stop the schedule; got ${runs}`);
});

test('stop() actually stops it', async () => {
  let runs = 0;
  const h = startBarAlignedPoll('999', () => { runs++; }, { fallbackIntervalMs: 10 });
  await new Promise((r) => setTimeout(r, 60));
  h.stop();
  const after = runs;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs, after, 'timer kept firing after stop');
});

test('the read-rate reduction is real, not cosmetic', () => {
  const { readsPerHour } = require('../bar-schedule.js');
  // The actual live cadences before this change
  assert.equal(readsPerHour('5', 15000).before, 240);
  assert.equal(readsPerHour('5', 15000).after, 12);
  assert.equal(readsPerHour('30', 30000).before, 120);
  assert.equal(readsPerHour('30', 30000).after, 2);
});
