'use strict';
/* ── priority-lock.js — the broker lock, with a fast lane ────────────────────
 *
 * (2026-09-02. Extracted from server.js's makeLock, which was a strict FIFO
 * promise chain, and given one new property: some callers matter more than
 * others and must be able to get ahead of the queue.)
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * On 2026-09-02 the broker lock reached a queue depth of SEVEN and the chart
 * lock THIRTEEN (counted from the day's log). The position watch runs on a 5s
 * timer and feeds the oversize guard — the one component in this app that can
 * act on the account unasked — and it was sitting behind up to six panel
 * repairs, account polls and table refreshes on the same lock. A 5s cadence
 * becomes an effective 20-30s, and the guard's whole safety model assumes its
 * reads are current.
 *
 * That day he reached 16 contracts against a cap of 2 and the app recorded a
 * peak of 4. The reads that would have caught it were queued.
 *
 * Worse, the diagnostics ADDED that day (orders re-render, positions
 * re-render, panel repair) all take the same lock, so every fix for the
 * staleness made the queue that causes it longer.
 *
 * ── WHAT THIS CHANGES, AND WHAT IT DOES NOT ─────────────────────────────────
 * One new thing: `{ priority: 'high' }` puts a waiter ahead of every queued
 * NORMAL waiter. It does NOT preempt the operation already running — a
 * half-finished order placement or a mid-flight table read must never be cut
 * in half, and preemption would reintroduce exactly the interleaving the two
 * locks exist to prevent.
 *
 * Everything else is preserved deliberately and verbatim in behaviour:
 *   • one operation at a time,
 *   • a per-operation timeout that RELEASES the lock rather than freezing the
 *     feed, with the late result discarded,
 *   • the caller's stack captured at call time (every timeout error otherwise
 *     looks identical, which is what made the 2026-08-19 crash undiagnosable),
 *   • a handler always attached to the returned promise, so a fire-and-forget
 *     caller can never turn a timeout into an unhandled rejection that takes
 *     down a process running a live trading session.
 *
 * ── ANTI-STARVATION IS NOT OPTIONAL ─────────────────────────────────────────
 * The position watch fires every 5s, forever. Without a bound it would jump the
 * queue every time and a normal waiter behind it could wait indefinitely — and
 * the account poll, which is what actually records trades and P&L, is a normal
 * waiter. So a normal waiter can only be jumped `maxJumps` times; after that it
 * is immune and the next high-priority caller queues behind it. Priority here
 * means "usually first", never "always first". A starved account poll would
 * trade a stale guard for a missing trade record, which is not a trade worth
 * making.
 *
 * PURE-ISH: no fs, no clock beyond setTimeout, no TradingView. Unit-tested in
 * test/priority-lock.test.js with a fake timer-free harness.
 */

const DEFAULTS = {
  timeoutMs: 30000,
  maxJumps: 3,     // how often one normal waiter may be overtaken before it is immune
};

function makeLock(name, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const waiting = [];        // queued waiters, in service order
  let running = false;
  let timeoutStreak = 0;
  let queueDepth = 0;
  let maxQueueDepth = 0;
  let highJumps = 0;         // observability: how often the fast lane was used
  // ── WAIT TIME, WHICH IS THE NUMBER THAT ACTUALLY MATTERS (2026-09-02) ─────
  // Queue DEPTH is a proxy; WAIT is the fault. A read that waits 21s answers
  // the question "what was open 21 seconds ago?", and on 2026-09-02 that was
  // long enough for a 16-lot to open and close unseen. Nothing measured it,
  // which is why the whole episode had to be reconstructed from a broker
  // statement after the fact.
  //
  // Note this is invisible to every timeout: each queued call completed well
  // inside its own budget. The failure is latency, not error — so raising the
  // timeout cannot help and makes it strictly worse, since the timeout is what
  // abandons a stuck call and frees the lock for whoever is next.
  let lastWaitMs = null;
  let maxWaitMs = 0;
  let maxWaitAt = null;

  function schedule() {
    if (running || !waiting.length) return;
    const w = waiting.shift();
    running = true;
    const waited = (cfg.now ? cfg.now() : Date.now()) - w.queuedAt;
    lastWaitMs = waited;
    if (waited > maxWaitMs) { maxWaitMs = waited; maxWaitAt = w.queuedAt; }
    if (cfg.onSlowWait && cfg.slowWaitMs && waited >= cfg.slowWaitMs) {
      try { cfg.onSlowWait(name, waited, w.high); } catch (e) {}
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(w.timer);
      queueDepth = Math.max(0, queueDepth - 1);
      running = false;
      // Yield to the microtask queue before starting the next operation so a
      // caller's own .then() runs first. Without this, a chain of queued
      // operations can starve the event loop this process also uses to serve
      // WebSocket traffic during a live session.
      Promise.resolve().then(schedule);
    };

    // ── PER-CALL TIMEOUT (2026-09-02) ────────────────────────────────────
    // One global timeout cannot fit both callers on this lock. A chart
    // timeframe switch legitimately takes 8-15s and cutting it short can leave
    // the chart on the wrong timeframe. A POSITION READ is worthless after ~5s
    // — the next one is already due — so spending 30s on a hung one just
    // guarantees the guard judges a stale account for 30 seconds.
    //
    // The right budget is the one that matches how fast the answer goes stale,
    // and that differs per caller. Anything without an explicit budget keeps
    // the lock's default, so nothing changes for callers that were fine.
    const budget = w.timeoutMs || cfg.timeoutMs;
    w.timer = setTimeout(() => {
      if (settled) return;
      timeoutStreak++;
      const err = new Error(`${name}: operation exceeded ${budget}ms`);
      err.stack += '\n--- withLock() was CALLED from ---\n' + w.callerStack;
      if (cfg.onTimeout) {
        try { cfg.onTimeout(name, budget, timeoutStreak, w.high); } catch (e) {}
      }
      w.reject(err);
      // The lock is released for the next caller; the original call may still
      // complete in the background and its result is deliberately discarded —
      // a later caller must never wait on a call already given up on.
      finish();
    }, budget);

    let out;
    try { out = w.fn(); } catch (e) { out = Promise.reject(e); }
    Promise.resolve(out).then(
      (v) => { if (!settled) { timeoutStreak = 0; w.resolve(v); finish(); } },
      (e) => { if (!settled) { w.reject(e); finish(); } }
    );
  }

  function withLock(fn, callOpts) {
    const high = !!(callOpts && callOpts.priority === 'high');
    queueDepth++;
    if (queueDepth > maxQueueDepth) maxQueueDepth = queueDepth;
    if (queueDepth > 1 && cfg.onContended) {
      try { cfg.onContended(name, queueDepth, high); } catch (e) {}
    }

    let resolve, reject;
    const winner = new Promise((res, rej) => { resolve = res; reject = rej; });
    const w = {
      fn, high, resolve, reject, timer: null,
      jumped: 0,
      queuedAt: cfg.now ? cfg.now() : Date.now(),
      timeoutMs: (callOpts && Number.isFinite(callOpts.timeoutMs)) ? callOpts.timeoutMs : null,
      // Captured synchronously at the CALL, not at the (much later) timeout —
      // otherwise every timeout error is identical and cannot name which of the
      // many call sites sharing this lock produced it.
      callerStack: new Error().stack,
    };

    if (!high) {
      waiting.push(w);
    } else {
      // Insert ahead of the first normal waiter that has not used up its
      // jump allowance. Never ahead of another high waiter — the fast lane is
      // FIFO within itself, so two urgent reads keep their order.
      let i = 0;
      while (i < waiting.length && (waiting[i].high || waiting[i].jumped >= cfg.maxJumps)) i++;
      if (i < waiting.length) {
        for (let j = i; j < waiting.length; j++) if (!waiting[j].high) waiting[j].jumped++;
        highJumps++;
      }
      waiting.splice(i, 0, w);
    }

    // Always at least one handler, whatever the caller does with the returned
    // promise. A fire-and-forget call whose timeout rejects unhandled would
    // take down a process that is mid-session.
    winner.catch(() => {});
    schedule();
    return winner;
  }

  withLock.queueDepth = () => queueDepth;
  withLock.maxQueueDepth = () => maxQueueDepth;
  withLock.highJumps = () => highJumps;
  withLock.timeoutStreak = () => timeoutStreak;
  withLock.lastWaitMs = () => lastWaitMs;
  withLock.maxWaitMs = () => maxWaitMs;
  withLock.maxWaitAt = () => maxWaitAt;
  // Called at IST rollover so one bad minute at 09:00 does not pin the day's
  // worst-case reading for the next twelve hours.
  withLock.resetWaitStats = () => { maxWaitMs = 0; maxWaitAt = null; };
  return withLock;
}

module.exports = { makeLock, DEFAULTS };
