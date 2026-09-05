'use strict';
function strictNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}
function headroomState(input) {
  const o = input || {};
  const balance = strictNumber(o.balance);
  const floor = strictNumber(o.floor);
  const rules = o.rules || {};
  const dg = rules.drawdownGuard || {};
  const reduceAt = strictNumber(dg.reduceAt) != null ? strictNumber(dg.reduceAt) : 500;
  const standDownAt = strictNumber(dg.standDownAt) != null ? strictNumber(dg.standDownAt) : 250;
  const sizeCap = strictNumber(rules.sizeCap) != null ? strictNumber(rules.sizeCap) : 2;
  if (balance == null || floor == null) {
    return { level: null, headroom: null, effectiveCap: sizeCap, tradingAllowed: null, reason: 'balance or floor unreadable' };
  }
  const headroom = balance - floor;
  if (headroom <= standDownAt) return { level: 'stand-down', headroom, effectiveCap: 0, tradingAllowed: false, reason: 'headroom ' + headroom.toFixed(0) + ' <= stand-down ' + standDownAt };
  if (headroom <= reduceAt) return { level: 'reduce', headroom, effectiveCap: Math.max(1, Math.floor(sizeCap / 2)), tradingAllowed: true, reason: 'headroom ' + headroom.toFixed(0) + ' <= reduce ' + reduceAt };
  return { level: 'normal', headroom, effectiveCap: sizeCap, tradingAllowed: true, reason: 'normal' };
}
module.exports = { headroomState, strictNumber };
