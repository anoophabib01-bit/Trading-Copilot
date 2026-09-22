'use strict';
/**
 * position-protection.js - APP-SIDE protection: close a trade at -200 / +600.
 *
 * WHY APP-SIDE (Anoop 2026-09-15: app-side protection is better): the numbers are his
 * (rules.json autoProtection: stopLossUsd 200, takeProfitUsd 600), but the BROKER-SIDE
 * bracket has no route on his build - the order ticket is not in the DOM, the buy/sell
 * widget is one-click market only, and an open position row exposes exactly one control
 * (Close). See G31 in the plan for the whole search. App-side enforcement needs none of
 * that: it reads the position the app already watches and closes it through the order path
 * that is now live-verified. The honest cost, stated so it is never forgotten: this only
 * protects while THIS APP IS AWAKE. A broker bracket would survive the app being closed.
 *
 * Two rules keep it honest:
 *   1. ONE attempt per position (the latch). A position that fails to close must not be
 *      re-ordered every poll - that is how a guard becomes a machine gun.
 *   2. UNREADABLE is its own answer, never silence. If the P&L cannot be established this
 *      reports 'blind' so the caller can alarm; returning 'nothing to do' would leave a
 *      live trade unprotected with no signal that anything was wrong (2026-09-14's shape).
 *
 * Pure, dual-export (module.exports for node --test, window.* for the browser).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PositionProtection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * The side that CLOSES a position, from however the broker spelled it.
   *
   * WHY THIS IS ITS OWN FUNCTION (found live 2026-09-15): oversize-guard.netPosition returns
   * side UPPERCASE ('LONG'/'SHORT'), while both enforcement paths derived the closing side
   * with `side === 'long' ? 'sell' : ...` — lowercase. The comparison was never true, the
   * closing side came back null, and the acting branch was skipped SILENTLY. The per-trade
   * stop therefore alarmed on every breach and closed nothing: the guard that this repo's own
   * replay says turns -$1,946 into +$910 never had hands. Case-insensitive here, and the
   * callers now say out loud when they cannot determine a side instead of doing nothing.
   * Returns null for anything it does not recognise - never a guess.
   */
  function closingSideFor(side) {
    const s = String(side == null ? '' : side).trim().toLowerCase();
    if (s === 'long' || s === 'buy' || s === 'b') return 'sell';
    if (s === 'short' || s === 'sell' || s === 's') return 'buy';
    return null;
  }

  /**
   * Parse a broker money string into a NUMBER, sign included.
   *
   * WHY THIS EXISTS (found live 2026-09-15, by watching an app-side protection test):
   * this broker renders losses with a UNICODE MINUS (U+2212), e.g. "\u221219.00\nUSD". The
   * parser this replaces stripped every non [0-9.-] character, which DELETED that minus and
   * turned a losing position into a winning one - so the per-trade stop compared +19 against
   * a -300 cap and never fired. Every ASCII-minus assumption in this codebase has the same
   * bug; this is the one place it is now handled, and both guards call it.
   * Also handles: the \nUSD suffix, thousands commas, and accounting parentheses.
   * Returns null (never 0) when there is no number, so callers can refuse instead of
   * treating an unreadable figure as break-even.
   */
  function parseMoney(value) {
    if (value === null || value === undefined) return null;
    let s = String(value);
    s = s.replace(/[\u2212\u2013\u2014\u2015]/g, '-');   // unicode minus / en / em dashes
    s = s.replace(/[\u00a0\u202f]/g, ' ');                // non-breaking spaces
    let neg = false;
    if (/^\s*\(.*\)\s*$/.test(s)) { neg = true; s = s.replace(/[()]/g, ''); }
    s = s.replace(/[^0-9.+-]/g, '');
    if (!s || s === '-' || s === '+' || s === '.' || s === '-.') return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return neg ? -Math.abs(n) : n;
  }

  /** Unrealised dollars from prices. A long profits as price rises, a short as it falls. */
  function unrealisedUsd(input) {
    const i = input || {};
    const q = Number(i.size), e = Number(i.entryPrice), p = Number(i.lastPrice), pv = Number(i.pointValue);
    if (!(q > 0) || !(e > 0) || !(p > 0) || !(pv > 0)) return null;
    const s = String(i.side || '').toLowerCase();
    let dir = 0;
    if (s.indexOf('long') === 0 || s === 'buy') dir = 1;
    else if (s.indexOf('short') === 0 || s === 'sell') dir = -1;
    if (!dir) return null;
    return (p - e) * pv * q * dir;
  }

  /**
   * Resolve the EFFECTIVE protection numbers for a stage ('eval' | 'funded').
   *
   * rules.json's autoProtection now carries a per-stage map (eval / funded), each
   * with stopLossUsd / takeProfitUsd / breakEvenAtUsd / trailDistanceUsd, so the
   * band can be tighter in evaluation and looser once funded. Falls back to the
   * FLAT keys (stopLossUsd etc. on the block itself) so any caller or config that
   * predates the per-stage split keeps working unchanged. `trailEnabled` is
   * derived, never typed separately: the trail runs only when BOTH trail numbers
   * are positive.
   */
  function resolveAutoProtection(autoProtection, mode) {
    const base = autoProtection || {};
    const stage = (mode === 'funded' ? base.funded : base.eval) || {};
    const pick = (k) => (stage[k] != null ? stage[k] : base[k]);
    const be = Number(pick('breakEvenAtUsd'));
    const trail = Number(pick('trailDistanceUsd'));
    return {
      enabled: base.enabled !== false,
      stopLossUsd: pick('stopLossUsd'),
      takeProfitUsd: pick('takeProfitUsd'),
      breakEvenAtUsd: be,
      trailDistanceUsd: trail,
      trailEnabled: Number.isFinite(be) && be > 0 && Number.isFinite(trail) && trail > 0,
    };
  }

  /**
   * @param {{side:string, size:number, entryPrice?:number, lastPrice?:number,
   *          unrealisedUsd?:number|null, pointValue?:number, stopLossUsd:number,
   *          takeProfitUsd:number, breakEvenAtUsd?:number, trailDistanceUsd?:number,
   *          peakUsd?:number|null, enabled?:boolean, alreadyAttempted?:boolean}} input
   * @returns {{action:'none'|'close'|'blind', reason:string, unrealisedUsd:number|null,
   *            source:string, peakUsd:number|null, stopLevelUsd:number|null}}
   */
  function decide(input) {
    const i = input || {};
    const stop = Number(i.stopLossUsd);
    const target = Number(i.takeProfitUsd);
    const be = Number(i.breakEvenAtUsd);
    const trail = Number(i.trailDistanceUsd);
    const size = Number(i.size);
    const early = (reason, source) => ({ action: 'none', reason, unrealisedUsd: null, source, peakUsd: null, stopLevelUsd: null });
    if (i.enabled === false) return early('protection disabled in rules.json', 'disabled');
    if (!(size > 0)) return early('no open position', 'flat');
    if (!(stop > 0) || !(target > 0)) return { action: 'blind', reason: 'autoProtection stop/target missing or non-positive in rules.json', unrealisedUsd: null, source: 'rules', peakUsd: null, stopLevelUsd: null };
    if (i.alreadyAttempted) return early('already attempted a close for this position', 'latch');

    let usd = (i.unrealisedUsd === null || i.unrealisedUsd === undefined) ? null : Number(i.unrealisedUsd);
    let source = 'broker';
    if (usd === null || !Number.isFinite(usd)) {
      usd = unrealisedUsd(i);
      source = 'prices';
    }
    if (usd === null || !Number.isFinite(usd)) {
      return { action: 'blind', reason: 'P&L unreadable (no broker figure and no usable price/entry)', unrealisedUsd: null, source: 'unreadable', peakUsd: null, stopLevelUsd: null };
    }

    // High-water mark of unrealised profit. Tracks only up, and is held by the
    // CALLER across polls (this function is pure): the server stores it in
    // positionProtectionState.peakUsd and resets it on flat / a new position.
    const peakIn = Number(i.peakUsd);
    const peak = Number.isFinite(peakIn) ? Math.max(peakIn, usd) : usd;

    // Trailing stop (2026-09-21). Once unrealised profit has EVER reached
    // breakEvenAtUsd, the protective stop rises to max(break-even, peak −
    // trailDistanceUsd) and can only rise from there; below that threshold the
    // fixed −stop still applies. The single expression IS the break-even lock:
    // at the instant peak == be the stop is be − trail (0 when be == trail), so a
    // trade that ran to the trigger can no longer close as a loss.
    const trailArmed = be > 0 && trail > 0 && peak >= be;
    const stopLevel = trailArmed ? Math.max(0, peak - trail) : -stop;

    if (usd >= target) return { action: 'close', reason: 'TARGET: +' + usd.toFixed(2) + ' is at or past +' + target, unrealisedUsd: usd, source, peakUsd: peak, stopLevelUsd: stopLevel };
    if (trailArmed && usd <= stopLevel) return { action: 'close', reason: 'TRAIL: ' + usd.toFixed(2) + ' fell to the trailing stop at +' + stopLevel.toFixed(2) + ' (peak ' + peak.toFixed(2) + ')', unrealisedUsd: usd, source, peakUsd: peak, stopLevelUsd: stopLevel };
    if (!trailArmed && usd <= -stop) return { action: 'close', reason: 'STOP: ' + usd.toFixed(2) + ' is at or past -' + stop, unrealisedUsd: usd, source, peakUsd: peak, stopLevelUsd: stopLevel };
    return {
      action: 'none',
      reason: trailArmed
        ? 'inside the band (' + usd.toFixed(2) + ') — trailing stop armed at +' + stopLevel.toFixed(2)
        : 'inside the band (' + usd.toFixed(2) + ')',
      unrealisedUsd: usd, source, peakUsd: peak, stopLevelUsd: stopLevel,
    };
  }

  return { decide, unrealisedUsd, parseMoney, closingSideFor, resolveAutoProtection };
});