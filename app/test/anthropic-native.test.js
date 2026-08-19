'use strict';
/**
 * Unit tests for anthropic-native.js — the request/response translation that
 * lets groq-agent.js talk to Anthropic's NATIVE API (and therefore use prompt
 * caching) without forking its tool loop.
 *
 * This code sits in the path of every agent in the app, so the translation is
 * tested in both directions rather than trusted.
 */
const test = require('node:test');
const assert = require('node:assert');
const { toAnthropicRequest, translateEvent } = require('../anthropic-native');

// ── toAnthropicRequest ───────────────────────────────────────────────────────
test('system message is hoisted out of messages to a top-level param', () => {
  const b = toAnthropicRequest({
    model: 'claude-haiku-4-5',
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]
  });
  assert.ok(Array.isArray(b.system), 'system should be a content-block array when caching');
  assert.strictEqual(b.system[0].text, 'SYS');
  assert.strictEqual(b.messages.length, 1, 'system must NOT remain in messages');
  assert.strictEqual(b.messages[0].role, 'user');
});

test('cache_control with 1h TTL lands on system AND the last tool', () => {
  const b = toAnthropicRequest({
    model: 'claude-haiku-4-5',
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }],
    tools: [
      { type: 'function', function: { name: 'a', description: 'd', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'b', description: 'd', parameters: { type: 'object', properties: {} } } }
    ]
  });
  assert.deepStrictEqual(b.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.strictEqual(b.tools[0].cache_control, undefined, 'only the LAST tool carries the breakpoint');
  assert.deepStrictEqual(b.tools[1].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('cacheTtl null produces a plain string system and no cache markers', () => {
  const b = toAnthropicRequest({
    model: 'm', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'a', description: 'd', parameters: {} } }]
  }, { cacheTtl: null });
  assert.strictEqual(b.system, 'SYS');
  assert.strictEqual(b.tools[0].cache_control, undefined);
});

test('tools convert from OpenAI parameters to Anthropic input_schema', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
  const b = toAnthropicRequest({
    model: 'm', messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'search', description: 'find', parameters: schema } }]
  });
  assert.strictEqual(b.tools[0].name, 'search');
  assert.deepStrictEqual(b.tools[0].input_schema, schema);
  assert.strictEqual(b.tools[0].parameters, undefined, 'OpenAI key must not leak through');
});

test('assistant tool_calls become tool_use blocks with parsed input', () => {
  const b = toAnthropicRequest({
    model: 'm',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'quote_get', arguments: '{"sym":"MNQ"}' } }] }
    ]
  });
  const blocks = b.messages[1].content;
  assert.strictEqual(blocks[0].type, 'tool_use');
  assert.strictEqual(blocks[0].id, 't1');
  assert.deepStrictEqual(blocks[0].input, { sym: 'MNQ' });
});

test('malformed tool arguments degrade to {} instead of throwing', () => {
  assert.doesNotThrow(() => {
    const b = toAnthropicRequest({
      model: 'm',
      messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 't1', function: { name: 'x', arguments: '{oops' } }] }]
    });
    assert.deepStrictEqual(b.messages[0].content[0].input, {});
  });
});

test('role:tool becomes a user message with a tool_result block', () => {
  const b = toAnthropicRequest({
    model: 'm',
    messages: [{ role: 'tool', tool_call_id: 't1', content: 'RESULT' }]
  });
  assert.strictEqual(b.messages[0].role, 'user');
  assert.strictEqual(b.messages[0].content[0].type, 'tool_result');
  assert.strictEqual(b.messages[0].content[0].tool_use_id, 't1');
  assert.strictEqual(b.messages[0].content[0].content, 'RESULT');
});

test('consecutive tool results merge into ONE user message', () => {
  const b = toAnthropicRequest({
    model: 'm',
    messages: [
      { role: 'tool', tool_call_id: 't1', content: 'A' },
      { role: 'tool', tool_call_id: 't2', content: 'B' }
    ]
  });
  assert.strictEqual(b.messages.length, 1);
  assert.strictEqual(b.messages[0].content.length, 2);
});

test('max_tokens defaults and temperature passes through', () => {
  const b = toAnthropicRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0.85 });
  assert.strictEqual(b.max_tokens, 4096);
  assert.strictEqual(b.temperature, 0.85);
  assert.strictEqual(b.stream, true);
});

// ── translateEvent ───────────────────────────────────────────────────────────
test('text_delta becomes an OpenAI content delta', () => {
  const out = translateEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }, {});
  assert.strictEqual(out[0].choices[0].delta.content, 'hello');
});

test('tool_use start + input_json_delta reassemble into one OpenAI tool call', () => {
  const state = {};
  const start = translateEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'quote_get' } }, state);
  assert.strictEqual(start[0].choices[0].delta.tool_calls[0].index, 0);
  assert.strictEqual(start[0].choices[0].delta.tool_calls[0].id, 'tu_1');
  assert.strictEqual(start[0].choices[0].delta.tool_calls[0].function.name, 'quote_get');

  const d1 = translateEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"sym"' } }, state);
  const d2 = translateEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"MNQ"}' } }, state);
  const joined = d1[0].choices[0].delta.tool_calls[0].function.arguments
               + d2[0].choices[0].delta.tool_calls[0].function.arguments;
  assert.deepStrictEqual(JSON.parse(joined), { sym: 'MNQ' });
});

test('two tool_use blocks get distinct OpenAI indices', () => {
  const state = {};
  const a = translateEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'x' } }, state);
  const b = translateEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'b', name: 'y' } }, state);
  assert.strictEqual(a[0].choices[0].delta.tool_calls[0].index, 0);
  assert.strictEqual(b[0].choices[0].delta.tool_calls[0].index, 1);
});

test('a TEXT content_block_start does not consume a tool index', () => {
  const state = {};
  translateEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, state);
  const tool = translateEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'x' } }, state);
  assert.strictEqual(tool[0].choices[0].delta.tool_calls[0].index, 0, 'text block must not shift tool numbering');
});

test('stop_reason tool_use maps to finish_reason tool_calls', () => {
  const out = translateEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, {});
  assert.strictEqual(out[0].choices[0].finish_reason, 'tool_calls');
});

test('stop_reason end_turn maps to stop; max_tokens maps to length', () => {
  assert.strictEqual(translateEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, {})[0].choices[0].finish_reason, 'stop');
  assert.strictEqual(translateEvent({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, {})[0].choices[0].finish_reason, 'length');
});

test('message_start surfaces usage including cache figures', () => {
  const out = translateEvent({ type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 19604 } } }, {});
  assert.strictEqual(out[0].usage.cache_read_input_tokens, 19604);
});

test('unknown / no-op events translate to nothing rather than throwing', () => {
  for (const t of ['ping', 'message_stop', 'content_block_stop', 'wat']) {
    assert.deepStrictEqual(translateEvent({ type: t }, {}), []);
  }
  assert.deepStrictEqual(translateEvent(null, {}), []);
});
