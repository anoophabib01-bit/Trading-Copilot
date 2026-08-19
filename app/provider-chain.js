'use strict';
/**
 * provider-chain.js — which AI provider serves a request, and what happens
 * when it fails (task #34, 2026-08-12)
 *
 * WHY THIS IS ITS OWN FILE
 * These two functions decide, for all nine of the app's AI call sites, which
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
 */

// The chain that has been carrying this app since before OmniRoute or Anthropic
// existed. Ordered cheapest-and-most-available last.
// FROZEN (2026-08-12, audit M6/M7): this was a mutable array of mutable
// objects, handed straight to callers. Any consumer could .push() onto it or
// rewrite an entry's provider, corrupting the fail-open chain for every future
// call in the process — silently, and only noticeable once a provider died.
// Object.freeze on the array AND each entry; fallbackChainFor() returns deep
// copies so callers can mutate their own result harmlessly.
const STANDARD_FALLBACK_CHAIN = Object.freeze([
  Object.freeze({ provider: 'gemini', model: 'gemini-3.1-flash-lite' }),
  Object.freeze({ provider: 'gemini', model: 'gemini-2.5-flash' }),
  Object.freeze({ provider: 'groq',   model: 'openai/gpt-oss-20b' })
]);

// Known providers. Previously any unrecognised or empty-string provider fell
// through to 'gemini' silently (audit H3/H4), which masked caller bugs — a typo
// like 'anthropc' would route to Gemini and look like it worked.
const KNOWN_PROVIDERS = Object.freeze(['anthropic', 'gemini', 'groq', 'ollama', 'omniroute']);

const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

/**
 * Choose the primary provider/model.
 *
 * Anthropic first when a key exists — first-party, reliable tool-calling, which
 * is the property the free models catastrophically lacked on 2026-08-10 (they
 * emitted raw tool JSON as chat text instead of calling anything).
 *
 * @param {object} cfg          ~/.mnq-copilot-config.json contents
 * @param {boolean} omniReady   whether OmniRoute's health probe is passing
 */
function primaryProviderModel(cfg, omniReady = false) {
  // AUDIT C2: `cfg = {}` only defends against undefined. An explicit null threw
  // TypeError here — and this function is on the path of every AI call in the
  // app, so that is a hard failure of the whole co-pilot, not a degraded read.
  if (!cfg || typeof cfg !== 'object') cfg = {};
  if (cfg.apiKey && !cfg.disableAnthropic) {
    return { provider: 'anthropic', model: cfg.agentModel || DEFAULT_ANTHROPIC_MODEL };
  }
  if (!cfg.disableOmniRoute && omniReady) {
    return { provider: 'omniroute', model: cfg.omniRouteModel || 'free-quality-first' };
  }
  return { provider: 'gemini', model: DEFAULT_GEMINI_MODEL };
}

/**
 * Build the ordered fallback chain for a given primary.
 *
 * THE BUG THIS ENCODES A FIX FOR (found 2026-08-11 while wiring Anthropic in):
 * without the gemini-3.5-flash splice, an Anthropic failure fell straight into
 * STANDARD_FALLBACK_CHAIN, whose first two entries are gemini-3.1-flash-lite
 * and gemini-2.5-flash — and groq-agent.js's own notes record that Google
 * closed the 2.5 line to new accounts (a live 404). The chain would therefore
 * have burned two steps on possibly-dead model IDs at exactly the moment the
 * primary had already failed. gemini-3.5-flash is the model that has actually
 * been serving this app, so it belongs at the front of any fail-open path.
 *
 * The primary is never repeated inside its own chain — retrying a provider that
 * just failed wastes the one thing in short supply mid-session, which is time.
 */
function fallbackChainFor(primary) {
  // AUDIT H3/H4: an unknown or empty provider used to become 'gemini' silently.
  // It still degrades to a usable chain (never leave a caller with nothing) but
  // the chain is no longer *tailored* to a provider we do not recognise.
  const raw = primary && typeof primary === 'object' ? primary.provider : null;
  const p = KNOWN_PROVIDERS.includes(raw) ? raw : null;
  const needsGeminiFront = (p === 'omniroute' || p === 'anthropic');
  const base = needsGeminiFront
    ? [{ provider: 'gemini', model: DEFAULT_GEMINI_MODEL }, ...STANDARD_FALLBACK_CHAIN]
    : STANDARD_FALLBACK_CHAIN;
  // Deep copy: frozen source, mutable result, no shared references (M7).
  const chain = base.map(c => ({ provider: c.provider, model: c.model }));
  // AUDIT M9: only exclude the primary when we have BOTH a known provider and a
  // real model string. Previously a falsy primary.model could match a chain
  // entry and drop a perfectly good fallback.
  const m = primary && typeof primary === 'object' ? primary.model : null;
  if (!p || typeof m !== 'string' || !m) return chain;
  return chain.filter(c => !(c.provider === p && c.model === m));
}

module.exports = {
  STANDARD_FALLBACK_CHAIN,
  KNOWN_PROVIDERS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GEMINI_MODEL,
  primaryProviderModel,
  fallbackChainFor
};
