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
import { evaluate } from '../connection.js';

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
export async function getAccount() {
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
    summary,
    positions,
    orders,
  };
}
