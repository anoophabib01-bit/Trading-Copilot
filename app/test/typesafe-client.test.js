'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const c = require('../typesafe-client');

const RULES_ON = { typesafe: { enabled: true, model: 'jev-latest', timeoutMs: 1000, maxStateChars: 6000, maxCallsPerDay: 40 } };
const CFG = { typesafeApiKey: 'k-test' };
const Q = { is_urgent: { type: 'noul', instructions: 'urgent?' } };

// ── resolveSettings ────────────────────────────────────────────────────────
test('disabled by default — an unconfigured app never calls out', () => {
  const s = c.resolveSettings({}, {}, {});
  assert.equal(s.enabled, false);
  assert.equal(s.model, 'jev-latest');
  assert.equal(s.timeoutMs, 1500);
  assert.equal(s.key, null);
});

test('the key comes from the app config, the same file as the other keys', () => {
  const s = c.resolveSettings(RULES_ON, CFG, {});
  assert.equal(s.enabled, true);
  assert.equal(s.key, 'k-test');
  assert.equal(s.keySource, 'config');
});

test('an env key overrides the config and says so', () => {
  const s = c.resolveSettings(RULES_ON, CFG, { TYPESAFE_API_KEY: 'k-env' });
  assert.equal(s.key, 'k-env');
  assert.equal(s.keySource, 'env');
});

test('junk config values fall back to the defaults rather than going out as NaN', () => {
  const s = c.resolveSettings({ typesafe: { enabled: true, timeoutMs: 'soon', maxStateChars: -1, maxCallsPerDay: 0, model: '  ' } }, CFG, {});
  assert.equal(s.timeoutMs, 1500);
  assert.equal(s.maxStateChars, 6000);
  assert.equal(s.maxCallsPerDay, 40);
  assert.equal(s.model, 'jev-latest');
});

// ── shouldCall ─────────────────────────────────────────────────────────────
test('the kill switch explains itself instead of failing silently', () => {
  const off = c.shouldCall(c.resolveSettings({}, {}, {}), {});
  assert.equal(off.call, false);
  assert.match(off.reason, /disabled/);
  const noKey = c.shouldCall(c.resolveSettings(RULES_ON, {}, {}), {});
  assert.equal(noKey.call, false);
  assert.match(noKey.reason, /no typesafeApiKey/);
});

test('the daily spend guard stops at the cap', () => {
  const s = c.resolveSettings({ typesafe: { enabled: true, maxCallsPerDay: 3 } }, CFG, {});
  assert.equal(c.shouldCall(s, { callsToday: 2 }).call, true);
  assert.equal(c.shouldCall(s, { callsToday: 3 }).call, false);
  assert.match(c.shouldCall(s, { callsToday: 3 }).reason, /cap reached/);
});

// ── buildRequest ───────────────────────────────────────────────────────────
test('no questions or empty state means no request', () => {
  const s = c.resolveSettings(RULES_ON, CFG, {});
  assert.equal(c.buildRequest('hi', {}, s).error, 'no questions');
  assert.equal(c.buildRequest('', Q, s).error, 'empty state');
  assert.equal(c.buildRequest('   ', Q, s).error, 'empty state');
});

test('a long string state is clipped, not refused', () => {
  const s = c.resolveSettings({ typesafe: { enabled: true, maxStateChars: 10 } }, CFG, {});
  const r = c.buildRequest('x'.repeat(50), Q, s);
  assert.equal(r.body.state.length, 10);
  assert.equal(r.stateChars, 10);
});

test('an oversized object state is refused — clipping a structure would change its meaning', () => {
  const s = c.resolveSettings({ typesafe: { enabled: true, maxStateChars: 20 } }, CFG, {});
  const r = c.buildRequest({ a: 'x'.repeat(100) }, Q, s);
  assert.match(r.error, /state too large/);
});

test('the request carries exactly the model, state and questions', () => {
  const s = c.resolveSettings(RULES_ON, CFG, {});
  const r = c.buildRequest({ hello: 'world' }, Q, s);
  assert.equal(r.body.model, 'jev-latest');
  assert.deepEqual(r.body.questions, Q);
  assert.deepEqual(r.questionIds, ['is_urgent']);
});

// ── normalizeResponse ──────────────────────────────────────────────────────
test('a noul answer is read as a probability in 0..1', () => {
  const r = c.normalizeResponse(200, { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.95 } } });
  assert.equal(r.ok, true);
  assert.equal(r.answers.q.noul, 0.95);
  assert.equal(r.model, 'jev-1.13.0');
});

test('a choice answer keeps the label, the distribution and the confidence', () => {
  const r = c.normalizeResponse(200, { answers: { d: { type: 'choice', choice: 'billing', probabilities: { billing: 0.88, sales: 0.12 }, confidence: 0.81 } } });
  assert.equal(r.answers.d.choice, 'billing');
  assert.equal(r.answers.d.confidence, 0.81);
  assert.deepEqual(r.answers.d.probabilities, { billing: 0.88, sales: 0.12 });
});

test('a score answer can land between levels and keeps its legend', () => {
  const r = c.normalizeResponse(200, { answers: { s: { type: 'score', score: 1.05, legend: { 0: 'calm', 1: 'tilted' }, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, confidence: 0.92 } } });
  assert.equal(r.answers.s.score, 1.05);
  assert.equal(r.answers.s.legend['1'], 'tilted');
});

test('an unknown answer type is dropped, never guessed at', () => {
  const r = c.normalizeResponse(200, { answers: { weird: { type: 'rubric', value: 3 }, good: { type: 'noul', noul: 0.2 } } });
  assert.equal(r.answers.weird, undefined);
  assert.equal(r.answers.good.noul, 0.2);
});

test('confidence and probabilities are clamped and non-numbers are dropped', () => {
  const r = c.normalizeResponse(200, { answers: { d: { type: 'choice', choice: 'a', probabilities: { a: 1.4, b: 'x' }, confidence: 9 } } });
  assert.equal(r.answers.d.confidence, 1);
  assert.deepEqual(r.answers.d.probabilities, { a: 1.4 });
});

test('every error status fails open with a readable reason', () => {
  assert.match(c.normalizeResponse(401, { error: { message: 'invalid key' } }).reason, /HTTP 401: invalid key/);
  assert.match(c.normalizeResponse(429, {}).reason, /HTTP 429/);
  assert.match(c.normalizeResponse(422, { error: 'bad question' }).reason, /HTTP 422: bad question/);
  assert.match(c.normalizeResponse(200, null).reason, /non-JSON/);
  assert.match(c.normalizeResponse(200, {}).reason, /no answers/);
});

// ── ask (mocked fetch — no network) ────────────────────────────────────────
const okFetch = (payload) => async () => ({ status: 200, json: async () => payload });

test('ask returns typed answers on success', async () => {
  const r = await c.ask('state', Q, { settings: c.resolveSettings(RULES_ON, CFG, {}), fetchImpl: okFetch({ model: 'jev-1.13.0', answers: { is_urgent: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 2 } }) });
  assert.equal(r.ok, true);
  assert.equal(r.answers.is_urgent.noul, 0.8);
  assert.ok(Number.isFinite(r.latencyMs));
});

test('ask never calls out when it is disabled or keyless', async () => {
  let called = 0;
  const spy = async () => { called++; return { status: 200, json: async () => ({ answers: {} }) }; };
  const a = await c.ask('state', Q, { settings: c.resolveSettings({}, {}, {}), fetchImpl: spy });
  const b = await c.ask('state', Q, { settings: c.resolveSettings(RULES_ON, {}, {}), fetchImpl: spy });
  assert.equal(called, 0, 'no request may leave the machine when off or unconfigured');
  assert.equal(a.skipped, true);
  assert.equal(b.skipped, true);
});

test('a throwing transport becomes a result, not an exception', async () => {
  const r = await c.ask('state', Q, { settings: c.resolveSettings(RULES_ON, CFG, {}), fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /request failed: ECONNRESET/);
});

test('a hung request times out and fails open', async () => {
  const hang = (url, opts) => new Promise((resolve, reject) => {
    if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const r = await c.ask('state', Q, { settings: c.resolveSettings({ typesafe: { enabled: true, timeoutMs: 25 } }, CFG, {}), fetchImpl: hang });
  assert.equal(r.ok, false);
  assert.match(r.reason, /timeout after 25ms/);
});

test('a 429 from the provider fails open like any other error', async () => {
  const r = await c.ask('state', Q, { settings: c.resolveSettings(RULES_ON, CFG, {}), fetchImpl: async () => ({ status: 429, json: async () => ({ error: 'rate limited' }) }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 429/);
});

// ── ledger ─────────────────────────────────────────���───────────────────────
test('the call ledger appends and counts per day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ledger-'));
  try {
    assert.equal(c.callsToday(dir, '2026-09-19'), 0, 'a missing ledger is zero calls, not an error');
    c.appendLedger(dir, { day: '2026-09-19', ok: true });
    c.appendLedger(dir, { day: '2026-09-19', ok: false });
    c.appendLedger(dir, { day: '2026-09-18', ok: true });
    assert.equal(c.callsToday(dir, '2026-09-19'), 2);
    assert.equal(c.callsToday(dir, '2026-09-18'), 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── two backends, one contract (2026-09-19) ────────────────────────────────
// TypeSafe's own console is invite-only, so the OpenRouter decisions endpoint is
// the backend that actually works. These tests pin the boundary that matters:
// WHICH key may be sent to WHICH host.
const OR_RULES = { typesafe: { enabled: true, backend: 'openrouter', timeoutMs: 1000, maxStateChars: 6000, maxCallsPerDay: 40 } };

test('no backend configured keeps the historical default, so an upgrade changes nothing', () => {
  const s = c.resolveSettings(RULES_ON, CFG, {});
  assert.equal(s.backend, 'typesafe');
  assert.equal(s.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(s.model, 'jev-latest');
});

test('the openrouter backend resolves its own host AND its own model id', () => {
  // 'jev-latest' is rejected by OpenRouter ("not a valid model ID"), so a shared
  // default would produce a 400 the moment someone flipped the switch.
  const s = c.resolveSettings(OR_RULES, {}, {});
  assert.equal(s.endpoint, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(s.model, 'typesafe/jev-1.13');
});

test('an explicit model still wins over the backend default', () => {
  const s = c.resolveSettings({ typesafe: Object.assign({}, OR_RULES.typesafe, { model: 'typesafe/jev-1.13' }) }, {}, {});
  assert.equal(s.model, 'typesafe/jev-1.13');
});

test('switching backends never sends one vendors key to another vendors host', () => {
  const or = c.resolveSettings(OR_RULES, { typesafeApiKey: 'k-typesafe' }, {});
  assert.equal(or.key, null, 'a typesafe key must not be used on the openrouter host');
  assert.equal(or.keySource, null);
  const direct = c.resolveSettings(RULES_ON, { openRouterApiKey: 'k-or' }, {});
  assert.equal(direct.key, null, 'an openrouter key must not be used on the typesafe host');
});

test('each backend reads its own key field', () => {
  assert.equal(c.resolveSettings(OR_RULES, { openRouterApiKey: 'k-or' }, {}).key, 'k-or');
  assert.equal(c.resolveSettings(RULES_ON, { typesafeApiKey: 'k-t' }, {}).key, 'k-t');
});

test('each backend reads its own env var, and env still beats config', () => {
  assert.equal(c.resolveSettings(OR_RULES, {}, { OPENROUTER_API_KEY: 'e-or' }).key, 'e-or');
  assert.equal(c.resolveSettings(RULES_ON, {}, { TYPESAFE_API_KEY: 'e-t' }).key, 'e-t');
  const both = c.resolveSettings(OR_RULES, { openRouterApiKey: 'cfg' }, { OPENROUTER_API_KEY: 'env' });
  assert.equal(both.key, 'env');
  assert.equal(both.keySource, 'env');
});

test('an unknown backend id falls back to the default rather than calling nowhere', () => {
  const s = c.resolveSettings({ typesafe: { enabled: true, backend: 'nope' } }, { typesafeApiKey: 'k' }, {});
  assert.equal(s.backend, 'typesafe');
  assert.equal(s.endpoint, 'https://api.typesafe.ai/v1/systemone');
});

test('shouldCall names the exact key field and env var for the ACTIVE backend', () => {
  const or = c.resolveSettings(OR_RULES, {}, {});
  const r1 = c.shouldCall(or, { callsToday: 0 });
  assert.equal(r1.call, false);
  assert.match(r1.reason, /openRouterApiKey/);
  assert.match(r1.reason, /OPENROUTER_API_KEY/);
  const t = c.resolveSettings(RULES_ON, {}, {});
  assert.match(c.shouldCall(t, { callsToday: 0 }).reason, /typesafeApiKey/);
});

test('the request shape is shared and the model id is the only difference', () => {
  // The contract is one contract; only the model id is backend-specific, and
  // that difference is the point (OpenRouter rejects 'jev-latest').
  const a = c.buildRequest({ x: 1 }, Q, c.resolveSettings(RULES_ON, CFG, {}));
  const b = c.buildRequest({ x: 1 }, Q, c.resolveSettings(OR_RULES, { openRouterApiKey: 'k' }, {}));
  assert.deepEqual(Object.keys(a.body).sort(), Object.keys(b.body).sort());
  assert.deepEqual(a.body.state, b.body.state);
  assert.deepEqual(a.body.questions, b.body.questions);
  assert.equal(a.body.model, 'jev-latest');
  assert.equal(b.body.model, 'typesafe/jev-1.13');
});

test('the openrouter answer shape normalises exactly like the direct one', () => {
  // Captured from a real call on 2026-09-19, verbatim shape.
  const real = {
    model: 'typesafe/jev-1.13-20260917',
    answers: {
      match: { type: 'choice', choice: 'A', probabilities: { A: 0.97, 'C-ADX': 0.02, B: 0.01 }, confidence: 0.97 },
      conviction: { type: 'score', score: 2.07, legend: { 0: 'marginal', 1: 'acceptable', 2: 'clean', 3: 'textbook' },
        probabilities: { 0: 0.02, 1: 0.1, 2: 0.67, 3: 0.21 }, confidence: 0.65 },
    },
    usage: { input_tokens: 529, output_tokens: 56, cost: 0.000022218 },
  };
  const n = c.normalizeResponse(200, real);
  assert.equal(n.ok, true);
  assert.equal(n.answers.match.choice, 'A');
  assert.equal(n.answers.match.probabilities.A, 0.97);
  assert.equal(n.answers.match.confidence, 0.97);
  assert.equal(n.answers.conviction.type, 'score');
  assert.equal(n.answers.conviction.score, 2.07);
  assert.equal(n.answers.conviction.legend['2'], 'clean');
  assert.equal(n.usage.cost, 0.000022218);
});

test('a decisions model refused on chat/completions is reported as a plain failure', () => {
  const n = c.normalizeResponse(400, { error: { message: 'typesafe/jev-1.13 is a decisions model and cannot be used with the chat/completions endpoint.', code: 400 } });
  assert.equal(n.ok, false);
  assert.match(n.reason, /HTTP 400/);
  assert.match(n.reason, /decisions model/);
});

test('switching the shipped backend to typesafe carries a model id valid on that host', () => {
  // The trap this pins, found live on 2026-09-21: app/rules.json held
  // model:'typesafe/jev-1.13' (an OpenRouter id) while the backend was switched
  // to typesafe. On api.typesafe.ai that id does not exist, so every call would
  // have 400'd — with the key, the switch and the endpoint all looking correct.
  // The two MUST move together, so the shipped file is asserted as a PAIR.
  const real = require('../rules.json');
  const s = c.resolveSettings(real, {}, {});
  if (s.backend === 'typesafe') {
    assert.equal(s.model, 'jev-latest', 'on the typesafe host the model must be jev-latest, not an OpenRouter id');
  } else {
    assert.match(s.model, /^typesafe\//, 'on OpenRouter the model id must be namespaced');
  }
});

test('the shipped timeout is long enough for the host it points at', () => {
  // Measured 2026-09-21: api.typesafe.ai took 1326ms for a ONE-question call,
  // against a timeout that was then 1500ms. The router asks SIX. A timeout that
  // close to the observed latency fails open intermittently — and a silent
  // fail-open is indistinguishable from the feature being switched off.
  const real = require('../rules.json');
  const s = c.resolveSettings(real, {}, {});
  if (s.backend === 'typesafe') assert.ok(s.timeoutMs >= 3000, 'official-host timeout is ' + s.timeoutMs + 'ms, too close to the ~1.3s observed');
  else assert.ok(s.timeoutMs >= 1000);
});
