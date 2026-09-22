'use strict';
/* ── typesafe-client.js — the TypeSafe (Jev) transport (2026-09-19) ──────────
 * Anoop: "i want to use this inside the project... build everything you
 * suggested."
 *
 * WHAT JEV IS, IN ONE LINE: a hosted System One model that evaluates a STATE
 * (string, or a structured object) against TYPED QUESTIONS and returns typed
 * answers with probabilities. It does not generate prose, it does not see
 * images, and it does not call tools. So it is NOT an agent and NOT a provider
 * for groq-agent.js — it is a classification/decision client, deliberately
 * wired OUTSIDE provider-chain.js so the app's one-provider rule (and the
 * fallback alarm that goes with it) is untouched.
 *
 * THE CONTRACT (verified against docs.typesafe.ai/api, 2026-09-19):
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <key>
 *   { state, model: "jev-latest",
 *     questions: { id: { type: "noul" | "choice" | "score", instructions, criteria } } }
 *   -> { model, answers: { id: {type, ...} }, usage: {input_tokens, output_tokens} }
 *   Errors are plain HTTP codes with a JSON body: 401 / 422 / 429.
 *
 * THE THREE RULES THIS MODULE ENFORCES, and why each is load-bearing:
 *
 *   1. FAIL-OPEN, ALWAYS. Every entry point returns a result object; nothing
 *      throws into the caller. This runs off the back of saving a journal note
 *      in a live-money app — an advisory classifier that can break the thing it
 *      annotates is worse than no classifier. No key, disabled, timeout, 429,
 *      malformed JSON: all of them are "no answer", not an exception.
 *
 *   2. IT NEVER DECIDES ANYTHING. There is no code path here that returns a
 *      size, a stop, a go/no-go, or a probability handed to the UI as a fact.
 *      Answers are recorded with their confidence so they can be MEASURED
 *      later; nothing consumes them yet.
 *
 *   3. CONFIDENCE IS NOT CALIBRATION. TypeSafe derives confidence from how
 *      peaked the answer distribution is. A confidently wrong answer is
 *      entirely possible, so a confidence from here must never be quoted to
 *      him as a percentage chance of anything, and must never reach a risk
 *      number. It is a column in a ledger, not a fact about the market.
 *
 * PURE HALF / THIN HALF, like account-snapshot.js: every decision
 * (resolveSettings / shouldCall / buildRequest / normalizeResponse) is pure and
 * unit-tested; only ask() and appendLedger() touch the network and the disk.
 */
const fs = require('fs');
const path = require('path');

// ── TWO BACKENDS, ONE CONTRACT (verified live 2026-09-19) ──────────────────
// TypeSafe's own console is INVITE-ONLY (console.typesafe.ai/login returns
// 'ohnoes' — Anoop hit exactly this on 2026-09-19), so the direct endpoint was
// unreachable in practice for the person this app is for. The model IS reachable
// through OpenRouter's decisions endpoint using the OpenRouter key this machine
// already holds, and it answers in the SAME shape — verified with real calls:
//
//   POST https://openrouter.ai/api/alpha/decisions
//   { model: "typesafe/jev-1.13", state, questions }
//   -> { model: "typesafe/jev-1.13-20260917",
//        answers: { match:   { type:"choice", choice:"A",
//                              probabilities:{A:.97,"C-ADX":.02,B:.01}, confidence:.97 },
//                   conviction:{ type:"score", score:2.07, legend:{...},
//                              probabilities:{...}, confidence:.65 } },
//        usage: { input_tokens, output_tokens, cost } }
//
// Identical fields to the direct API (`noul`, `choice`, `score`, legend,
// probabilities, confidence), so EVERYTHING above the transport — the journal
// classifier, the router, the ledger, the tests — is backend-agnostic. The
// OpenRouter body even reports `cost`, which the direct API did not.
//
// A chat/completions call to these ids is REFUSED by design: "it is a decisions
// model and cannot be used with the chat/completions endpoint". That refusal is
// also the guarantee — Jev physically cannot be used as a prose agent here, so
// rule 2 below (it never decides anything) is enforced by the vendor's API too.
const BACKENDS = Object.freeze({
  typesafe: {
    id: 'typesafe',
    label: 'TypeSafe direct',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    defaultModel: 'jev-latest',
    keyField: 'typesafeApiKey',
    envName: 'TYPESAFE_API_KEY',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter (alpha/decisions)',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    defaultModel: 'typesafe/jev-1.13',
    keyField: 'openRouterApiKey',
    envName: 'OPENROUTER_API_KEY',
  },
});
const BACKEND_IDS = Object.freeze(Object.keys(BACKENDS));
// Kept as a named export: it is the DEFAULT backend's endpoint, and existing
// callers/tests read it as "the endpoint" when no backend is configured.
const ENDPOINT = BACKENDS.typesafe.endpoint;
const DEFAULT_BACKEND = 'typesafe';
const DEFAULTS = Object.freeze({
  model: 'jev-latest',
  timeoutMs: 1500,
  maxStateChars: 6000,
  maxCallsPerDay: 40,
});

/** Which backend, and its table row. Unknown ids fall back to the default. */
function backendFor(id) {
  return BACKENDS[String(id || '').toLowerCase()] || BACKENDS[DEFAULT_BACKEND];
}

/** Read env without assuming process.env exists (tests / browser builds). */
function envValue(name) {
  try { return process && process.env ? process.env[name] : undefined; } catch { return undefined; }
}

/**
 * Everything the client needs, resolved once. The key is looked for in the
 * app's own config file first (the same file that holds deepseekApiKey and
 * geminiApiKey — one place for keys, not two), with an env override for
 * running without touching the config.
 */
function resolveSettings(rules, appCfg, env) {
  const t = (rules && rules.typesafe) || {};
  const cfg = appCfg || {};
  const backend = backendFor(t.backend);
  // The key is looked for under the ACTIVE backend's own field, so switching
  // backends cannot silently send one vendor's key to another vendor's host.
  const envKey = (env && env[backend.envName]) || envValue(backend.envName);
  const cfgKey = cfg[backend.keyField] || null;
  const key = envKey || cfgKey || null;
  return {
    enabled: t.enabled === true,
    backend: backend.id,
    backendLabel: backend.label,
    endpoint: backend.endpoint,
    model: typeof t.model === 'string' && t.model.trim()
      ? t.model.trim()
      // Each backend has its own default id: 'jev-latest' is meaningful on
      // TypeSafe's API and is REJECTED by OpenRouter ("not a valid model ID"),
      // which is exactly the kind of mismatch one shared default would hide.
      // No explicit backend configured keeps the historical default, so an
      // existing config cannot change behaviour by being upgraded.
      : (t.backend ? backend.defaultModel : DEFAULTS.model),
    timeoutMs: Number.isFinite(Number(t.timeoutMs)) && Number(t.timeoutMs) > 0 ? Number(t.timeoutMs) : DEFAULTS.timeoutMs,
    maxStateChars: Number.isFinite(Number(t.maxStateChars)) && Number(t.maxStateChars) > 0 ? Number(t.maxStateChars) : DEFAULTS.maxStateChars,
    maxCallsPerDay: Number.isFinite(Number(t.maxCallsPerDay)) && Number(t.maxCallsPerDay) > 0 ? Number(t.maxCallsPerDay) : DEFAULTS.maxCallsPerDay,
    key: key ? String(key) : null,
    keySource: envKey ? 'env' : (cfgKey ? 'config' : null),
    // ── cookbook item 4: the fresh uid ──────────────────────────────────────
    // The consistency cookbook sends a throwaway unique value with every call so
    // repeated runs are independent samples rather than cache hits. MEASURED on
    // this app's OpenRouter route 2026-09-21: five identical bodies with NO uid
    // already produced 4 distinct answers of 5, so there is no cache to defeat
    // here and the uid changed nothing. It is carried anyway, DEFAULT ON, because
    // the direct api.typesafe.ai route's caching is unverified and the field
    // costs one short string. If the official API rejects an unknown top-level
    // field, set typesafe.sendUid false — that is the only reason this is a
    // switch rather than unconditional.
    sendUid: t.sendUid !== false,
  };
}

/** A throwaway unique id for one call. Not a request id — nothing reads it back. */
function freshUid() {
  return 'c' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * May this call happen at all? Returns { call, reason }. The reason is logged
 * verbatim, because "why did nothing happen" is the question a silent skip
 * makes unanswerable — the failure mode this repo has been bitten by before.
 */
function shouldCall(settings, opts) {
  const s = settings || {};
  const o = opts || {};
  if (!s.enabled) return { call: false, reason: 'typesafe disabled in rules.json' };
  if (!s.key) {
    // Name the exact field and env var for the ACTIVE backend. "no key" with no
    // path to fix it is how a feature stays switched off for a month.
    const b = BACKENDS[s.backend] || BACKENDS[DEFAULT_BACKEND];
    return { call: false, reason: 'no ' + b.keyField + ' in the app config (or ' + b.envName + ') for the ' + b.label + ' backend' };
  }
  const callsToday = Number.isFinite(Number(o.callsToday)) ? Number(o.callsToday) : 0;
  if (callsToday >= s.maxCallsPerDay) return { call: false, reason: 'daily call cap reached (' + callsToday + '/' + s.maxCallsPerDay + ')' };
  return { call: true, reason: null };
}

/** The request body, with the size guard applied to the serialized state. */
function buildRequest(state, questions, settings) {
  const s = settings || {};
  const ids = Object.keys(questions || {});
  if (!ids.length) return { error: 'no questions' };
  if (state == null || (typeof state === 'string' && !state.trim())) return { error: 'empty state' };
  let payloadState = state;
  let chars;
  try {
    chars = typeof state === 'string' ? state.length : JSON.stringify(state).length;
  } catch (e) { return { error: 'state not serializable' }; }
  if (chars > s.maxStateChars) {
    // Truncate a string state rather than refuse it — a clipped note still
    // classifies — but say so in the ledger so a bad answer is explainable.
    if (typeof state === 'string') { payloadState = state.slice(0, s.maxStateChars); chars = payloadState.length; }
    else return { error: 'state too large (' + chars + ' > ' + s.maxStateChars + ' chars)' };
  }
  const body = { state: payloadState, model: s.model, questions };
  if (s.sendUid !== false) body.uid = (typeof s.uid === 'string' && s.uid) ? s.uid : freshUid();
  return { body, stateChars: chars, questionIds: ids };
}

/** Defensive normaliser. Unknown shapes are dropped, never guessed at. */
function normalizeResponse(status, json) {
  const code = Number(status);
  if (code !== 200) {
    const msg = json && json.error ? (typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error))) : null;
    return { ok: false, status: code, reason: 'HTTP ' + code + (msg ? ': ' + String(msg).slice(0, 200) : '') };
  }
  if (!json || typeof json !== 'object') return { ok: false, status: code, reason: 'non-JSON response' };
  const raw = json.answers;
  if (!raw || typeof raw !== 'object') return { ok: false, status: code, reason: 'no answers in response' };
  const answers = {};
  Object.keys(raw).forEach(function (id) {
    const a = raw[id];
    if (!a || typeof a !== 'object') return;
    const type = String(a.type || '');
    if (type === 'noul') {
      const v = Number(a.noul);
      if (Number.isFinite(v)) answers[id] = { type: 'noul', noul: clamp01(v) };
    } else if (type === 'choice') {
      answers[id] = {
        type: 'choice',
        choice: a.choice != null ? String(a.choice) : null,
        probabilities: numberMap(a.probabilities),
        confidence: Number.isFinite(Number(a.confidence)) ? clamp01(Number(a.confidence)) : null,
      };
    } else if (type === 'score') {
      answers[id] = {
        type: 'score',
        score: Number.isFinite(Number(a.score)) ? Number(a.score) : null,
        legend: (a.legend && typeof a.legend === 'object') ? a.legend : null,
        probabilities: numberMap(a.probabilities),
        confidence: Number.isFinite(Number(a.confidence)) ? clamp01(Number(a.confidence)) : null,
      };
    }
  });
  return {
    ok: true,
    status: code,
    model: json.model ? String(json.model) : null,
    answers,
    usage: (json.usage && typeof json.usage === 'object') ? json.usage : null,
  };
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));
function numberMap(v) {
  if (!v || typeof v !== 'object') return null;
  const out = {};
  Object.keys(v).forEach(function (k) {
    const n = Number(v[k]);
    if (Number.isFinite(n)) out[k] = n;
  });
  return Object.keys(out).length ? out : null;
}

/**
 * Ask Jev. Never throws. Returns:
 *   { ok:true, answers, model, usage, latencyMs, stateChars }
 *   { ok:false, reason, skipped?:true }
 * fetchImpl is injectable so the tests exercise every path with no network.
 */
async function ask(state, questions, opts) {
  const o = opts || {};
  const settings = o.settings || resolveSettings(o.rules, o.appCfg, o.env);
  const verdict = shouldCall(settings, { callsToday: o.callsToday });
  if (!verdict.call) return { ok: false, skipped: true, reason: verdict.reason };

  const req = buildRequest(state, questions, settings);
  if (req.error) return { ok: false, skipped: true, reason: req.error };

  const doFetch = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, skipped: true, reason: 'no fetch available in this runtime' };

  const started = Date.now();
  const controller = (typeof AbortController === 'function') ? new AbortController() : null;
  const timer = controller ? setTimeout(function () { try { controller.abort(); } catch (e) {} }, settings.timeoutMs) : null;
  try {
    const res = await doFetch(settings.endpoint || ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.key },
      body: JSON.stringify(req.body),
      signal: controller ? controller.signal : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    const norm = normalizeResponse(res.status, json);
    return Object.assign(norm, {
      latencyMs: Date.now() - started,
      stateChars: req.stateChars,
      questionIds: req.questionIds,
      model: norm.model || settings.model,
    });
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return { ok: false, reason: aborted ? ('timeout after ' + settings.timeoutMs + 'ms') : ('request failed: ' + String((e && e.message) || e).slice(0, 200)), latencyMs: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Append one call to DATA/typesafe/calls.jsonl. Append-only and derived, like
 * the pattern ledger: a corrupt file is recoverable by deleting it, and nothing
 * reads it yet — it exists so that in a few weeks the question "was its
 * confidence real on MY data" has an answer instead of a memory.
 */
function appendLedger(dataDir, row) {
  try {
    const dir = path.join(dataDir, 'typesafe');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(row) + '\n');
    return true;
  } catch (e) { return false; }
}

/** Calls already logged for a trading day — the daily cap reads this. */
function callsToday(dataDir, day) {
  try {
    const file = path.join(dataDir, 'typesafe', 'calls.jsonl');
    if (!fs.existsSync(file)) return 0;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let n = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try { if (JSON.parse(line).day === day) n++; } catch (e) {}
    }
    return n;
  } catch (e) { return 0; }
}

module.exports = {
  ENDPOINT, DEFAULTS, BACKENDS, BACKEND_IDS, DEFAULT_BACKEND, backendFor,
  resolveSettings, shouldCall, buildRequest, normalizeResponse, freshUid,
  ask, appendLedger, callsToday,
};
