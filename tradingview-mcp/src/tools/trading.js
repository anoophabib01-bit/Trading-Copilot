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
