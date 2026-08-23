'use strict';
/**
 * anthropic-native.js — native Anthropic support for groq-agent.js (task #31)
 *
 * WHY THIS EXISTS
 * Anthropic is reachable two ways:
 *   1. Its OpenAI-COMPATIBLE endpoint (/v1/chat/completions). Drop-in for this
 *      app's pipeline, which is what shipped 2026-08-11 evening — but it does
 *      NOT support prompt caching, and Anthropic's own docs call it "not a
 *      long-term or production-ready solution".
 *   2. The NATIVE endpoint (/v1/messages). Supports prompt caching with a 1h
 *      TTL, which matters here because ~19.6K tokens of system prompt + tool
 *      schemas are byte-identical on every call. Cache reads bill at 0.1x
 *      input, so on a small prepaid balance this is a 3-5x cost difference on
 *      every repeat call within the hour.
 *
 * THE DESIGN CHOICE THAT KEEPS THIS SMALL
 * groq-agent.js is OpenAI-shaped end to end: its payload, its SSE parser
 * (`choices[0].delta`), and its tool loop. Rather than fork that loop for
 * Anthropic — which would mean maintaining two copies of the most
 * correctness-critical code in the app — this module does pure TRANSLATION:
 *
 *     OpenAI-shaped request  --toAnthropicRequest()-->  native /v1/messages body
 *     native SSE events      --translateEvent()------>  OpenAI-shaped chunks
 *
 * The existing parser and tool loop then run completely unchanged. Everything
 * here is a pure function of its inputs, so it is unit-tested without a live
 * API key — see test/anthropic-native.test.js.
 */

// Anthropic's stop_reason vocabulary -> OpenAI's finish_reason vocabulary.
// 'tool_use' -> 'tool_calls' is the load-bearing one: groq-agent's loop keys
// off the PRESENCE of tool calls rather than this string (a deliberate fix from
// 2026-07-25, when Gemini reported 'stop' while streaming tool calls), but
// mapping it correctly keeps logs and any future consumer honest.
const STOP_REASON_MAP = {
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  pause_turn: 'stop',
  refusal: 'stop'
};

/**
 * Build a native /v1/messages request body from the OpenAI-shaped payload
 * groq-agent.js already assembles.
 *
 * Three real differences to handle:
 *   1. `system` is a TOP-LEVEL parameter, not a message with role:'system'.
 *   2. Tools use {name, description, input_schema}, not
 *      {type:'function', function:{name, description, parameters}}.
 *   3. Tool RESULTS come back as role:'tool' messages in OpenAI; Anthropic
 *      wants them as a user message containing tool_result content blocks, and
 *      assistant tool CALLS as tool_use content blocks.
 *
 * cacheTtl: '1h' | '5m' | null. Two cache breakpoints are placed — one on the
 * system prompt, one on the last tool — because those two blocks are the large,
 * byte-identical prefix. Anything after them (the conversation) is not cached,
 * which is correct: it changes every turn.
 */
function toAnthropicRequest(payload, { cacheTtl = '1h' } = {}) {
  const cacheControl = cacheTtl ? { type: 'ephemeral', ttl: cacheTtl } : null;
  const msgs = Array.isArray(payload.messages) ? payload.messages : [];

  // 1. Hoist system. Anthropic accepts only ONE leading system block, so if the
  //    caller ever passes several they are concatenated — the same thing
  //    Anthropic's own compat layer does, so behaviour matches either route.
  const systemTexts = msgs.filter(m => m.role === 'system').map(m => String(m.content || ''));
  const systemText = systemTexts.join('\n');

  // 2. Convert the conversation.
  const out = [];
  for (const m of msgs) {
    if (m.role === 'system') continue;

    // Assistant turn that called tools -> content blocks of type tool_use.
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const tc of m.tool_calls) {
        let input = {};
        // Arguments arrive as a JSON *string* in OpenAI shape. A malformed
        // string must not throw here — a dropped tool call is recoverable, a
        // crashed stream mid-session is not.
        try { input = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch { input = {}; }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function && tc.function.name,
          input
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    // Tool RESULT -> a user message carrying a tool_result block. Consecutive
    // results are merged into one user message, which is what Anthropic expects
    // when several tools were called in one assistant turn.
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: String(m.content == null ? '' : m.content)
      };
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && Array.isArray(prev.content) &&
          prev.content.every(b => b.type === 'tool_result')) {
        prev.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    // Preserve Anthropic content blocks (text/image/tool_use/tool_result).
    // Older code stringified arrays, which destroyed multimodal blocks.
    if (Array.isArray(m.content)) {
      out.push({ role: m.role, content: m.content });
    } else {
      out.push({ role: m.role, content: String(m.content == null ? '' : m.content) });
    }
  }

  const body = {
    model: payload.model,
    max_tokens: payload.max_tokens || 4096,
    stream: true,
    messages: out
  };
  if (payload.temperature != null) body.temperature = payload.temperature;

  if (systemText) {
    body.system = cacheControl
      ? [{ type: 'text', text: systemText, cache_control: { ...cacheControl } }]
      : systemText;
  }

  // 3. Tools. The cache breakpoint goes on the LAST tool so the whole tool
  //    block is covered by one marker.
  if (Array.isArray(payload.tools) && payload.tools.length) {
    body.tools = payload.tools.map((t, i) => {
      const fn = t.function || t;
      const tool = {
        name: fn.name,
        description: fn.description,
        input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} }
      };
      if (cacheControl && i === payload.tools.length - 1) tool.cache_control = { ...cacheControl };
      return tool;
    });
  }
  return body;
}

/**
 * Translate ONE native SSE event into zero or more OpenAI-shaped chunks, so
 * groq-agent.js's existing parser consumes them without modification.
 *
 * `state` is a caller-owned object carrying the tool-call index across events
 * (Anthropic addresses content blocks by index; OpenAI addresses tool calls by
 * their own index — they are not the same counter, so it is tracked here).
 */
function translateEvent(evt, state) {
  if (!evt || !evt.type) return [];
  const s = state || {};
  if (!s.toolIndexByBlock) s.toolIndexByBlock = {};
  if (s.nextToolIndex == null) s.nextToolIndex = 0;

  switch (evt.type) {
    case 'message_start': {
      // Usage arrives here (input + cache figures) and again on message_delta
      // (output). Emitting both lets the caller keep the last-seen merged view.
      const u = evt.message && evt.message.usage;
      return u ? [{ usage: u, choices: [{ delta: {} }] }] : [];
    }

    case 'content_block_start': {
      const cb = evt.content_block || {};
      if (cb.type !== 'tool_use') return [];
      const idx = s.nextToolIndex++;
      s.toolIndexByBlock[evt.index] = idx;
      return [{
        choices: [{
          delta: { tool_calls: [{ index: idx, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }] }
        }]
      }];
    }

    case 'content_block_delta': {
      const d = evt.delta || {};
      if (d.type === 'text_delta') {
        return [{ choices: [{ delta: { content: d.text } }] }];
      }
      if (d.type === 'input_json_delta') {
        const idx = s.toolIndexByBlock[evt.index];
        if (idx == null) return [];
        return [{
          choices: [{ delta: { tool_calls: [{ index: idx, function: { arguments: d.partial_json || '' } }] } }]
        }];
      }
      // thinking_delta / signature_delta are not surfaced to the UI.
      return [];
    }

    case 'message_delta': {
      const chunks = [];
      const stop = evt.delta && evt.delta.stop_reason;
      if (stop) chunks.push({ choices: [{ finish_reason: STOP_REASON_MAP[stop] || 'stop', delta: {} }] });
      if (evt.usage) chunks.push({ usage: evt.usage, choices: [{ delta: {} }] });
      return chunks;
    }

    default:
      // message_stop, content_block_stop, ping — nothing the parser needs.
      return [];
  }
}

module.exports = { toAnthropicRequest, translateEvent, STOP_REASON_MAP };
