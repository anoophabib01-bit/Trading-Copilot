'use strict';
/**
 * Tests for provider-chain.js — provider selection and the fail-open chain.
 *
 * This is the code that keeps the co-pilot answering when a provider dies
 * mid-session. It had zero coverage originally because it lived in server.js,
 * which exports nothing.
 *
 * 2026-09-02 (Landing 2): rewritten for the two-provider world. The Anthropic,
 * Groq, OmniRoute and Ollama cases are gone because those providers are gone —
 * not because they stopped mattering. What replaces them is a smaller set of
 * properties that matter MORE now that there is almost nowhere left to fall:
 * DeepSeek must win, the ladder must stay inside DeepSeek for one step, and
 * the Gemini break-glass must never be silently dropped.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  STANDARD_FALLBACK_CHAIN, KNOWN_PROVIDERS,
  DEFAULT_GEMINI_MODEL, DEFAULT_DEEPSEEK_MODEL, DEEPSEEK_STABLE_MODEL,
  primaryProviderModel, fallbackChainFor
} = require('../provider-chain');

const names = ch => ch.map(c => c.provider + '/' + c.model);

// ── primaryProviderModel ─────────────────────────────────────────────────────
test('a DeepSeek key makes DeepSeek primary, on the vision-exp model', () => {
  assert.deepStrictEqual(primaryProviderModel({ deepseekApiKey: 'sk-ds-x' }),
    { provider: 'deepseek', model: DEFAULT_DEEPSEEK_MODEL });
});

test('deepSeekModel overrides the default without a code change', () => {
  assert.strictEqual(primaryProviderModel({ deepseekApiKey: 'd', deepSeekModel: 'deepseek-v4-pro' }).model, 'deepseek-v4-pro');
});

test('THE KILL SWITCH: disableDeepSeek drops to the backup without deleting the paid key', () => {
  // Anoop needs a way out mid-session that does not involve retyping a key he
  // has paid for, on a machine he is actively trading from.
  const p = primaryProviderModel({ deepseekApiKey: 'd', geminiApiKey: 'g', disableDeepSeek: true });
  assert.deepStrictEqual(p, { provider: 'gemini', model: DEFAULT_GEMINI_MODEL });
});

test('no DeepSeek key falls back to Gemini, never to nothing', () => {
  // A co-pilot that refuses to answer mid-session is worse than a degraded one.
  assert.deepStrictEqual(primaryProviderModel({}), { provider: 'gemini', model: DEFAULT_GEMINI_MODEL });
  assert.strictEqual(primaryProviderModel({ deepseekApiKey: '' }).provider, 'gemini');
});

test('AUDIT C2: null config does not throw — it degrades to Gemini', () => {
  // This function is on the path of EVERY AI call, so a throw here is a hard
  // failure of the whole co-pilot, not a degraded read.
  assert.strictEqual(primaryProviderModel(null).provider, 'gemini');
  assert.strictEqual(primaryProviderModel(undefined).provider, 'gemini');
  assert.strictEqual(primaryProviderModel('nonsense').provider, 'gemini');
});

// ── fallbackChainFor ─────────────────────────────────────────────────────────
test('THE "exp" INSURANCE: a DeepSeek primary degrades to its stable sibling FIRST', () => {
  // vision-exp can be retired without notice — this app has been broken that
  // way twice already. Step 1 must stay inside DeepSeek so a retirement is
  // survivable without swapping vendor mid-verdict.
  const ch = fallbackChainFor({ provider: 'deepseek', model: DEFAULT_DEEPSEEK_MODEL });
  assert.deepStrictEqual(ch[0], { provider: 'deepseek', model: DEEPSEEK_STABLE_MODEL });
});

test('the Gemini break-glass is the LAST step and is never dropped', () => {
  // Anoop asked for this explicitly ("in case the credits in deepseek are
  // over"). It is the only step that survives a whole-vendor outage, and it
  // earned its place the day it was added.
  const ch = fallbackChainFor({ provider: 'deepseek', model: DEFAULT_DEEPSEEK_MODEL });
  assert.deepStrictEqual(ch[ch.length - 1], { provider: 'gemini', model: DEFAULT_GEMINI_MODEL });
});

test('the primary is never repeated inside its own chain', () => {
  const ch = fallbackChainFor({ provider: 'deepseek', model: DEEPSEEK_STABLE_MODEL });
  assert.ok(!names(ch).includes('deepseek/' + DEEPSEEK_STABLE_MODEL),
    'retrying the model that just failed wastes the one thing in short supply mid-session');
  assert.ok(ch.length > 0, 'excluding the primary must never empty the chain');
});

test('every chain is non-empty — a failure must always have somewhere to go', () => {
  for (const p of [
    { provider: 'deepseek', model: DEFAULT_DEEPSEEK_MODEL },
    { provider: 'deepseek', model: DEEPSEEK_STABLE_MODEL },
    { provider: 'gemini', model: DEFAULT_GEMINI_MODEL }
  ]) {
    assert.ok(fallbackChainFor(p).length > 0, p.provider + '/' + p.model + ' left with no fallback');
  }
});

test('a malformed/missing primary still yields a usable chain', () => {
  assert.ok(fallbackChainFor(undefined).length > 0);
  assert.ok(fallbackChainFor({}).length > 0);
  assert.ok(fallbackChainFor({ provider: 'deepseak' }).length > 0, 'a typo must still leave a working chain');
});

test('AUDIT H3/H4: an unknown provider is not treated as a known one', () => {
  // It still degrades to a usable chain, but nothing is EXCLUDED on its behalf.
  const ch = fallbackChainFor({ provider: 'not-a-provider', model: DEEPSEEK_STABLE_MODEL });
  assert.ok(names(ch).includes('deepseek/' + DEEPSEEK_STABLE_MODEL),
    'an unrecognised provider must not silently drop a real fallback entry');
});

test('AUDIT M9: a falsy model never drops a legitimate fallback entry', () => {
  assert.strictEqual(fallbackChainFor({ provider: 'deepseek', model: null }).length, STANDARD_FALLBACK_CHAIN.length);
  assert.strictEqual(fallbackChainFor({ provider: 'deepseek', model: '' }).length, STANDARD_FALLBACK_CHAIN.length);
});

test('AUDIT M6: the exported constants are frozen — push() cannot corrupt them', () => {
  assert.throws(() => STANDARD_FALLBACK_CHAIN.push({ provider: 'x', model: 'y' }), TypeError);
  assert.throws(() => KNOWN_PROVIDERS.push('x'), TypeError);
});

test('AUDIT M7: returned entries are copies — mutating one cannot poison the source', () => {
  const ch = fallbackChainFor({ provider: 'deepseek', model: DEFAULT_DEEPSEEK_MODEL });
  ch[0].provider = 'hijacked';
  ch.push({ provider: 'bogus', model: 'bogus' });
  const fresh = fallbackChainFor({ provider: 'deepseek', model: DEFAULT_DEEPSEEK_MODEL });
  assert.strictEqual(fresh[0].provider, 'deepseek');
  assert.ok(!names(fresh).includes('bogus/bogus'));
});

// ── cross-module: the two provider registries must agree ─────────────────────
test('KNOWN_PROVIDERS matches groq-agent VALID_PROVIDERS exactly', () => {
  // 2026-09-02: this used to compare against a HAND-COPIED list, which cannot
  // detect drift — only restate it. It duly passed while DeepSeek was present
  // in provider-chain.js and absent from groq-agent.js, a combination that is
  // silent by construction: the chain builder SKIPS an unrecognised provider
  // instead of throwing, so a configured paid key would have served zero
  // requests while the app looked perfectly healthy. Reads the real arrays now.
  const { VALID_PROVIDERS, DEFAULT_MODEL_BY_PROVIDER } = require('../groq-agent')._debug;
  assert.deepStrictEqual([...KNOWN_PROVIDERS].sort(), [...VALID_PROVIDERS].sort(),
    'a provider present in one registry and not the other fails SILENTLY');
  for (const p of VALID_PROVIDERS) {
    assert.ok(DEFAULT_MODEL_BY_PROVIDER[p],
      p + ' has no default model — a chain entry without an explicit model would send no model at all');
  }
});

test('REGRESSION: every entry of a real DeepSeek chain survives the groq-agent candidate filter', () => {
  const { VALID_PROVIDERS } = require('../groq-agent')._debug;
  const primary = primaryProviderModel({ deepseekApiKey: 'sk-ds-x' });
  assert.strictEqual(primary.provider, 'deepseek');
  for (const c of [primary, ...fallbackChainFor(primary)]) {
    assert.ok(VALID_PROVIDERS.includes(c.provider), c.provider + ' would be silently skipped by groq-agent');
  }
});
