'use strict';
/**
 * Tests for provider-chain.js — provider selection and the fail-open chain.
 *
 * This is the code that keeps the co-pilot answering when a provider dies
 * mid-session. It had zero test coverage because it lived in server.js, which
 * exports nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  STANDARD_FALLBACK_CHAIN, DEFAULT_GEMINI_MODEL,
  primaryProviderModel, fallbackChainFor
} = require('../provider-chain');

const names = ch => ch.map(c => c.provider + '/' + c.model);

// ── primaryProviderModel ─────────────────────────────────────────────────────
test('an Anthropic key makes Anthropic primary, on Haiku 4.5', () => {
  const p = primaryProviderModel({ apiKey: 'sk-ant-x' });
  assert.deepStrictEqual(p, { provider: 'anthropic', model: 'claude-haiku-4-5' });
});

test('agentModel overrides the default without a code change', () => {
  assert.strictEqual(primaryProviderModel({ apiKey: 'k', agentModel: 'claude-sonnet-4-6' }).model, 'claude-sonnet-4-6');
});

test('no key at all falls back to Gemini, never to nothing', () => {
  assert.deepStrictEqual(primaryProviderModel({}), { provider: 'gemini', model: DEFAULT_GEMINI_MODEL });
});

test('disableAnthropic is honoured even when a key exists', () => {
  assert.strictEqual(primaryProviderModel({ apiKey: 'k', disableAnthropic: true }).provider, 'gemini');
});

test('OmniRoute is only chosen when its health probe passes', () => {
  assert.strictEqual(primaryProviderModel({}, false).provider, 'gemini');
  assert.strictEqual(primaryProviderModel({}, true).provider, 'omniroute');
});

test('Anthropic outranks a healthy OmniRoute', () => {
  assert.strictEqual(primaryProviderModel({ apiKey: 'k' }, true).provider, 'anthropic');
});

// ── fallbackChainFor ─────────────────────────────────────────────────────────
test('THE FIX: an Anthropic primary gets gemini-3.5-flash FIRST', () => {
  const ch = fallbackChainFor({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  assert.strictEqual(ch[0].model, DEFAULT_GEMINI_MODEL,
    'without this the chain wastes its first two steps on possibly-retired Gemini IDs');
});

test('an OmniRoute primary also gets gemini-3.5-flash first', () => {
  assert.strictEqual(fallbackChainFor({ provider: 'omniroute', model: 'free-quality-first' })[0].model, DEFAULT_GEMINI_MODEL);
});

test('a Gemini primary keeps the plain standard chain', () => {
  const ch = fallbackChainFor({ provider: 'gemini', model: 'gemini-3.5-flash' });
  assert.deepStrictEqual(names(ch), names(STANDARD_FALLBACK_CHAIN));
});

test('the chain NEVER retries the exact primary that just failed', () => {
  const ch = fallbackChainFor({ provider: 'gemini', model: 'gemini-3.1-flash-lite' });
  assert.ok(!names(ch).includes('gemini/gemini-3.1-flash-lite'), 'retrying the failed model wastes time mid-session');
});

test('every chain ends at Groq — the last resort must always exist', () => {
  for (const p of [
    { provider: 'anthropic', model: 'claude-haiku-4-5' },
    { provider: 'omniroute', model: 'free-quality-first' },
    { provider: 'gemini', model: 'gemini-3.5-flash' }
  ]) {
    const ch = fallbackChainFor(p);
    assert.strictEqual(ch[ch.length - 1].provider, 'groq', `${p.provider} chain must end at Groq`);
  }
});

test('every chain is non-empty — a failure must always have somewhere to go', () => {
  for (const p of [
    { provider: 'anthropic', model: 'claude-haiku-4-5' },
    { provider: 'omniroute', model: 'x' },
    { provider: 'gemini', model: 'gemini-3.5-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-20b' }
  ]) {
    assert.ok(fallbackChainFor(p).length > 0, `${p.provider} left with no fallback`);
  }
});

test('a malformed/missing primary still yields a usable chain', () => {
  assert.ok(fallbackChainFor(undefined).length > 0);
  assert.ok(fallbackChainFor({}).length > 0);
});

test('the returned chain is a copy — callers cannot corrupt the shared constant', () => {
  const ch = fallbackChainFor({ provider: 'gemini', model: 'gemini-3.5-flash' });
  ch.push({ provider: 'bogus', model: 'bogus' });
  assert.strictEqual(STANDARD_FALLBACK_CHAIN.length, 3, 'the module constant must not be mutated');
});

// ── the real end-to-end path ─────────────────────────────────────────────────
test('full path: Anthropic key present -> Anthropic primary, 4-deep fail-open', () => {
  const p = primaryProviderModel({ apiKey: 'sk-ant-x' }, false);
  const ch = fallbackChainFor(p);
  assert.deepStrictEqual(
    [p.provider + '/' + p.model, ...names(ch)],
    [
      'anthropic/claude-haiku-4-5',
      'gemini/gemini-3.5-flash',
      'gemini/gemini-3.1-flash-lite',
      'gemini/gemini-2.5-flash',
      'groq/openai/gpt-oss-20b'
    ]
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT HARDENING (2026-08-12). C2 was a confirmed TypeError on the path of
// EVERY AI call in the app. M6/M7 allowed a caller to silently corrupt the
// fail-open chain for the rest of the process.
// ═══════════════════════════════════════════════════════════════════════════
const { KNOWN_PROVIDERS } = require('../provider-chain');

test('AUDIT C2: null config does not throw — it degrades to Gemini', () => {
  assert.doesNotThrow(() => primaryProviderModel(null, false));
  assert.strictEqual(primaryProviderModel(null, false).provider, 'gemini');
  assert.strictEqual(primaryProviderModel(undefined).provider, 'gemini');
  assert.strictEqual(primaryProviderModel('nonsense').provider, 'gemini');
  assert.strictEqual(primaryProviderModel(42).provider, 'gemini');
});

test('AUDIT M6: the exported chain is frozen — push() cannot corrupt it', () => {
  assert.throws(() => STANDARD_FALLBACK_CHAIN.push({ provider: 'evil', model: 'x' }), TypeError);
  assert.throws(() => { STANDARD_FALLBACK_CHAIN[0].provider = 'evil'; }, TypeError);
  assert.strictEqual(STANDARD_FALLBACK_CHAIN.length, 3);
  assert.strictEqual(STANDARD_FALLBACK_CHAIN[0].provider, 'gemini');
});

test('AUDIT M7: returned entries are copies — mutating one cannot poison the source', () => {
  const a = fallbackChainFor({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  a[0].provider = 'MUTATED';
  const b = fallbackChainFor({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  assert.strictEqual(b[0].provider, 'gemini', 'a later caller must not see the mutation');
  assert.strictEqual(STANDARD_FALLBACK_CHAIN[0].provider, 'gemini');
});

test('AUDIT H3/H4: an unknown provider is not treated as a known one', () => {
  // Still returns a usable chain (never strand a caller) but does NOT get the
  // anthropic/omniroute-specific gemini-3.5 prepend it never earned.
  const typo = fallbackChainFor({ provider: 'anthropc', model: 'x' });
  assert.ok(typo.length > 0);
  assert.strictEqual(typo[0].model, 'gemini-3.1-flash-lite', 'no tailored prepend for an unknown provider');
  assert.strictEqual(fallbackChainFor({ provider: '', model: 'x' })[0].model, 'gemini-3.1-flash-lite');
});

test('AUDIT M9: a falsy model never drops a legitimate fallback entry', () => {
  const ch = fallbackChainFor({ provider: 'gemini', model: '' });
  assert.strictEqual(ch.length, 3, 'all three standard entries must survive');
  assert.strictEqual(fallbackChainFor({ provider: 'gemini', model: null }).length, 3);
});

test('the real exclusion still works when provider AND model are both real', () => {
  const ch = fallbackChainFor({ provider: 'groq', model: 'openai/gpt-oss-20b' });
  assert.ok(!ch.some(c => c.provider === 'groq' && c.model === 'openai/gpt-oss-20b'));
});

test('KNOWN_PROVIDERS is frozen and covers every provider groq-agent accepts', () => {
  assert.throws(() => KNOWN_PROVIDERS.push('x'), TypeError);
  for (const p of ['anthropic', 'gemini', 'groq', 'ollama', 'omniroute']) {
    assert.ok(KNOWN_PROVIDERS.includes(p), p + ' missing');
  }
});
