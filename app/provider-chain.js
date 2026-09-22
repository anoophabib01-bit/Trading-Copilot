'use strict';
/**
 * provider-chain.js — which AI provider serves a request, and what happens
 * when it fails (task #34, 2026-08-12; consolidated to DeepSeek 2026-09-02)
 *
 * WHY THIS IS ITS OWN FILE
 * These two functions decide, for every one of the app's AI call sites, which
 * provider is tried first and in what order the survivors are tried after a
 * failure. They are the difference between "a provider died and the co-pilot
 * quietly kept working" and "the co-pilot went silent mid-session".
 *
 * They lived in server.js, which is an entry point with no exports and
 * therefore could not be tested at all. Pulling out these ~15 lines is not the
 * big server.js refactor (deliberately declined — see the 2026-08-12
 * discussion): it is the smallest extraction that makes the fail-open path
 * verifiable.
 *
 * Both are pure functions of their arguments — config is passed IN rather than
 * read from disk — so the tests never touch the real config file.
 *
 * ── 2026-09-02: FIVE PROVIDERS BECAME ONE (Landing 2) ──────────────────────
 * This file used to route between Anthropic, Gemini (three model IDs), Groq,
 * OmniRoute and local Ollama, with precedence rules that were genuinely hard
 * to predict from the outside. Anoop's reason for collapsing it, in his own
 * words: "it is creating a lot of confusion and i want to avoid confusion."
 *
 * Removed here: Anthropic, Groq, OmniRoute, Ollama, and the two vestigial
 * Gemini model IDs (gemini-3.1-flash-lite and gemini-2.5-flash — the latter
 * had been a known live 404 since Google closed the 2.5 line to new accounts,
 * so the old chain burned a step on a dead ID at exactly the moment the
 * primary had already failed).
 *
 * KEPT DELIBERATELY: one Gemini break-glass step. That was Anoop's own call
 * ("is it better if we keep gemini in case the credits in deepseek are over?")
 * and it earned its place the same day — when DeepSeek returned an empty reply
 * mid-Debate, Gemini answering meant a degraded verdict instead of no verdict.
 * It is a different VENDOR, which is the point: a within-DeepSeek ladder alone
 * cannot survive "account out of credit" or "DeepSeek is down".
 *
 * The cost of keeping it is that a different brain can answer as Jessi without
 * anyone noticing — which is exactly what happened on 2026-09-02. That is why
 * falling to Gemini is now ALARMED in the UI (modelBadgeHtml in
 * renderer/app.js), not merely logged.
 */

// Known providers. An unrecognised or empty-string provider used to fall
// through to 'gemini' silently (audit H3/H4), which masked caller bugs — a
// typo like 'deepseak' would route to Gemini and look like it worked.
//
// MUST STAY IN SYNC with groq-agent.js's VALID_PROVIDERS. A provider present
// in one and absent from the other fails SILENTLY: groq-agent's pushCandidate()
// skips an unknown provider rather than throwing, so a configured, paid key can
// serve zero requests while the app looks perfectly healthy. That exact drift
// happened on 2026-09-02 and shipped green tests. provider-chain.test.js now
// cross-checks the two real arrays against each other.
const KNOWN_PROVIDERS = Object.freeze(['deepseek', 'gemini']);

// ── DeepSeek — the primary brain ────────────────────────────────────────────
// Anoop's pick, asked and confirmed: the vision-exp variant serves EVERY call
// site, not just image turns. DeepSeek's own pricing table lists it as
// identical to plain v4-flash on tool calling, JSON output, context length and
// price — its only documented limitation is FIM completion, which this app
// never calls. So "one model everywhere" costs nothing, and one model
// everywhere is the entire point of the consolidation.
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash-vision-exp';

// The stable, non-experimental sibling, and the FIRST step of the ladder.
// It exists because this app has been broken mid-session twice by a model ID
// being retired without notice (Groq deprecated the Llama IDs on 2026-06-17;
// Google closed the Gemini 2.5 line, a live 404). An ID carrying an "exp" tag
// is precisely the kind that vanishes that way, and when it does, the failure
// arrives during a live trading session. Staying inside DeepSeek for step 1
// means a retirement is survivable without changing vendor mid-verdict.
const DEEPSEEK_STABLE_MODEL = 'deepseek-v4-flash';

// ── Gemini — break glass only ───────────────────────────────────────────────
// Not a peer of DeepSeek. This is the "DeepSeek is down or out of credit"
// step, and reaching it is an event worth interrupting Anoop about.
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

// The fail-open chain, in order, for a DeepSeek primary. Frozen (audit M6/M7):
// this was once a mutable array of mutable objects handed straight to callers,
// so any consumer could .push() onto it or rewrite an entry, corrupting the
// chain for every future call in the process — silently, and only noticeable
// once a provider actually died. fallbackChainFor() returns deep copies.
const STANDARD_FALLBACK_CHAIN = Object.freeze([
  Object.freeze({ provider: 'deepseek', model: DEEPSEEK_STABLE_MODEL }),
  Object.freeze({ provider: 'gemini', model: DEFAULT_GEMINI_MODEL })
]);

/**
 * Choose the primary provider/model.
 *
 * @param {object} cfg   ~/.trading-copilot-config.json contents
 */
function primaryProviderModel(cfg) {
  // AUDIT C2: `cfg = {}` only defends against undefined. An explicit null threw
  // TypeError here — and this function is on the path of every AI call in the
  // app, so that is a hard failure of the whole co-pilot, not a degraded read.
  if (!cfg || typeof cfg !== 'object') cfg = {};
  // disableDeepSeek is a kill switch, not a config toggle: it lets Anoop drop
  // to the backup brain mid-session without deleting a key he has paid for.
  if (cfg.deepseekApiKey && !cfg.disableDeepSeek) {
    return { provider: 'deepseek', model: cfg.deepSeekModel || DEFAULT_DEEPSEEK_MODEL };
  }
  // No DeepSeek key (or killed): Gemini carries the app. Never return nothing —
  // a co-pilot that refuses to answer mid-session is worse than a degraded one.
  return { provider: 'gemini', model: DEFAULT_GEMINI_MODEL };
}

/**
 * Build the ordered fallback chain for a given primary.
 *
 * The primary is never repeated inside its own chain — retrying a provider
 * that just failed wastes the one thing in short supply mid-session, which is
 * time.
 */
function fallbackChainFor(primary) {
  const raw = primary && typeof primary === 'object' ? primary.provider : null;
  const p = KNOWN_PROVIDERS.includes(raw) ? raw : null;
  // Deep copy: frozen source, mutable result, no shared references (M7).
  const chain = STANDARD_FALLBACK_CHAIN.map(c => ({ provider: c.provider, model: c.model }));
  // AUDIT M9: only exclude the primary when we have BOTH a known provider and
  // a real model string. Previously a falsy primary.model could match a chain
  // entry and drop a perfectly good fallback.
  const m = primary && typeof primary === 'object' ? primary.model : null;
  if (!p || typeof m !== 'string' || !m) return chain;
  return chain.filter(c => !(c.provider === p && c.model === m));
}

module.exports = {
  STANDARD_FALLBACK_CHAIN,
  KNOWN_PROVIDERS,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_STABLE_MODEL,
  primaryProviderModel,
  fallbackChainFor
};
