/* ── fold-only.js — "is this day a real trade record, or just a balance move?" ─
 *
 * (2026-08-31, after the day recap reported facts that never happened.)
 *
 * WHAT WENT WRONG, because this module only makes sense against it.
 * On 2026-08-31 TradingView's broker panel stopped re-rendering and the
 * order-history walk desynced from the positions panel at 19:25:49. The
 * round-trip scorer needs a confirmed FLAT to close a trade, so it scored
 * nothing (`closedRoundTripsScored: 0`) and the feed fell back to the
 * balance-delta fold: watch the account balance, and when it moves, write one
 * synthetic trade for the difference.
 *
 * That fallback is CORRECT and worth keeping — it is why the day's net P&L was
 * right to the cent (-$61.40 = -$31.00 gross - $30.40 commission on 16
 * contracts). The bug was downstream. A balance delta is ONE NUMBER: no entry,
 * no exit, no side, no hold, no count. Ten real round-trips over 19:25-19:42
 * became a single row stamped `source: 'live-fold-only'`, `side: null`,
 * `hold: 0` — and then the recap read that row as if it were a trade and
 * published "best trade $8 / worst -$52 / median hold 0s / 1 win 1 loss",
 * against a broker record of 10 trades, 6W/4L, +$30 best, -$59 worst, 9s median.
 * Jessi then coached on a "$-61 revenge re-entry" that never occurred.
 *
 * THE POINT. The flag was already on every row. Nothing checked it. So this is
 * one predicate, used by every consumer, and the rule it encodes is:
 *
 *   A fold-only day has a TRUSTWORTHY NET and NO TRADE DETAIL.
 *
 * Net P&L, and that the account moved, are real. Trade count, per-trade P&L,
 * best/worst, win/loss, hold times, sides and sizes are NOT — they are a
 * day-level number wearing a trade's shape. Consumers must show the net and
 * say the day is unreconciled, never compute statistics over these rows.
 *
 * This is the same discipline already used elsewhere in this repo: week-rollup
 * reports `disagreeDays` instead of picking a winner, armed-detectors refuses
 * free-form conditions, and the oversize guard refuses to act on an unreadable
 * size. Fold-only data is an unreadable size, for statistics.
 *
 * UMD like day-rollup.js — required by server.js AND loaded as a plain script
 * in the renderer, so one predicate serves both and cannot drift.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FoldOnly = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // Markers the feed itself writes. `source` is the explicit one; `evidence`
  // is checked too because tv-broker-feed has stamped both over time and a
  // consumer must not silently trust a row just because one field was renamed.
  function isFoldRow(t) {
    if (!t || typeof t !== 'object') return false;
    return t.source === 'live-fold-only' || t.evidence === 'fold';
  }

  /** A row carrying enough to be treated as a real trade. */
  function isRealTradeRow(t) {
    return !!t && typeof t === 'object' && !isFoldRow(t);
  }

  /**
   * Classify a day's trade rows.
   *
   * `foldOnly` is true only when there ARE rows and EVERY one is fold-derived.
   * An empty day is not fold-only — it is empty, which is a different and
   * honest state that must keep rendering as "no trades", never as "unreconciled".
   *
   * A MIXED day (some real, some fold) is also unreconciled: the real rows are
   * genuine but they do not account for the whole balance move, so any total
   * computed from them understates the day. `mixed` is reported separately so a
   * caller can say which of the two it is rather than flattening both into one
   * message.
   */
  function classify(trades) {
    const list = Array.isArray(trades) ? trades.filter(Boolean) : [];
    const fold = list.filter(isFoldRow);
    const real = list.filter(isRealTradeRow);
    const foldOnly = list.length > 0 && real.length === 0;
    const mixed = fold.length > 0 && real.length > 0;
    return {
      total: list.length,
      foldN: fold.length,
      realN: real.length,
      foldOnly,
      mixed,
      // The single question every consumer actually asks.
      unreconciled: foldOnly || mixed,
      // True when per-trade statistics are safe to compute and display.
      tradeDetailTrustworthy: list.length > 0 && fold.length === 0,
    };
  }

  /**
   * WHICH FIELDS SURVIVE A FOLD. (Refined 2026-09-02.)
   *
   * The first version of this module treated "fold-only" as "no per-trade
   * detail at all", and that was too blunt in a way that cost real
   * information: on 2026-09-01 the recap blanked BEST TRADE, WORST TRADE,
   * MAX SIZE and WIN/LOSS while still printing "median hold 0s" — four true
   * things hidden and one false thing published.
   *
   * A balance-delta fold watches the account go flat and records the move. So
   * it genuinely knows, per trade:
   *   MONEY  the P&L of each closed round trip (that IS the balance move)
   *   SIZE   how many contracts were on
   * and it genuinely cannot know:
   *   TIMING hold time, gaps — every fold row carries hold:0, which means
   *          UNKNOWN, not "zero seconds". Reading it as a duration produced
   *          "you exit winners too early" from a field that was never measured.
   *   PRICE  entry/exit prices — null on every fold row
   *   SIDE   long/short — null on every fold row
   *
   * Anything derivable from money+size (best, worst, maxSize, win/loss count)
   * is therefore REAL on a fold day and must be shown. Anything needing timing,
   * price or side must be suppressed. Callers should ask this rather than
   * branching on foldOnly directly.
   */
  function fieldTrust(trades) {
    const c = classify(trades);
    const clean = c.tradeDetailTrustworthy;
    return {
      money: c.total > 0,          // balance deltas are real even when folded
      size: c.total > 0,
      timing: clean,               // hold/gap: fold writes 0, meaning unknown
      price: clean,
      side: clean,
      unreconciled: c.unreconciled,
    };
  }
  /** Convenience: are ALL per-trade fields trustworthy? */
  function hasTradeDetail(trades) { return classify(trades).tradeDetailTrustworthy; }

  /**
   * One sentence explaining the state, for the UI and for Jessi's context.
   * Deliberately names the reason and the remedy — "unavailable" without a
   * cause reads as a bug rather than as a known, recoverable gap.
   */
  function explain(trades) {
    const c = classify(trades);
    if (!c.total) return null;
    if (c.foldOnly) {
      return 'Day not reconciled: the broker feed lost trade-level detail, so this day was '
        + 'reconstructed from account balance moves only. STILL ACCURATE: net and per-trade P&L, '
        + 'contract sizes, trade count, best/worst trade, win-loss. NOT AVAILABLE: entry and exit '
        + 'prices, long/short side, and hold times (every folded row carries hold 0, which means '
        + 'unknown, not zero seconds). Reconcile with a broker export to restore those.';
    }
    if (c.mixed) {
      return 'Day only partly reconciled: ' + c.realN + ' trade' + (c.realN === 1 ? '' : 's')
        + ' recorded normally and ' + c.foldN + ' balance-move row' + (c.foldN === 1 ? '' : 's')
        + ' the feed could not resolve into trades. Totals are right; per-trade detail is incomplete.';
    }
    return null;
  }

  return { isFoldRow, isRealTradeRow, classify, fieldTrust, hasTradeDetail, explain };
}));
