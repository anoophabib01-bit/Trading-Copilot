'use strict';
/**
 * Guards the DeepSeek request shape — specifically the two fields that stop a
 * heavy prompt from silently failing over to another vendor.
 *
 * THE LIVE BUG THIS PINS (2026-09-02, Anoop's first real Debate run)
 * DeepSeek V4 streams `reasoning_content` and spends it from the SAME
 * max_tokens budget as the visible answer. At max_tokens 4096 the Power-of-3
 * agent burned 15,387 characters thinking and produced ZERO content — a 200 OK
 * with an empty reply, which groq-agent treats as a dead model. The chain
 * dropped to deepseek-v4-flash (same result) and then to Gemini, which
 * answered as PO3 while every other card still said DeepSeek.
 *
 * Nothing failed loudly. It was caught only because the per-card provider
 * label was on screen and Anoop read it. These assertions are the substitute
 * for that luck.
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildRequest } = require('../groq-agent')._debug;

const basePayload = () => ({
  model: 'deepseek-v4-flash-vision-exp',
  stream: true,
  max_tokens: 4096,
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]
});

test('DeepSeek requests disable thinking — reasoning tokens must not eat the answer budget', () => {
  const { body } = buildRequest('deepseek', 'sk-test', basePayload());
  const sent = JSON.parse(body);
  assert.deepStrictEqual(sent.thinking, { type: 'disabled' },
    'without this, a heavy prompt returns empty content and fails over to another vendor');
});

test('DeepSeek requests carry headroom above the caller default of 4096', () => {
  const { body } = buildRequest('deepseek', 'sk-test', basePayload());
  assert.ok(JSON.parse(body).max_tokens >= 8192, 'max_tokens is a ceiling, not a charge — headroom is free');
});

test('a caller asking for MORE tokens than the floor is not silently reduced', () => {
  const p = basePayload(); p.max_tokens = 32000;
  assert.strictEqual(JSON.parse(buildRequest('deepseek', 'sk-test', p).body).max_tokens, 32000);
});

test('DeepSeek goes to the right host with Bearer auth and an accurate Content-Length', () => {
  const { options, body } = buildRequest('deepseek', 'sk-test', basePayload());
  assert.strictEqual(options.hostname, 'api.deepseek.com');
  assert.strictEqual(options.path, '/chat/completions');
  assert.strictEqual(options.headers.Authorization, 'Bearer sk-test');
  // A Content-Length computed from the PRE-modification body would truncate
  // the request — the thinking field is added after the caller stringifies.
  assert.strictEqual(options.headers['Content-Length'], Buffer.byteLength(body),
    'Content-Length must describe the body actually sent, not the original payload');
});

test('the thinking field is DeepSeek-only — it must not leak to the Gemini backup', () => {
  const { body } = buildRequest('gemini', 'k', basePayload());
  assert.strictEqual(JSON.parse(body).thinking, undefined, 'Gemini must not receive DeepSeek-specific fields');
});

test('an unknown provider throws instead of silently defaulting to one nobody chose', () => {
  // Pre-2026-09-02 buildRequest fell through to Groq for ANY unrecognised
  // name. That is the same silent-default class of bug as the registry drift
  // found the same day: a retired or typo'd provider would quietly get
  // answered by a vendor nobody selected.
  assert.throws(() => buildRequest('anthropic', 'k', basePayload()), /unknown provider/);
  assert.throws(() => buildRequest('typo', 'k', basePayload()), /unknown provider/);
});
