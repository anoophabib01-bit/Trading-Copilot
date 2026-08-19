// ── Account journeys: the single eval→funded lifecycle dataset (2026-08-16) ──
// Anoop, 2026-08-16, after finding the account_report.html trade data had been
// duplicated and the account_archives.json had cross-contaminated eval/funded
// data during earlier testing: "I want the data to be clearly segregated in
// one section, which is starting with evaluation and ending with funded
// breach, which has three components: new evaluation / evaluation breached or
// moved to funded / after moving to funded, either breached or taken payout.
// This should be the whole format, and this whole format should have a single
// dataset which can help me differentiate between both."
//
// WHY THE OLD MECHANISM COULD CROSS-CONTAMINATE
//
// account_archives.json (app.js buildArchiveRecord/persistArchiveRecord) wrote
// one independent record per breach/clear CLICK, sourced from whatever was in
// acctBucketCache[slot.id] (or the config fallback) at that exact moment — a
// snapshot with no link back to "which attempt is this," so if the in-memory
// cache for an unloaded slot was stale or wrong, the archive silently recorded
// the wrong account's data under the wrong label. Confirmed on 2026-08-16: an
// archive entry tagged slotId 's1' (a $50K EVAL slot) contained trade rows
// byte-identical to slot s3's real FUNDED-stage trades — an artifact of
// same-day canary/QA testing, not organic trading data, but exactly the "eval
// data moved to funded, funded moved to eval" symptom Anoop described.
//
// THE FIX: A JOURNEY IS ONE RECORD WITH A STATE MACHINE, NOT INDEPENDENT SNAPSHOTS
//
// One journey = one eval attempt, from open to its final outcome (and, if it
// clears, through the funded phase to ITS final outcome). eval and funded live
// as two clearly separate sub-objects on the SAME record, so there is no
// second file, no cache lookup, and no way for one phase's data to be filed
// under the other's label. Transitions are GUARDED (recordEvalBreach refuses
// to run on a journey whose eval phase isn't 'active') — so the exact failure
// mode above (double-archiving, archiving the wrong stage) is now a rejected
// call, not a silent bad write.
//
// STORAGE: one file, DATA/account_journeys.json, an array of journeys. This
// literally is "a single dataset" — not a folder, not per-slot files.
//
// journey shape:
//   {
//     id, slotId, size, createdAt,
//     eval:   { status: 'active'|'breached'|'cleared', startedAt, startBalance,
//               endedAt, finalBalance },
//     funded: null | { status: 'active'|'breached', startedAt, startBalance,
//                      endedAt, finalBalance, payouts: [{date, amount}] }
//   }
//
// funded stays 'active' across multiple payouts (Anoop: "multiple payouts can
// be achieved") — a payout does not close the journey, only a breach does.

const fs = require('fs');
const path = require('path');

function readJourneys(dataDir) {
  const fp = path.join(dataDir, 'account_journeys.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeJourneys(dataDir, journeys, atomicWriteImpl) {
  const fp = path.join(dataDir, 'account_journeys.json');
  const aw = atomicWriteImpl || require('./atomic-write');
  fs.mkdirSync(dataDir, { recursive: true });
  aw.writeAtomic(fp, JSON.stringify(journeys, null, 2), 'utf8');
}

function nextId(journeys) {
  let max = 0;
  journeys.forEach(function (j) {
    const m = /^j(\d+)$/.exec(j && j.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'j' + (max + 1);
}

function phaseOf(journey) {
  if (!journey) return null;
  if (journey.funded) return journey.funded.status === 'breached' ? 'FUNDED_BREACHED' : 'FUNDED';
  if (journey.eval.status === 'breached') return 'EVAL_BREACHED';
  if (journey.eval.status === 'cleared') return 'EVAL_CLEARED'; // transient: cleared but funded not opened yet
  return 'EVAL';
}

function isTerminal(journey) {
  const p = phaseOf(journey);
  return p === 'EVAL_BREACHED' || p === 'FUNDED_BREACHED';
}

/** Start a brand-new eval journey. Always creates a new record — callers are
 *  expected to gate "is this genuinely a new attempt" themselves (e.g. only
 *  call this when a slot has no data yet), matching how a real prop firm eval
 *  purchase is always a distinct attempt. */
function startEvalJourney(dataDir, opts) {
  opts = opts || {};
  const journeys = readJourneys(dataDir);
  const now = opts.now || new Date().toISOString();
  const journey = {
    id: nextId(journeys),
    slotId: opts.slotId || null,
    size: opts.size || null,
    createdAt: now,
    eval: { status: 'active', startedAt: now, startBalance: opts.startBalance != null ? opts.startBalance : null, endedAt: null, finalBalance: null },
    funded: null
  };
  journeys.push(journey);
  writeJourneys(dataDir, journeys, opts.atomicWrite);
  return journey;
}

function findJourney(journeys, id) {
  return journeys.filter(function (j) { return j && j.id === id; })[0] || null;
}

/** The journey this slot should transition, if any: the most recently created
 *  non-terminal journey for that slotId. Lets callers (WS handlers) address a
 *  transition by slotId — what the existing breach/clear UI already knows —
 *  without the renderer having to track journey ids itself. */
function activeJourneyForSlot(dataDir, slotId) {
  const journeys = readJourneys(dataDir);
  const candidates = journeys.filter(function (j) { return j && j.slotId === slotId && !isTerminal(j); });
  return candidates.length ? candidates[candidates.length - 1] : null;
}

function mutate(dataDir, id, fn, atomicWriteImpl) {
  const journeys = readJourneys(dataDir);
  const journey = findJourney(journeys, id);
  if (!journey) return { ok: false, reason: 'no-such-journey' };
  const result = fn(journey);
  if (result && result.rejected) return { ok: false, reason: result.reason };
  writeJourneys(dataDir, journeys, atomicWriteImpl);
  return { ok: true, journey: journey };
}

function recordEvalBreach(dataDir, id, opts) {
  opts = opts || {};
  return mutate(dataDir, id, function (j) {
    if (j.eval.status !== 'active') return { rejected: true, reason: 'eval-not-active' };
    j.eval.status = 'breached';
    j.eval.endedAt = opts.now || new Date().toISOString();
    j.eval.finalBalance = opts.finalBalance != null ? opts.finalBalance : null;
    return { rejected: false };
  }, opts.atomicWrite);
}

function recordEvalCleared(dataDir, id, opts) {
  opts = opts || {};
  return mutate(dataDir, id, function (j) {
    if (j.eval.status !== 'active') return { rejected: true, reason: 'eval-not-active' };
    const now = opts.now || new Date().toISOString();
    j.eval.status = 'cleared';
    j.eval.endedAt = now;
    j.eval.finalBalance = opts.finalBalance != null ? opts.finalBalance : null;
    j.funded = { status: 'active', startedAt: now, startBalance: opts.fundedStartBalance != null ? opts.fundedStartBalance : null, endedAt: null, finalBalance: null, payouts: [] };
    return { rejected: false };
  }, opts.atomicWrite);
}

function recordFundedBreach(dataDir, id, opts) {
  opts = opts || {};
  return mutate(dataDir, id, function (j) {
    if (!j.funded || j.funded.status !== 'active') return { rejected: true, reason: 'funded-not-active' };
    j.funded.status = 'breached';
    j.funded.endedAt = opts.now || new Date().toISOString();
    j.funded.finalBalance = opts.finalBalance != null ? opts.finalBalance : null;
    return { rejected: false };
  }, opts.atomicWrite);
}

/** A payout does NOT close the journey — funded stays 'active' so the same
 *  journey can record multiple payouts over time. */
function recordFundedPayout(dataDir, id, opts) {
  opts = opts || {};
  return mutate(dataDir, id, function (j) {
    if (!j.funded || j.funded.status !== 'active') return { rejected: true, reason: 'funded-not-active' };
    const amount = Number(opts.amount);
    if (!isFinite(amount) || amount <= 0) return { rejected: true, reason: 'invalid-amount' };
    j.funded.payouts.push({ date: opts.date || (opts.now || new Date().toISOString()).slice(0, 10), amount: amount });
    return { rejected: false };
  }, opts.atomicWrite);
}

function summarize(journey) {
  if (!journey) return null;
  const phase = phaseOf(journey);
  const payoutTotal = journey.funded ? journey.funded.payouts.reduce(function (s, p) { return s + (p.amount || 0); }, 0) : 0;
  return {
    id: journey.id, slotId: journey.slotId, size: journey.size, phase: phase,
    evalDays: null, // left for a caller with day-count data; not derivable here
    payoutCount: journey.funded ? journey.funded.payouts.length : 0,
    payoutTotal: payoutTotal
  };
}

module.exports = {
  readJourneys, writeJourneys,
  startEvalJourney, activeJourneyForSlot, findJourney,
  recordEvalBreach, recordEvalCleared, recordFundedBreach, recordFundedPayout,
  phaseOf, isTerminal, summarize
};
