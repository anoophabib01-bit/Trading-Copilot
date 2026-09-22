'use strict';
/* ── condition-candidates.js — which CONDITIONS could earn a gate? ────────────
 *
 * (Groundwork for the condition gate. The reasoning, the sample-size arithmetic
 * and the false-discovery warning are in FEATURE_DISCOVERY_PLAN.md.)
 *
 * ── WHY CONDITIONS AND NOT PLAYBOOKS ────────────────────────────────────────
 * The registry already switches whole PLAYBOOKS on and off. But a playbook is a
 * coarse thing: "Playbook A" is three timeframes and two directions, and its own
 * alert rate went 8 -> 30 a day. What he actually needs to know is narrower:
 * *under which recorded conditions does this setup win?* "A · 15m · London ·
 * with-bias" is a condition. That is the thing that can eventually gate an entry,
 * and the thing that is importable as a new playbook once it earns its place.
 *
 * ── WHAT THIS MODULE IS, AND IS NOT ─────────────────────────────────────────
 * It GENERATES candidate conditions from the recorded features and MEASURES each
 * one. It does not decide anything and it arms nothing. A condition becomes
 * gate-eligible only when its whole Wilson interval sits above the baseline rate
 * — i.e. it is not merely "higher than average", it is higher than average even
 * at the pessimistic end of its own uncertainty.
 *
 * ── THE TWO WAYS THIS GOES WRONG, BOTH GUARDED ──────────────────────────────
 *   1. FALSE DISCOVERY. Testing 200 conditions at once means several clear the
 *      bar by chance. The count tested is reported with every result, and the
 *      pairwise sweep is bounded, because the honest reading of "3 of 213" is
 *      "look at these next", never "these work".
 *   2. TEMPORAL CONFOUND. The real ledger already produced one: htfBias split
 *      46-vs-37 at 39% vs 62%, because the field only started being recorded on
 *      2026-09-03. The two groups differ by WHEN, not by market. So every
 *      candidate carries the date span of its matches, and a candidate whose
 *      matches all sit on one side of a recording change is flagged
 *      `timeConfounded` rather than promoted. (Found on his own data, not
 *      theorised.)
 *
 * PURE. Takes feature rows, returns measurements. No fs, no model, no network.
 */

const driftEdge = require('./drift-edge');

const DEFAULTS = Object.freeze({
  minSupport: 8,      // fewer matches than this cannot be a candidate at all
  minSamples: 30,     // the floor before ANY rate is reported
  maxPairs: 400,      // bound on the pairwise sweep
  z: 1.96,
  maxFeaturesPerCondition: 2,
});

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round3(n) { return Math.round(n * 1000) / 1000; }
function keyOf(pairs) { return pairs.map((p) => p.key + '=' + p.value).join(' & '); }

/** Which feature values are worth testing at all: not unique, not universal. */
function usableValues(rows, featureKeys, cfg) {
  const out = [];
  for (const key of featureKeys) {
    const counts = new Map();
    for (const r of rows) counts.set(r.features[key], (counts.get(r.features[key]) || 0) + 1);
    for (const [value, n] of counts) {
      // A MISSING key is not a value. When rows do not all carry the same schema,
      // every row lacking the key lands in an `undefined` bucket that then looks
      // like the single best-supported condition in the table — a phantom group
      // made of absence. featureRows() spells absence out as 'not-recorded'/'null'
      // precisely so that the real thing stays distinguishable from this.
      if (value === undefined) continue;
      // A value that matches every row is not a condition — it is the baseline.
      if (n >= cfg.minSupport && n < rows.length) out.push({ key, value, n });
    }
  }
  return out;
}

/**
 * Candidate conditions: every usable single value, plus pairs that co-occur
 * often enough to be measurable. Bounded, and the bound is reported.
 */
function makeConditions(rows, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const keys = Array.isArray(cfg.featureKeys) ? cfg.featureKeys : Object.keys((rows[0] && rows[0].features) || {});
  const singles = usableValues(rows, keys, cfg).map((v) => ({ pairs: [{ key: v.key, value: v.value }], arity: 1 }));
  const out = singles.slice();
  let truncated = false;
  let pairsAdded = 0;
  if (cfg.maxFeaturesPerCondition >= 2) {
    // The budget counts PAIRS, and the flag now fires whenever the sweep is cut
    // short — including when the singles alone already outnumber it. The first
    // version guarded the outer loop on the TOTAL size, so a table with many
    // singles skipped the pairwise sweep entirely and still reported
    // truncated:false, i.e. it claimed a complete search it never ran.
    outer:
    for (let i = 0; i < singles.length; i++) {
      for (let j = i + 1; j < singles.length; j++) {
        if (pairsAdded >= cfg.maxPairs) { truncated = true; break outer; }
        const a = singles[i].pairs[0], b = singles[j].pairs[0];
        if (a.key === b.key) continue;   // one value per feature
        let n = 0;
        for (const r of rows) if (r.features[a.key] === a.value && r.features[b.key] === b.value) n++;
        if (n >= cfg.minSupport) { out.push({ pairs: [a, b], arity: 2 }); pairsAdded++; }
      }
    }
  }
  // singles and pairs are reported separately because the bound applies to PAIRS
  // only — capping the singles would drop the most interpretable candidates in
  // the table, and capping the total silently would hide how many were tested,
  // which is the one number that keeps a lucky winner from reading as a rule.
  return {
    conditions: out, truncated, singles: singles.length,
    pairsTested: pairsAdded, tested: out.length,
  };
}

function matches(row, condition) {
  for (const p of condition.pairs) if (row.features[p.key] !== p.value) return false;
  return true;
}

/** Measure one condition against the baseline rate of the whole sample. */
function measureCondition(rows, condition, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const all = Array.isArray(rows) ? rows : [];
  const baseWins = all.filter((r) => r.win).length;
  const baseline = all.length ? round3(baseWins / all.length) : null;
  const hit = all.filter((r) => matches(r, condition));
  const n = hit.length;
  const wins = hit.filter((r) => r.win).length;
  const ci = driftEdge.wilson(wins, n, cfg.z);
  const pts = hit.map((r) => num(r.points)).filter((v) => v !== null);
  const enough = n >= cfg.minSamples;
  // ── the temporal confound, measured WHERE THE MATCHES ARE ─────────────────
  // Computed here rather than in a second pass over the rows: the first version
  // did it in rankConditions with its own filter, and the two definitions of
  // "matches" were one edit away from disagreeing. The real ledger produced this
  // confound for real — htfBias split 46-vs-37 at 39% vs 62% because the field
  // only started being recorded on 2026-09-03 — so every condition reports the
  // date span of its own matches.
  const hitDates = hit.map((r) => r.date).filter(Boolean).sort();
  const dateSpan = hitDates.length
    ? { first: hitDates[0], last: hitDates[hitDates.length - 1], dated: hitDates.length }
    : null;
  let timeConfounded = false;
  if (cfg.splitDate && hitDates.length) {
    const before = hitDates.filter((d) => d < cfg.splitDate).length;
    timeConfounded = before === 0 || before === hitDates.length;
  }
  const base = {
    key: keyOf(condition.pairs), pairs: condition.pairs, arity: condition.arity,
    n, wins, baseline, lift: null,
    winRate: enough ? ci.p : null,
    ci: enough ? { lo: ci.lo, hi: ci.hi } : null,
    expectancyPoints: enough && pts.length ? round3(pts.reduce((a, b) => a + b, 0) / pts.length) : null,
    // NB: shorthand, NOT `timeConfounded: false`. The first version computed the
    // flag and then overwrote it with false two lines later, so every condition
    // reported unconfounded and the demotion below never fired. The test caught
    // it; nothing else would have, because the output still looked plausible.
    dateSpan, timeConfounded, verdict: 'INSUFFICIENT', note: null,
  };
  if (!n) return Object.assign(base, { note: 'no signal matched this condition' });
  if (!enough) {
    return Object.assign(base, {
      note: n + ' match(es) — ' + cfg.minSamples + ' are needed before a rate means anything',
    });
  }
  // ELIGIBLE requires the WHOLE interval above the baseline, not just the point
  // estimate. That is the difference between "looked better" and "cannot be
  // explained by the average".
  // A confounded condition is DEMOTED, not merely flagged: its interval may
  // clear the baseline cleanly and still be an artefact of when the field started
  // being written, which is the one failure mode that would put a fake edge in
  // front of him looking exactly like a real one.
  let verdict = (baseline != null && ci.lo > baseline) ? 'ELIGIBLE' : 'PROMISING';
  let note = verdict === 'ELIGIBLE'
    ? 'the whole interval sits above the baseline of ' + Math.round((baseline || 0) * 100) + '%'
    : 'overlaps the baseline of ' + Math.round((baseline || 0) * 100) + '% — consistent with average';
  if (timeConfounded && verdict === 'ELIGIBLE') {
    verdict = 'PROMISING';
    note = 'every match falls on one side of ' + cfg.splitDate + ' — this may be a recording change, not an edge';
  }
  return Object.assign(base, { lift: round3(ci.p - (baseline || 0)), verdict, note });
}

/**
 * Rank candidates, and flag the temporal confound.
 * @param rows     feature rows (from feature-separation.featureRows)
 * @param opts     { featureKeys, minSupport, minSamples, maxPairs, dates }
 */
function rankConditions(rows, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const all = Array.isArray(rows) ? rows : [];
  const made = makeConditions(all, cfg);
  const measured = made.conditions.map((c) => measureCondition(all, c, cfg));
  measured.sort((a, b) => (b.winRate || -1) - (a.winRate || -1) || b.n - a.n);
  const eligible = measured.filter((m) => m.verdict === 'ELIGIBLE');
  const promising = measured.filter((m) => m.verdict === 'PROMISING');
  let summary;
  if (!all.length) summary = 'No joined signals yet — nothing to test.';
  else if (!eligible.length && !promising.length) {
    summary = made.tested + ' condition(s) tested across ' + all.length + ' signals; none has the '
      + cfg.minSamples + ' matches needed to report a rate.';
  } else if (!eligible.length) {
    summary = made.tested + ' conditions tested; ' + promising.length + ' has/have a rateable sample and none has its '
      + 'whole interval above the baseline. ' + all.length + ' signals is a small field to search '
      + made.tested + ' conditions in.';
  } else {
    summary = eligible.length + ' of ' + made.tested + ' conditions has its whole interval above the baseline: '
      + eligible.map((m) => m.key + ' (' + Math.round(m.winRate * 100) + '% at n=' + m.n + ')').join('; ')
      + '. ' + made.tested + ' were tested at once, so this is the next thing to examine — not a rule.';
  }
  return {
    rows: all.length, tested: made.tested, truncated: made.truncated,
    conditions: measured, eligible: eligible.map((m) => m.key),
    promising: promising.map((m) => m.key), minSamples: cfg.minSamples, summary,
  };
}

/**
 * The gate itself — and its default is ALLOW.
 *
 * Groundwork only: it takes the conditions that have been ARMED (a thing nothing
 * does yet) and answers whether a signal survives them. With none armed it
 * allows everything, which is exactly today's behaviour. Arming is deliberately
 * not implemented here: it belongs behind the same measured bar and the same
 * human decision that every other switch in this app waits for.
 */
function gate(armedConditions, features) {
  const armed = Array.isArray(armedConditions) ? armedConditions.filter((c) => c && c.armed) : [];
  if (!armed.length) return { allowed: true, reason: 'no condition is armed — nothing is gated', matched: null };
  const row = { features: features || {} };
  for (const c of armed) {
    if (matches(row, { pairs: c.pairs || [] })) {
      return { allowed: true, reason: 'matches the armed condition ' + (c.key || ''), matched: c.key || null };
    }
  }
  return { allowed: false, reason: 'no armed condition matched', matched: null };
}

module.exports = {
  DEFAULTS, usableValues, makeConditions, matches, measureCondition, rankConditions, gate,
};
