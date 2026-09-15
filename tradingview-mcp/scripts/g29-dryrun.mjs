/**
 * G29 verification harness — proves the buy/sell-widget order path on the LIVE
 * TradingView without submitting anything.
 *
 * Why this exists as its own file: the app spawns tradingview-mcp as a child
 * process, so updated order-path code only reaches the app after a restart of the
 * WHOLE app. This runs the same core functions in a fresh process, so the path can
 * be proven against the real chart before any restart, and re-proven later.
 *
 * dryRun = true stops after the size has been set on the widget AND read back off
 * it. Nothing is clicked that can submit. Run:
 *     node tradingview-mcp/scripts/g29-dryrun.mjs [qty]
 */
import { probeOrderEntry, placeMarketOrder } from '../src/core/trading.js';

const qty = Number(process.argv[2] || 1);
const out = { qty };
try {
  out.probe = await probeOrderEntry();
} catch (e) {
  out.probe = { error: e.message };
}
try {
  out.dryRun = await placeMarketOrder({ side: 'buy', qty, symbol: 'MNQZ6', dryRun: true });
} catch (e) {
  out.dryRun = { success: false, error: e.message };
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
