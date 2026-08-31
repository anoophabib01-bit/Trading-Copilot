#!/usr/bin/env node
'use strict';
// ── Autonomy report — what the CONTROL toggle has actually done ────────────
// Reads DATA/autonomy/ and answers two questions in one screen:
//   1. Who has been in charge, and what did the gate decide?
//   2. What is still missing before LIVE is permitted?
//
// (2) is the point. A gate that only says "no" gets ripped out; one that
// prints the remaining requirements as a to-do list is something you can
// work towards.
//
// Usage: node scripts/autonomy-report.js [--playbook B]

const path = require('path');
const fs = require('fs');
const store = require('../autonomy-store');
const gate = require('../autonomy-gate');

function main() {
  let playbook = 'B';
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--playbook') playbook = process.argv[++i];
  }
  const dataDir = path.join(__dirname, '..', '..', 'DATA');
  const rulesPath = path.join(__dirname, '..', 'rules.json');
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

  const state = store.readState(dataDir);
  const ev = store.evidence(dataDir, 'shadow', playbook);
  ev.accountDrawdownLimitUsd = (rules.eval && rules.eval.maxDrawdown) || null;
  ev.playbook = playbook;
  const result = gate.evaluate(state, ev);
  const badge = gate.badge(result);

  console.log('═'.repeat(64));
  console.log(' CONTROL — ' + badge.text);
  console.log('═'.repeat(64));
  console.log(` requested mode   ${state.mode}`);
  console.log(` effective mode   ${result.effectiveMode}`);
  console.log(` armed by         ${state.armedBy || '(nobody)'}${state.armedAt ? ' at ' + state.armedAt : ''}`);
  console.log(` shadow days      ${state.shadowDays}`);
  console.log();
  console.log(' ' + result.summary);

  console.log('\n── Track record (playbook ' + playbook + ') ' + '─'.repeat(28));
  console.log(`  resolved trades  ${ev.resolvedTrades}`);
  console.log(`  profit factor    ${ev.profitFactor == null ? 'not measurable yet' : ev.profitFactor.toFixed(2)}`);
  console.log(`  net              ${ev.netUsd == null ? 'n/a' : (ev.netUsd < 0 ? '-$' : '+$') + Math.abs(ev.netUsd).toFixed(2)}`);
  console.log(`  max drawdown     ${ev.maxDrawdownUsd == null ? 'n/a' : '$' + ev.maxDrawdownUsd.toFixed(2)}`);

  if (result.blockers.length) {
    console.log('\n── Still required before LIVE ' + '─'.repeat(34));
    result.blockers.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
  } else if (result.effectiveMode === 'live') {
    console.log('\n  All requirements met. The app may place orders.');
  }

  const decisions = store.readRootJsonl(dataDir, 'decisions.jsonl');
  if (decisions.length) {
    console.log('\n── Last 10 decisions ' + '─'.repeat(43));
    for (const d of decisions.slice(-10)) {
      console.log(`  ${(d.ts || '').slice(0, 19)}  ${d.kind || '?'}  ${d.requested || ''} → ${d.effective || ''}` +
                  (d.allowed === false ? '  REFUSED' : ''));
    }
  } else {
    console.log('\n  No decisions recorded yet — the toggle has never been used.');
  }

  console.log('\n Full record: ' + path.join(dataDir, 'autonomy'));
  console.log('─'.repeat(64));
}

main();
