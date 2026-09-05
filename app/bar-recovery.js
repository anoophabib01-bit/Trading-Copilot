'use strict';
// ── bar-recovery.js — does the bar record have a hole, and can it be filled? ──
//
// Anoop, 2026-09-02, after finding DATA/bars had recorded nothing for a day:
//
//   "why has bar recorder stopped. build a protocol to self repair on start up
//    as it is important."
//
// ── WHY THE RECORD HAD A HOLE ─────────────────────────────────────────────
// runBarRecorder() was only ever scheduled ONCE PER DAY, at >= 21:30 IST,
// guarded by a day key. The 10-minute poll around it exists so a restart in
// the evening still catches that day — but it can only catch it if the server
// is RUNNING at some point after 21:30. On 2026-09-01 the server stopped at
// 20:15 IST and did not come back until 11:31 IST the next morning, so the
// window was never open and the day was simply never recorded.
//
// Nothing was broken. The schedule had no memory: it could tell "today has not
// been recorded yet" from "today was recorded", but never "YESTERDAY was
// missed and is still partially reachable". That is the gap this closes.
//
// ── WHY IT MATTERS MORE THAN A NORMAL MISSED CRON ─────────────────────────
// bar-recorder.js exists precisely because TradingView will NOT serve this
// history retrospectively — its whole purpose is to accumulate what cannot be
// re-fetched later. A missed run is therefore not "we will get it next time";
// it is a permanent hole that grows less recoverable every hour.
//
// ── WHAT A REPAIR CAN AND CANNOT DO — READ THIS BEFORE TRUSTING IT ────────
// A catch-up pull fetches PULL_COUNT bars. That is a FIXED REACH BACKWARDS:
// 300 x 1m is ~5 hours, 300 x 5m is ~25 hours. Anything older than that reach
// is gone permanently, and no amount of retrying changes it.
//
// So this module never reports "repaired". It reports how much of the gap is
// reachable and how much is NOT, because a self-repair that quietly recovers
// 5 of 15 missing hours while logging "OK" would be the worst of both worlds —
// the hole stays, and the log says it was handled.
//
// ── WHY THE GAP IS MEASURED IN TIME, NOT IN BARS ──────────────────────────
// The obvious implementation counts `gapMinutes / spacing` missing bars. That
// over-states the loss, because MNQ does not print bars continuously: there is
// a daily maintenance break and a full weekend close. A 60-hour weekend gap is
// not 720 lost 5m bars. Every figure here is therefore a duration, and the
// unreachable portion is reported as "up to" — an upper bound on the loss, not
// a claim about it.
//
// PURE. No I/O, no clock, no chart — the caller supplies the file facts.

// Must match the `count:` runBarRecorder() actually requests. Exported so the
// two cannot drift: a server that pulls 300 while this assumes 500 would
// under-report the permanent loss, which is the one error worth preventing.
const PULL_COUNT = 300;

// One bar behind is just the still-forming candle, which the recorder is
// supposed to be behind. Two is a real gap.
const MIN_MISSED_BARS = 2;

const STATUS = {
  NEVER: 'never-recorded',   // no file, or no usable bars in it
  CURRENT: 'current',        // within MIN_MISSED_BARS — nothing to do
  RECOVERABLE: 'recoverable',// gap fits inside the pull reach
  PARTIAL: 'partial-loss',   // gap exceeds the reach; the oldest part is gone
};

function hours(mins) { return Math.round((mins / 60) * 10) / 10; }

/**
 * Assess one recorded timeframe.
 *
 * @param {{tf:string, spacing:number, lastBarMs:number|null, count:number}} file
 * @param {number} nowMs
 * @param {number} [pullCount]
 */
function assessFile(file, nowMs, pullCount) {
  const reach = (pullCount || PULL_COUNT) * file.spacing;   // minutes reachable
  const out = {
    tf: file.tf,
    spacing: file.spacing,
    count: file.count || 0,
    lastBarMs: file.lastBarMs || null,
    reachMinutes: reach,
    gapMinutes: null,
    missedBars: 0,
    unreachableMinutes: 0,
    status: STATUS.NEVER,
  };

  if (!file.lastBarMs || !Number.isFinite(file.lastBarMs)) return out;

  const gap = Math.max(0, (nowMs - file.lastBarMs) / 60000);
  out.gapMinutes = Math.round(gap);
  out.missedBars = Math.floor(gap / file.spacing);

  if (out.missedBars < MIN_MISSED_BARS) {
    out.status = STATUS.CURRENT;
    return out;
  }
  // Beyond the pull's reach, the oldest part of the gap can never be fetched.
  out.unreachableMinutes = Math.max(0, Math.round(gap - reach));
  out.status = out.unreachableMinutes > 0 ? STATUS.PARTIAL : STATUS.RECOVERABLE;
  return out;
}

/**
 * Assess every recorded timeframe and decide whether to run a catch-up pull.
 *
 * @returns {{needsRepair:boolean, files:Array, anyPermanentLoss:boolean, summary:string}}
 *   `needsRepair` is true when a pull would fetch something useful. Note it is
 *   ALSO true for a partial loss: the reachable part is still worth having,
 *   and refusing to pull because some of it is gone would throw away the rest.
 */
function assess(files, nowMs, pullCount) {
  const assessed = (files || []).map(f => assessFile(f, nowMs, pullCount));
  const actionable = assessed.filter(f => f.status !== STATUS.CURRENT);
  const anyPermanentLoss = assessed.some(f => f.status === STATUS.PARTIAL);
  return {
    needsRepair: actionable.length > 0,
    files: assessed,
    anyPermanentLoss,
    summary: summarize(assessed),
  };
}

// The line that goes in the log. It names what is gone as prominently as what
// is being fetched — a repair notice that mentions only the fix reads as
// success, and this one frequently is not one.
function summarize(assessed) {
  if (!assessed.length) return 'BAR RECORD: nothing configured to record.';
  const parts = [];
  for (const f of assessed) {
    switch (f.status) {
      case STATUS.NEVER:
        parts.push(f.tf + 'm: NEVER RECORDED — starting from nothing');
        break;
      case STATUS.CURRENT:
        parts.push(f.tf + 'm: current (' + f.count + ' bars)');
        break;
      case STATUS.RECOVERABLE:
        parts.push(f.tf + 'm: ' + hours(f.gapMinutes) + 'h gap, fully within the '
          + hours(f.reachMinutes) + 'h reach — recoverable');
        break;
      case STATUS.PARTIAL:
        parts.push(f.tf + 'm: ' + hours(f.gapMinutes) + 'h gap vs a '
          + hours(f.reachMinutes) + 'h reach — UP TO ' + hours(f.unreachableMinutes)
          + 'h IS GONE PERMANENTLY, only the newest ' + hours(f.reachMinutes) + 'h can be fetched');
        break;
    }
  }
  return 'BAR RECORD: ' + parts.join(' | ');
}

/**
 * What the pull actually achieved, compared with what was hoped for.
 *
 * Called AFTER runBarRecorder returns, because "we attempted a repair" and "the
 * hole is smaller than it was" are different claims and only the second one is
 * worth anything. A pull that adds zero bars while reporting success is the
 * exact failure this whole module was written in response to.
 *
 * @param {Array} before  assess().files, taken before the pull
 * @param {Array} results runBarRecorder()'s per-timeframe results
 */
function describeOutcome(before, results) {
  const byTf = new Map((results || []).map(r => [String(r.tf), r]));
  const lines = [];
  let repaired = 0, failed = 0;
  for (const b of before || []) {
    if (b.status === STATUS.CURRENT) continue;
    const r = byTf.get(String(b.tf));
    if (!r) { lines.push(b.tf + 'm: NOT ATTEMPTED'); failed++; continue; }
    if (r.error) { lines.push(b.tf + 'm: FAILED — ' + r.error); failed++; continue; }
    if (r.rejected) { lines.push(b.tf + 'm: REJECTED — ' + r.reason); failed++; continue; }
    const added = Number(r.added) || 0;
    if (added > 0) { lines.push(b.tf + 'm: +' + added + ' bars recovered'); repaired++; }
    else { lines.push(b.tf + 'm: 0 new bars — the gap was NOT filled'); failed++; }
  }
  return {
    repaired, failed,
    ok: failed === 0 && repaired > 0,
    text: lines.length ? lines.join(' | ') : 'nothing needed repair',
  };
}

module.exports = {
  assess, assessFile, describeOutcome, summarize,
  PULL_COUNT, MIN_MISSED_BARS, STATUS,
};
