'use strict';
/* ── week-report.js — the Weekly Report tab ──────────────────────────────────
 *
 * (2026-08-29, Anoop: "i want to create a weekly report tab that gives
 * information about the whole week and a details report of all the days
 * included with graphs and pie charts... i want to see this page every weekend
 * to plan for my upcoming week.")
 *
 * PRESENTATION ONLY. Every number on this tab is computed by week-rollup.js on
 * the SERVER and arrives in one payload. Nothing is recomputed here.
 *
 * That is deliberate and it is the whole reason the tab can be trusted: the
 * page, the Saturday markdown in sessions/ and the Telegram push all read the
 * same object. The alternative — a client that folds localStorage itself, the
 * way the Journal tab does — is exactly how "discipline score" would acquire
 * two definitions, which is the drift class CLAUDE.md warns about and which
 * day-rollup.js's header was written to stop happening again.
 *
 * The one thing this file DOES decide is what to draw, and the rules there are:
 *   - No chart without a number beside it. A pie you cannot read exact values
 *     off is decoration, and this tab is read on the morning he picks next
 *     week's size.
 *   - Nothing is smoothed, rounded up, or given an encouraging floor. If the
 *     positives list is empty the tab says the week produced none.
 *
 * SVG, not canvas: this is the first vector chart in the renderer (everything
 * before it was CSS bars), and SVG keeps it selectable, themeable via the
 * existing CSS variables, and printable without a bitmap step.
 */

// Which week is on screen. 0 = the week containing today, -1 = last week.
let wkOffset = 0;
// The last payload the server sent, kept so the commitment form can re-render
// without a round trip.
let wkData = null;
let wkBusy = false;

function wkEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wkMoney(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function wkMoney0(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '-$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US');
}
function wkDMY(iso) {
  if (!iso) return '—';
  const p = String(iso).split('-');
  return p[2] + '/' + p[1];
}

const WK_DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Slice colours. Deliberately NOT a rainbow: the breaches are shades of the
// warning colour so the eye reads "these are all the same kind of thing", and
// only "clean loss" is neutral — because a clean loss is not a mistake.
const WK_SLICE_COLOR = {
  oversize: 'var(--red)',
  revenge: '#e8724c',
  'hold-exceeded': 'var(--amber)',
  'out-of-window': '#c9a227',
  clean: 'var(--text-dim)',
  unattributed: 'var(--border2)'
};

// ── Entry point ──────────────────────────────────────────────────────────────

function renderWeekReport() {
  const body = document.getElementById('week-body');
  if (!body) return;
  if (!window.api || !window.api.weekReport) {
    body.innerHTML = '<div class="no-trades">Weekly report needs a live server connection.</div>';
    return;
  }
  if (!wkData) body.innerHTML = '<div class="no-trades">Folding the week…</div>';
  window.api.weekReport(wkOffset).then(msg => {
    if (!msg || !msg.week) {
      body.innerHTML = '<div class="no-trades">No data for that week.</div>';
      return;
    }
    wkData = msg;
    wkPaint();
  }).catch(e => {
    body.innerHTML = '<div class="no-trades">Could not load the week: ' + wkEsc(e && e.message) + '</div>';
  });
}

function wkNav(delta) {
  wkOffset += delta;
  if (wkOffset > 0) wkOffset = 0;      // the future has no report
  wkData = null;
  renderWeekReport();
}

// ── Borrowed-week marker (2026-08-31) ──────────────────────────────────────
// The Week tab now reads a week from whichever account actually traded it, so
// a fresh eval no longer blanks out the weeks before it. That fix creates a
// new way to be wrong: showing another account's P&L under the current
// account's heading. This says whose week it is, every time it is not the
// active one. Without it the tab would be confidently misattributing money.
function wkBorrowedHtml(d) {
  if (!d || !d.weekBorrowed) return '';
  var who = d.weekOwnerLabel || d.weekOwnerSlot || 'another account';
  return '<div style="margin:8px 0;padding:8px 11px;border:1px solid #7c5cff;'
    + 'border-radius:6px;background:rgba(124,92,255,.10);color:#c9bcff;'
    + 'font:12px/1.5 ui-monospace,Menlo,Consolas,monospace">'
    + 'This week belongs to <b>' + who + '</b>, not the account open now. '
    + 'Your current account had no trades this week, so the record is shown '
    + 'from the account that did trade it. Nothing here is deleted history.'
    + '</div>';
}
function wkPaint() {
  const body = document.getElementById('week-body');
  if (!body || !wkData) return;
  const d = wkData;
  body.innerHTML = [
    wkHeaderHtml(d),
    wkBorrowedHtml(d),
    wkAccountHtml(d),
    wkCalendarHtml(d),
    wkQuadrantHtml(d),
    wkPieHtml(d),
    wkDayBarsHtml(d),
    wkFindingsHtml(d),
    wkAdherenceHtml(d),
    wkTrendHtml(d),
    wkCommitmentGradeHtml(d),
    wkDoctrineHtml(d),
    wkCommitFormHtml(d),
    wkDataNoteHtml(d)
  ].join('');
}

// ── Header: week identity + the verdict sentence ─────────────────────────────

function wkHeaderHtml(d) {
  const w = d.week, f = d.findings || {};
  const b = w.behaviour;
  const netCls = w.money.net > 0 ? 'wk-g' : w.money.net < 0 ? 'wk-r' : '';
  const status = w.complete
    ? (d.frozen ? 'Frozen ' + wkDMY(String(d.frozen.frozenAt).slice(0, 10)) : 'Complete — not yet frozen')
    : 'In progress';

  return '<div class="wk-head">'
    + '<button class="jr-nav" onclick="wkNav(-1)" title="Previous week">&lsaquo;</button>'
    + '<div class="wk-head-mid">'
    + '<div class="wk-key">' + wkEsc(w.weekKey) + '</div>'
    + '<div class="wk-range">' + wkDMY(w.start) + ' — ' + wkDMY(w.end)
    + ' <span class="wk-status' + (w.complete ? '' : ' wk-live') + '">' + wkEsc(status) + '</span></div>'
    + '</div>'
    + '<button class="jr-nav" onclick="wkNav(1)"' + (wkOffset >= 0 ? ' disabled' : '') + ' title="Next week">&rsaquo;</button>'
    + '</div>'

    + '<div class="wk-verdict">' + wkEsc(f.headline || 'No verdict yet.') + '</div>'

    + '<div class="wk-kpis">'
    + wkKpi('Net', '<span class="' + netCls + '">' + wkMoney(w.money.net) + '</span>')
    + wkKpi('Trading days', b.tradedDays)
    + wkKpi('Trades', b.trades)
    + wkKpi('Biggest size', b.maxSize, b.maxSize > 2 ? 'wk-r' : 'wk-g')
    + wkKpi('Clean days', b.cleanDays + '/' + b.tradedDays, b.cleanDays > 0 ? 'wk-g' : 'wk-r')
    + wkKpi('Held fire', b.heldFireDays, b.heldFireDays > 0 ? 'wk-g' : '')
    + '</div>';
}

function wkKpi(label, val, cls) {
  return '<div class="wk-kpi"><div class="wk-kpi-l">' + wkEsc(label) + '</div>'
    + '<div class="wk-kpi-v ' + (cls || '') + '">' + val + '</div></div>';
}

// ── The account: what the week did to the one number that ends it ────────────

function wkAccountHtml(d) {
  const a = d.week.account, w = d.week;
  if (!a.maxDrawdown) return '';
  const usedPct = Math.max(0, Math.min(100, a.drawdownPctThisWeek));
  const worstPct = Math.max(0, Math.min(100, a.worstDayPctOfDrawdown));

  let h = '<div class="wk-card"><div class="wk-card-h">The account — bigger picture</div>';
  h += '<div class="wk-dd">';
  h += '<div class="wk-dd-bar"><div class="wk-dd-fill" style="width:' + usedPct + '%"></div>'
    + (worstPct > 0 ? '<div class="wk-dd-worst" style="width:' + worstPct + '%"></div>' : '')
    + '</div>';
  h += '<div class="wk-dd-legend">'
    + '<span><i class="wk-sw" style="background:var(--red)"></i>Week used ' + wkMoney0(a.drawdownUsedThisWeek) + ' (' + a.drawdownPctThisWeek + '%)</span>'
    + (w.money.worst && w.money.worst.net < 0
      ? '<span><i class="wk-sw" style="background:#8a1220"></i>Worst day ' + wkDMY(w.money.worst.date) + ' ' + wkMoney0(w.money.worst.net) + ' (' + a.worstDayPctOfDrawdown + '%)</span>'
      : '')
    + '<span class="wk-dim">of ' + wkMoney0(a.maxDrawdown) + ' total allowance</span>'
    + '</div></div>';

  h += '<div class="wk-grid3">';
  h += wkStat('Drawdown allowance', wkMoney0(a.maxDrawdown), 'The entire life of this account.');
  h += wkStat('Profit target', a.profitTarget ? wkMoney0(a.profitTarget) : '—',
    a.progressToTargetPct != null ? 'This week moved it ' + a.progressToTargetPct + '%.' : '');
  h += wkStat('Min trading days', a.minTradingDays || '—',
    'Traded ' + a.tradingDaysThisWeek + ' this week.');
  h += '</div></div>';
  return h;
}

function wkStat(label, val, sub) {
  return '<div class="wk-stat"><div class="wk-stat-l">' + wkEsc(label) + '</div>'
    + '<div class="wk-stat-v">' + val + '</div>'
    + (sub ? '<div class="wk-stat-s">' + wkEsc(sub) + '</div>' : '') + '</div>';
}

// ── Calendar ─────────────────────────────────────────────────────────────────
// Seven tiles, Monday first — the same shape as the Journal month grid so the
// two read as one family. A held-fire weekday gets its own colour: it is not a
// blank and it is not a loss, it is the thing he is trying to do more of.

function wkCalendarHtml(d) {
  let h = '<div class="wk-card"><div class="wk-card-h">The week, day by day</div><div class="wk-cal">';
  d.week.days.forEach(day => {
    let cls = 'wk-day';
    let inner = '';
    if (day.future) {
      cls += ' wk-future';
      inner = '<span class="wk-day-note">—</span>';
    } else if (day.traded) {
      cls += day.net > 0 ? ' wk-green' : day.net < 0 ? ' wk-red' : ' wk-flat';
      if (day.breaches > 0) cls += ' wk-breached';
      inner = '<span class="wk-day-pnl">' + wkMoney0(day.net) + '</span>'
        + '<span class="wk-day-meta">' + day.n + 't · max ' + day.maxSize + '</span>'
        + (day.breaches > 0
          ? '<span class="wk-day-br">' + day.breaches + ' breach' + (day.breaches === 1 ? '' : 'es') + '</span>'
          : '<span class="wk-day-br wk-g">clean</span>')
        + (day.checklist ? '<span class="wk-day-ck wk-ck-' + wkEsc(String(day.checklist.tier).toLowerCase().replace(/[^a-z]/g, '')) + '">'
          + wkEsc(day.checklist.tier) + '</span>' : '');
    } else if (day.heldFire) {
      cls += ' wk-held';
      inner = '<span class="wk-day-pnl">HELD</span><span class="wk-day-meta">no trades</span>'
        + '<span class="wk-day-br wk-g">a win</span>';
    } else if (day.preHistory && !day.isWeekend) {
      // Before this account had any record. Distinct from BOTH "held fire" and
      // a plain blank: the whole point of the data-horizon fix is that an
      // absence of records reads as an absence, not as restraint. Rendering it
      // identically to a generic empty cell would half-undo that.
      // Weekends are excluded because "closed" is the truer word there — the
      // market was shut whether or not the account had started. Matches how
      // behaviour.preHistoryDays counts (weekdays only).
      cls += ' wk-closed';
      inner = '<span class="wk-day-note">no data</span>';
    } else {
      cls += ' wk-closed';
      inner = '<span class="wk-day-note">' + (day.isWeekend ? 'closed' : '—') + '</span>';
    }
    const tip = day.traded && day.note
      ? ' title="' + wkEsc([day.note.mood ? 'Mood: ' + day.note.mood : '',
        day.note.followedPlan ? 'Followed plan: ' + day.note.followedPlan : '',
        day.note.mistake ? 'Mistake: ' + day.note.mistake : '',
        day.note.lesson ? 'Lesson: ' + day.note.lesson : ''].filter(Boolean).join('\n')) + '"'
      : '';
    h += '<div class="' + cls + '"' + tip + '>'
      + '<span class="wk-day-dow">' + WK_DOW[day.dow] + '</span>'
      + '<span class="wk-day-date">' + wkDMY(day.date) + '</span>'
      + inner + '</div>';
  });
  h += '</div>';

  // The journal line for each day that has one — the human record beside the numbers.
  const noted = d.week.days.filter(x => x.note && (x.note.text || x.note.lesson));
  if (noted.length) {
    h += '<div class="wk-notes">';
    noted.forEach(x => {
      h += '<div class="wk-note"><b>' + wkDMY(x.date) + '</b>'
        + (x.note.mood ? '<span class="wk-tag">' + wkEsc(x.note.mood) + '</span>' : '')
        + (x.note.followedPlan ? '<span class="wk-tag">plan: ' + wkEsc(x.note.followedPlan) + '</span>' : '')
        + (x.note.mistake ? '<span class="wk-tag wk-tag-r">' + wkEsc(x.note.mistake) + '</span>' : '')
        + '<div class="wk-note-t">' + wkEsc(x.note.text || '') + '</div>'
        + (x.note.lesson ? '<div class="wk-note-l">Lesson: ' + wkEsc(x.note.lesson) + '</div>' : '')
        + '</div>';
    });
    h += '</div>';
  }
  return h + '</div>';
}

// ── Quadrant ─────────────────────────────────────────────────────────────────

function wkQuadrantHtml(d) {
  const q = d.week.quadrants;
  const cell = (key, title, sub, cls) => {
    const dates = q[key] || [];
    return '<div class="wk-quad ' + cls + (dates.length ? '' : ' wk-quad-empty') + '">'
      + '<div class="wk-quad-t">' + wkEsc(title) + '</div>'
      + '<div class="wk-quad-n">' + dates.length + '</div>'
      + '<div class="wk-quad-d">' + (dates.length ? dates.map(wkDMY).join(' · ') : '—') + '</div>'
      + '<div class="wk-quad-s">' + wkEsc(sub) + '</div>'
      + '</div>';
  };
  return '<div class="wk-card"><div class="wk-card-h">Money × process</div>'
    + '<div class="wk-quad-note">A day is only repeatable if it made money <i>and</i> kept the rules. '
    + 'Splitting them is the point: your best money day this month scored 59% discipline and your best discipline day lost the most.</div>'
    + '<div class="wk-quads">'
    + cell('earned', 'Earned it', 'Green, rules intact. Copy these.', 'wk-q-earned')
    + cell('gotAway', 'Got away with it', 'Green, rules broken. Luck, not edge.', 'wk-q-got')
    + cell('badLuck', 'Cost of doing business', 'Red, rules intact. Acceptable.', 'wk-q-luck')
    + cell('selfInflicted', 'Self-inflicted', 'Red, rules broken. The only one that has to go to zero.', 'wk-q-self')
    + '</div></div>';
}

// ── Pie: where the money went ────────────────────────────────────────────────
// A real SVG donut. Each losing trade is already assigned to exactly ONE slice
// server-side, so these add to the total loss — a pie whose slices overlap
// would be worse than no pie at all.

function wkPieHtml(d) {
  const at = d.week.attribution;
  if (!at.slices.length || at.totalLoss === 0) {
    return '<div class="wk-card"><div class="wk-card-h">Where the money went</div>'
      + '<div class="wk-empty">No losing trades this week.</div></div>';
  }

  const R = 78, CX = 90, CY = 90, STROKE = 30;
  const circ = 2 * Math.PI * (R - STROKE / 2);
  let offset = 0;
  let arcs = '';
  at.slices.forEach(s => {
    const frac = Math.abs(s.loss) / Math.abs(at.totalLoss);
    const len = circ * frac;
    arcs += '<circle class="wk-arc" cx="' + CX + '" cy="' + CY + '" r="' + (R - STROKE / 2) + '"'
      + ' fill="none" stroke="' + (WK_SLICE_COLOR[s.key] || 'var(--border2)') + '"'
      + ' stroke-width="' + STROKE + '"'
      + ' stroke-dasharray="' + len.toFixed(2) + ' ' + (circ - len).toFixed(2) + '"'
      + ' stroke-dashoffset="' + (-offset).toFixed(2) + '"'
      + ' transform="rotate(-90 ' + CX + ' ' + CY + ')">'
      + '<title>' + wkEsc(s.label) + ': ' + wkMoney(s.loss) + ' (' + s.pct + '%)</title>'
      + '</circle>';
    offset += len;
  });

  const worst = at.slices[0];
  let h = '<div class="wk-card"><div class="wk-card-h">Where the money went</div>';
  h += '<div class="wk-pie-wrap">';
  h += '<svg class="wk-pie" viewBox="0 0 180 180" role="img" aria-label="Loss attribution by cause">'
    + arcs
    + '<text x="' + CX + '" y="' + (CY - 6) + '" class="wk-pie-c1">' + wkMoney0(at.totalLoss) + '</text>'
    + '<text x="' + CX + '" y="' + (CY + 12) + '" class="wk-pie-c2">in losing trades</text>'
    + '</svg>';

  h += '<div class="wk-legend">';
  at.slices.forEach(s => {
    h += '<div class="wk-leg">'
      + '<i class="wk-sw" style="background:' + (WK_SLICE_COLOR[s.key] || 'var(--border2)') + '"></i>'
      + '<span class="wk-leg-l">' + wkEsc(s.label) + '</span>'
      + '<span class="wk-leg-v">' + wkMoney(s.loss) + '</span>'
      + '<span class="wk-leg-p">' + s.pct + '%</span>'
      + '</div>';
  });
  h += '</div></div>';

  h += '<div class="wk-pie-note">Each losing trade is blamed on its single worst breach '
    + '(' + wkEsc((d.severity || []).join(' → ')) + '), so nothing is counted twice. '
    + at.losingRows + ' losing trades; ' + at.coveragePct + '% attributed'
    + (at.unattributedRows ? ' — ' + at.unattributedRows + ' row(s) had no flag data' : '') + '.';
  if (worst && worst.key !== 'clean' && worst.key !== 'unattributed') {
    h += ' <b>Trading clean would have cost '
      + wkMoney((at.slices.find(s => s.key === 'clean') || { loss: 0 }).loss) + ' instead of ' + wkMoney(at.totalLoss) + '.</b>';
  }
  h += '</div></div>';
  return h;
}

// ── Daily P&L bars ───────────────────────────────────────────────────────────
// The one "graph" that answers "how did the week actually unfold" — a zero-line
// bar per weekday, with the breach count under it so a green bar that broke
// four rules cannot be mistaken for a good day.

function wkDayBarsHtml(d) {
  const days = d.week.days.filter(x => !x.future && !x.isWeekend);
  if (!days.length) return '';
  const max = Math.max(1, ...days.map(x => Math.abs(x.net)));
  const H = 86;
  let h = '<div class="wk-card"><div class="wk-card-h">Daily P&amp;L</div><div class="wk-bars">';
  days.forEach(x => {
    const mag = Math.abs(x.net) / max;
    const px = Math.max(x.traded ? 3 : 0, Math.round(mag * (H / 2 - 6)));
    const up = x.net > 0;
    h += '<div class="wk-bar-col">'
      + '<div class="wk-bar-half wk-bar-up">'
      + (up ? '<div class="wk-bar wk-bar-g' + (x.breaches ? ' wk-bar-dirty' : '') + '" style="height:' + px + 'px"></div>' : '')
      + '</div>'
      + '<div class="wk-bar-zero"></div>'
      + '<div class="wk-bar-half wk-bar-dn">'
      + (!up && x.traded ? '<div class="wk-bar wk-bar-r' + (x.breaches ? ' wk-bar-dirty' : '') + '" style="height:' + px + 'px"></div>' : '')
      + '</div>'
      + '<div class="wk-bar-lbl">' + WK_DOW[x.dow] + '</div>'
      + '<div class="wk-bar-val ' + (x.traded ? (up ? 'wk-g' : 'wk-r') : 'wk-dim') + '">'
      + (x.traded ? wkMoney0(x.net) : (x.heldFire ? 'held' : '—')) + '</div>'
      + '<div class="wk-bar-br">' + (x.traded ? (x.breaches ? x.breaches + ' br' : 'clean') : '') + '</div>'
      + '</div>';
  });
  h += '</div><div class="wk-pie-note">Hatched bars broke at least one rule. A green hatched bar is money you were '
    + 'lucky to keep, not money you earned.</div></div>';
  return h;
}

// ── Mistakes and positives ───────────────────────────────────────────────────

function wkFindingsHtml(d) {
  const f = d.findings || { mistakes: [], positives: [] };
  let h = '<div class="wk-two">';

  h += '<div class="wk-card wk-card-r"><div class="wk-card-h">Major mistakes</div>';
  if (!f.mistakes.length) h += '<div class="wk-empty">Nothing flagged this week.</div>';
  f.mistakes.forEach((m, i) => {
    h += '<div class="wk-find"><div class="wk-find-t"><span class="wk-find-n">' + (i + 1) + '</span>'
      + wkEsc(m.title) + '</div><div class="wk-find-d">' + wkEsc(m.detail) + '</div></div>';
  });
  h += '</div>';

  h += '<div class="wk-card wk-card-g"><div class="wk-card-h">Positives</div>';
  if (!f.positives.length) {
    h += '<div class="wk-empty">Nothing this week — and that is the finding, not a gap. '
      + 'No clean day, no held-fire day, no earned day. This fills itself in the moment there is something real to put in it.</div>';
  }
  f.positives.forEach((p, i) => {
    h += '<div class="wk-find"><div class="wk-find-t"><span class="wk-find-n wk-find-ng">' + (i + 1) + '</span>'
      + wkEsc(p.title) + '</div><div class="wk-find-d">' + wkEsc(p.detail) + '</div></div>';
  });
  h += '</div></div>';
  return h;
}

// ── Does discipline actually pay? ────────────────────────────────────────────
// The one idea worth taking from the 2026 journal comparison (RizeTrade's
// "win rate with vs without rules"). Everything it needs was already stored.
//
// Shown PER CONTRACT with the sample size in plain sight. The per-trade column
// is rendered too — greyed and labelled — precisely so the comparison cannot be
// misread: per trade, his breached arm looks better simply because those trades
// were bigger. Hiding that column would look tidier and would leave the obvious
// objection unanswered.

function wkAdherenceHtml(d) {
  const a = d.adherence;
  if (!a || (!a.clean.trades && !a.breached.trades)) return '';

  const row = (label, s, cls) => '<tr class="' + (cls || '') + '">'
    + '<td><b>' + wkEsc(label) + '</b></td>'
    + '<td>' + s.trades + '</td>'
    + '<td>' + s.contracts + '</td>'
    + '<td>' + (s.winPct == null ? '—' : s.winPct + '%') + '</td>'
    + '<td class="wk-strong ' + (s.perContract > 0 ? 'wk-g' : s.perContract < 0 ? 'wk-r' : '') + '">'
    + (s.perContract == null ? '—' : wkMoney(s.perContract)) + '</td>'
    + '<td class="wk-muted-col">' + (s.perTrade == null ? '—' : wkMoney(s.perTrade)) + '</td>'
    + '<td class="' + (s.net > 0 ? 'wk-g' : s.net < 0 ? 'wk-r' : '') + '">' + wkMoney(s.net) + '</td>'
    + '<td class="wk-r">' + wkMoney(s.worst) + '</td></tr>';

  let h = '<div class="wk-card ' + (a.reliable ? '' : 'wk-card-prov') + '">'
    + '<div class="wk-card-h">Does discipline actually pay?'
    + (a.reliable ? '' : ' <span class="wk-prov-badge">provisional</span>') + '</div>';

  h += '<table class="wk-tbl wk-adh"><thead><tr>'
    + '<th></th><th>Trades</th><th>Contracts</th><th>Win%</th>'
    + '<th>$ / contract</th><th class="wk-muted-col">$ / trade</th><th>Net</th><th>Worst</th>'
    + '</tr></thead><tbody>'
    + row('Rules kept', a.clean, 'wk-adh-clean')
    + row('Rules broken', a.breached, 'wk-adh-dirty')
    + '</tbody></table>';

  if (a.perContractEdge != null) {
    h += '<div class="wk-adh-verdict ' + (a.disciplinePays ? 'wk-adh-yes' : 'wk-adh-no') + '">'
      + (a.disciplinePays
        ? 'Trading by your rules is worth <b>' + wkMoney(a.perContractEdge) + ' more per contract</b> than not.'
        : 'On the data so far, breaking the rules has not cost you per contract. That is a sample-size artefact far more often than it is a fact — it is not permission.')
      + '</div>';
  }

  h += '<div class="wk-pie-note"><b>' + wkEsc(a.basisNote) + '</b> '
    + wkEsc(a.note)
    + (a.ungradedTrades ? ' ' + a.ungradedTrades + ' row(s) were never flag-scored and are excluded.' : '')
    + (a.unsizedTrades ? ' ' + a.unsizedTrades + ' row(s) have no contract count and are excluded.' : '')
    + '</div>';

  h += '<div class="wk-pie-note">The <span class="wk-muted-col">$ / trade</span> column is shown greyed on purpose. '
    + 'Read per-trade and bigger positions always look better — they risk more. '
    + 'Per contract is the only comparison that answers whether you traded <i>well</i> rather than <i>big</i>.</div>';

  return h + '</div>';
}

// ── Trend vs last week ───────────────────────────────────────────────────────

// A metric's four values as a tiny SVG sparkline. Each metric is scaled to its
// OWN min/max — these are different units (dollars, counts, lots) and a shared
// axis would flatten every behavioural metric into a line at zero beside the
// P&L. Colour follows `betterIsUp`, so a falling giveback line is green and a
// falling clean-days line is red, without the reader having to remember which.
function wkSparkline(x) {
  const pts = x.points.filter(p => p.hasData);
  if (pts.length < 2) return '<span class="wk-dim">—</span>';
  const vals = pts.map(p => p.value);
  const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  const span = hi - lo || 1;
  const W = 72, H = 20, PAD = 2;
  const step = pts.length > 1 ? (W - PAD * 2) / (pts.length - 1) : 0;
  const xy = pts.map((p, i) => {
    const px = PAD + i * step;
    const py = H - PAD - ((p.value - lo) / span) * (H - PAD * 2);
    return [px, py];
  });
  const dAttr = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  // Direction of the LAST leg, judged the same way the verdict column is.
  const last = vals[vals.length - 1], prevV = vals[vals.length - 2];
  const rising = last > prevV;
  const stroke = last === prevV ? 'var(--text-dim)'
    : (rising === !!x.betterIsUp ? 'var(--green)' : 'var(--red)');
  const tip = pts.map(p => p.weekKey + ': ' + (x.money ? wkMoney0(p.value) : p.value)).join('\n');
  return '<svg class="wk-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">'
    + '<title>' + wkEsc(tip) + '</title>'
    + '<path d="' + dAttr + '" fill="none" stroke="' + stroke + '" stroke-width="1.5" '
    + 'stroke-linecap="round" stroke-linejoin="round"/>'
    + '<circle cx="' + xy[xy.length - 1][0].toFixed(1) + '" cy="' + xy[xy.length - 1][1].toFixed(1)
    + '" r="2" fill="' + stroke + '"/>'
    + '</svg>';
}

// ── Four weeks side by side ──────────────────────────────────────────────────
// (2026-08-31, Anoop: "lets compare 4 weeks data in this section".)
//
// Replaces the old two-column "versus last week". Two weeks tells you a
// direction; four tells you whether it is a trend or just last week.
//
// The verdict column compares the two most recent FINISHED weeks — never the
// in-progress one. Before that gate existed, opening the tab on a Monday
// scored an untraded week as an improvement on every behavioural metric at
// once ("Trades taken 49 -> 0, better"), which is flattery, not reporting.
function wkTrendHtml(d) {
  const series = d.trend4 || [];
  const weeks = d.weeksInWindow || [];
  if (!series.length || !weeks.length) {
    return '<div class="wk-card"><div class="wk-card-h">Last 4 weeks</div>'
      + '<div class="wk-empty">No weeks stored yet. This fills in as weeks finish.</div></div>';
  }

  const withData = weeks.filter(w => w.hasData).length;
  let h = '<div class="wk-card"><div class="wk-card-h">Last 4 weeks</div>';

  if (withData < 2) {
    h += '<div class="wk-empty" style="margin-bottom:10px">Only ' + withData + ' week'
      + (withData === 1 ? '' : 's') + ' of data so far — the columns fill in from the left as weeks finish.</div>';
  }

  h += '<div class="wk-scroll"><table class="wk-tbl wk-trend4"><thead><tr><th>Metric</th>';
  weeks.forEach(w => {
    h += '<th class="' + (w.isCurrent ? 'wk-th-cur' : '') + (w.hasData ? '' : ' wk-th-empty') + '">'
      + wkEsc(w.weekKey.replace(/^\d{4}-/, ''))
      + '<span class="wk-th-sub">' + wkDMY(w.start) + (w.complete ? '' : ' · live') + '</span></th>';
  });
  h += '<th>Trend</th><th>Latest move</th></tr></thead><tbody>';

  series.forEach(x => {
    const fmt = v => (v == null ? '—' : (x.money ? wkMoney0(v) : v));
    h += '<tr><td>' + wkEsc(x.label) + '</td>';
    x.points.forEach((p, i) => {
      const w = weeks[i] || {};
      let cls = p.hasData ? '' : 'wk-dim';
      if (p.hasData && x.money) cls = p.value > 0 ? 'wk-g' : p.value < 0 ? 'wk-r' : '';
      h += '<td class="' + cls + (w.isCurrent ? ' wk-td-cur' : '') + '">'
        + (p.hasData ? fmt(p.value) : '—') + '</td>';
    });
    h += '<td class="wk-spark-cell">' + wkSparkline(x) + '</td>';
    const vcls = x.good === true ? 'wk-g' : x.good === false ? 'wk-r' : 'wk-dim';
    const arrow = x.dir === 'up' ? '▲' : x.dir === 'down' ? '▼' : '–';
    h += '<td class="' + vcls + '">'
      + (x.good == null ? '<span class="wk-dim">—</span>'
        : arrow + ' ' + (x.good ? 'better' : 'worse'))
      + '</td></tr>';
  });
  h += '</tbody></table></div>';

  // Say exactly which two weeks the verdict column compared, and why the
  // in-progress week is not one of them.
  const first = series[0] || {};
  if (first.latestWeekKey && first.priorWeekKey) {
    h += '<div class="wk-pie-note">The <b>Latest move</b> column compares '
      + wkEsc(first.priorWeekKey) + ' → ' + wkEsc(first.latestWeekKey)
      + ' — the two most recent finished weeks. A week still in progress is shown but never scored: '
      + 'not having traded yet is not an improvement.</div>';
  } else {
    h += '<div class="wk-pie-note">Nothing to score yet — two finished weeks with data are needed before '
      + 'a move can be called better or worse.</div>';
  }
  h += '<div class="wk-pie-note">Each sparkline is scaled to its own range; they show shape, not magnitude. '
    + 'Read the numbers for size.</div>';
  return h + '</div>';
}

// ── Did last weekend's commitment hold? ──────────────────────────────────────

function wkCommitmentGradeHtml(d) {
  const g = d.grade;
  if (!g || !g.checkable) {
    return '<div class="wk-card"><div class="wk-card-h">What you committed to</div>'
      + '<div class="wk-empty">No commitment was recorded for this week. Use the panel below to set one for next week — '
      + 'it gets checked against what actually happens, not against what you remember.</div></div>';
  }
  let h = '<div class="wk-card"><div class="wk-card-h">What you committed to — kept ' + g.kept + ' of ' + g.checkable + '</div>';
  g.checks.forEach(c => {
    h += '<div class="wk-check ' + (c.kept ? 'wk-check-ok' : 'wk-check-no') + '">'
      + '<span class="wk-check-b">' + (c.kept ? 'KEPT' : 'BROKEN') + '</span>'
      + '<span class="wk-check-l">' + wkEsc(c.label) + '</span>'
      + '<span class="wk-check-d">' + wkEsc(c.detail) + '</span></div>';
  });
  if (g.focus) {
    h += '<div class="wk-check wk-check-self"><span class="wk-check-b">SELF</span>'
      + '<span class="wk-check-l">' + wkEsc(g.focus) + '</span>'
      + '<span class="wk-check-d">Not graded — the app cannot verify this one, so it will not put a tick on it.</span></div>';
  }
  if (g.allowedSetups && g.allowedSetups.length) {
    h += '<div class="wk-check wk-check-self"><span class="wk-check-b">N/A</span>'
      + '<span class="wk-check-l">Setups: ' + wkEsc(g.allowedSetups.join(', ')) + '</span>'
      + '<span class="wk-check-d">' + wkEsc(g.setupsNote) + '</span></div>';
  }
  return h + '</div>';
}

// ── The 50K mind ─────────────────────────────────────────────────────────────

function wkDoctrineHtml(d) {
  const doc = d.doctrine || { text: '' };
  const has = doc.text && doc.text.trim();
  let h = '<div class="wk-card wk-card-doc"><div class="wk-card-h">The 50K mind — fundamental state</div>';
  h += '<div class="wk-doc-body">'
    + '<textarea id="wk-doctrine" class="wk-doc-ta" rows="8" placeholder="'
    + wkEsc('What is true about this account regardless of what any single week did.\n\n'
      + 'This is the part that must NOT change every Saturday — it is the thing you read when the week has gone badly and you are '
      + 'tempted to size up. Write it once, edit it rarely.')
    + '">' + wkEsc(doc.text || '') + '</textarea>'
    + '<div class="wk-doc-actions">'
    + '<button class="engulf-check-btn" onclick="wkSaveDoctrine()">Save doctrine</button>'
    + '<span class="wk-dim">' + (doc.updatedAt ? 'Last edited ' + wkEsc(String(doc.updatedAt).slice(0, 10)) : 'Never set')
    + ' — never rewritten by the app.</span>'
    + (has ? '' : '<button class="engulf-check-btn" onclick="wkSeedDoctrine()" title="Fill the box with a first draft built from your own rules and journal — then edit it">Draft one for me</button>')
    + '</div></div>';

  const f = d.findings || {};
  if (has && f.mistakes && f.mistakes.length) {
    h += '<div class="wk-drift"><div class="wk-drift-h">Where you drifted from it this week</div>';
    f.mistakes.slice(0, 3).forEach(m => h += '<div class="wk-drift-i">' + wkEsc(m.title) + '</div>');
    h += '</div>';
  }
  return h + '</div>';
}

// A FIRST DRAFT, not a generated doctrine. It is built from rules.json and his
// own recorded numbers, dropped into an editable box, and never saved until he
// presses save. The distinction matters: the doctrine is his, and an app that
// writes it for him has replaced the thing it was supposed to anchor.
function wkSeedDoctrine() {
  const ta = document.getElementById('wk-doctrine');
  if (!ta || !wkData) return;
  const a = wkData.week.account;
  const lines = [
    'I am not trading this week to make money.',
    'I am trading so that this account still exists in eight weeks.',
    '',
    'Two lots. Not three "just this once".',
    'Two losses in a row and the platform closes. Non-negotiable.',
    a.maxDrawdown ? 'My whole allowance is ' + wkMoney0(a.maxDrawdown) + '. One bad day has taken 72% of it before.' : '',
    a.profitTarget ? 'The target is ' + wkMoney0(a.profitTarget) + ' and there is no deadline on it. Slow is allowed. Blown is not.' : '',
    '',
    'A day I do not trade is a day I executed correctly.',
    'The mouse is the enemy, not the market.'
  ].filter(l => l !== '');
  ta.value = lines.join('\n');
  ta.focus();
}

function wkSaveDoctrine() {
  const ta = document.getElementById('wk-doctrine');
  if (!ta || wkBusy) return;
  wkBusy = true;
  window.api.weekDoctrine(ta.value).then(msg => {
    wkBusy = false;
    if (msg && msg.week) { wkData = msg; wkPaint(); }
    if (typeof addSystemMessage === 'function') addSystemMessage('Doctrine saved. It will not be rewritten by the app.');
  }).catch(() => { wkBusy = false; });
}

// ── Commit next week ─────────────────────────────────────────────────────────

function wkCommitFormHtml(d) {
  const nextKey = d.nextWeekKey;
  const existing = d.nextCommitment;
  let h = '<div class="wk-card wk-card-commit"><div class="wk-card-h">Commit — ' + wkEsc(nextKey) + '</div>';
  h += '<div class="wk-commit-note">These get checked against what actually happens next week and reported back here next weekend. '
    + 'The first three are machine-checked. The focus line is yours to assess — the app will not pretend to grade it.</div>';
  h += '<div class="wk-commit-grid">'
    + wkField('wk-c-size', 'Max size (lots)', 'number', existing ? existing.maxSize : 2, '1')
    + wkField('wk-c-trades', 'Max trades / day', 'number', existing ? existing.maxTradesPerDay : 4, '1')
    + wkField('wk-c-stop', 'Stop the week at ($)', 'number', existing && existing.stopTheWeekAt != null ? Math.abs(existing.stopTheWeekAt) : 800, '50')
    + wkField('wk-c-setups', 'Allowed setups', 'text', existing ? (existing.allowedSetups || []).join(', ') : 'A, B', null)
    + '</div>';
  h += '<div class="wk-commit-focus"><label>One thing to fix</label>'
    + '<input type="text" id="wk-c-focus" maxlength="400" value="' + wkEsc(existing ? existing.focus : '') + '" '
    + 'placeholder="e.g. no entries before London open">'
    + '</div>';
  h += '<div class="wk-commit-actions">'
    + '<button class="engulf-check-btn wk-commit-btn" onclick="wkCommit()">'
    + (existing ? 'Update commitment' : 'Commit to this') + '</button>'
    + (existing ? '<span class="wk-dim">Committed ' + wkEsc(String(existing.committedAt).slice(0, 10)) + '</span>' : '')
    + '</div>';

  if (d.week.complete && !d.frozen) {
    h += '<div class="wk-freeze"><button class="engulf-check-btn" onclick="wkFreeze()">'
      + 'Freeze this week &amp; write the note</button>'
      + '<span class="wk-dim">Saves an immutable record, writes sessions/Week-' + wkEsc(d.week.weekKey) + '.md'
      + (d.telegramReady ? ' and pushes the summary to Telegram.' : '. Telegram has no token configured, so no push will be sent.')
      + '</span></div>';
  } else if (d.frozen) {
    h += '<div class="wk-freeze wk-dim">Frozen ' + wkEsc(String(d.frozen.frozenAt).slice(0, 16).replace('T', ' '))
      + (d.frozen.refreezeCount ? ' · re-frozen ' + d.frozen.refreezeCount + '×' : '')
      + '. <a href="#" onclick="wkFreeze();return false;">Re-freeze</a> if the underlying data was repaired.</div>';
  }
  return h + '</div>';
}

function wkField(id, label, type, val, step) {
  return '<div class="wk-field"><label for="' + id + '">' + wkEsc(label) + '</label>'
    + '<input type="' + type + '" id="' + id + '"' + (step ? ' step="' + step + '" min="0"' : '')
    + ' value="' + wkEsc(val == null ? '' : val) + '"></div>';
}

function wkVal(id) { const e = document.getElementById(id); return e ? e.value : ''; }

function wkCommit() {
  if (wkBusy || !wkData) return;
  wkBusy = true;
  const commitment = {
    maxSize: wkVal('wk-c-size'),
    maxTradesPerDay: wkVal('wk-c-trades'),
    stopTheWeekAt: wkVal('wk-c-stop'),
    allowedSetups: wkVal('wk-c-setups').split(',').map(s => s.trim()).filter(Boolean),
    focus: wkVal('wk-c-focus')
  };
  window.api.weekCommit(wkData.nextWeekKey, commitment).then(msg => {
    wkBusy = false;
    if (msg && msg.week) { wkData = msg; wkPaint(); }
    if (typeof addSystemMessage === 'function') {
      addSystemMessage('Committed for ' + (msg && msg.nextWeekKey ? msg.nextWeekKey : 'next week')
        + '. Max size ' + commitment.maxSize + ', max ' + commitment.maxTradesPerDay
        + ' trades/day. This gets checked against what you actually do.');
    }
  }).catch(() => { wkBusy = false; });
}

function wkFreeze() {
  if (wkBusy || !wkData) return;
  wkBusy = true;
  window.api.weekFreeze(wkData.week.weekKey).then(msg => {
    wkBusy = false;
    if (msg && msg.week) { wkData = msg; wkPaint(); }
    if (typeof addSystemMessage === 'function') {
      addSystemMessage('Week frozen' + (msg && msg.markdown ? ' — note written to ' + msg.markdown : '') + '.');
    }
  }).catch(() => { wkBusy = false; });
}

// ── The weekend nudge ────────────────────────────────────────────────────────
// Fired by the server when it auto-freezes a finished week. Marks the tab and
// says so in chat — the surface he is actually looking at — rather than relying
// on him remembering it is Saturday.

function wkOnWeekReady(msg) {
  try {
    const tab = document.querySelector('.rtab[data-tab="week"]');
    if (tab) {
      tab.classList.add('wk-tab-ready');
      tab.title = 'Week ' + (msg && msg.weekKey ? msg.weekKey : '') + ' is ready to review';
    }
    if (typeof addSystemMessage === 'function') {
      addSystemMessage('Week ' + (msg && msg.weekKey ? msg.weekKey : '') + ' is finished and the report is ready. '
        + 'Open the Week tab to read it and commit next week\'s numbers'
        + (msg && msg.markdown ? ' — the note is also at ' + msg.markdown : '') + '.');
    }
    // If the tab is already open, repaint it with the frozen record.
    const panel = document.getElementById('tab-week');
    if (panel && panel.style.display !== 'none') { wkData = null; renderWeekReport(); }
  } catch (e) { /* a nudge must never break the app */ }
}

// ── Data honesty ─────────────────────────────────────────────────────────────

function wkDataNoteHtml(d) {
  const rec = d.week.money.reconcile;
  if (!rec.disagreeDays.length) return '';
  let h = '<div class="wk-card wk-card-warn"><div class="wk-card-h">Data note — stores disagree</div>';
  h += '<div class="wk-pie-note">' + wkEsc(rec.note) + '</div>';
  h += '<table class="wk-tbl"><thead><tr><th>Day</th><th>balance_ledger</th><th>gr_history</th><th>trade rows</th></tr></thead><tbody>';
  rec.disagreeDays.forEach(x => {
    h += '<tr><td>' + wkDMY(x.date) + '</td><td>' + (x.ledger == null ? '—' : wkMoney(x.ledger)) + '</td>'
      + '<td class="wk-r">' + (x.grHistory == null ? '—' : wkMoney(x.grHistory)) + '</td>'
      + '<td>' + (x.rows == null ? '—' : wkMoney(x.rows)) + '</td></tr>';
  });
  return h + '</tbody></table></div>';
}
