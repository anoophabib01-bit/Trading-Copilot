'use strict';
/**
 * verify-fold.js — check the balance-delta-at-flat fold against reality.
 *
 * Written 2026-08-20 to close the longest-standing open item in TODOS.md:
 * "the balance-delta P&L fold has never been checked against a real closed
 * trade with non-zero P&L." Everything the live guardrail enforces sits on
 * top of that arithmetic, so it needed evidence rather than assumption.
 *
 * Run:  node scripts/verify-fold.js [--broker-balance 49953.80]
 *
 * It performs four independent checks and prints PASS/FAIL for each. Nothing
 * here writes; it is safe to run against a live session.
 */
const fs = require('fs');
const path = require('path');
const resolveDataDir = require('../resolve-data-dir');

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const DATA_DIR = resolveDataDir.resolveDataDir().dir;
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}\n`); };

// ── 1. The contract multiplier, from real broker-confirmed trades ──────────
// MNQ (Micro E-mini Nasdaq-100) is $2.00 per index point; tick is 0.25, so
// $0.50 per tick. If that is right, EVERY realized P&L in the CSV-derived
// history must be a whole number of $0.50 units, no matter how many fills it
// aggregates. This is the check that lets the rest of the file stop guessing.
const dayTrades = readJson(path.join(DATA_DIR, 'day_trades.json')) || readJson(path.join(__dirname, '..', 'data', 'day_trades.json'));
if (dayTrades) {
  const all = Object.entries(dayTrades).flatMap(([day, rows]) => (rows || []).map(r => ({ day, ...r })));
  const bad = all.filter(t => typeof t.pnl === 'number' && Math.abs(t.pnl / 0.5 - Math.round(t.pnl / 0.5)) > 1e-9);
  check('MNQ multiplier is $2.00/point ($0.50/tick)',
    all.length > 0 && bad.length === 0,
    `${all.length - bad.length}/${all.length} realized P&L values are exact multiples of $0.50 across ${Object.keys(dayTrades).length} days. Violations: ${bad.length}.`);

  // ── 2. Per-trade P&L must reconcile to the day ledger ────────────────────
  const ledger = readJson(path.join(DATA_DIR, 'balance_ledger.json')) || readJson(path.join(__dirname, '..', 'data', 'balance_ledger.json'));
  if (ledger) {
    const rows = Object.entries(dayTrades).map(([day, list]) => {
      const sum = (list || []).reduce((a, r) => a + (r.pnl || 0), 0);
      const gross = ledger[day] ? ledger[day].gross : null;
      return { day, sum, gross, ok: gross !== null && Math.abs(sum - gross) < 1e-9 };
    }).filter(r => r.gross !== null);
    const bad2 = rows.filter(r => !r.ok);
    check('per-trade P&L sums to the day ledger gross',
      rows.length > 0 && bad2.length === 0,
      `${rows.length - bad2.length}/${rows.length} days reconcile exactly.` + (bad2.length ? ' Off: ' + bad2.map(r => `${r.day} ${r.sum} vs ${r.gross}`).join(', ') : ''));
  }
}

// ── 3. The fold's endpoint against the broker's own balance ────────────────
// This is the real test of the balance-delta method: `balanceAtLastFlat` is
// the number the fold believes the account is worth while flat. It must equal
// what the broker panel actually shows.
const feed = readJson(path.join(DATA_DIR, 'tv_broker_feed_state.json'));
const brokerBalance = argOf('--broker-balance') ? Number(argOf('--broker-balance')) : null;
if (feed && brokerBalance !== null) {
  const diff = feed.balanceAtLastFlat - brokerBalance;
  check("fold's balanceAtLastFlat matches the broker panel",
    Math.abs(diff) < 0.005,
    `fold ${feed.balanceAtLastFlat} vs broker ${brokerBalance} (diff ${diff.toFixed(2)}).`);
}

// ── 4. dayPnl against the account's true day delta ─────────────────────────
// The fold cannot see trades that closed before its first poll (documented, by
// design — it establishes its baseline at that first readable poll). So the
// expected gap is exactly: accountStart - impliedDayStart.
//
// Pass --day-pnl / --day-start to re-check a HISTORICAL day, since the live
// state file is wiped at every IST rollover and the numbers from the day you
// want to audit will not be in it any more.
const histPnl = argOf('--day-pnl') !== null ? Number(argOf('--day-pnl')) : null;
const histStart = argOf('--day-start') !== null ? Number(argOf('--day-start')) : null;
if (feed || histPnl !== null) {
  const meta = readJson(path.join(DATA_DIR, 'accounts', 's2', 'meta.json'));
  const dayPnl = histPnl !== null ? histPnl : feed.dayPnl;
  const trades = histPnl !== null ? null : (feed.trades || []);
  const start = histStart !== null ? histStart
    : (meta && typeof meta.startBalance === 'number' ? meta.startBalance : null);

  if (trades && trades.length === 0 && histPnl === null) {
    console.log(`SKIP  fold's dayPnl vs the account's true day delta
      No trades recorded for the current IST day yet — nothing to check. To audit a
      past day, pass --day-pnl <fold dayPnl> --day-start <balance at that day's open>.
`);
  } else if (start !== null && brokerBalance !== null) {
    const trueDay = brokerBalance - start;
    const impliedStart = brokerBalance - dayPnl;
    const gap = dayPnl - trueDay;
    check("fold's dayPnl equals the account's true day delta",
      Math.abs(gap) < 0.005,
      `fold ${dayPnl.toFixed(2)} vs true ${trueDay.toFixed(2)} (gap ${gap.toFixed(2)}). ` +
      `Fold's implied day-start ${impliedStart.toFixed(2)} vs account start ${start.toFixed(2)}. ` +
      `A gap is the documented "baseline at first poll" blind spot — plausible, but it must be ` +
      `EXPLAINED, not waved through.`);
  }

  // Partition check: the day total being right does NOT prove the per-trade
  // split is right. That split is exactly what the 2026-08-20 count bug broke.
  if (trades && trades.length) {
    const sum = trades.reduce((a, t) => a + (t.pnl || 0), 0);
    check('per-trade P&L sums to the fold dayPnl (partition is self-consistent)',
      Math.abs(sum - feed.dayPnl) < 0.005,
      `sum(trades) ${sum.toFixed(2)} vs dayPnl ${feed.dayPnl.toFixed(2)}. ` +
      `NOTE: self-consistency only. It proves the parts add to the whole, NOT that the number ` +
      `of parts is right — ${trades.filter(t => t.inferred).length} of ${trades.length} are 'inferred'.`);
  }
}

const failed = results.filter(r => !r.pass);
console.log('─'.repeat(70));
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
