'use strict';
// ── Bar-close-aligned polling (2026-08-26) ─────────────────────────────────
// Fixes the live-feed timeouts. Written after measuring, not guessing.
//
// ── THE PROBLEM ────────────────────────────────────────────────────────────
// Every watcher polled on a wall clock: 5M engulf every 15s, 15M every 30s,
// FVG 30M every 30s, and so on. That is 740 chart reads an hour. Each read is
// a timeframe switch + a settle poll + an OHLCV read + a restore, measured at
// ~2.4s against the live chart.
//
// But EVERY detector calls dropFormingBar() and evaluates CLOSED bars only.
// New information therefore appears exactly once per bar period — 27 new bars
// an hour across all the watched timeframes. So 740 reads were being spent to
// learn 27 things, and the other 713 returned a bar that had already been
// evaluated.
//
// The cost was not merely wasted work. The chart lock and the broker lock are
// separate locks over ONE CDP connection, so the watchers' churn starved the
// polls that actually matter for live P&L — the 5s position watch and the 10s
// broker poll were the calls hitting `MCP timeout (12s)` while chart-lock
// queue depth climbed to 6.
//
// ── THE FIX ────────────────────────────────────────────────────────────────
// Schedule each watcher to run just after its own bar closes. One read per
// bar, which is exactly the rate at which the thing it is looking for can
// change.
//
// This makes detection FASTER as well as cheaper. A wall-clock poller sits at
// a random phase relative to the bar, so a 30M close was seen anywhere from 0
// to 30s late. Aligned, it is seen a fixed ~5s after the close, every time.
//
// ── WHY THE SETTLE MARGIN EXISTS ───────────────────────────────────────────
// Reading at the exact close instant races the feed: the bar may not have
// finalised, and dropFormingBar would then discard the very bar we woke for,
// costing a whole period. The margin trades a few seconds of latency for
// never missing a close.

// Intraday timeframes whose bars align to epoch boundaries. 5/15/30/60 all
// divide an hour evenly, so `ceil(now / barMs) * barMs` lands on a real bar
// close. Deliberately NOT extended to 240 ('4H'): the observed MNQ 4H bars sit
// at 22:00/02:00 UTC, which is not epoch-4h aligned, so the same arithmetic
// would compute boundaries that are not bar closes. Anything absent here falls
// back to plain interval polling rather than being scheduled wrongly.
const ALIGNED_BAR_MS = {
  '1': 60 * 1000,
  '3': 3 * 60 * 1000,
  '5': 5 * 60 * 1000,
  '15': 15 * 60 * 1000,
  '30': 30 * 60 * 1000,
  '60': 60 * 60 * 1000,
};

const DEFAULT_SETTLE_MS = 5000;
// A floor on the wait. Without it, waking at 0.2s before a close would fire,
// finish, and immediately reschedule into the same period — a tight loop that
// would be worse than the problem being fixed.
const MIN_DELAY_MS = 1500;

function barMsFor(tfCode) {
  return ALIGNED_BAR_MS[String(tfCode)] || null;
}

/**
 * Milliseconds until just after this timeframe's next bar close.
 * Returns null when the timeframe is not epoch-aligned — the caller must then
 * keep its existing interval rather than invent a schedule.
 */
function msUntilNextBarClose(tfCode, now, settleMs) {
  const barMs = barMsFor(tfCode);
  if (!barMs) return null;
  const t = Number.isFinite(now) ? now : Date.now();
  const settle = Number.isFinite(settleMs) ? settleMs : DEFAULT_SETTLE_MS;

  const nextClose = Math.ceil((t + 1) / barMs) * barMs;   // +1 so exactly-on-a-close moves to the NEXT one
  let delay = (nextClose - t) + settle;

  // If the settle margin has already carried us past the next close (i.e. we
  // are inside the margin right after one), aim at the following bar instead
  // of firing twice for the same period.
  if (delay < MIN_DELAY_MS) delay = (nextClose + barMs - t) + settle;
  return delay;
}

/**
 * Self-rescheduling bar-close poller.
 *
 * Returns a handle with .stop(). `run` may be async; the next tick is always
 * scheduled AFTER it settles, so a slow read can never stack a second copy of
 * itself on the chart lock — the exact failure being fixed.
 */
function startBarAlignedPoll(tfCode, run, opts) {
  const o = opts || {};
  const settleMs = o.settleMs;
  const fallbackMs = o.fallbackIntervalMs || 60000;
  let timer = null;
  let stopped = false;

  function schedule() {
    if (stopped) return;
    const aligned = msUntilNextBarClose(tfCode, Date.now(), settleMs);
    const delay = aligned == null ? fallbackMs : aligned;
    timer = setTimeout(tick, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function tick() {
    if (stopped) return;
    try { await run(); }
    catch (e) { /* a failing read must never stop the schedule */ }
    schedule();
  }

  schedule();
  return {
    stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } },
    get scheduled() { return !stopped; },
  };
}

// Reads an hour saved, for the log line that justifies the change.
function readsPerHour(tfCode, currentIntervalMs) {
  const barMs = barMsFor(tfCode);
  return {
    before: currentIntervalMs ? Math.round(3600000 / currentIntervalMs) : null,
    after: barMs ? Math.round(3600000 / barMs) : null,
  };
}

module.exports = { msUntilNextBarClose, startBarAlignedPoll, barMsFor, readsPerHour, ALIGNED_BAR_MS, DEFAULT_SETTLE_MS, MIN_DELAY_MS };
