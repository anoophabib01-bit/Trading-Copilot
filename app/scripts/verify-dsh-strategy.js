#!/usr/bin/env node
'use strict';
// ── Independent verification of DSH's V2 strategy (2026-08-26) ─────────────
// DSH's "long-only, strong-uptrend breakout" is the first candidate in this
// repo to survive out-of-sample testing, and its own report is unusually
// honest about its limits. This re-derives it rather than trusting it, and
// tests the one thing the report does not: SIZE.
//
// ── THE GAP THIS EXISTS TO CLOSE ───────────────────────────────────────────
// Every DSH result is computed at ONE contract (`risk*pv*1` in
// test_final_strategy.js). rules.json sets BOTH sizeFloor and sizeCap to 2,
// and the sizeFloor comment is emphatic about why: one-lot trades lost money
// in both stages of Anoop's real history because the wins were too small to
// pay for the losses. He cannot trade the size this was validated at.
//
// That is not a rounding difference. `perTradeMaxLoss` is $300, so at 2
// contracts every setup risking more than 75 points is REFUSED — a filter
// that does not exist at 1 contract, where the same limit permits 150 points.
// Doubling size does not double the result; it changes which trades happen.
//
// Reimplemented here rather than imported so this is a genuine second
// opinion on the rule, while still using the SAME simulateTrade (pessimistic
// fills, stop-wins-ties, real commission, 03:00 IST flatten) so the execution
// model is not a second variable.

const fs = require('fs');
const path = require('path');
const backtest = require('../backtest');

const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
const PV = backtest.MNQ_POINT_VALUE;
const REGIMES = {
  'Sep-Nov up (held out)': 'mnq_1h_sepnov.json',
  'Nov-Jan flat (held out)': 'mnq_1h_flat.json',
  'Feb-Mar down (held out)': 'mnq_1h_downtrend.json',
  'Apr-May up (held out)': 'mnq_1h_uptrend.json',
  'Jun-Aug (in-sample)': 'mnq_60.json',
};

function load(file) {
  const p = path.join(__dirname, '..', '..', 'DATA', 'bars', file);
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (d.bars || d).filter((b) => b && typeof b.time === 'number' && typeof b.close === 'number');
}

// Wilder ADX/DI. Causal: index i depends only on bars <= i.
function adxSeries(bars, period) {
  const n = bars.length;
  const tr = new Array(n).fill(0), pDM = new Array(n).fill(0), mDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high, dn = bars[i - 1].low - bars[i].low;
    pDM[i] = (up > dn && up > 0) ? up : 0;
    mDM[i] = (dn > up && dn > 0) ? dn : 0;
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  }
  const plusDI = new Array(n).fill(NaN), minusDI = new Array(n).fill(NaN);
  const dx = new Array(n).fill(NaN), adx = new Array(n).fill(NaN);
  let a = 0, pd = 0, md = 0;
  for (let i = 1; i <= period; i++) { a += tr[i]; pd += pDM[i]; md += mDM[i]; }
  const di = (i) => {
    plusDI[i] = a > 0 ? 100 * pd / a : 0; minusDI[i] = a > 0 ? 100 * md / a : 0;
    const s = plusDI[i] + minusDI[i];
    dx[i] = s > 0 ? 100 * Math.abs(plusDI[i] - minusDI[i]) / s : 0;
  };
  di(period);
  let ds = 0;
  for (let i = period + 1; i <= period * 2; i++) { a = a - a / period + tr[i]; pd = pd - pd / period + pDM[i]; md = md - md / period + mDM[i]; di(i); ds += dx[i]; }
  adx[period * 2] = ds / period;
  for (let i = period * 2 + 1; i < n; i++) {
    a = a - a / period + tr[i]; pd = pd - pd / period + pDM[i]; md = md - md / period + mDM[i]; di(i);
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }
  return { adx, plusDI, minusDI };
}

function run(bars, opts) {
  const { lookback, adxMin, contracts, dailyCap } = opts;
  const { adx, plusDI, minusDI } = adxSeries(bars, 14);
  const buf = RULES.playbooks.stopBufferPoints, rr = RULES.playbooks.targetR;
  const horizon = RULES.playbooks.outcomeHorizonBars;
  const comm = RULES.commissionPerContractPerSide * 2 * contracts;
  const trades = [];
  let blockedBig = 0, blockedSmall = 0, cappedOut = 0;
  const dayPnl = {};

  const warmup = Math.max(lookback + 2, 30);
  for (let i = warmup; i < bars.length; i++) {
    const bar = bars[i];
    if (!(adx[i] >= adxMin && plusDI[i] > minusDI[i])) continue;
    let hi = -Infinity;
    for (let k = i - lookback; k < i; k++) hi = Math.max(hi, bars[k].high);   // excludes bar i — no look-ahead
    if (!(bar.close > hi && bar.close > bar.open)) continue;

    const entry = bar.close, stop = bar.low - buf, risk = entry - stop;
    if (!(risk > 0)) continue;

    // The size-dependent gate. At 1 contract this admits 150pt stops; at 2 it
    // admits 75pt. This is the whole reason for this script.
    const riskUsd = risk * PV * contracts;
    if (RULES.playbooks.minRiskPoints && risk < RULES.playbooks.minRiskPoints) { blockedSmall++; continue; }
    if (riskUsd > RULES.perTradeMaxLoss) { blockedBig++; continue; }

    const day = new Date(bar.time * 1000).toISOString().slice(0, 10);
    // Consistency rule: stop opening new trades once the day is already up by
    // the cap. Enforced BEFORE entry, as it would be live.
    if (dailyCap && (dayPnl[day] || 0) >= dailyCap) { cappedOut++; continue; }

    const sim = backtest.simulateTrade(
      { playbook: 'C-ADX', direction: 'BULLISH', entry, stop, target: entry + risk * rr, requiresFill: false },
      bars, i, { horizonBars: horizon, slippagePoints: 0.5, flattenByISTMinutes: RULES.flattenByISTMinutes }
    );
    if (!sim) continue;
    const net = sim.points * PV * contracts - comm;
    dayPnl[day] = (dayPnl[day] || 0) + net;
    trades.push({ time: bar.time, day, net, riskUsd, outcome: sim.outcome });
  }
  return { trades, blockedBig, blockedSmall, cappedOut, dayPnl };
}

function stats(trades) {
  if (!trades.length) return null;
  const net = trades.reduce((a, t) => a + t.net, 0);
  const wins = trades.filter((t) => t.net > 0), losses = trades.filter((t) => t.net <= 0);
  const gw = wins.reduce((a, t) => a + t.net, 0), gl = -losses.reduce((a, t) => a + t.net, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of trades) { eq += t.net; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const byDay = {};
  for (const t of trades) byDay[t.day] = (byDay[t.day] || 0) + t.net;
  const days = Object.values(byDay);
  const best = Math.max(...days);
  return {
    n: trades.length, net, winPct: wins.length / trades.length * 100,
    pf: gl > 0 ? gw / gl : null, dd, bestDay: best,
    consistency: net > 0 ? best / net * 100 : null,
    tradingDays: days.length,
  };
}

function line(label, s, extra) {
  if (!s) { console.log(`  ${label.padEnd(24)} no trades`); return; }
  console.log(`  ${label.padEnd(24)} ${String(s.n).padStart(3)}t  ${s.winPct.toFixed(0).padStart(3)}%  ` +
    `${(s.net >= 0 ? '+$' : '-$') + Math.abs(s.net).toFixed(0).padStart(5)}  ` +
    `PF ${s.pf == null ? ' n/a' : s.pf.toFixed(2).padStart(4)}  DD $${s.dd.toFixed(0).padStart(4)}` + (extra || ''));
}

function main() {
  const dailyCap = 1000;
  console.log('═'.repeat(78));
  console.log(' INDEPENDENT VERIFICATION — DSH V2 (long-only, ADX>=35, 10-bar breakout)');
  console.log(' Same rule, re-derived. Same simulateTrade (stop-wins-ties, slippage, 03:00 IST flatten).');
  console.log('═'.repeat(78));

  for (const contracts of [1, 2]) {
    const isHis = contracts === RULES.sizeFloor;
    console.log(`\n${'─'.repeat(78)}`);
    console.log(` AT ${contracts} CONTRACT${contracts > 1 ? 'S' : ''}  ${isHis ? '← THE SIZE HIS RULES ACTUALLY REQUIRE (sizeFloor=sizeCap=2)' : '(DSH tested here; rules.json forbids this size)'}`);
    console.log(` per-trade max loss $${RULES.perTradeMaxLoss} = max stop of ${(RULES.perTradeMaxLoss / PV / contracts).toFixed(0)} points at this size`);
    console.log('─'.repeat(78));

    let all = [], totalBlockedBig = 0, totalCapped = 0;
    for (const [label, file] of Object.entries(REGIMES)) {
      const bars = load(file);
      if (!bars) { console.log(`  ${label.padEnd(24)} DATA MISSING`); continue; }
      const r = run(bars, { lookback: 10, adxMin: 35, contracts, dailyCap });
      totalBlockedBig += r.blockedBig; totalCapped += r.cappedOut;
      line(label, stats(r.trades), r.blockedBig ? `   (${r.blockedBig} blocked: stop too wide)` : '');
      all = all.concat(r.trades);
    }
    const agg = stats(all);
    console.log('  ' + '·'.repeat(74));
    line('AGGREGATE', agg);
    if (agg) {
      const ddLimit = 2000, target = 3000;   // 50K account, assumed — see backtest-playbooks.js
      console.log(`  ${''.padEnd(24)} consistency ${agg.consistency == null ? 'n/a' : agg.consistency.toFixed(0) + '%'} (rule: under 40%)` +
                  `   best day $${agg.bestDay.toFixed(0)}`);
      console.log(`  ${''.padEnd(24)} drawdown $${agg.dd.toFixed(0)} of the $${ddLimit} 50K limit ` +
                  `(${(agg.dd / ddLimit * 100).toFixed(0)}% used)`);
      const perMonth = agg.net / 9;
      console.log(`  ${''.padEnd(24)} ~$${perMonth.toFixed(0)}/month over 9 months → ` +
                  `${perMonth > 0 ? Math.ceil(target / perMonth) + ' months to $3,000' : 'never reaches target'}`);
      console.log(`  ${''.padEnd(24)} ${totalBlockedBig} setups refused for stop width, ${totalCapped} refused by the daily cap`);
    }
  }

  // ── DSH's 16-cell robustness grid, re-run at the size he must trade ──────
  // The published grid ("ALL 16 cells POSITIVE") is entirely at 1 contract.
  // perTradeMaxLoss binds on SIZE, so the grid has to be re-derived at 2
  // before "broad plateau" means anything for him.
  console.log('\n' + '═'.repeat(78));
  console.log(' ROBUSTNESS GRID AT 2 CONTRACTS — net$ (PF, consistency%)');
  console.log(' DSH published this grid at 1 contract, where all 16 cells were positive.');
  console.log('═'.repeat(78));
  const barsByRegime = Object.entries(REGIMES).map(([l, f]) => [l, load(f)]).filter(([, b]) => b);
  console.log('  lookback |' + [25, 30, 35, 40].map((a) => ('   ADX>=' + a).padEnd(21)).join(''));
  let positive = 0, tradeable = 0, cells = 0;
  for (const lookback of [5, 10, 15, 20]) {
    let row = '      ' + String(lookback).padEnd(3) + '  |';
    for (const adxMin of [25, 30, 35, 40]) {
      let all = [];
      for (const [, bars] of barsByRegime) all = all.concat(run(bars, { lookback, adxMin, contracts: 2, dailyCap }).trades);
      const s2 = stats(all);
      cells++;
      if (s2 && s2.net > 0) positive++;
      if (s2 && s2.net > 0 && s2.consistency != null && s2.consistency < 40) tradeable++;
      const cell = s2
        ? (s2.net >= 0 ? '+$' : '-$') + Math.abs(s2.net).toFixed(0) +
          ' (' + (s2.pf == null ? 'n/a' : s2.pf.toFixed(2)) + ', ' +
          (s2.consistency == null ? 'n/a' : s2.consistency.toFixed(0) + '%') + ')'
        : 'none';
      row += ('  ' + cell).padEnd(21);
    }
    console.log(row);
  }
  console.log('\n  ' + positive + '/' + cells + ' cells positive at 2 contracts.');
  console.log('  ' + tradeable + '/' + cells + ' are also UNDER the 40% consistency rule — i.e. actually tradeable on the eval.');

  console.log('\n' + '═'.repeat(78));
  console.log(' Read the 2-contract numbers. That is the only size he is permitted to trade.');
  console.log('═'.repeat(78));
}

main();
