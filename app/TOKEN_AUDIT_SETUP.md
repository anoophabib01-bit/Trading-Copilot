# Stage 1 audit — setup

## 1. Drop the file in
`token-audit.js` lives in `app/`, next to `claude-agent.js`, `mcp-bridge.js`,
`books-index.js`, `supercompress.js` — already done.

## 2. Patch claude-agent.js (3 lines, additive only — nothing existing changes)
Done: `module.exports.buildSystemPrompt` and `module.exports.ALL_TOOLS` are
now exported alongside the existing `module.exports = new ClaudeAgent();`.
This only *adds* two properties to the already-exported agent instance. It
doesn't change `stream()`, doesn't change what the app does at runtime, and
is safe to leave in permanently or remove after this exercise.

## 3. Set your API key and run
```powershell
# Windows PowerShell
$env:ANTHROPIC_API_KEY="sk-ant-your-key-here"
cd app
node token-audit.js
```
```cmd
:: Windows cmd
set ANTHROPIC_API_KEY=sk-ant-your-key-here
cd app
node token-audit.js
```

Anthropic's `messages.countTokens` endpoint is free — it counts tokens without
generating a completion, so running this costs nothing. If you skip the key
entirely, the script still runs using a labeled estimate (chars/4 + a known
~735 token/tool overhead figure) so you can see the shape of the numbers
immediately, then swap in exact ones once the key's set.

## 4. Edit the CONFIG block at the top of token-audit.js
`ESTIMATED_CALLS_PER_SESSION` and `ESTIMATED_SESSIONS_PER_MONTH` are
placeholder assumptions, not measured numbers. Real call counting is now
wired in (see below) — use `token-usage-report.js` to get actual numbers
instead of guessing.

## 5. Real call counting (added 2026-08-02)
`call-logger.js` logs one line to `DATA/token-usage.jsonl` every time
`claude-agent.js` completes a real, billed Claude API call — including each
recursive tool-use round trip within a single user turn, since those are
separate calls on Anthropic's side too. It's wired into `stream()`'s
`runLoop` right after `finalMessage()` resolves, so it captures real
`usage.input_tokens`/`usage.output_tokens` from the API response itself, not
an estimate. Logging is fire-and-forget and swallows its own errors — it can
never throw or slow down a live trading session.

After using the app for a few real sessions, run:
```powershell
cd app
node token-usage-report.js
```
This groups the log into sessions (a 45-minute gap between calls = a new
session, since `START CO-PILOT.bat` restarts the node process per trading
session and an in-memory counter alone would lose history across restarts)
and prints avg/max calls-per-session and sessions/day, plus a ready-to-paste
`CONFIG` block for `token-audit.js`.

`DATA/token-usage.jsonl` lives next to the rest of your real trade/account
data — already covered by `.gitignore`'s `DATA/` entry, so it never gets
committed.

## What to look at in the output
- **System + tool floor** — this is what every single call costs before any
  conversation history exists. If it's large relative to your history cost,
  tool schema bloat (23 tools) is your real token driver, not chat length.
- **History at 20 vs 40 messages** — tells you whether your `slice(-20)` /
  `slice(-40)` caps in `app.js` are actually doing meaningful cost control, or
  whether the tool schema dwarfs them (check the numbers — it likely does).
- **search_books round trip** — the real cost of one RAG retrieval before
  supercompress. Compare against a compressed run (needs a SuperCompress key)
  to see if that dependency is earning its keep in tokens, not just intent.
