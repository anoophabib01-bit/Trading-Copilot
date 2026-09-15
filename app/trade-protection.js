'use strict';
/**
 * trade-protection.js - turn Anoop's DOLLAR rule into broker prices.
 *
 * WHY (2026-09-15, his words): attach protection of 200 dollars per trade as a stop
 * and target 600. The rule is expressed in dollars because that is how he thinks about
 * risk; a broker needs PRICES. The conversion needs the point value of the instrument,
 * and this project has been bitten by exactly that before - MGC is $10/point and MNQ
 * $2/point - so the point value comes from rules.json's contracts block by symbol
 * (G10) and an unknown symbol REFUSES rather than guessing.
 *
 * Direction matters and is easy to get backwards: a LONG stop sits BELOW entry and its
 * target ABOVE; a SHORT is the mirror. Getting that wrong places a stop that triggers
 * instantly at a profit and a target that never fills.
 *
 * Pure, dual-export (module.exports for node --test, window.* for the browser).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.TradeProtection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Price distance for a dollar amount at a given size and point value. */
  function pointsForUsd(usd, qty, pointValue) {
    const q = Number(qty); const pv = Number(pointValue); const d = Number(usd);
    if (!Number.isFinite(q) || q <= 0) throw new Error('qty must be a positive number, got: ' + qty);
    if (!Number.isFinite(pv) || pv <= 0) throw new Error('pointValue must be a positive number, got: ' + pointValue);
    if (!Number.isFinite(d) || d <= 0) throw new Error('usd must be a positive number, got: ' + usd);
    return d / (pv * q);
  }

  /**
   * @param {{side:'buy'|'sell', qty:number, entryPrice:number, pointValue:number,
   *          stopLossUsd:number, takeProfitUsd:number, tickSize?:number}} input
   */
  function bracketFor(input) {
    const i = input || {};
    const side = String(i.side || '').toLowerCase();
    if (side !== 'buy' && side !== 'sell') throw new Error('side must be "buy" or "sell", got: ' + i.side);
    const entry = Number(i.entryPrice);
    if (!Number.isFinite(entry) || entry <= 0) throw new Error('entryPrice must be a positive number, got: ' + i.entryPrice);
    const qty = Number(i.qty);
    const stopPoints = pointsForUsd(i.stopLossUsd, qty, i.pointValue);
    const targetPoints = pointsForUsd(i.takeProfitUsd, qty, i.pointValue);
    const tick = Number(i.tickSize) > 0 ? Number(i.tickSize) : null;
    const round = (p) => (tick ? Math.round(p / tick) * tick : p);
    const long = side === 'buy';
    const stopPrice = round(long ? entry - stopPoints : entry + stopPoints);
    const targetPrice = round(long ? entry + targetPoints : entry - targetPoints);
    return { side, qty, stopPrice, targetPrice, stopPoints, targetPoints,
             riskUsd: Number(i.stopLossUsd), rewardUsd: Number(i.takeProfitUsd),
             ratio: Number(i.takeProfitUsd) / Number(i.stopLossUsd) };
  }

  /** Point value for a symbol from the rules contracts block. Refuses when unknown. */
  /**
   * Contract spec for a symbol from rules.json's contracts block, which is an OBJECT
   * MAP keyed by instrument ({"MNQ": {pointValue: 2, tickSize: 0.25}, "MGC": {...}})
   * - NOT an array. An array shape is still accepted defensively, because a rules file
   * from another era may carry it that way and guessing wrong here is a silent 5x error
   * on gold. Refuses on an unknown symbol rather than assuming MNQ.
   */
  function specForSymbol(rules, symbol) {
    const want = String(symbol || '').toUpperCase();
    if (!want) throw new Error('symbol is required');
    const c = (rules && rules.contracts) || {};
    let hit = null;
    if (Array.isArray(c)) {
      hit = c.find((row) => {
        const s = String((row && row.symbol) || '').toUpperCase();
        return s && (s === want || want.indexOf(s) === 0);
      }) || null;
    } else {
      hit = c[want] || null;
      if (!hit) {
        const key = Object.keys(c).find((k) => want.indexOf(String(k).toUpperCase()) === 0);
        if (key) hit = c[key];
      }
    }
    if (!hit || !(Number(hit.pointValue) > 0)) {
      throw new Error('no verified point value for ' + symbol + ' in rules.json contracts - refusing to guess');
    }
    return { symbol: want, pointValue: Number(hit.pointValue), tickSize: Number(hit.tickSize) > 0 ? Number(hit.tickSize) : null };
  }

  function pointValueForSymbol(rules, symbol) {
    return specForSymbol(rules, symbol).pointValue;
  }

  return { bracketFor, pointsForUsd, pointValueForSymbol, specForSymbol };
});