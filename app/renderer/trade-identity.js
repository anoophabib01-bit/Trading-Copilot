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

  // Same rule day-rollup.js uses, duplicated deliberately: this file is loaded
  // standalone by the reconciliation report and must not depend on load order.
  // Both read `pnlBasis` first and fall back to the live writer's provenance
  // stamps, so they cannot disagree about what a row's pnl means.
  function pnlBasisOf(row) {
    if (!row) return 'gross';
    if (row.pnlBasis === 'net' || row.pnlBasis === 'gross') return row.pnlBasis;
    if (row.evidence === 'fold' || row.source === 'live-fold-only') return 'net';
    return 'gross';
  }

  // Used only when the two rows are on different bases AND the conversion
  // cannot be computed (no rate supplied, or size never observed). Wide enough
  // to absorb a round turn on a realistic position, deliberately: a missed
  // match costs one line in a reconcile report, a false duplicate silently
  // doubles contracts, gross, and the size-cap counts the guardrail enforces.
  const MIXED_BASIS_TOLERANCE = 60;

  // G26: whether a row's size is a BEST-EFFORT fold observation rather than a
  // verified fill count. The live fold's sizeSeenThisTrade is the largest
  // position it happened to observe between polls, so it can be a PARTIAL read
  // of a larger CSV fill (2026-09-09: the fold saw 1 lot, the CSV had 2). A
  // verified size — a CSV row, or the order walk's own fill count — is never a
  // wildcard. Shared by the CSV importer (isSameTrade) and the live-feed
  // self-heal (mergeTradeRow / missingFromDayRows) so the two surfaces cannot
  // disagree about what "not fully observed" means.
  function sizeIsBestEffort(row) {
    if (!row) return true;                             // unknown row → wildcard
    const s = Number(row.size);
    if (!Number.isFinite(s) || s === 0) return true;   // size 0 = never observed
    return row.pnlBasis === 'net'                       // live fold rows are net-basis
      || row.evidence === 'fold'
      || row.source === 'live-fold-only'
      || row.inferred === true
      || row.evidence === 'degraded';
  }

  function isSameTrade(csvRow, liveRow, opts) {
    const o = opts || {};
    const exitTol = typeof o.exitToleranceMs === 'number' ? o.exitToleranceMs : EXIT_TOLERANCE_MS;
    const pnlTol = typeof o.pnlTolerance === 'number' ? o.pnlTolerance : PNL_TOLERANCE;
    if (!csvRow || !liveRow) return false;
    if (Math.abs((Number(liveRow.x) || 0) - (Number(csvRow.x) || 0)) > exitTol) return false;
    // 2026-08-24: size 0 on the live side means "NOT OBSERVED" — the fold
    // never saw the position open (opened and closed between two 10s polls),
    // so it records 0 and flags the row inferred:true. It does NOT mean zero
    // contracts. Comparing it literally against the CSV's real size can never
    // match, so the same trade survived the merge TWICE: doubled contracts,
    // doubled gross, and doubled the size-cap / revenge counts the guardrail
    // enforces on. Caught by Anoop asking the right question before importing
    // rather than after. Treated as a wildcard here, exactly as a missing
    // `side` already is on the next line. Both sides known and different is
    // still a genuine mismatch and still rejected.
    const lSize = Number(liveRow.size) || 0;
    const cSize = Number(csvRow.size) || 0;
    // G26: reject a size mismatch ONLY when both sides are VERIFIED. A
    // best-effort size (size 0, or a fold row's partial read) is a wildcard —
    // see sizeIsBestEffort above.
    if (!sizeIsBestEffort(liveRow) && !sizeIsBestEffort(csvRow) && lSize !== cSize) return false;
    const ls = String(liveRow.side || '').toLowerCase();
    const cs = String(csvRow.side || '').toLowerCase();
    if (ls && cs && ls !== cs) return false; // a missing side on either side matches anything

    // 2026-08-26: COMPARE THE TWO P&Ls ON THE SAME BASIS.
    //
    // Anoop, after re-importing: "i want it to verify CSV and not copy trade
    // history. it should overlap excisiting with new information."
    //
    // It could not overlap, because the two numbers for ONE trade are not the
    // same number. A CSV row's pnl is GROSS; a live fold row's pnl is a
    // balance delta between two flats, which the broker has already taken its
    // commission out of. For a 2-lot trade at $0.95 a side that is a $3.80
    // gap — 380x the $0.01 tolerance — so a live-written trade could NEVER
    // match its own CSV row, and the importer added a second copy of every
    // one of them. That is the "overread" he saw.
    //
    // Normalising to gross needs the rate, which the caller has (rules.json)
    // and this file does not. Without it, fall back to a tolerance wide
    // enough to absorb a plausible round turn rather than silently
    // duplicating: a missed match costs one manual reconcile line, a false
    // duplicate corrupts contracts, gross, and the size-cap counts the
    // guardrail enforces on.
    const lNet = pnlBasisOf(liveRow) === 'net';
    const cNet = pnlBasisOf(csvRow) === 'net';
    let lPnl = Number(liveRow.pnl) || 0;
    let cPnl = Number(csvRow.pnl) || 0;
    let tol = pnlTol;
    if (lNet !== cNet) {
      const comm = Number(o.commPerContract);
      if (comm > 0) {
        // Size is the only thing that converts between the two bases. When it
        // was never observed (0) the conversion is not available, so widen
        // instead of guessing a contract count.
        const lc = Number(liveRow.size) || 0;
        const cc = Number(csvRow.size) || 0;
        const size = lc || cc;
        if (size > 0) {
          if (lNet) lPnl += size * comm * 2;
          if (cNet) cPnl += size * comm * 2;
        } else {
          tol = Math.max(tol, MIXED_BASIS_TOLERANCE);
        }
      } else {
        tol = Math.max(tol, MIXED_BASIS_TOLERANCE);
      }
    }
    return Math.abs(lPnl - cPnl) <= tol;
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
        // 2026-08-26: pnlBasis describes THIS ROW'S pnl VALUE, not where the
        // row came from, so it must never be inherited like provenance. The
        // merged row carries the INCOMING (CSV) pnl, so it carries the
        // incoming basis — gross. Back-filling 'net' from the live row it
        // replaced labelled a gross number as net, which would then have had
        // commission added back to it and inflated the day.
        row.pnlBasis = pnlBasisOf(r);
      }
      map.set(k, row);
    });
    return Array.from(map.values()).sort((a, b) => a.t - b.t);
  }

  return { isSameTrade, matchCsvToLive, mergeCsvIntoStored, pnlBasisOf, sizeIsBestEffort, EXIT_TOLERANCE_MS, PNL_TOLERANCE, MIXED_BASIS_TOLERANCE };
});
