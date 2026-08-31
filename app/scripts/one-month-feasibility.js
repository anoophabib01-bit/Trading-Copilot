#!/usr/bin/env node
'use strict';
// ── Can DSH-V2 clear a 50K eval in ONE month? (2026-08-26) ─────────────────
// Anoop: "i want results on 1month even if size is increased. do you think it
// is possible?"
//
// This does not answer with an opinion. It slides a real 21-trading-day window
// across all 9 months of MNQ data and asks, for each contract size: how many
// of those months actually reached $3,000, and what did the account go through
// on the way?
//
// ── WHY ROLLING WINDOWS AND NOT AN AVERAGE ─────────────────────────────────
// "+$339/month at 2 contracts, so 9x the size gives +$3,051/month" is the
// arithmetic that blows accounts. It treats a mean as if it were a guarantee.
// The 9 months contain one regime (Nov-Jan, flat) where this strategy LOSES at
// every size, and the average silently absorbs it. What matters for a
// one-month eval is not the mean month — it is the DISTRIBUTION of months,
// and specifically the bad ones, because you only get to run the eval once and
// you do not get to pick which month you get.
//
// ── WHY DRAWDOWN IS THE REAL ANSWER ────────────────────────────────────────
// Profit scales with size. So does loss. The eval has a hard floor (~$2,000 on
// a 50K) that ends the account permanently, and it is checked continuously,
// not at month end. So the question is never "can size reach the target" —
// arithmetically it always can — it is "does the account survive the path".
// Those are different questions and only the second one matters.
//
// ── THE perTradeMaxLoss INTERACTION ────────────────────────────────────────
// rules.json caps risk at $300/trade, which at N contracts means a maximum
// stop of 150/N points. At 2 contracts that is 75pt and already refuses 33 of
// 76 setups; at 8 contracts it is 18pt and refuses essentially everything. So
// raising size REQUIRES raising that cap proportionally, or the strategy stops
// having trades at all. This models it scaled — the most FAVOURABLE reading —
// so the conclusion cannot be blamed on an artificial filter.

const fs = require('fs');
const path = require('path');
const backtest = require('../backtest');
const detectors = require('../detectors');

const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
const PV = backtest.MNQ_POINT_VALUE;

// 50K account. ASSUMED figures — see scripts/backtest-playbooks.js.
const TARGET = 3000;
const DD_LIMIT = 2000;
const TRADING_DAYS = 21;

const REGIME_FILES = ['mnq_1h_sepnov.json', 'mnq_1h_flat.json', 'mnq_1h_downtrend.json', 'mnq_1h_uptrend.json', 'mnq_60.json'];

function load(file) {
  const p = path.join(__dirname, '..', '..', 'DATA', 'bars', file);
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (d.bars || d).filter((b) => b && typeof b.time === 'number' && typeof b.close === 'number');
}

// DSH-V2, using the shared detectors. Risk cap scales with size (see header).
function runStrategy(bars, contracts, opts) {
  const o = opts || {};
  const lookback = o.lookback || 10, adxMin = o.adxMin || 35;
  const { adx, plusDI, minusDI } = detectors.adxSeries(bars, 14);
  const buf = RULES.playbooks.stopBufferPoints, rr = RULES.playbooks.targetR;
  const horizon = RULES.playbooks.outcomeHorizonBars;
  const comm = RULES.commissionPerContractPerSide * 2 * contracts;
  const maxRiskUsd = RULES.perTradeMaxLoss * (contracts / 2);   // scaled — see header
  const dailyCap = (o.dailyCap || 1000) * (contracts / 2);

  const trades = [];
  const dayPnl = {};
  for (let i = Math.max(lookback + 2, 30); i < bars.length; i++) {
    const bar = bars[i];
    if (!(adx[i] >= adxMin && plusDI[i] > minusDI[i])) continue;
    const hi = detectors.priorHigh(bars, i, lookback);
    if (hi == null || !(bar.close > hi && bar.close > bar.open)) continue;
    const entry = bar.close, stop = bar.low - buf, risk = entry - stop;
    if (!(risk > 0) || risk < RULES.playbooks.minRiskPoints) continue;
    if (risk * PV * contracts > maxRiskUsd) continue;

    const day = new Date(bar.time * 1000).toISOString().slice(0, 10);
    if ((dayPnl[day] || 0) >= dailyCap) continue;

    const sim = backtest.simulateTrade(
      { playbook: 'DSH-V2', direction: 'BULLISH', entry, stop, target: entry + risk * rr, requiresFill: false },
      bars, i, { horizonBars: horizon, slippagePoints: 0.5, flattenByISTMinutes: RULES.flattenByISTMinutes }
    );
    if (!sim) continue;
    const net = sim.points * PV * contracts - comm;
    dayPnl[day] = (dayPnl[day] || 0) + net;
    trades.push({ time: bar.time, day, net });
  }
  return trades;
}

// Every 21-trading-day window, stepped one trading day at a time.
// Reports what a real eval would have experienced: does drawdown breach the
// floor BEFORE the target is reached? Order matters, so this walks the path.
// `calendarDays` MUST come from the BARS, not from the trades. A window of 21
// days-that-had-trades is not a month — at ~5 trades a month it is closer to
// four months, which would quietly make the strategy look four times faster
// than it is. The calendar is every trading day the market was open.
function rollingMonths(trades, calendarDays) {
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.day)) byDay.set(t.day, []);
    byDay.get(t.day).push(t);
  }
  const days = calendarDays;
  const windows = [];
  for (let s = 0; s + TRADING_DAYS <= days.length; s++) {
    const slice = days.slice(s, s + TRADING_DAYS);
    let eq = 0, peak = 0, maxDD = 0, hitTarget = false, blewUp = false;
    const dayTotals = [];
    for (const d of slice) {
      let dayNet = 0;
      for (const t of (byDay.get(d) || [])) {
        eq += t.net; dayNet += t.net;
        peak = Math.max(peak, eq);
        maxDD = Math.max(maxDD, peak - eq);
        // Both checked continuously and IN ORDER — a blow-up before the
        // target is a failed eval even if the month ends green.
        if (!blewUp && maxDD >= DD_LIMIT) blewUp = true;
        if (!hitTarget && !blewUp && eq >= TARGET) hitTarget = true;
      }
      dayTotals.push(dayNet);
    }
    const best = Math.max(...dayTotals, 0);
    windows.push({
      start: slice[0], end: slice[slice.length - 1],
      net: eq, maxDD, hitTarget, blewUp,
      consistency: eq > 0 ? best / eq * 100 : null,
    });
  }
  return windows;
}

function main() {
  let allTrades = [];
  for (const f of REGIME_FILES) {
    const bars = load(f);
    if (!bars) continue;
    allTrades.push({ file: f, bars });
  }

  console.log('═'.repeat(80));
  console.log(' CAN DSH-V2 CLEAR A 50K EVAL IN ONE MONTH?');
  console.log(` Target $${TARGET} · hard floor $${DD_LIMIT} · ${TRADING_DAYS}-trading-day rolling windows`);
  console.log(' Real MNQ 1H data, Sep 2025 - Aug 2026 (5 regimes). Risk cap scaled WITH size.');
  console.log('═'.repeat(80));
  console.log();
  // Every trading day present in the data, across all regimes.
  const dayset = new Set();
  for (const { bars } of allTrades) {
    for (const b of bars) dayset.add(new Date(b.time * 1000).toISOString().slice(0, 10));
  }
  const calendarDays = Array.from(dayset).sort();
  console.log(`  ${calendarDays.length} trading days of real data → ${calendarDays.length - TRADING_DAYS + 1} overlapping one-month windows`);
  console.log();
  console.log('  size   months  hit $3k   BLEW UP   median net   worst month   best month');
  console.log('  ' + '─'.repeat(74));

  const rows = [];
  for (const contracts of [2, 3, 4, 5, 6, 7, 8]) {
    let trades = [];
    for (const { bars } of allTrades) trades = trades.concat(runStrategy(bars, contracts));
    trades.sort((a, b) => a.time - b.time);
    const w = rollingMonths(trades, calendarDays);
    if (!w.length) { console.log(`  ${String(contracts).padStart(3)}c   (not enough trading days)`); continue; }
    const nets = w.map((x) => x.net).sort((a, b) => a - b);
    const median = nets[Math.floor(nets.length / 2)];
    const hit = w.filter((x) => x.hitTarget).length;
    const blew = w.filter((x) => x.blewUp).length;
    rows.push({ contracts, w, hit, blew, median });
    const pct = (n) => `${n} (${(100 * n / w.length).toFixed(0)}%)`;
    console.log(`  ${String(contracts).padStart(3)}c   ${String(w.length).padStart(4)}    ${pct(hit).padEnd(10)}${pct(blew).padEnd(11)}` +
      `${fmt(median).padStart(9)}    ${fmt(nets[0]).padStart(9)}     ${fmt(nets[nets.length - 1]).padStart(9)}`);
  }

  // The decisive comparison: reaching the target vs surviving the path.
  console.log('\n' + '─'.repeat(80));
  console.log(' THE TRADE-OFF, STATED PLAINLY');
  console.log('─'.repeat(80));
  for (const r of rows) {
    const survived = r.w.filter((x) => x.hitTarget && !x.blewUp).length;
    const pct = (100 * survived / r.w.length).toFixed(0);
    console.log(`  ${String(r.contracts).padStart(3)}c  →  ${String(survived).padStart(3)}/${r.w.length} months reached $3,000 WITHOUT breaching the floor  (${pct}%)`);
  }

  if (!rows.length) { console.log('  no size produced a testable window'); return; }
  const best = rows.reduce((a, b) => {
    const sa = a.w.filter((x) => x.hitTarget && !x.blewUp).length / a.w.length;
    const sb = b.w.filter((x) => x.hitTarget && !x.blewUp).length / b.w.length;
    return sb > sa ? b : a;
  });
  const bestPct = (100 * best.w.filter((x) => x.hitTarget && !x.blewUp).length / best.w.length).toFixed(0);
  console.log(`\n  Best size tested: ${best.contracts} contracts, succeeding in ${bestPct}% of one-month windows.`);
  console.log('  Read that as the probability of clearing the eval in a month — and its complement');
  console.log('  as the probability of failing or blowing the account.');
  console.log('─'.repeat(80));
}

function fmt(v) { return (v < 0 ? '-$' : '+$') + Math.abs(v).toFixed(0); }

main();
