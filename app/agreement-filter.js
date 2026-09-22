'use strict';
/* ── agreement-filter.js — act on AGREEMENT, not on one answer ───────────────
 *
 * ── WHERE THIS COMES FROM, AND WHY IT IS NOT A GUESS ───────────────────────
 * github.com/justinhe16/trade-jev backtested Jev as a BUY/SELL/HOLD trader on
 * **NQ** — this app's own instrument — over 15 trading days, 22,401 Jev calls,
 * for $0.91. Its published findings:
 *
 *   | setting                          | P&L (15d)  | win days | worst day | trades |
 *   | Jev, act on EVERY answer         | -$128,590  |   3/15   | -$37,950  |  6,941 |
 *   | order-book imbalance rule        |  -$21,820  |   4/15   | -$10,390  |    -   |
 *   | random trades                    |  -$11,230  |   6/15   | -$15,760  |    -   |
 *   | JEV + FILTERS (0.7 conf, 4 in a  |  +$20,795  |  12/15   |  -$1,065  |    178 |
 *   |  row agreeing, 200 stop/100 tgt) |            |          |           |        |
 *
 * Two things are being said there, and the second is easy to miss:
 *
 *   1. RAW JEV ANSWERS ARE NOISE. It flips between BUY and SELL from one
 *      snapshot to the next — which matches the documented weakness on raw
 *      numbers ("not a calculator"). Acting on every answer lost more than
 *      random trading did. That is a direct warning against the tempting
 *      feature "let Jev call the trade".
 *   2. THE FILTER IS WHAT MADE IT A SIGNAL. And the filter is CODE, not model:
 *      a confidence floor, a REQUIRED RUN OF AGREEING ANSWERS, and a fixed
 *      stop/target. They then say, in their own words, that the settings were
 *      chosen from 1,920 tried on the same 15 days and that the table replays
 *      stored answers — "treat it as an interesting lead to test on new data,
 *      not a proven edge."
 *
 * So the transferable part is the AGREEMENT RUN, and it is cheap: at this app's
 * measured ~$0.00004 a call, four agreeing reads cost sixteen hundredths of a
 * cent. The app has never had this. Every Jev read it takes is a single sample,
 * and a single sample of a classifier that flips is a coin toss with a label.
 *
 * ── HOW IT MAPS ONTO THIS APP ──────────────────────────────────────────────
 * trade-jev answers every 15s on a moving book. This app's analogue is the
 * armed-setup poll: the same setup, read again on each closed bar. "Four
 * agreeing reads on one setup" is therefore expressible here without inventing
 * a new loop — it is the same question asked across successive polls, which is
 * what the monitors already do.
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 * Pure decision function over a SERIES of reads. It does not call anything, arm
 * anything, size anything or trade anything. `act` is an opinion about whether
 * the reads agree; what a caller does with that is the caller's business, and
 * nothing in this app is wired to trade on it.
 */

const DEFAULTS = Object.freeze({
  enabled: false,        // off until someone deliberately switches it on
  minAgreeing: 4,        // the run length trade-jev's winning setting used
  minConfidence: 0.7,    // its confidence floor, same number
  maxAgeMs: 30 * 60 * 1000,   // reads older than this are not one "run"
});

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round3(n) { return Math.round(n * 1000) / 1000; }

/** Settings off rules.json.agreementFilter, defaulting to the published setting. */
function filterSettings(rules) {
  const c = (rules && rules.agreementFilter) || {};
  const a = num(c.minAgreeing), f = num(c.minConfidence), age = num(c.maxAgeMs);
  return {
    enabled: c.enabled === true,
    minAgreeing: (a != null && a >= 2) ? Math.min(20, Math.floor(a)) : DEFAULTS.minAgreeing,
    minConfidence: (f != null && f >= 0 && f <= 1) ? f : DEFAULTS.minConfidence,
    maxAgeMs: (age != null && age > 0) ? age : DEFAULTS.maxAgeMs,
  };
}

/**
 * The longest run of the SAME answer at the END of the series.
 * Newest last — the run that is still standing now, not the best run of the day.
 */
function trailingRun(readings) {
  const list = (Array.isArray(readings) ? readings : []).filter((r) => r && r.answer);
  if (!list.length) return { answer: null, length: 0, minConfidence: null };
  const answer = String(list[list.length - 1].answer);
  let length = 0;
  let minConf = null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (String(list[i].answer) !== answer) break;
    const c = num(list[i].confidence);
    minConf = (minConf == null) ? c : (c == null ? minConf : Math.min(minConf, c));
    length++;
  }
  return { answer, length, minConfidence: minConf };
}

/**
 * Should a caller act on this series of reads?
 *
 * Both conditions must hold, exactly as in the published setting: a long enough
 * trailing run of the same answer, AND every read in that run at or above the
 * confidence floor. A run of four where one read was at 0.51 is not four
 * agreeing answers, it is three and a shrug.
 */
function shouldAct(readings, settings, nowMs) {
  const cfg = (settings && typeof settings.minAgreeing === 'number') ? settings : filterSettings(settings);
  const list = Array.isArray(readings) ? readings.filter((r) => r && r.answer) : [];
  if (!cfg.enabled) {
    return { act: false, reason: 'agreement filter is off — reads are recorded, nothing acts on them', run: trailingRun(list), config: cfg };
  }
  if (!list.length) return { act: false, reason: 'no reads yet', run: { answer: null, length: 0, minConfidence: null }, config: cfg };

  // A run is only a run if it is recent. Reads from an hour ago agreeing with a
  // read from now are not agreement, they are two different markets.
  const now = num(nowMs) != null ? Number(nowMs) : Date.now();
  const ages = list.map((r) => num(r.at)).filter((t) => t !== null);
  if (ages.length && (now - ages[ages.length - 1]) > cfg.maxAgeMs) {
    return { act: false, reason: 'the newest read is stale (' + Math.round((now - ages[ages.length - 1]) / 60000) + ' min old)', run: trailingRun(list), config: cfg };
  }

  const run = trailingRun(list);
  if (run.length < cfg.minAgreeing) {
    return {
      act: false, run, config: cfg,
      reason: 'only ' + run.length + ' agreeing read(s) on "' + run.answer + '" — ' + cfg.minAgreeing + ' are required',
    };
  }
  const weak = list.slice(list.length - run.length).filter((r) => {
    const c = num(r.confidence);
    return c == null || c < cfg.minConfidence;
  });
  if (weak.length) {
    return {
      act: false, run, config: cfg,
      reason: 'the run agrees but ' + weak.length + ' read(s) are below the ' + cfg.minConfidence + ' confidence floor',
    };
  }
  return {
    act: true, run, config: cfg,
    reason: run.length + ' consecutive reads agree on "' + run.answer + '", all at or above '
      + cfg.minConfidence + ' (lowest ' + round3(run.minConfidence) + ')',
  };
}

/**
 * Feed reads into a series, newest last.
 * Kept here so every caller builds the series the same way — a series assembled
 * differently in two places is two different filters wearing one name.
 */
function addReading(series, reading) {
  const list = Array.isArray(series) ? series.slice() : [];
  if (!reading || !reading.answer) return list;
  list.push({
    answer: String(reading.answer),
    confidence: num(reading.confidence),
    at: num(reading.at) != null ? Number(reading.at) : Date.now(),
    setupId: reading.setupId != null ? String(reading.setupId) : null,
  });
  // Bounded: the run can never need more than the threshold, and an unbounded
  // series on a live poll loop is a memory leak with a nice name.
  return list.slice(-24);
}

module.exports = { DEFAULTS, filterSettings, trailingRun, shouldAct, addReading };
