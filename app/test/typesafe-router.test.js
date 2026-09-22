'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const router = require('../typesafe-router');
const registryMod = require('../playbook-registry');
const realRules = require('../rules.json');

const RULES = (over) => Object.assign({ sizeCap: 4, typesafe: { enabled: true } }, over || {});
// NOT realRules. app/rules.json is USER DATA — it changes the moment he flips a
// playbook switch in the app, and on 2026-09-21 he did exactly that (C-ADX went
// ON), which broke two tests that had quietly asserted his current mix as if it
// were a code constant. Behaviour is asserted against an empty config, i.e. the
// module's shipped defaults; the live file is only ever read for STRUCTURE
// (a band is ordered, a gate is locked) further down.
const DEFAULTS_RULES = { sizeCap: 4 };
const ENTRIES = registryMod.listRegistry(DEFAULTS_RULES);
const ELIGIBLE = router.eligiblePlaybooks(DEFAULTS_RULES);

// extra = additional answers on the SAME response (the plan question rides the
// same request, so the fixtures have to model that).
const ANSWER = (over, extra) => ({
  ok: true,
  answers: Object.assign(
    { match: Object.assign({ type: 'choice', choice: 'A', probabilities: { A: 1 }, confidence: 0.8 }, over || {}) },
    extra || {}),
});

// ── settings ───────────────────────────────────────────────────────────────
test('a missing router block behaves exactly like the feature being off', () => {
  const s = router.routerSettings(RULES());
  assert.equal(s.enabled, false);
  assert.equal(s.minConfidence, 0.5);
  assert.deepEqual(s.escalateBand, [0.55, 0.9]);
});

test('a reversed escalateBand is normalised rather than silently gating nothing', () => {
  const s = router.routerSettings(RULES({ typesafe: { router: { escalateBand: [0.9, 0.4] } } }));
  assert.deepEqual(s.escalateBand, [0.4, 0.9]);
});

test('a malformed band or minConfidence falls back to the default', () => {
  const s = router.routerSettings(RULES({ typesafe: { router: { escalateBand: 'nope', minConfidence: 4 } } }));
  assert.deepEqual(s.escalateBand, [0.55, 0.9]);
  assert.equal(s.minConfidence, 0.5);
});

test('the router reads its OWN switch, not typesafe.enabled', () => {
  // The journal classifier must be able to run without paying for a call per
  // armed setup. Separate switches is the whole reason the block is nested.
  const s = router.routerSettings(RULES({ typesafe: { enabled: true, router: { enabled: false } } }));
  assert.equal(s.enabled, false);
});

// ── who may be routed to ───────────────────────────────────────────────────
test('only ON setups are options — never the gate, never PO3, never a non-setup', () => {
  const ids = ELIGIBLE.map((e) => e.id);
  assert.deepEqual(ids, ['A', 'B']);
  assert.equal(ids.includes('C'), false, 'the validity gate is a filter, not a candidate tag');
  assert.equal(ids.includes('PO3'), false, 'PO3 has no entry to propose');
});

test('switching a playbook on adds it to the options without touching the code', () => {
  const r = RULES({ playbookRegistry: { 'C-ADX': { enabled: true } } });
  assert.equal(router.eligiblePlaybooks(r).map((e) => e.id).includes('C-ADX'), true);
});

test('an unknown imported playbook is never offered as an option', () => {
  const r = RULES({ playbookRegistry: { 'D-SWEEP': { enabled: true } } });
  assert.equal(router.eligiblePlaybooks(r).some((e) => e.id === 'D-SWEEP'), false);
});

test('the option list is bounded by maxOptions', () => {
  const r = RULES({ typesafe: { router: { maxOptions: 1 } } });
  assert.equal(router.eligiblePlaybooks(r).length, 1);
});

// ── the question ───────────────────────────────────────────────────────────
test('with fewer than two options there is no question to pay for', () => {
  assert.deepEqual(router.buildQuestions([ELIGIBLE[0]]), {});
  assert.deepEqual(router.buildQuestions([]), {});
});

test('the question is a typed choice whose criteria ARE the enabled playbooks', () => {
  const q = router.buildQuestions(ELIGIBLE);
  assert.equal(q.match.type, 'choice');
  assert.deepEqual(Object.keys(q.match.criteria).sort(), ['A', 'B']);
  assert.match(q.match.criteria.B, /JadeCap/);
  assert.match(q.match.instructions, /recorded state/);
});

// ── the state ──────────────────────────────────────────────────────────────
test('the state carries only values the caller actually read — absent means null', () => {
  const s = router.buildState({ playbook: 'B', tfCode: '30', direction: 'BULLISH' }, { sessionTier: 'NY' });
  assert.equal(s.fired_detector.entry, null);
  assert.equal(s.fired_detector.risk_points, null);
  assert.equal(s.structure.read_1h, null);
  assert.equal(s.context.news_blackout, false);
  assert.equal(s.fired_detector.playbook, 'B');
  assert.equal(s.context.session, 'NY');
});

test('long free text is clipped, never paraphrased or dropped', () => {
  const s = router.buildState({ structure15m: 'x'.repeat(200) }, {});
  assert.equal(s.structure.read_15m.length, 61);
  assert.equal(s.structure.read_15m.endsWith('…'), true);
});

test('a quality object passes through whole — it is already structured', () => {
  const q = { structure: 'HH-HL', swingLocation: 'at low' };
  assert.deepEqual(router.buildState({ quality: q }, {}).context.quality, q);
});

// ── shaping the answer ─────────────────────────────────────────────────────
test('probabilities are normalised and sorted into a ranking', () => {
  const out = router.shapeResult(ANSWER({ probabilities: { A: 1, B: 3 } }), ELIGIBLE, { detector: 'A' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.ranking.map((r) => r.id), ['B', 'A']);
  assert.equal(out.ranking[0].p, 0.75);
  assert.equal(out.pick, 'B');
});

test('an option the router was never offered is dropped, not reported', () => {
  const out = router.shapeResult(ANSWER({ probabilities: { A: 1, C: 5, ZZZ: 9 } }), ELIGIBLE, { detector: 'A' });
  assert.deepEqual(out.ranking.map((r) => r.id), ['A']);
});

test('a single-option answer carries no confidence, whatever the API said', () => {
  // One entry is not a decisive read; it is a read with nothing to be decisive
  // between. Reporting a confidence there would overstate it.
  const out = router.shapeResult(ANSWER({ probabilities: { A: 1 }, confidence: 0.99 }), ELIGIBLE, { detector: 'A' });
  assert.equal(out.confidence, null);
});

test('a choice with no probabilities stands as a weightless one-entry ranking', () => {
  const out = router.shapeResult(ANSWER({ choice: 'B', probabilities: null, confidence: 0.9 }), ELIGIBLE, { detector: 'A' });
  assert.equal(out.pick, 'B');
  assert.equal(out.ranking[0].p, null);
  assert.equal(out.confidence, null);
});

test('a failed call records its reason and no ranking, and never throws', () => {
  const out = router.shapeResult({ ok: false, reason: 'HTTP 429: rate limited' }, ELIGIBLE, { detector: 'A' });
  assert.equal(out.ok, false);
  assert.equal(out.pick, null);
  assert.deepEqual(out.ranking, []);
  assert.match(out.reason, /429/);
});

test('an answer naming only unknown playbooks reports why it was unusable', () => {
  const out = router.shapeResult(ANSWER({ probabilities: { ZZZ: 1 } }), ELIGIBLE, { detector: 'A' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /unknown option|no usable answer/);
});

test('the detector tag rides along so a reader needs no lookup table', () => {
  const out = router.shapeResult(ANSWER(), ELIGIBLE, { detector: 'LTF-ENGULF', setupId: 'abc' });
  assert.equal(out.detector, 'LTF-ENGULF');
  assert.equal(out.detectorCanonical, 'A');
  assert.equal(out.setupId, 'abc');
});

// ── agreement, on canonical ids ────────────────────────────────────────────
test('a historical detector id agrees with the current one — the naming change is not an edge', () => {
  const out = router.shapeResult(ANSWER({ choice: 'A', probabilities: { A: 2, B: 1 } }), ELIGIBLE, { detector: 'LTF-ENGULF' });
  assert.equal(router.agreement(out, 'LTF-ENGULF').agree, true);
  assert.equal(router.agreement(out, 'A').agree, true);
  assert.equal(router.agreement(out, 'B').agree, false);
});

test('agreement is null when either side is missing, never false', () => {
  assert.equal(router.agreement({ ok: true, pick: null }, 'A').agree, null);
  assert.equal(router.agreement({ ok: true, pick: 'A' }, null).agree, null);
});

// ── escalation ─────────────────────────────────────────────────────────────
const SETTINGS = router.routerSettings(realRules);

test('a vague read is not worth an expensive second opinion', () => {
  const out = router.escalation({ ok: true, confidence: 0.3, ranking: [{ id: 'A' }, { id: 'B' }] }, SETTINGS);
  assert.equal(out.escalate, false);
  assert.match(out.reason, /not decisive enough/);
});

test('a certain read is already covered by the mechanical gates', () => {
  const out = router.escalation({ ok: true, confidence: 0.97, ranking: [{ id: 'A' }, { id: 'B' }] }, SETTINGS);
  assert.equal(out.escalate, false);
  assert.match(out.reason, /decisive/);
});

test('only the middle band escalates — that is where a second opinion can change the read', () => {
  const out = router.escalation({ ok: true, confidence: 0.7, ranking: [{ id: 'A' }, { id: 'B' }] }, SETTINGS);
  assert.equal(out.escalate, true);
});

test('no answer and no confidence both refuse to escalate, with a reason', () => {
  assert.match(router.escalation({ ok: false }, SETTINGS).reason, /no usable router read/);
  assert.match(router.escalation({ ok: true, confidence: null }, SETTINGS).reason, /no confidence/);
});

// ── the wording rule ───────────────────────────────────────────────────────
test('the ranking line states that it is a match weight, not a chance of winning', () => {
  const out = router.shapeResult(ANSWER({ probabilities: { A: 3, B: 1 }, confidence: 0.8 }), ELIGIBLE, { detector: 'A' });
  const line = router.describeRanking(out, 'A');
  assert.match(line, /match weights over playbooks, not a chance of winning/);
  assert.match(line, /agrees with the detector/);
});

test('a disagreement names both ids, so the row is readable without the ledger', () => {
  const out = router.shapeResult(ANSWER({ choice: 'B', probabilities: { B: 2, A: 1 } }), ELIGIBLE, { detector: 'A' });
  const line = router.describeRanking(out, 'A');
  assert.match(line, /DISAGREES — detector fired A, router ranked B first/);
});

test('a failed read renders as its reason rather than an empty ranking', () => {
  const out = router.shapeResult({ ok: false, reason: 'timeout' }, ELIGIBLE, { detector: 'A' });
  assert.match(router.describeRanking(out, 'A'), /timeout/);
});

// ── the shadow row ─────────────────────────────────────────────────────────
test('the shadow row joins to the ledger by setupId and carries the agreement verdict', () => {
  const out = router.shapeResult(ANSWER({ choice: 'B', probabilities: { B: 2, A: 1 } }), ELIGIBLE, { detector: 'A', setupId: 's-1' });
  const row = router.routerShadowRow(out, { escalate: false, escalateReason: 'not decisive' });
  assert.equal(row.event, 'router-shadow');
  assert.equal(row.setupId, 's-1');
  assert.equal(row.detector, 'A');
  assert.equal(row.pick, 'B');
  assert.equal(row.agree, false);
  assert.deepEqual(row.ranking.map((r) => r.id), ['B', 'A']);
  assert.equal(row.escalate, false);
});

test('the serialized row is one JSONL line', () => {
  const row = router.routerShadowRow(router.shapeResult(ANSWER(), ELIGIBLE, { detector: 'A' }), {});
  const line = router.serializeRouterRow(row);
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.split('\n').length, 2);
  assert.equal(JSON.parse(line.trim()).event, 'router-shadow');
});

// ── the measurement ────────────────────────────────────────────────────────
const ROW = (agree, win, perContract, conf) => ({
  agree, nextWin: win, nextPnlPerContract: perContract, conf: conf != null ? conf : 0.6,
});
const rept = (n, agree, wins, per, conf) => Array.from({ length: n }, (_, i) => ROW(agree, i < wins, per, conf));

test('nothing scored yet says so, and prints no number at all', () => {
  const e = router.evaluateRouter([]);
  assert.equal(e.verdict, 'INSUFFICIENT');
  assert.equal(e.scored, 0);
  assert.match(e.summary, /No router reads have been scored/);
});

test('below the sample floor a bucket reports NO rate — not a provisional one', () => {
  const e = router.evaluateRouter(rept(10, true, 8, 40).concat(rept(10, false, 4, -20)));
  assert.equal(e.verdict, 'INSUFFICIENT');
  for (const b of e.agreement.buckets) {
    assert.equal(b.winRate, null, b.key + ' must not print a rate at n=10');
    assert.equal(b.ci, null);
    assert.equal(b.expectancy, null);
  }
  assert.match(e.summary, /answers itself with time/);
});

test('overlapping intervals at a real sample size are NO_EDGE, however different they look', () => {
  // 22/40 = 55% vs 20/40 = 50%. A five-point gap on 40 pairs is not an edge.
  const e = router.evaluateRouter(rept(40, true, 22, 30).concat(rept(40, false, 20, 10)));
  assert.equal(e.verdict, 'NO_EDGE');
  assert.equal(e.agreement.separation.intervalsDisjoint, false);
  assert.match(e.summary, /consistent with chance/);
});

test('separated intervals are the only thing that CONFIRMS the router', () => {
  const e = router.evaluateRouter(rept(40, true, 30, 40).concat(rept(40, false, 10, -30)));
  assert.equal(e.verdict, 'CONFIRMED');
  assert.equal(e.agreement.separation.intervalsDisjoint, true);
  assert.equal(e.agreement.separation.best, 'agree');
  assert.match(e.summary, /before the ranking is allowed to reorder/);
});

test('rows with no agreement verdict or no outcome are excluded, not counted as losses', () => {
  // A router read whose signal never resolved is missing data. Counting it as a
  // loss would let an outage manufacture an edge.
  const e = router.evaluateRouter([{ agree: null, nextWin: true, nextPnlPerContract: 5 }, { agree: true, nextWin: null }, ROW(true, true, 5)]);
  assert.equal(e.scored, 1);
});

test('the confidence axis measures whether a decisive read predicts anything', () => {
  const e = router.evaluateRouter(rept(32, true, 26, 40, 0.9).concat(rept(32, true, 12, -20, 0.6)));
  const decisive = e.confidence.buckets.find((b) => b.key === 'decisive');
  const split = e.confidence.buckets.find((b) => b.key === 'split');
  assert.equal(decisive.n, 32);
  assert.equal(split.n, 32);
  assert.equal(e.confidence.verdict, 'CONFIRMED');
});

test('the evaluate output always carries the floor it used, so no caller can quote it without the bar', () => {
  const e = router.evaluateRouter([]);
  assert.equal(e.minSamples, 30);
});

// ── the join back to the outcome ledger ────────────────────────────────────
const RROW = (over) => Object.assign({
  event: 'router-shadow', ts: '2026-09-19T10:00:00.000Z', setupId: 's-1',
  detector: 'A', tf: '15', signalTs: '2026-09-19T09:59:00.000Z',
  pick: 'B', agree: false, confidence: 0.7,
}, over || {});
const OROW = (over) => Object.assign({
  resolved: true, setupId: 's-1', playbook: 'A', tf: '15',
  signalTs: '2026-09-19T09:59:00.000Z', atHorizon: 12, favourable: true, hit: null,
}, over || {});

test('a router row joins its outcome by setupId', () => {
  const j = router.joinToOutcomes([RROW()], [OROW()]);
  assert.equal(j.entries.length, 1);
  assert.equal(j.entries[0].agree, false);
  assert.equal(j.entries[0].picked, 'B');
  assert.equal(j.entries[0].nextWin, true);
  assert.equal(j.entries[0].nextPnlPerContract, 12);
});

test('without a setupId the composite signalTs|playbook|tf key still joins', () => {
  const j = router.joinToOutcomes([RROW({ setupId: null })], [OROW({ setupId: null })]);
  assert.equal(j.entries.length, 1);
});

test('a row whose signal has not resolved is UNJOINED — never counted as a loss', () => {
  // The failure this app already paid for: a measurement that silently drops its
  // own sample reports "no data" forever and looks exactly like "no edge".
  const j = router.joinToOutcomes([RROW({ setupId: 's-9' })], [OROW()]);
  assert.equal(j.entries.length, 0);
  assert.equal(j.unjoined.length, 1);
  assert.equal(j.unjoined[0].setupId, 's-9');
  assert.equal(j.routerRows, 1);
});

test('an unresolved outcome row is excluded from the join entirely', () => {
  const j = router.joinToOutcomes([RROW()], [OROW({ resolved: false })]);
  assert.equal(j.entries.length, 0);
  assert.equal(j.unjoined.length, 1);
  assert.equal(j.orphanOutcomes, 0);
});

test('the stop is a loss even when the horizon happened to close green', () => {
  // Same rule as the resolver's own same-bar ambiguity: the pessimistic reading.
  const j = router.joinToOutcomes([RROW()], [OROW({ hit: 'stop', favourable: true })]);
  assert.equal(j.entries[0].nextWin, false);
});

test('the target is a win even when the horizon closed red', () => {
  const j = router.joinToOutcomes([RROW()], [OROW({ hit: 'target', favourable: false })]);
  assert.equal(j.entries[0].nextWin, true);
});

test('outcomes nothing routed to are counted, not ignored', () => {
  const j = router.joinToOutcomes([RROW()], [OROW(), OROW({ setupId: 's-2' })]);
  assert.equal(j.orphanOutcomes, 1);
});

test('a non-router line in the router file is skipped rather than joined', () => {
  const j = router.joinToOutcomes([RROW({ event: 'something-else' }), RROW()], [OROW()]);
  assert.equal(j.routerRows, 1);
  assert.equal(j.entries.length, 1);
});

test('an unusable outcome value cannot poison the expectancy average', () => {
  const j = router.joinToOutcomes([RROW()], [OROW({ atHorizon: null })]);
  assert.equal(j.entries[0].nextPnlPerContract, null);
  assert.equal(j.entries[0].nextWin, true);
});

// ── #5: the pre-trade advisory (plan_match) ────────────────────────────────
const PLAN = 'Entry conditions he wrote: only the 15M engulf at a pre-marked level, after the sweep.\nExit conditions he wrote: target the next liquidity pool, stop beyond the wick.';

test('with no written plan the question is NOT asked — a fabricated standard is worse than none', () => {
  assert.deepEqual(router.buildQuestions(ELIGIBLE, { writtenPlan: '' }), router.buildQuestions(ELIGIBLE));
  assert.equal(router.buildQuestions(ELIGIBLE, { writtenPlan: '   ' }).plan_match, undefined);
  assert.equal(router.buildQuestions(ELIGIBLE).plan_match, undefined);
});

test('a written plan adds a noul question to the SAME request', () => {
  const q = router.buildQuestions(ELIGIBLE, { writtenPlan: PLAN });
  assert.equal(q.plan_match.type, 'noul');
  assert.match(q.plan_match.instructions, /HE WROTE HIMSELF/);
  assert.equal(q.match.type, 'choice', 'the ranking question is still there');
});

test('a plan alone is enough to ask, even with only one enabled playbook', () => {
  const q = router.buildQuestions([ELIGIBLE[0]], { writtenPlan: PLAN });
  assert.equal(q.match, undefined);
  assert.equal(q.plan_match.type, 'noul');
});

test('his words go into the state verbatim, not paraphrased', () => {
  const s = router.buildState({}, { writtenPlan: PLAN });
  assert.equal(s.written_plan, PLAN);
  assert.equal(router.buildState({}, {}).written_plan, null);
});

test('a long written plan is clipped rather than dropped', () => {
  const v = router.buildState({}, { writtenPlan: 'x'.repeat(2000) }).written_plan;
  assert.equal(v.length, 801);
  assert.equal(v.endsWith('…'), true);
});

test('the plan answer is shaped onto the result with its own field', () => {
  const out = router.shapeResult(ANSWER({ probabilities: { A: 1, B: 1 }, confidence: 0.8 }, { plan_match: { type: 'noul', noul: 0.12 } }), ELIGIBLE, { detector: 'A' });
  assert.equal(out.planMatch, 0.12);
  assert.equal(out.planAsked, true);
});

test('planMatch is null when unasked — a different fact from a low score', () => {
  const out = router.shapeResult(ANSWER(), ELIGIBLE, { detector: 'A' });
  assert.equal(out.planMatch, null);
  assert.equal(out.planAsked, false);
});

test('a failed call carries no plan answer either', () => {
  const out = router.shapeResult({ ok: false, reason: 'timeout' }, ELIGIBLE, { detector: 'A' });
  assert.equal(out.planMatch, null);
  assert.equal(out.planAsked, false);
});

test('the shadow row records the plan answer and whether it was asked', () => {
  // plan_match is a SIBLING of match on the same response, not a field of it.
  const out = router.shapeResult(ANSWER(null, { plan_match: { type: 'noul', noul: 0.9 } }), ELIGIBLE, { detector: 'A' });
  const row = router.routerShadowRow(out, {});
  assert.equal(row.planMatch, 0.9);
  assert.equal(row.planAsked, true);
  const none = router.routerShadowRow(router.shapeResult(ANSWER(), ELIGIBLE, { detector: 'A' }), {});
  assert.equal(none.planMatch, null);
  assert.equal(none.planAsked, false);
});

test('the plan answer is measured on its own axis, and only when it was asked', () => {
  const onPlan = rept(32, true, 26, 40).map((e) => Object.assign(e, { plan: 0.9 }));
  const offPlan = rept(32, true, 8, -30).map((e) => Object.assign(e, { plan: 0.1 }));
  const never = rept(10, true, 5, 5);   // no plan on file — excluded, not counted as a NO
  const e = router.evaluateRouter(onPlan.concat(offPlan, never));
  assert.equal(e.planAsked, 64);
  assert.equal(e.plan.buckets.find((b) => b.key === 'onplan').n, 32);
  assert.equal(e.plan.buckets.find((b) => b.key === 'offplan').n, 32);
  assert.equal(e.plan.verdict, 'CONFIRMED');
});

test('the plan axis refuses a rate below the sample floor like every other axis', () => {
  const few = router.evaluateRouter(rept(8, true, 7, 20).map((x) => Object.assign(x, { plan: 0.9 })));
  assert.equal(few.plan.verdict, 'INSUFFICIENT');
  assert.equal(few.plan.buckets.find((b) => b.key === 'onplan').winRate, null);
});

test('the plan answer survives the join from the ledger row to the outcome', () => {
  const j = router.joinToOutcomes([Object.assign({}, RROW(), { planMatch: 0.2, planAsked: true })], [OROW()]);
  assert.equal(j.entries[0].plan, 0.2);
});

test('a row with no plan answer joins with plan null, not with a zero', () => {
  const j = router.joinToOutcomes([RROW()], [OROW()]);
  assert.equal(j.entries[0].plan, null);
});

// ── consequence-based bands + the three-way decision (2026-09-20) ───────────
// Grounded in docs.typesafe.ai/patterns/confidence-routing, whose own example
// checks a balance at 0.6 but demands 0.85+ to approve a transfer.
const BANDED = router.routerSettings({
  typesafe: { router: { enabled: true, escalateBand: [0.55, 0.9], escalateBands: { A: [0.6, 0.9], B: [0.45, 0.95] } } },
});

test('a per-playbook band overrides the global one, so one confidence can mean two things', () => {
  const bRead = { ok: true, confidence: 0.5, detector: 'B', detectorCanonical: 'B' };
  const aRead = { ok: true, confidence: 0.5, detector: 'A', detectorCanonical: 'A' };
  assert.equal(router.escalation(bRead, BANDED).escalate, true, 'B is higher-consequence: 0.5 is worth checking');
  assert.equal(router.escalation(aRead, BANDED).escalate, false, 'A at 0.5 is not a finding to spend on');
  assert.deepEqual(router.escalation(bRead, BANDED).band, [0.45, 0.95]);
  assert.deepEqual(router.escalation(aRead, BANDED).band, [0.6, 0.9]);
});

test('an unlisted playbook falls back to the global band and says so', () => {
  const r = router.escalation({ ok: true, confidence: 0.7, detector: 'C-ADX', detectorCanonical: 'C-ADX' }, BANDED);
  assert.equal(r.bandFor, 'default');
  assert.deepEqual(r.band, [0.55, 0.9]);
});

test('a historical detector id is judged by its current bands entry', () => {
  const r = router.escalation({ ok: true, confidence: 0.65, detector: 'LTF-ENGULF', detectorCanonical: null }, BANDED);
  assert.equal(r.bandFor, 'A');
  assert.deepEqual(r.band, [0.6, 0.9]);
});

test('the decision names WHICH side of the band it fell on, not just a boolean', () => {
  // The docs treat low and high confidence as opposite cases — "a safer path"
  // versus "act" — so collapsing them into one boolean is what makes a gate
  // unexplainable six weeks later.
  const low = router.escalation({ ok: true, confidence: 0.1, detectorCanonical: 'A' }, BANDED);
  const mid = router.escalation({ ok: true, confidence: 0.75, detectorCanonical: 'A' }, BANDED);
  const high = router.escalation({ ok: true, confidence: 0.99, detectorCanonical: 'A' }, BANDED);
  assert.equal(low.decision, 'below-band');
  assert.equal(mid.decision, 'in-band');
  assert.equal(high.decision, 'above-band');
  assert.equal(low.escalate, false);
  assert.equal(mid.escalate, true);
  assert.equal(high.escalate, false);
  assert.match(low.reason, /mechanical gates stay in charge/);
  assert.match(high.reason, /nothing is left for a second opinion/);
});

test('a malformed per-playbook band is ignored rather than half-applied', () => {
  const s = router.routerSettings({ typesafe: { router: { escalateBands: { A: [0.9], B: 'x', C: [0.8, 0.2] } } } });
  assert.equal(s.escalateBands.A, undefined);
  assert.equal(s.escalateBands.B, undefined);
  assert.deepEqual(s.escalateBands.C, [0.2, 0.8]);
});

test('_comment keys inside escalateBands are not treated as a playbook', () => {
  assert.equal(router.routerSettings(realRules).escalateBands._COMMENT, undefined);
});

test('the shipped rules give B a wider band than A, and every band is ordered inside 0..1', () => {
  const s = router.routerSettings(realRules);
  const a = s.escalateBands.A, b = s.escalateBands.B;
  assert.ok(a && b, 'both must be configured');
  assert.ok(b[1] - b[0] > a[1] - a[0], 'B is the higher-consequence event and gets the wider band');
  for (const k of Object.keys(s.escalateBands)) {
    const [lo, hi] = s.escalateBands[k];
    assert.ok(lo < hi, k + ' band must be ordered');
    assert.ok(lo >= 0 && hi <= 1, k + ' band must be inside 0..1');
  }
});

test('a noul criteria is an OBJECT keyed true/false — the only shape the API accepts', () => {
  // The docs describe this feature in prose without giving the shape. A string
  // is rejected with `questions.plan_match.criteria: expected object, received
  // string`, and that 400s the WHOLE request — so the ranking is lost too. Found
  // by a live call on 2026-09-21; pinned here so it is never re-guessed.
  const q = router.buildQuestions(ELIGIBLE, { writtenPlan: PLAN });
  assert.equal(typeof q.plan_match.criteria, 'object');
  assert.equal(Array.isArray(q.plan_match.criteria), false);
  assert.deepEqual(Object.keys(q.plan_match.criteria).sort(), ['false', 'true']);
  assert.match(q.plan_match.criteria.true, /satisfies the entry conditions/);
  assert.match(q.plan_match.criteria.false, /contradicts/);
});

test('a noul question still carries no confidence — the docs are explicit about that', () => {
  const out = router.shapeResult(ANSWER(null, { plan_match: { type: 'noul', noul: 0.5 } }), ELIGIBLE, { detector: 'A' });
  assert.equal(out.planMatch, 0.5);
  assert.equal(out.confidence, null, 'a one-option ranking plus a noul must not invent a confidence');
});

// ── the composite column (2026-09-21) ───────────────────────────────────────
test('the composite rides onto the shadow row with its coverage', () => {
  const out = router.shapeResult(ANSWER(), ELIGIBLE, { detector: 'A' });
  out.compositeView = { composite: 0.72, coverage: { answered: 3, total: 4 } };
  const row = router.routerShadowRow(out, {});
  assert.equal(row.composite, 0.72);
  assert.deepEqual(row.compositeCoverage, { answered: 3, total: 4 });
});

test('a row with no composite records null, not a zero', () => {
  const row = router.routerShadowRow(router.shapeResult(ANSWER(), ELIGIBLE, { detector: 'A' }), {});
  assert.equal(row.composite, null);
});

test('the composite survives the join and is measured on its own axis', () => {
  const j = router.joinToOutcomes([Object.assign({}, RROW(), { composite: 0.8 })], [OROW()]);
  assert.equal(j.entries[0].comp, 0.8);
  const strong = rept(32, true, 26, 40).map((e) => Object.assign(e, { comp: 0.8 }));
  const weak = rept(32, true, 10, -30).map((e) => Object.assign(e, { comp: 0.3 }));
  const ev = router.evaluateRouter(strong.concat(weak));
  assert.equal(ev.compositeScored, 64);
  assert.equal(ev.composite.buckets.find((b) => b.key === 'strong').n, 32);
  assert.equal(ev.composite.verdict, 'CONFIRMED');
});

test('a row without a composite is excluded from the composite axis, not counted as weak', () => {
  const ev = router.evaluateRouter(rept(40, true, 30, 40).map((e) => Object.assign(e, { comp: 0.9 }))
    .concat(rept(40, true, 10, -20)));
  assert.equal(ev.compositeScored, 40, 'only rows that carried a composite are measured');
  assert.equal(ev.composite.verdict, 'INSUFFICIENT', 'one bucket cannot separate from anything');
});



