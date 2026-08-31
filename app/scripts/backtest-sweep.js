#!/usr/bin/env node
'use strict';
// ── Parameter sensitivity sweep (2026-08-26) ───────────────────────────────
// A single backtest result is one point, and every number feeding it —
// targetR, stop buffer, horizon, fill window — was a JUDGEMENT, not a
// measurement. rules.json's playbooks block says so in its own comment.
//
// So the honest question is not "did Playbook B make money at 2R over 12
// bars", it is "is the sign of the result stable across the settings I could
// just as reasonably have picked?" A strategy that is profitable at 2R and
// ruinous at 1.5R has not been shown to work; it has been fitted. And a
// strategy that loses across the whole grid is not suffering from a badly
// chosen target.
//
// This deliberately does NOT report a best cell and does not suggest one.
// Picking the top of a grid searched on 8.5 days of bars is overfitting with
// extra steps, and the resulting number would be the most confident and
// least trustworthy thing in the repo. It reports the DISTRIBUTION, and the
// share of the grid that is profitable at all.
//
// Usage: node scripts/backtest-sweep.js [--playbook B] [--contracts 2]

const fs = require('fs');
const path = require('path');
const backtest = require('../backtest');

const TARGET_R = [1, 1.5, 2, 2.5, 3];
const HORIZONS = [6, 12, 24, 48];
const STOP_BUFFERS = [1, 3, 6];

function loadBars(dir, tf) {
  const f = path.join(dir, `mnq_${tf}.json`);
  if (!fs.existsSync(f)) return null;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  return (d.bars || d).filter((b) => b && typeof b.time === 'number');
}

function main() {
  const argv = process.argv;
  let only = null, contracts = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--playbook') only = argv[++i];
    else if (argv[i] === '--contracts') contracts = parseInt(argv[++i], 10);
  }
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
  const barsDir = path.join(__dirname, '..', '..', 'DATA', 'bars');
  const b30 = loadBars(barsDir, '30');
  const b60 = loadBars(barsDir, '60');
  const b240 = loadBars(barsDir, '240');
  const size = contracts || base.sizeCap;

  const runs = [];
  const want = (id) => !only || only.toUpperCase() === id;

  for (const targetR of TARGET_R) {
    for (const outcomeHorizonBars of HORIZONS) {
      for (const stopBufferPoints of STOP_BUFFERS) {
        const rules = JSON.parse(JSON.stringify(base));
        Object.assign(rules.playbooks, { targetR, outcomeHorizonBars, stopBufferPoints });

        if (want('B') && b30) {
          const r = backtest.runPlaybookB(b30, rules, { contracts: size });
          runs.push({ pb: 'B', targetR, outcomeHorizonBars, stopBufferPoints, ...backtest.score(r.trades, rules, { contracts: size }), blocked: r.blocked.length });
        }
        if (want('A') && b60 && b240) {
          const r = backtest.runEngulfPlaybook('A', b60, b240, rules, { htfSeconds: 4 * 3600, contracts: size });
          runs.push({ pb: 'A', targetR, outcomeHorizonBars, stopBufferPoints, ...backtest.score(r.trades, rules, { contracts: size }), blocked: r.blocked.length });
        }
      }
    }
  }

  const byPb = {};
  for (const r of runs) (byPb[r.pb] = byPb[r.pb] || []).push(r);

  console.log('═'.repeat(72));
  console.log(` PARAMETER SWEEP — ${TARGET_R.length}×${HORIZONS.length}×${STOP_BUFFERS.length} = ${TARGET_R.length * HORIZONS.length * STOP_BUFFERS.length} settings per playbook`);
  console.log(` targetR ${TARGET_R.join('/')} · horizon ${HORIZONS.join('/')} bars · stop buffer ${STOP_BUFFERS.join('/')}pt · ${size} contracts`);
  console.log('═'.repeat(72));

  for (const pb of Object.keys(byPb)) {
    const rs = byPb[pb].filter((r) => r.filled > 0);
    if (!rs.length) { console.log(`\n${pb}: no setting produced a resolved trade.`); continue; }
    const nets = rs.map((r) => r.netUsd).sort((a, b) => a - b);
    const profitable = rs.filter((r) => r.netUsd > 0).length;
    const median = nets[Math.floor(nets.length / 2)];
    const tradeCounts = rs.map((r) => r.filled);

    console.log(`\n── Playbook ${pb} ${'─'.repeat(52)}`);
    console.log(`  settings that resolved any trade   ${rs.length}/${byPb[pb].length}`);
    console.log(`  PROFITABLE settings                ${profitable}/${rs.length}  (${(100 * profitable / rs.length).toFixed(0)}%)`);
    console.log(`  net P&L across the grid            worst ${fmt(nets[0])} · median ${fmt(median)} · best ${fmt(nets[nets.length - 1])}`);
    console.log(`  trades per setting                 ${Math.min(...tradeCounts)}–${Math.max(...tradeCounts)}`);
    // The verdict line states what the grid can and cannot support.
    if (profitable === 0) {
      console.log(`  → Loses money at EVERY setting tested. Not a tuning problem.`);
    } else if (profitable === rs.length) {
      console.log(`  → Profitable at every setting tested. Sign is stable; magnitude is not established.`);
    } else {
      console.log(`  → Sign FLIPS across the grid: the result depends on settings that were guessed, not measured.`);
      console.log(`    Do not read the best cell as the answer — on this sample size that is curve-fitting.`);
    }
  }

  // Hold time is a separate axis and a rules question, not a P&L one.
  console.log('\n' + '─'.repeat(72));
  const holdRuns = byPb['B'] ? byPb['B'].filter((r) => r.filled > 0) : [];
  if (holdRuns.length) {
    const maxHoldMin = (base.maxHoldSeconds || 0) / 60;
    console.log(` HOLD-TIME CONFLICT: rules.json maxHoldSeconds = ${base.maxHoldSeconds}s (${maxHoldMin} min).`);
    console.log(` Playbook B runs on 30M bars, so ${maxHoldMin} minutes is ONE bar. A 2R target`);
    console.log(` cannot resolve inside one 30M bar except by luck. The hold rule and the`);
    console.log(` playbook's timeframe are describing two different trading styles.`);
  }
  console.log('─'.repeat(72));
}

function fmt(v) { return (v < 0 ? '-$' : '+$') + Math.abs(v).toFixed(0); }

main();
