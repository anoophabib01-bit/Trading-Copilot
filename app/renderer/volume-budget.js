'use strict';
/**
 * volume-budget.js — contracts-per-day cap (2026-08-12)
 *
 * WHY THIS EXISTS, IN ANOOP'S OWN DATA
 * His last five logged days split almost perfectly on total contracts traded,
 * not on setups, not on direction, not on trade count:
 *
 *     2026-08-06    10 contracts    +$440.00
 *     2026-08-07    11 contracts    +$157.50
 *     2026-08-05    12 contracts    -$142.00
 *     2026-08-10    24 contracts    -$879.50
 *     2026-08-11    29 contracts    -$572.50
 *
 * Under ~12 he makes money or loses small. Past 24 — roughly double — he loses
 * an amount that erases a week. Same trader, same charts, same playbooks.
 *
 * The app already capped size PER ENTRY at 2 contracts (rules.json sizeCap) and
 * trade COUNT at 5/session and 10/day. Neither of those catches this: ten
 * legal 2-lot trades is twenty contracts, every individual one inside the
 * rules, and the day is already lost. The missing constraint was the total.
 *
 * The prop-firm research Anoop supplied points the same way — passers average
 * 3.2 trades/day at 0.5-1% risk; failures average 6.8 at 2-3%. His logged
 * average is 6.4 trades/day. This cap is the volume half of that gap.
 *
 * Pure functions — unit-tested in test/volume-budget.test.js.
 */

/**
 * @param {number} contractsSoFar  contracts traded today (sum of |size| per trade)
 * @param {object} cfg             rules.json → contractsPerDay
 * @returns {{level:'ok'|'warn'|'stop', used, cap, remaining, pctUsed, text}}
 */
function volumeStatus(contractsSoFar, cfg = {}) {
  const cap = Math.max(0, Number(cfg.max) || 0);
  const used = Math.max(0, Number(contractsSoFar) || 0);
  const warnPct = Number(cfg.warnAtPct) || 75;

  if (!cfg.enabled || !cap) {
    return { level: 'ok', used, cap: 0, remaining: Infinity, pctUsed: 0, text: 'Contracts-per-day cap is off.' };
  }

  const remaining = Math.max(0, cap - used);
  const pctUsed = Math.round((used / cap) * 100);

  if (used >= cap) {
    return {
      level: 'stop', used, cap, remaining: 0, pctUsed,
      text: `VOLUME CAP HIT — ${used} of ${cap} contracts used today. Every day you went past this size ended badly (24 and 29 contracts cost you $879 and $572). Done for the day.`
    };
  }
  if (pctUsed >= warnPct) {
    return {
      level: 'warn', used, cap, remaining, pctUsed,
      text: `VOLUME ${pctUsed}% — ${used} of ${cap} contracts. ${remaining} left. Your green days finished on 10-11 contracts; this is where size starts running.`
    };
  }
  return {
    level: 'ok', used, cap, remaining, pctUsed,
    text: `${used}/${cap} contracts used, ${remaining} left.`
  };
}

/**
 * Would this next entry breach the cap? Answered BEFORE the trade rather than
 * after — the whole point is to be told while the decision is still cheap.
 */
function wouldBreach(contractsSoFar, nextSize, cfg = {}) {
  const cap = Math.max(0, Number(cfg.max) || 0);
  if (!cfg.enabled || !cap) return { breach: false, projected: 0, cap: 0, text: '' };
  const used = Math.max(0, Number(contractsSoFar) || 0);
  const size = Math.max(0, Number(nextSize) || 0);
  const projected = used + size;
  return {
    breach: projected > cap,
    projected, cap,
    text: projected > cap
      ? `That ${size}-lot would take you to ${projected} contracts, past your ${cap} cap. You have ${Math.max(0, cap - used)} left.`
      : `${size}-lot takes you to ${projected}/${cap} contracts.`
  };
}

/** Total contracts across a day's trade objects ({size} each). */
function contractsUsed(trades) {
  if (!Array.isArray(trades)) return 0;
  return trades.reduce((s, t) => s + Math.abs(Number(t && t.size) || 0), 0);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { volumeStatus, wouldBreach, contractsUsed };
}
if (typeof window !== 'undefined') {
  window.VolumeBudget = { volumeStatus, wouldBreach, contractsUsed };
}
