'use strict';
/* ── ai-decision-gate.js — an AI gate in front of ENTRIES, and only entries ───
 *
 * ── WHERE THIS COMES FROM ───────────────────────────────────────────────────
 * OpenByteInc/QuantDinger (11.9k stars, Apache-2.0, a running product) puts a Jev
 * gate directly in front of live entry orders. Its published design, quoted:
 *
 *   "Before an entry reaches the exchange, QuantDinger sends the order, strategy
 *    context, exposure, positions, and budget state to TypeSafe Jev. Jev returns
 *    typed Choice results, probabilities, and confidence instead of prose..."
 *
 *   "The execution policy stays in QuantDinger code: rejected entries never reach
 *    the exchange; EXITS, STOP-LOSS, TAKE-PROFIT, AND EMERGENCY ACTIONS BYPASS
 *    THE FILTER."
 *
 *   "Provider failure is audited and FAILS OPEN, while every exit bypasses AI."
 *
 *   "...the order is allowed and the fail-open result is logged, SO AN AI OUTAGE
 *    CANNOT TRAP AN EXISTING POSITION."
 *
 * Those four sentences are the whole design, and they are why this file exists.
 * Everything else in the Jev ecosystem trades crypto; this is the one place a
 * serious product let a model stand in front of real orders, and it only did so
 * with those guarantees attached.
 *
 * ── THE THREE PROPERTIES THIS MODULE ENFORCES, AND WHY EACH IS LOAD-BEARING ──
 *
 * 1. ENTRIES CAN BE GATED. EXITS NEVER ARE. `bypassesGate()` is checked FIRST,
 *    before any state is built and before any provider is consulted, so there is
 *    no code path — not a timeout, not a malformed answer, not a future edit —
 *    by which a stop, a target, or a flatten can be held up by a model. A gate
 *    that can block an exit is a gate that can turn a small loss into a blown
 *    account, and that is the one failure this app cannot survive.
 *
 * 2. IT FAILS OPEN, AUDIBLY. No key, no provider, a 503, a timeout, a malformed
 *    answer, an unknown outcome — every one of them ALLOWS the order and records
 *    WHY. QuantDinger's sentence is the reason: an AI outage must not be able to
 *    trap a position. A silent fail-open is still a fail-open, but an UNLOGGED
 *    one is indistinguishable from the gate never having run.
 *
 * 3. NOTHING SEES THE FUTURE. `assertNoLookahead()` refuses any state in which a
 *    datum carries an `available_at` later than the decision time. Lifted from
 *    myc0576/SmartMoney-Cub, which enforces `available_at <= decision_time` in
 *    deterministic code rather than trusting the prompt. A gate reading a bar
 *    that had not closed when the decision was made is not a gate, it is a
 *    backtest that flatters itself — and this app's whole measurement stack
 *    depends on the ledger recording what was knowable at fire time.
 *
 * ── THE TWO CHECKS, ASKED INDEPENDENTLY ─────────────────────────────────────
 * QuantDinger stores "independent entry and risk checks" with the order context
 * and latency. maxlibin/moomoo-jev-trader asks Jev for "entry-quality and
 * stop-first-risk evaluations". Those are the same two questions, and they are
 * the right two, because they fail differently: a bad entry loses slowly, and a
 * stop that gets hit first loses at full size. They are asked as separate typed
 * questions in one request, so neither can hide behind the other's answer.
 *
 * PURE. Builds questions, shapes a decision, checks a clock. It does not place,
 * size, stop or block anything — and nothing in this app is wired to it yet.
 */

const DEFAULTS = Object.freeze({
  enabled: false,          // OFF until deliberately switched on, like every gate here
  requireBoth: false,      // true = both checks must pass; false = stop-first-risk alone can refuse
  timeoutMsFallback: 4000,
});

// ── 1. THE BYPASS. Checked first, always. ──────────────────────────────────
// These are the actions that reduce or remove risk. None of them may ever wait
// on a model, and the list is deliberately about INTENT rather than outcome so a
// caller cannot smuggle an entry through by naming it helpfully.
const EXIT_ACTIONS = Object.freeze([
  'exit', 'close', 'flatten', 'stop_hit', 'target_hit', 'stop_loss', 'take_profit',
  'emergency', 'reduce', 'partial_exit', 'trailing_stop', 'time_stop', 'kill',
]);

function bypassesGate(action, opts) {
  const a = String(action == null ? '' : action).toLowerCase().trim();
  const o = opts || {};
  if (o.isExit === true) return { bypass: true, reason: 'caller marked this an exit' };
  if (EXIT_ACTIONS.includes(a)) return { bypass: true, reason: '"' + a + '" is an exit-side action' };
  // Anything that REDUCES size is exit-side by construction, whatever it is named.
  if (Number.isFinite(Number(o.sizeDelta)) && Number(o.sizeDelta) < 0) {
    return { bypass: true, reason: 'the order reduces position size' };
  }
  return { bypass: false, reason: null };
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round3(n) { return Math.round(n * 1000) / 1000; }

// ── 2. NO LOOKAHEAD ────────────────────────────────────────────────────────
/**
 * Every timestamped datum in the state must have been knowable at decision time.
 * Returns { ok, violations[] } — never throws, because a guard that throws on
 * odd input is a guard that gets a try/catch around it and stops being a guard.
 */
function assertNoLookahead(state, decisionTimeMs) {
  const now = num(decisionTimeMs) != null ? Number(decisionTimeMs) : Date.now();
  const violations = [];
  const walk = (node, pathStr) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, pathStr + '[' + i + ']')); return; }
    for (const k of Object.keys(node)) {
      const v = node[k];
      const here = pathStr ? pathStr + '.' + k : k;
      if (k === 'available_at' && v != null) {
        const t = Date.parse(String(v));
        if (Number.isFinite(t) && t > now) {
          violations.push({ path: here, availableAt: String(v), msAhead: t - now });
        }
      }
      walk(v, here);
    }
  };
  walk(state, '');
  return { ok: violations.length === 0, violations, decisionTime: new Date(now).toISOString() };
}

// ── 3. THE QUESTIONS ───────────────────────────────────────────────────────
const DEFAULT_QUESTIONS = Object.freeze({
  entry_quality: {
    type: 'noul',
    instructions: 'Is this entry one the written strategy conditions allow right now, judged only from the order and '
      + 'the state? Answer NO when the state contradicts a condition, and NO when the state does not address it at all.',
    criteria: { true: 'the entry satisfies the written conditions', false: 'it does not, or the state does not say' },
  },
  stop_first_risk: {
    type: 'noul',
    instructions: 'Judging only from the recorded price action, volatility and the distance to the stop in this state, '
      + 'is the STOP more likely to be reached before the TARGET? Answer YES when the stop-first outcome looks more '
      + 'likely — a YES is a reason to refuse, not to widen the stop.',
    criteria: { true: 'the stop looks more likely to be hit first', false: 'the target looks more likely, or it is genuinely balanced' },
  },
});

function buildQuestions(rules, opts) {
  const o = opts || {};
  const q = {};
  const names = Array.isArray(o.checks) ? o.checks : ['entry_quality', 'stop_first_risk'];
  for (const n of names) if (DEFAULT_QUESTIONS[n]) q[n] = DEFAULT_QUESTIONS[n];
  return q;
}

/** The state QuantDinger sends: order, strategy context, exposure, positions, budget. */
function buildState(order, ctx) {
  const o = order || {};
  const c = ctx || {};
  return {
    // When this state was assembled. Stamped here so a caller cannot forget it,
    // and every downstream datum carries its own available_at.
    assembled_at: c.assembledAt || new Date().toISOString(),
    order: {
      symbol: o.symbol != null ? String(o.symbol) : null,
      side: o.side != null ? String(o.side) : null,
      quantity: num(o.quantity),
      entry: num(o.entry),
      stop: num(o.stop),
      target: num(o.target),
      available_at: o.availableAt || null,
    },
    strategy: c.strategy ? { id: c.strategy.id || null, conditions: c.strategy.conditions || null, available_at: c.strategy.availableAt || null } : null,
    exposure: c.exposure ? { open_positions: num(c.exposure.openPositions), same_side: num(c.exposure.sameSide), available_at: c.exposure.availableAt || null } : null,
    budget: c.budget ? { day_pnl: num(c.budget.dayPnl), losing_streak: num(c.budget.losingStreak), trades_today: num(c.budget.tradesToday), available_at: c.budget.availableAt || null } : null,
  };
}

// ── 4. THE DECISION ────────────────────────────────────────────────────────
/**
 * Turn a Jev answer into allow / refuse — or, on ANY doubt at all, into allow.
 *
 * `allow` is the safe direction only because the caller is an ENTRY. The exit
 * direction never reaches here; it was bypassed at the top.
 */
function decide(clientResult, settings, opts) {
  const cfg = Object.assign({}, DEFAULTS, settings || {});
  const o = opts || {};
  const out = {
    allow: true, decision: 'fail-open', checks: {}, latencyMs: o.latencyMs != null ? o.latencyMs : null,
    reason: null, provider: o.provider || null,
  };
  if (!cfg.enabled) return Object.assign(out, { decision: 'disabled', reason: 'AI decision gate is off — entries are not gated' });
  const r = clientResult || {};
  if (!r.ok) {
    // The sentence this exists for: an AI outage must not trap a position.
    return Object.assign(out, { decision: 'fail-open', reason: 'no usable AI answer (' + (r.reason || 'call did not succeed') + ') — the entry is ALLOWED and this is logged' });
  }
  const a = (r.answers) || {};
  const eq = a.entry_quality, sf = a.stop_first_risk;
  if (!eq && !sf) {
    return Object.assign(out, { decision: 'fail-open', reason: 'the answer carried neither check — the entry is ALLOWED and this is logged' });
  }
  const read = (x, invert) => {
    if (!x || typeof x.noul !== 'number') return null;
    // For stop_first_risk the DANGEROUS answer is yes, so it is inverted here and
    // nowhere else. One place inverts; a second place would eventually disagree.
    return invert ? (1 - x.noul) : x.noul;
  };
  const eqP = read(eq, false);
  const sfP = read(sf, true);
  out.checks = {
    entry_quality: eqP == null ? null : { passProbability: round3(eqP), passed: null },
    stop_first_risk: sfP == null ? null : { passProbability: round3(sfP), passed: null },
  };
  const floor = num(o.floor) != null ? Number(o.floor) : 0.5;
  if (eqP != null) out.checks.entry_quality.passed = eqP >= floor;
  if (sfP != null) out.checks.stop_first_risk.passed = sfP >= floor;
  const eqOk = eqP == null ? null : eqP >= floor;
  const sfOk = sfP == null ? null : sfP >= floor;
  const failed = [];
  if (eqOk === false) failed.push('entry_quality');
  if (sfOk === false) failed.push('stop_first_risk');
  // A STOP-FIRST refusal is the more serious of the two and is honoured on its
  // own: refusing a good entry costs an opportunity, refusing to notice that the
  // stop gets hit first costs the full position.
  const refuse = (sfOk === false) || (cfg.requireBoth && failed.length > 0);
  if (refuse) {
    return Object.assign(out, {
      allow: false, decision: 'refused',
      reason: 'refused by ' + failed.join(' + ') + ' at a ' + floor + ' floor — the entry does not reach the broker. '
        + 'This is an ENTRY refusal only; nothing on the exit side is affected.',
    });
  }
  return Object.assign(out, {
    allow: true, decision: 'allowed',
    reason: eqP == null || sfP == null
      ? 'only one check answered — allowed, and the missing check is recorded'
      : 'both checks passed at a ' + floor + ' floor',
  });
}

/**
 * The auditable line. QuantDinger shows provider, checks, result, confidence,
 * latency and reason; this is the same set, and it never claims a probability of
 * profit — only what the gate did and why.
 */
function describeDecision(result) {
  const r = result || {};
  const parts = Object.keys(r.checks || {}).map((k) => {
    const c = r.checks[k];
    return k + '=' + (c.passed == null ? 'no-answer' : (c.passed ? 'pass' : 'FAIL'));
  });
  return 'AI gate ' + String(r.decision || 'unknown').toUpperCase()
    + (parts.length ? ' (' + parts.join(', ') + ')' : '')
    + (r.latencyMs != null ? ' in ' + r.latencyMs + 'ms' : '')
    + (r.provider ? ' via ' + r.provider : '')
    + ' — ' + (r.reason || 'no reason recorded');
}

module.exports = {
  DEFAULTS, EXIT_ACTIONS, DEFAULT_QUESTIONS,
  bypassesGate, assertNoLookahead, buildQuestions, buildState, decide, describeDecision,
};
