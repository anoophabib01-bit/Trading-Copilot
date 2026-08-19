# Semi-Autonomous System — Hardening Plan (current, already partially active)

Status: this system already runs today. Debate → Judge → TRADE_TICKET → your
confirm click → `handleTradeConfirm` → real order is real, gated, and has
been live-tested (see `PHASE2_SEMI_AUTONOMOUS_SPEC.md`, `TODOS.md`). What's
broken isn't the confirm/execute flow — it's the **data feed underneath it**,
which is why trade counts, balance, and warnings keep going wrong even though
the order-placement path itself works.

## The core problem, stated once

There are 5 links in the chain from your click on TradingView to a number on
your screen:

```
1. TradingView Desktop DOM (Trading Panel tables)
2. tradingview-mcp (reads the DOM over CDP)
3. mcp-bridge.js (owns the CDP connection + heartbeat)
4. app/server.js (polls, folds trades, computes state)
5. app/renderer/app.js (displays it, warns you)
```

**Every one of these links has, today, been observed to fail silently** —
not loudly, not visibly, silently. That's the actual root cause behind every
symptom in this conversation:

| Symptom you hit | Which link failed | How it failed silently |
|---|---|---|
| "0 trades" after a real session | Link 1→4 | `getAccount()` hardcoded `success:true`; an unread positions table looked identical to "genuinely flat" |
| Account "reset" on slot switch | (separate: persistence, not the live chain) | config blob didn't carry the disk-authoritative ledger |
| "Connection may have dropped" on CSV upload | (separate: chat layer) | one failed turn poisoned every future turn — alternation never enforced |
| Balance drifting from broker's real number | Link 4→5 | app recomputes from ledger math, never reconciles against the literal DOM balance |
| Whole session showing nothing | Link 4 (the whole process) | **the server itself crashed and nobody was told** |
| Auto-recovery not bringing TradingView back | Link 3 | `readdirSync` on an ACL-locked folder threw, was swallowed, candidate list was silently empty forever |

Five different failure classes, five different bugs, one shared root cause:
**no link in the chain asserts its own health out loud.** A link either works
or it returns something that looks exactly like "nothing happened yet" — and
downstream code can't tell the difference.

## What's fixed already (2026-08-18/19, this session)

- Link 1→4: `getAccount()` now reports `degraded`/`unreadable[]`; the server
  refuses to fold a trade unless the positions table genuinely read.
- Link 4: poll-aliasing backstop — a trade that opens+closes between two 10s
  polls is inferred from the balance delta instead of vanishing.
- Link 4→5: raw DOM balance is now compared against the computed balance
  every tick; a >$1 divergence bannered and shown continuously in the HUD.
- Link 3: TradingView path resolution no longer silently fails on Windows'
  WindowsApps ACL restriction (was the literal reason auto-recovery could
  never find TradingView to relaunch it).
- Link 3: a single slow health probe no longer flips the connection to
  "dead" — requires 2 consecutive failures (contention-tolerant).
- Whole-chain observability: `mcp-bridge.js` went from **zero** console
  output to full connect/disconnect/recovery logging. This is what let last
  night's silent server crash actually be *found* instead of guessed at.
- Chat layer: conversation self-heals from a poisoned/orphaned turn instead
  of failing forever.
- Account persistence: disk (`accounts/<slot>/*.json`) now overlaid on every
  slot load, not just at boot; autosave every 30s + on tab-hide/unload.

## Done 2026-08-19, needs live verification

All 5 items below (from the "not yet fixed" plan, renumbered 1-5 here to
match TODOS.md/this build pass) are now built and unit/syntax-verified.
None have been exercised in a real live trading session yet — this section
states exactly what to watch for when doing that.

### 1. Server-process watchdog + crash alerting

**Built:** `app/watchdog.js` — a standalone, dependency-free Node process
(no npm packages, just `http`/`child_process`/`fs`), separate from
`server.js` on purpose so a crash in the app can never take the watchdog
down with it. Polls `http://localhost:7433/` every 45s (10s HTTP timeout).
On failure: logs to `app/logs/watchdog-YYYY-MM-DD.log`, pops a Windows modal
via `msg.exe *` (built-in, no new dependency — fails soft with a log line if
`msg.exe` is unavailable), and attempts exactly one relaunch via
`launch.bat` (spawned detached so the watchdog isn't tied to the launched
window), gated by a 5-minute cooldown so a crash loop can't spam relaunches.
Telegram was deliberately NOT touched (per the 2026-08-11 decision, still
respected). Wrapped in its own `uncaughtException`/`unhandledRejection`
handlers that log-and-survive, one level more paranoid than `server.js`'s
own crash guards. `app/watchdog.bat` is the run step — a separate optional
window alongside `launch.bat`, not wired into `START CO-PILOT.bat`, so
starting it is a deliberate extra step, not silently mandatory.

**Verified:** `node -c watchdog.js` passes. Manually traced (not run against
a live server, since starting/stopping the real server was off-limits this
session): server-down-at-watchdog-start → immediate first poll fires,
`alertedThisOutage` gates the alert/relaunch to once per outage, cooldown
prevents relaunch spam on a crash loop, recovery clears `consecutiveFailures`
and re-arms the alert for the *next* outage.

**WHAT ANOOP SHOULD TEST LIVE:**
- Run `app/watchdog.bat` alongside a normal session, then manually kill the
  `node server.js` process (Task Manager) — confirm within ~45s: a Windows
  msg.exe popup appears, `app/logs/watchdog-<date>.log` has the failure line,
  and `launch.bat` fires to bring the server back up.
- Kill it twice within 5 minutes — confirm the SECOND kill does not trigger
  a second relaunch attempt (cooldown log line should say so).
- Close the watchdog window itself — confirm the actual server is
  unaffected (they are fully independent processes).

### 2. Inferred-trade guard fix

**Built:** `app/renderer/size-freeze-guard.js`'s `sizeUpAfterLossViolation()`
now checks `prev.inferred === true` (the poll-aliasing backstop from
`tv-broker-feed.js`'s `fold()`) and, when true, substitutes the day's
largest previously-known size (scanning every earlier trade, inferred or
not) instead of trusting the inferred trade's `size:0` — "unknown size,
assume worst case" per the task's instruction, since 0 would silently read
as "tiny" and let a real size-up-after-loss through. Falls back to 0 only
when there is truly no other size data that day (can't invent one).

**Unit-tested:** 5 new tests added to `app/test/size-freeze-guard.test.js`
(now 14 total, all passing) — inferred loss + newSize above day maxSize
triggers; inferred loss + newSize below day maxSize does not; an inferred
trade with no prior known size falls back to 0 and still flags any positive
size; an inferred WIN never triggers regardless of substitution; and an
explicit regression check that every original (non-inferred) test case's
behavior is byte-for-byte unchanged.

**WHAT ANOOP SHOULD TEST LIVE:** this is a pure-logic fix with no new live
surface — the thing to watch for is the *absence* of a false negative: if a
scalp completes fully between two 10s polls (the exact condition that
produces an `inferred:true` trade) and is followed by a real size-up, the
HUD's hard-stop ("LIVE SIZE-UP RIGHT AFTER A LOSS") should still fire. No
action needed unless that specific sequence occurs and does NOT trigger.

### 3. Startup self-test (3 checks)

**Built:** `runLiveFeedSelfTest()` in `app/server.js` (near
`pollTVBrokerAccount()`/`startTVBrokerMonitor()`), scheduled 15s after
`mcpBridge`'s `tv-connected` event AND re-run on every subsequent
reconnect (not just once at boot) via `scheduleLiveFeedSelfTest()`. Checks:
(1) CDP reachable — folds in the existing `mcpBridge.ready`/`tvConnected`
state rather than re-probing; (2) broker panel readable — one
`trading_get_account` call (routed through `withChartLock`, same lock every
other chart-mutating/-reading caller uses) checking `positions.success` /
`orders.success` / `summary.success`; (3) synthetic fresh-quote check — one
`quote_get` call, passes only if it returns `success:true` with a numeric
`last`/`close`. Broadcasts `{type:'live-feed-self-test', passed, total:3,
failures:[...]}`. Client: `ws-client.js` carries it as
`onLiveFeedSelfTest`; `app.js` renders it into a new persistent (not toast)
`#live-feed-selftest` line under the TradingView status dot in
`index.html`, e.g. "Live feed: 3/3 checks passed" in green, or naming
exactly which check(s) failed in red.

**Verified:** `node -c server.js`/`app.js`/`ws-client.js` all pass; full
432-test suite still green (no pure-logic extraction was possible here —
this is inherently a live-TradingView-dependent integration, stated
honestly rather than faked with a unit test).

**WHAT ANOOP SHOULD TEST LIVE:**
- On a fresh app launch with TradingView already connected, confirm the
  line appears ~15s after connect and reads "3/3" when the Trading Panel is
  open and a fresh quote is available.
- Close the Trading Panel (or unlink the broker) and force a reconnect
  (toggle TradingView's CDP, or restart the bridge) — confirm the line
  updates to show the broker-panel check failing by name, not just a
  generic failure.
- Confirm the line updates again on the NEXT reconnect after re-opening the
  panel, without needing an app restart.

### 4. Three-way reconciliation: trade count (extends the existing balance recon)

**Built:** `pollTVBrokerAccount()` in `server.js` now also computes
`brokerFilledCount` (the orders table's own `Status === 'Filled'` rows —
literal, independent of `fold()`'s inference logic) alongside
`foldTradeCount` (`tvBrokerFeedState.tradeCount`), and broadcasts
`tradeCountMismatch: true/false` on the existing `tv-broker-account`
message, tolerance 0 per the task's instruction. Client: `grIngestLive()`
in `app.js` fires an amber banner on a mismatch transition (same
once-per-transition pattern as the existing `domMismatchNotified` balance
banner) and a new `⚠ COUNT broker X vs tracked Y` HUD tag next to the
existing `⚠ TV DOM` tag — same visual language, so the two reconciliation
signals read as one family. **Enforcement is untouched** — `s.live.tradeCount`
and the fold's enforcement path are exactly as before, per the task's
explicit instruction that this is visibility-only.

**Honest caveat documented in the code:** a single closed round trip can
show as 2 filled order rows (entry + exit), so this is not guaranteed to be
a clean 1:1 match even when nothing is wrong — it is best read as "did the
count move together," not as an exact equality that must always hold.

**Verified:** syntax-checked, full test suite green. No new pure-logic to
unit-test here (the comparison itself is a one-line `!==`); the trade-count
extraction logic it depends on (`fold()`) already has its own 13-test
coverage in `tv-broker-feed.test.js`, unchanged by this addition.

**WHAT ANOOP SHOULD TEST LIVE:** during a real session with several closed
trades, watch the new HUD tag and compare it by eye against what you
already do manually across your 3 monitors — does a mismatch ever appear
when the trade count actually agrees (false positive, check the 2-rows-per-
round-trip caveat above), and does it ever STAY silent when you can see by
eye by eye the counts differ?

### 5. Confirm-flow blind spots

**Already built earlier the same day** (found already present and working
in this checkout when this pass started; verified rather than rebuilt):
- **5a — `grResetDay()` hardening:** `app.js` now requires typing "i am
  done" (matching `grAckStop()`'s existing phrase) before clearing an
  ACTIVE stopped state; a routine reset with nothing stopped stays a plain
  `confirm()`.
- **5b — `placeMarketOrder()` post-submit verification:**
  `tradingview-mcp/src/core/trading.js` now polls `getPositions()`/
  `getOrders()` up to 6 times (300ms apart, ~1.8s total) after the submit
  click, looking for a matching position or a Working/Filled order before
  returning; returns `verified:false` (never silently swallowed) if nothing
  turns up in the window.
  - **Closed a gap found while verifying this item:** `handleTradeConfirm`
    (`server.js`) was computing `verified`/`verifyDetail` but never
    forwarding them in the `trade-confirm-result` WS message — a caller had
    no way to tell an actually-confirmed fill apart from an unconfirmed
    submit, both looked like plain `success:true`. Fixed same pass: both
    fields are now forwarded, and `app.js`'s `tcHandleResult()` renders
    `verified:false` as a distinct amber "⚠️ submitted but NOT CONFIRMED —
    check the broker panel manually" state instead of the same flat ✅.
- **5c — TP/SL passthrough test scaffold:** `tradingview-mcp/tests/trading.test.js`
  covers argument validation (rejects non-positive `stopPrice`/`targetPrice`
  before any DOM call) via `node:test`'s `mock.module` on `connection.js`'s
  `evaluate()`. Honestly scoped: the actual DOM click/set/readback sequence
  is stated as NOT meaningfully unit-testable (no fake TradingView DOM
  exists in this repo, and building one would only prove a fake behaves as
  scripted) — that part stays live-verified only, per the existing header
  comment on `placeMarketOrder()`.

**Verified:** `node --input-type=module -e "import(...)"` equivalent via
`npm run test:unit` in `tradingview-mcp` — 27/29 passing (the 2 failures are
the pre-existing unrelated `cli.test.js` Windows exit-code issue, not
related to this work).

**WHAT ANOOP SHOULD TEST LIVE:**
- Trigger `grResetDay()` while stopped — confirm the phrase prompt appears
  and a wrong/empty answer leaves the stop in place.
- Confirm a real small trade and manually check the server log / UI for the
  `verified`/`verifyDetail` fields — do they read true with "matching
  position found" (or "matching order found") shortly after a real fill?
- Deliberately test an ambiguous case if you can safely construct one (e.g.
  a very slow fill) — does the flow correctly say `verified:false` instead
  of falsely claiming success?

## Live verification, 2026-08-19 — real trades, real bugs found and fixed

Anoop placed real test trades during NY pre-session to verify this build
end-to-end, as planned. Two genuinely new bugs surfaced that no amount of
unit testing or code reading would have caught — both found because the
live data didn't match what the app showed, and pushed on rather than
accepted. This section is the precise record, kept so the same class of
mistake gets caught faster next time instead of re-discovered from scratch.

### Bug 6 — `tvBrokerFeedState` lived only in memory; a restart silently wiped today's trade tracking
**Symptom:** Anoop closed a real round-trip trade (Buy 12:53:55 → Sell
12:58:29 IST). The server was restarted twice after that (debugging earlier
items), both restarts landing after the trade had already closed. HUD read
"0 trades" despite 3 real fills visible in TradingView's own orders table.

**Root cause:** `tvBrokerFeedState` (dayPnl/tradeCount/trades/
balanceAtLastFlat — everything the live feed knows) was a plain in-memory
`let`, never written to disk. Every restart reset it via `freshState()`. The
fold's balance-delta method can only score a not-flat→flat transition it
personally observed — a trade that closed entirely before a given server
instance's first poll is invisible to that instance, permanently, by design.

**Fix:** `loadTVBrokerFeedState()`/`persistTVBrokerFeedState()` in
`app/server.js`, backed by the existing `dataSave`/`dataLoad` atomic-write
pattern, persisting to `DATA/tv_broker_feed_state.json`. Persisted on every
poll (not just on a trade close), so `wasFlat`/`balanceAtLastFlat`/
`sizeSeenThisTrade` survive a restart mid-trade too, not only the completed-
trades list.

**A bug caught in my own fix before shipping it:** the load call was
originally written to run at module top-level (`let tvBrokerFeedState =
loadTVBrokerFeedState()`), which executes before `initDataDir()` runs inside
the startup callback — `DATA_DIR` can be redirected by `initDataDir()` to a
different real directory (e.g. a `D:\` drive), so loading eagerly would read
from the pre-redirect fallback path while saving went to the real one,
silently pointing load and save at two different directories. Fixed by
moving the load call to right after `initDataDir()`, before
`startTVBrokerMonitor()` begins polling.

### Bug 7 — a trade that closed before this server instance polled it is recoverable — I initially said it wasn't
When Anoop asked "why doesn't the HUD show the 1 trade that closed before
this fix landed — isn't that a gap too?", the first answer given ("permanently
invisible, use CSV to backfill") was wrong. The exact data needed — side,
size, entry price, exit price, timestamps — was sitting in TradingView's own
orders table the whole time, unaffected by any server restart. Deflecting to
CSV was giving up one step too early.

**Fix:** `reconstructClosedTradesFromOrders()` in `app/tv-broker-feed.js` —
pairs sequential Filled entry+exit order rows per symbol (position returns to
flat = closed round trip), reconstructed once per IST day
(`backfillDone` flag, persisted, so a later restart never re-runs it and
double-counts against trades the live fold has since observed for real).

**Deliberately NOT computed: dollar P&L for backfilled trades.** A Filled
order row carries no realized-P&L column (this is exactly why the live path
uses balance-delta instead of reading P&L directly), and no verified
per-contract point/tick-value multiplier exists anywhere in this codebase to
convert an entry/exit price difference into dollars. Inventing one under
time pressure would have replaced a visible gap (0 trades) with an invisible
wrong number (a guessed $ figure) — worse, because a guessed number looks
trustworthy. Backfilled trades carry `pnl: 0, pnlUnknown: true,
source: 'backfilled-from-orders'` — numerically neutral (doesn't corrupt
dayPnl/enforcement math) but explicitly flagged as unconfirmed. Read the
broker's own numbers for a backfilled trade's exact $ result.

### Bug 8 — found immediately after Bug 7 shipped, same session: the orders table only shows Status when the "All" sub-tab is active
**Symptom:** the newly-shipped backfill (Bug 7's fix) ran (`backfillDone`
flag set) but reconstructed zero trades, despite the exact closed round trip
being fetchable moments earlier via a direct DOM read.

**Root cause:** TradingView's orders table only populates a `Status` column
value when the "All" sub-tab is the currently-active view in the Trading
Panel. Anoop's UI was on the "Filled" sub-tab — rows in that filtered view
have real `Filled Qty`/`Avg Fill Price` data but `Status` is entirely absent.
Three separate places in this codebase matched `Status === 'filled'`
literally (the live poll's fill-count, the backfill, and by extension the
trade-count reconciliation) — all three silently found zero fills whenever
that tab happened to be active. This is not hypothetical or rare: it is
whatever tab the user (or TradingView itself) last left selected, entirely
outside this app's control.

**Fix:** `isFilledOrderRow()` in `tv-broker-feed.js` — a single shared
helper used by every caller instead of three independent copies of the same
fragile check. A row counts as filled if `Status` explicitly says so
(case-insensitive), OR if `Status` is blank/absent AND it carries a positive
`Filled Qty` AND a parseable `Avg Fill Price` (fields that are only ever
populated on an actually-filled order, regardless of which sub-tab rendered
the row). An explicit non-filled `Status` (Working/Cancelled/Rejected) is
always authoritative and short-circuits the fallback.

**Verified against the exact live data that exposed it:** 23 new tests in
`app/test/tv-broker-feed.test.js` include the real order rows from today's
session verbatim (both the "All" tab shape with explicit Status, and the
"Filled" tab shape without it) as permanent regression fixtures — 442 tests
total, all passing, after this fix.

**WHAT TO WATCH GOING FORWARD:** if the HUD ever again undercounts trades
while TradingView's own orders table clearly shows more, the first thing to
check is which orders sub-tab is currently active in the UI — that's the
exact failure mode Bug 8 was.

### Bug 9 — `withChartLock` had no timeout: one stuck call silently froze the ENTIRE live feed for hours, with the process itself staying alive
**Found by:** Anoop's own multi-hour soak test (leaving a real trade open
2-6 hours specifically to catch a silent issue) — exactly what it was
designed to catch, and it worked.

**Symptom:** ~3 hours after a restart, zero real log activity — no poll, no
self-test re-run, no PO3/Engulf/SFP monitor ticks — while an unrelated
`setInterval` (the OmniRoute health probe, pure HTTP, no CDP involved) kept
firing every 30s the whole time. The HTTP-liveness watchdog (Item 1, earlier
in this doc) would NOT have caught this: `curl http://localhost:7433/` still
returns 200, the process is genuinely alive. Only the chart/broker-feed
subsystem was frozen.

**Independently confirmed TradingView/CDP itself was NOT the problem:** a
side-channel script opened its own fresh CDP connection while the app was
frozen and got a complete, correct, real-time read (open position, correct
floating P&L, correct order history) — the chart was reachable and healthy
the entire time the app showed nothing moving.

**Root cause:** `withChartLock()` (`server.js`) — the single serialization
point EVERY chart-touching caller routes through (the broker poll, the
startup self-test, PO3/Engulf/SFP monitors, `getFullBars`, everything) — was
a bare promise chain with no timeout. If any one locked operation ever hung
(neither resolved nor rejected — a CDP-level stall, not a normal tool error,
which already had its own `_rpc()` timeout in `mcp-bridge.js`), every future
caller queued up behind it and waited forever. One bad link freezes the
entire chain, permanently, silently.

**Fix:** `withChartLock()` now races every locked operation against a 30s
timeout. On timeout: logs loudly (`[withChartLock] operation exceeded
30000ms...`), rejects that one call, and — critically — **releases the lock
so the chain advances** instead of staying stuck. The original hung
operation, if it ever does complete in the background, is deliberately
discarded (caught so it can never become an unhandled rejection, and no
future caller waits on or is affected by it). A `_chartLockTimeoutStreak`
counter tracks consecutive timeouts (resets on any success) — logged for
now; a future step could escalate a repeating streak into forcing an
`_attemptTVRecovery()`-style relaunch, but that's not built yet (a single
timeout already unblocks everything; a genuinely dead CDP connection is
still separately caught by the existing heartbeat/auto-recovery).

**Verified:** syntax-checked, full 452-test suite still green. Not
independently unit-tested — this is timer/promise-race infrastructure code
tied to real async timing, same category as the watchdog (item 1) that was
verified by logical tracing rather than a synthetic test harness. Confirmed
live by restarting: the feed resumed immediately, all monitors auto-started,
state correctly reloaded from disk.

**WHAT TO WATCH GOING FORWARD:** the `[withChartLock] operation exceeded
30000ms` log line is now the signal for "this exact class of freeze is
happening again" — if that line ever appears in the log, at most it costs one
poll cycle now instead of the rest of the session. If it fires repeatedly
(the streak counter climbing), that's worth escalating to a forced
TradingView relaunch as a follow-up.

### Bug 11 — THE SEVERE ONE: `Balance` drifts on its own while genuinely flat, fabricating trades out of pure noise
**Found by:** Anoop's rapid-fire test session, minutes after Bug 9's debate-lock
fix shipped. 20 fabricated "trades" accumulated in under 4 minutes, then kept
climbing to 36 — every single one fictitious.

**Independently proven, not assumed:** polled the live account 4 times, 3
seconds apart, with ZERO trading activity in between:
```
t=0  balance=49,876.75  equity=49,893.25  profit=-15.50  positions=0
t=1  balance=49,874.75  equity=49,893.25  profit=-17.50  positions=0
t=2  balance=49,872.25  equity=49,893.25  profit=-21.00  positions=0
t=3  balance=49,871.75  equity=49,893.25  profit=-21.50  positions=0
```
`Balance` drifted continuously and monotonically while `Equity` stayed
perfectly constant and the account was genuinely flat (0 positions) the
entire time. Whether this is a UI settle-animation, a demo-account
simulation quirk, or delayed bracket-order cleanup on this specific
Tradeify/Tradovate account was not determined — what matters is it directly
invalidates the founding assumption of the ENTIRE balance-delta-at-flat
method (stated in `tv-broker-feed.js`'s own original header comment):
that Balance is stable between real trades. It is not, on this account.

**Severity:** this is the most serious bug found today. Every number the
live feed produces — trade count, day P&L, the F1 mistake-pattern trigger,
the trade-confirm shadow check's size-up-after-loss warnings — was
corruptible by pure balance noise with zero real trading involved. The F1
pattern actually fired live off 2 fabricated "wins" during the incident.

**Fix:** the poll-aliasing backstop (Bug 9's era, 2026-08-18) now requires
`hasNewFill: true` — true only when that SAME poll's orders-table read found
a genuinely new Filled order (`newFills.length > 0`, already computed
independently in `pollTVBrokerAccount` for the "new fill detected" log line).
A real fast round-trip still has a real new fill and is still caught by the
backstop; balance drift with no matching fill no longer is. When balance
moves with no new fill, the baseline silently re-anchors to the current
value (so a LATER genuine trade's delta is computed from the settled number,
not a stale one from minutes earlier) but nothing is scored. 2 new tests in
`tv-broker-feed.test.js`, including the exact live-measured drift sequence
above as a permanent regression fixture — 454 tests total.

**A second, compounding problem found while fixing the first: restart-order
races corrupted the persisted file, twice.** Deleting/overwriting
`tv_broker_feed_state.json` while the OLD (buggy) process was still alive
for even a few more seconds let it re-persist its own poisoned in-memory
state right back — once even growing 20→36 fake trades DURING the cleanup
attempt. The second time, a genuinely NEW (fixed) process itself booted and
loaded the file HALF A SECOND before the old process's dying write finished,
inheriting the corruption into its own memory despite running fixed code —
proving code fixes alone don't repair state already poisoned before the fix
takes effect. Resolved by explicitly killing the process BY PID first,
confirming zero matching processes remained, only THEN writing the clean
file, only THEN starting fresh — kill-clean-start, not restart-then-clean.

**WHAT ANOOP SHOULD TEST LIVE:** watch the HUD `⚠ COUNT broker X vs tracked
Y` reconciliation tag during normal (non-rapid) trading — it should now
consistently agree, since fabricated trades can no longer inflate the
tracked side without a matching real fill on the broker side. If a
mismatch ever reappears with the tracked side HIGHER than the broker side,
that's this exact bug returning and should be reported immediately.

## Confirmed live, 2026-08-19 (not just built — personally watched working)

- **Playbook-setup auto-start** — `Engulf monitor started [1H]` and
  `SFP/Playbook B monitor started [30M]` both fired in the server log
  immediately on TradingView connect, with zero manual toggle, on a fresh
  restart. A real SFP raid + Playbook B confirmation fired live minutes
  later (`SFP RAID [30M]: BULLISH swept 29547.25` /
  `PLAYBOOK B CONFIRMED [30M]: BULLISH`).
- **Startup self-test** — `[self-test] live feed: 3/3 checks passed` on
  every restart, ~15-20s after connect.
- **Broker feed reading positions + orders** — confirmed against the exact
  live DOM state multiple times (direct ground-truth reads via a side-channel
  script, matched against `getAccount()`'s output).
- **Trade detection** — all 3 real fills from Anoop's test trades correctly
  detected (`3 new filled order(s) detected: MNQU6 Buy x1, MNQU6 Sell x1,
  MNQU6 Buy x1`).
- **Persistence + backfill (Bugs 6-8 above)** — the closed round trip now
  correctly shows as `tradeCount: 1` in the persisted state, survives
  restarts, with the exact entry/exit prices and timestamps recovered.

## What's still open after this build

### The balance-delta P&L math itself — verification IN PROGRESS
Anoop's second test trade is currently open, intentionally left open to
verify this exact math end-to-end: once it closes (breakeven or stop-loss),
`balance-at-close − 50022.65` (the captured baseline) should exactly match
the broker's own realized P&L for that trade. This is the actual live test
this whole document has been building toward — everything else in the live
feed sits on top of this one calculation being correct. Report the result
here once observed.

### Backfilled trades don't have a $ figure — by design, not yet solved
Bug 7 above explains why (no verified per-contract multiplier exists in this
codebase). If Anoop wants exact dollar reconciliation for a trade that
closed before the server was tracking it, the options are: (a) read it off
the broker's own orders table directly (already always accurate), or (b) a
future addition — read the account's realized-P&L figure directly from
TradingView's DOM if one becomes reliably available (the `accountSummary`
table's `detail` has read as `null` every time checked so far — not
currently a usable source on this account/broker setup).

## How to verify all of this live

1. Restart the server (`launch.bat` — leaves TradingView untouched).
2. Confirm the "Live feed: 3/3 checks passed" line appears within ~15-20s.
3. Start `app/watchdog.bat` in its own window.
4. Place a small real test trade or two, working through each item's
   "WHAT ANOOP SHOULD TEST LIVE" checklist above, in order.
5. Only mark an item genuinely done once you've personally confirmed it —
   nothing in this document should be trusted as "working" until you've
   seen it work.

See `FULL_AUTONOMOUS_SYSTEM_PLAN.md` for what comes after this system has
run reliably for a real stretch of sessions — full autonomy is explicitly
gated behind that, not behind this build being merged.

## Next requested: live mistake-tracking feedback loop, feed accessible to all agents (2026-08-19)

Anoop's ask, precisely: track his live moves while trading, gather that into
a record of what actually happened, and feed it back into the agents so a
REPEATED mistake gets caught by the current workflow instead of only being
visible after the fact in a post-session review. Separately: the live feed
(balance/positions/trades/dayPnl) should be readable by every agent, not
just the guardrail HUD.

**Scoping this before writing code** (per Anoop's own instruction — "at most
seriousness... do not identify gaps like I did just now"; rushing this is
exactly how Bugs 6-8 above happened, and those were caught only because he
pushed back on an incomplete first answer):

### What already exists, not yet connected
- `app/bias-tracker.js` — declared-bias-vs-actual-trades adherence, already
  fed into Jessi/Debate/Post-Session contexts.
- The checklist's documented failure patterns (F1-F6: trade-count escalation,
  revenge clusters, inverted R:R, holding losers, multi-instrument bad days,
  winning-day-turned-losing) and the scalping mistake log (M1-M6) — currently
  static reference text an agent can read on request, not something checked
  against LIVE trade data automatically as it happens.
- `tv-broker-feed.js`'s `trades` array (now correctly populated per today's
  fixes) already has size/pnl/timestamps per trade — the raw material this
  feature needs already exists and is now reliable, which is why this is the
  right next step rather than an earlier one.

### What's missing
1. **A live pattern-matcher** — after each trade (or each poll), check the
   day's `trades` array against the documented F1-F6/M1-M6 patterns
   (trade count vs. limit, size increasing after a loss — already exists via
   size-freeze-guard — holding time vs. the 5-minute rule, R:R inversion,
   etc.) and produce a structured "this looks like pattern Fx" signal, not
   just raw numbers.
2. **A shared live-feed accessor for agents** — right now `tvBrokerFeedState`
   lives inside `server.js`'s closure; Jessi/Debate/Scalper/Post-Session each
   build their own context separately (`buildJessiContext`,
   `gatherAnalysisContext`, etc.) and don't uniformly include live trade
   state. Needs one shared context-builder function every agent's context
   assembly calls, so "how many trades so far, what pattern is showing" is
   answered identically everywhere instead of per-agent guesswork.
3. **Where the feedback actually surfaces** — a pattern match needs to reach
   Anoop DURING the session (the whole point — "when I make the same mistake
   it feeds the current workflow"), not just get logged for later. Candidates:
   a HUD banner (same style as today's mismatch banners), a proactive Jessi
   message, or surfacing in the next Debate Judge verdict's discipline section
   (`JUDGE_PERSONA` already weighs discipline highest in its hierarchy — a
   live pattern match is exactly the kind of input that lane needs).

### Decisions (Anoop, 2026-08-19): F1 first, advisory only

### BUILT — item 1, first slice (F1 only): needs live verification
`app/mistake-patterns.js` (new) — `checkTradeCountEscalation(trades)`, pure,
10 unit tests. Cites his own documented text verbatim (`app/renderer/index.html:636`):
*"profitable days: 6-12 trades, blow-up days: 65 trades, 20% win rate...
stop at 2 good trades. Done."* Fires on WIN count reaching 2 — deliberately
NOT the same signal as `rules.json`'s `tradesPerDay` cap (5), since F1's own
text is about continuing to trade after already winning, not raw trade
volume. Backfilled trades (`pnlUnknown: true`) are excluded from the win
count — can't confirm a win we don't know the sign of.

Wired into `pollTVBrokerAccount()` in `server.js`: checked only when
`tradeCount` just increased (not every 10s poll), fires once per IST day
(`f1AdvisoryFired` flag, persisted in `tv_broker_feed_state.json` — survives
a restart, never re-fires mid-session), broadcasts a new `mistake-pattern` WS
message. Client (`ws-client.js`/`app.js`): amber banner + a permanent
chat-log line via `addSystemMessage` (not just a toast — matches every other
advisory in this app).

**WHAT ANOOP SHOULD TEST LIVE:** get 2 winning trades in a real session,
confirm the banner + chat line fire exactly once citing the F1 text, and
confirm a 3rd/4th winning trade does NOT re-fire it (once per day, by
design — repeating it every trade would just become noise).

### BUILT — item 2, first slice (Jessi only): needs live verification
`formatLiveFeedContext()` (new, `server.js`) — one shared function reading
`tvBrokerFeedState` directly (today's real trade count, confirmed vs.
order-history-recovered dayPnl, open-position status, and the F1 check
inline), wired into `buildJessiContext()` (both voice and text share this
builder). Before this, Jessi's context sourced balance/P&L purely from the
CSV-derived config bucket — never read the live broker feed at all, which is
exactly the gap Anoop flagged.

**NOT yet done** (deliberately, staged rollout — verify one integration live
before extending): `gatherAnalysisContext()`/`gatherPO3Context()` (the
Debate panel's Analysis/PO3 agents) and the Judge/Scalper/Post-Session
Analyst context builders don't call `formatLiveFeedContext()` yet. Once
Jessi's integration is confirmed working live, extending to the rest is a
small, repetitive change (same function, same one-line call per builder) —
intentionally not batched into this pass so a mistake in the shared function
itself would be caught by ONE agent misbehaving, not five at once.

**WHAT ANOOP SHOULD TEST LIVE:** ask Jessi (text or voice) something like
"how many trades have I taken today" mid-session and confirm the answer
matches the HUD's live count, not a stale CSV figure.

**Item 3 (surfacing in the Judge's discipline lane) — not started.** Once
items 1-2 are confirmed live, wiring the F1 signal into `JUDGE_PERSONA`'s
context (same discipline-weighted-highest hierarchy it already uses) is the
next natural extension — deliberately sequenced after, not bundled in.

**Not started.** This section exists so the next building session starts
from a precise scope instead of re-deriving it, and so "build it live, market
open" happens against a plan that's already been thought through once, not
improvised under time pressure the way Bug 7's first (wrong) answer was.
