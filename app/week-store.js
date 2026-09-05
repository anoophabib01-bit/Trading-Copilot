'use strict';
/* ── week-store.js — persistence, commitments and the weekend markdown ───────
 *
 * (2026-08-29, Anoop: "i want to see this page every weekend to plan for my
 * upcoming week.")
 *
 * week-rollup.js computes. This module is everything that touches disk:
 *
 *   DATA/weekly/<slot>/<weekKey>.json   a FROZEN completed week
 *   DATA/weekly/<slot>/commitments.json what he promised, keyed by the week it applies TO
 *   DATA/weekly/doctrine.json           the 50K state-of-mind text (account-wide, not per slot)
 *   sessions/Week-<weekKey>-<slot>.md   the Obsidian-readable copy (slot-scoped
 *                                       since 2026-08-31 — one filename per week
 *                                       let an empty account overwrite a real one)
 *
 * WHY WEEKS ARE FROZEN. A completed week is a RECORD, unlike sessions/Now.md
 * which is a projection. Once frozen it stops tracking later repairs to
 * day_trades — which is the point: the week he reviewed on Saturday must still
 * say on the following Saturday what it said when he made a decision from it.
 * Re-deriving it live would let a Tuesday data fix silently rewrite the reason
 * he chose 2 lots. `frozenAt` and `sourceDrift` record when the freeze happened
 * and whether the stores have moved since, so a stale freeze is visible rather
 * than merely old.
 *
 * WHY THE DOCTRINE IS NOT REGENERATED. Anoop chose "fixed doctrine + weekly
 * delta" over a model-written mindset section. A mindset that is rewritten
 * every Saturday is not an anchor; it is just another opinion. This module
 * stores the doctrine verbatim and never touches it — only he edits it. The
 * "delta" half is computed in week-rollup and rendered beside it.
 *
 * COMMITMENTS ARE GRADED ONLY WHERE THEY ARE MACHINE-CHECKABLE. maxSize,
 * trades/day and the stop-the-week number are checked against the stores. The
 * free-text focus item is NOT auto-graded and is reported as self-assessed —
 * the same discipline armed-detectors.js applies by refusing free-form
 * conditions. A grade the app cannot actually verify is a lie with a tick next
 * to it.
 */
const fs = require('fs');
const path = require('path');
const atomicWrite = require('./atomic-write');
const WR = require('./week-rollup');

function readJson(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fallback; }
}
function writeJson(fp, obj) {
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    atomicWrite.writeAtomic(fp, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) { console.error('[week-store] write failed', fp, e.message); return false; }
}
function safeSlot(slot) { return /^[a-zA-Z0-9_\-]+$/.test(String(slot || '')) ? String(slot) : 's1'; }
function safeWeekKey(k) { return /^\d{4}-W\d{2}$/.test(String(k || '')) ? String(k) : null; }

function weeklyDir(dataDir, slot) { return path.join(dataDir, 'weekly', safeSlot(slot)); }
function doctrinePath(dataDir) { return path.join(dataDir, 'weekly', 'doctrine.json'); }
function commitmentsPath(dataDir, slot) { return path.join(weeklyDir(dataDir, slot), 'commitments.json'); }
function frozenPath(dataDir, slot, weekKey) { return path.join(weeklyDir(dataDir, slot), weekKey + '.json'); }

// ── Building a week from the account's own stores ────────────────────────────

function accountDir(dataDir, slot) { return path.join(dataDir, 'accounts', safeSlot(slot)); }

/**
 * Read every store this account has and fold one week out of them.
 * Missing stores are treated as empty, never as an error: a fresh slot must
 * produce an honest empty week rather than throw on the tab's first open.
 */
function buildWeek(dataDir, slot, anyDateInWeek, todayKey, accountRules) {
  const dir = accountDir(dataDir, slot);
  const ckArr = readJson(path.join(dir, 'ck_history.json'), []) || [];
  const ckByDate = {};
  if (Array.isArray(ckArr)) ckArr.forEach(c => { if (c && c.date) ckByDate[c.date] = c; });
  const grDays = readJson(path.join(dir, 'gr_history.json'), []) || [];
  const tradesByDay = readJson(path.join(dir, 'day_trades.json'), {}) || {};
  return WR.rollupWeek(anyDateInWeek, {
    grDays: grDays,
    tradesByDay: tradesByDay,
    // A slot with NO records at all must not fall back to "no horizon known":
    // that disables the pre-history check entirely and credits every weekday as
    // restraint. The empty s2 account froze 2026-W35 reporting "held fire 5
    // days" for a week it had never traded — the same absence-as-virtue bug the
    // horizon exists to prevent, arriving through the one door left open.
    dataStart: dataStartOf(grDays, tradesByDay) || NO_RECORDS_HORIZON,
    ledger: readJson(path.join(dir, 'balance_ledger.json'), {}) || {},
    ckByDate: ckByDate,
    notesByDate: readJson(path.join(dir, 'notes.json'), {}) || {},
    account: accountRules || {},
    todayKey: todayKey
  });
}

/**
 * The earliest day this account has ANY record for. Days before it are
 * pre-history, not restraint — see rollupWeek's heldFire comment for the
 * "five days held fire in a week he wasn't using the app" bug this closes.
 * Returns null when there is no history at all, which disables the horizon
 * rather than treating everything as pre-history.
 */
// Sentinel horizon for an account with zero records: every real date is before
// it, so every day is pre-history and nothing can be scored as held fire.
const NO_RECORDS_HORIZON = '9999-12-31';

function dataStartOf(grDays, tradesByDay) {
  const keys = [];
  (Array.isArray(grDays) ? grDays : []).forEach(d => { if (d && d.date) keys.push(d.date); });
  Object.keys(tradesByDay || {}).forEach(k => {
    const rows = tradesByDay[k];
    if (Array.isArray(rows) && rows.length) keys.push(k);
  });
  if (!keys.length) return null;
  return keys.sort()[0];
}

/**
 * Every trade row this account has ever stored, flattened, oldest first.
 * Used by the adherence split, which needs ALL history — a single week almost
 * never holds enough clean trades for a with-vs-without comparison to mean
 * anything, and quoting an edge off six trades is worse than quoting none.
 */
function allRows(dataDir, slot) {
  const store = readJson(path.join(accountDir(dataDir, slot), 'day_trades.json'), {}) || {};
  const out = [];
  Object.keys(store).sort().forEach(d => {
    const rows = store[d];
    if (Array.isArray(rows)) rows.forEach(r => out.push(r));
  });
  return out;
}

// ── Doctrine ─────────────────────────────────────────────────────────────────

const DOCTRINE_DEFAULT = {
  text: '',
  updatedAt: null
};

function loadDoctrine(dataDir) {
  const d = readJson(doctrinePath(dataDir), null);
  if (!d || typeof d.text !== 'string') return Object.assign({}, DOCTRINE_DEFAULT);
  return d;
}

function saveDoctrine(dataDir, text, nowMs) {
  const d = { text: String(text == null ? '' : text), updatedAt: new Date(nowMs || Date.now()).toISOString() };
  return writeJson(doctrinePath(dataDir), d) ? d : null;
}

// ── Commitments ──────────────────────────────────────────────────────────────

/** Normalise whatever the UI sent into the only shape the grader understands. */
function normalizeCommitment(raw, weekKey, nowMs) {
  const c = raw || {};
  const posInt = v => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const negMoney = v => {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return null;
    return -Math.abs(n);                       // "-800" and "800" both mean a $800 stop
  };
  const setups = Array.isArray(c.allowedSetups)
    ? c.allowedSetups.filter(s => /^[A-Za-z0-9 _-]{1,24}$/.test(String(s))).map(String)
    : [];
  return {
    weekKey: safeWeekKey(weekKey),
    maxSize: posInt(c.maxSize),
    maxTradesPerDay: posInt(c.maxTradesPerDay),
    allowedSetups: setups,
    stopTheWeekAt: negMoney(c.stopTheWeekAt),
    focus: String(c.focus == null ? '' : c.focus).slice(0, 400),
    committedAt: new Date(nowMs || Date.now()).toISOString()
  };
}

function loadCommitments(dataDir, slot) {
  return readJson(commitmentsPath(dataDir, slot), {}) || {};
}

function loadCommitment(dataDir, slot, weekKey) {
  const k = safeWeekKey(weekKey);
  if (!k) return null;
  return loadCommitments(dataDir, slot)[k] || null;
}

function saveCommitment(dataDir, slot, weekKey, raw, nowMs) {
  const k = safeWeekKey(weekKey);
  if (!k) return null;
  const all = loadCommitments(dataDir, slot);
  const c = normalizeCommitment(raw, k, nowMs);
  all[k] = c;
  return writeJson(commitmentsPath(dataDir, slot), all) ? c : null;
}

/**
 * Did the week honour what was promised for it?
 * Only the checkable fields get a verdict. `focus` is returned as
 * selfAssessed:true with no pass/fail — the app cannot see whether he stopped
 * entering before London open, and pretending otherwise would put a green tick
 * on an unverified claim.
 */
function gradeCommitment(week, commitment) {
  if (!week || !commitment) return null;
  const checks = [];
  const b = week.behaviour;

  if (commitment.maxSize != null) {
    checks.push({
      key: 'maxSize',
      label: 'Max size ' + commitment.maxSize + ' lots',
      promised: commitment.maxSize,
      actual: b.maxSize,
      kept: b.maxSize <= commitment.maxSize,
      detail: b.maxSize <= commitment.maxSize
        ? 'Biggest position was ' + b.maxSize + '.'
        : 'Biggest position was ' + b.maxSize + ' — ' + (b.maxSize - commitment.maxSize) + ' over what you committed to.'
    });
  }

  if (commitment.maxTradesPerDay != null) {
    const over = week.days.filter(d => d.traded && d.n > commitment.maxTradesPerDay);
    checks.push({
      key: 'maxTradesPerDay',
      label: 'Max ' + commitment.maxTradesPerDay + ' trades/day',
      promised: commitment.maxTradesPerDay,
      actual: week.days.reduce((m, d) => Math.max(m, d.traded ? d.n : 0), 0),
      kept: over.length === 0,
      detail: over.length === 0
        ? 'Held on every trading day.'
        : 'Exceeded on ' + over.length + ' day(s): ' + over.map(d => d.date + ' (' + d.n + ')').join(', ') + '.'
    });
  }

  if (commitment.stopTheWeekAt != null) {
    checks.push({
      key: 'stopTheWeekAt',
      label: 'Stop the week at $' + Math.abs(commitment.stopTheWeekAt),
      promised: commitment.stopTheWeekAt,
      actual: week.money.net,
      kept: week.money.net >= commitment.stopTheWeekAt,
      detail: week.money.net >= commitment.stopTheWeekAt
        ? 'Week closed at ' + week.money.net + ', inside the line.'
        : 'Week closed at ' + week.money.net + ', through the line by ' + Math.round((commitment.stopTheWeekAt - week.money.net) * 100) / 100 + '.'
    });
  }

  const checkable = checks.length;
  const kept = checks.filter(c => c.kept).length;
  return {
    weekKey: commitment.weekKey,
    checks: checks,
    kept: kept,
    checkable: checkable,
    allKept: checkable > 0 && kept === checkable,
    focus: commitment.focus || null,
    focusSelfAssessed: !!commitment.focus,
    allowedSetups: commitment.allowedSetups || [],
    // Setup adherence is NOT graded: day_trades rows carry playbook:null on
    // every row in the current data, so any verdict here would be invented.
    setupsGradable: false,
    setupsNote: 'Setup adherence is not graded — trade rows do not carry a playbook tag yet, so the app cannot see which setup you actually traded.'
  };
}

// ── Freezing ─────────────────────────────────────────────────────────────────

function loadFrozen(dataDir, slot, weekKey) {
  const k = safeWeekKey(weekKey);
  if (!k) return null;
  return readJson(frozenPath(dataDir, slot, k), null);
}

function listFrozen(dataDir, slot) {
  try {
    return fs.readdirSync(weeklyDir(dataDir, slot))
      .filter(f => /^\d{4}-W\d{2}\.json$/.test(f))
      .map(f => f.replace(/\.json$/, ''))
      .sort();
  } catch { return []; }
}

/**
 * Freeze a completed week. Refuses to freeze an incomplete one — a week frozen
 * mid-Wednesday would be a permanent record of a partial week, and nothing
 * downstream could tell it apart from a real one.
 * Re-freezing an already-frozen week is allowed but PRESERVES the original
 * `frozenAt` and records the re-freeze, so an accidental overwrite is visible.
 */
function freezeWeek(dataDir, slot, week, findings, trend, nowMs) {
  if (!week || !week.complete) return null;
  const k = safeWeekKey(week.weekKey);
  if (!k) return null;
  const prior = loadFrozen(dataDir, slot, k);
  const payload = {
    weekKey: k,
    slot: safeSlot(slot),
    start: week.start,
    end: week.end,
    frozenAt: (prior && prior.frozenAt) || new Date(nowMs || Date.now()).toISOString(),
    refrozenAt: prior ? new Date(nowMs || Date.now()).toISOString() : null,
    refreezeCount: prior ? (Number(prior.refreezeCount) || 0) + 1 : 0,
    week: week,
    findings: findings || null,
    trend: trend || null
  };
  return writeJson(frozenPath(dataDir, slot, k), payload) ? payload : null;
}

// ── The weekend markdown ─────────────────────────────────────────────────────

function money(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const DOW_NAME = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Obsidian-readable copy of the week. Written whole, never appended — same
 * contract as sessions/Now.md. It is a projection of the frozen record, so
 * deleting it costs nothing.
 */
function renderWeekMarkdown(week, findings, trend, opts) {
  const o = opts || {};
  const b = week.behaviour, a = week.account, at = week.attribution;
  const L = [];

  L.push('# Week ' + week.weekKey + ' — ' + week.start + ' to ' + week.end);
  L.push('');
  L.push('> ' + (findings && findings.headline ? findings.headline : 'No verdict — no trades recorded.'));
  L.push('');
  L.push('**Net ' + money(week.money.net) + '**'
    + ' · ' + b.tradedDays + ' trading day(s)'
    + ' · ' + b.trades + ' trades'
    + ' · biggest size ' + b.maxSize
    + ' · ' + b.cleanDays + ' clean day(s)'
    + ' · held fire ' + b.heldFireDays + ' day(s)');
  L.push('');

  // Account picture — the number that ends the account, first.
  if (a.maxDrawdown) {
    L.push('## The account');
    L.push('');
    L.push('| | |');
    L.push('|---|---|');
    L.push('| Drawdown allowance | ' + money(a.maxDrawdown) + ' |');
    L.push('| Used this week | ' + money(a.drawdownUsedThisWeek) + ' (' + a.drawdownPctThisWeek + '%) |');
    if (week.money.worst) {
      L.push('| Worst single day | ' + week.money.worst.date + ' at ' + money(week.money.worst.net)
        + ' — ' + a.worstDayPctOfDrawdown + '% of the allowance |');
    }
    if (a.profitTarget) L.push('| Profit target | ' + money(a.profitTarget) + ' (week moved it ' + a.progressToTargetPct + '%) |');
    if (a.minTradingDays) L.push('| Min trading days | ' + a.minTradingDays + ' (traded ' + a.tradingDaysThisWeek + ' this week) |');
    L.push('');
  }

  // Day by day.
  L.push('## Day by day');
  L.push('');
  L.push('| Day | Date | Net | Trades | Max size | Breaches | Verdict | Checklist |');
  L.push('|---|---|---|---|---|---|---|---|');
  week.days.forEach(d => {
    if (d.future) return;
    const verdict = d.traded ? (WR.QUADRANT_LABEL[d.quadrant] || '—')
      : d.heldFire ? 'Held fire' : (d.isWeekend ? '—' : '—');
    L.push('| ' + DOW_NAME[d.dow] + ' | ' + d.date + ' | ' + (d.traded ? money(d.net) : '—')
      + ' | ' + (d.traded ? d.n : '—')
      + ' | ' + (d.traded ? d.maxSize : '—')
      + ' | ' + (d.traded ? d.breaches : '—')
      + ' | ' + verdict
      + ' | ' + (d.checklist ? d.checklist.tier + ' (' + d.checklist.score + ')' : '—') + ' |');
  });
  L.push('');

  // Where the money went.
  if (at.slices.length) {
    L.push('## Where the money went');
    L.push('');
    L.push('Each losing trade is blamed on its single worst breach (' + WR.SEVERITY.join(' > ') + '), so nothing is counted twice.');
    L.push('');
    L.push('| Cause | Loss | Share |');
    L.push('|---|---|---|');
    at.slices.forEach(s => L.push('| ' + s.label + ' | ' + money(s.loss) + ' | ' + s.pct + '% |'));
    L.push('');
    L.push('_Total losing trades ' + money(at.totalLoss) + ' across ' + at.losingRows + ' trades; '
      + at.coveragePct + '% could be attributed'
      + (at.unattributedRows ? ' (' + at.unattributedRows + ' row(s) had no flag data)' : '') + '._');
    L.push('');
  }

  // Mistakes and positives.
  if (findings) {
    L.push('## Major mistakes');
    L.push('');
    if (!findings.mistakes.length) L.push('_None flagged._');
    findings.mistakes.forEach((m, i) => {
      L.push((i + 1) + '. **' + m.title + '**  ');
      L.push('   ' + m.detail);
    });
    L.push('');
    L.push('## Positives');
    L.push('');
    if (!findings.positives.length) {
      L.push('_Nothing this week. Not a rendering gap — the week produced no clean day, no held-fire day and no earned day. This section fills itself in when there is something real to put in it._');
    }
    findings.positives.forEach((p, i) => {
      L.push((i + 1) + '. **' + p.title + '**  ');
      L.push('   ' + p.detail);
    });
    L.push('');
  }

  // Trend.
  if (trend && trend.length && trend.some(t => t.prev != null)) {
    L.push('## Versus last week');
    L.push('');
    L.push('| Metric | Last week | This week | |');
    L.push('|---|---|---|---|');
    trend.forEach(t => {
      if (t.prev == null) return;
      // `good === null` means NOT SCOREABLE (one of the weeks is unfinished or
      // empty), which is a different fact from "unchanged". Printing it as
      // "same" is how an untraded Monday came to read as a flat result rather
      // than as no result.
      const mark = t.good === true ? 'better' : t.good === false ? 'worse'
        : t.delta === 0 ? 'same' : 'not scored';
      L.push('| ' + t.label + ' | ' + (t.money ? money(t.prev) : t.prev) + ' | '
        + (t.money ? money(t.now) : t.now) + ' | ' + mark + ' |');
    });
    L.push('');
  }

  // Commitment kept?
  if (o.grade && o.grade.checkable) {
    L.push('## What you committed to for this week');
    L.push('');
    o.grade.checks.forEach(c => {
      L.push('- ' + (c.kept ? '**KEPT**' : '**BROKEN**') + ' — ' + c.label + '. ' + c.detail);
    });
    if (o.grade.focus) {
      L.push('- _Focus (self-assessed, not graded):_ ' + o.grade.focus);
    }
    L.push('');
  }

  // Doctrine + drift.
  if (o.doctrine && o.doctrine.text && o.doctrine.text.trim()) {
    L.push('## The 50K mind');
    L.push('');
    o.doctrine.text.split(/\r?\n/).forEach(line => L.push('> ' + line));
    L.push('');
    if (findings && findings.mistakes.length) {
      L.push('**Where you drifted from it this week:** ' + findings.mistakes.slice(0, 3).map(m => m.title).join('; ') + '.');
      L.push('');
    }
  }

  // Data honesty.
  if (week.money.reconcile.disagreeDays.length) {
    L.push('## Data note');
    L.push('');
    L.push('These days disagree across the three stores that should all say the same thing:');
    L.push('');
    week.money.reconcile.disagreeDays.forEach(d => {
      L.push('- **' + d.date + '** — balance_ledger ' + money(d.ledger)
        + ', gr_history ' + money(d.grHistory) + ', trade rows ' + money(d.rows));
    });
    L.push('');
    L.push('_' + week.money.reconcile.note + '_');
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('_Written whole by week-store.js. This file is a projection of '
    + 'DATA/weekly/' + safeSlot(o.slot) + '/' + week.weekKey + '.json, which is the record. '
    + 'Deleting this note costs nothing._');
  L.push('');
  return L.join('\n');
}

/** Write the markdown into the Obsidian vault (repo root `sessions/`). */
function writeWeekMarkdown(sessionsDir, week, findings, trend, opts) {
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    // SLOT-SCOPED (2026-08-31). Was 'Week-<key>.md', which is one filename for
    // every account: switching to slot s2 and auto-freezing overwrote the s1
    // note describing a -$1,392 week with an empty one. The frozen JSON was
    // always slot-scoped, so the RECORD survived and only this projection was
    // lost — but the projection is the half he actually reads.
    const fp = path.join(sessionsDir, 'Week-' + week.weekKey + '-' + safeSlot(opts && opts.slot) + '.md');
    atomicWrite.writeAtomic(fp, renderWeekMarkdown(week, findings, trend, opts), 'utf8');
    return fp;
  } catch (e) { console.error('[week-store] markdown write failed:', e.message); return null; }
}

/** One-line Telegram headline — deliberately short; the detail is in the tab. */
function telegramSummary(week, findings) {
  const b = week.behaviour, a = week.account;
  const L = [];
  L.push('WEEK ' + week.start + ' → ' + week.end + ' — ' + money(week.money.net));
  if (a.maxDrawdown && a.drawdownUsedThisWeek > 0) {
    L.push(a.drawdownPctThisWeek + '% of your drawdown allowance, in one week.');
  }
  if (findings && findings.headline) L.push(findings.headline);
  if (findings && findings.mistakes.length) {
    L.push('Biggest cause: ' + findings.mistakes[0].title + '.');
  }
  L.push('Clean days ' + b.cleanDays + '/' + b.tradedDays + ' · held fire ' + b.heldFireDays + '.');
  L.push('');
  L.push('Open the Week tab and commit next week\'s numbers.');
  return L.join('\n');
}

module.exports = {
  buildWeek, allRows, dataStartOf,
  loadDoctrine, saveDoctrine,
  loadCommitments, loadCommitment, saveCommitment, normalizeCommitment, gradeCommitment,
  freezeWeek, loadFrozen, listFrozen,
  renderWeekMarkdown, writeWeekMarkdown, telegramSummary,
  weeklyDir, frozenPath, commitmentsPath, doctrinePath
};
