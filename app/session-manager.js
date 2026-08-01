'use strict';
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = 'G:\\MNQ-CoPilot\\sessions';

function ensureDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function sessionPath(date) {
  return path.join(SESSIONS_DIR, `${date}.md`);
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
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

  fs.writeFileSync(p, content, 'utf8');
  return { path: p, existed: false };
}

function logTrade(date, trade) {
  ensureDir();
  const dateStr = date || todayStr();
  const p = sessionPath(dateStr);

  if (!fs.existsSync(p)) {
    startSession(dateStr, {});
  }

  let content = fs.readFileSync(p, 'utf8');

  // Count existing trade rows
  const rows = (content.match(/^\|\s*\d+\s*\|/gm) || []);
  const num = rows.length + 1;

  const row = `| ${num} | ${trade.time || new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} | ${trade.direction || '?'} | ${trade.entry || '?'} | ${trade.stop || '?'} | ${trade.target || '?'} | ${trade.exit || '-'} | ${trade.pnl !== undefined ? '$' + trade.pnl : '-'} | ${trade.breakTaken ? 'Yes' : 'No'} | ${trade.notes || ''} |`;

  content = content.replace(
    /(\| # \| Time.*\n\|---.*\n)/,
    `$1${row}\n`
  );

  fs.writeFileSync(p, content, 'utf8');
  return { num, path: p };
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

  fs.writeFileSync(p, content, 'utf8');
  return true;
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

module.exports = { startSession, logTrade, updateVerdict, readSession, listSessions, todayStr, sessionPath, SESSIONS_DIR };
