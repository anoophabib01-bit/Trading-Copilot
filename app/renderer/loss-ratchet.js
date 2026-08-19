'use strict';
/**
 * loss-ratchet.js — "tomorrow's max loss can never exceed what I made today"
 *
 * Anoop's own rule, 2026-08-12. It targets the failure mode he named himself:
 *   "after a couple of profit days, there is one last day which eats all my
 *    profits, and it is over. Then again, I start with a new evaluation."
 *
 * THE CORRECTION THAT MATTERS
 * As first described — "max loss tomorrow = yesterday's profit" — the rule has
 * a hole that points the wrong way. An $800 green day would set tomorrow's cap
 * at $800, which is FOUR TIMES the $200 funded rule. It would loosen risk
 * precisely after the good days that historically precede a blow-up.
 *
 * So the cap is min(normal dayStop, yesterday's profit). It can only ever
 * TIGHTEN, never loosen. That is what makes it a ratchet rather than a
 * negotiation.
 *
 * Pure function of its inputs — unit-tested in test/loss-ratchet.test.js.
 */

/**
 * @param {number} yesterdayPnl   yesterday's realised P&L (negative = loss)
 * @param {number} baseDayStop    the normal daily stop as a POSITIVE number
 * @param {object} cfg            rules.json → lossRatchet
 * @returns {{cap:number, capNegative:number, source:string, reason:string, tightened:boolean}}
 */
function computeCap(yesterdayPnl, baseDayStop, cfg = {}) {
  const base = Math.abs(Number(baseDayStop) || 0);
  const enabled = cfg.enabled !== false;
  const floor = Math.abs(Number(cfg.floor) || 0);
  const mode = cfg.mode || 'min';

  const noRatchet = (reason) => ({
    cap: base, capNegative: -base, source: 'dayStop', reason, tightened: false
  });

  if (!enabled) return noRatchet('Loss ratchet disabled in rules.json.');
  if (!(Number(yesterdayPnl) > 0)) {
    // A red or flat yesterday leaves the normal stop in force. Deliberately NOT
    // zero or negative: if a losing day made the next day untradeable, the rule
    // would trap him out entirely and he would simply switch it off.
    return noRatchet('Yesterday was not green, so the normal daily stop applies.');
  }

  const profit = Number(yesterdayPnl);
  // 'raw' honours the literal original phrasing. It is documented but should
  // not be used — see rules.json's _lossRatchet_comment.
  let cap = mode === 'raw' ? profit : Math.min(base, profit);
  if (floor > 0 && cap < floor) cap = floor;

  const tightened = cap < base;
  return {
    cap,
    capNegative: -cap,
    source: tightened ? 'ratchet' : 'dayStop',
    reason: tightened
      ? `Yesterday you made $${profit}. Today you may not lose more than $${cap}.`
      : `Yesterday's $${profit} is above your normal $${base} stop, so the normal stop still governs.`,
    tightened
  };
}

/**
 * Current status against the cap, for the HUD and the warning banner.
 *
 * Three states rather than two, on purpose. A single hard stop gives no notice;
 * the caution tier exists so there is a moment to stand down BEFORE the decision
 * is made for him — which on 2026-08-10 is precisely the window where the 9-lot
 * went on.
 *
 * @param {number} todayPnl   today's running P&L (negative = loss)
 */
function statusFor(todayPnl, capInfo, cfg = {}) {
  const cap = capInfo.cap;
  const lost = todayPnl < 0 ? Math.abs(todayPnl) : 0;
  const warnPct = Number(cfg.warnAtPct) || 50;
  const warnAt = cap * (warnPct / 100);
  const remaining = Math.max(0, +(cap - lost).toFixed(2));
  const pctUsed = cap > 0 ? Math.round((lost / cap) * 100) : 0;

  if (lost >= cap) {
    return {
      level: 'stop', cap, lost, remaining: 0, pctUsed,
      text: capInfo.tightened
        ? `STOP — you have lost $${lost.toFixed(2)}, which is all of yesterday's $${cap} profit. Yesterday's work is now undone. Close the platform.`
        : `STOP — $${lost.toFixed(2)} hit your $${cap} daily limit. Close the platform.`
    };
  }
  if (lost >= warnAt && lost > 0) {
    return {
      level: 'warn', cap, lost, remaining, pctUsed,
      text: capInfo.tightened
        ? `CAUTION — $${lost.toFixed(2)} down, ${pctUsed}% of yesterday's $${cap} profit given back. $${remaining} left before you have erased the day you worked for.`
        : `CAUTION — $${lost.toFixed(2)} down, ${pctUsed}% of your $${cap} stop. $${remaining} left.`
    };
  }
  return {
    level: 'ok', cap, lost, remaining, pctUsed,
    text: capInfo.tightened
      ? `Today's cap is $${cap} (yesterday's profit). $${remaining} of room left.`
      : `Today's cap is $${cap}. $${remaining} of room left.`
  };
}

// Dual-mode export. This file is loaded BOTH by Node (server-side agents,
// unit tests) and directly by the browser via a <script> tag — the renderer has
// no module system. Keeping one file rather than two copies means the rule that
// stops him trading can never drift between where it is tested and where it
// actually runs.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeCap, statusFor };
}
if (typeof window !== 'undefined') {
  window.LossRatchet = { computeCap, statusFor };
}
