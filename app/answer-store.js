'use strict';
/* ── answer-store.js — store every answer, replay the settings for free ──────
 *
 * (Pattern taken from justinhe16/trade-jev: "run once -> replay many times ->
 * view". Their whole settings search ran off STORED answers and cost nothing;
 * only the initial run cost money.)
 *
 * ── WHY THIS IS THE HIGHEST-VALUE THING LEFT ────────────────────────────────
 * A Jev answer already contains everything a threshold needs: the chosen option
 * AND the full probability distribution. So changing a cutoff — 0.7 to 0.6, four
 * agreeing reads to three — is ARITHMETIC OVER DATA ALREADY ON DISK. It needs no
 * API call, no new state, and no waiting for the market to do it again.
 *
 * Today this app answers once and forgets: the threshold is baked into the call
 * that produced the answer, so trying a different one means waiting weeks for
 * new armed setups. That is the difference between a system that can be tuned
 * and one that can only be re-run.
 *
 * ── AND IT IS ALSO THE TRAP, SO THE TRAP IS BUILT IN ────────────────────────
 * trade-jev tried **1,920 settings on the same 15 days** and then said so, in
 * their own published findings: "treat it as an interesting lead to test on new
 * data, not a proven edge." A free sweep with no held-out test is a machine for
 * finding the best fortnight of noise.
 *
 * So replay here ALWAYS reports two numbers: the setting chosen on the FIRST
 * part of the record, and what that same setting did on the part it never saw.
 * A setting that wins on both is a lead. A setting that wins only on the part it
 * was chosen from is what the split exists to catch, and the module says which
 * one it is looking at.
 *
 * PURE except for the two thin io functions. Unit-tested.
 */

const fs = require('fs');
const path = require('path');
const driftEdge = require('./drift-edge');

const DEFAULTS = Object.freeze({
  tuneFraction: 0.6,   // first 60% of the record by TIME tunes; the rest tests
  minConfidence: 0.7,  // the published starting point, not a discovered one
  minSamples: 30,
  z: 1.96,
});

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round3(n) { return Math.round(n * 1000) / 1000; }

/**
 * One record. Everything needed to re-decide later WITHOUT the model:
 * what it was asked, what it answered, HOW SURE, and what actually happened.
 */
function buildRecord(fields) {
  const f = fields || {};
  const a = f.answer || {};
  return {
    ts: f.ts || new Date().toISOString(),
    setupId: f.setupId != null ? String(f.setupId) : null,
    playbook: f.playbook != null ? String(f.playbook) : null,
    tf: f.tf != null ? String(f.tf) : null,
    question: f.question != null ? String(f.question) : null,
    // The whole point: the DISTRIBUTION is stored, not just the winner.
    answer: a.choice != null ? String(a.choice) : (a.noul != null ? num(a.noul) : (a.score != null ? num(a.score) : null)),
    probabilities: a.probabilities && typeof a.probabilities === 'object' ? a.probabilities : null,
    confidence: num(a.confidence),
    // The outcome, filled in when the signal resolves. null until then — and a
    // null outcome is PENDING, never a loss.
    outcome: f.outcome === true ? true : (f.outcome === false ? false : null),
    points: num(f.points),
    costs: num(f.costs),
  };
}

/**
 * Would this record have been acted on, under these thresholds?
 *
 * Reading a stored answer is the entire mechanism — no model, no network.
 */
function passes(record, settings) {
  const s = settings || {};
  const conf = num(record && record.confidence);
  const floor = num(s.minConfidence);
  if (floor != null && (conf == null || conf < floor)) return false;
  if (s.option != null && String(record.answer) !== String(s.option)) return false;
  return true;
}

/**
 * Score a set of records under one setting.
 * Refuses a win rate below the sample floor, like every other measurement here.
 */
function score(records, settings, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const list = (Array.isArray(records) ? records : []).filter((r) => r && r.outcome !== null);
  const taken = list.filter((r) => passes(r, settings));
  const n = taken.length;
  const wins = taken.filter((r) => r.outcome === true).length;
  const ci = driftEdge.wilson(wins, n, cfg.z);
  const pts = taken.map((r) => num(r.points)).filter((v) => v !== null);
  const costs = taken.map((r) => num(r.costs)).filter((v) => v !== null);
  const enough = n >= cfg.minSamples;
  const gross = pts.length ? pts.reduce((a, b) => a + b, 0) : null;
  const cost = costs.length ? costs.reduce((a, b) => a + b, 0) : 0;
  return {
    setting: settings || null,
    considered: list.length, taken: n, skipped: list.length - n, wins,
    winRate: enough ? ci.p : null,
    ci: enough ? { lo: ci.lo, hi: ci.hi } : null,
    pointsGross: enough ? round3(gross) : null,
    // NET of costs, because a filter that raises the win rate while trading more
    // often can still lose money — the exact shape trade-jev measured.
    pointsNet: enough ? round3(gross - cost) : null,
    note: enough ? null : n + ' taken — ' + cfg.minSamples + ' are needed before a rate means anything',
  };
}

/**
 * THE SPLIT. Tune on the first part BY TIME, then test the winner on the rest.
 *
 * Time, not random: two signals fired a minute apart are not independent
 * observations, and a random split would put half of each cluster in both halves
 * and report a held-out number that is not held out.
 */
function splitByTime(records, fraction) {
  const list = (Array.isArray(records) ? records : []).slice()
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (!list.length) return { tune: [], test: [], cutTs: null };
  const f = (num(fraction) != null && fraction > 0 && fraction < 1) ? fraction : DEFAULTS.tuneFraction;
  const cut = Math.max(1, Math.min(list.length - 1, Math.floor(list.length * f)));
  return { tune: list.slice(0, cut), test: list.slice(cut), cutTs: list[cut] ? list[cut].ts : null };
}

/**
 * Sweep a grid of thresholds, pick the best on the TUNE half, and report what
 * that same setting did on the TEST half. Both numbers, always.
 */
function sweep(records, grid, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const { tune, test, cutTs } = splitByTime(records, cfg.tuneFraction);
  const floors = (grid && Array.isArray(grid.minConfidence)) ? grid.minConfidence : [0.5, 0.6, 0.7, 0.8, 0.9];
  const candidates = [];
  for (const f of floors) {
    const setting = { minConfidence: f, option: (grid && grid.option) || undefined };
    const t = score(tune, setting, cfg);
    const v = score(test, setting, cfg);
    candidates.push({ setting, tune: t, test: v, overfit: null });
  }
  // The verdict is about ONE number: how much of the tune-half advantage
  // survived contact with the half it was chosen on.
  const ranked = candidates.filter((c) => c.tune.winRate != null).sort((a, b) => b.tune.winRate - a.tune.winRate);
  const best = ranked[0] || null;
  let verdict = 'INSUFFICIENT';
  let summary;
  if (!best) {
    summary = 'Not enough resolved records on the tuning half to choose a setting (' + tune.length
      + ' record(s) there, ' + cfg.minSamples + ' taken per setting are needed).';
  } else {
    const heldOut = best.test;
    if (heldOut.winRate == null) {
      verdict = 'UNTESTED';
      summary = 'Best tuning setting is confidence >= ' + best.setting.minConfidence + ' (' + Math.round(best.tune.winRate * 100)
        + '% over ' + best.tune.taken + '), but the held-out half has only ' + heldOut.taken
        + ' taken — too few to test it on. ';
    } else {
      const drop = round3(best.tune.winRate - heldOut.winRate);
      // SURVIVED means the held-out INTERVAL contains the tuning point estimate —
      // the same overlap rule drift-edge.js uses for buckets, applied to the
      // question "is the held-out result consistent with the one I chose?".
      // The first version demanded heldOut.ci.lo >= tune - 0.10, which at n=32
      // and a true 80% asks the lower bound (0.65) to clear an arbitrary 0.70 —
      // it failed a setting that had held up perfectly, so it would have reported
      // OVERFIT on genuinely consistent data.
      const survived = heldOut.ci.lo <= best.tune.winRate && heldOut.ci.hi >= best.tune.winRate;
      verdict = survived ? 'HELD_UP' : 'OVERFIT';
      summary = 'Best tuning setting is confidence >= ' + best.setting.minConfidence + ': '
        + Math.round(best.tune.winRate * 100) + '% on the tuning half (' + best.tune.taken + ' taken), '
        + Math.round(heldOut.winRate * 100) + '% on the held-out half (' + heldOut.taken + ' taken) — a drop of '
        + Math.round(drop * 100) + ' points. '
        // The count is stated in BOTH branches. A setting that held up is still
        // the winner of an N-way search on one dataset, and reporting the count
        // only when the result is bad would make a lucky winner look clean.
        + floors.length + (floors.length === 1 ? ' setting was' : ' settings were') + ' tried on the same data, so '
        + (survived
          ? 'this is a lead worth testing forward on new days — not an edge.'
          : 'treat this as noise, not a result.');
      best.overfit = !survived;
    }
  }
  return {
    candidates, best, verdict, cutTs, summary,
    tuneN: tune.length, testN: test.length, settingsTried: floors.length,
    minSamples: cfg.minSamples,
  };
}

// ── thin io ───────────────────────────────────────────────────────────────
function storePath(dataDir) { return path.join(dataDir, 'typesafe', 'answers.jsonl'); }

function appendRecords(dataDir, records) {
  try {
    const list = (Array.isArray(records) ? records : [records]).filter(Boolean);
    if (!list.length) return 0;
    const dir = path.join(dataDir, 'typesafe');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(storePath(dataDir), list.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return list.length;
  } catch (e) { return 0; }
}

function readRecords(dataDir, limit) {
  try {
    const file = storePath(dataDir);
    if (!fs.existsSync(file)) return [];
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    return limit ? rows.slice(-limit) : rows;
  } catch (e) { return []; }
}

/** Fold records to the newest per setupId, then attach resolved outcomes. */
function withOutcomes(records, outcomeBySetupId) {
  const map = (outcomeBySetupId && typeof outcomeBySetupId === 'object') ? outcomeBySetupId : {};
  return (Array.isArray(records) ? records : []).map((r) => {
    const o = r && r.setupId ? map[r.setupId] : null;
    if (!o) return r;
    return Object.assign({}, r, { outcome: o.outcome === true, points: o.points != null ? o.points : r.points });
  });
}

module.exports = {
  DEFAULTS, buildRecord, passes, score, splitByTime, sweep,
  storePath, appendRecords, readRecords, withOutcomes,
};
