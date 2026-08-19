/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

// PARTIALLY FIXED 2026-08-17 — DIALOG-OPENING IS FIXED AND VERIFIED LIVE;
// PRICE-SETTING IS STILL BROKEN. Do not trust the price on any alert this
// creates until the TODO below is actually done.
//
// Fixed and confirmed live: (1) the original code looked for
// `[aria-label="Create Alert"]` (capital A) but the real button's
// aria-label is "Create alert" (lowercase a) — pure case-sensitivity miss;
// (2) that button only exists once the Alerts PANEL is open
// (`[data-name="alerts"]` toggles it) — clicking it cold did nothing. Both
// fixed; the dialog now opens reliably every time, confirmed via alert_count
// increasing on every attempt.
//
// STILL BROKEN — price is silently wrong on every alert created so far
// (three live test alerts confirmed: requested 31500/31750/31750, all three
// were created at whatever the CURRENT MARKET PRICE was at click time
// instead — see IDs 5392178384, 5392204198, 5392211739 on the real account,
// need manual deletion, NOT via delete_all which would wipe legitimate
// alerts too). Root cause, confirmed by direct testing: the native-setter +
// input/change/blur/Enter event sequence that works for every OTHER
// TradingView input in this codebase (qty, TP/SL — see trading.js) does
// NOT work here. `input.value` reads back correctly in the DOM right after
// setting it, but the alert that actually gets created uses the ORIGINAL
// pre-edit value regardless — meaning this specific component's React state
// is not listening to standard synthetic events at all, unlike every other
// input tested in this codebase. Real fix needs actual per-keystroke input
// simulation via CDP's Input.dispatchKeyEvent (character by character, not
// a single value-set), not yet attempted. DO NOT wire this into anything
// that acts on the created alert's price until that's done and re-verified.
//
// Also not done: `condition` (crossing/greater_than/less_than) is a
// dropdown, not touched — every alert uses whatever the dialog defaults to.
// `message` custom text was not confirmed reachable (no separate editable
// field found). Verifies success via alert_count before/after — but "an
// alert was created" and "at the requested price" are NOT the same thing
// right now; only the former is actually verified.
export async function create({ condition, price, message }) {
  const before = await list();
  const beforeCount = (before && before.alert_count) || 0;

  const openCreateDialog = async () => {
    const already = await evaluate(`!!Array.from(document.querySelectorAll('button')).find(function(b){ return b.getAttribute('aria-label') === 'Create alert' && b.offsetParent !== null; })`);
    if (!already) {
      await evaluate(`(function(){ var btn = document.querySelector('[data-name="alerts"]'); if (btn) btn.click(); return !!btn; })()`);
      await new Promise(r => setTimeout(r, 400));
    }
    return evaluate(`(function(){ var btn = Array.from(document.querySelectorAll('button')).find(function(b){ return b.getAttribute('aria-label') === 'Create alert'; }); if (btn) { btn.click(); return true; } return false; })()`);
  };

  const opened = await openCreateDialog();
  if (!opened) return { success: false, error: 'Could not find the "Create alert" button — the Alerts panel toggle or dialog structure may have changed.', source: 'dom_fallback' };
  await new Promise(r => setTimeout(r, 600));

  // BUGFIX (2026-08-17, found by live-testing this exact fix): setting the
  // price and clicking Create as TWO SEPARATE evaluate() calls left a race —
  // the first live test reported priceSet:true and created:true, but the
  // alert that actually got created was at TradingView's DEFAULT price
  // (current market price), not the one requested. Exactly the same class of
  // bug as the qty-input race documented in trading.js's setQtyJs comment.
  // Fixed the same way: set price, VERIFY it read back correctly, THEN click
  // Create — all in ONE evaluate() call, so there is no gap for a re-render
  // to reset the field between setting it and submitting. Fails closed
  // (never clicks Create) if the read-back doesn't match.
  const priceStr = String(price);
  const result = await evaluate(`
    (function() {
      var headers = Array.from(document.querySelectorAll('div,span')).filter(function(e){ return e.textContent && e.textContent.trim() === 'Create alert on'; });
      if (!headers.length) return { ok: false, error: 'alert dialog not found' };
      var dialog = headers[0];
      for (var i = 0; i < 10; i++) {
        if (dialog.querySelectorAll('input').length > 0) break;
        dialog = dialog.parentElement;
        if (!dialog) return { ok: false, error: 'price input container not found' };
      }
      var input = dialog.querySelector('input');
      if (!input) return { ok: false, error: 'price input not found' };
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${safeString(priceStr)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (input.value !== ${safeString(priceStr)}) {
        return { ok: false, error: 'price field read back "' + input.value + '" after setting "${priceStr}" — refusing to submit', confirmValue: input.value };
      }
      // Re-find the button container (walking from the header again, not a
      // stale reference) — dialog may have re-rendered once between the
      // input search above and here, same defensive pattern as elsewhere.
      var btnDialog = headers[0];
      for (var j = 0; j < 12; j++) {
        var btns = Array.from(btnDialog.querySelectorAll('button'));
        var createBtn = btns.find(function(b){ return /^create$/i.test((b.textContent || '').trim()); });
        if (createBtn) { createBtn.click(); return { ok: true, confirmValue: input.value }; }
        btnDialog = btnDialog.parentElement;
        if (!btnDialog) return { ok: false, error: 'Create button not found', confirmValue: input.value };
      }
      return { ok: false, error: 'Create button not found after 12 levels', confirmValue: input.value };
    })()
  `);
  if (!result || !result.ok) {
    return { success: false, error: (result && result.error) || 'unknown failure setting price / clicking Create', price, condition, confirmValue: result && result.confirmValue, source: 'dom_fallback' };
  }

  await new Promise(r => setTimeout(r, 800));
  const after = await list();
  const afterCount = (after && after.alert_count) || 0;
  const countIncreased = afterCount > beforeCount;

  // 2026-08-17: count-increasing is NOT sufficient — see header comment,
  // three live tests each created an alert at the wrong (current-market)
  // price despite this. alert_list returns the ACTUAL committed price, so
  // compare it against what was requested and fail loudly if they disagree,
  // rather than report success on a wrong alert the way earlier versions did.
  let priceMatches = false, actualPrice = null;
  if (countIncreased && after && Array.isArray(after.alerts) && after.alerts.length) {
    const newest = after.alerts[0]; // most recently created appears first
    const series = newest.condition && newest.condition.series;
    const valueEntry = Array.isArray(series) ? series.find((s) => s && s.type === 'value') : null;
    actualPrice = valueEntry ? valueEntry.value : null;
    priceMatches = actualPrice != null && Math.abs(actualPrice - Number(price)) < 0.01;
  }

  return {
    success: countIncreased && priceMatches,
    price, condition, message: message || '(not set — see header comment)',
    price_set: true,
    verified_via_alert_list: countIncreased,
    price_verified: priceMatches,
    requested_price: Number(price), actual_price: actualPrice,
    warning: countIncreased && !priceMatches
      ? `An alert WAS created, but at price ${actualPrice} instead of the requested ${price} — see this file's header comment. Delete it manually (not via delete_all).`
      : undefined,
    alert_count_before: beforeCount, alert_count_after: afterCount,
    source: 'dom_fallback',
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all }) {
  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Use delete_all: true.');
}
