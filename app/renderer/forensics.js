'use strict';
/* ── forensics.js — the Forensics tab ────────────────────────────────────────
 *
 * (2026-09-05, Anoop: "I need MAE and MFE per trade... time-in-trade, where
 * your entry sat relative to the session range, and what price did in the 30
 * minutes after you exited... then compute expectancy per tag with trade counts
 * attached... then I can run counterfactuals on my real trades.")
 *
 * PRESENTATION ONLY. Every figure arrives from forensics-report.js on the
 * server in one payload. Nothing here computes, averages, rounds up or fills a
 * gap. Same split as week-report.js, same reason: a client that re-folds the
 * numbers is how one metric acquires two definitions.
 *
 * THE DESIGN RULE FOR THIS TAB, above every other consideration:
 *
 *   Coverage is stated before any number that depends on it, and a missing
 *   measurement renders as "—" with its reason, never as 0.
 *
 * That is not fastidiousness. The work this tab displays exists because a
 * scoring bug produced a 4,518-point MFE on a contract that cannot move that
 * far, and it was averaged into a per-playbook verdict because nothing between
 * the arithmetic and the screen ever asked whether the input was real. A blank
 * cell that says why it is blank is the fix.
 *
 * Today almost every cell IS blank: the bar archive began collecting on
 * 2026-09-05 and the trades before it have no bars to measure against. The tab
 * is still worth opening, because "0 of 199 measured" is the honest state of
 * the dataset and it improves by itself with every session recorded.
 */

let fxData = null;
let fxBusy = false;
let fxTradeFilter = 'all';   // all | measured | unmeasured

function fxEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A missing number is a fact, not a zero. Everything that can be absent goes
// through here, and the reason (when there is one) becomes the tooltip.
function fxNum(v, digits, reason) {
  if (v == null || !isFinite(v)) {
    return '<span class="fx-na"' + (reason ? ' title="' + fxEsc(reason) + '"' : '') + '>&mdash;</span>';
  }
  return Number(v).toFixed(digits == null ? 1 : digits);
}

function fxMoney(v) {
  if (v == null || !isFinite(v)) return '<span class="fx-na">&mdash;</span>';
  const n = Number(v);
  const cls = n > 0 ? 'fx-pos' : (n < 0 ? 'fx-neg' : '');
  return '<span class="' + cls + '">' + (n < 0 ? '-$' : '$')
    + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</span>';
}

function fxPct(v, digits) {
  if (v == null || !isFinite(v)) return '<span class="fx-na">&mdash;</span>';
  return (Number(v) * 100).toFixed(digits == null ? 0 : digits) + '%';
}

function fxHold(sec) {
  if (sec == null || !isFinite(sec)) return '<span class="fx-na">&mdash;</span>';
  const s = Math.round(Number(sec));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function fxClock(ms) {
  if (!ms) return '<span class="fx-na">&mdash;</span>';
  // IST wall-clock, matching every other time surface in this app.
  const d = new Date(Number(ms) + 5.5 * 3600000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

/* ── Coverage banner — always first ─────────────────────────────────────── */
function fxCoverage(c) {
  if (!c) return '';
  const pct = c.maeMfePct == null ? 0 : c.maeMfePct;
  const tone = c.withMaeMfe === 0 ? 'empty' : (pct < 0.5 ? 'thin' : 'ok');
  const reasons = Object.keys(c.reasons || {})
    .map((k) => '<li>' + fxEsc(k) + ' &mdash; ' + c.reasons[k] + '</li>').join('');
  return '<div class="fx-cov fx-cov-' + tone + '">'
    + '<div class="fx-cov-head">Measurement coverage</div>'
    + '<div class="fx-cov-bar"><span style="width:' + Math.round(pct * 100) + '%"></span></div>'
    + '<div class="fx-cov-nums">'
    + '<b>' + c.withMaeMfe + '</b> of <b>' + c.trades + '</b> trades have MAE/MFE'
    + ' &nbsp;·&nbsp; ' + c.withPrices + ' have entry price + side'
    + ' &nbsp;·&nbsp; ' + c.withPost30 + ' have post-exit data'
    + ' &nbsp;·&nbsp; ' + c.withPlaybook + ' carry a playbook'
    + '</div>'
    + '<div class="fx-cov-note">' + fxEsc(c.note || '') + '</div>'
    + (reasons ? '<ul class="fx-cov-why">' + reasons + '</ul>' : '')
    + '</div>';
}

/* ── Per-trade table — the Journal-side detail, beside P&L ──────────────── */
function fxTradeTable(rows) {
  const shown = rows.filter((r) => {
    if (fxTradeFilter === 'measured') return r.mae != null;
    if (fxTradeFilter === 'unmeasured') return r.mae == null;
    return true;
  });
  if (!shown.length) {
    return '<div class="no-trades">No trades match this filter.</div>';
  }
  let h = '<div class="fx-scroll"><table class="fx-tbl"><thead><tr>'
    + '<th>Day</th><th>In</th><th>Side</th><th class="num">Size</th><th class="num">P&amp;L</th>'
    + '<th class="num">Hold</th><th class="num">MAE</th><th class="num">MFE</th><th class="num">MFE/MAE</th>'
    + '<th class="num">Entry in range</th><th class="num">Left on table</th>'
    + '<th>Playbook</th><th>Session</th><th>Tags</th>'
    + '</tr></thead><tbody>';
  for (const r of shown) {
    const tags = [];
    if (r.tradeIndexOfDay != null) tags.push('#' + r.tradeIndexOfDay);
    if (r.isReentry) tags.push('re-entry');
    if (r.afterLoss) tags.push('after loss');
    for (const f of r.flags || []) tags.push(f);
    h += '<tr>'
      + '<td>' + fxEsc(r.day || '') + '</td>'
      + '<td>' + fxClock(r.entryAt) + '</td>'
      + '<td>' + fxEsc(r.side || '&mdash;') + '</td>'
      + '<td class="num">' + (r.size == null ? '&mdash;' : r.size) + '</td>'
      + '<td class="num">' + fxMoney(r.pnl) + '</td>'
      + '<td class="num">' + fxHold(r.holdSec) + '</td>'
      + '<td class="num">' + fxNum(r.mae, 1, r.forensicsReason) + '</td>'
      + '<td class="num">' + fxNum(r.mfe, 1, r.forensicsReason) + '</td>'
      + '<td class="num">' + fxNum(r.edgeRatio, 2, r.forensicsReason) + '</td>'
      + '<td class="num">' + fxPct(r.entryPctOfRange) + '</td>'
      + '<td class="num">' + fxNum(r.post30LeftOnTable, 1, r.post30Reason) + '</td>'
      + '<td>' + fxEsc(r.playbook || '&mdash;') + '</td>'
      + '<td>' + fxEsc(r.session || '&mdash;') + '</td>'
      + '<td class="fx-tags">' + tags.map((t) => '<span>' + fxEsc(t) + '</span>').join('') + '</td>'
      + '</tr>';
  }
  return h + '</tbody></table></div>';
}

/* ── Expectancy per tag ─────────────────────────────────────────────────── */
function fxExpectancy(tables, minN) {
  let h = '<div class="fx-note">Ranked by <b>expectancy per contract</b>, never per trade &mdash; '
    + 'comparing per-trade across sizes measures how big the bet was, not how well it was traded. '
    + 'Rows with fewer than ' + minN + ' trades are shown but greyed: they are not findings.</div>';
  for (const t of tables) {
    h += '<div class="fx-block"><h4>' + fxEsc(t.label) + '</h4>';
    if (!t.rows.length) { h += '<div class="no-trades">Nothing tagged on this dimension yet.</div></div>'; continue; }
    h += '<div class="fx-scroll"><table class="fx-tbl"><thead><tr>'
      + '<th>' + fxEsc(t.label) + '</th><th class="num">n</th><th class="num">Win%</th>'
      + '<th class="num">Avg win</th><th class="num">Avg loss</th><th class="num">Payoff</th>'
      + '<th class="num">Exp / contract</th><th class="num">Exp / trade</th><th class="num">Total</th>'
      + '<th class="num">Avg MAE</th><th class="num">Avg MFE</th><th class="num">Avg hold</th>'
      + '</tr></thead><tbody>';
    for (const r of t.rows) {
      h += '<tr class="' + (r.underMin ? 'fx-undermin' : '') + '"'
        + (r.underMin ? ' title="n=' + r.n + ', below the ' + minN + '-trade bar — shown for completeness, not ranked"' : '') + '>'
        + '<td>' + fxEsc(r.tag) + (r.underMin ? ' <span class="fx-thin">thin</span>' : '') + '</td>'
        + '<td class="num"><b>' + r.n + '</b></td>'
        + '<td class="num">' + fxPct(r.winRate) + '</td>'
        + '<td class="num">' + fxMoney(r.avgWin) + '</td>'
        + '<td class="num">' + fxMoney(r.avgLoss) + '</td>'
        + '<td class="num">' + fxNum(r.payoff, 2) + '</td>'
        + '<td class="num">' + fxMoney(r.expectancyPerContract) + '</td>'
        + '<td class="num">' + fxMoney(r.expectancyPerTrade) + '</td>'
        + '<td class="num">' + fxMoney(r.totalPnl) + '</td>'
        + '<td class="num">' + fxNum(r.avgMae, 1, 'no trade in this bucket has an MAE yet') + '</td>'
        + '<td class="num">' + fxNum(r.avgMfe, 1, 'no trade in this bucket has an MFE yet') + '</td>'
        + '<td class="num">' + fxHold(r.avgHold) + '</td>'
        + '</tr>';
    }
    h += '</tbody></table></div></div>';
  }
  return h;
}

/* ── Counterfactuals ────────────────────────────────────────────────────── */
function fxCounterfactuals(list) {
  let h = '<div class="fx-note">Each one replays the <b>real</b> trades under a single changed rule. '
    + 'They are not combined: skipping a trade changes what the next one would have been, so the deltas '
    + 'do not add up and must not be read as a plan.</div><div class="fx-cf-grid">';
  for (const c of list) {
    if (c.unavailable || c.degenerate) {
      h += '<div class="fx-cf fx-cf-off"><div class="fx-cf-label">' + fxEsc(c.label) + '</div>'
        + '<div class="fx-cf-why">' + fxEsc(c.unavailable || c.degenerate) + '</div></div>';
      continue;
    }
    const d = Number(c.deltaVsActual) || 0;
    h += '<div class="fx-cf ' + (d > 0 ? 'fx-cf-good' : (d < 0 ? 'fx-cf-bad' : '')) + '">'
      + '<div class="fx-cf-label">' + fxEsc(c.label) + '</div>'
      + '<div class="fx-cf-delta">' + (d > 0 ? '+' : '') + fxMoney(d) + '</div>'
      + '<div class="fx-cf-meta">net ' + fxMoney(c.net) + ' &nbsp;·&nbsp; win ' + fxPct(c.winRate)
      + (c.basis ? ' &nbsp;·&nbsp; ' + fxEsc(c.basis) : '')
      + (c.excluded ? ' &nbsp;·&nbsp; ' + c.excluded + ' excluded (no MFE)' : '')
      + (c.refused ? ' &nbsp;·&nbsp; <b>' + c.refused + ' refused</b>' : '')
      + '</div>'
      + (c.error ? '<div class="fx-cf-why">' + fxEsc(c.error) + '</div>' : '')
      + '</div>';
  }
  return h + '</div>';
}

/* ── Entry point, called from switchTab ─────────────────────────────────── */
async function renderForensics() {
  const body = document.getElementById('forensics-body');
  if (!body) return;
  if (fxBusy) return;
  fxBusy = true;
  if (!fxData) body.innerHTML = '<div class="no-trades">Loading forensics…</div>';
  try {
    const res = await window.api.forensics();
    if (res && res.error) {
      body.innerHTML = '<div class="no-trades">Forensics could not be built: ' + fxEsc(res.error) + '</div>';
      return;
    }
    fxData = res;
    fxPaint();
  } catch (e) {
    body.innerHTML = '<div class="no-trades">Forensics request failed: ' + fxEsc(e && e.message) + '</div>';
  } finally {
    fxBusy = false;
  }
}

function fxPaint() {
  const body = document.getElementById('forensics-body');
  if (!body || !fxData) return;
  const d = fxData;
  if (!d.trades || !d.trades.length) {
    body.innerHTML = fxCoverage(d.coverage)
      + '<div class="no-trades">No trades recorded for this account yet. '
      + 'Every trade from here on is measured as it closes.</div>';
    return;
  }
  const f = (id, label) => '<button class="fx-filter' + (fxTradeFilter === id ? ' on' : '')
    + '" onclick="fxSetFilter(\'' + id + '\')">' + label + '</button>';
  body.innerHTML =
    fxCoverage(d.coverage)
    + '<div class="fx-section"><h3>Every trade</h3>'
    + '<div class="fx-filters">' + f('all', 'All (' + d.trades.length + ')')
    + f('measured', 'Measured (' + d.coverage.withMaeMfe + ')')
    + f('unmeasured', 'Not yet measured (' + (d.trades.length - d.coverage.withMaeMfe) + ')') + '</div>'
    + fxTradeTable(d.trades) + '</div>'
    + '<div class="fx-section"><h3>Expectancy by tag</h3>' + fxExpectancy(d.expectancy, d.minN) + '</div>'
    + '<div class="fx-section"><h3>Counterfactuals on your real trades</h3>'
    + fxCounterfactuals(d.counterfactuals) + '</div>'
    + '<div class="fx-built">Built ' + new Date(d.builtAt).toLocaleString() + ' from account '
    + fxEsc(d.slot || '?') + ' &nbsp;·&nbsp; <button class="fx-filter" onclick="fxRefresh()">Refresh</button></div>';
}

function fxSetFilter(id) { fxTradeFilter = id; fxPaint(); }
function fxRefresh() { fxData = null; renderForensics(); }
