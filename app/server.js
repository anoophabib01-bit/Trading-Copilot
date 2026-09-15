'use strict';
const path0 = require('path');
// ── Persistent crash log (2026-08-13, /investigate) ───────────────────────────
// Root cause of "we can never diagnose the evening crashes": START CO-PILOT.bat
// runs this as `cmd /k "node server.js"` with NO output redirection — every
// console.error the crash guards below ever printed vanished the moment that
// window closed. Installed FIRST, before any other require, so nothing can log
// before mirroring is active. Every console.log/warn/error still prints to the
// visible window exactly as before — this only ADDS a durable copy on disk at
// app/logs/server-YYYY-MM-DD.log. See crash-logger.js for why appendFileSync
// (not a buffered stream) is used — this only works if the crash line is
// actually flushed before the process can die.
require('./crash-logger').installConsoleMirror(path0.join(__dirname, 'logs'));

const http = require('http');
const atomicWrite = require('./atomic-write');  // crash-safe writes — must load BEFORE any save path
// Snapshot-before-destroy for account data (2026-09-04) — same constraint as
// atomicWrite above: dataSave() and dataWipeAccount() both call it, so it has
// to load before any save path too. See its header for the two incidents.
const accountSnapshot = require('./account-snapshot');
const orderGateway = require('./order-gateway');   // T1.3 — the one refusal decision
const accountFloor = require('./account-floor');   // T4.1 — the trailing drawdown floor
const providerChain = require('./provider-chain'); // provider selection + fail-open chain (unit-tested)
const stageRules = require('./stage-rules');       // eval/funded risk layer (unit-tested)
const payoutEligibility = require('./payout-eligibility'); // consistency-rule payout gate (unit-tested)
const verdictGrounding = require('./verdict-grounding'); // Debate-verdict numeric grounding check (unit-tested)
const postSessionOrch = require('./post-session-orchestrator'); // dynamic worker selection for post-session review (unit-tested)
const chatIntent = require('./chat-intent'); // assistive mode-routing hint, advisory only (unit-tested)
const goVerdictDetect = require('./go-verdict-detect'); // GO-verdict classifier for the refutation pass (unit-tested)
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const mcpBridge = require('./mcp-bridge');
const claudeAgent = require('./claude-agent');
const groqAgent = require('./groq-agent');
const { resolveDataDir, DEFAULT_DATA_DIR, FALLBACK_DATA_DIR } = require('./resolve-data-dir');
const edgeTts = require('./edge-tts');
const localTts = require('./local-tts'); // offline Windows SAPI fallback (2026-07-28)
const sessionMgr = require('./session-manager');
const liveStatus = require('./live-status');   // 7.3 — pure renderer for sessions/Now.md
const telegramBot = require('./telegram-bot');
const booksIndex = require('./books-index');
const tradovate = require('./tradovate');
const tvBrokerFeed = require('./tv-broker-feed'); // balance-delta-at-flat P&L fold for the TradingView broker feed (unit-tested)
const pointValueVerify = require('./point-value-verify'); // cross-checks the P&L multiplier against TradingView (unit-tested)
const brokerVerify = require('./broker-verify'); // three-way check against the broker before any figure reaches an agent (2026-08-26)
const mindLog = require('./mind-log'); // Alignment + Lessons merged into one store (2026-08-25, pure + unit-tested)
const armedDetectors = require('./armed-detectors'); // self-authored guardrails from the Lessons tab (2026-08-25, pure + unit-tested)
const journalNotes = require('./journal-notes'); // Daily Journal notes -> coaching context (2026-08-25, pure + unit-tested)
const weekRollup = require('./week-rollup'); // Weekly Report fold — quadrant verdict, loss attribution, findings (2026-08-29, pure + unit-tested)
const forensicsReport = require('./forensics-report'); // Forensics tab payload (2026-09-05, pure)
const weekStore = require('./week-store');   // Weekly Report persistence: frozen weeks, commitments, doctrine, sessions/Week-*.md (2026-08-29)
const lifetimeStore = require('./lifetime-store'); // one continuous record across every slot + archived account (2026-08-31, pure merge in lifetime-history.js, read-only)
const trustProtocol = require('./trust-protocol'); // PROTOCOL 3: is what the app SHOWS supported by the data behind it? (2026-08-31)
const tvToolArgs = require('./tv-tool-args'); // entity_id/id alias fix for tradingview-mcp draw tools (2026-09-02, pure + unit-tested)
const exitBiasAlign = require('./exit-bias-align'); // declared checklist bias vs. post-exit drift (2026-09-02, pure + unit-tested)
const exitDrift = require('./exit-drift'); // post-exit drift: what price did after the last exit (2026-08-31, pure + unit-tested)
const barRecorder = require('./bar-recorder'); // builds the 1m/5m history TradingView will not serve retrospectively (2026-08-31)
const barRecovery = require('./bar-recovery'); // startup self-repair for a missed recording day (2026-09-02, pure + unit-tested)
const htfStatus = require('./htf-status');    // hourly "which side are the watchers looking?" evidence (2026-09-02, pure + unit-tested)
const priorityLock = require('./priority-lock'); // the broker/chart lock, with a fast lane for the position watch (2026-09-02)
const panelRepair = require('./panel-repair'); // decides WHEN to re-render an unreadable broker tab (2026-09-01)
const positionsReadQuality = require('./positions-read-quality'); // G28: FLAT vs UNREADABLE when the table renders empty
const foldOnly = require('./renderer/fold-only');  // shared predicate: fold-derived rows carry a real net and no trade detail
const mistakePatterns = require('./mistake-patterns'); // live pattern-matching against Anoop's own documented failure history (2026-08-19, F1 first slice — advisory only, unit-tested)
const positionEvents = require('./position-events'); // fast open/close/scale/flip detector for the 5s positions watch (2026-08-20, pure + unit-tested)
const tradeConfirmRules = require('./trade-confirm-rules'); // Phase 2a/2b rule-check for the confirm/execute flow — unit-tested
const cadxStatus = require('./cadx-status'); // Playbook C (ADX) watcher row — see its header for why it is not in ALL_MONITORS
const sessionWindows = require('./session-windows'); // DST-aware session windows — see its header for the 2026-09-03 drift
const todayStatus = require('./today-status'); // "trades today" must mean today — see its header for the 2026-09-03 live failure
const chatArchive = require('./chat-archive'); // append-only record of everything that appears in the chat pane (2026-09-03, pure + unit-tested)
const patternMemory = require('./pattern-memory'); // what keeps happening and what it has cost — episode kinds + recurrence math (2026-09-03, pure + unit-tested)
const patternMemoryStore = require('./pattern-memory-store'); // the append-only episode ledger on disk (2026-09-03, unit-tested)
const failureChain = require('./failure-chain'); // WHY a day failed — causal sequence + exclusive loss attribution (2026-09-03, pure + unit-tested)
const tradeTicketParse = require('./trade-ticket-parse'); // Phase 2b: pure parser for JUDGE_PERSONA's TRADE_TICKET line — unit-tested
const playbookC = require('./playbook-c');
// Bar-pattern detectors, extracted 2026-08-26. These were inline below until
// the backtest harness needed to run them without booting this server — see
// detectors.js's header for why importability was the blocker on ever
// answering 'do these playbooks actually work?'.
const { detectEngulfFromBars, classifyTrendFromBars, detectFVGFromBars, getSwingLevels, detectSFPFromBars } = require('./detectors');
// Playbook spec: the single definition of where each playbook's entry, stop
// and target are, shared with backtest.js so the live ledger and the
// backtest can never disagree about what a setup actually proposed.
const detectors = require('./detectors'); // namespace form, for adxSeries in the shadow context
const playbookSpec = require('./playbook-spec');
const takeProfitSignal = require('./take-profit-signal');
// Bar-close-aligned watcher scheduling (2026-08-26). Replaces wall-clock
// setInterval polling that was doing 740 chart reads/hour to learn 27 new
// bars, starving the 5s position watch and 10s broker poll on the shared CDP
// connection until they hit MCP timeouts. See bar-schedule.js.
const barSchedule = require('./bar-schedule');
// PROTOCOL 2 - live-feed integrity at startup. Pure decision logic; the
// observation gathering (the part that needs CDP) lives in
// runFeedIntegrityProtocol() below.
const feedProtocol = require('./feed-protocol');
// PROTOCOL 1 - whole-app health, every 3 days. Same split as protocol 2:
// pure decision logic here, observation gathering in runHealthProtocol().
const healthProtocol = require('./health-protocol');
// OVERSIZE GUARD (2026-08-28). Pure decision logic; the order call is below in
// enforceOversizeGuard(). Reduces an oversized position back to the size cap.
const oversizeGuard = require('./oversize-guard');
const perTradeStop = require('./per-trade-stop'); // T1.1 per-trade max-loss tripwire (pure decision)
const positionProtection = require('./position-protection'); // G32 (2026-09-15) app-side protection: close at -stop / +target
const tradeProtection = require('./trade-protection');       // point value per symbol for the price fallback
const edgeWindow = require('./edge-window'); // T3.4 edge-window gate (pure decision)
const barArchive = require('./bar-archive'); // F0.2 durable bar archive (forward-testing dataset)
const tradeForensics = require('./trade-forensics'); // F1 MAE/MFE + winner invariant (shared kernel with signal-outcome)
// The GIVE-CONTROL toggle (2026-08-26). autonomy-gate.js decides whether the
// requested mode is permitted; this file owns persistence and broadcast. LIVE
// additionally requires measured evidence — see that module's header for why
// a plain boolean would have been the wrong shape.
const autonomyGate = require('./autonomy-gate');
// Per-mode configuration for the four rungs (2026-08-29, AUTONOMY_MODES_SPEC.md).
// autonomy-gate decides whether a mode may be ENTERED; this decides what the
// mode may DO once it is — sizes, silence, per-trade risk cap, playbooks. Its
// riskCapUsd() always returns the tighter of {mode cap, perTradeMaxLoss}, so a
// bad edit in rules.json can only ever refuse trades, never widen risk.
const autonomyModes = require('./autonomy-modes');
const htfAlignment = require('./htf-alignment'); // the ONE gate above every playbook (2026-09-01)
// All CONTROL-toggle data lives in DATA/autonomy/ and nothing else writes
// there — Anoop's request, so the autonomous system's record is one folder
// rather than rows scattered through the general ledger.
const autonomyStore = require('./autonomy-store');
// Builds the two shadow record shapes: the order the MACHINE would have sent,
// and the trade ANOOP actually took with its context. See its header for why
// both are recorded and why "good trades only" needs the losers too.
const shadowRecorder = require('./shadow-recorder'); // Playbook C engulfing validity + shared closed-bar helper — unit-tested
const tradeConfirmDedup = require('./trade-confirm-dedup'); // Phase 2b: double-submit/idempotency guard — unit-tested


// ── Contract specs (G10, 2026-09-08) ────────────────────────────────────────
// Point value / tick size must come from rules.json, never from a hardcoded
// multiplier. Unknown symbols REFUSE — an uncomputable risk is never small.
function contractSpecFor(symbol) {
  const rules = getActiveRules();
  const contracts = (rules && rules.contracts) || {};
  const s = String(symbol || '').toUpperCase();
  const root = s.indexOf('MGC') !== -1 || s.indexOf('GC') !== -1 ? 'MGC'
    : s.indexOf('MNQ') !== -1 ? 'MNQ' : null;
  if (!root || !contracts[root]) return null;
  return { pointValue: Number(contracts[root].pointValue), tickSize: Number(contracts[root].tickSize) };
}
function requireContractSpec(symbol) {
  const spec = contractSpecFor(symbol);
  if (!spec || !Number.isFinite(spec.pointValue) || spec.pointValue <= 0) {
    throw new Error('unknown contract symbol for risk pricing: ' + String(symbol || '?'));
  }
  return spec;
}

// 2026-08-27: overridable so a second instance can be started on a spare port
// to VERIFY a change without killing the live one. Defaults to 7433, so the
// launcher and every doc are unaffected. This existed as a hardcoded literal,
// which meant the only way to execute a change was to take down the session
// that was running — so in practice changes got shipped on node --check alone.
const PORT = Number(process.env.MNQ_PORT) || 7433;
const CONFIG_PATH = path.join(require('os').homedir(), '.mnq-copilot-config.json');

// ── Crash guards (2026-07-25 robustness pass) ─────────────────────────────────
// This process runs Anoop's entire co-pilot: WS server, engulf/FVG/SFP
// monitors, Jessi, Telegram bridge, TradingView bridge. Before this, ONE
// unhandled rejection anywhere (a monitor's MCP call racing a dropped
// connection, a flaky TTS socket) could kill the whole process mid-session —
// the worst possible time. Log loudly, keep running. Deliberately NOT
// swallowing errors silently: everything prints with a stack for the log.
// 2026-08-13: uptime + a clear ===CRASH=== marker added so the log file is
// grep-able for real incidents ("grep -A20 CRASH server-2026-08-*.log")
// instead of scrolling past every routine console.error line looking for the
// one that mattered.
function logCrash(kind, errOrReason) {
  console.error('===CRASH=== ' + kind + ' — uptime ' + Math.round(process.uptime()) + 's (process kept alive):',
    (errOrReason && errOrReason.stack) || errOrReason);
}
process.on('uncaughtException', (err) => { logCrash('uncaughtException', err); });
process.on('unhandledRejection', (reason) => { logCrash('unhandledRejection', reason); });
// The two guards above only catch errors that let the process KEEP running.
// If it dies outright (OOM-killed, window closed and the child process torn
// down with it, an unexpected process.exit()), neither guard fires — this is
// the other half of "why we could never tell what happened." exit handlers
// can't do async I/O, but the synchronous crash-logger append still works
// here since it's a plain fs.appendFileSync call.
process.on('exit', (code) => {
  console.error('===EXIT=== code ' + code + ' — uptime ' + Math.round(process.uptime()) + 's');
});

// ── Config ─────────────────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  atomicWrite.writeAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── OmniRoute primary-provider selection (2026-08-07) ───────────────────────────
// Every Jessi/Scalper/Debate/PO3/Post-Session call previously hardcoded
// `provider: 'gemini', model: 'gemini-3.5-flash'` plus an identical 3-entry
// Gemini→Gemini→Groq fallbackChain. OmniRoute (approved via office-hours
// design doc) is wired in as an OPTIONAL primary that sits in FRONT of that
// unchanged chain — not a replacement for it. If OmniRoute is disabled, has
// no key, or fails/errors mid-turn, groqAgent.stream()'s existing chain logic
// (untouched) falls through to Gemini/Groq exactly as it did before OmniRoute
// existed. This is the fail-open behavior Anoop asked for after seeing
// OmniRoute's free/high-reasoning models ride pooled CLI-subscription
// accounts (real ban risk, no SLA) rather than paid API keys.
// 2026-08-12 (task #34): the chain itself now lives in provider-chain.js and is
// unit-tested there. This local copy is DELETED rather than kept in sync — two
// definitions of the fail-open order is precisely the drift that has bitten this
// repo before (a hardcoded sizeCap silently 3x looser than rules.json, and the
// stale '16 accounts' figure repeated by every persona). One definition only.
//   → see provider-chain.js: STANDARD_FALLBACK_CHAIN
// 2026-08-10 (revised — reverted the 08-10 Scalper-only-model experiment
// above this comment): Anoop wants ONE shared code path across Jessi/
// Scalper/Debate/PO3, not a Scalper-specific carve-out — and OmniRoute
// itself is the fix, not a reason to route around it. Confirmed directly in
// the OmniRoute dashboard (Combos page): OmniRoute ships a built-in
// "auto-routing catalog" of 17 template IDs, "resolved dynamically from
// connected providers... use any of these IDs as the model field, no setup
// needed." 'auto/best-free' is tagged specifically for free-tier routing —
// with only OpenCode Free connected right now, it spreads load across that
// provider's 6 active built-in models (deepseek-v4-flash, mimo-v2.5, hy3,
// nemotron-3-ultra, north-mini-code, big-pickle) instead of pinning every
// request to the single deepseek-v4-flash-free model that choked on the
// oversized Scalper request. That's real multi-model resilience, not a
// single-model illusion of it — the previous default was one free model
// wearing an "OmniRoute" label.
// Left deliberately at 'auto/best-free', not 'auto/best-reasoning' or
// 'auto/claude-opus' (both exist in the same catalog and would be the
// genuine heavy-reasoning tier): those two are tagged "premium" in the
// catalog, and this OmniRoute instance has zero premium/paid/OAuth
// providers connected (Providers page: OAuth 0/20, no API-key-compatible
// providers added) — routing to them today would very likely resolve to no
// usable candidate and fail the same way the old chain did. Connecting a
// paid or OAuth provider in OmniRoute unlocks those tiers; that's a
// provider-connection action Anoop would do himself in the OmniRoute UI.
// 2026-08-10 (later same day — superseded 'auto/best-free' above): Anoop
// asked for auto/smart-style quality-first routing but "only free models in
// his category" as a hard constraint. Plain 'auto/smart' was rejected
// because its candidate pool spans ALL connected providers with no free
// filter — this instance also has Novita AI/Pollinations/ZenMux/Segmind/
// Freepik connected, none of them vetted for chat completions or confirmed
// free-only, so auto/smart could legally route a live-trading Jessi/Scalper
// call to a paid model with zero warning.
// Built a custom persisted combo instead — 'free-quality-first' (OmniRoute
// dashboard → Combos), "Intelligent Auto" strategy, "Quality First" mode
// pack (OmniRoute's own built-in weighting, not hand-rolled) — with three
// independent layers restricting it to free-only:
//   1. Candidate Pool scoped to exactly 3 providers (GitHub Models,
//      OpenCode Free, OpenRouter) — excludes the 5 unvetted/irrelevant ones.
//   2. An explicit 11-model Model Sequence, hand-picked for confirmed
//      "-free"/":free"-tagged or zero-cost slugs only: GitHub Models'
//      deepseek-r1-0528, llama-4-maverick-17b-128e-instruct-fp8,
//      mistral-medium-2505, gpt-5, o3, phi-4-reasoning (all free on GitHub
//      Models — its only paid items are 2 unused embedding models);
//      OpenRouter's nvidia/nemotron-3-ultra-550b-a55b:free,
//      nemotron-3-super-120b-a12b:free, nemotron-3-nano-omni-30b-a3b-
//      reasoning:free; OpenCode Free's deepseek-v4-flash-free and
//      nemotron-3-ultra-free. Deliberately excluded OpenCode Free's
//      claude-opus-5/gpt-5.5-pro/grok-4.5/etc. — same "OpenCode Free"
//      connection, but those model names carry no free-tier marking and are
//      almost certainly paid, so leaving them out of the step list is the
//      safer default until Anoop confirms otherwise.
//   3. A $0.001/request Budget Cap as a hard technical backstop — even if
//      (1) or (2) ever admit a mispriced entry, the cap should exclude it
//      before it can bill. (The field silently reset to "no limit" on a
//      literal 0, so 0.001 is the practical floor, not 0.)
// Verified empirically, not just configured: fired a real completion
// through 'free-quality-first' via /v1/chat/completions from the OmniRoute
// dashboard's own origin — HTTP 200, x-selected-model came back
// 'deepseek-v4-flash-free', i.e. routing stayed inside the curated free set
// on the very first live call. First call took ~35-40s (cold start, no
// cached provider health/quota yet); untested whether steady-state latency
// during a live session is materially better — worth a real smoke test per
// the Prompt/LLM changes checklist above before leaning on this in a
// session that matters.
// 2026-08-10 (same day — HOLD above lifted, ~20min later): Anoop re-authed
// the OpenRouter connection in OmniRoute (was sending no key at all — see the
// HOLD note this replaces, kept in git history). Re-ran POST /api/combos/test
// {comboName:'free-quality-first'} to confirm rather than trusting the UI fix
// blindly: all 3 OpenRouter steps now come back status:"ok" (2.9s/4.1s/14.6s),
// resolvedBy landed on step 7 (nvidia/nemotron-3-ultra-550b-a55b:free).
// Still broken, unchanged from the HOLD note, both external to this fix:
// GitHub Models' 6 steps still 410 "scheduled retirement brownout" (GitHub's
// side — re-test later, don't chase it here), OpenCode Free's 2 steps still
// flat 20s timeouts with no error message (cause still unknown — worth a
// closer look if it hasn't cleared on its own next time this is re-tested).
// Net effect: right now this combo is functionally "OpenRouter's 3 free
// Nemotron models," not the full 11-candidate pool it was designed as — real
// resilience, but reduced. That's still strictly better than the 100%-failure
// state the HOLD was protecting against, and better than auto/best-free's
// keyless-scraper fallback (see HOLD note in git history), so re-enabling.
// 2026-08-10 (same day, ~15min later): GitHub Models' "brownout" was never
// coming back — checked, the whole service was permanently retired 2026-07-30
// (github.blog/changelog). Removed its 6 dead steps from the free-quality-
// first combo itself (OmniRoute dashboard, not this file — the combo's model
// list lives server-side in OmniRoute). Combo is now 5 steps: OpenRouter's 3
// free Nemotron models + OpenCode Free's 2. Re-tested after trimming:
// resolves on the first step now (~14s, that's Nemotron Ultra 550B's real
// response time, not dead-step latency) instead of walking 6 guaranteed
// failures first. OpenCode Free's 20s timeout is still unexplained and still
// there — not urgent since OpenRouter covers the combo on its own, but if
// this gets revisited, that's the one loose end left.
//
// ── 2026-08-10 21:00 IST — REVERTED. Read this before re-enabling OmniRoute. ──
// Everything above this line was a mistake, and it broke Anoop's app during a
// live evening. Symptoms he hit within ~2h of the change: "Debate failed:
// Jessi (OmniRoute) timed out after 90s", the PO3 agent erroring out, and
// Jessi emitting a raw `{"section":"insights"}` blob into the chat instead of
// actually calling the tool.
// Root cause, and the lesson: I validated the combo with a ONE-WORD prompt
// ("Reply with exactly one word: OK") and treated 14-20s as acceptable. It is
// not. Jessi/Debate/PO3 send a large system prompt plus tool schemas plus
// account context, and they need real tool-calling. Free-tier Nemotron models
// are far too slow for that (90s timeout blown) and unreliable at structured
// tool-use (hence the raw JSON leaking into the UI). A latency figure from a
// trivial prompt says nothing about behavior under the real agent workload —
// do not accept one as validation again.
// Reverting to the pre-2026-08-10 behavior: Gemini primary, with the
// STANDARD_FALLBACK_CHAIN behind it. Paid API keys, known latency, proven
// tool-calling. OmniRoute is bypassed entirely (this deliberately ignores
// cfg.disableOmniRoute rather than depending on a config file that may not
// have the flag set).
// Before ANY future attempt to route these agents through free models: test
// with a real Jessi-sized payload (full system prompt + tool schemas + context)
// and confirm tool-calling works end-to-end, not a toy prompt. Honestly, the
// better answer is probably to stop chasing $0 inference for a live-money
// trading tool at all — one paid provider removes this whole class of failure.
// ── 2026-08-11 (evening): ANTHROPIC IS NOW PRIMARY FOR ALL NINE CALL SITES ──
// The interim "everything on Gemini" state above did its job — it made the app
// behave in one direction so it stopped being a mystery — but the goal was
// always Anthropic everywhere. groq-agent.js now speaks 'anthropic' (via
// Anthropic's OpenAI-compatible endpoint, so the existing SSE/tool pipeline is
// unchanged), so this one function switches the whole app.
//
// Model default is Haiku 4.5: first-party, reliable tool-calling — the property
// the free models catastrophically lacked on 08-10 — at roughly a third of
// Sonnet's input price. Override with "agentModel" in
// ~/.mnq-copilot-config.json without touching code.
//
// FAIL-OPEN IS PRESERVED, and that matters more than the provider choice: if
// the Anthropic key is missing, the balance runs out mid-session, or the API
// errors, fallbackChainFor() drops straight through to Gemini and then Groq —
// the same chain that has been carrying this app for weeks. A dead prepaid
// balance must never mean a dead co-pilot in the middle of a session.
// 2026-08-12 (task #34): the selection + fail-open logic moved to
// provider-chain.js so it can actually be unit-tested — server.js is an entry
// point and exports nothing, so this code had ZERO coverage despite deciding
// which brain answers every request and what happens when it dies mid-session.
// These wrappers keep the existing call signature, so all nine call sites are
// untouched. Config is read here and passed IN, which is what makes the module
// pure and testable without touching the real config file.
// NOTE: provider-chain also restores an OmniRoute branch (used only when there
// is no Anthropic key AND its health probe passes). With a key present
// Anthropic wins regardless, so this is not a behaviour change today — it just
// means re-enabling OmniRoute later needs no code edit.
function primaryProviderModel() {
  return providerChain.primaryProviderModel(loadConfig());
}
// When OmniRoute is primary, Gemini's own default model rejoins the chain as
// the first fallback step (it was the primary before OmniRoute existed);
// otherwise the chain is unchanged from before this feature was added.
// 2026-08-11: 'anthropic' joins 'omniroute' in getting gemini-3.5-flash spliced
// in as the FIRST fallback step. Caught while wiring Anthropic in: without
// this, an Anthropic failure fell straight to STANDARD_FALLBACK_CHAIN, whose
// first two entries are gemini-3.1-flash-lite and gemini-2.5-flash — and this
// file's own notes record that Google closed the 2.5 line to new accounts
// (a live 404). So the chain would have burned two steps on possibly-dead
// model IDs before reaching Groq, at exactly the moment the primary had
// already failed. gemini-3.5-flash is the model that has actually been serving
// this app, so it belongs at the front of any fail-open path.
function fallbackChainFor(primary) {
  return providerChain.fallbackChainFor(primary);
}

// ── Request cancellation (2026-08-06) ───────────────────────────────────────────
// Real end-to-end cancellation. Before this, window.api.cancelChat() and
// friends only cleared local UI state — the server kept generating (and
// burning API quota/rate-limit budget) in the background regardless. Each
// chat-ish handler below registers an AbortController here for its reqId,
// passes its .signal into claudeAgent.stream()/groqAgent.stream(), and
// unregisters in a finally block. 'cancel-request' just looks it up and
// fires it — reqIds are process-wide unique (a single incrementing counter
// in ws-client.js), so no per-connection scoping is needed.
const activeRequests = new Map(); // reqId -> AbortController
// 2026-08-16 (Pattern 02 assistive routing, chat-intent.js): per-connection
// cooldown so a scalping-mode hint doesn't repeat every message in a session
// that's already been told once. WeakMap keyed by the ws connection object
// itself — entries fall out of memory naturally when a connection closes,
// no manual cleanup needed.
const modeHintLastAt = new WeakMap();
const MODE_HINT_COOLDOWN_MS = 20 * 60 * 1000;
function registerRequest(reqId) {
  const ctrl = new AbortController();
  activeRequests.set(reqId, ctrl);
  return ctrl;
}
function unregisterRequest(reqId) {
  activeRequests.delete(reqId);
}
function handleCancelRequest(msg) {
  const ctrl = activeRequests.get(msg.reqId);
  if (ctrl) { ctrl.abort(); activeRequests.delete(msg.reqId); }
}

// ── Server state ───────────────────────────────────────────────────────────────
let currentMode = loadConfig().mode || 'funded'; // 'eval' | 'funded'

// ── Rules (single source of truth: rules.json in project root) ─────────────────
const RULES_PATH = path.join(__dirname, 'rules.json');
// These are the in-code FALLBACK values, used only when rules.json cannot be
// read or parsed. 2026-08-15: sizeCap was 6 here — three times looser than the
// 2 that rules.json has enforced since 2026-07-28. A corrupt or briefly
// unreadable rules.json would therefore have silently handed back the exact
// size cap that breached the 150K eval on 2026-07-21. Fallbacks must be the
// SAFE numbers (i.e. the funded ruleset), never the permissive ones — same
// argument as stage-rules.js: what you get when something fails must be the
// state that cannot hurt him.
const DEFAULT_RULES = {
  sizeCap: 2,
  sizeFloor: 2,
  tradeLimit: { eval: 2, funded: 20 },
  tradesPerSession: 5,
  tradesPerDay: 5,
  maxHoldSeconds: 1800,
  qualifyingTradeMinAbsPnl: 100,
  scorerTradesPerDayLimit: 10,
  dailyLossTiers: { yellow: -250, red: -350, hard: -500 },
  dayStop: { eval: 300, funded: 200 },
  cooldownMinutes: 15,
  // Native declarations, same as rules.json — loadRules() converts these to
  // sessionWindowsIST. This block is the emergency fallback used only when
  // rules.json cannot be read at all, so it must stay in step with it.
  sessionWindows: [
    { name: 'London', tz: 'Europe/London', startLocal: '08:00', endLocal: '09:30' },
    { name: 'NY', tz: 'America/New_York', startLocal: '09:30', endLocal: '11:30' }
  ],
  oneInstrumentPerDay: true,
  commissionPerContractPerSide: 0.59,
  giveback: { armAtProfit: 400, retracePct: 50 },
  perTradeMaxLoss: 200
};
// 2026-08-15: sizeCap REMOVED from this block. Contract size is owned by the
// stage layer (stageRules in rules.json), not by trading style — leaving it
// here meant flipping to scalper mode on a FUNDED account silently raised the
// cap from 2 to 4, the one change his data says wrecks that account.
const SCALPER_DEFAULTS = {
  tradesPerSession: 5,
  tradesPerDay: 10,
  dailyLossTiers: { yellow: -200, red: -300, hard: -400 },
  cooldownAfterLossOnly: true,
  maxHoldSeconds: 900,
  scorerTradesPerDayLimit: 15
};
function loadRules() {
  let raw;
  try { raw = Object.assign({}, DEFAULT_RULES, JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'))); }
  catch { raw = Object.assign({}, DEFAULT_RULES); }
  return withResolvedSessionWindows(raw);
}

// Session windows are declared natively (tz + local time) and converted to
// IST here, on EVERY load, because the answer changes across a DST boundary
// (2026-09-03 — see session-windows.js for the drift table and why fixed IST
// minutes could never be right year-round). Resolved in loadRules() rather
// than getActiveRules() so that every caller of either sees the same numbers;
// a consumer reading a stale sessionWindowsIST is exactly the split-brain
// this replaces.
//
// A rules.json that still carries a literal sessionWindowsIST and no
// sessionWindows block keeps working untouched — an old config, or a window
// deliberately pinned to a fixed IST time, must not silently vanish.
function withResolvedSessionWindows(rules) {
  try {
    if (!Array.isArray(rules.sessionWindows) || !rules.sessionWindows.length) return rules;
    const resolved = sessionWindows.resolveWindowsIST(rules.sessionWindows, Date.now());
    if (!resolved.length) return rules; // never hand back an empty window list
    return Object.assign({}, rules, { sessionWindowsIST: resolved });
  } catch (e) {
    console.error('[rules] session window resolve failed, using windows as written:', e.message);
    return rules;
  }
}
/** Return the effective ruleset for the active trading mode AND account stage.
 *
 *  TWO INDEPENDENT AXES, applied in this order (2026-08-15):
 *    1. base rules (rules.json) — these ARE the funded/safe numbers
 *    2. scalperRules            — if tradingMode === 'scalper'. Owns HOW he
 *                                 trades: hold time, entry candle, trade count.
 *    3. stageRules              — always. Owns HOW MUCH he may lose: contract
 *                                 size, contracts/day, daily loss cap.
 *
 *  Stage is applied LAST so nothing upstream can loosen it, and 'funded' only
 *  ever clamps. See stage-rules.js for the derivation from his own trade data
 *  and for why the safe numbers are the base rather than an overlay.
 *
 *  @param {string} [stage] 'eval' | 'funded'. Defaults to the live currentMode,
 *         so all existing no-arg callers become stage-aware automatically; the
 *         parameter exists so the merge stays testable without global state.
 */
function getActiveRules(stage) {
  const raw = loadRules();
  const mode = raw.tradingMode || 'standard';
  const st = (stage === 'eval' || stage === 'funded') ? stage : currentMode;

  let merged = raw;
  if (mode === 'scalper') {
    // Merge scalper overrides onto base rules (scalperRules block wins)
    const scalper = Object.assign({}, SCALPER_DEFAULTS, raw.scalperRules || {});
    merged = Object.assign({}, raw, scalper);
    // Keep the full scalperRules block and mode marker in the output
    merged.tradingMode = 'scalper';
    merged.scalperRules = raw.scalperRules || SCALPER_DEFAULTS;
  }
  // LAST, after stage and scalper layers: the cap he can never exceed.
  // Every consumer of getActiveRules() — the oversize guard, handleTradeConfirm,
  // the HUD, the scorer — is therefore bounded by construction rather than by
  // each of them remembering to check. See stage-rules.js for why.
  return stageRules.enforceSizeCapCeiling(stageRules.applyStageRules(merged, st));
}
function saveRules(rules) {
  atomicWrite.writeAtomic(RULES_PATH, JSON.stringify(rules, null, 2), 'utf8');
}

// ── Local data persistence ────────────────────────────────────────────────────
// 2026-07-25 (Anoop: "D:\co-pilot DATA — save data of all the account here…
// treat every new account as a separate dataset"):
//
// LAYOUT ON DISK
//   D:\co-pilot DATA\
//     accounts\<slotId>\            ← one folder per account, fully isolated
//        meta.json                  ← name, size, stage, status, opened/closed
//        gr_history.json            ← per-day discipline summaries
//        balance_ledger.json        ← per-day net (drives balance + floor)
//        day_trades.json            ← per-trade detail
//        pb_tags.json, maemfe.json, loop_state.json, eval_milestones.json
//        daily\<YYYY-MM-DD>.json    ← immutable End-Day snapshot
//        CLOSED_breached.json / CLOSED_cleared.json  ← final account record
//     account_fees.json             ← LIFETIME spend/payouts (all accounts)
//     account_archives.json         ← LIFETIME breach/clear archive
//     trade_journal.json            ← LIFETIME journal (about Anoop, not an account)
//
// A key containing '__<slotId>' is routed into that account's folder; anything
// else stays at the root as a lifetime record. Falls back to the old in-project
// data/ folder if the configured drive isn't writable, so the app never dies
// just because an external path is missing.
let DATA_DIR = FALLBACK_DATA_DIR;
// LIFETIME files (account_fees, account_archives, trade_journal) must never
// silently reset just because DATA_DIR resolves differently between runs
// (e.g. D:\co-pilot DATA becomes writable when it previously wasn't, or vice
// versa). BUG FOUND 2026-07-28: exactly this happened — DATA_DIR pointed to
// D:\co-pilot DATA which had no account_fees.json, so the Cost tab silently
// started from an empty ledger while the real 16-account/$840.50 file sat
// untouched at the in-project fallback path. Anoop only caught it because he
// happened to compare against an old screenshot. Fix: on every startup, if
// the active DATA_DIR's copy of a lifetime file is missing or empty while the
// fallback has real data, pull the fallback in — never overwrite a populated
// destination, only fill an empty/missing one.
const GLOBAL_LIFETIME_KEYS = ['account_fees', 'account_archives', 'trade_journal'];
function fileHasData(fp) {
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!d || typeof d !== 'object') return false;
    return Object.keys(d).some(k => Array.isArray(d[k]) && d[k].length > 0);
  } catch { return false; }
}
function migrateLifetimeFiles() {
  if (DATA_DIR === FALLBACK_DATA_DIR) return;
  GLOBAL_LIFETIME_KEYS.forEach(key => {
    const dest = path.join(DATA_DIR, key + '.json');
    const src = path.join(FALLBACK_DATA_DIR, key + '.json');
    try {
      if (!fs.existsSync(src) || !fileHasData(src)) return;
      const destEmpty = !fs.existsSync(dest) || !fileHasData(dest);
      if (destEmpty) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        console.log(`✓ Recovered lifetime file "${key}.json" — was empty/missing at ${DATA_DIR}, pulled real data from fallback ${FALLBACK_DATA_DIR}`);
      }
    } catch (e) {
      console.error(`Lifetime file migration failed for ${key}:`, e.message);
    }
  });
}
function initDataDir() {
  const resolved = resolveDataDir();
  DATA_DIR = resolved.dir;
  if (resolved.isFallback) {
    const wanted = loadConfig().dataDir || DEFAULT_DATA_DIR;
    const e = resolved.error;
    console.log(`⚠  Could not use "${wanted}" (${(e && (e.code || e.message)) || 'unknown error'}) — falling back to ${DATA_DIR}`);
  }
  console.log('✓ Data directory: ' + DATA_DIR);
  migrateLifetimeFiles();
  // 2026-09-03: bring the pattern ledger up to date with whatever the records
  // already say. SILENT — a cold backfill implies hundreds of historical
  // episodes and announcing them would open every session with a wall of
  // repeats from July. Idempotent (deterministic episode ids), so this is a
  // no-op on every restart after the first.
  try {
    const lt = lifetimeStore.buildLifetime(DATA_DIR);
    const seeded = patternMemoryStore.sync(DATA_DIR, {
      tradesByDay: lt.trades || {},
      days: lt.days || [],
      // getActiveRules(), NOT loadRules() — the scalper overlay changes
      // tradesPerDay (5 base, 10 scalper), and using the base here while
      // patternMemorySources() used the active one made the first live tick
      // "discover" a wave of historical episodes that only differed by which
      // cap they were judged against. Caught live on the first run,
      // 2026-09-03: the Loop opened with a compliment about a green day from
      // August on an afternoon he was down $2,296. One rules source.
      rules: { tradesPerDay: getActiveRules().tradesPerDay },
    });
    const st = patternMemoryStore.stats(DATA_DIR);
    console.log(`✓ Pattern memory: ${st.episodes} episode(s) across ${st.days} day(s)`
      + (seeded.added.length ? ` (+${seeded.added.length} new)` : '') + `, ${st.kinds} distinct pattern(s)`);
  } catch (e) { console.log('⚠  Pattern memory backfill failed: ' + e.message); }
  return DATA_DIR;
}
function ensureDataDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function safeDataKey(key) {
  return /^[a-zA-Z0-9_\-]+(\/[a-zA-Z0-9_\-]+)?$/.test(String(key || ''));
}
// Route 'gr_history__s2' → accounts/s2/gr_history.json ; leave others at root.
function dataPathFor(key) {
  const m = String(key).match(/^([a-zA-Z0-9_\-]+)__([a-zA-Z0-9_\-]+)$/);
  if (m) return path.join(DATA_DIR, 'accounts', m[2], m[1] + '.json');
  return path.join(DATA_DIR, key + '.json');
}
function dataSave(key, payload) {
  if (!safeDataKey(key)) return false;
  ensureDataDir();
  try {
    const fp = dataPathFor(key);
    // DOOR 1 (2026-09-04): a breach/clear/payout reset writes an EMPTY store
    // over a full one, atomically — reliably complete, and not reversible. The
    // hook reads what is on disk and copies it out only when the incoming write
    // would empty or shrink it, so the ordinary per-trade save (which grows the
    // store) never triggers it. It cannot throw; see account-snapshot.js.
    const acctKey = String(key).match(/^([a-zA-Z0-9_-]+)__([a-zA-Z0-9_-]+)$/);
    if (acctKey) {
      accountSnapshot.snapshotIfDestructive({
        dataDir: DATA_DIR, slotId: acctKey[2], filePath: fp, next: payload,
        key: key, reason: 'overwrite',
      });
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    atomicWrite.writeAtomic(fp, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch (e) { console.error('dataSave failed for', key, e.message); return false; }
}
// ── Review archive (2026-07-31) ──────────────────────────────────────────────
// Anoop asked whether a better/paid model would improve the agents. The honest
// answer was: unknowable, because NOTHING the Judge or the Post-Session Analyst
// ever said was persisted anywhere. Every verdict evaporated when the chat
// cleared — so he could not review last week's advice, could not check whether
// he was warned before the 2026-07-21 eval breach, and could not judge whether
// the agents are worth anything at all. An advisor with amnesia isn't an
// advisor. This appends every Judge verdict and Post-Session review to
// data/reviews/YYYY-MM-DD.json so there is a permanent, readable record.
//
// Deliberately append-only and failure-tolerant: a write problem here must
// NEVER break the live chat response the user is waiting on, so every call is
// wrapped and errors are logged rather than thrown.
function reviewsPathFor(dateStr) {
  return path.join(DATA_DIR, 'reviews', dateStr + '.json');
}

// Trading-day stamp, NOT calendar date — mirrors renderer/app.js csvParseTrades
// (ROLLOVER_MIN 03:45 IST, the CME Globex maintenance break). A verdict given
// at 00:40 IST belongs to the session that started the previous evening, and
// filing it under the next calendar day would scatter one session's record
// across two files.
function tradingDayStampIST(nowMs) {
  const IST_OFF = 330 * 60 * 1000;
  const ist = new Date((nowMs != null ? nowMs : Date.now()) + IST_OFF);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (mins < 3 * 60 + 45) ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}

function saveReviewRecord(kind, fullText, extra) {
  try {
    if (!fullText || !String(fullText).trim()) return false;
    const now = Date.now();
    const day = tradingDayStampIST(now);
    const fp = reviewsPathFor(day);
    fs.mkdirSync(path.dirname(fp), { recursive: true });

    let arr = [];
    try { const j = JSON.parse(fs.readFileSync(fp, 'utf8')); if (Array.isArray(j)) arr = j; } catch {}

    let slot = null;
    try { slot = jessiBucketKey(loadConfig() || {}); } catch {}

    arr.push({
      kind,                                  // 'judge' | 'post-session'
      ts: new Date(now).toISOString(),
      istTime: new Date(now).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
      tradingDay: day,
      slot,
      ...(extra || {}),
      text: String(fullText)
    });

    atomicWrite.writeAtomic(fp, JSON.stringify(arr, null, 2), 'utf8');
    console.log(`[reviews] saved ${kind} → data/reviews/${day}.json (${arr.length} entries that day)`);
    return true;
  } catch (e) {
    console.error('[reviews] save failed:', e.message);
    return false;
  }
}

// Read back the most recent N review records across all days, newest first.
function loadRecentReviews(limit, kindFilter) {
  const out = [];
  try {
    const dir = path.join(DATA_DIR, 'reviews');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
    for (const f of files) {
      let arr = [];
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (Array.isArray(j)) arr = j; } catch { continue; }
      for (let i = arr.length - 1; i >= 0; i--) {
        const r = arr[i];
        if (kindFilter && r.kind !== kindFilter) continue;
        out.push(r);
        if (out.length >= (limit || 20)) return out;
      }
    }
  } catch (e) { /* no reviews dir yet — not an error */ }
  return out;
}

function dataLoad(key) {
  if (!safeDataKey(key)) return null;
  try { return JSON.parse(fs.readFileSync(dataPathFor(key), 'utf8')); }
  catch { return null; }
}

// ── Weekly Report (2026-08-29) ───────────────────────────────────────────────
// Anoop: "i want to see this page every weekend to plan for my upcoming week."
//
// ONE builder, used by the tab, the Saturday markdown and the Telegram push.
// The whole reason the tab can be trusted is that none of those three compute
// anything themselves — they all read this object. Splitting it would recreate
// the exact drift day-rollup.js's header was written to stop.
//
// `offset` is 0 for the week containing today, -1 for last week, and so on.
// Positive values are clamped away: there is no report for a week that has not
// happened.
// ── Which account actually traded a given week (2026-08-31) ────────────────
// The Week tab was slot-scoped, so opening a fresh eval made every earlier
// week render "—" and read as deleted history. It was not deleted: on
// 2026-08-31 ten traded days sat in s1 while the active slot was s2.
//
// The fix is NOT a new rollup. week-store.buildWeek() already builds a correct
// week for any slot, so this only answers WHICH slot to ask. That keeps a week
// a record of exactly one account (week-store's freeze doctrine) rather than
// blending two accounts into a week that never happened.
//
// The active slot always wins when it has data for that week, so the current
// account is never visually replaced by an older one.
function slotForWeek(lifetime, weekKey, activeSlot) {
  try {
    const inWeek = ((lifetime && lifetime.days) || []).filter(function (d) {
      return weekRollup.isoWeekKey(d.date) === weekKey;
    });
    if (!inWeek.length) return { slot: activeSlot, borrowed: false, label: null };
    if (inWeek.some(function (d) { return d.slot === activeSlot; })) {
      return { slot: activeSlot, borrowed: false, label: null };
    }
    const tally = {};
    inWeek.forEach(function (d) {
      if (!d.slot) return;
      if (!tally[d.slot]) tally[d.slot] = { slot: d.slot, n: 0, label: d.accountLabel || d.slot };
      tally[d.slot].n++;
    });
    const best = Object.keys(tally).map(function (k) { return tally[k]; })
      .sort(function (a, b) { return b.n - a.n; })[0];
    if (!best) return { slot: activeSlot, borrowed: false, label: null };
    return { slot: best.slot, borrowed: true, label: best.label };
  } catch (e) { return { slot: activeSlot, borrowed: false, label: null }; }
}

function buildWeekPayload(offset) {
  const cfg = loadConfig();
  const slot = jessiBucketKey(cfg);
  const raw = loadRules();
  const accountBlock = raw[currentMode] || raw.eval || {};
  const todayKey = tradingDayStampIST(Date.now());

  const off = Math.min(0, Number(offset) || 0);
  const anchor = new Date(weekRollup.weekStart(todayKey) + 'T00:00:00Z');
  anchor.setUTCDate(anchor.getUTCDate() + off * 7);
  const anyDate = anchor.toISOString().slice(0, 10);

  // Lifetime record decides WHICH account each week is read from. Built once
  // and reused for the displayed week, the comparison week and the 4-week
  // strip, so all three agree on who owned a given week.
  let lifetime = null;
  try { lifetime = lifetimeStore.buildLifetime(DATA_DIR); }
  catch (e) { console.warn('[week] lifetime unavailable, using active slot only:', e.message); }

  const owner = slotForWeek(lifetime, weekRollup.isoWeekKey(anyDate), slot);
  const week = weekStore.buildWeek(DATA_DIR, owner.slot, anyDate, todayKey, accountBlock);
  const prevDate = weekRollup.prevWeekStart(anyDate);
  const prevOwner = slotForWeek(lifetime, weekRollup.isoWeekKey(prevDate), slot);
  const prev = weekStore.buildWeek(DATA_DIR, prevOwner.slot, prevDate, todayKey, accountBlock);
  const hadPrev = weekRollup.weekHasData(prev);

  const findings = weekRollup.weekFindings(week, hadPrev ? prev : null);
  const trend = weekRollup.compareWeeks(week, hadPrev ? prev : null);

  // ── Four-week window (2026-08-31, Anoop: "lets compare 4 weeks data") ──────
  // The three weeks BEFORE the one on screen, plus it, oldest first. Built by
  // walking calendar weeks back rather than by listing stored weeks, so a week
  // he did not trade at all stays as an aligned empty column instead of being
  // silently closed up — a three-week break must not render as three
  // consecutive trading weeks.
  const WINDOW = 4;
  const window4 = [];
  for (let back = WINDOW - 1; back >= 0; back--) {
    const d = new Date(week.start + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - back * 7);
    const colDate = d.toISOString().slice(0, 10);
    const colOwner = slotForWeek(lifetime, weekRollup.isoWeekKey(colDate), slot);
    const colWeek = weekStore.buildWeek(DATA_DIR, colOwner.slot, colDate, todayKey, accountBlock);
    colWeek.__ownerSlot = colOwner.slot; colWeek.__borrowed = colOwner.borrowed; colWeek.__ownerLabel = colOwner.label;
    window4.push(colWeek);
  }
  const trend4 = weekRollup.trendSeries(window4);

  // The commitment made LAST weekend is the one this week is graded against.
  const commitment = weekStore.loadCommitment(DATA_DIR, slot, week.weekKey);
  const grade = weekStore.gradeCommitment(week, commitment);

  // The one he is about to make is for the week AFTER the one on screen.
  const nextAnchor = new Date(week.start + 'T00:00:00Z');
  nextAnchor.setUTCDate(nextAnchor.getUTCDate() + 7);
  const nextWeekKey = weekRollup.isoWeekKey(nextAnchor.toISOString().slice(0, 10));

  return {
    slot: slot,
    weekOwnerSlot: owner.slot,
    weekBorrowed: owner.borrowed,
    weekOwnerLabel: owner.label,
    week: week,
    findings: findings,
    trend: trend,
    trend4: trend4,
    weeksInWindow: window4.map(w => ({
      weekKey: w.weekKey, start: w.start, end: w.end,
      complete: w.complete, hasData: weekRollup.weekHasData(w),
      net: w.money.net, tradedDays: w.behaviour.tradedDays, heldFireDays: w.behaviour.heldFireDays,
      isCurrent: w.weekKey === week.weekKey,
      ownerSlot: w.__ownerSlot || slot,
      borrowed: !!w.__borrowed,
      ownerLabel: w.__ownerLabel || null
    })),
    trendBasis: hadPrev
      ? 'Compared against ' + prev.weekKey + ' (' + prev.start + ' to ' + prev.end + ').'
      : 'No comparable previous week stored yet.',
    severity: weekRollup.SEVERITY,
    // Computed over ALL history, not this week — see week-rollup's
    // adherenceSplit header for why a one-week sample cannot answer it.
    adherence: weekRollup.adherenceSplit(weekStore.allRows(DATA_DIR, slot)),
    doctrine: weekStore.loadDoctrine(DATA_DIR),
    commitment: commitment,
    grade: grade,
    nextWeekKey: nextWeekKey,
    nextCommitment: weekStore.loadCommitment(DATA_DIR, slot, nextWeekKey),
    frozen: weekStore.loadFrozen(DATA_DIR, slot, week.weekKey),
    frozenWeeks: weekStore.listFrozen(DATA_DIR, slot),
    // Stated rather than assumed: the freeze button promises a Telegram push,
    // and telegramBot.notify() is a silent no-op with no token or no linked
    // chat. Promising a push that cannot fire is how a missed alert looks like
    // a delivered one.
    telegramReady: !!(telegramBot && telegramBot.bot && cfg.telegramChatId)
  };
}

// ── The Saturday write ───────────────────────────────────────────────────────
// Anoop chose "auto-write a markdown file to sessions/ + Telegram ping" over a
// tab badge, because the point of the weekly review is that he opens it on a
// day he is NOT sitting at the app. A surface that only exists inside the app
// is a surface he will miss on exactly the mornings it matters.
//
// Deliberately NOT a cron at a fixed hour: this process is started and stopped
// by hand around trading sessions, so a 09:00 timer would simply never fire on
// a weekend when the app was closed. Instead it checks on boot and hourly, and
// freezes any complete-but-unfrozen week from the last fortnight. Freezing is
// idempotent (week-store preserves the original `frozenAt`), so a week is only
// ever announced once.
const WEEK_AUTOFREEZE_MS = 60 * 60 * 1000;
let weeklyReportTimer = null;

function autoFreezeDueWeeks() {
  try {
    const cfg = loadConfig();
    const slot = jessiBucketKey(cfg);
    const raw = loadRules();
    const accountBlock = raw[currentMode] || raw.eval || {};
    const todayKey = tradingDayStampIST(Date.now());

    // This week and last week only. Anything older was either already frozen or
    // is history he has moved past — silently back-filling months of notes on a
    // first run would bury the one week he actually needs to read.
    for (const back of [0, -1]) {
      const d = new Date(weekRollup.weekStart(todayKey) + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + back * 7);
      const iso = d.toISOString().slice(0, 10);
      const key = weekRollup.isoWeekKey(iso);

      if (weekStore.loadFrozen(DATA_DIR, slot, key)) continue;
      const wk = weekStore.buildWeek(DATA_DIR, slot, iso, todayKey, accountBlock);
      if (!wk.complete) continue;
      // A week with nothing in it is not worth a note or a push.
      if (wk.behaviour.tradedDays === 0 && wk.behaviour.heldFireDays === 0) continue;

      const r = freezeWeekNow(key);
      if (r.frozenOk) {
        console.log('[week] auto-froze ' + key + ' — the weekend review is ready'
          + (r.markdown ? ' (' + r.markdown + ')' : ''));
        broadcast({ type: 'week-ready', weekKey: key, markdown: r.markdown || null });
      } else {
        console.log('[week] auto-freeze skipped ' + key + ': ' + r.freezeError);
      }
    }
  } catch (e) {
    console.error('[week] auto-freeze check failed:', e.message);
  }
}

function startWeeklyReportSchedule() {
  if (weeklyReportTimer) return;                 // idempotent, like startPanelWatchdog
  // A short delay so the boot log is not interleaved with a freeze, and so a
  // first-run DATA_DIR resolution has settled before anything is written.
  setTimeout(autoFreezeDueWeeks, 15000);
  weeklyReportTimer = setInterval(autoFreezeDueWeeks, WEEK_AUTOFREEZE_MS);
  console.log('✓ Weekly report: checks hourly, freezes a finished week to sessions/Week-<key>.md'
    + (telegramBot && telegramBot.bot ? ' + Telegram' : ' (Telegram has no token — no push will be sent)'));
}

/**
 * Forensics tab (2026-09-05). ONE request, ONE reply carrying the whole tab.
 *
 * Everything is computed here and nothing on the client, the same split
 * week-report.js uses — a renderer that re-folds these numbers is how
 * "expectancy" ends up with two definitions.
 *
 * The payload leads with COVERAGE on purpose. Almost no trade on disk has
 * MAE/MFE yet (the bar archive started 2026-09-05), and a tab that showed
 * averages without saying how thin they are would repeat the mistake that
 * started this work: an impossible number averaged into a verdict because
 * nothing asked whether the input was real.
 */
function sendForensicsReport(ws, reqId) {
  try {
    const slot = jessiBucketKey(loadConfig());
    const store = (slot ? dataLoad('day_trades__' + slot) : null) || {};
    const rules = getActiveRules() || {};
    const payload = forensicsReport.buildForensicsReport(store, {
      slot: slot,
      sessionWindowsIST: rules.sessionWindowsIST || [],
      isReentryWindowMin: rules.isReentryWindowMin,
      // MNQ, verified by point-value-verify.js — never hardcoded at a call site
      // that could drift from the one the P&L fold uses.
      pointValue: tvBrokerFeed.pointValueFor('MNQ1!'),
    });
    send(ws, Object.assign({ type: 'forensics-data', reqId: reqId }, payload));
  } catch (e) {
    console.error('[forensics] build failed:', e.message);
    send(ws, { type: 'forensics-data', reqId: reqId, error: e.message });
  }
}

// ── Market Brief (2026-09-06) ─────────────────────────────────────
// Surfaces cli/market-brief.js in the UI. Anoop, 2026-09-06: "i want market
// brief before newyork session and if any important event or any sudden
// movement in both instrument and all information related to it."
//
// THREE THINGS THIS DELIBERATELY DOES:
//
//  1. REQUIRES LAZILY, INSIDE A TRY. cli/ is a separate folder driving external
//     binaries. If it is missing, moved, or throws on load, that must degrade
//     this one tab — not take down a process that is also running the monitors,
//     Jessi and the broker feed. Same reasoning as the crash guards at the top
//     of this file.
//
//  2. CACHES. Building a brief costs ~6 CLI invocations and 30-60s (60 days of
//     5m bars for two instruments, plus context symbols). Without a cache every
//     tab switch would respawn all of it. `refresh: true` forces a rebuild.
//
//  3. NEVER PARTIALLY ANSWERS. One request, one whole-tab payload — the same
//     shape Week and Forensics use, so the panel can never merge a fresh number
//     into a stale view.
//
// The brief is READ-ONLY and carries no direction. There is no path from here
// to handleTradeConfirm and there must not be one.
let _briefCache = { at: 0, data: null };
const BRIEF_TTL_MS = 10 * 60 * 1000;

async function sendMarketBrief(ws, reqId, forceRefresh) {
  try {
    const fresh = Date.now() - _briefCache.at < BRIEF_TTL_MS;
    if (_briefCache.data && fresh && !forceRefresh) {
      send(ws, { type: 'brief-data', reqId: reqId, brief: _briefCache.data,
                 cached: true, ageMs: Date.now() - _briefCache.at });
      return;
    }
    const mb = require('../cli/market-brief');
    const brief = await mb.buildBrief();
    _briefCache = { at: Date.now(), data: brief };
    send(ws, { type: 'brief-data', reqId: reqId, brief: brief, cached: false, ageMs: 0 });
  } catch (e) {
    console.error('[brief] failed:', e && e.message);
    send(ws, { type: 'brief-data', reqId: reqId, brief: null,
               error: (e && e.message) || 'brief failed' });
  }
}

// Gold brief (2026-09-07). Anoop: "a second brief for MGC". Same cache
// discipline and same lazy-require-inside-try as sendMarketBrief above — see
// that function's header for why both matter. Cached separately from the
// combined brief because the two hit different symbol sets and one being warm
// says nothing about the other.
let _goldCache = { at: 0, data: null };

async function sendGoldBrief(ws, reqId, forceRefresh) {
  try {
    const fresh = Date.now() - _goldCache.at < BRIEF_TTL_MS;
    if (_goldCache.data && fresh && !forceRefresh) {
      send(ws, { type: 'gold-brief-data', reqId: reqId, brief: _goldCache.data,
                 cached: true, ageMs: Date.now() - _goldCache.at });
      return;
    }
    const gb = require('../cli/gold-brief');
    const brief = await gb.buildGoldBrief();
    _goldCache = { at: Date.now(), data: brief };
    send(ws, { type: 'gold-brief-data', reqId: reqId, brief: brief, cached: false, ageMs: 0 });
  } catch (e) {
    console.error('[gold-brief] failed:', e && e.message);
    send(ws, { type: 'gold-brief-data', reqId: reqId, brief: null,
               error: (e && e.message) || 'gold brief failed' });
  }
}

function sendWeekReport(ws, reqId, offset, extra) {
  try {
    const payload = buildWeekPayload(offset);

    // ── Lifetime context for the Week tab (2026-08-31) ────────────────────
    // The Week tab is server-driven, so the renderer's in-memory lifetime
    // overlay cannot reach it. Without this, starting a fresh eval makes
    // every prior week render as "—" and read as deleted history — the exact
    // complaint this work started from.
    //
    // It does NOT rewrite the week. A frozen week is a RECORD of one account
    // (see week-store.js's freeze doctrine) and must keep saying what it said
    // when he made a decision from it. So the slot's own week is served
    // unchanged, and this only ATTACHES what other accounts did in the same
    // calendar week. Presence elsewhere is reported; the record is not merged.
    try {
      const wk = payload && payload.week;
      const key = wk && wk.weekKey;
      if (key) {
        const lt = lifetimeStore.buildLifetime(DATA_DIR);
        const mine = (wk.days || []).filter(function (d) { return d && d.n > 0; }).length;
        const inWeek = (lt.days || []).filter(function (d) { return weekRollup.isoWeekKey(d.date) === key; });
        const byAccount = {};
        inWeek.forEach(function (d) {
          const label = d.accountLabel || d.slot || '?';
          if (!byAccount[label]) byAccount[label] = { label: label, slot: d.slot, days: 0, net: 0, trades: 0 };
          byAccount[label].days++;
          byAccount[label].net += Number(d.pnl) || 0;
          byAccount[label].trades += Number(d.n) || 0;
        });
        const accounts = Object.keys(byAccount).map(function (k) {
          byAccount[k].net = Math.round(byAccount[k].net * 100) / 100;
          return byAccount[k];
        });
        payload.lifetimeWeek = {
          weekKey: key,
          activeSlotDays: mine,
          totalDays: inWeek.length,
          accounts: accounts,
          // True only when THIS account has nothing but another one does —
          // the single case where a blank week is misleading rather than true.
          elsewhereOnly: mine === 0 && inWeek.length > 0,
          lifetime: { firstDate: lt.stats.firstDate, lastDate: lt.stats.lastDate, tradedDays: lt.stats.tradedDays, net: lt.stats.net },
        };
      }
    } catch (e) { console.warn('[week] lifetime context failed:', e.message); }

    send(ws, Object.assign({ type: 'week-report-data', reqId: reqId }, payload, extra || {}));
  } catch (e) {
    console.error('[week] report build failed:', e.message);
    send(ws, { type: 'week-report-data', reqId: reqId, week: null, error: e.message });
  }
}

/**
 * Freeze the named week: immutable record, Obsidian note, Telegram push.
 * Refuses an unfinished week (week-store enforces it too) so a partial week can
 * never become a permanent record indistinguishable from a real one.
 */
function freezeWeekNow(weekKey) {
  try {
    const cfg = loadConfig();
    const slot = jessiBucketKey(cfg);
    const raw = loadRules();
    const accountBlock = raw[currentMode] || raw.eval || {};
    const todayKey = tradingDayStampIST(Date.now());

    // Locate the requested week by key rather than trusting an offset from the
    // client — the tab and the server must agree on WHICH week got frozen.
    let anyDate = null;
    for (let i = 0; i >= -60; i--) {
      const d = new Date(weekRollup.weekStart(todayKey) + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i * 7);
      const iso = d.toISOString().slice(0, 10);
      if (weekRollup.isoWeekKey(iso) === weekKey) { anyDate = iso; break; }
    }
    if (!anyDate) return { frozenOk: false, freezeError: 'Unknown week ' + weekKey };

    const week = weekStore.buildWeek(DATA_DIR, slot, anyDate, todayKey, accountBlock);
    if (!week.complete) return { frozenOk: false, freezeError: 'That week has not finished yet.' };

    const prev = weekStore.buildWeek(DATA_DIR, slot, weekRollup.prevWeekStart(anyDate), todayKey, accountBlock);
    const hadPrev = prev.behaviour.tradedDays > 0 || prev.behaviour.heldFireDays > 0;
    const findings = weekRollup.weekFindings(week, hadPrev ? prev : null);
    const trend = weekRollup.compareWeeks(week, hadPrev ? prev : null);

    const rec = weekStore.freezeWeek(DATA_DIR, slot, week, findings, trend, Date.now());
    if (!rec) return { frozenOk: false, freezeError: 'Could not write the frozen record.' };

    const md = weekStore.writeWeekMarkdown(sessionMgr.SESSIONS_DIR, week, findings, trend, {
      slot: slot,
      doctrine: weekStore.loadDoctrine(DATA_DIR),
      grade: weekStore.gradeCommitment(week, weekStore.loadCommitment(DATA_DIR, slot, week.weekKey))
    });

    console.log('[week] froze ' + week.weekKey + ' (' + week.start + '..' + week.end + ') net '
      + week.money.net + ' → ' + (md || 'markdown FAILED'));

    // Silent no-op without a token/linked chat — that is why telegramReady is
    // reported to the UI rather than the button implying a push happened.
    try { telegramBot.notify(weekStore.telegramSummary(week, findings)); } catch (e) {}

    return { frozenOk: true, markdown: md, freezeError: null };
  } catch (e) {
    console.error('[week] freeze failed:', e.message);
    return { frozenOk: false, freezeError: e.message };
  }
}
// Wipe one account's whole folder — used by "Start fresh" so no layer survives.
//
// DOOR 2 (2026-09-04): this is the recursive delete that emptied
// DATA/accounts/s1 at 18:56 that day, taking day_trades.json, gr_history.json,
// balance_ledger.json AND all ten of their .bak-* files with it — because every
// per-file backup this repo wrote lived INSIDE the folder being removed. The
// snapshot goes to DATA/_snapshots/<slot>/, outside the blast radius, and is
// taken before the rmSync rather than after it for obvious reasons.
function dataWipeAccount(slotId) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(String(slotId || ''))) return false;
  try {
    const snapRes = accountSnapshot.snapshotSlot({ dataDir: DATA_DIR, slotId, reason: 'wipe' });
    if (snapRes && snapRes.ok) {
      console.log('[snapshot] ' + slotId + ': saved ' + snapRes.files.length + ' file(s) before wipe → ' + snapRes.dir);
    }
    fs.rmSync(path.join(DATA_DIR, 'accounts', slotId), { recursive: true, force: true });
    return true;
  } catch (e) { console.error('dataWipeAccount failed:', e.message); return false; }
}
// ── Per-account chart screenshots (2026-07-25) ────────────────────────────────
// Anoop: "can i add screenshot of the data which i trade and be saved in same
// account i add to?" — yes: accounts/<slotId>/screenshots/<date>__<ts>.png
// Stored as real image files (not base64 in JSON) so the folder stays browsable
// in Explorer and the JSON files stay small.
const SHOT_EXT_OK = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
function shotDir(slotId) { return path.join(DATA_DIR, 'accounts', String(slotId), 'screenshots'); }
function shotSave(slotId, dateStr, base64, ext) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(String(slotId || ''))) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const e = String(ext || 'png').toLowerCase().replace('.', '');
  if (!SHOT_EXT_OK[e]) return null;
  try {
    const dir = shotDir(slotId);
    fs.mkdirSync(dir, { recursive: true });
    // BUG FIX (caught in test): Date.now() alone collided when two images were
    // attached in the same millisecond — the second silently overwrote the
    // first. Add a short random suffix so every attachment is its own file.
    const name = `${dateStr}__${Date.now()}${Math.random().toString(36).slice(2, 6)}.${e}`;
    const raw = String(base64 || '').replace(/^data:[^,]+,/, '');
    fs.writeFileSync(path.join(dir, name), Buffer.from(raw, 'base64'));
    return name;
  } catch (err) { console.error('shotSave failed:', err.message); return null; }
}
function shotList(slotId, dateStr) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(String(slotId || ''))) return [];
  try {
    return fs.readdirSync(shotDir(slotId))
      .filter(f => !dateStr || f.indexOf(dateStr + '__') === 0)
      .sort();
  } catch { return []; }
}
function shotRead(slotId, file) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(String(slotId || ''))) return null;
  if (!/^[\w\-]+\.(png|jpe?g|webp)$/i.test(String(file || ''))) return null; // no traversal
  try {
    const e = String(file).split('.').pop().toLowerCase();
    const buf = fs.readFileSync(path.join(shotDir(slotId), file));
    return `data:${SHOT_EXT_OK[e] || 'image/png'};base64,` + buf.toString('base64');
  } catch { return null; }
}

// End-Day snapshot: immutable dated record inside the account's folder.
function dataEndDay(slotId, dateStr, payload) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(String(slotId || ''))) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
  try {
    const fp = path.join(DATA_DIR, 'accounts', slotId, 'daily', dateStr + '.json');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    atomicWrite.writeAtomic(fp, JSON.stringify(payload, null, 2), 'utf8');
    return fp;
  } catch (e) { console.error('dataEndDay failed:', e.message); return false; }
}

// ── PDF text extraction (for Analyze CSV → PDF uploads) ────────────────────────
// Lazy-required so a broken/missing pdf-parse install doesn't crash the whole
// server on boot — it only matters at the moment a PDF is actually uploaded.
//
// FIX (2026-07-21, "DOMMatrix is not defined" on Anoop's real machine): pdf-parse
// pulls in pdfjs-dist, which prefers @napi-rs/canvas for its DOMMatrix/Path2D/
// ImageData support — but @napi-rs/canvas ships one native binary PER PLATFORM
// as separate optional npm packages, and `npm install` only fully installs the
// one matching whatever machine ran the install. This dependency got installed
// from this session's Linux sandbox (a live-mounted shared folder, not Anoop's
// real machine), so node_modules ended up with a real Linux binary and an
// EMPTY placeholder folder for @napi-rs/canvas-win32-x64-msvc — confirmed by
// directly inspecting both folders (30MB vs 0 bytes, no package.json in the
// Windows one). On Anoop's Windows machine that native module fails to load,
// pdfjs-dist has no canvas backend, and it crashes referencing a bare global
// DOMMatrix that only exists in browsers, not plain Node.
// Fix: polyfill DOMMatrix from the pure-JS `dommatrix` package (no native
// binary, so no per-platform build problem) before pdf-parse/pdfjs-dist ever
// looks for it. This doesn't depend on @napi-rs/canvas resolving correctly on
// whatever machine this actually runs on.
async function extractPdfText(base64) {
  if (!base64) throw new Error('No PDF data received');
  if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = require('dommatrix');
  }
  const { PDFParse } = require('pdf-parse');
  const buf = Buffer.from(base64, 'base64');
  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  return result.text || '';
}

// 2026-08-17 (Anoop: "Update file" should read all kinds of trade reports,
// not just CSV/PDF). Excel exports (.xlsx/.xls) are a common broker-report
// format — parsed server-side the same way PDFs already are, converting the
// FIRST sheet straight to CSV text via SheetJS's own sheet_to_csv() so it
// flows through the exact same, already-tested csvIngest()/csvParseTrades()
// pipeline on the client — no new row-parsing logic to get wrong, same
// pattern handlePdfFile() already uses (extract → convert to CSV → reuse
// the CSV path). Dependency note: the plain `xlsx` package on npm is
// unpatched (known Prototype Pollution + ReDoS CVEs, no fix available per
// `npm audit` — SheetJS's real fix only ships via their own CDN). Installed
// instead as `xlsx: "npm:@e965/xlsx@^0.20.3"` — a provenance-signed npm
// republish of the patched build, the community-recommended fix referenced
// across SheetJS's own GitHub issues (#2822, #2825).
async function extractXlsxCsv(base64) {
  if (!base64) throw new Error('No spreadsheet data received');
  const XLSX = require('xlsx');
  const buf = Buffer.from(base64, 'base64');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) throw new Error('Spreadsheet has no sheets');
  const sheet = wb.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_csv(sheet);
}

// ── MIME types ─────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// ── HTTP server ────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  let url = req.url === '/' ? '/index.html' : req.url;
  url = url.split('?')[0];

  // ── GET /health (2026-08-12, task #5) ────────────────────────────────────
  // One place that answers "what is actually alive right now" without reading
  // the terminal. Two concrete uses:
  //   1. START CO-PILOT.bat currently just polls until the PORT accepts a
  //      connection — which is true the instant the socket binds, before the
  //      MCP bridge or TradingView are up. This reports real readiness.
  //   2. When something misbehaves mid-session, this distinguishes "the AI
  //      provider died" from "TradingView dropped" from "a monitor stopped" in
  //      one request, instead of guessing from symptoms.
  // Deliberately does NOT expose API keys — only whether each is configured.
  if (url === '/health') {
    let body;
    try {
      const cfg = loadConfig();
      const primary = primaryProviderModel();
      body = {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        mode: currentMode,
        ai: {
          primary: primary.provider + '/' + primary.model,
          fallbackChain: fallbackChainFor(primary).map(c => c.provider + '/' + c.model),
          keys: {                       // configured? — never the values
            deepseek: !!cfg.deepseekApiKey,
            gemini: !!cfg.geminiApiKey   // break-glass only
          },
          deepSeekDisabled: !!cfg.disableDeepSeek
        },
        tradingview: {
          bridgeReady: !!mcpBridge.ready,          // our child process is up
          tvConnected: !!mcpBridge.tvConnected,    // CDP actually reachable — these diverge, and that divergence caused a false "connected" indicator before
          // 2026-09-02: can this session place a REAL order? Set only by
          // "START CO-PILOT (LIVE ORDERS).bat". Surfaced because it was
          // previously unknowable from outside the process — you had to infer
          // it from which shortcut you double-clicked, and being wrong in
          // either direction is expensive: believing orders are armed when
          // they are not means a confirmed ticket silently does nothing,
          // and believing they are not when they are is worse.
          liveOrdersEnabled: process.env.TV_ALLOW_LIVE_ORDERS === '1'
        },
        monitors: {
          mechanical: !!mechanicalInterval,
          engulf: Object.keys(engulfMonitors || {}).length,
          sfp: Object.keys(sfpMonitors || {}).length
        }
      };
    } catch (e) {
      body = { ok: false, error: e.message };
    }
    res.writeHead(body.ok ? 200 : 503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body, null, 2));
  }

  // 2026-08-27: shared UMD modules live in app/ and are loaded by BOTH the
  // server and the page. index.html referenced them as '../mind-log.js',
  // which LOOKS right on disk and is not: a browser normalises '/../x' to
  // '/x' before the request is ever sent, so the server searched renderer/
  // and returned 404. window.MindLog / window.ArmedDetectors /
  // window.JournalNotes were silently undefined in the page, which is why
  // the Mind tab, the watchlist and the Journal scorecard rendered nothing.
  //
  // Caught only by fetching them from the running server. node --check and
  // the unit suite both passed the whole time — TRUST-PROTOCOL Rule 2.
  const SHARED_ROOT_MODULES = ['mind-log.js', 'armed-detectors.js', 'journal-notes.js'];
  let filePath = path.join(__dirname, 'renderer', url);
  if (!fs.existsSync(filePath)) {
    const base = path.basename(url);
    if (SHARED_ROOT_MODULES.indexOf(base) !== -1) filePath = path.join(__dirname, base);
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end('Not found');
  }

  const ext = path.extname(filePath);
  res.setHeader('Content-Type', MIME[ext] || 'text/plain');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(filePath).pipe(res);
});

// ── WebSocket server ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('Client connected');

  const cfg = loadConfig();
  send(ws, { type: 'config', data: cfg });
  send(ws, { type: 'mcp-status', connected: mcpBridge.ready && mcpBridge.tvConnected });
  send(ws, { type: 'tv-kill-status', killed: tvKilledByUser });
  send(ws, { type: 'mode-update', mode: currentMode });
  // The HTF chip must not be blank on a fresh page load. Uses the 60s-cached
  // read, so a reconnect storm cannot turn into a burst of chart switches.
  publishHtfStatus('client-connect', false).catch(function () {});
  for (const key of Object.keys(engulfMonitors)) {
    send(ws, { type: 'engulf-monitor-status', tf: key, running: engulfMonitors[key].running });
  }
  for (const key of Object.keys(fvgMonitors)) {
    send(ws, { type: 'fvg-monitor-status', tf: key, running: fvgMonitors[key].running });
  }
  for (const key of Object.keys(sfpMonitors)) {
    send(ws, { type: 'sfp-monitor-status', tf: key, running: sfpMonitors[key].running });
  }
  send(ws, { type: 'po3-monitor-status', running: po3Monitor.running });
  send(ws, { type: 'news-status', ...computeNewsStatus() });
  send(ws, { type: 'tradovate-account', ...(tradovate.lastSnapshot() || {}) });
  send(ws, { type: 'rules', data: getActiveRules() });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'config-set':       handleConfigSet(ws, msg);   break;
      case 'chat-send':        handleChat(ws, msg);        break;
      case 'jessi-chat-send':  handleJessiChat(ws, msg);   break;
      case 'debate-chat-send': handleDebateChat(ws, msg);  break;
      case 'post-session-review': handlePostSessionReview(ws, msg); break;
      case 'scalper-chat-send': handleScalperChat(ws, msg); break;
      case 'cancel-request':   handleCancelRequest(msg);   break;
      case 'tts-speak':        handleTtsSpeak(ws, msg);   break;
      case 'ict-po3':          handleIctPo3(ws, msg);     break;
      case 'po3-monitor-toggle':
        // 2026-08-17: track an explicit manual OFF so the new auto-start-on-
        // reconnect (see mcpBridge.on('tv-connected', ...)) can't silently
        // override a choice Anoop actually made — a CDP blip + heartbeat
        // recovery firing 'tv-connected' again should not un-disable a
        // monitor he deliberately turned off.
        po3MonitorUserDisabled = !msg.enabled;
        msg.enabled ? startPo3Monitor() : stopPo3Monitor();
        break;
      case 'po3-check-now': checkPo3Phase(); break;
      // Diagnostic: reports which TTS engines actually work on this machine.
      // Added 2026-07-28 so a voice failure can be identified in one step
      // instead of guessed at. Run from the browser console:
      //   window.api.ttsDiagnose().then(console.log)
      case 'tts-diagnose': {
        (async () => {
          const out = { platform: process.platform, edge: null, local: null, localVoices: [] };
          try {
            const c = await edgeTts.synthesizeClips('test', edgeTts.DEFAULT_VOICE);
            out.edge = 'OK (' + (c && c.length) + ' clip)';
          } catch (e) { out.edge = 'FAIL: ' + e.message; }
          try {
            if (!localTts.isAvailable()) out.local = 'unavailable (not Windows)';
            else {
              const c = await localTts.synthesizeClips('test');
              out.local = 'OK (' + (c && c.length) + ' clip, ' + (c[0] ? c[0].length : 0) + ' b64 chars)';
            }
          } catch (e) { out.local = 'FAIL: ' + e.message; }
          try { out.localVoices = await localTts.listVoices(); } catch (e) {}
          send(ws, { type: 'tts-diagnose-result', reqId: msg.reqId, ...out });
        })();
        break;
      }
      case 'jessi-voice-send': handleJessiVoiceSend(ws, msg); break;
      case 'jessi-app-action-result': {
        const p = pendingAppActions.get(msg.actionId);
        if (p) { pendingAppActions.delete(msg.actionId); p.resolve(msg.result || (msg.ok ? 'Done.' : 'Action failed.')); }
        break;
      }
      case 'journal-add':      handleJournalAdd(ws, msg);  break;
      // 2026-07-25: per-account dataset management (D:\co-pilot DATA)
      case 'data-wipe-account':
        send(ws, { type: 'data-wiped', reqId: msg.reqId, ok: dataWipeAccount(msg.slotId) });
        break;
      case 'data-end-day': {
        const fp = dataEndDay(msg.slotId, msg.date, msg.payload || {});
        send(ws, { type: 'data-end-day-saved', reqId: msg.reqId, ok: !!fp, path: fp || null });
        break;
      }
      case 'data-dir-get':
        send(ws, { type: 'data-dir', reqId: msg.reqId, dir: DATA_DIR, isFallback: DATA_DIR === FALLBACK_DATA_DIR, wanted: (loadConfig().dataDir || DEFAULT_DATA_DIR) });
        break;
      // Per-account daily note (Daily Journal) — accounts/<slot>/notes.json
      case 'note-save': {
        const notes = dataLoad('notes__' + msg.slotId) || {};
        notes[msg.date] = msg.note || {};
        send(ws, { type: 'note-saved', reqId: msg.reqId, ok: dataSave('notes__' + msg.slotId, notes) });
        break;
      }

      // ── Weekly Report (2026-08-29) ───────────────────────────────────────
      // Four requests, ONE reply shape. Every handler mutates at most one
      // thing and then re-derives the whole payload from disk, so the tab can
      // never show a number the server did not just recompute. The client is
      // pure presentation; see renderer/week-report.js for why that split is
      // load-bearing rather than tidy.
      // ── Forensics tab (2026-09-05) ───────────────────────────────────────
      case 'forensics-get':
        sendForensicsReport(ws, msg.reqId);
        break;

      // ── Market Brief tab (2026-09-06) ────────────────────────────────────
      case 'brief-get':
        sendMarketBrief(ws, msg.reqId, msg.refresh);
        break;

      case 'gold-brief-get':
        sendGoldBrief(ws, msg.reqId, msg.refresh);
        break;

      case 'week-report-get':
        sendWeekReport(ws, msg.reqId, msg.offset);
        break;

      case 'week-doctrine-set': {
        // The doctrine is stored verbatim and NEVER regenerated — that is the
        // whole point of it being an anchor. Anoop chose "fixed doctrine +
        // weekly delta" over a model-written mindset section.
        weekStore.saveDoctrine(DATA_DIR, msg.text, Date.now());
        sendWeekReport(ws, msg.reqId, msg.offset);
        break;
      }

      case 'week-commit-set': {
        const slot = jessiBucketKey(loadConfig());
        const saved = weekStore.saveCommitment(DATA_DIR, slot, msg.weekKey, msg.commitment, Date.now());
        if (saved) {
          console.log('[week] commitment for ' + msg.weekKey + ': size<=' + saved.maxSize
            + ', trades/day<=' + saved.maxTradesPerDay
            + (saved.stopTheWeekAt != null ? ', stop at ' + saved.stopTheWeekAt : ''));
        } else {
          console.log('[week] commitment REJECTED — bad week key: ' + msg.weekKey);
        }
        sendWeekReport(ws, msg.reqId, msg.offset);
        break;
      }

      case 'week-freeze': {
        const r = freezeWeekNow(msg.weekKey);
        sendWeekReport(ws, msg.reqId, msg.offset, r);
        break;
      }
      // Chart screenshot for a given day, stored inside that account's folder
      case 'shot-save': {
        const r = shotSave(msg.slotId, msg.date, msg.base64, msg.ext);
        send(ws, { type: 'shot-saved', reqId: msg.reqId, ok: !!r, file: r || null });
        break;
      }
      case 'shot-list':
        send(ws, { type: 'shot-list', reqId: msg.reqId, files: shotList(msg.slotId, msg.date) });
        break;
      case 'shot-read':
        send(ws, { type: 'shot-data', reqId: msg.reqId, dataUrl: shotRead(msg.slotId, msg.file) });
        break;
      case 'mcp-call':         handleMCPCall(ws, msg);     break;
      case 'session-start':    handleSessionStart(ws, msg);break;
      case 'session-trade':    handleSessionTrade(ws, msg);break;
      case 'session-read':
        send(ws, { type: 'session-data', reqId: msg.reqId, data: sessionMgr.readSession(msg.date) });
        break;
      case 'session-list':
        send(ws, { type: 'session-list', reqId: msg.reqId, data: sessionMgr.listSessions() });
        break;
      case 'screenshot-get':   handleScreenshot(ws, msg);  break;
      case 'mcp-reconnect':    startMCP();                 break;
      case 'tv-kill':          handleTvKill(ws);           break;
      case 'tv-restore':       handleTvRestore(ws);        break;
      case 'tv-kill-status-get': broadcastTvKillStatus();  break;
      case 'checklist-done':   handleChecklistDone(ws, msg); break;
      case 'account-db-rebuild': handleAccountDbRebuild(ws, msg); break;
      case 'journey-action':   handleJourneyAction(ws, msg); break;
      case 'journey-list':     handleJourneyList(ws, msg);   break;
      case 'mode-switch':      handleModeSwitch(ws, msg);  break;
      case 'engulf-monitor-toggle': handleEngulfToggle(msg); break;
      case 'engulf-check-now': checkEngulfingSignal(msg.tf || '1h'); break;
      case 'tv-broker-check-now': pollTVBrokerAccount(); break;
      // ── Oversize guard: state on demand, and an explicit switch ──────────
      // A guard whose state you cannot ask for is a guard you have to TRUST,
      // and on 2026-09-02 that trust was misplaced for a whole session. The
      // status message is what makes the UI badge honest; the toggle is
      // deliberately loud (see handleOversizeGuardToggle).
      case 'oversize-guard-status': send(ws, { type: 'oversize-guard-status', status: oversizeGuardStatus() }); break;
      case 'oversize-guard-toggle': handleOversizeGuardToggle(ws, msg); break;
      // ── Lifetime history (2026-08-31) ─────────────────────────────────────
      // Anoop started a second eval and every history tab went blank, because
      // they all read the ACTIVE slot only. Nothing had been deleted — 16
      // traded days were sitting in other slots and in account_archives.json.
      // This serves the merged, deduped, boundary-marked record. READ-ONLY:
      // lifetime-store.js never writes, so this can never damage a slot.
      // PROTOCOL 3 (TRUST). Protocol 1 asks "is it running", Protocol 2 asks
      // "is the feed reading". Neither caught 2026-08-31, when both were fine
      // and the app still published 2 trades / 1W-1L / best $8 against a
      // broker record of 10 trades / 6W-4L / +$30. This asks the third
      // question: is what is on screen supported by the data behind it?
      case 'bar-record-run': runBarRecorder('manual', ws, msg.reqId); break;

      case 'exit-drift-get': runExitDrift(ws, msg.reqId); break;
      case 'exit-mark-chart': markExitOnChart(ws, msg.reqId); break;

      case 'trust-protocol-run': runTrustProtocol('manual', ws, msg.reqId); break;

      case 'lifetime-get': {
        try {
          const lt = lifetimeStore.buildLifetime(DATA_DIR);
          send(ws, { type: 'lifetime-data', reqId: msg.reqId, data: lt });
        } catch (e) {
          console.warn('[lifetime] build failed:', e.message);
          send(ws, { type: 'lifetime-data', reqId: msg.reqId, error: e.message });
        }
        break;
      }
      // 2026-08-23: manual re-run of the visible 3-step check. runLiveFeedSelfTest
      // now REPAIRS an unmounted broker panel as part of check 2, so this button
      // is a genuine 'fix it now', not just a re-report.
      case 'live-feed-selftest-run': runLiveFeedSelfTest().catch(e => console.warn('[self-test] manual run failed:', e.message)); break;
      case 'health-protocol-run': runHealthProtocol('manual').catch(e => console.warn('[protocol:health] manual run failed:', e.message)); break;
      case 'feed-protocol-run': runFeedIntegrityProtocol('manual').catch(e => console.warn('[protocol:feed] manual run failed:', e.message)); break;
      case 'trade-confirm-request': handleTradeConfirm(ws, msg); break;
      case 'fvg-monitor-toggle': handleFVGToggle(msg); break;
      case 'fvg-check-now': checkFVGSignal(msg.tf || '30m'); break;
      case 'sfp-monitor-toggle': handleSFPToggle(msg); break;
      case 'watchers-get': send(ws, { type: 'watchers-status', data: buildWatchersStatus() }); break;
      case 'signal-decision': handleSignalDecision(ws, msg); break;
      case 'armed-setup-get': send(ws, { type: 'armed-setup', setup: readArmedSetup() }); break;
      case 'h6-get': send(ws, { type: 'h6-status', passed: h6Status.passed, at: h6Status.at, firstOk: h6Status.firstOk }); break;
      case 'autonomy-set': { handleAutonomySet(msg); break; }
      case 'autonomy-get': { broadcastAutonomy(); break; }
      case 'scorecard-get': {
        const dayKey2 = tradingDayStampIST(Date.now());
        let sigs = [];
        try {
          const f = path.join(DATA_DIR, 'signals', dayKey2 + '.jsonl');
          if (fs.existsSync(f)) sigs = fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
        } catch (e) {}
        const dt2 = dataLoad('day_trades__' + jessiBucketKey(loadConfig())) || {};
        send(ws, { type: 'scorecard-data', h6: h6Status, day: dayKey2, signals: sigs, rows: Array.isArray(dt2[dayKey2]) ? dt2[dayKey2] : [] });
        break;
      }
      case 'sfp-check-now': checkSFPSignal(msg.tf || '30m'); break;
      case 'mark-london-levels': markLondonLevels(); break;
      case 'mark-ny-levels': markNYLevels(); break;
      case 'news-refresh': refreshNewsAndBroadcast(true); break;
      case 'mark-news-times': markNewsTimesOnChart(); break;
      case 'mechanical-check': runMechanicalAnalysis(); break;
      case 'tradovate-test': handleTvTest(ws, msg); break;
      case 'tradovate-restart': startTradovate(); break;
      case 'rules-get':  send(ws, { type: 'rules', reqId: msg.reqId, data: getActiveRules() }); break;
      case 'rules-set':
        try {
          const _next = Object.assign(loadRules(), msg.data || {});
          // sizeCap is the one rule the UI can move, so it is the one rule the
          // UI must not be trusted with. Clamped here, server-side, because a
          // renderer bug or a replayed message must not be able to widen it.
          // G32 (2026-09-15): the protection band is settable from the UI, so like sizeCap it
          // is clamped SERVER-SIDE - a renderer bug or a replayed message must not be able to
          // widen a risk number. clampAutoProtection also re-attaches the block's own
          // _comment/_status strings, which a plain Object.assign would have dropped.
          if (msg.data && msg.data.autoProtection) {
            _next.autoProtection = tradeProtection.clampAutoProtection(msg.data.autoProtection, loadRules());
          }
          if (msg.data && msg.data.sizeCap !== undefined) {
            const _cap = stageRules.clampSizeCap(msg.data.sizeCap, _next);
            _next.sizeCap = _cap;
            // The stage blocks own contract size (stage is applied LAST and
            // eval PERMITS to exactly its block value), so a top-level write
            // alone would be overwritten on the very next read. EVAL therefore
            // follows his dial.
            //
            // ── FUNDED DOES NOT (2026-09-08) ──────────────────────────────
            // It used to. That single line made Anoop's own decision
            // structurally unrepresentable: on 2026-09-05 he was asked directly
            // and said "No, funded stays at 2", the file was changed, and the
            // very next nudge of the titlebar Cap control at 21:05 silently put
            // it back to 4 — because this handler forced both blocks to the
            // same number. He was never told; nothing in the UI shows the
            // funded block at all.
            //
            // Funded is the account that pays out and the one where his own
            // record says every size except 2 loses money (-$1,717 over 31
            // trades). The stage layer exists precisely so funded can be
            // TIGHTER than whatever else is going on — funded clamps by min, so
            // leaving its block alone means his dial can lower funded but never
            // raise it. Raising the funded cap is a deliberate edit to
            // rules.json, not a side effect of a button he presses to change
            // the eval cap.
            if (_next.stageRules) {
              if (_next.stageRules.eval) _next.stageRules.eval.sizeCap = _cap;
            }
            if (_cap !== Math.floor(Number(msg.data.sizeCap))) {
              console.warn('[rules] sizeCap request ' + msg.data.sizeCap + ' clamped to ' + _cap);
            }
          }
          saveRules(_next);
          broadcast({ type: 'rules', data: getActiveRules() });
        } catch (e) { send(ws, { type: 'rules-error', message: e.message }); }
        break;
      case 'trading-mode-set': {
        const mode = (msg.mode === 'scalper') ? 'scalper' : 'standard';
        const raw = loadRules();
        raw.tradingMode = mode;
        saveRules(raw);
        broadcast({ type: 'rules', data: getActiveRules() });
        broadcast({ type: 'trading-mode', mode });
        break;
      }
      case 'trading-mode-get':
        send(ws, { type: 'trading-mode', reqId: msg.reqId, mode: loadRules().tradingMode || 'standard' });
        break;
      case 'data-save':
        send(ws, { type: 'data-saved', reqId: msg.reqId, ok: dataSave(msg.key, msg.payload) });
        break;
      case 'data-load':
        // 2026-08-25: 'mind_log' goes through mindLogLoad(), not the raw file
        // read. The merged Alignment+Lessons store is built lazily on first
        // access, and the RENDERER is usually the first thing to ask for it —
        // a plain dataLoad returns null before any migration has run, so the
        // tab painted "Nothing written yet" over six real entries sitting in
        // align_notes.json. Routing it here makes the request itself migrate.
        send(ws, {
          type: 'data-loaded', reqId: msg.reqId,
          data: msg.key === 'mind_log' ? mindLogLoad() : dataLoad(msg.key),
        });
        break;
      // ── Chat archive (2026-09-03) ───────────────────────────────────────
      // Anoop: "i want all the data that comes on the chat to be saved as it
      // comes." The renderer captures every row that appears in the chat pane
      // (renderer/chat-archive.js) and posts it here; chat-archive.js appends
      // it to DATA/chat_archive/<trading-day>.jsonl and never rewrites a byte.
      //
      // The ack matters. The client holds an outbox and only clears a batch
      // once the server confirms it landed on disk, so a dropped socket or a
      // failed write costs a retry rather than the conversation — rawSend()
      // in ws-client.js silently no-ops when the socket is closed, which is
      // exactly how "saved as it comes" would otherwise become "saved when
      // the connection happened to be up".
      case 'chat-archive-append': {
        let ctx = { nowMs: Date.now(), slot: null, mode: currentMode };
        try { ctx.slot = jessiBucketKey(loadConfig() || {}); } catch (e) {}
        const res = chatArchive.appendRecords(DATA_DIR, msg.rows, ctx);
        if (!res.ok) console.error('[chat-archive] append failed:', res.error);
        send(ws, {
          type: 'chat-archive-appended', reqId: msg.reqId,
          batchId: msg.batchId || null,
          ok: res.ok, written: res.written, error: res.error
        });
        break;
      }
      // Read it back. scope: 'recent' (last N rows, reading order) |
      // 'day' (one trading day in full) | 'search' (AND-terms, newest first) |
      // 'stats' (how much is on file) | 'days' (which days exist).
      case 'chat-archive-query': {
        let data = null, error = null;
        try {
          const scope = msg.scope || 'recent';
          if (scope === 'day')          data = chatArchive.readDay(DATA_DIR, msg.day);
          else if (scope === 'search')  data = chatArchive.search(DATA_DIR, { query: msg.query, limit: msg.limit, days: msg.days });
          else if (scope === 'stats')   data = chatArchive.stats(DATA_DIR);
          else if (scope === 'days')    data = chatArchive.listDays(DATA_DIR);
          else                          data = chatArchive.readRecent(DATA_DIR, { limit: msg.limit, roles: msg.roles });
        } catch (e) { error = e.message; }
        send(ws, { type: 'chat-archive-result', reqId: msg.reqId, scope: msg.scope || 'recent', data, error });
        break;
      }
      // ── Pattern memory (2026-09-03) — see server.js's THE LOOP block ──────
      // scope: 'memory' (every pattern, summarised) | 'kind' (one pattern in
      // full) | 'ledger' (raw episodes) | 'stats'.
      case 'pattern-memory-query': {
        let data = null, error = null;
        try {
          const ledger = patternMemoryStore.readLedger(DATA_DIR);
          const scope = msg.scope || 'memory';
          if (scope === 'kind')        data = patternMemory.recurrence(ledger, String(msg.kind || ''));
          else if (scope === 'ledger') data = msg.date ? ledger.filter(e => e.date === msg.date) : ledger.slice(-(msg.limit || 200));
          else if (scope === 'stats')  data = patternMemoryStore.stats(DATA_DIR);
          else                         data = patternMemory.summarize(ledger);
        } catch (e) { error = e.message; }
        send(ws, { type: 'pattern-memory-result', reqId: msg.reqId, scope: msg.scope || 'memory', data, error });
        break;
      }
      // Run the Loop on demand (2026-09-03). Two reasons this exists rather
      // than leaving the agent purely reactive:
      //   1. It is the only way to VERIFY the agent end to end without waiting
      //      for a real repeat to happen on a live account.
      //   2. "Why do you keep doing this?" is a question he should be able to
      //      ask, not only one the app decides to answer.
      // Bypasses the once-per-day gate on purpose — this is an explicit
      // request, not an interruption, so the rule that stops the app talking
      // over itself does not apply. It does NOT bypass the repeat bar: with
      // nothing repeated there is genuinely nothing for this agent to say.
      case 'loop-run': {
        try {
          const ledger = patternMemoryStore.readLedger(DATA_DIR);
          const day = msg.date || tradingDayStampIST();
          let pool = patternMemory.onlyFromDay(ledger, day);
          if (msg.kind) pool = pool.filter(e => e.kind === msg.kind);
          // Falling back to the whole ledger is deliberate for an EXPLICIT
          // ask: on a day he has not traded, "show me my worst pattern" should
          // answer from the record rather than report nothing.
          if (!pool.length) {
            pool = msg.kind ? ledger.filter(e => e.kind === msg.kind) : ledger;
          }
          const primary = patternMemory.pickPrimary(pool, ledger);
          if (!primary) {
            send(ws, { type: 'loop-run-result', reqId: msg.reqId, ok: false, error: 'Nothing on the pattern ledger to speak about yet.' });
            break;
          }
          const rec = patternMemory.recurrence(ledger, primary.kind);
          if (rec.count < 2) {
            send(ws, { type: 'loop-run-result', reqId: msg.reqId, ok: false, error: `"${primary.kind}" has happened once. The Loop only speaks about repeats.` });
            break;
          }
          send(ws, { type: 'loop-run-result', reqId: msg.reqId, ok: true, kind: primary.kind, count: rec.count });
          runLoopAgent(primary, rec, ledger);   // broadcasts loop-feedback when done
        } catch (e) {
          send(ws, { type: 'loop-run-result', reqId: msg.reqId, ok: false, error: e.message });
        }
        break;
      }
      // Read back archived Judge verdicts / Post-Session reviews (2026-07-31).
      case 'reviews-load':
        send(ws, {
          type: 'reviews-loaded', reqId: msg.reqId,
          data: loadRecentReviews(msg.limit || 20, msg.kind || null)
        });
        break;
      case 'pdf-extract':
        extractPdfText(msg.base64)
          .then(text => send(ws, { type: 'pdf-extracted', reqId: msg.reqId, ok: true, text }))
          .catch(err => send(ws, { type: 'pdf-extracted', reqId: msg.reqId, ok: false, error: err.message }));
        break;
      case 'xlsx-extract':
        extractXlsxCsv(msg.base64)
          .then(csv => send(ws, { type: 'xlsx-extracted', reqId: msg.reqId, ok: true, csv }))
          .catch(err => send(ws, { type: 'xlsx-extracted', reqId: msg.reqId, ok: false, error: err.message }));
        break;
      default: break;
    }
  });

  ws.on('close', () => console.log('Client disconnected'));
});

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  wss.clients.forEach(ws => send(ws, obj));
}

// 2026-08-17: lets handleDebateChat/dispatchGoRefutation be invoked with
// ws=null for a system-initiated debate (see autoTriggerDebate below) — every
// connected client sees it instead of one specific request's socket, which
// doesn't exist for a background trigger.
function emitTo(ws, obj) {
  if (ws) send(ws, obj); else broadcast(obj);
}

// ── Handler: Config ────────────────────────────────────────────────────────────
function handleConfigSet(ws, msg) {
  const cfg = loadConfig();
  cfg[msg.key] = msg.value;
  saveConfig(cfg);
  if (msg.key === 'deepseekApiKey') groqAgent.initDeepSeek(msg.value);
  if (msg.key === 'geminiApiKey') groqAgent.initGemini(msg.value);
  if (msg.key === 'tvEnabled') startTradovate();
  send(ws, { type: 'config-saved', key: msg.key });
}

// ── Handler: Mode switch ───────────────────────────────────────────────────────
// Fires the moment he presses ✓ PRE-TRADE DONE (2026-08-13). His ask: "This is
// a reminder that you should give me on the chat after I complete the checklist."
//
// Deliberately NOT an LLM call: it is a deterministic restatement of what he
// just declared plus arithmetic over his own record. An LLM here would cost
// tokens and latency to paraphrase numbers it would occasionally get wrong,
// and the whole point is that he asked for PROOF.
// 2026-08-13 (Anoop): "gather all the information of all the accounts and
// make one database to analyse." Rebuilds DATA/account_database.json from
// every slot folder under DATA/accounts/ — read-only aggregation, never
// mutates any per-account source file. Reuses this server's already-resolved
// DATA_DIR rather than account-db.js guessing its own path, so this always
// reads the SAME location the rest of the app is actually writing to.
const accountDb = require('./account-db');
const journeyTracker = require('./journey-tracker');
function handleAccountDbRebuild(ws, msg) {
  try {
    const db = accountDb.rebuildAccountDatabase(DATA_DIR);
    // 2026-08-13 (Anoop: "make excel... CSV file... not excel"): every trade,
    // every account, one file, so he can see it all at once without hunting
    // through 5 separate account tabs. Written to disk (account_trades.csv,
    // same folder as the JSON database) AND handed back in the response so
    // the renderer can trigger an immediate browser download — no need to
    // go find the file on disk first.
    const csvOut = accountDb.writeTradesCsv(DATA_DIR, db);
    // 2026-08-13 (Anoop: "why is the data unreadable to a normal person...
    // I don't want it to be saved as code"): one self-contained HTML file,
    // opens in any browser, styled tables, no software to configure.
    const htmlOut = accountDb.writeHtmlReport(DATA_DIR, db);
    send(ws, { type: 'account-db-result', reqId: msg && msg.reqId, ok: true, summary: accountDb.formatSummary(db), db: db, csv: csvOut.csv, html: htmlOut.html });
  } catch (e) {
    console.error('[account-db] rebuild failed:', e.message);
    send(ws, { type: 'account-db-result', reqId: msg && msg.reqId, ok: false, error: e.message });
  }
}

// ── Account journeys: single-dataset eval→funded lifecycle (2026-08-16) ────
// See journey-tracker.js for the full model and why it replaced the old
// per-click account_archives.json mechanism. One WS action per real-world
// event; each is a guarded state transition, so a stray/duplicate click is
// rejected rather than silently recorded a second time or under the wrong
// slot. slotId is what the renderer already knows from the existing
// breach/clear buttons — activeJourneyForSlot() finds the right journey so
// the client never has to track journey ids itself.
function handleJourneyAction(ws, msg) {
  try {
    const action = msg.action;
    let result;
    if (action === 'start') {
      const journey = journeyTracker.startEvalJourney(DATA_DIR, { slotId: msg.slotId, size: msg.size, startBalance: msg.startBalance });
      result = { ok: true, journey: journey };
    } else {
      const journey = journeyTracker.activeJourneyForSlot(DATA_DIR, msg.slotId);
      if (!journey) { result = { ok: false, reason: 'no-active-journey' }; }
      else if (action === 'eval-breach') result = journeyTracker.recordEvalBreach(DATA_DIR, journey.id, { finalBalance: msg.finalBalance });
      else if (action === 'eval-cleared') result = journeyTracker.recordEvalCleared(DATA_DIR, journey.id, { finalBalance: msg.finalBalance, fundedStartBalance: msg.fundedStartBalance });
      else if (action === 'funded-breach') result = journeyTracker.recordFundedBreach(DATA_DIR, journey.id, { finalBalance: msg.finalBalance });
      else if (action === 'funded-payout') result = journeyTracker.recordFundedPayout(DATA_DIR, journey.id, { amount: msg.amount, date: msg.date });
      else result = { ok: false, reason: 'unknown-action' };
    }
    send(ws, { type: 'journey-result', reqId: msg.reqId, action: action, ok: result.ok, reason: result.reason, journey: result.journey });
  } catch (e) {
    console.error('[journey] action failed:', e.message);
    send(ws, { type: 'journey-result', reqId: msg && msg.reqId, ok: false, reason: 'exception' });
  }
}

function handleJourneyList(ws, msg) {
  try {
    const journeys = journeyTracker.readJourneys(DATA_DIR);
    send(ws, { type: 'journey-list', reqId: msg && msg.reqId, journeys: journeys });
  } catch (e) {
    send(ws, { type: 'journey-list', reqId: msg && msg.reqId, journeys: [] });
  }
}

function handleChecklistDone(ws, msg) {
  try {
    const rules = getActiveRules();
    if (rules.biasAdherence && rules.biasAdherence.enabled === false) return;
    const loaded = biasLoadMatrix();
    const ck = (msg && msg.record) || null;
    if (!ck) return;
    const text = biasTracker.formatPostChecklist(ck, loaded && loaded.matrix, rules);
    if (!text) return;
    send(ws, { type: 'bias-note', text: text });
    console.log('[bias] post-checklist reminder sent for ' + (ck.date || '?'));
  } catch (e) {
    // Never let this break the checklist completion he just earned.
    console.warn('[bias] post-checklist reminder failed:', e.message);
  }
}

function handleModeSwitch(ws, msg) {
  setCurrentMode(msg.mode);
}

// Shared mode-switch logic used by both the browser WS handler and the
// Telegram /mode command, so both surfaces stay in sync (same currentMode
// variable, same broadcast to all connected browser clients).
function setCurrentMode(mode) {
  currentMode = mode === 'eval' ? 'eval' : 'funded';
  const cfg = loadConfig();
  cfg.mode = currentMode;
  saveConfig(cfg);
  broadcast({ type: 'mode-update', mode: currentMode });
  console.log(`Mode switched to: ${currentMode.toUpperCase()}`);
}

// ── Handler: Chat ──────────────────────────────────────────────────────────────
async function handleChat(ws, msg) {
  const { messages, reqId } = msg;

  let extraContext = null;
  try {
    const align = formatAlignmentNotes(3);
    if (align) extraContext = `### His own words about himself — current state AND standing lessons (read before coaching; don't just cite it, factor it in):\n${align}`;
  } catch (e) {}

  const abortCtrl = registerRequest(reqId);
  try {
    // ── 2026-08-11: ONE PROVIDER, ONE DIRECTION ──────────────────────────────
    // Until today this single handler was the ONLY one of the app's nine AI
    // call sites that used Anthropic (via claude-agent.js); the other eight all
    // went through groq-agent.js on Gemini. Nothing surfaced that split in the
    // UI, so "which model am I talking to?" had no answer you could see — and
    // it cost Anoop hours of confusion trying to work out whether his Anthropic
    // key was live.
    //
    // handleChat now uses the SAME groqAgent.stream() + primaryProviderModel()
    // path as every other agent, so switching provider is one function, in one
    // place, for the whole app. claude-agent.js is deliberately NOT deleted —
    // it holds the working native-Anthropic implementation (prompt caching, 1h
    // TTL, tool loop) that the forthcoming Anthropic adapter for groq-agent.js
    // will be modelled on. Its system prompt and tool definitions are reused
    // here via its _debug export so there is still exactly one copy of the
    // Claude-path persona and toolset in the codebase.
    //
    // Tool-shape note: claude-agent's ALL_TOOLS are Anthropic-shaped
    // ({name, description, input_schema}); groq-agent speaks OpenAI shape
    // ({type:'function', function:{name, description, parameters}}). Converted
    // inline below. This conversion disappears once the native adapter lands.
    const systemPrompt = claudeAgent._debug.buildSystemPrompt(currentMode)
      + (extraContext ? '\n\n' + extraContext : '');
    const chatTools = claudeAgent._debug.ALL_TOOLS.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));
    const primary = primaryProviderModel();
    await groqAgent.stream(messages, systemPrompt, chatTools, {
      provider: primary.provider,
      model: primary.model,
      temperature: 0.85,
      signal: abortCtrl.signal,
      fallbackChain: fallbackChainFor(primary),
      // ── Tool routing for the main chat (2026-09-03) ──────────────────────
      // This path used to pass NO executor, so groq-agent sent every tool
      // call straight to the TradingView MCP bridge. That is right for the
      // chart tools and wrong for the two ALL_TOOLS entries that are not
      // chart tools: search_books has been advertised to this agent since
      // 2026-07-27 and could only ever have failed at the bridge, and
      // recall_chat (the chat archive) would have done the same. Everything
      // else falls through to the bridge with the same call it made before,
      // so chart behaviour on this path is byte-for-byte unchanged.
      toolExecutor: async (name, args) => {
        if (name === 'recall_chat') return recallChat(args);
        if (name === 'recall_patterns') return recallPatterns(args);
        if (name === 'diagnose_day') return diagnoseDay(args);
        if (name === 'search_books') {
          const query = (args && args.query) || '';
          if (!query.trim()) return 'search_books needs a "query".';
          const results = booksIndex.searchBooks(query, { limit: 4, book: (args && args.book) || null });
          if (!results.length) return `No passages found for "${query}" in the book library.`;
          return results.map(r => `[${r.title}]\n${r.text}`).join('\n\n---\n\n');
        }
        const raw = await mcpBridge.callTool(name, args || {});
        return (raw && raw.content) ? raw.content.map(c => c.text || '').join('\n') : JSON.stringify(raw);
      },
      onToken:    (text)              => send(ws, { type: 'chat-token',     reqId, text }),
      onToolStart:(name, id)          => send(ws, { type: 'chat-tool-start',reqId, name, id }),
      onToolDone: (name, id, ok, res) => send(ws, { type: 'chat-tool-done', reqId, name, id, ok, result: res }),
      onDone:     (fullText)          => send(ws, { type: 'chat-done',      reqId, fullText }),
      onError:    (errMsg)            => send(ws, { type: 'chat-error',     reqId, message: errMsg })
    });
  } finally {
    unregisterRequest(reqId);
  }
}

// ── Jessi — Groq-backed accountability companion ────────────────────────────────
// Separate persona/backend from the main claudeAgent chat above. Jessi is meant
// to be talked to casually between setups, has read access to ingested trade
// data / checklist / insights / breach history, and can be asked about the live
// chart on demand (a lightweight regex gate below fetches one TV snapshot per
// message when it looks needed — not a standing background poll).
const JESSI_PERSONA = `You are Jessi Livermore — Anoop Habib's accountability coach and psychological companion for prop-firm trading, built into his MNQ Co-Pilot app. Named after the trader Jesse Livermore (Anoop's own spelling, not corrected).

Who you're talking to: Anoop Habib, Hubballi, Karnataka, India (IST). Trades MNQ (Micro Nasdaq) and MGC (Micro Gold) as a Lucid Trading prop-firm scalper. THE GOAL IS ONE CLEAN PAYOUT, not a spotless record — he can take more evaluation attempts than he has capital to worry about, and the only account he cannot afford is the funded one he is careless with. Past losses hit Max Loss Limit every time, via the same handful of failure modes (trade-count escalation, revenge clusters, inverted R:R, holding losers, giving back gains after being up) — those are the specific behaviors to watch for, cited BY BEHAVIOR when they show up in his data, never as a running tally of accounts lost. A tally reads as "this is already decided" and kills the motivation to try the next one clean; a named behavior in today's data is something he can still act on right now.
STAGE ASYMMETRY (his own framing, 2026-08-13): evaluation is where he can afford to spend TIME — clearing it fast is the goal, not zero risk. Funded is where the discipline must be tightest, because that is the account that actually pays out. Grade eval on pace-to-clear; grade funded on process purity. Do not apply funded-strictness language to an eval account or eval-patience language to a funded one.
He is running SINGLE funded accounts for now, building capital one payout at a time — not simultaneous multi-account copy-trading. Do not suggest running several accounts at once unless he raises it himself; that is a later-stage plan, not today's.
## COACHING PROTOCOL (added 2026-08-11 at Anoop's request — follow this every reply)
Anoop's words: "It is just pointing out to me that I am making the mistake. There is no
motivation... it should motivate me to keep calm, relax, and trade when needed."
He is right. Until now you were only ever handed losses, violations and blown accounts,
so every reply read like a prosecution. You now also receive a PROCESS section
(app_get_data "process"). Use it. The rules:

1. LEAD WITH WHAT IS WORKING. Open with something true and specific he did right —
   a clean day, a discipline streak, a loss he cut properly, a day he chose not to
   trade. Pull it from the PROCESS data, never invent it. If there is genuinely
   nothing, say so plainly and move on — do not manufacture praise.
2. A RED DAY WITH CLEAN RULES IS A WIN. Say it in those words. Process is the score,
   P&L is the weather.
3. NOT TRADING IS A RESULT, NOT A GAP. Waiting, standing down, and stopping early are
   the skill itself. Never imply he "did nothing" on a no-trade day.
4. SAY YES WHEN IT IS YES. If conditions genuinely align and his process is clean, say
   so clearly and without hedging. A coach who only ever says no carries no information —
   his NO stops meaning anything, and he starts ignoring both. This matters for his
   safety, not his mood.
5. ONE correction per reply, maximum. Name the single highest-leverage thing. Do not
   stack every failure mode into one message — a list of everything wrong is not
   coaching, it is noise, and he stops reading.
6. AFTER A LOSING DAY, DO NOT PILE ON. He already knows. Acknowledge it once, then go to
   what he controls tomorrow. Never re-litigate a closed day he has already accepted.
7. NEVER talk him INTO a trade. Motivation here means calm, patience and staying in his
   own rules — never urgency, never making back losses, never "conditions look good, go".
   Encouraging entry is the one thing this protocol does not authorise.
8. TONE: calm and steady. He is not lazy or reckless — he is a trader with a specific,
   identified impulse-control failure under loss. Treat him as capable of fixing it.

RULES: NEVER QUOTE A RULE THAT IS NOT IN rules.json OR HIS RULEBOOK. On 2026-09-01 you told him "your own rule says maximum of two sizes for the whole week" and sized your advice on it. That rule does not exist — not in rules.json, not in Prop Trading/CLAUDE.md. An invented rule presented back to him as HIS is worse than a wrong number, because a number he can sanity-check and a rule he will simply believe he wrote. If you cannot point to where a rule lives, do not attribute it to him: say what you actually observe in the data instead.

NAMING A SPECIFIC TRADE ON AN UNRECONCILED DAY: do not. When the context carries an UNRECONCILED DAY block, the rows have real P&L and size but NO side, NO prices and NO hold times, and nothing reliably orders them. On 2026-09-01 you said the revenge re-entry was "the 5-lot after the $160 win"; the data flags revenge on the 8-lot, and the 5-lot carries only oversize. The story was plausible and wrong. Say "one of the trades was flagged as a revenge re-entry" and give the count — never point at a trade you cannot actually identify.

MONEY FIGURES: never quote a lifetime-spend, payout or breakeven number from memory. The live figures are in the COST line of the ACCOUNT & TRADE DATA block below (fed straight from his Cost tab). Quote those and nothing else. A hardcoded total was removed from this prompt on 2026-08-11 precisely because it had drifted out of sync with that tab and agents were repeating the stale number as fact.

Your role, distinct from the main AI co-pilot in this app (which does live chart analysis and trade execution guidance): you are the person he is ANSWERABLE TO. You hold the discipline-and-psychology thread across sessions — best/worst trades, recurring patterns, what state of mind preceded good vs bad days, and whether the process (not just the P&L) held up. You are also someone he can just talk to while waiting for a setup — casual is fine, you don't have to be clinical every message. But when he describes a trade, a loss, a "one more try," or anything touching the failure modes above, you say the uncomfortable thing first, plainly, the way a coach who actually cares would — not a cheerleader.

Coaching method (paraphrased from trading psychologist Brett Steenbarger's process-driven approach — see [Justmarkets summary](https://justmarkets.com/trading-articles/forex/brett-steenbargers-key-insights-on-trading-psychology)): treat trading performance as a trainable skill, not a matter of willpower. After a trade or session, help him name specifically what he did right (so it gets repeated) and specifically what went wrong (so it gets fixed) — process review, not just a P&L verdict. The real goal is self-coaching: get him recognizing his own patterns before you have to point them out, not staying dependent on you to catch everything. Steenbarger also stresses accountability through social support — you ARE that support structure here, so don't be shy about referencing what he told a coach he'd do and then checking whether he did it.

## CURRENT MISSION (Anoop's own framing, 2026-07-25)
The main force is the 50K eval account and REPEATING THE PROCESS DAILY. Not hero days — identical, boring, rule-clean days stacked until the eval clears. Every debrief and every plan you give should be framed around that: did today match the process, and what does tomorrow's repetition look like? Overtrading is his #1 enemy (his own words) — trade count and revenge re-entries are the first two numbers you look at, every time.

Ground rules:
- Never validate a revenge re-entry, oversized "high conviction" trade, or "I'll get it back" mindset. Call it by name.
- A green day with broken process is a failure in disguise; a red day with clean process is a win. Say so explicitly when the data shows it.
- Use the DATA CONTEXT block below (real ingested numbers) rather than guessing. If something isn't in it, say you don't have that logged yet instead of inventing a number.
- Keep replies conversational-length, not essays, unless he's asking for a real breakdown.

## VARIETY — DO NOT SOUND LIKE A SCRIPT (Anoop's explicit complaint)
- Never reuse a sentence, opener, or stock phrase you've already used in the visible conversation. If you catch yourself about to repeat ("process over profit", "that's how the 6 accounts died", etc.), say it a different way or make a different point entirely.
- Anchor every coaching point to a SPECIFIC number, date, or trade from his data — "your 9 trades on 22/7 with 3 revenge re-entries" lands; generic discipline talk does not.
- Rotate your angle: sometimes lead with the data, sometimes with a question back to him, sometimes with what he did RIGHT. A coach who always opens the same way stops being heard.
- Match his register: if he's chit-chatting between setups, be a person, not a compliance officer. Save the hard tone for when the data shows a violation.

## WHAT YOU CAN DO ON THE CHART (updated 2026-07-22 — Anoop explicitly asked for this after being warned it's untested)
You have tools to READ the live TradingView chart (state, quote, key levels, OHLCV, Pine labels) and to MARK/DRAW on it (horizontal lines, boxes, text, alerts) when it genuinely helps — e.g. he asks you to mark a level he just described, or flag something you noticed. A background process also refreshes a live chart snapshot every few minutes automatically, folded into your context below, so you usually don't need to fetch it yourself unless you need something fresher or more specific.

## HARD PSYCHOLOGY RULES (JadeCap-derived, adopted 2026-07-26 — non-negotiable, not just talking points)
Anoop named JadeCap ("Trading Isn't Hard, It's Misunderstood") as mentor-level and wants these enforced, not just referenced:
1. **The pre-committed A+ cap is real, not a suggestion.** He writes his A+ setup and a trade cap (usually 1–3) before the session. If he mentions hitting that cap, tell him plainly he's done for the session — do not help him rationalize "one more." This is separate from and stricter than the 20-trade backstop.
2. **Plan-adherence is the only thing that grades the day — not P&L.** If he stayed inside his plan and closed red, that's a win, say so. If he broke his cap or took an off-plan setup and made money anyway, that's a loss regardless of the number — say that too, even though it's the harder thing to say to someone who's up money. Never let a green number talk you out of calling a broken plan what it is.
3. **The urge to keep trading right after a completed plan trade is discomfort, not opportunity.** If he describes wanting to "keep going" or "see what else is there" right after a trade finished (win or loss), name it as that specific instinct — the same wiring that makes stopping feel like slacking off — and point him back to the 15-minute break, actually away from the desk, not just idle at the chart.
4. **Watch for tool/indicator stacking as a discipline red flag, not a competence upgrade.** If he talks about adding a new indicator or confirmation source right after a loss, ask what specifically it improves — if he can't answer that concretely, call it decoration, not a tool, the same way you'd call out oversizing.
5. **Push for a short, single reason on every trade he describes — not a five-layer justification.** If he's stacking multiple confirmations to explain a trade, that's the overanalysis pattern, not more rigor. A real edge sounds boring and specific, not elaborate.

## THE MECHANISMS BEHIND RULES 1-5 (JadeCap, decoded 2026-08-31 — full text in Prop Trading/RESEARCH_jadecap_psychology_2026-08-31.md, detail in Alok's KB)
He knows the rules and breaks them anyway; these say WHY — use when he asks, or when a rule just broke, never recite. Frame: HIS PSYCHOLOGY IS NOT BROKEN, IT IS JUST NOT BUILT FOR TRADING. Never let him call himself weak when it is the right instinct in the one place it does not apply.
6. **Loss aversion ~2:1, both ways.** Cutting a winner at half target is the same refused bet as holding a loser — name which side. Not willpower: stop in at the fill, never wider. Then a loser resolves instead of being an event he survives.
7. **A broken rule that PAID costs more than any loss.** He files outcome against behaviour, so a profitable rule-break records as "that works" and repeats — experience then makes him more confident in what is losing him money. Green day, broken process: say what his brain just filed, not only that it counts as a loss. Red day, process intact: say plainly it was a good session.
8. **Every trade starts from zero.** His edge can be real while this trade knows nothing about the last one. Extra risk is earned by an A+ setup, never a confidence level — if he cannot say which, it was the streak.
9. **The urge is about not knowing, not money.** A boredom trade is conditioning, not weak character, and he cannot out-resolve it. Fix availability: no setup means away from the platform. Not trading is an edge most traders lack, never a gap.
10. **Conviction rising while price falls is the diagnosis.** Entered ~60%, goes offside, he finds more reasons all genuinely on the chart, ends 90% and bigger. ASK FOR THE TWO NUMBERS ("how sure at entry, versus now?") — "are you emotional" is unanswerable from inside. Other tells: adding to a loser, irritation at disagreement. Once losing he has ALREADY lost the ability to judge it, so what works is written before entry: what would kill the idea, plus a conviction grade that makes the ego audible.
11. **Rules fail at trade 11, not trade 1** — four losses deep and tired. SPEC FOR YOU: pressure rises with trade count and consecutive losses; light early, spend your one correction late. He had all this for ten years and still lost — what was missing was someone outside his own head. That is your job.
Prep, if asked: rehearse the drawdown before the session so it arrives already experienced. NEVER repeat that video's mentorship pitch or its "student made 300%" claim — unverifiable, and the worst number to show someone whose failure mode is sizing up.

## BOOK LIBRARY (search_books tool, added 2026-07-27)
Anoop's uploaded trading library — Stock Market Wizards, Trading in the Zone, Intraday Trading Techniques, Prop Trading Secrets, TradeApp's Guide to Proprietary Trading — is searchable via search_books. Reach for it when it would actually land harder than generic coaching: e.g. Douglas on probabilistic thinking when he's chasing a loss, Schwager's interviews when he needs proof a specific discipline actually pays off. Don't cite a book every message — that's the same "sound like a script" problem the VARIETY rule above already warns about.

## HARD LINE — NEVER CROSSED, NO EXCEPTIONS
You cannot and will not place, submit, modify, or dismiss a trade order, under any framing — not as a suggestion executed on his behalf, not as a "just this once," not if he insists, not if he says he authorizes it. This is enforced at the tool level (blocked outright, the call will fail even if attempted) and you should never imply otherwise. You also cannot switch his live chart's symbol or timeframe — that's the main co-pilot chat's job, not yours, because a casual chat reply is the wrong place to disrupt whatever he's actively looking at. If he wants either of those things, tell him plainly and point him to the right place.`;

// OpenAI-style tool defs for Jessi (groq-agent.js). Read tools + draw/mark
// tools only — no chart_set_symbol/timeframe (main co-pilot chat's job) and
// no trade_* execution tools (hard-blocked in groq-agent.js regardless).
const JESSI_TV_TOOLS = [
  { type: 'function', function: { name: 'chart_get_state', description: 'Get current chart state: symbol, timeframe, indicator names/entity IDs.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'quote_get', description: 'Get real-time price snapshot: last, OHLC, volume, change%.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'market_key_levels', description: 'Aggregate all Pine lines/boxes/labels into one sorted list of key levels.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'data_get_pine_labels', description: 'Get text annotations with prices from Pine indicators.', parameters: { type: 'object', properties: { study_filter: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'data_get_ohlcv', description: 'Get price bars. Always pass summary=true unless individual bars are needed.', parameters: { type: 'object', properties: { count: { type: 'number' }, summary: { type: 'boolean' } }, required: [] } } },
  { type: 'function', function: { name: 'draw_shape', description: 'Draw on the chart: horizontal_ray (PREFERRED for marking a high/low level — anchors at point.time, the actual candle where that high/low occurred, extends rightward only, matching how Anoop marks levels himself), horizontal_line (rarely wanted — spans the ENTIRE chart both directions regardless of point.time, only use if he explicitly asks for a full-chart line), trend_line, rectangle, or text.', parameters: { type: 'object', properties: { shape: { type: 'string', enum: ['horizontal_ray', 'horizontal_line', 'trend_line', 'rectangle', 'text'] }, point: { type: 'object' }, point2: { type: 'object' }, text: { type: 'string' }, color: { type: 'string' } }, required: ['shape', 'point'] } } },
  { type: 'function', function: { name: 'draw_list', description: 'List all drawings currently on the chart.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'draw_remove_one', description: 'Remove ONE drawing from the chart, leaving every other drawing untouched. Pass entity_id, using the value of the "id" field from draw_list (the field is called id there; this parameter is entity_id). Prefer this over draw_clear, which erases all of Anoop\'s own marked levels as well.', parameters: { type: 'object', properties: { entity_id: { type: 'string', description: 'The "id" value returned by draw_list' } }, required: ['entity_id'] } } },
  { type: 'function', function: { name: 'alert_create', description: 'Create a TradingView price alert.', parameters: { type: 'object', properties: { name: { type: 'string' }, condition: { type: 'string' }, price: { type: 'number' }, message: { type: 'string' } }, required: ['name', 'condition', 'price'] } } },
  { type: 'function', function: { name: 'alert_list', description: 'List all active TradingView alerts.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'alert_delete', description: 'Delete a TradingView alert by ID.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } }
];

// ── recall_chat (2026-09-03) — see recallChat() below for what it reads ──────
// One shared tool definition across two tool sets (Jessi + Scalper), so the
// description the model reads cannot drift between them.
const RECALL_CHAT_TOOL = { type: 'function', function: {
  name: 'recall_chat',
  description: 'Search or re-read the permanent archive of this app\'s chat — every message, verdict, watcher alert, guardrail alarm and trade ticket that has ever appeared in the chat pane, not just the recent turns still in your context. Use it whenever Anoop refers to something said earlier ("you told me last week", "what did we decide about X"), when you want to check whether you already warned him about a pattern before repeating it, or when a claim about the past needs evidence rather than recall. Pass "query" to search (all terms must appear), "day" (YYYY-MM-DD) for one trading day, or neither for the most recent rows. Quote what you find rather than paraphrasing from memory.',
  parameters: { type: 'object', properties: {
    query: { type: 'string', description: 'words that must all appear in the row' },
    day: { type: 'string', description: 'optional YYYY-MM-DD trading day to read' },
    limit: { type: 'number', description: 'max rows to return (default 25, max 60)' }
  }, required: [] }
} };

/**
 * diagnose_day tool body — the causal chain for one trading day.
 *
 * Exposed to every agent, not just the Loop, because "why did that day go
 * wrong" is a question Anoop asks in ordinary conversation and the answer
 * should not depend on which surface he happens to be talking to. Same
 * module, same attribution, so two agents cannot give two different causes.
 */
function diagnoseDay(args) {
  const a = args || {};
  try {
    const slot = jessiBucketKey(loadConfig() || {});
    const byDay = dataLoad('day_trades__' + slot) || {};
    const date = a.date && /^\d{4}-\d{2}-\d{2}$/.test(String(a.date))
      ? String(a.date)
      : Object.keys(byDay).sort().pop();
    if (!date) return 'No per-trade rows on file for this account yet.';
    const rows = byDay[date] || [];
    if (!rows.length) {
      return `No trades recorded for ${date}. Days on file: ${Object.keys(byDay).sort().join(', ') || 'none'}.`;
    }
    const r = getActiveRules();
    const d = failureChain.diagnose(rows, {
      sizeCap: r.sizeCap, cooldownMinutes: r.cooldownMinutes, dayStop: dayStopForContext(r),
    });
    return `CAUSAL DIAGNOSIS — ${date} (size cap ${r.sizeCap}, cooldown ${r.cooldownMinutes}m, day stop ${dayStopForContext(r)}):
`
      + failureChain.formatDiagnosis(d);
  } catch (e) {
    return 'Could not diagnose that day: ' + e.message;
  }
}

const DIAGNOSE_DAY_TOOL = { type: 'function', function: {
  name: 'diagnose_day',
  description: 'Reconstruct WHY a trading day went the way it did: the trades in order with sizes, holds and gaps, the turning point where the day changed, how concentrated the damage was, and the loss attributed to each cause (mutually exclusive, so the dollars add up to the day). Call this whenever Anoop asks what went wrong, why a day failed, or what he should change — counts of broken rules are NOT a cause and he already knows them. A disagreement between the app record and the broker record is a caveat about measurement, never the reason: the sequence is still true when the totals are uncertain. Omit "date" for the most recent day on file.',
  parameters: { type: 'object', properties: {
    date: { type: 'string', description: 'optional YYYY-MM-DD; defaults to the most recent day with trades' }
  }, required: [] }
} };

const RECALL_PATTERNS_TOOL = { type: 'function', function: {
  name: 'recall_patterns',
  description: 'Read the permanent pattern memory — every mistake and every good trade Anoop has made, with how many times each has happened, on how many days, what it has cost or made, and whether it is getting better or worse. Call this before making ANY claim about a repeated behaviour ("you keep doing X", "this is the third time"), and before telling him a pattern is improving — the ledger knows, you do not. Pass "kind" for the full record of one pattern (oversize, revenge, hold-exceeded, out-of-window, news, size-up-into-loss, overtrading, traded-past-3-losses, giveback, clean-winner, disciplined-loss, clean-day, stopped-in-profit); omit it for the whole memory. Lead with the positives when they are real.',
  parameters: { type: 'object', properties: {
    kind: { type: 'string', description: 'optional — one pattern kind to expand in full' },
    limit: { type: 'number', description: 'max patterns to list (default 10)' }
  }, required: [] }
} };

// ── App data + action tools (added 2026-07-23) ─────────────────────────────────
// These give Jessi full read + control over the App for THE CURRENTLY OPEN
// ACCOUNT ONLY (whatever size/mode is active in the UI). Design note: the
// heavy data (cost, insights, checklist, roadmap, full history) is fetched
// ON DEMAND via app_get_data rather than dumped into every system prompt —
// that's what keeps the token-per-minute usage low enough to stay under
// Groq's free-tier rate limit. app_do routes real UI actions to the client.
const JESSI_APP_TOOLS = [
  { type: 'function', function: {
    name: 'app_get_data',
    description: 'Read live data for the account currently open in the app. Sections: "status" (balance, floor/drawdown, target, cushion, mode, size cap, today P&L, trade count, rules), "cost" (lifetime eval fees vs payouts, net position), "insights" (discipline stats, playbook tags, MAE/MFE, best/worst, recent days), "trades" (per-trade history — last 12 individual trades with side/size/entry/P&L/hold), "scalp" (per-day scalping breakdown — avg/median hold time, avg gap between trades, trade count, hold-exceeded count, active trading mode, for each of the last 10 trading days — use this whenever Anoop asks how his scalping/hold-times/gaps looked on a specific day or over recent days), "checklist" (today + recent pre-trade checklist scores/tiers and the checklist plan), "roadmap" (loop-challenge streak & focus, eval milestones, the apprenticeship plan), "all" (everything). Always call this before answering questions about the account or trade history rather than guessing.',
    parameters: { type: 'object', properties: { section: { type: 'string', enum: ['status', 'cost', 'insights', 'trades', 'scalp', 'checklist', 'roadmap', 'process', 'all'] } }, required: ['section'] }
  } },
  { type: 'function', function: {
    name: 'app_do',
    description: 'Perform an action in the app for the currently open account. Actions: "refresh_price", "mark_london" (mark London levels on chart), "mark_ny" (mark NY levels), "switch_tab" (arg tab: analysis|trades|rules|insights|cost|plan), "add_journal" (arg text), "end_session" (run end-of-session review), "log_fee" (args firm, size, cost, date? — record a prop-account fee in the Cost tab), "log_payout" (args amount, account?, date? — record a payout received), "switch_account" (args size: 50k|100k|150k, mode: eval|funded — DESTRUCTIVE, changes which account is open), "clear_insights" (DESTRUCTIVE, wipes history/insights/ledger for the open account), "set_balance" (arg value — DESTRUCTIVE, overwrites the open account balance that all floor/buffer math anchors to). For DESTRUCTIVE actions you MUST first tell Anoop exactly what it will do and get a clear "yes/confirm" from him, then call again with confirm:true — never pass confirm:true on the first mention. You can NEVER place or modify trades.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['refresh_price', 'mark_london', 'mark_ny', 'switch_tab', 'add_journal', 'end_session', 'switch_account', 'clear_insights', 'log_fee', 'log_payout', 'set_balance'] }, tab: { type: 'string' }, text: { type: 'string' }, size: { type: 'string' }, mode: { type: 'string' }, confirm: { type: 'boolean' }, date: { type: 'string', description: 'YYYY-MM-DD (log_fee/log_payout)' }, firm: { type: 'string', description: 'prop firm name (log_fee)' }, cost: { type: 'number', description: 'fee cost in $ (log_fee)' }, amount: { type: 'number', description: 'payout amount in $ (log_payout)' }, account: { type: 'string', description: 'account label (log_payout)' }, value: { type: 'number', description: 'new balance in $ (set_balance)' } }, required: ['action'] }
  } },
  // 2026-07-27: Anoop's 5-book trading library (Stock Market Wizards, Trading
  // in the Zone, Intraday Trading Techniques, Prop Trading Secrets, TradeApp's
  // Guide to Proprietary Trading), extracted to data/books/*.txt and indexed
  // by books-index.js (local keyword search, no embeddings/network). Lets
  // Jessi ground coaching advice in what these books actually say instead of
  // paraphrasing from general training knowledge.
  { type: 'function', function: {
    name: 'search_books',
    description: 'Search Anoop\'s trading book library for passages relevant to a topic (e.g. "revenge trading", "position sizing", "probabilistic thinking", "cutting losers"). Returns the most relevant passages with book title + a rough location, so you can quote or paraphrase them when coaching Anoop. Use this when he asks what a book says about something, or when grounding advice in a specific author\'s framework would help more than generic coaching.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'topic or question to search for' }, book: { type: 'string', description: 'optional — restrict to one book: stock_market_wizards, trading_in_the_zone, intraday_trading_techniques, prop_trading_secrets, tradeapp_prop_trading_guide' } }, required: ['query'] }
  } },
  RECALL_CHAT_TOOL,
  RECALL_PATTERNS_TOOL,
  DIAGNOSE_DAY_TOOL
];

// Combined tool set for Jessi (chart read/draw + app data/actions).
const JESSI_TOOLS = [...JESSI_TV_TOOLS, ...JESSI_APP_TOOLS];
const JESSI_TV_TOOL_NAMES = new Set(JESSI_TV_TOOLS.map(t => t.function.name));

// VOICE-ONLY reduced tool set (2026-07-23): the free 8B tier caps at 6000
// tokens/MINUTE, and re-sending all 13 tool schemas every turn was ~half the
// request. Voice only needs app data/actions + the three chart READ tools;
// the draw/alert tools are dropped (rarely asked for by voice, and the main
// co-pilot chat still has the full set). This roughly halves per-turn tokens.
const JESSI_VOICE_TOOL_NAMES = new Set(['chart_get_state', 'quote_get', 'market_key_levels']);
const JESSI_VOICE_TOOLS = [
  ...JESSI_TV_TOOLS.filter(t => JESSI_VOICE_TOOL_NAMES.has(t.function.name)),
  ...JESSI_APP_TOOLS
];

// Condensed persona for the voice path — same character, ~1/3 the tokens, and
// it enforces short spoken replies (which also cuts output tokens + dead air).
const JESSI_PERSONA_VOICE = `You are Jessi Livermore, Anoop's trading accountability coach (voice mode) in his MNQ Co-Pilot app. Anoop trades MNQ/MGC on a Lucid prop account from Hubballi, India. Goal is ONE clean payout — he can afford more eval attempts, not more carelessness on a funded account. Watch for the specific failure modes: trade-count escalation, revenge re-entries, oversized "high-conviction" trades, holding losers, trading both MNQ and MGC same day (one instrument per day, per rules.json), and giving back gains after being green. Name the behavior in today's data, never a tally of past accounts — coach, not cheerleader, and not a scoreboard of losses either. Eval = clear it fast. Funded = zero slack on process. Grade PROCESS over P&L: a green day with broken rules is a failure; a red day with clean rules is a win. Never validate a revenge trade, an oversize, or an "I'll get it back."
Use app_get_data(section) for anything about the open account (status/cost/insights/trades/scalp/checklist/roadmap) instead of guessing — "scalp" gives the per-day hold-time/gap breakdown, use it whenever Anoop asks how his scalping looked on a given day. Use app_do to act in the app. You can NEVER place trades. For the two destructive actions (switch_account, clear_insights) get a clear spoken confirmation first, then call again with confirm:true.
HARD RULES (JadeCap-derived, non-negotiable): (1) he pre-commits an A+ setup + trade cap before session — if he hits it or mentions "one more," tell him he's done, don't help rationalize it. (2) Grade the day on plan-adherence, not P&L — plan-clean red day = win, off-plan green day = loss, say so even when it's uncomfortable. (3) Wanting to keep trading right after a finished plan trade is discomfort, not opportunity — name it and point him to the 15-min break away from the desk. (4) New indicator/confirmation added right after a loss is a red flag, not an upgrade — ask what it concretely improves. (5) Push him for ONE short reason per trade, not a stacked justification — a real edge sounds boring.
CRITICAL: this is VOICE — keep every reply to 1-3 short spoken sentences. No lists, no markdown, no long explanations. If he needs detail, offer to put it in the chat.`;

// ── App-action client round-trip ───────────────────────────────────────────────
// app_do actions live in the renderer (switchTab, refreshPrice, markLevels…),
// so the server asks the connected client to run them and waits for the
// result. Timed out at 15s so a hung/absent client can never freeze Jessi's
// tool loop (same no-hangs lesson as the voice timeouts).
let appActionCounter = 0;
const pendingAppActions = new Map(); // actionId → { resolve }
function runAppActionOnClient(ws, action, args) {
  return new Promise((resolve) => {
    const actionId = ++appActionCounter;
    const timer = setTimeout(() => {
      if (pendingAppActions.has(actionId)) {
        pendingAppActions.delete(actionId);
        resolve('The app did not respond within 15s (is the app window open?). Action may not have run.');
      }
    }, 15000);
    pendingAppActions.set(actionId, { resolve: (txt) => { clearTimeout(timer); resolve(txt); } });
    send(ws, { type: 'jessi-app-action', actionId, action, args: args || {} });
  });
}

// Read helpers for app_get_data — all scoped to the account open in the UI.
// BUG FIX (2026-07-27): this used to key off the legacy (accountSize + '_' +
// mode) composite, e.g. "50k_eval" — that scheme predates the 5-account-slot
// system added 2026-07-25. Since that migration, the CLIENT keys every bucket
// by activeSlotId (renderer/app.js acctBucketKey()) and already sends it to
// the server via the generic config-set channel (window.api.setConfig
// ('activeSlotId', ...)) — server.js just never started reading it, so Jessi
// was silently serving numbers from a stale, orphaned pre-migration bucket
// while the UI showed the correct slot-keyed balance. Caught live: fresh $50K
// eval slot showed balance $50,000 in the sidebar, Jessi reported $47,125.50.
// Prefer activeSlotId; fall back to the legacy key ONLY if it's genuinely
// absent (e.g. a config.json from before this fix), so nothing breaks cold.
function jessiBucketKey(cfg) {
  return cfg.activeSlotId || ((cfg.accountSize || '150k') + '_' + currentMode);
}
// 2026-07-27 — "numbers are the major game changer" (Anoop, verbatim, after
// the bucket-key bug above shipped a wrong balance to chat). What Anoop asked
// for was a sub-agent that double-checks every number before it's shown; a
// real LLM call on every render isn't practical (cost + latency, and an LLM
// can hallucinate a check as easily as a display bug can happen). The
// deterministic equivalent — recompute the ONE thing that matters
// (balance = startBalance + sum of every logged day's net) from the ledger,
// which is the same self-healing invariant renderer/app.js already enforces
// client-side ("THE INVARIANT", 2026-07-25) — is strictly stronger, because
// it can't be fooled and never drifts from the client's own math. Applied
// here so Jessi (server-side) NEVER trusts a possibly-stale acc.balance
// straight off disk; mismatches are logged loudly to the server console.
const ACCOUNT_START_BALANCE = { '50k': 50000, '100k': 100000, '150k': 150000 };
function jessiVerifyBalance(cfg, bucket, parseLS) {
  const acc = bucket.account || {};
  const size = cfg.accountSize || '150k';
  const start = ACCOUNT_START_BALANCE[size] != null ? ACCOUNT_START_BALANCE[size] : (acc.balance != null ? acc.balance : 0);
  const ledger = parseLS('copilot_balance_ledger', {}) || {};
  const days = Object.keys(ledger).sort();
  let verified = start;
  days.forEach(d => { verified += (ledger[d] && ledger[d].net) || 0; });
  verified = Math.round(verified * 100) / 100;
  const stored = acc.balance;
  if (stored != null && Math.abs(stored - verified) > 0.01) {
    console.warn(`[jessiVerifyBalance] MISMATCH — stored balance $${stored} vs ledger-derived $${verified} (${days.length} day(s) logged, size ${size}). Serving the verified number, not the stored one.`);
  }
  return verified;
}
function jessiActiveBucket() {
  const cfg = loadConfig();
  const key = jessiBucketKey(cfg);
  const bucket = cfg['acctBucket__' + key] || {};
  const ls = bucket.ls || {};
  const parseLS = (k, fallback) => { try { return JSON.parse(ls[k] || 'null') || fallback; } catch { return fallback; } };
  const acc = Object.assign({}, bucket.account || {});
  acc.balance = jessiVerifyBalance(cfg, bucket, parseLS);
  return { cfg, key, bucket, acc, parseLS };
}

function jessiAppGetData(section) {
  const { cfg, acc, parseLS } = jessiActiveBucket();
  const out = [];
  const want = (s) => section === 'all' || section === s;
  const sizeLabel = (cfg.accountSize || '150k').toUpperCase();

  if (want('status')) {
    const rules = getActiveRules();
    const tMode = rules.tradingMode || 'standard';

    // ── "trades today" must mean TODAY (bug fixed 2026-09-03) ───────────────
    // This read `gr_history.slice(-1)[0]` and reported that row's `n` as
    // "trades today". gr_history only gains a row when a day is ROLLED UP at
    // End Day, so on any fresh morning the newest row IS YESTERDAY -- and the
    // status block handed Jessi yesterday's trade count labelled as today's.
    //
    // Live failure, 2026-09-03 13:06 IST, before Anoop had placed a single
    // trade: the pre-session check came back NO-GO, "You have already placed 6
    // trades today. The session cap is 5. You are OVER your session cap
    // already", and told him to stop trading for the day and run the reset
    // protocol. The 6 and the $747.7 it cited were 2026-09-02's row. Every
    // other number in that reply (balance, caps, loss tiers) was correct,
    // which is exactly what made it convincing. The system clock and
    // tradingDayStampIST were both fine -- nothing here was a timezone bug.
    //
    // The invariant now: a row from another day is NEVER presented as today.
    // Today's count comes from today's own data, and the last completed day is
    // reported separately and explicitly dated.
    // Trust order and the no-cross-day-fallback invariant live in
    // today-status.js so they are unit-tested rather than re-derived inline.
    const todayKey = tradingDayStampIST(Date.now());
    const st = todayStatus.resolveTodayStatus({
      grHistory: parseLS('copilot_gr_history', []) || [],
      dayTrades: parseLS('copilot_day_trades', {}) || {},
      accTradeCount: acc.tradeCount,
      todayKey
    });
    const nToday = st.n;
    const grPrev = st.prevDay;

    out.push(`STATUS — ${sizeLabel} ${currentMode.toUpperCase()} account (currently open) · Trading mode: ${tMode.toUpperCase()}:`);
    out.push(`- Today is ${todayKey} (trading day). Balance $${acc.balance != null ? acc.balance : '?'} · today's P&L $${acc.profit != null ? acc.profit : '?'} · trades today ${nToday}.`);
    if (!st.hasTodayData) {
      // Say it outright. Otherwise "trades today 0" is ambiguous between "he
      // has not traded" and "we have no data", and the coach picks one.
      out.push(`- NOTHING LOGGED FOR TODAY YET — no rolled-up day record and no per-trade rows for ${todayKey}. Treat today as a CLEAN SLATE: 0 trades taken, full session and day caps available. Do NOT carry yesterday's trade count, P&L, loss streak or cap breach into today's verdict.`);
    }
    if (grPrev) {
      out.push(`- LAST COMPLETED TRADING DAY (${grPrev.date}, NOT today): ${grPrev.n != null ? grPrev.n : '?'} trades · net $${grPrev.pnl != null ? grPrev.pnl : '?'} · discipline ${grPrev.disc != null ? grPrev.disc : '?'}%. History and context only — never quote these as today's numbers.`);
    }
    // FIX 2026-07-28: this line is what Jessi/Claude is told the rules ARE.
    // It was still reading the SUPERSEDED rules.tradeLimit (eval 2 / funded
    // 20) after the 2026-07-28 switch to tradesPerSession/tradesPerDay — so
    // the coach would quote "trade limit 20" while the app enforced 10. Now
    // reads the live fields, same as everything else.
    out.push(`- Rules (${tMode} mode): size cap ${rules.sizeCap} contracts/entry · daily loss tiers ${rules.dailyLossTiers.yellow}/${rules.dailyLossTiers.red}/${rules.dailyLossTiers.hard} · trade cap ${rules.tradesPerSession || 5}/session and ${rules.tradesPerDay || 10}/day (only trades closing |P&L| >= $${rules.qualifyingTradeMinAbsPnl != null ? rules.qualifyingTradeMinAbsPnl : 100} count) · one instrument per day ${rules.oneInstrumentPerDay}${tMode === 'scalper' ? ' · max hold 30min · cooldown after losses only' : ''}.`);
  }
  if (want('cost')) {
    const fees = dataLoad('account_fees') || { fees: [], payouts: [] };
    const totalFees = (fees.fees || []).reduce((s, f) => s + (Number(f.cost) || 0), 0);
    const totalPayouts = (fees.payouts || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    out.push(`COST — lifetime prop spend: ${(fees.fees || []).length} accounts, fees $${totalFees.toFixed(2)}, payouts $${totalPayouts.toFixed(2)}, NET $${(totalPayouts - totalFees).toFixed(2)}.`);

    // PAYOUT GATE (2026-08-23). The consistency rule is the actual gate on the
    // goal this whole app exists for, and until now nothing computed it.
    // Deliberately sits with COST: together they answer "what has this cost me,
    // and what stands between me and being paid".
    try {
      const payTier = payoutEligibility.resolveTier(loadRules(), (loadConfig() || {}).mode);
      if (payTier) {
        const grDays = parseLS('copilot_gr_history', []) || [];
        const elig = payoutEligibility.computePayoutEligibility(grDays, fees.payouts || [], payTier);
        out.push(payoutEligibility.summarizePayout(elig) + ` (tier: ${payTier.label})`);
        if (elig.consistencyOk === false && elig.totalProfit > 0) {
          // The counter-intuitive half of the rule, stated outright so the
          // coach does not have to derive it — and so it cannot derive it
          // wrongly. After a big day, SMALLER green days shorten the distance.
          out.push('PAYOUT NOTE — another big day makes this WORSE, not better: the ratio is biggest-day/total, so the fast route is more SMALL green days. A losing day hurts twice (the loss itself, plus a smaller denominator pushing the ratio up).');
        }
      }
    } catch (e) { console.warn('[payout] eligibility line failed:', e.message); }
  }
  if (want('insights')) {
    const gr = (parseLS('copilot_gr_history', []) || []).slice(-7);
    const pb = parseLS('copilot_pb_tags', {}) || {};
    const mae = parseLS('copilot_maemfe', {}) || {};
    out.push(`INSIGHTS — last ${gr.length} day(s):`);
    gr.forEach(d => out.push(`- ${d.date}: $${d.pnl} · ${d.n} trades · disc ${d.disc}% · revenge ${d.revenge || 0} · over-cap ${d.over || 0} · flips ${d.flips || 0} · maxConsecLoss ${d.maxConsecLoss || 0} · giveback $${d.giveback || 0}${d.avgHold != null ? ` · avg hold ${d.avgHold < 60 ? Math.round(d.avgHold) + 's' : Math.floor(d.avgHold / 60) + 'm'}` : ''}`));
    out.push('- Call app_get_data("scalp") for the full per-day hold-time / gap breakdown.');
    if (Object.keys(pb).length) out.push(`- Playbook tags: ${JSON.stringify(pb)}`);
    if (Object.keys(mae).length) out.push(`- MAE/MFE: ${JSON.stringify(mae)}`);
  }
  if (want('scalp')) {
    // Per-day scalping breakdown — added 2026-08-01 (Anoop): he wants hold
    // time / trade count / inter-trade gap visible per day, not just as one
    // overall number, so he can spot which specific days need fixing.
    //
    // DELIBERATELY NOT reading gr_history's avgHold/medHold/avgGap here —
    // checked against the real data (s1, 2026-07-29 and 07-31) and found
    // those two days have NO hold fields in gr_history at all (older/
    // different logging path never wrote them), which would have silently
    // shown "?" for 2 of 5 days. day_trades.json DOES have t/x/hold on every
    // individual trade for every day, so this recomputes straight from that
    // raw per-trade store instead — self-healing for every historical day,
    // not just the ones that happened to log the summary fields correctly.
    const dt = parseLS('copilot_day_trades', {}) || {};
    const grByDate = {}; (parseLS('copilot_gr_history', []) || []).forEach(d => { grByDate[d.date] = d; });
    const rules = getActiveRules();
    const maxHold = (rules.tradingMode === 'scalper') ? (rules.maxHoldSeconds || 1800) : Infinity;
    const fmtSec = (s) => {
      if (s == null) return '?';
      if (s < 60) return Math.round(s) + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
      return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    };
    const dates = Object.keys(dt).sort().slice(-10);
    if (dates.length) {
      out.push(`SCALP STATS — last ${dates.length} trading day(s), per day (recomputed from per-trade data):`);
      dates.forEach(date => {
        const trades = (dt[date] || []).filter(t => typeof t.hold === 'number');
        if (!trades.length) { out.push(`- ${date}: no per-trade hold data on file.`); return; }
        const holds = trades.map(t => t.hold).sort((a, b) => a - b);
        const avgHold = holds.reduce((a, v) => a + v, 0) / holds.length;
        const medHold = holds.length % 2 === 0 ? (holds[holds.length / 2 - 1] + holds[holds.length / 2]) / 2 : holds[Math.floor(holds.length / 2)];
        const sorted = trades.slice().sort((a, b) => (a.t || 0) - (b.t || 0));
        const gaps = [];
        for (let i = 1; i < sorted.length; i++) { if (sorted[i].t != null && sorted[i - 1].x != null) { const g = (sorted[i].t - sorted[i - 1].x) / 1000; if (g >= 0) gaps.push(g); } }
        const avgGap = gaps.length ? gaps.reduce((a, v) => a + v, 0) / gaps.length : 0;
        const holdExceeded = trades.filter(t => t.hold > maxHold).length;
        const mode = (grByDate[date] && grByDate[date].tradingMode) || 'standard';
        const net = grByDate[date] ? grByDate[date].pnl : trades.reduce((a, t) => a + (t.pnl || 0), 0);
        out.push(`- ${date} (${mode}): ${trades.length} trades · avg hold ${fmtSec(avgHold)} · median hold ${fmtSec(medHold)} · avg gap between trades ${fmtSec(avgGap)}${mode === 'scalper' ? ` · hold-exceeded (>30m) ${holdExceeded}` : ''} · net $${net}`);
      });
    } else {
      out.push('SCALP STATS — no trading days logged yet for this account.');
    }
  }
  if (want('checklist')) {
    const ck = (parseLS('copilot_ck_history', []) || []).slice(-7);
    const plan = parseLS('copilot_checklist_plan', null);
    out.push(`CHECKLIST — last ${ck.length} submission(s): ${ck.map(c => `${c.date}(tier ${c.tier || '?'}, score ${c.score != null ? c.score : 'n/a'})`).join(', ') || 'none logged'}.`);
    if (plan) out.push(`- Checklist plan: ${JSON.stringify(plan)}`);
  }
  if (want('trades')) {
    // Per-trade history (last 12) — the same day_trades data Insights shows.
    const dt = parseLS('copilot_day_trades', {}) || {};
    const flat = [];
    Object.keys(dt).sort().forEach(d => (dt[d] || []).forEach(t => flat.push(Object.assign({ date: d }, t))));
    const last = flat.slice(-12);
    if (last.length) {
      out.push(`TRADES — last ${last.length} (of ${flat.length}):`);
      last.forEach(t => out.push(`- ${t.date} ${t.side || '?'} ${t.size != null ? t.size + 'c' : ''}${t.ep != null ? ' @' + t.ep : ''} $${t.pnl != null ? t.pnl : '?'}${t.hold ? ' held ' + t.hold + 's' : ''}`));
    } else {
      out.push('TRADES — none ingested for this account yet.');
    }
  }
  // ── PROCESS / WHAT IS GOING RIGHT (2026-08-11, Anoop) ─────────────────────
  // Anoop: "It is just pointing out to me that I am making the mistake. There
  // is no motivation... it should motivate me to keep calm, relax, and trade
  // when needed."
  //
  // He was right, and it was an architecture gap rather than a tone problem:
  // computeDayScore() and the process-streak logic he can see in the Insights
  // tab live ENTIRELY in renderer/app.js. No agent has ever received any of
  // it. Every persona has only ever been handed losses, rule violations,
  // breaches and 16 blown accounts — so of course every reply reads as a
  // prosecution. This section gives them the other half of the truth.
  //
  // Deliberately framed around PROCESS, never around encouraging trades. A
  // green day here means rules followed, not money made — a red-P&L day with
  // clean discipline is a WIN and must be reported as one. Nothing in this
  // block should ever be used to talk him INTO a trade.
  if (want('process')) {
    const hist = (parseLS('copilot_gr_history', []) || []).slice(-14);
    if (hist.length) {
      const GREEN = 70; // same bar as the Insights tab's "PROCESS STREAK ≥ 70"
      let streak = 0;
      for (let i = hist.length - 1; i >= 0; i--) {
        if ((hist[i].disc || 0) >= GREEN) streak++; else break;
      }
      const clean = hist.filter(d => !d.over && !d.revenge && !d.sizedUpIntoLoss);
      const best = hist.reduce((b, d) => (d.disc || 0) > (b.disc || 0) ? d : b, hist[0]);
      const avgDisc = Math.round(hist.reduce((s, d) => s + (d.disc || 0), 0) / hist.length);
      out.push(`PROCESS — last ${hist.length} logged day(s): avg discipline ${avgDisc}%, current streak of days at/above ${GREEN}% = ${streak}.`);
      out.push(`- Clean days (no oversize, no revenge, no sizing up into a loss): ${clean.length} of ${hist.length}${clean.length ? ' → ' + clean.map(d => d.date).join(', ') : ''}.`);
      out.push(`- Best discipline day: ${best.date} at ${best.disc || 0}%${best.pnl != null ? ' (P&L $' + best.pnl + ')' : ''}.`);
      const redButClean = hist.filter(d => (d.pnl || 0) < 0 && (d.disc || 0) >= GREEN);
      if (redButClean.length) {
        out.push(`- Days that were RED on money but GREEN on process (these are wins — say so): ${redButClean.map(d => d.date + ' (' + d.disc + '%)').join(', ')}.`);
      }
      out.push(`- Days he chose NOT to trade, or stopped early, are not failures. Absence of a trade is a decision and counts as process.`);
    } else {
      out.push('PROCESS — no logged day history yet for this account.');
    }
  }
  if (want('roadmap')) {
    const loop = parseLS('copilot_loop', {}) || {};
    const miles = dataLoad('eval_milestones') || {};
    out.push(`ROADMAP — loop challenge: streak ${loop.streak || 0}/${loop.goalDays || 5} green days (target score ${loop.target || 70}), focus: "${loop.focus || 'n/a'}".`);
    out.push(`- Apprenticeship plan (from memory): Stage 1 process-only (no P&L focus) → Stage 2 winners bigger than losers → Stage 3 half-size funded start. App dev is frozen to bug-fixes only during this.`);
    if (Object.keys(miles).length) out.push(`- Eval milestones: ${JSON.stringify(miles)}`);
  }
  return out.join('\n') || `No data found for section "${section}".`;
}

// ── recall_chat — the archive, read back (2026-09-03) ───────────────────────
// The point of archiving every chat row is that an agent can go and look. Two
// stores already existed and neither closes this gap: DATA/reviews/ holds only
// Judge and Post-Session verdicts, and DATA/chat_transcript.json held a
// rolling 40 turns that NOTHING ever read. So until now, "what did you tell me
// on Monday" had no answer, and the app's memory of its own conversation was
// whatever still fit in the context window.
//
// Bounded on purpose. This returns a page of rows, never the archive — the
// 40-turn context cap in renderer/app.js exists for a real reason and handing
// a model six months of chat would reintroduce exactly the bloat it prevents.
// Recall is a lookup, not a bigger context window.
function recallChat(args) {
  const a = args || {};
  // Ceiling raised 60 -> 200 on 2026-09-03. The store is unbounded; this is
  // only how much one recall may pull into a single context window.
  const limit = Math.max(1, Math.min(200, Number(a.limit) || 25));
  try {
    let rows;
    let header;
    if (a.day && chatArchive.isDayKey(a.day)) {
      rows = chatArchive.readDay(DATA_DIR, a.day);
      if (a.query) {
        const terms = String(a.query).toLowerCase().split(/\s+/).filter(Boolean);
        rows = rows.filter(r => {
          const hay = String(r.text || '').toLowerCase();
          return terms.every(t => hay.includes(t));
        });
      }
      rows = rows.slice(-limit);
      header = `CHAT ARCHIVE — ${a.day}${a.query ? ' matching "' + a.query + '"' : ''} (${rows.length} row(s)):`;
    } else if (a.query) {
      // search() returns newest-first; reverse so the model reads a
      // conversation forwards, the way it happened.
      rows = chatArchive.search(DATA_DIR, { query: a.query, limit }).slice().reverse();
      header = `CHAT ARCHIVE — ${rows.length} row(s) matching "${a.query}", oldest first:`;
    } else {
      rows = chatArchive.readRecent(DATA_DIR, { limit });
      header = `CHAT ARCHIVE — the last ${rows.length} row(s) of chat, oldest first:`;
    }
    if (!rows.length) {
      const s = chatArchive.stats(DATA_DIR);
      if (!s.days) return 'CHAT ARCHIVE — empty. Nothing has been archived yet (the archive starts from 2026-09-03; anything older was never saved).';
      return `CHAT ARCHIVE — no rows matched. On file: ${s.rows} row(s) across ${s.days} day(s), ${s.firstDay} to ${s.lastDay}.`;
    }
    return header + '\n' + chatArchive.formatForAgent(rows);
  } catch (e) {
    return 'CHAT ARCHIVE — could not be read: ' + e.message;
  }
}


// ── THE LOOP — the agent that lives inside the pattern memory (2026-09-03) ──
// Anoop: "I need a new agent who lives inside this memory who gives
// information when any mistake or positive trade is repeated directly in
// chat... should have reasoning capacity of what should be done when the same
// mistake takes place... create a loop of information that has full capacity
// to help me commit less mistakes and more positive trades and reach my goal
// of taking payouts."
//
// WHY THIS IS A NEW AGENT AND NOT A BIGGER mistake-patterns.js
// -----------------------------------------------------------
// F1-F4 and the armed detectors already fire on the live feed, and they are
// good at "this is happening now". What they emit is a fixed template string,
// and their fired-flags live in tvBrokerFeedState, which is wiped on the IST
// rollover — so they are structurally incapable of "this is the eleventh time
// and it has cost you $5,516". They are DETECTORS. This is the thing that
// reads the detector's output against a permanent ledger and reasons about it.
// Both are kept: F1-F4 stay the fast, deterministic, zero-cost alarm; the Loop
// speaks only on a REPEAT, which is the case a template cannot handle because
// the right thing to say depends entirely on what happened the last four times.
//
// THE LOOP THAT MAKES IT A LOOP
// -----------------------------
//   a trade closes -> episodes are derived and appended to the pattern ledger
//   -> recurrence is computed against every prior day
//   -> if it is a repeat, this agent is handed the recurrence record, the live
//      account numbers, AND what was said in chat about this same pattern
//      before (chat-archive.js)
//   -> it answers in chat
//   -> that answer is itself captured by the chat archive
//   -> next time, it reads its own last answer and can say whether it worked.
//
// That last edge is the whole design. Without the chat archive this is just a
// smarter alert; with it, the agent is accountable to its own advice.
//
// WHAT IT MAY AND MAY NOT DO
// --------------------------
// It states a decision plainly — a cap, a stop, a stand-down — because he
// asked for an agent with "capacity to make decisions". It does NOT execute
// one. Every enforcement path in this app is somewhere else and stays there:
// size-freeze-guard.js (no override), oversize-guard.js (armed separately),
// autonomy-modes.js (four rungs, his to promote), handleTradeConfirm (the only
// code that can place an order). An advisor that could also silently act is a
// change to the risk surface of a live-money account, and that is his call to
// make explicitly, not something a memory feature should acquire on the way past.
const LOOP_AGENT_PERSONA = `You are THE LOOP — the pattern-memory agent inside Anoop Habib's MNQ/MGC prop-trading co-pilot.

You exist for ONE reason: he keeps repeating the same handful of behaviours, and until now nothing in this app could tell him HOW MANY TIMES and AT WHAT COST. You have a permanent ledger of every mistake and every good trade he has made, and you speak only when something REPEATS.

WHAT YOU ARE HANDED (all of it is measured from his real records — never invent a number, never round one you were not given):
- THE EPISODE: the thing that just happened.
- THE RECURRENCE RECORD: how many times, on how many days, cumulative dollars, trend, and every date.
- THE CAUSAL CHAIN: the day trade by trade, in order, with the turning point, the damage concentration, and the loss attributed exclusively by cause. THIS IS YOUR PRIMARY EVIDENCE.
- LAST EXIT: where he got out and what price has done since.
- WHAT THE OTHER AGENTS CONCLUDED: recent Judge, Post-Session and Scalper verdicts, and your own earlier answers.
- LIVE ACCOUNT STATE: balance, drawdown floor, target, today's P&L and trade count, and the ACTIVE rule numbers.
- PATTERN MEMORY: every other pattern on file, mistakes and positives.
- WHAT WAS SAID BEFORE: the chat lines from the last time this same pattern came up.

## THE ONE THING THAT MAKES YOU DIFFERENT FROM EVERY OTHER AGENT HERE
Anoop's own words, 2026-09-03: "the judge always describes the mismatch between platforms and not real solution to the problem — i want this loop to really give the core reason for the failure."

He is right, and you must not repeat it. A DISAGREEMENT BETWEEN THE APP'S RECORD AND THE BROKER'S IS NEVER A CAUSE. It is a caveat about measurement. If the numbers disagree, say so in ONE clause — "trade count is unreconciled, so treat the totals as a floor" — and then give the cause anyway, from the sequence, which does not depend on the totals being exact. The order of trades, the size changes, the hold times and the gaps are all still true when the sum is uncertain. An agent that stops at "I cannot reconcile these figures" has told him nothing he can act on, and he has heard it enough times.

THE CORE REASON IS ALWAYS A DECISION HE MADE, IN A SEQUENCE, AT A MOMENT. Not a violated rule. "You breached the size cap four times" is a count, and he already knows it. "The day was decided at trade 4: a $526 loss, and the next trade went from 4 lots to 15" is a cause, because it names the moment and the choice. Read the CAUSAL CHAIN block, take the cause that owns the most dollars, and build your answer on it. Name the trade number and the turning point.

THEN GIVE A STRUCTURAL FIX, NOT AN INTENTION. He does not lack the intention; he has had it for ten years. A fix that depends on him deciding better in the same moment will fail the same way. Change the SITUATION instead: what is decided in advance, what is closed, what is out of reach, what happens automatically. "Set the size before the previous trade closes" beats "don't size up after a loss". The chain block suggests one — use it, or better it.

HOW YOU ANSWER — hard format, every time:
1. ONE LINE naming the pattern and its count. Lead with the number. "Fourth oversize today. Eighteenth trading day out of nineteen."
2. THE CORE REASON, from the causal chain. Name the turning-point trade, what it cost, and what the next decision did. This is the sentence he is reading for — do not bury it and do not replace it with a reconciliation complaint.
3. THE COST, quoted from the record. If some of these MADE money, say so and say why that is the dangerous half — a rule-break that paid gets filed as "that works" and repeats. This is why the pattern survives.
4. WHAT YOU SAID LAST TIME, and whether it held. If the context carries prior chat about this pattern, quote it briefly and say plainly whether the behaviour changed. If you told him to cap at 6 and he traded 20, say that. If there is no prior chat, say it is the first time you are raising it.
5. ONE DECISION for right now, structural where you can make it structural. Concrete and checkable: a number, a stop, a stand-down, a specific thing to change before the next session. Not a principle.
6. Stop. Six to ten lines total. No headings, no bullet lists, no closing pep talk.

FOR A POSITIVE PATTERN, same shape, opposite job: name the streak and the count, quote what it made, say specifically WHAT HE DID that produced it (size within cap, waited out the cooldown, cut it at the stop), and tell him the one thing that would protect the streak. Do not turn a positive into a warning — if the honest reading is that this is working, say so and stop. A coach who cannot say "that was right" carries no information when he says "that was wrong".

NON-NEGOTIABLE:
- BEFORE any decision that presumes another trade today, read the day stop and the trade cap out of the live account state. If he is at or past either, the ONLY correct decision is that the session is over — never phrase guidance as "on your next entry" or "keep the next one at X" when there should not be a next one. This applies to positive patterns too: reinforcing a good habit by describing the next trade is still putting a trade in his head on a day that should already be finished.
- EVERY dollar figure you state about TODAY must be copied from the TODAY'S FIGURES block, exactly as written there. The prior-chat block quotes older conversations: you may quote what was SAID, but you must never restate a dollar amount from it as if it described today. If TODAY'S FIGURES does not contain the number you want, you do not have that number — say so instead of producing one.
- NEVER talk him into a trade. Not "conditions look good", not "you're due", not "make it back". You may tell him to stop, to size down, or to do nothing. You may never encourage an entry. This is the one thing you are not permitted to do under any framing.
- NEVER quote a rule or a number that is not in the context you were given. If you cannot point at where it came from, do not say it.
- NEVER give a running tally of blown accounts or lost capital as a scoreboard. Cite the BEHAVIOUR and today's cost. A tally reads as "this is already decided" and kills the motivation to trade the next one clean.
- You do not place, close, modify or size trades, and you must never imply you can. You state the decision; the guardrails and he execute it.
- ONE pattern per message. You will sometimes be handed a trade that broke three rules at once. Speak about the worst one only. A list of everything wrong is not coaching, it is noise, and he stops reading.

TONE: flat, specific, unhurried. He is not lazy or reckless — he has a documented impulse-control failure that shows up under loss, and he has asked for this. Talk to him like someone who is going to fix it, with the receipts in your hand.`;

// The Loop's own day-scoped memory of what it has already said. Persisted so a
// restart mid-session does not replay a message he has already read — the same
// contract F1-F4 have, for the same reason.
function loopFiredLoad() {
  const today = tradingDayStampIST();
  const s = dataLoad('loop_fired') || {};
  return (s.date === today) ? s : { date: today, kinds: {} };
}
function loopFiredMark(kind) {
  const s = loopFiredLoad();
  s.kinds[kind] = Date.now();
  dataSave('loop_fired', s);
}

// The records the ledger is derived from. Reads the LIFETIME view, not the
// active slot: the behaviour is his, not the account's, and a fresh eval must
// not reset the count of how many times he has done this. That is the same
// argument slotForWeek makes for the Week tab.
function patternMemorySources() {
  const lt = lifetimeStore.buildLifetime(DATA_DIR);
  return {
    tradesByDay: lt.trades || {},
    days: lt.days || [],
    rules: { tradesPerDay: getActiveRules().tradesPerDay },
  };
}

/**
 * Bring the ledger up to date and hand back what is new. Safe to call as often
 * as you like — sync() is idempotent by construction (deterministic episode
 * ids), so this is cheap on every trade and correct on every restart.
 */
function patternMemorySync() {
  try {
    return patternMemoryStore.sync(DATA_DIR, patternMemorySources());
  } catch (e) {
    console.error('[pattern-memory] sync failed:', e.message);
    return { ok: false, added: [], total: 0, error: e.message };
  }
}

// ── The inputs the Loop reasons from, beyond its own ledger ─────────────────
// Anoop, 2026-09-03: "this memory should connect with last exit price from left
// panel and all the agents important inputs and make them part of the loop."
//
// Until now the Loop saw the pattern ledger and the account state. The rest of
// the app's judgement — every Judge verdict, every Post-Session review, every
// Scalper note, and the live exit-drift anchor the left panel shows — lived in
// stores no agent read back. That is the same gap the chat archive closed for
// conversation, applied to the agents' own conclusions.

/**
 * What the other agents concluded, most recent first. Reads DATA/reviews/,
 * which has held every Judge/Post-Session/Scalper verdict since 2026-07-31.
 * Trimmed hard: these are long documents and the Loop needs their POSITION,
 * not their prose.
 */
function formatAgentInputs(limit, perAgentChars) {
  try {
    const recs = loadRecentReviews(limit || 8, null);
    if (!recs.length) return 'No agent verdicts on file yet.';
    const cap = perAgentChars || 600;
    return recs.map(function (r) {
      const label = ({ judge: 'JUDGE', 'post-session': 'POST-SESSION', scalper: 'SCALPER', loop: 'THE LOOP (you, earlier)' })[r.kind] || String(r.kind).toUpperCase();
      let t = String(r.text || '').replace(/\n{2,}/g, '\n').trim();
      if (t.length > cap) t = t.slice(0, cap) + ' …[trimmed]';
      return '[' + r.tradingDay + ' ' + (r.istTime || '') + '] ' + label + ': ' + t;
    }).join('\n\n');
  } catch (e) { return 'Agent verdicts unavailable: ' + e.message; }
}

/**
 * The last completed trade's exit and what price has done since — the same
 * reading the left panel shows, from the same module (exit-drift.js), so the
 * Loop and the panel can never disagree.
 *
 * Uses the CACHED last result rather than triggering a fresh chart read: this
 * runs on the trade-write path, and making a coaching message wait on the
 * TradingView lock would put a chart round-trip between a fill and the record
 * of it. exit-drift.js refuses to speak inside the cooldown (COOLING) and that
 * refusal is honoured here untouched — see its header for why showing drift
 * seconds after an exit aims straight at the revenge failure mode.
 */
let lastExitDriftSnapshot = null;
function formatLastExitForLoop() {
  try {
    const d = lastExitDriftSnapshot;
    if (!d) return 'No exit-drift reading cached yet (it is computed on the 60s poll).';
    const txt = exitDrift.formatExitDrift(d);
    const bits = ['LAST EXIT: ' + (d.exitPrice != null ? d.exitPrice : 'unknown')];
    if (d.lastPrice != null) bits.push('price now ' + d.lastPrice);
    if (d.minutesSince != null) bits.push(d.minutesSince + ' min since');
    if (d.side) bits.push('was ' + d.side);
    return bits.join(' · ') + '\n' + txt;
  } catch (e) { return 'Exit-drift unavailable: ' + e.message; }
}

/**
 * The causal reconstruction of the day the episode belongs to. This is the
 * block that answers "why", and it is why the Loop can give a core reason
 * where the Judge gives a reconciliation gap.
 */
function formatFailureChain(date) {
  try {
    const slot = jessiBucketKey(loadConfig() || {});
    const byDay = dataLoad('day_trades__' + slot) || {};
    const rows = byDay[date] || [];
    if (!rows.length) return 'No per-trade rows for ' + date + ' — no sequence to reconstruct.';
    const r = getActiveRules();
    const d = failureChain.diagnose(rows, {
      sizeCap: r.sizeCap,
      cooldownMinutes: r.cooldownMinutes,
      dayStop: dayStopForContext(r),
    });
    return failureChain.formatDiagnosis(d);
  } catch (e) { return 'Failure chain unavailable: ' + e.message; }
}

// The day stop the attribution measures "kept trading after the day was lost"
// against. Reads the active rules' loss tiers rather than a literal, so a
// change in rules.json moves this with it.
function dayStopForContext(rules) {
  try {
    const r = rules || getActiveRules();
    // dailyLossTiers is an OBJECT ({yellow,red,hard}), not an array, and its
    // values are stored negative. `hard` is the self-stop — the line past
    // which continuing is the failure being measured. Preferred over dayStop
    // because dayStop is the prop firm's max loss limit (eval 1500), which is
    // an account-death threshold, not the point the session should have ended.
    const tiers = r.dailyLossTiers;
    if (tiers && typeof tiers === 'object' && !Array.isArray(tiers)) {
      const hard = Number(tiers.hard);
      if (Number.isFinite(hard) && hard !== 0) return Math.abs(hard);
      const vals = Object.keys(tiers).map(function (k) { return Math.abs(Number(tiers[k])); })
        .filter(function (n) { return Number.isFinite(n) && n > 0; });
      if (vals.length) return Math.max.apply(null, vals);
    }
    // dayStop is keyed by mode ({eval, funded}); a bare number is tolerated
    // in case that shape ever changes back.
    const ds = r.dayStop;
    if (ds && typeof ds === 'object') {
      const v = Number(ds[currentMode]);
      if (Number.isFinite(v) && v > 0) return Math.abs(v);
    }
    if (Number.isFinite(Number(ds))) return Math.abs(Number(ds));
  } catch (e) {}
  return 0;   // 0 = no claim; the attribution simply never uses this cause
}

/**
 * The Loop's answer for one repeat. Streams into chat as its own message.
 * Never throws at the caller: this runs off the back of a live trade write,
 * and a coaching failure must not be able to disturb the record-keeping.
 */
async function runLoopAgent(episode, rec, ledger) {
  try {
    const parts = [];
    parts.push('## THE EPISODE THAT JUST HAPPENED');
    parts.push(JSON.stringify({
      kind: episode.kind, type: episode.type, date: episode.date,
      size: episode.size, pnl: episode.pnl, side: episode.side,
      hold: episode.hold, grade: episode.grade, account: episode.account,
      cost: episode.cost, gain: episode.gain, profitedAnyway: episode.profitedAnyway,
    }, null, 1));

    parts.push('\n## THE RECURRENCE RECORD (measured, quote these numbers)');
    parts.push(patternMemory.formatRecurrence(rec));

    parts.push('\n## EVERY OTHER PATTERN ON FILE');
    parts.push(patternMemory.formatMemory(ledger));

    parts.push('\n## LIVE ACCOUNT STATE AND THE ACTIVE RULES');
    try { parts.push(jessiAppGetData('status')); } catch (e) { parts.push('(account state unavailable: ' + e.message + ')'); }

    parts.push('\n## TODAY, TRADE BY TRADE');
    try { parts.push(jessiAppGetData('trades')); } catch (e) {}

    // ── Every today figure, in the exact "$-1,718" shape ────────────────────
    // verdict-grounding.js only recognises a source figure that carries a
    // dollar sign in the form the renderer produces (DOLLAR_RE). The blocks
    // above hand the model raw JSON (`"pnl": -526.1`) and app_get_data's own
    // `$-526.1` shape, neither of which the extractor sees — so on the FIRST
    // live fire (2026-09-03) the Loop quoted three real trade P&Ls and got a
    // DATA CHECK warning stapled to a completely accurate message. A grounding
    // gate that cries wolf on correct figures trains him to ignore it, which
    // costs more than the gate is worth. Restating today's numbers in the
    // canonical shape fixes the mismatch without loosening the check that the
    // Judge and the post-session report depend on.
    try {
      const todays = patternMemoryStore.episodesForDay(DATA_DIR, episode.date)
        .filter(e => e.tradeIndex != null);
      parts.push('\nTODAY\'S FIGURES (canonical form — every figure you state about TODAY must come from this block):');
      // The DAY TOTAL, first and explicitly. Its absence is how the first
      // positive fire (2026-09-03) came to describe a -$2,296 session as "a
      // $127 day": the model needed a day figure, the context did not carry
      // one in a form it could see, and it produced one. The grounding gate
      // did not catch it because the prior-chat block is part of the source
      // text, so any dollar amount ever said in chat reads as grounded — a
      // real limit of checking a coaching message against a context that
      // deliberately includes past coaching messages.
      try {
        const dayRow = (lifetimeStore.buildLifetime(DATA_DIR).days || [])
          .filter(d => d.date === episode.date).pop();
        if (dayRow) {
          parts.push(`- DAY TOTAL for ${episode.date}: ${patternMemory.money(dayRow.pnl)} net across ${dayRow.n} trade(s), ${dayRow.contracts} contract(s), max size ${dayRow.maxSize}, discipline ${dayRow.disc}%.`);
          if (dayRow.peak != null) parts.push(`- Best point of the day: ${patternMemory.money(dayRow.peak)}. Worst single trade: ${patternMemory.money(dayRow.worst)}.`);
        }
      } catch (e) {}
      todays.forEach(e => {
        parts.push(`- trade #${e.tradeIndex + 1}: ${e.size} contract(s), ${patternMemory.money(e.pnl)} [${e.kind}]`);
      });
      parts.push(`This pattern's cumulative damage: ${patternMemory.money(rec.totalCost)}.`
        + (rec.worst ? ` Worst single instance: ${patternMemory.money(rec.worst.cost)} on ${rec.worst.date}.` : ''));
      if (rec.totalGain) parts.push(`Total made on this pattern: ${patternMemory.money(rec.totalGain)}.`);
    } catch (e) {}

    // ── THE CAUSAL CHAIN (2026-09-03) ───────────────────────────────────────
    // The block that answers WHY. Everything above this point is aggregates:
    // counts, recurrence, dollars. Aggregates can only say WHICH RULES broke,
    // which is why an agent asked for a cause reaches for the most concrete
    // discrepancy it can see — usually the app-vs-broker reconciliation gap —
    // and presents that as the finding. See failure-chain.js's header. This is
    // the sequence, the turning point, and the loss attributed exclusively by
    // cause, so the answer is an attribution rather than whichever violation
    // was noticed first.
    parts.push('\n## HOW THIS DAY ACTUALLY UNFOLDED — THE CAUSAL CHAIN');
    parts.push(formatFailureChain(episode.date));

    // Where he got out last and what price has done since — the same reading
    // the left panel shows, from the same module, so they cannot disagree.
    parts.push('\n## LAST EXIT AND WHAT PRICE DID AFTER IT');
    parts.push(formatLastExitForLoop());

    // What every other agent has concluded recently. Their positions are
    // evidence; their reconciliation complaints are not causes.
    parts.push('\n## WHAT THE OTHER AGENTS CONCLUDED (Judge, Post-Session, Scalper, and you earlier)');
    parts.push(formatAgentInputs(8, 600));

    // The edge that closes the loop: what was said about this same pattern
    // before. Without it the agent repeats itself forever and can never be
    // held to its own advice.
    parts.push('\n## WHAT WAS SAID IN CHAT ABOUT THIS PATTERN BEFORE');
    try {
      const info = patternMemory.kindInfo(episode.kind);
      const q = LOOP_SEARCH_TERMS[episode.kind] || (info ? info.label.split(' ')[0] : episode.kind);
      // Widened 2026-09-03 (Anoop: "the memory can be extended to 4GB but needs
      // great capacity of the agent to guide"). The disk has never been the
      // constraint — nothing here trims — so what "more capacity" actually buys
      // is more of the record reaching the model. Raised where it changes the
      // answer: how much prior conversation about THIS pattern it can weigh.
      const prior = chatArchive.search(DATA_DIR, { query: q, limit: 24 })
        .filter(r => r.tradingDay !== episode.date)   // earlier days only
        .slice(0, 12).reverse();
      parts.push(prior.length
        ? chatArchive.formatForAgent(prior, { perRow: 700 })
        : 'Nothing on record — this is the first time you are raising this pattern with him.');
    } catch (e) { parts.push('(prior chat unavailable: ' + e.message + ')'); }

    const dataContext = parts.join('\n');
    const primary = primaryProviderModel();
    const ask = rec.type === 'positive'
      ? 'A positive pattern just repeated. Follow your format and reinforce it.'
      : 'A mistake just repeated. Follow your format exactly. One pattern only.';

    let answer = '';
    await groqAgent.stream(
      [{ role: 'user', content: ask + '\n\n' + dataContext }],
      istDateAnchor() + '\n\n' + LOOP_AGENT_PERSONA,
      [], // no tools — everything it may use is already in the context
      {
        provider: primary.provider,
        model: primary.model,
        temperature: 0.6,   // lower than the coaching personas: this one quotes numbers
        fallbackChain: fallbackChainFor(primary),
        onDone: (fullText, answeredBy) => {
          let outText = fullText;
          // Same grounding gate the Debate verdict and the post-session report
          // use. This agent's whole authority is that its numbers are real, so
          // a figure it invented is worse here than anywhere else in the app.
          try {
            const g = verdictGrounding.checkGrounding(fullText, dataContext, getActiveRules());
            if (!g.ok) {
              outText = fullText + verdictGrounding.groundingWarningBlock(g.ungrounded);
              console.warn('[loop-agent] ungrounded figures:', g.ungrounded.join(', '));
            }
          } catch (e) { console.error('[loop-agent] grounding check failed:', e.message); }
          answer = outText;
          broadcast({
            type: 'loop-feedback',
            kind: episode.kind,
            patternType: rec.type,
            label: rec.label,
            count: rec.count,
            days: rec.days,
            totalCost: rec.totalCost,
            totalGain: rec.totalGain,
            trend: rec.trend,
            date: episode.date,
            text: outText,
            answeredBy,
          });
          // Filed with the Judge and Post-Session verdicts, so the Loop's
          // advice is reviewable later rather than only scrollable.
          saveReviewRecord('loop', outText, { pattern: episode.kind, count: rec.count, trend: rec.trend });
        },
        onError: (errMsg) => {
          console.error('[loop-agent] stream failed:', errMsg);
          // Say the measurable part anyway. The recurrence record is the
          // valuable half and it does not need a model to be true — going
          // silent because a vendor is down would lose exactly the fact this
          // whole feature exists to surface.
          broadcast({
            type: 'loop-feedback', kind: episode.kind, patternType: rec.type,
            label: rec.label, count: rec.count, days: rec.days,
            totalCost: rec.totalCost, totalGain: rec.totalGain, trend: rec.trend,
            date: episode.date, degraded: true,
            text: `**${rec.label.toUpperCase()} — repeat #${rec.count}.** On ${rec.days} of ${rec.daysTradedTotal} trading days on file`
              + (rec.type === 'mistake' ? `, cumulative ${patternMemory.money(rec.totalCost)}.` : `, ${patternMemory.money(rec.totalGain)} made.`)
              + ` Trend: ${rec.trend}. (The coaching model was unavailable — this is the raw record.)`,
          });
        },
      }
    );
    return answer;
  } catch (e) {
    console.error('[loop-agent] failed:', e.message);
    return null;
  }
}

// Search terms used to pull the previous conversation about a pattern out of
// the chat archive. Deliberately the words that actually appear in chat — the
// episode kind ("size-up-into-loss") is a code identifier and would match
// nothing he or the agents have ever written.
const LOOP_SEARCH_TERMS = {
  'oversize': 'size cap',
  'revenge': 'revenge',
  'hold-exceeded': 'hold',
  'out-of-window': 'session window',
  'news': 'news',
  'size-up-into-loss': 'sizing up',
  'overtrading': 'trades today',
  'traded-past-3-losses': 'losses in a row',
  'giveback': 'gave it back',
  'clean-winner': 'clean',
  'disciplined-loss': 'process',
  'clean-day': 'clean day',
  'stopped-in-profit': 'stopped',
};

/**
 * The decision point. Given the episodes a write just produced, work out
 * whether anything has repeated, pick the ONE worth speaking about, and run
 * the agent. Fire-and-forget by design — the caller is a disk write on the
 * live trade path and must not wait on a model.
 */
function maybeRunLoop(added) {
  try {
    if (!Array.isArray(added) || !added.length) return;
    const ledger = patternMemoryStore.readLedger(DATA_DIR);
    const today = tradingDayStampIST();
    const todayEpisodes = ledger.filter(e => e.date === today);
    const fired = loopFiredLoad().kinds || {};

    // The Loop only ever speaks about TODAY — see onlyFromDay's header for the
    // live incident that rule exists to stop. Recurrence still counts every
    // day on file; only the trigger is today.
    const fresh = patternMemory.onlyFromDay(added, today);
    if (!fresh.length) return;

    // Consider mistakes and positives separately, so a bad trade in a good
    // session never silences the streak and vice versa — they are answers to
    // different questions and he asked for both.
    ['mistake', 'positive'].forEach(function (type) {
      const candidates = fresh.filter(e => e && e.type === type && !fired[e.kind]);
      if (!candidates.length) return;
      const primary = patternMemory.pickPrimary(candidates, ledger);
      if (!primary) return;
      const rec = patternMemory.recurrence(ledger, primary.kind);
      const decision = patternMemory.shouldIntervene(primary, rec, { firedToday: fired, todayEpisodes });
      if (!decision.intervene) {
        console.log(`[loop] holding on ${primary.kind}: ${decision.reason}`);
        return;
      }
      loopFiredMark(primary.kind);
      console.log(`[loop] firing on ${primary.kind} — ${decision.reason} (trend ${rec.trend})`);
      runLoopAgent(primary, rec, ledger);   // deliberately not awaited
    });
  } catch (e) {
    console.error('[loop] decision failed:', e.message);
  }
}

/**
 * Sync the ledger and run the Loop on whatever is new. The single entry point
 * every caller uses, so "record it" and "reason about it" can never drift
 * apart into two code paths that disagree about what happened.
 */
function patternMemoryTick(opts) {
  const res = patternMemorySync();
  if (!res.ok) return res;
  if (res.added.length && !(opts && opts.silent)) maybeRunLoop(res.added);
  return res;
}

// What the agents read when they want the memory rather than one repeat.
function formatPatternMemoryForAgent(limit) {
  try {
    const ledger = patternMemoryStore.readLedger(DATA_DIR);
    if (!ledger.length) return 'PATTERN MEMORY — nothing recorded yet.';
    return patternMemory.formatMemory(ledger, { limit: limit || 8 });
  } catch (e) { return 'PATTERN MEMORY — unavailable: ' + e.message; }
}

/** recall_patterns tool body — the memory, or one pattern in full. */
function recallPatterns(args) {
  const a = args || {};
  try {
    const ledger = patternMemoryStore.readLedger(DATA_DIR);
    if (!ledger.length) return 'PATTERN MEMORY — nothing recorded yet.';
    if (a.kind) {
      const rec = patternMemory.recurrence(ledger, String(a.kind));
      if (!rec.count) {
        return `PATTERN MEMORY — "${a.kind}" has never been recorded. Known kinds: ${Object.keys(patternMemory.KINDS).join(', ')}.`;
      }
      return patternMemory.formatRecurrence(rec);
    }
    return patternMemory.formatMemory(ledger, { limit: Number(a.limit) || 10 });
  } catch (e) {
    return 'PATTERN MEMORY — could not be read: ' + e.message;
  }
}


// The per-connection tool executor Jessi uses. Routes chart tools to the TV
// MCP bridge, app_get_data to the local reader, app_do to the client.
function makeJessiToolExecutor(ws) {
  // set_balance is confirm-gated too: it rewrites the number every risk
  // calculation (floor, buffer, day-stop context) is anchored to.
  const DESTRUCTIVE = new Set(['switch_account', 'clear_insights', 'set_balance']);
  return async (name, args) => {
    if (JESSI_TV_TOOL_NAMES.has(name)) {
      // 2026-07-25: fail FAST and clearly when TradingView is down instead of
      // calling into the bridge and waiting on a call that cannot succeed
      // (risking a hang until the 90s turn timeout). Returned as a normal tool
      // RESULT, not a thrown error, so the model reads it, tells Anoop, and
      // carries on with the rest of the conversation.
      if (!mcpBridge.ready || !mcpBridge.tvConnected) {
        return `TradingView is disconnected — "${name}" is unavailable right now. Do not retry chart tools this turn. Tell Anoop TradingView Desktop needs to be running and reconnected (Refresh in the app), and answer whatever you can from his app data instead.`;
      }
      // FIX (2026-08-06): 'market_key_levels' is not a real tradingview-mcp
      // tool (see getKeyLevelsSnapshot() above) — route it there instead of
      // the generic mcpBridge passthrough, which would just fail silently.
      // Alias-normalised before the bridge: draw_list hands the model an "id"
      // field, so it reaches for "id" on draw_remove_one whatever the schema
      // says. See tv-tool-args.js for why the rename alone is not enough.
      const raw = name === 'market_key_levels' ? await getKeyLevelsSnapshot() : await mcpBridge.callTool(name, tvToolArgs.normalizeToolArgs(name, args || {}));
      return (raw && raw.content) ? raw.content.map(c => c.text || '').join('\n') : JSON.stringify(raw);
    }
    if (name === 'app_get_data') {
      return jessiAppGetData((args && args.section) || 'status');
    }
    if (name === 'recall_chat') {
      return recallChat(args);
    }
    if (name === 'recall_patterns') {
      return recallPatterns(args);
    }
    if (name === 'diagnose_day') return diagnoseDay(args);
    if (name === 'search_books') {
      const query = (args && args.query) || '';
      if (!query.trim()) return 'search_books needs a "query".';
      const results = booksIndex.searchBooks(query, { limit: 4, book: (args && args.book) || null });
      if (!results.length) return `No passages found for "${query}" in the book library.`;
      return results.map(r => `[${r.title}]\n${r.text}`).join('\n\n---\n\n');
    }
    if (name === 'app_do') {
      const action = args && args.action;
      if (!action) return 'app_do needs an "action".';
      if (DESTRUCTIVE.has(action) && !(args && args.confirm === true)) {
        return `CONFIRMATION REQUIRED — "${action}" is destructive. Tell Anoop out loud exactly what it will do, get a clear spoken "yes/confirm", then call app_do again with confirm:true. Do NOT run it yet.`;
      }
      return await runAppActionOnClient(ws, action, args || {});
    }
    return `Unknown tool "${name}".`;
  };
}

// ── End app tools ──────────────────────────────────────────────────────────────

// ── Always-on background TV snapshot for Jessi ─────────────────────────────────
// Lighter cadence (3 min) than the 60s/45s/30s engulf monitors, specifically so
// this doesn't add more load to a TradingView MCP connection that has already
// dropped twice this session. Populates jessiTVCache; buildJessiContext() folds
// it in with an age indicator so Jessi has near-live chart awareness without a
// fetch on every single message.
let jessiTVCache = { text: null, ts: 0 };
// FIX (2026-08-06, Anoop: "power of 3 is always unclear" investigation
// surfaced this too): 'market_key_levels' — meant to "aggregate all Pine
// lines/boxes/labels into one sorted list of key levels" — has never existed
// as a real tradingview-mcp tool (same class of bug as market_multi_tf,
// fixed just above in gatherPO3Context). Every call site below silently got
// "Key levels: unavailable" forever. Real replacement: the three tools that
// actually exist for this (data_get_pine_lines/labels/boxes), combined and
// returned in the same {content:[{text}]} shape every call site already
// expects — so this is a drop-in swap, not a rewrite of each caller.
async function getKeyLevelsSnapshot() {
  const [lines, labels, boxes] = await Promise.all([
    mcpBridge.callTool('data_get_pine_lines', {}).catch(() => null),
    mcpBridge.callTool('data_get_pine_labels', {}).catch(() => null),
    mcpBridge.callTool('data_get_pine_boxes', {}).catch(() => null)
  ]);
  const txt = (r) => (r && r.content) ? r.content.map(c => c.text || '').join(' ') : '';
  const parts = [];
  const l1 = txt(lines); if (l1) parts.push('Lines: ' + l1);
  const l2 = txt(labels); if (l2) parts.push('Labels: ' + l2);
  const l3 = txt(boxes); if (l3) parts.push('Zones: ' + l3);
  return { content: [{ text: parts.length ? parts.join(' | ') : 'no key levels drawn' }] };
}

let jessiTVMonitorInterval = null;
function startJessiTVMonitor() {
  if (jessiTVMonitorInterval) clearInterval(jessiTVMonitorInterval);
  const poll = async () => {
    if (!mcpBridge.ready || !mcpBridge.tvConnected) return;
    try {
      const [state, quote, levels] = await Promise.all([
        mcpBridge.callTool('chart_get_state', {}).catch(() => null),
        mcpBridge.callTool('quote_get', {}).catch(() => null),
        getKeyLevelsSnapshot().catch(() => null)
      ]);
      const txt = (r) => (r && r.content) ? r.content.map(c => c.text || '').join(' ') : 'unavailable';
      jessiTVCache = { text: `Chart state: ${txt(state)}\nQuote: ${txt(quote)}\nKey levels: ${txt(levels)}`, ts: Date.now() };
    } catch { /* leave stale cache in place rather than wiping it on a transient error */ }
  };
  poll(); // immediate first read
  jessiTVMonitorInterval = setInterval(poll, 3 * 60 * 1000);
}

// minimal=true (voice): only the account one-liner + the tool directory, no
// chart snapshot / history / journal — those are all fetchable via tools and
// were padding every voice turn against the 6000 TPM cap.
// 2026-08-06: "Where your head's at" (Alignment tab) — Anoop's own dated
// reflections, stored globally (not slot-namespaced, same as Lessons/trade
// journal) via dataSave/dataLoad('align_notes'). Was localStorage-only
// before this — no agent could ever read it despite the UI claiming
// otherwise. This is the single formatter every agent's context-builder
// below calls, so there's one place to change the format, not N copies.
// 2026-08-25: this now serves the MERGED log — recent "where his head's at"
// state entries PLUS his standing lessons, each under its own label.
//
// Before the merge, a lesson without an armed detector reached no agent at
// all, while an identical sentence typed one tab over reached all seven call
// sites below. Routing both through here closes that in one place instead of
// bolting a second formatter onto seven prompts.
//
// The name is unchanged deliberately: it is called from seven places, and a
// rename would be seven chances to miss one and silently drop a persona's
// context. `limit` still means "how many recent STATE entries" — standing
// lessons are capped separately inside mind-log.js, because they never expire
// and an unbounded list would eventually crowd out live trading data.
function formatAlignmentNotes(limit) {
  try {
    const out = mindLog.formatContext(mindLogLoad(), { stateLimit: limit || 3 });
    return out || null;
  } catch (e) { return null; }
}

// Shared IST date/time anchor prepended to EVERY agent's system prompt/context.
// All app data and uploaded Tradovate CSVs are IST wall-clock; without this,
// agents guessed the date (a previously hardcoded date in claude-agent.js went
// ~6 weeks stale, so "yesterday" gave today and day-of-week was wrong).
// Computed fresh per call so it never goes stale.
// Session windows as one short line, ALWAYS read from rules.json -- never
// restated as a literal here. Added 2026-09-03 because buildJessiContext()
// carried NO session times at all, so when Anoop ran the pre-session check
// the model simply invented them: it printed "NY Session opens: 14:00 IST",
// a time that appears in no rule, no config and no data file in this repo.
// A coach that invents the session open will wave him into a window that is
// not open, or hold him out of one that is.
function fmtIstMin(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function formatSessionWindowsIST() {
  const wins = (getActiveRules().sessionWindowsIST || [])
    .filter(w => w && w.startMin != null).slice().sort((a, b) => a.startMin - b.startMin);
  if (!wins.length) return 'no session windows configured';
  return wins.map(w => `${w.name || '?'} ${fmtIstMin(w.startMin)}-${w.endMin != null ? fmtIstMin(w.endMin) : '?'}`).join(', ') + ' IST';
}
// Where the clock actually stands relative to those windows, stated so the
// model never has to subtract two times itself.
function formatSessionStateIST(nowMs) {
  const ist = new Date((nowMs != null ? nowMs : Date.now()) + 330 * 60 * 1000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const wins = (getActiveRules().sessionWindowsIST || [])
    .filter(w => w && w.startMin != null).slice().sort((a, b) => a.startMin - b.startMin);
  if (!wins.length) return '';
  const open = wins.find(w => mins >= w.startMin && (w.endMin == null || mins < w.endMin));
  if (open) return `${open.name} is OPEN now (closes ${fmtIstMin(open.endMin)} IST, ${open.endMin - mins} min left).`;
  const next = wins.find(w => w.startMin > mins);
  if (next) return `No session open right now. Next is ${next.name} at ${fmtIstMin(next.startMin)} IST, in ${next.startMin - mins} min.`;
  return 'No session open right now, and none left today — both windows have closed.';
}

function istDateAnchor() {
  const now = new Date();
  const d = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const wd = now.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' });
  const t = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
  return `Today is ${d} (${wd}), ${t} IST. All app data and every uploaded trade report (Tradovate CSV) is Indian Standard Time (UTC+5:30) — the trader is in India trading the US market. Resolve "today"/"yesterday"/day-of-week strictly in IST from this line; never guess.`;
}

// ── Bias adherence (2026-08-13) ───────────────────────────────────────────────
// Anoop: "compare it with my p&L and crosscheck if my pre-trade was correct or
// wrong and even remind me if in the past i was wrong or right."
//
//   accounts/<slot>/ck_history.json   (declared bias / 4H / 1H per day)
//        +                          ──> biasTracker.buildMatrix ──> Jessi context
//   accounts/<slot>/day_trades.json   (side + pnl per trade)          + Judge
//
// Reads straight off disk rather than the config bucket: the checklist record
// is written there immediately on DONE (renderer ckWriteRecord), so this sees a
// completion within the same session without waiting for End Day.
const biasTracker = require('./bias-tracker');

function biasActiveSlotId() {
  const cfg = loadConfig();
  return cfg.activeSlotId || null;
}

function biasLoadMatrix() {
  try {
    const slot = biasActiveSlotId();
    if (!slot) return null;
    const ckh = dataLoad('ck_history__' + slot) || [];
    const dt = dataLoad('day_trades__' + slot) || {};
    if (!Array.isArray(ckh) || !ckh.length) return { matrix: null, ckh: [], dt: dt };
    return { matrix: biasTracker.buildMatrix(ckh, dt, getActiveRules()), ckh: ckh, dt: dt };
  } catch (e) {
    console.warn('[bias] matrix build failed:', e.message);
    return null;
  }
}

// Today's checklist record + today's trades, for the live cross-check.
function biasTodayContext() {
  try {
    const rules = getActiveRules();
    if (rules.biasAdherence && rules.biasAdherence.enabled === false) return '';
    const loaded = biasLoadMatrix();
    if (!loaded) return '';
    // Calendar IST, NOT tradingDayStampIST(). The checklist record is keyed by
    // calendar day (renderer/checklist-logic.js tradingDayIST) because a
    // pre-trade checklist is a ritual before a session, not a fill; trade
    // records use the 03:45 Globex rollover. The two strings are identical
    // except between 00:00 and 03:45 IST — and matching a checklist against the
    // rollover key in that window would silently find nothing and report "no
    // checklist recorded today" to a man who had just done one.
    const today = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
    const ck = (loaded.ckh || []).filter(e => e && e.date === today)[0] || null;
    return biasTracker.formatContext(ck, (loaded.dt || {})[today], loaded.matrix, rules);
  } catch (e) {
    console.warn('[bias] context failed:', e.message);
    return '';
  }
}

// 2026-08-19 (Anoop's request: "live feed should be accessible to whole of
// the app and work with all agents"): a single shared accessor for today's
// LIVE broker state, so every agent context-builder reads the same source
// instead of each rebuilding its own (or, as of today, not reading it at
// all — buildJessiContext below sourced balance/P&L purely from the CSV-
// derived config bucket, never tvBrokerFeedState). First slice: wired into
// Jessi (both voice and text share this function). Debate/PO3 context
// builders (gatherAnalysisContext/gatherPO3Context) are the next step, not
// done in this same pass — see SEMI_AUTONOMOUS_SYSTEM_PLAN.md's
// "live feed accessible to all agents" section for the staged rollout
// reasoning (verify one integration live before extending to the rest).
// 2026-08-21 (D3): the OPEN position is now part of every agent's live-feed
// context. It used to reach Jessi only as a chat line, so cutting the noisy
// opened/scaled transcript lines would otherwise have made her blind to the
// fact that a trade is on right now — the opposite of what was asked for.
// "Tell Jessi" is a MODEL-CONTEXT requirement; "print it in the transcript"
// is a UI one, and conflating them was the sharpest finding of the review.
function formatOpenPositionContext() {
  const rows = Array.isArray(tvLastPositions) ? tvLastPositions : [];
  const open = rows.filter(p => {
    const q = Number(String((p && p.Qty) == null ? '' : p.Qty).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(q) && q !== 0;
  });
  if (!open.length) return 'OPEN POSITION: none (flat).';
  return 'OPEN POSITION RIGHT NOW: ' + open.map(p =>
    `${p.Side || '?'} ${p.Qty} ${p.Symbol}` + (p['Avg Fill Price'] ? ` from ${p['Avg Fill Price']}` : '') +
    (p.Profit ? ` (open P&L ${p.Profit})` : '')).join('; ') +
    '. This is a LIVE position, not a closed trade — its P&L is still floating.' +
    // 2026-08-24: this sentence used to end "and is not in the day total
    // below", which was true of the balance-delta fold and is false of the
    // broker's own Total P/L (Tradovate: "Combined realized and unrealized
    // P&L for the current session"). Left uncorrected it would have taught
    // every agent to add the open P&L a second time.
    (tvBrokerFeed.effectiveDayPnl(tvBrokerFeedState, Date.now()).source === 'broker'
      ? ' It IS already included in the day P&L below — do not add it again.'
      : ' It is NOT included in the day P&L below.');
}

// ── Verification gate (2026-08-26) ─────────────────────────────────────────
// Anoop: "it should verify with live broker data ... if not API will read
// wrong data and token is simply wasted. before every output it should
// verify."
//
// Every number failure in this app has had one shape: a source was wrong,
// nothing compared it against a second source, and the wrong number was
// handed to an agent as fact. Each of those was detectable by checking the
// app's own day record against the broker's order history. Nothing did it.
//
// Recomputed on demand rather than cached: it is cheap (a rollup over one
// day's rows), and a cached verdict is precisely the kind of stale fact this
// exists to prevent.
function currentVerification() {
  try {
    const slot = jessiBucketKey(loadConfig());
    const dayKey = dayRollup.tradingDayKey(Date.now());
    const store = dataLoad('day_trades__' + slot) || {};
    const rules = getActiveRules();
    return brokerVerify.verifyDay({
      appRows: Array.isArray(store[dayKey]) ? store[dayKey] : [],
      commPerCt: rules.commissionPerContractPerSide != null ? Number(rules.commissionPerContractPerSide) * 2 : 1.0,
      walkClosed: tvBrokerLastWalkClosed,
      brokerRealized: tvBrokerLastBrokerRealized,
      openSize: tvBrokerFeedState ? (tvBrokerFeedState.sizeSeenThisTrade || 0) : 0,
    });
  } catch (e) { return null; }
}

// The last TRUSTWORTHY order-history walk and broker P&L reading, kept so the
// verification can run between polls. Both are null whenever their source was
// unreadable or desynced — the verification then reports NOT VERIFIED, which
// is deliberately a different verdict from a pass.
let tvBrokerLastWalkClosed = null;
let tvBrokerLastBrokerRealized = null;

function formatLiveFeedContext() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) return null;
  if (tvBrokerFeedReadOk !== true) return null;
  const st = tvBrokerFeedState;
  const unconfirmed = (st.trades || []).filter(t => t.pnlUnknown);
  const effPnl = tvBrokerFeed.effectiveDayPnl(st, Date.now());
  const effCount = tvBrokerFeed.effectiveTradeCount(st);
  // 2026-08-24: this sentence is what every agent reasons about size and
  // stops from, so it now states the SOURCE as plainly as the number. The
  // previous wording ("confirmed day P&L ... from N trades this instance
  // watched close") described the fold's partial window as though it were the
  // session total — the same claim that put -$154.20 in front of him against
  // a real +$399.70.
  const lines = [];
  // THE GATE. Every figure below is checked against the broker's own order
  // history and P&L panel first, and the agent is told what that check said
  // BEFORE it reads a single number - including, explicitly, that "could not
  // check" is not the same as "correct".
  const verification = currentVerification();
  if (verification) {
    const vtext = brokerVerify.formatVerificationContext(verification);
    if (vtext) lines.push(vtext);
  }
  if (effPnl.source === 'broker') {
    lines.push(`Live broker feed (today, real trades — not the CSV): ${effCount.value} trade(s). ` +
      `Day P&L $${effPnl.value.toFixed(2)} — this is the BROKER's own session total, read straight off the account panel` +
      (typeof effPnl.open === 'number' && effPnl.open !== 0
        ? `, made up of $${effPnl.realized.toFixed(2)} realized plus $${effPnl.open.toFixed(2)} floating on the position that is open right now.`
        : ' (flat, so all of it is realized).'));
  } else {
    lines.push(`Live broker feed (today, real trades — not the CSV): ${effCount.value} trade(s), day P&L $${(effPnl.value == null ? 0 : effPnl.value).toFixed(2)}. ` +
      `⚠ The broker's own P&L panel is NOT readable right now, so this figure is RECONSTRUCTED from balance movements and covers only trades this instance watched close. ` +
      `Treat it as a floor on the day's result, not the result — the real number may be materially different. Tell him to read the P&L off the broker before sizing anything.`);
  }
  if (effCount.evidence === 'degraded') {
    lines.push(`The trade count is PROVISIONAL (${effCount.degraded} close(s) could not be corroborated against the broker's order history). Use it as guidance, not as a hard stop.`);
  }
  if (unconfirmed.length) lines.push(`${unconfirmed.length} trade(s) were recovered from order history with $ unconfirmed.`);
  if (st.wasFlat === false) lines.push(`A position is currently OPEN (size ${st.sizeSeenThisTrade}).` +
    (effPnl.source === 'broker' ? ' Its floating P&L IS already included in the day P&L above.' : ' Its floating P&L is NOT included in the day P&L above.'));
  try {
    const f1 = mistakePatterns.checkTradeCountEscalation(st.trades);
    if (f1.matched) lines.push(`⚠ ${f1.message}`);
  } catch (e) {}
  // 2026-08-20: F2 alongside F1. Unlike the poll-side broadcast (which fires
  // once per day so a banner never becomes noise), the agent context reports
  // the CURRENT state every turn — an agent asked "should I take this trade"
  // mid-streak must see the streak, not a flag that already fired an hour ago.
  try {
    const f2 = mistakePatterns.checkRevengeCluster(st.trades, { cooldownMinutes: getActiveRules().cooldownMinutes });
    if (f2.matched) lines.push(`⚠ ${f2.message}`);
  } catch (e) {}
  // 5.3 (F3 inverted R:R): same current-state contract as F1/F2 — thresholds
  // from rules.json (f3Ratio, f3MinWins), never hardcoded.
  try {
    const r = getActiveRules();
    const f3 = mistakePatterns.checkInvertedRR(st.trades, { f3Ratio: r.f3Ratio, f3MinWins: r.f3MinWins });
    if (f3.matched) lines.push(`⚠ ${f3.message}`);
  } catch (e) {}
  return lines.join(' ');
}

function buildJessiContext(minimal) {
  const cfg = loadConfig();
  const key = jessiBucketKey(cfg); // see jessiBucketKey() note above — slot-keyed, not legacy accountSize_mode
  const bucket = cfg['acctBucket__' + key] || {};
  const ls = bucket.ls || {};
  const parseLS = (k, fallback) => { try { return JSON.parse(ls[k] || 'null') || fallback; } catch { return fallback; } };
  const acc = Object.assign({}, bucket.account || {});
  acc.balance = jessiVerifyBalance(cfg, bucket, parseLS); // see jessiVerifyBalance() note above

  const parts = [];
  parts.push(`## CURRENT DATE/TIME\n${istDateAnchor()}`);
  // These are the ONLY session times. Stated explicitly because the model was
  // otherwise inventing them -- see formatSessionWindowsIST()'s header.
  parts.push(`## SESSION WINDOWS (IST, from rules.json — the only session times that exist; never quote one that is not on this line)\n${formatSessionWindowsIST()}. ${formatSessionStateIST()}`);

  // ── Is today a real trade record, or just a balance move? (2026-08-31) ──
  // The broker feed lost trade-level detail that day and the session was
  // reconstructed from account balance moves. Jessi was handed those rows as
  // if they were trades and told him he "took a revenge re-entry at size 5
  // right after a $-61 loss". No such trade existed: the -$61.40 WAS the whole
  // session, and the real -$59 loss was followed by two small winners.
  // Coaching invented specifics is worse than coaching nothing — he acts on it.
  try {
    const _todayTrades = (parseLS("copilot_day_trades", {}) || {})[tradingDayStampIST(Date.now())] || [];
    const _note = foldOnly.explain(_todayTrades);
    if (_note) {
      parts.push([
        "## UNRECONCILED DAY — DO NOT CITE PER-TRADE DETAIL",
        _note,
        "TRUSTWORTHY: the day's net P&L, and that the account moved.",
        "NOT TRUSTWORTHY: trade count, individual trade P&L, entry/exit prices, sides, sizes, hold times, best/worst trade, win-loss.",
        "Coach on the NET RESULT and on PROCESS only. Do NOT describe a specific trade, quote a per-trade number, or narrate a sequence of trades from this day — those rows are one balance figure wearing a trade's shape, and anything specific you say about them is fiction he will then act on. 'Today is not reconciled, so I can only speak to the net' is the correct and genuinely useful answer here."
      ].join(String.fromCharCode(10)));
    }
  } catch (e) {}
  parts.push(`## DATA CONTEXT (open account — treat as ground truth)`);
  parts.push(`Active account: ${(cfg.accountSize || '150k').toUpperCase()} ${currentMode.toUpperCase()} — balance $${acc.balance || '?'}, today's P&L $${acc.profit != null ? acc.profit : '?'}.`);
  parts.push(`For cost/insights/trades/scalp/checklist/roadmap/history/rules call app_get_data(section) — "scalp" is the per-day hold-time/gap breakdown. To act call app_do. This open account only. No trades.`);

  // Even in minimal (voice) context, a single most-recent Alignment entry is
  // worth the few extra tokens — it's usually one short dated line, and it's
  // exactly the continuity ("where his head's at") voice coaching needs too.
  const minimalAlign = formatAlignmentNotes(1);
  if (minimalAlign) parts.push(`\n### His own words about himself (most recent state + standing lessons):\n${minimalAlign}`);

  // 2026-08-13: in BOTH minimal (voice) and full context. Anoop asked for the
  // cross-check "the whole day whenever i chat" — a voice turn is a chat turn,
  // and this is ~8 short lines, cheap enough for the voice budget.
  const biasCtx = biasTodayContext();
  if (biasCtx) {
    parts.push(`\n### Direction of record vs what he actually did\n${biasCtx}
When his adherence is below target, say the number and name the pattern — do not lecture. If today is GOT AWAY WITH IT, never congratulate the P&L: he broke his own declared direction and got paid, which is the lesson that ends accounts. Cite the precedent date when one is given.`);
  }

  // 2026-08-19: live broker feed, same short line in both minimal (voice)
  // and full context — see formatLiveFeedContext() above.
  const liveCtx = [formatLiveFeedContext(), formatOpenPositionContext()].join(String.fromCharCode(10));
  if (liveCtx) parts.push(`\n### Live feed (today, real broker data)\n${liveCtx}`);
  // 3.1: the shared market-state line (live chart setup + 1H bias).
  const marketCtx = formatMarketStateLine();
  if (marketCtx) parts.push(`\n### Market state (live chart)\n${marketCtx}`);

  if (minimal) return parts.join('\n');

  // Full context (text chat): add a bit more inline.
  const grHistory = (parseLS('copilot_gr_history', []) || []).slice(-3);
  const journal = (dataLoad('trade_journal') || []).slice(-3);
  // 2026-07-25: state TradingView's status EXPLICITLY. Without this, when the
  // CDP connection is down the model sees no chart section at all, assumes the
  // tools are available, calls them, gets a wall of errors back, and burns
  // requests + context on guaranteed failures. Telling it plainly not to try
  // costs a few tokens and avoids all of that.
  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    parts.push(`\n### TradingView: OFFLINE (CDP connection to TradingView Desktop is down)
Do NOT call any chart tool (chart_get_state, quote_get, market_key_levels, data_get_ohlcv, data_get_pine_labels, draw_shape, draw_list, draw_remove_one, alert_*) — they will all fail until it reconnects. If Anoop asks about the live chart, price or levels, tell him straight that TradingView is disconnected and he needs TradingView Desktop running, then Refresh in the app. Everything else about you works fine without it: his trade history, checklist, journal, breach record, patterns and the coaching all come from app data, not the chart.`);
  } else if (jessiTVCache.text) {
    const ageSec = Math.round((Date.now() - jessiTVCache.ts) / 1000);
    parts.push(`\n### Live chart snapshot (${ageSec}s old — call a chart tool for something fresher)\n${jessiTVCache.text}`);
  }
  if (grHistory.length) {
    parts.push(`\n### Last ${grHistory.length} day(s) (call app_get_data "insights" for more):`);
    grHistory.forEach(d => parts.push(`- ${d.date}: $${d.pnl} · ${d.n} trades · disc ${d.disc}%`));
  }
  if (journal.length) {
    parts.push(`\n### Recent journal notes:`);
    journal.forEach(j => parts.push(`- [${j.ts}] ${j.text}`));
  }
  // 2026-08-25: the DAILY JOURNAL — his own end-of-day words, his mood, whether
  // he followed his plan, the mistake he named, and the lesson he wrote for the
  // next session. Distinct from `trade_journal` above (that is the free-text
  // app_do "add_journal" stream); this is the Journal tab's structured note,
  // and until now NOTHING read it back to him.
  const djCtx = formatJournalNotesContext(3);
  if (djCtx) parts.push('\n### His own journal — what he told himself to do today\n' + djCtx);
  // 2026-08-25: after the merge, every armed guardrail's TEXT already reaches
  // all seven personas through formatAlignmentNotes (the merged mind log), so
  // this block adds only what that one cannot say — which of them have
  // actually caught him, and which have been armed for weeks without ever
  // firing. The never-fired half is the point: such a check is either a habit
  // he fixed or a check that does not work, and staying quiet lets him assume
  // the first. Full-context path only — this is detail, not continuity.
  const armedCtx = formatArmedDetectorsContext();
  if (armedCtx) parts.push('\n### How his armed guardrails are actually performing\n' + armedCtx);
  // 2026-08-01: surface the Scalper agent's behavioural notes to Jessi too, so
  // the two agents reinforce the same observation instead of contradicting each
  // other. Capped to 3 days here (Jessi's context is token-sensitive); the
  // Post-Session Analyst gets 7 days.
  try {
    const sn = scalperNotesRead(null, 3);
    if (sn && !/^No scalper notes/.test(sn)) parts.push('\n### Scalper agent notes (behaviour, from video reviews):\n' + sn);
  } catch (e) {}
  // Fuller Alignment history for full (text chat) context — the minimal/voice
  // path above already got the single most-recent entry.
  const fullAlign = formatAlignmentNotes(3);
  if (fullAlign) parts.push(`\n### His own words about himself — current state AND standing lessons (read before coaching; don't just cite it, factor it in):\n${fullAlign}`);
  return parts.join('\n');
}

// Lightweight on-demand TV pull — only fires when the message text looks like
// it's asking about the live chart. This is intentionally NOT a background
// poll; it runs once, synchronously, inside a single chat turn.
async function maybeFetchTVSnapshot(text) {
  if (!/\b(chart|price|level|pdh|pdl|candle|trend|bias|zone|setup|4h|1h|15m|quote)\b/i.test(text || '')) return null;
  if (!mcpBridge.ready || !mcpBridge.tvConnected) return '(Anoop asked about the chart, but TradingView MCP is not connected right now — tell him to check the connection.)';
  try {
    const [state, quote, levels] = await Promise.all([
      mcpBridge.callTool('chart_get_state', {}).catch(() => null),
      mcpBridge.callTool('quote_get', {}).catch(() => null),
      getKeyLevelsSnapshot().catch(() => null)
    ]);
    const txt = (r) => (r && r.content) ? r.content.map(c => c.text || '').join(' ') : '';
    return `### Live TradingView snapshot (pulled just now, on-demand)\nChart state: ${txt(state) || 'unavailable'}\nQuote: ${txt(quote) || 'unavailable'}\nKey levels: ${txt(levels) || 'unavailable'}`;
  } catch (e) {
    return `(Tried to pull the live chart but it failed: ${e.message})`;
  }
}

// 2026-07-23: Groq's per-response rate-limit headers give live TPM/RPD
// remaining (see groqAgent.stream()'s onQuota) — this only turns that into a
// user-facing warning once it's actually getting tight, so normal turns
// don't spam a status line on every single message. Threshold is on TPM
// specifically since that's what caused the 413 seen live (a single turn's
// tool-call context blowing past the per-minute cap) — RPD running low is a
// much rarer real-world case on the 8B model's 14.4K/day allowance.
const QUOTA_WARN_FRACTION = 0.2;
function quotaWarning(model, quota) {
  if (!quota || quota.limitTokens == null || quota.remainingTokens == null) return null;
  if (quota.remainingTokens / quota.limitTokens > QUOTA_WARN_FRACTION) return null;
  return `${model}: ${quota.remainingTokens}/${quota.limitTokens} tokens left this minute.`;
}

async function handleJessiChat(ws, msg) {
  const { messages, reqId } = msg;
  const lastUserText = (messages && messages.length) ? messages[messages.length - 1].content : '';

  // Background monitor (jessiTVCache) covers most "what's the chart doing"
  // asks already; this is only an extra force-refresh for freshness when the
  // message specifically looks chart-related, on top of the cache in buildJessiContext().
  const tvSnapshot = await maybeFetchTVSnapshot(lastUserText);
  const systemPrompt = JESSI_PERSONA + '\n\n' + buildJessiContext() + (tvSnapshot ? '\n\n' + tvSnapshot : '');

  // 2026-08-16 (Pattern 02, assistive routing — chat-intent.js): advisory
  // only, never rewrites systemPrompt or reroutes the message. A separate WS
  // message the renderer shows as a system note; Jessi's own answer is
  // untouched either way.
  try {
    const intent = chatIntent.classifyChatIntent(lastUserText);
    const hint = chatIntent.modeMismatchHint(intent, (getActiveRules().tradingMode || 'standard'));
    if (hint && !chatIntent.shouldSuppressForCooldown(modeHintLastAt.get(ws), Date.now(), MODE_HINT_COOLDOWN_MS)) {
      modeHintLastAt.set(ws, Date.now());
      send(ws, { type: 'mode-hint', reqId, message: hint });
    }
  } catch (e) {}

  // FIX (2026-07-23, "still not working" — text chat hit a 429 on
  // llama-3.3-70b-versatile, TPD 95443/100000 used): this call never passed a
  // `model`, so groq-agent.js's stream() silently defaulted to the 70B model
  // (see GROQ_MODEL in groq-agent.js) — a completely separate free-tier daily
  // budget from the 8B model handleJessiVoiceSend() already switched to for
  // the same rate-limit reason. Text chat was still exposed to the exact
  // problem voice was fixed for. Now shares the 8B model/budget with voice.
  // Tradeoff worth knowing: text chat and voice now draw from the SAME daily
  // 8B token bucket, so heavy use of both in one day can still exhaust it —
  // just no longer on a bucket that was already at 95%+ before this fix.
  // 2026-07-25: switched from Groq to GEMINI as Jessi's primary brain.
  // Root cause of the repeated live failures was never the daily budget — it
  // was Groq's free-tier TOKENS-PER-MINUTE ceiling (6,000-8,000), which
  // Jessi's turn genuinely exceeds: 413 "Request too large" and
  // 429 "TPM Limit 8000, Used 5517, Requested 2663" are both per-minute
  // errors. Shuffling between two Groq model IDs only moved the same request
  // between two equally-small buckets. Gemini's free tier allows 250,000 TPM
  // (~30x), so the fat context fits instead of needing to be trimmed.
  // Flash-Lite over plain Flash: 15 RPM / 1,000 RPD vs 10 RPM / 250 RPD —
  // Jessi is meant for casual back-and-forth, so request volume wins over
  // the marginal reasoning gain.
  // Groq stays as the fallback: separate vendor, entirely separate quota, and
  // still the fastest inference available if Gemini's RPD ever runs out.
  const abortCtrl = registerRequest(reqId);
  const primary = primaryProviderModel();
  try {
  await groqAgent.stream(messages, systemPrompt, JESSI_TOOLS, {
    provider: primary.provider,
    model: primary.model,
    temperature: 0.85,
    signal: abortCtrl.signal,
    // 2026-07-25 (revised): started as a single gemini-2.5-flash-lite +
    // one Groq fallback, which died on a live 404 — Google had closed the 2.5
    // line to new accounts, and 404 wasn't retryable at the time. Now an
    // ordered chain, tried top to bottom on 404/429/413/400:
    //   1. gemini-3.5-flash      — GA, 15 RPM / 1,500 RPD
    //   2. gemini-3.1-flash-lite — GA, cheaper/lighter Google fallback
    //   3. gemini-2.5-flash      — older line; works for accounts that
    //                              already had access before it was closed
    //   4. openai/gpt-oss-20b    — Groq. Different vendor, separate quota,
    //      and Groq's own migration target for llama-3.1-8b-instant /
    //      llama-3.3-70b-versatile, both deprecated 2026-06-17 (retiring
    //      08/16/26). Last because of Groq's 6-8K TPM ceiling, which is what
    //      caused the original failures this whole switch was meant to fix.
    // Entries whose provider has no key configured are skipped automatically.
    fallbackChain: fallbackChainFor(primary),
    toolExecutor: makeJessiToolExecutor(ws),
    onToken:     (text)              => send(ws, { type: 'jessi-chat-token',     reqId, text }),
    onToolStart: (name, id)          => send(ws, { type: 'jessi-chat-tool-start',reqId, name, id }),
    onToolDone:  (name, id, ok, res) => send(ws, { type: 'jessi-chat-tool-done', reqId, name, id, ok, result: res }),
    onFallback:  (fromM, toM)        => send(ws, { type: 'jessi-chat-fallback',  reqId, from: fromM, to: toM }),
    onWait:      (m, sec)            => send(ws, { type: 'jessi-chat-quota-warn', reqId, message: `${m}: per-minute rate cap — waiting ${sec}s and retrying the same model (not switching).` }),
    onQuota:     (m, quota) => { const w = quotaWarning(m, quota); if (w) send(ws, { type: 'jessi-chat-quota-warn', reqId, message: w }); },
    onDone:      (fullText, answeredBy) => send(ws, { type: 'jessi-chat-done',   reqId, fullText, answeredBy }),
    onError:     (errMsg)            => send(ws, { type: 'jessi-chat-error',     reqId, message: errMsg })
  });
  } finally {
    unregisterRequest(reqId);
  }
}

// ── 3-Agent Debate System ──────────────────────────────────────────────────────
// Architecture: User question → Jessi (discipline/psychology) + Analysis (technical/market)
// run in PARALLEL → Expert Judge synthesizes both arguments → final answer streamed to user.
// All three agents run on the same Gemini backend (free tier). Data is PRE-FETCHED before
// the debate so no tool calling is needed during the debate itself — faster and cheaper.

const ANALYSIS_DEBATE_PERSONA = `You are the Technical Analysis Agent in Anoop Habib's MNQ Co-Pilot trading app. Your role in this debate is to argue PURELY from the market/technical data perspective.

Your data domain (and ONLY yours — stay in your lane):
- Live TradingView chart state: current symbol, timeframe, indicator values
- Price action: OHLCV bars, candlestick patterns, trend structure
- Key levels: support/resistance, Pine-drawn lines/labels/boxes, PDH/PDL, session levels
- Technical indicators: RSI, MACD, EMA, Bollinger Bands, VWAP — whatever's on the chart
- Market structure: higher highs/lows, lower highs/lows, FVGs, SFPs, engulfing patterns
- Multi-timeframe alignment: 1H → 15M → 5M confluence. Your context includes a MECHANICAL 1H BIAS block (2026-08-17, PO3's own bias-gate source) — use it, don't say you lack 1H/HTF data. Daily is DELIBERATELY never given to you (Anoop reads the daily candle himself, same rule Power of 3 follows) — if a top-down needs Daily specifically, say that's his call to make, not a data gap you're missing.
- Playbook validity: whether current price action satisfies Playbook A (engulfing + TF alignment), Playbook B (SFP + FVG), or Playbook C (engulfing validity rules)

What you are NOT:
- You are NOT a psychologist or discipline coach — that's Jessi's domain
- You do NOT comment on trade count, revenge patterns, emotional state, or rule violations
- You do NOT give the final verdict — the Expert Judge does that

Your job: Present the strongest technical argument you can. If the setup is valid, say so with specific levels and confluence. If it's not, say so with specific reasons (no alignment, no zone, wrong structure). Be precise with numbers — cite actual prices, levels, and indicator readings from the data below. If data is missing or stale, say so rather than fabricating.

Anoop's entry framework requires ALL of these in sequence: (1) Daily bias clear, (2) 1H aligns with Daily, (3) Price at a pre-marked 4H zone, (4) 15M/5M reaction at zone, (5) 3M/1M trigger. Score the current setup against each step.`;

const JUDGE_PERSONA = `You are the Expert Judge in Anoop Habib's MNQ Co-Pilot trading app. You receive THREE arguments — from Jessi (discipline/psychology), the Technical Analysis agent (structure/levels), and the ICT Power of 3 agent (AMD phase: Accumulation / Manipulation / Distribution) — and you synthesize them into a single, definitive answer.

Your method:
1. Read all three arguments carefully. Identify where they AGREE and where they CONFLICT.
2. When they agree, state the consensus plainly — no need to rehash each one.
3. When they conflict, weigh the evidence each side presented. Technical data trumps feelings, but discipline data trumps technical setups (a valid setup with a revenge mindset is still a NO-GO).
4. Give your VERDICT clearly at the top, then the reasoning. Don't bury the answer.
5. If any agent made a claim unsupported by its data, call that out.
6. DATA-INTEGRITY HALT (highest priority, overrides everything below). All three agents are handed the SAME pre-fetched ACCOUNT & TRADE DATA block. They must therefore report identical trade counts, P&L figures, sizes and hold times. If two agents state DIFFERENT numbers for the same trades, one of them has fabricated. Do NOT average them, do NOT reconcile them, and do NOT proceed as if "both point to the same reality" — they do not. Instead: make your verdict NO-GO, state plainly at the top that the app produced contradictory trade data and which agent's figures disagree with the seeded block, and tell Anoop the analysis below cannot be trusted until it is checked against his broker statement. A confidently-worded coaching verdict built on invented P&L is more dangerous than no verdict at all.

Decision hierarchy (non-negotiable):
- If Jessi flags a discipline violation (revenge, overtrading, broken plan, sizing up while down) → that OVERRIDES any technical setup quality AND any AMD phase. A perfect chart doesn't fix a broken process.
- If Analysis says the setup is invalid (no alignment, no zone, wrong structure) → that OVERRIDES Jessi saying "he's in a good headspace." Feeling good doesn't make a bad setup tradeable.
- If Power of 3 says price is still in ACCUMULATION, or that the phase is unclear → treat that as a WAIT signal even when the other two look acceptable. Entering during accumulation is entering before the manipulation leg that would stop him out — this is exactly the trap the framework exists to avoid.
- If Power of 3 identifies MANIPULATION completing (liquidity swept, reversal underway) and both other agents are green, that STRENGTHENS the case — say so explicitly.
- ALL THREE must be green for a GO. Any one red = NO-GO, with the specific reason.
- Power of 3 alone is never sufficient for a GO — a clean AMD read with a discipline violation is still NO.

YOU ARE THE ONLY AGENT WHO WRITES AT LENGTH. The other three are now capped at a
headline plus two lines each, deliberately, because Anoop reads this mid-session
with money on and cannot absorb four long analyses. That means:
- The VERDICT is yours alone. They are forbidden from giving one. If you do not
  state it, nobody does.
- The fix for tomorrow is yours alone. Always end with a section headed exactly
  "## ONE CONCRETE FIX FOR TOMORROW" containing ONE action, in one or two lines,
  specific enough to do without deciding anything further. Not three options, not
  a principle — one action. "Cap tomorrow at 6 contracts total" is a fix.
  "Be more disciplined" is not.
- Do NOT repeat their headlines back. They have already been read directly above
  you. Reference a point only when your verdict turns on it.

Tone: Direct, data-backed, no hedging. You're the final word — own it. Keep it
tight: verdict on the first line, then 2-4 sentences of reasoning, then the fix.
The whole screen — your verdict plus their three cards — must be readable in
under five minutes. Not an essay.

Depth stays available; it just is not the default. Every figure you were handed
remains in the app's records. If Anoop wants the long version he asks a direct
question, or runs the post-session report — and then length is fine.

Context: Zero margin for error on ANY currently open account — funded especially, since that is the one that pays out. When in doubt, the answer is NO. Past losses hit Max Loss Limit through a recurring, specific handful of failure modes (trade-count escalation, revenge re-entries, size-up while down, holding losers, giving back gains) — cite the specific behavior in today's data if you see it, not a running account count.

COST OF FAILURE — cite this, it is the point. The ACCOUNT & TRADE DATA block includes a COST line with his real lifetime prop spend, payouts received, and net position, fed live from his Cost tab. Quote those exact figures rather than any number you remember. When a session goes badly, state plainly what the running total now is and that payouts remain at zero — the gap between what he has spent and what he has been paid is the single most honest argument against taking one more trade. Never estimate or round it; if the COST line is absent, say the figure is unavailable rather than inventing one.

MACHINE-READABLE TICKET LINE (2026-08-17, Phase 2b). If and ONLY IF your verdict is a genuine GO with a specific entry, end your response with one line in exactly this format (own line, nothing after it):
TRADE_TICKET: side=buy|sell size=N [stop=PRICE] [target=PRICE]
- side and size are REQUIRED whenever you say GO. size must be a whole number you believe is appropriate — the app enforces its own hard cap independently of what you write here, so do not inflate it to seem confident; state the size you actually believe is right for this setup.
- stop/target are OPTIONAL — include a PRICE only if you can point to a specific level from the arguments above (a real structural level, not a guess). Omit the key entirely rather than inventing a number.
- Do NOT include a symbol on this line — the app resolves the live symbol itself.
- On a NO-GO, do not emit this line at all.
This line is parsed by the app to offer Anoop a one-click trade ticket — it is a mechanical instruction, not part of your prose, so keep your actual verdict text exactly as tight as instructed above; add this as a final standalone line after everything else, including "## ONE CONCRETE FIX FOR TOMORROW".`;

// 2026-08-16 (Pattern 03, parallelization — the VOTING variant). Debate mode
// already uses SECTIONING well (Jessi/Analysis/PO3, each one lane, Judge
// synthesizes). Voting — the same judgment checked a second independent way
// for extra confidence — was entirely absent. Scoped to GO verdicts only,
// on purpose: that is the one outcome that actually authorizes risk, so it
// is the only one worth the extra call. Fires AFTER the verdict has already
// been shown (see handleDebateChat's onDone) rather than before it, so the
// live trading moment pays zero extra latency — the safety value lands as a
// follow-up note a few seconds later instead of a delay on the verdict
// itself. Silent when it finds nothing: a refuter that always says something
// trains Anoop to ignore it, exactly the failure mode a real second opinion
// is supposed to prevent.
const REFUTER_PERSONA = `You are a skeptical second-opinion reviewer for Anoop Habib's MNQ Co-Pilot trading app. You are handed a GO verdict that has ALREADY been shown to Anoop, along with the three arguments (Jessi/discipline, Analysis/technical, Power of 3/AMD phase) it was built from.

Your ONLY job: try, genuinely, to find a real reason this GO is wrong — a discipline flag Jessi raised that the verdict underweighted, a technical invalidity Analysis raised that got glossed over, or an AMD-phase problem Power of 3 raised that was dismissed too quickly.

If you find a genuine objection: state it in 2-3 sentences, specific and actionable, citing the exact point from whichever argument you're drawing on.

If you cannot find a real objection after actually trying: reply with EXACTLY this and nothing else — "NO OBJECTION — the GO holds up."

Do not manufacture a concern to look thorough. A false alarm on a genuinely good trade has a real cost too — it teaches Anoop to distrust a working system.`;

function dispatchGoRefutation(ws, reqId, judgeContext, verdictText) {
  // Deliberately not awaited by the caller — see the comment above. Own
  // try/catch so a failure here can never surface as a debate error; the
  // verdict Anoop already has stands regardless of what happens next.
  runDebateAgent(REFUTER_PERSONA, 'Review the GO verdict above. Does it hold up?', judgeContext + '\n\n## THE VERDICT ALREADY SHOWN\n' + verdictText, null)
    .then(result => {
      const text = (result && result.text || '').trim();
      if (!text || /^no objection/i.test(text)) return; // silent — nothing to add
      emitTo(ws, { type: 'debate-refutation', reqId, text });
    })
    .catch(e => console.error('[go-refutation] failed:', e.message));
}

// Pre-fetch all data for the Analysis agent (no tool calling during debate)
async function gatherAnalysisContext() {
  const parts = [];

  // Live TradingView snapshot
  if (mcpBridge.ready && mcpBridge.tvConnected) {
    try {
      const [state, quote, levels, ohlcv, labels, boxes] = await Promise.all([
        mcpBridge.callTool('chart_get_state', {}).catch(() => null),
        mcpBridge.callTool('quote_get', {}).catch(() => null),
        getKeyLevelsSnapshot().catch(() => null),
        mcpBridge.callTool('data_get_ohlcv', { summary: true }).catch(() => null),
        mcpBridge.callTool('data_get_pine_labels', {}).catch(() => null),
        mcpBridge.callTool('data_get_pine_boxes', {}).catch(() => null)
      ]);
      const txt = (r) => (r && r.content) ? r.content.map(c => c.text || '').join(' ') : 'unavailable';
      parts.push('## LIVE CHART DATA (pulled just now)');
      parts.push('Chart state: ' + txt(state));
      parts.push('Quote: ' + txt(quote));
      parts.push('Key levels: ' + txt(levels));
      parts.push('OHLCV summary: ' + txt(ohlcv));
      parts.push('Pine labels: ' + txt(labels));
      parts.push('Pine boxes (zones): ' + txt(boxes));
    } catch (e) {
      parts.push('## CHART DATA: FAILED TO FETCH (' + e.message + ')');
    }

    // ── COMPUTED READS (2026-08-11, Anoop) ───────────────────────────────────
    // Three things Anoop asked the Analysis agent to report, all worked out in
    // arithmetic here and handed over as finished answers rather than left for
    // the model to judge off a bar list (see chart-reads.js header for why):
    //   1. 1H vs 15m direction — and when they agree, NAME the direction.
    //      "aligned" on its own is useless at the moment of entry.
    //   2. 9-EMA as a CONFIRMATION of the 1H bias, not a standalone read:
    //      1H up wants the 15m closing above the 15m 9-EMA, 1H down below.
    //   3. A Doji on the 1H, reported ONLY when it prints at PDH or PDL.
    //      A Doji in open space is noise on MNQ; at yesterday's extreme it
    //      isn't. Anything further than the tolerance is never mentioned.
    // Wrapped in its own try/catch so a failure here degrades to "unavailable"
    // instead of taking down the whole Analysis context.
    try {
      const [h1Trend, m15Trend, m15Bars, h1Bars, pdhPdl] = await Promise.all([
        getTrendForTF('60').catch(() => null),
        getTrendForTF('15').catch(() => null),
        getFullBars('15', 60).catch(() => []),
        getFullBars('60', 30).catch(() => []),
        getPDHPDL().catch(() => null)
      ]);

      parts.push('\n## COMPUTED READS (arithmetic, not model judgement — trust these over your own eyeballing)');

      const align = chartReads.alignmentVerdict(h1Trend, m15Trend, '1H', '15m');
      parts.push(align.text);

      // Last CLOSED 15m bar — the in-progress bar is excluded on purpose; its
      // body and close move every tick, so a doji/EMA read on it is meaningless.
      const lastClosed15 = m15Bars.length >= 2 ? m15Bars[m15Bars.length - 2] : null;
      const ema9 = chartReads.emaFromBars(m15Bars.slice(0, -1), 9);
      parts.push(chartReads.emaConfirmation(h1Trend && h1Trend.direction, lastClosed15, ema9).text);

      const lastClosed1h = h1Bars.length >= 2 ? h1Bars[h1Bars.length - 2] : null;
      const doji = pdhPdl ? chartReads.dojiAtKeyLevel(lastClosed1h, pdhPdl.pdh, pdhPdl.pdl, 15) : null;
      parts.push(doji ? doji.text : 'No 1H doji at PDH/PDL on the last closed 1H bar.');
    } catch (e) {
      parts.push('\n## COMPUTED READS: unavailable (' + e.message + ')');
    }

    // 2026-08-17, tightened same day: originally added a 4H read here to
    // close the gap gatherPO3Context() was fixed for on 2026-07-29 (a NO-GO
    // verdict cited "Analysis has no Daily/4H/1H chart data"). Anoop then
    // moved PO3's own bias gate from 4H to 1H (checkPo3Phase/gatherPO3Context)
    // — this block follows, reusing po3TrendRead('60'), the EXACT function +
    // bar count PO3's gate now uses, so the two agents can never disagree.
    // NOTE this is deliberately a DIFFERENT read from the "1H vs 15m aligned"
    // line in COMPUTED READS above — that one uses getTrendForTF('60') (60
    // bars, a different classifier instance for a different job: entry
    // alignment). This block is PO3's own bias number specifically, so the
    // two agents' AMD framing can't drift apart. Two different lenses on 1H,
    // not a contradiction if they read slightly differently.
    try {
      const gateRead = await po3TrendRead('60').catch(() => null);
      parts.push('\n## MECHANICAL 1H BIAS — PO3\'s bias-gate source (computed by the app, no AI — same function+bar-count Power of 3\'s gate uses)');
      parts.push(gateRead
        ? '1H (PO3 gate): ' + (gateRead.label || gateRead.direction) + ' | direction=' + gateRead.direction + ' | score=' + (gateRead.score != null ? gateRead.score : 'n/a') + ' | bars=' + (gateRead.bars || 'n/a')
        : '1H (PO3 gate): unavailable');
      parts.push('NOTE: Daily is deliberately NOT provided — Anoop reads the daily candle himself. Do not claim a daily read; if his question needs one, say Daily is his call, not yours.');
    } catch (e) {
      parts.push('\n## MECHANICAL 1H BIAS: unavailable (' + e.message + ')');
    }
  } else {
    parts.push('## CHART DATA: UNAVAILABLE (TradingView not connected)');
  }

  // Also include the cached TV snapshot if it has extra info
  if (jessiTVCache.text) {
    const ageSec = Math.round((Date.now() - jessiTVCache.ts) / 1000);
    parts.push('\n## Background monitor snapshot (' + ageSec + 's old)\n' + jessiTVCache.text);
  }

  // Recent trade data (from the active account) for pattern context.
  //
  // 2026-08-11 — ANTI-FABRICATION GUARD. On 08-10 the Debate ran with this
  // block correctly populated (real values: -72.5/145s, -146/587s, -171/25s,
  // -449/954s, +0.5/379s) and the Technical agent reproduced it verbatim —
  // but Jessi, holding the identical text, emitted a completely invented
  // 5-row table (-312/-245/-180/-95/-47, none of which exist anywhere) and
  // Anoop was shown it as fact. That is the single most dangerous failure
  // this app can have: a coach inventing P&L on a live funded account.
  // Not a tool bug (debate agents run with tools:[] and get pre-seeded data)
  // and not a data bug (the file on disk was correct) — the model simply
  // confabulated in the presence of ground truth.
  // This header is deliberately blunt and sits immediately above the numbers,
  // where an attention-limited model is most likely to honour it. It is a
  // mitigation, NOT a fix — the real fix is a model that doesn't do this.
  // ── 2026-08-11: P&L DELIBERATELY WITHHELD FROM THIS AGENT ────────────────
  // Anoop: "both these agents should not be influenced by P&L" (Analysis and
  // Power of 3). This function previously injected jessiAppGetData('all') —
  // balance, today's P&L, per-trade history, lifetime cost. A technical agent
  // that can see it is down $855 on the day is no longer reading the chart;
  // it is reading the chart *and* the scoreboard, and the second one leaks
  // into the first. Jessi is the agent whose job is the money and the
  // behaviour, and she still gets all of it (see handleDebateChat).
  //
  // Removing it also removes this agent's ability to fabricate trade numbers
  // at all — it has none to get wrong. Note the earlier comment here blamed
  // the 08-10 fabrication on "the model confabulating in the presence of
  // ground truth"; that diagnosis was WRONG. Analysis had the real rows and
  // reported them correctly. Jessi had only day-level totals plus an
  // instruction to call a tool she did not have in debate mode, and filled
  // the gap herself. Root cause and fix are in handleDebateChat.
  parts.push('\n## ACCOUNT / P&L: deliberately not provided.');
  parts.push('You are the technical agent. You do not know his balance, his P&L, his position, or his trade history, and you must not speculate about them or let them colour your read. Judge the chart only. If asked about money or his trading record, say that is Jessi\'s lane.');

  // 2026-08-07: Alignment ("where his head's at") — was only reaching Jessi/
  // Scalper/Claude/Post-Session (via buildJessiContext). Anoop asked for it
  // to be known by ALL agents, this one included, even though Analysis's own
  // persona stays out of psychology — the data is now visible either way, the
  // persona's "stay in your lane" instruction still governs what it DOES with it.
  try {
    const align = formatAlignmentNotes(2);
    if (align) parts.push('\n## HIS OWN WORDS ABOUT HIMSELF — current state AND standing lessons (for awareness, not yours to diagnose)\n' + align);
  } catch (e) {}

  return parts.join('\n');
}

// Run one debate agent (no tools, collect full text). Resolves
// {text, answeredBy} — answeredBy is null on error (no model actually
// produced a reply in that case).
function runDebateAgent(systemPrompt, userQuestion, dataContext, signal) {
  return new Promise((resolve) => {
    let fullText = '';
    const primary = primaryProviderModel();
    groqAgent.stream(
      [{ role: 'user', content: userQuestion }],
      systemPrompt + '\n\n' + dataContext,
      [], // no tools
      {
        provider: primary.provider,
        model: primary.model,
        temperature: 0.7,
        signal,
        fallbackChain: fallbackChainFor(primary),
        onToken: (text) => { fullText += text; },
        onDone: (_text, answeredBy) => resolve({ text: fullText || '(No argument produced)', answeredBy }),
        onError: (err) => resolve({ text: '(Agent error: ' + err + ')', answeredBy: null })
      }
    );
  });
}

// 2026-08-19 BUG FIX (found live, root-caused after a recurring
// withChartLock timeout cascade every ~3 minutes): checkPo3SecondarySymbol
// used to hold the exclusive chart lock through this ENTIRE function,
// including the full multi-agent LLM debate below (Jessi + Analysis + PO3 in
// parallel, then the Judge) — 10-90+ seconds observed live. Every other
// chart-lock consumer (PO3 primary monitor, Engulf, SFP, key-level checks)
// queued behind it and routinely timed out. `preGathered`, when provided,
// lets a caller supply context it already fetched WHILE the chart was still
// parked on the symbol it needed — the caller (checkPo3SecondarySymbol) can
// then restore the primary symbol and release the lock BEFORE the slow LLM
// calls below ever start. Every other caller (the manual Debate button, the
// primary-symbol auto-trigger) omits it and this function gathers its own
// context exactly as before — zero behavior change for them.
async function handleDebateChat(ws, msg, preGathered) {
  const { messages, reqId } = msg;
  const lastUserText = (messages && messages.length) ? messages[messages.length - 1].content : '';
  const abortCtrl = registerRequest(reqId);

  // BUGFIX (2026-07-28): this whole function used to run with no top-level
  // try/catch. Anoop hit a hard stuck chat ("the chat is crashed" — red stop
  // icon, input disabled) that traced back to this: any throw anywhere in
  // here (a synchronous throw from groqAgent.stream, gatherAnalysisContext,
  // etc.) became an unhandled promise rejection on the server. The client
  // never got a debate-judge-error, so its sendDebateChat() promise just sat
  // there until its OWN 5-minute timeout — isStreaming stuck true the whole
  // time, which is what made the UI look crashed. Wrapping the body means any
  // failure now reaches the client immediately instead of silently hanging.
  try {
    // Phase 1: Pre-fetch data for both agents
    emitTo(ws, { type: 'debate-status', reqId, phase: 'gathering', message: 'Gathering data for both agents...' });

    const jessiContext = preGathered ? preGathered.jessiContext : buildJessiContext();
    const tvSnapshot = preGathered ? preGathered.tvSnapshot : await maybeFetchTVSnapshot(lastUserText);
    const analysisContext = preGathered ? preGathered.analysisContext : await gatherAnalysisContext();

    const jessiSystemPrompt = JESSI_PERSONA + '\n\nYou are in DEBATE MODE. Your lane is DISCIPLINE ONLY: trade count, size, cooldown, revenge, plan adherence. Not the chart, not the phase, not the verdict.'
      // 2026-08-17: found live — Jessi was ignoring DEBATE_BRIEF_FORMAT entirely
      // (writing full paragraphs, no headline) and telling Anoop to "switch to
      // the main chat" for chart analysis, a phrase that exists nowhere in this
      // prompt. Root cause: the base JESSI_PERSONA above (used in her OTHER
      // modes too) has a HARD LINE section saying symbol/timeframe switching
      // "is the main co-pilot chat's job, not yours" — true in her normal
      // single-agent chat mode, where that really is a different code path, but
      // there is no second "chat" inside a debate reply, and nothing above told
      // her that distinction doesn't apply here. Being explicit about it,
      // rather than trusting her to infer it from an unrelated HARD LINE bullet.
      + '\n\nIMPORTANT — THIS IS THE ONLY CHAT. There is no separate "main chat" to switch to from inside a debate reply — you and the Judge below are answering in the SAME view, right now. Never tell Anoop to switch chats or ask elsewhere. If his question is really about chart/phase/verdict, do not refuse or explain your lane restriction — just give your DISCIPLINE read on whatever decision is on the table (is now a safe moment to enter, size-wise and state-of-mind-wise) and let the Judge below cover the rest. The output shape below is MANDATORY even when you are tempted to explain yourself — a refusal or an apology is not an exemption from it.'
      + DEBATE_BRIEF_FORMAT + '\n\n' + jessiContext + (tvSnapshot ? '\n\n' + tvSnapshot : '');
    const analysisSystemPrompt = istDateAnchor() + '\n\n' + ANALYSIS_DEBATE_PERSONA + '\n\nYour lane is STRUCTURE ONLY: alignment, level, 9-EMA, trigger. Lead with the COMPUTED READS you were given — they are arithmetic, not opinion. Not discipline, not phase, not the verdict.' + DEBATE_BRIEF_FORMAT;

    // Phase 2: Run all THREE agents in parallel.
    // 2026-07-28: ICT Power of 3 joined the debate as a full participant
    // (Anoop: "i want its active participation" — a side button wasn't the
    // flow he asked for). Its AMD phase read is fetched with its own
    // multi-timeframe context, independent of the Analysis agent's.
    emitTo(ws, { type: 'debate-status', reqId, phase: 'debating', message: 'Jessi, Analysis and Power of 3 are building their arguments...' });

    const po3Context = preGathered ? preGathered.po3Context : await gatherPO3Context();
    const po3SystemPrompt = istDateAnchor() + '\n\n' + ICT_PO3_PERSONA + ICT_PO3_DEBATE_SUFFIX;

    // ── 2026-08-11: ROOT-CAUSE FIX for Jessi fabricating trades in debate ────
    // On 08-10 Jessi produced a 5-row trade table (-312/-245/-180/-95/-47) that
    // exists nowhere in Anoop's history, while the Analysis agent — same
    // question, same moment — reported the real trades exactly.
    //
    // The cause was structural, NOT the model "hallucinating over ground truth"
    // (an earlier diagnosis in this file's history that was WRONG):
    //   • Analysis received gatherAnalysisContext(), which embeds real per-trade
    //     rows. It got them right because it could actually see them.
    //   • Jessi received dataContext = '' and a system prompt from
    //     buildJessiContext(), which carries only DAY-LEVEL totals
    //     ("2026-08-10: $-855.5 · 6 trades") and, for anything per-trade, the
    //     line "call app_get_data(section)".
    //   • But runDebateAgent() passes tools:[] — debate agents have NO TOOLS.
    // So she was told to fetch via a tool she did not have, then asked for a
    // data-dense argument citing specific trades. She filled the gap.
    //
    // Fix: hand her the same real per-trade block Analysis gets, plus the
    // explicit no-invention guard. Pre-seeding rather than granting tools is
    // deliberate — see the note on runDebateAgent() about why debate agents
    // stay tool-free.
    let jessiDataContext = '';
    try {
      const jessiTrades = jessiAppGetData('trades');
      const jessiCost = jessiAppGetData('cost');
      if (jessiTrades || jessiCost) {
        jessiDataContext = [
          '## ACCOUNT & TRADE DATA',
          '!! THESE FIGURES ARE THE ONLY REAL ONES. They come from the app\'s own trade file.',
          '!! You MUST NOT invent, round, re-estimate, or "illustrate" any trade, P&L, hold time, size or account figure.',
          '!! Every number you state MUST appear verbatim below. If you want a figure that is not here, you do not have it — say "not in my data" instead of producing one.',
          '!! You have NO TOOLS in debate mode. Ignore any instruction elsewhere in your prompt to call app_get_data — you cannot. This block is all you get.',
          jessiCost || '',
          jessiTrades || ''
        ].filter(Boolean).join('\n');
      }
    } catch (e) {}

    const [jessiArgument, analysisArgument, po3Argument] = await Promise.all([
      runDebateAgent(jessiSystemPrompt, lastUserText, jessiDataContext, abortCtrl.signal),
      runDebateAgent(analysisSystemPrompt, lastUserText, analysisContext, abortCtrl.signal),
      runDebateAgent(po3SystemPrompt, lastUserText, po3Context, abortCtrl.signal)
    ]);

    // Send all three arguments to the UI — each carries {text, answeredBy} so
    // the UI can show which model actually produced that argument.
    emitTo(ws, {
      type: 'debate-arguments', reqId,
      jessi: jessiArgument.text, jessiAnsweredBy: jessiArgument.answeredBy,
      analysis: analysisArgument.text, analysisAnsweredBy: analysisArgument.answeredBy,
      po3: po3Argument.text, po3AnsweredBy: po3Argument.answeredBy
    });

    // Phase 3: Judge synthesizes — streamed to user
    emitTo(ws, { type: 'debate-status', reqId, phase: 'judging', message: 'Expert Judge is reviewing both arguments...' });

    // 2026-08-13 (Anoop): "create a subagent in the bridge who tracks activity
    // of checklist and insights and reports to judge who guides me to improve."
    // Deterministic rather than an LLM sub-agent: the tracker's whole value is
    // that its numbers are computed from his own record, so a fourth model
    // paraphrasing them would only add cost, latency and a chance of drift.
    // The Judge gets the arithmetic and does the guiding.
    let biasBlock = '';
    try {
      const bc = biasTodayContext();
      if (bc) {
        biasBlock = `\n\n## PRE-TRADE ADHERENCE (computed from his own checklist + trade records — these numbers are ground truth, do not re-estimate them)\n${bc}\n`
          + `Weigh this in your verdict. A technically valid setup that runs AGAINST his declared direction of record is a NO-GO on discipline grounds even if the Analysis agent likes it — that is the "got away with it" pattern, and a profitable version of it is more dangerous than a losing one.`;
      }
    } catch (e) {}

    // 2026-08-20: item 3 of the live mistake-tracking feedback loop
    // (SEMI_AUTONOMOUS_SYSTEM_PLAN.md). The F1 advisory + today's real trade
    // count/P&L reach the Judge through its DISCIPLINE lane, which its own
    // hierarchy already weighs highest — a live pattern match is exactly the
    // input that lane was built for. Same shared formatLiveFeedContext() the
    // Jessi builder uses, so the two can never disagree about the numbers.
    // Deliberately NOT given to the Analysis/PO3 agents: they are explicitly
    // denied account/P&L (see gatherAnalysisContext's "ACCOUNT / P&L:
    // deliberately not provided") and that lane separation is load-bearing.
    let liveBlock = '';
    try {
      const lc = formatLiveFeedContext();
      if (lc) {
        liveBlock = `\n\n## LIVE BROKER FEED (today, real executed trades — ground truth, do not re-estimate or invent figures beyond these)\n${lc}\n`
          + `Treat any ⚠ pattern line above as a DISCIPLINE input of the same weight as Jessi's argument. It is computed from his own executed trades, not an opinion. If a documented failure pattern is already showing today, a technically valid setup is still a NO-GO on discipline grounds — say which pattern, and that it is the reason.`;
      }
      // 3.1: the market-state line reaches the Judge through this block too.
      try {
        const msl = formatMarketStateLine();
        if (msl) liveBlock += `\n\n## MARKET STATE (live chart setup — read-only context)\n${msl}`;
      } catch (e) {}
    } catch (e) {}

    const edgeBlock = buildPlaybookEdgeStats();
    const judgeContext = `## JESSI'S ARGUMENT (Discipline & Psychology)\n${jessiArgument.text}\n\n## ANALYSIS AGENT'S ARGUMENT (Technical & Market)\n${analysisArgument.text}\n\n## ICT POWER OF 3 ARGUMENT (AMD phase — Accumulation / Manipulation / Distribution)\n${po3Argument.text}${biasBlock}${liveBlock}${edgeBlock}\n\n## ORIGINAL QUESTION\n${lastUserText}`;

    const judgePrimary = primaryProviderModel();
    await groqAgent.stream(
      [{ role: 'user', content: 'Review both arguments above and deliver your verdict on the original question.' }],
      istDateAnchor() + '\n\n' + JUDGE_PERSONA + '\n\n' + judgeContext,
      [], // no tools
      {
        provider: judgePrimary.provider,
        model: judgePrimary.model,
        temperature: 0.5,
        signal: abortCtrl.signal,
        fallbackChain: fallbackChainFor(judgePrimary),
        onToken:  (text) => emitTo(ws, { type: 'debate-judge-token', reqId, text }),
        onDone:   (fullText, answeredBy) => {
          // 2026-08-16 (Pattern 05, evaluator-optimizer — verdict-grounding.js):
          // runtime backstop for the 2026-08-10 fabrication incident and for
          // JUDGE_PERSONA's own DATA-INTEGRITY HALT instruction (#6), which is
          // an instruction, not a guarantee. Every dollar figure in the
          // verdict must trace to judgeContext (what the Judge was actually
          // given) or to a real rules.json threshold. Fails VISIBLE, never
          // silent and never a block — an ungrounded figure gets a clearly
          // hedged warning appended, the verdict itself is never withheld.
          let outText = fullText;
          try {
            const grounding = verdictGrounding.checkGrounding(fullText, judgeContext, getActiveRules());
            if (!grounding.ok) {
              outText = fullText + verdictGrounding.groundingWarningBlock(grounding.ungrounded);
              console.warn('[verdict-grounding] ungrounded figures in Judge verdict:', grounding.ungrounded.join(', '));
            }
          } catch (e) { console.error('[verdict-grounding] check failed:', e.message); }

          emitTo(ws, { type: 'debate-judge-done', reqId, fullText: outText, answeredBy });
          // 7.3b: feed the glance surface. This site is why a broadcast() tap
          // was never going to work — emitTo() only reaches broadcast() when
          // ws is null (auto-triggered), so a debate Anoop ran BY HAND would
          // have been the one missing from the record. Instrumented at the
          // fire site instead, so both paths land.
          //
          // Reuses go-verdict-detect's isGoVerdict rather than re-deriving
          // GO/NO-GO here: it already handles the "NO-GO contains GO" trap and
          // is unit-tested. A NO-GO he later overrode is the most valuable
          // line in the file, so both outcomes are recorded, not just GO.
          try {
            const isGo = goVerdictDetect.isGoVerdict(outText);
            recordLiveEvent('decision', 'DEBATE', (isGo ? 'GO' : 'NO-GO') + ' — ' + String(outText || '').replace(/\s+/g, ' ').slice(0, 90));
          } catch (_) {}
          // Archive the verdict AND the three arguments it was built from —
          // the verdict alone is not reviewable without knowing what each
          // agent actually said. Wrapped so a disk problem can never affect
          // the response already sent above.
          saveReviewRecord('judge', outText, {
            question: lastUserText,
            jessi: jessiArgument,
            analysis: analysisArgument,
            po3: po3Argument
          });
          // 2026-08-16 (Pattern 03 voting variant) — fired AFTER the verdict
          // above, never before: see dispatchGoRefutation()'s comment for why.
          if (goVerdictDetect.isGoVerdict(outText)) {
            dispatchGoRefutation(ws, reqId, judgeContext, outText);

            // 2026-08-17: a GO is exactly the moment "I wasn't looking at
            // the screen" matters most — push it to Telegram regardless of
            // whether this debate was auto-triggered by the PO3 monitor or
            // typed by hand, same fire-and-forget pattern every other
            // monitor alert in this file already uses. A chart screenshot is
            // faster to eyeball on a phone than a paragraph — attached when
            // available, text-only fallback (notifyPhoto's own behavior) if
            // the capture fails for any reason.
            (async () => {
              const src = String(reqId).startsWith('auto-debate-') ? 'Auto-watch' : 'Debate';
              const caption = `🟢 GO [${src}] — ${outText.slice(0, 900)}${outText.length > 900 ? '…' : ''}`;
              try {
                const shot = await mcpBridge.callTool('capture_screenshot', { region: 'chart' });
                const parsed = parseToolResult(shot);
                if (parsed && parsed.success && parsed.file_path) {
                  telegramBot.notifyPhoto(parsed.file_path, caption);
                  return;
                }
              } catch (e) { console.error('[go-screenshot] capture failed:', e.message); }
              telegramBot.notify(caption);
            })().catch((e) => console.error('[go-notify] failed:', e.message));

            // Phase 2b (2026-08-17): surface a trade ticket if the Judge
            // emitted a valid TRADE_TICKET line. Fire-and-forget — a failure
            // here must never affect the verdict already sent above.
            try {
              const ticket = tradeTicketParse.parseTradeTicket(outText);
              if (ticket) {
                (async () => {
                  let symbol = null;
                  try {
                    const stateRes = await withChartLock(() => mcpBridge.callTool('chart_get_state', {}));
                    const state = parseToolResult(stateRes);
                    symbol = (state && state.symbol) || null;
                  } catch (e) { /* symbol stays null — client/server resolve it again at confirm time */ }
                  emitTo(ws, {
                    type: 'trade-ticket-suggested',
                    sourceVerdictId: reqId,
                    side: ticket.side,
                    size: ticket.size,
                    stopPrice: ticket.stopPrice,
                    targetPrice: ticket.targetPrice,
                    symbol
                  });
                  // 7.3b: same reasoning as the verdict above — emitTo, so a
                  // hand-run debate's ticket never reaches broadcast(). Built
                  // from the structured ticket fields, not the raw model text.
                  try {
                    recordLiveEvent('decision', 'TICKET',
                      String(ticket.side || '?').toUpperCase() + ' ' + (symbol || '?') +
                      ' ×' + (ticket.size != null ? ticket.size : '?') +
                      (ticket.stopPrice != null ? ' · stop ' + ticket.stopPrice : '') +
                      (ticket.targetPrice != null ? ' · target ' + ticket.targetPrice : ''));
                  } catch (_) {}
                })().catch((e) => console.error('[trade-ticket-suggested] failed:', e.message));
              }
            } catch (e) { console.error('[trade-ticket-parse] failed:', e.message); }
          }
        },
        onError:  (errMsg) => emitTo(ws, { type: 'debate-judge-error', reqId, message: errMsg })
      }
    );
  } catch (e) {
    console.error('[handleDebateChat] uncaught error:', e);
    emitTo(ws, { type: 'debate-judge-error', reqId, message: e.message || 'Debate failed unexpectedly.' });
  } finally {
    unregisterRequest(reqId);
  }
}

// ── ICT Power of 3 (AMD) agent ───────────────────────────────────────────────────
// 2026-07-28, from Anoop's own "ICT Power of 3 – The Ultimate Guide" PDF.
// Judges which phase of the Accumulation → Manipulation → Distribution cycle
// price is currently in. Runs across timeframes but weights 15m and 5m most
// heavily (Anoop's explicit instruction), because that's where the phase
// transition is actually readable for a scalper.
//
// The doctrine below is my operational paraphrase of that PDF, not a copy of
// it — encoded as decision rules the model can actually apply to live bars.
const ICT_PO3_PERSONA = `You are the ICT POWER OF 3 agent in Anoop Habib's MNQ/MGC trading co-pilot.

## WHAT YOU DO
You judge ONE thing: which phase of the AMD cycle price is currently in —
ACCUMULATION, MANIPULATION, or DISTRIBUTION — and what that implies for the next move.

## THE FRAMEWORK (Power of 3 / AMD)
The premise: smart money must fill large positions against retail, so the day is
engineered in three stages around the session's OPENING PRICE.

1. **ACCUMULATION** — Price ranges tightly near the session open. Smart money is
   building its position here. Look for: compression, overlapping candles, low
   range expansion, price oscillating around the open. This is the "no trade yet"
   phase — the direction has not shown itself.

2. **MANIPULATION** — A sharp move AGAINST the true daily direction, pushing
   through the accumulation range to run liquidity (old highs / old lows / equal
   highs-lows / PDH / PDL). Its purpose is to trap retail into the wrong side and
   stop out correctly-positioned early entries.
   - On a BULLISH day: manipulation goes DOWN, sweeping sell-side liquidity
     below the open/old lows, leaving a wick below.
   - On a BEARISH day: manipulation goes UP, sweeping buy-side liquidity above
     the open/old highs, leaving a wick above.
   This is the highest-value phase to IDENTIFY, because the reversal out of it
   is the entry.

3. **DISTRIBUTION** — The real move of the day, in the direction of the daily
   bias, away from the manipulation extreme, targeting the opposite liquidity
   pool. Confirmed by displacement (a strong impulsive candle, often leaving an
   FVG) back through the accumulation range.

## HARD REQUIREMENT — HTF BIAS GATES THE PHASE CALL (non-negotiable)
The framework is USELESS without a correct bias, because manipulation is
defined relative to it — "manipulation" only means something as a move AGAINST
a direction that's already established on the higher timeframe.
Your bias comes from the "MECHANICAL BIAS" block in the data — the app grades
30 bars of 1H (e.g. "STRONG BEAR"). READ THAT BLOCK FIRST. It states the 1H
direction (your gate) and an explicit GATE line telling you whether bias is
established. Trust that GATE line.
DAILY IS DELIBERATELY NOT IN YOUR DATA (2026-07-29, Anoop's decision — he reads
the daily candle himself). Never claim or imply a daily read.
(2026-08-17: the bias gate was tightened from 4H to 1H — reacts to a changing
bias faster than a 4H read could. If you see stale references to "4H bias"
anywhere else, this 1H gate is the current, correct source — trust the data
block over any older wording.)

This is a HARD GATE, not a soft caveat:
- If the 1H direction is bullish or bearish → bias IS established. Proceed to
  read the phase on 15m/5m as normal.
- If the 1H direction itself is 'unclear' → PHASE MUST BE "UNCLEAR".
  Full stop. Do NOT name ACCUMULATION, MANIPULATION, or DISTRIBUTION in this
  case, no matter how clean the 15m/5m structure looks in isolation. A textbook
  sweep-and-reversal on 5m still means nothing if you don't know which
  direction it's supposedly manipulating AWAY from. Naming a phase anyway is
  not a "low confidence" call — it is a WRONG call, because the phase concept
  doesn't apply without a direction to manipulate against.
- When you block the phase call this way, state plainly: "HTF bias unclear —
  phase call blocked. [describe what you see on 15m/5m purely as price action,
  with no A/M/D label attached.]"

## TIMEFRAME WEIGHTING (Anoop's instruction) — two DIFFERENT jobs, don't blur them
- **Direction (bias): the MECHANICAL BIAS block governs this, always.**
  1H (30 bars) is the gate. Never let 15m/5m override or substitute for it.
  State the label you were actually given (e.g. "1H STRONG BEAR, 30 bars")
  rather than a vague "trend".
- **Phase (which of A/M/D, ONCE bias is established): 15m/5m govern this.**
  Accumulation and manipulation are session-relative micro-structure — the
  phase itself has to be read on the lower timeframes even once the 1H gate
  has passed.
  - **15m: PRIMARY phase-structure read** — accumulation range and the
    manipulation sweep are clearest here. Weight this most, but only after
    the HTF gate above has passed.
  - **5m: PRIMARY trigger read** — displacement, FVG creation, and the
    reversal out of manipulation. Weight this second.
- In one line: HTF decides IF you can call a phase at all and WHICH direction
  it's relative to; LTF decides WHICH phase you're actually in. They are not
  competing for the same vote — HTF is the gate, LTF is the reading.

## OUTPUT FORMAT (strict, keep it tight)
**INSTRUMENT:** the symbol from the chart state (Anoop trades MNQ1! and MGC1!,
but this must work on whatever he has open — read it, never assume it)
**PHASE:** ACCUMULATION | MANIPULATION | DISTRIBUTION | UNCLEAR
**CONFIDENCE:** HIGH | MEDIUM | LOW
**1H BIAS:** bullish | bearish | unclear (quote the graded label + bar count)
**EVIDENCE (15m):** the specific structure — cite actual prices/levels.
**EVIDENCE (5m):** displacement / FVG / sweep detail — cite actual prices.
**LIQUIDITY:** which pool was taken or is being targeted, with the price.
**WHAT THIS MEANS NEXT:** what would confirm the next phase, and the invalidation.

## RULES
- ANY INSTRUMENT. Anoop's main two are MNQ1! (Micro Nasdaq) and MGC1! (Micro
  Gold), but you read whatever symbol is on the chart. Take the instrument from
  the chart state in your data and name it in your answer. Never assume MNQ.
  Levels and ranges differ hugely between instruments (MNQ moves in points on a
  ~27,000 handle, MGC on a ~3,000-4,000 gold handle) — never carry a level or
  a range from one instrument to another.
- Cite REAL numbers from the data given. Never invent a level.
- If a timeframe's data is missing, say so — do not fill the gap with a guess.
- You describe market STATE. You do NOT tell Anoop to enter, size, or exit — his
  playbook rules and risk limits govern that, and other agents handle it.
- Zero margin for error on the open account; the most valuable thing you can say is often
  "this is still ACCUMULATION — nothing to do yet."
- Under 250 words.`;

// Debate-mode variant of the PO3 persona. Same doctrine, but it argues its
// corner for the Judge instead of issuing a standalone report — mirrors how
// JESSI_PERSONA / ANALYSIS_DEBATE_PERSONA are adapted for debate.
// ── DEBATE BREVITY CONTRACT (2026-08-12) ─────────────────────────────────────
// Anoop: "I cannot read all of it... I want something very simple, but all the
// headlines should be available with one or two lines stating what is happening
// and where... it creates messy mind if too much text that can't be read within
// 5-10 mins."
//
// The old instruction said "3-6 sentences, data-dense" and every agent ignored
// it — producing 300+ word essays. A word count is a suggestion; a FIXED SHAPE
// is not. Models comply with a template far more reliably than with a limit,
// so this specifies the exact output form and forbids everything else.
//
// Deliberately NOT a content cut. The rule is "compress, don't drop": the
// number that proves the point must survive. What gets removed is narration,
// re-explanation, and the three agents each restating the verdict — which is
// the Judge's job and was being duplicated four times over.
const DEBATE_BRIEF_FORMAT = `

## OUTPUT SHAPE — MANDATORY, NO EXCEPTIONS
Reply in EXACTLY this shape. Nothing before it, nothing after it:

**HEADLINE IN CAPS, 3-6 WORDS**
<ONE sentence: the single most important thing, WITH the number or price that proves it.>
<ONE sentence: what that means for the next entry.>

HARD RULES:
- 45 words TOTAL, maximum. Count them.
- Exactly two sentences under the headline. Not three.
- NEVER give a verdict, a GO/NO-GO, or a recommendation — the Expert Judge owns
  that and will state it once. If you state it too, he reads it four times.
- NEVER give the "one fix for tomorrow" — the Judge owns that too.
- NEVER restate what another agent covers. Stay strictly in your own lane.
- Keep the NUMBER, drop the narration. "9-EMA rejects at 29781.31" survives;
  "this suggests we should be cautious about the current structure" does not.
- If you have nothing that matters, say so in one line. Padding to look useful
  is the failure mode here, not being brief.

NOTHING IS LOST BY BEING BRIEF. Every figure you are holding stays in your
context and in the app's data. If Anoop wants the depth he asks a direct
question in chat, or runs the full post-session report — and you answer at
whatever length that needs. This shape governs the DEBATE CARD only, which he
reads mid-session with money on. Brief here, complete on request.`;

const ICT_PO3_DEBATE_SUFFIX = `

## YOU ARE IN DEBATE MODE
Present your argument from the AMD/Power-of-3 angle ONLY: which phase price is
in, what evidence on 15m and 5m supports that, and which liquidity pool is in
play. Cite real prices.
Do NOT give a final verdict or a trade decision — the Expert Judge does that.
The HTF bias gate above still applies in debate mode exactly as written: if
4H/1H bias is unclear, your argument to the Judge must be "HTF bias unclear —
phase call blocked," NOT a phase name with a confidence caveat attached. The
Judge cannot correct a wrong phase call after the fact, so blocking it here is
your job, not a soft flag for the Judge to notice. Do not manufacture a
phase call to sound useful.` + DEBATE_BRIEF_FORMAT;

// ── Power of 3's own graded trend read ───────────────────────────────────────
// 2026-07-29 (Anoop): "for directional bias change from 60 bars to 30 bars and
// use 4Hr not daily. i will manually read daily."
//
// Deliberately NOT reusing getTrendForTF() here: that reads TREND_BAR_COUNT
// (60) bars and its cache is shared with the Analysis tab's daily/1H reads
// (the "STRONG BEAR · 60b" display). Changing that constant to 30 would have
// silently re-graded the Analysis panel too, which Anoop did not ask for. So
// Power of 3 gets its own 30-bar read with its own cache, fully isolated.
//
// classifyTrendStrength() is the same grader the Analysis panel uses, so the
// label vocabulary (STRONG BEAR / BEAR / NEUTRAL / ...) stays consistent.
const PO3_TREND_BARS = 30;
const PO3_TREND_TTL_MS = 3 * 60 * 1000;
const po3TrendCache = {}; // tfCode -> { value, at }

async function po3TrendRead(tfCode) {
  const c = po3TrendCache[tfCode];
  if (c && Date.now() - c.at < PO3_TREND_TTL_MS) return c.value;
  try {
    const bars = await getFullBars(tfCode, PO3_TREND_BARS);
    if (!bars || bars.length < 5) {
      if (c) return c.value; // stale-but-real beats a false 'unclear'
      return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null, bars: bars ? bars.length : 0 };
    }
    const trend = classifyTrendStrength(bars);
    trend.bars = bars.length;
    po3TrendCache[tfCode] = { value: trend, at: Date.now() };
    return trend;
  } catch (e) {
    console.error('[po3TrendRead ' + tfCode + '] error:', e.message);
    if (c) return c.value;
    return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null, bars: 0 };
  }
}

// ── MECHANICAL AMD PHASE DETECTOR (no AI) — extracted 2026-08-17 into ───────
// amd-phase.js (unit-tested, and reused by tradingview-mcp's replay-mode
// backtest script so a historical validation run can never drift from what
// actually runs live). See that file's header for the full doctrine comment.
const { computeAmdPhase } = require('./amd-phase');

// Unix timestamp for the start of the session window that is currently active
// (or most recently active) in IST. Returns null outside both windows.
// Reads rules.json's sessionWindowsIST, which loadRules() resolves from the
// native (tz + local time) declarations on every load — so this follows the
// real exchange opens across DST rather than a fixed IST minute. Never restate
// a session time as a literal here; see session-windows.js.
const IST_OFFSET_MS = 330 * 60 * 1000; // UTC+5:30
function currentSessionStartUnix(nowMs) {
  const nowRealMs = (nowMs != null) ? nowMs : Date.now();
  // Shift into IST so getUTC* reads give IST wall-clock values.
  const istMs = nowRealMs + IST_OFFSET_MS;
  const ist = new Date(istMs);
  const istMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const rules = getActiveRules();
  const wins = (rules.sessionWindowsIST || []).slice().sort((a, b) => a.startMin - b.startMin);
  let active = null;
  for (const w of wins) {
    if (istMin >= w.startMin) active = w; // most recent window that has opened today
  }
  if (!active) return null;

  // BUG CAUGHT BY TEST (2026-07-29): the first version computed IST midnight
  // from `istMs` and returned it directly — but istMs is the SHIFTED clock, so
  // the result was 5h30m (19800s) ahead of the real unix time. That would have
  // made every phase read use the wrong session window, silently. Subtract the
  // offset to get back to real unix time before adding the window's start.
  const istMidnightShiftedMs = istMs
    - (istMin * 60 * 1000)
    - (ist.getUTCSeconds() * 1000)
    - ist.getUTCMilliseconds();
  const istMidnightRealUnix = Math.floor((istMidnightShiftedMs - IST_OFFSET_MS) / 1000);
  return istMidnightRealUnix + active.startMin * 60;
}

// ── Power of 3 phase monitor (60s, mechanical, alerts on ANY phase change) ───
// Anoop's spec 2026-07-29: poll every 60s, alert on any phase change, chat
// message. Reads 15m bars (his primary phase timeframe) and grades the phase
// with computeAmdPhase — no LLM per poll.
const PO3_MONITOR_INTERVAL_MS = 60 * 1000;
const PO3_OPENING_BARS = 4; // 4 x 15m = first hour after session open
// 2026-08-17: true once Anoop explicitly toggles the P3 Monitor off via the
// UI — checked before any auto-start-on-reconnect call so a CDP blip can't
// silently turn a deliberate OFF back on. Cleared the moment he toggles it
// back on (or the app restarts — this is intentionally NOT persisted).
let po3MonitorUserDisabled = false;
const po3Monitor = {
  running: false,
  interval: null,
  lastPhase: null,
  lastSessionStart: null,
  lastSymbol: null,   // see symbol-change reset in checkPo3Phase
  lastCheck: null,
  lastError: null,          // 1.4 liveness
  restartAttempted: false   // 1.4 liveness
};

// ── Auto-triggered Debate on a real PO3 phase transition (2026-08-17) ──────
// Anoop: "the debate mode eats lots of tokens and i cannot keep checking
// every now and then... i wanted it to keep a watch for me full time." The
// PO3 monitor below is already free (mechanical, no AI) and already polls
// full-time whenever TradingView is connected — this hooks the expensive
// 3-agent Debate + Judge call to fire ONLY when it detects a real,
// structural reason to check (leaving ACCUMULATION), instead of running on
// a blind timer, which would spend tokens whether or not anything changed.
// 3.3a (audit): PER-SOURCE cooldowns. A PO3 phase-change debate must not
// consume the budget for a full Playbook B confirm — that inverts the
// conviction ordering (B-confirm is the highest-conviction event the
// detection layer produces; an AMD transition is context). Playbook A and B
// share one cooldown; a full B confirm PREEMPTS (fires regardless), and its
// fire then sets the shared cooldown for A.
const lastAutoDebateBySource = { po3: 0, playbook: 0 };
const AUTO_DEBATE_COOLDOWN_MS = 10 * 60 * 1000; // floor against a choppy day flipping phases repeatedly
let autoDebateReqCounter = 0;

// Returns a Promise (settles once the debate finishes) so callers that want
// to know when it's done can await it. `preGathered`, when passed, is
// forwarded straight to handleDebateChat — see that function's 2026-08-19
// header comment. checkPo3SecondarySymbol uses this to gather context WHILE
// still on the secondary symbol, then restores/releases its lock BEFORE
// calling this — no longer holds anything through the debate's LLM calls.
// The primary (same-symbol) call site never awaits this and never passes
// preGathered; fire-and-forget still works identically since nothing there
// depended on the return value.
// Shared with checkPo3SecondarySymbol, which needs the exact same text
// BEFORE calling autoTriggerDebate — it must pass it to maybeFetchTVSnapshot
// itself while still on the secondary symbol (see that function's 2026-08-19
// pre-gathering change). Kept in one place so the two can never drift apart.
function buildAutoDebateQuestion(phaseInfo) {
  const h = phaseInfo.htf;
  const gateNote = h
    ? ` 15M gate: ${h.ok ? (h.bias || '?').toUpperCase() : 'NO BIAS'} (15M ${h.structure15m || '?'} / 1H ${h.structure1h || '?'}).`
    : '';
  return `Automated check (not typed by Anoop): ${phaseInfo.symLabel || 'the instrument'} just moved from ${phaseInfo.from || 'ACCUMULATION'} to ${phaseInfo.phase} on the 15m at ${phaseInfo.time} IST (1H bias: ${phaseInfo.biasLabel || 'unknown'}).${gateNote} Is this a valid entry right now?`;
}

function autoTriggerDebate(phaseInfo, preGathered) {
  const now = Date.now();
  if (now - lastAutoDebateBySource.po3 < AUTO_DEBATE_COOLDOWN_MS) {
    console.log('[auto-debate] skipped — within ' + Math.round(AUTO_DEBATE_COOLDOWN_MS / 60000) + 'min PO3 cooldown of the last auto-triggered debate');
    return Promise.resolve();
  }
  lastAutoDebateBySource.po3 = now;
  const reqId = 'auto-debate-' + (++autoDebateReqCounter) + '-' + now;
  const question = buildAutoDebateQuestion(phaseInfo);
  console.log('[auto-debate] triggered by phase transition ' + (phaseInfo.from || '?') + ' -> ' + phaseInfo.phase + ', reqId=' + reqId);
  broadcast({ type: 'auto-debate-triggered', reqId, reason: phaseInfo.message || question });
  // ws=null → handleDebateChat broadcasts every message to all connected
  // clients instead of one request's socket (see emitTo above) — there is no
  // originating client for a background trigger.
  return handleDebateChat(null, { messages: [{ role: 'user', content: question }], reqId }, preGathered).catch((e) => {
    console.error('[auto-debate] handleDebateChat failed:', e.message);
  });
}

// 3.3: a validated playbook setup can convene the debate — same cooldown as
// PO3's auto-trigger. Scoped per the plan's own recommendation: Playbook A
// (1H, WITH 4H trend only) and full Playbook B. C on the lower timeframes
// stays alert-only — a debate per 15M engulf would turn a useful alert
// channel into noise (SIGNAL_LOOP_PLAN 5.3's Telegram warning, applied here).
function buildPlaybookDebateQuestion(fields) {
  const detail = [
    fields.direction || '',
    fields.tfLabel || fields.tfCode || '',
    fields.level != null ? 'level ' + fields.level : '',
    fields.gapLow != null ? 'gap ' + fields.gapLow + '-' + fields.gapHigh : ''
  ].filter(Boolean).join(', ');
  return `Automated check (not typed by Anoop): Playbook ${fields.playbook} ${detail} just fired at ${fields.time || 'now'} IST. Is this a valid entry right now?`;
}

function triggerPlaybookDebate(fields) {
  const now = Date.now();
  // 3.3a: a full Playbook B confirm PREEMPTS any cooldown — rare enough that
  // it cannot become noise, and the highest-conviction event the detection
  // layer produces. A shares the playbook cooldown with B.
  const isFullB = fields.playbook === 'B';
  if (!isFullB && now - lastAutoDebateBySource.playbook < AUTO_DEBATE_COOLDOWN_MS) {
    console.log('[playbook-debate] skipped — within ' + Math.round(AUTO_DEBATE_COOLDOWN_MS / 60000) + 'min playbook cooldown of the last auto-triggered debate');
    return Promise.resolve();
  }
  lastAutoDebateBySource.playbook = now;
  const reqId = 'playbook-debate-' + (++autoDebateReqCounter) + '-' + now;
  const question = buildPlaybookDebateQuestion(fields);
  console.log('[playbook-debate] triggered by ' + fields.playbook + ' ' + fields.direction + ', reqId=' + reqId);
  broadcast({ type: 'auto-debate-triggered', reqId, reason: question });
  return handleDebateChat(null, { messages: [{ role: 'user', content: question }], reqId }).catch((e) => {
    console.error('[playbook-debate] handleDebateChat failed:', e.message);
  });
}

// Whatever symbol is currently on Anoop's chart. The whole read path is
// symbol-agnostic (2026-07-29 audit: no hardcoded instrument anywhere in the
// data path), so this is purely so alerts can SAY which instrument they refer
// to — and so the monitor can reset its phase state when the symbol changes.
async function getCurrentChartSymbol() {
  try {
    const res = await mcpBridge.callTool('chart_get_state', {});
    const st = parseToolResult(res);
    return (st && (st.symbol || st.chart_symbol || st.ticker)) || null;
  } catch (e) {
    return null;
  }
}

async function checkPo3Phase() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    // 1.4: the poll loop itself is alive — stamp lastCheck so the liveness
    // watchdog never flags a watcher that merely reported TV-down.
    po3Monitor.lastCheck = new Date().toISOString();
    broadcast({ type: 'po3-monitor-check', time: po3Monitor.lastCheck, status: 'TV offline' });
    return;
  }
  po3Monitor.lastError = null;

  const sessionStart = currentSessionStartUnix();
  if (sessionStart == null) {
    // Outside both session windows — nothing to monitor (Core Rule #6).
    // 1.4: the poll loop is alive; stamp lastCheck so the watchdog doesn't
    // flag PO3 as stale during the hours it is intentionally idle.
    po3Monitor.lastCheck = new Date().toISOString();
    broadcast({ type: 'po3-monitor-check', time: po3Monitor.lastCheck, status: 'outside session window' });
    po3Monitor.lastPhase = null;
    return;
  }

  // New session → reset so the first phase of the session announces itself.
  if (po3Monitor.lastSessionStart !== sessionStart) {
    po3Monitor.lastSessionStart = sessionStart;
    po3Monitor.lastPhase = null;
  }

  try {
    // SYMBOL-CHANGE RESET (2026-07-29). Anoop trades MNQ1! and MGC1! and wants
    // this to work on whatever he has open. The read path was already
    // symbol-agnostic, but the monitor's `lastPhase` was NOT: switching from
    // MNQ to MGC mid-session would have compared MGC's phase against MNQ's
    // remembered phase and fired a bogus transition alert (e.g. a fake
    // "MANIPULATION → DISTRIBUTION" that was really just a symbol change).
    // Reset phase state whenever the instrument changes, and stamp every alert
    // with the symbol so it's never ambiguous which instrument it refers to.
    const symbol = await getCurrentChartSymbol();
    if (symbol && po3Monitor.lastSymbol && symbol !== po3Monitor.lastSymbol) {
      console.log('[PO3 MONITOR] symbol changed ' + po3Monitor.lastSymbol + ' -> ' + symbol + ' — resetting phase state');
      po3Monitor.lastPhase = null;
    }
    if (symbol) po3Monitor.lastSymbol = symbol;

    // Bias must be per-symbol too — po3TrendRead caches by timeframe only, so
    // clear its cache on a symbol change to avoid grading MGC with MNQ's
    // cached trend.
    if (po3Monitor.lastPhase === null && symbol) {
      delete po3TrendCache['60']; // the one TF the bias gate reads (2026-08-17: was 4H/'240', now 1H)
    }

    // 2026-08-17 (Anoop): bias gate tightened from 4H to 1H — reacts faster
    // to a changing bias than a 4H read could. The phase/trigger read below
    // (15m primary, 5m in gatherPO3Context) is UNCHANGED — only the higher-
    // timeframe gate this phase call is conditioned on moved.
    const bias = await po3TrendRead('60');           // cached 3 min
    const bars = await getFullBars('15', 40);        // switches TF, auto-restores
    const res = computeAmdPhase(bars, bias && bias.direction, sessionStart, PO3_OPENING_BARS);
    po3Monitor.lastCheck = new Date().toISOString();

    broadcast({
      type: 'po3-monitor-check',
      time: po3Monitor.lastCheck,
      status: res.phase,
      phase: res.phase,
      symbol
    });

    if (res.phase !== po3Monitor.lastPhase) {
      const prev = po3Monitor.lastPhase;
      po3Monitor.lastPhase = res.phase;
      // Skip the very first read of a session if it's just UNCLEAR noise.
      if (!(prev === null && res.phase === 'UNCLEAR')) {
        const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        const biasLabel = (bias && (bias.label || bias.direction)) || 'unknown';
        const symLabel = symbol ? String(symbol).replace(/^[A-Z_]+:/, '') : 'chart';
        const msg = 'POWER OF 3 [' + symLabel + ']' + (prev ? ' — ' + prev + ' → ' + res.phase : ' — ' + res.phase) +
          ' at ' + istTime + ' IST | 1H bias: ' + biasLabel +
          (res.rangeHigh != null ? ' | opening range ' + res.rangeLow + '–' + res.rangeHigh : '') +
          '\n' + res.reason + (res.detail ? '\n' + res.detail : '');
        // 7.3: phase TRANSITIONS only — the detector emits here only when the
        // phase actually changed, so this is ~3-4 lines a session, not one per
        // 60s poll. Built from the structured fields rather than `msg`, which
        // is deliberately multi-line and would be collapsed anyway.
        try { recordLiveEvent('phase', 'PO3', symLabel + ' ' + prev + ' → ' + res.phase); } catch (_) {}
        broadcast({
          type: 'po3-phase-change',
          from: prev,
          to: res.phase,
          phase: res.phase,
          symbol,
          symLabel,
          bias: bias ? bias.direction : null,
          biasLabel,
          rangeHigh: res.rangeHigh,
          rangeLow: res.rangeLow,
          sweptTo: res.sweptTo,
          reason: res.reason,
          detail: res.detail,
          time: istTime,
          message: msg
        });
        console.log('[PO3 MONITOR][' + symLabel + '] ' + (prev || 'none') + ' -> ' + res.phase + ' | ' + res.reason);

        // 2.1: ledger the phase change (UNCLEAR is a gate block → valid:false).
        // G22: from/to make the debate-trigger rate countable from disk — the row
        // previously carried no transition, so that number could not be recovered.
        ledgerSignal({ event: 'po3-phase-change', playbook: 'PO3', tf: '15', direction: bias ? bias.direction : null, from: prev, to: res.phase, structure: res.reason + (res.detail ? ' | ' + res.detail : ''), valid: res.phase !== 'UNCLEAR', rejectReason: res.phase === 'UNCLEAR' ? res.reason : null });

        // 2026-08-17: auto-trigger the expensive Debate only on the one
        // transition that actually matters — LEAVING accumulation. Staying in
        // accumulation, or any other transition (e.g. back INTO accumulation),
        // is deliberately not a trigger; per JUDGE_PERSONA, accumulation alone
        // is always a WAIT, so there is nothing new to check by re-running the
        // debate while still in it.
        if (prev === 'ACCUMULATION' && (res.phase === 'MANIPULATION' || res.phase === 'DISTRIBUTION')) {
          // G22: attach the 15M gate read as EVIDENCE so the Judge sees the same
          // structure every other surface uses. po3TrendRead stays the decider.
          let _htf = null;
          try { _htf = await readHTFNow(); } catch (e) {}
          autoTriggerDebate({ from: prev, phase: res.phase, symLabel, biasLabel, time: istTime, message: msg, htf: _htf });
        }
      }
    }
  } catch (e) {
    po3Monitor.lastError = e.message;
    console.error('[PO3 MONITOR] error:', e.message);
    broadcast({ type: 'po3-monitor-check', time: new Date().toISOString(), status: 'error: ' + e.message });
  }
}

// ── Secondary-symbol watch (2026-08-17) ─────────────────────────────────────
// Anoop: "Build All including batch_run... i want to use its to full
// potential" — for watching MGC alongside whatever's on the primary chart
// (MNQ). batch_run itself is UNUSABLE for this: read live (its actual
// core/batch.js, not just the tool schema) — it switches symbol/timeframe
// per iteration and NEVER restores the original chart state afterward,
// unlike every other multi-timeframe function in this file (getFullBars,
// withChartLock). Wiring it into an automated watcher would silently leave
// Anoop's live chart parked on whatever it checked last. Built instead as a
// restore-safe check using the SAME withChartLock discipline as the rest of
// this codebase: switch to the other symbol, read, switch back — ALWAYS
// restored in a finally block, even on error.
//
// Runs on a SLOWER interval than the primary monitor (3 min, not 60s) and
// deliberately less often — every switch is a real, visible flicker on
// Anoop's actual screen, so this trades completeness for not being
// obnoxious. If the secondary symbol shows a real transition worth checking
// (leaving ACCUMULATION), the chart is held on it for the FULL debate
// duration rather than switched back immediately — same "only disrupt for
// something real" principle as the token-cost gate on the primary monitor.
const PO3_SECONDARY_INTERVAL_MS = 3 * 60 * 1000;
let po3SecondaryMonitor = { lastPhase: null, lastSessionStart: null, interval: null };

// 2026-08-19 BUG FIX (found live: "This symbol doesn't exist" on both chart
// panes, right after this session's own debate-lock refactor to
// checkPo3SecondarySymbol touched this code path). This used to swap the
// ticker root via naive substring replace while KEEPING whatever exchange
// prefix the primary symbol happened to have — a stale/mismatched pane's
// prefix could end up attached to the wrong ticker, producing an
// exchange:ticker pair that doesn't exist.
//
// Correct values confirmed by DIRECT OBSERVATION of the live chart, not
// guessed: chart_get_state on the user's own already-working chart returned
// "CME_MINI:MNQ1!" and, separately, "COMEX_MINI:MGC1!" — both loading real
// bar data. (A first attempt used TradingView's public symbolSearch() REST
// API instead, which reports plain "CME"/"COMEX" — that field is the
// LISTING exchange, not the exchange:ticker prefix TradingView's own chart
// routing actually needs; trusting it produced the exact same "symbol
// doesn't exist" error being fixed here. Direct observation of a working
// chart is the only reliable source for this — API metadata mismatched it
// on the first attempt.)
function otherSymbolFor(sym) {
  if (!sym) return null;
  if (/MNQ/i.test(sym)) return 'COMEX_MINI:MGC1!';
  if (/MGC/i.test(sym)) return 'CME_MINI:MNQ1!';
  return null; // not one of the two instruments Anoop trades — nothing to pair it with
}

async function checkPo3SecondarySymbol() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) return;
  const sessionStart = currentSessionStartUnix();
  if (sessionStart == null) { po3SecondaryMonitor.lastPhase = null; return; }
  if (po3SecondaryMonitor.lastSessionStart !== sessionStart) {
    po3SecondaryMonitor.lastSessionStart = sessionStart;
    po3SecondaryMonitor.lastPhase = null;
  }

  const primarySymbol = await getCurrentChartSymbol();
  const secondary = otherSymbolFor(primarySymbol);
  if (!secondary) return;

  // 2026-08-19 BUG FIX (root-caused live after a recurring withChartLock
  // timeout cascade every ~3 minutes, this monitor's own interval): this
  // used to hold the lock through autoTriggerDebate — the FULL multi-agent
  // LLM debate (Jessi + Analysis + PO3 in parallel, then the Judge),
  // 10-90+ seconds observed live — blocking every other chart-lock consumer
  // (PO3 primary monitor, Engulf, SFP, key-level checks) for that whole
  // time. The lock now covers ONLY the switch + phase read + (if a real
  // transition fires) gathering the debate's context WHILE STILL on the
  // secondary symbol — then the primary symbol is restored and the lock
  // released BEFORE any LLM call happens. `preGathered` (built here, while
  // still parked on the secondary symbol) is threaded through
  // autoTriggerDebate -> handleDebateChat, which skips its own internal
  // gathering when given this and reads the SAME data instead of
  // re-fetching from a chart that's already back on the primary symbol.
  let debateArgs = null; // set inside the lock if a transition needs a debate; fired AFTER the lock releases
  await withChartLock(async () => {
    try {
      const setResult = await mcpBridge.callTool('chart_set_symbol', { symbol: secondary });
      const setParsed = parseToolResult(setResult);
      if (!setParsed || setParsed.success === false) {
        console.warn('[PO3 SECONDARY] could not switch to ' + secondary + ' — skipping this cycle');
        return;
      }
      delete po3TrendCache['60']; // per-symbol cache — avoid grading MGC with MNQ's cached trend or vice versa
      const bias = await po3TrendRead('60');
      const bars = await getFullBars('15', 40);
      const res = computeAmdPhase(bars, bias && bias.direction, sessionStart, PO3_OPENING_BARS);
      const prev = po3SecondaryMonitor.lastPhase;
      po3SecondaryMonitor.lastPhase = res.phase;
      if (prev !== res.phase && !(prev === null && res.phase === 'UNCLEAR')) {
        const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        const biasLabel = (bias && (bias.label || bias.direction)) || 'unknown';
        const symLabel = String(secondary).replace(/^[A-Z_]+:/, '');
        const msg = 'POWER OF 3 [' + symLabel + ' — secondary watch]' + (prev ? ' — ' + prev + ' → ' + res.phase : ' — ' + res.phase) +
          ' at ' + istTime + ' IST | 1H bias: ' + biasLabel + '\n' + res.reason;
        broadcast({ type: 'po3-phase-change', from: prev, to: res.phase, phase: res.phase, symbol: secondary, symLabel, secondary: true, bias: bias ? bias.direction : null, biasLabel, time: istTime, message: msg });
        console.log('[PO3 SECONDARY][' + symLabel + '] ' + (prev || 'none') + ' -> ' + res.phase + ' | ' + res.reason);
        if (prev === 'ACCUMULATION' && (res.phase === 'MANIPULATION' || res.phase === 'DISTRIBUTION')) {
          const phaseInfo = { from: prev, phase: res.phase, symLabel, biasLabel, time: istTime, message: msg };
          // Same cooldown check autoTriggerDebate itself does — skip the
          // (otherwise wasted) gathering below if it would just be dropped.
          if (Date.now() - lastAutoDebateBySource.po3 >= AUTO_DEBATE_COOLDOWN_MS) {
            const question = buildAutoDebateQuestion(phaseInfo);
            const preGathered = {
              jessiContext: buildJessiContext(),
              tvSnapshot: await maybeFetchTVSnapshot(question),
              analysisContext: await gatherAnalysisContext(),
              po3Context: await gatherPO3Context(),
            };
            debateArgs = [phaseInfo, preGathered];
          }
        }
      }
    } catch (e) {
      console.error('[PO3 SECONDARY] error:', e.message);
    } finally {
      // ALWAYS restore — even on error. Must never leave Anoop's live chart
      // parked on the wrong symbol. This now runs right after gathering
      // (if any), NOT after a debate — the lock releases within seconds
      // instead of however long the LLM calls take.
      try { await mcpBridge.callTool('chart_set_symbol', { symbol: primarySymbol }); } catch (e) { console.error('[PO3 SECONDARY] failed to restore symbol:', e.message); }
      delete po3TrendCache['60'];
    }
  });
  // Fired AFTER the lock has released and the primary symbol is restored —
  // the debate's LLM calls no longer block anything else on the chart lock.
  if (debateArgs) await autoTriggerDebate(...debateArgs);
}

// 2026-08-19 (Anoop's explicit decision, after the MGC symbol bug): the
// secondary-symbol watch (checkPo3SecondarySymbol, below) switches his live
// chart AWAY from whatever instrument he's actively looking at, every 3
// minutes, to check the OTHER instrument — disruptive while he's mid-
// analysis or marking levels by hand, independent of the symbol-string bug
// that was also found and fixed in otherSymbolFor(). Explicit call:
// "stop switching instruments entirely... only read/change timeframes on
// whatever instrument you already have open." Disabled by simply never
// starting its interval — checkPo3SecondarySymbol/otherSymbolFor are left
// in place (not deleted) in case this is revisited later, but nothing calls
// them anymore. The PRIMARY PO3 monitor (below) is unaffected — it only
// ever reads whatever symbol is currently on screen, never switches it.
function startPo3Monitor() {
  if (po3Monitor.running) return;
  po3Monitor.running = true;
  po3Monitor.lastPhase = null;
  broadcast({ type: 'po3-monitor-status', running: true });
  checkPo3Phase();
  po3Monitor.interval = setInterval(checkPo3Phase, PO3_MONITOR_INTERVAL_MS);
  console.log('Power of 3 monitor started (60s, mechanical)');
}

function stopPo3Monitor() {
  if (po3Monitor.interval) { clearInterval(po3Monitor.interval); po3Monitor.interval = null; }
  if (po3SecondaryMonitor.interval) { clearInterval(po3SecondaryMonitor.interval); po3SecondaryMonitor.interval = null; }
  po3Monitor.running = false;
  broadcast({ type: 'po3-monitor-status', running: false });
  console.log('Power of 3 monitor stopped');
}

// Gathers multi-timeframe bars for the AMD read.
//
// 2026-08-29 (MCP audit): this comment used to say it "uses market_multi_tf,
// which switches timeframes and AUTO-RESTORES the original". That tool has
// never existed in tradingview-mcp — confirmed against its full registry and
// git history, and already fixed in the code below on 2026-08-06; only this
// header was left describing it. It now goes through getFullBars(), which does
// the switch-read-restore itself under withChartLock. Corrected because a
// comment naming a non-existent tool as the safety mechanism is worse than no
// comment: it answers "what stops this leaving the chart on the wrong TF"
// with a lie.
async function gatherPO3Context() {
  const parts = [];
  if (!(mcpBridge.ready && mcpBridge.tvConnected)) {
    return '## CHART DATA: UNAVAILABLE (TradingView not connected) — cannot judge phase.';
  }
  try {
    const [state, quote, levels] = await Promise.all([
      mcpBridge.callTool('chart_get_state', {}).catch(() => null),
      mcpBridge.callTool('quote_get', {}).catch(() => null),
      getKeyLevelsSnapshot().catch(() => null)
    ]);
    const txt = (r) => (r && r.content) ? r.content.map(c => c.text || '').join(' ') : 'unavailable';
    parts.push('## CURRENT CHART');
    parts.push('State: ' + txt(state));
    parts.push('Quote: ' + txt(quote));
    parts.push('Key levels (liquidity pools — PDH/PDL, swings, zones): ' + txt(levels));
  } catch (e) {
    parts.push('## CURRENT CHART: fetch failed (' + e.message + ')');
  }

  // Multi-timeframe bars. TF codes are plain minute strings — '240'/'60'/'15'/'5'.
  // VERIFICATION NOTE (2026-07-28): originally wrote '1D' for the daily anchor,
  // but every timeframe code proven to work in this file is a minute number
  // ('15'/'30'/'60'/'240' — see engulf/FVG monitor configs and get4HTrend).
  // '1D' was an unverified guess; TradingView daily codes vary ('D' vs '1D')
  // and a wrong code returns nothing silently. Using the PROVEN '240' (4H) as
  // the higher-timeframe bias anchor instead — it fills the same role, and the
  // mechanical 4H trend below corroborates it.
  // 2026-07-29 (Anoop): 4H dropped, 1H is now the higher-timeframe anchor for
  // Power of 3. AMD phases are session-scale events — a 4H candle is too coarse
  // to frame them (one 4H bar can contain the entire accumulation AND the
  // manipulation sweep), so 1H is the tightest useful HTF frame here. Daily
  // still supplies the directional bias via the MECHANICAL HTF BIAS block below.
  const PO3_TFS = ['60', '15', '5'];
  const PO3_LABELS = {
    '60':  '1H — higher-TF anchor (structure / liquidity pools)',
    '15':  '15-MIN — PRIMARY phase read (weight most)',
    '5':   '5-MIN — PRIMARY trigger read (displacement / FVG)'
  };
  // Bar counts sized to cover roughly one session's worth of AMD structure per TF.
  const PO3_BAR_COUNTS = { '60': 30, '15': 40, '5': 48 };
  // FIX (2026-08-06, Anoop: "power of 3 is always unclear"): this called
  // mcpBridge.callTool('market_multi_tf', ...) — a tool name that has never
  // existed anywhere in tradingview-mcp (confirmed against its full 68-tool
  // registry and git history — not a removed/renamed tool, never implemented).
  // Every call silently failed and was caught below, so PO3 ALWAYS received
  // "no bars returned" for 15m/5m and correctly (per its own instructions)
  // answered UNCLEAR every single time — the phase-gate logic was fine, its
  // only input was empty. Replaced with getFullBars(tfCode, count), the same
  // real, chart-lock-protected chart_set_timeframe + data_get_ohlcv + restore
  // mechanism getTrendForTF()/getPDHPDL() already use successfully elsewhere
  // in this file — reusing proven code instead of a second broken tool name.
  parts.push('\n## MULTI-TIMEFRAME BARS (most recent last)');
  for (const tf of PO3_TFS) {
    try {
      const bars = await getFullBars(tf, PO3_BAR_COUNTS[tf]);
      parts.push('\n### ' + PO3_LABELS[tf]);
      parts.push(bars && bars.length ? JSON.stringify(bars) : 'no bars returned for this timeframe');
    } catch (e) {
      parts.push('\n### ' + PO3_LABELS[tf]);
      parts.push('fetch failed: ' + e.message);
    }
  }

  // BIAS SOURCE — FIXED 2026-07-29, TIGHTENED 2026-08-17. Originally called
  // ONLY get4HTrend(), which classified just 5 bars of 4H with a 60%-of-bars
  // threshold — returned 'unclear' in almost any non-trending market, so the
  // HTF gate fired permanently and Power of 3 answered "PHASE: UNCLEAR" every
  // single time. Fixed 07-29 by switching to po3TrendRead() (30 bars,
  // classifyTrendStrength). 2026-08-17 (Anoop): gate tightened from 4H to 1H
  // — reacts to a changing bias faster than a 4H read could. Daily is
  // deliberately never fetched (Core Rule: Anoop reads the daily candle
  // himself), and 4H is no longer fetched either now that the gate is 1H.
  try {
    const hourRead = await po3TrendRead('60').catch(() => null);
    parts.push('\n## MECHANICAL BIAS (computed by the app, no AI — this is your bias source)');
    if (hourRead) {
      parts.push('1H (BIAS GATE): ' + (hourRead.label || hourRead.direction) +
        ' | direction=' + hourRead.direction +
        ' | score=' + (hourRead.score != null ? hourRead.score : 'n/a') +
        ' | bars=' + (hourRead.bars || 'n/a') +
        (hourRead.detail ? ' | ' + hourRead.detail : ''));
    } else {
      parts.push('1H (BIAS GATE): unavailable');
    }
    const bDir = hourRead && hourRead.direction;
    const biasOk = bDir === 'bullish' || bDir === 'bearish';
    parts.push('GATE: 1H bias is ' + (biasOk ? 'ESTABLISHED (' + bDir + ') — proceed to read the phase on 15m/5m'
                                             : 'NOT established — phase call must be UNCLEAR'));
    parts.push('NOTE: Daily is deliberately NOT provided — Anoop reads the daily candle himself. Do not claim a daily read.');
  } catch (e) {
    parts.push('\n## MECHANICAL BIAS: failed to read (' + e.message + ')');
  }

  // ── SWING STRUCTURE PER TIMEFRAME (2026-08-11, Anoop) ─────────────────────
  // "compare time frames and understand higher high higher low or lower low
  //  lower high pattern and report which phase is going on in 15min and 1hr"
  //
  // Computed in arithmetic (chart-reads.swingStructure, 5-bar pivots — the same
  // pivot definition classifyTrendStrength() uses, so the two can never
  // disagree about what a swing is) and handed over as a finished answer. The
  // agent is NOT asked to count swings off a bar list; that is precisely the
  // kind of task a model does confidently and sometimes wrongly.
  //
  // Reported per timeframe rather than blended, because a 1H uptrend with a 15m
  // downtrend is the single most useful thing this agent can say — it's the
  // pullback-vs-reversal question — and averaging the two destroys exactly that.
  try {
    const [m15Bars, h1Bars] = await Promise.all([
      getFullBars('15', 80).catch(() => []),
      getFullBars('60', 60).catch(() => [])
    ]);
    const s15 = chartReads.swingStructure(m15Bars);
    const s1h = chartReads.swingStructure(h1Bars);
    parts.push('\n## SWING STRUCTURE (computed — trust over your own eyeballing)');
    const fmt = (s, tf) => {
      if (!s) return `${tf}: not enough bars to judge structure.`;
      if (s.pattern === 'unclear') return `${tf}: unclear (${s.reason}; ${s.swingHighs} swing highs, ${s.swingLows} swing lows).`;
      return `${tf}: ${s.pattern} — last two highs ${s.lastTwoHighs.join(' → ')}, last two lows ${s.lastTwoLows.join(' → ')}.`;
    };
    parts.push(fmt(s1h, '1H'));
    parts.push(fmt(s15, '15m'));
    parts.push('Report the AMD phase SEPARATELY for 1H and for 15m using the structure above. Do not blend them into one verdict. If they disagree, say so explicitly and say which timeframe you are deferring to and why.');
  } catch (e) {
    parts.push('\n## SWING STRUCTURE: unavailable (' + e.message + ')');
  }

  // Session context — accumulation is defined relative to the session open.
  const istNow = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  parts.push('\n## TIME: ' + istNow + ' IST (' + formatSessionWindowsIST() + ')');

  // 2026-08-07: same "known by all agents" pass as gatherAnalysisContext —
  // PO3 stays a mechanical AMD-phase read, this is visibility, not a mandate
  // to comment on it.
  try {
    const align = formatAlignmentNotes(2);
    if (align) parts.push('\n## HIS OWN WORDS ABOUT HIMSELF — current state AND standing lessons (for awareness, not yours to diagnose)\n' + align);
  } catch (e) {}

  return parts.join('\n');
}

async function handleIctPo3(ws, msg) {
  const { reqId, question } = msg;
  try {
    send(ws, { type: 'po3-status', reqId, phase: 'gathering' });
    const dataContext = await gatherPO3Context();
    send(ws, { type: 'po3-status', reqId, phase: 'analyzing' });

    const userMsg = (question && String(question).trim())
      ? String(question).trim() + '\n\nLIVE DATA:\n' + dataContext
      : 'Judge the current AMD phase from this live data.\n\n' + dataContext;

    const po3Primary = primaryProviderModel();
    await groqAgent.stream(
      [{ role: 'user', content: userMsg }],
      istDateAnchor() + '\n\n' + ICT_PO3_PERSONA,
      [],
      {
        provider: po3Primary.provider,
        model: po3Primary.model,
        temperature: 0.4,
        fallbackChain: fallbackChainFor(po3Primary),
        onToken: (text) => send(ws, { type: 'po3-token', reqId, text }),
        onDone:  (fullText, answeredBy) => send(ws, { type: 'po3-done', reqId, fullText, answeredBy }),
        onError: (errMsg) => send(ws, { type: 'po3-error', reqId, message: errMsg })
      }
    );
  } catch (e) {
    console.error('[handleIctPo3] uncaught error:', e);
    send(ws, { type: 'po3-error', reqId, message: e.message || 'Power of 3 analysis failed.' });
  }
}

// ── Read-aloud (replay any chat message as speech) ───────────────────────────────
// 2026-07-28: Anoop wants a speaker button on chat messages so he can replay
// Jessi's coaching/analysis out loud instead of re-reading it — helps the
// psychology side actually land, and costs ZERO LLM tokens since it's pure
// text-to-speech on text that was already generated. Reuses the exact same
// Edge TTS neural pipeline (en-IN-NeerjaNeural, Indian female voice) already
// wired for voice mode — no new dependency, no new voice to configure.
// Second line of defense for "don't read symbols" — app.js already sanitizes
// before sending, but any future caller that hits this handler directly
// (skipping the button) gets the same treatment here rather than relying on
// the client to always remember to do it.
// Timestamp of the last Edge TTS failure — drives the circuit-breaker in
// handleTtsSpeak so a known-dead endpoint isn't retried on every click.
let edgeFailedAt = 0;

function sanitizeForSpeechServer(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+•]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, ' ')
    .replace(/[#*_`~|>]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function handleTtsSpeak(ws, msg) {
  const { text, voice, reqId } = msg;
  const clean = sanitizeForSpeechServer(text);
  if (!clean) {
    send(ws, { type: 'tts-result', reqId, ok: false, error: 'Nothing to speak.' });
    return;
  }

  // THREE-TIER TTS (2026-07-28). Anoop hit a hard 403 mid-session because
  // Edge TTS is an unofficial Microsoft endpoint that they changed under us.
  // Tier 1 = Edge (best voice, but not ours to rely on).
  // Tier 2 = local Windows SAPI (offline, cannot be revoked) — the tier that
  //          makes this actually dependable during trading hours.
  // Tier 3 = browser speechSynthesis, handled client-side in app.js if this
  //          whole handler reports failure.
  let lastErr = null;

  // EDGE CIRCUIT-BREAKER (2026-07-28). Anoop's diagnostic came back
  // edge='FAIL: 403', local='OK'. Edge is an unofficial endpoint Microsoft has
  // locked down; when it's failing it fails EVERY time, and waiting for that
  // round-trip before falling through to the local voice added a needless
  // delay to every single click. After a failure we skip Edge entirely for
  // EDGE_COOLDOWN_MS and go straight to the local Windows voice, then re-probe
  // once the cooldown lapses in case Microsoft (or a future fix) restores it.
  const EDGE_COOLDOWN_MS = 30 * 60 * 1000; // 30 min
  const edgeInCooldown = edgeFailedAt && (Date.now() - edgeFailedAt) < EDGE_COOLDOWN_MS;

  if (!edgeInCooldown) {
    try {
      const clips = await edgeTts.synthesizeClips(clean.slice(0, 8000), voice || edgeTts.DEFAULT_VOICE);
      edgeFailedAt = 0; // recovered
      send(ws, { type: 'tts-result', reqId, ok: true, clips, mime: 'audio/mpeg', engine: 'edge' });
      return;
    } catch (e) {
      lastErr = e;
      edgeFailedAt = Date.now();
      console.error('[handleTtsSpeak] Edge TTS failed (' + e.message + ') — using local Windows voice, skipping Edge for 30 min.');
    }
  }

  try {
    if (localTts.isAvailable()) {
      const clips = await localTts.synthesizeClips(clean.slice(0, 8000));
      send(ws, { type: 'tts-result', reqId, ok: true, clips, mime: localTts.MIME, engine: 'local' });
      return;
    }
  } catch (e) {
    lastErr = e;
    console.error('[handleTtsSpeak] local Windows TTS also failed:', e.message);
  }

  send(ws, {
    type: 'tts-result', reqId, ok: false,
    error: 'Server voices unavailable (' + ((lastErr && lastErr.message) || 'unknown') + ')'
  });
}

// ── Post-Session Analyst (standalone agent, auto-fires after CSV ingest) ────────
// 2026-07-28. Reads ALL data across every tab and agent, produces a structured
// post-session review: plan adherence, rule compliance, positives, negatives,
// and concrete next-session guidance. Runs on Gemini, no tools, no debate overhead.

const POST_SESSION_ANALYST_PERSONA = `You are the POST-SESSION ANALYST for Anoop Habib's MNQ/MGC prop trading co-pilot app.

## YOUR ROLE
You fire AFTER a trading session is over and Anoop has uploaded his Performance CSV. Your job is a forensic, numbers-first breakdown of the session. You are NOT a coach or cheerleader — you are an auditor who also gives forward-looking guidance.

## YOU ARE THE SYNTHESIS STEP, NOT THE ONLY ANALYST
Two things below have already been computed for you by dedicated passes, before you ever see this prompt:
- A **DETERMINISTIC SESSION SUMMARY** block — the date/trade-count/P&L/win-rate arithmetic, computed by code directly from the day's ledger. Use it verbatim for section 1. Do not recompute or re-derive any figure in it — if your own reading of the raw data would produce a different number, the deterministic block is correct and yours is not.
- A **PATTERN CHECK FINDINGS** block — the output of focused single-purpose workers, each dispatched ONLY when today's numbers actually crossed a real threshold for that specific failure mode (2026-08-16: orchestrator-workers pattern — see post-session-orchestrator.js). Incorporate their findings into section 6 rather than re-deriving your own read of the same patterns from scratch. If it says no workers triggered, say plainly that none of the documented failure-mode thresholds were tripped today — do not invent a concern to fill the section.

## OUTPUT FORMAT (strict, always follow this order)
1. **SESSION SUMMARY** — taken from the DETERMINISTIC SESSION SUMMARY block above, plus instrument and session window (London/NY) if available from the data.
2. **PLAN ADHERENCE** — Did Anoop write a pre-committed A+ cap before the session? Did he stay inside it? Grade: PASS or FAIL. (Rule #13 & #14: the plan-adherence grade overrides P&L — a green day that broke the cap is a FAIL.)
3. **RULE-BY-RULE COMPLIANCE** — Go through every applicable rule and score it:
   - Max 2 contracts per entry (rule #2)
   - Daily loss tiers: yellow/red/hard (rule #3)
   - Trade count: per-session (5 qualifying) and per-day (10) (rule #5)
   - Session window compliance (rule #6)
   - 15-minute break between trades (rule #7)
   - Pre-marked zones (rule #8)
   - One instrument per day (rule #9)
   - No sizing up while day is negative (rule #2 enforcement addendum)
   Mark each: ✅ COMPLIANT, ⚠️ PARTIAL, or 🚨 VIOLATED — with the specific data point (timestamp, trade #, size) that proves it.
4. **POSITIVES** — What went right, with evidence. Even on bad days, find the process wins.
5. **NEGATIVES** — What went wrong, with evidence. No softening. Cite the exact trade(s).
6. **PATTERN CHECK** — Built from the PATTERN CHECK FINDINGS block above. Present each triggered worker's finding; if none triggered, say so in one line.
7. **NEXT SESSION GUIDANCE** — 2-3 concrete, actionable items for tomorrow. Not platitudes — specific behavioral instructions tied to what you found above. If today was a FAIL, the first item should address the primary failure mode.

## RULES
- Reference actual numbers from the data — timestamps, P&L, sizes, hold times. No generalizing.
- If data is missing for a check, say "DATA MISSING — cannot verify" rather than guessing.
- Commission estimate: $0.59/contract/side (from rules.json).
- Goal is the next clean payout, not a spotless record. Zero margin for error in your assessment, especially if this session was on a FUNDED account — an eval breach costs time, a funded breach costs the payout itself.
- Do NOT give investment advice or trade recommendations. You analyze the session that already happened.
- Keep the entire review under 600 words. Dense, not padded.`;

// 2026-08-16 (Pattern 04, orchestrator-workers — post-session-orchestrator.js):
// deterministically decides which focused pattern-check workers today's data
// actually warrants, then runs them in parallel via the same runDebateAgent()
// helper the Debate flow already uses. Returns { summaryBlock, findingsBlock }
// — two markdown strings ready to splice into the synthesis prompt. Never
// throws: any failure gathering signals degrades to "0 workers, no
// deterministic summary" rather than blocking the review outright — a
// post-session review must never fail to render because one signal source
// was unavailable.
async function runPostSessionWorkers(abortSignal) {
  let gr = null, quadrant = null, ckToday = null, biasBlock = '';
  try {
    const { parseLS } = jessiActiveBucket();
    const grHist = parseLS('copilot_gr_history', []) || [];
    gr = Array.isArray(grHist) && grHist.length ? grHist[grHist.length - 1] : null;
  } catch (e) {}
  try {
    const loaded = biasLoadMatrix();
    if (loaded) {
      const today = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
      ckToday = (loaded.ckh || []).filter(e => e && e.date === today)[0] || null;
      const day = biasTracker.dayAdherence(ckToday, (loaded.dt || {})[today], getActiveRules());
      quadrant = biasTracker.quadrantFor(day, getActiveRules());
    }
    biasBlock = biasTodayContext();
  } catch (e) {}

  const flags = postSessionOrch.detectFlags({ gr, quadrant, ckToday, rules: getActiveRules() });
  const workers = postSessionOrch.selectWorkers(flags);
  const summary = postSessionOrch.deterministicSummary(gr);
  const summaryBlock = summary
    ? '## DETERMINISTIC SESSION SUMMARY (computed by code, not the model — use verbatim)\n' + summary
    : '## DETERMINISTIC SESSION SUMMARY\nDATA MISSING — no gr_history entry found for this session.';

  if (!workers.length) {
    return {
      summaryBlock,
      findingsBlock: '## PATTERN CHECK FINDINGS\nNo pattern-check workers triggered — none of the documented failure-mode thresholds were crossed today.'
    };
  }

  const grJson = gr ? JSON.stringify(gr) : '{}';
  const results = await Promise.all(workers.map(w => {
    const dataContext = w.topic === 'biasAdherence' ? (biasBlock || 'No bias data available.')
      : w.topic === 'checklistSkip' ? ('Checklist record: ' + JSON.stringify(ckToday || {}))
      : ('Today\'s session numbers (JSON): ' + grJson);
    return runDebateAgent(w.persona, 'Assess this specific pattern for today\'s session using only the data given.', dataContext, abortSignal)
      .then(r => Object.assign({}, w, r));
  }));

  const findingsBlock = '## PATTERN CHECK FINDINGS (from dedicated focused workers — incorporate, do not re-derive)\n'
    + results.map(r => `**${r.title}:** ${r.text}`).join('\n\n');

  return { summaryBlock, findingsBlock };
}

async function handlePostSessionReview(ws, msg) {
  const { reqId } = msg;
  const abortCtrl = registerRequest(reqId);

  // BUGFIX (2026-07-28): same top-level try/catch fix as handleDebateChat —
  // no throw in here used to reach the client, leaving the UI stuck on the
  // stop icon until the client's 5-min timeout fired.
  try {
    send(ws, { type: 'post-review-status', reqId, phase: 'gathering' });

    // Gather ALL data
    const parts = [];

    // 2026-08-16: dynamic-worker pattern check runs alongside the rest of the
    // gathering below — see runPostSessionWorkers() just above.
    const { summaryBlock, findingsBlock } = await runPostSessionWorkers(abortCtrl.signal);
    parts.push(summaryBlock);
    parts.push('\n' + findingsBlock);

    // Rules
    const rules = getActiveRules();
    parts.push('\n## ACTIVE RULES (rules.json)\n' + JSON.stringify(rules, null, 2));

    // Full account + trade + insights data
    const appData = jessiAppGetData('all');
    if (appData) parts.push('\n## FULL ACCOUNT & TRADE DATA\n' + appData);

    // Jessi context (journal, recent history)
    const jessiCtx = buildJessiContext();
    if (jessiCtx) parts.push('\n## JESSI CONTEXT (journal, recent history)\n' + jessiCtx);

    // Scalper's notebook (2026-08-01) — the Scalper agent records durable
    // per-day/per-trade behavioural notes during video reviews. Feeding them
    // in here is what makes the agents coordinate instead of each starting
    // from zero: the analyst can cite a pattern the Scalper already named.
    try {
      const scalpNotes = scalperNotesRead(null, 7);
      if (scalpNotes && !/^No scalper notes/.test(scalpNotes)) {
        parts.push('\n## SCALPER AGENT NOTES (behavioural observations from video reviews)\n' + scalpNotes);
      }
    } catch (e) {}

    // TradingView cache (end-of-session chart state)
    if (jessiTVCache.text) {
      const ageSec = Math.round((Date.now() - jessiTVCache.ts) / 1000);
      parts.push('\n## CHART STATE (cached, ' + ageSec + 's old)\n' + jessiTVCache.text);
    }

    // Session history (prior sessions for pattern comparison)
    try {
      const sessDir = path.join(DATA_DIR, 'sessions');
      if (fs.existsSync(sessDir)) {
        const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.json')).sort().slice(-5);
        const recent = files.map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8')); }
          catch { return null; }
        }).filter(Boolean);
        if (recent.length) parts.push('\n## RECENT SESSION HISTORY (last ' + recent.length + ')\n' + JSON.stringify(recent, null, 2));
      }
    } catch (e) {}

    // 2026-08-20: same shared live-feed accessor. The post-session review is
    // written about the session that just ended, so the broker's own record of
    // it belongs here alongside the client-reported session data.
    try {
      const lc = formatLiveFeedContext();
      if (lc) parts.push('\n## LIVE BROKER FEED (today, real executed trades — ground truth if it disagrees with the session data above)\n' + lc);
    } catch (e) {}
    // 3.1: market state at review time.
    try {
      const msl = formatMarketStateLine();
      if (msl) parts.push('\n## MARKET STATE AT REVIEW TIME\n' + msl);
    } catch (e) {}

    const dataContext = parts.join('\n');

    send(ws, { type: 'post-review-status', reqId, phase: 'analyzing' });

    // Stream the review
    const postSessionPrimary = primaryProviderModel();
    await groqAgent.stream(
      [{ role: 'user', content: 'Analyze my just-completed trading session. Here is ALL the data:\n\n' + dataContext }],
      istDateAnchor() + '\n\n' + POST_SESSION_ANALYST_PERSONA,
      [], // no tools
      {
        provider: postSessionPrimary.provider,
        model: postSessionPrimary.model,
        temperature: 0.8,
        signal: abortCtrl.signal,
        fallbackChain: fallbackChainFor(postSessionPrimary),
        onToken:  (text) => send(ws, { type: 'post-review-token', reqId, text }),
        onDone:   (fullText, answeredBy) => {
          // 2026-08-16 (Pattern 01, prompt chaining — the "gate" step):
          // facts (deterministic summary + worker findings, gathered above)
          // → draft (this call) → gate. Same verdict-grounding.js used for
          // the Debate verdict, applied here to the full report against
          // everything it was actually handed (dataContext, which itself
          // starts with the deterministic summary/findings blocks).
          let outText = fullText;
          try {
            const grounding = verdictGrounding.checkGrounding(fullText, dataContext, rules);
            if (!grounding.ok) {
              outText = fullText + verdictGrounding.groundingWarningBlock(grounding.ungrounded);
              console.warn('[verdict-grounding] ungrounded figures in post-session report:', grounding.ungrounded.join(', '));
            }
          } catch (e) { console.error('[verdict-grounding] check failed:', e.message); }

          send(ws, { type: 'post-review-done', reqId, fullText: outText, answeredBy });
          saveReviewRecord('post-session', outText, {});
        },
        onError:  (errMsg) => send(ws, { type: 'post-review-error', reqId, message: errMsg })
      }
    );
  } catch (e) {
    console.error('[handlePostSessionReview] uncaught error:', e);
    send(ws, { type: 'post-review-error', reqId, message: e.message || 'Post-session review failed unexpectedly.' });
  } finally {
    unregisterRequest(reqId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE SCALPER — dedicated scalping specialist agent (added 2026-08-01)
// ═══════════════════════════════════════════════════════════════════════════════
// Anoop's brief: an expert who "understands human greed of trading" but ALSO
// has real scalper competence, so it can identify the GAP between the two —
// specifically the gap between the levels he picks as an analyst (which are
// usually fine) and the size/hold/re-entry decisions he makes as a trader
// (which are what actually blow the accounts).
//
// Persona core is grounded in researched scalping practice (NinjaTrader's 10
// futures scalping principles, TradeAlgo's ES scalping guide, ForTraders'
// scalping strategy guide, plus the behavioural-finance literature on the
// disposition effect — Odean 1998, Barber & Odean 2000) rather than invented
// coaching platitudes. Key sourced facts embedded below:
//   - Scalping needs a HIGH win rate to survive commissions: ~60%+. A 55% win
//     rate on 4-tick stops LOSES money after commissions (TradeAlgo). So a
//     "good win rate" is not proof of edge on its own.
//   - Disposition effect: traders sell winners ~50% more readily than losers
//     (Odean 1998) and hold losers ~1.5x longer than winners. Cutting winners
//     early is an EMOTIONAL act, not a technical one.
//   - Time stop belongs alongside the price stop — the "it's not a scalp
//     anymore" rule. A scalp that has outlived its thesis is a different,
//     unplanned trade you never agreed to take.
//   - Fixed fractional sizing per scalp; the math is trivial, the discipline
//     is the hard part. Size is decided BEFORE the session, never live.
//   - Overtrading after losses is the single most-cited scalper killer.
//   - "Knowing when NOT to trade" is listed as a core skill, not a fallback.
const SCALPER_PERSONA = `You are THE SCALPER — Anoop Habib's specialist scalping coach inside his MNQ Co-Pilot app. You are not Jessi (the general accountability coach) and not the Post-Session Analyst (the forensic auditor). You are the one who understands the CRAFT of scalping AND the greed that destroys it, and your entire value is in spotting the gap between the two in Anoop specifically.

## WHO ANOOP IS (do not forget any of this)
- Trades MNQ/MGC micros on a Lucid prop account from Hubballi, India (IST). Read the CURRENT account size and stage (eval/funded) live from the ACCOUNT & TRADE DATA block — do not hardcode a slot or stage here, it drifts.
- Goal: one clean payout at a time, growing capital from ~$1,000 by rotating that capital through eval attempts into single funded accounts. NOT simultaneous multi-account copy-trading yet — that is a later-stage plan, only raise it if he does.
- STAGE ASYMMETRY: eval exists to be cleared FAST — time in eval is the cost, not risk. Funded exists to be protected — zero slack on process once funded, because that account is what actually pays out. Coach the pace in eval; coach the discipline in funded. Do not blur the two.
- NEVER state his lifetime spend, payout total, or net position from memory. Read it from the COST line in the ACCOUNT & TRADE DATA block, which is fed live from his Cost tab, and quote that verbatim. A hardcoded total here had drifted from the real figure and agents were repeating it as fact; it was removed 2026-08-11.
- EVERY blow-up died the same way: trade-count escalation, revenge re-entries within minutes, sizing UP while already down, holding losers, trading both instruments in one day, and giving back gains after being green. Name the SPECIFIC behavior when it's in today's data — never a running tally of past accounts. He can afford another eval attempt; he cannot afford treating "one more account gone" as proof it's already over.
- ~83% of his trades are scalps (under 10 minutes). The app runs a Scalper Mode with its own ruleset for exactly this reason.
- He is a COMPETENT ANALYST and a POOR RISK MANAGER. This is the central fact about him. His marked levels, zones and bias work are usually reasonable. His size, his re-entry timing, and his hold discipline are what kill him. Do not spend your time re-teaching him chart reading — spend it on the execution gap.

## THE GAP YOU EXIST TO CLOSE
On the analyst side he asks "where is price likely to go?" On the trader side he asks "how do I get that money back / how much can I get out of this?" The second question is greed wearing the costume of conviction. Your job every single time: separate the level from the size, and the thesis from the urgency. A correct level taken at 4 contracts 11 seconds after a loss is NOT a good trade that happened to be big — it is a bad trade that happened to be right.

## WHAT YOU KNOW ABOUT SCALPING (use this, it is sourced, not invented)
1. **Scalping requires a genuinely high win rate to clear costs.** ~60%+ is the working threshold; a 55% win rate on 4-tick stops actually loses money after commissions. So never congratulate him on a win rate alone — check it against hold time, size consistency, and commission drag before calling it edge.
2. **Time stop sits alongside the price stop.** The "it's not a scalp anymore" rule: if a scalp has outlived its thesis window, it has silently become a different trade he never planned. Exit on time, not on hope. In Scalper Mode the app's max hold is 30 minutes — anything past that is flagged hold-exceeded.
3. **The disposition effect is measurable and he has it.** Traders sell winners roughly 50% more readily than losers, and hold losers about 1.5x longer than winners. Cutting a winner early is an emotional act, not a technical one. When you see small avg-win against large avg-loss, name it as this, by name.
4. **Size is decided before the session, never live.** Fixed sizing per scalp. The arithmetic is trivial; the discipline is the entire game. Any size chosen DURING a session is an emotional number, no matter how it is justified afterwards.
5. **Overtrading after losses is the single most-cited scalper killer.** Not a style issue — the mechanism of ruin.
6. **Knowing when NOT to trade is a core skill, not a fallback.** Flat is a position. No setup is information, not failure.
7. **Execution consistency is what makes performance data meaningful at all.** If his size and hold vary trade to trade, his stats measure nothing and no edge can ever be proven or disproven.

## HOW YOU BEHAVE
- **Lead with the uncomfortable thing.** First line names the worst pattern in the data, not a greeting and not a positive.
- **Always cite trade numbers.** The Journal table is numbered (#1, #2, #3...). Say "trade 6" and "trade 7", never "that one short". He reads along with the numbers.
- **Green P&L is not a defence.** Per his own rule #14 a green day with a broken plan is a FAILED session, full stop. When the market rewarded a violation, say plainly that the reward is the danger — it is the reinforcement that trains the next blow-up. This is the most important thing you do.
- **Separate "was the level right" from "was the trade right".** Grade them independently, every time. He is allowed to be right about direction and still have taken a bad trade. Tell him which of the two failed.
- **Be specific about the fix.** Not "size down" but "trades 6 and 7 were 4 contracts against your 2-cap, taken 40s and 11s after a loss — the fix is the 15-minute timer, not smaller size, because size was a symptom of the re-entry urge."
- **Never help him rationalise.** "High conviction", "it was a clean setup", "I was already in profit", "I only need one more" — every one of these is the exact sound of a revenge re-entry or a size-up-while-down dressed as reasoning. Name the specific behavior, calmly, without moralising — not a reference to past accounts.
- **Do not be cruel and do not be soft.** You are an expert peer who takes him seriously enough to be blunt. No lectures, no shaming, no cheerleading.

## YOUR HARD ENFORCEMENT DUTIES
You must proactively call a STOP when you see any of these in the data or in what he tells you:
- Size above the active size cap (read it live from rules — never assume the number).
- ANY size increase relative to the previous trade while the day's running P&L is negative. This is the exact pattern that breached the $150K eval on 2026-07-21. It is a hard stop, not a caution.
- Re-entry inside the cooldown window (15 minutes; in Scalper Mode, after losses specifically).
- Trade count past the per-session or per-day cap.
- Both MNQ and MGC touched on the same day.
- Trading outside the London/NY session windows.
- Continuing after the daily loss tier is hit.
When you call a stop, state the rule, the evidence (trade number + timestamp + number), and what he does right now. Then stop talking. Do not soften it with a compliment afterwards.

## TOOLS
- app_get_data("scalp") — per-day hold times, median gaps, cooldown breaches, trade counts. Your primary data source. Call it before any per-day claim.
- app_get_data("trades") / ("insights") / ("status") — per-trade detail, discipline history, live account state and the ACTIVE rule numbers.
- scalp_note_add — record a durable note about a specific day or trade (behaviour observed, pattern, agreed fix). Use this whenever Anoop reviews session video with you, so the observation survives the chat.
- scalp_note_get — read back prior notes. ALWAYS call this before giving feedback on a new session, so you can say "this is the third time" instead of treating every day as new. Repetition across days is your strongest evidence.
- search_books — ground a point in his own trading library when it genuinely helps.

## OUTPUT
Compact. Trade-numbered. Evidence attached to every claim. No headers unless he asks for a full report. If you are guessing, say you are guessing.`;

// Per-account scalper notebook. Key routes to accounts/<slot>/scalper_notes.json
// via dataPathFor()'s '<key>__<slotId>' convention, so notes never leak between
// accounts (same isolation rule as gr_history/day_trades).
// 2026-08-25. Anoop: "everything that i put in journal will be lesson and
// should come to be in coaching in chat tomorrow and help me stick to this."
// It never arrived: 'note-save' wrote accounts/<slot>/notes.json, and the only
// reader anywhere in the codebase was the Journal tab redrawing its own
// textarea. Same per-slot isolation as scalper notes below — a lesson written
// on the 50K eval must not surface while a different account is open.
// ── Self-authored guardrails (2026-08-25) ───────────────────────────────────
// Anoop: "idea 1 armed detector is good idea build it and make it part of the
// system." A lesson in the Lessons tab can now carry a machine-checkable
// condition; promoting it arms that condition for the next session.
//
// GLOBAL, not per-slot — deliberately, and for the same reason the Lessons tab
// always was: "sizing up while losing blows accounts" is true on every
// account, not just whichever one happens to be open. Contrast journalNotes
// above, which IS per-slot because a day's mood belongs to that day's account.
// The merged Alignment+Lessons store. Migration is LAZY and NON-DESTRUCTIVE:
// the first read with no mind_log.json builds one from align_notes.json and
// lessons_log.json and leaves both originals untouched, forever. His 18 Aug
// alignment entry is long and irreplaceable — nothing about tidying two files
// into one is worth risking it, so the old files stay as their own backup.
function mindLogLoad() {
  const merged = dataLoad('mind_log');
  if (Array.isArray(merged)) return mindLog.load(merged);
  const built = mindLog.migrate(dataLoad('align_notes'), dataLoad('lessons_log'));
  if (built.length) {
    dataSave('mind_log', built);
    console.log('[mind-log] merged ' + built.length + ' entr' + (built.length === 1 ? 'y' : 'ies')
      + ' from align_notes.json + lessons_log.json into mind_log.json. Both originals left in place.');
  }
  return built;
}

// Kept as the write path's counterpart so both sides of a fire-record use the
// same key.
function mindLogSave(list) { return dataSave('mind_log', list); }

// Back-compat shim: armed-detectors works on anything carrying
// {promoted, detector}, and lessons are exactly that subset of the mind log.
function lessonsLogLoad() {
  return mindLog.armable(mindLogLoad());
}

// Newest-first [{date, pnl}] for finished days, EXCLUDING today — the shape
// red-day-streak needs. Read from the ACTIVE slot's history: "two red days in
// a row" has to mean two red days on the account he is about to trade.
function armedPriorDays(limit) {
  try {
    const slot = loadConfig().activeSlotId;
    const hist = dataLoad(slot ? ('gr_history__' + slot) : 'gr_history');
    if (!Array.isArray(hist)) return [];
    const today = dayRollup.tradingDayKey(Date.now());
    return hist
      .filter(d => d && d.date && d.date < today && typeof d.pnl === 'number')
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, limit || 10)
      .map(d => ({ date: d.date, pnl: d.pnl }));
  } catch (e) { return []; }
}

// One line per armed detector for agent context, so the coaching agents know
// what he has told himself to watch for — including the ones that have never
// fired, which is the honest half.
function formatArmedDetectorsContext() {
  try {
    const rows = armedDetectors.describeArmed(lessonsLogLoad(), Date.now());
    if (!rows.length) return '';
    return rows.map(r => '- "' + r.text + '" -> ' + r.summary).join(String.fromCharCode(10));
  } catch (e) { return ''; }
}

function journalNotesLoad() {
  const cfg = loadConfig();
  const slot = cfg.activeSlotId;
  return dataLoad(slot ? ('notes__' + slot) : 'notes') || {};
}

function formatJournalNotesContext(limit) {
  try {
    return journalNotes.formatJournalContext(journalNotesLoad(), tradingDayStampIST(), { limit: limit || 3 });
  } catch (e) { return ''; }
}

// 2026-08-25: the stick-rate scorecard. formatJournalNotesContext above says
// what he wrote LAST time; this says whether writing it has ever changed
// anything. The distinction matters because a lesson he fixed and a lesson he
// re-writes every week are indistinguishable to an agent reading one day's
// note — and "this is the fifth time you have written that" is a sentence no
// agent in this app could previously say.
function formatJournalScorecardContext() {
  try {
    return journalNotes.formatScorecardContext(journalNotesLoad(), tradingDayStampIST(), {});
  } catch (e) { return ''; }
}

function scalperNotesKey() {
  const cfg = loadConfig();
  const slot = cfg.activeSlotId;
  return slot ? ('scalper_notes__' + slot) : 'scalper_notes';
}
function scalperNotesLoad() {
  return dataLoad(scalperNotesKey()) || { days: {} };
}
function scalperNotesAdd(date, entry) {
  const store = scalperNotesLoad();
  if (!store.days) store.days = {};
  if (!store.days[date]) store.days[date] = [];
  store.days[date].push(Object.assign({ ts: new Date().toISOString() }, entry));
  // Keep the notebook bounded — 120 most recent days.
  const keys = Object.keys(store.days).sort();
  while (keys.length > 120) { delete store.days[keys.shift()]; }
  dataSave(scalperNotesKey(), store);
  return store.days[date].length;
}
function scalperNotesRead(dateFilter, limitDays) {
  const store = scalperNotesLoad();
  const days = store.days || {};
  if (dateFilter) {
    const list = days[dateFilter] || [];
    if (!list.length) return `No scalper notes recorded for ${dateFilter}.`;
    return `SCALPER NOTES — ${dateFilter} (${list.length}):\n` + list.map((n, i) =>
      `${i + 1}. [${n.kind || 'note'}${n.trade != null ? ' · trade #' + n.trade : ''}] ${n.text}`).join('\n');
  }
  const dates = Object.keys(days).sort().slice(-(limitDays || 10));
  if (!dates.length) return 'No scalper notes recorded yet for this account.';
  const out = [`SCALPER NOTES — last ${dates.length} day(s) with notes:`];
  dates.forEach(d => {
    out.push(`\n${d}:`);
    (days[d] || []).forEach((n, i) => out.push(`  ${i + 1}. [${n.kind || 'note'}${n.trade != null ? ' · trade #' + n.trade : ''}] ${n.text}`));
  });
  return out.join('\n');
}

// Scalper's tool set — app data (incl. the scalp section) + its own notebook +
// the book library. Deliberately NO chart-drawing and NO trade execution: this
// agent reviews and enforces, it does not touch the market or the chart.
const SCALPER_TOOLS = [
  { type: 'function', function: {
    name: 'app_get_data',
    description: 'Read live data for the account currently open. Sections: "scalp" (PER-DAY hold times, median inter-trade gap, cooldown breaches, trade counts, hold-exceeded — your primary source, call this first for any per-day claim), "trades" (last 12 individual trades with side/size/entry/P&L/hold/flags), "insights" (discipline %, revenge count, over-cap count, giveback, per-day history), "status" (balance, floor, target, and the ACTIVE rule numbers — always read the size cap and loss tiers from here rather than assuming), "checklist", "roadmap", "cost", "all".',
    parameters: { type: 'object', properties: { section: { type: 'string', enum: ['scalp', 'trades', 'insights', 'status', 'checklist', 'roadmap', 'cost', 'process', 'all'] } }, required: ['section'] }
  } },
  { type: 'function', function: {
    name: 'scalp_note_add',
    description: 'Record a durable scalping note for a specific date, optionally tied to a specific trade number from the Journal table. Use this whenever you and Anoop review session video or discuss a specific trade, so the observation persists beyond this chat and can be cited on later days. Kinds: "behaviour" (what he did and the emotional driver), "pattern" (a repeating tendency across days), "fix" (the concrete agreed change), "level" (analysis-quality observation about the level/zone he chose).',
    parameters: { type: 'object', properties: {
      date: { type: 'string', description: 'YYYY-MM-DD the note is about' },
      kind: { type: 'string', enum: ['behaviour', 'pattern', 'fix', 'level'] },
      trade: { type: 'number', description: 'optional 1-based trade number from the Journal table' },
      text: { type: 'string', description: 'the note itself — specific and evidence-bearing, not vague' }
    }, required: ['date', 'kind', 'text'] }
  } },
  { type: 'function', function: {
    name: 'scalp_note_get',
    description: 'Read back previously recorded scalper notes. Call this BEFORE giving feedback on a new session so you can identify repeats across days ("third time this week") rather than treating each day as isolated. Omit date to get the last several days of notes.',
    parameters: { type: 'object', properties: {
      date: { type: 'string', description: 'optional YYYY-MM-DD; omit for recent days' },
      days: { type: 'number', description: 'optional number of recent days to return (default 10)' }
    }, required: [] }
  } },
  { type: 'function', function: {
    name: 'search_books',
    description: 'Search Anoop\'s trading book library (Stock Market Wizards, Trading in the Zone, Intraday Trading Techniques, Prop Trading Secrets, TradeApp\'s Guide to Proprietary Trading) for relevant passages when grounding a coaching point in a specific author helps more than your own framing.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, book: { type: 'string' } }, required: ['query'] }
  } },
  RECALL_CHAT_TOOL,
  RECALL_PATTERNS_TOOL,
  DIAGNOSE_DAY_TOOL
];

function makeScalperToolExecutor() {
  return async (name, args) => {
    if (name === 'app_get_data') return jessiAppGetData((args && args.section) || 'scalp');
    if (name === 'recall_chat') return recallChat(args);
    if (name === 'recall_patterns') return recallPatterns(args);
    if (name === 'diagnose_day') return diagnoseDay(args);
    if (name === 'scalp_note_add') {
      if (!args || !args.date || !args.text) return 'scalp_note_add needs at least "date" and "text".';
      const n = scalperNotesAdd(args.date, { kind: args.kind || 'note', trade: args.trade, text: args.text });
      return `Saved. ${args.date} now has ${n} scalper note(s) on file.`;
    }
    if (name === 'scalp_note_get') return scalperNotesRead(args && args.date, args && args.days);
    if (name === 'search_books') {
      const query = (args && args.query) || '';
      if (!query.trim()) return 'search_books needs a "query".';
      const results = booksIndex.searchBooks(query, { limit: 4, book: (args && args.book) || null });
      if (!results.length) return `No passages found for "${query}".`;
      return results.map(r => `[${r.title}]\n${r.text}`).join('\n\n---\n\n');
    }
    return `Unknown tool "${name}".`;
  };
}

// ── Handler: Scalper chat ──────────────────────────────────────────────────────
// Same streaming/fallback shape as handleJessiChat and handlePostSessionReview.
// Seeds the turn with live scalp data + prior notes so the agent starts already
// knowing the numbers instead of burning a tool round-trip on every message.
async function handleScalperChat(ws, msg) {
  const { reqId, messages } = msg;
  const abortCtrl = registerRequest(reqId);
  try {
    const seed = [];
    try {
      const rules = getActiveRules();
      seed.push('## ACTIVE RULES (live — use these numbers, do not assume)\n'
        + `mode: ${rules.tradingMode || 'standard'} · sizeCap: ${rules.sizeCap} · tradesPerSession: ${rules.tradesPerSession} · tradesPerDay: ${rules.tradesPerDay}`
        + ` · lossTiers: ${rules.dailyLossTiers.yellow}/${rules.dailyLossTiers.red}/${rules.dailyLossTiers.hard}`
        + ` · cooldownMinutes: ${rules.cooldownMinutes}${rules.maxHoldSeconds ? ' · maxHoldSeconds: ' + rules.maxHoldSeconds : ''}`);
    } catch (e) {}
    try { seed.push('\n## SCALP STATS (per day)\n' + jessiAppGetData('scalp')); } catch (e) {}
    try { seed.push('\n## RECENT TRADES\n' + jessiAppGetData('trades')); } catch (e) {}
    // 2026-08-10: trimmed from 10→5 days — notes accumulate daily and were
    // contributing to the oversized-request 413s (see the auto/best-free
    // note near primaryProviderModel() above). 5 days still covers "third
    // time this week" pattern-spotting.
    try { seed.push('\n## YOUR PRIOR NOTES\n' + scalperNotesRead(null, 5)); } catch (e) {}
    try {
      const align = formatAlignmentNotes(3);
      if (align) seed.push('\n## HIS OWN WORDS ABOUT HIMSELF — current state AND standing lessons (read before coaching)\n' + align);
    } catch (e) {}
    // 2026-08-20: shared live-feed accessor (same one Jessi and the Judge read).
    // The Scalper's whole job is today's execution, so a stale CSV-derived
    // trade count was the worst place for this gap to sit.
    try {
      const lc = formatLiveFeedContext();
      if (lc) seed.push('\n## LIVE BROKER FEED (today, real executed trades — ground truth over the CSV/scalp stats above if they disagree)\n' + lc);
    } catch (e) {}
    // 3.1: the market-state line reaches the Scalper through the shared block.
    try {
      const msl = formatMarketStateLine();
      if (msl) seed.push('\n## MARKET STATE (live chart setup)\n' + msl);
    } catch (e) {}

    const seeded = [{ role: 'user', content: 'CONTEXT (auto-attached, not typed by Anoop):\n' + seed.join('\n') }]
      .concat(Array.isArray(messages) ? messages : []);

    const scalperPrimary = primaryProviderModel();
    await groqAgent.stream(
      seeded,
      istDateAnchor() + '\n\n' + SCALPER_PERSONA,
      SCALPER_TOOLS,
      {
        provider: scalperPrimary.provider,
        model: scalperPrimary.model,
        temperature: 0.7,
        signal: abortCtrl.signal,
        fallbackChain: fallbackChainFor(scalperPrimary),
        toolExecutor: makeScalperToolExecutor(),
        onToken: (text) => send(ws, { type: 'scalper-token', reqId, text }),
        onToolStart: (name) => send(ws, { type: 'scalper-tool', reqId, name, phase: 'start' }),
        onToolDone:  (name) => send(ws, { type: 'scalper-tool', reqId, name, phase: 'done' }),
        onFallback: (fromM, toM) => send(ws, { type: 'scalper-fallback', reqId, from: fromM, to: toM }),
        onDone: (fullText, answeredBy) => {
          send(ws, { type: 'scalper-done', reqId, fullText, answeredBy });
          saveReviewRecord('scalper', fullText, {});
        },
        onError: (errMsg) => send(ws, { type: 'scalper-error', reqId, message: errMsg })
      }
    );
  } catch (e) {
    console.error('[handleScalperChat] uncaught error:', e);
    send(ws, { type: 'scalper-error', reqId, message: e.message || 'Scalper chat failed unexpectedly.' });
  } finally {
    unregisterRequest(reqId);
  }
}

// ── Handler: Jessi voice mode (voice in, voice out) ─────────────────────────────
// Added 2026-07-23. Reuses the exact same JESSI_PERSONA/context/tool pipeline
// as handleJessiChat above — voice is purely an I/O wrapper around the same
// brain, not a second Jessi. Flow: browser records mic audio with client-side
// silence detection (3-4s) → sends one WS message with the clip → this
// transcribes it (Whisper), runs it through the normal Jessi turn, then
// synthesizes the reply (Orpheus) and ships back base64 WAV clips for the
// client to play. No tokens are streamed mid-turn in voice mode (nothing to
// caption live-word-by-word usefully while waiting on audio synthesis
// anyway) — client gets transcript + full reply + audio in two messages.
async function handleJessiVoiceSend(ws, msg) {
  const { reqId, messages } = msg;
  // 2026-09-02 (Landing 2): ONE input path. msg.transcript is produced by the
  // browser's own speech recognition; the legacy audioBase64 -> Groq Whisper
  // branch is gone with Groq itself. msg.clientTts:true still means the
  // browser will speak the reply, so the server skips synthesis entirely.
  const clientTts = msg.clientTts === true;
  const abortCtrl = registerRequest(reqId);
  try {
    // 2026-07-25: this used to hard-require a Groq key for ANY voice turn.
    // That became wrong once Gemini became the default brain: if the browser
    // does STT (msg.transcript) and TTS (clientTts), a voice turn needs no
    // Groq call at all, so a Gemini-only setup should work. Now only demands
    // a Groq key for the parts that genuinely still go through Groq —
    // server-side Whisper STT, server-side Orpheus TTS, or a Groq brain.
    // 2026-08-07: server-side STT can now also be satisfied by OmniRoute
    // (Speechmatics), so the Groq requirement for STT specifically is relaxed
    // when OmniRoute is configured and enabled — Groq is still required for
    // TTS (Orpheus) since OmniRoute has no text-to-speech model at all.
    // 2026-09-02 (Landing 2): the whole Groq/OmniRoute gate above is gone.
    // Voice needs NO speech vendor at all now:
    //   • speech-to-text  — the browser's own recognition (msg.transcript).
    //     This was already the primary path; Groq Whisper was only the legacy
    //     MediaRecorder fallback, and DeepSeek has no audio API to replace it,
    //     so browser-only is the deliberate choice (agreed 2026-09-02).
    //   • text-to-speech  — Edge neural / local Windows SAPI / browser voice.
    //   • the brain       — DeepSeek, same as every other agent.
    // What remains is one honest check: did we actually get words to answer?
    const stCfg = loadConfig();
    if (!groqAgent.isDeepSeekReady() && !groqAgent.isGeminiReady()) {
      send(ws, { type: 'jessi-voice-error', reqId, message: 'No AI key configured. Add your DeepSeek key in Settings.' });
      return;
    }
    if (!(typeof msg.transcript === 'string' && msg.transcript.trim())) {
      // Stated plainly rather than as a vendor error, because the fix is not
      // "add a key" any more — it is "use a browser that can hear you".
      send(ws, { type: 'jessi-voice-error', reqId, message: "Voice input needs your browser's speech recognition and it didn't return any words. Chrome supports it; if you're on another browser, type instead." });
      return;
    }

    // Guaranteed non-empty by the check above — the server-side Whisper /
    // Speechmatics branches that used to live here are gone with Groq and
    // OmniRoute (Landing 2). The browser is the only transcriber now.
    const transcript = msg.transcript.trim();
    if (!transcript) {
      send(ws, { type: 'jessi-voice-error', reqId, message: "Didn't catch anything — try again." });
      return;
    }
    send(ws, { type: 'jessi-voice-transcript', reqId, text: transcript });

    // Voice uses the condensed persona + reduced tool set + short history to
    // stay under the 8B free tier's 6000 tokens/minute cap. No live-chart
    // snapshot injected here (Jessi can call quote_get/market_key_levels if
    // she actually needs it) — that snapshot was another chunk of every turn.
    const turnMessages = [...(messages || []).slice(-8), { role: 'user', content: transcript }];
    const systemPrompt = JESSI_PERSONA_VOICE + '\n\n' + buildJessiContext(true);

    // 2026-09-02 (Landing 2): the voice-brain picker is gone. It offered
    // Gemini / Groq / two local Ollama models — a per-surface override that
    // existed only because the free brains had wildly different token
    // ceilings, so voice needed a cheaper one than text chat. With a single
    // paid provider that reason is gone, and a voice answer coming from a
    // DIFFERENT model than the same question typed into chat was precisely
    // the kind of inconsistency Anoop asked to be rid of.
    // Voice now uses the same brain and the same fail-open ladder as every
    // other agent.
    const voicePrimary = primaryProviderModel();
    const brainProvider = voicePrimary.provider;
    const brainModel = voicePrimary.model;
    const brainChain = fallbackChainFor(voicePrimary);

    let fullReply = '';
    let replyAnsweredBy = null;
    await new Promise((resolve) => {
      groqAgent.stream(turnMessages, systemPrompt, JESSI_VOICE_TOOLS, {
        provider: brainProvider,
        model: brainModel,
        signal: abortCtrl.signal,
        fallbackChain: brainChain,
        toolExecutor: makeJessiToolExecutor(ws),
        onToolStart: (name, id) => send(ws, { type: 'jessi-voice-tool-start', reqId, name, id }),
        onToolDone:  (name, id, ok, res) => send(ws, { type: 'jessi-voice-tool-done', reqId, name, id, ok, result: res }),
        onFallback:  (fromM, toM) => send(ws, { type: 'jessi-voice-fallback', reqId, from: fromM, to: toM }),
        onWait:      (m, sec) => send(ws, { type: 'jessi-voice-quota-warn', reqId, message: `${m}: per-minute cap — waiting ${sec}s, same model.` }),
        onQuota:     (m, quota) => { const w = quotaWarning(m, quota); if (w) send(ws, { type: 'jessi-voice-quota-warn', reqId, message: w }); },
        onDone: (text, answeredBy) => { fullReply = text; replyAnsweredBy = answeredBy; resolve(); },
        onError: (errMsg) => { send(ws, { type: 'jessi-voice-error', reqId, message: errMsg }); resolve(null); }
      });
    });
    // FIX 2026-07-23: this used to `return` silently on an empty reply,
    // which left the client's "thinking" UI stuck forever with no terminal
    // message ever sent (found live). onError already covers the errored
    // path; this covers the "stream finished but produced nothing" path.
    if (!fullReply) {
      send(ws, { type: 'jessi-voice-error', reqId, message: "Jesse didn't say anything back — try again." });
      return;
    }

    // 2026-07-25: Edge TTS (neural, en-IN voices, free/unofficial — see
    // edge-tts.js header) is tried FIRST for the speaking voice, per Anoop's
    // ask for a human-sounding voice he can use all day.
    //
    // 2026-09-02 (Landing 2): the old tier 3 was Groq Orpheus, the LAST thing
    // in the voice path still needing a Groq key. Replaced with the local
    // Windows SAPI voice that handleTtsSpeak has used as its own tier 2 since
    // 2026-07-28. Strictly better on three counts, which is why this is the
    // step that let Groq be removed entirely:
    //   • offline — cannot be revoked, rate-limited or deprecated mid-session
    //   • Orpheus is English/Arabic ONLY, so it never had an Indian-English
    //     voice; SAPI usually has Heera (en-IN) installed
    //   • no vendor key at all
    // Ladder now: Edge neural -> browser (if the client offered) -> local SAPI.
    // Setting the voice to "browser" in Settings skips Edge entirely.
    //
    // FAILURE BEHAVIOUR IS ALSO BETTER: the Groq branch could THROW, which
    // failed the whole voice turn — Anoop got an error instead of an answer he
    // had already waited for. Every branch below now degrades to "no clips",
    // which the client already treats as "speak it with the browser voice", so
    // a dead voice engine costs him the audio, never the reply.
    const edgeVoice = loadConfig().edgeVoice || edgeTts.DEFAULT_VOICE;
    let sent = false;
    if (edgeVoice !== 'browser') {
      try {
        const clips = await edgeTts.synthesizeClips(fullReply, edgeVoice);
        send(ws, { type: 'jessi-voice-audio', reqId, fullText: fullReply, clips, mime: 'audio/mpeg', answeredBy: replyAnsweredBy });
        sent = true;
      } catch (e) {
        console.log('Edge TTS failed (falling back):', e.message);
      }
    }
    if (!sent && clientTts) {
      // Browser speaks it — no server TTS call, no audio payload.
      send(ws, { type: 'jessi-voice-audio', reqId, fullText: fullReply, clips: [], answeredBy: replyAnsweredBy });
    } else if (!sent) {
      let clips = [], mime = localTts.MIME;
      try {
        if (localTts.isAvailable()) clips = await localTts.synthesizeClips(fullReply);
      } catch (e) {
        console.error('[jessi-voice] local Windows TTS failed:', e.message, '— sending text only, client will speak it.');
      }
      send(ws, { type: 'jessi-voice-audio', reqId, fullText: fullReply, clips, mime, answeredBy: replyAnsweredBy });
    }
  } catch (e) {
    send(ws, { type: 'jessi-voice-error', reqId, message: e.message });
  } finally {
    unregisterRequest(reqId);
  }
}

// ── Handler: Trade journal (free-text trade/state-of-mind entries) ─────────────
// Deliberately NOT account-scoped (not part of ACCT_LS_KEYS) — psychological
// patterns are about Anoop, not about which prop account is currently active,
// so this survives account breach/clear resets.
function handleJournalAdd(ws, msg) {
  const entries = dataLoad('trade_journal') || [];
  const entry = { ts: new Date().toISOString(), text: String(msg.text || '').slice(0, 2000) };
  entries.push(entry);
  const trimmed = entries.slice(-300);
  dataSave('trade_journal', trimmed);
  send(ws, { type: 'journal-saved', reqId: msg.reqId, ok: true, entry });
}

// ── Handler: MCP direct call ───────────────────────────────────────────────────
async function handleMCPCall(ws, msg) {
  const { name, args, reqId } = msg;
  try {
    // Same normalisation as the agent path — this route is reachable from the
    // renderer and from anything else that speaks the WS protocol.
    const result = await mcpBridge.callTool(name, tvToolArgs.normalizeToolArgs(name, args || {}));
    send(ws, { type: 'mcp-result', reqId, ok: true, result });
  } catch (e) {
    send(ws, { type: 'mcp-result', reqId, ok: false, error: e.message });
  }
}

// ── Handler: Sessions ──────────────────────────────────────────────────────────
function handleSessionStart(ws, msg) {
  const result = sessionMgr.startSession(sessionMgr.todayStr(), msg.data || {});
  send(ws, { type: 'session-started', reqId: msg.reqId, data: result });
}

function handleSessionTrade(ws, msg) {
  const result = sessionMgr.logTrade(sessionMgr.todayStr(), msg.trade || {});
  send(ws, { type: 'session-trade-logged', reqId: msg.reqId, data: result });
}

// ── Handler: Screenshot ────────────────────────────────────────────────────────
function handleScreenshot(ws, msg) {
  try {
    if (!msg.filePath || !fs.existsSync(msg.filePath)) {
      return send(ws, { type: 'screenshot-data', reqId: msg.reqId, data: null });
    }
    const data = fs.readFileSync(msg.filePath);
    send(ws, { type: 'screenshot-data', reqId: msg.reqId, data: 'data:image/png;base64,' + data.toString('base64') });
  } catch {
    send(ws, { type: 'screenshot-data', reqId: msg.reqId, data: null });
  }
}

// ── Engulfing monitors (multi-timeframe: 1H / 30M / 15M) ────────────────────────
// Each monitor runs its own interval and uses getBarsAndLabels() (2026-08-06 —
// was market_multi_tf, a tool name that never existed, see its fix comment
// below) to switch the TradingView chart to its target timeframe, pull
// Pine/OHLCV data, then restore the chart — so 30M/15M checks are real, not
// just gated behind "chart happens to already be on that TF" the way the old
// single-TF version was.
const ENGULF_TFS = {
  '1h':  { tfCode: '60', label: '1H',  intervalMs: 60 * 1000 },
  '30m': { tfCode: '30', label: '30M', intervalMs: 45 * 1000 },
  '15m': { tfCode: '15', label: '15M', intervalMs: 30 * 1000 },
  // 2026-08-27: the 5M watcher was missing outright — a 5M bullish engulf on
  // MNQ closed live and nothing fired, because no monitor was ever polling
  // that timeframe. Polls at 15s so a close is reported inside a quarter of a
  // minute rather than after a 5M-length gap.
  '5m':  { tfCode: '5',  label: '5M',  intervalMs: 15 * 1000 }
};

const engulfMonitors = {};
for (const key of Object.keys(ENGULF_TFS)) {
  engulfMonitors[key] = { running: false, interval: null, lastSignalKey: null, lastCheck: null, lastRejectKey: null, lastError: null, restartAttempted: false }; // 1.4 liveness
}

// 1.2 (plan decision 2): engulf watchers are always on — there is no
// supported OFF and no *MonitorUserDisabled flag to flip. The toggle message
// handler stays so an old client/Telegram 'off' is REFUSED with a status line
// instead of leaving a watcher dark.
function handleEngulfToggle(msg) {
  const key = ENGULF_TFS[msg.tf] ? msg.tf : '1h';
  if (msg.enabled) { startEngulfMonitor(key); return; }
  broadcast({ type: 'engulf-monitor-status', tf: key, running: true, alwaysOn: true, note: `Engulf ${ENGULF_TFS[key].label} watcher is always on — 'off' is not supported.` });
  console.log(`Engulf ${ENGULF_TFS[key].label}: 'off' refused — watchers are always on`);
}

function startEngulfMonitor(key) {
  stopEngulfMonitor(key);
  const mon = engulfMonitors[key];
  mon.running = true;
  broadcast({ type: 'engulf-monitor-status', tf: key, running: true });
  console.log(`Engulf monitor started [${ENGULF_TFS[key].label}]`);
  checkEngulfingSignal(key); // immediate
  // Bar-close aligned: one read per bar instead of one every intervalMs. The
  // detector drops the forming bar, so a mid-bar poll can only re-read a
  // candle it has already judged.
  mon.poller = barSchedule.startBarAlignedPoll(ENGULF_TFS[key].tfCode, () => checkEngulfingSignal(key), { fallbackIntervalMs: ENGULF_TFS[key].intervalMs });
}

function stopEngulfMonitor(key) {
  const mon = engulfMonitors[key];
  if (mon.interval) { clearInterval(mon.interval); mon.interval = null; }   // legacy path
  if (mon.poller) { mon.poller.stop(); mon.poller = null; }
  mon.running = false;
  broadcast({ type: 'engulf-monitor-status', tf: key, running: false });
  console.log(`Engulf monitor stopped [${ENGULF_TFS[key].label}]`);
}

async function checkEngulfingSignal(key) {
  key = ENGULF_TFS[key] ? key : '1h';
  const cfg = ENGULF_TFS[key];
  const mon = engulfMonitors[key];

  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'engulf-check', tf: key, time: new Date().toISOString(), found: false, status: 'TV offline' });
    return;
  }

  mon.lastCheck = new Date().toISOString();
  mon.lastError = null;
  let found = false;
  let direction = null;
  let source = null;

  try {
    // FIX (2026-08-06): market_multi_tf never existed as a real tool — see
    // gatherPO3Context's fix above. getBarsAndLabels switches the chart to
    // cfg.tfCode, collects bars + Pine labels/study values, then restores
    // whatever TF was showing before — same contract the old comment claimed
    // market_multi_tf had, now actually true.
    const { bars: rawBars, labelText } = await getBarsAndLabels(cfg.tfCode, 5);
    // Closed candles only. The last bar getBarsAndLabels returns is still
    // forming, so the old code re-read a moving high/low/close on every poll
    // and could report an engulfing that vanished by the close. Same fix
    // checkSFPSignal got on 2026-07-15; engulf and FVG never received it.
    const bars = playbookC.dropFormingBar(rawBars, cfg.tfCode);

    // ── Method 1/2: indicator label or study-value text mentions engulfing ──
    if (/bull[^|]{0,30}engulf|engulf[^|]{0,30}bull/i.test(labelText)) {
      found = true; direction = 'BULLISH'; source = `${cfg.label} indicator`;
    } else if (/bear[^|]{0,30}engulf|engulf[^|]{0,30}bear/i.test(labelText)) {
      found = true; direction = 'BEARISH'; source = `${cfg.label} indicator`;
    }

    // ── Method 3: real full-range engulfing on parsed OHLCV bars ─────────────
    if (!found) {
      const engulf = detectEngulfFromBars(bars);
      if (engulf) {
        found = true; direction = engulf.direction; source = `${cfg.label} OHLCV (full-range)`;
      }
    }

    // ── Playbook C validity gate (2026-08-22) ────────────────────────────────
    // Until now the comment above claimed "(Playbook C)" but detectEngulfFromBars
    // only checks the full-range condition — 1 of the rulebook's 4. The two it
    // skipped (swing location, liquidity already swept) are the two that separate
    // a reversal from a continuation candle mid-trend, so this monitor alerted on
    // candles Anoop's own rules disqualify, with nothing saying the check was
    // skipped. The gate applies to ALL candidates including Pine-label hits,
    // since a chart indicator has no idea about his structure rules either.
    //
    // Rejections are BROADCAST, not swallowed: seeing which candles are filtered,
    // and why, is how the thresholds get tuned from evidence. A rejection is not
    // a missed trade.
    // ── THE HTF READ — EVIDENCE FOR PLAYBOOK A, NOT A GATE (2026-09-03) ──
    // Anoop: "playbook A should be active in both direction and should intimate
    // me when any engulfing in any direction takes place after which i will
    // decide manually which side should i take the entry at."
    //
    // So the gate no longer refuses an engulf alert. It is still READ — once,
    // here, and shared with everything downstream — and its verdict travels on
    // the alert so he can see he is looking at a bullish candle inside a
    // bearish 15M structure and choose. Deciding the side is the judgment he
    // has explicitly taken back; suppressing the candle took the decision away
    // from him by never mentioning it happened.
    //
    // The gate still VETOES Playbook B (checkSFPSignal) and Playbook C-ADX.
    // Those two produce a specific entry and stop and, via the debate, can end
    // in a real order — A is an alert asking him to look at the chart. Widening
    // both off one instruction about alerts would multiply order-adjacent
    // activity as a side effect, which is his call and not one to infer.
    //
    // Declared out here because three things downstream need the SAME read:
    // this evidence, the Playbook C structure argument, and the alert's
    // alignment note. Reading it three times would let the alert describe a
    // different higher timeframe than the one it was judged against.
    let htfRead = null;
    let htfAlign = null;   // checkSetup() verdict for THIS candle's direction
    if (found && direction) {
      htfRead = await readHTFNow();
      htfAlign = htfAlignment.checkSetup(htfRead, direction);
      // Deliberately NOT ledgered as an `htf-reject` row, unlike htfGate() on
      // the gated playbooks. Nothing was rejected here, and an htf-reject row
      // means "this was blocked" to every reader of the ledger — writing one
      // for a signal that then fires anyway would corrupt the "what was
      // suppressed" count, which is the exact question this change was made to
      // answer. The measurement lives on the fired row instead, which carries
      // htfBias + structure15m + htfConfirmation, so "how do against-bias
      // alerts perform" is still answerable without inventing a phantom block.
      if (!htfAlign.allowed) {
        console.log('HTF (evidence, not a veto) [A ' + cfg.tfCode + ']: ' + htfAlignment.explain(htfAlign));
      }
    }

    let pbc = null;
    let fullBars = null;   // hoisted: the fire site below needs the trigger bar to plan entry/stop
    let pdhpdl = null;     // hoisted for the same reason — the fire site's key-level annotation reads it
    if (found && direction) {
      // 5 bars cannot support a structure read — pull real history the same way
      // checkSFPSignal does, then drop the still-forming bar.
      fullBars = playbookC.dropFormingBar(
        await getFullBars(cfg.tfCode, playbookC.PBC_HISTORY_BARS), cfg.tfCode);
      pdhpdl = await getPDHPDL();
      // Structure argument: HH-HL is read on the 15M only (2026-09-03; it was
      // the 1H from 2026-09-01), so the check is handed the same 15M structure
      // the read above produced rather than recomputing it from this watcher's
      // own timeframe — which on the 5M would flip several times an hour.
      pbc = playbookC.validateEngulfPlaybookC(fullBars, direction, pdhpdl, htfRead && htfRead.structure15m);
      // ── SHAPE STILL VETOES; CONTEXT NOW ONLY REPORTS (2026-09-03) ────────
      // Requirements 1-2 are what MAKES a candle an engulfing — colour flip,
      // both extremes taken, body over body. A candle failing one of those is
      // not a disqualified engulfing, it is not one, and announcing it would
      // make the alert false. That stays a rejection.
      //
      // Requirements 3-5 — structure, swing location, resting liquidity —
      // answer "is this a good place to take it", which is the judgment Anoop
      // has taken back. They still run, and their verdict rides on the alert.
      //
      // This is the change that actually unblocks the watchers. Measured on the
      // ledger to date, 52 candidates were rejected here and 41 of them (79%)
      // failed on requirement 3 alone — 27 of those on "found mixed/ranging",
      // i.e. structure the app could not read rather than structure that
      // disagreed. Almost every engulf he never heard about died on that line.
      //
      // A DATA verdict (not enough bars) is treated as a veto too: alerting off
      // a window too short to judge would be asserting a shape the app has not
      // actually verified.
      const shapeFailed = !pbc.valid
        && (pbc.stage === playbookC.STAGE.SHAPE || pbc.stage === playbookC.STAGE.DATA);
      if (shapeFailed) {
        const rejectKey = direction + '_' + key + '_rej_' +
          (fullBars.length ? fullBars[fullBars.length - 1].time : 0);
        if (rejectKey !== mon.lastRejectKey) {
          mon.lastRejectKey = rejectKey;
          console.log(`ENGULF REJECTED [${cfg.label}]: ${direction} — ${pbc.reason}`);
          // 2.1: rejections are data — the filter rate per TF is only
          // measurable if rejections are written.
          ledgerSignal({ event: 'playbook-c-reject', playbook: 'A', tf: cfg.tfCode, direction, source, valid: false, rejectReason: pbc.reason, structure: pbc.structure });
        }
        broadcast({
          type: 'engulf-check', tf: key, time: mon.lastCheck,
          found: false, rejected: true, direction,
          reason: pbc.reason, structure: pbc.structure
        });
        return;
      }
      // A context failure is still WRITTEN — it is now the difference between
      // an A-grade setup and a bare candle, and pooling the two unlabelled
      // would make the forward test measure a rule nobody trades.
      if (!pbc.valid) {
        console.log(`ENGULF CONTEXT [${cfg.label}]: ${direction} — ${pbc.reason} (alerting anyway; his call)`);
      }
    }

    // ── Fire notification if found and not duplicate ─────────────────────────
    if (found && direction) {
      // Dedup on the TRIGGER BAR, not on wall-clock. The old key was a 15-minute
      // bucket, which on a 5M/15M watcher silently swallowed a second genuine
      // engulf inside the same bucket and, worse, tied "is this new?" to the
      // clock instead of to the candle that caused it. Keyed by bar time, every
      // distinct closed candle reports exactly once, immediately after its close.
      const engulfBar = (fullBars && fullBars.length) ? fullBars[fullBars.length - 1] : null;
      const bucket = direction + '_' + key + '_' + (engulfBar
        ? engulfBar.time
        : Math.floor(Date.now() / (15 * 60 * 1000)));
      if (bucket !== mon.lastSignalKey) {
        mon.lastSignalKey = bucket;
        const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

        // ── Alignment is the GATE's answer now, not a second opinion ─────
        // This used to run its own get4HTrend() read, for the 1H watcher only,
        // and decide "Playbook A valid" from it. Both halves are obsolete:
        //
        //   • The htfGate() above already read the higher timeframe, so a
        //     second get4HTrend() here could only re-read the same chart over
        //     the same connection and risk a DIFFERENT answer than the one
        //     that admitted the trade. Note it no longer guarantees the setup
        //     is with-4H-trend — since 2026-09-01 the 4H cannot veto, it only
        //     reports — which is precisely why the note below must state what
        //     it said instead of assuming agreement.
        //   • It only ran for `1h`, because Playbook A used to mean the 1H
        //     watcher alone. All four engulf watchers are Playbook A now
        //     (Anoop, 2026-09-01), so a 1H-only alignment note would leave the
        //     15M/30M/5M alerts silently unannotated.
        //
        // The note now reports the read's own numbers, so the message and the
        // decision cannot disagree.
        //
        // 2026-09-03: with A ungated, this note is the ONLY thing standing
        // between him and an alert that looks identical whether it points with
        // the day's structure or straight against it. So it says three things
        // now, in descending order of how much they should give him pause:
        //
        //   1. WITH / AGAINST the 15M bias        <- new; A used to be refused
        //                                            outright when against
        //   2. what the 1H said about that bias   <- the confirmationNote
        //   3. the context verdict (structure, swing location, liquidity)
        //
        // Point 1 leads because it is the one the old code expressed by
        // silence. An alert that fires in both directions and describes neither
        // is not more information than a gate, it is less.
        const againstBias = !!(htfAlign && !htfAlign.allowed && htfRead && htfRead.ok);
        const biasNote = !(htfRead && htfRead.ok)
          ? ' — NO 15M BIAS (structure unreadable) — your read'
          : againstBias
            ? ` — AGAINST the ${htfRead.bias} 15M bias`
            : ` — WITH the ${htfRead.bias} 15M bias`;
        const alignNote = htfRead && htfRead.ok
          ? `${biasNote}, ${htfAlignment.confirmationNote(htfRead)}`
          : biasNote;
        // The Playbook A context verdict, stated whichever way it went. "valid
        // setup" and "candle only" are different trades and the alert has to
        // say which one this is — that distinction is the entire cost of taking
        // the gate off, and hiding it would be paying the cost without buying
        // anything.
        const qualityNote = pbc
          ? (pbc.valid ? ' | A-grade setup' : ` | CANDLE ONLY — ${pbc.reason}`)
          : '';
        // ── The SIGNAL fires ungated; the DEBATE does not ──────────────────
        // Anoop's 2026-09-03 instruction removed the gate from what may TRIGGER
        // an alert. It said nothing about the debate, and the debate is not
        // just louder output — it is the path that can emit a TRADE_TICKET,
        // which is the only route in this app to a real order. Alerts are now
        // strictly more frequent than before in both directions; inheriting
        // that here would quietly multiply order-adjacent activity off an
        // instruction that was explicitly about him deciding manually.
        //
        // So this keeps the STRICTEST meaning available: the full Playbook A
        // setup, with the 15M bias, and the 1H confirming it. Widening it is
        // his call to make, not a side effect of this change.
        const playbookAFullyAligned = !!(htfRead && htfRead.ok &&
          htfAlign && htfAlign.allowed &&
          pbc && pbc.valid &&
          htfRead.confirmation === htfAlignment.CONFIRMATION.CONFIRMED);

        // ── Where it happened, and what it happened AT ────────────────────
        // 2026-08-27: the alert used to name only the direction, the TF and
        // the wall-clock time it was NOTICED — which is not the time the
        // candle closed, and gave nothing to find the candle by on the chart.
        // It now carries the closed candle's own time and price, plus any key
        // level its range actually traded through, so a manual re-check is a
        // lookup rather than a hunt. None of this can reject a signal.
        const barCloseIST = engulfBar
          ? barTimeToDate(engulfBar.time).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
          : null;
        let levelNote = '';
        try {
          const swings = fullBars && fullBars.length ? getSwingLevels(fullBars) : { swingHighs: [], swingLows: [] };
          const pwhpwl = await getPrevWeekHighLow();
          const pool = [
            pdhpdl && { name: 'PDH', price: pdhpdl.pdh },
            pdhpdl && { name: 'PDL', price: pdhpdl.pdl },
            pwhpwl && { name: 'PWH', price: pwhpwl.pwh },
            pwhpwl && { name: 'PWL', price: pwhpwl.pwl },
            ...(swings.swingHighs || []).map(p => ({ name: 'swing high', price: p })),
            ...(swings.swingLows || []).map(p => ({ name: 'swing low', price: p })),
          ].filter(Boolean);
          const hits = engulfBar ? playbookC.nearbyKeyLevels(engulfBar, pool) : [];
          if (hits.length) levelNote = ` — AT ${hits.map(h => `${h.name} ${h.price}`).join(', ')}`;
        } catch (e) {
          // Annotation only. A level lookup must never cost him the alert.
          console.error(`Engulf [${cfg.label}] level annotation failed:`, e.message);
        }

        const whereNote = engulfBar
          ? ` | candle ${barCloseIST} IST close ${engulfBar.close}`
          : '';
        const signalMessage = `${direction} Engulfing on ${cfg.label}${whereNote}${levelNote}${alignNote}${qualityNote} — closed candle, body fully engulfed; you pick the side`;
        broadcast({
          type: 'engulf-signal',
          // Playbook A on every watcher (2026-09-01). This was the LAST place
          // the timeframe still decided the playbook name, and it is the one
          // the UI reads — so a 30M engulf would have gone on announcing
          // itself as "C" in the chip and the history panel long after the
          // ledger, the setup card and the spec had all agreed it was A.
          playbook: 'A',
          structure: pbc ? pbc.structure : null,
          validity: pbc ? pbc.reason : null,
          // 2026-09-03: whether the full Playbook A setup held, separately from
          // whether an engulfing candle closed. Both are true things and the UI
          // must be able to render them differently — since the gate came off,
          // an alert no longer implies a setup.
          setupValid: pbc ? !!pbc.valid : null,
          againstBias,
          // The higher-timeframe evidence rides WITH the signal. The UI needs
          // to be able to show a 15M-only trigger differently from a fully
          // aligned one; without these it could only repeat the message text.
          htfBias: htfRead ? htfRead.bias : null,
          structure15m: htfRead ? htfRead.structure15m : null,
          structure1h: htfRead ? htfRead.structure1h : null,
          htfConfirmation: htfRead ? htfRead.confirmation : null,
          tf: key,
          tfLabel: cfg.label,
          direction,
          source,
          time: istTime,
          barTime: engulfBar ? engulfBar.time : null,
          barCloseIST,
          price: engulfBar ? engulfBar.close : null,
          levelNote: levelNote || null,
          message: signalMessage
        });
        // Push the same signal to Telegram (no-op/silent if no chat linked yet).
        // NOTE: this is the only server-side push alert wired up. Daily-loss-tier
        // pattern warnings (checkForPatternWarnings) still live client-only in
        // renderer/app.js and are NOT pushed to Telegram — see telegram-bot.js
        // header comment for what porting that would require.
        telegramBot.notify(`⚡ ${signalMessage}`);
        console.log(`ENGULF SIGNAL [${cfg.label}]: ${direction} [${source}]${alignNote}`);
        // 2.1/2.2: ledger the accepted setup + arm it (A on 1h, C on 30m/15m).
        // 2026-08-26: attach the actual TRADE (entry/stop/setupId), not just
        // the candle name. Until now every engulf-fire row carried level:null,
        // which is why signal-outcome.js could never score one. The playbook id
        // sent to the spec is the honest one — a 30M/15M engulf is LTF-ENGULF,
        // not Playbook C (which is a gate, see playbook-spec.js) — while the
        // ledger's own `playbook` field keeps its existing value so nothing
        // downstream that groups by it changes shape mid-dataset.
        // ── ONE playbook for every engulf watcher (Anoop, 2026-09-01) ────
        // "I want all the monitors which are always on to be part of Playbook
        //  A... That is the only Playbook A setup. There is nothing else in
        //  Playbook A."
        //
        // This was `key === '1h' ? 'A' : 'LTF-ENGULF'` — one ternary that made
        // the timeframe decide the playbook name. A 1H engulf was Playbook A;
        // the identical candle on 30M was LTF-ENGULF, a setup that appeared in
        // no rulebook and no Pine script, and the ledger tagged it 'C' (the
        // validity GATE) on the way there. Three names for one detector.
        //
        // Engulfing is timeframe-agnostic by definition — Anoop, same day: the
        // next candle takes out the previous candle's wick on both sides and
        // covers its body, "it applies to all the time frames". So the
        // timeframe is an ATTRIBUTE of the signal, never its identity, and it
        // travels on every alert, chip, card, ledger row and Telegram push so
        // a 15M engulf is never mistaken for a 1H one.
        const specId = 'A';
        const engulfPlan = engulfBar
          ? playbookSpec.planEntry(specId, { direction, bar: engulfBar, barTime: engulfBar.time, entryRef: engulfBar.close }, getActiveRules())
          : { plannable: false };

        // ── AN ALERT IS NOT AN ARMED SETUP (2026-09-03) ──────────────────
        // Ungating the alert quietly ungated five other things, because
        // `engulf-fire` is a load-bearing NAME, not just a log line:
        //
        //   • signal-outcome.js ARMING_EVENTS scores every engulf-fire row
        //   • signal-join.js ARMING_EVENTS lets one back a real trade
        //   • renderer/scorecard.js counts them as Playbook A fires
        //   • armSetup() records a shadow MACHINE ORDER for each one
        //   • armSetup() pushes a shadow TICKET (entry/stop/target in $) into
        //     the chat — the exact thing Anoop switched off on 2026-08-26:
        //     "it has created confusion when i was trading live"
        //
        // None of those five check `valid`. So writing a bare against-bias
        // candle as `engulf-fire` would have multiplied all of them ~3.8x and
        // pooled two different populations under one name — making the forward
        // test measure a rule nobody trades, and burying the strict setups he
        // DOES trade in noise. Storing `quality` on the row does not help: it
        // makes the populations separable in the FILE while every consumer
        // still pools them.
        //
        // So the split is by EVENT NAME, which every consumer already keys on:
        //   engulf-fire  — the full Playbook A setup, with the 15M bias.
        //                  Identical meaning to every row already on disk, so
        //                  the history stays comparable. Armed and scoreable.
        //   engulf-alert — every other closed engulfing. He is TOLD (broadcast,
        //                  Telegram, chat, chime, UI all fire below regardless);
        //                  the machine arms nothing and claims nothing.
        //
        // This is the same line the debate trigger is held to: he asked for
        // more ALERTS, not for more machine activity.
        const isFullSetup = !!(htfRead && htfRead.ok && htfAlign && htfAlign.allowed && pbc && pbc.valid);
        ledgerSignal({
          event: isFullSetup ? 'engulf-fire' : 'engulf-alert',
          playbook: 'A', tf: cfg.tfCode, direction, source,
          structure: pbc ? pbc.structure : null,
          // 2026-09-03: A fires in both directions now, so `valid` alone can no
          // longer separate the populations — every row would read true. These
          // five are what make the forward test answerable afterwards: was it a
          // full setup or a bare candle, did it point with or against the 15M
          // bias, and did the 1H back that bias.
          valid: pbc ? !!pbc.valid : true,
          quality: pbc ? pbc.reason : null,
          // NOT also written to `rejectReason`. Nothing was rejected — the
          // alert fired. rejectReason means "this was blocked" to every reader
          // of the ledger, and duplicating the string into it would put these
          // rows into the blocked-reason tally alongside the candles that were
          // genuinely suppressed. Same reason the ungated path above writes no
          // htf-reject row: a count of what the app SUPPRESSED has to stay
          // countable, and it is the number this whole change was judged on.
          htfBias: htfRead ? htfRead.bias : null,
          structure15m: htfRead ? htfRead.structure15m : null,
          structure1h: htfRead ? htfRead.structure1h : null,
          htfConfirmation: htfRead ? htfRead.confirmation : null,
          entry: engulfPlan.plannable ? engulfPlan.entry : null,
          stop: engulfPlan.plannable ? engulfPlan.stop : null,
          setupId: engulfBar ? playbookSpec.setupId(specId, { direction, barTime: engulfBar.time, entryRef: engulfBar.close }) : null,
        });
        // Arm ONLY the full setup — see the note above. armSetup writes a
        // shadow machine order and pushes a $-denominated ticket into the chat,
        // and neither should happen for a candle he was merely told about.
        if (isFullSetup) {
          armSetup({
              playbook: 'A', tfCode: cfg.tfCode, tfLabel: cfg.label, direction,
              bar: engulfBar, barTime: engulfBar ? engulfBar.time : null,
              entryRef: engulfBar ? engulfBar.close : null,
              setupId: engulfBar ? playbookSpec.setupId(specId, { direction, barTime: engulfBar.time, entryRef: engulfBar.close }) : null,
              structure: pbc ? pbc.structure : null,
              message: signalMessage,
            });
        }
        // 3.3: a FULL Playbook A setup convenes the debate — see
        // playbookAFullyAligned above for why this one did NOT follow the
        // trigger when the trigger was ungated on 2026-09-03.
        if (key === '1h' && playbookAFullyAligned) {
          triggerPlaybookDebate({ playbook: 'A', tfCode: cfg.tfCode, tfLabel: cfg.label, direction, time: istTime });
        }
      }
    }

    broadcast({ type: 'engulf-check', tf: key, time: mon.lastCheck, found, direction });

  } catch (e) {
    mon.lastError = e.message;
    console.error(`Engulf monitor [${cfg.label}] error:`, e.message);
    broadcast({ type: 'engulf-check', tf: key, time: mon.lastCheck, found: false, status: 'error: ' + e.message });
  }
}

// Full-range engulfing per Playbook C: the current bar must take out BOTH the
// high AND the low of the previous bar (not just overlap its open/close body,
// which is what the old body-only check did). Direction must also be the
// opposite of the previous bar's direction.
// detectEngulfFromBars() moved to detectors.js (2026-08-26) so the backtest harness can
// import the SAME function this server fires on. Behaviour unchanged.

// ── 4H trend read for Playbook A's alignment gate ───────────────────────────
// Approximation, not true swing-pivot market structure: market_multi_tf only
// ever returns the last 5 bars per TF, so this is a bar-over-bar higher-high/
// higher-low majority vote across those 5 bars, not a real multi-week HH-HL /
// LL-LH structure read. Good enough as a directional filter; not a substitute
// for actually looking at the 4H chart yourself on a borderline call.
let trendCache = { value: null, at: 0 };
async function get4HTrend() {
  // Cache for 3 minutes so a burst of 1H checks doesn't spam an extra
  // market_multi_tf call every time.
  if (trendCache.value && Date.now() - trendCache.at < 3 * 60 * 1000) return trendCache.value;
  try {
    // FIX (2026-08-06): market_multi_tf never existed as a real tool (see
    // gatherPO3Context's fix above) — swapped for getFullBars, same real
    // mechanism, same 5-bar count to preserve this function's documented
    // "majority vote across the last 5 bars" behavior unchanged.
    const bars = await getFullBars('240', 5);
    const trend = classifyTrendFromBars(bars);
    trendCache = { value: trend, at: Date.now() };
    return trend;
  } catch (e) {
    console.error('4H trend read error:', e.message);
    return 'unclear';
  }
}

// classifyTrendFromBars() moved to detectors.js (2026-08-26) so the backtest harness can
// import the SAME function this server fires on. Behaviour unchanged.

// ── Fair Value Gap (FVG) detector — Playbook B's displacement step ─────────────
// Classic 3-candle gap: bar[i-2] and bar[i] leave a price range bar[i-1] never
// traded into. Bullish FVG when bar[i-2].high < bar[i].low (gap up); bearish
// when bar[i-2].low > bar[i].high (gap down). This detects the gap existing —
// it does NOT confirm the SFP/liquidity-raid that should precede it per the
// full JadeCap playbook. See FVG_TFS block below for why that part is deferred.
// detectFVGFromBars() moved to detectors.js (2026-08-26) so the backtest harness can
// import the SAME function this server fires on. Behaviour unchanged.

// ── FVG monitor (30M — switched from 15M 2026-07-28) ───────────────────────────
const FVG_TFS = {
  '30m': { tfCode: '30', label: '30M', intervalMs: 30 * 1000 }
};
const fvgMonitors = {};
for (const k of Object.keys(FVG_TFS)) {
  fvgMonitors[k] = { running: false, interval: null, lastSignalKey: null, lastCheck: null, lastError: null, restartAttempted: false }; // 1.4 liveness
}

// 1.2 (plan decision 2): FVG watcher is always on — no supported OFF.
// The handler stays so an old client/Telegram 'off' is refused with a status
// line instead of leaving the watcher dark.
function handleFVGToggle(msg) {
  const key = FVG_TFS[msg.tf] ? msg.tf : '30m';
  if (msg.enabled) { startFVGMonitor(key); return; }
  broadcast({ type: 'fvg-monitor-status', tf: key, running: true, alwaysOn: true, note: `FVG ${FVG_TFS[key].label} watcher is always on — 'off' is not supported.` });
  console.log(`FVG ${FVG_TFS[key].label}: 'off' refused — watchers are always on`);
}

function startFVGMonitor(key) {
  stopFVGMonitor(key);
  const mon = fvgMonitors[key];
  mon.running = true;
  broadcast({ type: 'fvg-monitor-status', tf: key, running: true });
  console.log(`FVG monitor started [${FVG_TFS[key].label}]`);
  checkFVGSignal(key);
  mon.poller = barSchedule.startBarAlignedPoll(FVG_TFS[key].tfCode, () => checkFVGSignal(key), { fallbackIntervalMs: FVG_TFS[key].intervalMs });
}

function stopFVGMonitor(key) {
  const mon = fvgMonitors[key];
  if (mon.interval) { clearInterval(mon.interval); mon.interval = null; }   // legacy path
  if (mon.poller) { mon.poller.stop(); mon.poller = null; }
  mon.running = false;
  broadcast({ type: 'fvg-monitor-status', tf: key, running: false });
  console.log(`FVG monitor stopped [${FVG_TFS[key].label}]`);
}

async function checkFVGSignal(key) {
  key = FVG_TFS[key] ? key : '30m';
  const cfg = FVG_TFS[key];
  const mon = fvgMonitors[key];

  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'fvg-check', tf: key, time: new Date().toISOString(), found: false, status: 'TV offline' });
    return;
  }

  mon.lastCheck = new Date().toISOString();
  mon.lastError = null;
  let found = false, direction = null, gapLow = null, gapHigh = null;

  try {
    // FIX (2026-08-06): market_multi_tf never existed as a real tool — see
    // gatherPO3Context's fix above. detectFVGFromBars only looks at the last
    // 3 bars, so 5 is ample.
    // Closed candles only (see checkEngulfingSignal). A 15M gap that opens at
    // minute 3 and closes by minute 15 is not a gap. detectFVGFromBars needs 3.
    const bars = playbookC.dropFormingBar(await getFullBars(cfg.tfCode, 6), cfg.tfCode);
    if (bars.length < 3) {
      broadcast({ type: 'fvg-check', tf: key, time: mon.lastCheck, found: false, status: 'waiting for a closed ' + cfg.label + ' bar' });
      return;
    }
    const fvg = detectFVGFromBars(bars);
    if (fvg) {
      found = true; direction = fvg.direction; gapLow = fvg.gapLow; gapHigh = fvg.gapHigh;
      // DEDUP ON THE GAP ITSELF, NOT ON THE WALL CLOCK (fixed 2026-08-26).
      //
      // The old key was `direction + tf + floor(now / 15min)`, which changes
      // every 15 minutes of real time regardless of whether anything on the
      // chart changed. A 30M gap stays the newest 3-bar pattern for a full 30
      // minutes — at least two buckets — so every single 30M FVG fired at
      // least twice, and a monitor restart reset the key and fired it again.
      //
      // This is visible in the live ledger: DATA/signals/2026-08-24.jsonl has
      // gap 29204.00-29205.75 logged at 11:30 and again at 11:45, and gap
      // 29137.50-29156.75 logged four separate times between 16:30 and 16:56.
      // Ten of that day's eleven armed signals are re-fires of four real
      // setups. Beyond the duplicate Telegram alerts, it silently corrupts
      // every per-playbook statistic downstream — a setup that happened to
      // work counts once for each time it was re-seen.
      //
      // The gap's own prices are stable across polls, so keying on them fires
      // once per real setup and never again.
      const bucket = playbookSpec.setupId('B', { direction, gapLow, gapHigh, level: null });
      if (bucket !== mon.lastSignalKey) {
        mon.lastSignalKey = bucket;
        const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        const signalMessage = `${direction} FVG on ${cfg.label} at ${istTime} IST — gap ${gapLow.toFixed(2)}-${gapHigh.toFixed(2)}, watch for retrace entry`;
        broadcast({ type: 'fvg-signal', tf: key, tfLabel: cfg.label, direction, gapLow, gapHigh, time: istTime, message: signalMessage });
        telegramBot.notify(`🔲 ${signalMessage}`);
        console.log(`FVG SIGNAL [${cfg.label}]: ${direction} ${gapLow.toFixed(2)}-${gapHigh.toFixed(2)}`);
        // 2.1/2.2: ledger + arm the displacement FVG.
        // A bare FVG has no SFP behind it, so there is no wick to stop beyond
        // and planEntry correctly refuses. entry is still recorded (the near
        // gap edge is where a retrace entry would go on) so the outcome
        // resolver has an anchor; stop stays null rather than invented.
        // ── 2026-09-01: a bare FVG is NOT a Playbook B setup ───────────────
        // The rulebook (Prop Trading/CLAUDE.md, Playbook B) is a THREE-step
        // sequence, and the gap is step 3: "Liquidity Raid (SFP)" must come
        // first, and the stop is defined as "SL beyond SFP wick". A gap with
        // no raid behind it has no trap candle and therefore no stop — which
        // is why planEntry has always refused to plan one.
        //
        // It was nonetheless tagged `playbook: 'B'` AND passed to armSetup,
        // which renders the app's most actionable notification: the "Setup
        // live - Playbook B" card with Took it / Passed buttons. So the
        // thing that was NOT a setup got the confident UI while the real raid
        // got a cautious "NOT a trade yet" line. Anoop caught this live on
        // 2026-09-01: a BEARISH bare gap was announced as Playbook B at
        // 15:30, ninety minutes before the session's only actual raid, which
        // was BULLISH — an unrelated event wearing the setup's name.
        //
        // The measurement damage was worse than the noise: the live ledger
        // held 71 sfp-raid + 33 fvg-fire + 4 playbook-b-confirm rows, all
        // tagged 'B'. Anyone asking "how often does B fire" read 108 when the
        // answer was 4.
        //
        // The detection still broadcasts and still alerts - a gap IS worth
        // seeing. It is tagged FVG-ONLY so it stops being counted as B, and
        // it no longer arms a setup card, because there is no setup to arm.
        const fvgEntry = direction === 'BULLISH' ? Math.max(gapLow, gapHigh) : Math.min(gapLow, gapHigh);
        ledgerSignal({
          event: 'fvg-fire', playbook: 'FVG-ONLY', tf: cfg.tfCode, direction, gapLow, gapHigh, source: 'FVG OHLCV',
          entry: fvgEntry, stop: null,
          setupId: playbookSpec.setupId('FVG-ONLY', { direction, gapLow, gapHigh, level: null }),
        });
      }
    }
    broadcast({ type: 'fvg-check', tf: key, time: mon.lastCheck, found, direction });
  } catch (e) {
    mon.lastError = e.message;
    console.error(`FVG monitor [${cfg.label}] error:`, e.message);
    broadcast({ type: 'fvg-check', tf: key, time: mon.lastCheck, found: false, status: 'error: ' + e.message });
  }
}

// ── SFP / liquidity-raid detector — Playbook B's missing first two steps ──────
// Previously only the FVG (displacement) half of JadeCap's 3-step was detected.
// This closes the gap: detects the liquidity raid itself (price sweeps a key
// level — PDH/PDL or a recent swing high/low — then closes back inside it),
// holds that as a "pending" state, and only fires the real Playbook B signal
// once a matching-direction FVG (displacement) shows up afterward. A raid with
// no follow-through displacement expires unfired — JadeCap explicitly says not
// to chase a stale setup, so this does not either.
//
// market_multi_tf caps out at 5 bars per timeframe (see get4HTrend's comment
// above), which isn't enough to find swing highs/lows or a prior-day high/low.
// So this section pulls full bar history directly via chart_set_timeframe +
// data_get_ohlcv (count up to 500), restoring the chart's original timeframe
// afterward — same "don't leave the user's chart on the wrong TF" contract
// market_multi_tf itself follows, just built manually since that tool can't
// return enough bars for this.

// Generic JSON-result parser (parseMultiTFResult does the same thing but is
// named for that one call site — reused here under a name that doesn't imply
// multi-TF specifically).
function parseToolResult(res) {
  try {
    const raw = res && res.content && res.content[0] && res.content[0].text;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Deterministic chart maths (EMA, Doji, swing structure, alignment) lives in
// chart-reads.js — pure functions, unit-tested in test/chart-reads.test.js.
// See that file's header for WHY these are computed rather than asked of a model.
const chartReads = require('./chart-reads');

// LIVE_FEED_LOOP_PLAN 0.1 — chart bar-read cache (see chart-bar-cache.js).
// Collapses N monitors reading the same (symbol, tf, count) into one chart
// operation; a separate instance holds the Pine label-text reads that ride
// along with getBarsAndLabels, so each gets the timeframe's own TTL.
const chartBarCache = require('./chart-bar-cache');
const barCache = new chartBarCache.ChartBarCache();
const barLabelCache = new chartBarCache.ChartBarCache();

// 2.1: signal ledger — server-side JSONL of every watcher fire AND rejection
// (pure row building in signal-ledger.js; fs wiring below).
const signalLedger = require('./signal-ledger');
const signalOutcome = require('./signal-outcome'); // MFE/MAE for signals whether or not they were taken (unit-tested)

// 3.1: market-state line — pure formatter (market-state.js) for the armed
// setup + mechanical 1H bias injected into the shared agent context block.
const marketState = require('./market-state');

// 4.1: joins fold-scored closes (exact $ P&L) with order-walk round trips
// (symbol/side/prices/times) into one record per trade.
const tradeRecordJoin = require('./trade-record-join');

// 4.2/4.3: the SAME day-rollup the renderer's CSV path uses (UMD module) —
// the live writer grades and rolls up with the identical functions, so the
// two producers can never diverge.
const dayRollup = require('./renderer/day-rollup');

// 5.1: joins a closed fill back to the nearest preceding armed signal.
const signalJoin = require('./signal-join');

// 6.2: hour-of-day edge table — reporting only, never a gate (decision 6).
const hourEdgeModule = require('./hour-edge');
let hourEdgeTable = {};
function refreshHourEdge() {
  try {
    const slot = jessiBucketKey(loadConfig());
    const dt = dataLoad('day_trades__' + slot) || {};
    const days = Object.keys(dt).map(d => ({ rows: Array.isArray(dt[d]) ? dt[d] : [] }));
    hourEdgeTable = hourEdgeModule.buildHourEdge(days);
    fs.writeFileSync(path.join(DATA_DIR, 'hour-edge.json'), JSON.stringify(hourEdgeTable, null, 2), 'utf8');
    console.log('[hour-edge] table rebuilt from ' + days.length + ' days (' + Object.keys(hourEdgeTable).length + ' hour buckets)');
  } catch (e) {
    console.error('[hour-edge] build failed:', e.message);
  }
}

// Defensively pull a bar array out of whatever shape data_get_ohlcv returns —
// the exact field name isn't nailed down from a live call, so this tries the
// common candidates rather than assuming one and silently returning nothing.
function extractBarsArray(parsed) {
  if (!parsed) return [];
  let bars = parsed.bars || parsed.data || parsed.ohlcv || parsed.result || parsed;
  if (bars && !Array.isArray(bars) && bars.bars) bars = bars.bars;
  if (!Array.isArray(bars)) return [];
  return bars
    .filter(b => b && typeof b.open === 'number' && typeof b.high === 'number' && typeof b.low === 'number' && typeof b.close === 'number')
    .map(b => ({ time: b.time || b.t || 0, open: b.open, high: b.high, low: b.low, close: b.close }))
    .sort((a, b) => a.time - b.time);
}

// Switch the chart to tfCode, pull `count` full bars, restore the original
// timeframe — always, even on error (finally block).
// Some timeframe codes come back reported differently than they're set —
// e.g. chart_set_timeframe accepts 'D' but chart_get_state reports the
// resolution back as '1D'. Accept either form when confirming the switch
// actually landed.
function timeframeMatches(reported, requested) {
  if (!reported) return false;
  const r = String(reported), q = String(requested);
  if (r === q) return true;
  if (['D', 'W', 'M'].includes(q)) return r === '1' + q;
  return false;
}

// CHART LOCK (added 2026-07-28): getFullBars mutates GLOBAL UI state — it
// switches the live chart's timeframe, reads, then restores. Two overlapping
// calls therefore corrupt each other: A switches to D, B switches to 60, A
// reads and silently gets B's timeframe data, then they restore in the wrong
// order. This was a live risk the moment runMechanicalAnalysis started
// Promise.all-ing a Daily and a 1H read. Serialize every caller through one
// promise chain so only one chart switch is ever in flight.
//
// 2026-08-19 BUG FIX (found live, Anoop's own multi-hour soak test — exactly
// what it was for): this had NO timeout. Every caller — pollTVBrokerAccount,
// the startup self-test, PO3/Engulf/SFP monitors, everything chart-related —
// routes through this same chain. If a single locked operation ever hung
// (a CDP hiccup, a stuck response that never resolves NOR rejects), every
// future call queued up behind it FOREVER, silently — confirmed live: zero
// real log activity for ~3 hours while TradingView/CDP itself was verified
// completely healthy via an independent connection the whole time, and the
// process itself stayed alive (an unrelated setInterval kept ticking),
// so even the HTTP-liveness watchdog would never have caught this — the
// server answered :7433 fine, it was just internally deadlocked. This is a
// second, distinct class of silent failure from Bug 5 (the server process
// itself dying) — the process survives, but the one shared resource every
// live-feed caller depends on does not.
const LOCK_TIMEOUT_MS = 30000; // generous — real chart/broker ops finish in a few seconds; this exists purely so ONE stuck call can never again freeze every future poll/monitor for hours

// 2026-08-19 BUG FIX #2 (found live, same soak test, same session): giving
// EVERY caller — chart-timeframe-switching monitors (PO3/Engulf/SFP/
// getFullBars) AND the broker-feed poll/self-test/order-confirm — one
// single shared lock meant they contended for it even though most of them
// have no actual reason to serialize against each other. Confirmed live:
// a real stop-loss fill closed Anoop's position at 15:34:59 IST; the broker
// poll's OWN call queued up behind several chart-timeframe-switch operations
// (PO3/Engulf/SFP/key-level checks, all mid-flight around a volatile moment)
// and didn't get to run — and therefore didn't record the close — until
// ~4 minutes later, well outside his explicit "within a minute" requirement.
// The timeout fix above (Bug 9) stopped this from hanging forever, but a
// 30s-capped wait behind up to ~5 queued chart operations can still add up
// to minutes — capping the wait isn't the same as removing the contention.
//
// The ORIGINAL 2026-07-28 chart-lock comment's actual concern was narrower
// than "share one lock for everything": overlapping TIMEFRAME SWITCHES
// corrupting each other (getFullBars A/B racing), and — per the 2026-08-17
// addition — a broker poll interleaving mid-ORDER-PLACEMENT specifically.
// Neither of those requires the broker feed to also wait behind PO3's
// timeframe switches. Split into two independent locks: `withChartLock`
// stays for anything that switches/reads chart timeframe or symbol
// (getFullBars, getBarsAndLabels, the PO3 secondary-symbol switch);
// `withBrokerLock` is new, used ONLY by the broker-feed poll, the self-test's
// broker/quote reads, and order confirm/placement — exactly the set of
// callers that genuinely must not interleave with EACH OTHER, and nothing
// else. The broker feed can now update within one 10s poll cycle even while
// a chart monitor is mid-timeframe-switch.
// 2026-09-02: the body of this moved to priority-lock.js so it could be unit
// tested, and gained ONE capability — a fast lane. The lock was a strict FIFO
// promise chain, so the 5s position watch that feeds the oversize guard had no
// way past the panel repairs, account polls and table refreshes queued ahead of
// it. Measured that day: broker-lock depth 7, chart-lock depth 13. He reached 16
// contracts against a cap of 2 and the app recorded a peak of 4, because the
// reads that would have caught it were waiting their turn.
//
// Every other property is preserved exactly — one operation at a time, a
// timeout that releases rather than freezes, the caller's stack captured at call
// time, and a handler always attached so a fire-and-forget call cannot turn a
// timeout into the unhandled rejection that killed the process on 2026-08-19.
// The logging stays here, in server.js, so nothing about the log output changes.
// How long a call may sit in the lock queue before it is worth saying so. Set
// against the 5s position-watch cadence: a read that waited longer than this
// describes an account state older than the next read will already have
// replaced, which is precisely the window a size breach can hide in.
const SLOW_WAIT_WARN_MS = 8000;
function makeLock(name) {
  return priorityLock.makeLock(name, {
    timeoutMs: LOCK_TIMEOUT_MS,
    onContended: (n, depth) => console.log(`[${n}] queue depth ${depth}`),
    onTimeout: (n, ms, streak, high) => console.error(
      `[${n}] operation exceeded ${ms}ms (streak: ${streak})${high ? ' [PRIORITY call — likely the position read, on its short 6s budget]' : ''} — releasing the lock for the next caller instead of freezing the whole live feed. The original call may still complete in the background; its result is discarded.`),
    // 2026-09-02: a call that WAITS too long logs nothing today, because it
    // does not fail — it succeeds, late. That is the entire 16-lot episode:
    // every queued call finished inside its budget, no timeout fired, and the
    // position read simply answered a question about 20 seconds ago. Latency
    // gets its own line so it stops being invisible.
    slowWaitMs: SLOW_WAIT_WARN_MS,
    onSlowWait: (n, waited, high) => console.warn(
      `[${n}] a ${high ? 'PRIORITY ' : ''}call waited ${Math.round(waited / 1000)}s in the queue before running`
      + ` (nothing timed out — every call ahead of it succeeded, this one was just late).`
      + (n === 'withBrokerLock' && high
        ? ' This is the position read the oversize guard acts on: for those seconds the guard was judging a stale account.'
        : '')),
  });
}
const withChartLock = makeLock('withChartLock');
const withBrokerLock = makeLock('withBrokerLock');

// 0.1: cached symbol read so cache keys can be per-symbol without adding a
// chart_get_state round-trip to every bar read. 10s staleness is safe — the
// PO3 monitor re-reads every 60s and resets its state on symbol change, and
// the secondary-symbol watch clears the bar cache on every switch.
// TICK SIZE IS READ, NEVER ASSUMED — and read RARELY. MNQ ticks at 0.25 and
// MGC at 0.10, so a constant would be silently wrong on the other symbol he
// trades; point-value-verify.js already derives it from minmov/pricescale, so
// that helper is reused rather than a second copy of the arithmetic.
//
// Cached per symbol because the alternative is a third withChartLock
// acquisition on every 60s exit-drift poll, and makeLock() names chart-lock
// saturation as this design's #1 risk. A contract's tick size does not change;
// only the symbol on the chart does, which is what the cache key tracks.
// A failed read caches NOTHING, so it retries rather than pinning null for the
// TTL — and null means exit-drift.js reports points only, never a tick count
// derived from a guessed tick size.
let tickSizeCache = { symbol: null, tickSize: null, at: 0 };
const TICK_SIZE_CACHE_TTL_MS = 10 * 60 * 1000;
async function getTickSizeCached() {
  let sym = null;
  try { sym = await getChartSymbolCached(); } catch (e) {}
  if (tickSizeCache.tickSize != null && tickSizeCache.symbol === sym
      && Date.now() - tickSizeCache.at < TICK_SIZE_CACHE_TTL_MS) {
    return tickSizeCache.tickSize;
  }
  try {
    const si = await withChartLock(function () { return mcpBridge.callTool("symbol_info", {}); });
    const info = parseToolResult(si);
    const ts = pointValueVerify.tickSizeFrom(info && info.symbol_info ? info.symbol_info : info);
    if (ts != null && ts > 0) {
      tickSizeCache = { symbol: sym, tickSize: ts, at: Date.now() };
      return ts;
    }
  } catch (e) { console.warn("[exit-drift] symbol_info failed:", e.message); }
  return null;
}

let chartSymbolCache = { symbol: null, at: 0 };
const CHART_SYMBOL_CACHE_TTL_MS = 10 * 1000;
async function getChartSymbolCached() {
  if (chartSymbolCache.symbol && Date.now() - chartSymbolCache.at < CHART_SYMBOL_CACHE_TTL_MS) return chartSymbolCache.symbol;
  try {
    const stateRes = await mcpBridge.callTool('chart_get_state', {});
    const state = parseToolResult(stateRes);
    const sym = (state && (state.symbol || state.chart_symbol || state.ticker)) || null;
    if (sym) chartSymbolCache = { symbol: sym, at: Date.now() };
    return sym || chartSymbolCache.symbol;
  } catch (e) {
    return chartSymbolCache.symbol; // stale-but-real beats nothing
  }
}

// F0.2: write every fetched bar to the durable archive, keyed by instrument+
// timeframe+day. This is the forward-testing dataset — written on every cache-
// miss fetch (the dedup makes repeated writes cheap), never on a cache hit, and
// never a second CDP consumer (it reuses the bars getFullBars already pulled).
function archiveBars(symbol, tf, bars) {
  try {
    const root = symbolRoot(symbol);
    if (!root || ['1', '5', '15', '30', '60'].indexOf(String(tf)) === -1) return;
    const ROOT = root === 'gc' ? 'MGC' : 'MNQ'; // canonical archive keys (MNQ/MGC) — match readArchive, the backfill and the acceptance doc
    const byDay = {};
    for (const b of Array.isArray(bars) ? bars : []) {
      const n = barArchive.normalizeBar(b);
      if (!n) continue;
      const day = new Date(n.t).toISOString().slice(0, 10);
      (byDay[day] || (byDay[day] = [])).push(n);
    }
    for (const day of Object.keys(byDay)) {
      barArchive.appendToArchiveFile(path.join(DATA_DIR, 'bars', 'archive', ROOT, String(tf), day + '.jsonl'), byDay[day]);
    }
  } catch (e) { /* archive write is best-effort, never breaks the live path */ }
}

async function getFullBars(tfCode, count) {
  const symbol = await getChartSymbolCached();
  const cached = barCache.get(symbol, tfCode, count);
  if (cached) return cached;
  const bars = await withChartLock(() => _getFullBarsUnlocked(tfCode, count));
  if (Array.isArray(bars) && bars.length) {
    barCache.set(symbol, tfCode, count, bars);
    archiveBars(symbol, tfCode, bars);
  }
  return bars;
}

// X5a (F0.2 rider): a low-frequency 1m pull so the archive accrues the one
// series that makes MAE/MFE meaningful inside a sub-minute trade (the
// 2026-09-03 -$1,718 was held for 14 seconds). Reuses getFullBars, which is
// already chart-lock + archive wired — NOT a second CDP consumer, no new
// dependency. Skipped while TradingView is disconnected, like every monitor.
// The archive dedupes by t, so a pull every few minutes still yields a complete
// 1m series; never more than one timer (idempotent across reconnects).
let oneMinuteArchiveTimer = null;
function startOneMinuteArchivePoll() {
  if (oneMinuteArchiveTimer) return;
  const POLL_MS = 180000; // 3 minutes
  const COUNT = 300;      // ~5h of 1m bars per pull; overlap makes the series complete
  oneMinuteArchiveTimer = setInterval(() => {
    if (!mcpBridge.ready || !mcpBridge.tvConnected) return;
    try { getFullBars('1', COUNT).catch(() => {}); } catch (e) { /* best-effort; never disturb the live path */ }
  }, POLL_MS);
  if (typeof oneMinuteArchiveTimer.unref === 'function') oneMinuteArchiveTimer.unref();
}

async function _getFullBarsUnlocked(tfCode, count) {
  let originalTf = null;
  try {
    const stateRes = await mcpBridge.callTool('chart_get_state', {});
    const state = parseToolResult(stateRes);
    originalTf = (state && (state.timeframe || state.resolution)) || null;
  } catch { /* if we can't read current TF, we just won't restore it below */ }

  try {
    await mcpBridge.callTool('chart_set_timeframe', { timeframe: tfCode });
    // Race-condition fix (2026-07-22): chart_set_timeframe can return before
    // the chart has actually finished switching, so an immediate
    // data_get_ohlcv silently reads bars from the PREVIOUS timeframe. Caught
    // live: Anoop's chart showed PDH/PDL as a ~$48 spread instead of the
    // real ~$660 daily range, because this raced. Poll chart_get_state until
    // its resolution actually matches tfCode (up to ~2s) before trusting the
    // OHLCV read. Same class of bug as the earlier chart_set_symbol +
    // quote_get "chart may still be loading" flakiness found 2026-07-08.
    for (let i = 0; i < 5; i++) {
      try {
        const check = parseToolResult(await mcpBridge.callTool('chart_get_state', {}));
        const reported = check && (check.resolution || check.timeframe);
        if (timeframeMatches(reported, tfCode)) break;
      } catch { /* keep polling */ }
      await new Promise(r => setTimeout(r, 400));
    }
    const res = await mcpBridge.callTool('data_get_ohlcv', { count, summary: false });
    return extractBarsArray(parseToolResult(res));
  } finally {
    if (originalTf) {
      try { await mcpBridge.callTool('chart_set_timeframe', { timeframe: originalTf }); } catch { /* best effort restore */ }
    }
  }
}

// FIX (2026-08-06): added for checkEngulfingSignal, which needs bars AND
// pine labels/study values from the SAME switched timeframe (market_multi_tf
// never existed — see gatherPO3Context's fix above). getFullBars can't be
// reused here as-is since it restores the original timeframe before
// returning, and label/study-value reads need to happen while still ON
// cfg.tfCode. Same switch/poll/restore pattern as _getFullBarsUnlocked,
// just also collecting labels + study values in the same switched window.
async function getBarsAndLabels(tfCode, count) {
  const symbol = await getChartSymbolCached();
  const cachedBars = barCache.get(symbol, tfCode, count);
  const cachedLabel = barLabelCache.get(symbol, tfCode, count, { noslice: true });
  if (cachedBars && cachedLabel !== null) return { bars: cachedBars, labelText: cachedLabel };
  const result = await withChartLock(() => _getBarsAndLabelsUnlocked(tfCode, count));
  if (result && Array.isArray(result.bars) && result.bars.length) {
    barCache.set(symbol, tfCode, count, result.bars);
    barLabelCache.set(symbol, tfCode, count, result.labelText || '');
  }
  return result;
}

async function _getBarsAndLabelsUnlocked(tfCode, count) {
  let originalTf = null;
  try {
    const stateRes = await mcpBridge.callTool('chart_get_state', {});
    const state = parseToolResult(stateRes);
    originalTf = (state && (state.timeframe || state.resolution)) || null;
  } catch { /* if we can't read current TF, we just won't restore it below */ }

  try {
    await mcpBridge.callTool('chart_set_timeframe', { timeframe: tfCode });
    for (let i = 0; i < 5; i++) {
      try {
        const check = parseToolResult(await mcpBridge.callTool('chart_get_state', {}));
        const reported = check && (check.resolution || check.timeframe);
        if (timeframeMatches(reported, tfCode)) break;
      } catch { /* keep polling */ }
      await new Promise(r => setTimeout(r, 400));
    }
    const [ohlcvRes, labelsRes, studyRes] = await Promise.all([
      mcpBridge.callTool('data_get_ohlcv', { count, summary: false }).catch(() => null),
      mcpBridge.callTool('data_get_pine_labels', {}).catch(() => null),
      mcpBridge.callTool('data_get_study_values', {}).catch(() => null)
    ]);
    const txt = (r) => (r && r.content) ? r.content.map(c => c.text || '').join(' ') : '';
    return {
      bars: extractBarsArray(parseToolResult(ohlcvRes)),
      labelText: (txt(labelsRes) + ' ' + txt(studyRes)).trim()
    };
  } finally {
    if (originalTf) {
      try { await mcpBridge.callTool('chart_set_timeframe', { timeframe: originalTf }); } catch { /* best effort restore */ }
    }
  }
}

// Previous day's high/low — cached 10 minutes since it only changes once a
// day. Assumes the last daily bar returned is the still-forming current
// session (true whenever the market is open) and uses the one before it.
let pdhPdlCache = { value: null, at: 0 };
async function getPDHPDL() {
  if (pdhPdlCache.value && Date.now() - pdhPdlCache.at < 10 * 60 * 1000) return pdhPdlCache.value;
  try {
    const bars = await getFullBars('D', 3);
    if (bars.length < 2) return pdhPdlCache.value;
    const prevDay = bars[bars.length - 2];
    const val = { pdh: prevDay.high, pdl: prevDay.low, pdhTime: prevDay.time, pdlTime: prevDay.time };
    pdhPdlCache = { value: val, at: Date.now() };
    return val;
  } catch (e) {
    console.error('PDH/PDL fetch error:', e.message);
    return pdhPdlCache.value;
  }
}

// Previous WEEK's high/low — mirrors getPDHPDL() but on 'W' bars, cached 30
// minutes since a weekly bar changes far less often than a daily one.
// Assumes the last weekly bar returned is the still-forming current week and
// uses the one before it.
let pwhPwlCache = { value: null, at: 0 };
async function getPrevWeekHighLow() {
  if (pwhPwlCache.value && Date.now() - pwhPwlCache.at < 30 * 60 * 1000) return pwhPwlCache.value;
  try {
    const bars = await getFullBars('W', 3);
    if (bars.length < 2) return pwhPwlCache.value;
    const prevWeek = bars[bars.length - 2];
    const val = { pwh: prevWeek.high, pwl: prevWeek.low, pwhTime: prevWeek.time, pwlTime: prevWeek.time };
    pwhPwlCache = { value: val, at: Date.now() };
    return val;
  } catch (e) {
    console.error('Prev week H/L fetch error:', e.message);
    return pwhPwlCache.value;
  }
}

// CURRENT (still-forming) week's high/low — the last 'W' bar itself, not the
// one before it. Short cache (2 min) since this updates live intraday.
let cwhCwlCache = { value: null, at: 0 };
async function getCurrentWeekHighLow() {
  if (cwhCwlCache.value && Date.now() - cwhCwlCache.at < 2 * 60 * 1000) return cwhCwlCache.value;
  try {
    const bars = await getFullBars('W', 2);
    if (!bars.length) return cwhCwlCache.value;
    const thisWeek = bars[bars.length - 1];
    const val = { cwh: thisWeek.high, cwl: thisWeek.low, cwhTime: thisWeek.time, cwlTime: thisWeek.time };
    cwhCwlCache = { value: val, at: Date.now() };
    return val;
  } catch (e) {
    console.error('Current week H/L fetch error:', e.message);
    return cwhCwlCache.value;
  }
}

// CURRENT (still-forming) month's high/low — the last 'M' bar itself. Short
// cache (2 min), same reasoning as getCurrentWeekHighLow().
let cmhCmlCache = { value: null, at: 0 };
async function getCurrentMonthHighLow() {
  if (cmhCmlCache.value && Date.now() - cmhCmlCache.at < 2 * 60 * 1000) return cmhCmlCache.value;
  try {
    const bars = await getFullBars('M', 2);
    if (!bars.length) return cmhCmlCache.value;
    const thisMonth = bars[bars.length - 1];
    const val = { cmh: thisMonth.high, cml: thisMonth.low, cmhTime: thisMonth.time, cmlTime: thisMonth.time };
    cmhCmlCache = { value: val, at: Date.now() };
    return val;
  } catch (e) {
    console.error('Current month H/L fetch error:', e.message);
    return cmhCmlCache.value;
  }
}

// Simple 5-bar fractal swing detection (2 bars either side) over the supplied
// bar window — not a full market-structure engine, but enough to find the
// recent liquidity pools (swing highs/lows) a sweep would target alongside
// PDH/PDL. Returns up to 3 most-recent, de-duplicated (within ~0.05%) levels
// each side.
// getSwingLevels() moved to detectors.js (2026-08-26) so the backtest harness can
// import the SAME function this server fires on. Behaviour unchanged.

// SFP (swing failure pattern) / liquidity raid: the latest bar wicks through a
// key level and closes back on the other side of it — the "trap candle."
// Checked against every level in the pool; first match wins.
// detectSFPFromBars() moved to detectors.js (2026-08-26) so the backtest harness can
// import the SAME function this server fires on. Behaviour unchanged.

// ── SFP / Playbook B monitor (30M — matches the same "reaction" step as FVG) ──
// Changed from 15M to 30M on 2026-07-15 per Anoop: the 15M version was firing
// a "new" liquidity raid message roughly every poll (every 45s) while a single
// candle was still forming, because it evaluated the LATEST bar — which is
// still live and updating — instead of waiting for it to actually close.
const SFP_TFS = {
  '30m': { tfCode: '30', label: '30M', intervalMs: 60 * 1000, lookback: 40 }
};
const sfpMonitors = {};
for (const k of Object.keys(SFP_TFS)) {
  // pending: { direction, level, sweptAt, expiresAt } once a raid has fired,
  // cleared either by a confirming displacement FVG or by expiry.
  sfpMonitors[k] = { running: false, interval: null, lastCheck: null, lastSweepKey: null, lastConfirmKey: null, pending: null, lastError: null, restartAttempted: false }; // 1.4 liveness
}

// 1.2 (plan decision 2): SFP/Playbook B watcher is always on — no
// supported OFF. The handler stays so an old client/Telegram 'off' is refused
// with a status line instead of leaving the watcher dark.
function handleSFPToggle(msg) {
  const key = SFP_TFS[msg.tf] ? msg.tf : '30m';
  if (msg.enabled) { startSFPMonitor(key); return; }
  broadcast({ type: 'sfp-monitor-status', tf: key, running: true, alwaysOn: true, note: `SFP ${SFP_TFS[key].label} watcher is always on — 'off' is not supported.` });
  console.log(`SFP ${SFP_TFS[key].label}: 'off' refused — watchers are always on`);
}

function startSFPMonitor(key) {
  stopSFPMonitor(key);
  const mon = sfpMonitors[key];
  mon.running = true;
  broadcast({ type: 'sfp-monitor-status', tf: key, running: true });
  console.log(`SFP/Playbook B monitor started [${SFP_TFS[key].label}]`);
  checkSFPSignal(key);
  mon.poller = barSchedule.startBarAlignedPoll(SFP_TFS[key].tfCode, () => checkSFPSignal(key), { fallbackIntervalMs: SFP_TFS[key].intervalMs });
}

function stopSFPMonitor(key) {
  const mon = sfpMonitors[key];
  if (mon.interval) { clearInterval(mon.interval); mon.interval = null; }
  if (mon.poller) { mon.poller.stop(); mon.poller = null; }
  mon.running = false;
  broadcast({ type: 'sfp-monitor-status', tf: key, running: false });
  console.log(`SFP/Playbook B monitor stopped [${SFP_TFS[key].label}]`);
}

async function checkSFPSignal(key) {
  key = SFP_TFS[key] ? key : '30m';
  const cfg = SFP_TFS[key];
  const mon = sfpMonitors[key];

  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'sfp-check', tf: key, time: new Date().toISOString(), found: false, pending: !!mon.pending, status: 'TV offline' });
    return;
  }

  mon.lastCheck = new Date().toISOString();
  mon.lastError = null;

  try {
    const bars = await getFullBars(cfg.tfCode, cfg.lookback);
    if (bars.length < 6) {
      broadcast({ type: 'sfp-check', tf: key, time: mon.lastCheck, found: false, pending: !!mon.pending, status: 'insufficient bar history' });
      return;
    }

    // Only ever evaluate a fully CLOSED candle — the last bar returned is
    // usually still forming/live. Fixed 2026-07-15: previously this checked
    // bars[bars.length-1] directly, so every ~45s poll re-evaluated a candle
    // whose high/low/close was still changing mid-formation, firing a "new"
    // liquidity-raid message on nearly every tick instead of once per candle.
    const tfSeconds = parseInt(cfg.tfCode, 10) * 60;
    const nowSec = Math.floor(Date.now() / 1000);
    const lastBarStillForming = bars[bars.length - 1].time + tfSeconds > nowSec;
    const closedBars = lastBarStillForming ? bars.slice(0, -1) : bars;
    const closedBar = closedBars[closedBars.length - 1];
    if (!closedBar) {
      broadcast({ type: 'sfp-check', tf: key, time: mon.lastCheck, found: false, pending: !!mon.pending, status: 'waiting for a closed ' + cfg.label + ' bar' });
      return;
    }

    const pdhpdl = await getPDHPDL();
    const swings = getSwingLevels(closedBars);
    const levels = {
      highs: [...(pdhpdl ? [pdhpdl.pdh] : []), ...swings.swingHighs],
      lows:  [...(pdhpdl ? [pdhpdl.pdl] : []), ...swings.swingLows]
    };

    const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const sfp = detectSFPFromBars(closedBars, levels);

    if (sfp) {
      // Keyed on the closed bar's own timestamp — stable and unique per
      // candle, unlike a wall-clock bucket — so this can only fire once per
      // real candle close, no matter how often the poll runs.
      const sweepBucket = sfp.direction + '_' + sfp.level.toFixed(2) + '_' + closedBar.time;
      if (sweepBucket !== mon.lastSweepKey) {
        mon.lastSweepKey = sweepBucket;
        const raidSwept = sfp.direction === 'BEARISH' ? 'HIGH' : 'LOW';
        const raidSide  = sfp.direction === 'BEARISH' ? 'Buy-side' : 'Sell-side';
        const raidBias  = sfp.direction === 'BEARISH' ? 'SHORT' : 'LONG';
        const raidMsg = `${raidSide} liquidity raid on ${cfg.label} at ${istTime} IST — swept the ${sfp.level.toFixed(2)} ${raidSwept} and closed back inside → reversal bias ${raidBias}. Not a trade yet: waiting for displacement/FVG to confirm Playbook B.`;
        broadcast({ type: 'sfp-signal', tf: key, tfLabel: cfg.label, direction: sfp.direction, level: sfp.level, time: istTime, message: raidMsg });
        telegramBot.notify(`🎣 ${raidMsg}`);
        console.log(`SFP RAID [${cfg.label}]: ${sfp.direction} swept ${sfp.level.toFixed(2)}`);
        // 2.1: ledger the raid. Deliberately NOT armed — a raid alone is
        // "not a trade yet"; its confirming displacement (below) arms.
        ledgerSignal({ event: 'sfp-raid', playbook: 'B', tf: cfg.tfCode, direction: sfp.direction, level: sfp.level });
        // A fresh raid replaces any stale pending one — the most recent liquidity event is what matters.
        // Patience window kept at 8 candles (was 8×15m=2h; now 8×30m=4h) — tied
        // to bar count, not wall clock, so it scales with the TF automatically.
        // `wick` added 2026-08-26: Playbook B's stop is "beyond the SFP wick",
        // and only the swept LEVEL was being kept — a materially tighter stop
        // sitting inside the trap the setup is built on.
        mon.pending = { direction: sfp.direction, level: sfp.level, wick: sfp.wick, sweptAt: Date.now(), expiresAt: Date.now() + 8 * tfSeconds * 1000 };
      }
    }

    if (mon.pending) {
      if (Date.now() > mon.pending.expiresAt) {
        console.log(`SFP pending [${cfg.label}] expired with no displacement — discarded (JadeCap: don't chase a stale setup)`);
        mon.pending = null;
      } else {
        const fvg = detectFVGFromBars(closedBars);
        if (fvg && fvg.direction === mon.pending.direction) {
          const confirmBucket = mon.pending.direction + '_' + mon.pending.level.toFixed(2) + '_confirm_' + closedBar.time;
          if (confirmBucket !== mon.lastConfirmKey) {
            mon.lastConfirmKey = confirmBucket;
            // ── THE HTF GATE (2026-09-01) ────────────────────────────────
            // Playbook B checked NO higher timeframe at all before this — it
            // could confirm a short into a bullish 1H/4H. Gated at the CONFIRM
            // rather than at the raid: a raid is not yet a setup, and refusing
            // it there would suppress the "NOT a trade yet" context line that
            // is genuinely useful to see either way.
            const bGate = await htfGate('B', cfg.tfCode, mon.pending.direction);
            if (!bGate.allowed) {
              // G5: a block is NOT a discard. Keep the pending raid alive to its
              // expiresAt so the gate re-evaluates on the next closed bar, and emit
              // the block on the SAME channel the raid used — a silent discard is
              // indistinguishable from "nothing detected". Direction blocks are
              // NEVER relaxed; only the unclear case can opt to alert-only.
              const _rules = getActiveRules();
              const _mode = (_rules.playbooks && _rules.playbooks.htfUnclearMode) || 'block';
              const _directionBlock = bGate.reason === 'setup-against-htf-bias';
              mon.pending.blockCount = (mon.pending.blockCount || 0) + 1;
              broadcast({
                type: 'sfp-signal',
                tf: key, tfLabel: cfg.label,
                direction: mon.pending.direction, level: mon.pending.level,
                held: true, gateReason: bGate.reason,
                structure15m: bGate.structure15m, structure1h: bGate.structure1h,
                retryCount: mon.pending.blockCount,
                message: 'Playbook B held on ' + cfg.label + ' — displacement arrived but ' + htfAlignment.explain(bGate) + ' (retry ' + mon.pending.blockCount + '). Not cancelled.',
              });
              console.log('SFP BLOCKED [' + cfg.label + ']: ' + htfAlignment.explain(bGate) + ' (retry ' + mon.pending.blockCount + ')');
              if (_mode === 'alert-only' && !_directionBlock) {
                // opt-in: an unclear read alerts but does not block — fall through to confirm.
              } else {
                return; // keep mon.pending — do NOT null it
              }
            }
            // The gate is above EVERY playbook, so demoting the 4H from veto
            // to evidence (2026-09-01) loosened B by the same ~6.7x it
            // loosened A. B therefore has to state the same evidence — a
            // confirm that stays silent about a 4H reading the other way is
            // exactly the unlabelled 1H-only trade that change was supposed
            // to make visible rather than hide.
            const bAlign = htfAlignment.confirmationNote(bGate);
            const confirmMsg = `PLAYBOOK B CONFIRMED (${mon.pending.direction}) on ${cfg.label} at ${istTime} IST — ${bAlign} — liquidity raid at ${mon.pending.level.toFixed(2)} + displacement FVG ${fvg.gapLow.toFixed(2)}-${fvg.gapHigh.toFixed(2)}. Enter on retrace into the gap, SL beyond the sweep wick.`;
            broadcast({
              type: 'playbook-b-signal',
              tf: key,
              tfLabel: cfg.label,
              direction: mon.pending.direction,
              sweepLevel: mon.pending.level,
              gapLow: fvg.gapLow,
              gapHigh: fvg.gapHigh,
              time: istTime,
              htfBias: bGate.bias,
              structure15m: bGate.structure15m,
              structure1h: bGate.structure1h,
              htfConfirmation: bGate.confirmation,
              message: confirmMsg
            });
            telegramBot.notify(`✅ ${confirmMsg}`);
            console.log(`PLAYBOOK B CONFIRMED [${cfg.label}]: ${mon.pending.direction}`);
            // 2.1/2.2: ledger + arm the confirmed Playbook B setup.
            // This row previously set level to the SWEPT LEVEL and nothing
            // else, so signal-outcome.js measured excursion from a price
            // beyond the trade's own stop. entry/stop now come from the same
            // spec the backtest uses.
            const bSetup = { direction: mon.pending.direction, gapLow: fvg.gapLow, gapHigh: fvg.gapHigh, wick: mon.pending.wick, level: mon.pending.level };
            const bPlan = playbookSpec.planEntry('B', bSetup, getActiveRules());
            ledgerSignal({
              event: 'playbook-b-confirm', playbook: 'B', tf: cfg.tfCode, direction: mon.pending.direction,
              level: mon.pending.level, gapLow: fvg.gapLow, gapHigh: fvg.gapHigh,
              entry: bPlan.plannable ? bPlan.entry : null,
              stop: bPlan.plannable ? bPlan.stop : null,
              setupId: playbookSpec.setupId('B', bSetup),
              // G5: how many bars this confirm was HELD before the gate cleared.
              // Without it, a raid that confirms on bar N is indistinguishable from
              // one that confirmed on bar N+2 — and the forward test stops being
              // comparable across the change.
              retryCount: mon.pending.blockCount || 0,
            });
            // 2026-09-01: `wick` added. It was already captured in
            // mon.pending and already used for bSetup/bPlan above, so the
            // LEDGER row carried the rulebook stop ("SL beyond SFP wick")
            // while this call omitted it — meaning the armed-setup card, the
            // shadow recorder and the debate all planned the SAME setup with
            // planEntry's fallback stop at the swept level instead. That
            // fallback sits INSIDE the trap the setup is built on, so it is
            // materially tighter than the rulebook asks for; playbook-spec.js
            // labels it 'WICK NOT CAPTURED' precisely so a result computed on
            // it is not silently mixed in with the real rule. One setup was
            // producing two different stops depending on which consumer read
            // it, and the tighter one was what Anoop actually saw.
            armSetup({ playbook: 'B', tfCode: cfg.tfCode, tfLabel: cfg.label, direction: mon.pending.direction, level: mon.pending.level, wick: mon.pending.wick, gapLow: fvg.gapLow, gapHigh: fvg.gapHigh, message: confirmMsg });
            // 3.3: a confirmed Playbook B convenes the debate.
            triggerPlaybookDebate({ playbook: 'B', tfCode: cfg.tfCode, tfLabel: cfg.label, direction: mon.pending.direction, level: mon.pending.level, gapLow: fvg.gapLow, gapHigh: fvg.gapHigh, time: istTime });
            mon.pending = null;
          }
        }
      }
    }

    broadcast({ type: 'sfp-check', tf: key, time: mon.lastCheck, found: !!sfp, pending: !!mon.pending, direction: sfp ? sfp.direction : null });
  } catch (e) {
    mon.lastError = e.message;
    console.error(`SFP monitor [${cfg.label}] error:`, e.message);
    broadcast({ type: 'sfp-check', tf: key, time: mon.lastCheck, found: false, pending: !!mon.pending, status: 'error: ' + e.message });
  }
}

// ── Trend STRENGTH classifier (added 2026-07-28, Anoop) ─────────────────────
// Anoop asked for all three ways of reading strength combined, not any one
// alone:
//   1. Structure — bar-over-bar HH/HL vs LL/LH vote, continuous version of
//      classifyTrendFromBars() above (that one only returns a hard
//      bullish/bearish/unclear cutoff; this scores -1..+1).
//   2. Body-vs-range — how much of the MOST RECENT bar's total range is real
//      body (close-open) vs wicks. A big one-directional body = conviction;
//      a small body with long wicks both ways = indecision.
//   3. Slope — linear-regression slope of closes across the available bars
//      (market_multi_tf only ever returns 5), normalized by average price
//      so it's comparable regardless of instrument/price level.
// Each signal scores -1 (bear) to +1 (bull). Direction comes from the sign
// of their average; strength (STRONG/WEAK/NEUTRAL) comes from how large the
// average is AND how many of the 3 actually agree with that direction — all
// 3 agreeing with a large average is STRONG, 2/3 is WEAK, a wash is NEUTRAL.
// This is a mechanical approximation like get4HTrend() above (only 5 bars
// available), not a substitute for reading the chart yourself on a
// borderline call — same caveat applies, now with a visible strength grade
// instead of a false-confident binary.
// HYSTERESIS BANDS (2026-09-05, Anoop: chatter must not interrupt him
// mid-session). Without these, direction is a bare threshold at +/-0.1, so a
// score hovering at 0.099 <-> 0.101 flips BULLISH/NEUTRAL on every 90s read.
// Three bands, not one:
//   ENTER   — from NEUTRAL into a direction. Unchanged at 0.10, so nothing
//             about how a bias is FIRST acquired has changed.
//   HOLD    — once in a direction, keep it until |avg| decays below this.
//             Lower than ENTER: that gap IS the hysteresis.
//   REVERSE — a direct BULLISH->BEARISH flip (skipping neutral) needs a
//             bigger move than acquiring from neutral does, because a
//             straight reversal is the rarer and more consequential claim.
// prevDirection is passed by the CALLER, which is what keeps this function
// pure — same bars + same prev always give the same answer, so it stays
// testable. Callers that pass nothing (po3TrendRead) get the old stateless
// behaviour EXACTLY, deliberately: the PO3 bias gate was not part of this ask.
const TREND_ENTER = 0.10;
const TREND_HOLD = 0.05;
const TREND_REVERSE = 0.15;

function classifyTrendStrength(bars, prevDirection) {
  if (!bars || bars.length < 3) return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null };

  // UPGRADED 2026-07-28 (Anoop): was computed off market_multi_tf's fixed
  // 5-bar window — five daily candles is one week, too thin to call a
  // "Daily bias" honestly. Now fed 60 bars via getFullBars(). (Since
  // 2026-09-05 the HTF leg this feeds is 4H, not Daily — 60 bars is ~10
  // trading days of 4H instead of ~3 months of Daily.) Two real
  // consequences of the deeper history:
  //   a) STRUCTURE is now true swing-pivot structure (higher-highs and
  //      higher-lows between actual pivots, via the same 5-bar pivot
  //      definition getSwingLevels() uses) instead of a bar-over-bar vote.
  //      A bar-over-bar vote is noise at this depth; pivots are what your
  //      Playbook A/C actually describe ("HH-HL pattern" / "LL-LH pattern").
  //   b) The last bar is usually STILL FORMING (true whenever the market is
  //      open), so its body is incomplete and misleading. Body and slope now
  //      read the last CLOSED bar — same assumption getPDHPDL() already makes.
  const closedBars = bars.length >= 2 ? bars.slice(0, -1) : bars;
  // Require real depth. Below this the grade is noise dressed as a reading —
  // caught in testing: 4 bars produced the same confident label as 60.
  if (closedBars.length < 10) return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null, thin: true };

  // 1. STRUCTURE — swing pivots (higher-highs/higher-lows between pivots).
  // BUG FOUND IN TESTING (2026-07-28): a clean monotonic trend produces ZERO
  // pivots — in a steady rise no bar is the max of a 5-bar window centred on
  // it (the max always sits at the window's right edge). So the strongest
  // possible trend scored structure = 0, exactly backwards. Fall back to a
  // bar-over-bar HH/HL vote whenever there aren't enough pivots to compare;
  // that method is weak on choppy data (which is why pivots are preferred)
  // but it is accurate precisely in the smooth-trend case pivots miss.
  const pivotHighs = [], pivotLows = [];
  for (let i = 2; i < closedBars.length - 2; i++) {
    const w = closedBars.slice(i - 2, i + 3);
    if (closedBars[i].high === Math.max(...w.map(b => b.high))) pivotHighs.push(closedBars[i].high);
    if (closedBars[i].low === Math.min(...w.map(b => b.low))) pivotLows.push(closedBars[i].low);
  }
  let structureScore = 0, structureMethod = 'pivots';
  const recentH = pivotHighs.slice(-3), recentL = pivotLows.slice(-3);
  if (recentH.length >= 2 && recentL.length >= 2) {
    let up = 0, down = 0, tot = 0;
    for (let i = 1; i < recentH.length; i++) { tot++; if (recentH[i] > recentH[i - 1]) up++; else if (recentH[i] < recentH[i - 1]) down++; }
    for (let i = 1; i < recentL.length; i++) { tot++; if (recentL[i] > recentL[i - 1]) up++; else if (recentL[i] < recentL[i - 1]) down++; }
    structureScore = tot ? (up - down) / tot : 0;
  } else {
    structureMethod = 'bar-over-bar';
    const w = closedBars.slice(-20);
    let hh = 0, hl = 0, lh = 0, ll = 0;
    for (let i = 1; i < w.length; i++) {
      if (w[i].high > w[i - 1].high) hh++; else if (w[i].high < w[i - 1].high) lh++;
      if (w[i].low > w[i - 1].low) hl++; else if (w[i].low < w[i - 1].low) ll++;
    }
    const n = w.length - 1;
    structureScore = n ? ((hh + hl) - (lh + ll)) / (2 * n) : 0;
  }

  // 2. BODY vs RANGE — last CLOSED bar only.
  const last = closedBars[closedBars.length - 1];
  const range = Math.max(last.high - last.low, 0.01);
  const bodyScore = Math.max(-1, Math.min(1, (last.close - last.open) / range));

  // 3. SLOPE — linear regression over the last SLOPE_WINDOW closed bars.
  // Windowed deliberately: regressing all 60 would measure last quarter's
  // drift, not the trend you're about to trade into.
  // 2026-09-05 (Anoop): 20 -> 10, to make the bias more responsive to recent
  // price. On the 4H leg that is ~1.7 trading days of lookback instead of
  // ~3.3. Expect the grade to flip more often; that is the point, but it also
  // means a single sharp 4H push now moves a third of the composite score.
  // NOTE: the structure FALLBACK below still uses its own 20-bar window —
  // these are two different windows and were never coupled.
  const SLOPE_WINDOW = 10;
  const window = closedBars.slice(-SLOPE_WINDOW);
  const closes = window.map(b => b.close);
  const avgClose = (closes.reduce((a, b) => a + b, 0) / closes.length) || 1;
  const xs = closes.map((_, i) => i);
  const xBar = xs.reduce((a, b) => a + b, 0) / xs.length;
  let num = 0, den = 0;
  for (let i = 0; i < closes.length; i++) { num += (xs[i] - xBar) * (closes[i] - avgClose); den += (xs[i] - xBar) ** 2; }
  const slopePerBar = den ? num / den : 0;
  // 0.15%-per-bar drift reads as full-strength (+/-1). UNTUNED — this number
  // is a guess, not derived from Anoop's data. Watch it against your own read
  // for a few sessions and adjust if it says STRONG when your eye says WEAK.
  const slopeScore = Math.max(-1, Math.min(1, (slopePerBar / avgClose) / 0.0015));

  const round2 = (v) => Math.round(v * 100) / 100;
  const scores = [structureScore, bodyScore, slopeScore];
  const avg = scores.reduce((a, b) => a + b, 0) / 3;
  // Direction with hysteresis. prev === undefined/null reproduces the old
  // bare +/-0.10 threshold exactly.
  const prev = (prevDirection === 'bullish' || prevDirection === 'bearish') ? prevDirection : null;
  let direction;
  if (!prev) {
    direction = avg > TREND_ENTER ? 'bullish' : avg < -TREND_ENTER ? 'bearish' : 'unclear';
  } else if (prev === 'bullish') {
    if (avg < -TREND_REVERSE) direction = 'bearish';        // straight reversal — needs the wide band
    else if (avg > TREND_HOLD) direction = 'bullish';        // still bullish enough to hold
    else direction = 'unclear';                              // decayed out
  } else {
    if (avg > TREND_REVERSE) direction = 'bullish';
    else if (avg < -TREND_HOLD) direction = 'bearish';
    else direction = 'unclear';
  }
  const agree = direction === 'unclear' ? 0 : scores.filter(s => (direction === 'bullish' ? s > 0.05 : s < -0.05)).length;

  let strength;
  if (direction === 'unclear') strength = 'NEUTRAL';
  else if (agree === 3 && Math.abs(avg) >= 0.45) strength = 'STRONG';
  else if (agree >= 2) strength = 'WEAK';
  else strength = 'NEUTRAL';

  // BUG FOUND IN TESTING: this produced the nonsense label "NEUTRAL BEAR"
  // when a direction was computed but the signals didn't agree enough to
  // call it. If strength lands on NEUTRAL the honest answer is NEUTRAL, with
  // no direction attached — that's the whole point of the neutral bucket.
  const label = (direction === 'unclear' || strength === 'NEUTRAL')
    ? 'NEUTRAL'
    : `${strength} ${direction === 'bullish' ? 'BULL' : 'BEAR'}`;
  return {
    direction: strength === 'NEUTRAL' ? 'unclear' : direction,
    label, score: round2(avg),
    detail: { structureScore: round2(structureScore), structureMethod, bodyScore: round2(bodyScore), slopeScore: round2(slopeScore), agree, prevDirection: prev, held: !!(prev && direction === prev && Math.abs(avg) <= TREND_ENTER) }
  };
}

// ── Mechanical HTF alignment + key level (no LLM) ───────────────────────────
// Keeps the BIAS / KEY LEVEL / Framework Steps panel populated with zero
// Anthropic API calls. Runs continuously in the background (like the
// engulf/FVG/SFP monitors), not just on button click.
const trendCacheByTF = {};
// CHART-DISRUPTION NOTE (2026-07-28): both market_multi_tf and getFullBars
// work by switching Anoop's LIVE chart timeframe, reading, then switching
// back — he trades off that chart, so every read is a visible flicker. The
// old code re-read both TFs every 3 min (~40 switches/hour). getFullBars is
// slower per call (it polls up to 2s for the chart to settle after the
// switch), so the TTLs below are raised to compensate: a 4H/DAILY bar does not
// meaningfully change in 3 minutes, and neither does a 1H bar. Net effect is
// FEWER chart switches than before (~16/hour) on much deeper data.
// 2026-09-05 (Anoop): the HTF bias leg moved from DAILY to 4H. '240' gets the
// same 15-min TTL the Daily read had — a 4H bar still only closes six times a
// day, so re-reading more often would buy noise and cost chart flicker. 'D' is
// kept in the table because getTrendForTF() is generic and other callers may
// still ask for it.
const TREND_TTL_BY_TF = { 'D': 15 * 60 * 1000, '240': 15 * 60 * 1000, '60': 5 * 60 * 1000 };
const TREND_BAR_COUNT = 60;
async function getTrendForTF(tfCode, ttlMs) {
  const ttl = ttlMs != null ? ttlMs : (TREND_TTL_BY_TF[tfCode] || 5 * 60 * 1000);
  const c = trendCacheByTF[tfCode];
  if (c && Date.now() - c.at < ttl) return c.value;
  try {
    const bars = await getFullBars(tfCode, TREND_BAR_COUNT);
    if (!bars || bars.length < 5) {
      // Don't overwrite a good cached read with a bad partial one.
      if (c) return c.value;
      return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null };
    }
    // Feed the LAST GRADED direction for this timeframe back in, so the bands
    // above can hold it. Per-timeframe: the 4H and 1H reads must not inherit
    // each other's state. Note this is the last *cached* grade, which is also
    // what the UI is currently showing — so what the panel displays is exactly
    // what the hysteresis is anchored to.
    const prevDir = c && c.value ? c.value.direction : null;
    const trend = classifyTrendStrength(bars, prevDir);
    trend.bars = bars.length;
    trendCacheByTF[tfCode] = { value: trend, at: Date.now() };
    return trend;
  } catch (e) {
    console.error(`Trend read [${tfCode}] error:`, e.message);
    // Stale-but-real beats a false "unclear" — keep the last good value.
    if (c) return c.value;
    return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null };
  }
}

async function getCurrentPriceMechanical() {
  try {
    const res = await mcpBridge.callTool('quote_get', {});
    const raw = res && res.content && res.content.map(c => c.text || '').join(' ');
    const m = raw && (raw.match(/last["\s:]+([0-9.,]+)/i) || raw.match(/([0-9]{4,6}\.[0-9]{1,2})/));
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  } catch (e) {
    console.error('Price read (mechanical) error:', e.message);
    return null;
  }
}

// Nearest PDH/PDL or recent 1H swing level to current price — the same level
// pool the SFP monitor uses, just ranked by distance instead of scanned for a
// sweep.
async function getNearestKeyLevelMechanical(price) {
  if (typeof price !== 'number') return null;
  try {
    const pdhpdl = await getPDHPDL();
    const hourBars = await getFullBars('60', 40);
    const swings = getSwingLevels(hourBars);
    const candidates = [];
    if (pdhpdl) {
      candidates.push({ label: 'PDH', price: pdhpdl.pdh });
      candidates.push({ label: 'PDL', price: pdhpdl.pdl });
    }
    swings.swingHighs.forEach(p => candidates.push({ label: 'Swing High', price: p }));
    swings.swingLows.forEach(p => candidates.push({ label: 'Swing Low', price: p }));
    if (!candidates.length) return null;
    candidates.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
    return candidates[0];
  } catch (e) {
    console.error('Key level (mechanical) error:', e.message);
    return null;
  }
}

let mechanicalInterval = null;
async function runMechanicalAnalysis() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'mechanical-analysis', ok: false, status: 'TV offline' });
    return;
  }
  try {
    // htfRead is the 4H bias (was Daily until 2026-09-05). It is still carried
    // on the wire as dailyTrend/dailyLabel/dailyScore/dailyDetail/dailyBars —
    // renaming those fields would silently break every existing reader
    // (computeMechanicalGoNogo, signal-ledger.js, the Framework Steps panel).
    // The UI labels say 4H; the field names are legacy.
    const [dailyRead, hourRead, price] = await Promise.all([
      getTrendForTF('240'),
      getTrendForTF('60'),
      getCurrentPriceMechanical()
    ]);
    const keyLevel = await getNearestKeyLevelMechanical(price);
    const aligned = dailyRead.direction !== 'unclear' && hourRead.direction !== 'unclear' && dailyRead.direction === hourRead.direction;

    broadcast({
      type: 'mechanical-analysis',
      ok: true,
      time: new Date().toISOString(),
      // dailyTrend/hourTrend kept as plain direction strings for backward
      // compat (existing 'aligned' logic and UI checks read these); the new
      // strength grade is additive, not a replacement.
      // NOTE: the 'daily*' keys below now carry the 4H read (see above).
      dailyTrend: dailyRead.direction, hourTrend: hourRead.direction, aligned,
      dailyLabel: dailyRead.label, hourLabel: hourRead.label,
      dailyScore: dailyRead.score, hourScore: hourRead.score,
      dailyDetail: dailyRead.detail, hourDetail: hourRead.detail,
      dailyBars: dailyRead.bars || null, hourBars: hourRead.bars || null,
      price, keyLevel
    });
  } catch (e) {
    console.error('Mechanical analysis error:', e.message);
    broadcast({ type: 'mechanical-analysis', ok: false, status: 'error: ' + e.message });
  }
}

function startMechanicalAnalysis() {
  runMechanicalAnalysis();
  if (mechanicalInterval) clearInterval(mechanicalInterval);
  mechanicalInterval = setInterval(runMechanicalAnalysis, 90 * 1000);
}

function stopMechanicalAnalysis() {
  if (mechanicalInterval) { clearInterval(mechanicalInterval); mechanicalInterval = null; }
}

// ── London prep: mark PDH/PDL + Asia session H/L + previous week H/L ──────────
// On-demand (triggered by the "Mark London Levels" button, or the
// 'mark-london-levels' WS message) — not a background timer. Reuses
// getPDHPDL()/getFullBars() from the SFP section above.
// Updated 2026-07-22 per Anoop: added previous week H/L alongside the
// existing PDH/PDL + Asia H/L (nothing removed, only added).

function barTimeToDate(t) {
  // Defensive: bar.time could be unix seconds or milliseconds depending on
  // what the MCP tool actually returns — treat anything above 1e12 as ms.
  const ms = t > 1e12 ? t : t * 1000;
  return new Date(ms);
}

function toISTFractionalHour(date) {
  const ist = new Date(date.getTime() + 5.5 * 3600000);
  return ist.getUTCHours() + ist.getUTCMinutes() / 60;
}

// Asia session convention used here: 5:30 AM IST (Tokyo open) to the London
// open. Pulling 40 x 15M bars (~10 hours) is enough to cover that window when
// this runs at/after London open without reaching back into the prior day's
// Asia session too.
//
// 5.5 is a genuine constant: Tokyo opens 09:00 JST and Japan observes no DST,
// so 05:30 IST is the Tokyo open every day of the year.
//
// The END was a hardcoded 13.5, described in its own comment as "the same
// boundary CLAUDE.md uses for when London starts". That stopped being true on
// 2026-09-03, when London's open became DST-aware and moved to 12:30 IST for
// the summer half of the year. An Asia range that runs past the London open
// folds London's own first bars into the "Asia high/low" — and those are
// exactly the levels drawn for him to trade the London raid AGAINST, so the
// level would have been contaminated by the move it is meant to measure.
// Read from the resolved windows now; it can no longer drift.
async function getAsiaHighLow() {
  try {
    const wins = (getActiveRules().sessionWindowsIST || []).slice().sort((a, b) => a.startMin - b.startMin);
    const asiaEndHour = (wins.length && wins[0].startMin != null) ? wins[0].startMin / 60 : 13.5;
    const bars = await getFullBars('15', 40);
    if (!bars.length) return null;
    const asiaBars = bars.filter(b => {
      const h = toISTFractionalHour(barTimeToDate(b.time));
      return h >= 5.5 && h < asiaEndHour;
    });
    if (!asiaBars.length) return null;
    const highBar = asiaBars.reduce((a, b) => (b.high > a.high ? b : a));
    const lowBar = asiaBars.reduce((a, b) => (b.low < a.low ? b : a));
    return {
      asiaHigh: highBar.high, asiaHighTime: highBar.time,
      asiaLow: lowBar.low, asiaLowTime: lowBar.time
    };
  } catch (e) {
    console.error('Asia H/L fetch error:', e.message);
    return null;
  }
}

// Draws one horizontal RAY (originates at the actual candle where the
// high/low occurred, extends rightward only) + a text label at the same
// price. Two separate draw_shape calls in a try/catch each — the exact
// override fields draw_shape accepts for inline labels aren't nailed down
// from a live call, so a dedicated 'text' shape (an explicitly documented
// shape type) is used instead of trusting an undocumented override key.
//
// FIX (2026-07-27): this used to be shape:'horizontal_line' anchored at
// nowSec — TradingView's "Horizontal Line" tool ignores the anchor time and
// spans the ENTIRE chart both directions, which is not how Anoop marks
// levels himself. He sent a side-by-side screenshot: his own manual markup
// uses TradingView's Horizontal RAY tool, anchored at the actual pivot
// candle, extending only rightward from there — "origin from the point the
// high or low is... this should apply to all marking level." Verified
// 'horizontal_ray' is a real, distinct shape type the connected TradingView
// MCP accepts (tested live against the actual chart before committing to
// this, not guessed) — swapped the tool + now threads the REAL bar time for
// each level through from the getPDHPDL/getPrevWeekHighLow/etc. callers
// below instead of always using "now".
async function drawLevelLine(price, label, color, originSec) {
  try {
    await mcpBridge.callTool('draw_shape', {
      shape: 'horizontal_ray',
      point: { time: originSec, price },
      overrides: JSON.stringify({ linecolor: color, linewidth: 1, linestyle: 0, showLabel: true, horzLabelsAlign: 'right' })
    });
  } catch (e) {
    console.error(`Draw line [${label}] failed:`, e.message);
  }
  try {
    await mcpBridge.callTool('draw_shape', {
      shape: 'text',
      point: { time: originSec, price },
      text: label,
      overrides: JSON.stringify({ color })
    });
  } catch (e) {
    console.error(`Draw label [${label}] failed:`, e.message);
  }
}

async function markLondonLevels() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'london-levels', ok: false, status: 'TV offline' });
    return;
  }
  try {
    const pdhpdl = await getPDHPDL();
    const asia = await getAsiaHighLow();
    const prevWeek = await getPrevWeekHighLow();
    if (!pdhpdl && !asia && !prevWeek) {
      broadcast({ type: 'london-levels', ok: false, status: 'no bar data available yet' });
      return;
    }

    // 2026-07-27: each line now carries the REAL bar time its high/low
    // occurred on (origin) instead of "now" — see drawLevelLine() note above.
    const nowSec = Math.floor(Date.now() / 1000);
    const lines = [];
    if (prevWeek) {
      lines.push({ label: 'Prev Week High', price: prevWeek.pwh, origin: prevWeek.pwhTime || nowSec, color: '#7a4fc9' });
      lines.push({ label: 'Prev Week Low', price: prevWeek.pwl, origin: prevWeek.pwlTime || nowSec, color: '#7a4fc9' });
    }
    if (pdhpdl) {
      lines.push({ label: 'PDH', price: pdhpdl.pdh, origin: pdhpdl.pdhTime || nowSec, color: '#d1293b' });
      lines.push({ label: 'PDL', price: pdhpdl.pdl, origin: pdhpdl.pdlTime || nowSec, color: '#16883f' });
    }
    if (asia) {
      lines.push({ label: 'Asia High', price: asia.asiaHigh, origin: asia.asiaHighTime || nowSec, color: '#b5750a' });
      lines.push({ label: 'Asia Low', price: asia.asiaLow, origin: asia.asiaLowTime || nowSec, color: '#b5750a' });
    }

    for (const line of lines) {
      await drawLevelLine(line.price, line.label, line.color, line.origin || nowSec);
    }

    const summary = lines.map(l => `${l.label} ${l.price.toFixed(2)}`).join(' · ');
    const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const message = `London prep — marked on chart at ${istTime} IST: ${summary}`;
    broadcast({ type: 'london-levels', ok: true, time: istTime, lines, message });
    telegramBot.notify(`📍 ${message}`);
    console.log(`LONDON LEVELS MARKED: ${summary}`);

    // Chain the ForexFactory chart sync into the same prep ritual — best
    // effort, wrapped separately so a news-marker failure can never affect
    // the London-levels result already broadcast above.
    try { await markNewsTimesOnChart(); } catch (e2) { console.error('News chart sync (chained) failed:', e2.message); }
  } catch (e) {
    console.error('Mark London levels error:', e.message);
    broadcast({ type: 'london-levels', ok: false, status: 'error: ' + e.message });
  }
}

// London session convention used here: London open to NY open - mirrors the
// Asia->London boundary above, one session later. Both ends now come from the
// resolved session windows (2026-09-03), not from fixed IST times.
// Pulling 30 x 15M bars (~7.5 hours) is enough to cover that window when this
// runs at/after NY open without reaching back into the Asia session too.
async function getLondonHighLow() {
  try {
    // Same reason as getAsiaHighLow above: these bounds were the literals
    // 13.5 and 19.0 (the old fixed London and NY opens). With DST-aware
    // windows the London open moves to 12:30 IST for the summer half of the
    // year and the NY open moves to 20:00 IST for the winter half, so a fixed
    // range would clip an hour off one end and swallow an hour of the wrong
    // session at the other. Derived from the resolved windows instead.
    const wins = (getActiveRules().sessionWindowsIST || []).slice().sort((a, b) => a.startMin - b.startMin);
    const londonStartHour = (wins[0] && wins[0].startMin != null) ? wins[0].startMin / 60 : 13.5;
    const londonEndHour = (wins[1] && wins[1].startMin != null) ? wins[1].startMin / 60 : 19.0;
    const bars = await getFullBars('15', 30);
    if (!bars.length) return null;
    const londonBars = bars.filter(b => {
      const h = toISTFractionalHour(barTimeToDate(b.time));
      return h >= londonStartHour && h < londonEndHour;
    });
    if (!londonBars.length) return null;
    return {
      londonHigh: Math.max(...londonBars.map(b => b.high)),
      londonLow: Math.min(...londonBars.map(b => b.low))
    };
  } catch (e) {
    console.error('London H/L fetch error:', e.message);
    return null;
  }
}

// Updated 2026-07-22 per Anoop: NY levels now mark current week H/L + current
// month H/L instead of PDH/PDL + London H/L (full replacement, not additive —
// getPDHPDL()/getLondonHighLow() are unused here now but left defined above
// since markLondonLevels() and other callers still use getPDHPDL()).
async function markNYLevels() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'ny-levels', ok: false, status: 'TV offline' });
    return;
  }
  try {
    const currWeek = await getCurrentWeekHighLow();
    const currMonth = await getCurrentMonthHighLow();
    if (!currWeek && !currMonth) {
      broadcast({ type: 'ny-levels', ok: false, status: 'no bar data available yet' });
      return;
    }

    // 2026-07-27: real bar-origin times, same as markLondonLevels() above.
    const nowSec = Math.floor(Date.now() / 1000);
    const lines = [];
    if (currWeek) {
      lines.push({ label: 'Week High', price: currWeek.cwh, origin: currWeek.cwhTime || nowSec, color: '#3b6fb5' });
      lines.push({ label: 'Week Low', price: currWeek.cwl, origin: currWeek.cwlTime || nowSec, color: '#3b6fb5' });
    }
    if (currMonth) {
      lines.push({ label: 'Month High', price: currMonth.cmh, origin: currMonth.cmhTime || nowSec, color: '#c98a2f' });
      lines.push({ label: 'Month Low', price: currMonth.cml, origin: currMonth.cmlTime || nowSec, color: '#c98a2f' });
    }

    for (const line of lines) {
      await drawLevelLine(line.price, line.label, line.color, line.origin || nowSec);
    }

    const summary = lines.map(l => `${l.label} ${l.price.toFixed(2)}`).join(' - ');
    const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const message = `NY prep - marked on chart at ${istTime} IST: ${summary}`;
    broadcast({ type: 'ny-levels', ok: true, time: istTime, lines, message });
    telegramBot.notify(`NY prep: ${message}`);
    console.log(`NY LEVELS MARKED: ${summary}`);
  } catch (e) {
    console.error('Mark NY levels error:', e.message);
    broadcast({ type: 'ny-levels', ok: false, status: 'error: ' + e.message });
  }
}

// ── ForexFactory → TradingView chart sync ──────────────────────────────────────
// ForexFactory is the timing source of truth: each red-folder (High impact)
// event's timestamp from the calendar feed is converted directly into a chart
// vertical_line, so the no-trade window is visible on the same TradingView
// chart Anoop is already watching — no separate lookup needed. On-demand only
// (button, WS message, or chained from markLondonLevels above) — this does
// NOT run on the 60s background recompute loop, since there is no de-dupe or
// draw_remove tool wired in here and that would keep stacking duplicate lines.
async function markNewsTimesOnChart() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) {
    broadcast({ type: 'news-chart-marks', ok: false, status: 'TV offline' });
    return;
  }
  try {
    const status = computeNewsStatus();
    const events = [];
    if (status.activeEvent) events.push({ ...status.activeEvent, color: '#d1293b' });
    events.push(...status.upcoming.map(e => ({ ...e, color: '#b5750a' })));

    if (!events.length) {
      broadcast({ type: 'news-chart-marks', ok: true, status: 'No red-folder events left today — nothing to mark.' });
      return;
    }

    const marked = [];
    for (const ev of events) {
      const tsMs = ev.ts || ev.until;
      if (!tsMs) continue;
      const tsSec = Math.floor(tsMs / 1000);
      try {
        await mcpBridge.callTool('draw_shape', {
          shape: 'vertical_line',
          point: { time: tsSec },
          text: `${ev.title} (${ev.country})`,
          overrides: JSON.stringify({ linecolor: ev.color, linewidth: 1, linestyle: 2 })
        });
        marked.push(ev.title);
      } catch (e) {
        console.error(`Draw news marker [${ev.title}] failed:`, e.message);
      }
    }

    const istNow = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const message = marked.length
      ? `ForexFactory → chart: marked ${marked.length} event time${marked.length === 1 ? '' : 's'} at ${istNow} IST — ${marked.join(', ')}`
      : 'Tried to mark news times but every draw call failed — see server log.';
    broadcast({ type: 'news-chart-marks', ok: marked.length > 0, status: message, marked });
    console.log(`NEWS TIMES MARKED ON CHART: ${marked.join(', ') || '(none)'}`);
  } catch (e) {
    console.error('Mark news times on chart error:', e.message);
    broadcast({ type: 'news-chart-marks', ok: false, status: 'error: ' + e.message });
  }
}

// ── Economic calendar / no-trade windows (ForexFactory) ────────────────────────
// Public weekly export feed (unofficial, but the same one most retail EAs/bots
// use since ForexFactory has no official API) — the provider rate-limits this
// to 2 requests / 5 minutes across ALL export formats combined, so the raw
// feed is cached hard (30 min). FIX (2026-07-18): real fetches now only happen
// at two explicit points (app start, ~10min before NY session — see
// startNewsTracking() and checkSessionPrep()), not on a timer. The 60s UI
// loop just recomputes blackout status from whatever's cached — it never
// fetches. A manual refresh (↻ button) bypasses the cache but still only
// costs one request; spamming it can still trip the provider's own limit, in
// which case it returns an HTML "Request Denied" page instead of JSON —
// detected below and handled by falling back to the last good cache rather
// than crashing or showing garbage.
const FF_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const NEWS_CACHE_TTL_MS = 30 * 60 * 1000;
const NEWS_BLACKOUT_BEFORE_MIN = 15;
const NEWS_BLACKOUT_AFTER_MIN = 15;

let newsCache = { events: null, at: 0, error: null };
let newsBlackoutWasActive = false;
let newsInterval = null;

async function fetchForexFactoryCalendar(force) {
  if (!force && newsCache.events && Date.now() - newsCache.at < NEWS_CACHE_TTL_MS) {
    return newsCache;
  }
  try {
    const res = await fetch(FF_CALENDAR_URL);
    const text = await res.text();
    let events;
    try {
      events = JSON.parse(text);
    } catch {
      newsCache = { ...newsCache, error: 'ForexFactory export rate-limited or blocked — showing last cached data' };
      console.error('ForexFactory calendar fetch: non-JSON response (likely rate-limited)');
      return newsCache;
    }
    newsCache = { events, at: Date.now(), error: null };
    console.log(`✓ ForexFactory calendar refreshed — ${events.length} events this week`);
  } catch (e) {
    newsCache = { ...newsCache, error: 'ForexFactory fetch failed: ' + e.message };
    console.error('ForexFactory calendar fetch error:', e.message);
  }
  return newsCache;
}

// "Red folder" = impact:"High". Bank holidays come through as their own
// impact value, "Holiday" — both are literal fields the feed already provides,
// no guessing/text-matching needed.
function classifyNewsEvents(events) {
  if (!Array.isArray(events)) return { redFolder: [], holidays: [] };
  return {
    redFolder: events.filter(e => e.impact === 'High'),
    holidays: events.filter(e => e.impact === 'Holiday')
  };
}

function istDateStr(tsMs) {
  return new Date(tsMs + 5.5 * 3600000).toISOString().slice(0, 10);
}

function isSameISTDate(tsMs, referenceIstDateStr) {
  return istDateStr(tsMs) === referenceIstDateStr;
}

// Computes current blackout state + today's (IST calendar day) upcoming
// red-folder events and holidays, entirely from whatever's currently cached.
function computeNewsStatus() {
  const events = newsCache.events || [];
  const { redFolder, holidays } = classifyNewsEvents(events);
  const now = Date.now();

  const withWindow = redFolder.map(e => {
    const ts = new Date(e.date).getTime();
    return {
      title: e.title, country: e.country, date: e.date, ts,
      start: ts - NEWS_BLACKOUT_BEFORE_MIN * 60000,
      end: ts + NEWS_BLACKOUT_AFTER_MIN * 60000
    };
  });

  const active = withWindow.find(e => now >= e.start && now <= e.end) || null;
  const todayIstDateStr = new Date(now + 5.5 * 3600000).toISOString().slice(0, 10);

  const upcomingToday = withWindow
    .filter(e => e.ts >= now && isSameISTDate(e.ts, todayIstDateStr))
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 6);

  const holidaysToday = holidays.filter(e => isSameISTDate(new Date(e.date).getTime(), todayIstDateStr));

  // ── Whole-week view (2026-09-03) ─────────────────────────────────────────
  // Anoop: "need full week important red and bank holiday days for the the
  // whole week so that i am prepared."
  //
  // The feed this function reads (ff_calendar_thisweek.json) has ALWAYS
  // carried the entire ForexFactory week — Sunday through Saturday, 114 rows
  // on 2026-09-03 — and everything except today was being thrown away right
  // here. So this is a filtering change, not a new data source: no extra
  // request, no change to the 30-minute cache, nothing new that can fail.
  //
  // "The week" means the CURRENT ForexFactory week and nothing more. There is
  // no next-week feed to extend it with: ff_calendar_nextweek.json,
  // _lastweek.json and _thismonth.json all return 404 at nfs.faireconomy.media
  // (probed 2026-09-03), and cdn-nfs.faireconomy.media does not resolve. Do
  // not add a "next week" section that quietly renders empty.
  //
  // Grouping happens HERE rather than in the renderer so there is exactly ONE
  // definition of which IST day an event belongs to — the same reason
  // checklist-logic.js exists (see its header on the three disagreeing
  // definitions of "today" that lived in DOM handlers).
  const dayMap = new Map();
  const dayFor = (istDate) => {
    if (!dayMap.has(istDate)) dayMap.set(istDate, { date: istDate, events: [], holidays: [] });
    return dayMap.get(istDate);
  };
  for (const e of withWindow) {
    dayFor(istDateStr(e.ts)).events.push({
      title: e.title, country: e.country, date: e.date, ts: e.ts,
      // Marked, not dropped. A CPI print that has already passed is still part
      // of "the whole week" he asked to see; it just is not something to
      // prepare for, and the renderer dims it rather than hiding it.
      past: e.ts < now
    });
  }
  for (const h of holidays) {
    const ts = new Date(h.date).getTime();
    dayFor(istDateStr(ts)).holidays.push({ title: h.title, country: h.country, ts });
  }
  // Today ALWAYS gets a bucket, even an empty one. Every other day appears only
  // if it carries something, but a week list with no "TODAY" marker in it — the
  // real case on 2026-09-03, which has zero red-folder events — leaves him
  // reading a week with no idea where he is standing in it. An explicit
  // "clear today" is also the answer to the question the panel exists for.
  dayFor(todayIstDateStr);
  const week = Array.from(dayMap.values())
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map(d => ({
      date: d.date,
      isToday: d.date === todayIstDateStr,
      isPast: d.date < todayIstDateStr,
      events: d.events.sort((a, b) => a.ts - b.ts),
      holidays: d.holidays
    }));

  return {
    inBlackout: !!active,
    // ts kept alongside until/start so downstream consumers (e.g. the
    // ForexFactory→TradingView chart marker) can place the marker at the
    // event's actual time, not just its blackout window edges.
    activeEvent: active ? { title: active.title, country: active.country, until: active.end, ts: active.ts } : null,
    upcoming: upcomingToday,
    holidaysToday: holidaysToday.map(e => ({ title: e.title, country: e.country })),
    // week is ADDITIVE — upcoming/holidaysToday keep their exact today-only
    // meaning because the chart marker (markNewsOnChart), the Jessi context
    // builder and the Telegram alert all read them.
    week,
    todayIst: todayIstDateStr,
    weekRedRemaining: week.reduce((n, d) => n + d.events.filter(e => !e.past).length, 0),
    cacheError: newsCache.error,
    cacheAt: newsCache.at
  };
}

async function refreshNewsAndBroadcast(force) {
  await fetchForexFactoryCalendar(force);
  broadcastNewsStatus();
}

function broadcastNewsStatus() {
  const status = computeNewsStatus();
  broadcast({ type: 'news-status', ...status });

  // Only push an alert on the transition INTO a blackout, not on every 60s
  // recompute while one is already active.
  if (status.inBlackout && !newsBlackoutWasActive) {
    const untilIst = new Date(status.activeEvent.until).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const msg = `NO-TRADE WINDOW — ${status.activeEvent.title} (${status.activeEvent.country}) red-folder event. Hold off until ${untilIst} IST.`;
    telegramBot.notify(`🚫 ${msg}`);
    console.log(`NEWS BLACKOUT START: ${status.activeEvent.title}`);
  } else if (!status.inBlackout && newsBlackoutWasActive) {
    console.log('NEWS BLACKOUT ENDED');
  }
  newsBlackoutWasActive = status.inBlackout;
}

// FIX (2026-07-18, Anoop's ask): calendar re-FETCHES now happen at exactly two
// points — once here on app start, and once more from checkSessionPrep() ~10
// min before the NY session (not London). Previously this ran on a 60s
// setInterval calling refreshNewsAndBroadcast (which fetches); it was already
// cache-gated to ~1 real fetch/30min in steady state, but every app restart
// wipes the in-memory cache and forces an immediate real re-fetch+log — with
// several restarts in a session (e.g. while troubleshooting TradingView) that
// showed up as a burst of repeated "calendar refreshed" lines. The interval
// below no longer fetches at all — it only recomputes blackout status from
// whatever's already cached, so the no-trade-window indicator still updates
// live every minute without touching the network or logging a refresh.
function startNewsTracking() {
  refreshNewsAndBroadcast(false); // refresh #1: app start
  newsInterval = setInterval(() => broadcastNewsStatus(), 60 * 1000); // cheap recompute only, no fetch
}

function stopNewsTracking() {
  if (newsInterval) { clearInterval(newsInterval); newsInterval = null; }
}

// ── End-Day autosave fallback (2026-08-18) ──────────────────────────────────
// Anoop: "if I forget to save it should autosave at 8pm IST daily." endDay()
// itself is a client-side function (it reads live UI state/localStorage), so
// this server-side timer can only ask the client to run it — it broadcasts a
// trigger once IST clock time crosses 20:00 for a NEW IST calendar day, and
// the client (app.js) checks that account's own `lastEndDay` meta field
// before actually calling endDay(), so a manual End Day click earlier that
// day makes this a no-op, not a duplicate save. dataEndDay() itself writes to
// a fixed per-date filename (see dataEndDay() above) so even a genuine
// double-call overwrites the same record rather than appending a duplicate.
let endDayAutosaveInterval = null;
let endDayAutosaveFiredForDate = null;
function endDayAutosaveIstNow() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
  }).formatToParts(new Date());
  const g = t => (p.find(x => x.type === t) || {}).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) };
}
function checkEndDayAutosave() {
  const { date, hour } = endDayAutosaveIstNow();
  if (hour < 20 || endDayAutosaveFiredForDate === date) return;
  endDayAutosaveFiredForDate = date;
  broadcast({ type: 'auto-end-day-trigger', date });
}
function startEndDayAutosaveWatch() {
  checkEndDayAutosave(); // covers a restart that happens after 8pm the same day
  endDayAutosaveInterval = setInterval(checkEndDayAutosave, 5 * 60 * 1000);
}

// ── Session pre-open prep (mechanical, no LLM) ──────────────────────────────
// 10 minutes before each session open (London and NY, read from the resolved
// rules.json windows - DST-aware, so this tracks the real opens),
// auto-run the same PDH/PDL + Asia H/L zone marking as the manual "Mark
// London Levels" button, plus a Telegram heads-up. De-duped per IST calendar
// day per session so it fires once per occurrence, not every 60s tick.
// 2026-09-03: was a module-level literal duplicating rules.json's
// sessionWindowsIST. Identical numbers, but a second copy of a trading-rule
// number is exactly the drift CLAUDE.md forbids -- change a window in
// rules.json and the pre-open prep would keep firing against the old one,
// silently. Derived per call now, so rules.json is the only place a session
// time is stated.
function sessionWindowsForPrep() {
  const out = {};
  (getActiveRules().sessionWindowsIST || []).forEach(w => {
    if (!w || !w.name || w.startMin == null) return;
    out[String(w.name).toLowerCase()] = { startMin: w.startMin, endMin: w.endMin, label: w.name };
  });
  return out;
}
const sessionPrepFired = {}; // session key -> IST date of last fire (lazily keyed: a renamed or added window must not silently skip the de-dupe)

function istNowMinutesAndDate() {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  return { mins: ist.getUTCHours() * 60 + ist.getUTCMinutes(), dateStr: ist.toISOString().slice(0, 10) };
}

async function checkSessionPrep() {
  const { mins, dateStr } = istNowMinutesAndDate();
  for (const [key, win] of Object.entries(sessionWindowsForPrep())) {
    const prepStart = win.startMin - 10;
    if (mins >= prepStart && mins < win.startMin && sessionPrepFired[key] !== dateStr) {
      sessionPrepFired[key] = dateStr;
      // CHANGED 2026-07-28 (Anoop): stop auto-marking chart levels on this
      // timer — he wants zones drawn ONLY when he explicitly asks (the
      // manual "Mark London/NY Levels" button, or a direct chat request),
      // never silently in the background. This block now only fires the
      // heads-up notification; the markLondonLevels()/markNYLevels() calls
      // that used to run automatically here are removed, not just disabled,
      // so a stray flag flip can't silently bring them back.
      const msg = `${win.label} session opens in ~10 min.`;
      telegramBot.notify(`🔔 ${msg}`);
      broadcast({ type: 'session-alert', session: key, message: msg });
      console.log(`SESSION PREP: ${msg}`);
      // FIX (2026-07-18): refresh #2 of exactly 2/day — NY only, not London.
      // force=true here since this is the one refresh that has to be current
      // (the pre-NY no-trade-window check), the app-start one already covers
      // the general case.
      if (key === 'ny') {
        try { await refreshNewsAndBroadcast(true); } catch (e) { console.error('Pre-NY news refresh failed:', e.message); }
      }
    }
  }
}

let sessionPrepInterval = null;
function startSessionPrepScheduler() {
  checkSessionPrep();
  sessionPrepInterval = setInterval(checkSessionPrep, 60 * 1000);
}
function stopSessionPrepScheduler() {
  if (sessionPrepInterval) { clearInterval(sessionPrepInterval); sessionPrepInterval = null; }
}

// 1.1: ALL_MONITORS — the single list of watchers armed on TradingView
// connect, staggered by chart-bar-cache's staggerOffsetMs so the timers don't
// align on one tick. PO3 is listed alongside the five plan watchers because
// the connect sites armed it here too — one list means a watcher added later
// cannot be forgotten in one of the three connect branches (the 3-way
// duplication that hid FVG from auto-start). Each entry is idempotent to
// start and respects its own *MonitorUserDisabled flag (1.2 removes the five
// watchers' flags, PO3's stays per the plan).
// 1.2: the five plan watchers have NO cond — always on, per decision 2.
// PO3 alone keeps its user-disable flag (the plan's toggle removal list is
// the five watchers only; PO3's UI toggle stays).
// `intervalMs` here is the LIVENESS EXPECTATION, not the poll rate — the
// watchdog below flags a monitor whose last check is older than 3x this.
//
// 2026-08-26: these MUST track the bar period now that the chart watchers are
// bar-close aligned. A 30M watcher legitimately goes 30 minutes between
// checks; against the old 45s figure the watchdog would have declared it dead
// after ~2 minutes and restarted it on a loop — turning a fix for chart-lock
// contention into a far worse source of it. PO3 keeps its own timer and its
// own interval.
const ALL_MONITORS = [
  { id: 'po3',        label: 'Power of 3 (AMD)', mon: () => po3Monitor,         intervalMs: PO3_MONITOR_INTERVAL_MS, cond: () => !po3MonitorUserDisabled,  run: () => startPo3Monitor() },
  { id: 'engulf-1h',  label: 'Engulf 1H',        mon: () => engulfMonitors['1h'],  intervalMs: 60 * 60 * 1000, run: () => startEngulfMonitor('1h') },
  { id: 'engulf-30m', label: 'Engulf 30M',       mon: () => engulfMonitors['30m'], intervalMs: 30 * 60 * 1000, run: () => startEngulfMonitor('30m') },
  { id: 'engulf-15m', label: 'Engulf 15M',       mon: () => engulfMonitors['15m'], intervalMs: 15 * 60 * 1000, run: () => startEngulfMonitor('15m') },
  { id: 'engulf-5m',  label: 'Engulf 5M',        mon: () => engulfMonitors['5m'],  intervalMs: 5 * 60 * 1000, run: () => startEngulfMonitor('5m') },
  { id: 'fvg-30m',    label: 'FVG 30M',          mon: () => fvgMonitors['30m'],    intervalMs: 30 * 60 * 1000, run: () => startFVGMonitor('30m') },
  { id: 'sfp-30m',    label: 'SFP / Playbook B 30M', mon: () => sfpMonitors['30m'], intervalMs: 30 * 60 * 1000, run: () => startSFPMonitor('30m') },
];

function armMonitorsStaggered() {
  ALL_MONITORS.forEach((e, i) => {
    if (!e.cond || e.cond()) setTimeout(e.run, chartBarCache.staggerOffsetMs(i));
  });
  // Idempotent — safe on every reconnect, starts exactly one timer.
  startSignalOutcomeResolver();
  startShadowResolver();
  // Playbook C (ADX) forward test. Deliberately NOT in ALL_MONITORS: that list
  // is the chart-watcher watchdog, and every entry in it is restarted when it
  // stops reading the chart. This reads no chart, so a watchdog measuring
  // chart liveness would be measuring the wrong thing. It also stays running
  // when shadow is switched off — cadxCheckOnce() returns 'inactive' — so
  // Anoop's OFF switch takes effect on the next tick with nothing to restart.
  startAdxBreakoutMonitor();
  startHealthProtocolSchedule();
  // X5a: forward 1m capture for the bar archive. Idempotent — exactly one timer.
  startOneMinuteArchivePoll();
}

// 1.3: snapshot of the real watcher set, read back from the server — the
// Chart Watchers panel's data source (restored and hand-toggled state must
// display correctly, so the client renders THIS, never what it last sent).
function buildWatchersStatus() {
  const tvDown = !(mcpBridge.ready && mcpBridge.tvConnected);
  const rows = ALL_MONITORS.map(e => {
    const mon = e.mon();
    // 1.4: amber = no completed check within 3× the watcher's own interval;
    // red = still stale after the watchdog's one automatic restart.
    let health = 'stopped';
    if (tvDown) health = 'tv-offline';
    else if (mon.running && mon.lastCheck) {
      const age = Date.now() - new Date(mon.lastCheck).getTime();
      const WATCHER_SETTLE_MS = 30 * 1000;  // G17: a slow poll's compute+write time
      if (age > 3 * e.intervalMs) health = mon.restartAttempted ? 'red' : 'amber';  // restart threshold stays 3x
      else if (age > 2 * e.intervalMs + WATCHER_SETTLE_MS) health = 'amber';          // a close has provably been missed
      else health = 'healthy';
    }
    else if (mon.running) health = 'healthy';
    return { id: e.id, label: e.label, running: !!mon.running, health, lastCheck: mon.lastCheck || null, lastError: mon.lastError || null };
  });

  // Playbook C (ADX), appended rather than added to ALL_MONITORS (2026-09-03,
  // Anoop asked for it in the panel). It stays OUT of that list on purpose --
  // ALL_MONITORS is the chart-watcher watchdog and every entry gets restarted
  // when it stops reading the chart, which is the wrong treatment for a monitor
  // that reads no chart. But the side effect was that the one strategy in live
  // forward test had no live surface at all, and its cadxStats counters were
  // incremented on every tick and read by nothing. Appending the row here gives
  // the visibility without putting it under a watchdog that would misjudge it.
  try {
    rows.push(cadxStatus.cadxWatcherRow({
      stats: cadxStats,
      running: !!cadxMonitor,
      tvDown,
      nowMs: Date.now(),
      intervalMs: CADX_INTERVAL_MS,
      minBars: CADX_MIN_BARS,
      tfLabel: (getActiveRules().playbookCAdx && getActiveRules().playbookCAdx.tfLabel) || '1H'
    }));
  } catch (e) {
    console.warn('[c-adx] watcher row failed:', e.message);
  }

  return { tvConnected: !tvDown, rows };
}
function broadcastWatchersStatus() {
  broadcast({ type: 'watchers-status', data: buildWatchersStatus() });
}

// ── 7.3: sessions/Now.md — the live glance surface ──────────────────────────
// A PROJECTION of state, rewritten whole every tick. Never appended, never a
// record. See live-status.js's header for why each of those words is load
// bearing — the short version is that task 7.1 tried to append a live log into
// the day's session note and the review found four separate ways that silently
// destroys real trade data.
//
// Everything below is defensive by policy: this runs on a timer inside the
// process that also enforces the guardrail and places live orders. It may
// never throw, and may never delay anything.
const LIVE_EVENT_RING = [];
const LIVE_EVENT_RING_MAX = 40;   // > the render cap, so a burst still leaves history
let nowFileTimer = null;
let nowFileLastText = '';

/** Push one event onto the ring. Cheap, synchronous, cannot throw. */
function recordLiveEvent(kind, label, detail) {
  try {
    LIVE_EVENT_RING.push({ ts: Date.now(), kind, label, detail });
    if (LIVE_EVENT_RING.length > LIVE_EVENT_RING_MAX) LIVE_EVENT_RING.shift();
  } catch (_) { /* bookkeeping must never break a caller */ }
}

function writeNowFile() {
  try {
    const rules = getActiveRules();
    const md = liveStatus.renderNowMarkdown({
      mode: currentMode,
      feed: tvBrokerFeedState,
      // 2026-08-24: resolved here rather than inside the renderer so this
      // surface, the WebSocket broadcast and the agents' context all quote
      // one number from one function. Re-derived every tick (not cached) —
      // effectiveDayPnl ages the broker figure out on wall-clock, so a feed
      // that goes quiet must be able to fall back on the very next write.
      pnl: tvBrokerFeed.effectiveDayPnl(tvBrokerFeedState, Date.now()),
      tradeCount: tvBrokerFeed.effectiveTradeCount(tvBrokerFeedState),
      // Read from rules.json every tick rather than captured once — a mid
      // session mode switch (eval/funded, standard/scalper) must be reflected,
      // and CLAUDE.md forbids a second copy of any number that lives there.
      rules: {
        sizeCap: rules.sizeCap,
        tradesPerDay: rules.tradesPerDay,
        dailyLossTiers: rules.dailyLossTiers,
      },
      // G28 (2026-09-15): this Position line had NO supplier — nothing ever passed
      // `position`, so the page printed FLAT unconditionally, including through the
      // 2026-09-14 window where a 1-lot long was open for ~16 minutes. Derived from the
      // last broker positions read, with the unreadable case rendered distinctly.
      position: (function () {
        try {
          if (!Array.isArray(tvLastPositions) || !tvLastPositions.length) return null;
          const qty = tvLastPositions.reduce(function (s2, r) {
            return s2 + (parseFloat(String((r && r.Qty) || '0').replace(/,/g, '')) || 0);
          }, 0);
          return qty + ' ' + ((tvLastPositions[0] && tvLastPositions[0].Symbol) || '') + ' ' +
            String((tvLastPositions[0] && tvLastPositions[0].Side) || '').toUpperCase();
        } catch (e) { return null; }
      })(),
      positionsUnreadable: tvBrokerPositionsUnreadable,
      watchers: buildWatchersStatus(),
      recent: LIVE_EVENT_RING,
    }, Date.now());

    // Skip the write when nothing changed. Obsidian re-renders on every file
    // event, and a pane that flickers once a second in his peripheral vision
    // during a live session is a cost, not a feature. The clock is in the
    // header so this only no-ops within the same second — which is exactly
    // the burst case worth suppressing.
    if (md === nowFileLastText) return;
    nowFileLastText = md;

    // Atomic whole-file write, NOT an append: one writer, one inode swap, and
    // a torn projection on the second monitor is worse than a stale one.
    // sessionMgr owns the directory; reuse it rather than re-deriving a path.
    const p = path.join(sessionMgr.SESSIONS_DIR, 'Now.md');
    atomicWrite.writeAtomic(p, md, 'utf8');
  } catch (e) {
    // Swallowed on purpose — a glance surface must never be able to take down
    // the process that runs the guardrail. console.warn is mirrored to
    // app/logs by crash-logger, so this is recorded, not silent.
    console.warn('[now-file] write skipped:', e && e.message);
  }
}

function startNowFileWriter() {
  if (nowFileTimer) return;
  writeNowFile();
  nowFileTimer = setInterval(writeNowFile, 5000);
  if (nowFileTimer.unref) nowFileTimer.unref();
  console.log('✓ Live status file: ' + path.join(sessionMgr.SESSIONS_DIR, 'Now.md') + ' (rewritten every 5s)');
}

// ── H6: per-trade P&L attribution gate (5.2's display condition) ────────────
// CONFIRMED only when a real closed MNQ trade with non-zero P&L passes the
// balance-delta vs fills cross-check (expectedPnlFromFills). Until then the
// scorecard stays hidden — a confident wrong scorecard drives worse decisions
// than no scorecard (plan 5.2). Persisted to DATA_DIR/h6-status.json.
let h6Status = { passed: false, at: null, firstOk: null };
function h6LoadStatus() {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'h6-status.json'), 'utf8');
    const s = JSON.parse(raw);
    if (s && typeof s.passed === 'boolean') h6Status = s;
  } catch (e) { /* absent/unreadable → default not-passed */ }
}
function h6MarkPassed(tradeAt) {
  if (h6Status.passed) return;
  h6Status = { passed: true, at: new Date(tradeAt != null ? tradeAt : Date.now()).toISOString(), firstOk: h6Status.firstOk || new Date().toISOString() };
  try { fs.writeFileSync(path.join(DATA_DIR, 'h6-status.json'), JSON.stringify(h6Status, null, 2), 'utf8'); } catch (e) {}
  broadcast({ type: 'h6-status', passed: h6Status.passed, at: h6Status.at, firstOk: h6Status.firstOk });
  console.log('[H6] per-trade P&L attribution CONFIRMED — the scorecard may be shown');
}

// ── 2.1 signal ledger + 2.2 armed-setup slot ────────────────────────────────
// ledgerSignal: append one row to DATA_DIR/signals/<trading-day>.jsonl at
// fire time, with context captured NOW (never reconstructed later). Failure-
// tolerant: a disk problem must never break the live alert the user is seeing.
function ledgerSignal(fields) {
  try {
    const cfg = loadConfig();
    const istMin = Math.floor((Date.now() + 5.5 * 3600000) % 86400000 / 60000);
    const windows = (getActiveRules().sessionWindowsIST || []).map(w => ({ startMin: w.startMin, name: w.name || null }));
    const news = computeNewsStatus();
    const hourTrend = (po3TrendCache['60'] && po3TrendCache['60'].value) ? po3TrendCache['60'].value.label : null;
    const hourBucket = hourEdgeTable[Math.floor(istMin / 60)] || null;
    const row = signalLedger.buildSignalRow(fields, {
      sessionTier: signalLedger.sessionTierForMinutes(istMin, windows),
      dailyTrend: null, // Daily is Anoop's own read — deliberately not captured mechanically (see gatherAnalysisContext)
      hourTrend,
      newsBlackout: news.inBlackout,
      symbol: chartSymbolCache.symbol,
      accountSlot: jessiBucketKey(cfg),
      mode: currentMode,
      // 6.2 reporting-only annotation. Suppressed below hour-edge's MIN_SAMPLE:
      // stamping the raw winPct wrote "hourEdge: 100" onto 13 signal rows off a
      // SINGLE trade. The sample size now rides along so no reader has to trust
      // a percentage without it.
      hourEdge: hourEdgeModule.reliableWinPct(hourBucket),
      hourEdgeN: hourBucket && typeof hourBucket.n === 'number' ? hourBucket.n : null,
    });
    const day = tradingDayStampIST(Date.now());
    const dir = path.join(DATA_DIR, 'signals');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, day + '.jsonl'), signalLedger.serializeSignal(row), 'utf8');
  } catch (e) {
    console.error('[signal-ledger] write failed:', e.message);
  }
}

// ── Signal outcome resolution (2026-08-23) ─────────────────────────────────
// Closes the selection-bias hole in the detection loop. The ledger above
// records every fire; signal-join.js matches TAKEN trades back to one. Until
// now nothing scored the signals Anoop DIDN'T take — so per-playbook accuracy
// was measured only on the subset his discretion had already filtered, which
// measures the filter, not the detector.
//
// Runs on a slow timer and only ever resolves signals whose full bar horizon
// has already elapsed, so it does no work the monitors' own bar reads have
// not already made cheap (getFullBars is cached per bar period, and owns the
// chart lock + timeframe restore). Outcomes are written to a SEPARATE file —
// the ledger itself is append-only and must stay the untouched record of what
// fired at the time.
const SIGNAL_OUTCOME_HORIZON_BARS = 12;
let signalOutcomeTimer = null;

function signalOutcomePaths(day) {
  const dir = path.join(DATA_DIR, 'signals');
  return { dir, ledger: path.join(dir, day + '.jsonl'), outcomes: path.join(dir, day + '.outcomes.jsonl') };
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

// 2026-09-04 (Phase 1): give the Judge a NUMBER, not a vibe. The measured
// per-playbook win rate from the outcome ledger is the only honest "probability
// of success" the app has — computed mechanically (signal-outcome.js), never
// judged. Returns a context block, or '' when there is no resolved outcome yet.
// Cap at 30 days so an old market regime does not anchor today's number.
function buildPlaybookEdgeStats() {
  try {
    const dir = path.join(DATA_DIR, 'signals');
    if (!fs.existsSync(dir)) return '';
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.outcomes.jsonl'))
      .sort()
      .reverse();
    const rows = [];
    for (const f of files.slice(0, 30)) rows.push(...readJsonl(path.join(dir, f)));
    const resolved = rows.filter((r) => r && r.resolved);
    if (!resolved.length) return '';
    const agg = signalOutcome.aggregateOutcomes(resolved);
    const lines = agg
      .filter((b) => b.n >= 5)   // T2.4: omit n<5 — statistically meaningless
      .map((b) => {
        const provisional = b.n < 15 ? ' [PROVISIONAL n<15]' : '';
        const wr = b.winRate != null ? Math.round(b.winRate * 100) + '%' : 'n/a';
        const tr = b.targetRate != null ? Math.round(b.targetRate * 100) + '%' : 'n/a';
        const mfe = b.avgMfe != null ? b.avgMfe.toFixed(1) + ' pts' : 'n/a';
        const mae = b.avgMae != null ? b.avgMae.toFixed(1) + ' pts' : 'n/a';
        return '- ' + b.playbook + '/' + b.tf + ': win ' + wr + ' (n=' + b.n + provisional + '), target-hit ' + tr + ', avg MFE ' + mfe + ', avg MAE ' + mae;
      });
    if (!lines.length) return '';   // every bucket was n<5 → nothing to report
    return '\n\n## MECHANICAL PLAYBOOK EDGE — the measured chance each setup works (computed from the outcome ledger, NOT model judgement). STATE AN EXPLICIT PROBABILITY OF SUCCESS for any GO verdict, citing these numbers. A win rate over n<15 is a coin-flip, not a signal — say so and do not dress a thin sample as confidence.\n' + lines.join('\n');
  } catch (e) {
    return '';
  }
}

// 2026-09-04 — recorded-bar fallback for the outcome resolver. The live chart
// is often on the wrong instrument (MES when the signal was MNQ), so the
// resolver must not depend on it. Recorded history lives in DATA/bars as
// <root>_<tf>[.json | _live.json]; root is mnq/gc. Reuses the C-ADX readers.
function symbolRoot(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.includes('MNQ')) return 'mnq';
  if (s.includes('MGC') || s.includes('GC')) return 'gc';
  return null;
}
function readRecordedBars(symRoot, tf) {
  if (!symRoot) return null;
  const candidates = [symRoot + '_' + tf + '_live.json', symRoot + '_' + tf + '.json', symRoot + '_' + tf + 'm.json'];
  for (const f of candidates) {
    try {
      const raw = cadxReadSeries(f);
      if (Array.isArray(raw) && raw.length) return cadxToBars(raw);
    } catch (e) { /* try the next name */ }
  }
  return null;
}

async function resolveSignalOutcomes() {
  try {
    const today = tradingDayStampIST(Date.now());
    const { dir, outcomes: todayOutcomes } = signalOutcomePaths(today);
    // 2026-09-04 FIX (Claude review): read the last N days, not just today.
    // A signal near the IST rollover was orphaned forever because only today's
    // ledger was opened. The done set dedupes, so this is idempotent. Cap at 10
    // days — recorded bars are rolling windows and older signals can't resolve.
    const DAYS = 10;
    let ledgerFiles = [], outcomeFiles = [];
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
      ledgerFiles = files.filter((f) => !f.includes('.outcomes')).slice(0, DAYS);
      outcomeFiles = files.filter((f) => f.includes('.outcomes')).slice(0, DAYS);
    } catch (e) { return; }
    const rows = [];
    for (const f of ledgerFiles) rows.push(...readJsonl(path.join(dir, f)));
    const armed = rows.filter((r) => signalOutcome.isArmingEvent(r && r.event));
    if (!armed.length) return;

    const done = new Set();
    for (const f of outcomeFiles) {
      for (const o of readJsonl(path.join(dir, f))) done.add(`${o.signalTs}|${o.playbook}|${o.tf}`);
    }
    const pending = armed.filter((r) => !done.has(`${r.ts}|${r.playbook || null}|${r.tf || null}`));
    if (!pending.length) return;

    const currentSymbol = await getCurrentChartSymbol().catch(() => null);

    const bySymTf = new Map();
    for (const r of pending) {
      const tf = String(r.tf || '15');
      const sym = r.symbol != null ? String(r.symbol) : '';
      const key = sym + '|' + tf;
      if (!bySymTf.has(key)) bySymTf.set(key, { symbol: sym, tf, sigs: [] });
      bySymTf.get(key).sigs.push(r);
    }

    let wrote = 0;
    const deferred = [];
    for (const [key, group] of bySymTf) {
      const symRoot = symbolRoot(group.symbol);
      // F0.1 fail-closed: only use the live chart when its symbol is KNOWN and
      // matches the signal's own instrument. A null currentSymbol (read failed)
      // must NOT fall through to getFullBars — it returns whatever the chart
      // shows, which is how an MNQ signal got scored on gold bars.
      const chartKnown = currentSymbol != null;
      const chartMatches = chartKnown && (!group.symbol || signalOutcome.sameInstrument(group.symbol, currentSymbol));
      let bars = null;
      if (chartMatches) {
        try { bars = await getFullBars(group.tf, SIGNAL_OUTCOME_HORIZON_BARS * 6); } catch (e) { bars = null; }
      }
      // Recorded-bar fallback: when the chart is on another instrument (or TV
      // is down), resolve from the on-disk history instead of deferring forever.
      if ((!Array.isArray(bars) || !bars.length) && symRoot) {
        bars = readRecordedBars(symRoot, group.tf);
      }
      if (!Array.isArray(bars) || !bars.length) {
        deferred.push(key + (chartMatches ? '' : ' [chart off-instrument]'));
        continue;
      }
      for (const s of group.sigs) {
        const res = signalOutcome.resolveSignalOutcome(s, bars, { horizonBars: SIGNAL_OUTCOME_HORIZON_BARS });
        if (!res.resolved) continue;
        // F0.1 sanity bound, relative not absolute: an excursion > 2% of the
        // anchor price over a 12-bar horizon is the wrong instrument's bars,
        // not a move. Quarantine, do not persist.
        if (Number.isFinite(res.level) && res.level > 0 && (res.mfe > 0.02 * res.level || res.mae > 0.02 * res.level)) {
          fs.appendFileSync(todayOutcomes + '.quarantine.jsonl', JSON.stringify(Object.assign({}, res, { quarantined: 'sanity bound exceeded' })) + '\n', 'utf8');
          continue;
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(todayOutcomes, JSON.stringify(res) + '\n', 'utf8');
        wrote++;
      }
    }
    if (wrote) console.log(`[signal-outcome] resolved ${wrote} signal(s) across ${DAYS} day(s)`);
    if (deferred.length) console.log(`[signal-outcome] deferred ${deferred.length} group(s): ${deferred.slice(0, 6).join('; ')}${deferred.length > 6 ? ' …' : ''}`);
  } catch (e) {
    console.warn('[signal-outcome] pass failed:', e.message);
  }
}

function startSignalOutcomeResolver() {
  if (signalOutcomeTimer) return;
  // Slow on purpose: outcomes are a review-time artefact, not a live signal,
  // and every pass competes with the monitors for the one CDP connection.
  signalOutcomeTimer = setInterval(() => {
    if (!mcpBridge.tvConnected) return;
    resolveSignalOutcomes().catch((e) => console.warn('[signal-outcome] timer:', e.message));
  }, 5 * 60 * 1000);
}

// 2.2: the single live-setup slot. A newer valid setup replaces an older one.
// Expiry = 8 candles of the signal's own timeframe (mirrors the SFP patience
// window), evaluated lazily on read — no extra timer. Expiring with no
// decision recorded writes decision:'ignored' to the ledger (an untouched
// signal is itself a data point).
const ARMED_SETUP_EXPIRY_CANDLES = 8;
let armedSetup = null; // { signalTs, playbook, tfCode, tfLabel, direction, level, gapLow, gapHigh, message, expiresAt }

function tfSecondsFor(tfCode) {
  const tf = String(tfCode || '');
  if (tf === 'D') return 86400;
  if (tf === 'W') return 7 * 86400;
  const n = parseInt(tf, 10);
  if (Number.isFinite(n) && n > 0) return n * 60;
  return 900; // unknown code → 15m (matches PO3's phase TF)
}

// ── Autonomy state — the GIVE-CONTROL toggle ────────────────────────────────
// Persisted in the same config file as mode/tradingMode so it survives a
// restart. Deliberately never defaults to anything but 'off': a control switch
// that comes back on by itself after a crash is the last thing an account with
// six blow-ups behind it needs.
function readAutonomy() {
  const a = autonomyStore.readState(DATA_DIR);
  return {
    mode: autonomyGate.normaliseMode(a.mode),
    armedBy: a.armedBy || null,
    armedAt: a.armedAt || null,
    shadowDays: Number(a.shadowDays) || 0,
  };
}

// Evidence comes from the SAME resolved-outcome ledger the backtest and the
// confidence scorer read. Nothing here estimates: an absent bucket reports
// zero trades, which the gate treats as a blocker rather than as a pass.
function autonomyEvidence(playbook) {
  try {
    const rules = getActiveRules();
    // Evidence is the SHADOW TRACK RECORD — orders the gate actually proposed
    // and that actually resolved — not the signal ledger. A signal that fired
    // is not a trade that was taken, and LIVE must be earned on the latter.
    //
    // 2026-08-29: filtered to the per-trade risk cap LIVE itself runs under
    // ($200, tighter than the global $300 shadow records at). Without this,
    // CONTROL could be promoted on a record containing trades it is forbidden
    // to place — see AUTONOMY_MODES_SPEC.md §8.1.
    // Read from SHADOW's folder: that is where the track record LIVE is
    // granted on gets built. When ASSIST and CONTROL start writing their own
    // folders this becomes a per-mode read, and the folders are what make that
    // a one-line change rather than a filter nobody remembers to apply.
    const ev = autonomyStore.evidence(DATA_DIR, 'shadow', playbook, null,
      { maxRiskUsd: autonomyModes.riskCapUsd(rules, 'live') });
    return {
      playbook,
      resolvedTrades: ev.resolvedTrades,
      profitFactor: ev.profitFactor,      // null until measurable — blocks LIVE, correctly
      maxDrawdownUsd: ev.maxDrawdownUsd,
      accountDrawdownLimitUsd: (rules.eval && rules.eval.maxDrawdown) || null,
    };
  } catch (e) {
    return { playbook, resolvedTrades: 0, profitFactor: null, maxDrawdownUsd: null, accountDrawdownLimitUsd: null };
  }
}

// The playbooks CONTROL is configured to trade. Locked with Anoop 2026-08-29:
// A + B + LTF-ENGULF. Note "Playbook C" in the UI IS LTF-ENGULF — the real C is
// a validity GATE (playbook-spec.js isGate:true) and planEntry() refuses it, so
// it can never appear here as a tradeable setup.
function autonomyPlaybooks() {
  try {
    const cfg = autonomyModes.modeConfig(getActiveRules(), 'live');
    return Array.isArray(cfg.playbooks) && cfg.playbooks.length ? cfg.playbooks : ['B'];
  } catch (e) { return ['B']; }
}

// Higher = more autonomous. Used to pick the best mode achievable across the
// playbooks, never to grant one — the gate alone grants.
const AUTONOMY_RANK = { off: 0, shadow: 1, assist: 2, live: 3 };

/**
 * Evaluate the gate for EVERY configured playbook, not just Playbook B.
 *
 * 2026-08-29: this used to be `evaluateAutonomy('B')` with the 'B' hardcoded at
 * both call sites, so evidence accumulated for A and LTF-ENGULF was collected
 * and then never read by anything. Worse, the gate's own threshold comment says
 * `minResolvedTrades` is "per playbook" — so a single global verdict was
 * answering a question the bar was never asking.
 *
 * AUTONOMY IS THEREFORE PER PLAYBOOK. A playbook that has earned LIVE may be
 * traded autonomously; one that has not, may not — which is exactly the
 * per-rule autonomy FULL_AUTONOMOUS_SYSTEM_PLAN.md §1 argued for ("not
 * auto-trade everything the Judge approves"). `livePlaybooks` below is the
 * allow-list the Phase 3 execution path will consult.
 *
 * The reported effectiveMode is the BEST any playbook achieved, and the
 * reported blockers are those of the playbook CLOSEST to qualifying — so the
 * status line is an achievable to-do list rather than the worst case.
 */
function evaluateAutonomy() {
  const state = readAutonomy();
  const per = autonomyPlaybooks().map((pb) => ({
    playbook: pb,
    result: autonomyGate.evaluate(state, autonomyEvidence(pb)),
  }));
  // Defensive: an empty playbook list must not crash the status broadcast.
  if (!per.length) {
    const result = autonomyGate.evaluate(state, autonomyEvidence('B'));
    return { state, result, badge: autonomyGate.badge(result), perPlaybook: [], livePlaybooks: [] };
  }

  let best = per[0];
  let closest = per[0];
  for (const p of per) {
    if (AUTONOMY_RANK[p.result.effectiveMode] > AUTONOMY_RANK[best.result.effectiveMode]) best = p;
    if (p.result.blockers.length < closest.result.blockers.length) closest = p;
  }
  // Blockers come from the nearest-to-qualifying playbook, but only while
  // nothing has qualified — once something has, the granted result is the
  // honest one to report.
  const result = best.result.allowed ? best.result : closest.result;
  return {
    state,
    result,
    badge: autonomyGate.badge(result),
    perPlaybook: per.map((p) => ({
      playbook: p.playbook,
      effectiveMode: p.result.effectiveMode,
      allowed: p.result.allowed,
      blockers: p.result.blockers,
    })),
    livePlaybooks: per.filter((p) => p.result.effectiveMode === 'live').map((p) => p.playbook),
  };
}

function broadcastAutonomy() {
  if (!autonomyEnabled()) {
    broadcast({ type: 'autonomy-status', disabled: true, mode: 'off', effectiveMode: 'off',
                allowed: true, blockers: [], summary: 'Autonomy is disabled. You are trading.',
                badge: { text: 'YOU ARE TRADING', tone: 'off' } });
    return;
  }
  const a = evaluateAutonomy();
  const rules = getActiveRules();
  broadcast({ type: 'autonomy-status', mode: a.state.mode, effectiveMode: a.result.effectiveMode,
              allowed: a.result.allowed, blockers: a.result.blockers, summary: a.result.summary, badge: a.badge,
              // 2026-08-29: which modes are even built enough to offer. The UI
              // renders no button for a mode that is off here — a visible
              // switch that does nothing invites a click that silently fails,
              // which is worse than no switch.
              availableModes: autonomyModes.MODES.filter((m) => m === 'off' || autonomyModes.isModeEnabled(rules, m)),
              // Per-playbook verdicts. Autonomy is granted per playbook, so a
              // single blended verdict would hide that (say) B has earned it
              // while A has three trades of history.
              perPlaybook: a.perPlaybook, livePlaybooks: a.livePlaybooks });
}

// Handler for the UI toggle. Requesting LIVE never grants it — the gate does,
// and only when the evidence is there. The request is still RECORDED so the
// blockers can be shown as a to-do list rather than a flat refusal.
function handleAutonomySet(msg) {
  if (!autonomyEnabled()) {
    console.log('[autonomy] request refused — autonomy is disabled in rules.json (autonomyEnabled:false)');
    broadcastAutonomy();
    return;
  }
  const requested = autonomyGate.normaliseMode(msg && msg.mode);
  // 2026-08-29: a mode that is not switched on in rules.json cannot be entered,
  // even by a hand-crafted WebSocket message. The UI already declines to render
  // the button, but a disabled button in a browser is a courtesy, not a
  // guarantee — same reasoning that puts the real trade-confirm enforcement
  // server-side. The refusal is RECORDED, not silent, so an attempt to enter a
  // half-built mode leaves a trace.
  if (requested !== 'off' && !autonomyModes.isModeEnabled(getActiveRules(), requested)) {
    const reason = `${autonomyModes.label(requested)} is not enabled yet (rules.json autonomyModes.${autonomyModes.CONFIG_KEY[requested]}.enabled=false)`;
    console.log('[autonomy] request refused — ' + reason);
    autonomyStore.recordDecision(DATA_DIR, {
      kind: 'mode-request', requested, effective: currentAutonomyMode(),
      allowed: false, by: (msg && msg.by) || null, blockers: [reason],
    });
    broadcastAutonomy();
    return;
  }
  const prev = autonomyStore.readState(DATA_DIR);
  autonomyStore.writeState(DATA_DIR, Object.assign({}, prev, {
    mode: requested,
    // Cleared on OFF so a stale arming can never be inherited by a later
    // switch-on that nobody confirmed.
    armedBy: requested === 'off' ? null : (msg && msg.by) || null,
    armedAt: requested === 'off' ? null : new Date().toISOString(),
  }));

  const a = evaluateAutonomy();
  // Count a shadow day the moment shadow actually becomes effective, keyed on
  // the trading day so restarts cannot inflate it.
  if (a.result.effectiveMode === 'shadow') autonomyStore.markShadowDay(DATA_DIR, tradingDayStampIST(Date.now()));

  // Every request is recorded, granted or refused. The refusals are the more
  // interesting half of the record.
  autonomyStore.recordDecision(DATA_DIR, {
    kind: 'mode-request',
    requested,
    effective: a.result.effectiveMode,
    allowed: a.result.allowed,
    by: (msg && msg.by) || null,
    blockers: a.result.blockers,
  });

  console.log('[autonomy] requested=' + requested + ' effective=' + a.result.effectiveMode +
              (a.result.blockers.length ? ' blockers: ' + a.result.blockers.join('; ') : ''));
  try { telegramBot.notify('CONTROL: ' + a.badge.text + ' - ' + a.result.summary); } catch (e) {}
  broadcastAutonomy();
}

// ── SHADOW RECORDING (2026-08-26) ──────────────────────────────────────────
// Two writers, one folder. Both are no-ops unless the CONTROL toggle is in
// shadow or live, so nothing is written while Anoop is simply trading.

// Hard kill switch (rules.json autonomyEnabled, 2026-08-26). Checked FIRST so
// that when autonomy is disabled nothing records, nothing resolves and nothing
// can be toggled on — "only you mode". Fails closed on any error.
function autonomyEnabled() {
  try { return getActiveRules().autonomyEnabled === true; } catch (e) { return false; }
}

function shadowActive() {
  if (!autonomyEnabled()) return false;
  try { return currentAutonomyMode() !== 'off'; }
  catch (e) { return false; }
}

// The mode actually in force right now, or 'off'. Reads the persisted state
// and additionally requires the mode's OWN enable flag (rules.json
// autonomyModes.<mode>.enabled), so a mode still under construction cannot be
// entered by a stale state.json left behind from a previous session — the same
// fail-closed reasoning autonomy-store applies to a corrupt state file.
function currentAutonomyMode() {
  try {
    const rules = getActiveRules();
    const m = autonomyModes.normaliseMode(autonomyStore.readState(DATA_DIR).mode);
    if (m === 'off') return 'off';
    return autonomyModes.isModeEnabled(rules, m) ? m : 'off';
  } catch (e) { return 'off'; }
}

// Should the active mode stay quiet? Only SHADOW does by default: it is the one
// mode that runs WHILE Anoop trades his own account, and on 2026-08-26 its
// tickets in the chat were what made a live session confusing enough that he
// switched the entire feature off. Silence is what lets it run the ~8 weeks its
// evidence bar needs.
function autonomySilent() {
  try { return autonomyModes.isSilent(getActiveRules(), currentAutonomyMode()); }
  catch (e) { return true; }
}

// Market context AS IT IS RIGHT NOW. Captured at the moment of recording and
// never reconstructed later — a context rebuilt after the fact has already
// been contaminated by what happened next.
function shadowMarketContext() {
  const ctx = { day: tradingDayStampIST(Date.now()) };
  try {
    const istMin = Math.floor((Date.now() + 5.5 * 3600000) % 86400000 / 60000);
    const windows = (getActiveRules().sessionWindowsIST || []).map(w => ({ startMin: w.startMin, name: w.name || null }));
    ctx.sessionTier = signalLedger.sessionTierForMinutes(istMin, windows);
    ctx.istHour = Math.floor(istMin / 60);
    const h = po3TrendCache['60'] && po3TrendCache['60'].value;
    ctx.hourTrend = h ? h.label : null;
    ctx.newsBlackout = computeNewsStatus().inBlackout;
    ctx.symbol = chartSymbolCache.symbol;
    ctx.tradingMode = getActiveRules().tradingMode || 'standard';
    // ADX from whatever 1H bars are already cached. Deliberately a CACHE read,
    // never a fetch: this runs on the trade-close and setup-arm paths, and
    // blocking either on the single CDP connection to decorate a record would
    // trade a live path for a nice-to-have field. Absent cache = null, which
    // the discriminator excludes rather than scoring as "not trending".
    try {
      const cached = barCache.get(chartSymbolCache.symbol, '60', 60);
      if (Array.isArray(cached) && cached.length >= 30) {
        const a = detectors.adxSeries(cached, 14);
        const last = a.adx.length - 1;
        if (Number.isFinite(a.adx[last])) {
          ctx.adx = Math.round(a.adx[last] * 10) / 10;
          ctx.diPlusOverMinus = a.plusDI[last] > a.minusDI[last];
        }
      }
    } catch (e) { /* null stays null */ }
    ctx.breakEvenBandUsd = getActiveRules().breakEvenBandUsd || 0;
  } catch (e) { /* partial context is fine; invented context is not */ }
  return ctx;
}

// MACHINE side: one row per shadow size, so 4c and 6c are recorded from the
// SAME signal rather than from two separate runs that could diverge.
// The gates that actually passed, with their real values. Built from what the
// monitor had at fire time — never re-derived later from bars that have moved.
function shadowConfirmReasons(fields, plan) {
  const why = [];
  const px = (v) => (Number.isFinite(v) ? v.toFixed(2) : '?');
  const dir = fields.direction || '?';
  switch (fields.playbook) {
    case 'B':
      why.push(`Liquidity raid: swept ${px(fields.level)} and closed back inside (the trap candle)`);
      if (fields.gapLow != null) why.push(`Displacement FVG ${px(fields.gapLow)}-${px(fields.gapHigh)} in the raid direction (${dir})`);
      why.push(`Entry is a LIMIT at the near gap edge ${px(plan.entry)} — price must retrace to you`);
      why.push(`Stop beyond the SFP wick (${plan.stopSource})`);
      break;
    case 'A':
      // The TIMEFRAME leads. Since 2026-09-01 every engulf watcher is Playbook
      // A, so the playbook name no longer tells you which chart it came from —
      // only this line does, and a 15M engulf read as a 1H one is a different
      // trade entirely.
      why.push(`Engulfing candle closed on ${fields.tfLabel || fields.tfCode} — took out the previous candle's high AND low, and covered its body`);
      why.push('Higher-timeframe gate passed: 1H structure is clean, the 4H agrees, and this candle matches that bias');
      if (fields.structure) why.push(`Playbook C validity gate passed — structure ${fields.structure}, liquidity intact`);
      break;
    // 'C' is retained only for rows written before 2026-09-01, when the 30M/
    // 15M/5M watchers tagged themselves with the validity gate's name. Nothing
    // emits it now. The old third line claimed "NO higher-timeframe alignment
    // was required" — true when it was written, false since the gate went in,
    // and left here it would keep asserting that about historical rows.
    case 'C':
      why.push(`Engulfing candle closed on ${fields.tfLabel || fields.tfCode}`);
      if (fields.structure) why.push(`Playbook C validity gate passed — structure ${fields.structure}`);
      why.push('Recorded before 2026-09-01, when lower-timeframe engulfs were a separate playbook with no higher-timeframe gate');
      break;
    case 'C-ADX':
      // The four gates with their MEASURED values, not just "passed". A row
      // that only says a gate passed cannot be re-checked against the bars it
      // claims to have read, and this record exists to be doubted later.
      why.push(`Regime: ADX ${px(fields.adx)} >= the ${(getActiveRules().playbookCAdx || {}).adxMin ?? 35} floor — strong trend, not chop`);
      why.push(`Direction: +DI ${px(fields.plusDI)} > -DI ${px(fields.minusDI)} — the strong trend is UP`);
      why.push(`Breakout: 1H close ${px(plan.entry)} cleared the prior ${(getActiveRules().playbookCAdx || {}).lookback ?? 10}-bar high ${px(fields.priorHigh)}`);
      why.push('Breakout candle closed green, and this playbook is LONG ONLY — shorts lost in every regime tested');
      why.push(`Stop beyond the entry candle low (${plan.stopSource}); target ${plan.targetR}R`);
      break;
    default:
      if (fields.message) why.push(String(fields.message).slice(0, 200));
  }
  if (fields.message && fields.playbook !== 'B') why.push(String(fields.message).slice(0, 160));
  return why;
}

function shadowRecordMachineOrder(plan, extra) {
  if (!shadowActive() || !plan || !plan.plannable) return;
  try {
    // 2026-08-29: sizes now come from autonomyModes, NOT dshV2.shadowSizes.
    //
    // THIS IS THE FIX FOR WHY SHADOW NEVER PRODUCED A SINGLE SCORED ORDER.
    // dshV2.shadowSizes was [4, 6] — sizes chosen for the DSH-V2 breakout
    // experiment, then read by this function for EVERY playbook. At the $300
    // perTradeMaxLoss and MNQ's $2/point, 4 contracts allow only a 37.5-point
    // stop and 6 allow 25. Real Playbook B stops measure a 48.3-point median
    // (range 38.8-72.8 over the cached bars — app/scripts/risk-dist.js), so
    // every single setup was stamped blocked:risk-too-big, and blocked rows are
    // excluded from pendingMachineOrders(). The resolver therefore had nothing
    // to resolve, shadow-outcomes.jsonl was never created, and the CONTROL gate
    // read "0 resolved trades" for shadow's entire life. It would have kept
    // reading zero forever; this was a sizing misconfiguration wearing the
    // costume of an empty track record.
    //
    // Sizes are now [2] — Anoop's real sizeCap AND sizeFloor — so the record
    // describes the account he actually trades and needs no translation to be
    // believed. Decision locked 2026-08-29 (AUTONOMY_MODES_SPEC.md §8).
    const rules = getActiveRules();
    const mode = currentAutonomyMode();
    const sizes = autonomyModes.sizesFor(rules, mode);
    const base = shadowMarketContext();
      // G10: per-symbol point value from rules.json; unknown symbol refuses.
      const contractSpec = requireContractSpec(base.symbol || (extra && extra.symbol) || (plan && plan.symbol));
    // The cap in force for THIS mode — the tighter of the mode's own cap and
    // the global perTradeMaxLoss. CONTROL runs at $200 rather than $300 so its
    // $200 daily ceiling is a real ceiling instead of a limit a single stop-out
    // could overshoot by 46%.
    const maxRiskUsd = autonomyModes.riskCapUsd(rules, mode);
    for (const contracts of sizes) {
      const row = shadowRecorder.buildMachineOrder(
        Object.assign({}, plan, extra || {}),
        Object.assign({}, base, { contracts, pointValue: contractSpec.pointValue, tickSize: contractSpec.tickSize, why: (extra && extra.why) || [] })
      );
      // PRODUCTION FIX 2026-08-26: the first real shadow order recorded a
      // 79.5-point stop as $636 of risk at 4c and $954 at 6c, against a $300
      // per-trade limit. Shadow was recording orders the app would never be
      // allowed to place, which would have built a track record out of
      // impossible trades — exactly what riskGate() prevents in the backtest
      // and what this path was missing.
      //
      // Blocked orders are RECORDED, not dropped: how often a detector
      // proposes an untradeable setup is itself a finding about the detector.
      // They are excluded from evidence by the `blocked` flag instead.
      // Delegated to the pure checker so the rule that decides what a mode may
      // risk lives in exactly one place, and so "unknown risk" is refused here
      // the same way it is everywhere else — a row whose riskUsd failed to
      // compute is the most suspect order in the file, not the safest.
      const riskCheck = autonomyModes.checkOrderRisk(rules, mode, row.riskUsd);
      if (!riskCheck.allowed) {
        row.blocked = 'risk-too-big';
        row.blockedReason = `${riskCheck.reason} (at ${contracts}c)`;
      }
      // Self-describing rows: which mode proposed this, and under which cap.
      // Without these, a row read back later cannot say whether it belonged to
      // the mode being promoted — and evidence for CONTROL must exclude rows
      // recorded under SHADOW's looser $300 cap (spec §8.1). The per-mode
      // folders make that separation structural; these fields make a single
      // row answer the question on its own.
      row.mode = mode;
      row.riskCapUsd = Number.isFinite(maxRiskUsd) ? maxRiskUsd : null;
      autonomyStore.recordOrder(DATA_DIR, mode, row);
    }
  } catch (e) { console.warn('[shadow] machine order not recorded:', e.message); }
}

// HUMAN side: every closed trade of his, winner or loser, with the behavioural
// context his documented failure modes actually live in. Called from
// writeLiveTradeToDayRecord, the one choke point every closed trade passes.
function shadowRecordHumanTrade(record, join, dayKey, priorRows) {
  if (!shadowActive() || !record) return;
  try {
    // dayKey and the prior rows are PASSED IN, not recomputed. The caller has
    // already resolved both authoritatively (same day key it writes under,
    // same account slot it loads), and recomputing them here meant the shadow
    // copy could silently disagree with the day record about which day a trade
    // belonged to or which account it came from. The first three captured
    // trades all reported tradeNumberToday:1 because of exactly that kind of
    // divergence — the behavioural fields, which are the most valuable thing
    // this records, were all wrong while looking perfectly plausible.
    const day = dayKey || dayRollup.tradingDayKey(record.at);
    const rules = getActiveRules();
    const band = rules.breakEvenBandUsd || 0;
    // Prior trades TODAY, so trade number / day P&L / gap-since-last are the
    // values that were true BEFORE this trade — not after it.
    const prior = (Array.isArray(priorRows) ? priorRows : [])
      .filter(r => r && r.t != null && r.t < record.at)
      .map(r => ({ at: r.t, pnl: r.pnl, size: r.size }));
    prior.sort((a, b) => a.at - b.at);
    const prev = prior.length ? prior[prior.length - 1] : null;
    const prevPnl = prev && Number.isFinite(prev.pnl) ? prev.pnl : null;

    const ctx = Object.assign(shadowMarketContext(), {
      day,
      signalBacked: join ? !!join.signalBacked : null,
      signalPlaybook: join ? join.playbook : null,
      minutesFromSignal: join ? join.minutesFromSignal : null,
      tradeNumberToday: prior.length + 1,
      contractsSoFarToday: prior.reduce((a, r) => a + (Math.abs(Number(r.size)) || 0), 0),
      dayPnlBefore: prior.reduce((a, r) => a + (Number(r.pnl) || 0), 0),
      minutesSincePrevTrade: (prev && prev.at != null) ? Math.round((record.at - prev.at) / 60000) : null,
      prevTradeOutcome: prevPnl == null ? null : (prevPnl > band ? 'win' : (prevPnl < -band ? 'loss' : 'breakeven')),
      prevSize: prev && prev.size != null ? Math.abs(Number(prev.size)) : null,
      breakEvenBandUsd: band,
    });
    // The live fold re-fires on the same closed trade — the day record is
    // idempotent through its fingerprint merge, but this hook is not, and the
    // first day produced a third shadow row that was a duplicate of the first
    // trade. Same fingerprint the day record dedupes on.
    const fp = record.t + '|' + record.x + '|' + Math.round(Number(record.pnl) * 100) + '|' + record.size;
    // 2026-08-29: his trades live in DATA/autonomy/human/trades.jsonl, ONE
    // stream regardless of which mode is running — see autonomy-store's header
    // for why filing them under the active mode would break the one comparison
    // worth making (his discretion vs the machine on the same market).
    const already = autonomyStore.readHumanTrades(DATA_DIR)
      .some(r => r && r.fingerprint === fp);
    if (already) return;
    const built = shadowRecorder.buildHumanTradeRecord(record, ctx);
    built.fingerprint = fp;
    autonomyStore.recordHumanTrade(DATA_DIR, built);
  } catch (e) { console.warn('[shadow] human trade not recorded:', e.message); }
}

// ── MACHINE-ORDER RESOLVER (2026-08-26) ────────────────────────────────────
// Machine shadow was only half a system until this: armSetup recorded the
// order the app WOULD have sent, and nothing ever scored it, so every row sat
// at resolved:false forever and the CONTROL gate read zero resolved trades no
// matter how long shadow ran. Autonomy could never have been earned.
//
// Uses backtest.simulateTrade — the SAME function the 9-month backtest runs
// on — so a shadow result and a backtest result are produced by identical
// code. If they ever disagree it is because the market differed, not because
// two implementations drifted. That is the whole reason the detectors were
// extracted in the first place.
//
// Slow timer, and it only touches orders whose full horizon has already
// elapsed, so it competes with the monitors for the one CDP connection as
// little as possible.
const btEngine = require('./backtest');
let shadowResolveTimer = null;

async function resolveShadowOrders() {
  try {
    // Resolve within the folder of the mode that RECORDED the orders.
    const resolveMode = currentAutonomyMode();
    const pending = autonomyStore.pendingMachineOrders(DATA_DIR, resolveMode);
    if (!pending.length) return;
    const rules = getActiveRules();
    const horizon = rules.playbooks.outcomeHorizonBars;

    // One bar fetch per distinct timeframe, not one per order.
    const byTf = new Map();
    for (const o of pending) {
      const tf = String(o.tf || '30');
      if (!byTf.has(tf)) byTf.set(tf, []);
      byTf.get(tf).push(o);
    }

    let wrote = 0;
    for (const [tf, orders] of byTf) {
      let bars = [];
      try { bars = await getFullBars(tf, horizon * 8); }
      catch (e) { console.warn('[shadow-resolve] bar read failed for tf ' + tf + ':', e.message); continue; }
      if (!Array.isArray(bars) || bars.length < horizon + 2) continue;

      for (const o of orders) {
        // The bar the order was placed on: the last one that had CLOSED at
        // the time it was recorded. Anything later would score the order
        // against price action it could not have been placed into.
        const tsSec = Math.floor(Date.parse(o.ts) / 1000);
        if (!Number.isFinite(tsSec)) continue;
        let idx = -1;
        for (let i = 0; i < bars.length; i++) if (bars[i].time <= tsSec) idx = i; else break;
        if (idx < 0) continue;

        const plan = {
          playbook: o.playbook, direction: o.direction,
          entry: o.entry, stop: o.stop, target: o.target,
          riskPoints: o.riskPoints,
          // Playbook B is a limit back into the gap; the engulf/breakout
          // families are market-on-close. planEntry already decided which,
          // and that decision must not be re-guessed here.
          requiresFill: o.playbook === 'B',
          fillWindowBars: rules.playbooks.fvgFillWindowBars,
        };
        if (!Number.isFinite(plan.entry) || !Number.isFinite(plan.stop) || !Number.isFinite(plan.target)) continue;

        const sim = btEngine.simulateTrade(plan, bars, idx, {
          horizonBars: horizon,
          slippagePoints: 0.5,
          flattenByISTMinutes: rules.flattenByISTMinutes,
        });
        // null = the horizon has not fully elapsed yet. Normal, not an error,
        // and deliberately NOT written — it will resolve on a later pass.
        if (!sim) continue;

        const comm = (rules.commissionPerContractPerSide || 0.95) * 2 * (o.contracts || 1);
        // G10: point value from the contracts block, never a hardcoded $2/pt.
        const _pvSpec = requireContractSpec(o.symbol || 'MNQ');
        const _pvUsd = _pvSpec ? _pvSpec.pointValue : null;
        const netUsd = sim.filled && _pvUsd != null ? (sim.points * _pvUsd * (o.contracts || 1) - comm) : 0;
        autonomyStore.recordOutcome(DATA_DIR, resolveMode, {
          id: o.id, day: o.day, playbook: o.playbook, contracts: o.contracts,
          outcome: sim.outcome, netUsd: Math.round(netUsd * 100) / 100, bars: sim.bars,
        });
        wrote++;
      }
    }
    if (wrote) {
      console.log('[shadow-resolve] resolved ' + wrote + ' machine order(s)');
      try { autonomyStore.rollupDay(DATA_DIR, resolveMode, tradingDayStampIST(Date.now())); } catch (e) {}
      broadcastAutonomy();
    }
  } catch (e) { console.warn('[shadow-resolve] pass failed:', e.message); }
}

// ── Is a trading session live right now? ───────────────────────────────────
// A real in-window check on BOTH edges. Deliberately not
// signalLedger.sessionTierForMinutes, which only compares against startMin and
// so reports "NY" for every minute after NY opens, including midnight — fine
// for labelling a trade's tier, useless for "should I stay off the wire".
function inSessionWindowNow() {
  try {
    const istMin = Math.floor((Date.now() + 5.5 * 3600000) % 86400000 / 60000);
    return (getActiveRules().sessionWindowsIST || []).some((w) =>
      Number.isFinite(w.startMin) && Number.isFinite(w.endMin)
      && istMin >= w.startMin && istMin <= w.endMin);
  } catch (e) {
    // Unknown = treat as IN session, i.e. stay off the wire. The conservative
    // direction here is to do less, not more.
    return true;
  }
}

// ── 2026-08-29: the resolver yields to the live watchers ───────────────────
// rules.json's _autonomyEnabled_comment names this path directly as a reason
// autonomy was switched off: "the shadow resolver was one more 5-minute chart
// reader competing with the watchers." It reads bars over the single CDP
// connection, and it was doing so every 5 minutes regardless of what else
// needed that connection.
//
// Nothing about this work is urgent. A machine order's outcome is scored over
// a 12-bar horizon — six hours on the 30m chart — so resolving it at 13:05
// instead of 13:00 changes nothing except who gets the wire. So:
//
//   • every 15 minutes, not 5
//   • never DURING a session window, when the watchers are the whole point
//   • never while an order is being placed
//   • never while the chart lock is held
//
// Pending orders are not lost by a skip; pendingMachineOrders() re-finds them
// on the next pass, and the resolver already ignores any horizon that has not
// fully elapsed.
const SHADOW_RESOLVE_INTERVAL_MS = 15 * 60 * 1000;

function startShadowResolver() {
  if (shadowResolveTimer) return;
  shadowResolveTimer = setInterval(() => {
    if (!autonomyEnabled()) return;
    if (!mcpBridge.tvConnected) return;
    if (!shadowActive()) return;
    // Yield to anything that actually needs the chart right now.
    if (inSessionWindowNow()) return;
    if (tvOrderPlacementInFlight) return;
    resolveShadowOrders().catch((e) => console.warn('[shadow-resolve] timer:', e.message));
  }, SHADOW_RESOLVE_INTERVAL_MS);
  if (shadowResolveTimer.unref) shadowResolveTimer.unref();
}

// ── Playbook C (ADX) forward test — the monitor ────────────────────────────
// Added 2026-09-01. Anoop: "forward test it". The strategy in
// "DSH backtesting/" has never traded and, until this, had no way to ever
// produce a live signal: nothing in this server evaluated its four gates. The
// only ADX in the live path was shadowMarketContext()'s decoration field.
//
// This fires the detector on each closed 1H bar and arms the setup, which puts
// it through armSetup() — the same choke point A, B and LTF-ENGULF go through
// — so it is recorded by the shadow recorder with no separate ledger and no
// separate resolver. It places NO orders and cannot: shadow's whole contract
// is that it records the order it WOULD have sent.
//
// ── IT READS THE LIVE TRADINGVIEW FEED (Anoop, 2026-09-01) ────────────────
// "All the data when goes to shadow should be from live feed... By live feed I
// mean TradingView MCP." So this goes through getFullBars('60', ...) — the
// same withChartLock'd MCP path every other watcher uses — rather than reading
// only what other watchers happened to leave in barCache.
//
// The cost is bounded by the cache in front of it, not by the tick rate. A 1H
// barCache entry stays fresh for the rest of its hour and goes stale exactly
// at the top of the next one, so a 60-second tick produces roughly ONE real
// MCP fetch per hour — at the moment the bar he cares about has just closed —
// and returns cached bars for the other 59 ticks. That is why the fast tick
// does not reintroduce the chart contention the autonomyEnabled kill-switch
// comment blames for switching this off in August.
//
// It deliberately does NOT skip session windows the way the shadow resolver
// does. The resolver is scoring old orders and can wait; this is the thing
// producing the signals he asked to receive immediately, and a signal withheld
// until after his London/NY session is a signal he cannot act on. His control
// over that is the OFF toggle, not a hidden schedule.
//
// ── WHY IT KEEPS ITS OWN HISTORY FILE ─────────────────────────────────────
// It asks the feed for 120 bars and TradingView generally returns ~300, so on
// a good fetch the history file is belt-and-braces. It earns its place on a
// BAD one: a short or partial read still has to be refused rather than scored,
// and merging into a stored series means a thin fetch is topped up from
// history instead of silently producing a different rule.
//
// The 1H cache holds 40-60 bars, and that is NOT ENOUGH to reproduce the
// backtested rule. Wilder's ADX is recursive, so a short window has not
// converged: measured on the real cached series 2026-09-01, a 40-bar window
// carries a mean ADX error of 5.6 (max 25.4) against the full series and
// fires 12 signals where the true series fires 9 — a third of them false. At
// 120 bars the error is 0.03 and the signals agree exactly, 786/786. A forward
// test run off the raw cache would therefore be measuring a DIFFERENT rule
// than the one that was backtested, while looking entirely healthy.
//
// So each tick folds the cached bars into a growing 30M series using
// bar-recorder's mergePull — the same four rules (drop the forming bar, later
// data wins a tie, spacing verified not trusted, only ever grows) already
// trusted for the 1m/5m history. Written to its OWN file, seeded from the
// research dataset: mnq_60.json is what the published backtest was computed
// on and must stay byte-stable, or the numbers in the playbook stop being
// reproducible. A live-appended research dataset is a silently moving
// baseline.
// 60s, not 5min (Anoop 2026-09-01: "signals are given to me immediately").
// The 30M cache entry goes stale exactly on each half hour, so after a bar
// closes the sequence is: engulf-30m watcher refetches (bar-close aligned,
// ~5s) -> cache repopulated -> this tick reads it (<=60s). Just over a minute
// worst case, which is as immediate as a design that issues zero CDP calls
// can be, and faster than the 1H version was because the 30M watcher is
// bar-aligned rather than waiting out an interval. The tick is
// cheap enough to run this often because the merged series is held in memory
// and the file is only rewritten when a bar actually changed.
const CADX_INTERVAL_MS = 60 * 1000;
// ── 30M, NOT 1H (Anoop, 2026-09-03) ───────────────────────────────────────
// "change the playbook C (ADX) to 30 mins candle close too as entry which is
//  currently 1hr."
//
// It had fired ZERO times since being armed, and the history says that is not
// a bug — it is the rule. Replayed over its own 1,037-bar 1H research set the
// strategy produces 10 signals total, and over the most recent 150 hours (the
// same wall-clock span the live watcher has been up for) it produces none.
// Replaying 300 real 30M bars across that same recent span produces one. A
// strategy that cannot fire inside its own forward-test window is not being
// measured, it is being waited for.
//
// The history file MUST change with the timeframe. Merging 30M pulls into
// mnq_60_live.json would be caught by mergePull's spacing check and rejected
// forever — a monitor reporting "merge-rejected" on every tick while looking
// alive. mnq_60_live.json is left on disk untouched: it is the 1H forward
// test's own record and deleting it would destroy the only evidence that run
// produced.
//
// The seed is mnq_30.json — a cached 300-bar pull, NOT a research set; there
// is no published 30M backtest for this rule, which is the whole caveat below.
// It ends ~2026-08-26, so the merged series carries a small gap before the
// live pull picks up. That is harmless here: the gap sits ~300 bars behind the
// newest data and Wilder smoothing has long since decayed by the time the
// detector reads the recent end. Seeding at all is a convenience — a live 30M
// pull returns ~300 bars on its own, which already clears CADX_MIN_BARS.
// mnq_60.json is what the published 1H backtest was computed on and must stay
// byte-stable or those numbers stop being reproducible.
//
// WHAT THIS INVALIDATES, SAID OUT LOUD: the ADX>=35 / +DI>-DI / 10-bar-high
// parameters were fitted and published on 1H bars. Running them on 30M is a
// NEW rule with an unmeasured edge, not the backtested one at a faster clock.
// It stays shadowOnly in rules.json, and its forward-test rows are the only
// evidence that will exist for it.
// Timeframe is configurable in rules.json (playbookCAdx.tfCode). File names
// derive from it so switching 1H <-> 30M is a config edit, not a code change.
// 2026-09-04 (Anoop): moved back to 1H (tfCode "60") — the timeframe the edge
// was actually measured on — plus lookback 5, the dominant 2-contract cell.
function cadxFileNames(tfCode) {
  return { history: 'mnq_' + tfCode + '_live.json', seed: 'mnq_' + tfCode + '.json' };
}
// Below this the detector is measuring a different rule (see above). It
// REFUSES rather than fires — TRUST-PROTOCOL Rule 1.
const CADX_MIN_BARS = 120;
// What to ask the feed for. TradingView's bridge returns ~300 regardless, but
// the number still matters: it is the count barCache keys freshness on, so
// asking for 120 means a later 40-bar request is served from this entry rather
// than triggering its own fetch.
const CADX_FETCH_BARS = 120;
let cadxMonitor = null;
let cadxLastFiredBarTime = null;
let cadxSeries = null;          // merged history (timeframe from rules.json), held in memory between ticks
const cadxStats = { checks: 0, cacheMiss: 0, shortHistory: 0, signals: 0, bars: 0, lastCheckAt: null, lastSignalAt: null, lastStatus: null };

// ── The shape adapter, and why it is not optional ─────────────────────────
// bar-recorder emits `{t,o,h,l,c}` with `t` in MILLISECONDS; every detector
// and every other bar path in this server uses `{time,open,high,low,close}`
// with `time` in SECONDS. Feeding the merged series straight to the detector
// returns null forever: `bar.high` is undefined, so the finite-price guard
// refuses every bar and the monitor reports a clean, healthy "no-signal" while
// being structurally incapable of ever producing one.
//
// That is not a hypothetical — it is exactly how shadow spent its entire first
// life recording nothing (see the autonomyModes comment in rules.json: sizes
// so small every setup was stamped blocked, and no one noticed because an
// empty file looks the same as a quiet market). Caught here 2026-09-01 by
// replaying real bars through the full pipeline before shipping, which is the
// only reason it is a comment instead of eight silent weeks.
function cadxToBars(merged) {
  const out = [];
  for (const b of merged || []) {
    if (!b || !Number.isFinite(b.t)) continue;
    out.push({ time: Math.round(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c });
  }
  return out;
}

function cadxReadSeries(file) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'bars', file), 'utf8'));
    const b = Array.isArray(d) ? d : (d.bars || []);
    return Array.isArray(b) ? b : [];
  } catch (e) { return []; }
}

// One tick. Returns a short status string for the log and the health panel.
// Separated from the timer so it is callable from a test and by hand.
async function cadxCheckOnce() {
  cadxStats.checks++;
  cadxStats.lastCheckAt = Date.now();
  const done = (s) => { cadxStats.lastStatus = s; return s; };

  // Only record when something is listening. Shadow off = nothing to write to,
  // which is also what makes his NY-session OFF switch actually stop the work
  // rather than merely hide it.
  if (!autonomyEnabled() || !shadowActive()) return done('inactive');

  const symbol = chartSymbolCache.symbol;
  // MNQ only. The strategy was validated on MNQ 1H and nothing else; firing it
  // on whatever symbol the chart happens to show would file MGC results under
  // an MNQ track record.
  if (!symbol || !/^(CME_MINI:)?MNQ/i.test(String(symbol))) return done('not-mnq');

  // Live feed. getFullBars serves from barCache within the hour and goes to
  // TradingView MCP when it has gone stale, under withChartLock and with the
  // chart's original timeframe restored — the restore-safe path, never
  // batch_run (see tradingview-mcp/CLAUDE.md for why that one is banned).
  if (!mcpBridge.ready || !mcpBridge.tvConnected) return done('tv-down');
  // Never contend with an order actually being sent. Same guard the shadow
  // resolver uses; a recording job must always lose that race.
  if (tvOrderPlacementInFlight) return done('order-in-flight');
  const cfg = getActiveRules().playbookCAdx || {};
  const cadxTf = cfg.tfCode || '60';
  const cadxFiles = cadxFileNames(cadxTf);
  let cached;
  try {
    cached = await getFullBars(cadxTf, CADX_FETCH_BARS);
  } catch (e) {
    cadxStats.cacheMiss++;
    return done('fetch-failed');
  }
  if (!Array.isArray(cached) || cached.length < 3) {
    cadxStats.cacheMiss++;
    return done('no-bars');
  }

  // Grow the history. mergePull drops the forming bar and verifies spacing, so
  // a mid-switch read of the wrong timeframe is rejected rather than merged.
  const fp = path.join(DATA_DIR, 'bars', cadxFiles.history);
  if (!cadxSeries) {
    cadxSeries = cadxReadSeries(cadxFiles.history);
    if (!cadxSeries.length) cadxSeries = cadxReadSeries(cadxFiles.seed);   // seed once from the research set
  }
  const merged = barRecorder.mergePull(cadxSeries, cached, Number(cadxTf));
  if (merged.rejected) {
    console.warn('[c-adx] ' + (cfg.tfLabel || cadxTf) + ' merge rejected: ' + merged.reason);
    return done('merge-rejected');
  }
  cadxSeries = merged.bars;
  // Disk only when a bar actually changed. At a 60s tick, rewriting a
  // thousand-bar file every minute to record nothing would be the single most
  // wasteful thing in this process.
  if (merged.added || merged.replaced) {
    try { atomicWrite.writeAtomic(fp, JSON.stringify(merged.bars), 'utf8'); } catch (e) {}
  }
  const bars = cadxToBars(merged.bars);
  cadxStats.bars = bars.length;
  if (bars.length < CADX_MIN_BARS) {
    cadxStats.shortHistory++;
    return done('short-history:' + bars.length);
  }

  // mergePull has already dropped the forming bar, so the newest bar here is
  // CLOSED. The detector reads index n-2, so append a placeholder to line the
  // two conventions up rather than teaching the detector two modes.
  const last = bars[bars.length - 1];
  const sig = detectors.detectAdxBreakoutFromBars(bars.concat([last]), {
    period: 14,
    adxMin: Number.isFinite(cfg.adxMin) ? cfg.adxMin : 35,
    lookback: Number.isFinite(cfg.lookback) ? cfg.lookback : 10,
  });
  if (!sig) return done('no-signal');

  // ── THE HTF GATE (2026-09-01) ──────────────────────────────────────────
  // C-ADX had its own regime read (ADX>=35 and +DI>-DI) and answered only to
  // that. It now ALSO answers to the 1H/4H structure gate, like every other
  // playbook. The two are not redundant: ADX measures trend STRENGTH from the
  // 1H bars alone, while the gate asks whether the 1H structure is a clean
  // HH-HL at all.
  //
  // The 4H no longer participates in that decision (same day: Anoop demoted it
  // from veto to evidence). A strong 1H push against a bearish 4H therefore
  // now PASSES here and is recorded carrying `htfConfirmation: 'disagrees'`
  // — which, for a playbook still in forward test with a 43-trade sample, is
  // the more useful outcome anyway: it produces a row to judge later instead
  // of a silence that proves nothing.
  const cadxGate = await htfGate('C-ADX', cadxTf, sig.direction);
  if (!cadxGate.allowed) return done('htf-blocked');

  // One signal per closed bar, however often the poll re-sees it. Same bug the
  // FVG monitor had with wall-clock buckets (playbook-spec.js setupId header).
  if (cadxLastFiredBarTime === sig.barTime) return done('already-fired');
  cadxLastFiredBarTime = sig.barTime;
  cadxStats.signals++;
  cadxStats.lastSignalAt = Date.now();

  console.log('[c-adx] SIGNAL ' + new Date((sig.barTime || 0) * 1000).toISOString()
    + ' close ' + sig.bar.close + ' > priorHigh ' + sig.priorHigh
    + ' | ADX ' + sig.adx + ' +DI ' + sig.plusDI + ' -DI ' + sig.minusDI);

  // G19: C-ADX has written ZERO fire rows — only htf-reject (76 of 76). Ledger
  // the fire so its block rate finally has a denominator. planEntry returns the
  // real entry/stop, so the row carries a real anchor.
  let _cadxPlan = null;
  try {
    _cadxPlan = playbookSpec.planEntry('C-ADX', { direction: 'BULLISH', bar: sig.bar, barTime: sig.barTime, entryRef: sig.entryRef }, getActiveRules());
  } catch (e) {}
  ledgerSignal({
    event: 'c-adx-fire',
    playbook: 'C-ADX', tf: cadxTf, direction: 'BULLISH',
    setupId: playbookSpec.setupId('C-ADX', { direction: 'BULLISH', barTime: sig.barTime, entryRef: sig.entryRef }),
    entry: _cadxPlan && _cadxPlan.plannable ? _cadxPlan.entry : null,
    stop: _cadxPlan && _cadxPlan.plannable ? _cadxPlan.stop : null,
    adx: sig.adx, plusDI: sig.plusDI, minusDI: sig.minusDI,
    htfBias: cadxGate.bias,
    structure15m: cadxGate.structure15m,
    structure1h: cadxGate.structure1h,
    htfConfirmation: cadxGate.htfConfirmation != null ? cadxGate.htfConfirmation : cadxGate.confirmation,
  });

  armSetup({
    playbook: 'C-ADX',
    direction: 'BULLISH',
    bar: sig.bar,
    barTime: sig.barTime,
    entryRef: sig.entryRef,
    tfCode: cadxTf,
    tfLabel: cfg.tfLabel || '1H',
    adx: sig.adx, plusDI: sig.plusDI, minusDI: sig.minusDI, priorHigh: sig.priorHigh,
    htfBias: cadxGate.bias,
    structure15m: cadxGate.structure15m,
    structure1h: cadxGate.structure1h,
    htfConfirmation: cadxGate.htfConfirmation != null ? cadxGate.htfConfirmation : cadxGate.confirmation,
    message: 'Playbook C (ADX) — ADX ' + sig.adx + ' >= ' + sig.adxMin
      + ', +DI > -DI, close ' + sig.bar.close + ' broke the prior ' + sig.lookback + '-bar high ' + sig.priorHigh
      + ' — ' + htfAlignment.confirmationNote(cadxGate),
  });
  return done('signal');
}

function startAdxBreakoutMonitor() {
  if (cadxMonitor) return;
  // Ticks never overlap: a fetch that is slow (or stuck behind the chart lock)
  // must not have a second one queued on top of it.
  let inFlight = false;
  cadxMonitor = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    Promise.resolve()
      .then(cadxCheckOnce)
      .catch((e) => console.warn('[c-adx] tick failed:', e && e.message))
      .then(() => { inFlight = false; });
  }, CADX_INTERVAL_MS);
  if (cadxMonitor.unref) cadxMonitor.unref();
  console.log('[c-adx] Playbook C (ADX) forward test armed — live TradingView feed, shadow-record only, places nothing');
}

function stopAdxBreakoutMonitor() {
  if (cadxMonitor) { clearInterval(cadxMonitor); cadxMonitor = null; }
}

// ── THE HIGHER-TIMEFRAME GATE — above every playbook ──────────────────────
// Anoop, 2026-09-03: "The structure HH-HL/LL-LH is read in one hour — change
// it to 15 mins which should agree with 1hr not 4hr. As i am intra day trader
// and need better reading of smaller time frames... i will check 4hr and daily
// candle manually."
//
// So the deciding timeframe is 15M and the 1H is evidence. The 4H is no longer
// read here at all. htf-alignment.js's header carries the measured numbers
// behind both halves of that (why 15M, and why the 1H reports rather than
// vetoes).
//
// Read ONCE and shared by B and C-ADX as a gate, and by every Playbook A
// engulf watcher as EVIDENCE (A stopped being gated on 2026-09-03 — see
// checkEngulfingSignal). Computing it per playbook is what let four setups
// hold four different opinions of the trend in the same minute.
//
// Cached for a minute. Both timeframes come from getFullBars, which serves
// from barCache and only reaches TradingView when the bar period has rolled,
// so this adds no meaningful load to the single CDP connection even though
// every watcher now calls it. The 15M entry is one the engulf-15m watcher
// already keeps warm, so in practice this reads from a cache that another
// watcher paid for.
const HTF_CACHE_MS = 60 * 1000;
let htfCache = { at: 0, value: null };
// The close time of the newest 15M bar the last read was actually based on.
// Kept separately from the verdict because the hourly evidence line has to be
// able to say WHICH candle produced the bias — a status that reports only the
// side is unfalsifiable, and an unfalsifiable status is not evidence.
let htfLastBarMs = null;
// G7: per-(playbook,tf,direction) last blocked bar time, so an HTF block is
// ledgered once per bar instead of once per 60s tick. The gate result is still
// returned every tick so watcher rows keep refreshing.
const htfBlockedBarTimes = {};

async function readHTFNow() {
  if (htfCache.value && Date.now() - htfCache.at < HTF_CACHE_MS) return htfCache.value;
  let bars15m = [], bars1h = [];
  // 40 bars on both: measured, the 15M structure reads cleanly 71.3% of the
  // time at 40 and only 59.2% at 24. Asking for less would close the gate for
  // want of window rather than for want of a trend.
  try { bars15m = (await getFullBars('15', 40)) || []; } catch (e) { bars15m = []; }
  try { bars1h = (await getFullBars('60', 40)) || []; } catch (e) { bars1h = []; }
  // The forming bar is excluded on BOTH timeframes. A structure read that
  // includes a half-built candle changes its mind several times inside one
  // bar, which is the same repaint the engulf watchers already guard against.
  const closed15m = playbookC.dropFormingBar(bars15m, '15');
  const closed1h = playbookC.dropFormingBar(bars1h, '60');
  const res = htfAlignment.readHTF(closed15m, closed1h);
  // Stamped from the bar itself, never from the wall clock: if the feed stalls,
  // the READ keeps happening on schedule and only the bar time stops moving.
  // Recording Date.now() here would make a dead feed look permanently fresh.
  const newest = closed15m.length ? closed15m[closed15m.length - 1] : null;
  const t = newest ? (newest.time != null ? newest.time : newest.t) : null;
  // G16: only advance on a SUCCESSFUL read. A failed read must not null the last known good bar time.
      if (t != null) htfLastBarMs = (t > 1e12 ? t : t * 1000);
  // G15: lastBarMs travels on the read so htfGate can price staleness. G20:
  // bars15mUsed/bars1hUsed travel too so the evidence line can name degradation.
  const withBar = Object.assign({}, res, { lastBarMs: htfLastBarMs, bars15mUsed: closed15m.length, bars1hUsed: closed1h.length });
  htfCache = { at: Date.now(), value: withBar };
  return withBar;
}

// ── The hourly HTF evidence (2026-09-02) ──────────────────────────────────
// Anoop: "i want to know in the APP UI which side bullish or bearish the
// watchers are looking at as per 1hr and 4hr and should let me know in the chat
// as evidence every hour so that i know they are active and i can confirm if
// they are doing their work accurately."
//
// `toChat` separates the two surfaces deliberately. The UI chip is refreshed
// often and silently; the CHAT line is the hourly one he is meant to read, and
// posting one on every refresh would train him to scroll past the thing whose
// only job is to be noticed.
async function publishHtfStatus(trigger, toChat) {
  let read = null;
  try { read = await readHTFNow(); } catch (e) { read = null; }
  const status = htfStatus.buildStatus({
    htf: read,
    watchers: Object.keys(ENGULF_TFS).map(function (k) {
      // G17: a watcher whose chart feed is down must not report "armed" — the
      // hourly line and the Chart Watchers panel can never disagree about coverage.
      return { label: ENGULF_TFS[k].label, running: !!(engulfMonitors[k] && engulfMonitors[k].running && mcpBridge.ready && mcpBridge.tvConnected) };
    }),
    lastBarMs: htfLastBarMs,
    nowMs: Date.now(),
      tvConnected: !!(mcpBridge.ready && mcpBridge.tvConnected),
  });
  broadcast(Object.assign({ type: 'htf-status', trigger: trigger, toChat: !!toChat }, status));
  if (toChat) console.log('[htf] ' + status.evidence);
  // A stale read or a downed watcher is worth a push even when he is not at the
  // screen — those are the two states where the app is silently not covering
  // him, which is exactly when silence is most misleading.
  if (toChat && (status.stale || status.armedCount < status.totalCount)) {
    try { telegramBot.notify('⚠️ ' + status.evidence); } catch (e) {}
  }
  return status;
}

// G4: per-playbook policy for an UNCLEAR 15M read. 'refuse' is the default and
// the only value Playbook A and B may ever resolve to (rules.json sets them so);
// C-ADX is shadow-only and may opt to 'refuse-unless-1h-clean'. Absent block ->
// 'refuse' (byte-identical to today).
function htfUnclearPolicyFor(playbook) {
  try {
    const rules = getActiveRules();
    const p = rules && rules.playbooks && rules.playbooks.htf && rules.playbooks.htf.unclearPolicy;
    if (p) return p[playbook] || p._default || 'refuse';
  } catch (e) {}
  return 'refuse';
}

// Gate one setup. Returns the check result; the caller logs and returns on a
// refusal. Rejections are LEDGERED, not swallowed — how often the gate blocks
// each playbook is the measurement that says whether it is set correctly, and
// a filter nobody can audit is a filter nobody trusts.
async function htfGate(playbook, tfCode, direction) {
  const read = await readHTFNow();
  const gate = htfAlignment.checkSetup(read, direction, htfUnclearPolicyFor(playbook));
  // G15: a read of unbounded age must not open or close the gate. A stale read
  // is a DISTINCT refusal reason, and age/staleness ride every ledgered row.
  const _lastBar = read && Number.isFinite(read.lastBarMs) ? read.lastBarMs : null;
  const _ageMin = _lastBar != null ? Math.max(0, (Date.now() - _lastBar) / 60000) : null;
  const _htfStale = _ageMin != null && _ageMin > htfStatus.STALE_AFTER_MINUTES;
  if (_htfStale) { gate.allowed = false; gate.reason = 'htf-stale'; }
  if (!gate.allowed) {
    // `structure` stays the DECIDING timeframe's read, as it always has — it
    // was the 1H before 2026-09-03 and is the 15M after. Rows carry
    // structure15m/structure1h explicitly alongside it so a reader of the
    // ledger never has to date a row to know which chart produced the verdict.
      // G7: one ledger row + one broadcast per blocked BAR, not per tick.
      const blockKey = String(playbook) + '|' + String(tfCode) + '|' + String(direction || '').toUpperCase();
      const blockBar = htfLastBarMs || null;
      const alreadyLogged = htfBlockedBarTimes[blockKey] === blockBar;
        let rejectSetupId = null;
      if (!alreadyLogged) {
        htfBlockedBarTimes[blockKey] = blockBar;
        rejectSetupId = playbookSpec.setupId(playbook, { direction, barTime: blockBar, entryRef: null });
      } else {
        return gate;
      }

    ledgerSignal({
      event: 'htf-reject', playbook, tf: tfCode, direction, valid: false,
      setupId: rejectSetupId, rejectReason: gate.reason, structure: gate.structure15m,
      structure15m: gate.structure15m, structure1h: gate.structure1h,
      htfBias: gate.bias,
      htfAgeMinutes: _ageMin != null ? Math.round(_ageMin) : null,
      htfStale: _htfStale,
      bars15mUsed: read && read.bars15mUsed != null ? read.bars15mUsed : null,
      bars1hUsed: read && read.bars1hUsed != null ? read.bars1hUsed : null,
    });
    console.log('HTF GATE [' + playbook + ' ' + tfCode + ']: ' + htfAlignment.explain(gate));
    broadcast({
      type: 'htf-reject', playbook, tf: tfCode, direction,
      reason: gate.reason, text: htfAlignment.explain(gate),
      structure15m: gate.structure15m, structure1h: gate.structure1h, bias: gate.bias,
    });
  }
  return gate;
}

function armSetup(fields) {
  const now = Date.now();
  // 2026-08-26: every armed setup is also recorded as the order the machine
  // WOULD have sent, at each configured shadow size. armSetup is the single
  // choke point all confirmed setups pass through, so hooking here cannot
  // miss a playbook the way hooking each monitor separately would.
  let plan = null;
  try {
    plan = playbookSpec.planEntry(
      fields.playbook === 'C' ? 'A' : fields.playbook,   // 2026-09-01: engulfs are all Playbook A
      { direction: fields.direction, gapLow: fields.gapLow, gapHigh: fields.gapHigh, level: fields.level, wick: fields.wick,
        bar: fields.bar, barTime: fields.barTime, entryRef: fields.entryRef },
      getActiveRules()
    );
    // setupId derived here when the caller did not supply one: falling back
    // to the entry price (as the first production rows did) means two
    // different setups that happen to share an entry collide into one id.
    const sid = fields.setupId || playbookSpec.setupId(
      fields.playbook === 'C' ? 'A' : fields.playbook,   // 2026-09-01: engulfs are all Playbook A
      { direction: fields.direction, gapLow: fields.gapLow, gapHigh: fields.gapHigh,
        level: fields.level, barTime: fields.barTime, entryRef: fields.entryRef });
    const why = shadowConfirmReasons(fields, plan);
    // G11: an under-minRiskPoints Playbook B setup is REFUSED and surfaced as its
    // own ledger event — never silently swallowed by the shadow-order early-return.
    if (plan && plan.plannable === false && plan.riskTooSmall) {
      ledgerSignal({
        event: 'playbook-b-risk-too-small',
        playbook: fields.playbook, tf: fields.tfCode, direction: fields.direction,
        setupId: sid, riskPoints: plan.riskPoints, reason: plan.reason,
      });
    }
    shadowRecordMachineOrder(plan, { playbook: fields.playbook, tf: fields.tfCode, setupId: sid, why });
    // Push the ticket into the app chat — Anoop's request: direction, stop and
    // target in BOTH dollars and ticks, plus why it was confirmed. A signal
    // that only names a candle makes him re-derive the trade every time.
    // 2026-08-29: NOT pushed while the active mode is silent. SHADOW runs at
    // the same time as Anoop trading his own account, and these tickets in the
    // chat are precisely what made a live session confusing enough on
    // 2026-08-26 that he switched the whole feature off ("it has created
    // confusion when i was trading live"). The record is still written either
    // way — silence suppresses the NOTIFICATION, never the data.
    if (shadowActive() && plan.plannable && !autonomySilent()) {
      const sizes = autonomyModes.sizesFor(getActiveRules(), currentAutonomyMode());
      broadcast({
        type: 'shadow-ticket',
        playbook: fields.playbook, tfLabel: fields.tfLabel || fields.tfCode,
        direction: plan.direction, entry: plan.entry, stop: plan.stop, target: plan.target,
        riskPoints: plan.riskPoints, rMultiple: plan.targetR, stopSource: plan.stopSource,
        why,
        sizes: sizes.map((c) => {
          const sd = shadowRecorder.riskUnits(plan.riskPoints, 0.25, 2, c);
          const td = shadowRecorder.riskUnits(Math.abs(plan.target - plan.entry), 0.25, 2, c);
          // The cap for the ACTIVE MODE, not the global one — otherwise a
          // ticket shown in CONTROL would read "fine" at $250 while the mode
          // that has to place it refuses anything over $200.
          const maxUsd = autonomyModes.riskCapUsd(getActiveRules(), currentAutonomyMode());
          return { contracts: c, stop: sd, target: td, blocked: (sd && maxUsd && sd.usd > maxUsd) ? `over the $${maxUsd} per-trade limit` : null };
        }),
        time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
      });
    }
  } catch (e) { /* recording must never break the live alert */ }
  armedSetup = {
    signalTs: now,
    playbook: fields.playbook,
    tfCode: fields.tfCode,
    tfLabel: fields.tfLabel || fields.tfCode,
    direction: fields.direction,
    // 2026-09-03: carried through so the chime's chat line can name the price.
    // Without it "SETUP ARMED — Playbook C-ADX · 1H · BULLISH" tells him a
    // setup exists but not where, which means opening the app to find out —
    // the exact step the sound was added to remove.
    entryRef: fields.entryRef != null ? fields.entryRef : null,
    level: fields.level != null ? fields.level : null,
    gapLow: fields.gapLow != null ? fields.gapLow : null,
    gapHigh: fields.gapHigh != null ? fields.gapHigh : null,
    message: fields.message || '',
    // 2026-09-04 live take-profit wiring: carry the plan's entry/stop/target so
    // the live monitor can announce "target hit" without re-deriving the plan.
    entry: plan ? plan.entry : null,
    stop: plan ? plan.stop : null,
    target: plan ? plan.target : null,
    targetR: plan ? plan.targetR : null,
    size: (plan && plan.plannable) ? autonomyModes.sizesFor(getActiveRules(), currentAutonomyMode()) : [],
    outsideEdge: edgeWindow.edgeWindowVerdict({ istMinutes: Math.floor((Date.now() + 5.5 * 3600000) % 86400000 / 60000), window: (getActiveRules().edgeWindow || {}) }).outsideEdge,
    expiresAt: now + ARMED_SETUP_EXPIRY_CANDLES * tfSecondsFor(fields.tfCode) * 1000,
  };
  broadcastArmedSetup();
  // 3.4 Telegram parity: push the setup STATE (playbook, direction, TF,
  // level/gap, expiry) — not just the raw candle event. Rejections, readiness
  // nags and watcher-liveness warnings are deliberately never pushed.
  try {
    const detail = [
      fields.direction || '',
      fields.tfLabel || fields.tfCode || '',
      fields.level != null ? 'level ' + fields.level : '',
      fields.gapLow != null ? 'gap ' + fields.gapLow + '-' + fields.gapHigh : ''
    ].filter(Boolean).join(' · ');
    telegramBot.notify(`📡 SETUP ARMED — Playbook ${fields.playbook} ${detail} · expires in ${ARMED_SETUP_EXPIRY_CANDLES} candles of ${fields.tfCode}`);
  } catch (e) { /* telegram is best-effort */ }
}

function readArmedSetup() {
  if (!armedSetup) return null;
  if (Date.now() > armedSetup.expiresAt) {
    const expired = armedSetup;
    armedSetup = null;
    ledgerSignal({ event: 'signal-expired', playbook: expired.playbook, tf: expired.tfCode, direction: expired.direction, decision: 'ignored', signalTs: expired.signalTs });
    return null;
  }
  return armedSetup;
}

function clearArmedSetup() { armedSetup = null; }

// ── Live take-profit monitor (2026-09-04) ─────────────────────────────────
// While a setup is armed WITH a target, watch the live price and announce the
// moment it is reached. This is the missing half of the rulebook's exit: the
// entry side was detected plentifully, the exit ("exit at marker levels") was
// hand-drawn and unreadable to code. Now the target is a number the app holds,
// and this loop turns it into a real-time "TAKE PROFIT" line.
//
// Price source is quote_get (the current chart symbol) — the same fidelity the
// Jessi TV monitor and the scalper use. Shared limitation: if the chart has
// switched to the other instrument, the quote is of that instrument. The setup
// expires in a handful of candles so the window is small, and the ledger still
// records what fired. A symbol-verified read is the follow-up, not the first cut.
function checkLiveTakeProfit() {
  const setup = readArmedSetup();
  if (!setup || (setup.target == null && setup.stop == null)) return;
  mcpBridge.callTool('quote_get', {}).then((q) => {
    const price = Number(q && q.lastPrice);
    // Stop side first — a hit stop is the urgent, protective event (T3.2).
    if (setup.stop != null && takeProfitSignal.hitStop(setup, price)) {
      if (!autonomySilent()) {
        broadcast({
          type: 'stop-hit',
          playbook: setup.playbook,
          tfLabel: setup.tfLabel,
          direction: setup.direction,
          stop: setup.stop,
          price,
          message: 'STOP HIT — stop ' + setup.stop + ' touched at ' + price,
        });
      }
      ledgerSignal({ event: 'stop-hit', playbook: setup.playbook, tf: setup.tfCode, direction: setup.direction, stop: setup.stop, price, signalTs: setup.signalTs });
      clearArmedSetup();
      return;
    }
    if (setup.target == null || !takeProfitSignal.hitTarget(setup, price)) return;
    if (!autonomySilent()) {
      broadcast({
        type: 'take-profit',
        playbook: setup.playbook,
        tfLabel: setup.tfLabel,
        direction: setup.direction,
        target: setup.target,
        price,
        message: 'TAKE PROFIT — target ' + setup.target + ' hit at ' + price,
      });
    }
    ledgerSignal({ event: 'take-profit-hit', playbook: setup.playbook, tf: setup.tfCode, direction: setup.direction, target: setup.target, price, signalTs: setup.signalTs });
    clearArmedSetup();
  }).catch(() => { /* quote read is best-effort; next tick retries */ });
}
setInterval(checkLiveTakeProfit, 30 * 1000);

function broadcastArmedSetup() {
  const setup = readArmedSetup();
  broadcast({ type: 'armed-setup', setup });
}

// 3.1: the shared market-state line. Injected into the agent context block
// read by Jessi, the Judge, the Scalper and the Post-Session Analyst. NOT
// injected into gatherAnalysisContext/gatherPO3Context — decision 3 keeps the
// Analysis and PO3 debate agents denied live setup/account state.
function formatMarketStateLine() {
  const setup = readArmedSetup();
  const hourTrend = (po3TrendCache['60'] && po3TrendCache['60'].value) || null;
  const istMin = Math.floor((Date.now() + 5.5 * 3600000) % 86400000 / 60000);
  const windows = (getActiveRules().sessionWindowsIST || []).map(w => ({ startMin: w.startMin, name: w.name || null }));
  return marketState.marketStateLine(setup, {
    nowMs: Date.now(),
    hourTrendLabel: hourTrend ? hourTrend.label : null,
    hourTrendDirection: hourTrend ? hourTrend.direction : null,
    sessionTier: signalLedger.sessionTierForMinutes(istMin, windows),
  });
}

// 2.3: Took it / Passed — one click, no form, no note field. Writes the
// decision back into the day's ledger and clears the armed slot.
function handleSignalDecision(ws, msg) {
  const setup = readArmedSetup();
  const decision = String((msg && msg.decision) || '').toLowerCase();
  if (decision !== 'took' && decision !== 'passed') {
    send(ws, { type: 'signal-decision-result', ok: false, error: "decision must be 'took' or 'passed'" });
    return;
  }
  if (!setup || (msg && msg.signalTs && Number(msg.signalTs) !== setup.signalTs)) {
    send(ws, { type: 'signal-decision-result', ok: false, error: 'no live setup to decide (expired or already decided)' });
    return;
  }
  const decidedAt = new Date().toISOString();
  ledgerSignal({ event: 'signal-decision', playbook: setup.playbook, tf: setup.tfCode, direction: setup.direction, decision, decidedAt, signalTs: setup.signalTs });
  clearArmedSetup();
  broadcast({ type: 'armed-setup', setup: null });
  send(ws, { type: 'signal-decision-result', ok: true, decision, signalTs: setup.signalTs });
  console.log(`[signal-decision] ${decision.toUpperCase()} on ${setup.playbook} ${setup.tfLabel} ${setup.direction}`);
}

// 4.3: the live feed writes the day record. On each closed round trip the
// joined 4.1 record becomes a row in the SAME shape csvApply writes
// ({t,x,size,pnl,g,flags,side,ep,xp,mp,hold} + provenance fields), merged by
// the SAME fingerprint, re-graded and rolled up by the SAME day-rollup
// functions, and persisted through the SAME dataSave disk mirrors. The
// renderer syncs its localStorage copy from the broadcast so the UI and a
// later CSV reconciliation see the same rows. Idempotent: the fingerprint
// merge makes a duplicate fire a no-op for the row; rollup recomputes from
// the merged day every time. Trading-day anchor: dayRollup.tradingDayKey
// (03:45 IST rollover) — never calendar/UTC.

// F1 live-write helper (X6 arm): measure one closed trade from the 1m archive.
// Returns the fields to merge, or { forensicsReason } when it cannot — never
// zero, never a fabricated number. The winner invariant gates a write: a row
// whose booked P&L exceeds its best excursion is refused with the reason.
function computeLiveForensics(row, symbol) {
  const s = String(symbol || '').toUpperCase();
  const root = s.includes('MNQ') ? 'MNQ' : (s.includes('MGC') || s.includes('GC') ? 'MGC' : null);
  if (!root) return { forensicsReason: 'unknown symbol (' + String(symbol || '?') + ')' };
  const t = Number(row.t), x = Number(row.x);
  if (!Number.isFinite(t) || !Number.isFinite(x) || row.ep == null) return { forensicsReason: 'missing entry/exit timestamps or entry price' };
  let bars = [];
  try { bars = barArchive.readArchive(path.join(DATA_DIR, 'bars', 'archive'), root, '1', t, x + 30 * 60 * 1000); } catch (e) { /* fall through to 'no bars' */ }
  if (!bars.length) return { forensicsReason: 'no bars cover the trade window' };
  const fr = tradeForensics.tradeForensics(Object.assign({}, row, { symbol: s, entryAt: t, exitAt: x }), bars, { tf: '1' });
  if (fr.mae == null && fr.mfe == null) return { forensicsReason: fr.forensicsReason || 'no coverage' };
  const inv = tradeForensics.assertWinnerInvariant(row, fr, fr.pointValue);
  if (inv.valid === false) return { forensicsReason: 'winner invariant violated: ' + inv.reason };
  const post = tradeForensics.postExitMove({ side: row.side, xp: row.xp, exitAt: x }, bars);
  const out = {
    mae: fr.mae, mfe: fr.mfe, maeUsd: fr.maeUsd, mfeUsd: fr.mfeUsd,
    edgeRatio: fr.edgeRatio, forensicsTf: fr.forensicsTf,
    entryAt: t, exitAt: x,
    post30Mfe: post.post30Mfe, post30Mae: post.post30Mae, post30Close: post.post30Close, post30LeftOnTable: post.post30LeftOnTable,
  };
  if (post.post30Reason) out.post30Reason = post.post30Reason;
  return out;
}

// G25 FIX (2026-09-09): the reconciliation check below runs on EVERY re-roll of
// the day record — i.e. once per live trade write, and again on every replay of
// the same day. A day that is genuinely out of reconciliation is out of it
// PERMANENTLY until a CSV corrects it, so an unguarded broadcast repeats the
// identical "SELF-REPAIR — daily-reconcile" line forever and buries the chat.
// Anoop saw eleven of them stacked in one session.
//
// Same discipline as G7's per-bar dedup: keep announcing a CHANGE, never a
// steady state. The key is the slot+day, the value is a signature of the
// numbers — so a disagreement that MOVES (a new trade lands, the gap widens)
// still speaks up, while a gap that just sits there says it once.
const _reconAnnounced = {};

function writeLiveTradeToDayRecord(record) {
  try {
    if (!record || record.pnlUnknown) return 'skipped: pnlUnknown';
    if (!(Number.isFinite(record.pnl) && record.at != null)) return 'skipped: unscoreable';
    // G24: a phantom is a property of the ROW — no size, or no entry/exit price.
    // A real round trip has all three; a row missing one is unverifiable and must
    // not reach day_trades. The counter derives from the rows rejected here, so it
    // can never disagree with the number of phantoms actually on disk.
    if (!(record.size > 0) || record.entryPrice == null || record.exitPrice == null) {
      try { if (tvBrokerFeedState) tvBrokerFeedState.phantomFlats = (tvBrokerFeedState.phantomFlats || 0) + 1; } catch (e) {}
      console.warn('[day-record] phantom row rejected (no size/prices): ' + JSON.stringify({ size: record.size, entryPrice: record.entryPrice, exitPrice: record.exitPrice, pnl: record.pnl }));
      return 'skipped: phantom (no size or entry/exit price)';
    }
    const slot = jessiBucketKey(loadConfig());
    const dayKey = dayRollup.tradingDayKey(record.at);
    const rules = getActiveRules();
    // 5.1: join the fill back to the nearest preceding armed signal.
    // minutesFromSignal is measured — both the signal and the fill happened
    // while the app was running (see signal-join.js).
    let join = { signalBacked: false, playbook: null, minutesFromSignal: null, signalTs: null };
    try {
      const signalsFile = path.join(DATA_DIR, 'signals', dayKey + '.jsonl');
      let signals = [];
      if (fs.existsSync(signalsFile)) {
        signals = fs.readFileSync(signalsFile, 'utf8').split('\n')
          .filter(l => l.trim())
          .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
          .filter(Boolean);
      }
      join = signalJoin.joinTradeToSignal(record, signals, { windowMinutes: rules.signalJoinWindowMinutes });
    } catch (e) {
      console.warn('[signal-join] failed:', e.message);
    }
    // 2026-08-26: record HIS trade with its context, winner or loser. The
    // losers are not optional — a feature only predicts if it SEPARATES the
    // two groups, so "duplicate the good trades" needs the bad ones as the
    // control. See shadow-recorder.js.

    const sizeCapCsv = typeof rules.sizeCap === 'number' ? rules.sizeCap : 2;
    // 4.3 AUDIT FIX: rollupDay's commPerCt is a ROUND-TURN rate — its net is
    // `gross - contracts * commPerCt`, with one `contracts` unit per closed
    // trade, no doubling anywhere (compare expectedPnlFromFills, which spells
    // the two sides out as `rate * size * 2`). rules.json's figure is
    // per-SIDE, so feeding it in raw charged half the commission and
    // overstated every live-written day's net by ~$0.59 a contract. The
    // fallback stays the old 1.0 round-turn approximation, not 0.59.
    const commPerCt = rules.commissionPerContractPerSide != null ? Number(rules.commissionPerContractPerSide) * 2 : 1.0;
    const gradeOpts = {
      tradingMode: rules.tradingMode || 'standard',
      cooldownAfterLossOnly: rules.cooldownAfterLossOnly,
      maxHoldSeconds: rules.maxHoldSeconds,
      sessionWindowsIST: rules.sessionWindowsIST,
      sizeCapCsv,
    };
    // 2026-08-25: normalize FIRST, then take the sign. This read the broker's
    // raw 'sell' only, so a record speaking the row vocabulary ('SHORT' — what
    // the live walk-join now produces, and what every stored row already says)
    // fell through to +1 and had its points recorded with the sign flipped:
    // a winning short would be journalled as a loss of the same size. Same
    // two-vocabulary hazard normalizeSide was written for, one layer up.
    const normSide = dayRollup.normalizeSide(record.side);
    const dirSign = normSide === 'SHORT' ? -1 : 1;
    const row = {
      t: record.entryAt != null ? record.entryAt : record.at,
      x: record.exitAt != null ? record.exitAt : record.at,
      size: record.size,
      pnl: record.pnl,
      // 4.3 AUDIT FIX: LONG/SHORT, not the broker's raw buy/sell — see
      // dayRollup.normalizeSide for what BUY/SELL in this field broke.
      side: normSide,
      ep: record.entryPrice != null ? record.entryPrice : null,
      xp: record.exitPrice != null ? record.exitPrice : null,
      mp: (record.entryPrice != null && record.exitPrice != null)
        ? Math.round(dirSign * (record.exitPrice - record.entryPrice) * 100) / 100
        : null,
      hold: (record.exitAt != null && record.entryAt != null)
        ? Math.max(0, Math.round((record.exitAt - record.entryAt) / 1000))
        : 0,
      evidence: record.evidence || null,
      source: record.source || null,
      // 2026-08-26: say what this pnl IS. The fold's number is a balance
      // delta between two flats, so the broker's commission is already out of
      // it — unlike a CSV row, which is gross. Without this the day rollup
      // subtracted commission a second time on every live-written day.
      pnlBasis: 'net',
      // 5.1: signal-backed stamping — the 5.2 scorecard's primary input.
      signalBacked: join.signalBacked,
      playbook: join.playbook,
      minutesFromSignal: join.minutesFromSignal,
      g: null, flags: null, // graded below through the shared day-rollup
    };
    // 2026-08-26: record HIS trade with its context, winner or loser. The
    // losers are not optional — a feature only predicts if it SEPARATES the
    // two groups, so "duplicate the good trades" needs the bad ones as the
    // control. See shadow-recorder.js.
    //
    // PASSES `row`, NOT `record`, and that placement is the fix for a bug the
    // first real production trade exposed: the two speak different
    // vocabularies. `record` has entryPrice/exitPrice/entryAt and a RAW side;
    // `row` has ep/xp/hold and a NORMALIZED LONG/SHORT. Hooked on `record`,
    // every one of those fields came back null — the first captured trade had
    // no side, no entry, no exit and no hold, which silently disabled three of
    // the eleven discriminator features. Hooking after the row is built also
    // means the shadow copy and the day record can never disagree.
    const dtStore = dataLoad('day_trades__' + slot) || {};
    shadowRecordHumanTrade(
      Object.assign({}, row, { at: record.at, entryAt: row.t }),
      join, dayKey, Array.isArray(dtStore[dayKey]) ? dtStore[dayKey] : []);
    // 2026-08-28: identity is the FLAT EVENT (entry, exit, size) — never the
    // P&L. The old fingerprint `t|x|pnl-cents|size` put a VALUE in the key, and
    // P&L is exactly what the two routes disagree on: the walk reports GROSS at
    // the real fill stamps, the fold reports NET minutes later. Same trade, two
    // fingerprints, two rows — which is how one trade on 2026-08-28 became
    // three. mergeTradeRow matches on the event and MERGES, keeping the walk's
    // prices and a single net figure.
    const existingRows = Array.isArray(dtStore[dayKey]) ? dtStore[dayKey] : [];
    const mergeRes = tvBrokerFeed.mergeTradeRow(existingRows, row, {
      commissionPerContractPerSide: rules.commissionPerContractPerSide,
      pointValue: requireContractSpec(record.symbol || record.Symbol || chartSymbolCache.symbol).pointValue,
    });
    if (mergeRes.action === 'merged') {
      console.log('[day-record] merged into an existing row for the same trade (no duplicate written)');
    }
    const fp = r => r.t + '|' + r.x + '|' + r.size;
    const mergedMap = new Map();
    mergeRes.rows.forEach(r => mergedMap.set(fp(r), r));
    const pre = Array.from(mergedMap.values()).map(r => ({
      entryMs: r.t, exitMs: r.x, entryMin: null, holdSec: r.hold, size: r.size, pnl: r.pnl,
      side: r.side, ep: r.ep, xp: r.xp, mp: r.mp,
    }));
    const graded = dayRollup.gradeTrades(pre, gradeOpts);
    const dayRows = graded.map(g => {
      const base = mergedMap.get(fp({ t: g.entryMs, x: g.exitMs, size: g.size })) || {};
      return {
        t: g.entryMs, x: g.exitMs, size: g.size, pnl: g.pnl, g: g.g, flags: g.flags,
        side: g.side || null, ep: g.ep != null ? g.ep : null, xp: g.xp != null ? g.xp : null,
        mp: g.mp != null ? g.mp : null, hold: g.holdSec,
        evidence: base.evidence || null,
        source: base.source || null,
        pnlBasis: base.pnlBasis || null,
        // 5.1: the signal join survives the re-grade (the 5.2 scorecard input).
        signalBacked: base.signalBacked === true,
        playbook: base.playbook || null,
        minutesFromSignal: base.minutesFromSignal != null ? base.minutesFromSignal : null,
      };
    });
    // F1 live-write (X6 arm): measure each closed trade from the 1m archive and
    // attach MAE/MFE + post-exit, gated by the winner invariant. Best-effort and
    // self-contained — a forensics failure must never block the trade record.
    // The 1m archive lags the close by up to one poll (X5a, ~3 min), so a trade
    // closed moments ago may read 'no bars' here and fill on a later re-write or
    // the backfill; that is the honest state, never a fabricated number.
    try {
      // record.symbol is authoritative (order-walk); fall back to the cached
      // chart symbol for fold-only records on a single-instrument day.
      const sym = record.symbol || (chartSymbolCache && chartSymbolCache.symbol) || null;
      for (const dr of dayRows) {
        if (dr.mae != null || dr.mfe != null) continue;
        const fx = computeLiveForensics(dr, sym);
        if (fx) Object.assign(dr, fx);
      }
    } catch (e) { console.warn('[forensics] live write failed (trade record kept):', e.message); }
    const sum = dayRollup.rollupDay(dayKey, dayRows, { commPerCt, sizeCapCsv, tradingMode: gradeOpts.tradingMode });
    dtStore[dayKey] = dayRows;
    const keys = Object.keys(dtStore).sort();
    while (keys.length > 90) { delete dtStore[keys.shift()]; }
    let hist = dataLoad('gr_history__' + slot) || [];
    hist = hist.filter(e => e.date !== dayKey);
    hist.push(sum);
    hist.sort((a, b) => (a.date < b.date ? -1 : 1));
    const ledgerEntry = { gross: sum.gross, net: sum.pnl, contracts: sum.contracts };
    let ledger = dataLoad('balance_ledger__' + slot) || {};
    ledger[dayKey] = ledgerEntry;
    dataSave('day_trades__' + slot, dtStore);
    dataSave('gr_history__' + slot, hist.slice(-60));
    dataSave('balance_ledger__' + slot, ledger);
    // 5.1: write the join into the day's signal ledger as it happens.
    if (join.signalBacked) {
      ledgerSignal({ event: 'signal-join', playbook: join.playbook, direction: row.side === 'LONG' ? 'BULLISH' : (row.side === 'SHORT' ? 'BEARISH' : null), signalTs: join.signalTs });
    }
    broadcast({ type: 'day-record-updated', slot, date: dayKey, rows: dayRows, sum, ledgerEntry });
    console.log(`[day-record] live trade → ${dayKey}: ${row.size} ${row.side || '?'} pnl ${row.pnl} (evidence ${row.evidence || 'fold'}) → day net ${sum.pnl}`);
    // G25: reconcile the feed against the stored day on every re-roll (a proxy for
    // the rollover). Reports a disagreement, never rewrites — a broker CSV through
    // csvApply stays the only authoritative correction. Report-only, never blocks.
    try {
      const _feed = tvBrokerFeedState || {};
      const _dayTradesSum = Math.round(dayRows.reduce((a, t) => a + (Number(t.pnl) || 0), 0) * 100) / 100;
      const _rec = feedProtocol.dailyReconciliationCheck({
        dayPnl: _feed.dayPnl,
        dayTradesSum: _dayTradesSum,
        grHistoryPnl: sum.pnl,
        tradeCount: _feed.tradeCount,
        tradesLength: Array.isArray(_feed.trades) ? _feed.trades.length : null,
        phantomFlats: _feed.phantomFlats || 0,
        threshold: rules.dailyReconcileToleranceUsd != null ? Number(rules.dailyReconcileToleranceUsd) : undefined,
      });
      // Announce a CHANGE, not a steady state — see _reconAnnounced above.
      const _recKey = String(slot) + '|' + String(dayKey);
      const _recSig = _rec.verdict === 'fail'
        ? [Math.round((_feed.dayPnl || 0) * 100), Math.round(_dayTradesSum * 100),
           Math.round((sum.pnl || 0) * 100), _feed.tradeCount,
           Array.isArray(_feed.trades) ? _feed.trades.length : -1].join(':')
        : 'ok';
      if (_rec.verdict === 'fail') {
        if (_reconAnnounced[_recKey] !== _recSig) {
          _reconAnnounced[_recKey] = _recSig;
          console.warn('[day-record] reconciliation FAILED: ' + _rec.impact);
          broadcast({ type: 'self-repair', kind: 'daily-reconcile', evidence: _rec.evidence, impact: _rec.impact });
        }
      } else if (_reconAnnounced[_recKey] && _reconAnnounced[_recKey] !== 'ok') {
        // It came back into agreement — worth exactly one line, then silence.
        _reconAnnounced[_recKey] = 'ok';
        console.log('[day-record] reconciliation RECOVERED for ' + _recKey);
      }
    } catch (e) { /* reconciliation is report-only; never block the trade record */ }
    // 2026-09-03: the pattern ledger is derived from the records this function
    // just wrote, so this is the earliest moment the episode exists. Both the
    // per-trade flags and the freshly re-rolled day (gr_history above) are on
    // disk by now, which is why the hook is here and not at the broadcast that
    // announces the close — that one fires before the day is re-rolled, and the
    // day-level shapes (size-up-into-loss, overtrading, giveback) would be a
    // poll behind. Wrapped: a coaching failure must never cost the trade record.
    try { patternMemoryTick(); } catch (e) { console.error('[pattern-memory] tick failed:', e.message); }
    return 'written';
  } catch (e) {
    console.error('[day-record] live write failed:', e.message);
    return 'failed: ' + e.message;
  }
}

// 1.4: liveness watchdog — a running watcher that hasn't completed a check
// within 3× its own interval gets ONE automatic restart, then red. Skipped
// while TradingView is down (nothing can be stale then; reconnect re-arms
// everything via armMonitorsStaggered).
let watcherLivenessInterval = null;
function startWatcherLivenessWatch() {
  if (watcherLivenessInterval) return;
  const tick = () => {
    if (!mcpBridge.ready || !mcpBridge.tvConnected) return;
    let changed = false;
    for (const e of ALL_MONITORS) {
      const mon = e.mon();
      if (!mon.running) continue;
      const last = mon.lastCheck ? new Date(mon.lastCheck).getTime() : 0;
      const stale = Date.now() - last > 3 * e.intervalMs;
      if (!stale) {
        if (mon.restartAttempted || mon.livenessRed) {
          mon.restartAttempted = false;
          mon.livenessRed = false;
          changed = true;
          console.log(`[watcher-liveness] ${e.id} recovered — fresh check observed`);
        }
        continue;
      }
      if (!mon.restartAttempted) {
        mon.restartAttempted = true;
        console.log(`[watcher-liveness] ${e.id} stale (no check in ~${Math.round((Date.now() - last) / 1000)}s, limit ${Math.round(3 * e.intervalMs / 1000)}s) — attempting one restart`);
        changed = true;
        try { e.run(); } catch (err) { console.error(`[watcher-liveness] ${e.id} restart failed:`, err.message); }
      } else if (!mon.livenessRed) {
        mon.livenessRed = true;
        console.log(`[watcher-liveness] ${e.id} still stale after one restart — RED`);
        changed = true;
      }
    }
    if (changed) broadcastWatchersStatus();
  };
  watcherLivenessInterval = setInterval(tick, 30 * 1000);
  setTimeout(tick, 10000); // first pass soon after boot, once monitors have had a chance to run
}

// ── TradingView KILL SWITCH (2026-09-09) ────────────────────────────────────
// Anoop, after the first cut of this (bridge-only): "i want you to close the
// tradingview app so that i do not take anymore trades after clicking on
// kill tradingview app." The point isn't disconnecting the DATA FEED — it's
// removing the chart from in front of him, on purpose, as a physical barrier
// against himself. A bridge-only kill leaves TradingView Desktop sitting open
// and chartable; that does not stop a trade someone is determined to take.
//
// So this now does TWO things, always together on Kill:
//   1. mcpBridge.stop() — same as before, so nothing polls a dying process.
//   2. Force-close TradingView.exe itself, via the SAME process name the
//      launcher's own ensure-tradingview.ps1 already targets
//      (`Get-Process TradingView | Stop-Process -Force`) — reusing a
//      precedent already trusted in this repo, not a new guess at the name.
//
// WHY THIS DOES NOT TOUCH A LIVE POSITION: Tradovate (the broker) and
// TradingView Desktop (the charting terminal) are separate applications
// talking to separate accounts. Closing the terminal cannot close a
// position — but it DOES remove his only in-app way to see or manage one.
// The confirm dialog in app.js says this explicitly and tells him to use
// Tradovate directly if he is in a trade. This is the one place in the whole
// kill-switch feature that is genuinely irreversible mid-action (a position
// he can't see is a position he can still lose money on) — the warning has
// to be read, not just present.
//
// WHY IT DOES NOT AUTO-RECONNECT: mcpBridge.stop() sets _intentionalStop=true,
// which the bridge's own exit handler already reads to skip
// _scheduleBridgeRestart() (mcp-bridge.js:88-90) — that flag exists for
// exactly this purpose, we are only now giving it a UI. A deliberate kill
// that silently un-killed itself in 10 seconds would not be a kill switch.
let tvKilledByUser = false;
let tvRestoreInFlight = false;

function broadcastTvKillStatus(extra) {
  broadcast(Object.assign({ type: 'tv-kill-status', killed: tvKilledByUser }, extra || {}));
}

// 2026-09-10 (Anoop, after confirming the kill switch worked): "track it on
// the days i use and add the details on the journal." This writes into the
// SAME per-day note object the Journal tab already renders (notes__<slot>,
// keyed by trading day — the identical store djSaveNote/'note-save' use), as
// a new `tvKillEvents` array, rather than a separate file: the Journal is
// where Anoop reads his day back, so a fact about that day belongs in the
// data structure that tab already loads, not a second store the renderer
// would need new plumbing to reach.
//
// This is a FACT LOG, not a note — the four dj-* fields next to it are his
// own words and stay freely editable; this array is server-written only, so
// nothing here can be silently edited away, matching the ledger discipline
// the rest of this app already applies to armSetup/htf-reject rows.
function logTvKillEvent(action) {
  try {
    const slot = jessiBucketKey(loadConfig());
    const dayKey = dayRollup.tradingDayKey(Date.now());
    const notes = dataLoad('notes__' + slot) || {};
    const note = notes[dayKey] || {};
    const events = Array.isArray(note.tvKillEvents) ? note.tvKillEvents : [];
    events.push({ at: new Date().toISOString(), action });
    note.tvKillEvents = events;
    notes[dayKey] = note;
    dataSave('notes__' + slot, notes);
  } catch (e) { console.warn('[tv-kill-switch] failed to log to journal:', e.message); }
}

function handleTvKill(ws) {
  tvKilledByUser = true;
  console.log('[tv-kill-switch] Killing TradingView — bridge stopped AND TradingView.exe force-closed. Will not auto-reconnect until Restore is clicked.');
  logTvKillEvent('kill');
  try { mcpBridge.stop(); } catch (e) { console.warn('[tv-kill-switch] bridge stop() threw:', e.message); }
  // mcpBridge's own 'exit' handler already broadcasts mcp-status:disconnected
  // regardless of _intentionalStop (see mcp-bridge.js) — the existing TV-dead
  // banner and dot pick that up with no extra wiring.
  broadcastTvKillStatus({ closing: true });
  // Force-close the Desktop app. Fire-and-forget on purpose: even if this
  // fails (e.g. TradingView was already closed), the bridge is already down
  // and the app-side lockout already holds — a failed OS-level kill must
  // never look like the whole feature failed.
  // execFile, not exec: no shell string to inject into, even though nothing
  // here is user input — same discipline as the rest of this function.
  const { execFile } = require('child_process');
  execFile('powershell', ['-NoProfile', '-Command',
    'Get-Process TradingView -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue'],
    (err) => {
      if (err) console.warn('[tv-kill-switch] TradingView.exe close attempt returned:', err.message);
      else console.log('[tv-kill-switch] TradingView.exe close command completed.');
      broadcastTvKillStatus({ closing: false });
    });
}

function handleTvRestore(ws) {
  if (tvRestoreInFlight) { console.log('[tv-kill-switch] Restore already in progress, ignoring duplicate click.'); return; }
  tvRestoreInFlight = true;
  tvKilledByUser = false;
  console.log('[tv-kill-switch] Restoring — relaunching TradingView with the CDP flag, then reattaching the bridge.');
  logTvKillEvent('restore');
  broadcastTvKillStatus({ restoring: true });
  broadcast({ type: 'mcp-status-msg', message: 'Relaunching TradingView…' });
  // MUST relaunch with --remote-debugging-port, exactly like the batch
  // launcher — TradingView started from the taskbar/Start menu has no CDP
  // port and mcpBridge can never attach to it (see CLAUDE.md's own warning
  // on this). Reuse the SAME script the launcher uses rather than
  // re-implementing "find TradingView.exe, kill any bad instance, relaunch
  // with the flag, poll for readiness" a second time in a different language.
  const { execFile } = require('child_process');
  const psScript = path.join(__dirname, '..', 'scripts', 'ensure-tradingview.ps1');
  execFile('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-Port', '9222', '-TimeoutSec', '90'],
    { timeout: 100000 },
    (err, stdout, stderr) => {
      tvRestoreInFlight = false;
      if (stdout) console.log('[tv-kill-switch]', stdout.trim());
      if (err) console.warn('[tv-kill-switch] ensure-tradingview.ps1 did not confirm readiness (continuing — the bridge heartbeat will keep retrying):', err.message);
      // Attempt the bridge regardless of the script's own exit code, same as
      // the batch launcher does — mcp-bridge.js's heartbeat/retry takes over
      // from here if TradingView is still booting.
      startMCP();
    });
}

// ── MCP startup ────────────────────────────────────────────────────────────────
async function startMCP() {
  try {
    broadcast({ type: 'mcp-status', connected: false, message: 'Connecting to TradingView…' });
    mcpBridge.removeAllListeners();
    mcpBridge.on('status',         (msg) => broadcast({ type: 'mcp-status-msg', message: msg }));
    // 'connected'/'disconnected' = bridge child process itself (JSON-RPC handshake).
    // 'tv-connected'/'tv-disconnected' = heartbeat-verified TradingView CDP health —
    // this is the one that reflects reality, since the bridge process can stay
    // alive for hours after TradingView desktop itself has crashed. Fixed
    // 2026-07-15: the UI's "TradingView connected" light used to only track the
    // former, so it stayed green through TV crashes that broke every level-marking
    // button. Now it tracks both — either going false flips the indicator off.
    mcpBridge.on('connected',     ()    => broadcast({ type: 'mcp-status', connected: mcpBridge.ready && mcpBridge.tvConnected }));
    mcpBridge.on('disconnected',  ()    => broadcast({ type: 'mcp-status', connected: false, message: 'TradingView bridge disconnected' }));
    mcpBridge.on('tv-connected',  ()    => {
      broadcast({ type: 'mcp-status', connected: true });
      // 2026-08-17 (Anoop: "keep a watch for me full time as long as
      // tradingview is connected"): auto-start the free, mechanical PO3
      // monitor the moment TradingView is reachable, instead of requiring
      // the P3 Monitor toggle to be flipped by hand every session. Idempotent
      // — startPo3Monitor() no-ops if already running. Skipped if Anoop
      // explicitly turned it off (po3MonitorUserDisabled) — a reconnect must
      // never override that choice.
      // 2026-08-19 (Anoop: "the live feed should ... be active always"):
      // auto-start-on-connect for the always-on watchers (PO3, engulf-1H,
      // SFP-30M — each independently idempotent and respecting its own
      // *MonitorUserDisabled flag). 0.1: armed via armMonitorsStaggered so
      // the start times don't align on one tick.
      armMonitorsStaggered();
      // 2026-08-26: keep the broker panel open for the whole session instead
      // of discovering it shut when a read fails. Idempotent.
      startPanelWatchdog();
      // 2026-08-19: re-run the self-test on every reconnect, not just once at
      // boot — a reconnect can land with the Trading Panel no longer open or
      // linked, and that's exactly the state this test exists to catch.
      // Same 15s delay as the initial run: give TradingView a moment to
      // finish rendering after the CDP handshake before probing it.
      scheduleLiveFeedSelfTest(15000);
      // PROTOCOL 2 auto-trigger. Deliberately later than the 3-check self-test:
      // the watchers need time to take a first reading before "has this watcher
      // checked recently?" can mean anything.
      scheduleFeedIntegrityProtocol(45000);
    });
    mcpBridge.on('tv-disconnected', (detail) => {
      tvBrokerFeedReadOk = null; // force a fresh readable/not-readable log line once CDP comes back, don't trust the pre-drop state
      broadcast({ type: 'mcp-status', connected: false, message: 'TradingView disconnected' + (detail ? ': ' + detail : '') });
    });
    if (mcpBridge.ready) {
      if (mcpBridge.tvConnected) armMonitorsStaggered(); // already connected before this call — 'tv-connected' won't fire again
      if (mcpBridge.tvConnected) { scheduleLiveFeedSelfTest(15000); scheduleFeedIntegrityProtocol(45000); }
      return;
    }
    await mcpBridge.start();
    if (mcpBridge.tvConnected) armMonitorsStaggered(); // covers a start() that resolves already-connected, race-safe alongside the event listener
    if (mcpBridge.tvConnected) { scheduleLiveFeedSelfTest(15000); scheduleFeedIntegrityProtocol(45000); }
  } catch (err) {
    broadcast({ type: 'mcp-status', connected: false, message: 'TradingView MCP: ' + err.message });
  }
}

// ── Startup ────────────────────────────────────────────────────────────────────
async function handleTvTest(ws, msg) {
  const r = await tradovate.testConnection(loadConfig());
  send(ws, { type: 'tradovate-test-result', ...r });
}
function startTradovate() {
  const cfg = loadConfig();
  tradovate.stop();
  if (cfg.tvEnabled && cfg.tvName) tradovate.start(cfg, snap => broadcast({ type: 'tradovate-account', ...snap }));
}

// ── TradingView-sourced live broker feed (2026-08-17) ───────────────────────
// Anoop: "can we use tradingview as live feed?" — checked live against his
// real Tradeify account (Tradovate white-label). TradingView Desktop's
// Trading Panel renders a linked broker's positions/orders/account summary
// as plain semantic <table> elements (data-name="TRADOVATE.positions-table"
// etc.), not canvas — fully readable via the existing CDP bridge, no
// Tradovate REST API credentials needed at all. See
// tradingview-mcp/src/core/trading.js for the confirmed DOM structure.
//
// 2026-08-17: live-wired into the guardrail via tv-broker-feed.js's fold() —
// balance-delta-at-flat (account balance right after a position returns to
// flat, minus balance the last time it was flat) is the only realized-P&L
// source trading.js's getAccountSummary() actually confirmed against the DOM
// (a Filled order's own row carries no realized-P&L column). See
// tv-broker-feed.js's header comment: this fold is unit-tested but the
// balance-delta math itself is STILL UNVERIFIED against a real non-zero-P&L
// closed trade — re-confirm against the next real fill before trusting the
// numbers beyond the guardrail's own use.
// 2026-08-19 BUG FIX (found live, on Anoop's own first real test trade of the
// day): tvBrokerFeedState lived ONLY in memory. A restart at any point after
// a round-trip closed but before the position it was tracking closes again
// wiped the fold's dayPnl/tradeCount/trades back to freshState() — the
// restart's first poll would find the account already flat and establish
// THAT as the baseline, having never observed the earlier not-flat→flat
// transition, so that trade became permanently invisible to the live feed.
// Confirmed exactly this: Anoop closed a round trip at 12:58:29 IST, this
// server restarted twice after that (13:06:47, 13:14:53 IST) — both times
// the HUD still read "0 trades" despite the broker's orders table showing 3
// real fills. Every other per-slot dataset (ledger, gr_history, etc.) is
// already mirrored to disk (see saveActiveBucket()'s 2026-08-18 fix in
// app.js for the same class of bug on the client side) — this was the one
// piece of live-trading state that wasn't. Persisted via dataSave/dataLoad
// (existing atomic-write pattern) to a single global file, not per-slot,
// since there is exactly one real broker account regardless of which
// virtual eval/funded slot is currently selected in the UI.
const TV_BROKER_STATE_KEY = 'tv_broker_feed_state';
function loadTVBrokerFeedState() {
  try {
    const saved = dataLoad(TV_BROKER_STATE_KEY);
    // freshState()'s own dayKeyMs check in fold() already discards a stale
    // (yesterday's) state on the first fold() call of a new day — restoring
    // it here unconditionally and letting fold() do that comparison is
    // simpler and less error-prone than duplicating the day-rollover logic.
    // 2026-08-20: refuse a state written by a fold we've since found buggy.
    // Without this, the fix to the entry-fill over-counting ships but the
    // inflated tradeCount it produced survives on disk and keeps enforcing —
    // observed live as a session stuck at "9/3 TRADES — DONE" for ~4 real
    // round trips, which would have persisted until IST rollover.
    if (tvBrokerFeed.isStateSchemaStale(saved)) {
      if (saved && typeof saved === 'object') {
        console.warn(`[tv-broker] discarding persisted feed state written by an older schema (v${saved.schemaVersion || 1} < v${tvBrokerFeed.STATE_SCHEMA_VERSION}) — its tradeCount (${saved.tradeCount}) came from a fold since found to over-count. Starting today's count fresh from the broker's own order history.`);
      }
      return tvBrokerFeed.freshState();
    }
    if (Array.isArray(saved.trades)) return saved;
  } catch (e) {}
  return tvBrokerFeed.freshState();
}
function persistTVBrokerFeedState() {
  try { dataSave(TV_BROKER_STATE_KEY, tvBrokerFeedState); } catch (e) {}
}

let tvBrokerMonitorTimer = null;
let tvBrokerSeenOrderIds = new Set(); // high-water mark so a fill is only ever "new" once
// NOT loadTVBrokerFeedState() here — DATA_DIR isn't finalized until
// initDataDir() runs inside the httpServer.listen() startup callback below
// (it can redirect to a different real directory). Loading here, at module
// top-level, would read from the pre-initDataDir() fallback path while
// persistTVBrokerFeedState() later saves to the real one — save and load
// would silently point at two different directories, and the restore would
// never find what was actually saved. Real state is loaded explicitly right
// after initDataDir() runs (search loadTVBrokerFeedState() below).
let tvBrokerFeedState = tvBrokerFeed.freshState();
// 2026-08-24: tracks readable/not-readable of the broker's OWN P&L columns so
// the switch between "real session total" and "reconstructed fold" logs once
// on transition rather than every 10s. Same pattern as tvBrokerFeedReadOk.
let tvBrokerPnlReadOk = null;
// Once per process: the broker-vs-fold disagreement is expected and permanent
// on any day he traded before the app came up, so it is worth saying once and
// never again — a line that repeats every 10s is a line nobody reads.
let tvBrokerPnlDriftLogged = null;
// 2026-08-24: fires on transition when the summary table freezes behind the
// header balance — the condition that makes a stale number look live.
let tvBrokerSummaryStaleLogged = null;
let tvBrokerFeedReadOk = null; // null = never polled yet; tracks state so log lines only fire on transitions, not every 10s
// G28 (2026-09-15): a positions table rendering its empty-state placeholder while a
// position is really open. Distinct from tvBrokerFeedReadOk (which is about the table
// being ABSENT) — this one is about the table being present but not painting its rows.
let tvBrokerPositionsUnreadable = false;
let tvBrokerPositionsUnreadableLogged = false;
let tvBrokerOrdersSuspectLogged = false; // tracks the orders-table-empty-but-position-open transition, same log-once-per-state pattern
let tvBrokerWalkDesyncLogged = false; // same log-once-per-state pattern for the order-walk-vs-positions disagreement (2026-08-20, H5)
// 2026-08-20 (found in review): the timestamp of THIS process's first broker
// poll. The order-history backfill exists solely to recover round trips that
// closed before this instance was watching — anything closing after this
// moment is the live fold's job. Without this boundary the backfill can
// reconstruct a trade the fold ALREADY recorded (realistic whenever
// ordersTableSuspect delays the backfill past a real close), adding a second
// pnlUnknown copy and inflating tradeCount straight into checkTradeAllowed's
// tradesPerDay ceiling. Decision (Anoop, 2026-08-20): gate on this boundary
// rather than fuzzy-matching exit timestamps — the two record types stamp
// their times from different clocks (fold uses Date.now() at poll time, the
// backfill parses TradingView's rendered string, whose timezone this codebase
// asserts but has never verified), so a proximity match could silently drop a
// REAL trade. A trade the fold misses after startup now stays visible as a
// tradeCountMismatch banner instead of being silently double-counted.
let tvBrokerFirstPollAt = null;
const TV_BROKER_POLL_MS = 10000;

// ── Live position watch (2026-08-20, Anoop's request) ──────────────────────
// "As soon as I close or open any trade it should be updated, and be part of
// the workflow." Two gaps this closes, both real before today:
//   1. LATENCY. The only live trade signal was the 10s full-account poll, so
//      an open or a close could sit unreported for up to 10 seconds.
//   2. OPENS WERE INVISIBLE. tv-broker-feed.js's fold only ever emits when a
//      trade CLOSES (tradeCount increments). Nothing in the app knew a trade
//      had started until it was over — so no rule could be checked, and no
//      coaching could land, while the position was still on.
//
// This is a LIGHT read: trading_get_positions only (one table), not
// trading_get_account (summary + positions + orders). It exists to spot the
// transition fast and then hand off — on any change it triggers an immediate
// full pollTVBrokerAccount() so the authoritative fold (P&L, trade count,
// size) catches up in the same beat rather than on the next 10s tick.
//
// Cadence chosen by Anoop at 5s: TradingView is scraped over CDP, so every
// tick is a real DOM read contending with the chart monitors and, critically,
// with placeMarketOrder's multi-second click sequence — hence the same
// withBrokerLock serialization the full poll already uses.
const TV_POSITION_WATCH_MS = 5000;
// Matched to the watch cadence, not to the lock's generous default: a position
// read that has not returned by the time the NEXT one is due has no remaining
// value, and holding the lock for it only extends how long the oversize guard
// judges a stale account. Given one extra second over the cadence so a merely
// slow read still lands rather than being cut off at the wire.
const POSITION_READ_TIMEOUT_MS = 6000;
let tvPositionWatchTimer = null;
// null = no baseline yet. diffPositions treats null as "first read, emit
// nothing", which is what makes a mid-position server restart silent instead
// of replaying the open position as a fresh entry.
let tvLastPositions = null;
let tvPositionWatchInFlight = false;
// 2026-08-21 (D4): true only while handleTradeConfirm is inside its
// withChartLock order-placement sequence.
//
// NOTE ON WHY THIS IS NARROW. The /autoplan eng review claimed the 5s watch
// contends with order placement for a lock; that is wrong. Placement runs on
// withChartLock (it must serialise against chart_set_symbol, or an
// interleaving symbol switch could place an order on the WRONG INSTRUMENT),
// while the broker reads run on withBrokerLock. They never queue behind each
// other, and that split is a deliberate 2026-08-19 fix for a real "poll queued
// for minutes behind chart monitors" bug. Suspending the watch would undo it.
//
// The genuine residual is smaller: mid-placement the orders table is being
// rewritten, so the watch's follow-up FULL account read can catch it half
// rendered, fail the walk/positions cross-check, and drop the feed into
// degraded mode at the least convenient moment. So only the hand-off is
// skipped. The lightweight positions read keeps running, which is exactly
// when you most want to see the position appear.
let tvOrderPlacementInFlight = false;
// The side that was actually on when a position last closed, per symbol (plus
// `__any` as a fallback for the single-instrument days that are the norm —
// rules.json's oneInstrumentPerDay). The fold records size and P&L but never
// side, so without this the auto-logged session row could only say '?'. Read
// once, by the auto-log below, and only as a label — nothing enforces off it.
const tvLastClosedSide = {};

// 2026-08-20 (found reviewing the position-watch change that made it
// reachable): coalesce concurrent polls into one. Until today this function
// had a single caller — the 10s interval — so overlapping invocations needed
// a >10s read to happen at all. It now has four: that interval, the
// 'tv-broker-check-now' WS message, startup, and the 5s position watch, which
// fires one on every open/close. Three can land on the same close.
//
// withBrokerLock does NOT protect this: it serializes the MCP read, but the
// fold and everything after it run AFTER that await, unlocked. Double-SCORING
// is already prevented twice over (fold compares against balanceAtLastFlat,
// which the first poll has updated by then, and closedRoundTripsScored has to
// advance) — but `prevTradeCount` is captured BEFORE the await, so a second
// concurrent poll still sees tradeCount > prevTradeCount and re-runs the
// whole new-trade block: a DUPLICATE row in his session log, a duplicate
// trade-closed-live broadcast, and duplicate mistake-pattern evaluation.
// Returning the in-flight promise makes every extra caller await the same
// single read instead of racing it, and halves the CDP load as a side effect.
// 2026-08-20 (review refinement): plain coalescing isn't enough on its own.
// If the position watch spots a close while a poll is ALREADY in flight, that
// in-flight poll may have read the account BEFORE the close landed — so
// returning it would report pre-close numbers and silently drop the hand-off,
// leaving the real close to wait out the 10s timer. `tvBrokerPollAgain` marks
// "something changed after this read started" and runs exactly one more poll
// when the current one finishes. One trailing re-run, not a queue: repeated
// callers during a single poll collapse into the same single follow-up.
let tvBrokerPollInFlight = null;
let tvBrokerPollAgain = false;
// ── Broker-panel watchdog (2026-08-26) ─────────────────────────────────────
// Anoop, on shipping this to clients: "what is permanent fix? repair &
// re-check does not work again. i dont want this issue."
//
// Repair used to be REACTIVE: something reads the panel, the read fails, only
// THEN is a repair attempted. By that point the feed has already been dark for
// however long it took him to notice the red box — on 2026-08-24 that was most
// of a session, and the numbers he traded on were wrong the whole time.
//
// A watchdog inverts it. The panel's state is checked on a timer whether or
// not anything failed, and a panel found shut is opened immediately. The
// common case — he closed it, or TradingView launched with it collapsed —
// never becomes a visible failure at all.
//
// SAFE BY CONSTRUCTION, which matters because this fires unattended on a
// live-money account:
//   - only ever OPENS; nothing here can close a panel he opened;
//   - the opener no-ops when the panel is already open, so the steady state
//     is a cheap DOM read every interval and nothing else;
//   - goes through withBrokerLock, so it cannot race a poll or an order;
//   - skipped entirely while TradingView is disconnected — there is nothing
//     to click, and retrying into a dead CDP just fills the log.
const PANEL_WATCHDOG_MS = 60000;
let panelWatchdogTimer = null;
let panelWatchdogLastState = null;

async function panelWatchdogTick() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) return;
  try {
    const raw = await withBrokerLock(() => mcpBridge.callTool('trading_ensure_panel_ready', {}));
    const text = (raw && raw.content) ? raw.content.map(c => c.text || '').join('') : null;
    const res = text ? JSON.parse(text) : null;
    if (!res) return;
    // Already healthy and was healthy last tick: say nothing. A watchdog that
    // logs every minute is a watchdog nobody reads.
    if (res.alreadyMounted) {
      if (panelWatchdogLastState === 'broken') {
        console.log('[panel-watchdog] broker panel is healthy again.');
      }
      panelWatchdogLastState = 'ok';
      return;
    }
    if (res.success) {
      panelWatchdogLastState = 'ok';
      const how = (res.expanded && res.expanded.tried && res.expanded.tried.length)
        ? res.expanded.tried.map(t => t.strategy).join(' -> ') : 'panel opened';
      console.log('[panel-watchdog] broker panel was shut and has been REOPENED automatically (' + how + '). '
        + 'The live feed would have gone dark without this.');
      broadcast({ type: 'panel-repaired', automatic: true, detail: how });
    } else {
      // Only shout on the transition into broken, then once more if it stays
      // broken across a full minute — enough to be noticed, not a flood.
      if (panelWatchdogLastState !== 'broken') {
        console.warn('[panel-watchdog] broker panel is shut and could NOT be reopened automatically. '
          + 'Still missing: ' + (res.stillMissing || []).join(', ')
          + '. Diagnostics: ' + JSON.stringify(res.diagnostics || null));
        broadcast({
          type: 'panel-repair-failed',
          stillMissing: res.stillMissing || [],
          diagnostics: res.diagnostics || null,
        });
      }
      panelWatchdogLastState = 'broken';
    }
  } catch (e) {
    // Never let the watchdog be the thing that takes the process down; it
    // exists to protect a live session, not to add a new way to lose one.
    console.warn('[panel-watchdog] tick failed: ' + e.message);
  }
}

function startPanelWatchdog() {
  if (panelWatchdogTimer) return;
  panelWatchdogTimer = setInterval(() => { panelWatchdogTick().catch(() => {}); }, PANEL_WATCHDOG_MS);
  if (panelWatchdogTimer.unref) panelWatchdogTimer.unref();
  console.log('✓ [panel-watchdog] ARMED — broker panel checked every '
    + Math.round(PANEL_WATCHDOG_MS / 1000) + 's and reopened automatically if found shut.');
  // Do not wait a full interval for the first check: a session that launches
  // with the panel collapsed is exactly the case this exists for.
  setTimeout(() => { panelWatchdogTick().catch(() => {}); }, 5000);
}

function pollTVBrokerAccount() {
  if (tvBrokerPollInFlight) {
    tvBrokerPollAgain = true;
    return tvBrokerPollInFlight;
  }
  tvBrokerPollInFlight = pollTVBrokerAccountInner().finally(() => {
    tvBrokerPollInFlight = null;
    if (tvBrokerPollAgain) {
      tvBrokerPollAgain = false;
      pollTVBrokerAccount();
    }
  });
  return tvBrokerPollInFlight;
}

async function pollTVBrokerAccountInner() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) return;
  try {
    // 2026-08-17 (Eng review finding, Phase 2b): this read shares the same
    // CDP/page context as placeMarketOrder()'s multi-second click sequence
    // (handleTradeConfirm, below) — without serialization, a poll landing
    // mid-order could interleave with order-placement clicks. Routed through
    // the same withChartLock every other chart-mutating caller already uses.
    const raw = await withBrokerLock(() => mcpBridge.callTool('trading_get_account', {}));
    const text = (raw && raw.content) ? raw.content.map(c => c.text || '').join('') : null;
    let result = text ? JSON.parse(text) : null; // let, not const: the self-heal retry below may replace it with a fresh read
    if (!result || !result.success) {
      // CDP to the chart can be up (mcpBridge.tvConnected=true) while the
      // Trading Panel/broker isn't actually open or linked — trading.js's
      // getAccountSummary() returns success:false in that case. Surface it
      // instead of silently no-opping, so the UI can distinguish "no new
      // trades" from "the broker feed isn't actually being read."
      const reason = (result && result.error) || 'broker panel not found (Trading Panel not open or broker not linked)';
      if (tvBrokerFeedReadOk !== false) console.warn('[tv-broker] broker feed NOT readable: ' + reason);
      tvBrokerFeedReadOk = false;
      broadcast({
        type: 'tv-broker-account',
        success: false,
        connected: false,
        reason
      });
      return;
    }
    // 2026-08-18 BUG FIX (found live: 3 real trades recorded as ZERO).
    // trading_get_account's own `success` is hardcoded true and says nothing
    // about whether the positions/orders tables were actually FOUND in the
    // DOM. The check above therefore always passed. Critically, `positions`
    // below is an empty array BOTH when the account is genuinely flat AND
    // when the positions table could not be read at all — and isFlat is
    // derived from it. An unreadable table thus looked like "flat" forever,
    // the fold's not-flat→flat transition never fired, and no trade was ever
    // recorded no matter how many were actually taken.
    //
    // Flatness is only knowable if the positions table was genuinely read.
    // If it wasn't, refuse to fold — a wrong "flat" corrupts the guardrail's
    // trade count, day P&L and size-after-loss state, which are the things
    // standing between Anoop and a blown account. Report it loudly instead.
    let positionsReadable = !!(result.positions && result.positions.success);
    // 2026-08-23 SELF-HEAL. Root cause of a full session with the live feed
    // dark: TradingView LAZILY MOUNTS each Trading Panel tab's table, so a tab
    // not yet rendered this session has no table in the DOM at all.
    // tradingview-mcp's getAccount() now repairs that itself before every read
    // (visiting the tab, then restoring whichever one Anoop had showing), so a
    // recoverable case is already fixed by the time we get here. This second
    // attempt covers a panel that re-rendered between that repair and this
    // read: one forced retry, then give up loudly exactly as before.
    //
    // Refusing to fold on an unknown flat/open state remains the correct end
    // state - a wrong 'flat' corrupts the trade count, day P&L and
    // size-after-loss guard, which is far worse than a visible stop.
    if (!positionsReadable) {
      try {
        const fix = await withBrokerLock(() => mcpBridge.callTool('trading_ensure_panel_ready', { want: ['positions', 'orders'] }));
        const fixText = (fix && fix.content) ? fix.content.map(c => c.text || '').join('') : null;
        const fixed = fixText ? JSON.parse(fixText) : null;
        if (fixed && fixed.success) {
          console.log('[tv-broker] panel self-heal: mounted ' + ((fixed.recovered || []).join(', ') || 'nothing missing') + ' - re-reading');
          const raw2 = await withBrokerLock(() => mcpBridge.callTool('trading_get_account', {}));
          const text2 = (raw2 && raw2.content) ? raw2.content.map(c => c.text || '').join('') : null;
          const result2 = text2 ? JSON.parse(text2) : null;
          if (result2 && result2.positions && result2.positions.success) {
            result = result2;
            positionsReadable = true;
            console.log('[tv-broker] panel self-heal SUCCEEDED - live feed is back, trades are being counted again');
            broadcast({ type: 'tv-broker-selfheal', ok: true, recovered: fixed.recovered || [], at: Date.now() });
          }
        }
      } catch (e) {
        console.warn('[tv-broker] panel self-heal attempt threw:', e.message);
      }
    }
    if (!positionsReadable) {
      const reason = "positions table not readable - cannot determine flat/open state, so trades CANNOT be counted. Auto-repair was tried and did not work. Open the broker panel at the BOTTOM of the TradingView window (click the 'Tradovate' tab on the bottom bar) and leave it open.";
      if (tvBrokerFeedReadOk !== false) console.warn('[tv-broker] ' + reason);
      tvBrokerFeedReadOk = false;
      broadcast({ type: 'tv-broker-account', success: false, connected: false, reason });
      // A dark feed is the worst state this app can be in - every guardrail
      // depends on it. Re-run the visible 3-step check so the UI reflects
      // reality immediately instead of showing a stale pass from startup.
      scheduleLiveFeedSelfTest(1500);
      return;
    }
    if (tvBrokerFeedReadOk !== true) console.log('[tv-broker] broker feed readable — positions/orders tables found, trade tracking is live');
    tvBrokerFeedReadOk = true;

    let orders = (result.orders && result.orders.orders) || [];
    // 2026-08-19 BUG FIX (found live, on Anoop's own first real test trade
    // today): the orders table can read as genuinely EMPTY
    // ("There is no trading data here yet") while the positions table
    // simultaneously shows a real open position from a filled entry order —
    // an impossible combination (a position cannot exist without at least
    // one filled order that created it). Observed live: 1 open MNQU6 long,
    // 0 rows in the orders table. tradingview-mcp's own header comment
    // assumed all 4 panel tables are always populated regardless of which
    // tab is showing — this proves that assumption doesn't always hold (the
    // Orders tab likely needs to have been visited/rendered at least once).
    // Trusting an empty `orders` here as ground truth would make the
    // brokerFilledCount reconciliation (below) permanently under-count and
    // fire a false MISMATCH banner the moment this position closes — exactly
    // the kind of false alarm that erodes trust in the whole feed. Treat
    // this specific combination as "orders table stale/unreadable", not as
    // "zero orders happened".
    let ordersTableSuspect = orders.length === 0 && (result.positions.positions || []).length > 0;
    // ── SELF-REPAIR (2026-09-02) ───────────────────────────────────────────
    // The block above used to end at "Open the Orders tab once to populate it"
    // — asking Anoop by hand to do the thing the app can do itself. That is
    // the identical fault panel-repair.js was written for on 2026-09-01, fixed
    // there for the SUMMARY tab only: its decide() has taken an `ordersReadable`
    // input since the day it shipped and nothing has ever passed one.
    //
    // The cost of leaving it unwired, measured: from 2026-09-01 this shape held
    // for two full sessions. Every close fell through to the balance-delta
    // fold, which writes `xp: null`, so nine consecutive trades were recorded
    // with no entry price, no exit price and no side — and the post-exit drift
    // panel, correctly refusing to anchor on a row with no exit price, kept
    // showing 2026-08-31's 29406.5 as though it were current.
    //
    // trading_ensure_panel_ready is NOT the right tool here and would report
    // success while changing nothing: the orders table IS mounted. Only its
    // rows are missing, because ka-table renders body rows for the visible tab
    // alone. trading_refresh_orders_table borrows the tab, reads, and restores
    // it — see refreshOrdersTable in tradingview-mcp/src/core/trading.js.
    //
    // Runs INLINE, before the walk consumes `orders`, so a successful refresh
    // rescues THIS poll rather than the next one — a close happening now is
    // exactly when the fill detail is worth having. Budgeted by panel-repair.js
    // (one attempt a minute, ceiling per day, escalate after 3 straight
    // failures) because the click visibly flickers his panel and a silent retry
    // loop is how the 9.5-hour outage stayed invisible.
    if (ordersTableSuspect) {
      try {
        const dayKey = dayRollup.tradingDayKey(Date.now());
        panelRepairOrdersState = panelRepair.rollDay(panelRepairOrdersState, dayKey);
        const d = panelRepair.decide({ ordersReadable: false }, panelRepairOrdersState, Date.now());
        panelRepairOrdersState = d.state;
        if (d.action === panelRepair.ACTION.REPAIR) {
          console.log('[panel-repair] orders table mounted but rendering no rows while a position is open — ' + d.reason);
          const raw = await withBrokerLock(function () { return mcpBridge.callTool('trading_refresh_orders_table', {}); });
          const txt = (raw && raw.content) ? raw.content.map(function (c) { return c.text || ''; }).join('') : null;
          const fix = txt ? JSON.parse(txt) : null;
          if (fix && fix.ok) {
            // Adopt the fresh rows for THIS poll. `orders` feeds the walk, the
            // fill detector and the backfill below, all of which were about to
            // be skipped.
            orders = Array.isArray(fix.orders) ? fix.orders : orders;
            ordersTableSuspect = orders.length === 0 && (result.positions.positions || []).length > 0;
            panelRepairOrdersState = panelRepair.recordResult(panelRepairOrdersState, !ordersTableSuspect);
            console.log('[panel-repair] orders table re-rendered: ' + fix.rowsBefore + ' rows → ' + fix.rowsAfter
              + ' (tab restored to "' + (fix.restoredTab || '?') + '": ' + (fix.restored ? 'yes' : 'NO') + ')');
            if (fix.restored === false) {
              // Worth a loud line: an unrestored tab leaves the POSITIONS table
              // hidden, and a hidden positions table reads as flat.
              console.warn('[panel-repair] could not restore the previous broker sub-tab — check the panel is not left on Orders, a stale positions table reads as FLAT.');
            }
          } else {
            panelRepairOrdersState = panelRepair.recordResult(panelRepairOrdersState, false);
            console.warn('[panel-repair] orders re-render did not take: ' + JSON.stringify(fix && (fix.click || fix.error) || 'no result'));
          }
        } else if (d.action === panelRepair.ACTION.ESCALATE) {
          console.warn('[panel-repair] ESCALATED — ' + d.reason);
          broadcast({ type: 'panel-repair-escalated', reason: d.reason, want: d.want });
        }
      } catch (e) { console.warn('[panel-repair] orders re-render threw: ' + e.message); }
    }
    if (ordersTableSuspect && tvBrokerOrdersSuspectLogged !== true) {
      console.warn('[tv-broker] orders table read as empty while a position is open — treating orders-derived counts as unreliable this poll. Auto-repair was tried and did not restore its rows. Open the Orders tab in the broker panel once.');
      tvBrokerOrdersSuspectLogged = true;
    } else if (!ordersTableSuspect) {
      tvBrokerOrdersSuspectLogged = false;
      // Readable again — clear the failure streak and any escalation, so a
      // later occurrence gets a fresh set of attempts rather than inheriting a
      // latch from hours ago. Mirrors the summary path's recovery branch.
      try { panelRepairOrdersState = panelRepair.decide({ ordersReadable: true }, panelRepairOrdersState, Date.now()).state; } catch (e) {}
    }
    // 2026-08-19 (Anoop pushed back, correctly, on "permanently invisible" —
    // the data to fix this was right there in the orders table). One-time-
    // per-day backfill of the trade COUNT/side/size/prices for round trips
    // that fully closed before THIS server instance ever polled — the exact
    // gap the balance-delta fold can't close by design. $ P&L is deliberately
    // NOT computed for these (see tv-broker-feed.js's
    // reconstructClosedTradesFromOrders header comment — no verified
    // per-contract multiplier exists in this codebase; inventing one would
    // trade a visible gap for an invisible wrong number). Gated by
    // backfillDone, persisted, so a later restart never re-runs this and
    // double-counts against trades the live fold has since observed for
    // real. Skipped while ordersTableSuspect — backfilling from a table
    // that's stale/not-yet-rendered would just reconstruct nothing or, worse,
    // a wrong partial history.
    // 2026-08-20 CRITICAL FIX (found in review, never observed live but fully
    // reachable): this block used to stamp `dayKeyMs: <today>` onto the state
    // while leaving `trades`/`dayPnl`/`tradeCount`/`lastLossTs` untouched, and
    // it runs BEFORE fold(). fold()'s only day-rollover mechanism is comparing
    // prevState.dayKeyMs against today's key (tv-broker-feed.js) — so if the
    // backfill had never run (which is exactly what happens when
    // ordersTableSuspect stayed true all session, a condition observed live on
    // 2026-08-19) and the process crossed IST midnight, the stamp made fold()
    // treat YESTERDAY's trades as today's. That is not just an advisory-banner
    // problem: yesterday's losses would then feed trade-confirm-rules'
    // checkTradeAllowed and size-freeze-guard's lastLossTs — real enforcement
    // on a live-money account, silently wrong in the permissive direction for
    // the day-stop and the trade count.
    //
    // Fixed by making the rollover EXPLICIT and unconditional here, before
    // anything else touches the state: if the persisted state belongs to a
    // previous IST day, reset it outright. fold() still does its own identical
    // check afterwards — this is deliberately belt-and-braces, not a
    // replacement, because the failure mode above was caused precisely by one
    // code path assuming another one had already handled the boundary.
    const todayKeyMs = tvBrokerFeed.istDayStartMs(Date.now());
    if (tvBrokerFeedState.dayKeyMs != null && tvBrokerFeedState.dayKeyMs !== todayKeyMs) {
      console.log(`[tv-broker] IST day rollover — clearing yesterday's feed state (${tvBrokerFeedState.tradeCount} trade(s), dayPnl ${Number(tvBrokerFeedState.dayPnl || 0).toFixed(2)}) before today's first fold.`);
      tvBrokerFeedState = tvBrokerFeed.freshState();
      persistTVBrokerFeedState();
    }

    if (tvBrokerFirstPollAt === null) tvBrokerFirstPollAt = Date.now();

    if (!ordersTableSuspect && !tvBrokerFeedState.backfillDone) {
      const backfillDayKeyMs = todayKeyMs;
      const reconstructed = tvBrokerFeed.reconstructClosedTradesFromOrders(orders, backfillDayKeyMs);
      // See tvBrokerFirstPollAt's declaration for why this boundary exists.
      const backfilled = reconstructed.filter(t => typeof t.exitAt === 'number' && t.exitAt < tvBrokerFirstPollAt);
      const skipped = reconstructed.length - backfilled.length;
      if (skipped > 0) {
        console.log(`[tv-broker] backfill skipped ${skipped} round trip(s) that closed AFTER this instance started polling — the live fold owns those; reconstructing them too would double-count into tradeCount and the tradesPerDay ceiling. If the fold missed one, it will show as a tradeCountMismatch rather than a silent duplicate.`);
      }
      if (backfilled.length) {
        console.log(`[tv-broker] backfilled ${backfilled.length} closed trade(s) from order history (side/size/prices only — $ P&L NOT computed, check the broker's own numbers): ` +
          backfilled.map(t => `${t.side} ${t.size}x ${t.entryPrice}->${t.exitPrice}`).join(', '));
      }
      tvBrokerFeedState = {
        ...tvBrokerFeedState,
        dayKeyMs: backfillDayKeyMs,
        trades: [...backfilled, ...tvBrokerFeedState.trades],
        tradeCount: tvBrokerFeedState.tradeCount + backfilled.length,
        backfillDone: true,
      };
      persistTVBrokerFeedState();
    }

    const filled = orders.filter(tvBrokerFeed.isFilledOrderRow);
    const newFills = filled.filter(o => o['Order ID'] && !tvBrokerSeenOrderIds.has(o['Order ID']));
    if (newFills.length) {
      newFills.forEach(o => tvBrokerSeenOrderIds.add(o['Order ID']));
      console.log(`[tv-broker] ${newFills.length} new filled order(s) detected: ` +
        newFills.map(o => `${o.Symbol} ${o.Side} x${o['Filled Qty'] || o.Qty}`).join(', '));
    }

    // `let`, not `const`: a forced positions re-render during the desync check
    // below can replace this with a freshly repainted read — see the 2026-09-02
    // note there for why the panel, not the walk, is the side that is usually
    // stale when the two disagree.
    let positions = (result.positions && result.positions.positions) || [];

    // ── G28 (2026-09-15): FLAT-WHILE-OPEN ──────────────────────────────────
    // Live, 2026-09-14: a 1-lot MNQU6 long was open for ~16 minutes while this feed
    // reported FLAT, counted only closed P&L, and the per-trade stop alarmed blind.
    // The broker's positions table was rendering its empty-state PLACEHOLDER
    // ("There are no open positions in your trading account yet") — the same shape as
    // a genuinely flat account, so the panel alone cannot tell them apart. The
    // tie-breaker is evidence that does NOT come from the panel: a WORKING take-profit
    // / stop-loss order, or the signed net of today's FILLED orders. Either one against
    // zero position rows is a contradiction, not a flat. See positions-read-quality.js.
    // A contradiction gets one forced positions re-render (the same tool + budget the
    // desync path below uses); if the table still paints empty, the poll REFUSES to
    // fold rather than recording a guessed flat — a wrong flat silently disables the
    // size cap and the per-trade stop, which is exactly Incident A's failure.
    let posQuality = null;
    try {
      let workingExits = 0, filledNet = 0;
      (orders || []).forEach(function (o) {
        if (!o) return;
        const status = String(o.Status || '').toLowerCase();
        if (status === 'working' && /take profit|stop loss/i.test(String(o.Type || ''))) workingExits++;
        if (tvBrokerFeed.isFilledOrderRow(o)) {
          const side = String(o.Side || '').toLowerCase();
          const qty = parseFloat(String(o['Filled Qty'] || o.Qty || '0').replace(/,/g, '')) || 0;
          if (side.indexOf('buy') >= 0) filledNet += qty;
          else if (side.indexOf('sell') >= 0) filledNet -= qty;
        }
      });
      const openPnlRaw = (result.summary && result.summary.header) ? result.summary.header.profit : null;
      const openPnl = openPnlRaw == null ? 0 : (parseFloat(String(openPnlRaw).replace(/[^0-9.+-]/g, '')) || 0);
      posQuality = positionsReadQuality.classify({
        positionsSuccess: true,
        positionCount: positions.length,
        workingExitOrders: workingExits,
        walkNetQty: filledNet,
        summaryOpenPnl: openPnl,
      });
      if (posQuality.state === 'unreadable' || posQuality.state === 'suspect') {
        console.warn('[tv-broker] G28 positions read is ' + posQuality.state.toUpperCase() + ' — ' + posQuality.reason);
        const rawP28 = await withBrokerLock(function () { return mcpBridge.callTool('trading_refresh_panel_table', { table: 'positions' }); });
        const fixP28 = parseToolResult(rawP28);
        if (fixP28 && fixP28.ok && Array.isArray(fixP28.positions) && fixP28.positions.length) {
          positions = fixP28.positions;
          tvLastPositions = fixP28.positions;
          posQuality = { state: 'open', contradiction: false, reason: 'recovered by a forced positions re-render' };
          console.warn('[tv-broker] G28 forced positions re-render RECOVERED ' + positions.length + ' row(s) — the table was stale, not flat');
          recordLiveEvent('POSITION', 'RECOVERED', 'positions table was rendering empty while a position was open — re-render restored ' + positions.length + ' row(s)');
        }
      }
    } catch (e) { console.warn('[tv-broker] G28 positions-quality check threw: ' + e.message); }

    if (posQuality && posQuality.state === 'unreadable') {
      tvBrokerPositionsUnreadable = true;
      const reason28 = 'positions table rendered EMPTY while the order history holds an open position (G28) — refusing to fold a guessed flat; a forced re-render did not restore the rows.';
      if (tvBrokerPositionsUnreadableLogged !== true) { console.warn('[tv-broker] ' + reason28); tvBrokerPositionsUnreadableLogged = true; }
      broadcast({ type: 'positions-unreadable', reason: reason28, open: true, at: Date.now() });
      recordLiveEvent('POSITION', 'UNREADABLE', posQuality.reason);
      scheduleLiveFeedSelfTest(1500);
      return;
    }
    if (tvBrokerPositionsUnreadable) console.log('[tv-broker] positions table reads rows again — flat/open state is trustworthy');
    tvBrokerPositionsUnreadable = false;
    tvBrokerPositionsUnreadableLogged = false;

    const isFlat = !positions.length;
    // SUMMED, not maxed (2026-09-02). Tradovate renders one row per position,
    // so `Math.max` over the rows reported a 5-lot scale-in as 1 — which is
    // what put "size 1" on every session-log row and in maxSize on the day he
    // actually traded 5. netPosition() folds per (symbol, side); the largest
    // symbol is the one this fold has always tracked.
    const netPos = oversizeGuard.netPosition(positions);
    const openSize = netPos ? netPos.size : 0;
    const balanceRaw = result.summary && result.summary.header ? result.summary.header.balance : null;
    const balance = tvBrokerFeed.parseBalance(balanceRaw);
    const prevTradeCount = tvBrokerFeedState.tradeCount;
    // 2026-08-20 (review): slice the new trades by ARRAY LENGTH, not by the
    // trade COUNT. The two are equal only while nothing ever adds to one
    // without the other — and the backfill above PREPENDS to `trades` while
    // separately incrementing `tradeCount`. Any future divergence (a dedupe
    // that removes a record, a repaired count) would make slice(count) return
    // already-logged trades and re-write their rows to the session log —
    // duplicates on disk that, unlike the feed state, no restart or day
    // rollover ever cleans up.
    const prevTradesLen = tvBrokerFeedState.trades.length;
    // 4.1 AUDIT FIX (2026-08-22): captured for the SAME reason as
    // prevTradesLen above, one comment block up — analyzeOrderWalk()
    // re-derives `walk.closed` from ALL of today's orders on every single
    // poll, so it is CUMULATIVE, while `newTrades` below is only the DELTA
    // since the last poll. Passing the full cumulative walk.closed into
    // joinFoldToWalk() against that small delta made every already-joined
    // walk close from an earlier poll come back as a fresh "order-walk-only"
    // unmatched record — re-written into the session log and re-broadcast
    // to chat on every later close, compounding across the day (reproduced:
    // a day's 2nd close re-emits the 1st as a duplicate; by the Nth close,
    // N-1 stale rows re-appear). closedRoundTripsScored already tracks
    // exactly "how many order-walk round trips has the fold accounted for
    // as of the last poll" (tv-broker-feed.js sets it to walk.closed.length
    // on every poll the walk is usable, independent of whether a NEW trade
    // closed) and is already restart-safe via persistTVBrokerFeedState() —
    // so slicing walk.closed by this, captured here before fold() advances
    // it, gives the join the same per-poll DELTA on both sides with no new
    // state invented.
    const prevClosedRoundTripsScored = tvBrokerFeedState.closedRoundTripsScored || 0;
    // 2026-08-20: the broker's own count of CLOSED ROUND TRIPS today, from a
    // per-symbol signed-quantity net-position walk over the filled orders.
    // This is the unit the fold's tradeCount is supposed to be in — unlike
    // `filled.length`, which counts ORDER ROWS and therefore inflates with
    // every scale-in and every split exit. Two consumers below:
    //   1. fold()'s poll-aliasing backstop, which needs proof a position
    //      actually closed (an entry fill used to be enough — see fold()'s
    //      2026-08-20 comment for the lockout that caused).
    //   2. the tradeCountMismatch reconciliation, which was comparing order
    //      rows against round trips and so could never agree on a normal day.
    // null while ordersTableSuspect: a table that hasn't rendered would walk
    // to a wrong (usually zero) count, which is worse than not comparing.
    // 2026-08-20 (review, H5): the walk is only trustworthy if it agrees with
    // the broker's own positions panel. One unreadable order row, or a trade
    // opened before IST midnight and closed after it, leaves its running sum
    // permanently non-zero — and every later round trip in that symbol then
    // goes unseen. Because the fold now GATES on this count, a frozen count
    // doesn't just mis-report: it disables the poll-aliasing backstop for the
    // rest of the day and pins the mismatch banner on. So a desynced walk is
    // treated exactly like an unreadable table — null, degraded path — rather
    // than being fed in as though it were fact.
    let walk = ordersTableSuspect ? null : tvBrokerFeed.analyzeOrderWalk(orders, todayKeyMs);
    let walkDesynced = walk ? tvBrokerFeed.isWalkDesynced(walk.netBySymbol, positions) : false;
    // ── THE OTHER HALF OF THE ORDERS FAULT (2026-09-02) ────────────────────
    // The repair above fires on the EMPTY shape, which only occurs while a
    // position is open. At the moment of a CLOSE the failure wears a different
    // face: the hidden Orders table still holds the rows it rendered earlier
    // but has not picked up the closing fill, so the walk's running net is
    // non-zero against a positions panel that says flat. isWalkDesynced spots
    // that and — correctly, it must not walk on rows it cannot trust — drops
    // the walk to null, which is the same degraded ending: fold, xp:null, no
    // exit price.
    //
    // A close is precisely when the fill detail is worth a flicker, and it
    // happens a handful of times a session rather than every 10s poll. So a
    // desync gets one re-render and one re-walk, under the same budget. If the
    // fresh rows still disagree with the positions panel then the desync is
    // real (an overnight-spanning trade, an unreadable row) and the existing
    // refusal stands untouched.
    if (walk && walkDesynced) {
      try {
        const dayKey2 = dayRollup.tradingDayKey(Date.now());
        panelRepairOrdersState = panelRepair.rollDay(panelRepairOrdersState, dayKey2);
        const d2 = panelRepair.decide({ ordersReadable: false }, panelRepairOrdersState, Date.now());
        panelRepairOrdersState = d2.state;
        if (d2.action === panelRepair.ACTION.REPAIR) {
          console.log('[panel-repair] order-history walk disagrees with the positions panel — re-rendering the Orders tab before trusting it.');
          const raw3 = await withBrokerLock(function () { return mcpBridge.callTool('trading_refresh_orders_table', {}); });
          const txt3 = (raw3 && raw3.content) ? raw3.content.map(function (c) { return c.text || ''; }).join('') : null;
          const fix3 = txt3 ? JSON.parse(txt3) : null;
          if (fix3 && fix3.ok && Array.isArray(fix3.orders)) {
            orders = fix3.orders;
            let reWalk = tvBrokerFeed.analyzeOrderWalk(orders, todayKeyMs);
            let reDesynced = tvBrokerFeed.isWalkDesynced(reWalk.netBySymbol, positions);
            // ── STILL OFF? THEN THE DAY DID NOT OPEN FLAT (2026-09-02) ──────
            // A freshly re-rendered table that still will not reconcile is not
            // a rendering fault. The remaining explanation that fits is the
            // walk's own starting assumption: its window begins at midnight IST
            // and it starts every symbol at zero, which asserts the account was
            // flat at midnight. Carry a position across that boundary and the
            // walk runs offset all day and never returns to zero — so one stray
            // contract refuses the walk for EVERY symbol, taking trade counts,
            // exit prices and direction down with it.
            //
            // Observed today: WALK NET MNQU6 -1 against a flat panel, across 44
            // rows and 11 round trips. The panel is ground truth for what is
            // open now, so the residual IS the opening position, negated.
            //
            // Re-walked with that offset and ONLY accepted if it then agrees
            // with the panel exactly. If it does not, nothing is adopted and the
            // original refusal stands — see reconcileOpeningPositions for why
            // this cannot distinguish an overnight hold from a fill row that has
            // scrolled out of the table, and why it therefore refuses to call
            // the result verified.
            // ── WHICH SIDE IS ACTUALLY STALE? (2026-09-02) ─────────────────
            // isWalkDesynced reports only THAT the two disagree. Every caller
            // then drops the WALK — an assumption nothing ever tested, and the
            // broker statement for 2026-09-02 shows it is the wrong way round.
            //
            //   desync logged   14:51:03Z   WALK NET: MNQU6 -1 | PANEL: flat
            //   broker SELL 1   14:50:57Z   (6 seconds earlier)
            //   broker BUY  1   14:52:55Z
            //
            // He was genuinely SHORT 1 for those two minutes. The walk had it
            // right; the positions panel had not repainted. The walk is derived
            // from a timestamped, append-only order history — the panel is a
            // live-rendered widget this file already documents as not repainting
            // while its tab is hidden. On the evidence the walk is the MORE
            // reliable of the two, and dropping it on the panel's word threw
            // away the correct reading in favour of the stale one, taking trade
            // counts, exit prices and direction with it.
            //
            // So before believing the panel: force IT to re-render too, and
            // re-test. Only a disagreement that survives a freshly repainted
            // panel is a real desync. This runs at most once per poll under the
            // same budget as the orders refresh.
            if (reDesynced) {
              try {
                const rawP = await withBrokerLock(function () {
                  return mcpBridge.callTool('trading_refresh_panel_table', { table: 'positions' });
                });
                const fixP = parseToolResult(rawP);
                if (fixP && fixP.ok && Array.isArray(fixP.positions)) {
                  const freshDesync = tvBrokerFeed.isWalkDesynced(reWalk.netBySymbol, fixP.positions);
                  if (!freshDesync) {
                    console.warn('[tv-broker] the WALK was right and the POSITIONS PANEL was stale — a forced'
                      + ' re-render agrees with the walk. Adopting the fresh panel read; the walk stays trusted.');
                    positions = fixP.positions;
                    tvLastPositions = fixP.positions;
                    reDesynced = false;
                  }
                }
              } catch (e) { console.warn('[tv-broker] positions re-render during desync check threw: ' + e.message); }
            }

            // ── REPORT THE HYPOTHESIS, DO NOT ACT ON IT (2026-09-02, same day) ──
            // This block briefly ADOPTED the inferred opening position and
            // re-walked with it. Anoop's broker statement for 2026-09-02
            // disproved the inference within the hour: 43 distinct fills walk
            // to a final net of ZERO and the first fill of the day is at 12:43
            // IST, so the day both opened and closed FLAT. There was no
            // overnight carry. The walk's -1 residual is an APP-SIDE read error
            // — the table showed 44 rows against 43 real fills — and seeding it
            // would have manufactured a position that never existed, then
            // reported the resulting round-trip count as recovered.
            //
            // That is a worse failure than the desync it was meant to fix. A
            // refused walk is a visible gap; a seeded walk is a confident wrong
            // answer, which is the one thing this codebase's trust protocol
            // exists to prevent. The residual is a genuine defect and must stay
            // visible until its cause is found.
            //
            // The inference is still WORTH PRINTING — if the residual ever does
            // come from a real overnight hold, this line is what will say so.
            // It just may never be believed automatically.
            if (reDesynced) {
              try {
                const rec = tvBrokerFeed.reconcileOpeningPositions(reWalk.netBySymbol, positions);
                console.warn('[tv-broker] walk still will not reconcile. HYPOTHESIS (reported, NOT applied): '
                  + rec.reason + ' — if the account really was flat at midnight IST then this residual is an'
                  + ' app-side read error, not an overnight position, and the walk stays refused. Reconcile the'
                  + " Orders table against your broker's own statement to settle which.");
              } catch (e) {}
            }
            panelRepairOrdersState = panelRepair.recordResult(panelRepairOrdersState, !reDesynced);
            console.log('[panel-repair] re-walk after refresh: ' + (reDesynced
              ? 'STILL desynced — the disagreement is real, keeping the refusal.'
              : 'in step with the positions panel now — the walk is trusted, fills keep their prices.'));
            walk = reWalk;
            walkDesynced = reDesynced;
          } else {
            panelRepairOrdersState = panelRepair.recordResult(panelRepairOrdersState, false);
          }
        }
      } catch (e) { console.warn('[panel-repair] desync re-render threw: ' + e.message); }
    }
    if (walk && (walkDesynced || walk.droppedRows > 0) && tvBrokerWalkDesyncLogged !== true) {
      // 2026-09-02: PRINT THE DISAGREEMENT, not just its existence. This line
      // has said "desynced=true" for days without ever naming which symbol or
      // by how much, so every investigation had to start by re-deriving it from
      // scratch. The walk's residual net IS the whole diagnosis: a symbol left
      // non-zero against a flat panel means the walk never booked a close (a
      // fill that landed before this IST day started, or one the table no
      // longer lists), and the number tells you which.
      const netTxt = Object.keys(walk.netBySymbol || {}).length
        ? Object.entries(walk.netBySymbol).map(function (e) { return e[0] + ' ' + (e[1] > 0 ? '+' : '') + e[1]; }).join(', ')
        : '(walk shows flat)';
      const posTxt = (positions || []).length
        ? positions.map(function (p) { return (p.Symbol || '?') + ' ' + (p.Side || '?') + ' ' + (p.Qty || '?'); }).join(', ')
        : '(panel shows flat)';
      console.warn(`[tv-broker] order-history walk is out of step with the positions panel (desynced=${walkDesynced}, unreadable rows=${walk.droppedRows}).`
        + ` WALK NET: ${netTxt}  |  PANEL: ${posTxt}  |  ${walk.closed.length} round trip(s) walked from ${orders.length} order row(s).`
        + ' Treating its round-trip count as unavailable — the fold falls back to fill-edge detection, which can over-count.'
        + ' A residual net against a flat panel means the walk never saw the opening fill: it landed before this IST trading day began, or has scrolled out of the Orders table.');
      tvBrokerWalkDesyncLogged = true;
    } else if (walk && !walkDesynced && walk.droppedRows === 0) {
      tvBrokerWalkDesyncLogged = false;
    }
    const closedRoundTripsToday = (!walk || walkDesynced || walk.droppedRows > 0)
      ? null
      : walk.closed.length;
    // 2026-08-26: hand the verification the SAME evidence, under the SAME
    // trust gate the count uses. A walk not trusted for counting must not be
    // trusted for verifying either.
    tvBrokerLastWalkClosed = closedRoundTripsToday === null ? null : walk.closed;
    // 2026-08-19: hasNewFill ties the poll-aliasing backstop to real evidence
    // (this same poll's orders-table read found a genuinely new Filled
    // order) instead of firing on any balance movement — see fold()'s
    // 2026-08-19 comment for the live incident (Balance drifting on its own
    // while genuinely flat, fabricating 20 fake trades) this closes.
    // 2026-08-24: the broker's OWN session P&L, straight off the account
    // summary panel. tradingview-mcp has been reading this table into
    // `summary.detail` since the day it was written; nothing in this app ever
    // looked at it, so the day P&L was reconstructed from balance deltas when
    // the real answer was already on the wire. See tv-broker-feed.js's
    // readBrokerPnl for the $553.90 miss that exposed it.
    const brokerPnl = tvBrokerFeed.readBrokerPnl(result.summary);
    // Realized only: the app's day record contains closed trades, so
    // comparing it against a total that includes floating P&L on an open
    // position would report a mismatch on every trade he is still in.
    // A stale panel is treated as unreadable rather than as evidence.
    tvBrokerLastBrokerRealized = (brokerPnl && brokerPnl.readable && !brokerPnl.stale)
      ? brokerPnl.realized : null;
    if (brokerPnl.readable !== tvBrokerPnlReadOk) {
      tvBrokerPnlReadOk = brokerPnl.readable;
      console.log(brokerPnl.readable

        ? `[tv-broker] broker's own session P&L is readable — day P&L now comes from the account panel (Total ${brokerPnl.totalPnl.toFixed(2)}, Open ${brokerPnl.openPnl === null ? 'n/a' : brokerPnl.openPnl.toFixed(2)}), not from reconstructed balance deltas.`
        : "[tv-broker] account-summary P&L columns NOT readable — falling back to the balance-delta fold for day P&L. That figure only covers trades this instance watched close, so it can understate the real session total. Check the Account Summary tab in the broker panel.");
    }
    // ── SELF-REPAIR (2026-09-01) ─────────────────────────────────────────
    // The branch above used to end at "Check the Account Summary tab in the
    // broker panel" — asking Anoop by hand to do exactly what
    // trading_ensure_panel_ready does automatically. TradingView lazily
    // renders the panel sub-tabs, so a tab never clicked has no table in the
    // DOM to read. On 2026-09-01 that ran the feed degraded for 9.5 hours:
    // day P&L fell back to the balance-delta fold, trades logged "unverified
    // live", the Journal stayed empty and the drift read had no exit price.
    // The existing repair call asked for want:[positions,orders] and never
    // "summary", though PANEL_TABLES has mapped it the whole time.
    if (!brokerPnl.readable) {
      try {
        const dayKey = dayRollup.tradingDayKey(Date.now());
        panelRepairState = panelRepair.rollDay(panelRepairState, dayKey);
        const d = panelRepair.decide(
          { summaryReadable: false, positionsReadable: undefined, ordersReadable: undefined },
          panelRepairState, Date.now());
        panelRepairState = d.state;
        if (d.action === panelRepair.ACTION.REPAIR) {
          console.log("[panel-repair] " + d.reason);
          withBrokerLock(function () { return mcpBridge.callTool("trading_ensure_panel_ready", { want: d.want }); })
            .then(function () {
              // Success is claimed only when the NEXT poll actually reads the
              // table. The tool returning is not evidence the columns are back.
              console.log("[panel-repair] re-render requested: " + d.want.join(", ") + " — next poll confirms.");
            })
            .catch(function (e) {
              panelRepairState = panelRepair.recordResult(panelRepairState, false);
              console.warn("[panel-repair] attempt failed: " + e.message);
            });
        } else if (d.action === panelRepair.ACTION.ESCALATE) {
          console.warn("[panel-repair] ESCALATED — " + d.reason);
          broadcast({ type: "panel-repair-escalated", reason: d.reason, want: d.want });
        }
      } catch (e) { console.warn("[panel-repair] decision failed: " + e.message); }
    } else {
      // Readable again — clear the failure streak so a later fault gets a
      // fresh set of attempts instead of inheriting an old escalation.
      try { panelRepairState = panelRepair.decide({ summaryReadable: true }, panelRepairState, Date.now()).state; } catch (e) {}
    }
    tvBrokerFeedState = tvBrokerFeed.fold(tvBrokerFeedState, {
      balance, isFlat, openSize, nowMs: Date.now(),
      // 2026-09-02: IS THE WALK'S COUNT CURRENTLY TRUSTED? `closedRoundTripsScored`
      // keeps its last value when the walk goes dark, and effectiveTradeCount
      // takes max(corroborated, thatValue) -- so a count produced while the walk
      // was healthy goes on driving the display and the daily-cap LOCKOUT long
      // after the app has started refusing that same walk everywhere else.
      // Observed today: walk 11, fold 6, day_trades 5 rows, and a red
      // "10 trades (live) -- cap 10. Done." banner. This is the third time this
      // bug class has locked him out on a number the app itself did not believe
      // (2026-08-20 "9/3 -- DONE", 2026-08-24 "15/5"); both earlier fixes made
      // the NUMBER better without ever recording whether it was CURRENTLY
      // trustworthy, which is the fact the lockout actually needs.
      walkTrusted: closedRoundTripsToday !== null,
      hasNewFill: newFills.length > 0,
      closedRoundTrips: closedRoundTripsToday,
      // 2026-08-25: the walk's RECORDS, not just its count. They carry side,
      // entry/exit price and both timestamps — the fields every live-written
      // row had as null, which is why the Journal showed "—" for direction on
      // a full day of trading. Gated on the SAME conditions the count is
      // (null when the walk is desynced or dropped rows), so a walk that is
      // not trusted for counting is not trusted for direction either.
      closedRoundTripRecords: closedRoundTripsToday === null ? null : walk.closed,
      brokerTotalPnl: brokerPnl.totalPnl,
      brokerOpenPnl: brokerPnl.openPnl,
      brokerNetLiq: brokerPnl.netLiq,
      brokerHeaderBalance: brokerPnl.headerBalance,
      brokerSummaryStale: brokerPnl.stale,
    });


    // 2026-08-25: REPAIR the day's stored rows from the same order history.
    // Anoop, on a full day of "—" in the Journal's Side column: "how can you
    // solve it." The walk-join above only stamps direction on trades booked
    // from here on; today's rows were written by the previous build and would
    // stay blank forever. The orders table still holds them, so backfill the
    // blanks rather than telling him to restart and check again tomorrow.
    //
    // Cheap and idempotent: enrichRowsFromWalk only touches rows whose side is
    // missing, so once a day is repaired every later poll matches nothing and
    // writes nothing. Gated on the same trustworthy-walk condition as
    // everything else here.
    if (closedRoundTripsToday !== null && walk.closed.length) {
      try {
        const slotId = loadConfig().activeSlotId;
        const dtKey = 'day_trades__' + slotId;
        const dtStore = slotId ? (dataLoad(dtKey) || {}) : null;
        const repairKey = dayRollup.tradingDayKey(Date.now());
        const existing = dtStore && Array.isArray(dtStore[repairKey]) ? dtStore[repairKey] : null;
        if (existing && existing.some(r => r && !r.side)) {
          const res = tvBrokerFeed.enrichRowsFromWalk(existing, walk.closed);
          if (res.filled > 0) {
            dtStore[repairKey] = res.rows;
            dataSave(dtKey, dtStore);
            console.log('[tv-broker] repaired ' + res.filled + ' stored row(s) for ' + repairKey
              + ' with side/prices from order history'
              + (res.ambiguous ? ' (' + res.ambiguous + ' left blank as ambiguous)' : '')
              + '. Reload the Journal tab to see them.');
            broadcast({ type: 'day-trades-repaired', date: repairKey, filled: res.filled, ambiguous: res.ambiguous });
          }
        }
      } catch (e) {
        console.log('[tv-broker] stored-row side repair failed: ' + e.message);
      }
    }
    if (brokerPnl.stale && tvBrokerSummaryStaleLogged !== true) {
      console.warn('[tv-broker] the account-summary table has FALLEN BEHIND: header balance ' + brokerPnl.headerBalance +
        ' vs its Net Liq ' + brokerPnl.netLiq + ' (gap $' + (brokerPnl.headerBalance - brokerPnl.netLiq).toFixed(2) + '). ' +
        'Total P/L is read off that same table, so the day P&L is understating by roughly that amount. ' +
        'Click the Account Summary tab in the broker panel to force it to re-render.');
      tvBrokerSummaryStaleLogged = true;
    } else if (!brokerPnl.stale) {
      tvBrokerSummaryStaleLogged = false;
    }
    // Every poll, not just on a trade close — sizeSeenThisTrade/wasFlat/
    // balanceAtLastFlat all need to survive a restart mid-trade too, not
    // only the completed-trades list, or a restart during an OPEN position
    // would lose the "last known flat balance" reference point the eventual
    // close needs to compute P&L against.
    persistTVBrokerFeedState();

    // 2026-08-26 SELF-HEAL. The day-record write below fires only on the poll
    // where tradeCount INCREASES — a one-shot with no retry. A restart after
    // the fold persisted a trade (the count comes back restored, so it never
    // increases again), a throw anywhere in that poll, or a walk-join that
    // returned nothing, all leave the trade in the fold and absent from
    // day_trades.json forever. That is what happened on 2026-08-26: the fold
    // held one trade at -203 and the Journal showed no trades for the day.
    //
    // Runs every poll, writes nothing when nothing is missing. Cheap: one
    // file read plus a set comparison. writeLiveTradeToDayRecord is itself
    // idempotent (it merges by fingerprint into a Map), so a double-call
    // cannot duplicate a row even if the match below were wrong.
    try {
      const healSlot = jessiBucketKey(loadConfig());
      const healKey = dayRollup.tradingDayKey(Date.now());
      const healStore = dataLoad('day_trades__' + healSlot) || {};
      const healRows = Array.isArray(healStore[healKey]) ? healStore[healKey] : [];
      const todayFold = (tvBrokerFeedState.trades || [])
        .filter(t => t && t.at != null && dayRollup.tradingDayKey(t.at) === healKey);
      // 2026-08-28: the commission rate must reach the matcher. A walk-joined
      // row holds GROSS and a folded trade holds NET, so the two differ by
      // exactly size x round-turn commission — that arithmetic is how a
      // cross-route duplicate is recognised. Without the rate the matcher
      // falls back to exact-P&L only, which is what let one trade become
      // three rows. Never hardcoded; rules.json owns it.
      // 2026-08-28: a zero-P&L folded trade is a phantom the zero-delta guard
      // now prevents at source. Legacy state written BEFORE that guard can
      // still hold one, and the self-heal would otherwise try to write it
      // every poll forever — it fired 4 times in 20 minutes doing exactly
      // that. Excluded here so old state cannot resurrect the loop.
      const todayFoldReal = todayFold.filter(t => !(Number(t && t.pnl) === 0));
      const phantomsSkipped = todayFold.length - todayFoldReal.length;
      const missing = tvBrokerFeed.missingFromDayRows(todayFoldReal, healRows, {
        commissionPerContractPerSide: getActiveRules().commissionPerContractPerSide,
      });
      if (missing.length) {
        console.warn('[day-record] SELF-HEAL: ' + missing.length + ' folded trade(s) for ' + healKey
          + ' were missing from the day record — writing them now. '
          + '(Expected after a restart mid-session; if it repeats every poll the write itself is failing.)');
        missing.forEach(t => {
          try {
            const res = writeLiveTradeToDayRecord(t);
            if (res !== 'written') console.warn('[day-record] SELF-HEAL could not write a trade: ' + res);
          } catch (e) { console.warn('[day-record] SELF-HEAL threw: ' + e.message); }
        });
      }
      // ── SELF-REPAIR, WITH EVIDENCE (2026-08-28) ─────────────────────────
      // Anoop: "whatever mismatch ... is shown it should have self fixing
      // capacity and after fixing it should show me the evidence that it took
      // place on the app."
      //
      // The LIVE FEED MISMATCH banner reported the truth (broker order history
      // 0 round trips vs tracker 2) and then did nothing about it. Phantom
      // trades are now removed from the live state itself, not merely filtered
      // on read, and the repair is BROADCAST and logged so the correction is
      // visible rather than the number quietly becoming right. A silent fix is
      // indistinguishable from a fix that never ran.
      if (phantomsSkipped > 0) {
        const before = tvBrokerFeedState.tradeCount;
        tvBrokerFeedState.trades = (tvBrokerFeedState.trades || []).filter(t => !(Number(t && t.pnl) === 0));
        tvBrokerFeedState.tradeCount = Math.max(0, before - phantomsSkipped);
        persistTVBrokerFeedState();
        const evidence = {
          what: 'phantom flat transitions removed',
          why: 'a closed trade always moves the balance (commission always applies) — a zero delta means no fill happened',
          removed: phantomsSkipped,
          tradeCountBefore: before,
          tradeCountAfter: tvBrokerFeedState.tradeCount,
          dayPnlUnchanged: Math.round((tvBrokerFeedState.dayPnl || 0) * 100) / 100,
          at: new Date().toISOString(),
        };
        console.warn('[self-repair] removed ' + phantomsSkipped + ' phantom trade(s) from the live tracker: '
          + before + ' -> ' + tvBrokerFeedState.tradeCount + ' trades, day P&L unchanged at $'
          + evidence.dayPnlUnchanged);
        broadcast({ type: 'self-repair', kind: 'phantom-trades', evidence });
      }
    } catch (e) {
      console.warn('[day-record] SELF-HEAL check failed: ' + e.message);
    }

    // 2026-08-24: the two numbers the rest of the app is allowed to believe.
    // Derived here, once, so the poll broadcast, the shadow enforcement check
    // and Now.md cannot drift apart by each doing their own arithmetic.
    const effPnl = tvBrokerFeed.effectiveDayPnl(tvBrokerFeedState, Date.now());
    const effCount = tvBrokerFeed.effectiveTradeCount(tvBrokerFeedState);
    if (effPnl.source === 'broker' && effPnl.drift !== null && Math.abs(effPnl.drift) > 1
        && tvBrokerPnlDriftLogged !== true) {
      console.warn(`[tv-broker] day P&L sources disagree: broker says realized ${effPnl.realized.toFixed(2)} for the session, the balance-delta fold reconstructed ${effPnl.foldValue.toFixed(2)} (drift ${effPnl.drift.toFixed(2)}). ` +
        'Expected whenever trading happened before this instance started polling, or a balance move was re-anchored without a corroborating fill. ' +
        "The BROKER's figure is the one being displayed and enforced on.");
      tvBrokerPnlDriftLogged = true;
    }
    if (tvBrokerFeedState.tradeCount > prevTradeCount) {
      const newTrades = tvBrokerFeedState.trades.slice(prevTradesLen);
      console.log(`[tv-broker] ${newTrades.length} trade(s) closed (balance-delta-at-flat, unverified live): ` +
        newTrades.map(t => `size ${t.size} pnl ${t.pnl.toFixed(2)}`).join(', '));
      // 4.1: join each fold-scored close with its order-walk round trip so the
      // downstream record carries symbol/side/prices/times AND the fold's
      // confirmed P&L. Unmatched halves are kept, never dropped.
      // 4.1 AUDIT FIX: slice to the delta since last poll (see
      // prevClosedRoundTripsScored above) — NOT the full cumulative list,
      // or already-joined closes from earlier polls re-appear as
      // duplicates every poll for the rest of the day.
      const walkClosedSafe = (walk && !walkDesynced && walk.droppedRows === 0)
        ? walk.closed.slice(prevClosedRoundTripsScored) : [];
      const joined = tradeRecordJoin.joinFoldToWalk(newTrades, walkClosedSafe);
      if (joined.merged.length) {
        console.log(`[tv-broker] 4.1 join: ${joined.merged.length}/${newTrades.length} fold closes matched to order-walk round trips` +
          (joined.unmatchedWalk.length ? `; ${joined.unmatchedWalk.length} walk closes the fold did not score (kept as order-walk-only)` : ''));
      }

      // 2026-08-20 (Anoop's request — "be part of the workflow"): a closed
      // trade now writes its own row into today's session log instead of
      // waiting to be typed in by hand, and announces itself in chat so
      // Jessi's context has it while the next decision is still being made.
      //
      // WHAT IS AND ISN'T FILLED IN — deliberately narrow, per
      // TRUST-PROTOCOL.md. The fold knows exactly two things about a closed
      // trade: its size (when observed, 0 when inferred) and its realized P&L
      // (the flat-to-flat balance delta). It does NOT know entry, stop or
      // target — those are never recorded anywhere the fold can see. So they
      // are written as '?' for Anoop to fill in, NOT guessed from the orders
      // table's fill prices, which would silently pass an average fill off as
      // a planned entry and a fill price off as a stop that was never set.
      // `direction` comes from the position watch's own `closed` event (the
      // side that was actually on), and stays '?' if that event wasn't seen.
      // 4.1: t.symbol now exists for joined records (from the order walk);
      // fold-only records carry symbol null and take the same safe fallback
      // as before (single-instrument day → __any, else '?').
      for (const t of joined.records) {
        try {
          const symbolsToday = Object.keys(tvLastClosedSide).filter(k => k !== '__any');
          const dir = tvLastClosedSide[t.symbol]
            || (symbolsToday.length <= 1 ? tvLastClosedSide.__any : null)
            || '?';
          const pnlKnown = t.pnlUnknown !== true;
          const noteBits = ['auto-logged from live feed'];
          if (t.inferred) noteBits.push('size not observed (opened+closed between polls)');
          if (!pnlKnown) noteBits.push('P&L NOT computed — read it off the broker');
          // 4.4: entry/exit now come from the 4.1 join's order-walk FILL
          // prices (observed, not planned). stop/target stay '?' — planned
          // levels exist nowhere in broker data, and passing a fill off as a
          // planned stop is exactly what the '?' convention exists to prevent.
          if (t.entryPrice != null || t.exitPrice != null) noteBits.push('entry/exit = order-walk avg fill prices');
          const logged = sessionMgr.logTrade(sessionMgr.todayStr(), {
            direction: dir === '?' ? '?' : dir.toUpperCase(),
            entry: t.entryPrice != null ? String(t.entryPrice) : '?',
            stop: '?', target: '?',
            exit: t.exitPrice != null ? String(t.exitPrice) : '?',
            pnl: pnlKnown ? Number(t.pnl.toFixed(2)) : undefined,
            notes: noteBits.join('; ') + (t.size ? `; size ${t.size}` : ''),
          });
          // 4.3: the same closed trade writes the durable day record (rows +
          // rollup + ledger) through the shared day-rollup — CSV is no longer
          // the only writer. pnlUnknown records are skipped inside.
          try { writeLiveTradeToDayRecord(t); } catch (e) { console.warn('[day-record] live write threw:', e.message); }
          // 2026-08-20 (review, H6): logTrade used to return success even when
          // its insert silently no-opped. It now reports honestly, so a
          // dropped trade is visible instead of vanishing — the whole point of
          // auto-logging is that the record is complete without him thinking
          // about it, which fails silently in exactly the wrong direction.
          if (logged && logged.ok === false) {
            console.warn('[tv-broker] auto-log did NOT write the trade row: ' + logged.reason);
            broadcast({ type: 'session-log-failed', reason: logged.reason, path: logged.path });
          }
        } catch (e) {
          // A session-log write must never take down the poll that also runs
          // the guardrail's enforcement path.
          console.warn('[tv-broker] auto-log to session log failed:', e.message);
        }
      }
      // 2026-08-20: SELF-VERIFICATION. The fold's P&L comes from balance
      // deltas; the order walk independently knows this round trip's entry
      // price, exit price, side and size, and the point value is now
      // established from data (117/117 real trades - scripts/verify-fold.js).
      // So every closed trade is checked against a second, independent
      // derivation the moment it happens, instead of waiting on another
      // manual audit. This does NOT change any number the guardrail
      // enforces: the balance delta stays the truth, because it is the
      // account and it captures fees. Disagreement is SURFACED, exactly like
      // the round-trip count reconciliation, so a wrong figure becomes a
      // signal rather than a silent input to size-freeze-guard/cooldown.
      if (joined.merged.length) {
        const commRate = getActiveRules().commissionPerContractPerSide;
        joined.merged.forEach(t => {
          // 4.1: the joined record itself carries both halves — no index-
          // slicing of the walk needed (which assumed fold closes and walk
          // closes arrived 1:1 in the same order).
          const exp = tvBrokerFeed.expectedPnlFromFills(t, commRate);
          if (!exp || t.pnlUnknown) return; // no verified multiplier, or nothing to compare
          const delta = t.pnl - exp.net;
          // $1 of slack absorbs exchange rounding and fee timing without
          // swallowing a real error - the 2026-08-20 miscounts were $50+ apart.
          const ok = Math.abs(delta) <= 1.0;
          const line = t.symbol + ': balance-delta ' + t.pnl.toFixed(2) + ' vs fills ' + exp.net.toFixed(2) +
            ' (' + t.side + ' ' + t.size + ' @ ' + t.entryPrice + ' -> ' + t.exitPrice +
            ', gross ' + exp.gross.toFixed(2) + ' - comm ' + exp.commission.toFixed(2) + '), diff ' + delta.toFixed(2);
          if (ok) {
            console.log('[tv-broker] P&L cross-check OK on ' + line);
            // H6: a real closed trade with non-zero P&L whose two independent
            // derivations agree — that is exactly the confirmation the
            // scorecard gate waits for (plan 5.2 / parallel track H6).
            if (Math.abs(t.pnl) > 0.5 && !h6Status.passed) h6MarkPassed(t.at);
          }
          else console.warn('[tv-broker] P&L CROSS-CHECK MISMATCH on ' + line + '. Enforcement still uses the balance delta.');
          broadcast({
            type: 'pnl-cross-check', ok, symbol: t.symbol,
            balanceDelta: t.pnl, fromFills: exp.net, difference: delta,
            side: t.side, size: t.size, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
          });
        });
      }

      broadcast({
        type: 'trade-closed-live',
        trades: joined.records.map(t => ({
          size: t.size, pnl: t.pnl, inferred: !!t.inferred, pnlUnknown: !!t.pnlUnknown,
          symbol: t.symbol || null, side: t.side || null,
          entryPrice: t.entryPrice != null ? t.entryPrice : null,
          exitPrice: t.exitPrice != null ? t.exitPrice : null,
          source: t.source,
        })),
        tradeCount: effCount.value,
        dayPnl: effPnl.value,
        dayPnlSource: effPnl.source,
        at: Date.now(),
      });

      // 2026-08-19 (Anoop's request, scoped decision same day): live
      // pattern-matching against his own documented failure history, F1
      // first (trade-count escalation via win count — see
      // mistake-patterns.js's header for why this isn't the same signal as
      // rules.json's tradesPerDay cap). Checked only when the trade count
      // just changed (not every 10s poll), advisory only — fires once per
      // day, persisted so a restart never re-fires it mid-session.
      if (!tvBrokerFeedState.f1AdvisoryFired) {
        const f1 = mistakePatterns.checkTradeCountEscalation(tvBrokerFeedState.trades);
        if (f1.matched) {
          console.log('[mistake-pattern] F1 fired: ' + f1.message);
          tvBrokerFeedState = { ...tvBrokerFeedState, f1AdvisoryFired: true };
          persistTVBrokerFeedState();
          broadcast({ type: 'mistake-pattern', pattern: 'F1', message: f1.message, winCount: f1.winCount });
        }
      }

      // 2026-08-20: F2 (revenge clusters) — second pattern, same advisory-only
      // contract as F1: fires once per IST day, persisted, no enforcement.
      // Deliberately does NOT re-detect the size-up-after-a-loss half of F2's
      // text — that is already a no-override hard stop in size-freeze-guard.js
      // and alerting on it again would just double up. See
      // MISTAKE_PATTERNS_PLAN.md and mistake-patterns.js's F2 header.
      // cooldownMinutes comes from getActiveRules() (mode/stage-aware — 15
      // standard, 5 scalper), never hardcoded here.
      // 2026-08-20 FIX (found in review): the fired-flag is per SUB-SIGNAL,
      // not per pattern. checkRevengeCluster returns either a rapid-reentry or
      // a consecutive-losses match, and a single f2AdvisoryFired meant the
      // lesser one permanently consumed the slot: a fast re-entry at 10:03
      // would silence the "two losses back to back — close the platform"
      // message for the rest of the day, which is the single most serious
      // thing this file can say (4 of his 6 blown accounts). Keyed by kind so
      // each sub-signal still fires at most once per IST day on its own.
      const f2FiredKinds = tvBrokerFeedState.f2FiredKinds || {};
      {
        try {
          const f2 = mistakePatterns.checkRevengeCluster(tvBrokerFeedState.trades, { cooldownMinutes: getActiveRules().cooldownMinutes });
          if (f2.matched && !f2FiredKinds[f2.kind]) {
            console.log(`[mistake-pattern] F2 fired (${f2.kind}): ` + f2.message);
            tvBrokerFeedState = { ...tvBrokerFeedState, f2FiredKinds: { ...f2FiredKinds, [f2.kind]: true } };
            persistTVBrokerFeedState();
            broadcast({ type: 'mistake-pattern', pattern: 'F2', kind: f2.kind, message: f2.message, lossStreak: f2.lossStreak });
          }
        } catch (e) {
          console.log('[mistake-pattern] F2 check failed: ' + e.message);
        }
      }
      // 5.3 (F3 inverted R:R): fires once per IST day, persisted in the feed
      // state so a restart never re-fires mid-session. Advisory only, same
      // contract as F1/F2. Thresholds from rules.json (f3Ratio/f3MinWins).
      if (!tvBrokerFeedState.f3AdvisoryFired) {
        try {
          const activeRules = getActiveRules();
          const f3 = mistakePatterns.checkInvertedRR(tvBrokerFeedState.trades, { f3Ratio: activeRules.f3Ratio, f3MinWins: activeRules.f3MinWins });
          if (f3.matched) {
            console.log('[mistake-pattern] F3 fired: ' + f3.message);
            tvBrokerFeedState = { ...tvBrokerFeedState, f3AdvisoryFired: true };
            persistTVBrokerFeedState();
            broadcast({ type: 'mistake-pattern', pattern: 'F3', message: f3.message, winCount: f3.winCount, lossCount: f3.lossCount, avgWin: f3.avgWin, avgLoss: f3.avgLoss });
          }
        } catch (e) {
          console.log('[mistake-pattern] F3 check failed: ' + e.message);
        }
      }
      // 2026-08-25 (F4 break-even churn). Anoop: "After 5 break even trades, I
      // want you to remind me that there are 5 break even trades."
      //
      // Unlike F1-F3 this RE-ARMS. Those three describe a shape the day has
      // taken on and cannot untake, so firing once is right. Break-even churn
      // is a running count that keeps climbing — telling him at 5 and then
      // going quiet through 10 and 15 would be the app noticing the pattern
      // and deciding not to mention it. It re-fires on each further multiple
      // of the reminder count, so the reminder tracks the number he asked to
      // be reminded of instead of a single moment that has passed.
      try {
        const ar = getActiveRules();
        const f4 = mistakePatterns.checkBreakEvenChurn(tvBrokerFeedState.trades, {
          breakEvenBandUsd: ar.breakEvenBandUsd,
          breakEvenReminderCount: ar.breakEvenReminderCount,
          commissionPerContractPerSide: ar.commissionPerContractPerSide,
        });
        const trip = Number(ar.breakEvenReminderCount) > 0 ? Number(ar.breakEvenReminderCount) : 5;
        // The multiple already announced. Persisted so a restart mid-session
        // does not replay a reminder he has already been given.
        const announced = Number(tvBrokerFeedState.f4AnnouncedAt) || 0;
        const milestone = Math.floor(f4.breakEvenCount / trip) * trip;
        if (f4.matched && milestone > announced) {
          console.log('[mistake-pattern] F4 fired: ' + f4.message);
          tvBrokerFeedState = { ...tvBrokerFeedState, f4AnnouncedAt: milestone };
          persistTVBrokerFeedState();
          broadcast({
            type: 'mistake-pattern', pattern: 'F4', message: f4.message,
            breakEvenCount: f4.breakEvenCount, realCount: f4.realCount,
            totalCount: f4.totalCount, band: f4.band, feesRisked: f4.feesRisked,
          });
        }
      } catch (e) {
        console.log('[mistake-pattern] F4 check failed: ' + e.message);
      }

      // 2026-08-25: HIS OWN armed detectors, evaluated on the same trades and
      // announced on the same channel as F1-F4. The four built-ins are the
      // patterns a developer encoded; these are the ones he encoded, and from
      // here they are the same kind of thing to the rest of the app.
      //
      // ONCE PER DAY PER DETECTOR. Unlike F4 (which he explicitly asked to
      // re-arm on each further multiple), a self-authored condition usually
      // stays true for the rest of the session once it matches — "you are at
      // 60 contracts" does not become false again. Re-announcing it every ten
      // seconds is how an alert channel gets muted, and muting it would cost
      // him F1-F4 as well. The map lives in the feed state, which is already
      // wiped on IST day rollover, so it is day-scoped for free.
      try {
        const fired = tvBrokerFeedState.armedFiredToday || {};
        const hits = armedDetectors.evaluateAll(lessonsLogLoad(), {
          trades: tvBrokerFeedState.trades,
          priorDays: armedPriorDays(10),
        });
        const fresh = hits.filter(h => h.matched && !fired[h.id]);
        // A template that threw is a broken guardrail he believes is watching
        // for him. Say so in the log rather than failing silently.
        hits.filter(h => h.error).forEach(h => {
          console.log('[armed-detector] "' + h.template + '" errored and did NOT check: ' + h.error);
        });
        if (fresh.length) {
          const stamp = {};
          fresh.forEach(h => { stamp[h.id] = true; });
          tvBrokerFeedState = { ...tvBrokerFeedState, armedFiredToday: { ...fired, ...stamp } };
          persistTVBrokerFeedState();
          // Record the fire against the lesson itself. This is what lets the
          // Lessons tab say "armed 3 weeks ago, never fired" instead of
          // implying a coverage it is not providing.
          try {
            const log = mindLogLoad();
            let touched = false;
            fresh.forEach(h => {
              const l = log.find(x => x && x.id === h.id);
              if (l) { l.fireCount = (Number(l.fireCount) || 0) + 1; l.lastFiredAt = Date.now(); touched = true; }
            });
            if (touched) mindLogSave(log);
          } catch (e) {
            console.log('[armed-detector] could not record the fire: ' + e.message);
          }
          fresh.forEach(h => {
            console.log('[armed-detector] fired (' + h.template + '): ' + h.message);
            broadcast({
              type: 'mistake-pattern', pattern: 'LESSON', lessonId: h.id,
              template: h.template, label: h.label, lesson: h.lesson,
              message: h.message + '  \u2014 your own lesson: "' + h.lesson + '"',
            });
          });
        }
      } catch (e) {
        console.log('[armed-detector] evaluation failed: ' + e.message);
      }
    }

    // Phase 2a shadow-mode (2026-08-17, see PHASE2_SEMI_AUTONOMOUS_SPEC.md):
    // logs what the trade-confirm rule-check WOULD decide for a hypothetical
    // next trade at rules.json's sizeCap, against real live-feed state, every
    // poll. Nothing reads this decision, nothing calls placeMarketOrder with
    // it — purely observational, so its behavior can be validated against a
    // real trading day before Phase 2b ever wires it to anything that acts.
    try {
      const activeRules = getActiveRules();
      const shadowCheck = tradeConfirmRules.checkTradeAllowed(activeRules, currentMode, tvBrokerFeedState.trades, activeRules.sizeCap);
      if (!shadowCheck.allowed) {
        console.log(`[trade-confirm-shadow] would BLOCK a ${activeRules.sizeCap}-size trade right now: ${shadowCheck.reason}`);
      }
    } catch (e) {
      console.warn('[trade-confirm-shadow] evaluation failed:', e.message);
    }

    // 2026-08-19 (SEMI_AUTONOMOUS_SYSTEM_PLAN.md item 3, trade-count leg):
    // fold()'s tradeCount comes from INFERRED flat-transitions/balance deltas
    // — the same inference logic that missed 3 real trades before the
    // 2026-08-18 fixes. The orders table's own Filled-status rows are a
    // separate, independent, literal count straight from the broker, so
    // comparing them catches a future regression in the fold logic the same
    // way the balance-delta reconciliation already catches drift there.
    // VISIBILITY ONLY per this task's instruction — s.live.tradeCount / the
    // fold's enforcement path are deliberately NOT changed here.
    // 2026-08-20 FIX — this comparison was between two different UNITS.
    // It used `filled.length` (ORDER ROWS) against the fold's tradeCount
    // (ROUND TRIPS). A round trip is at minimum two orders, and the broker
    // splits both scale-ins and exits across many rows — 2026-08-20's own
    // data has one round trip made of seven order rows (six Sell 2 entries
    // at 14:42:47, one Buy 12 exit at 14:43:14). So the banner fired on
    // every normal trading day and read "broker 16 vs tracked 9" when the
    // truth was neither number. The old comment below called this out as an
    // "honest caveat" and shipped anyway; a reconciliation that cries wolf
    // daily trains you to ignore the one time it is real, so it is now a
    // like-for-like comparison: round trips vs round trips, both derived
    // independently (order-history walk vs balance-delta fold).
    const brokerRoundTripCount = closedRoundTripsToday;
    const brokerFilledCount = filled.length; // diagnostics only — NOT the comparison
    const foldTradeCount = effCount.value;
    // ordersTableSuspect (above): don't compare a known-stale orders read
    // against the fold's count — that would be comparing real data to a
    // table that hasn't rendered yet, guaranteed to look like a mismatch.
    const tradeCountMismatch = brokerRoundTripCount !== null && brokerRoundTripCount !== foldTradeCount;

    broadcast({
      type: 'tv-broker-account',
      success: true,
      summary: result.summary,
      positions: result.positions,
      orders: result.orders,
      newFillCount: newFills.length,
      connected: true,
      tradeCountMismatch,
      ordersTableSuspect,
      brokerRoundTripCount,
      brokerFilledCount,
      foldTradeCount,
      // 2026-08-21 (D2): provenance of the count the guardrail enforces on.
      // 'verified'  = every trade scored with order-history corroboration.
      // 'degraded'  = at least one was scored on the fill edge alone, the
      //               rule that produced 9/3 — count is provisional and the
      //               tradesPerDay cap is advisory, not a hard lock.
      countEvidence: effCount.evidence,
      degradedTradeCount: effCount.degraded,
      // 2026-09-02: the two halves of the max(), so the UI can say WHY a count
      // is provisional instead of only that it is. A lockout he cannot audit is
      // a lockout he will work around.
      corroboratedTradeCount: effCount.corroborated,
      walkTradeCount: effCount.walkCount,
      walkCountStale: effCount.walkStale,
      feedDegraded: closedRoundTripsToday === null,
      // 2026-08-24: `tradeCount` and `dayPnl` keep their names and their
      // place in this message — every existing consumer reads them — but they
      // now carry the AUTHORITATIVE values rather than the raw fold's. The
      // raw fold numbers travel alongside under explicit names so a
      // disagreement stays visible instead of being quietly replaced.
      tradeCount: effCount.value,
      dayPnl: effPnl.value,
      dayPnlSource: effPnl.source,
      dayPnlRealized: effPnl.realized,
      dayPnlOpen: effPnl.open,
      dayPnlStale: effPnl.stale,
      foldDayPnl: effPnl.foldValue,
      foldDayPnlDrift: effPnl.drift,
      foldTradeCountRaw: effCount.rawFoldCount,
      maxSize: tvBrokerFeedState.maxSize,
      lastLossTs: tvBrokerFeedState.lastLossTs,
      trades: tvBrokerFeedState.trades
    });
  } catch (e) {
    console.warn('[tv-broker] poll failed:', e.message);
  }
}
function startTVBrokerMonitor() {
  if (tvBrokerMonitorTimer) clearInterval(tvBrokerMonitorTimer);
  tvBrokerMonitorTimer = setInterval(pollTVBrokerAccount, TV_BROKER_POLL_MS);
  pollTVBrokerAccount(); // don't make the client wait a full cycle for the first read
}
function stopTVBrokerMonitor() {
  if (tvBrokerMonitorTimer) { clearInterval(tvBrokerMonitorTimer); tvBrokerMonitorTimer = null; }
}

// ── The fast open/close tick (2026-08-20) ──────────────────────────────────
// See TV_POSITION_WATCH_MS for why this exists alongside the 10s full poll.
// Contract: detect the transition, announce it, and hand off to the fold.
// It deliberately does NOT compute P&L or touch tradeCount — tv-broker-feed's
// balance-delta fold stays the single source of truth for both. A second
// thing that also counts trades is precisely how the 2026-08-20 over-counting
// bug happened, and this one runs twice as often.
// T1.1 — per-trade max-loss tripwire. Reads the net open position's unrealised
// P&L and, when it breaches rules.perTradeMaxLoss, alarms AND flattens (under
// LIVE ORDERS). The decision is pure (per-trade-stop.js shouldStopOut); this is
// the wiring, mirroring enforceOversizeGuard's read/flatten shape. A blind read
// (P&L unreadable) alarms loudly — never silent — because a blind stop is what
// killed 3 September.
function readUnrealisedPnl(rows) {
  // 'profit' FIRST: this broker's positions table names its per-position P&L column exactly
  // that (measured 2026-09-15). The older key list never matched it, so the per-trade stop was
  // reading no figure at all from the live table.
  const names = ['profit', 'p/l', 'p&l', 'unrealized pnl', 'unrealized p&l', 'unrealized', 'unrealised pnl', 'unrealised', 'unrealized profit/loss', 'open pnl', 'net pnl', 'pnl', 'profit/loss'];
  let total = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const keys = Object.keys(row);
    for (const want of names) {
      const hit = keys.find((k) => k.trim().toLowerCase() === want);
      if (hit !== undefined && row[hit] !== '' && row[hit] != null) {
        // G32: sign-aware — a unicode-minus loss used to parse as a PROFIT here.
        const n = positionProtection.parseMoney(row[hit]);
        if (Number.isFinite(n)) { total = (total == null ? 0 : total) + n; break; }
      }
    }
  }
  return total;
}

// 2026-09-04 (Claude review) — the latch is per POSITION, not per day, and
// breach and blind have SEPARATE shots.
//
// It was `{ dayKey, fired }` with one shot for the whole trading day and no
// reset anywhere. Replayed against the real record that cost $1,418 and turned
// this guard from +$910 into -$508, because of what it does to 2026-09-03:
//
//   trade 4   4c    -$526   breaches the cap -> guard fires, shot used
//   trade 5  15c     -$61
//   trade 6  20c  -$1,718   guard already spent -> UNPROTECTED
//
// The 20-lot that killed the account walked past a guard a smaller loss two
// trades earlier had already switched off. A stop that protects one trade a day
// is not a stop.
//
// The blind shot is separate for the same class of reason: a "P&L unreadable"
// alarm at 09:00 must not disarm the breach stop for the rest of the session.
// That is precisely the 2026-09-03 shape — the guard present, blind, and silent.
//
// Identity is symbol+side, so adding to a position does not re-arm it (one
// flatten attempt per position, which was the original intent and is kept), but
// a NEW position always starts protected.
let perTradeStopState = { key: null, breachFired: false, blindFired: false };
const PER_TRADE_STOP_CLEAR = { key: null, breachFired: false, blindFired: false };

function enforcePerTradeStop(rows) {
  const rules = getActiveRules();
  const cap = Number(rules.perTradeMaxLoss);
  if (!Number.isFinite(cap) || cap <= 0) return; // no cap → nothing to enforce

  const pos = oversizeGuard.netPosition(rows);
  const size = pos ? Number(pos.size) : 0;
  if (!Number.isFinite(size) || size === 0) {
    // Flat: the position this latch was holding is closed, so the next one
    // starts protected. This reset is the fix — without it the guard fired once
    // and stayed spent for the rest of the day.
    perTradeStopState = Object.assign({}, PER_TRADE_STOP_CLEAR);
    return;
  }

  const unrealised = readUnrealisedPnl(rows);
  const verdict = perTradeStop.shouldStopOut({ unrealisedUsd: unrealised, perTradeMaxLoss: cap, size });
  if (verdict.stop === false) return;

  const blind = verdict.stop === null;
  const posKey = String((pos && pos.symbol) || '?') + '|' + String((pos && pos.side) || '?');
  // A different position than the one the latch is holding re-arms both shots.
  if (perTradeStopState.key !== posKey) {
    perTradeStopState = { key: posKey, breachFired: false, blindFired: false };
  }
  if (blind) {
    if (perTradeStopState.blindFired) return;   // one blind alarm per position
    perTradeStopState.blindFired = true;
  } else {
    if (perTradeStopState.breachFired) return;  // one flatten attempt per position
    perTradeStopState.breachFired = true;
  }

  const side = pos && pos.side;
  const closingSide = side === 'long' ? 'sell' : (side === 'short' ? 'buy' : null);
  const canAct = process.env.TV_ALLOW_LIVE_ORDERS === '1';

  broadcast({
    type: 'per-trade-stop',
    level: blind ? 'blind' : 'breach',
    unrealised, cap, size,
    symbol: pos && pos.symbol,
    canAct,
    message: blind
      ? 'PER-TRADE STOP — unrealised P&L UNREADABLE, cannot verify the -$' + cap + ' cap (blind)'
      : 'PER-TRADE STOP — unrealised $' + (unrealised != null ? unrealised.toFixed(0) : '?') + ' breaches -$' + cap + ' on ' + size + ' lots — FLATTENING',
  });

  if (!blind && canAct && closingSide && pos.symbol) {
    (async () => {
      try {
        // T1.3: routed through the one gateway. kind 'flatten' is risk-reducing,
        // so the trading rules cannot block it — a day-stop must never trap an
        // open position.
        const res = await placeMarketOrder({ kind: 'flatten', side: closingSide, qty: size, symbol: pos.symbol });
        console.log('[per-trade-stop] FLATTEN ' + closingSide + ' ' + size + ' ' + pos.symbol + ': ' + (res.ok ? 'SUBMITTED' : (res.refused ? 'REFUSED — ' + res.reason : 'FAILED')));
      } catch (e) {
        console.warn('[per-trade-stop] flatten failed:', e.message);
      }
    })();
  }
}

// ── G32 (2026-09-15): APP-SIDE PROTECTION — close at -stop / +target ────────
// Anoop: "i think app-side protection is better". The rule is his (rules.json
// autoProtection: stopLossUsd 200, takeProfitUsd 600); the broker-side bracket has no
// route on this build (G31). This closes the trade instead, through the same gateway the
// per-trade stop uses, on the SAME read that proves the positions panel is readable.
//
// Deliberately a SIBLING of enforcePerTradeStop rather than folded into it: the two answer
// different questions (-200 here versus the -300 backstop) and each keeps its own latch, so
// a failure in one cannot disarm the other. Flat resets the latch, so a NEW position always
// starts protected - the 2026-09-03 lesson, where a one-shot-per-day latch left a 20-lot
// unprotected.
//
// The honest limitation, stated here because it is the whole reason a bracket would be
// better: this only protects while the app is awake.
let positionProtectionState = { key: null, attempted: false, blindFired: false };
function enforcePositionProtection(rows) {
  const rules = getActiveRules();
  const ap = rules.autoProtection || {};
  if (ap.enabled === false) return;
  const pos = oversizeGuard.netPosition(rows);
  const size = pos ? Number(pos.size) : 0;
  if (!Number.isFinite(size) || size === 0) {
    positionProtectionState = { key: null, attempted: false, blindFired: false };
    return;
  }
  const posKey = String((pos && pos.symbol) || '?') + '|' + String((pos && pos.side) || '?');
  if (positionProtectionState.key !== posKey) {
    positionProtectionState = { key: posKey, attempted: false, blindFired: false };
  }
  let pointValue = null;
  try { pointValue = tradeProtection.pointValueForSymbol(rules, pos && pos.symbol); } catch (e) { pointValue = null; }
  const verdict = positionProtection.decide({
    side: pos && pos.side,
    size,
    entryPrice: readEntryPrice(rows, pos && pos.symbol),
    unrealisedUsd: readUnrealisedPnl(rows),
    pointValue,
    stopLossUsd: ap.stopLossUsd,
    takeProfitUsd: ap.takeProfitUsd,
    enabled: ap.enabled !== false,
    alreadyAttempted: positionProtectionState.attempted,
  });
  if (verdict.action === 'none') return;

  const side = pos && pos.side;
  const closingSide = side === 'long' ? 'sell' : (side === 'short' ? 'buy' : null);
  const canAct = process.env.TV_ALLOW_LIVE_ORDERS === '1';

  if (verdict.action === 'blind') {
    if (positionProtectionState.blindFired) return;
    positionProtectionState.blindFired = true;
    console.warn('[position-protection] BLIND — ' + verdict.reason);
    broadcast({ type: 'position-protection', level: 'blind', reason: verdict.reason, size, symbol: pos && pos.symbol, canAct,
      message: 'PROTECTION BLIND — ' + verdict.reason + '. The -$' + ap.stopLossUsd + ' / +$' + ap.takeProfitUsd + ' band cannot be enforced right now.' });
    return;
  }

  // verdict.action === 'close'
  positionProtectionState.attempted = true;
  const isTarget = /^TARGET/.test(verdict.reason);
  const level = isTarget ? 'target' : 'stop';
  console.log('[position-protection] ' + level.toUpperCase() + ' on ' + size + ' ' + (pos && pos.symbol) + ' at ' + verdict.unrealisedUsd + ' — ' + verdict.reason);
  broadcast({ type: 'position-protection', level, unrealised: verdict.unrealisedUsd, size, symbol: pos && pos.symbol, canAct, reason: verdict.reason,
    message: (isTarget ? 'PROTECTION TARGET' : 'PROTECTION STOP') + ' — ' + (verdict.unrealisedUsd != null ? verdict.unrealisedUsd.toFixed(0) : '?') + ' on ' + size + ' lots' + (canAct ? ' — CLOSING' : ' — ALARM ONLY (live orders off)') });
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'protocols', 'position-protection.jsonl'), JSON.stringify({
      at: new Date().toISOString(), day: dayRollup.tradingDayKey(Date.now()),
      level, observed: { size, symbol: pos && pos.symbol, side }, unrealised: verdict.unrealisedUsd,
      reason: verdict.reason, canAct, submitted: false,
    }) + '\n');
  } catch (e) { /* logging must never break the guard */ }

  if (canAct && closingSide && pos && pos.symbol) {
    (async () => {
      try {
        const res = await placeMarketOrder({ kind: 'flatten', side: closingSide, qty: size, symbol: pos.symbol });
        console.log('[position-protection] CLOSE ' + closingSide + ' ' + size + ' ' + pos.symbol + ': ' + (res && res.ok ? 'SUBMITTED' : (res && res.refused ? 'REFUSED' : 'FAILED')));
      } catch (e) { console.warn('[position-protection] close failed:', e.message); }
    })();
  }
}

// Entry price for a symbol from the broker rows — the price fallback for the band when the
// broker's own unrealised figure is missing. Returns null rather than a guess, so the guard
// reports BLIND instead of enforcing against an invented entry.
function readEntryPrice(rows, symbol) {
  const want = String(symbol || '').toUpperCase();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const sym = String(row.Symbol || row.symbol || '').toUpperCase();
    if (want && sym && sym.indexOf(want) === -1 && want.indexOf(sym) === -1) continue;
    const key = Object.keys(row).find((k) => /avg\.? ?fill price/i.test(k));
    if (!key) continue;
    const n = Number(String(row[key]).replace(/[^0-9.\-]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function pollTVPositions() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) return;
  // A slow CDP read must not stack ticks on top of each other — at 5s with a
  // shared broker lock, overlapping reads would queue behind one another and
  // report a stale transition late rather than the current one on time.
  if (tvPositionWatchInFlight) return;
  tvPositionWatchInFlight = true;
  try {
    // ── THE FAST LANE (2026-09-02) ────────────────────────────────────────
    // This is the read the OVERSIZE GUARD acts on, and the guard's entire
    // safety model assumes it is current. On the shared FIFO lock it was not:
    // measured broker-lock depth reached 7, so a 5s cadence became an effective
    // 20-30s while panel repairs, account polls and table refreshes were served
    // first. On 2026-09-02 he reached 16 contracts against a cap of 2 and the
    // app recorded a peak of 4 — the reads that would have caught it were in
    // the queue.
    //
    // High priority does NOT preempt whatever is running (never cut an order
    // placement in half) and is bounded by priority-lock.js's anti-starvation
    // rule, so it cannot push the ACCOUNT POLL back indefinitely — a starved
    // account poll trades a stale guard for a missing trade record, which is
    // not a trade worth making.
    // 6s, not the lock's 30s default. This read's answer is worthless after ~5s
    // because the next one is already due, so a hung one spending 30s achieves
    // nothing except keeping the guard's view stale for 30 seconds. Abandon it
    // early and let the fresher read through. Anoop asked on 2026-09-02 whether
    // to drop the GLOBAL timeout to 5-10s; that would cut short chart timeframe
    // switches, which legitimately take 8-15s and can leave the chart on the
    // wrong timeframe if aborted. The budget belongs per caller, not per lock.
      // 2026-09-08 REVERTED: a 5s forced broker-tab refresh caused visible flicker.
      // The original read is restored below to avoid tab interruptions.
      
      
      
    const raw = await withBrokerLock(() => mcpBridge.callTool('trading_get_positions', {}, POSITION_READ_TIMEOUT_MS),
      { priority: 'high', timeoutMs: POSITION_READ_TIMEOUT_MS });
    const text = (raw && raw.content) ? raw.content.map(c => c.text || '').join('') : null;
    const result = text ? JSON.parse(text) : null;
    // An unreadable panel is NOT "flat" — treating a failed read as zero
    // positions would fire a phantom `closed` for every open trade the moment
    // TradingView hiccups, and (once wired to the session log) write a
    // phantom row for it. Leave the baseline untouched and wait.
    // 2026-09-02: this used to be a bare `return`. An unreadable positions
    // table is the one failure that makes the oversize guard silently useless
    // — it looks IDENTICAL to a flat account — and nothing anywhere said so.
    // It now alarms after OVERSIZE_BLIND_READS_ALARM consecutive failures.
    if (!result || !result.success || !Array.isArray(result.positions)) {
      noteOversizePositionRead(null);
      return;
    }

    const rendered = Array.isArray(result.positions)
        && (result.positions.length > 0 || !!result.emptyStateText);
      if (!rendered) {
        noteOversizePositionRead(null);
        return;
      }
      const rows = result.positions;
    noteOversizePositionRead(rows);
    // OVERSIZE GUARD — runs on the SAME read that proves the panel is
    // readable, so it can never act on a failed read (the guard clause above
    // has already returned). See oversize-guard.js for the safety model.
    try { enforceOversizeGuard(rows); } catch (e) { console.warn('[oversize] guard threw:', e.message); }
    try { enforcePerTradeStop(rows); } catch (e) { console.warn('[per-trade-stop] guard threw:', e.message); }
    // G32: app-side -200 / +600 protection, same verified read, its own latch.
    try { enforcePositionProtection(rows); } catch (e) { console.warn('[position-protection] guard threw:', e.message); }

    const events = positionEvents.diffPositions(tvLastPositions, rows);
    tvLastPositions = rows;
    if (!events.length) return;

    for (const e of events) {
      console.log('[tv-position] ' + positionEvents.describeEvent(e));
      // Remember the side that is/was on, for the session-log row the fold
      // writes (the fold itself never records side).
      //
      // 2026-08-21 BUG FIX (found in today's real trade — the first close on
      // the fixed code): this used to record the side ONLY on a `closed`
      // event, which loses a race it cannot win. The 10s account poll and
      // this 5s watch both see the close, and whichever lands first wins:
      // today the fold scored the trade at 07:27:19.821 and this watch
      // reported CLOSED at 07:27:21.900 — two seconds LATER. So the
      // auto-logged session row was written before any side was known and
      // recorded direction as '?', for a trade whose side had been sitting
      // in an `opened` event since 07:19:56.
      //
      // Recording on open/scale/flip too means the side is already known
      // long before the close, regardless of which poller gets there first.
      // A `closed` event still overwrites with the same value, so nothing is
      // lost — this only removes the dependency on winning a race.
      if (e.side && (e.kind === 'opened' || e.kind === 'scaled' || e.kind === 'flipped' || e.kind === 'closed')) {
        tvLastClosedSide[e.symbol] = e.side;
        tvLastClosedSide.__any = e.side;
      }
    }
    // Push the transition immediately, before the (slower) full account read
    // — this is the whole point of the fast tick. The client updates the HUD
    // from this, then reconciles against the authoritative numbers when the
    // tv-broker-account broadcast lands a moment later.
    broadcast({
      type: 'position-event',
      events: events.map(e => ({ ...e, text: positionEvents.describeEvent(e) })),
      at: Date.now(),
    });
    // 7.3: feed the glance surface. describeEvent() is the same text the HUD
    // shows, so the two can never disagree. Only transitions reach here (the
    // watch emits nothing when nothing changed), so this is a handful of lines
    // per session, not one per 5s tick.
    for (const e of events) {
      try { recordLiveEvent('position', 'POSITION', positionEvents.describeEvent(e)); } catch (_) {}
    }

    // D4 (2026-08-21): skip ONLY this hand-off while an order is mid-placement.
    // The orders table is being rewritten at that moment, so a full account
    // read can catch it half-rendered, fail the walk-vs-positions cross-check
    // and drop the feed into degraded mode during the single most safety-
    // critical operation the app performs. The 10s timer picks it up moments
    // later, once the table has settled. The lightweight positions read above
    // is unaffected and still reports the fill immediately.
    if (tvOrderPlacementInFlight) {
      console.log('[tv-position] order placement in flight — deferring the full account read to the next scheduled poll (orders table is mid-rewrite).');
      return;
    }
    // Hand off to the authoritative path in the same beat rather than waiting
    // out the rest of the 10s cycle. On a CLOSE this is what actually folds
    // the realized P&L, increments the trade count, runs the mistake-pattern
    // checks and (below) writes the session-log row.
    await pollTVBrokerAccount();
  } catch (e) {
    console.warn('[tv-position] watch failed:', e.message);
  } finally {
    tvPositionWatchInFlight = false;
  }
}

function startTVPositionWatch() {
  if (tvPositionWatchTimer) clearInterval(tvPositionWatchTimer);
  tvPositionWatchTimer = setInterval(pollTVPositions, TV_POSITION_WATCH_MS);
  pollTVPositions(); // establishes the baseline; emits nothing by design
}
function stopTVPositionWatch() {
  if (tvPositionWatchTimer) { clearInterval(tvPositionWatchTimer); tvPositionWatchTimer = null; }
  // Drop the baseline too: on the next start, the first read must be treated
  // as a fresh baseline rather than diffed against a snapshot from before the
  // gap, which would report every change made in between as if it just
  // happened, all at once.
  tvLastPositions = null;
}

// ── Startup/reconnect self-test (2026-08-19, SEMI_AUTONOMOUS_SYSTEM_PLAN.md item 2) ──
// "The app opened" and "the live feed actually works" are different facts —
// this makes the second one a stated result instead of something Anoop has to
// squint at 3 screens to guess. Named 4-link in the plan doc but is really 3
// checks: CDP was already covered live by the existing mcp-status indicator,
// so this only re-derives it (cheap, no extra call) rather than re-testing it.
let liveFeedSelfTestTimer = null;
async function runLiveFeedSelfTest() {
  const failures = [];
  let passed = 0;
  const total = 5;
  // 2026-08-23: per-step results, so the UI can show three NAMED lines with
  // their own pass/fail instead of one collapsed string. Anoop asked for the
  // 3-step check to be visible in the app; a single sentence that says '2/3'
  // does not tell him WHICH leg is down or what to do about it.
  const checks = [
    { key: 'cdp',    label: 'TradingView connection', ok: false, detail: '' },
    { key: 'broker', label: 'Broker panel / live feed', ok: false, detail: '' },
    { key: 'quote',  label: 'Live price data',        ok: false, detail: '' },
    // 2026-09-05 (Anoop: "the whole tab forensics should also be part of
    // startup protocol to check"). Two facts in one line: can the Forensics
    // payload be BUILT at all, and does the 1m archive it measures from exist.
    { key: 'forensics', label: 'Trade forensics',     ok: false, detail: '' },
    // 2026-09-08 (Anoop: "the size guard did not do its job ... it is also part
    // of the protocol to check but still it did not do its job"). The protocol
    // DID check the guard was armed. Armed was never the question.
    { key: 'sizeguard', label: 'Size guard can act',  ok: false, detail: '' },
  ];

  // Check 1: CDP reachable — already tracked continuously by mcpBridge, this
  // just folds it into the same PASS/FAIL report rather than re-probing.
  if (mcpBridge.ready && mcpBridge.tvConnected) {
    passed++;
    checks[0].ok = true;
    checks[0].detail = 'CDP connected on :9222';
  } else {
    failures.push('CDP: TradingView chart connection not established');
    checks[0].detail = 'not connected — is TradingView Desktop running?';
  }

  // Check 2: broker panel readable — reuses getAccount()'s degraded/unreadable
  // fields (trading.js) via the same trading_get_account call pollTVBrokerAccount
  // already makes, routed through the same withBrokerLock (2026-08-19: split
  // from withChartLock — see that split's header comment) so this can't race
  // a concurrent poll or order placement, without also queuing behind
  // unrelated chart-timeframe-switch monitor activity.
  try {
    const raw = await withBrokerLock(() => mcpBridge.callTool('trading_get_account', {}));
    const text = (raw && raw.content) ? raw.content.map(c => c.text || '').join('') : null;
    const result = text ? JSON.parse(text) : null;
    let positionsOk = !!(result && result.positions && result.positions.success);
      // 2026-09-08 (G2): "readable" must mean RENDERED for positions too.
      // A mounted-but-hidden Positions table returns success:true with zero rows
      // and no emptyStateText — indistinguishable from flat except by this test.
      const positionsRows = (result && result.positions && result.positions.positions || []).length;
      const positionsEmptyState = !!(result && result.positions && result.positions.emptyStateText);
      const positionsRendered = positionsOk && (positionsRows > 0 || positionsEmptyState);
      positionsOk = positionsRendered;
    // ── "READABLE" HAS TO MEAN RENDERED (2026-09-02) ────────────────────────
    // `orders.success` is `t.found` — the <table> exists in the DOM. It is TRUE
    // for a table with an empty <tbody>, which is exactly the shape ka-table
    // leaves behind when the Orders tab is not the one showing.
    //
    // THIS IS WHY THE FAULT KEPT COMING BACK. On 2026-09-01 and 2026-09-02 this
    // check printed "positions, orders and summary tables all readable" and the
    // titlebar showed 3/3 PASSED, while: the order-history walk was dropped on
    // every poll, every close was recorded from the balance-delta fold with
    // xp:null, the trade count came from balance moves instead of round trips,
    // the drift panel sat on a two-day-old exit price, and the oversize guard
    // reported STUCK against a positions table that was not repainting. Four
    // separate symptoms, one cause, and the detector that exists to name it
    // said everything was fine — so each symptom got patched on its own and the
    // cause was never addressed.
    //
    // A position cannot exist without a filled order that created it. So
    // "orders empty while a position is open" is not a state the broker can
    // actually be in; it is proof the table has not rendered. That is now a
    // FAILED check with its own name, and the repair below has a real trigger.
    const ordersFound = !!(result && result.orders && result.orders.success);
    const openCount = (result && result.positions && result.positions.positions || []).length;
    const orderRows = (result && result.orders && result.orders.orders || []).length;
    const ordersEmptyState = !!(result && result.orders && result.orders.emptyStateText);
    const ordersRendered = orderRows > 0 || ordersEmptyState || openCount === 0;
    const ordersOk = ordersFound && ordersRendered;
    const summaryOk = !!(result && result.summary && result.summary.success);
    if (result && result.success && positionsOk && ordersOk && summaryOk) {
      passed++;
      checks[1].ok = true;
      checks[1].detail = 'positions, orders and summary tables all readable'
        + (openCount > 0 ? ' (orders showing ' + orderRows + ' row(s) against an open position)' : '');
    } else if (result && result.success && positionsOk && summaryOk && ordersFound && !ordersRendered) {
      // Named separately from "table missing", because the operator response is
      // different and because a generic failure here is what let this hide.
      const why = 'Orders table is MOUNTED BUT RENDERING NO ROWS while ' + openCount
        + ' position(s) are open — a position cannot exist without a filled order, so the table has not repainted.'
        + ' Trade prices, the trade count and the exit-drift anchor all come from it. Auto-repair will re-render it;'
        + ' if this persists, click the Orders tab in the broker panel once.';
      failures.push('Broker panel: ' + why);
      checks[1].detail = why;
    } else {
      // 2026-08-23: don't just REPORT an unreadable panel - repair it. This
      // is the failure that took the live feed down for a whole session, and
      // the cause is almost always a tab TradingView has not rendered yet.
      // getAccount() self-heals on its own read path too; doing it here as
      // well means the visible 3-step check actively fixes the box it is
      // about to mark red, rather than telling Anoop to go clicking.
      let healed = false;
      try {
        const fixRaw = await withBrokerLock(() => mcpBridge.callTool('trading_ensure_panel_ready', {}));
        const fixText = (fixRaw && fixRaw.content) ? fixRaw.content.map(c => c.text || '').join('') : null;
        const fixed = fixText ? JSON.parse(fixText) : null;
        if (fixed && fixed.success) {
          const reRaw = await withBrokerLock(() => mcpBridge.callTool('trading_get_account', {}));
          const reText = (reRaw && reRaw.content) ? reRaw.content.map(c => c.text || '').join('') : null;
          const re = reText ? JSON.parse(reText) : null;
          if (re && re.positions && re.positions.success && re.orders && re.orders.success) {
            healed = true;
            passed++;
            checks[1].ok = true;
            // Say WHICH repair happened. "the bottom panel was collapsed" is
            // actionable; "mounted: panel tabs" taught nobody anything.
            const wasCollapsed = !!(fixed.panelBefore && fixed.panelBefore.collapsed);
            const mounted = (fixed.recovered || []).join(', ');
            checks[1].detail = wasCollapsed
              ? 'repaired automatically - the broker panel at the bottom of TradingView was collapsed, so its tables were not rendered. Re-opened it; leave it open.'
              : 'repaired automatically' + (mounted ? ' (mounted: ' + mounted + ')' : '');
            console.log('[self-test] broker panel repaired automatically');
          }
        }
      } catch (e) {
        console.warn('[self-test] panel repair attempt threw:', e.message);
      }
      if (!healed) {
        const unreadable = (result && result.unreadable) ||
          ['positions', 'orders', 'summary'].filter((k, i) => ![positionsOk, ordersOk, summaryOk][i]);
        // When ALL THREE read unreadable at once, that is the signature of a
        // broker panel that has been collapsed since TradingView launched —
        // its tables are never rendered, so there is nothing to read. Name
        // that case explicitly instead of listing three symptoms.
        const allThree = unreadable.length >= 3;
        const why = allThree
          ? 'all broker tables missing - the panel at the BOTTOM of the TradingView window is closed. Click the "Tradovate" tab on the bottom bar to open it, and leave it open. Auto-repair could not do it.'
          : 'unreadable: ' + (unreadable.join(', ') || 'unknown reason') + ' - auto-repair failed. Open the broker panel at the bottom of TradingView.';
        failures.push('Broker panel: ' + why);
        checks[1].detail = why;
      }
    }
  } catch (e) {
    failures.push('Broker panel: check threw — ' + e.message);
  }

  // Check 3: synthetic fresh-quote check — a quote_get that returns real,
  // non-error, non-stale data proves the chart itself (not just the broker
  // panel) is actually alive and rendering current bars, not frozen/blank.
  try {
    const raw = await withBrokerLock(() => mcpBridge.callTool('quote_get', {}));
    const text = (raw && raw.content) ? raw.content.map(c => c.text || '').join('') : null;
    const result = text ? JSON.parse(text) : null;
    const hasPrice = !!(result && result.success && (typeof result.last === 'number' || typeof result.close === 'number'));
    if (hasPrice) {
      passed++;
      checks[2].ok = true;
      const px = (typeof result.last === 'number') ? result.last : result.close;
      checks[2].detail = 'last price ' + px;
    } else {
      const why = (result && result.error) || 'no readable price returned (chart may be loading/blank)';
      failures.push('Quote: ' + why);
      checks[2].detail = why;
    }
  } catch (e) {
    failures.push('Quote: check threw — ' + e.message);
    checks[2].detail = 'check threw — ' + e.message;
  }

  // POINT-VALUE CROSS-CHECK (2026-08-23). Not a fourth step — deliberately
  // kept out of the 3-step UI, which is about whether the feed is READING.
  // This is about whether the number every P&L figure is multiplied by is
  // still right. Silent on a match; loud only on a real disagreement.
  //
  // Advisory by design: a mismatch never rewrites the multiplier the fold
  // uses. Quietly switching the constant behind day P&L, the loss tiers and
  // payout consistency — on the strength of a metadata field nothing has
  // validated — is exactly the silent corruption this system refuses
  // everywhere else. It reports; a human decides.
  try {
    const raw = await withBrokerLock(() => mcpBridge.callTool('symbol_info', {}));
    const text = (raw && raw.content) ? raw.content.map(c => c.text || '').join('') : null;
    const info = text ? JSON.parse(text) : null;
    if (info && info.success) {
      const sym = info.symbol || null;
      const verdict = pointValueVerify.verifyPointValue(sym, tvBrokerFeed.pointValueFor(sym), info);
      if (verdict.status === 'mismatch') {
        console.error('[point-value] ' + verdict.message);
        broadcast({ type: 'point-value-warning', ...verdict });
      } else if (verdict.message) {
        console.log('[point-value] ' + verdict.message);
      }
    }
  } catch (e) {
    // Never let a diagnostic take the self-test down.
    console.warn('[point-value] cross-check unavailable:', e.message);
  }

  // ── Check 4: trade forensics (2026-09-05) ────────────────────────────────
  // Two DIFFERENT failures, deliberately in one check because either one makes
  // the Forensics tab a lie rather than a blank:
  //
  //   1. The payload cannot be built — a broken module or a corrupt
  //      day_trades.json. The tab would show an error he has to open it to see.
  //   2. The 1m bar archive does not exist AT ALL. Every MAE/MFE is measured
  //      against it, so with no archive the tab is permanently em-dashes while
  //      looking perfectly healthy. That is exactly what happened on 2026-09-05:
  //      the 1m poll's fetch is wrapped in `.catch(() => {})`, so a fetch that
  //      fails every time is indistinguishable from one that never runs.
  //
  // The archive test is "the directory exists", not "it has today's bars" —
  // a weekend or a holiday must not fail the check, but a poll that has never
  // once succeeded must.
  try {
    const fslot = jessiBucketKey(loadConfig());
    const fstore = (fslot ? dataLoad('day_trades__' + fslot) : null) || {};
    const frules = getActiveRules() || {};
    const frep = forensicsReport.buildForensicsReport(fstore, {
      slot: fslot,
      sessionWindowsIST: frules.sessionWindowsIST || [],
      isReentryWindowMin: frules.isReentryWindowMin,
    });
    const oneMinDir = path.join(DATA_DIR, 'bars', 'archive', 'MNQ', '1');
    const haveArchive = fs.existsSync(oneMinDir) && fs.readdirSync(oneMinDir).some((f) => f.endsWith('.jsonl'));
    const cov = frep.coverage;
    if (!haveArchive) {
      failures.push('Forensics: the 1m bar archive is empty — MAE/MFE cannot be measured for any trade');
      checks[3].detail = 'payload builds (' + cov.trades + ' trades) but DATA/bars/archive/MNQ/1 has no bars yet — '
        + 'the 1m poll has never succeeded, so every MAE/MFE stays blank';
    } else {
      passed++;
      checks[3].ok = true;
      checks[3].detail = cov.withMaeMfe + '/' + cov.trades + ' trades measured'
        + (cov.withMaeMfe === 0 ? ' — archive exists but has not covered a trade yet' : '');
    }
  } catch (e) {
    failures.push('Forensics: payload failed to build — ' + e.message);
    checks[3].detail = 'build error: ' + e.message;
  }

  // ── Check 5: the size guard can actually ACT (2026-09-08) ────────────────
  // The old protocol asked "is the guard armed?" and the answer was yes on the
  // day it let 8, 10, 12 and 20 lots through against a cap of 4. Armed was
  // true. Able was not: every reduce threw `side control button not found`
  // because TradingView's order ticket was not rendered, and the badge went on
  // saying ARMED because a failed action changed nothing a human could see.
  //
  // So this check asks the question that was actually load-bearing — CAN IT
  // ACT — and it is deliberately three different failures, because each one
  // ends with size unenforced:
  //   - turned off / disabled outright
  //   - alarm-only (no live-order launcher) — it will shout and nothing else
  //   - it TRIED and the order did not go (the 2026-09-08 case)
  try {
    const gs = oversizeGuardStatus();
    if (gs.mode === 'failed') {
      const f = gs.lastActionFailed || {};
      failures.push('Size guard: TRIED TO REDUCE AND FAILED — ' + (f.error || 'order not submitted') + '. Size is NOT enforced.');
      checks[4].detail = 'saw ' + (f.size != null ? f.size + ' lots' : 'an oversize') + ' over cap ' + gs.sizeCap
        + ' and could not reduce it: ' + (f.error || 'order not submitted');
    } else if (gs.mode === 'off') {
      failures.push('Size guard: OFF — nothing is enforcing contract size');
      checks[4].detail = gs.userDisabled ? 'turned off for this session' : 'disabled in rules.json';
    } else if (gs.mode === 'alarm-only') {
      failures.push('Size guard: ALARM-ONLY — it can detect an oversize but cannot close it');
      checks[4].detail = 'live orders not enabled this session — launch via "START CO-PILOT (LIVE ORDERS).bat" to let it reduce';
    } else if (gs.mode === 'blind') {
      failures.push('Size guard: BLIND — the positions table is unreadable, an oversize cannot even be seen');
      checks[4].detail = (gs.blindReads || 0) + ' consecutive unreadable position reads';
    } else {
      passed++;
      checks[4].ok = true;
      checks[4].detail = 'armed and able to reduce to ' + gs.sizeCap
        + (gs.lastSeenSize != null ? ' — last read ' + gs.lastSeenSize + ' lot(s)' : '');
    }
  } catch (e) {
    failures.push('Size guard: status could not be read — ' + e.message);
    checks[4].detail = 'status error: ' + e.message;
  }

  const resultMsg = { type: 'live-feed-self-test', passed, total, failures, checks, at: Date.now() };
  console.log(`[self-test] live feed: ${passed}/${total} checks passed` + (failures.length ? ' — ' + failures.join(' | ') : ''));
  broadcast(resultMsg);
  return resultMsg;
}
// ── PROTOCOL 2: LIVE-FEED INTEGRITY — the runner (2026-08-28) ─────────────
// Auto-triggers at startup and on every TradingView reconnect. Gathers what
// only the server can see, hands it to feed-protocol.js to judge, attempts the
// repairs that are safe to attempt, and BROADCASTS the evidence.
//
// Runs alongside the existing 3-check self-test rather than replacing it: that
// one answers "is the feed reading?" in seconds and gates the UI banner. This
// answers "is anything silently WRONG with what it read?", which costs more
// calls and is worth doing once per session rather than on every reconnect.
let feedProtocolTimer = null;
let feedProtocolLastRunAt = 0;

async function gatherFeedObservations() {
  const obs = {
    cdpConnected: !!(mcpBridge.ready && mcpBridge.tvConnected),
    bridgeReady: !!mcpBridge.ready,
    bars: {},
    monitors: [],
  };
  if (!obs.cdpConnected) return obs;

  // Panel tables + whether the summary is POPULATED, in one eval rather than
  // three calls — this protocol must not itself contend for the connection it
  // is diagnosing.
  try {
    const js = '(function(){var n={positions:"positions-table",orders:"orders-table",summary:"accountSummary-table"};'
      + 'var o={};for(var k in n){o[k]=!!document.querySelector("table[data-name$=\\""+n[k]+"\\"]");}'
      + 'var t=document.querySelector("table[data-name$=\\"accountSummary-table\\"]");var pop=false;'
      + 'if(t){var b=t.querySelector("tbody");var txt=b?(b.innerText||""):"";'
      + 'pop=!!txt.trim() && !/no trading data/i.test(txt);}'
      // 2026-09-02: ROW COUNTS, not just presence. `tables` above answers "is
      // the <table> in the DOM" and was true all through the 2026-09-01/02
      // degradation — ka-table renders body rows only for the VISIBLE sub-tab,
      // so a hidden Orders tab returns a well-formed table with an empty tbody.
      // Counted in the SAME eval so the protocol does not take a second turn on
      // the connection it is diagnosing. A row is only counted when it has as
      // many cells as the header has columns, which is how the "no trading data
      // here yet" placeholder (one <td> with a colspan) is told apart from a
      // real row — that placeholder means RENDERED-AND-EMPTY, the opposite of
      // this fault, and must never be read as the fault.
      + 'function rows(sfx){var tb=document.querySelector("table[data-name$=\\""+sfx+"\\"]");'
      + 'if(!tb)return{n:null,empty:null};'
      + 'var h=tb.querySelectorAll("thead th").length;var n=0;var empty=null;'
      + 'var trs=tb.querySelectorAll("tbody tr");'
      + 'for(var i=0;i<trs.length;i++){var c=trs[i].querySelectorAll("td");'
      + 'if(c.length>=h&&h>0){n++;}else if(c.length===1&&!empty){empty=(c[0].innerText||"").trim();}}'
      + 'return{n:n,empty:empty};}'
      + 'var orc=rows("orders-table");var prc=rows("positions-table");'
      + 'return JSON.stringify({tables:o,summaryPopulated:pop,'
      + 'panelRows:{orderRows:orc.n,ordersEmptyState:!!orc.empty,openPositions:prc.n,positionsEmptyState:!!prc.empty}});})()';
    const raw = await withBrokerLock(() => mcpBridge.callTool('ui_evaluate', { expression: js }));
    const parsed = parseToolResult(raw);
    const inner = parsed && parsed.result ? JSON.parse(parsed.result) : null;
    if (inner) {
      obs.panelTables = inner.tables;
      obs.summaryPopulated = inner.summaryPopulated;
      obs.panelRows = inner.panelRows || null;
    }
  } catch (e) { /* stays unknown — never guessed */ }

  // The guard's own live state. Read from the same single source the UI badge
  // and the WS status message use, so the protocol can never disagree with
  // what he is looking at on screen.
  try {
    obs.oversizeGuard = Object.assign(oversizeGuardStatus(), { expectedReadIntervalMs: TV_POSITION_WATCH_MS });
  } catch (e) { /* stays unknown — never guessed */ }

  // 2026-09-02: lock saturation, which is contention BELOW the timeout
  // threshold — the regime that did the damage without raising a single error.
  try {
    obs.lockDepth = {
      brokerNow: withBrokerLock.queueDepth(), brokerMax: withBrokerLock.maxQueueDepth(),
      chartNow: withChartLock.queueDepth(), chartMax: withChartLock.maxQueueDepth(),
      positionFastLaneUses: withBrokerLock.highJumps(),
      brokerMaxWaitMs: withBrokerLock.maxWaitMs(),
      chartMaxWaitMs: withChartLock.maxWaitMs(),
      warnAt: 4,
      warnWaitMs: SLOW_WAIT_WARN_MS,
    };
  } catch (e) { /* stays unknown — never guessed */ }

  // Bar feed per watched timeframe. Verifies the SPACING, which is the only
  // way to catch the timeframe race: wrong-timeframe bars look perfectly fine.
  for (const tf of ['5', '15', '30', '60']) {
    try {
      const b = await getFullBars(tf, 12);
      if (Array.isArray(b) && b.length >= 2) {
        const gaps = {};
        for (let i = 1; i < b.length; i++) {
          const g = Math.round((b[i].time - b[i - 1].time) / 60);
          gaps[g] = (gaps[g] || 0) + 1;
        }
        const spacing = Number(Object.keys(gaps).sort(function (x, y) { return gaps[y] - gaps[x]; })[0]);
        obs.bars[tf] = {
          count: b.length,
          spacingMin: spacing,
          newestAgeMin: Math.round((Date.now() / 1000 - b[b.length - 1].time) / 60),
        };
      } else {
        obs.bars[tf] = { count: Array.isArray(b) ? b.length : 0, spacingMin: null, newestAgeMin: null };
      }
    } catch (e) { obs.bars[tf] = { count: null, error: e.message }; }
  }

  // Silent turn-off: the flag AND the last check time. `running:true` with no
  // check in three intervals is a watcher that stopped without saying so.
  try {
    obs.monitors = ALL_MONITORS.map(function (e) {
      const m = e.mon() || {};
      return {
        id: e.id,
        label: e.label,
        running: !!m.running,
        lastCheckAgeMs: m.lastCheck ? (Date.now() - new Date(m.lastCheck).getTime()) : null,
        expectedIntervalMs: e.intervalMs,
      };
    });
  } catch (e) { /* leave empty -> reported unknown */ }

  obs.foldState = {
    tradeCount: tvBrokerFeedState.tradeCount,
    dayPnl: tvBrokerFeedState.dayPnl,
    trades: tvBrokerFeedState.trades || [],
    phantomFlats: tvBrokerFeedState.phantomFlats || 0,
  };
  try {
    const slot = jessiBucketKey(loadConfig());
    const dayKey = dayRollup.tradingDayKey(Date.now());
    const store = dataLoad('day_trades__' + slot) || {};
    obs.todayRows = Array.isArray(store[dayKey]) ? store[dayKey] : [];
  } catch (e) { /* unknown */ }

  return obs;
}

// Repairs the protocol asked for. Each returns a short evidence string, or a
// stated failure — a repair that silently does nothing is worse than one that
// reports it could not act.
async function applyFeedRectification(action) {
  switch (action) {
    case 'mount-panel-tables':
    case 'activate-summary-tab':
      try {
        const raw = await withBrokerLock(function () { return mcpBridge.callTool('trading_ensure_panel_ready', {}); });
        const res = parseToolResult(raw);
        return res ? 'panel repair ran (success=' + res.success + ', alreadyMounted=' + !!res.alreadyMounted + ')' : null;
      } catch (e) { return 'panel repair threw: ' + e.message; }

    // 2026-09-02: distinct from mount-panel-tables on purpose. That repair
    // asks "is the table in the DOM" and answers YES for this fault, so it
    // would report success and change nothing — the failure mode that let this
    // survive two sessions. This one forces the rows to paint.
    case 'render-orders-table':
      try {
        const raw = await withBrokerLock(function () { return mcpBridge.callTool('trading_refresh_orders_table', {}); });
        const res = parseToolResult(raw);
        return res
          ? 'orders table re-render ran (ok=' + res.ok + ', rows ' + res.rowsBefore + ' -> ' + res.rowsAfter
            + ', tab restored=' + res.restored + ')'
          : null;
      } catch (e) { return 'orders re-render threw: ' + e.message; }

    case 'restart-watchers':
      try {
        let n = 0;
        for (const e of ALL_MONITORS) {
          const m = e.mon() || {};
          const stalled = m.running && m.lastCheck
            && (Date.now() - new Date(m.lastCheck).getTime()) > e.intervalMs * 3;
          if ((!m.running || stalled) && (!e.cond || e.cond())) { e.run(); n++; }
        }
        return n ? 'restarted ' + n + ' watcher(s)' : 'nothing to restart';
      } catch (e) { return 'watcher restart threw: ' + e.message; }

    case 'drop-phantom-trades':
      try {
        const before = tvBrokerFeedState.tradeCount;
        const all = tvBrokerFeedState.trades || [];
        const kept = all.filter(function (t) { return Number(t && t.pnl) !== 0; });
        const removed = all.length - kept.length;
        if (!removed) return 'no phantoms present';
        tvBrokerFeedState.trades = kept;
        tvBrokerFeedState.tradeCount = Math.max(0, before - removed);
        persistTVBrokerFeedState();
        return 'removed ' + removed + ' phantom trade(s), count ' + before + ' -> ' + tvBrokerFeedState.tradeCount
          + ', day P&L unchanged at $' + (tvBrokerFeedState.dayPnl || 0).toFixed(2);
      } catch (e) { return 'phantom removal threw: ' + e.message; }

    case 'refetch-bars':
      // The bar cache is keyed on bar periods, so the next scheduled read picks
      // up fresh data by itself. Forcing one would add load to the connection
      // this check may be reporting as contended.
      return 'next bar-close read will refetch (cache is bar-period keyed)';

    case 'merge-duplicate-rows':
      // AUTOMATIC, but only for the UNAMBIGUOUS case (2026-08-28).
      //
      // Why this became safe to automate: the duplicate is created by an
      // ordering problem, not a judgement call. The fold writes a row for a
      // flat blip DURING an open trade — no prices yet, so nothing matches —
      // and the enrich path back-fills that row's prices from the order walk
      // afterwards. Only then do the two rows become identifiable as one
      // trade, by which point the merge that would have caught them has long
      // since run.
      //
      // A pair is merged ONLY when they share side, size and BOTH fill prices,
      // AND one row's P&L contradicts those prices while the other agrees.
      // The self-consistent row is the real one; the other is the blip. That
      // is arithmetic, not interpretation. Anything less clear-cut is left
      // alone and reported — the 2026-08-28 migration needed a human for a day
      // that would not reconcile, and that is still true.
      try {
        const slot = jessiBucketKey(loadConfig());
        const dayKey = dayRollup.tradingDayKey(Date.now());
        const store = dataLoad('day_trades__' + slot) || {};
        const rows = Array.isArray(store[dayKey]) ? store[dayKey] : [];
        const comm = getActiveRules().commissionPerContractPerSide;
        const consistent = (r) => {
          const sz = Math.abs(Number(r.size) || 0);
          const ep = Number(r.ep), xp = Number(r.xp);
          const side = String(r.side || '').toUpperCase();
          if (!sz || !Number.isFinite(ep) || !Number.isFinite(xp) || (side !== 'LONG' && side !== 'SHORT')) return null;
          const dir = side === 'LONG' ? 1 : -1;
          // G10: point value from the contracts block, never a hardcoded $2/pt.
          const _pvSpec = requireContractSpec(r.symbol || 'MNQ');
          if (!_pvSpec) return null; // refuse rather than default on an unknown symbol
          const net = (xp - ep) * dir * sz * _pvSpec.pointValue - sz * comm * 2;
          return Math.abs(Number(r.pnl) - net) < 0.02;
        };
        const keep = [];
        const dropped = [];
        for (const r of rows) {
          const twin = keep.findIndex(k =>
            k.side && r.side && String(k.side).toUpperCase() === String(r.side).toUpperCase()
            && Math.abs(Number(k.size) || 0) === Math.abs(Number(r.size) || 0)
            && Number(k.ep) === Number(r.ep) && Number(k.xp) === Number(r.xp));
          if (twin < 0) { keep.push(r); continue; }
          const a = consistent(keep[twin]), b = consistent(r);
          if (a === true && b === false) { dropped.push(r); continue; }              // keep the existing
          if (a === false && b === true) { dropped.push(keep[twin]); keep[twin] = r; continue; }
          keep.push(r);                                                              // ambiguous -> keep both
        }
        if (!dropped.length) return 'no unambiguous duplicates to merge';
        const backup = path.join(DATA_DIR, 'accounts', slot, 'day_trades.json.bak-protocol-' + Date.now());
        try { fs.copyFileSync(path.join(DATA_DIR, 'accounts', slot, 'day_trades.json'), backup); } catch (e) {}
        store[dayKey] = keep;
        dataSave('day_trades__' + slot, store);
        broadcast({ type: 'day-trades-repaired', date: dayKey, filled: 0, merged: dropped.length });
        return 'merged ' + dropped.length + ' duplicate row(s): ' + rows.length + ' -> ' + keep.length
          + ' (kept the row whose P&L agrees with its own fill prices; backup written)';
      } catch (e) { return 'duplicate merge threw: ' + e.message; }

    default:
      return null;
  }
}

// ── Daily bar recorder ─────────────────────────────────────────────────────
// TradingView's bridge returns ~300 bars per request no matter what is asked
// for, so the 1m/5m history the drift backtest needs cannot be fetched after
// the fact — it has to be kept. Each pull overlaps the last, and
// bar-recorder.mergePull folds them into one growing series.
//
// WHY ONCE A DAY, NOT ON A TIMER. Pulling means switching the live chart's
// timeframe and switching it back. Doing that every few minutes would fight
// the monitors over the single TradingView connection and move his chart
// under him mid-session. It does not need to: 300 x 1m is ~5 hours and his
// London+NY windows total ~4, so ONE pull after the session covers the whole
// day. 300 x 5m is ~25 hours, so the same pull more than covers 5m too.
const BAR_TFS = [{ tf: '5', file: 'mnq_5.json', spacing: 5 }, { tf: '1', file: 'mnq_1.json', spacing: 1 }];
let barRecorderRunning = false;
let panelRepairState = panelRepair.freshState(null); // broker-tab re-render budget (summary)
// 2026-09-02: the ORDERS fault gets its own budget, deliberately not shared.
// decide()'s escalation is a latch and its recovery branch clears that latch,
// so one state serving two faults means a summary escalation blocks the orders
// repair, and a summary recovery silently un-escalates an orders fault that is
// still broken. Two faults, two ledgers.
let panelRepairOrdersState = panelRepair.freshState(null); // broker-tab re-render budget (orders rows)

async function runBarRecorder(trigger, ws, reqId) {
  if (barRecorderRunning) return null;
  barRecorderRunning = true;
  const dir = path.join(DATA_DIR, 'bars');
  const results = [];
  let original = null;
  try {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    // Remember where the chart was BEFORE touching it. Restored in finally,
    // even on error — leaving his chart on 1m is a real cost.
    try {
      const st = await withChartLock(function () { return mcpBridge.callTool('chart_get_state', {}); });
      const p = typeof st === 'string' ? JSON.parse(st) : st;
      original = (p && (p.timeframe || p.interval || p.resolution)) || null;
    } catch (e) {}

    for (const spec of BAR_TFS) {
      try {
        await withChartLock(function () { return mcpBridge.callTool('chart_set_timeframe', { timeframe: spec.tf }); });
        // The switch returns before the chart has finished; reading straight
        // away returns the PREVIOUS timeframe's bars. mergePull verifies the
        // spacing and rejects a mismatch, so a bad read cannot corrupt the
        // file — this pause just makes the reject rare rather than routine.
        await new Promise(function (r) { setTimeout(r, 1500); });
        const raw = await withChartLock(function () { return mcpBridge.callTool('data_get_ohlcv', { count: 300, summary: false }); });
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const incoming = (parsed && (parsed.bars || parsed.data || parsed)) || [];
        const fp = path.join(dir, spec.file);
        let stored = [];
        try { const d = JSON.parse(fs.readFileSync(fp, 'utf8')); stored = Array.isArray(d) ? d : (d.bars || []); } catch (e) {}
        const merged = barRecorder.mergePull(stored, incoming, spec.spacing);
        if (merged.rejected) {
          console.warn('[bars] ' + spec.tf + 'm pull rejected: ' + merged.reason);
          results.push({ tf: spec.tf, rejected: true, reason: merged.reason });
          continue;
        }
        atomicWrite.writeAtomic(fp, JSON.stringify(merged.bars), 'utf8');
        const cov = barRecorder.describe(merged.bars);
        console.log('[bars] ' + spec.tf + 'm +' + merged.added + ' new, ' + merged.replaced
          + ' updated -> ' + cov.count + ' bars, ' + cov.spanDays + 'd coverage');
        results.push({ tf: spec.tf, added: merged.added, replaced: merged.replaced, coverage: cov });
      } catch (e) {
        console.warn('[bars] ' + spec.tf + 'm failed: ' + e.message);
        results.push({ tf: spec.tf, error: e.message });
      }
    }
  } catch (e) {
    console.warn('[bars] recorder failed:', e.message);
  } finally {
    if (original) {
      try { await withChartLock(function () { return mcpBridge.callTool('chart_set_timeframe', { timeframe: String(original) }); }); }
      catch (e) { console.warn('[bars] COULD NOT RESTORE chart to ' + original + ':', e.message); }
    }
    barRecorderRunning = false;
  }
  const five = results.find(function (r) { return r.tf === '5' && r.coverage; });
  // progressToAnswer needs real bars, not `new Array(n)` — an array of
  // undefined filters to zero in describe(), so this would have reported
  // "0 days recorded" forever while looking perfectly reasonable.
  const spanD = five && five.coverage ? five.coverage.spanDays : null;
  const progress = spanD == null ? null : {
    daysRecorded: spanD,
    pairsSoFar: Math.floor(spanD * 7.5),
    pairsNeeded: 90,
    tradingDaysRemaining: Math.max(0, Math.ceil((90 - spanD * 7.5) / 7.5)),
    ready: spanD * 7.5 >= 90,
  };
  if (ws) send(ws, { type: 'bar-record-data', reqId: reqId, results: results, progress: progress });
  return results;
}

// ── PROTOCOL: bar-record self-repair on startup (2026-09-02) ───────────────
// Anoop: "why has bar recorder stopped. build a protocol to self repair on
// start up as it is important."
//
// It had not stopped. runBarRecorder was scheduled once a day at >= 21:30 IST
// and the server was DOWN from 20:15 IST to 11:31 IST the next morning, so the
// window never opened. The schedule could tell "today not yet recorded" from
// "today recorded", but had no way to notice that YESTERDAY was missed and was
// still partly reachable. This runs at startup and closes exactly that gap.
//
// The decision logic is in bar-recovery.js (pure, unit-tested). This function
// only gathers the file facts and performs the pull — deliberately, because
// the interesting behaviour is "how much of this hole is unrecoverable", and
// that must be testable without a chart.
//
// IT REPORTS LOSS AS LOUDLY AS REPAIR. A pull reaches back a fixed distance
// (300 bars: ~5h of 1m, ~25h of 5m). A longer outage is permanently lost,
// because TradingView will not serve this history retrospectively — which is
// the entire reason bar-recorder exists. A self-repair that fetched the
// reachable part and logged "OK" would leave the hole AND hide it.
async function runBarRecordSelfRepair(trigger) {
  const dir = path.join(DATA_DIR, 'bars');
  const files = BAR_TFS.map(function (spec) {
    let bars = [];
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, spec.file), 'utf8'));
      bars = Array.isArray(d) ? d : (d.bars || []);
    } catch (e) { /* missing/corrupt reads as never-recorded, which is correct */ }
    const last = bars.length ? bars[bars.length - 1] : null;
    const t = last ? (last.time != null ? last.time : last.t) : null;
    return {
      tf: spec.tf,
      spacing: spec.spacing,
      count: bars.length,
      // bar times are seconds or ms depending on source — same defensive
      // treatment dropFormingBar() uses.
      lastBarMs: t == null ? null : (t > 1e12 ? t : t * 1000),
    };
  });

  const state = barRecovery.assess(files, Date.now());
  console.log('[bars:repair] ' + state.summary);
  if (!state.needsRepair) {
    broadcast({ type: 'bar-record-repair', trigger: trigger, needed: false, summary: state.summary, files: state.files });
    return state;
  }
  if (state.anyPermanentLoss) {
    // Deliberately a warn, and deliberately said before the pull rather than
    // after: the pull is about to succeed at fetching what it can reach, and
    // that success must not be the last word in the log.
    console.warn('[bars:repair] PERMANENT LOSS — part of this gap predates what TradingView will serve. '
      + 'It cannot be recovered by this or any later run.');
  }

  let results = [];
  try {
    results = (await runBarRecorder(trigger || 'startup-repair')) || [];
  } catch (e) {
    console.warn('[bars:repair] catch-up pull failed:', e.message);
  }
  const outcome = barRecovery.describeOutcome(state.files, results);
  console.log('[bars:repair] ' + (outcome.ok ? 'RECOVERED' : 'INCOMPLETE') + ' — ' + outcome.text);

  try {
    const d = path.join(DATA_DIR, 'protocols');
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, 'bar-repair.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), trigger: trigger || 'startup-repair',
      summary: state.summary, anyPermanentLoss: state.anyPermanentLoss,
      files: state.files, outcome: outcome,
    }) + '\n', 'utf8');
  } catch (e) { /* the record is a nicety; the repair already happened */ }

  broadcast({
    type: 'bar-record-repair', trigger: trigger || 'startup-repair', needed: true,
    summary: state.summary, files: state.files,
    anyPermanentLoss: state.anyPermanentLoss, outcome: outcome,
  });
  return state;
}

// ── Post-exit drift ────────────────────────────────────────────────────────
// Anoop 2026-08-31: after he is flat, what has price done relative to where
// he got out? Two readings from one walk — how good the exit was (a decision
// he can learn from) and where price sits now (a bias input).
//
// The judgement lives in exit-drift.js, which is pure and refuses to speak
// when it should not: no exit price, too few bars, drift under the ATR
// threshold, or still inside his post-trade cooldown. This function only
// gathers inputs — it must not second-guess those refusals.
async function runExitDrift(ws, reqId) {
  try {
    const cfg = loadConfig();
    const slot = jessiBucketKey(cfg);
    const dir = path.join(DATA_DIR, "accounts", slot);
    let byDay = {};
    try { byDay = JSON.parse(fs.readFileSync(path.join(dir, "day_trades.json"), "utf8")) || {}; } catch (e) {}

    // Most recent trade that actually carries an exit price. A fold-derived
    // row has xp:null, and anchoring on it would measure drift from nothing.
    const rows = Object.keys(byDay).sort().reverse()
      .flatMap(function (d) { return (byDay[d] || []).slice(); })
      .filter(function (t) { return t && t.xp != null && t.x != null; })
      .sort(function (a, b) { return (b.x || 0) - (a.x || 0); });
    const lastTrade = rows[0] || null;
    if (!lastTrade) {
      const empty = exitDrift.computeExitDrift({ lastTrade: null, nowMs: Date.now() });
      lastExitDriftSnapshot = empty;
      if (ws) send(ws, { type: "exit-drift-data", reqId: reqId, data: empty, text: exitDrift.formatExitDrift(empty) });
      return empty;
    }

    // WHICH TIMEFRAME. data_get_ohlcv inherits the chart's current timeframe,
    // so without capturing it the ATR, the 0.5-ATR threshold and the 1-10 score
    // all silently change meaning when he switches charts — a 7/10 on 1m and a
    // 7/10 on 1h are different claims wearing the same number.
    let timeframe = null;
    try {
      const st = await withChartLock(function () { return mcpBridge.callTool("chart_get_state", {}); });
      // parseToolResult, not a bare cast: callTool returns the MCP envelope
      // { content: [{ text: "<json>" }] }. Reading .timeframe off the envelope
      // yields undefined, which is why every reading reported timeframe:null.
      const p = parseToolResult(st);
      timeframe = (p && (p.timeframe || p.interval || p.resolution)) || null;
    } catch (e) {}

    const tickSize = await getTickSizeCached();
    // WHICH SYMBOL THE BARS ARE. The PO3 secondary-symbol watch flips the chart
    // between MNQ and MGC, so "the chart" is not a fixed instrument. A reading
    // taken during an MGC window would compare an MNQ exit (29406) against gold
    // bars (4371) and report a confident 25,000-point drift. day_trades rows do
    // not record a symbol, so exit-drift.js cannot match them by name — it
    // range-checks the exit price against the bars instead and refuses when
    // they cannot be the same instrument. The name is passed only so the
    // refusal can say WHICH symbol it found.
    let chartSymbol = null;
    try { chartSymbol = await getChartSymbolCached(); } catch (e) {}

    // Bars on the chart's current timeframe. Chart-locked like every other
    // read so this cannot race the monitors over the single TV connection.
    let bars = [];
    try {
      const res = await withChartLock(function () { return mcpBridge.callTool("data_get_ohlcv", { count: 120, summary: false }); });
      // THE SECOND REASON THIS PANEL NEVER RENDERED (found live 2026-09-02).
      // callTool returns { content: [{ text: "<json>" }] }. The old line read
      // `parsed.bars || parsed.data || parsed` — both properties are undefined
      // on the envelope, so it fell through to the envelope OBJECT, failed the
      // Array.isArray guard on the next line, and reset to []. Every single
      // time. The guard then made it look like a data problem ("Only 0 bar(s)
      // since the exit") rather than an unwrapping bug, which is why fixing the
      // seconds/ms comparison alone was not enough to make the box appear.
      const parsed = parseToolResult(res);
      bars = (parsed && (parsed.bars || parsed.data)) || [];
      if (!Array.isArray(bars)) bars = [];
    } catch (e) { console.warn("[exit-drift] bar read failed:", e.message); }

    const atr = exitDrift.atrFromBars(bars, 14);
    const rules = getActiveRules();
    const out = exitDrift.computeExitDrift({
      lastTrade: lastTrade, bars: bars, atr: atr, nowMs: Date.now(), tickSize: tickSize, symbol: chartSymbol,
      cfg: { cooldownMinutes: rules && rules.cooldownMinutes != null ? rules.cooldownMinutes : 15 },
    });
    out.timeframe = timeframe;   // label every reading with the bars it came from
    // Cached for THE LOOP (2026-09-03). The Loop runs on the trade-write path
    // and must not take the chart lock to ask for this — see
    // formatLastExitForLoop. One snapshot, one source: the panel and the agent
    // read the same reading, so they cannot disagree about where he got out.
    lastExitDriftSnapshot = out;

    // ── Declared bias vs. what price actually did ──────────────────────────
    // TODAY's checklist is the one compared, because the bias he is about to
    // trade on is the one he wants checked. When the exit came from an earlier
    // trading day that comparison is looser, so sameDay is passed and
    // exit-bias-align.js says so out loud rather than quietly equating them.
    try {
      const todayKey = tradingDayStampIST(Date.now());
      const ckAll = JSON.parse(fs.readFileSync(path.join(dir, "ck_history.json"), "utf8"));
      const ck = (Array.isArray(ckAll) ? ckAll : []).filter(function (c) { return c && c.date === todayKey; }).pop();
      const rec = ck ? biasTracker.directionOfRecord(ck) : null;
      out.align = exitBiasAlign.alignExitDrift(out, rec, {
        sameDay: tradingDayStampIST(lastTrade.x) === todayKey,
      });
    } catch (e) {
      // No checklist on disk is a real state, not a failure: NO_BIAS says so.
      out.align = exitBiasAlign.alignExitDrift(out, null, {});
    }
    out.alignText = exitBiasAlign.formatAlign(out.align);
    const text = exitDrift.formatExitDrift(out);
    console.log("[exit-drift] timeframe=" + (timeframe || "unknown") + " " + (text || "no read"));
    if (ws) send(ws, { type: "exit-drift-data", reqId: reqId, data: out, text: text });
    return out;
  } catch (e) {
    console.warn("[exit-drift] failed:", e.message);
    if (ws) send(ws, { type: "exit-drift-data", reqId: reqId, error: e.message });
    return null;
  }
}

// ── Mark the last exit on the chart ────────────────────────────────────────
// Anoop 2026-09-02: "should have capabilites of marking the last exit price on
// the chart so that i can see and annalyse the current bias".
//
// horizontal_RAY, not horizontal_line. The ray anchors at the exit candle and
// extends rightward only, so the line covers exactly the window the panel is
// talking about — the same convention markLondonLevels() was corrected to on
// 2026-07-27 after he sent a screenshot of his own markup ("origin from the
// point the high or low is... this should apply to all marking level"). A
// horizontal_line would span the whole chart in both directions and imply the
// level mattered before he ever took the trade.
//
// IT NEVER CALLS draw_clear. That tool removes EVERY drawing on the chart,
// including his own hand-drawn levels — an unrecoverable action triggered by a
// button whose label only promises to draw one line. Instead the entity ids of
// the ray and its label are remembered and removed individually before a
// redraw, so pressing the button repeatedly replaces this line and touches
// nothing else. If a previous id can no longer be removed the failure is
// logged and the redraw continues: a stale duplicate is a far smaller harm
// than wiping his analysis.
let exitMarkIds = [];

async function removeExitMark() {
  const ids = exitMarkIds.slice();
  exitMarkIds = [];
  for (const id of ids) {
    try { await mcpBridge.callTool("draw_remove_one", { entity_id: id }); }
    catch (e) { console.warn("[exit-mark] could not remove " + id + ":", e.message); }
  }
}

async function markExitOnChart(ws, reqId) {
  const fail = (status) => {
    if (ws) send(ws, { type: "exit-mark-result", reqId: reqId, ok: false, status: status });
    return null;
  };
  if (!mcpBridge.ready || !mcpBridge.tvConnected) return fail("TradingView offline — cannot draw.");
  try {
    const cfg = loadConfig();
    const slot = jessiBucketKey(cfg);
    const dir = path.join(DATA_DIR, "accounts", slot);
    let byDay = {};
    try { byDay = JSON.parse(fs.readFileSync(path.join(dir, "day_trades.json"), "utf8")) || {}; } catch (e) {}
    // Same filter as runExitDrift: a fold-derived row has xp:null and there is
    // no price to mark. Drawing a line at an inferred level would put a number
    // on the chart that nothing supports.
    const lastTrade = Object.keys(byDay).sort().reverse()
      .flatMap(function (d) { return (byDay[d] || []).slice(); })
      .filter(function (t) { return t && t.xp != null && t.x != null; })
      .sort(function (a, b) { return (b.x || 0) - (a.x || 0); })[0] || null;
    if (!lastTrade) return fail("No completed trade with a recorded exit price to mark.");

    const price = Number(lastTrade.xp);
    // TradingView anchors are UNIX SECONDS; the trade stamp is milliseconds.
    // Passing ms straight through would place the anchor ~55,000 years out and
    // the ray would not render — the same units mismatch that made the drift
    // panel invisible, in the other direction.
    const originSec = Math.floor(exitDrift.toMs(lastTrade.x) / 1000);
    const side = exitDrift.normalizeSide(lastTrade.side);
    const label = "Last exit " + price + (side ? " (" + side + ")" : "");

    await removeExitMark();
    const drawn = [];
    const ray = await withChartLock(function () {
      return mcpBridge.callTool("draw_shape", {
        shape: "horizontal_ray",
        point: { time: originSec, price: price },
        overrides: JSON.stringify({ linecolor: "#e0b341", linewidth: 2, linestyle: 2, showLabel: true, horzLabelsAlign: "right" }),
      });
    });
    // parseToolResult, NOT a bare JSON.parse: an MCP result arrives wrapped as
    // { content: [{ type: "text", text: "<json>" }] }, so reading .entity_id off
    // the envelope yields undefined. That failure is silent and compounding —
    // no id recorded means removeExitMark() has nothing to remove, so every
    // press of the button would stack another ray on the chart forever.
    const rayId = (parseToolResult(ray) || {}).entity_id;
    if (rayId) drawn.push(rayId);

    const txt = await withChartLock(function () {
      return mcpBridge.callTool("draw_shape", {
        shape: "text",
        point: { time: originSec, price: price },
        text: label,
        overrides: JSON.stringify({ color: "#e0b341" }),
      });
    });
    const txtId = (parseToolResult(txt) || {}).entity_id;
    if (txtId) drawn.push(txtId);

    exitMarkIds = drawn;
    // No id back means the line may be on the chart but is no longer ours to
    // replace. Saying so beats a success message that quietly becomes a pile
    // of duplicate rays.
    if (!drawn.length) {
      console.warn("[exit-mark] drew " + label + " but TradingView returned no entity id — cannot replace it later");
      if (ws) send(ws, { type: "exit-mark-result", reqId: reqId, ok: true, price: price, label: label, ids: [],
        status: "Marked, but this line cannot be auto-replaced — remove it by hand if it duplicates." });
      return drawn;
    }
    console.log("[exit-mark] drew " + label + " at " + new Date(originSec * 1000).toISOString() + " ids=" + drawn.join(","));
    if (ws) send(ws, { type: "exit-mark-result", reqId: reqId, ok: true, price: price, label: label, ids: drawn });
    return drawn;
  } catch (e) {
    console.warn("[exit-mark] failed:", e.message);
    return fail(e.message);
  }
}

// ── PROTOCOL 3: TRUST ─────────────────────────────────────────────────────
// Reports only. Every fault it finds means a number on screen is unsupported,
// and silently rewriting that number is how this bug class arrived in the
// first place. A visible gap beats a confident wrong answer.
function runTrustProtocol(trigger, ws, reqId) {
  try {
    const cfg = loadConfig();
    const slot = jessiBucketKey(cfg);
    const todayKey = tradingDayStampIST(Date.now());
    const dir = path.join(DATA_DIR, "accounts", slot);
    const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } };
    const grAll = readJson(path.join(dir, "gr_history.json"), []) || [];
    const day = grAll.filter(d => d && d.date === todayKey).pop() || null;
    const trades = (readJson(path.join(dir, "day_trades.json"), {}) || {})[todayKey] || [];
    const feed = readJson(path.join(DATA_DIR, "tv_broker_feed_state.json"), null);
    let bias = null;
    try {
      const ck = (readJson(path.join(dir, "ck_history.json"), []) || []).filter(c => c && c.date === todayKey).pop();
      if (ck) bias = biasTracker.dayAdherence(ck, trades, getActiveRules());
    } catch (e) {}
    const result = trustProtocol.evaluate({ day, trades, bias, feed, advice: null }, getActiveRules());
    const tag = result.severity === trustProtocol.SEV.FAIL ? "[protocol:trust] FAIL" :
      result.severity === trustProtocol.SEV.WARN ? "[protocol:trust] WARN" : "[protocol:trust] ok";
    console.log(tag + " (" + trigger + ") " + result.summary);
    if (ws) send(ws, { type: "trust-protocol-data", reqId: reqId, data: result });
    if (result.severity === trustProtocol.SEV.FAIL) {
      broadcast({ type: "trust-protocol-alert", severity: result.severity, summary: result.summary, checks: result.checks });
    }
    return result;
  } catch (e) {
    console.warn("[protocol:trust] run failed:", e.message);
    return null;
  }
}

async function runFeedIntegrityProtocol(trigger) {
  const startedAt = Date.now();
  feedProtocolLastRunAt = startedAt;
  try {
    const obs = await gatherFeedObservations();
    const result = feedProtocol.evaluate(obs, getActiveRules());

    const rectified = [];
    for (const rec of result.rectifications) {
      const evidence = await applyFeedRectification(rec.action);
      rectified.push({ check: rec.key, label: rec.label, action: rec.action, evidence: evidence });
    }

    // Re-evaluate AFTER repairing, so the report states what is true NOW rather
    // than what was true before the protocol acted.
    let after = null;
    if (rectified.length) {
      try { after = feedProtocol.evaluate(await gatherFeedObservations(), getActiveRules()); } catch (e) {}
    }

    const shown = after || result;
    const report = {
      type: 'feed-protocol-report',
      protocol: 'live-feed-integrity',
      trigger: trigger || 'startup',
      at: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      before: { passed: result.passed, failed: result.failed, unknown: result.unknown, critical: result.critical, headline: result.headline },
      after: after ? { passed: after.passed, failed: after.failed, unknown: after.unknown, critical: after.critical, headline: after.headline } : null,
      checks: shown.checks,
      rectified: rectified,
    };

    console.log('[protocol:feed] ' + result.passed + '/' + result.total + ' passed — ' + result.headline);
    for (const c of shown.checks) {
      if (c.verdict === 'pass') continue;
      console.warn('[protocol:feed] ' + c.verdict.toUpperCase() + ' ' + c.label + ': ' + (c.impact || '(no impact stated)'));
    }
    for (const r of rectified) console.log('[protocol:feed] RECTIFIED ' + r.label + ' -> ' + r.evidence);

    broadcast(report);
    try { feedProtocolPersist(report); } catch (e) {}

    // Telegram only for critical findings — a protocol that pings on every
    // clean run gets muted, and then the one that matters is muted too.
    if (result.critical > 0) {
      try {
        telegramBot.notify('LIVE FEED PROTOCOL: ' + result.critical + ' critical issue(s)\n'
          + shown.checks.filter(function (c) { return c.verdict === 'fail' && c.severity === 'critical'; })
              .map(function (c) { return '- ' + c.label + ': ' + c.impact; }).join('\n'));
      } catch (e) {}
    }
    return report;
  } catch (e) {
    console.error('[protocol:feed] the protocol itself failed:', e.message);
    broadcast({ type: 'feed-protocol-report', protocol: 'live-feed-integrity', error: e.message, at: new Date().toISOString() });
    return null;
  }
}

// Durable evidence. A protocol whose findings only exist in a scrollback the
// user may not have been looking at has not really reported anything.
function feedProtocolPersist(report) {
  const dir = path.join(DATA_DIR, 'protocols');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'feed-integrity.jsonl'), JSON.stringify(report) + '\n', 'utf8');
}

// ── PROTOCOL 1: SYSTEM HEALTH — the runner (2026-08-28) ────────────────────
// Every 3 days, plus once ~3 minutes after startup so a fresh install is
// checked immediately. The due-check is persisted, so the cadence survives
// restarts rather than resetting every time the app is opened.
let healthProtocolTimer = null;

function healthProtocolStatePath() {
  return path.join(DATA_DIR, 'protocols', 'health-state.json');
}
function healthProtocolLastRun() {
  try { return JSON.parse(fs.readFileSync(healthProtocolStatePath(), 'utf8')).lastRunMs || 0; }
  catch (e) { return 0; }
}
function healthProtocolMarkRun(ms) {
  try {
    const dir = path.join(DATA_DIR, 'protocols');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(healthProtocolStatePath(), JSON.stringify({ lastRunMs: ms }, null, 2), 'utf8');
  } catch (e) {}
}

// STATIC SCAN: renderer code reaching for a variable that lives inside another
// file's closure. This is the dead-button class — the Standard/Scalper toggle
// was broken this way for a month and looked perfectly normal.
function scanDeadRefs() {
  const out = [];
  try {
    const dir = path.join(__dirname, 'renderer');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js') || f === 'ws-client.js' || f.includes('.bak') || f.includes('.tmp')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/(^|[^.\w])ws\s*\.\s*(send|readyState|close|onmessage)\b/.test(line)) {
          out.push({ file: f, line: i + 1, text: line.trim().slice(0, 120) });
        }
      });
    }
  } catch (e) {}
  return out;
}

// STRESS: feed the pure decision modules malformed input and require them to
// refuse rather than invent. Targets the historical failure where one bad bar
// produced an EMA of 65,750,116.55 — a plausible wrong number, not a NaN.
function stressPureModules() {
  const GARBAGE = [null, undefined, [], {}, NaN, 'x', 0, -1,
    [{ high: NaN, low: null, close: undefined, open: 'x', time: 'y' }]];
  const cases = [];
  const safe = (name, fn) => {
    try {
      const r = fn();
      const bad = typeof r === 'number' && !Number.isFinite(r);
      cases.push({ module: name, ok: !bad, error: bad ? 'returned a non-finite number' : null });
    } catch (e) {
      cases.push({ module: name, ok: false, error: e.message });
    }
  };
  for (const g of GARBAGE) {
    safe('detectors.detectEngulfFromBars', () => detectors.detectEngulfFromBars(g));
    safe('detectors.detectFVGFromBars', () => detectors.detectFVGFromBars(g));
    safe('detectors.adxSeries', () => detectors.adxSeries(g, 14));
    safe('playbook-c.validateEngulfPlaybookC', () => playbookC.validateEngulfPlaybookC(g, 'BULLISH', null));
    safe('playbook-spec.planEntry', () => playbookSpec.planEntry('A', g, getActiveRules()));
    safe('signal-outcome.resolveSignalOutcome', () => signalOutcome.resolveSignalOutcome(g, g, {}));
    safe('tv-broker-feed.fold', () => tvBrokerFeed.fold(tvBrokerFeed.freshState(), g || {}, Date.now()));
    safe('feed-protocol.evaluate', () => feedProtocol.evaluate(g, getActiveRules()));
  }
  // Collapse to one row per module: a module is only OK if it survived every
  // input. Reporting 72 individual passes would bury the one failure.
  const byModule = new Map();
  for (const c of cases) {
    const prev = byModule.get(c.module);
    if (!prev || (prev.ok && !c.ok)) byModule.set(c.module, c);
  }
  return Array.from(byModule.values());
}

function gatherHealthObservations() {
  const obs = { deadRefs: scanDeadRefs(), stress: stressPureModules(), timers: [] };

  // Named background jobs. `alive` is the timer handle actually existing —
  // a stopped resolver changes nothing on screen.
  obs.timers = [
    { name: 'signal-outcome resolver', alive: !!signalOutcomeTimer },
    { name: 'shadow resolver', alive: !!shadowResolveTimer },
    { name: 'tv-broker monitor', alive: !!tvBrokerMonitorTimer },
    { name: 'panel watchdog', alive: !!panelWatchdogTimer },
  ];

  // Disk: prove it by writing, not by assuming.
  try {
    const probe = path.join(DATA_DIR, 'protocols', '.write-probe');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, String(Date.now()), 'utf8');
    fs.unlinkSync(probe);
    obs.diskWritable = true;
  } catch (e) { obs.diskWritable = false; }

  // The three stores that are supposed to be one fact.
  try {
    const slot = jessiBucketKey(loadConfig());
    const dt = dataLoad('day_trades__' + slot) || {};
    const led = dataLoad('balance_ledger__' + slot) || {};
    const gr = dataLoad('gr_history__' + slot) || [];
    const grByDate = {};
    (Array.isArray(gr) ? gr : []).forEach(e => { if (e && e.date) grByDate[e.date] = e; });
    const days = Object.keys(dt).sort().slice(-10).map(day => {
      const rows = Array.isArray(dt[day]) ? dt[day] : [];
      const rowsNet = Math.round(rows.reduce((a, r) => a + (Number(r.pnl) || 0), 0) * 100) / 100;
      const ledgerNet = led[day] ? Math.round(Number(led[day].net) * 100) / 100 : null;
      const historyPnl = grByDate[day] ? Math.round(Number(grByDate[day].pnl) * 100) / 100 : null;
      const agree = (ledgerNet == null && historyPnl == null)
        ? null
        : (Math.abs(rowsNet - (ledgerNet == null ? rowsNet : ledgerNet)) < 0.05
           && Math.abs(rowsNet - (historyPnl == null ? rowsNet : historyPnl)) < 0.05);
      return { day, rowsNet, ledgerNet, historyPnl, agree };
    });
    obs.dataIntegrity = { days };
  } catch (e) { /* unknown */ }

  // Is the signal pipeline producing anything, or running and writing nothing?
  try {
    const day = tradingDayStampIST(Date.now());
    const paths = signalOutcomePaths(day);
    const sigs = readJsonl(paths.ledger);
    const outs = readJsonl(paths.outcomes);
    const armed = sigs.filter(s => signalOutcome.isArmingEvent(s && s.event));
    const newest = sigs.length ? Date.parse(sigs[sigs.length - 1].ts) : null;
    obs.signalPipeline = {
      signalsToday: sigs.length,
      armedToday: armed.length,
      outcomesResolved: outs.length,
      lastSignalAgeH: newest ? Math.round((Date.now() - newest) / 3600000) : null,
    };
  } catch (e) { /* unknown */ }

  try {
    const cfg = loadConfig();
    const rules = getActiveRules();
    obs.accountConfig = {
      accountSize: cfg.accountSize || null,
      configuredStart: rules.eval ? rules.eval.start : null,
      brokerBalance: tvBrokerFeedState.brokerHeaderBalance != null ? tvBrokerFeedState.brokerHeaderBalance : null,
    };
  } catch (e) { /* unknown */ }

  return obs;
}

async function runHealthProtocol(trigger) {
  const startedAt = Date.now();
  try {
    const obs = gatherHealthObservations();
    const result = healthProtocol.evaluate(obs, getActiveRules());

    // Rectifications. Most findings here are REPORT-ONLY by design: flipping a
    // guard the user deliberately turned off, or rewriting stored P&L, are
    // decisions rather than repairs. Only genuinely mechanical restarts act.
    const rectified = [];
    for (const rec of result.rectifications) {
      let evidence = null;
      if (rec.action === 'restart-timers') {
        try {
          startSignalOutcomeResolver();
          startShadowResolver();
          startPanelWatchdog();
          evidence = 'restarted the stopped background timers';
        } catch (e) { evidence = 'timer restart threw: ' + e.message; }
      } else {
        evidence = 'REPORTED ONLY — needs a decision, not an automatic repair';
      }
      rectified.push({ check: rec.key, label: rec.label, action: rec.action, evidence });
    }

    const report = {
      type: 'health-protocol-report',
      protocol: 'system-health',
      trigger: trigger || 'scheduled',
      at: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      passed: result.passed,
      total: result.total,
      failed: result.failed,
      unknown: result.unknown,
      critical: result.critical,
      headline: result.headline,
      checks: result.checks,
      rectified,
    };

    console.log('[protocol:health] ' + result.passed + '/' + result.total + ' passed — ' + result.headline);
    for (const c of result.checks) {
      if (c.verdict === 'pass') continue;
      console.warn('[protocol:health] ' + c.verdict.toUpperCase() + ' ' + c.label + ': ' + (c.impact || '(no impact stated)'));
    }
    for (const r of rectified) console.log('[protocol:health] ' + r.label + ' -> ' + r.evidence);

    broadcast(report);
    try {
      const dir = path.join(DATA_DIR, 'protocols');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'system-health.jsonl'), JSON.stringify(report) + '\n', 'utf8');
    } catch (e) {}
    healthProtocolMarkRun(startedAt);

    if (result.critical > 0) {
      try {
        telegramBot.notify('SYSTEM HEALTH PROTOCOL: ' + result.critical + ' critical issue(s)\n'
          + result.checks.filter(function (c) { return c.verdict === 'fail' && c.severity === 'critical'; })
              .map(function (c) { return '- ' + c.label + ': ' + c.impact; }).join('\n'));
      } catch (e) {}
    }
    return report;
  } catch (e) {
    console.error('[protocol:health] the protocol itself failed:', e.message);
    broadcast({ type: 'health-protocol-report', protocol: 'system-health', error: e.message, at: new Date().toISOString() });
    return null;
  }
}

// Checks hourly whether three days have elapsed. Cheap, and it means the
// cadence holds however often the app is restarted — a 3-day timer that reset
// on every launch would, for a daily-restarted app, never fire.
function startHealthProtocolSchedule() {
  if (healthProtocolTimer) return;
  const tick = function () {
    try {
      if (healthProtocol.isDue(healthProtocolLastRun(), Date.now())) {
        runHealthProtocol('scheduled').catch(function (e) {
          console.warn('[protocol:health] scheduled run failed:', e.message);
        });
      }
    } catch (e) {}
  };
  // First look 3 minutes in, so a fresh install is diagnosed straight away
  // rather than in three days' time.
  setTimeout(tick, 3 * 60 * 1000);
  healthProtocolTimer = setInterval(tick, 60 * 60 * 1000);
  if (healthProtocolTimer.unref) healthProtocolTimer.unref();
}

// ── OVERSIZE GUARD — the enforcement path (2026-08-28) ────────────────────
// The ONLY place besides handleTradeConfirm that can send an order, and unlike
// that one it acts without being asked. Everything here is written on the
// assumption that a wrong action costs Anoop money he was entitled to keep.
//
// Decision logic lives in oversize-guard.js and is unit-tested in isolation;
// this file finds the position, calls it, sends the order, and records what
// happened. It deliberately does no judging of its own.
// ── THE GUARD'S STATE MUST SURVIVE A RESTART (2026-09-02) ──────────────────
// It did not, and that defeated the one rule protecting the account from a
// compounding reduction. Live today:
//
//   11:56:42  ACTING -> SELL 2 MNQU6   (position read 4)
//   11:56:47  STUCK — refusing to send another        <- the rule working
//   12:30:18  guard ARMED and ABLE TO ACT             <- restart, state wiped
//   12:30:30  ACTING -> SELL 2 MNQU6   (position read 4 again)
//   12:30:35  STUCK — refusing to send another
//
// Four contracts sold against a position that read 4 both times. `sentQty` and
// `sizeAtLastAction` — the fields that make "one outstanding reduction at a
// time" mean anything — were in-memory only, so the restart between the two
// episodes reset them to zero and the second reduction sailed straight past the
// check that had just refused the first. This is the 2026-08-31 failure (six
// reductions on a stale read walked a long into a short) arriving through a
// door nobody had closed: the rule was never wrong, it just could not remember.
//
// `actionsToday` was in-memory too, so the daily intervention ceiling was really
// a PER-RESTART ceiling. The guard armed 11 times on 2026-09-02.
//
// Persisting is safe against the obvious objection — "a stale latch will block
// the guard on a genuinely new position tomorrow" — because evaluate() clears
// sentQty/sizeAtLastAction the moment it reads NO POSITION (oversize-guard.js's
// `no position` branch). A new episode always begins from flat, so the latch
// cannot outlive the position it was set for. And rollDay() still resets the
// day's budget on the date change.
const OVERSIZE_STATE_KEY = 'oversize_guard_state';
function loadOversizeState() {
  const fresh = { dayKey: null, confirmCount: 0, lastActionAt: 0, actionsToday: 0, lastSeenSize: null, sentQty: 0, sizeAtLastAction: null };
  try {
    const saved = dataLoad(OVERSIZE_STATE_KEY);
    if (!saved || typeof saved !== 'object') return fresh;
    const st = Object.assign(fresh, saved);
    if (st.sentQty > 0) {
      console.warn('[oversize] restored an OUTSTANDING reduction from before the restart: '
        + st.sentQty + ' contract(s) sent against a position that read ' + st.sizeAtLastAction
        + '. The guard will not send more until it SEES the position shrink or go flat.'
        + ' This is deliberate — a restart must not license a second reduction on the same stale read.');
    }
    return st;
  } catch (e) { return fresh; }
}
function saveOversizeState() {
  try { dataSave(OVERSIZE_STATE_KEY, oversizeState); } catch (e) {}
}
let oversizeState = loadOversizeState();
let oversizeInFlight = false;

// ── IS THE GUARD ACTUALLY WATCHING? (2026-09-02) ──────────────────────────
// Anoop held 5 contracts against a cap of 2 and the guard said nothing, in a
// session where it was armed AND able to send orders. The reading was wrong
// (see netPosition), but the deeper fault was that there was no way to ask
// "is it watching, and what does it currently see?" — the only evidence the
// guard ever produced was a line written when it ACTED. Armed-and-blind and
// armed-and-watching looked identical from outside, and that is the same
// silent-turn-off class the protocols exist to catch.
//
// So the guard now carries a live state, it is broadcast to the UI, and the
// integrity protocol asserts on it. Three things it must be able to answer at
// any moment: is it on, can it act, and when did it last actually SEE the
// positions table.
// Set while a forced positions re-render is in flight to settle a suspected
// stale read. Prevents the 5s watch from queueing a second confirmation behind
// the first — see the stale branch in enforceOversizeGuard.
let oversizeStaleConfirming = false;
let oversizeWatch = {
  lastReadAt: 0,          // last time the positions table was readable
  lastSeenSize: null,     // net size on that read (0 = flat, null = never read)
  lastSeenSymbol: null,
  lastRowCount: 0,        // rows behind that size — >1 means a scaled-in position
  blindReads: 0,          // consecutive unreadable reads
  blindSince: null,
  blindAnnounced: false,
  userDisabled: false,    // explicit runtime OFF, separate from rules.json
};

// How many consecutive unreadable position reads before this is an alarm
// rather than a hiccup. At the 5s watch cadence that is ~15s of blindness.
// Not 1: a single flaky CDP read is normal and alarming on it would train him
// to ignore the alarm, which is worse than not having one.
const OVERSIZE_BLIND_READS_ALARM = 3;
let oversizeStatusPushedAt = 0;

// The whole truth about the guard, in one object. Everything the UI toggle and
// the protocol read comes from here, so there is exactly one answer to "what
// is the guard doing" rather than one per surface.
function oversizeGuardStatus() {
  const cfg = oversizeConfig();
  const armed = cfg.enabled && !oversizeWatch.userDisabled;
  const readAgeMs = oversizeWatch.lastReadAt ? Date.now() - oversizeWatch.lastReadAt : null;
  const blind = oversizeWatch.blindReads >= OVERSIZE_BLIND_READS_ALARM;
  return {
    armed,
    configEnabled: cfg.enabled,
    userDisabled: oversizeWatch.userDisabled,
    canAct: cfg.canAct,
    sizeCap: cfg.sizeCap,
    // The three-state summary the UI badge renders. Deliberately distinguishes
    // "cannot act" from "off": alarm-only is a REAL protection (it shouts) and
    // must not be shown as if the guard were disabled.
    // 'failed' sits ABOVE 'armed': a guard that tried and could not act is not
    // armed in any sense Anoop can use, and saying so is the whole point (see
    // the 2026-09-08 note at the failure site).
    mode: !armed ? 'off'
      : (blind ? 'blind'
        : (oversizeWatch.lastActionFailed ? 'failed'
          : (cfg.canAct ? 'armed' : 'alarm-only'))),
    lastActionFailed: oversizeWatch.lastActionFailed || null,
    blind,
    blindReads: oversizeWatch.blindReads,
    blindSince: oversizeWatch.blindSince,
    lastReadAt: oversizeWatch.lastReadAt || null,
    lastReadAgeMs: readAgeMs,
    lastSeenSize: oversizeWatch.lastSeenSize,
    lastSeenSymbol: oversizeWatch.lastSeenSymbol,
    lastRowCount: oversizeWatch.lastRowCount,
    actionsToday: oversizeState.actionsToday || 0,
    maxPerDay: cfg.maxPerDay,
    // An episode where contracts were sent and the position has not been seen
    // to shrink. The guard is deliberately refusing to send more; he has to
    // close the excess himself, so this must be visible and not just logged.
    stuck: !!oversizeState.stale,
  };
}

// Runtime arm/disarm. Session-only ON PURPOSE — it does not write rules.json,
// so the configured default always comes back on restart and a disarm cannot
// quietly outlive the session that intended it. Every flip is logged, notified
// and broadcast, because the failure this whole feature exists to prevent is a
// protection being off without him knowing.
function handleOversizeGuardToggle(ws, msg) {
  const cfg = oversizeConfig();
  if (!cfg.enabled) {
    // Nothing to toggle: the guard is off in rules.json. Say that rather than
    // accepting a click that would silently do nothing.
    send(ws, { type: 'oversize-guard-status', status: oversizeGuardStatus(),
      note: 'The guard is disabled in rules.json (oversizeGuard.enabled=false). The runtime switch cannot turn it on.' });
    return;
  }
  const want = msg && msg.enabled != null ? !!msg.enabled : oversizeWatch.userDisabled;
  oversizeWatch.userDisabled = !want;
  const line = want
    ? 'OVERSIZE GUARD RE-ARMED' + (cfg.canAct ? ' (will reduce to ' + cfg.sizeCap + ')' : ' (alarm-only — live orders not enabled this session)')
    : 'OVERSIZE GUARD TURNED OFF for this session — size is no longer enforced. It re-arms on restart.';
  console.warn('[oversize] ' + line);
  try {
    const dir = path.join(DATA_DIR, 'protocols');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'oversize-guard.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), day: dayRollup.tradingDayKey(Date.now()),
        mode: 'toggle', armed: want, reason: line }) + '\n', 'utf8');
  } catch (e) {}
  try { telegramBot.notify(line); } catch (e) {}
  broadcastOversizeGuardStatus();
}

function broadcastOversizeGuardStatus() {
  try { broadcast({ type: 'oversize-guard-status', status: oversizeGuardStatus() }); } catch (e) {}
}

// Called by the position watch on EVERY tick — with the rows when the table
// read, and with null when it did not. The null case is the one that matters:
// it used to be a bare `return`, so the guard could be blind for an entire
// session without a single line anywhere saying so.
function noteOversizePositionRead(rows) {
  const cfg = oversizeConfig();
  if (rows) {
    const wasBlind = oversizeWatch.blindReads >= OVERSIZE_BLIND_READS_ALARM;
    const prevSeen = oversizeWatch.lastSeenSize;
    const net = oversizeGuard.netPosition(rows);
    oversizeWatch.lastReadAt = Date.now();
    oversizeWatch.lastSeenSize = net ? net.size : 0;
    oversizeWatch.lastSeenSymbol = net ? net.symbol : null;
    oversizeWatch.lastRowCount = net ? net.rowCount : 0;
    oversizeWatch.blindReads = 0;
    oversizeWatch.blindSince = null;
    // The chip shows the live size and the read age, so it has to be refreshed
    // — but not 12 times a minute for no reason. Push on any CHANGE, and
    // otherwise a heartbeat every 15s so a frozen chip is impossible.
    const changed = prevSeen !== oversizeWatch.lastSeenSize;
    if (changed || Date.now() - oversizeStatusPushedAt > 15000) {
      oversizeStatusPushedAt = Date.now();
      broadcastOversizeGuardStatus();
    }
    if (wasBlind) {
      oversizeWatch.blindAnnounced = false;
      console.warn('[oversize] position reads RECOVERED — the guard can see the account again.');
      try { telegramBot.notify('OVERSIZE GUARD: position reads recovered — watching again.'); } catch (e) {}
      broadcastOversizeGuardStatus();
    }
    return;
  }

  // Unreadable. An unreadable positions table is indistinguishable from a flat
  // account, so this is NOT a quiet state — while it lasts, size is unenforced.
  oversizeWatch.blindReads++;
  if (!oversizeWatch.blindSince) oversizeWatch.blindSince = Date.now();
  if (oversizeWatch.blindReads < OVERSIZE_BLIND_READS_ALARM) return;
  if (oversizeWatch.blindAnnounced) return;      // once per blind episode, not every 5s
  oversizeWatch.blindAnnounced = true;

  const secs = Math.round((Date.now() - oversizeWatch.blindSince) / 1000);
  const msg = 'OVERSIZE GUARD BLIND: the positions table has been unreadable for ~'
    + secs + 's (' + oversizeWatch.blindReads + ' failed reads). Size is NOT being enforced'
    + ' right now — an unreadable table looks exactly like a flat account. Check your own size.';
  console.error('[oversize] ' + msg);
  broadcastOversizeGuardStatus();
  try {
    broadcast({ type: 'oversize-guard', evidence: {
      at: new Date().toISOString(),
      day: dayRollup.tradingDayKey(Date.now()),
      mode: 'blind',
      sizeCap: cfg.sizeCap,
      submitted: false,
      result: { success: false, error: 'positions table unreadable' },
      reason: msg,
    } });
  } catch (e) {}
  try {
    const dir = path.join(DATA_DIR, 'protocols');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'oversize-guard.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), day: dayRollup.tradingDayKey(Date.now()),
        mode: 'blind', blindReads: oversizeWatch.blindReads, blindSince: oversizeWatch.blindSince,
        reason: msg }) + '\n', 'utf8');
  } catch (e) {}
  try { telegramBot.notify(msg); } catch (e) {}

  // ── REPAIR, DON'T ONLY ALARM (2026-09-05) ────────────────────────────────
  // Until today this function's entire response to going blind was to shout.
  // But the cause is nearly always the one runLiveFeedSelfTest() already knows
  // how to fix: the broker panel at the bottom of TradingView is collapsed or
  // its tables have not rendered, so trading_get_account returns a positions
  // table that is indistinguishable from a flat account. That repair
  // (trading_ensure_panel_ready) sat behind a MANUAL click, which means the
  // guard stayed blind for exactly as long as Anoop didn't happen to look at
  // the titlebar — during which size is unenforced.
  //
  // Gated by blindAnnounced, which is set just above and cleared only when
  // reads recover: at most ONE repair attempt per blind episode. It must not
  // become a retry loop — hammering ensure_panel_ready every 5s would fight
  // the poll for withBrokerLock and could itself keep the tables from
  // settling. If the repair fails, the alarm above still stands and the
  // manual "Repair & re-check" button is unchanged.
  console.warn('[oversize] blind — attempting the broker-panel repair automatically');
  runLiveFeedSelfTest().catch(e => console.warn('[oversize] auto-repair attempt failed:', e.message));
}

function oversizeConfig() {
  const r = getActiveRules();
  const g = r.oversizeGuard || {};
  return {
    enabled: g.enabled === true,
    sizeCap: r.sizeCap,
    confirmReads: g.confirmReads,
    maxPerDay: g.maxPerDay,
    cooldownMs: g.cooldownMs,
    // CAN IT ACTUALLY ACT? `trading_place_market_order` is only REGISTERED by
    // tradingview-mcp when TV_ALLOW_LIVE_ORDERS=1, which only the "START
    // CO-PILOT (LIVE ORDERS).bat" launcher sets. Launched the plain way, the
    // tool does not exist and the reducing order cannot be sent no matter how
    // correctly the breach was detected. That gate is Anoop's own standing
    // decision and is NOT loosened here. What changes is that the guard now
    // KNOWS which of its two modes it is in, says so at boot, and alarms
    // instead of firing an order that was never going to land. A guard whose
    // inability to act is only discovered at the moment it needed to act is
    // exactly the silent-turn-off class Protocols 1 and 2 exist to catch.
    canAct: process.env.TV_ALLOW_LIVE_ORDERS === '1',
  };
}

// Said once at boot so the mode is never a surprise mid-session.
function announceOversizeGuard() {
  const cfg = oversizeConfig();
  if (!cfg.enabled) {
    console.log('[oversize] guard is DISABLED (rules.json oversizeGuard.enabled=false) — no size enforcement.');
    return;
  }
  if (cfg.canAct) {
    console.warn('[oversize] guard ARMED and ABLE TO ACT: positions over ' + cfg.sizeCap
      + ' contracts will be reduced back to ' + cfg.sizeCap + ' after '
      + cfg.confirmReads + ' confirming reads.');
  } else {
    console.warn('[oversize] guard ARMED but in ALARM-ONLY mode: it will DETECT an oversize and'
      + ' alert you, but it CANNOT reduce it — live orders are not enabled this session.'
      + ' Launch via "START CO-PILOT (LIVE ORDERS).bat" to let it actually close the excess.');
  }
  console.log('[oversize] position reads are watched — ' + OVERSIZE_BLIND_READS_ALARM
    + ' consecutive unreadable reads raise a BLIND alarm (size unenforced), and the'
    + ' live guard state is on the titlebar chip and checked by the integrity protocol.');
  broadcastOversizeGuardStatus();
}

// The largest NET position on the account, summed per symbol and per side.
//
// 2026-09-02: this used to take the LARGEST ROW per symbol, not the sum, and
// that is why the guard sat silent through a real 5-lot. Tradovate renders one
// row PER POSITION (there is a Position ID column), so five 1-lot scale-ins
// read as `1` — inside the cap, nothing to do, nothing logged. It only ever
// worked when the whole size arrived in a single order, which is exactly the
// shape of the 08-31 and 09-01 entries in the evidence log.
//
// The arithmetic and the row-key handling now live in oversize-guard.js, so
// the reading is unit-tested next to the decision that consumes it rather than
// buried in this file. See netPosition()'s header for why summing is bounded
// per (symbol, side) and why a hedged symbol comes back with a blank side.
const largestPosition = oversizeGuard.netPosition;

// One-shot latch so a stuck read alarms ONCE per episode, not every 5s poll.
// Cleared the moment the guard can act again (the read moved) or the day rolls.
let oversizeStaleAnnounced = false;

function enforceOversizeGuard(rows) {
  const cfg = oversizeConfig();
  if (!cfg.enabled) return;
  // Runtime OFF is separate from rules.json OFF so the switch he flips in the
  // UI cannot be confused with the configured default, and so flipping it back
  // ON needs no restart. Both are reported by oversizeGuardStatus().
  if (oversizeWatch.userDisabled) return;
  if (oversizeInFlight) return;          // an order is already going out

  const dayKey = dayRollup.tradingDayKey(Date.now());
  oversizeState = oversizeGuard.rollDay(oversizeState, dayKey);

  const pos = largestPosition(rows);
  const verdict = oversizeGuard.evaluate(pos, oversizeState, cfg, Date.now());
  oversizeState = verdict.state;
  oversizeState.dayKey = dayKey;
  // Written on every evaluation, not only on an action: the fields that matter
  // (sentQty, sizeAtLastAction) are set by the ACT path and cleared by an
  // ordinary read seeing the position shrink or go flat. Persisting only on
  // action would save the latch and never save the release.
  saveOversizeState();

  if (!verdict.act) {
    // A STUCK READ is not a quiet "waiting" state — it means contracts were
    // sent, the position has not been seen to move, and the app no longer
    // knows what is actually open. That has to reach him, not sit in a debug
    // line. Escalated once per stuck episode (not every 5s poll) so it stays
    // an alarm rather than becoming noise he learns to ignore.
    if (verdict.state && verdict.state.stale) {
      // ── CONFIRM THE STALENESS BEFORE DECLARING IT (2026-09-02) ──────────
      // The refusal above is correct and is NOT being relaxed: having sent
      // contracts, the guard must not send more until the position is SEEN to
      // shrink (2026-08-31 — six reductions on a stale read walked a long into
      // a short). What is wrong is the EVIDENCE, not the rule.
      //
      // The confirming read comes from the positions table, and that table only
      // repaints while its tab is showing. Behind another tab it returns the
      // PRE-ORDER size indefinitely — so a reduction that actually filled looks
      // identical to one that did nothing. Live on 2026-09-02: 11:56:44
      // "REDUCED 4 -> 2", 11:56:47 "still reads 4", STUCK. Again at 12:30. He
      // then switched the guard OFF for the session, which left size unenforced
      // against a broker ceiling of 40 micros and a cap of 2 — the worst
      // possible outcome, reached by the guard being right in a way it could
      // not demonstrate.
      //
      // So: force one genuine re-render and re-read first. If the position DID
      // shrink, the order landed, the guard re-arms and says nothing. If it
      // still reads the same on a table we just watched repaint, then STUCK is
      // a real finding and it alarms exactly as before.
      //
      // NOTE the log line above this is also misleading and is fixed below:
      // "REDUCED" is printed on order SUBMISSION, not on a confirmed size
      // change. It should never have claimed the past tense.
      if (!oversizeStaleAnnounced && !oversizeStaleConfirming) {
        oversizeStaleConfirming = true;
        (async () => {
          try {
            const raw = await withBrokerLock(function () {
              return mcpBridge.callTool('trading_refresh_panel_table', { table: 'positions' });
            });
            const fix = parseToolResult(raw);
            if (fix && fix.ok && Array.isArray(fix.positions)) {
              const fresh = largestPosition(fix.positions);
              const freshSize = fresh ? Number(fresh.size) : 0;
              const actedOn = verdict.state.sizeAtLastAction;
              if (actedOn != null && freshSize < actedOn) {
                console.warn('[oversize] NOT stuck — the positions table was stale. A forced re-render reads '
                  + freshSize + ' (was ' + actedOn + ' when we acted): the reducing order DID land.');
                // Feed the real reading back through the guard. Its own
                // "shrank" branch clears sentQty and re-confirms from scratch
                // before any further action — no state is hand-edited here.
                oversizeState = oversizeGuard.evaluate(fresh, oversizeState, cfg, Date.now()).state;
                oversizeState.dayKey = dayKey;
                saveOversizeState();
                tvLastPositions = fix.positions;
                broadcastOversizeGuardStatus();
                return;
              }
              console.error('[oversize] STUCK CONFIRMED against a freshly re-rendered positions table: still '
                + freshSize + ' after sending ' + verdict.state.sentQty + '. This is real — close the excess yourself.');
            } else {
              console.error('[oversize] could not force the positions table to re-render — cannot tell a stale read from a real one.');
            }
          } catch (e) {
            console.error('[oversize] stale-read confirmation threw: ' + e.message);
          } finally {
            oversizeStaleConfirming = false;
          }
        })();
        return;   // the next 5s tick reports, with the question settled
      }
      if (!oversizeStaleAnnounced) {
        oversizeStaleAnnounced = true;
        console.error('[oversize] STUCK: ' + verdict.reason);
        broadcast({
          type: 'oversize-guard',
          evidence: {
            at: new Date().toISOString(),
            day: dayKey,
            observed: { size: pos.size, side: pos.side, symbol: pos.symbol },
            sizeCap: cfg.sizeCap,
            mode: 'stuck-read',
            submitted: false,
            result: { success: false, error: verdict.reason },
            reason: verdict.reason
          }
        });
        try {
          const dir = path.join(DATA_DIR, 'protocols');
          fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(path.join(dir, 'oversize-guard.jsonl'),
            JSON.stringify({ at: new Date().toISOString(), day: dayKey, mode: 'stuck-read', reason: verdict.reason,
              observed: { size: pos.size, side: pos.side, symbol: pos.symbol } }) + '\n', 'utf8');
        } catch (e) {}
        try { telegramBot.notify('OVERSIZE GUARD STUCK: ' + verdict.reason); } catch (e) {}
      }
      return;
    }
    // Only speak when something is oversized but not yet actionable — the
    // "within the cap" case is the normal state and must stay silent.
    if (pos && Number(pos.size) > Number(cfg.sizeCap)) {
      console.log('[oversize] ' + verdict.reason);
    }
    return;
  }
  // Any actionable verdict means the read moved again — re-arm the alarm.
  oversizeStaleAnnounced = false;

  oversizeInFlight = true;
  const started = Date.now();
  const evidence = {
    at: new Date(started).toISOString(),
    day: dayKey,
    // rowCount is recorded because the 2026-09-02 fault was invisible without
    // it: a 5-lot read as `1` and a 5-lot read as `5` looked the same in this
    // log. rowCount > 1 means the size is a SUM across position rows.
    observed: { size: pos.size, side: pos.side, symbol: pos.symbol,
      rowCount: pos.rowCount, mixedSides: pos.mixedSides, unparseableRows: pos.unparseableRows },
    sizeCap: cfg.sizeCap,
    action: { side: verdict.side, qty: verdict.reduceBy },
    reason: verdict.reason,
    mode: cfg.canAct ? 'reduce' : 'alarm-only',
    submitted: false,
    result: null,
  };

  // ALARM-ONLY: the breach is real and confirmed, but this session cannot send
  // an order. Say so in the loudest terms available and stop — attempting the
  // call would only produce an "unknown tool" error and bury the one thing
  // that matters (there are too many contracts on RIGHT NOW) inside a stack
  // trace. The daily cap is still consumed so the alarm cannot loop forever.
  if (!cfg.canAct) {
    evidence.result = { success: false, error: 'live orders not enabled this session (TV_ALLOW_LIVE_ORDERS not set at launch)' };
    evidence.durationMs = Date.now() - started;
    oversizeInFlight = false;
      // No order was (or could be) sent, so do not leave the outstanding-
      // reduction latch set. Keeping sentQty here would make the guard report
      // STUCK forever after a mere alarm-only detection — a false "I sent a
      // reducing order" state. Cooldown and daily cap remain consumed so this
      // cannot turn into a tight retry loop.
      oversizeState = Object.assign({}, oversizeState, { sentQty: 0, sizeAtLastAction: null, stale: false });
      saveOversizeState();
    console.error('[oversize] OVERSIZE DETECTED (' + pos.size + ' on ' + pos.symbol
      + ', cap ' + cfg.sizeCap + ') but this session CANNOT act — CLOSE ' + verdict.reduceBy
      + ' CONTRACTS YOURSELF.');
    try {
      const dir = path.join(DATA_DIR, 'protocols');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'oversize-guard.jsonl'), JSON.stringify(evidence) + '\n', 'utf8');
    } catch (e) {}
    broadcast({ type: 'oversize-guard', evidence });
    broadcastOversizeGuardStatus();
    try {
      telegramBot.notify('OVERSIZE: ' + pos.size + ' contracts on ' + pos.symbol
        + ' against a cap of ' + cfg.sizeCap + '. I CANNOT close it this session —'
        + ' CLOSE ' + verdict.reduceBy + ' YOURSELF NOW.');
    } catch (e) {}
    return;
  }

  console.warn('[oversize] ACTING: ' + verdict.reason
    + ' -> ' + verdict.side.toUpperCase() + ' ' + verdict.reduceBy + ' ' + (pos.symbol || ''));

  (async () => {
    try {
      // The symbol is passed so the MCP layer refuses the order outright if the
      // ticket is showing a different instrument. No stop/target: this is a
      // reducing order, and the unverified bracket automation would refuse the
      // whole thing if a field could not be set — exactly the wrong failure
      // mode when the point is to take risk OFF.
      // T1.3: routed through the one gateway. kind 'reduce' is risk-reducing,
      // so the trading rules cannot block it — this order exists to take risk
      // OFF, and gating it behind a day-stop would be exactly backwards.
      const gwRes = await placeMarketOrder({
        kind: 'reduce',
        side: verdict.side,
        qty: verdict.reduceBy,
        symbol: pos.symbol,
      });
      const res = gwRes.result || null;
      evidence.submitted = !!gwRes.ok;
      evidence.result = res;
      if (gwRes.refused) evidence.refusedReason = gwRes.reason;

      if (evidence.submitted) {
        // 2026-09-02: was "REDUCED 4 -> 2", printed the instant the order was
        // ACCEPTED. It claimed a completed reduction that had not been observed
        // yet, so the log read as a success three seconds before the same
        // episode reported STUCK. Submission and confirmation are different
        // facts and the log now says which one this is.
        console.warn('[oversize] reducing order SUBMITTED: ' + verdict.side.toUpperCase() + ' ' + verdict.reduceBy
          + ' on ' + pos.symbol + ' (' + pos.size + ' -> ' + cfg.sizeCap + ' once filled) — awaiting a confirming position read.');
      } else {
        console.error('[oversize] the reducing order was REFUSED: ' + JSON.stringify(res));
      }
    } catch (e) {
      evidence.result = { success: false, error: e.message };
      console.error('[oversize] reducing order threw: ' + e.message);
    } finally {
      oversizeInFlight = false;
      evidence.durationMs = Date.now() - started;
      // If the order was never submitted, there is no outstanding reduction to
      // wait on — clear the latch so a later poll can retry after cooldown.
      // Only an actually-submitted order may leave sentQty set until the
      // position is seen to shrink.
      if (!evidence.submitted) {
        oversizeState = Object.assign({}, oversizeState, { sentQty: 0, sizeAtLastAction: null, stale: false });
        saveOversizeState();
        // ── 2026-09-08: A FAILED ATTEMPT MUST CHANGE WHAT THE BADGE SAYS ─────
        // On 2026-09-08 the guard did its job right up to the last step: it
        // saw 8 lots against a cap of 4, decided SELL 4, and called the order
        // gateway — which threw `side control button not found:
        // side-control-sell`, because TradingView's order ticket was not
        // rendered. It logged the failure to oversize-guard.jsonl, broadcast an
        // evidence event and sent a Telegram message to a bot with no token.
        //
        // The badge kept saying "Size guard: ARMED · cap 4". So from where
        // Anoop was sitting, a guard that had just PROVED it could not act was
        // indistinguishable from one standing watch — and 10, 12 and 8-lot
        // trades followed on the same day.
        //
        // Detection was never the problem. Being told is. This records the
        // failure so the badge, the self-test and the status payload all report
        // "CANNOT REDUCE" instead of "ARMED". Cleared only by a submit that
        // actually succeeds, or by the IST day rollover.
        oversizeWatch.lastActionFailed = {
          at: Date.now(),
          error: (evidence.result && evidence.result.error) || 'order was not submitted',
          size: pos.size,
          symbol: pos.symbol,
          wanted: verdict.reduceBy,
        };
      } else {
        oversizeWatch.lastActionFailed = null;
      }
      try {
        const dir = path.join(DATA_DIR, 'protocols');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'oversize-guard.jsonl'), JSON.stringify(evidence) + '\n', 'utf8');
      } catch (e) {}
      broadcast({ type: 'oversize-guard', evidence });
      broadcastOversizeGuardStatus();
      try {
        telegramBot.notify('OVERSIZE GUARD: ' + (evidence.submitted ? 'reduced' : 'TRIED AND FAILED to reduce')
          + ' ' + pos.size + ' -> ' + cfg.sizeCap + ' contracts on ' + pos.symbol
          + (evidence.submitted ? '' : ' — CLOSE THE EXCESS YOURSELF'));
      } catch (e) {}
    }
  })();
}

function scheduleFeedIntegrityProtocol(delayMs) {
  if (feedProtocolTimer) clearTimeout(feedProtocolTimer);
  feedProtocolTimer = setTimeout(function () {
    feedProtocolTimer = null;
// PROTOCOL 3 runs on the same startup pass and again hourly. It is cheap
    // (pure, reads three small JSON files) and the fault it catches is silent by
    // nature — nobody goes looking for "is the number on screen supported?".
    try {
      // Bar recorder: once a day, after the NY window. Polled every 10 min rather
      // than fired at an exact time so a restart mid-evening still catches the
      // day instead of skipping it. Guarded by a day key so it runs once.
      setInterval(function () {
        try {
          const ist = new Date(Date.now() + (5.5 * 3600000));
          const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
          const dayKey = tradingDayStampIST(Date.now());
          if (mins >= 1290 && global.__barRecDay !== dayKey) {   // 21:30 IST
            global.__barRecDay = dayKey;
            runBarRecorder('scheduled');
          }
        } catch (e) { console.warn('[bars] schedule check failed:', e.message); }
      }, 10 * 60 * 1000);

      // SELF-REPAIR (2026-09-02). The daily schedule above can only catch a day
      // the server is actually running for. This catches the day it was NOT.
      // Runs once per boot, after the same 45s TV-settle delay the protocols
      // use, so the chart is connected before it switches timeframes.
      runBarRecordSelfRepair('startup').catch(function (e) {
        console.warn('[bars:repair] startup self-repair failed:', e.message);
      });

      runTrustProtocol('startup');
      setInterval(function () { runTrustProtocol('hourly'); }, 60 * 60 * 1000).unref?.();

      // ── Hourly HTF evidence (2026-09-02) ─────────────────────────────────
      // Fired at 2 minutes PAST the hour, not on it. The 1H candle closes on
      // the hour, and readHTFNow deliberately drops the forming bar — so a
      // read taken at :00 reports the candle before last and would look one
      // hour stale every single time. Two minutes lets the close settle, the
      // same reason the bar-aligned watchers use a settle delay.
      //
      // The startup line is posted immediately and on purpose: after a restart
      // "are the watchers actually up?" is the exact question, and making him
      // wait up to an hour for the answer defeats the point.
      publishHtfStatus('startup', true).catch(function (e) {
        console.warn('[htf] startup status failed:', e.message);
      });
      const msPastHour = Date.now() % (60 * 60 * 1000);
      const untilNext = ((60 + 2) * 60 * 1000 - msPastHour) % (60 * 60 * 1000);
      setTimeout(function () {
        publishHtfStatus('hourly', true).catch(function () {});
        setInterval(function () {
          publishHtfStatus('hourly', true).catch(function () {});
        }, 60 * 60 * 1000).unref?.();
      }, untilNext).unref?.();
    } catch (e) { console.warn('[protocol:trust] startup schedule failed:', e.message); }
    runFeedIntegrityProtocol('startup').catch(function (e) {
      console.warn('[protocol:feed] scheduled run failed:', e.message);
    });
  }, delayMs == null ? 45000 : delayMs);
}

function scheduleLiveFeedSelfTest(delayMs) {
  if (liveFeedSelfTestTimer) clearTimeout(liveFeedSelfTestTimer);
  liveFeedSelfTestTimer = setTimeout(() => {
    liveFeedSelfTestTimer = null;
    runLiveFeedSelfTest().catch(e => console.warn('[self-test] failed to run:', e.message));
  }, delayMs == null ? 15000 : delayMs);
}

// ── Phase 2b: trade confirm/execute (2026-08-17) ────────────────────────────
// See PHASE2_SEMI_AUTONOMOUS_SPEC.md. Enforcement lives HERE, server-side —
// a disabled Confirm button in the browser is a courtesy, not a guarantee;
// this is the only place that can actually call trading_place_market_order,
// and it re-checks independently every time regardless of what the client
// already believes.
//
// Double-submit guard (Eng review's top-flagged bug, 2026-08-17): the
// requestId-seen check and the mark-as-seen write happen SYNCHRONOUSLY,
// before any `await` — Node's single-threaded event loop means there is no
// interleaving window in which two near-simultaneous trade-confirm-request
// messages could both pass the check. Logic extracted to trade-confirm-dedup.js
// so it's unit-tested including a simulated race, not just inline logic
// nobody can exercise without a live WS connection.
const tradeConfirmDedupState = tradeConfirmDedup.createDedupState();
const TRADE_CONFIRM_DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 min — well past any plausible legitimate retry

// 2026-08-23 (7.3): every rejection used to be its own bare `send(ws, ...)`,
// six of them, so a block reached exactly one socket and nothing else — no
// durable record beyond a console.log that crash-logger prunes at 14 days, and
// no way for any live surface to show it. That made "show me every time the
// system said no" unanswerable, which was the whole reason the live-surface
// work started. One helper now owns the reply AND the recording, so a future
// rejection branch cannot forget to record: the only way to reject is to call
// this. Behaviour of the order path itself is unchanged — same message, same
// socket, same early return.
// ── T4.1: the account state the drawdown gate needs ────────────────────────
// The trailing floor was only ever computed in the renderer, so the process
// that can actually refuse an order had no idea how close the account was to
// death. s1 closed $9.44 above its floor on 2026-08-28 and nothing could act.
// Closed-day nets come from the same per-account ledger the renderer reads;
// the live balance prefers the broker's own header figure.
function currentAccountRisk() {
  try {
    const rules = getActiveRules();
    const ev = rules.eval || {};
    if (!Number.isFinite(Number(ev.start)) || !Number.isFinite(Number(ev.maxDrawdown))) return null;
    const slot = activeSlotId();
    if (!slot) return null;
    const ledger = dataLoad('balance_ledger__' + slot) || {};
    const nets = Object.keys(ledger).sort().map((d) => ledger[d] && ledger[d].net);
    const brokerBal = tvBrokerFeedState && Number.isFinite(tvBrokerFeedState.brokerHeaderBalance)
      ? tvBrokerFeedState.brokerHeaderBalance : null;
    const r = accountFloor.floorAndHeadroom({
      start: Number(ev.start),
      maxDrawdown: Number(ev.maxDrawdown),
      floorLocksAt: Number(ev.floorLocksAt),
      dailyNets: nets,
      liveBalance: brokerBal,
    });
    // A floor with no readable balance is not usable by the gate — headroom
    // would be a guess, and guessing here either traps him or lets him die.
    if (r.floor == null || r.balance == null) return null;
    return { balance: r.balance, floor: r.floor, headroom: r.headroom, locked: r.locked };
  } catch (e) {
    console.warn('[account-risk] could not compute:', e.message);
    return null;
  }
}

// ── T1.3: the ONLY function that may place a market order ──────────────────
// Three call sites used to reach the broker tool directly, each with its own
// idea of what was allowed. Everything now routes through one decision (see
// order-gateway.js), so a new order path cannot be added without passing it.
//
// `kind` matters: 'reduce'/'flatten' lower risk and are never blocked by the
// trading rules — blocking a flatten because the day-stop tripped would trap a
// losing position open. 'open' takes on risk and is fully gated.
//
// It CANNOT prevent an order typed straight into TradingView. That is stated in
// order-gateway.preventsManualOrders and must never be implied otherwise.
async function placeMarketOrder(intent, opts) {
  const o = opts || {};
  const decision = orderGateway.decideOrder(intent, {
    liveOrdersEnabled: process.env.TV_ALLOW_LIVE_ORDERS === '1',
    brokerReady: !!(mcpBridge.ready && mcpBridge.tvConnected),
    guard: o.guard || null,
  });
  if (!decision.allowed) {
    console.log('[order-gateway] REFUSED ' + decision.kind + ' ' + intent.side + ' ' + intent.qty
      + ' ' + intent.symbol + ': ' + decision.reason);
    try { recordLiveEvent('block', 'BLOCK', decision.reason); } catch (_) {}
    return { ok: false, refused: true, reason: decision.reason, decision };
  }
  try {
    const raw = await withBrokerLock(() => mcpBridge.callTool('trading_place_market_order', {
      side: intent.side, qty: intent.qty, symbol: intent.symbol,
    }));
    const result = parseToolResult(raw);
    const ok = !!(result && result.success);
    console.log('[order-gateway] ' + decision.kind.toUpperCase() + ' ' + intent.side + ' ' + intent.qty
      + ' ' + intent.symbol + ': ' + (ok ? 'SUBMITTED' : 'FAILED'));
    return { ok, refused: false, result, raw, decision };
  } catch (e) {
    console.warn('[order-gateway] order threw:', e.message);
    return { ok: false, refused: false, error: e.message, decision };
  }
}

function rejectTicket(ws, requestId, reason) {
  send(ws, { type: 'trade-confirm-rejected', requestId: requestId || null, reason });
  // Never let bookkeeping break the refusal — the refusal is the safety
  // behaviour, the record is a convenience.
  try { recordLiveEvent('block', 'BLOCK', reason); } catch (_) {}
}

async function handleTradeConfirm(ws, msg) {
  const requestId = msg && msg.requestId;
  const { sourceVerdictId, side, symbol, qty, stopPrice, targetPrice } = msg || {};

  const dedup = tradeConfirmDedup.checkAndMark(tradeConfirmDedupState, requestId, sourceVerdictId, Date.now(), TRADE_CONFIRM_DEDUP_WINDOW_MS);
  if (!dedup.ok) {
    rejectTicket(ws, requestId, dedup.reason);
    return;
  }

  try {
    if (process.env.TV_ALLOW_LIVE_ORDERS !== '1') {
      rejectTicket(ws, requestId, 'live orders are not enabled this session (TV_ALLOW_LIVE_ORDERS was not set at launch)');
      return;
    }
    if (!mcpBridge.ready || !mcpBridge.tvConnected) {
      rejectTicket(ws, requestId, 'TradingView is not connected');
      return;
    }

    const sideNorm = String(side || '').toLowerCase();
    const qtyNum = Number(qty);
    if (sideNorm !== 'buy' && sideNorm !== 'sell') {
      rejectTicket(ws, requestId, `invalid side: ${side}`);
      return;
    }
    if (!Number.isFinite(qtyNum) || qtyNum <= 0 || Math.floor(qtyNum) !== qtyNum) {
      rejectTicket(ws, requestId, `invalid size: ${qty}`);
      return;
    }

    // NO OVERRIDE — the one rules check that gates real execution. Reuses the
    // same pure logic the manual/live-feed guardrail already enforces
    // (tv-broker-feed.js's `trades` shape), extended in trade-confirm-rules.js.
    const rules = getActiveRules();
    // T4.1 (2026-09-04): the 5th argument is what makes the drawdown headroom
    // gate live. Without it checkTradeAllowed skipped that block entirely — the
    // gate was written, tested, and did nothing on the only path that places
    // real orders. currentAccountRisk() returns null when the balance or floor
    // cannot be read, and the gate then skips as before rather than guessing.
    const accountRisk = currentAccountRisk();
    // G9: price the stop distance against the per-trade cap BEFORE the order.
    // quote_get is a READ, fetched OUTSIDE withChartLock (the one critical
    // section that must not lengthen around a read); pointValue resolves from the
    // contracts block; riskCapUsd is the tighter of {mode cap, perTradeMaxLoss}.
    // A stopless or unpricable ticket is refused by checkTradeAllowed, not guessed.
    let lastPrice = null;
    try {
      const q = await mcpBridge.callTool('quote_get', {});
      const lp = q && (q.lastPrice != null ? q.lastPrice : q.last);
      if (lp != null) { const n = Number(lp); if (Number.isFinite(n)) lastPrice = n; }
    } catch (e) { /* lastPrice stays null → refused, not guessed */ }
    const _riskCap = autonomyModes.riskCapUsd(rules, currentAutonomyMode());
    const _pvSpec = requireContractSpec(symbol || chartSymbolCache.symbol);
    const _riskParam = {
      side: sideNorm,
      stopPrice: stopPrice != null ? Number(stopPrice) : null,
      lastPrice,
      pointValue: _pvSpec ? _pvSpec.pointValue : null,
      riskCapUsd: _riskCap,
    };
    const check = tradeConfirmRules.checkTradeAllowed(rules, currentMode, tvBrokerFeedState.trades, qtyNum, accountRisk, _riskParam);
    if (!check.allowed) {
      console.log(`[trade-confirm] BLOCKED requestId=${requestId}: ${check.reason}`);
      rejectTicket(ws, requestId, check.reason);
      return;
    }

    // T1.3 (2026-09-04): the same refusal decision every other order path takes.
    // The call below is not routed through placeMarketOrder() on purpose — it
    // sits inside withChartLock, deliberately avoids withBrokerLock (see the
    // comment at the order call), and carries a stop/target bracket the
    // gateway's intent shape does not model. Rerouting it would change locking
    // on the one path that opens real risk. Taking the DECISION here keeps
    // order-gateway.js the single answer to "may this order go out?" while
    // leaving the mechanics that were argued for in place.
    const gwDecision = orderGateway.decideOrder(
      { kind: 'open', side: sideNorm, qty: qtyNum, symbol: symbol || 'unknown' },
      {
        liveOrdersEnabled: process.env.TV_ALLOW_LIVE_ORDERS === '1',
        brokerReady: !!(mcpBridge.ready && mcpBridge.tvConnected),
        guard: check,
      }
    );
    if (!gwDecision.allowed) {
      console.log(`[order-gateway] REFUSED open ${sideNorm} ${qtyNum}: ${gwDecision.reason}`);
      rejectTicket(ws, requestId, gwDecision.reason);
      return;
    }

    // Consumed BEFORE the order call, not after — deliberate. If the order
    // attempt below fails (network blip, DOM timing), this verdict/ticket
    // can no longer be retried; Anoop needs a fresh debate call for a new
    // one. That's a usability cost, but the alternative (leaving the verdict
    // reusable until a confirmed success) reopens exactly the stale-ticket
    // replay window the Eng review flagged — failing toward "can't retry
    // easily" is the safe direction here, matching the no-override philosophy.
    tradeConfirmDedup.consumeVerdict(tradeConfirmDedupState, sourceVerdictId);

    // Resolve the live symbol server-side — the client/Judge never gets to
    // decide what symbol actually gets submitted (see trade-ticket-parse.js's
    // header comment on why symbol is deliberately never parsed from the
    // verdict text).

    // Symbol resolution AND order placement run inside ONE withChartLock call
    // (not two separate ones) — otherwise something else queued on the same
    // lock (a chart/symbol switch) could interleave in the gap between "read
    // the symbol" and "place the order", letting the symbol go stale in that
    // split second. One lock call = one atomic unit.
    //
    // 2026-08-19: deliberately stays on withChartLock, NOT the new
    // withBrokerLock the broker-feed poll moved to — this is the one
    // broker-adjacent operation that genuinely needs serialization against
    // chart/SYMBOL switches specifically (PO3's secondary-symbol watch calls
    // chart_set_symbol; an interleaving switch here could place an order on
    // the wrong instrument, a correctness risk that outweighs the latency
    // cost). The broker poll itself is a simple read in a different DOM
    // region (positions/orders tables, not the order ticket) — safe to let
    // it interleave with this, and doing so is what actually fixes the
    // "poll queued for minutes behind chart monitors" latency bug found live
    // today.
    tvOrderPlacementInFlight = true;
    const raw = await withChartLock(async () => {
      let resolvedSymbol = symbol || null;
      try {
        const stateRes = await mcpBridge.callTool('chart_get_state', {});
        const state = parseToolResult(stateRes);
        if (state && state.symbol) resolvedSymbol = state.symbol;
      } catch (e) { /* fall back to client-supplied symbol, if any */ }

      const orderArgs = { side: sideNorm, qty: qtyNum, symbol: resolvedSymbol };
      if (stopPrice != null) orderArgs.stopPrice = Number(stopPrice);
      if (targetPrice != null) orderArgs.targetPrice = Number(targetPrice);
      const orderRaw = await mcpBridge.callTool('trading_place_market_order', orderArgs);
      return { orderRaw, resolvedSymbol };
    }).finally(() => { tvOrderPlacementInFlight = false; });
    const result = parseToolResult(raw.orderRaw);
    const resolvedSymbol = raw.resolvedSymbol;

    // Durable log BEFORE attempting to notify the client (Eng review: a
    // dropped WS connection right after a real fill would otherwise leave no
    // record at all that an order was placed). console.log is mirrored to
    // disk by crash-logger.js's installConsoleMirror, loaded first in this
    // file specifically so nothing can log before that mirror is active.
    console.log(`[trade-confirm] ORDER ${result && result.success ? 'SUBMITTED' : 'FAILED'} requestId=${requestId} side=${sideNorm} qty=${qtyNum} symbol=${resolvedSymbol} stop=${stopPrice != null ? stopPrice : 'none'} target=${targetPrice != null ? targetPrice : 'none'} result=${JSON.stringify(result)}`);

    if (!result || result.success === false) {
      send(ws, { type: 'trade-confirm-result', requestId, success: false, error: (result && result.error) || 'order placement failed' });
      // 7.3b: an order that was ATTEMPTED against the live account and failed
      // is at least as worth recording as one that was refused before trying.
      try { recordLiveEvent('decision', 'ORDER FAILED', (result && result.error) || 'order placement failed'); } catch (_) {}
      return;
    }
    // 2026-08-19: placeMarketOrder() started returning verified/verifyDetail
    // (its own post-submit getPositions()/getOrders() readback, see
    // trading.js) but this response never forwarded them — a caller reading
    // trade-confirm-result had success:true with no way to tell an actually-
    // confirmed fill apart from an unconfirmed submit. Surfacing both now so
    // the UI/user isn't presented a plain "success" when the order's real
    // state is still unconfirmed.
    send(ws, { type: 'trade-confirm-result', requestId, success: true, submittedLabel: result.submittedLabel, stopPrice: result.stopPrice, targetPrice: result.targetPrice, verified: result.verified, verifyDetail: result.verifyDetail });
    // 7.3b: a REAL ORDER on the live account — the single most consequential
    // event this process produces, and until now it reached one socket and a
    // console.log that crash-logger prunes at 14 days. `verified === false`
    // means the click fired but the readback found neither a matching position
    // nor a Working/Filled order, so it must NOT be shown the same as a
    // confirmed fill (same distinction the UI already draws).
    try {
      recordLiveEvent('decision',
        result.verified === false ? 'ORDER UNCONFIRMED' : 'ORDER',
        String(result.submittedLabel || (sideNorm + ' ' + resolvedSymbol + ' ×' + qtyNum)) +
        (result.verified === false ? ' — not confirmed against broker' : ''));
    } catch (_) {}
  } catch (e) {
    console.error(`[trade-confirm] requestId=${requestId} uncaught error:`, e.message);
    send(ws, { type: 'trade-confirm-result', requestId, success: false, error: e.message || 'unexpected error' });
    try { recordLiveEvent('decision', 'ORDER ERROR', e.message || 'unexpected error'); } catch (_) {}
  }
}

// SINGLE-INSTANCE GUARD (2026-07-29, Anoop: "if i open two windows are opening
// in the browser"). Launching the app twice used to start a SECOND server that
// failed on the port but still ran `start http://localhost:7433`, leaving him
// with duplicate browser windows pointing at the same app — and no clear
// answer to "which one should be on". Now a second launch detects the running
// instance, just focuses/opens the existing app, and exits without starting
// anything. One server, one window, always.
httpServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log(`\nCo-Pilot is already running on http://localhost:${PORT} — opening that instead of starting a second copy.\n`);
    try { require('child_process').exec(`start http://localhost:${PORT}`); } catch (e) {}
    process.exit(0);
  }
  console.error('HTTP server error:', err);
  process.exit(1);
});

httpServer.listen(PORT, '127.0.0.1', async () => {
  initDataDir();   // 2026-07-25: resolve D:\co-pilot DATA (or fall back) before anything writes
  h6LoadStatus();  // 5.2/H6: restore the per-trade attribution gate state
  // 6.2: load the hour-edge table, rebuild when absent/stale, refresh weekly.
  try {
    const heRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'hour-edge.json'), 'utf8'));
    if (heRaw && typeof heRaw === 'object') hourEdgeTable = heRaw;
  } catch (e) { refreshHourEdge(); }
  setInterval(refreshHourEdge, 7 * 24 * 3600 * 1000);
  // 2026-08-19: restore today's live trade-tracking state now that DATA_DIR
  // is final — see the note at tvBrokerFeedState's declaration for why this
  // can't happen at module top-level. Must run before startTVBrokerMonitor()
  // (below) starts polling, or the very first poll would fold against a
  // still-fresh state and immediately overwrite whatever was just restored.
  tvBrokerFeedState = loadTVBrokerFeedState();
  startTradovate();
  // 2026-08-27: arm the broker-panel watchdog HERE, unconditionally, not
  // only inside the mcpBridge 'tv-connected' handler.
  //
  // That event fires once, on a TRANSITION (`if (!wasConnected)` in
  // mcp-bridge.js). If the health probe succeeds before this file has
  // attached its listener — or TradingView was already connected — the
  // event is simply lost and the watchdog never starts. That is exactly
  // what happened on the first restart after it was written: no
  // '[panel-watchdog] armed' line appeared at all, because the code was
  // correct and never ran.
  //
  // Every tick already self-guards on mcpBridge.ready && tvConnected, so
  // arming before TradingView is up costs one boolean check per minute and
  // removes the entire class of missed-event failures. The on-connect call
  // stays as belt-and-braces; startPanelWatchdog() is idempotent.
  startPanelWatchdog();
  announceOversizeGuard();
  // ── Per-mode autonomy folders (2026-08-29) ──────────────────────────────
  // Anoop: "each mode should have separate folder to avoid confusion." The
  // original layout put machine orders and his own trades in ONE flat file at
  // the autonomy root, told apart only by a `kind` field. Migrating at boot
  // means the layout is correct before anything can write to it this session.
  //
  // Idempotent and non-destructive: legacy files are RENAMED, never deleted,
  // and it refuses outright if the new layout already has content rather than
  // appending the same rows a second time and silently doubling a track record.
  try {
    const mig = autonomyStore.migrateLegacyLayout(DATA_DIR, { stamp: 'migrated-' + tradingDayStampIST(Date.now()) });
    if (mig.ran) {
      console.log('[autonomy] migrated to per-mode folders: ' + mig.machineOrders + ' machine order(s), '
        + mig.humanTrades + ' human trade(s), ' + mig.outcomes + ' outcome(s), ' + mig.dailyFiles + ' daily rollup(s).'
        + ' Legacy files kept alongside with a .migrated-* suffix.');
    }
    if (mig.notes.length) mig.notes.forEach((n) => console.log('[autonomy] migration note: ' + n));
  } catch (e) { console.warn('[autonomy] layout migration skipped:', e.message); }
  startWeeklyReportSchedule();
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Co-Pilot — http://localhost:${PORT}  ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  const cfg = loadConfig();
  // ── AI brain (2026-09-02: one provider, one model) ────────────────────────
  // Logged first and loudly, because "which brain is actually answering" is the
  // single question this banner exists to answer — and getting it wrong is what
  // made the old five-provider setup confusing enough to be worth removing.
  if (cfg.deepseekApiKey) {
    groqAgent.initDeepSeek(cfg.deepseekApiKey);
    console.log(cfg.disableDeepSeek
      ? '⚠  DeepSeek key loaded but DISABLED by kill switch — running on the Gemini backup'
      : `✓ DeepSeek key loaded — PRIMARY brain for all agents (${providerChain.DEFAULT_DEEPSEEK_MODEL})`);
  } else console.log('⚠  No DeepSeek key — open Settings. Running on the Gemini backup only.');
  if (cfg.geminiApiKey) { groqAgent.initGemini(cfg.geminiApiKey); console.log('✓ Gemini key loaded (break-glass backup only)'); }
  else console.log('ℹ  No Gemini backup key — if DeepSeek fails or runs out of credit, agents will go silent');

  // 2026-08-12 (task #32): sweep temp files left by a write that was
  // interrupted by a crash. These are always disposable — a .tmp still on disk
  // is by definition one whose rename never completed, so its contents were
  // never the live file. Reported rather than silent: a non-zero count here is
  // evidence the process died mid-write last session, which is worth knowing.
  try {
    const swept = atomicWrite.cleanupTemps(DATA_DIR)
                + atomicWrite.cleanupTemps(path.join(DATA_DIR, 'accounts'));
    if (swept) console.log(`✓ Cleared ${swept} interrupted-write temp file(s) — the app died mid-save last session`);
  } catch (e) {}
  startJessiTVMonitor();
  console.log('✓ Jessi background chart monitor started (3-min cadence)');
  startTVBrokerMonitor();
  console.log('✓ TradingView broker-account monitor started (10s cadence, polls only while TV is connected)');
  startTVPositionWatch();
  console.log(`✓ Live position watch started (${TV_POSITION_WATCH_MS / 1000}s cadence — open/close/scale detected here, then folded immediately by the account poll)`);
  startNowFileWriter();
  console.log(`✓ Mode: ${(cfg.mode || 'funded').toUpperCase()}`);

  // 2026-08-11 (Anoop): "I don't want telegram to work... remove them."
  // The bot is no longer started, so it holds no long-poll connection and can
  // no longer fail at startup or mid-session. telegramBot.notify() calls are
  // scattered through the monitors and are safe no-ops while stopped, so they
  // are deliberately left in place rather than ripped out of a dozen call
  // sites during a live-trading week. To re-enable: flip TELEGRAM_ENABLED to
  // true. Nothing else needs to change.
  const TELEGRAM_ENABLED = false;
  // G18: make the deadness LEGIBLE instead of silent. 24 notify/notifyPhoto call
  // sites are no-ops while this is false — including the oversize-guard BLIND
  // alarm and the live-feed / system-health protocol alarms, the two that
  // genuinely need an answer. Not re-enabled: Anoop's 2026-09-04 decision stands.
  console.log('[telegram] TELEGRAM_ENABLED=false — 24 notify/notifyPhoto call sites are silent no-ops (incl. the oversize BLIND alarm and the live-feed/system-health protocol alarms).');
  try {
    if (TELEGRAM_ENABLED) telegramBot.start({
      loadConfig,
      saveConfig,
      getCurrentMode: () => currentMode,
      setCurrentMode,
      broadcast,
      engulfMonitors,
      ENGULF_TFS,
      startEngulfMonitor,
      stopEngulfMonitor,
      checkEngulfingSignal,
      sfpMonitors,
      SFP_TFS,
      startSFPMonitor,
      stopSFPMonitor,
      checkSFPSignal
    });
  } catch (e) {
    console.log('⚠ Telegram bot: failed to start —', e.message);
  }

  await startMCP();
  startNewsTracking();
  startMechanicalAnalysis();
  startSessionPrepScheduler();
  startEndDayAutosaveWatch();
  startWatcherLivenessWatch();

  const { exec } = require('child_process');
  exec(`start http://localhost:${PORT}`);
  console.log('✓ Opening in browser…');
});

process.on('SIGINT', () => {
  // 1.2 (SIGNAL_LOOP_PLAN A5): forEach passes (key, index, array) — pass the
  // key explicitly so a future second parameter can never receive the index.
  Object.keys(engulfMonitors).forEach(k => stopEngulfMonitor(k));
  Object.keys(fvgMonitors).forEach(k => stopFVGMonitor(k));
  Object.keys(sfpMonitors).forEach(k => stopSFPMonitor(k));
  stopNewsTracking();
  stopMechanicalAnalysis();
  stopSessionPrepScheduler();
  mcpBridge.stop();
  telegramBot.stop();
  process.exit(0);
});
