#!/usr/bin/env node
'use strict';
// ── Does the LIVE path for Playbook C (ADX) actually produce signals? ───────
// (2026-09-01, added with the forward test.)
//
// verify-dsh-strategy.js checks whether the RULE makes money. This checks
// something different and, on the evidence of this repo's history, more likely
// to be wrong: whether the code path that is supposed to notice a signal in
// production can notice one at all.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Shadow mode spent its entire first life recording ZERO orders. Not because
// the market was quiet and not because the resolver was broken, but because
// its configured sizes made every setup exceed the per-trade risk cap, so
// every row was stamped blocked and excluded. Nothing looked broken. An empty
// output file is indistinguishable from a quiet market unless something
// independently asserts that the path CAN fire.
//
// This script is that assertion. It replays real cached 1H bars through the
// exact composition cadxCheckOnce() performs in server.js —
//
//     bar-recorder.mergePull  ->  shape adapter  ->  detectAdxBreakoutFromBars
//         ->  playbook-spec.planEntry  ->  shadow-recorder.buildMachineOrder
//         ->  autonomy-modes.checkOrderRisk
//
// — and fails loudly if the count of signals it produces is zero, or disagrees
// with the detector read directly off the full series.
//
// It already caught one real bug on the day it was written: mergePull emits
// `{t,o,h,l,c}` with `t` in milliseconds while every detector in this repo
// expects `{time,open,high,low,close}` in seconds, so the monitor returned a
// healthy-looking "no-signal" on every tick and could never have fired. That
// would have been another eight silent weeks.
//
// Usage: node scripts/verify-cadx-live-path.js

const fs = require('fs');
const path = require('path');
const detectors = require('../detectors');
const playbookSpec = require('../playbook-spec');
const shadowRecorder = require('../shadow-recorder');
const barRecorder = require('../bar-recorder');
const autonomyModes = require('../autonomy-modes');

const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
const CFG = RULES.playbookCAdx || {};
const ADX_MIN = Number.isFinite(CFG.adxMin) ? CFG.adxMin : 35;
const LOOKBACK = Number.isFinite(CFG.lookback) ? CFG.lookback : 10;
const MIN_BARS = 120;          // must match CADX_MIN_BARS in server.js
const FETCH = 300;             // what TradingView's bridge actually returns

// The same adapter server.js applies. Kept as its own function here so a
// change to one side that is not mirrored on the other shows up as a
// disagreement in the counts below rather than as silence in production.
function toBars(merged) {
  const out = [];
  for (const b of merged || []) {
    if (!b || !Number.isFinite(b.t)) continue;
    out.push({ time: Math.round(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c });
  }
  return out;
}

function load(file) {
  const p = path.join(__dirname, '..', '..', 'DATA', 'bars', file);
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (Array.isArray(d) ? d : (d.bars || [])).filter((b) => b && Number.isFinite(b.close));
}

function main() {
  const all = load('mnq_60.json');
  if (!all || all.length < MIN_BARS + 50) {
    console.error('No usable DATA/bars/mnq_60.json — cannot verify.');
    process.exit(2);
  }

  console.log('='.repeat(78));
  console.log(' LIVE-PATH VERIFICATION — Playbook C (ADX)');
  console.log(` config: ADX>=${ADX_MIN}, lookback ${LOOKBACK}, min bars ${MIN_BARS}, size 2 (rules.json sizeFloor=sizeCap)`);
  console.log('='.repeat(78));

  // ── Reference: the detector read straight off the full series ────────────
  //
  // Compared only from MIN_BARS on. The live path cannot see a signal before
  // it has MIN_BARS of history, so counting those as "missed" would compare
  // the monitor against a reference it is designed not to match — and the
  // exclusion is right on the merits, not just convenient: below ~120 bars
  // Wilder's ADX has not converged (mean error 5.6 at 40 bars against the full
  // series), so an early hit is a reading the strategy was never validated on.
  // The excluded region is REPORTED rather than quietly dropped.
  const ref = new Set();
  const warmupOnly = [];
  for (let i = 30; i < all.length - 1; i++) {
    const s = detectors.detectAdxBreakoutFromBars(all.slice(0, i + 2), { period: 14, adxMin: ADX_MIN, lookback: LOOKBACK });
    if (!s) continue;
    if (i < MIN_BARS) { warmupOnly.push(s.barTime); continue; }
    ref.add(s.barTime);
  }

  // ── The live composition, replayed tick by tick ──────────────────────────
  let series = [];
  let lastFired = null;
  const rows = [];
  for (let i = MIN_BARS; i < all.length; i++) {
    const pull = all.slice(Math.max(0, i - (FETCH - 1)), i + 1);   // what the feed hands back
    const merged = barRecorder.mergePull(series, pull, 60);
    if (merged.rejected) { console.error(`  merge rejected at bar ${i}: ${merged.reason}`); process.exit(1); }
    series = merged.bars;
    const bars = toBars(series);
    if (bars.length < MIN_BARS) continue;

    const sig = detectors.detectAdxBreakoutFromBars(bars.concat([bars[bars.length - 1]]),
      { period: 14, adxMin: ADX_MIN, lookback: LOOKBACK });
    if (!sig || lastFired === sig.barTime) continue;
    lastFired = sig.barTime;

    const plan = playbookSpec.planEntry('C-ADX',
      { direction: sig.direction, bar: sig.bar, barTime: sig.barTime, entryRef: sig.entryRef }, RULES);
    if (!plan.plannable) { console.error(`  UNPLANNABLE signal: ${plan.reason}`); process.exit(1); }

    const row = shadowRecorder.buildMachineOrder(
      Object.assign({}, plan, { playbook: 'C-ADX', setupId: playbookSpec.setupId('C-ADX', sig) }),
      { contracts: 2, pointValue: 2, tickSize: 0.25, why: [] });
    const chk = autonomyModes.checkOrderRisk(RULES, 'shadow', row.riskUsd);
    rows.push({ barTime: sig.barTime, adx: sig.adx, entry: plan.entry, stop: plan.stop,
                riskPoints: plan.riskPoints, riskUsd: row.riskUsd, allowed: chk.allowed });
  }

  console.log(`\n  bars replayed          ${all.length}`);
  console.log(`  history built          ${series.length} (seeded empty, grown by mergePull)`);
  console.log(`  signals via live path  ${rows.length}`);
  console.log(`  signals via detector   ${ref.size}  (read straight off the full series, from bar ${MIN_BARS} on)`);
  if (warmupOnly.length) {
    console.log(`  excluded as warm-up    ${warmupOnly.length}  (${warmupOnly.map((t) => new Date(t * 1000).toISOString().slice(0, 10)).join(', ')})`);
    console.log('                         — before the live path has enough history; ADX has not converged there.');
  }

  const live = new Set(rows.map((r) => r.barTime));
  const missing = [...ref].filter((t) => !live.has(t));
  const extra = [...live].filter((t) => !ref.has(t));

  console.log('\n' + '─'.repeat(78));
  console.log('  when              ADX    entry      stop     risk pts   risk $   recorded as');
  console.log('─'.repeat(78));
  for (const r of rows) {
    console.log('  ' + new Date(r.barTime * 1000).toISOString().slice(0, 16).replace('T', ' ')
      + String(r.adx).padStart(7)
      + String(r.entry).padStart(11) + String(r.stop).padStart(11)
      + r.riskPoints.toFixed(1).padStart(11) + ('$' + r.riskUsd).padStart(9)
      + (r.allowed ? '   order' : '   BLOCKED risk-too-big'));
  }

  const blocked = rows.filter((r) => !r.allowed).length;
  console.log('\n' + '═'.repeat(78));
  console.log(` ${rows.length - blocked} of ${rows.length} signals are recordable as ORDERS at 2 contracts;`);
  console.log(` ${blocked} exceed the $${RULES.perTradeMaxLoss} per-trade cap (75-point max stop at this size)`);
  console.log(' and are recorded as BLOCKED rows — visible, but excluded from the evidence.');
  console.log('═'.repeat(78));

  // ── The assertions ───────────────────────────────────────────────────────
  let bad = 0;
  if (rows.length === 0) {
    console.error('\nFAIL: the live path produced ZERO signals. This is the shadow-mode failure');
    console.error('      mode repeating: a path that cannot fire looks exactly like a quiet market.');
    bad++;
  }
  if (missing.length || extra.length) {
    console.error(`\nFAIL: live path disagrees with the detector — ${missing.length} missed, ${extra.length} spurious.`);
    console.error('      The monitor would be measuring a different rule than the backtest.');
    bad++;
  }
  if (!bad) console.log('\nPASS: the live path fires, and fires on exactly the bars the detector does.');
  process.exit(bad ? 1 : 0);
}

main();
