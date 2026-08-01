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

// Build the HTTP(S) request for whichever provider. Returns the transport
// module too so the caller uses http for Ollama, https for Groq/Gemini.
function buildRequest(provider, apiKey, payload) {
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

const PROVIDER_LABEL = { groq: 'Groq', gemini: 'Gemini', ollama: 'Ollama (local)' };

class GroqAgent {
  constructor() {
    this.apiKey = null;        // Groq (also used for Whisper STT / Orpheus TTS below)
    this.geminiApiKey = null;  // Google Gemini — separate vendor, separate quota
  }

  init(apiKey) {
    this.apiKey = (apiKey || '').trim() || null;
  }

  initGemini(apiKey) {
    this.geminiApiKey = (apiKey || '').trim() || null;
  }

  // Groq-specific readiness — voice (Whisper/Orpheus) is Groq-only, so this
  // deliberately still means "Groq usable", not "any provider usable".
  isReady() { return !!this.apiKey; }

  isGeminiReady() { return !!this.geminiApiKey; }

  // Which providers can actually serve a chat turn right now. Ollama needs no
  // key (local), so it's always considered available at this layer — a
  // connection failure surfaces as a normal request error instead.
  keyFor(provider) {
    if (provider === 'gemini') return this.geminiApiKey;
    if (provider === 'ollama') return null;
    return this.apiKey;
  }

  // messages: [{role:'user'|'assistant'|'tool', content, ...}, ...] (no system role in here)
  // systemPrompt: string
  // tools: OpenAI-style tool defs (optional) — [{type:'function', function:{name, description, parameters}}]
  async stream(messages, systemPrompt, tools, opts = {}) {
    const { onToken, onToolStart, onToolDone, onDone, onError, onFallback, onQuota, onWait, model, fallbackModel, fallbackProvider, fallbackChain, toolExecutor } = opts;
    const VALID_PROVIDERS = ['groq', 'gemini', 'ollama'];
    const startProvider = VALID_PROVIDERS.includes(opts.provider) ? opts.provider : 'groq';
    const DEFAULT_MODEL = { groq: GROQ_MODEL, gemini: GEMINI_MODEL, ollama: 'llama3.1:8b' };

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

    let settled = false;
    const finishError = (msg) => { if (!settled) { settled = true; onError && onError(msg); } };
    const finishDone = (fullText) => { if (!settled) { settled = true; onDone && onDone(fullText); } };

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
    const runLoop = async (msgs, accumulatedText) => {
      const payload = {
        model: activeModel,
        stream: true,
        // 0.85 for chat (passed by server — variety in coaching phrasing was an
        // explicit Anoop complaint), default 0.7 elsewhere.
        temperature: opts.temperature || 0.7,
        max_tokens: 1536,
        messages: [{ role: 'system', content: systemPrompt }, ...msgs]
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
        const msg = (e && e.message) || String(e);
        if (TRANSIENT.test(msg) && !transientRetried) {
          transientRetried = true;
          next = { msgs, text: accumulatedText };
          resolveReq();
          return;
        }
        clearGlobalTimer();
        finishError(msg);
        resolveReq();
      };

      await new Promise((resolveReq) => {
        const req = mod.request(options, (res) => {
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
                  await new Promise(r => setTimeout(r, waitSec * 1000));
                  startGlobalTimer(); // timer measures work, not deliberate waiting
                  next = { msgs, text: accumulatedText };
                  resolveReq();
                  return;
                }
              }
              const RETRYABLE = [429, 413, 404, 400, 500, 502, 503];
              const hasNext = chainIdx + 1 < chain.length;
              if (RETRYABLE.includes(res.statusCode) && hasNext) {
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
              clearGlobalTimer();
              // Exhausting the chain is worth naming explicitly — otherwise the
              // surfaced error looks like a single-model failure when in fact
              // every configured candidate was tried.
              const exhausted = RETRYABLE.includes(res.statusCode) && !hasNext && chain.length > 1
                ? ` (all ${chain.length} configured models tried)` : '';
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
              let json;
              try { json = JSON.parse(payloadStr); } catch { continue; }
              const choice = json.choices && json.choices[0];
              if (!choice) continue;
              if (choice.finish_reason) finishReason = choice.finish_reason;
              const delta = choice.delta || {};
              if (delta.content) { fullText += delta.content; onToken && onToken(delta.content); }
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index;
                  if (!toolCallsByIndex[idx]) toolCallsByIndex[idx] = { id: null, name: null, args: '' };
                  if (tc.id) toolCallsByIndex[idx].id = tc.id;
                  if (tc.function && tc.function.name) toolCallsByIndex[idx].name = tc.function.name;
                  if (tc.function && tc.function.arguments) toolCallsByIndex[idx].args += tc.function.arguments;
                }
              }
            }
          });

          res.on('end', async () => {
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
              // calls. Previously this called finishDone('') and the UI drew a
              // permanently empty bubble with no explanation and no fallback.
              // Treat it as an error instead so the caller's offline/local path
              // takes over and Jessi always says something.
              clearGlobalTimer();
              finishError(`${PROVIDER_LABEL[activeProvider] || activeProvider}/${activeModel} returned an empty reply${finishReason ? ` (finish_reason: ${finishReason})` : ''}.`);
              resolveReq();
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
