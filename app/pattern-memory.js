'use strict';
/* ── pattern-memory.js — what keeps happening, and what it has cost ──────────
 * 2026-09-03. Anoop: "This memory should behave as the core to note mistakes
 * and positive trades now on and I need a new agent who lives inside this
 * memory who gives information when any mistake or positive trade is repeated
 * directly in chat... create a loop of information that has full capacity to
 * help me commit less mistakes and more positive trades."
 *
 * WHAT ALREADY EXISTED, AND THE ONE THING IT COULD NOT DO
 * ------------------------------------------------------
 * mistake-patterns.js (F1-F4) and armed-detectors.js already watch the live
 * feed and fire into chat. They are good at "this is happening right now".
 * They are structurally incapable of "this is the fourth time" — every one of
 * their fired-flags lives in tvBrokerFeedState, which is WIPED on the IST day
 * rollover. Today's oversize alert knows nothing about yesterday's.
 *
 * So the app could say "you are oversized" every single day for a month and
 * never once say "you have now done this on 11 of the last 19 trading days and
 * it has cost you $4,180". The second sentence is the one that changes
 * behaviour, and nothing in the app could form it.
 *
 * This module is the missing half: a durable EPISODE ledger keyed by what kind
 * of thing happened, so recurrence and cumulative cost are computable facts
 * rather than an impression.
 *
 * POSITIVES ARE FIRST-CLASS, NOT DECORATION
 * -----------------------------------------
 * Every existing detector is a failure detector. That is exactly the imbalance
 * JESSI_PERSONA's COACHING PROTOCOL was written to correct ("there is no
 * motivation... it should motivate me to keep calm") — and the fix there was a
 * PROCESS data section, which reads day-level rollups. Nothing has ever
 * recorded a single GOOD TRADE as an event worth repeating. A clean winner and
 * a clean loser are both process wins under his own doctrine ("a red day with
 * clean rules is a win"), and both are recorded here as episodes with the same
 * standing as a mistake.
 *
 * WHY A LOSS WITH NO FLAGS IS A POSITIVE
 * --------------------------------------
 * renderer/app.js's gradeTrade() awards one point each for size within cap, no
 * cooldown breach, inside a session window, and hold/news — so zero flags is
 * exactly grade A. A losing trade with zero flags means he took a valid setup
 * by his own rules and the market disagreed. Filing that as a failure is how
 * an app teaches someone that following the rules does not pay. It is filed
 * here as `disciplined-loss`.
 *
 * PURE. No fs, no clock of its own (every function that needs "now" is given
 * it), no app state. The disk half is pattern-memory-store.js — same split as
 * week-rollup/week-store and lifetime-history/lifetime-store, and for the same
 * reason: the rules about what counts as a repeat are the part worth testing
 * exhaustively, and they should not need a temp directory to exercise.
 */

// ── The vocabulary ──────────────────────────────────────────────────────────
// `label` is what a human reads. `source` cites where the signal comes from,
// because an episode that cannot be traced back to a real record is an
// accusation, not evidence. Severity orders interventions when a single trade
// trips several — see pickPrimary().
const KINDS = {
  // ── mistakes, per trade ───────────────────────────────────────────────────
  'oversize': {
    type: 'mistake', severity: 100,
    label: 'traded above the size cap',
    source: 'trade flag "oversize" (renderer/app.js gradeTrade: size > rules.sizeCap)'
  },
  'revenge': {
    type: 'mistake', severity: 95,
    label: 're-entered inside the cooldown after a loss',
    source: 'trade flag "revenge" (gradeTrade: entered while cooldown was active)'
  },
  'hold-exceeded': {
    type: 'mistake', severity: 60,
    label: 'held a scalp past the max hold',
    source: 'trade flag "hold-exceeded" (gradeTrade, scalper mode: hold > rules.maxHoldSeconds)'
  },
  'out-of-window': {
    type: 'mistake', severity: 55,
    label: 'traded outside a session window',
    source: 'trade flag "out-of-window" (gradeTrade vs rules.sessionWindowsIST)'
  },
  'news': {
    type: 'mistake', severity: 50,
    label: 'traded inside a news blackout',
    source: 'trade flag "news" (gradeTrade, standard mode)'
  },
  // ── mistakes, per day (shapes a single trade cannot show) ─────────────────
  'size-up-into-loss': {
    type: 'mistake', severity: 110,
    label: 'increased size while losing',
    source: 'gr_history.sizedUpIntoLoss for the day'
  },
  'overtrading': {
    type: 'mistake', severity: 90,
    label: 'took more trades than the daily cap allows',
    source: 'gr_history.n vs rules.tradesPerDay'
  },
  'traded-past-3-losses': {
    type: 'mistake', severity: 105,
    label: 'kept trading past three losses',
    source: 'gr_history.tradedPast3Losses for the day'
  },
  'giveback': {
    type: 'mistake', severity: 85,
    label: 'was up on the day and gave it back',
    source: 'gr_history.peak > 0 with a negative close'
  },
  // ── positives ────────────────────────────────────────────────────────────
  'clean-winner': {
    type: 'positive', severity: 40,
    label: 'a winning trade with every rule intact',
    source: 'trade with zero flags and positive P&L (grade A)'
  },
  'disciplined-loss': {
    type: 'positive', severity: 35,
    label: 'a losing trade taken correctly — process intact',
    source: 'trade with zero flags and negative P&L (grade A)'
  },
  'clean-day': {
    type: 'positive', severity: 45,
    label: 'a full day inside every rule',
    source: 'gr_history day with no over/revenge/size-up and discipline at or above the green bar'
  },
  'stopped-in-profit': {
    type: 'positive', severity: 48,
    label: 'closed the day green without pushing past the cap',
    source: 'gr_history day with positive P&L and trade count within the cap'
  },
};

// The discipline bar the Insights tab already calls green. Kept identical so
// "clean day" means the same thing in both places.
const GREEN_DISC = 70;

function kindInfo(kind) { return KINDS[kind] || null; }
function isMistake(kind) { const k = KINDS[kind]; return !!k && k.type === 'mistake'; }
function isPositive(kind) { const k = KINDS[kind]; return !!k && k.type === 'positive'; }

// ── Episode construction ────────────────────────────────────────────────────
// Deterministic ids. A backfill re-run over the same records must produce the
// same ids so it can append nothing rather than duplicating history — the
// ledger is append-only and has no way to take a duplicate back.
function tradeEpisodeId(kind, date, index) { return kind + '@' + date + '#' + index; }
function dayEpisodeId(kind, date) { return kind + '@' + date; }

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

/**
 * Episodes for ONE trade row (day_trades shape: {t,x,size,pnl,g,flags,side,...}).
 * A single trade can carry several mistakes at once — a 20-lot revenge entry is
 * genuinely two different failures and is recorded as two episodes, because
 * counting it once would understate whichever one you dropped.
 */
function tradeEpisodes(trade, ctx) {
  const t = trade || {};
  const date = (ctx && ctx.date) || '';
  const index = (ctx && ctx.index != null) ? ctx.index : 0;
  const flags = Array.isArray(t.flags) ? t.flags : [];
  const pnl = num(t.pnl);
  const out = [];

  const base = {
    date,
    at: num(t.x) || num(t.t) || 0,
    size: num(t.size),
    pnl,
    side: t.side || null,
    hold: t.hold != null ? num(t.hold) : null,
    grade: t.g || null,
    slot: t.__slot || (ctx && ctx.slot) || null,
    account: t.__accountLabel || (ctx && ctx.account) || null,
    tradeIndex: index,
  };

  for (const f of flags) {
    if (!KINDS[f]) continue;   // an unknown flag is not silently reinterpreted
    out.push({
      ...base,
      id: tradeEpisodeId(f, date, index),
      kind: f,
      type: 'mistake',
      // Cost is the damage this trade actually did. A rule-break that made
      // money still counts as an episode — see the JadeCap mechanism in
      // JESSI_PERSONA ("a broken rule that PAID costs more than any loss") —
      // but its cost is 0, not a negative number dressed up as harm.
      cost: pnl < 0 ? pnl : 0,
      profitedAnyway: pnl > 0,
    });
  }

  if (flags.length === 0) {
    const kind = pnl >= 0 ? 'clean-winner' : 'disciplined-loss';
    out.push({
      ...base,
      id: tradeEpisodeId(kind, date, index),
      kind,
      type: 'positive',
      gain: pnl > 0 ? pnl : 0,
      cost: pnl < 0 ? pnl : 0,
    });
  }

  return out;
}

/**
 * Episodes for one ROLLED-UP day (gr_history shape). These are the shapes no
 * single trade can show: escalation across trades, giving back a green day,
 * a whole day that stayed clean.
 */
function dayEpisodes(day, opts) {
  const d = day || {};
  const date = d.date || '';
  if (!date) return [];
  const rules = (opts && opts.rules) || {};
  const tradesPerDay = num(rules.tradesPerDay) || 0;
  const out = [];

  const base = {
    date,
    at: (opts && opts.at) || 0,
    pnl: num(d.pnl),
    trades: num(d.n),
    maxSize: num(d.maxSize),
    disc: num(d.disc),
    slot: d.slot || (opts && opts.slot) || null,
    account: d.accountLabel || (opts && opts.account) || null,
  };

  if (d.sizedUpIntoLoss === true) {
    out.push({ ...base, id: dayEpisodeId('size-up-into-loss', date), kind: 'size-up-into-loss', type: 'mistake', cost: base.pnl < 0 ? base.pnl : 0 });
  }
  if (d.tradedPast3Losses === true) {
    out.push({ ...base, id: dayEpisodeId('traded-past-3-losses', date), kind: 'traded-past-3-losses', type: 'mistake', cost: base.pnl < 0 ? base.pnl : 0 });
  }
  if (tradesPerDay > 0 && base.trades > tradesPerDay) {
    out.push({ ...base, id: dayEpisodeId('overtrading', date), kind: 'overtrading', type: 'mistake', over: base.trades - tradesPerDay, cap: tradesPerDay, cost: base.pnl < 0 ? base.pnl : 0 });
  }
  // Giveback only counts when he was genuinely UP and finished down. A day
  // that was never green has nothing to give back, and calling its drawdown
  // "giveback" would turn an ordinary losing day into a second accusation.
  if (num(d.peak) > 0 && base.pnl < 0) {
    out.push({ ...base, id: dayEpisodeId('giveback', date), kind: 'giveback', type: 'mistake', peak: num(d.peak), giveback: num(d.giveback), cost: base.pnl });
  }

  const clean = num(d.over) === 0 && num(d.revenge) === 0 && d.sizedUpIntoLoss !== true;
  if (clean && base.disc >= GREEN_DISC && base.trades > 0) {
    out.push({ ...base, id: dayEpisodeId('clean-day', date), kind: 'clean-day', type: 'positive', gain: base.pnl > 0 ? base.pnl : 0 });
  }
  if (base.pnl > 0 && base.trades > 0 && (tradesPerDay === 0 || base.trades <= tradesPerDay)) {
    out.push({ ...base, id: dayEpisodeId('stopped-in-profit', date), kind: 'stopped-in-profit', type: 'positive', gain: base.pnl });
  }

  return out;
}

/**
 * The whole ledger from the whole record. Used both for the one-time backfill
 * and to recompute a single day. Ordered oldest-first by date then trade.
 *
 * @param {object} input
 *   tradesByDay  {'YYYY-MM-DD': [tradeRow, ...]}  (lifetime-store's `trades`)
 *   days         [grHistoryRow, ...]
 *   rules        active rules (tradesPerDay is the only field read)
 */
function buildEpisodes(input) {
  const tradesByDay = (input && input.tradesByDay) || {};
  const days = (input && Array.isArray(input.days)) ? input.days : [];
  const rules = (input && input.rules) || {};
  const out = [];

  Object.keys(tradesByDay).sort().forEach(function (date) {
    const rows = tradesByDay[date] || [];
    rows.forEach(function (t, i) {
      tradeEpisodes(t, { date, index: i }).forEach(function (e) { out.push(e); });
    });
  });

  days.slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); })
    .forEach(function (d) {
      dayEpisodes(d, { rules }).forEach(function (e) { out.push(e); });
    });

  return out.sort(function (a, b) {
    if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
    return num(a.tradeIndex) - num(b.tradeIndex);
  });
}

// ── Recurrence ──────────────────────────────────────────────────────────────
/**
 * Everything the ledger knows about one kind. This is the object the agent
 * reasons from, so every field here has to be a fact it can quote.
 *
 * `recentRate` vs `priorRate` is the only derived judgement: whether this is
 * getting worse or being fixed. Expressed as days-with-it per days-traded over
 * the last `windowDays` against everything before, because raw counts rise
 * simply from trading more.
 */
function recurrence(episodes, kind, opts) {
  const all = (Array.isArray(episodes) ? episodes : []).filter(function (e) { return e && e.kind === kind; });
  const windowDays = (opts && opts.windowDays) || 10;
  const info = kindInfo(kind);

  const dates = Array.from(new Set(all.map(function (e) { return e.date; }))).filter(Boolean).sort();
  const totalCost = all.reduce(function (s, e) { return s + num(e.cost); }, 0);
  const totalGain = all.reduce(function (s, e) { return s + num(e.gain); }, 0);

  // Trading days across the WHOLE ledger, so a rate has a denominator that
  // means something.
  const allDates = Array.from(new Set((episodes || []).map(function (e) { return e && e.date; }))).filter(Boolean).sort();
  const recentWindow = allDates.slice(-windowDays);
  const priorWindow = allDates.slice(0, Math.max(0, allDates.length - windowDays));
  const inRecent = dates.filter(function (d) { return recentWindow.indexOf(d) >= 0; });
  const inPrior = dates.filter(function (d) { return priorWindow.indexOf(d) >= 0; });

  const recentRate = recentWindow.length ? inRecent.length / recentWindow.length : 0;
  const priorRate = priorWindow.length ? inPrior.length / priorWindow.length : null;

  let trend = 'unknown';
  if (priorRate === null) trend = dates.length > 1 ? 'establishing' : 'new';
  else if (recentRate > priorRate + 0.15) trend = 'worsening';
  else if (recentRate < priorRate - 0.15) trend = 'improving';
  else trend = 'steady';

  return {
    kind,
    type: info ? info.type : 'unknown',
    label: info ? info.label : kind,
    source: info ? info.source : null,
    count: all.length,
    days: dates.length,
    dates,
    firstSeen: dates[0] || null,
    lastSeen: dates[dates.length - 1] || null,
    totalCost: Math.round(totalCost * 100) / 100,
    totalGain: Math.round(totalGain * 100) / 100,
    worst: all.reduce(function (w, e) { return (num(e.cost) < num(w && w.cost)) ? e : w; }, all[0] || null),
    profitedAnywayCount: all.filter(function (e) { return e.profitedAnyway; }).length,
    daysTradedTotal: allDates.length,
    recentDaysWithIt: inRecent.length,
    recentWindowDays: recentWindow.length,
    recentRate: Math.round(recentRate * 100) / 100,
    priorRate: priorRate === null ? null : Math.round(priorRate * 100) / 100,
    trend,
    isRepeat: all.length > 1,
  };
}

/** Every kind present in the ledger, most-recurrent first. */
function summarize(episodes, opts) {
  const kinds = Array.from(new Set((episodes || []).map(function (e) { return e && e.kind; }))).filter(Boolean);
  return kinds
    .map(function (k) { return recurrence(episodes, k, opts); })
    .sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return (KINDS[b.kind] ? KINDS[b.kind].severity : 0) - (KINDS[a.kind] ? KINDS[a.kind].severity : 0);
    });
}

/**
 * When several episodes land at once (one trade can be oversized AND revenge,
 * and a day-close produces a handful), the agent must speak about ONE thing.
 * JESSI_PERSONA's rule 5 is explicit about why: "ONE correction per reply,
 * maximum... a list of everything wrong is not coaching, it is noise, and he
 * stops reading." Highest severity wins, ties broken by how entrenched it is.
 */
function pickPrimary(episodes, ledger, opts) {
  const list = (episodes || []).filter(Boolean);
  if (!list.length) return null;
  return list.slice().sort(function (a, b) {
    const sa = KINDS[a.kind] ? KINDS[a.kind].severity : 0;
    const sb = KINDS[b.kind] ? KINDS[b.kind].severity : 0;
    if (sb !== sa) return sb - sa;
    const ra = recurrence(ledger || [], a.kind, opts).count;
    const rb = recurrence(ledger || [], b.kind, opts).count;
    return rb - ra;
  })[0];
}

/**
 * The trigger set: episodes that actually happened on `day`.
 *
 * "New to the ledger" is NOT the same as "just happened". A backfill, a
 * repaired trade row, or a change to rules.json can all put an August episode
 * on the ledger for the first time today. Announcing those replays history
 * into chat as if it were live — which is what happened on the very first live
 * run (2026-09-03: an "eighth green day" compliment fired mid-afternoon on a
 * -$2,296 day, because switching to the scalper trade cap reclassified eight
 * old days as new episodes).
 *
 * Recurrence still counts every day on file. Only the TRIGGER is today.
 */
function onlyFromDay(episodes, day) {
  if (!day) return [];
  return (episodes || []).filter(function (e) { return e && e.date === day; });
}

/**
 * Does this episode earn an interruption?
 *
 * He asked for feedback "when any mistake or positive trade is REPEATED", so
 * the bar is a second occurrence, not a first — a one-off is noise and firing
 * on it is how an alert channel gets ignored (the same reasoning that keeps
 * F1-F4 to once per day).
 *
 * `firedToday` is the caller's record of what has already spoken today, keyed
 * by kind. Once per kind per day: today's fourth oversize is not four separate
 * things to say, and the recurrence count in the message already carries "and
 * again".
 *
 * Positives are held to a HIGHER repeat bar than mistakes. Not because they
 * matter less — because a positive fires on every clean trade, and a coach who
 * congratulates each one stops being informative by lunchtime. Mistakes get
 * the second occurrence; positives get a streak.
 */
const POSITIVE_STREAK_BAR = 3;

function shouldIntervene(episode, rec, opts) {
  const o = opts || {};
  const firedToday = o.firedToday || {};
  if (!episode || !rec) return { intervene: false, reason: 'no episode' };
  if (firedToday[episode.kind]) return { intervene: false, reason: 'already spoken about ' + episode.kind + ' today' };

  if (rec.type === 'mistake') {
    if (rec.count < 2) return { intervene: false, reason: 'first occurrence on record — not a repeat yet' };
    return { intervene: true, severity: rec.trend === 'worsening' ? 'high' : 'normal', reason: 'repeat #' + rec.count };
  }
  if (rec.type === 'positive') {
    // Count TODAY's positives of this kind — a streak inside one session is
    // the thing worth naming ("three clean trades in a row"), and it is also
    // what the ledger can prove.
    const todayCount = (o.todayEpisodes || []).filter(function (e) { return e && e.kind === episode.kind; }).length;
    if (todayCount < POSITIVE_STREAK_BAR && rec.count < POSITIVE_STREAK_BAR) {
      return { intervene: false, reason: 'not yet a streak (' + todayCount + ' today, ' + rec.count + ' on record)' };
    }
    return { intervene: true, severity: 'positive', reason: 'streak of ' + Math.max(todayCount, 0) + ' today, ' + rec.count + ' on record' };
  }
  return { intervene: false, reason: 'unknown episode type' };
}

// ── Rendering for an agent's context ────────────────────────────────────────
function money(n) {
  const v = num(n);
  return (v < 0 ? '-$' : '$') + Math.abs(Math.round(v * 100) / 100).toLocaleString('en-US');
}

/** The recurrence record for ONE kind, as the agent should read it. */
function formatRecurrence(rec) {
  if (!rec) return '';
  const lines = [];
  lines.push(`PATTERN: ${rec.label} (${rec.kind}) — ${rec.type.toUpperCase()}`);
  lines.push(`- Occurrences on record: ${rec.count}, across ${rec.days} trading day(s) out of ${rec.daysTradedTotal} on file.`);
  lines.push(`- First seen ${rec.firstSeen}, most recent ${rec.lastSeen}.`);
  if (rec.type === 'mistake') {
    lines.push(`- Cumulative damage on the days it appeared: ${money(rec.totalCost)}.`);
    if (rec.worst && num(rec.worst.cost) < 0) {
      lines.push(`- Worst single instance: ${money(rec.worst.cost)} on ${rec.worst.date}${rec.worst.size ? ' at ' + rec.worst.size + ' contracts' : ''}.`);
    }
    if (rec.profitedAnywayCount > 0) {
      lines.push(`- ${rec.profitedAnywayCount} of these MADE money. That is the dangerous half: a rule-break that paid gets filed as "that works" and repeats.`);
    }
  } else {
    lines.push(`- Total made on these: ${money(rec.totalGain)}.`);
  }
  lines.push(`- Recent rate: on ${rec.recentDaysWithIt} of the last ${rec.recentWindowDays} trading days`
    + (rec.priorRate === null ? '' : ` (${Math.round(rec.recentRate * 100)}% now vs ${Math.round(rec.priorRate * 100)}% before)`)
    + ` — trend: ${rec.trend.toUpperCase()}.`);
  lines.push(`- Dates: ${rec.dates.join(', ')}`);
  lines.push(`- Signal source (this is measured, not inferred): ${rec.source}`);
  return lines.join('\n');
}

/** The whole memory, compact, for a context block. */
function formatMemory(episodes, opts) {
  const limit = (opts && opts.limit) || 8;
  const all = summarize(episodes, opts);
  const mistakes = all.filter(function (r) { return r.type === 'mistake'; }).slice(0, limit);
  const positives = all.filter(function (r) { return r.type === 'positive'; }).slice(0, limit);
  if (!mistakes.length && !positives.length) return 'PATTERN MEMORY — empty, nothing recorded yet.';

  const out = [];
  out.push('PATTERN MEMORY — every recorded repeat, newest data included:');
  if (mistakes.length) {
    out.push('MISTAKES (count · days · cumulative damage · trend):');
    mistakes.forEach(function (r) {
      out.push(`- ${r.label} [${r.kind}]: ${r.count}× on ${r.days} day(s), ${money(r.totalCost)}, ${r.trend}. Last ${r.lastSeen}.`);
    });
  }
  if (positives.length) {
    out.push('POSITIVES (what is working — lead with these):');
    positives.forEach(function (r) {
      out.push(`- ${r.label} [${r.kind}]: ${r.count}× on ${r.days} day(s), ${money(r.totalGain)} made. Last ${r.lastSeen}.`);
    });
  }
  return out.join('\n');
}

module.exports = {
  KINDS, GREEN_DISC, POSITIVE_STREAK_BAR,
  kindInfo, isMistake, isPositive,
  tradeEpisodeId, dayEpisodeId,
  tradeEpisodes, dayEpisodes, buildEpisodes,
  recurrence, summarize, pickPrimary, onlyFromDay, shouldIntervene,
  money, formatRecurrence, formatMemory,
};
