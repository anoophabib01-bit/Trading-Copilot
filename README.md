# Trading Co-Pilot

An AI co-pilot for **TradingView Desktop**. It runs as a local Node.js server, pairs an
AI coaching agent ("Jessi") with your live TradingView chart over the Chrome DevTools
Protocol, and enforces trading-discipline rules that are defined as data (so you can edit
them without touching code).

Chart any instrument you like — the co-pilot reads whatever symbol/timeframe is on your
TradingView chart. It ships with example discipline rules and coaching tuned for futures
scalping (MNQ / MGC), which you adapt to your own instrument and style by editing
`app/rules.json`. Broader, instrument-agnostic presets and features are on the roadmap.

> **Disclaimer.** Personal tool, provided as-is, no warranty. Not financial advice, not a
> product. Trading carries substantial risk. Use at your own risk.

## What it does

- Reads your live TradingView chart (price, OHLCV, timeframe, drawings) via a CDP bridge.
- Runs an AI analysis/coaching agent (Claude, with Groq / Gemini / local / OpenAI-compatible
  router fallbacks) that can analyze the chart, flag rule violations, and talk through setups.
- Enforces discipline rules from `app/rules.json` (size caps, trades per session, loss tiers,
  session windows) — the single source of truth, edit it to fit your instrument.
- Live monitors that poll the chart and push detections (engulfing, FVG, SFP, Power-of-3).
- Optional voice mode (speech in, spoken replies).

## What's in here

- **`app/`** — the server: a Node.js WebSocket/HTTP app that talks to the AI backends,
  bridges to TradingView via `tradingview-mcp`, and enforces the rules.
- **`tradingview-mcp/`** — a standalone MCP server that drives TradingView Desktop over CDP.
  See `tradingview-mcp/README.md`.

Runtime state (your trade history, chat transcripts, sessions) lives in `DATA/` and
`sessions/` and is **not** in the repo (gitignored).

## Requirements

- Windows with **TradingView Desktop** (the CDP bridge drives the desktop app).
- **Node.js 20+**.
- An API key for at least one AI backend (Anthropic Claude, and/or Groq, Gemini, or a
  self-hosted OpenAI-compatible router).

## Configuration

The server reads `~/.mnq-copilot-config.json` in your home directory (**not** the repo):

```bash
cp app/.mnq-copilot-config.example.json ~/.mnq-copilot-config.json
```

Fill in your own keys. Never commit real keys — the config lives outside the repo by design.

## Running

TradingView must be launched with remote debugging enabled
(`--remote-debugging-port=9222`) **before** the server.

On Windows, `START CO-PILOT.bat` does that in the right order: it launches TradingView
with the debug port, waits for it to answer, then starts the server. **It runs from
wherever you put it** — it resolves the project folder from its own location, so a fresh
clone works as cloned. (It used to be pinned to one drive letter; fixed 2026-09-22.)

Or run the server directly:

```bash
cd app
npm install
node server.js
```

Then open `http://localhost:7433`.

## Adapting it to your instrument

Everything instrument-specific lives in `app/rules.json`: size caps, trades per session,
daily-loss tiers, and session windows (IST wall-clock minutes since midnight). Edit that
file — the server reads it at runtime, no code changes needed. The AI coaching personas
currently reference futures scalping; generalizing those is on the roadmap.

## Tests

```bash
cd app && npm test                        # app unit tests (node --test)
cd tradingview-mcp && npm run test:unit   # MCP unit tests (no live TradingView needed)
```

## Roadmap

- Instrument-agnostic rule presets (equities, crypto, forex) beyond the futures defaults.
- Configurable coaching personas not tied to a single trading style.
- Cleaner setup (fewer hardcoded paths, cross-platform launch).
