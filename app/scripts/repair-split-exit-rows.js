#!/usr/bin/env node
'use strict';
// ── Repair day rows whose price came from ONE fill of a split exit ─────────
// (2026-09-03, with the analyzeOrderWalk VWAP fix.)
//
// WHY THIS IS NEEDED SEPARATELY FROM THE CODE FIX
// ---------------------------------------------------------------------------
// The walk now reports a volume-weighted exit price, so every FUTURE round
// trip is right. Rows already on disk are not: they carry the old single-fill
// price, and nothing re-derives them.
//   - enrichRowsFromWalk only fills rows that are MISSING a side/price; it
//     never second-guesses a row that already has one, which is correct
//     behaviour and also means it will not touch these.
//   - mergeTradeRow's "a row must not contradict its own prices" repair
//     recomputes P&L FROM the stored price, so it re-derives the same wrong
//     number every poll. That is the 683-warning self-heal loop.
//
// WHAT IT TRUSTS, AND WHY
// ---------------------------------------------------------------------------
// The fold's P&L is a BALANCE DELTA — it is the account itself, and it already
// includes whatever the exchange actually charged. The row's P&L is derived
// arithmetic. When the two disagree by more than commission, the balance is
// the one that cannot be wrong about how much money moved.
//
// So: keep the fold's P&L, and BACK-SOLVE the exit price it implies.
//     gross = pnl + size * commissionPerSide * 2
//     xp    = ep + gross / (size * pointValue * dir)
// On Anoop's 2026-09-03 trade that returns 29282.25 — which is independently
// exactly (29280.75*2 + 29283.75*2)/4 from his Tradovate statement. Two
// derivations, one answer; that agreement is the check that this is safe.
//
// DELIBERATELY CONSERVATIVE. It only touches a row where ALL of these hold:
//   - a fold trade matches it on size and flat-event timing
//   - the two P&L figures differ by more than commission (a real disagreement,
//     not the known gross-vs-net gap the matcher already handles)
//   - the row has ep, size, side and a known point value
//   - the back-solved price lands within a sane distance of the stored one
// Anything else is REPORTED and left alone. A row this cannot explain is a row
// a human should look at, not one a script should overwrite.
//
// Dry run by default. Requires --apply to write, and backs up first.
// THE APP MUST BE CLOSED: the server rewrites tv_broker_feed_state.json every
// 10s from memory and re-merges day rows on the same poll, so an edit made
// underneath a running server is clobbered within seconds.
//
// Usage:
//   node scripts/repair-split-exit-rows.js              # dry run, shows the diff
//   node scripts/repair-split-exit-rows.js --apply      # writes, after a backup

const fs = require('fs');
const path = require('path');

const tvFeed = require('../tv-broker-feed.js');
const dayRollup = require('../renderer/day-rollup.js');
const rules = require('../rules.json');
const { resolveDataDir } = require('../resolve-data-dir.js');

const APPLY = process.argv.includes('--apply');
const DAY = (process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))) || dayRollup.tradingDayKey(Date.now());
const COMM_SIDE = Number(rules.commissionPerContractPerSide);
const POINT = 2; // MNQ, verified 117/117 in scripts/verify-fold.js

const DATA_DIR = resolveDataDir().dir;
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };

function main() {
  console.log('='.repeat(78));
  console.log(' SPLIT-EXIT ROW REPAIR — trading day ' + DAY + (APPLY ? '   [APPLY]' : '   [dry run]'));
  console.log(' data dir: ' + DATA_DIR + '   commission/side: $' + COMM_SIDE);
  console.log('='.repeat(78));

  const foldState = readJson(path.join(DATA_DIR, 'tv_broker_feed_state.json'), {});
  const fold = (foldState.trades || []).filter(t => t && t.at != null && dayRollup.tradingDayKey(t.at) === DAY);
  if (!fold.length) { console.log('\nNo fold trades for ' + DAY + '. Nothing to reconcile against.'); return; }

  const accountsDir = path.join(DATA_DIR, 'accounts');
  let slots = [];
  try { slots = fs.readdirSync(accountsDir); } catch (e) { console.log('\nNo accounts directory.'); return; }

  let repaired = 0, flagged = 0;

  for (const slot of slots) {
    const file = path.join(accountsDir, slot, 'day_trades.json');
    if (!fs.existsSync(file)) continue;
    const store = readJson(file, null);
    if (!store || !Array.isArray(store[DAY]) || !store[DAY].length) continue;

    const rows = store[DAY];
    let changed = false;
    console.log('\n' + slot + ' — ' + rows.length + ' row(s)');

    rows.forEach((row, i) => {
      const size = Math.abs(Number(row.size) || 0);
      const ep = Number(row.ep);
      const side = String(row.side || '').toUpperCase();
      const rowExit = Number.isFinite(row.x) ? row.x : row.t;

      // Match a fold trade to this row on size + flat-event timing. Same shape
      // the live matcher uses; kept local so this script cannot be changed by
      // a future edit to that one without someone noticing here.
      const match = fold.find(t => Math.abs(Number(t.size) || 0) === size
        && Number.isFinite(t.at) && Number.isFinite(rowExit)
        && Math.abs(Number(t.at) - rowExit) <= 10 * 60 * 1000);

      const label = '  [' + i + '] ' + side + ' ' + size + 'c ' + ep + '->' + row.xp + '  row $' + Number(row.pnl).toFixed(2);
      if (!match) { console.log(label + '   (no fold trade to compare — left alone)'); return; }

      const gap = Math.abs(Number(row.pnl) - Number(match.pnl));
      const commGap = size * COMM_SIDE * 2;
      if (gap < 0.01 || Math.abs(gap - commGap) < 0.02) {
        console.log(label + '   fold $' + Number(match.pnl).toFixed(2) + '   ✓ agree');
        return;
      }

      // A real disagreement. Can it be explained as a split-exit price?
      if (!(size > 0) || !Number.isFinite(ep) || (side !== 'LONG' && side !== 'SHORT')) {
        console.log(label + '   fold $' + Number(match.pnl).toFixed(2) + '   ⚠ DISAGREES but row lacks ep/size/side — FLAGGED, not touched');
        flagged++; return;
      }
      const dir = side === 'LONG' ? 1 : -1;
      const gross = Number(match.pnl) + size * COMM_SIDE * 2;
      const xp = Math.round((ep + gross / (size * POINT * dir)) * 1e6) / 1e6;

      // Sanity: a back-solved price far from the stored one means the
      // disagreement is not a split-exit price at all.
      if (!Number.isFinite(xp) || Math.abs(xp - Number(row.xp)) > 500) {
        console.log(label + '   fold $' + Number(match.pnl).toFixed(2) + '   ⚠ back-solved price ' + xp + ' is implausible — FLAGGED, not touched');
        flagged++; return;
      }

      const mp = Math.round((side === 'LONG' ? xp - ep : ep - xp) * 100) / 100;
      console.log(label + '   fold $' + Number(match.pnl).toFixed(2));
      console.log('        REPAIR  xp ' + row.xp + ' -> ' + xp + '   pnl $' + Number(row.pnl).toFixed(2) + ' -> $' + Number(match.pnl).toFixed(2) + '   mp ' + row.mp + ' -> ' + mp);
      repaired++;
      if (APPLY) {
        row.xp = xp;
        row.pnl = Math.round(Number(match.pnl) * 100) / 100;
        row.mp = mp;
        row.pnlBasis = 'net';
        row.repaired = 'split-exit-vwap-2026-09-03';
        changed = true;
      }
    });

    if (APPLY && changed) {
      const bak = file + '.bak-split-exit-' + Date.now();
      fs.copyFileSync(file, bak);
      fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
      console.log('  written (backup: ' + path.basename(bak) + ')');
    }
  }

  // The fold's cached exitPrice came from the OLD walk too. Its P&L is the
  // balance delta and is correct, but leaving a wrong price in the state means
  // the next merge re-derives the wrong number from it all over again.
  const foldFixes = [];
  for (const t of fold) {
    const size = Math.abs(Number(t.size) || 0);
    const ep = Number(t.entryPrice);
    const side = String(t.side || '').toUpperCase();
    if (!(size > 0) || !Number.isFinite(ep) || (side !== 'LONG' && side !== 'SHORT')) continue;
    const dir = side === 'LONG' ? 1 : -1;
    const implied = Math.round((ep + (Number(t.pnl) + size * COMM_SIDE * 2) / (size * POINT * dir)) * 1e6) / 1e6;
    if (Number.isFinite(implied) && Math.abs(implied - Number(t.exitPrice)) > 0.0001 && Math.abs(implied - Number(t.exitPrice)) <= 500) {
      foldFixes.push({ t, implied });
    }
  }
  if (foldFixes.length) {
    console.log('\ntv_broker_feed_state.json — cached exit prices from the old walk:');
    foldFixes.forEach(f => console.log('  ' + f.t.side + ' ' + f.t.size + 'c  exitPrice ' + f.t.exitPrice + ' -> ' + f.implied + '   (pnl $' + Number(f.t.pnl).toFixed(2) + ' unchanged — it is the balance delta)'));
    if (APPLY) {
      const sf = path.join(DATA_DIR, 'tv_broker_feed_state.json');
      fs.copyFileSync(sf, sf + '.bak-split-exit-' + Date.now());
      foldFixes.forEach(f => { f.t.exitPrice = f.implied; });
      fs.writeFileSync(sf, JSON.stringify(foldState, null, 2), 'utf8');
      console.log('  written (backed up)');
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log(' ' + repaired + ' row(s) ' + (APPLY ? 'repaired' : 'would be repaired') + ', ' + flagged + ' flagged for a human, ' + foldFixes.length + ' fold price(s) ' + (APPLY ? 'corrected' : 'to correct'));
  if (!APPLY && (repaired || foldFixes.length)) {
    console.log(' Dry run — nothing written. Close the app, then re-run with --apply.');
  }
  console.log('='.repeat(78));
}

main();
