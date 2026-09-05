'use strict';
// ── forensics-report.js — the payload behind the Forensics tab ──────────────
//
// (2026-09-05, Anoop: "change all the necessary things need in the UI so that
// i can start seeing them and use them".)
//
// PURE. No I/O, no disk, no clock beyond what is passed in. The server reads
// day_trades from the active slot, hands it here, and sends the result down one
// WebSocket message. The renderer draws it and computes NOTHING — the same
// split week-report.js already uses, and for the same reason: a client that
// re-folds the numbers is how "expectancy" acquires two definitions.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE — coverage is reported, never
// papered over. Almost every trade on disk today has no MAE/MFE, because the
// bar archive only started collecting on 2026-09-05 and the 199 recovered
// trades pre-date it. A tab that quietly averaged the handful of covered rows
// and printed a confident number would be lying by omission. So:
//
//   - `coverage` is computed first and rendered at the top, before any figure.
//   - Every expectancy row carries its own n, and `underMin` when n is too
//     small to mean anything.
//   - MAE/MFE aggregates count only rows that HAVE them (expectancy.js already
//     excludes nulls), and the count of rows that do is reported beside them.
//   - A counterfactual that could not run says so instead of returning the
//     book unchanged, which reads as "this would not have helped".
//
// The failure this guards against is the one that started the whole plan: an
// impossible 4,518-point MFE that was averaged into a playbook verdict because
// nothing between the arithmetic and the screen asked whether the input was
// real.

const tradeTags = require('./trade-tags');
const expectancy = require('./expectancy');
const counterfactual = require('./counterfactual');

// Below this, a tag is shown but never ranked. Six playbooks x five sessions
// over a 199-trade record puts most cells here, and saying so is the point.
const MIN_N = 8;

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}

// day_trades.json is { "YYYY-MM-DD": [row, ...] }. Flatten to one ordered list,
// stamping the day on each row so nothing downstream has to re-derive it.
function flattenDayTrades(store) {
  const out = [];
  if (!store || typeof store !== 'object') return out;
  for (const day of Object.keys(store).sort()) {
    const rows = store[day];
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      // `t` is the entry stamp on legacy rows, `x` the exit; entryAt/exitAt are
      // F1.2's explicit fields. Prefer the explicit ones, fall back so rows
      // written before F1 still place on the timeline.
      const entryAt = num(r.entryAt) != null ? num(r.entryAt) : num(r.t);
      const exitAt = num(r.exitAt) != null ? num(r.exitAt) : num(r.x);
      out.push(Object.assign({}, r, { day, entryAt, exitAt }));
    }
  }
  out.sort((a, b) => (a.entryAt || 0) - (b.entryAt || 0));
  return out;
}

/**
 * How much of the record can actually answer the forensic questions?
 * Reported before any number that depends on it.
 */
function coverageOf(trades) {
  const n = trades.length;
  let withPrices = 0, withMae = 0, withPost30 = 0, withPlaybook = 0;
  const reasons = {};
  for (const t of trades) {
    if (num(t.ep) != null && t.side) withPrices++;
    if (num(t.mae) != null && num(t.mfe) != null) withMae++;
    else if (t.forensicsReason) reasons[t.forensicsReason] = (reasons[t.forensicsReason] || 0) + 1;
    if (num(t.post30Mfe) != null) withPost30++;
    if (t.playbook) withPlaybook++;
  }
  return {
    trades: n,
    withPrices,
    withMaeMfe: withMae,
    withPost30,
    withPlaybook,
    // The honest headline. 0% is a true and useful answer.
    maeMfePct: n ? withMae / n : null,
    reasons,
    // Said in words on the tab so nobody has to interpret a percentage.
    note: withMae === 0
      ? 'No trade on record has MAE/MFE yet. The bar archive began collecting on 2026-09-05; every trade before it has no bars to measure against, and filling them from nearby bars would be a fabrication. Numbers appear here as new trades are recorded.'
      : (withMae < n
        ? withMae + ' of ' + n + ' trades have MAE/MFE. Averages below use only those rows; the rest are excluded, never counted as zero.'
        : 'Every trade on record has MAE/MFE.'),
  };
}

/** One display row per trade — the Journal-side detail, beside P&L. */
function tradeRows(trades) {
  return trades.map((t) => ({
    day: t.day,
    entryAt: t.entryAt,
    exitAt: t.exitAt,
    side: t.side || null,
    size: num(t.size),
    pnl: num(t.pnl),
    ep: num(t.ep),
    xp: num(t.xp),
    holdSec: num(t.hold),
    mae: num(t.mae),
    mfe: num(t.mfe),
    maeUsd: num(t.maeUsd),
    mfeUsd: num(t.mfeUsd),
    edgeRatio: num(t.edgeRatio),
    forensicsTf: t.forensicsTf || null,
    forensicsReason: t.forensicsReason || null,
    entryPctOfRange: num(t.entryPctOfRange),
    post30Mfe: num(t.post30Mfe),
    post30LeftOnTable: num(t.post30LeftOnTable),
    post30Reason: t.post30Reason || null,
    playbook: t.playbook || null,
    session: t.session || null,
    isReentry: !!t.isReentry,
    afterLoss: !!t.afterLoss,
    tradeIndexOfDay: num(t.tradeIndexOfDay),
    flags: Array.isArray(t.flags) ? t.flags : [],
  }));
}

const DIMENSIONS = [
  { key: 'playbook', label: 'Playbook', fn: (t) => t.playbook || 'untagged' },
  { key: 'session', label: 'Session', fn: (t) => t.session || 'unknown' },
  { key: 'dayOfWeek', label: 'Day of week', fn: (t) => (t.dayOfWeek == null ? null : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.dayOfWeek]) },
  { key: 'size', label: 'Size', fn: (t) => (num(t.size) == null ? null : num(t.size) + 'c') },
  { key: 'afterLoss', label: 'After a loss', fn: (t) => (t.afterLoss ? 'after a loss' : 'after a win / first') },
  { key: 'isReentry', label: 'Re-entry', fn: (t) => (t.isReentry ? 're-entry' : 'fresh') },
  { key: 'tradeIndexOfDay', label: 'Nth trade of day', fn: (t) => (num(t.tradeIndexOfDay) == null ? null : '#' + num(t.tradeIndexOfDay)) },
];

function expectancyTables(tagged) {
  return DIMENSIONS.map((d) => ({
    key: d.key,
    label: d.label,
    minN: MIN_N,
    rows: expectancy.expectancyBy(tagged, d.fn, MIN_N),
  }));
}

/**
 * Counterfactuals. Each one either returns a result or says why it could not
 * run — never the book unchanged dressed up as a finding.
 */
function counterfactuals(tagged, opts) {
  const o = opts || {};
  const out = [];

  const cutoffs = [{ label: 'Nothing after 11:00 IST', min: 660 }, { label: 'Nothing after 13:00 IST', min: 780 }];
  const haveIstMin = tagged.filter((t) => num(t.entryIstMin) != null).length;
  for (const c of cutoffs) {
    if (!haveIstMin) {
      out.push({ id: 'cutoff-' + c.min, label: c.label, unavailable: 'no trade carries an entry time — nothing to cut off' });
      continue;
    }
    const kept = tagged.filter((t) => num(t.entryIstMin) == null || num(t.entryIstMin) < c.min).length;
    if (kept === 0) {
      // A cutoff that removes EVERY trade is not a rule, it is "stop trading" —
      // and it will always show a delta equal to the entire loss, which reads
      // like the best idea on the page. Say what it actually means.
      out.push({
        id: 'cutoff-' + c.min, label: c.label,
        degenerate: 'this cutoff removes every trade on record — his sessions all start after it, so the "improvement" is simply not trading',
      });
      continue;
    }
    out.push(Object.assign({ id: 'cutoff-' + c.min, label: c.label, basis: kept + ' of ' + haveIstMin + ' trades kept' },
      counterfactual.cutoffAt(tagged, { cutoffMin: c.min })));
  }

  const haveIdx = tagged.filter((t) => num(t.tradeIndexOfDay) != null).length;
  for (const n of [3, 4]) {
    const eligible = tagged.filter((t) => num(t.tradeIndexOfDay) === n).length;
    if (!haveIdx) {
      out.push({ id: 'skip-' + n, label: 'Skip trade #' + n + ' of each day', unavailable: 'trades are not indexed within their day' });
      continue;
    }
    out.push(Object.assign({ id: 'skip-' + n, label: 'Skip trade #' + n + ' of each day', basis: eligible + ' trades removed' },
      counterfactual.skipNthTrade(tagged, { n })));
  }

  for (const stop of [300, 200]) {
    const wouldCap = tagged.filter((t) => (num(t.pnl) || 0) < -stop).length;
    out.push(Object.assign({ id: 'stop-' + stop, label: 'Per-trade stop at $' + stop, basis: wouldCap + ' trades capped' },
      counterfactual.perTradeStop(tagged, { stopUsd: stop })));
  }

  // 2R needs an MFE and a derivable per-trade R. With no MFE anywhere it must
  // say so — returning the book unchanged would read as "running winners
  // wouldn't help", which is the opposite of "we cannot tell". X4/X7: R is
  // derived per trade (signal stop when signalBacked, else MAE-implied) and the
  // point value comes from point-value-verify.js inside counterfactual.js, so no
  // R or pointValue parameter is passed — a call site can no longer supply a
  // wrong multiplier. Winners with no derivable R are refused and counted.
  const withMfe = tagged.filter((t) => num(t.mfe) != null).length;
  if (!withMfe) {
    out.push({
      id: 'run-2r',
      label: 'Every winner runs to 2R',
      unavailable: 'no trade has an MFE yet — this counterfactual reads excursion, and the bar archive has not covered a trade yet',
    });
  } else {
    const r = counterfactual.winnersRunTo2R(tagged);
    const rs = r.rSources || {};
    const basis = withMfe + ' with MFE · R: ' + (rs['signal-stop'] || 0) + ' signal-stop, ' + (rs['mae-implied'] || 0) + ' mae-implied';
    out.push(Object.assign({ id: 'run-2r', label: 'Every winner runs to 2R', basis }, r));
  }
  return out;
}

/**
 * Build the whole tab payload.
 * @param {object} dayTradesStore  day_trades.json for the active slot
 * @param {object} opts { sessionWindowsIST, isReentryWindowMin, pointValue, R, slot }
 */
function buildForensicsReport(dayTradesStore, opts) {
  const o = opts || {};
  const flat = flattenDayTrades(dayTradesStore);
  const tagged = tradeTags.tagTrades(flat, {
    sessionWindowsIST: o.sessionWindowsIST || [],
    isReentryWindowMin: o.isReentryWindowMin,
  });
  const coverage = coverageOf(tagged);
  return {
    slot: o.slot || null,
    builtAt: Date.now(),
    coverage,
    minN: MIN_N,
    trades: tradeRows(tagged),
    expectancy: expectancyTables(tagged),
    counterfactuals: counterfactuals(tagged, o),
    days: Object.keys(dayTradesStore || {}).sort(),
  };
}

module.exports = { buildForensicsReport, flattenDayTrades, coverageOf, tradeRows, MIN_N };
