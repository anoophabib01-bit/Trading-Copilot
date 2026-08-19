// unified-data.js
// Single source of truth for accounts, trades, and stage transitions.
// Reads from DATA/unified/{accounts,trades,account_events}.json.
// Falls back to legacy per-slot files only if unified files are missing.

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

function readUnified(dataDir) {
  const unifiedDir = path.join(dataDir, 'unified');
  const accounts = readJsonSafe(path.join(unifiedDir, 'accounts.json'), []);
  const trades = readJsonSafe(path.join(unifiedDir, 'trades.json'), []);
  const events = readJsonSafe(path.join(unifiedDir, 'account_events.json'), []);
  return { accounts, trades, events, unifiedDir };
}

function getAccountById(accounts, accountId) {
  return accounts.find(a => a.id === accountId) || null;
}

function getTradesForAccount(trades, accountId) {
  return trades.filter(t => t.account_id === accountId).sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    return da < db ? -1 : da > db ? 1 : 0;
  });
}

function getEventsForAccount(events, accountId) {
  return events.filter(e => e.account_id === accountId).sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    return da < db ? -1 : da > db ? 1 : 0;
  });
}

function buildUnifiedDatabase(dataDir) {
  const { accounts, trades, events } = readUnified(dataDir);
  const now = new Date().toISOString();

  const enrichedAccounts = accounts.map(acc => {
    const accTrades = getTradesForAccount(trades, acc.id);
    const wins = accTrades.filter(t => (t.pnl || 0) > 0).length;
    const losses = accTrades.filter(t => (t.pnl || 0) < 0).length;
    const scratch = accTrades.filter(t => (t.pnl || 0) === 0).length;
    const netPnl = Math.round(accTrades.reduce((s, t) => s + (t.pnl || 0), 0) * 100) / 100;
    return {
      ...acc,
      tradeCount: accTrades.length,
      netTotal: netPnl,
      winCount: wins,
      lossCount: losses,
      scratchCount: scratch,
      winRatePct: accTrades.length ? Math.round((wins / accTrades.length) * 1000) / 10 : null
    };
  });

  const allTrades = trades.sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  const totalTrades = allTrades.length;
  const winCount = allTrades.filter(t => (t.pnl || 0) > 0).length;
  const lossCount = allTrades.filter(t => (t.pnl || 0) < 0).length;
  const scratchCount = totalTrades - winCount - lossCount;
  const netPnlAllAccounts = Math.round(allTrades.reduce((s, t) => s + (t.pnl || 0), 0) * 100) / 100;

  const byStage = {};
  for (const stage of ['NEW_EVAL', 'EVAL_ACTIVE', 'EVAL_BREACHED', 'FUNDED_ACTIVE', 'FUNDED_BREACHED', 'PAYOUT']) {
    const stageAccounts = enrichedAccounts.filter(a => a.current_stage === stage);
    const stageTrades = allTrades.filter(t => t.stage_at_entry === stage);
    byStage[stage] = {
      accounts: stageAccounts.length,
      trades: stageTrades.length,
      netPnl: Math.round(stageTrades.reduce((s, t) => s + (t.pnl || 0), 0) * 100) / 100
    };
  }

  const summary = {
    totalAccounts: enrichedAccounts.length,
    activeAccounts: enrichedAccounts.filter(a => a.status === 'active').length,
    breachedAccounts: enrichedAccounts.filter(a => a.status === 'breached').length,
    totalTrades,
    winRatePct: totalTrades ? Math.round((winCount / totalTrades) * 1000) / 10 : null,
    winCount,
    lossCount,
    scratchCount,
    netPnlAllAccounts,
    byStage
  };

  return {
    generatedAt: now,
    accounts: enrichedAccounts,
    allTrades,
    accountEvents: events,
    summary,
    dataQuality: []
  };
}

module.exports = {
  readUnified,
  getAccountById,
  getTradesForAccount,
  getEventsForAccount,
  buildUnifiedDatabase
};
