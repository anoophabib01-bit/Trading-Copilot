'use strict';
/**
 * verify-slot.js — "is my new evaluation actually saving?"
 *
 * Written 2026-08-31 after Anoop started a fresh 50K eval (slot s2) and had
 * no way to confirm the data was landing in the new folder rather than still
 * going to the old one. The app tells you which slot it *intends* to write to
 * (the "Saving to: ..." line in the Journal tab); this checks what is actually
 * on disk, which is not the same claim.
 *
 * READ-ONLY. It opens files and stats them, and writes nothing. Safe to run
 * while the server is live and mid-session.
 *
 * Run:  node app/verify-slot.js
 *
 * Three things it proves, in order of how much they'd hurt if wrong:
 *   1. The active slot in config matches the folder being written.
 *   2. Files inside the slot carry their own slotId stamp, and it agrees with
 *      the folder they're sitting in. A path can be right by accident; a
 *      self-stamped record cannot.
 *   3. No OTHER slot has been written more recently — which is the actual
 *      failure mode worth catching. "New data is being saved" and "new data
 *      is being saved to the RIGHT place" are different statements, and the
 *      first one is true even when an account switch silently didn't take.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveDataDir } = require('./resolve-data-dir');

const CONFIG_PATH = path.join(os.homedir(), '.trading-copilot-config.json');

// Files a traded slot accumulates. Absence is NOT an error on a fresh account —
// each one is created by its first triggering event, so the list doubles as
// "what you should expect to appear, and what has to happen first".
const EXPECTED = [
  ['ck_history.json',      'pre-trade checklist completed'],
  ['day_trades.json',      'first trade logged'],
  ['gr_history.json',      'first day rolled up (End Day & Save)'],
  ['balance_ledger.json',  'first balance change'],
  ['meta.json',            'account metadata written'],
  ['eval_milestones.json', 'eval progress tracked'],
  ['loop_state.json',      'loop-challenge streak updated'],
  ['notes.json',           'first journal note'],
  ['pb_tags.json',         'first playbook tag'],
  ['maemfe.json',          'first MAE/MFE record'],
];

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return s + 's ago';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 172800) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Pull every distinct slotId stamped inside a JSON file, at any depth. The
// records that carry one (checklist rows, trades) stamp it per-row, so a file
// that was written under the wrong slot shows up here as a mismatch even
// though its path looks fine.
function stampedSlotIds(file) {
  const found = new Set();
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return found; }
  (function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) { node.forEach((v) => walk(v, depth + 1)); return; }
    if (typeof node.slotId === 'string' && node.slotId) found.add(node.slotId);
    Object.values(node).forEach((v) => walk(v, depth + 1));
  })(parsed, 0);
  return found;
}

function main() {
  const problems = [];
  const notes = [];

  const { dir: DATA_DIR, isFallback } = resolveDataDir();
  if (isFallback) problems.push(`DATA_DIR fell back to ${DATA_DIR} — the configured/default path was not writable.`);

  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {
    problems.push(`Could not read ${CONFIG_PATH}: ${e.message}`);
  }

  const slot = cfg.activeSlotId || null;
  console.log('\n  ACCOUNT SLOT VERIFICATION');
  console.log('  ' + '─'.repeat(58));
  console.log(`  Data dir     : ${DATA_DIR}`);
  console.log(`  Active slot  : ${slot || '(none set)'}`);
  console.log(`  Account      : ${cfg.accountSize || '?'} ${String(cfg.mode || '?').toUpperCase()}`);
  console.log(`  Checked at   : ${stamp(Date.now())}`);

  if (!slot) {
    problems.push('No activeSlotId in config — the app has not been told which account is open.');
    report(problems, notes);
    return;
  }

  const accountsDir = path.join(DATA_DIR, 'accounts');
  const slotDir = path.join(accountsDir, slot);

  if (!fs.existsSync(slotDir)) {
    problems.push(`Slot folder does not exist yet: ${slotDir}`);
    notes.push('It is created on the first save. Complete the pre-trade checklist and re-run this.');
    report(problems, notes);
    return;
  }

  // ── What is actually in the active slot ──────────────────────────────────
  console.log(`\n  FILES IN ${slot}`);
  console.log('  ' + '─'.repeat(58));
  let newestInSlot = 0;
  const present = new Set();
  EXPECTED.forEach(([name, trigger]) => {
    const fp = path.join(slotDir, name);
    if (!fs.existsSync(fp)) {
      console.log(`  ·  ${name.padEnd(22)} not yet — created on: ${trigger}`);
      return;
    }
    present.add(name);
    const st = fs.statSync(fp);
    if (st.mtimeMs > newestInSlot) newestInSlot = st.mtimeMs;
    const ids = stampedSlotIds(fp);
    let tag = '';
    if (ids.size) {
      const wrong = [...ids].filter((s) => s !== slot);
      if (wrong.length) {
        tag = `  ⚠ contains slotId ${wrong.join(',')}`;
        problems.push(`${name} sits in ${slot}/ but stamps slotId "${wrong.join(',')}" inside — records were written under a different account.`);
      } else {
        tag = `  ✓ stamped ${slot}`;
      }
    }
    console.log(`  ✓  ${name.padEnd(22)} ${String(st.size).padStart(7)} B   ${stamp(st.mtimeMs)}  (${ago(st.mtimeMs)})${tag}`);
  });

  if (!present.size) {
    problems.push(`${slot}/ exists but is empty — nothing has been saved to this account yet.`);
  }

  // ── The check that actually matters: is anything else newer? ─────────────
  // A fresh slot legitimately has almost nothing in it, so "s2 has one file"
  // proves little on its own. What proves the switch took is that no OTHER
  // slot has been written since.
  console.log('\n  OTHER SLOTS (nothing here should be newer than the active slot)');
  console.log('  ' + '─'.repeat(58));
  let others = [];
  try { others = fs.readdirSync(accountsDir).filter((d) => d !== slot); } catch {}
  if (!others.length) console.log('  (none)');
  others.forEach((other) => {
    const od = path.join(accountsDir, other);
    let newest = 0, newestName = '';
    let files = [];
    try { files = fs.readdirSync(od); } catch { return; }
    files.forEach((f) => {
      // Ignore .bak-* snapshots: they are historical by definition and their
      // mtime says nothing about whether the app is still writing live data here.
      if (f.includes('.bak')) return;
      try {
        const st = fs.statSync(path.join(od, f));
        if (st.isFile() && st.mtimeMs > newest) { newest = st.mtimeMs; newestName = f; }
      } catch {}
    });
    if (!newest) { console.log(`  ${other.padEnd(5)} (no live files)`); return; }
    const stale = newest <= newestInSlot;
    console.log(`  ${other.padEnd(5)} newest: ${newestName.padEnd(22)} ${stamp(newest)}  (${ago(newest)})  ${stale ? '✓ older than active' : '⚠ NEWER THAN ACTIVE'}`);
    if (!stale && newestInSlot) {
      problems.push(`Slot ${other} was written MORE RECENTLY than the active slot ${slot} (${newestName}). The account switch may not have taken.`);
    }
  });

  report(problems, notes);
}

function report(problems, notes) {
  console.log('\n  VERDICT');
  console.log('  ' + '─'.repeat(58));
  if (!problems.length) {
    console.log('  ✓ PASS — the active slot is the one being written, and every');
    console.log('    self-stamped record agrees with the folder it is in.');
  } else {
    console.log(`  ✗ ${problems.length} problem${problems.length === 1 ? '' : 's'} found:\n`);
    problems.forEach((p, i) => console.log(`    ${i + 1}. ${p}`));
  }
  notes.forEach((n) => console.log(`\n  note: ${n}`));
  console.log('');
  process.exitCode = problems.length ? 1 : 0;
}

main();
