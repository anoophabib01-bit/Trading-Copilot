'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../voice-intent');
const realRules = require('../rules.json');

const ON = { voiceRouter: { enabled: true } };
const ANSWER = (choice, conf, ok) => ({ ok: ok !== false, answers: { intent: { type: 'choice', choice, confidence: conf } } });

// ── the catalogue ──────────────────────────────────────────────────────────
test('every intent declares a kind, and only the three known kinds exist', () => {
  for (const key of Object.keys(v.DEFAULT_INTENTS)) {
    assert.ok(['read', 'action', 'agent'].includes(v.DEFAULT_INTENTS[key].kind), key + ' has an unknown kind');
  }
});

test('an action carries a confirm line and a higher threshold than a read', () => {
  // The docs' consequence rule: a read is safe at the floor, an action is not.
  const cfg = v.intentConfig(ON).intents;
  for (const k of Object.keys(cfg)) {
    if (cfg[k].kind === 'action') {
      assert.ok(cfg[k].confirm, k + ' is an action with nothing to say back');
      assert.ok(cfg[k].act >= 0.8, k + ' act threshold is too low for an action');
    }
    if (cfg[k].kind === 'read') assert.ok(cfg[k].act <= 0.7, k + ' is a harmless read but demands certainty');
  }
});

test('the catch-all always exists and is always last', () => {
  const cfg = v.intentConfig(ON).intents;
  const agent = Object.keys(cfg).filter((k) => cfg[k].kind === 'agent');
  assert.equal(agent.length, 1);
  assert.ok(cfg.ask_coach);
});

// ── the options follow the state ───────────────────────────────────────────
test('an intent whose precondition is absent is not offered', () => {
  // The model cannot pick an option it was never given, so offering "armed
  // setup" with nothing armed would invite a confident wrong answer.
  const without = v.availableIntents(ON, {}).map((i) => i.key);
  const withSetup = v.availableIntents(ON, { armedSetup: true }).map((i) => i.key);
  assert.equal(without.includes('setup_status'), false);
  assert.equal(withSetup.includes('setup_status'), true);
});

test('the catch-all survives every state, so a misroute can never trap him', () => {
  for (const ctx of [{}, { armedSetup: true }, { armedSetup: false, pendingTicket: true }]) {
    assert.equal(v.availableIntents(ON, ctx).some((i) => i.kind === 'agent'), true);
  }
});

test('an individually disabled intent disappears from the options', () => {
  const ids = v.availableIntents({ voiceRouter: { enabled: true, intents: { mark_exit: { enabled: false } } } }, {}).map((i) => i.key);
  assert.equal(ids.includes('mark_exit'), false);
});

// ── the question ───────────────────────────────────────────────────────────
test('disabled asks nothing, so a caller can spread the result safely', () => {
  assert.deepEqual(v.buildQuestions({ voiceRouter: { enabled: false } }, {}), {});
  assert.deepEqual(v.buildQuestions({}, {}), {});
});

test('the question is one typed choice whose criteria ARE the available intents', () => {
  const q = v.buildQuestions(ON, {});
  assert.equal(q.intent.type, 'choice');
  assert.deepEqual(Object.keys(q.intent.criteria).sort(), v.availableIntents(ON, {}).map((i) => i.key).sort());
  assert.match(q.intent.instructions, /misheard/);
  assert.match(q.intent.instructions, /catch-all/);
});

test('the question says the transcript may be wrong, because voice is not typing', () => {
  const q = v.buildQuestions(ON, {});
  assert.match(q.intent.instructions, /misheard words/);
  assert.match(q.intent.instructions, /Do not choose an action that the recorded app state cannot support/);
});

// ── the state ──────────────────────────────────────────────────────────────
test('the transcript goes in verbatim — never cleaned up or corrected', () => {
  const s = v.buildState('  close the tickt  ', {});
  assert.equal(s.spoken_transcript, '  close the tickt  ');
});

test('a very long transcript is clipped rather than dropped', () => {
  const s = v.buildState('x'.repeat(2000), {});
  assert.equal(s.spoken_transcript.length, v.DEFAULTS.maxTranscriptChars);
});

test('absent context is null or false, never invented', () => {
  const s = v.buildState('hello', {});
  assert.equal(s.app_state.trading_mode, null);
  assert.equal(s.app_state.armed_setup, false);
  assert.equal(s.app_state.pending_ticket, false);
});

test('the state carries the last question asked, so a bare "yes" can be resolved', () => {
  const s = v.buildState('yes', { lastConfirm: 'Mark your exit on the chart?' });
  assert.equal(s.app_state.last_question_asked, 'Mark your exit on the chart?');
});

// ── the three-way decision ─────────────────────────────────────────────────
test('below the floor nothing is routed — the full agent answers', () => {
  const r = v.route(ANSWER('account_status', 0.4), ON, {});
  assert.equal(r.decision, 'agent');
  assert.match(r.reason, /below the floor/);
});

test('a read above the floor is answered directly', () => {
  const r = v.route(ANSWER('account_status', 0.7), ON, {});
  assert.equal(r.decision, 'handle');
  assert.equal(r.intent, 'account_status');
  assert.ok(r.confidence >= r.floor);
});

test('an action between the floor and its own threshold is confirmed, not performed', () => {
  const r = v.route(ANSWER('mark_exit', 0.7), ON, {});
  assert.equal(r.decision, 'confirm');
  assert.match(r.reason, /clears the floor but not its own threshold/);
  assert.equal(r.confirmText, v.intentConfig(ON).intents.mark_exit.confirm);
});

test('an action above its threshold is STILL spoken back before it is performed', () => {
  // Confidence is not permission. This is the one place a high number must not
  // buy less scrutiny — the transcript is a guess even when the model is sure.
  const r = v.route(ANSWER('mark_exit', 0.99), ON, {});
  assert.equal(r.decision, 'confirm');
  assert.match(r.reason, /still spoken back/);
});

test('the router sending him to the coach is not a failure', () => {
  const r = v.route(ANSWER('ask_coach', 0.95), ON, {});
  assert.equal(r.decision, 'agent');
  assert.match(r.reason, /routed to the coach by the router itself/);
});

// ── fail-open, in every direction ──────────────────────────────────────────
test('a disabled router falls through to the agent with its reason', () => {
  const r = v.route(ANSWER('account_status', 0.99), { voiceRouter: { enabled: false } }, {});
  assert.equal(r.decision, 'agent');
  assert.match(r.reason, /disabled/);
});

test('a failed call falls through to the agent rather than eating the utterance', () => {
  const r = v.route({ ok: false, reason: 'HTTP 503' }, ON, {});
  assert.equal(r.decision, 'agent');
  assert.match(r.reason, /503/);
});

test('a malformed answer falls through rather than guessing', () => {
  for (const bad of [{ ok: true }, { ok: true, answers: {} }, { ok: true, answers: { intent: { type: 'noul', noul: 1 } } },
                     { ok: true, answers: { intent: { type: 'choice', choice: null } } }]) {
    assert.equal(v.route(bad, ON, {}).decision, 'agent');
  }
});

test('an intent the router was never offered is refused, not honoured', () => {
  const r = v.route(ANSWER('delete_everything', 0.99), ON, {});
  assert.equal(r.decision, 'agent');
  assert.match(r.reason, /not available/);
});

test('no confidence on a read still answers; no confidence on an ACTION goes to the coach', () => {
  // The asymmetry is deliberate: an unanswered read costs him a repeated
  // question, an unconfirmed action costs him an action.
  assert.equal(v.route(ANSWER('account_status', null), ON, {}).decision, 'handle');
  assert.equal(v.route(ANSWER('mark_exit', null), ON, {}).decision, 'agent');
});

test('route never throws, whatever it is handed', () => {
  for (const bad of [null, undefined, 42, 'x', {}, [], { ok: true, answers: { intent: 5 } }]) {
    assert.doesNotThrow(() => v.route(bad, ON, {}));
    assert.equal(v.route(bad, ON, {}).decision, 'agent');
  }
});

// ── the confirmation round-trip ────────────────────────────────────────────
test('a plain yes is an affirmation, including the ways voice mangles it', () => {
  for (const y of ['yes', 'Yes', 'yeah', 'yep', 'yup', 'correct', 'confirm', 'do it', 'go ahead', 'yes.']) {
    assert.equal(v.isAffirmation(y), true, '"' + y + '" should confirm');
  }
});

test('anything that is not a clean yes is NOT an affirmation', () => {
  // The safe direction: an unrecognised reply runs the agent rather than
  // performing an action on a half-heard "yes but wait".
  for (const n of ['yes but wait', 'no', 'yesno', 'ok maybe', '', '   ', 'why', 'yes indeed I think so', null, undefined]) {
    assert.equal(v.isAffirmation(n), false, '"' + n + '" must not confirm');
  }
});

// ── config surface ─────────────────────────────────────────────────────────
test('thresholds and descriptions are overridable from rules.json', () => {
  const cfg = v.intentConfig({ voiceRouter: { enabled: true, floor: 0.75, intents: { mark_exit: { act: 0.95 } } } });
  assert.equal(cfg.floor, 0.75);
  assert.equal(cfg.intents.mark_exit.act, 0.95);
});

test('a malformed threshold falls back rather than disabling a gate', () => {
  const cfg = v.intentConfig({ voiceRouter: { enabled: true, floor: 9, intents: { mark_exit: { act: -1 } } } });
  assert.equal(cfg.floor, v.DEFAULTS.floor);
  assert.equal(cfg.intents.mark_exit.act, v.DEFAULT_INTENTS.mark_exit.act);
});

test('the description line never claims a probability of being right', () => {
  const line = v.describeRoute(v.route(ANSWER('mark_exit', 0.9), ON, {}));
  assert.match(line, /asking first/);
  assert.equal(/%/.test(line), false, 'no percentage in a routing line');
});

test('the module still builds against his live rules file, whatever it says', () => {
  assert.doesNotThrow(() => v.buildQuestions(realRules, {}));
  assert.doesNotThrow(() => v.route(ANSWER('account_status', 0.9), realRules, {}));
});
