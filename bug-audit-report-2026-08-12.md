# Bug Audit Report — MNQ Co-Pilot

**Date:** 2026-08-12  
**Scope:** Full codebase (`app/` + `tradingview-mcp/`)  
**Method:** Static analysis + pattern matching + targeted sub-agent reviews  
**Status:** Report-only — no fixes applied

---

## Executive Summary

| Severity | Count | Key Risk |
|----------|-------|----------|
| **Critical** | 2 | Uncaught TypeError, pending-promise map leak |
| **High** | 9 | NaN propagation, null tool_call_ids, silent error swallowing, unvalidated inputs |
| **Medium** | 12 | Async event-handler unhandled rejections, mutable shared state, incomplete cleanup |
| **Low** | 15 | Code smells, dead code, minor validation gaps, magic strings |
| **Total** | **38** | |

**Biggest risk areas:**
1. `groq-agent.js` — provider fallback chain + streaming callback error handling
2. `chart-reads.js` — no input validation on bar data; NaN propagates silently
3. `mcp-bridge.js` — pending promise map can leak on timeout/stop
4. `server.js` + `renderer/app.js` — 100+ empty `catch (e) {}` blocks swallow errors silently

---

## 1. `app/groq-agent.js` — AI Engine / Provider Fallback

### Critical

| # | Line | Finding |
|---|------|---------|
| C1 | 248 | `parseInt(u.port, 10)` on `new URL(baseUrl).port`. When `baseUrl` has no explicit port (e.g. `http://127.0.0.1`), `u.port` is `''`, and `parseInt('', 10)` returns `NaN`. The resulting `base.port = NaN` causes the HTTP request to fail immediately. **Fix:** `port: u.port ? parseInt(u.port, 10) : 80`. |

### High

| # | Line | Finding |
|---|------|---------|
| H1 | 670, 728–730 | Tool-call delta `tc.index` may be `undefined`, and `tc.id` may be `null`. The code stores `{ id: null, name: null, args: '' }` and later emits `id: null` / `tool_call_id: null` in messages sent back to the API. OpenAI-compatible providers require `tool_call_id` to match a valid ID; `null` will cause the next API call to fail or be rejected. **Fix:** coerce missing `id`/`index` to synthetic values (`tc.id \|\| \`call_${Date.now()}_${idx}\``; `idx = tc.index ?? Object.keys(toolCallsByIndex).length`). |
| H2 | 537 | During a per-minute 429 wait (`await new Promise(r => setTimeout(r, waitSec * 1000))`), `opts.signal` is **not** observed. A user cancellation (`AbortController.abort()`) will not interrupt the wait; the agent remains blocked for up to 30s before checking the signal again. **Fix:** race the timeout against `opts.signal`. |

### Medium

| # | Line | Finding |
|---|------|---------|
| M1 | 711 | `catch (e) {}` completely swallows errors from `callLogger.logCall`. If the logger throws (malformed usage object, disk full, etc.), token/cost tracking silently dies with no indication. **Fix:** at minimum `console.error('[call-logger]', e)` or route to `onError`. |
| M2 | 741 | `JSON.parse(tc.args || '{}')` silently defaults to an empty object when the model emits malformed JSON. The tool executor then receives no arguments instead of a visible parse error, leading to confusing silent behavior. **Fix:** let the executor handle the raw string and surface parse errors to the model via the tool result. |
| M3 | 498, 680 | `res.on('end', async () => { ... })` uses `async` callbacks inside event handlers. If any `await` throws *after* `resolveReq()` has already settled the outer promise, it becomes an **unhandled promise rejection**. The code has partial try-catch coverage, but paths like `onDone`/`onToolDone`/`onFallback` callbacks can throw unchecked. |
| M4 | 748–753 | When `toolExecutor` is provided, if it returns `undefined` (no explicit return), `resultText` is `undefined`. This is then passed to `onToolDone` and stored as `content: undefined` in the tool-result message. OpenAI requires `content` to be a string; `undefined` can cause the next API call to reject. **Fix:** coerce `resultText = resultText ?? ''`. |
| M5 | 447 | `TRANSIENT` includes `ETIMEDOUT`, but `handleSocketError` is only invoked from `req.on('error')` and `res.on('error')`. Node.js TCP timeouts on `http.request` typically surface as `ECONNRESET` or `AbortError` (via AbortController), not `ETIMEDOUT` on the request object. The regex entry is likely dead code and gives a false sense of coverage. |

### Low

| # | Line | Finding |
|---|------|---------|
| L1 | 585–596 | The condition `RETRYABLE_STATUSES.includes(res.statusCode) && !hasNext && chain.length > 1` is evaluated **three times** in close proximity. Minor code smell / readability issue. |
| L2 | 248 | `} catch {}` silently swallows all `URL` parsing errors. If `baseUrl` is genuinely invalid, the code silently falls back to `127.0.0.1:20128` instead of surfacing the misconfiguration. |
| L3 | 500 | `catch {}` around `JSON.parse(errBuf)` silently swallows malformed error bodies. The raw `errBuf` is used as a fallback, which is acceptable resilience, but makes debugging API-side issues harder. |
| L4 | 830, 875 | MIME-to-extension mapping is incomplete: `audio/wav` falls through to `webm` extension (`voice.webm`), which may confuse the transcription endpoint. |
| L5 | 764 | If the model returns a truly empty reply (not `finish_reason: 'length'` but genuinely empty output), the code advances the chain. This can burn through providers on responses that are simply empty rather than truncated. |
| L6 | 378–384 | `globalTimer` is a `setTimeout` stored in a local variable. While cleanup is correct across all exit paths, there is no defensive check if `clearGlobalTimer` is called after the timer already fired. |

---

## 2. `app/provider-chain.js` — Provider Selection

### Critical

| # | Line | Finding |
|---|------|---------|
| C2 | 44 | `primaryProviderModel(cfg = {}, omniReady = false)` — the default parameter `cfg = {}` only guards against `undefined`. If `null` is passed explicitly, `cfg.apiKey` throws `TypeError: Cannot read properties of null (reading 'apiKey')`. There is no try/catch or input guard. |

### High

| # | Line | Finding |
|---|------|---------|
| H3 | 69 | `fallbackChainFor` silently coerces invalid `primary` to `'gemini'`: `(primary && primary.provider) || 'gemini'` means `null`, `undefined`, `{}`, or `{ provider: '' }` all silently resolve to `'gemini'`. This masks bugs in callers that pass a missing or malformed primary object. |
| H4 | 69 | Empty-string `provider` silently defaults to `'gemini'`. If `primary.provider` is `""` (falsy), the expression falls through to `'gemini'`. Invalid provider names are silently swallowed instead of being rejected. |

### Medium

| # | Line | Finding |
|---|------|---------|
| M6 | 24–28 | Exported `STANDARD_FALLBACK_CHAIN` is mutable. Any consumer can call `.push()`, `.splice()`, or mutate its objects, which would corrupt the fallback chain for all future callers. |
| M7 | 72–73 | `fallbackChainFor` returns shallow copies with shared object references. If a caller mutates a property on a returned entry (e.g., `chain[0].provider = 'x'`), it mutates the original object inside `STANDARD_FALLBACK_CHAIN`. |
| M8 | 70 | The `gemini-3.5-flash` prepend is documented as a fix specifically for Anthropic failures, but the code also prepends it for `omniroute` (`p === 'omniroute' || p === 'anthropic'`). If `omniroute` is a separate proxy layer, this may be an over-application of the fix. |
| M9 | 74 | `fallbackChainFor` filter may fail to exclude the primary when `primary.model` is falsy. If `primary.model` is `undefined`, `null`, or `""`, the filter condition `c.model === (primary && primary.model)` compares against a falsy value. If any chain entry coincidentally has a matching provider and a falsy model, it would be incorrectly removed. |

### Low

| # | Line | Finding |
|---|------|---------|
| L7 | Throughout | Magic strings for providers and models (`'anthropic'`, `'gemini'`, `'groq'`, `'omniroute'`) are hardcoded in multiple places. A typo in any call site would be a silent runtime bug. |
| L8 | 34, 54 | Missing JSDoc `@returns` tags on both exported functions. |
| L9 | 41, 47 | `omniReady` is documented as `boolean` but accepted as-is. Passing a non-boolean (e.g., a string) could produce confusing behavior. |

---

## 3. `app/chart-reads.js` — Deterministic Chart Math

### High

| # | Line | Finding |
|---|------|---------|
| H5 | 39, 40, 54, 56, 60, 113 | **Unvalidated bar object properties** — `bars[i].close`, `bar.high`, `bar.low`, `bar.open` are used in arithmetic without verifying they are finite numbers. If any bar has `undefined`, `null`, or a string value, the math produces `NaN` which silently propagates through `emaFromBars`, `detectDoji`, and `swingStructure`, returning seemingly valid objects containing `NaN`. |
| H6 | 106, 108 | **Unvalidated `leftRight` parameter** — `swingStructure` accepts any value for `leftRight`. A negative value makes `leftRight * 2 + 3` smaller than the required minimum, potentially passing the length guard while causing the inner loop bounds to be inverted or incorrect. A float (e.g., `1.5`) would cause the loop to iterate a non-integer number of steps, producing off-by-one pivot detection. |
| H7 | 37 | **`period` not validated as integer** — `emaFromBars` accepts any positive number for `period`. A float like `2.5` passes `period > 0`, but `bars.slice(0, period)` coerces to `2` silently, and `2 / (period + 1)` produces a different `k` than expected. This leads to an EMA computed with a mismatched period/seed length. |

### Medium

| # | Line | Finding |
|---|------|---------|
| M10 | 52, 195 | **`bodyMaxPct` and `tolerance` not validated for type or range** — If `bodyMaxPct` is negative, the condition `ratio > bodyMaxPct` is always true, so `detectDoji` returns `null` for every bar. If `tolerance` is negative, `nearestLevel` returns `null` for every input. |
| M11 | 53, 169 | **Truthiness checks instead of shape validation** — `detectDoji` checks `if (!bar)` but does not verify `bar` is an object with numeric `high`/`low`/`open`/`close`. `emaConfirmation` checks `if (!lastClosed15m)` but does not verify `.close` is a number. A `{}` or `{close: undefined}` passes the guard and produces misleading `'exactly at'` results. |
| M12 | 86–87 | **`nearestLevel` silently drops zero prices** — `Number(...)` converts `{price: 0}` to `0`, and `!(p > 0)` skips it. If a legitimate level is priced at exactly `0` (unlikely for MNQ but possible in other contexts), it is silently excluded. |
| M13 | 143 | **`alignmentVerdict` does not normalize or validate direction strings** — It checks `h === 'unclear'` exactly, but if a caller passes `'Unclear'` or `'UNCLEAR'`, it falls through to the inequality check and may produce a confusing `'NOT ALIGNED — higher Unclear vs lower ...'` instead of treating it as unknown. |
| M14 | 172–173 | **`emaConfirmation` does not validate `close` is finite** — If `lastClosed15m.close` is `NaN` or `undefined`, `close > ema9` and `close < ema9` are both `false`, so `side` becomes `'exactly at'`. The function then reports a confirmation/non-confirmation based on a NaN distance, which is misleading. |

### Low

| # | Line | Finding |
|---|------|---------|
| L10 | 89–90 | **Non-deterministic tie-breaking in `nearestLevel`** — When two levels have exactly the same distance, the first encountered wins. If the caller reorders the `levels` array, the result changes silently. No secondary sort key (e.g., label) is used. |
| L11 | 118–119 | **`swingStructure` conflates multiple failure modes** — It returns `'unclear'` with a count when either highs or lows is < 2, but the caller cannot distinguish between "only 1 swing high found", "only 1 swing low found", or "1 of each found". This makes downstream reasoning ambiguous. |
| L12 | 66 | **Floating-point division in neutral-doji check** — `Math.abs(upper - lower) / range < 0.2` uses raw floating-point arithmetic. For very small ranges, rounding error could push a value that should be `< 0.2` to `>= 0.2`, causing a neutral doji to be misclassified as dragonfly or gravestone. |
| L13 | 174 | **`toFixed(2)` truncation vs rounding in distance display** — `+(close - ema9).toFixed(2)` is used for both display and logic. `toFixed` rounds, but the rounded value is stored in the return object. If a caller compares `distance` against a threshold later, the pre-rounded value is lost. |
| L14 | 142 | **Object truthiness for `higherTF`/`lowerTF`** — `higherTF && higherTF.direction` treats any truthy object as valid, even if it has no `direction` property. An `{}` passes the guard and produces misleading results. |

---

## 4. `app/mcp-bridge.js` — TradingView Child Process Bridge

### High

| # | Line | Finding |
|---|------|---------|
| H8 | 244–252 | **Pending promise map leak on timeout** — `_handleLine` resolves/rejects pending promises when a response arrives, but if a request times out (line 270–274), the entry is deleted from `pending`. If a late response then arrives for that timed-out request, `_handleLine` silently ignores it because `this.pending.has(msg.id)` is `false`. This is correct for that single request, BUT if the bridge restarts or the child process reconnects, any responses still in flight from the old process will be silently dropped, potentially leaving the caller hanging indefinitely if it doesn't have its own timeout. |

### Medium

| # | Line | Finding |
|---|------|---------|
| M15 | 323–332 | **`stop()` doesn't clear pending promises** — When `stop()` is called, it kills the child process and clears the heartbeat timer, but it does **not** reject or resolve the pending promises in `this.pending`. Any caller waiting on an RPC call will hang forever. **Fix:** iterate `this.pending` and reject each with `new Error('MCP bridge stopped')`. |
| M16 | 268 | **`proc.stdin.write(msg)` has no backpressure handling** — If the child process's stdin buffer fills up (because it's not reading fast enough), `write()` returns `false`, but the code ignores the return value and continues. Under heavy load, this can cause data loss or process hangs. **Fix:** check the return value and pause/resume with `'drain'` event. |
| M17 | 49–50 | **`this.buf += chunk.toString()` unbounded buffer growth** — If the child process outputs a massive amount of data without sending newline-delimited JSON (e.g., enters a debug loop), `this.buf` grows without limit. **Fix:** cap buffer size or split on newlines more aggressively. |
| M18 | 107–114 | **`_scheduleBridgeRestart` recursion without abort** — If `start()` keeps failing, `_scheduleBridgeRestart` calls itself recursively via `setTimeout`. There is no maximum retry count or backoff cap beyond `MAX_BRIDGE_RESTART_BACKOFF_MS` (30s), so it will retry forever with no escalation or alert. |

### Low

| # | Line | Finding |
|---|------|---------|
| L15 | 267 | **`proc.stdout` data concatenation uses `+=`** — For high-throughput streams, repeated string concatenation creates many intermediate string objects. Use an array + `join()` or a Transform stream for better performance. |
| L16 | 270–283 | **Timer handle stored in closure but not tracked** — If `_rpc` is called many times rapidly, each call creates a `timer` closure. There is no central tracking, so if the process is stopped while timers are pending, they all fire and try to clear already-cleared handles. Harmless but untidy. |

---

## 5. `app/server.js` — Main Process / WebSocket Server

### High

| # | Line | Finding |
|---|------|---------|
| H9 | 824–826 | **`send(ws, obj)` doesn't check `ws.readyState === WebSocket.OPEN`** — It checks `ws.readyState === 1`, which is correct, BUT `wss.clients.forEach(ws => send(ws, obj))` iterates over the entire client set. If a client disconnects during iteration, `ws.readyState` may have changed to `3` (CLOSED) between the `forEach` snapshot and the `send` call. The check catches this, BUT there is no handling for `ws.readyState === 2` (CONNECTING) which could throw. **Fix:** also check `ws.readyState === WebSocket.OPEN` explicitly. |
| H10 | 1856–1860 | **`Promise.all` without individual error handling** — Three `runDebateAgent` calls run in parallel. If one fails, `Promise.all` rejects immediately, and the other two results are lost. The caller gets no partial results. **Fix:** use `Promise.allSettled` and handle each agent's result individually. |

### Medium

| # | Line | Finding |
|---|------|---------|
| M19 | Throughout | **100+ empty `catch (e) {}` blocks** — Found in `server.js`, `renderer/app.js`, `claude-agent.js`, `groq-agent.js`, `atomic-write.js`, and `tradingview-mcp/src/core/*.js`. Errors are silently swallowed with no logging, no metrics, and no user notification. This makes debugging production issues extremely difficult. **Fix:** at minimum `console.error('[module]', e)` or route to a centralized error handler. |
| M20 | 1078–1086 | **`runAppActionOnClient` pending map has no cleanup on timeout** — If the client doesn't respond within 15s, the timer resolves the promise with a timeout message, but the entry remains in `pendingAppActions` if the client later responds. **Fix:** `pendingAppActions.delete(actionId)` in the timeout handler. |
| M21 | 4664–4672 | **`EADDRINUSE` handler calls `process.exit(0)` after `exec`** — `require('child_process').exec(\`start http://localhost:${PORT}\`)` is asynchronous. The `process.exit(0)` may execute before the browser opens, or the exec may fail silently. There is no callback/error handling on the `exec` call. |

### Low

| # | Line | Finding |
|---|------|---------|
| L17 | 1073 | **`appActionCounter` is a plain global `let`** — If the process runs long enough, this counter will wrap around to negative values after ~9 billion actions. Not a practical issue, but using a `BigInt` or resetting on overflow would be more robust. |
| L18 | 660–674 | **`send(ws, ...)` during connection setup** — The initial config burst (lines 659–674) sends 10+ messages synchronously on connection. If the client is slow to process, the WebSocket buffer may fill up and `ws.send()` will return `false`, but the code doesn't check the return value or pause. |

---

## 6. `app/mcp-bridge.js` — Additional Findings

### Medium (continued)

| # | Line | Finding |
|---|------|---------|
| M22 | 323–332 | **`stop()` doesn't clear pending promises** — When `stop()` is called, it kills the child process and clears the heartbeat timer, but does **not** reject or resolve the pending promises in `this.pending`. Any caller waiting on an RPC call will hang forever. **Fix:** iterate `this.pending` and reject each with `new Error('MCP bridge stopped')`. |

---

## 7. `app/renderer/app.js` — Client-Side UI

### High

| # | Line | Finding |
|---|------|---------|
| H11 | 907 | **`setInterval` without cleanup on page unload** — `setInterval(() => { if (typeof saveActiveBucket === 'function') { try { saveActiveBucket(); } catch (e) {} } }, 2 * 60 * 1000)` runs forever. If the user navigates away or closes the tab, the interval keeps running. **Fix:** clear on `beforeunload`. |

### Medium

| # | Line | Finding |
|---|------|---------|
| M23 | 3862 | **`pr.then(() => { try { p.pause(); } catch (e) {} }).catch(() => {})`** — The outer `.catch(() => {})` swallows errors from `p.pause()`, AND the inner `try/catch` also swallows them. Double-swallowing makes debugging impossible. |
| M24 | 973 | **`this.ctx.resume().catch(() => {})`** — If the AudioContext is in a state where `resume()` fails (e.g., `suspended` due to browser autoplay policy), the error is silently swallowed, and the caller has no indication that audio is still muted. |

### Low

| # | Line | Finding |
|---|------|---------|
| L19 | 6048 | **`grRender(); setInterval(grRender, 1000)`** — Runs every second indefinitely. If the tab is hidden, `requestAnimationFrame` would be more efficient, but the current approach wastes CPU cycles. |
| L20 | 937 | **`tick(); setInterval(tick, 1000)`** — Same pattern as above. Should use `setTimeout` recursion with drift correction or `requestAnimationFrame` for UI updates. |

---

## 8. `app/claude-agent.js` — Native Anthropic Adapter

### Low

| # | Line | Finding |
|---|------|---------|
| L21 | 339–384 | **`globalTimer` pattern** — While cleanup is correct across all exit paths, the timer is stored in a local variable and cleared via a closure. If the function throws before the closure is created, the timer leaks. Wrapping in `try/finally` would be safer. |
| L22 | 424 | **Empty `catch (e) {}`** — Same pattern as elsewhere; at minimum log the error. |

---

## 9. `app/atomic-write.js` — Crash-Safe File Writes

### Low

| # | Line | Finding |
|---|------|---------|
| L23 | 55–56 | **`fs.closeSync(fd)` and `fs.unlinkSync(tmp)` in try/catch** — If the file is already closed or deleted (e.g., by another process), the catch silently ignores it. This is acceptable for cleanup, but could mask filesystem issues. |

---

## 10. `app/edge-tts.js` — Edge TTS

### Low

| # | Line | Finding |
|---|------|---------|
| L24 | 125–130 | **WebSocket error/close handlers clear timer but don't reject the outer promise** — If `ws.on('error')` fires, `fail(e)` is called, but if `ws.on('close')` also fires (which it often does after `error`), the `else if (!settled) fail(...)` may fire a second time, causing a double-reject. |

---

## 11. `tradingview-mcp/` — MCP Server

### Medium

| # | Line | Finding |
|---|------|---------|
| M25 | `src/core/stream.js`, `src/core/data.js`, `src/core/pine.js`, etc. | **49 empty `catch(e) {}` blocks** in core tools — Same systemic issue as the main app. TradingView API calls that throw are silently ignored, returning `undefined` to the caller, which then may produce confusing null-reference errors downstream. |

### Low

| # | Line | Finding |
|---|------|---------|
| L25 | `src/core/health.js:236` | **`.on('error', () => resolve(null))`** — Network errors during health check resolve to `null` instead of rejecting, making it impossible for the caller to distinguish between "healthy but no data" and "connection failed". |

---

## 12. Cross-Cutting Concerns

### Systemic: Empty Catch Blocks
**100+ instances** across `app/` and `tradingview-mcp/`. The pattern `catch (e) {}` appears in:
- `app/renderer/app.js` (~50 instances)
- `app/server.js` (~15 instances)
- `tradingview-mcp/src/core/*.js` (~49 instances)
- `app/groq-agent.js`, `app/claude-agent.js`, `app/atomic-write.js`

**Impact:** Silent failures make debugging production issues nearly impossible. Errors that should be logged, reported to the user, or trigger fallback behavior simply vanish.

### Systemic: Unhandled Promise Rejections in Event Handlers
`groq-agent.js` uses `async` callbacks inside `res.on('end', async () => { ... })`. If any `await` inside throws *after* the outer promise has already settled, Node.js emits `unhandledRejection`. The codebase has `process.on('unhandledRejection', ...)` handlers that log and keep the process alive, but individual callback paths are not fully covered.

### Systemic: No Input Validation on External Data
`chart-reads.js` is the most critical example — it trusts that bar data from the TradingView bridge is well-formed. A single malformed bar from a data feed will poison `emaFromBars`, `detectDoji`, and `swingStructure` with `NaN` that is never caught, and every downstream agent will report invalid numbers with full confidence.

---

## Recommended Fix Priority

| Priority | Issues | Effort | Impact |
|----------|--------|--------|--------|
| **P0** | C1, C2, H1, H2, H5, H6, H7, H8 | Medium | Crashes / wrong data / failed API calls |
| **P1** | H3, H9, H10, M3, M15, M22, M23 | Medium | Hangs / unhandled rejections / blocked cancellations |
| **P2** | M1, M2, M4, M5, M6–M9, M19–M21, M25 | Low–Medium | Silent failures / data corruption / memory leaks |
| **P3** | All Low items | Low | Code hygiene / maintainability |

---

*Report generated: 2026-08-12*
