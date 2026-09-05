'use strict';
/* ── bar-recorder.js — build the intraday history TradingView will not give ───
 *
 * (2026-08-31. The drift retrospective could not run: TradingView's CDP bridge
 * returns 300 bars per request regardless of what is asked for. Covering
 * 2026-07-27..08-31 needs ~30,000 bars at 1m and ~6,000 at 5m. Retrospective
 * history at the timeframes Anoop actually enters on does not exist and cannot
 * be fetched, so the only way to get it is to start keeping it.)
 *
 * Each pull returns the most recent ~300 bars, which OVERLAP the previous pull.
 * This module folds a new pull into the stored series so the file grows into a
 * continuous history instead of being overwritten by the last five hours.
 *
 * ── THE FOUR RULES, AND WHY EACH ONE EXISTS ─────────────────────────────────
 *
 * 1. DROP THE FORMING BAR. The newest bar in any pull is still open — its high,
 *    low and close are whatever the last tick happened to be. Storing it freezes
 *    a half-finished candle into permanent history, and every later pull would
 *    disagree with it. `dropLast` removes it; the next pull, by which time it
 *    has closed, supplies the real one.
 *
 * 2. LATER DATA WINS ON A TIE. Same timestamp from two pulls means the earlier
 *    copy was mid-formation. The newer read replaces it rather than being
 *    discarded as a duplicate — the opposite of the usual dedupe instinct, and
 *    the reason bar-for-bar equality is not the test.
 *
 * 3. SPACING IS VERIFIED, NOT TRUSTED. chart_set_timeframe returns before the
 *    chart finishes switching, so a read can silently return the PREVIOUS
 *    timeframe's bars (pull-bars.js carries the full note; it was caught live on
 *    2026-07-22). Appending 30m bars into mnq_5.json would corrupt every ATR,
 *    threshold and score downstream while looking completely normal. A pull
 *    whose modal spacing does not match the file is REJECTED, not merged.
 *
 * 4. IT ONLY EVER GROWS, UP TO A CAP. This history cannot be re-fetched, so a
 *    bug that truncates it destroys something unrecoverable. Merging never
 *    returns fewer bars than it started with unless the retention cap trims the
 *    OLDEST, and the cap is deliberately far above what the backtest needs.
 *
 * PURE. No fs, no clock, no chart. Unit-tested in test/bar-recorder.test.js.
 */

const DEFAULTS = {
  maxBars: 60000,        // ~6 weeks of 1m during RTH+ETH; ~40 MB worst case as JSON
  dropLast: true,        // the forming bar
  spacingToleranceMin: 0.51,
};

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Seconds or milliseconds in, milliseconds out. */
function toMs(v) {
  const n = num(v);
  if (n == null) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Normalise a bar from any of the shapes this repo's sources produce. */
function normalizeBar(b) {
  if (!b || typeof b !== 'object') return null;
  const t = toMs(b.t != null ? b.t : b.time);
  const h = num(b.h != null ? b.h : b.high);
  const l = num(b.l != null ? b.l : b.low);
  const c = num(b.c != null ? b.c : b.close);
  const o = num(b.o != null ? b.o : b.open);
  if (t == null || h == null || l == null || c == null) return null;
  const out = { t, o: o == null ? c : o, h, l, c };
  const v = num(b.v != null ? b.v : b.volume);
  if (v != null) out.v = v; // M2: keep volume — impossible to recover later
  return out;
}

function normalizeAll(bars) {
  return (Array.isArray(bars) ? bars : []).map(normalizeBar).filter(Boolean).sort((a, b) => a.t - b.t);
}

/**
 * Modal gap between consecutive bars, in minutes. Modal rather than mean
 * because sessions break, holidays and halts produce large gaps that would drag
 * an average far away from the real bar size.
 */
function modalSpacingMin(bars) {
  const list = normalizeAll(bars);
  if (list.length < 3) return null;
  const counts = new Map();
  for (let i = 1; i < list.length; i++) {
    const mins = Math.round(((list[i].t - list[i - 1].t) / 60000) * 100) / 100;
    if (mins > 0) counts.set(mins, (counts.get(mins) || 0) + 1);
  }
  let best = null, bestN = 0;
  counts.forEach((n, mins) => { if (n > bestN) { bestN = n; best = mins; } });
  return best;
}

/**
 * Fold a fresh pull into the stored series.
 *
 * @returns {{bars, added, replaced, rejected, reason, spacing}}
 *   `rejected` true means the stored series is returned UNCHANGED.
 */
function mergePull(stored, incoming, expectedSpacingMin, options) {
  const cfg = Object.assign({}, DEFAULTS, options || {});
  const base = normalizeAll(stored);
  let fresh = normalizeAll(incoming);

  if (!fresh.length) {
    return { bars: base, added: 0, replaced: 0, rejected: true, reason: 'Empty pull — nothing to merge.', spacing: null };
  }

  // Rule 1: the newest bar is still forming.
  if (cfg.dropLast && fresh.length > 1) fresh = fresh.slice(0, -1);

  // Rule 3: verify the pull is the timeframe it claims to be.
  const spacing = modalSpacingMin(fresh);
  const expected = num(expectedSpacingMin);
  if (expected != null && spacing != null && Math.abs(spacing - expected) > cfg.spacingToleranceMin) {
    return {
      bars: base, added: 0, replaced: 0, rejected: true, spacing,
      reason: 'Pull looks like ' + spacing + 'm bars but this series is ' + expected
        + 'm — refusing to merge. The chart most likely had not finished switching timeframe.',
    };
  }

  const byT = new Map(base.map((b) => [b.t, b]));
  let added = 0, replaced = 0;
  fresh.forEach((b) => {
    // Rule 2: a newer read of the same timestamp supersedes the stored one.
    if (byT.has(b.t)) { replaced++; byT.set(b.t, b); }
    else { added++; byT.set(b.t, b); }
  });

  let out = [...byT.values()].sort((a, b) => a.t - b.t);

  // Rule 4: trim only the OLDEST, and only past the cap.
  if (cfg.maxBars && out.length > cfg.maxBars) out = out.slice(out.length - cfg.maxBars);

  return { bars: out, added, replaced, rejected: false, reason: null, spacing };
}

/** Human-readable coverage, for the log line and the report. */
function describe(bars) {
  const list = normalizeAll(bars);
  if (!list.length) return { count: 0, from: null, to: null, spanDays: 0, spacing: null };
  const from = list[0].t, to = list[list.length - 1].t;
  return {
    count: list.length,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    spanDays: Math.round(((to - from) / 86400000) * 10) / 10,
    spacing: modalSpacingMin(list),
  };
}

/**
 * How much more recording is needed before the drift question is answerable.
 * Reported so the wait is a countdown he can see rather than an open-ended
 * "keep going" — the backtest needs pairs, and pairs need trading days.
 */
function progressToAnswer(bars, opts) {
  const o = Object.assign({ pairsPerDay: 7.5, pairsNeeded: 90 }, opts || {});
  const d = describe(bars);
  const daysRecorded = d.spanDays || 0;
  const pairsSoFar = Math.floor(daysRecorded * o.pairsPerDay);
  const remaining = Math.max(0, o.pairsNeeded - pairsSoFar);
  return {
    daysRecorded, pairsSoFar, pairsNeeded: o.pairsNeeded,
    tradingDaysRemaining: Math.ceil(remaining / o.pairsPerDay),
    ready: remaining <= 0,
  };
}

module.exports = { mergePull, describe, modalSpacingMin, normalizeBar, normalizeAll, progressToAnswer, toMs, DEFAULTS };
