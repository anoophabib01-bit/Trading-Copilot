'use strict';
/**
 * live-status.js — the pure renderer for `sessions/Now.md`.
 *
 * WHY THIS EXISTS, AND WHY IT IS A REWRITE AND NOT AN APPEND
 * ----------------------------------------------------------
 * Task 7.1 proposed appending a live event log into the day's session note.
 * The /autoplan review (2026-08-23) killed it for four separate reasons, and
 * every one of them is a design constraint on this file:
 *
 *   1. `logTrade()` locates the trades table by regex and rewrites the whole
 *      note. A second writer on that file risks the audited one. -> This file
 *      writes `Now.md`, NEVER the session note.
 *   2. `fs.appendFileSync` CREATES a missing file, and `logTrade()` only builds
 *      its template when the file is absent — so an append that lands first
 *      permanently breaks trade logging for that day. -> Nothing here ever
 *      touches a path `logTrade()` owns.
 *   3. An append-only log grows all session, and Obsidian does not auto-scroll,
 *      so the newest line ends up below the fold — unreadable at a glance,
 *      which was the entire point. -> Fixed-size, current state at the TOP.
 *   4. Obsidian holds whole-file buffers and saves them back (observed live:
 *      it rewrote four tracked docs minutes after the vault opened). -> This
 *      file is a PROJECTION of state held elsewhere, never a record. If
 *      Obsidian clobbers it, the next tick regenerates it and nothing is lost.
 *      Never treat `Now.md` as data; the ledger and the session note are the
 *      records.
 *
 * Pure: no fs, no Date.now(), no rules retyped. Every number arrives via the
 * `state` argument, read by the caller from `rules.json` and the live feed —
 * so this module cannot drift out of sync with the rulebook (CLAUDE.md's
 * rules-are-data convention).
 */

/** Events worth a line. Anything not listed is dropped — fail-closed. */
const RECENT_EVENT_CAP = 8;

/** Fixed glyph set. Five, deliberately — a sixth makes it decoration. */
const GLYPH = {
  block:    '🛑',   // a refusal — the event this whole feature exists for
  decision: '◆',    // debate verdict, trade ticket
  phase:    '⚡',   // PO3 transition
  signal:   '·',    // monitor detection
  position: '▸',    // open / close / scale
};

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/**
 * ms -> HH:MM:SS in IST, without pulling in a date library. Seconds are kept
 * on EVENT rows because the trades table carries seconds too, and correlating
 * a block against a trade row after the session is the main use.
 */
function istClock(ms) {
  if (!Number.isFinite(ms)) return '--:--:--';
  const d = new Date(ms + 330 * 60 * 1000);
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}

/**
 * ms -> HH:MM in IST, for the HEADER only.
 *
 * Deliberately coarser than istClock. The caller skips the write when the
 * rendered text is byte-identical to the last one; with seconds in the header
 * the text differs on every single tick, so that check could never fire and
 * the file would be rewritten every 5s forever. Obsidian re-renders on each
 * file event, so that is a pane flickering in his peripheral vision all
 * session — a real cost during live trading, for no information.
 *
 * At minute resolution the file rewrites when something ACTUALLY changes
 * (P&L, position, a new event) and otherwise at most once a minute, which is
 * still fresh enough to prove the surface is alive.
 */
function istClockShort(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  const d = new Date(ms + 330 * 60 * 1000);
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

/** $1,234.50 / -$85.00 — a plain thousands grouper, no Intl dependency. */
function money(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const neg = n < 0;
  const fixed = Math.abs(n).toFixed(2);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + grouped + '.' + frac;
}

/**
 * A markdown table cell must not contain a raw pipe or newline — one unescaped
 * `|` from a model-generated reason breaks the table from that row down. Also
 * hard-capped, so a long Judge rationale cannot blow out the column widths.
 */
function cell(s, max = 62) {
  let t = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim();
  if (t.length > max) t = t.slice(0, max - 1) + '…';
  return t;
}

/**
 * Which loss tier the day's P&L currently sits in. Tiers arrive from
 * rules.json via `state`; they are never written down here.
 * Returns { label, hit } where `hit` is the worst tier breached, or null.
 */
function lossTierStatus(dayPnl, tiers) {
  if (!tiers || typeof dayPnl !== 'number') return { line: '—', hit: null };
  const order = [['hard', '⛔'], ['red', '🔴'], ['yellow', '🟡']];
  const parts = order
    .filter(([k]) => typeof tiers[k] === 'number')
    .map(([k, g]) => g + ' ' + money(tiers[k]));
  let hit = null;
  for (const [k] of order) {
    if (typeof tiers[k] === 'number' && dayPnl <= tiers[k]) { hit = k; break; }
  }
  return { line: parts.join('   ') || '—', hit };
}

/**
 * Render the whole file. Always returns a complete document — never a partial
 * one, because the caller writes it atomically and a torn projection on the
 * second monitor is worse than a stale one.
 *
 * @param {object} state
 * @param {number} nowMs  injected so tests are deterministic
 * @returns {string}
 */
function renderNowMarkdown(state, nowMs) {
  const s = state || {};
  const feed = s.feed || {};
  const rules = s.rules || {};
  const watchers = s.watchers || {};
  const recent = Array.isArray(s.recent) ? s.recent : [];

  // 2026-08-24: `pnl` and `tradeCount` are now handed in pre-resolved by the
  // caller (tv-broker-feed's effectiveDayPnl/effectiveTradeCount) rather than
  // read raw off the feed state. This surface is what he actually had on
  // screen when it read -$154.20 against the broker's real +$399.70, so it
  // must not do its own arithmetic — it renders the one number the rest of
  // the app enforces on, and says where that number came from.
  const pnl = s.pnl || {};
  const dayPnl = typeof pnl.value === 'number' ? pnl.value
    : (typeof feed.dayPnl === 'number' ? feed.dayPnl : null);
  const tier = lossTierStatus(dayPnl, rules.dailyLossTiers);

  const tvUp = watchers.tvConnected === true;
  const header = tvUp ? '● LIVE' : '○ TV OFFLINE';

  const out = [];
  out.push('# ' + header + '  ·  ' + istClockShort(nowMs) + ' IST  ·  ' + String(s.mode || '?').toUpperCase());
  out.push('');
  out.push('> Projection of live state, rewritten whole every tick. **Not a record** —');
  out.push('> the session note and the signal ledger are. Safe to close or ignore.');
  out.push('');

  // ── Account ──
  out.push('## Account');
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  // 2026-08-24: Net Liq (the broker's own account figure, matching the EQUITY
  // column he reads) in preference to balanceAtLastFlat, which came from the
  // header strip and drifts on its own between trades.
  // 2026-08-24 CORRECTED same day: the header balance, not Net Liq. Net Liq
  // comes from the summary table, which was observed frozen for 70 minutes
  // while the header tracked the broker's own export exactly. See
  // tv-broker-feed.js's readBrokerPnl correction note.
  const bal = typeof feed.brokerHeaderBalance === 'number' ? feed.brokerHeaderBalance
    : typeof feed.brokerNetLiq === 'number' ? feed.brokerNetLiq
    : feed.balanceAtLastFlat;
  out.push('| Balance | ' + money(bal) + ' |');
  out.push('| Day P&L | **' + money(dayPnl) + '**' +
           // Provenance inline, not in a footnote. "broker" means this is the
           // account panel's own session total, open P&L included, and should
           // tie out to what Tradovate shows. "estimated" means the summary
           // panel was unreadable and this is the balance-delta fold, which
           // only covers trades this instance watched close — a number to
           // treat as a floor, not as the truth.
           (pnl.source === 'fold' ? ' _(estimated — broker panel unreadable)_'
            : pnl.stale ? ' _(⚠ panel is BEHIND by ~' + money(pnl.staleBy) + ' — click Account Summary in the broker panel)_'
            : '') + ' |');
  // Split realized vs open only when a position is actually running: on a
  // flat account the two lines would say the same thing twice.
  if (typeof pnl.open === 'number' && pnl.open !== 0) {
    out.push('| ├ realized | ' + money(pnl.realized) + ' |');
    out.push('| └ open | ' + money(pnl.open) + ' |');
  }
  const tradeCount = s.tradeCount || {};
  const tc = tradeCount.value != null ? tradeCount.value
    : (feed.tradeCount != null ? feed.tradeCount : null);
  out.push('| Trades | ' + (tc != null ? tc : '—') +
           (rules.tradesPerDay != null ? ' / ' + rules.tradesPerDay : '') +
           // A count carrying fill-edge-only evidence is advisory, and saying
           // so is the difference between him stopping and him wondering why
           // the app thinks he has traded twice as much as he has.
           (tradeCount.evidence === 'degraded' ? ' _(provisional)_' : '') + ' |');
  out.push('| Size cap | ' + (rules.sizeCap != null ? rules.sizeCap : '—') + ' |');
  out.push('');

  // ── Loss tiers ──
  out.push('## Loss tiers');
  out.push('');
  out.push(tier.line);
  out.push('');
  out.push(tier.hit
    ? '**' + tier.hit.toUpperCase() + ' TIER BREACHED** — ' + money(dayPnl)
    : 'Current: ' + money(dayPnl) + ' — clear');
  out.push('');

  // ── Position ──
  out.push('## Position');
  out.push('');
  // G28 (2026-09-15): UNREADABLE is its own answer. The broker's positions table can
  // render its empty-state placeholder while a position is really open (measured live
  // 2026-09-14), and printing FLAT there is the single most dangerous line this page can
  // show: it is the page Anoop glances at. Say what is actually known.
  out.push(s.positionsUnreadable
    ? '**UNREADABLE** — broker positions table is not rendering (a position may be open)'
    : (s.position ? cell(s.position) : 'FLAT'));
  out.push('');

  // ── Watchers ──
  out.push('## Watchers');
  out.push('');
  if (!Array.isArray(watchers.rows) || !watchers.rows.length) {
    out.push('_no watcher data_');
  } else {
    const mark = { healthy: '✅', amber: '🟠', red: '🔴', 'tv-offline': '○', stopped: '✗' };
    out.push(watchers.rows.map(r => (mark[r.health] || '?') + ' ' + cell(r.label || r.id, 24)).join('  '));
  }
  out.push('');

  // ── Recent ──
  out.push('## Recent');
  out.push('');
  if (!recent.length) {
    out.push('_nothing yet this session_');
  } else {
    out.push('| Time | | Event | Detail |');
    out.push('|---|---|---|---|');
    for (const e of recent.slice(-RECENT_EVENT_CAP).reverse()) {
      out.push('| ' + istClock(e && e.ts) +
               ' | ' + (GLYPH[e && e.kind] || '·') +
               ' | ' + cell(e && e.label, 18) +
               ' | ' + cell(e && e.detail) + ' |');
    }
  }
  out.push('');

  return out.join('\n');
}

module.exports = { renderNowMarkdown, istClock, istClockShort, money, cell, lossTierStatus, GLYPH, RECENT_EVENT_CAP };
