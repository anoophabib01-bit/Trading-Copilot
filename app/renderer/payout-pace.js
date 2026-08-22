/* ── Payout pace (LIVE_FEED_LOOP_PLAN.md task 6.1) ────────────────────────
 * Distance-to-payout derived mechanically from the day record: distance to
 * the payout threshold, the trailing 20-day daily rate, days-to-target at
 * that rate, and the fixed 20-session implied daily need. GUARD (from the
 * plan): a daily TARGET is a pace indicator, never permission to keep
 * trading to reach it — display alongside the hard stops, never in a place
 * where it could read as a goal that overrides the trade limit or day stop.
 * Pure, UMD.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PayoutPace = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HORIZON_SESSIONS = 20;

  function payoutPace(opts) {
    const o = opts || {};
    const balance = o.balance;
    const target = o.payoutTarget;
    const trailingNet = Number(o.trailing20DayNet) || 0;
    if (typeof balance !== 'number' || !Number.isFinite(balance) || typeof target !== 'number' || !Number.isFinite(target)) return null;
    const distance = Math.round((target - balance) * 100) / 100;
    const dailyRate = Math.round((trailingNet / HORIZON_SESSIONS) * 100) / 100;
    const daysToTarget = (distance > 0 && dailyRate > 0) ? Math.max(1, Math.round(distance / dailyRate)) : null;
    const needPerDay = distance > 0 ? Math.round((distance / HORIZON_SESSIONS) * 100) / 100 : 0;
    return { balance, target, distance, dailyRate, daysToTarget, needPerDay };
  }

  return { payoutPace, HORIZON_SESSIONS };
});
