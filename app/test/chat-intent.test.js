const test = require('node:test');
const assert = require('node:assert');
const CI = require('../chat-intent.js');

// ── classifyChatIntent ───────────────────────────────────────────────────

test('the bare word "scalp"/"scalping" alone is a strong, unambiguous signal', () => {
  assert.strictEqual(CI.classifyChatIntent('should I scalp this move?'), 'scalping');
  assert.strictEqual(CI.classifyChatIntent('thinking about scalping the open'), 'scalping');
});

test('a single weak signal alone is NOT enough — avoids over-firing on ordinary chat', () => {
  assert.strictEqual(CI.classifyChatIntent('what\'s a good hold time here?'), null);
  assert.strictEqual(CI.classifyChatIntent('is this a re-entry or a new setup?'), null);
});

test('two weak signals together ARE enough', () => {
  const r = CI.classifyChatIntent('how long should I hold before a re-entry?');
  assert.strictEqual(r, 'scalping');
});

test('THE FALSE-POSITIVE GUARD: a review question about scalping must NOT trigger', () => {
  assert.strictEqual(CI.classifyChatIntent('how did my scalping look yesterday?'), null);
  assert.strictEqual(CI.classifyChatIntent('review my scalp trades from last session'), null);
  assert.strictEqual(CI.classifyChatIntent('how was my hold time this morning?'), null);
});

test('a plain discipline/psychology question has no signal at all', () => {
  assert.strictEqual(CI.classifyChatIntent('I feel like revenge trading right now, talk me down'), null);
  assert.strictEqual(CI.classifyChatIntent('what\'s my balance?'), null);
});

test('classifyChatIntent on empty/garbage input returns null, never throws', () => {
  assert.strictEqual(CI.classifyChatIntent(''), null);
  assert.strictEqual(CI.classifyChatIntent(null), null);
  assert.strictEqual(CI.classifyChatIntent(undefined), null);
  assert.strictEqual(CI.classifyChatIntent(42), null);
});

// ── modeMismatchHint ──────────────────────────────────────────────────────

test('a scalping-classified message in standard mode gets a hint', () => {
  const hint = CI.modeMismatchHint('scalping', 'standard');
  assert.ok(hint);
  assert.match(hint, /Scalper mode/);
});

test('a scalping-classified message already in scalper mode gets no hint — nothing to suggest', () => {
  assert.strictEqual(CI.modeMismatchHint('scalping', 'scalper'), null);
});

test('a null intent never produces a hint regardless of mode', () => {
  assert.strictEqual(CI.modeMismatchHint(null, 'standard'), null);
  assert.strictEqual(CI.modeMismatchHint(null, 'scalper'), null);
});

// ── shouldSuppressForCooldown ─────────────────────────────────────────────

test('shouldSuppressForCooldown suppresses within the window, allows after it', () => {
  const cooldownMs = 20 * 60 * 1000;
  const lastHintAt = 1_000_000;
  assert.strictEqual(CI.shouldSuppressForCooldown(lastHintAt, lastHintAt + 1000, cooldownMs), true);
  assert.strictEqual(CI.shouldSuppressForCooldown(lastHintAt, lastHintAt + cooldownMs + 1, cooldownMs), false);
});

test('shouldSuppressForCooldown never suppresses when there is no prior hint', () => {
  assert.strictEqual(CI.shouldSuppressForCooldown(null, Date.now(), 60000), false);
  assert.strictEqual(CI.shouldSuppressForCooldown(undefined, Date.now(), 60000), false);
});
