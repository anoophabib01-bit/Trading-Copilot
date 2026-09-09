# India Desk — DSH handoff, 2026-09-06

**Built by DSH against `DSH_INDIA_DESK_PLAN.md`. Contract: DSH implements, Claude verifies.**

## What landed

| Tier | File | Status |
|---|---|---|
| I0.1 | `cli/test/india-firewall.test.js` | DONE. Walks `cli/india-desk/`, fails on any import resolving into `app/`, any dynamic require, or the strings handleTradeConfirm / TRADE_TICKET / `require('ws')`. **Demo done:** temp file with `require('../../app/server.js')` failed the suite; deleted → pass. |
| I0.2 | `cli/india-desk/sync.js` | DONE (corrected by measurement — see §1). `sync --full --resources indices,index_constituents,equity --db cli/state/nse-india/data.db --rate-limit 0.5`, one line per run to `sync-log.jsonl`. NOT YET SCHEDULED via Task Scheduler. |
| I1.1 | `cli/india-desk/nse.js` | DONE. getMarketStatus / getMovers / getIndexDrivers / getColdSignals + isNseOpen + readSyncedSessions. Empty-at-exit-0 → 'cold', never 'ready'. |
| I1.2 | `cli/india-desk/server.js` + `index.html` | DONE. node:http GET-only, 127.0.0.1, INDIA_PORT default 7434, 60s cache, POST → 405. Page: market band (GIFT Nifty), movers, index-driver (cumulative_pct_of_move), cold panel ("NOT AVAILABLE — needs 20+ synced sessions, currently N"), IST + open/closed. |
| I1.3 | `START INDIA DESK.bat` | DONE. Repo root. Launches server, waits for port, opens 7434. Does not kill node / touch TradingView. |

`cli/market-cli.js` gained `runNdjson()` — `sync` emits NDJSON events; `run()`'s single `JSON.parse` would fail on it.

## Verification already run

- `node --test "cli/test/*.test.js"` → **36 tests, 36 pass**.
- Server smoke test: `/api/desk` numeric `niftyLast=23897.7`, 20 movers, POST → 405, `/` → 200, three cold signals → 'cold'.
- Firewall demo: adding `require('../../app/server.js')` fails the suite; revert passes.

## The three things measured that the plan got wrong (all corrected in code)

### 1. `sync --full` (no --resources) syncs ONE resource, not "everything"

Measured: `sync --full` and `workflow archive --full` with no `--resources` both synced exactly `indices` (1 record, ~400ms) and stopped. `sync.js` now passes `--resources indices,index_constituents,equity` explicitly, which correctly attempts all three (verified: sync_summary reports `resources:3, success:1, errored:2`). The log line now also records `resources/success/errored` so a silent partial failure is visible on disk.

### 2. equity + index_constituents are cookie-gated — the 20-session clock cannot start without `auth login --chrome`

`equity` and `index_constituents` (the data `delivery-spike`, `delivery-divergence`, `sector-breadth` and `index-driver` read) **error** during sync; only `indices` succeeds. `auth status` reports "No browser cookie configured. Run: nse-india-pp-cli auth login --chrome". The pre-existing 204 KB store at `~/.local/share/nse-india-pp-cli` has `index_constituents: 50` + `equity: 17` from an earlier direct run, but the relocated store starts empty and cannot reproduce those until the cookie is imported.

**Action for Anoop/Claude (one-time):** `nse-india-pp-cli auth login --chrome` (or via the wrapper so the cookie lands in `cli/state/nse-india/`), then `node cli/india-desk/sync.js`. Until then the desk correctly shows index-driver empty and all three signals "NOT AVAILABLE" — the honest cold state, not a bug.

### 3. Store relocation does NOT come from the wrapper env — it is explicit `--db`

`market-cli.js`'s `childEnv` sets XDG/<NAME>_HOME, but the NSE CLI hardcodes `~/.local/share/nse-india-pp-cli/data.db` for its SQLite db and ignores those vars. So `sync.js` and every local-store reader (`index-driver`, `delivery-spike`, `delivery-divergence`, `sector-breadth`) pass `--db cli/state/nse-india/data.db` explicitly. `market`/`movers` are live-API and take no `--db`.

## Remaining (not DSH this pass)

- **`auth login --chrome`** (one-time, above) — unblocks the sync.
- **Schedule I0.2** — Windows Task Scheduler daily after 15:30 IST: `node G:\MNQ-CoPilot\cli\india-desk\sync.js`. Survives reboot.
- **I2.1** — turn the cold panel live once warm; read each command's `--help` for real shapes (`PRINTING_PRESS_INTEGRATION.md` shapes are invented and wrong).
- **Out of scope, restated** — no India→MNQ link, no write path, no Telegram, binaries stay in the printing-press install root.

---

# Claude verification, 2026-09-06

**Verdict: all three corrections CONFIRMED by independent measurement. Build accepted.**

## DSH's build, re-verified

| Check | Result |
|---|---|
| `node --test "cli/test/*.test.js"` | **36/36 pass** |
| Firewall test is real, not decorative | Injected `require('../../app/server.js')` into `cli/india-desk/` → **35 pass, 1 fail**. Removed → 36/36 |
| `GET /api/desk` | **200**, `niftyLast: 23897.7`, 20 movers rows |
| `POST /api/desk` | **405** |
| Cold signals | **3× `"state":"cold"`** |
| `indexDrivers` | **0 rows** — consistent with the cookie gate, not a bug |
| Co-pilot on 7433 | untouched throughout |

## The three corrections, independently re-measured

**1. `sync --full` with no `--resources` — CONFIRMED.**
```
{"event":"sync_complete","resource":"indices","total":1,"duration_ms":362}
{"event":"sync_summary","total_records":1,"resources":1,"success":1,"errored":0}
```
One resource, one record, then it stops. Passing `--resources` explicitly is correct.

**2. Cookie gate — CONFIRMED verbatim.** `auth status` →
`Not authenticated. Run: nse-india-pp-cli auth login --chrome`.

**3. Env relocation doesn't work — CONFIRMED, and it is BROADER than DSH reported.**
`doctor` with and without the exact vars `childEnv()` sets:

| CLI | Without env | With env |
|---|---|---|
| `nse-india` | `~/.local/share/nse-india-pp-cli/data.db` | **identical** |
| `yahoo-finance` | `~/.local/share/yahoo-finance-pp-cli/data.db` | **identical** |

So this was not an nse-india quirk — **`childEnv()` was a no-op on both installed CLIs**, and the
claim that it relocated storage was mine, asserted without testing. The four-path-kind ladder is
documented only on the *newer* catalog pages (`fpi-india`, `benzinga`, `mcpmarket`) and absent from
these two: a per-CLI capability the wrapper treated as universal.

## Corrected in response

- **`cli/market-cli.js`** — `childEnv()`'s comment now states the measured truth instead of the
  false claim. Added `dbPathFor(name)` and a **first-class `db` option** on both `run()` and
  `runNdjson()`: `db: true` appends `--db cli/state/<name>/data.db` and creates the directory;
  `db: '<path>'` overrides. Verified: `index-driver` with `db:true` sends
  `--db G:\MNQ-CoPilot\cli\state\nse-india\data.db`, and `movers` without it still returns 20 rows.
  **DSH can now drop the hand-passed `--db` strings in `sync.js` and `nse.js` in favour of
  `{ db: true }`** — same behaviour, one place to change it.
- **`cli/README.md`** — the three relocation claims corrected, plus new Verified-facts entries for
  the env finding, the one-resource `sync --full`, and the cookie gate.
- **`cli/cli-paths.json`** — `nse-india` note now carries the cookie gate, the `--resources`
  requirement, and the no-env-relocation rule.

## Still open

1. **`auth login --chrome`** — one-time, needs a human with a browser. Nothing in the 20-session
   clock starts until this is done. **This is the single blocking item.**
2. **Schedule the sync** — Task Scheduler, daily after 15:30 IST, must survive reboot.
3. **The old 204 KB store** at `~/.local/share/nse-india-pp-cli` holds `index_constituents: 50` and
   `equity: 17` from an earlier direct run. Worth checking whether copying `data.db` into
   `cli/state/nse-india/` seeds the clock 50 sessions early — it may be stale or schema-mismatched,
   so verify before relying on it. Cheap to test, and it could save four weeks.
