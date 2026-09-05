#!/usr/bin/env node
// ── Risk protocol conformance check ─────────────────────────────────────────
//
// Answers one question the trader has been unable to answer for six months:
// which of these rules is actually enforced, and which is only written down?
//
// For every entry in risk-protocol.js it verifies:
//   1. the number exists in rules.json at the declared path (no code literals)
//   2. the enforcing file exists and contains the declared symbol
//   3. the module it depends on exists
//   4. the test file exists
//
// A rule that fails any of these is reported as DRIFT — the exact condition
// that let "Max 2 contracts. Hard cap. No exceptions." sit in the rulebook
// while rules.json said 6 and nothing enforced either.
//
//   node scripts/risk-protocol-check.js          human report
//   node scripts/risk-protocol-check.js --json   machine output
//
// Exit code is 1 on any drift, so this can gate a commit if you ever want it to.

'use strict';

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const { PROTOCOL, STRENGTH, resolveNumber } = require(path.join(APP, 'risk-protocol.js'));
const rules = JSON.parse(fs.readFileSync(path.join(APP, 'rules.json'), 'utf8'));

const exists = (rel) => fs.existsSync(path.join(APP, rel));
function fileHasSymbol(rel, symbol) {
  try {
    const src = fs.readFileSync(path.join(APP, rel), 'utf8');
    // Word-boundary match so `enforcePerTradeStop` does not match a comment
    // mentioning `enforcePerTradeStopSomethingElse`.
    return new RegExp('\\b' + symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(src);
  } catch (e) { return false; }
}

const report = PROTOCOL.map((r) => {
  const problems = [];

  const paths = [r.number].concat(r.bounds || []).filter(Boolean);
  const numbers = {};
  for (const p of paths) {
    const v = resolveNumber(rules, p);
    numbers[p] = v;
    if (v === undefined || v === null) problems.push(`rules.json is missing "${p}"`);
  }

  if (r.enforcedIn) {
    if (!exists(r.enforcedIn.file)) problems.push(`enforcing file missing: ${r.enforcedIn.file}`);
    else if (!fileHasSymbol(r.enforcedIn.file, r.enforcedIn.symbol)) {
      problems.push(`${r.enforcedIn.file} no longer contains ${r.enforcedIn.symbol}()`);
    }
  } else problems.push('no enforcement site declared');

  if (r.module && !exists(r.module)) problems.push(`module missing: ${r.module}`);
  if (!r.test) problems.push('no test declared');
  else if (!exists(r.test)) problems.push(`test file missing: ${r.test}`);

  return { id: r.id, title: r.title, strength: r.strength, numbers, problems, ok: problems.length === 0 };
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: report.every((r) => r.ok), report }, null, 2));
  process.exit(report.every((r) => r.ok) ? 0 : 1);
}

const pad = (s, n) => String(s).padEnd(n);
const bar = '─'.repeat(78);
console.log('\nRISK MANAGEMENT PROTOCOL — conformance\n' + bar);

for (const strength of [STRENGTH.BLOCKS, STRENGTH.REACTS, STRENGTH.ADVISORY]) {
  const rows = report.filter((r) => r.strength === strength);
  if (!rows.length) continue;
  const note = strength === STRENGTH.BLOCKS ? 'refuses the action before it happens'
    : strength === STRENGTH.REACTS ? 'cannot prevent it; acts immediately after'
      : 'says something; changes nothing on its own';
  console.log(`\n${strength}  — ${note}`);
  for (const r of rows) {
    const nums = Object.entries(r.numbers).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ');
    console.log(`  ${r.ok ? 'OK  ' : 'DRIFT'} ${pad(r.id, 24)} ${nums}`);
    if (!r.ok) r.problems.forEach((p) => console.log(`        ! ${p}`));
  }
}

const drift = report.filter((r) => !r.ok);
const blocks = report.filter((r) => r.strength === STRENGTH.BLOCKS).length;
const advis = report.filter((r) => r.strength === STRENGTH.ADVISORY).length;

console.log('\n' + bar);
console.log(`${report.length} rules — ${blocks} block, ${report.length - blocks - advis} react, ${advis} advisory only.`);
console.log(drift.length ? `${drift.length} WITH DRIFT — a rule that cannot be verified is an intention, not a rule.`
  : 'No drift: every rule has a number in rules.json, a live enforcement site, and a test.');
console.log('\nCeiling on all of it: these govern orders THIS APP places. None can stop an order');
console.log('typed straight into TradingView — which is how all five account-killing trades happened.\n');

process.exit(drift.length ? 1 : 0);
