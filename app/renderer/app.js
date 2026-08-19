'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  messages: [],
  trades: [],
  // FIX (2026-07-21): default account is the 150K eval (the $50K funded
  // account is blown — see Settings for the account ID, kept out of source
  // control). These initial literal values are
  // just a placeholder shape — loadAccountBucket() overwrites state.account
  // entirely on boot from ACCOUNT_PROFILES + whatever's persisted per bucket
  // (see the multi-account architecture block right after this state object).
  mode: 'eval',     // 'eval' | 'funded'  (stage within the active account size)
  accountSize: '150k', // '50k' | '100k' | '150k' — see ACCOUNT_PROFILES below
  isStreaming: false,
  // ON by default again (2026-07-28, later same day). I'd turned this off as a
  // precaution while the chat-lock cause was unknown — that turned out to be a
  // wrong element id in my own debate UI code ('chat-messages' vs 'messages'),
  // which is fixed, and renderer/resilience.js now guarantees the chat can
  // never stay locked regardless. Anoop wants the three agents (Jessi +
  // Analysis + Power of 3) participating in every question, which only happens
  // with debate mode on. The ⚖ button still toggles it off per-session.
  debateMode: true,
  scalperAgent: false,   // The Scalper specialist agent (2026-08-01)
  tvConnected: false,
  account: {
    balance: 148932,
    fundedFloor: 48000,
    evalFloor: 145500,
    evalDayCap: 2500,
    evalDayStop: 300,
    evalTarget: 159000,
    fundedDayStop: 200,
    fundedTargetMin: 150,
    fundedTargetMax: 300,
    payoutTarget: 52000,
    profit: 0,
    tradeCount: 0,
    lastTradeTime: null,
    goNogo: 'pending'
  },
  analysis: { bias: null, biasNote: 'Run analysis to update', keyLevel: null },
  streamBuffer: '',
  currentAssistantBubble: null,
  engulf: {
    '1h':  { running: false, history: [], lastBias: null },
    '30m': { running: false, history: [], lastBias: null },
    '15m': { running: false, history: [], lastBias: null }
  },
  fvg: {
    '30m': { running: false, history: [] }
  },
  sfp: {
    '30m': { running: false, history: [] }
  },
  // Tool calls (chart reads, TF switches, etc.) during a chat turn are tracked
  // silently and collapsed into a single tick at the end — see setupChatListeners.
  toolCallCount: 0,
  toolCallHadError: false,
  news: null,
  newsWasBlackout: false,
  hasApiKey: false,
  mechanical: { dailyTrend: null, hourTrend: null, aligned: null, price: null, keyLevel: null, at: null }
};

// Expose state on window for renderer/resilience.js (the crash-recovery +
// transcript-persistence layer, loaded after this file). A top-level `const`
// lives in the script's lexical scope and does NOT become a window property,
// so without this line the resilience layer cannot see or repair chat state.
window.state = state;

// ═══ Multi-account architecture (2026-07-21, Anoop's request after the $50K ═══
// ═══ funded account blew and the $150K eval became primary) ═════════════════
// Anoop trades separate Lucid accounts by SIZE (50K/100K/150K), each moving
// through two STAGES (Eval -> Funded). Each size+stage combo is a fully
// separate data bucket — balance, floor, CSV/ledger history, streak — so
// switching accounts, or uploading a CSV, can never bleed into another
// account's numbers. A bucket that's never been used loads genuinely empty
// (fresh defaults below), which is what makes "Eval empty until Funded
// starts, Funded empty until Eval clears" true.
//
// PLACEHOLDER terms are flagged explicitly below — they are NOT confirmed
// Lucid rules, just reasonable assumptions so the architecture works today:
//   - 50K Eval: this project's records only ever had the OLD 50K FUNDED
//     account's terms (a different product) — never a 50K eval's real terms.
//     Target/maxLoss here are a straight-line scale of the CONFIRMED 150K
//     eval terms (6% target / 3% max loss). Confirm against Lucid's docs
//     before trusting them.
//   - 150K Funded: this account hasn't cleared its eval yet, so its real
//     funded-stage terms were never confirmed either — same 6%/3%-style
//     scaling assumption used as a placeholder.
//   - 100K (both stages): account doesn't exist yet — future-proofing only.
// Crosschecked 2026-07-21 against Lucid's official LucidFlex docs
// (support.lucidtrading.com/en/collections/16914631-lucidflex — Evaluation,
// Funded, Scaling Plan, Drawdown, Consistency, Payouts articles). Three
// numbers here were wrong before this pass and are now corrected:
//   - 50k eval maxLoss: was 1500, official is 2000
//   - 150k funded floorBuffer: was 6000, official MLL is 4500 (same as eval's own MLL)
//   - 150k funded targetMin: was 300, official min qualifying-day profit is 250
// Every other number below matched the official docs exactly, so their
// placeholder:true flags are cleared too — the only two entries still
// genuinely unconfirmed are the 100k accounts, which don't exist yet
// (notOpened:true) and so were never tested against a real account either.
const ACCOUNT_PROFILES = {
  '50k': {
    label: '$50K',
    eval:   { startBalance: 50000,  target: 3000,  maxLoss: 2000,  accountId: null, placeholder: false, notOpened: false },
    // 2026-08-12: `blown` is DATA, not a hardcoded size check. Two places below
    // read `state.accountSize === '50k' && mode === 'funded'` to decide the
    // account was dead. That was true of the OLD $50K funded account. Anoop's
    // NEW Lucid funded account is ALSO $50K, so the app branded a live account
    // a corpse — and every Judge verdict inherited it, reasoning off historical
    // numbers. Set to false on evidence: DATA/accounts/s3 has six days of real
    // trading (2026-08-05 .. 2026-08-12) whose net sums to -997, reconciling
    // exactly to the 49,003 balance on screen. A traded account is not blown.
    // Flip this to true the day an account actually breaches — do NOT go back
    // to inferring it from the size.
    funded: { startBalance: 50000,  floorBuffer: 2000, dayStop: 200, targetMin: 150, targetMax: 300, payoutTarget: 52000,  accountId: null, placeholder: false, notOpened: false, blown: false }
  },
  '100k': {
    label: '$100K',
    eval:   { startBalance: 100000, target: 6000,  maxLoss: 3000,  accountId: null, placeholder: false, notOpened: true },
    funded: { startBalance: 100000, floorBuffer: 4000, dayStop: 250, targetMin: 200, targetMax: 400, payoutTarget: 104000, accountId: null, placeholder: false, notOpened: true,  blown: false }
  },
  '150k': {
    label: '$150K',
    eval:   { startBalance: 150000, target: 9000,  maxLoss: 4500,  accountId: null, placeholder: false, notOpened: false },
    funded: { startBalance: 150000, floorBuffer: 4500, dayStop: 300, targetMin: 250, targetMax: 600, payoutTarget: 154500, accountId: null, placeholder: false, notOpened: false, blown: false }
  }
};

// Account-scoped localStorage keys — every one of these gets swapped out on
// account switch. Deliberately excludes UI-only prefs (panel widths, theme)
// which stay global regardless of which account is active.
const ACCT_LS_KEYS = ['copilot_gr_history', 'copilot_balance_ledger', 'copilot_day_trades', 'copilot_loop', 'copilot_guardrail_v1', 'copilot_ck_history', 'copilot_pb_tags', 'copilot_maemfe', 'copilot_goodtrades', 'copilot_checklist_plan', 'copilot_eval_milestones', 'copilot_alok_memory', 'copilot_ladder_actuals'];

// ── 5 free account slots (2026-07-25) ────────────────────────────────────────
// Anoop asked for FIVE independent accounts where he picks each one's size —
// so he can run e.g. three 50K evals at once (his "3 evals simultaneously →
// copy trading" plan). Previously data was keyed by size_stage, which caps you
// at one account per size+stage combination.
//
// Design choice that keeps this low-risk: `state.accountSize` and `state.mode`
// STAY as they are — every rules lookup (ACCOUNT_PROFILES), floor/target calc,
// and UI render already depends on them. The ONLY thing that changed is what
// keys the saved data: a slot id instead of size_stage. A slot simply carries
// which size+stage it currently is.
const ACCT_SLOT_COUNT = 5;
function acctDefaultSlots() {
  return [
    { id: 's1', name: 'Account 1', size: '150k', stage: 'eval' },
    { id: 's2', name: 'Account 2', size: '50k',  stage: 'eval' },
    { id: 's3', name: 'Account 3', size: '50k',  stage: 'eval' },
    { id: 's4', name: 'Account 4', size: '100k', stage: 'eval' },
    { id: 's5', name: 'Account 5', size: '150k', stage: 'funded' }
  ];
}
let acctSlots = acctDefaultSlots();
let activeSlotId = 's1';

function acctSlot(id) { return acctSlots.filter(s => s.id === (id || activeSlotId))[0] || acctSlots[0]; }

// Bucket key is now the SLOT id. Legacy size_stage keys are migrated once by
// migrateSlotsIfNeeded() below, so old history survives (his explicit ask:
// "whatever history was there in the past, let it be").
// BUG FIX 2026-07-25 (found from Anoop's screenshot: slot 1 named "$50K EVAL"
// showing a $150,359 balance, slots 2 and 3 showing the SAME $47,126, and the
// left panel disagreeing with the gate):
// this used to resolve a key by matching size+stage, while saveActiveBucket()
// keyed by SLOT ID. Two different key schemes — writes landed on 's2' while
// reads came from '50k_eval', and any two slots sharing a size read the same
// legacy bucket. Data crossed between accounts, which is unacceptable when the
// floor/target math for a 50K profile can end up applied to a 150K balance.
// The bucket key is now ALWAYS the slot id, with no size-based matching.
function acctBucketKey() { return activeSlotId; }

// BUG FIX 2026-07-25 — the one that made "Start fresh" look broken.
// csvApply mirrors history to server-side files via dataSave('gr_history'),
// dataSave('balance_ledger') etc, and restoreFromDisk() reads them back on
// every launch and RECOMPUTES the balance from them. Those filenames were
// GLOBAL, so they were shared by every account: wiping a slot cleared its
// localStorage and its config bucket, then the disk mirror restored the old
// 9-day ledger straight back over it — which is why a "fresh $50,000" slot
// came back as $50,359 (the 150K ledger's net replayed against the 50K start
// balance). The chat line "source of truth: data/ folder" was literally true.
// Disk keys are now per-slot, so each account's mirror is its own.
function slotDataKey(base) { return base + '__' + activeSlotId; }

// One-time migration: copy each legacy acctBucket__<size>_<stage> blob onto the
// slot that represents that same size+stage, then remember that we've done it.
async function migrateSlotsIfNeeded() {
  let cfg = {};
  try { cfg = (await window.api.getConfig()) || {}; } catch (e) {}
  if (Array.isArray(cfg.acctSlots) && cfg.acctSlots.length === ACCT_SLOT_COUNT) {
    acctSlots = cfg.acctSlots;
    activeSlotId = cfg.activeSlotId || acctSlots[0].id;
    return false;
  }
  acctSlots = acctDefaultSlots();
  // Map legacy buckets → slots with the same size+stage (first match wins).
  const used = {};
  acctSlots.forEach(slot => {
    const legacy = cfg['acctBucket__' + slot.size + '_' + slot.stage];
    if (legacy && !used[slot.size + '_' + slot.stage]) {
      used[slot.size + '_' + slot.stage] = true;
      acctBucketCache[slot.id] = legacy;
      try { window.api.setConfig('acctBucket__' + slot.id, legacy); } catch (e) {}
      slot.name = ACCOUNT_PROFILES[slot.size].label + ' ' + slot.stage.toUpperCase();
    }
  });
  activeSlotId = (cfg.accountSize && cfg.mode)
    ? (acctSlots.filter(s => s.size === cfg.accountSize && s.stage === cfg.mode)[0] || acctSlots[0]).id
    : acctSlots[0].id;
  try {
    window.api.setConfig('acctSlots', acctSlots);
    window.api.setConfig('activeSlotId', activeSlotId);
  } catch (e) {}
  return true;
}

// ── Breached accounts: retire, don't display ──────────────────────────────────
// Anoop 2026-07-25: "do not show any account that is already breached. the
// breached account i cannot trade because its closed to trade after breaching.
// the details of breached should be added as cost session."
// A retired slot keeps its data (history is never destroyed) but is hidden from
// the picker and its fee is logged to the Cost tab as a blown account.
async function retireSlot(slot, peek) {
  // Write this account's FINAL record into its own folder before retiring it,
  // so a breached eval's full history survives as its own dataset (2026-07-25).
  try { if (typeof closeAccountRecord === 'function') await closeAccountRecord(slot, 'breached'); } catch (e) {}
  slot.retired = true;
  slot.retiredAt = new Date().toISOString().slice(0, 10);
  slot.retiredBalance = peek ? peek.bal : null;
  persistSlots();
  // Log to the Cost tab ledger (data/account_fees.json) as a blown account so
  // lifetime spend stays accurate. Cost = the eval fee, which we don't know —
  // recorded at 0 and flagged so he can fill the real number in the Cost tab.
  try {
    const d = await costLoad();
    const already = (d.fees || []).some(f => f.slotId === slot.id);
    if (!already) {
      d.fees.push({
        id: 'fee-' + Date.now(),
        slotId: slot.id,
        date: slot.retiredAt,
        firm: 'Lucid',
        size: (ACCOUNT_PROFILES[slot.size].label || '').replace('$', ''),
        ref: slot.name || slot.id,
        cost: 0,
        status: 'blown',
        confirmed: false,
        note: 'auto-logged on breach — set the real fee paid'
      });
      await costPersist();
      if (typeof renderCost === 'function') renderCost();
    }
  } catch (e) {}
}

// Rebuild the 5-slot table from the (still intact) legacy size_stage buckets.
// Needed because the key-scheme bug above scrambled which size each slot
// claimed to be. Legacy buckets were COPIED, never moved, so they're still the
// clean source of truth.
async function rebuildSlotsFromLegacy() {
  let cfg = {};
  try { cfg = (await window.api.getConfig()) || {}; } catch (e) {}
  acctSlots = acctDefaultSlots();
  acctSlots.forEach(slot => {
    const legacy = cfg['acctBucket__' + slot.size + '_' + slot.stage];
    if (legacy) {
      acctBucketCache[slot.id] = legacy;
      try { window.api.setConfig('acctBucket__' + slot.id, legacy); } catch (e) {}
      slot.name = ACCOUNT_PROFILES[slot.size].label + ' ' + slot.stage.toUpperCase();
    } else {
      acctBucketCache[slot.id] = null;
      try { window.api.setConfig('acctBucket__' + slot.id, null); } catch (e) {}
    }
    delete slot.retired; delete slot.retiredAt; delete slot.retiredBalance;
  });
  activeSlotId = acctSlots[0].id;
  persistSlots();
  // Clear the global (non-per-account) config keys too — see LAYER 4 note in
  // the gate's Start-fresh handler. Then load with skipSave so the stale
  // in-memory account can't be written back over the rebuild.
  for (const k of ['balance', 'profit', 'evalFloor', 'fundedFloor', 'evalTarget', 'evalDayCap', 'evalDayStop']) {
    try { await window.api.setConfig(k, null); } catch (e) {}
  }
  state.account = acctDefaults(acctSlots[0].size, acctSlots[0].stage);
  await switchSlot(activeSlotId, { force: true, announce: false, skipSave: true });
  if (typeof addSystemMessage === 'function') {
    addSystemMessage('Account list rebuilt from your original per-size data. Each slot now holds only its own account\'s history.');
  }
}

function persistSlots() {
  try {
    window.api.setConfig('acctSlots', acctSlots);
    window.api.setConfig('activeSlotId', activeSlotId);
  } catch (e) {}
}

// Switch to a slot by id — the new primary account-switch entry point.
async function switchSlot(slotId, opts) {
  opts = opts || {};
  const slot = acctSlot(slotId);
  if (!slot) return;
  if (activeSlotId === slot.id && !opts.force) { _renderMode(slot.stage); return; }
  // BUG FIX 2026-07-25: `skipSave` exists because "Start fresh" wipes the slot
  // and then calls this to reload it — and this unconditional save was
  // re-persisting the STILL-LOADED stale state.account right back over the
  // wipe. Same clobber class as the accountBreached() fix; I reintroduced it
  // here and Anoop caught it (balance stayed $50,359 after a reset).
  if (!opts.skipSave) saveActiveBucket();   // persist the slot we're leaving
  activeSlotId = slot.id;
  state.accountSize = slot.size;
  state.mode = slot.stage;
  const hadData = await loadAccountBucket(slot.size, slot.stage);
  window.api.setConfig('accountSize', slot.size);
  window.api.setConfig('mode', slot.stage);
  persistSlots();
  _renderMode(slot.stage);
  updateAccountUI();
  if (typeof updateRulesTab === 'function') updateRulesTab();
  if (typeof grRender === 'function') grRender();
  if (typeof renderInsights === 'function') renderInsights();
  if (typeof renderJournal === 'function' && document.getElementById('tab-journal') && document.getElementById('tab-journal').style.display !== 'none') renderJournal();
  if (opts.announce !== false && typeof addSystemMessage === 'function') {
    addSystemMessage(`Now trading "${slot.name}" — ${ACCOUNT_PROFILES[slot.size].label} ${slot.stage.toUpperCase()}.` + (hadData ? '' : ' Fresh slot, no history yet.'));
  }
}

// Reconfigure the ACTIVE slot's size/stage (used by the titlebar 50K/100K/150K
// and EVAL/FUNDED buttons — they now retune the current slot rather than
// jumping to a different data bucket).
async function setActiveSlotConfig(size, stage) {
  const slot = acctSlot();
  saveActiveBucket();
  slot.size = size; slot.stage = stage;
  state.accountSize = size; state.mode = stage;
  persistSlots();
  await loadAccountBucket(size, stage);
  window.api.setConfig('accountSize', size);
  window.api.setConfig('mode', stage);
  _renderMode(stage);
  updateAccountUI();
  if (typeof updateRulesTab === 'function') updateRulesTab();
  if (typeof grRender === 'function') grRender();
}

// FIX (2026-07-21, "Cannot read properties of undefined (reading
// 'toLocaleString')" on Anoop's real machine): this used to return ONLY the
// active stage's fields (eval OR funded), on the assumption that the inactive
// side wasn't needed. But updateAccountUI()/updateRulesTab() render BOTH the
// eval and funded stat blocks on every call regardless of which one is
// currently visible (they're toggled by CSS, not conditionally rendered) — so
// acc.fundedFloor/acc.fundedDayStop/etc. get read even while state.mode is
// 'eval', and were undefined. Now always includes both branches' numbers.
function acctDefaults(size, stage) {
  const p = ACCOUNT_PROFILES[size];
  const base = { balance: p[stage].startBalance, profit: 0, tradeCount: 0, lastTradeTime: null, goNogo: 'pending' };
  return Object.assign(base, {
    evalFloor: p.eval.startBalance - p.eval.maxLoss,
    evalDayCap: Math.round(p.eval.maxLoss * (2500 / 4500)) || 300,
    evalDayStop: 300,
    evalTarget: p.eval.startBalance + p.eval.target,
    fundedFloor: p.funded.startBalance - p.funded.floorBuffer,
    fundedDayStop: p.funded.dayStop,
    fundedTargetMin: p.funded.targetMin,
    fundedTargetMax: p.funded.targetMax,
    payoutTarget: p.funded.payoutTarget
  });
}

// FIX (2026-07-21, found while wiring this up): window.api.getConfig() in
// this app's ACTUAL bridge (renderer/ws-client.js) takes NO key argument —
// it always resolves the one cached full config object, and that cache is
// never refreshed after a setConfig() call within the same running session.
// Reading `await window.api.getConfig('acctBucket__x')` as if it fetched
// just that key would silently return the WRONG data (either the stale
// startup snapshot, or nothing) — which meant every account switch would
// have wiped that account's real ledger/history instead of restoring it.
// Fixed with a local in-memory cache that's authoritative for the running
// session (always fresh across switches) and falls back to the persisted
// full config only on first load after a restart.
const acctBucketCache = {};

// Persist the CURRENTLY active bucket (state.account + its account-scoped
// localStorage keys) before leaving it — called at the start of every switch.
function saveActiveBucket() {
  const key = acctBucketKey();
  const blob = { account: Object.assign({}, state.account), ls: {} };
  ACCT_LS_KEYS.forEach(k => { blob.ls[k] = localStorage.getItem(k); });
  acctBucketCache[key] = blob;
  try { window.api.setConfig('acctBucket__' + key, blob); } catch (e) {}
  // 2026-08-18: also mirror the account-defining datasets to
  // accounts/<slot>/*.json. Previously only csvApply()/archive() wrote these,
  // so anything that changed the ledger by another route lived ONLY in
  // localStorage + the config blob — and loadAccountBucket() would happily
  // delete it. Disk is what overlaySlotDiskData() restores from, so writing
  // here is what actually makes a save durable across restarts and switches.
  mirrorSlotDataToDisk();
}

// Fire-and-forget mirror of the per-slot datasets to disk. Never blocks the
// UI and never throws into a caller — a disk problem must not interrupt a
// live trading session.
function mirrorSlotDataToDisk() {
  if (!window.api || !window.api.dataSave || !activeSlotId) return;
  const pairs = [
    ['gr_history', 'copilot_gr_history'],
    ['balance_ledger', 'copilot_balance_ledger'],
    ['day_trades', 'copilot_day_trades'],
    ['pb_tags', 'copilot_pb_tags'],
    ['maemfe', 'copilot_maemfe'],
    ['loop_state', 'copilot_loop'],
    ['ck_history', 'copilot_ck_history'],
    ['eval_milestones', 'copilot_eval_milestones'],
  ];
  pairs.forEach(([key, lsKey]) => {
    try {
      const raw = localStorage.getItem(lsKey);
      if (!raw) return; // never overwrite a good disk file with nothing
      const parsed = JSON.parse(raw);
      const nonEmpty = parsed && (Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length);
      if (!nonEmpty) return;
      Promise.resolve(window.api.dataSave(slotDataKey(key), parsed)).catch(() => {});
    } catch (e) {}
  });
}

// ── Autosave (2026-08-18, Anoop: "I want the data to autosave") ────────────
// saveActiveBucket() previously ran only on an explicit account switch and a
// couple of one-off moments. Closing the tab, a browser crash, or a server
// restart mid-session therefore lost everything since the last switch — and
// because the stale blob was what loadAccountBucket() trusted, the loss then
// looked like "the account reset itself". These three hooks make a save
// happen on a timer, when the page is hidden, and on unload.
let _autosaveTimer = null;
function startAccountAutosave() {
  if (_autosaveTimer) return;
  _autosaveTimer = setInterval(() => {
    try { saveActiveBucket(); } catch (e) {}
  }, 30000);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { try { saveActiveBucket(); } catch (e) {} }
  });
  // pagehide is the reliable one on modern browsers; beforeunload kept as a
  // belt-and-braces fallback. Both are sync — setConfig/dataSave are
  // fire-and-forget over the open WebSocket, which survives long enough.
  window.addEventListener('pagehide', () => { try { saveActiveBucket(); } catch (e) {} });
  window.addEventListener('beforeunload', () => { try { saveActiveBucket(); } catch (e) {} });
}

// Load a bucket's data into state.account + the same flat localStorage keys
// every existing function (csvApply, loopUpdate, the guardrail IIFE, etc.)
// already reads/writes unmodified — they keep working exactly as before,
// just now operating on whichever bucket is currently loaded into those keys.
// Returns true if the bucket already had saved data, false if it's fresh/empty.
async function loadAccountBucket(size, stage) {
  // 2026-07-25: keyed by ACTIVE SLOT ID, matching saveActiveBucket(). See the
  // acctBucketKey() note above for the cross-contamination bug this fixes.
  // size/stage are still used to build the correct profile defaults.
  const key = activeSlotId;
  // FIX (2026-07-22, found while wiring up the breach/clear archive feature):
  // window.api.setConfig() fire-and-forgets to the server and never updates
  // ws-client.js's local cachedConfig — the exact same staleness bug the
  // 2026-07-21 fix above already worked around for the "populate" direction.
  // clearPersistedBucket() needs to EXPLICITLY mark a bucket empty so this
  // function doesn't fall through to getConfig() and silently resurrect the
  // stale (pre-clear) blob within the same running session. Distinguish "key
  // never checked" (fall through to getConfig, as before) from "key checked
  // and known empty/cleared" (hasOwnProperty true, value null) instead of a
  // plain truthy check, which conflated the two.
  let blob;
  if (Object.prototype.hasOwnProperty.call(acctBucketCache, key)) {
    blob = acctBucketCache[key];
  } else {
    blob = null;
    try {
      const cfg = await window.api.getConfig();
      blob = (cfg && cfg['acctBucket__' + key]) || null;
    } catch (e) {}
    acctBucketCache[key] = blob;
  }
  const defaults = acctDefaults(size, stage);
  state.account = Object.assign({}, defaults, (blob && blob.account) || {});
  ACCT_LS_KEYS.forEach(k => {
    const v = blob && blob.ls ? blob.ls[k] : null;
    if (v != null) localStorage.setItem(k, v); else localStorage.removeItem(k);
  });

  // ── 2026-08-18 BUG FIX: "every account I previously traded shows from the
  // start." ──────────────────────────────────────────────────────────────
  // The config blob above is NOT the authoritative record — accounts/<slot>/
  // *.json is (restoreFromDisk() recomputes the balance from it on boot, and
  // csvApply/archive() mirror every change into it). But restoreFromDisk()
  // only ever ran ONCE, at boot, for whichever slot was active then. Every
  // slot switch after that restored from the config blob alone — and the
  // removeItem() above actively DELETED copilot_balance_ledger /
  // copilot_day_trades / copilot_gr_history whenever the blob happened to
  // lack them. enforceAccountInvariant() then correctly recomputed the
  // balance from an empty ledger and got the pristine start balance. A
  // traded account therefore came back as fresh, and the emptied state was
  // written straight back over the blob by the next saveActiveBucket().
  // (Confirmed on disk: accounts/s2 held a real -$211.50 day while
  // acctBucket__s2 had no ledger key at all.)
  //
  // Fix: overlay the per-slot disk mirror on EVERY load, not just at boot.
  // Disk wins only where it has real data — a genuinely wiped slot has no
  // file, so "Start fresh" still works.
  await overlaySlotDiskData();

  enforceAccountInvariant(size, stage);
  return !!blob;
}

// Reads accounts/<activeSlotId>/*.json back into the flat localStorage keys
// the rest of the app already uses. Safe to call repeatedly. Only non-empty
// datasets are applied, so this can never blank out good in-memory state.
async function overlaySlotDiskData() {
  if (!window.api || !window.api.dataLoad || !activeSlotId) return;
  const pairs = [
    ['gr_history', 'copilot_gr_history'],
    ['balance_ledger', 'copilot_balance_ledger'],
    ['day_trades', 'copilot_day_trades'],
    ['pb_tags', 'copilot_pb_tags'],
    ['maemfe', 'copilot_maemfe'],
    ['loop_state', 'copilot_loop'],
    ['ck_history', 'copilot_ck_history'],
    ['eval_milestones', 'copilot_eval_milestones'],
  ];
  for (const [key, lsKey] of pairs) {
    try {
      const v = await window.api.dataLoad(slotDataKey(key));
      const nonEmpty = v && (Array.isArray(v) ? v.length : Object.keys(v).length);
      if (nonEmpty) localStorage.setItem(lsKey, JSON.stringify(v));
    } catch (e) {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE INVARIANT (2026-07-25) — added after Anoop restarted repeatedly and the
// balance stayed $50,359 on an account showing "0 days". His words: "my numbers
// are more important for me to take any decision on day to day bases."
//
// A trading account's balance is NOT free-floating data — it is DERIVED:
//     balance = startBalance + sum(every logged day's net)
// So with ZERO days logged, the balance can only be the starting balance.
// Anything else is corruption, full stop. Same for the floor.
//
// Rather than chase which of the four storage layers leaked this time, this
// recomputes the derived fields from the ledger on EVERY load and render. If the
// ledger and the displayed balance ever disagree, the LEDGER WINS — it's the
// only auditable source. This makes the numbers self-healing instead of
// depending on me having found every hiding place.
// ═══════════════════════════════════════════════════════════════════════════════
function enforceAccountInvariant(size, stage) {
  size = size || state.accountSize; stage = stage || state.mode;
  const prof = ACCOUNT_PROFILES[size] && ACCOUNT_PROFILES[size][stage];
  if (!prof || !state.account) return;
  const isEval = stage === 'eval';
  const start = prof.startBalance;
  const buffer = isEval ? prof.maxLoss : prof.floorBuffer;

  let ledger = {};
  try { ledger = JSON.parse(localStorage.getItem('copilot_balance_ledger') || '{}') || {}; } catch (e) {}
  const days = Object.keys(ledger).sort();

  // 2026-08-17 (Anoop: "let the HUD give information to left panel... CSV
  // should be optional"): if today has no CSV entry yet, but the live broker
  // feed is connected, fold today's live P&L into THIS SAME computation as
  // an extra day — still one canonical ledger-is-truth calculation, just
  // extended to accept live data for TODAY when CSV hasn't filled it in yet.
  // Deliberately NOT written into copilot_balance_ledger — recomputed fresh
  // every call, so a bad live read can never corrupt the real CSV record,
  // and a CSV upload for today always wins over it (checked first, below).
  const todayKey = csvDayKey();
  let liveTodayNet = null;
  if (!ledger[todayKey]) {
    try {
      const gs = JSON.parse(localStorage.getItem('copilot_guardrail_v1') || 'null');
      if (gs && gs.live && gs.live.connected) liveTodayNet = gs.live.dayPnl || 0;
    } catch (e) {}
  }

  // Recompute balance + EOD-trailing floor straight from the ledger (+ live today, if applicable).
  const lockFloorValue = start + 100;
  let bal = start, floor = start - buffer;
  days.forEach(d => {
    bal += (ledger[d] && ledger[d].net) || 0;
    floor = Math.min(lockFloorValue, Math.max(floor, bal - buffer));
  });
  const usingLiveToday = liveTodayNet != null;
  if (usingLiveToday) {
    bal += liveTodayNet;
    floor = Math.min(lockFloorValue, Math.max(floor, bal - buffer));
  }
  bal = Math.round(bal * 100) / 100;

  const acc = state.account;
  const before = acc.balance;
  acc.balance = bal;
  acc.balanceSource = usingLiveToday ? 'live' : 'csv'; // 2026-08-17: read by updateAccountUI for a source label
  if (isEval) acc.evalFloor = Math.round(floor); else acc.fundedFloor = Math.round(floor);
  // Deterministic-from-terms fields — never trusted from storage.
  const d = acctDefaults(size, stage);
  if (isEval) { acc.evalTarget = d.evalTarget; acc.evalDayCap = d.evalDayCap; }
  else { acc.payoutTarget = d.payoutTarget; acc.fundedDayStop = d.fundedDayStop; }
  if (usingLiveToday) acc.profit = Math.round(liveTodayNet);
  else if (!days.length) acc.profit = 0;   // no days logged, no live today → today's P&L can't be non-zero

  // Keep the global config keys in step so a reload can't resurrect the old
  // value — but ONLY for a CSV-derived balance. A live-derived one is an
  // estimate, not a confirmed ledger fact, and should not survive a restart
  // as if it were; a fresh live update re-applies within ~10s anyway once
  // the feed reconnects.
  if (!usingLiveToday) {
    try {
      window.api.setConfig('balance', bal);
      if (isEval) window.api.setConfig('evalFloor', Math.round(floor)); else window.api.setConfig('fundedFloor', Math.round(floor));
      if (!days.length) window.api.setConfig('profit', 0);
    } catch (e) {}
  }

  // Don't fire the "corrected" chat message for an expected live-vs-ledger
  // difference (dayPnl legitimately moves every poll) — only warn when the
  // CSV-only computation itself disagreed with storage, the real
  // drift/corruption case this was built to catch.
  if (!usingLiveToday && before != null && Math.abs(before - bal) > 0.01 && typeof addSystemMessage === 'function') {
    addSystemMessage(`Corrected balance from the ledger: $${Math.round(before).toLocaleString()} → $${Math.round(bal).toLocaleString()} (${days.length} day${days.length === 1 ? '' : 's'} logged). The ledger is the source of truth.`);
  }
}

// Switch the active account+stage: persist whatever's currently loaded, pull
// in the target bucket (or genuinely empty defaults if never used), re-render
// every panel, and confirm the switch BY ACCOUNT NUMBER in chat — not just a
// mode label — per Anoop's 2026-07-21 request to always be sure which
// account is live.
// 2026-07-25: now slot-aware. If a slot already IS this size+stage, switch to
// that slot (preserving its own data). Otherwise retune the active slot. This
// keeps every existing caller — titlebar buttons, auto-promotion, Jessi's
// switch_account action, the gate rows — working unchanged.
async function switchAccount(size, stage, opts) {
  opts = opts || {};
  const match = acctSlots.filter(s => s.size === size && s.stage === stage)[0];
  if (match && match.id !== activeSlotId) { return switchSlot(match.id, opts); }
  if (state.accountSize === size && state.mode === stage && !opts.force) { _renderMode(stage); return; }
  saveActiveBucket();
  state.accountSize = size; state.mode = stage;
  { const sl = acctSlot(); sl.size = size; sl.stage = stage; persistSlots(); }
  const hadData = await loadAccountBucket(size, stage);
  // 2026-08-16: opening a genuinely fresh eval slot IS "starting a new
  // evaluation" (journey-tracker.js) — this is the one place every path that
  // begins a new eval attempt funnels through (the account gate, the titlebar
  // toggle, and the post-breach re-open all call switchAccount). The
  // opts.promoted branch is excluded: that transition is recorded explicitly
  // by slotClearedToFunded, on the SAME journey, not a new one.
  if (!hadData && stage === 'eval' && !opts.promoted) {
    try {
      const sl = acctSlot();
      window.api.journeyAction('start', { slotId: sl.id, size: size, startBalance: state.account.balance }).catch(() => {});
    } catch (e) {}
  }
  window.api.setConfig('accountSize', size);
  window.api.setConfig('mode', stage);
  _renderMode(stage);
  updateAccountUI();
  if (typeof updateRulesTab === 'function') updateRulesTab();
  if (typeof grRender === 'function') grRender();
  if (typeof renderInsights === 'function') renderInsights();
  const prof = ACCOUNT_PROFILES[size][stage];
  const idNote = prof.accountId ? ` — account ${prof.accountId}` : (prof.notOpened ? ' — not opened yet, placeholder only' : ' — no account number on file yet');
  const placeholderNote = prof.placeholder ? ' ⚠ Terms for this account/stage are ASSUMED, not confirmed with Lucid — verify before relying on them.' : '';
  const emptyNote = !hadData ? ' Starting fresh — this account/stage has no data yet.' : '';
  if (opts.promoted) {
    addSystemMessage(`🎯 ${ACCOUNT_PROFILES[size].eval.label} EVAL TARGET HIT — auto-promoted to ${ACCOUNT_PROFILES[size].label} FUNDED${idNote}.${placeholderNote}${emptyNote} Funded rules now active.`);
  } else if (opts.announce !== false) {
    addSystemMessage(`Switched to ${ACCOUNT_PROFILES[size].label} ${stage.toUpperCase()}${idNote}.${placeholderNote}${emptyNote}`);
  }
}

// FIX (2026-07-21): user-facing alias kept for the existing EVAL/FUNDED
// toggle buttons in index.html — now routes through the bucket system above
// instead of only flipping state.mode, so switching stages is always
// data-isolated for whichever account SIZE is currently active.
function switchMode(mode) { switchAccount(state.accountSize, mode); }

// ── Trading mode (Standard / Scalper) ────────────────────────────────────────
function switchTradingMode(mode) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'trading-mode-set', mode: mode }));
  applyTradingModeUI(mode);
}
function applyTradingModeUI(mode) {
  const stdBtn = document.getElementById('tmode-standard-btn');
  const scBtn = document.getElementById('tmode-scalper-btn');
  if (stdBtn) stdBtn.classList.toggle('active', mode === 'standard');
  if (scBtn) scBtn.classList.toggle('active', mode === 'scalper');
}

// ── Account breach/clear archiving (2026-07-22) ─────────────────────────────
// Anoop's request: when an account breaches (or clears into funded), archive
// everything about it to a durable file BEFORE wiping the slate, so nothing
// is lost when the same size+stage bucket gets reused for the next attempt.
// Reuses the existing 2026-07-21 multi-account bucket architecture above
// rather than building a parallel storage path — snapshot the same fields
// saveActiveBucket() would persist, write them to their own file via
// window.api.dataSave (durable, data/account_archives.json on disk).
// Distills the raw archived localStorage blob down to actual takeaways —
// reusing insCoachNotes() (the same per-day mistake/positive tagger that
// drives the Insights day cards) instead of dumping raw JSON, so what's
// "noted" is actually readable later, not just backed up. insCoachNotes is a
// plain top-level function declared further down this file — safe to call
// here because function declarations hoist across the whole script.
function buildLessons(ls) {
  let hist = []; try { hist = JSON.parse(ls.copilot_gr_history || '[]'); } catch (e) {}
  let goodtrades = []; try { goodtrades = JSON.parse(ls.copilot_goodtrades || '[]'); } catch (e) {}
  const mistakeCount = {}, positiveCount = {};
  let totalTrades = 0, discSum = 0, discN = 0;
  hist.forEach(r => {
    totalTrades += (r.n || 0);
    if (typeof r.disc === 'number') { discSum += r.disc; discN++; }
    const notes = (r.dow !== undefined && typeof insCoachNotes === 'function') ? insCoachNotes(r) : [];
    notes.forEach(n => {
      if (n.c === 'bad') mistakeCount[n.t] = (mistakeCount[n.t] || 0) + 1;
      else if (n.c === 'good') positiveCount[n.t] = (positiveCount[n.t] || 0) + 1;
    });
  });
  const topSorted = (obj) => Object.keys(obj).sort((a, b) => obj[b] - obj[a]).slice(0, 6)
    .map(t => obj[t] > 1 ? (t + ' (×' + obj[t] + ')') : t);
  const positives = topSorted(positiveCount);
  if (goodtrades.length) positives.push(goodtrades.length + ' good-trade analysis log' + (goodtrades.length === 1 ? '' : 's') + ' saved');
  return {
    totalDays: hist.length,
    totalTrades,
    avgDisc: discN ? Math.round(discSum / discN) : null,
    mistakes: topSorted(mistakeCount),
    positives
  };
}

// 2026-08-13 REFACTOR — was hardcoded to state.account/state.mode (the ACTIVE
// slot only). Anoop asked for breach/clear buttons "beside the account" in
// the ⇄ Account picker rows, which must work on ANY slot, not just whichever
// one happens to be loaded. Generalized to take the slot + its account/ls data
// explicitly; the ACTIVE-slot callers below pass state.account + live
// localStorage, everything else passes the slot's cached bucket.
function buildArchiveRecord(slot, accountData, lsData, eventType) {
  const prof = ACCOUNT_PROFILES[slot.size][slot.stage];
  const record = {
    archivedAt: new Date().toISOString(),
    event: eventType, // 'breached' | 'cleared'
    size: slot.size, stage: slot.stage,
    label: (slot.name || ACCOUNT_PROFILES[slot.size].label) + ' ' + slot.stage.toUpperCase(),
    accountId: prof.accountId || null,
    slotId: slot.id,
    account: Object.assign({}, accountData),
    ls: Object.assign({}, lsData)
  };
  record.lessons = buildLessons(record.ls);
  return record;
}

async function persistArchiveRecord(record) {
  let archives = [];
  try {
    if (window.api && window.api.dataLoad) archives = await window.api.dataLoad('account_archives');
    if (!Array.isArray(archives)) archives = [];
  } catch (e) { archives = []; }
  archives.push(record);
  try { if (window.api && window.api.dataSave) await window.api.dataSave('account_archives', archives); } catch (e) { console.error('Archive save failed:', e.message); }
  ARCHIVE_CACHE = archives; // keep the Insights-tab archive viewer in sync without a refetch
  return record;
}

// Read a slot's account+ls data WITHOUT assuming it's the active one. Active
// slot's real data is live (state.account + localStorage); any other slot's
// data lives only in the bucket cache/config.
async function readSlotBucketData(slot) {
  if (slot.id === activeSlotId) {
    const ls = {};
    ACCT_LS_KEYS.forEach(k => { ls[k] = localStorage.getItem(k); });
    return { account: Object.assign({}, state.account), ls: ls };
  }
  let blob = acctBucketCache[slot.id];
  if (blob === undefined) {
    let cfg = {};
    try { cfg = (await window.api.getConfig()) || {}; } catch (e) {}
    blob = cfg['acctBucket__' + slot.id] || null;
  }
  return { account: (blob && blob.account) || acctDefaults(slot.size, slot.stage), ls: (blob && blob.ls) || {} };
}

// BUG FIX 2026-08-13 (found while wiring per-account breach/clear buttons —
// same bug flagged in that morning's /plan-eng-review as B1): the OLD
// clearPersistedBucket(size, stage) built key = size + '_' + stage, a LEGACY
// scheme from before the 2026-07-25 slot system. Every real bucket read/write
// is keyed by SLOT ID (see acctBucketKey(), loadAccountBucket()) — a slot's
// bucket key never changes when its `stage` field changes. So the old clear
// calls in accountClearedToFunded() were pure no-ops: they cleared a key
// nothing ever reads, while the slot's REAL bucket (still keyed by slot.id)
// kept its full eval ledger. switchAccount() would then load that same
// uncleaned bucket under the 'funded' label, and enforceAccountInvariant()
// would compute funded balance = fundedStart + sum(every eval day) — a wrong,
// inflated floor on a live funded account. This resets the ACTUAL key.
async function resetSlotBucket(slot) {
  const fresh = { account: acctDefaults(slot.size, slot.stage), ls: {} };
  acctBucketCache[slot.id] = fresh;
  try { await window.api.setConfig('acctBucket__' + slot.id, fresh); } catch (e) {}
  return fresh.account;
}

// Refresh whatever's currently on screen after a breach/clear action —
// active-slot panels if it was the loaded one, always the account gate rows
// (breach/clear can be triggered on the loaded OR an unloaded slot).
function refreshAfterSlotAction(wasActive) {
  if (wasActive) {
    updateAccountUI();
    if (typeof updateRulesTab === 'function') updateRulesTab();
    if (typeof grRender === 'function') grRender();
    if (typeof renderInsights === 'function') renderInsights();
  }
  const gateEl = document.getElementById('account-gate');
  if (gateEl && gateEl.style.display !== 'none') showAccountGate(state.accountSize, state.mode);
}

// Mark ANY slot BREACHED — works whether or not it's the currently active
// account. Archives its full trade/insight history to account_archives.json,
// marks it breached in the Cost tab, then resets that SAME slot to fresh
// (same size+stage) so it's ready for a new attempt. Does not retire/hide the
// slot — that's the separate auto-detect path in retireSlot(), which fires
// when the LEDGER itself shows a breach; this is the manual "I know it's
// gone, record it now" action.
// 2026-08-13 (autoplan Design review, finding #2): this is a 4-step async
// chain (archive read → archive write → cost-tab update → bucket reset)
// against a real-money account slot, and the button stayed clickable the
// entire time — a second click before the first finished ran the whole
// pipeline twice (two archive records, two cost-tab writes). ckButtonBusy()
// disables the actual clicked element for the duration; try/finally
// guarantees it re-enables even if something in the chain throws.
function ckButtonBusy(ev, busyLabel, fn) {
  const btn = ev && ev.currentTarget;
  const original = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = busyLabel; }
  return Promise.resolve(fn()).finally(() => {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  });
}

async function slotBreached(slot, ev) {
  const label = (slot.name || ACCOUNT_PROFILES[slot.size].label) + ' ' + slot.stage.toUpperCase();
  const kind = slot.stage === 'eval' ? 'Evaluation' : 'Funded';
  if (!confirm(`Mark ${label} as BREACHED?\n\nThis archives all current trade/insight data (with mistakes/positives noted) to a file, marks it breached in the Cost tab, then wipes this account's slate clean for your next attempt. This cannot be undone from here.`)) return;

  await ckButtonBusy(ev, 'Archiving…', async () => {
    const wasActive = slot.id === activeSlotId;
    const { account: accountData, ls: lsData } = await readSlotBucketData(slot);
    const record = await persistArchiveRecord(buildArchiveRecord(slot, accountData, lsData, 'breached'));
    const costRes = await costMarkAccountBreached(slot.size, slot.stage, record.archivedAt);

    const freshAccount = await resetSlotBucket(slot);
    if (wasActive) {
      state.account = freshAccount;
      ACCT_LS_KEYS.forEach(k => localStorage.removeItem(k));
    }
    refreshAfterSlotAction(wasActive);

    // 2026-08-16: single-dataset journey record (see journey-tracker.js) —
    // fire-and-forget, same as every other archive write in this function;
    // must never be the thing that blocks the actual breach action.
    try {
      window.api.journeyAction(slot.stage === 'eval' ? 'eval-breach' : 'funded-breach', {
        slotId: slot.id, finalBalance: (accountData && accountData.balance) || null
      }).then(() => { if (typeof renderInsights === 'function') renderInsights(); }).catch(() => {});
    } catch (e) {}

    const costNote = costRes.matched
      ? ' Cost tab entry marked BLOWN.'
      : ' ⚠ No matching fee row found in Cost tab — add/confirm it there so lifetime spend stays accurate.';
    addSystemMessage(`📉 ${kind} breached — ${label}. History + mistakes/positives archived (see Insights → Past Accounts).${costNote} Starting fresh — this account/stage has no data now.`);
  });
}

// Mark a FUNDED slot's FIRST PAYOUT — the third terminal outcome alongside
// breach/clear (eval → breach|clear; funded → breach|payout). A payout is not
// a loss of the account: the slot keeps trading funded afterward, so this
// archives the payout period's history (same buildArchiveRecord/persistArchiveRecord
// path breach/clear use, event='payout') and resets the ledger fresh for the
// NEXT payout period, rather than retiring the slot.
async function slotPaidOut(slot, ev) {
  if (slot.stage !== 'funded') { addSystemMessage('Payouts apply to FUNDED accounts only.'); return; }
  const label = slot.name || ACCOUNT_PROFILES[slot.size].label;
  if (!confirm(`Record FIRST PAYOUT for ${label} FUNDED?\n\nThis archives the current funded period's data (with mistakes/positives noted) to a file, marks it paid-out in the Cost tab, then starts the next funded period with a clean ledger. This account stays FUNDED.`)) return;

  await ckButtonBusy(ev, 'Recording payout…', async () => {
    const wasActive = slot.id === activeSlotId;
    const { account: accountData, ls: lsData } = await readSlotBucketData(slot);
    const record = await persistArchiveRecord(buildArchiveRecord(slot, accountData, lsData, 'payout'));
    const costRes = await costMarkAccountPaidOut(slot.size, slot.stage, record.archivedAt);

    slot.payoutAt = record.archivedAt;
    slot.payoutCount = (slot.payoutCount || 0) + 1;
    persistSlots();
    const freshAccount = await resetSlotBucket(slot);
    if (wasActive) {
      state.account = freshAccount;
      ACCT_LS_KEYS.forEach(k => localStorage.removeItem(k));
    }
    refreshAfterSlotAction(wasActive);

    try {
      window.api.journeyAction('funded-payout', {
        slotId: slot.id, finalBalance: (accountData && accountData.balance) || null, payoutCount: slot.payoutCount
      }).then(() => { if (typeof renderInsights === 'function') renderInsights(); }).catch(() => {});
    } catch (e) {}

    const costNote = costRes.matched
      ? ' Cost tab entry marked PAID OUT.'
      : ' ⚠ No matching fee row found in Cost tab — add/confirm it there so lifetime spend stays accurate.';
    addSystemMessage(`💰 First payout recorded — ${label}. History archived (see Insights → Past Accounts).${costNote} Still FUNDED — ledger reset for the next period.`);
  });
}

// Mark an EVAL slot CLEARED and move it to FUNDED — works on the active slot
// or any other. Archives eval history, marks it passed in the Cost tab, then
// starts FUNDED on that SAME slot with a clean slate (does not inherit the
// eval ledger — see resetSlotBucket's bug-fix note above for why the old path
// silently failed to guarantee that).
// Shared core: archive eval history, mark Cost tab passed, transition the
// slot to funded, reset its bucket fresh. Used by BOTH the manual "EVAL
// CLEARED" button (slotClearedToFunded, after a confirm dialog) and the
// automatic promotion that fires the moment a live eval balance crosses
// target (checkAutoPromotion).
// FIX (2026-08-18): checkAutoPromotion() previously called switchAccount()
// directly and skipped every step here — the same bug class as B2 from the
// 2026-08-13 review, just surfaced in the AUTOMATIC path instead of the
// manual button. Since auto-promotion is the path that actually fires on a
// live target hit, every real eval→funded promotion was silently discarding
// the eval history bundle (no archive, no Cost-tab passed mark, no journey
// record) instead of the manual button's correct behavior.
async function promoteSlotToFunded(slot) {
  const wasActive = slot.id === activeSlotId;
  const { account: accountData, ls: lsData } = await readSlotBucketData(slot);
  const record = await persistArchiveRecord(buildArchiveRecord(slot, accountData, lsData, 'cleared'));
  await costMarkAccountPassed(slot.size, 'eval', record.archivedAt);

  slot.stage = 'funded';
  persistSlots();
  const freshAccount = await resetSlotBucket(slot); // resets under the SAME slot.id, now stage='funded'

  // 2026-08-16: closes the eval phase AND opens funded on the SAME journey
  // record (journey-tracker.js) — the fix for the eval/funded data
  // cross-contamination found in the old per-click archive mechanism.
  try {
    window.api.journeyAction('eval-cleared', {
      slotId: slot.id, finalBalance: (accountData && accountData.balance) || null,
      fundedStartBalance: freshAccount ? freshAccount.balance : null
    }).then(() => { if (typeof renderInsights === 'function') renderInsights(); }).catch(() => {});
  } catch (e) {}

  return { wasActive, accountData };
}

async function slotClearedToFunded(slot, ev) {
  if (slot.stage !== 'eval') { addSystemMessage('Already FUNDED — nothing to promote.'); return; }
  const label = slot.name || ACCOUNT_PROFILES[slot.size].label;
  if (!confirm(`Mark ${label} EVAL as CLEARED and move to FUNDED?\n\nThis archives all current eval data (with mistakes/positives noted) to a file, marks it passed in the Cost tab, then starts FUNDED with a clean slate.`)) return;

  await ckButtonBusy(ev, 'Promoting…', async () => {
    const { wasActive } = await promoteSlotToFunded(slot);
    if (wasActive) {
      // switchAccount() re-runs loadAccountBucket() (reloads what resetSlotBucket
      // just wrote — genuinely fresh, per the bug fix above) and does the full
      // state.mode/UI/config sync + the "auto-promoted" system message.
      await switchAccount(slot.size, 'funded', { promoted: true });
    } else {
      refreshAfterSlotAction(false);
      addSystemMessage(`🎯 ${label} EVAL CLEARED — moved to FUNDED. Funded rules now active for this account. Eval history archived (see Insights → Past Accounts).`);
    }
  });
}

// Insights tab buttons still operate on whichever slot is currently loaded —
// thin wrappers over the slot-scoped functions above so there is exactly one
// implementation, not two that can drift.
async function accountBreached(ev) { await slotBreached(acctSlot(), ev); }
async function accountClearedToFunded(ev) { await slotClearedToFunded(acctSlot(), ev); }
async function accountPaidOut(ev) { await slotPaidOut(acctSlot(), ev); }

// After every balance recompute (csvApply), check whether the ACTIVE eval
// account just cleared its target. If so, auto-promote to funded per Anoop's
// explicit instruction: "once i reach target of evaluation it should start
// for funded with funded rules." Funded starts genuinely empty — it does NOT
// carry over the eval stage's trade history/ledger (that history goes through
// promoteSlotToFunded's archive step instead, same as the manual button).
// promotionInFlight guards the same double-fire race ckButtonBusy guards on
// the manual path: state.mode only flips to 'funded' once switchAccount()
// resolves at the end of the chain, so a second balance tick arriving before
// that (e.g. two ticks a poll interval apart) would otherwise re-enter and
// archive/promote twice.
let promotionInFlight = false;
function checkAutoPromotion() {
  if (state.mode !== 'eval' || promotionInFlight) return;
  const prof = ACCOUNT_PROFILES[state.accountSize].eval;
  if (state.account.balance >= prof.startBalance + prof.target) {
    promotionInFlight = true;
    const slot = acctSlot();
    promoteSlotToFunded(slot)
      .then(() => switchAccount(state.accountSize, 'funded', { promoted: true }))
      .catch(e => console.error('Auto-promotion failed:', e.message))
      .finally(() => { promotionInFlight = false; });
  }
}

// ── Startup account-confirmation gate ───────────────────────────────────────
// Shown on every launch per Anoop's 2026-07-21 request ("on start of the app
// it should confirm which account i am trading"). Behind the gate the app has
// already loaded the remembered account's real data (no blank flash) — the
// gate is a confirmation/switch step layered on top, not a data-loading block.
// 2026-07-25: rows now show each bucket's REAL saved state — balance, last
// traded date, and a BREACHED flag when balance is below that stage's floor.
// Anoop's exact complaint was "I do not know if the data is actually from my
// past or in the present": the gate previously showed only an account number,
// so a dead bucket (e.g. 50K EVAL sitting at $47,125 against a $49,628 floor —
// a NEGATIVE buffer, i.e. already blown) looked identical to a live one.
// Each stale row also gets a "Start fresh" action so old blown-account data
// can be wiped without hunting through the Insights tab.
// bucketKey: either a slot id ('s1') or a legacy 'size_stage' key.
// size/stage are still needed to resolve the profile's floor + startBalance.
function gatePeekBucket(cfg, bucketKey, size, stage) {
  const blob = (cfg && cfg['acctBucket__' + bucketKey]) || null;
  if (!blob) return null;
  const acc = blob.account || {};
  let lastDate = null, days = 0;
  try {
    const led = JSON.parse((blob.ls && blob.ls['copilot_balance_ledger']) || '{}') || {};
    const keys = Object.keys(led).sort();
    days = keys.length;
    lastDate = keys[keys.length - 1] || null;
  } catch (e) {}
  const prof = ACCOUNT_PROFILES[size][stage];
  // 2026-07-25: derive from THIS bucket's ledger rather than its stored balance,
  // so the picker can never advertise a number the ledger doesn't support
  // (a slot reading "$50,359 · 0 days" is exactly that contradiction).
  const _buffer = stage === 'eval' ? prof.maxLoss : prof.floorBuffer;
  const _lock = prof.startBalance + 100;
  let _bal = prof.startBalance, _floor = prof.startBalance - _buffer;
  try {
    const _led = JSON.parse((blob.ls && blob.ls['copilot_balance_ledger']) || '{}') || {};
    Object.keys(_led).sort().forEach(k => {
      _bal += (_led[k] && _led[k].net) || 0;
      _floor = Math.min(_lock, Math.max(_floor, _bal - _buffer));
    });
  } catch (e) {}
  const floor = Math.round(_floor);
  const bal = Math.round(_bal * 100) / 100;
  const breached = (bal != null && floor != null) ? bal < floor : false;
  const start = prof.startBalance;
  return { bal, floor, breached, lastDate, days, start };
}

async function showAccountGate(size, stage) {
  const el = document.getElementById('account-gate');
  if (!el) return;
  const prof = ACCOUNT_PROFILES[size][stage];
  document.getElementById('gate-current-label').textContent = `${ACCOUNT_PROFILES[size].label} ${stage.toUpperCase()}`;
  document.getElementById('gate-current-id').textContent = prof.accountId ? prof.accountId : (prof.notOpened ? 'Not opened yet' : 'No account number on file');

  let cfg = {};
  try { cfg = (await window.api.getConfig()) || {}; } catch (e) {}

  const rowsEl = document.getElementById('gate-account-rows');
  rowsEl.innerHTML = '';

  // One row per SLOT (5 of them). Each row: editable name, size + stage
  // dropdowns, live saved-state readout, breach flag, Start-fresh.
  // 2026-07-25: breached accounts are RETIRED and hidden — Lucid closes them to
  // trading, so offering them in a "which account are you trading" picker is
  // just an invitation to a mistake. They're auto-logged to the Cost tab and
  // their history stays in the archive.
  let retiredCount = 0;
  for (const slot of acctSlots) {
    const pk = gatePeekBucket(cfg, slot.id, slot.size, slot.stage);
    if (pk && pk.breached && !slot.retired) { await retireSlot(slot, pk); }
    if (slot.retired) retiredCount++;
  }

  acctSlots.filter(s => !s.retired).forEach(slot => {
    const isCurrent = slot.id === activeSlotId;
    // Slot-keyed only — no legacy fallback. The old size_stage fallback is what
    // let two slots of the same size display each other's data.
    const peek = gatePeekBucket(cfg, slot.id, slot.size, slot.stage);
    const row = document.createElement('div');
    row.className = 'gate-row gate-slot' + (isCurrent ? ' current' : '') + (peek && peek.breached ? ' breached' : '');

    let stateTxt;
    if (!peek) stateTxt = 'Empty — no data yet';
    else {
      const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
      const when = peek.lastDate ? fmtDMY(peek.lastDate) : 'no days logged';
      stateTxt = `${money(peek.bal)} · last traded ${when} · ${peek.days} day${peek.days === 1 ? '' : 's'}`;
    }

    row.innerHTML =
      `<input class="gate-slot-name" value="${(slot.name || '').replace(/"/g, '&quot;')}" title="Rename this account">` +
      `<select class="gate-slot-size">` +
        ['50k', '100k', '150k'].map(s => `<option value="${s}"${slot.size === s ? ' selected' : ''}>${ACCOUNT_PROFILES[s].label}</option>`).join('') +
      `</select>` +
      `<select class="gate-slot-stage">` +
        ['eval', 'funded'].map(s => `<option value="${s}"${slot.stage === s ? ' selected' : ''}>${s.toUpperCase()}</option>`).join('') +
      `</select>` +
      `<span class="gate-row-id">${stateTxt}</span>` +
      (isCurrent ? '<span class="gate-row-tag">ACTIVE</span>' : '');

    // Editing name/size/stage must NOT trigger the row's "trade this" click.
    const nameEl = row.querySelector('.gate-slot-name');
    const sizeEl = row.querySelector('.gate-slot-size');
    const stageEl = row.querySelector('.gate-slot-stage');
    [nameEl, sizeEl, stageEl].forEach(e => e.onclick = (ev) => ev.stopPropagation());
    nameEl.onchange = () => { slot.name = nameEl.value.trim() || slot.id; persistSlots(); };
    sizeEl.onchange = async () => {
      slot.size = sizeEl.value; persistSlots();
      if (slot.id === activeSlotId) await setActiveSlotConfig(slot.size, slot.stage);
      showAccountGate(state.accountSize, state.mode);
    };
    stageEl.onchange = async () => {
      slot.stage = stageEl.value; persistSlots();
      if (slot.id === activeSlotId) await setActiveSlotConfig(slot.size, slot.stage);
      showAccountGate(state.accountSize, state.mode);
    };

    const go = document.createElement('button');
    go.className = 'gate-slot-go';
    go.textContent = isCurrent ? 'Continue' : 'Trade this';
    go.onclick = async (ev) => {
      ev.stopPropagation();
      await switchSlot(slot.id, { force: isCurrent });
      hideAccountGate();
      // 2026-08-13 (Anoop): "it should open up and should be done as first step
      // after choosing account type. After that, all the other tasks come."
      // Picking the account is the moment the session starts, so this is where
      // the checklist gets the first word.
      try { if (typeof ckAfterAccountChosen === 'function') ckAfterAccountChosen(); } catch (e) {}
    };
    row.appendChild(go);

    if (peek) {
      const fresh = document.createElement('button');
      fresh.className = 'gate-fresh-btn';
      fresh.textContent = 'Start fresh';
      fresh.title = 'Wipe this slot back to its starting balance — other accounts untouched';
      fresh.onclick = async (ev) => {
        ev.stopPropagation();
        const startBal = ACCOUNT_PROFILES[slot.size][slot.stage].startBalance;
        if (!confirm(`Wipe "${slot.name}" back to a clean $${startBal.toLocaleString()}?\n\nClears its trade history, ledger, checklist scores and insights. Other accounts are untouched.`)) return;
        acctBucketCache[slot.id] = null;
        try { window.api.setConfig('acctBucket__' + slot.id, null); } catch (e) {}
        // 2026-07-25: a "clear" is only real when ALL THREE storage layers go.
        // 1) localStorage  2) the config bucket  3) the account's disk folder.
        // Missing #3 is what made the first version of this button look broken.
        ACCT_LS_KEYS.forEach(k => localStorage.removeItem(k));
        try { await window.api.dataWipeAccount(slot.id); } catch (e) {}
        // LAYER 4 (found 2026-07-25 from Anoop's screenshot: TARGET still read
        // $159,000 — the 150K's target — on a fresh 50K): these config keys are
        // GLOBAL, not per-account. csvApply writes them and applyConfig reads
        // them straight back into state.account, so they survived every other
        // wipe. Clear them, and reset the in-memory account to clean profile
        // defaults BEFORE reloading so nothing stale can be re-saved.
        for (const k of ['balance', 'profit', 'evalFloor', 'fundedFloor', 'evalTarget', 'evalDayCap', 'evalDayStop']) {
          try { await window.api.setConfig(k, null); } catch (e) {}
        }
        state.account = acctDefaults(slot.size, slot.stage);
        await switchSlot(slot.id, { force: true, announce: false, skipSave: true });
        hideAccountGate();
        if (typeof addSystemMessage === 'function') addSystemMessage(`"${slot.name}" reset to a clean slate — $${startBal.toLocaleString()}, no history.`);
      };
      row.appendChild(fresh);
    }

    // 2026-08-13 (Anoop): "a button... beside the account in a minimalist
    // style" that indicates/marks breach or eval→funded clearance, per slot,
    // right in the picker row. Stage-scoped: eval gets BOTH actions (it can
    // fail OR pass), funded gets only breach (there's no further stage to
    // clear into). Always shown, even on an empty/fresh slot — this is a
    // manual declaration, not something gated on ledger state.
    const status = document.createElement('div');
    status.className = 'gate-status-actions';
    if (slot.stage === 'eval') {
      const breachBtn = document.createElement('button');
      breachBtn.className = 'gate-status-btn gate-status-breach';
      breachBtn.textContent = 'Eval breached';
      breachBtn.title = 'Mark this evaluation account breached — archives its data and resets it fresh';
      breachBtn.onclick = (ev) => { ev.stopPropagation(); slotBreached(slot, ev); };
      status.appendChild(breachBtn);

      const clearBtn = document.createElement('button');
      clearBtn.className = 'gate-status-btn gate-status-clear';
      clearBtn.textContent = 'Cleared → Funded';
      clearBtn.title = 'Mark this evaluation cleared and move it to FUNDED — archives eval data, starts funded fresh';
      clearBtn.onclick = (ev) => { ev.stopPropagation(); slotClearedToFunded(slot, ev); };
      status.appendChild(clearBtn);
    } else {
      const breachBtn = document.createElement('button');
      breachBtn.className = 'gate-status-btn gate-status-breach';
      breachBtn.textContent = 'Funded breached';
      breachBtn.title = 'Mark this funded account breached — archives its data and resets it fresh';
      breachBtn.onclick = (ev) => { ev.stopPropagation(); slotBreached(slot, ev); };
      status.appendChild(breachBtn);
    }
    row.appendChild(status);

    rowsEl.appendChild(row);
  });

  // Footer: retired-account note + a rebuild escape hatch.
  const foot = document.createElement('div');
  foot.className = 'gate-foot';
  foot.innerHTML = (retiredCount
    ? `<span class="gate-foot-note">${retiredCount} breached account${retiredCount === 1 ? '' : 's'} hidden — closed to trading, logged in the Cost tab.</span>`
    : '<span class="gate-foot-note">Switch accounts any time from the ⇄ button in the title bar.</span>');
  const rebuild = document.createElement('button');
  rebuild.className = 'gate-fresh-btn';
  rebuild.textContent = 'Rebuild list';
  rebuild.title = 'Re-derive all 5 slots from your original per-size data. Use this if an account shows a balance that does not match its size.';
  rebuild.onclick = async (ev) => {
    ev.stopPropagation();
    if (!confirm('Rebuild the account list from your original per-size data?\n\nNothing is deleted — each slot is re-pointed at the right account\'s history. Use this if a slot shows a balance that does not match its size.')) return;
    await rebuildSlotsFromLegacy();
    showAccountGate(state.accountSize, state.mode);
  };
  foot.appendChild(rebuild);
  rowsEl.appendChild(foot);
  el.style.display = 'flex';
}

function hideAccountGate() {
  const el = document.getElementById('account-gate');
  if (el) el.style.display = 'none';
}

// ── Boot ───────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  requestNotificationPermission();
  setupWsEvents();
  setupChatListeners();
  startClock();
  buildTradePips(0);
  await loadSettings();
  // loadSessions() removed 2026-07-28 — the Log tab it painted into is gone,
  // so this ran at every boot, hit a null #session-list, threw, and had the
  // error swallowed by its own try/catch. Dead work on every startup.
  refreshPrice();
  updateAccountUI();
  startMechanicalGoNogoTimer();
  ckLoadPlan();
  initVoicePause();
  updateVoicePauseUI();
  setInterval(updateVoicePauseUI, 60 * 1000); // keeps the button's title/greyout fresh and auto-clears once the window elapses
});

// FIX (2026-07-27): "when I leave a session and close the app it should auto
// save the last changed number and when I get back it should start from
// where I had left" (Anoop). Two layers: a best-effort save right as the
// window closes (setConfig is a fire-and-forget WS send to a LOCAL server on
// localhost:7433, so it lands well before the process actually tears down in
// practice), plus a periodic safety net below in case the app is force-quit
// or crashes without beforeunload firing at all (Task Manager kill, power
// loss, etc.) — the periodic save means the worst case is losing at most a
// couple minutes, not the whole session.
window.addEventListener('beforeunload', () => {
  if (typeof saveActiveBucket === 'function') { try { saveActiveBucket(); } catch (e) {} }
  window.api.removeAllListeners();
});
setInterval(() => { if (typeof saveActiveBucket === 'function') { try { saveActiveBucket(); } catch (e) {} } }, 2 * 60 * 1000);

// ── Notification permission ───────────────────────────────────────────────────
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showBrowserNotification(title, body, urgent = false) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, {
    body,
    icon: '',
    requireInteraction: urgent
  });
  if (!urgent) setTimeout(() => n.close(), 10000);
}

// ── Clock ──────────────────────────────────────────────────────────────────────
// 2026-08-15 (Anoop): "just as a reminder before new york session it should
// remind me to redo checklist via chat" — fires once, 10 min before the 7 PM
// IST NY session, ONLY if today's checklist gate isn't already open. Guarded
// by ckToday() (not a plain Date key) so it respects the same 03:30 IST
// rollover as the gate itself, and by a per-day flag so the once-a-second
// clock tick can't fire it twice.
let ckNySessionReminderDate = null;
function startClock() {
  function tick() {
    const now  = new Date();
    const ist  = new Date(now.getTime() + 5.5 * 3600000);  // getTime() is always UTC
    const h = ist.getUTCHours(), m = ist.getUTCMinutes(), s = ist.getUTCSeconds();
    const p = n => String(n).padStart(2, '0');
    const isNY = h === 19 || h === 20;  // NY session: 7:00–9:00 PM IST
    document.getElementById('session-clock').textContent =
      `${p(h)}:${p(m)}:${p(s)} IST${isNY ? '  ● NY LIVE' : ''}`;

    if (h === 18 && m === 50) {
      const today = (typeof ckToday === 'function') ? ckToday() : null;
      if (today && ckNySessionReminderDate !== today) {
        ckNySessionReminderDate = today;
        try {
          if (!ckGateIsOpen() && typeof addSystemMessage === 'function') {
            addSystemMessage('📋 NY session starts in 10 minutes — pre-trade checklist is not done yet. Redo it now before you trade.');
          }
        } catch (e) {}
      }
    }
  }
  tick(); setInterval(tick, 1000);
}

// ── TradingView connection audio alerts (2026-08-11) ───────────────────────────
// Anoop's ask, after losing a session on 08-10 to a disconnect he never noticed:
// "when tradingview disconnects from the app there should be a sound along with
// the red dot which is already present. even when connected or disconnected it
// should work."
//
// Tones are synthesised with WebAudio rather than shipped as .mp3/.wav files on
// purpose — no asset to load, no 404, no extra file that can go missing from a
// folder move. One less thing that can silently fail, which is the whole point
// of this feature.
//
// The disconnect alarm REPEATS every 30s while still disconnected (capped at 20
// reps / 10 min so it can't shriek all night if he's walked away). A single beep
// is exactly what gets missed when you're staring at a DOM — repetition is the
// feature, not an oversight. Any click silences the current run.
// 2026-08-12 — the visual half of the disconnect alert. The audio half can be
// blocked by the browser or muted by Windows; the visual half must therefore
// stand alone and be impossible to miss, not merely present. See #tv-dead-bar.
function setTvDeadVisual(dead) {
  try {
    const chip = document.getElementById('tv-status');
    const bar  = document.getElementById('tv-dead-bar');
    if (chip) chip.classList.toggle('tv-dead', !!dead);
    if (bar)  bar.classList.toggle('show', !!dead);
    // Title bleeds into the taskbar, so it reaches him even when the app is
    // behind TradingView on another monitor.
    document.title = dead ? '\u26A0 TV DISCONNECTED — Co-Pilot' : 'Co-Pilot';
  } catch (e) { /* the alert must never be the thing that breaks the UI */ }
}

const tvAudio = {
  ctx: null,
  repeatTimer: null,
  repeats: 0,
  MAX_REPEATS: 20,
  blockedWarned: false,

  // Browsers refuse to start an AudioContext without a user gesture. We create
  // it lazily and try to resume; if the app has been sitting untouched since
  // load, the first alert may be silently swallowed — so we surface that in the
  // chat log rather than letting Anoop believe the alarm is armed when it isn't.
  ensureCtx() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    } catch (e) { return null; }
  },

  // 2026-08-12 — THE REASON THE ALARM WAS SILENT.
  // ensureCtx() calls resume(), but resume() is ASYNCHRONOUS. The callers below
  // then read ctx.state on the very next line, where it is still 'suspended',
  // and bail to warnBlocked(). The first disconnect alarm therefore suppressed
  // itself every single time — precisely the alarm that matters most.
  //
  // The fix is to stop resuming at alarm time and instead unlock the context on
  // Anoop's first click/keypress anywhere in the app, which always happens long
  // before a disconnect. By the time an alarm fires the context is already
  // running, so no race exists to lose.
  armOnFirstGesture() {
    if (this._armed) return;
    this._armed = true;
    const unlock = () => {
      try {
        const ctx = this.ensureCtx();
        if (ctx && ctx.state === 'running') {
          this._unlocked = true;
          document.removeEventListener('pointerdown', unlock, true);
          document.removeEventListener('keydown', unlock, true);
        }
      } catch (e) { /* an unusable AudioContext must never break the UI */ }
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
  },

  tone(freq, startAt, durSec, gainPeak) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, ctx.currentTime + startAt);
    // Short attack/release ramps — a raw gate on a square wave clicks audibly.
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + startAt);
    gain.gain.exponentialRampToValueAtTime(gainPeak, ctx.currentTime + startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startAt + durSec);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(ctx.currentTime + startAt);
    osc.stop(ctx.currentTime + startAt + durSec + 0.02);
  },

  // Descending, urgent, deliberately unpleasant. This one means "stop".
  playDisconnect() {
    const ctx = this.ensureCtx();
    if (!ctx) return this.warnBlocked();
    if (ctx.state === 'suspended') return this.warnBlocked();
    this.tone(880, 0.00, 0.18, 0.25);
    this.tone(660, 0.22, 0.18, 0.25);
    this.tone(440, 0.44, 0.34, 0.28);
  },

  // Ascending, brief, quiet. Confirmation only — must not sound like a reward.
  playConnect() {
    const ctx = this.ensureCtx();
    if (!ctx || ctx.state === 'suspended') return;
    this.tone(660, 0.00, 0.10, 0.12);
    this.tone(880, 0.12, 0.14, 0.12);
  },

  warnBlocked() {
    if (this.blockedWarned) return;
    this.blockedWarned = true;
    try {
      addSystemMessage('⚠ Audio alerts are blocked by the browser until you click once anywhere in this window. Click now to arm the TradingView disconnect alarm.');
    } catch (e) {}
  },

  startAlarm() {
    this.stopAlarm();
    this.repeats = 0;
    this.playDisconnect();
    this.repeatTimer = setInterval(() => {
      if (++this.repeats >= this.MAX_REPEATS) return this.stopAlarm();
      this.playDisconnect();
    }, 30000);
  },

  stopAlarm() {
    if (this.repeatTimer) { clearInterval(this.repeatTimer); this.repeatTimer = null; }
    this.repeats = 0;
  }
};

// Unlock WebAudio on Anoop's first interaction so the disconnect alarm is
// already armed when it is needed. See armOnFirstGesture() for why.
try { tvAudio.armOnFirstGesture(); } catch (e) {}

// Any click both satisfies the browser's autoplay gesture requirement and
// silences an in-progress alarm — he has acknowledged it by then.
document.addEventListener('click', () => {
  tvAudio.ensureCtx();
  if (tvAudio.repeatTimer) tvAudio.stopAlarm();
});

// ── WebSocket events ───────────────────────────────────────────────────────────
function setupWsEvents() {
  window.api.onWsOpen(() => {
    // Server sends config on connect
    window.api.getConfig().then(applyConfig);
  });

  window.api.onMcpConnected(() => {
    const wasDisconnected = state.tvConnected === false;
    state.tvConnected = true;
    tvAudio.stopAlarm();
    if (wasDisconnected) tvAudio.playConnect();
    document.getElementById('tv-dot').className = 'connected';
    document.getElementById('tv-status-text').textContent = 'TradingView connected';
    setTvDeadVisual(false);
    refreshPrice();
    window.api.requestMechanicalCheck();
    // Deliberately do NOT clear the NO-GO here. Reconnecting restores the feed
    // but not a fresh read — the verdict stays blocked until the next
    // mechanical analysis actually lands and computeMechanicalGoNogo() sees
    // non-stale data. Re-running it now just re-labels the reason accurately.
    if (wasDisconnected) addSystemMessage('TradingView reconnected — waiting on a fresh Daily/1H read before the verdict can clear.');
    computeMechanicalGoNogo();
  });

  // 2026-08-11: a disconnect used to change nothing but a small grey line of
  // text in the header — quieter than a cooldown timer, and easy to miss for a
  // whole session (Anoop did, on 08-10, and kept trading). A dropped market
  // feed is at least as serious as a cooldown, so it now gets a red alert
  // banner, a chat-log line, and an immediate NO-GO recompute (the freshness
  // check in computeMechanicalGoNogo() turns !tvConnected into a hard block).
  window.api.onMcpDisconnected(({ message } = {}) => {
    const wasConnected = state.tvConnected;
    state.tvConnected = false;
    document.getElementById('tv-dot').className = 'error';
    document.getElementById('tv-status-text').textContent = message || 'TradingView offline';
    setTvDeadVisual(true);
    if (wasConnected) {
      tvAudio.startAlarm();
      if (typeof showAlertBanner === 'function') {
        showAlertBanner('⚠ TRADINGVIEW DISCONNECTED — no live chart data. NO-GO until it reconnects. Do not enter on remembered levels.', 'red');
      }
      addSystemMessage('⚠ TradingView disconnected' + (message ? ' (' + message + ')' : '') + ' — chart data is now stale. Verdict forced to NO-GO. If you are in a position, manage it on the broker DOM; do not open anything new.');
    }
    computeMechanicalGoNogo();
  });

  window.api.onMcpStatus(msg => {
    document.getElementById('tv-status-text').textContent = String(msg).slice(0, 45);
  });

  // 2026-08-19 (SEMI_AUTONOMOUS_SYSTEM_PLAN.md item 2): persistent, always-
  // visible self-test line — updated in place on every result (initial boot
  // AND every reconnect re-test), never a toast that can be missed.
  if (window.api && window.api.onLiveFeedSelfTest) {
    window.api.onLiveFeedSelfTest((msg) => {
      const el = document.getElementById('live-feed-selftest');
      if (!el) return;
      const passed = msg && msg.passed, total = (msg && msg.total) || 3;
      const failures = (msg && msg.failures) || [];
      el.style.display = 'block';
      if (passed === total) {
        el.textContent = `Live feed: ${passed}/${total} checks passed`;
        el.style.color = 'var(--green, #3ecf8e)';
      } else {
        el.textContent = `Live feed: ${passed}/${total} checks passed — ` + failures.join(' | ');
        el.style.color = 'var(--red, #ff5c5c)';
      }
    });
  }

  // 2026-08-19 (Anoop's request, first slice — see SEMI_AUTONOMOUS_SYSTEM_PLAN.md
  // "Next requested: live mistake-tracking feedback loop"): a live pattern
  // match against his own documented failure history. F1 (trade-count
  // escalation) first, advisory only per his explicit decision — a banner +
  // a permanent chat-log line, NOT a hard stop. Fires once per day
  // (server-side gated), so this only ever shows once, not spammed.
  if (window.api && window.api.onMistakePattern) {
    window.api.onMistakePattern((msg) => {
      if (!msg || !msg.message) return;
      showAlertBanner('🎯 ' + msg.message, 'amber');
      if (typeof addSystemMessage === 'function') addSystemMessage('🎯 ' + msg.message);
    });
  }

  // ── Power of 3 phase-change alerts (2026-07-29) ──────────────────────────
  // Mechanical detector on the server fires these; DISTRIBUTION is the
  // entry-relevant one (manipulation complete, reversal underway) so it gets
  // the loudest treatment. ACCUMULATION deliberately reads as "do nothing".
  window.api.onPo3PhaseChange(info => {
    if (!info) return;
    const msgs = document.getElementById('messages');
    if (!msgs) return;
    const phase = info.phase || info.to || 'UNCLEAR';
    const colour = phase === 'DISTRIBUTION' ? '#22c55e'
                 : phase === 'MANIPULATION' ? '#f59e0b'
                 : phase === 'ACCUMULATION' ? '#94a3b8' : '#64748b';
    // Symbol is stamped on every alert — Anoop trades MNQ1! and MGC1! and the
    // monitor follows whatever chart he has open, so the instrument must never
    // be ambiguous.
    const sym = info.symLabel ? ' [' + info.symLabel + ']' : '';
    const headline = phase === 'DISTRIBUTION' ? '◱ POWER OF 3' + sym + ' — DISTRIBUTION (entry-relevant)'
                   : phase === 'MANIPULATION' ? '◱ POWER OF 3' + sym + ' — MANIPULATION (trap in progress, not an entry)'
                   : '◱ POWER OF 3' + sym + ' — ' + phase;
    const d = document.createElement('div');
    d.className = 'msg assistant';
    d.innerHTML =
      '<div class="msg-bubble" style="border-left:3px solid ' + colour + '">' +
        '<div style="font-weight:700;color:' + colour + ';font-size:0.8rem;letter-spacing:.4px;margin-bottom:4px">' +
          escHtml(headline) + '</div>' +
        (info.from ? '<div style="font-size:0.72rem;opacity:.7;margin-bottom:4px">' + escHtml(info.from) + ' → ' + escHtml(phase) + ' · ' + escHtml(info.time || '') + ' IST</div>' : '') +
        '<div style="font-size:0.78rem;line-height:1.5">' + escHtml(info.reason || '') + '</div>' +
        (info.detail ? '<div style="font-size:0.75rem;margin-top:4px;opacity:.85"><b>' + escHtml(info.detail) + '</b></div>' : '') +
        '<div style="font-size:0.72rem;margin-top:5px;opacity:.7">4H bias: ' + escHtml(info.biasLabel || '—') +
          (info.rangeLow != null ? ' · opening range ' + info.rangeLow + '–' + info.rangeHigh : '') +
          (info.sweptTo != null ? ' · swept ' + info.sweptTo : '') + '</div>' +
      '</div>';
    msgs.appendChild(d);
    attachSpeakButton(d, headline + '. ' + (info.reason || '') + ' ' + (info.detail || ''));
    scrollToBottom();
    // showBrowserNotification is the app's real notifier (notify() doesn't
    // exist — caught in verification). urgent=true, same as FVG/Playbook B.
    if (phase === 'DISTRIBUTION') {
      showBrowserNotification('POWER OF 3 — DISTRIBUTION', info.reason || 'Manipulation complete, distributing with bias.', true);
    }
  });

  window.api.onPo3MonitorStatus(info => {
    const btn = document.getElementById('po3-monitor-btn');
    if (btn) {
      const on = !!(info && info.running);
      btn.classList.toggle('active', on);
      btn.textContent = on ? '◱ P3 Monitor ON' : '◱ P3 Monitor';
    }
  });

  window.api.onModeUpdate(mode => switchAccount(state.accountSize, mode));
  // 2026-08-16 (Pattern 03 voting variant): registered ONCE here, not inside
  // sendDebateMessage() — this can legitimately arrive seconds after a debate
  // call has already returned (a second independent pass trying to refute a
  // GO verdict), so it must outlive any single call's lifetime. Registering
  // it per-call with no matching unsubscribe would stack a new listener on
  // every debate and fire the same refutation multiple times after a few
  // rounds. Silent server-side when nothing was found, so this only ever
  // fires with something worth reading.
  if (window.api.onDebateRefutation) {
    window.api.onDebateRefutation((text) => {
      addSystemMessage('🔍 Second-opinion check on that GO: ' + text);
    });
  }
  // Phase 2b (2026-08-17): registered once, same reasoning as
  // onDebateRefutation above — a ticket can arrive after the debate call's
  // own promise already resolved.
  if (window.api.onTradeTicketSuggested) {
    window.api.onTradeTicketSuggested((msg) => renderTradeTicketCard(msg));
  }
  if (window.api.onTradeConfirmResult) {
    window.api.onTradeConfirmResult((msg) => tcHandleResult(msg, null));
  }
  if (window.api.onTradeConfirmRejected) {
    window.api.onTradeConfirmRejected((msg) => tcHandleResult(null, msg));
  }

  // ── Auto-triggered Debate (2026-08-17) ────────────────────────────────
  // Anoop: "i wanted it to keep a watch for me full time... tell me when
  // the setup appears." The server's PO3 monitor now auto-runs a full
  // Debate when price leaves ACCUMULATION (see server.js autoTriggerDebate)
  // and broadcasts the same debate-status/arguments/judge-token/judge-done
  // events a manual debate uses — routed here through a SEPARATE reqId
  // channel (debate:auto*) so it can never collide with a debate Anoop is
  // actively running by hand. Uses its own local bubble/buffer, not
  // state.currentAssistantBubble, for the same reason.
  let autoDebateStatusEl = null, autoDebateBubble = null, autoDebateBuffer = '';
  if (window.api.onDebateAutoTriggered) {
    window.api.onDebateAutoTriggered((msg) => {
      const msgs = document.getElementById('messages');
      if (!msgs) return;
      autoDebateStatusEl = document.createElement('div');
      autoDebateStatusEl.className = 'msg assistant';
      autoDebateStatusEl.innerHTML = '<div class="debate-status-pill">🤖 Auto-watch: ' + escHtml(msg.reason || 'phase changed, checking...') + '</div>';
      msgs.appendChild(autoDebateStatusEl);
      scrollToBottom();
    });
  }
  if (window.api.onDebateAutoStatus) {
    window.api.onDebateAutoStatus((phase) => {
      const pill = autoDebateStatusEl && autoDebateStatusEl.querySelector('.debate-status-pill');
      if (pill) pill.textContent = phase === 'debating' ? '🤖 Auto-watch: Jessi, Analysis & Power of 3 are debating…' : '🤖 Auto-watch: ' + phase;
    });
  }
  if (window.api.onDebateAutoArguments) {
    window.api.onDebateAutoArguments((jessiArg, analysisArg, po3Arg, answeredBy) => {
      answeredBy = answeredBy || {};
      if (autoDebateStatusEl) { autoDebateStatusEl.remove(); autoDebateStatusEl = null; }
      const msgs = document.getElementById('messages');
      if (!msgs) return;
      const argEl = document.createElement('div');
      argEl.className = 'msg assistant';
      let html = '<div class="debate-arguments">' +
        '<div class="debate-arg"><div class="debate-arg-header jessi">Jessi (Discipline)</div>' + escHtml(jessiArg || '').replace(/\n/g, '<br>') + modelBadgeHtml(answeredBy.jessi) + '</div>' +
        '<div class="debate-arg"><div class="debate-arg-header analysis">Analysis (Technical)</div>' + escHtml(analysisArg || '').replace(/\n/g, '<br>') + modelBadgeHtml(answeredBy.analysis) + '</div>';
      if (po3Arg) {
        html += '<div class="debate-arg"><div class="debate-arg-header po3">Power of 3 (AMD)</div>' + escHtml(po3Arg).replace(/\n/g, '<br>') + modelBadgeHtml(answeredBy.po3) + '</div>';
      }
      html += '</div>';
      argEl.innerHTML = html;
      msgs.appendChild(argEl);
      scrollToBottom();

      // New bubble for the judge's streamed verdict, independent of the
      // main chat's state.currentAssistantBubble.
      const msgs2 = document.getElementById('messages');
      const d = document.createElement('div');
      d.className = 'msg assistant';
      autoDebateBubble = document.createElement('div');
      autoDebateBubble.className = 'msg-bubble';
      autoDebateBubble.innerHTML = '<div class="debate-judge-header">🤖⚖ Expert Judge (auto-watch)</div>';
      d.appendChild(autoDebateBubble);
      msgs2.appendChild(d);
      autoDebateBuffer = '';
      scrollToBottom();
    });
  }
  if (window.api.onDebateAutoJudgeToken) {
    window.api.onDebateAutoJudgeToken((t) => {
      if (!autoDebateBubble) return;
      autoDebateBuffer += t;
      autoDebateBubble.innerHTML = '<div class="debate-judge-header">🤖⚖ Expert Judge (auto-watch)</div>' + renderMarkdown(autoDebateBuffer);
      scrollToBottom();
    });
  }
  if (window.api.onDebateAutoJudgeDone) {
    window.api.onDebateAutoJudgeDone((fullText, answeredBy) => {
      if (autoDebateBubble) {
        const text = fullText || autoDebateBuffer;
        autoDebateBubble.innerHTML = '<div class="debate-judge-header">🤖⚖ Expert Judge (auto-watch)</div>' + renderMarkdown(text) + modelBadgeHtml(answeredBy);
        if (isWarningText(text)) autoDebateBubble.classList.add('warning');
        else if (isCautionText(text)) autoDebateBubble.classList.add('caution');
        attachSpeakButton(autoDebateBubble.parentElement, text);
      }
      autoDebateBubble = null; autoDebateBuffer = '';
    });
  }
  if (window.api.onDebateAutoJudgeError) {
    window.api.onDebateAutoJudgeError((message) => {
      if (autoDebateStatusEl) { autoDebateStatusEl.remove(); autoDebateStatusEl = null; }
      addSystemMessage('⚠ Auto-watch debate failed: ' + message);
      autoDebateBubble = null; autoDebateBuffer = '';
    });
  }
  if (window.api.onBiasNote) {
    window.api.onBiasNote(msg => {
      if (msg && msg.text && typeof addSystemMessage === 'function') addSystemMessage(msg.text);
    });
  }

  window.api.onEngulfMonStatus(msg => {
    const tf = (msg && msg.tf) || '1h';
    const running = !!(msg && msg.running);
    if (!state.engulf[tf]) return;
    state.engulf[tf].running = running;
    updateEngulfStatus(tf, running ? 'watching' : 'off');
    const toggle = document.getElementById('engulf-toggle-' + tf);
    if (toggle) toggle.checked = running;
  });

  window.api.onEngulfSignal(signal => handleEngulfSignal(signal));

  window.api.onEngulfCheck(chk => {
    const tf = (chk && chk.tf) || '1h';
    if (!state.engulf[tf]) return;
    const el = document.getElementById('engulf-status-' + tf);
    if (state.engulf[tf].running && !chk.found && el) {
      const t = new Date(chk.time).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
      el.textContent = `Watching — last check ${t} IST`;
    }
  });

  window.api.onFVGMonStatus(msg => {
    const tf = (msg && msg.tf) || '15m';
    const running = !!(msg && msg.running);
    if (!state.fvg[tf]) return;
    state.fvg[tf].running = running;
    updateFVGStatus(tf, running ? 'watching' : 'off');
    const toggle = document.getElementById('fvg-toggle-' + tf);
    if (toggle) toggle.checked = running;
  });

  window.api.onFVGSignal(signal => handleFVGSignal(signal));

  window.api.onFVGCheck(chk => {
    const tf = (chk && chk.tf) || '15m';
    if (!state.fvg[tf]) return;
    const el = document.getElementById('fvg-status-' + tf);
    if (state.fvg[tf].running && !chk.found && el) {
      const t = new Date(chk.time).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
      el.textContent = `Watching — last check ${t} IST`;
    }
  });

  window.api.onSFPMonStatus(msg => {
    const tf = (msg && msg.tf) || '15m';
    const running = !!(msg && msg.running);
    if (!state.sfp[tf]) return;
    state.sfp[tf].running = running;
    updateSFPStatus(tf, running ? 'watching' : 'off');
    const toggle = document.getElementById('sfp-toggle-' + tf);
    if (toggle) toggle.checked = running;
  });

  // A raw sweep is informational (Playbook B step 2 only) — log it in history
  // but don't treat it as the tradeable signal. handlePlaybookBSignal below is
  // the one that fires the popup/notification, since that's steps 2+3 combined.
  window.api.onSFPSignal(signal => handleSFPSweep(signal));

  window.api.onPlaybookBSignal(signal => handlePlaybookBSignal(signal));

  window.api.onSFPCheck(chk => {
    const tf = (chk && chk.tf) || '15m';
    if (!state.sfp[tf]) return;
    state.sfp[tf].pending = !!chk.pending;
    const el = document.getElementById('sfp-status-' + tf);
    if (state.sfp[tf].running && !chk.found && el) {
      const t = new Date(chk.time).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
      el.textContent = chk.pending
        ? `Liquidity raid pending — awaiting displacement (last check ${t} IST)`
        : `Watching — last check ${t} IST`;
    }
  });

  window.api.onLondonLevels(res => {
    if (res && res.ok) {
      const detail = res.lines.map(l => l.label + ' ' + l.price.toFixed(2)).join(' · ');
      updateActionPill(state._londonPill, 'London levels marked', true, detail);
      showAlertBanner(`📍 London levels marked — ${detail}`, 'amber');
    } else {
      updateActionPill(state._londonPill, 'London levels failed', false, res && res.status);
    }
    state._londonPill = null;
  });

  // FIX (2026-07-27): server has broadcast 'ny-levels' since NY marking was
  // built, but nothing on the client ever listened for it — "Mark NY Levels"
  // drew fine server-side but never told Anoop it happened or failed. Found
  // while compacting the London-levels pill.
  window.api.onNyLevels(res => {
    if (res && res.ok) {
      const detail = res.lines.map(l => l.label + ' ' + l.price.toFixed(2)).join(' · ');
      updateActionPill(state._nyPill, 'NY levels marked', true, detail);
      showAlertBanner(`📍 NY levels marked — ${detail}`, 'amber');
    } else {
      updateActionPill(state._nyPill, 'NY levels failed', false, res && res.status);
    }
    state._nyPill = null;
  });

  window.api.onNewsStatus(status => renderNewsPanel(status));
  window.api.onEndDayAutoTrigger(msg => { handleEndDayAutoTrigger(msg && msg.date); });
  window.api.onTradovateTestResult(r => { const st = document.getElementById('settings-tv-status'); if (!st) return; if (r.ok) { st.style.color = 'var(--green)'; st.textContent = '\u2713 Connected (' + r.env + '). Accounts: ' + ((r.accounts||[]).join(', ') || 'none'); } else { st.style.color = 'var(--red)'; st.textContent = '\u2717 ' + (r.error || 'connection failed'); } });

  window.api.onNewsChartMarks(res => {
    const label = res && res.ok ? 'News times marked' : 'News marking failed';
    updateActionPill(state._newsMarkPill, label, !!(res && res.ok), res && res.status);
    state._newsMarkPill = null;
  });

  // ── Mechanical HTF alignment / key level (no LLM, always-on) ───────────────
  // 2026-08-11: a failed read (TV offline / error) used to `return` here, which
  // silently LEFT THE PREVIOUS READ IN PLACE. state.mechanical kept its last
  // dailyTrend/hourTrend forever, so computeMechanicalGoNogo() went on scoring
  // alignment against a chart snapshot from before the disconnect and could
  // still render GO. That is what happened on 2026-08-10. Now a failure marks
  // the read stale and immediately re-runs the verdict, which forces NO-GO.
  window.api.onMechanicalAnalysis(msg => {
    if (!msg || !msg.ok) {
      if (state.mechanical) state.mechanical.failed = (msg && msg.status) || 'read failed';
      computeMechanicalGoNogo();
      return;
    }
    state.mechanical = {
      dailyTrend: msg.dailyTrend, hourTrend: msg.hourTrend, aligned: msg.aligned,
      dailyLabel: msg.dailyLabel, hourLabel: msg.hourLabel,
      dailyScore: msg.dailyScore, hourScore: msg.hourScore,
      dailyDetail: msg.dailyDetail, hourDetail: msg.hourDetail,
      dailyBars: msg.dailyBars, hourBars: msg.hourBars,
      price: msg.price, keyLevel: msg.keyLevel, at: msg.time
    };
    applyMechanicalAnalysis();
    computeMechanicalGoNogo();
  });

  window.api.onSessionAlert(msg => {
    addSystemMessage(`🔔 ${msg.message}`);
    showAlertBanner(msg.message, 'amber');
  });
}

// ── Chat listeners ─────────────────────────────────────────────────────────────
function setupChatListeners() {
  window.api.onChatToken(text => appendToCurrentBubble(text));

  // Individual tool calls (reading chart, switching TF, fetching bars, etc.)
  // run silently now — no per-step chip in the chat. Just count them so a
  // single summary tick can appear once, after the response finishes.
  window.api.onChatToolStart(() => { state.toolCallCount++; });

  window.api.onChatToolDone((name, id, ok, result) => {
    if (!ok) state.toolCallHadError = true;
    parseAnalysisFromToolResult(name, result);
    if (name === 'capture_screenshot' && ok) tryLoadScreenshot(result);
  });

  window.api.onChatDone(fullText => {
    finalizeAssistantBubble(fullText);
    appendFinalToolTick();
    setStreaming(false);
    checkForPatternWarnings(fullText);
    parseGoNogo(fullText);
    scrollToBottom();
  });

  window.api.onChatError(msg => {
    setStreaming(false);
    if (state.currentAssistantBubble) {
      state.currentAssistantBubble.innerHTML = '<em style="color:var(--red)">Error: ' + escHtml(msg) + '</em>';
      state.currentAssistantBubble = null;
    } else {
      addSystemMessage('Error: ' + msg);
    }
    if (msg.includes('API key')) openSettings();
  });

  const csvInput = document.getElementById('csv-file-input');
  if (csvInput) csvInput.addEventListener('change', handleCsvFileSelected);
  const gtInput = document.getElementById('goodtrade-input');
  if (gtInput) gtInput.addEventListener('change', handleGoodTradeShot);
}

// ── CSV analysis (reuses the same chat/tool-use pipeline as the chat box,
//    so it always sees the current rules via buildSystemPrompt() — no
//    separate/duplicate rules logic to keep in sync) ────────────────────────
async function handleCsvFileSelected(ev) {
  const files = Array.from(ev.target.files || []);
  ev.target.value = ''; // allow re-selecting the same files later
  if (!files.length) return;
  if (state.isStreaming) { addSystemMessage('Wait for the current response to finish before analyzing CSVs.'); return; }
  const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result || '')); r.onerror = () => rej(new Error('read failed')); r.readAsText(f); });
  // Sequential so the balance ledger (localStorage) updates cleanly file-by-file;
  // dates are keyed, so overlapping days overwrite instead of double-counting.
  for (const f of files) {
    const isPdf = /\.pdf$/i.test(f.name);
    // 2026-08-17: "Update file" extended beyond CSV/PDF — .xlsx/.xls route
    // through server-side extraction (same pattern as PDF), everything else
    // (.csv, .txt, .tsv, or no/unknown extension) goes through the existing
    // text path, which now also auto-detects comma/tab/semicolon delimiters
    // (see splitCsvLine) instead of assuming comma — so a tab-delimited
    // broker export just works without needing its own branch here.
    const isXlsx = /\.xlsx?$/i.test(f.name);
    try {
      if (isPdf) { await handlePdfFile(f); }
      else if (isXlsx) { await handleXlsxFile(f); }
      else { const text = await readFile(f); csvIngest(f.name, text); }
    }
    catch (e) { addSystemMessage('Could not read ' + f.name + (e && e.message ? ' — ' + e.message : '')); }
  }
  if (files.length > 1) addSystemMessage('Ingested ' + files.length + ' files. Overlapping dates were merged, never double-counted.');
}

// ── PDF upload path (added 2026-07-21) ──────────────────────────────────────
// Extraction happens server-side (pdf-parse, via ws-client's pdfExtract — see
// server.js's 'pdf-extract' handler) to keep this cheap on the renderer side.
// Text-to-trade-row parsing below is a BEST-EFFORT regex match against the
// row shape Tradovate's Performance-report PDF export typically uses (symbol,
// qty, buy price, sell price, PNL, bought timestamp, sold timestamp all on
// one logical row). It has NOT been verified against a real parsed sample —
// pdf-parse can lose column alignment on some PDF generators. So this always
// prints the parsed trade count + total PNL BEFORE trusting the numbers, and
// refuses to touch the ledger at all if it can't find a plausible row shape,
// rather than risk silently feeding garbage into the balance/floor calc.
function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

// Regex tuned to Tradovate's actual "Performance" PDF export TRADES table —
// TESTED 2026-07-21 against the real sample PDF (Performance.20260721.150527.pdf):
// matched 217/217 rows, summed PNL landed exactly on the PDF's own printed
// "Gross P/L $2,304.50" and "# of Trades 217". Real column order is:
//   Symbol  Qty  BuyPrice  BuyTime  Duration  SellTime  SellPrice  P&L
// Two things the first draft of this regex got wrong and were caught by
// testing against the real file rather than shipped on a guess:
//   1. Column order is Buy Time → Duration → Sell Time → Sell Price → P&L,
//      not "two prices then two timestamps" as first assumed.
//   2. Losing trades print as "$(100.00)" — dollar sign BEFORE the paren, not
//      "($100.00)". The first draft's paren-before-$ pattern silently failed
//      to match every losing row, which would have summed to gross PROFIT
//      only ($11,118, the PDF's "Total Profit" line) and made a losing/mixed
//      day look like a big winner. Fixed pattern is \$\(?...\)?.
// Duration ("36sec", "11min 34sec", "3h 10min 35sec") is sometimes entirely
// absent (sub-second fills back-to-back) so it's an optional non-capturing
// group, not counted as one of the row's data fields.
function pdfTextToTradeRows(text) {
  const rowRe = /([A-Z]{2,6}\d{1,2})\s+(\d{1,3})\s+([\d,]+\.\d{1,4})\s+(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2})\s+(?:(?:\d+h\s*)?(?:\d+min\s*)?\d+sec\s+)?(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2})\s+([\d,]+\.\d{1,4})\s+(\$\(?[\d,]+\.\d{2}\)?)/g;
  const rows = [];
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    rows.push({
      symbol: m[1], qty: m[2],
      buyPrice: m[3].replace(/,/g, ''), buyTime: m[4],
      sellTime: m[5], sellPrice: m[6].replace(/,/g, ''),
      pnl: m[7]
    });
  }
  return rows;
}

// The PDF has no fill-ID columns (unlike the raw CSV export), so scaled
// entries/exits would each print as their own row and get double/triple-
// counted as separate "trades" without grouping — the exact bug already
// fixed for CSVs this session, via fill-ID union-find. Rather than write a
// second grouping algorithm blind, this synthesizes a proxy Buy Fill ID so
// the SAME, already-tested csvParseTrades grouping does the consolidation.
// Verified against the real sample: every leg of one scaled entry shares the
// exact same Buy Price + Buy Time character-for-character, even when the
// exit itself fragments into several partial fills at different prices/times
// a few hundred ms apart — so (symbol, buyPrice, buyTime) alone is enough to
// reunite every leg of one round-turn trade.
function tradeRowsToCsv(rows) {
  const header = ['Symbol', 'Qty', 'Buy Price', 'Sell Price', 'PNL', 'Bought Timestamp', 'Sold Timestamp', 'Buy Fill ID', 'Sell Fill ID'];
  const lines = [header.join(',')];
  rows.forEach((r, i) => {
    const buyFillId = r.symbol + '_' + r.buyPrice + '_' + r.buyTime.replace(/[^\d]/g, '');
    const sellFillId = 'leg' + i; // unique per row — grouping happens via the shared buyFillId above
    lines.push([r.symbol, r.qty, r.buyPrice, r.sellPrice, '"' + r.pnl + '"', r.buyTime, r.sellTime, buyFillId, sellFillId].join(','));
  });
  return lines.join('\n');
}

async function handlePdfFile(f) {
  addUserMessage('📄 Extracting ' + f.name + ' (server-side pdf-parse)…');
  const buf = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('read failed')); r.readAsArrayBuffer(f); });
  const base64 = arrayBufferToBase64(buf);
  const text = await window.api.pdfExtract(base64);
  const rows = pdfTextToTradeRows(text);
  if (!rows.length) {
    addSystemMessage('Could not find a recognizable trade-row layout in ' + f.name + '. Tradovate can change this export\'s formatting — export the CSV instead so nothing goes into the ledger on a guess.');
    return;
  }
  const totalPnl = rows.reduce((a, r) => a + parsePnl(r.pnl), 0);
  addSystemMessage('Parsed ' + rows.length + ' fill row(s) from ' + f.name + ', gross PNL $' + totalPnl.toFixed(2) + ' before grouping/commission. Compare this against the PDF\'s own "Gross P/L" line — if they don\'t match, stop and use the CSV export instead.');
  const csvText = tradeRowsToCsv(rows);
  csvIngest(f.name, csvText);
}

// ── Excel upload path (added 2026-08-17) — extends handleCsvFileSelected's
// routing above, same "extract → convert to CSV → reuse csvIngest" pattern
// as handlePdfFile just above. Extraction happens server-side (SheetJS,
// via ws-client's xlsxExtract — see server.js's 'xlsx-extract' handler),
// converting the workbook's FIRST sheet straight to CSV text — no new
// row-parsing logic, the existing (already fuzzy-header-matching)
// csvParseTrades() handles whatever comes back exactly like a real CSV
// upload. Only the first sheet is read; a multi-sheet export with trades on
// a later tab would need a different sheet picked — not handled here, keep
// it simple until that's actually a real case.
async function handleXlsxFile(f) {
  addUserMessage('📊 Extracting ' + f.name + ' (server-side, first sheet)…');
  const buf = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('read failed')); r.readAsArrayBuffer(f); });
  const base64 = arrayBufferToBase64(buf);
  const csvText = await window.api.xlsxExtract(base64);
  if (!csvText || !csvText.trim()) {
    addSystemMessage('Could not extract any data from ' + f.name + ' — the first sheet may be empty, or trades may be on a different sheet.');
    return;
  }
  csvIngest(f.name, csvText);
}

// ── Deterministic CSV discipline scorer (no LLM) ────────────────────────────
// Column names vary across Tradovate CSV export types (Orders vs Fills vs
// Performance tab), so this maps columns fuzzily by header keyword instead
// of assuming exact names, and clearly reports any check it had to skip
// because a needed column wasn't found — never silently guesses at data
// that isn't there. Verified against a real Tradovate "Performance" export
// (headers: symbol, qty, buyPrice, sellPrice, pnl, boughtTimestamp,
// soldTimestamp, duration) on 2026-07-06 — see notes on each fix below.
function splitCsvLine(line, delimiter) {
  // Quote-aware split — Tradovate's own export doesn't quote fields, but a
  // pnl value like "$1,234.00" would otherwise misalign every column after
  // it on a naive comma-split. `delimiter` defaults to comma — every
  // existing CSV caller is unaffected; only parseCsvRows below ever passes
  // something else (2026-08-17, for .txt/.tsv support).
  const d = delimiter || ',';
  const cells = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === d && !inQuotes) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

// 2026-08-17: "Update file" needs to handle plain .txt/.tsv broker exports
// too, which are usually tab- or semicolon-delimited, not comma. Detected
// from the HEADER line only (outside quotes) — whichever of , / \t / ;
// appears most often wins; comma is the default/tiebreak, matching every
// CSV export this already worked against.
function detectDelimiter(headerLine) {
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let inQuotes = false;
  for (let i = 0; i < headerLine.length; i++) {
    const c = headerLine[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && counts[c] !== undefined) counts[c]++;
  }
  let best = ',', bestCount = counts[','];
  for (const d of ['\t', ';']) { if (counts[d] > bestCount) { best = d; bestCount = counts[d]; } }
  return best;
}

function parseCsvRows(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 2) return { headers: [], rows: [] };
  const delimiter = detectDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter);
  const rows = lines.slice(1).map(line => {
    const cells = splitCsvLine(line, delimiter);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
  return { headers, rows };
}

// FIX: try patterns in priority order across ALL headers and return on the
// first pattern that matches anything, rather than scanning headers in file
// order — the original version let "_tickSize" (which contains "Size") win
// over the real "qty" column just because it appeared earlier in the file.
function findColumn(headers, patterns) {
  for (const p of patterns) {
    const hit = headers.find(h => p.test(h));
    if (hit) return hit;
  }
  return null;
}

// FIX: Tradovate's Performance export uses accounting notation for losses —
// "$(50.00)" — not a leading minus. The original check only looked for the
// whole string to START with "(" and missed the "$" prefix, so every losing
// trade silently parsed as NaN and got dropped from the report entirely
// (which made a real -$1,244.50 losing week read as +$8,037.50 compliant).
function parsePnl(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s.length) return NaN;
  const neg = /\(/.test(s);
  s = s.replace(/[$,()]/g, '');
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return neg ? -Math.abs(n) : n;
}

// FIX: parses "MM/DD/YYYY HH:MM:SS" by literal string components instead of
// `new Date(str)` + timezone math. Tradovate exports the account's display
// timezone (IST here) as plain wall-clock digits — going through Date would
// make correctness depend on the browser/OS timezone matching IST exactly,
// which is fragile and impossible to verify from inside this app. sortKey is
// a monotonic integer good for ordering/gap-in-minutes within one export
// (no DST in IST, so plain arithmetic is safe).
function parseTradovateTimestamp(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const mo = +m[1], day = +m[2], yr = +m[3], hh = +m[4], mi = +m[5], ss = +m[6];
  return {
    hour: hh, minute: mi,
    sortKey: (((yr * 400 + mo) * 31 + day) * 24 + hh) * 3600 + mi * 60 + ss,
    dayKey: `${yr}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  };
}

function runCsvDisciplineScorer(filename, csvText) {
  addUserMessage(`📄 Analyzing ${filename} (mechanical scorer, no AI)…`);
  const report = computeCsvDisciplineReport(csvText);
  addSystemMessage(renderCsvDisciplineReport(filename, report));
  scrollToBottom();
}

// Shared fill-pair grouping for the CSV scorer and the live ledger parser
// (csvParseTrades). A single scaled entry/exit produces several round-turn
// rows sharing the same buyFillId/sellFillId — without grouping, each row is
// silently counted as its own trade (this was the core bug: 135 fill rows
// scored as 135 "trades" instead of 56 real ones). Also drops exact-duplicate
// rows (identical buyFillId+sellFillId pair) that appear when overlapping or
// re-exported CSVs get merged — 71 of these were found across Anoop's 6 CSVs.
function groupRowsByFillId(rows, cBid, cSid) {
  const useIds = !!(cBid && cSid);
  if (!useIds) return { groups: rows.map(r => [r]), duplicatesDropped: 0 };

  const seenPairs = new Set();
  let duplicatesDropped = 0;
  const deduped = [];
  for (const r of rows) {
    const key = String(r[cBid]) + '|' + String(r[cSid]);
    if (seenPairs.has(key)) { duplicatesDropped++; continue; }
    seenPairs.add(key);
    deduped.push(r);
  }

  const par = {};
  const find = x => { if (par[x] === undefined) par[x] = x; while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const uni = (a, b) => { par[find(a)] = find(b); };
  deduped.forEach(r => uni('B' + r[cBid], 'S' + r[cSid]));

  const byGroup = {};
  deduped.forEach(r => {
    const k = find('B' + r[cBid]);
    (byGroup[k] = byGroup[k] || []).push(r);
  });

  return { groups: Object.values(byGroup), duplicatesDropped };
}

// Rules come from rules.json on the server (delivered as window.RULES over WS).
// This fallback only applies before the first server message arrives.
const DEFAULT_RULES_FALLBACK = {
  sizeCap: 6,
  tradeLimit: { eval: 2, funded: 20 },
  tradesPerSession: 5,
  tradesPerDay: 10,
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
function getRules() { return window.RULES || DEFAULT_RULES_FALLBACK; }

function computeCsvDisciplineReport(csvText) {
  const RULES = getRules();
  const { headers, rows } = parseCsvRows(csvText);
  if (!rows.length) return { error: 'No data rows found in this CSV.' };

  // FIX: a round-turn row has separate bought/sold timestamps and which one
  // is the entry depends on trade direction (sold-then-bought for a short).
  // The original version always treated "bought" as entry, which silently
  // mis-ordered every short trade.
  const buyTimeCol  = findColumn(headers, [/bought.*time/i, /buy.*time/i, /entry.*time/i]);
  const sellTimeCol = findColumn(headers, [/sold.*time/i, /sell.*time/i, /exit.*time/i]);
  const pnlCol      = findColumn(headers, [/^pnl$/i, /p\W?\/?\W?l/i, /profit/i, /net/i]);
  const symbolCol   = findColumn(headers, [/symbol/i, /contract/i, /instrument/i]);
  const qtyCol      = findColumn(headers, [/^qty$/i, /quantity/i, /contracts/i, /qty/i, /size/i]);
  const bidCol      = findColumn(headers, [/buy.*fill.*id/i]);
  const sidCol      = findColumn(headers, [/sell.*fill.*id/i]);

  const missing = [];
  if (!buyTimeCol && !sellTimeCol) missing.push('trade time/timestamp');
  if (!pnlCol) missing.push('P&L');
  if (!symbolCol) missing.push('symbol/contract');
  if (!bidCol || !sidCol) missing.push('buy/sell fill ID (falling back to 1 row = 1 trade — counts will be wrong if any trade was scaled)');

  // FIX (2026-07-16): group fill-pair rows into real trades by shared
  // buyFillId/sellFillId before scoring anything. Previously every row was
  // scored as its own "trade," which inflated trade counts, corrupted the
  // 20/day check and revenge detection, and skewed avg win/loss.
  const { groups, duplicatesDropped } = groupRowsByFillId(rows, bidCol, sidCol);

  const trades = [];
  for (const grp of groups) {
    let pnl = 0, qty = 0, entry = null, exit = null, symbol = null;
    for (const r of grp) {
      const bt = buyTimeCol ? parseTradovateTimestamp(r[buyTimeCol]) : null;
      const st = sellTimeCol ? parseTradovateTimestamp(r[sellTimeCol]) : null;
      const rowPnl = pnlCol ? parsePnl(r[pnlCol]) : NaN;
      const rowQty = qtyCol ? parseFloat(r[qtyCol]) : 1;
      if (!bt && !st) continue;
      if (isNaN(rowPnl)) continue;
      pnl += rowPnl;
      qty += isNaN(rowQty) ? 1 : rowQty;
      if (!symbol && symbolCol) symbol = r[symbolCol];
      const rowEntry = (bt && st) ? (bt.sortKey <= st.sortKey ? bt : st) : (bt || st);
      const rowExit  = (bt && st) ? (bt.sortKey <= st.sortKey ? st : bt) : (bt || st);
      if (rowEntry && (!entry || rowEntry.sortKey < entry.sortKey)) entry = rowEntry;
      if (rowExit && (!exit || rowExit.sortKey > exit.sortKey)) exit = rowExit;
    }
    if (!entry && !exit) continue;
    if (!entry) entry = exit;
    if (!exit) exit = entry;
    trades.push({ entry, exit, pnl, qty: qty || 1, symbol });
  }
  trades.sort((a, b) => a.entry.sortKey - b.entry.sortKey);

  if (!trades.length) {
    return { error: `Couldn't parse any usable rows. Missing/unrecognized columns: ${missing.join(', ') || 'unknown format'}. Headers found: ${headers.join(', ')}` };
  }

  // Group by calendar day (dayKey is already the literal IST date from the export)
  const byDay = {};
  for (const tr of trades) (byDay[tr.entry.dayKey] = byDay[tr.entry.dayKey] || []).push(tr);

  const fmtTime = (t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
  const checks = [];

  // 1. Trade count vs the per-session / per-day caps (rules.json).
  // CHANGED 2026-07-28 (Anoop): was a flat 20/day count of every row. Now
  // 5/session across London+NY (10/day total), and only trades that closed
  // with |P&L| >= qualifyingTradeMinAbsPnl (default $100) use up a slot —
  // a near-breakeven scratch trade between -$100 and +$100 doesn't count.
  const sessionWins = RULES.sessionWindowsIST || [{ name: 'London', startMin: 810, endMin: 900 }, { name: 'NY', startMin: 1140, endMin: 1260 }];
  const minAbsPnl = RULES.qualifyingTradeMinAbsPnl != null ? RULES.qualifyingTradeMinAbsPnl : 100;
  const sessionLimit = RULES.tradesPerSession || 5;
  const dayLimit = RULES.tradesPerDay || RULES.scorerTradesPerDayLimit || 10;
  const sessionOf = (tr) => {
    const mins = tr.entry.hour * 60 + tr.entry.minute;
    const win = sessionWins.find(w => mins >= w.startMin && mins < w.endMin);
    return win ? win.name : 'Other';
  };
  for (const [day, trs] of Object.entries(byDay)) {
    const qualifying = trs.filter(tr => Math.abs(tr.pnl) >= minAbsPnl);
    if (qualifying.length > dayLimit) {
      checks.push({ ok: false, label: 'Trade count', detail: `${day}: ${qualifying.length} qualifying trades of ${trs.length} total (limit ${dayLimit}/day, |P&L|>=$${minAbsPnl} counts)` });
    }
    const bySession = {};
    qualifying.forEach(tr => { const s = sessionOf(tr); bySession[s] = (bySession[s] || 0) + 1; });
    Object.entries(bySession).forEach(([s, n]) => {
      if (n > sessionLimit) checks.push({ ok: false, label: 'Trade count', detail: `${day}: ${n} qualifying ${s} trades (limit ${sessionLimit}/session)` });
    });
  }

  // 2. Daily loss tiers (rules.json: yellow/red/hard, running P&L within the day)
  const tiers = RULES.dailyLossTiers || { yellow: -100, red: -150, hard: -200 };
  for (const [day, trs] of Object.entries(byDay)) {
    let running = 0, hitY = false, hitR = false, hitH = false;
    for (const tr of trs) {
      running += tr.pnl;
      if (running <= tiers.hard && !hitH) { checks.push({ ok: false, label: 'Daily stop', detail: `${day}: hit $${tiers.hard} HARD STOP at ${fmtTime(tr.entry)} IST (running P&L $${running.toFixed(2)})` }); hitH = true; }
      else if (running <= tiers.red && !hitR) { checks.push({ ok: false, label: 'Daily stop', detail: `${day}: crossed $${tiers.red} RED tier at ${fmtTime(tr.entry)} IST` }); hitR = true; }
      else if (running <= tiers.yellow && !hitY) { checks.push({ ok: false, label: 'Daily stop', detail: `${day}: crossed $${tiers.yellow} YELLOW tier at ${fmtTime(tr.entry)} IST` }); hitY = true; }
    }
  }

  // 3. Session window violations (windows from rules.json, IST minutes)
  const winList = RULES.sessionWindowsIST || [];
  const outsideWindow = trades.filter(tr => {
    const mins = tr.entry.hour * 60 + tr.entry.minute;
    return !winList.some(w => mins >= w.startMin && mins < w.endMin);
  });
  if (outsideWindow.length) {
    checks.push({ ok: false, label: 'Session window', detail: `${outsideWindow.length} trade(s) outside London/NY windows — e.g. ${outsideWindow[0].entry.dayKey} ${fmtTime(outsideWindow[0].entry)} IST` });
  }

  // 4. One-instrument-per-day (strip trailing contract month/year, e.g. MNQU6 → MNQ)
  if (symbolCol) {
    for (const [day, trs] of Object.entries(byDay)) {
      const roots = new Set(trs.filter(t => t.symbol).map(t => String(t.symbol).replace(/[A-Z]\d{1,2}!?$/i, '')));
      if (roots.size > 1) checks.push({ ok: false, label: 'One instrument/day', detail: `${day}: traded ${[...roots].join(' + ')} same day` });
    }
  }

  // 5 & 7. Revenge clusters / 15-min break rule — next entry within 15 min of
  // the PREVIOUS trade's exit (the break is supposed to start once a trade closes).
  const cooldownMin = RULES.cooldownMinutes || 15;
  const quickReentries = [];
  for (let i = 1; i < trades.length; i++) {
    const gapMin = (trades[i].entry.sortKey - trades[i - 1].exit.sortKey) / 60;
    if (gapMin >= 0 && gapMin < cooldownMin) quickReentries.push({ prev: trades[i - 1], gapMin });
  }
  if (quickReentries.length) {
    const afterLoss = quickReentries.filter(q => q.prev.pnl < 0).length;
    checks.push({
      ok: false, label: `${cooldownMin}-min break rule`,
      detail: `${quickReentries.length} re-entr${quickReentries.length === 1 ? 'y' : 'ies'} within ${cooldownMin} min of the prior trade's exit` +
        (afterLoss ? ` (${afterLoss} immediately after a loss — possible revenge pattern)` : '')
    });
  }

  // 9. Per-trade max loss (rules.json) — one oversized loser erases several
  // average winners; this is the single-trade tail-risk check.
  const maxLossCap = RULES.perTradeMaxLoss || 200;
  const bigLosers = trades.filter(t => t.pnl <= -maxLossCap);
  if (bigLosers.length) {
    const worst = bigLosers.reduce((a, b) => (a.pnl < b.pnl ? a : b));
    checks.push({
      ok: false, label: 'Per-trade max loss',
      detail: `${bigLosers.length} trade(s) lost more than $${maxLossCap} — worst $${worst.pnl.toFixed(2)} at ${worst.entry.dayKey} ${fmtTime(worst.entry)} IST`
    });
  }

  // 10. Giveback rule (rules.json) — once the day peaked above armAtProfit,
  // retracing more than retracePct% of that peak means the session should
  // have been locked. (07/09: +$847 peak → −$928 close = $1,775 given back.)
  const gb = RULES.giveback || { armAtProfit: 400, retracePct: 50 };
  for (const [day, trs] of Object.entries(byDay)) {
    let run = 0, peak = 0, violated = false, violAt = null;
    for (const tr of trs) {
      run += tr.pnl;
      if (run > peak) peak = run;
      if (!violated && peak >= gb.armAtProfit && run <= peak * (1 - gb.retracePct / 100)) {
        violated = true; violAt = { time: fmtTime(tr.entry), peak, run };
      }
    }
    if (violated) {
      checks.push({
        ok: false, label: 'Giveback lockout',
        detail: `${day}: peaked +$${violAt.peak.toFixed(0)}, gave back past ${gb.retracePct}% (was $${violAt.run.toFixed(0)} at ${violAt.time} IST) — day should have been locked`
      });
    }
  }

  // 6. R:R inversion — avg win vs avg loss
  const wins = trades.filter(t => t.pnl > 0).map(t => t.pnl);
  const losses = trades.filter(t => t.pnl < 0).map(t => Math.abs(t.pnl));
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  if (wins.length && losses.length && avgLoss > avgWin) {
    checks.push({ ok: false, label: 'R:R inversion', detail: `Avg loss $${avgLoss.toFixed(2)} > avg win $${avgWin.toFixed(2)}` });
  }

  // 8. Net P&L after estimated commission (rules.json, per contract per side ×2)
  const commPerSide = RULES.commissionPerContractPerSide || 0.59;
  const grossPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalContracts = trades.reduce((s, t) => s + (t.qty || 1), 0);
  const estCommission = totalContracts * commPerSide * 2;
  const netPnl = grossPnl - estCommission;

  return {
    tradeCount: trades.length,
    fillRowCount: rows.length,
    duplicatesDropped,
    days: Object.keys(byDay).length,
    grossPnl, estCommission, netPnl,
    avgWin, avgLoss,
    wins: wins.length, losses: losses.length,
    violations: checks,
    missing,
    compliant: checks.length === 0
  };
}

function renderCsvDisciplineReport(filename, r) {
  if (r.error) return `Couldn't score ${filename}: ${r.error}`;
  const verdict = r.violations.length === 0 ? 'COMPLIANT' : r.violations.length <= 2 ? 'PARTIAL VIOLATION' : 'FULL BREAKDOWN';
  const lines = [];
  const fillNote = r.fillRowCount && r.fillRowCount !== r.tradeCount
    ? ` (${r.fillRowCount} fill rows${r.duplicatesDropped ? `, ${r.duplicatesDropped} duplicate dropped` : ''} → ${r.tradeCount} trades)`
    : '';
  lines.push(`Mechanical discipline scorer — ${filename} (${r.tradeCount} trades${fillNote}, ${r.days} day${r.days === 1 ? '' : 's'}, no AI used)`);
  lines.push(`Verdict: ${verdict}`);
  lines.push(`Gross P&L $${r.grossPnl.toFixed(2)} − est. commission $${r.estCommission.toFixed(2)} = Net $${r.netPnl.toFixed(2)}`);
  lines.push(`${r.wins} wins / ${r.losses} losses — avg win $${r.avgWin.toFixed(2)} · avg loss $${r.avgLoss.toFixed(2)}`);
  if (r.violations.length) {
    lines.push('Violations:');
    r.violations.forEach(v => lines.push(`  • [${v.label}] ${v.detail}`));
  } else {
    lines.push('No rule violations detected in the checks this scorer covers.');
  }
  if (r.missing.length) {
    lines.push(`Note: couldn't verify some checks — missing column(s): ${r.missing.join(', ')}.`);
  }
  return lines.join('\n');
}


// ── Mode switching ─────────────────────────────────────────────────────────────
// FIX (2026-07-21): the old switchMode/applyMode pair (flat state.mode only,
// no account-size awareness) is superseded by switchAccount/_renderMode
// defined earlier in this file, right after ACCOUNT_PROFILES. switchMode is
// kept as a thin alias (used by the EVAL/FUNDED toggle buttons in index.html)
// so no HTML changes were needed.

function _renderMode(mode) {
  document.getElementById('mode-eval-btn').classList.toggle('active', mode === 'eval');
  document.getElementById('mode-funded-btn').classList.toggle('active', mode === 'funded');

  const pill = document.getElementById('hdr-mode-pill');
  pill.textContent = mode.toUpperCase();
  pill.className = 'mode-pill ' + mode;

  document.querySelectorAll('.eval-only').forEach(el => el.style.display = mode === 'eval' ? '' : 'none');
  document.querySelectorAll('.funded-only').forEach(el => el.style.display = mode === 'funded' ? '' : 'none');

  // FIX (2026-07-21): title is now account-size-aware instead of hardcoded to
  // the blown $50K — a funded 150K (once it clears) is not "blown."
  {
    const prof = ACCOUNT_PROFILES[state.accountSize] && ACCOUNT_PROFILES[state.accountSize][mode];
    const sizeLabel = ACCOUNT_PROFILES[state.accountSize] ? ACCOUNT_PROFILES[state.accountSize].label : '';
    let statusNote = '';
    if (prof && prof.notOpened) statusNote = ' (not opened yet)';
    else if (prof && prof.blown) statusNote = ' (BLOWN — historical reference only)';
    else if (prof && prof.placeholder) statusNote = ' (terms unconfirmed)';
    document.getElementById('account-section-title').textContent =
      `${sizeLabel} ${mode === 'eval' ? 'Eval' : 'Funded'} Account${statusNote}`;
  }

  const tlabel = document.getElementById('trade-limit-label');
  tlabel.textContent = mode === 'eval' ? '/ 2 per session' : '/ 20 max';

  const rl = document.getElementById('ck-risk-loss-sub');
  if (rl) rl.textContent = mode === 'eval'
    ? "Eval: no firm daily loss limit \u2014 your self-stop is \u2212$300 \u2192 flatten & lock the platform. Know where today's P&L sits."
    : "Funded: \u2212$100 = YELLOW, \u2212$150 = RED (A+ only), \u2212$200 = HARD STOP \u2192 close Tradovate. Know where today's P&L sits.";

  updateSizeDisplay();
  updateAccountUI();
  updateRulesTab();
  computeMechanicalGoNogo();
  updateAccountSizeSelector(mode);
}

// FIX (2026-07-21): keeps the 50K/100K/150K account-size selector in sync —
// which size button is active, and whether the FUNDED tag shows a BLOWN
// warning (only true for 50K right now) vs a "not opened" state (100K).
function updateAccountSizeSelector(mode) {
  document.querySelectorAll('.acct-size-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === state.accountSize);
  });
  const tag = document.getElementById('mode-funded-tag');
  if (!tag) return;
  const fundedProf = ACCOUNT_PROFILES[state.accountSize].funded;
  // 2026-08-12: was `state.accountSize === '50k'` — see ACCOUNT_PROFILES.
  if (mode === 'funded' && fundedProf.blown) {
    tag.textContent = 'BLOWN'; tag.style.display = '';
  } else if (fundedProf.notOpened) {
    tag.textContent = 'N/A'; tag.style.display = '';
  } else {
    tag.style.display = 'none';
  }
}

async function applyConfig(cfg) {
  if (!cfg) return;
  state.hasApiKey = !!cfg.apiKey;

  // FIX (2026-07-21): multi-account architecture. Each Lucid account (by
  // size) moves through Eval -> Funded stages, each a fully separate data
  // bucket (see ACCOUNT_PROFILES / loadAccountBucket above). Remembered
  // account+stage come from cfg; a leftover mode:'funded' under size 150k is
  // corrected to 'eval' once (that account hasn't cleared — see the 2026-07-21
  // breach note in CLAUDE.md). The old flat cfg.balance/evalFloor/etc. fields
  // below are LEGACY pre-migration values, used only as a one-time seed for
  // the 150K eval bucket if it's never been saved under the new system yet —
  // every account/stage after that reads/writes its own isolated bucket.
  let size = ACCOUNT_PROFILES[cfg.accountSize] ? cfg.accountSize : '150k';
  let stage = cfg.mode || 'eval';
  if (size === '150k' && stage === 'funded') stage = 'eval';

  state.accountSize = size; state.mode = stage;
  const hadData = await loadAccountBucket(size, stage);
  if (!hadData && size === '150k' && stage === 'eval') {
    const acc = state.account;
    if (cfg.balance)     acc.balance     = parseFloat(cfg.balance);
    if (cfg.profit !== undefined) acc.profit = parseFloat(cfg.profit);
    if (cfg.evalFloor)    acc.evalFloor    = parseFloat(cfg.evalFloor);
    if (cfg.evalDayCap)   acc.evalDayCap   = parseFloat(cfg.evalDayCap);
    if (cfg.evalDayStop)  acc.evalDayStop  = parseFloat(cfg.evalDayStop);
    if (cfg.evalTarget)   acc.evalTarget   = parseFloat(cfg.evalTarget);
  }

  _renderMode(stage);
  updateAccountUI();
  updateRulesTab();
  // 2026-07-25: run the slot migration (legacy size_stage buckets → 5 slots)
  // BEFORE drawing the gate, so the gate shows slot-keyed state, not stale keys.
  try { await migrateSlotsIfNeeded(); } catch (e) {}
  showAccountGate(size, stage);
}

// ── Engulfing monitors (1H / 30M / 15M) ─────────────────────────────────────────
const ENGULF_MONS = {
  '1h':  { label: '1H',  intervalSec: 60 },
  '30m': { label: '30M', intervalSec: 45 },
  '15m': { label: '15M', intervalSec: 30 }
};

// Roller switcher — added 2026-07-22 alongside the 1H/30M/15M consolidation.
// Only swaps which panel is visible; all three monitors keep running/holding
// state in the background regardless of which one is on screen.
function selectEngulfTF(tf) {
  if (!ENGULF_MONS[tf]) return;
  document.querySelectorAll('.engulf-tf-panel').forEach(panel => {
    panel.style.display = (panel.dataset.tfPanel === tf) ? '' : 'none';
  });
  document.querySelectorAll('.engulf-roller-tab').forEach(tab => {
    tab.classList.toggle('active', tab.id === 'engulf-roller-tab-' + tf);
  });
}

// Keeps the roller pill's status dot in sync with that TF's monitor state,
// even while its panel is hidden behind another selected tab.
function syncEngulfRollerDot(tf, cls) {
  const dot = document.getElementById('engulf-roller-dot-' + tf);
  if (dot) dot.className = 'engulf-roller-dot ' + cls;
}

function toggleEngulfMonitor(tf, enabled) {
  window.api.toggleEngulfMonitor(tf, enabled);
  if (enabled) {
    updateEngulfStatus(tf, 'starting');
    const cfg = ENGULF_MONS[tf] || { label: tf, intervalSec: 60 };
    const el = addActionPill(`${cfg.label} Engulf Monitor`, `Checking every ${cfg.intervalSec}s — popup + browser notification on a detected engulfing candle.`);
    updateActionPill(el, `${cfg.label} Engulf Monitor started`, true, `Checking every ${cfg.intervalSec}s — popup + browser notification on a detected engulfing candle.`);
    requestNotificationPermission();
  }
}

function checkEngulfNow(tf) {
  window.api.checkEngulfNow(tf);
  updateEngulfStatus(tf, 'checking');
  setTimeout(() => {
    if (state.engulf[tf] && state.engulf[tf].running) updateEngulfStatus(tf, 'watching');
  }, 4000);
}

// `bias` ('bull'|'bear'|null) is the last known engulfing direction for this
// TF — passed explicitly on a fresh signal, otherwise falls back to whatever
// was last stored on state.engulf[tf].lastBias so the color persists after
// the 30s "SIGNAL DETECTED" flash reverts back to the watching state, rather
// than losing the directional read every time.
function updateEngulfStatus(tf, status, bias) {
  const el = document.getElementById('engulf-status-' + tf);
  if (!el) return;
  const cfg = ENGULF_MONS[tf] || { intervalSec: 60 };
  const b = bias || (state.engulf[tf] && state.engulf[tf].lastBias) || null;
  const arrow = b === 'bear' ? '▼' : '▲';
  const biasNote = b ? ` · last: ${b === 'bear' ? 'SHORT' : 'LONG'}` : '';
  const map = {
    off:      { text: 'Off — toggle to start watching', cls: 'off' },
    starting: { text: 'Starting…', cls: 'starting' },
    watching: { text: `Watching — checks every ${cfg.intervalSec}s${biasNote}`, cls: b ? (b === 'bear' ? 'bear' : 'bull') : 'watching' },
    checking: { text: 'Checking now…', cls: 'starting' },
    signal:   { text: `SIGNAL DETECTED ${arrow}`, cls: b === 'bear' ? 'signal-bear' : 'signal-bull' }
  };
  const s = map[status] || map.off;
  el.textContent = s.text;
  el.className = 'engulf-status ' + s.cls;
  syncEngulfRollerDot(tf, s.cls);
}

function handleEngulfSignal(signal) {
  const { direction, time, message, source } = signal;
  const tf = signal.tf && state.engulf[signal.tf] ? signal.tf : '1h';
  const label = signal.tfLabel || (ENGULF_MONS[tf] && ENGULF_MONS[tf].label) || tf;
  const isBull = direction === 'BULLISH';
  const bias = isBull ? 'bull' : 'bear';
  if (state.engulf[tf]) { state.engulf[tf].lastBias = bias; state.engulf[tf].lastSignalAt = Date.now(); }

  // Update status
  updateEngulfStatus(tf, 'signal', bias);
  setTimeout(() => updateEngulfStatus(tf, state.engulf[tf].running ? 'watching' : 'off', bias), 30000);

  // Show last signal in analysis panel
  const analysisBlock = document.getElementById('engulf-analysis-block');
  const analysisContent = document.getElementById('engulf-analysis-content');
  analysisBlock.style.display = '';
  analysisContent.innerHTML = `
    <div class="engulf-signal-badge ${isBull ? 'bull' : 'bear'}">
      ${isBull ? '▲' : '▼'} ${direction}
    </div>
    <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">${time} IST · ${label}${source ? ' · ' + source : ''}</div>
    <div style="font-size:11px;color:var(--text-mid);margin-top:4px;">Check a lower TF for entry setup</div>
  `;

  // Show popup
  showEngulfPopup(direction, time, message, isBull, label);

  // Browser notification
  showBrowserNotification(
    `${direction} Engulfing — ${label}`,
    message || `${direction} engulfing candle at ${time} IST on ${label}.`,
    true
  );

  // Alert banner
  showAlertBanner(`${isBull ? '▲' : '▼'} ${direction} ENGULFING ${label} at ${time} IST — check lower TF`, isBull ? 'green' : 'red');

  // Add to that monitor's history
  state.engulf[tf].history.unshift({ direction, time, source });
  renderEngulfHistory(tf);

  // Auto-inject into chat (skip if already streaming to avoid conflict)
  if (!state.isStreaming) {
    const chatMsg = `ENGULF ALERT: ${direction} engulfing candle detected on ${label} at ${time} IST. Based on this signal, what should I do next? Check the chart and walk me through the entry setup.`;
    addSystemMessage(`${direction} Engulf signal on ${label} detected at ${time} IST. Auto-analyzing…`);
    state.messages.push({ role: 'user', content: chatMsg });
    setStreaming(true);
    startNewAssistantBubble();
    window.api.sendChat([buildContextMessage(), ...state.messages])
      .catch(e => { setStreaming(false); addSystemMessage('Analysis error: ' + e.message); });
  } else {
    addSystemMessage(`${direction} Engulf signal on ${label} at ${time} IST — finish current response, then ask for entry analysis.`);
  }
}

function showEngulfPopup(direction, time, message, isBull, label) {
  const popup = document.getElementById('engulf-popup');
  document.getElementById('engulf-popup-icon').textContent = isBull ? '▲' : '▼';
  document.getElementById('engulf-popup-title').textContent = `${direction} ENGULFING — ${label}`;
  document.getElementById('engulf-popup-sub').textContent = `${time} IST · Check lower TF`;
  popup.className = 'engulf-popup visible ' + (isBull ? 'bull' : 'bear');
  clearTimeout(popup._timer);
  popup._timer = setTimeout(closeEngulfPopup, 30000);
}

function closeEngulfPopup() {
  document.getElementById('engulf-popup').className = 'engulf-popup';
}

function renderEngulfHistory(tf) {
  const el = document.getElementById('engulf-history-' + tf);
  if (!el) return;
  const hist = state.engulf[tf].history;
  if (!hist.length) { el.innerHTML = ''; return; }
  el.innerHTML = hist.slice(0, 5).map(s =>
    `<div class="engulf-hist-row">
      <span class="${s.direction === 'BULLISH' ? 'green' : 'red'}">${s.direction === 'BULLISH' ? '▲' : '▼'} ${s.direction}</span>
      <span style="color:var(--text-dim);font-size:10px;">${s.time}</span>
    </div>`
  ).join('');
}

// ── FVG monitor (30M — Playbook B displacement step) ────────────────────────────
// Same architecture as the engulf monitors, one TF for now. Detects the gap
// existing; does NOT confirm the SFP/liquidity-raid that should precede it in
// the full JadeCap 3-step — that part needs swing/liquidity history tracking
// that isn't built yet. Treat a signal here as "a gap exists," not "Playbook B
// setup confirmed" — cross-check the SFP step yourself before acting on it.
// Switched from 15M to 30M on 2026-07-28.
function toggleFVGMonitor(tf, enabled) {
  window.api.toggleFVGMonitor(tf, enabled);
  if (enabled) {
    updateFVGStatus(tf, 'starting');
    (() => { const el = addActionPill('FVG Monitor'); updateActionPill(el, 'FVG Monitor (30M) started', true, 'Checking every 30s for fair value gaps. Confirm the SFP/liquidity-raid step yourself — this only detects the gap, not the full Playbook B setup.'); })();
    requestNotificationPermission();
  }
}

function checkFVGNow(tf) {
  window.api.checkFVGNow(tf);
  updateFVGStatus(tf, 'checking');
  setTimeout(() => {
    if (state.fvg[tf] && state.fvg[tf].running) updateFVGStatus(tf, 'watching');
  }, 4000);
}

function updateFVGStatus(tf, status) {
  const el = document.getElementById('fvg-status-' + tf);
  if (!el) return;
  const map = {
    off:      { text: 'Off — toggle to start watching', cls: 'off' },
    starting: { text: 'Starting…', cls: 'starting' },
    watching: { text: 'Watching — checks every 30s', cls: 'watching' },
    checking: { text: 'Checking now…', cls: 'starting' },
    signal:   { text: 'GAP DETECTED', cls: 'signal' }
  };
  const s = map[status] || map.off;
  el.textContent = s.text;
  el.className = 'engulf-status ' + s.cls;
}

function handleFVGSignal(signal) {
  const { direction, time, message, gapLow, gapHigh } = signal;
  const tf = signal.tf && state.fvg[signal.tf] ? signal.tf : '30m';
  const label = signal.tfLabel || '30M';
  const isBull = direction === 'BULLISH';

  updateFVGStatus(tf, 'signal');
  setTimeout(() => updateFVGStatus(tf, state.fvg[tf].running ? 'watching' : 'off'), 30000);

  showAlertBanner(`${isBull ? '▲' : '▼'} ${direction} FVG ${label} at ${time} IST — gap ${gapLow.toFixed(2)}-${gapHigh.toFixed(2)}`, isBull ? 'green' : 'red');
  showBrowserNotification(`${direction} FVG — ${label}`, message || `${direction} fair value gap at ${time} IST.`, true);

  state.fvg[tf].history.unshift({ direction, time, gapLow, gapHigh });
  renderFVGHistory(tf);

  if (!state.isStreaming) {
    const chatMsg = `FVG ALERT: ${direction} fair value gap detected on ${label} at ${time} IST (${gapLow.toFixed(2)}-${gapHigh.toFixed(2)}). This is the displacement step of Playbook B — help me confirm whether an SFP/liquidity raid preceded it, and what the retrace entry would look like.`;
    addSystemMessage(`${direction} FVG on ${label} detected at ${time} IST. Auto-analyzing…`);
    state.messages.push({ role: 'user', content: chatMsg });
    setStreaming(true);
    startNewAssistantBubble();
    window.api.sendChat([buildContextMessage(), ...state.messages])
      .catch(e => { setStreaming(false); addSystemMessage('Analysis error: ' + e.message); });
  } else {
    addSystemMessage(`${direction} FVG on ${label} at ${time} IST — finish current response, then ask for entry analysis.`);
  }
}

function renderFVGHistory(tf) {
  const el = document.getElementById('fvg-history-' + tf);
  if (!el) return;
  const hist = state.fvg[tf].history;
  if (!hist.length) { el.innerHTML = ''; return; }
  el.innerHTML = hist.slice(0, 5).map(s =>
    `<div class="engulf-hist-row">
      <span class="${s.direction === 'BULLISH' ? 'green' : 'red'}">${s.direction === 'BULLISH' ? '▲' : '▼'} ${s.direction}</span>
      <span style="color:var(--text-dim);font-size:10px;">${s.time}</span>
    </div>`
  ).join('');
}

// ── SFP / Playbook B monitor (30M — closes the gap the FVG monitor disclosed) ──
// Two-stage: a raw sweep (liquidity raid) is logged quietly — it's only steps
// 1-2 of JadeCap, not tradeable on its own. The loud alert (popup + browser
// notification + chat auto-analysis) fires only once the server confirms a
// matching-direction FVG afterward — the full 3-step setup.
// Changed from 15M to 30M on 2026-07-15 — the server now also gates strictly
// on candle CLOSE, not just a faster poll, so this only ever fires once per
// real 30M candle regardless of how often it polls in the background.
function toggleSFPMonitor(tf, enabled) {
  window.api.toggleSFPMonitor(tf, enabled);
  if (enabled) {
    updateSFPStatus(tf, 'starting');
    (() => { const el = addActionPill('Playbook B Monitor'); updateActionPill(el, 'Playbook B Monitor (30M) started', true, 'Watching for a liquidity raid (SFP) on PDH/PDL or recent swing highs/lows, then a confirming displacement FVG — only evaluated on closed 30M candles.'); })();
    requestNotificationPermission();
  }
}

function checkSFPNow(tf) {
  window.api.checkSFPNow(tf);
  updateSFPStatus(tf, 'checking');
  setTimeout(() => {
    if (state.sfp[tf] && state.sfp[tf].running) updateSFPStatus(tf, 'watching');
  }, 4000);
}

function updateSFPStatus(tf, status) {
  const el = document.getElementById('sfp-status-' + tf);
  if (!el) return;
  const map = {
    off:      { text: 'Off — toggle to start watching', cls: 'off' },
    starting: { text: 'Starting…', cls: 'starting' },
    watching: { text: 'Watching — 30M candle close only', cls: 'watching' },
    checking: { text: 'Checking now…', cls: 'starting' },
    pending:  { text: 'Liquidity raid — awaiting displacement…', cls: 'starting' },
    signal:   { text: 'PLAYBOOK B CONFIRMED', cls: 'signal' }
  };
  const s = map[status] || map.off;
  el.textContent = s.text;
  el.className = 'engulf-status ' + s.cls;
}

// Quiet log-only handler for the raw liquidity-raid broadcast (sfp-signal).
// Intentionally does not popup/notify/auto-chat — see comment above.
function handleSFPSweep(signal) {
  const { direction, time, level } = signal;
  const tf = signal.tf && state.sfp[signal.tf] ? signal.tf : '30m';
  const label = signal.tfLabel || '30M';

  updateSFPStatus(tf, 'pending');

  state.sfp[tf].history.unshift({ direction, time, label: `swept ${Number(level).toFixed(2)}`, kind: 'raid' });
  renderSFPHistory(tf);
  const sweptSide = direction === 'BEARISH' ? 'HIGH' : 'LOW';
  const liqSide   = direction === 'BEARISH' ? 'Buy-side' : 'Sell-side';
  const raidBias  = direction === 'BEARISH' ? 'SHORT' : 'LONG';
  addSystemMessage(`${liqSide} liquidity raid on ${label} at ${time} IST — swept the ${Number(level).toFixed(2)} ${sweptSide} → reversal bias ${raidBias}. NOT a trade yet: waiting for a confirming displacement FVG (Playbook B).`);
}

// The real, tradeable Playbook B signal: raid + confirming FVG together.
function handlePlaybookBSignal(signal) {
  const { direction, time, message, sweepLevel, gapLow, gapHigh } = signal;
  const tf = signal.tf && state.sfp[signal.tf] ? signal.tf : '30m';
  const label = signal.tfLabel || '30M';
  const isBull = direction === 'BULLISH';

  updateSFPStatus(tf, 'signal');
  setTimeout(() => updateSFPStatus(tf, state.sfp[tf].running ? 'watching' : 'off'), 30000);

  showEngulfPopup(direction, time, message, isBull, `Playbook B · ${label}`);
  showAlertBanner(`${isBull ? '▲' : '▼'} PLAYBOOK B CONFIRMED (${direction}) ${label} — raid ${Number(sweepLevel).toFixed(2)} + FVG ${Number(gapLow).toFixed(2)}-${Number(gapHigh).toFixed(2)}`, isBull ? 'green' : 'red');
  showBrowserNotification(`PLAYBOOK B CONFIRMED — ${label}`, message || `${direction} liquidity raid + displacement confirmed at ${time} IST.`, true);

  state.sfp[tf].history.unshift({ direction, time, label: `CONFIRMED — gap ${Number(gapLow).toFixed(2)}-${Number(gapHigh).toFixed(2)}`, kind: 'confirm' });
  renderSFPHistory(tf);

  if (!state.isStreaming) {
    const chatMsg = `PLAYBOOK B CONFIRMED: ${direction} liquidity raid at ${Number(sweepLevel).toFixed(2)} followed by a ${direction} displacement FVG (${Number(gapLow).toFixed(2)}-${Number(gapHigh).toFixed(2)}) on ${label} at ${time} IST. Help me plan the retrace entry into the gap with SL beyond the sweep wick, and check this against Daily/1H bias and current trade count before I act.`;
    addSystemMessage(`Playbook B confirmed on ${label} at ${time} IST. Auto-analyzing…`);
    state.messages.push({ role: 'user', content: chatMsg });
    setStreaming(true);
    startNewAssistantBubble();
    window.api.sendChat([buildContextMessage(), ...state.messages])
      .catch(e => { setStreaming(false); addSystemMessage('Analysis error: ' + e.message); });
  } else {
    addSystemMessage(`Playbook B confirmed on ${label} at ${time} IST — finish current response, then ask for entry analysis.`);
  }
}

function renderSFPHistory(tf) {
  const el = document.getElementById('sfp-history-' + tf);
  if (!el) return;
  const hist = state.sfp[tf].history;
  if (!hist.length) { el.innerHTML = ''; return; }
  el.innerHTML = hist.slice(0, 5).map(s =>
    `<div class="engulf-hist-row">
      <span class="${s.kind === 'confirm' ? (s.direction === 'BULLISH' ? 'green' : 'red') : ''}" style="${s.kind === 'raid' ? 'color:var(--amber);' : ''}">
        ${s.kind === 'confirm' ? (s.direction === 'BULLISH' ? '▲' : '▼') : '🎣'} ${s.label}
      </span>
      <span style="color:var(--text-dim);font-size:10px;">${s.time}</span>
    </div>`
  ).join('');
}

// ═══ ALOK — local, no-API trade-history & discipline assistant (2026-07-21) ═══
// Anoop's ask: chat questions about already-ingested trade history ("which
// side were my last 2 entries") were failing because the ONLY chat path was
// window.api.sendChat → claude-agent.js → Anthropic API, which 401s whenever
// the key is missing/invalid. Everything below answers straight from data
// already sitting in localStorage (copilot_day_trades, copilot_gr_history,
// copilot_balance_ledger, copilot_ck_history, copilot_pb_tags,
// copilot_maemfe) — zero network calls, works even with no API key at all.
//
// Named "Alok" per Anoop's request, porting what's actually portable from
// Edgedesk's Alok persona (EdgeDesk.html — that chat was AI-only and is
// PERMANENTLY DISABLED there now, "no calls to any external API are made").
// Two kinds of things lived in that prompt, and only one survives the move
// to a no-API engine honestly:
//   1. Six failure modes (F1-F6) and psychology triggers whose CONDITION is
//      a computable fact — trade count, streak, P&L, giveback, etc. — with a
//      FIXED, pre-written line to say when it fires. That's just conditional
//      logic wearing a name, and it's ported faithfully below in
//      alokPatternCheck(), reading the SAME per-day fields csvApply already
//      computes (revenge, maxConsecLoss, giveback, flips, sizedUpIntoLoss,
//      bigAfterWins) — not a second parallel analysis.
//   2. "Tone matching" / "emotional intelligence" — read how vague or casual
//      his phrasing is, calibrate warmth, infer feelings from free text. That
//      genuinely requires language understanding. A keyword matcher faking
//      that would confidently misread him, which is worse than admitting the
//      limit plainly — so this does NOT attempt it. Open-ended, feelings-based
//      coaching still needs a working API key; Alok says so rather than guess.
// Numbers referenced below are CoPilot's own real, current account rules
// (ACCOUNT_PROFILES / getRules()) — not Edgedesk's separate account's stale
// numbers ($500/day, London+NY-AM windows), which belong to a different
// account entirely and would be wrong here.

function alokDateKeyword(qLower) {
  if (/\byesterday\b/.test(qLower)) {
    // FIX: caught by testing, not just reading — `new Date(str+'T00:00:00')`
    // then `.toISOString()` round-trips through UTC, and on any machine west
    // of UTC (including IST once local midnight is what's typed) that shift
    // silently lands on the day BEFORE yesterday. Using the (year,month,day)
    // constructor + local getters never touches UTC at all, so there's
    // nothing to shift.
    const [y, mo, da] = csvDayKey().split('-').map(Number);
    const d = new Date(y, mo - 1, da - 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  if (/\btoday\b/.test(qLower)) return csvDayKey();
  // "N days ago" — including spelled-out numbers ("two days ago"), via
  // compromise.js (loaded as a local script, no CDN/API call — see
  // index.html). Wrapped in try/catch and gated on typeof so a missing or
  // broken load of the library can never take Alok down with it; digit-only
  // phrasing still works below even if this whole block silently no-ops.
  let daysAgoSrc = qLower;
  if (typeof nlp === 'function') {
    try { const d0 = nlp(qLower); d0.numbers().toNumber(); daysAgoSrc = d0.out('text') || qLower; } catch (e) {}
  }
  let da = daysAgoSrc.match(/\b(\d+)\s+days?\s+ago\b/);
  if (da) {
    const n = parseInt(da[1], 10);
    const [y, mo, dd] = csvDayKey().split('-').map(Number);
    const d = new Date(y, mo - 1, dd - n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  let m = qLower.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = qLower.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (m) {
    const yr = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : String(new Date().getFullYear());
    return yr + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  }
  return null;
}
function alokLastN(qLower) {
  let m = qLower.match(/(?:last|past)\s+(\d+)/) || qLower.match(/(\d+)\s+(?:last|recent|most recent|past)/);
  if (m) return parseInt(m[1], 10);
  // Spelled-out counts ("last five trades", "past ten") — same compromise.js
  // number-word-to-digit conversion as alokDateKeyword above, same
  // defensive gating so a missing library never breaks the digit path.
  if (typeof nlp === 'function') {
    try {
      const d1 = nlp(qLower);
      d1.numbers().toNumber();
      const converted = d1.out('text');
      const m2 = converted.match(/(?:last|past)\s+(\d+)/) || converted.match(/(\d+)\s+(?:last|recent|most recent|past)/);
      if (m2) return parseInt(m2[1], 10);
    } catch (e) {}
  }
  if (/\b(last|latest|most recent|past)\b/.test(qLower)) return 1;
  return null;
}
function alokAllTradesSorted() {
  const dt = pbDayTrades();
  const out = [];
  Object.keys(dt).sort().forEach(d => (dt[d] || []).forEach(t => out.push(Object.assign({ date: d }, t))));
  out.sort((a, b) => a.t - b.t);
  return out;
}
function alokFmtTime(ms) { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function alokFmtTrade(t, i, arr) {
  const tag = (pbTags()[t.date + '|' + t.t]) || null;
  return (arr && arr.length > 1 ? (i + 1) + '. ' : '') + fmtDMY(t.date) + ' ' + alokFmtTime(t.t) + ' — ' + (t.side || '?') + ' ' + t.size + 'c'
    + (t.ep != null ? ' @ ' + t.ep : '') + ', ' + insMoney(t.pnl) + (t.hold ? ', held ' + fmtDur(t.hold) : '') + (tag ? ', playbook ' + tag : '');
}
// One trigger only (per the original prompt's own "never stack" rule),
// picked in rough severity order — reads the SAME fields csvApply already
// computed into copilot_gr_history for that day, no re-analysis.
function alokPatternCheck(dateKey) {
  let hist = []; try { hist = JSON.parse(localStorage.getItem('copilot_gr_history') || '[]'); } catch (e) {}
  const r = hist.filter(h => h.date === dateKey)[0];
  if (!r) return null;
  if (r.tradedPast3Losses) return '[GAMBLERS-FALLACY] Three-plus losses in a row on ' + dateKey + ' and trading continued. Each trade is independent — three losses doesn\'t make the next one more likely to win.';
  if (r.revenge > 0) return '[REVENGE-WINDOW] ' + r.revenge + ' re-entr' + (r.revenge === 1 ? 'y' : 'ies') + ' within 15 min of a loss on ' + dateKey + '. The break is the rule, not a suggestion.';
  if (r.sizedUpIntoLoss) return '[COGNITIVE-NARROWING] Size increased while the day was red on ' + dateKey + '. That\'s "get it back" thinking, not the plan.';
  if (r.giveback > (r.peak || 0) * 0.4 && r.peak > 0) return '[POST-GREEN-RISK / GAVE IT BACK] Peaked at +$' + Math.round(r.peak) + ' on ' + dateKey + ' and gave back $' + Math.round(r.giveback) + '. Lock the win when you have it.';
  if (r.n >= 5) return '[DECISION-FATIGUE] ' + r.n + ' trades on ' + dateKey + '. Are you still sharp, or running on autopilot by the end of that?';
  if (r.avgLoss && r.avgWin && Math.abs(r.avgLoss) > r.avgWin) return '[INVERTED R:R] Avg loss $' + Math.abs(Math.round(r.avgLoss)) + ' > avg win $' + Math.round(r.avgWin) + ' on ' + dateKey + '. Winners must be bigger than losers — that\'s the one metric that matters.';
  if (r.bigAfterWins) return '[WIN-ESCALATION] Your biggest size on ' + dateKey + ' came after 2+ wins in a row. Is that the setup, or the streak talking?';
  if ((r.flips || 0) >= 2) return '[CONFIRMATION-BIAS] ' + r.flips + ' direction flip-flops on ' + dateKey + '. One bias, one direction — a flip this soon after a loss is usually revenge wearing an analysis costume.';
  return null;
}

// ── Alok's knowledge base (2026-07-21) ──────────────────────────────────────
// Anoop asked Alok to also draw on (a) this project's own memory — his
// documented failure modes, playbooks, and coaching commitments — and (b)
// real futures/prop-firm trading-psychology research, gathered via Firecrawl
// and baked in here as static content, "no API needed". This is a SNAPSHOT,
// not a live link: Alok cannot reach the actual Cowork memory files at
// runtime (different machine/process entirely), so this is a one-time export
// of what mattered at build time. If the memory changes significantly later,
// this needs a manual re-export, not an automatic refresh.
// Retrieval below is keyword-overlap scoring against each entry's tags — a
// genuine local search, not synthesis. It can SURFACE the right static
// content for a topic; it cannot compose new advice tailored to phrasing it
// hasn't seen before the way a real reasoning model could. Every entry also
// tries to tie itself to Anoop's OWN current numbers (via alokKbLiveTieIn)
// so this isn't just generic content — it's paired with his actual data
// where the data exists.
const ALOK_KB = [
  {
    id: 'revenge_trading', tags: ['revenge', 'revenge trading', 'get it back', 'win it back', 'tilt'],
    title: 'Revenge trading',
    body: "Revenge trading is taking a trade to relieve the pain of the last loss, not because the setup earned it. It rarely looks emotional from the inside — the next entry still feels like a valid read. The tell is the pattern, not the excuse: size creeps up, the re-entry comes faster than the last one, and the stop gets looser. Your own history has the clearest version of this — one of the blown accounts (from the 6-blown-account review) went from 12 trades on a good day to 65 on its last one, win rate cratered to 20%, and the average loss ($246) was 16x the average win ($15.75). It was up +$937 right before that. The fix that actually holds under stress isn't willpower — it's a rule that doesn't ask permission: 15 minutes off the desk after every trade, win or loss, no exceptions."
  },
  {
    id: 'overtrading', tags: ['overtrad', 'too many trades', 'trade count', 'trading too much'],
    title: 'Overtrading',
    body: "Overtrading is rarely a strategy problem — it's what happens when a trader stops respecting their own limit on how many real setups exist in a session. Boredom, a missed move, or a loss are the usual triggers, and once it starts, activity gets mistaken for edge. Your own data shows the shape of it clearly: every blown account's profitable days ran 6-12 trades; every blow-up day ran into the 60s. The rule that has actually saved accounts isn't a vague \"trade less\" — it's a hard number decided before the session (yours: 5 trades is a caution checkpoint, 20 is a hard stop) so the count itself, not your read of the market in the moment, ends the session."
  },
  {
    id: 'loss_aversion', tags: ['hold loser', 'holding losers', 'cut winner', 'loss aversion', 'let it run', 'giving it room'],
    title: 'Loss aversion — holding losers, cutting winners',
    body: "Loss aversion is why a small win feels worth locking in immediately while a loss feels worth waiting out. In practice that flips your risk/reward upside down: winners get cut early, losers get \"just a bit more room.\" Your Mar 31 MGC data shows this exactly — average losing hold time was 188 minutes, over 3 hours, on a system where a real thesis proves itself in minutes, not hours. The fix isn't discipline in the abstract — it's deciding the exit BEFORE entry (time stop + price stop) and treating any mid-trade urge to widen either one as the loss-aversion signal itself, not new information about the market."
  },
  {
    id: 'position_sizing', tags: ['position siz', 'risk per trade', 'how much should i risk', 'contract size', 'lot size'],
    title: 'Position sizing in prop evaluations',
    body: "Outside research on prop-firm sizing is consistent: experienced eval traders typically risk 0.25%-1% of account balance per trade, specifically because a short losing streak at 2% (4 losses = an 8% drawdown) can burn through a max-loss limit before there's any chance to recover — the eval doesn't care that the strategy is sound over 100 trades if it doesn't survive the next 4. Your own hard cap (2 contracts per entry, no exceptions) exists for the same reason, scaled to your actual account size and MLL rather than a generic percentage. Fixed lot size regardless of stop distance is the most common mistake reported — same contract count on a 10-tick stop and a 40-tick stop is 4x the real risk on the wider one."
  },
  {
    id: 'consistency_rule', tags: ['consistency rule', 'consistency percentage', 'one big day', 'largest day'],
    title: 'Prop-firm consistency rule',
    body: "Most funded-account payouts (including Lucid's LucidFlex, your active $150K eval) require that no single day account for more than 50% of total profit — the firm wants proof the edge is repeatable, not one lucky trade dressed up as a strategy. This matters even on days that otherwise look great: hitting a profit milestone off one outlier trade can look like progress on the balance line while quietly failing the actual payout requirement. Worth checking your own ledger's largest single day against total profit before assuming a green stretch clears you for payout."
  },
  {
    id: 'gamblers_fallacy', tags: ['three losses', 'losing streak', 'gambler', 'due for a win', 'independent'],
    title: "Gambler's fallacy / independent trades",
    body: "Each trade is statistically independent — three losses in a row doesn't make the fourth trade more likely to win, and the market has no memory of your last entry. The dangerous version of this belief isn't usually conscious (\"the next one is due\") — it shows up as continuing to trade past the point where the plan said stop. Your own rule already encodes the correct response: three consecutive losses ends the session, full stop, regardless of how the next setup looks."
  },
  {
    id: 'discipline_framework', tags: ['discipline', 'follow my rules', 'stick to the plan', 'why do i keep breaking'],
    title: 'Why discipline breaks under pressure (and what actually holds)',
    body: "Traders almost never break rules from ignorance — by the time a stop gets widened or an extra trade gets justified, the trader usually already knows the rule they're breaking. The problem is that decision quality degrades under stress faster than willpower can compensate for it. What actually holds isn't a better pep talk before the session — it's reducing how much discretion exists at the exact moment emotion peaks: rules decided in advance (position size, daily stop, cooldown) that don't require a fresh decision mid-session to enforce. This is the whole logic behind grading your PROCESS separately from your P&L: a red day with every rule followed is a clean day; a green day that broke the plan is a failure that got paid, which is the more dangerous outcome long-term."
  },
  {
    id: 'trader_model', tags: ['my model', 'my plan', 'my commitments', 'own commitments', 'kane', 'jadecap', 'my rules', 'my own'],
    title: 'Your own declared model (2026-07-17)',
    body: "Your own words, quoted back: \"I am cheating on my rules and not sticking to my plan... when I am emotional I lose money and when I am not emotional I follow process and make profit.\" The commitments you set for yourself: no oversizing for dopamine, winners must be bigger than losers (the one metric that actually matters), one bias and one direction per day — flipping sides mid-session is revenge wearing an analysis costume, flat size regardless of mood, off the desk 15 minutes after any loss and done for the day after three in a row, and grading process over P&L. These aren't rules I'm imposing — they're your own sober commitments from a clear-headed moment, which is exactly why they're worth citing back to you in one that isn't."
  },
  {
    id: 'playbooks', tags: ['playbook a', 'playbook b', 'playbook c', 'jadecap', 'engulf', 'sfp', 'fvg'],
    title: 'Your three playbooks',
    body: "Playbook A (Engulfing + 4H): mark levels, confirm 4H structure (HH-HL bullish or LL-LH bearish), wait for an engulfing 1H candle close WITH that structure — against it means no action. Playbook B (JadeCap 3-step): daily bias from HTF structure, wait for a liquidity raid (price sweeps a level then closes back inside — the trap), then enter on the displacement/FVG left by the move that follows. Playbook C (engulfing validity): a bullish engulfing only counts at a swing low in an HH-HL pattern and must take out both the high AND low of the prior candle — critically, never take one AFTER buy-side liquidity has already been swept (mirror rule for bearish/sell-side). That last rule is flagged in your own notes as the most common mistake."
  },
  {
    id: 'session_windows', tags: ['session window', 'trading hours', 'when should i trade', 'london session', 'ny session'],
    title: 'Session windows',
    body: "Two windows: London (1:30-3:00 PM IST) is prep/small-size only — reviewing the prior NY session and building context, not a full second main session. NY (7:00-9:00 PM IST) is the primary session with full rules. No trades outside either window — a full day-6-blown-account review found several blow-ups involved trades hours outside any defined window, in a mental state that never got the pre-session check."
  },
  {
    id: 'one_instrument', tags: ['multi instrument', 'mnq and mgc', 'switch instrument', 'trade both'],
    title: 'One instrument per day',
    body: "Every documented blow-up shows both MNQ and MGC being traded the same day — losing on one and then opening the other isn't diversification, it's doubling exposure while already emotionally compromised. The rule is one instrument per day, not per session, specifically because the failure pattern was \"lost on MNQ, switched to MGC\" within the same day, not across different sessions."
  },
  {
    id: 'blown_accounts', tags: ['blown account', 'previous accounts', 'why did i blow', 'history of blow'],
    title: 'The 6 blown $50K accounts — what actually killed them',
    body: "All 6 died to the max-loss limit, not a consistency breach or a single catastrophic trade. Average survival: 4.7 trading days. Every account's own worst day was preceded by a period of being UP — account 6 built +$937 before giving it all back plus $1,700 more. The core mechanism, in order: a loss triggers a re-entry to recover it, that re-entry loses bigger, the bigger loss triggers switching instruments or sizing up, and that repeats until the max-loss limit is hit. None of these were bad-strategy failures — the same accounts had 55-83% win rates on their good days. They were entirely failures in the response to a loss, not the setup quality."
  },
  {
    id: 'kane_po3_session', tags: ['po3', 'power of three', 'premium discount', 'accumulation manipulation distribution', 'kane po3', '9:30', '10am open'],
    title: 'Trader Kane\'s PO3 / multi-timeframe framework for NQ',
    body: "From Trader Kane's Chart Fanatics interview (paraphrased, not quoted verbatim): he frames NQ price action as Power of Three — accumulation, manipulation, distribution — and insists the three timeframes have to actually line up before he'll act: Daily sets the range, H4 confirms it, H1 is where the entry gets triggered, and he explicitly won't act until \"all of those timeframes align.\" His session-time read on NQ: the 9:30 open brings a volatile liquidity injection, and by 10:00am price statistically tends to reverse back toward the prior session's range — he treats that as a repeatable behavior, not a coincidence. His entry zone is a premium/discount split of the recent range (roughly the 50% mark) — he only cares about price trading into that zone, not about predicting the whole move. Once a liquidity sweep confirms his direction, he moves his stop to breakeven immediately \"so that even so I'm not losing any money due to fees\" rather than waiting for a bigger profit cushion first. This lines up closely with your own Playbook B (SFP → displacement/FVG) and the Daily→1H→scalp alignment rule already in your checklist — Kane's version just names the specific NQ session-time window (9:30/10:00) and the immediate-breakeven-after-sweep habit, which your own notes didn't have spelled out before."
  },
  {
    id: 'kane_patience', tags: ['patience', 'wait for the model', 'base hit', 'small win', 'okay being wrong', 'trader kane patience'],
    title: 'Trader Kane on patience and the "base hit" mentality',
    body: "From the same interview: Kane says the single biggest thing he sees traders lack — including people who assume shorter-term trading needs less patience than swing trading — is patience: \"95% of people... open the chart as soon as they wake up.\" His own target per setup is deliberately small — he calls it needing to \"grab that base hit every single day and then I'm done, I move on\" — rather than chasing a bigger move once he's already got what the setup was for. He's explicit about being comfortable being wrong: \"if I'm wrong, I'm wrong, that's okay, I really tried to instill into everybody that all I need to do is wait for price\" to reach his zone, not force an entry before it does. That's the same discipline your own Core Rule #12 already states (no trade before the market shows its hand) and your trader-model file's \"grade process not P&L\" — Kane's framing adds the base-hit language: the goal is one clean, defined win per day, not maximizing every session."
  }
];
// Score by tag-substring overlap — plain local search, not semantic.
function alokKbSearch(ql) {
  let best = null, bestScore = 0;
  ALOK_KB.forEach(entry => {
    const score = entry.tags.reduce((a, t) => a + (ql.indexOf(t) >= 0 ? t.length : 0), 0);
    if (score > bestScore) { bestScore = score; best = entry; }
  });
  return bestScore > 0 ? best : null;
}
// Grounds the static KB entry in Anoop's OWN latest numbers where computable —
// the "trading analyses" half of "expert coach in psychology and trading
// analyses", not just a canned paragraph.
function alokKbLiveTieIn(id) {
  let hist = []; try { hist = JSON.parse(localStorage.getItem('copilot_gr_history') || '[]'); } catch (e) {}
  const last = hist[hist.length - 1];
  if (!last) return '';
  if (id === 'revenge_trading' && last.revenge) return '\n\nYour data: ' + last.revenge + ' revenge re-entr' + (last.revenge === 1 ? 'y' : 'ies') + ' flagged on ' + fmtDMY(last.date) + '.';
  if (id === 'overtrading' && last.n >= 5) return '\n\nYour data: ' + last.n + ' trades on ' + fmtDMY(last.date) + (last.n >= 20 ? ' — past the hard stop.' : ' — past the caution checkpoint.');
  if (id === 'loss_aversion' && last.avgWin && last.avgLoss && Math.abs(last.avgLoss) > last.avgWin) return '\n\nYour data: avg loss $' + Math.abs(Math.round(last.avgLoss)) + ' > avg win $' + Math.round(last.avgWin) + ' on ' + fmtDMY(last.date) + ' — inverted right now.';
  if (id === 'gamblers_fallacy' && last.tradedPast3Losses) return '\n\nYour data: you traded past 3 consecutive losses on ' + fmtDMY(last.date) + '.';
  if (id === 'position_sizing' && last.maxSize > 2) return '\n\nYour data: max size ' + last.maxSize + 'c on ' + fmtDMY(last.date) + ' — over your own 2-contract cap.';
  return '';
}

// ── Conversational memory (2026-07-21, ported concept from Edgedesk's
// updateCoachMemory — NOT its code, which is just a localStorage write
// feeding an AI-API call. This is a same-idea, zero-API reimplementation:
// a rolling local log of exchanges so Alok can be asked what was already
// discussed, capped so it doesn't grow unbounded. ──────────────────────────
function alokMemoryLog() {
  let m = []; try { m = JSON.parse(localStorage.getItem('copilot_alok_memory') || '[]'); } catch (e) {}
  return m;
}
function alokMemorySave(q, a) {
  try {
    const m = alokMemoryLog();
    m.push({ t: Date.now(), q: q, a: a });
    while (m.length > 40) m.shift();
    localStorage.setItem('copilot_alok_memory', JSON.stringify(m));
  } catch (e) {}
}

// Daily debrief — same DESIGN INTENT as Edgedesk's autoDebrief (an
// end-of-day wrap-up), but computed deterministically from local data
// instead of being handed to an LLM. Edgedesk's actual autoDebrief just
// calls the disabled sendToAlok stub now, so there's no working code there
// to port — this is a genuine local rebuild of the idea.
function alokDailyDebrief(dateKey) {
  let hist = []; try { hist = JSON.parse(localStorage.getItem('copilot_gr_history') || '[]'); } catch (e) {}
  const r = hist.filter(h => h.date === dateKey)[0];
  const dayTrades = (pbDayTrades()[dateKey] || []);
  if (!r && !dayTrades.length) return 'No data logged for ' + dateKey + ' — nothing to debrief.';
  const n = dayTrades.length || (r ? r.n : 0);
  const pnl = dayTrades.length ? dayTrades.reduce((a, t) => a + t.pnl, 0) : (r ? r.pnl : 0);
  const wins = dayTrades.filter(t => t.pnl > 0).length;
  const wr = dayTrades.length ? Math.round(wins / dayTrades.length * 100) : null;
  let ckh = []; try { ckh = JSON.parse(localStorage.getItem('copilot_ck_history') || '[]'); } catch (e) {}
  const ck = ckh.filter(x => x.date === dateKey)[0];
  const pattern = alokPatternCheck(dateKey);
  const lines = [];
  lines.push(dateKey + ': ' + n + ' trade' + (n === 1 ? '' : 's') + ', net ' + insMoney(pnl) + (wr != null ? ', ' + wr + '% win rate' : '') + '.');
  lines.push('Checklist: ' + (ck ? ('done, tier ' + ck.tier) : 'no record — looks skipped.'));
  lines.push(pattern ? ('Flag: ' + pattern) : 'No named discipline pattern flagged — clean by the local checks.');
  return lines.join('\n');
}

// Weekly report — same DESIGN INTENT as Edgedesk's weeklyAlokReport (also
// dead code there — it hands a 7-day summary to the same disabled
// sendToAlok stub). Rebuilt here as a deterministic trend summary over the
// last 7 logged days in copilot_gr_history.
function alokWeeklyReport() {
  let hist = []; try { hist = JSON.parse(localStorage.getItem('copilot_gr_history') || '[]'); } catch (e) {}
  if (!hist.length) return 'No session history logged yet — nothing to summarize for the week.';
  const days = hist.slice(-7);
  const totalTrades = days.reduce((a, d) => a + (d.n || 0), 0);
  const totalPnl = days.reduce((a, d) => a + (d.pnl || 0), 0);
  const best = days.reduce((b, d) => (d.pnl || 0) > (b.pnl || 0) ? d : b, days[0]);
  const worst = days.reduce((w, d) => (d.pnl || 0) < (w.pnl || 0) ? d : w, days[0]);
  const flagged = days.filter(d => alokPatternCheck(d.date)).length;
  const lines = [];
  lines.push('Last ' + days.length + ' logged day' + (days.length === 1 ? '' : 's') + ' (' + fmtDMY(days[0].date) + ' to ' + fmtDMY(days[days.length - 1].date) + '): ' + totalTrades + ' trades, net ' + insMoney(totalPnl) + '.');
  lines.push('Best day: ' + fmtDMY(best.date) + ' (' + insMoney(best.pnl || 0) + '). Worst day: ' + fmtDMY(worst.date) + ' (' + insMoney(worst.pnl || 0) + ').');
  lines.push(flagged + ' of ' + days.length + ' day' + (days.length === 1 ? '' : 's') + ' had a discipline pattern flagged.');
  return lines.join('\n');
}

// Renamed to alokAnswerCore — the real logic. alokAnswer (below, after this
// function) wraps it to log every exchange into the conversational memory.
// Always returns a string — never falls through to the AI pipeline, per
// Anoop's explicit call: unmatched/open-ended questions get told plainly
// that Alok is a local data assistant, not silently routed to an API that
// may not even have a valid key right now.
function alokAnswerCore(raw) {
  const q = raw.trim();
  const ql = q.toLowerCase();

  // FIX (caught from Anoop's real screenshot, 2026-07-21): "hello"/"hellooo"
  // typed alone — no "alok" in it — fell all the way through to the final
  // catch-all. The old rule only recognized a greeting if paired with the
  // word "alok". Bare greetings (with repeated letters, "hellooo" etc.) are
  // now their own match, checked first.
  if (/^(hi+|hey+|hello+|hiya|yo+|sup)\b[\s!.,]*$|^(hi|hey|hello)\b.*(alok|jessi|livermore)|^(alok|jessi|livermore)\b[,:]?\s*$|what can you (do|help)|who are you/.test(ql)) {
    return "Jessi Livermore here — no API calls, everything local. I answer questions about your ingested trade history (side, size, entry/exit time, P&L, hold time, checklist, playbook tags, MAE/MFE), known discipline patterns (revenge, size escalation, giveback, inverted R:R), daily debriefs and weekly reports, and I've got your trading psychology and playbook knowledge baked in too — revenge trading, overtrading, loss aversion, position sizing, your own 6-blown-account history, and Playbooks A/B/C. Ask about \"today\", \"yesterday\", a date, \"my last N trades\", \"debrief today\", \"weekly report\", or a topic like \"why do I revenge trade\". I don't do open-ended coaching — that still needs a working API key in Settings.";
  }

  // Small talk — Alok's own conversational range, not a factual query.
  // Keeps the in-character coach voice (per ALOK_KB tone) rather than a
  // generic chatbot reply.
  if (/^(thanks|thank you|thx|ty|cheers)\b/.test(ql)) {
    return "Anytime. Back to the plan when you're ready.";
  }
  if (/^(ok|okay|k|kk|cool|got it|good|nice|sounds good|alright|fine)[\.\!]?$/.test(ql)) {
    return "Noted.";
  }
  if (/^(bye|goodbye|see ya|later|good ?night|gn)\b/.test(ql)) {
    return "Session's over when the rules say it's over, not when the mood says so. See you at the next check-in.";
  }
  if (/^how are you\b/.test(ql)) {
    return "Running fine — I'm the part of this desk that doesn't get emotional. Better question: how are YOU, going into a session?";
  }

  // Conversation recap — reads the persistent exchange log (see
  // alokMemoryLog above), not state.messages, so it survives app restarts.
  if (/what (have we|did we) (talk|discuss)|conversation history|recap (our|the) chat|what did i ask/.test(ql)) {
    const m = alokMemoryLog();
    if (!m.length) return "Nothing logged yet — this is the first thing you've asked me.";
    const recent = m.slice(-5);
    return "Last " + recent.length + " exchange" + (recent.length === 1 ? '' : 's') + ":\n" + recent.map(e => 'Q: ' + e.q + '\nA: ' + e.a.split('\n')[0]).join('\n\n');
  }

  // Daily debrief / weekly report — checked before the trade-data gate below
  // since both functions handle "no data yet" gracefully on their own.
  if (/\bdebrief\b|how (did|was) (i|my day)|end of day\b|\beod\b|wrap up (today|the day)/.test(ql)) {
    const dk = alokDateKeyword(ql) || csvDayKey();
    return alokDailyDebrief(dk);
  }
  if (/weekly report|how (was|is) my week|this week|past week|last 7 days/.test(ql)) {
    return alokWeeklyReport();
  }

  const all = alokAllTradesSorted();
  if (!all.length) return "No trade data ingested yet — upload a report in Update File first, then ask me about it.";

  const dateKey = alokDateKeyword(ql);
  const n = alokLastN(ql);
  let scope = all;
  if (dateKey) scope = all.filter(t => t.date === dateKey);
  if (n) scope = scope.slice(-n);
  const scopeLabel = dateKey ? ('on ' + fmtDMY(dateKey)) : (n ? ('in your last ' + n) : 'across everything uploaded');

  // Explicit "trade history / list trades / last N trades / read my trades"
  // intent — list the actual trades from day_trades (the same per-trade data
  // Insights uses). Placed BEFORE the date-abort below so a stray/implicit
  // date parse (e.g. defaulting to today, which has no trades) can't swallow
  // a plain "show my last 10 trades" request. Uses `all` (every trade), not
  // the possibly date-scoped `scope`, so it always returns real history.
  // (2026-07-23: added after "read the last 10 trades" returned "no trades
  //  for today" instead of the last 10 across all dates.)
  if (/\b(trade history|history of (my )?trades|list (my )?trades|show (me )?(my )?trades|read .*\btrades?\b|recent trades|my trades|last \d+ trades?)\b/.test(ql)) {
    const list = dateKey && all.some(t => t.date === dateKey)
      ? all.filter(t => t.date === dateKey)
      : all.slice(-(n || 10));
    if (!list.length) return 'No trades ingested yet — upload a Performance report in Update File first.';
    return 'Last ' + list.length + ' trade' + (list.length === 1 ? '' : 's') + ':\n' + list.map(alokFmtTrade).join('\n');
  }

  if (dateKey && !all.some(t => t.date === dateKey)) return 'No trades on file for ' + fmtDMY(dateKey) + '. Dates with data: ' + Array.from(new Set(all.map(t => t.date))).slice(-10).map(fmtDMY).join(', ') + '.';

  // Concept questions ("why do I hold losers", "tell me about playbook b")
  // get checked against the knowledge base FIRST — caught by testing that
  // words like "hold" or "playbook" also match the factual data patterns
  // further down (hold TIME, playbook TAGS), which were winning and
  // answering the wrong question entirely. A "why/what is/tell me about"
  // question is conceptual; only fall through to factual matching if the KB
  // genuinely has nothing for it.
  if (/^why\b|^what is\b|^what are\b|tell me about|explain|how do i (stop|avoid)|help me understand/.test(ql)) {
    const kbEarly = alokKbSearch(ql);
    if (kbEarly) return kbEarly.title + ' — ' + kbEarly.body + alokKbLiveTieIn(kbEarly.id);
  }

  // Pattern / psychology check
  // NARROWED (caught by testing): this used to also match bare "revenge"/
  // "tilt", which collided with the KB topic entries below — "why do I keep
  // revenge trading" was firing today's live GAMBLERS-FALLACY check instead
  // of actually answering the revenge-trading question. Live status-check
  // phrasing only now; concept questions route to the KB search instead.
  if (/\bpatterns?\b|\bdisciplin\w* check\b|how.*(am i|was i) doing|any (red )?flags/.test(ql)) {
    const dk = dateKey || all[all.length - 1].date;
    const hit = alokPatternCheck(dk);
    return hit ? hit : ('No named pattern flagged for ' + dk + ' — clean by the discipline checks I can run locally.');
  }

  // Checklist status
  if (/\bchecklist\b/.test(ql)) {
    const dk = dateKey || csvDayKey();
    let ckh = []; try { ckh = JSON.parse(localStorage.getItem('copilot_ck_history') || '[]'); } catch (e) {}
    const e = ckh.filter(x => x.date === dk)[0];
    return e ? ('Checklist ' + dk + ': done, tier ' + e.tier + (e.score != null ? ', score ' + e.score : '') + '.') : ('No checklist record for ' + dk + ' — looks skipped.');
  }

  // Playbook tag distribution / lookup
  if (/\b(playbook|tag(ged)?)\b/.test(ql)) {
    const tags = pbTags();
    if (scope.length === 1) {
      const t = scope[0], tag = tags[t.date + '|' + t.t];
      return tag ? ('Tagged playbook ' + tag + ': ' + alokFmtTrade(t)) : ('That trade isn\'t tagged yet — tag it in Insights.');
    }
    const counts = {};
    scope.forEach(t => { const tg = tags[t.date + '|' + t.t]; if (tg) counts[tg] = (counts[tg] || 0) + 1; });
    const keys = Object.keys(counts);
    return keys.length ? ('Playbook tags ' + scopeLabel + ': ' + keys.map(k => k + '×' + counts[k]).join(', ') + '.') : ('No tagged trades ' + scopeLabel + '.');
  }

  // MAE/MFE
  if (/\b(mae|mfe|heat|captured|drawdown on the trade)\b/.test(ql)) {
    const store = mmStore();
    const rows = scope.map(t => store[t.date + '|' + t.t]).filter(Boolean);
    if (!rows.length) return 'No MAE/MFE computed ' + scopeLabel + ' yet — run it from the Insights tab with the MNQ 1m chart open first.';
    const avgMae = Math.round(rows.reduce((a, r) => a + r.mae, 0) / rows.length);
    const avgMfe = Math.round(rows.reduce((a, r) => a + r.mfe, 0) / rows.length);
    return 'MAE/MFE ' + scopeLabel + ' (' + rows.length + ' trade' + (rows.length === 1 ? '' : 's') + '): avg heat sat through $' + avgMae + ', avg move available $' + avgMfe + '.';
  }

  // Side / direction
  if (/\b(side|long or short|buy or sell|bought or sold|direction)\b/.test(ql)) {
    if (!scope.length) return 'No trades found ' + scopeLabel + '.';
    return scope.map(alokFmtTrade).join('\n');
  }

  // Best / worst
  if (/\b(best|worst|biggest (win|loss|winner|loser))\b/.test(ql)) {
    if (!scope.length) return 'No trades found ' + scopeLabel + '.';
    const wantWorst = /\b(worst|loss|loser)\b/.test(ql);
    const pick = scope.reduce((b, t) => (wantWorst ? t.pnl < b.pnl : t.pnl > b.pnl) ? t : b, scope[0]);
    return (wantWorst ? 'Worst trade ' : 'Best trade ') + scopeLabel + ': ' + alokFmtTrade(pick);
  }

  // Count / how many
  if (/\bhow many\b.*(trade|entr)/.test(ql) || /\btrade count\b/.test(ql)) {
    return scope.length + ' trade' + (scope.length === 1 ? '' : 's') + ' ' + scopeLabel + '.';
  }

  // Win rate
  if (/\bwin rate|winning percentage\b/.test(ql)) {
    if (!scope.length) return 'No trades found ' + scopeLabel + '.';
    const wins = scope.filter(t => t.pnl > 0).length;
    return Math.round(wins / scope.length * 100) + '% (' + wins + '/' + scope.length + ') ' + scopeLabel + '.';
  }

  // P&L / profit / loss
  if (/\bp ?& ?n? ?l\b|\bpnl\b|\bprofit\b|\bloss\b|\bnet\b|how much (did i (make|lose))/.test(ql)) {
    if (!scope.length) return 'No trades found ' + scopeLabel + '.';
    const pnl = scope.reduce((a, t) => a + t.pnl, 0);
    return 'Net ' + scopeLabel + ': ' + insMoney(pnl) + ' (' + scope.length + ' trade' + (scope.length === 1 ? '' : 's') + ').';
  }

  // Size / contracts
  if (/\b(size|contracts|how many (lots|contracts|micros))\b/.test(ql)) {
    if (!scope.length) return 'No trades found ' + scopeLabel + '.';
    if (scope.length === 1) return alokFmtTrade(scope[0]);
    return scope.map(alokFmtTrade).join('\n');
  }

  // Hold time / duration
  if (/\b(hold|duration|how long)\b/.test(ql)) {
    if (!scope.length) return 'No trades found ' + scopeLabel + '.';
    const avg = scope.reduce((a, t) => a + (t.hold || 0), 0) / scope.length;
    return 'Avg hold ' + scopeLabel + ': ' + fmtDur(avg) + ' (' + scope.length + ' trade' + (scope.length === 1 ? '' : 's') + ').';
  }

  // Entry price
  if (/\b(entry price|what price|entered at)\b/.test(ql)) {
    if (!scope.length) return 'No trades found ' + scopeLabel + '.';
    return scope.map(alokFmtTrade).join('\n');
  }

  // Generic listing fallback — ANY "last N" or date reference that didn't
  // match a specific attribute above. FIX: this used to require the literal
  // word "show"/"list"/"what were" to also be present, so "last 10 trades
  // history" (real phrasing Anoop typed, no "show"/"list" in it) fell all
  // the way through to the final catch-all instead of listing anything.
  // Requesting a date or a "last N" IS the request — no extra keyword needed.
  if (n || dateKey) {
    return scope.length ? scope.map(alokFmtTrade).join('\n') : ('No trades found ' + scopeLabel + '.');
  }

  // Knowledge base — psychology/trading-analysis topics (memory + Firecrawl
  // research, baked in locally). Tried before the final catch-all so a
  // question like "why do I keep revenge trading" gets real content instead
  // of "I don't have an answer for that".
  const kb = alokKbSearch(ql);
  if (kb) return kb.title + ' — ' + kb.body + alokKbLiveTieIn(kb.id);

  return "I don't have a local answer for that — I can tell you about your ingested trade history (side, size, P&L, hold time), checklist, playbook tags, MAE/MFE, known discipline patterns, daily debriefs, weekly reports, and your own trading psychology/playbook knowledge base. Open-ended coaching needs a working API key (Settings) — this is a data-only assistant, not a substitute for that.";
}

// Public entry point — wraps alokAnswerCore and logs every exchange into the
// persistent conversation memory (copilot_alok_memory) before returning, so
// "what have we talked about" has something real to read back.
function alokAnswer(raw) {
  const reply = alokAnswerCore(raw);
  alokMemorySave(raw, reply);
  return reply;
}

// ── Chat ───────────────────────────────────────────────────────────────────────
function addAlokMessage(text) {
  const msgs = document.getElementById('messages');
  const d = document.createElement('div');
  d.className = 'msg assistant';
  d.innerHTML = '<div class="msg-bubble"><b style="opacity:.7">Jessi Livermore · </b>' + escHtml(text).replace(/\n/g, '<br>') + '</div>';
  msgs.appendChild(d);
  attachSpeakButton(d, text);
  scrollToBottom();
}
// ── 3-Agent Debate Mode toggle ────────────────────────────────────────────
function toggleDebateMode() {
  state.debateMode = !state.debateMode;
  const btn = document.getElementById('debate-mode-btn');
  if (btn) btn.classList.toggle('active', state.debateMode);
  // Scalper and Debate are mutually exclusive routes in sendMessage() — turning
  // one on must visibly turn the other off, or the UI implies both are active
  // while only the Scalper (checked first) actually runs.
  if (state.debateMode && state.scalperAgent) {
    state.scalperAgent = false;
    const sb = document.getElementById('scalper-agent-btn');
    if (sb) sb.classList.remove('active');
  }
}

// ── The Scalper agent toggle (2026-08-01) ─────────────────────────────────
function toggleScalperAgent() {
  state.scalperAgent = !state.scalperAgent;
  const btn = document.getElementById('scalper-agent-btn');
  if (btn) btn.classList.toggle('active', state.scalperAgent);
  if (state.scalperAgent && state.debateMode) {
    state.debateMode = false;
    const db = document.getElementById('debate-mode-btn');
    if (db) db.classList.remove('active');
  }
  addSystemMessage(state.scalperAgent
    ? '⚡ The Scalper is on — scalping specialist. It reads your per-day scalp stats and its own notes, grades size/hold/re-entry separately from your levels, and keeps notes across sessions.'
    : 'The Scalper is off — back to the normal chat.');
}

// ── Debate-mode send: Jessi + Analysis → Expert Judge ─────────────────────
async function sendDebateMessage(text) {
  const cfg = await window.api.getConfig();
  if (!cfg || (!cfg.geminiApiKey && !cfg.groqApiKey)) {
    addSystemMessage('⚠ Debate mode requires an API key (Gemini or Groq). Set one in Settings.');
    setStreaming(false);
    return;
  }

  // Phase 1: status pill while gathering data
  // FIX (2026-07-28): was getElementById('chat-messages') — WRONG ID. The
  // real container is 'messages' (see addUserMessage/startNewAssistantBubble).
  // getElementById returned null, .appendChild() threw, and because this runs
  // BEFORE the try block below while isStreaming is already true, the chat
  // locked permanently with the red stop icon. Class was wrong too
  // ('msg-row assistant' vs the real 'msg assistant').
  const msgs = document.getElementById('messages');
  if (!msgs) { setStreaming(false); return; } // never leave the chat locked
  const statusEl = document.createElement('div');
  statusEl.className = 'msg assistant';
  statusEl.innerHTML = '<div class="debate-status-pill">⚖ Gathering data for debate…</div>';
  msgs.appendChild(statusEl);
  scrollToBottom();

  const offStatus = window.api.onDebateStatus((phase) => {
    const pill = statusEl.querySelector('.debate-status-pill');
    if (pill) pill.textContent = phase === 'debating' ? '⚖ Jessi, Analysis & Power of 3 are debating…' : '⚖ ' + phase;
  });

  // Phase 2: side-by-side arguments
  let argEl = null;
  const offArgs = window.api.onDebateArguments((jessiArg, analysisArg, po3Arg, answeredBy) => {
    answeredBy = answeredBy || {};
    statusEl.remove(); // remove status pill
    argEl = document.createElement('div');
    argEl.className = 'msg assistant';
    // Three debaters as of 2026-07-28 — Power of 3 joined as a full participant.
    let html = '<div class="debate-arguments">' +
      '<div class="debate-arg"><div class="debate-arg-header jessi">Jessi (Discipline)</div>' + escHtml(jessiArg || '').replace(/\n/g, '<br>') + modelBadgeHtml(answeredBy.jessi) + '</div>' +
      '<div class="debate-arg"><div class="debate-arg-header analysis">Analysis (Technical)</div>' + escHtml(analysisArg || '').replace(/\n/g, '<br>') + modelBadgeHtml(answeredBy.analysis) + '</div>';
    if (po3Arg) {
      html += '<div class="debate-arg"><div class="debate-arg-header po3">Power of 3 (AMD)</div>' + escHtml(po3Arg).replace(/\n/g, '<br>') + modelBadgeHtml(answeredBy.po3) + '</div>';
    }
    html += '</div>';
    argEl.innerHTML = html;
    msgs.appendChild(argEl);
    scrollToBottom();
  });

  // Phase 3: streamed judge verdict
  startNewAssistantBubble();
  // Prepend judge header
  if (state.currentAssistantBubble) {
    state.currentAssistantBubble.innerHTML = '<div class="debate-judge-header">⚖ Expert Judge</div>';
  }
  const offToken = window.api.onDebateJudgeToken((t) => { appendToCurrentBubble(t); });

  try {
    const { text: fullText, answeredBy } = await window.api.sendDebateChat(state.messages.slice(-20));
    finalizeAssistantBubble(fullText, '<div class="debate-judge-header">⚖ Expert Judge</div>', answeredBy);
  } catch (e) {
    if (state.currentAssistantBubble) {
      state.currentAssistantBubble.parentElement.remove();
      state.currentAssistantBubble = null;
      state.streamBuffer = '';
    }
    statusEl.remove();
    addSystemMessage('⚠ Debate failed: ' + e.message);
  } finally {
    offStatus();
    offArgs();
    offToken();
    setStreaming(false);
  }
}

// Toggle the mechanical AMD phase monitor (server-side, 60s, no AI per poll).
function togglePo3Monitor() {
  const btn = document.getElementById('po3-monitor-btn');
  const turningOn = !(btn && btn.classList.contains('active'));
  window.api.togglePo3Monitor(turningOn);
  // The server echoes po3-monitor-status, which sets the button's real state —
  // this is just immediate feedback so the click doesn't feel dead.
  if (btn) btn.textContent = turningOn ? '◱ P3 Monitor…' : '◱ P3 Monitor';
}

// ── ICT Power of 3 (AMD phase read) ───────────────────────────────────────
// Judges Accumulation / Manipulation / Distribution from live multi-TF data,
// weighting 15m and 5m most (Anoop's instruction, from his ICT PDF).
async function runIctPo3(question) {
  if (state.isStreaming) { addSystemMessage('Wait for the current response to finish, then run Power of 3.'); return; }

  const cfg = await window.api.getConfig();
  if (!cfg || (!cfg.geminiApiKey && !cfg.groqApiKey)) {
    addSystemMessage('⚠ Power of 3 needs an API key (Gemini or Groq). Set one in Settings.');
    return;
  }

  const msgs = document.getElementById('messages');
  if (!msgs) return;

  setStreaming(true);
  const statusEl = document.createElement('div');
  statusEl.className = 'msg assistant';
  statusEl.innerHTML = '<div class="debate-status-pill">◱ Power of 3 — reading 1H / 15m / 5m…</div>';
  msgs.appendChild(statusEl);
  scrollToBottom();

  const offStatus = window.api.onPo3Status((phase) => {
    const pill = statusEl.querySelector('.debate-status-pill');
    if (pill) pill.textContent = phase === 'analyzing' ? '◱ Judging AMD phase…' : '◱ Reading D / 1H / 15m / 5m…';
  });

  startNewAssistantBubble();
  const HDR = '<div class="debate-judge-header" style="color:#a78bfa">◱ ICT Power of 3 — AMD Phase</div>';
  if (state.currentAssistantBubble) state.currentAssistantBubble.innerHTML = HDR;
  const offToken = window.api.onPo3Token((t) => appendToCurrentBubble(t));

  try {
    const { text: fullText, answeredBy } = await window.api.sendIctPo3(question || '');
    statusEl.remove();
    finalizeAssistantBubble(fullText, HDR, answeredBy);
  } catch (e) {
    statusEl.remove();
    if (state.currentAssistantBubble) {
      state.currentAssistantBubble.parentElement.remove();
      state.currentAssistantBubble = null;
      state.streamBuffer = '';
    }
    addSystemMessage('⚠ Power of 3 failed: ' + (e && e.message ? e.message : e));
  } finally {
    offStatus();
    offToken();
    setStreaming(false);
  }
}

// ── Post-Session Analyst ──────────────────────────────────────────────────
// 2026-08-12: NO LONGER auto-fires after CSV ingest. Runs on request only —
// via the chat trigger ("post session review"), End Day & Save, or
// window.runPostSessionReview(). See rules.json autoPostSessionReview.
async function runPostSessionReview(retriesLeft) {
  // FIX (2026-07-28): was an unbounded self-reschedule — if something upstream
  // stayed stuck (e.g. the debate/debrief hang this was found alongside),
  // this would poll every 3s forever in the background. Capped at ~2 minutes
  // (40 retries) then gives up silently rather than polling indefinitely.
  if (retriesLeft === undefined) retriesLeft = 40;
  if (state.isStreaming) {
    if (retriesLeft <= 0) { console.warn('[Post-Session Analyst] gave up waiting for stream to free up'); return; }
    setTimeout(() => runPostSessionReview(retriesLeft - 1), 3000);
    return;
  }

  const cfg = await window.api.getConfig();
  if (!cfg || (!cfg.geminiApiKey && !cfg.groqApiKey)) return; // silent skip if no key

  setStreaming(true);
  // FIX (2026-07-28): same wrong-id bug as sendDebateMessage — 'chat-messages'
  // does not exist; the real container is 'messages'.
  const msgs = document.getElementById('messages');

  // Status pill
  const statusEl = document.createElement('div');
  statusEl.className = 'msg assistant';
  statusEl.innerHTML = '<div class="debate-status-pill">📋 Post-Session Analyst gathering data…</div>';
  msgs.appendChild(statusEl);
  scrollToBottom();

  const offStatus = window.api.onPostReviewStatus((phase) => {
    const pill = statusEl.querySelector('.debate-status-pill');
    if (pill) pill.textContent = phase === 'analyzing' ? '📋 Analyzing session…' : '📋 ' + phase;
  });

  // Streamed review
  startNewAssistantBubble();
  if (state.currentAssistantBubble) {
    state.currentAssistantBubble.innerHTML = '<div class="debate-judge-header" style="color:var(--green,#22c55e)">📋 Post-Session Review</div>';
  }
  const offToken = window.api.onPostReviewToken((t) => { appendToCurrentBubble(t); });

  try {
    const { text: fullText, answeredBy } = await window.api.sendPostSessionReview();
    statusEl.remove();
    finalizeAssistantBubble(fullText, '<div class="debate-judge-header" style="color:var(--green,#22c55e)">📋 Post-Session Review</div>', answeredBy);
  } catch (e) {
    statusEl.remove();
    if (state.currentAssistantBubble) {
      state.currentAssistantBubble.parentElement.remove();
      state.currentAssistantBubble = null;
      state.streamBuffer = '';
    }
    addSystemMessage('⚠ Post-session review failed: ' + e.message);
  } finally {
    offStatus();
    offToken();
    setStreaming(false);
  }
}

// Jessi now answers via Groq (free, streamed) when a key is configured —
// this REPLACES the 2026-07-21 "local only, never falls through" design.
// alokAnswerCore() (the local rule-based data lookups) is kept as the offline
// fallback: no Groq key set, or the Groq call errors (network down, rate
// limited, etc), so Jessi never goes silent just because the API hiccups.
// presetText: optional — used by the post-ingest auto-debrief to send a
// programmatic message through the exact same pipeline as a typed one. The
// typeof check matters: DOM event handlers pass a MouseEvent as the first arg.
async function sendMessage(presetText) {
  const input = document.getElementById('chat-input');
  const preset = (typeof presetText === 'string' && presetText.trim()) ? presetText.trim() : null;
  const text = preset || input.value.trim();
  if (!text || state.isStreaming) return;

  if (!preset) { input.value = ''; autoResize(input); }

  addUserMessage(text);
  state.messages.push({ role: 'user', content: text });

  // ── On-demand full Post-Session report (2026-08-12) ─────────────────────
  // It no longer auto-fires on CSV upload (see csvApply / rules.json
  // autoPostSessionReview). This is how you ask for it when you actually want
  // the detail — checked FIRST so it can't be swallowed by the Scalper/Debate/
  // Alok ladder below. Matched loosely because the point is that it's easy to
  // reach, not that it's typed exactly.
  if (/^\s*(run\s+)?(the\s+)?post[\s-]?session(\s+(review|report|analysis))?\s*$/i.test(text)) {
    try { runPostSessionReview(); }
    catch (e) { addSystemMessage('Could not start the post-session report: ' + e.message); }
    return;
  }

  // The Scalper (2026-08-01) — scalping specialist. Checked BEFORE debate mode
  // because it's the more specific intent: when Anoop turns the Scalper on he
  // wants the scalping expert, not a 3-way debate about the same question.
  if (state.scalperAgent) {
    setStreaming(true);
    startNewAssistantBubble();
    let gotTok = false;
    let scalperAnsweredBy = null;
    const offTok = window.api.onScalperToken((t) => { gotTok = true; appendToCurrentBubble(t); });
    const offTs = window.api.onScalperToolStart((name) => { state.toolCallCount++; console.debug('[Scalper tool]', name); });
    const offTd = window.api.onScalperToolDone((name) => { console.debug('[Scalper tool done]', name); });
    try {
      // BUGFIX 2026-08-01: the screenshot-attach path (~line 6762) pushes
      // content as an Anthropic-style block array (type:'image'), which
      // Groq's schema rejects outright (only text/image_url/document
      // allowed) — a 400 that only surfaced once the fallback chain reached
      // Groq. Flatten any non-string content to its text parts before
      // sending, and cap history the same way Jessi does (slice(-20)) so
      // this is safe across every provider in the chain, not just Gemini.
      const safeMessages = state.messages.slice(-20).map(m => {
        if (typeof m.content === 'string') return m;
        if (Array.isArray(m.content)) {
          const text = m.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n').trim();
          return { role: m.role, content: text || '[attachment omitted for this agent]' };
        }
        return { role: m.role, content: String(m.content || '') };
      });
      const { text: reply, answeredBy } = await window.api.sendScalperChat(safeMessages);
      scalperAnsweredBy = answeredBy;
      if (!gotTok && reply) appendToCurrentBubble(reply);
    } catch (e) {
      addSystemMessage('⚠ Scalper failed: ' + (e && e.message ? e.message : e));
    } finally {
      offTok && offTok(); offTs && offTs(); offTd && offTd();
      finalizeAssistantBubble(undefined, null, scalperAnsweredBy);
      setStreaming(false);
    }
    return;
  }

  // 3-Agent Debate mode — route to the debate pipeline instead of Jessi solo
  if (state.debateMode) {
    setStreaming(true);
    // try/finally so the chat unlocks even if sendDebateMessage throws before
    // reaching its own error handling. The resilience layer would catch this
    // too, but failing safe here means zero visible interruption.
    try { await sendDebateMessage(text); }
    catch (e) { addSystemMessage('⚠ Debate failed: ' + (e && e.message ? e.message : e)); }
    finally { setStreaming(false); }
    return;
  }

  // 2026-07-25: was `!cfg.groqApiKey` only. Once Gemini became Jessi's primary
  // brain, a Gemini-only setup would have been wrongly forced into the offline
  // local answer path despite having a working key. Either key is enough now —
  // the server picks the provider and handles cross-vendor fallback itself.
  const cfg = await window.api.getConfig();
  if (!cfg || (!cfg.geminiApiKey && !cfg.groqApiKey)) {
    const alokReply = alokAnswer(text);
    state.messages.push({ role: 'assistant', content: alokReply });
    addAlokMessage(alokReply);
    return;
  }

  setStreaming(true);
  startNewAssistantBubble();
  let gotAnyToken = false;
  const offToken = window.api.onJessiChatToken((t) => { gotAnyToken = true; appendToCurrentBubble(t); });
  // FIX (2026-07-27): these all used to post visible chat bubbles ("Jessi →
  // app_get_data…", "⚠ Gemini/gemini-3.5-flash unavailable…") — Anoop was
  // explicit that model routing and tool-call mechanics should be invisible,
  // same silent-with-one-summary-tick pattern the main co-pilot chat already
  // uses (see onChatToolStart/onChatToolDone/appendFinalToolTick above).
  // Console only from here; the single collapsed tick still shows via
  // appendFinalToolTick() in finalizeAssistantBubble() below.
  const offToolStart = window.api.onJessiChatToolStart((name) => { state.toolCallCount++; console.debug('[Jessi tool]', name); });
  const offToolDone = window.api.onJessiChatToolDone((name, id, ok) => { if (!ok) { state.toolCallHadError = true; console.debug('[Jessi tool failed]', name); } });
  // 2026-07-23: fires when the 8B model hits its daily limit mid-turn and
  // groq-agent.js auto-retries on gpt-oss-20b. 2026-07-25: per-minute 429s no
  // longer reach this handler (the agent waits + retries the same model
  // instead) — what's left is genuine unavailability. 2026-07-27: kept as a
  // console log only, never a chat bubble — model routing is Jessi's business,
  // not something that should interrupt the conversation on screen.
  const offFallback = window.api.onJessiChatFallback((from, to) => console.debug('[Jessi model fallback]', from, '->', to));
  // 2026-07-23: proactive warning BEFORE a 413/429 actually happens (Groq's
  // live rate-limit headers). 2026-07-27: console only, same reasoning as above.
  const offQuotaWarn = window.api.onJessiChatQuotaWarn((message) => console.debug('[Jessi quota]', message));
  // 2026-08-16 (Pattern 02, assistive routing — chat-intent.js): the ONE
  // system-message case in this whole listener block that's meant to be
  // visible, not console-only — it's a direct suggestion for Anoop to act on
  // ("switch to Scalper mode?"), not internal model-routing mechanics.
  const offModeHint = window.api.onJessiChatModeHint((message) => addSystemMessage('💡 ' + message));
  try {
    const { text: fullText, answeredBy } = await window.api.sendJessiChat(state.messages.slice(-20));
    finalizeAssistantBubble(fullText, null, answeredBy);
    appendFinalToolTick(); // single "Analysis complete ✓" tick, same as main chat — replaces the removed per-tool bubbles
  } catch (e) {
    // Groq failed mid-flight — remove the empty streaming bubble (if nothing
    // arrived) and fall back to the local, data-only answer instead of
    // leaving Jessi silent.
    if (!gotAnyToken && state.currentAssistantBubble) {
      state.currentAssistantBubble.parentElement.remove();
      state.currentAssistantBubble = null;
      state.streamBuffer = '';
    } else if (state.currentAssistantBubble) {
      finalizeAssistantBubble(state.streamBuffer);
    }
    // FIX (2026-07-23, "why isn't jessi texting normally" — hello/hi/etc
    // returning the canned "no trades on file for today" reply every time):
    // this used to append the error note directly onto `text` before handing
    // it to alokAnswerCore(). That defeats every one of its anchored regexes
    // (the greeting check is `^...$`), so ANY message fell through all the
    // way to the generic date-scoped trade lookup, which defaults to today
    // and returns the same "no trades" line no matter what was actually
    // typed. Keep the diagnostic note as its own system message instead, and
    // pass the user's real text through untouched so local matching works.
    addSystemMessage('⚠ Jessi\'s live brain is unavailable right now (' + e.message + ') — answering from local data instead.');
    const alokReply = alokAnswer(text);
    state.messages.push({ role: 'assistant', content: alokReply });
    addAlokMessage(alokReply);
  } finally {
    offToken();
    offToolStart();
    offToolDone();
    offFallback();
    offQuotaWarn();
    offModeHint();
    setStreaming(false);
  }
}

// ── Trade journal quick-add (Insights tab) ──────────────────────────────────────
async function journalSubmit() {
  const input = document.getElementById('journal-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await window.api.journalAdd(text);
    addSystemMessage('Journaled: "' + text + '" — Jessi will have this next time you talk.');
  } catch (e) {
    addSystemMessage('Could not save journal entry: ' + e.message);
  }
}

function cancelStreaming() {
  window.api.cancelChat();
  window.api.cancelJessiChat();
  // FIX (2026-07-28): this only knew about the two original chat pipelines.
  // Debate mode and the Post-Session Analyst each track their own reqId and
  // never got cancelled by the stop button — if either hung server-side (see
  // the try/catch fix in handleDebateChat/handlePostSessionReview), clicking
  // stop looked like it did nothing because isStreaming would just get set
  // back to true by leftover state, or the stuck status pill would linger.
  if (typeof window.api.cancelDebateChat === 'function') window.api.cancelDebateChat();
  if (window.api.onPostReviewDone) { /* no cancel WS message yet — resolve locally so UI unlocks */ }
  setStreaming(false);
  if (state.currentAssistantBubble) {
    state.currentAssistantBubble.innerHTML += '<br><em style="color:var(--text-dim);font-size:11px;">[cancelled]</em>';
    state.currentAssistantBubble = null;
  }
  state.streamBuffer = '';
  // Clean up any stray debate/post-review status pills left in the DOM.
  document.querySelectorAll('.debate-status-pill').forEach(el => {
    const row = el.closest('.msg');
    if (row) row.remove();
  });
}

// ── Voice mode: voice in, voice out ─────────────────────────────────────────
// Added 2026-07-23. Talks to the SAME Jessi brain as text chat (state.messages
// is shared) — this is purely an alternate I/O layer: mic → Whisper → Jessi →
// Orpheus → speakers, looping automatically until the user backs out.
// Silence detection (Web Audio amplitude) auto-stops the recording 3-4s after
// Anoop stops talking, per his spec, rather than requiring push-to-talk.
const voiceState = {
  active: false,
  phase: 'idle',       // idle | listening | thinking | speaking
  stream: null,
  audioCtx: null,
  analyser: null,
  recorder: null,
  chunks: [],
  silenceTimer: null,
  silenceCheckRaf: null,
  everSpoke: false,
  clipQueue: [],
  watchdogTimer: null,
  recognition: null, utterance: null, gotResult: false,
  offTranscript: null, offAudio: null, offError: null,
  offToolStart: null, offToolDone: null
};

const VOICE_SILENCE_MS = 3500;      // 3-4s pause = "done talking", per spec
const VOICE_AMPLITUDE_THRESHOLD = 0.02; // rough speech/silence cutoff, 0-1 scale
const VOICE_WATCHDOG_MS = 45000;    // 45s: local Ollama's FIRST call after idle
// has to load the model into RAM (can take 10-30s cold), so the backstop must
// be generous enough not to false-trip on that warm-up. Groq is far faster;
// this just needs to cover the slowest legit case. Belt-and-suspenders: even
// if the backend
// hangs somewhere I haven't fixed yet, the UI itself can never get stuck
// forever again — 2026-07-23, added after the "stuck on Sending to Jesse…"
// live bug (root cause was missing timeouts server-side; this is the
// client-side backstop in case a *new* hang shows up somewhere else later).

function armVoiceWatchdog() {
  clearVoiceWatchdog();
  voiceState.watchdogTimer = setTimeout(() => {
    window.api.cancelJessiVoice(); // drop the stale reqId so a late reply is ignored
    setVoicePhase('idle', 'Timed out — tap to try again', 'No response from Jesse within 25s.');
  }, VOICE_WATCHDOG_MS);
}
function clearVoiceWatchdog() {
  if (voiceState.watchdogTimer) { clearTimeout(voiceState.watchdogTimer); voiceState.watchdogTimer = null; }
}

function setVoicePhase(phase, statusText, caption) {
  voiceState.phase = phase;
  const orb = document.getElementById('voice-orb');
  const status = document.getElementById('voice-status');
  const cap = document.getElementById('voice-caption');
  const startBtn = document.getElementById('voice-start-btn');
  if (orb) orb.className = 'voice-orb ' + (phase === 'idle' ? 'voice-idle' : 'voice-' + phase);
  if (status) status.textContent = statusText || '';
  if (cap && caption !== undefined) cap.textContent = caption;
  if (startBtn) startBtn.style.display = (phase === 'idle') ? '' : 'none';
}

// ── Voice pause (2026-07-23, Anoop: "pause Voice for now and use only chat
// ... not just 3 hours, until i turn it on") — keeps the whole shared Groq
// budget (8B + gpt-oss-20b fallback) free for text chat until manually
// resumed. Indefinite, not timed: no expiry, persists in localStorage across
// refreshes/restarts, and only clears when Voice is explicitly re-enabled.
const VOICE_PAUSE_KEY = 'copilot_voice_paused';
function initVoicePause() {
  try { if (localStorage.getItem(VOICE_PAUSE_KEY) === null) localStorage.setItem(VOICE_PAUSE_KEY, '1'); } catch (e) {}
}
function voiceIsPaused() { try { return localStorage.getItem(VOICE_PAUSE_KEY) === '1'; } catch (e) { return false; } }
function voiceSetPaused(paused) { try { localStorage.setItem(VOICE_PAUSE_KEY, paused ? '1' : '0'); } catch (e) {} updateVoicePauseUI(); }
function updateVoicePauseUI() {
  const btn = document.getElementById('voice-mode-btn');
  if (!btn) return;
  if (voiceIsPaused()) {
    btn.style.opacity = '0.45';
    btn.title = 'Voice paused — keeping the full chat quota free. Click to turn it back on.';
  } else {
    btn.style.opacity = '';
    btn.title = 'Talk to Jesse — voice in, voice out';
  }
}

function toggleVoiceMode() {
  if (voiceIsPaused()) {
    if (!confirm('Voice is paused to keep the full Groq chat quota free for text chat. Turn it back on now?')) return;
    voiceSetPaused(false);
  }
  const overlay = document.getElementById('voice-overlay');
  const messages = document.getElementById('messages');
  const inputArea = document.getElementById('input-area');
  const typing = document.getElementById('typing');
  const btn = document.getElementById('voice-mode-btn');
  if (!overlay) return;

  if (!voiceState.active) {
    voiceState.active = true;
    overlay.style.display = 'flex';
    if (messages) messages.style.display = 'none';
    if (inputArea) inputArea.style.display = 'none';
    if (typing) typing.style.display = 'none';
    if (btn) btn.classList.add('active');
    // Warm up the TTS voice list (getVoices() is async-populated in Chrome).
    try { if (window.speechSynthesis) window.speechSynthesis.getVoices(); } catch (e) {}
    setVoicePhase('idle', 'Tap to start talking to Jesse', '');
    wireVoiceListeners();
  } else {
    voiceStopEverything();
    voiceState.active = false;
    overlay.style.display = 'none';
    if (messages) messages.style.display = '';
    if (inputArea) inputArea.style.display = '';
    if (btn) btn.classList.remove('active');
    unwireVoiceListeners();
  }
}

function wireVoiceListeners() {
  if (voiceState.offTranscript) return; // already wired
  voiceState.offTranscript = window.api.onJessiVoiceTranscript((text) => {
    state.messages.push({ role: 'user', content: text });
    setVoicePhase('thinking', 'Jesse is thinking…', 'You: ' + text);
    armVoiceWatchdog(); // reset the clock — now waiting on the reply+TTS leg
  });
  voiceState.offToolStart = window.api.onJessiVoiceToolStart((name) => {
    setVoicePhase('thinking', 'Jesse → ' + name + '…', document.getElementById('voice-caption').textContent);
  });
  voiceState.offToolDone = window.api.onJessiVoiceToolDone(() => {});
  // 2026-07-23: same 8B→gpt-oss-20b auto-retry as text chat. Caption-only
  // (not a chat bubble) since voice mode's "conversation" is the caption
  // strip, not the message list.
  voiceState.offFallback = window.api.onJessiVoiceFallback((from, to) => {
    setVoicePhase('thinking', 'Switched brains (' + from + ' limit hit)…', document.getElementById('voice-caption').textContent);
  });
  // 2026-08-03: was addSystemMessage (a visible chat bubble) — inconsistent
  // with text-chat's onJessiChatQuotaWarn, which is deliberately console-only
  // (2026-07-27: "model routing is Jessi's business, not something that
  // should interrupt the conversation on screen"). Matched to that stated
  // philosophy: caption-only, like offFallback just above.
  voiceState.offQuotaWarn = window.api.onJessiVoiceQuotaWarn((message) => {
    setVoicePhase('thinking', '⏳ Running low — ' + message, document.getElementById('voice-caption').textContent);
  });
  voiceState.offAudio = window.api.onJessiVoiceAudio((fullText, clips, mime, answeredBy) => {
    clearVoiceWatchdog();
    state.messages.push({ role: 'assistant', content: fullText });
    const brainNote = answeredBy && answeredBy.label ? ' (' + answeredBy.label + ')' : '';
    setVoicePhase('speaking', 'Jesse is speaking…' + brainNote, 'Jesse: ' + fullText);
    // Clips present → server-synthesized audio (Edge TTS mp3, or legacy Groq
    // wav — mime says which). No clips → browser speechSynthesis fallback.
    if (clips && clips.length) voicePlayClips(clips, mime);
    else voiceSpeak(fullText);
  });
  voiceState.offError = window.api.onJessiVoiceError((message) => {
    clearVoiceWatchdog();
    setVoicePhase('idle', 'Error — tap to try again', message || 'Something went wrong.');
  });
}

function unwireVoiceListeners() {
  [voiceState.offTranscript, voiceState.offToolStart, voiceState.offToolDone, voiceState.offFallback, voiceState.offQuotaWarn, voiceState.offAudio, voiceState.offError]
    .forEach(off => { if (off) off(); });
  voiceState.offTranscript = voiceState.offToolStart = voiceState.offToolDone = voiceState.offFallback = voiceState.offQuotaWarn = voiceState.offAudio = voiceState.offError = null;
}

// Dispatcher: prefer the browser's free/unlimited Web Speech API (STT). Only
// fall back to the MediaRecorder→Groq-Whisper path if the browser lacks it.
const VOICE_HAS_BROWSER_STT = ('webkitSpeechRecognition' in window) || ('SpeechRecognition' in window);
function voiceStartListening() {
  if (!voiceState.active) return;
  if (VOICE_HAS_BROWSER_STT) voiceStartRecognition();
  else voiceStartMediaRecorder();
}

// ── Browser-native speech recognition (free, unlimited, no Groq) ────────────
function voiceStartRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec;
  try { rec = new SR(); } catch (e) { setVoicePhase('idle', 'Voice not available', e.message); return; }
  voiceState.recognition = rec;
  voiceState.gotResult = false;
  rec.lang = 'en-IN';           // Indian English recognition
  rec.interimResults = false;
  rec.continuous = false;        // auto-stops on end of speech (built-in endpointing)
  rec.maxAlternatives = 1;

  rec.onresult = (ev) => {
    const transcript = (ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript || '').trim();
    if (!transcript) return;
    voiceState.gotResult = true;
    setVoicePhase('thinking', 'Sending to Jesse…', '');
    armVoiceWatchdog();
    window.api.sendJessiVoiceText(transcript, state.messages.slice(-20));
  };
  rec.onerror = (ev) => {
    if (ev.error === 'no-speech' || ev.error === 'aborted') {
      if (voiceState.active && voiceState.phase === 'listening') voiceStartListening(); // just re-arm
      return;
    }
    setVoicePhase('idle', 'Mic error — tap to try again', ev.error || 'recognition failed');
  };
  rec.onend = () => {
    // Ended with no result and we're still meant to be listening → re-arm.
    if (!voiceState.gotResult && voiceState.active && voiceState.phase === 'listening') voiceStartListening();
  };

  try { rec.start(); setVoicePhase('listening', 'Listening… speak now', ''); }
  catch (e) { setVoicePhase('idle', 'Could not start mic', e.message); }
}

// ── Browser-native speech synthesis (free, unlimited, Indian voice) ─────────
function voicePickVoice() {
  const voices = (window.speechSynthesis && window.speechSynthesis.getVoices()) || [];
  if (!voices.length) return null;
  const byName = (re) => voices.find(v => re.test(v.name));
  // Prefer a known Indian female voice, then any en-IN, then any female-ish en.
  return byName(/heera/i)
    || voices.find(v => /en-IN/i.test(v.lang) && /female|heera|kavya|neerja|aditi/i.test(v.name))
    || voices.find(v => /en-IN/i.test(v.lang))
    || byName(/female|zira|neerja|aria/i)
    || voices.find(v => /^en/i.test(v.lang))
    || voices[0];
}

function voiceSpeak(text) {
  const synth = window.speechSynthesis;
  if (!synth) { voiceOnPlaybackDone(); return; }
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = voicePickVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-IN'; }
  u.rate = 1.0; u.pitch = 1.0;
  u.onend = () => voiceOnPlaybackDone();
  u.onerror = () => voiceOnPlaybackDone();
  voiceState.utterance = u;
  synth.speak(u);
}

// ── Legacy fallback: MediaRecorder → Groq Whisper (only if no browser STT) ──
async function voiceStartMediaRecorder() {
  if (!voiceState.active) return;
  try {
    voiceState.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setVoicePhase('idle', 'Mic permission denied', e.message);
    return;
  }

  voiceState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = voiceState.audioCtx.createMediaStreamSource(voiceState.stream);
  voiceState.analyser = voiceState.audioCtx.createAnalyser();
  voiceState.analyser.fftSize = 512;
  source.connect(voiceState.analyser);

  voiceState.chunks = [];
  voiceState.everSpoke = false;
  const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  voiceState.recorder = mimeType ? new MediaRecorder(voiceState.stream, { mimeType }) : new MediaRecorder(voiceState.stream);
  voiceState.recorder.ondataavailable = (e) => { if (e.data && e.data.size) voiceState.chunks.push(e.data); };
  voiceState.recorder.onstop = voiceOnRecordingStop;
  voiceState.recorder.start();

  setVoicePhase('listening', 'Listening… (pauses ~3-4s when you stop)', '');
  voiceWatchSilence();
}

function voiceWatchSilence() {
  const buf = new Uint8Array(voiceState.analyser.fftSize);
  const tick = () => {
    if (!voiceState.analyser || voiceState.phase !== 'listening') return;
    voiceState.analyser.getByteTimeDomainData(buf);
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sumSq += v * v; }
    const rms = Math.sqrt(sumSq / buf.length);

    if (rms > VOICE_AMPLITUDE_THRESHOLD) {
      voiceState.everSpoke = true;
      if (voiceState.silenceTimer) { clearTimeout(voiceState.silenceTimer); voiceState.silenceTimer = null; }
    } else if (voiceState.everSpoke && !voiceState.silenceTimer) {
      voiceState.silenceTimer = setTimeout(() => {
        if (voiceState.recorder && voiceState.recorder.state === 'recording') voiceState.recorder.stop();
      }, VOICE_SILENCE_MS);
    }
    voiceState.silenceCheckRaf = requestAnimationFrame(tick);
  };
  voiceState.silenceCheckRaf = requestAnimationFrame(tick);
}

async function voiceOnRecordingStop() {
  if (voiceState.silenceCheckRaf) { cancelAnimationFrame(voiceState.silenceCheckRaf); voiceState.silenceCheckRaf = null; }
  if (voiceState.silenceTimer) { clearTimeout(voiceState.silenceTimer); voiceState.silenceTimer = null; }
  if (voiceState.stream) { voiceState.stream.getTracks().forEach(t => t.stop()); voiceState.stream = null; }
  if (voiceState.audioCtx) { voiceState.audioCtx.close(); voiceState.audioCtx = null; }

  if (!voiceState.everSpoke || !voiceState.chunks.length) {
    // Nothing said — just re-arm listening rather than round-tripping empty audio.
    if (voiceState.active) voiceStartListening();
    return;
  }

  const blob = new Blob(voiceState.chunks, { type: voiceState.chunks[0].type || 'audio/webm' });
  const mimeType = blob.type || 'audio/webm';
  const base64 = await blobToBase64(blob);
  setVoicePhase('thinking', 'Sending to Jesse…', '');
  armVoiceWatchdog();
  window.api.sendJessiVoice(base64, mimeType, state.messages.slice(-20));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function voicePlayClips(clips, mime) {
  voiceState.clipQueue = clips.slice();
  voiceState.clipMime = mime || 'audio/wav'; // Edge TTS sends audio/mpeg; legacy Groq path sends wav
  const player = document.getElementById('voice-player');
  if (!player || !voiceState.clipQueue.length) { voiceOnPlaybackDone(); return; }

  player.onended = voicePlayNextClip;
  player.onerror = voicePlayNextClip;
  voicePlayNextClip();
}

function voicePlayNextClip() {
  const player = document.getElementById('voice-player');
  const next = voiceState.clipQueue.shift();
  if (!next) { voiceOnPlaybackDone(); return; }
  player.src = 'data:' + (voiceState.clipMime || 'audio/wav') + ';base64,' + next;
  player.play().catch(() => voicePlayNextClip());
}

function voiceOnPlaybackDone() {
  if (!voiceState.active) return;
  voiceStartListening(); // loop back to listening automatically
}

// ── Jessi app-action dispatcher ─────────────────────────────────────────────
// Called by the server (via ws-client) when voice/text Jessi invokes app_do.
// Runs the real UI action for the CURRENTLY OPEN account and returns a short
// result string the server feeds back into Jessi's tool loop. Destructive
// actions (switch_account, clear_insights) are already spoken-confirm-gated
// server-side, so by the time they arrive here confirm was granted.
window.jessiExecuteAppAction = async function (action, args) {
  args = args || {};
  try {
    switch (action) {
      case 'refresh_price':
        if (typeof refreshPrice === 'function') refreshPrice();
        return { ok: true, result: 'Price refreshed.' };

      case 'mark_london':
        if (typeof markLondonLevels === 'function') markLondonLevels();
        return { ok: true, result: 'Marking London levels (Prev Week H/L, PDH/PDL, Asia H/L) on the chart.' };

      case 'mark_ny':
        if (typeof markNYLevels === 'function') markNYLevels();
        return { ok: true, result: 'Marking NY levels (Week H/L, Month H/L) on the chart.' };

      case 'switch_tab': {
        const tab = String(args.tab || '').toLowerCase();
        const valid = ['analysis', 'journal', 'trades', 'rules', 'insights', 'cost', 'plan'];
        if (!valid.includes(tab)) return { ok: false, result: `Unknown tab "${args.tab}". Valid: ${valid.join(', ')}.` };
        if (typeof switchTab === 'function') switchTab(tab);
        return { ok: true, result: `Switched to the ${tab} tab.` };
      }

      case 'add_journal': {
        const text = String(args.text || '').trim();
        if (!text) return { ok: false, result: 'Nothing to journal — no text given.' };
        await window.api.journalAdd(text);
        return { ok: true, result: `Journaled: "${text}".` };
      }

      case 'end_session':
        if (typeof fillInput === 'function') fillInput('Session ended. Run the end-of-session review: verdict on system compliance, patterns triggered, best and worst decision, one fix for tomorrow.');
        if (typeof switchTab === 'function') switchTab('insights');
        return { ok: true, result: 'Opened Insights and loaded the end-of-session review prompt.' };

      case 'switch_account': {
        const size = String(args.size || '').toLowerCase();
        const mode = String(args.mode || '').toLowerCase();
        if (!['50k', '100k', '150k'].includes(size) || !['eval', 'funded'].includes(mode)) {
          return { ok: false, result: `Bad account. size must be 50k/100k/150k, mode eval/funded (got ${args.size}/${args.mode}).` };
        }
        if (typeof switchAccount === 'function') await switchAccount(size, mode);
        return { ok: true, result: `Switched the open account to ${size.toUpperCase()} ${mode.toUpperCase()}.` };
      }

      case 'log_fee': {
        // Same storage as the Cost tab's manual form (data/account_fees.json),
        // just fed from chat args instead of DOM inputs.
        const cost = parseFloat(args.cost);
        const d = await costLoad();
        d.fees.push({
          id: 'fee-' + Date.now(),
          date: (args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) ? args.date : new Date().toISOString().slice(0, 10),
          firm: String(args.firm || '—').trim(),
          size: String(args.size || '—').trim(),
          ref: '', cost: isNaN(cost) ? 0 : cost, status: 'active', confirmed: !isNaN(cost), note: 'added via Jessi'
        });
        await costPersist();
        if (typeof renderCost === 'function') renderCost();
        return { ok: true, result: `Logged fee: ${args.firm || '—'} ${args.size || ''} $${isNaN(cost) ? '?' : cost}.` };
      }

      case 'log_payout': {
        const amt = parseFloat(args.amount);
        if (isNaN(amt) || amt <= 0) return { ok: false, result: 'log_payout needs a positive "amount".' };
        const d = await costLoad();
        d.payouts.push({
          date: (args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) ? args.date : new Date().toISOString().slice(0, 10),
          account: String(args.account || '').trim(), amount: amt
        });
        await costPersist();
        if (typeof renderCost === 'function') renderCost();
        // 2026-08-16: mirror onto the active slot's journey record (does NOT
        // close it — funded stays active for the next payout, journey-tracker.js).
        // Best-effort against whichever slot is currently open; account_fees.json
        // (above) remains the authoritative lifetime figure Jessi quotes from.
        try {
          const sl = acctSlot();
          window.api.journeyAction('funded-payout', {
            slotId: sl.id, amount: amt,
            date: (args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) ? args.date : undefined
          }).then(() => { if (typeof renderInsights === 'function') renderInsights(); }).catch(() => {});
        } catch (e) {}
        return { ok: true, result: `Logged payout of $${amt}. First payout ever would be a real milestone — check the Cost tab.` };
      }

      case 'set_balance': {
        // Confirm-gated server-side (DESTRUCTIVE set) — by the time this runs,
        // Anoop already explicitly confirmed.
        const value = parseFloat(args.value);
        if (isNaN(value) || value <= 0) return { ok: false, result: 'set_balance needs a positive "value".' };
        const old = state.account.balance;
        state.account.balance = value;
        window.api.setConfig('balance', value);
        if (typeof updateAccountUI === 'function') updateAccountUI();
        return { ok: true, result: `Balance updated $${old} → $${value} for the open account. Floors/buffers recompute from this.` };
      }

      case 'clear_insights': {
        // Same effect as the ✕ Clear-insights button, minus its browser
        // confirm() dialog (spoken confirmation already happened server-side).
        ['copilot_gr_history', 'copilot_balance_ledger', 'copilot_ck_history', 'copilot_guardrail_v1'].forEach(k => localStorage.removeItem(k));
        if (typeof grRender === 'function') grRender();
        if (typeof renderInsights === 'function') renderInsights();
        if (typeof addSystemMessage === 'function') addSystemMessage('Insights cleared by voice. Upload your Performance CSVs to rebuild.');
        return { ok: true, result: 'Cleared insights, history, checklist scores and the balance ledger for the open account.' };
      }

      default:
        return { ok: false, result: `Unknown action "${action}".` };
    }
  } catch (e) {
    return { ok: false, result: 'Error running ' + action + ': ' + e.message };
  }
};

function voiceStopEverything() {
  clearVoiceWatchdog();
  if (voiceState.recognition) {
    try { voiceState.recognition.onend = null; voiceState.recognition.onresult = null; voiceState.recognition.abort(); } catch (e) {}
    voiceState.recognition = null;
  }
  if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) {} }
  if (voiceState.recorder && voiceState.recorder.state === 'recording') {
    voiceState.recorder.onstop = null; // don't trigger the auto-send path on manual exit
    voiceState.recorder.stop();
  }
  if (voiceState.silenceCheckRaf) { cancelAnimationFrame(voiceState.silenceCheckRaf); voiceState.silenceCheckRaf = null; }
  if (voiceState.silenceTimer) { clearTimeout(voiceState.silenceTimer); voiceState.silenceTimer = null; }
  if (voiceState.stream) { voiceState.stream.getTracks().forEach(t => t.stop()); voiceState.stream = null; }
  if (voiceState.audioCtx) { voiceState.audioCtx.close(); voiceState.audioCtx = null; }
  const player = document.getElementById('voice-player');
  if (player) { player.onended = null; player.pause(); player.src = ''; }
  voiceState.clipQueue = [];
  window.api.cancelJessiVoice();
  setVoicePhase('idle', '', '');
}

function buildContextMessage() {
  const acc = state.account;
  const modeRules = state.mode === 'eval'
    ? `Daily stop: -$${acc.evalDayStop} | Day cap: $${acc.evalDayCap.toLocaleString()} | Max size: 6 micros | Session trades: 2 | Daily: 2`
    : `Daily loss tiers: -$100 YELLOW / -$150 RED / -$${acc.fundedDayStop} HARD STOP | Target: $${acc.fundedTargetMin}–$${acc.fundedTargetMax} (5 qualifying days ≥$150 for payout) | Size: ${getSizeFromProfit(acc.profit)} | Trades: ${acc.tradeCount}/20 | 15-min break mandatory | One instrument per DAY`;

  // Coaching layer (Kane/JadeCap model, adopted 2026-07-17): the AI chat must
  // hold Anoop to HIS OWN model, not hand out generic advice.
  let coachCtx = '';
  try {
    const ls = typeof loopState === 'function' ? loopState() : {};
    coachCtx = `
COACHING MODEL (hold him to it, no softening):
- Grade PROCESS not P&L: red day + rules followed = A day; green day + broken rules = failure in disguise.
- One bias per day, ONE direction. Flip-flopping long/short = revenge — call it out immediately.
- Flat size (max 6 micros), never sized by mood or confidence. Winners must be BIGGER than losers (top-line health metric).
- Cut losers at the cap ($300 disaster ceiling, target $200). Hold winners 5-10 min toward the next level.
- 2-3 shots per day, 19:00-20:00 IST hour only. After a loss: off the desk 15 min, no exceptions.
- Losing streaks are normal probability — manage behavior around them, never chase them back.
- Challenge: ${ls.streak || 0}/${ls.goalDays || 5} green days (score>=${ls.target || 70}). Today's focus: ${ls.focus || 'upload CSV to set'}.`;
  } catch (e) {}

  return {
    role: 'user',
    content: `[LIVE SESSION — ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST | MODE: ${state.mode.toUpperCase()}]
Balance: $${acc.balance.toLocaleString()} | Floor: $${(state.mode === 'eval' ? acc.evalFloor : acc.fundedFloor).toLocaleString()} | Buffer: $${(acc.balance - (state.mode === 'eval' ? acc.evalFloor : acc.fundedFloor)).toLocaleString()}
Today P&L: ${acc.profit >= 0 ? '+' : ''}$${acc.profit} | Trades today: ${acc.tradeCount}
${modeRules}
GO/NO-GO: ${acc.goNogo.toUpperCase()}${coachCtx}
[END CONTEXT — respond concisely]`
  };
}

function getSizeFromProfit(profit) {
  if (profit >= 2000) return '40 micros';
  if (profit >= 1000) return '30 micros';
  return '20 micros';
}

// ── Read-aloud (2026-07-28) ──────────────────────────────────────────────────
// Speaker button on every assistant message — replays the ALREADY-GENERATED
// text via Edge TTS (same en-IN Neerja neural voice as voice mode). Pure
// text-to-speech on text already on screen: no LLM call, zero tokens per
// replay. Anoop's own words: "so that i can hear anything again to fix my
// psychology and also save token." Standalone from voiceState/voice mode's
// player — a message can be replayed at any time, mid-session or not, without
// touching voice-mode's own UI/phase machinery.
let ttsPlayer = null;
let ttsQueue = [];
let ttsActiveBtn = null;
// 2026-08-07: the read-aloud button was producing SILENCE for Anoop despite
// the server returning valid TTS clips. Root cause: Chrome's autoplay policy
// blocks <audio>.play() after the network round-trip (the click "gesture"
// expires while we wait for the server), and ttsPlayNext's play().catch() only
// logged + advanced the queue — it never fell back to the browser's own
// speechSynthesis the way VOICE MODE does. Voice mode is reliable precisely
// because (with browser STT present) it speaks replies via window.speechSynthesis,
// which is immune to the audio-element autoplay policy. So read-aloud now
// mirrors that: try the nicer neural clip, but the instant the FIRST clip is
// blocked/fails, speak the whole reply via speechSynthesis so there is ALWAYS
// sound on a click. ttsCurrentText holds the text for that fallback;
// ttsStartedPlaying distinguishes "first clip never played (autoplay blocked →
// browser voice)" from "a later clip hiccuped after audio already worked (just
// advance)".
let ttsCurrentText = '';
let ttsStartedPlaying = false;

// Strips markdown syntax and decorative symbols/emoji before handing text to
// TTS. Anoop's ask: "i don't want the voice to read any symbols as they are
// of no use and unnecessary" — without this, Neerja would literally say
// "asterisk asterisk COMPLIANT asterisk asterisk" or spell out "hash hash"
// for headers, and every ✅/🚨/⚠/📋 emoji used throughout the app's messages.
function sanitizeForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')                    // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')                          // inline code
    .replace(/^#{1,6}\s+/gm, '')                          // markdown headers
    .replace(/^>\s?/gm, '')                                // blockquote markers
    .replace(/^\s*[-*+•]\s+/gm, '')                        // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '')                         // numbered list markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')               // [text](url) -> text
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')       // **bold**, _italic_, ~~strike~~
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, ' ') // emoji/symbol/arrow ranges
    .replace(/[#*_`~|>]/g, ' ')                            // any leftover markdown punctuation
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function getTtsPlayer() {
  if (!ttsPlayer) {
    ttsPlayer = document.createElement('audio');
    ttsPlayer.style.display = 'none';
    document.body.appendChild(ttsPlayer);
    // NOTE: BOTH onended and onerror are armed PER-CLIP inside ttsPlayNext, not
    // persistently here, so the synchronous autoplay-"unlock" probe clip and the
    // intentional src teardown in ttsStop() (which clear both handlers) can never
    // touch playback state — no spurious queue-advance/reset and no phantom
    // browser-voice fallback. Handlers exist only while a real clip is playing.
  }
  return ttsPlayer;
}
// One place that decides what a clip failure means, shared by BOTH the
// <audio>.play() promise rejection (autoplay block) and the element's onerror
// event (decode failure). If nothing has audibly played yet, the neural path
// is unusable this click → speak the whole reply via the browser voice so
// there is always sound. If audio was already playing, it's a mid-stream blip
// → just advance to the next clip.
function ttsHandleClipFailure(why) {
  console.error('[read-aloud] clip failure:', why && why.name ? (why.name + ' ' + (why.message || '')) : (why || 'media error'));
  // Disarm the element handlers first — a blocked clip can fire BOTH the play()
  // promise rejection and the element's onerror; without this the second event
  // would re-enter and restart the browser-voice fallback. ttsPlayNext re-arms
  // them for the next clip in the advance branch below.
  if (ttsPlayer) { ttsPlayer.onended = null; ttsPlayer.onerror = null; }
  if (!ttsStartedPlaying) {
    ttsQueue = [];
    ttsSpeakViaBrowser(ttsCurrentText, ttsActiveBtn);
  } else {
    ttsPlayNext();
  }
}
// Guaranteed, network-free, autoplay-immune speech — the SAME engine voice
// mode uses to reliably speak replies. This is the backstop that makes the
// read-aloud button always produce sound, even when the neural <audio> clips
// are blocked by Chrome's autoplay policy. Returns true if it started speaking.
function ttsSpeakViaBrowser(text, btn) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) { ttsStopUI(); return false; }
    const clean = sanitizeForSpeech(text);
    if (!clean) { ttsStopUI(); return false; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    const v = (typeof voicePickVoice === 'function') ? voicePickVoice() : null;
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-IN'; }
    u.rate = 1.0; u.pitch = 1.0;
    u.onend = ttsStopUI;
    u.onerror = ttsStopUI;
    if (btn) btn.textContent = '⏹';
    synth.speak(u);
    return true;
  } catch (e) {
    console.error('[read-aloud] browser speechSynthesis failed:', e);
    ttsStopUI();
    return false;
  }
}
function ttsPlayNext() {
  const next = ttsQueue.shift();
  if (!next) { ttsStopUI(); return; }
  const player = getTtsPlayer();
  player.onended = ttsPlayNext;          // arm ONLY for this real clip
  player.onerror = ttsHandleClipFailure; // arm ONLY for this real clip
  player.src = 'data:' + next.mime + ';base64,' + next.clip;
  const pr = player.play();
  if (pr && pr.then) pr.then(() => { ttsStartedPlaying = true; }).catch(() => {});
  // play() rejection (Chrome autoplay block after the network round-trip) and
  // the element's onerror (decode failure) both route through the one shared
  // handler so a first-clip failure ALWAYS falls back to the browser voice.
  if (pr && pr.catch) pr.catch((err) => ttsHandleClipFailure(err));
}
function ttsStopUI() {
  if (ttsActiveBtn) { ttsActiveBtn.classList.remove('speaking'); ttsActiveBtn.textContent = '🔊'; }
  if (ttsPlayer) { ttsPlayer.onended = null; ttsPlayer.onerror = null; } // disarm — no clip is playing now
  ttsActiveBtn = null;
  ttsQueue = [];
  ttsStartedPlaying = false;
  ttsCurrentText = '';
}
function ttsStop() {
  // Disarm onerror BEFORE tearing down src — clearing the source fires an
  // error event on the element, which must NOT be treated as a clip failure
  // (that would spuriously kick off the browser-voice fallback). removeAttribute
  // + load() resets the element cleanly instead of pointing it at an empty URL.
  try {
    const p = getTtsPlayer();
    p.onended = null; p.onerror = null;
    p.pause();
    p.removeAttribute('src');
    p.load();
  } catch (e) {}
  // Also cancel browser speechSynthesis — read-aloud falls back to it when
  // Edge TTS is unavailable, and without this the stop button did nothing
  // during a fallback playback.
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
  ttsStopUI();
}
async function ttsToggle(btn, text) {
  // Clicking the currently-speaking button stops playback.
  if (ttsActiveBtn === btn) { ttsStop(); return; }
  ttsStop(); // stop whatever else was playing first
  ttsActiveBtn = btn;
  ttsCurrentText = text;       // stashed so any playback failure can fall back to browser speech
  ttsStartedPlaying = false;
  btn.classList.add('speaking');
  btn.textContent = '⏳';

  // HARDENING (2026-07-28): "unlock" the audio element SYNCHRONOUSLY inside
  // the click handler, before any await. Browsers gate audio playback on user
  // activation; because the real play() below happens after a network
  // round-trip (which can take seconds for a long review), the activation can
  // be judged stale and play() then rejects silently — button looks dead, no
  // sound, no error. Playing a 0-length silent clip here while we're still
  // provably inside the user gesture marks the element as user-initiated, so
  // the later play() is always allowed. 2026-08-07: even when this fails,
  // ttsPlayNext now falls back to browser speech, so silence is no longer a
  // possible outcome.
  try {
    const p = getTtsPlayer();
    p.onended = null; p.onerror = null; // the unlock's silent probe clip must not touch playback state
    p.src = 'data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA';
    const pr = p.play();
    if (pr && pr.then) pr.then(() => { try { p.pause(); } catch (e) {} }).catch(() => {});
  } catch (e) { /* non-fatal — real play() below may still work */ }
  try {
    const clean = sanitizeForSpeech(text);
    if (!clean) { ttsStopUI(); return; }
    const { clips, mime } = await window.api.speakText(clean);
    if (ttsActiveBtn !== btn) return; // user switched to another message while we waited
    // No clips from the server (both server voices down) — go straight to the
    // browser voice rather than falling silent.
    if (!clips || !clips.length) { ttsSpeakViaBrowser(text, btn); return; }
    btn.textContent = '⏹';
    ttsQueue = clips.map(c => ({ clip: c, mime: mime || 'audio/mpeg' }));
    ttsPlayNext();
  } catch (e) {
    // Server TTS threw (e.g. Edge's unofficial endpoint 403'd AND local
    // Windows SAPI was unavailable, or the request timed out). Voice mode
    // always had a browser-speechSynthesis fallback; read-aloud now shares the
    // exact same guaranteed path so it never fails hard during trading hours.
    console.error('[read-aloud] server TTS failed, using browser voice:', e && e.message ? e.message : e);
    if (ttsActiveBtn !== btn) return;
    if (!ttsSpeakViaBrowser(text, btn)) {
      addSystemMessage('⚠ Read-aloud unavailable: ' + (e && e.message ? e.message : e));
    }
  }
}
// Attaches a 🔊 button to a message row. `rowEl` is the .msg container (NOT
// the inner .msg-bubble) — the button sits alongside the bubble, not inside
// its markdown-rendered HTML. Skips empty/very short text (e.g. system pills).
function attachSpeakButton(rowEl, text) {
  try {
    if (!rowEl || !text || text.trim().length < 3) return;
    if (rowEl.querySelector('.msg-speak-btn')) return; // already attached
    const btn = document.createElement('button');
    btn.className = 'msg-speak-btn';
    btn.type = 'button';
    btn.title = 'Read aloud';
    btn.textContent = '🔊';
    btn.onclick = (ev) => { ev.stopPropagation(); ttsToggle(btn, text); };
    rowEl.appendChild(btn);
  } catch (e) { /* never let a UI extra break message rendering */ }
}
window.attachSpeakButton = attachSpeakButton; // exposed for resilience.js's restore()

// ── Message rendering ──────────────────────────────────────────────────────────
function addUserMessage(text) {
  const msgs = document.getElementById('messages');
  const d = document.createElement('div');
  d.className = 'msg user';
  d.innerHTML = `<div class="msg-bubble">${escHtml(text)}</div>`;
  msgs.appendChild(d);
  scrollToBottom();
}

function startNewAssistantBubble() {
  const msgs = document.getElementById('messages');
  const d = document.createElement('div');
  d.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  d.appendChild(bubble);
  msgs.appendChild(d);
  state.currentAssistantBubble = bubble;
  state.streamBuffer = '';
  scrollToBottom();
  return bubble;
}

function appendToCurrentBubble(text) {
  if (!state.currentAssistantBubble) startNewAssistantBubble();
  state.streamBuffer += text;
  state.currentAssistantBubble.innerHTML = renderMarkdown(state.streamBuffer);
  scrollToBottom();
}

// 2026-08-07: small "answered by: X" badge — added per Anoop's ask after
// OmniRoute joined the provider chain as primary brain. Previously model
// routing was deliberately invisible (2026-07-27: "Jessi's business, not
// something that interrupts the conversation on screen") — this supersedes
// that for a narrower reason: OmniRoute can fail/get banned silently, and a
// downgrade to Gemini/Groq with zero visible signal is a real risk worth
// surfacing. Kept as a small caption-style line, not a bubble, so it doesn't
// re-introduce the interruption the earlier decision was avoiding.
function modelBadgeHtml(answeredBy) {
  if (!answeredBy || !answeredBy.label) return '';
  const icon = answeredBy.provider === 'omniroute' ? '⚡'
    : answeredBy.provider === 'groq' ? '🟢'
    : answeredBy.provider === 'gemini' ? '🔷'
    : answeredBy.provider === 'ollama' ? '💻' : '';
  return `<div class="model-answered-by" title="This reply was generated by ${escHtml(answeredBy.label)}">${icon} ${escHtml(answeredBy.label)}</div>`;
}

function finalizeAssistantBubble(fullText, htmlPrefix, answeredBy) {
  if (state.currentAssistantBubble) {
    const text = fullText || state.streamBuffer;
    state.currentAssistantBubble.innerHTML = (htmlPrefix || '') + renderMarkdown(text) + modelBadgeHtml(answeredBy);
    if (isWarningText(text)) state.currentAssistantBubble.classList.add('warning');
    else if (isCautionText(text)) state.currentAssistantBubble.classList.add('caution');
    attachSpeakButton(state.currentAssistantBubble.parentElement, text);
    state.currentAssistantBubble = null;
    state.streamBuffer = '';
  }
  state.messages.push({ role: 'assistant', content: fullText || '' });
  // Keep conversation context to last 20 turns to prevent token bloat
  if (state.messages.length > 40) state.messages = state.messages.slice(-40);
}

function addSystemMessage(text) {
  const msgs = document.getElementById('messages');
  const d = document.createElement('div');
  d.className = 'msg system-msg';
  d.innerHTML = `<div class="msg-bubble">${escHtml(text)}</div>`;
  msgs.appendChild(d);
  scrollToBottom();
}

// ── Phase 2b: trade ticket card (2026-08-17) ─────────────────────────────
// Rendered when the Judge's verdict carries a TRADE_TICKET line (see
// trade-ticket-parse.js). Editable size/stop/target, Confirm sends a
// trade-confirm-request — the server (handleTradeConfirm in server.js) is
// the ONLY place that actually enforces sizeCap/dayStop/size-freeze and
// calls placeMarketOrder; nothing here can bypass that by construction, it
// just sends a request and renders whatever the server decides.
// 2026-08-17: tracked separately from the DOM so the HUD pill (always
// visible, unlike the chat panel which scrolls) can reflect "is there a
// ticket waiting" from anywhere in the app — GO verdicts can be rare, so a
// pending one is easy to miss if it only ever showed inside the chat.
window._pendingTicketIds = window._pendingTicketIds || new Set();
function updateTicketPill() {
  const pill = document.getElementById('gr-ticket-pill');
  if (!pill) return;
  const n = window._pendingTicketIds.size;
  pill.style.display = n > 0 ? '' : 'none';
  pill.textContent = n > 1 ? ('⚡ ' + n + ' TRADE TICKETS PENDING') : '⚡ TRADE TICKET PENDING';
}
window.tcScrollToPending = function () {
  const id = window._pendingTicketIds.values().next().value;
  const el = id && document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

function renderTradeTicketCard(msg) {
  const id = 'tc-' + String(msg.sourceVerdictId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '');
  if (document.getElementById(id)) return; // one card per verdict
  window._pendingTicketIds.add(id);
  updateTicketPill();
  const msgs = document.getElementById('messages');
  if (!msgs) return;
  const d = document.createElement('div');
  d.className = 'msg system-msg trade-ticket-card';
  d.id = id;
  d.dataset.side = msg.side || '';
  d.dataset.symbol = msg.symbol || '';
  d.dataset.sourceVerdictId = msg.sourceVerdictId || '';
  const sideLabel = String(msg.side || '').toUpperCase();
  const symbolLabel = msg.symbol ? escHtml(msg.symbol) : '<span style="opacity:.6">resolving symbol…</span>';
  // Attribute-interpolated values are forced through Number(...) first —
  // a finite number's toString() can never contain a quote/bracket
  // character, so this can't break out of the attribute regardless of what
  // arrives over the WS message, independent of escHtml's own text-escaping.
  const safeNum = (v) => (v != null && Number.isFinite(Number(v))) ? Number(v) : '';
  d.innerHTML = `<div class="msg-bubble trade-ticket-bubble">
    <div class="tt-header">⚡ Trade ticket — ${escHtml(sideLabel)} ${symbolLabel}</div>
    <div class="tt-row"><label>Size</label><input type="number" min="1" class="gr-in" id="${id}-size" value="${safeNum(msg.size)}"></div>
    <div class="tt-row"><label>Stop (optional)</label><input type="number" step="0.25" class="gr-in" id="${id}-stop" value="${safeNum(msg.stopPrice)}"></div>
    <div class="tt-row"><label>Target (optional)</label><input type="number" step="0.25" class="gr-in" id="${id}-target" value="${safeNum(msg.targetPrice)}"></div>
    <div class="tt-actions">
      <button class="gr-btn" onclick="tcConfirm('${id}')">Confirm &amp; Execute</button>
      <button class="gr-btn gr-reset" onclick="tcDismiss('${id}')">Dismiss</button>
    </div>
    <div class="tt-result" id="${id}-result"></div>
  </div>`;
  msgs.appendChild(d);
  scrollToBottom();
}

window.tcDismiss = function (id) {
  const el = document.getElementById(id);
  if (el) el.remove();
  window._pendingTicketIds.delete(id);
  updateTicketPill();
};

window.tcConfirm = function (id) {
  const card = document.getElementById(id);
  if (!card) return;
  const sizeEl = document.getElementById(id + '-size');
  const stopEl = document.getElementById(id + '-stop');
  const targetEl = document.getElementById(id + '-target');
  const resultEl = document.getElementById(id + '-result');
  const size = parseInt(sizeEl.value, 10);
  if (!size || size <= 0) { sizeEl.style.borderColor = 'var(--red)'; return; }
  sizeEl.style.borderColor = '';
  const stopVal = stopEl.value !== '' ? parseFloat(stopEl.value) : null;
  const targetVal = targetEl.value !== '' ? parseFloat(targetEl.value) : null;
  card.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
  if (resultEl) resultEl.textContent = 'Submitting…';
  const requestId = window.api.sendTradeConfirm({
    sourceVerdictId: card.dataset.sourceVerdictId || null,
    side: card.dataset.side,
    symbol: card.dataset.symbol || undefined,
    qty: size,
    stopPrice: stopVal,
    targetPrice: targetVal
  });
  card.dataset.pendingRequestId = requestId;
};

// One handler for both trade-confirm-result (passed/failed at execution) and
// trade-confirm-rejected (blocked by the server-side rules check before
// ever reaching placeMarketOrder) — same card lookup, different messaging.
function tcHandleResult(resultMsg, rejectedMsg) {
  const msg = resultMsg || rejectedMsg;
  if (!msg || !msg.requestId) return;
  // CSS.escape guards the selector against a requestId containing a quote
  // or bracket — requestId is normally self-generated in ws-client.js
  // (tc-<digits>-<base36>) so this is defense-in-depth, not a known bug.
  const safeReqId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(msg.requestId) : String(msg.requestId).replace(/["\\\]]/g, '');
  const card = document.querySelector('.trade-ticket-card[data-pending-request-id="' + safeReqId + '"]');
  if (!card) return;
  const resultEl = document.getElementById(card.id + '-result');
  if (rejectedMsg) {
    if (resultEl) resultEl.textContent = '🚫 BLOCKED: ' + (rejectedMsg.reason || 'rejected by server-side rules check');
    card.querySelectorAll('button, input').forEach((el) => { el.disabled = false; });
    return;
  }
  if (resultMsg.success) {
    // 2026-08-19: placeMarketOrder()'s post-submit readback (verified/
    // verifyDetail) now reaches this far — don't present an unconfirmed
    // submit with the same flat "✅" a confirmed one gets. verified===false
    // means the click fired but neither a matching position nor a Working/
    // Filled order was found within the readback window — worth a manual
    // look at the broker panel, not a silent "all good."
    if (resultMsg.verified === false) {
      if (resultEl) resultEl.innerHTML = '⚠️ Order submitted but NOT CONFIRMED: ' + escHtml(resultMsg.submittedLabel || '') + ' — check the broker panel manually.';
      addSystemMessage('Trade submitted (' + (resultMsg.submittedLabel || (card.dataset.side + ' ' + card.dataset.symbol)) + ') but could not be confirmed against the broker\'s positions/orders within the readback window — verify manually before assuming it went through.');
    } else {
      if (resultEl) resultEl.innerHTML = '✅ Order submitted: ' + escHtml(resultMsg.submittedLabel || '') + (resultMsg.verifyDetail ? ' (' + escHtml(resultMsg.verifyDetail) + ')' : '');
      addSystemMessage('Trade confirmed and executed: ' + (resultMsg.submittedLabel || (card.dataset.side + ' ' + card.dataset.symbol)));
    }
    // Resolved — no longer pending. A rejection/failure above deliberately
    // does NOT clear this: the card re-enables for another attempt, so it
    // should stay lit until Anoop either succeeds or explicitly dismisses it.
    window._pendingTicketIds.delete(card.id);
    updateTicketPill();
  } else {
    if (resultEl) resultEl.textContent = '❌ ' + (resultMsg.error || 'order failed');
    card.querySelectorAll('button, input').forEach((el) => { el.disabled = false; });
  }
}

// Compact single-line status pill for deterministic (non-chat) quick actions
// — marking chart levels, marking news times, starting a monitor. Anoop:
// "action taken about marking and every other thing to be small and not
// occupy space" — these used to be full-width addSystemMessage() bubbles
// that wrapped to 2+ lines each and stacked up fast. Same visual language as
// the tool-call indicator pill (small, single line), but standalone (not
// keyed by TV tool name) so it can't collide with toolLabel()'s map. The
// full detail (e.g. every level + its price) goes in the title= tooltip
// instead of being spelled out in the pill itself — hover to see it.
function addActionPill(label, fullDetail) {
  const msgs = document.getElementById('messages');
  const d = document.createElement('div');
  d.className = 'tool-indicator';
  if (fullDetail) d.title = fullDetail;
  d.innerHTML = `<div class="tool-dot"></div> ${escHtml(label)}…`;
  msgs.appendChild(d);
  scrollToBottom();
  return d;
}
function updateActionPill(el, label, ok, fullDetail) {
  if (!el) return addActionPill(label, fullDetail); // pre-announce pill was never created (e.g. page reloaded mid-action) — still show the result
  el.className = 'tool-indicator ' + (ok ? 'done' : 'error');
  if (fullDetail) el.title = fullDetail;
  el.innerHTML = `<div class="tool-dot"></div> ${escHtml(label)} ${ok ? '✓' : '✗'}`;
}

// Single collapsed indicator shown once a response finishes, instead of a
// chip per tool call. No-op if the turn didn't use any tools (a plain chat
// reply shouldn't get a tick at all).
function appendFinalToolTick() {
  const count = state.toolCallCount;
  const hadError = state.toolCallHadError;
  state.toolCallCount = 0;
  state.toolCallHadError = false;
  if (count <= 0) return;

  const msgs = document.getElementById('messages');
  const d = document.createElement('div');
  d.className = 'tool-indicator ' + (hadError ? 'error' : 'done');
  const label = hadError ? 'Analysis complete — one check failed' : 'Analysis complete';
  d.innerHTML = `<div class="tool-dot"></div> ${label} ${hadError ? '✗' : '✓'}`;
  msgs.appendChild(d);
  scrollToBottom();
}

function appendToolIndicator(toolName) {
  const msgs = document.getElementById('messages');
  const d = document.createElement('div');
  d.className = 'tool-indicator';
  d.dataset.tool = toolName;
  d.innerHTML = `<div class="tool-dot"></div> ${toolLabel(toolName)}…`;
  msgs.appendChild(d);
  scrollToBottom();
}

function updateToolIndicator(toolName, ok) {
  const el = document.querySelector(`.tool-indicator[data-tool="${toolName}"]:not(.done):not(.error)`);
  if (el) {
    el.className = 'tool-indicator ' + (ok ? 'done' : 'error');
    el.innerHTML = `<div class="tool-dot"></div> ${toolLabel(toolName)} ${ok ? '✓' : '✗'}`;
  }
}

function toolLabel(name) {
  const map = {
    chart_get_state: 'Reading chart', chart_set_timeframe: 'Switching TF',
    quote_get: 'Fetching price', data_get_ohlcv: 'Reading bars',
    data_get_study_values: 'Reading indicators', data_get_pine_lines: 'Reading levels',
    data_get_pine_labels: 'Reading labels', data_get_pine_tables: 'Reading tables',
    capture_screenshot: 'Screenshot', alert_create: 'Creating alert',
    alert_list: 'Listing alerts', draw_shape: 'Drawing on chart',
    draw_clear: 'Clearing drawings', chart_manage_indicator: 'Managing indicator',
    tv_health_check: 'Health check', chart_set_symbol: 'Switching symbol'
  };
  return map[name] || name;
}

// ── Markdown renderer ──────────────────────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  let html = escHtml(text);
  html = html.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>');
  html = html.replace(/^## (.+)$/gm,  '<div class="md-h3">$1</div>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g,     '<em>$1</em>');
  html = html.replace(/`(.+?)`/g,       '<code>$1</code>');
  // 2026-08-05: was [•\-] only, so a single-asterisk bullet ("* Verdict on
  // the process...", Jessi's actual output style) fell through as a literal
  // asterisk instead of a bullet. Safe to add '*' here: the \*\*bold\*\* and
  // \*italic\* passes above already ran and only ever consume a MATCHED pair
  // of asterisks on the same line, so a lone leading "* " survives untouched
  // and lands here.
  html = html.replace(/^[•\-*] (.+)$/gm, '<div class="md-li">$1</div>');
  html = html.replace(/^\d+\. (.+)$/gm, '<div class="md-li">$1</div>');
  html = html.replace(/^---+$/gm,        '<hr class="md-sep">');
  // 2026-08-12 P0: these were two passes with GO FIRST, so 'NO-GO' became
  // 'NO-<span class="badge-go">GO</span>' — a NO-GO verdict rendered a GREEN GO
  // chip, and the NO-GO pass then found nothing left to match. Every NO-GO Anoop
  // has ever been shown was coloured as its opposite. One alternating pass now:
  // NO-GO is listed first so the regex engine prefers it, and because it is a
  // single pass the substituted markup is never rescanned.
  html = html.replace(/\bNO-GO\b|\bGO\b/g, (m) =>
    m === 'NO-GO'
      ? '<span class="badge-nogo">NO-GO</span>'
      : '<span class="badge-go">GO</span>');
  // FIX (2026-07-27): md-li/md-h3/hr are already block elements — each one
  // creates its own line break. A blank line next to one (very common in
  // AI-generated markdown, one blank line between every bullet) used to
  // become an EXTRA stacked <br> on top of that, doubling the visible gap.
  // Anoop: "there is lot of gap between all the lines... I should be able to
  // read in 1-2 mouse scrolls." Strip blank lines touching a block element
  // entirely, and cap any remaining run of blank lines (genuine paragraph
  // breaks in prose) to a single blank line instead of stacking.
  // Strip newlines ENTIRELY around block boundaries (div/hr already are the
  // break — any <br> there was pure double-spacing), not just collapsed to
  // one; only plain prose newlines become <br>.
  html = html.replace(/\n+(?=<div class="md-(li|h3)">|<hr)/g, '');
  html = html.replace(/(<\/div>|<hr class="md-sep">)\n+/g, '$1');
  html = html.replace(/\n{3,}/g, '\n\n');
  html = html.replace(/\n/g,             '<br>');
  return html;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function isWarningText(t) {
  if (!t) return false;
  return /pattern [12]|stop now|close tradovate|daily stop|hard stop|emergency/i.test(t);
}
function isCautionText(t) {
  if (!t) return false;
  return /pattern [3456]|danger zone|violation|no-go|caution|approaching/i.test(t);
}

// ── Input helpers ──────────────────────────────────────────────────────────────
function setStreaming(on) {
  state.isStreaming = on;
  document.getElementById('send-btn').style.display = on ? 'none' : 'flex';
  document.getElementById('cancel-btn').style.display = on ? 'flex' : 'none';
  document.getElementById('typing').classList.toggle('visible', on && !state.currentAssistantBubble);
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function fillInput(text) {
  const el = document.getElementById('chat-input');
  el.value = text;
  el.focus();
  autoResize(el);
  el.setSelectionRange(text.length, text.length);
}

function scrollToBottom() {
  const msgs = document.getElementById('messages');
  requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
}

// ── Quick actions ──────────────────────────────────────────────────────────────
function quickAction(action) {
  const prompts = {
    'pre-session': 'Run the full pre-session GO/NO-GO checklist. Read the live chart, get current price and 4H bias, check key level. Issue GO or NO-GO based on account rules and my current mode.',
    'analyze':     'Run a complete top-down analysis: Daily → 4H → 1H → 15M. Read the chart at each timeframe using MCP. Give me: bias direction, key level, whether any Playbook A or B setup is forming right now, and exactly what to wait for.',
    'screenshot':  'Take a screenshot of the current chart and tell me what you see.',
    'stop-session':'Session ended. Run the end-of-session review. Verdict on system compliance, patterns triggered, best decision, worst decision, one fix for tomorrow.',
    'watchlist':   'Scan my "focus" watchlist (make sure it\'s the active tab in TradingView) — pull it with watchlist_get and give me a compact read per symbol: price, change%, quick bias. This is context only, not a trade instruction — I still only trade MNQ and MGC.'
  };
  if (prompts[action]) fillInput(prompts[action]);
}

// Deterministic (not chat-driven) — same architecture as the monitor
// check-now buttons. Marks Prev Week H/L + PDH/PDL + Asia session H/L on the
// live chart. UPDATED 2026-07-22 (was PDH/PDL + Asia only, additive change) —
// keep this string in sync with markLondonLevels() in server.js if that
// changes again.
function markLondonLevels() {
  window.api.markLondonLevels();
  state._londonPill = addActionPill('Marking London levels');
}

// Deterministic (not chat-driven) - same architecture as markLondonLevels above.
// Marks current Week H/L + current Month H/L on the live chart. UPDATED
// 2026-07-22 (was PDH/PDL + London H/L — full replacement, not additive) —
// keep this string in sync with markNYLevels() in server.js if that changes again.
function markNYLevels() {
  window.api.markNYLevels();
  state._nyPill = addActionPill('Marking NY levels');
}

// ── Economic calendar / no-trade windows ────────────────────────────────────────
// Server tracks this continuously (cheap — no TradingView calls, just a cached
// JSON feed re-filtered every 60s) and pushes 'news-status' on every recompute,
// so this just renders whatever it's given.
function renderNewsPanel(status) {
  state.news = status;
  computeMechanicalGoNogo();
  const banner = document.getElementById('news-blackout-banner');
  const list = document.getElementById('news-list');
  if (!banner || !list) return;

  if (status.inBlackout && status.activeEvent) {
    const untilT = new Date(status.activeEvent.until).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' });
    banner.style.display = '';
    banner.className = 'gonogo-badge nogo';
    banner.textContent = `NO-TRADE — ${status.activeEvent.title} (${status.activeEvent.country}) until ${untilT} IST`;
    if (!state.newsWasBlackout) {
      showAlertBanner(`🚫 NO-TRADE WINDOW — ${status.activeEvent.title} (${status.activeEvent.country})`, 'red');
      showBrowserNotification('NO-TRADE WINDOW', `${status.activeEvent.title} (${status.activeEvent.country}) — hold off until ${untilT} IST`, true);
    }
  } else {
    banner.style.display = 'none';
  }
  state.newsWasBlackout = !!status.inBlackout;

  const rows = [];
  (status.holidaysToday || []).forEach(h => {
    rows.push(`<div class="news-item holiday"><span class="news-title">🏦 ${escHtml(h.title)} (${escHtml(h.country)})</span></div>`);
  });
  (status.upcoming || []).forEach(e => {
    const t = new Date(e.date).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' });
    rows.push(`<div class="news-item high"><span class="news-title">🔴 ${escHtml(e.title)} (${escHtml(e.country)})</span><span class="news-time">${t} IST</span></div>`);
  });

  if (!rows.length) {
    list.innerHTML = status.cacheAt
      ? '<span class="no-patterns">No red-folder events or holidays left today.</span>'
      : '<span class="no-patterns">Loading calendar…</span>';
  } else {
    list.innerHTML = rows.join('');
  }

  if (status.cacheError) {
    list.innerHTML += `<div style="font-size:10px;color:var(--text-dim);margin-top:4px;">${escHtml(status.cacheError)}</div>`;
  }
}

function refreshNews() {
  window.api.refreshNews();
  addActionPill('Refreshing economic calendar', 'ForexFactory is rate-limited — this only works a couple of times per 5 minutes.');
}

// Draws today's remaining red-folder event times straight onto the
// TradingView chart as vertical lines — ForexFactory supplies the timing,
// the chart is just where it gets marked. Also fires automatically as part
// of markLondonLevels() on the server, so this button is mainly for a
// manual re-sync mid-session.
function markNewsOnChart() {
  window.api.markNewsOnChart();
  state._newsMarkPill = addActionPill('Marking news times');
}

// ── Live price ─────────────────────────────────────────────────────────────────
async function refreshPrice() {
  if (!state.tvConnected) return;
  try {
    const r = await window.api.mcpCall('quote_get', {});
    if (r.ok && r.result && r.result.content) {
      const text = r.result.content.map(c => c.text || '').join('');
      const pm = text.match(/last["\s:]+([0-9.,]+)/i) || text.match(/([0-9]{4,6}\.[0-9]{1,2})/);
      const cm = text.match(/change_pct["\s:]+([+-]?[0-9.]+)/i);
      if (pm) {
        const el = document.getElementById('hdr-price');
        const p  = parseFloat(pm[1].replace(',', ''));
        el.textContent = p.toLocaleString('en-US', { minimumFractionDigits: 2 });
        el.className   = 'price' + (cm ? (parseFloat(cm[1]) >= 0 ? ' up' : ' dn') : '');
      }
    }
    const cs = await window.api.mcpCall('chart_get_state', {});
    if (cs.ok && cs.result && cs.result.content) {
      const t = cs.result.content.map(c => c.text || '').join('');
      const sm = t.match(/symbol["\s:]+["']?([A-Z0-9!]+)/i);
      const tm = t.match(/(?:resolution|timeframe)["\s:]+["']?(\w+)/i);
      if (sm) document.getElementById('hdr-symbol').textContent = sm[1];
      if (tm) {
        const tfMap = { '1':'1M','5':'5M','15':'15M','60':'1H','240':'4H','D':'Daily','W':'Weekly' };
        document.getElementById('hdr-tf').textContent = tfMap[tm[1]] || tm[1];
      }
    }
  } catch {}
}

// ── Analysis parsing ───────────────────────────────────────────────────────────
function parseAnalysisFromToolResult(toolName, result) {
  if (!result) return;
  if (/ohlcv|study/i.test(toolName)) {
    const bull = /bullish|higher high|hh.*hl|uptrend/i.test(result);
    const bear = /bearish|lower low|ll.*lh|downtrend/i.test(result);
    if (bull && !bear) updateBias('bull', 'Bullish — from indicator data');
    else if (bear && !bull) updateBias('bear', 'Bearish — from indicator data');
  }
  if (/pine_lines|pine_labels/i.test(toolName)) {
    const m = result.match(/([0-9]{4,6}(?:\.[0-9]{1,2})?)/);
    if (m) {
      state.analysis.keyLevel = parseFloat(m[1]);
      document.getElementById('level-display').textContent =
        parseFloat(m[1]).toLocaleString('en-US', { minimumFractionDigits: 2 });
    }
    // Look for engulf signal in labels (chat-driven pull, assumed 1H context)
    if (/bull.*engulf|engulf.*bull/i.test(result)) {
      handleEngulfSignal({ direction: 'BULLISH', tf: '1h', tfLabel: '1H', time: nowIST(), source: 'pine label', message: 'Bullish engulfing detected in indicator label' });
    } else if (/bear.*engulf|engulf.*bear/i.test(result)) {
      handleEngulfSignal({ direction: 'BEARISH', tf: '1h', tfLabel: '1H', time: nowIST(), source: 'pine label', message: 'Bearish engulfing detected in indicator label' });
    }
  }
}

function nowIST() {
  return new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function updateBias(dir, note) {
  state.analysis.bias = dir;
  const labels = { bull: 'BULLISH', bear: 'BEARISH', neutral: 'NEUTRAL' };
  document.getElementById('bias-display').textContent = labels[dir] || 'NEUTRAL';
  document.getElementById('bias-display').className = 'bias-display ' + (dir || 'neutral');
  document.getElementById('bias-note').textContent = note;
}

function parseGoNogo(text) {
  if (!text) return;
  if (/\bGO\b/.test(text) && !/\bNO.GO\b/i.test(text)) setGoNogo('go');
  else if (/\bNO.GO\b/i.test(text)) setGoNogo('nogo');
}

function setGoNogo(s, reasons) {
  const changed = state.account.goNogo !== s;
  state.account.goNogo = s;
  const el = document.getElementById('gonogo-badge');
  el.textContent = s === 'go' ? 'GO ✓' : s === 'nogo' ? 'NO-GO ✗' : 'PENDING CHECK-IN';
  el.className = 'gonogo-badge ' + s;
  if (reasons && reasons.length) el.title = reasons.join(' · ');
  else el.removeAttribute('title');
  // Only message the chat log on an actual verdict change — avoid spamming
  // the feed every time the 30s mechanical recheck runs and nothing changed.
  if (changed && reasons) {
    addSystemMessage(`Mechanical check: ${s.toUpperCase()}${reasons.length ? ' — ' + reasons.join('; ') : ''}`);
  }
}

// ── Mechanical analysis rendering (no LLM) ──────────────────────────────────
// Fills the same BIAS / KEY LEVEL / Framework Steps panel that used to only
// update from Claude's tool calls (parseAnalysisFromToolResult), using the
// server's always-on 'mechanical-analysis' broadcast instead.
function applyMechanicalAnalysis() {
  const m = state.mechanical;
  if (m.dailyTrend && m.dailyTrend !== 'unclear') {
    const dir = m.dailyTrend === 'bullish' ? 'bull' : 'bear';
    updateBias(dir, `${m.dailyTrend === 'bullish' ? 'Bullish' : 'Bearish'} — Daily trend (mechanical, no AI)`);
  } else if (m.dailyTrend === 'unclear') {
    updateBias('neutral', 'Unclear — Daily trend (mechanical, no AI)');
  }
  if (m.keyLevel && typeof m.keyLevel.price === 'number') {
    state.analysis.keyLevel = m.keyLevel.price;
    document.getElementById('level-display').textContent =
      `${m.keyLevel.price.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${m.keyLevel.label})`;
  }
  updateFrameworkSteps();
}

function updateFrameworkSteps() {
  const m = state.mechanical;
  const set = (id, text, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'step-value' + (cls ? ' ' + cls : '');
  };

  // Step 1 — Daily bias. Now shows strength (STRONG/WEAK/NEUTRAL), not just
  // direction — added 2026-07-28 (Anoop), combines structure/body/slope.
  // Bar count is shown so a thin read is visibly thin — if it says 5 bars,
  // the chart read failed/partial and the grade is not trustworthy.
  set('step-1-val', (m.dailyLabel || (m.dailyTrend ? m.dailyTrend.toUpperCase() : '—')) + (m.dailyBars ? ` · ${m.dailyBars}b` : ''),
      m.dailyTrend === 'bullish' ? 'bull' : m.dailyTrend === 'bearish' ? 'bear' : '');

  // Step 2 — 1H aligns with Daily (Playbook A / HTF alignment rule)
  if (m.dailyTrend && m.hourTrend) {
    set('step-2-val', m.aligned ? `YES (${m.hourLabel || m.hourTrend})` : `NO (${m.hourLabel || m.hourTrend})`, m.aligned ? 'bull' : 'bear');
  } else {
    set('step-2-val', '—', '');
  }

  // Step 3 — Zone reaction: reuse the SFP monitor's pending-raid state
  const sfpVals = Object.values(state.sfp || {});
  const sfpPending = sfpVals.some(s => s && s.pending);
  const sfpRunning = sfpVals.some(s => s && s.running);
  if (sfpPending) set('step-3-val', 'Raid detected — watching for displacement', 'bull');
  else if (sfpRunning) set('step-3-val', 'Watching for raid…', '');
  else set('step-3-val', 'SFP monitor off', '');

  // Step 4 — Trigger candle: reuse the Engulf monitor's last-seen signal,
  // discarded after 2 hours so it doesn't read as "live" hours later.
  const engulf1h = state.engulf && state.engulf['1h'];
  const fresh = engulf1h && engulf1h.lastSignalAt && (Date.now() - engulf1h.lastSignalAt < 2 * 3600 * 1000);
  if (fresh) {
    set('step-4-val', engulf1h.lastBias === 'bull' ? 'Bullish engulf seen' : 'Bearish engulf seen', engulf1h.lastBias);
  } else {
    set('step-4-val', '—', '');
  }
}

// ── Session window (IST) — London 1:30–3:00 PM, NY 7:00–9:00 PM ────────────
function getSessionWindow() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (mins >= 19 * 60 && mins < 21 * 60) return 'ny';
  if (mins >= 13 * 60 + 30 && mins < 15 * 60) return 'london';
  return null;
}

// ── Mechanical GO/NO-GO gate (no LLM) ────────────────────────────────────────
// Replaces the old parseGoNogo(claudeText) regex-on-AI-text approach with
// hard rule checks against numbers already tracked client-side (state.account,
// state.news, state.mechanical). Runs on its own timer plus after any action
// that changes one of those inputs (trade logged, settings saved, mode
// switch, news update, mechanical-analysis update).
function computeMechanicalGoNogo() {
  const acc = state.account;
  const mode = state.mode;
  const session = getSessionWindow();
  const dailyStop = mode === 'eval' ? -acc.evalDayStop : -acc.fundedDayStop;
  // CHANGED 2026-07-28 (Anoop): was a hardcoded eval:2/funded:20 split, no
  // longer the rule — now 5/session, 10/day flat, same in eval and funded.
  const tradeLim  = getRules().tradesPerDay || 10;
  const breakActive = !!(acc.lastTradeTime && (Date.now() - acc.lastTradeTime < 15 * 60 * 1000));
  const newsBlackout = !!(state.news && state.news.inBlackout);
  const dayStopHit = acc.profit <= dailyStop;
  const overTradeLimit = acc.tradeCount >= tradeLim;

  // ── PRE-SESSION CHECKLIST GATE (2026-08-12, task #33) ──────────────────────
  // Until now the checklist was ADVISORY. Nothing anywhere stopped Anoop
  // trading without it — the Insights tab nagged ("do the checklist BEFORE the
  // first trade — it is 10% of your score") and that was the whole enforcement.
  //
  // On 2026-08-10 he skipped it and lost $855.50. He named it himself
  // afterwards as the thing he was supposed to do and didn't. It is the one
  // input entirely under his control, it costs ninety seconds, and it happens
  // BEFORE the first entry — which is the only moment in the whole sequence
  // where a decision is still cheap.
  //
  // So it is now a HARD reason, ranked with the daily stop. Deliberately NOT a
  // soft/pending one: soft reasons render as "PENDING CHECK-IN", which is
  // exactly the ignorable amber state that let this slide for months.
  //
  // Config, not code: rules.json → requireChecklist (default true). If this
  // ever becomes obstructive he can switch it off in one place rather than
  // deleting the enforcement, which is what actually happens to guards that
  // can't be turned off.
  const requireChecklist = getRules().requireChecklist !== false;
  let checklistDoneToday = false;
  try {
    const ckh = JSON.parse(localStorage.getItem('copilot_ck_history') || '[]');
    const t = (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10);
    checklistDoneToday = ckh.some(e => e && e.date === t);
  } catch (e) {
    // Unreadable history must not silently unlock trading — fail CLOSED.
    checklistDoneToday = false;
  }

  const m = state.mechanical;
  // ── Chart-data freshness (added 2026-08-11) ────────────────────────────────
  // Until today this function had NO notion of whether the chart read was
  // current. On 2026-08-10 TradingView dropped mid-session, state.mechanical
  // kept its last-known trends, and the badge could still say GO from a
  // pre-disconnect snapshot. Stale chart data is now a HARD block, ranked with
  // the daily stop, because "I don't know what the chart is doing" must never
  // resolve to GO. Server re-runs the read every 90s (server.js
  // mechanicalInterval), so 4 minutes tolerates two missed cycles plus slack
  // before it trips. Keep these two in sync if that interval ever changes.
  const MECH_MAX_AGE_MS = 4 * 60 * 1000;
  const mechAgeMs = (m && m.at) ? (Date.now() - Date.parse(m.at)) : Infinity;
  const mechStale = !m || !m.at || !isFinite(mechAgeMs) || mechAgeMs > MECH_MAX_AGE_MS;
  const alignedKnown = m && m.dailyTrend && m.hourTrend && !m.failed && !mechStale;
  const notAligned = alignedKnown && !m.aligned;

  const hardReasons = [];
  if (dayStopHit) hardReasons.push('Daily stop hit');
  if (overTradeLimit) hardReasons.push(`Trade limit reached (${acc.tradeCount}/${tradeLim})`);
  if (requireChecklist && !checklistDoneToday) hardReasons.push('Pre-trade checklist not completed today — Checklist tab, then ✓ PRE-TRADE DONE');

  // ── GUARDRAIL STOP BRIDGE (2026-08-16) ────────────────────────────────────
  // Until now this function had no idea the guardrail's own stop-overlay
  // (size-up while losing, size-up right after a loss, daily stop logged
  // manually) had fired — two independent systems computing "is today over"
  // with no connection between them. Acknowledging the overlay ("I am done")
  // only hides the modal, it does not clear s.stopped, so this stays a HARD
  // reason for the rest of the day exactly like the overlay itself does.
  if (typeof window.grIsStopped === 'function' && window.grIsStopped()) {
    hardReasons.push('Guardrail stop active today — size-up-after-a-loss or daily-stop pattern logged (see HUD)');
  }

  // ── CONTRACTS-PER-DAY (2026-08-12) ────────────────────────────────────────
  // A hard block, alongside the daily stop. Anoop's own logged days split on
  // total contracts: 10/11 traded green, 24/29 cost $879 and $572. Nothing
  // enforced the total before — sizeCap governs each ENTRY (2) and
  // tradesPerDay governs COUNT (10), so ten legal 2-lot trades is twenty
  // contracts with every individual trade inside the rules.
  // Reads the guardrail's own trade log (grTodayTrades), the same source the
  // HUD counts from, so the badge and the bar can never disagree.
  try {
    const vcfg = getRules().contractsPerDay || {};
    if (vcfg.enabled && window.VolumeBudget) {
      const todayTrades = (typeof window.grTodayTrades === 'function') ? window.grTodayTrades() : [];
      const used = window.VolumeBudget.contractsUsed(todayTrades);
      const vs = window.VolumeBudget.volumeStatus(used, vcfg);
      if (vs.level === 'stop') hardReasons.push(`Contract volume cap hit (${used}/${vs.cap} today)`);
    }
  } catch (e) { /* never let this throw and take the whole verdict with it */ }
  if (!state.tvConnected) hardReasons.push('TradingView disconnected — no live chart data');
  else if (m && m.failed) hardReasons.push(`Chart read failing (${m.failed})`);
  else if (mechStale) hardReasons.push(
    isFinite(mechAgeMs)
      ? `Chart data stale (${Math.round(mechAgeMs / 60000)} min old)`
      : 'No chart data yet — never read'
  );

  const softReasons = [];
  if (!session) softReasons.push('Outside session window (London 1:30–3PM / NY 7–9PM IST)');
  if (breakActive) softReasons.push('15-min break timer active');
  if (newsBlackout) softReasons.push('News blackout active');
  if (notAligned) softReasons.push(`Daily/1H bias not aligned (${m.dailyTrend}/${m.hourTrend})`);

  if (hardReasons.length) {
    setGoNogo('nogo', hardReasons);
  } else if (softReasons.length) {
    setGoNogo('pending', softReasons);
  } else if (alignedKnown) {
    setGoNogo('go', ['In session, aligned, no active blocks']);
  } else {
    setGoNogo('pending', ['Waiting on Daily/1H trend read']);
  }
}

let mechanicalGoNogoTimer = null;
function startMechanicalGoNogoTimer() {
  computeMechanicalGoNogo();
  if (mechanicalGoNogoTimer) clearInterval(mechanicalGoNogoTimer);
  mechanicalGoNogoTimer = setInterval(computeMechanicalGoNogo, 30 * 1000);
}

function tryLoadScreenshot(result) {
  const m = result.match(/screenshots[\/\\][\w\-.]+\.png/i) ||
            result.match(/([A-Za-z]:[\/\\][\w\\/\-.]+\.png)/i);
  if (m) {
    window.api.getScreenshot(m[0]).then(data => {
      if (data) {
        const img = document.getElementById('screenshot-img');
        img.src  = data;
        img.style.display = 'block';
        document.getElementById('screenshot-placeholder').style.display = 'none';
        switchTab('analysis');
      }
    });
  }
}

// ── Pattern warnings ───────────────────────────────────────────────────────────
function checkForPatternWarnings(text) {
  if (!text) return;
  const alerts = [];
  const { tradeCount, profit, mode } = { ...state.account, mode: state.mode };
  const acc = state.account;
  const dailyStop = mode === 'eval' ? -acc.evalDayStop : -acc.fundedDayStop;
  const dayWarn   = dailyStop + 50;
  const tradeLim  = mode === 'eval' ? 2     : 20;
  const dayCap    = acc.evalDayCap;
  const dayCapWarn = Math.round(dayCap * 0.93);
  const fundedTarget = acc.fundedTargetMax;

  if (profit <= dailyStop) {
    alerts.push('DAILY STOP HIT — close Tradovate NOW');
    showAlertBanner('DAILY STOP HIT — Close Tradovate immediately!', 'red');
  } else if (profit <= dayWarn) {
    alerts.push(`P&L $${profit} — approaching daily stop`);
    showAlertBanner(`P&L $${profit} — $${Math.abs(dailyStop - profit)} from daily stop`, 'amber');
  }
  if (tradeCount > tradeLim) {
    alerts.push(`Trade count ${tradeCount} — over limit (${tradeLim})`);
    showAlertBanner(`ESCALATION — ${tradeCount} trades today. Pattern 1 forming.`, 'red');
  }
  if (/MGC|gold/i.test(text) && profit < 0) {
    alerts.push('MGC mentioned after loss — Pattern 5 risk');
  }
  if (mode === 'eval' && profit >= dayCapWarn) {
    alerts.push(`CONSISTENCY CAP WARNING — approaching $${dayCap.toLocaleString()} daily limit`);
    showAlertBanner(`EVAL CAP — $${dayCap.toLocaleString()} daily limit approaching. Slow down!`, 'amber');
  }
  if (mode === 'funded' && profit >= fundedTarget) {
    showAlertBanner(`FUNDED TARGET $${fundedTarget} HIT — consider stopping for today`, 'green');
  }

  renderPatterns(alerts);
}

function renderPatterns(alerts) {
  const list = document.getElementById('pattern-list');
  list.innerHTML = alerts.length
    ? alerts.map(a => `<div class="pattern-alert">${escHtml(a)}</div>`).join('')
    : '<span class="no-patterns">All clear</span>';
}

// ── Alert banner ───────────────────────────────────────────────────────────────
let bannerTimer;
function showAlertBanner(text, type = 'red') {
  const b = document.getElementById('alert-banner');
  b.textContent = text;
  b.className   = 'visible' + (type === 'amber' ? ' amber-banner' : type === 'green' ? ' green-banner' : '');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.className = ''; }, type === 'green' ? 5000 : 8000);
}

// ── Account UI ─────────────────────────────────────────────────────────────────
function updateAccountUI() {
  const acc = state.account;
  const fundedBuffer = acc.balance - acc.fundedFloor;
  const evalBuffer   = acc.balance - acc.evalFloor;
  const buffer = state.mode === 'eval' ? evalBuffer : fundedBuffer;
  // BUG FIX 2026-07-25: this was hardcoded 4500/2000 — the 150K eval's max loss
  // and the 50K funded's buffer. On a 50K EVAL (max loss $2,000) the drawdown
  // bar was scaled against $4,500, so it under-reported how close the floor was.
  // Now read from the ACTIVE account's own profile.
  const _prof = ACCOUNT_PROFILES[state.accountSize][state.mode];
  const mllSize = state.mode === 'eval' ? _prof.maxLoss : _prof.floorBuffer;

  // 2026-07-25: recompute balance/floor/target from the LEDGER before painting.
  // See enforceAccountInvariant() — the ledger is the only auditable source, so
  // if storage and ledger disagree the ledger wins. This is what makes the
  // numbers self-healing rather than dependent on clearing every cache.
  if (typeof enforceAccountInvariant === 'function') enforceAccountInvariant();
  const mllPct = Math.max(0, Math.min(100, ((mllSize - buffer) / mllSize) * 100));

  // 2026-08-17: "● " prefix when today's balance is live-derived (no CSV
  // uploaded yet today) — same visual language as the bottom HUD's own
  // "● LIVE ·" tag, so a live-vs-CSV number is never presented as identical
  // in confidence to a CSV-confirmed one.
  const balPrefix = acc.balanceSource === 'live' ? '● ' : '';
  const balTitle = acc.balanceSource === 'live'
    ? 'Live estimate from the TradingView broker feed — no CSV uploaded for today yet. Upload a CSV to lock in the commission-accurate number.'
    : 'From your uploaded CSV ledger.';

  // Funded rows
  { const el = document.getElementById('stat-balance-funded'); el.textContent = balPrefix + '$' + acc.balance.toLocaleString(); el.title = balTitle; }
  document.getElementById('stat-floor-funded').textContent   = '$' + acc.fundedFloor.toLocaleString();
  document.getElementById('stat-buffer-funded').textContent  = '$' + fundedBuffer.toLocaleString();
  document.getElementById('stat-payout').textContent         = '$' + acc.payoutTarget.toLocaleString();
  document.getElementById('stat-daystop-funded').textContent = '−$' + acc.fundedDayStop.toLocaleString() + ' HARD';
  document.getElementById('stat-daytarget-funded').textContent =
    '$' + acc.fundedTargetMin.toLocaleString() + '–$' + acc.fundedTargetMax.toLocaleString();

  // Eval rows
  { const el = document.getElementById('stat-balance-eval'); el.textContent = balPrefix + '$' + acc.balance.toLocaleString(); el.title = balTitle; }
  document.getElementById('stat-floor-eval').textContent     = '$' + acc.evalFloor.toLocaleString();
  { const be = document.getElementById('stat-buffer-eval'); if (be) be.textContent = '$' + evalBuffer.toLocaleString(); }
  document.getElementById('stat-daycap-eval').textContent    = '$' + acc.evalDayCap.toLocaleString() + ' MAX';
  document.getElementById('stat-daystop-eval').textContent   = '−$' + acc.evalDayStop.toLocaleString();
  // 2026-07-25 (Anoop): in EVAL this row is the TARGET to clear (e.g. $53,000
  // on a 50K), not "remaining to target". Was also hardcoded to the 150K
  // fallback (159000) whenever evalTarget was missing — now derived from the
  // active profile so a 50K never shows a 150K number.
  const remEl = document.getElementById('stat-remaining-eval');
  const evalTarget = acc.evalTarget || (_prof.startBalance + (_prof.target || 0));
  if (remEl) remEl.textContent = '$' + evalTarget.toLocaleString();

  const pnlEl = document.getElementById('stat-pnl');
  pnlEl.textContent  = (acc.profit >= 0 ? '+' : '') + '$' + acc.profit;
  pnlEl.className    = 'stat-value ' + (acc.profit > 0 ? 'green' : acc.profit < 0 ? 'red' : '');

  document.getElementById('stat-trades').textContent = String(acc.tradeCount);
  updateSizeDisplay();

  const bar = document.getElementById('buffer-bar');
  bar.style.width = mllPct + '%';
  bar.className   = 'progress-fill' + (mllPct > 75 ? ' danger' : mllPct > 50 ? ' warn' : '');

  buildTradePips(acc.tradeCount);
  // Keep the Ladder tab synced to whichever account is active — it used to
  // only redraw on tab click, so switching accounts left it showing the
  // previous account's frozen numbers until you clicked away and back.
  if (typeof renderLadder === 'function') renderLadder();
}

function updateRulesTab() {
  const acc = state.account;
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

  set('rules-floor-eval',    '$' + acc.evalFloor.toLocaleString() + ' (trails)');
  set('rules-daycap-eval',   '$' + acc.evalDayCap.toLocaleString() + ' MAX (consistency)');
  set('rules-daystop-eval',  '−$' + acc.evalDayStop.toLocaleString() + ' → done');

  set('rules-floor-funded',   '$' + acc.fundedFloor.toLocaleString() + ' (EOD trailing)');
  set('rules-daystop-funded', '−$' + acc.fundedDayStop.toLocaleString() + ' → CLOSE TRADOVATE');
  set('rules-daytarget-funded', '$' + acc.fundedTargetMin.toLocaleString() + '–$' + acc.fundedTargetMax.toLocaleString());
  set('rules-payout-funded', 'Balance ≥$' + acc.payoutTarget.toLocaleString());
}

function updateSizeDisplay() {
  const size = state.mode === 'eval'
    ? '6 micros'
    : getSizeFromProfit(state.account.profit);
  document.getElementById('stat-size').textContent = size;
}

function buildTradePips(count) {
  const max = state.mode === 'eval' ? 2 : 10;
  const limit = state.mode === 'eval' ? 2 : 20;
  document.getElementById('trade-pips').innerHTML = Array.from({ length: max }, (_, i) => {
    let cls = 'trade-pip';
    if (i < Math.min(count, max)) cls += count >= limit ? ' limit' : ' used';
    return `<div class="${cls}"></div>`;
  }).join('');
}

// ── Break timer ────────────────────────────────────────────────────────────────
let breakTimer;
function startBreakTimer() {
  clearInterval(breakTimer);
  const end = Date.now() + 15 * 60 * 1000;
  const el  = document.getElementById('stat-break');
  breakTimer = setInterval(() => {
    const rem = end - Date.now();
    if (rem <= 0) {
      clearInterval(breakTimer);
      el.textContent   = 'Break done ✓';
      el.style.color   = 'var(--green)';
      addSystemMessage('15-minute break complete. You may take the next trade when setup confirms.');
      return;
    }
    const m = Math.floor(rem / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    el.textContent = `${m}:${String(s).padStart(2,'0')} left`;
    el.style.color = rem < 120000 ? 'var(--green)' : 'var(--amber)';
  }, 1000);
}

// ── Trade logging ──────────────────────────────────────────────────────────────
async function logTradeForm() {
  const dir    = document.getElementById('f-dir').value;
  const entry  = parseFloat(document.getElementById('f-entry').value);
  const stop   = parseFloat(document.getElementById('f-stop').value);
  const target = parseFloat(document.getElementById('f-target').value);
  const pnlRaw = document.getElementById('f-pnl').value;
  const pnl    = pnlRaw ? parseFloat(pnlRaw) : undefined;

  if (!entry || !stop || !target) {
    addSystemMessage('Please fill in Entry, Stop, and Target.');
    return;
  }

  const result = await window.api.logTrade({ direction: dir, entry, stop, target, pnl });
  const num = result ? result.num : state.trades.length + 1;

  state.account.tradeCount++;
  if (pnl !== undefined) state.account.profit += pnl;
  state.trades.push({ num, direction: dir, entry, stop, target, pnl });
  state.account.lastTradeTime = Date.now();

  updateAccountUI();
  renderTrades();
  startBreakTimer();
  computeMechanicalGoNogo();

  ['f-entry','f-stop','f-target','f-pnl'].forEach(id => {
    document.getElementById(id).value = '';
  });

  addSystemMessage(`Trade #${num} logged. 15-min break timer started.`);

  // CHANGED 2026-07-28 (Anoop): flat 5/session, 10/day rule replacing the old
  // eval:2/funded:5 split — same caution/hard structure in both modes now.
  const cautionLim = getRules().tradesPerSession || 5;
  const hardLim = getRules().tradesPerDay || 10;
  if (state.account.tradeCount > hardLim) {
    addPatternAlert(`${state.account.tradeCount} trades — over the daily cap`);
    showAlertBanner(`${state.account.tradeCount} trades today — HARD CAP ${hardLim}/day (${cautionLim}/session) reached`, 'red');
  } else if (state.account.tradeCount > cautionLim) {
    addPatternAlert(`${state.account.tradeCount} trades — escalation risk`);
    showAlertBanner(`${state.account.tradeCount} trades today — caution, cap is ${cautionLim}/session, ${hardLim}/day`, 'amber');
  }

  // Auto-review with Claude
  const summary = `Trade #${num} logged: ${dir} entry ${entry}, stop ${stop}, target ${target}${pnl !== undefined ? ', P&L $' + pnl : ' (open)'}. Quickly verify this trade followed the entry framework for ${state.mode.toUpperCase()} mode. Was 15-min break respected?`;
  state.messages.push({ role: 'user', content: summary });
  setStreaming(true);
  startNewAssistantBubble();
  window.api.sendChat([buildContextMessage(), ...state.messages])
    .catch(() => setStreaming(false));
}

function addPatternAlert(text) {
  const list = document.getElementById('pattern-list');
  const noP  = list.querySelector('.no-patterns');
  if (noP) noP.remove();
  const d = document.createElement('div');
  d.className = 'pattern-alert';
  d.textContent = text;
  list.prepend(d);
}

function renderTrades() {
  const list = document.getElementById('trade-list');
  if (!state.trades.length) {
    list.innerHTML = '<div class="no-trades">No trades logged today</div>';
    return;
  }
  list.innerHTML = state.trades.map(t => `
    <div class="trade-card">
      <div class="trade-num">Trade #${t.num}</div>
      <div class="trade-dir ${t.direction === 'LONG' ? 'long' : 'short'}">${t.direction}</div>
      <div style="font-size:11px;color:var(--text-dim);margin:2px 0;">
        E: ${t.entry} · SL: ${t.stop} · TP: ${t.target}
      </div>
      ${t.pnl !== undefined
        ? `<div class="trade-pnl ${t.pnl >= 0 ? 'pos' : 'neg'}">${t.pnl >= 0 ? '+' : ''}$${t.pnl}</div>`
        : '<div style="color:var(--text-dim);font-size:11px;">Open</div>'}
    </div>`).join('');
}

// ── Sessions ───────────────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const sessions = await window.api.listSessions();
    renderSessionList(sessions || []);
  } catch {}
}

function renderSessionList(sessions) {
  const today = new Date().toISOString().slice(0, 10);
  const list  = document.getElementById('session-list');
  if (!sessions.length) { list.innerHTML = '<div class="no-trades">No logs yet</div>'; return; }
  list.innerHTML = sessions.map(f => {
    const date = f.replace('.md', '');
    return `<div class="session-item" onclick="viewSession('${date}')">
      <span class="session-date">${fmtDMY(date)}</span>
      ${date === today ? '<span class="session-tag today">TODAY</span>' : ''}
    </div>`;
  }).join('');
}

async function viewSession(date) {
  const content = await window.api.readSession(date);
  if (!content) return;
  addSystemMessage(`Session ${fmtDMY(date)}:\n${content.slice(0, 800)}${content.length > 800 ? '…' : ''}`);
  switchTab('sessions');
}

// ── Tabs ───────────────────────────────────────────────────────────────────────
function switchTab(tabId) {
  // 2026-08-13 checklist gate. Wrapped in its own try/catch and placed BEFORE
  // any DOM mutation: if this throws, we fall through and switch the tab
  // normally. switchTab() previously had no error handling at all, so a throw
  // in here would have left every panel hidden with no way back — the same
  // silent-failure class as the ckPlanRead recursion, except this one would
  // brick the UI mid-session instead of degrading quietly.
  try {
    if (typeof ckGateIsOpen === 'function' && CK_GATED_TABS.indexOf(tabId) !== -1 && !ckGateIsOpen()) {
      switchTab('checklist');
      const hint = document.getElementById('ck-gate-hint');
      if (hint) {
        hint.style.display = 'block';
        hint.textContent = 'The ' + tabId.toUpperCase() + ' tab unlocks once the pre-trade checklist is done. Chat stays open — ask Jessi to help you finish it.';
        setTimeout(() => { try { hint.style.display = 'none'; } catch (e) {} }, 6000);
      }
      return;
    }
  } catch (e) { /* fail OPEN — never trap the user in a locked panel */ }

  document.querySelectorAll('.rtab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('#right-content > div').forEach(d => {
    d.style.display = d.id === 'tab-' + tabId ? '' : 'none';
  });
  if (tabId === 'ladder')   renderLadder();
  if (tabId === 'checklist') ckLoadPlan();
  if (tabId === 'insights') renderInsights();
  if (tabId === 'apprentice') renderPlanStageBanner();
  if (tabId === 'lessons') renderLessons();
  if (tabId === 'align')   renderAlignment();
  if (tabId === 'cost') renderCost();
  if (tabId === 'journal') renderJournal();
}

// ── Cost tab: lifetime prop-account spend vs payouts -> breakeven ───────────
// Durable ledger in data/account_fees.json. Fees = every prop account bought;
// payouts = every payout received. Net = payouts - fees; breakeven when net >= 0.
let COST_STATE = null;

function costMoney(n) {
  const s = Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (Number(n) < 0 ? '-$' : '$') + s;
}
// Display-only date formatter — added 2026-07-22 per Anoop: dates render as
// D/M/YYYY (no zero-padding, e.g. 4/2/2026) everywhere in the UI. Storage,
// sorting (.sort/.localeCompare on 'YYYY-MM-DD' strings), filtering, and
// object-key uses of .date must keep the raw ISO string — lexicographic sort
// only works in ISO order. Only call this at the point of rendering to the
// user, never on a value that flows back into a comparison, filter, or key.
function fmtDMY(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return dateStr;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  const [, y, mo, d] = m;
  return `${parseInt(d, 10)}/${parseInt(mo, 10)}/${y}`;
}
// Short form (no year) for compact per-row headings that previously used
// .slice(5) on the ISO string to get 'MM-DD' — same D/M order, just no year.
function fmtDM(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return dateStr;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  const [, , mo, d] = m;
  return `${parseInt(d, 10)}/${parseInt(mo, 10)}`;
}

function costEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function costLoad() {
  if (COST_STATE) return COST_STATE;
  let data = null;
  try { if (window.api && window.api.dataLoad) data = await window.api.dataLoad('account_fees'); } catch (e) {}
  if (!data || typeof data !== 'object') data = { meta: {}, fees: [], payouts: [] };
  data.fees = Array.isArray(data.fees) ? data.fees : [];
  data.payouts = Array.isArray(data.payouts) ? data.payouts : [];
  data.meta = data.meta || {};
  COST_STATE = data;
  return data;
}
async function costPersist() {
  if (!COST_STATE) return;
  COST_STATE.meta.updated = new Date().toISOString().slice(0, 10);
  try { if (window.api && window.api.dataSave) await window.api.dataSave('account_fees', COST_STATE); } catch (e) {}
}

// Links accountBreached()/accountClearedToFunded() to the Cost tab's fee
// ledger so a breach/clear in the Insights tab is reflected there too,
// without either tab having to be open. Matching is heuristic (no fee row
// stores a direct accountId link today): prefer a ref that appears inside
// ACCOUNT_PROFILES' accountId string, else fall back to same firm (assumed
// Lucid — every account on file is) + same size digits + not already
// resolved (blown/passed). If nothing matches, don't fabricate a $ figure —
// report back so the caller can tell Anoop to link/add it by hand.
async function costMarkAccountFeeStatus(size, stage, newStatus, archiveId) {
  const d = await costLoad();
  const prof = ACCOUNT_PROFILES[size][stage];
  const sizeDigits = String(size).replace(/[^0-9]/g, '');
  let fee = null;
  if (prof.accountId) {
    fee = d.fees.find(f => f.ref && prof.accountId.indexOf(String(f.ref).replace('#', '')) >= 0);
  }
  if (!fee) {
    fee = d.fees.find(f =>
      String(f.firm || '').toLowerCase() === 'lucid' &&
      String(f.size || '').replace(/[^0-9]/g, '') === sizeDigits &&
      f.status !== 'blown' && f.status !== 'passed'
    );
  }
  if (!fee) return { matched: false };
  fee.status = newStatus;
  fee.breachArchiveId = archiveId || fee.breachArchiveId || null;
  const tag = 'Auto-marked ' + newStatus.toUpperCase() + ' via app on ' + new Date().toISOString().slice(0, 10);
  fee.note = fee.note ? (fee.note + ' · ' + tag) : tag;
  await costPersist();
  if (document.getElementById('cost-body')) renderCost();
  return { matched: true, fee };
}
function costMarkAccountBreached(size, stage, archiveId) { return costMarkAccountFeeStatus(size, stage, 'blown', archiveId); }
function costMarkAccountPassed(size, stage, archiveId) { return costMarkAccountFeeStatus(size, stage, 'passed', archiveId); }
function costMarkAccountPaidOut(size, stage, archiveId) { return costMarkAccountFeeStatus(size, stage, 'paid_out', archiveId); }

// 2026-08-13 (Anoop): "gather all the information of all the accounts and
// make one database to analyse." Rebuilds DATA/account_database.json
// server-side (account-db.js) from every slot's own files, then shows the
// summary right here — no need to open the file to see it worked.
async function accountDbRebuildAndShow() {
  const btn = document.getElementById('account-db-rebuild-btn');
  const out = document.getElementById('account-db-summary');
  if (btn) { btn.disabled = true; btn.textContent = 'Rebuilding…'; }
  try {
    const res = await window.api.accountDbRebuild();
    if (out) {
      out.style.display = 'block';
      out.textContent = res && res.ok
        ? res.summary
        : 'Rebuild failed: ' + ((res && res.error) || 'unknown error');
    }
    if (res && res.ok && typeof addSystemMessage === 'function') {
      addSystemMessage('📊 Account report ready — opened in a new tab, and saved to DATA/account_report.html + account_trades.csv + account_database.json (' + res.db.summary.totalAccounts + ' accounts, ' + res.db.summary.totalTrades + ' trades combined).');
    }
    // 2026-08-13 (Anoop: "why is the data unreadable to a normal person"):
    // open the HTML report directly — no download, no file to go find, it's
    // just readable right there the moment he clicks the button.
    if (res && res.ok && res.html) {
      try {
        const blob = new Blob([res.html], { type: 'text/html;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) { console.error('Report open failed:', e.message); }
    }
    // Also trigger a real download of the CSV, for anyone who wants the raw
    // rows in Excel specifically — lands straight in Downloads.
    if (res && res.ok && res.csv) {
      try {
        const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'mnq-copilot-all-trades-' + ckToday() + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) { console.error('CSV download failed:', e.message); }
    }
  } catch (e) {
    if (out) { out.style.display = 'block'; out.textContent = 'Rebuild failed: ' + e.message; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Rebuild database'; }
  }
}

async function renderCost() {
  const el = document.getElementById('cost-body');
  if (!el) return;
  const d = await costLoad();

  const totalFees = d.fees.reduce((s, f) => s + (Number(f.cost) || 0), 0);
  const totalPayouts = d.payouts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const net = totalPayouts - totalFees;
  const toBreakeven = Math.max(0, totalFees - totalPayouts);
  const bought = d.fees.length;
  const blown = d.fees.filter(f => (f.status || '') === 'blown').length;
  const active = d.fees.filter(f => (f.status || '') === 'active' || (f.status || '') === 'funded').length;
  const unconfirmed = d.fees.filter(f => f.confirmed === false).length;

  const netColor = net >= 0 ? 'var(--good,#3fb950)' : 'var(--bad,#f85149)';

  const card = (label, value, color) =>
    `<div style="flex:1;min-width:120px;background:var(--panel-2,#161b22);border:1px solid var(--border,#30363d);border-radius:10px;padding:12px 14px;">
       <div style="font-size:11px;color:var(--text-dim,#8b949e);text-transform:uppercase;letter-spacing:.04em;">${label}</div>
       <div style="font-size:20px;font-weight:700;margin-top:4px;color:${color || 'var(--text,#e6edf3)'};">${value}</div>
     </div>`;

  let html = '';
  html += `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
      ${card('Total spent', costMoney(totalFees), 'var(--bad,#f85149)')}
      ${card('Payouts received', costMoney(totalPayouts), totalPayouts > 0 ? 'var(--good,#3fb950)' : null)}
      ${card('Net position', costMoney(net), netColor)}
      ${card('To breakeven', toBreakeven > 0 ? costMoney(toBreakeven) : 'REACHED', toBreakeven > 0 ? null : 'var(--good,#3fb950)')}
    </div>`;

  html += `<div style="font-size:12px;color:var(--text-dim,#8b949e);margin-bottom:10px;line-height:1.5;">
      <b style="color:var(--text,#e6edf3);">${bought}</b> accounts bought · <b>${blown}</b> blown${active ? ` · <b>${active}</b> active` : ''} · <b>${d.payouts.length}</b> payouts.
      ${unconfirmed ? `<span style="color:var(--warn,#d29922);"> ⚠ ${unconfirmed} fee${unconfirmed > 1 ? 's' : ''} unconfirmed — totals will move once set.</span>` : ''}
    </div>`;

  // Fees table
  html += `<div style="font-weight:600;margin:14px 0 6px;">Accounts bought</div>`;
  html += `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="text-align:left;color:var(--text-dim,#8b949e);border-bottom:1px solid var(--border,#30363d);">
        <th style="padding:5px 6px;">Date</th><th style="padding:5px 6px;">Firm</th><th style="padding:5px 6px;">Size</th>
        <th style="padding:5px 6px;">Ref</th><th style="padding:5px 6px;text-align:right;">Cost</th>
        <th style="padding:5px 6px;">Status</th><th></th></tr></thead><tbody>`;
  d.fees.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach(f => {
    const st = f.status || 'blown';
    const stColor = st === 'blown' ? 'var(--bad,#f85149)' : (st === 'active' || st === 'funded') ? 'var(--good,#3fb950)' : 'var(--text-dim,#8b949e)';
    html += `<tr style="border-bottom:1px solid var(--border,#21262d);">
        <td style="padding:5px 6px;white-space:nowrap;">${costEsc(fmtDMY(f.date))}</td>
        <td style="padding:5px 6px;">${costEsc(f.firm)}</td>
        <td style="padding:5px 6px;">${costEsc(f.size)}</td>
        <td style="padding:5px 6px;color:var(--text-dim,#8b949e);">${costEsc(f.ref)}</td>
        <td style="padding:5px 6px;text-align:right;white-space:nowrap;">${costMoney(f.cost)}${f.confirmed === false ? ' <span style="color:var(--warn,#d29922);" title="Unconfirmed fee">?</span>' : ''}</td>
        <td style="padding:5px 6px;"><span onclick="costCycleStatus('${costEsc(f.id)}')" style="cursor:pointer;color:${stColor};" title="Click to change status">${st}</span></td>
        <td style="padding:5px 6px;text-align:right;"><span onclick="costRemoveFee('${costEsc(f.id)}')" style="cursor:pointer;color:var(--text-dim,#8b949e);" title="Remove">✕</span></td>
      </tr>`;
  });
  html += `</tbody></table></div>`;

  // Payouts table
  html += `<div style="font-weight:600;margin:16px 0 6px;">Payouts received</div>`;
  if (!d.payouts.length) {
    html += `<div class="no-trades" style="padding:8px 0;">None yet. $0 across ${bought} accounts.</div>`;
  } else {
    html += `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="text-align:left;color:var(--text-dim,#8b949e);border-bottom:1px solid var(--border,#30363d);">
          <th style="padding:5px 6px;">Date</th><th style="padding:5px 6px;">Account</th>
          <th style="padding:5px 6px;text-align:right;">Amount</th><th></th></tr></thead><tbody>`;
    d.payouts.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach((p, i) => {
      html += `<tr style="border-bottom:1px solid var(--border,#21262d);">
          <td style="padding:5px 6px;white-space:nowrap;">${costEsc(fmtDMY(p.date))}</td>
          <td style="padding:5px 6px;">${costEsc(p.account || '')}</td>
          <td style="padding:5px 6px;text-align:right;color:var(--good,#3fb950);">${costMoney(p.amount)}</td>
          <td style="padding:5px 6px;text-align:right;"><span onclick="costRemovePayout(${i})" style="cursor:pointer;color:var(--text-dim,#8b949e);" title="Remove">✕</span></td>
        </tr>`;
    });
    html += `</tbody></table></div>`;
  }

  // Add controls
  const inp = 'background:var(--panel,#0d1117);border:1px solid var(--border,#30363d);border-radius:6px;color:var(--text,#e6edf3);padding:5px 7px;font-size:12px;';
  const btn = 'background:var(--accent,#1f6feb);border:none;border-radius:6px;color:#fff;padding:6px 12px;font-size:12px;cursor:pointer;';
  html += `<div style="margin-top:18px;padding-top:12px;border-top:1px solid var(--border,#30363d);">
      <div style="font-weight:600;margin-bottom:6px;">＋ Bought a new account</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
        <input id="cf-date" type="date" style="${inp}">
        <input id="cf-firm" placeholder="Firm (Lucid)" style="${inp}width:100px;">
        <input id="cf-size" placeholder="Size (150K)" style="${inp}width:80px;">
        <input id="cf-ref"  placeholder="Ref / key" style="${inp}width:110px;">
        <input id="cf-cost" type="number" step="0.01" placeholder="Cost $" style="${inp}width:90px;">
        <button style="${btn}" onclick="costAddFee()">Add account</button>
      </div>
    </div>`;
  html += `<div style="margin-top:14px;">
      <div style="font-weight:600;margin-bottom:6px;">＋ Received a payout</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
        <input id="cp-date" type="date" style="${inp}">
        <input id="cp-acct" placeholder="Account" style="${inp}width:130px;">
        <input id="cp-amt"  type="number" step="0.01" placeholder="Amount $" style="${inp}width:100px;">
        <button style="${btn}" onclick="costAddPayout()">Add payout</button>
      </div>
    </div>`;

  if (d.meta && d.meta.feeDiscrepancyNote) {
    html += `<div style="margin-top:14px;font-size:11px;color:var(--text-dim,#8b949e);line-height:1.5;border-top:1px dashed var(--border,#30363d);padding-top:10px;">${costEsc(d.meta.feeDiscrepancyNote)}</div>`;
  }

  el.innerHTML = html;
}

async function costAddFee() {
  const g = id => (document.getElementById(id) || {}).value || '';
  const cost = parseFloat(g('cf-cost'));
  const fee = {
    id: 'fee-' + Date.now(),
    date: g('cf-date') || new Date().toISOString().slice(0, 10),
    firm: g('cf-firm').trim() || '—',
    size: g('cf-size').trim() || '—',
    ref: g('cf-ref').trim() || '',
    cost: isNaN(cost) ? 0 : cost,
    status: 'active',
    confirmed: !isNaN(cost),
    note: ''
  };
  const d = await costLoad();
  d.fees.push(fee);
  await costPersist();
  renderCost();
}
async function costAddPayout() {
  const g = id => (document.getElementById(id) || {}).value || '';
  const amt = parseFloat(g('cp-amt'));
  if (isNaN(amt) || amt <= 0) { alert('Enter a payout amount.'); return; }
  const d = await costLoad();
  d.payouts.push({ date: g('cp-date') || new Date().toISOString().slice(0, 10), account: g('cp-acct').trim(), amount: amt });
  await costPersist();
  renderCost();
}
async function costCycleStatus(id) {
  const d = await costLoad();
  const f = d.fees.find(x => x.id === id);
  if (!f) return;
  const order = ['active', 'blown', 'funded', 'passed'];
  const i = order.indexOf(f.status || 'blown');
  f.status = order[(i + 1) % order.length];
  await costPersist();
  renderCost();
}
async function costRemoveFee(id) {
  const d = await costLoad();
  d.fees = d.fees.filter(x => x.id !== id);
  await costPersist();
  renderCost();
}
async function costRemovePayout(i) {
  const d = await costLoad();
  d.payouts.splice(i, 1);
  await costPersist();
  renderCost();
}

// ── Roadmap tab: "you are here" stage banner ────────────────────────────────
function renderPlanStageBanner() {
  const el = document.getElementById('plan-stage-banner');
  if (!el) return;
  const START = new Date('2026-07-17T00:00:00');
  const today = new Date();
  const day = Math.max(1, Math.floor((today - START) / 86400000) + 1);
  const stages = [
    { from: 1,  to: 21, label: 'Stage 1: One Clean Rep' },
    { from: 22, to: 50, label: 'Stage 2: Size the Winner, Not the Ego' },
    { from: 51, to: 90, label: 'Stage 3: Funded Is a Different Sport' },
  ];
  if (day > 90) {
    el.innerHTML = `<div><b>Day ${day} of 90</b> <span class="psb-sub">— apprenticeship window closed, review complete</span></div>`;
    return;
  }
  const stage = stages.find(s => day >= s.from && day <= s.to) || stages[0];
  const daysLeft = stage.to - day + 1;
  el.innerHTML = `<div><b>Day ${day} of 90</b> · ${stage.label}</div><div class="psb-sub">${daysLeft} day${daysLeft === 1 ? '' : 's'} left in this stage</div>`;
}

// ── Settings ───────────────────────────────────────────────────────────────────
async function loadSettings() {
  const cfg = await window.api.getConfig();
  if (!cfg) { openSettings(); return; }
  if (!cfg.apiKey) {
    addSystemMessage('Running without an Anthropic API key — mechanical monitors (1H Engulf, FVG, SFP) and manual chart tools are live. AI chat/analysis is off until a key is added in Settings (⚙).');
  }
  applyConfig(cfg);
}

function openSettings() {
  const acc = state.account;
  window.api.getConfig().then(cfg => {
    cfg = cfg || {};
    const val = (id, cfgKey, fallback) => {
      document.getElementById(id).value = cfg[cfgKey] !== undefined ? cfg[cfgKey] : fallback;
    };
    if (cfg.apiKey) document.getElementById('settings-api-key').value = cfg.apiKey;
    if (cfg.groqApiKey) document.getElementById('settings-groq-key').value = cfg.groqApiKey;
    { const gk = document.getElementById('settings-gemini-key'); if (gk && cfg.geminiApiKey) gk.value = cfg.geminiApiKey; }
    { const ork = document.getElementById('settings-omniroute-key'); if (ork && cfg.omniRouteApiKey) ork.value = cfg.omniRouteApiKey; }
    { const oru = document.getElementById('settings-omniroute-url'); if (oru) oru.value = cfg.omniRouteBaseUrl || 'http://localhost:20128'; }
    { const dor = document.getElementById('settings-disable-omniroute'); if (dor) dor.checked = !!cfg.disableOmniRoute; }
    { const vb = document.getElementById('settings-voice-brain'); if (vb) vb.value = cfg.voiceBrain || 'gemini'; }
    { const vn = document.getElementById('settings-voice-name'); if (vn) vn.value = cfg.edgeVoice || 'en-IN-NeerjaNeural'; }
    val('settings-balance', 'balance', acc.balance);
    val('settings-profit',  'profit',  acc.profit);

    val('settings-funded-floor',     'fundedFloor',     acc.fundedFloor);
    val('settings-funded-daystop',   'fundedDayStop',   acc.fundedDayStop);
    val('settings-funded-targetmin', 'fundedTargetMin', acc.fundedTargetMin);
    val('settings-funded-targetmax', 'fundedTargetMax', acc.fundedTargetMax);
    val('settings-payout',           'payoutTarget',    acc.payoutTarget);

    val('settings-eval-floor',   'evalFloor',   acc.evalFloor);
    val('settings-eval-daycap',  'evalDayCap',  acc.evalDayCap);
    val('settings-eval-daystop', 'evalDayStop', acc.evalDayStop);

    if (cfg.telegramBotToken) document.getElementById('settings-telegram-token').value = cfg.telegramBotToken;
    document.getElementById('settings-telegram-chatid').value = cfg.telegramChatId !== undefined ? cfg.telegramChatId : '';
    document.getElementById('settings-tv-enabled').checked = !!cfg.tvEnabled;
    val('settings-tv-env', 'tvEnv', 'demo');
    val('settings-tv-name', 'tvName', '');
    if (cfg.tvPassword) document.getElementById('settings-tv-password').value = cfg.tvPassword;
    val('settings-tv-appid', 'tvAppId', 'MNQ Co-Pilot');
    val('settings-tv-cid', 'tvCid', '');
    if (cfg.tvSec) document.getElementById('settings-tv-sec').value = cfg.tvSec;
    { const dto = document.getElementById('settings-disable-token-opt'); if (dto) dto.checked = !!cfg.disableTokenOpt; }
  });
  document.getElementById('settings-overlay').className = 'visible';
}

function closeSettings() {
  document.getElementById('settings-overlay').className = '';
}

async function saveSettings() {
  const acc = state.account;
  const num = (id, fallback) => parseFloat(document.getElementById(id).value) || fallback;

  const apiKey  = document.getElementById('settings-api-key').value.trim();
  const groqApiKey = document.getElementById('settings-groq-key').value.trim();
  const geminiKeyEl = document.getElementById('settings-gemini-key');
  const geminiApiKey = geminiKeyEl ? geminiKeyEl.value.trim() : '';
  const omniRouteKeyEl = document.getElementById('settings-omniroute-key');
  const omniRouteApiKey = omniRouteKeyEl ? omniRouteKeyEl.value.trim() : '';
  const omniRouteUrlEl = document.getElementById('settings-omniroute-url');
  const omniRouteBaseUrl = omniRouteUrlEl ? omniRouteUrlEl.value.trim() : '';
  const voiceBrainEl = document.getElementById('settings-voice-brain');
  const voiceBrain = voiceBrainEl ? voiceBrainEl.value : 'gemini';
  const voiceNameEl = document.getElementById('settings-voice-name');
  const edgeVoice = voiceNameEl ? voiceNameEl.value : 'en-IN-NeerjaNeural';
  const balance = num('settings-balance', 50000);
  const profit  = num('settings-profit', 0);

  const fundedFloor     = num('settings-funded-floor', acc.fundedFloor);
  const fundedDayStop   = num('settings-funded-daystop', acc.fundedDayStop);
  const fundedTargetMin = num('settings-funded-targetmin', acc.fundedTargetMin);
  const fundedTargetMax = num('settings-funded-targetmax', acc.fundedTargetMax);
  const payoutTarget    = num('settings-payout', acc.payoutTarget);

  const evalFloor   = num('settings-eval-floor', acc.evalFloor);
  const evalDayCap  = num('settings-eval-daycap', acc.evalDayCap);
  const evalDayStop = num('settings-eval-daystop', acc.evalDayStop);

  const telegramBotToken = document.getElementById('settings-telegram-token').value.trim();
  const telegramChatId   = document.getElementById('settings-telegram-chatid').value.trim();

  const cfgEntries = {
    apiKey, groqApiKey, geminiApiKey, omniRouteApiKey, omniRouteBaseUrl, voiceBrain, edgeVoice, balance, profit,
    fundedFloor, fundedDayStop, fundedTargetMin, fundedTargetMax, payoutTarget,
    evalFloor, evalDayCap, evalDayStop
  };
  for (const [key, value] of Object.entries(cfgEntries)) {
    await window.api.setConfig(key, value);
  }

  // Telegram fields are strings, not numbers — kept out of cfgEntries' num()
  // pattern. Chat ID is optional and auto-fills on first bot message, so we
  // only push it here if the user actually typed one (leaving it blank does
  // NOT erase an already-claimed chat id).
  await window.api.setConfig('telegramBotToken', telegramBotToken);
  if (telegramChatId) await window.api.setConfig('telegramChatId', telegramChatId);

  // Tradovate live-feed credentials (strings; enable flag set last so the server (re)starts the feed).
  await window.api.setConfig('tvEnv', document.getElementById('settings-tv-env').value);
  await window.api.setConfig('tvName', document.getElementById('settings-tv-name').value.trim());
  await window.api.setConfig('tvPassword', document.getElementById('settings-tv-password').value);
  await window.api.setConfig('tvAppId', document.getElementById('settings-tv-appid').value.trim());
  await window.api.setConfig('tvCid', document.getElementById('settings-tv-cid').value.trim());
  await window.api.setConfig('tvSec', document.getElementById('settings-tv-sec').value);
  await window.api.setConfig('tvEnabled', document.getElementById('settings-tv-enabled').checked);

  const dtoEl = document.getElementById('settings-disable-token-opt');
  if (dtoEl) await window.api.setConfig('disableTokenOpt', dtoEl.checked);

  const dorEl = document.getElementById('settings-disable-omniroute');
  if (dorEl) await window.api.setConfig('disableOmniRoute', dorEl.checked);

  Object.assign(acc, {
    balance, profit,
    fundedFloor, fundedDayStop, fundedTargetMin, fundedTargetMax, payoutTarget,
    evalFloor, evalDayCap, evalDayStop
  });
  state.hasApiKey = !!apiKey;
  updateAccountUI();
  updateRulesTab();
  closeSettings();
  addSystemMessage(apiKey
    ? 'Settings saved. AI co-pilot is ready.'
    : 'Settings saved. Running without an API key — mechanical monitors, GO/NO-GO gate, and manual chart tools stay live; AI chat/analysis is off.');
  refreshPrice();
  computeMechanicalGoNogo();
}

document.getElementById('settings-open-btn').addEventListener('click', openSettings);


// ── Target Ladder ──────────────────────────────────────────────────────────
// REBUILT 2026-07-28 (Anoop): was permanently hardcoded to the dead $150K
// eval's numbers at time of breach (START=148932, FLOOR0=145500, TARGET=
// 159000, MLL=4500) regardless of which account was active — so a fresh
// $50K account still showed the old eval's balance/floor. Now every number
// is pulled live from state.account / ACCOUNT_PROFILES[state.accountSize],
// the same source updateAccountUI() uses for the left sidebar, so the two
// can never drift apart. Storage key is in ACCT_LS_KEYS so typed actuals
// swap per account slot instead of bleeding across accounts.
(function(){
  const LKEY='copilot_ladder_actuals';
  const DAYS=15;
  function loadA(){ try{return JSON.parse(localStorage.getItem(LKEY))||{};}catch(e){return{};} }
  function saveA(o){ localStorage.setItem(LKEY, JSON.stringify(o)); }
  function money(n){ return (n<0?'-$':'$')+Math.abs(Math.round(n)).toLocaleString(); }
  window.saveLadderEntry=function(day,val){ const a=loadA(); if(val===''||val===null||isNaN(Number(val))){delete a[day];}else{a[day]=Number(val);} saveA(a); renderLadder(); };
  window.resetLadder=function(){ if(confirm('Clear all actual entries from the ladder?')){ localStorage.removeItem(LKEY); renderLadder(); } };
  window.renderLadder=function(){
    const wrap=document.getElementById('ladder-table-wrap'); if(!wrap) return;
    const size = state.accountSize, acc = state.account;
    const prof = ACCOUNT_PROFILES[size] && ACCOUNT_PROFILES[size].eval;
    if(!prof){ wrap.innerHTML=''; return; }

    // Live numbers — same source as the left-panel sidebar (updateAccountUI).
    const START = acc.balance;
    const FLOOR0 = acc.evalFloor;
    const MLL = prof.maxLoss;
    const TARGET = acc.evalTarget || (prof.startBalance + prof.target);
    // Lock threshold: eval floor stops trailing once balance clears
    // startBalance+$100 (matches the confirmed 150K eval behavior — floor
    // locked permanently at $150,100 on a $150,000 start).
    const LOCK_FLOOR = prof.startBalance + 100;
    // Daily plan pace: scale the same ratio the old 150K ladder used
    // (700/day plan vs its 9000 target ⇒ ~1.167x target/15days), so smaller
    // accounts get a proportionally smaller daily plan instead of the old
    // eval's flat $700/day showing up on a $50K account.
    const PLAN_NET = Math.max(1, Math.round((prof.target * 1.167) / DAYS));
    function fl(prev,bal){ return Math.min(LOCK_FLOOR, Math.max(prev, bal-MLL)); }

    const badge=document.getElementById('ladder-badge');
    if(badge) badge.textContent = ACCOUNT_PROFILES[size].label+' EVAL — TARGET LADDER';
    const noteEl=document.getElementById('ladder-note');
    if(noteEl) noteEl.textContent = 'EOD-trailing floor · target '+money(TARGET)+' · consistency 50% · no DLL, no min days. Type each day\'s real net; balance/floor/cushion auto-update. Saved locally in this app.';

    const a=loadA();
    let pBal=START, pFloor=FLOOR0, rows=[];
    for(let d=1; d<=DAYS; d++){ pBal+=PLAN_NET; pFloor=fl(pFloor,pBal); rows.push({d:d, pBal:pBal, pFloor:pFloor, pCush:pBal-pFloor}); }
    let aBal=START, aFloor=FLOOR0, curBal=START, curFloor=FLOOR0, logged=0;
    rows.forEach(function(r){ if(a[r.d]!==undefined){ aBal+=a[r.d]; aFloor=fl(aFloor,aBal); r.aBal=aBal; r.aFloor=aFloor; r.aCush=aBal-aFloor; curBal=aBal; curFloor=aFloor; logged++; } });
    const cush=curBal-curFloor, rem=TARGET-curBal, passed=curBal>=TARGET;
    const alert = cush<(MLL*0.33) ? 'danger' : (cush<(MLL*0.55)?'warn':'');
    const sumEl=document.getElementById('ladder-summary');
    if(sumEl) sumEl.innerHTML =
      '<div class="ldr-cards">'
      +'<div class="ldr-card"><div class="ldr-k">Balance</div><div class="ldr-v">'+money(curBal)+'</div></div>'
      +'<div class="ldr-card"><div class="ldr-k">Floor</div><div class="ldr-v">'+money(curFloor)+(curFloor>=LOCK_FLOOR?' \U0001F512':'')+'</div></div>'
      +'<div class="ldr-card '+alert+'"><div class="ldr-k">Cushion</div><div class="ldr-v">'+money(cush)+'</div></div>'
      +'<div class="ldr-card"><div class="ldr-k">To target</div><div class="ldr-v">'+(passed?'PASS ✓':money(rem))+'</div></div>'
      +'</div>'
      +'<div class="ldr-next">'+(passed?'Target hit — stop trading this account and upgrade to funded.':'Days logged: '+logged+' · next-day target +'+money(PLAN_NET)+' net · keep any single day ≤ '+money(MLL)+' (consistency)')+'</div>';
    let h='<table class="ladder-tbl"><thead><tr><th>Day</th><th>Plan Bal</th><th>Floor</th><th>Cush</th><th>Actual Net</th><th>Act Bal</th><th>Act Cush</th></tr></thead><tbody>';
    rows.forEach(function(r){
      const lock = r.pFloor>=LOCK_FLOOR;
      const cls = (passed&&r.d===DAYS)?'pass':(lock?'lock':'');
      const netv = a[r.d]!==undefined? a[r.d] : '';
      h+='<tr class="'+cls+'">'
        +'<td>'+r.d+'</td>'
        +'<td>'+money(r.pBal)+'</td>'
        +'<td>'+money(r.pFloor)+(lock?' \U0001F512':'')+'</td>'
        +'<td>'+money(r.pCush)+'</td>'
        +'<td><input class="ladder-in" type="number" step="1" value="'+netv+'" onchange="saveLadderEntry('+r.d+', this.value)" placeholder="—"></td>'
        +'<td>'+(r.aBal!==undefined?money(r.aBal):'')+'</td>'
        +'<td class="'+((r.aCush!==undefined&&r.aCush<(MLL*0.33))?'cx-danger':'')+'">'+(r.aCush!==undefined?money(r.aCush):'')+'</td>'
        +'</tr>';
    });
    h+='</tbody></table>';
    wrap.innerHTML=h;
  };
})();

// ── Lessons Log (added 2026-07-28, Anoop) ───────────────────────────────────
// Deliberately GLOBAL — NOT in ACCT_LS_KEYS — because a lesson like "sizing
// up while losing blows accounts" applies across every account, not just
// whichever one is active when you write it. This is a capture tool, not an
// enforcement tool: writing a lesson here does not change any rule by
// itself. Promoting one into an actual enforced rule (rules.json + app
// logic + a dated CLAUDE.md changelog entry) is still a deliberate follow-up
// step — same as the existing "Pending Checklist Enhancements" section.
(function(){
  const LKEY = 'copilot_lessons_log';
  function loadL(){ try{ return JSON.parse(localStorage.getItem(LKEY)) || []; }catch(e){ return []; } }
  function saveL(list){ localStorage.setItem(LKEY, JSON.stringify(list)); }
  window.addLesson = function(){
    const el = document.getElementById('lesson-text');
    const text = el ? el.value.trim() : '';
    if (!text) return;
    const list = loadL();
    list.unshift({ id: Date.now(), ts: new Date().toISOString(), text: text, promoted: false });
    saveL(list.slice(0, 100));
    if (el) el.value = '';
    const saved = document.getElementById('lesson-saved');
    if (saved) { saved.textContent = 'Saved ✓'; setTimeout(() => { saved.textContent = ''; }, 2000); }
    renderLessons();
  };
  window.togglePromoted = function(id){
    const list = loadL();
    const e = list.find(x => x.id === id);
    if (e) { e.promoted = !e.promoted; saveL(list); renderLessons(); }
  };
  window.deleteLesson = function(id){
    if (!confirm('Delete this lesson?')) return;
    saveL(loadL().filter(x => x.id !== id));
    renderLessons();
  };
  window.renderLessons = function(){
    const wrap = document.getElementById('lessons-list'); if (!wrap) return;
    const list = loadL();
    if (!list.length) { wrap.innerHTML = '<div style="font-size:12px;opacity:.5;">No lessons logged yet.</div>'; return; }
    wrap.innerHTML = list.map(function(e){
      const d = new Date(e.ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      return '<div style="border:1px solid var(--border,#30363d);border-radius:6px;padding:6px 8px;margin-bottom:6px;font-size:12px;'
        + (e.promoted ? 'border-left:3px solid var(--green,#3fb950);' : 'border-left:3px solid var(--amber,#d29922);') + '">'
        + '<div style="opacity:.6;font-size:10px;margin-bottom:2px;">' + d + (e.promoted ? ' · promoted to rule' : ' · not yet a rule') + '</div>'
        + '<div>' + e.text.replace(/</g, '&lt;') + '</div>'
        + '<div style="margin-top:4px;">'
        + '<button class="engulf-check-btn" style="font-size:10px;padding:2px 6px;" onclick="togglePromoted(' + e.id + ')">' + (e.promoted ? 'Mark not-yet-promoted' : 'Mark promoted') + '</button> '
        + '<button class="engulf-check-btn" style="font-size:10px;padding:2px 6px;" onclick="deleteLesson(' + e.id + ')">Delete</button>'
        + '</div></div>';
    }).join('');
  };
})();

// ── Alignment tab (added 2026-07-28, Anoop) ─────────────────────────────────
// Two halves, deliberately asymmetric. Top half is NOT free text — it's
// rendered live from getRules()/state.account, so what Anoop sees here is
// mechanically guaranteed to match what the app is actually enforcing (no
// separate copy to drift, unlike the old Ladder tab / sizeCap bugs). Bottom
// half is his own dated log of current thinking/direction — global across
// accounts, same as Lessons — that Claude should read before coaching him,
// so continuity isn't assumed from memory alone.
(function(){
  const AKEY = 'copilot_align_notes'; // local cache/offline fallback only — server (DATA/align_notes.json) is the source of truth
  let cache = [];
  let loaded = false;

  // 2026-08-06: was localStorage-only — browser-local, never reached the
  // server, so (a) clearing browser data or switching machines silently lost
  // every entry, and (b) no agent could ever read it, despite the UI copy
  // literally saying "Claude reads recent entries here before coaching you."
  // Neither was true. Fixed: server is now the source of truth (global key,
  // not slot-namespaced — same as Lessons, since your psychology isn't
  // per-account); localStorage is kept only as an instant-paint cache/
  // offline fallback if the server round-trip fails.
  async function loadA(force){
    if (loaded && !force) return cache;
    try {
      if (window.api && window.api.dataLoad) {
        const remote = await window.api.dataLoad('align_notes');
        if (Array.isArray(remote) && remote.length) { cache = remote; loaded = true; localStorage.setItem(AKEY, JSON.stringify(remote)); return cache; }
        // 2026-08-07 FIX: entries saved BEFORE the 2026-08-06 server-persistence
        // fix landed are still sitting only in localStorage — they display fine
        // (this function falls back to the local cache below) but no agent has
        // ever been able to read them, since formatAlignmentNotes() only reads
        // the server file. The UI looked correct while being functionally
        // inert — exactly Anoop's "the alignment tab is just UI" complaint.
        // One-time migration: if the server has nothing but the local cache
        // does, push the local cache up so the server file catches up.
        if (Array.isArray(remote) && !remote.length) {
          let local = [];
          try { local = JSON.parse(localStorage.getItem(AKEY)) || []; } catch (e) { local = []; }
          if (local.length) {
            console.log('[Alignment] migrating', local.length, 'local-only entries to server');
            try { if (window.api.dataSave) await window.api.dataSave('align_notes', local); } catch (e) { console.error('Alignment migration failed:', e.message); }
            cache = local; loaded = true; return cache;
          }
        }
      }
    } catch (e) { console.error('Alignment load failed, using local cache:', e.message); }
    try { cache = JSON.parse(localStorage.getItem(AKEY)) || []; } catch (e) { cache = []; }
    loaded = true;
    return cache;
  }
  async function saveA(list){
    cache = list;
    localStorage.setItem(AKEY, JSON.stringify(list));
    try { if (window.api && window.api.dataSave) await window.api.dataSave('align_notes', list); }
    catch (e) { console.error('Alignment save failed (kept locally, will retry next save):', e.message); }
  }
  window.addAlignNote = async function(){
    const el = document.getElementById('align-text');
    const text = el ? el.value.trim() : '';
    if (!text) return;
    const list = (await loadA()).slice();
    list.unshift({ id: Date.now(), ts: new Date().toISOString(), text: text });
    await saveA(list.slice(0, 150));
    if (el) el.value = '';
    const saved = document.getElementById('align-saved');
    if (saved) { saved.textContent = 'Saved ✓'; setTimeout(() => { saved.textContent = ''; }, 2000); }
    renderAlignment();
  };
  window.deleteAlignNote = async function(id){
    if (!confirm('Delete this entry?')) return;
    await saveA((await loadA()).filter(x => x.id !== id));
    renderAlignment();
  };
  window.renderAlignment = async function(){
    const liveEl = document.getElementById('align-live-rules');
    if (liveEl) {
      const r = (typeof getRules === 'function') ? getRules() : {};
      const acc = (typeof state !== 'undefined') ? state.account : {};
      const size = (typeof state !== 'undefined') ? state.accountSize : null;
      const mode = (typeof state !== 'undefined') ? state.mode : null;
      const prof = (size && typeof ACCOUNT_PROFILES !== 'undefined' && ACCOUNT_PROFILES[size]) ? ACCOUNT_PROFILES[size] : null;
      const row = (k, v) => '<div class="rules-item"><span class="rules-key">' + k + '</span><span class="rules-val">' + v + '</span></div>';
      let h = '';
      h += row('Active account', (prof ? prof.label : (size || '—')) + ' · ' + (mode || '—').toUpperCase());
      h += row('Balance', acc && acc.balance != null ? '$' + acc.balance.toLocaleString() : '—');
      h += row('Size cap', (r.sizeCap || 2) + ' contracts/entry (hard)');
      h += row('Trade cap', (r.tradesPerSession || 5) + '/session · ' + (r.tradesPerDay || 10) + '/day');
      h += row('Qualifying trade', '|P&L| ≥ $' + (r.qualifyingTradeMinAbsPnl != null ? r.qualifyingTradeMinAbsPnl : 100) + ' counts toward the cap');
      h += row('Daily loss tiers', '$' + (r.dailyLossTiers ? r.dailyLossTiers.yellow : -100) + ' YELLOW / $' + (r.dailyLossTiers ? r.dailyLossTiers.red : -150) + ' RED / $' + (r.dailyLossTiers ? r.dailyLossTiers.hard : -200) + ' HARD STOP');
      h += row('Cooldown', (r.cooldownMinutes || 15) + ' min after every trade, win or loss');
      h += row('One instrument/day', r.oneInstrumentPerDay ? 'Yes' : 'No');
      if (r.sessionWindowsIST) {
        r.sessionWindowsIST.forEach(w => { h += row(w.name + ' session', Math.floor(w.startMin / 60) + ':' + String(w.startMin % 60).padStart(2, '0') + '–' + Math.floor(w.endMin / 60) + ':' + String(w.endMin % 60).padStart(2, '0') + ' IST'); });
      }
      h += row('Sized up while losing', 'Forced hard stop (added 2026-07-28)');
      liveEl.innerHTML = h;
    }
    const wrap = document.getElementById('align-notes-list'); if (!wrap) return;
    wrap.innerHTML = '<div style="font-size:12px;opacity:.5;">Loading…</div>';
    const list = await loadA(true); // force a fresh server read on every tab-open, not just the cache
    if (!list.length) { wrap.innerHTML = '<div style="font-size:12px;opacity:.5;">Nothing logged yet.</div>'; return; }
    wrap.innerHTML = list.map(function(e){
      const d = new Date(e.ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      return '<div style="border:1px solid var(--border,#30363d);border-radius:6px;padding:6px 8px;margin-bottom:6px;font-size:12px;">'
        + '<div style="opacity:.6;font-size:10px;margin-bottom:2px;">' + d + '</div>'
        + '<div>' + e.text.replace(/</g, '&lt;') + '</div>'
        + '<div style="margin-top:4px;"><button class="engulf-check-btn" style="font-size:10px;padding:2px 6px;" onclick="deleteAlignNote(' + e.id + ')">Delete</button></div>'
        + '</div>';
    }).join('');
  };
})();

// ── Checklist tab ──────────────────────────────────────────────────────────────
// Ported from Edgedesk (C:\Users\Admin\Claude\Projects\Edgedesk\EdgeDesk.html,
// the Pre-Trade panel). Kept as a self-contained, localStorage-only feature —
// no dependency on Edgedesk's per-account key namespacing, its localhost:7373
// bridge, or its Notion sync, none of which exist in this app. All ids/fns
// prefixed ck- / ck to avoid any collision with the rest of app.js.
// 2026-08-13: delegates to the ONE trading-day definition (IST) in
// checklist-logic.js. This used to build a browser-LOCAL date while the
// go/no-go gate at ~4513 compared against a UTC string and endDay used
// Asia/Kolkata — three answers to "what day is it". Between 00:00 and 05:30
// IST they disagree, so a checklist finished at 01:00 IST could never satisfy
// the gate that requires it. Falls back to the old local computation only if
// the module failed to load, so the tab can never go blank over this.
function ckToday() {
  if (window.ChecklistLogic) return window.ChecklistLogic.tradingDayIST();
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const CK_PLAN_KEY = 'copilot_checklist_plan';
// AUDIT FIX 2026-07-25: several checklist functions parsed this key with NO
// try/catch — one corrupted localStorage value would throw and kill the whole
// checklist tab render. All CK_PLAN_KEY reads now go through this.
// BUG FIX 2026-08-13 — this line read `return ckPlanRead() || {}`, i.e. it
// called ITSELF. Every call blew the stack, the RangeError was swallowed by
// its own catch, and the function returned {} every single time. Effects,
// all silent (no console error survives the catch):
//   - ckSetBody/ckSetActiveSess read {}, so each one wrote a blob containing
//     ONLY its own field — every tick erased the previous tick. Anoop's exact
//     report: "only one tick in one tab is accepted".
//   - ckSavePlan's `existing` was always {}, so typing in Today's Plan wiped
//     the body check and the session selection.
//   - ckLoadPlan saw no date, bailed at the staleness check, and left the
//     form blank on every open.
// Live since 2026-07-25, which is why the checklist has never been completed
// once. Restores the read the original AUDIT FIX comment below intended.
function ckPlanRead() {
  try { return JSON.parse(localStorage.getItem(CK_PLAN_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
const CK_BODY_GROUPS = { gym: ['high', 'low', 'rest'], sleep: ['good', 'ok', 'poor'], nap: ['yes', 'no'] };

function ckSetBody(type, val) {
  const body = Object.assign({}, ckPlanRead().body || {});
  body[type] = val;
  ckPlanWrite({ body: body });
  ckRenderBodyCheck(body);
  ckUpdateVerdict();
}

function ckRenderBodyCheck(body) {
  body = body || {};
  Object.keys(CK_BODY_GROUPS).forEach(type => {
    CK_BODY_GROUPS[type].forEach(v => {
      const btn = document.getElementById('ck-' + type + v.charAt(0).toUpperCase() + v.slice(1));
      if (btn) btn.className = 'ck-body-btn' + (body[type] === v ? ' active-' + v : '');
    });
  });
}

// Single writer for the whole checklist blob. Every mutation goes through
// here and MERGES onto what's on disk, so no writer can drop a sibling field.
// The old ckSavePlan rebuilt the object literal from the form and had to
// hand-carry activeSess/body forward; anything not in that literal (ticks,
// stress, preTradeDone) would have been silently lost even after the
// ckPlanRead fix above.
function ckPlanWrite(patch) {
  const p = ckPlanRead();
  Object.assign(p, patch || {});
  if (!p.date) p.date = ckToday();
  try { localStorage.setItem(CK_PLAN_KEY, JSON.stringify(p)); } catch (e) {}
  return p;
}

function ckSavePlan() {
  const get = id => document.getElementById(id)?.value || '';
  ckPlanWrite({
    bias: get('ck-planBias'), maxT: get('ck-planMaxT'), levels: get('ck-planLevels'),
    news: get('ck-planNews'), focus: get('ck-planFocus'), h4: get('ck-planH4'),
    h1: get('ck-planH1'), setups: get('ck-planSetups'),
    date: ckToday()
  });
}

function ckLoadPlan() {
  const p = ckPlanRead();
  // MIDNIGHT ROLLOVER (2026-08-13): a stale blob used to just `return`, leaving
  // yesterday's preTradeDone/preTradeScore/preTradeTier sitting in storage. The
  // gate reads ck_history (date-matched, so it was never fooled), but anything
  // reading plan.preTradeDone would have believed a session left open overnight
  // was still "done". Actively clear it instead of returning early.
  if (p.date !== ckToday()) {
    ckPlanWrite({
      date: ckToday(), preTradeDone: null, preTradeDoneAt: null,
      preTradeScore: null, preTradeTier: null,
      ticks: [], fw: [], pb: null, body: {}, stress: {}, activeSess: ''
    });
    ckResetChecklistUI();
    ckRenderGate();
    return;
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('ck-planBias', p.bias); set('ck-planMaxT', p.maxT); set('ck-planLevels', p.levels);
  set('ck-planNews', p.news); set('ck-planFocus', p.focus); set('ck-planH4', p.h4);
  set('ck-planH1', p.h1); set('ck-planSetups', p.setups);
  ckRenderActiveSess(p.activeSess || '');
  ckRenderBodyCheck(p.body || {});
  ckRenderStress(p.stress || {});
  ckRestoreTicks(p);
  ckUpdateVerdict();
  ckRenderGate();
  ckRenderWeekly();
}

// The visual half of a reset, with no confirm and no storage write — used by
// the midnight-rollover path above, and by ckResetChecklist() after its confirm.
function ckResetChecklistUI() {
  [1, 2, 3].forEach(i => document.getElementById('ck-pb' + i)?.classList.remove('on'));
  const pbNote = document.getElementById('ck-pbNote');
  if (pbNote) pbNote.textContent = 'Select a playbook to begin';
  [0, 1, 2, 3, 4].forEach(i => document.getElementById('ck-fs' + i)?.classList.remove('done'));
  const fwNote = document.getElementById('ck-fwNote');
  if (fwNote) fwNote.textContent = 'Tap each step as you complete top-down analysis';
  document.querySelectorAll('#tab-checklist .ck-chk-item').forEach(el => el.classList.remove('on'));
  const badge = document.getElementById('ck-doneBadge');
  if (badge) badge.style.display = 'none';
  const btn = document.getElementById('ck-doneBtn');
  if (btn) { btn.textContent = '✓ PRE-TRADE DONE'; btn.style.opacity = '1'; btn.onclick = ckMarkDone; }
  ckUpdateVerdict();
}

// ── Stress routine (2026-08-13) ───────────────────────────────────────────────
// Anoop: "Routine to keep stress low during trading hours."
// Ticks, not a timer: a mid-session interrupt would fire while he is in a
// position, which is the worst possible moment to add an input.
const CK_STRESS_ITEMS = [
  ['rec', '🔴 Screen recording started'],
  ['breath', '🌬️ 2 minutes of slow breathing'],
  ['phone', '📵 Phone out of reach, notifications off']
];

function ckSetStress(key) {
  const stress = Object.assign({}, ckPlanRead().stress || {});
  stress[key] = !stress[key];
  ckPlanWrite({ stress: stress });
  ckRenderStress(stress);
}

function ckRenderStress(stress) {
  stress = stress || {};
  CK_STRESS_ITEMS.forEach(([key]) => {
    const btn = document.getElementById('ck-stress-' + key);
    if (btn) btn.className = 'ck-body-btn' + (stress[key] ? ' active-good' : '');
  });
}

// ── Weekend screen time (2026-08-13) ──────────────────────────────────────────
// Anoop: "track weekend screen time to reduce it".
// Deliberately OUTSIDE the daily plan blob and outside the gate: markets are
// shut at the weekend, so anything behind the pre-trade gate would never fire
// on the day it is about. Keyed by ISO week in its own storage key.
const CK_WEEKLY_KEY = 'copilot_ck_weekly';

function ckWeeklyRead() {
  try { return JSON.parse(localStorage.getItem(CK_WEEKLY_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}

function ckSaveWeekly() {
  const el = document.getElementById('ck-weekly-hours');
  if (!el || !window.ChecklistLogic) return;
  const wk = window.ChecklistLogic.isoWeekKey();
  const w = ckWeeklyRead();
  const v = parseFloat(el.value);
  if (isNaN(v) || v < 0) { delete w[wk]; } else { w[wk] = Math.round(v * 10) / 10; }
  try { localStorage.setItem(CK_WEEKLY_KEY, JSON.stringify(w)); } catch (e) {}
  ckRenderWeekly();
}

function ckRenderWeekly() {
  if (!window.ChecklistLogic) return;
  const w = ckWeeklyRead();
  const wk = window.ChecklistLogic.isoWeekKey();
  const input = document.getElementById('ck-weekly-hours');
  if (input && document.activeElement !== input) input.value = (w[wk] != null ? w[wk] : '');
  const trend = document.getElementById('ck-weekly-trend');
  if (!trend) return;
  const keys = Object.keys(w).sort().slice(-4);
  if (!keys.length) { trend.textContent = 'No weeks logged yet.'; return; }
  const max = Math.max.apply(null, keys.map(k => w[k])) || 1;
  const rows = keys.map(k => {
    const v = w[k];
    const bars = '█'.repeat(Math.max(1, Math.round((v / max) * 12)));
    return k + '  ' + bars + '  ' + v + 'h';
  });
  const first = w[keys[0]], last = w[keys[keys.length - 1]];
  const delta = (keys.length > 1)
    ? (last < first ? '  ↓ down ' + Math.round((first - last) * 10) / 10 + 'h vs ' + keys[0]
      : (last > first ? '  ↑ up ' + Math.round((last - first) * 10) / 10 + 'h vs ' + keys[0] : '  → flat'))
    : '';
  trend.textContent = rows.join('\n') + (delta ? '\n' + delta : '');
}

// Session windows match CLAUDE.md rule #6 (reactivated 2026-07-02): London
// 1:30–3:00 PM IST / 8:00–9:30 UTC (prep only), NY 7:00–9:00 PM IST /
// 13:30–15:30 UTC (main session) — NOT Edgedesk's own wider windows
// (12:30–6:00 PM / 7:00–9:30 PM IST), which don't match this project's rules.
// 2026-08-13: moved into checklist-logic.js and boundary-tested. The version
// that lived here also returned 'london'/'ny' on Saturdays and Sundays, so
// "Auto" on a weekend told him to start a screen recording for a shut market.
function ckSessFromUTC() {
  if (window.ChecklistLogic) return window.ChecklistLogic.sessionFromUTC();
  const now = new Date();
  const tot = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (tot >= 480 && tot < 570) return 'london';
  if (tot >= 810 && tot < 930) return 'ny';
  return '';
}

function ckSetActiveSess(sess) {
  // Routed through ckPlanWrite 2026-08-13 — this was one of two remaining raw
  // setItem writers that bypassed the single merging writer.
  ckPlanWrite({ activeSess: sess });
  ckRenderActiveSess(sess);
  const rem = document.getElementById('ck-sessReminder');
  if (!rem) return;
  if (sess === 'london') {
    rem.style.display = 'block';
    rem.style.borderLeftColor = 'rgba(59,130,246,.7)';
    rem.innerHTML = '🇬🇧 <strong>London prep — small size only, not a full second session:</strong><br>'
      + '📼 Watch yesterday\'s screen recording before opening any chart.<br>'
      + '🔴 Start screen recording now — before you touch TradingView.';
  } else if (sess === 'ny') {
    const napTaken = document.getElementById('ck-napYes')?.classList.contains('active-yes');
    rem.style.display = 'block';
    rem.style.borderLeftColor = 'rgba(168,85,247,.7)';
    rem.innerHTML = '🗽 <strong>New York — primary session, full rules apply:</strong><br>'
      + '📼 Watch yesterday\'s screen recording if you haven\'t yet today.<br>'
      + (napTaken ? '😴 Nap logged — good.' : '⚠️ No nap logged — mark it above if you took one.') + '<br>'
      + '🔴 Start screen recording now — before you open any position.';
  } else {
    rem.style.display = 'none';
    rem.innerHTML = '';
  }
}

function ckRenderActiveSess(sess) {
  const map = { london: 'ck-sessLondon', ny: 'ck-sessNy', '': 'ck-sessNone' };
  const cls = { london: 'active-london', ny: 'active-ny', '': 'active-none' };
  Object.entries(map).forEach(([s, id]) => {
    const b = document.getElementById(id);
    if (!b) return;
    b.className = 'ck-sess-btn' + (sess === s ? ' ' + cls[s] : '');
  });
}

function ckAutoDetectSess() {
  ckSetActiveSess(ckSessFromUTC() || '');
}

// 2026-08-13: ticks are now PERSISTED. Until today the entire checklist state
// lived in CSS classes (.on / .done / .active-*) with no model behind it, so
// every tick died on reload and nothing could be written into the record.
// Each item is identified by its index within #tab-checklist, which is stable
// as long as items are appended rather than reordered; ckRestoreTicks() bounds
// -checks so a future edit to index.html can at worst lose a restore, never
// throw and blank the tab.
function ckAllChkItems() {
  return Array.prototype.slice.call(document.querySelectorAll('#tab-checklist .ck-chk-item'));
}

function ckPersistTicks() {
  const items = ckAllChkItems();
  const on = [];
  items.forEach((el, i) => { if (el.classList.contains('on')) on.push(i); });
  ckPlanWrite({
    ticks: on,
    fw: [0, 1, 2, 3, 4].filter(n => document.getElementById('ck-fs' + n)?.classList.contains('done')),
    pb: [1, 2, 3].find(i => document.getElementById('ck-pb' + i)?.classList.contains('on')) || null
  });
}

function ckRestoreTicks(p) {
  try {
    const items = ckAllChkItems();
    (p.ticks || []).forEach(i => { if (items[i]) items[i].classList.add('on'); });
    (p.fw || []).forEach(n => document.getElementById('ck-fs' + n)?.classList.add('done'));
    if (p.pb) { const el = document.getElementById('ck-pb' + p.pb); if (el) el.classList.add('on'); }
  } catch (e) {}
}

function ckTog(el) {
  el.classList.toggle('on');
  ckPersistTicks();
  ckUpdateVerdict();
}

function ckTogFW(i) {
  const el = document.getElementById('ck-fs' + i);
  if (!el) return;
  el.classList.toggle('done');
  ckPersistTicks();
  const done = [0, 1, 2, 3, 4].filter(n => document.getElementById('ck-fs' + n)?.classList.contains('done')).length;
  const note = document.getElementById('ck-fwNote');
  if (note) note.textContent = done === 5 ? 'All 5 steps complete — cleared for entry' : done + '/5 steps complete';
  ckUpdateVerdict();
}

function ckSelPB(n) {
  [1, 2, 3].forEach(i => document.getElementById('ck-pb' + i)?.classList.remove('on'));
  document.getElementById('ck-pb' + n)?.classList.add('on');
  const notes = {
    1: 'Engulfing + TF: wait for a closed engulfing candle on 5M in the HTF direction. Confluence with a key level required.',
    2: 'SFP + FVG: spike beyond prior swing that closes back inside. FVG from the move = entry zone.',
    3: 'Liquidity Raid: price sweeps a stop pool (PDH/PDL/equal highs/lows), rejects strongly. Enter on 3M/5M reaction candle.'
  };
  const noteEl = document.getElementById('ck-pbNote');
  if (noteEl) noteEl.textContent = notes[n] || '';
  ckUpdateVerdict();
}

// Edgedesk's #verdict div was static decoration — nothing in its source ever
// updated it. Made it live here: recomputes against the checklist items each
// selected playbook actually needs, not just "is anything checked."
function ckUpdateVerdict() {
  const verdict = document.getElementById('ck-verdict');
  if (!verdict) return;
  const selPb = [1, 2, 3].find(i => document.getElementById('ck-pb' + i)?.classList.contains('on'));
  if (!selPb) {
    verdict.className = 'ck-verdict';
    verdict.innerHTML = '<div class="ck-vdot"></div><span>Select a playbook and complete the checklist</span>';
    return;
  }
  // 2026-08-13: the counts still come from the DOM (that IS the live state),
  // but the arithmetic and the tier now come from ckScore() so this banner and
  // the score written into the permanent record can never disagree again. The
  // old code here hardcoded the risk-item count as 4 while ckMarkDone read it
  // from the DOM — one edit to index.html and they diverged silently.
  const r = window.ChecklistLogic.ckScore(ckReadCounts());
  if (r.done === r.total) {
    verdict.className = 'ck-verdict go';
    verdict.innerHTML = '<div class="ck-vdot"></div><span>✓ Cleared — ' + r.label + ', all steps confirmed</span>';
  } else {
    verdict.className = 'ck-verdict partial';
    verdict.innerHTML = '<div class="ck-vdot"></div><span>' + r.label + ' — ' + r.done + '/' + r.total + ' items confirmed</span>';
  }
  ckRenderStickyHeader(r);
}

// Single DOM→counts reader. Both the live verdict and the saved record go
// through this, so there is exactly one place that knows how the checklist is
// laid out in index.html.
function ckReadCounts() {
  const isOn = id => document.getElementById(id)?.classList.contains('on');
  const selPb = [1, 2, 3].find(i => document.getElementById('ck-pb' + i)?.classList.contains('on'));
  let structDone = 0;
  if (selPb === 1) {
    structDone = document.querySelectorAll('#ck-block-5m .ck-chk-item.on').length;
  } else if (selPb === 2) {
    structDone = (isOn('ck-sfp') ? 1 : 0) + (isOn('ck-fvg') ? 1 : 0)
      + document.querySelectorAll('#ck-block-liq .ck-chk-item.on:not(#ck-sfp):not(#ck-fvg)').length;
  } else if (selPb === 3) {
    structDone = document.querySelectorAll('#ck-block-liq .ck-chk-item.on:not(#ck-sfp):not(#ck-fvg)').length;
  }
  return {
    selPb: selPb,
    htfDone: document.querySelectorAll('#ck-block-htf .ck-chk-item.on').length,
    structDone: structDone,
    riskDone: document.querySelectorAll('#ck-block-risk .ck-chk-item.on').length,
    riskTotal: document.querySelectorAll('#ck-block-risk .ck-chk-item').length,
    fwDone: [0, 1, 2, 3, 4].filter(n => document.getElementById('ck-fs' + n)?.classList.contains('done')).length,
    blackout: !!window.grInBlackout
  };
}

function ckResetChecklist() {
  if (!confirm('Reset the pre-trade checklist? This clears playbook, framework steps, and all checked items (plan fields and body check are kept).')) return;
  ckResetChecklistUI();
  // 2026-08-13: Reset used to clear the SCREEN only. The persisted ticks and
  // today's ck_history entry survived, so a reset checklist still read as
  // "done" to the gate — a visibly empty form that had silently already let
  // him through. Clear both, and re-render the gate so the lock comes back.
  ckPlanWrite({ ticks: [], fw: [], pb: null, preTradeDone: null, preTradeDoneAt: null, preTradeScore: null, preTradeTier: null });
  try {
    const ckh = ckHistoryRead().filter(e => e && e.date !== ckToday());
    localStorage.setItem('copilot_ck_history', JSON.stringify(ckh));
  } catch (e) {}
  ckRenderGate();
}

function ckMarkDone() {
  const now = new Date();
  const hh = now.getHours(), mm = now.getMinutes();
  const ap = hh >= 12 ? 'PM' : 'AM', h12 = hh % 12 || 12;
  const timeStr = h12 + ':' + (mm < 10 ? '0' : '') + mm + ' ' + ap;

  // 2026-08-13: score + tier now come from ckScore() in checklist-logic.js —
  // the same call the live verdict banner makes. See ckReadCounts().
  //
  // The old copy here recomputed the whole thing with a second formula. Note
  // the GO text it produced was also stale: "6 MNQ cap, one of your 2 trades"
  // hardcoded a size cap of 6 and a trade limit of 2, both superseded in
  // rules.json (sizeCap is 2; tradesPerSession is 5). Per CLAUDE.md, numbers
  // that live in rules.json must never be hardcoded in a string — ckScore's
  // verdict text now says "size per rules" instead of naming a stale number.
  const counts = ckReadCounts();
  const r = window.ChecklistLogic.ckScore(counts);
  const selPb = counts.selPb, riskDone = counts.riskDone, riskTotal = counts.riskTotal;
  const score = r.score, tier = r.tier, label = r.label;
  const done = r.done, total = r.total, riskFull = r.riskFull;
  const fwDone = counts.fwDone;
  const verdictTxt = r.verdict;
  const tierColor = tier === 'GO' ? 'var(--green)' : (tier === 'CAUTION' ? 'var(--amber)' : 'var(--red)');
  const tierBg = tier === 'GO' ? 'var(--green-dim)' : (tier === 'CAUTION' ? 'var(--amber-dim)' : 'var(--red-dim)');

  const badge = document.getElementById('ck-doneBadge');
  const timeEl = document.getElementById('ck-doneTime');
  const itemsEl = document.getElementById('ck-doneItems');
  if (badge) { badge.style.display = 'block'; badge.style.background = tierBg; badge.style.borderColor = tierColor; }
  const header = badge ? badge.querySelector('div') : null;
  if (header) {
    header.style.color = tierColor;
    header.textContent = selPb ? ('✓ PRE-TRADE ' + tier + ' — READINESS ' + score + '/10') : ('✓ PRE-TRADE ' + tier);
  }
  if (timeEl) timeEl.textContent = 'Completed at ' + timeStr;
  if (itemsEl) {
    const lines = [];
    if (selPb) lines.push('Readiness: ' + score + '/10  (' + done + '/' + total + ' ' + label + ' items)');
    lines.push('Risk Gate: ' + riskDone + '/' + riskTotal + (riskFull ? ' ✓' : ' ✗ INCOMPLETE'));
    lines.push('Framework: ' + fwDone + '/5 steps');
    lines.push(verdictTxt);
    const plan = ckPlanRead();
    if (plan.bias) lines.push('Bias: ' + plan.bias);
    if (plan.levels) lines.push('Key levels: ' + plan.levels);
    itemsEl.innerHTML = lines.map(l => '· ' + l).join('<br>');
  }
  const p = ckPlanWrite({
    preTradeDone: timeStr, preTradeDoneAt: Date.now(),
    preTradeScore: score, preTradeTier: tier
  });
  const entry = ckWriteRecord({
    score: selPb ? score : null, tier: tier, done: true,
    label: label, itemsDone: done, itemsTotal: total,
    riskDone: riskDone, riskTotal: riskTotal, fwDone: fwDone,
    timeStr: timeStr, plan: p
  });
  ckRenderGate();
  // 2026-08-13 (Anoop): "This is a reminder that you should give me on the chat
  // after I complete the checklist." The server owns it — it has the full
  // ck_history + day_trades matrix on disk and can cite real precedent days.
  try { if (window.api && window.api.checklistDone) window.api.checklistDone(entry); } catch (e) {}
  const btn = document.getElementById('ck-doneBtn');
  if (btn) { btn.textContent = selPb ? ('✓ ' + tier + ' ' + score + '/10 · ' + timeStr) : ('✓ ' + tier + ' · ' + timeStr); btn.style.opacity = '0.85'; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHECKLIST RECORD + GATE (2026-08-13)
//
// Anoop: "after completing, it is done for my record and saved in same location
// as trade details… this is just for my psychological satisfaction and
// discipline purpose. as you can see i have not used it once."
//
// He had not used it because ckPlanRead() was throwing away every tick since
// 2026-07-25 (see the fix at the top of this section), not because he skipped it.
//
//   ckMarkDone ──┐
//   ckSkipToday ─┴─> ckWriteRecord ──> localStorage copilot_ck_history (90 days)
//                                 └──> dataSave('ck_history__<slot>')  [immediate]
//                                      = DATA/accounts/<slot>/ck_history.json
//                                        (same folder as day_trades.json)
//
// The disk write no longer waits for End Day: a day he completes but never
// formally closes used to leave no durable record at all.
// ═══════════════════════════════════════════════════════════════════════════════

// Decided 2026-08-13 (Anoop): ONE checklist per day, covering every account.
// The checklist is about him and the market, not about which slot is open —
// and switching slots runs loadAccountBucket(), which removeItem()s every
// ACCT_LS_KEYS entry (including copilot_ck_history). Without this, completing
// the checklist and then switching accounts mid-session would drop him back
// into an empty, locked checklist. Mirrored to EVERY slot's folder so each
// account's dataset still carries its own copy of the day's record.
function ckWriteRecord(rec) {
  const date = ckToday();
  const plan = rec.plan || ckPlanRead();
  const entry = {
    date: date,
    score: rec.score, tier: rec.tier, done: rec.done === true,
    label: rec.label || '', itemsDone: rec.itemsDone, itemsTotal: rec.itemsTotal,
    riskDone: rec.riskDone, riskTotal: rec.riskTotal, fwDone: rec.fwDone,
    completedAt: rec.timeStr || '', completedAtMs: Date.now(),
    ticks: ckReadTicks(),
    bias: plan.bias || '', h4: plan.h4 || '', h1: plan.h1 || '',
    levels: plan.levels || '', news: plan.news || '', focus: plan.focus || '',
    setups: plan.setups || '', maxT: plan.maxT || '',
    body: plan.body || {}, stress: plan.stress || {}, session: plan.activeSess || '',
    slotId: (typeof activeSlotId !== 'undefined') ? activeSlotId : null
  };
  let ckh = [];
  try { ckh = JSON.parse(localStorage.getItem('copilot_ck_history') || '[]') || []; } catch (e) { ckh = []; }
  if (!Array.isArray(ckh)) ckh = [];
  ckh = ckh.filter(e => e && e.date !== date);
  ckh.push(entry);
  ckh = ckh.slice(-90);
  let wrote = false;
  try { localStorage.setItem('copilot_ck_history', JSON.stringify(ckh)); wrote = true; } catch (e) {}
  // The original bug was invisible for 19 days because every failure was
  // swallowed. A record that cannot be written is the one thing that must be
  // loud — silence here is what he already lived through.
  ckSetSaveError(!wrote);

  // BUG FIX 2026-08-13 (Anoop: "once I have confirmed it once... now again it
  // is asking me" — after a restart, same day, no account switch in between).
  // `copilot_ck_history` is in ACCT_LS_KEYS, so the FAST boot path
  // (applyConfig() -> loadAccountBucket(), synchronous, no delay) restores it
  // from the CACHED BUCKET CONFIG, not from localStorage or the disk mirror
  // below. That config is only ever refreshed by saveActiveBucket(), which
  // nothing was calling here — so a completion sat correctly in localStorage
  // for the rest of THIS session, but the config a restart reads from was
  // still the pre-completion snapshot. The disk mirror further down WOULD
  // eventually self-correct it (restoreFromDisk, 800ms-2.5s after boot) — but
  // nothing re-renders the checklist gate when that lands either, so even the
  // self-correction was invisible. This call makes the fast path correct
  // immediately, which is what actually runs before he ever sees the gate.
  try { if (typeof saveActiveBucket === 'function') saveActiveBucket(); } catch (e) {}

  // Mirror to disk for every slot, immediately. Fire-and-forget: a disk problem
  // must never block the UI he is standing in front of before a session.
  // ALSO updates each OTHER slot's cached bucket in memory (not just disk) so
  // switching to a different account later in the same session sees today's
  // completion too — "one checklist per day, all accounts" (his call,
  // 2026-08-13) means every slot's fast-path cache needs it, not just the one
  // that was active when he pressed DONE. A slot whose cache was never loaded
  // this session is left alone; it picks up the correct value from its own
  // disk file the first time it's actually opened.
  try {
    const slots = (typeof acctSlots !== 'undefined' && Array.isArray(acctSlots)) ? acctSlots : [];
    slots.forEach(s => {
      if (!s || s.retired) return;
      Promise.resolve(window.api.dataSave('ck_history__' + s.id, ckh)).catch(() => {});
      if (s.id !== activeSlotId && typeof acctBucketCache !== 'undefined' && acctBucketCache[s.id]) {
        acctBucketCache[s.id].ls = acctBucketCache[s.id].ls || {};
        acctBucketCache[s.id].ls['copilot_ck_history'] = JSON.stringify(ckh);
        try { window.api.setConfig('acctBucket__' + s.id, acctBucketCache[s.id]); } catch (e) {}
      }
    });
  } catch (e) {}
  return entry;
}

// Serializes which items are actually ticked, so the record answers "what did I
// confirm that day", not just "I scored 8". The old record stored {date, score,
// tier} and nothing else — the part worth looking back on was never kept.
function ckReadTicks() {
  const out = { items: [], framework: [], playbook: null };
  try {
    document.querySelectorAll('#tab-checklist .ck-chk-item.on').forEach(el => {
      const lbl = el.querySelector('.ck-clbl');
      if (lbl) out.items.push(lbl.textContent.trim());
    });
    [0, 1, 2, 3, 4].forEach(n => {
      if (document.getElementById('ck-fs' + n)?.classList.contains('done')) out.framework.push(n);
    });
    const pb = [1, 2, 3].find(i => document.getElementById('ck-pb' + i)?.classList.contains('on'));
    out.playbook = pb || null;
  } catch (e) {}
  return out;
}

function ckHistoryRead() {
  try {
    const h = JSON.parse(localStorage.getItem('copilot_ck_history') || '[]');
    return Array.isArray(h) ? h : [];
  } catch (e) { return []; }
}

// The escape hatch. Deliberately real: it opens the gate immediately, with no
// friction beyond one confirm. What it costs is visible rather than blocking —
// the day is recorded SKIPPED, the streak breaks, and a banner stays up.
// A door he can always open is a door he will not rip off its hinges.
function ckSkipToday() {
  if (!confirm('Skip the pre-trade checklist today?\n\nThis is recorded as SKIPPED, it breaks your streak, and a banner stays up for the session. You can still complete it later — that turns it into LATE and keeps the record honest.')) return;
  ckWriteRecord({ score: null, tier: 'SKIPPED', done: false, label: '', timeStr: '' });
  ckRenderGate();
  if (typeof addSystemMessage === 'function') {
    addSystemMessage('⚠️ Pre-trade checklist SKIPPED for ' + ckToday() + '. Recorded. Complete it any time today to turn it into LATE.');
  }
}

let ckSaveErrored = false;
function ckSetSaveError(on) {
  ckSaveErrored = !!on;
  const el = document.getElementById('ck-save-error');
  if (el) el.style.display = on ? 'block' : 'none';
}

// ── The gate ──────────────────────────────────────────────────────────────────
// Locks the trade-relevant right-panel tabs until the checklist is completed or
// explicitly skipped. THREE deliberate safety properties, because this is the
// only mechanism in the app that can take away access to his own tool during a
// live session:
//
//   1. FAILS OPEN. ckGateOpen() returns true on anything malformed, and the
//      whole body here is wrapped so a throw unlocks rather than locks. This is
//      the opposite of the go/no-go badge's fail-closed choice, correctly: the
//      badge only advises, so erring toward NO-GO is free.
//   2. CHAT IS NEVER LOCKED. Jessi is the tool that helps him FINISH the
//      checklist (read the chart, confirm 4H/1H, name PDH/PDL). Gating the
//      assistant behind the task it assists with is the one lock that would
//      make the feature worth resenting.
//   3. THE SKIP BUTTON IS STATIC HTML. It is never rendered by this code path,
//      so an exception here can't take the escape hatch with it.
//
// Weekends are exempt outright — no market, nothing to be disciplined about.
// The tabs that are ABOUT trading. Verified against the .rtab strip in
// index.html: analysis, journal, rules, lessons, align, ladder, checklist,
// apprentice, insights, cost.
//
// Deliberately NOT gated:
//   checklist              — obviously
//   rules, lessons, align  — the material that helps him comply. Locking the
//                            rulebook behind the discipline gate is backwards.
//   chat                   — not a right-panel tab at all (it is the main
//                            panel), so Jessi is structurally always reachable.
//                            That was the whole objection to the hard lock.
const CK_GATED_TABS = ['analysis', 'journal', 'ladder', 'apprentice', 'insights', 'cost'];

// 2026-08-13 (autoplan Design review, severity 2/10 — the most severe finding
// of the whole review): ckGateIsOpen() collapsed three DIFFERENT reasons for
// "open" into one boolean — a genuine completed checklist looked IDENTICAL to
// a silent fail-open (missing module, save error, or an exception). That is
// the exact bug SHAPE this app has already shipped once (ckPlanRead()'s
// self-recursion swallowed every tick for 19 days with zero visible sign).
// Failing open was still the right safety call — this app must never trap
// Anoop behind a locked panel — but failing open INVISIBLY defeats the whole
// point of a discipline gate. This function now tells the difference.
// Returns: null (gate genuinely evaluated — real pass or real lock) or a
// short reason string ('module-missing' | 'save-error' | 'exception') when
// the "open" state came from a safety fallback, not a real completion.
// Weekend is NOT degraded — that is an intentional, correct exemption, not a
// failure, and must not alarm the user every Saturday.
function ckGateDegradedReason() {
  try {
    if (window.ChecklistLogic && window.ChecklistLogic.isWeekendIST()) return null;
    if (!window.ChecklistLogic) return 'module-missing';
    if (ckSaveErrored) return 'save-error';
    window.ChecklistLogic.ckGateOpen(ckHistoryRead(), ckToday()); // exercise it; throw surfaces below
    return null;
  } catch (e) { return 'exception'; }
}

function ckGateIsOpen() {
  try {
    if (window.ChecklistLogic && window.ChecklistLogic.isWeekendIST()) return true;
    if (!window.ChecklistLogic) return true; // module missing → never lock
    if (ckSaveErrored) return true;          // can't record → don't gate
    return window.ChecklistLogic.ckGateOpen(ckHistoryRead(), ckToday());
  } catch (e) { return true; }
}

function ckRenderGate() {
  try {
    const open = ckGateIsOpen();
    const counts = (typeof ckReadCounts === 'function') ? ckReadCounts() : null;
    const r = (counts && window.ChecklistLogic) ? window.ChecklistLogic.ckScore(counts) : null;
    document.querySelectorAll('.rtab').forEach(t => {
      const id = t.dataset.tab;
      const locked = !open && CK_GATED_TABS.indexOf(id) !== -1;
      t.classList.toggle('rtab-locked', locked);
      if (locked && r) t.title = 'Checklist ' + r.done + '/' + r.total + ' — finish it to unlock';
      else if (!locked) t.title = '';
    });
    const banner = document.getElementById('ck-global-banner');
    if (banner) {
      const today = ckHistoryRead().filter(e => e && e.date === ckToday())[0];
      const degraded = open ? ckGateDegradedReason() : null;
      if (today && today.tier === 'SKIPPED') {
        banner.style.display = 'block';
        banner.className = 'ck-banner ck-banner-skip';
        banner.textContent = '⚠️ Pre-trade checklist SKIPPED today — trading off-process. Complete it to clear this.';
      } else if (!open) {
        banner.style.display = 'block';
        banner.className = 'ck-banner ck-banner-todo';
        banner.textContent = '📋 Pre-trade checklist not done — finish it before you trade.';
      } else if (degraded) {
        // The tabs are unlocked, but NOT because the checklist was completed —
        // a safety fallback fired instead. Must look visibly different from a
        // real pass, or this defeats the gate as silently as the ckPlanRead
        // recursion bug did.
        banner.style.display = 'block';
        banner.className = 'ck-banner ck-banner-degraded';
        banner.textContent = '⚠ Checklist enforcement unavailable (' + degraded + ') — tabs unlocked as a safety fallback, not because it was completed. Do the checklist manually.';
      } else {
        banner.style.display = 'none';
      }
    }
    ckRenderStreak();
  } catch (e) {
    // Never let a gate-render problem be the thing that bricks the panel.
    try { document.querySelectorAll('.rtab').forEach(t => t.classList.remove('rtab-locked')); } catch (e2) {}
  }
}

// Called the moment an account is chosen — the start of a session.
// Weekend: no market, so it does not demand the daily checklist; it opens the
// tab on the weekly screen-time block instead, which is the thing that IS
// actionable on a Saturday.
function ckAfterAccountChosen() {
  try {
    ckLoadPlan();
    ckRenderGate();
    if (window.ChecklistLogic && window.ChecklistLogic.isWeekendIST()) {
      switchTab('checklist');
      if (typeof addSystemMessage === 'function') {
        addSystemMessage('Weekend — no pre-trade checklist needed. Log your weekend screen time in the Checklist tab.');
      }
      return;
    }
    switchTab('checklist');
    if (!ckGateIsOpen() && typeof addSystemMessage === 'function') {
      addSystemMessage('📋 Pre-trade checklist first. Analysis, Journal, Insights, Ladder, Roadmap and Cost unlock when it is done — chat stays open, so ask me to help you work through it.');
    }
  } catch (e) {}
}

function ckRenderStreak() {
  const el = document.getElementById('ck-streak');
  if (!el || !window.ChecklistLogic) return;
  const n = window.ChecklistLogic.ckStreak(ckHistoryRead(), ckToday());
  el.textContent = n > 0 ? ('🔥 Day ' + n) : '';
  el.style.display = n > 0 ? 'inline-block' : 'none';
}

function ckRenderStickyHeader(r) {
  const el = document.getElementById('ck-sticky-progress');
  if (el && r) el.textContent = r.done + '/' + r.total;
  const v = document.getElementById('ck-sticky-tier');
  if (v && r) {
    v.textContent = r.tier;
    v.className = 'ck-sticky-tier ' + (r.tier === 'GO' ? 'is-go' : (r.tier === 'CAUTION' ? 'is-caution' : 'is-nogo'));
  }
}



// ── Tier-1 Guardrails: size cap / trade limit / post-loss cooldown / daily stop ──
// ── Tier-2: news-blackout · per-trade grade · body gating ────────────────────────
// ── Tier-3 hooks: daily archiving + live-feed ingest (auto mode) ─────────────────
window.grInBlackout = false;
(function () {
  const GKEY = 'copilot_guardrail_v1', HKEY = 'copilot_gr_history';
  // Rules-driven (rules.json via window.RULES); live-updated on rules broadcast.
  let SIZE_CAP = 6, COOLDOWN_MS = 15 * 60 * 1000;
  function grApplyRules(r) {
    r = r || (typeof getRules === 'function' ? getRules() : null);
    if (!r) return;
    SIZE_CAP = r.sizeCap || 2; // fallback matches the documented hard rule, not the old stale 6
    COOLDOWN_MS = (r.cooldownMinutes || 15) * 60 * 1000;
  }
  grApplyRules(window.RULES);

  // 2026-08-16: dedicated alarm for the guardrail stop overlay — deliberately
  // NOT tvAudio (the existing TradingView-disconnect alarm). tvAudio is
  // silenced by a single document-wide click handler (any click anywhere
  // silences it, on the theory that a click means "I've seen it"). Reusing
  // that here would let this alarm die on an unrelated click — switching
  // tabs, scrolling the chart — long before he's actually acknowledged the
  // stop. This has its own lifecycle, silenced ONLY by grAckStop() succeeding
  // or grResetDay(). Reuses tvAudio's ensureCtx()/tone() (same AudioContext,
  // already unlocked via tvAudio.armOnFirstGesture()) rather than duplicating
  // the browser-autoplay-unlock handling, which was the exact bug (2026-08-12
  // note above tvAudio.armOnFirstGesture) that made the disconnect alarm
  // silently fail once already.
  const stopAlarm = {
    timer: null,
    repeats: 0,
    running: false,
    // Sharp double-beep, both tones HIGHER than tvAudio's descending
    // disconnect tone — deliberately distinct so which alarm is firing is
    // identifiable by ear alone, without looking at the screen.
    playTone(phase) {
      const ctx = tvAudio.ensureCtx();
      if (!ctx || ctx.state === 'suspended') return;
      const peak = phase === 2 ? 0.32 : 0.24; // phase 2 is louder, not just faster
      tvAudio.tone(1046, 0.00, 0.12, peak);
      tvAudio.tone(1046, 0.16, 0.12, peak);
      if (phase === 2) tvAudio.tone(1318, 0.32, 0.16, peak);
    },
    scheduleNext() {
      const delay = window.StopAlarm ? window.StopAlarm.nextAlarmDelayMs(this.repeats) : 30000;
      this.timer = setTimeout(() => {
        const canContinue = window.StopAlarm ? window.StopAlarm.shouldContinueAlarm(this.repeats) : this.repeats < 30;
        if (!this.running || !canContinue) { this.stop(); return; }
        this.repeats++;
        this.playTone(window.StopAlarm ? window.StopAlarm.alarmPhase(this.repeats) : 1);
        this.scheduleNext();
      }, delay);
    },
    start() {
      if (this.running) return; // idempotent — grShowStop() calls this every render tick
      this.running = true;
      this.repeats = 0;
      this.playTone(1);
      this.scheduleNext();
    },
    stop() {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.running = false;
      this.repeats = 0;
    }
  };

  let grNewsStatus = null;
  const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
  const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function summarize(s) {
    const n = s.trades.length, pnl = s.trades.reduce((a, t) => a + t.pnl, 0);
    const maxSize = s.trades.reduce((m, t) => Math.max(m, t.size), 0);
    const over = s.trades.filter(t => t.size > SIZE_CAP).length;
    const revenge = s.trades.filter(t => t.flags && t.flags.indexOf('revenge') >= 0).length;
    const disc = n ? Math.round(s.trades.reduce((a, t) => a + (t.pts || 0), 0) / (4 * n) * 100) : 0;
    return { date: s.date, n: n, pnl: pnl, maxSize: maxSize, over: over, revenge: revenge, disc: disc };
  }
  function archive(sum) { try { let h = JSON.parse(localStorage.getItem(HKEY) || '[]'); h = h.filter(e => e.date !== sum.date); h.push(sum); localStorage.setItem(HKEY, JSON.stringify(h.slice(-60))); if (window.api && window.api.dataSave) window.api.dataSave(slotDataKey('gr_history'), h.slice(-60)).catch(() => {}); } catch (e) {} }
  function load() {
    let s; try { s = JSON.parse(localStorage.getItem(GKEY)); } catch (e) {}
    if (s && s.date && s.date !== today() && s.trades && s.trades.length) archive(summarize(s));
    if (!s || s.date !== today()) s = { date: today(), trades: [], cooldownUntil: 0, stopped: false, stoppedAt: 0, acked: false, live: null, lastLossSeen: 0 };
    // A day carried over from before stoppedAt existed: stop-alarm.js's
    // ackDelayRemainingMs() fails OPEN (returns 0) on a missing timestamp, so
    // this is a display nicety, not a safety requirement. MUST persist the
    // stamp immediately, not just set it on the in-memory object — load() is
    // called fresh on every render tick, and an unpersisted stamp would be
    // recomputed to "now" every single call, making the countdown never
    // advance (every render would see a brand-new stoppedAt and report the
    // full delay remaining, forever).
    if (s.stopped && !s.stoppedAt) { s.stoppedAt = Date.now(); save(s); }
    return s;
  }
  function save(s) { localStorage.setItem(GKEY, JSON.stringify(s)); }
  window.grHistory = function () { try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch (e) { return []; } };
  window.grToday = function () { return summarize(load()); };
  window.grTodayTrades = function () { return load().trades; };
  // 2026-08-16: computeMechanicalGoNogo() previously had no notion of this
  // guardrail's own stop state — a HARD STOP banner + the full-screen
  // #gr-stop-overlay could fire here while the separate GO/NO-GO badge kept
  // showing GO or PENDING seconds later, because the two systems never
  // talked to each other. This is the bridge.
  window.grIsStopped = function () { return !!load().stopped; };

  function bodyReduced() { try { const b = (JSON.parse(localStorage.getItem('copilot_checklist_plan') || '{}').body) || {}; return b.sleep === 'poor' || b.nap === 'no'; } catch (e) { return false; } }
  // CHANGED 2026-07-28 (Anoop): was eval:2/funded:20 — now flat 10/day
  // (5/session × 2 sessions), same in both modes.
  const baseLimit = () => getRules().tradesPerDay || 10;
  const limit = () => bodyReduced() ? (baseLimit() <= 2 ? 1 : Math.ceil(baseLimit() / 2)) : baseLimit();
  // Tracks the last ratchet level shown so the banner fires on CHANGE only,
  // rather than on every HUD render (which runs on a timer).
  let grLastRatchetLevel = 'ok';
  let grLastVolumeLevel = 'ok';
  const baseDayStop = () => {
    const a = (typeof state !== 'undefined' && state.account) || {};
    const ds = (getRules().dayStop) || { eval: 300, funded: 200 };
    return state.mode === 'eval' ? (a.evalDayStop || ds.eval || 300) : (a.fundedDayStop || ds.funded || 200);
  };

  // ── LOSS RATCHET (2026-08-12, Anoop's own rule) ────────────────────────────
  // "If I make $500 profit today, tomorrow the maximum loss I should face is
  //  $500, not $600, $700 or $800."
  // Aimed squarely at the failure mode he named: a run of green days, then one
  // day that takes all of it back and ends the account.
  //
  // Implemented as min(normal stop, yesterday's profit) — see
  // renderer/loss-ratchet.js for why the literal version would have LOOSENED
  // risk after a big green day rather than tightening it.
  //
  // dayStop() keeps its old name and signature so every existing caller (the
  // HUD, the live-feed ingest, computeMechanicalGoNogo) picks the ratchet up
  // with no change — there is exactly ONE definition of "today's limit" in the
  // app, and this is it.
  // BUG FIX 2026-08-12, same day as the ratchet shipped — found by replaying it
  // against Anoop's real data. It read ONLY gr_history, but the two persistence
  // pipelines are independent:
  //   • gr_history      — written by the guardrail HUD when a day is ended/saved
  //   • balance_ledger  — written by the CSV/broker import
  // On the live account gr_history held ONE entry (last 2026-08-05) while
  // balance_ledger had five days through 2026-08-11. So "yesterday's profit"
  // would have been read from six days earlier — a cap computed from the wrong
  // day, silently. On a rule whose entire job is to stop him at the right
  // number, silently using stale input is worse than not having the rule.
  //
  // Now takes the most recent PRIOR day found in EITHER source. Prefers
  // balance_ledger's `net` when both have the same date, because net is
  // after commissions and that is the number that actually left the account —
  // the same gross-vs-net gap that made the HUD read -$637 while the broker
  // said -$855.50 on 08-10.
  const yesterdayPnl = () => {
    const candidates = [];
    try {
      const h = (window.grHistory ? window.grHistory() : []) || [];
      for (const d of h) if (d && d.date) candidates.push({ date: d.date, pnl: d.pnl || 0, src: 'gr' });
    } catch (e) {}
    try {
      const led = JSON.parse(localStorage.getItem('copilot_balance_ledger') || '{}') || {};
      for (const date of Object.keys(led)) {
        const v = led[date] || {};
        const pnl = (v.net != null) ? v.net : (v.gross != null ? v.gross : null);
        if (pnl != null) candidates.push({ date, pnl, src: 'ledger' });
      }
    } catch (e) {}
    const t = today();
    const prior = candidates.filter(c => c.date && c.date < t);
    if (!prior.length) return 0;
    // Latest date wins; on a tie the ledger (net, post-commission) wins.
    prior.sort((a, b) => a.date === b.date
      ? (a.src === 'ledger' ? 1 : -1)
      : (a.date < b.date ? -1 : 1));
    return prior[prior.length - 1].pnl || 0;
  };
  const ratchetInfo = () => {
    const cfg = (getRules().lossRatchet) || {};
    if (!window.LossRatchet) {
      // Fail SAFE, not open: if the module didn't load, fall back to the normal
      // stop rather than silently running with no cap at all.
      return { cap: baseDayStop(), capNegative: -baseDayStop(), tightened: false, source: 'dayStop', reason: 'loss-ratchet.js not loaded' };
    }
    return window.LossRatchet.computeCap(yesterdayPnl(), baseDayStop(), cfg);
  };
  const dayStop = () => ratchetInfo().cap;
  const banner = (t, c) => { if (typeof showAlertBanner === 'function') showAlertBanner(t, c); };
  function sessWindow() { const n = new Date(); const t = n.getUTCHours() * 60 + n.getUTCMinutes(); if (t >= 480 && t < 570) return 'london'; if (t >= 810 && t < 930) return 'ny'; return ''; }
  function gradeTrade(size, wasCooldown, inWin, blackout, holdSec) {
    const _R = getRules();
    const _isScalper = (_R.tradingMode || 'standard') === 'scalper';
    let pts = 0; const flags = [];
    if (size <= SIZE_CAP) pts++; else flags.push('oversize');
    if (!wasCooldown) pts++; else flags.push('revenge');
    if (inWin) pts++; else flags.push('out-of-window');
    // 4th slot: scalper checks hold time, standard checks news blackout
    if (_isScalper) {
      const maxH = _R.maxHoldSeconds || 1800;
      if (holdSec == null || holdSec <= maxH) pts++; else flags.push('hold-exceeded');
    } else {
      if (!blackout) pts++; else flags.push('news');
    }
    return { pts: pts, flags: flags, g: ['D', 'D', 'C', 'B', 'A'][pts] };
  }
  function nextNewsTxt() { if (!grNewsStatus || !grNewsStatus.upcoming || !grNewsStatus.upcoming.length) return ''; const e = grNewsStatus.upcoming[0], m = Math.round((e.ts - Date.now()) / 60000); if (m < 0 || m > 180) return ''; return 'next: ' + e.title + ' in ' + m + 'm'; }

  window.grLog = function () {
    const s = load();
    if (s.stopped) { grShowStop(s); return; }
    const sizeEl = document.getElementById('gr-size'), pnlEl = document.getElementById('gr-pnl');
    const size = parseInt(sizeEl.value, 10), pnl = parseFloat(pnlEl.value);
    if (!size || isNaN(pnl)) { sizeEl.style.borderColor = 'var(--red)'; return; }
    sizeEl.style.borderColor = '';
    const inCooldown = s.cooldownUntil > Date.now();
    const inWin = !!sessWindow(), blackout = !!window.grInBlackout;
    const grade = gradeTrade(size, inCooldown, inWin, blackout);
    // LESSON LOGGED 2026-07-28 (Anoop): the 150K eval breach was sizing UP
    // (5 lots, doubled to 10) WHILE ALREADY DOWN on the day — not just a
    // single oversize trade. Check this BEFORE pushing the new trade, using
    // the previous trade's size and the running P&L up to (not including)
    // this one, so it catches the exact pattern: bigger size than last time,
    // entered while the day is already red. This is now a forced hard stop,
    // same severity as hitting the daily loss limit.
    const prevTrade = s.trades[s.trades.length - 1];
    const runningBeforeThis = s.trades.reduce((a, t) => a + t.pnl, 0);
    const sizedUpWhileLosing = !!(prevTrade && size > prevTrade.size && runningBeforeThis < 0);
    // 2026-08-16 (Anoop, after the six-workflow-patterns build): distinct from
    // sizedUpWhileLosing above, which only fires when the DAY's cumulative
    // P&L is negative. This catches size rising right after the PRECEDING
    // trade specifically, even on a day that's still net positive from
    // earlier wins — the exact shape his own trade data showed drove more of
    // the funded drawdown than any single other pattern (trade immediately
    // after a loss: 42% win rate, -$1,197 net, avg size 3.6c vs 2.1c on the
    // day's first trade). See size-freeze-guard.js.
    const sizedUpAfterLoss = window.SizeFreezeGuard ? window.SizeFreezeGuard.sizeUpAfterLossViolation(s.trades, size) : false;
    s.trades.push({ t: Date.now(), size: size, pnl: pnl, g: grade.g, pts: grade.pts, flags: grade.flags });
    if (pnl < 0) s.cooldownUntil = Date.now() + COOLDOWN_MS;
    const dayPnl = s.trades.reduce((a, t) => a + t.pnl, 0);
    const wasStopped = s.stopped;
    if (dayPnl <= -dayStop()) s.stopped = true;
    if (sizedUpWhileLosing) s.stopped = true;
    if (sizedUpAfterLoss) s.stopped = true;
    if (s.stopped && !wasStopped) s.stoppedAt = Date.now();
    save(s); pnlEl.value = ''; sizeEl.value = ''; grRender();
    banner('Trade graded ' + grade.g + ' (' + grade.pts + '/4)' + (grade.flags.length ? ' — ' + grade.flags.join(', ') : ' — clean'), grade.pts >= 3 ? 'green' : grade.pts === 2 ? 'amber' : 'red');
    if (blackout) banner('You logged a trade during a NEWS BLACKOUT — the flash-crash setup.', 'red');
    if (size > SIZE_CAP) banner('SIZE VIOLATION — ' + size + ' > ' + SIZE_CAP + ' cap. The pattern that blew 8 accounts.', 'red');
    if (sizedUpWhileLosing) banner('SIZE-UP WHILE LOSING — ' + size + ' contracts after ' + prevTrade.size + ', day P&L ' + money(runningBeforeThis) + '. This is exactly what blew the 150K eval on 07-21. HARD STOP.', 'red');
    else if (sizedUpAfterLoss) banner('SIZE-UP RIGHT AFTER A LOSS — ' + size + ' contracts after a ' + money(prevTrade.pnl) + ' loss on ' + prevTrade.size + '. This is the single pattern that cost the most on the funded account. HARD STOP.', 'red');
    if (inCooldown) banner('Logged during the 15-min cooldown — the revenge re-entry that cost you.', 'red');
    if (s.stopped) { grShowStop(s); if (!sizedUpWhileLosing && !sizedUpAfterLoss) banner('DAILY STOP HIT (' + money(dayPnl) + ') — flatten and close Tradovate now.', 'red'); }
    else if (s.trades.length > limit()) banner('OVER LIMIT — ' + s.trades.length + ' trades, cap ' + limit() + '. Stop.', 'red');
    else if (s.trades.length === limit()) banner(limit() + ' trades used — you are DONE for the day.', 'red');
    else if (pnl < 0) banner('Loss logged — 15-min cooldown started. No re-entry.', 'amber');
  };

  // Tier-3: live-feed ingest. Server sends aggregated today numbers from real
  // fills (Tradovate REST, or — 2026-08-17 — the TradingView broker feed via
  // tv-broker-feed.js's balance-delta-at-flat fold); the SAME guards fire
  // automatically (no manual logging).
  window.grIngestLive = function (data) {
    const s = load();
    // 2026-08-18: data.success===false means the chart/CDP connection is up
    // but the broker Trading Panel itself isn't readable (not open / not
    // linked) — previously this silently produced the same s.live=null as a
    // normal "no trades yet" tick, so the feed could be dead for a whole
    // session with no visible signal. Surface it once per state transition.
    if (data && data.success === false) {
      if (!s.brokerFeedDown) {
        banner('LIVE BROKER FEED NOT READING — ' + (data.reason || 'Trading Panel not open or broker not linked') + '. Trades will not be tracked live until this is fixed.', 'red');
      }
      s.brokerFeedDown = true;
    } else if (data && data.connected) {
      s.brokerFeedDown = false;
    }
    s.live = data && data.connected ? { connected: true, tradeCount: data.tradeCount || 0, dayPnl: data.dayPnl || 0, maxSize: data.maxSize || 0, at: Date.now() } : null;
    if (s.live) {
      if (s.live.dayPnl <= -dayStop() && !s.stopped) { s.stopped = true; s.stoppedAt = Date.now(); banner('DAILY STOP HIT (' + money(s.live.dayPnl) + ') — flatten and close Tradovate now.', 'red'); }
      if (data.lastLossTs && data.lastLossTs > (s.lastLossSeen || 0)) { s.lastLossSeen = data.lastLossTs; s.cooldownUntil = data.lastLossTs + COOLDOWN_MS; banner('Live loss — 15-min cooldown started.', 'amber'); }
      if (s.live.maxSize > SIZE_CAP) banner('LIVE SIZE VIOLATION — ' + s.live.maxSize + ' > ' + SIZE_CAP + ' cap.', 'red');
      if (s.live.tradeCount >= limit()) banner(s.live.tradeCount + ' trades (live) — cap ' + limit() + '. Done.', 'red');
    }
    // 2026-08-17: size-freeze-guard now runs against LIVE-detected trades too,
    // not just manually logged ones — this closes the exact gap the CEO
    // review flagged ("you built a way to enter trades before finishing the
    // way to stop yourself"). data.trades is today's full ordered list from
    // the server fold; s.liveTrades is what this client has already scored.
    // Only the newly-arrived tail is ever evaluated against the guard, each
    // one checked against the trade immediately before it, in order —
    // mirrors grLog()'s sizedUpAfterLoss check exactly.
    if (Array.isArray(data && data.trades)) {
      const already = Array.isArray(s.liveTrades) ? s.liveTrades : [];
      if (data.trades.length > already.length) {
        let liveTrades = already.slice();
        for (let i = already.length; i < data.trades.length; i++) {
          const trade = data.trades[i];
          const violation = window.SizeFreezeGuard ? window.SizeFreezeGuard.sizeUpAfterLossViolation(liveTrades, trade.size) : false;
          liveTrades = liveTrades.concat([trade]);
          if (violation && !s.stopped) {
            s.stopped = true; s.stoppedAt = Date.now();
            const prevTrade = liveTrades[liveTrades.length - 2];
            banner('LIVE SIZE-UP RIGHT AFTER A LOSS — ' + trade.size + ' contracts after a ' + money(prevTrade.pnl) + ' loss on ' + prevTrade.size + '. HARD STOP.', 'red');
          }
        }
        s.liveTrades = liveTrades;
      }
    }
    // ── 2026-08-18 (Anoop: "let it read my DOM from TradingView ... it is
    // wrong every time") ─────────────────────────────────────────────────
    // The displayed account balance was NEVER read from TradingView's DOM —
    // it is always RECOMPUTED as startBalance + sum(ledger days) [+ today's
    // live P&L], by design (enforceAccountInvariant's "ledger wins"
    // invariant, added 2026-07-25 after a real corruption bug). That
    // invariant is correct and stays: this app tracks 5 independent virtual
    // slots that can share one real broker account, so blindly displaying
    // TradingView's raw total balance in place of a slot's own computed
    // number would break slot isolation the moment two slots point at the
    // same funded account.
    //
    // But "correct by design" isn't the same as "matches reality" — the
    // recompute can drift from what TradingView's own DOM literally shows
    // (commissions not in the CSV, a trade the fold missed, a timing gap).
    // Anoop keeps three monitors open specifically to catch this. Rather
    // than silently trust either number, surface both and flag a mismatch
    // loudly instead of letting him find it by eyeballing three screens.
    const domBalanceRaw = data && data.summary && data.summary.header && data.summary.header.balance;
    const domBalance = (typeof domBalanceRaw === 'string')
      ? Number(domBalanceRaw.replace(/−/g, '-').replace(/[^0-9.\-]/g, ''))
      : null;
    if (domBalance != null && Number.isFinite(domBalance) && state.account && typeof state.account.balance === 'number') {
      const diff = Math.round((state.account.balance - domBalance) * 100) / 100;
      s.domBalance = domBalance;
      s.domBalanceDiff = diff;
      s.domBalanceAt = Date.now();
      // $1 tolerance for rounding; a real drift is usually tens of dollars
      // (a missed trade, unlogged commission), not cents.
      if (Math.abs(diff) > 1) {
        if (!s.domMismatchNotified) {
          banner('LIVE FEED MISMATCH — TradingView\'s account balance reads ' + money(domBalance)
            + ', Co-Pilot\'s ledger math says ' + money(state.account.balance) + ' (off by ' + money(diff)
            + '). Trusting the ledger for THIS slot\'s numbers by design (5 slots can share one real account) — but check for a missing trade or commission.', 'amber');
          s.domMismatchNotified = true;
        }
      } else {
        s.domMismatchNotified = false;
      }
    }
    // 2026-08-19 (SEMI_AUTONOMOUS_SYSTEM_PLAN.md item 3, trade-count leg):
    // same style/philosophy as the balance mismatch banner above — VISIBILITY
    // only, s.live.tradeCount (used for enforcement) is untouched below.
    if (typeof data.tradeCountMismatch === 'boolean') {
      s.tradeCountMismatch = data.tradeCountMismatch;
      s.brokerFilledCount = data.brokerFilledCount;
      s.foldTradeCount = data.foldTradeCount;
      if (data.tradeCountMismatch) {
        if (!s.tradeCountMismatchNotified) {
          banner('LIVE FEED MISMATCH — broker\'s filled-order count reads ' + data.brokerFilledCount
            + ', Co-Pilot\'s trade tracker says ' + data.foldTradeCount
            + '. Not changing enforcement on this — but a real trade or fold miscount may be hiding here, check the orders table.', 'amber');
          s.tradeCountMismatchNotified = true;
        }
      } else {
        s.tradeCountMismatchNotified = false;
      }
    }
    save(s); grRender();
    // 2026-08-17: left panel (Balance/DD-Floor/Target) now also reacts to
    // every live tick — enforceAccountInvariant() (called inside
    // updateAccountUI) picks up today's live P&L from the SAME
    // copilot_guardrail_v1 state save() just wrote, when no CSV exists yet
    // for today. See enforceAccountInvariant's 2026-08-17 comment.
    if (typeof updateAccountUI === 'function') updateAccountUI();
  };

  // 2026-08-19 (SEMI_AUTONOMOUS_SYSTEM_PLAN.md item 5a): flagged twice as too
  // easy to hit accidentally — a single confirm() dialog wiped the hardened
  // stop (and the size-freeze-guard's trade history it reads for
  // sizeUpAfterLossViolation) with one misclick. When there's an ACTIVE
  // stopped state to clear, this now requires typing the same confirmation
  // phrase used by the daily-stop ack overlay ("i am done", grAckStop above)
  // instead of a single-click browser confirm — a plain reset with nothing
  // active to lose (day hasn't hit stop) stays a lightweight confirm(), since
  // there's nothing consequential being discarded in that case.
  window.grResetDay = function () {
    const cur = load();
    if (cur && cur.stopped) {
      const typed = prompt('This day is STOPPED. Resetting now clears the hardened stop AND today\'s size-freeze-guard trade history — a size-up-after-loss violation would no longer be caught for trades already logged.\n\nType "i am done" to confirm the reset:');
      if (!typed || typed.trim().toLowerCase() !== 'i am done') { banner('Reset cancelled — confirmation phrase did not match.', 'amber'); return; }
    } else if (!confirm('Reset today\'s guardrail counters (trades, cooldown, stop)?')) {
      return;
    }
    stopAlarm.stop(); const s = load(); const keep = s.live; localStorage.removeItem(GKEY); const ns = load(); ns.live = keep; save(ns); grRender(); const ov = document.getElementById('gr-stop-overlay'); if (ov) ov.style.display = 'none';
  };
  window.grAckStop = function () {
    const inp = document.getElementById('gr-stop-ack');
    if (inp && inp.disabled) return; // still inside the mandatory pause — see grShowStop()
    if (inp && inp.value.trim().toLowerCase() === 'i am done') {
      stopAlarm.stop();
      const s = load(); s.acked = true; save(s);
      const ov = document.getElementById('gr-stop-overlay'); if (ov) ov.style.display = 'none';
    } else if (inp) { inp.style.borderColor = 'var(--red)'; }
  };
  window.grNews = function (status) { grNewsStatus = status; window.grInBlackout = !!(status && status.inBlackout); grRender(); };
  // 2026-08-16: now drives the alarm and the mandatory ack-delay countdown,
  // on top of just toggling visibility. Called every render tick (~1s) while
  // a stop is active and unacked — start() is idempotent so this does not
  // restart the alarm's escalation timer on every call.
  function grShowStop(s) {
    const ov = document.getElementById('gr-stop-overlay'); if (!ov) return;
    ov.style.display = s.acked ? 'none' : 'flex';
    if (s.acked) { stopAlarm.stop(); return; }
    stopAlarm.start();
    const inp = document.getElementById('gr-stop-ack');
    const btn = document.getElementById('gr-stop-btn');
    const cd = document.getElementById('gr-stop-countdown');
    const remaining = window.StopAlarm ? window.StopAlarm.ackDelayRemainingMs(s.stoppedAt, Date.now()) : 0;
    const locked = remaining > 0;
    if (inp) inp.disabled = locked;
    if (btn) btn.disabled = locked;
    if (cd) cd.textContent = locked ? ('Read this. Acknowledgment unlocks in ' + Math.ceil(remaining / 1000) + 's…') : '';
  }

  window.grRender = function () {
    const bar = document.getElementById('gr-hud'); if (!bar) return;
    const s = load();
    const live = s.live && s.live.connected ? s.live : null;
    const count = live ? live.tradeCount : s.trades.length, lim = limit();
    const dayPnl = live ? live.dayPnl : s.trades.reduce((a, t) => a + t.pnl, 0);
    const maxSize = live ? live.maxSize : s.trades.reduce((m, t) => Math.max(m, t.size), 0);
    const disc = (!live && count) ? Math.round(s.trades.reduce((a, t) => a + (t.pts || 0), 0) / (4 * count) * 100) : null;
    const cd = s.cooldownUntil - Date.now();
    const reduced = bodyReduced();
    const stopped = s.stopped || (live && live.dayPnl <= -dayStop());
    const tag = live ? '● LIVE · ' : '';
    let txt, cls;
    if (stopped) { txt = tag + '⛔ STOPPED — DONE FOR THE DAY'; cls = 'gr-stop'; }
    else if (window.grInBlackout) { txt = tag + '🚫 NEWS BLACKOUT' + (grNewsStatus && grNewsStatus.activeEvent ? ' — ' + grNewsStatus.activeEvent.title : '') + ' — no entries'; cls = 'gr-stop'; }
    else if (cd > 0) { txt = tag + '⏳ COOLDOWN ' + mmss(cd) + ' — no entries'; cls = 'gr-cool'; }
    else if (count >= lim) { txt = tag + '⛔ ' + count + '/' + lim + ' TRADES — DONE'; cls = 'gr-stop'; }
    else { txt = tag + '✓ CLEAR — ' + count + '/' + lim + ' trades' + (reduced ? ' · REDUCED DAY' : ''); cls = reduced ? 'gr-cool' : 'gr-clear'; }
    document.getElementById('gr-state').textContent = txt;
    bar.className = 'gr-hud ' + cls;
    const nn = nextNewsTxt();
    let scTxt = '';
    try {
      const hh = window.grHistory ? window.grHistory() : [];
      const lastH = hh.length ? hh[hh.length - 1] : null;
      if (lastH && lastH.date === today() && typeof computeDayScore === 'function') {
        const cs = computeDayScore(lastH);
        if (cs) scTxt = ' · score ' + cs.score;
      }
      if (typeof loopState === 'function') {
        const ls = loopState();
        if (ls.goalDays) scTxt += ' · 🔁' + (ls.streak || 0) + '/' + ls.goalDays;
      }
    } catch (e) {}
    // 2026-08-11: label the SOURCE of the day number. On 08-10 the HUD read
    // "Day -$637" while the broker CSV said -$855.50 — because this figure is
    // the sum of trades Anoop typed in by hand, and two of the six never got
    // logged. The HUD cannot know about a trade it was never told about, but it
    // can stop presenting a hand-entered figure with the same authority as a
    // broker-verified one. '(manual — unverified)' is the honest label; the
    // '● LIVE' prefix already marks the broker-fed case. Fixing the underlying
    // gap needs the Tradovate feed validated (see tradovate.js NEEDS-VALIDATION
    // and task #29) — until then, assume this number is the floor, not the truth.
    const srcTag = live ? '' : ' · manual — unverified';

    // ── Loss-ratchet readout + warning (2026-08-12) ─────────────────────────
    // Anoop asked for "a warning when it reached previous day profit into loss".
    // Three tiers rather than a single hard stop, deliberately: a stop that
    // only speaks at the limit gives no moment to stand down BEFORE the
    // decision is taken out of his hands — and that window (down, not yet
    // stopped) is exactly where the 9-lot went on on 08-10.
    // The banner fires only on a level CHANGE, so it doesn't spam every render.
    // ── Contracts-per-day readout + warning (2026-08-12) ────────────────────
    // The variable his own five days actually split on. Shown next to size so
    // "2/2 per entry" can never again look fine while the day is at 24 total.
    let volTag = '';
    try {
      const vcfg = (getRules().contractsPerDay) || {};
      if (window.VolumeBudget && vcfg.enabled) {
        const used = window.VolumeBudget.contractsUsed(s.trades);
        const vs = window.VolumeBudget.volumeStatus(used, vcfg);
        volTag = ' · vol ' + used + '/' + vs.cap;
        if (vs.level !== 'ok' && vs.level !== grLastVolumeLevel) {
          grLastVolumeLevel = vs.level;
          banner(vs.text, vs.level === 'stop' ? 'red' : 'amber');
        } else if (vs.level === 'ok') {
          grLastVolumeLevel = 'ok';
        }
      }
    } catch (e) {}

    let ratchetTag = '';
    try {
      const ri = ratchetInfo();
      const st = window.LossRatchet
        ? window.LossRatchet.statusFor(dayPnl, ri, (getRules().lossRatchet) || {})
        : null;
      if (ri.tightened) ratchetTag = ' · RATCHET ' + money(-ri.cap) + ' (yday +' + money(yesterdayPnl()) + ')';
      if (st && st.level !== 'ok' && st.level !== grLastRatchetLevel) {
        grLastRatchetLevel = st.level;
        banner(st.text, st.level === 'stop' ? 'red' : 'amber');
      } else if (st && st.level === 'ok') {
        grLastRatchetLevel = 'ok';
      }
    } catch (e) {}

    // 2026-08-18/19: continuous reconciliation readout, not just a one-time
    // banner — Anoop keeps 3 monitors open specifically to spot-check this,
    // so the HUD should show it on every render, not just the moment it first
    // diverges. Only shown while live-connected and only past the $1 rounding
    // tolerance (see grIngestLive).
    const domTag = (live && s.domBalance != null && Math.abs(s.domBalanceDiff || 0) > 1)
      ? ' · ⚠ TV DOM ' + money(s.domBalance) + ' (Δ' + money(s.domBalanceDiff) + ')'
      : '';
    // 2026-08-19: same style as domTag above — trade-count reconciliation
    // (SEMI_AUTONOMOUS_SYSTEM_PLAN.md item 3).
    const tcTag = (live && s.tradeCountMismatch)
      ? ' · ⚠ COUNT broker ' + s.brokerFilledCount + ' vs tracked ' + s.foldTradeCount
      : '';
    document.getElementById('gr-meta').textContent = 'Day ' + money(dayPnl) + srcTag + ' · stop ' + money(-dayStop()) + ratchetTag + ' · size ' + (maxSize || 0) + '/' + SIZE_CAP + volTag + (disc !== null ? ' · disc ' + disc + '%' : '') + scTxt + (nn ? ' · ' + nn : '') + domTag + tcTag;
    const logWrap = document.getElementById('gr-logwrap'); if (logWrap) logWrap.style.opacity = live ? '0.4' : '1';
    if (stopped && !s.acked) grShowStop(s); else stopAlarm.stop();
  };

  function grInit() {
    if (document.getElementById('gr-hud')) return;
    const bar = document.createElement('div'); bar.id = 'gr-hud'; bar.className = 'gr-hud gr-clear';
    bar.innerHTML = '<div id="gr-state" class="gr-state">✓ CLEAR</div><div id="gr-meta" class="gr-meta"></div>'
      // 2026-08-17: persistent, always-visible indicator for a pending trade
      // ticket (Phase 2b) — GO verdicts can be rare, so the ticket card sitting
      // in the chat panel alone isn't enough; this stays lit until the ticket
      // is confirmed or dismissed, from anywhere in the app.
      + '<div id="gr-ticket-pill" class="gr-ticket-pill" style="display:none" onclick="tcScrollToPending()" title="Click to jump to the pending trade ticket">⚡ TRADE TICKET PENDING</div>'
      + '<div id="gr-logwrap" class="gr-log"><input id="gr-size" class="gr-in" type="number" min="1" placeholder="size"><input id="gr-pnl" class="gr-in" type="number" placeholder="P&L $"><button class="gr-btn" onclick="grLog()">Log trade</button><button class="gr-btn gr-reset" onclick="grResetDay()" title="reset day">↺</button></div>';
    document.body.appendChild(bar);
    const ov = document.createElement('div'); ov.id = 'gr-stop-overlay';
    // 2026-08-16: gr-stop-countdown shows the mandatory-pause message; the
    // input/button start disabled and grShowStop() unlocks them once
    // StopAlarm.ackDelayRemainingMs() reaches 0. id added to the button
    // (previously class-only) so grShowStop() can address it directly.
    ov.innerHTML = '<div class="gr-stop-box"><div class="gr-stop-title">⛔ DAILY STOP HIT</div><div class="gr-stop-sub">You are done trading today. Flatten every position and close Tradovate. The account you keep is worth more than the trade you skip.</div><div id="gr-stop-countdown" class="gr-stop-countdown"></div><input id="gr-stop-ack" class="gr-stop-inp" placeholder="type: i am done" disabled><button id="gr-stop-btn" class="gr-btn gr-stop-btn" onclick="grAckStop()" disabled>Acknowledge</button></div>';
    document.body.appendChild(ov);
    if (window.api && window.api.onNewsStatus) window.api.onNewsStatus(grNews);
    if (window.api && window.api.onTradovateAccount) window.api.onTradovateAccount(grIngestLive);
    // 2026-08-17: tv-broker-account carries the same aggregated
    // connected/tradeCount/dayPnl/maxSize/lastLossTs/trades fields
    // grIngestLive already expects (see tv-broker-feed.js), plus raw
    // summary/positions/orders this guard doesn't need — passing the whole
    // message through is safe, grIngestLive only reads the fields it knows.
    if (window.api && window.api.onTvBrokerAccount) window.api.onTvBrokerAccount(grIngestLive);
    if (window.api && window.api.onRules) window.api.onRules(grApplyRules);
    grRender(); setInterval(grRender, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', grInit); else grInit();
})();


// ── Tier-3: Insights (weekly scorecard · today mirror · readiness vs outcome · consistency) ──
function insScorecard(hist) {
  const days = hist.length;
  if (!days) return null;
  const totTrades = hist.reduce((a, d) => a + (d.n || 0), 0);
  const over = hist.reduce((a, d) => a + (d.over || 0), 0);
  const revenge = hist.reduce((a, d) => a + (d.revenge || 0), 0);
  const disc = Math.round(hist.reduce((a, d) => a + (d.disc || 0), 0) / days);
  const green = hist.filter(d => (d.pnl || 0) > 0).length;
  const overLimitDays = hist.filter(d => (d.n || 0) > 2).length;
  const pnls = hist.map(d => d.pnl || 0);
  const best = Math.max.apply(null, pnls), worst = Math.min.apply(null, pnls);
  const net = pnls.reduce((a, b) => a + b, 0);
  return { days, totTrades, avgTrades: (totTrades / days), over, revenge, disc, green, overLimitDays, best, worst, net };
}
function insMoney(n) { return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString(); }
// Lazily loads data/account_archives.json (written by archiveActiveBucket())
// so the Insights tab can surface past breached/cleared accounts without
// blocking the first synchronous render. archiveActiveBucket() also updates
// this cache directly right after a fresh archive, so the very next
// renderInsights() call (fired right after accountBreached() resets the UI)
// already has it without a refetch.
let ARCHIVE_CACHE = null;
async function loadArchives() {
  if (ARCHIVE_CACHE !== null) return ARCHIVE_CACHE;
  let a = [];
  try { if (window.api && window.api.dataLoad) a = await window.api.dataLoad('account_archives'); } catch (e) {}
  if (!Array.isArray(a)) a = [];
  ARCHIVE_CACHE = a;
  return a;
}
// ── Account journeys view (2026-08-16) ──────────────────────────────────────
// The single-dataset eval→funded lifecycle record (journey-tracker.js),
// replacing the old per-click account_archives.json as the primary picture:
// one card per attempt, eval and funded phases on the SAME card so they can
// never be read as two unrelated accounts. Same lazy-cache-then-rerender
// shape as loadArchives()/insArchiveBlock() just below it.
let JOURNEY_CACHE = null;
async function loadJourneys() {
  if (JOURNEY_CACHE !== null) return JOURNEY_CACHE;
  let j = [];
  try { if (window.api && window.api.journeyList) j = await window.api.journeyList(); } catch (e) {}
  if (!Array.isArray(j)) j = [];
  JOURNEY_CACHE = j;
  return j;
}
function journeyPhase(j) {
  if (j.funded) return j.funded.status === 'breached' ? 'FUNDED_BREACHED' : 'FUNDED';
  if (j.eval.status === 'breached') return 'EVAL_BREACHED';
  return 'EVAL';
}
function journeyPhaseLabel(phase) {
  return { EVAL: '🟦 EVAL — in progress', EVAL_BREACHED: '📉 EVAL BREACHED', FUNDED: '🎯 FUNDED — live', FUNDED_BREACHED: '📉 FUNDED BREACHED' }[phase] || phase;
}
function journeyMoney(n) { return n == null ? '—' : costMoney(n); }
function insJourneyBlock() {
  if (JOURNEY_CACHE === null) { loadJourneys().then(() => { if (typeof renderInsights === 'function') renderInsights(); }); return ''; }
  if (!JOURNEY_CACHE.length) return '';
  const rows = JOURNEY_CACHE.slice().reverse().map(j => {
    const phase = journeyPhase(j);
    const evCls = (phase === 'EVAL_BREACHED' || phase === 'FUNDED_BREACHED') ? 'ins-bad' : 'ins-good';
    const sizeLabel = (ACCOUNT_PROFILES[j.size] && ACCOUNT_PROFILES[j.size].label) || j.size || '?';
    const head = costEsc(sizeLabel) + ' · ' + costEsc(j.slotId || '') + ' · ' + journeyPhaseLabel(phase);

    const evalLine = '<div class="ins-daymetrics"><span>Eval: ' + j.eval.status
      + (j.eval.startBalance != null ? ', start ' + journeyMoney(j.eval.startBalance) : '')
      + (j.eval.finalBalance != null ? ', ended ' + journeyMoney(j.eval.finalBalance) : '')
      + (j.eval.startedAt ? ', ' + fmtDMY(j.eval.startedAt.slice(0, 10)) : '') + '</span></div>';

    let fundedLine = '';
    if (j.funded) {
      const payouts = j.funded.payouts || [];
      const total = payouts.reduce((s, p) => s + (p.amount || 0), 0);
      fundedLine = '<div class="ins-daymetrics"><span>Funded: ' + j.funded.status
        + (j.funded.startedAt ? ', ' + fmtDMY(j.funded.startedAt.slice(0, 10)) : '')
        + '</span><span>' + payouts.length + ' payout' + (payouts.length === 1 ? '' : 's') + (total ? ', ' + journeyMoney(total) + ' total' : '') + '</span></div>';
      if (payouts.length) {
        fundedLine += '<div class="ins-note-good">' + payouts.map(p => '✓ ' + fmtDMY(p.date) + ' ' + journeyMoney(p.amount)).join('&nbsp;&nbsp;') + '</div>';
      }
    }
    return '<div class="ins-day"><div class="ins-day-head ' + evCls + '">' + head + '</div>' + evalLine + fundedLine + '</div>';
  }).join('');
  return '<div class="analysis-block"><div class="block-title">Account Journeys — Eval → Funded</div>' + rows + '</div>';
}
function insArchiveBlock() {
  if (ARCHIVE_CACHE === null) { loadArchives().then(() => { if (typeof renderInsights === 'function') renderInsights(); }); return ''; }
  if (!ARCHIVE_CACHE.length) return '';
  const rows = ARCHIVE_CACHE.slice().reverse().map(rec => {
    const isBreach = rec.event === 'breached';
    const evLabel = isBreach ? '📉 BREACHED' : '🎯 CLEARED → FUNDED';
    const evCls = isBreach ? 'ins-bad' : 'ins-good';
    const les = rec.lessons || {};
    const mistakes = (les.mistakes || []).map(m => '<div class="ins-note-bad">✗ ' + costEsc(m) + '</div>').join('');
    const positives = (les.positives || []).map(m => '<div class="ins-note-good">✓ ' + costEsc(m) + '</div>').join('');
    const dateStr = rec.archivedAt ? fmtDMY(rec.archivedAt.slice(0, 10)) : '';
    const head = costEsc(rec.label) + ' · ' + dateStr + ' · ' + evLabel;
    const metrics = '<div class="ins-daymetrics"><span>' + (les.totalTrades || 0) + ' trades</span><span>' + (les.totalDays || 0) + ' days</span>'
      + (les.avgDisc != null ? '<span>avg disc ' + les.avgDisc + '%</span>' : '') + '</div>';
    return '<div class="ins-day"><div class="ins-day-head ' + evCls + '">' + head + '</div>' + metrics
      + (mistakes || positives ? (mistakes + positives) : '<div class="ins-note">No day-level history was logged before this account was archived.</div>')
      + '</div>';
  }).join('');
  return '<div class="analysis-block"><div class="block-title">Past Accounts (Archive)</div>' + rows + '</div>';
}
function renderInsights() {
  const el = document.getElementById('ins-body'); if (!el) return;
  const hist = (typeof grHistory === 'function' ? grHistory() : []).slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const acc = state.account;
  if (!hist.length) { el.innerHTML = '<div class="no-trades">No days logged yet. Upload your Performance reports (Update File) — each day is analyzed separately.</div>' + insJourneyBlock() + insArchiveBlock() + insClearBtn(); return; }
  let h = '';
  h += insJourneyBlock();
  h += insLoopBlock();
  h += insScoreBlock(hist);
  h += insRedDayBlock(hist);
  h += insPlaybookBlock();
  h += insMaeMfeBlock();
  h += insProse(hist, acc);
  h += insPassMath(hist, acc);
  h += insScoreCardBlock(hist);
  h += '<div class="analysis-block"><div class="block-title">Day by day</div>' + hist.slice().reverse().map(insDeepCard).join('') + '</div>';
  h += insArchiveBlock();
  h += insClearBtn();
  el.innerHTML = h;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtDur(sec) { sec = Math.round(sec || 0); return sec < 90 ? sec + 's' : Math.round(sec / 60) + 'm'; }
function insClearBtn() { return '<div style="margin-top:12px"><button class="btn-cancel" style="width:100%;border-color:var(--red);color:var(--red)" onclick="grClearInsights()">✕ Clear all insights (re-upload to rebuild)</button></div>'; }
window.grClearInsights = function () {
  if (!confirm('Clear ALL insights, history, and the balance ledger? Re-upload your CSVs to rebuild.')) return;
  ['copilot_gr_history', 'copilot_balance_ledger', 'copilot_ck_history', 'copilot_guardrail_v1'].forEach(k => localStorage.removeItem(k));
  if (typeof grRender === 'function') grRender();
  renderInsights();
  addSystemMessage('Insights cleared. Upload your Performance CSVs to rebuild the analysis from scratch.');
};

function insCoachNotes(r) {
  const notes = [];
  if (r.dow >= 2 && r.dow <= 4) notes.push({ c: 'good', t: 'Prime day (' + DOW[r.dow] + ', NY session) — higher risk OK once your bias is confirmed.' });
  else if (r.dow === 1 || r.dow === 5) notes.push({ c: 'warn', t: DOW[r.dow] + ' is lower-volume — cut size and trade count; avoid Mon-AM / Fri-PM chop.' });
  if (r.n > 20) notes.push({ c: 'bad', t: r.n + ' trades — over your 20 cap. Machine-gunning; this is the flag.' });
  else if (r.n > 12) notes.push({ c: 'warn', t: r.n + ' trades — getting high; quality over quantity.' });
  if (r.medHold < 300) notes.push({ c: 'warn', t: 'Median hold ' + fmtDur(r.medHold) + ' — faster than your 5-10min plan; you exit winners too early.' });
  else if (r.over15 > 0) notes.push({ c: 'warn', t: r.over15 + ' trade(s) held >15min — past your max.' });
  else notes.push({ c: 'good', t: 'Holds in your 5-15min band — good.' });
  if (r.firstThreeMax > 6) notes.push({ c: 'bad', t: 'Started big (' + r.firstThreeMax + 'c in first 3 trades) — start small, size up only after bias confirms.' });
  if (r.sizedUpIntoLoss) notes.push({ c: 'bad', t: 'Increased size while the day was red — sizing up into a loser.' });
  else if (r.bigAfterWins) notes.push({ c: 'good', t: 'Biggest size came after wins — correct pyramiding.' });
  if (r.revenge > 0) notes.push({ c: 'warn', t: r.revenge + ' revenge re-entr' + (r.revenge === 1 ? 'y' : 'ies') + ' (<15min after a loss).' });
  if (r.losses && r.wins && Math.abs(r.avgLoss) > r.avgWin) notes.push({ c: 'bad', t: 'Avg loss $' + Math.abs(Math.round(r.avgLoss)) + ' > avg win $' + Math.round(r.avgWin) + ' — inverted R:R. Winners must be bigger than losers, point blank.' });
  if ((r.flips || 0) >= 2) notes.push({ c: 'bad', t: r.flips + ' direction flip-flops (<15min) — you traded BOTH sides. One bias per day; a quick flip is revenge, not analysis.' });
  else if ((r.flips || 0) === 1) notes.push({ c: 'warn', t: '1 quick direction flip — watch it; the second one is where tilt starts.' });
  if (r.tradedPast3Losses) notes.push({ c: 'bad', t: 'Kept trading after 3 consecutive losses — that is the off-the-desk moment, not the push-through moment.' });
  else if ((r.maxConsecLoss || 0) >= 3) notes.push({ c: 'warn', t: r.maxConsecLoss + ' consecutive losses — streaks are normal probability; the job is stopping, not winning it back.' });
  // Process vs outcome (JadeCap): the grade is the process, not the P&L
  if (r.pnl < 0 && r.disc >= 85 && !r.over && (r.flips || 0) === 0) notes.push({ c: 'good', t: 'RED DAY, CLEAN PROCESS — this is an A day in disguise. Do it again tomorrow.' });
  if (r.pnl > 0 && (r.over > 0 || (r.flips || 0) >= 2 || r.disc < 55)) notes.push({ c: 'bad', t: 'GREEN P&L, BROKEN PROCESS — a failure in disguise. This is how the 6 accounts died.' });
  return notes;
}
function insDeepCard(r) {
  const dow = r.dow !== undefined ? DOW[r.dow] : '';
  const pnlCls = r.pnl >= 0 ? 'ins-good' : 'ins-bad';
  const cs = computeDayScore(r);
  const cause = classifyRedDay(r);
  const head = fmtDM(r.date) + ' ' + dow + ' · ' + insMoney(r.pnl) + ' · ' + r.n + ' trades'
    + (cs ? ' · score ' + cs.score : '') + (cause ? ' · ' + cause : '');
  let metrics = '';
  if (r.avgHold !== undefined) metrics = '<div class="ins-daymetrics"><span>max ' + r.maxSize + 'c</span><span>hold ~' + fmtDur(r.medHold) + '</span><span>gap ~' + fmtDur(r.avgGap) + '</span><span>best ' + insMoney(r.best) + '</span><span>worst ' + insMoney(r.worst) + '</span><span>disc ' + r.disc + '%</span></div>';
  else metrics = '<div class="ins-daymetrics"><span>max ' + (r.maxSize || '?') + 'c</span><span>disc ' + (r.disc || 0) + '%</span></div>';
  const notes = (r.dow !== undefined ? insCoachNotes(r) : []).map(n => '<div class="ins-note-' + n.c + '">' + (n.c === 'good' ? '✓' : n.c === 'warn' ? '▲' : '✗') + ' ' + n.t + '</div>').join('');
  return '<div class="ins-day"><div class="ins-day-head ' + pnlCls + '">' + head + '</div>' + metrics + notes + '</div>';
}
function insPassMath(hist, acc) {
  const mode = state.mode, start = mode === 'eval' ? 150000 : 50000;
  const floor = mode === 'eval' ? acc.evalFloor : acc.fundedFloor;
  const target = mode === 'eval' ? (acc.evalTarget || 159000) : start + 3000;
  const cushion = acc.balance - floor, profit = acc.balance - start;
  const pos = hist.filter(d => d.pnl > 0).map(d => d.pnl);
  const largest = pos.length ? Math.max.apply(null, pos) : 0;
  const consistency = profit > 0 ? Math.round(largest / profit * 100) : null;
  const cc = cushion < 1500 ? 'ins-bad' : cushion < 2500 ? 'ins-warn' : 'ins-good';
  return '<div class="analysis-block"><div class="block-title">Pass Math</div><div class="ins-grid">'
    + insCard('Cushion to breach', insMoney(cushion), cc)
    + insCard('To target', insMoney(Math.max(0, target - acc.balance)), '')
    + insCard('Consistency', consistency === null ? '—' : consistency + '% / 50%', consistency !== null && consistency > 50 ? 'ins-bad' : 'ins-good')
    + insCard('Net (eval days)', insMoney(profit), profit >= 0 ? 'ins-good' : 'ins-bad')
    + '</div><div class="ins-note">Balance counts eval days (07/08 on). Upload complete daily exports so it matches Lucid.</div></div>';
}
function insScoreCardBlock(hist) {
  const wk = insScorecard(hist.slice(-7)); if (!wk) return '';
  // Top-line health metric (JadeCap: "winners bigger than losers = profitable, point blank")
  const h7 = hist.slice(-7);
  const totW = h7.reduce((a, d) => a + (d.wins || 0), 0), totL = h7.reduce((a, d) => a + (d.losses || 0), 0);
  const aW = totW ? h7.reduce((a, d) => a + (d.avgWin || 0) * (d.wins || 0), 0) / totW : 0;
  const aL = totL ? Math.abs(h7.reduce((a, d) => a + (d.avgLoss || 0) * (d.losses || 0), 0) / totL) : 0;
  const wl = aL > 0 ? (aW / aL) : null;
  const flips7 = h7.reduce((a, d) => a + (d.flips || 0), 0);
  return '<div class="analysis-block"><div class="block-title">Scorecard — last ' + wk.days + ' day' + (wk.days === 1 ? '' : 's') + '</div><div class="ins-grid">'
    + insCard('Avg win : avg loss', wl === null ? '—' : '$' + Math.round(aW) + ' : $' + Math.round(aL) + ' (' + wl.toFixed(2) + 'x)', wl === null ? '' : wl >= 1.3 ? 'ins-good' : wl >= 1 ? 'ins-warn' : 'ins-bad')
    + insCard('Direction flips', String(flips7), flips7 ? 'ins-bad' : 'ins-good')
    + insCard('Avg trades/day', wk.avgTrades.toFixed(1), wk.avgTrades > 20 ? 'ins-bad' : wk.avgTrades > 12 ? 'ins-warn' : 'ins-good')
    + insCard('Days over 20', String(hist.filter(d => d.n > 20).length), hist.filter(d => d.n > 20).length ? 'ins-bad' : 'ins-good')
    + insCard('Over-6 size trades', String(wk.over), wk.over ? 'ins-warn' : 'ins-good')
    + insCard('Revenge re-entries', String(wk.revenge), wk.revenge ? 'ins-bad' : 'ins-good')
    + insCard('Avg discipline', wk.disc + '%', wk.disc >= 75 ? 'ins-good' : wk.disc >= 50 ? 'ins-warn' : 'ins-bad')
    + insCard('Green days', wk.green + '/' + wk.days, '')
    + insCard('Best day', insMoney(wk.best), 'ins-good')
    + insCard('Worst day', insMoney(wk.worst), 'ins-bad')
    + '</div></div>';
}
function insProse(hist, acc) {
  const enr = hist.filter(d => d.dow !== undefined);
  const avg = arr => arr.length ? arr.reduce((a, d) => a + d.pnl, 0) / arr.length : 0;
  const prime = enr.filter(d => d.dow >= 2 && d.dow <= 4), low = enr.filter(d => d.dow === 1 || d.dow === 5);
  const parts = [];
  parts.push(hist.length + ' day' + (hist.length === 1 ? '' : 's') + ' logged · net ' + insMoney(hist.reduce((a, d) => a + d.pnl, 0)) + '.');
  if (prime.length) parts.push('Prime days (Tue–Thu, NY): avg ' + insMoney(avg(prime)) + '/day over ' + prime.length + '. This is where your edge should live — concentrate risk here.');
  if (low.length) parts.push('Low-vol days (Mon/Fri): avg ' + insMoney(avg(low)) + '/day. ' + (avg(low) < avg(prime) ? 'Weaker, as expected — trade these small or sit out.' : 'Keep size down regardless; the volume is not there.'));
  const bad = [].concat.apply([], enr.map(insCoachNotes)).filter(n => n.c === 'bad');
  const freq = {}; bad.forEach(n => { const k = n.t.split('—')[0].trim(); freq[k] = (freq[k] || 0) + 1; });
  const top = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
  if (top) parts.push('Most-repeated mistake: ' + top + ' (' + freq[top] + '×). Fix this one first.');
  const rem = Math.max(0, (acc.evalTarget || 159000) - acc.balance), pAvg = avg(prime);
  if (pAvg > 0) parts.push('At ' + insMoney(pAvg) + '/prime-day, the ' + insMoney(rem) + ' to target is ~' + Math.ceil(rem / pAvg) + ' prime days (~' + Math.max(1, Math.ceil(rem / pAvg / 3)) + ' weeks). Protect the cushion and it is very doable.');
  return '<div class="analysis-block"><div class="block-title">Coach’s Notes</div><div class="ins-prose">' + parts.map(x => '<p>' + x + '</p>').join('') + '</div>'
    + '<div class="ins-do"><b>Do</b> — start 2–4 lots; add to 8–12 only after 2 confirming candles + aligned bias; trade NY Tue–Thu; aim 5–10min holds.</div>'
    + '<div class="ins-dont"><b>Don’t</b> — open big, size up while red, revenge inside 15min, or push past 20 trades. Mon-AM & Fri-PM: smallest size or sit out.</div></div>';
}
function insCard(k, v, cls) { return '<div class="ins-card ' + (cls || '') + '"><div class="ins-k">' + k + '</div><div class="ins-v">' + v + '</div></div>'; }

// ═══ Feature 1: Co-Pilot Score (0–100) — rule adherence 40 · risk 30 · edge 20 · process 10 ═══
function computeDayScore(r) {
  if (!r || r.disc === undefined) return null;
  const RULES = getRules();
  const maxLoss = RULES.perTradeMaxLoss || 200;
  const gb = RULES.giveback || { armAtProfit: 400, retracePct: 50 };
  const ruleAdh = Math.max(0, Math.min(100, r.disc || 0));
  let risk = 100;
  if (r.worst !== undefined && r.worst <= -maxLoss) risk -= 50;
  if (r.peak !== undefined && r.peak >= gb.armAtProfit && r.giveback >= r.peak * (gb.retracePct / 100)) risk -= 50;
  risk = Math.max(0, risk);
  let edge = 50;
  const gw = (r.wins || 0) * (r.avgWin || 0), gl = (r.losses || 0) * Math.abs(r.avgLoss || 0);
  if (gl > 0) edge = Math.max(0, Math.min(100, (gw / gl) * 50));
  else if (gw > 0) edge = 100;
  let process = 0;
  try {
    const ckh = JSON.parse(localStorage.getItem('copilot_ck_history') || '[]');
    if (ckh.some(e => e.date === r.date)) process = 100;
  } catch (e) {}
  const score = Math.round(0.4 * ruleAdh + 0.3 * risk + 0.2 * edge + 0.1 * process);
  return { score: score, ruleAdh: Math.round(ruleAdh), risk: risk, edge: Math.round(edge), process: process };
}
function insScoreBlock(hist) {
  const last = hist[hist.length - 1];
  const cs = computeDayScore(last);
  if (!cs) return '';
  const last7 = hist.slice(-7).map(d => ({ date: d.date, s: (computeDayScore(d) || {}).score })).filter(x => x.s !== undefined);
  const avg7 = last7.length ? Math.round(last7.reduce((a, x) => a + x.s, 0) / last7.length) : cs.score;
  const prev = last7.length > 1 ? last7[last7.length - 2].s : null;
  const arrow = prev === null ? '' : cs.score > prev ? ' ▲' : cs.score < prev ? ' ▼' : ' —';
  const cls = s => s >= 75 ? 'ins-good' : s >= 50 ? 'ins-warn' : 'ins-bad';
  const bars = last7.map(x => '<span title="' + fmtDMY(x.date) + ': ' + x.s + '" style="display:inline-block;width:18px;margin-right:3px;text-align:center;border-radius:3px;padding:2px 0;font-size:10px;background:' + (x.s >= 75 ? 'var(--green-dim)' : x.s >= 50 ? 'var(--amber-dim)' : 'var(--red-dim)') + '">' + x.s + '</span>').join('');
  const letter = cs.score >= 85 ? 'A' : cs.score >= 70 ? 'B' : cs.score >= 55 ? 'C' : 'D';
  // JadeCap: grade the PROCESS, not the P&L
  let procLine = '';
  if (last.pnl < 0 && cs.score >= 70) procLine = '<div class="ins-note-good">✓ Red P&L but grade ' + letter + ' — you followed the process. That IS a win. Repeat it.</div>';
  else if (last.pnl > 0 && cs.score < 55) procLine = '<div class="ins-note-bad">✗ Green P&L on a grade-' + letter + ' process — a failure in disguise. The market paid you for a mistake; do not learn from the payment.</div>';
  return '<div class="analysis-block"><div class="block-title">Co-Pilot Score — ' + fmtDM(last.date) + ' · Process grade ' + letter + '</div>' + procLine + '<div class="ins-grid">'
    + insCard('Score', cs.score + '/100' + arrow, cls(cs.score))
    + insCard('7-day avg', String(avg7), cls(avg7))
    + insCard('Rules 40%', cs.ruleAdh + '', cls(cs.ruleAdh))
    + insCard('Risk 30%', cs.risk + '', cls(cs.risk))
    + insCard('Edge 20%', cs.edge + '', cls(cs.edge))
    + insCard('Process 10%', cs.process ? '✓ checklist' : '✗ no checklist', cs.process ? 'ins-good' : 'ins-bad')
    + '</div><div style="margin-top:8px">' + bars + '</div>'
    + '<div class="ins-note">Rules = per-trade discipline points. Risk = no tail-loss, no giveback. Edge = profit factor. Process = checklist done. 1% better every day = this number, not P&L.</div></div>';
}

// ═══ Feature 2: Red-day auto-categorization ═══
function classifyRedDay(r) {
  if (!r || r.pnl >= 0) return null;
  const RULES = getRules();
  const maxLoss = RULES.perTradeMaxLoss || 200;
  const gb = RULES.giveback || { armAtProfit: 400, retracePct: 50 };
  if (r.worst !== undefined && r.worst <= -maxLoss && Math.abs(r.worst) >= Math.abs(r.pnl) * 0.5) return 'TAIL-LOSS';
  if (r.peak !== undefined && r.peak >= gb.armAtProfit && r.giveback >= r.peak * (gb.retracePct / 100)) return 'GIVEBACK';
  if (r.over > 0) return 'OVERSIZE';
  if ((r.revenge || 0) >= 3 || (r.flips || 0) >= 2) return 'REVENGE';
  if ((r.n || 0) > (RULES.scorerTradesPerDayLimit || 20)) return 'OVERTRADE';
  if (r.worst !== undefined && r.worst <= -maxLoss) return 'TAIL-LOSS';
  return 'GRIND';
}
function insRedDayBlock(hist) {
  const reds = hist.filter(d => d.pnl < 0);
  if (!reds.length) return '';
  const freq = {}, dollars = {};
  reds.forEach(d => { const c = classifyRedDay(d); freq[c] = (freq[c] || 0) + 1; dollars[c] = (dollars[c] || 0) + d.pnl; });
  const top = Object.keys(freq).sort((a, b) => freq[b] - freq[a]);
  const cards = top.map(c => insCard(c, freq[c] + '× · ' + insMoney(dollars[c]), 'ins-bad')).join('');
  const meanings = { 'TAIL-LOSS': 'one trade ate the day — enforce the per-trade cap', 'GIVEBACK': 'won then gave it back — lock the day at 50% retrace', 'OVERSIZE': 'size over the cap did the damage', 'REVENGE': 'loss-chase re-entries', 'OVERTRADE': 'too many trades, commissions + chop', 'GRIND': 'slow bleed — no single villain, just no edge that day' };
  return '<div class="analysis-block"><div class="block-title">Why your red days happen</div>'
    + '<div class="ins-prose"><p><b>' + freq[top[0]] + ' of ' + reds.length + ' red day' + (reds.length === 1 ? '' : 's') + ' = ' + top[0] + '</b> — ' + (meanings[top[0]] || '') + '. Fix this one first.</p></div>'
    + '<div class="ins-grid">' + cards + '</div></div>';
}

// ═══ Feature 3: Playbook tagging → per-setup stats ═══
function pbTags() { try { return JSON.parse(localStorage.getItem('copilot_pb_tags') || '{}'); } catch (e) { return {}; } }
function pbDayTrades() { try { return JSON.parse(localStorage.getItem('copilot_day_trades') || '{}'); } catch (e) { return {}; } }
window.pbTag = function (key, val) {
  const tags = pbTags();
  if (val) tags[key] = val; else delete tags[key];
  localStorage.setItem('copilot_pb_tags', JSON.stringify(tags));
  if (window.api && window.api.dataSave) window.api.dataSave(slotDataKey('pb_tags'), tags).catch(() => {});
  renderInsights();
};
window.pbSelDate = function (d) { window._pbDate = d; renderInsights(); };
function insPlaybookBlock() {
  const dt = pbDayTrades();
  const dates = Object.keys(dt).sort();
  if (!dates.length) return '';
  const tags = pbTags();
  // Per-playbook stats across ALL tagged trades
  const PB = { A: 'A · Engulf+4H', B: 'B · SFP+FVG', C: 'C · Liq raid' };
  const agg = {};
  dates.forEach(d => (dt[d] || []).forEach(t => {
    const tag = tags[d + '|' + t.t]; if (!tag) return;
    const a = agg[tag] = agg[tag] || { n: 0, w: 0, gw: 0, gl: 0, pnl: 0, hold: 0 };
    a.n++; a.pnl += t.pnl; a.hold += (t.hold || 0);
    if (t.pnl > 0) { a.w++; a.gw += t.pnl; } else a.gl += Math.abs(t.pnl);
  }));
  let stats = '';
  Object.keys(PB).forEach(k => {
    const a = agg[k]; if (!a) return;
    const pf = a.gl > 0 ? (a.gw / a.gl).toFixed(2) : (a.gw > 0 ? '∞' : '—');
    stats += insCard(PB[k], a.n + ' trades · ' + Math.round(a.w / a.n * 100) + '% WR · PF ' + pf + ' · ' + insMoney(a.pnl) + ' · hold ' + fmtDur(a.hold / a.n), a.pnl >= 0 ? 'ins-good' : 'ins-bad');
  });
  // Tagging UI for a selected day (default: latest)
  const sel = window._pbDate && dt[window._pbDate] ? window._pbDate : dates[dates.length - 1];
  const dateOpts = dates.slice(-10).reverse().map(d => '<option value="' + d + '"' + (d === sel ? ' selected' : '') + '>' + d + '</option>').join('');
  const fmtT = ms => { const dd = new Date(ms); return String(dd.getHours()).padStart(2, '0') + ':' + String(dd.getMinutes()).padStart(2, '0'); };
  const untagged = (dt[sel] || []).filter(t => !tags[sel + '|' + t.t]).length;
  const rows = (dt[sel] || []).map(t => {
    const key = sel + '|' + t.t, cur = tags[key] || '';
    const opts = ['', 'A', 'B', 'C'].map(v => '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + (v || '—') + '</option>').join('');
    return '<div style="display:flex;gap:8px;align-items:center;font-size:11px;padding:3px 0;border-bottom:1px solid var(--border)">'
      + '<span style="width:42px">' + fmtT(t.t) + '</span><span style="width:44px">' + (t.side || '?') + '</span><span style="width:30px">' + t.size + 'c</span>'
      + '<span style="width:64px;color:' + (t.pnl >= 0 ? 'var(--green)' : 'var(--red)') + '">' + insMoney(t.pnl) + '</span>'
      + '<select class="form-select" style="width:56px" onchange="pbTag(\'' + key + '\', this.value)">' + opts + '</select></div>';
  }).join('');
  return '<div class="analysis-block"><div class="block-title">Playbook edge (tagged trades)</div>'
    + (stats ? '<div class="ins-grid">' + stats + '</div>' : '<div class="ins-note">No trades tagged yet — tag below to learn which playbook pays.</div>')
    + '<div style="margin:8px 0 4px;display:flex;gap:8px;align-items:center"><span class="ins-k">Tag day:</span><select class="form-select" style="width:130px" onchange="pbSelDate(this.value)">' + dateOpts + '</select>'
    + (untagged ? '<span class="ins-k">' + untagged + ' untagged</span>' : '<span class="ins-k" style="color:var(--green)">all tagged ✓</span>') + '</div>'
    + rows + '</div>';
}

// ═══ Daily Loop engine — GOAL → DOER (session) → CHECKER (scorer) → ADJUST ═══
// Loop-engineering applied to the trading process, fully mechanical:
// verifiable goal (green day, score ≥ target), checker runs on every CSV ingest,
// output picks tomorrow's single focus and tracks the 5-green-day challenge.
function loopState() {
  try { return JSON.parse(localStorage.getItem('copilot_loop') || '{}'); } catch (e) { return {}; }
}
function loopSave(s) {
  localStorage.setItem('copilot_loop', JSON.stringify(s));
  if (window.api && window.api.dataSave) window.api.dataSave(slotDataKey('loop_state'), s).catch(() => {});
}
function loopPickFocus(sum, cs) {
  // One focus only: the worst thing yesterday, in kill order.
  if ((sum.flips || 0) >= 2) return 'ONE direction today. Pick the bias, trade it, and if you are wrong — you are done, not flipped.';
  if (sum.tradedPast3Losses) return 'Three losses in a row = off the desk. The streak is probability; stopping is the skill.';
  const cause = classifyRedDay(sum);
  if (cause === 'TAIL-LOSS') return 'Cut every loser at the cap. One trade must never eat the day.';
  if (cause === 'GIVEBACK') return 'Day peaked then bled — once up, protect 50% of the peak or stop.';
  if (cause === 'OVERSIZE') return 'Max 6 contracts. Not 9, not 12. Size is what breached 6 accounts.';
  if (cause === 'REVENGE') return 'After a loss: hands off 15 minutes. The market reopens tomorrow too.';
  if (cause === 'OVERTRADE') return 'Fewer, better trades. 2-3 quality setups in the 19:00 hour.';
  if (!cs) return 'Upload the CSV daily so the loop can run.';
  const parts = [['ruleAdh', 'Follow the per-trade rules: size, window, cooldown.'], ['risk', 'No tail losses, no giveback — protect the day.'], ['edge', 'Hold winners 5-10 min toward the next level; stop scalping out at 1 min.'], ['process', 'Do the checklist BEFORE the first trade — it is 10% of your score.']];
  parts.sort((a, b) => (cs[a[0]] || 0) - (cs[b[0]] || 0));
  return parts[0][1];
}
function loopUpdate(hist) {
  const RULES = getRules();
  const target = (RULES.challenge && RULES.challenge.scoreTarget) || 70;
  const goalDays = (RULES.challenge && RULES.challenge.greenDays) || 5;
  if (!hist || !hist.length) return null;
  const s = loopState();
  s.target = target; s.goalDays = goalDays;
  s.history = s.history || [];

  // FIX (2026-07-20, Anoop's report — same CSV date was counting as 2+ green
  // days): "today" is excluded from the streak entirely. Tradovate CSVs can
  // be pulled mid-session, and a day isn't done until it's done — counting an
  // in-progress day risks counting one that later turns red. It rolls into
  // the streak automatically the next time a CSV is ingested after that date
  // has passed, same as any other closed day.
  const today = csvDayKey();
  const closed = hist.filter(h => h.date < today);
  if (!closed.length) { loopSave(s); return s; }

  // Recompute (never blindly append) the history entry for every closed date
  // touched by this ingestion. `hist` is already deduped to one record per
  // calendar date by csvApply — re-uploading a day's CSV REPLACES that day's
  // entry there, not adds to it. Mirroring that here (filter-then-push on
  // date, same as csvApply does) means re-ingesting the same day's CSV any
  // number of times — even with a different total from a corrected export —
  // can only ever occupy ONE slot in s.history.
  closed.forEach(day => {
    const cs = computeDayScore(day);
    const green = !!(cs && cs.score >= target && day.pnl > 0);
    s.history = s.history.filter(h => h.date !== day.date);
    s.history.push({ date: day.date, score: cs ? cs.score : null, green: green, pnl: day.pnl });
  });
  s.history.sort((a, b) => a.date < b.date ? -1 : 1);
  s.history = s.history.slice(-30);

  // Streak is DERIVED fresh from history every call — the trailing run of
  // green closed days ending at the most recent one — instead of an
  // incrementing counter. A counter can be bumped twice for one calendar day
  // if re-processed with a different score; a derived value structurally
  // cannot, since re-processing the same date just overwrites its one slot
  // above and the count is recomputed from scratch.
  let streak = 0;
  for (let i = s.history.length - 1; i >= 0; i--) {
    if (s.history[i].green) streak++; else break;
  }
  s.streak = streak;
  s.best = Math.max(s.best || 0, s.streak);

  const lastEntry = s.history[s.history.length - 1];
  const lastFull = closed.filter(h => h.date === lastEntry.date)[0] || hist.filter(h => h.date === lastEntry.date)[0];
  s.lastDate = lastEntry.date; s.lastScore = lastEntry.score; s.lastGreen = lastEntry.green;
  s.focus = loopPickFocus(lastFull, computeDayScore(lastFull));
  loopSave(s);
  return s;
}
// ═══ Eval Clearance Challenge (redesigned 2026-07-21 per Anoop's request) ═══
// The old version only tracked a 5-green-day process streak in isolation —
// it could hit "CHALLENGE COMPLETE" with zero relationship to actually
// clearing the eval. This reframes the whole thing around the real goal
// (clear the active eval) while keeping the process streak as the FIRST,
// easiest milestone — the goal-gradient/habit-loop literature is consistent
// that a big distant goal (here, $9,000) demotivates on its own, but a short
// near-term win (5 days) builds the habit that the long win depends on.
// Four milestones, in the order Anoop asked for, ladder-style:
//   1. FOUNDATION  — 5 consecutive green days (process only, no $ requirement)
//   2. HALFWAY     — balance reaches 50% of the eval's profit target
//   3. THREE-QUARTER — balance reaches 75% of the eval's profit target
//   4. CLEARED     — balance reaches 100% (the actual pass line)
// Design choices and why:
//   - Milestones are PERMANENT once hit (stored per account-bucket, reset
//     only if this account's own start balance changes — i.e. a fresh eval
//     attempt after a blow). A red day right after hitting 50% shouldn't
//     un-hit it; loss-aversion research says protecting an earned gain is a
//     stronger motivator than chasing an ever-resettable one.
//   - HALFWAY/THREE-QUARTER/CLEARED are gated with a consistency-guard check
//     against Lucid's own real rule (single day's profit ≤ 50% of total) —
//     hitting a dollar milestone off one outlier trade isn't discipline, it's
//     luck, and this app's whole thesis is "green P&L on a broken process is
//     failure in disguise." The milestone still unlocks (the balance really
//     is where it is), but a risky one is flagged, not silently celebrated.
//   - Pace is reframed from raw dollars into "days at your own average" —
//     translating an abstract number into a concrete, achievable unit is a
//     standard chunking technique for long-horizon goals.
function evalMilestoneState() {
  try { return JSON.parse(localStorage.getItem('copilot_eval_milestones') || '{}'); } catch (e) { return {}; }
}
function evalMilestoneSave(s) {
  localStorage.setItem('copilot_eval_milestones', JSON.stringify(s));
  if (window.api && window.api.dataSave) window.api.dataSave(slotDataKey('eval_milestones'), s).catch(() => {});
}
function evalProgress() {
  if (state.mode !== 'eval') return null;
  const prof = ACCOUNT_PROFILES[state.accountSize].eval;
  const start = prof.startBalance, target = prof.target;
  const profit = state.account.balance - start;
  const pct = Math.max(0, Math.min(100, Math.round((profit / target) * 100)));
  return { start: start, target: target, profit: profit, pct: pct, targetBalance: start + target };
}
function evalConsistencyCheck() {
  let ledger = {}; try { ledger = JSON.parse(localStorage.getItem('copilot_balance_ledger') || '{}'); } catch (e) {}
  const nets = Object.keys(ledger).map(d => ledger[d].net).filter(n => typeof n === 'number');
  const totalProfit = nets.reduce((a, n) => a + Math.max(0, n), 0);
  const best = nets.reduce((a, n) => Math.max(a, n), 0);
  if (totalProfit <= 0) return null;
  const pct = Math.round((best / totalProfit) * 100);
  return { pct: pct, risky: pct > 50 };
}
function evalPaceEstimate(ev) {
  const loop = loopState();
  const greens = (loop.history || []).filter(h => h.green && h.pnl > 0);
  if (!greens.length) return null;
  const avg = greens.reduce((a, h) => a + h.pnl, 0) / greens.length;
  const remaining = ev.target - ev.profit;
  if (remaining <= 0 || avg <= 0) return null;
  return { avg: avg, daysLeft: Math.ceil(remaining / avg) };
}
// Called after loopUpdate() on every CSV/PDF ingest. Returns labels of any
// milestone crossed for the FIRST time this call, so csvApply can announce
// them in chat — the moment of crossing is what deserves a callout, not
// every render afterward.
function checkEvalMilestones() {
  const ev = evalProgress();
  if (!ev) return [];
  const loop = loopState();
  let m = evalMilestoneState();
  if (m.startBalance !== ev.start) m = { startBalance: ev.start }; // new eval attempt — fresh ladder
  const newlyHit = [];
  const mark = (key, label) => {
    if (!m[key]) { m[key] = { date: csvDayKey(), balance: state.account.balance, pct: ev.pct }; newlyHit.push(label); }
  };
  if ((loop.best || 0) >= (loop.goalDays || 5)) mark('foundation', '🔥 FOUNDATION — 5 green days in a row, proven');
  if (ev.pct >= 50) mark('half', '⚡ HALFWAY — 50% of the eval cleared');
  if (ev.pct >= 75) mark('threeQuarter', '🚀 THREE-QUARTER — 75% of the eval cleared');
  if (ev.pct >= 100) mark('cleared', '🏆 EVAL CLEARED — target hit');
  evalMilestoneSave(m);
  return newlyHit;
}
function evalTrophy(label, emoji, done) {
  return '<div style="flex:1;text-align:center;padding:8px 4px;border-radius:6px;border:1px solid ' + (done ? 'var(--green)' : 'var(--border)') + ';background:' + (done ? 'var(--green-dim)' : 'transparent') + ';opacity:' + (done ? '1' : '.5') + ';">'
    + '<div style="font-size:18px;">' + (done ? emoji : '🔒') + '</div>'
    + '<div style="font-size:9px;letter-spacing:.3px;margin-top:2px;">' + label + '</div>'
    + '</div>';
}
function insLoopBlock() {
  const s = loopState();
  if (!s.lastDate) return '';
  const dots = [];
  for (let i = 0; i < (s.goalDays || 5); i++) dots.push(i < (s.streak || 0) ? '🟢' : '⚪');

  const ev = evalProgress();
  const m = evalMilestoneState();

  // Funded accounts (or any non-eval bucket) have nothing to "clear" — fall
  // back to the plain process-streak view rather than showing a fake ladder.
  if (!ev) {
    const done = (s.streak || 0) >= (s.goalDays || 5);
    return '<div class="analysis-block"><div class="block-title">Process Streak — 5 green days ≥ ' + (s.target || 70) + '</div>'
      + '<div style="font-size:20px;letter-spacing:4px;margin:6px 0">' + dots.join('') + (done ? ' ✅' : '') + '</div>'
      + '<div class="ins-grid">'
      + insCard('Streak', (s.streak || 0) + ' / ' + (s.goalDays || 5), s.streak ? 'ins-good' : '')
      + insCard('Best streak', String(s.best || 0), '')
      + '</div>'
      + '<div class="ins-do"><b>Today\'s focus</b> — ' + (s.focus || '—') + '</div></div>';
  }

  const pace = evalPaceEstimate(ev);
  const cons = evalConsistencyCheck();
  const label = (ACCOUNT_PROFILES[state.accountSize] && ACCOUNT_PROFILES[state.accountSize].label) || '';
  const barColor = ev.pct >= 100 ? 'var(--green)' : ev.pct >= 75 ? 'var(--green)' : ev.pct >= 50 ? 'var(--amber)' : 'var(--border2)';

  const trophies = [
    evalTrophy('FOUNDATION<br>5 green days', '🔥', !!m.foundation),
    evalTrophy('HALFWAY<br>50% cleared', '⚡', !!m.half),
    evalTrophy('3/4 MARK<br>75% cleared', '🚀', !!m.threeQuarter),
    evalTrophy('EVAL CLEARED<br>100%', '🏆', !!m.cleared)
  ].join('');

  const paceLine = pace
    ? 'At your ' + Math.round(pace.avg) + '/day average, ' + pace.daysLeft + ' more green day' + (pace.daysLeft === 1 ? '' : 's') + ' clears it.'
    : (ev.pct >= 100 ? 'Target reached.' : 'Log more green days to get a pace estimate.');
  const consLine = cons
    ? (cons.risky
        ? '⚠ Your largest single day is ' + cons.pct + '% of total profit — Lucid\'s consistency rule caps this at 50%. This progress is real but fragile; the next few days need to widen the base, not add another spike.'
        : 'Largest single day is ' + cons.pct + '% of total profit — well inside Lucid\'s 50% consistency cap. Progress is broad-based, not one lucky trade.')
    : '';

  return '<div class="analysis-block"><div class="block-title">EVAL CLEARANCE — ' + label + ' (target $' + ev.targetBalance.toLocaleString() + ')</div>'
    + '<div style="margin:6px 0;">'
    + '<div style="display:flex;justify-content:space-between;font-size:11px;opacity:.8;margin-bottom:4px;">'
    + '<span>$' + Math.round(state.account.balance).toLocaleString() + ' → $' + ev.targetBalance.toLocaleString() + '</span><span>' + ev.pct + '%</span>'
    + '</div>'
    + '<div style="height:10px;background:var(--surface2);border-radius:5px;overflow:hidden;">'
    + '<div style="height:100%;width:' + ev.pct + '%;background:' + barColor + ';"></div>'
    + '</div></div>'
    + '<div style="display:flex;gap:6px;margin:10px 0;">' + trophies + '</div>'
    + '<div class="ins-grid">'
    + insCard('Green streak', (s.streak || 0) + ' / ' + (s.goalDays || 5), s.streak ? 'ins-good' : '')
    + insCard('Best streak', String(s.best || 0), '')
    + insCard('Last day', (s.lastDate || '').slice(5) + ' · ' + (s.lastScore === null ? '—' : s.lastScore) + (s.lastGreen ? ' ✓' : ' ✗'), s.lastGreen ? 'ins-good' : 'ins-bad')
    + insCard('Pace', pace ? (pace.daysLeft + ' days left (est.)') : '—', '')
    + '</div>'
    + (consLine ? '<div class="ins-do" style="' + (cons && cons.risky ? 'background:var(--amber-dim);color:var(--amber);' : '') + '">' + consLine + '</div>' : '')
    + '<div class="ins-do"><b>Today\'s focus</b> — ' + (s.focus || '—') + '</div></div>';
}
// Surface the focus at the top of the Checklist tab (the loop feeds the ritual)
function loopInjectFocus() {
  const tab = document.getElementById('tab-checklist');
  if (!tab || document.getElementById('loop-focus-banner')) return;
  const s = loopState();
  if (!s.focus) return;
  const div = document.createElement('div');
  div.id = 'loop-focus-banner';
  div.style.cssText = 'margin:0 0 10px;padding:10px 12px;border:1px solid var(--amber);border-radius:6px;background:var(--amber-dim);font-size:12px;';
  div.innerHTML = '<b>🔁 Loop focus (from yesterday\'s checker):</b> ' + s.focus + '<span style="opacity:.7"> · streak ' + (s.streak || 0) + '/' + (s.goalDays || 5) + '</span>';
  tab.insertBefore(div, tab.firstChild);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loopInjectFocus); else setTimeout(loopInjectFocus, 500);

// ═══ Feature 4: MAE/MFE via TradingView 1-min bars (no external API) ═══
const MNQ_PT_VALUE = 2; // $ per index point per micro contract
function mmStore() { try { return JSON.parse(localStorage.getItem('copilot_maemfe') || '{}'); } catch (e) { return {}; } }
// window.api.mcpCall('<tool>', args) resolves to { ok, result } where result is
// the RAW MCP tool envelope { content: [{ type:'text', text: '<JSON string>' }] }
// — the JSON payload (bars, resolution, etc.) is one level deeper than that and
// needs an explicit JSON.parse, same as mcp-bridge.js's own _parseResult() and
// server.js's parseToolResult(). The original MAE/MFE code (and my first pass at
// this fix) read resp.result.bars / resp.result.resolution directly, which are
// always undefined on this shape — it was silently getting nothing back.
function mmParseToolResult(resp) {
  try {
    const r = resp && resp.result;
    const raw = r && r.content && r.content[0] && r.content[0].text;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}
window.insRunMaeMfe = async function () {
  const dt = pbDayTrades();
  const dates = Object.keys(dt).sort();
  if (!dates.length) { addSystemMessage('MAE/MFE: no ingested day trades yet — upload a CSV first.'); return; }
  const sel = window._pbDate && dt[window._pbDate] ? window._pbDate : dates[dates.length - 1];
  const trades = (dt[sel] || []).filter(t => t.ep && t.side);
  if (!trades.length) { addSystemMessage('MAE/MFE: trades for ' + sel + ' have no entry price/side (re-upload that day\'s CSV with the updated parser).'); return; }
  addSystemMessage('MAE/MFE: pulling 1-min bars from TradingView for ' + sel + ' (' + trades.length + ' trades)…');
  // FIX (2026-07-17), two stacked bugs found by tracing this end-to-end:
  // 1. data_get_ohlcv has no timeframe/limit params — passing {timeframe:'1',
  //    limit:1000} was silently ignored, so this read whatever resolution the
  //    chart happened to already be on (confirmed live: chart was sitting on
  //    60/1H). Fixed by explicitly chart_set_timeframe('1') first, verifying
  //    the switch landed, and restoring the original timeframe after — same
  //    contract server.js's getFullBars() already uses for its own bar pulls.
  // 2. Response parsing read resp.result.bars directly, but resp.result is the
  //    raw MCP envelope { content:[{text:'<JSON string>'}] } — the real fields
  //    are one JSON.parse deeper (see mmParseToolResult above). Every call was
  //    silently getting `undefined` back regardless of bug #1.
  let bars = null;
  let originalTf = null;
  try {
    const stateResp = await window.api.mcpCall('chart_get_state', {});
    const st = mmParseToolResult(stateResp);
    originalTf = (st && (st.resolution || st.timeframe)) || null;
  } catch (e) { /* if we can't read it, we just won't restore below */ }
  try {
    await window.api.mcpCall('chart_set_timeframe', { timeframe: '1' });
    const confirmResp = await window.api.mcpCall('chart_get_state', {});
    const cs = mmParseToolResult(confirmResp);
    const landedTf = cs && (cs.resolution || cs.timeframe);
    if (String(landedTf) !== '1') {
      addSystemMessage('MAE/MFE: could not switch the chart to 1-minute (currently ' + (landedTf || 'unknown') + ') — aborting rather than computing on the wrong timeframe.');
      return;
    }
    const resp = await window.api.mcpCall('data_get_ohlcv', { count: 1000, summary: false });
    const res = mmParseToolResult(resp);
    const cand = res && (res.bars || res.data || res.ohlcv || res.candles || (Array.isArray(res) ? res : null));
    if (cand && cand.length) bars = cand;
    else { addSystemMessage('MAE/MFE: TradingView returned no bars even on the 1-minute chart — retry.'); return; }
  } catch (e) { addSystemMessage('MAE/MFE error: ' + e.message + ' — is TradingView connected?'); return; }
  finally {
    if (originalTf) { try { await window.api.mcpCall('chart_set_timeframe', { timeframe: String(originalTf) }); } catch (e) { /* best-effort restore */ } }
  }
  const norm = bars.map(b => ({ t: (b.time || b.t || 0) * ((b.time || b.t || 0) < 1e12 ? 1000 : 1), h: +(b.high !== undefined ? b.high : b.h), l: +(b.low !== undefined ? b.low : b.l) })).filter(b => b.t && !isNaN(b.h));
  const store = mmStore();
  let done = 0;
  trades.forEach(t => {
    const win = norm.filter(b => b.t >= t.t - 60000 && b.t <= t.x + 60000);
    if (!win.length) return;
    const hi = Math.max.apply(null, win.map(b => b.h)), lo = Math.min.apply(null, win.map(b => b.l));
    const maePts = t.side === 'LONG' ? Math.max(0, t.ep - lo) : Math.max(0, hi - t.ep);
    const mfePts = t.side === 'LONG' ? Math.max(0, hi - t.ep) : Math.max(0, t.ep - lo);
    store[sel + '|' + t.t] = { mae: Math.round(maePts * MNQ_PT_VALUE * t.size), mfe: Math.round(mfePts * MNQ_PT_VALUE * t.size), pnl: t.pnl };
    done++;
  });
  localStorage.setItem('copilot_maemfe', JSON.stringify(store));
  if (window.api && window.api.dataSave) window.api.dataSave(slotDataKey('maemfe'), store).catch(() => {});
  addSystemMessage('MAE/MFE: computed for ' + done + '/' + trades.length + ' trades on ' + sel + (done < trades.length ? ' (others outside the loaded bar window — scroll the chart back and retry)' : '') + '. See Insights.');
  renderInsights();
};
function insMaeMfeBlock() {
  const store = mmStore();
  const keys = Object.keys(store);
  let inner;
  if (!keys.length) {
    inner = '<div class="ins-note">Not computed yet. Open your MNQ 1-minute chart in TradingView, then press the button. Winners: how much of the available move you captured. Losers: how much heat you sat through.</div>';
  } else {
    const rows = keys.map(k => store[k]);
    const winners = rows.filter(r => r.pnl > 0 && r.mfe > 0), losers = rows.filter(r => r.pnl < 0);
    const capt = winners.length ? Math.round(winners.reduce((a, r) => a + Math.min(1, r.pnl / r.mfe), 0) / winners.length * 100) : null;
    const heat = losers.length ? Math.round(losers.reduce((a, r) => a + r.mae, 0) / losers.length) : null;
    const missed = winners.length ? Math.round(winners.reduce((a, r) => a + Math.max(0, r.mfe - r.pnl), 0)) : 0;
    inner = '<div class="ins-grid">'
      + insCard('Trades measured', String(rows.length), '')
      + (capt !== null ? insCard('Move captured (winners)', capt + '%', capt >= 60 ? 'ins-good' : capt >= 35 ? 'ins-warn' : 'ins-bad') : '')
      + (heat !== null ? insCard('Avg heat on losers (MAE)', insMoney(-heat), heat > (getRules().perTradeMaxLoss || 200) ? 'ins-bad' : 'ins-warn') : '')
      + (missed ? insCard('Left on the table', insMoney(missed), 'ins-warn') : '')
      + '</div><div class="ins-note">Captured <40% = exits too early. Heat > per-trade cap = stops too wide or not honored.</div>';
  }
  return '<div class="analysis-block"><div class="block-title">MAE / MFE — exits & heat</div>' + inner
    + '<div style="margin-top:8px"><button class="engulf-check-btn" onclick="insRunMaeMfe()">▶ Compute MAE/MFE (selected tag-day)</button></div></div>';
}

function testTradovateConn() {
  const st = document.getElementById('settings-tv-status');
  if (st) { st.style.color = 'var(--text-dim)'; st.textContent = 'Testing\u2026'; }
  window.api.setConfig('tvEnv', document.getElementById('settings-tv-env').value);
  window.api.setConfig('tvName', document.getElementById('settings-tv-name').value.trim());
  window.api.setConfig('tvPassword', document.getElementById('settings-tv-password').value);
  window.api.setConfig('tvAppId', document.getElementById('settings-tv-appid').value.trim());
  window.api.setConfig('tvCid', document.getElementById('settings-tv-cid').value.trim());
  window.api.setConfig('tvSec', document.getElementById('settings-tv-sec').value);
  window.api.testTradovate();
}

// ── CSV feedback engine: one upload updates the whole app (no API) ──────────────
// Groups scaled fills into real trades (union-find on buy/sell fill ids), grades
// each, then drives: guardrail day-state + HUD, Insights history, the balance
// ledger, and the Eval account panel (balance / EOD-trailing floor / cushion).
// FIX (2026-07-28, Anoop): SIZE_CAP_CSV was a hardcoded literal 6 — three
// times looser than the documented hard rule (2 contracts/entry) and never
// read rules.json at all, same disease as the old Ladder-tab bug. It's now a
// getter that reads getRules().sizeCap live, so a rules.json edit actually
// changes what the CSV scorer flags as oversize instead of silently not.
const EVAL_START = 150000, EVAL_START_DATE = '2026-07-08', EVAL_MLL = 4500, EVAL_LOCK_CLOSE = 154600, EVAL_LOCK_FLOOR = 150100, COMM_PER_CT = 1.0;
function SIZE_CAP_CSV_FN() { return (typeof getRules === 'function' ? getRules().sizeCap : null) || 2; }
Object.defineProperty(window, 'SIZE_CAP_CSV', { get: SIZE_CAP_CSV_FN });
function csvDayKey() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

function csvParseTrades(csvText) {
  const parsed = parseCsvRows(csvText);
  const headers = parsed.headers, rows = parsed.rows;
  if (!rows || !rows.length) return { error: 'No data rows found in this CSV.' };
  const col = pats => findColumn(headers, pats);
  const cBid = col([/buy.*fill.*id/i]), cSid = col([/sell.*fill.*id/i]);
  const cQty = col([/^qty$/i, /quantity/i, /contracts/i, /\bsize\b/i]);
  const cPnl = col([/^pnl$/i, /p\W?\/?\W?l/i, /profit/i, /^net$/i]);
  const cBt = col([/bought.*time/i, /buy.*time/i, /entry.*time/i]);
  const cSt = col([/sold.*time/i, /sell.*time/i, /exit.*time/i]);
  const cBpr = col([/buy.*price/i]), cSpr = col([/sell.*price/i]);
  if (!cPnl || (!cBt && !cSt)) return { error: 'Missing P&L or timestamp column. Headers: ' + headers.join(', ') };
  const dOf = str => { const m = String(str || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? (m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0')) : null; };
  const msOf = str => { const t = Date.parse(String(str || '').replace(/-/g, '/')); return isNaN(t) ? 0 : t; };
  const hmOf = str => { const m = String(str || '').match(/\s(\d{1,2}):(\d{2})/); return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : -1; };
  // TRADING-DAY ROLLOVER (2026-07-28, Anoop's request): CSV timestamps are
  // plain calendar dates (IST, confirmed against Tradovate's Local=IST clock
  // + ForexFactory's live session times). But Anoop's trading day is anchored
  // to the NY futures session, not to IST midnight — CME Globex's daily
  // maintenance break (~5:00-5:15 PM ET) rolls the trading day over around
  // 02:30-03:45 AM IST, well after midnight. Without this, a trade taken at
  // e.g. 12:40 AM IST — still inside the NY session that opened 7 PM the
  // PREVIOUS IST evening — got filed under the new calendar date, silently
  // splitting one session's trades across two "days" for every count/limit/
  // score that groups by date. ROLLOVER_MIN = 03:45 IST (Anoop's own number,
  // matches the CME Globex break). Any timestamp before 03:45 IST is
  // attributed to the PREVIOUS calendar date — i.e. it still belongs to the
  // trading day that started the evening before.
  const ROLLOVER_MIN = 3 * 60 + 45; // 03:45 IST
  const tradingDayOf = str => {
    const cal = dOf(str);
    if (!cal) return null;
    const mins = hmOf(str);
    if (mins < 0 || mins >= ROLLOVER_MIN) return cal; // no time, or already past rollover — calendar date stands
    // Before rollover: roll back to the previous calendar date.
    const [y, m, d] = cal.split('-').map(Number);
    const prev = new Date(y, m - 1, d - 1); // JS Date handles month/year underflow correctly
    return prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0') + '-' + String(prev.getDate()).padStart(2, '0');
  };
  const recs = [];
  for (const r of rows) {
    const pnl = parsePnl(r[cPnl]); if (isNaN(pnl)) continue;
    recs.push({ bid: cBid ? r[cBid] : '', sid: cSid ? r[cSid] : '', qty: Math.abs(parseFloat(cQty ? r[cQty] : 1)) || 0, pnl: pnl, bt: cBt ? r[cBt] : '', st: cSt ? r[cSt] : '', bp: cBpr ? parseFloat(r[cBpr]) : NaN, sp: cSpr ? parseFloat(r[cSpr]) : NaN });
  }
  if (!recs.length) return { error: 'No usable rows parsed.' };
  const useIds = !!(cBid && cSid);

  // FIX (2026-07-16): dedup exact-duplicate fill rows (same buyFillId+sellFillId
  // pair) BEFORE grouping. Without this, a row duplicated by an overlapping/
  // re-exported CSV would get summed twice into the same trade's qty/pnl —
  // the grouping below was already correct, this dedup step was the missing piece.
  let duplicatesDropped = 0;
  let workingRecs = recs;
  if (useIds) {
    const seen = new Set();
    workingRecs = [];
    for (const r of recs) {
      const key = r.bid + '|' + r.sid;
      if (seen.has(key)) { duplicatesDropped++; continue; }
      seen.add(key);
      workingRecs.push(r);
    }
  }

  const par = {};
  const find = x => { if (par[x] === undefined) par[x] = x; while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const uni = (a, b) => { par[find(a)] = find(b); };
  if (useIds) workingRecs.forEach(r => uni('B' + r.bid, 'S' + r.sid));
  const groups = {};
  workingRecs.forEach((r, i) => { const k = useIds ? find('B' + r.bid) : ('row' + i); (groups[k] = groups[k] || []).push(r); });
  const trades = [];
  Object.keys(groups).forEach(k => {
    const rs = groups[k];
    const qty = rs.reduce((a, x) => a + x.qty, 0);
    const pnl = rs.reduce((a, x) => a + x.pnl, 0);
    let entryMs = Infinity, exitMs = 0, entryStr = '', dateStr = null;
    rs.forEach(x => { [x.bt, x.st].forEach(str => { const m = msOf(str); if (m) { if (m < entryMs) { entryMs = m; entryStr = str; } if (m > exitMs) exitMs = m; } }); });
    // Trading-day date now comes from the ENTRY timestamp specifically (via
    // tradingDayOf, session-rollover-aware) — using whichever of bt/st came
    // first, matching entryStr/entryMin used everywhere else below.
    dateStr = entryStr ? tradingDayOf(entryStr) : (tradingDayOf(rs[0].bt) || tradingDayOf(rs[0].st));
    if (!dateStr) return;
    // Side + qty-weighted entry price (for MAE/MFE): long = bought first
    const first = rs[0];
    const side = (msOf(first.bt) && msOf(first.st)) ? (msOf(first.bt) <= msOf(first.st) ? 'LONG' : 'SHORT') : 'LONG';
    let pxSum = 0, pxQty = 0;
    rs.forEach(x => { const px = side === 'LONG' ? x.bp : x.sp; if (!isNaN(px) && px > 0) { pxSum += px * x.qty; pxQty += x.qty; } });
    const entryPrice = pxQty ? Math.round((pxSum / pxQty) * 100) / 100 : null;
    // ADDED 2026-07-28 (Anoop): qty-weighted EXIT price (mirror of entryPrice,
    // opposite side of the fill) so realized points moved (exit-entry, signed
    // for direction) can be shown per trade — the CSV parser previously threw
    // this away even though Buy Price/Sell Price columns were already read.
    let xSum = 0, xQty = 0;
    rs.forEach(x => { const px = side === 'LONG' ? x.sp : x.bp; if (!isNaN(px) && px > 0) { xSum += px * x.qty; xQty += x.qty; } });
    const exitPrice = xQty ? Math.round((xSum / xQty) * 100) / 100 : null;
    const movePts = (entryPrice != null && exitPrice != null)
      ? Math.round((side === 'LONG' ? (exitPrice - entryPrice) : (entryPrice - exitPrice)) * 100) / 100
      : null;
    trades.push({ date: dateStr, size: qty, pnl: pnl, entryMs: entryMs, exitMs: exitMs, entryMin: hmOf(entryStr), holdSec: Math.max(0, Math.round((exitMs - entryMs) / 1000)), side: side, entryPrice: entryPrice, exitPrice: exitPrice, movePts: movePts });
  });
  const byDate = {};
  trades.forEach(t => { (byDate[t.date] = byDate[t.date] || []).push(t); });
  Object.keys(byDate).forEach(d => {
    const day = byDate[d].sort((a, b) => a.entryMs - b.entryMs);
    let prevLossExit = null;
    const _R = getRules();
    const _isScalper = (_R.tradingMode || 'standard') === 'scalper';
    const _cooldownLossOnly = _isScalper && _R.cooldownAfterLossOnly;
    const _maxHold = _isScalper ? (_R.maxHoldSeconds || 1800) : Infinity;
    let prevExitMs = null; // tracks ALL prior exits (for standard mode cooldown)
    day.forEach(t => {
      // Standard: 15-min break after EVERY trade (win or loss) — rule #7
      // Scalper: 15-min break only after LOSING trades
      let revenge;
      if (_cooldownLossOnly) {
        revenge = prevLossExit !== null && (t.entryMs - prevLossExit) / 60000 < 15 && (t.entryMs - prevLossExit) >= 0;
      } else {
        revenge = prevExitMs !== null && (t.entryMs - prevExitMs) / 60000 < 15 && (t.entryMs - prevExitMs) >= 0;
      }
      const inWin = (t.entryMin >= 810 && t.entryMin < 900) || (t.entryMin >= 1140 && t.entryMin < 1260);
      const flags = []; let pts = 0;
      if (t.size <= SIZE_CAP_CSV) pts++; else flags.push('oversize');
      if (!revenge) pts++; else flags.push('revenge');
      if (inWin) pts++; else flags.push('out-of-window');
      // 4th flag slot: scalper mode checks hold time, standard assumes news-clear
      if (_isScalper) {
        if ((t.holdSec || 0) <= _maxHold) pts++; else flags.push('hold-exceeded');
      } else {
        pts++; // news not knowable historically — assume clear
      }
      t.pts = pts; t.flags = flags; t.g = ['D', 'D', 'C', 'B', 'A'][pts];
      prevExitMs = t.exitMs;
      if (t.pnl < 0) prevLossExit = t.exitMs;
    });
  });
  return { byDate: byDate, duplicatesDropped };
}

function csvApply(filename, parsed) {
  const byDate = parsed.byDate;
  const dates = Object.keys(byDate).sort();
  let hist = []; try { hist = JSON.parse(localStorage.getItem('copilot_gr_history') || '[]'); } catch (e) {}
  let ledger = {}; try { ledger = JSON.parse(localStorage.getItem('copilot_balance_ledger') || '{}'); } catch (e) {}
  const perDay = [];
  // MERGE, DON'T REPLACE (2026-07-28, Anoop): re-uploading a CSV for a day
  // that's already logged used to wholesale-overwrite that day's trade list
  // and day-level stats with only whatever was in THIS upload — a partial
  // re-export (e.g. just the newest trades) silently dropped everything
  // already logged, and re-uploading the same file counted nothing twice
  // only by luck of always being a full-day export. Now every date's trades
  // are merged by a stable fingerprint (entry time + exit time + pnl + size,
  // which is identical across re-exports of the same underlying fill) before
  // any stats are computed — a re-upload of an unchanged trade UPDATES it in
  // place, a genuinely new trade for that day gets ADDED, nothing repeats.
  const fp = r => r.t + '|' + r.x + '|' + Math.round(r.pnl * 100) + '|' + r.size;
  let dtStore = {}; try { dtStore = JSON.parse(localStorage.getItem('copilot_day_trades') || '{}'); } catch (e) {}
  dates.forEach(d => {
    const incoming = byDate[d].map(t => ({
      t: t.entryMs, x: t.exitMs, size: t.size, pnl: t.pnl, g: t.g, flags: t.flags,
      side: t.side || null, ep: t.entryPrice || null, xp: t.exitPrice || null,
      mp: t.movePts != null ? t.movePts : null, hold: t.holdSec
    }));
    const mergedMap = new Map();
    (dtStore[d] || []).forEach(r => mergedMap.set(fp(r), r));
    incoming.forEach(r => mergedMap.set(fp(r), r));
    const day = Array.from(mergedMap.values()).sort((a, b) => a.t - b.t);

    const gross = day.reduce((a, t) => a + t.pnl, 0);
    const contracts = day.reduce((a, t) => a + t.size, 0);
    const net = Math.round((gross - contracts * COMM_PER_CT) * 100) / 100;
    const maxSize = day.reduce((m, t) => Math.max(m, t.size), 0);
    const over = day.filter(t => t.size > SIZE_CAP_CSV).length;
    const revenge = day.filter(t => (t.flags || []).indexOf('revenge') >= 0).length;
    const disc = Math.round(day.reduce((a, t) => a + (4 - (t.flags || []).length), 0) / (4 * day.length) * 100);
    const dd = new Date(d + 'T00:00:00'); const dow = dd.getDay();
    const pnls = day.map(t => t.pnl); const wins = pnls.filter(p => p > 0); const losses = pnls.filter(p => p < 0);
    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const holds = day.map(t => t.hold || 0); const avgHold = Math.round(holds.reduce((a, b) => a + b, 0) / day.length);
    const medHold = holds.slice().sort((a, b) => a - b)[Math.floor(day.length / 2)];
    const gaps = []; for (let i = 1; i < day.length; i++) gaps.push((day[i].t - day[i - 1].x) / 1000);
    const avgGap = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
    const firstThreeMax = Math.max.apply(null, day.slice(0, 3).map(t => t.size));
    let runp = 0, prevSize = 0, sizedUpIntoLoss = false;
    day.forEach(t => { if (t.size > prevSize && runp < 0) sizedUpIntoLoss = true; prevSize = t.size; runp += t.pnl; });
    let wseq = 0, bigAfterWins = false; for (const t of day) { if (t.size === maxSize) { bigAfterWins = wseq >= 2; break; } if (t.pnl > 0) wseq++; else wseq = 0; }
    const under5 = holds.filter(hh => hh < 300).length, over15 = holds.filter(hh => hh > 900).length;
    // Giveback: intraday peak vs close (gross, ordered by entry time)
    let gbRun = 0, gbPeak = 0;
    day.forEach(t => { gbRun += t.pnl; if (gbRun > gbPeak) gbPeak = gbRun; });
    const giveback = Math.round((gbPeak - gbRun) * 100) / 100;
    // Direction flip-flops (JadeCap: abandoning the thesis = revenge, not analysis):
    // side changed vs previous trade AND re-entered within 15 min of its exit.
    let flips = 0;
    for (let fi = 1; fi < day.length; fi++) {
      if (day[fi].side && day[fi - 1].side && day[fi].side !== day[fi - 1].side
          && (day[fi].t - day[fi - 1].x) / 60000 < 15) flips++;
    }
    // Longest run of consecutive losses + whether he kept trading after 3 in a row
    let consec = 0, maxConsec = 0, tradedPast3Losses = false;
    day.forEach(t => {
      if (t.pnl < 0) { consec++; if (consec > maxConsec) maxConsec = consec; }
      else { if (consec >= 3) tradedPast3Losses = true; consec = 0; }
    });
    if (maxConsec >= 3 && day[day.length - 1].pnl >= 0) tradedPast3Losses = true;
    const _tMode = (getRules().tradingMode || 'standard');
    // Count hold-exceeded flags (set by csvParse in scalper mode)
    const holdExceeded = day.filter(t => (t.flags || []).indexOf('hold-exceeded') >= 0).length;
    const sum = { date: d, dow: dow, n: day.length, pnl: net, gross: gross, contracts: contracts, maxSize: maxSize, over: over, revenge: revenge, disc: disc, best: Math.max.apply(null, pnls), worst: Math.min.apply(null, pnls), avgWin: avgWin, avgLoss: avgLoss, avgHold: avgHold, medHold: medHold, avgGap: avgGap, firstThreeMax: firstThreeMax, sizedUpIntoLoss: sizedUpIntoLoss, bigAfterWins: bigAfterWins, under5: under5, over15: over15, wins: wins.length, losses: losses.length, peak: Math.round(gbPeak), giveback: giveback, flips: flips, maxConsecLoss: maxConsec, tradedPast3Losses: tradedPast3Losses, tradingMode: _tMode, holdExceeded: holdExceeded };
    hist = hist.filter(e => e.date !== d); hist.push(sum);
    ledger[d] = { gross: gross, net: net, contracts: contracts };
    perDay.push({ d: d, n: day.length, gross: gross, net: net, over: over, revenge: revenge, disc: disc, maxSize: maxSize });
    // Persist the MERGED trade-level detail per day (playbook tagging + MAE/MFE need it)
    dtStore[d] = day;
    // if this CSV covers today, load the merged day into the live guardrail day-state
    if (d === csvDayKey()) {
      const stop = state.mode === 'eval' ? (state.account.evalDayStop || 300) : (state.account.fundedDayStop || 200);
      const gs = { date: d, trades: day.map(t => ({ t: t.t, size: t.size, pnl: t.pnl, g: t.g, pts: 4 - (t.flags || []).length, flags: t.flags })), cooldownUntil: 0, stopped: net <= -stop, acked: false, live: null, lastLossSeen: 0 };
      localStorage.setItem('copilot_guardrail_v1', JSON.stringify(gs));
    }
  });
  try {
    const keys = Object.keys(dtStore).sort(); while (keys.length > 90) { delete dtStore[keys.shift()]; }
    localStorage.setItem('copilot_day_trades', JSON.stringify(dtStore));
    if (window.api && window.api.dataSave) window.api.dataSave(slotDataKey('day_trades'), dtStore).catch(() => {});
  } catch (e) {}
  hist.sort((a, b) => a.date < b.date ? -1 : 1);
  localStorage.setItem('copilot_gr_history', JSON.stringify(hist.slice(-60)));
  localStorage.setItem('copilot_balance_ledger', JSON.stringify(ledger));
  // Durable mirror → data/ folder on disk (survives cache clears / UI rebuilds)
  if (window.api && window.api.dataSave) {
    window.api.dataSave(slotDataKey('gr_history'), hist.slice(-60)).catch(() => {});
    window.api.dataSave(slotDataKey('balance_ledger'), ledger).catch(() => {});
  }

  // FIX (2026-07-21): recompute balance + EOD-trailing floor using the
  // ACTIVE account's own profile numbers, not the hardcoded 150K-eval-only
  // constants (EVAL_START/EVAL_MLL/EVAL_LOCK_FLOOR) this used to read — those
  // were correct for the 150K eval but silently wrong for every other
  // account/stage. Lock mechanic (floor trails up on daily closes, freezes
  // permanently once a close reaches start+buffer+$100) is the one CONFIRMED
  // pattern from Lucid's real terms — both the 150K eval ($154,600 lock-close
  // / $150,100 lock-floor) and the old 50K funded ($52,100 / $50,100) match
  // this exact "+$100" shape, so it's generalized here rather than
  // hardcoded per account. Each bucket's ledger is already isolated by the
  // account-switch system, so there's no need for a start-date cutoff filter.
  const isEval = state.mode === 'eval';
  const prof = ACCOUNT_PROFILES[state.accountSize][state.mode];
  const start = prof.startBalance;
  const buffer = isEval ? prof.maxLoss : prof.floorBuffer;
  const lockFloorValue = start + 100;
  let bal = start, floor = start - buffer;
  Object.keys(ledger).sort().forEach(d => { bal += ledger[d].net; floor = Math.min(lockFloorValue, Math.max(floor, bal - buffer)); });
  bal = Math.round(bal * 100) / 100;
  const acc = state.account;
  acc.balance = bal;
  if (isEval) acc.evalFloor = Math.round(floor); else acc.fundedFloor = Math.round(floor);
  const todayNet = byDate[csvDayKey()] ? perDay.filter(x => x.d === csvDayKey())[0].net : null;
  if (todayNet !== null) acc.profit = Math.round(todayNet);
  window.api.setConfig('balance', bal);
  if (isEval) window.api.setConfig('evalFloor', Math.round(floor)); else window.api.setConfig('fundedFloor', Math.round(floor));
  if (todayNet !== null) window.api.setConfig('profit', Math.round(todayNet));
  checkAutoPromotion();
  updateAccountUI(); if (typeof updateRulesTab === 'function') updateRulesTab();
  if (typeof grRender === 'function') grRender();
  if (typeof renderInsights === 'function' && document.getElementById('tab-insights') && document.getElementById('tab-insights').style.display !== 'none') renderInsights();
  // Journal tab (calendar/equity/radar/log/reports) rebuilds from the same
  // ledger + history this function just wrote — refresh it if it's open.
  if (typeof renderJournal === 'function' && document.getElementById('tab-journal') && document.getElementById('tab-journal').style.display !== 'none') renderJournal();

  // chat summary
  const cushion = bal - Math.round(floor);
  const L = [];
  L.push('CSV ingested — ' + filename + '. Everything updated from your fills (no AI).');
  if (parsed.duplicatesDropped) L.push('Dropped ' + parsed.duplicatesDropped + ' duplicate fill row(s) (same buy+sell fill ID, e.g. from an overlapping export) — not double-counted.');
  perDay.forEach(x => L.push(x.d + ': ' + x.n + ' trades · net ' + (x.net < 0 ? '-$' : '$') + Math.abs(Math.round(x.net)) + (x.over ? ' · ' + x.over + ' over-6' : '') + (x.revenge ? ' · ' + x.revenge + ' revenge' : '') + ' · disc ' + x.disc + '%'));
  dates.forEach(d => {
    const he = hist.filter(e => e.date === d)[0];
    const cs = he && computeDayScore(he);
    const cause = he && classifyRedDay(he);
    if (cs) {
      const letter = cs.score >= 85 ? 'A' : cs.score >= 70 ? 'B' : cs.score >= 55 ? 'C' : 'D';
      L.push('Co-Pilot Score ' + d + ': ' + cs.score + '/100 · process grade ' + letter + ' (rules ' + cs.ruleAdh + ' · risk ' + cs.risk + ' · edge ' + cs.edge + ' · process ' + (cs.process ? '✓' : '✗') + ')' + (cause ? ' — red-day cause: ' + cause : ''));
      if (he.pnl < 0 && cs.score >= 70) L.push(d + ': red P&L, clean process — that is an A day. The grade is the process, not the money.');
      if (he.pnl > 0 && cs.score < 55) L.push(d + ': GREEN P&L ON A BROKEN PROCESS — failure in disguise. Do not let the payment teach the mistake.');
      if ((he.flips || 0) >= 2) L.push(d + ': ' + he.flips + ' direction flip-flops — you traded both sides. One bias per day.');
      if (he.tradedPast3Losses) L.push(d + ': kept trading after 3 consecutive losses — that was the off-the-desk moment.');
    }
  });
  // Close the loop: checker output → streak + tomorrow's focus
  try {
    const ls = loopUpdate(hist);
    if (ls) {
      L.push('LOOP · challenge ' + (ls.streak || 0) + '/' + (ls.goalDays || 5) + ' green days' + (ls.lastGreen ? ' — day counted ✓' : ' — streak reset ✗ (need score ≥' + ls.target + ' AND green P&L)'));
      if (dates.indexOf(csvDayKey()) >= 0) L.push('LOOP · today (' + csvDayKey() + ') is still open — not counted toward the streak until the session closes and a later CSV rolls it in as a closed day.');
      L.push('LOOP · tomorrow\'s focus: ' + ls.focus);
      const banner = document.getElementById('loop-focus-banner'); if (banner) banner.remove();
      if (typeof loopInjectFocus === 'function') loopInjectFocus();
    }
    const hitMilestones = checkEvalMilestones();
    hitMilestones.forEach(label => L.push('MILESTONE · ' + label));
  } catch (e) {}
  L.push('Next: tag today\'s trades with playbook A/B/C in Insights, then run MAE/MFE with the MNQ 1m chart open.');
  L.push('Account: balance $' + Math.round(bal).toLocaleString() + ' · floor $' + Math.round(floor).toLocaleString() + ' · cushion $' + Math.round(cushion).toLocaleString() + ' · to target $' + Math.max(0, (acc.evalTarget || 159000) - bal).toLocaleString());
  L.push('See it: left panel = balance/cushion · Insights tab = scorecard & history · bottom HUD = today.');
  addSystemMessage(L.join('\n'));
  if (typeof scrollToBottom === 'function') scrollToBottom();

  // FIX (2026-07-27): persist the bucket blob right after new trading data
  // lands, not just on account-switch/End-Day. Without this, a fresh CSV
  // ingest updates localStorage (survives an app restart on its own) but NOT
  // the acctBucket__<slotId> config blob the server reads for Jessi — so
  // Jessi could go on reporting pre-ingest numbers until the next explicit
  // save. See also jessiVerifyBalance() in server.js, which recomputes the
  // balance from the ledger as a second line of defense either way.
  if (typeof saveActiveBucket === 'function') saveActiveBucket();

  // 2026-07-25: auto-debrief. After every CSV/PDF ingest, Jessi reviews the
  // fresh Insights UNPROMPTED and coaches on it — Anoop asked for exactly
  // this ("jessi should check my insights and all the tabs after updating
  // the CSV/PDF and interact accordingly"). Routed through sendMessage() so
  // it uses the identical model/fallback pipeline as a typed message, and
  // skipped when a stream is already running. The compact per-day summary is
  // inlined so Jessi coaches on REAL numbers even before calling app_get_data.
  try {
    const dbLines = perDay.map(x => `${x.d}: ${x.n} trades, net $${Math.round(x.net)}, disc ${x.disc}%${x.revenge ? ', ' + x.revenge + ' revenge' : ''}${x.over ? ', ' + x.over + ' oversize' : ''}`);
    const dbMsg = '(auto-debrief — I just uploaded my trading data: ' + dbLines.join(' | ')
      + `. Current balance $${Math.round(bal)}, cushion $${Math.round(cushion)}.) `
      + 'Pull app_get_data("insights") and coach me on this upload: verdict on the process, the ONE pattern that matters most right now, and one concrete fix for tomorrow. Reference my actual numbers, keep it tight, and do not repeat phrasings you have already used with me.';
    setTimeout(() => { try { sendMessage(dbMsg); } catch (e) {} }, 600);
    // ── 2026-08-12: full Post-Session report is now OPT-IN ────────────────────
    // It used to auto-fire 5s after EVERY CSV upload, on top of the debrief
    // above — two AI calls per upload. Anoop: "it is such a long list of
    // details... I cannot read the whole post-session review every time I
    // upload a CSV. At the end of the session, I will upload only once. That
    // is when I need all the details."
    // The report is ~5-7K tokens in / ~1.5K out (about $0.014 a time on
    // Haiku). The cost is the smaller argument — generating 1,500 tokens
    // nobody reads is 100% waste at any price, and it buried the one line he
    // actually wanted underneath it.
    // The SHORT debrief above still fires on every upload. The full report now
    // runs only on request: "End Day & Save", or typing "post session review".
    // Restore the old behaviour with autoPostSessionReview: true in rules.json.
    const autoPSR = (getRules().autoPostSessionReview === true);
    if (autoPSR) {
      setTimeout(() => { try { runPostSessionReview(); } catch (e) {} }, 5000);
    } else {
      setTimeout(() => {
        try {
          addSystemMessage('Full post-session report skipped (not auto-run). Type "post session review" or use End Day & Save when you want the detailed breakdown.');
        } catch (e) {}
      }, 1200);
    }
  } catch (e) {}
}

function csvIngest(filename, csvText) {
  if (typeof addUserMessage === 'function') addUserMessage('📄 Ingesting ' + filename + ' (mechanical, no AI)…');
  const parsed = csvParseTrades(csvText);
  if (parsed.error) { addSystemMessage('Could not ingest ' + filename + ': ' + parsed.error); return; }
  csvApply(filename, parsed);
}

// ── Panel drag-resize: left and right panels, widths persisted locally ────────
// UPDATED 2026-08-02 (design-shotgun): the right panel carries 10 tabs
// (Analysis/Journal/Rules/Lessons/Alignment/Ladder/Checklist/Roadmap/
// Insights/Cost) with dense nested cards — a fixed 1000px cap wasn't enough
// room to read comfortably. Right's max is now computed live from the actual
// window width each drag, so it can expand nearly to the center panel's
// floor instead of stopping at an arbitrary number. Left keeps a static cap
// since it's a fixed nav/account list, not detail-heavy.
(function () {
  const KEY = 'copilot_panel_widths';
  const DEFAULTS = { left: 240, right: 480 };
  const LIMITS = { left: [170, 480] };
  const MIN_RIGHT = 320;
  const CENTER_MIN = 280; // center (chart/chat) never shrinks below this

  function loadWidths() { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { return Object.assign({}, DEFAULTS); } }
  function saveWidths(w) { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch (e) {} }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function init() {
    const left = document.getElementById('left-panel');
    const right = document.getElementById('right-panel');
    const rzL = document.getElementById('resizer-left');
    const rzR = document.getElementById('resizer-right');
    if (!left || !right || !rzL || !rzR) return;

    function maxRight() {
      const totalW = window.innerWidth;
      const leftW = left.getBoundingClientRect().width;
      return Math.max(MIN_RIGHT, totalW - leftW - CENTER_MIN - 24 /* resizer + gutters */);
    }

    const widths = loadWidths();
    left.style.width = clamp(widths.left, LIMITS.left[0], LIMITS.left[1]) + 'px';
    right.style.width = clamp(widths.right, MIN_RIGHT, maxRight()) + 'px';

    function attach(handle, panel, side) {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = panel.getBoundingClientRect().width;
        handle.classList.add('dragging');
        document.body.classList.add('panel-resizing');
        function onMove(ev) {
          // left panel grows dragging right; right panel grows dragging left
          const dx = ev.clientX - startX;
          let w;
          if (side === 'left') {
            w = clamp(startW + dx, LIMITS.left[0], LIMITS.left[1]);
          } else {
            w = clamp(startW - dx, MIN_RIGHT, maxRight());
          }
          panel.style.width = w + 'px';
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          handle.classList.remove('dragging');
          document.body.classList.remove('panel-resizing');
          const w = loadWidths();
          w[side] = Math.round(panel.getBoundingClientRect().width);
          saveWidths(w);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      // double-click resets that side to its default width
      handle.addEventListener('dblclick', () => {
        panel.style.width = DEFAULTS[side] + 'px';
        const w = loadWidths(); w[side] = DEFAULTS[side]; saveWidths(w);
      });
    }
    attach(rzL, left, 'left');
    attach(rzR, right, 'right');

    // Re-clamp the right panel on window resize so it never overruns center
    // if the user shrinks the window after dragging it wide.
    window.addEventListener('resize', () => {
      const w = right.getBoundingClientRect().width;
      const m = maxRight();
      if (w > m) right.style.width = m + 'px';
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

// ── Boot-time restore: the data/ folder on disk is the SOURCE OF TRUTH.
// On every launch, disk state replaces localStorage (ingest writes both, so
// disk is never behind), then the account panel is recomputed from the ledger.
// This is what keeps the app's balance equal to Lucid without manual steps. ───
(function () {
  async function restoreFromDisk() {
    if (!window.api || !window.api.dataLoad) return;
    // 2026-07-25: never restore before the active slot is resolved — the disk
    // mirror is per-slot now, and restoring early would read the wrong (or a
    // non-existent) account's files.
    if (typeof activeSlotId === 'undefined' || !activeSlotId) return;
    const pairs = [
      ['gr_history', 'copilot_gr_history'],
      ['balance_ledger', 'copilot_balance_ledger'],
      ['day_trades', 'copilot_day_trades'],
      ['pb_tags', 'copilot_pb_tags'],
      ['maemfe', 'copilot_maemfe'],
      ['loop_state', 'copilot_loop'],
      // 2026-08-13: ck_history was WRITE-ONLY. endDay() flushed it to
      // accounts/<slot>/ck_history.json but nothing ever read it back, while
      // two code paths removeItem('copilot_ck_history') on clear/wipe. So the
      // "permanent record" Anoop asked for could be destroyed by a clear even
      // though a good copy sat on disk. Now restored on boot like every other
      // per-slot dataset — which also means his completion streak survives.
      ['ck_history', 'copilot_ck_history']
    ];
    let ledger = null;
    for (const [key, lsKey] of pairs) {
      try {
        const v = await window.api.dataLoad(slotDataKey(key));
        const nonEmpty = v && (Array.isArray(v) ? v.length : Object.keys(v).length);
        if (nonEmpty) {
          localStorage.setItem(lsKey, JSON.stringify(v));
          if (key === 'balance_ledger') ledger = v;
          // 2026-08-13: this is the path that eventually has the RIGHT data
          // even when the fast boot path above raced ahead with a stale
          // snapshot — but nothing told the checklist UI to look again. Without
          // this, a correct completion could land in localStorage and the gate
          // would still show "not done" until he switched tabs by hand.
          if (key === 'ck_history' && typeof ckRenderGate === 'function') ckRenderGate();
        }
      } catch (e) {}
    }
    // FIX (2026-07-21): same account-profile parameterization as the primary
    // recompute in csvApply — this path was also hardcoded to the 150K eval's
    // constants (currently dead code anyway, since window.api.dataLoad isn't
    // defined in preload.js, but fixed for consistency in case that's ever wired up).
    try {
      if (ledger && Object.keys(ledger).length && typeof ACCOUNT_PROFILES !== 'undefined' && state.account) {
        const isEval = state.mode === 'eval';
        const prof = ACCOUNT_PROFILES[state.accountSize][state.mode];
        const start = prof.startBalance;
        const buffer = isEval ? prof.maxLoss : prof.floorBuffer;
        const lockFloorValue = start + 100;
        let bal = start, floor = start - buffer;
        Object.keys(ledger).sort().forEach(d => {
          bal += ledger[d].net;
          floor = Math.min(lockFloorValue, Math.max(floor, bal - buffer));
        });
        bal = Math.round(bal * 100) / 100;
        state.account.balance = bal;
        if (isEval) state.account.evalFloor = Math.round(floor); else state.account.fundedFloor = Math.round(floor);
        window.api.setConfig('balance', bal);
        if (isEval) window.api.setConfig('evalFloor', Math.round(floor)); else window.api.setConfig('fundedFloor', Math.round(floor));
        if (typeof updateAccountUI === 'function') updateAccountUI();
        if (typeof addSystemMessage === 'function') addSystemMessage('Ledger restored from disk — balance $' + bal.toLocaleString() + ' · floor $' + Math.round(floor).toLocaleString() + ' (' + Object.keys(ledger).length + ' days, source of truth: data/ folder).');
        if (typeof checkAutoPromotion === 'function') checkAutoPromotion();
      }
    } catch (e) {}
    if (typeof grRender === 'function') grRender();
    if (typeof loopInjectFocus === 'function') loopInjectFocus();
    if (typeof renderInsights === 'function' && document.getElementById('tab-insights') && document.getElementById('tab-insights').style.display !== 'none') renderInsights();
  }
  if (window.api && window.api.onWsOpen) window.api.onWsOpen(() => setTimeout(restoreFromDisk, 800));
  else setTimeout(restoreFromDisk, 2500);
  // 2026-08-18: start the periodic/unload autosave once the boot restore has
  // had its turn, so the first autosave can never write a pre-restore (empty)
  // snapshot over a good disk file.
  setTimeout(() => { try { startAccountAutosave(); } catch (e) {} }, 5000);
})();


// ── Good-trade screenshot review (vision) ───────────────────────────────────────
// Repurposes the old "Screenshot Chart" button. Sends an uploaded trade screenshot
// to the vision model with a coach prompt focused on what went right, where the
// exit was early, and how to repeat the setup with more size. Needs a valid API key.
async function handleGoodTradeShot(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (!state.hasApiKey) { addSystemMessage('Good-trade review needs vision — add a valid Anthropic API key in Settings (⚙). The 401 you saw means the current key is invalid.'); return; }
  if (state.isStreaming) { addSystemMessage('Wait for the current response to finish, then upload the screenshot.'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = String(reader.result || '');
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
    if (!m) { addSystemMessage('Could not read that image.'); return; }
    const mediaType = m[1], b64 = m[2];
    const img = document.getElementById('screenshot-img');
    if (img) { img.src = dataUrl; img.style.display = 'block'; }
    const ph = document.getElementById('screenshot-placeholder'); if (ph) ph.style.display = 'none';
    addUserMessage('★ Reviewing a good trade — ' + file.name);
    const prompt = 'This is a screenshot of an MNQ trade I believe I played WELL but likely EXITED TOO EARLY. Review it as an elite scalping coach:\n'
      + '1. WHAT I DID RIGHT — entry timing, direction vs structure / EMA / levels / volume; what made this a good read. Be specific to the candles on the chart.\n'
      + '2. THE EXIT — did I leave money on the table? Point to where price went and the next level/structure I could have held to, and roughly how much more was available.\n'
      + '3. HOW TO REPEAT IT BIGGER — how to recognise this exact setup next time, how to HOLD 5–10min instead of scalping out, and how to scale size up (start small, add on confirmation) once bias is confirmed.\n'
      + '4. ONE risk / watch-out for this pattern.\n'
      + 'Context: MNQ micro scalper, prime days Tue–Thu NY session, 6-contract base with room to pyramid, wants to hold winners longer. Keep it tight and actionable, referencing the actual candles/levels visible.';
    state.messages.push({ role: 'user', content: [ { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } }, { type: 'text', text: prompt } ] });
    setStreaming(true); startNewAssistantBubble();
    try {
      const analysis = await window.api.sendChat([buildContextMessage(), ...state.messages]);
      const last = state.messages[state.messages.length - 1];
      if (last && Array.isArray(last.content)) last.content = [{ type: 'text', text: '[Uploaded a good-trade screenshot for review]' }];
      try { const j = JSON.parse(localStorage.getItem('copilot_goodtrades') || '[]'); j.push({ at: Date.now(), name: file.name, analysis: String(analysis || '').slice(0, 4000) }); localStorage.setItem('copilot_goodtrades', JSON.stringify(j.slice(-50))); } catch (e) {}
    } catch (e) { setStreaming(false); addSystemMessage('Analysis error: ' + e.message); }
  };
  reader.onerror = () => addSystemMessage('Could not read that image.');
  reader.readAsDataURL(file);
}

// ═══════════════════════════════════════════════════════════════════════════════
// JOURNAL TAB — TradeZella-style presentation of data the app already stores
// (2026-07-25, Anoop's ask after the TradeZella walkthrough video). All charts
// are hand-rolled canvas — zero dependencies, fully offline (CDN vendoring was
// not possible and a trading app shouldn't need the network to draw anyway).
// Data sources: copilot_balance_ledger (per-day net), copilot_gr_history
// (per-day discipline), copilot_day_trades (per-trade detail).
// ═══════════════════════════════════════════════════════════════════════════════
let jrMonthOffset = 0; // 0 = current month, -1 = previous …
let _jrArchiveOverlay = null; // when set, jrLS reads from this instead of localStorage

function jrLS(key, fb) {
  try {
    if (_jrArchiveOverlay && _jrArchiveOverlay[key] != null) {
      return JSON.parse(_jrArchiveOverlay[key]) || fb;
    }
    return JSON.parse(localStorage.getItem(key) || 'null') || fb;
  } catch (e) { return fb; }
}
function jrMoney(n) { return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString(); }
function jrCss(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#888'; }

// All trades flattened across days, newest first
function jrAllTrades() {
  const dt = jrLS('copilot_day_trades', {});
  const out = [];
  Object.keys(dt).sort().forEach(d => (dt[d] || []).forEach(t => out.push(Object.assign({ date: d }, t))));
  return out;
}

// ── Phase 2: headline stats ────────────────────────────────────────────────────
function jrStats() {
  const trades = jrAllTrades();
  const ledger = jrLS('copilot_balance_ledger', {});
  const days = Object.keys(ledger).sort();
  const net = days.reduce((a, d) => a + (ledger[d].net || 0), 0);
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
  const grossW = wins.reduce((a, t) => a + t.pnl, 0), grossL = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const winRate = trades.length ? wins.length / trades.length * 100 : 0;
  const pf = grossL > 0 ? grossW / grossL : (grossW > 0 ? Infinity : 0);
  const avgW = wins.length ? grossW / wins.length : 0;
  const avgL = losses.length ? grossL / losses.length : 0;
  const expectancy = trades.length ? (grossW - grossL) / trades.length : 0;
  const greenDays = days.filter(d => ledger[d].net > 0).length;
  return { net, winRate, pf, avgW, avgL, expectancy, nTrades: trades.length, nDays: days.length, greenDays };
}

// ── Canvas helpers (line/area, bars, radar) ────────────────────────────────────
function jrCanvas(id, h) { return '<canvas id="' + id + '" height="' + (h || 140) + '" style="width:100%;display:block;"></canvas>'; }
function jrPrep(id) {
  const c = document.getElementById(id); if (!c) return null;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth || 300, h = c.getAttribute('height') * 1;
  c.width = w * dpr; c.height = h * dpr; c.style.height = h + 'px';
  const x = c.getContext('2d'); x.scale(dpr, dpr);
  return { x, w, h };
}
function jrDrawLine(id, values) {
  const p = jrPrep(id); if (!p || values.length < 2) return;
  const { x, w, h } = p, pad = 6;
  const min = Math.min(0, ...values), max = Math.max(0, ...values), span = (max - min) || 1;
  const X = i => pad + i * (w - pad * 2) / (values.length - 1);
  const Y = v => h - pad - (v - min) * (h - pad * 2) / span;
  const acc = jrCss('--accent'), up = values[values.length - 1] >= 0;
  const col = up ? jrCss('--green') : jrCss('--red');
  x.beginPath(); x.moveTo(X(0), Y(0));
  values.forEach((v, i) => x.lineTo(X(i), Y(v)));
  x.strokeStyle = col; x.lineWidth = 2; x.lineJoin = 'round'; x.stroke();
  x.lineTo(X(values.length - 1), Y(min)); x.lineTo(X(0), Y(min)); x.closePath();
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, col + '44'); g.addColorStop(1, col + '00');
  x.fillStyle = g; x.fill();
  // zero line
  x.strokeStyle = jrCss('--border2'); x.setLineDash([3, 4]); x.beginPath(); x.moveTo(pad, Y(0)); x.lineTo(w - pad, Y(0)); x.stroke(); x.setLineDash([]);
}
function jrDrawBars(id, labels, values) {
  const p = jrPrep(id); if (!p || !values.length) return;
  const { x, w, h } = p, padB = 16, padT = 6;
  const max = Math.max(...values.map(Math.abs), 1);
  const bw = (w - 10) / values.length;
  const zero = padT + (h - padB - padT) * (max / (max * 2));
  values.forEach((v, i) => {
    const bh = Math.abs(v) / max * (h - padB - padT) / 2;
    x.fillStyle = v >= 0 ? jrCss('--green') : jrCss('--red');
    x.globalAlpha = 0.85;
    x.fillRect(5 + i * bw + bw * 0.15, v >= 0 ? zero - bh : zero, bw * 0.7, Math.max(bh, 1));
    x.globalAlpha = 1;
    x.fillStyle = jrCss('--text-dim'); x.font = '9px "JetBrains Mono", monospace'; x.textAlign = 'center';
    x.fillText(labels[i], 5 + i * bw + bw / 2, h - 4);
  });
}
function jrDrawRadar(id, labels, values) { // values 0-100
  const p = jrPrep(id); if (!p) return;
  const { x, w, h } = p, cx = w / 2, cy = h / 2 + 4, R = Math.min(w, h) / 2 - 24, n = labels.length;
  const pt = (i, r) => [cx + r * Math.sin(i * 2 * Math.PI / n), cy - r * Math.cos(i * 2 * Math.PI / n)];
  x.strokeStyle = jrCss('--border'); x.lineWidth = 1;
  [0.33, 0.66, 1].forEach(f => { x.beginPath(); for (let i = 0; i <= n; i++) { const [px, py] = pt(i % n, R * f); i ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke(); });
  for (let i = 0; i < n; i++) { const [px, py] = pt(i, R); x.beginPath(); x.moveTo(cx, cy); x.lineTo(px, py); x.stroke(); }
  const acc = jrCss('--accent');
  x.beginPath();
  for (let i = 0; i <= n; i++) { const [px, py] = pt(i % n, R * Math.max(0.04, (values[i % n] || 0) / 100)); i ? x.lineTo(px, py) : x.moveTo(px, py); }
  x.closePath(); x.fillStyle = acc + '33'; x.fill(); x.strokeStyle = acc; x.lineWidth = 2; x.stroke();
  x.fillStyle = jrCss('--text-mid'); x.font = '9.5px Outfit, sans-serif'; x.textAlign = 'center';
  labels.forEach((l, i) => { const [px, py] = pt(i, R + 13); x.fillText(l, px, py + 3); });
}

// ── Points / sizing charts (2026-08-13) ─────────────────────────────────────
// Anoop: "make this chart live in journal tab inside everyday trade data. so
// that i know and judge my mistakes of oversizing and find my sweet spot."
// Both functions read window.PointsTracker — the SAME module server.js uses
// and the Node tests replay against real trade history — so this chart can
// never quietly disagree with the numbers Anoop is told in chat.

// Per-day bars: bar height = points captured on that trade, bar OPACITY =
// how large the size was relative to that day's biggest trade. A big, dark
// bar sitting in red is the oversizing mistake made visible — no reading
// required. Dashed line = that day's mean.
function jrDrawPointsBars(id, trades, mult) {
  const p = jrPrep(id); if (!p) return;
  const PT = window.PointsTracker; if (!PT) return;
  const { x, w, h } = p, padB = 6, padT = 6;
  const valid = trades
    .map(t => ({ t, pts: PT.tradePoints(t, mult) }))
    .filter(o => o.pts !== null);
  if (!valid.length) return;
  const maxAbs = Math.max(...valid.map(o => Math.abs(o.pts)), 1);
  const maxSize = Math.max(...valid.map(o => o.t.size || 1), 1);
  const bw = (w - 10) / valid.length;
  const zero = padT + (h - padB - padT) / 2;
  valid.forEach((o, i) => {
    const bh = Math.abs(o.pts) / maxAbs * (h - padB - padT) / 2;
    const sizeFrac = Math.min(1, (o.t.size || 1) / maxSize);
    x.fillStyle = o.pts >= 0 ? jrCss('--green') : jrCss('--red');
    x.globalAlpha = 0.30 + 0.60 * sizeFrac; // bigger contract = more opaque bar
    x.fillRect(5 + i * bw + bw * 0.15, o.pts >= 0 ? zero - bh : zero, bw * 0.7, Math.max(bh, 1));
    x.globalAlpha = 1;
  });
  const meanPts = valid.reduce((a, o) => a + o.pts, 0) / valid.length;
  const meanY = zero - Math.max(-1, Math.min(1, meanPts / maxAbs)) * (h - padB - padT) / 2;
  x.strokeStyle = jrCss('--border2'); x.setLineDash([3, 4]);
  x.beginPath(); x.moveTo(5, meanY); x.lineTo(w - 5, meanY); x.stroke(); x.setLineDash([]);
  x.strokeStyle = jrCss('--border2');
  x.beginPath(); x.moveTo(5, zero); x.lineTo(w - 5, zero); x.stroke();
}

// Aggregate across the whole account: bucket every trade by size, run each
// bucket through PointsTracker.summarize(), and hand back expectancy per
// bucket. This IS "find my sweet spot" — the size whose expectancy is
// highest, computed, not guessed.
function jrSizeSweetSpot(mult) {
  const PT = window.PointsTracker; if (!PT) return [];
  const trades = jrAllTrades();
  const buckets = [
    { label: '1 lot', test: s => s === 1 },
    { label: '2 lots', test: s => s === 2 },
    { label: '3-5 lots', test: s => s >= 3 && s <= 5 },
    { label: '6+ lots', test: s => s >= 6 }
  ];
  return buckets
    .map(b => {
      const bt = trades.filter(t => b.test(t.size));
      return { label: b.label, n: bt.length, summary: PT.summarize(bt, mult) };
    })
    .filter(r => r.n > 0 && r.summary);
}

function jrDrawSizeSweetSpot(id, rows) {
  const p = jrPrep(id); if (!p || !rows.length) return;
  const { x, w, h } = p, padB = 22, padT = 6;
  const vals = rows.map(r => r.summary.expectancyPts);
  const max = Math.max(...vals.map(Math.abs), 0.5);
  const bw = (w - 10) / rows.length;
  const zero = padT + (h - padB - padT) / 2;
  const bestIdx = vals.indexOf(Math.max(...vals));
  rows.forEach((r, i) => {
    const v = r.summary.expectancyPts;
    const bh = Math.abs(v) / max * (h - padB - padT) / 2;
    const bx = 5 + i * bw + bw * 0.15, by = v >= 0 ? zero - bh : zero, bwid = bw * 0.7, bhh = Math.max(bh, 1);
    x.fillStyle = v >= 0 ? jrCss('--green') : jrCss('--red');
    x.globalAlpha = 0.85; x.fillRect(bx, by, bwid, bhh); x.globalAlpha = 1;
    if (i === bestIdx && v > 0) { x.strokeStyle = jrCss('--accent'); x.lineWidth = 2; x.strokeRect(bx - 1, by - 1, bwid + 2, bhh + 2); }
    x.fillStyle = jrCss('--text-dim'); x.font = '9px "JetBrains Mono", monospace'; x.textAlign = 'center';
    x.fillText(r.label, 5 + i * bw + bw / 2, h - 12);
    x.fillText('n=' + r.n, 5 + i * bw + bw / 2, h - 3);
  });
  x.strokeStyle = jrCss('--border2');
  x.beginPath(); x.moveTo(5, zero); x.lineTo(w - 5, zero); x.stroke();
}

// ── Scalp Stats section ────────────────────────────────────────────────────────
// jrScalpStatsHtml(trades, opts) — reusable for both the overall Journal view
// (no args → all trades across every day) and a single Daily Journal row
// (pass that day's trade array + { compact: true, dayLabel: date }).
// BUG FIX 2026-08-01 (Anoop caught it): gap calc previously read t.entryMs /
// t.exitMs, but persisted trade records (see csvApply ~line 6379) use t.t
// (entry ms) and t.x (exit ms) — entryMs/exitMs don't exist on these objects,
// so the gaps array was always empty and Avg Gap silently showed 0s no
// matter how many trades. Fixed to read the real fields.
function jrScalpStatsHtml(tradesIn, opts) {
  opts = opts || {};
  const rules = getRules();
  const mode = (rules.tradingMode || 'standard');
  const trades = (tradesIn || jrAllTrades()).filter(t => typeof t.hold === 'number');
  if (!trades.length) return '';

  // Hold-time buckets
  const buckets = [
    { label: '<1m', max: 60 },
    { label: '1-5m', max: 300 },
    { label: '5-10m', max: 600 },
    { label: '10-30m', max: 1800 },
    { label: '>30m', max: Infinity }
  ];
  const counts = buckets.map(() => 0);
  let totalHold = 0;
  const holds = [];
  trades.forEach(t => {
    const h = t.hold;
    totalHold += h;
    holds.push(h);
    for (let i = 0; i < buckets.length; i++) {
      if (h <= buckets[i].max) { counts[i]++; break; }
    }
  });
  holds.sort((a, b) => a - b);
  const avgHold = totalHold / trades.length;
  const medHold = holds.length % 2 === 0
    ? (holds[holds.length / 2 - 1] + holds[holds.length / 2]) / 2
    : holds[Math.floor(holds.length / 2)];

  // Inter-trade gaps — real fields are t (entry ms) and x (exit ms), NOT
  // entryMs/exitMs. Sort by entry time first (trades may not arrive sorted
  // when pulled cross-day via jrAllTrades).
  //
  // CHANGED 2026-08-01 (Anoop): report MEDIAN gap, not mean. On 2026-07-31
  // the mean read "28m 27s" while the actual NY re-entry gaps were 169s,
  // 395s, 40s, 11s, 66s — the mean was single-handedly dragged up by one
  // ~2h46m cross-session gap between an afternoon trade and the NY open.
  // That made a session with five sub-15-minute cooldown violations look
  // like a patient one. Median ignores that outlier and reflects how fast
  // he actually re-enters. Mean is still computed and shown as a secondary
  // number so a big cross-session gap is still visible, just not headline.
  const sorted = trades.slice().sort((a, b) => (a.t || 0) - (b.t || 0));
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].t != null && sorted[i - 1].x != null) {
      const g = (sorted[i].t - sorted[i - 1].x) / 1000;
      if (g >= 0) gaps.push(g);
    }
  }
  const gapsSorted = gaps.slice().sort((a, b) => a - b);
  const medGap = gapsSorted.length
    ? (gapsSorted.length % 2 === 0
        ? (gapsSorted[gapsSorted.length / 2 - 1] + gapsSorted[gapsSorted.length / 2]) / 2
        : gapsSorted[Math.floor(gapsSorted.length / 2)])
    : 0;
  const meanGap = gaps.length ? gaps.reduce((a, v) => a + v, 0) / gaps.length : 0;
  // Cooldown violations: re-entries faster than the 15-min break rule (#7).
  const cooldownBreaches = gaps.filter(g => g < 900).length;

  // Hold-exceeded count
  const maxHold = mode === 'scalper' ? (rules.maxHoldSeconds || 1800) : Infinity;
  const holdExceeded = trades.filter(t => t.hold > maxHold).length;

  function fmt(sec) {
    if (sec < 60) return Math.round(sec) + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + Math.round(sec % 60) + 's';
    return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
  }

  // Build the bar chart data for hold-time distribution
  const maxCount = Math.max(...counts, 1);
  const barH = opts.compact ? 44 : 60;
  const tilePad = opts.compact ? '5px 7px' : '6px 8px';
  const tileFont = opts.compact ? '13px' : '15px';

  let html = '<div class="analysis-block" style="margin-top:' + (opts.compact ? '8px' : '12px') + '">';
  if (!opts.compact) {
    html += '<div class="analysis-header" style="font-size:13px;font-weight:600;margin-bottom:8px">';
    html += '&#9201; Scalp Stats' + (mode === 'scalper' ? ' <span style="color:var(--amber);font-size:11px">(SCALPER MODE)</span>' : '') + '</div>';
  } else {
    html += '<div style="font-size:11px;font-weight:600;margin-bottom:6px;color:var(--text-dim)">&#9201; Scalp Stats — ' + (opts.dayLabel || '') + '</div>';
  }

  // Stat tiles row
  html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
  const tile = (label, val, color) => '<div style="flex:1;min-width:80px;padding:' + tilePad + ';background:var(--surface);border-radius:6px;border:1px solid var(--border)">' +
    '<div style="font-size:10px;color:var(--text-dim)">' + label + '</div>' +
    '<div style="font-size:' + tileFont + ';font-weight:600;color:' + (color || 'var(--text)') + '">' + val + '</div></div>';
  html += tile('Avg Hold', fmt(avgHold));
  html += tile('Med Hold', fmt(medHold));
  html += tile('Med Gap', fmt(medGap));
  html += tile('Trades', trades.length + '');
  // Cooldown breaches are the number that actually predicts blow-ups
  // (revenge clusters), so it gets a tile of its own in every mode.
  html += tile('Cooldown Breaks', cooldownBreaches + '/' + gaps.length, cooldownBreaches > 0 ? 'var(--red)' : 'var(--green)');
  if (mode === 'scalper') html += tile('Hold Exceeded', holdExceeded + '', holdExceeded > 0 ? 'var(--red)' : 'var(--green)');
  html += '</div>';
  if (gaps.length && meanGap > medGap * 2) {
    html += '<div style="font-size:10px;color:var(--text-dim);margin:-4px 0 8px">'
      + 'Mean gap ' + fmt(meanGap) + ' is skewed by an outlier gap — median (' + fmt(medGap) + ') reflects your actual re-entry speed.</div>';
  }

  // Hold-time distribution bar chart (inline CSS bars)
  html += '<div style="font-size:10px;color:var(--text-dim);margin-bottom:4px">Hold-Time Distribution</div>';
  html += '<div style="display:flex;gap:4px;align-items:flex-end;height:' + barH + 'px;margin-bottom:4px">';
  counts.forEach((c, i) => {
    const pct = c / maxCount * 100;
    const color = (mode === 'scalper' && i >= 4) ? 'var(--red)' : 'var(--accent)';
    html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">';
    html += '<div style="font-size:9px;color:var(--text-mid);margin-bottom:2px">' + c + '</div>';
    html += '<div style="width:100%;max-width:36px;height:' + Math.max(pct, 2) + '%;background:' + color + ';border-radius:3px 3px 0 0;opacity:0.8"></div>';
    html += '</div>';
  });
  html += '</div>';
  html += '<div style="display:flex;gap:4px">';
  buckets.forEach(b => {
    html += '<div style="flex:1;text-align:center;font-size:9px;color:var(--text-dim)">' + b.label + '</div>';
  });
  html += '</div>';

  html += '</div>';
  return html;
}

// ── Phase 1: P&L calendar ──────────────────────────────────────────────────────
function jrCalendarHtml() {
  const ledger = jrLS('copilot_balance_ledger', {});
  const gr = {}; jrLS('copilot_gr_history', []).forEach(d => { gr[d.date] = d; });
  const now = new Date(); const base = new Date(now.getFullYear(), now.getMonth() + jrMonthOffset, 1);
  const y = base.getFullYear(), m = base.getMonth();
  const monthName = base.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  let html = '<div class="jr-cal-head"><button class="jr-nav" onclick="jrMonthOffset--;renderJournal()">‹</button><b>' + monthName + '</b><button class="jr-nav" onclick="jrMonthOffset++;renderJournal()"' + (jrMonthOffset >= 0 ? ' disabled' : '') + '>›</button></div>';
  html += '<div class="jr-cal">';
  ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(d => html += '<div class="jr-dow">' + d + '</div>');
  html += '<div class="jr-dow jr-wk">Wk</div>';
  let day = 1, weekSum = 0, weekHad = false;
  for (let row = 0; row < 6 && day <= daysInMonth; row++) {
    for (let col = 0; col < 7; col++) {
      if ((row === 0 && col < firstDow) || day > daysInMonth) { html += '<div class="jr-day jr-empty"></div>'; continue; }
      const key = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      const led = ledger[key];
      if (led) {
        const cls = led.net > 0 ? 'jr-green' : led.net < 0 ? 'jr-red' : 'jr-flat';
        const g = gr[key];
        weekSum += led.net; weekHad = true;
        html += '<div class="jr-day ' + cls + '" title="' + fmtDMY(key) + ': ' + jrMoney(led.net) + (g ? ' · ' + g.n + ' trades · disc ' + g.disc + '%' : '') + '"><span class="jr-dn">' + day + '</span><span class="jr-pnl">' + jrMoney(led.net) + '</span>' + (g ? '<span class="jr-tc">' + g.n + 't</span>' : '') + '</div>';
      } else {
        html += '<div class="jr-day"><span class="jr-dn">' + day + '</span></div>';
      }
      day++;
    }
    html += '<div class="jr-day jr-wk ' + (weekHad ? (weekSum > 0 ? 'jr-green' : weekSum < 0 ? 'jr-red' : 'jr-flat') : '') + '">' + (weekHad ? '<span class="jr-pnl">' + jrMoney(weekSum) + '</span>' : '') + '</div>';
    weekSum = 0; weekHad = false;
  }
  return html + '</div>';
}

// ── Phase 4: trade log ─────────────────────────────────────────────────────────
function jrTradeLogHtml() {
  const trades = jrAllTrades().reverse().slice(0, 60);
  if (!trades.length) return '';
  const rows = trades.map(t => {
    const time = t.t ? new Date(t.t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' }) : '—';
    const hold = t.hold != null ? (t.hold >= 60 ? Math.round(t.hold / 60) + 'm' : t.hold + 's') : '—';
    return '<tr><td>' + fmtDM(t.date) + '</td><td>' + time + '</td><td class="' + (t.side === 'long' ? 'jr-g' : t.side === 'short' ? 'jr-r' : '') + '">' + (t.side || '—') + '</td><td>' + (t.size || '—') + '</td><td>' + hold + '</td><td class="' + (t.pnl >= 0 ? 'jr-g' : 'jr-r') + '">' + jrMoney(t.pnl) + '</td></tr>';
  }).join('');
  return '<div class="analysis-block"><div class="block-title">Trade Log — last ' + trades.length + '</div><div class="jr-tbl-wrap"><table class="jr-tbl"><thead><tr><th>Date</th><th>Time</th><th>Side</th><th>Size</th><th>Hold</th><th>P&L</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}

// ── Main render ────────────────────────────────────────────────────────────────
async function renderJournal() {
  const body = document.getElementById('journal-body'); if (!body) return;
  await djLoad();   // per-account notes + screenshot index
  _jrArchiveOverlay = null; // reset any previous overlay
  let archiveBanner = '';
  let ledger = jrLS('copilot_balance_ledger', {});
  let days = Object.keys(ledger).sort();
  // Fallback: if the current slot has no data, check archives for historical
  // trading data. This handles the case where data was ingested under a previous
  // account that was later breached/archived, leaving the current slot empty.
  if (!days.length) {
    const archives = await loadArchives();
    // Merge ls data from ALL archives (oldest first so newest overwrites)
    if (archives.length) {
      const merged = {};
      archives.forEach(rec => {
        if (!rec.ls) return;
        ACCT_LS_KEYS.forEach(k => { if (rec.ls[k] != null) merged[k] = rec.ls[k]; });
      });
      if (merged.copilot_balance_ledger) {
        _jrArchiveOverlay = merged;
        ledger = jrLS('copilot_balance_ledger', {});
        days = Object.keys(ledger).sort();
        if (days.length) {
          const labels = archives.map(r => r.label || (r.size ? '$' + r.size.toUpperCase() + ' ' + (r.stage || '') : 'Unknown')).join(', ');
          archiveBanner = '<div class="jr-archive-banner">📦 Showing data from archived account' + (archives.length > 1 ? 's' : '') + ': ' + labels + '. Ingest a new CSV to populate the current account.</div>';
        }
      }
    }
  }
  if (!days.length) { _jrArchiveOverlay = null; body.innerHTML = '<div class="no-trades">No trading days ingested yet — upload a Performance report in Update File and the journal builds itself.</div>'; return; }

  // Show WHERE this account's data is being written, in the UI — so there's no
  // need to read a server console to know if the drive path worked.
  let dirLine = '';
  try {
    const d = await window.api.dataDirGet();
    const slot = (typeof acctSlot === 'function') ? acctSlot() : null;
    if (d) {
      const isFallback = /MNQ-CoPilot-App[\\/]data$/i.test(d);
      dirLine = '<div class="jr-datadir' + (isFallback ? ' warn' : '') + '">'
        + (isFallback ? '⚠ Saving inside the app folder (D:\\co-pilot DATA was not reachable): ' : '💾 Saving to: ')
        + d + (slot ? '\\accounts\\' + slot.id : '') + '</div>';
    }
  } catch (e) {}

  const s = jrStats();
  const tile = (k, v, cls) => '<div class="jr-tile ' + (cls || '') + '"><div class="jr-k">' + k + '</div><div class="jr-v">' + v + '</div></div>';

  // 2026-08-13: points + sizing tile, driven by window.PointsTracker — the
  // same math behind the -2.99 pts/trade figure Anoop was given in chat, now
  // computed live instead of re-typed by hand every morning.
  const PT = window.PointsTracker;
  const allTr = jrAllTrades();
  const ptSummary = PT ? PT.summarize(allTr) : null;
  const rollRatio = PT ? PT.rollingRatio(allTr, 10) : null;
  const guidance = PT ? PT.sizeGuidance(rollRatio) : null;

  let html = archiveBanner + dirLine + '<div class="jr-grid">'
    + tile('Net P&L', jrMoney(s.net), s.net >= 0 ? 'jr-g' : 'jr-r')
    + tile('Win rate', s.winRate.toFixed(1) + '%', s.winRate >= 50 ? 'jr-g' : 'jr-r')
    + tile('Profit factor', s.pf === Infinity ? '∞' : s.pf.toFixed(2), s.pf >= 1.3 ? 'jr-g' : s.pf >= 1 ? '' : 'jr-r')
    + tile('Avg win / loss', jrMoney(s.avgW) + ' / ' + jrMoney(-s.avgL), s.avgW > s.avgL ? 'jr-g' : 'jr-r')
    + tile('Expectancy/trade', jrMoney(s.expectancy), s.expectancy >= 0 ? 'jr-g' : 'jr-r')
    + tile('Days', s.greenDays + '/' + s.nDays + ' green', '')
    + (ptSummary ? tile('Points/trade', (ptSummary.expectancyPts >= 0 ? '+' : '') + ptSummary.expectancyPts.toFixed(1) + ' pts', ptSummary.expectancyPts >= 0 ? 'jr-g' : 'jr-r') : '')
    + (rollRatio != null ? tile('Rolling ratio (10)', rollRatio === Infinity ? '∞' : rollRatio.toFixed(2) + ':1', rollRatio >= 1 ? 'jr-g' : 'jr-r') : '')
    + '</div>';

  if (guidance) {
    html += '<div class="jr-sizing-note' + (guidance.tier === 'minimum' ? ' jr-r' : guidance.tier === 'step-up' ? ' jr-g' : '') + '" style="font-size:12px;padding:6px 10px;margin:0 0 10px;">'
      + '<b>Sizing right now:</b> ' + guidance.label + '</div>';
  }

  const sweetRows = jrSizeSweetSpot();
  if (sweetRows.length) {
    html += '<div class="analysis-block"><div class="block-title">Size sweet spot — expectancy (pts) by size</div>'
      + jrCanvas('jr-sweetspot', 120)
      + '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;">Outlined bar = best expectancy bucket. This is computed from every trade on this account, not a guess.</div>'
      + '</div>';
  }

  html += '<div class="analysis-block"><div class="block-title">Equity Curve — cumulative net</div>' + jrCanvas('jr-equity', 130) + '</div>';
  html += '<div class="analysis-block">' + jrCalendarHtml() + '</div>';
  html += '<div class="analysis-block"><div class="block-title">Co-Pilot Radar — latest day</div>' + jrCanvas('jr-radar', 170) + '</div>';
  // ── Scalp Stats section (visible in any mode, highlights scalp performance) ──
  html += jrScalpStatsHtml();

  // Daily Journal — collapsible per-day rows (newest first), each with its own
  // saved note + screenshots for THIS account.
  const dtAll = jrLS('copilot_day_trades', {});
  const histByDate = {}; jrLS('copilot_gr_history', []).forEach(d => { histByDate[d.date] = d; });
  const djDates = Array.from(new Set(Object.keys(ledger).concat(Object.keys(dtAll)))).sort().reverse();
  html += '<div class="analysis-block"><div class="block-title">Daily Journal — ' + djDates.length + ' day' + (djDates.length === 1 ? '' : 's') + ' · click a day to expand</div>'
        + djDates.map(d => djDayRow(d, histByDate[d] || (ledger[d] ? { pnl: ledger[d].net, gross: ledger[d].gross, disc: 0 } : null), (dtAll[d] || []))).join('')
        + '</div>';

  html += jrTradeLogHtml();

  // Phase 5: reports
  html += '<div class="analysis-block"><div class="block-title">P&L by weekday</div>' + jrCanvas('jr-dow', 110) + '</div>';
  html += '<div class="analysis-block"><div class="block-title">P&L by hour (IST)</div>' + jrCanvas('jr-hour', 110) + '</div>';
  body.innerHTML = html;

  // Draw after DOM exists
  let cum = 0; const eq = days.map(d => (cum += ledger[d].net || 0));
  jrDrawLine('jr-equity', eq);
  if (sweetRows.length) jrDrawSizeSweetSpot('jr-sweetspot', sweetRows);

  const hist = jrLS('copilot_gr_history', []);
  const last = hist[hist.length - 1];
  const cs = (typeof computeDayScore === 'function' && last) ? computeDayScore(last) : null;
  const disc7 = hist.slice(-7);
  const discAvg = disc7.length ? disc7.reduce((a, d) => a + (d.disc || 0), 0) / disc7.length : 0;
  jrDrawRadar('jr-radar', ['Rules', 'Risk', 'Edge', 'Process', 'Consistency'],
    cs ? [cs.ruleAdh, cs.risk, cs.edge, cs.process, discAvg] : [0, 0, 0, 0, discAvg]);

  const dowSum = [0, 0, 0, 0, 0]; // Mon..Fri
  hist.forEach(d => { if (d.dow >= 1 && d.dow <= 5) dowSum[d.dow - 1] += d.pnl; });
  jrDrawBars('jr-dow', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], dowSum);

  // per-day mini equity curves + points/sizing bars (only the expanded ones
  // exist in the DOM)
  Object.keys(djOpen).forEach(d => {
    if (!djOpen[d]) return;
    const tr = (dtAll[d] || []);
    if (tr.length < 2) return;
    let c = 0; jrDrawLine('dj-eq-' + d, tr.map(t => (c += t.pnl)));
    jrDrawPointsBars('dj-pts-' + d, tr);
  });

  const hourSum = {};
  jrAllTrades().forEach(t => {
    if (!t.t) return;
    const h = new Date(t.t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit' });
    hourSum[h] = (hourSum[h] || 0) + t.pnl;
  });
  const hours = Object.keys(hourSum).sort();
  jrDrawBars('jr-hour', hours.map(h => h + 'h'), hours.map(h => hourSum[h]));
  _jrArchiveOverlay = null; // clean up after render
}

// ═══════════════════════════════════════════════════════════════════════════════
// END DAY — per-account daily snapshot to D:\co-pilot DATA (2026-07-25)
// Anoop: "update them everyday after i click end day … i need data of all the
// accounts separately if cleared eval or breached eval."
// Writes an immutable dated file into the ACTIVE account's own folder, refreshes
// that account's meta.json, and flushes every live localStorage key to its
// per-account disk mirror so nothing lives only in the browser.
// ═══════════════════════════════════════════════════════════════════════════════
function edToday() {
  // IST calendar date — trading day boundary is Anoop's local day.
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => (p.filter(x => x.type === t)[0] || {}).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

// 2026-08-18: "if I forget to save it should autosave at 8pm IST daily." The
// server broadcasts 'auto-end-day-trigger' once per IST calendar day at/after
// 20:00 (see checkEndDayAutosave in server.js); this only actually calls
// endDay() if the active slot's own persisted meta shows it wasn't already
// saved TODAY — a manual "End Day & Save" click earlier the same day makes
// this a no-op instead of a second (redundant) post-session-review run.
// dataEndDay()'s write is a fixed per-date filename regardless (see
// dataEndDay() in server.js), so even a genuine double-call overwrites the
// same record rather than duplicating it — this guard exists to avoid
// re-firing the expensive Jessi post-session analysis, not to prevent data
// duplication (that's already impossible by construction).
async function handleEndDayAutoTrigger(date) {
  if (!date) return;
  const slot = (typeof acctSlot === 'function') ? acctSlot() : null;
  if (!slot) return;
  let meta = null;
  try { meta = await window.api.dataLoad('meta__' + slot.id); } catch (e) {}
  if (meta && meta.lastEndDay === date) return; // already saved today, manually
  await endDay();
}

async function endDay() {
  const slot = (typeof acctSlot === 'function') ? acctSlot() : null;
  if (!slot) { addSystemMessage('No active account — open ⇄ Account first.'); return; }
  const date = edToday();
  const acc = state.account || {};
  const prof = ACCOUNT_PROFILES[slot.size][slot.stage];
  const isEval = slot.stage === 'eval';
  const floor = isEval ? acc.evalFloor : acc.fundedFloor;
  const target = isEval ? (acc.evalTarget || prof.startBalance + (prof.target || 0)) : null;

  const ls = (k, fb) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || fb; } catch (e) { return fb; } };
  const hist = ls('copilot_gr_history', []);
  const ledger = ls('copilot_balance_ledger', {});
  const today = hist.filter(d => d.date === date)[0] || null;

  const snapshot = {
    date,
    account: { slotId: slot.id, name: slot.name, size: slot.size, stage: slot.stage, accountId: prof.accountId || null },
    closing: {
      balance: acc.balance, floor: floor, target: target,
      cushionToFloor: (acc.balance != null && floor != null) ? Math.round((acc.balance - floor) * 100) / 100 : null,
      toTarget: (target != null && acc.balance != null) ? Math.round((target - acc.balance) * 100) / 100 : null
    },
    today: today,                       // trades/pnl/discipline for the day, if a CSV was ingested
    daysLogged: Object.keys(ledger).length,
    savedAt: new Date().toISOString()
  };

  // 1) immutable dated snapshot
  let savedPath = null;
  try {
    const r = await window.api.dataEndDay(slot.id, date, snapshot);
    savedPath = r && r.path;
  } catch (e) {}

  // 2) refresh this account's meta + flush every per-account key to its folder
  try {
    await window.api.dataSave('meta__' + slot.id, {
      slotId: slot.id, name: slot.name, size: slot.size, stage: slot.stage,
      accountId: prof.accountId || null,
      status: slot.retired ? 'breached' : 'active',
      startBalance: prof.startBalance,
      lastBalance: acc.balance, lastFloor: floor, target: target,
      lastEndDay: date, updatedAt: new Date().toISOString()
    });
    const flush = [
      ['gr_history', 'copilot_gr_history', []], ['balance_ledger', 'copilot_balance_ledger', {}],
      ['day_trades', 'copilot_day_trades', {}], ['pb_tags', 'copilot_pb_tags', {}],
      ['maemfe', 'copilot_maemfe', {}], ['loop_state', 'copilot_loop', {}],
      ['eval_milestones', 'copilot_eval_milestones', {}], ['ck_history', 'copilot_ck_history', []]
    ];
    for (const [base, lsKey, fb] of flush) {
      await window.api.dataSave(base + '__' + slot.id, ls(lsKey, fb));
    }
  } catch (e) {}

  // 3) persist the bucket too, so a crash can't lose the day
  if (typeof saveActiveBucket === 'function') saveActiveBucket();

  const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n || 0)).toLocaleString();
  addSystemMessage(
    `📁 Day closed for "${slot.name}" (${fmtDMY(date)}).\n` +
    `Balance ${money(acc.balance)} · floor ${money(floor)}` + (target ? ` · target ${money(target)}` : '') +
    (today ? `\nToday: ${today.n} trades · net ${money(today.pnl)} · discipline ${today.disc}%` : '\nNo CSV ingested for today — snapshot saved with balances only.') +
    (savedPath ? `\nSaved to: ${savedPath}` : '\n⚠ Could not write the snapshot file — check the data folder path.')
  );
  if (typeof renderJournal === 'function' && document.getElementById('tab-journal') && document.getElementById('tab-journal').style.display !== 'none') renderJournal();

  // 2026-08-12: this is the ONE moment the full report is genuinely wanted —
  // Anoop: "At the end of the session, I will upload only once. That is when I
  // need all the details." It no longer fires on every CSV upload, so End Day
  // is where it belongs. Delayed so the summary above renders first, and only
  // when a session actually happened — closing a no-trade day should not spend
  // ~7K tokens analysing nothing.
  if (today && today.n > 0) {
    setTimeout(() => { try { runPostSessionReview(); } catch (e) {} }, 1500);
  }
}

// Final record when an account closes — breached or cleared. Written into that
// account's own folder so each eval's outcome is preserved separately.
async function closeAccountRecord(slot, status) {
  if (!slot) return;
  const ls = (k, fb) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || fb; } catch (e) { return fb; } };
  const prof = ACCOUNT_PROFILES[slot.size][slot.stage];
  const rec = {
    slotId: slot.id, name: slot.name, size: slot.size, stage: slot.stage,
    accountId: prof.accountId || null, status,
    closedOn: edToday(),
    finalBalance: (state.account || {}).balance,
    startBalance: prof.startBalance,
    daysTraded: Object.keys(ls('copilot_balance_ledger', {})).length,
    history: ls('copilot_gr_history', []),
    ledger: ls('copilot_balance_ledger', {}),
    closedAt: new Date().toISOString()
  };
  try { await window.api.dataSave('CLOSED_' + status + '__' + slot.id, rec); } catch (e) {}
  return rec;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY JOURNAL (2026-07-25) — TradeZella-style, per ACTIVE ACCOUNT.
// Anoop: "the trade journal should convert to daily journal and should look like
// the screenshot. each day should have its own typing details that is saved. Use
// drop down for better detailing." Plus: attach chart screenshots per day.
// Each day is a collapsible row: header (date + net P&L) → expanded stats grid,
// mini equity curve, trade table, a saved NOTE, and screenshot thumbnails.
// Notes live in accounts/<slot>/notes.json ; images in accounts/<slot>/screenshots/.
// ═══════════════════════════════════════════════════════════════════════════════
let djOpen = {};        // date → expanded?
let djNotes = {};       // date → {text, mood, followedPlan, mistake, lesson}
let djShots = {};       // date → [filenames]

const DJ_MOODS = ['', 'calm', 'focused', 'rushed', 'frustrated', 'revenge', 'fearful', 'overconfident'];
const DJ_YN = ['', 'yes', 'partly', 'no'];
const DJ_MISTAKES = ['', 'none', 'overtraded', 'revenge re-entry', 'oversized', 'moved stop', 'cut winner early',
  'held loser', 'traded both sides', 'no pre-marked zone', 'traded outside session', 'chased entry'];

async function djLoad() {
  const slot = (typeof acctSlot === 'function') ? acctSlot() : null;
  if (!slot) return;
  try { djNotes = (await window.api.dataLoad('notes__' + slot.id)) || {}; } catch (e) { djNotes = {}; }
  try {
    const all = await window.api.shotList(slot.id, '');
    djShots = {};
    (all || []).forEach(f => { const d = f.split('__')[0]; (djShots[d] = djShots[d] || []).push(f); });
  } catch (e) { djShots = {}; }
}

window.djToggle = function (date) { djOpen[date] = !djOpen[date]; renderJournal(); };

window.djSaveNote = async function (date) {
  const slot = acctSlot(); if (!slot) return;
  const g = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  const note = {
    text: g('dj-text-' + date),
    mood: g('dj-mood-' + date),
    followedPlan: g('dj-plan-' + date),
    mistake: g('dj-mistake-' + date),
    lesson: g('dj-lesson-' + date),
    savedAt: new Date().toISOString()
  };
  djNotes[date] = note;
  const ok = await window.api.noteSave(slot.id, date, note);
  const badge = document.getElementById('dj-saved-' + date);
  if (badge) { badge.textContent = ok ? 'Saved ✓' : 'Save failed'; badge.style.color = ok ? 'var(--green)' : 'var(--red)'; }
  // ADDED 2026-07-28 (Anoop): clear the form back to blank right after a
  // successful save, instead of leaving it showing what was just typed. The
  // saved note itself is untouched (djNotes[date] still has it, badge still
  // says "Saved ✓") — re-expanding this day later re-populates the fields
  // from the saved note as before; this reset only affects the moment
  // right after you hit Save.
  if (ok) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
    set('dj-mood-' + date, '');
    set('dj-plan-' + date, '');
    set('dj-mistake-' + date, '');
    set('dj-text-' + date, '');
    set('dj-lesson-' + date, '');
  }
};

window.djAddShot = function (date) {
  const slot = acctSlot(); if (!slot) return;
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const ext = (f.name.split('.').pop() || 'png').toLowerCase();
    const b64 = await new Promise(res => { const r = new FileReader(); r.onloadend = () => res(String(r.result)); r.readAsDataURL(f); });
    const saved = await window.api.shotSave(slot.id, date, b64, ext);
    if (saved) { (djShots[date] = djShots[date] || []).push(saved); addSystemMessage('Chart saved to "' + slot.name + '" → screenshots/' + saved); renderJournal(); }
    else addSystemMessage('Could not save that image — png/jpg/webp only.');
  };
  inp.click();
};

window.djViewShot = async function (file) {
  const slot = acctSlot(); if (!slot) return;
  const url = await window.api.shotRead(slot.id, file);
  if (!url) return;
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:24px;';
  ov.onclick = () => ov.remove();
  ov.innerHTML = '<img src="' + url + '" style="max-width:100%;max-height:100%;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.6)">';
  document.body.appendChild(ov);
};

// One collapsible day row
function djDayRow(date, dayStats, trades) {
  const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n || 0)).toLocaleString();
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
  const gW = wins.reduce((a, t) => a + t.pnl, 0), gL = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = gL > 0 ? (gW / gL).toFixed(2) : (gW > 0 ? '∞' : '--');
  const wr = trades.length ? (wins.length / trades.length * 100).toFixed(2) + '%' : '--';
  const vol = trades.reduce((a, t) => a + (t.size || 0), 0);
  const net = dayStats ? dayStats.pnl : trades.reduce((a, t) => a + t.pnl, 0);
  const gross = dayStats && dayStats.gross != null ? dayStats.gross : trades.reduce((a, t) => a + t.pnl, 0);
  const comm = Math.round((gross - net) * 100) / 100;
  const open = !!djOpen[date];
  const note = djNotes[date] || {};
  const shots = djShots[date] || [];
  const dow = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });

  let h = '<div class="dj-day' + (open ? ' open' : '') + '">';
  h += '<div class="dj-head" onclick="djToggle(\'' + date + '\')">'
     + '<span class="dj-caret">' + (open ? '⌄' : '›') + '</span>'
     + '<span class="dj-date">' + dow + ', ' + fmtDMY(date) + '</span>'
     + '<span class="dj-net ' + (net >= 0 ? 'jr-g' : 'jr-r') + '">Net P&L ' + money(net) + '</span>'
     + (note.text || note.mistake ? '<span class="dj-hasnote">note</span>' : '')
     + (shots.length ? '<span class="dj-hasnote">' + shots.length + ' 📷</span>' : '')
     + '</div>';

  if (open) {
    h += '<div class="dj-body">';
    h += '<div class="dj-statgrid">'
      + '<div><span>Total Trades</span><b>' + trades.length + '</b></div>'
      + '<div><span>Winners</span><b class="jr-g">' + wins.length + '</b></div>'
      + '<div><span>Gross P&L</span><b>' + money(gross) + '</b></div>'
      + '<div><span>Commissions</span><b>' + money(comm) + '</b></div>'
      + '<div><span>Winrate</span><b>' + wr + '</b></div>'
      + '<div><span>Losers</span><b class="jr-r">' + losses.length + '</b></div>'
      + '<div><span>Volume</span><b>' + vol + '</b></div>'
      + '<div><span>Profit Factor</span><b>' + pf + '</b></div>'
      + (dayStats ? '<div><span>Discipline</span><b>' + dayStats.disc + '%</b></div>' : '')
      + (dayStats && dayStats.revenge ? '<div><span>Revenge</span><b class="jr-r">' + dayStats.revenge + '</b></div>' : '')
      + '</div>';

    h += '<canvas id="dj-eq-' + date + '" height="70" style="width:100%;display:block;margin:8px 0 4px;"></canvas>';

    // 2026-08-13: points captured per trade THIS day, bar opacity = contract
    // size relative to the day's biggest trade. A big dark bar in red is the
    // oversizing mistake, visible without reading the table below it.
    if (trades.length >= 2) {
      h += '<div style="font-size:10px;color:var(--text-dim);margin:6px 0 2px;">Points per trade — darker bar = bigger size</div>'
        + '<canvas id="dj-pts-' + date + '" height="60" style="width:100%;display:block;margin:0 0 4px;"></canvas>';
    }

    // Per-day Scalp Stats — hold-time distribution, avg/med hold, avg gap,
    // hold-exceeded, for THIS day only (Anoop asked for per-day, not just
    // the overall Journal aggregate, so he can see what to fix day by day).
    h += jrScalpStatsHtml(trades, { compact: true, dayLabel: dow + ', ' + fmtDMY(date) });

    if (trades.length) {
      // ADDED 2026-07-28 (Anoop): Points column = realized exit-entry move,
      // signed for direction (long: exit-entry, short: entry-exit) — comes
      // from mp/xp/ep persisted per trade by csvApply. Older CSVs imported
      // before this change won't have mp, so those rows just show '—'.
      // ADDED 2026-08-01 (Anoop): leading "#" serial column so trades can be
      // referred to by number in coaching conversations ("trade 3 was the
      // revenge entry") instead of by timestamp. Numbering is 1-based and
      // follows the same order the table renders in (chronological), so the
      // number shown here matches what the Scalper agent quotes back.
      // Also flags each row's violations inline (from t.flags set at ingest)
      // so a bad trade is visible without cross-referencing another panel.
      h += '<div class="jr-tbl-wrap" style="max-height:200px"><table class="jr-tbl"><thead><tr>'
        + '<th style="width:28px">#</th><th>Open</th><th>Side</th><th>Size</th><th>Hold</th><th>Points</th><th>Net P&L</th><th>Flags</th></tr></thead><tbody>';
      trades.forEach((t, ti) => {
        const tm = t.t ? new Date(t.t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '—';
        const hold = t.hold != null ? (t.hold >= 60 ? Math.round(t.hold / 60) + 'm' : t.hold + 's') : '—';
        const pts = t.mp != null ? (t.mp >= 0 ? '+' : '') + t.mp.toFixed(2) : '—';
        const fl = (t.flags || []);
        const flHtml = fl.length
          ? fl.map(f => '<span class="dj-flag" title="' + f + '">' + f + '</span>').join(' ')
          : '<span style="opacity:.35">clean</span>';
        h += '<tr><td style="opacity:.55;font-variant-numeric:tabular-nums">' + (ti + 1) + '</td><td>' + tm + '</td><td class="' + (t.side === 'long' ? 'jr-g' : t.side === 'short' ? 'jr-r' : '') + '">' + (t.side || '—')
           + '</td><td>' + (t.size || '—') + '</td><td>' + hold + '</td><td class="' + (t.mp > 0 ? 'jr-g' : t.mp < 0 ? 'jr-r' : '') + '">' + pts + '</td><td class="' + (t.pnl >= 0 ? 'jr-g' : 'jr-r') + '">' + money(t.pnl) + '</td><td style="font-size:10px">' + flHtml + '</td></tr>';
      });
      h += '</tbody></table></div>';

      // ADDED 2026-07-28 (Anoop): realized win:loss ratio recomputed every 2
      // trades (avgWin ÷ avgLoss within each consecutive pair) — this is a
      // REALIZED ratio from actual fills, not a planned R:R, since the CSV
      // never carries the stop/target price that was set on the order.
      const pairs = [];
      for (let i = 0; i < trades.length; i += 2) pairs.push(trades.slice(i, i + 2));
      h += '<div class="jr-pairs" style="margin-top:6px;font-size:12px;opacity:.85">';
      pairs.forEach((pair, pi) => {
        const idxLabel = pair.length === 2 ? ('Trades ' + (pi * 2 + 1) + '–' + (pi * 2 + 2)) : ('Trade ' + (pi * 2 + 1));
        const wins = pair.filter(t => t.pnl > 0), losses = pair.filter(t => t.pnl < 0);
        const avgW = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
        const avgL = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
        const ratio = avgL > 0 ? '1:' + (avgW / avgL).toFixed(2) : (avgW > 0 ? 'all wins' : (wins.length === 0 && losses.length === 0 ? '—' : 'all losses'));
        h += '<div>' + idxLabel + ' — avgWin ' + money(avgW) + ' / avgLoss ' + money(avgL) + ' → <b>' + ratio + '</b></div>';
      });
      h += '</div>';
    }

    // Dropdown-driven detail + free text, saved per day per account
    const sel = (id, opts, val, label) => '<label class="dj-f"><span>' + label + '</span><select id="' + id + '">'
      + opts.map(o => '<option value="' + o + '"' + (val === o ? ' selected' : '') + '>' + (o || '—') + '</option>').join('') + '</select></label>';
    h += '<div class="dj-note">'
      + '<div class="dj-fields">'
        + sel('dj-mood-' + date, DJ_MOODS, note.mood || '', 'State of mind')
        + sel('dj-plan-' + date, DJ_YN, note.followedPlan || '', 'Followed the plan')
        + sel('dj-mistake-' + date, DJ_MISTAKES, note.mistake || '', 'Main mistake')
      + '</div>'
      + '<textarea id="dj-text-' + date + '" class="dj-text" rows="3" placeholder="What happened today — setups, how you felt, what you would repeat…">' + (note.text || '').replace(/</g, '&lt;') + '</textarea>'
      + '<input id="dj-lesson-' + date + '" class="dj-lesson" placeholder="One lesson to carry into tomorrow" value="' + (note.lesson || '').replace(/"/g, '&quot;') + '">'
      + '<div class="dj-actions">'
        + '<button class="jr-nav dj-btn" onclick="djSaveNote(\'' + date + '\')">Save note</button>'
        + '<button class="jr-nav dj-btn" onclick="djAddShot(\'' + date + '\')">📷 Add chart</button>'
        + '<span id="dj-saved-' + date + '" class="dj-saved">' + (note.savedAt ? 'Saved ' + fmtDMY(note.savedAt.slice(0, 10)) : '') + '</span>'
      + '</div>';
    if (shots.length) {
      h += '<div class="dj-shots">' + shots.map(f =>
        '<button class="dj-shot" onclick="djViewShot(\'' + f + '\')" title="' + f + '">🖼 ' + f.split('__')[1] + '</button>').join('') + '</div>';
    }
    h += '</div></div>';
  }
  return h + '</div>';
}
