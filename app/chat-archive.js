'use strict';
/* ── chat-archive.js — the append-only record of everything said in chat ─────
 * 2026-09-03. Anoop: "i want all the data that comes on the chat to be saved
 * as it comes because i want all the details to be part of the memory of the
 * app."
 *
 * WHAT WAS ACTUALLY BEING SAVED BEFORE THIS FILE
 * ----------------------------------------------
 * One thing, and it was a rolling window, not a record:
 *
 *   renderer/app.js:5795   state.messages.slice(-40)      <- context cap
 *   renderer/resilience.js persists THAT SAME ARRAY to DATA/chat_transcript.json
 *
 * The 40-turn cap is correct where it lives — it stops the model's context
 * bloating. The bug is that the DISK MIRROR inherited it. chat_transcript.json
 * is a whole-file overwrite of the last 40 turns, so turn 41 does not age out
 * of context, it is DELETED FROM DISK. On 2026-09-03 that file held exactly 40
 * messages for a machine that has been running this app since July.
 *
 * Worse, it only ever held role:'user' and role:'assistant'. Everything else
 * that appears in the chat pane reached no store at all:
 *   - addSystemMessage()  — 111 call sites, including every watcher detection,
 *                           every guardrail alarm, every FALLBACK warning
 *   - trade ticket cards  — the actual GO decisions, with the size he confirmed
 *   - debate / Judge / PO3 / post-session blocks rendered as their own rows
 * The Judge and Post-Session reviews go to DATA/reviews/ (saveReviewRecord in
 * server.js) which is why THAT gap was already known. Nothing covered the rest.
 *
 * And nothing ever read chat_transcript.json back. Not one call site. A
 * write-only log is not memory — it is a file that makes you think you have a
 * record. That is the specific thing this replaces.
 *
 * WHY JSONL, APPEND-ONLY, ONE FILE PER TRADING DAY
 * -----------------------------------------------
 * reviews/ rewrites a whole JSON array on every save. That is fine at a dozen
 * verdicts a day and wrong here: chat produces hundreds of rows a session, and
 * a rewrite-per-row means the entire day's record is in flight on every write
 * — one bad write loses the lot. An appended line cannot corrupt the lines
 * already on disk, and a crash mid-append costs the tail line only (readDayRaw
 * skips an unparseable line rather than failing the file).
 *
 * NEVER capped, NEVER trimmed, NEVER rewritten. That is the whole point. If
 * this file ever grows a retention policy, read the paragraph above first.
 *
 * REVISIONS, NOT DUPLICATES
 * -------------------------
 * A chat row is not final when it appears — an assistant bubble streams in
 * token by token, and a ticket card changes when it is confirmed. The capture
 * side (renderer/chat-archive.js) therefore re-emits a row as it settles,
 * carrying the SAME `id` and a higher `seq`. Every revision is kept on disk
 * (an append-only log does not go back and edit), and the readers fold by id
 * keeping the highest seq. So the file is the full history including partials,
 * and a reader sees each row once, finished.
 *
 * Pure w.r.t. the app: takes a dataDir, touches nothing global, throws nothing
 * at the caller. A logging failure must never break a live trading session —
 * same doctrine as call-logger.js.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const DIR_NAME = 'chat_archive';

// A single row can legitimately be enormous (a pasted broker export, a
// post-session review). This ceiling exists only so one runaway row cannot
// write gigabytes; it is deliberately far above any real message.
const MAX_TEXT = 200000;
// Bound on one append CALL, not on the store. Stops a malformed client
// flooding the disk in a single message; the outbox retries the rest.
const MAX_BATCH = 500;

const IST_OFF = 330 * 60 * 1000;

// Trading-day stamp, NOT calendar date — same 03:45 IST rollover as
// server.js's tradingDayStampIST and renderer/app.js's csvParseTrades. A
// message sent at 00:40 IST belongs to the session that began the previous
// evening; filing it under the next calendar day would split one session's
// conversation across two files.
function tradingDayStamp(nowMs) {
  const ist = new Date((nowMs != null ? nowMs : Date.now()) + IST_OFF);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (mins < 3 * 60 + 45) ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}

function istTimeOf(ms) {
  try {
    return new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  } catch (e) {
    return new Date(ms + IST_OFF).toISOString().slice(11, 19);
  }
}

function archiveDir(dataDir) { return path.join(dataDir, DIR_NAME); }
function dayPath(dataDir, day) { return path.join(archiveDir(dataDir), day + '.jsonl'); }

function isDayKey(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function clip(s) {
  const t = String(s == null ? '' : s);
  if (t.length <= MAX_TEXT) return t;
  return t.slice(0, MAX_TEXT) + '\n…[truncated: ' + (t.length - MAX_TEXT) + ' more chars]';
}

// The client's own clock stamps the record, so a row captured while the
// socket was down keeps the time it actually happened rather than the time
// the outbox drained. Anything implausible falls back to server-now — a
// wrong clock must not scatter today's conversation into 1970 or 2049.
function resolveTs(clientTs, nowMs) {
  const n = Number(clientTs);
  if (!Number.isFinite(n)) return nowMs;
  if (Math.abs(n - nowMs) > 24 * 60 * 60 * 1000) return nowMs;
  return n;
}

/**
 * Normalise one client-supplied row into the stored record. The server owns
 * every field the client has no business asserting (time bucket, slot, mode).
 */
function buildRecord(raw, ctx) {
  const nowMs = (ctx && ctx.nowMs) || Date.now();
  const ts = resolveTs(raw && raw.clientTs, nowMs);
  const rec = {
    v: SCHEMA_VERSION,
    id: String((raw && raw.id) || ('m-' + ts + '-' + Math.random().toString(36).slice(2, 8))),
    seq: Number.isFinite(Number(raw && raw.seq)) ? Number(raw.seq) : 0,
    ts: new Date(ts).toISOString(),
    istTime: istTimeOf(ts),
    tradingDay: tradingDayStamp(ts),
    slot: (ctx && ctx.slot) || null,
    mode: (ctx && ctx.mode) || null,
    role: String((raw && raw.role) || 'unknown'),
    classes: String((raw && raw.classes) || ''),
    text: clip(raw && raw.text)
  };
  if (raw && raw.meta && typeof raw.meta === 'object') rec.meta = raw.meta;
  return rec;
}

/**
 * Append rows. Returns { ok, written, days }. Never throws: the caller is a
 * live WS handler and a disk problem must not take the chat down with it.
 */
function appendRecords(dataDir, rows, ctx) {
  const out = { ok: false, written: 0, days: [], error: null };
  try {
    const list = Array.isArray(rows) ? rows.slice(0, MAX_BATCH) : [];
    if (!list.length) { out.ok = true; return out; }

    // Group by trading day so a batch spanning the 03:45 rollover lands in
    // both files correctly, with one open/append per file rather than per row.
    const byDay = new Map();
    for (const raw of list) {
      const rec = buildRecord(raw, ctx);
      if (!rec.text && !rec.meta) continue;   // an empty row is not a record
      if (!byDay.has(rec.tradingDay)) byDay.set(rec.tradingDay, []);
      byDay.get(rec.tradingDay).push(rec);
    }

    fs.mkdirSync(archiveDir(dataDir), { recursive: true });
    for (const entry of byDay) {
      const day = entry[0], recs = entry[1];
      const lines = recs.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n';
      fs.appendFileSync(dayPath(dataDir, day), lines, 'utf8');
      out.written += recs.length;
      out.days.push(day);
    }
    out.ok = true;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

function listDays(dataDir) {
  try {
    return fs.readdirSync(archiveDir(dataDir))
      .filter(function (f) { return f.endsWith('.jsonl') && isDayKey(f.slice(0, -6)); })
      .map(function (f) { return f.slice(0, -6); })
      .sort();
  } catch (e) { return []; }
}

// Parse one day file. A torn final line (crash mid-append) is skipped, not
// treated as a corrupt file — losing one row must never cost the day.
function readDayRaw(dataDir, day) {
  if (!isDayKey(day)) return [];
  let text = '';
  try { text = fs.readFileSync(dayPath(dataDir, day), 'utf8'); }
  catch (e) { return []; }
  const out = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j === 'object') out.push(j);
    } catch (e) { /* torn or hand-edited line — skip it, keep the rest */ }
  }
  return out;
}

// Fold revisions: one entry per id, the highest seq wins (ties -> later line).
function foldById(records) {
  const byId = new Map();
  for (const r of records) {
    const id = r && r.id;
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev || Number(r.seq || 0) >= Number(prev.seq || 0)) byId.set(id, r);
  }
  return Array.from(byId.values()).sort(function (a, b) {
    return String(a.ts).localeCompare(String(b.ts));
  });
}

/** One trading day's conversation, in order, revisions folded. */
function readDay(dataDir, day) { return foldById(readDayRaw(dataDir, day)); }

/**
 * The most recent `limit` rows across days, OLDEST-FIRST (reading order).
 * Walks day files newest-first and stops as soon as it has enough, so a
 * six-month archive costs one file read to answer "what did we just say".
 */
function readRecent(dataDir, opts) {
  const limit = Math.max(1, Math.min(20000, (opts && opts.limit) || 60));
  const roleList = opts && Array.isArray(opts.roles) && opts.roles.length ? opts.roles : null;
  const roles = roleList ? new Set(roleList) : null;
  const days = listDays(dataDir).reverse();
  let out = [];
  for (const day of days) {
    let rows = readDay(dataDir, day);
    if (roles) rows = rows.filter(function (r) { return roles.has(r.role); });
    // Take from the end of this day, prepending so order stays chronological.
    const take = rows.slice(Math.max(0, rows.length - (limit - out.length)));
    out = take.concat(out);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Substring search, newest-first. Every term must appear (AND), case-
 * insensitive. Deliberately dumb: this is a recall aid over one person's own
 * chat history, not a search engine, and a dependency-free scan of a few
 * hundred KB is faster than anything that needs an index kept in sync.
 */
function search(dataDir, opts) {
  const q = String((opts && opts.query) || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(2000, (opts && opts.limit) || 20));
  const maxDays = Math.max(1, Math.min(3650, (opts && opts.days) || 120));
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const days = listDays(dataDir).reverse().slice(0, maxDays);
  const out = [];
  for (const day of days) {
    const rows = readDay(dataDir, day);
    for (let i = rows.length - 1; i >= 0; i--) {
      const hay = String(rows[i].text || '').toLowerCase();
      const hit = terms.every(function (t) { return hay.includes(t); });
      if (hit) {
        out.push(rows[i]);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function stats(dataDir) {
  const days = listDays(dataDir);
  let rows = 0, bytes = 0;
  for (const d of days) {
    try { bytes += fs.statSync(dayPath(dataDir, d)).size; } catch (e) {}
    rows += readDayRaw(dataDir, d).length;
  }
  return {
    days: days.length,
    firstDay: days[0] || null,
    lastDay: days[days.length - 1] || null,
    rows,
    bytes
  };
}

/**
 * Compact text rendering for an agent's context window. Roles are labelled in
 * words rather than by CSS class because the model reads this, not the DOM.
 */
const ROLE_LABEL = {
  user: 'ANOOP',
  assistant: 'AI',
  system: 'APP',
  ticket: 'TRADE TICKET',
  debate: 'DEBATE',
  judge: 'JUDGE',
  unknown: '?'
};

function formatForAgent(records, opts) {
  const perRow = Math.max(80, Math.min(4000, (opts && opts.perRow) || 700));
  if (!records || !records.length) return 'No archived chat found for that request.';
  return records.map(function (r) {
    const label = ROLE_LABEL[r.role] || String(r.role || '?').toUpperCase();
    let t = String(r.text || '').replace(/[ \t]+\n/g, '\n').trim();
    if (t.length > perRow) t = t.slice(0, perRow) + ' …[trimmed]';
    // A trade ticket's numbers live in form fields, not in its text. Dropping
    // them here would recall "there was a ticket" while losing the only detail
    // that matters about it — the size he was about to send.
    const f = r.meta && r.meta.fields;
    if (f) {
      const pairs = Object.keys(f).map(function (k) {
        // The DOM ids are "tc-<verdict-id>-size"; only the last segment says
        // anything to a reader.
        return k.split('-').pop() + '=' + f[k];
      });
      if (pairs.length) t += ' {' + pairs.join(', ') + '}';
    }
    if (r.meta && r.meta.seeded) t += ' [seeded from the old rolling transcript — timestamp is the save time, not the message time]';
    return '[' + r.tradingDay + ' ' + r.istTime + '] ' + label + ': ' + t;
  }).join('\n');
}

module.exports = {
  SCHEMA_VERSION, DIR_NAME, MAX_TEXT, MAX_BATCH,
  tradingDayStamp, istTimeOf, archiveDir, dayPath, isDayKey,
  resolveTs, buildRecord, appendRecords,
  listDays, readDayRaw, foldById, readDay, readRecent, search, stats,
  formatForAgent
};
