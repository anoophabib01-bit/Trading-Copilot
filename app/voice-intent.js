'use strict';
/* ── voice-intent.js — route a spoken utterance to a HANDLER (2026-09-21) ─────
 *
 * (docs.typesafe.ai/patterns/intent-routing + /patterns/confidence-routing. Both
 * patterns, and why they matter in this app, are in COMPOSITE_SCORING_PLAN.md.)
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * Every spoken word currently becomes a full Jessi agent turn: persona, tools,
 * and the whole account context, streamed through DeepSeek. But a large share of
 * what he SAYS into the mic is not a question at all — it is a command, or a
 * request for a number the app already holds. "What's my cushion" does not need
 * a tool-using agent; it needs a read.
 *
 * ── THE PATTERN ─────────────────────────────────────────────────────────────
 * TypeSafe's own flagship confidence example is literally a VOICE interface —
 * voice banking commands, with a 0.6 floor and per-action thresholds above it
 * ("check_balance at 0.6 is fine, approve_transfer needs 0.85+"). That is this
 * app's situation almost exactly, so the shape is taken straight from it:
 *
 *   confidence < floor          -> the full agent (today's behaviour, unchanged)
 *   floor <= c < act            -> READ: answer it.  ACTION: speak a confirmation
 *   c >= act                    -> answer it / perform the routed action
 *
 * ── WHY CONFIDENCE IS THE RIGHT INSTRUMENT HERE ─────────────────────────────
 * Voice's dominant error mode is MISHEARING, not misunderstanding. A typed
 * routing decision that says "I think he said 'close the ticket', but only
 * barely" is worth acting on very differently from one that is certain — and a
 * confidence floor is exactly the instrument for that, where a prompt is not.
 *
 * ── THE SPINE: IT ROUTES, IT DOES NOT DECIDE ────────────────────────────────
 *   1. FAIL-OPEN, ALWAYS. Anything unclear, unavailable, malformed or absent
 *      returns `decision: 'agent'` — the full Jessi turn runs exactly as it does
 *      today. A router that can silently swallow an utterance would be worse
 *      than no router, because he would be talking to something that stopped
 *      answering.
 *   2. IT ONLY CHOOSES A HANDLER. Every handler then does its own work and its
 *      own validation: the confirm path still runs trade-confirm-rules.js, a
 *      read still reads. Nothing here places, sizes, stops or blocks anything.
 *   3. A CONSEQUENTIAL ACTION IS NEVER TAKEN ON ONE HEARING. It is spoken back
 *      as a question and waits for a yes — the docs' own "ask the user to
 *      confirm" branch, which matters more in voice than anywhere because the
 *      transcript is a guess.
 *   4. OPTIONS FOLLOW THE STATE. An intent whose preconditions are absent ("close
 *      the ticket" with no ticket open) is not offered at all, because the docs
 *      are explicit that the model cannot choose an option it was never given —
 *      offering it would only invite a confident wrong answer.
 *
 * PURE. Builds questions, shapes a decision, writes nothing, calls nothing.
 */

// ── The intent catalogue ────────────────────────────────────────────────────
// `kind`: 'read' answers with data the app already holds; 'action' changes
// something and needs a confirmation; 'agent' is the escape hatch and is always
// available, so a misroute can never trap him.
//
// `act` is the per-intent threshold, per the docs' consequence rule: a read is
// safe at the floor, an action needs near-certainty.
const DEFAULT_INTENTS = Object.freeze({
  account_status: {
    kind: 'read', label: 'Account status', act: 0.6,
    description: 'He is asking for where the account stands — balance, cushion to the floor, distance to target, or how much of the daily loss limit is left.',
    confirm: null,
  },
  day_status: {
    kind: 'read', label: 'Today so far', act: 0.6,
    description: 'He is asking about TODAY — trades taken, P&L so far, size used, how many trades are left, or whether the day is still tradeable.',
    confirm: null,
  },
  setup_status: {
    kind: 'read', label: 'Armed setup', act: 0.65,
    description: 'He is asking whether a setup is armed right now, and what it is — direction, entry, stop or target.',
    confirm: null,
    requires: 'armedSetup',
  },
  mark_exit: {
    kind: 'action', label: 'Mark an exit on the chart', act: 0.85,
    description: 'He is asking to mark his exit on the chart, or to record where he got out.',
    confirm: 'Mark your exit on the chart?',
  },
  start_session: {
    kind: 'action', label: 'Start / end the session', act: 0.85,
    description: 'He is asking to start or end the trading session, or to open the pre-session check.',
    confirm: 'Start the session?',
  },
  ask_coach: {
    kind: 'agent', label: 'Ask the coach', act: 0,
    description: 'Everything else: a question about the market, a request for judgement, a challenge, an explanation, or anything that is not one of the other options. This is the catch-all.',
    confirm: null,
  },
});

const DEFAULTS = Object.freeze({
  enabled: false,   // off until a key exists, like every other Jev surface
  // 'observe' records every decision and changes nothing; 'steer' additionally
  // hands the agent a one-line hint about what he is asking for. 'steer' is the
  // shipped mode because the hint can only make an answer more focused — it
  // cannot make the app do something, and a wrong hint costs him a repeat, which
  // is what a mishearing already costs.
  mode: 'steer',
  floor: 0.6,       // below this, no routing at all — the full agent answers
  maxTranscriptChars: 500,
});
const MODES = ['observe', 'steer', 'off'];

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp01(n) { return Math.min(1, Math.max(0, n)); }

/** Catalogue + thresholds, overridden by rules.json.voiceRouter where present. */
function intentConfig(rules) {
  const cfg = (rules && rules.voiceRouter) || {};
  const intents = {};
  const overrides = (cfg.intents && typeof cfg.intents === 'object') ? cfg.intents : {};
  for (const key of Object.keys(DEFAULT_INTENTS)) {
    const base = DEFAULT_INTENTS[key];
    const o = (overrides[key] && typeof overrides[key] === 'object') ? overrides[key] : {};
    const act = num(o.act);
    intents[key] = {
      key,
      kind: ['read', 'action', 'agent'].includes(o.kind) ? o.kind : base.kind,
      label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : base.label,
      description: typeof o.description === 'string' && o.description.trim() ? o.description.trim() : base.description,
      confirm: typeof o.confirm === 'string' && o.confirm.trim() ? o.confirm.trim() : base.confirm,
      requires: base.requires || null,
      act: (act != null && act >= 0 && act <= 1) ? act : base.act,
      enabled: o.enabled !== false,
    };
  }
  const floorRaw = num(cfg.floor);
  const modeRaw = String(cfg.mode || '').toLowerCase();
  return {
    enabled: cfg.enabled === true,
    mode: MODES.includes(modeRaw) ? modeRaw : DEFAULTS.mode,
    floor: (floorRaw != null && floorRaw >= 0 && floorRaw <= 1) ? floorRaw : DEFAULTS.floor,
    maxTranscriptChars: num(cfg.maxTranscriptChars) > 0 ? Number(cfg.maxTranscriptChars) : DEFAULTS.maxTranscriptChars,
    intents,
  };
}

/**
 * Which intents may be offered for THIS utterance.
 *
 * An intent whose precondition is absent is not offered. The docs are explicit
 * that the model cannot pick an option it was never given, so offering "close
 * the ticket" while no ticket is open would not be harmless — it would invite a
 * confident answer to an impossible question.
 */
function availableIntents(rules, ctx) {
  const cfg = intentConfig(rules);
  const c = ctx || {};
  const out = [];
  for (const key of Object.keys(cfg.intents)) {
    const intent = cfg.intents[key];
    if (!intent.enabled) continue;
    if (intent.requires === 'armedSetup' && !c.armedSetup) continue;
    out.push(intent);
  }
  // The catch-all must always survive, or a misroute could trap him in a
  // router with no way back to the coach.
  if (!out.some((i) => i.kind === 'agent')) out.push(cfg.intents.ask_coach);
  return out;
}

/** The one question. {} when there is nothing to route between. */
function buildQuestions(rules, ctx) {
  const cfg = intentConfig(rules);
  if (!cfg.enabled) return {};
  const opts = availableIntents(rules, ctx);
  if (opts.length < 2) return {};
  const criteria = {};
  for (const i of opts) criteria[i.key] = i.label + ' — ' + i.description;
  return {
    intent: {
      type: 'choice',
      instructions: 'He spoke one short command or question into a microphone, and the transcript below is what the '
        + 'speech recogniser produced — it may contain misheard words, and it may be incomplete. Choose the single '
        + 'option that best matches what he was TRYING to do. Choose the catch-all when the utterance is a question, a '
        + 'request for judgement, or anything that is not clearly one of the specific actions. Do not choose an action '
        + 'that the recorded app state cannot support.',
      criteria,
    },
  };
}

/** The state. The transcript verbatim — never cleaned up or corrected. */
function buildState(transcript, ctx) {
  const c = ctx || {};
  const cfg = { maxTranscriptChars: DEFAULTS.maxTranscriptChars };
  const t = transcript == null ? '' : String(transcript);
  return {
    spoken_transcript: t.length <= cfg.maxTranscriptChars ? t : t.slice(0, cfg.maxTranscriptChars),
    app_state: {
      trading_mode: c.tradingMode != null ? String(c.tradingMode) : null,
      account_phase: c.phase != null ? String(c.phase) : null,
      armed_setup: c.armedSetup === true,
      pending_ticket: c.pendingTicket === true,
      in_session: c.inSession === true,
      last_question_asked: c.lastConfirm ? String(c.lastConfirm) : null,
    },
  };
}

/**
 * The routing decision. The ONLY place the three outcomes are decided.
 *
 * Returns { decision, intent, confidence, act, floor, reason, confirmText }.
 * `decision` is one of:
 *   'handle'  — perform the intent now (a read, or an action that cleared its act threshold)
 *   'confirm' — speak the intent back as a question and wait for a yes
 *   'agent'   — the full Jessi turn, i.e. today's behaviour
 *
 * A reply of "yes" to a spoken confirmation is itself routed: see `isAffirmation`.
 */
function route(clientResult, rules, ctx) {
  const cfg = intentConfig(rules);
  const r = clientResult || {};
  const c = ctx || {};
  const base = { intent: null, confidence: null, act: null, floor: cfg.floor, confirmText: null };
  if (!cfg.enabled) return Object.assign({}, base, { decision: 'agent', reason: 'voice router disabled in rules.json' });
  if (!r.ok) return Object.assign({}, base, { decision: 'agent', reason: 'no usable routing read — ' + (r.reason || 'call failed') });
  const a = (r.answers && r.answers.intent) || null;
  if (!a || a.type !== 'choice' || !a.choice) {
    return Object.assign({}, base, { decision: 'agent', reason: 'the answer named no intent' });
  }
  const intent = cfg.intents[a.choice];
  if (!intent || !intent.enabled) {
    return Object.assign({}, base, { decision: 'agent', reason: 'the answer named an intent that is not available' });
  }
  const conf = num(a.confidence);
  const out = { intent: intent.key, confidence: conf, act: intent.act, floor: cfg.floor, confirmText: intent.confirm };

  if (intent.kind === 'agent') {
    return Object.assign({}, out, { decision: 'agent', reason: 'routed to the coach by the router itself' });
  }
  // A Noul-style absence of confidence cannot gate anything, and an action on no
  // confidence is the one thing that must never happen.
  if (conf == null) {
    return Object.assign({}, out, {
      decision: intent.kind === 'read' ? 'handle' : 'agent',
      reason: intent.kind === 'read'
        ? 'no confidence reported, but a read is harmless — answering it'
        : 'no confidence reported and this is an action, so it goes to the coach rather than being performed',
    });
  }
  if (conf < cfg.floor) {
    return Object.assign({}, out, {
      decision: 'agent',
      reason: 'below the floor (' + conf + ' < ' + cfg.floor + ') — the transcript is a guess at this point, so the full agent handles it',
    });
  }
  if (intent.kind === 'read') {
    return Object.assign({}, out, { decision: 'handle', reason: 'a read at ' + conf + ' is safe to answer (floor ' + cfg.floor + ')' });
  }
  if (conf < intent.act) {
    return Object.assign({}, out, {
      decision: 'confirm',
      reason: 'an action at ' + conf + ' clears the floor but not its own threshold (' + intent.act + ') — asking first',
    });
  }
  return Object.assign({}, out, {
    decision: 'confirm',
    reason: 'an action at ' + conf + ' clears its own threshold (' + intent.act + '), but an action is still spoken back before it is performed',
  });
}

/**
 * Is a spoken reply an affirmation?
 *
 * A confirmation round-trip has to accept "yes", and has to accept it being
 * misheard as "yeah" / "yep" / "correct" — and must NOT accept "yes but wait".
 * Anything it does not recognise is NOT an affirmation, so the turn falls
 * through to the agent, which is the safe direction.
 */
const AFFIRM = /^\s*(yes|yeah|yep|yup|ya|correct|confirm|confirmed|do it|go ahead|please do|affirmative)\b[\s.!]*$/i;

function isAffirmation(text) {
  return AFFIRM.test(String(text == null ? '' : text));
}

/**
 * The one-line hint handed to the agent when mode is 'steer'.
 *
 * This is the WHOLE of what the router changes in the voice turn. It never
 * supplies a number, never says what to do, and is empty for an 'agent'
 * decision — so the common case is bit-for-bit today's prompt. A wrong hint
 * costs him a repeat; it cannot make the app do anything.
 */
function steerLine(result) {
  const r = result || {};
  if (r.decision === 'agent' || !r.intent) return '';
  const cfgLabel = String(r.intent).replace(/_/g, ' ');
  if (r.decision === 'confirm') {
    return 'VOICE ROUTER (a classifier read of the transcript, which may be misheard): he appears to be asking to '
      + cfgLabel + '. If you can do it with a tool, ask him to confirm in one short sentence before doing it. '
      + 'If you cannot, say so in one short sentence. Do not do it on this turn alone.';
  }
  return 'VOICE ROUTER (a classifier read of the transcript, which may be misheard): he appears to be asking about "'
    + cfgLabel + '". Answer that in ONE short spoken sentence, with the number he asked for, using your tools to get '
    + 'it. If the router has misread him, answer what he actually asked instead.';
}

/** The line the UI/ledger shows. Never a probability, never advice. */
function describeRoute(result) {
  const r = result || {};
  if (r.decision === 'agent') return 'Voice: handled by the coach — ' + (r.reason || 'no route');
  if (r.decision === 'confirm') return 'Voice: ' + r.intent + ' (confidence ' + r.confidence + ' vs act ' + r.act + ') — asking first: "' + (r.confirmText || '') + '"';
  return 'Voice: ' + r.intent + ' handled directly (confidence ' + r.confidence + ').';
}

module.exports = {
  DEFAULT_INTENTS, DEFAULTS, AFFIRM,
  intentConfig, availableIntents, buildQuestions, buildState, route,
  isAffirmation, describeRoute, steerLine, MODES,
};
