/**
 * Core chart control logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite } from '../connection.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
  };
}

// 2026-08-18: fixed a live bug — with a multi-pane layout open (2+ charts
// side by side, e.g. MNQ + MGC), CHART_API always reads whichever pane
// TradingView itself currently considers "active" (last clicked/focused),
// NOT necessarily the pane the caller actually wants. A stale/broken pane
// (e.g. showing "This symbol doesn't exist") could silently be read instead
// of the live one sitting right next to it. getState now: (1) accepts an
// optional pane_index to target a specific pane explicitly, bypassing the
// "active" pointer entirely; (2) when no pane_index is given and more than
// one pane exists, cross-checks the active pane against all panes and flags
// it (multi_pane_layout + all_panes) rather than trusting it blindly, so a
// caller in app/server.js can detect and correct instead of acting on a
// dead chart.
export async function getState({ pane_index, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const targetExpr = (pane_index !== undefined && pane_index !== null)
    ? `window.TradingViewApi._chartWidgetCollection.getAll()[${Number(pane_index)}]`
    : CHART_API;
  const state = await evaluate(`
    (function() {
      var chart = ${targetExpr};
      if (!chart) return { error: 'pane_index out of range' };
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      var barCount = -1;
      try {
        var model = chart.model ? chart.model() : null;
        var mainSeries = model ? model.mainSeries() : null;
        barCount = mainSeries ? mainSeries.bars().size() : -1;
      } catch(e) {}

      // Multi-pane awareness: report every pane's symbol/bar-count so a
      // caller can tell "active" apart from "the pane I actually meant".
      var cwc = window.TradingViewApi._chartWidgetCollection;
      var all = cwc.getAll();
      var panes = [];
      if (all.length > 1) {
        for (var i = 0; i < all.length; i++) {
          try {
            var c = all[i];
            var m = c.model ? c.model() : null;
            var ms = m ? m.mainSeries() : null;
            panes.push({ index: i, symbol: ms ? ms.symbol() : null, bar_count: ms ? ms.bars().size() : -1 });
          } catch(e) { panes.push({ index: i, error: e.message }); }
        }
      }

      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
        bar_count: barCount,
        multi_pane_layout: all.length > 1,
        all_panes: panes,
      };
    })()
  `);
  if (state && state.error) throw new Error(state.error);

  // bar_count === 0 on the pane actually being read is exactly the "This
  // symbol doesn't exist" / broken-pane symptom reported live 2026-08-18.
  // Auto-correct (per user decision 2026-08-18): if the caller didn't pin a
  // specific pane_index and the "active" pane is dead, but another pane in
  // the same layout has real data, transparently re-read from that pane
  // instead of returning a symbol string that looks fine but has no data
  // behind it. Always reported via auto_corrected_from_active so a caller
  // can tell this happened rather than assuming "active" was honored.
  if ((pane_index === undefined || pane_index === null) && state && state.bar_count === 0 && state.multi_pane_layout) {
    const alt = (state.all_panes || []).find(p => typeof p.bar_count === 'number' && p.bar_count > 0);
    if (alt) {
      const corrected = await getState({ pane_index: alt.index, _deps });
      return { ...corrected, auto_corrected_from_active: true, dead_pane_index: state.all_panes.findIndex(p => p.bar_count === 0) };
    }
  }

  const warning = (state && state.bar_count === 0)
    ? 'This pane has 0 bars — likely a broken/invalid symbol pane, not live data. If a multi-pane layout is open, check all_panes for one with a real bar_count and pass its index as pane_index.'
    : undefined;
  return { success: true, ...state, ...(warning ? { warning } : {}) };
}

export async function setSymbol({ symbol, _deps }) {
  const { evaluateAsync, waitForChartReady } = _resolve(_deps);
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  return { success: true, symbol, chart_ready: ready };
}

export async function setTimeframe({ timeframe, _deps }) {
  const { evaluate, waitForChartReady } = _resolve(_deps);
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${safeString(timeframe)}, {});
    })()
  `);
  const ready = await waitForChartReady(null, timeframe);
  return { success: true, timeframe, chart_ready: ready };
}

export async function setType({ chart_type, _deps }) {
  const { evaluate } = _resolve(_deps);
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum) || typeNum < 0 || typeNum > 9 || !Number.isInteger(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy(${safeString(indicator)}, false, false, ${JSON.stringify(inputArr)});
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    return { success: newIds.length > 0, action: 'add', indicator, entity_id: newIds[0] || null, new_study_count: newIds.length };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity(${safeString(entity_id)});
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function getVisibleRange() {
  const { evaluate } = _resolve();
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to, _deps }) {
  const { evaluate } = _resolve(_deps);
  const f = requireFinite(from, 'from');
  const t = requireFinite(to, 'to');
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${f} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${t}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date, _deps }) {
  const { evaluate } = _resolve(_deps);
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
}

// 2026-08-23: FIXED A LIVE BUG. This called a bare `evaluate(...)`, but the
// module imports it as `_evaluate` and every other function in this file
// resolves it through `_resolve(_deps)`. So symbol_info threw
// "ReferenceError: evaluate is not defined" on EVERY call and had presumably
// never worked. Found while wiring app/tv-broker-feed.js's point-value
// cross-check to a real source instead of a hardcoded constant.
//
// Also now returns the contract's own price/value metadata. `pointvalue`
// (with minmov/pricescale as the fallback derivation) is what lets the app
// verify its VERIFIED_POINT_VALUE table against TradingView rather than
// trusting a constant that governs every P&L figure it computes. Fields are
// passed through as TradingView reports them — absent stays absent, because a
// derived-but-wrong multiplier is worse than a missing one.
export async function symbolInfo({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      var series = null;
      try { series = chart._chartWidget.model().mainSeries().symbolInfo(); } catch (e) { series = null; }
      var src = series || info;
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType(),
        pointvalue: (src && src.pointvalue !== undefined) ? src.pointvalue : null,
        minmov: (src && src.minmov !== undefined) ? src.minmov : null,
        pricescale: (src && src.pricescale !== undefined) ? src.pricescale : null,
        currency_code: (src && src.currency_code !== undefined) ? src.currency_code : null
      };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
