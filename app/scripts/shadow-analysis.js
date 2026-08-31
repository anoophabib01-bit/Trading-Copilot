#!/usr/bin/env node
'use strict';
// ── Shadow analysis — "what separates my good trades from my bad ones?" ────
// Reads DATA/autonomy/shadow-orders.jsonl and answers the question Anoop
// actually asked, in the only form that can be answered honestly.
//
// It does NOT describe his winners. Describing winners alone always produces
// something and that something is almost always worthless — see
// shadow-recorder.js's header. Every feature is scored on how often it appears
// in WINNERS versus LOSERS, and the gap between those two rates (`lift`) is
// the only column that carries information.
//
// Usage: node scripts/shadow-analysis.js [--min 20]

const path = require('path');
const store = require('../autonomy-store');
const { discriminate } = require('../shadow-recorder');

// ── THE BIGGER PICTURE ─────────────────────────────────────────────────────
// Machine shadow and human shadow each answer half a question. Together they
// answer the one that actually decides whether control should be handed over:
// on the same market, does Anoop's discretion ADD value or subtract it?
//
// Reported side by side rather than as a single "who won" verdict, because
// the two are not sampled identically — the machine trades every signal it
// sees, Anoop trades a subset plus trades no signal called. Expectancy per
// trade is the comparable figure; totals are not.
function machineVsHuman(dataDir, human) {
  const store = require('../autonomy-store');
  const sizes = new Set(store.readJsonl(dataDir, 'shadow-orders.jsonl')
    .filter((o) => o && (o.kind === 'machine-order' || o.kind == null) && o.contracts != null)
    .map((o) => o.contracts));

  console.log('\n  ' + '─'.repeat(72));
  console.log('  MACHINE vs YOU — the number that decides whether to hand over control');
  console.log('  ' + '─'.repeat(72));

  const hWins = human.filter((r) => r.outcome === 'win');
  const hLosses = human.filter((r) => r.outcome === 'loss');
  const hScored = hWins.length + hLosses.length;
  const hNet = human.reduce((a, r) => a + (Number(r.pnl) || 0), 0);

  if (!sizes.size) {
    console.log('  No machine orders resolved yet — nothing to compare against.');
    console.log('  The machine side needs signals to fire AND their horizon to elapse.');
  } else {
    for (const c of Array.from(sizes).sort((a, b) => a - b)) {
      const ev = store.evidence(dataDir, null, c);
      if (!ev.resolvedTrades) { console.log(`  machine @${c}c   no resolved orders yet`); continue; }
      const exp = ev.netUsd / ev.resolvedTrades;
      console.log(`  machine @${String(c).padStart(2)}c   ${String(ev.resolvedTrades).padStart(3)} trades   ` +
        `net ${usd(ev.netUsd).padStart(9)}   per-trade ${usd(exp).padStart(8)}   ` +
        `PF ${ev.profitFactor == null ? 'n/a' : ev.profitFactor.toFixed(2)}   maxDD ${usd(-(ev.maxDrawdownUsd || 0))}`);
    }
  }
  if (hScored) {
    console.log(`  YOU          ${String(hScored).padStart(3)} trades   ` +
      `net ${usd(hNet).padStart(9)}   per-trade ${usd(hNet / Math.max(1, human.length)).padStart(8)}   ` +
      `win rate ${(100 * hWins.length / hScored).toFixed(0)}%`);
  } else {
    console.log('  YOU          no scored trades yet');
  }
  console.log('\n  Compare PER-TRADE, not totals — you and the machine do not take the');
  console.log('  same number of trades, so a bigger total can just mean more trades.');
}

// The last few shadow tickets, in the same shape the app chat shows them:
// direction, stop and target in dollars AND ticks, and why it confirmed.
function recentTickets(dataDir) {
  const store = require('../autonomy-store');
  const rows = store.readJsonl(dataDir, 'shadow-orders.jsonl')
    .filter((o) => o && (o.kind === 'machine-order' || o.kind == null));
  // One ticket per SETUP — the same signal is recorded once per shadow size,
  // and listing each size as its own ticket would treble the apparent number
  // of setups.
  const bySetup = new Map();
  for (const o of rows) {
    // Fall back to the id with its trailing size segment stripped. Rows
    // written before setupId was carried through end in "|4c"/"|6c", so
    // keying on the raw id would split one setup into one ticket per size.
    const k = o.setupId || String(o.id || '').replace(/\|\d+c$/, '');
    if (!bySetup.has(k)) bySetup.set(k, []);
    bySetup.get(k).push(o);
  }
  const setups = Array.from(bySetup.values()).slice(-5);
  if (!setups.length) return;

  console.log('\n  ' + '─'.repeat(72));
  console.log('  LAST ' + setups.length + ' SHADOW TICKET(S) — none of these were placed');
  console.log('  ' + '─'.repeat(72));
  for (const group of setups) {
    const t = group[0];
    const px = (v) => (typeof v === 'number' ? v.toFixed(2) : '?');
    console.log(`\n  Playbook ${t.playbook} ${t.direction} on ${t.tf}M · ${(t.ts || '').slice(0, 16).replace('T', ' ')}Z`);
    console.log(`    Entry ${px(t.entry)}  Stop ${px(t.stop)}  Target ${px(t.target)}` +
                (t.rMultiple ? `  ${t.rMultiple}R` : ''));
    for (const o of group.sort((a, b) => (a.contracts || 0) - (b.contracts || 0))) {
      const sd = o.stopDistance, td = o.targetDistance;
      if (!sd) {
        // Pre-fix rows have no tick/dollar breakdown, but their risk flag
        // still matters and must not be swallowed by the missing-data branch.
        const note = o.blocked ? `   BLOCKED: ${o.blockedReason || o.blocked}` : '';
        console.log(`    @${o.contracts}c   risk $${o.riskUsd != null ? o.riskUsd.toFixed(0) : '?'} (recorded before the tick/dollar breakdown existed)${note}`);
        continue;
      }
      const line = `    @${o.contracts}c   SL ${String(sd.ticks).padStart(4)} ticks / $${String(sd.usd.toFixed(0)).padStart(5)}` +
                   `   TP ${String(td ? td.ticks : '?').padStart(4)} ticks / $${String(td ? td.usd.toFixed(0) : '?').padStart(5)}`;
      console.log(o.blocked ? `${line}   BLOCKED: ${o.blockedReason || o.blocked}` : line);
    }
    if (t.why && t.why.length) {
      console.log('    Why it confirmed:');
      t.why.forEach((w, i) => console.log(`      ${i + 1}. ${w}`));
    }
  }
}

function usd(v) { return (v < 0 ? '-$' : '+$') + Math.abs(Number(v) || 0).toFixed(2); }

function main() {
  let minSample = 20;
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--min') minSample = parseInt(process.argv[++i], 10);

  const dataDir = path.join(__dirname, '..', '..', 'DATA');
  const rows = store.readJsonl(dataDir, 'shadow-orders.jsonl');
  // `excluded` rows are quarantined records kept for provenance — duplicate
  // re-folds, or rows whose behavioural fields were captured before the
  // day/slot fix. Counting them would put known-wrong data into the very
  // comparison the whole thing exists to make.
  const human = rows.filter((r) => r.kind === 'human-trade' && !r.excluded);
  const quarantined = rows.filter((r) => r.kind === 'human-trade' && r.excluded).length;
  const machine = rows.filter((r) => r.kind === 'machine-order');

  console.log('═'.repeat(76));
  console.log(' SHADOW ANALYSIS — what separates your winners from your losers');
  console.log('═'.repeat(76));
  console.log(`  your trades recorded    ${human.length}`);
  console.log(`  machine orders recorded ${machine.length}  (never submitted)`);
  if (quarantined) console.log(`  quarantined             ${quarantined} (duplicate re-folds — kept on disk, excluded from every number)`);

  const wins = human.filter((r) => r.outcome === 'win').length;
  const losses = human.filter((r) => r.outcome === 'loss').length;
  const be = human.filter((r) => r.outcome === 'breakeven').length;
  console.log(`  wins ${wins} · losses ${losses} · break-even ${be} (excluded — neither to copy nor avoid)`);

  // Tickets and the machine-vs-you table render FIRST and UNCONDITIONALLY.
  // The feature comparison needs both winners and losers before it can say
  // anything, but the ticket list is useful from the very first setup —
  // gating it behind a statistical precondition is why the display Anoop
  // asked for would otherwise have stayed invisible for weeks.
  recentTickets(dataDir);
  machineVsHuman(dataDir, human);

  if (!wins || !losses) {
    console.log(`\n  Feature comparison needs BOTH winners and losers — a feature only`);
    console.log(`  predicts if it separates the two. Have ${wins} win(s) and ${losses} loss(es) so far.`);
    console.log('─'.repeat(76));
    return;
  }

  console.log('\n  feature                                  in wins  in losses   lift   verdict');
  console.log('  ' + '─'.repeat(72));
  for (const f of discriminate(human, { minSample })) {
    if (f.winRate == null) continue;
    const pct = (v) => (v * 100).toFixed(0).padStart(4) + '%';
    const lift = (f.lift >= 0 ? '+' : '') + (f.lift * 100).toFixed(0) + '%';
    console.log(`  ${f.feature.padEnd(40)}${pct(f.winRate)}     ${pct(f.lossRate)}  ${lift.padStart(6)}   ${f.verdict}`);
  }

  console.log('\n  READ THE LIFT COLUMN, NOT THE "IN WINS" COLUMN.');
  console.log('  A feature in 90% of your winners is worthless if it is also in 90% of');
  console.log('  your losers. Only the gap between the two columns is an edge.');
  console.log('─'.repeat(76));
}

main();
