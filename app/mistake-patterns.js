'use strict';
// ── Live mistake-pattern detection (2026-08-19) ─────────────────────────────
// Anoop's ask: track his live moves while trading and feed it back so a
// REPEATED mistake gets caught by the current workflow, not just visible
// after the fact in a post-session review. Scoped deliberately narrow per
// his own explicit decision (2026-08-19, after Bugs 6-8 were found live):
// ONE pattern first (F1, trade-count escalation), advisory only — no
// enforcement action, promoting to a hard stop is a separate future decision.
//
// Pure, side-effect-free, unit-tested — mirrors size-freeze-guard.js's shape
// so this can be extended with F2-F6/M1-M6 later without re-deriving the
// pattern.
//
// SOURCE TEXT (cited verbatim, app/renderer/index.html:636 — his own
// documented account-blowup analysis, do not paraphrase this away from what
// he actually wrote for himself):
//   "F1 — Trade count escalation — profitable days: 6-12 trades. Blow-up
//    days: 65 trades, 20% win rate. More trades = more damage. Stop at 2
//    good trades. Done."
//
// The signal this checks is NOT the same as rules.json's tradesPerDay hard
// cap (5) — that's a count ceiling regardless of outcome. F1's own text is
// about WINNING trades specifically: the failure mode his own data shows is
// continuing to trade AFTER already winning, not merely trading a lot. So
// this fires on win count, which can (and should) warn well before the
// tradesPerDay cap is ever reached.

const F1_WIN_THRESHOLD = 2; // "Stop at 2 good trades. Done." — his own number, not invented here

/**
 * @param {Array} trades  today's trades (tv-broker-feed.js fold() shape) —
 *   {pnl, pnlUnknown, size, ...}. Backfilled trades with pnlUnknown:true are
 *   deliberately excluded from the win count — we don't know if they won.
 * @returns {{matched: boolean, winCount: number, totalCount: number, message: string|null}}
 */
function checkTradeCountEscalation(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const knownTrades = list.filter(t => t && !t.pnlUnknown);
  const winCount = knownTrades.filter(t => typeof t.pnl === 'number' && t.pnl > 0).length;
  const matched = winCount >= F1_WIN_THRESHOLD;
  return {
    matched,
    winCount,
    totalCount: list.length,
    message: matched
      ? `PATTERN F1 (your own data): "profitable days run 6-12 trades, blow-up days run into the 60s at a 20% win rate — stop at 2 good trades, done." You're at ${winCount} winning trade${winCount === 1 ? '' : 's'} today. This is exactly the point your own history says to stop.`
      : null,
  };
}

// ── F2: revenge clusters (2026-08-20) ──────────────────────────────────────
// SOURCE TEXT (verbatim, app/renderer/index.html):
//   "F2 — Revenge clusters — rapid re-entries at same zone, increasing size
//    after losses. Two losses in a row = close platform. Non-negotiable."
//
// That text contains THREE sub-signals. The size half — increasing size after
// a loss — is ALREADY a hard stop with no override (size-freeze-guard.js's
// sizeUpAfterLossViolation, wired into both grLog() and grIngestLive()), so
// detecting it again here would only double-alert on something already
// blocked. F2 covers the two halves nothing watches:
//
//   F2a  consecutive losses — the last two confirmed trades both lost. This
//        is Risk Protocol rule 08 ("after 2 consecutive losses, close the
//        platform, stop for the session") and his own note says it appears in
//        4 of 6 blown accounts. ADVISORY here on purpose: the stop it argues
//        for is his call, and forcing a session stop on a 2-loss streak is a
//        larger behavioural change than a detection pass should make alone.
//
//   F2b  rapid re-entry after a loss — a trade closed within
//        rules.cooldownMinutes of the previous LOSING trade's close.
//
// HONEST LIMITATION on F2b: the broker feed records CLOSE times only (fold()
// stamps `at` when a position returns flat) — there is no entry timestamp per
// trade today. So this measures close-to-close, which makes it a strict LOWER
// BOUND: a trade that closed inside the cooldown certainly also entered
// inside it, so every match is real, but a slow trade entered immediately
// after a loss is missed. Adding entry timestamps closes that gap and is
// tracked as its own pass in MISTAKE_PATTERNS_PLAN.md — deliberately not
// approximated with a proxy here.
//
// Precedence: when both sub-signals match, F2a is what gets reported. A loss
// streak is the more serious state and its instruction ("close the platform")
// supersedes "slow down".

const F2_LOSS_STREAK = 2; // "Two losses in a row = close platform" — his number

/**
 * @param {Array} trades  today's trades (tv-broker-feed.js fold() shape)
 * @param {object} [opts] { cooldownMinutes } — from rules.json via
 *   getActiveRules(), never hardcoded. Omitted/invalid disables F2b only;
 *   F2a still runs.
 * @returns {{matched: boolean, kind: string|null, lossStreak: number,
 *            gapMinutes: number|null, message: string|null}}
 */
function checkRevengeCluster(trades, opts) {
  const list = Array.isArray(trades) ? trades : [];

  // 2026-08-20 FIX (found in review, before this ever ran live): the first
  // version FILTERED OUT pnlUnknown trades and then counted the streak over
  // what remained. That silently closes the gap a trade left behind — the
  // sequence loss → (backfilled trade, P&L sign unknown) → loss reported
  // "2 losing trades back to back" even though the middle trade may well have
  // been a WIN. Backfilled trades are precisely the fast scalps the 10s poll
  // aliases past, so that sequence is common, not exotic — and it would have
  // fabricated the single most severe message in this file ("close the
  // platform") on a day that never had a loss streak.
  //
  // A trade whose outcome we don't know BREAKS the evaluation rather than
  // being deleted from it: adjacency is the whole signal here, so an
  // indeterminate neighbour means we genuinely cannot say. Reported as
  // `indeterminate: true` so callers can tell "no streak" apart from "cannot
  // tell" — this is the same principle as pollTVBrokerAccount refusing to
  // fold when the positions table is unreadable instead of guessing "flat".
  let lossStreak = 0;
  let indeterminate = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (!t || t.pnlUnknown || typeof t.pnl !== 'number') { indeterminate = true; break; }
    if (t.pnl < 0) lossStreak++;
    else break;
  }
  if (indeterminate && lossStreak < F2_LOSS_STREAK) {
    // An unknown trade cut the walk short before a streak was established.
    // Whatever came before it cannot be reasoned about, so decline to judge —
    // including F2b, whose adjacency assumption is broken by the same trade.
    return { matched: false, kind: null, lossStreak, gapMinutes: null, indeterminate: true, message: null };
  }
  // Confirmed trades only, for F2b's adjacency check below.
  const known = list.filter(t => t && !t.pnlUnknown && typeof t.pnl === 'number');

  if (lossStreak >= F2_LOSS_STREAK) {
    return {
      matched: true,
      kind: 'consecutive-losses',
      lossStreak,
      gapMinutes: null,
      message: `PATTERN F2 (your own data): "revenge clusters — rapid re-entries, increasing size after losses. Two losses in a row = close platform. Non-negotiable." That's ${lossStreak} losing trade${lossStreak === 1 ? '' : 's'} back to back. Your 8-rule protocol says stop the session here, and this is the pattern in 4 of your 6 blown accounts.`,
    };
  }

  // F2b — rapid re-entry after a loss. Needs the cooldown from rules.json.
  const cooldownMinutes = opts && Number(opts.cooldownMinutes);
  // Adjacency is read off the RAW list, not the filtered one, for the same
  // reason as the streak above: if an unknown trade sits between the last two
  // confirmed ones, the "gap since the previous trade" would be measured
  // straight across a trade that actually happened in between.
  if (Number.isFinite(cooldownMinutes) && cooldownMinutes > 0 && list.length >= 2) {
    const last = list[list.length - 1];
    const prev = list[list.length - 2];
    const bothKnown = last && prev && !last.pnlUnknown && !prev.pnlUnknown
      && typeof last.pnl === 'number' && typeof prev.pnl === 'number';
    const bothTimed = bothKnown && typeof last.at === 'number' && typeof prev.at === 'number';
    if (bothTimed && prev.pnl < 0) {
      const gapMs = last.at - prev.at;
      // A non-positive gap means the timestamps are out of order or identical
      // — bad data, not a fast re-entry. Declining to judge is correct.
      if (gapMs > 0 && gapMs < cooldownMinutes * 60000) {
        const gapMinutes = gapMs / 60000;
        return {
          matched: true,
          kind: 'rapid-reentry',
          lossStreak,
          gapMinutes,
          message: `PATTERN F2 (your own data): "revenge clusters — rapid re-entries at same zone... after losses." You were back in and out again ${gapMinutes < 1 ? 'under a minute' : gapMinutes.toFixed(1) + ' minutes'} after a losing trade closed — inside your own ${cooldownMinutes}-minute cooldown. Measured close-to-close, so the real gap after the loss was even shorter than that.`,
        };
      }
    }
  }

  return { matched: false, kind: null, lossStreak, gapMinutes: null, message: null };
}

// ── F3: inverted R:R (2026-08-22, LIVE_FEED_LOOP_PLAN 5.3) ───────────────
// SOURCE TEXT (verbatim, app/renderer/index.html):
//   "Inverted R:R — avg win $15.75, avg loss $246. Cutting winners, holding
//    losers. Use time stop: exit flat if no move in 60 seconds. Never move
//    stop away."
//
// Signal (REALIZED, not planned): with >= f3MinWins confirmed wins and >= 1
// confirmed loss today, fire when avgLoss >= f3Ratio × avgWin. His documented
// ratio is ~15.6:1; f3Ratio = 2 is a deliberately early warning, not a
// re-statement of the disaster. Counts are stated in the message so he can
// judge whether it is behaviour or one bad trade. pnlUnknown trades are
// excluded from the win/loss math (their sign is unknown — design rule 2).
// The "time stop / never move stop" halves are NOT covered: the feed sees no
// stop-modification events (per MISTAKE_PATTERNS_PLAN.md's F3 note).

/**
 * @param {Array} trades  today's trades (tv-broker-feed.js fold() shape)
 * @param {object} [opts] { f3Ratio, f3MinWins } — from rules.json, never
 *   hardcoded. Defaults: ratio 2, minWins 2.
 * @returns {{matched: boolean, winCount: number, lossCount: number,
 *            avgWin: number|null, avgLoss: number|null, ratio: number|null,
 *            message: string|null}}
 */
function checkInvertedRR(trades, opts) {
  const list = Array.isArray(trades) ? trades : [];
  const ratio = (opts && Number(opts.f3Ratio)) || 2;
  const minWins = (opts && Number(opts.f3MinWins)) || 2;
  const known = list.filter(t => t && !t.pnlUnknown && typeof t.pnl === 'number');
  const wins = known.filter(t => t.pnl > 0);
  const losses = known.filter(t => t.pnl < 0);
  if (wins.length < minWins || losses.length < 1) {
    return { matched: false, winCount: wins.length, lossCount: losses.length, avgWin: null, avgLoss: null, ratio: null, message: null };
  }
  const avgWin = wins.reduce((a, t) => a + t.pnl, 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length);
  const matched = avgLoss >= ratio * avgWin;
  return {
    matched,
    winCount: wins.length,
    lossCount: losses.length,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    ratio: avgWin > 0 ? Math.round((avgLoss / avgWin) * 100) / 100 : null,
    message: matched
      ? `PATTERN F3 (your own data): "inverted R:R — avg win $15.75, avg loss $246. Cutting winners, holding losers." Today's realized trades average $${Math.round(avgWin * 100) / 100} won and $${Math.round(avgLoss * 100) / 100} lost (${wins.length} win${wins.length === 1 ? '' : 's'}, ${losses.length} loss${losses.length === 1 ? '' : 'es'}) — your losses are running ${avgWin > 0 ? (avgLoss / avgWin).toFixed(1) : '?'}× your wins. That is the exact shape of every blown account.`
      : null,
  };
}

module.exports = { checkTradeCountEscalation, F1_WIN_THRESHOLD, checkRevengeCluster, F2_LOSS_STREAK, checkInvertedRR };
