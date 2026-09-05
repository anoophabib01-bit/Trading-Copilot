'use strict';
function strictNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}
function shouldStopOut(input) {
  const o = input || {};
  const size = strictNumber(o.size);
  const pnl = strictNumber(o.unrealisedUsd);
  const cap = strictNumber(o.perTradeMaxLoss);
  if (size === 0) return { stop: false, reason: 'no open position (size 0)' };
  if (pnl == null) return { stop: null, reason: 'unrealised P&L unreadable — cannot verify the per-trade cap (treat as blind, escalate loudly)' };
  if (cap == null || cap <= 0) return { stop: false, reason: 'no usable per-trade cap configured' };
  if (pnl <= -cap) return { stop: true, reason: 'unrealised $' + pnl.toFixed(2) + ' breaches the -$' + cap + ' per-trade cap' };
  return { stop: false, reason: 'unrealised $' + pnl.toFixed(2) + ' inside the -$' + cap + ' cap' };
}
module.exports = { shouldStopOut, strictNumber };
