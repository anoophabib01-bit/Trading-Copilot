'use strict';
/**
 * clean-today-ledger.js — 2026-08-24, one-off repair with a permanent reason.
 *
 * WHAT WENT WRONG: before the broker-P&L fix shipped, tv-broker-feed.js's
 * fill-edge backstop scored a "closed trade" every time the orders table went
 * dark and any fill landed while the positions panel read flat. On 2026-08-24
 * that wrote 19 rows into day_trades for the day, 18 of them with size 0 —
 * phantoms. Their P&L summed to -283.10, which endDay/csvApply rolled up into
 * balance_ledger as net -284.28 for the day. The broker's own account panel
 * said +399.70 for the same session.
 *
 * WHY DELETING IS THE FIX, NOT EDITING: once a day has a balance_ledger entry,
 * updateAccountUI stops consulting the live feed for that day entirely (see
 * renderer/app.js's `if (!ledger[todayKey])` guard) — the ledger is treated as
 * confirmed fact. So the corrected live figure could not reach the left panel
 * while a poisoned entry sat there. Removing the day hands it back to the live
 * feed, which now reads the broker's own Total P/L. Overwriting the entry with
 * a hand-computed number would just be a second guess wearing a fact's label.
 *
 * WHY IT IS A SCRIPT AND NOT AN EDIT MADE WHILE THE APP RUNS: the renderer
 * mirrors localStorage to disk every 30s and on pagehide/visibilitychange
 * (mirrorSlotDataToDisk). Editing these files under a live tab is overwritten
 * within half a minute. RUN THIS WITH THE CO-PILOT TAB CLOSED.
 *
 * Backs up every file it touches, never deletes a backup, and refuses to do
 * anything if the day it is asked to remove does not look like the damage it
 * was written for.
 */
const fs = require('fs');
const path = require('path');
const { resolveDataDir } = require('../resolve-data-dir');

const DAY = process.argv[2] || new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // IST day
const SLOT = process.argv[3] || 's1';
const dir = path.join(resolveDataDir().dir, 'accounts', SLOT);

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = file + '.bak-' + stamp;
  fs.copyFileSync(file, dest);
  return dest;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

console.log('Slot: ' + SLOT + '   Day: ' + DAY);
console.log('Dir : ' + dir);
console.log('');

const ledgerFile = path.join(dir, 'balance_ledger.json');
const tradesFile = path.join(dir, 'day_trades.json');
for (const f of [ledgerFile, tradesFile]) {
  if (!fs.existsSync(f)) { console.error('MISSING: ' + f + ' — nothing done.'); process.exit(1); }
}

const ledger = loadJson(ledgerFile);
const trades = loadJson(tradesFile);
const dayTrades = Array.isArray(trades[DAY]) ? trades[DAY] : [];
const phantoms = dayTrades.filter(t => Number(t.size) === 0).length;

if (!ledger[DAY] && !dayTrades.length) {
  console.log('Nothing to clean — ' + DAY + ' has no ledger entry and no stored trades.');
  process.exit(0);
}

console.log('FOUND:');
if (ledger[DAY]) console.log('  ledger  ' + DAY + ': net ' + ledger[DAY].net + ', contracts ' + ledger[DAY].contracts);
console.log('  trades  ' + DAY + ': ' + dayTrades.length + ' row(s), ' + phantoms + ' with size 0 (phantom)');
console.log('');

// Refuse to run on a day that does not carry the signature of the bug. A day
// whose rows all have a real size was NOT written by the fill-edge backstop,
// and deleting it would destroy good records.
if (dayTrades.length && phantoms === 0) {
  console.error('REFUSING: none of ' + DAY + "'s rows have size 0, so this is not the phantom-trade damage this script repairs.");
  console.error('If you really mean to clear this day, do it by hand — deliberately.');
  process.exit(1);
}

console.log('BACKUPS:');
console.log('  ' + path.basename(backup(ledgerFile)));
console.log('  ' + path.basename(backup(tradesFile)));
console.log('');

delete ledger[DAY];
delete trades[DAY];
fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2), 'utf8');
fs.writeFileSync(tradesFile, JSON.stringify(trades, null, 2), 'utf8');

const days = Object.keys(ledger).sort();
const START = 50000;
let bal = START;
days.forEach(d => { bal += ledger[d].net; });
console.log('DONE. ' + DAY + ' removed from both files.');
console.log('');
console.log('Ledger now holds ' + days.length + ' day(s): ' + days.join(', '));
console.log('Base balance (start ' + START + ' + those days): $' + (Math.round(bal * 100) / 100).toLocaleString());
console.log("Today's P&L will now come from the live broker feed instead.");
