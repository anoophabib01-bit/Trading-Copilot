'use strict';
/* ── pattern-memory-store.js — the disk half of the pattern memory ───────────
 * 2026-09-03. pattern-memory.js decides what counts as an episode and what a
 * repeat means; it never touches a file. This module owns the ledger on disk
 * and the one-time backfill from records that already exist.
 *
 * Split for the same reason week-rollup/week-store and lifetime-history/
 * lifetime-store are split: the rules are the part worth testing exhaustively
 * and should not need a temp directory to exercise.
 *
 * THE LEDGER — DATA/pattern_memory/episodes.jsonl
 * ----------------------------------------------
 * Append-only, one episode per line, never rewritten. Same doctrine as
 * chat-archive.js: this is the record that lets the app say "eleventh time,
 * $4,180" instead of "you are oversized", and a store that trims is a store
 * that eventually cannot say the second thing.
 *
 * Episode ids are deterministic (pattern-memory.js's tradeEpisodeId /
 * dayEpisodeId), so `sync` can be run as often as you like: it diffs what the
 * records now imply against what is already on the ledger and appends only the
 * difference. That is what makes it safe to call on every startup and after
 * every closed trade.
 *
 * WHY THE LEDGER IS DERIVED, NOT AUTHORED
 * ---------------------------------------
 * Every episode is computed from day_trades/gr_history — records that already
 * existed and are written by other paths. Nothing here is the only copy of
 * anything, so a corrupt ledger is recoverable by deleting it and re-syncing.
 * The one thing that would NOT be recoverable is a hand-written episode, which
 * is exactly why there is no API for adding one.
 *
 * A LATER CORRECTION WINS. day_trades rows get repaired (broker reconciliation,
 * repair-split-exit-rows.js), so the same episode id can legitimately reappear
 * with different numbers. Every version is appended; readers fold by id and
 * keep the last. Never throws — this is memory, not a feature, and a disk
 * problem must not take a live session down with it.
 */

const fs = require('fs');
const path = require('path');
const pm = require('./pattern-memory');

const DIR_NAME = 'pattern_memory';
const LEDGER_FILE = 'episodes.jsonl';
const SCHEMA_VERSION = 1;

function dirFor(dataDir) { return path.join(dataDir, DIR_NAME); }
function ledgerPath(dataDir) { return path.join(dirFor(dataDir), LEDGER_FILE); }

/** Every line on the ledger, in write order, tolerant of a torn tail. */
function readRaw(dataDir) {
  let text = '';
  try { text = fs.readFileSync(ledgerPath(dataDir), 'utf8'); }
  catch (e) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j && j.id) out.push(j); }
    catch (e) { /* a crash mid-append costs one line, never the ledger */ }
  }
  return out;
}

/** The ledger as a reader should see it: one entry per id, latest version. */
function readLedger(dataDir) {
  const byId = new Map();
  for (const e of readRaw(dataDir)) byId.set(e.id, e);
  return Array.from(byId.values()).sort(function (a, b) {
    if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
    return (Number(a.tradeIndex) || 0) - (Number(b.tradeIndex) || 0);
  });
}

function append(dataDir, episodes) {
  const out = { ok: false, written: 0, error: null };
  try {
    const list = (episodes || []).filter(Boolean);
    if (!list.length) { out.ok = true; return out; }
    fs.mkdirSync(dirFor(dataDir), { recursive: true });
    const now = new Date().toISOString();
    const lines = list.map(function (e) {
      return JSON.stringify(Object.assign({ v: SCHEMA_VERSION, recordedAt: now }, e));
    }).join('\n') + '\n';
    fs.appendFileSync(ledgerPath(dataDir), lines, 'utf8');
    out.written = list.length;
    out.ok = true;
  } catch (e) { out.error = e.message; }
  return out;
}

/**
 * Bring the ledger up to date with the records on disk, and say what CHANGED.
 *
 * The `added` list is the whole point: it is what the caller announces. On a
 * cold backfill it is hundreds of historical episodes and nothing should be
 * announced (see `silent`); after one closed trade it is the one or two
 * episodes that trade just produced.
 *
 * @param {string} dataDir
 * @param {object} sources  { tradesByDay, days, rules } — lifetime-store shapes
 * @returns {{ok, added: Episode[], total: number, error: string|null}}
 */
function sync(dataDir, sources) {
  const res = { ok: false, added: [], total: 0, error: null };
  try {
    const implied = pm.buildEpisodes({
      tradesByDay: (sources && sources.tradesByDay) || {},
      days: (sources && sources.days) || [],
      rules: (sources && sources.rules) || {},
    });
    const existing = readLedger(dataDir);
    const seen = new Map(existing.map(function (e) { return [e.id, e]; }));

    const added = implied.filter(function (e) {
      const prev = seen.get(e.id);
      if (!prev) return true;
      // A repaired trade row can change an episode's numbers under the same
      // id. Re-append so the correction is on the record; readers fold to it.
      return Number(prev.cost || 0) !== Number(e.cost || 0)
          || Number(prev.pnl || 0) !== Number(e.pnl || 0)
          || Number(prev.size || 0) !== Number(e.size || 0);
    });

    if (added.length) {
      const w = append(dataDir, added);
      if (!w.ok) { res.error = w.error; return res; }
    }
    res.added = added;
    res.total = implied.length;
    res.ok = true;
  } catch (e) { res.error = e.message; }
  return res;
}

/** Episodes recorded for one trading day. */
function episodesForDay(dataDir, date) {
  return readLedger(dataDir).filter(function (e) { return e.date === date; });
}

function stats(dataDir) {
  const led = readLedger(dataDir);
  const dates = Array.from(new Set(led.map(function (e) { return e.date; }))).filter(Boolean).sort();
  let bytes = 0;
  try { bytes = fs.statSync(ledgerPath(dataDir)).size; } catch (e) {}
  return {
    episodes: led.length,
    revisions: readRaw(dataDir).length,
    days: dates.length,
    firstDay: dates[0] || null,
    lastDay: dates[dates.length - 1] || null,
    kinds: pm.summarize(led).length,
    bytes,
  };
}

module.exports = {
  DIR_NAME, LEDGER_FILE, SCHEMA_VERSION,
  dirFor, ledgerPath,
  readRaw, readLedger, append, sync, episodesForDay, stats,
};
