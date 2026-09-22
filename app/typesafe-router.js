'use strict';
/* ── typesafe-router.js — the SHADOW setup router (Phase 2, 2026-09-19) ───────
 *
 * (Anoop: "cross check what are the other possibillities to use this to make the
 * app faster and better in decision making as i want to import many more
 * playbooks in future.")
 *
 * ── THE PROBLEM IT ADDRESSES ────────────────────────────────────────────────
 * With one always-on engulf watcher on four timeframes and a second playbook on
 * SFP+FVG, several detectors now fire in the same minute and each one sends its
 * own alert. Playbook A's own alert rate already went 8 -> 30 per day (3.8x),
 * about a third of them against the higher-timeframe bias. The cost is not the
 * messages, it is that a wall of equally-weighted alerts has no ORDER, and the
 * one that mattered is read at the same speed as the four that did not.
 *
 * ── WHAT IT DOES, AND WHAT IT IS NOT ALLOWED TO DO ──────────────────────────
 * It asks Jev one typed question — "which ENABLED playbook does this state most
 * resemble?" — with the enabled setups as the options, and records the answer
 * BESIDE the detector's own tag. That is the whole feature in shadow:
 *
 *   • It RANKS what he reads first. It never vetoes, never sizes, never stops.
 *   • It is written to its OWN jsonl keyed by setupId, so the signal ledger stays
 *     append-only — the same join signal-outcome.js already uses. A "column on
 *     the ledger" is a joined column here, not a rewritten row.
 *   • Nothing consumes the ranking. It earns the right to be shown ahead of the
 *     detector's tag only if the measurement below says the ranking agrees with
 *     what actually happened MORE OFTEN THAN IT DISAGREES, with intervals that
 *     do not overlap. Until then it is a recorded opinion.
 *
 * ── ON p, AND ON confidence ─────────────────────────────────────────────────
 * `p` is a DISTRIBUTION OVER PLAYBOOKS — "how much of this state looks like B" —
 * not a probability that a trade wins, and it is never rendered as one. The UI
 * prints it as a match weight beside a playbook name, never as "% chance".
 *
 * `confidence` is derived from how peaked that distribution is, so it measures
 * how DECISIVE the classification was, not how likely it is to be right. It is
 * used for exactly one thing: deciding whether an expensive path is worth firing
 * (escalation()). It is never quoted as a chance and never used to size.
 *
 * ── WHY THE MEASUREMENT IS THE REAL PRODUCT ─────────────────────────────────
 * evaluateRouter() answers the only question that matters: when Jev's top pick
 * differed from the detector's tag, did the outcome differ too? With ~135 trades
 * over 16 days the honest answer will be INSUFFICIENT for weeks, and the module
 * says so rather than printing a number. If the two buckets never separate, the
 * router is a re-labelling of what the detectors already knew, and the correct
 * action is to DELETE it — which is a successful outcome, not a failed one.
 *
 * PURE. Builds requests, shapes answers, measures outcomes. Calls nothing, writes
 * nothing, places nothing. Unit-tested in test/typesafe-router.test.js.
 */

const driftEdge = require('./drift-edge');
const playbookSpec = require('./playbook-spec');
const registryMod = require('./playbook-registry');

const DEFAULTS = Object.freeze({
  enabled: false,              // shadow router off until the key exists
  minConfidence: 0.5,          // below this the ranking is recorded but not ranked in the UI
  escalateBand: [0.55, 0.9],   // confidence window where the expensive path is worth firing
  minSamples: 30,              // same floor as drift-edge
  maxOptions: 8,
  z: 1.96,
});

const VERDICT = driftEdge.VERDICT;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round3(n) { return Math.round(n * 1000) / 1000; }
function round2(n) { return Math.round(n * 100) / 100; }
function clip(s, max) {
  if (s == null) return null;
  const t = String(s);
  return t.length <= max ? t : t.slice(0, max) + '…';
}

/** Settings for this feature, straight off rules.json.typesafe.router. */
function routerSettings(rules) {
  const t = (rules && rules.typesafe) || {};
  const r = (t.router && typeof t.router === 'object') ? t.router : {};
  const band = Array.isArray(r.escalateBand) && r.escalateBand.length === 2
    && r.escalateBand.every((v) => Number.isFinite(Number(v)))
    ? [Math.min(Number(r.escalateBand[0]), Number(r.escalateBand[1])), Math.max(Number(r.escalateBand[0]), Number(r.escalateBand[1]))]
    : DEFAULTS.escalateBand.slice();
  const mc = num(r.minConfidence);
  // ── Consequence-based thresholds (docs: patterns/confidence-routing) ──────
  // The official pattern is explicit that a threshold belongs to the ACTION,
  // not to the model: "checking a balance at 0.6 is fine ... but approving a
  // transfer requires very high confidence". One global band for every playbook
  // says a routine A fire and a Playbook B confirm carry the same consequences,
  // and they do not — B is the highest-conviction event this app produces and
  // the one that can surface a trade ticket. escalBands lets the band differ
  // per playbook, with the global band as the fallback for anything unlisted.
  const bands = {};
  const rawBands = (r.escalateBands && typeof r.escalateBands === 'object') ? r.escalateBands : {};
  for (const id of Object.keys(rawBands)) {
    if (id.startsWith('_')) continue;
    const b = rawBands[id];
    if (Array.isArray(b) && b.length === 2 && b.every((v) => Number.isFinite(Number(v)))) {
      bands[String(id).toUpperCase()] = [Math.min(Number(b[0]), Number(b[1])), Math.max(Number(b[0]), Number(b[1]))];
    }
  }
  return {
    enabled: r.enabled === true,
    minConfidence: (mc != null && mc >= 0 && mc <= 1) ? mc : DEFAULTS.minConfidence,
    escalateBand: band,
    escalateBands: bands,
    minSamples: num(r.minSamples) > 0 ? Number(r.minSamples) : DEFAULTS.minSamples,
    maxOptions: num(r.maxOptions) > 0 ? Number(r.maxOptions) : DEFAULTS.maxOptions,
    z: DEFAULTS.z,
  };
}

/**
 * The options the router may choose between: playbooks that are SWITCHED ON and
 * that are actual setups. A gate (C) is not a candidate — it is a filter, and
 * offering it as a tag would let the model label a trade "invalid" as though
 * that were a playbook. An unknown id has no detector, so it cannot be a
 * plausible match for a state that a detector produced.
 */
function eligiblePlaybooks(rules, settings) {
  const cfg = settings || routerSettings(rules);
  return registryMod.listRegistry(rules)
    .filter((e) => e.kind === 'setup' && e.enabled && !e.unknown)
    .slice(0, cfg.maxOptions);
}

/**
 * The one question. Returns {} when there is nothing to discriminate: with a
 * single eligible playbook every state would "match" it, which is a fact about
 * the registry rather than a reading of the market — and paying for it would be
 * paying to be told what the detector already said.
 */
function buildQuestions(registryEntries, opts) {
  const list = Array.isArray(registryEntries) ? registryEntries.filter(Boolean) : [];
  const o = opts || {};
  const q = {};
  // ── The pre-trade advisory (#5), 2026-09-19 ─────────────────────────────
  // A SECOND question on the SAME request, so it is free: the state is already
  // serialized and sent. It asks whether the setup in front of him matches the
  // plan HE WROTE — the only thing in this app that can answer that is his own
  // pre-session text.
  //
  // NO WRITTEN PLAN, NO QUESTION. Asking "does this match the plan?" with no
  // plan on file invites the model to invent one to compare against, and a
  // fabricated standard is worse than no advisory at all. Absent text means the
  // question is simply not asked, and the ledger row records that it was never
  // asked rather than recording a low score.
  if (typeof o.writtenPlan === 'string' && o.writtenPlan.trim()) {
    q.plan_match = {
      type: 'noul',
      instructions: 'Does the setup in this state satisfy the entry conditions HE WROTE HIMSELF in written_plan — the '
        + 'instrument, the setup, the level and the invalidation he committed to before the session? Judge against HIS '
        + 'words only. If written_plan does not address a feature of this state, treat that feature as neither for nor '
        + 'against. Answer NO when the state contradicts something he wrote; answer NO when the state is simply not '
        + 'something he wrote about.',
      // The docs allow criteria on a Noul as an optional clarification of what
      // yes and no mean. Worth spending the tokens here: "does it match the
      // plan" is exactly the kind of question whose NO is ambiguous, and the
      // clarification is what keeps a low score from meaning three things.
      //
      // THE SHAPE IS {"true": ..., "false": ...} — an OBJECT with those exact
      // keys, not a string and not {"yes":...}. The docs describe the feature in
      // prose without giving the shape, and a string is rejected outright:
      //   HTTP 400  questions.plan_match.criteria  expected object, received string
      // That failure is total — the whole request 400s, so the RANKING is lost
      // too, not just the plan answer. Found by a live call, not by the tests,
      // which is why both shapes are now pinned in typesafe-router.test.js.
      criteria: {
        true: 'The setup satisfies the entry conditions he wrote in written_plan: the instrument, the setup, the '
          + 'level and the invalidation all agree with his words.',
        false: 'The state contradicts something in his written plan, or it is a setup his plan never described.',
      },
    };
  }
  if (list.length < 2) return q;
  const criteria = {};
  for (const e of list) criteria[e.id] = e.label + ' — ' + e.blurb;
  q.match = {
      type: 'choice',
      instructions: 'Which single playbook does this market state most resemble, judged ONLY from the recorded state? '
        + 'Each option is the playbook it names. Answer from the evidence in the state — the timeframe, the direction, '
        + 'the structure reads and the session — not from which one tends to work. If the state is genuinely between two, '
        + 'still choose one, and let the probabilities carry the doubt. '
        + 'A setup is only worth ranking if it can pay for itself: economics.must_beat_points is the cost this '
        + 'trade has to clear, and economics.r_multiple is what it pays if it works. Weigh a setup that cannot '
        + 'clear its own cost accordingly.',
      criteria,
  };
  return q;
}

/**
 * The state handed to the model. Structured, and built ONLY from values the
 * caller actually read — an absent field is null, never a guess. Same discipline
 * as verdict-grounding: a number the app did not measure must not appear.
 */
function buildState(setup, ctx) {
  const s = setup || {};
  const c = ctx || {};
  return {
    // His own words, verbatim and clipped — never paraphrased. Null when he
    // wrote nothing, which is also what suppresses the plan_match question.
    written_plan: clip(c.writtenPlan, 800) || null,
    // ── THE ECONOMICS (2026-09-21, from the Jev trading repos) ──────────────
    // jev-trader tells its model exactly what a trade has to beat: "The trade
    // crosses the spread (spreadBps), so the move must beat that cost." Its state
    // is built from derived quantities — spread, imbalance, returns in bps — not
    // raw numbers, which is also what the docs mean by the model not being a
    // calculator. This app's state described the setup and never said what made
    // it not worth taking, which is half of a trade decision.
    economics: (c.economics && typeof c.economics === 'object') ? {
      risk_points: num(c.economics.riskPoints),
      reward_points: num(c.economics.rewardPoints),
      r_multiple: num(c.economics.rMultiple),
      cost_points: num(c.economics.costPoints),
      // Stated as a number the model can compare against, because "must beat the
      // cost" is only actionable if the cost is in the state.
      must_beat_points: num(c.economics.mustBeatPoints),
    } : null,
    fired_detector: {
      playbook: s.playbook != null ? String(s.playbook) : null,
      timeframe: s.tfCode != null ? String(s.tfCode) : (s.tf != null ? String(s.tf) : null),
      direction: s.direction != null ? String(s.direction) : null,
      entry: num(s.entry),
      stop: num(s.stop),
      target: num(s.target),
      risk_points: num(s.riskPoints),
      target_r: num(s.targetR),
    },
    structure: {
      read_15m: clip(s.structure15m, 60),
      read_1h: clip(s.structure1h, 60),
      htf_bias: clip(s.htfBias, 40),
      htf_confirmation: clip(s.htfConfirmation, 40),
    },
    context: {
      session: clip(c.sessionTier, 30),
      hour_trend: clip(c.hourTrend, 30),
      news_blackout: c.newsBlackout === true,
      symbol: clip(c.symbol, 20),
      quality: (s.quality && typeof s.quality === 'object') ? s.quality : null,
    },
  };
}

/**
 * Shape the client's answer into a ranking.
 *
 * Ordered by probability when the API supplied them; otherwise the single
 * `choice` stands as a one-entry ranking with NO weight, which is the honest
 * rendering of "it picked one and told us nothing about the runner-up".
 */
function shapeResult(clientResult, registryEntries, meta) {
  const r = clientResult || {};
  const m = meta || {};
  const list = Array.isArray(registryEntries) ? registryEntries.filter(Boolean) : [];
  const byId = {};
  for (const e of list) byId[e.id] = e;
  if (!r.ok) {
    return {
      ok: false, reason: r.reason || 'router call did not succeed',
      ranking: [], pick: null, confidence: null, planMatch: null, planAsked: false, detector: m.detector || null,
      setupId: m.setupId || null, at: m.at || new Date().toISOString(),
    };
  }
  // ── The pre-trade advisory's answer (#5) ────────────────────────────────
  // A noul on the SAME request, so it costs nothing extra. null means the
  // question was NEVER ASKED (no written plan), which is a different fact from
  // a low score — the ledger must be able to tell "he wrote no plan" apart from
  // "the state did not match his plan".
  const planAnswer = (r.answers && r.answers.plan_match) || null;
  const planMatch = (planAnswer && planAnswer.type === 'noul' && typeof planAnswer.noul === 'number')
    ? planAnswer.noul : null;
  const a = (r.answers && r.answers.match) || null;
  let ranking = [];
  let confidence = null;
  if (a && a.type === 'choice') {
    confidence = a.confidence != null ? a.confidence : null;
    const probs = a.probabilities || null;
    if (probs) {
      let total = 0;
      for (const k of Object.keys(probs)) total += probs[k];
      ranking = Object.keys(probs)
        .filter((k) => byId[k])
        .map((k) => ({ id: k, label: byId[k].label, p: round3(total > 0 ? probs[k] / total : probs[k]) }))
        .sort((x, y) => y.p - x.p);
    }
    // A DISTRIBUTION IS AUTHORITATIVE. When the API returned probabilities, it
    // answered the question it was asked, and falling back to `choice` on a
    // distribution that covers none of our options would silently rescue a
    // malformed response into a confident one-entry ranking. The fallback exists
    // only for the genuinely weightless case: a choice with no distribution at
    // all. (test/typesafe-router.test.js caught the rescue: probabilities over
    // an option we never offered came back as ok:true.)
    const hadProbs = !!(probs && Object.keys(probs).length);
    if (!ranking.length && !hadProbs && a.choice && byId[a.choice]) {
      ranking = [{ id: a.choice, label: byId[a.choice].label, p: null }];
    }
  }
  const pick = ranking.length ? ranking[0].id : null;
  return {
    ok: !!pick,
    reason: pick ? null : 'no usable answer (unknown option or malformed probabilities)',
    ranking,
    pick,
    planMatch,
    // True when the plan question was actually put to the model. Distinct from
    // planMatch !== null so a caller can count "how often do I even have a plan
    // written down" without inferring it from answers.
    planAsked: planMatch !== null,
    // A one-entry ranking or a pick with no distribution is not a decisive read,
    // whatever the API said about it.
    confidence: (ranking.length > 1) ? confidence : null,
    model: r.model || null,
    usage: r.usage || null,
    latencyMs: r.latencyMs != null ? r.latencyMs : null,
    detector: m.detector != null ? String(m.detector) : null,
    detectorCanonical: m.detector != null ? playbookSpec.canonicalId(m.detector) : null,
    setupId: m.setupId || null,
    at: m.at || new Date().toISOString(),
  };
}

/**
 * Did the router agree with the detector that fired?
 *
 * Compared on CANONICAL ids, because the ledger still holds historical
 * 'LTF-ENGULF' and 'C' rows that both mean Playbook A. Comparing raw strings
 * would score every historical engulf as a disagreement and manufacture an
 * "edge" out of a naming change.
 */
function agreement(rankingOrResult, detectorId) {
  const r = rankingOrResult || {};
  const pick = r.pick || (Array.isArray(r) && r.length ? r[0].id : null);
  const detector = detectorId != null ? playbookSpec.canonicalId(detectorId) : (r.detectorCanonical || null);
  if (!pick || !detector) return { agree: null, picked: pick || null, detector: detector || null };
  return { agree: playbookSpec.canonicalId(pick) === detector, picked: pick, detector };
}

/**
 * Is this read decisive enough to be worth the expensive path (debate / judge
 * escalation)? Two-sided on purpose:
 *   • below the band  — the model is not sure, so a slow expensive answer would
 *                       be an expensive way of saying "unclear";
 *   • above the band  — the model is certain, and the detector's own tag plus a
 *                       mechanical gate already cover the easy cases.
 * The band is where a second opinion can actually change the reading.
 */
function escalation(result, settings) {
  const cfg = settings || DEFAULTS;
  const r = result || {};
  // Which band applies to THIS read. Keyed on the detector's canonical id, so a
  // historical 'LTF-ENGULF' row is judged by Playbook A's band, not by none.
  const key = r.detectorCanonical || (r.detector != null ? playbookSpec.canonicalId(r.detector) : null);
  const bands = cfg.escalateBands || {};
  const band = (key && bands[String(key).toUpperCase()]) || cfg.escalateBand || DEFAULTS.escalateBand;
  const bandFor = (key && bands[String(key).toUpperCase()]) ? key : 'default';
  if (!r.ok) return { escalate: false, decision: 'no-read', band, bandFor, reason: 'no usable router read' };
  if (r.confidence == null) {
    return { escalate: false, decision: 'no-confidence', band, bandFor, reason: 'the answer carried no confidence, so there is nothing to gate on' };
  }
  const [lo, hi] = band;
  // The THREE outcomes are distinct on purpose, because the official pattern
  // treats them as different cases — a low-confidence read means "a safer path",
  // a high-confidence read means "act" — and collapsing them into one boolean is
  // what makes a gate unexplainable six weeks later. Both are still "do not
  // spend on a second opinion", but for opposite reasons and with opposite
  // remedies, so the caller is handed which one it was.
  if (r.confidence < lo) {
    return {
      escalate: false, decision: 'below-band', confidence: r.confidence, band, bandFor,
      reason: 'read is not decisive enough (' + round2(r.confidence) + ' < ' + lo + ') to be worth a second opinion'
        + ' — the typed read is not a finding to act on, so the mechanical gates stay in charge',
    };
  }
  if (r.confidence > hi) {
    return {
      escalate: false, decision: 'above-band', confidence: r.confidence, band, bandFor,
      reason: 'read is decisive (' + round2(r.confidence) + ' > ' + hi + '); nothing is left for a second opinion to resolve',
    };
  }
  return {
    escalate: true, decision: 'in-band', confidence: r.confidence, band, bandFor,
    reason: 'read is confident enough to be worth checking and not so certain that checking is wasted ('
      + round2(r.confidence) + ' in [' + lo + ', ' + hi + '])',
  };
}

/**
 * The line the UI shows. NEVER a percentage chance of winning — `p` is a match
 * weight over playbooks and the text says so.
 */
function describeRanking(result, detectorId) {
  const r = result || {};
  if (!r.ok) return 'Router (shadow): ' + (r.reason || 'no read') + '.';
  const ag = agreement(r, detectorId);
  // `label` is present on a LIVE result but STRIPPED when the row is persisted
  // (routerShadowRow keeps only {id, p}), so reading it off a row replayed from
  // disk rendered "undefined 99% > undefined 1%" — the panel's own last-read
  // line, visibly broken, for as long as it has existed. Fall back to the id,
  // which is always there; a raw id is worse prose than a label and far better
  // than the word "undefined".
  const parts = r.ranking.map((e) => (e.label || e.id || '?') + (e.p != null ? ' ' + Math.round(e.p * 100) + '%' : ''));
  const tail = ag.agree === true ? 'agrees with the detector'
    : ag.agree === false ? 'DISAGREES — detector fired ' + ag.detector + ', router ranked ' + ag.picked + ' first'
    : 'nothing to compare against';
  return 'Router (shadow) ranked: ' + parts.join(' > ') + ' — ' + tail
    + '. Those are match weights over playbooks, not a chance of winning.';
}

// ── The measurement ─────────────────────────────────────────────────────────

/**
 * One row per router call, keyed by setupId so it joins to the signal ledger the
 * same way signal-outcome rows do. Pure row construction; the fs is the caller's.
 */
function routerShadowRow(result, ctx) {
  const r = result || {};
  const c = ctx || {};
  return {
    ts: c.ts || r.at || new Date().toISOString(),
    event: 'router-shadow',
    setupId: r.setupId || c.setupId || null,
    detector: r.detector != null ? r.detector : null,
    detectorCanonical: r.detectorCanonical || null,
    // The ledger's own join key, carried verbatim so this row can be matched to
    // an outcome row written by signal-outcome.js (which keys on
    // signalTs|playbook|tf) without any lookup table in between.
    tf: c.tf != null ? String(c.tf) : null,
    signalTs: c.signalTs != null ? c.signalTs : null,
    ok: !!r.ok,
    reason: r.reason || null,
    pick: r.pick || null,
    agree: agreement(r, r.detectorCanonical).agree,
    confidence: r.confidence != null ? r.confidence : null,
    planMatch: r.planMatch != null ? r.planMatch : null,
    planAsked: !!r.planAsked,
    // The composite (composite-score.js) is a 0..1 column, never a verdict. It
    // rides here so the SAME Wilson evaluator that judges the ranking can judge
    // it, with no second measurement stack.
    composite: (r.compositeView && r.compositeView.composite != null) ? r.compositeView.composite : null,
    compositeCoverage: (r.compositeView && r.compositeView.coverage) ? r.compositeView.coverage : null,
    ranking: Array.isArray(r.ranking) ? r.ranking.map((e) => ({ id: e.id, p: e.p })) : [],
    model: r.model || null,
    latencyMs: r.latencyMs != null ? r.latencyMs : null,
    usage: r.usage || null,
    escalate: c.escalate != null ? !!c.escalate : null,
    escalateReason: c.escalateReason || null,
  };
}

function serializeRouterRow(row) {
  return JSON.stringify(row) + '\n';
}

/**
 * Join router rows to resolved outcomes and measure whether the ranking means
 * anything.
 *
 * @param entries [{ agree, conf, nextWin, nextPnlPerContract, picked, detector }]
 *
 * Two axes, because they answer different questions:
 *   agreement  — when the router disagreed with the detector, did the outcome
 *                differ? (the question Phase 2 exists to answer)
 *   confidence — does a decisive read predict a better outcome? (whether
 *                escalation() is gating on something real)
 *
 * Same refusal as drift-edge: below minSamples a bucket reports NO rate at all,
 * and an edge is only CONFIRMED when two buckets' intervals do not overlap.
 */
function summarise(entries, cfg) {
  const n = entries.length;
  if (!n) return { n: 0, verdict: VERDICT.INSUFFICIENT, winRate: null, ci: null, expectancy: null, wins: 0 };
  const wins = entries.filter((e) => e.nextWin).length;
  const ci = driftEdge.wilson(wins, n, cfg.z);
  const enough = n >= cfg.minSamples;
  return {
    n, wins,
    winRate: enough ? ci.p : null,
    ci: enough ? { lo: ci.lo, hi: ci.hi } : null,
    expectancy: enough ? round2(entries.reduce((a, e) => a + (num(e.nextPnlPerContract) || 0), 0) / n) : null,
    verdict: enough ? VERDICT.NO_EDGE : VERDICT.INSUFFICIENT,
  };
}

function axisFrom(entries, cfg, keyFn, labels) {
  const buckets = [];
  for (const [key, label] of labels) {
    const rows = entries.filter((e) => keyFn(e) === key);
    buckets.push(Object.assign({ key, label }, summarise(rows, cfg)));
  }
  const usable = buckets.filter((b) => b.winRate != null);
  let verdict = VERDICT.INSUFFICIENT;
  let separation = null;
  if (usable.length >= 2) {
    const sorted = usable.slice().sort((a, b) => b.winRate - a.winRate);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    const disjoint = best.ci.lo > worst.ci.hi;
    separation = { best: best.key, worst: worst.key, gap: round3(best.winRate - worst.winRate), intervalsDisjoint: disjoint };
    verdict = disjoint ? VERDICT.CONFIRMED : VERDICT.NO_EDGE;
  }
  return { buckets, verdict, separation };
}

function evaluateRouter(entries, options) {
  const cfg = Object.assign({ minSamples: DEFAULTS.minSamples, z: DEFAULTS.z }, options || {});
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.agree !== null && e.agree !== undefined && e.nextWin !== undefined && e.nextWin !== null);
  const byAgreement = axisFrom(list, cfg, (e) => (e.agree ? 'agree' : 'disagree'),
    [['agree', 'router agreed with the detector'], ['disagree', 'router disagreed']]);
  const byConfidence = axisFrom(list.filter((e) => num(e.conf) != null), cfg,
    (e) => (Number(e.conf) >= 0.75 ? 'decisive' : 'split'),
    [['decisive', 'decisive read (>=0.75)'], ['split', 'split read (<0.75)']]);
  // The plan advisory's own axis (#5). Only rows where the question was actually
  // ASKED take part — a day with no written plan is missing data, not a "no".
  const byPlan = axisFrom(list.filter((e) => num(e.plan) != null), cfg,
    (e) => (Number(e.plan) >= 0.5 ? 'onplan' : 'offplan'),
    [['onplan', 'matched his written plan'], ['offplan', 'did not match his written plan']]);
  // The composite's own axis: does a weighted grade of the setup predict the
  // outcome better than the ranking does? Only rows that carried a composite
  // take part — a state with no dimensions answered is missing data, not a low
  // score, and counting it as one would blame the grade for the silence.
  const byComposite = axisFrom(list.filter((e) => num(e.comp) != null), cfg,
    (e) => (Number(e.comp) >= 0.6 ? 'strong' : 'weak'),
    [['strong', 'composite >= 0.60'], ['weak', 'composite < 0.60']]);

  let summary;
  if (!list.length) {
    summary = 'No router reads have been scored yet. Every armed setup is being routed once the shadow router is switched on, and each read is scored when that signal resolves.';
  } else if (byAgreement.verdict === VERDICT.CONFIRMED) {
    const s = byAgreement.separation;
    summary = 'The router separates outcomes: ' + s.best + ' wins more than ' + s.worst + ' with non-overlapping intervals. That is the evidence required before the ranking is allowed to reorder what you read.';
  } else if (byAgreement.verdict === VERDICT.NO_EDGE) {
    const b = byAgreement.buckets;
    summary = 'No demonstrated edge. ' + b.map((x) => x.label + ': ' + Math.round((x.winRate || 0) * 100) + '% (n=' + x.n + ')').join(' vs ')
      + '. The intervals overlap — at this sample size that gap is consistent with chance. Until it separates, the router stays a recorded opinion and the detector keeps the tag.';
  } else {
    summary = 'Not enough scored reads to test the router yet (' + list.length + ' so far; '
      + cfg.minSamples + ' per bucket are needed). This answers itself with time, not with argument.';
  }

  return {
    verdict: byAgreement.verdict,
    agreement: byAgreement,
    confidence: byConfidence,
    plan: byPlan,
    planAsked: list.filter((e) => num(e.plan) != null).length,
    composite: byComposite,
    compositeScored: list.filter((e) => num(e.comp) != null).length,
    scored: list.length,
    minSamples: cfg.minSamples,
    summary,
  };
}

/**
 * Join router rows to resolved signal outcomes.
 *
 * ── WHY setupId FIRST, AND WHY THE FALLBACK MATTERS ─────────────────────────
 * The signal ledger's own outcome rows key on `signalTs|playbook|tf`, so a
 * router row carries the same three fields and joins that way. setupId is tried
 * first because it is the only key that cannot collide — two engulf fires on the
 * same timeframe in the same second are one bucket under the composite key.
 *
 * Rows that do not join are RETURNED, not dropped. This is the failure this repo
 * has already paid for once: the outcome ledger ran for nine days producing
 * nothing because every row silently failed to resolve. A measurement that
 * quietly discards its own sample reports "no data" forever and looks identical
 * to "no edge", so the caller is handed the counts and the first few keys.
 *
 * @param routerRows  rows from DATA/signals/<day>.router.jsonl
 * @param outcomeRows rows from DATA/signals/<day>.outcomes.jsonl
 */
function joinToOutcomes(routerRows, outcomeRows) {
  const outs = (Array.isArray(outcomeRows) ? outcomeRows : []).filter((o) => o && o.resolved);
  const bySetup = new Map();
  // The composite key is built ONLY from outcomes that carry no setupId — rows
  // written before 2026-09-19, plus any resolver path that could not see one.
  // Letting a row WITH an id into this map would let a router row whose id
  // disagrees silently match on timestamp instead, which scores the router
  // against a different signal's outcome. (Caught by
  // test/typesafe-router.test.js: setupId s-9 joined s-1's outcome.)
  const byKey = new Map();
  for (const o of outs) {
    if (o.setupId) bySetup.set(String(o.setupId), o);
    else byKey.set([o.signalTs, o.playbook || '', o.tf || ''].join('|'), o);
  }
  const entries = [];
  const unjoined = [];
  const usedOutcomes = new Set();
  for (const r of Array.isArray(routerRows) ? routerRows : []) {
    if (!r || r.event !== 'router-shadow') continue;
    let o = null;
    if (r.setupId && bySetup.has(String(r.setupId))) o = bySetup.get(String(r.setupId));
    else if (r.signalTs) {
      // Legacy fallback, and ONLY for outcomes that could not be keyed by id.
      const composite = byKey.get([r.signalTs, r.detector || '', r.tf || ''].join('|'));
      if (composite && (!r.setupId || !composite.setupId)) o = composite;
    }
    if (!o) {
      // An unresolved signal is PENDING, not a loss: the horizon may not have
      // elapsed yet. Only a row that is old enough to have resolved counts as a
      // genuine join failure, and the caller can see both.
      unjoined.push({ setupId: r.setupId || null, pick: r.pick || null, detector: r.detector || null, ts: r.ts || null });
      continue;
    }
    usedOutcomes.add(o);
    const win = o.hit === 'target' ? true : (o.hit === 'stop' ? false : (o.favourable === true));
    entries.push({
      setupId: r.setupId || o.setupId || null,
      agree: r.agree === true ? true : (r.agree === false ? false : null),
      conf: num(r.confidence),
      plan: num(r.planMatch),
      comp: num(r.composite),
      picked: r.pick || null,
      detector: r.detector || o.playbook || null,
      // POINTS per contract, not dollars: the outcome ledger measures the
      // signal's own excursion in price. Calling points "dollars" would need a
      // point value this module does not have and must not assume.
      nextPnlPerContract: num(o.atHorizon),
      nextWin: win,
      hit: o.hit || null,
    });
  }
  const orphanOutcomes = outs.filter((o) => !usedOutcomes.has(o)).length;
  return { entries, unjoined, orphanOutcomes, routerRows: (Array.isArray(routerRows) ? routerRows : []).filter((r) => r && r.event === 'router-shadow').length };
}

module.exports = {
  DEFAULTS, VERDICT, routerSettings, eligiblePlaybooks, buildQuestions, buildState,
  shapeResult, agreement, escalation, describeRanking, routerShadowRow,
  serializeRouterRow, evaluateRouter, summarise, axisFrom, joinToOutcomes,
};
