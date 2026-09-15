/**
 * csv-reconcile-policy.js — decides whether a broker CSV upload may be applied
 * WITHOUT the confirm click.
 *
 * WHY (2026-09-15, Anoop): "if next time if the app is not active and if i upload
 * CSV it should pick trades that are missing and update in the app." The reconcile
 * flow already adds missing trades, but every upload stopped at a confirm card —
 * including the pure-addition case where the app was simply not running, which is
 * the one case that cannot change anything already recorded.
 *
 * The rule is deliberately narrow: auto-apply ONLY when every difference is a trade
 * the app does not have. If the file would also rewrite a recorded row (a matched
 * trade whose P&L differs) or the store holds trades the file does not mention
 * (live-only), the confirm card still appears — an unattended upload must never be
 * able to change or drop a number that was already recorded.
 *
 * Pure + dual-export (module.exports for node --test, window.* for the browser),
 * the established shape for decision logic in this renderer.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CsvReconcilePolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * @param {{dates?: Array<{date:string, csvOnly?:number, liveOnly?:number,
   *          disagree?:number, matched?:number, csvCount?:number}>}} input
   * @returns {{action:'auto-apply'|'no-op'|'confirm', added:number, liveOnly:number,
   *            disagree:number, matched:number, reason:string}}
   */
  function decide(input) {
    const dates = (input && Array.isArray(input.dates)) ? input.dates : [];
    let added = 0, liveOnly = 0, disagree = 0, matched = 0, csvTotal = 0;
    for (const d of dates) {
      if (!d) continue;
      added += Number(d.csvOnly) || 0;
      liveOnly += Number(d.liveOnly) || 0;
      disagree += Number(d.disagree) || 0;
      matched += Number(d.matched) || 0;
      csvTotal += Number(d.csvCount) || 0;
    }
    if (added === 0 && liveOnly === 0 && disagree === 0) {
      return {
        action: 'no-op', added, liveOnly, disagree, matched,
        reason: csvTotal === 0
          ? 'the file carries no trades'
          : 'the file matches the app record exactly — nothing to add',
      };
    }
    if (added > 0 && liveOnly === 0 && disagree === 0) {
      return {
        action: 'auto-apply', added, liveOnly, disagree, matched,
        reason: added + ' trade(s) exist only in the file — the app was not running to record them',
      };
    }
    return {
      action: 'confirm', added, liveOnly, disagree, matched,
      reason: 'applying could change rows already recorded (live-only ' + liveOnly +
        ', P&L disagreements ' + disagree + ')',
    };
  }

  return { decide };
});
