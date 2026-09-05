'use strict';
/* ── exit-bias-align.js — declared bias vs. what price actually did ──────────
 *
 * (2026-09-02, Anoop: "...so that i can see and annalyse the current bias and
 * confirm as per pre-trade bais which i submit on checklist")
 *
 * Joins two things the app already knows and had never put side by side:
 *   the DIRECTION HE DECLARED on the pre-trade checklist (bias-tracker.js's
 *   directionOfRecord — Daily Bias wins, 4H/1H set confidence), and
 *   the DRIFT SINCE HIS LAST EXIT (exit-drift.js's ABOVE / BELOW verdict).
 *
 * ── WHY THIS IS WRITTEN DEFENSIVELY ─────────────────────────────────────────
 *
 * 1. AGREEMENT IS THE DANGEROUS ANSWER, NOT THE REASSURING ONE. He declares a
 *    bias, sees price drift the same way, and reads it as the market
 *    confirming him — which is textbook confirmation bias, and it arrives
 *    exactly when he is flat and looking for a reason to re-enter. Drift
 *    agreeing with a bias is NOT evidence the bias is right: over a short
 *    window price drifts both ways (the reason exit-drift.js gates on ATR at
 *    all). So ALIGNED is deliberately worded as an observation, never as
 *    confirmation, and never as a reason to trade.
 *
 * 2. DIVERGENCE IS THE INFORMATIVE ANSWER. Price moving against the direction
 *    he wrote down before the session is the reading that should actually
 *    change his mind, and it is the one a naive "confirmation" feature would
 *    bury. DIVERGED therefore gets the plainest language of the four.
 *
 * 3. NO BIAS MEANS NO COMPARISON. A day with no checklist, or a Conflicted
 *    daily bias, yields dir:null. Treating that as "neutral" or defaulting it
 *    to his last known bias would invent a declaration he never made — the
 *    same class of error as exit-drift.js anchoring on a fold-derived row with
 *    no exit price. It returns NO_BIAS and says why.
 *
 * 4. IT NEVER OUTRANKS THE DRIFT'S OWN REFUSALS. If exit-drift returned
 *    NO_READ, COOLING or UNKNOWN there is no direction to compare against, and
 *    manufacturing one here would route straight around the cooldown that
 *    exists to stop a revenge re-entry. NO_DRIFT is returned unchanged.
 *
 * PURE. No fs, no clock, no chart. Unit-tested in test/exit-bias-align.test.js.
 */

const ALIGN = {
  ALIGNED:   'ALIGNED',   // drift is going the way he declared
  DIVERGED:  'DIVERGED',  // drift is going against what he declared
  NO_BIAS:   'NO_BIAS',   // he declared no usable direction today
  NO_DRIFT:  'NO_DRIFT',  // exit-drift declined to call a direction
};

// The drift verdict expressed as a trade direction: price ABOVE the exit is
// the direction a LONG would have profited from. This is a restatement of the
// drift, NOT a signal — see the header.
function driftDirection(drift) {
  if (!drift) return null;
  if (drift.verdict === 'ABOVE') return 'LONG';
  if (drift.verdict === 'BELOW') return 'SHORT';
  return null;
}

/**
 * @param {object} drift   an exit-drift.js result
 * @param {object} rec     bias-tracker.js directionOfRecord() output
 *                         { dir: 'LONG'|'SHORT'|null, confidence, daily, h4, h1 }
 * @returns {{status, biasDir, driftDir, confidence, sameDay, note}}
 */
function alignExitDrift(drift, rec, opts) {
  const o = opts || {};
  const r = rec || {};
  const biasDir = r.dir || null;
  const driftDir = driftDirection(drift);
  const confidence = r.confidence || 'none';

  const base = {
    status: ALIGN.NO_DRIFT, biasDir, driftDir, confidence,
    // Whether the checklist being compared is from the SAME DAY as the exit.
    // A bias declared this morning says nothing about an exit two days ago,
    // and silently comparing them would be the most confident wrong reading
    // this module could produce. The caller sets it; null means unknown.
    sameDay: o.sameDay === undefined ? null : !!o.sameDay,
    note: null,
  };

  if (!driftDir) {
    return Object.assign(base, {
      status: ALIGN.NO_DRIFT,
      note: 'No directional read since your exit yet, so there is nothing to compare your bias against.',
    });
  }
  if (!biasDir) {
    return Object.assign(base, {
      status: ALIGN.NO_BIAS,
      note: 'No usable daily bias on the checklist for this day, so there is nothing to check the drift against.',
    });
  }

  const aligned = biasDir === driftDir;
  const stale = base.sameDay === false
    ? ' Note: that bias was declared on a different day than the exit, so treat the comparison loosely.'
    : '';

  if (aligned) {
    return Object.assign(base, {
      status: ALIGN.ALIGNED,
      // Worded as an observation on purpose. "Consistent with" is the strongest
      // claim the evidence supports; "confirms" would be false and would read
      // as a green light. See header note 1.
      note: 'Price has drifted ' + (driftDir === 'LONG' ? 'up' : 'down')
        + ' since your exit, consistent with the ' + biasDir + ' bias you declared'
        + (confidence !== 'full' ? ' (' + confidence + ' confidence)' : '')
        + '. That is consistent, not confirmation — drift agreeing with a bias is not evidence the bias is right.'
        + stale,
    });
  }
  return Object.assign(base, {
    status: ALIGN.DIVERGED,
    note: 'You declared ' + biasDir + ' but price has drifted '
      + (driftDir === 'LONG' ? 'up' : 'down') + ' since your exit — against that bias'
      + (confidence !== 'full' ? ' (' + confidence + ' confidence)' : '')
      + '. Worth re-reading before the next entry.' + stale,
  });
}

/** One line for the panel / coach. Null when there is nothing worth saying. */
function formatAlign(a) {
  if (!a) return null;
  if (a.status === ALIGN.NO_DRIFT) return null;   // the drift box already says this
  if (a.status === ALIGN.NO_BIAS) return a.note;
  return (a.status === ALIGN.ALIGNED ? 'BIAS ALIGNED' : 'BIAS DIVERGED') + ' — ' + a.note;
}

module.exports = { alignExitDrift, driftDirection, formatAlign, ALIGN };
