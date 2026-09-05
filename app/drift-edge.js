'use strict';
/* ── drift-edge.js — does the post-exit drift score predict the NEXT trade? ───
 *
 * (2026-08-31, Anoop: "what can be done to know what it will do next. It is a
 * probability, a confidence level, and a reason to size up. everything here has
 * to be tested against whether your next trade actually wins.")
 *
 * He is right that this is the only thing that would earn exit-drift.js those
 * roles. exit-drift.js scores what price DID after an exit. This module answers
 * the separate and much harder question: does that score tell you anything
 * about the trade you take next?
 *
 * ── HOW IT ANSWERS ──────────────────────────────────────────────────────────
 * Input is PAIRS: the drift score standing after trade N, and the realised
 * outcome of trade N+1. Pairs never cross a trading day — an overnight gap
 * makes "what price did since your last exit" a different question, and letting
 * it span days would quietly inflate the sample with the easiest cases.
 *
 * Output per bucket: n, win rate, expectancy per contract, and a WILSON score
 * interval. Wilson rather than the textbook normal interval because at n=12 the
 * normal approximation produces intervals that run past 0 and 1 and look far
 * tighter than the evidence supports.
 *
 * ── WHY IT REFUSES MORE OFTEN THAN IT ANSWERS ───────────────────────────────
 * With ~135 trades over 16 days there are roughly 120 usable pairs. Split ten
 * ways that is ~12 per bucket, where a 58% win rate carries a 95% interval of
 * about 32%-81% — indistinguishable from a coin, from a real edge, and from a
 * disaster. So:
 *
 *   • Buckets are COARSE by default (weak / clear / decisive), not 1-10.
 *   • A bucket under `minSamples` returns `verdict: 'INSUFFICIENT'` and no
 *     probability at all. Not a greyed-out number, not a provisional one.
 *   • An edge is only reported when two buckets' intervals DO NOT OVERLAP.
 *     Two point estimates differing by 15 points on n=20 each is noise, and
 *     printing "68% vs 53%" invites sizing up on it.
 *
 * That last rule is the whole safety argument. rules.json is full of comments
 * where a plausible rule was overturned by his own data — the 1-contract floor,
 * the 15-minute hold minimum, the 5-6 contract bucket that looked like +$506
 * and collapsed to +$24 once one lucky trade was removed. This module exists so
 * the drift score does not become the next of those, and so that if it IS real,
 * he has the evidence rather than my opinion.
 *
 * ── ON "A REASON TO SIZE UP" ────────────────────────────────────────────────
 * `sizeSuggestion()` is deliberately capped by rules.json's sizeCap and returns
 * null unless the edge is CONFIRMED. It proposes; it never sets. His own
 * hot-hand rule already says extra risk is earned by an A+ setup and never by a
 * confidence level — a validated statistical edge is a legitimate third case,
 * but only once it is actually validated, and never above the hard cap.
 *
 * PURE. No fs, no clock, no chart. Unit-tested in test/drift-edge.test.js.
 */

const DEFAULTS = {
  minSamples: 30,        // below this a bucket reports nothing
  buckets: [
    { key: 'weak', label: 'weak (1-3)', min: 1, max: 3 },
    { key: 'clear', label: 'clear (4-7)', min: 4, max: 7 },
    { key: 'decisive', label: 'decisive (8-10)', min: 8, max: 10 },
  ],
  z: 1.96,               // 95%
};

const VERDICT = {
  CONFIRMED: 'CONFIRMED',       // intervals separate — a real difference
  NO_EDGE: 'NO_EDGE',           // enough data, no separation
  INSUFFICIENT: 'INSUFFICIENT', // not enough pairs to say anything
};

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

/**
 * Wilson score interval for a binomial proportion.
 * Chosen over the normal approximation because these samples are small and
 * near the edges; the normal version reports intervals that fall outside [0,1]
 * and are far too narrow at n < 30, which is exactly where this module lives.
 */
function wilson(successes, n, z) {
  if (!n) return { lo: 0, hi: 1, p: null };
  const Z = z || DEFAULTS.z;
  const p = successes / n;
  const d = 1 + (Z * Z) / n;
  const centre = p + (Z * Z) / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p) + (Z * Z) / (4 * n)) / n);
  return {
    p: round3(p),
    lo: round3(Math.max(0, (centre - margin) / d)),
    hi: round3(Math.min(1, (centre + margin) / d)),
  };
}

/**
 * Build pairs from ordered trades plus a drift score standing after each exit.
 *
 * @param {Array} trades  chronological, each {x, pnl, size, date}
 * @param {Function} scoreAt  (tradeIndex) -> score 1-10 or null
 * Pairs are dropped when the score is null (exit-drift refused to read) or when
 * the next trade is on a different day.
 */
function buildPairs(trades, scoreAt) {
  const list = (Array.isArray(trades) ? trades : []).filter(Boolean);
  const out = [];
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    if (!a || !b) continue;
    if (a.date && b.date && a.date !== b.date) continue;   // never across days
    const score = num(typeof scoreAt === 'function' ? scoreAt(i) : null);
    const pnl = num(b.pnl);
    if (score == null || pnl == null) continue;
    const size = num(b.size) || 1;
    out.push({
      score,
      nextPnl: pnl,
      nextWin: pnl > 0,
      // Per CONTRACT, matching week-rollup's adherenceSplit: comparing raw
      // per-trade P&L across sizes measures how big he bet, not how well the
      // signal did.
      nextPnlPerContract: round2(pnl / size),
      date: b.date || null,
    });
  }
  return out;
}

/** Aggregate one bucket's pairs. */
function summariseBucket(bucket, pairs, cfg) {
  const rows = pairs.filter((p) => p.score >= bucket.min && p.score <= bucket.max);
  const n = rows.length;
  if (!n) {
    return { key: bucket.key, label: bucket.label, n: 0, verdict: VERDICT.INSUFFICIENT, winRate: null, ci: null, expectancy: null, note: 'No pairs in this bucket.' };
  }
  const wins = rows.filter((r) => r.nextWin).length;
  const ci = wilson(wins, n, cfg.z);
  const expectancy = round2(rows.reduce((a, r) => a + r.nextPnlPerContract, 0) / n);
  const enough = n >= cfg.minSamples;
  return {
    key: bucket.key, label: bucket.label, n, wins,
    // No probability at all below the threshold. A provisional number is the
    // thing that gets acted on and then defended.
    winRate: enough ? ci.p : null,
    ci: enough ? { lo: ci.lo, hi: ci.hi } : null,
    expectancy: enough ? expectancy : null,
    verdict: enough ? VERDICT.NO_EDGE : VERDICT.INSUFFICIENT,
    note: enough ? null : n + ' pairs — needs ' + cfg.minSamples + ' before a rate means anything.',
  };
}

/**
 * The whole evaluation.
 * An edge is CONFIRMED only when the best and worst sufficiently-sampled
 * buckets have NON-OVERLAPPING confidence intervals.
 */
function evaluateDriftEdge(pairs, options) {
  const cfg = Object.assign({}, DEFAULTS, options || {});
  const list = (Array.isArray(pairs) ? pairs : []).filter(Boolean);
  const buckets = cfg.buckets.map((b) => summariseBucket(b, list, cfg));
  const usable = buckets.filter((b) => b.winRate != null);

  let verdict = VERDICT.INSUFFICIENT;
  let separation = null;
  let summary;

  if (usable.length < 2) {
    summary = 'Not enough data to test whether the drift score predicts anything. '
      + list.length + ' pair(s) total; ' + usable.length + ' of ' + buckets.length
      + ' buckets have the ' + cfg.minSamples + ' needed. Keep recording — this answers itself with time, not with argument.';
  } else {
    const sorted = usable.slice().sort((a, b) => b.winRate - a.winRate);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const disjoint = best.ci.lo > worst.ci.hi;
    separation = {
      best: best.key, worst: worst.key,
      bestRate: best.winRate, worstRate: worst.winRate,
      gap: round3(best.winRate - worst.winRate),
      intervalsDisjoint: disjoint,
    };
    if (disjoint) {
      verdict = VERDICT.CONFIRMED;
      summary = 'Drift score separates outcomes: "' + best.label + '" wins '
        + Math.round(best.winRate * 100) + '% (n=' + best.n + ', ' + Math.round(best.ci.lo * 100) + '-'
        + Math.round(best.ci.hi * 100) + '%) vs "' + worst.label + '" at '
        + Math.round(worst.winRate * 100) + '% (n=' + worst.n + '). The intervals do not overlap.';
    } else {
      verdict = VERDICT.NO_EDGE;
      summary = 'No demonstrated edge. "' + best.label + '" shows '
        + Math.round(best.winRate * 100) + '% vs "' + worst.label + '" at '
        + Math.round(worst.winRate * 100) + '%, but the confidence intervals OVERLAP ('
        + Math.round(best.ci.lo * 100) + '-' + Math.round(best.ci.hi * 100) + '% vs '
        + Math.round(worst.ci.lo * 100) + '-' + Math.round(worst.ci.hi * 100)
        + '%). That gap is consistent with chance at this sample size.';
    }
  }

  return { verdict, buckets, separation, pairs: list.length, minSamples: cfg.minSamples, summary };
}

/**
 * The only path from evidence to size.
 *
 * Returns null unless the edge is CONFIRMED and this score sits in the winning
 * bucket. Never exceeds sizeCap — a validated edge changes WHEN he takes the
 * larger size within his rule, never what the rule is. Anything else would make
 * a statistic able to overrule a hard cap, which is the failure his own
 * _sizeCap_comment records costing a 150K account.
 */
function sizeSuggestion(edge, score, rules) {
  const cap = num(rules && rules.sizeCap);
  const floor = num(rules && rules.sizeFloor) || 1;
  if (!edge || edge.verdict !== VERDICT.CONFIRMED || cap == null) return null;
  const s = num(score);
  if (s == null || !edge.separation) return null;
  const best = edge.buckets.find((b) => b.key === edge.separation.best);
  if (!best) return null;
  const inBest = DEFAULTS.buckets.some((b) => b.key === best.key && s >= b.min && s <= b.max);
  if (!inBest) return null;
  return {
    size: Math.min(cap, Math.max(floor, cap)),
    cappedAt: cap,
    because: 'Drift score ' + s + ' is in the "' + best.label + '" bucket, which wins '
      + Math.round(best.winRate * 100) + '% over ' + best.n + ' recorded pairs with a non-overlapping interval. '
      + 'Still capped at your sizeCap of ' + cap + ' — evidence changes when you use the cap, never the cap itself.',
  };
}

module.exports = {
  evaluateDriftEdge, buildPairs, summariseBucket, sizeSuggestion, wilson,
  VERDICT, DEFAULTS,
};
