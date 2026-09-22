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

// ── A SCRATCH IS NOT A LOSS (2026-09-21) ─────────────────────────────────────
// This guard fired on 2026-09-21 and raised the full-screen "DAILY STOP HIT"
// overlay on a day that closed +$124.30, on 4 trades, at a max size of 4/4 —
// all three of Anoop's own limits intact. The trigger was trade 2: 4 contracts
// taken after trade 1 closed -$0.90 on 1 contract.
//
// -$0.90 is not a loss anywhere else in this app. It is BELOW the break-even
// band, and rules.json's own definition (breakEvenBandUsd) says a trade inside
// +/-$100 is "not a trade" — renderer/app.js's Journal table renders it with a
// "break-even" badge reading "by your own definition, not a trade". day-plan.js
// documents the same rule for streaks ("A SCRATCH ENDS A STREAK"). A -$0.90
// close is commission, not a losing state: it carries no information about
// whether the next trade is being taken from a place of loss.
//
// So "loss" now means the same thing here that it means everywhere else in the
// app. The dangerous shape this guard exists for is unchanged: a REAL loss
// (|pnl| >= the band) followed by an INCREASE. That shape is still a hard stop.
//
// FAIL-SAFE DEFAULT, deliberately different from the display band at
// renderer/app.js's Journal table (which defaults 100 when the rule is absent):
// an ABSENT or non-positive band means "every negative close counts as a loss",
// i.e. the old behaviour. Defaulting to a permissive band here would silently
// weaken a safety guard on a missing key, which is the wrong direction to fail.

/**
 * @param {Array<{size:number, pnl:number}>} trades  today's trades so far, in order
 * @param {number} newSize                            size about to be logged
 * @param {object} [opts]                             { breakEvenBandUsd }
 * @returns {boolean} true if this is a real size increase immediately after a loss
 */
function sizeUpAfterLossViolation(trades, newSize, opts) {
  return sizeUpAfterLossReading(trades, newSize, opts).violation;
}

/**
 * The same judgement, with the reasoning kept — so the overlay can say WHICH
 * limit stopped the day and with what numbers, instead of always printing
 * "DAILY STOP HIT". A stop that names the wrong reason is a stop he learns to
 * dismiss, which costs the guard the days it is right.
 *
 * @returns {{violation:boolean, level:string, prevSize:number|null,
 *            prevPnl:number|null, newSize:number|null, reason:string}}
 */
function sizeUpAfterLossReading(trades, newSize, opts) {
  const o = opts || {};
  const band = Number(o.breakEvenBandUsd) > 0 ? Number(o.breakEvenBandUsd) : 0;
  const no = (level, reason) => ({
    violation: false, level, prevSize: null, prevPnl: null, newSize: null, reason
  });

  if (!Array.isArray(trades) || !trades.length) return no('none', 'No earlier trade today.');
  if (typeof newSize !== 'number' || !isFinite(newSize) || newSize <= 0) {
    return no('none', 'New size is not a usable number.');
  }
  const prev = trades[trades.length - 1];
  if (!prev || typeof prev.size !== 'number' || typeof prev.pnl !== 'number') {
    return no('none', 'The previous trade has no readable size and P&L.');
  }
  if (prev.pnl >= 0) return no('none', 'The previous trade was not a loss.');
  if (band > 0 && Math.abs(prev.pnl) < band) {
    // pnl is negative here, so this can only be reached by a real scratch.
    return {
      violation: false, level: 'scratch', prevSize: prev.size, prevPnl: prev.pnl, newSize: newSize,
      reason: 'The previous trade closed ' + prev.pnl + ', inside the +/-$' + band
        + ' break-even band — by your own definition that is a scratch, not a loss.'
    };
  }
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
  const violation = newSize > effectivePrevSize;
  return {
    violation: violation, level: violation ? 'violation' : 'none',
    prevSize: effectivePrevSize, prevPnl: prev.pnl, newSize: newSize,
    // Names the size the guard actually compared against, which for an inferred
    // previous trade is NOT prev.size — the overlay must quote the number the
    // decision was made on, or it reads as a wrong accusation.
    reason: violation
      ? 'Size rose to ' + newSize + ' contracts after a ' + prev.pnl + ' loss on '
        + effectivePrevSize + ' contract' + (effectivePrevSize === 1 ? '' : 's') + '.'
      : 'Size did not increase after the loss.'
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sizeUpAfterLossViolation, sizeUpAfterLossReading };
}
if (typeof window !== 'undefined') {
  window.SizeFreezeGuard = { sizeUpAfterLossViolation, sizeUpAfterLossReading };
}
