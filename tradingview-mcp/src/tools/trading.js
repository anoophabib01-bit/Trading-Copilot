import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/trading.js';

// 2026-08-17: reads a connected broker's live account state (positions,
// orders, balance/equity/P&L) directly from TradingView Desktop's Trading
// Panel DOM. See src/core/trading.js for the confirmed table structure and
// what is NOT yet verified (real Filled-order row shape — this account had
// zero trades when the tables were first inspected).
export function registerTradingTools(server) {
  server.tool('trading_get_positions', 'Get currently open positions from the connected broker account (Symbol, Side, Qty, Avg Fill Price, Profit, Update Time, Position ID). Empty if no broker is linked or no positions are open.', {}, async () => {
    try { return jsonResult(await core.getPositions()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('trading_get_orders', 'Get orders from the connected broker account (Symbol, Side, Type, Qty, Filled Qty, Avg Fill Price, Status, Update Time, Order ID, ...). Optionally filter by status (e.g. "Filled" for fill/trade history, "Working" for open orders).', {
    status: z.string().optional().describe('Filter by order status: Working, Inactive, Filled, Cancelled, Rejected. Omit for all.'),
  }, async ({ status }) => {
    try { return jsonResult(await core.getOrders({ status })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('trading_get_account_summary', 'Get the connected broker account\'s balance, equity, open/total P&L, and margin figures.', {}, async () => {
    try { return jsonResult(await core.getAccountSummary()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  // 2026-08-23: explicit repair entry point. getAccount() already self-heals
  // on every read, but the app's startup self-test needs to be able to FORCE
  // a mount attempt and report exactly what it did, so a human looking at the
  // 3-step check sees "recovered positions tab" rather than a silent pass.
  // Only ever clicks tab controls — never a ticket, never anything that can
  // transmit an order. See ensurePanelTablesMounted's safety contract.
  server.tool('trading_ensure_panel_ready', "Ensure the broker Trading Panel's positions/orders tables are mounted in the DOM, clicking their tabs if TradingView has not rendered them yet, then restoring whichever tab was showing. Use when a broker read reports a table as unreadable. Never places or modifies orders.", {
    want: z.array(z.enum(['positions', 'orders', 'summary'])).optional().describe('Which tables must be mounted. Defaults to all three.'),
  }, async ({ want }) => {
    try { return jsonResult(await core.ensurePanelTablesMounted({ want })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  // 2026-09-02: mounting is not rendering. ka-table only renders BODY ROWS for
  // the visible sub-tab, so the orders table can be fully mounted (every check
  // in trading_ensure_panel_ready passes) and still read as zero rows. That
  // shape is indistinguishable from "no orders today" to a caller, and it cost
  // two days of trades with no entry/exit price — see refreshOrdersTable.
  // Borrows the Orders tab for one read, then puts the human's tab back.
  // Clicks tab controls only; never places or modifies an order.
  server.tool('trading_refresh_orders_table', "Force the broker panel's Orders table to render its rows by briefly selecting the Orders tab, read it, then restore whichever tab was showing. Use when the orders table reads as empty but a position is open — that combination means the table has not rendered, not that there are no orders. Never places or modifies orders.", {
    settleMs: z.number().optional().describe('How long to wait for the tab to render before reading, in ms. Default 700.'),
  }, async ({ settleMs }) => {
    try { return jsonResult(await core.refreshOrdersTable({ settleMs })); }
    catch (err) { return jsonResult({ success: false, ok: false, error: err.message }, true); }
  });

  // 2026-09-02: the positions half. The oversize guard confirms a reduction by
  // re-reading the positions table; a table that is not re-rendering returns
  // the pre-order size forever, so a reduction that WORKED looks like one that
  // did nothing and the guard reports STUCK. Gives it a real read to judge.
  server.tool('trading_refresh_panel_table', "Force one broker-panel table ('orders' or 'positions') to render its current rows by briefly selecting its tab, read it, then restore whichever tab was showing. Use when a table's contents look stale or empty but the account state says otherwise — a hidden tab does not repaint. Never places or modifies orders.", {
    table: z.enum(['orders', 'positions']).describe("Which table to force-render."),
    settleMs: z.number().optional().describe('How long to wait for the tab to render before reading, in ms. Default 700.'),
  }, async ({ table, settleMs }) => {
    try { return jsonResult(await core.refreshPanelTable({ table, settleMs })); }
    catch (err) { return jsonResult({ success: false, ok: false, error: err.message }, true); }
  });

  server.tool('trading_get_account', 'Get everything from the connected broker account in one call: account summary, open positions, and orders. Prefer this over three separate calls when the caller needs the full picture.', {}, async () => {
    try { return jsonResult(await core.getAccount()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  // 2026-08-17: PLACES A REAL ORDER ON THE CONNECTED BROKER ACCOUNT WITH REAL
  // MONEY. Confirmed live (1-lot Buy then offsetting Sell, verified filled
  // and flat again) — via manual clicks; the reusable function's own
  // verification path (verifyOrderLabel, src/core/trading.js) was NOT
  // exercised successfully until an independent review caught a regex bug
  // in it (2026-08-17) — see that file's comments.
  //
  // GATED behind TV_ALLOW_LIVE_ORDERS=1, off by default. Before this gate,
  // the only thing stopping an AI agent from calling this tool was a prompt
  // instruction ("caller MUST already have explicit human authorization") —
  // an instruction is not enforcement, and this app's own claude-agent.js
  // already asserts elsewhere that Jessi "can NEVER place or modify trades."
  // The semi-autonomous confirm-per-trade flow this tool is meant to serve
  // does not exist yet (per the diff review this was built alongside) — so
  // registering it unconditionally would make it reachable by any MCP
  // client before the thing that's supposed to gate it is built. Flip the
  // env var on deliberately, per session, once the confirm flow is real.
  if (process.env.TV_ALLOW_LIVE_ORDERS === '1') {
    server.tool('trading_place_market_order', 'PLACES A REAL MARKET ORDER on the connected broker account — real money moves the instant this is called. Only call this after the human has explicitly authorized this specific trade (side, quantity, symbol). Verifies the order-ticket UI reflects the requested side/quantity/symbol via the submit button\'s own label before submitting; refuses rather than guessing if anything looks wrong. Optional stopPrice/targetPrice: UNVERIFIED DOM automation (2026-08-17) — if given and the ticket\'s stop-loss/take-profit fields cannot be found and set with confidence, the ENTIRE order is refused (fails closed, nothing is submitted) rather than placing a naked position.', {
      side: z.enum(['buy', 'sell']).describe('Order direction'),
      qty: z.number().int().positive().describe('Number of contracts/units'),
      symbol: z.string().optional().describe('Expected symbol, e.g. "MNQU6" — if given, refuses to submit unless the order ticket shows this symbol'),
      stopPrice: z.number().positive().optional().describe('Absolute stop-loss price. UNVERIFIED automation — if it cannot be set, the whole order is refused.'),
      targetPrice: z.number().positive().optional().describe('Absolute take-profit price. UNVERIFIED automation — if it cannot be set, the whole order is refused.'),
    }, async ({ side, qty, symbol, stopPrice, targetPrice }) => {
      try { return jsonResult(await core.placeMarketOrder({ side, qty, symbol, stopPrice, targetPrice })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    });
  }
}
