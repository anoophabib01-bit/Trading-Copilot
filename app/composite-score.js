'use strict';
/* ── composite-score.js — score each dimension, combine with weights YOU own ──
 *
 * (docs.typesafe.ai/patterns/composite-scoring, applied 2026-09-21. The two
 * rules it comes from, and why they matter here, are in COMPOSITE_SCORING_PLAN.md.)
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * "Break the judgment into independent dimensions, score each one separately,
 * and combine them with weights you control in code." The docs' example scores
 * four dimensions of a resume, divides each by the top level, and weights them
 * differently for an IC role and a manager role.
 *
 * ── WHY THAT BEATS THE SINGLE QUESTION IT REPLACES ──────────────────────────
 * The router asked ONE Choice: "which playbook does this state most resemble?"
 * It answers with one number and no breakdown. When it ranks B above A there is
 * no way to ask WHY, and no way to say "trend alignment matters more this month"
 * without rewriting an instruction string. Four atomic Scores give both: a
 * visible breakdown, and weights that are a data edit rather than a prompt edit.
 *
 * ── THE FIVE RULES THIS MODULE ENFORCES ─────────────────────────────────────
 *   1. A MISSING DIMENSION IS null, NOT ZERO. "No session read" and "outside the
 *      session" are different facts, and scoring the first as the second invents
 *      evidence. Weights are renormalised over the dimensions that ANSWERED, and
 *      coverage is reported so a 2-of-4 composite is never read as a 4-of-4 one.
 *   2. EVERY NUMBER CARRIES ITS PROVENANCE. Each part keeps the raw score, the
 *      normalised value, the probability mass behind it, and the confidence —
 *      because the docs are explicit that a Score's "probabilities and
 *      confidence" must be read ALONGSIDE the score: different distributions
 *      produce the same score, and 1.0 can mean all-on-level-1 or half-on-0-and-
 *      half-on-2.
 *   3. WEIGHTS ARE CLAMPED, NEVER TRUSTED. Negative becomes 0, a set that sums
 *      to nothing falls back to equal weighting, and the EFFECTIVE weights are
 *      returned so the UI can show what was actually applied rather than what
 *      was asked for.
 *   4. LEVELS STAND ALONE. Each level is judged against the state on its own, so
 *      they are written as concrete situations, never as degrees of a hidden
 *      scale. Max 10 levels (the API's own limit).
 *   5. PURE. No fs, no clock, no network, no model. It normalises and combines
 *      what it was handed.
 *
 * It never produces a probability, a size, or an order. It is a 0..1 column.
 */

// ── The dimensions, as DATA ────────────────────────────────────────────────
// Each level is a concrete situation a reader could point at, not an adjective.
// Level numbers are the array index from 0, per the Score primitive.
const DEFAULT_DIMENSIONS = Object.freeze({
  trend_alignment: {
    label: 'Trend alignment',
    instructions: 'How well does this setup agree with the higher-timeframe trend actually recorded in the state? '
      + 'Judge the DIRECTION agreement only — not the quality of the entry.',
    levels: [
      'Against the recorded higher-timeframe trend',
      'The higher-timeframe read is unclear, mixed or missing',
      'With the recorded higher-timeframe trend',
      'With the recorded trend and the trend is itself strengthening',
    ],
  },
  level_quality: {
    label: 'Level quality',
    instructions: 'What kind of level is this setup trading at, judged only from what the state says about the level? '
      + 'His own doctrine names "no pre-marked zone" as a mistake, so a level marked before the session is the high end.',
    levels: [
      'No identifiable level in the state',
      'A level the detector inferred, not one he had marked',
      'A level he had marked before the session',
      'A major level he had marked before the session, at a prior swing',
    ],
  },
  session_quality: {
    label: 'Session quality',
    instructions: 'How good is the moment this setup fired, judging from the session recorded in the state and his own '
      + 'session windows? Judge the TIME, not the setup.',
    levels: [
      'Outside every session window',
      'At the very edge of a session window, or in a thin period',
      'Inside a session window',
      'Inside a session window, in its first hour',
    ],
  },
  trigger_quality: {
    label: 'Trigger quality',
    instructions: 'How clean is the trigger candle or event the detector fired on, judged only from what the state '
      + 'records about it?',
    levels: [
      'No trigger recorded, or the setup was invalid',
      'A marginal trigger — the candle is present but does not fully qualify',
      'A clean trigger that meets the written conditions',
      'A textbook trigger: full qualification and clear displacement',
    ],
  },
});

const DEFAULT_WEIGHTS = Object.freeze({
  trend_alignment: 0.35,
  level_quality: 0.3,
  session_quality: 0.15,
  trigger_quality: 0.2,
});

const MAX_LEVELS = 10;   // the API's own ceiling for a Score

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round3(n) { return Math.round(n * 1000) / 1000; }

/** Dimensions and weights, overridden by rules.json where it says so. */
function scoringConfig(rules) {
  const cfg = (rules && rules.routerScoring) || {};
  const dims = {};
  for (const key of Object.keys(DEFAULT_DIMENSIONS)) {
    const base = DEFAULT_DIMENSIONS[key];
    const over = (cfg.dimensions && cfg.dimensions[key]) || null;
    const levels = (over && Array.isArray(over.levels) && over.levels.length >= 2)
      ? over.levels.filter((l) => typeof l === 'string' && l.trim()).slice(0, MAX_LEVELS)
      : base.levels.slice();
    dims[key] = {
      label: (over && typeof over.label === 'string' && over.label.trim()) ? over.label.trim() : base.label,
      instructions: (over && typeof over.instructions === 'string' && over.instructions.trim()) ? over.instructions.trim() : base.instructions,
      levels: levels.length >= 2 ? levels : base.levels.slice(),
    };
  }
  const w = {};
  const rawW = (cfg.weights && typeof cfg.weights === 'object') ? cfg.weights : {};
  for (const key of Object.keys(dims)) {
    const v = num(rawW[key]);
    // A NEGATIVE weight is clamped to 0, not replaced by the default. "The
    // weights you control" has to mean what it says: a dimension the user
    // weighted at zero carries zero. A missing or non-numeric weight is a
    // different case — that is an absent setting, so the default applies.
    // Either way the weight actually applied is reported back in weightsUsed.
    w[key] = (v != null) ? Math.max(0, v) : DEFAULT_WEIGHTS[key];
  }
  return { dimensions: dims, weights: w };
}

/**
 * The Score questions, ready to go on the wire beside any others.
 * Returns {} when disabled, so a caller can spread it safely.
 */
function buildScoreQuestions(rules) {
  const cfg = scoringConfig(rules);
  if (rules && rules.routerScoring && rules.routerScoring.enabled === false) return {};
  const q = {};
  for (const key of Object.keys(cfg.dimensions)) {
    const d = cfg.dimensions[key];
    q[key] = { type: 'score', instructions: d.instructions, criteria: d.levels };
  }
  return q;
}

/**
 * One Score answer -> a 0..1 value, or null when the dimension did not answer.
 *
 * The top level is the dimension's own length minus 1, so the normalisation
 * cannot drift from the criteria that were actually sent.
 */
function normaliseAnswer(answer, levels) {
  if (!answer || answer.type !== 'score') return null;
  const raw = num(answer.score);
  if (raw == null) return null;
  const top = Math.max(1, (Array.isArray(levels) ? levels.length : 1) - 1);
  return {
    raw,
    value: round3(Math.min(1, Math.max(0, raw / top))),
    confidence: num(answer.confidence),
    // Kept because the docs insist on reading the distribution alongside the
    // score: identical scores can hide opposite distributions.
    probabilities: answer.probabilities || null,
    legend: answer.legend || null,
  };
}

/**
 * Combine the answered dimensions.
 *
 * Weights are renormalised over what actually answered, so a state missing a
 * session read is judged on the three dimensions it HAS rather than being
 * dragged toward zero by one it does not. coverage is returned because that
 * renormalisation is exactly what makes a 2-of-4 number dangerous to read alone.
 */
function combine(answers, rules, opts) {
  const o = opts || {};
  const cfg = o.config || scoringConfig(rules);
  const parts = [];
  let weightSum = 0;
  let acc = 0;
  for (const key of Object.keys(cfg.dimensions)) {
    const d = cfg.dimensions[key];
    const n = normaliseAnswer((answers || {})[key], d.levels);
    const w = num(cfg.weights[key]);
    const part = {
      key,
      label: d.label,
      answered: !!n,
      weight: (w != null && w >= 0) ? w : 0,
      raw: n ? n.raw : null,
      value: n ? n.value : null,
      confidence: n ? n.confidence : null,
    };
    parts.push(part);
    if (n) { weightSum += part.weight; acc += part.weight * n.value; }
  }
  const answered = parts.filter((p) => p.answered);
  const total = parts.length;
  if (!answered.length) {
    return {
      composite: null, parts, coverage: { answered: 0, total },
      weightsUsed: null, reason: 'no dimension answered — nothing to combine',
    };
  }
  // A weight set that sums to nothing (all zero, or all malformed) falls back to
  // EQUAL weighting rather than to a null — otherwise a config typo silently
  // disables the feature while looking like it ran. Documented above; enforced
  // here. (The first version returned the "no dimension answered" branch for
  // this case, which was both wrong and mislabelled.)
  const equal = weightSum <= 0;
  const total_weight = equal ? answered.length : weightSum;
  let combined = 0;
  const weightsUsed = {};
  for (const p of answered) {
    const w = equal ? 1 : p.weight;
    combined += w * p.value;
    weightsUsed[p.key] = round3(w / total_weight);
  }
  return {
    composite: round3(combined / total_weight),
    parts,
    coverage: { answered: answered.length, total },
    weightsUsed,
    equalWeights: equal,
    reason: null,
  };
}

/**
 * The line the UI shows. Never a probability, never a rank, never advice.
 * Names the weakest answered dimension because that is the actionable half.
 */
function explain(result) {
  const r = result || {};
  if (r.composite == null) return 'No dimensions answered — nothing to combine.';
  const pct = Math.round(r.composite * 100);
  const answered = (r.parts || []).filter((p) => p.answered);
  const weakest = answered.slice().sort((a, b) => a.value - b.value)[0];
  const missing = (r.parts || []).filter((p) => !p.answered).map((p) => p.label);
  return 'Composite ' + pct + '% from ' + r.coverage.answered + ' of ' + r.coverage.total + ' dimensions'
    + (weakest ? ' — weakest: ' + weakest.label + ' (' + Math.round(weakest.value * 100) + '%)' : '')
    + (missing.length ? ' — no read for: ' + missing.join(', ') : '')
    + '. A weighted opinion of this setup, not a chance of winning.';
}

module.exports = {
  DEFAULT_DIMENSIONS, DEFAULT_WEIGHTS, MAX_LEVELS,
  scoringConfig, buildScoreQuestions, normaliseAnswer, combine, explain,
};
