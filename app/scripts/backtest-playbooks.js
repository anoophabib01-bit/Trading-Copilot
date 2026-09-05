#!/usr/bin/env node
'use strict';
// ── Playbook backtest runner (2026-08-26) ──────────────────────────────────
// Runs backtest.js over saved bar files and prints a report.
//
// Bars come from a FILE, not a live TradingView call, deliberately: a
// backtest you cannot re-run on the identical input is not a measurement,
// it is an anecdote. Pull once with scripts/pull-bars.js, commit the numbers
// you got, and any future change to a detector can be diffed against exactly
// the same history.
//
// Usage:
//   node scripts/pull-bars.js                       # writes DATA/bars/*.json
//   node scripts/backtest-playbooks.js              # all playbooks
//   node scripts/backtest-playbooks.js --playbook B
//   node scripts/backtest-playbooks.js --bars <dir> --contracts 2 --json

const fs = require('fs');
const path = require('path');
const backtest = require('../backtest');
const spec = require('../playbook-spec');

// ── Account tiers ─────────────────────────────────────────────────────────
// rules.json's `eval` block is configured for a 150K account (start 150000,
// target 9000, max drawdown 4500). Anoop stated on 2026-08-26 that he
// "majorly uses 50K accounts, not 150K", so every eval projection computed
// from rules.json alone has been answering the wrong question.
//
// THE 50K FIGURES BELOW ARE ASSUMPTIONS, NOT CONFIRMED, and are printed as
// such on every run. They are the commonly published Tradeify shape (6%
// target, 4% max drawdown) — NOT read from his dashboard. They live here in
// the harness rather than in rules.json ON PURPOSE: rules.json drives the
// LIVE drawdown guardrail, and writing a guessed 2000 into it would either
// halt a session that was fine or, far worse, be wrong in the loose
// direction. A reporting assumption is recoverable; a guessed safety limit
// is not. Confirm the real numbers, then change rules.json once.
const ACCOUNT_TIERS = {
  '50k':  { label: '50K',  start: 50000,  profitTarget: 3000, maxDrawdown: 2000, assumed: true },
  '150k': { label: '150K', start: 150000, profitTarget: 9000, maxDrawdown: 4500, assumed: false },
};

function parseArgs(argv) {
  const out = { contracts: null, playbook: null, json: false, bars: null, account: '50k' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--contracts') out.contracts = parseInt(argv[++i], 10);
    else if (a === '--playbook') out.playbook = argv[++i];
    else if (a === '--bars') out.bars = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--account') out.account = String(argv[++i]).toLowerCase();
  }
  return out;
}

function loadBars(dir, tf) {
  const f = path.join(dir, `mnq_${tf}.json`);
  if (!fs.existsSync(f)) return null;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const bars = Array.isArray(d) ? d : (d.bars || []);
  return bars.filter((b) => b && typeof b.time === 'number' && typeof b.close === 'number');
}

function fmtSpan(bars) {
  if (!bars || !bars.length) return 'no bars';
  const f = new Date(bars[0].time * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const l = new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return `${bars.length} bars, ${f} → ${l} UTC`;
}

function spanDays(bars) {
  if (!bars || bars.length < 2) return null;
  return (bars[bars.length - 1].time - bars[0].time) / 86400;
}

function pct(v) { return v == null ? 'n/a' : (v * 100).toFixed(1) + '%'; }
function usd(v) { return v == null ? 'n/a' : (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2); }

function blockedSummary(blocked) {
  const by = {};
  for (const b of blocked || []) by[b.code] = (by[b.code] || 0) + 1;
  return Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ');
}

function report(label, res, sc, extra, targetUsd) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
  const nb = (res.blocked || []).length;
  console.log(`  setups detected      ${sc.signals + nb}`);
  // Blocked setups are printed BEFORE the performance lines on purpose. They
  // are not a footnote — they are how often the detector proposed something
  // Anoop's own risk rules forbid, and a reader who meets the win rate first
  // has already formed a view by the time they reach it.
  if (nb) console.log(`  blocked by risk rule ${nb}   (${blockedSummary(res.blocked)}) — excluded from everything below`);
  if (sc.noFill) console.log(`  never filled         ${sc.noFill}   (retrace never came — no trade, not a loss)`);
  if (extra) console.log(`  ${extra}`);
  if (!sc.filled) { console.log('  NO RESOLVED TRADES — nothing to score.'); return; }
  console.log(`  trades taken         ${sc.filled}   (${sc.targets} target / ${sc.stops} stop / ${sc.timeouts} timeout)`);
  console.log(`  win rate             ${pct(sc.winRate)}   (${sc.wins}W / ${sc.losses}L)`);
  console.log(`  net @ ${sc.contracts} contracts   ${usd(sc.netUsd)}`);
  console.log(`  expectancy/trade     ${usd(sc.expectancyUsd)}`);
  console.log(`  avg win / avg loss   ${usd(sc.avgWinUsd)} / ${usd(sc.avgLossUsd)}`);
  console.log(`  profit factor        ${sc.profitFactor == null ? 'n/a' : sc.profitFactor}`);
  console.log(`  max drawdown         ${usd(sc.maxDrawdownUsd)}`);
  if (sc.frequency) {
    const f = sc.frequency;
    console.log(`  FREQUENCY            ${f.tradeableSetupsPerDay} tradeable setups/day over ${f.spanDays} days`);
    if (f.requiredExpectancyFor30Days != null) {
      console.log(`                       at that rate, clearing ${usd(targetUsd)} in 30 trading days needs ${usd(f.requiredExpectancyFor30Days)}/trade`);
    }
  }
  if (sc.evalProjection) {
    const p = sc.evalProjection;
    console.log(`  → EVAL: ~${p.tradesToTarget} trades to ${usd(p.targetUsd)} at this expectancy; drawdown headroom ${usd(p.ddHeadroom)} of ${usd(p.ddLimitUsd)}`);
  } else {
    console.log(`  → EVAL: not projected — needs >=10 resolved trades AND positive expectancy (TRUST-PROTOCOL Rule 1)`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
  const barsDir = args.bars || path.join(__dirname, '..', '..', 'DATA', 'bars');
  const contracts = args.contracts || rules.sizeCap;

  // Overlay the chosen account tier onto the rules the scorer reads, so
  // evalProjection answers the question about the account he actually trades.
  const tier = ACCOUNT_TIERS[args.account] || ACCOUNT_TIERS['50k'];
  rules.eval = Object.assign({}, rules.eval, { start: tier.start, profitTarget: tier.profitTarget, maxDrawdown: tier.maxDrawdown });

  if (!fs.existsSync(barsDir)) {
    console.error(`No bars at ${barsDir}. Run: node scripts/pull-bars.js`);
    process.exit(1);
  }

  const b15 = loadBars(barsDir, '15');
  const b30 = loadBars(barsDir, '30');
  const b60 = loadBars(barsDir, '60');
  const b240 = loadBars(barsDir, '240');

  console.log('═'.repeat(66));
  console.log(' PLAYBOOK BACKTEST — same detectors the live monitors fire on');
  console.log('═'.repeat(66));
  console.log(` 15M  ${fmtSpan(b15)}`);
  console.log(` 30M  ${fmtSpan(b30)}`);
  console.log(` 1H   ${fmtSpan(b60)}`);
  console.log(` 4H   ${fmtSpan(b240)}`);
  console.log(` size ${contracts} contracts · commission $${rules.commissionPerContractPerSide}/side · ` +
              `stop buffer ${rules.playbooks.stopBufferPoints}pt · target ${rules.playbooks.targetR}R · ` +
              `horizon ${rules.playbooks.outcomeHorizonBars} bars`);
  console.log(` account ${tier.label}: target $${tier.profitTarget} · max drawdown $${tier.maxDrawdown}` +
              (tier.assumed ? '   ⚠ ASSUMED FIGURES — verify against the Tradeify dashboard' : ''));

  const out = {};
  const want = (id) => !args.playbook || args.playbook.toUpperCase() === id;

  if (want('A')) {
    if (b60 && b240) {
      const r = backtest.runEngulfPlaybook('A', b60, b240, rules, { htfSeconds: 4 * 3600 });
      const sc = backtest.score(r.trades, rules, { contracts, spanDays: spanDays(b60) });
      out.A = { score: sc, rejects: r.rejects.length };
      report('PLAYBOOK A — 4H structure + 1H engulf', r, sc, `gate rejections      ${r.rejects.length}`, tier.profitTarget);
    } else console.log('\n  PLAYBOOK A skipped — needs 1H and 4H bars');
  }

  if (want('B')) {
    if (b30) {
      const r = backtest.runPlaybookB(b30, rules, {});
      const sc = backtest.score(r.trades, rules, { contracts, spanDays: spanDays(b30) });
      out.B = { score: sc, raids: r.raids.length };
      report('PLAYBOOK B — SFP raid + displacement FVG (30M)', r, sc, `liquidity raids seen ${r.raids.length}`, tier.profitTarget);
    } else console.log('\n  PLAYBOOK B skipped — needs 30M bars');
  }

  if (want('LTF-ENGULF')) {
    if (b30) {
      const r = backtest.runEngulfPlaybook('LTF-ENGULF', b30, null, rules, {});
      const sc = backtest.score(r.trades, rules, { contracts, spanDays: spanDays(b30) });
      out['LTF-ENGULF'] = { score: sc, rejects: r.rejects.length };
      report('LTF-ENGULF (what the app calls "Playbook C") — 30M engulf, no HTF gate', r, sc, `gate rejections      ${r.rejects.length}`, tier.profitTarget);
    }
  }

  console.log('\n' + '─'.repeat(66));
  console.log(' Playbook C is NOT scored here: it is a validity GATE, not a setup.');
  console.log(' Its effect is the "gate rejections" line on A and LTF-ENGULF above.');
  console.log(' Targets are an R multiple, NOT the rulebook\'s "exit at marker levels".');
  console.log(' Read results as: does the ENTRY+STOP have an edge — not the exit.');
  console.log('─'.repeat(66));

  if (args.json) console.log('\n' + JSON.stringify(out, null, 2));
}

main();
