'use strict';
/* ── feature-separation.js — which recorded conditions actually separate wins? ─
 *
 * (docs.typesafe.ai/cookbooks/autoresearch_feature_discovery, at the scale this
 * app actually has. The full cookbook and its numbers are summarised in
 * FEATURE_DISCOVERY_PLAN.md; this file is the part that is honest at n≈87.)
 *
 * ── WHAT THE COOKBOOK DOES, AND WHAT IT NEEDS ───────────────────────────────
 * It turns free text into numeric features by asking typed questions, trains a
 * CatBoost regressor on the answers, and runs a loop where the model's own worst
 * predictions feed back into a new question proposal. Its headline number:
 *
 *     predict the training mean ................ RMSE 3.09
 *     CatBoost on word counts .................. RMSE 2.47
 *     ASK THE MODEL FOR THE SCORE DIRECTLY ...... RMSE 2.15
 *     18 designed questions, one proposal call .. RMSE 1.87
 *     38 questions after five loop rounds ....... RMSE 1.77   (2,000 rows)
 *
 * Two things to take from that table, and they point in opposite directions:
 *
 *   1. DECOMPOSE, DO NOT ASK FOR THE ANSWER. Asking for the target itself (2.15)
 *      was WORSE than asking 18 small questions and combining them (1.87). That
 *      is direct evidence against the tempting feature "ask Jev the probability
 *      this trade wins" — the cookbook measured that instinct and it lost.
 *   2. THE LOOP NEEDS THOUSANDS OF ROWS. 1.87 -> 1.77 cost 2,000 training rows
 *      and five rounds. This app has 87 resolved signals. A gradient-boosted
 *      model on 87 rows across ~10 candidate features would fit the noise and
 *      report a beautiful number.
 *
 * ── SO THIS MODULE IS THE COOKBOOK'S FIRST HALF ─────────────────────────────
 * The part that survives a small sample: convert the recorded state into
 * features, then ask of EACH feature whether its groups separate — with the
 * Wilson interval and the n>=30 refusal that drift-edge.js and the router
 * evaluator already use. At n=87 the honest output is mostly "not yet", and that
 * is the correct output, not a failure of the module.
 *
 * It answers the question he actually asked — "are there good trades in my data"
 * — without ever printing a win rate it cannot defend.
 *
 * PURE. No fs, no model, no network. Unit-tested in test/feature-separation.test.js.
 */

const driftEdge = require('./drift-edge');

const DEFAULTS = Object.freeze({
  minSamples: 30,     // same floor as every other measurement in this repo
  minGroupSize: 5,    // a group smaller than this is not shown at all
  z: 1.96,
});

// The state features the ledger actually records. Anything not listed here is
// simply not a feature yet — this is a whitelist on purpose, because a feature
// invented from a field nobody populated is a column of nulls that "separates"
// nothing and dilutes every multiple-comparison count.
const FEATURE_KEYS = Object.freeze([
  'playbook', 'tf', 'direction', 'htfBias', 'htfConfirmation', 'sessionTier',
  'newsBlackout', 'structure15m', 'structure1h', 'hourTrend', 'valid',
]);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round3(n) { return Math.round(n * 1000) / 1000; }

/** The ledger's own outcome join key — signalTs|playbook|tf. */
function joinKey(row) {
  return [row && row.ts, row && (row.playbook || ''), row && (row.tf || '')].join('|');
}

/**
 * Join ledger rows to resolved outcomes.
 *
 * This is the SAME composite key signal-outcome.js already writes, so the two
 * sides agree without a lookup table. Rows that do not join are returned, not
 * dropped: the failure this app has already paid for once was a measurement that
 * silently discarded its own sample and reported "no data" forever.
 */
function joinLedger(ledgerRows, outcomeRows) {
  const ledger = new Map();
  for (const r of Array.isArray(ledgerRows) ? ledgerRows : []) {
    if (!r || !r.ts) continue;
    const k = joinKey(r);
    // First row wins for a given key: a re-fire of the same signal on the same
    // bar must not overwrite the state captured at the original fire time.
    if (!ledger.has(k)) ledger.set(k, r);
  }
  const joined = [];
  const unmatched = [];
  for (const o of Array.isArray(outcomeRows) ? outcomeRows : []) {
    if (!o || !o.resolved) continue;
    const k = [o.signalTs, o.playbook || '', o.tf || ''].join('|');
    const l = ledger.get(k) || null;
    if (!l) { unmatched.push({ signalTs: o.signalTs, playbook: o.playbook, tf: o.tf }); continue; }
    joined.push({ ledger: l, outcome: o });
  }
  return { joined, unmatched, ledgerRows: ledger.size };
}

/**
 * One row per joined signal: the feature values plus the OUTCOME.
 *
 * Win is decided the same pessimistic way the resolver and the router do — a
 * stop is a loss even when the horizon closed green — so the number this module
 * reports cannot be better than the number the app already trusts.
 */
function featureRows(joined, opts) {
  const o = opts || {};
  const keys = Array.isArray(o.featureKeys) ? o.featureKeys : FEATURE_KEYS.slice();
  const out = [];
  for (const j of joined) {
    const l = j.ledger || {};
    const oc = j.outcome || {};
    const features = {};
    for (const k of keys) {
      const v = l[k];
      // null is its own value, spelled out, because "the ledger did not record
      // this" must be visible as a group rather than silently equal to a value.
      features[k] = (v === undefined) ? 'not-recorded'
        : (v === null) ? 'null'
        : (typeof v === 'boolean') ? String(v)
        : String(v);
    }
    const atHorizon = num(oc.atHorizon);
    const win = oc.hit === 'target' ? true : (oc.hit === 'stop' ? false : (oc.favourable === true));
    out.push({ features, win, points: atHorizon, hit: oc.hit || null, playbook: oc.playbook || null, tf: oc.tf || null });
  }
  return out;
}

/**
 * Does ONE feature separate outcomes?
 *
 * Groups are the feature's distinct values. A group below minGroupSize is not
 * shown; a group below minSamples reports NO win rate at all. The verdict is
 * CONFIRMED only when two shown groups' Wilson intervals do not overlap — the
 * exact rule drift-edge.js uses, reused rather than reimplemented.
 */
function separateFeature(rows, key, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const groups = new Map();
  for (const r of rows) {
    const v = r.features[key];
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(r);
  }
  const out = [];
  for (const [value, list] of groups) {
    const n = list.length;
    const wins = list.filter((r) => r.win).length;
    const ci = driftEdge.wilson(wins, n, cfg.z);
    const pts = list.map((r) => num(r.points)).filter((v) => v !== null);
    const enough = n >= cfg.minSamples;
    out.push({
      value, n, wins,
      shown: n >= cfg.minGroupSize,
      // No rate below the floor. A provisional number is the thing that gets
      // acted on and then defended.
      winRate: enough ? ci.p : null,
      ci: enough ? { lo: ci.lo, hi: ci.hi } : null,
      expectancyPoints: enough && pts.length ? round3(pts.reduce((a, b) => a + b, 0) / pts.length) : null,
      note: enough ? null : n + ' signals — needs ' + cfg.minSamples + ' before a rate means anything',
    });
  }
  out.sort((a, b) => b.n - a.n);
  const usable = out.filter((g) => g.shown && g.winRate != null);
  let verdict = 'INSUFFICIENT';
  let separation = null;
  if (usable.length >= 2) {
    const sorted = usable.slice().sort((a, b) => b.winRate - a.winRate);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const disjoint = best.ci.lo > worst.ci.hi;
    separation = { best: best.value, worst: worst.value, gap: round3(best.winRate - worst.winRate), intervalsDisjoint: disjoint };
    verdict = disjoint ? 'CONFIRMED' : 'NO_EDGE';
  }
  return { key, groups: out, verdict, separation };
}

/**
 * Every feature at once, with the multiple-comparison caveat made explicit.
 *
 * Testing eleven features at once means a "significant" split is expected by
 * chance somewhere. That is not a reason to skip the test, it is a reason to say
 * how many features were tested beside the one that came back positive — so a
 * lone winner is read as "look at this next", never as "this works".
 */
function separateAll(rows, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const keys = Array.isArray(cfg.featureKeys) ? cfg.featureKeys : FEATURE_KEYS.slice();
  const features = keys.map((k) => separateFeature(rows, k, cfg));
  const confirmed = features.filter((f) => f.verdict === 'CONFIRMED');
  const withData = features.filter((f) => f.groups.some((g) => g.winRate != null));
  let summary;
  if (!rows.length) {
    summary = 'No joined signals yet — nothing to separate.';
  } else if (!withData.length) {
    summary = rows.length + ' joined signal(s), and no feature group has the ' + cfg.minSamples
      + ' needed to report a win rate. This answers itself with time, not with argument.';
  } else if (!confirmed.length) {
    summary = 'No feature separates outcomes yet: ' + withData.length + ' of ' + features.length
      + ' features have a group large enough to rate, and none has two groups whose intervals fail to overlap.';
  } else {
    summary = confirmed.map((f) => '"' + f.key + '" separates: ' + f.separation.best + ' '
      + Math.round((f.groups.find((g) => g.value === f.separation.best).winRate) * 100) + '% vs '
      + f.separation.worst + ' ' + Math.round((f.groups.find((g) => g.value === f.separation.worst).winRate) * 100) + '%')
      .join('; ')
      + '. ' + features.length + ' features were tested at once, so treat a lone winner as the next thing to look at, not as a rule.';
  }
  return {
    rows: rows.length, features, confirmed: confirmed.map((f) => f.key),
    tested: features.length, withData: withData.length, minSamples: cfg.minSamples, summary,
  };
}

/** Does the sample support the cookbook's actual method (a trained model)? */
function sampleCheck(n, featureCount, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const f = num(featureCount) || 1;
  const perParam = 10;
  const needed = f * perParam;
  return {
    rows: n, features: f, needed,
    ready: n >= needed,
    verdict: n >= needed
      ? 'Enough rows to try a supervised model on these features, with a held-out split.'
      : 'Not enough rows for a trained model: ' + n + ' rows against ' + f + ' features needs roughly '
        + needed + ' by the usual 10-rows-per-feature rule. Until then, per-feature intervals are the honest '
        + 'instrument — a model here would fit the noise and report a number nobody should act on.',
  };
}

module.exports = {
  DEFAULTS, FEATURE_KEYS,
  joinKey, joinLedger, featureRows, separateFeature, separateAll, sampleCheck,
};
