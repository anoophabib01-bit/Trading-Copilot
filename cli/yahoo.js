'use strict';
// ── yahoo.js — Yahoo Finance chart adapter + session arithmetic ─────────────
//
// Everything the app needs from yahoo-finance-pp-cli, with the verified
// operational facts baked in so no caller has to rediscover them.
//
// ── WHAT WAS VERIFIED ON 2026-09-06 (by direct invocation) ─────────────────
//   chart MNQ=F  -> exchangeName "CME", instrumentType "FUTURE", live price.
//   chart MGC=F  -> exchangeName "CMX", instrumentType "FUTURE".
//   quote list   -> HTTP 401. Yahoo has CLOSED /v7/finance/quote. `chart`
//                   hits /v8 and needs no auth. `doctor` still reports
//                   "Auth: not required" while `quote` is dead, so doctor is
//                   NOT a readiness check for the endpoint we actually use.
//
//   Bar counts actually returned (interval / max range / bars):
//     MNQ=F  1m  / 7d   /  7,127      MNQ=F  1h / 2y  / 14,504
//     MNQ=F  5m  / 60d  / 16,691      MNQ=F  1d / max /    385  <- GAPPED
//     MNQ=F  15m / 60d  /  5,565      MGC=F  1d / max /    164  <- GAPPED
//
// ── THE DAILY-BAR TRAP ─────────────────────────────────────────────────────
// 385 daily bars across seven years is ~55/year against an expected ~252, and
// MGC's 164 across sixteen years is worse. Yahoo stitches CONTINUOUS futures
// contracts badly at daily resolution. Anything computed from `1d` on MNQ=F or
// MGC=F — an average true range, a 20-day baseline, a gap statistic — is wrong
// in a way that looks plausible. So DAILY_UNSAFE below is enforced in code
// rather than left in a comment: fetchBars() refuses the combination outright.
// Use 1h and resample if a daily figure is genuinely needed.

const { run } = require('./market-cli');

// Continuous-futures roots whose Yahoo daily series is too gapped to use.
const DAILY_UNSAFE = new Set(['MNQ=F', 'MGC=F', 'NQ=F', 'GC=F', 'ES=F', 'CL=F', 'DX=F']);

// Max range Yahoo will serve per interval. Asking beyond this silently returns
// a shorter window rather than erroring, which is how a "60 days of 1m data"
// assumption survives testing and fails in production.
const MAX_RANGE = {
  '1m': '7d', '2m': '60d', '5m': '60d', '15m': '60d',
  '30m': '60d', '60m': '2y', '90m': '60d', '1h': '2y',
  '1d': 'max', '5d': 'max', '1wk': 'max', '1mo': 'max', '3mo': 'max',
};

// The instruments this app cares about, plus the cross-market context that
// actually moves them. Kept here so the brief and the corpus agree on symbols.
const SYMBOLS = {
  MNQ: { y: 'MNQ=F', label: 'MNQ', name: 'Micro E-mini Nasdaq-100', tick: 0.25, tickValue: 0.5 },
  MGC: { y: 'MGC=F', label: 'MGC', name: 'Micro Gold', tick: 0.1, tickValue: 1.0 },
};

// `kind` decides how a change is measured, and it is not cosmetic. An INDEX
// prints one close a day, so last-vs-previous daily close is a real session
// change. A continuous FUTURE trades ~23h, so the last two intraday bars are
// often the same price with the market shut — that comparison reports 0% on a
// day the contract actually moved 1%. Futures are therefore sessionized (prior
// RTH close vs overnight close), exactly like MNQ and MGC.
//
// DX=F is NOT a valid Yahoo symbol — verified 2026-09-06, HTTP 404 "symbol may
// be delisted". The ICE dollar index is DX-Y.NYB.
const CONTEXT = [
  { y: '^VIX', label: 'VIX', kind: 'index', name: 'Volatility index', why: 'risk appetite; MNQ inverse' },
  { y: '^TNX', label: '10Y', kind: 'index', name: '10-year yield', why: 'rates drive MNQ multiple' },
  { y: 'DX-Y.NYB', label: 'DXY', kind: 'index', name: 'Dollar index', why: 'inverse to MGC' },
  { y: 'ES=F', label: 'ES', kind: 'future', name: 'E-mini S&P 500', why: 'breadth check on MNQ move' },
];

// Gold-specific context. Verified 2026-09-07: SI=F carries the same 5m/60d
// depth as MGC=F (16,691 bars) so the gold/silver ratio in gold-brief.js is
// computed from a like-for-like sample, not a shorter one padded with gaps.
// TIP (iShares TIPS bond ETF) is a REAL-YIELD proxy, not a nominal-yield one —
// gold tracks real yields far more tightly than nominal 10Y, and TIP's price
// moves inversely to real yields (price up = real yields down = gold-bullish),
// which is the opposite sign convention from DXY/10Y above. ^XAU (Philadelphia
// Gold/Silver Sector index) is a miner-sentiment gauge, distinct from the
// metal price itself — it can diverge from MGC when the market is pricing
// miner-specific risk (financing, jurisdiction) rather than the metal.
const GOLD_CONTEXT = [
  { y: 'SI=F', label: 'Silver', kind: 'future', name: 'Silver futures', why: 'gold/silver ratio — see below' },
  { y: 'TIP', label: 'TIP', kind: 'index', name: 'TIPS bond ETF (real-yield proxy)', why: 'price UP = real yields DOWN = gold-bullish (inverse of DXY/10Y above)' },
  { y: '^XAU', label: 'XAU', kind: 'index', name: 'Philadelphia Gold/Silver miners index', why: 'miner sentiment — can diverge from the metal' },
];

// ── fetchBars ──────────────────────────────────────────────────────────────
// Returns { ok, symbol, meta, bars, error }. bars are ascending, each
// { t (epoch seconds), o, h, l, c, v }. Yahoo pads its arrays with nulls where
// no trade occurred; those rows are dropped rather than passed on as zeroes,
// because a null close read as 0 would poison every downstream statistic.
async function fetchBars(symbol, { interval = '5m', range, period1, period2, timeout } = {}) {
  if (interval === '1d' && DAILY_UNSAFE.has(symbol)) {
    return {
      ok: false, symbol, bars: [], meta: null,
      error: 'refusing 1d on ' + symbol + ': Yahoo daily bars for continuous futures are '
        + 'severely gapped (verified 2026-09-06). Use 1h and resample.',
    };
  }

  const args = ['chart', symbol, '--interval', interval];
  if (period1) {
    args.push('--period1', String(period1));
    if (period2) args.push('--period2', String(period2));
  } else {
    args.push('--range', range || MAX_RANGE[interval] || '1mo');
  }

  const res = await run('yahoo-finance', args, { timeout: timeout ?? 180000 });
  if (!res.ok) {
    return { ok: false, symbol, bars: [], meta: null, error: res.error, code: res.codeKey };
  }

  const result = res.data && res.data.chart && res.data.chart.result && res.data.chart.result[0];
  if (!result) {
    const apiErr = res.data && res.data.chart && res.data.chart.error;
    return {
      ok: false, symbol, bars: [], meta: null,
      error: apiErr ? (apiErr.description || apiErr.code) : 'no chart result for ' + symbol,
    };
  }

  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open ? q.open[i] : null;
    const h = q.high ? q.high[i] : null;
    const l = q.low ? q.low[i] : null;
    const c = q.close ? q.close[i] : null;
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({ t: ts[i], o, h, l, c, v: (q.volume && q.volume[i]) || 0 });
  }

  return { ok: true, symbol, meta: result.meta || null, bars, error: null };
}

// ── Time zone arithmetic ───────────────────────────────────────────────────
// The exchange day is New York; Anoop reads the clock in India. Both are
// derived from the same instant via Intl, which handles the two DST shifts a
// year on their own schedules — the failure mode a fixed +9:30 offset has, and
// the one already recorded against this repo's session windows.
function zonedParts(epochSec, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(epochSec * 1000))) p[part.type] = part.value;
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    H: hour, M: Number(p.minute), wd: p.weekday,
    dayKey: p.year + '-' + p.month + '-' + p.day,
    minutes: hour * 60 + Number(p.minute),
  };
}

const etParts = (t) => zonedParts(t, 'America/New_York');
const istParts = (t) => zonedParts(t, 'Asia/Kolkata');

function fmtET(t) {
  const p = etParts(t);
  return String(p.H).padStart(2, '0') + ':' + String(p.M).padStart(2, '0') + ' ET';
}
function fmtIST(t) {
  const p = istParts(t);
  return String(p.H).padStart(2, '0') + ':' + String(p.M).padStart(2, '0') + ' IST';
}
function fmtBoth(t) { return fmtET(t) + ' / ' + fmtIST(t); }

// NY regular trading hours: 09:30–16:00 ET, weekdays. Index futures trade
// nearly around the clock, so "the session" is a window we impose on a
// continuous tape, not a property of the tape.
const RTH_OPEN_MIN = 9 * 60 + 30;
const RTH_CLOSE_MIN = 16 * 60;

function isWeekday(p) { return p.wd !== 'Sat' && p.wd !== 'Sun'; }
function isRTH(t) {
  const p = etParts(t);
  return isWeekday(p) && p.minutes >= RTH_OPEN_MIN && p.minutes < RTH_CLOSE_MIN;
}

// Minutes until the next 09:30 ET open from a given instant (0 if inside RTH).
function minutesToNYOpen(nowSec = Math.floor(Date.now() / 1000)) {
  const p = etParts(nowSec);
  if (isWeekday(p) && p.minutes >= RTH_OPEN_MIN && p.minutes < RTH_CLOSE_MIN) return 0;
  let mins = RTH_OPEN_MIN - p.minutes;
  let probe = nowSec;
  if (mins <= 0) { mins += 1440; probe += 86400; }
  // Skip weekends by walking forward a day at a time.
  let guard = 0;
  while (!isWeekday(etParts(probe)) && guard++ < 7) { mins += 1440; probe += 86400; }
  return mins;
}

// ── Session grouping ───────────────────────────────────────────────────────
// Splits bars into RTH days and the overnight (globex) block that precedes the
// next RTH open. `sessions` is keyed by the ET calendar day of the RTH block.
function groupSessions(bars) {
  const rth = new Map();
  for (const b of bars) {
    if (!isRTH(b.t)) continue;
    const k = etParts(b.t).dayKey;
    if (!rth.has(k)) rth.set(k, []);
    rth.get(k).push(b);
  }
  return rth;
}

function ohlcOf(bars) {
  if (!bars || !bars.length) return null;
  let h = -Infinity, l = Infinity, v = 0;
  for (const b of bars) { if (b.h > h) h = b.h; if (b.l < l) l = b.l; v += b.v || 0; }
  return {
    o: bars[0].o, h, l, c: bars[bars.length - 1].c, v,
    from: bars[0].t, to: bars[bars.length - 1].t, n: bars.length,
  };
}

module.exports = {
  fetchBars, SYMBOLS, CONTEXT, GOLD_CONTEXT, MAX_RANGE, DAILY_UNSAFE,
  zonedParts, etParts, istParts, fmtET, fmtIST, fmtBoth,
  isRTH, isWeekday, minutesToNYOpen, groupSessions, ohlcOf,
  RTH_OPEN_MIN, RTH_CLOSE_MIN,
};
