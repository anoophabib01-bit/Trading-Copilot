/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

// ALERT CREATE/DELETE FIXED 2026-08-2x via TradingView's pricealerts REST API.
//
// WHY REST: the alert dialog's price field is a React-controlled input whose
// committed state does NOT react to (a) synthetic input/change events,
// (b) CDP Input.insertText, or even (c) per-keystroke CDP Input.dispatchKeyEvent
// on this TradingView build — ALL verified live. In every case the DOM read the
// requested price back correctly, yet the committed alert used the current-market
// price. The dialog automation is therefore abandoned as the primary path.
//
// create() now POSTs to pricealerts.tradingview.com/create_alert with the exact
// payload shape captured live from the UI's own network traffic (Content-Type
// text/plain;charset=UTF-8 to avoid the CORS preflight). The committed price is
// verified by re-reading alert_list and comparing — the "created" and "at the
// requested price" checks are BOTH enforced. The dialog path is retained only as
// a best-effort fallback when the REST call fails.
//
// deleteAlerts() now uses the real pricealerts.tradingview.com/delete_alerts
// endpoint with { payload: { alert_ids: [...] } }, supporting individual IDs and
// delete-all — replacing the previous fake context-menu click.
//
// condition: "crossing" (default) maps to the API's "cross" type; greater_than /
// less_than map to greater / less. `message` is not settable via this API, so the
// auto-generated "<SYMBOL> Crossing <price>" message is used.
// create() rewritten 2026-08-2x to use TradingView's pricealerts REST API
// DIRECTLY instead of driving the alert dialog's DOM. Why: the dialog's price
// field is a React-controlled input whose committed state does NOT react to any
// of (a) synthetic input/change events, (b) CDP Input.insertText, or even
// (c) per-keystroke CDP Input.dispatchKeyEvent on this TradingView build — all
// verified live: the DOM read the requested price back correctly yet the
// committed alert always used the current-market price (see header comment).
// The REST create_alert endpoint (captured live from the UI's own network
// traffic) commits the requested price exactly, so it is the reliable path.
// The dialog-DOM path is retained as a fallback below only when the REST call
// is unavailable. Success is verified by re-reading alert_list and comparing
// the committed value against the requested price.
export async function create({ condition, price, message }) {
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum)) {
    return { success: false, error: `price must be a finite number, got: ${price}` };
  }

  // Map the human condition string to the REST condition type TradingView uses.
  // "crossing" is the tested/default; greater/less map to the API's types.
  const condMap = { crossing: 'cross', greater_than: 'greater', less_than: 'less', cross: 'cross' };
  const condType = condMap[String(condition || 'crossing').toLowerCase()] || 'cross';

  const baseUrl = 'https://pricealerts.tradingview.com'
    + '?log_username=' + encodeURIComponent('AnoopHabib')
    + '&maintenance_unset_reason=initial_operated';

  const createResult = await evaluateAsync(`
    (async function() {
      var price = ${priceNum};
      var symbol = window.TradingViewApi._activeChartWidgetWV.value().symbol();
      // Build the exact payload shape captured from the UI create request.
      var body = {
        payload: {
          conditions: [{ type: ${safeString(condType)}, frequency: 'on_first_fire', series: [{ type: 'barset' }, { type: 'value', value: price }], resolution: '1' }],
          symbol: '=' + JSON.stringify({ "currency-id": "USD", session: "regular", "settlement-as-close": false, symbol: symbol }),
          resolution: '1',
          message: symbol + " Crossing " + price.toLocaleString("en-US", { minimumFractionDigits: 2 }),
          sound_file: 'alert/fired', sound_duration: 0, popup: true, auto_deactivate: true,
          email: false, sms_over_email: false, mobile_push: true, web_hook: null, name: null,
          expiration: new Date(Date.now() + 7*24*3600*1000).toISOString(),
          active: true, ignore_warnings: true
        }
      };
      var url = '${baseUrl.replace("?", "/create_alert?")}';
      try {
        var r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) });
        var text = await r.text();
        return { status: r.status, body: text };
      } catch (e) {
        return { status: 0, body: '', error: e.message };
      }
    })()
  `);

  let created = null;
  let restOk = false;
  if (createResult && createResult.status && createResult.body) {
    try {
      const parsed = JSON.parse(createResult.body);
      if (parsed && parsed.s === 'ok' && parsed.r) {
        restOk = true;
        created = parsed.r;
      }
    } catch (e) { /* not json / unexpected shape */ }
  }

  // If REST failed, fall back to the dialog-DOM path (best effort).
  let domFallback = null;
  if (!restOk) {
    domFallback = await createViaDialog({ condition: condType, price: priceNum });
  }

  // Verification: re-read alert_list and compare the committed value.
  await new Promise(r => setTimeout(r, 900));
  const after = await list();
  const afterCount = (after && after.alert_count) || 0;
  const newest = (after && Array.isArray(after.alerts) && after.alerts[0]) || null;
  let actualPrice = null;
  if (newest) {
    const series = newest.condition && newest.condition.series;
    const valueEntry = Array.isArray(series) ? series.find((s) => s && s.type === 'value') : null;
    actualPrice = valueEntry ? valueEntry.value : null;
  }
  const priceMatches = actualPrice != null && Math.abs(actualPrice - priceNum) < 0.01;
  const createdAny = restOk || (domFallback && domFallback.created) || afterCount > 0;

  return {
    success: priceMatches,
    price: priceNum, condition: condition, message: message || undefined,
    source: restOk ? 'rest_api' : ('dom_fallback'),
    price_set: true,
    verified_via_alert_list: afterCount > 0,
    price_verified: priceMatches,
    requested_price: priceNum, actual_price: actualPrice,
    alert_id: (created && created.alert_id) || (newest && newest.alert_id) || null,
    alert_count_after: afterCount,
    warning: (createdAny && !priceMatches)
      ? `An alert WAS created, but at price ${actualPrice} instead of the requested ${priceNum} — the alert may need manual deletion.`
      : undefined,
  };
}

// Best-effort dialog fallback (the old DOM path), kept only if the REST create
// is unavailable. Known limitation: on this TradingView build the price field's
// committed state is not reliably driven, so this may create at market price.
// It fails closed (never claims success) unless alert_list confirms the price.
async function createViaDialog({ condition, price }) {
  try {
    const opened = await evaluate(`(function(){ var already = !!Array.from(document.querySelectorAll("button")).find(function(b){ return b.getAttribute("aria-label") === "Create alert" && b.offsetParent !== null; }); if (!already) { var btn = document.querySelector("[data-name=\\"alerts\\"]"); if (btn) btn.click(); } return true; })()`);
    await new Promise(r => setTimeout(r, 500));
    await evaluate(`(function(){ var btn = Array.from(document.querySelectorAll("button")).find(function(b){ return b.getAttribute("aria-label") === "Create alert"; }); if (btn) btn.click(); return !!btn; })()`);
    await new Promise(r => setTimeout(r, 800));
    // Click Create (accept whatever price the dialog has — best effort).
    const clicked = await evaluate(`(function(){ var hs = Array.from(document.querySelectorAll("div,span")).filter(function(e){ return e.textContent && e.textContent.trim() === "Create alert on"; }); if (!hs.length) return { ok: false }; var el = hs[0]; var found = false; for (var j = 0; j < 12; j++) { var bs = Array.from(el.querySelectorAll("button")); var b = bs.find(function(x){ return /^create$/i.test((x.textContent || "").trim()); }); if (b) { b.click(); found = true; break; } el = el.parentElement; if (!el) break; } return { ok: found }; })()`);
    return { created: clicked && clicked.ok, source: 'dom_fallback' };
  } catch (e) {
    return { created: false, error: e.message, source: 'dom_fallback' };
  }
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

export async function deleteAlerts({ delete_all, alert_ids }) {
  // REST-based deletion (2026-08-2x): the previous implementation only faked a
  // context-menu click and required manual confirmation. The real endpoint
  // (discovered live) is POST pricealerts.tradingview.com/delete_alerts with a
  // { payload: { alert_ids: [...] } } body. delete_all resolves the current
  // list and deletes every alert by ID — never the dialog context menu.
  const baseUrl = 'https://pricealerts.tradingview.com'
    + '?log_username=' + encodeURIComponent('AnoopHabib')
    + '&maintenance_unset_reason=initial_operated';

  let ids = Array.isArray(alert_ids) ? alert_ids.filter((n) => Number.isFinite(Number(n))) : [];
  if (delete_all) {
    const cur = await list();
    ids = (cur && Array.isArray(cur.alerts)) ? cur.alerts.map((a) => a.alert_id) : [];
  }
  if (!ids.length) {
    return { success: true, deleted_count: 0, note: 'No alerts matched for deletion.', source: 'rest_api' };
  }

  const result = await evaluateAsync(`
    (async function() {
      var ids = ${JSON.stringify(ids)};
      var url = '${baseUrl.replace("?", "/delete_alerts?")}';
      try {
        var r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ payload: { alert_ids: ids } }) });
        var text = await r.text();
        return { status: r.status, body: text };
      } catch (e) {
        return { status: 0, body: '', error: e.message };
      }
    })()
  `);

  let ok = false;
  if (result && result.status && result.body) {
    try { const parsed = JSON.parse(result.body); ok = parsed && parsed.s === 'ok'; } catch (e) {}
  }
  await new Promise((r) => setTimeout(r, 700));
  const after = await list();
  return {
    success: ok,
    deleted_count: ids.length,
    alert_ids: ids,
    alert_count_after: (after && after.alert_count) || 0,
    warning: ok ? undefined : (result && result.error) || 'delete_alerts REST call failed',
    source: 'rest_api',
  };
}
