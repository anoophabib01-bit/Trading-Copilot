// ── Size-freeze-after-a-loss guard (2026-08-16) ──────────────────────────────
// Anoop, after the six-workflow-patterns build: "the highest-value funded-only
// rule isn't a size cap — it's: any day that hits the daily loss tier ends the
// day, and the next funded day starts at minimum size." The data behind it:
// the trade immediately after a loss, across 109 de-duplicated trades, was
// n=24, 42% win rate, -$1,197 net — with average size RISING to 3.6 contracts
// from 2.1 on the day's first trade. That single state accounts for more of
// the funded drawdown than any other single pattern found.
//
// WHY THIS IS A NEW CHECK, NOT A DUPLICATE of the existing sizedUpWhileLosing
// (grLog(), below sizeFreezeViolation's call site): that check only fires
// when the DAY'S CUMULATIVE P&L is negative before the new trade. A trader
// who is +$50 on the day from two earlier wins, then takes one loss, then
// immediately doubles size on the next trade, has day P&L still positive —
// sizedUpWhileLosing does not see it. This checks the PRECEDING TRADE alone,
// which is exactly the state the data above measured. Both checks stay:
// day-cumulative-negative catches the 07-21 150K breach shape; this one
// catches the shape that actually drove the funded drawdown.
//
// Pure and side-effect-free so it's testable without the guardrail's
// localStorage-backed load()/save() — mirrors stage-rules.js /
// post-session-orchestrator.js's split between "decide" (here, unit-tested)
// and "act" (grLog(), wired against real trade state).

/**
 * @param {Array<{size:number, pnl:number}>} trades  today's trades so far, in order
 * @param {number} newSize                            size about to be logged
 * @returns {boolean} true if this is a real size increase immediately after a loss
 */
function sizeUpAfterLossViolation(trades, newSize) {
  if (!Array.isArray(trades) || !trades.length) return false;
  if (typeof newSize !== 'number' || !isFinite(newSize) || newSize <= 0) return false;
  const prev = trades[trades.length - 1];
  if (!prev || typeof prev.size !== 'number' || typeof prev.pnl !== 'number') return false;
  if (prev.pnl >= 0) return false;
  // 2026-08-19: an inferred trade (tv-broker-feed.js's poll-aliasing backstop,
  // a round trip completed entirely between two polls) is recorded with
  // size:0 because its real size was never observed. Trusting 0 here would
  // read a genuine size-up-after-loss as "tiny" and silently let it through —
  // exactly the enforcement gap flagged in SEMI_AUTONOMOUS_SYSTEM_PLAN.md item
  // 5. Treat "unknown" as "assume worst case": substitute the day's largest
  // size seen so far (any trade before this one, inferred or not) instead of
  // trusting size:0. If nothing else is known either, fall back to 0 (can't
  // invent a size out of nothing) — same as before for that edge case.
  let effectivePrevSize = prev.size;
  if (prev.inferred === true) {
    let maxSoFar = 0;
    for (let i = 0; i < trades.length - 1; i++) {
      const t = trades[i];
      if (t && typeof t.size === 'number' && isFinite(t.size) && t.size > maxSoFar) maxSoFar = t.size;
    }
    effectivePrevSize = maxSoFar;
  }
  return newSize > effectivePrevSize;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sizeUpAfterLossViolation };
}
if (typeof window !== 'undefined') {
  window.SizeFreezeGuard = { sizeUpAfterLossViolation };
}
