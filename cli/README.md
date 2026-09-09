# `cli/` — external market CLIs

**This folder is the single place anything about an external market CLI lives.**
Binaries are registered here, their local store is relocated here **via explicit
`--db`** (not env vars — see Verified facts), the wrapper
lives here, and this file is the reference. If you are looking for how the app
talks to a market data CLI, you are in the right directory and there is nowhere
else to check.

Established 2026-09-06 at Anoop's instruction: *"make sure you name a NEW folder
naming CLI and use only that folder for all the information related to CLI so
that you can refer anytime."*

---

## Quick start

```bash
node cli/market-brief.js              # pre-New-York-session brief, MNQ + MGC
node cli/market-brief.js --save       # same, also writes cli/briefs/<date>.json
node cli/market-brief.js --json       # machine-readable

node cli/corpus-pull.js               # refresh the local OHLCV corpus
node cli/corpus-pull.js --full        # adds 1m/7d and 1h/2y series

node cli/gold-brief.js                # MGC-only brief + gold/silver ratio
node cli/gold-brief.js --save         # writes cli/briefs/gold-<date>.json

node cli/backtest-po3.js              # PO3 base rates from the corpus
node cli/econ-calendar.js             # scheduled releases + blackout windows
node cli/econ-calendar.js --check     # is RIGHT NOW inside a blackout?

node --test "cli/test/*.test.js"      # 30 tests, no network
```

---

## What is installed

| CLI | Binary | Auth | Status |
|---|---|---|---|
| `yahoo-finance` | `yahoo-finance-pp-cli.exe` v2026.8.1 | none for `chart` | **Primary.** OHLCV for MNQ/MGC/VIX |
| `fred` | `fred-pp-cli.exe` | **needs `FRED_API_KEY`** | Installed. Calendar not yet exercised — no key set |
| `prediction-goat` | `prediction-goat-pp-cli.exe` | none | Installed + synced. **Unusable for macro** — see below. `trending` works |
| `nse-india` | `nse-india-pp-cli.exe` | none | India desk only. Cold store |

> **`fred` needs a free key before EVENT RISK works.** Get one at
> <https://fredaccount.stlouisfed.org/apikeys>, then `setx FRED_API_KEY <key>`
> and open a new shell. Until then the brief reports event risk as `UNKNOWN`
> — never as clear.

Both live in `%LOCALAPPDATA%\Programs\PrintingPress\bin`. Absolute paths are
recorded in [`cli-paths.json`](cli-paths.json) — **never rely on `PATH`.** The
installer's bin directory is not on it, and `START CO-PILOT.bat` runs with a
different `PATH` than a developer shell, so `exec('yahoo-finance-pp-cli ...')`
would be `ENOENT` at runtime.

### Evaluated and not installed

| CLI | Status |
|---|---|
| `kalshi` | **Not installed — needs a funded account.** Now the *only* route to Kalshi odds in this library. See below |
| `mcpmarket` | **Not installed — wrong layer.** Finds tools for the builder, not for the app. See below |
| `benzinga` | **Blocked.** Paid licence, entitlements split across two token families; the calendar needs the market/super-token specifically |

> **Correction, 2026-09-06.** An earlier version of this table said *"`prediction-goat`
> covers the same odds without the ability to trade"* and told you to skip Kalshi on
> that basis. **That was wrong.** `prediction-goat` returns **zero Kalshi rows** — every
> `trending` result comes back `source: polymarket`. If you want Fed/CPI implied
> probabilities from this library, the Kalshi CLI is the only path. The rest of the
> Kalshi trade-off — an account, RSA keys on disk, and a binary that can place orders
> next to an app with a live order path — is unchanged.

---

## Files

| File | Role |
|---|---|
| `market-cli.js` | The **only** module allowed to spawn a CLI. Path resolution, `--db` relocation, output unwrapping, exit-code mapping |
| `yahoo.js` | Yahoo chart adapter, symbol table, ET/IST conversion, RTH session helpers |
| `market-brief.js` | The pre-session brief (MNQ + MGC). Also exports `sessionize()` and `ratioSeries()` |
| `gold-brief.js` | MGC-only brief: gold-specific drivers + the gold/silver ratio |
| `econ-calendar.js` | FRED release calendar → blackout windows. **Fails closed** |
| `backtest-po3.js` | Base rates for `app/amd-phase.js` against the corpus |
| `corpus-pull.js` | Pulls and merges OHLCV into `cli/corpus/` |
| `cli-paths.json` | Resolved binary paths + per-CLI operational notes |
| `corpus/` | `<symbol>/<interval>.jsonl`, one bar per line, merged by timestamp |
| `briefs/` | Saved briefs, one JSON per ET date |
| `state/` | Per-CLI local store, reached only by passing `db: true` to `run()`/`runNdjson()` |

---

## Verified facts (2026-09-06, by direct invocation)

These were established by running the binary, not by reading its docs. They are
the difference between an integration that works and one that fails quietly.

**Yahoo serves CME futures.** `chart MNQ=F` returns `exchangeName: "CME"`,
`instrumentType: "FUTURE"`. `MGC=F` returns `"CMX"`. This is real, free,
key-less OHLCV for both instruments.

**`quote list` is dead — use `chart`.** `quote list` returns `HTTP 401
Unauthorized`; Yahoo has closed `/v7/finance/quote`. `chart` uses `/v8` and
needs no auth. Note that `doctor` still cheerfully reports `Auth: not required`
while `quote` is broken, so **`doctor` is not a readiness check** for the
endpoint we actually use.

**Never use `--interval 1d` on continuous futures.** MNQ returns 385 daily bars
across seven years — about 55/year against an expected 252. MGC returns 164
across sixteen years. Yahoo stitches continuous contracts badly at daily
resolution, and anything derived from it (an ATR, a 20-day baseline, a gap
statistic) is wrong in a way that looks plausible. `yahoo.js` **refuses** the
combination in code rather than warning about it. Use `1h` and resample.

**Bar depth actually returned:**

| Symbol | Interval | Max range | Bars |
|---|---|---|---|
| `MNQ=F` | 1m | 7d | 7,127 |
| `MNQ=F` | 5m | 60d | 16,691 |
| `MNQ=F` | 15m | 60d | 5,565 |
| `MNQ=F` | 1h | 2y | 14,504 |
| `MGC=F` | 5m | 60d | ~16,700 |

Asking beyond an interval's max range silently returns a *shorter* window rather
than erroring — which is how a "60 days of 1m data" assumption survives testing
and fails in production. `MAX_RANGE` in `yahoo.js` records the real caps.

**`DX=F` is not a valid Yahoo symbol** (HTTP 404, "symbol may be delisted"). The
ICE dollar index is `DX-Y.NYB`.

**`--agent` silently strips fields — do not use it.** It expands to
`--json --compact --no-input --no-color --yes`, and `--compact` "returns only
key fields". Measured on `nse-india movers`:

| Flag | Fields per row |
|---|---|
| `--agent` | **1** — just `{ identifier: "PCJEWELLEREQN" }` |
| `--json` | **18** — `symbol`, `lastPrice`, `pChange`, `totalTradedValue`, … |

The flag that advertises itself as *the* agent default discards the data an
agent wants, with no error and exit code 0. `market-cli.js` therefore passes the
agent flags **individually, minus `--compact`**, and exposes `compact: true` as
an explicit opt-in. Do not "simplify" it back to `--agent`.

**`indices list` returns `{nts, stn}`**, not a flat list. Nobody has established
what those keys are — find out before rendering anything from that command.

**Store relocation does NOT work through environment variables.** This was
asserted here without testing and was wrong; DSH found it on `nse-india`, and
re-measuring showed it is broader. `doctor` run with and without
`XDG_DATA_HOME` / `<NAME>_HOME`:

| CLI | Without env | With env |
|---|---|---|
| `nse-india` | `~/.local/share/nse-india-pp-cli/data.db` | **identical** |
| `yahoo-finance` | `~/.local/share/yahoo-finance-pp-cli/data.db` | **identical** |

Both hardcode `~/.config` and `~/.local/share`. The four-path-kind ladder is
documented on the *newer* CLIs' pages (`fpi-india`, `benzinga`, `mcpmarket`) and
absent from these two — a per-CLI capability the wrapper was treating as
universal. **The only relocation that works is an explicit flag:** pass
`db: true` to `run()` / `runNdjson()` and it appends
`--db cli/state/<name>/data.db`. Local-store commands (`sync`, `index-driver`,
`delivery-spike`, `delivery-divergence`, `sector-breadth`) need it; live-API
commands (`market`, `movers`, `equity quote`) reject it.

**`sync --full` with no `--resources` syncs ONE resource.** Measured:
`{"resources":1,"total_records":1}` — just `indices`, in 362 ms, then it stops.
It does not mean "sync everything". Pass `--resources` explicitly.

**`equity` and `index_constituents` are cookie-gated.** `auth status` returns
*"Not authenticated. Run: nse-india-pp-cli auth login --chrome"*. Those two
resources are what `index-driver`, `delivery-spike`, `delivery-divergence` and
`sector-breadth` all read — so **the 20-session clock cannot start until that
one-time browser login is done.** Until then `sync` reports
`resources:3, success:1, errored:2` and the desk correctly shows everything cold.

---

## The safety boundary

Borrowed directly from `app/autonomy-modes.js`, which guarantees a per-mode
config can only ever be *tighter* than the global rules — `riskCapUsd()` returns
the minimum, so a bad edit can only refuse trades, never widen risk.

> **Nothing in this folder may raise a size, loosen a gate, or add conviction.**
> A CLI result may **block** a trade or **annotate** a record. It may never
> permit one.

There is no code path from `cli/` into `handleTradeConfirm`, and there must not
be one. The brief has no bullish/bearish field, and `cli/test/cli.test.js`
asserts that no alert contains directional vocabulary — so if someone later adds
a lean, the suite fails and they have to argue for it deliberately.

The reasoning is in this repo's own data. `failure-chain.js` on 2026-09-03: the
day was decided at trade four — a −$526 loss, then size went 4 → 15 → 20 lots,
and escalation-after-loss owned −$1,779, 77% of the damage. The problem is
stopping, not signal. A pre-session brief that offers a lean hands the
rationalising voice a starting position.

---

## The four bugs `market-cli.js` exists to prevent

`PRINTING_PRESS_INTEGRATION.md` proposed a client that would have failed on its
first call, four separate ways. Each is fixed once, centrally:

1. **Await properly.** The draft did `_runCLI('movers').slice(0, limit)` and
   `_runCLI(...)[0]` — indexing a Promise. `.slice` is not a function on a
   Promise; `[0]` is `undefined`.
2. **Two output shapes.** Some commands return `{meta, results}`; others return
   a bare array (`index-driver`) or bare `null`. The draft always read
   `.results`, so a bare array became `undefined`.
3. **Empty is not an error, and an error is not empty.** `delivery-spike` prints
   `null` and `sector-breadth` prints `[]` — **both at exit code 0** — when the
   local store is unsynced. A caller that cannot tell "no data yet" from "no
   signal" reads an unsynced store as a calm market.
4. **Exit codes are meaningful.** `0` ok · `2` usage · `3` not found · `4` auth ·
   `5` API · `7` rate limited · `10` config. A `7` should back off; a `4` should
   alarm once and stop retrying.

A fifth was caught on the brief's own first live run and is now a regression
test: the **gap percentile compared unlike quantities** — live gap measured
`overnight close − prior RTH close`, baseline measured `RTH open − overnight
close`. Every real gap scored in the 100th percentile, so the brief announced a
record gap every single day. Percentiles are only meaningful between like
quantities.

---

## The brief

`market-brief.js` describes what happened overnight in MNQ and MGC, with every
unusual figure stated as a **percentile against that instrument's own recent
history** — "wider than 92% of the last 48 sessions", not "wide".

It reports: gap vs prior RTH close (points, %, and dollars per contract), prior
RTH OHLC, overnight high/low/range and where price sits in it, sudden moves, and
cross-market context (VIX, 10Y, DXY, ES).

**Sudden-move detection** z-scores each overnight 5-minute bar against the
instrument's own 60-day distribution of 5m moves and reports anything beyond
3 sigma, timestamped in both ET and IST.

It works. On its first run it flagged, for both instruments independently, a
large move at **08:30 ET on Friday 4 September** — MNQ −114 pts (5.2σ), MGC
−77.4 pts (21.1σ). That is the first Friday of the month at the canonical US
data release time: Non-Farm Payrolls. The detector found the event with no
calendar wired at all.

Which is also the argument for installing `fred` next: the brief can already
tell you *something violent happened at 08:30*. It cannot yet tell you
*something violent is scheduled for 08:30 tomorrow*. Until then EVENT RISK reads
`NOT WIRED`, and it says explicitly that event risk is **unknown, not absent**.

---

## The corpus

`corpus-pull.js` writes newline-delimited JSON to
`cli/corpus/<symbol>/<interval>.jsonl`, merged by timestamp so a re-run never
loses a bar that has aged out upstream.

Two reasons it exists rather than fetching live:

1. **Yahoo's window is short and moving.** 5m data ages out at 60 days, 1m at 7.
   A month from now, today's 1m bars are unrecoverable from any source. Pulling
   on a schedule is the only way the archive gets deeper than vendor retention.
   This is also what makes it useful for the forensics/replay work: chart bars
   in this app are rolling snapshots, and Yahoo is an *independent* source that
   can backfill a window nobody archived — but only while it is still served.
2. **A backtest that re-fetches is not reproducible.** Base rates computed from
   a moving window cannot be compared across runs.

Current state: **36,684 bars** — MNQ and MGC at 5m and 15m over 60 days, plus
two years of daily VIX.

### What the corpus is for

The point is **base rates**. `app/amd-phase.js` is a pure, unit-tested PO3 phase
detector. Run it across 13,534 real 5-minute MNQ bars and you get a *frequency* —
when accumulation breaks at 09:35 ET, what actually happened next, across 48
sessions — instead of an assertion. That is the honest kind of probability:
counted, not asserted. It is also a pure-function backtest, so it runs under
`node --test` with no live chart and no risk.

---

## Where each CLI belongs in the autonomy ladder

From `app/autonomy-modes.js`: `MODES = ['off','shadow','assist','live']`,
labelled MYSELF / SHADOW / ASSIST / CONTROL, each rung adding exactly one new
thing that can go wrong. The CLIs follow the same discipline.

| Mode | What a CLI may do |
|---|---|
| **MYSELF** (`off`) | Post-session only. Replay bars that were not archived; describe what happened. Never speaks before or during a trade |
| **SHADOW** (`shadow`) | Ground truth for scoring. Replay the corpus, let shadow call it, count the hits — this is what makes scoring possible without a live chart |
| **ASSIST** (`assist`) | Veto lines printed on a ticket being approved: "FOMC resolves in 40 minutes." Never a reason the ticket exists |
| **CONTROL** (`live`) | Hard refusal gates only, **failing closed**. No network call in the hot path — refresh a blackout table on a timer, read it from memory at decision time |

---

## Skills vs app tools

Each printing-press CLI also ships an **agent skill** (omit `--cli-only` when
installing). Already present on this machine: `pp-nse-india`,
`printingpress-universal`.

Those skills are for **Claude Code working in this repo** — they teach the
coding agent to drive the CLI. They are **not** available to Jessi, the Judge or
the Scalper: those run on DeepSeek through `groq-agent.js` and can only call
schemas registered in `JESSI_TOOLS` / `ALL_TOOLS`.

Keep the CLIs on the build side. Every tool schema added to `JESSI_TOOLS` is
permanent prompt content on every request — four market-data tools would be four
new ways for an agent to talk itself into a trade, at permanent token cost.
Promote exactly one thing to a runtime tool when there is evidence it blocks
something real; run `node token-audit.js` first.

---

## Adding a CLI

1. `npx -y @mvanhorn/printing-press-library install <name>` (add `--cli-only` to
   skip the agent skill).
2. Add it to `cli-paths.json` with its resolved absolute path and an operational
   note covering anything you had to discover by running it.
3. Call it only through `market-cli.js` — never `exec` it directly.
4. **Run every command you intend to use and record what actually came back.**
   Half the facts in this file contradict the CLI's own documentation.

---

## First base rates (2026-09-06)

`node cli/backtest-po3.js` — 49 MNQ sessions, 15m bars, 29 Jun → 4 Sep 2026.
It imports `computeAmdPhase()` from `app/amd-phase.js` directly, so it can
never drift from what gates a live auto-triggered debate.

**The headline: `amd-phase.js` reaches DISTRIBUTION by two different routes,
and only one of them works.**

Its own source flags one route as *"ENTRY-RELEVANT: this is the reversal out of
manipulation"*. The other — opening range broken **with** bias, no counter-sweep
first — carries the reason *"distributing, but no manipulation trap was set"*.
Split by route, over the same 49 sessions:

| Route | n | Median MFE | Median MAE | Mean P&L to close | Win @1.5R | Expectancy |
|---|---|---|---|---|---|---|
| **Via manipulation trap** | 12 | 86 pts | **48.5 pts** | **+44.7 pts** | 50% | **+0.25R** |
| No trap — range break | 23 | 78.5 pts | **130.75 pts** | +4.4 pts | 13% | −0.67R |

Each segment is scored against its own median adverse excursion as R; a pooled
stop would be far too wide for one and far too tight for the other. A session
where both target and stop were touched counts as a **loss**, because bar
extremes carry no ordering and the pessimistic read is the only honest one.

The trap route risks **2.7× less** for slightly more upside. The no-trap route
has a median adverse excursion of 130 pts — **$261/contract** — for a mean P&L
of essentially zero.

**Two-thirds of what currently fires is the bad route.** 23 of 35 signals.

Other counts from the same run: the 1H bias gate blocked 7 of 49 sessions (14%);
the trap actually completes in only 36% of judged sessions; 45% of sessions go
straight `ACCUMULATION → DISTRIBUTION` with no manipulation leg at all.

### Limits — read before acting on the table

- **n = 12** for the good segment, over about ten weeks. Suggestive, not proven.
- **Bias is approximated**, not the live `classifyTrendStrength()` (still inline
  in `app/server.js` ~line 7269, not exported). Phase-transition *counts* are a
  real measurement of the AMD logic; bias-dependent *outcome rates* are
  indicative until that function is extracted the way `amd-phase.js` was. **That
  extraction is the single highest-value next step**, and it would also let the
  existing TradingView backtest stop approximating.
- Forward outcomes are measured to the session close only; no trailing stop, no
  partial exits, no fees.


---

## The UI

Surfaced as a **Brief** tab in the app (added 2026-09-06 — before that, everything
here was terminal-only and invisible in the product).

| Layer | Change |
|---|---|
| `app/server.js` | `case 'brief-get'` + `sendMarketBrief()` — lazy `require('../cli/market-brief')` inside a `try`, 10-minute cache |
| `app/renderer/ws-client.js` | `case 'brief-data'` + `api.marketBrief(refresh)`, 150s timeout |
| `app/renderer/index.html` | `data-tab="brief"` button + `#tab-brief` panel |
| `app/renderer/app.js` | `renderBrief()` + a `switchTab` hook |

Four design choices worth keeping:

- **Lazy require inside a try.** `cli/` drives external binaries. If it goes
  missing or throws on load, that degrades one tab — it must not take down a
  process also running the monitors, Jessi and the broker feed.
- **Renders on tab open, never on a timer.** A panel refreshed while hidden is
  the hidden-tab staleness this app has already been bitten by. The server
  cache makes opening cheap.
- **One request, one whole-tab payload** — same shape as Week and Forensics, so
  the panel can never merge a fresh number into a stale view.
- **EVENT RISK renders first, and `UNKNOWN` is amber, not neutral.** An
  unreachable calendar must not look like a clear one.

Verified end-to-end on 2026-09-06 by booting a second server on `MNQ_PORT=7444`
(the override exists for exactly this) and driving `brief-get` over a real
WebSocket: full payload on the first call, `cached: true` on the second. The
live server on 7433 was left untouched.

---

## Prediction GOAT — installed, and NOT usable for macro

Installed and synced 2026-09-06, then found unfit for the purpose it was
recommended for. Recorded here so nobody re-recommends it without re-testing.

**It stays installed** (Anoop, 2026-09-06: "do not remove anything"). It is
read-only, self-contained, and costs nothing while idle — and keeping it means
the re-test below can be run the moment upstream fixes the paginators.

| Check | Result |
|---|---|
| `topic fed` / `cpi` / `inflation` / `recession` | **0 hits, every one** |
| `resolving --week` | `{"items":[]}` — **at exit code 0, no error** |
| `markets list --limit 500` | returns **100 rows**; the limit is ignored |
| `/markets/keyset`, `/events/keyset` | **HTTP 422** `invalid integer` |
| `sync` exit code | **0**, despite 3 errored resources |
| `trending` | works, prices genuinely live — but every row is `source: polymarket` |

The local index caps at 100 rows per resource because both keyset paginators —
the things that would walk the full dataset — return 422. `sync` reports success
anyway: *"3 resource(s) failed but exit code is 0 because the new default treats
non-critical failures as warnings."* And `base_url` is
`gamma-api.polymarket.com`; **the Kalshi half, which is where Fed and CPI
markets actually live, returns nothing here.**

So the 100 markets it does hold are politics and sports — 2028 presidential
races, "Xi Jinping out before 2027?" — with 2 macro-ish matches out of 100.

**Not wired into EVENT RISK, deliberately.** Re-test after an upstream fix; the
bar is `topic cpi` returning hits. Note this is the *same failure class* as
`nse-india`'s cold store and the reason `market-cli.js` reports `empty` as a
distinct state: an unusable data source that exits 0 looks exactly like a calm
market.


---

## Kalshi — evaluated 2026-09-06, not installed

Read from the catalog page; not executed (it needs a funded Kalshi account, so
there was nothing to test against).

**It is a full trading client, not a data tool with trading attached.** The
`portfolio` group covers `create-order`, `batch-create-orders`, `amend-order`,
`cancel-order`, order groups with a rolling 15-second contract limit, and
transfers across up to 32 subaccounts.

**Auth is the barrier.** Composed RSA-PSS signature auth — a UUID access key id
(`KALSHI_API_KEY`) *plus* an RSA private key file (`KALSHI_PRIVATE_KEY_PATH` or
`KALSHI_PRIVATE_KEY`). Kalshi issues read-only and read/write tiers; both need
an account.

**Safety features it does ship:**

- `KALSHI_READ_ONLY=1` / `--read-only` — a client-side lock that blocks every
  POST/PUT/PATCH/DELETE **before signing**, regardless of which key tier is
  loaded. Set it in the environment, not per-command.
- `--dry-run` on every mutator.
- Caveat: tier detection is **client-side only**. The CLI never probes whether
  your loaded key is read-only; it finds out when the API returns 403.

**What would actually be worth having, all research-only:**

| Command | What it gives |
|---|---|
| `markets history <ticker> --sparkline` | Price over time, from snapshots captured on each sync. The API only returns current price |
| `markets correlate KXFEDFUNDS-26FEB KXCPI-26FEB --window 30d` | Pearson correlation between two markets |
| `historical get-market-candlesticks` | 1min / 1h / 1day candles for markets past the historical cutoff |

Together those answer a real question: *what did the market price a Fed decision
at, hour by hour, and what did MNQ do next.* That is a genuine probability
backtest, and it is the one thing in this library that would extend
`cli/backtest-po3.js` beyond price alone.

**Cold-store warning, same pattern as everything else here:** `markets movers`
needs two syncs **an hour apart** before it returns anything, and
`markets history` needs at least two syncs. Day one produces nothing.

**Known gaps disclosed upstream:** `sync` emits HTTP 404 warnings on bare-path
resources (`/account`, `/api-keys`, `/communications`) because Kalshi nests them
under different paths; sync skips them and continues.

**Decision:** not installed. Revisit only if you open a Kalshi account, and if
you do, set `KALSHI_READ_ONLY=1` in the launcher environment before the first
call — not as a flag someone has to remember.

---

## mcpmarket — evaluated 2026-09-06, not installed

Read from the catalog page; not executed.

**What it is:** a browser for mcpmarket.com's catalog of MCP servers, MCP
clients and Agent Skills, mirroring what you browse into local SQLite so it can
answer questions the website cannot — what is trending, what changed since last
week, what one author has shipped.

**Actual command surface is thin:** `category`, `mcpclient <slug>`,
`server get`, `server similar`, `skill <slug>`. **Discrepancy worth knowing:**
the page's Quick Start shows `server search` and `server list`, and the feature
list shows `trending`, `diff`, `author`, `leaderboard`, `watch`, `dedupe` and
`stack` — but **none of those appear in the Commands section**. Whether they
exist would have to be established by running `--help`, not by reading the page.

The two genuinely interesting ideas, if they are real: `stack <server> --depth 2`
walks the similar-tools graph to build a toolchain rather than one suggestion at
a time, and `dedupe --category <c>` surfaces near-identical listings so you do
not install three servers that do the same job.

**Caveats:** every stateful command compares against local snapshots and needs
the catalog browsed **at least twice on different days** — day one returns
nothing (the same cold-store pattern as `nse-india`, `prediction-goat` and
Kalshi). And mcpmarket.com sits behind Vercel bot protection; the CLI ships
Chrome-fingerprint HTTP transport to get through, which makes it structurally
fragile to an upstream change.

### Can MCP Market find better tools for this app? No — wrong layer.

Two structural reasons, both about how this app is actually built:

1. **MCP servers cannot reach the agents.** Jessi, the Judge and the Scalper run
   on DeepSeek through `groq-agent.js` — an OpenAI-shaped tool loop that can only
   call schemas registered in `JESSI_TOOLS` / `ALL_TOOLS`. That is not MCP. The
   app has exactly **one** MCP integration: `mcp-bridge.js` spawning
   `tradingview-mcp` as a child process, with its own heartbeat and a
   `tvConnected` state kept deliberately separate from child-process liveness.
   A second MCP server means teaching that bridge to multiplex — real work on a
   process that runs live trading sessions.

2. **The known gaps are not in that catalog.** They are specific and already
   identified: FRED needs an API key; `classifyTrendStrength()` needs extracting
   from `server.js` before the PO3 base rates firm up; Kalshi data needs a Kalshi
   account. No MCP server addresses any of them.

Anything MCP Market surfaces plugs into **Claude Code or Claude Desktop**, not
into MNQ-CoPilot — the same builder-vs-product split as the `pp-*` agent skills.
It is a workflow tool for whoever is building, not a capability source for the
app.


---

## The gold brief

`node cli/gold-brief.js` — MGC on its own, added 2026-09-07 at Anoop's request
("a second brief for MGC"). Also available in the app: the **Brief** tab now has
a **MNQ + MGC / Gold only** toggle.

**It is not a second engine.** `buildBrief()` now takes `{ symbols, context }`,
and `gold-brief.js` calls it with `symbols:['MGC']` and `Y.GOLD_CONTEXT`. There
is one implementation of "what counts as a sudden move" and one of "what counts
as an unusual gap"; a fix in `market-brief.js` fixes both briefs, and the two
cannot drift into disagreeing about the same MGC bar. The renderer follows the
same rule — `briefEventRiskPanel` / `briefInstrumentsPanel` / `briefContextPanel`
/ `briefAlertsPanel` in `renderer/app.js` are shared by both views.

### What gold gets that the combined brief doesn't

| Series | Why |
|---|---|
| `SI=F` silver | Feeds the gold/silver ratio |
| `TIP` TIPS ETF | **Real-yield** proxy — see the sign-convention warning below |
| `^XAU` miners | Miner sentiment, which can diverge from the metal itself |

**The sign convention is the trap.** DXY and 10Y in the combined brief are
*inverse* to gold. TIP is not: its price moves inversely to **real** yields, so
**TIP up = real yields down = gold-bullish** — the opposite direction. Gold
tracks real yields far more tightly than nominal ones, which is why TIP is here
and a nominal-yield series is not. A test asserts TIP's `why` string still says
"real yield", because the next person to write an alert rule off these fields
will get the direction backwards if that note goes missing.

### The gold/silver ratio

Verified 2026-09-07: `SI=F` carries the same 5m/60d depth as `MGC=F` (16,691
bars each), so the ratio is computed from a like-for-like sample rather than a
shorter series padded with gaps.

`ratioSeries()` pairs bars by **nearest timestamp**, not by array index. MGC and
SI are separate contracts on separate books — they do not always print at the
same second, and either can be missing a bar the other has. Index-pairing is
correct right up to the first gap, after which every later pair is silently off
by one bar and the ratio compares two different moments. Nothing in the output
would look wrong; the number would just quietly be false. Pairs more than 150s
apart (2.5× a 5m bar) are dropped rather than treated as simultaneous.

Reported as a value plus its own percentile and z-score — **never** as "gold is
cheap/rich versus silver". That would be a directional call, and this tab has
none by design.

First live run: ratio **67.067** (MGC 4476.6 / SI 66.75), 11th percentile of the
last 60 days, −0.92σ against its own recent mean.

