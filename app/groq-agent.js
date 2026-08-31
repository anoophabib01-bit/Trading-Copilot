'use strict';
// Groq-backed chat agent for "Jessi" — mirrors claude-agent.js's shape
// (init/isReady/stream with a tool-calling loop) but talks to Groq's free,
// OpenAI-compatible chat-completions endpoint instead of Anthropic's API.
//
// 2026-07-22: upgraded from plain streaming text to real tool-calling so
// Jessi can read AND mark/draw on the TradingView chart (Anoop explicitly
// asked for write access after being warned this was untested). The tool
// loop mirrors claude-agent.js's runLoop but parses OpenAI-style streamed
// tool_call deltas (indexed, accumulated by index) instead of Anthropic's
// content_block events.
//
// HARD SAFETY RULE (defense in depth — enforced here regardless of what the
// caller passes as `tools`): this agent will NEVER execute a tool whose name
// matches the trade-execution blocklist below, even if the model requests
// it. Placing/submitting/modifying real trades is not something a free,
// unsupervised model gets to do from a chat reply — full stop.
const BLOCKED_TOOLS = new Set([
  'trade_submit', 'trade_open_limit', 'trade_dismiss',
  'chart_set_symbol', 'chart_set_timeframe' // also excluded: don't let casual chat disrupt Anoop's live chart setup
]);

const https = require('https');
const http = require('http');
const mcpBridge = require('./mcp-bridge');
const callLogger = require('./call-logger');
const anthropicNative = require('./anthropic-native');

// 2026-07-25: was 'llama-3.3-70b-versatile', which Groq DEPRECATED on
// 2026-06-17 (alongside llama-3.1-8b-instant, retiring 08/16/26). Groq's own
// migration targets are openai/gpt-oss-20b / gpt-oss-120b / qwen/qwen3.6-27b.
// Defaulting to gpt-oss-20b since the app's existing fallback path already
// proved it works here.
const GROQ_MODEL = 'openai/gpt-oss-20b';
const GROQ_HOST = 'api.groq.com';
const GROQ_PATH = '/openai/v1/chat/completions';

// Ollama (local, unlimited) exposes an OpenAI-compatible endpoint. Same SSE
// streaming + tool-call format as Groq, so the existing parser is reused — the
// only differences are http (not https), no auth, and localhost:11434.
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const OLLAMA_PATH = '/v1/chat/completions';

// Google Gemini via its OpenAI-COMPATIBILITY endpoint (ai.google.dev/gemini-api/docs/openai),
// not the native generateContent API — so the exact same SSE parser and
// tool_calls delta format used for Groq/Ollama applies unchanged.
//
// WHY THIS IS NOW THE DEFAULT (2026-07-25): Groq's free tier caps tokens PER
// MINUTE at 6,000–8,000, and Jessi's turn (14 days of trade data + checklist +
// journal + chart snapshot + ~11 tool defs) genuinely does not fit — that's
// what produced the live 413 "Request too large" and 429 "TPM Limit 8000,
// Used 5517, Requested 2663" failures, NOT running out of daily budget.
// Gemini's free tier allows vastly more TPM, which removes the cause rather
// than deferring it.
//
// MODEL ID (revised 2026-07-25, same day): originally gemini-2.5-flash-lite,
// which returned a live 404 — "This model models/gemini-2.5-flash-lite is no
// longer available to new users." Google had closed the 2.5 line to new
// accounts. Now gemini-3.5-flash (GA), free tier 15 RPM / 1,500 RPD — more
// daily requests than the 2.5 Flash-Lite plan it replaces. Because Google
// retires IDs at this pace, callers pass an ordered CHAIN of candidates and
// 404 is retryable (see the chain logic in stream()); relying on one
// hardcoded ID here is a liability, not a config choice.
// KNOWN QUIRK: Gemini's compat layer returns `usage` on every chunk instead of
// only the last (an OpenAI spec deviation). Harmless here — this parser
// ignores `usage` entirely.
const GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const GEMINI_PATH = '/v1beta/openai/chat/completions';

// OmniRoute — self-hosted, locally-run LLM routing proxy (OpenAI-compatible),
// added 2026-08-07 per the approved office-hours design doc. Anoop runs it
// himself at localhost:20128 with his own API key/account pool behind it, so
// this is plain http to a local port, same shape as the Ollama branch below.
// DELIBERATE SCOPE NOTE: some models OmniRoute exposes ride pooled/shared
// "free" CLI-subscription accounts (its Tier-1 stealth layer) rather than
// real paid API keys — a real account-ban risk, acknowledged and accepted by
// Anoop for the reasoning/large-context capability it unlocks. This is why
// OmniRoute is wired as the PRIMARY provider with the existing Gemini/Groq
// chain kept as an unmodified fail-open fallback (see server.js
// primaryProviderModel()/fallbackChainFor()) — a ban or outage here falls
// through to the same chain that worked before OmniRoute existed, not a dead
// end. Host/port are read from config at call time (initOmniRoute), not
// hardcoded, since this runs on Anoop's machine only.
const OMNIROUTE_PATH = '/v1/chat/completions';
// 2026-08-07 (revised, same day): Anoop's explicit pick — oc/deepseek-v4-flash-free
// as the starting model, verified working via a direct curl before wiring in.
// Was 'auto/best-reasoning'. The shift-down-on-failure "plan" this starts is
// unchanged: server.js's fallbackChainFor() still degrades OmniRoute -> Gemini
// (x3 candidates) -> Groq exactly as before — only the OmniRoute starting
// model changed, not the fail-open chain around it.
const OMNIROUTE_MODEL = 'oc/deepseek-v4-flash-free';

// Normalize message content for the target provider.
// The renderer constructs Anthropic-style image blocks. Those are valid for
// Anthropic's native /v1/messages, but OpenAI-compatible providers (Groq,
// Gemini, OmniRoute) expect image_url blocks instead. Convert here so the
// same client code works across the whole fallback chain.
function normalizeMessages(messages, provider) {
  if (!Array.isArray(messages)) return messages;
  if (provider === 'anthropic') return messages;
  return messages.map(m => {
    if (!m || typeof m !== 'object') return m;
    if (Array.isArray(m.content)) {
      const normalized = m.content.map(block => {
        if (!block || typeof block !== 'object') return block;
        if (block.type === 'image' && block.source && block.source.type === 'base64') {
          const mediaType = block.source.media_type || 'image/png';
          const data = block.source.data || '';
          return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } };
        }
        return block;
      });
      return { ...m, content: normalized };
    }
    return m;
  });
}

// Build the HTTP(S) request for whichever provider. Returns the transport
// module too so the caller uses http for Ollama/OmniRoute (both local), https
// for Groq/Gemini.
function buildRequest(provider, apiKey, payload, omniRouteBase) {
  const body = JSON.stringify(payload);
  if (provider === 'ollama') {
    return {
      mod: http,
      options: {
        hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: OLLAMA_PATH, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      },
      body
    };
  }
  if (provider === 'omniroute') {
    const base = omniRouteBase || { host: '127.0.0.1', port: 20128 };
    return {
      mod: http,
      options: {
        hostname: base.host, port: base.port, path: OMNIROUTE_PATH, method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body),
          // 2026-08-07: forces OmniRoute's "stacked" compression pipeline
          // (RTK -> Caveman, ~78-95% token savings per OmniRoute's own docs)
          // on every request — Anoop asked to use compression "in a token
          // optimal way (less)". Per-request header is the HIGHEST-precedence
          // control OmniRoute exposes (beats dashboard panel defaults and
          // named profiles), so this guarantees it applies regardless of what
          // the dashboard's Compression Settings page has configured. The
          // applied mode echoes back in the response's
          // X-OmniRoute-Compression header if this ever needs verifying live.
          'x-omniroute-compression': 'stacked'
        }
      },
      body
    };
  }
  if (provider === 'anthropic') {
    // 2026-08-12 (task #31): switched from Anthropic's OpenAI-COMPAT endpoint
    // to the NATIVE /v1/messages API. The compat route worked but cannot do
    // prompt caching, so every call re-paid full price on ~19.6K tokens of
    // byte-identical system prompt + tool schemas. Native + a 1h cache TTL
    // bills repeat calls inside the hour at 0.1x input — a 3-5x difference on
    // a small prepaid balance.
    // The OpenAI-shaped payload is translated here, and the native SSE events
    // are translated BACK to OpenAI shape in the parser below, so this module's
    // tool loop stays a single implementation shared by every provider.
    const nativeBody = JSON.stringify(anthropicNative.toAnthropicRequest(payload, { cacheTtl: '1h' }));
    return {
      mod: https,
      options: {
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,                 // native API uses x-api-key, NOT Bearer
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(nativeBody)
        }
      },
      body: nativeBody
    };
  }
  if (provider === 'gemini') {
    return {
      mod: https,
      options: {
        hostname: GEMINI_HOST, path: GEMINI_PATH, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) }
      },
      body
    };
  }
  return {
    mod: https,
    options: {
      hostname: GROQ_HOST, path: GROQ_PATH, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) }
    },
    body
  };
}

const PROVIDER_LABEL = { anthropic: 'Anthropic', groq: 'Groq', gemini: 'Gemini', ollama: 'Ollama (local)', omniroute: 'OmniRoute' };

// ── Conversation repair (2026-08-18) ────────────────────────────────────────
// Every provider this file talks to requires user/assistant turns to
// alternate. Nothing in this app enforced that, and a failed turn leaves its
// user message in history with no assistant reply — so the NEXT request is
// malformed, fails, and leaves another orphan. The conversation degrades
// permanently after one bad turn; the user only sees a generic timeout.
//
// Rules, in order:
//   • drop empty/blank turns (an aborted stream can persist an empty
//     assistant message, which is itself an alternation break)
//   • collapse consecutive same-role turns into one, newest content last,
//     rather than dropping them — a re-sent auto-debrief must not be silently
//     discarded, and merging preserves what was asked
//   • never start with an assistant turn (providers reject a leading
//     assistant message)
// Exported for unit testing; pure, no I/O.
function isBlankContent(c) {
  if (c == null) return true;
  if (typeof c === 'string') return c.trim() === '';
  if (Array.isArray(c)) {
    if (!c.length) return true;
    // A content-block array is blank only if every block is a blank text
    // block. Image/tool blocks are never blank.
    return c.every(b => b && typeof b === 'object' && b.type === 'text'
      ? String(b.text || '').trim() === ''
      : false);
  }
  return false;
}

function mergeContent(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a + '\n\n' + b;
  const toArr = (x) => Array.isArray(x) ? x : [{ type: 'text', text: String(x == null ? '' : x) }];
  return [...toArr(a), ...toArr(b)];
}

function sanitizeConversation(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object' || !m.role) continue;
    if (isBlankContent(m.content)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      out[out.length - 1] = { ...prev, content: mergeContent(prev.content, m.content) };
    } else {
      out.push({ ...m });
    }
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

// ── Fallback-loop cap decision (extracted 2026-08-03 for unit testing) ──────
// Pure function: given the current retry state, should the model chain loop
// back to the start instead of giving up? Kept separate from stream()'s HTTP
// orchestration so it's testable without mocking network calls — see
// app/test/fallback-loop.test.js.
const RETRYABLE_STATUSES = [429, 413, 404, 400, 500, 502, 503];
function shouldLoopChain({ statusCode, chainLength, lapCount, maxLaps, elapsedMs, budgetMs }) {
  return RETRYABLE_STATUSES.includes(statusCode)
    && chainLength > 1
    && lapCount < maxLaps
    && elapsedMs < budgetMs;
}
// Reason a loop gave up, for logging/error messages — only meaningful when
// shouldLoopChain(...) is false. Distinguishes the two independent caps so
// "why did it stop" is never a guess.
function loopGiveUpReason({ lapCount, maxLaps }) {
  return lapCount >= maxLaps ? `lap cap (${maxLaps}) reached` : 'time budget exceeded';
}

class GroqAgent {
  constructor() {
    this.apiKey = null;        // Groq (also used for Whisper STT / Orpheus TTS below)
    this.geminiApiKey = null;  // Google Gemini — separate vendor, separate quota
    this.omniRouteApiKey = null;
    this.omniRouteBase = { host: '127.0.0.1', port: 20128 }; // local instance, see buildRequest
    this._omniRouteHealthy = false;   // true only after a successful health probe
    this._omniRouteLastCheck = 0;     // Date.now() of last probe attempt
    this._omniRouteCheckInterval = 30000; // re-probe every 30s
  }

  init(apiKey) {
    this.apiKey = (apiKey || '').trim() || null;
  }

  initGemini(apiKey) {
    this.geminiApiKey = (apiKey || '').trim() || null;
  }

  // 2026-08-11: Anthropic as a first-class provider here, so all nine of the
  // app's AI call sites can run on it via primaryProviderModel() instead of
  // only handleChat.
  //
  // Routed through Anthropic's OpenAI-COMPATIBLE endpoint
  // (https://api.anthropic.com/v1/chat/completions), which lets it reuse this
  // module's existing request/SSE/tool-loop pipeline unchanged rather than
  // needing a hand-written parser for Anthropic's native event stream.
  //
  // KNOWN TRADE-OFF, accepted deliberately: the compat layer does NOT support
  // prompt caching (Anthropic's docs are explicit), and Anthropic labels it
  // "not a long-term or production-ready solution". So this path pays full
  // input price on every call, and the 1h cache TTL in claude-agent.js does
  // NOT apply here. That is affordable at this app's shape — the debate agents
  // carry no tool schemas, so their context is ~7K tokens, roughly $0.02-0.04
  // per interaction on Haiku — but it is the reason a NATIVE adapter is still
  // worth building later (task #31): native gets caching back and is the
  // supported path.
  initAnthropic(apiKey) {
    this.anthropicApiKey = (apiKey || '').trim() || null;
  }

  // baseUrl (optional): e.g. "http://localhost:20128" — parsed for host/port,
  // falls back to the 127.0.0.1:20128 default (Anoop's local instance) if
  // omitted or unparseable.
  initOmniRoute(apiKey, baseUrl) {
    this.omniRouteApiKey = (apiKey || '').trim() || null;
    if (baseUrl) {
      try {
        const u = new URL(baseUrl);
        this.omniRouteBase = { host: u.hostname, port: u.port ? parseInt(u.port, 10) : 80 };
      } catch {}
    }
  }

  // Groq-specific readiness — voice (Whisper/Orpheus) is Groq-only, so this
  // deliberately still means "Groq usable", not "any provider usable".
  isReady() { return !!this.apiKey; }

  isGeminiReady() { return !!this.geminiApiKey; }

  isOmniRouteReady() { return !!this.omniRouteApiKey && this._omniRouteHealthy; }

  // Probes OmniRoute's health endpoint; caches result for 30s so we don't
  // hammer it on every chat turn.  Called by server.js before routing a
  // request through primaryProviderModel().
  async probeOmniRouteHealth() {
    if (!this.omniRouteApiKey) { this._omniRouteHealthy = false; return false; }
    const now = Date.now();
    if (now - this._omniRouteLastCheck < this._omniRouteCheckInterval) return this._omniRouteHealthy;
    this._omniRouteLastCheck = now;
    const base = this.omniRouteBase || { host: '127.0.0.1', port: 20128 };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000); // 5s timeout
      const res = await fetch(`http://${base.host}:${base.port}/api/monitoring/health`, {
        signal: controller.signal
      });
      clearTimeout(timer);
      this._omniRouteHealthy = res.ok;
    } catch {
      this._omniRouteHealthy = false;
    }
    // Log the TRANSITION, not every probe. This runs every 30s and, when
    // OmniRoute is not running locally, fails every single time — which on
    // 2026-08-26 accounted for 425 of 567 lines in the server log, 75% of the
    // output. That is not a cosmetic problem: the live feed is diagnosed by
    // reading this log, and the MCP timeouts and panel self-heal messages that
    // actually mattered were buried in the noise. Same discipline the panel
    // watchdog already states for itself — a check that logs every minute is a
    // check nobody reads.
    //
    // Behaviour is unchanged: the fallback to Gemini already happens through
    // _omniRouteHealthy regardless of what is printed.
    if (this._omniRouteHealthy !== this._omniRouteLastLoggedHealth) {
      console.log(this._omniRouteHealthy
        ? '[OmniRoute] health probe recovered — available as primary again'
        : '[OmniRoute] health probe failed — skipping to Gemini fallback (silenced until it changes)');
      this._omniRouteLastLoggedHealth = this._omniRouteHealthy;
    }
    return this._omniRouteHealthy;
  }

  // Which providers can actually serve a chat turn right now. Ollama needs no
  // key (local), so it's always considered available at this layer — a
  // connection failure surfaces as a normal request error instead.
  keyFor(provider) {
    if (provider === 'anthropic') return this.anthropicApiKey;
    if (provider === 'gemini') return this.geminiApiKey;
    if (provider === 'omniroute') return this.omniRouteApiKey;
    if (provider === 'ollama') return null;
    return this.apiKey;
  }

  // messages: [{role:'user'|'assistant'|'tool', content, ...}, ...] (no system role in here)
  // systemPrompt: string
  // tools: OpenAI-style tool defs (optional) — [{type:'function', function:{name, description, parameters}}]
  async stream(messages, systemPrompt, tools, opts = {}) {
    const { onToken, onToolStart, onToolDone, onDone, onError, onFallback, onQuota, onWait, model, fallbackModel, fallbackProvider, fallbackChain, toolExecutor } = opts;
    // ── 2026-08-18: REPAIR THE CONVERSATION BEFORE SENDING ──────────────────
    // Found live: DATA/chat_transcript.json ended with THREE consecutive
    // `user` turns and no assistant replies — each a CSV auto-debrief that
    // got no answer. Once one turn fails and leaves an orphan user message in
    // history, the conversation no longer alternates, and every provider here
    // (Gemini and Anthropic both) rejects that outright. So a single transient
    // failure permanently poisons the chat: every later message fails too, and
    // it presents to Anoop as "connection may have dropped" over and over,
    // including right after a fix that had nothing to do with it. Repairing
    // here — the one chokepoint all nine agent call sites share — means no
    // caller can send a malformed conversation, and an already-poisoned
    // history heals itself on the next message instead of needing a wipe.
    {
      const before = Array.isArray(messages) ? messages.length : 0;
      messages = sanitizeConversation(messages);
      if (before !== messages.length) {
        console.warn(`[groq-agent] conversation repaired before send: ${before} turns -> ${messages.length} (blank/consecutive same-role turns merged or dropped). A prior turn almost certainly failed and left an orphan message.`);
      }
    }
    // 2026-08-18: the chat path had NO logging whatsoever — when a turn hung
    // or failed, the server log showed nothing at all, so "connection may have
    // dropped" could not be diagnosed after the fact. One line per turn.
    const _turnStart = Date.now();
    const _turnLabel = `${messages.length} turns, ${(tools || []).length} tools`;
    console.log(`[groq-agent] turn start — ${_turnLabel}`);
    const VALID_PROVIDERS = ['anthropic', 'groq', 'gemini', 'ollama', 'omniroute'];
    const startProvider = VALID_PROVIDERS.includes(opts.provider) ? opts.provider : 'groq';
    const DEFAULT_MODEL = { groq: GROQ_MODEL, gemini: GEMINI_MODEL, ollama: 'llama3.1:8b', omniroute: OMNIROUTE_MODEL };

    const missingKey = (p) => p !== 'ollama' && !this.keyFor(p);

    // ── Model chain ────────────────────────────────────────────────────────────
    // 2026-07-25 (second pass, after a live 404): the previous design had ONE
    // fallback step and only advanced on 429/413. A retired model ID returns
    // 404 ("This model models/gemini-2.5-flash-lite is no longer available to
    // new users") and hard-failed the whole turn — exactly what happened on
    // Anoop's first try with a valid key. Google retires model IDs often
    // enough that a single hardcoded ID is inherently fragile, so this is now
    // an ordered list of candidates and 404 is treated as retryable alongside
    // the capacity errors. Entries whose provider has no configured key are
    // skipped rather than attempted.
    const chain = [];
    const pushCandidate = (p, m) => {
      if (!p || !VALID_PROVIDERS.includes(p)) return;
      if (missingKey(p)) return;                      // no key → not a usable candidate
      const mm = m || DEFAULT_MODEL[p];
      if (chain.some(c => c.provider === p && c.model === mm)) return; // dedupe
      chain.push({ provider: p, model: mm });
    };
    pushCandidate(startProvider, model);
    (Array.isArray(fallbackChain) ? fallbackChain : []).forEach(c => c && pushCandidate(c.provider, c.model));
    // Legacy single-step opts still honoured so existing callers keep working.
    if (fallbackProvider) pushCandidate(fallbackProvider, fallbackModel);
    else if (fallbackModel) pushCandidate(startProvider, fallbackModel);

    if (!chain.length) {
      const label = PROVIDER_LABEL[startProvider] || startProvider;
      const where = startProvider === 'gemini' ? 'aistudio.google.com/apikey' : 'console.groq.com';
      onError && onError(`${label} API key not configured. Add a free key from ${where} in Settings.`);
      return;
    }

    let chainIdx = 0;
    let activeProvider = chain[0].provider;
    let activeModel = chain[0].model;
    // One transient-socket retry per turn total (not per round) — enough to
    // absorb a dead pooled socket without risking a retry loop.
    let transientRetried = false;
    // One per-minute-429 wait per turn total. Waiting is bounded (30s cap) and
    // only ever done once, so a genuinely exhausted model still falls through
    // to the chain on its second 429 rather than stalling forever.
    let minuteWaited = false;

    // 2026-08-03: chain exhaustion used to be a dead end — if every configured
    // model failed once, the turn just failed, even though a per-minute 429
    // often clears within a lap or two. Now it loops back to the start of the
    // chain, capped hard so a genuine multi-provider outage still fails fast
    // and visibly instead of hanging indefinitely during a live trading
    // session. MAX_LAPS=2 means the chain is tried twice total (1 extra
    // wrap); MAX_LOOP_BUDGET_MS bounds total wall-clock time regardless of
    // lap count, since per-minute waits (up to 30s each, above) could
    // otherwise stack up across laps.
    const MAX_LAPS = 2;
    const MAX_LOOP_BUDGET_MS = 60 * 1000;
    const turnStartedAt = Date.now();
    let lapCount = 1; // 1 = first pass through the chain, not yet a "lap"

    let settled = false;
    const finishError = (msg) => { if (!settled) { settled = true; console.warn(`[groq-agent] turn FAILED after ${Math.round((Date.now() - _turnStart) / 1000)}s — ${msg}`); onError && onError(msg); } };
    // 2026-08-07: onDone now also reports WHICH provider/model actually
    // produced this reply (activeProvider/activeModel reflect wherever the
    // chain/lap logic above landed by completion time) — added so the UI can
    // show "answered by: X" instead of model routing being invisible outside
    // fallback events and server console logs. Kept as a plain object (not
    // threaded through every caller as a new positional arg) so existing
    // onDone(fullText) callers that ignore the 2nd arg keep working untouched.
    const finishDone = (fullText) => { if (!settled) { settled = true; console.log(`[groq-agent] turn done in ${Math.round((Date.now() - _turnStart) / 1000)}s via ${activeProvider}/${activeModel} — ${(fullText || '').length} chars`); onDone && onDone(fullText, { provider: activeProvider, model: activeModel, label: `${PROVIDER_LABEL[activeProvider] || activeProvider}/${activeModel}` }); } };

    // 2026-07-25: was a single fixed `const` 90s timer. Now restartable, because
    // a per-minute-429 wait (up to 30s, below) plus a full retried stream can
    // legitimately exceed 90s — the timer restarts when a deliberate wait
    // begins so it only ever measures actual work, not queued waiting.
    let globalTimer = null;
    const startGlobalTimer = () => {
      if (globalTimer) clearTimeout(globalTimer);
      globalTimer = setTimeout(() => finishError(`Jessi (${PROVIDER_LABEL[activeProvider] || activeProvider}) timed out after 90s.`), 90 * 1000);
    };
    const clearGlobalTimer = () => { if (globalTimer) clearTimeout(globalTimer); };
    startGlobalTimer();

    // activeProvider/activeModel/chainIdx are closure vars (not re-derived
    // from opts per call) so a switch survives the tool-calling loop's
    // recursive runLoop() calls within one turn — once moved down the chain,
    // the rest of THIS turn stays there instead of flapping back.
    // 2026-08-06: real end-to-end cancellation. opts.signal is an
    // AbortSignal server.js creates per reqId and aborts when the client
    // sends 'cancel-request' — previously cancelChat()/cancelJessiChat() etc.
    // only cleared local UI state, so a cancelled turn kept retrying (and
    // burning API quota) in the background indefinitely. Checked before every
    // attempt (covers chain-advance and the lap loop) AND threaded into the
    // actual HTTP request below (covers an already-in-flight request).
    if (opts.signal && opts.signal.aborted) {
      clearGlobalTimer();
      finishError('Cancelled.');
      return;
    }
    const runLoop = async (msgs, accumulatedText) => {
      if (opts.signal && opts.signal.aborted) {
        clearGlobalTimer();
        finishError('Cancelled.');
        return;
      }
      const payload = {
        model: activeModel,
        stream: true,
        // 0.85 for chat (passed by server — variety in coaching phrasing was an
        // explicit Anoop complaint), default 0.7 elsewhere.
        temperature: opts.temperature || 0.7,
        // 2026-08-05: was 1536 — too low once the tool-call JSON for all 14
        // tools got large enough, so the model hit finish_reason:'length'
        // before completing a single tool call, returning empty content on
        // an otherwise-200-OK response.
        max_tokens: 4096,
        messages: normalizeMessages([{ role: 'system', content: systemPrompt }, ...msgs], activeProvider)
      };
      if (tools && tools.length) { payload.tools = tools; payload.tool_choice = 'auto'; }

      const { mod, options, body } = buildRequest(activeProvider, this.keyFor(activeProvider), payload, this.omniRouteBase);

      // BUG FIX 2026-07-25 (caught by a local 404-simulation test, not shipped
      // broken): both continuation paths below used to call `resolveReq()` and
      // THEN `await runLoop(...)` from inside the promise executor. That
      // resolved this promise — and therefore stream()'s own await chain —
      // before the continuation had actually run, so stream() reported itself
      // finished while a retry/tool-call round was still in flight. In the
      // 404-fallback case the retry request was never issued at all: the turn
      // produced no text and no error, just silence.
      // Fix: the response handler now only RECORDS what to do next, and the
      // recursion happens after the promise settles, so every nested round is
      // properly awaited by the caller.
      let next = null; // { msgs, text } — set to continue, left null to stop

      // 2026-07-25: Node 22's global HTTP agent pools keep-alive sockets, so a
      // socket left over from an earlier turn can be closed server-side and
      // then reused, throwing "socket hang up"/ECONNRESET on a request that was
      // never actually attempted. In a long-running desktop app (this thing
      // stays open all session) that shows up as random dead replies. These are
      // transient by definition — retry the SAME model once, immediately,
      // before treating it as a real failure. Deliberately NOT a chain advance:
      // nothing is wrong with the model, only with one dead socket. DNS/refused
      // errors are excluded — those are genuine and shouldn't be masked.
      const TRANSIENT = /socket hang up|ECONNRESET|EPIPE|ETIMEDOUT/i;
      const handleSocketError = (e, resolveReq) => {
        // User cancelled (opts.signal aborted mid-request) — not a real
        // failure, don't retry, don't log it as one.
        if (e && e.name === 'AbortError') {
          clearGlobalTimer();
          finishError('Cancelled.');
          resolveReq();
          return;
        }
        const msg = (e && e.message) || String(e) || 'connection failed';
        if (TRANSIENT.test(msg) && !transientRetried) {
          transientRetried = true;
          next = { msgs, text: accumulatedText };
          resolveReq();
          return;
        }
        // 2026-08-07: a non-transient CONNECTION-level failure (refused, DNS,
        // TLS, "AggregateError" from Node's dual-stack ECONNREFUSED) used to
        // be immediately fatal — only HTTP-status errors (429/413/etc, below)
        // advanced the fallback chain. That's a real gap for a provider like
        // a local OmniRoute instance that can be fully down (process crashed,
        // never started): the whole turn would just fail instead of falling
        // through to the next configured provider. Advance the chain here too
        // so "unreachable" is treated the same as "errored" for fail-open
        // purposes. Deliberately NOT lap-looped (unlike the HTTP-status path)
        // — a hard-down connection should fail fast once the chain is
        // exhausted, not retry a dead endpoint repeatedly during a live
        // session.
        const hasNext = chainIdx + 1 < chain.length;
        if (hasNext) {
          const fromLabel = `${PROVIDER_LABEL[activeProvider] || activeProvider}/${activeModel}`;
          chainIdx += 1;
          activeProvider = chain[chainIdx].provider;
          activeModel = chain[chainIdx].model;
          const toLabel = `${PROVIDER_LABEL[activeProvider] || activeProvider}/${activeModel}`;
          onFallback && onFallback(fromLabel, toLabel, msg);
          next = { msgs, text: accumulatedText };
          resolveReq();
          return;
        }
        clearGlobalTimer();
        finishError(msg);
        resolveReq();
      };

      await new Promise((resolveReq) => {
        const req = mod.request(opts.signal ? { ...options, signal: opts.signal } : options, (res) => {
          if (res.statusCode !== 200) {
            let errBuf = '';
            res.on('data', (c) => { errBuf += c; });
            res.on('end', async () => {
              let detail = errBuf;
              try { detail = JSON.parse(errBuf).error.message; } catch {}
              // 2026-07-23: 413 ("Request too large" — a single turn's
              // accumulated tool-call context blew past the model's TPM cap,
              // e.g. 6616 tokens vs 8B's 6000 TPM) is a real capacity error
              // the same fallback should cover, not just 429 (daily budget
              // exhausted). Both mean "this model can't take this request
              // right now" — the fallback model has a different TPM ceiling
              // (8K vs 6K) so the identical request can genuinely fit there.
              // Retryable statuses — advance one step down the model chain:
              //   429 rate/quota exhausted for this model
              //   413 request too large for this model's TPM ceiling
              //   404 model ID retired / not available to this account
              //   400 some providers report an unknown model as 400, not 404
              // All four mean "this specific endpoint can't serve this request",
              // and the next candidate is a different model and/or vendor with
              // its own quota and its own availability — so the identical
              // request genuinely can succeed there.
              // 2026-07-25 (fourth pass — live: all three Gemini models
              // "hit daily limit" within minutes of first use, which was
              // actually the 10-15 RPM per-MINUTE cap, not the 1,500/day):
              // a per-minute 429 is a "wait a few seconds" problem, and
              // advancing the chain on it needlessly abandons the best model
              // for the rest of the turn — exactly the inconsistency Anoop
              // complained about. So: if the 429 body says per-minute (or
              // carries a retryDelay under a minute — Gemini returns
              // RetryInfo like "retryDelay":"22s"), wait that long (capped
              // 30s, once per turn) and retry the SAME model. Per-day 429s
              // and everything else still advance the chain.
              if (res.statusCode === 429 && !minuteWaited) {
                const delayMatch = String(detail).match(/retry(?:Delay|[ -]?in)["\s:]*([0-9.]+)\s*s/i);
                const delaySec = delayMatch ? Math.ceil(parseFloat(delayMatch[1])) : null;
                const minuteScale = /per[ -]?minute|PerMinute|\bRPM\b|\bTPM\b|tokens per minute|requests per minute/i.test(String(detail))
                  || (delaySec != null && delaySec <= 60);
                if (minuteScale) {
                  minuteWaited = true;
                  const waitSec = Math.min(delaySec || 15, 30);
                  onWait && onWait(activeModel, waitSec, detail);
                  // AUDIT H2 (2026-08-12): this wait used to ignore opts.signal
                  // entirely, so pressing cancel during a rate-limit wait did
                  // nothing for up to 30 seconds — the worst possible moment to
                  // be unresponsive, since a 429 wait is exactly when a trader
                  // gives up and clicks away. Now the timer races the abort.
                  await new Promise((r) => {
                    const t = setTimeout(done, waitSec * 1000);
                    function done() {
                      clearTimeout(t);
                      if (opts.signal) opts.signal.removeEventListener('abort', done);
                      r();
                    }
                    if (opts.signal) {
                      if (opts.signal.aborted) return done();
                      opts.signal.addEventListener('abort', done, { once: true });
                    }
                  });
                  if (opts.signal && opts.signal.aborted) { resolveReq(); return; }
                  startGlobalTimer(); // timer measures work, not deliberate waiting
                  next = { msgs, text: accumulatedText };
                  resolveReq();
                  return;
                }
              }
              const hasNext = chainIdx + 1 < chain.length;
              if (RETRYABLE_STATUSES.includes(res.statusCode) && hasNext) {
                const fromLabel = `${PROVIDER_LABEL[activeProvider] || activeProvider}/${activeModel}`;
                chainIdx += 1;
                activeProvider = chain[chainIdx].provider;
                activeModel = chain[chainIdx].model;
                const toLabel = `${PROVIDER_LABEL[activeProvider] || activeProvider}/${activeModel}`;
                onFallback && onFallback(fromLabel, toLabel, detail);
                next = { msgs, text: accumulatedText };
                resolveReq();
                return;
              }
              // Chain exhausted. Loop back to the top instead of dead-ending —
              // a per-minute 429 or a transient provider hiccup often clears
              // within a lap or two — but capped hard on both lap count and
              // total elapsed time so a genuine multi-provider outage still
              // fails fast and visibly instead of hanging during a live
              // session. Both caps checked together: whichever is hit first
              // stops the loop.
              const canLoopAgain = shouldLoopChain({
                statusCode: res.statusCode,
                chainLength: chain.length,
                lapCount,
                maxLaps: MAX_LAPS,
                elapsedMs: Date.now() - turnStartedAt,
                budgetMs: MAX_LOOP_BUDGET_MS
              });
              if (canLoopAgain) {
                const fromLabel = `${PROVIDER_LABEL[activeProvider] || activeProvider}/${activeModel}`;
                lapCount += 1;
                chainIdx = 0;
                activeProvider = chain[0].provider;
                activeModel = chain[0].model;
                minuteWaited = false; // fresh lap gets its own one-time per-minute wait allowance
                console.log(`[groq-agent] fallback chain exhausted, restarting lap ${lapCount}/${MAX_LAPS} (${Math.round((Date.now() - turnStartedAt) / 1000)}s elapsed) — last error: ${detail}`);
                onFallback && onFallback(fromLabel, `${PROVIDER_LABEL[activeProvider] || activeProvider}/${activeModel}`,
                  `restarting model chain (lap ${lapCount}/${MAX_LAPS}) — ${detail}`);
                next = { msgs, text: accumulatedText };
                resolveReq();
                return;
              }
              clearGlobalTimer();
              if (RETRYABLE_STATUSES.includes(res.statusCode) && !hasNext && chain.length > 1) {
                const why = loopGiveUpReason({ lapCount, maxLaps: MAX_LAPS });
                console.log(`[groq-agent] giving up after ${lapCount} lap(s), ${why} — last error: ${detail}`);
              }
              // Exhausting the chain (and any lap budget) is worth naming
              // explicitly — otherwise the surfaced error looks like a
              // single-model failure when in fact every configured candidate
              // was tried, potentially across multiple laps.
              const exhausted = RETRYABLE_STATUSES.includes(res.statusCode) && !hasNext && chain.length > 1
                ? ` (all ${chain.length} configured models tried, ${lapCount} lap${lapCount > 1 ? 's' : ''})` : '';
              finishError(`${PROVIDER_LABEL[activeProvider] || activeProvider} API error (${res.statusCode})${exhausted}: ${detail}`);
              resolveReq();
            });
            return;
          }

          // 2026-07-23: Groq returns live rate-limit headers on every
          // response (not just errors) — x-ratelimit-remaining-tokens is TPM
          // remaining, x-ratelimit-remaining-requests is RPD remaining (see
          // console.groq.com/docs/rate-limits). Surfacing this lets the app
          // warn BEFORE a 413/429 happens instead of only after. Groq's
          // headers don't expose TPD (daily token) remaining directly — only
          // TPM + RPD — so this can't show "today's budget" the way the
          // error messages sometimes do, only "this minute" and "today's
          // request count".
          if (onQuota && res.headers) {
            const h = res.headers;
            const num = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
            const limitTokens = num(h['x-ratelimit-limit-tokens']);
            const remainingTokens = num(h['x-ratelimit-remaining-tokens']);
            const limitRequests = num(h['x-ratelimit-limit-requests']);
            const remainingRequests = num(h['x-ratelimit-remaining-requests']);
            if (limitTokens != null || limitRequests != null) {
              onQuota(activeModel, { limitTokens, remainingTokens, limitRequests, remainingRequests });
            }
          }

          let buffer = '';
          let fullText = accumulatedText || '';
          let finishReason = null;
          let lastUsage = null;   // token usage from the stream — see logCall below
          // 2026-08-12 (task #8): wall-clock latency for THIS provider attempt.
          // Declared per-attempt, not per-request, so a fallback hop is timed
          // separately from the primary that failed before it — otherwise the
          // slow provider's cost would be blamed on whoever eventually answered.
          const callStartedAt = Date.now();
          // Anthropic addresses content blocks by its own index; OpenAI
          // addresses tool calls by a separate counter. This carries the
          // mapping across events for one request. Unused by other providers.
          const anthropicState = {};
          // Tool calls accumulate by index (Groq/OpenAI stream them incrementally,
          // splitting the JSON arguments string across many delta chunks).
          const toolCallsByIndex = {};

          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const payloadStr = t.slice(5).trim();
              if (payloadStr === '[DONE]') continue;
              let parsed;
              try { parsed = JSON.parse(payloadStr); } catch { continue; }
              // Anthropic's native stream emits its own event vocabulary
              // (message_start / content_block_delta / message_delta / ...).
              // Translate each event into zero or more OpenAI-shaped chunks so
              // everything below this line — including the tool loop — is
              // provider-agnostic and has exactly one implementation.
              const chunks = activeProvider === 'anthropic'
                ? anthropicNative.translateEvent(parsed, anthropicState)
                : [parsed];
              for (const json of chunks) {
              const choice = json.choices && json.choices[0];
              if (!choice) continue;
              if (choice.finish_reason) finishReason = choice.finish_reason;
              if (json.usage) lastUsage = json.usage;
              const delta = choice.delta || {};
              if (delta.content) { fullText += delta.content; onToken && onToken(delta.content); }
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  // AUDIT H1 (2026-08-12): tc.index can be undefined and tc.id
                  // can be null on some providers' streams. Both used to be
                  // stored as-is, so the follow-up request carried
                  // tool_call_id: null — which providers reject, killing the
                  // turn AFTER the tool already ran. Synthesise stable
                  // substitutes instead: a missing index appends rather than
                  // colliding on the key `undefined`, and a missing id gets a
                  // deterministic one so the tool_result can still be matched.
                  const idx = (typeof tc.index === 'number' && tc.index >= 0)
                    ? tc.index
                    : Object.keys(toolCallsByIndex).length;
                  if (!toolCallsByIndex[idx]) {
                    toolCallsByIndex[idx] = { id: null, name: null, args: '' };
                  }
                  if (tc.id) toolCallsByIndex[idx].id = tc.id;
                  if (!toolCallsByIndex[idx].id) toolCallsByIndex[idx].id = `call_${callStartedAt}_${idx}`;
                  if (tc.function && tc.function.name) toolCallsByIndex[idx].name = tc.function.name;
                  if (tc.function && tc.function.arguments) toolCallsByIndex[idx].args += tc.function.arguments;
                }
              }
              }
            }
          });

          res.on('end', async () => {
            // ── 2026-08-11: TOKEN LOGGING FOR EVERY PROVIDER ──────────────
            // call-logger was only ever wired into claude-agent.js. When all
            // nine call sites moved here, token/cost tracking silently died —
            // DATA/token-usage.jsonl stopped being written at all. Logged here
            // so `node token-usage-report.js` reflects REAL usage again.
            // Field mapping: the OpenAI-compatible shape (Anthropic compat,
            // Gemini, Groq, OmniRoute) reports prompt_tokens/completion_tokens;
            // call-logger and token-audit.js both expect Anthropic's native
            // input_tokens/output_tokens, so translate here rather than
            // teaching every consumer two vocabularies.
            try {
              if (lastUsage) {
                callLogger.logCall({
                  mode: activeProvider + '/' + activeModel,
                  usage: {
                    input_tokens: lastUsage.input_tokens != null ? lastUsage.input_tokens : lastUsage.prompt_tokens,
                    output_tokens: lastUsage.output_tokens != null ? lastUsage.output_tokens : lastUsage.completion_tokens,
                    // The OpenAI-compat layer does NOT report cache hits (it
                    // does not support prompt caching at all), so these stay
                    // null on this path by design, not by omission.
                    cache_creation_input_tokens: lastUsage.cache_creation_input_tokens || null,
                    cache_read_input_tokens: lastUsage.cache_read_input_tokens || null
                  },
                  stopReason: finishReason,
                  toolCallCount: Object.keys(toolCallsByIndex).length,
                  latencyMs: Date.now() - callStartedAt,
                  provider: activeProvider,
                  model: activeModel
                });
              }
            } catch (e) {}

            const toolCalls = Object.values(toolCallsByIndex).filter(tc => tc.name);

            // BUG FIX 2026-07-25 (live: "hello" produced an empty grey bubble,
            // no text and no error): this used to require
            // `finishReason === 'tool_calls'`. Groq sets that; Gemini's
            // OpenAI-compat layer does NOT reliably — it can stream tool_calls
            // while reporting finish_reason 'stop' (or omitting it). The tool
            // calls were then silently DISCARDED and finishDone('') fired with
            // an empty string, so the UI drew an empty bubble and never fell
            // back to the local answer. The PRESENCE of tool calls is the
            // authoritative signal, not the provider's finish_reason label.
            if (toolCalls.length) {
              const assistantMsg = {
                role: 'assistant',
                content: fullText || null,
                tool_calls: toolCalls.map(tc => ({
                  id: tc.id, type: 'function',
                  function: { name: tc.name, arguments: tc.args || '{}' }
                }))
              };
              const toolResultMsgs = [];
              for (const tc of toolCalls) {
                let resultText;
                if (BLOCKED_TOOLS.has(tc.name)) {
                  resultText = `Refused: "${tc.name}" is not permitted for Jessi (trade-execution / live-symbol-switch tools are hard-blocked).`;
                  onToolDone && onToolDone(tc.name, tc.id, false, resultText);
                } else {
                  let args = {};
                  try { args = JSON.parse(tc.args || '{}'); } catch {}
                  onToolStart && onToolStart(tc.name, tc.id);
                  try {
                    // toolExecutor (when provided) owns routing — it can handle
                    // app-data/app-action tools itself and fall back to the TV
                    // MCP bridge for chart tools. Without it, default to the
                    // bridge (original behaviour).
                    if (toolExecutor) {
                      resultText = await toolExecutor(tc.name, args);
                    } else {
                      const raw = await mcpBridge.callTool(tc.name, args);
                      resultText = (raw && raw.content) ? raw.content.map(c => c.text || '').join('\n') : JSON.stringify(raw);
                    }
                    onToolDone && onToolDone(tc.name, tc.id, true, resultText);
                  } catch (e) {
                    resultText = `Error: ${e.message}`;
                    onToolDone && onToolDone(tc.name, tc.id, false, resultText);
                  }
                }
                toolResultMsgs.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
              }
              next = { msgs: [...msgs, assistantMsg, ...toolResultMsgs], text: fullText };
              resolveReq();
            } else if (!String(fullText || '').trim()) {
              // Stream closed cleanly but produced NOTHING — no text, no tool
              // calls. Common cause: finish_reason 'length' means the output
              // hit max_tokens before completing any content or tool call.
              // 2026-08-05 FIX: try the next model in the chain before giving
              // up — a smaller/different model may succeed where this one
              // truncated. Only hard-error if the chain is exhausted.
              const hasNext = chainIdx + 1 < chain.length;
              if (hasNext) {
                const fromLabel = `${PROVIDER_LABEL[activeProvider] || activeProvider}/${activeModel}`;
                chainIdx += 1;
                activeProvider = chain[chainIdx].provider;
                activeModel = chain[chainIdx].model;
                const toLabel = `${PROVIDER_LABEL[activeProvider] || activeProvider}/${activeModel}`;
                onFallback && onFallback(fromLabel, toLabel, `empty reply (finish_reason: ${finishReason || 'unknown'})`);
                next = { msgs, text: accumulatedText };
                resolveReq();
              } else {
                clearGlobalTimer();
                finishError(`${PROVIDER_LABEL[activeProvider] || activeProvider}/${activeModel} returned an empty reply${finishReason ? ` (finish_reason: ${finishReason})` : ''}.`);
                resolveReq();
              }
            } else {
              clearGlobalTimer();
              finishDone(fullText);
              resolveReq();
            }
          });
          res.on('error', (e) => handleSocketError(e, resolveReq));
        });
        req.on('error', (e) => handleSocketError(e, resolveReq));
        req.write(body);
        req.end();
      });

      // Continuation runs AFTER the promise above settles — see the BUG FIX
      // note near the top of this function for why it can't be inline.
      if (next) {
        const { msgs: nextMsgs, text: nextText } = next;
        next = null;
        await runLoop(nextMsgs, nextText);
      }
    };

    try {
      await runLoop(messages, '');
    } catch (e) {
      clearGlobalTimer();
      finishError(e.message);
    }
  }

  // ── Voice mode: STT (Whisper) + TTS (Orpheus) ──────────────────────────────
  // Added 2026-07-23 for the voice-in/voice-out mode next to the Refresh
  // button. Deliberately using Groq for BOTH ends — same API key already in
  // Settings, no second vendor to auth/manage. Checked apilayer.com's
  // marketplace first: nothing there beats Groq's native Whisper + Orpheus
  // pairing for this. KNOWN GAP: Orpheus only ships English + Arabic (Saudi)
  // voices as of this writing — no Hindi/Indian-accented voice exists on
  // Groq. Defaulting to "autumn" (closest neutral female English voice).
  // If the accent gap actually matters once Anoop hears it, swapping to a
  // vendor with en-IN voices (Azure, Google Cloud TTS, ElevenLabs) is a
  // contained change — only synthesizeSpeech() below needs to move, nothing
  // upstream of it.
  async transcribeAudio(audioBuffer, mimeType) {
    if (!this.apiKey) throw new Error('Groq API key not configured.');
    const ext = (mimeType || '').includes('mp4') ? 'mp4' : (mimeType || '').includes('ogg') ? 'ogg' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/webm' }), `voice.${ext}`);
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'json');

    // 2026-07-23 FIX: this call had no timeout — a stalled connection to Groq
    // hung the whole voice turn forever with no error ever surfacing (found
    // live: caption stuck on "Sending to Jesse…" indefinitely). AbortController
    // guarantees a terminal state within 20s either way.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let res;
    try {
      res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Groq transcription timed out after 20s — network stalled.');
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = await res.text().catch(() => '');
      try { detail = JSON.parse(detail).error.message; } catch {}
      throw new Error(`Groq transcription error (${res.status}): ${detail}`);
    }
    const data = await res.json();
    return (data.text || '').trim();
  }

  // OmniRoute/Speechmatics STT (2026-08-07) — same shape as transcribeAudio
  // above (multipart, OpenAI-compatible /v1/audio/transcriptions), just
  // pointed at the local OmniRoute instance with the speechmatics/enhanced
  // model. Model id MUST be the full "provider/model" form — OmniRoute
  // rejects the short "sm/enhanced" alias on this endpoint with a 400
  // ("Use format: provider/model"), confirmed by hand before wiring this in.
  // Caller (server.js) is responsible for falling back to transcribeAudio()
  // above on any failure — this method does not fall back internally.
  async transcribeAudioOmniRoute(audioBuffer, mimeType) {
    if (!this.omniRouteApiKey) throw new Error('OmniRoute API key not configured.');
    const ext = (mimeType || '').includes('mp4') ? 'mp4' : (mimeType || '').includes('ogg') ? 'ogg' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/webm' }), `voice.${ext}`);
    form.append('model', 'speechmatics/enhanced');
    form.append('response_format', 'json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const base = this.omniRouteBase || { host: '127.0.0.1', port: 20128 };
    let res;
    try {
      res = await fetch(`http://${base.host}:${base.port}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.omniRouteApiKey}` },
        body: form,
        signal: controller.signal
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('OmniRoute transcription timed out after 20s — network stalled.');
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = await res.text().catch(() => '');
      try { detail = JSON.parse(detail).error.message; } catch {}
      throw new Error(`OmniRoute transcription error (${res.status}): ${detail}`);
    }
    const data = await res.json();
    return (data.text || '').trim();
  }

  // Splits text into <=180-char chunks on sentence boundaries (Orpheus caps
  // input at 200 chars/request) so a full multi-sentence reply can still be
  // spoken as one continuous-sounding clip sequence on the client.
  splitForTTS(text) {
    const sentences = String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*\s*/g) || [String(text || '')];
    const chunks = [];
    let cur = '';
    for (const s of sentences) {
      if ((cur + s).length > 180) {
        if (cur.trim()) chunks.push(cur.trim());
        cur = s.length > 180 ? s.slice(0, 180) : s; // hard-truncate a single runaway sentence rather than error
      } else {
        cur += s;
      }
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks.filter(Boolean);
  }

  async synthesizeSpeech(text, voice = 'autumn') {
    if (!this.apiKey) throw new Error('Groq API key not configured.');
    const chunks = this.splitForTTS(text);
    const clips = [];
    for (const chunk of chunks) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let res;
      try {
        res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'canopylabs/orpheus-v1-english',
            voice,
            input: chunk,
            response_format: 'wav'
          }),
          signal: controller.signal
        });
      } catch (e) {
        if (e.name === 'AbortError') throw new Error('Groq TTS timed out after 20s — network stalled.');
        throw e;
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        let detail = await res.text().catch(() => '');
        try { detail = JSON.parse(detail).error.message; } catch {}
        throw new Error(`Groq TTS error (${res.status}): ${detail}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      clips.push(buf.toString('base64'));
    }
    return clips; // array of base64 WAV clips, play sequentially client-side
  }
}

module.exports = new GroqAgent();
// Internal-only accessor for unit tests (app/test/fallback-loop.test.js) —
// namespaced under _debug rather than exported directly, same pattern as
// claude-agent.js's _debug, so nothing else in the app depends on it.
module.exports._debug = { shouldLoopChain, loopGiveUpReason, RETRYABLE_STATUSES, sanitizeConversation, isBlankContent };
