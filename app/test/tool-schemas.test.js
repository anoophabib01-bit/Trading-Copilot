'use strict';
// ── Tool-schema sanity (2026-09-03) ─────────────────────────────────────────
// A duplicate tool name is not a soft failure. Gemini rejects the whole
// request with 400 "Duplicate function declaration found: <name>", so EVERY
// agent on that path dies at once — and because provider-chain fails open, the
// symptom is a full lap through every configured model before the user sees
// anything. It shipped once (recall_patterns added to claude-agent.js's
// ARCHIVE_TOOLS twice on the same day) and was only caught by driving the live
// server, because `node --check` and every unit test passed.
//
// These are cheap structural checks over the real exported arrays — the same
// shape of guard provider-chain.test.js applies to KNOWN_PROVIDERS.

const test = require('node:test');
const assert = require('node:assert');

const claudeAgent = require('../claude-agent');

test('ALL_TOOLS has no duplicate tool names', () => {
  const names = claudeAgent._debug.ALL_TOOLS.map((t) => t.name);
  const seen = new Set();
  const dupes = [];
  names.forEach((n) => { if (seen.has(n)) dupes.push(n); else seen.add(n); });
  assert.deepStrictEqual(dupes, [], 'duplicate tool name(s) would 400 the whole request');
});

test('every ALL_TOOLS entry has a name, a description and an object schema', () => {
  claudeAgent._debug.ALL_TOOLS.forEach((t) => {
    assert.ok(t.name && typeof t.name === 'string', 'tool needs a name');
    // The model reads descriptions as instructions — an empty one is a tool it
    // cannot know when to use.
    assert.ok(t.description && t.description.length > 20, t.name + ' needs a real description');
    assert.ok(t.input_schema && t.input_schema.type === 'object', t.name + ' needs an object input_schema');
    assert.ok(Array.isArray(t.input_schema.required), t.name + ' needs a required array');
  });
});

test('tool names match the shape every provider accepts', () => {
  // OpenAI and Gemini both restrict function names to [A-Za-z0-9_-]. A name
  // with a space or a dot is rejected at request time, not at load time.
  claudeAgent._debug.ALL_TOOLS.forEach((t) => {
    assert.match(t.name, /^[A-Za-z0-9_-]{1,64}$/, t.name + ' is not a portable function name');
  });
});

test('the memory tools are actually wired into the main chat', () => {
  // These three are the whole point of the 2026-09-03 memory work: without
  // them the main co-pilot cannot reach the chat archive, the pattern ledger,
  // or the causal diagnosis, and silently answers from context alone.
  const names = claudeAgent._debug.ALL_TOOLS.map((t) => t.name);
  ['recall_chat', 'recall_patterns', 'diagnose_day'].forEach((n) => {
    assert.ok(names.includes(n), n + ' is missing from ALL_TOOLS');
  });
});
