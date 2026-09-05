// session-windows.js — resolve session windows to IST minutes, DST-aware.
//
// WHY THIS EXISTS (2026-09-03, Anoop's decision)
// ---------------------------------------------------------------------------
// The session windows were stored as FIXED minutes-since-IST-midnight
// (London 810 = 13:30, NY 1140 = 19:00). India does not observe DST; London
// and New York both do, and they shift on different dates. A fixed IST time
// therefore cannot track an exchange open — it can only ever be right for part
// of the year, and the two windows are wrong in opposite halves of it:
//
//                        real open (IST)              old fixed value
//   date            London        New York        London    NY
//   2026-09-03      12:30 (BST)   19:00 (EDT)     13:30 ✗   19:00 ✓
//   2026-10-26      13:30 (GMT)   19:00 (EDT)     13:30 ✓   19:00 ✓
//   2026-11-02      13:30 (GMT)   20:00 (EST)     13:30 ✓   19:00 ✗
//
// So on 2026-09-03 the app's "London" window opened a full hour after London
// actually did, and from 2026-11-02 its "NY" window would have opened an hour
// before the New York cash open. Anoop's own rulebook (Prop Trading/CLAUDE.md
// rule #136) pinned both to UTC, which is what baked the drift in; its own
// closing note already flagged the London hours as unreconciled.
//
// Windows are now declared in the exchange's OWN timezone and converted here.
// Durations are preserved exactly from the previous fixed values (London 90
// minutes, NY 120), so this moves WHEN a window opens, never how long it runs.
//
// The output shape is unchanged — {name, startMin, endMin} in IST minutes —
// so every existing consumer (currentSessionStartUnix, the pre-open prep, the
// renderer's window flags, day-rollup) keeps working untouched. rules.json
// stays the single source of truth; it just states the times natively now.
//
// Deliberately pure and clock-free: `atMs` is always passed in. Everything
// here is date-dependent, so a module that read the clock itself could only be
// tested on the day you happened to run it.

'use strict';

const IST_OFFSET_MIN = 330; // UTC+5:30, fixed — India has no DST

/**
 * Minutes the zone is AHEAD of UTC at a given instant (negative if behind).
 * Uses the ICU database via Intl, so DST rules stay correct without this repo
 * shipping (and having to maintain) a transition table of its own.
 */
function tzOffsetMinutes(tz, atMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(atMs));
  const p = {};
  parts.forEach(x => { p[x.type] = x.value; });
  // hourCycle can render midnight as "24" in some ICU builds.
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asIfUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return Math.round((asIfUtc - Math.floor(atMs / 1000) * 1000) / 60000);
}

/**
 * The UTC instant at which `tz` local wall-clock reads `dateStr` `hh:mm`.
 * Iterates because the offset depends on the instant we are solving for; two
 * passes settle it everywhere except inside a DST gap, where it lands on the
 * first real instant after the gap (which is the correct session open anyway).
 */
function zonedWallTimeToUtc(dateStr, hhmm, tz) {
  const Y = Number(dateStr.slice(0, 4));
  const M = Number(dateStr.slice(5, 7));
  const D = Number(dateStr.slice(8, 10));
  const h = Number(String(hhmm).split(':')[0]);
  const m = Number(String(hhmm).split(':')[1] || 0);
  const naive = Date.UTC(Y, M - 1, D, h, m);
  let guess = naive;
  for (let i = 0; i < 3; i++) {
    const next = naive - tzOffsetMinutes(tz, guess) * 60000;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** The IST calendar date (YYYY-MM-DD) containing `atMs`. */
function istDateStr(atMs) {
  return new Date(atMs + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

/** Minutes since IST midnight for a UTC instant. */
function istMinutesOf(utcMs) {
  const ist = new Date(utcMs + IST_OFFSET_MIN * 60000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/**
 * Resolve native window declarations to IST minutes for the day containing
 * `atMs`.
 *
 * @param {Array} windows [{ name, tz, startLocal:"HH:MM", endLocal:"HH:MM" }]
 *   A window that already carries numeric startMin/endMin and no tz is passed
 *   through untouched — so a hand-pinned fixed-IST window still works, and a
 *   malformed entry degrades to "as written" rather than disappearing.
 * @param {number} atMs
 * @returns {Array} [{ name, startMin, endMin, tz, startLocal, endLocal, crossesIstMidnight }]
 */
function resolveWindowsIST(windows, atMs) {
  const now = (atMs != null) ? atMs : Date.now();
  const dateStr = istDateStr(now);
  const list = Array.isArray(windows) ? windows : [];

  return list.map(w => {
    if (!w) return null;
    if (!w.tz || !w.startLocal) {
      // Nothing to convert — a fixed-IST window, left exactly as declared.
      return (w.startMin != null) ? Object.assign({}, w) : null;
    }
    const startUtc = zonedWallTimeToUtc(dateStr, w.startLocal, w.tz);
    const endUtc = w.endLocal ? zonedWallTimeToUtc(dateStr, w.endLocal, w.tz) : null;
    const startMin = istMinutesOf(startUtc);
    const endMin = endUtc != null ? istMinutesOf(endUtc) : null;

    // Every consumer compares against minutes-since-IST-midnight of the SAME
    // IST day, so a window that lands on a different IST date (or wraps past
    // midnight) would compare wrongly. Neither current window can do this, but
    // it is flagged rather than silently normalised: a future window that
    // wraps needs a real decision, not a mod-1440.
    const crossesIstMidnight = istDateStr(startUtc) !== dateStr
      || (endMin != null && endMin < startMin);

    return {
      name: w.name,
      startMin,
      endMin,
      tz: w.tz,
      startLocal: w.startLocal,
      endLocal: w.endLocal || null,
      crossesIstMidnight
    };
  }).filter(Boolean).sort((a, b) => a.startMin - b.startMin);
}

module.exports = { resolveWindowsIST, tzOffsetMinutes, zonedWallTimeToUtc, istMinutesOf, istDateStr, IST_OFFSET_MIN };
