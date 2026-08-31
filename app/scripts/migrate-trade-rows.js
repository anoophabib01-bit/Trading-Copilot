#!/usr/bin/env node
'use strict';
// ── Trade-row migration (2026-08-28) ───────────────────────────────────────
// Anoop, after the app showed three rows and a count of two for a day he took
// ONE trade on:
//   "if i take 2 or more entries and exit all at one price then it is
//    considered as one trade" — a FLAT-TO-FLAT definition
//   "all the trades which are considered as breakeven should also be seen"
//
// ── WHAT IS WRONG WITH THE STORE ───────────────────────────────────────────
// Two independent writers both record the same trade:
//   • the ORDER-WALK  — pairs fills, writes GROSS P&L, carries side/ep/xp
//   • the BALANCE FOLD — closes at flat, writes NET P&L, carries no prices
// The day-record's fingerprint (t|x|pnl|size) cannot dedupe them because both
// the timestamps and the P&L legitimately differ between the two paths.
//
// Consequence: six days hold pure GROSS, one holds pure NET, and three hold
// BOTH MIXED TOGETHER. Any sum over the store is meaningless, and a scale-in
// exited in one go is counted as several trades instead of one.
//
// ── WHY THE FOLD WINS ──────────────────────────────────────────────────────
// Not a preference — it is the only one that matches Anoop's own definition.
// The fold closes a trade when the position reaches flat, so two entries and
// one exit is ONE trade. The walk pairs fills, so the same sequence is two.
// The fold's P&L is also already net, because a balance delta is inherently
// after commission.
//
// So: the fold owns identity and P&L; the walk contributes only the fields the
// fold cannot know (side, entry price, exit price).
//
// ── SAFETY ─────────────────────────────────────────────────────────────────
// DRY RUN BY DEFAULT. --apply is required to write, and it backs up first.
// Pairing is deliberately conservative: a walk row is only merged into a fold
// row when the match is unambiguous. Anything uncertain is LEFT ALONE and
// reported, because silently guessing which of two rows was the real trade is
// exactly how a P&L record stops being trustworthy.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
const COMM_PER_SIDE = RULES.commissionPerContractPerSide;      // 0.95
const COMM_ROUND_TURN = COMM_PER_SIDE * 2;                     // 1.90 per contract
const PAIR_WINDOW_MS = 15 * 60 * 1000;   // a fold detects flat AFTER the exit; 15 min is generous

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SLOT = (args.find((a) => a.startsWith('--slot=')) || '--slot=s1').split('=')[1];

const dtPath = path.join(ROOT, 'DATA', 'accounts', SLOT, 'day_trades.json');
const ledPath = path.join(ROOT, 'DATA', 'accounts', SLOT, 'balance_ledger.json');

const isWalk = (r) => !!(r && r.side);          // order-walk rows carry side + prices
const isFold = (r) => !(r && r.side);
const money = (v) => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);

function classifyDay(rows) {
  const walk = rows.filter(isWalk), fold = rows.filter(isFold);
  if (walk.length && fold.length) return 'mixed';
  if (walk.length) return 'all-gross';
  if (fold.length) return 'all-net';
  return 'empty';
}

// Pair a walk row to a fold row. Same size, and the fold's stamp falls at or
// after the walk's exit inside the window. Returns null unless EXACTLY ONE
// candidate matches — ambiguity is reported, never resolved by guessing.
function findPair(walkRow, foldRows, usedFold) {
  const cands = foldRows.filter((f, i) => {
    if (usedFold.has(i)) return false;
    if (Math.abs(Number(f.size) || 0) !== Math.abs(Number(walkRow.size) || 0)) return false;
    const dt = (f.t || 0) - (walkRow.x || walkRow.t || 0);
    return dt >= -60000 && dt <= PAIR_WINDOW_MS;   // small negative tolerance for clock skew
  });
  if (cands.length !== 1) return { row: null, ambiguous: cands.length > 1, candidates: cands.length };
  return { row: cands[0], index: foldRows.indexOf(cands[0]), ambiguous: false, candidates: 1 };
}

// ── THE MODEL, CORRECTED AFTER THE FIRST DRY RUN (2026-08-28) ─────────────
// My first attempt assumed the FOLD was the trade record and the walk was a
// duplicate. The dry run disproved it: on 2026-08-27 the nine walk rows,
// converted from gross to net, summed to -$55.60 — the EXACT total of that
// day's two fold rows. On 2026-08-28 the single walk row's own prices
// (SHORT 29611 -> 29609.5, 1 lot = $3.00 gross) net to $1.10, again exactly
// the fold's figure.
//
// So it is the other way round: the WALK rows are the real trades and the
// FOLD rows are a redundant, balance-derived shadow of the same trading. The
// walk rows also already satisfy Anoop's definition — a size-8 row with an
// averaged entry of 29549.44 (not a 0.25 tick multiple) is several entries
// aggregated into one flat-to-flat trade, which is exactly "2 or more entries
// exited at one price is one trade".
//
// Therefore: keep the walk rows, recompute their gross FROM THEIR OWN PRICES
// (several carry a stale stored P&L — 2026-08-28's said $0.00 when its prices
// said $3.00), convert to net, and drop the fold shadow ONLY on days where the
// two reconcile. A day that does not reconcile is left untouched and flagged,
// because picking a winner there would be guessing at real money.
const PV = 2.0;                      // MNQ $/point — verified, point-value-verify.js
const RECONCILE_TOL = 1.00;          // cents-level rounding on averaged fill prices

function grossFromPrices(r) {
  const ep = Number(r.ep), xp = Number(r.xp), sz = Math.abs(Number(r.size) || 0);
  if (!Number.isFinite(ep) || !Number.isFinite(xp) || !sz) return null;
  const dir = String(r.side || '').toUpperCase() === 'LONG' ? 1 : -1;
  return Math.round((xp - ep) * dir * sz * PV * 100) / 100;
}

function migrate() {
  const dt = JSON.parse(fs.readFileSync(dtPath, 'utf8'));
  const led = JSON.parse(fs.readFileSync(ledPath, 'utf8'));
  const out = {};
  const report = [];

  for (const day of Object.keys(dt).sort()) {
    const rows = (dt[day] || []).slice();
    const walk = rows.filter(isWalk);
    const fold = rows.filter(isFold);
    const before = rows.reduce((a, r) => a + (Number(r.pnl) || 0), 0);
    const contracts = rows.reduce((a, r) => a + Math.abs(Number(r.size) || 0), 0);
    const entry = { day, rowsBefore: rows.length, netBefore: before, actions: [], warnings: [] };

    if (!walk.length) {
      // Fold-only day: the fold IS the only record. Already net.
      entry.kind = 'fold-only';
      out[day] = rows.map((r) => Object.assign({}, r, { pnlBasis: 'net' }));
      entry.actions.push('fold is the only record — kept as net, untouched');
    } else {
      // Walk rows are the trades. Recompute gross from prices, then net.
      const walkContracts = walk.reduce((a, r) => a + Math.abs(Number(r.size) || 0), 0);
      let recomputed = 0, repriced = 0, noPrices = 0;
      const netted = walk.map((r) => {
        const g = grossFromPrices(r);
        const sz = Math.abs(Number(r.size) || 0);
        const gross = g == null ? (Number(r.pnl) || 0) : g;
        if (g == null) noPrices++;
        else if (Math.abs(g - (Number(r.pnl) || 0)) > 0.01) repriced++;
        recomputed += gross;
        return Object.assign({}, r, {
          pnl: Math.round((gross - sz * COMM_ROUND_TURN) * 100) / 100,
          grossPnl: gross,
          pnlBasis: 'net',
          migrated: '2026-08-28 gross(from prices)->net',
        });
      });
      const walkNet = Math.round((recomputed - walkContracts * COMM_ROUND_TURN) * 100) / 100;
      const foldNet = Math.round(fold.reduce((a, r) => a + (Number(r.pnl) || 0), 0) * 100) / 100;

      if (!fold.length) {
        entry.kind = 'walk-only';
        out[day] = netted;
        entry.actions.push(`${walk.length} trades, gross ${money(recomputed)} - ${walkContracts} contracts commission = ${money(walkNet)}`);
      } else if (Math.abs(walkNet - foldNet) <= RECONCILE_TOL) {
        entry.kind = 'reconciled';
        out[day] = netted;
        entry.actions.push(`walk nets to ${money(walkNet)}, fold shadow says ${money(foldNet)} — RECONCILED (${money(walkNet - foldNet)} apart)`);
        entry.actions.push(`dropped ${fold.length} redundant fold row(s)`);
      } else {
        entry.kind = 'UNRECONCILED';
        out[day] = rows.slice();   // LEAVE UNTOUCHED
        entry.warnings.push(`walk nets to ${money(walkNet)} but the fold shadow says ${money(foldNet)} — ${money(Math.abs(walkNet - foldNet))} apart, over the ${money(RECONCILE_TOL)} tolerance`);
        entry.warnings.push('LEFT UNTOUCHED — resolving this needs the broker export, not a guess');
      }
      if (repriced) entry.actions.push(`${repriced} row(s) had a stale stored P&L, recomputed from their own fill prices`);
      if (noPrices) entry.warnings.push(`${noPrices} walk row(s) had no usable prices — stored P&L used as gross`);
    }

    entry.rowsAfter = out[day].length;
    entry.netAfter = out[day].reduce((a, r) => a + (Number(r.pnl) || 0), 0);
    entry.ledgerNet = led[day] ? led[day].net : null;
    report.push(entry);
  }

  return { out, report };
}

function main() {
  const { out, report } = migrate();

  console.log('═'.repeat(88));
  console.log(` TRADE-ROW MIGRATION — ${APPLY ? 'APPLYING' : 'DRY RUN (no writes)'}   slot ${SLOT}`);
  console.log(` One row per trade · flat-to-flat · NET P&L · commission $${COMM_ROUND_TURN}/contract round turn`);
  console.log('═'.repeat(88));
  console.log();
  console.log('%-12s %-10s %6s %6s %11s %11s %11s'.replace(/%-?(\d+)s/g, (m, n) => '%s') === '' ? '' : '');
  console.log('  day          kind        rows        net P&L');
  console.log('  ' + '─'.repeat(84));

  let netBefore = 0, netAfter = 0, rowsBefore = 0, rowsAfter = 0;
  for (const e of report) {
    netBefore += e.netBefore; netAfter += e.netAfter;
    rowsBefore += e.rowsBefore; rowsAfter += e.rowsAfter;
    const arrow = e.rowsBefore === e.rowsAfter ? `${e.rowsBefore}` : `${e.rowsBefore} -> ${e.rowsAfter}`;
    console.log(`  ${e.day}   ${e.kind.padEnd(10)} ${arrow.padEnd(9)} ${money(e.netBefore).padStart(10)} -> ${money(e.netAfter).padStart(10)}`);
    for (const a of e.actions) console.log(`                 · ${a}`);
    for (const w of e.warnings) console.log(`                 ⚠ ${w}`);
  }

  console.log('  ' + '─'.repeat(84));
  console.log(`  TOTAL        rows ${rowsBefore} -> ${rowsAfter}        net ${money(netBefore)} -> ${money(netAfter)}`);
  console.log();

  // ── The only check that is not circular: the broker's own balance ────────
  const BROKER = Number(process.env.BROKER_BALANCE || 51179.90);
  console.log('  ── Reconciliation against the BROKER (the only non-circular check) ──');
  console.log(`  broker balance now                 ${money(BROKER)}`);
  console.log(`  corrected total net across all days ${money(netAfter)}`);
  console.log(`  => implied TRUE start balance       ${money(BROKER - netAfter)}`);
  console.log(`  current configured startBalance     ${money(50378.60)}`);
  const drift = (BROKER - netAfter) - 50378.60;
  console.log(`  ${Math.abs(drift) < 0.01 ? 'MATCHES — no further change needed' : 'startBalance must move by ' + money(drift) + ' after this migration'}`);
  console.log();

  if (!APPLY) {
    console.log('  DRY RUN — nothing written. Re-run with --apply to commit (a backup is taken first).');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(dtPath, dtPath + '.bak-pre-migration-' + stamp);
  fs.writeFileSync(dtPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`  WRITTEN. Backup: ${path.basename(dtPath)}.bak-pre-migration-${stamp}`);
}

main();
