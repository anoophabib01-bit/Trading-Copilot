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

// ── Minimum sample before an hour's win% may be QUOTED ───────────────────────
// (2026-08-31 audit) buildHourEdge always recorded `n` correctly, but the
// consumer in server.js stamped only `winPct` onto every signal row and threw
// the sample size away. The result was 13 rows in DATA/signals carrying
// "hourEdge: 100" — a 100% win rate derived from ONE trade at 12:00 IST — with
// nothing on the row to say so. That is a confident number manufactured from an
// absence of data, sitting in the ledger the scorecard and the agents read.
//
// 5 is a floor for being worth showing AT ALL, not a claim of significance —
// even n=8 is thin for a win rate. Below it, `reliableWinPct` returns null so
// the annotation is absent rather than wrong; `n` is always carried alongside
// so a reader can judge the rest.
const MIN_SAMPLE = 5;

/**
 * The hour's win% only when there is enough of a sample to quote it.
 * Returns null below MIN_SAMPLE — never a number the caller might round-trip
 * into looking authoritative.
 */
function reliableWinPct(bucket, minSample) {
  const min = typeof minSample === 'number' ? minSample : MIN_SAMPLE;
  if (!bucket || typeof bucket.n !== 'number' || bucket.n < min) return null;
  return typeof bucket.winPct === 'number' ? bucket.winPct : null;
}

module.exports = { buildHourEdge, reliableWinPct, MIN_SAMPLE };
