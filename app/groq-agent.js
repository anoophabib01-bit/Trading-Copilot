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

// 2026-09-02 (Landing 2): the Groq and local-Ollama constants that stood here
// are gone with their providers. Kept as a note because the reason matters:
// Groq's free tier capped tokens PER MINUTE at 6,000-8,000, and a full Jessi
// turn genuinely did not fit — that produced live 413 "Request too large" and
// 429 "TPM Limit 8000" failures, and it is why the app grew a multi-provider
// chain in the first place. A single paid provider removes the cause rather
// than routing around it.

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

// 2026-09-02 (Landing 2): OmniRoute is removed. It routed some models through
// pooled/shared "free" CLI-subscription accounts — an accepted account-ban risk
// while it was buying reasoning capability the free tier lacked. A first-party
// paid key makes that trade pointless, and Anoop had already disabled it via
// its own kill switch before this change.

// DeepSeek — first-party, paid, OpenAI-compatible (2026-09-02, "Landing 1" of
// the single-provider consolidation Anoop asked for). Direct to the vendor,
// NOT through OmniRoute's pooled-account layer above — that route shares
// "free" CLI-subscription accounts and carries a ban risk; this one is his own
// prepaid key and answers to nobody else's quota.
//
// WHY THIS PROVIDER, AND WHY IT REPLACES FOUR OTHERS
// The app had grown five AI providers (Anthropic primary, Gemini x3 fallback
// models, Groq, OmniRoute, local Ollama) plus four key fields in Settings with
// non-obvious precedence. Anoop's words on 2026-09-02: "it is creating a lot of
// confusion and i want to avoid confusion." DeepSeek covers every capability
// this app actually uses — tool calling, streaming, 1M context, image input,
// automatic prefix caching — so the other four stop being necessary rather
// than merely being switched off.
//
// MODEL: Anoop's explicit pick, asked and confirmed. The vision-exp variant is
// used for EVERYTHING, not just image turns, because DeepSeek's own pricing
// table lists it as identical to plain v4-flash on tool calling, JSON output,
// context length AND price — its only documented limitation is FIM completion,
// which this app never calls. So there is no cost or capability penalty for
// running one model everywhere, and one model everywhere is the entire point.
//
// THE "exp" TAG IS WHY THE LADDER BELOW IT EXISTS (see provider-chain.js).
// This app has twice been broken mid-session by a model ID being retired with
// no notice — Groq deprecated the Llama IDs on 2026-06-17, and Google closed
// the Gemini 2.5 line to new accounts (a live 404, recorded above). An
// experimental ID is exactly the kind of thing that disappears that way, so
// plain deepseek-v4-flash sits directly beneath it as the stable sibling.
//
// NO cache_control HERE, DELIBERATELY: that field is Anthropic-only and would
// be a foreign key on an OpenAI-shaped request. DeepSeek caches automatically
// by hashing the request prefix, no markers needed. Worth knowing: that also
// means caching only pays off when the PREFIX is stable, and this app's system
// prompt currently carries live P&L and timestamps inside it — so cache hits
// will be rare until that is restructured. Deliberately NOT fixed in the same
// change as the provider swap (it is a prompt-structure edit, which this
// repo's CLAUDE.md requires be smoke-tested on its own).
const DEEPSEEK_MODEL = 'deepseek-v4-flash-vision-exp';
const DEEPSEEK_HOST = 'api.deepseek.com';
const DEEPSEEK_PATH = '/chat/completions';

// Normalize message content for the target provider.
// The renderer constructs Anthropic-style image blocks. Those are valid for
// Anthropic's native /v1/messages, but OpenAI-compatible providers (Groq,
// Gemini, OmniRoute) expect image_url blocks instead. Convert here so the
// same client code works across the whole fallback chain.
function normalizeMessages(messages, provider) {
  if (!Array.isArray(messages)) return messages;
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
function buildRequest(provider, apiKey, payload) {
  const body = JSON.stringify(payload);
  if (provider === 'deepseek') {
    // Plain OpenAI shape, Bearer auth — no translation layer, no vendor
    // headers. That is the reason the OpenAI-compatible endpoint was chosen
    // over DeepSeek's Anthropic-compatible one: this module's SSE parser and
    // tool loop already speak this dialect, so the whole anthropic-native.js
    // translation step drops out of the hot path for every call.
    //
    // ── thinking DISABLED — found live 2026-09-02, first real Debate run ────
    // DeepSeek V4 streams a `reasoning_content` delta (a visible chain of
    // thought) alongside `content`, and those reasoning tokens are spent from
    // the SAME max_tokens budget. On a heavy prompt the model can burn the
    // entire ceiling thinking and emit ZERO content — a 200 OK carrying an
    // empty reply, which this module treats as a dead model and fails over.
    //
    // That is exactly what happened to the Power-of-3 agent on Anoop's first
    // live Debate: vision-exp spent 15,387 chars reasoning and produced
    // nothing (finish_reason 'length'), the chain dropped to
    // deepseek-v4-flash which did the same, and Gemini ended up answering as
    // PO3 while Jessi, Analysis and the Judge all still said DeepSeek. Only
    // the per-card provider label made it visible at all.
    //
    // Measured against the live API before choosing this fix, same prompt,
    // max_tokens 4096:
    //   thinking disabled  ->     0 reasoning,  6657 content, finish 'stop'
    //   reasoning_effort=low  -> 10451 reasoning, 4648 content, finish 'length'
    //   reasoning_effort=minimal -> 15307 reasoning, 0 content, finish 'length'
    // Only disabling it actually resolves the truncation; the effort knobs
    // reduce thinking without stopping it eating the budget.
    //
    // Disabling costs nothing real here: this app DISCARDS reasoning_content
    // entirely — no parser reads it, no UI shows it — so every reasoning token
    // was billed as output and thrown away, while tripling latency (36s vs
    // ~10s) in a live session where Anoop is waiting on a verdict.
    // To re-enable deliberately, delete this field and raise max_tokens to
    // ~16000 (verified working); do NOT re-enable without doing both.
    //
    // This is the SAME BUG CLASS as the 2026-08-05 fix recorded at max_tokens
    // above — "too low once the tool-call JSON got large enough ... returning
    // empty content on an otherwise-200-OK response". Same failure, new cause.
    const dsPayload = { ...payload, thinking: { type: 'disabled' } };
    // A ceiling, not a charge — output is billed per token actually generated,
    // so headroom above the observed ~1.7K-token answer is free insurance
    // against a long Debate reply truncating mid-sentence.
    if (!dsPayload.max_tokens || dsPayload.max_tokens < 8192) dsPayload.max_tokens = 8192;
    const dsBody = JSON.stringify(dsPayload);
    return {
      mod: https,
      options: {
        hostname: DEEPSEEK_HOST, path: DEEPSEEK_PATH, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(dsBody) }
      },
      body: dsBody
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
  // 2026-09-02 (Landing 2): this used to fall through to Groq for ANY
  // unrecognised provider. That silent default is the same class of bug as the
  // registry drift found earlier the same day — a typo'd or retired provider
  // name would quietly get answered by a vendor nobody chose. With two
  // providers left there is no sensible default, so an unknown one is a
  // programming error and says so.
  throw new Error(`buildRequest: unknown provider "${provider}" — expected 'deepseek' or 'gemini'`);
}

const PROVIDER_LABEL = { deepseek: 'DeepSeek', gemini: 'Gemini' };

// Hoisted to module scope 2026-09-02 so a test can actually read them.
// These two lived inside stream() as locals, which meant the only way to check
// them was to duplicate the list in the test file — and a duplicated list
// cannot detect drift, it can only restate it. provider-chain.test.js did
// exactly that and consequently did NOT catch DeepSeek being absent here while
// present in provider-chain.js. That gap is silent by construction:
// pushCandidate() skips an unrecognised provider rather than throwing, so the
// app would have run happily with a configured DeepSeek key that never served
// one request. Exported via _debug so the test compares the REAL arrays.
const VALID_PROVIDERS = Object.freeze(['deepseek', 'gemini']);
const DEFAULT_MODEL_BY_PROVIDER = Object.freeze({ deepseek: DEEPSEEK_MODEL, gemini: GEMINI_MODEL });

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
    this.deepSeekApiKey = null; // DeepSeek — the primary brain (2026-09-02)
    this.geminiApiKey = null;   // Gemini — break-glass only, see provider-chain.js
  }

  // DeepSeek (2026-09-02) — the consolidation target. Same shape as every
  // other init here: trim, empty-string becomes null so isDeepSeekReady() and
  // primaryProviderModel() both read a whitespace-only paste as "not set"
  // rather than sending a Bearer header containing spaces.
  initDeepSeek(apiKey) {
    this.deepSeekApiKey = (apiKey || '').trim() || null;
  }

  initGemini(apiKey) {
    this.geminiApiKey = (apiKey || '').trim() || null;
  }

  isGeminiReady() { return !!this.geminiApiKey; }

  isDeepSeekReady() { return !!this.deepSeekApiKey; }

  // Which providers can actually serve a chat turn right now. Ollama needs no
  // key (local), so it's always considered available at this layer — a
  // connection failure surfaces as a normal request error instead.
  keyFor(provider) {
    if (provider === 'deepseek') return this.deepSeekApiKey;
    if (provider === 'gemini') return this.geminiApiKey;
    return null;
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
    // Module-scope registry (see the note at its definition): a provider
    // missing from VALID_PROVIDERS is skipped by pushCandidate() rather than
    // rejected, so it fails SILENTLY. Any future provider must be added there
    // AND to provider-chain.js's KNOWN_PROVIDERS.
    const startProvider = VALID_PROVIDERS.includes(opts.provider) ? opts.provider : 'deepseek';
    const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER;

    const missingKey = (p) => !this.keyFor(p);

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
      const where = startProvider === 'gemini' ? 'aistudio.google.com/apikey' : 'platform.deepseek.com';
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

      const { mod, options, body } = buildRequest(activeProvider, this.keyFor(activeProvider), payload);

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
              // 2026-09-02 (Landing 2): was a ternary translating Anthropic's
              // native SSE events into OpenAI shape via anthropic-native.js.
              // Anthropic is gone, and both remaining providers speak OpenAI
              // natively, so events pass straight through — the translation
              // layer and its per-request state object are deleted.
              const choice = parsed.choices && parsed.choices[0];
              const json = parsed;
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
}

module.exports = new GroqAgent();
// Internal-only accessor for unit tests (app/test/fallback-loop.test.js) —
// namespaced under _debug rather than exported directly, same pattern as
// claude-agent.js's _debug, so nothing else in the app depends on it.
module.exports._debug = { shouldLoopChain, loopGiveUpReason, RETRYABLE_STATUSES, sanitizeConversation, isBlankContent,
  // Exposed so provider-chain.test.js can cross-check the two registries
  // against each other instead of against a hand-copied list.
  VALID_PROVIDERS, DEFAULT_MODEL_BY_PROVIDER, PROVIDER_LABEL,
  // Exposed 2026-09-02 so the DeepSeek thinking/max_tokens guard is testable.
  // That bug (reasoning tokens eating the whole budget -> empty reply ->
  // silent failover to Gemini mid-Debate) was only caught because Anoop
  // happened to read a provider label on one card. It must not come back
  // unnoticed a second time.
  buildRequest };
