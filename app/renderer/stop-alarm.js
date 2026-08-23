// ── Escalating guardrail-stop alarm — pure timing logic (2026-08-16) ───────
// Anoop, after finding grAckStop() only requires typing 8 characters with no
// verification, and grResetDay() clears the whole stop with one confirm()
// click: "build the escalating alarm version of the stop." Two independent
// pieces of logic, both correctness-critical enough to test on their own —
// get either wrong and this either fails to interrupt a tilt-state (alarm
// too quiet/short) or traps him behind a stop he can't clear (delay too
// long) — the second of which this app's whole philosophy (checklist gate,
// journey guards, this stop itself) has always deliberately avoided.
//
// Deliberately NOT infinite and NOT undismissable — see MAX_REPEATS and
// ACK_DELAY_MS below. An alarm that never stops on its own is a liability if
// he's stepped away from the desk with the account already flat; a stop that
// can never be cleared is worse than the account it's protecting.

// Phase 1 (reps 0-3): same 30s cadence as the existing TradingView-disconnect
// alarm, for consistency. Phase 2 (rep 4+): tightens to 15s — genuinely
// escalating, not just repeating. Caps at MAX_REPEATS so an unattended alarm
// eventually goes quiet rather than running forever.
const PHASE2_AT_REP = 4;
const PHASE1_DELAY_MS = 30000;
const PHASE2_DELAY_MS = 15000;
const MAX_REPEATS = 30; // ~2min phase 1 + ~6.5min phase 2 ≈ 8.5 minutes total

function nextAlarmDelayMs(repeats) {
  return repeats < PHASE2_AT_REP ? PHASE1_DELAY_MS : PHASE2_DELAY_MS;
}

function alarmPhase(repeats) {
  return repeats < PHASE2_AT_REP ? 1 : 2;
}

function shouldContinueAlarm(repeats) {
  return typeof repeats === 'number' && isFinite(repeats) && repeats < MAX_REPEATS;
}

// The mandatory pause before "I am done" is even clickable — long enough to
// interrupt a reflexive dismiss, short enough to never feel like a trap.
const ACK_DELAY_MS = 8000;

/**
 * @param {number} stoppedAtMs  timestamp the stop was triggered
 * @param {number} nowMs
 * @returns {number} milliseconds remaining before the ack control unlocks, 0 if already unlocked
 */
function ackDelayRemainingMs(stoppedAtMs, nowMs) {
  if (typeof stoppedAtMs !== 'number' || !isFinite(stoppedAtMs)) return 0; // no known trigger time → fail OPEN, never trap on bad data
  if (typeof nowMs !== 'number' || !isFinite(nowMs)) return 0;
  const remaining = ACK_DELAY_MS - (nowMs - stoppedAtMs);
  return remaining > 0 ? Math.ceil(remaining) : 0;
}

const CONST = { PHASE2_AT_REP, PHASE1_DELAY_MS, PHASE2_DELAY_MS, MAX_REPEATS, ACK_DELAY_MS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nextAlarmDelayMs, alarmPhase, shouldContinueAlarm, ackDelayRemainingMs, CONST };
}
if (typeof window !== 'undefined') {
  window.StopAlarm = { nextAlarmDelayMs, alarmPhase, shouldContinueAlarm, ackDelayRemainingMs, CONST };
}
