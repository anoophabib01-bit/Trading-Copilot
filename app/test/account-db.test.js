const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AD = require('../account-db.js');

// Build a throwaway DATA/ fixture per test — real fs, temp dir, never touches
// the actual G:\MNQ-CoPilot\DATA this module runs against in production.
function makeFixtureAccount(dataDir, slotId, files) {
  const dir = path.join(dataDir, 'accounts', slotId);
  fs.mkdirSync(dir, { recursive: true });
  Object.keys(files).forEach(name => {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(files[name]), 'utf8');
  });
}

function makeTmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'account-db-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

test('readAllAccounts finds every slot folder, in stable sorted order', () => {
  const dataDir = makeTmpDataDir();
  try {
    makeFixtureAccount(dataDir, 's2', { 'meta.json': { slotId: 's2' } });
    makeFixtureAccount(dataDir, 's1', { 'meta.json': { slotId: 's1' } });
    const accounts = AD.readAllAccounts(path.join(dataDir, 'accounts'));
    assert.deepStrictEqual(accounts.map(a => a.slotId), ['s1', 's2']);
  } finally { cleanup(dataDir); }
});

test('a slot with no files at all does not throw — every reader falls back safely', () => {
  const dataDir = makeTmpDataDir();
  try {
    fs.mkdirSync(path.join(dataDir, 'accounts', 's5'), { recursive: true });
    const accounts = AD.readAllAccounts(path.join(dataDir, 'accounts'));
    assert.strictEqual(accounts.length, 1);
    assert.strictEqual(accounts[0].meta, null);
    assert.deepStrictEqual(accounts[0].ledger, {});
    assert.deepStrictEqual(accounts[0].grHistory, []);
  } finally { cleanup(dataDir); }
});

test('corrupt JSON in one file does not take down the whole read', () => {
  const dataDir = makeTmpDataDir();
  try {
    const dir = path.join(dataDir, 'accounts', 's1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), '{ not valid json', 'utf8');
    fs.writeFileSync(path.join(dir, 'balance_ledger.json'), JSON.stringify({ '2026-08-01': { net: 100 } }), 'utf8');
    const accounts = AD.readAllAccounts(path.join(dataDir, 'accounts'));
    assert.strictEqual(accounts[0].meta, null); // corrupt file -> fallback, not a throw
    assert.strictEqual(accounts[0].ledger['2026-08-01'].net, 100); // sibling file still reads fine
  } finally { cleanup(dataDir); }
});

test('buildDatabase flattens trades across accounts and tags each with its slot/size/stage', () => {
  const raw = [
    {
      slotId: 's1', meta: { name: 'A', size: '50k', stage: 'eval', status: 'active' },
      ledger: { '2026-08-01': { net: 100 } },
      dayTrades: { '2026-08-01': [{ side: 'LONG', pnl: 100, size: 2 }] },
      grHistory: [], ckHistory: [], closedBreached: null, closedCleared: null
    },
    {
      slotId: 's3', meta: { name: 'B', size: '50k', stage: 'funded', status: 'active' },
      ledger: { '2026-08-05': { net: -50 } },
      dayTrades: { '2026-08-05': [{ side: 'SHORT', pnl: -50, size: 1 }] },
      grHistory: [], ckHistory: [], closedBreached: null, closedCleared: null
    }
  ];
  const db = AD.buildDatabase(raw);
  assert.strictEqual(db.allTrades.length, 2);
  assert.strictEqual(db.allTrades[0].slotId, 's1');
  assert.strictEqual(db.allTrades[0].stage, 'eval');
  assert.strictEqual(db.allTrades[1].slotId, 's3');
  assert.strictEqual(db.allTrades[1].stage, 'funded');
  assert.strictEqual(db.summary.totalTrades, 2);
  assert.strictEqual(db.summary.netPnlAllAccounts, 50);
});

test('per-stage rollup separates eval and funded correctly', () => {
  const raw = [
    { slotId: 's1', meta: { size: '50k', stage: 'eval' }, ledger: { d1: { net: 100 } }, dayTrades: { d1: [{ side: 'LONG', pnl: 100 }] }, grHistory: [], ckHistory: [], closedBreached: null, closedCleared: null },
    { slotId: 's2', meta: { size: '50k', stage: 'eval' }, ledger: { d1: { net: 200 } }, dayTrades: { d1: [{ side: 'LONG', pnl: 200 }] }, grHistory: [], ckHistory: [], closedBreached: null, closedCleared: null },
    { slotId: 's3', meta: { size: '150k', stage: 'funded' }, ledger: { d1: { net: -30 } }, dayTrades: { d1: [{ side: 'SHORT', pnl: -30 }] }, grHistory: [], ckHistory: [], closedBreached: null, closedCleared: null }
  ];
  const db = AD.buildDatabase(raw);
  assert.strictEqual(db.summary.byStage.eval.accounts, 2);
  assert.strictEqual(db.summary.byStage.eval.netPnl, 300);
  assert.strictEqual(db.summary.byStage.funded.accounts, 1);
  assert.strictEqual(db.summary.byStage.funded.netPnl, -30);
});

test('win rate counts strictly positive/negative, scratches are neither', () => {
  const raw = [{
    slotId: 's1', meta: { size: '50k', stage: 'eval' },
    ledger: {}, dayTrades: { d1: [{ pnl: 50 }, { pnl: -20 }, { pnl: 0 }] },
    grHistory: [], ckHistory: [], closedBreached: null, closedCleared: null
  }];
  const db = AD.buildDatabase(raw);
  assert.strictEqual(db.summary.winCount, 1);
  assert.strictEqual(db.summary.lossCount, 1);
  assert.strictEqual(db.summary.scratchCount, 1);
  assert.strictEqual(db.summary.winRatePct, 33.3);
});

test('THE REAL DATA CASE: meta says active but a CLOSED_breached.json exists — flagged, not hidden', () => {
  // This is s3's actual state on disk as of 2026-08-13: meta.json status
  // "active" while CLOSED_breached.json sits in the same folder.
  const raw = [{
    slotId: 's3', meta: { name: 'FUNDED', size: '50k', stage: 'funded', status: 'active' },
    ledger: {}, dayTrades: {}, grHistory: [], ckHistory: [],
    closedBreached: { status: 'breached', closedOn: '2026-08-01' }, closedCleared: null
  }];
  const db = AD.buildDatabase(raw);
  assert.strictEqual(db.dataQuality.length, 1);
  assert.strictEqual(db.dataQuality[0].slotId, 's3');
  assert.match(db.dataQuality[0].issue, /stale meta\.json/);
});

test('trades with no matching ledger entries are flagged, not silently trusted', () => {
  const raw = [{
    slotId: 's4', meta: { size: '50k', stage: 'eval' },
    ledger: {}, dayTrades: { d1: [{ pnl: 10 }] },
    grHistory: [], ckHistory: [], closedBreached: null, closedCleared: null
  }];
  const db = AD.buildDatabase(raw);
  assert.strictEqual(db.dataQuality.length, 1);
  assert.match(db.dataQuality[0].issue, /balance for this slot cannot be derived/);
});

test('a slot with no meta.json is flagged, size/stage come back null, does not throw', () => {
  const raw = [{
    slotId: 's5', meta: null,
    ledger: {}, dayTrades: {}, grHistory: [], ckHistory: [], closedBreached: null, closedCleared: null
  }];
  const db = AD.buildDatabase(raw);
  assert.strictEqual(db.accounts[0].size, null);
  assert.strictEqual(db.accounts[0].stage, null);
  assert.ok(db.dataQuality.some(f => /no meta\.json/.test(f.issue)));
});

test('checklist days roll up across accounts, done vs skipped counted separately', () => {
  const raw = [
    { slotId: 's1', meta: { size: '50k', stage: 'eval' }, ledger: {}, dayTrades: {}, grHistory: [],
      ckHistory: [{ date: '2026-08-10', tier: 'GO', done: true }, { date: '2026-08-11', tier: 'SKIPPED' }],
      closedBreached: null, closedCleared: null },
    { slotId: 's2', meta: { size: '50k', stage: 'eval' }, ledger: {}, dayTrades: {}, grHistory: [],
      ckHistory: [{ date: '2026-08-10', tier: 'GO', done: true }],
      closedBreached: null, closedCleared: null }
  ];
  const db = AD.buildDatabase(raw);
  assert.strictEqual(db.summary.checklistDaysDone, 2);
  assert.strictEqual(db.summary.checklistDaysSkipped, 1);
});

test('rebuildAccountDatabase writes account_database.json atomically and returns the same data', () => {
  const dataDir = makeTmpDataDir();
  try {
    makeFixtureAccount(dataDir, 's1', {
      'meta.json': { name: 'A', size: '50k', stage: 'eval', status: 'active' },
      'balance_ledger.json': { '2026-08-01': { net: 250 } },
      'day_trades.json': { '2026-08-01': [{ side: 'LONG', pnl: 250, size: 2 }] }
    });
    const db = AD.rebuildAccountDatabase(dataDir);
    const outPath = path.join(dataDir, 'account_database.json');
    assert.ok(fs.existsSync(outPath));
    const onDisk = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(onDisk.summary.totalTrades, 1);
    assert.strictEqual(onDisk.summary.netPnlAllAccounts, 250);
    assert.strictEqual(db.summary.netPnlAllAccounts, 250);
    assert.ok(db.generatedAt);
  } finally { cleanup(dataDir); }
});

test('dryRun does not write to disk', () => {
  const dataDir = makeTmpDataDir();
  try {
    makeFixtureAccount(dataDir, 's1', { 'meta.json': { size: '50k', stage: 'eval' } });
    AD.rebuildAccountDatabase(dataDir, { dryRun: true });
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'account_database.json')), false);
  } finally { cleanup(dataDir); }
});

test('rebuildAccountDatabase on a completely empty accounts/ folder does not throw', () => {
  const dataDir = makeTmpDataDir();
  fs.mkdirSync(path.join(dataDir, 'accounts'), { recursive: true });
  try {
    const db = AD.rebuildAccountDatabase(dataDir);
    assert.strictEqual(db.accounts.length, 0);
    assert.strictEqual(db.summary.totalTrades, 0);
    assert.strictEqual(db.summary.winRatePct, null); // 0 trades -> no rate, not 0% or NaN
  } finally { cleanup(dataDir); }
});

test('formatSummary produces readable text with per-account lines', () => {
  const raw = [{
    slotId: 's1', meta: { name: 'My Eval', size: '50k', stage: 'eval', status: 'active' },
    ledger: { d1: { net: 100 } }, dayTrades: { d1: [{ pnl: 100 }] },
    grHistory: [], ckHistory: [], closedBreached: null, closedCleared: null
  }];
  const db = AD.buildDatabase(raw);
  const text = AD.formatSummary(db);
  assert.match(text, /My Eval/);
  assert.match(text, /50k EVAL/);
});

// ── CSV export ────────────────────────────────────────────────────────────

test('csvEscape leaves plain values untouched', () => {
  assert.strictEqual(AD.csvEscape('LONG'), 'LONG');
  assert.strictEqual(AD.csvEscape(100), '100');
  assert.strictEqual(AD.csvEscape(-50.5), '-50.5');
});

test('csvEscape quotes and doubles embedded quotes', () => {
  assert.strictEqual(AD.csvEscape('he said "go"'), '"he said ""go"""');
});

test('csvEscape quotes a value containing a comma — THE bug class this exists to prevent', () => {
  // flags is a joined list like "oversize; revenge" — if the join character
  // or a stray value ever contains a comma, an unescaped field silently
  // shifts every column after it. This is what stops that.
  assert.strictEqual(AD.csvEscape('oversize, revenge'), '"oversize, revenge"');
});

test('csvEscape quotes embedded newlines', () => {
  assert.strictEqual(AD.csvEscape('line1\nline2'), '"line1\nline2"');
});

test('csvEscape renders null/undefined as empty, not the string "null"', () => {
  assert.strictEqual(AD.csvEscape(null), '');
  assert.strictEqual(AD.csvEscape(undefined), '');
  assert.strictEqual(AD.csvEscape(0), '0'); // falsy but real — must not collapse to empty
});

test('tradesToCsv produces a header row plus one row per trade, in order', () => {
  const trades = [
    { date: '2026-08-01', slotId: 's1', size: '50k', stage: 'eval', side: 'LONG', size_contracts: 2, pnl: 100, entryPrice: 21000, exitPrice: 21010, hold: 73, flags: [] },
    { date: '2026-08-02', slotId: 's3', size: '50k', stage: 'funded', side: 'SHORT', size_contracts: 5, pnl: -122.5, entryPrice: 29838, exitPrice: 29825.75, hold: 492, flags: ['oversize', 'out-of-window'] }
  ];
  const csv = AD.tradesToCsv(trades);
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  assert.strictEqual(lines.length, 3); // header + 2 trades
  assert.strictEqual(lines[0], 'date,slotId,size,stage,side,contracts,pnl,entryPrice,exitPrice,holdSeconds,flags');
  assert.strictEqual(lines[1], '2026-08-01,s1,50k,eval,LONG,2,100,21000,21010,73,');
  assert.strictEqual(lines[2], '2026-08-02,s3,50k,funded,SHORT,5,-122.5,29838,29825.75,492,oversize; out-of-window');
});

test('tradesToCsv starts with a UTF-8 BOM so Excel renders it correctly on open', () => {
  const csv = AD.tradesToCsv([{ date: '2026-08-01', slotId: 's1' }]);
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF);
});

test('tradesToCsv on an empty/missing list still produces a valid header-only file', () => {
  assert.match(AD.tradesToCsv([]), /^\uFEFFdate,slotId,size,stage,side,contracts,pnl,entryPrice,exitPrice,holdSeconds,flags\r\n$/);
  assert.match(AD.tradesToCsv(null), /^\uFEFFdate,slotId/);
});

test('tradesToCsv skips null entries in the trade list without corrupting row alignment', () => {
  const csv = AD.tradesToCsv([null, { date: '2026-08-01', slotId: 's1', pnl: 10 }, undefined]);
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  assert.strictEqual(lines.length, 2); // header + 1 real trade, nulls silently skipped
});

test('writeTradesCsv writes account_trades.csv next to account_database.json', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-db-csv-'));
  try {
    makeFixtureAccount(dataDir, 's1', {
      'meta.json': { size: '50k', stage: 'eval' },
      'balance_ledger.json': { '2026-08-01': { net: 100 } },
      'day_trades.json': { '2026-08-01': [{ side: 'LONG', pnl: 100, size: 2 }] }
    });
    const db = AD.rebuildAccountDatabase(dataDir);
    const out = AD.writeTradesCsv(dataDir, db);
    assert.ok(fs.existsSync(path.join(dataDir, 'account_trades.csv')));
    const onDisk = fs.readFileSync(path.join(dataDir, 'account_trades.csv'), 'utf8');
    assert.strictEqual(onDisk, out.csv);
    assert.match(onDisk, /LONG,2,100/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('writeTradesCsv respects dryRun — no file written', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-db-csv-dry-'));
  try {
    const db = AD.buildDatabase([]);
    AD.writeTradesCsv(dataDir, db, { dryRun: true });
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'account_trades.csv')), false);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// ── HTML report ───────────────────────────────────────────────────────────

test('htmlEscape neutralizes the five dangerous characters', () => {
  assert.strictEqual(AD.htmlEscape('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(AD.htmlEscape('Tom & Jerry'), 'Tom &amp; Jerry');
  assert.strictEqual(AD.htmlEscape(`it's "quoted"`), 'it&#39;s &quot;quoted&quot;');
});

test('htmlEscape renders null/undefined as empty', () => {
  assert.strictEqual(AD.htmlEscape(null), '');
  assert.strictEqual(AD.htmlEscape(undefined), '');
});

test('buildHtmlReport is a complete, well-formed document with the real numbers in it', () => {
  const raw = [{
    slotId: 's1', meta: { name: 'My Eval', size: '50k', stage: 'eval', status: 'active' },
    ledger: { '2026-08-01': { net: 100 } },
    dayTrades: { '2026-08-01': [{ side: 'LONG', pnl: 100, size: 2, hold: 60 }] },
    grHistory: [], ckHistory: [], closedBreached: null, closedCleared: null
  }];
  const db = AD.buildDatabase(raw);
  db.generatedAt = new Date().toISOString();
  const html = AD.buildHtmlReport(db);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/html>$/);
  assert.match(html, /My Eval/);
  assert.match(html, /\$100/); // the net P&L rendered somewhere
  assert.match(html, /LONG/);
  assert.match(html, /1 trade\(s\)/);
});

test('THE POINT OF THIS FEATURE: an account name containing HTML does not break the page', () => {
  // Slot names are user-editable (the gate row's rename input) — a name like
  // <b>fund</b> or an account containing a raw "&" must not corrupt the
  // report's markup or inject anything into the page he opens in a browser.
  const raw = [{
    slotId: 's1', meta: { name: '<b>Fund</b> & Co', size: '50k', stage: 'eval', status: 'active' },
    ledger: {}, dayTrades: {}, grHistory: [], ckHistory: [], closedBreached: null, closedCleared: null
  }];
  const db = AD.buildDatabase(raw);
  const html = AD.buildHtmlReport(db);
  assert.doesNotMatch(html, /<b>Fund<\/b>/);
  assert.match(html, /&lt;b&gt;Fund&lt;\/b&gt; &amp; Co/);
});

test('an account with zero trades gets no per-account trade section, no crash', () => {
  const raw = [{
    slotId: 's4', meta: { name: 's4', size: '50k', stage: 'eval', status: 'active' },
    ledger: {}, dayTrades: {}, grHistory: [], ckHistory: [], closedBreached: null, closedCleared: null
  }];
  const db = AD.buildDatabase(raw);
  const html = AD.buildHtmlReport(db);
  assert.match(html, /s4/); // still listed in the overview table
  assert.doesNotMatch(html, /0 trade\(s\)/); // no empty trade-table section rendered for it
});

test('data quality flags render as a visible warning block when present', () => {
  const raw = [{
    slotId: 's3', meta: { name: 'FUNDED', size: '50k', stage: 'funded', status: 'active' },
    ledger: {}, dayTrades: {}, grHistory: [], ckHistory: [],
    closedBreached: { status: 'breached' }, closedCleared: null
  }];
  const db = AD.buildDatabase(raw);
  const html = AD.buildHtmlReport(db);
  assert.match(html, /Data quality notes/);
  assert.match(html, /stale meta\.json/);
});

test('no data quality flags means no warning block at all', () => {
  const db = AD.buildDatabase([]);
  const html = AD.buildHtmlReport(db);
  assert.doesNotMatch(html, /Data quality notes/);
});

test('writeHtmlReport writes account_report.html and returns the same content', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-db-html-'));
  try {
    const db = AD.buildDatabase([]);
    const out = AD.writeHtmlReport(dataDir, db);
    assert.ok(fs.existsSync(path.join(dataDir, 'account_report.html')));
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'account_report.html'), 'utf8'), out.html);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('writeHtmlReport respects dryRun', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-db-html-dry-'));
  try {
    AD.writeHtmlReport(dataDir, AD.buildDatabase([]), { dryRun: true });
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'account_report.html')), false);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
