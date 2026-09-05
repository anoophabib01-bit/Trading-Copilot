'use strict';
// F1 trade forensics — per-trade MAE/MFE and the shared excursion kernel.
// Null discipline: a missing number is null with a reason, NEVER zero.
const pointValueVerify = require('./point-value-verify');
function dirSign(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'buy' || s === 'long' || s === 'bullish') return 1;
  if (s === 'sell' || s === 'short' || s === 'bearish') return -1;
  return 0;
}
function barTimeMs(b) {
  if (b && typeof b.time === 'number') return b.time * 1000;
  if (b && typeof b.t === 'number') return b.t;
  return null;
}
function barHigh(b) { return Number(b && (b.high != null ? b.high : b.h)); }
function barLow(b) { return Number(b && (b.low != null ? b.low : b.l)); }
function barClose(b) { return Number(b && (b.close != null ? b.close : b.c)); }
function excursion(bars, anchor, sign, fromMs, toMs) {
  let mfe = 0, mae = 0;
  for (const b of Array.isArray(bars) ? bars : []) {
    const t = barTimeMs(b);
    if (t == null) continue;
    if (fromMs != null && t < fromMs) continue;
    if (toMs != null && t > toMs) continue;
    const hi = barHigh(b), lo = barLow(b);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    const fav = sign === 1 ? hi - anchor : anchor - lo;
    const adv = sign === 1 ? anchor - lo : hi - anchor;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
  }
  return { mfe, mae };
}
function toMs(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return null;
}
function tradeForensics(trade, bars, opts) {
  const o = opts || {};
  const sign = dirSign(trade && trade.side);
  const ep = Number(trade && trade.ep);
  const entryAt = toMs(trade && trade.entryAt);
  const exitAt = toMs(trade && trade.exitAt);
  if (!sign || !Number.isFinite(ep) || entryAt == null || exitAt == null) {
    return { mae: null, mfe: null, edgeRatio: null, forensicsReason: 'missing side, entry price, or entry/exit timestamps' };
  }
  const covering = (Array.isArray(bars) ? bars : []).some((b) => {
    const t = barTimeMs(b);
    return t != null && t >= entryAt && t <= exitAt;
  });
  if (!covering) {
    return { mae: null, mfe: null, edgeRatio: null, forensicsReason: 'no bars cover the trade window', forensicsTf: o.tf || null };
  }
  const ex = excursion(bars, ep, sign, entryAt, exitAt);
  const pv = pointValueVerify.pointValueFor(trade.symbol);
  const size = Number(trade && trade.size) || 1;
  return {
    mae: ex.mae, mfe: ex.mfe,
    maeUsd: pv != null ? ex.mae * pv * size : null,
    mfeUsd: pv != null ? ex.mfe * pv * size : null,
    pointValue: pv,
    edgeRatio: ex.mae > 0 ? ex.mfe / ex.mae : null,
    forensicsTf: o.tf || null,
  };
}
function entryPctOfRange(ep, sessionHigh, sessionLow) {
  const hi = Number(sessionHigh), lo = Number(sessionLow), p = Number(ep);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || !Number.isFinite(p) || hi === lo) return null;
  return (p - lo) / (hi - lo);
}
function postExitMove(trade, bars) {
  const sign = dirSign(trade && trade.side);
  const xp = Number(trade && trade.xp);
  const exitAt = toMs(trade && trade.exitAt);
  if (!sign || !Number.isFinite(xp) || exitAt == null) return { post30Mfe: null, post30Mae: null, post30Close: null, post30LeftOnTable: null };
  const endMs = exitAt + 30 * 60 * 1000;
  // X1: refuse rather than approximate. No bar in [exitAt, exitAt+30min] → null,
  // never zero — an unarchived trade must NOT read as "you left nothing on the table".
  const covering = (Array.isArray(bars) ? bars : []).some((b) => { const t = barTimeMs(b); return t != null && t >= exitAt && t <= endMs; });
  if (!covering) return { post30Mfe: null, post30Mae: null, post30Close: null, post30LeftOnTable: null, post30Reason: 'no bars cover the post-exit window' };
  const ex = excursion(bars, xp, sign, exitAt, endMs);
  let close = null;
  for (const b of Array.isArray(bars) ? bars : []) {
    const t = barTimeMs(b);
    const c = barClose(b);
    if (t != null && Number.isFinite(c) && t >= exitAt && t <= endMs) close = c;
  }
  return { post30Mfe: ex.mfe, post30Mae: ex.mae, post30Close: close, post30LeftOnTable: ex.mfe };
}
// X6: write-time invariant. A WINNING trade cannot book more than its best
// excursion offered: mfe * pointValue * size >= pnl (within a tolerance for
// commission and bar granularity). A violation means the bars were wrong.
function assertWinnerInvariant(trade, forensics, pointValue) {
  const pnl = Number(trade && trade.pnl);
  if (!(pnl > 0)) return { valid: true };
  const mfe = forensics && Number(forensics.mfe);
  const pv = Number(pointValue);
  const size = Number(trade && trade.size) || 1;
  if (!Number.isFinite(mfe) || !Number.isFinite(pv)) return { valid: true }; // cannot check
  const ceiling = mfe * pv * size;
  const tolerance = 2 * pv * size + 5; // 2 points of granularity + $5 commission
  if (pnl > ceiling + tolerance) {
    return { valid: false, reason: 'winner pnl $' + pnl + ' exceeds mfe-implied ceiling $' + ceiling.toFixed(2) + ' (mfe ' + mfe + ' x pv ' + pv + ' x size ' + size + ')' };
  }
  return { valid: true };
}

module.exports = { excursion, tradeForensics, entryPctOfRange, postExitMove, dirSign, assertWinnerInvariant };