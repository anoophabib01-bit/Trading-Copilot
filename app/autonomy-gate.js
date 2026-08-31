'use strict';
// ── Autonomy gate — the "GIVE CONTROL" toggle (2026-08-26) ─────────────────
// Anoop: "i am okay if you want to take control and take trades. there should
// be a toggle that says give control so that i know you are incharge on the
// trades. you should enter and exit with profits."
//
// This is that toggle. It is a real switch with real state, and it is
// deliberately not a boolean.
//
// ── WHY IT IS NOT JUST A BOOLEAN ───────────────────────────────────────────
// A plain on/off would let control be handed to a strategy with no
// demonstrated edge. As of 2026-08-26 that is precisely the situation: the
// first real backtest of all three playbooks over live MNQ bars returned
// NEGATIVE expectancy on every one of them, on samples of 1 to 4 tradeable
// trades, with the profitability sign flipping across 40-47% of a 60-cell
// parameter sweep. Automating that does not produce profits faster; it
// produces losses faster, with commission on top, and without the one thing
// that has actually been protecting the account so far — a human hesitating.
//
// "You should enter and exit with profits" is the goal, and no honest system
// can promise it. What a system CAN do is refuse to act until the evidence
// that it works exists, and then act without hesitation once it does. That is
// what this gate encodes. The toggle is armed by Anoop; whether it can
// actually FIRE is decided by measured performance.
//
// ── THE FOUR STATES ────────────────────────────────────────────────────────
//   OFF        — Anoop trades. The app advises. (default, and today's reality)
//   SHADOW     — the app records the exact order it WOULD have sent, and the
//                outcome is scored against what actually happened. Nothing is
//                submitted to the broker. This is how the evidence gets built,
//                and it is the state the toggle should live in for now.
//   ASSIST     — the app decides and shows a ticket; ANOOP APPROVES EACH ONE;
//                the app then places it. Real orders, human in the loop per
//                trade. Added 2026-08-29 (AUTONOMY_MODES_SPEC.md).
//   LIVE       — the app may place real orders unattended. Requires BOTH
//                Anoop's switch AND the evidence bar below.
//
// ── WHY ASSIST EXISTS ──────────────────────────────────────────────────────
// SHADOW places nothing; LIVE places everything with nobody watching. Between
// them sat a cliff, and everything worth knowing before trusting an unattended
// system lives on the far side of it: whether the entries actually fill,
// whether the stop lands where the plan said, whether slippage and commission
// eat the whole edge. A shadow record cannot answer any of those — it was
// never submitted to anything. ASSIST answers them at a damage ceiling of one
// trade that Anoop personally looked at.
//
// It also produces a signal neither neighbour can: every ticket he REFUSES is
// a labelled example of the machine wanting a trade his judgement rejected,
// with the outcome observable afterwards. SHADOW never shows him the ticket;
// LIVE never asks.
//
// ASSIST is deliberately NOT gated on the evidence bar. Its whole purpose is
// to be the place where evidence about real execution starts existing, and
// requiring that evidence up front would make it unreachable for the same
// circular reason that would have made LIVE unreachable without SHADOW. What
// bounds ASSIST is not a track record but the human in the loop.
//
// SHADOW is the important one. It makes "give control" a decision backed by
// a track record instead of a leap, and it costs nothing to run. Every day it
// runs, the sample that LIVE requires gets bigger.
//
// ── WHY THE BAR IS WHERE IT IS ─────────────────────────────────────────────
// The thresholds are deliberately conservative and are NOT tuned to be
// reachable. This account has blown six times (Prop Trading/CLAUDE.md), every
// one on max loss limit, and the documented pattern is that accounts were UP
// before they crashed. An autonomous system inherits that risk with a faster
// clock. The bar is set where a reasonable person would hand over money, not
// where the current data happens to sit.
//
// PURE. Decides; does not act. server.js owns the actual order path
// (handleTradeConfirm remains the only code that can place an order) and the
// persistence of the toggle.

// Minimums before LIVE is permitted. Every one must pass.
const LIVE_REQUIREMENTS = {
  minResolvedTrades: 40,     // per playbook — below this a win rate is noise
  minProfitFactor: 1.3,      // after commission and slippage
  minShadowDays: 20,         // consecutive days in SHADOW with the gate healthy
  maxDrawdownPctOfLimit: 0.4, // observed DD must stay under 40% of the account's own limit
  requireHumanConfirm: true, // Anoop must flip it himself; no code may self-promote
};

// Kept in lockstep with autonomy-modes.js MODES — required so a mode that
// exists in one file cannot be silently unknown (and therefore read as 'off')
// in the other. Imported rather than re-declared for exactly that reason.
const { MODES } = require('./autonomy-modes');

// The only identities that count as a human arming LIVE. Deliberately an
// allow-list rather than a deny-list: a new automated caller must be added
// here on purpose to gain the privilege, instead of inheriting it by
// happening not to match a blocked pattern.
const HUMAN_ARMERS = new Set(['anoop']);

function isHumanArmer(armedBy) {
  return HUMAN_ARMERS.has(String(armedBy || '').trim().toLowerCase());
}

function normaliseMode(mode) {
  const m = String(mode || 'off').toLowerCase();
  return MODES.includes(m) ? m : 'off';
}

/**
 * Can the gate operate in the mode requested?
 *
 * @param {object} state     { mode, armedBy, armedAt, shadowDays }
 * @param {object} evidence  { playbook, resolvedTrades, profitFactor,
 *                             maxDrawdownUsd, accountDrawdownLimitUsd }
 * @returns {object} { allowed, effectiveMode, blockers[], summary }
 */
function evaluate(state, evidence, opts) {
  const st = state || {};
  const ev = evidence || {};
  const req = Object.assign({}, LIVE_REQUIREMENTS, (opts && opts.requirements) || {});
  const requested = normaliseMode(st.mode);
  const blockers = [];

  if (requested === 'off') {
    return { allowed: true, effectiveMode: 'off', blockers: [], summary: 'Manual trading. The app advises only.' };
  }

  // SHADOW is always permitted — it cannot lose money, and refusing it would
  // block the only route to ever earning LIVE.
  if (requested === 'shadow') {
    return {
      allowed: true, effectiveMode: 'shadow', blockers: [],
      summary: 'SHADOW: every order the app would have sent is recorded and scored. Nothing reaches the broker.',
    };
  }

  // ── ASSIST — real orders, but only ones Anoop personally approves ────────
  // Gated on the HUMAN, not on the evidence bar. Requiring a track record here
  // would be circular: ASSIST is where the record of real execution starts
  // existing, so demanding it up front makes the rung permanently unreachable
  // — the same trap SHADOW would have fallen into if LIVE's bar applied to it.
  //
  // What bounds the risk instead is that nothing is submitted without a click,
  // and the mode's own per-trade risk cap (autonomy-modes.js) still applies to
  // every ticket. The armer check stays: an automated caller must not be able
  // to put the app into a state where it can place orders at all.
  if (requested === 'assist') {
    if (!isHumanArmer(st.armedBy)) {
      return {
        allowed: false, effectiveMode: 'shadow',
        blockers: [st.armedBy
          ? `armed by "${st.armedBy}", which is not a human identity — Anoop must flip this himself`
          : 'no human confirmation recorded — Anoop must flip this himself'],
        summary: 'ASSIST refused (not armed by a human) — running in SHADOW instead.',
      };
    }
    return {
      allowed: true, effectiveMode: 'assist', blockers: [],
      summary: 'ASSIST: the app proposes a ticket for every setup. Nothing is placed until you approve it.',
    };
  }

  // ── LIVE — every requirement is checked and every failure is named ───────
  // Named individually rather than collapsed to "not eligible" so the answer
  // to "what would it take?" is always on screen. A gate that only says no is
  // a gate that gets ripped out.
  // ── Only a HUMAN may arm LIVE ────────────────────────────────────────────
  // A truthy `armedBy` is not enough. This was caught during the very first
  // end-to-end test of the toggle on 2026-08-26: a scripted WebSocket message
  // set armedBy to a session id, which passed a plain truthiness check and
  // would have satisfied the human-confirmation requirement on behalf of a
  // human who never touched anything. The whole purpose of this field is that
  // a person decided; an automated path proving it decided is worthless.
  //
  // So the value must match a known human identity. Anything else — a session
  // id, a hostname, a service account, an empty string — is not confirmation.
  if (!isHumanArmer(st.armedBy)) {
    blockers.push(st.armedBy
      ? `armed by "${st.armedBy}", which is not a human identity — Anoop must flip this himself`
      : 'no human confirmation recorded — Anoop must flip this himself');
  }
  const n = Number(ev.resolvedTrades);
  if (!Number.isFinite(n) || n < req.minResolvedTrades) {
    blockers.push(`needs ${req.minResolvedTrades} resolved trades for ${ev.playbook || 'this playbook'}, has ${Number.isFinite(n) ? n : 0}`);
  }
  const pf = Number(ev.profitFactor);
  if (!Number.isFinite(pf) || pf < req.minProfitFactor) {
    blockers.push(`needs profit factor >= ${req.minProfitFactor} after costs, has ${Number.isFinite(pf) ? pf.toFixed(2) : 'none measured'}`);
  }
  const sd = Number(st.shadowDays);
  if (!Number.isFinite(sd) || sd < req.minShadowDays) {
    blockers.push(`needs ${req.minShadowDays} days in SHADOW first, has ${Number.isFinite(sd) ? sd : 0}`);
  }
  const dd = Number(ev.maxDrawdownUsd);
  const ddLimit = Number(ev.accountDrawdownLimitUsd);
  if (Number.isFinite(dd) && Number.isFinite(ddLimit) && ddLimit > 0) {
    if (dd > ddLimit * req.maxDrawdownPctOfLimit) {
      blockers.push(`observed drawdown $${dd.toFixed(0)} exceeds ${Math.round(req.maxDrawdownPctOfLimit * 100)}% of the $${ddLimit.toFixed(0)} account limit`);
    }
  } else {
    blockers.push('account drawdown limit not configured — cannot verify the risk ceiling');
  }

  if (blockers.length) {
    // FAILS CLOSED, and specifically fails closed to SHADOW rather than OFF:
    // the request to hand over control is honoured as far as it safely can
    // be, and the shadow record is what eventually clears the blockers.
    return {
      allowed: false, effectiveMode: 'shadow', blockers,
      summary: `LIVE refused (${blockers.length} unmet requirement${blockers.length > 1 ? 's' : ''}) — running in SHADOW instead so the evidence keeps building.`,
    };
  }

  return {
    allowed: true, effectiveMode: 'live', blockers: [],
    summary: `LIVE: the app may place orders for ${ev.playbook}. Armed by ${st.armedBy} at ${st.armedAt || 'unknown time'}.`,
  };
}

// One-line status for the UI badge. The whole point of the toggle is that
// Anoop can tell at a glance who is in charge, so this must never be ambiguous.
function badge(result) {
  const r = result || {};
  switch (r.effectiveMode) {
    case 'live':   return { text: 'CLAUDE IS TRADING', tone: 'live' };
    // Says "you approve" rather than naming the app, because the one thing
    // that must never be ambiguous in ASSIST is whose click places the order.
    case 'assist': return { text: 'ASSIST — you approve every trade', tone: 'assist' };
    case 'shadow': return { text: 'SHADOW — recording, not trading', tone: 'shadow' };
    default:       return { text: 'YOU ARE TRADING', tone: 'off' };
  }
}

module.exports = { evaluate, badge, normaliseMode, isHumanArmer, MODES, HUMAN_ARMERS, LIVE_REQUIREMENTS };
