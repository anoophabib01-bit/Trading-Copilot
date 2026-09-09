/* ── Day rollup (LIVE_FEED_LOOP_PLAN.md task 4.2) ──────────────────────────
 * Extracted from renderer/app.js's csvParseTrades + csvApply. These are the
 * computations that turn a day's trade rows into per-trade grades/flags and
 * the day summary (discipline %, gross/net, best/worst, hold/gap stats,
 * giveback, flips, consecutive losses, sizedUpIntoLoss, bigAfterWins).
 *
 * THEY MUST BE SHARED, NOT REIMPLEMENTED: the CSV path and the live-feed
 * writer (task 4.3) feed the same functions, or "discipline score" diverges
 * into two definitions — exactly the rules.json drift class CLAUDE.md warns
 * about. Byte-compatibility with the old inline code is the contract; every
 * rounding/ordering quirk is preserved on purpose (see the golden test note).
 *
 * UMD: loads as window.DayRollup in the browser (renderer/index.html) and as
 * a CommonJS module for server.js and the test suite.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DayRollup = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_WINDOWS = [
    { name: 'London', startMin: 810, endMin: 900 },
    { name: 'NY', startMin: 1140, endMin: 1260 }
  ];

  // Stored day_trades rows speak LONG/SHORT — that is the vocabulary every
  // consumer already reads (MAE/MFE's `t.side === 'LONG'`, rollupDay's flip
  // count, the reconciliation's side check, Jessi's trade lines). The live
  // feed speaks the broker's buy/sell, because that is what the order rows
  // say. Writing the broker's word straight into the row (4.3 originally
  // did) put 'BUY'/'SELL' beside every historical 'LONG'/'SHORT': MAE/MFE
  // silently read every live BUY as a short, and the 4.5 tolerance identity
  // — which rejects a side mismatch — could never match a live row against
  // its own CSV, re-opening the doubling landmine 4.5 exists to close.
  // Anything already in the row vocabulary passes through untouched;
  // anything unrecognised becomes null rather than a guess.
  function normalizeSide(side) {
    const s = String(side == null ? '' : side).trim().toUpperCase();
    if (s === 'LONG' || s === 'BUY') return 'LONG';
    if (s === 'SHORT' || s === 'SELL') return 'SHORT';
    return null;
  }

  // Trading-day key with the 03:45 IST Globex rollover anchor — the same
  // anchor csvParseTrades uses (a pre-rollover timestamp belongs to the
  // previous calendar day). Pure; the live writer (4.3) must use THIS.
  function tradingDayKey(ms, rolloverMin) {
    const roll = typeof rolloverMin === 'number' ? rolloverMin : 3 * 60 + 45;
    const ist = new Date(ms + 5.5 * 3600000);
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (mins < roll) ist.setUTCDate(ist.getUTCDate() - 1);
    return ist.toISOString().slice(0, 10);
  }

  function entryMinOf(tMs) {
    return Math.floor((tMs + 5.5 * 3600000) % 86400000 / 60000);
  }

  // Per-trade grading: revenge (cooldown), size cap, session window, scalper
  // hold — exactly the rules the old inline block applied. Returns a NEW
  // array (rows are not mutated) with pts/flags/g added.
  function gradeTrades(trades, rules) {
    const r = rules || {};
    const isScalper = (r.tradingMode || 'standard') === 'scalper';
    const cooldownLossOnly = isScalper && !!r.cooldownAfterLossOnly;
    const maxHold = isScalper ? (typeof r.maxHoldSeconds === 'number' ? r.maxHoldSeconds : 1800) : Infinity;
    const windows = (Array.isArray(r.sessionWindowsIST) && r.sessionWindowsIST.length) ? r.sessionWindowsIST : DEFAULT_WINDOWS;
    const sizeCap = typeof r.sizeCapCsv === 'number' ? r.sizeCapCsv : 2;
    const sorted = trades.slice().sort((a, b) => a.entryMs - b.entryMs);
    let prevLossExit = null;
    let prevExitMs = null;
    return sorted.map(t => {
      let revenge;
      if (cooldownLossOnly) {
        revenge = prevLossExit !== null && (t.entryMs - prevLossExit) / 60000 < 15 && (t.entryMs - prevLossExit) >= 0;
      } else {
        revenge = prevExitMs !== null && (t.entryMs - prevExitMs) / 60000 < 15 && (t.entryMs - prevExitMs) >= 0;
      }
      const emin = typeof t.entryMin === 'number' ? t.entryMin : entryMinOf(t.entryMs);
      const inWin = windows.some(w => emin >= w.startMin && emin < w.endMin);
      const flags = [];
      let pts = 0;
      if (t.size <= sizeCap) pts++; else flags.push('oversize');
      if (!revenge) pts++; else flags.push('revenge');
      if (inWin) pts++; else flags.push('out-of-window');
      if (isScalper) {
        if ((t.holdSec || 0) <= maxHold) pts++; else flags.push('hold-exceeded');
      } else {
        pts++; // news not knowable historically — assume clear
      }
      const g = ['D', 'D', 'C', 'B', 'A'][pts];
      prevExitMs = t.exitMs;
      if (t.pnl < 0) prevLossExit = t.exitMs;
      return Object.assign({}, t, { pts, flags, g });
    });
  }

  // The day summary — byte-compatible with the old csvApply computation.
  // rows: [{t, x, size, pnl, g, flags, side, ep, xp, mp, hold}] (the stored
  // day_trades row shape; grades already applied by gradeTrades).
  // ── What a row's `pnl` actually MEANS (2026-08-26) ──────────────────────
  // Anoop, after re-importing yesterday's CSV: "it overread again and
  // calculated wrong."
  //
  // Two writers fill this store and they disagree about `pnl`:
  //
  //   CSV import   pnl is GROSS. Commission is subtracted once, here, at day
  //                level (`gross - contracts * comm`).
  //   live fold    pnl is a BALANCE DELTA between two flats. The broker has
  //                ALREADY taken its commission out of that balance, so the
  //                number is NET before it ever reaches this file.
  //
  // Nothing marked which, so rollupDay applied the CSV rule to both and
  // charged commission a second time on every live-written day. 2026-08-25:
  // eleven live rows summing to a true net of $314.10 were reported as
  // $200.10 — $114.00 of commission deducted twice across 60 contracts.
  //
  // The same ambiguity is why a CSV row could never tolerance-match its own
  // live row (see trade-identity.js): the two numbers for one trade differ by
  // exactly the commission, which is orders of magnitude outside a $0.01
  // tolerance.
  //
  // Fixed by making the row say so. `pnlBasis: 'net'` is stamped by the live
  // writer; anything else is treated as gross. Rows written before this
  // existed are inferred from the provenance the live writer has always
  // stamped (evidence 'fold' / source 'live-fold-only'), so historical days
  // correct themselves without a migration.
  function pnlBasisOf(row) {
    if (!row) return 'gross';
    if (row.pnlBasis === 'net' || row.pnlBasis === 'gross') return row.pnlBasis;
    if (row.evidence === 'fold' || row.source === 'live-fold-only') return 'net';
    return 'gross';
  }

  // A row's gross P&L, whichever basis it was stored in. Adding the
  // commission back for a net row is the ONLY way a mixed day (some trades
  // imported, some live) can produce one coherent gross and one coherent net.
  function grossOf(row, commPerCt) {
    const pnl = Number(row && row.pnl) || 0;
    if (pnlBasisOf(row) !== 'net') return pnl;
    return pnl + (Number(row.size) || 0) * commPerCt;
  }

  function rollupDay(date, rows, opts) {
    const o = opts || {};
    const comm = typeof o.commPerCt === 'number' ? o.commPerCt : 1.0;
    const sizeCap = typeof o.sizeCapCsv === 'number' ? o.sizeCapCsv : 2;
    const tMode = o.tradingMode || 'standard';
    const day = rows.slice().sort((a, b) => a.t - b.t);

    // Normalise every row to gross FIRST, then take commission off once.
    const gross = day.reduce((a, t) => a + grossOf(t, comm), 0);
    const contracts = day.reduce((a, t) => a + t.size, 0);
    const net = Math.round((gross - contracts * comm) * 100) / 100;
    const maxSize = day.reduce((m, t) => Math.max(m, t.size), 0);
    const over = day.filter(t => t.size > sizeCap).length;
    const revenge = day.filter(t => (t.flags || []).indexOf('revenge') >= 0).length;
    const disc = Math.round(day.reduce((a, t) => a + (4 - (t.flags || []).length), 0) / (4 * day.length) * 100);
    const dd = new Date(date + 'T00:00:00');
    const dow = dd.getDay();
    // Per-trade extremes are quoted on the SAME basis as the day's gross, or
    // a live day's "best trade" would be net while an imported day's is
    // gross — two numbers that look comparable and are not.
    const pnls = day.map(t => grossOf(t, comm));
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const holds = day.map(t => t.hold || 0);
    const avgHold = Math.round(holds.reduce((a, b) => a + b, 0) / day.length);
    const medHold = holds.slice().sort((a, b) => a - b)[Math.floor(day.length / 2)];
    const gaps = [];
    for (let i = 1; i < day.length; i++) gaps.push((day[i].t - day[i - 1].x) / 1000);
    const avgGap = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
    const firstThreeMax = Math.max.apply(null, day.slice(0, 3).map(t => t.size));
    let runp = 0, prevSize = 0, sizedUpIntoLoss = false;
    day.forEach(t => { if (t.size > prevSize && runp < 0) sizedUpIntoLoss = true; prevSize = t.size; runp += grossOf(t, comm); });
    let wseq = 0, bigAfterWins = false;
    for (const t of day) {
      if (t.size === maxSize) { bigAfterWins = wseq >= 2; break; }
      if (t.pnl > 0) wseq++; else wseq = 0;
    }
    const under5 = holds.filter(hh => hh < 300).length;
    const over15 = holds.filter(hh => hh > 900).length;
    let gbRun = 0, gbPeak = 0;
    day.forEach(t => { gbRun += grossOf(t, comm); if (gbRun > gbPeak) gbPeak = gbRun; });
    const giveback = Math.round((gbPeak - gbRun) * 100) / 100;
    let flips = 0;
    for (let fi = 1; fi < day.length; fi++) {
      if (day[fi].side && day[fi - 1].side && day[fi].side !== day[fi - 1].side
          && (day[fi].t - day[fi - 1].x) / 60000 < 15) flips++;
    }
    let consec = 0, maxConsec = 0, tradedPast3Losses = false;
    day.forEach(t => {
      if (t.pnl < 0) { consec++; if (consec > maxConsec) maxConsec = consec; }
      else { if (consec >= 3) tradedPast3Losses = true; consec = 0; }
    });
    if (maxConsec >= 3 && day[day.length - 1].pnl >= 0) tradedPast3Losses = true;
    const holdExceeded = day.filter(t => (t.flags || []).indexOf('hold-exceeded') >= 0).length;

    // Field order matches the old sum object exactly — byte-compatibility.
    return {
      date: date, dow: dow, n: day.length, pnl: net, gross: gross,
      contracts: contracts, maxSize: maxSize, over: over, revenge: revenge,
      disc: disc, best: Math.max.apply(null, pnls), worst: Math.min.apply(null, pnls),
      avgWin: avgWin, avgLoss: avgLoss, avgHold: avgHold, medHold: medHold,
      avgGap: avgGap, firstThreeMax: firstThreeMax, sizedUpIntoLoss: sizedUpIntoLoss,
      bigAfterWins: bigAfterWins, under5: under5, over15: over15, wins: wins.length,
      losses: losses.length, peak: Math.round(gbPeak), giveback: giveback,
      flips: flips, maxConsecLoss: maxConsec, tradedPast3Losses: tradedPast3Losses,
      tradingMode: tMode, holdExceeded: holdExceeded,
      // G23: stamp the rate the day was computed under, so a later rate change can
      // never silently re-price a stored day. Commission is per-era, not global.
      commPerCt: comm
    };
  }

  return { gradeTrades, rollupDay, tradingDayKey, entryMinOf, normalizeSide, pnlBasisOf, grossOf, DEFAULT_WINDOWS };
});
