'use strict';
const fs = require('fs');
const path = require('path');
const atomicWrite = require('./atomic-write');

// Renamed 2026-09-18. Anchor on app/server.js so a stray empty folder of the
// new name cannot capture the session history -- splitting session notes away
// from the ledger would silently break the week rollup and the dashboard.
const SESSIONS_DIR = (function () {
  const fs = require('fs');
  const path = require('path');
  const roots = ['G:\\Trading-CoPilot', 'G:\\MNQ-CoPilot'];
  for (let i = 0; i < roots.length; i++) {
    try { if (fs.existsSync(path.join(roots[i], 'app', 'server.js'))) return path.join(roots[i], 'sessions'); } catch (e) {}
  }
  return 'G:\\MNQ-CoPilot\\sessions';
})();

function ensureDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function sessionPath(date) {
  return path.join(SESSIONS_DIR, `${date}.md`);
}

// 2026-08-20 BUG FIX (found in review, never observed live but reachable every
// night): this returned the UTC date while every other day boundary in this
// app is IST wall-clock (CLAUDE.md: "Timestamps/session windows are IST"). The
// two disagree for the 5.5 hours between 00:00 and 05:30 IST — which straddles
// the NY session close. A trade closing at 01:00 IST on the 21st would append
// its row to the 20th's session file, while the live feed's own IST day had
// already rolled over and reset the count to 0. That mismatch only became
// load-bearing when the feed started auto-logging closed trades (it previously
// only mattered for a manual click, made by a human who knew what day it was).
function todayStr() {
  const IST_OFFSET_MS = 330 * 60 * 1000;
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function startSession(date, { balance, floor, buffer, bias, keyLevel, goNoGo, reason, physical }) {
  ensureDir();
  const dateStr = date || todayStr();
  const p = sessionPath(dateStr);

  // Don't overwrite an existing session
  if (fs.existsSync(p)) {
    return { path: p, existed: true };
  }

  const content = `# Session — ${dateStr} | NY 7:00 PM IST

## Pre-Session
- Balance: $${balance || '?'} | Floor: $${floor || '?'} | Buffer: $${buffer || '?'}
- Bias: ${bias || 'TBD'} based on 4H
- Key level: ${keyLevel || 'TBD'}
- GO/NO-GO: ${goNoGo || 'PENDING'} — reason: ${reason || ''}
- Physical state: [meal ${physical?.meal ? '✓' : '✗'}] [nap ${physical?.nap ? '✓' : '✗'}] [phone down ${physical?.phone ? '✓' : '✗'}]

## Trades
| # | Time (IST) | Direction | Entry | Stop | Target | Exit | P&L | 15m break? | Notes |
|---|---|---|---|---|---|---|---|---|---|

## Session Verdict
- System compliance:
- Patterns triggered:
- Best decision:
- Worst decision:
- One thing to fix tomorrow:

## Next Session
- Bias:
- Level to watch:
- Rule focus:
`;

  // 2026-08-23: same silent-write hole as logTrade — see its comment. A
  // failure here matters more than it looks: logTrade only builds this
  // template when the file is ABSENT, so a silently-failed startSession
  // leaves a note with no trades-table header and every later logTrade for
  // that day returns {ok:false}.
  const w = atomicWrite.writeAtomic(p, content, 'utf8');
  if (!w.ok) return { path: p, existed: false, ok: false, reason: 'write failed: ' + (w.error || 'unknown') };
  return { path: p, existed: false, ok: true };
}

function logTrade(date, trade) {
  ensureDir();
  const dateStr = date || todayStr();
  const p = sessionPath(dateStr);

  if (!fs.existsSync(p)) {
    startSession(dateStr, {});
  }

  let content = fs.readFileSync(p, 'utf8');

  // 2026-08-23 BUG FIX (found by review, never observed live). This counted
  // `^| <digits> |` across the WHOLE file with /gm, not just the trades
  // table. Any other line in the note matching that shape — a second table,
  // a pasted log line, an event row — inflated every subsequent trade number
  // silently. Scoped to the contiguous row block under the table header.
  const num = countTradeRows(content) + 1;

  const row = formatTradeRow(num, trade);

  // 2026-08-20 BUG FIX (found in review, two defects in one line). The old
  // implementation was:
  //     content.replace(/(\| # \| Time.*\n\|---.*\n)/, `$1${row}\n`)
  //
  //   1. It numbered rows ASCENDING (rows.length + 1) but inserted each one
  //      immediately after the header — so the newest trade sat at the TOP
  //      carrying the HIGHEST number, and trade 1 was at the bottom. Reading
  //      the table top-to-bottom gave reverse chronology with forward
  //      numbering, and manual entries interleaved with auto ones into
  //      nonsense. Tolerable when a human clicked "Log trade" a few times a
  //      day; not once the live feed writes a row on every close.
  //   2. If the regex did not match — the header was hand-edited, the `---`
  //      separator reformatted, anything — `replace` returned the string
  //      UNCHANGED, the file was rewritten identically, and the function still
  //      returned {num, path} as though it had succeeded. The trade vanished
  //      with no error and no throw, so the caller's try/catch never fired.
  //
  // Now: locate the header, walk past the rows already under it, and insert
  // there (true append, chronological). Report failure honestly instead of
  // silently discarding a trade.
  const next = insertTradeRow(content, row);
  if (next === null) {
    return { ok: false, written: false, path: p, reason: 'trade table header not found — session file may have been hand-edited' };
  }

  // 2026-08-23 BUG FIX (found by review). The return value was discarded and
  // {ok:true} returned unconditionally. writeAtomic reports {ok:false} only
  // when BOTH the atomic rename and the plain-write fallback throw — on
  // Windows that is what an Obsidian / OneDrive / Defender handle on the .md
  // produces as EPERM/EBUSY. The 2026-08-20 fix below made the regex-miss
  // failure honest and left this one silent, so a trade could be dropped
  // while the caller was told it was written.
  const w = atomicWrite.writeAtomic(p, next, 'utf8');
  if (!w.ok) {
    return { ok: false, written: false, path: p, reason: 'write failed: ' + (w.error || 'unknown') };
  }
  return { ok: true, written: true, num, path: p };
}

// The pure row formatter, extracted 2026-08-23 so the breakTaken fix below is
// testable without the hardcoded SESSIONS_DIR (same extract-the-decision
// pattern as insertTradeRow). `nowTimeStr` is injected so tests are
// deterministic; production leaves it undefined and gets the IST clock.
//
// 2026-08-23 BUG FIX (found by review, visible in every auto-logged row on
// disk). The break cell was `trade.breakTaken ? 'Yes' : 'No'`, so an
// UNOBSERVED value rendered as 'No' — asserting a discipline failure that was
// never measured, in the one column the post-session review grades compliance
// on. The live feed never sets breakTaken, so every auto-logged row carried a
// false compliance record. Unknown is now '?', matching the convention the
// other unobserved fields in this same row already use.
function formatTradeRow(num, trade, nowTimeStr) {
  const t = trade || {};
  const time = t.time || nowTimeStr ||
    new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const breakCell = (t.breakTaken === undefined || t.breakTaken === null)
    ? '?'
    : (t.breakTaken ? 'Yes' : 'No');
  return `| ${num} | ${time} | ${t.direction || '?'} | ${t.entry || '?'} | ${t.stop || '?'} | ${t.target || '?'} | ${t.exit || '-'} | ${t.pnl !== undefined ? '$' + t.pnl : '-'} | ${breakCell} | ${t.notes || ''} |`;
}

// The pure half of the row count, exported for the same reason insertTradeRow
// is: testable without the hardcoded SESSIONS_DIR. Counts only the numbered
// rows in the contiguous block under the trades-table header — never the
// whole file. Returns 0 when the table cannot be located, which makes the
// caller's next row number 1 rather than an arbitrary file-wide tally.
function countTradeRows(content) {
  if (typeof content !== 'string') return 0;
  const header = content.match(/^\| # \| Time.*\n\|[-|: \t]+\n/m);
  if (!header) return 0;
  let at = header.index + header[0].length;
  let n = 0;
  for (;;) {
    const nl = content.indexOf('\n', at);
    const line = content.slice(at, nl === -1 ? content.length : nl);
    if (!line.startsWith('|')) break;
    if (/^\|\s*\d+\s*\|/.test(line)) n++;
    if (nl === -1) break;
    at = nl + 1;
  }
  return n;
}

// The pure half of logTrade, exported so the insert position and the
// failure case are testable without the hardcoded SESSIONS_DIR (same
// extract-the-decision pattern as checklist-logic.js / tv-broker-feed.js).
// Returns the new file content, or null when the table can't be located —
// null means "refused to write", never "wrote nothing and called it success".
function insertTradeRow(content, row) {
  if (typeof content !== 'string' || typeof row !== 'string') return null;
  // NOTE the separator class is [-|: \t] and NOT [-\s|:] — \s matches
  // newlines, so the greedy match swallowed the BLANK LINE after the
  // separator and the row was inserted outside the table, which breaks it
  // as markdown (a blank line terminates a table). Caught by this module's
  // own test, not live.
  const header = content.match(/^\| # \| Time.*\n\|[-|: \t]+\n/m);
  if (!header) return null;
  let insertAt = header.index + header[0].length;
  // Skip the contiguous block of existing data rows so the new row lands last.
  for (;;) {
    const nl = content.indexOf('\n', insertAt);
    const line = content.slice(insertAt, nl === -1 ? content.length : nl);
    if (!line.startsWith('|')) break;
    if (nl === -1) { insertAt = content.length; break; }
    insertAt = nl + 1;
  }
  return content.slice(0, insertAt) + row + '\n' + content.slice(insertAt);
}

function updateVerdict(date, { compliance, patterns, best, worst, fix, nextBias, nextLevel, nextFocus }) {
  const dateStr = date || todayStr();
  const p = sessionPath(dateStr);
  if (!fs.existsSync(p)) return false;

  let content = fs.readFileSync(p, 'utf8');

  if (compliance) content = content.replace(/- System compliance:.*/, `- System compliance: ${compliance}`);
  if (patterns) content = content.replace(/- Patterns triggered:.*/, `- Patterns triggered: ${patterns}`);
  if (best) content = content.replace(/- Best decision:.*/, `- Best decision: ${best}`);
  if (worst) content = content.replace(/- Worst decision:.*/, `- Worst decision: ${worst}`);
  if (fix) content = content.replace(/- One thing to fix tomorrow:.*/, `- One thing to fix tomorrow: ${fix}`);
  if (nextBias) content = content.replace(/- Bias:\s*$/, `- Bias: ${nextBias}`);
  if (nextLevel) content = content.replace(/- Level to watch:\s*$/, `- Level to watch: ${nextLevel}`);
  if (nextFocus) content = content.replace(/- Rule focus:\s*$/, `- Rule focus: ${nextFocus}`);

  // 2026-08-23: same silent-write hole as logTrade — see its comment.
  const w = atomicWrite.writeAtomic(p, content, 'utf8');
  return !!w.ok;
}

function readSession(date) {
  const dateStr = date || todayStr();
  const p = sessionPath(dateStr);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function listSessions() {
  ensureDir();
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, 30);
}

module.exports = { startSession, logTrade, insertTradeRow, countTradeRows, formatTradeRow, updateVerdict, readSession, listSessions, todayStr, sessionPath, SESSIONS_DIR };
