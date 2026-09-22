'use strict';
/* ── consistency-check.js — does the same state answer the same way twice? ────
 *
 * (docs.typesafe.ai/cookbooks/consistency_noul_cookbook — the second cookbook,
 * and the one technique in it worth stealing. See FEATURE_DISCOVERY_PLAN.md §2.)
 *
 * ── WHAT THE COOKBOOK DOES ──────────────────────────────────────────────────
 * One 14-question rubric over one insurance claim, run 15 times per condition,
 * checking whether each answer holds still. Its findings:
 *
 *   • LLM answers MOVE between runs, at temperature 0 too, and the models
 *     disagree with themselves on judgment calls.
 *   • TypeSafe's mean per-question probability standard deviation was 0.0102 —
 *     below every LLM condition tested. That is the real case for Jev here: not
 *     that it is smarter, but that the same state answers the same way.
 *   • Probabilities from 0.30 to 0.70 were routed to an explicit "uncertain"
 *     outcome for human review, with the number kept visible.
 *   • Each call carried a fresh throwaway uid so repeats are independent
 *     samples rather than cache hits.
 *
 * ── THE TECHNIQUE WORTH STEALING, AND WHAT IT ACTUALLY IS ───────────────────
 * MEASURED ON THIS APP'S ROUTE, 2026-09-21 (5 repeats, identical body, no uid):
 *
 *   valid    : 0.72 0.71 0.75 0.74 0.72   -> 4 distinct answers out of 5
 *   trend_ok : 0.96 0.96 0.96 0.96 0.96   -> 1 distinct answer
 *
 * So on this route there is NO caching to defeat — the repeats are ALREADY
 * independent, and adding a fresh uid changed nothing (3 distinct of 5). The uid
 * is therefore cheap insurance rather than the point, and this module does not
 * depend on it. The LOOP is the technique: run it N times, and MEASURE the
 * spread instead of trusting one draw.
 *
 * ── WHAT THIS MODULE ADDS TO THE COOKBOOK ───────────────────────────────────
 * The cookbook reports a standard deviation and routes a fixed 0.30-0.70 band to
 * review. A standard deviation alone does not tell you whether it MATTERS. What
 * matters is whether the movement can FLIP A DECISION THIS APP ACTUALLY MAKES —
 * and this app gates on real numbers: 0.5 for the plan match, 0.6 for the voice
 * floor, per-playbook bands for the debate gate.
 *
 * So the verdict here is not "stable" or "noisy". It is:
 *
 *   FLIPS_AT_THRESHOLD — repeats landed on BOTH sides of a threshold the app
 *                        gates on. One draw could have gone either way.
 *   NEAR_THRESHOLD     — never crossed, but the spread reaches within
 *                        `margin` of a threshold. A slightly different state
 *                        would flip it.
 *   MOVING             — real spread, but no threshold near it. The noise is
 *                        harmless for gating; it still matters if the number is
 *                        shown to him as a reading.
 *   STABLE             — held still.
 *   INSUFFICIENT       — too few repeats to say.
 *
 * That is the same discipline as everywhere else in this repo: report the thing
 * that changes a decision, and refuse to report before there is enough to say.
 *
 * PURE. Takes answer arrays, returns statistics. No fs, no network, no model.
 */

const DEFAULTS = Object.freeze({
  minRepeats: 5,      // below this, nothing is reported
  stableSd: 0.02,     // the cookbook measured 0.0102; 0.02 is a fair bar
  margin: 0.05,       // how close to a threshold counts as "near"
});

// The thresholds this app actually gates decisions on. Kept here so the check
// answers "can this flip something" rather than an abstract "is it noisy".
const APP_THRESHOLDS = Object.freeze([
  { at: 0.5, why: 'plan_match considers a state on-plan at >= 0.5' },
  { at: 0.6, why: 'the voice router answers at or above its 0.6 floor' },
  { at: 0.75, why: 'the composite axis calls a setup strong at >= 0.75' },
]);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round3(n) { return Math.round(n * 1000) / 1000; }
function round4(n) { return Math.round(n * 10000) / 10000; }

/** Population standard deviation. */
function sd(values) {
  const xs = (values || []).map(num).filter((v) => v !== null);
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

/**
 * Pull the comparable number out of one answer, whatever primitive it is.
 * A choice's confidence is NOT used here: confidence is a property of the
 * distribution, and the thing that flips a gate is the value, not the shape.
 */
function valueOf(answer) {
  if (!answer || typeof answer !== 'object') return null;
  if (answer.type === 'noul') return num(answer.noul);
  if (answer.type === 'score') return num(answer.score);
  if (answer.type === 'choice') return answer.choice != null ? String(answer.choice) : null;
  return null;
}

/**
 * Summarise one question across N repeats.
 * @param values  the extracted values, one per repeat
 */
function summariseQuestion(id, values, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const raw = Array.isArray(values) ? values : [];
  const n = raw.length;
  const numeric = raw.map(num).filter((v) => v !== null);
  const isNumeric = numeric.length === n && n > 0;
  const base = {
    id, n, kind: isNumeric ? 'numeric' : 'categorical',
    values: raw, distinct: new Set(raw.map(String)).size,
    mean: null, sd: null, min: null, max: null, range: null,
    crossings: [], verdict: 'INSUFFICIENT', note: null,
  };
  if (n < cfg.minRepeats) {
    return Object.assign(base, { note: n + ' repeat(s) — ' + cfg.minRepeats + ' are needed before a spread means anything' });
  }
  if (!isNumeric) {
    // A Choice that picked different options on different runs is the loudest
    // possible instability — there is no average of two different answers.
    const stable = base.distinct === 1;
    return Object.assign(base, {
      verdict: stable ? 'STABLE' : 'MOVING',
      note: stable ? 'the same option every time' : base.distinct + ' different options across ' + n + ' repeats',
    });
  }
  const mean = numeric.reduce((a, b) => a + b, 0) / numeric.length;
  const s = sd(numeric);
  const min = Math.min.apply(null, numeric);
  const max = Math.max.apply(null, numeric);

  // Does the spread reach across any threshold the app gates on?
  const thresholds = cfg.thresholds || APP_THRESHOLDS;
  const crossings = [];
  for (const t of thresholds) {
    const below = numeric.filter((v) => v < t.at).length;
    const above = numeric.filter((v) => v >= t.at).length;
    if (below && above) crossings.push({ at: t.at, below, above, crossed: true, why: t.why });
    else if (Math.min(Math.abs(min - t.at), Math.abs(max - t.at)) <= cfg.margin) {
      crossings.push({ at: t.at, below, above, crossed: false, why: t.why });
    }
  }
  const crossed = crossings.some((c) => c.crossed);
  const near = !crossed && crossings.length > 0;
  const verdict = crossed ? 'FLIPS_AT_THRESHOLD' : near ? 'NEAR_THRESHOLD' : (s > cfg.stableSd ? 'MOVING' : 'STABLE');
  const note = crossed
    ? 'the repeats landed on BOTH sides of ' + crossings.filter((c) => c.crossed).map((c) => c.at).join(' and ')
      + ' — one draw could have gone either way'
    : near
      ? 'held still, but the spread reaches within ' + cfg.margin + ' of ' + crossings.map((c) => c.at).join('/')
      : s > cfg.stableSd
        ? 'real spread (sd ' + round4(s) + ') but no decision threshold sits near it'
        : 'held still';
  return Object.assign(base, {
    mean: round3(mean), sd: round4(s), min, max, range: round3(max - min), crossings, verdict, note,
  });
}

/**
 * Summarise a whole run of repeats.
 * @param runs  array of client results ({ok, answers}), one per repeat
 * @param opts  { thresholds, minRepeats, stableSd, margin }
 */
function summariseRun(runs, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r && r.ok && r.answers);
  const failed = (Array.isArray(runs) ? runs : []).length - list.length;
  const ids = new Set();
  for (const r of list) for (const k of Object.keys(r.answers || {})) ids.add(k);
  const questions = [];
  for (const id of ids) {
    const values = list.map((r) => valueOf((r.answers || {})[id]));
    questions.push(summariseQuestion(id, values, cfg));
  }
  questions.sort((a, b) => (a.verdict === 'FLIPS_AT_THRESHOLD' ? -1 : 0) - (b.verdict === 'FLIPS_AT_THRESHOLD' ? -1 : 0));
  const flipping = questions.filter((q) => q.verdict === 'FLIPS_AT_THRESHOLD');
  const near = questions.filter((q) => q.verdict === 'NEAR_THRESHOLD');
  const worstSd = questions.reduce((m, q) => Math.max(m, q.sd || 0), 0);
  let summary;
  // Failures are stated beside the count, never quietly dropped: a run of 2
  // successes and 7 503s is not "a small sample", it is an outage, and the two
  // have different fixes.
  const failNote = failed ? ' (' + failed + ' failed)' : '';
  if (!list.length) {
    summary = 'No successful repeats — nothing to compare' + failNote + '.';
  } else if (list.length < cfg.minRepeats) {
    summary = list.length + ' repeat(s) captured' + failNote + '; ' + cfg.minRepeats
      + ' are needed before a spread means anything.';
  } else if (flipping.length) {
    summary = 'UNSAFE TO GATE ON: ' + flipping.map((q) => q.id).join(', ')
      + ' landed on both sides of a threshold the app decides with. Either ask it differently or keep a human in that loop.';
  } else if (near.length) {
    summary = 'No question flipped a threshold, but ' + near.map((q) => q.id).join(', ')
      + ' came within ' + cfg.margin + ' of one. Worst spread across all questions: sd ' + round4(worstSd)
      + ' over ' + list.length + ' repeats.';
  } else {
    summary = 'Every question held still across ' + list.length + ' repeats (worst sd ' + round4(worstSd)
      + '). The rubric answers the same way on the same state.';
  }
  return {
    repeats: list.length, failed, questions, worstSd: round4(worstSd),
    flipping: flipping.map((q) => q.id), near: near.map((q) => q.id),
    minRepeats: cfg.minRepeats, summary,
  };
}

module.exports = { DEFAULTS, APP_THRESHOLDS, sd, valueOf, summariseQuestion, summariseRun };
