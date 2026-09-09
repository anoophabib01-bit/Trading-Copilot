'use strict';
// ── sync.js — India Desk nightly sync (I0.2) ───────────────────────────────
// Runs `sync --full` through cli/market-cli.js (the single spawn point), forcing
// the store into cli/state/nse-india/ via --db. The CLI's own default is
// ~/.local/share/nse-india-pp-cli/data.db and it does NOT follow XDG, so the
// explicit --db is what makes the relocation real. Rate-limited to 0.5 req/s.
//
// SYNC ONLY. It must not render, alert, or notify. One line per run is appended
// to cli/state/nse-india/sync-log.jsonl so "has this actually been running" is
// answerable from disk, not from memory. Schedule it daily after the NSE close
// (15:30 IST) via Windows Task Scheduler, or keep it on a timer — either way it
// must survive a reboot (Task Scheduler is the robust choice).

const fs = require('node:fs');
const marketCli = require('../market-cli');
const { NAME, STATE_DIR, DB_PATH, SYNC_LOG } = require('./nse');

const NL = String.fromCharCode(10);

function appendLog(entry) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(SYNC_LOG, JSON.stringify(entry) + NL, 'utf8');
  } catch (e) {
    console.error('[india-sync] failed to write sync-log:', e.message);
  }
}

async function runSync() {
  const t = Date.now();
  const started = Date.now();
  // `sync --resources` explicitly requests the three resources the analytics read.
  // Measured 2026-09-06: with no --resources, `sync`/`workflow archive` only sync
  // "indices" (1 record) and never attempt equity or index_constituents, leaving
  // delivery-spike / delivery-divergence / sector-breadth / index-driver cold
  // forever. equity + index_constituents are cookie-gated (need `auth login
  // --chrome` once), so until then they error; the log records `errored` so a
  // silent partial failure is visible.
  const r = await marketCli.runNdjson(NAME, ['sync', '--full', '--resources', 'indices,index_constituents,equity', '--db', DB_PATH, '--rate-limit', '0.5']);
  const durationMs = Date.now() - started;
  let rowsBySeries = null;
  if (r.summary && r.summary.rowsBySeries != null) rowsBySeries = r.summary.rowsBySeries;
  else if (r.summary && r.summary.total_records != null) rowsBySeries = r.summary.total_records;
  const entry = { t, ok: r.ok, durationMs, exitCode: r.code, rowsBySeries };
  if (r.summary) { entry.resources = r.summary.resources; entry.success = r.summary.success; entry.errored = r.summary.errored; }
  if (!r.ok) entry.error = r.error || ('exit ' + r.code);
  appendLog(entry);
  if (r.ok) console.log('[india-sync] ok in ' + durationMs + 'ms (resources ' + (r.summary ? r.summary.resources : '?') + ', errored ' + (r.summary ? r.summary.errored : '?') + ')');
  else console.error('[india-sync] FAILED exit=' + r.code + ': ' + (r.error || 'unknown'));
  return entry;
}

if (require.main === module) {
  runSync().catch((e) => {
    appendLog({ t: Date.now(), ok: false, durationMs: 0, exitCode: 1, rowsBySeries: null, error: e.message });
    console.error('[india-sync] threw:', e.message);
    process.exitCode = 1;
  });
}

module.exports = { runSync, appendLog, SYNC_LOG, DB_PATH };
