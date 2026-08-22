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
const providerChain = require('./provider-chain'); // provider selection + fail-open chain (unit-tested)
const stageRules = require('./stage-rules');       // eval/funded risk layer (unit-tested)
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
const telegramBot = require('./telegram-bot');
const booksIndex = require('./books-index');
const tradovate = require('./tradovate');
const tvBrokerFeed = require('./tv-broker-feed'); // balance-delta-at-flat P&L fold for the TradingView broker feed (unit-tested)
const mistakePatterns = require('./mistake-patterns'); // live pattern-matching against Anoop's own documented failure history (2026-08-19, F1 first slice — advisory only, unit-tested)
const positionEvents = require('./position-events'); // fast open/close/scale/flip detector for the 5s positions watch (2026-08-20, pure + unit-tested)
const tradeConfirmRules = require('./trade-confirm-rules'); // Phase 2a/2b rule-check for the confirm/execute flow — unit-tested
const tradeTicketParse = require('./trade-ticket-parse'); // Phase 2b: pure parser for JUDGE_PERSONA's TRADE_TICKET line — unit-tested
const playbookC = require('./playbook-c'); // Playbook C engulfing validity + shared closed-bar helper — unit-tested
const tradeConfirmDedup = require('./trade-confirm-dedup'); // Phase 2b: double-submit/idempotency guard — unit-tested

const PORT = 7433;
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
  return providerChain.primaryProviderModel(loadConfig(), groqAgent.isOmniRouteReady());
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
  sessionWindowsIST: [
    { name: 'London', startMin: 810, endMin: 900 },
    { name: 'NY', startMin: 1140, endMin: 1260 }
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
  try { return Object.assign({}, DEFAULT_RULES, JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'))); }
  catch { return Object.assign({}, DEFAULT_RULES); }
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
  return stageRules.applyStageRules(merged, st);
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
// Wipe one account's whole folder — used by "Start fresh" so no layer survives.
function dataWipeAccount(slotId) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(String(slotId || ''))) return false;
  try {
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
            anthropic: !!cfg.apiKey,
            gemini: !!cfg.geminiApiKey,
            groq: !!cfg.groqApiKey,
            omniroute: !!cfg.omniRouteApiKey
          },
          omniRouteHealthy: groqAgent.isOmniRouteReady()
        },
        tradingview: {
          bridgeReady: !!mcpBridge.ready,          // our child process is up
          tvConnected: !!mcpBridge.tvConnected     // CDP actually reachable — these diverge, and that divergence caused a false "connected" indicator before
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

  const filePath = path.join(__dirname, 'renderer', url);

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
  send(ws, { type: 'mode-update', mode: currentMode });
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
      case 'checklist-done':   handleChecklistDone(ws, msg); break;
      case 'account-db-rebuild': handleAccountDbRebuild(ws, msg); break;
      case 'journey-action':   handleJourneyAction(ws, msg); break;
      case 'journey-list':     handleJourneyList(ws, msg);   break;
      case 'mode-switch':      handleModeSwitch(ws, msg);  break;
      case 'engulf-monitor-toggle': handleEngulfToggle(msg); break;
      case 'engulf-check-now': checkEngulfingSignal(msg.tf || '1h'); break;
      case 'tv-broker-check-now': pollTVBrokerAccount(); break;
      case 'trade-confirm-request': handleTradeConfirm(ws, msg); break;
      case 'fvg-monitor-toggle': handleFVGToggle(msg); break;
      case 'fvg-check-now': checkFVGSignal(msg.tf || '30m'); break;
      case 'sfp-monitor-toggle': handleSFPToggle(msg); break;
      case 'watchers-get': send(ws, { type: 'watchers-status', data: buildWatchersStatus() }); break;
      case 'signal-decision': handleSignalDecision(ws, msg); break;
      case 'armed-setup-get': send(ws, { type: 'armed-setup', setup: readArmedSetup() }); break;
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
          saveRules(Object.assign(loadRules(), msg.data || {}));
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
        send(ws, { type: 'data-loaded', reqId: msg.reqId, data: dataLoad(msg.key) });
        break;
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
  if (msg.key === 'apiKey') claudeAgent.init(msg.value);
  if (msg.key === 'groqApiKey') groqAgent.init(msg.value);
  if (msg.key === 'geminiApiKey') groqAgent.initGemini(msg.value);
  if (msg.key === 'apiKey') groqAgent.initAnthropic(msg.value);
  if (msg.key === 'omniRouteApiKey') { groqAgent.initOmniRoute(msg.value, cfg.omniRouteBaseUrl); groqAgent.probeOmniRouteHealth(); }
  if (msg.key === 'omniRouteBaseUrl') { groqAgent.initOmniRoute(cfg.omniRouteApiKey, msg.value); groqAgent.probeOmniRouteHealth(); }
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
    if (align) extraContext = `### Where he's at (his own dated reflections — read before coaching, don't just cite it, actually factor it in):\n${align}`;
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
  { type: 'function', function: { name: 'draw_remove_one', description: 'Remove a single drawing by its entity ID (get IDs from draw_list).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'alert_create', description: 'Create a TradingView price alert.', parameters: { type: 'object', properties: { name: { type: 'string' }, condition: { type: 'string' }, price: { type: 'number' }, message: { type: 'string' } }, required: ['name', 'condition', 'price'] } } },
  { type: 'function', function: { name: 'alert_list', description: 'List all active TradingView alerts.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'alert_delete', description: 'Delete a TradingView alert by ID.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } }
];

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
  } }
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
    const gr = (parseLS('copilot_gr_history', []) || []).slice(-1)[0] || {};
    const tMode = rules.tradingMode || 'standard';
    out.push(`STATUS — ${sizeLabel} ${currentMode.toUpperCase()} account (currently open) · Trading mode: ${tMode.toUpperCase()}:`);
    out.push(`- Balance $${acc.balance != null ? acc.balance : '?'} · today's P&L $${acc.profit != null ? acc.profit : '?'} · trades today ${gr.n != null ? gr.n : '?'}.`);
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
      const raw = name === 'market_key_levels' ? await getKeyLevelsSnapshot() : await mcpBridge.callTool(name, args || {});
      return (raw && raw.content) ? raw.content.map(c => c.text || '').join('\n') : JSON.stringify(raw);
    }
    if (name === 'app_get_data') {
      return jessiAppGetData((args && args.section) || 'status');
    }
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
function formatAlignmentNotes(limit) {
  try {
    const list = dataLoad('align_notes');
    if (!Array.isArray(list) || !list.length) return null;
    const recent = list.slice(0, limit || 3);
    return recent.map(e => {
      const d = e.ts ? new Date(e.ts).toISOString().slice(0, 10) : '?';
      return `- [${d}] ${e.text}`;
    }).join('\n');
  } catch (e) { return null; }
}

// Shared IST date/time anchor prepended to EVERY agent's system prompt/context.
// All app data and uploaded Tradovate CSVs are IST wall-clock; without this,
// agents guessed the date (a previously hardcoded date in claude-agent.js went
// ~6 weeks stale, so "yesterday" gave today and day-of-week was wrong).
// Computed fresh per call so it never goes stale.
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
    '. This is a LIVE position, not a closed trade — its P&L is floating and is not in the day total below.';
}

function formatLiveFeedContext() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) return null;
  if (tvBrokerFeedReadOk !== true) return null;
  const st = tvBrokerFeedState;
  const confirmed = (st.trades || []).filter(t => !t.pnlUnknown);
  const unconfirmed = (st.trades || []).filter(t => t.pnlUnknown);
  const lines = [
    `Live broker feed (today, real trades — not the CSV): ${st.tradeCount} trade(s), confirmed day P&L $${st.dayPnl.toFixed(2)} (from ${confirmed.length} trade(s) this instance watched close)` +
      (unconfirmed.length ? `, plus ${unconfirmed.length} trade(s) recovered from order history with $ unconfirmed (check the broker for exact P&L on those)` : '') + '.'
  ];
  if (st.wasFlat === false) lines.push(`A position is currently OPEN (size ${st.sizeSeenThisTrade}) — not yet counted, will fold in on close.`);
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
  parts.push(`## DATA CONTEXT (open account — treat as ground truth)`);
  parts.push(`Active account: ${(cfg.accountSize || '150k').toUpperCase()} ${currentMode.toUpperCase()} — balance $${acc.balance || '?'}, today's P&L $${acc.profit != null ? acc.profit : '?'}.`);
  parts.push(`For cost/insights/trades/scalp/checklist/roadmap/history/rules call app_get_data(section) — "scalp" is the per-day hold-time/gap breakdown. To act call app_do. This open account only. No trades.`);

  // Even in minimal (voice) context, a single most-recent Alignment entry is
  // worth the few extra tokens — it's usually one short dated line, and it's
  // exactly the continuity ("where his head's at") voice coaching needs too.
  const minimalAlign = formatAlignmentNotes(1);
  if (minimalAlign) parts.push(`\n### Where his head's at (most recent):\n${minimalAlign}`);

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
  if (fullAlign) parts.push(`\n### Where his head's at (his own dated reflections — read before coaching, don't just cite it, actually factor it in):\n${fullAlign}`);
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
    if (align) parts.push('\n## WHERE HE\'S AT (his own dated reflections — for awareness, not yours to diagnose)\n' + align);
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

    const judgeContext = `## JESSI'S ARGUMENT (Discipline & Psychology)\n${jessiArgument.text}\n\n## ANALYSIS AGENT'S ARGUMENT (Technical & Market)\n${analysisArgument.text}\n\n## ICT POWER OF 3 ARGUMENT (AMD phase — Accumulation / Manipulation / Distribution)\n${po3Argument.text}${biasBlock}${liveBlock}\n\n## ORIGINAL QUESTION\n${lastUserText}`;

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
// London 13:30 IST, NY 19:00 IST — matches rules.json sessionWindowsIST.
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
let lastAutoDebateAt = 0;
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
  return `Automated check (not typed by Anoop): ${phaseInfo.symLabel || 'the instrument'} just moved from ${phaseInfo.from || 'ACCUMULATION'} to ${phaseInfo.phase} on the 15m at ${phaseInfo.time} IST (1H bias: ${phaseInfo.biasLabel || 'unknown'}). Is this a valid entry right now?`;
}

function autoTriggerDebate(phaseInfo, preGathered) {
  const now = Date.now();
  if (now - lastAutoDebateAt < AUTO_DEBATE_COOLDOWN_MS) {
    console.log('[auto-debate] skipped — within ' + Math.round(AUTO_DEBATE_COOLDOWN_MS / 60000) + 'min cooldown of the last auto-triggered debate');
    return Promise.resolve();
  }
  lastAutoDebateAt = now;
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
  if (now - lastAutoDebateAt < AUTO_DEBATE_COOLDOWN_MS) {
    console.log('[playbook-debate] skipped — within ' + Math.round(AUTO_DEBATE_COOLDOWN_MS / 60000) + 'min cooldown of the last auto-triggered debate');
    return Promise.resolve();
  }
  lastAutoDebateAt = now;
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
        ledgerSignal({ event: 'po3-phase-change', playbook: 'PO3', tf: '15', direction: bias ? bias.direction : null, structure: res.reason + (res.detail ? ' | ' + res.detail : ''), valid: res.phase !== 'UNCLEAR', rejectReason: res.phase === 'UNCLEAR' ? res.reason : null });

        // 2026-08-17: auto-trigger the expensive Debate only on the one
        // transition that actually matters — LEAVING accumulation. Staying in
        // accumulation, or any other transition (e.g. back INTO accumulation),
        // is deliberately not a trigger; per JUDGE_PERSONA, accumulation alone
        // is always a WAIT, so there is nothing new to check by re-running the
        // debate while still in it.
        if (prev === 'ACCUMULATION' && (res.phase === 'MANIPULATION' || res.phase === 'DISTRIBUTION')) {
          autoTriggerDebate({ from: prev, phase: res.phase, symLabel, biasLabel, time: istTime, message: msg });
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
          if (Date.now() - lastAutoDebateAt >= AUTO_DEBATE_COOLDOWN_MS) {
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

// Gathers multi-timeframe bars for the AMD read. Uses market_multi_tf, which
// switches timeframes and AUTO-RESTORES the original — important because this
// drives Anoop's live chart and must not leave it on the wrong TF mid-session.
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
  parts.push('\n## TIME: ' + istNow + ' IST (London 13:30-15:00, NY 19:00-21:00 IST)');

  // 2026-08-07: same "known by all agents" pass as gatherAnalysisContext —
  // PO3 stays a mechanical AMD-phase read, this is visibility, not a mandate
  // to comment on it.
  try {
    const align = formatAlignmentNotes(2);
    if (align) parts.push('\n## WHERE HE\'S AT (his own dated reflections — for awareness, not yours to diagnose)\n' + align);
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
  } }
];

function makeScalperToolExecutor() {
  return async (name, args) => {
    if (name === 'app_get_data') return jessiAppGetData((args && args.section) || 'scalp');
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
      if (align) seed.push('\n## WHERE HIS HEAD\'S AT (his own dated reflections — read before coaching)\n' + align);
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
  const { reqId, audioBase64, mimeType, messages } = msg;
  // 2026-07-23: two input paths now.
  //  (a) msg.transcript present → browser already did STT (Web Speech API,
  //      free/unlimited) — skip Groq Whisper entirely.
  //  (b) audioBase64 present → legacy path, Groq Whisper transcribes.
  // And msg.clientTts:true → the browser will speak the reply with its own
  // speechSynthesis (free/unlimited, Indian voice available) — so we skip the
  // Groq Orpheus call and just return the reply text. This removes 2 of the 3
  // Groq calls per turn, which is what was burning the daily token budget.
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
    const stCfg = loadConfig();
    const omniRouteCanStt = !stCfg.disableOmniRoute && groqAgent.isOmniRouteReady();
    const needsGroqStt = !(typeof msg.transcript === 'string' && msg.transcript.trim()) && !omniRouteCanStt;
    const needsGroqTts = !clientTts;
    const brainIsGroq = (stCfg.voiceBrain || 'gemini') === 'groq';
    if ((needsGroqStt || needsGroqTts || brainIsGroq) && !groqAgent.isReady()) {
      const why = needsGroqStt ? 'speech-to-text' : needsGroqTts ? 'speech playback' : 'the Groq voice brain';
      send(ws, { type: 'jessi-voice-error', reqId, message: `Groq API key needed for ${why}. Add a free key from console.groq.com in Settings (or switch the voice brain to Gemini and let the browser handle speech).` });
      return;
    }
    if (!brainIsGroq && !groqAgent.isGeminiReady() && !groqAgent.isReady()) {
      send(ws, { type: 'jessi-voice-error', reqId, message: 'No AI key configured. Add a free Gemini key (aistudio.google.com/apikey) or Groq key in Settings.' });
      return;
    }

    let transcript;
    if (typeof msg.transcript === 'string' && msg.transcript.trim()) {
      transcript = msg.transcript.trim();
    } else {
      const audioBuffer = Buffer.from(audioBase64 || '', 'base64');
      if (!audioBuffer.length) {
        send(ws, { type: 'jessi-voice-error', reqId, message: 'No speech received — try again.' });
        return;
      }
      // 2026-08-07: OmniRoute/Speechmatics tried first when configured
      // (Anoop's ask — "omnirouter as primary, groq as second option"),
      // falling back to Groq Whisper on ANY failure (unreachable, upstream
      // provider auth error, whatever) — same fail-open pattern as the text
      // agents. Deliberately not routed through groqAgent.stream()'s chain
      // machinery since transcription is a one-shot multipart call, not a
      // streamed chat turn; a simple try/catch covers it.
      // 2026-08-11 (Anoop): "I don't want speechmatics to work. remove them."
      // Speechmatics-via-OmniRoute is now skipped entirely — STT goes straight
      // to Groq Whisper. This removes one live external dependency from the
      // voice path; the OmniRoute branch below is left commented rather than
      // deleted so re-enabling is a one-line change if it's ever wanted.
      //   if (!cfg.disableOmniRoute && groqAgent.isOmniRouteReady()) {
      //     try { transcript = await groqAgent.transcribeAudioOmniRoute(audioBuffer, mimeType); }
      //     catch (e) { transcript = await groqAgent.transcribeAudio(audioBuffer, mimeType); }
      //   }
      transcript = await groqAgent.transcribeAudio(audioBuffer, mimeType);
    }
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

    // Voice brain switcher (Settings): 'gemini' (cloud Flash-Lite, NEW default
    // 2026-07-25), 'groq' (cloud, gpt-oss-20b), 'ollama-llama' (local
    // llama3.1:8b), or 'ollama-qwen' (local qwen2.5:3b).
    // 2026-07-25: default moved from Groq to Gemini for the same TPM reason as
    // text chat (250K vs 6-8K tokens/min), and the old 'groq' option's model ID
    // changed from llama-3.1-8b-instant to openai/gpt-oss-20b because Groq
    // deprecated the Llama IDs on 2026-06-17 (retiring 08/16/26).
    // Note: voice STT (Whisper) and TTS (Orpheus) are still Groq-only — this
    // switch only changes which model does the REASONING, so a Groq key is
    // still needed for server-side voice unless the browser handles STT/TTS.
    const voiceBrain = loadConfig().voiceBrain || 'gemini';
    let brainProvider = 'gemini', brainModel = 'gemini-3.5-flash';
    if (voiceBrain === 'groq') { brainProvider = 'groq'; brainModel = 'openai/gpt-oss-20b'; }
    else if (voiceBrain === 'ollama-llama') { brainProvider = 'ollama'; brainModel = 'llama3.1:8b'; }
    else if (voiceBrain === 'ollama-qwen') { brainProvider = 'ollama'; brainModel = 'qwen2.5:3b'; }
    else {
      // 'gemini' (default brain) is the only choice OmniRoute is allowed to
      // preempt — an explicit groq/ollama pick in Settings is a deliberate
      // choice and stays untouched.
      const voicePrimary = primaryProviderModel();
      brainProvider = voicePrimary.provider;
      brainModel = voicePrimary.model;
    }

    // Same ordered fallback chain as text chat (see handleJessiChat) so a
    // retired Gemini model ID or an exhausted quota degrades instead of
    // failing the turn. Local Ollama brains get no chain — they're already
    // unlimited, and silently jumping to a cloud vendor would contradict the
    // whole point of picking a local brain.
    const brainChain = brainProvider === 'ollama' ? undefined : fallbackChainFor({ provider: brainProvider, model: brainModel });

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
    // edge-tts.js header) is now tried FIRST for the speaking voice, per
    // Anoop's ask for a human-sounding voice he can use all day. Ladder:
    //   1. Edge TTS neural (en-IN-NeerjaNeural by default, Settings picker)
    //   2. clientTts → browser speechSynthesis (unlimited, robotic-ish)
    //   3. legacy Groq Orpheus (English-only, burns Groq quota)
    // Setting the voice to "browser" in Settings skips Edge entirely.
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
      const clips = await groqAgent.synthesizeSpeech(fullReply, 'autumn');
      send(ws, { type: 'jessi-voice-audio', reqId, fullText: fullReply, clips, mime: 'audio/wav', answeredBy: replyAnsweredBy });
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
    const result = await mcpBridge.callTool(name, args || {});
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
  '15m': { tfCode: '15', label: '15M', intervalMs: 30 * 1000 }
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
  mon.interval = setInterval(() => checkEngulfingSignal(key), ENGULF_TFS[key].intervalMs);
}

function stopEngulfMonitor(key) {
  const mon = engulfMonitors[key];
  if (mon.interval) {
    clearInterval(mon.interval);
    mon.interval = null;
  }
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
    let pbc = null;
    if (found && direction) {
      // 5 bars cannot support a structure read — pull real history the same way
      // checkSFPSignal does, then drop the still-forming bar.
      const fullBars = playbookC.dropFormingBar(
        await getFullBars(cfg.tfCode, playbookC.PBC_HISTORY_BARS), cfg.tfCode);
      const pdhpdl = await getPDHPDL();
      pbc = playbookC.validateEngulfPlaybookC(fullBars, direction, pdhpdl);
      if (!pbc.valid) {
        const rejectKey = direction + '_' + key + '_rej_' +
          (fullBars.length ? fullBars[fullBars.length - 1].time : 0);
        if (rejectKey !== mon.lastRejectKey) {
          mon.lastRejectKey = rejectKey;
          console.log(`ENGULF REJECTED [${cfg.label}]: ${direction} — ${pbc.reason}`);
          // 2.1: rejections are data — the Playbook C filter rate per TF is
          // only measurable if rejections are written.
          ledgerSignal({ event: 'playbook-c-reject', playbook: 'C', tf: cfg.tfCode, direction, source, valid: false, rejectReason: pbc.reason, structure: pbc.structure });
        }
        broadcast({
          type: 'engulf-check', tf: key, time: mon.lastCheck,
          found: false, rejected: true, direction,
          reason: pbc.reason, structure: pbc.structure
        });
        return;
      }
    }

    // ── Fire notification if found and not duplicate ─────────────────────────
    if (found && direction) {
      // 15-min dedup bucket per monitor — don't fire same direction twice in 15 mins
      const bucket = direction + '_' + key + '_' + Math.floor(Date.now() / (15 * 60 * 1000));
      if (bucket !== mon.lastSignalKey) {
        mon.lastSignalKey = bucket;
        const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

        // Playbook A: a 1H engulfing only counts as a real setup if it agrees
        // with the 4H trend. Only checked for the 1H monitor — that's the TF
        // Playbook A actually pairs with the 4H filter.
        let alignNote = '';
        let playbookAValid = false; // 3.3: A debates only fire on a WITH-trend 1H engulf
        if (key === '1h') {
          const trend = await get4HTrend();
          if (trend === 'bullish' || trend === 'bearish') {
            const withTrend = (trend === 'bullish' && direction === 'BULLISH') || (trend === 'bearish' && direction === 'BEARISH');
            playbookAValid = withTrend;
            alignNote = withTrend
              ? ` — WITH 4H trend (${trend}), Playbook A valid`
              : ` — AGAINST 4H trend (${trend}), Playbook A says NO ACTION`;
          } else {
            alignNote = ' — 4H trend unclear, confirm manually before acting';
          }
        }

        const signalMessage = `${direction} Engulfing on ${cfg.label} at ${istTime} IST${alignNote} — check a lower TF for entry`;
        broadcast({
          type: 'engulf-signal',
          playbook: key === '1h' ? 'A' : 'C',
          structure: pbc ? pbc.structure : null,
          validity: pbc ? pbc.reason : null,
          tf: key,
          tfLabel: cfg.label,
          direction,
          source,
          time: istTime,
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
        ledgerSignal({ event: 'engulf-fire', playbook: key === '1h' ? 'A' : 'C', tf: cfg.tfCode, direction, source, structure: pbc ? pbc.structure : null });
        armSetup({ playbook: key === '1h' ? 'A' : 'C', tfCode: cfg.tfCode, tfLabel: cfg.label, direction, message: signalMessage });
        // 3.3: validated Playbook A (1H WITH 4H trend) convenes the debate.
        if (key === '1h' && playbookAValid) {
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
function detectEngulfFromBars(bars) {
  if (!bars || bars.length < 2) return null;
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];
  if ([prev.open, prev.close, prev.high, prev.low, curr.open, curr.close, curr.high, curr.low].some(v => typeof v !== 'number')) return null;

  if (prev.close < prev.open && curr.close > curr.open) {
    if (curr.high >= prev.high && curr.low <= prev.low) {
      return { direction: 'BULLISH' };
    }
  }
  if (prev.close > prev.open && curr.close < curr.open) {
    if (curr.high >= prev.high && curr.low <= prev.low) {
      return { direction: 'BEARISH' };
    }
  }
  return null;
}

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

function classifyTrendFromBars(bars) {
  if (!bars || bars.length < 3) return 'unclear';
  let higherHighs = 0, higherLows = 0, lowerHighs = 0, lowerLows = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].high > bars[i - 1].high) higherHighs++;
    else if (bars[i].high < bars[i - 1].high) lowerHighs++;
    if (bars[i].low > bars[i - 1].low) higherLows++;
    else if (bars[i].low < bars[i - 1].low) lowerLows++;
  }
  const n = bars.length - 1;
  const threshold = Math.ceil(n * 0.6);
  if (higherHighs >= threshold && higherLows >= threshold) return 'bullish';
  if (lowerHighs >= threshold && lowerLows >= threshold) return 'bearish';
  return 'unclear';
}

// ── Fair Value Gap (FVG) detector — Playbook B's displacement step ─────────────
// Classic 3-candle gap: bar[i-2] and bar[i] leave a price range bar[i-1] never
// traded into. Bullish FVG when bar[i-2].high < bar[i].low (gap up); bearish
// when bar[i-2].low > bar[i].high (gap down). This detects the gap existing —
// it does NOT confirm the SFP/liquidity-raid that should precede it per the
// full JadeCap playbook. See FVG_TFS block below for why that part is deferred.
function detectFVGFromBars(bars) {
  if (!bars || bars.length < 3) return null;
  const a = bars[bars.length - 3];
  const c = bars[bars.length - 1];
  if ([a.high, a.low, c.high, c.low].some(v => typeof v !== 'number')) return null;

  if (a.high < c.low) return { direction: 'BULLISH', gapLow: a.high, gapHigh: c.low };
  if (a.low > c.high) return { direction: 'BEARISH', gapLow: c.high, gapHigh: a.low };
  return null;
}

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
  mon.interval = setInterval(() => checkFVGSignal(key), FVG_TFS[key].intervalMs);
}

function stopFVGMonitor(key) {
  const mon = fvgMonitors[key];
  if (mon.interval) { clearInterval(mon.interval); mon.interval = null; }
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
      const bucket = direction + '_' + key + '_' + Math.floor(Date.now() / (15 * 60 * 1000));
      if (bucket !== mon.lastSignalKey) {
        mon.lastSignalKey = bucket;
        const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        const signalMessage = `${direction} FVG on ${cfg.label} at ${istTime} IST — gap ${gapLow.toFixed(2)}-${gapHigh.toFixed(2)}, watch for retrace entry`;
        broadcast({ type: 'fvg-signal', tf: key, tfLabel: cfg.label, direction, gapLow, gapHigh, time: istTime, message: signalMessage });
        telegramBot.notify(`🔲 ${signalMessage}`);
        console.log(`FVG SIGNAL [${cfg.label}]: ${direction} ${gapLow.toFixed(2)}-${gapHigh.toFixed(2)}`);
        // 2.1/2.2: ledger + arm the displacement FVG.
        ledgerSignal({ event: 'fvg-fire', playbook: 'B', tf: cfg.tfCode, direction, gapLow, gapHigh, source: 'FVG OHLCV' });
        armSetup({ playbook: 'B', tfCode: cfg.tfCode, tfLabel: cfg.label, direction, gapLow, gapHigh, message: signalMessage });
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

// 3.1: market-state line — pure formatter (market-state.js) for the armed
// setup + mechanical 1H bias injected into the shared agent context block.
const marketState = require('./market-state');

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
function makeLock(name) {
  let chain = Promise.resolve();
  let timeoutStreak = 0;
  // 0.1 observability: queue depth is logged whenever the lock is contended,
  // so chart-lock saturation (the plan's #1 risk) is visible in the log
  // instead of assumed. Getters exposed for the Chart Watchers panel (1.4).
  let queueDepth = 0;
  let maxQueueDepth = 0;
  return function withLock(fn) {
    queueDepth++;
    if (queueDepth > maxQueueDepth) maxQueueDepth = queueDepth;
    if (queueDepth > 1) console.log(`[${name}] queue depth ${queueDepth}`);
    // 2026-08-19: captured synchronously, at the moment of the CALL, not the
    // moment of the (much later) timeout — this is the one piece of
    // information that's been missing while chasing the unhandled-rejection
    // crash: every timeout error looks identical ("operation exceeded
    // 30000ms"), so the crash log alone can't say WHICH of the ~8 call sites
    // sharing this lock was actually the unhandled one. Appended to the
    // timeout error's own stack below so the next occurrence is diagnosable
    // from the log directly instead of guessed at.
    const callerStack = new Error().stack;
    const run = chain.then(fn, fn);
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timeoutStreak++;
        console.error(`[${name}] operation exceeded ${LOCK_TIMEOUT_MS}ms (streak: ${timeoutStreak}) — releasing the lock for the next caller instead of freezing the whole live feed. The original call may still complete in the background; its result is discarded.`);
        const err = new Error(`${name}: operation exceeded ${LOCK_TIMEOUT_MS}ms`);
        err.stack += '\n--- withLock() was CALLED from ---\n' + callerStack;
        reject(err);
      }, LOCK_TIMEOUT_MS);
    });
    const winner = Promise.race([run, timeout]);
    // Chain advances on whichever settles first. If `run` itself eventually
    // settles after we've already moved on (post-timeout), its result/error
    // is deliberately ignored here — swallowed so it can never become an
    // unhandled rejection — a future caller must never wait on a call this
    // function already gave up on.
    const release = () => { queueDepth = Math.max(0, queueDepth - 1); };
    run.then(() => { clearTimeout(timer); release(); }, () => { clearTimeout(timer); release(); });
    run.catch(() => {});
    chain = winner.then(
      () => { timeoutStreak = 0; },
      () => {} // rejection (including our own timeout) still advances the chain — never gets permanently stuck on one bad link
    );
    // 2026-08-19 BUG FIX (found live, same session, same day): a timeout
    // still crashed the process with an unhandled-rejection log line despite
    // the guards above — because THOSE guards attach handlers to `run` and to
    // a *derived* promise (`chain = winner.then(...)`), not to `winner`
    // itself, the exact value returned to the caller. If a caller ever
    // invokes withChartLock/withBrokerLock without awaiting or catching the
    // result (a fire-and-forget call, which existed among today's monitor
    // callers), `winner`'s own rejection has zero handlers attached to IT
    // specifically and Node reports it as unhandled — confirmed live,
    // moments after the split above shipped. Attaching a no-op `.catch()`
    // directly to `winner` guarantees it always has at least one handler,
    // regardless of what any caller does, while the SAME `winner` object is
    // still returned below — a well-behaved caller's own `await`/`.catch()`
    // on it keeps working exactly as before; this only closes the gap for
    // callers that don't.
    winner.catch(() => {});
    withLock.queueDepth = () => queueDepth;
    withLock.maxQueueDepth = () => maxQueueDepth;
    return winner;
  };
}
const withChartLock = makeLock('withChartLock');
const withBrokerLock = makeLock('withBrokerLock');

// 0.1: cached symbol read so cache keys can be per-symbol without adding a
// chart_get_state round-trip to every bar read. 10s staleness is safe — the
// PO3 monitor re-reads every 60s and resets its state on symbol change, and
// the secondary-symbol watch clears the bar cache on every switch.
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

async function getFullBars(tfCode, count) {
  const symbol = await getChartSymbolCached();
  const cached = barCache.get(symbol, tfCode, count);
  if (cached) return cached;
  const bars = await withChartLock(() => _getFullBarsUnlocked(tfCode, count));
  if (Array.isArray(bars) && bars.length) barCache.set(symbol, tfCode, count, bars);
  return bars;
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
function getSwingLevels(bars) {
  const highs = [], lows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const w = bars.slice(i - 2, i + 3);
    if (bars[i].high === Math.max(...w.map(b => b.high))) highs.push(bars[i].high);
    if (bars[i].low === Math.min(...w.map(b => b.low))) lows.push(bars[i].low);
  }
  const dedupeMostRecent = (arr) => {
    const out = [];
    for (let i = arr.length - 1; i >= 0 && out.length < 3; i--) {
      const v = arr[i];
      if (!out.some(o => Math.abs(o - v) / v < 0.0005)) out.push(v);
    }
    return out;
  };
  return { swingHighs: dedupeMostRecent(highs), swingLows: dedupeMostRecent(lows) };
}

// SFP (swing failure pattern) / liquidity raid: the latest bar wicks through a
// key level and closes back on the other side of it — the "trap candle."
// Checked against every level in the pool; first match wins.
function detectSFPFromBars(bars, levels) {
  if (!bars || bars.length < 1) return null;
  const curr = bars[bars.length - 1];
  if ([curr.high, curr.low, curr.close].some(v => typeof v !== 'number')) return null;

  for (const level of levels.highs) {
    if (typeof level === 'number' && curr.high > level && curr.close < level) {
      return { direction: 'BEARISH', level };
    }
  }
  for (const level of levels.lows) {
    if (typeof level === 'number' && curr.low < level && curr.close > level) {
      return { direction: 'BULLISH', level };
    }
  }
  return null;
}

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
  mon.interval = setInterval(() => checkSFPSignal(key), SFP_TFS[key].intervalMs);
}

function stopSFPMonitor(key) {
  const mon = sfpMonitors[key];
  if (mon.interval) { clearInterval(mon.interval); mon.interval = null; }
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
        mon.pending = { direction: sfp.direction, level: sfp.level, sweptAt: Date.now(), expiresAt: Date.now() + 8 * tfSeconds * 1000 };
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
            const confirmMsg = `PLAYBOOK B CONFIRMED (${mon.pending.direction}) on ${cfg.label} at ${istTime} IST — liquidity raid at ${mon.pending.level.toFixed(2)} + displacement FVG ${fvg.gapLow.toFixed(2)}-${fvg.gapHigh.toFixed(2)}. Enter on retrace into the gap, SL beyond the sweep wick.`;
            broadcast({
              type: 'playbook-b-signal',
              tf: key,
              tfLabel: cfg.label,
              direction: mon.pending.direction,
              sweepLevel: mon.pending.level,
              gapLow: fvg.gapLow,
              gapHigh: fvg.gapHigh,
              time: istTime,
              message: confirmMsg
            });
            telegramBot.notify(`✅ ${confirmMsg}`);
            console.log(`PLAYBOOK B CONFIRMED [${cfg.label}]: ${mon.pending.direction}`);
            // 2.1/2.2: ledger + arm the confirmed Playbook B setup.
            ledgerSignal({ event: 'playbook-b-confirm', playbook: 'B', tf: cfg.tfCode, direction: mon.pending.direction, level: mon.pending.level, gapLow: fvg.gapLow, gapHigh: fvg.gapHigh });
            armSetup({ playbook: 'B', tfCode: cfg.tfCode, tfLabel: cfg.label, direction: mon.pending.direction, level: mon.pending.level, gapLow: fvg.gapLow, gapHigh: fvg.gapHigh, message: confirmMsg });
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
function classifyTrendStrength(bars) {
  if (!bars || bars.length < 3) return { direction: 'unclear', label: 'NEUTRAL', score: 0, detail: null };

  // UPGRADED 2026-07-28 (Anoop): was computed off market_multi_tf's fixed
  // 5-bar window — five daily candles is one week, too thin to call a
  // "Daily bias" honestly. Now fed 60 bars via getFullBars(). Two real
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

  // 3. SLOPE — linear regression over the last 20 closed bars. Windowed at 20
  // deliberately: regressing all 60 would measure last quarter's drift, not
  // the trend you're about to trade into.
  const window = closedBars.slice(-20);
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
  const direction = avg > 0.1 ? 'bullish' : avg < -0.1 ? 'bearish' : 'unclear';
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
    detail: { structureScore: round2(structureScore), structureMethod, bodyScore: round2(bodyScore), slopeScore: round2(slopeScore), agree }
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
// switch), so the TTLs below are raised to compensate: a DAILY bar does not
// meaningfully change in 3 minutes, and neither does a 1H bar. Net effect is
// FEWER chart switches than before (~16/hour) on much deeper data.
const TREND_TTL_BY_TF = { 'D': 15 * 60 * 1000, '60': 5 * 60 * 1000 };
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
    const trend = classifyTrendStrength(bars);
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
    const [dailyRead, hourRead, price] = await Promise.all([
      getTrendForTF('D'),
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

// Asia session convention used here: 5:30 AM IST (Tokyo open) to 1:30 PM IST
// (London open) — the same boundary CLAUDE.md uses for when London starts.
// Pulling 40 x 15M bars (~10 hours) is enough to cover that window when this
// runs at/after London open without reaching back into the prior day's Asia
// session too.
async function getAsiaHighLow() {
  try {
    const bars = await getFullBars('15', 40);
    if (!bars.length) return null;
    const asiaBars = bars.filter(b => {
      const h = toISTFractionalHour(barTimeToDate(b.time));
      return h >= 5.5 && h < 13.5;
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

// London session convention used here: 1:30 PM IST (London open) to 7:00 PM IST
// (NY open) - mirrors the Asia->London boundary above, one session later.
// Pulling 30 x 15M bars (~7.5 hours) is enough to cover that window when this
// runs at/after NY open without reaching back into the Asia session too.
async function getLondonHighLow() {
  try {
    const bars = await getFullBars('15', 30);
    if (!bars.length) return null;
    const londonBars = bars.filter(b => {
      const h = toISTFractionalHour(barTimeToDate(b.time));
      return h >= 13.5 && h < 19.0;
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

function isSameISTDate(tsMs, referenceIstDateStr) {
  const d = new Date(tsMs + 5.5 * 3600000);
  return d.toISOString().slice(0, 10) === referenceIstDateStr;
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

  return {
    inBlackout: !!active,
    // ts kept alongside until/start so downstream consumers (e.g. the
    // ForexFactory→TradingView chart marker) can place the marker at the
    // event's actual time, not just its blackout window edges.
    activeEvent: active ? { title: active.title, country: active.country, until: active.end, ts: active.ts } : null,
    upcoming: upcomingToday,
    holidaysToday: holidaysToday.map(e => ({ title: e.title, country: e.country })),
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
// 10 minutes before London (1:30 PM IST) and NY (7:00 PM IST) session opens,
// auto-run the same PDH/PDL + Asia H/L zone marking as the manual "Mark
// London Levels" button, plus a Telegram heads-up. De-duped per IST calendar
// day per session so it fires once per occurrence, not every 60s tick.
const SESSION_WINDOWS = {
  london: { startMin: 13 * 60 + 30, endMin: 15 * 60, label: 'London' },
  ny:     { startMin: 19 * 60,      endMin: 21 * 60,  label: 'NY' }
};
const sessionPrepFired = { london: null, ny: null }; // IST date string of last fire, per session

function istNowMinutesAndDate() {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  return { mins: ist.getUTCHours() * 60 + ist.getUTCMinutes(), dateStr: ist.toISOString().slice(0, 10) };
}

async function checkSessionPrep() {
  const { mins, dateStr } = istNowMinutesAndDate();
  for (const [key, win] of Object.entries(SESSION_WINDOWS)) {
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
const ALL_MONITORS = [
  { id: 'po3',        label: 'Power of 3 (AMD)', mon: () => po3Monitor,         intervalMs: PO3_MONITOR_INTERVAL_MS, cond: () => !po3MonitorUserDisabled,  run: () => startPo3Monitor() },
  { id: 'engulf-1h',  label: 'Engulf 1H',        mon: () => engulfMonitors['1h'],  intervalMs: 60 * 1000, run: () => startEngulfMonitor('1h') },
  { id: 'engulf-30m', label: 'Engulf 30M',       mon: () => engulfMonitors['30m'], intervalMs: 45 * 1000, run: () => startEngulfMonitor('30m') },
  { id: 'engulf-15m', label: 'Engulf 15M',       mon: () => engulfMonitors['15m'], intervalMs: 30 * 1000, run: () => startEngulfMonitor('15m') },
  { id: 'fvg-30m',    label: 'FVG 30M',          mon: () => fvgMonitors['30m'],    intervalMs: 30 * 1000, run: () => startFVGMonitor('30m') },
  { id: 'sfp-30m',    label: 'SFP / Playbook B 30M', mon: () => sfpMonitors['30m'], intervalMs: 60 * 1000, run: () => startSFPMonitor('30m') },
];

function armMonitorsStaggered() {
  ALL_MONITORS.forEach((e, i) => {
    if (!e.cond || e.cond()) setTimeout(e.run, chartBarCache.staggerOffsetMs(i));
  });
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
    else if (mon.running && mon.lastCheck && Date.now() - new Date(mon.lastCheck).getTime() > 3 * e.intervalMs) health = mon.restartAttempted ? 'red' : 'amber';
    else if (mon.running) health = 'healthy';
    return { id: e.id, label: e.label, running: !!mon.running, health, lastCheck: mon.lastCheck || null, lastError: mon.lastError || null };
  });
  return { tvConnected: !tvDown, rows };
}
function broadcastWatchersStatus() {
  broadcast({ type: 'watchers-status', data: buildWatchersStatus() });
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
    const row = signalLedger.buildSignalRow(fields, {
      sessionTier: signalLedger.sessionTierForMinutes(istMin, windows),
      dailyTrend: null, // Daily is Anoop's own read — deliberately not captured mechanically (see gatherAnalysisContext)
      hourTrend,
      newsBlackout: news.inBlackout,
      symbol: chartSymbolCache.symbol,
      accountSlot: jessiBucketKey(cfg),
      mode: currentMode,
    });
    const day = tradingDayStampIST(Date.now());
    const dir = path.join(DATA_DIR, 'signals');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, day + '.jsonl'), signalLedger.serializeSignal(row), 'utf8');
  } catch (e) {
    console.error('[signal-ledger] write failed:', e.message);
  }
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

function armSetup(fields) {
  const now = Date.now();
  armedSetup = {
    signalTs: now,
    playbook: fields.playbook,
    tfCode: fields.tfCode,
    tfLabel: fields.tfLabel || fields.tfCode,
    direction: fields.direction,
    level: fields.level != null ? fields.level : null,
    gapLow: fields.gapLow != null ? fields.gapLow : null,
    gapHigh: fields.gapHigh != null ? fields.gapHigh : null,
    message: fields.message || '',
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
      // 2026-08-19: re-run the self-test on every reconnect, not just once at
      // boot — a reconnect can land with the Trading Panel no longer open or
      // linked, and that's exactly the state this test exists to catch.
      // Same 15s delay as the initial run: give TradingView a moment to
      // finish rendering after the CDP handshake before probing it.
      scheduleLiveFeedSelfTest(15000);
    });
    mcpBridge.on('tv-disconnected', (detail) => {
      tvBrokerFeedReadOk = null; // force a fresh readable/not-readable log line once CDP comes back, don't trust the pre-drop state
      broadcast({ type: 'mcp-status', connected: false, message: 'TradingView disconnected' + (detail ? ': ' + detail : '') });
    });
    if (mcpBridge.ready) {
      if (mcpBridge.tvConnected) armMonitorsStaggered(); // already connected before this call — 'tv-connected' won't fire again
      if (mcpBridge.tvConnected) scheduleLiveFeedSelfTest(15000);
      return;
    }
    await mcpBridge.start();
    if (mcpBridge.tvConnected) armMonitorsStaggered(); // covers a start() that resolves already-connected, race-safe alongside the event listener
    if (mcpBridge.tvConnected) scheduleLiveFeedSelfTest(15000);
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
let tvBrokerFeedReadOk = null; // null = never polled yet; tracks state so log lines only fire on transitions, not every 10s
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
    const result = text ? JSON.parse(text) : null;
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
    const positionsReadable = !!(result.positions && result.positions.success);
    if (!positionsReadable) {
      const reason = 'positions table not readable — cannot determine flat/open state, so trades CANNOT be counted. Open the Trading Panel\'s Positions tab in TradingView.';
      if (tvBrokerFeedReadOk !== false) console.warn('[tv-broker] ' + reason);
      tvBrokerFeedReadOk = false;
      broadcast({ type: 'tv-broker-account', success: false, connected: false, reason });
      return;
    }
    if (tvBrokerFeedReadOk !== true) console.log('[tv-broker] broker feed readable — positions/orders tables found, trade tracking is live');
    tvBrokerFeedReadOk = true;

    const orders = (result.orders && result.orders.orders) || [];
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
    const ordersTableSuspect = orders.length === 0 && (result.positions.positions || []).length > 0;
    if (ordersTableSuspect && tvBrokerOrdersSuspectLogged !== true) {
      console.warn('[tv-broker] orders table read as empty while a position is open — treating orders-derived counts as unreliable this poll (likely the Orders tab has not been rendered yet in TradingView). Open the Orders tab once to populate it.');
      tvBrokerOrdersSuspectLogged = true;
    } else if (!ordersTableSuspect) {
      tvBrokerOrdersSuspectLogged = false;
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

    const positions = (result.positions && result.positions.positions) || [];
    const isFlat = !positions.length;
    const openSize = positions.reduce((m, p) => Math.max(m, Math.abs(Number(p.Qty) || 0)), 0);
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
    const walk = ordersTableSuspect ? null : tvBrokerFeed.analyzeOrderWalk(orders, todayKeyMs);
    const walkDesynced = walk ? tvBrokerFeed.isWalkDesynced(walk.netBySymbol, positions) : false;
    if (walk && (walkDesynced || walk.droppedRows > 0) && tvBrokerWalkDesyncLogged !== true) {
      console.warn(`[tv-broker] order-history walk is out of step with the positions panel (desynced=${walkDesynced}, unreadable rows=${walk.droppedRows}). Treating its round-trip count as unavailable — the fold falls back to fill-edge detection, which can over-count. Check the Orders tab for a row with a missing fill price or timestamp.`);
      tvBrokerWalkDesyncLogged = true;
    } else if (walk && !walkDesynced && walk.droppedRows === 0) {
      tvBrokerWalkDesyncLogged = false;
    }
    const closedRoundTripsToday = (!walk || walkDesynced || walk.droppedRows > 0)
      ? null
      : walk.closed.length;
    // 2026-08-19: hasNewFill ties the poll-aliasing backstop to real evidence
    // (this same poll's orders-table read found a genuinely new Filled
    // order) instead of firing on any balance movement — see fold()'s
    // 2026-08-19 comment for the live incident (Balance drifting on its own
    // while genuinely flat, fabricating 20 fake trades) this closes.
    tvBrokerFeedState = tvBrokerFeed.fold(tvBrokerFeedState, {
      balance, isFlat, openSize, nowMs: Date.now(),
      hasNewFill: newFills.length > 0,
      closedRoundTrips: closedRoundTripsToday,
    });
    // Every poll, not just on a trade close — sizeSeenThisTrade/wasFlat/
    // balanceAtLastFlat all need to survive a restart mid-trade too, not
    // only the completed-trades list, or a restart during an OPEN position
    // would lose the "last known flat balance" reference point the eventual
    // close needs to compute P&L against.
    persistTVBrokerFeedState();
    if (tvBrokerFeedState.tradeCount > prevTradeCount) {
      const newTrades = tvBrokerFeedState.trades.slice(prevTradesLen);
      console.log(`[tv-broker] ${newTrades.length} trade(s) closed (balance-delta-at-flat, unverified live): ` +
        newTrades.map(t => `size ${t.size} pnl ${t.pnl.toFixed(2)}`).join(', '));

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
      for (const t of newTrades) {
        try {
          // 2026-08-20 (review): live-fold trade records are {size, pnl, at} —
          // they carry NO `symbol` (only backfilled records do, and those never
          // reach this loop). So the per-symbol lookup always missed and every
          // row silently took the `__any` fallback. Harmless on a
          // one-instrument day, but on an MNQ+MGC day it writes a CONFIDENT
          // wrong direction to a file the Post-Session Analyst later reads back
          // as fact — a TRUST-PROTOCOL violation. Fall back to '?' rather than
          // to the other instrument's side whenever today wasn't single-symbol.
          const symbolsToday = Object.keys(tvLastClosedSide).filter(k => k !== '__any');
          const dir = tvLastClosedSide[t.symbol]
            || (symbolsToday.length <= 1 ? tvLastClosedSide.__any : null)
            || '?';
          const pnlKnown = t.pnlUnknown !== true;
          const noteBits = ['auto-logged from live feed'];
          if (t.inferred) noteBits.push('size not observed (opened+closed between polls)');
          if (!pnlKnown) noteBits.push('P&L NOT computed — read it off the broker');
          const logged = sessionMgr.logTrade(sessionMgr.todayStr(), {
            direction: dir === '?' ? '?' : dir.toUpperCase(),
            entry: '?', stop: '?', target: '?', exit: '?',
            pnl: pnlKnown ? Number(t.pnl.toFixed(2)) : undefined,
            notes: noteBits.join('; ') + (t.size ? `; size ${t.size}` : ''),
          });
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
      if (walk && !walkDesynced && walk.closed.length >= newTrades.length) {
        const commRate = getActiveRules().commissionPerContractPerSide;
        const recentRts = walk.closed.slice(-newTrades.length);
        newTrades.forEach((t, idx) => {
          const rt = recentRts[idx];
          const exp = tvBrokerFeed.expectedPnlFromFills(rt, commRate);
          if (!exp || t.pnlUnknown) return; // no verified multiplier, or nothing to compare
          const delta = t.pnl - exp.net;
          // $1 of slack absorbs exchange rounding and fee timing without
          // swallowing a real error - the 2026-08-20 miscounts were $50+ apart.
          const ok = Math.abs(delta) <= 1.0;
          const line = rt.symbol + ': balance-delta ' + t.pnl.toFixed(2) + ' vs fills ' + exp.net.toFixed(2) +
            ' (' + rt.side + ' ' + rt.size + ' @ ' + rt.entryPrice + ' -> ' + rt.exitPrice +
            ', gross ' + exp.gross.toFixed(2) + ' - comm ' + exp.commission.toFixed(2) + '), diff ' + delta.toFixed(2);
          if (ok) console.log('[tv-broker] P&L cross-check OK on ' + line);
          else console.warn('[tv-broker] P&L CROSS-CHECK MISMATCH on ' + line + '. Enforcement still uses the balance delta.');
          broadcast({
            type: 'pnl-cross-check', ok, symbol: rt.symbol,
            balanceDelta: t.pnl, fromFills: exp.net, difference: delta,
            side: rt.side, size: rt.size, entryPrice: rt.entryPrice, exitPrice: rt.exitPrice,
          });
        });
      }

      broadcast({
        type: 'trade-closed-live',
        trades: newTrades.map(t => ({
          size: t.size, pnl: t.pnl, inferred: !!t.inferred, pnlUnknown: !!t.pnlUnknown,
        })),
        tradeCount: tvBrokerFeedState.tradeCount,
        dayPnl: tvBrokerFeedState.dayPnl,
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
    const foldTradeCount = tvBrokerFeedState.tradeCount;
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
      countEvidence: (tvBrokerFeedState.trades || []).some(t => t && t.evidence === 'degraded') ? 'degraded' : 'verified',
      degradedTradeCount: (tvBrokerFeedState.trades || []).filter(t => t && t.evidence === 'degraded').length,
      feedDegraded: closedRoundTripsToday === null,
      tradeCount: tvBrokerFeedState.tradeCount,
      dayPnl: tvBrokerFeedState.dayPnl,
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
async function pollTVPositions() {
  if (!mcpBridge.ready || !mcpBridge.tvConnected) return;
  // A slow CDP read must not stack ticks on top of each other — at 5s with a
  // shared broker lock, overlapping reads would queue behind one another and
  // report a stale transition late rather than the current one on time.
  if (tvPositionWatchInFlight) return;
  tvPositionWatchInFlight = true;
  try {
    const raw = await withBrokerLock(() => mcpBridge.callTool('trading_get_positions', {}));
    const text = (raw && raw.content) ? raw.content.map(c => c.text || '').join('') : null;
    const result = text ? JSON.parse(text) : null;
    // An unreadable panel is NOT "flat" — treating a failed read as zero
    // positions would fire a phantom `closed` for every open trade the moment
    // TradingView hiccups, and (once wired to the session log) write a
    // phantom row for it. Leave the baseline untouched and wait.
    if (!result || !result.success || !Array.isArray(result.positions)) return;

    const rows = result.positions;
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
  const total = 3;

  // Check 1: CDP reachable — already tracked continuously by mcpBridge, this
  // just folds it into the same PASS/FAIL report rather than re-probing.
  if (mcpBridge.ready && mcpBridge.tvConnected) {
    passed++;
  } else {
    failures.push('CDP: TradingView chart connection not established');
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
    const positionsOk = !!(result && result.positions && result.positions.success);
    const ordersOk = !!(result && result.orders && result.orders.success);
    const summaryOk = !!(result && result.summary && result.summary.success);
    if (result && result.success && positionsOk && ordersOk && summaryOk) {
      passed++;
    } else {
      const unreadable = (result && result.unreadable) ||
        ['positions', 'orders', 'summary'].filter((k, i) => ![positionsOk, ordersOk, summaryOk][i]);
      failures.push('Broker panel: unreadable — ' + (unreadable.join(', ') || 'unknown reason') + ' (open the Trading Panel in TradingView)');
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
    } else {
      failures.push('Quote: ' + ((result && result.error) || 'no readable price returned (chart may be loading/blank)'));
    }
  } catch (e) {
    failures.push('Quote: check threw — ' + e.message);
  }

  const resultMsg = { type: 'live-feed-self-test', passed, total, failures, at: Date.now() };
  console.log(`[self-test] live feed: ${passed}/${total} checks passed` + (failures.length ? ' — ' + failures.join(' | ') : ''));
  broadcast(resultMsg);
  return resultMsg;
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

async function handleTradeConfirm(ws, msg) {
  const requestId = msg && msg.requestId;
  const { sourceVerdictId, side, symbol, qty, stopPrice, targetPrice } = msg || {};

  const dedup = tradeConfirmDedup.checkAndMark(tradeConfirmDedupState, requestId, sourceVerdictId, Date.now(), TRADE_CONFIRM_DEDUP_WINDOW_MS);
  if (!dedup.ok) {
    send(ws, { type: 'trade-confirm-rejected', requestId: requestId || null, reason: dedup.reason });
    return;
  }

  try {
    if (process.env.TV_ALLOW_LIVE_ORDERS !== '1') {
      send(ws, { type: 'trade-confirm-rejected', requestId, reason: 'live orders are not enabled this session (TV_ALLOW_LIVE_ORDERS was not set at launch)' });
      return;
    }
    if (!mcpBridge.ready || !mcpBridge.tvConnected) {
      send(ws, { type: 'trade-confirm-rejected', requestId, reason: 'TradingView is not connected' });
      return;
    }

    const sideNorm = String(side || '').toLowerCase();
    const qtyNum = Number(qty);
    if (sideNorm !== 'buy' && sideNorm !== 'sell') {
      send(ws, { type: 'trade-confirm-rejected', requestId, reason: `invalid side: ${side}` });
      return;
    }
    if (!Number.isFinite(qtyNum) || qtyNum <= 0 || Math.floor(qtyNum) !== qtyNum) {
      send(ws, { type: 'trade-confirm-rejected', requestId, reason: `invalid size: ${qty}` });
      return;
    }

    // NO OVERRIDE — the one rules check that gates real execution. Reuses the
    // same pure logic the manual/live-feed guardrail already enforces
    // (tv-broker-feed.js's `trades` shape), extended in trade-confirm-rules.js.
    const rules = getActiveRules();
    const check = tradeConfirmRules.checkTradeAllowed(rules, currentMode, tvBrokerFeedState.trades, qtyNum);
    if (!check.allowed) {
      console.log(`[trade-confirm] BLOCKED requestId=${requestId}: ${check.reason}`);
      send(ws, { type: 'trade-confirm-rejected', requestId, reason: check.reason });
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
  } catch (e) {
    console.error(`[trade-confirm] requestId=${requestId} uncaught error:`, e.message);
    send(ws, { type: 'trade-confirm-result', requestId, success: false, error: e.message || 'unexpected error' });
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
  // 2026-08-19: restore today's live trade-tracking state now that DATA_DIR
  // is final — see the note at tvBrokerFeedState's declaration for why this
  // can't happen at module top-level. Must run before startTVBrokerMonitor()
  // (below) starts polling, or the very first poll would fold against a
  // still-fresh state and immediately overwrite whatever was just restored.
  tvBrokerFeedState = loadTVBrokerFeedState();
  startTradovate();
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Co-Pilot — http://localhost:${PORT}  ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  const cfg = loadConfig();
  if (cfg.apiKey) { claudeAgent.init(cfg.apiKey); console.log('✓ Claude API key loaded'); }
  else console.log('⚠  No API key — open Settings');
  if (cfg.geminiApiKey) { groqAgent.initGemini(cfg.geminiApiKey); console.log('✓ Gemini API key loaded (Jessi primary brain)'); }
  else console.log('⚠  No Gemini key — Jessi falls back to Groq (smaller 6-8K tokens/min ceiling). Free key: aistudio.google.com/apikey');
  if (cfg.groqApiKey) { groqAgent.init(cfg.groqApiKey); console.log('✓ Groq API key loaded (Jessi fallback + voice STT/TTS)'); }
  else console.log('⚠  No Groq key — Jessi chat falls back to offline mode until one is added in Settings');
  if (cfg.apiKey) { groqAgent.initAnthropic(cfg.apiKey); console.log('✓ Anthropic key wired into ALL agents (primary brain)'); }

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
  if (cfg.omniRouteApiKey) {
    groqAgent.initOmniRoute(cfg.omniRouteApiKey, cfg.omniRouteBaseUrl);
    console.log('✓ OmniRoute API key loaded (primary brain when enabled)');
    // Probe health immediately + every 30s so primaryProviderModel() can
    // skip OmniRoute instantly when the server is down (instead of waiting
    // for a per-request timeout → "silently failing").
    groqAgent.probeOmniRouteHealth().then(ok =>
      console.log(ok ? '✓ OmniRoute health check passed — using as primary' : '⚠  OmniRoute health check failed — falling back to Gemini'));
    setInterval(() => groqAgent.probeOmniRouteHealth(), 30000);
  } else console.log('ℹ  No OmniRoute key — using Gemini/Groq chain only');
  startJessiTVMonitor();
  console.log('✓ Jessi background chart monitor started (3-min cadence)');
  startTVBrokerMonitor();
  console.log('✓ TradingView broker-account monitor started (10s cadence, polls only while TV is connected)');
  startTVPositionWatch();
  console.log(`✓ Live position watch started (${TV_POSITION_WATCH_MS / 1000}s cadence — open/close/scale detected here, then folded immediately by the account poll)`);
  console.log(`✓ Mode: ${(cfg.mode || 'funded').toUpperCase()}`);

  // 2026-08-11 (Anoop): "I don't want telegram to work... remove them."
  // The bot is no longer started, so it holds no long-poll connection and can
  // no longer fail at startup or mid-session. telegramBot.notify() calls are
  // scattered through the monitors and are safe no-ops while stopped, so they
  // are deliberately left in place rather than ripped out of a dozen call
  // sites during a live-trading week. To re-enable: flip TELEGRAM_ENABLED to
  // true. Nothing else needs to change.
  const TELEGRAM_ENABLED = false;
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
