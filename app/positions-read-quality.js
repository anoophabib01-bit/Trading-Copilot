'use strict';
/**
 * positions-read-quality.js — is this broker read actually FLAT, or is the
 * positions table just not rendering? (G28, 2026-09-15.)
 *
 * WHY THIS EXISTS (measured live): on 2026-09-14 Anoop opened a 1-lot MNQU6 long.
 * For ~16 minutes the app reported Position FLAT, its day P&L counted closed
 * trades only, and the per-trade stop alarmed "unrealised P&L UNREADABLE". The
 * broker's own positions table was rendering its empty-state PLACEHOLDER
 * ("There are no open positions in your trading account yet") while a real
 * position and a working TP/SL pair sat on the account. One manual
 * tv-broker-check-now restored the read.
 *
 * The existing guard only covers positions.success === false. This case is
 * success === TRUE with zero rows — which is ALSO the shape of a genuinely flat
 * account, so it cannot be judged from the panel alone. The tie-breaker is
 * evidence that does not come from the panel:
 *
 *   - a WORKING take-profit/stop-loss order (an exit cannot exist without a
 *     position to exit), and
 *   - the signed net of today's FILLED orders (order history is timestamped and
 *     append-only; server.js's own 2026-09-02 note records a live case where the
 *     walk was right and the panel was stale).
 *
 * Either one, against zero position rows, is a contradiction: the read is
 * UNREADABLE, never flat. Open P&L alone is weaker — it can lag a close — so it
 * only raises 'suspect', which asks for one forced re-render without refusing
 * the poll.
 *
 * Pure and dependency-free so the decision is unit-tested rather than reasoned
 * about inside a 14k-line poll loop.
 */

/** 'flat' | 'open' | 'unreadable' | 'suspect' */
function classify(input) {
  const i = input || {};
  if (i.positionsSuccess === false) {
    return { state: 'unreadable', contradiction: true, reason: 'positions table could not be read at all' };
  }
  const count = Number(i.positionCount) || 0;
  if (count > 0) return { state: 'open', contradiction: false, reason: count + ' open position row(s)' };

  const workingExits = Number(i.workingExitOrders) || 0;
  const walkNet = Math.abs(Number(i.walkNetQty) || 0);
  const openPnl = Math.abs(Number(i.summaryOpenPnl) || 0);

  if (workingExits > 0) {
    return {
      state: 'unreadable', contradiction: true,
      reason: 'positions table shows EMPTY while ' + workingExits + ' working take-profit/stop-loss order(s) exist — those cannot exist without a position',
    };
  }
  if (walkNet > 0) {
    return {
      state: 'unreadable', contradiction: true,
      reason: 'positions table shows EMPTY while the filled-order walk nets ' + walkNet + ' contract(s) — the order history says a position is open',
    };
  }
  if (openPnl > 0.005) {
    return {
      state: 'suspect', contradiction: false,
      reason: 'positions table shows EMPTY while the account reports ' + openPnl.toFixed(2) + ' open P&L — worth one forced re-render before believing flat',
    };
  }
  return { state: 'flat', contradiction: false, reason: 'no position rows and no evidence of one' };
}

module.exports = { classify };
