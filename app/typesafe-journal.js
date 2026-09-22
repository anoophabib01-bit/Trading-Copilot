'use strict';
/* ── typesafe-journal.js — a loss day, turned into countable facts ───────────
 * 2026-09-19. Phase 1 of the TypeSafe (Jev) work, and the ONE job chosen out of
 * every candidate because it fills a gap nothing else in this app can.
 *
 * THE GAP. pattern-memory.js counts what the FLAGS catch: 112 revenge
 * re-entries, 89 oversize, 75 out-of-window. It cannot count what he WRITES.
 * The Journal's free text, the loss-journal fields (entry criteria, exit
 * criteria, state at entry vs after) and the lesson line are stored, quoted
 * back verbatim by journal-notes.js, and never structured. So "I entered early
 * because I was bored" written on nine different days is invisible as a trend,
 * while one oversize trade is a countable episode. Deva's doctrine is explicit
 * that the loss data is the non-negotiable half — "why did you lose, what was
 * your psychological state, what were your entry and exit criteria" — and it is
 * the half this app can read but not count.
 *
 * WHAT THIS MODULE DOES. Takes the saved note (plus the day's numbers), builds
 * a typed question set from a rubric that lives in rules.json, asks Jev, and
 * stores the typed answer BESIDE his words. His words are never rewritten,
 * never replaced, and never summarised — the classification is an extra field
 * that a human can always check against the sentence it came from.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   • It does not grade him. The record is not a score in any report; it is a
 *     label with a confidence, kept so a pattern can be COUNTED later.
 *   • It does not feed any guard, any size, or any go/no-go. Nothing consumes
 *     it yet — that is the point of a shadow phase.
 *   • It does not decide what counts as a mistake. The taxonomy is data in
 *     rules.json, next to every other threshold in this app.
 *
 * PURE CORE + THIN I/O, the same split as account-snapshot.js: buildQuestions /
 * buildState / shapeResult are pure and unit-tested; classifyAndStore takes its
 * save/load and fetch as dependencies so the whole path can be exercised
 * without a network or a real account folder.
 */
const typesafeClient = require('./typesafe-client');

const MAX_TEXT = 700;      // per free-text field, before the request cap
const MAX_TRADES = 12;     // most recent trades described to the model

function clip(v, max) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

/**
 * The typed questions, built from the rubric in rules.json. If the taxonomy is
 * missing or empty we return {} and no call is made — an unconfigured rubric
 * must produce silence, never a guessed label.
 */
function buildQuestions(taxonomy) {
  const t = taxonomy || {};
  const options = t.options && typeof t.options === 'object' ? t.options : null;
  const levels = Array.isArray(t.stateLevels) ? t.stateLevels.filter(Boolean) : null;
  const q = {};
  // NO RUBRIC, NO JOB. This module IS the journal classifier — the taxonomy is
  // its contract, not a garnish. Returning the two boolean questions on their
  // own would mean a half-classified day recorded as if it were a whole answer
  // (a "plan not followed" with no mistake label beside it), which is exactly
  // the guessed-label failure this guard exists to prevent. Caught by
  // test/typesafe-journal.test.js, which asserted zero calls with no rubric and
  // got one.
  if (!(options && Object.keys(options).length >= 2)) return {};
  q.mistake = {
    type: 'choice',
    instructions: t.mistakeQuestion || 'Which single mistake best describes this losing day, judged from what he wrote and the trades listed? Choose "none" when his process held up and the market simply disagreed.',
    criteria: options,
  };
  if (levels && levels.length >= 2) {
    q.state_drift = {
      type: 'score',
      instructions: t.stateQuestion || 'How far did his state move from his own baseline across this session, judging only from the text he wrote?',
      criteria: levels,
    };
  }
  q.plan_followed = {
    type: 'noul',
    instructions: t.planQuestion || 'Did he trade the plan he committed to before the session — the setups and the trade cap he wrote down — rather than what the market offered him in the moment?',
  };
  q.entry_was_setup = {
    type: 'noul',
    instructions: t.setupQuestion || 'Was the entry he describes an actual A+ setup by his written definition, rather than an early or chased entry he talked himself into?',
  };
  return q;
}

/**
 * The state handed to the model. A plain object, because the API accepts
 * structured state — no prose assembly, and the model sees exactly the fields a
 * reader of the note would see. Every field is capped; his sentence survives
 * whole or clipped, never paraphrased.
 */
function buildState(note, dayContext, dateKey) {
  const n = note || {};
  const d = dayContext || {};
  const state = {
    date: dateKey || null,
    trader_written: {
      state_of_mind: clip(n.mood, 40),
      followed_plan_dropdown: clip(n.followedPlan, 12),
      main_mistake_dropdown: clip(n.mistake, 60),
      what_happened: clip(n.text, MAX_TEXT),
      lesson_for_tomorrow: clip(n.lesson, 300),
      entry_criteria_written: clip(n.entryCriteria, 400),
      exit_criteria_written: clip(n.exitCriteria, 400),
      state_at_entry: clip(n.stateAtEntry, 40),
      state_after: clip(n.stateNow, 40),
    },
    day_numbers: {
      net_pnl: Number.isFinite(Number(d.net)) ? Number(d.net) : null,
      trades: Number.isFinite(Number(d.trades)) ? Number(d.trades) : null,
      max_size: Number.isFinite(Number(d.maxSize)) ? Number(d.maxSize) : null,
      size_cap: Number.isFinite(Number(d.sizeCap)) ? Number(d.sizeCap) : null,
      flags: Array.isArray(d.flags) ? d.flags.slice(0, 10).map(f => clip(f, 40)) : [],
    },
  };
  // Trim empty fields so the model is not reading a wall of blanks.
  Object.keys(state.trader_written).forEach(function (k) {
    if (!state.trader_written[k]) delete state.trader_written[k];
  });
  if (Array.isArray(d.tradesDetail) && d.tradesDetail.length) {
    state.trades = d.tradesDetail.slice(-MAX_TRADES).map(function (t) {
      return {
        n: Number.isFinite(Number(t.n)) ? Number(t.n) : null,
        size: Number.isFinite(Number(t.size)) ? Number(t.size) : null,
        pnl: Number.isFinite(Number(t.pnl)) ? Number(t.pnl) : null,
        side: clip(t.side, 8) || null,
        flags: Array.isArray(t.flags) ? t.flags.slice(0, 6).map(f => clip(f, 30)) : undefined,
      };
    });
  }
  return state;
}

/**
 * The storable record. Everything here is either a typed answer or a number the
 * API returned; nothing is inferred. Confidence is kept ALONGSIDE the label,
 * never instead of it.
 */
function shapeResult(answers, meta) {
  const a = answers || {};
  const m = meta || {};
  const pick = (id) => (a[id] && typeof a[id] === 'object') ? a[id] : null;
  const mistake = pick('mistake');
  const drift = pick('state_drift');
  const plan = pick('plan_followed');
  const setup = pick('entry_was_setup');
  return {
    at: m.at || new Date().toISOString(),
    model: m.model || null,
    mistake: mistake ? mistake.choice : null,
    mistakeConfidence: mistake ? mistake.confidence : null,
    mistakeProbabilities: mistake ? mistake.probabilities : null,
    stateDrift: drift ? drift.score : null,
    stateDriftConfidence: drift ? drift.confidence : null,
    planFollowed: plan ? (Number(plan.noul) >= 0.5) : null,
    planFollowedProbability: plan ? plan.noul : null,
    entryWasSetup: setup ? (Number(setup.noul) >= 0.5) : null,
    entryWasSetupProbability: setup ? setup.noul : null,
    latencyMs: m.latencyMs != null ? m.latencyMs : null,
    stateChars: m.stateChars != null ? m.stateChars : null,
    // Kept so a later reader can see exactly what was asked, without keeping a
    // copy of the note itself (the note already exists in its own store).
    answers: a,
  };
}

/**
 * The thin half. Orchestrates one classification and stores it.
 *
 * deps: { dataDir, save(key, value), load(key) } — injected so the path
 * convention stays in server.js and this module can be tested against a stub.
 * Returns the stored record on success, or { skipped, reason } — NEVER throws.
 */
async function classifyAndStore(opts) {
  const o = opts || {};
  const deps = o.deps || {};
  const client = o.client || typesafeClient;
  const settings = client.resolveSettings(o.rules, o.appCfg, o.env);
  const storeKey = o.storeKey || ('typesafe_notes__' + (o.slotId || 'unknown'));

  const day = o.dayKey || o.date || null;
  const callsToday = (o.callsToday != null) ? o.callsToday
    : (deps.dataDir && day && client.callsToday ? client.callsToday(deps.dataDir, day) : 0);
  const verdict = client.shouldCall(settings, { callsToday });
  if (!verdict.call) return { ok: false, skipped: true, reason: verdict.reason };

  const questions = buildQuestions((o.rules && o.rules.mistakeTaxonomy) || o.taxonomy);
  if (!Object.keys(questions).length) return { ok: false, skipped: true, reason: 'no mistakeTaxonomy configured in rules.json' };

  const state = buildState(o.note, o.dayContext, o.date);
  // fetchImpl is forwarded so the whole path can be exercised end-to-end in
  // tests with a mocked transport — the same dependency-injection idea as the
  // injected save/load above, and the reason no test here needs a network.
  const res = await client.ask(state, questions, { settings, fetchImpl: o.fetchImpl });
  const row = {
    at: new Date().toISOString(),
    day,
    slot: o.slotId || null,
    kind: 'journal',
    ok: !!res.ok,
    reason: res.ok ? null : (res.reason || null),
    model: res.model || settings.model,
    latencyMs: res.latencyMs != null ? res.latencyMs : null,
    stateChars: res.stateChars != null ? res.stateChars : null,
    questionIds: res.questionIds || Object.keys(questions),
    answers: res.ok ? res.answers : null,
  };
  if (o.ledger !== false && deps.dataDir && client.appendLedger) client.appendLedger(deps.dataDir, row);
  if (!res.ok) return { ok: false, skipped: !!res.skipped, reason: res.reason || 'no answer' };

  const record = shapeResult(res.answers, { model: res.model, latencyMs: res.latencyMs, stateChars: res.stateChars });
  try {
    if (deps.load && deps.save) {
      const store = deps.load(storeKey) || {};
      store[o.date] = record;
      deps.save(storeKey, store);
    }
  } catch (e) { /* advisory: a failed store must not surface as an error */ }
  return { ok: true, record, key: storeKey };
}

module.exports = { buildQuestions, buildState, shapeResult, classifyAndStore, MAX_TEXT, MAX_TRADES };
