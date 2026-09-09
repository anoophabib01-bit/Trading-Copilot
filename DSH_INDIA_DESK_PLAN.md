# Build queue for DSH — India Desk, 2026-09-06

**Contract:** same as `CLAUDE_TASKS_FOR_DSH.md`. DSH implements, Claude verifies. Every task has a
machine-checkable **ACCEPTANCE** block.

**Goal, in Anoop's words:** *"can we use it complete saparte from this app with a swap or a different
page?"* — asked about the NSE India CLI. Offered three shapes (tab / terminal script / separate page
on its own port); he chose **separate page, own port**.

**That choice is the specification, not a preference.** An India tab inside the co-pilot would be
firewalled by convention — someone has to remember never to wire NSE data into
`buildJessiContext()`, the Judge, or a `TRADE_TICKET`. A separate process is firewalled
*structurally*: it cannot leak because it is not in the address space. Every task below has to
preserve that property, and I0.1 makes it machine-checkable.

**Ordering is forced by calendar time, not effort.** Read I0 before anything else.

---

## Reference — what the NSE CLI actually returns today

Measured 2026-09-06 by direct invocation through `cli/market-cli.js`. Not read from the docs; half
of the below contradicts them.

**Binary is at** `%LOCALAPPDATA%\Programs\PrintingPress\bin\nse-india-pp-cli.exe` and is **not on
PATH**. Resolve it from `cli/cli-paths.json` via `cli/market-cli.js`. Never `exec` it by bare name —
`START CO-PILOT.bat` has a different PATH than a dev shell, so a bare name is `ENOENT` at runtime.

**Live commands work:**

```
market                    ok  5 keys: giftnifty, indicativenifty50, marketState, marketcap, niftyusd
movers                    ok  20 rows x 18 fields
index-driver "NIFTY 50"   ok  15 rows: symbol, weight_pct, p_change_pct,
                                       index_point_contribution, cumulative_pct_of_move, impact
equity quote --symbol X   ok  nested at results.equityResponse[0].metaData.*
```

**Three commands are COLD and return nothing — at exit code 0:**

```
delivery-spike        -> null
delivery-divergence   -> null
sector-breadth        -> []
```

These are local-store computations, not API calls. The CLI's own troubleshooting: *"Need 20+
sessions of data: run `sync --full` daily for 4 weeks before running delivery-spike."* **They are the
only genuinely India-specific analytics in the tool** — institutional accumulation, smart-money
divergence, sector breadth. Everything else is a quote board.

**The `--agent` trap — this one bit us.** `--agent` expands to
`--json --compact --no-input --no-color --yes`, and `--compact` "returns only key fields". Measured:

```
movers --agent   ->  rows of exactly { identifier: "PCJEWELLEREQN" }     1 field
movers --json    ->  symbol, lastPrice, pChange, totalTradedValue, ...  18 fields
```

The flag that advertises itself as the agent default silently discards the data an agent wants, with
no error. `cli/market-cli.js` was fixed on 2026-09-06 to pass the agent flags individually minus
`--compact`; `compact: true` is now an explicit opt-in. **Do not "simplify" that back to `--agent`.**

**One unresolved shape:** `indices list` returns an object with keys `{nts, stn}`, not a flat list.
Nobody has established what those are. Establish it before rendering anything from that command.

**State location:** NSE's store is currently at `~/.local/share/nse-india-pp-cli` (204 KB) because it
was run directly before the wrapper existed. Anything run through `cli/market-cli.js` relocates into
`cli/state/nse-india/`. The nightly sync in I0.2 must go through the wrapper so the store lands in
one place.

**Rate limits:** the CLI auto-backs off at 3 req/sec. For batch work pass `--rate-limit 0.5`. Exit
code `7` means rate-limited and is retryable; `cli/market-cli.js` already surfaces that as
`retryable: true`.

---

# TIER I0 — start the clock

## I0.1 — The firewall, as a test  ★ write this before the feature

The whole reason for a separate process is that NSE data cannot reach a trading decision. Encode
that as a check rather than a comment, so a future refactor that quietly adds an import fails CI
instead of shipping.

**Do:**
1. Create `cli/india-desk/` — everything for this feature lives there, per Anoop's standing
   instruction that all CLI-related work stays under `cli/`.
2. Add `cli/test/india-firewall.test.js` asserting, over every file in `cli/india-desk/`:
   - no `require` or `import` whose resolved path enters `app/` — no `../app`, no `../../app`, no
     `app/server`, no dynamic `require(variable)` at all;
   - the string `handleTradeConfirm` appears nowhere;
   - the string `TRADE_TICKET` appears nowhere;
   - no `require('ws')` — this page is HTTP-only and must not join the app's WebSocket bus.
3. The check walks the directory, so a file added later is covered without editing the test.

**Why a string check and not a design note:** `market-cli.js` already carries the "may block, never
permit" doctrine in a header comment. A comment did not stop `--agent` from silently degrading every
caller for a day. Machine-checkable beats documented.

**ACCEPTANCE:**
- `node --test "cli/test/*.test.js"` passes with the new file present.
- Deliberately adding `const x = require('../../app/server.js')` to any file under
  `cli/india-desk/` makes the suite **fail**. Revert after demonstrating.

## I0.2 — Nightly `sync --full`  ★ do this first; it is the only task where waiting is the cost

`delivery-spike`, `delivery-divergence` and `sector-breadth` need **20+ sessions** of local history.
Nothing can shorten that. If the sync starts the day the page ships, the page's most interesting
half is empty for four more weeks; if it starts today, the page arrives with the data already warm.

This is the same ordering logic as `DSH_TRADE_FORENSICS_PLAN.md` F0.2 — the archive had to start
before the analytics that read it.

**Do:**
1. `cli/india-desk/sync.js` — runs `sync --full` through `cli/market-cli.js` (so the store lands in
   `cli/state/nse-india/`), with `--rate-limit 0.5`.
2. Append one line per run to `cli/state/nse-india/sync-log.jsonl`:
   `{t, ok, durationMs, exitCode, rowsBySeries}` — so "has this actually been running" is answerable
   from disk, not from memory.
3. Schedule it once daily after the NSE close (15:30 IST) — Windows Task Scheduler, or a
   `setInterval` in the desk server if it is left running. Whichever, it must survive a reboot.
4. Sync only. It must not render, alert, or notify.

**ACCEPTANCE:**
- `node cli/india-desk/sync.js` exits 0 and appends exactly one line to `sync-log.jsonl`.
- After two runs on different days, `sync-log.jsonl` has two lines with distinct `t`.
- `cli/state/nse-india/` exists and is non-empty (proves the wrapper's relocation is in effect and
  the store is not still landing in `~/.local/share/`).
- A deliberate network-off run appends a line with `ok:false` and a non-zero `exitCode` rather than
  writing nothing.

---

# TIER I1 — the page

## I1.1 — `cli/india-desk/nse.js`, the adapter

Pure-ish: calls `cli/market-cli.js`, returns normalised objects. No HTTP, no HTML, no rendering.

**Do:**
1. `getMarketStatus()` — from `market`. Return `{niftyLast, niftyChange, niftyPctChange, status,
   giftNifty:{last, pctChange, timestamp}, usdInr, marketCapCr, asOf}`. Read the real keys:
   `indicativenifty50.finalClosingValue` / `.perChange` / `.status`, `giftnifty.LASTPRICE` /
   `.PERCHANGE` / `.TIMESTMP`, `marketState[]` for per-segment open/closed.
2. `getMovers(limit=20)` — from `movers`. Project `{symbol, lastPrice, pChange, totalTradedValue,
   dayHigh, dayLow, yearHigh, yearLow}`.
3. `getIndexDrivers(index='NIFTY 50')` — from `index-driver`. It returns a **bare array**, not an
   envelope; `market-cli.js` handles that, but do not assume `.results`.
4. `getColdSignals()` — calls all three cold commands and returns
   `{deliverySpike:{state, rows}, deliveryDivergence:{...}, sectorBreadth:{...}}` where `state` is
   one of `'ready' | 'cold' | 'error'`. **`empty` at exit 0 must map to `'cold'`, never to an empty
   `'ready'`.** This is the single most important line in the adapter — see I1.2.
5. Every function returns `{ok, data, error}` and never throws.

**ACCEPTANCE:**
- `node -e` calling each function prints real values: `niftyLast` is a number > 10000,
  `getMovers()` returns 20 rows each with a numeric `lastPrice`, `getIndexDrivers()` returns ≥10
  rows each with `cumulative_pct_of_move`.
- `getColdSignals()` today returns `state:'cold'` for all three, with `rows: []` — and **not**
  `state:'ready'`.
- Unit test with a stubbed `run()` returning `{ok:true, empty:true, data:null}` asserts `'cold'`.

## I1.2 — The server and page

**Do:**
1. `cli/india-desk/server.js` — plain `node:http`, **GET only**, bound to `127.0.0.1`, port from
   `INDIA_PORT` env with default **7434** (7433 is the co-pilot; `MNQ_PORT` is its override and the
   precedent for this pattern).
2. Reject any method that is not GET with 405. There is no write path in this feature and there must
   not be one.
3. Two routes: `/` serves the page, `/api/desk` returns the JSON from I1.1.
4. Cache the payload for 60s — NSE is closed most of the time Anoop is at the desk, so re-spawning
   the CLI on every reload is pure waste.
5. `cli/india-desk/index.html` — self-contained, no CDN. Sections: market status band (with GIFT
   Nifty called out — it trades ~21h and is the only line here with any overnight relevance),
   movers table, index-driver table with `cumulative_pct_of_move`, and the cold-signals panel.
6. **Render IST, and show whether NSE is open.** Cash session is 09:15–15:30 IST. A page showing a
   stale close as if it were live is the failure this whole exercise is meant to avoid.

**The cold-signals panel is not optional and not cosmetic.** It must say, explicitly, one of:
- *"Institutional accumulation: NOT AVAILABLE — needs 20+ synced sessions, currently N."*
- the real rows, once warm.

It must never render an empty result as "no accumulation detected". An unsynced store and a calm
market produce identical output, and that ambiguity is exactly the class of bug that made
`prediction-goat` look healthy while returning nothing (see `cli/README.md`).

**ACCEPTANCE:**
- `INDIA_PORT=7434 node cli/india-desk/server.js` starts, and `curl -s localhost:7434/api/desk`
  returns JSON with a numeric `niftyLast`.
- `curl -X POST localhost:7434/api/desk` returns **405**.
- `curl -s localhost:7434/api/desk | grep -c '"state":"cold"'` returns **3** today.
- The rendered page contains the literal string `NOT AVAILABLE` while the store is cold.
- The co-pilot on 7433 is **untouched**: `netstat -ano | grep 7433` shows the same PID before and
  after the desk is started and stopped.

## I1.3 — `START INDIA DESK.bat`

Repo root, beside `START CO-PILOT.bat` — that is where launchers live in this repo.

**Do:** launch `node cli/india-desk/server.js`, wait for the port to listen, open a browser at
`http://localhost:7434`. Do **not** kill node processes, do **not** touch TradingView, do **not**
assume the co-pilot is running. This desk is independent of both.

**ACCEPTANCE:** double-clicking it with the co-pilot **not** running opens a working page. Doing it
with the co-pilot running leaves 7433 serving normally throughout.

---

# TIER I2 — only once the store is warm (≈4 weeks after I0.2 starts)

## I2.1 — Turn the cold panel live

When `getColdSignals()` starts returning `state:'ready'`, render `delivery-spike`,
`delivery-divergence` and `sector-breadth` properly.

**Do:** show the CLI's own fields; do not invent derived scores. Read each command's `--help` for the
real output shape before writing the renderer — the shapes in `PRINTING_PRESS_INTEGRATION.md` are
**invented and wrong** (`index-driver` alone was documented as an object with `concentrationRatio`
and is really a flat array). Treat that file as a command inventory only.

**ACCEPTANCE:** with a warm store, all three panels render non-empty; each displayed field is
traceable to a key in the raw CLI output, verified by diffing the rendered numbers against
`nse-india-pp-cli delivery-spike --json`.

---

# What is explicitly OUT of scope

- **Any link between India data and an MNQ decision.** Not a signal, not a context line, not a
  confidence adjustment. The earlier claim that Indian institutional flow leads MNQ by 2–3 sessions
  has **no backtest behind it**, and the timing runs the wrong way: NSE cash closes 15:30 IST, US
  cash opens 19:00–20:00 IST, so NIFTY's print is largely a *response* to the prior US session.
  This desk is an India research surface. That is all it is.
- **Any write path.** No orders, no journal entries, no alerts into the co-pilot's chat.
- **Telegram or push notification.** Nothing here is urgent enough to interrupt a trading session.
- **Moving the binaries into `cli/`.** They stay in the printing-press install root; the installer
  owns that directory and an upgrade replaces them there. `cli/cli-paths.json` is the pointer.

---

# Verification Claude will run on handback

```bash
node --test "cli/test/*.test.js"          # incl. the I0.1 firewall test
node cli/india-desk/sync.js                # exit 0, one new log line
INDIA_PORT=7434 node cli/india-desk/server.js &
curl -s localhost:7434/api/desk | node -e '...'   # niftyLast numeric, 3x state:cold
curl -s -o /dev/null -w '%{http_code}' -X POST localhost:7434/api/desk   # 405
netstat -ano | grep 7433                   # co-pilot PID unchanged
```

Plus a read of every file under `cli/india-desk/` for imports that reach `app/`.
