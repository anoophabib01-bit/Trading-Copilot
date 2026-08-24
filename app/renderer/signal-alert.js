'use strict';
/**
 * signal-alert.js — decides whether a watcher detection deserves a chime.
 *
 * WHY THIS IS A SEPARATE, TESTED MODULE
 * -------------------------------------
 * The naive version of "beep when a watcher detects something" is to beep on
 * the watcher's event. That is wrong twice over, and both mistakes are audible
 * every 30 seconds during a live session:
 *
 *   1. `engulf-check` / `fvg-check` / `sfp-check` fire on EVERY POLL, carrying
 *      `found: false` almost always. They are heartbeats, not detections. Only
 *      `engulf-signal`, `fvg-signal`, `sfp-signal` and `po3-phase-change` mean
 *      something was actually found.
 *   2. The same signal re-fires on later polls while it stays valid. Observed
 *      live on 2026-08-24: the same 30M FVG (gap 29204–29205.75) fired at
 *      17:00:20 and again at 17:15:17. That is one setup, not two, and it must
 *      make one sound.
 *
 * So the decision is: is this a real detection, and is it NEW? Pure, so it can
 * be tested without a browser, an AudioContext, or a live TradingView.
 *
 * Deliberately NOT handled here: playing the sound or writing to chat. This
 * module decides; app.js acts.
 */

/** How long the same signal identity stays "already announced". */
const REPEAT_WINDOW_MS = 20 * 60 * 1000;   // 20 min — longer than a 30M bar's re-confirm cycle

/**
 * A stable identity for a detection, so a re-fire of the SAME setup is
 * recognised. Built from what actually distinguishes one setup from another,
 * per watcher type — not from the timestamp, which always differs.
 * Returns null when the message is not a real detection.
 */
function signalKey(type, msg) {
  const m = msg || {};
  const tf = m.tf != null ? String(m.tf) : '?';
  const dir = m.direction != null ? String(m.direction).toUpperCase() : '?';

  switch (type) {
    case 'engulf':
      // An engulf is identified by its bar; `time` is the bar's own IST stamp
      // from the server, not the poll clock, so it is stable across re-fires.
      return 'engulf|' + tf + '|' + dir + '|' + (m.time || '?');
    case 'fvg':
      // The gap bounds ARE the setup. Same gap = same setup, however many
      // polls confirm it.
      return 'fvg|' + tf + '|' + dir + '|' + (m.gapLow != null ? m.gapLow : '?') + '-' + (m.gapHigh != null ? m.gapHigh : '?');
    case 'sfp':
      // The swept level is the setup.
      return 'sfp|' + tf + '|' + dir + '|' + (m.level != null ? m.level : '?');
    case 'po3':
      // A transition, keyed by where it went. Re-entering the same phase later
      // is a genuinely new event, so `from` is part of the key.
      return 'po3|' + (m.symbol || m.symLabel || '?') + '|' + (m.from || '?') + '→' + (m.to || m.phase || '?');
    default:
      return null;
  }
}

/**
 * Human-readable one-liner for the chat notification. Kept short on purpose —
 * this lands in the chat stream mid-session, next to Jessi's replies, and a
 * paragraph there is worse than nothing.
 */
function describeSignal(type, msg) {
  const m = msg || {};
  const tf = m.tfLabel || (m.tf != null ? String(m.tf).toUpperCase() : '');
  const dir = m.direction != null ? String(m.direction).toUpperCase() : '';

  switch (type) {
    case 'engulf':
      return 'Engulfing ' + tf + (dir ? ' · ' + dir : '');
    case 'fvg':
      return 'FVG ' + tf + (dir ? ' · ' + dir : '') +
        (m.gapLow != null && m.gapHigh != null ? ' · gap ' + m.gapLow + '–' + m.gapHigh : '');
    case 'sfp':
      return 'SFP ' + tf + (dir ? ' · ' + dir : '') +
        (m.level != null ? ' · swept ' + m.level : '');
    case 'po3': {
      const sym = m.symLabel || m.symbol || '';
      const to = m.to || m.phase || '?';
      return 'PO3 ' + (sym ? sym + ' ' : '') + (m.from ? m.from + ' → ' : '') + to;
    }
    default:
      return type;
  }
}

/**
 * Should this detection make a sound and post to chat?
 *
 * @param {object} seen   mutable map of key -> last-announced ms (caller owns it)
 * @param {string} type   'engulf' | 'fvg' | 'sfp' | 'po3'
 * @param {object} msg    the broadcast payload
 * @param {number} nowMs  injected for deterministic tests
 * @returns {{announce:boolean, key:string|null, text:string, reason:string}}
 */
function shouldAnnounce(seen, type, msg, nowMs) {
  const key = signalKey(type, msg);
  if (!key) return { announce: false, key: null, text: '', reason: 'unknown type' };

  // A payload carrying an explicit found:false is a poll heartbeat that
  // happens to share a channel — never announce it. (`found` is absent on the
  // dedicated *-signal events, so absence must NOT be treated as false.)
  if (msg && msg.found === false) {
    return { announce: false, key, text: '', reason: 'poll heartbeat, nothing found' };
  }

  const last = seen && Object.prototype.hasOwnProperty.call(seen, key) ? seen[key] : null;
  if (last != null && Number.isFinite(nowMs) && (nowMs - last) < REPEAT_WINDOW_MS) {
    return { announce: false, key, text: '', reason: 'same signal already announced' };
  }

  if (seen) seen[key] = nowMs;
  return { announce: true, key, text: describeSignal(type, msg), reason: 'new signal' };
}

/** Drop entries older than the repeat window so the map cannot grow all day. */
function pruneSeen(seen, nowMs) {
  if (!seen || !Number.isFinite(nowMs)) return seen;
  for (const k of Object.keys(seen)) {
    if ((nowMs - seen[k]) >= REPEAT_WINDOW_MS) delete seen[k];
  }
  return seen;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { signalKey, describeSignal, shouldAnnounce, pruneSeen, REPEAT_WINDOW_MS };
}
if (typeof window !== 'undefined') {
  window.SignalAlert = { signalKey, describeSignal, shouldAnnounce, pruneSeen, REPEAT_WINDOW_MS };
}
