'use strict';
// ── Phase 2b: trade-confirm dedup/idempotency (2026-08-17) ──────────────────
// Extracted from server.js's handleTradeConfirm so the double-submit guard —
// the Eng review's top-flagged bug ("the single most likely real-money bug
// in the whole spec") — is unit-testable in isolation, not just inline logic
// nobody can exercise without a live WS connection.
//
// checkAndMark() must be called SYNCHRONOUSLY by the caller, before any
// `await` — its whole safety property depends on there being no interleaving
// window between checking whether a requestId/verdict was already seen and
// marking it seen. This module doesn't enforce that itself (it can't — it's
// just data), so the caller (server.js) is responsible for not awaiting
// between reading a message and calling this.

/** @returns {{seen: Map<string, number>, consumedVerdicts: Set<string>}} */
function createDedupState() {
  return { seen: new Map(), consumedVerdicts: new Set() };
}

function cleanup(state, nowMs, windowMs) {
  const cutoff = nowMs - windowMs;
  for (const [id, ts] of state.seen) {
    if (ts < cutoff) state.seen.delete(id);
  }
}

/**
 * Checks whether a trade-confirm request is a duplicate (same requestId
 * seen before, within the window) or reuses an already-consumed verdict,
 * and — if it's genuinely new — marks it seen immediately, in the same call.
 *
 * @param {object} state          from createDedupState() — mutated in place
 * @param {string} requestId      client-generated, unique per Confirm click
 * @param {string|null} sourceVerdictId  the Judge verdict this ticket came from, or null
 * @param {number} nowMs
 * @param {number} windowMs       how long a requestId is remembered
 * @returns {{ok:boolean, reason:string|null}}
 */
function checkAndMark(state, requestId, sourceVerdictId, nowMs, windowMs) {
  if (!requestId || typeof requestId !== 'string') {
    return { ok: false, reason: 'missing requestId' };
  }
  cleanup(state, nowMs, windowMs);
  if (state.seen.has(requestId)) {
    return { ok: false, reason: 'duplicate request — already processed' };
  }
  if (sourceVerdictId && state.consumedVerdicts.has(sourceVerdictId)) {
    return { ok: false, reason: 'this trade ticket has already been confirmed once' };
  }
  state.seen.set(requestId, nowMs);
  return { ok: true, reason: null };
}

/** Call once a request has actually gone on to place an order, so the same verdict can never fire twice. */
function consumeVerdict(state, sourceVerdictId) {
  if (sourceVerdictId) state.consumedVerdicts.add(sourceVerdictId);
}

module.exports = { createDedupState, checkAndMark, consumeVerdict };
