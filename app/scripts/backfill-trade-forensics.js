'use strict';
// F1 backfill: run trade-forensics over historical day_trades.json, filling only
// what the archive actually covers. Expect ~nothing for pre-2026-09-05 trades —
// that is correct (the bars were never recorded), and the script SAYS SO rather
// than producing plausible numbers from the wrong bars.
const fs = require('fs');
const path = require('path');
const barArchive = require('../bar-archive');
const forensics = require('../trade-forensics');
const DATA = 'G:/MNQ-CoPilot/DATA';
const ARCHIVE = path.join(DATA, 'bars', 'archive');
let filled = 0, unfilled = 0, refused = 0;
const reasons = {};
function note(reason) { reasons[reason] = (reasons[reason] || 0) + 1; }
// X9: accept BOTH `--from=<dir>` and `--from <dir>`, and reject any other flag
// with a non-zero exit — never silently read a different directory and report a
// confident answer to a question that was never asked.
const argv = process.argv.slice(2);
let fromDir = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--from') {
    if (i + 1 >= argv.length) { console.error('--from requires a directory argument'); process.exit(2); }
    fromDir = argv[++i];
  } else if (a.startsWith('--from=')) {
    fromDir = a.split('=').slice(1).join('=');
  } else if (a.startsWith('--')) {
    console.error('unknown argument: ' + a + ' (usage: node backfill-trade-forensics.js [--from <dir>])');
    process.exit(2);
  }
}
if (fromDir == null) fromDir = path.join(DATA, 'accounts');
// X8: discover day_trades files in EITHER layout — accounts/<slot>/day_trades.json
// or recovered <slot>_<status>_<date>_day_trades.json. Vacuous (0 trades looked at)
// was the bug; a real breakdown is the point.
const tradeFiles = [];
if (fs.existsSync(fromDir)) {
  for (const e of fs.readdirSync(fromDir)) {
    const p = path.join(fromDir, e);
    try {
      if (fs.statSync(p).isDirectory()) {
        const f = path.join(p, 'day_trades.json');
        if (fs.existsSync(f)) tradeFiles.push(f);
      } else if (e.endsWith('_day_trades.json')) {
        tradeFiles.push(p);
      }
    } catch (_) {}
  }
}
for (const fp of tradeFiles) {
  const trades = JSON.parse(fs.readFileSync(fp, 'utf8'));
  // The recovered files are object-keyed by date ({"2026-08-17": [ ... ]}), not a
  // flat array. Flatten every date bucket.
  let arr = [];
  if (Array.isArray(trades)) arr = trades;
  else if (trades && typeof trades === 'object') {
    for (const v of Object.values(trades)) if (Array.isArray(v)) arr = arr.concat(v);
  }
  let changed = false;
  for (const t of arr) {
    if (!t || t.mae != null || t.mfe != null) continue;
    // t/x are ALREADY milliseconds in the recovered rows (13-digit epoch), not
    // seconds — do not multiply.
    const entryAt = typeof t.entryAt === 'number' ? t.entryAt : (typeof t.t === 'number' ? t.t : null);
    const exitAt = typeof t.exitAt === 'number' ? t.exitAt : (typeof t.x === 'number' ? t.x : null);
    if (entryAt == null || exitAt == null || t.ep == null) { note('missing timestamps/price'); unfilled++; continue; }
    const sym = String(t.symbol || 'MNQ').toUpperCase(); // recovered rows lack symbol; MNQ is the eval instrument
    t.symbol = sym; // stamp it so point-value-verify + the winner invariant resolve the right multiplier (X7)
    const root = sym.includes('MNQ') ? 'MNQ' : (sym.includes('MGC') || sym.includes('GC') ? 'MGC' : null);
    if (!root) { note('unknown symbol'); unfilled++; continue; }
    const bars = barArchive.readArchive(ARCHIVE, root, '1', entryAt, exitAt + 30 * 60 * 1000);
    if (!bars.length) { note('no bars in archive'); unfilled++; continue; }
    const fr = forensics.tradeForensics(t, bars, { tf: '1' });
    if (fr.mae == null && fr.mfe == null) { note(fr.forensicsReason || 'no coverage'); unfilled++; continue; }
    // X6: write-time invariant. A WINNING trade cannot book more than its best
    // excursion offered. Refuse (do not write) on violation — never a console
    // warning beside a row that got stored anyway.
    const inv = forensics.assertWinnerInvariant(t, fr, fr.pointValue);
    if (inv.valid === false) { refused++; unfilled++; note('winner invariant violated: ' + inv.reason); continue; }
    t.mae = fr.mae; t.mfe = fr.mfe; t.edgeRatio = fr.edgeRatio; t.forensicsTf = fr.forensicsTf;
    t.maeUsd = fr.maeUsd; t.mfeUsd = fr.mfeUsd; // X7: dollars alongside points
    const post = forensics.postExitMove(t, bars);
    t.post30Mfe = post.post30Mfe; t.post30Mae = post.post30Mae; t.post30Close = post.post30Close; t.post30LeftOnTable = post.post30LeftOnTable;
    changed = true; filled++;
  }
  if (changed) fs.writeFileSync(fp, JSON.stringify(Array.isArray(trades) ? arr : Object.assign({}, trades, { trades: arr }), null, 2), 'utf8');
}
console.log('backfill filled=' + filled + ' unfilled=' + unfilled + ' refused=' + refused);
for (const [k, v] of Object.entries(reasons)) console.log('  ' + k + ': ' + v);