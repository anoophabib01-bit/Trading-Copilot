'use strict';
// ── Signal ledger (LIVE_FEED_LOOP_PLAN.md task 2.1) ─────────────────────────
// Server-side, at broadcast time: every watcher fire AND every Playbook C
// rejection appends one JSON line to DATA_DIR/signals/<YYYY-MM-DD>.jsonl with
// the market context captured AT FIRE TIME (trend/news/mode/account) — it
// cannot be reconstructed later. Rejections are data, not noise: the Playbook
// C filter rate per timeframe is only measurable if rejections are written.
//
// This module is pure row construction + serialization; the fs wiring and
// context gathering live in server.js (ledgerSignal). JSONL so a partial
// write costs one line, not the day.

// Session tier from IST wall-clock minutes, using the same windows as
// currentSessionStartUnix (rules.sessionWindowsIST: {name, startMin}).
// Windows are sorted descending by startMin so an overlap resolves to the
// LATER-opening session (NY) rather than the earlier one (London).
function sessionTierForMinutes(istMinutes, windows) {
  const wins = Array.isArray(windows) ? windows : [];
  const sorted = wins.slice().sort((a, b) => (b.startMin || 0) - (a.startMin || 0));
  for (const w of sorted) {
    if (istMinutes >= w.startMin) return w.name || 'session';
  }
  return 'outside-session';
}

// Build a ledger row from a fire-site's fields + the server's context.
// Unknown/missing fields become null — the ledger must never invent.
function buildSignalRow(fields, ctx) {
  const f = fields || {};
  const c = ctx || {};
  return {
    ts: f.ts || new Date().toISOString(),
    event: f.event || 'signal',
    playbook: f.playbook || null,
    tf: f.tf || null,
    direction: f.direction || null,
    level: f.level != null ? f.level : null,
    // ── entry / stop / setupId — ADDED 2026-08-26 ───────────────────────────
    // Without these the ledger recorded that something FIRED but never what
    // the trade was, and signal-outcome.js anchors its MFE/MAE on a price.
    // The consequence was total and silent: across 2026-08-24 and 08-25, 16
    // of 17 armed signals carried level:null, so resolveSignalOutcome()
    // returned 'signal lacks direction, level or timestamp' for every one and
    // DATA/signals/*.outcomes.jsonl was never created. The entire measurement
    // apparatus — the thing that answers "do my playbooks work" — had been
    // running and producing nothing.
    //
    // `entry` is deliberately separate from `level`. The one signal that DID
    // carry a level (playbook-b-confirm) set it to the SWEPT LEVEL, which is
    // the stop reference, not the entry: measuring excursion from there would
    // have scored the trade from beyond its own stop. entry is where the
    // trade goes on, stop is where it comes off, level keeps its original
    // meaning so nothing that already reads it changes behaviour.
    entry: f.entry != null ? f.entry : null,
    stop: f.stop != null ? f.stop : null,
    // Stable per-setup identity so one gap is one signal. See playbook-spec.js
    // setupId() for the wall-clock-bucket re-fire bug this replaces.
    setupId: f.setupId || null,
    gapLow: f.gapLow != null ? f.gapLow : null,
    gapHigh: f.gapHigh != null ? f.gapHigh : null,
    source: f.source || null,
    valid: f.valid !== false,
    rejectReason: f.rejectReason || null,
    structure: f.structure || null,
    sessionTier: c.sessionTier || null,
    dailyTrend: c.dailyTrend || null,
    hourTrend: c.hourTrend || null,
    newsBlackout: !!c.newsBlackout,
    symbol: c.symbol || null,
    accountSlot: c.accountSlot || null,
    mode: c.mode || null,
    hourEdge: c.hourEdge != null ? c.hourEdge : null, // 6.2 reporting-only
    // Sample size behind hourEdge. A win% with no n beside it is not a fact,
    // it is an anecdote — see hour-edge.js MIN_SAMPLE (2026-08-31 audit).
    hourEdgeN: c.hourEdgeN != null ? c.hourEdgeN : null,
    decision: f.decision || null,
    decidedAt: f.decidedAt || null,
    signalTs: f.signalTs != null ? f.signalTs : null,
  };
}

function serializeSignal(row) {
  return JSON.stringify(row) + '\n';
}

module.exports = { buildSignalRow, serializeSignal, sessionTierForMinutes };
