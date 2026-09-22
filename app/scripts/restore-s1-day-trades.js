'use strict';
/**
 * restore-s1-day-trades.js — one-shot recovery, 2026-09-03.
 *
 * WHAT HAPPENED
 * On 2026-09-03 ~20:53 IST, DATA/accounts/s1/day_trades.json was found holding
 * a BYTE-IDENTICAL COPY of s2's rows (2026-08-31 .. 2026-09-03). s1's own
 * August rows were gone. It was noticed because three week-store REPLAY tests,
 * which assert against the real files, went from passing to reporting 0 trades
 * for 2026-W35.
 *
 * The clobber happened during a server restart while a fresh browser window
 * opened against the app. The exact writer was NOT identified — mirrorSlotDataToDisk
 * in renderer/app.js explicitly excludes day_trades/gr_history/balance_ledger
 * for precisely this class of bug, and the server's own writes key off
 * loadConfig().activeSlotId, which reads s2 both before and after. So this
 * script FIXES THE DATA; it does not fix the cause, which is still open.
 *
 * WHAT IS RECOVERABLE, AND HOW IT WAS VERIFIED
 * Two independent records survived the clobber and agree with each other:
 *   1. DATA/accounts/s1/day_trades.json.bak-pre-size0-test (2026-08-28 19:52),
 *      real app-written rows with full prices.
 *   2. DATA/pattern_memory/episodes.jsonl, built from the LIVE file minutes
 *      before the clobber, carrying per-trade index/size/pnl.
 * They match exactly for 2026-08-26 (13 rows) and 2026-08-27 (9 rows). For
 * 2026-08-28 the backup holds 11 rows and the ledger holds 6 — the backup
 * predates a dedupe pass — and the 6 are an exact P&L subset of the 11, so the
 * live rows are recoverable by selecting them.
 *
 * NOTHING IS FABRICATED. Every restored row is a real row from the backup
 * file. Days the ledger cannot vouch for are restored only when gr_history's
 * own trade count for that day agrees, and are reported either way.
 *
 * The September rows are REMOVED from s1: they are s2's, and leaving them
 * makes an account that stopped trading on 2026-08-28 look like it traded
 * through September.
 *
 *   node scripts/restore-s1-day-trades.js           # dry run
 *   node scripts/restore-s1-day-trades.js --write   # apply
 */

const fs = require('fs');
const path = require('path');
const patternStore = require('../pattern-memory-store');

const WRITE = process.argv.includes('--write');
// Renamed 2026-09-18. Anchor on app/server.js so a stray folder of the new
// name cannot point this recovery script at an empty directory.
const DATA = (function () {
  const path = require('path');
  const roots = ['G:\\Trading-CoPilot', 'G:\\MNQ-CoPilot'];
  for (let i = 0; i < roots.length; i++) {
    try { if (fs.existsSync(path.join(roots[i], 'app', 'server.js'))) return path.join(roots[i], 'DATA'); } catch (e) {}
  }
  return 'G:\\MNQ-CoPilot\\DATA';
})();
const SLOT_DIR = path.join(DATA, 'accounts', 's1');
const LIVE = path.join(SLOT_DIR, 'day_trades.json');
const BACKUP = path.join(SLOT_DIR, 'day_trades.json.bak-pre-size0-test');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const key = (r) => String(r.pnl);   // P&L is the join key the two records share

// ── One row the ledger could not vouch for, restored anyway ────────────────
// 2026-08-28, size 2, -$13, zero flags, grade A. The pattern ledger is built
// from lifetime-store's MERGED view, and lifetime-history.mergeTrades dedupes
// across slots and archives — this row did not survive that merge, so the
// ledger never saw it even though the live file had it.
//
// It is restored on the evidence of the test suite: week-rollup.test.js's
// REPLAY asserts 16 clean trades against the real file and passed at the start
// of the session that lost the data. Without this row the count is 15. The row
// itself is a real, untouched row from the backup file — nothing is invented,
// only its inclusion is decided here rather than by the ledger.
//
// It also marks a real limit of the pattern ledger: a trade lifetime-store
// dedupes away is invisible to it. Worth knowing before treating episode
// counts as an exact census of trades.
// DISABLED after verification: adding this row makes 2026-W35 count 50 trades
// where every other record says 49, so it belongs to a different day than it
// appears to, or the backup's copy is itself a duplicate. One unexplained
// clean trade is a smaller error than a wrong week, so the ledger-verified
// set stands and the gap is reported instead of guessed at.
const LEDGER_BLIND_SPOT = {};

function main() {
  const live = readJson(LIVE);
  const bak = readJson(BACKUP);
  const gr = readJson(path.join(SLOT_DIR, 'gr_history.json'));
  const grByDate = new Map(gr.map((r) => [r.date, r]));

  // Per-trade episodes recorded from the live file before the clobber.
  const ledger = patternStore.readLedger(DATA).filter((e) => e.tradeIndex != null);
  const ledgerByDate = new Map();
  ledger.forEach((e) => {
    if (!ledgerByDate.has(e.date)) ledgerByDate.set(e.date, new Map());
    ledgerByDate.get(e.date).set(e.tradeIndex, e);
  });

  const out = {};
  const report = [];

  Object.keys(bak).sort().forEach((date) => {
    const bakRows = bak[date] || [];
    const led = ledgerByDate.get(date);
    const grRow = grByDate.get(date);

    if (led && led.size) {
      const wanted = [...led.values()].sort((a, b) => a.tradeIndex - b.tradeIndex);
      if (wanted.length === bakRows.length) {
        out[date] = bakRows;
        report.push(`${date}: ${bakRows.length} row(s) restored — backup and pattern ledger agree exactly.`);
        return;
      }
      // Select the rows the ledger actually saw, by P&L, in ledger order. A
      // P&L that appears twice in the backup consumes one row per match, so a
      // genuine duplicate pair is never collapsed into one.
      const pool = new Map();
      bakRows.forEach((r) => {
        const k = key(r);
        if (!pool.has(k)) pool.set(k, []);
        pool.get(k).push(r);
      });
      const picked = [];
      const missed = [];
      wanted.forEach((e) => {
        const k = key(e);
        const bucket = pool.get(k);
        if (bucket && bucket.length) picked.push(bucket.shift());
        else missed.push(e.pnl);
      });
      if (missed.length) {
        report.push(`${date}: SKIPPED — ${missed.length} live trade(s) have no matching backup row (P&L ${missed.join(', ')}). Not restoring a partial day.`);
        return;
      }
      const extraKeys = LEDGER_BLIND_SPOT[date] || [];
      const extras = [];
      extraKeys.forEach((k) => {
        const bucket = pool.get(k);
        if (bucket && bucket.length) extras.push(bucket.shift());
      });
      // Keep the day in the backup's own order, so the restored rows sit in
      // the sequence they were actually traded.
      const all = bakRows.filter((r) => picked.indexOf(r) !== -1 || extras.indexOf(r) !== -1);
      out[date] = all;
      report.push(`${date}: ${all.length} of ${bakRows.length} backup row(s) restored — the ledger's exact subset (backup predates a dedupe)`
        + (extras.length ? `, plus ${extras.length} row the ledger was blind to (see LEDGER_BLIND_SPOT).` : '.'));
      return;
    }

    // No ledger coverage: fall back to gr_history's own trade count.
    if (grRow && Number(grRow.n) === bakRows.length) {
      out[date] = bakRows;
      report.push(`${date}: ${bakRows.length} row(s) restored — gr_history.n agrees (no ledger coverage).`);
    } else {
      report.push(`${date}: SKIPPED — backup has ${bakRows.length} row(s), gr_history says n=${grRow ? grRow.n : 'no row'}. Cannot verify; leaving it out.`);
    }
  });

  const dropped = Object.keys(live).filter((d) => !out[d]);
  console.log('=== RESTORE PLAN for DATA/accounts/s1/day_trades.json ===');
  report.forEach((l) => console.log('  ' + l));
  console.log('  REMOVED (these are s2\'s rows, wrong in s1): ' + (dropped.join(', ') || 'none'));
  console.log(`  Result: ${Object.keys(out).length} day(s), ${Object.values(out).reduce((s, r) => s + r.length, 0)} row(s).`);

  if (!WRITE) { console.log('\nDRY RUN — re-run with --write to apply.'); return; }

  const stamp = path.join(SLOT_DIR, 'day_trades.json.bak-clobbered-by-s2-20260903');
  fs.copyFileSync(LIVE, stamp);
  fs.writeFileSync(LIVE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\nWrote ${LIVE}`);
  console.log(`Previous (clobbered) contents preserved at ${stamp}`);
}

main();
