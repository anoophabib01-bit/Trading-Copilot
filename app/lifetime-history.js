'use strict';
/* ── lifetime-history.js — one continuous record across every account ────────
 *
 * (2026-08-31, Anoop: "build a lifetime view that reads across all five slots
 * plus account_archives.json and gives one continuous record, with the
 * per-account boundaries marked so a fresh eval never again looks like deleted
 * history.")
 *
 * THE PROBLEM THIS FIXES. Every history surface in the app — Journal, Insights,
 * Week, Ladder — reads the localStorage keys in ACCT_LS_KEYS, and those keys are
 * swapped wholesale when the active slot changes. So starting a fresh eval makes
 * the entire app look wiped: on 2026-08-31 he opened a new 50K, and the Week tab
 * showed W33/W34/W35 as "—" while 10 traded days sat untouched in
 * DATA/accounts/s1/. Nothing was lost. Nothing was visible either.
 *
 * WHAT THIS MODULE IS. A pure merge over two kinds of source:
 *   LIVE     DATA/accounts/<slot>/{gr_history,day_trades,balance_ledger,ck_history}.json
 *   ARCHIVED DATA/account_archives.json — each record carries a full `ls`
 *            snapshot with those same stores, frozen at archive time.
 * It returns ONE date-sorted spine with per-day provenance, plus the account
 * boundaries, so a fresh account reads as a new chapter rather than an empty book.
 *
 * ── THE THREE DECISIONS THAT MATTER ─────────────────────────────────────────
 *
 * 1. THE SPINE IS THE TRADING DAY, NOT THE SNAPSHOT. A day happened once in
 *    reality. It can appear in many snapshots: on 2026-08-31 the range
 *    2026-08-17..08-28 existed in live s1 AND in four separate archive records,
 *    and 08-17..08-21 ALSO appeared inside an earlier "Account 1 EVAL" archive
 *    whose clear had not actually wiped gr_history. Concatenating sources would
 *    have shown some days five times and inflated lifetime P&L fivefold. So the
 *    output is keyed by date, and every source that claimed that date is listed
 *    in `sources` rather than becoming another row.
 *
 * 2. DISAGREEMENT IS REPORTED, NEVER RESOLVED SILENTLY. When two snapshots claim
 *    the same date with different numbers, this does NOT pick a winner behind his
 *    back. It picks the richest one for display (most trades, then latest
 *    snapshot), sets `conflict: true`, and records what the others said in
 *    `conflictDetail`. week-rollup.js already established this rule with
 *    `disagreeDays`, and it earned its place: the first time it ran it found
 *    balance_ledger silently under-charging commission. A merge that quietly
 *    averages or last-write-wins would hide exactly that class of bug.
 *
 * 3. ACCOUNT IDENTITY IS DERIVED, BECAUSE accountId IS NULL EVERYWHERE. Neither
 *    meta.json nor any archive record carries a usable accountId (all null as of
 *    2026-08-31). Identity is therefore (slot + label), and a lineage's span is
 *    derived from the days attributed to it. This is a heuristic and is labelled
 *    as one — `identityBasis: 'derived'` ships in the output so a caller can say
 *    so on screen instead of implying a certainty the data does not support.
 *    If a real accountId is ever populated, prefer it: see accountKeyOf().
 *
 * DUPLICATE ARCHIVES ARE COLLAPSED, AND COUNTED. Clicking "breached" four times
 * wrote four near-identical records within three minutes. They are folded into
 * one account and the count is reported as `duplicateArchives` — visible, not
 * tidied away, because a duplicate archive means an archive flow misfired.
 *
 * PURE. No fs, no clock, no globals — buildLifetime() in lifetime-store.js does
 * the IO and hands plain objects here. Everything below is unit-tested in
 * test/lifetime-history.test.js.
 */

/** Parse a value that may be a JSON string (archive `ls` blobs) or already parsed. */
function coerce(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
}

/** YYYY-MM-DD only. Anything else is not a trading day and must not become a row. */
function isDateKey(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/**
 * Stable key for one real-world account.
 * Prefers a genuine accountId if one is ever written; falls back to slot+label,
 * which is what today's data actually supports.
 */
function accountKeyOf(src) {
  if (src && src.accountId) return 'id:' + String(src.accountId);
  const slot = String((src && (src.slot || src.slotId)) || '?');
  return 'sl:' + slot + '|' + (normalizeLabel(src && src.label) || '(unlabelled)');
}

/**
 * Label normalisation, and why it is load-bearing.
 *
 * The live store and the archive store name the SAME account differently:
 * meta.json calls it "Tradify 01" while the archive record calls it
 * "Tradify 01 EVAL". Keyed on the raw strings they split into two accounts —
 * which on real data (2026-08-31) produced a phantom 0-day "Tradify 01 EVAL
 * (breached)" alongside a "Tradify 01 (active)" that had actually breached. The
 * breach event ended up attached to the empty half.
 *
 * So the stage suffix is stripped before comparing. Stage is tracked in its own
 * field; it is not part of an account's identity, because an account keeps its
 * identity when it converts from eval to funded.
 */
function normalizeLabel(label) {
  return String(label || '')
    .trim().toLowerCase()
    .replace(/\s*[-—|]\s*/g, ' ')
    .replace(/\s+(eval|evaluation|funded|live|pa|xa)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalise one source (a live slot or one archive record) into a common shape.
 * `kind` is 'live' | 'archive'. `at` is the archive timestamp (ms) or null for live.
 */
function normalizeSource(src) {
  const ls = src.ls || {};
  // A live slot hands stores directly; an archive hands them as JSON strings
  // under the localStorage key names.
  const gr = coerce(src.gr_history != null ? src.gr_history : ls.copilot_gr_history, []) || [];
  const trades = coerce(src.day_trades != null ? src.day_trades : ls.copilot_day_trades, {}) || {};
  const ledger = coerce(src.balance_ledger != null ? src.balance_ledger : ls.copilot_balance_ledger, {}) || {};
  const checks = coerce(src.ck_history != null ? src.ck_history : ls.copilot_ck_history, []) || [];
  let atMs = null;
  if (src.archivedAt) { const t = Date.parse(src.archivedAt); if (Number.isFinite(t)) atMs = t; }
  return {
    key: accountKeyOf(src),
    kind: src.kind === 'archive' ? 'archive' : 'live',
    slot: String(src.slot || src.slotId || '?'),
    label: src.label || null,
    stage: src.stage || src.mode || null,
    size: src.size || null,
    event: src.event || null,
    status: src.status || null,
    archivedAt: src.archivedAt || null,
    atMs,
    days: Array.isArray(gr) ? gr.filter(d => d && isDateKey(d.date)) : [],
    trades: trades && typeof trades === 'object' ? trades : {},
    ledger: ledger && typeof ledger === 'object' ? ledger : {},
    checks: Array.isArray(checks) ? checks : [],
  };
}

/**
 * Richness score — decides which snapshot of a contested day is DISPLAYED.
 * Deliberately not "latest wins": a later archive taken after a reset can hold a
 * hollowed-out version of a day (archive record 4 on 2026-08-29 had zero days
 * while records 1-3 held ten). Trade count first, then recency as a tiebreak.
 */
function richness(day, source) {
  const n = num(day && day.n);
  const at = source && source.atMs ? source.atMs : 0;
  // Live has no archive timestamp but is the most current writer, so it sorts
  // above equally-rich archived copies.
  const liveBonus = source && source.kind === 'live' ? 1 : 0;
  return { n, at, liveBonus };
}

function richer(a, b) {
  if (a.n !== b.n) return a.n > b.n;
  if (a.liveBonus !== b.liveBonus) return a.liveBonus > b.liveBonus;
  return a.at > b.at;
}

/** Do two day-rows disagree on anything a human would care about? */
function daysDisagree(a, b) {
  const f = (d) => [num(d.n), Math.round(num(d.pnl) * 100), num(d.maxSize), num(d.wins), num(d.losses)].join('|');
  return f(a) !== f(b);
}

/**
 * THE MERGE.
 * @param {Array} rawSources  live slots and archive records, any order
 * @returns {{days:Array, accounts:Array, boundaries:Array, conflicts:Array, stats:Object}}
 */
function mergeLifetime(rawSources) {
  const sources = (Array.isArray(rawSources) ? rawSources : [])
    .filter(Boolean)
    .map(normalizeSource);

  // ── Collapse sources into accounts (lineages) ────────────────────────────
  const accountsByKey = new Map();
  sources.forEach((s) => {
    let acct = accountsByKey.get(s.key);
    if (!acct) {
      acct = {
        key: s.key, slot: s.slot, label: s.label, stage: s.stage, size: s.size,
        status: s.status, event: null, archivedAt: null,
        snapshots: 0, live: false, archived: false,
        firstDate: null, lastDate: null, days: 0, net: 0,
        identityBasis: s.key.startsWith('id:') ? 'accountId' : 'derived',
      };
      accountsByKey.set(s.key, acct);
    }
    acct.snapshots++;
    if (s.kind === 'live') acct.live = true; else acct.archived = true;
    // The terminal event (breached/cleared) comes from the LATEST archive.
    if (s.kind === 'archive' && s.event && (acct.archivedAt == null || (s.atMs || 0) >= Date.parse(acct.archivedAt || 0))) {
      acct.event = s.event;
      acct.archivedAt = s.archivedAt;
    }
    if (!acct.label && s.label) acct.label = s.label;
    if (!acct.stage && s.stage) acct.stage = s.stage;
    if (!acct.size && s.size) acct.size = s.size;
  });

  // ── Build the day spine ──────────────────────────────────────────────────
  // One entry per real trading day. Contested days keep the richest copy and
  // record what the losers said.
  const byDate = new Map();
  sources.forEach((s) => {
    s.days.forEach((day) => {
      const date = day.date;
      const score = richness(day, s);
      const claim = {
        accountKey: s.key, slot: s.slot, label: s.label,
        kind: s.kind, archivedAt: s.archivedAt,
        n: num(day.n), pnl: num(day.pnl),
      };
      const existing = byDate.get(date);
      if (!existing) {
        byDate.set(date, { date, row: day, score, owner: s.key, claims: [claim], conflict: false, conflictDetail: [] });
        return;
      }
      existing.claims.push(claim);
      if (daysDisagree(existing.row, day)) {
        existing.conflict = true;
        existing.conflictDetail.push({
          from: s.label || s.slot, kind: s.kind,
          n: num(day.n), pnl: num(day.pnl), maxSize: num(day.maxSize),
        });
      }
      if (richer(score, existing.score)) {
        // The previously-displayed row becomes a recorded alternative, so
        // swapping the winner never loses the evidence for the swap.
        if (daysDisagree(existing.row, day)) {
          existing.conflictDetail.push({
            from: existing.row.__from || 'previous', kind: 'superseded',
            n: num(existing.row.n), pnl: num(existing.row.pnl), maxSize: num(existing.row.maxSize),
          });
        }
        existing.row = day; existing.score = score; existing.owner = s.key;
      }
    });
  });

  const days = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((d) => Object.assign({}, d.row, {
      date: d.date,
      accountKey: d.owner,
      accountLabel: (accountsByKey.get(d.owner) || {}).label || null,
      slot: (accountsByKey.get(d.owner) || {}).slot || null,
      sources: d.claims,
      conflict: d.conflict,
      conflictDetail: d.conflict ? d.conflictDetail : [],
    }));

  // ── Attribute span + totals back to each account ─────────────────────────
  days.forEach((d) => {
    const acct = accountsByKey.get(d.accountKey);
    if (!acct) return;
    if (!acct.firstDate || d.date < acct.firstDate) acct.firstDate = d.date;
    if (!acct.lastDate || d.date > acct.lastDate) acct.lastDate = d.date;
    acct.days++;
    acct.net += num(d.pnl);
  });

  // Mark the day an account ENDED with how it ended. The calendar renders a
  // breach darker red and a clear brighter green than an ordinary losing or
  // winning day, because those two days are not just another result — they are
  // the day an account died or paid out, and they should be findable at a glance
  // months later. Only the account's LAST traded day carries this; a breach is
  // an event, not a property of the whole account.
  days.forEach((d) => {
    const acct = accountsByKey.get(d.accountKey);
    if (acct && acct.event && acct.lastDate === d.date) {
      d.accountEvent = acct.event;                 // 'breached' | 'cleared'
      d.accountEventLabel = acct.label || acct.slot || null;
    }
  });

  const accounts = [...accountsByKey.values()]
    .map((a) => Object.assign({}, a, { net: Math.round(a.net * 100) / 100 }))
    .sort((a, b) => {
      // Accounts with no traded days sort last; otherwise chronological.
      if (!a.firstDate && !b.firstDate) return 0;
      if (!a.firstDate) return 1;
      if (!b.firstDate) return -1;
      return a.firstDate < b.firstDate ? -1 : a.firstDate > b.firstDate ? 1 : 0;
    });

  // ── Boundaries: where the account changes as you walk the spine ──────────
  // These are what stop a fresh eval from reading as deleted history: the UI
  // draws a marker here instead of an unexplained gap.
  const boundaries = [];
  let prev = null;
  days.forEach((d) => {
    if (prev && d.accountKey !== prev.accountKey) {
      const from = accountsByKey.get(prev.accountKey) || {};
      const to = accountsByKey.get(d.accountKey) || {};
      boundaries.push({
        atDate: d.date,
        afterDate: prev.date,
        fromLabel: from.label || from.slot || null,
        fromEvent: from.event || null,
        fromNet: Math.round(num(from.net) * 100) / 100,
        toLabel: to.label || to.slot || null,
        toSlot: to.slot || null,
      });
    }
    prev = d;
  });

  const conflicts = days.filter((d) => d.conflict)
    .map((d) => ({ date: d.date, kept: { n: num(d.n), pnl: num(d.pnl) }, others: d.conflictDetail }));

  const duplicateArchives = [...accountsByKey.values()]
    .reduce((acc, a) => acc + Math.max(0, a.snapshots - (a.live ? 2 : 1)), 0);

  return {
    days,
    accounts,
    boundaries,
    conflicts,
    stats: {
      sources: sources.length,
      liveSlots: sources.filter((s) => s.kind === 'live').length,
      archives: sources.filter((s) => s.kind === 'archive').length,
      duplicateArchives,
      accounts: accounts.length,
      tradedDays: days.length,
      firstDate: days.length ? days[0].date : null,
      lastDate: days.length ? days[days.length - 1].date : null,
      net: Math.round(days.reduce((a, d) => a + num(d.pnl), 0) * 100) / 100,
      trades: days.reduce((a, d) => a + num(d.n), 0),
      conflictDays: conflicts.length,
      identityBasis: accounts.every((a) => a.identityBasis === 'accountId') ? 'accountId' : 'derived',
    },
  };
}

/**
 * Merge the per-day trade lists the same way, so the Journal can show real
 * trades across accounts. Keyed by date; the account that owns the day (per the
 * spine above) decides whose trade list is authoritative, which keeps the trade
 * list consistent with the day row shown beside it.
 */
function mergeTrades(rawSources, days) {
  const sources = (Array.isArray(rawSources) ? rawSources : []).filter(Boolean).map(normalizeSource);
  const ownerByDate = new Map((days || []).map((d) => [d.date, d.accountKey]));
  const out = {};
  sources.forEach((s) => {
    Object.keys(s.trades || {}).forEach((date) => {
      if (!isDateKey(date)) return;
      const owner = ownerByDate.get(date);
      // Days present in day_trades but absent from gr_history have no owner —
      // keep the first sighting rather than dropping a real trading day.
      if (owner && owner !== s.key) return;
      if (out[date] && owner) return;
      const list = Array.isArray(s.trades[date]) ? s.trades[date] : [];
      out[date] = list.map((t) => Object.assign({}, t, {
        __accountKey: s.key, __slot: s.slot, __accountLabel: s.label || null,
      }));
    });
  });
  return out;
}

/**
 * Merge the per-day balance ledger. Same ownership rule as mergeTrades: the
 * account that owns the day owns its ledger entry, so the ledger can never
 * describe a different account's day than the row rendered beside it.
 */
function mergeLedger(rawSources, days) {
  const sources = (Array.isArray(rawSources) ? rawSources : []).filter(Boolean).map(normalizeSource);
  const ownerByDate = new Map((days || []).map((d) => [d.date, d.accountKey]));
  const out = {};
  sources.forEach((s) => {
    Object.keys(s.ledger || {}).forEach((date) => {
      if (!isDateKey(date)) return;
      const owner = ownerByDate.get(date);
      if (owner && owner !== s.key) return;
      if (out[date] && owner) return;
      out[date] = s.ledger[date];
    });
  });
  return out;
}

/**
 * Merge checklist history across accounts.
 *
 * Deduped on (date + completedAtMs) rather than date alone: a checklist is a
 * per-session artifact and he can legitimately complete more than one in a day
 * (2026-08-31 had a pre-session check on the old account and another on the new
 * one). Keying on date would silently delete the second — which on that date is
 * precisely the record showing he re-checked before switching accounts.
 */
function mergeChecks(rawSources, days) {
  const sources = (Array.isArray(rawSources) ? rawSources : []).filter(Boolean).map(normalizeSource);
  const ownerByDate = new Map((days || []).map((d) => [d.date, d.accountKey]));
  const seen = new Set();
  const out = [];
  sources.forEach((s) => {
    (s.checks || []).forEach((c) => {
      if (!c || !isDateKey(c.date)) return;
      const id = c.date + '|' + (c.completedAtMs || c.completedAt || '') + '|' + (c.score != null ? c.score : '');
      if (seen.has(id)) return;
      seen.add(id);
      const owner = ownerByDate.get(c.date);
      out.push(Object.assign({}, c, {
        __accountKey: owner || s.key,
        __slot: s.slot,
        __accountLabel: s.label || null,
      }));
    });
  });
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

module.exports = {
  mergeLifetime,
  mergeTrades,
  mergeLedger,
  mergeChecks,
  normalizeLabel,
  // exported for tests / reuse
  accountKeyOf,
  normalizeSource,
  daysDisagree,
  isDateKey,
};
