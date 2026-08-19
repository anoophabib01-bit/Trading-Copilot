'use strict';
// Regression tests for the 2026-08-18 "connection may have dropped" cascade.
// DATA/chat_transcript.json was found ending in THREE consecutive `user` turns
// with no assistant replies — each a CSV auto-debrief that got no answer. Every
// provider requires alternating roles, so after the first failure left an
// orphan user turn, every later request was malformed and failed too. The user
// only ever saw a generic timeout, repeatedly, including right after unrelated
// fixes had shipped.
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeConversation, isBlankContent } = require('../groq-agent.js')._debug;

test('THE LIVE BUG: three orphaned user turns collapse into one valid turn', () => {
  const poisoned = [
    { role: 'user', content: 'debrief 08-17' },
    { role: 'assistant', content: 'here is your coaching' },
    { role: 'user', content: 'debrief 08-17 again' },
    { role: 'user', content: 'debrief 08-18' },
    { role: 'user', content: 'debrief 08-18 again' },
  ];
  const out = sanitizeConversation(poisoned);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(m => m.role), ['user', 'assistant', 'user']);
  // Merged, not dropped — a re-sent debrief must not be silently discarded.
  assert.match(out[2].content, /debrief 08-17 again/);
  assert.match(out[2].content, /debrief 08-18 again/);
});

test('roles strictly alternate after sanitizing', () => {
  const out = sanitizeConversation([
    { role: 'user', content: 'a' }, { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' }, { role: 'assistant', content: 'd' },
    { role: 'user', content: 'e' },
  ]);
  for (let i = 1; i < out.length; i++) {
    assert.notEqual(out[i].role, out[i - 1].role, 'consecutive same-role turn survived');
  }
});

test('an aborted stream leaving an empty assistant turn does not break alternation', () => {
  const out = sanitizeConversation([
    { role: 'user', content: 'question' },
    { role: 'assistant', content: '' },   // cancelled mid-stream
    { role: 'user', content: 'asking again' },
  ]);
  assert.deepEqual(out.map(m => m.role), ['user']);
  assert.match(out[0].content, /question/);
  assert.match(out[0].content, /asking again/);
});

test('a conversation starting with an assistant turn has it removed', () => {
  const out = sanitizeConversation([
    { role: 'assistant', content: 'unprompted' },
    { role: 'user', content: 'hi' },
  ]);
  assert.deepEqual(out.map(m => m.role), ['user']);
});

test('image/tool content blocks are never treated as blank', () => {
  const img = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }];
  assert.equal(isBlankContent(img), false);
  const out = sanitizeConversation([{ role: 'user', content: img }]);
  assert.equal(out.length, 1);
});

test('a whitespace-only text block counts as blank', () => {
  assert.equal(isBlankContent([{ type: 'text', text: '   ' }]), true);
  assert.equal(isBlankContent('  \n '), true);
  assert.equal(isBlankContent([]), true);
  assert.equal(isBlankContent(null), true);
});

test('an already-valid conversation passes through untouched', () => {
  const good = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
  ];
  assert.deepEqual(sanitizeConversation(good), good);
});

test('merging preserves content-block arrays rather than stringifying them', () => {
  const out = sanitizeConversation([
    { role: 'user', content: [{ type: 'text', text: 'one' }] },
    { role: 'user', content: [{ type: 'text', text: 'two' }] },
  ]);
  assert.equal(out.length, 1);
  assert.ok(Array.isArray(out[0].content));
  assert.equal(out[0].content.length, 2);
});

test('garbage input never throws', () => {
  assert.deepEqual(sanitizeConversation(null), []);
  assert.deepEqual(sanitizeConversation(undefined), []);
  assert.deepEqual(sanitizeConversation('nope'), []);
  assert.deepEqual(sanitizeConversation([null, undefined, {}, { role: 'user', content: 'ok' }]).map(m => m.role), ['user']);
});
