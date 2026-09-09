'use strict';
// ── gold-brief.js — the MGC-only brief ──────────────────────────────────────
//
//   node cli/gold-brief.js            # terminal brief, MGC only
//   node cli/gold-brief.js --json     # machine-readable
//   node cli/gold-brief.js --save     # also writes cli/briefs/gold-<date>.json
//
// Anoop, 2026-09-07: "a second brief for MGC".
//
// ── WHY A SEPARATE SCRIPT AND NOT A SEPARATE ENGINE ────────────────────────
// This is MGC run through the SAME session/sudden-move/alert logic as
// market-brief.js — buildBrief() now takes { symbols, context } and this file
// just calls it with symbols:['MGC'] and a gold-specific context list. There
// is exactly one implementation of "what counts as a sudden move" and one of
// "what counts as an unusual gap"; a bug fix in market-brief.js fixes both
// briefs, and there is no way for the two to drift into disagreeing about the
// same MGC bar.
//
// What THIS file adds on top, unique to gold:
//
//   1. GOLD-SPECIFIC CONTEXT (cli/yahoo.js GOLD_CONTEXT): silver (for the
//      ratio below), TIP as a REAL-YIELD proxy (opposite sign convention from
//      the nominal 10Y/DXY in the combined brief — read the header note on
//      GOLD_CONTEXT before touching the alert logic), and XAU miners as a
//      sentiment gauge distinct from the metal price.
//
//   2. THE GOLD/SILVER RATIO. Verified 2026-09-07: SI=F carries the same
//      5m/60d depth as MGC=F (16,691 bars each), so the ratio is computed from
//      a like-for-like sample, not a shorter series padded with gaps.
//      `ratioSeries()` in market-brief.js pairs bars by nearest timestamp, not
//      by index — the two contracts don't always tick at the same second, and
//      index-pairing would silently misalign every bar after the first gap.
//
// Same boundary as everything else in cli/: this is a DESCRIPTION, never a
// direction. There is no "gold is cheap/rich vs silver" verdict anywhere
// below — only the ratio's current value and its percentile against its own
// recent history, exactly the same treatment market-brief.js gives a gap or
// a range.

const fs = require('node:fs');
const path = require('node:path');
const Y = require('./yahoo');
const MB = require('./market-brief');

const BRIEFS_DIR = path.join(__dirname, 'briefs');
const round = (v, d = 2) => (v == null || !isFinite(v) ? null : Number(v.toFixed(d)));

// ── the ratio panel ─────────────────────────────────────────────────────────
async function goldSilverRatio() {
  const [mgc, si] = await Promise.all([
    Y.fetchBars('MGC=F', { interval: '5m', range: '60d' }),
    Y.fetchBars('SI=F', { interval: '5m', range: '60d' }),
  ]);
  if (!mgc.ok || !si.ok) {
    return { ok: false, error: (mgc.error || si.error || 'fetch failed') };
  }

  const series = MB.ratioSeries(mgc.bars, si.bars);
  if (series.length < 30) return { ok: false, error: 'not enough paired bars for a ratio series' };

  const values = series.map((p) => p.ratio);
  const last = values[values.length - 1];
  const pct = MB.percentileOf(values.slice(0, -1), last);

  // A 20-session-ish trailing mean/stdev, same spirit as the sudden-move
  // z-score in market-brief.js — "unusual" is against THIS series' own
  // recent behaviour, not a hardcoded band.
  const recentWindow = values.slice(-1000); // ~3.5 trading days at 5m
  const mean = MB.mean(recentWindow);
  const sd = MB.stdev(recentWindow);
  const z = sd > 0 ? (last - mean) / sd : 0;

  return {
    ok: true,
    ratio: round(last, 3),
    percentile: pct,
    zVsRecent: round(z, 2),
    mgcPrice: round(mgc.bars[mgc.bars.length - 1].c, 2),
    silverPrice: round(si.bars[si.bars.length - 1].c, 2),
    sampleBars: series.length,
    note: 'Ratio = MGC close / SI close, paired by nearest timestamp (≤150s skew). '
      + 'Percentile and z-score are against this ratio’s own trailing history — '
      + 'this is a fact about relative pricing, not a cheap/rich call.',
  };
}

// ── render (terminal) ───────────────────────────────────────────────────────
function renderGold(brief, ratio) {
  const L = [];
  const bar = '─'.repeat(66);
  L.push('');
  L.push('  GOLD BRIEF — MGC-specific drivers');
  L.push('  ' + brief.now.at);
  L.push(bar);

  // Reuse market-brief's own instrument rendering by re-deriving just the MGC
  // block through the same code path a human would read in the combined
  // brief — done here as a light re-render rather than re-importing render()
  // wholesale, since that function also prints the combined-brief header/
  // context/alerts layout this file replaces with its own.
  const mgc = brief.instruments[0];
  if (!mgc.ok) {
    L.push('  MGC — UNAVAILABLE: ' + mgc.error);
  } else {
    L.push('');
    L.push('  MGC  ' + mgc.name + '   ' + mgc.last.price + '   (' + mgc.last.at + ')');
    if (mgc.gap) {
      L.push('    Gap vs prior close    ' + (mgc.gap.pts > 0 ? '+' : '') + mgc.gap.pts + ' pts  '
        + (mgc.gap.pct > 0 ? '+' : '') + mgc.gap.pct + '%  $' + mgc.gap.usd + '/contract'
        + (mgc.gap.percentile != null ? '   [' + mgc.gap.percentile + 'th pct]' : ''));
    }
    if (mgc.overnight) {
      L.push('    Overnight             H ' + mgc.overnight.h + '   L ' + mgc.overnight.l
        + '   range ' + mgc.overnight.range
        + (mgc.overnight.rangePct != null ? '  [' + mgc.overnight.rangePct + 'th pct]' : ''));
    }
    if (mgc.sudden && mgc.sudden.length) {
      L.push('    Sudden moves          ' + mgc.sudden.length + ' bar(s) beyond 3 sigma');
      for (const s of mgc.sudden.slice(0, 3)) {
        L.push('      ' + (s.move > 0 ? '+' : '') + s.move + ' pts  ' + s.z + ' sigma  $'
          + s.usd + '   ' + s.at);
      }
    } else {
      L.push('    Sudden moves          none beyond 3 sigma');
    }
  }

  L.push('');
  L.push(bar);
  L.push('  GOLD/SILVER RATIO');
  if (!ratio.ok) {
    L.push('    unavailable: ' + ratio.error);
  } else {
    L.push('    ratio ' + ratio.ratio + '   (MGC ' + ratio.mgcPrice + ' / SI ' + ratio.silverPrice + ')');
    L.push('    ' + (ratio.percentile != null ? '[' + ratio.percentile + 'th pct of the last 60d]' : '')
      + '   ' + ratio.zVsRecent + ' sigma vs its own recent (~3.5 trading day) mean');
    L.push('    ' + ratio.note);
  }

  L.push('');
  L.push(bar);
  L.push('  DRIVERS  (gold-specific)');
  for (const c of brief.context) {
    if (!c.ok) { L.push('    ' + c.label.padEnd(8) + 'unavailable'); continue; }
    L.push('    ' + c.label.padEnd(8) + String(c.last).padEnd(10)
      + ((c.chgPct > 0 ? '+' : '') + c.chgPct + '%').padEnd(9)
      + '[' + c.percentile + 'th pct]   ' + c.why);
  }

  L.push('');
  L.push(bar);
  if (brief.alerts.length) {
    L.push('  ALERTS — reasons for caution only. None of these is a setup.');
    for (const a of brief.alerts) {
      L.push('    [' + a.level.toUpperCase() + '] ' + a.instrument + ': ' + a.text);
    }
  } else {
    L.push('  ALERTS   none.');
  }

  L.push('');
  L.push(bar);
  L.push('  EVENT RISK   ' + brief.eventRisk.status);
  L.push('    ' + brief.eventRisk.note);

  L.push('');
  L.push('  Source: Yahoo Finance /v8 chart via yahoo-finance-pp-cli. Delayed data.');
  L.push('  TIP is a real-yield proxy: price UP = real yields DOWN = gold-bullish —');
  L.push('  the OPPOSITE sign convention from DXY/10Y in the combined Brief tab.');
  L.push('  No directional view is expressed anywhere above, by design.');
  L.push('');
  return L.join('\n');
}

// ── main ────────────────────────────────────────────────────────────────────
async function buildGoldBrief() {
  const [brief, ratio] = await Promise.all([
    MB.buildBrief({ symbols: ['MGC'], context: Y.GOLD_CONTEXT }),
    goldSilverRatio(),
  ]);
  return { ...brief, ratio };
}

async function main() {
  const argv = process.argv.slice(2);
  const full = await buildGoldBrief();

  if (argv.includes('--json')) {
    console.log(JSON.stringify(full, null, 2));
  } else {
    console.log(renderGold(full, full.ratio));
  }

  if (argv.includes('--save')) {
    fs.mkdirSync(BRIEFS_DIR, { recursive: true });
    const day = Y.etParts(Math.floor(Date.now() / 1000)).dayKey;
    const file = path.join(BRIEFS_DIR, 'gold-' + day + '.json');
    fs.writeFileSync(file, JSON.stringify(full, null, 2));
    console.error('saved -> ' + path.relative(path.join(__dirname, '..'), file));
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { buildGoldBrief, goldSilverRatio, renderGold };
