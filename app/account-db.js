// ── Unified account database (2026-08-13) ─────────────────────────────────────
// Anoop: "gather all the information of all the accounts and make one
// database to analyse."
//
// DATA/accounts/<slot>/ holds each account's files in isolation — correct for
// keeping eval and funded data from mixing (2026-08-13's earlier decision),
// wrong for asking a question that spans accounts ("what's my real win rate
// across everything", "which account actually made money"). This reads every
// slot folder and produces ONE consolidated view, written to
// DATA/account_database.json, without touching or mutating any of the
// per-account source files — read-only aggregation, nothing here can corrupt
// the ledgers it reads from.
//
// Pure-ish and Node-only (needs fs to read the account folders — this is a
// server-side/CLI module, not a renderer one, so no dual window/module export
// like checklist-logic.js). Every function that touches disk takes the paths
// explicitly rather than resolving them itself, so it's testable against a
// fixture directory and reusable from server.js's already-resolved DATA_DIR
// without duplicating that resolution logic.
//
//   DATA/accounts/s1/*.json  ─┐
//   DATA/accounts/s2/*.json  ─┼─> readAllAccounts() ─> buildDatabase() ─> {
//   DATA/accounts/s3/*.json  ─┤                          accounts: [...],
//   DATA/accounts/s4/*.json  ─┤                          allTrades: [...],
//   DATA/accounts/s5/*.json  ─┘                          allDays: [...],
//                                                          allChecklist: [...],
//                                                          summary: {...},
//                                                          dataQuality: [...]
//                                                        }
//                                                             |
//                                                             v
//                                          DATA/account_database.json (atomic write)

const fs = require('fs');
const path = require('path');

function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch (e) {
    return fallback;
  }
}

// One slot folder -> its full raw contents, nothing dropped, nothing
// recomputed. Aggregation/analysis happens one layer up in buildDatabase()
// so this stays a straight, honest read.
function readAccountFolder(accountsDir, slotId) {
  const dir = path.join(accountsDir, slotId);
  const meta = readJsonSafe(path.join(dir, 'meta.json'), null);
  const ledger = readJsonSafe(path.join(dir, 'balance_ledger.json'), {});
  const dayTrades = readJsonSafe(path.join(dir, 'day_trades.json'), {});
  const grHistory = readJsonSafe(path.join(dir, 'gr_history.json'), []);
  const ckHistory = readJsonSafe(path.join(dir, 'ck_history.json'), []);
  const closedBreached = readJsonSafe(path.join(dir, 'CLOSED_breached.json'), null);
  const closedCleared = readJsonSafe(path.join(dir, 'CLOSED_cleared.json'), null);
  return {
    slotId,
    meta,
    ledger: (ledger && typeof ledger === 'object') ? ledger : {},
    dayTrades: (dayTrades && typeof dayTrades === 'object') ? dayTrades : {},
    grHistory: Array.isArray(grHistory) ? grHistory : [],
    ckHistory: Array.isArray(ckHistory) ? ckHistory : [],
    closedBreached, closedCleared
  };
}

// Every folder under DATA/accounts, in a stable order (s1..s5, then anything
// else alphabetically) — never assumes exactly 5, so a 6th slot added later
// isn't silently dropped.
function listAccountSlots(accountsDir) {
  let entries = [];
  try { entries = fs.readdirSync(accountsDir, { withFileTypes: true }); } catch (e) { return []; }
  return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
}

function readAllAccounts(accountsDir) {
  return listAccountSlots(accountsDir).map(slotId => readAccountFolder(accountsDir, slotId));
}

// ── Build the consolidated database ────────────────────────────────────────

function moneyRound(n) { return Math.round((n || 0) * 100) / 100; }

function buildDatabase(rawAccounts) {
  const accounts = [];
  const allTrades = [];
  const allDays = [];
  const allChecklist = [];
  const dataQuality = [];

  rawAccounts.forEach(acc => {
    const meta = acc.meta || {};
    const size = meta.size || null;
    const stage = meta.stage || null;

    // Ledger days, tagged with which account they belong to.
    const days = Object.keys(acc.ledger).sort().map(date => {
      const d = acc.ledger[date] || {};
      allDays.push({ slotId: acc.slotId, size, stage, date, net: moneyRound(d.net) });
      return { date, net: moneyRound(d.net) };
    });

    // Trades, tagged and flattened — day_trades.json is keyed by date with an
    // array per day; this walks every day and tags every trade with the
    // account it came from, which nothing upstream currently does.
    let tradeCount = 0;
    Object.keys(acc.dayTrades).sort().forEach(date => {
      const trades = acc.dayTrades[date];
      if (!Array.isArray(trades)) return;
      trades.forEach(t => {
        if (!t) return;
        tradeCount++;
        allTrades.push({
          slotId: acc.slotId, size, stage, date,
          side: t.side || null, size_contracts: t.size != null ? t.size : null,
          pnl: moneyRound(t.pnl), entryPrice: t.ep != null ? t.ep : null,
          exitPrice: t.xp != null ? t.xp : null, hold: t.hold != null ? t.hold : null,
          flags: Array.isArray(t.flags) ? t.flags : []
        });
      });
    });

    acc.ckHistory.forEach(e => {
      if (!e || !e.date) return;
      allChecklist.push({ slotId: acc.slotId, size, stage, date: e.date, tier: e.tier || null, score: e.score != null ? e.score : null, done: e.done === true });
    });

    const netTotal = moneyRound(days.reduce((s, d) => s + d.net, 0));

    // Flag real inconsistencies rather than silently trusting meta.json —
    // found one in this exact data: s3's meta says status "active" while a
    // CLOSED_breached.json sits in the same folder.
    if (acc.closedBreached && meta.status === 'active') {
      dataQuality.push({ slotId: acc.slotId, issue: 'meta.status is "active" but a CLOSED_breached.json record exists for this slot — likely stale meta.json.' });
    }
    if (!acc.meta) {
      // NOTE: checked against acc.meta (the raw read), not the local `meta`
      // above — that one is already defaulted to {} for convenience elsewhere
      // in this function, so `!meta` would never be true and this flag would
      // never fire. Caught by the "no meta.json" test, 2026-08-13.
      dataQuality.push({ slotId: acc.slotId, issue: 'no meta.json found — size/stage unknown for this slot\'s trades in this database.' });
    }
    if (tradeCount > 0 && days.length === 0) {
      dataQuality.push({ slotId: acc.slotId, issue: `${tradeCount} trade(s) recorded but no balance_ledger.json entries — balance for this slot cannot be derived.` });
    }

    accounts.push({
      slotId: acc.slotId,
      name: meta.name || acc.slotId,
      size, stage,
      status: meta.status || (acc.closedBreached ? 'breached' : (acc.closedCleared ? 'cleared' : 'unknown')),
      startBalance: meta.startBalance != null ? meta.startBalance : null,
      lastBalance: meta.lastBalance != null ? meta.lastBalance : null,
      daysLogged: days.length,
      tradeCount,
      netTotal,
      checklistDaysDone: acc.ckHistory.filter(e => e && e.done).length,
      checklistDaysSkipped: acc.ckHistory.filter(e => e && e.tier === 'SKIPPED').length
    });
  });

  allTrades.sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
  allDays.sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
  allChecklist.sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));

  const byStage = { eval: { accounts: 0, trades: 0, netPnl: 0 }, funded: { accounts: 0, trades: 0, netPnl: 0 } };
  accounts.forEach(a => {
    if (a.stage === 'eval' || a.stage === 'funded') {
      byStage[a.stage].accounts++;
      byStage[a.stage].trades += a.tradeCount;
      byStage[a.stage].netPnl = moneyRound(byStage[a.stage].netPnl + a.netTotal);
    }
  });

  const totalTrades = allTrades.length;
  const wins = allTrades.filter(t => t.pnl > 0).length;
  const losses = allTrades.filter(t => t.pnl < 0).length;

  const summary = {
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter(a => a.status === 'active').length,
    breachedAccounts: accounts.filter(a => a.status === 'breached').length,
    totalTrades,
    totalDaysLogged: allDays.length,
    winRatePct: totalTrades ? Math.round((wins / totalTrades) * 1000) / 10 : null,
    winCount: wins, lossCount: losses, scratchCount: totalTrades - wins - losses,
    netPnlAllAccounts: moneyRound(allTrades.reduce((s, t) => s + t.pnl, 0)),
    byStage,
    checklistDaysDone: allChecklist.filter(e => e.done).length,
    checklistDaysSkipped: allChecklist.filter(e => e.tier === 'SKIPPED').length
  };

  return { generatedAt: null, accounts, allTrades, allDays, allChecklist, summary, dataQuality };
}

// ── Top-level entry point ──────────────────────────────────────────────────
// Reads DATA/accounts, builds the database, writes it to
// DATA/account_database.json via the same atomic-write helper every other
// save path in this app uses (so a crash mid-write can never leave a
// truncated file — see atomic-write.js). Returns the database object either
// way, so a caller (server.js, the CLI below) can use it without re-reading
// the file it just wrote.
function rebuildAccountDatabase(dataDir, opts) {
  opts = opts || {};
  const atomicWrite = opts.atomicWrite || require('./atomic-write');
  const accountsDir = path.join(dataDir, 'accounts');
  const raw = readAllAccounts(accountsDir);
  const db = buildDatabase(raw);
  db.generatedAt = new Date().toISOString();
  if (!opts.dryRun) {
    const outPath = path.join(dataDir, 'account_database.json');
    atomicWrite.writeAtomic(outPath, JSON.stringify(db, null, 2), 'utf8');
  }
  return db;
}

// ── CSV export (2026-08-13) ────────────────────────────────────────────────
// Anoop: "make excel for all this data... so that I see all the trades at
// once" -> "CSV file" / "not excel". Plain CSV needs no new dependency
// (adding a real .xlsx writer pulled in a dependency chain with 2 critical
// npm vulnerabilities — reverted) and Excel opens a .csv natively on
// double-click, which is all "see it in Excel" actually requires.
//
// One row per trade, EVERY account combined and tagged, sorted by date —
// exactly "all the trades at once" instead of hunting through 5 separate
// account tabs in the app.
const CSV_TRADE_COLUMNS = [
  'date', 'slotId', 'size', 'stage', 'side', 'contracts',
  'pnl', 'entryPrice', 'exitPrice', 'holdSeconds', 'flags'
];

// RFC 4180 minimal escaping: wrap in quotes and double any embedded quote
// whenever the value contains a comma, quote, or newline. A trade's `flags`
// array can legitimately contain a comma-joined list, so this is not
// optional — an unescaped field would silently shift every column after it.
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function tradesToCsv(trades) {
  const rows = [CSV_TRADE_COLUMNS.join(',')];
  (trades || []).forEach(t => {
    if (!t) return;
    rows.push(CSV_TRADE_COLUMNS.map(col => {
      if (col === 'contracts') return csvEscape(t.size_contracts);
      if (col === 'holdSeconds') return csvEscape(t.hold);
      if (col === 'flags') return csvEscape((t.flags || []).join('; '));
      return csvEscape(t[col]);
    }).join(','));
  });
  // Excel (esp. on Windows) needs a UTF-8 BOM to render non-ASCII correctly
  // and to auto-detect the encoding at all rather than guessing wrong.
  return '﻿' + rows.join('\r\n') + '\r\n';
}

// Writes DATA/account_trades.csv alongside the JSON database. Same
// atomic-write guarantee as rebuildAccountDatabase — a crash mid-write can
// never leave a half-written CSV that Excel then silently mis-parses.
function writeTradesCsv(dataDir, db, opts) {
  opts = opts || {};
  const atomicWrite = opts.atomicWrite || require('./atomic-write');
  const csv = tradesToCsv(db.allTrades);
  const outPath = path.join(dataDir, 'account_trades.csv');
  if (!opts.dryRun) atomicWrite.writeAtomic(outPath, csv, 'utf8');
  return { csv, path: outPath };
}

// ── HTML report (2026-08-13) ────────────────────────────────────────────────
// Anoop: "why is the data unreadable to a normal person... I don't want it to
// be saved as code." The JSON files ARE the app's real storage (server.js
// reads/writes them directly, they have to stay machine-shaped) and CSV
// needs Excel to render as a table — this needs neither. One self-contained
// .html file, double-click, opens in any browser, no software to configure.
function htmlEscape(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function moneyHtml(n) {
  n = n || 0;
  const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : '');
  const sign = n < 0 ? '-$' : '$';
  return `<span class="${cls}">${sign}${Math.abs(Math.round(n * 100) / 100).toLocaleString()}</span>`;
}

function buildHtmlReport(db) {
  const s = db.summary;
  const genDate = db.generatedAt ? new Date(db.generatedAt).toLocaleString() : '';

  const accountRows = db.accounts.map(a => `
    <tr>
      <td>${htmlEscape(a.slotId)}</td>
      <td>${htmlEscape(a.name)}</td>
      <td>${htmlEscape(a.size || '?')}</td>
      <td>${htmlEscape((a.stage || '?').toUpperCase())}</td>
      <td>${htmlEscape(a.status)}</td>
      <td>${a.tradeCount}</td>
      <td>${a.daysLogged}</td>
      <td>${moneyHtml(a.netTotal)}</td>
    </tr>`).join('');

  // One table per account, days-then-trades, so "all the data" reads as a
  // report per account rather than one 149-row wall with no structure.
  const perAccountSections = db.accounts.map(a => {
    const trades = db.allTrades.filter(t => t.slotId === a.slotId);
    if (!trades.length) return '';
    const tradeRows = trades.map(t => `
      <tr>
        <td>${htmlEscape(t.date)}</td>
        <td>${htmlEscape(t.side)}</td>
        <td>${t.size_contracts != null ? t.size_contracts : ''}</td>
        <td>${moneyHtml(t.pnl)}</td>
        <td>${t.entryPrice != null ? t.entryPrice : ''}</td>
        <td>${t.exitPrice != null ? t.exitPrice : ''}</td>
        <td>${t.hold != null ? t.hold + 's' : ''}</td>
        <td>${htmlEscape((t.flags || []).join(', '))}</td>
      </tr>`).join('');
    return `
    <h2>${htmlEscape(a.slotId)} — ${htmlEscape(a.name)} (${htmlEscape(a.size || '?')} ${htmlEscape((a.stage || '?').toUpperCase())}, ${htmlEscape(a.status)})</h2>
    <p class="meta">${trades.length} trade(s) &middot; net ${moneyHtml(a.netTotal)}</p>
    <table>
      <thead><tr><th>Date</th><th>Side</th><th>Contracts</th><th>P&amp;L</th><th>Entry</th><th>Exit</th><th>Hold</th><th>Flags</th></tr></thead>
      <tbody>${tradeRows}</tbody>
    </table>`;
  }).join('\n');

  const flagRows = db.dataQuality.map(f => `<li><b>${htmlEscape(f.slotId)}:</b> ${htmlEscape(f.issue)}</li>`).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Trading Co-Pilot — All Accounts Report</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; background:#0d1117; color:#e6edf3; margin:0; padding:28px 34px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:26px 0 4px; border-top:1px solid #30363d; padding-top:16px; }
  .meta { color:#8b949e; font-size:12px; margin:0 0 10px; }
  .pos { color:#3fb950; font-weight:600; }
  .neg { color:#f85149; font-weight:600; }
  table { border-collapse:collapse; width:100%; font-size:12px; margin-bottom:6px; }
  th, td { text-align:left; padding:5px 9px; border-bottom:1px solid #21262d; }
  th { color:#8b949e; font-weight:600; text-transform:uppercase; font-size:10px; letter-spacing:.04em; }
  .summary-grid { display:flex; gap:14px; flex-wrap:wrap; margin:14px 0 22px; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:12px 16px; min-width:150px; }
  .card .label { font-size:10px; color:#8b949e; text-transform:uppercase; letter-spacing:.04em; }
  .card .value { font-size:18px; font-weight:700; margin-top:3px; }
  .flags { background:#3d1f1f; border:1px solid #f85149; border-radius:8px; padding:10px 14px; margin:16px 0; font-size:12px; }
  .flags li { margin:3px 0; }
</style></head>
<body>
  <h1>Trading Co-Pilot — All Accounts Report</h1>
  <p class="meta">Generated ${htmlEscape(genDate)} &middot; read-only, combined from every account slot &middot; nothing here changes your live data</p>

  <div class="summary-grid">
    <div class="card"><div class="label">Accounts</div><div class="value">${s.totalAccounts} <span style="font-size:11px;color:#8b949e;">(${s.activeAccounts} active, ${s.breachedAccounts} breached)</span></div></div>
    <div class="card"><div class="label">Total Trades</div><div class="value">${s.totalTrades}</div></div>
    <div class="card"><div class="label">Win Rate</div><div class="value">${s.winRatePct != null ? s.winRatePct + '%' : 'n/a'} <span style="font-size:11px;color:#8b949e;">(${s.winCount}W/${s.lossCount}L/${s.scratchCount} scratch)</span></div></div>
    <div class="card"><div class="label">Net P&amp;L, all accounts</div><div class="value">${moneyHtml(s.netPnlAllAccounts)}</div></div>
    <div class="card"><div class="label">Eval stage</div><div class="value">${moneyHtml(s.byStage.eval.netPnl)} <span style="font-size:11px;color:#8b949e;">/ ${s.byStage.eval.trades} trades</span></div></div>
    <div class="card"><div class="label">Funded stage</div><div class="value">${moneyHtml(s.byStage.funded.netPnl)} <span style="font-size:11px;color:#8b949e;">/ ${s.byStage.funded.trades} trades</span></div></div>
  </div>

  ${db.dataQuality.length ? `<div class="flags"><b>⚠ Data quality notes:</b><ul>${flagRows}</ul></div>` : ''}

  <h2 style="border-top:none;padding-top:0;">Accounts overview</h2>
  <table>
    <thead><tr><th>Slot</th><th>Name</th><th>Size</th><th>Stage</th><th>Status</th><th>Trades</th><th>Days</th><th>Net P&amp;L</th></tr></thead>
    <tbody>${accountRows}</tbody>
  </table>

  ${perAccountSections}
</body></html>`;
}

// Writes DATA/account_report.html. Same atomic-write guarantee as the other
// exports — a crash mid-write can never leave a half-rendered page.
function writeHtmlReport(dataDir, db, opts) {
  opts = opts || {};
  const atomicWrite = opts.atomicWrite || require('./atomic-write');
  const html = buildHtmlReport(db);
  const outPath = path.join(dataDir, 'account_report.html');
  if (!opts.dryRun) atomicWrite.writeAtomic(outPath, html, 'utf8');
  return { html, path: outPath };
}

// Human-readable summary — what the CLI prints, and what a WS handler / chat
// tool can hand back without dumping the full per-trade array.
function formatSummary(db) {
  const s = db.summary;
  const lines = [];
  lines.push(`Accounts: ${s.totalAccounts} (${s.activeAccounts} active, ${s.breachedAccounts} breached)`);
  lines.push(`Trades: ${s.totalTrades} across ${s.totalDaysLogged} logged day(s) — win rate ${s.winRatePct != null ? s.winRatePct + '%' : 'n/a'} (${s.winCount}W / ${s.lossCount}L / ${s.scratchCount} scratch)`);
  lines.push(`Net P&L, ALL accounts combined: $${s.netPnlAllAccounts.toLocaleString()}`);
  lines.push(`  Eval stage:   ${s.byStage.eval.accounts} account(s), ${s.byStage.eval.trades} trades, net $${s.byStage.eval.netPnl.toLocaleString()}`);
  lines.push(`  Funded stage: ${s.byStage.funded.accounts} account(s), ${s.byStage.funded.trades} trades, net $${s.byStage.funded.netPnl.toLocaleString()}`);
  lines.push(`Checklist: ${s.checklistDaysDone} day(s) done, ${s.checklistDaysSkipped} skipped`);
  db.accounts.forEach(a => {
    lines.push(`  [${a.slotId}] ${a.name} — ${a.size || '?'} ${(a.stage || '?').toUpperCase()} (${a.status}) — ${a.tradeCount} trades, ${a.daysLogged} days, net $${a.netTotal.toLocaleString()}`);
  });
  if (db.dataQuality.length) {
    lines.push('Data quality flags:');
    db.dataQuality.forEach(f => lines.push(`  ⚠ [${f.slotId}] ${f.issue}`));
  }
  return lines.join('\n');
}

module.exports = {
  readAccountFolder, listAccountSlots, readAllAccounts,
  buildDatabase, rebuildAccountDatabase, formatSummary,
  csvEscape, tradesToCsv, writeTradesCsv,
  htmlEscape, buildHtmlReport, writeHtmlReport
};

// CLI: `node account-db.js [dataDir]` — defaults to ../DATA relative to this
// file (app/), matching this machine's confirmed live location
// (G:\Trading-CoPilot\DATA, no custom dataDir configured as of 2026-08-13).
if (require.main === module) {
  const dataDir = process.argv[2] || path.join(__dirname, '..', 'DATA');
  const db = rebuildAccountDatabase(dataDir);
  const csvOut = writeTradesCsv(dataDir, db);
  const htmlOut = writeHtmlReport(dataDir, db);
  console.log(`Written: ${path.join(dataDir, 'account_database.json')}`);
  console.log(`Written: ${csvOut.path}`);
  console.log(`Written: ${htmlOut.path}\n`);
  console.log(formatSummary(db));
}
