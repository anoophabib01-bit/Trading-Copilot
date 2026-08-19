'use strict';
// ── Trade-ticket line parser (2026-08-17, Phase 2b) ──────────────────────────
// Pure classifier for JUDGE_PERSONA's machine-readable "TRADE_TICKET: ..."
// line (see server.js). Deliberately narrow: only side/size/stop/target are
// ever trusted from the LLM's text — symbol is always resolved live
// server-side (chart_get_state), never parsed from the verdict, so a stale or
// wrong symbol in the Judge's text can never reach an order.

/**
 * @param {string} text  the Judge's full verdict text
 * @returns {{side:'buy'|'sell', size:number, stopPrice:number|null, targetPrice:number|null}|null}
 *          null if no valid TRADE_TICKET line is present
 */
function parseTradeTicket(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^TRADE_TICKET:\s*(.+)$/m);
  if (!m) return null;

  const kv = {};
  m[1].split(/\s+/).forEach((tok) => {
    const eq = tok.indexOf('=');
    if (eq === -1) return;
    kv[tok.slice(0, eq).toLowerCase()] = tok.slice(eq + 1);
  });

  const side = (kv.side || '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') return null;

  const size = Number(kv.size);
  if (!Number.isFinite(size) || size <= 0 || Math.floor(size) !== size) return null;

  const stop = kv.stop !== undefined ? Number(kv.stop) : null;
  const target = kv.target !== undefined ? Number(kv.target) : null;

  return {
    side,
    size,
    stopPrice: stop !== null && Number.isFinite(stop) && stop > 0 ? stop : null,
    targetPrice: target !== null && Number.isFinite(target) && target > 0 ? target : null,
  };
}

module.exports = { parseTradeTicket };
