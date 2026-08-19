'use strict';
// archive-and-reset-accounts.js (2026-08-18)
// One-shot, one-way: archives ALL current account/trade data into
// DATA/history/<timestamp>/, then resets the live config to a single fresh
// slot ("Account A", stage=eval). Run with the app/server CLOSED — this
// edits the same ~/.mnq-copilot-config.json the live server reads/writes,
// and a concurrent writer could clobber this script's changes or vice versa.
//
// Usage: node app/scripts/archive-and-reset-accounts.js [--dry-run]
//
// What moves into DATA/history/<timestamp>/ (fs.renameSync — same volume,
// so this is a real move, not copy+leave-orphan):
//   DATA/accounts/            (s1-s5 folders — full per-slot trade history)
//   DATA/account_archives.json
//   DATA/account_database.json
//   DATA/account_report.html   (stale once accounts reset)
//   DATA/account_trades.csv    (stale once accounts reset)
//   DATA/trades_analysis.csv   (stale once accounts reset)
//   DATA/unified/              (disconnected reporting rollup, see plan doc)
//
// What does NOT move (out of scope — not per-account trade/lifecycle data):
//   account_fees.json (Cost tab — firm-wide fee ledger, may track costs not
//     tied to a specific archived account), chat_transcript.json,
//     align_notes.json, resume.html, token-usage.jsonl, charts/, reviews/
//
// Config changes (~/.mnq-copilot-config.json), snapshotted to
// DATA/history/<timestamp>/config-snapshot.json BEFORE any change:
//   acctSlots      -> [{ id: 's6', name: 'Account A', size: '50k', stage: 'eval' }]
//   activeSlotId   -> 's6'
//   every acctBucket__* key removed (their content is preserved in the
//     config snapshot above, so nothing is lost — just no longer live)
//   accountSize/mode -> '50k'/'eval' (kept in sync with the new active slot)

const fs = require('fs');
const path = require('path');
const os = require('os');
const atomicWrite = require('../atomic-write');
const { resolveDataDir } = require('../resolve-data-dir');

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIG_PATH = path.join(os.homedir(), '.mnq-copilot-config.json');
const { dir: DATA_DIR } = resolveDataDir();

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function moveIfExists(src, dest, log) {
  if (!fs.existsSync(src)) { log.push(`  (skip, not found) ${src}`); return; }
  if (DRY_RUN) { log.push(`  [dry-run] would move ${src} -> ${dest}`); return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  log.push(`  moved ${src} -> ${dest}`);
}

function main() {
  const stamp = ts();
  const historyDir = path.join(DATA_DIR, 'history', stamp);
  const log = [];
  log.push(`Archive run: ${stamp}${DRY_RUN ? ' (DRY RUN — nothing will be written)' : ''}`);
  log.push(`DATA_DIR: ${DATA_DIR}`);
  log.push(`History target: ${historyDir}`);

  if (!DRY_RUN) fs.mkdirSync(historyDir, { recursive: true });

  // 1) Config snapshot FIRST, before any config mutation — this is the
  // safety net if anything below needs to be reversed by hand.
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { log.push(`  ⚠ could not read config: ${e.message}`); }
  const configSnapshotPath = path.join(historyDir, 'config-snapshot.json');
  if (!DRY_RUN) atomicWrite.writeJsonAtomic(configSnapshotPath, cfg);
  log.push(`  config snapshot -> ${configSnapshotPath}`);

  // 2) Move DATA/ files into history/
  moveIfExists(path.join(DATA_DIR, 'accounts'), path.join(historyDir, 'accounts'), log);
  moveIfExists(path.join(DATA_DIR, 'account_archives.json'), path.join(historyDir, 'account_archives.json'), log);
  moveIfExists(path.join(DATA_DIR, 'account_database.json'), path.join(historyDir, 'account_database.json'), log);
  moveIfExists(path.join(DATA_DIR, 'account_report.html'), path.join(historyDir, 'account_report.html'), log);
  moveIfExists(path.join(DATA_DIR, 'account_trades.csv'), path.join(historyDir, 'account_trades.csv'), log);
  moveIfExists(path.join(DATA_DIR, 'trades_analysis.csv'), path.join(historyDir, 'trades_analysis.csv'), log);
  moveIfExists(path.join(DATA_DIR, 'unified'), path.join(historyDir, 'unified'), log);

  // 3) Reset config to a single fresh "Account A" slot.
  const NEW_SLOT_ID = 's6';
  const NEW_SLOT = { id: NEW_SLOT_ID, name: 'Account A', size: '50k', stage: 'eval' };

  const oldAcctBucketKeys = Object.keys(cfg).filter(k => k.startsWith('acctBucket__'));
  oldAcctBucketKeys.forEach(k => log.push(`  removing config key (preserved in snapshot): ${k}`));

  if (!DRY_RUN) {
    oldAcctBucketKeys.forEach(k => { delete cfg[k]; });
    cfg.acctSlots = [NEW_SLOT];
    cfg.activeSlotId = NEW_SLOT_ID;
    cfg.accountSize = NEW_SLOT.size;
    cfg.mode = NEW_SLOT.stage;
    atomicWrite.writeAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    log.push(`  config updated: acctSlots=[Account A / ${NEW_SLOT_ID}], activeSlotId=${NEW_SLOT_ID}`);
  } else {
    log.push(`  [dry-run] would set acctSlots=[Account A / ${NEW_SLOT_ID}], activeSlotId=${NEW_SLOT_ID}`);
  }

  console.log(log.join('\n'));
  console.log(DRY_RUN
    ? '\nDry run complete — nothing was changed. Re-run without --dry-run to apply.'
    : '\nDone. Start the app — it will open fresh on "Account A" (eval, $50K).');
}

main();
