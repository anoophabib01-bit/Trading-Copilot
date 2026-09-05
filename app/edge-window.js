'use strict';
function strictNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}
function edgeWindowVerdict(input) {
  const o = input || {};
  const istMinutes = strictNumber(o.istMinutes);
  const win = o.window || {};
  const start = strictNumber(win.start);
  const end = strictNumber(win.end);
  if (istMinutes == null || start == null || end == null) return { outsideEdge: false, reason: 'edge window not computable' };
  if (istMinutes >= start && istMinutes < end) return { outsideEdge: false, reason: 'inside edge window' };
  return { outsideEdge: true, reason: 'outside edge window (' + start + '-' + end + ' IST)' };
}
module.exports = { edgeWindowVerdict };
