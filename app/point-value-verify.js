'use strict';
// ── Point-value verification (2026-08-23) ──────────────────────────────────
// Cross-checks tv-broker-feed.js's VERIFIED_POINT_VALUE table against what
// TradingView itself reports for the symbol on the chart.
//
// WHY: MNQ's $2.00/point governs EVERY P&L figure the app computes — the
// price-derived cross-check on each round trip, and through it the day P&L,
// the guardrail's loss tiers, and now payout eligibility. It was established
// empirically (117/117 realized values exact at $0.50/tick) and is correct.
// But it was a CONSTANT: nothing re-checked it, and nothing would notice if
// the account moved to a different contract, or if a symbol was added to the
// table with a guessed multiplier. Verified-once is not the same as
// self-checking.
//
// Confirmed live 2026-08-23 — TradingView reports for MNQ1!:
//   pointvalue 2, minmov 25, pricescale 100, currency USD
//   → tick = minmov/pricescale = 0.25, tick value = 0.25 * 2 = $0.50 ✓
// which independently corroborates the empirical figure.
//
// DELIBERATELY ADVISORY, NOT AUTHORITATIVE. A mismatch RAISES AN ALARM; it
// never silently switches the multiplier the fold uses. TradingView's
// metadata is a second opinion, not a more trustworthy one — and quietly
// changing the number that every P&L figure depends on, based on a field
// nothing has validated, is precisely the kind of silent corruption the rest
// of this system is built to refuse. A human decides.

// TradingView reports the tick as minmov/pricescale (e.g. 25/100 = 0.25).
function tickSizeFrom(info) {
  const minmov = Number(info && info.minmov);
  const pricescale = Number(info && info.pricescale);
  if (!Number.isFinite(minmov) || !Number.isFinite(pricescale) || pricescale === 0) return null;
  return minmov / pricescale;
}

/**
 * @param {string} symbol   contract as the app knows it (e.g. "MNQU6", "MNQ1!")
 * @param {number|null} expected  the app's configured point value, or null if
 *                                the symbol is deliberately untracked
 * @param {object} info     symbol_info result { pointvalue, minmov, pricescale }
 */
function verifyPointValue(symbol, expected, info) {
  const reported = Number(info && info.pointvalue);
  const hasReported = Number.isFinite(reported) && reported > 0;
  const tickSize = tickSizeFrom(info);
  const tickValue = (hasReported && tickSize != null) ? tickSize * reported : null;

  const base = {
    symbol: symbol || null,
    expected: Number.isFinite(expected) ? expected : null,
    reported: hasReported ? reported : null,
    tickSize,
    tickValue,
  };

  if (!hasReported) {
    // No opinion from TradingView is not evidence of a problem. Staying silent
    // beats crying wolf on every symbol whose metadata is thin.
    return { ...base, status: 'unknown', ok: true, message: null };
  }
  if (base.expected == null) {
    // The app declines to track this symbol (MGC has no verified multiplier,
    // on purpose). Report what TradingView says so it can be adopted after a
    // human checks it — but do not adopt it here.
    return {
      ...base,
      status: 'untracked',
      ok: true,
      message: `${symbol}: no verified point value configured; TradingView reports $${reported}/point` +
        (tickValue != null ? ` (tick ${tickSize} = $${tickValue.toFixed(2)})` : '') +
        '. Not adopted automatically — verify against a real fill before adding it.',
    };
  }
  if (Math.abs(base.expected - reported) < 1e-9) {
    return {
      ...base,
      status: 'match',
      ok: true,
      message: `${symbol}: point value $${reported}/point confirmed by TradingView`,
    };
  }
  return {
    ...base,
    status: 'mismatch',
    ok: false,
    message: `POINT VALUE MISMATCH on ${symbol}: the app computes P&L at $${base.expected}/point, ` +
      `TradingView reports $${reported}/point` +
      (tickValue != null ? ` (tick ${tickSize} = $${tickValue.toFixed(2)})` : '') +
      '. Every P&L figure — day total, loss tiers, payout consistency — is derived from this number. ' +
      'NOT changed automatically. Verify against a real fill before trusting either figure.',
  };
}

// X7: the single source of point-value truth (dollars per 1.0 point). Every
// dollar figure must come from here, not a caller-supplied multiplier. Add a
// symbol ONLY after verifyPointValue confirms it against TradingView.
const POINT_VALUES = { MNQ: 2, MES: 5, MGC: 10, NQ: 20, GC: 100, ES: 50 };
function pointValueFor(symbol) {
  const s = String(symbol || '').toUpperCase();
  for (const k of Object.keys(POINT_VALUES)) {
    if (s.includes(k)) return POINT_VALUES[k];
  }
  return null;
}

module.exports = { verifyPointValue, tickSizeFrom, pointValueFor, POINT_VALUES };
