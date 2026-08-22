'use strict';
// ── Chart bar-read cache (LIVE_FEED_LOOP_PLAN.md task 0.1) ──────────────────
// Collapses N monitors reading the same (symbol, timeframe, count) into ONE
// chart operation. Every getFullBars()/getBarsAndLabels() call switches the
// live chart's timeframe and restores it — with five watchers armed that is
// ~10 switches/min on the single CDP connection that order placement also
// uses (plan 0.1's own table). This cache makes reads on the same
// (symbol, timeframe) share one fetch for the TTL window.
//
// TTL = one third of the timeframe's bar duration, per the plan (a 30m read
// stays fresh for 10 minutes, a 1H read for 20). Deliberate consequence,
// recorded for review: a just-closed NEW bar is not visible to a monitor
// until the cached read expires, so worst-case detection lag after a bar
// close is roughly TTL/2. The plan accepts this trade — the constant is one
// edit away if live verification says otherwise.
//
// A request for `count` bars is served from a cached entry that fetched
// `count` OR MORE bars (take the last `count`). A request for MORE than
// the cached count misses, so a bigger fetch is never masked by a smaller
// one. `get(..., {noslice:true})` returns the raw cached value (used by the
// label-text cache alongside the bars cache).
//
// Pure and side-effect-free: no TradingView, no I/O — unit-testable.

const BAR_DURATION_MS = {
  '1': 60 * 1000,
  '5': 5 * 60 * 1000,
  '15': 15 * 60 * 1000,
  '30': 30 * 60 * 1000,
  '45': 45 * 60 * 1000,
  '60': 60 * 60 * 1000,
  '120': 120 * 60 * 1000,
  '180': 180 * 60 * 1000,
  '240': 240 * 60 * 1000,
  'D': 24 * 3600 * 1000,
  'W': 7 * 24 * 3600 * 1000,
  'M': 30 * 24 * 3600 * 1000,
};

const DEFAULT_TTL_MS = 5 * 60 * 1000; // unknown timeframes — conservative
const MIN_TTL_MS = 10 * 1000;

// Normalize the timeframe codes the codebase uses: '60' stays '60',
// '1h'/'1H' → '60', '4H' → '240', '1D' → 'D', '1W' → 'W'.
function normalizeTf(tfCode) {
  if (tfCode == null) return '?';
  const s = String(tfCode).trim().toUpperCase();
  if (BAR_DURATION_MS[s]) return s;
  const m = s.match(/^(\d+)([HDWM])$/);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === 'H') return String(n * 60);
    if (m[2] === 'D' && n === 1) return 'D';
    if (m[2] === 'W' && n === 1) return 'W';
    if (m[2] === 'M' && n === 1) return 'M';
  }
  return s; // unknown code — keyed raw, TTL falls back to DEFAULT_TTL_MS
}

function ttlMsForTf(tfCode) {
  const dur = BAR_DURATION_MS[normalizeTf(tfCode)];
  if (!dur) return DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.round(dur / 3));
}

// Stagger monitor start times so five timers don't align on the same tick.
function staggerOffsetMs(index, perStepMs = 4000) {
  return Math.max(0, Number(index) || 0) * (perStepMs || 0);
}

class ChartBarCache {
  constructor(opts = {}) {
    this._entries = new Map(); // `symbol|tf` → { value, count, at }
    this._now = opts.now || (() => Date.now());
    this.stats = { hits: 0, misses: 0, sets: 0 };
  }
  _key(symbol, tfCode) {
    return (symbol ? String(symbol) : '?') + '|' + normalizeTf(tfCode);
  }
  // Returns the last `count` cached bars (or the raw value with
  // {noslice:true}), or null on miss / stale / too-small entry.
  get(symbol, tfCode, count, opts = {}) {
    const key = this._key(symbol, tfCode);
    const e = this._entries.get(key);
    if (!e) { this.stats.misses++; return null; }
    if (this._now() - e.at > ttlMsForTf(tfCode)) {
      this._entries.delete(key);
      this.stats.misses++;
      return null;
    }
    if (!(e.count >= count)) { this.stats.misses++; return null; }
    this.stats.hits++;
    if (opts.noslice) return e.value;
    return Array.isArray(e.value) ? e.value.slice(-count) : e.value;
  }
  // Stores value for (symbol, tfCode). A fresh entry with >= count is kept
  // (never shrunk); otherwise replaced. Returns true when the cache changed.
  set(symbol, tfCode, count, value) {
    if (value == null) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    const key = this._key(symbol, tfCode);
    const e = this._entries.get(key);
    if (e && this._now() - e.at <= ttlMsForTf(tfCode) && e.count >= count) return false;
    this._entries.set(key, { value: Array.isArray(value) ? value.slice() : value, count, at: this._now() });
    this.stats.sets++;
    return true;
  }
  clear() { this._entries.clear(); }
  size() { return this._entries.size; }
}

module.exports = { ChartBarCache, normalizeTf, ttlMsForTf, staggerOffsetMs, BAR_DURATION_MS };
