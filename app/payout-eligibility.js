'use strict';
// ── Payout eligibility (2026-08-23) ────────────────────────────────────────
// Computes how far Anoop is from being ALLOWED to request a payout, which is
// a different question from how much money he has made — and the one the app
// could not answer at all until now.
//
// WHY THIS EXISTS: the stated goal of the whole system is "reach a payout".
// The hard gate on that is the prop firm's CONSISTENCY RULE, and before this
// module the app tracked no part of it. `rules.json` carried a single
// `consistencyPctMax: 50` which (a) matched no published Tradeify tier and
// (b) was read by no code anywhere — `grep` returned only its own definition.
// So the one number in the repo about the payout gate was both wrong and
// dead.
//
// THE RULE (Tradeify, https://help.tradeify.co/en/articles/10468320):
//   "no single day's profit should exceed a set percentage of the trader's
//    total profits over a given period"
//   Biggest end-of-day P&L / consistency% = total balance needed.
//
// Published limits, as of 2026-08-23:
//   Growth Sim Funded ............ 35%
//   Select Evaluation ............ 40%  (evaluation phase ONLY; none funded)
//   Lightning Funded (post 2025-09-12) 20% → 25% → 30% by payout number
//   Lightning Funded (pre)  ...... 20% flat
// These live in rules.json (payout.tiers), not here — this module must never
// be the place a firm's number is hardcoded. That is the mistake that put a
// 50 in the config in the first place.
//
// THREE PROPERTIES OF THE RULE THAT ARE COUNTER-INTUITIVE, and which the
// coach should be able to say out loud (all confirmed in the source's FAQ):
//   1. After a big green day, MORE SMALL GREEN DAYS is the fast route to a
//      payout. Another big day makes the ratio worse, not better.
//   2. A losing day hurts twice — the loss itself, and the shrunken
//      denominator pushing the ratio UP.
//   3. One profitable day is always 100%, so it can never be eligible. Spread
//      is mandatory, not preferable.
//
// BOUNDARY: "at or below" passes. 19.97% meets a 20% rule and exactly 20.00%
// meets it too; only STRICTLY ABOVE fails. Implemented as `<=` with a small
// epsilon so float noise at the boundary cannot manufacture a failure.

// Floating-point slack for the at-or-below comparison. A ratio computed as
// 35.000000000000004 must not read as a breach of a 35% rule.
const PCT_EPSILON = 1e-9;

// Days on or before a payout belong to the PREVIOUS payout period: the source
// says the count and the percentage both reset after an approved payout.
function daysSinceLastPayout(days, payouts) {
  const rows = Array.isArray(days) ? days.slice() : [];
  const outs = Array.isArray(payouts) ? payouts : [];
  let cutoff = null;
  for (const p of outs) {
    const d = p && p.date ? String(p.date) : null;
    if (!d) continue;
    if (cutoff == null || d > cutoff) cutoff = d;
  }
  const kept = cutoff == null ? rows : rows.filter((r) => r && String(r.date) > cutoff);
  return { cutoff, days: kept.filter((r) => r && r.date != null) };
}

// WHICH P&L FIELD: the source parenthesises "(commissions are not included in
// profit)", which reads as the firm evaluating GROSS. gr_history carries both
// `pnl` (net) and `gross`. Defaulting to net is the conservative choice — net
// is smaller, so the computed consistency ratio is HIGHER and the app will
// call him ineligible slightly before the firm does, never after. Configurable
// via rules.json payout.profitField because this is a genuine ambiguity in the
// firm's wording and only a real payout request settles it.
function dayProfit(row, field) {
  if (!row) return 0;
  const v = field === 'gross' ? row.gross : row.pnl;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {Array}  days     gr_history rows: { date, pnl, gross }
 * @param {Array}  payouts  account_fees payouts: { date, amount }
 * @param {Object} cfg      { consistencyPct, minProfitableDays, minDayProfit,
 *                            profitField }
 */
function computePayoutEligibility(days, payouts, cfg) {
  const c = cfg || {};
  const limitPct = Number(c.consistencyPct);
  const field = c.profitField === 'gross' ? 'gross' : 'pnl';
  const minDayProfit = Number(c.minDayProfit) || 0;
  const minProfitableDays = Number(c.minProfitableDays) || 0;

  const { cutoff, days: period } = daysSinceLastPayout(days, payouts);

  let totalProfit = 0;
  let biggestDay = 0;
  let biggestDayDate = null;
  let profitableDays = 0;
  let qualifyingDays = 0;
  let losingDays = 0;

  for (const row of period) {
    const p = dayProfit(row, field);
    totalProfit += p;
    if (p > 0) {
      profitableDays++;
      if (p >= minDayProfit) qualifyingDays++;
      if (p > biggestDay) { biggestDay = p; biggestDayDate = row.date; }
    } else if (p < 0) {
      losingDays++;
    }
  }

  // With no profit banked there is no ratio to speak of. Deliberately NOT
  // reported as 0% (which would look compliant and is the opposite of true) —
  // null means "undefined", and eligible stays false.
  const hasProfit = totalProfit > 0 && biggestDay > 0;
  const consistencyPct = hasProfit ? (biggestDay / totalProfit) * 100 : null;

  const limitKnown = Number.isFinite(limitPct) && limitPct > 0;
  const consistencyOk = !!(hasProfit && limitKnown && consistencyPct <= limitPct + PCT_EPSILON);

  // Total profit required for the CURRENT biggest day to sit at the limit.
  const requiredTotal = (hasProfit && limitKnown) ? biggestDay / (limitPct / 100) : null;
  const additionalProfitNeeded = requiredTotal == null
    ? null
    : Math.max(0, requiredTotal - totalProfit);

  // The ceiling for any NEW day that must not itself breach the rule. Uses the
  // post-addition total, so it answers "if I make $X today, is X itself now
  // the biggest day and does that break me?" — solve d <= limit*(total+d)
  //   → d <= limit*total / (1 - limit)
  const lf = limitKnown ? limitPct / 100 : null;
  const maxNewDayProfit = (lf != null && lf < 1 && totalProfit > 0)
    ? (lf * totalProfit) / (1 - lf)
    : null;

  const daysNeeded = Math.max(0, minProfitableDays - qualifyingDays);

  // Rough shape of the remaining work: enough days to satisfy the day count,
  // and enough of them to dilute the biggest day. Reported as a hint, never as
  // a promise — the firm's own gates (profit target, 10-second rule, payout
  // caps) are not modelled here.
  let suggestedDays = daysNeeded;
  if (additionalProfitNeeded != null && additionalProfitNeeded > 0 && maxNewDayProfit && maxNewDayProfit > 0) {
    suggestedDays = Math.max(suggestedDays, Math.ceil(additionalProfitNeeded / maxNewDayProfit));
  }
  const suggestedPerDay = (additionalProfitNeeded != null && suggestedDays > 0)
    ? additionalProfitNeeded / suggestedDays
    : null;

  return {
    periodStartAfter: cutoff,      // null = no payout yet, whole history counts
    daysInPeriod: period.length,
    profitField: field,
    totalProfit,
    biggestDay,
    biggestDayDate,
    profitableDays,
    qualifyingDays,
    losingDays,
    consistencyPct,
    consistencyLimitPct: limitKnown ? limitPct : null,
    consistencyOk,
    requiredTotal,
    additionalProfitNeeded,
    maxNewDayProfit,
    minProfitableDays,
    minDayProfit,
    qualifyingDaysNeeded: daysNeeded,
    suggestedDays,
    suggestedPerDay,
    // Eligible ONLY when both gates pass. Deliberately conservative: an
    // unknown limit is never treated as satisfied.
    eligible: !!(consistencyOk && daysNeeded === 0),
  };
}

// One-line human summary for Jessi's context block and the recap. Kept here so
// the wording stays with the maths and cannot drift from it.
function summarizePayout(e) {
  if (!e) return 'PAYOUT — data unavailable.';
  if (!e.consistencyLimitPct) {
    return 'PAYOUT — no consistency limit configured for this account tier, so eligibility cannot be computed. Set rules.json payout.tiers.';
  }
  if (e.totalProfit <= 0) {
    return `PAYOUT — not eligible: no net profit banked this period (${e.daysInPeriod} day(s) since last payout).`;
  }
  const parts = [];
  parts.push(`PAYOUT — biggest day $${e.biggestDay.toFixed(2)} of $${e.totalProfit.toFixed(2)} total = ${e.consistencyPct.toFixed(1)}% (limit ${e.consistencyLimitPct}%)`);
  if (e.eligible) {
    parts.push('ELIGIBLE on consistency + day count');
  } else {
    if (!e.consistencyOk && e.additionalProfitNeeded > 0) {
      parts.push(`needs $${e.additionalProfitNeeded.toFixed(2)} more profit spread over other days`);
      if (e.maxNewDayProfit) parts.push(`no single new day above $${e.maxNewDayProfit.toFixed(2)}`);
    }
    if (e.qualifyingDaysNeeded > 0) {
      parts.push(`${e.qualifyingDaysNeeded} more day(s) above $${e.minDayProfit}`);
    }
  }
  return parts.join('; ') + '.';
}

// Pick the tier block for the account family + mode. `mode` is the app's
// existing eval|funded axis, so no new state is introduced. Returns null when
// nothing matches, and callers must treat null as "cannot compute" rather than
// as "no limit, therefore fine".
function resolveTier(rules, mode) {
  const p = (rules && rules.payout) || null;
  if (!p || !p.tiers) return null;
  const family = String(p.accountFamily || '').trim();
  if (!family) return null;
  const suffix = String(mode || '').toLowerCase() === 'funded' ? 'Funded' : 'Eval';
  const key = family + suffix;
  const tier = p.tiers[key] || p.tiers[family] || null;
  if (!tier) return null;
  return {
    key,
    label: tier.label || key,
    consistencyPct: tier.consistencyPct,
    minProfitableDays: tier.minProfitableDays,
    minDayProfit: tier.minDayProfit,
    profitField: p.profitField,
  };
}

module.exports = { computePayoutEligibility, summarizePayout, daysSinceLastPayout, resolveTier };
