'use strict';
function filterPo3Transitions(events) {
  const out = [];
  const last = {};
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.event !== 'po3-phase-change') continue;
    const sym = e.symbol || '?';
    const phase = e.phase || e.to || e.direction || e.from || '?';
    if (last[sym] === phase) continue;
    last[sym] = phase;
    out.push(e);
  }
  return out;
}
module.exports = { filterPo3Transitions };
