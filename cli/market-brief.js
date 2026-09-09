'use strict';
// ── market-brief.js — the pre-New-York-session brief ────────────────────────
//
//   node cli/market-brief.js            # terminal brief for MNQ + MGC
//   node cli/market-brief.js --json     # machine-readable, same numbers
//   node cli/market-brief.js --save     # also writes cli/briefs/<date>.json
//
// Anoop, 2026-09-06: "i want market brief before newyork session and if any
// important event or any sudden movement in both instrument and all
// information related to it."
//
// ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ──────────────────────────
// It is a DESCRIPTION of what happened overnight, with every unusual figure
// stated as a percentile against this instrument's own recent history — so
// "wide range" means "wider than 87% of the last 60 sessions", not a feeling.
//
// It is NOT a direction, a bias, a setup, or a confidence score. There is no
// field in the output that says long or short, and that is a design decision
// rather than an omission. This repo's own failure-chain analysis says the
// damage comes from escalation after a loss, not from a shortage of market
// opinion; a brief that arrives before the session and offers a lean is a
// brief that hands the rationalising voice a starting position. Every number
// here is a fact about the tape, and the ALERTS section only ever raises
// reasons for CAUTION — never reasons to act.
//
// Same boundary as market-cli.js: nothing here may raise a size, loosen a
// gate, or add conviction.

const fs = require('node:fs');
const path = require('node:path');
const Y = require('./yahoo');
const EC = require('./econ-calendar');

const BRIEFS_DIR = path.join(__dirname, 'briefs');

// ── small stats ────────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}
// Share of the sample strictly below v, as a 0-100 percentile.
function percentileOf(sample, v) {
  if (!sample.length) return null;
  let below = 0;
  for (const x of sample) if (x < v) below++;
  return Math.round((below / sample.length) * 100);
}
const round = (v, d = 2) => (v == null || !isFinite(v) ? null : Number(v.toFixed(d)));

// ── sessionize ─────────────────────────────────────────────────────────────
// Splits a continuous futures tape into { rth, overnight } per trading day.
// The overnight block that PRECEDES an RTH open is filed under that open's
// day, because that is the block a trader reads before the bell.
//
// Day assignment avoids calendar arithmetic entirely: the RTH day keys present
// in the data are the only valid targets, so an overnight bar is attached to
// the first RTH day at or after it. That is exact across weekends, holidays
// and both DST shifts without any offset maths.
function sessionize(bars) {
  const rthDays = [];
  const seen = new Set();
  for (const b of bars) {
    if (!Y.isRTH(b.t)) continue;
    const k = Y.etParts(b.t).dayKey;
    if (!seen.has(k)) { seen.add(k); rthDays.push(k); }
  }
  rthDays.sort();

  const firstAtOrAfter = (key) => {
    for (const d of rthDays) if (d >= key) return d;
    return null;
  };
  const firstAfter = (key) => {
    for (const d of rthDays) if (d > key) return d;
    return null;
  };

  const out = new Map();
  const bucket = (k) => {
    if (!out.has(k)) out.set(k, { day: k, rth: [], overnight: [] });
    return out.get(k);
  };

  for (const b of bars) {
    const p = Y.etParts(b.t);
    if (Y.isRTH(b.t)) { bucket(p.dayKey).rth.push(b); continue; }
    const target = p.minutes < Y.RTH_OPEN_MIN ? firstAtOrAfter(p.dayKey) : firstAfter(p.dayKey);
    if (target) bucket(target).overnight.push(b);
  }
  return out;
}

// ── per-instrument analysis ────────────────────────────────────────────────
async function analyseInstrument(spec) {
  const res = await Y.fetchBars(spec.y, { interval: '5m', range: '60d' });
  if (!res.ok) return { ...spec, ok: false, error: res.error };

  const bars = res.bars;
  const sessions = [...sessionize(bars).values()].sort((a, b) => a.day.localeCompare(b.day));
  if (sessions.length < 2) return { ...spec, ok: false, error: 'not enough sessions' };

  // The pending day is the last bucket, whose RTH has not happened yet (or is
  // only partly formed). The prior COMPLETE RTH is the last one before it.
  const pending = sessions[sessions.length - 1];
  const priorSessions = sessions.slice(0, -1).filter((s) => s.rth.length > 0);
  const prior = priorSessions[priorSessions.length - 1];
  if (!prior) return { ...spec, ok: false, error: 'no complete prior RTH session' };

  const priorRTH = Y.ohlcOf(prior.rth);
  const overnight = Y.ohlcOf(pending.overnight);
  const last = bars[bars.length - 1];

  // Baseline distributions from complete prior sessions only — never includes
  // the partial session being described, which would drag its own percentile.
  //
  // The gap baseline MUST measure the same quantity as the live gap below:
  // "how far has price travelled from the last RTH close to the end of the
  // overnight block". The first draft compared it against (RTH open − that
  // session's overnight close), which is the jump at the bell — a much smaller
  // number — so every live gap scored in the 100th percentile and the brief
  // announced a record gap every single day. Percentiles are only meaningful
  // between like quantities, and a mismatched one fails loudly enough to look
  // convincing.
  const onRanges = [], rthRanges = [], gaps = [];
  for (let i = 0; i < priorSessions.length; i++) {
    const s = priorSessions[i];
    const on = Y.ohlcOf(s.overnight);
    const r = Y.ohlcOf(s.rth);
    if (on) onRanges.push(on.h - on.l);
    if (r) rthRanges.push(r.h - r.l);
    if (on && i > 0) {
      const prevRTH = Y.ohlcOf(priorSessions[i - 1].rth);
      if (prevRTH) gaps.push(Math.abs(on.c - prevRTH.c));
    }
  }

  // 5m move distribution, in points, over the whole 60-day window. Used to
  // z-score overnight bars — "sudden" means large against this instrument's
  // own recent behaviour, not against a fixed threshold.
  const moves = [];
  for (let i = 1; i < bars.length; i++) moves.push(bars[i].c - bars[i - 1].c);
  const sd = stdev(moves);

  let sudden = [];
  if (overnight && pending.overnight.length > 1) {
    const on = pending.overnight;
    for (let i = 1; i < on.length; i++) {
      const move = on[i].c - on[i - 1].c;
      const z = sd > 0 ? move / sd : 0;
      if (Math.abs(z) >= 3) {
        sudden.push({
          t: on[i].t, at: Y.fmtBoth(on[i].t),
          move: round(move, 2), z: round(z, 1),
          usd: round(Math.abs(move) / spec.tick * spec.tickValue, 0),
          from: round(on[i - 1].c, 2), to: round(on[i].c, 2),
        });
      }
    }
    sudden.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    sudden = sudden.slice(0, 5);
  }

  const onRange = overnight ? overnight.h - overnight.l : null;
  const gap = overnight && priorRTH ? overnight.c - priorRTH.c : null;
  const posInRange = overnight && onRange > 0
    ? Math.round(((overnight.c - overnight.l) / onRange) * 100) : null;

  const ptToUsd = (p) => (p == null ? null : round(Math.abs(p) / spec.tick * spec.tickValue, 0));

  return {
    ...spec, ok: true,
    last: { price: round(last.c, 2), t: last.t, at: Y.fmtBoth(last.t) },
    priorRTH: priorRTH && {
      day: prior.day,
      o: round(priorRTH.o, 2), h: round(priorRTH.h, 2),
      l: round(priorRTH.l, 2), c: round(priorRTH.c, 2),
      range: round(priorRTH.h - priorRTH.l, 2),
      rangePct: percentileOf(rthRanges, priorRTH.h - priorRTH.l),
      volume: priorRTH.v,
    },
    overnight: overnight && {
      h: round(overnight.h, 2), l: round(overnight.l, 2),
      c: round(overnight.c, 2), range: round(onRange, 2),
      rangePct: percentileOf(onRanges, onRange),
      rangeVsMedian: round(onRange / (mean(onRanges) || 1), 2),
      posInRange, bars: overnight.n, volume: overnight.v,
      from: Y.fmtBoth(overnight.from), to: Y.fmtBoth(overnight.to),
    },
    gap: gap == null ? null : {
      pts: round(gap, 2),
      pct: priorRTH ? round((gap / priorRTH.c) * 100, 2) : null,
      usd: ptToUsd(gap),
      dir: gap > 0 ? 'up' : gap < 0 ? 'down' : 'flat',
      percentile: percentileOf(gaps, Math.abs(gap)),
    },
    sudden,
    move5mSd: round(sd, 2),
    sessionsAnalysed: priorSessions.length,
  };
}

// ── cross-market context ───────────────────────────────────────────────────
async function analyseContext(contextList) {
  const out = [];
  for (const c of (contextList || Y.CONTEXT)) {
    const isIndex = c.kind === 'index';
    const interval = isIndex ? '1d' : '15m';
    const range = isIndex ? '1y' : '60d';
    const res = await Y.fetchBars(c.y, { interval, range, timeout: 120000 });
    if (!res.ok || res.bars.length < 3) {
      out.push({ ...c, ok: false, error: res.error || 'no bars' });
      continue;
    }
    const b = res.bars;
    const closes = b.map((x) => x.c);
    const last = b[b.length - 1];

    let ref, refLabel;
    if (isIndex) {
      ref = b[b.length - 2].c;
      refLabel = 'prior daily close';
    } else {
      // Continuous future: compare against the prior RTH close, not the prior
      // bar — with the market shut those two bars are the same print.
      const sessions = [...sessionize(b).values()].sort((a, z) => a.day.localeCompare(z.day));
      const complete = sessions.filter((s) => s.rth.length > 0);
      const prevRTH = complete.length ? Y.ohlcOf(complete[complete.length - 1].rth) : null;
      ref = prevRTH ? prevRTH.c : b[b.length - 2].c;
      refLabel = prevRTH ? 'prior RTH close' : 'prior bar';
    }

    out.push({
      ...c, ok: true,
      last: round(last.c, 2),
      chg: round(last.c - ref, 2),
      chgPct: round(((last.c - ref) / ref) * 100, 2),
      refLabel,
      percentile: percentileOf(closes, last.c),
      n: b.length,
    });
  }
  return out;
}

// ── alerts ─────────────────────────────────────────────────────────────────
// CAUTION only. Nothing here is ever phrased as an opportunity, and there is
// deliberately no bullish/bearish field to read a lean out of.
function buildAlerts(instruments, context) {
  const alerts = [];
  for (const ins of instruments) {
    if (!ins.ok) {
      alerts.push({ level: 'error', instrument: ins.label, text: 'data unavailable: ' + ins.error });
      continue;
    }
    if (ins.overnight && ins.overnight.rangePct != null && ins.overnight.rangePct >= 80) {
      alerts.push({
        level: 'high', instrument: ins.label,
        text: 'Overnight range ' + ins.overnight.range + ' pts is wider than '
          + ins.overnight.rangePct + '% of the last ' + ins.sessionsAnalysed
          + ' sessions (' + ins.overnight.rangeVsMedian + 'x the mean).',
      });
    }
    if (ins.gap && ins.gap.percentile != null && ins.gap.percentile >= 80) {
      alerts.push({
        level: 'high', instrument: ins.label,
        text: 'Gap ' + ins.gap.dir + ' ' + Math.abs(ins.gap.pts) + ' pts ($'
          + ins.gap.usd + '/contract) vs prior RTH close — larger than '
          + ins.gap.percentile + '% of recent gaps.',
      });
    }
    if (ins.sudden && ins.sudden.length) {
      const s = ins.sudden[0];
      alerts.push({
        level: 'high', instrument: ins.label,
        text: ins.sudden.length + ' sudden move' + (ins.sudden.length > 1 ? 's' : '')
          + ' overnight. Largest ' + s.move + ' pts ($' + s.usd + '/contract) in one 5m bar at '
          + s.at + ' — ' + Math.abs(s.z) + ' sigma.',
      });
    }
    if (ins.overnight && ins.overnight.rangePct != null && ins.overnight.rangePct <= 15) {
      alerts.push({
        level: 'note', instrument: ins.label,
        text: 'Overnight range compressed — narrower than '
          + (100 - ins.overnight.rangePct) + '% of recent sessions. Thin premarket ranges '
          + 'expand on the open more often than they persist.',
      });
    }
  }
  const vix = context.find((c) => c.label === 'VIX');
  if (vix && vix.ok && vix.chgPct != null && Math.abs(vix.chgPct) >= 8) {
    alerts.push({
      level: 'high', instrument: 'VIX',
      text: 'VIX ' + (vix.chgPct > 0 ? 'up' : 'down') + ' ' + Math.abs(vix.chgPct)
        + '% to ' + vix.last + ' (' + vix.percentile + 'th percentile of the last year).',
    });
  }
  return alerts;
}

// ── render ─────────────────────────────────────────────────────────────────
function pad(s, n) { return String(s).padEnd(n); }

function render(brief) {
  const L = [];
  const bar = '─'.repeat(66);
  L.push('');
  L.push('  MARKET BRIEF — pre New York session');
  L.push('  ' + brief.now.at);
  L.push('  ' + (brief.now.minutesToOpen === 0
    ? 'NY session is OPEN'
    : 'NY open in ' + Math.floor(brief.now.minutesToOpen / 60) + 'h '
      + (brief.now.minutesToOpen % 60) + 'm'));
  L.push(bar);

  for (const i of brief.instruments) {
    L.push('');
    if (!i.ok) { L.push('  ' + i.label + '  —  UNAVAILABLE: ' + i.error); continue; }
    L.push('  ' + i.label + '  ' + i.name + '   ' + i.last.price + '   (' + i.last.at + ')');
    if (i.gap) {
      L.push('    ' + pad('Gap vs prior close', 22)
        + (i.gap.pts > 0 ? '+' : '') + i.gap.pts + ' pts  '
        + (i.gap.pct > 0 ? '+' : '') + i.gap.pct + '%  $' + i.gap.usd + '/contract'
        + (i.gap.percentile != null ? '   [' + i.gap.percentile + 'th pct]' : ''));
    }
    if (i.priorRTH) {
      L.push('    ' + pad('Prior RTH ' + i.priorRTH.day, 22)
        + 'H ' + i.priorRTH.h + '   L ' + i.priorRTH.l + '   C ' + i.priorRTH.c
        + '   range ' + i.priorRTH.range);
    }
    if (i.overnight) {
      L.push('    ' + pad('Overnight', 22)
        + 'H ' + i.overnight.h + '   L ' + i.overnight.l
        + '   range ' + i.overnight.range
        + (i.overnight.rangePct != null ? '  [' + i.overnight.rangePct + 'th pct]' : ''));
      L.push('    ' + pad('', 22) + 'price sits ' + i.overnight.posInRange
        + '% up the overnight range');
    }
    if (i.sudden && i.sudden.length) {
      L.push('    ' + pad('Sudden moves', 22) + i.sudden.length + ' bar(s) beyond 3 sigma');
      for (const s of i.sudden.slice(0, 3)) {
        L.push('    ' + pad('', 22) + (s.move > 0 ? '+' : '') + s.move + ' pts  '
          + s.z + ' sigma  $' + s.usd + '   ' + s.at);
      }
    } else {
      L.push('    ' + pad('Sudden moves', 22) + 'none beyond 3 sigma');
    }
  }

  L.push('');
  L.push(bar);
  L.push('  CONTEXT');
  for (const c of brief.context) {
    if (!c.ok) { L.push('    ' + pad(c.label, 8) + 'unavailable'); continue; }
    L.push('    ' + pad(c.label, 8) + pad(c.last, 10)
      + pad((c.chgPct > 0 ? '+' : '') + c.chgPct + '%', 9)
      + pad('[' + c.percentile + 'th pct]', 14) + c.why);
  }

  L.push('');
  L.push(bar);
  if (brief.alerts.length) {
    L.push('  ALERTS — reasons for caution only. None of these is a setup.');
    for (const a of brief.alerts) {
      L.push('    [' + a.level.toUpperCase() + '] ' + a.instrument + ': ' + a.text);
    }
  } else {
    L.push('  ALERTS   none — overnight was unremarkable on every measure checked.');
  }

  L.push('');
  L.push(bar);
  L.push('  EVENT RISK   ' + brief.eventRisk.status);
  L.push('    ' + brief.eventRisk.note);
  for (const w of (brief.eventRisk.windows || [])) {
    L.push('    tier ' + w.tier + '  ' + w.key.padEnd(8) + w.at);
  }
  L.push('');
  L.push('  Source: Yahoo Finance /v8 chart via yahoo-finance-pp-cli. Delayed data.');
  L.push('  Percentiles are against this instrument\'s own last '
    + (brief.instruments.find((i) => i.ok) || {}).sessionsAnalysed + ' sessions.');
  L.push('  No directional view is expressed anywhere above, by design.');
  L.push('');
  return L.join('\n');
}

// ── main ───────────────────────────────────────────────────────────────────
// `opts.symbols` narrows which of Y.SYMBOLS to analyse (default: all — MNQ +
// MGC, the combined brief). `opts.context` overrides the context list (default
// Y.CONTEXT). gold-brief.js calls this with { symbols: ['MGC'], context:
// Y.GOLD_CONTEXT } so the two briefs share every line of session/sudden-move/
// alert logic and can never drift against each other.
async function buildBrief(opts) {
  const symbolKeys = (opts && opts.symbols) || Object.keys(Y.SYMBOLS);
  const contextList = (opts && opts.context) || Y.CONTEXT;

  const nowSec = Math.floor(Date.now() / 1000);
  const instruments = [];
  for (const key of symbolKeys) {
    instruments.push(await analyseInstrument(Y.SYMBOLS[key]));
  }
  const context = await analyseContext(contextList);
  const alerts = buildAlerts(instruments, context);

  return {
    generatedAt: new Date().toISOString(),
    now: { at: Y.fmtBoth(nowSec), minutesToOpen: Y.minutesToNYOpen(nowSec) },
    instruments, context, alerts,
    eventRisk: await eventRisk(nowSec),
  };
}

// EVENT RISK reads the FRED calendar and FAILS CLOSED. An unreachable calendar
// reports UNKNOWN, never "clear" — a brief that goes quiet when its data source
// breaks would say exactly the same thing on a calm morning and on CPI day.
async function eventRisk(nowSec) {
  const cal = await EC.fetchCalendar({ days: 7 });
  if (!cal.ok) {
    return {
      status: 'UNKNOWN', blocked: true, windows: [],
      note: cal.reason + ' — treat event risk as UNKNOWN, not as absent.',
    };
  }
  const verdict = EC.isBlackout(cal.windows, nowSec);
  const upcoming = cal.windows.filter((w) => w.to > nowSec).slice(0, 5);
  return {
    status: verdict.blocked ? 'BLACKOUT' : 'CLEAR',
    blocked: verdict.blocked,
    reason: verdict.reason,
    next: verdict.next || null,
    windows: upcoming.map((w) => ({ key: w.key, at: w.atLabel, name: w.name, tier: w.tier })),
    note: verdict.blocked
      ? verdict.reason
      : (verdict.next
        ? 'Next scheduled mover: ' + verdict.next.key + ' in ' + verdict.next.inMinutes + ' minutes.'
        : 'No tier-1 release scheduled in the next 7 days.'),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const brief = await buildBrief();

  if (argv.includes('--json')) {
    console.log(JSON.stringify(brief, null, 2));
  } else {
    console.log(render(brief));
  }

  if (argv.includes('--save')) {
    fs.mkdirSync(BRIEFS_DIR, { recursive: true });
    const day = Y.etParts(Math.floor(Date.now() / 1000)).dayKey;
    const file = path.join(BRIEFS_DIR, day + '.json');
    fs.writeFileSync(file, JSON.stringify(brief, null, 2));
    console.error('saved -> ' + path.relative(path.join(__dirname, '..'), file));
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

// ── ratioSeries — PURE, used by gold-brief.js for the gold/silver ratio ────
// Pairs two bar arrays by nearest-timestamp match rather than by index: MGC
// and SI can each have gaps at slightly different bars (a thin-liquidity print
// missing on one contract but not the other), and index-pairing would silently
// misalign every bar after the first gap. Returns [{t, ratio}], ascending.
// maxSkewSec bounds how far apart two "matched" bars may be — default 150s
// (2.5x a 5m bar) so a pairing across a real data hole is dropped rather than
// treated as simultaneous.
function ratioSeries(barsA, barsB, maxSkewSec) {
  const skew = maxSkewSec || 150;
  const out = [];
  let j = 0;
  for (let i = 0; i < barsA.length; i++) {
    const a = barsA[i];
    while (j < barsB.length - 1 && Math.abs(barsB[j + 1].t - a.t) <= Math.abs(barsB[j].t - a.t)) j++;
    const b = barsB[j];
    if (b && Math.abs(b.t - a.t) <= skew && b.c > 0) {
      out.push({ t: a.t, ratio: a.c / b.c });
    }
  }
  return out;
}

module.exports = {
  buildBrief, render, sessionize, analyseInstrument, analyseContext,
  buildAlerts, percentileOf, stdev, mean, ratioSeries, BRIEFS_DIR,
};
