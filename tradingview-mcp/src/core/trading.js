/**
 * Core trading-panel logic (2026-08-17).
 *
 * Reads the live broker account (Tradeify, via Tradovate's white-labeled
 * integration) directly from TradingView Desktop's Trading Panel DOM.
 *
 * WHY THIS EXISTS: MNQ Co-Pilot's guardrail (app/renderer/app.js, grLog/
 * grIngestLive) enforces size-after-loss/daily-stop rules, but only against
 * MANUALLY logged trades or the (untested, permission-uncertain) Tradovate
 * REST API. TradingView Desktop is already CDP-connected here, and — once a
 * broker is linked — renders account/position/order data as a set of plain,
 * semantic HTML <table> elements, not canvas or an encoded blob. Confirmed
 * live against a real connected Tradeify account (2026-08-17):
 *
 *   table[data-name="TRADOVATE.positions-table"]        Symbol, Side, Qty,
 *     Avg Fill Price, Profit, Update Time, Position ID
 *   table[data-name="TRADOVATE.orders-table"]            Symbol, Side, Type,
 *     Qty, Remaining Qty, Filled Qty, Limit Price, Stop Price, Take Profit,
 *     Stop Loss, Avg Fill Price, Status, Update Time, Order ID, Expiry,
 *     Expiry Time
 *   table[data-name="TRADOVATE.summary.accountSummary-table"]  Total P/L,
 *     Open P/L, Net Liq, Total Margin Used, Available Margin, Day Margin,
 *     Initial Margin, Maintenance Margin
 *
 * All four tables exist in the DOM AT ONCE regardless of which tab is
 * currently showing on screen for the human — reading them never has to
 * click anything, so this can never disrupt what Anoop is actually looking
 * at. The "TRADOVATE." prefix on every data-name is TradingView's own broker
 * integration component name, not something specific to this account or to
 * Tradeify's white-label — the same selectors should hold for any
 * Tradovate-based broker connection.
 *
 * ⚠ THE PARAGRAPH ABOVE IS TRUE ONLY WHILE THE BOTTOM PANEL IS EXPANDED.
 * Corrected 2026-08-23 after the live feed was dark for a full session.
 * These tables live in `[class*="layout__area--bottom"]`. COLLAPSE that
 * panel and TradingView unmounts its whole subtree — all four tables vanish
 * from the DOM simultaneously, leaving a 38px title bar with just the broker
 * name on it. Tab selection genuinely does not matter (an unselected tab's
 * table is present with offsetParent === null); PANEL EXPANSION does. If
 * every table reads not-found at once, the panel is collapsed — that is the
 * signature. See ensurePanelTablesMounted() at the foot of this file, which
 * detects and repairs exactly this, and never re-collapses the panel
 * afterwards (re-collapsing would immediately re-break the feed).
 *
 * WHAT IS NOT YET VERIFIED: the account this was built against was fresh
 * (zero trades), so every row shape below is confirmed for HEADERS only —
 * "There are no open positions" / "There is no trading data here yet" was
 * the actual live state. The first real Filled order's row must be checked
 * against parseOrders()'s column mapping before anything here is trusted for
 * the size-freeze-guard's "was the preceding trade a loss" check specifically
 * — Filled orders carry Avg Fill Price but the header row does NOT show a
 * per-order realized-P&L column. Realized P&L per trade is instead computed
 * server-side (app/tv-broker-feed.js's fold()) as "balance delta at each
 * flat moment" — the account-header Balance figure right after a position
 * returns to flat, minus Balance the last time it was flat. That fold is
 * unit-tested but the balance-delta MATH ITSELF has not been checked against
 * a real non-zero-P&L closed trade — do not assume it is solved until
 * re-verified against a real trade.
 */
import { getClient, evaluate } from '../connection.js';

// ── Order-label verification (2026-08-17, extracted after a real bug) ──────
// The submit button's OWN label ("Buy 1 MNQU6 MARKET") is the single source
// of truth placeMarketOrder() checks before ever clicking — it mirrors side,
// quantity, and symbol at once. This was inline as three separate checks
// with a regex bug (see git history / journeys memory) that made the
// quantity check permanently unmatchable, discovered only by an independent
// review, never by manual testing — the two prior "verified live" trades
// never actually exercised this exact code path (they failed earlier, at
// DOM-timing issues, before ever reaching the quantity check). Extracted to
// a pure function specifically so it can be unit tested in isolation,
// against fabricated labels, without needing a live TradingView connection
// or real money on the line to catch a regression here again.
export function verifyOrderLabel(label, side, qtyNum, symbol) {
  if (typeof label !== 'string') return { ok: false, reason: 'label is not a string' };
  const s = String(side || '').toLowerCase();
  const expectedPrefix = s === 'buy' ? 'Buy' : s === 'sell' ? 'Sell' : null;
  if (!expectedPrefix) return { ok: false, reason: `invalid side: ${side}` };
  if (!label.startsWith(expectedPrefix)) {
    return { ok: false, reason: `submit button reads "${label}", expected it to start with "${expectedPrefix}". The UI is not in the state this call expects.` };
  }
  if (!new RegExp('\\b' + qtyNum + '\\b').test(label)) {
    return { ok: false, reason: `submit button reads "${label}", expected it to mention quantity ${qtyNum}. Quantity may not have been set correctly.` };
  }
  if (symbol && label.indexOf(symbol) === -1) {
    return { ok: false, reason: `submit button reads "${label}", expected it to mention symbol "${symbol}".` };
  }
  return { ok: true };
}

// TradingView renders negative figures with U+2212 MINUS SIGN, not the ASCII
// hyphen-minus (U+002D) JS's Number()/parseFloat() expect — confirmed live
// 2026-08-17 against a real -$0.50 floating P&L ("−0.50", char code 8722).
// Silent bug otherwise: parseFloat('−0.50') is NaN, not -0.5. Every
// caller that turns a summary/table string into a number MUST go through
// this first.
export function normalizeMinus(s) {
  return typeof s === 'string' ? s.replace(/−/g, '-') : s;
}

// Generic reader for one of the panel's ka-table grids. Returns header names
// and each body row as BOTH a positional array and a {header: value} object
// (object form is what callers should use — positional is kept only as a
// fallback in case a header is blank/duplicated, matching the real headers
// captured above where the last column is always "").
const READ_TABLE_JS = (dataName) => `
(function() {
  var t = document.querySelector('table[data-name="${dataName}"]');
  if (!t) return { found: false };
  var headerCells = Array.from(t.querySelectorAll('thead th'))
    .map(function(th) { return (th.innerText || '').trim(); });
  var bodyTrs = Array.from(t.querySelectorAll('tbody tr'));
  var rows = [];
  var emptyStateText = null;
  for (var r = 0; r < bodyTrs.length; r++) {
    var cells = Array.from(bodyTrs[r].querySelectorAll('td')).map(function(td) { return (td.innerText || '').trim(); });
    // ka-table's "no data" placeholder renders as ONE <tr> with a single
    // <td> (colspan across the whole table), not one cell per header — a
    // real data row always has as many cells as there are header columns.
    // Caught live: a fresh account's positions table returned exactly this
    // shape and was originally mis-parsed as one real row with the message
    // text sitting in the Symbol column.
    if (cells.length < headerCells.length) {
      if (cells.length === 1 && !emptyStateText) emptyStateText = cells[0];
      continue;
    }
    var obj = {};
    for (var i = 0; i < headerCells.length; i++) {
      var key = headerCells[i];
      // NOTE: minus-sign normalization happens on the Node side (see
      // normalizeMinus in this file) — the DOM read stays a faithful,
      // unmodified copy of what's actually on screen.
      if (key) obj[key] = cells[i] != null ? cells[i] : null;
    }
    rows.push({ cells: cells, row: obj });
  }
  return { found: true, visible: t.offsetParent !== null, headers: headerCells, rows: rows, emptyStateText: emptyStateText };
})()
`;

async function readTable(dataName) {
  const result = await evaluate(READ_TABLE_JS(dataName));
  if (!result || !result.found) {
    return { found: false, headers: [], rows: [], emptyStateText: null };
  }
  return result;
}

export async function getPositions() {
  const t = await readTable('TRADOVATE.positions-table');
  return {
    success: t.found,
    count: t.rows.length,
    empty: t.rows.length === 0,
    emptyStateText: t.emptyStateText,
    positions: t.rows.map((r) => r.row),
  };
}

export async function getOrders({ status } = {}) {
  const t = await readTable('TRADOVATE.orders-table');
  let rows = t.rows.map((r) => r.row);
  // Status filtering done client-side against the Status column already
  // present in every row — no need to click the UI's All/Filled/etc. tab,
  // which would disturb what's on screen for Anoop.
  if (status) {
    const want = String(status).toLowerCase();
    rows = rows.filter((r) => String(r.Status || '').toLowerCase() === want);
  }
  return {
    success: t.found,
    count: rows.length,
    empty: rows.length === 0,
    emptyStateText: t.emptyStateText,
    orders: rows,
  };
}

export async function getAccountSummary() {
  // The summary TABLE (Total P/L, Open P/L, Net Liq, margins) is a separate
  // element from the top account-header strip (account ID, Balance, Equity,
  // Profit) seen directly under the tab bar — that strip isn't a <table> at
  // all, just plain divs, so it's read by label-adjacent text match instead.
  const summaryTable = await readTable('TRADOVATE.summary.accountSummary-table');
  const headerStrip = await evaluate(`
    (function() {
      var b = document.querySelector('.bottom-widgetbar-content');
      if (!b) return { found: false };
      var text = (b.innerText || '');
      var lines = text.split('\\n').map(function(l) { return l.trim(); }).filter(Boolean);
      function valueAfter(label) {
        var i = lines.indexOf(label);
        return i !== -1 && i + 1 < lines.length ? lines[i + 1] : null;
      }
      return {
        found: true,
        accountId: lines[0] || null,
        currency: lines[1] || null,
        balance: valueAfter('Account Balance'),
        equity: valueAfter('Equity'),
        profit: valueAfter('Profit'),
      };
    })()
  `);
  // normalizeMinus applied here, not inside the page-context eval string —
  // keeps the DOM-reading JS a faithful passthrough and the sign-fix in one
  // place, in real Node code where it's easy to test in isolation.
  const detail = summaryTable.rows.length
    ? Object.fromEntries(Object.entries(summaryTable.rows[0].row).map(([k, v]) => [k, normalizeMinus(v)]))
    : null;
  return {
    success: !!(summaryTable.found || (headerStrip && headerStrip.found)),
    header: headerStrip && headerStrip.found ? {
      accountId: headerStrip.accountId,
      currency: headerStrip.currency,
      balance: normalizeMinus(headerStrip.balance),
      equity: normalizeMinus(headerStrip.equity),
      profit: normalizeMinus(headerStrip.profit),
    } : null,
    detail,
  };
}

// ── Order placement (2026-08-17) ─────────────────────────────────────────
// Confirmed live against a real account: placed a 1-lot market Buy, verified
// the fill, placed the offsetting 1-lot market Sell, verified flat again.
// Round-trip cost $2.90 in commission on essentially unchanged price — the
// expected cost of a real, immediately-closed test.
//
// SAFETY PROPERTY THIS PRESERVES: before clicking submit, this reads the
// submit button's OWN label back (TradingView renders it as e.g. "Buy 1
// MNQU6 MARKET" once side+qty are set) and refuses to proceed unless that
// label matches the side/qty actually requested. This is the same manual
// check done by hand during verification — a mismatch here means the UI is
// in an unexpected state (wrong side selected, stale quantity, panel not
// focused) and clicking anyway would place an order that isn't the one
// asked for. Fails CLOSED: any mismatch or missing element throws rather
// than guessing and clicking.
// ── Optional stop-loss / take-profit (2026-08-17, Phase 2c) ────────────────
// VERIFIED LIVE 2026-08-17 against a real connected account (draft ticket
// state only — checkbox toggled + price set + read back, never submitted):
// TradingView's order ticket renders an "Exits" bracket section containing
// two independent fields, "Take profit, price" and "Stop loss, price", each
// a {checkbox, text input} pair. NEITHER the checkbox's nor the input's
// label text lives on an ancestor within 1-2 levels — it takes 4-6
// `parentElement` hops from either element before an ancestor's innerText
// actually contains the field's label. The two fields' bracket group shares
// a common ancestor (contains BOTH "Take profit" and "Stop loss" text), so
// matching on "want the target label AND NOT the other label" is required
// to stop the walk at the correct (smaller) container instead of overshooting
// into the shared group. Also confirmed live the same day: the ticket's text
// inputs (qty AND these) carry no explicit `type="text"` DOM attribute —
// selecting by `input[type="text"]` matches nothing; `.type === 'text'`
// (the resolved property) is required. See setQtyJs's comment above for the
// same fix applied to the quantity field.
//
// FAILS CLOSED regardless: if a field can't be found/toggled with
// confidence, placeMarketOrder() throws BEFORE the qty/side selection is
// ever submitted — the whole order is aborted, never partially placed
// without the stop/target Anoop believed was there.
function setTicketPriceFieldJS(wantRegexLiteral, otherRegexLiteral, price) {
  return `
    (function() {
      var panels = Array.from(document.querySelectorAll('.trading-panel-content'));
      var panel = panels.find(function(p) { return p.offsetParent !== null; });
      if (!panel) return { ok: false, error: 'no visible trading panel found' };
      var wantRe = ${wantRegexLiteral};
      var otherRe = ${otherRegexLiteral};

      function findByLabel(candidates) {
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          var walk = el;
          for (var d = 0; d < 6 && walk; d++) {
            walk = walk.parentElement;
            if (!walk) break;
            var text = walk.innerText || '';
            if (wantRe.test(text) && !otherRe.test(text)) return candidates[i];
          }
        }
        return null;
      }

      var checkboxes = Array.from(panel.querySelectorAll('input[type="checkbox"]'));
      var cb = findByLabel(checkboxes);
      if (!cb) return { ok: false, error: 'no matching checkbox found for ' + wantRe };

      var texts = Array.from(panel.querySelectorAll('input')).filter(function(i) { return i.type === 'text'; });
      var input = findByLabel(texts);
      if (!input) return { ok: false, error: 'no matching price input found for ' + wantRe };

      var isChecked = cb.checked === true || cb.getAttribute('aria-checked') === 'true';
      if (!isChecked) cb.click();

      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '${price}');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, confirmValue: input.value };
    })()
  `;
}

export async function placeMarketOrder({ side, qty, symbol, stopPrice, targetPrice }) {
  const s = String(side || '').toLowerCase();
  if (s !== 'buy' && s !== 'sell') throw new Error(`side must be "buy" or "sell", got: ${side}`);
  const qtyNum = Number(qty);
  if (!Number.isFinite(qtyNum) || qtyNum <= 0 || Math.floor(qtyNum) !== qtyNum) {
    throw new Error(`qty must be a positive whole number, got: ${qty}`);
  }

  // side-control-buy/sell are TOGGLE buttons, not "set to this side" buttons
  // — clicking one that's already active collapses/re-renders the ticket
  // instead of leaving it alone (caught live: this is exactly what produced
  // the "quantity input never appeared" failure below, on a retry where the
  // requested side happened to already be selected from a prior call). Only
  // click if the requested side isn't already the active one.
  const selectResult = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="side-control-${s}"]');
      if (!btn) return { ok: false, error: 'side control button not found: side-control-${s}' };
      var alreadyActive = btn.className.indexOf('active') !== -1;
      if (!alreadyActive) btn.click();
      return { ok: true, clicked: !alreadyActive };
    })()
  `);
  if (!selectResult || !selectResult.ok) {
    throw new Error((selectResult && selectResult.error) || 'failed to select order side');
  }

  // Find the visible panel AND set quantity in ONE round trip, retried as a
  // whole. Splitting "check the input exists" from "set the input" across
  // two separate evaluate() calls left a race window — live testing showed
  // the ticket's price-suggestion fields (TP/SL "ticks" values) re-render on
  // every price tick, and a check could pass an instant before a re-render
  // replaced the very element it just found, so the follow-up set() call hit
  // a detached/gone node. Doing find+set atomically per attempt removes that
  // gap; only the RETRY LOOP needs to re-run, not a separate check-then-act
  // pair. Up to 3s total, every 200ms.
  //
  // VISIBLE PANEL ONLY: with more than one chart pane open, TradingView
  // renders a SEPARATE .trading-panel-content per pane, and a plain
  // querySelector grabs whichever is FIRST in the DOM — which live testing
  // showed can be a different pane's panel entirely (hidden/inactive,
  // offsetParent === null), not the one actually on screen.
  //
  // This is a React-controlled input: setting .value directly does not
  // register with React's own state, so this uses the native input value
  // setter + a real 'input' event, the standard way to drive a React input
  // from outside React. Positional selector (first text input in the panel)
  // rather than a CSS-module class hash, which is not guaranteed stable
  // across TradingView versions.
  //
  // BUGFIX (2026-08-17, found while live-verifying Phase 2c TP/SL): this used
  // to select via `input[type="text"]`, a CSS ATTRIBUTE selector — but a live
  // DOM inspection (via `tv ui eval`, TradingView connected) showed the qty
  // field carries NO explicit `type` attribute at all (`hasAttribute('type')`
  // === false); `type` reads as `"text"` only via the browser's implicit
  // default, which `[type="text"]` does NOT match. Confirmed live:
  // `document.querySelectorAll('input[type="text"]')` returned ZERO elements
  // on the current TradingView build, while `Array.from(...).filter(i =>
  // i.type === 'text')` correctly found all 3 (qty, TP price, SL price).
  // Whether this is a markup change since the original qty verification or
  // always-latent is unknown — either way, property-based filtering is
  // strictly more robust (matches the browser's resolved type regardless of
  // whether the framework sets the attribute) and is what's used everywhere
  // in this file now, including the new TP/SL fields below.
  const setQtyJs = `
    (function() {
      var panels = Array.from(document.querySelectorAll('.trading-panel-content'));
      var panel = panels.find(function(p) { return p.offsetParent !== null; });
      if (!panel) return { ok: false, error: 'no visible trading panel found' };
      var textInputs = Array.from(panel.querySelectorAll('input')).filter(function(i) { return i.type === 'text'; });
      var qtyInput = textInputs[0];
      if (!qtyInput) return { ok: false, error: 'quantity input not found' };
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(qtyInput, '${qtyNum}');
      qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
      qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, confirmValue: qtyInput.value };
    })()
  `;
  let qtyResult = null;
  for (let i = 0; i < 15; i++) {
    qtyResult = await evaluate(setQtyJs);
    if (qtyResult && qtyResult.ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!qtyResult || !qtyResult.ok) {
    throw new Error((qtyResult && qtyResult.error) || 'failed to set quantity after retrying for 3s');
  }

  // Optional stop-loss / take-profit — see setTicketPriceFieldJS's header
  // comment above: verified live 2026-08-17 (draft ticket state, never
  // submitted). Runs BEFORE the submit button is ever verified/clicked
  // below, so a failure here still aborts the entire order — nothing has
  // been submitted yet at this point.
  const STOP_RE = '/stop[\\s-]*loss|\\bSL\\b/i';
  const TARGET_RE = '/take[\\s-]*profit|\\bTP\\b/i';
  if (stopPrice != null) {
    const stopNum = Number(stopPrice);
    if (!Number.isFinite(stopNum) || stopNum <= 0) throw new Error(`stopPrice must be a positive number, got: ${stopPrice}`);
    const stopResult = await evaluate(setTicketPriceFieldJS(STOP_RE, TARGET_RE, stopNum));
    if (!stopResult || !stopResult.ok) {
      throw new Error(`REFUSING TO SUBMIT — could not set stop-loss (${(stopResult && stopResult.error) || 'unknown error'}). No order was placed.`);
    }
  }
  if (targetPrice != null) {
    const targetNum = Number(targetPrice);
    if (!Number.isFinite(targetNum) || targetNum <= 0) throw new Error(`targetPrice must be a positive number, got: ${targetPrice}`);
    const targetResult = await evaluate(setTicketPriceFieldJS(TARGET_RE, STOP_RE, targetNum));
    if (!targetResult || !targetResult.ok) {
      throw new Error(`REFUSING TO SUBMIT — could not set take-profit (${(targetResult && targetResult.error) || 'unknown error'}). No order was placed.`);
    }
  }

  // Poll (up to 1.5s) for the submit button's label to actually re-render
  // with the new quantity, rather than a fixed delay — same race as the
  // side-select wait above, same fix.
  let verifyResult = null;
  for (let i = 0; i < 15; i++) {
    verifyResult = await evaluate(`
      (function() {
        var submit = document.querySelector('[data-name="place-and-modify-button"]');
        if (!submit) return { ok: false, error: 'submit button not found' };
        if (submit.disabled) return { ok: false, error: 'submit button is disabled' };
        var label = (submit.innerText || '').trim();
        return { ok: true, label: label, disabled: submit.disabled };
      })()
    `);
    if (verifyResult && verifyResult.ok && verifyOrderLabel(verifyResult.label, s, qtyNum, symbol).ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!verifyResult || !verifyResult.ok) {
    throw new Error((verifyResult && verifyResult.error) || 'could not read submit button state');
  }

  const finalCheck = verifyOrderLabel(verifyResult.label, s, qtyNum, symbol);
  if (!finalCheck.ok) {
    throw new Error(`REFUSING TO SUBMIT — ${finalCheck.reason}`);
  }

  const clickResult = await evaluate(`
    (function() {
      var submit = document.querySelector('[data-name="place-and-modify-button"]');
      if (!submit) return { ok: false, error: 'submit button vanished before click' };
      var label = (submit.innerText || '').trim();
      submit.click();
      return { ok: true, label: label };
    })()
  `);
  if (!clickResult || !clickResult.ok) {
    throw new Error((clickResult && clickResult.error) || 'submit click failed');
  }

  // POST-SUBMIT READ-BACK (2026-08-19, SEMI_AUTONOMOUS_SYSTEM_PLAN.md item 5b):
  // until now this returned `success: true` the instant the click event fired,
  // with nothing confirming the order actually reached the broker — same
  // "claiming success it can't back up" shape verifyOrderLabel() above was
  // built to close on the PRE-submit side. On real money, a caller that
  // retries an ambiguous "did that go through?" can double a position, so a
  // few short polls of getPositions()/getOrders() run here to look for
  // confirming evidence before this function is allowed to say success. A
  // Working order (limit/stop, not yet filled) still counts as confirmed —
  // this only needs proof the ticket reached the broker, not that it filled;
  // a market order failing to fill at all would be a broker-side problem this
  // function has no way to diagnose further. If nothing turns up in the
  // window, `verified: false` is returned rather than silently swallowing the
  // uncertainty — the caller (handleTradeConfirm in app/server.js) decides
  // what to do with an unverified submit, this function does not guess.
  let verified = false;
  let verifyDetail = null;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const [posRes, ordRes] = await Promise.all([getPositions(), getOrders()]);
      const sideWord = s === 'buy' ? 'Long' : 'Short';
      const posMatch = posRes.success && posRes.positions.some((p) => {
        const sym = String(p.Symbol || '');
        const side = String(p.Side || '');
        return (!symbol || sym.indexOf(symbol) !== -1) && side.indexOf(sideWord) !== -1;
      });
      const ordMatch = ordRes.success && ordRes.orders.some((o) => {
        const sym = String(o.Symbol || '');
        const st = String(o.Status || '').toLowerCase();
        // "Working" = accepted, not yet filled; "Filled" = done — both are
        // proof the order reached the broker, which is all this confirms.
        return (!symbol || sym.indexOf(symbol) !== -1) && (st === 'filled' || st === 'working');
      });
      if (posMatch || ordMatch) {
        verified = true;
        verifyDetail = posMatch ? 'matching position found' : 'matching order found';
        break;
      }
    } catch (e) {
      // A read-back failure is not itself proof the order failed — the click
      // already happened — so this loop degrades to "could not confirm"
      // rather than throwing and masking whatever the click actually did.
      verifyDetail = `readback error: ${e && e.message}`;
    }
  }

  return {
    success: true,
    submittedLabel: clickResult.label,
    stopPrice: stopPrice != null ? Number(stopPrice) : null,
    targetPrice: targetPrice != null ? Number(targetPrice) : null,
    verified,
    verifyDetail,
  };
}

// 2026-08-18 BUG FIX (live, real money): this returned a hardcoded
// `success: true` regardless of whether any of the three sub-reads actually
// found their DOM tables. Callers therefore could not tell "positions table
// read, genuinely no open positions" apart from "positions table wasn't
// found at all" — both surfaced as an empty positions array. app/server.js's
// pollTVBrokerAccount() derived isFlat from exactly that array, so an
// unreadable table silently meant "flat", the fold's not-flat→flat
// transition never fired, and a real trading day recorded ZERO trades.
// `success` stays true for backward compatibility (it never meant anything
// stricter); the truth is now reported additively so callers can check it.
export async function getAccount({ autoRecover = true } = {}) {
  let recovery = null;
  // 2026-08-23: SELF-HEAL BEFORE READING. When the bottom panel is collapsed
  // TradingView unmounts every broker table, so they all read "unreadable" at
  // once. Because flatness is derived from the positions table, that
  // correctly but fatally shut the whole live feed down for a real session.
  // Re-mount first (expanding the panel), THEN read. Only positions and
  // orders are requested: they are the two the fold actually depends on, and
  // the summary has the header strip as a fallback — though in practice one
  // expand remounts all of them together. See ensurePanelTablesMounted.
  if (autoRecover) {
    try {
      const pre = await evaluate(mountedTablesJS());
      const panel = await evaluate(bottomPanelStateJS());
      // Repair when a table is missing OR the panel is collapsed. The second
      // condition matters even with the tables present: a collapsed panel is
      // not provably still updating them, and a stale positions table reads
      // as flat. See ensurePanelTablesMounted's requireExpanded note.
      const needsWork = (pre && (pre.positions === false || pre.orders === false))
        || !!(panel && panel.present && panel.collapsed);
      if (needsWork) recovery = await ensurePanelTablesMounted({ want: ['positions', 'orders'] });
    } catch (e) {
      recovery = { success: false, error: String((e && e.message) || e) };
    }
  }
  const [positions, orders, summary] = await Promise.all([
    getPositions(),
    getOrders(),
    getAccountSummary(),
  ]);
  const unreadable = [];
  if (!positions.success) unreadable.push('positions');
  if (!orders.success) unreadable.push('orders');
  if (!summary.success) unreadable.push('summary');
  return {
    success: true,
    degraded: unreadable.length > 0,
    unreadable,
    // Non-null only when a mount recovery was actually attempted this call,
    // so callers can log/surface "the feed healed itself" without guessing.
    recovery,
    summary,
    positions,
    orders,
  };
}

// ── Broker panel mounting + auto-recovery (2026-08-23, rev 2) ───────────────
// ROOT CAUSE, established by probing the LIVE DOM rather than by reasoning
// (2026-08-23, TradingView Desktop 3.3.0 / Electron 38):
//
//   The three broker tables live in the BOTTOM panel — the DOM subtree under
//   `[class*="layout__area--bottom"]`. When that panel is COLLAPSED,
//   TradingView unmounts its entire contents. What is left is a 38px title
//   bar containing a single button labelled with the broker name
//   ("Tradovate"). Collapsed, querySelector for any of the three tables
//   returns null — all three at once, which is the tell.
//
//   Measured live, before and after one click on that button:
//       layout__area--bottom clientHeight        38  ->  657
//       [class*="collapsed-"] present          true  ->  false
//       TRADOVATE.positions-table             absent ->  present
//       TRADOVATE.orders-table                absent ->  present
//       TRADOVATE.summary.accountSummary-table absent ->  present
//
// TWO EARLIER BELIEFS ABOUT THIS FILE ARE NOW SETTLED:
//
//  1. The file header's claim that "all tables exist in the DOM AT ONCE
//     regardless of which tab is showing" is CORRECT — but only while the
//     bottom panel is expanded. Orders and summary read fine with their tab
//     hidden (offsetParent === null yet fully in the DOM). Tab selection is
//     therefore NOT what governs readability; panel expansion is.
//
//  2. The first attempt at this fix (rev 1, same day) assumed per-tab lazy
//     mounting and clicked tabs inside `.trading-panel-content`. That
//     selector resolves to the RIGHT-HAND ORDER TICKET (Buy/Sell/Market/
//     Limit), not the bottom panel — so it searched the order ticket for a
//     "Positions" tab, found nothing, and reported "auto-repair failed"
//     while changing nothing. Wrong about both the mechanism and the
//     container. It is deleted, not patched.
//
// This has now cost two live sessions:
//   • 2026-08-19 — orders table read empty; worked around defensively in
//     app/server.js (ordersTableSuspect) with a manual "open the Orders tab".
//   • 2026-08-23 — all three tables unreadable for a full session. Flatness
//     derives from the positions table, so the feed correctly REFUSED to
//     fold (a wrong "flat" corrupts trade count, day P&L and size-after-loss
//     state) and every dependent guardrail went dark.
//
// STRATEGY — expand first, tab-click only as a fallback:
//   1. Report which wanted tables are actually in the DOM.
//   2. If any are missing, EXPAND the bottom panel (the fix in ~every case).
//   3. Re-check. If something is still missing, fall back to clicking that
//      table's tab — correctly scoped to the bottom panel this time.
//
// DELIBERATELY NEVER RE-COLLAPSES THE PANEL. Collapsing is what unmounts the
// tables; restoring that state would re-break the feed the instant we fixed
// it. The panel staying open is a hard requirement of reading the account,
// not a preference. Sub-tab selection IS restored, since that is cosmetic
// and costs nothing.
//
// SAFETY CONTRACT: every click is confined to the bottom panel's tab strip
// (`[class*="layout__area--bottom"]` and its tab controls). It excludes
// `menuButton*` (which opens a context menu) and anything not visible. It
// can never reach the order ticket, a buy/sell button, or anything that
// transmits. It is strictly read-enablement: if it cannot find a control it
// reports so and changes nothing, and callers keep their existing
// refuse-to-fold behaviour for whatever stays unreadable.

// Matched by SUFFIX so a non-Tradovate broker integration still resolves —
// the "TRADOVATE." prefix is TradingView's component name for this broker
// and would silently stop matching if the account were ever moved.
const PANEL_TABLES = {
  positions: 'positions-table',
  orders: 'orders-table',
  summary: 'accountSummary-table',
};

// Visible-text patterns per tab, lowercase substring. Loose on purpose: the
// live label is "Account summary" (lowercase s) and the panel appends counts
// like "Positions (1)".
const TAB_TEXT = {
  positions: ['position'],
  orders: ['order'],
  summary: ['account summary', 'summary'],
};

const BOTTOM_PANEL_SEL = '[class*="layout__area--bottom"]';

export function mountedTablesJS() {
  return `
(function() {
  var names = ${JSON.stringify(PANEL_TABLES)};
  var out = {};
  for (var k in names) {
    out[k] = !!document.querySelector('table[data-name$="' + names[k] + '"]');
  }
  return out;
})()
`;
}

// Diagnostic snapshot of the bottom panel, so callers (and the app's UI
// health check) can say "the panel is collapsed" specifically, instead of
// the useless generic "table not found".
export function bottomPanelStateJS() {
  return `
(function() {
  var root = document.querySelector('${BOTTOM_PANEL_SEL}');
  if (!root) return { present: false, collapsed: null, height: 0, brokerTab: null };
  var collapsedEl = root.querySelector('[class*="collapsed-"]');
  var brokerTab = null;
  var btns = Array.prototype.slice.call(root.querySelectorAll('[class*="tabbar-"] button'));
  for (var i = 0; i < btns.length; i++) {
    var tx = ((btns[i].innerText || btns[i].textContent || '') + '').trim();
    if (tx && tx.length < 40 && !/menuButton/.test((btns[i].className || '') + '')) { brokerTab = tx; break; }
  }
  return {
    present: true,
    collapsed: !!collapsedEl || root.clientHeight < 80,
    height: root.clientHeight,
    brokerTab: brokerTab
  };
})()
`;
}


// ── Opening the broker panel, robustly (2026-08-26) ─────────────────────────
// Anoop, shipping this to clients: "issue with live feed again, what is
// permanent fix? repair & recheck does not work again."
//
// expandBottomPanelJS below only ever looked INSIDE
// [class*="layout__area--bottom"] and clicked the first labelled button in its
// tab strip. Two ways that finds nothing, both of which end the session with a
// dark feed and a message telling the human to go clicking:
//
//   1. The bottom area is not in the layout AT ALL. When the trading panel is
//      fully closed (not merely collapsed) TradingView removes the container,
//      so `root` is null and the opener returns "bottom panel container not
//      found" without trying anything else.
//   2. The tab strip exists but its buttons are unlabelled, off-screen, or the
//      hashed class names moved. Every selector here is a wildcard match on a
//      third-party app's generated class names — they WILL move.
//
// So: several independent strategies, each verified by re-reading the panel
// state, stopping at the first that works. They are ordered cheapest-and-
// most-proven first, and every one is a no-op when the panel is already open,
// so running this on a healthy app cannot close anything.
export function openBrokerPanelJS() {
  return `
(function() {
  var tried = [];
  function panelState() {
    var r = document.querySelector('${BOTTOM_PANEL_SEL}');
    if (!r) return { present: false, collapsed: null, height: 0 };
    return {
      present: true,
      collapsed: !!r.querySelector('[class*="collapsed-"]') || r.clientHeight < 80,
      height: r.clientHeight
    };
  }
  function isOpen(st) { return st.present && st.collapsed === false; }
  function visible(el) {
    if (!el || el.offsetParent === null) return false;
    var b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  }
  function label(el) {
    return (((el.innerText || el.textContent || '') + ' ' +
             (el.getAttribute('aria-label') || '') + ' ' +
             (el.getAttribute('title') || '') + ' ' +
             (el.getAttribute('data-name') || '')) + '').trim();
  }

  var before = panelState();
  if (isOpen(before)) return { ok: true, already: true, strategy: null, before: before, after: before, tried: tried };

  function attempt(name, fn) {
    if (isOpen(panelState())) return true;
    var detail = null;
    try { detail = fn(); } catch (e) { detail = 'threw: ' + e.message; }
    tried.push({ strategy: name, detail: detail });
    return false;   // caller re-checks after a settle delay
  }

  // S1 — the original: the broker-name tab inside the bottom panel's own tab
  // strip. This is the one that has actually worked in the field, so it stays
  // first; everything below is a fallback for when the container is missing.
  attempt('bottom-tabbar-button', function() {
    var root = document.querySelector('${BOTTOM_PANEL_SEL}');
    if (!root) return 'no bottom panel container';
    var btns = Array.prototype.slice.call(root.querySelectorAll('[class*="tabbar-"] button'));
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i], tx = label(b);
      if (!tx || tx.length > 40) continue;
      if (/menuButton/.test((b.className || '') + '')) continue;
      if (!visible(b)) continue;
      b.click();
      return 'clicked "' + tx + '"';
    }
    return 'no labelled visible button in the tab strip';
  });

  // S2 — the bottom STATUS BAR toggle. When the panel is fully closed the
  // container is gone, so the only remaining control lives in TradingView's
  // bottom toolbar. Matched on accessible text rather than a hashed class,
  // which is the part most likely to survive a TradingView release.
  attempt('bottom-toolbar-toggle', function() {
    var bar = document.querySelector('[class*="bottom-widgetbar"], [class*="widgetbar-"], [class*="bottomWidgetBar"], footer');
    var scope = bar || document.body;
    var cands = Array.prototype.slice.call(scope.querySelectorAll('button, [role="button"], [data-name]'));
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i], tx = label(el);
      if (!visible(el)) continue;
      if (/trading\\s*panel|order\\s*panel|broker|tradovate|paper\\s*trading/i.test(tx)) {
        el.click();
        return 'clicked "' + tx.slice(0, 40) + '"';
      }
    }
    return 'no trading-panel toggle found in the bottom toolbar';
  });

  // S3 — anything anywhere that names the broker and looks clickable. Last
  // DOM resort, deliberately narrow on text so it cannot click a chart tool.
  attempt('document-wide-broker-control', function() {
    var cands = Array.prototype.slice.call(
      document.querySelectorAll('button, [role="tab"], [role="button"]'));
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i], tx = label(el);
      if (!tx || tx.length > 40 || !visible(el)) continue;
      if (/^(tradovate|paper trading|trading panel)$/i.test(tx.trim())) {
        el.click();
        return 'clicked "' + tx.trim() + '"';
      }
    }
    return 'no broker-named control anywhere in the document';
  });

  return { ok: false, already: false, before: before, after: panelState(), tried: tried };
})()
`;
}

// Everything the opener can see, for when it still fails. A repair that cannot
// explain itself is a support ticket; this turns the next occurrence into
// something diagnosable from a log instead of a screenshot.
export function panelDiagnosticsJS() {
  return `
(function() {
  function label(el) {
    return (((el.innerText || el.textContent || '') + ' ' +
             (el.getAttribute('aria-label') || '') + ' ' +
             (el.getAttribute('data-name') || '')) + '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  }
  var root = document.querySelector('${BOTTOM_PANEL_SEL}');
  var out = {
    url: location.href,
    bottomAreaPresent: !!root,
    bottomAreaHeight: root ? root.clientHeight : 0,
    bottomAreaClasses: root ? (root.className + '').slice(0, 200) : null,
    tabbarButtons: [],
    bottomBarControls: [],
    brokerNamedControls: []
  };
  if (root) {
    out.tabbarButtons = Array.prototype.slice
      .call(root.querySelectorAll('[class*="tabbar-"] button'))
      .slice(0, 12).map(function(b) { return { text: label(b), visible: b.offsetParent !== null }; });
  }
  var bar = document.querySelector('[class*="bottom-widgetbar"], [class*="widgetbar-"], footer');
  if (bar) {
    out.bottomBarControls = Array.prototype.slice
      .call(bar.querySelectorAll('button, [role="button"], [data-name]'))
      .slice(0, 20).map(function(b) { return { text: label(b), visible: b.offsetParent !== null }; });
  }
  out.brokerNamedControls = Array.prototype.slice
    .call(document.querySelectorAll('button, [role="tab"], [role="button"]'))
    .filter(function(el) { return /tradovate|paper trading|trading panel|broker/i.test(label(el)); })
    .slice(0, 12).map(function(b) { return { text: label(b), visible: b.offsetParent !== null }; });
  return out;
})()
`;
}

// Expands the bottom panel by clicking the broker-name tab in its tab strip.
// That button is a toggle: clicking it while collapsed expands it. We only
// ever click it after confirming the panel IS collapsed, so it can never be
// the thing that collapses it.
export function expandBottomPanelJS() {
  return `
(function() {
  var root = document.querySelector('${BOTTOM_PANEL_SEL}');
  if (!root) return { ok: false, error: 'bottom panel container not found' };
  var collapsed = !!root.querySelector('[class*="collapsed-"]') || root.clientHeight < 80;
  if (!collapsed) return { ok: true, already: true, height: root.clientHeight };
  var heightBefore = root.clientHeight;
  var btns = Array.prototype.slice.call(root.querySelectorAll('[class*="tabbar-"] button'));
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    var tx = ((b.innerText || b.textContent || '') + '').trim();
    if (!tx || tx.length > 40) continue;                        // unlabelled/fake tab
    if (/menuButton/.test((b.className || '') + '')) continue;   // opens a menu, not a toggle
    if (b.offsetParent === null) continue;                       // not visible
    b.click();
    return { ok: true, already: false, clicked: tx, heightBefore: heightBefore };
  }
  return { ok: false, error: 'no labelled broker tab button in the bottom tab strip' };
})()
`;
}

// Clicks a sub-tab (Positions / Orders / Account summary) inside the bottom
// panel. Fallback only — with the panel expanded all three tables are
// normally mounted regardless of which sub-tab is selected.
export function clickPanelTabJS(patterns) {
  return `
(function() {
  var pats = ${JSON.stringify(patterns)};
  var root = document.querySelector('${BOTTOM_PANEL_SEL}');
  if (!root) return { ok: false, error: 'bottom panel container not found' };
  var cands = Array.prototype.slice.call(
    root.querySelectorAll('[role="tab"], button, [class*="roundTabButton"]')
  );
  function textOf(el) { return ((el.innerText || el.textContent || '') + '').trim().toLowerCase(); }
  function isActive(el) {
    var c = (el.className || '') + '';
    return el.getAttribute('aria-selected') === 'true' || c.indexOf('active') !== -1 || c.indexOf('selected') !== -1;
  }
  var prevActive = null;
  for (var i = 0; i < cands.length; i++) {
    if (isActive(cands[i])) { var t = textOf(cands[i]); if (t && t.length <= 40) { prevActive = t; break; } }
  }
  for (var p = 0; p < pats.length; p++) {
    for (var j = 0; j < cands.length; j++) {
      var el = cands[j];
      var txt = textOf(el);
      if (!txt || txt.length > 40) continue;                       // a container, not a tab
      if (/menuButton/.test((el.className || '') + '')) continue;   // opens a menu
      if (txt.indexOf(pats[p]) === -1) continue;
      if (el.offsetParent === null) continue;                       // not visible
      el.click();
      return { ok: true, clicked: txt, prevActive: prevActive };
    }
  }
  return { ok: false, error: 'no visible bottom-panel tab matched: ' + pats.join(', '), prevActive: prevActive };
})()
`;
}

// Ensure every panel table the caller needs is mounted in the DOM. Returns
// what was missing, what was recovered, what is still missing, and enough
// diagnostics for the UI to tell the human something actionable.
export async function ensurePanelTablesMounted({ want, requireExpanded = true } = {}) {
  const keys = Array.isArray(want) && want.length ? want : Object.keys(PANEL_TABLES);
  const before = await evaluate(mountedTablesJS());
  const missing = keys.filter((k) => before && before[k] === false);
  const panelBefore = await evaluate(bottomPanelStateJS());

  // WHY `requireExpanded` DEFAULTS TO TRUE — measured 2026-08-23:
  // Collapsing the panel does NOT immediately unmount the tables; once
  // rendered they persist in the DOM. The real lifecycle is "lazy mount on
  // FIRST expand, then persist", which is exactly how a whole session went
  // dark: the panel had been collapsed since launch, so the tables were
  // never rendered even once.
  //
  // That leaves a question that could NOT be settled from a flat, idle
  // account: does a collapsed panel keep receiving updates, or does its DOM
  // freeze at the last rendered values? Sampling it 12s apart showed no
  // change, which proves nothing either way with no position open.
  //
  // Presence is therefore NOT accepted as sufficient. A frozen positions
  // table reads as "no open positions" — i.e. FLAT — and a false flat is the
  // precise corruption this whole guard exists to prevent (it fabricates a
  // round trip, mis-scores day P&L, and unlocks size-after-loss). Requiring
  // the panel expanded costs screen space; assuming liveness we cannot
  // demonstrate costs real money. Callers that only want presence (a
  // diagnostic, a test) can opt out with requireExpanded: false.
  const needExpand = !!(requireExpanded && panelBefore && panelBefore.present && panelBefore.collapsed);

  if (!missing.length && !needExpand) {
    return {
      success: true, alreadyMounted: true, missing: [], recovered: [],
      stillMissing: [], expanded: null, clicks: [], panelBefore, panelAfter: panelBefore,
      diagnostics: null,
    };
  }

  // STEP 1 — open the bottom panel. This is the actual fix in essentially
  // every observed case: it both mounts tables that were never rendered and
  // guarantees the ones already there are being kept current.
  //
  // 2026-08-26: runs whenever the panel is not demonstrably OPEN, not only
  // when it is present-and-collapsed. A panel that is fully closed has no
  // container at all, so `panelBefore.present` is false — and the old guard
  // skipped the repair entirely in exactly the case that needs it most,
  // which is how "auto-repair could not do it" was reached with no repair
  // ever attempted. Each strategy inside openBrokerPanelJS is a no-op when
  // the panel is already open, so widening this cannot close anything.
  let expanded = null;
  const panelNotOpen = !panelBefore || !panelBefore.present || panelBefore.collapsed !== false;
  if (panelNotOpen) {
    expanded = await evaluate(openBrokerPanelJS());
    await new Promise((r) => setTimeout(r, 900)); // let the panel render its tables

    // STEP 1b — KEYBOARD FALLBACK. Every strategy above matches a
    // third-party app's DOM; when TradingView reshuffles its markup they all
    // miss at once. Alt+T is TradingView's own Trading Panel toggle and goes
    // through the app's shortcut handler rather than our selectors, so it is
    // the one route that does not depend on class names we do not own.
    //
    // Strictly gated on the panel still not being open, because this IS a
    // toggle: firing it against an open panel would close the thing we are
    // trying to open.
    const afterDom = await evaluate(bottomPanelStateJS());
    const stillShut = !afterDom || !afterDom.present || afterDom.collapsed !== false;
    if (stillShut) {
      try {
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 1, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84 });
        await new Promise((r) => setTimeout(r, 900));
        const afterKey = await evaluate(bottomPanelStateJS());
        expanded = Object.assign({}, expanded || {}, {
          keyboardFallback: { tried: true, opened: !!(afterKey && afterKey.present && afterKey.collapsed === false) },
        });
      } catch (e) {
        expanded = Object.assign({}, expanded || {}, { keyboardFallback: { tried: true, error: e.message } });
      }
    }
  }

  let after = await evaluate(mountedTablesJS());
  let stillMissing = keys.filter((k) => after && after[k] === false);

  // STEP 2 — fallback: if something is STILL unmounted with the panel open,
  // try selecting its own tab. Not expected to be needed; kept because the
  // 2026-08-19 orders incident predates this understanding and a cheap
  // second attempt beats a dark feed.
  const clicks = [];
  let restoreTo = null;
  if (stillMissing.length) {
    for (const key of stillMissing) {
      const res = await evaluate(clickPanelTabJS(TAB_TEXT[key] || [key]));
      clicks.push(Object.assign({ table: key }, res || { ok: false, error: 'evaluate returned nothing' }));
      // Only the FIRST click sees the human's real tab; after that "previous"
      // is a tab we selected ourselves.
      if (restoreTo == null && res && res.prevActive) restoreTo = res.prevActive;
      await new Promise((r) => setTimeout(r, 400));
    }
    after = await evaluate(mountedTablesJS());
    stillMissing = keys.filter((k) => after && after[k] === false);
  }

  const recovered = missing.filter((k) => stillMissing.indexOf(k) === -1);

  // 2026-08-26: when repair genuinely could not do it, dump what the opener
  // could see. Without this the only evidence is a screenshot of a red box,
  // and the selectors this depends on live in someone else's app — the next
  // break needs to be diagnosable from a log, not reproduced live.
  let diagnostics = null;
  if (stillMissing.length) {
    try { diagnostics = await evaluate(panelDiagnosticsJS()); } catch (e) { diagnostics = { error: e.message }; }
  }

  // Restore the sub-tab the human had selected — cosmetic only, and
  // deliberately non-fatal: failing to restore a tab must never turn a
  // successful recovery into a reported failure. The PANEL is never
  // re-collapsed; that would unmount the tables again.
  let restored = null;
  if (restoreTo) {
    try {
      const r = await evaluate(clickPanelTabJS([restoreTo]));
      restored = !!(r && r.ok);
    } catch (e) { restored = false; }
  }

  const panelAfter = await evaluate(bottomPanelStateJS());

  return {
    success: stillMissing.length === 0,
    alreadyMounted: false,
    missing,
    recovered,
    stillMissing,
    expanded,
    clicks,
    restoredTab: restoreTo,
    restored,
    panelBefore,
    panelAfter,
    // 2026-08-26: what the opener could see when it still failed. Null on
    // success — a healthy repair should not carry a DOM dump around.
    diagnostics,
  };
}

// ── Forcing ONE table to actually render its rows (2026-09-02) ──────────────
//
// A THIRD failure mode, distinct from the two above and invisible to both.
//
//   collapsed panel  -> the table is not in the DOM at all      (fixed 2026-08-23)
//   tab never opened -> the table is not in the DOM at all      (fixed 2026-09-01, summary)
//   tab not SHOWING  -> the table IS in the DOM, with ZERO ROWS  <- this
//
// ensurePanelTablesMounted answers "is `table[data-name$=orders-table]` in the
// document", and for this fault the answer is YES. The <table> is mounted, its
// <thead> is correct, and its <tbody> is empty because ka-table only renders
// body rows for the visible tab. Every presence check passes while the read
// returns nothing.
//
// WHAT IT COST. app/server.js flags `ordersTableSuspect` on exactly this shape
// (orders empty while a position is open) and then degrades: the order-history
// walk is dropped, `closedRoundTrips` goes null, and every close falls to the
// balance-delta fold — which knows the money and nothing else. Those rows are
// written with `xp: null`, so from 2026-09-01 the app had no exit price for any
// trade, and the post-exit drift panel sat anchored on 2026-08-31's 29406.5 for
// two days while reporting it as current.
//
// WHY IT CLICKS AND THEN CLICKS BACK. Only the showing tab renders rows, so all
// three cannot be live at once — there is no arrangement of the panel that
// makes this go away. The read therefore borrows the tab: select Orders, let it
// render, read it, put his tab back. Restoration is NOT cosmetic here (unlike
// ensurePanelTablesMounted's, which is): leaving Orders selected would silently
// stop the positions table from updating, and a stale positions table reads as
// FLAT — the exact corruption the 2026-08-23 note calls out as worse than a
// visible failure. So the tab always goes back, including on the throw path.
//
// DELIBERATELY NOT CALLED ON EVERY POLL. The panel visibly flickers, and at the
// 10s account cadence that is unusable. Callers fire it when the answer matters
// and not otherwise (app/server.js: on the suspect shape, under panel-repair.js's
// cooldown/ceiling/escalation budget). It never re-collapses the panel and it
// never touches the order ticket — same safety contract as everything above.
//
// Returns the FRESH read plus what it did, so a caller that gets `ok: false`
// can keep its existing refuse-to-trust behaviour rather than acting on a table
// it has no evidence rendered.
// 2026-09-02 (same day, second fault): POSITIONS has the identical problem and
// it is the more dangerous of the two. The oversize guard sends a reducing
// order, then re-reads the positions table to confirm the position shrank. With
// that table not re-rendering, the confirmation read returns the PRE-ORDER size
// forever — so a reduction that actually worked looks like one that did nothing,
// the guard hits its "one outstanding reduction at a time" refusal, and reports
// STUCK. That happened twice on 2026-09-02 (11:56 and 12:30) and ended with the
// guard switched off for the session, leaving size unenforced against a broker
// ceiling of 40 micros and a cap of 2.
//
// The guard's refusal is CORRECT and stays exactly as it is — a stale read is
// precisely when it must not send more (six reductions on a stale read flipped a
// long to a short on 2026-08-31). What was wrong is the EVIDENCE it refuses on.
// This gives it a genuinely re-rendered read to judge, so STUCK means the
// position really did not move rather than the DOM not repainting.
const REFRESHABLE = {
  orders: { dataName: 'TRADOVATE.orders-table', tabText: TAB_TEXT.orders },
  positions: { dataName: 'TRADOVATE.positions-table', tabText: TAB_TEXT.positions },
};

export async function refreshPanelTable({ table = 'orders', settleMs = 700 } = {}) {
  const spec = REFRESHABLE[table];
  if (!spec) return { ok: false, error: 'unknown table: ' + table };
  const before = await readTable(spec.dataName);
  const mounted = await evaluate(mountedTablesJS());

  // The panel must be open first — with it collapsed there is no tab to click
  // and no rows to render. Reuses the proven opener rather than a second one.
  const panel = await evaluate(bottomPanelStateJS());
  let opened = null;
  if (!panel || !panel.present || panel.collapsed !== false) {
    opened = await evaluate(openBrokerPanelJS());
    await new Promise((r) => setTimeout(r, 900));
  }

  let click = null;
  let restored = null;
  let after = before;
  try {
    click = await evaluate(clickPanelTabJS(spec.tabText));
    if (click && click.ok) {
      await new Promise((r) => setTimeout(r, settleMs));
      after = await readTable(spec.dataName);
    }
  } finally {
    // ALWAYS, even if the read above threw. A tab left on Orders freezes the
    // positions table, and a frozen positions table reads as flat.
    if (click && click.ok && click.prevActive) {
      try {
        const r = await evaluate(clickPanelTabJS([click.prevActive]));
        restored = !!(r && r.ok);
      } catch (e) { restored = false; }
    }
  }

  const rows = after.rows.map((r) => r.row);
  return {
    // ok means: the tab was clicked AND the table now shows either real rows
    // or TradingView's explicit "no data" placeholder. An empty table with no
    // placeholder is the unrendered shape again — not evidence of zero orders.
    ok: !!(click && click.ok) && (rows.length > 0 || !!after.emptyStateText),
    table,
    mountedBefore: mounted ? mounted[table] : null,
    rowsBefore: before.rows.length,
    rowsAfter: rows.length,
    emptyStateText: after.emptyStateText,
    opened,
    click,
    restoredTab: click && click.prevActive ? click.prevActive : null,
    restored,
    rows,
    // Kept under its original name so the orders callers written earlier today
    // keep working unchanged.
    orders: table === 'orders' ? rows : undefined,
    positions: table === 'positions' ? rows : undefined,
  };
}

// The original orders-only entry point, now a thin wrapper. Callers added on
// 2026-09-02 use this name and there is no reason to churn them.
export async function refreshOrdersTable(opts = {}) {
  return refreshPanelTable(Object.assign({}, opts, { table: 'orders' }));
}
