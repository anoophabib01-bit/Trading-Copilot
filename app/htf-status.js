'use strict';
// ── htf-status.js — "which way are the watchers looking, and are they alive?" ─
//
// Anoop, 2026-09-02:
//
//   "i want to know in the APP UI which side bullish or bearish the watchers
//    are looking at as per 1hr and 4hr and should let me know in the chat as
//    evidence every hour so that i know they are active and i can confirm if
//    they are doing their work accurately."
//
// 2026-09-03: the pair of timeframes moved down a rung — structure is read on
// the 15M and the 1H confirms it (htf-alignment.js has the measurements). The
// requirement is unchanged; only which two charts it names.
//
// Two separate requirements hide in that sentence, and only the first is
// obvious:
//
//   1. WHICH SIDE — the 15M/1H read the gate is currently applying.
//   2. THAT IT IS ACTUALLY WORKING — "so that i know they are active and i can
//      confirm if they are doing their work accurately."
//
// Requirement 2 is the hard one, and it is why this module exists instead of a
// one-line template string at the call site. An hourly message saying
// "watchers are looking BEARISH" proves nothing on its own: a server whose
// chart feed died an hour ago prints exactly the same sentence, and prints it
// forever. A status line that cannot fail is not evidence, it is decoration.
//
// So every line carries the three things that make it checkable:
//
//   • WHEN the underlying bars end (`barCloseIST`), so he can look at his own
//     15M chart and see whether the app is reading the same candle he is.
//   • HOW OLD that is (`dataAgeMinutes`), so a frozen feed shows up as an
//     ageing number rather than a confident repetition.
//   • HOW MANY watchers are armed (`armedCount`/`totalCount`), named
//     individually when any is missing, because "4 of 4" and "3 of 4" are the
//     difference between covered and quietly blind on one timeframe.
//
// STALE IS SAID OUT LOUD. Past a threshold the line leads with STALE instead of
// the bias. The bias is still reported — hiding it would be its own failure —
// but it is never presented as current when it is not, because the entire point
// of the hourly message is to be trusted without being audited every time.
//
// PURE. No I/O, no clock, no chart — the caller supplies the read and the time.

// Two 15M bars, plus a margin. One is normal (the read excludes the forming
// bar by design, so it is always at least one behind); two means a close was
// missed.
//
// This was 125 minutes when structure was read on the 1H. Left at 125 against
// a 15M read it would take EIGHT missed closes before the panel admitted the
// feed had stalled — two hours of a confident, wrong side. The threshold has
// to track the deciding timeframe or the staleness check quietly stops being
// one.
const STALE_AFTER_MINUTES = 35;

function pad(n) { return String(n).padStart(2, '0'); }

// IST wall-clock, matching every other timestamp Anoop sees in this app.
function istHHMM(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + 5.5 * 3600000);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

function ageText(mins) {
  if (mins == null) return 'unknown age';
  if (mins < 60) return mins + 'm old';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? h + 'h' + pad(m) + 'm old' : h + 'h old';
}

function sideWord(bias) {
  if (bias === 'bullish') return 'BULLISH';
  if (bias === 'bearish') return 'BEARISH';
  return 'NO SIDE';
}

/**
 * @param {object} o
 * @param {object} o.htf          readHTF() result (may be null/failed)
 * @param {Array}  o.watchers     [{ label:'1H', running:true }, ...]
 * @param {number} o.lastBarMs    close time of the newest 15M bar the read used
 * @param {number} o.nowMs
 * @param {number} [o.staleAfterMinutes]
 */
function buildStatus(o) {
  const opts = o || {};
  const htf = opts.htf || null;
  const watchers = Array.isArray(opts.watchers) ? opts.watchers : [];
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : null;
  const lastBarMs = Number.isFinite(opts.lastBarMs) ? opts.lastBarMs : null;
  const staleAfter = Number.isFinite(opts.staleAfterMinutes) ? opts.staleAfterMinutes : STALE_AFTER_MINUTES;

  const armed = watchers.filter(w => w && w.running);
  const missing = watchers.filter(w => w && !w.running).map(w => w.label);
  const dataAgeMinutes = (nowMs != null && lastBarMs != null)
    ? Math.max(0, Math.round((nowMs - lastBarMs) / 60000)) : null;
  const stale = dataAgeMinutes != null && dataAgeMinutes > staleAfter;
  // G16: default CONNECTED unless explicitly told false — a caller that does
  // not pass tvConnected (tests, older call sites) must not read as "feed down".
  const tvConnected = opts.tvConnected === false ? false : true;

  const ok = !!(htf && htf.ok);
  const st = {
    ok,
    bias: ok ? htf.bias : null,
    structure15m: htf ? (htf.structure15m || null) : null,
    structure1h: htf ? (htf.structure1h || null) : null,
    confirmation: htf ? (htf.confirmation || null) : null,
    reason: htf ? htf.reason : 'htf-unavailable',
    armedCount: armed.length,
    totalCount: watchers.length,
    missingWatchers: missing,
    armedLabels: armed.map(w => w.label),
    barCloseIST: istHHMM(lastBarMs),
    atIST: istHHMM(nowMs),
    dataAgeMinutes,
    stale,
      tvConnected,
    side: sideWord(ok ? htf.bias : null),
    // G20: how many bars the read actually used — a short response must not read
    // like a full window.
    bars15mUsed: htf ? (htf.bars15mUsed != null ? htf.bars15mUsed : null) : null,
    bars1hUsed: htf ? (htf.bars1hUsed != null ? htf.bars1hUsed : null) : null,
  };
  st.headline = buildHeadline(st);
  st.evidence = buildEvidence(st);
  return st;
}

// The short form — the UI chip. One glance: which way, and is it trustworthy.
function buildHeadline(st) {
  if (st.stale) return 'HTF STALE — ' + st.side + ' (' + ageText(st.dataAgeMinutes) + ')';
  if (st.tvConnected === false) return 'HTF FEED DOWN — TradingView disconnected';
  if (!st.ok) return 'HTF NO BIAS — B and C held, A alerts unlabelled';
  const conf = st.confirmation === 'confirmed' ? '1H confirms'
    : st.confirmation === 'disagrees' ? '1H disagrees'
    : st.confirmation === 'unclear' ? '1H unclear'
    : '1H unavailable';
  return 'HTF ' + st.side + ' — 15M ' + st.structure15m + ', ' + conf;
}

// The hourly chat line. Longer on purpose: this is the one he is meant to be
// able to CHECK, so it names the candle and the watcher count rather than
// asking him to take the verdict on faith.
function buildEvidence(st) {
  const when = st.atIST ? st.atIST + ' IST' : 'now';
  const parts = [];

  if (st.stale) {
  if (st.tvConnected === false) {
    parts.push('HTF ' + when + ' — FEED DOWN. TradingView is disconnected; no bias read is current.');
    parts.push('The newest 15M bar the watchers have is ' + (st.barCloseIST || 'unknown')
      + ' IST (' + ageText(st.dataAgeMinutes) + ').');
    parts.push('Playbook B and Playbook C (ADX) are held until the feed returns.');
    return parts.join(' ');
  }

    // Leads with the problem. A stale read that opens with the bias would be
    // read as the bias, and the staleness is the more important fact.
    parts.push('HTF ' + when + ' — STALE READ, do not trust this side.');
    parts.push('The newest 15M bar the watchers have is ' + (st.barCloseIST || 'unknown')
      + ' IST (' + ageText(st.dataAgeMinutes) + '), so the chart feed has probably stalled.');
    parts.push('Last computed side was ' + st.side + '.');
  } else if (!st.ok) {
    parts.push('HTF ' + when + ' — NO BIAS. Playbook B and Playbook C (ADX) are held;'
      + ' Playbook A still alerts on any closed engulfing, with no bias to label it against.');
    parts.push(st.structure15m
      ? 'The 15M structure reads ' + st.structure15m + ', not a clean HH-HL or LL-LH.'
      : 'The 15M structure could not be read at all.');
  } else {
    parts.push('HTF ' + when + ' — the watchers are looking ' + st.side + '.');
    parts.push('15M structure ' + (st.structure15m === 'bullish' ? 'HH-HL' : 'LL-LH')
      + '; 1H ' + describeConfirm(st) + '.');
    // Playbook A stopped being gated on 2026-09-03 — it alerts in BOTH
    // directions and he picks the side. Saying "only BULLISH setups can fire"
    // would now be false on the watchers he sees most often, and a status line
    // that is wrong about what the app does is worse than no status line.
    parts.push('Playbook B and Playbook C (ADX) can only fire ' + st.side
      + '; Playbook A alerts BOTH ways and labels each one with or against this bias.');
  }

  parts.push(watcherText(st));
  if (st.barCloseIST && !st.stale) {
    // G20: below the requested 40 bars the read is degraded and must say so — a
    // starved window and a full one produce identical output otherwise.
    const readNote = (st.bars15mUsed != null && st.bars15mUsed < 40)
      ? 'read from ' + st.bars15mUsed + ' of 40 requested 15M bars — degraded'
      : 'Read from 15M bars';
    parts.push(readNote + ' up to ' + st.barCloseIST + ' IST ('
      + ageText(st.dataAgeMinutes) + ') — check that candle against your chart.');
  }
  return parts.join(' ');
}

function describeConfirm(st) {
  switch (st.confirmation) {
    case 'confirmed': return (st.structure1h === 'bullish' ? 'HH-HL' : 'LL-LH') + ', which CONFIRMS it';
    case 'disagrees': return (st.structure1h === 'bullish' ? 'HH-HL' : 'LL-LH')
      + ', which DISAGREES — these are 15M-only trades';
    case 'unclear':   return 'unclear, so it does not confirm — these are 15M-only trades';
    default:          return 'unavailable, not read — these are 15M-only trades';
  }
}

// Named individually when any is down. "3 of 4" tells him something is wrong;
// only the name tells him which timeframe he is blind on.
function watcherText(st) {
  if (!st.totalCount) return 'No engulf watchers are registered.';
  if (st.armedCount === st.totalCount) {
    return 'All ' + st.totalCount + ' engulf watchers armed (' + st.armedLabels.join(', ') + ').';
  }
  if (st.armedCount === 0) return 'WARNING: NO engulf watchers are running — nothing is being monitored.';
  return 'WARNING: only ' + st.armedCount + ' of ' + st.totalCount + ' watchers armed — '
    + st.missingWatchers.join(', ') + ' ' + (st.missingWatchers.length === 1 ? 'is' : 'are') + ' DOWN.';
}

module.exports = { buildStatus, buildHeadline, buildEvidence, STALE_AFTER_MINUTES };
