'use strict';
// ── Autonomy store — all CONTROL-toggle data, one folder PER MODE ──────────
// Anoop, 2026-08-26: "create a new folder and work under it to save all the
// data you need after turning on the toggle so that there is no confusion."
// Anoop, 2026-08-29: "each mode should have separate folder to avoid confusion
// and if currently not made make new folder and store everything accordingly."
//
// That folder is DATA/autonomy/ and this module is the ONLY thing that writes
// to it. See its README.md for the file-by-file map.
//
// ── THE LAYOUT ─────────────────────────────────────────────────────────────
//   DATA/autonomy/
//     state.json            which mode is active, who armed it, when
//     decisions.jsonl       every mode request, granted or refused
//     shadow/               orders.jsonl outcomes.jsonl daily/
//     assist/               orders.jsonl outcomes.jsonl daily/ approvals.jsonl
//     control/              orders.jsonl outcomes.jsonl daily/ interventions.jsonl
//     human/                trades.jsonl
//
// ── WHY ONE FOLDER PER MODE, AND NOT ONE FILE WITH A `mode` COLUMN ─────────
// Because the folders are what make a promotion decision honest.
//
// Each mode produces a track record, and the next rung up is granted on it.
// But a record only describes the system that produced it: SHADOW's profit
// factor at 2 contracts with SIMULATED fills says nothing about CONTROL at 2
// contracts with REAL slippage, a different exit rule and a tighter risk cap.
// If all three streams share a file, computing "the track record" means
// remembering to filter — and the day someone forgets, a good shadow number
// promotes a system that has never existed. Separate folders make that
// mistake impossible to make by accident rather than merely discouraged.
//
// The rule this layout enforces: evidence transfers between modes only when
// the (playbook, size, exitPolicy) tuple is identical. See
// AUTONOMY_MODES_SPEC.md §4.
//
// ── WHY `human/` IS NOT A MODE FOLDER ──────────────────────────────────────
// Anoop's own trades are his trades no matter which mode happens to be
// running. Filing them under the active mode would mean the same behaviour
// lands in three different folders depending on a toggle he flipped for
// unrelated reasons, and the one comparison worth making — his discretion
// versus the machine on the same market — would need a union of all of them.
// One stream, always.
//
// FAILURE-TOLERANT, in the same shape as ledgerSignal(): a disk problem must
// never break the live path. Every write is wrapped; a failure logs and
// returns false rather than throwing into a trading loop.

const fs = require('fs');
const path = require('path');

// Mode ids that own a folder. 'live' is the mode id; its folder is named
// 'control' to match the UI and rules.json — the same two-vocabulary mapping
// autonomy-modes.CONFIG_KEY owns. Kept as a local map so this module has no
// require-time dependency on that one.
const MODE_FOLDER = { shadow: 'shadow', assist: 'assist', live: 'control' };
const HUMAN_FOLDER = 'human';

function autonomyDir(dataDir) {
  return path.join(dataDir, 'autonomy');
}

function ensureDir(dataDir) {
  const dir = autonomyDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Folder for one mode. Anything not a known executing/recording mode falls
// back to 'shadow' rather than throwing: the alternative is a live recording
// path that can crash on an unexpected mode string, and losing one row to a
// mislabelled folder is far cheaper than losing the write.
function modeFolder(mode) {
  return MODE_FOLDER[String(mode || '').toLowerCase()] || 'shadow';
}

function modeDir(dataDir, mode) {
  return path.join(autonomyDir(dataDir), modeFolder(mode));
}

function ensureModeDir(dataDir, mode) {
  const dir = modeDir(dataDir, mode);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── state.json — the toggle's memory across restarts ──────────────────────
// Kept HERE rather than in ~/.trading-copilot-config.json (where mode/tradingMode
// live) so the whole autonomy record travels together and can be inspected,
// archived or deleted as one unit. Never defaults to anything but 'off': a
// control switch that comes back on by itself after a crash is the last thing
// an account with six blow-ups behind it needs.
//
// Deliberately at the ROOT, not per mode: there is exactly one answer to "who
// is trading right now", and a per-mode copy could disagree with itself.
const DEFAULT_STATE = { mode: 'off', armedBy: null, armedAt: null, shadowDays: 0, lastShadowDay: null };

function readState(dataDir) {
  try {
    const f = path.join(autonomyDir(dataDir), 'state.json');
    if (!fs.existsSync(f)) return Object.assign({}, DEFAULT_STATE);
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Object.assign({}, DEFAULT_STATE, s || {});
  } catch (e) {
    // A corrupt state file must read as OFF, never as whatever it last was.
    console.warn('[autonomy-store] state unreadable, defaulting to OFF:', e.message);
    return Object.assign({}, DEFAULT_STATE);
  }
}

function writeState(dataDir, state) {
  try {
    const dir = ensureDir(dataDir);
    const merged = Object.assign({}, DEFAULT_STATE, state || {});
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(merged, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[autonomy-store] state write failed:', e.message);
    return false;
  }
}

// Count a day of SHADOW operation exactly once, keyed on the trading day
// stamp. Called on any day the gate ran in shadow; repeat calls the same day
// are no-ops. This is what LIVE's `minShadowDays` requirement counts, so it
// must never be inflatable by restarting the app.
function markShadowDay(dataDir, dayStamp) {
  const st = readState(dataDir);
  if (!dayStamp || st.lastShadowDay === dayStamp) return st;
  st.shadowDays = (Number(st.shadowDays) || 0) + 1;
  st.lastShadowDay = dayStamp;
  writeState(dataDir, st);
  return st;
}

// ── append-only records ───────────────────────────────────────────────────
function appendJsonl(dir, file, row) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, file), JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch (e) {
    console.error(`[autonomy-store] ${file} write failed:`, e.message);
    return false;
  }
}

function readJsonlAt(dir, file) {
  try {
    const f = path.join(dir, file);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

// Read a file from one mode's folder.
function readJsonl(dataDir, mode, file) {
  return readJsonlAt(modeDir(dataDir, mode), file);
}

// Read a file from the autonomy ROOT (state/decisions live there).
function readRootJsonl(dataDir, file) {
  return readJsonlAt(autonomyDir(dataDir), file);
}

// Every time the gate was asked to act — including, and especially, refusals.
// A gate that only records what it did would hide the far more interesting
// record of what it declined and why. Root-level: a mode request is ABOUT the
// modes, it does not belong to any one of them.
function recordDecision(dataDir, decision) {
  return appendJsonl(ensureDir(dataDir), 'decisions.jsonl', Object.assign({
    ts: new Date().toISOString(),
  }, decision || {}));
}

// An order a MODE would have placed (shadow) or did place (assist/control).
// `submitted` is explicit rather than implied by the folder, so a reader never
// has to know which directory they are in to know whether real money moved.
function recordOrder(dataDir, mode, order) {
  return appendJsonl(ensureModeDir(dataDir, mode), 'orders.jsonl', Object.assign({
    ts: new Date().toISOString(),
    submitted: false,
    mode: String(mode || 'shadow').toLowerCase(),
  }, order || {}));
}

// Resolution of a machine order, written to its OWN file.
//
// orders.jsonl is append-only and must stay the untouched record of what was
// PROPOSED, at the time it was proposed — the same separation
// signal-outcome.js keeps between the signal ledger and its outcomes. Editing
// a proposal in place to add its result would destroy the one property that
// makes the record trustworthy: that it was written before the outcome was
// knowable.
function recordOutcome(dataDir, mode, outcome) {
  return appendJsonl(ensureModeDir(dataDir, mode), 'outcomes.jsonl', Object.assign({
    ts: new Date().toISOString(),
  }, outcome || {}));
}

// A trade ANOOP took. One stream regardless of mode — see the header.
function recordHumanTrade(dataDir, trade) {
  return appendJsonl(path.join(autonomyDir(dataDir), HUMAN_FOLDER), 'trades.jsonl', Object.assign({
    ts: new Date().toISOString(),
    kind: 'human-trade',
  }, trade || {}));
}

function readHumanTrades(dataDir) {
  return readJsonlAt(path.join(autonomyDir(dataDir), HUMAN_FOLDER), 'trades.jsonl');
}

// A ticket ASSIST showed and Anoop approved or refused. Its own file because
// the REFUSALS are the point: "the machine wanted this, he said no, here is
// what price did next" is a signal neither SHADOW (never shows him the ticket)
// nor CONTROL (never asks) can produce.
function recordApproval(dataDir, approval) {
  return appendJsonl(ensureModeDir(dataDir, 'assist'), 'approvals.jsonl', Object.assign({
    ts: new Date().toISOString(),
  }, approval || {}));
}

// Something CONTROL did to the account without being asked — a reduction, a
// flatten, a breaker trip. Separate from orders.jsonl because an intervention
// is not a trade and must never be counted as one in a track record.
function recordIntervention(dataDir, intervention) {
  return appendJsonl(ensureModeDir(dataDir, 'live'), 'interventions.jsonl', Object.assign({
    ts: new Date().toISOString(),
  }, intervention || {}));
}

// Rows written before the human/machine split carry no `kind`. They were all
// machine orders, so they are treated as such rather than silently dropped —
// discarding history to simplify a filter is how a track record quietly
// shrinks.
function isMachineOrder(o) {
  return o.kind === 'machine-order' || o.kind == null;
}

// An order the risk rules would have refused. Recorded so the refusal rate is
// visible, but NEVER counted toward the track record a mode is promoted on — a
// profit factor built partly from trades the mode is forbidden to place is a
// number about a system that does not exist.
function isBlocked(o) {
  return !!(o && o.blocked);
}

// Machine orders in this mode that still have no resolution. What the resolver
// works on.
function pendingMachineOrders(dataDir, mode) {
  const done = new Set(readJsonl(dataDir, mode, 'outcomes.jsonl').map((o) => o && o.id).filter(Boolean));
  return readJsonl(dataDir, mode, 'orders.jsonl')
    .filter((o) => o && isMachineOrder(o) && !isBlocked(o) && o.id && !done.has(o.id));
}

// Orders joined to their resolutions, within ONE mode. One row per RESOLVED
// order.
//
// `opts.maxRiskUsd` filters to orders the reading mode would actually have been
// allowed to place. This is not cosmetic: SHADOW records under the global $300
// per-trade cap while CONTROL runs at $200, so reading shadow's record for a
// CONTROL promotion without the filter would grant it on a track record
// containing trades it is forbidden to take — the same class of error as
// counting `blocked` rows toward the profit factor.
// See AUTONOMY_MODES_SPEC.md §8.1.
function resolvedMachineOrders(dataDir, mode, playbook, contracts, opts) {
  const maxRiskUsd = Number((opts || {}).maxRiskUsd);
  const byId = new Map();
  for (const o of readJsonl(dataDir, mode, 'outcomes.jsonl')) if (o && o.id) byId.set(o.id, o);
  return readJsonl(dataDir, mode, 'orders.jsonl')
    .filter((o) => o && isMachineOrder(o) && !isBlocked(o))
    .filter((o) => !playbook || o.playbook === playbook)
    .filter((o) => contracts == null || o.contracts === contracts)
    // An order whose risk is UNKNOWN is excluded when a cap is being applied,
    // never assumed to fit. Unknown is not small.
    //
    // `typeof === 'number'` and not Number(o.riskUsd): Number(null) is 0, and
    // 0 passes every cap — so a row with no risk figure would count toward the
    // track record a mode gets promoted on, as if it were the safest trade in
    // the file. Same trap fixed in autonomy-modes.strictNumber().
    .filter((o) => !Number.isFinite(maxRiskUsd)
      || (typeof o.riskUsd === 'number' && Number.isFinite(o.riskUsd) && o.riskUsd <= maxRiskUsd))
    .map((o) => {
      // Backward compatible: an order that already carries its own result
      // (the pre-resolver shape) is still honoured.
      if (o.resolved && Number.isFinite(o.netUsd)) return o;
      const r = byId.get(o.id);
      return r ? Object.assign({}, o, { resolved: true, netUsd: r.netUsd, outcome: r.outcome, bars: r.bars }) : null;
    })
    .filter(Boolean);
}

// ── daily rollup — what the gate reads to decide about promotion ──────────
// Only orders that actually RESOLVED count. A pending order is not a scratch
// and must not dilute the profit factor toward 1.0, which is the same refusal
// signal-outcome.js makes on a partial horizon.
function rollupDay(dataDir, mode, dayStamp) {
  // Joined view: resolution lives in outcomes.jsonl, so reading `o.resolved`
  // off the order row alone would report every day as empty.
  const orders = resolvedMachineOrders(dataDir, mode).filter((o) => o && o.day === dayStamp);

  // ── PER SIZE, NEVER SUMMED ACROSS SIZES ──────────────────────────────────
  // The same signal is recorded once per configured size, so adding them
  // produces a number that describes no account that could exist. A first run
  // of this showed 10 real setups reported as +$9,095 — the 4c result ($3,638)
  // plus the 6c result ($5,457) — which reads as a day's P&L and is nothing of
  // the kind. Each size is its own hypothetical account and is totalled alone.
  const bySize = new Map();
  for (const o of orders) {
    const key = o.contracts != null ? o.contracts : 'unknown';
    if (!bySize.has(key)) bySize.set(key, { contracts: key, wins: 0, losses: 0, grossWin: 0, grossLoss: 0 });
    const b = bySize.get(key);
    const net = Number(o.netUsd);
    if (!Number.isFinite(net)) continue;
    if (net > 0) { b.wins++; b.grossWin += net; } else { b.losses++; b.grossLoss += Math.abs(net); }
  }

  const sizes = Array.from(bySize.values()).map((b) => ({
    contracts: b.contracts,
    resolved: b.wins + b.losses,
    wins: b.wins, losses: b.losses,
    netUsd: Math.round((b.grossWin - b.grossLoss) * 100) / 100,
    profitFactor: b.grossLoss > 0 ? Math.round((b.grossWin / b.grossLoss) * 100) / 100 : null,
  })).sort((a, b) => (a.contracts || 0) - (b.contracts || 0));

  const allProposed = readJsonl(dataDir, mode, 'orders.jsonl')
    .filter((o) => o && isMachineOrder(o) && o.day === dayStamp);
  const proposed = allProposed.filter((o) => !isBlocked(o));
  const blocked = allProposed.filter(isBlocked);
  // Distinct SETUPS, not rows — the honest count of how many times a playbook
  // actually fired, independent of how many sizes each fire was recorded at.
  const distinctSetups = new Set(proposed.map((o) => o.setupId || o.id)).size;

  const summary = {
    day: dayStamp,
    mode: String(mode || 'shadow').toLowerCase(),
    setupsFired: distinctSetups,
    ordersRecorded: proposed.length,
    // Surfaced, not buried: how often a detector proposed a setup the risk
    // rules forbid is a finding about the detector.
    blockedByRisk: blocked.length,
    // Per-size results. There is deliberately no top-level netUsd: any single
    // number here would have to pick a size or add them, and both mislead.
    sizes,
  };
  try {
    const dir = path.join(ensureModeDir(dataDir, mode), 'daily');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${dayStamp}.json`), JSON.stringify(summary, null, 2), 'utf8');
  } catch (e) { console.error('[autonomy-store] daily rollup write failed:', e.message); }
  return summary;
}

// Cumulative evidence across every day IN ONE MODE — the numbers
// autonomy-gate.js checks a promotion against.
function evidence(dataDir, mode, playbook, contracts, opts) {
  const orders = resolvedMachineOrders(dataDir, mode, playbook, contracts, opts);
  let grossWin = 0, grossLoss = 0, equity = 0, peak = 0, maxDD = 0;
  for (const o of orders) {
    const net = Number(o.netUsd);
    if (!Number.isFinite(net)) continue;
    if (net > 0) grossWin += net; else grossLoss += Math.abs(net);
    equity += net;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }
  return {
    mode: String(mode || 'shadow').toLowerCase(),
    playbook: playbook || null,
    contracts: contracts != null ? contracts : null,
    // Echoed back so a reader can tell an empty result caused by "no trades
    // yet" from one caused by "every trade was over this mode's cap".
    maxRiskUsd: Number.isFinite(Number((opts || {}).maxRiskUsd)) ? Number(opts.maxRiskUsd) : null,
    resolvedTrades: orders.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdownUsd: orders.length ? Math.round(maxDD * 100) / 100 : null,
    netUsd: Math.round(equity * 100) / 100,
  };
}

// ── ONE-TIME MIGRATION to the per-mode layout (2026-08-29) ────────────────
// The original layout put everything in two flat files at the autonomy root:
// shadow-orders.jsonl (BOTH machine orders and Anoop's own trades, told apart
// only by a `kind` field) and shadow-outcomes.jsonl.
//
// Runs at boot, IDEMPOTENT, and NON-DESTRUCTIVE: the legacy files are renamed
// to *.migrated-<stamp> rather than deleted, so a bad migration costs a rename
// to undo. Nothing here overwrites a destination that already has content — if
// the new layout is already populated the legacy files are left exactly where
// they are and the migration reports that it did nothing, because a second
// pass appending the same rows would silently double a track record.
function migrateLegacyLayout(dataDir, opts) {
  const stamp = (opts && opts.stamp) || 'migrated';
  const root = autonomyDir(dataDir);
  const result = { ran: false, machineOrders: 0, humanTrades: 0, outcomes: 0, dailyFiles: 0, notes: [] };
  try {
    if (!fs.existsSync(root)) return result;

    const legacyOrders = path.join(root, 'shadow-orders.jsonl');
    const legacyOutcomes = path.join(root, 'shadow-outcomes.jsonl');
    const legacyDaily = path.join(root, 'daily');
    const hasLegacy = fs.existsSync(legacyOrders) || fs.existsSync(legacyOutcomes) || fs.existsSync(legacyDaily);
    if (!hasLegacy) return result;

    // Refuse to merge into a populated destination — see the header.
    const destOrders = path.join(modeDir(dataDir, 'shadow'), 'orders.jsonl');
    const destHuman = path.join(root, HUMAN_FOLDER, 'trades.jsonl');
    if (fs.existsSync(destOrders) || fs.existsSync(destHuman)) {
      result.notes.push('new layout already populated — legacy files left untouched rather than appended twice');
      return result;
    }

    // orders: split by kind. A row with no kind is a machine order (see
    // isMachineOrder) and belongs to shadow, which is the only mode that has
    // ever run.
    for (const row of readJsonlAt(root, 'shadow-orders.jsonl')) {
      if (row && row.kind === 'human-trade') {
        recordHumanTrade(dataDir, row);
        result.humanTrades++;
      } else if (row) {
        recordOrder(dataDir, row.mode || 'shadow', row);
        result.machineOrders++;
      }
    }
    for (const row of readJsonlAt(root, 'shadow-outcomes.jsonl')) {
      recordOutcome(dataDir, row.mode || 'shadow', row);
      result.outcomes++;
    }

    // daily/ rollups belonged to shadow.
    if (fs.existsSync(legacyDaily)) {
      const destDaily = path.join(modeDir(dataDir, 'shadow'), 'daily');
      fs.mkdirSync(destDaily, { recursive: true });
      for (const f of fs.readdirSync(legacyDaily)) {
        try {
          fs.copyFileSync(path.join(legacyDaily, f), path.join(destDaily, f));
          result.dailyFiles++;
        } catch (e) { result.notes.push(`daily/${f}: ${e.message}`); }
      }
      try { fs.renameSync(legacyDaily, legacyDaily + '.' + stamp); } catch (e) { result.notes.push(e.message); }
    }

    for (const f of [legacyOrders, legacyOutcomes]) {
      if (fs.existsSync(f)) {
        try { fs.renameSync(f, f + '.' + stamp); } catch (e) { result.notes.push(e.message); }
      }
    }

    result.ran = true;
    return result;
  } catch (e) {
    result.notes.push('migration failed: ' + e.message);
    return result;
  }
}

module.exports = {
  autonomyDir, ensureDir, modeDir, ensureModeDir, modeFolder,
  MODE_FOLDER, HUMAN_FOLDER,
  readState, writeState, markShadowDay, DEFAULT_STATE,
  recordDecision, recordOrder, recordOutcome,
  recordHumanTrade, readHumanTrades, recordApproval, recordIntervention,
  readJsonl, readRootJsonl,
  pendingMachineOrders, resolvedMachineOrders, isBlocked, isMachineOrder,
  rollupDay, evidence,
  migrateLegacyLayout,
};
