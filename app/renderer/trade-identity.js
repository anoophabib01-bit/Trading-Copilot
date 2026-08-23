/* ── Trade identity for CSV↔live reconciliation (plan 4.5 landmine) ─────────
 * csvApply's merge key fp = t|x|round(pnl*100)|size dedupes correctly ONLY
 * when both sides come from the same CSV export. After 4.3 the live record
 * carries broker order timestamps in ms while the CSV's come from printed
 * strings — the same trade produces two fingerprints, and reconciling a
 * live-written day would silently DOUBLE every trade in it.
 *
 * Reconciliation must therefore match on TOLERANCE IDENTITY: same size,
 * compatible side, exit within ~60s, P&L within a cent. A tolerance match is
 * THE SAME TRADE (compared, never re-added); everything else is a genuine
 * difference to report. Pure, UMD (browser + Node), unit-tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TradeIdentity = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EXIT_TOLERANCE_MS = 60 * 1000;
  const PNL_TOLERANCE = 0.01;

  function isSameTrade(csvRow, liveRow, opts) {
    const o = opts || {};
    const exitTol = typeof o.exitToleranceMs === 'number' ? o.exitToleranceMs : EXIT_TOLERANCE_MS;
    const pnlTol = typeof o.pnlTolerance === 'number' ? o.pnlTolerance : PNL_TOLERANCE;
    if (!csvRow || !liveRow) return false;
    if (Math.abs((Number(liveRow.x) || 0) - (Number(csvRow.x) || 0)) > exitTol) return false;
    if (Number(liveRow.size) !== Number(csvRow.size)) return false;
    const ls = String(liveRow.side || '').toLowerCase();
    const cs = String(csvRow.side || '').toLowerCase();
    if (ls && cs && ls !== cs) return false; // a missing side on either side matches anything
    return Math.abs((Number(liveRow.pnl) || 0) - (Number(csvRow.pnl) || 0)) <= pnlTol;
  }

  // Greedy one-to-one match. Returns { matched, csvOnly, liveOnly } —
  // matched[i] = { csvRow, liveRow, pnlDelta } for comparison/reporting.
  function matchCsvToLive(csvRows, liveRows, opts) {
    const csv = Array.isArray(csvRows) ? csvRows : [];
    const live = Array.isArray(liveRows) ? liveRows : [];
    const used = new Set();
    const matched = [];
    const csvOnly = [];
    for (const c of csv) {
      let hit = -1;
      for (let i = 0; i < live.length; i++) {
        if (used.has(i)) continue;
        if (isSameTrade(c, live[i], opts)) { hit = i; break; }
      }
      if (hit >= 0) {
        used.add(hit);
        matched.push({ csvRow: c, liveRow: live[hit], pnlDelta: (Number(c.pnl) || 0) - (Number(live[hit].pnl) || 0) });
      } else {
        csvOnly.push(c);
      }
    }
    const liveOnly = live.filter((_, i) => !used.has(i));
    return { matched, csvOnly, liveOnly };
  }

  // ── The APPLY side of the landmine (4.5 audit fix) ────────────────────────
  // matchCsvToLive above only powers the REPORT. csvApply — the thing the
  // "Apply to app" button actually runs — merged by csvApply's fp()
  // fingerprint alone (t|x|round(pnl*100)|size), which is exactly the key the
  // header of this file says cannot be trusted across the two sources. So on
  // any day the live feed had already written, confirming the reconciliation
  // ADDED a second copy of every trade: doubled contracts, doubled gross,
  // doubled the size-cap and revenge counts the guardrail reads.
  //
  // mergeCsvIntoStored does the merge the way the report already compares:
  // an incoming CSV row that is the SAME TRADE as a stored row (tolerance
  // identity, one-to-one) REPLACES that row in place; anything unmatched is
  // added; stored rows the file doesn't have are kept, never deleted. The
  // CSV's own fingerprint still short-circuits the scan, so re-uploading the
  // same file over a CSV-written day behaves exactly as it always did.
  //
  // Live-only provenance (evidence/source/signalBacked/playbook/
  // minutesFromSignal) and any field the CSV leaves null survive onto the
  // merged row — the plan requires provenance to survive a write, and a
  // reconciliation is a write.
  const PROVENANCE_KEYS = ['evidence', 'source', 'signalBacked', 'playbook', 'minutesFromSignal'];

  function mergeCsvIntoStored(storedRows, incomingRows, fp, opts) {
    const stored = Array.isArray(storedRows) ? storedRows : [];
    const incoming = Array.isArray(incomingRows) ? incomingRows : [];
    const key = typeof fp === 'function'
      ? fp
      : (r => r.t + '|' + r.x + '|' + Math.round(r.pnl * 100) + '|' + r.size);
    const map = new Map();
    stored.forEach(r => map.set(key(r), r));
    const claimed = new Set();
    incoming.forEach(r => {
      let k = key(r);
      if (!map.has(k)) {
        for (const [ek, ex] of map) {
          if (claimed.has(ek)) continue;
          if (isSameTrade(r, ex, opts)) { k = ek; break; }
        }
      }
      claimed.add(k);
      const prev = map.get(k);
      const row = Object.assign({}, r);
      if (prev) {
        PROVENANCE_KEYS.forEach(f => { if (row[f] == null && prev[f] != null) row[f] = prev[f]; });
        Object.keys(prev).forEach(f => { if (row[f] == null && prev[f] != null) row[f] = prev[f]; });
      }
      map.set(k, row);
    });
    return Array.from(map.values()).sort((a, b) => a.t - b.t);
  }

  return { isSameTrade, matchCsvToLive, mergeCsvIntoStored, EXIT_TOLERANCE_MS, PNL_TOLERANCE };
});
