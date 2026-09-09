// cadx-status.js — turn the Playbook C (ADX) monitor's counters into a row the
// Chart Watchers panel can show.
//
// WHY THIS EXISTS (2026-09-03, Anoop asked for it)
// ---------------------------------------------------------------------------
// C-ADX is deliberately NOT in server.js's ALL_MONITORS: that list is the
// chart-watcher watchdog, every entry in it gets restarted when it stops
// reading the chart, and C-ADX reads no chart. The reasoning is right, but it
// had a side effect nobody chose — buildWatchersStatus() maps ALL_MONITORS and
// nothing else, so C-ADX appeared in neither the Chart Watchers panel nor
// sessions/Now.md. Its `cadxStats` counters were incremented on every tick and
// then read by NOTHING.
//
// So the one strategy in live forward test was the one strategy with no live
// surface at all. When its bar file went unwritten for 2.5 hours on 2026-09-03
// there was no way to tell whether that was a quiet market, a chart switched
// to MGC, a dead TradingView bridge or a stopped timer — which is the exact
// ambiguity the forward test's own §13 says must never be left open.
//
// This is a projection of counters, not a health check of its own: it reports
// what the monitor last did, and it must never claim more than that. In
// particular a status the monitor has not yet produced reads "starting up",
// never "healthy" — a green dot that means "no information" is worse than no
// dot, because it is the one a person stops checking.

'use strict';

// Health values reuse the panel's existing vocabulary (healthy / amber / red /
// tv-offline / stopped) so no new dot has to be invented; the human-readable
// half goes in `detail`, which the renderer prefers over its generic text.
const STATUS_TEXT = {
  'inactive':        { health: 'stopped',  text: 'shadow is OFF — running but recording nothing' },
  'not-mnq':         { health: 'stopped',  text: 'chart is not MNQ — idle (this strategy is MNQ-only)' },
  'tv-down':         { health: 'tv-offline', text: 'TradingView disconnected' },
  'order-in-flight': { health: 'healthy',  text: 'stood down — an order is being placed' },
  'fetch-failed':    { health: 'amber',    text: 'bar fetch FAILED on the last tick' },
  'no-bars':         { health: 'amber',    text: 'no bars returned on the last tick' },
  'merge-rejected':  { health: 'amber',    text: 'bar merge REJECTED — spacing or timeframe mismatch' },
  'no-signal':       { health: 'healthy',  text: 'watching — no setup on the last closed bar' },
  // The two that matter most, and the two that were invisible before this.
  'htf-blocked':     { health: 'healthy',  text: 'SETUP FOUND — held by the HTF gate (15M structure has no clean bias, or it reads the other way)' },
  'already-fired':   { health: 'healthy',  text: 'signal already recorded for this bar' },
  'signal':          { health: 'healthy',  text: '⚡ SIGNAL FIRED — setup armed and recorded' },
};

function hhmmss(ms, tz) {
  try { return new Date(ms).toLocaleTimeString('en-IN', { timeZone: tz || 'Asia/Kolkata', hour12: false }); }
  catch (e) { return '?'; }
}

/**
 * @param {object} o
 * @param {object} o.stats      the live cadxStats object
 * @param {boolean} o.running   is the interval timer up
 * @param {boolean} o.tvDown    bridge not ready / CDP not connected
 * @param {number} o.nowMs
 * @param {number} o.intervalMs the monitor's own tick interval
 * @param {number} o.minBars    warm-up requirement, for the short-history text
 * @returns {{id:string,label:string,running:boolean,health:string,lastCheck:(string|null),lastError:null,detail:string}}
 */
function cadxWatcherRow(o) {
  const opts = o || {};
  const st = opts.stats || {};
  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const interval = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 60000;
  const minBars = Number.isFinite(opts.minBars) ? opts.minBars : 120;

  const row = {
    id: 'c-adx',
    // G19: the timeframe comes from rules.json cfg.tfLabel, never a hardcoded
    // '30M' — the watcher has been running on the 1H for days while reporting 30M.
    label: 'Playbook C (ADX) ' + (opts.tfLabel || '1H'),
    running: !!opts.running,
    health: 'stopped',
    lastCheck: st.lastCheckAt ? new Date(st.lastCheckAt).toISOString() : null,
    lastError: null,
    detail: ''
  };

  if (!opts.running) {
    row.detail = 'monitor not running';
    return row;
  }
  if (opts.tvDown) {
    row.health = 'tv-offline';
    row.detail = 'waiting for TradingView';
    return row;
  }
  // No completed tick yet, or none recently. Reported as its own state rather
  // than folded into the last known status, because "the last thing it said"
  // stops being true the moment it stops saying anything.
  if (!st.lastCheckAt) {
    row.health = 'amber';
    row.detail = 'starting up — no completed check yet';
    return row;
  }
  const age = now - st.lastCheckAt;
  if (age > 3 * interval) {
    // No watchdog restarts this monitor (it is out of ALL_MONITORS by design),
    // so a stale C-ADX will NOT fix itself the way a chart watcher does. Said
    // plainly, because the amber dot means something different here.
    row.health = age > 10 * interval ? 'red' : 'amber';
    row.detail = 'STALE — no check in ' + Math.round(age / 1000) + 's (nothing restarts this one; reload or restart the server)';
    return row;
  }

  const raw = String(st.lastStatus || '');
  let mapped = STATUS_TEXT[raw];
  if (!mapped && raw.startsWith('short-history')) {
    const have = raw.split(':')[1] || '?';
    mapped = { health: 'healthy', text: 'warming up — ' + have + ' of ' + minBars + ' bars' };
  }
  if (!mapped) mapped = { health: 'amber', text: raw ? 'unrecognised status "' + raw + '"' : 'no status yet' };

  row.health = mapped.health;
  const bits = [mapped.text];
  bits.push('last check ' + hhmmss(st.lastCheckAt, opts.tz) + ' IST');
  if (Number.isFinite(st.bars) && st.bars > 0) bits.push(st.bars + ' bars');
  // Signals are the point of the whole exercise, so the count is always shown
  // — including the zero. "0 signals" is a real and expected reading here (the
  // strategy produces a tradeable one roughly every two months); leaving it out
  // when it is zero would hide the normal case and show only the rare one.
  bits.push((st.signals || 0) + ' signal' + ((st.signals || 0) === 1 ? '' : 's') + ' this run');
  if (st.lastSignalAt) bits.push('last signal ' + hhmmss(st.lastSignalAt, opts.tz) + ' IST');
  row.detail = bits.join(' · ');
  return row;
}

module.exports = { cadxWatcherRow, STATUS_TEXT };
