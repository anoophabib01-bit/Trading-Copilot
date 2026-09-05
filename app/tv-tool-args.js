'use strict';
/* ── tv-tool-args.js — argument aliases for tradingview-mcp tools ────────────
 *
 * (2026-09-02) Found while wiring the exit-price chart marker.
 *
 * THE BUG THIS EXISTS FOR
 * server.js advertised `draw_remove_one` to the Groq/Jessi path with a
 * parameter named `id`, but the real tool in tradingview-mcp takes
 * `entity_id`, and NOTHING in the app translated between them. Neither
 * dispatch site (makeJessiToolExecutor, handleMCPCall) touches args — they go
 * straight to mcpBridge.callTool. So every agent attempt to remove one drawing
 * arrived with entity_id undefined and removed nothing.
 *
 * It failed quietly. The tool returned a normal-looking result, the model
 * reported success, and the drawing stayed on the chart — the same shape of
 * silent failure as the exit-drift panel that never rendered.
 *
 * WHY AN ALIAS LAYER AND NOT JUST A SCHEMA RENAME
 * The schema is renamed too (that is the actual fix). But `draw_list` returns
 * shapes as `{ id, name }`, and both tool descriptions say the value comes
 * "from draw_list". A model holding an object whose field is literally called
 * `id` will keep reaching for `id` no matter what the parameter is called, and
 * that mistake is invisible at the call site. Accepting both spellings costs
 * one object copy and removes an entire class of silent no-op.
 *
 * NARROW ON PURPOSE. Only the tools that genuinely take `entity_id` are
 * listed, and only the one alias each. A general "rename any id-ish key"
 * helper would eventually rewrite an argument some other tool meant literally.
 *
 * PURE. No fs, no network. Unit-tested in test/tv-tool-args.test.js.
 */

// Tool -> { wrongKey: rightKey }. Both entries below are tools whose real
// signature is entity_id (tradingview-mcp/src/tools/drawing.js). Only
// draw_remove_one is currently exposed to an agent; draw_get_properties is
// listed so it is already correct if it is ever added.
const ARG_ALIASES = {
  draw_remove_one:     { id: 'entity_id' },
  draw_get_properties: { id: 'entity_id' },
};

/**
 * Returns args with known aliases renamed. Never mutates the input.
 * An explicit correct key always wins over the alias — if a caller sent both,
 * the one matching the real signature is what it meant.
 */
function normalizeToolArgs(name, args) {
  const map = ARG_ALIASES[name];
  if (!map || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  let out = null;
  for (const wrong of Object.keys(map)) {
    const right = map[wrong];
    if (!Object.prototype.hasOwnProperty.call(args, wrong)) continue;
    // Correct key already present and usable: drop the alias rather than
    // overwrite what the caller explicitly asked for.
    if (args[right] !== undefined && args[right] !== null && args[right] !== '') {
      if (!out) out = Object.assign({}, args);
      delete out[wrong];
      continue;
    }
    if (!out) out = Object.assign({}, args);
    out[right] = args[wrong];
    delete out[wrong];
  }
  return out || args;
}

module.exports = { normalizeToolArgs, ARG_ALIASES };
