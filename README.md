# MNQ Co-Pilot

A personal trading co-pilot for MNQ (Micro Nasdaq) and MGC (Micro Gold) futures.
It is a local Node.js server that pairs an AI coaching agent ("Jessi") with a live
TradingView Desktop chart, and enforces a set of trading-discipline rules defined as
data. Built for a single trader's own workflow and shared here as-is.

> **Disclaimer.** This is a personal tool, provided as-is with no warranty. It is not
> financial advice and not a product. Trading futures carries substantial risk. Use at
> your own risk.

## What's in here

- **`app/`** — the product: a Node.js WebSocket/HTTP server that talks to Claude and
  Groq/Gemini for AI coaching, bridges to a live TradingView Desktop chart via the
  `tradingview-mcp` subproject, and enforces discipline rules from `rules.json`.
- **`tradingview-mcp/`** — a standalone MCP server that drives TradingView Desktop over
  the Chrome DevTools Protocol (CDP). `app/mcp-bridge.js` spawns it as a child process.
  See `tradingview-mcp/README.md`.

Runtime state (trade history, chat transcripts, session recordings) lives in
`DATA/` and `sessions/` and is **not** part of the repo (gitignored).

## Requirements

- Windows with **TradingView Desktop** installed (the CDP bridge drives the desktop app).
- **Node.js 20+**.
- API keys for at least one AI backend (Anthropic Claude, and/or Groq, Gemini, or a
  self-hosted OpenAI-compatible router). See Configuration below.

## Configuration

The server reads a config file at `~/.mnq-copilot-config.json` (your home directory,
**not** the repo). Copy the example and fill in your own keys:

```bash
cp app/.mnq-copilot-config.example.json ~/.mnq-copilot-config.json
```

Never commit real keys. The config file lives outside the repo by design.

## Running

TradingView must be launched with remote debugging enabled (`--remote-debugging-port=9222`)
**before** the server, or the CDP bridge can't connect. On Windows, `START CO-PILOT.bat`
does this in the right order (it hardcodes local paths — edit them for your machine).

To run the server directly:

```bash
cd app
npm install
node server.js
```

The server listens on `http://localhost:7433`; open that URL in a browser.

## Tests

```bash
cd app && npm test                 # app unit tests (node --test)
cd tradingview-mcp && npm run test:unit   # MCP unit tests (no live TradingView needed)
```

## Architecture (brief)

- **Rules are data.** `app/rules.json` is the single source of truth for every discipline
  rule (size caps, trades/session, daily loss tiers, session windows). Loaded at runtime.
- **Single-process server.** `app/server.js` is a raw `http` server plus a `ws`
  WebSocketServer. All client↔server messages flow through one handler that dispatches on
  message type.
- **Two AI backends.** `app/claude-agent.js` (Anthropic SDK) is the main analysis agent;
  `app/groq-agent.js` is a multi-provider fallback (Groq / Gemini / local Ollama / an
  OpenAI-compatible router) used for voice, lighter, and alternate paths.
- **Live chart monitors** poll TradingView on timers and push detections to the client.
- **`app/mcp-bridge.js`** owns the `tradingview-mcp` child process and a heartbeat that
  verifies the CDP connection independently of whether the child process is up.

Note: `app/main.js` + `preload.js` are a legacy Electron shell and are not the primary
launch path.
