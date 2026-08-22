'use strict';
// ── Hour-of-day edge table (LIVE_FEED_LOOP_PLAN.md task 6.2) ───────────────
// Reporting only — plan decision 6 forbids hour weighting or hour-based
// blocking; this turns the "which hours actually pay" assumption into what
// the last days' rows say. Built from day_trades rows (entry time t + pnl).
// Pure; server.js persists the result to DATA_DIR/hour-edge.json weekly and
// annotates signal-ledger rows with the current hour's bucket.
function buildHourEdge(days) {
  const buckets = {};
  for (const day of Array.isArray(days) ? days : []) {
    const rows = (day && Array.isArray(day.rows)) ? day.rows : [];
    for (const r of rows) {
      if (!r || typeof r.t !== 'number' || typeof r.pnl !== 'number') continue;
      const istMin = Math.floor((r.t + 5.5 * 3600000) % 86400000 / 60000);
      const h = Math.floor(istMin / 60);
      const b = buckets[h] || (buckets[h] = { hour: h, n: 0, wins: 0, losses: 0, net: 0 });
      b.n++;
      if (r.pnl > 0) b.wins++;
      else if (r.pnl < 0) b.losses++;
      b.net += r.pnl;
    }
  }
  Object.keys(buckets).forEach(h => {
    const b = buckets[h];
    b.winPct = b.n ? Math.round(b.wins / b.n * 100) : null;
    b.net = Math.round(b.net * 100) / 100;
  });
  return buckets;
}

module.exports = { buildHourEdge };
