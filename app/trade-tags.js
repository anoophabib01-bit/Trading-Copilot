'use strict';
// F2.1 trade tagging — session, dayOfWeek, isReentry, afterLoss, tradeIndexOfDay.
// playbook and minutesFromSignal come from signal-join (pass them through).
// M3: the day boundary uses dayRollup.tradingDayKey (03:45 IST Globex rollover),
// NOT IST calendar midnight — the rest of the app rolls over at 03:45, and a
// trade at 01:00 IST belongs to the PREVIOUS trading day. tradeIndexOfDay is
// exactly where a second definition of "day" would first disagree.
const dayRollup = require('./renderer/day-rollup');
function toMs(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return null;
}
function classifySession(istMin, windows) {
  const london = (windows || []).find((w) => w.name === 'London');
  const ny = (windows || []).find((w) => w.name === 'NY');
  if (london && istMin >= london.startMin && istMin < london.endMin) return 'london';
  if (ny && istMin >= ny.startMin && istMin < ny.endMin) return 'ny-open';
  if (london && ny) {
    if (istMin < london.startMin) return 'asia';
    if (istMin >= london.endMin && istMin < ny.startMin) return 'lunch';
    if (istMin >= ny.endMin) return 'pm';
  }
  return 'off-hours';
}
function tagTrades(trades, opts) {
  const o = opts || {};
  const windows = o.sessionWindowsIST || [];
  const reentryMin = o.isReentryWindowMin != null ? o.isReentryWindowMin : 5;
  const out = [];
  let day = null, idxOfDay = 0, prev = null;
  for (const t of Array.isArray(trades) ? trades : []) {
    const entryAt = toMs(t.entryAt);
    const exitAt = toMs(t.exitAt);
    const istMin = entryAt != null ? Math.floor(((entryAt + 5.5 * 3600000) % 86400000) / 60000) : null;
    const thisDay = entryAt != null ? dayRollup.tradingDayKey(entryAt) : null;
    if (thisDay !== day) { day = thisDay; idxOfDay = 0; prev = null; }
    idxOfDay++;
    const dir = String(t.side || '').toLowerCase();
    const isReentry = !!(prev && prev.symbol === t.symbol && prev.dir === dir && entryAt != null && prev.exitAt != null && (entryAt - prev.exitAt) <= reentryMin * 60000);
    const afterLoss = prev ? (Number(prev.pnl) || 0) < 0 : false;
    out.push(Object.assign({}, t, {
      entryIstMin: istMin,
      session: istMin != null ? classifySession(istMin, windows) : null,
      // M3: dayOfWeek follows the TRADING day (same key tradeIndexOfDay groups by),
      // so a 02:00 IST trade is a Friday trade, not a Saturday one.
      dayOfWeek: thisDay != null ? new Date(thisDay + 'T00:00:00Z').getUTCDay() : null,
      isReentry,
      afterLoss,
      tradeIndexOfDay: idxOfDay,
    }));
    prev = { symbol: t.symbol, dir, exitAt, pnl: t.pnl };
  }
  return out;
}
module.exports = { tagTrades, classifySession };