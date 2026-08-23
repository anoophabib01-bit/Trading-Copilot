import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clickPanelTabJS,
  mountedTablesJS,
  expandBottomPanelJS,
  bottomPanelStateJS,
} from '../src/core/trading.js';

// ── Broker panel mount/recovery (2026-08-23, rev 2) ─────────────────────────
// These cover the JS that is INJECTED INTO TRADINGVIEW and therefore never
// runs in this process — a syntax error or a bad match rule in it would
// otherwise only ever surface live, mid-session, on the one code path that
// takes the whole guardrail down when it fails.
//
// The fake DOM below is modelled on the REAL structure captured over CDP from
// TradingView Desktop 3.3.0 on 2026-08-23, collapsed and expanded:
//
//   [class*="layout__area--bottom"]              h=38 collapsed / h=657 open
//     └ div[role=toolbar].footerPanel-tQ8Kilpy
//        └ div.tabbar-e9wUhp2L
//           └ div.tabs-e9wUhp2L collapsed-e9wUhp2L   <- the collapsed marker
//              └ div.tab-hvcu2Y0t
//                 ├ button.container-hvcu2Y0t   "Tradovate"   <- expand toggle
//                 └ div.menuButton-hvcu2Y0t     ""            <- opens a MENU
//           └ div.tabs-e9wUhp2L fakeTabs-e9wUhp2L
//              └ ... button with EMPTY text                   <- must be skipped
//
//   Expanded, the sub-tabs appear as .roundTabButton-Wa6TmGN3 with the
//   labels "Positions", "Orders", "Account summary" (lowercase s),
//   "Notifications log", "More".
//
// Rev 1 of this fix scoped its clicks to `.trading-panel-content`, which is
// the RIGHT-HAND ORDER TICKET, not this panel. It found nothing, reported
// "auto-repair failed", and changed nothing. The container assertion below
// exists so that specific mistake can never be made silently again.

function mkEl(text, { active = false, visible = true, className = null } = {}) {
  return {
    innerText: text,
    textContent: text,
    className: className != null ? className : (active ? 'tab active' : 'tab'),
    offsetParent: visible ? {} : null,
    clicks: 0,
    getAttribute(k) { return k === 'aria-selected' ? (active ? 'true' : 'false') : null; },
    click() { this.clicks++; },
    querySelectorAll: () => [],
  };
}

// `sels` maps a selector string to what querySelector should return.
function mkPanel({ tabs = [], collapsed = false, height = 657 } = {}) {
  return {
    clientHeight: height,
    querySelector: (sel) => (sel.includes('collapsed-') && collapsed ? { className: 'collapsed-x' } : null),
    querySelectorAll: () => tabs,
  };
}

function runInFakeDom(js, { panel, tables = {}, bottomSelOnly = true } = {}) {
  const document = {
    querySelector: (sel) => {
      if (sel.startsWith('table[data-name$=')) {
        const m = sel.match(/\$="([^"]+)"/);
        return tables[m && m[1]] ? {} : null;
      }
      if (sel.includes('layout__area--bottom')) return panel || null;
      // Rev 1's container. Returning null here is the point: nothing in the
      // shipped code may depend on it any more.
      if (!bottomSelOnly) return panel || null;
      return null;
    },
    querySelectorAll: () => (panel ? panel.querySelectorAll() : []),
  };
  return new Function('document', 'return ' + js.trim())(document);
}

// ── mountedTablesJS ─────────────────────────────────────────────────────────

test('mountedTablesJS reports each table independently, matched by suffix', () => {
  const out = runInFakeDom(mountedTablesJS(), {
    panel: mkPanel(),
    tables: { 'positions-table': true, 'orders-table': false, 'accountSummary-table': true },
  });
  assert.equal(out.positions, true);
  assert.equal(out.orders, false);
  assert.equal(out.summary, true);
});

test('mountedTablesJS matches by SUFFIX so a non-Tradovate broker still resolves', () => {
  // Regression guard: hardcoding the "TRADOVATE." prefix would make every
  // table read absent the moment the account moved to another integration,
  // which is indistinguishable from a collapsed panel.
  const js = mountedTablesJS();
  assert.ok(js.includes('data-name$='), 'must use a suffix match, not an exact data-name');
  assert.ok(!js.includes('TRADOVATE.'), 'must not hardcode the TRADOVATE component prefix');
});

// ── bottomPanelStateJS ──────────────────────────────────────────────────────

test('bottomPanelStateJS reports collapsed via the class marker', () => {
  const out = runInFakeDom(bottomPanelStateJS(), {
    panel: mkPanel({ collapsed: true, height: 38, tabs: [mkEl('Tradovate')] }),
  });
  assert.equal(out.present, true);
  assert.equal(out.collapsed, true);
  assert.equal(out.height, 38);
  assert.equal(out.brokerTab, 'Tradovate');
});

test('bottomPanelStateJS treats a short panel as collapsed even without the class', () => {
  // Belt and braces: the class hash (collapsed-e9wUhp2L) is generated and
  // will change between TradingView releases. Height is the durable signal.
  const out = runInFakeDom(bottomPanelStateJS(), {
    panel: mkPanel({ collapsed: false, height: 38, tabs: [mkEl('Tradovate')] }),
  });
  assert.equal(out.collapsed, true);
});

test('bottomPanelStateJS reports an expanded panel as not collapsed', () => {
  const out = runInFakeDom(bottomPanelStateJS(), {
    panel: mkPanel({ collapsed: false, height: 657, tabs: [mkEl('Tradovate')] }),
  });
  assert.equal(out.collapsed, false);
  assert.equal(out.height, 657);
});

test('bottomPanelStateJS reports absent when the panel container is missing', () => {
  const out = runInFakeDom(bottomPanelStateJS(), { panel: null });
  assert.equal(out.present, false);
});

// ── expandBottomPanelJS ─────────────────────────────────────────────────────

test('expandBottomPanelJS clicks the labelled broker tab when collapsed', () => {
  const brokerTab = mkEl('Tradovate');
  const out = runInFakeDom(expandBottomPanelJS(), {
    panel: mkPanel({ collapsed: true, height: 38, tabs: [brokerTab] }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.already, false);
  assert.equal(out.clicked, 'Tradovate');
  assert.equal(brokerTab.clicks, 1);
});

test('expandBottomPanelJS does NOTHING when already expanded — it must never collapse the panel', () => {
  // This is the highest-stakes assertion in the file. The button is a TOGGLE:
  // clicking it while expanded would collapse the panel, unmount all three
  // tables, and take the live feed down — the exact failure being fixed.
  const brokerTab = mkEl('Tradovate');
  const out = runInFakeDom(expandBottomPanelJS(), {
    panel: mkPanel({ collapsed: false, height: 657, tabs: [brokerTab] }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.already, true);
  assert.equal(brokerTab.clicks, 0, 'must not click the toggle on an already-open panel');
});

test('expandBottomPanelJS skips the menuButton, which opens a context menu', () => {
  const menu = mkEl('Tradovate', { className: 'menuButton-hvcu2Y0t container-ReTy_Xt0' });
  const real = mkEl('Tradovate', { className: 'container-hvcu2Y0t button-_yKxzjvM' });
  const out = runInFakeDom(expandBottomPanelJS(), {
    panel: mkPanel({ collapsed: true, height: 38, tabs: [menu, real] }),
  });
  assert.equal(out.ok, true);
  assert.equal(menu.clicks, 0, 'must not click the menu button');
  assert.equal(real.clicks, 1);
});

test('expandBottomPanelJS skips the empty-text fakeTabs button', () => {
  const fake = mkEl('', { className: 'container-hvcu2Y0t' });
  const real = mkEl('Tradovate', { className: 'container-hvcu2Y0t' });
  const out = runInFakeDom(expandBottomPanelJS(), {
    panel: mkPanel({ collapsed: true, height: 38, tabs: [fake, real] }),
  });
  assert.equal(out.clicked, 'Tradovate');
  assert.equal(fake.clicks, 0);
});

test('expandBottomPanelJS skips invisible controls', () => {
  const hidden = mkEl('Tradovate', { visible: false });
  const out = runInFakeDom(expandBottomPanelJS(), {
    panel: mkPanel({ collapsed: true, height: 38, tabs: [hidden] }),
  });
  assert.equal(out.ok, false);
  assert.equal(hidden.clicks, 0);
});

test('expandBottomPanelJS reports cleanly when the panel container is absent', () => {
  const out = runInFakeDom(expandBottomPanelJS(), { panel: null });
  assert.equal(out.ok, false);
  assert.match(out.error, /bottom panel container not found/);
});

// ── clickPanelTabJS ─────────────────────────────────────────────────────────

test('clickPanelTabJS finds the Positions tab and remembers the active one', () => {
  const tabs = [mkEl('Positions'), mkEl('Orders', { active: true }), mkEl('Account summary')];
  const out = runInFakeDom(clickPanelTabJS(['position']), {
    panel: mkPanel({ tabs }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.clicked, 'positions');
  assert.equal(out.prevActive, 'orders');
  assert.equal(tabs[0].clicks, 1);
});

test('clickPanelTabJS matches the real lowercase "Account summary" label', () => {
  // The live label is "Account summary", not "Account Summary".
  const tabs = [mkEl('Account summary')];
  const out = runInFakeDom(clickPanelTabJS(['account summary', 'summary']), {
    panel: mkPanel({ tabs }),
  });
  assert.equal(out.ok, true);
  assert.equal(tabs[0].clicks, 1);
});

test('clickPanelTabJS matches a tab with an appended count, "Positions (1)"', () => {
  const tabs = [mkEl('Positions (1)')];
  const out = runInFakeDom(clickPanelTabJS(['position']), { panel: mkPanel({ tabs }) });
  assert.equal(out.ok, true);
  assert.equal(tabs[0].clicks, 1);
});

test('clickPanelTabJS ignores a long-text container that merely CONTAINS the word', () => {
  const container = mkEl('Positions Orders Account summary Notifications log More and much more text');
  const out = runInFakeDom(clickPanelTabJS(['position']), { panel: mkPanel({ tabs: [container] }) });
  assert.equal(out.ok, false);
  assert.equal(container.clicks, 0);
});

test('clickPanelTabJS refuses an invisible tab', () => {
  const hidden = mkEl('Positions', { visible: false });
  const out = runInFakeDom(clickPanelTabJS(['position']), { panel: mkPanel({ tabs: [hidden] }) });
  assert.equal(out.ok, false);
  assert.equal(hidden.clicks, 0);
});

// ── container regression ────────────────────────────────────────────────────

test('REGRESSION: all injected snippets scope to layout__area--bottom, never the order ticket', () => {
  // Rev 1 scoped to `.trading-panel-content`, which is the Buy/Sell order
  // ticket. Clicking around inside the order ticket is exactly the thing this
  // code must never do, and it is also why rev 1 silently did nothing.
  for (const js of [expandBottomPanelJS(), bottomPanelStateJS(), clickPanelTabJS(['position'])]) {
    assert.ok(js.includes('layout__area--bottom'), 'must scope to the bottom panel');
    assert.ok(!js.includes('trading-panel-content'), 'must NOT touch the order ticket');
    assert.ok(!js.includes('order-panel'), 'must NOT touch the order panel');
  }
});
